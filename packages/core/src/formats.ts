/**
 * Formats d'import et d'export paramétrables, comme les « formats paramétrables »
 * de Sage : on décrit une fois les colonnes d'un fichier (catalogue d'un
 * fournisseur, écritures pour le logiciel du cabinet comptable) puis on le
 * réutilise en un clic.
 */

export type Separator = ';' | ',' | '\t';

export type ImportField = 'name' | 'barcode' | 'salePrice' | 'purchasePrice' | 'vat' | 'unit' | 'department' | 'family';

export const IMPORT_FIELDS: Record<ImportField, string> = {
  name: 'Désignation',
  barcode: 'Code-barres',
  salePrice: 'Prix de vente',
  purchasePrice: "Prix d'achat",
  vat: 'TVA (%)',
  unit: 'Unité',
  department: 'Rayon',
  family: 'Famille',
};

export interface ImportFormat {
  id: string;
  name: string;
  kind: 'articles';
  separator: Separator;
  /** Lignes à sauter avant les données (en-têtes, titre du fournisseur…). */
  skipRows: number;
  decimal: ',' | '.';
  /** Numéro de colonne (0 = première) de chaque donnée ; absente : non importée. */
  columns: Partial<Record<ImportField, number>>;
  builtin?: boolean;
}

export type ExportField = 'journal' | 'date' | 'piece' | 'account' | 'aux' | 'label' | 'debit' | 'credit' | 'amount' | 'direction';

export const EXPORT_FIELDS: Record<ExportField, string> = {
  journal: 'Journal',
  date: 'Date',
  piece: 'Pièce',
  account: 'Compte',
  aux: 'Tiers',
  label: 'Libellé',
  debit: 'Débit',
  credit: 'Crédit',
  amount: 'Montant',
  direction: 'Sens (D/C)',
};

export type DateFormat = 'dd/mm/yyyy' | 'ddmmyy' | 'ddmmyyyy' | 'yyyy-mm-dd';

export interface ExportFormat {
  id: string;
  name: string;
  kind: 'ecritures';
  separator: Separator;
  dateFormat: DateFormat;
  header: boolean;
  columns: ExportField[];
  debitMark: string;
  creditMark: string;
  builtin?: boolean;
}

export type FileFormat = ImportFormat | ExportFormat;

export const BUILTIN_EXPORT_FORMATS: ExportFormat[] = [
  {
    id: 'fedonix',
    name: 'FEDONIX 360 (CSV)',
    kind: 'ecritures',
    separator: ';',
    dateFormat: 'dd/mm/yyyy',
    header: true,
    columns: ['journal', 'date', 'piece', 'account', 'aux', 'label', 'debit', 'credit'],
    debitMark: 'D',
    creditMark: 'C',
    builtin: true,
  },
  {
    id: 'sage100',
    name: 'Sage 100 Comptabilité (format paramétrable : journal, date JJMMAA, pièce, compte, tiers, libellé, sens, montant)',
    kind: 'ecritures',
    separator: ';',
    dateFormat: 'ddmmyy',
    header: false,
    columns: ['journal', 'date', 'piece', 'account', 'aux', 'label', 'direction', 'amount'],
    debitMark: 'D',
    creditMark: 'C',
    builtin: true,
  },
  {
    id: 'debit-credit',
    name: 'Ciel, EBP et tableurs (date, journal, compte, pièce, libellé, débit, crédit)',
    kind: 'ecritures',
    separator: ';',
    dateFormat: 'dd/mm/yyyy',
    header: true,
    columns: ['date', 'journal', 'account', 'piece', 'label', 'debit', 'credit'],
    debitMark: 'D',
    creditMark: 'C',
    builtin: true,
  },
];

/** Découpe un fichier texte délimité (guillemets doublés gérés, BOM retiré). */
export function splitDelimited(text: string, separator: Separator): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"' && cell === '') quoted = true;
    else if (c === separator) {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(cell);
      cell = '';
      if (row.some((x) => x.trim())) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x.trim())) rows.push(row);
  return rows;
}

/** Séparateur le plus probable d'un fichier (celui qui revient le plus sur la première ligne). */
export function guessSeparator(text: string): Separator {
  const first = text.replace(/^﻿/, '').split(/\r?\n/, 1)[0] ?? '';
  const count = (s: string) => first.split(s).length - 1;
  return ([';', '\t', ','] as Separator[]).reduce((best, s) => (count(s) > count(best) ? s : best), ';');
}

const parseNumber = (v: string, decimal: ',' | '.') => {
  const clean = v.replace(/[\s ]/g, '').replace(/[^\d,.-]/g, '');
  const n = Number(decimal === ',' ? clean.replace(/\./g, '').replace(',', '.') : clean.replace(/,/g, ''));
  return Number.isFinite(n) ? n : NaN;
};

export interface ArticleImportRow {
  name: string;
  barcode?: string;
  salePrice: number;
  purchasePrice?: number;
  vatRateBp?: number;
  unit?: 'piece' | 'kg' | 'litre';
  department?: string;
  family?: string;
}

/** Lit un catalogue selon un format : une ligne d'article par ligne du fichier. */
export function parseArticlesWith(text: string, f: ImportFormat): ArticleImportRow[] {
  const get = (r: string[], k: ImportField) => (f.columns[k] === undefined ? '' : (r[f.columns[k]!] ?? '').trim());
  return splitDelimited(text, f.separator)
    .slice(f.skipRows)
    .map((r): ArticleImportRow => {
      const unit = get(r, 'unit').toLowerCase();
      const vat = get(r, 'vat');
      const purchase = get(r, 'purchasePrice');
      return {
        name: get(r, 'name'),
        barcode: get(r, 'barcode') || undefined,
        salePrice: Math.round(parseNumber(get(r, 'salePrice'), f.decimal)),
        purchasePrice: purchase ? Math.round(parseNumber(purchase, f.decimal)) : undefined,
        vatRateBp: vat ? Math.round(parseNumber(vat.replace('%', ''), f.decimal === ',' ? ',' : '.') * 100) : undefined,
        unit: unit === 'kg' ? 'kg' : unit.startsWith('l') ? 'litre' : 'piece',
        department: get(r, 'department') || undefined,
        family: get(r, 'family') || undefined,
      };
    })
    .filter((r) => r.name);
}

export interface ExportLine {
  journal: string;
  /** AAAA-MM-JJ */
  date: string;
  piece: string;
  account: string;
  aux: string | null;
  label: string;
  debit: number;
  credit: number;
}

function formatDate(iso: string, f: DateFormat): string {
  const [y, m, d] = iso.split('-');
  if (f === 'yyyy-mm-dd') return iso;
  if (f === 'ddmmyy') return `${d}${m}${y!.slice(2)}`;
  if (f === 'ddmmyyyy') return `${d}${m}${y}`;
  return `${d}/${m}/${y}`;
}

/** Écrit les lignes d'écritures selon un format d'export. */
export function formatEntries(lines: ExportLine[], f: ExportFormat): string {
  const esc = (v: string) => (v.includes(f.separator) || /["\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const cell = (l: ExportLine, c: ExportField): string => {
    switch (c) {
      case 'journal':
        return l.journal;
      case 'date':
        return formatDate(l.date, f.dateFormat);
      case 'piece':
        return l.piece;
      case 'account':
        return l.account;
      case 'aux':
        return l.aux ?? '';
      case 'label':
        return l.label;
      case 'debit':
        return l.debit ? String(l.debit) : '';
      case 'credit':
        return l.credit ? String(l.credit) : '';
      case 'amount':
        return String(l.debit || l.credit);
      case 'direction':
        return l.debit ? f.debitMark : f.creditMark;
    }
  };
  const out: string[] = [];
  if (f.header) out.push(f.columns.map((c) => EXPORT_FIELDS[c]).join(f.separator));
  for (const l of lines) out.push(f.columns.map((c) => esc(cell(l, c))).join(f.separator));
  return `${out.join('\r\n')}\r\n`;
}
