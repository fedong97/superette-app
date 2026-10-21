import type { Fcfa, Milli } from '@superette/core';
import type { AdminService } from './admin';
import type { Db } from './database';
import type { Inventory, InventoryService } from './inventories';
import { AppError, Base, type Clock, type Context } from './util';

/** Produit proposé au comptage de la semaine, avec ce qui l'a fait choisir. */
export interface CycleCountRow {
  article_id: string;
  article_code: string;
  article_name: string;
  department_name: string | null;
  stock: Milli;
  value: Fcfa;
  /** Inventaires clos où le produit avait un écart (sur un an). */
  gaps: number;
  /** Dernier comptage clos (null : jamais compté). */
  last_counted: string | null;
  days_since: number | null;
  /** Raisons lisibles : « valeur élevée », « souvent en écart », « jamais compté ». */
  reasons: string[];
  score: number;
}

/** Produits comptés récemment (jours) : ils attendent leur tour. */
const RECENT_DAYS = 28;

/**
 * Inventaire tournant : chaque semaine, une liste courte de produits à compter,
 * choisie par valeur en stock, écarts passés et temps depuis le dernier
 * comptage. Le magasin ne ferme jamais pour un grand inventaire : tout le stock
 * finit par être compté, les produits chers et sensibles plus souvent.
 */
export class CycleCountService extends Base {
  constructor(
    db: Db,
    clock: Clock,
    private readonly admin: AdminService,
    private readonly inventories: InventoryService,
  ) {
    super(db, clock);
  }

  proposal(storeId: string, warehouseId: string, opts: { size?: number } = {}): CycleCountRow[] {
    const wh = this.admin.getWarehouse(warehouseId);
    if (wh.store_id !== storeId) throw new AppError("Ce dépôt n'est pas dans ce magasin", 'FORBIDDEN');
    const size = opts.size ?? this.admin.storeSettings(storeId).cycleCountPerWeek;
    const today = this.today();
    const yearAgo = new Date(Date.parse(`${today}T00:00:00Z`) - 365 * 86_400_000).toISOString().slice(0, 10);
    const rows = this.db
      .prepare(
        `SELECT a.id AS article_id, a.code AS article_code, a.name AS article_name, d.name AS department_name, s.qty AS stock,
                CAST(ROUND(s.qty * s.avg_cost / 1000.0) AS INTEGER) AS value,
                (SELECT COUNT(*) FROM inventory_lines l JOIN inventories i ON i.id = l.inventory_id
                  WHERE l.article_id = a.id AND i.warehouse_id = s.warehouse_id AND i.status = 'closed' AND COALESCE(l.difference, 0) <> 0 AND i.inventory_date >= @yearAgo) AS gaps,
                (SELECT MAX(i.inventory_date) FROM inventory_lines l JOIN inventories i ON i.id = l.inventory_id
                  WHERE l.article_id = a.id AND i.warehouse_id = s.warehouse_id AND i.status = 'closed' AND l.counted IS NOT NULL) AS last_counted,
                (SELECT 1 FROM inventory_lines l JOIN inventories i ON i.id = l.inventory_id
                  WHERE l.article_id = a.id AND i.warehouse_id = s.warehouse_id AND i.status = 'open' LIMIT 1) AS open_count
         FROM stock s JOIN articles a ON a.id = s.article_id LEFT JOIN families f ON f.id = a.family_id LEFT JOIN departments d ON d.id = f.department_id
         WHERE s.warehouse_id = @warehouseId AND a.active = 1 AND a.is_service = 0 AND s.qty > 0`,
      )
      .all({ warehouseId, yearAgo }) as (Omit<CycleCountRow, 'days_since' | 'reasons' | 'score'> & { open_count: number | null })[];
    if (!rows.length) return [];
    const values = rows.map((r) => r.value).sort((a, b) => a - b);
    const p80 = values[Math.floor(values.length * 0.8)] ?? 0;
    const maxValue = values[values.length - 1] || 1;
    const out: CycleCountRow[] = [];
    for (const { open_count, ...r } of rows) {
      if (open_count) continue;
      const days = r.last_counted ? Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${r.last_counted}T00:00:00Z`)) / 86_400_000) : null;
      if (days !== null && days < RECENT_DAYS) continue;
      const reasons: string[] = [];
      if (r.value >= p80 && r.value > 0) reasons.push('valeur élevée');
      if (r.gaps > 0) reasons.push(r.gaps > 1 ? `${r.gaps} écarts en un an` : 'un écart en un an');
      if (days === null) reasons.push('jamais compté');
      else if (days > 90) reasons.push(`pas compté depuis ${days} jours`);
      // Valeur (0-50), écarts passés (15 par écart, 45 au plus), ancienneté du comptage (jusqu'à 40).
      const score = Math.round((r.value / maxValue) * 50) + Math.min(45, r.gaps * 15) + (days === null ? 40 : Math.min(40, Math.round(days / 9)));
      out.push({ ...r, days_since: days, reasons, score });
    }
    return out.sort((a, b) => b.score - a.score || b.value - a.value).slice(0, size);
  }

  /** Ouvre l'inventaire partiel de la semaine avec les produits choisis. */
  start(ctx: Context, warehouseId: string, articleIds: string[]): Inventory {
    if (!articleIds.length) throw new AppError('Choisissez au moins un produit', 'EMPTY');
    const week = this.isoWeek(this.today());
    return this.inventories.create(ctx, { warehouseId, kind: 'partial', articleIds, label: `Inventaire tournant, semaine ${week}` });
  }

  private isoWeek(day: string): number {
    const d = new Date(`${day}T00:00:00Z`);
    const dayNum = (d.getUTCDay() + 6) % 7;
    d.setUTCDate(d.getUTCDate() - dayNum + 3);
    const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
    return 1 + Math.round(((d.getTime() - firstThursday.getTime()) / 86_400_000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  }
}
