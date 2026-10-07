/**
 * Tickets pour imprimantes thermiques ESC/POS (Epson, Xprinter, Bixolon…).
 *
 * Un ticket est d'abord décrit comme une suite de lignes (`Receipt`), puis
 * traduit en octets ESC/POS. La même description sert à l'impression par le
 * pilote Windows (rendu HTML), si bien que les deux modes impriment le même
 * contenu.
 */

export type ReceiptLine =
  | { t: 'text'; text: string; align?: 'left' | 'center' | 'right'; bold?: boolean; big?: boolean }
  /** Libellé à gauche, montant aligné à droite ; le libellé trop long passe à la ligne. */
  | { t: 'row'; left: string; right: string; bold?: boolean; big?: boolean; indent?: number }
  | { t: 'rule' }
  | { t: 'feed' };
export type Receipt = ReceiptLine[];

/**
 * Table de caractères de l'imprimante. PC850 est la plus répandue sur les
 * imprimantes vendues au Cameroun ; PC858 ajoute « € » ; WPC1252 est la table
 * Windows ; « ascii » retire les accents quand aucune table ne convient.
 */
export type Codepage = 'pc850' | 'pc858' | 'wpc1252' | 'ascii';
export const CODEPAGES: Record<Codepage, { label: string; escT: number | null }> = {
  pc850: { label: 'PC850 (Europe de l’Ouest)', escT: 2 },
  pc858: { label: 'PC858 (PC850 avec €)', escT: 19 },
  wpc1252: { label: 'WPC1252 (Windows)', escT: 16 },
  ascii: { label: 'Sans accents', escT: null },
};

/** Largeur de ligne en caractères (police A) : 48 pour 80 mm, 42 pour certains 80 mm, 32 pour 58 mm. */
export const PAPER_WIDTHS = [48, 42, 32] as const;

export interface EscPosOptions {
  columns: number;
  codepage: Codepage;
  /** Coupe le papier en fin de ticket. */
  cut?: boolean;
  /** Ouvre le tiroir-caisse avant d'imprimer. */
  kick?: boolean;
}

const ESC = 0x1b;
const GS = 0x1d;

const PC850: Record<string, number> = {
  à: 0x85, â: 0x83, ä: 0x84, ç: 0x87, é: 0x82, è: 0x8a, ê: 0x88, ë: 0x89, î: 0x8c, ï: 0x8b, ô: 0x93, ö: 0x94,
  ù: 0x97, û: 0x96, ü: 0x81, ÿ: 0x98, À: 0xb7, Â: 0xb6, Ä: 0x8e, Ç: 0x80, É: 0x90, È: 0xd4, Ê: 0xd2, Ë: 0xd3,
  Î: 0xd7, Ï: 0xd8, Ô: 0xe2, Ö: 0x99, Ù: 0xeb, Û: 0xea, Ü: 0x9a, '«': 0xae, '»': 0xaf, '°': 0xf8, '·': 0xfa,
};
const PC858: Record<string, number> = { ...PC850, '€': 0xd5 };

/** Caractères remplacés avant tout calcul de largeur. */
const SUBSTITUTES: Record<string, string> = {
  ' ': ' ', ' ': ' ', ' ': ' ', '’': "'", '‘': "'", '“': '"', '”': '"',
  '–': '-', '—': '-', '…': '...', œ: 'oe', Œ: 'OE', æ: 'ae', Æ: 'AE', '\t': ' ',
};

function encodable(ch: string, codepage: Codepage): boolean {
  const code = ch.charCodeAt(0);
  if (code >= 0x20 && code <= 0x7e) return true;
  if (codepage === 'pc850') return ch in PC850;
  if (codepage === 'pc858') return ch in PC858;
  if (codepage === 'wpc1252') return ch === '€' || (code >= 0xa0 && code <= 0xff);
  return false;
}

/**
 * Ramène un texte aux seuls caractères imprimables avec la table choisie :
 * espaces insécables, apostrophes typographiques et ligatures sont remplacés,
 * les accents absents de la table sont retirés, le reste devient « ? ».
 */
export function toPrinterText(text: string, codepage: Codepage): string {
  let out = '';
  for (const raw of text) {
    const ch = SUBSTITUTES[raw] ?? raw;
    for (const c of ch) {
      if (encodable(c, codepage)) out += c;
      else if (c === '€') out += 'EUR';
      else {
        const bare = c.normalize('NFD').replace(/[̀-ͯ]/g, '');
        out += bare.length === 1 && encodable(bare, codepage) ? bare : '?';
      }
    }
  }
  return out;
}

function encode(text: string, codepage: Codepage): number[] {
  const bytes: number[] = [];
  for (const c of text) {
    const code = c.charCodeAt(0);
    if (code < 0x80) bytes.push(code);
    else if (codepage === 'pc850') bytes.push(PC850[c]!);
    else if (codepage === 'pc858') bytes.push(PC858[c]!);
    else bytes.push(c === '€' ? 0x80 : code);
  }
  return bytes;
}

/** Coupe un texte en lignes d'au plus `width` caractères, de préférence entre deux mots. */
export function wrapText(text: string, width: number): string[] {
  const lines: string[] = [];
  let rest = text.trim();
  while (rest.length > width) {
    let cut = rest.lastIndexOf(' ', width);
    if (cut <= 0) cut = width;
    lines.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  lines.push(rest);
  return lines;
}

/** Met en page une ligne « libellé … montant » sur `width` colonnes. */
export function layoutRow(left: string, right: string, width: number, indent = 0): string[] {
  const pad = ' '.repeat(Math.min(indent, Math.max(0, width - 1)));
  const room = width - pad.length;
  if (!right) return wrapText(left, room).map((l) => pad + l);
  if (right.length >= room) return [...wrapText(left, room).map((l) => pad + l), right.padStart(width)];
  const lines = wrapText(left, room).map((l) => pad + l);
  const last = lines[lines.length - 1]!;
  if (last.length + 1 + right.length <= width) lines[lines.length - 1] = last + right.padStart(width - last.length);
  else lines.push(right.padStart(width));
  return lines;
}

/** Commande d'ouverture du tiroir-caisse (impulsion de 50 ms sur la broche 2, standard ESC/POS). */
export function drawerKick(): Uint8Array {
  return Uint8Array.from([ESC, 0x70, 0, 25, 250]);
}

/** Traduit un ticket en octets ESC/POS prêts à envoyer à l'imprimante. */
export function receiptToEscPos(receipt: Receipt, opts: EscPosOptions): Uint8Array {
  const { columns, codepage } = opts;
  const out: number[] = [ESC, 0x40];
  if (opts.kick) out.push(...drawerKick());
  const table = CODEPAGES[codepage].escT;
  if (table !== null) out.push(ESC, 0x74, table);
  const text = (s: string) => out.push(...encode(s, codepage), 0x0a);
  const style = (bold: boolean, big: boolean, align: 0 | 1 | 2) =>
    out.push(ESC, 0x45, bold ? 1 : 0, GS, 0x21, big ? 0x11 : 0, ESC, 0x61, align);

  for (const line of receipt) {
    if (line.t === 'rule') {
      style(false, false, 0);
      text('-'.repeat(columns));
    } else if (line.t === 'feed') {
      out.push(0x0a);
    } else if (line.t === 'text') {
      const width = line.big ? Math.floor(columns / 2) : columns;
      style(Boolean(line.bold), Boolean(line.big), line.align === 'center' ? 1 : line.align === 'right' ? 2 : 0);
      for (const l of wrapText(toPrinterText(line.text, codepage), width)) text(l);
    } else {
      const width = line.big ? Math.floor(columns / 2) : columns;
      style(Boolean(line.bold), Boolean(line.big), 0);
      const rows = layoutRow(toPrinterText(line.left, codepage), toPrinterText(line.right, codepage), width, line.indent);
      for (const l of rows) text(l);
    }
  }
  style(false, false, 0);
  if (opts.cut !== false) out.push(ESC, 0x64, 4, GS, 0x56, 1);
  else out.push(ESC, 0x64, 2);
  return Uint8Array.from(out);
}

/** Aperçu texte d'un ticket (sans styles), tel qu'il sortira sur `columns` colonnes. */
export function receiptToText(receipt: Receipt, columns: number, codepage: Codepage = 'pc850'): string {
  const lines: string[] = [];
  for (const line of receipt) {
    if (line.t === 'rule') lines.push('-'.repeat(columns));
    else if (line.t === 'feed') lines.push('');
    else if (line.t === 'text') {
      const width = line.big ? Math.floor(columns / 2) : columns;
      for (const l of wrapText(toPrinterText(line.text, codepage), width)) {
        const w = line.big ? l.split('').join(' ') : l;
        const space = columns - w.length;
        lines.push(line.align === 'center' ? ' '.repeat(Math.floor(space / 2)) + w : line.align === 'right' ? w.padStart(columns) : w);
      }
    } else {
      const width = line.big ? Math.floor(columns / 2) : columns;
      const rows = layoutRow(toPrinterText(line.left, codepage), toPrinterText(line.right, codepage), width, line.indent);
      lines.push(...rows.map((l) => (line.big ? l.split('').join(' ') : l)));
    }
  }
  return lines.map((l) => l.trimEnd()).join('\n');
}
