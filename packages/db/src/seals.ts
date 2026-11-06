import { createHash } from 'node:crypto';
import type { Db } from './database';
import { Base } from './util';

/**
 * Journal scellé (0.116.0) : chaque vente, ligne, paiement, mouvement de caisse,
 * de stock et de trésorerie reçoit à sa création une empreinte, enchaînée à la
 * précédente comme les maillons d'une chaîne (table `seals`). Une modification ou
 * une suppression faite par ONIX ajoute un nouveau maillon ; une modification faite
 * en dehors d'ONIX (outil SQLite, fichier de base retouché) n'en ajoute pas, et le
 * contrôle d'intégrité la signale.
 *
 * Les déclencheurs sont TEMPORAIRES (propres à la connexion ouverte par ONIX) : ils
 * appellent la fonction d'empreinte enregistrée par `openDatabase`. Un autre outil
 * qui ouvre la base n'a ni les déclencheurs ni la fonction : ce qu'il change n'est
 * pas scellé, donc se voit.
 */

/** Tables scellées, avec le nom de la pièce lisible par le gérant. */
export const SEALED_TABLES: Record<string, { label: string; ref?: string }> = {
  sales: { label: 'Ticket ou facture', ref: 'number' },
  sale_lines: { label: 'Ligne de ticket', ref: 'label' },
  sale_payments: { label: 'Paiement de ticket', ref: 'method' },
  cash_sessions: { label: 'Journée de caisse', ref: 'z_number' },
  cash_operations: { label: 'Apport ou prélèvement de caisse', ref: 'reason' },
  cash_handovers: { label: 'Remise de caisse' },
  central_cash_movements: { label: 'Mouvement de la caisse centrale' },
  treasury_entries: { label: 'Encaissement ou décaissement', ref: 'number' },
  emoney_movements: { label: 'Mouvement de caisse électronique' },
  customer_payments: { label: 'Règlement client', ref: 'number' },
  payment_allocations: { label: 'Affectation de règlement' },
  supplier_invoices: { label: 'Facture fournisseur', ref: 'number' },
  supplier_payments: { label: 'Règlement fournisseur', ref: 'number' },
  receptions: { label: 'Bon de réception', ref: 'number' },
  reception_lines: { label: 'Ligne de réception' },
  expenses: { label: 'Dépense', ref: 'number' },
  manual_entries: { label: 'Écriture comptable manuelle', ref: 'label' },
  manual_entry_lines: { label: "Ligne d'écriture manuelle", ref: 'account' },
  opening_balances: { label: 'Solde de départ' },
  stock_movements: { label: 'Mouvement de stock', ref: 'type' },
  inventory_entries: { label: "Saisie d'inventaire" },
  gift_vouchers: { label: "Bon d'achat", ref: 'code' },
  loyalty_moves: { label: 'Mouvement de points de fidélité' },
  staff_salaries: { label: 'Salaire', ref: 'number' },
  audit_log: { label: "Ligne du journal d'audit", ref: 'action' },
};

export type SealProblem = 'modified' | 'deleted' | 'added' | 'chain';

export const SEAL_PROBLEMS: Record<SealProblem, string> = {
  modified: 'Modifiée en dehors d’ONIX',
  deleted: 'Supprimée en dehors d’ONIX',
  added: 'Ajoutée en dehors d’ONIX',
  chain: 'Chaîne des empreintes rompue',
};

export interface SealFinding {
  problem: SealProblem;
  table: string;
  table_label: string;
  row_id: string;
  /** Numéro ou libellé de la pièce quand elle existe encore. */
  ref: string | null;
  /** Date du dernier maillon de la pièce (ou de la rupture). */
  at: string | null;
}

export interface SealCheck {
  at: string;
  ok: boolean;
  /** Maillons de la chaîne relus. */
  seals: number;
  /** Pièces contrôlées. */
  rows: number;
  findings: SealFinding[];
  /** Nombre total d'anomalies (la liste est limitée). */
  total: number;
  /** Début du contrôle sur ce PC (premier maillon). */
  since: string | null;
  /** Empreinte du dernier maillon, à noter ou à imprimer (12 caractères). */
  fingerprint: string | null;
}

const MAX_FINDINGS = 300;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const q = (name: string) => `"${name.replace(/"/g, '""')}"`;

/** Maillon : empreinte du précédent, de la pièce, de l'opération, de ses données et de l'heure. */
export const chainHash = (prev: string, tbl: string, rowId: string, op: string, data: string | null, at: string) => sha(`${prev}|${tbl}|${rowId}|${op}|${data ?? ''}|${at}`);

function tables(db: Db): string[] {
  const have = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").pluck().all() as string[]);
  return Object.keys(SEALED_TABLES).filter((t) => have.has(t));
}

function columns(db: Db, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${q(table)})`).all() as { name: string }[]).map((c) => c.name);
}

const rowData = (prefix: string, cols: string[]) => `onix_sha256(json_array(${cols.map((c) => `${prefix}${q(c)}`).join(', ')}))`;

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
const LAST = "COALESCE((SELECT hash FROM seals ORDER BY seq DESC LIMIT 1), '')";

function link(table: string, idExpr: string, op: string, data: string): string {
  const t = `'${table}'`;
  return `INSERT INTO seals (tbl, row_id, op, data, at, hash) VALUES (${t}, ${idExpr}, '${op}', ${data}, ${NOW},
    onix_sha256(${LAST} || '|' || ${t} || '|' || ${idExpr} || '|' || '${op}' || '|' || COALESCE(${data}, '') || '|' || ${NOW}));`;
}

/** Scelle d'un coup toutes les pièces actuelles d'une table (début du contrôle, ou colonnes changées par une mise à jour). */
function sealAll(db: Db, table: string, cols: string[], op: 'S' | 'M'): void {
  const rows = db.prepare(`SELECT id, ${rowData('', cols)} AS data FROM ${q(table)} ORDER BY rowid`).all() as { id: string; data: string }[];
  const insert = db.prepare('INSERT INTO seals (tbl, row_id, op, data, at, hash) VALUES (?, ?, ?, ?, ?, ?)');
  let prev = (db.prepare('SELECT hash FROM seals ORDER BY seq DESC LIMIT 1').pluck().get() as string | undefined) ?? '';
  const at = new Date().toISOString();
  for (const r of rows) {
    prev = chainHash(prev, table, r.id, op, r.data, at);
    insert.run(table, r.id, op, r.data, at, prev);
  }
}

/**
 * Prépare le scellement sur la connexion ouverte : fonction d'empreinte, colonnes
 * scellées de chaque table (une mise à jour qui ajoute une colonne fait d'abord
 * contrôler la table avec les anciennes colonnes, puis la rescelle), et déclencheurs
 * temporaires. Appelé par `openDatabase` après les migrations.
 */
export function installSeals(db: Db): void {
  db.function('onix_sha256', { deterministic: true }, (v: unknown) => (v == null ? null : sha(String(v))));
  if (db.readonly) return;
  const hasTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'seals'").get();
  if (!hasTable) return;
  db.transaction(() => {
    const known = new Map((db.prepare('SELECT tbl, cols FROM seal_tables').all() as { tbl: string; cols: string }[]).map((r) => [r.tbl, JSON.parse(r.cols) as string[]]));
    for (const table of tables(db)) {
      const cols = columns(db, table);
      const before = known.get(table);
      if (before && before.join(',') === cols.join(',')) continue;
      if (before) {
        // Colonnes changées par une mise à jour d'ONIX : les anomalies d'avant sont gardées, puis la table est rescellée.
        const still = before.filter((c) => cols.includes(c));
        const found = checkTable(db, table, still.length === before.length ? before : null);
        const keep = db.prepare('INSERT INTO seal_findings (at, problem, tbl, row_id, ref, seal_at) VALUES (?, ?, ?, ?, ?, ?)');
        const at = new Date().toISOString();
        for (const f of found.findings) keep.run(at, f.problem, f.table, f.row_id, f.ref, f.at);
      }
      sealAll(db, table, cols, before ? 'M' : 'S');
      db.prepare('INSERT INTO seal_tables (tbl, cols) VALUES (?, ?) ON CONFLICT(tbl) DO UPDATE SET cols = excluded.cols').run(table, JSON.stringify(cols));
    }
  })();
  for (const table of tables(db)) {
    const cols = columns(db, table);
    const name = (op: string) => q(`seal_${table}_${op}`);
    const changed = `json_array(${cols.map((c) => `NEW.${q(c)}`).join(', ')}) IS NOT json_array(${cols.map((c) => `OLD.${q(c)}`).join(', ')})`;
    db.exec(`
      DROP TRIGGER IF EXISTS temp.${name('i')};
      DROP TRIGGER IF EXISTS temp.${name('u')};
      DROP TRIGGER IF EXISTS temp.${name('d')};
      CREATE TEMP TRIGGER ${name('i')} AFTER INSERT ON main.${q(table)} BEGIN ${link(table, 'NEW.id', 'I', rowData('NEW.', cols))} END;
      CREATE TEMP TRIGGER ${name('u')} AFTER UPDATE ON main.${q(table)} WHEN ${changed} BEGIN ${link(table, 'NEW.id', 'U', rowData('NEW.', cols))} END;
      CREATE TEMP TRIGGER ${name('d')} AFTER DELETE ON main.${q(table)} BEGIN ${link(table, 'OLD.id', 'D', 'NULL')} END;
    `);
  }
}

/**
 * Compare les pièces d'une table à leur dernier maillon. `cols` : colonnes scellées
 * (par défaut celles enregistrées) ; null quand une colonne scellée a disparu (on ne
 * peut plus recalculer les empreintes : seules les pièces disparues ou ajoutées se voient).
 */
function checkTable(db: Db, table: string, cols?: string[] | null): { findings: SealFinding[]; rows: number } {
  const sealedCols = cols === undefined ? ((): string[] | null => {
    const raw = db.prepare('SELECT cols FROM seal_tables WHERE tbl = ?').pluck().get(table) as string | undefined;
    return raw ? (JSON.parse(raw) as string[]) : null;
  })() : cols;
  const meta = SEALED_TABLES[table]!;
  const current = columns(db, table);
  const refCol = meta.ref && current.includes(meta.ref) ? meta.ref : null;
  const rows = db
    .prepare(`SELECT id, ${sealedCols ? rowData('', sealedCols) : 'NULL'} AS data, ${refCol ? q(refCol) : 'NULL'} AS ref FROM ${q(table)}`)
    .all() as { id: string; data: string | null; ref: unknown }[];
  // Dernier maillon de chaque pièce (SQLite rend les colonnes de la ligne du MAX).
  const last = new Map(
    (db.prepare('SELECT row_id, op, data, at, MAX(seq) AS seq FROM seals WHERE tbl = ? GROUP BY row_id').all(table) as { row_id: string; op: string; data: string | null; at: string }[]).map(
      (s) => [s.row_id, s],
    ),
  );
  const findings: SealFinding[] = [];
  const base = { table, table_label: meta.label };
  for (const r of rows) {
    const s = last.get(r.id);
    const ref = r.ref == null ? null : String(r.ref);
    if (!s || s.op === 'D') findings.push({ ...base, problem: 'added', row_id: r.id, ref, at: s?.at ?? null });
    else if (sealedCols && s.data !== r.data) findings.push({ ...base, problem: 'modified', row_id: r.id, ref, at: s.at });
    last.delete(r.id);
  }
  for (const s of last.values()) if (s.op !== 'D') findings.push({ ...base, problem: 'deleted', row_id: s.row_id, ref: null, at: s.at });
  return { findings, rows: rows.length };
}

/** Contrôle d'intégrité : la chaîne des maillons, puis chaque pièce scellée comparée à son dernier maillon. */
export class SealService extends Base {
  /** `userId` : contrôle demandé par quelqu'un (tracé au journal d'audit) ; null : contrôle automatique du jour. */
  check(userId: string | null = null): SealCheck {
    const findings: SealFinding[] = [];
    let total = 0;
    const add = (f: SealFinding) => {
      total++;
      if (findings.length < MAX_FINDINGS) findings.push(f);
    };
    // 1. La chaîne : chaque maillon recalculé à partir du précédent, sans trou dans les numéros.
    let prev = '';
    let expected = 0;
    let count = 0;
    let since: string | null = null;
    let lastHash: string | null = null;
    const it = this.db.prepare('SELECT seq, tbl, row_id, op, data, at, hash FROM seals ORDER BY seq').iterate() as IterableIterator<{
      seq: number;
      tbl: string;
      row_id: string;
      op: string;
      data: string | null;
      at: string;
      hash: string;
    }>;
    for (const s of it) {
      count++;
      since ??= s.at;
      const broken = (expected && s.seq !== expected + 1) || chainHash(prev, s.tbl, s.row_id, s.op, s.data, s.at) !== s.hash;
      if (broken) add({ problem: 'chain', table: s.tbl, table_label: SEALED_TABLES[s.tbl]?.label ?? s.tbl, row_id: s.row_id, ref: `maillon n° ${s.seq}`, at: s.at });
      expected = s.seq;
      prev = s.hash;
      lastHash = s.hash;
    }
    // 2. Les pièces.
    let rows = 0;
    for (const table of tables(this.db)) {
      const r = checkTable(this.db, table);
      rows += r.rows;
      for (const f of r.findings) add(f);
    }
    const result: SealCheck = { at: this.now(), ok: total === 0, seals: count, rows, findings, total, since, fingerprint: lastHash ? lastHash.slice(0, 12).toUpperCase() : null };
    this.db
      .prepare("INSERT INTO settings (key, value) VALUES ('seal.lastCheck', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(JSON.stringify({ at: result.at, ok: result.ok, total, seals: count, rows }));
    // Contrôle demandé, ou anomalie trouvée : une ligne au journal d'audit.
    if (userId || !result.ok) this.audit(userId, 'integrity.check', undefined, undefined, { ok: result.ok, total, seals: count, rows });
    return result;
  }

  /** Contrôle automatique : une fois par jour au plus. */
  checkDaily(): SealCheck | null {
    const last = this.lastCheck();
    if (last && last.at.slice(0, 10) === this.now().slice(0, 10)) return null;
    return this.check(null);
  }

  /** Dernier contrôle fait sur ce PC (sans le refaire). */
  lastCheck(): { at: string; ok: boolean; total: number; seals: number; rows: number } | null {
    const raw = this.db.prepare("SELECT value FROM settings WHERE key = 'seal.lastCheck'").pluck().get() as string | undefined;
    return raw ? JSON.parse(raw) : null;
  }

  /** Anomalies relevées avant qu'une mise à jour d'ONIX ne rescelle une table. */
  earlierFindings(): (SealFinding & { found_at: string })[] {
    return (this.db.prepare('SELECT at, problem, tbl, row_id, ref, seal_at FROM seal_findings ORDER BY at DESC, id LIMIT 300').all() as {
      at: string;
      problem: SealProblem;
      tbl: string;
      row_id: string;
      ref: string | null;
      seal_at: string | null;
    }[]).map((f) => ({ problem: f.problem, table: f.tbl, table_label: SEALED_TABLES[f.tbl]?.label ?? f.tbl, row_id: f.row_id, ref: f.ref, at: f.seal_at, found_at: f.at }));
  }

  /** Empreinte du dernier maillon, à noter sur le rapport de clôture. */
  fingerprint(): string | null {
    const h = this.db.prepare('SELECT hash FROM seals ORDER BY seq DESC LIMIT 1').pluck().get() as string | undefined;
    return h ? h.slice(0, 12).toUpperCase() : null;
  }
}
