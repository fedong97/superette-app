import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { weightedAverageCost } from '@superette/core';
import type { BackupService, BackupInfo } from './backup';
import { inspectBackup } from './backup';
import type { Db } from './database';
import { AppError, Base, type Clock } from './util';

/**
 * Outil de réparation : vérifie la base et répare
 * ce qui se recalcule (stock, lots), sans jamais toucher la base à la main.
 * Il travaille par petits paquets : la caisse continue de vendre pendant ce temps.
 */
export interface RepairCheck {
  key: 'integrity' | 'foreign_keys' | 'stock' | 'lots' | 'outbox' | 'size';
  label: string;
  status: 'ok' | 'fixed' | 'problem' | 'info';
  detail: string;
}

export interface RepairReport {
  at: string;
  /** Rien à réparer, ou tout a été réparé. */
  ok: boolean;
  /** Base abîmée : il faut restaurer une sauvegarde (la réparation ne l'écrit pas). */
  damaged: boolean;
  checks: RepairCheck[];
  /** Sauvegarde faite juste avant la réparation. */
  backup: string | null;
}

type MovementRow = { article_id: string; warehouse_id: string; type: string; qty: number; unit_cost: number };

const CHUNK = 200;
const plural = (n: number, word: string) => `${n} ${word}${n > 1 ? 's' : ''}`;
const pause = () => new Promise<void>((r) => setImmediate(r));

/** Stock attendu par article et dépôt, rejoué à partir des mouvements (même calcul que StockService.recompute). */
function expectedStock(db: Db): Map<string, { article_id: string; warehouse_id: string; qty: number; avg: number }> {
  const out = new Map<string, { article_id: string; warehouse_id: string; qty: number; avg: number }>();
  const rows = db.prepare('SELECT article_id, warehouse_id, type, qty, unit_cost FROM stock_movements ORDER BY article_id, warehouse_id, at, id').iterate() as IterableIterator<MovementRow>;
  for (const m of rows) {
    const key = `${m.article_id}|${m.warehouse_id}`;
    let s = out.get(key);
    if (!s) out.set(key, (s = { article_id: m.article_id, warehouse_id: m.warehouse_id, qty: 0, avg: 0 }));
    if (m.qty > 0 && (m.type === 'RECEPTION' || m.type === 'TRANSFER_IN' || m.type === 'PRODUCTION_IN')) s.avg = weightedAverageCost(s.qty, s.avg, m.qty, m.unit_cost);
    s.qty += m.qty;
  }
  return out;
}

/** Articles et dépôts dont le stock enregistré ne correspond plus aux mouvements. */
export function stockGaps(db: Db) {
  const expected = expectedStock(db);
  const current = db.prepare('SELECT article_id, warehouse_id, qty, avg_cost FROM stock').all() as { article_id: string; warehouse_id: string; qty: number; avg_cost: number }[];
  const gaps: { article_id: string; warehouse_id: string; qty: number; avg: number }[] = [];
  const seen = new Set<string>();
  for (const c of current) {
    const key = `${c.article_id}|${c.warehouse_id}`;
    seen.add(key);
    const e = expected.get(key) ?? { article_id: c.article_id, warehouse_id: c.warehouse_id, qty: 0, avg: 0 };
    // Seule la quantité compte : le CMUP peut légitimement dépendre de l'ordre d'arrivée des mouvements.
    if (e.qty !== c.qty) gaps.push(e);
  }
  for (const [key, e] of expected) if (!seen.has(key) && e.qty !== 0) gaps.push(e);
  return gaps;
}

function lotGaps(db: Db): string[] {
  return db
    .prepare('SELECT l.id FROM lots l WHERE l.qty <> (SELECT COALESCE(SUM(m.qty), 0) FROM stock_movements m WHERE m.lot_id = l.id)')
    .pluck()
    .all() as string[];
}

/** Dernière sauvegarde valide trouvée dans un dossier (pour remplacer une base abîmée). */
export function latestGoodBackup(dir: string): BackupInfo | null {
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.db'));
  } catch {
    return null;
  }
  const infos = files.map((f) => inspectBackup(join(dir, f))).filter((i) => i.ok && i.kind !== 'safety');
  infos.sort((a, b) => b.created_at.localeCompare(a.created_at));
  return infos[0] ?? null;
}

/** Dossier des sauvegardes par défaut d'une base (« sauvegardes » à côté du fichier). */
export const defaultBackupDir = (dbFile: string) => join(dirname(dbFile), 'sauvegardes');

export class RepairService extends Base {
  constructor(
    db: Db,
    clock: Clock,
    private readonly backups: BackupService,
  ) {
    super(db, clock);
  }

  /** Vérifie la base sans rien modifier. */
  check(): RepairReport {
    return this.report(null, false);
  }

  /**
   * Répare ce qui peut l'être : une sauvegarde est faite d'abord, puis le stock et
   * les lots sont recalculés à partir des mouvements, par petits paquets.
   */
  async repair(userId: string | null): Promise<RepairReport> {
    const integrity = this.integrity();
    if (integrity !== 'ok') {
      // Une base abîmée ne se répare pas en écrivant dedans : on restaure une sauvegarde.
      return this.report(null, false);
    }
    let backup: string | null = null;
    if (!this.db.memory) {
      try {
        backup = (await this.backups.backup(userId, { kind: 'safety' })).file;
      } catch (e) {
        throw new AppError(`Réparation annulée : la sauvegarde d'avant réparation a échoué (${e instanceof Error ? e.message : String(e)})`, 'REPAIR_FAILED');
      }
    }
    const fixed = { stock: 0, lots: 0 };
    const gaps = stockGaps(this.db);
    const upsert = this.db.prepare(
      `INSERT INTO stock (article_id, warehouse_id, qty, avg_cost) VALUES (?, ?, ?, ?)
       ON CONFLICT(article_id, warehouse_id) DO UPDATE SET qty = excluded.qty, avg_cost = excluded.avg_cost`,
    );
    const recompute = this.db.prepare(
      `SELECT type, qty, unit_cost FROM stock_movements WHERE article_id = ? AND warehouse_id = ? ORDER BY at, id`,
    );
    for (let i = 0; i < gaps.length; i += CHUNK) {
      this.tx(() => {
        for (const g of gaps.slice(i, i + CHUNK)) {
          // Recalcul au moment de l'écriture : une vente faite entre-temps est comptée.
          let qty = 0;
          let avg = 0;
          for (const m of recompute.all(g.article_id, g.warehouse_id) as { type: string; qty: number; unit_cost: number }[]) {
            if (m.qty > 0 && (m.type === 'RECEPTION' || m.type === 'TRANSFER_IN' || m.type === 'PRODUCTION_IN')) avg = weightedAverageCost(qty, avg, m.qty, m.unit_cost);
            qty += m.qty;
          }
          upsert.run(g.article_id, g.warehouse_id, qty, avg);
          fixed.stock++;
        }
      });
      await pause();
    }
    const lots = lotGaps(this.db);
    const fixLot = this.db.prepare('UPDATE lots SET qty = (SELECT COALESCE(SUM(qty), 0) FROM stock_movements WHERE lot_id = ?) WHERE id = ?');
    for (let i = 0; i < lots.length; i += CHUNK) {
      this.tx(() => {
        for (const id of lots.slice(i, i + CHUNK)) fixLot.run(id, id);
      });
      fixed.lots += Math.min(CHUNK, lots.length - i);
      await pause();
    }
    // Rien de bloquant : on vide le journal quand personne n'écrit, et SQLite met ses statistiques à jour.
    this.db.pragma('wal_checkpoint(PASSIVE)');
    this.db.pragma('optimize');
    const report = this.report(backup, true, fixed);
    this.audit(userId, 'repair.run', undefined, undefined, { fixed, backup, ok: report.ok });
    return report;
  }

  private integrity(): string {
    const rows = this.db.pragma('quick_check(20)') as { quick_check: string }[];
    return rows.map((r) => r.quick_check).join(' ; ');
  }

  private report(backup: string | null, repaired: boolean, fixed = { stock: 0, lots: 0 }): RepairReport {
    const checks: RepairCheck[] = [];
    const integrity = this.integrity();
    const damaged = integrity !== 'ok';
    checks.push(
      damaged
        ? { key: 'integrity', label: 'Fichier de la base', status: 'problem', detail: `Fichier abîmé (${integrity.slice(0, 300)}). Restaurez la dernière sauvegarde (Administration › Sauvegardes).` }
        : { key: 'integrity', label: 'Fichier de la base', status: 'ok', detail: 'Aucune page abîmée.' },
    );
    if (damaged) return { at: this.now(), ok: false, damaged, checks, backup };

    const fk = this.db.pragma('foreign_key_check') as { table: string }[];
    const tables = [...new Set(fk.map((r) => r.table))];
    checks.push(
      fk.length
        ? { key: 'foreign_keys', label: 'Liens entre les données', status: 'problem', detail: `${plural(fk.length, 'ligne')} renvoie${fk.length > 1 ? 'nt' : ''} à une donnée absente (${tables.join(', ')}). Envoyez ce rapport au support.` }
        : { key: 'foreign_keys', label: 'Liens entre les données', status: 'ok', detail: 'Toutes les données renvoient à des fiches existantes.' },
    );

    const stock = stockGaps(this.db).length;
    checks.push(
      stock
        ? { key: 'stock', label: 'Stock', status: 'problem', detail: `${plural(stock, 'article')} dont le stock ne correspond plus aux mouvements : « Réparer » le recalcule.` }
        : repaired && fixed.stock
          ? { key: 'stock', label: 'Stock', status: 'fixed', detail: `Stock recalculé pour ${plural(fixed.stock, 'article')} à partir des mouvements.` }
          : { key: 'stock', label: 'Stock', status: 'ok', detail: 'Le stock correspond aux mouvements.' },
    );

    const lots = lotGaps(this.db).length;
    checks.push(
      lots
        ? { key: 'lots', label: 'Lots et péremptions', status: 'problem', detail: `${plural(lots, 'lot')} dont la quantité ne correspond plus aux mouvements : « Réparer » la recalcule.` }
        : repaired && fixed.lots
          ? { key: 'lots', label: 'Lots et péremptions', status: 'fixed', detail: `Quantité recalculée pour ${plural(fixed.lots, 'lot')}.` }
          : { key: 'lots', label: 'Lots et péremptions', status: 'ok', detail: 'Les lots correspondent aux mouvements.' },
    );

    const pending = this.db.prepare('SELECT COUNT(*) AS n, MIN(created_at) AS oldest FROM outbox WHERE sent_at IS NULL').get() as { n: number; oldest: string | null };
    const linked = this.db.prepare("SELECT 1 FROM settings WHERE key = 'sync.token'").get();
    checks.push({
      key: 'outbox',
      label: 'Envois au serveur',
      status: 'info',
      detail: !linked
        ? 'PC non relié à un serveur central.'
        : pending.n
          ? `${plural(pending.n, 'opération')} en attente d'envoi depuis le ${new Date(pending.oldest!).toLocaleString('fr-FR')}.`
          : 'Tout est envoyé.',
    });

    const pageSize = this.db.pragma('page_size', { simple: true }) as number;
    const pages = this.db.pragma('page_count', { simple: true }) as number;
    const free = this.db.pragma('freelist_count', { simple: true }) as number;
    const mo = (n: number) => `${((n * pageSize) / 1_048_576).toFixed(1).replace('.', ',')} Mo`;
    checks.push({ key: 'size', label: 'Taille', status: 'info', detail: `${mo(pages)}, dont ${mo(free)} d'espace libre réutilisé par les prochaines ventes.` });

    return { at: this.now(), ok: checks.every((c) => c.status !== 'problem'), damaged, checks, backup };
  }
}
