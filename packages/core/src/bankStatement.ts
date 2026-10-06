import type { Fcfa } from './money';

/** Ligne d'un relevé de banque ou de Mobile Money. Montant positif : argent reçu ; négatif : argent sorti. */
export interface StatementLine {
  date: string;
  label: string;
  reference: string | null;
  amount: Fcfa;
}

export interface ParsedStatement {
  lines: StatementLine[];
  /** Lignes ignorées, avec leur numéro dans le fichier et la raison. */
  skipped: { row: number; reason: string }[];
  /** Colonnes reconnues, pour l'afficher à l'utilisateur. */
  columns: Partial<Record<'date' | 'label' | 'reference' | 'debit' | 'credit' | 'amount' | 'fee', string>>;
}

const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

/** Montant écrit à la française ou à l'anglaise : « 1 250 000 », « 1.250.000 », « 1,250,000.00 », « -5 000 », « 1 250,50 ». */
export function parseStatementAmount(raw: string): number | null {
  let s = raw.replace(/[\s  ]/g, '').replace(/(fcfa|xaf|cfa|f)$/i, '');
  if (!s) return null;
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  if (s.startsWith('-')) {
    negative = !negative;
    s = s.slice(1);
  } else if (s.startsWith('+')) s = s.slice(1);
  if (s.endsWith('-')) {
    negative = !negative;
    s = s.slice(0, -1);
  }
  if (!/^[\d.,]+$/.test(s)) return null;
  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  let decimal: '.' | ',' | null = null;
  if (lastDot >= 0 && lastComma >= 0) decimal = lastDot > lastComma ? '.' : ',';
  else {
    const sep = lastDot >= 0 ? '.' : lastComma >= 0 ? ',' : null;
    // Un seul séparateur suivi d'1 ou 2 chiffres, et pas répété : c'est la décimale (« 1250,50 »).
    if (sep && s.split(sep).length === 2 && /^\d{1,2}$/.test(s.slice(s.lastIndexOf(sep) + 1))) decimal = sep;
  }
  let intPart = s;
  let frac = '';
  if (decimal) {
    intPart = s.slice(0, s.lastIndexOf(decimal));
    frac = s.slice(s.lastIndexOf(decimal) + 1);
  }
  intPart = intPart.replace(/[.,]/g, '');
  if (!/^\d+$/.test(intPart || '0') || !/^\d*$/.test(frac)) return null;
  const v = Math.round(Number(`${intPart || '0'}.${frac || '0'}`));
  return negative ? -v : v;
}

/** Date « 06/10/2026 », « 6-10-26 », « 2026-10-06 » ou « 06/10/2026 14:32 » vers AAAA-MM-JJ. */
export function parseStatementDate(raw: string): string | null {
  const s = raw.trim();
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(s);
  if (m) return valid(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/.exec(s);
  if (m) {
    const y = m[3]!.length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    return valid(y, Number(m[2]), Number(m[1]));
  }
  return null;
}

function valid(y: number, mo: number, d: number): string | null {
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Découpe une ligne CSV en tenant compte des guillemets. */
function splitCsv(line: string, sep: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === sep) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out.map((c) => c.trim());
}

const COLUMN_WORDS: [keyof ParsedStatement['columns'], string[]][] = [
  ['date', ['date operation', "date d'operation", 'date op', 'date', 'jour']],
  ['label', ['libelle', 'description', 'designation', 'motif', 'details', 'detail', 'narration', 'operation', 'type']],
  ['reference', ['reference', 'ref', 'transaction id', 'id transaction', 'numero', 'n° piece', 'piece', 'id']],
  ['debit', ['debit', 'retrait', 'sortie', 'paye', 'montant debit']],
  ['credit', ['credit', 'depot', 'entree', 'recu', 'montant credit']],
  ['fee', ['frais', 'fee', 'fees', 'commission']],
  ['amount', ['montant', 'amount', 'somme', 'valeur']],
];

/**
 * Lit un relevé exporté en CSV (banque, MTN MoMo, Orange Money). Les
 * colonnes sont reconnues par leur titre : date, libellé, référence, puis
 * débit et crédit séparés ou un montant signé. Une colonne de frais donne une
 * ligne de frais à part.
 */
export function parseStatementCsv(text: string): ParsedStatement {
  const rows = text.replace(/^﻿/, '').split(/\r?\n/);
  const headerIdx = rows.findIndex((r) => /date/i.test(fold(r)));
  const skipped: ParsedStatement['skipped'] = [];
  if (headerIdx < 0) return { lines: [], skipped: [{ row: 1, reason: 'Aucune ligne de titres avec une colonne « Date »' }], columns: {} };
  const header = rows[headerIdx]!;
  const sep = [';', '\t', ','].map((s) => [s, header.split(s).length] as const).sort((a, b) => b[1] - a[1])[0]![0];
  const titles = splitCsv(header, sep).map(fold);
  const columns: ParsedStatement['columns'] = {};
  const index: Partial<Record<keyof ParsedStatement['columns'], number>> = {};
  const taken = new Set<number>();
  for (const [key, words] of COLUMN_WORDS) {
    for (const w of words) {
      const i = titles.findIndex((t, k) => !taken.has(k) && (t === w || t.startsWith(`${w} `) || t.startsWith(w)));
      if (i >= 0) {
        index[key] = i;
        columns[key] = splitCsv(header, sep)[i];
        taken.add(i);
        break;
      }
    }
  }
  if (index.date === undefined || (index.amount === undefined && index.debit === undefined && index.credit === undefined)) {
    return { lines: [], skipped: [{ row: headerIdx + 1, reason: 'Colonnes « Date » et « Montant » (ou « Débit » / « Crédit ») introuvables' }], columns };
  }
  const lines: StatementLine[] = [];
  for (let r = headerIdx + 1; r < rows.length; r++) {
    const raw = rows[r]!;
    if (!raw.trim()) continue;
    const cells = splitCsv(raw, sep);
    const cell = (k: keyof ParsedStatement['columns']) => (index[k] === undefined ? '' : (cells[index[k]!] ?? ''));
    const date = parseStatementDate(cell('date'));
    if (!date) {
      // Lignes de solde ou de total sans date : ignorées sans bruit.
      if (cell('date')) skipped.push({ row: r + 1, reason: `Date illisible : « ${cell('date')} »` });
      continue;
    }
    let amount: number | null;
    if (index.debit !== undefined || index.credit !== undefined) {
      const d = cell('debit') ? parseStatementAmount(cell('debit')) : 0;
      const c = cell('credit') ? parseStatementAmount(cell('credit')) : 0;
      amount = d === null || c === null ? null : Math.abs(c) - Math.abs(d);
      if (amount === 0 && index.amount !== undefined) amount = parseStatementAmount(cell('amount'));
    } else amount = parseStatementAmount(cell('amount'));
    if (amount === null) {
      skipped.push({ row: r + 1, reason: 'Montant illisible' });
      continue;
    }
    const label = cell('label') || 'Opération';
    const reference = cell('reference') || null;
    if (amount) lines.push({ date, label, reference, amount });
    const fee = cell('fee') ? parseStatementAmount(cell('fee')) : 0;
    if (fee) lines.push({ date, label: `Frais : ${label}`, reference, amount: -Math.abs(fee) });
  }
  return { lines, skipped, columns };
}
