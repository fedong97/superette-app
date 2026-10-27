import { type Fcfa, type Milli } from '@superette/core';
import type { Db } from './database';
import type { StockService, TransferLot } from './stock';
import { AppError, Base, type Clock, type Context, newId } from './util';

export type StoreTransferStatus = 'requested' | 'shipped' | 'received' | 'refused' | 'cancelled';

export const STORE_TRANSFER_STATUS: Record<StoreTransferStatus, string> = {
  requested: 'Demandée',
  shipped: 'Expédiée',
  received: 'Réceptionnée',
  refused: 'Refusée',
  cancelled: 'Annulée',
};

export interface StoreTransferRequest {
  id: string;
  number: string;
  /** Magasin qui expédie (celui qui en a trop). */
  from_store_id: string;
  from_store_name: string;
  /** Magasin qui demande et réceptionne. */
  to_store_id: string;
  to_store_name: string;
  article_id: string;
  article_code: string;
  article_name: string;
  unit: string;
  qty: Milli;
  status: StoreTransferStatus;
  note: string | null;
  requested_by_name: string | null;
  shipped_qty: Milli | null;
  unit_cost: Fcfa | null;
  shipped_at: string | null;
  received_qty: Milli | null;
  received_at: string | null;
  answer: string | null;
  created_at: string;
  /** Vu depuis le magasin courant : on demande (in) ou on nous demande (out). */
  direction: 'in' | 'out';
}

/** Article à demander à un autre magasin plutôt qu'au fournisseur. */
export interface StoreTransferSuggestion {
  article_id: string;
  code: string;
  name: string;
  unit: string;
  /** Notre stock (dépôts du magasin) et le seuil d'alerte. */
  stock: Milli;
  alert_qty: Milli;
  /** Magasin qui en a le plus au-dessus de son propre seuil. */
  from_store_id: string;
  from_store_name: string;
  from_stock: Milli;
  /** Quantité proposée : ce qui nous manque, sans vider l'autre magasin. */
  qty: Milli;
  /** Dernière mise à jour du stock de l'autre magasin reçue ici. */
  updated_at: string | null;
}

/**
 * Demandes de marchandise entre magasins : avant d'acheter au fournisseur, le
 * magasin en manque la demande à celui qui en a trop. L'autre magasin expédie
 * (le stock sort chez lui au coût moyen, avec ses lots), puis le premier
 * réceptionne la quantité arrivée. Les deux magasins voient la demande.
 */
export class StoreTransferService extends Base {
  constructor(
    db: Db,
    clock: Clock,
    private readonly stock: StockService,
  ) {
    super(db, clock);
  }

  /** Stock d'un article dans un magasin : le nôtre en direct, les autres d'après le dernier envoi reçu. */
  private storeStock(storeId: string, articleId: string, own: boolean): Milli {
    const table = own ? 'stock' : 'stock_levels';
    return this.db
      .prepare(`SELECT COALESCE(SUM(l.qty), 0) FROM ${table} l JOIN warehouses w ON w.id = l.warehouse_id WHERE w.store_id = ? AND w.active = 1 AND l.article_id = ?`)
      .pluck()
      .get(storeId, articleId) as Milli;
  }

  /**
   * Articles sous leur seuil d'alerte ici et en surplus dans un autre magasin
   * (au-dessus de deux fois le seuil là-bas), sans demande déjà en cours.
   */
  suggestions(storeId: string): StoreTransferSuggestion[] {
    const low = this.db
      .prepare(
        `SELECT a.id, a.code, a.name, a.unit, a.alert_qty, a.max_qty,
                COALESCE((SELECT SUM(s.qty) FROM stock s JOIN warehouses w ON w.id = s.warehouse_id WHERE w.store_id = @storeId AND w.active = 1 AND s.article_id = a.id), 0) AS stock
         FROM articles a
         WHERE a.active = 1 AND a.is_service = 0 AND a.alert_qty IS NOT NULL AND a.alert_qty > 0
           AND NOT EXISTS (SELECT 1 FROM store_transfer_requests r WHERE r.article_id = a.id AND r.to_store_id = @storeId AND r.status IN ('requested', 'shipped'))`,
      )
      .all({ storeId }) as { id: string; code: string; name: string; unit: string; alert_qty: Milli; max_qty: Milli | null; stock: Milli }[];
    const others = this.db
      .prepare(
        `SELECT w.store_id, s.name AS store_name, l.qty, l.updated_at FROM stock_levels l JOIN warehouses w ON w.id = l.warehouse_id JOIN stores s ON s.id = w.store_id
         WHERE l.article_id = ? AND w.store_id <> ? AND w.active = 1 AND s.active = 1`,
      );
    const out: StoreTransferSuggestion[] = [];
    for (const a of low) {
      if (a.stock > a.alert_qty) continue;
      const byStore = new Map<string, { name: string; qty: Milli; at: string | null }>();
      for (const r of others.all(a.id, storeId) as { store_id: string; store_name: string; qty: Milli; updated_at: string | null }[]) {
        const s = byStore.get(r.store_id) ?? { name: r.store_name, qty: 0, at: null };
        s.qty += r.qty;
        if (r.updated_at && (!s.at || r.updated_at > s.at)) s.at = r.updated_at;
        byStore.set(r.store_id, s);
      }
      const target = Math.max(a.max_qty ?? 0, a.alert_qty * 2);
      let best: StoreTransferSuggestion | null = null;
      for (const [id, s] of byStore) {
        const surplus = s.qty - a.alert_qty * 2;
        let qty = Math.min(target - a.stock, surplus);
        if (a.unit === 'piece') qty = Math.floor(qty / 1000) * 1000;
        if (qty <= 0 || (best && best.qty >= qty)) continue;
        best = { article_id: a.id, code: a.code, name: a.name, unit: a.unit, stock: a.stock, alert_qty: a.alert_qty, from_store_id: id, from_store_name: s.name, from_stock: s.qty, qty, updated_at: s.at };
      }
      if (best) out.push(best);
    }
    return out.sort((x, y) => x.name.localeCompare(y.name, 'fr'));
  }

  request(ctx: Context, input: { fromStoreId: string; articleId: string; qty: Milli; note?: string | null }): StoreTransferRequest {
    if (input.fromStoreId === ctx.storeId) throw new AppError('Choisissez un autre magasin', 'INVALID');
    if (!this.db.prepare('SELECT 1 FROM stores WHERE id = ? AND active = 1').get(input.fromStoreId)) throw new AppError('Magasin introuvable', 'NOT_FOUND');
    const a = this.db.prepare('SELECT id, is_service FROM articles WHERE id = ? AND active = 1').get(input.articleId) as { id: string; is_service: number } | undefined;
    if (!a || a.is_service) throw new AppError('Article introuvable', 'NOT_FOUND');
    if (!Number.isSafeInteger(input.qty) || input.qty <= 0) throw new AppError('Quantité invalide', 'INVALID');
    if (this.db.prepare("SELECT 1 FROM store_transfer_requests WHERE article_id = ? AND to_store_id = ? AND from_store_id = ? AND status = 'requested'").get(input.articleId, ctx.storeId, input.fromStoreId))
      throw new AppError('Une demande de cet article à ce magasin est déjà en attente', 'DUPLICATE');
    const id = newId();
    const now = this.now();
    const number = `DM-${this.stationPrefix()}-${this.nextCounter('store_transfer_request')}`;
    this.tx(() => {
      this.db
        .prepare(
          `INSERT INTO store_transfer_requests (id, number, from_store_id, to_store_id, article_id, qty, status, note, requested_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'requested', ?, ?, ?, ?)`,
        )
        .run(id, number, input.fromStoreId, ctx.storeId, input.articleId, input.qty, input.note?.trim() || null, ctx.userId, now, now);
      this.enqueue(ctx, 'store_transfer_request', id, 'upsert', {});
      this.audit(ctx.userId, 'store_transfer.request', 'store_transfer_request', id, { from: input.fromStoreId, qty: input.qty });
    });
    return this.get(id, ctx.storeId);
  }

  /** Le magasin sollicité expédie : le stock sort de son dépôt (le plus fourni par défaut). */
  ship(ctx: Context, id: string, input: { qty?: Milli; warehouseId?: string | null } = {}): StoreTransferRequest {
    const r = this.raw(id);
    if (r.from_store_id !== ctx.storeId) throw new AppError('Seul le magasin sollicité expédie', 'FORBIDDEN');
    if (r.status !== 'requested') throw new AppError(`Demande déjà ${STORE_TRANSFER_STATUS[r.status].toLowerCase()}`, 'INVALID');
    const qty = input.qty ?? r.qty;
    if (!Number.isSafeInteger(qty) || qty <= 0) throw new AppError('Quantité invalide', 'INVALID');
    const warehouseId =
      input.warehouseId ||
      (this.db
        .prepare('SELECT w.id FROM warehouses w LEFT JOIN stock s ON s.warehouse_id = w.id AND s.article_id = ? WHERE w.store_id = ? AND w.active = 1 ORDER BY COALESCE(s.qty, 0) DESC LIMIT 1')
        .pluck()
        .get(r.article_id, ctx.storeId) as string | undefined);
    if (!warehouseId) throw new AppError('Aucun dépôt dans ce magasin', 'NOT_FOUND');
    if (this.storeStock(ctx.storeId, r.article_id, true) < qty) throw new AppError('Stock insuffisant pour expédier cette quantité', 'INSUFFICIENT_STOCK');
    const now = this.now();
    this.tx(() => {
      const out = this.stock.transferOut(ctx, { articleId: r.article_id, warehouseId, qty, refId: id, refType: 'store_transfer', reason: `Pour un autre magasin (${r.number})` });
      this.db
        .prepare(
          `UPDATE store_transfer_requests SET status = 'shipped', shipped_qty = ?, unit_cost = ?, lots = ?, from_warehouse_id = ?, shipped_by = ?, shipped_at = ?, updated_at = ?
           WHERE id = ? AND status = 'requested'`,
        )
        .run(qty, out.unitCost, JSON.stringify(out.lots), warehouseId, ctx.userId, now, now, id);
      this.enqueue(ctx, 'store_transfer_request', id, 'upsert', {});
      this.audit(ctx.userId, 'store_transfer.ship', 'store_transfer_request', id, { qty });
    });
    return this.get(id, ctx.storeId);
  }

  refuse(ctx: Context, id: string, answer: string): StoreTransferRequest {
    const r = this.raw(id);
    if (r.from_store_id !== ctx.storeId) throw new AppError('Seul le magasin sollicité peut refuser', 'FORBIDDEN');
    if (r.status !== 'requested') throw new AppError('Cette demande n’est plus en attente', 'INVALID');
    if (!answer.trim()) throw new AppError('Indiquez pourquoi (ex. « plus assez de stock »)', 'REASON_REQUIRED');
    return this.close(ctx, id, 'refused', answer.trim());
  }

  cancel(ctx: Context, id: string): StoreTransferRequest {
    const r = this.raw(id);
    if (r.to_store_id !== ctx.storeId) throw new AppError('Seul le magasin qui a demandé peut annuler', 'FORBIDDEN');
    if (r.status !== 'requested') throw new AppError('La marchandise est déjà expédiée : réceptionnez-la', 'INVALID');
    return this.close(ctx, id, 'cancelled', null);
  }

  private close(ctx: Context, id: string, status: 'refused' | 'cancelled', answer: string | null): StoreTransferRequest {
    this.tx(() => {
      this.db.prepare("UPDATE store_transfer_requests SET status = ?, answer = ?, updated_at = ? WHERE id = ? AND status = 'requested'").run(status, answer, this.now(), id);
      this.enqueue(ctx, 'store_transfer_request', id, 'upsert', {});
      this.audit(ctx.userId, `store_transfer.${status === 'refused' ? 'refuse' : 'cancel'}`, 'store_transfer_request', id, { answer });
    });
    return this.get(id, ctx.storeId);
  }

  /** Le magasin demandeur réceptionne la quantité arrivée, au coût de l'expédition et avec ses lots. */
  receive(ctx: Context, id: string, input: { qty?: Milli; warehouseId?: string | null } = {}): StoreTransferRequest {
    const r = this.raw(id);
    if (r.to_store_id !== ctx.storeId) throw new AppError('Seul le magasin qui a demandé réceptionne', 'FORBIDDEN');
    if (r.status !== 'shipped') throw new AppError(r.status === 'requested' ? 'Pas encore expédiée par l’autre magasin' : 'Cette demande est clôturée', 'INVALID');
    const qty = input.qty ?? r.shipped_qty ?? r.qty;
    if (!Number.isSafeInteger(qty) || qty < 0) throw new AppError('Quantité invalide', 'INVALID');
    const warehouseId =
      input.warehouseId ||
      (this.db
        .prepare("SELECT id FROM warehouses WHERE store_id = ? AND active = 1 ORDER BY kind = 'reserve' DESC, is_sales_default DESC, name LIMIT 1")
        .pluck()
        .get(ctx.storeId) as string | undefined);
    if (!warehouseId) throw new AppError('Aucun dépôt dans ce magasin', 'NOT_FOUND');
    const now = this.now();
    this.tx(() => {
      if (qty > 0)
        this.stock.transferIn(ctx, {
          articleId: r.article_id,
          warehouseId,
          qty,
          unitCost: r.unit_cost ?? 0,
          lots: r.lots ? (JSON.parse(r.lots) as TransferLot[]) : [],
          refId: id,
          refType: 'store_transfer',
          reason: `Venu d'un autre magasin (${r.number})`,
        });
      this.db
        .prepare("UPDATE store_transfer_requests SET status = 'received', received_qty = ?, to_warehouse_id = ?, received_by = ?, received_at = ?, updated_at = ? WHERE id = ? AND status = 'shipped'")
        .run(qty, warehouseId, ctx.userId, now, now, id);
      this.enqueue(ctx, 'store_transfer_request', id, 'upsert', {});
      this.audit(ctx.userId, 'store_transfer.receive', 'store_transfer_request', id, { qty, shipped: r.shipped_qty });
    });
    return this.get(id, ctx.storeId);
  }

  private raw(id: string) {
    const r = this.db.prepare('SELECT * FROM store_transfer_requests WHERE id = ?').get(id) as
      | { number: string; from_store_id: string; to_store_id: string; article_id: string; qty: Milli; status: StoreTransferStatus; shipped_qty: Milli | null; unit_cost: Fcfa | null; lots: string | null }
      | undefined;
    if (!r) throw new AppError('Demande introuvable', 'NOT_FOUND');
    return r;
  }

  get(id: string, storeId: string): StoreTransferRequest {
    const row = this.db.prepare(`${SELECT} WHERE r.id = @id`).get({ id, storeId }) as StoreTransferRequest | undefined;
    if (!row) throw new AppError('Demande introuvable', 'NOT_FOUND');
    return row;
  }

  /** Demandes du magasin (faites et reçues) : en cours d'abord, puis les 60 derniers jours. */
  list(storeId: string, opts: { open?: boolean } = {}): StoreTransferRequest[] {
    const since = new Date(this.clock().getTime() - 60 * 86_400_000).toISOString();
    return this.db
      .prepare(
        `${SELECT} WHERE (r.from_store_id = @storeId OR r.to_store_id = @storeId)
           AND (r.status IN ('requested', 'shipped') OR (@open = 0 AND r.updated_at >= @since))
         ORDER BY r.status NOT IN ('requested', 'shipped'), r.created_at DESC LIMIT 500`,
      )
      .all({ storeId, open: opts.open ? 1 : 0, since }) as StoreTransferRequest[];
  }

  /** Demandes à traiter par ce magasin : à expédier (on nous demande) et à réceptionner. */
  pending(storeId: string): { toShip: number; toReceive: number } {
    const row = this.db
      .prepare(
        `SELECT COUNT(CASE WHEN from_store_id = @storeId AND status = 'requested' THEN 1 END) AS toShip,
                COUNT(CASE WHEN to_store_id = @storeId AND status = 'shipped' THEN 1 END) AS toReceive
         FROM store_transfer_requests WHERE status IN ('requested', 'shipped')`,
      )
      .get({ storeId }) as { toShip: number; toReceive: number };
    return row;
  }
}

const SELECT = `SELECT r.id, r.number, r.from_store_id, fs.name AS from_store_name, r.to_store_id, ts.name AS to_store_name, r.article_id, a.code AS article_code,
                       a.name AS article_name, a.unit, r.qty, r.status, r.note, u.name AS requested_by_name, r.shipped_qty, r.unit_cost, r.shipped_at,
                       r.received_qty, r.received_at, r.answer, r.created_at, CASE WHEN r.to_store_id = @storeId THEN 'in' ELSE 'out' END AS direction
                FROM store_transfer_requests r JOIN articles a ON a.id = r.article_id LEFT JOIN stores fs ON fs.id = r.from_store_id
                LEFT JOIN stores ts ON ts.id = r.to_store_id LEFT JOIN users u ON u.id = r.requested_by`;
