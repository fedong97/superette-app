import { MOVEMENT_TYPES, type MovementType, type Milli } from '@superette/core';
import type { Db } from './database';
import type { StockService } from './stock';
import { AppError, Base, type Clock, type Context, newId } from './util';

export interface StockChange {
  id: string;
  at: string;
  warehouse_name: string;
  type: MovementType;
  type_label: string;
  reason: string | null;
  ref_type: string | null;
  before: Milli;
  delta: Milli;
  after: Milli;
  user_name: string | null;
}

export type StockRequestStatus = 'pending' | 'approved' | 'rejected';

export interface StockRequest {
  id: string;
  number: number;
  warehouse_id: string;
  warehouse_name: string;
  article_id: string;
  article_name: string;
  unit: 'piece' | 'kg' | 'litre';
  before_qty: Milli;
  requested_qty: Milli;
  delta: Milli;
  reason: string;
  status: StockRequestStatus;
  requested_at: string;
  requested_by_name: string;
  decided_at: string | null;
  decided_by_name: string | null;
  decision_note: string | null;
}

/**
 * Monitoring de l'évolution du stock d'un produit (KONTROL) : chaque
 * modification effective avec le stock avant et après, et les demandes de
 * correction du magasinier, que le gérant valide avant que le stock bouge.
 */
export class MonitoringService extends Base {
  constructor(
    db: Db,
    clock: Clock,
    private readonly stock: StockService,
  ) {
    super(db, clock);
  }

  /** Mouvements d'un produit sur la période (dates ISO), stock avant et après chaque mouvement. */
  changes(storeId: string, opts: { articleId: string; warehouseId?: string | null; from: string; to: string }): { opening: Milli; closing: Milli; rows: StockChange[] } {
    const scope = { storeId, articleId: opts.articleId, wh: opts.warehouseId ?? null, from: opts.from, to: opts.to };
    const where = `m.article_id = @articleId AND w.store_id = @storeId AND (@wh IS NULL OR m.warehouse_id = @wh)`;
    const opening = this.db
      .prepare(`SELECT COALESCE(SUM(m.qty), 0) FROM stock_movements m JOIN warehouses w ON w.id = m.warehouse_id WHERE ${where} AND m.at < @from`)
      .pluck()
      .get(scope) as number;
    const raw = this.db
      .prepare(
        `SELECT m.id, m.at, w.name AS warehouse_name, m.type, m.reason, m.ref_type, m.qty AS delta, u.name AS user_name
         FROM stock_movements m JOIN warehouses w ON w.id = m.warehouse_id LEFT JOIN users u ON u.id = m.user_id
         WHERE ${where} AND m.at >= @from AND m.at <= @to ORDER BY m.at, m.rowid`,
      )
      .all(scope) as Omit<StockChange, 'before' | 'after' | 'type_label'>[];
    let running = opening;
    const rows = raw.map((r) => {
      const before = running;
      running += r.delta;
      return { ...r, type_label: MOVEMENT_TYPES[r.type] ?? r.type, before, after: running };
    });
    return { opening, closing: running, rows };
  }

  requests(storeId: string, opts: { articleId?: string | null; status?: StockRequestStatus | null; from?: string | null; to?: string | null; id?: string } = {}): StockRequest[] {
    return this.db
      .prepare(
        `SELECT r.id, r.number, r.warehouse_id, w.name AS warehouse_name, r.article_id, a.name AS article_name, a.unit, r.before_qty, r.requested_qty,
                r.requested_qty - r.before_qty AS delta, r.reason, r.status, r.requested_at, ur.name AS requested_by_name, r.decided_at, ud.name AS decided_by_name, r.decision_note
         FROM stock_requests r JOIN warehouses w ON w.id = r.warehouse_id JOIN articles a ON a.id = r.article_id
         JOIN users ur ON ur.id = r.requested_by LEFT JOIN users ud ON ud.id = r.decided_by
         WHERE r.store_id = @storeId AND (@articleId IS NULL OR r.article_id = @articleId) AND (@status IS NULL OR r.status = @status)
           AND (@from IS NULL OR r.requested_at >= @from) AND (@to IS NULL OR r.requested_at <= @to) AND (@id IS NULL OR r.id = @id)
         ORDER BY r.requested_at DESC`,
      )
      .all({ storeId, articleId: opts.articleId ?? null, status: opts.status ?? null, from: opts.from ?? null, to: opts.to ?? null, id: opts.id ?? null }) as StockRequest[];
  }

  private getRequest(id: string): StockRequest {
    const storeId = this.db.prepare('SELECT store_id FROM stock_requests WHERE id = ?').pluck().get(id) as string | undefined;
    const r = storeId ? this.requests(storeId, { id })[0] : undefined;
    if (!r) throw new AppError('Demande introuvable', 'NOT_FOUND');
    return r;
  }

  /**
   * Demande de correction : « le stock réel est de … ». Le gérant (approveNow)
   * corrige directement ; sinon la demande attend sa validation.
   */
  request(ctx: Context, input: { articleId: string; warehouseId: string; newQty: Milli; reason: string }, approveNow = false): StockRequest {
    if (!input.reason.trim()) throw new AppError('Le motif est obligatoire', 'INVALID');
    if (!Number.isSafeInteger(input.newQty) || input.newQty < 0) throw new AppError('Quantité invalide', 'INVALID');
    const before = (this.db.prepare('SELECT qty FROM stock WHERE article_id = ? AND warehouse_id = ?').pluck().get(input.articleId, input.warehouseId) as number | undefined) ?? 0;
    if (before === input.newQty) throw new AppError('Le stock est déjà à cette quantité', 'INVALID');
    return this.tx(() => {
      const last = this.db.prepare('SELECT MAX(number) FROM stock_requests WHERE store_id = ?').pluck().get(ctx.storeId) as number | null;
      if (last) this.raiseCounter(`stock_request:${ctx.storeId}`, last);
      const id = newId();
      this.db
        .prepare(
          `INSERT INTO stock_requests (id, number, store_id, warehouse_id, article_id, before_qty, requested_qty, reason, requested_at, requested_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, this.nextCounter(`stock_request:${ctx.storeId}`), ctx.storeId, input.warehouseId, input.articleId, before, input.newQty, input.reason.trim(), this.now(), ctx.userId);
      this.audit(ctx.userId, 'stock.request', 'article', input.articleId, { before, requested: input.newQty });
      return approveNow ? this.decide(ctx, id, true, null) : this.getRequest(id);
    });
  }

  /** Validation (la différence constatée est appliquée au stock) ou refus. */
  decide(ctx: Context, id: string, approve: boolean, note: string | null): StockRequest {
    const r = this.getRequest(id);
    if (r.status !== 'pending') throw new AppError('Cette demande est déjà traitée', 'INVALID');
    if (!approve && !note?.trim()) throw new AppError('Indiquez pourquoi la demande est refusée', 'INVALID');
    return this.tx(() => {
      if (approve && r.delta !== 0)
        this.stock.adjustForInventory(ctx, {
          articleId: r.article_id,
          warehouseId: r.warehouse_id,
          difference: r.delta,
          inventoryId: id,
          reason: `Correction n° ${r.number} : ${r.reason}`,
          refType: 'stock_request',
        });
      this.db
        .prepare('UPDATE stock_requests SET status = ?, decided_at = ?, decided_by = ?, decision_note = ?, applied_delta = ? WHERE id = ?')
        .run(approve ? 'approved' : 'rejected', this.now(), ctx.userId, note?.trim() || null, approve ? r.delta : null, id);
      this.audit(ctx.userId, approve ? 'stock.request.approve' : 'stock.request.reject', 'article', r.article_id, { id });
      return this.getRequest(id);
    });
  }
}
