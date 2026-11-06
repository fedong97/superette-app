/**
 * Lecture d'une facture fournisseur en PDF (0.116.0) : à partir des lignes de
 * texte du document (une ligne = les mots d'une même hauteur, de gauche à
 * droite), retrouve le n° de facture, la date, le NIU du fournisseur, les totaux
 * et les lignes d'articles (désignation, quantité, prix unitaire, montant).
 *
 * Une ligne d'article est retenue quand trois nombres de la ligne vérifient
 * quantité × prix ≈ montant : c'est ce contrôle qui évite de prendre une adresse
 * ou un numéro de téléphone pour un article. Les nombres à la française
 * (« 12 500 », « 12.500 », « 1 250,50 ») sont reconnus ; quand un espace peut
 * séparer deux nombres ou des milliers (« 24 450 10 800 »), toutes les lectures
 * sont essayées et celle qui tombe juste est gardée.
 *
 * Rien n'est enregistré : l'écran montre ce qui a été lu, le magasinier vérifie.
 */

export interface ReadInvoiceLine {
  /** Texte de la ligne, nombres retirés : désignation, référence… */
  label: string;
  /** Code-barres EAN-8 ou EAN-13 trouvé sur la ligne. */
  barcode: string | null;
  /** Premier mot de la ligne s'il ressemble à une référence (lettres et chiffres). */
  reference: string | null;
  /** Quantité en millièmes (2 → 2 000). */
  qty: number;
  /** Prix unitaire en FCFA, tel qu'écrit (HT ou TTC selon la facture). */
  unitPrice: number;
  /** Montant de la ligne en FCFA. */
  total: number;
  /** N° de la ligne dans le document (pour la retrouver). */
  row: number;
}

export interface ReadInvoice {
  number: string | null;
  /** AAAA-MM-JJ. */
  date: string | null;
  /** NIU (numéro d'identifiant unique) lu sur la facture. */
  taxpayerNumber: string | null;
  totalHt: number | null;
  totalTva: number | null;
  totalTtc: number | null;
  lines: ReadInvoiceLine[];
  /** Somme des montants des lignes lues. */
  linesTotal: number;
}

/** Un mot qui peut faire partie d'un nombre : chiffres, avec virgule ou point décimal éventuels. */
const NUMERIC = /^\d+(?:[.,]\d+)?$/;
const GROUP = /^\d{3}(?:,\d+)?$/;

/** « 12.500 » (point des milliers) ou « 12,5 » / « 12.5 » (décimales). */
function parseToken(t: string): number | null {
  if (!NUMERIC.test(t)) return null;
  if (/^\d{1,3}(\.\d{3})+$/.test(t)) return Number(t.replace(/\./g, ''));
  return Number(t.replace(',', '.'));
}

/** Toutes les façons de lire une suite de mots numériques (fusion des groupes de 3 chiffres : milliers). */
function readings(tokens: string[], limit = 64): number[][] {
  const out: number[][] = [];
  const walk = (i: number, acc: number[]) => {
    if (out.length >= limit) return;
    if (i === tokens.length) {
      out.push(acc);
      return;
    }
    const first = tokens[i]!;
    if (!/^\d{1,3}$/.test(first) && !NUMERIC.test(first)) return;
    // Le mot seul.
    const alone = parseToken(first);
    // Le mot suivi de groupes de 3 chiffres (milliers) : 1 250 000.
    if (/^\d{1,3}$/.test(first)) {
      let text = first;
      for (let j = i + 1; j < tokens.length && GROUP.test(tokens[j]!); j++) {
        text += tokens[j]!.replace(',', '.');
        const v = Number(text);
        walk(j + 1, [...acc, v]);
        if (tokens[j]!.includes(',')) break;
      }
    }
    if (alone !== null) walk(i + 1, [...acc, alone]);
  };
  walk(0, []);
  return out;
}

/** quantité × prix ≈ montant (arrondi au franc, ou 0,5 % d'écart pour les prix ronds). */
const fits = (q: number, p: number, t: number) => q > 0 && p > 0 && t > 0 && Math.abs(q * p - t) <= Math.max(1, t * 0.005);

/** Montant écrit : « 12 500 », « 12.500 », « 12 500,00 », « 12500 FCFA ». */
export function parseInvoiceAmount(text: string): number | null {
  const m = /(\d{1,3}(?:[ .  ]\d{3})+|\d+)(?:,(\d{1,2}))?/.exec(text);
  if (!m) return null;
  return Math.round(Number(m[1]!.replace(/[ .  ]/g, '')) + (m[2] ? Number(`0.${m[2]}`) : 0));
}

const DATE = /\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})\b|\b(\d{4})-(\d{2})-(\d{2})\b/;

function parseDate(text: string): string | null {
  const m = DATE.exec(text);
  if (!m) return null;
  let [d, mo, y] = m[4] ? [Number(m[6]), Number(m[5]), Number(m[4])] : [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 100) y += 2000;
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || y < 2000 || y > 2100) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Montant porté sur la ligne d'un total (le dernier nombre de la ligne). */
function lineAmount(line: string): number | null {
  const tail = /(\d{1,3}(?:[ .  ]\d{3})+(?:,\d{1,2})?|\d+(?:,\d{1,2})?)\s*(?:f\s?cfa|fcfa|xaf|f)?\s*$/i.exec(line.trim());
  return tail ? parseInvoiceAmount(tail[1]!) : null;
}

export function readSupplierInvoice(rawLines: string[]): ReadInvoice {
  const lines = rawLines.map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  let number: string | null = null;
  let date: string | null = null;
  let niu: string | null = null;
  let totalHt: number | null = null;
  let totalTva: number | null = null;
  let totalTtc: number | null = null;
  const items: ReadInvoiceLine[] = [];

  lines.forEach((line, row) => {
    const f = fold(line);
    if (!number) {
      const m = /\bfacture\b[^:\d\n]{0,20}?\s*(?:n[°o]|no\.?|num(?:ero)?\.?|#)?\s*[:.]?\s*([a-z]{0,6}[-/]?\d[\w/-]{0,24})/i.exec(f);
      // « Facture du 05/11/2026 » : une date, pas un numéro.
      if (m && !parseDate(m[1]!)) number = line.substr(m.index + m[0].length - m[1]!.length, m[1]!.length).trim().toUpperCase();
    }
    if (!date && /\bdate\b|\bdu\b|\ble\b/.test(f)) date = parseDate(line);
    if (!niu) {
      const m = /\b([MP]\d{12}[A-Z])\b/i.exec(line);
      if (m && /niu|contribuable|identifiant|n\.?i\.?u/.test(f)) niu = m[1]!.toUpperCase();
    }
    // Totaux : la ligne « Total HT », « TVA 19,25 % », « Total TTC » ou « Net à payer ».
    if (/\b(total|montant)\s*(h\.?t\.?|hors\s+taxes?)\b/.test(f)) totalHt ??= lineAmount(line);
    else if (/\b(total|montant)?\s*t\.?v\.?a\b/.test(f) && !/\bttc\b/.test(f) && !/\bht\b/.test(f)) totalTva ??= lineAmount(line);
    else if (/\b(total\s*t\.?t\.?c\.?|net\s+a\s+payer|montant\s+t\.?t\.?c)\b/.test(f)) totalTtc ??= lineAmount(line);
    if (/\b(total|sous[- ]total|net a payer|tva|remise globale|acompte)\b/.test(f)) return;

    // Ligne d'article : les mots numériques de la fin de la ligne.
    const words = line.split(' ');
    let start = words.length;
    while (start > 0 && (NUMERIC.test(words[start - 1]!) || /^(?:f|fcfa|xaf|%)$/i.test(words[start - 1]!))) start--;
    const tail = words.slice(start).filter((w) => NUMERIC.test(w));
    if (tail.length < 3) return;
    const head = words.slice(0, start);
    let best: { q: number; p: number; t: number } | null = null;
    for (const nums of readings(tail)) {
      // Le montant de la ligne est le dernier nombre (ou l'avant-dernier quand le taux de TVA suit) ;
      // la quantité et le prix sont deux nombres voisins avant lui.
      for (let k = nums.length - 1; k >= 2 && !best; k--) {
        const t = nums[k]!;
        for (let i = k - 2; i >= 0 && !best; i--) {
          const q = nums[i]!;
          const p = nums[i + 1]!;
          if (fits(q, p, t) && Number.isInteger(p) && q < 100_000) best = { q, p, t };
          else if (fits(p, q, t) && Number.isInteger(q) && p < 100_000) best = { q: p, p: q, t };
        }
        if (k < nums.length - 2) break;
      }
      if (best) break;
    }
    if (!best) return;
    const text = head.join(' ');
    const barcode = /\b(\d{13}|\d{8})\b/.exec(text)?.[1] ?? null;
    const first = head[0] ?? '';
    const reference = /^(?=.*\d)[A-Z0-9][A-Z0-9./-]{2,}$/i.test(first) && first !== barcode ? first : null;
    const label = head
      .filter((w) => w !== barcode && w !== reference)
      .join(' ')
      .trim();
    if (!label && !barcode && !reference) return;
    items.push({ label: label || reference || barcode || '', barcode, reference, qty: Math.round(best.q * 1000), unitPrice: Math.round(best.p), total: Math.round(best.t), row });
  });

  // Date : à défaut d'une ligne « Date… », la première date du document.
  if (!date) for (const l of lines) if ((date = parseDate(l))) break;
  return { number, date, taxpayerNumber: niu, totalHt, totalTva, totalTtc, lines: items, linesTotal: items.reduce((s, l) => s + l.total, 0) };
}

/** Ressemblance de deux désignations (0 à 1) : mots en commun, sans accents ni casse. */
export function labelSimilarity(a: string, b: string): number {
  const words = (s: string) =>
    new Set(
      fold(s)
        .replace(/[^a-z0-9]+/g, ' ')
        .split(' ')
        .filter((w) => w.length > 1),
    );
  const A = words(a);
  const B = words(b);
  if (!A.size || !B.size) return 0;
  let common = 0;
  for (const w of A) if (B.has(w)) common++;
  return (2 * common) / (A.size + B.size);
}
