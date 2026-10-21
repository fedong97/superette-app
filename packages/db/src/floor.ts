import type { Milli } from '@superette/core';
import type { Db } from './database';
import { nextVisit } from './purchases';
import type { StockService } from './stock';
import { AppError, Base, type Clock, type Context } from './util';

/** Ligne de la liste de réassort : ce qu'il faut monter de la réserve au rayon. */
export interface RestockRow {
  article_id: string;
  code: string;
  name: string;
  department_name: string | null;
  unit: 'piece' | 'kg' | 'litre';
  unit_name: string | null;
  /** En rayon (surface de vente). */
  shelf: Milli;
  /** Ce qu'il faut garder en rayon : réglé sur la fiche, sinon deux jours de ventes. */
  target: Milli;
  /** La quantité vient du réglage de la fiche (sinon des ventes). */
  target_set: boolean;
  from_warehouse_id: string;
  from_name: string;
  /** Stock du dépôt de départ. */
  available: Milli;
  /** Emplacement dans le dépôt de départ (allée, étagère). */
  location: string | null;
  /** Quantité proposée, arrondie au carton quand c'est possible. */
  qty: Milli;
  pack_name: string | null;
  pack_units: Milli | null;
}

export interface RestockPlan {
  shop: { id: string; name: string } | null;
  rows: RestockRow[];
}

export type DayTaskKind = 'reception' | 'transfer_ship' | 'transfer_receive' | 'restock' | 'cycle' | 'expiry' | 'supplier_visit' | 'inventory' | 'missed';

/** Tâche du jour, à cocher. */
export interface DayTask {
  key: string;
  kind: DayTaskKind;
  label: string;
  detail: string | null;
  open: [string, string?];
  done: boolean;
  done_at: string | null;
}

/**
 * Le magasin au quotidien : liste de réassort du rayon (ce qu'il faut monter
 * de la réserve, avec l'emplacement) et tâches du jour à cocher.
 */
export class FloorService extends Base {
  constructor(
    db: Db,
    clock: Clock,
    private readonly stock: StockService,
  ) {
    super(db, clock);
  }

  /** Surface de vente du magasin : le dépôt de vente par défaut, sinon le premier dépôt « magasin ». */
  private shopOf(storeId: string): { id: string; name: string } | null {
    return (
      (this.db
        .prepare(
          `SELECT id, name FROM warehouses WHERE store_id = ? AND active = 1 AND purpose = 'stock'
           ORDER BY is_sales_default DESC, kind = 'shop' DESC, name LIMIT 1`,
        )
        .get(storeId) as { id: string; name: string } | undefined) ?? null
    );
  }

  restockList(storeId: string): RestockPlan {
    const shop = this.shopOf(storeId);
    if (!shop) return { shop: null, rows: [] };
    const since = new Date(this.clock().getTime() - 14 * 86_400_000).toISOString();
    const rows = this.db
      .prepare(
        `SELECT a.id AS article_id, a.code, a.name, a.unit, a.unit_name, a.shelf_qty, a.locations, d.name AS department_name,
                COALESCE((SELECT qty FROM stock WHERE article_id = a.id AND warehouse_id = @shop), 0) AS shelf,
                COALESCE((SELECT -SUM(m.qty) FROM stock_movements m WHERE m.article_id = a.id AND m.warehouse_id = @shop
                           AND m.type IN ('SALE', 'RETURN') AND m.at >= @since), 0) AS sold
         FROM articles a LEFT JOIN families f ON f.id = a.family_id LEFT JOIN departments d ON d.id = f.department_id
         WHERE a.active = 1 AND a.is_service = 0
           AND EXISTS (SELECT 1 FROM stock s JOIN warehouses w ON w.id = s.warehouse_id
                       WHERE s.article_id = a.id AND w.store_id = @storeId AND w.id <> @shop AND w.active = 1 AND w.purpose = 'stock' AND s.qty > 0)`,
      )
      .all({ storeId, shop: shop.id, since }) as {
      article_id: string;
      code: string;
      name: string;
      unit: RestockRow['unit'];
      unit_name: string | null;
      shelf_qty: Milli | null;
      locations: string | null;
      department_name: string | null;
      shelf: Milli;
      sold: Milli;
    }[];
    const reserves = this.db.prepare(
      `SELECT w.id, w.name, s.qty FROM stock s JOIN warehouses w ON w.id = s.warehouse_id
       WHERE s.article_id = ? AND w.store_id = ? AND w.id <> ? AND w.active = 1 AND w.purpose = 'stock' AND s.qty > 0 ORDER BY w.kind = 'reserve' DESC, s.qty DESC`,
    );
    const packOf = this.db.prepare('SELECT name, units FROM article_packs WHERE article_id = ? ORDER BY units LIMIT 1');
    const out: RestockRow[] = [];
    for (const r of rows) {
      const daily = Math.max(0, r.sold) / 14;
      // Sans réglage : deux jours de ventes, en pièces entières.
      const twoDays = daily * 2;
      const target = r.shelf_qty ?? (twoDays <= 0 ? 0 : r.unit === 'piece' ? Math.ceil(twoDays / 1000) * 1000 : Math.ceil(twoDays));
      if (target <= 0 || r.shelf >= target) continue;
      const from = reserves.get(r.article_id, storeId, shop.id) as { id: string; name: string; qty: Milli } | undefined;
      if (!from) continue;
      const pack = packOf.get(r.article_id) as { name: string; units: Milli } | undefined;
      const need = target - Math.max(0, r.shelf);
      let qty = Math.min(from.qty, need);
      // Un carton entier quand il tient dans la réserve : c'est ce que le magasinier monte.
      if (pack && pack.units > 0) {
        const cartons = Math.ceil(need / pack.units) * pack.units;
        if (cartons <= from.qty) qty = cartons;
      }
      let location: string | null = null;
      try {
        location = r.locations ? ((JSON.parse(r.locations) as Record<string, string>)[from.id] ?? null) : null;
      } catch {
        location = null;
      }
      out.push({
        article_id: r.article_id,
        code: r.code,
        name: r.name,
        department_name: r.department_name,
        unit: r.unit,
        unit_name: r.unit_name,
        shelf: r.shelf,
        target,
        target_set: r.shelf_qty !== null,
        from_warehouse_id: from.id,
        from_name: from.name,
        available: from.qty,
        location,
        qty,
        pack_name: pack?.name ?? null,
        pack_units: pack?.units ?? null,
      });
    }
    // Rangé par dépôt puis par emplacement : le magasinier fait sa tournée dans l'ordre.
    out.sort((a, b) => a.from_name.localeCompare(b.from_name, 'fr') || (a.location ?? '~').localeCompare(b.location ?? '~', 'fr', { numeric: true }) || a.name.localeCompare(b.name, 'fr'));
    return { shop, rows: out };
  }

  /** Monte en rayon les lignes choisies : un transfert direct par dépôt de départ. */
  restock(ctx: Context, lines: { articleId: string; fromWarehouseId: string; qty: Milli }[]): { transfers: number; lines: number } {
    const shop = this.shopOf(ctx.storeId);
    if (!shop) throw new AppError("Ce magasin n'a pas de surface de vente", 'INVALID');
    const kept = lines.filter((l) => Number.isSafeInteger(l.qty) && l.qty > 0);
    if (!kept.length) throw new AppError('Aucune quantité à monter en rayon', 'EMPTY');
    const byFrom = new Map<string, { articleId: string; qty: Milli }[]>();
    for (const l of kept) {
      const wh = this.db.prepare('SELECT store_id FROM warehouses WHERE id = ?').pluck().get(l.fromWarehouseId) as string | undefined;
      if (wh !== ctx.storeId) throw new AppError("Ce dépôt n'est pas dans ce magasin", 'FORBIDDEN');
      byFrom.set(l.fromWarehouseId, [...(byFrom.get(l.fromWarehouseId) ?? []), { articleId: l.articleId, qty: l.qty }]);
    }
    return this.tx(() => {
      for (const [from, ls] of byFrom) this.stock.transfer(ctx, { fromWarehouseId: from, toWarehouseId: shop.id, lines: ls });
      this.audit(ctx.userId, 'stock.restock', 'warehouse', shop.id, { lines: kept.length });
      return { transfers: byFrom.size, lines: kept.length };
    });
  }

  /** Quantité à garder en rayon, réglée sur la fiche du produit (null : deux jours de ventes). */
  setShelfQty(ctx: Context, articleId: string, qty: Milli | null): void {
    if (qty !== null && (!Number.isSafeInteger(qty) || qty < 0)) throw new AppError('Quantité invalide', 'INVALID');
    this.tx(() => {
      const r = this.db.prepare('UPDATE articles SET shelf_qty = ?, updated_at = ? WHERE id = ?').run(qty, this.now(), articleId);
      if (!r.changes) throw new AppError('Produit introuvable', 'NOT_FOUND');
      this.enqueue(null, 'article', articleId, 'upsert', {});
      this.audit(ctx.userId, 'article.shelf_qty', 'article', articleId, { qty });
    });
  }

  /** Tâches du jour du magasin, selon ce que l'utilisateur peut faire. */
  dayTasks(storeId: string, can: (right: string) => boolean): DayTask[] {
    const today = this.today();
    const tasks: Omit<DayTask, 'done' | 'done_at'>[] = [];
    if (can('order_receive') || can('purchases')) {
      const orders = this.db
        .prepare(
          `SELECT o.id, o.number, s.name AS supplier, o.expected_date FROM purchase_orders o JOIN suppliers s ON s.id = o.supplier_id
           WHERE o.store_id = ? AND o.status = 'sent' AND o.expected_date IS NOT NULL AND o.expected_date <= ? ORDER BY o.expected_date`,
        )
        .all(storeId, today) as { id: string; number: string; supplier: string; expected_date: string }[];
      for (const o of orders)
        tasks.push({
          key: `reception:${o.id}`,
          kind: 'reception',
          label: `Réception attendue : ${o.number} (${o.supplier})`,
          detail: o.expected_date < today ? `En retard depuis le ${fr(o.expected_date)}` : "Prévue aujourd'hui",
          open: ['purchases', 'orders'],
        });
    }
    if (can('transfer_ship')) {
      const toShip = this.db
        .prepare(
          `SELECT t.id, t.number, w.name AS to_name FROM transfers t JOIN warehouses f ON f.id = t.from_warehouse_id JOIN warehouses w ON w.id = t.to_warehouse_id
           WHERE f.store_id = ? AND t.status = 'draft' ORDER BY t.created_at`,
        )
        .all(storeId) as { id: string; number: number; to_name: string }[];
      for (const t of toShip) tasks.push({ key: `ship:${t.id}`, kind: 'transfer_ship', label: `Transfert n° ${t.number} à expédier`, detail: `Vers ${t.to_name}`, open: ['stock', 'transfer'] });
    }
    if (can('transfer_receive')) {
      const toReceive = this.db
        .prepare(
          `SELECT t.id, t.number, f.name AS from_name FROM transfers t JOIN warehouses f ON f.id = t.from_warehouse_id JOIN warehouses w ON w.id = t.to_warehouse_id
           WHERE w.store_id = ? AND t.status = 'shipped' ORDER BY t.shipped_at`,
        )
        .all(storeId) as { id: string; number: number; from_name: string }[];
      for (const t of toReceive) tasks.push({ key: `receive:${t.id}`, kind: 'transfer_receive', label: `Transfert n° ${t.number} à réceptionner`, detail: `Venant de ${t.from_name}`, open: ['stock', 'transfer'] });
    }
    if (can('transfer_direct')) {
      const n = this.restockList(storeId).rows.length;
      if (n) tasks.push({ key: 'restock', kind: 'restock', label: `Réassort du rayon : ${n} produit${n > 1 ? 's' : ''} à monter`, detail: null, open: ['stock', 'restock'] });
    }
    if (can('inventory_count') || can('cycle_count')) {
      const open = this.db
        .prepare("SELECT id, number, label FROM inventories WHERE store_id = ? AND status = 'open' ORDER BY opened_at")
        .all(storeId) as { id: string; number: number; label: string | null }[];
      for (const i of open) tasks.push({ key: `inventory:${i.id}`, kind: 'inventory', label: `Inventaire n° ${i.number} à compter`, detail: i.label, open: ['stock', 'inventory'] });
      const weekAgo = new Date(this.clock().getTime() - 7 * 86_400_000).toISOString();
      const recent = this.db.prepare("SELECT 1 FROM inventories WHERE store_id = ? AND label LIKE 'Inventaire tournant%' AND opened_at >= ?").get(storeId, weekAgo);
      if (!recent && can('cycle_count'))
        tasks.push({ key: 'cycle', kind: 'cycle', label: "Lancer l'inventaire tournant de la semaine", detail: 'Une vingtaine de produits choisis par valeur et écarts passés', open: ['stock', 'cycle'] });
    }
    if (can('stock_loss') || can('clearance')) {
      const soon = new Date(Date.parse(`${today}T00:00:00Z`) + 7 * 86_400_000).toISOString().slice(0, 10);
      const n = this.db
        .prepare(
          `SELECT COUNT(DISTINCT l.article_id) FROM lots l JOIN warehouses w ON w.id = l.warehouse_id
           WHERE w.store_id = ? AND l.qty > 0 AND l.expiry IS NOT NULL AND l.expiry <= ?`,
        )
        .pluck()
        .get(storeId, soon) as number;
      if (n)
        tasks.push({
          key: 'expiry',
          kind: 'expiry',
          label: `${n} produit${n > 1 ? 's' : ''} à déstocker ou à solder`,
          detail: 'Périmés ou qui périment dans les 7 jours',
          open: can('clearance') ? ['stock', 'clearance'] : ['stock', 'expiry'],
        });
    }
    if (can('reorder')) {
      const tomorrow = new Date(Date.parse(`${today}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
      const visits = this.db.prepare('SELECT id, name, visit_days FROM suppliers WHERE active = 1 AND visit_days IS NOT NULL').all() as { id: string; name: string; visit_days: string }[];
      for (const v of visits) {
        const next = nextVisit(v.visit_days, today);
        if (next !== today && next !== tomorrow) continue;
        tasks.push({
          key: `visit:${v.id}:${next}`,
          kind: 'supplier_visit',
          label: `${v.name} passe ${next === today ? "aujourd'hui" : 'demain'} : préparer la commande`,
          detail: 'La proposition de commande de ce fournisseur est prête',
          open: ['purchases', 'calendar'],
        });
      }
    }
    if (can('reorder')) {
      const since = new Date(this.clock().getTime() - 86_400_000).toISOString();
      const n = this.db.prepare('SELECT COUNT(*) FROM missed_sales WHERE store_id = ? AND created_at >= ?').pluck().get(storeId, since) as number;
      if (n) tasks.push({ key: `missed:${today}`, kind: 'missed', label: `${n} vente${n > 1 ? 's' : ''} manquée${n > 1 ? 's' : ''} notée${n > 1 ? 's' : ''} depuis hier`, detail: 'Ce que les clients voulaient', open: ['purchases', 'missed'] });
    }
    const checks = new Map(
      (this.db.prepare('SELECT task_key, done_at FROM day_task_checks WHERE day = ?').all(today) as { task_key: string; done_at: string }[]).map((c) => [c.task_key, c.done_at]),
    );
    return tasks.map((t) => ({ ...t, done: checks.has(t.key), done_at: checks.get(t.key) ?? null }));
  }

  /**
   * « Avant de clôturer » : tickets en attente sur cette caisse, paiements
   * Mobile Money pas encore confirmés, livraisons parties sans retour. Les
   * paniers préparés au rayon sont ajoutés par le PC (ils sont sur le serveur).
   */
  beforeClose(storeId: string, registerId: string): BeforeCloseItem[] {
    const out: BeforeCloseItem[] = [];
    const held = this.db
      .prepare('SELECT h.label, u.name AS user_name, h.created_at FROM held_tickets h LEFT JOIN users u ON u.id = h.user_id WHERE h.register_id = ? ORDER BY h.created_at')
      .all(registerId) as { label: string; user_name: string | null; created_at: string }[];
    if (held.length)
      out.push({ key: 'held', label: 'Tickets en attente', count: held.length, detail: held.map((h) => `${h.label}${h.user_name ? ` (${h.user_name})` : ''}`), open: null });
    const since = new Date(this.clock().getTime() - 2 * 86_400_000).toISOString();
    const momo = this.db
      .prepare("SELECT method, phone, amount FROM mobile_payments WHERE store_id = ? AND (register_id = ? OR register_id IS NULL) AND status = 'pending' AND created_at >= ? ORDER BY created_at")
      .all(storeId, registerId, since) as { method: string; phone: string; amount: number }[];
    if (momo.length)
      out.push({
        key: 'momo',
        label: 'Demandes Mobile Money non confirmées',
        count: momo.length,
        detail: momo.map((m) => `${m.method === 'MTN_MOMO' ? 'MTN MoMo' : 'Orange Money'} ${m.phone} : ${m.amount.toLocaleString('fr-FR')} FCFA`),
        open: null,
      });
    const deliveries = this.db
      .prepare(
        `SELECT s.number, d.courier, s.total_ttc FROM sale_deliveries d JOIN sales s ON s.id = d.sale_id
         WHERE d.store_id = ? AND d.status = 'out' ORDER BY d.out_at`,
      )
      .all(storeId) as { number: string; courier: string | null; total_ttc: number }[];
    if (deliveries.length)
      out.push({
        key: 'deliveries',
        label: 'Livraisons parties, pas encore revenues',
        count: deliveries.length,
        detail: deliveries.map((d) => `${d.number}${d.courier ? ` avec ${d.courier}` : ''}`),
        open: ['deliveries'],
      });
    return out;
  }

  checkTask(ctx: Context, key: string, done: boolean): void {
    const day = this.today();
    if (done) this.db.prepare('INSERT OR REPLACE INTO day_task_checks (day, task_key, user_id, done_at) VALUES (?, ?, ?, ?)').run(day, key, ctx.userId, this.now());
    else this.db.prepare('DELETE FROM day_task_checks WHERE day = ? AND task_key = ?').run(day, key);
  }
}

/** Ce qui reste ouvert avant de clôturer la caisse. */
export interface BeforeCloseItem {
  key: 'held' | 'momo' | 'deliveries' | 'carts';
  label: string;
  count: number;
  detail: string[];
  open: [string, string?] | null;
}

const fr = (d: string) => d.split('-').reverse().join('/');
