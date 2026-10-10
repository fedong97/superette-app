import type { Fcfa, Milli } from '@superette/core';
import type { Db } from './database';
import type { StockService, TransferLot } from './stock';
import { AppError, Base, type Clock, type Context, newId } from './util';

export type TransferStatus = 'draft' | 'shipped' | 'received' | 'cancelled';
export const TRANSFER_STATUS: Record<TransferStatus, string> = { draft: 'Brouillon', shipped: 'Expédié', received: 'Réceptionné', cancelled: 'Annulé' };

export interface Transfer {
  id: string;
  number: number;
  store_id: string;
  from_warehouse_id: string;
  to_warehouse_id: string;
  from_name: string;
  to_name: string;
  status: TransferStatus;
  label: string | null;
  route_number: string | null;
  reception_number: string | null;
  created_at: string;
  created_by_name: string;
  shipped_at: string | null;
  shipped_by_name: string | null;
  printed_at: string | null;
  received_at: string | null;
  received_by_name: string | null;
  line_count: number;
  /** Valeur au CMUP : à l'expédition une fois expédié, sinon au coût du jour. */
  value: Fcfa;
  /** Valeur des quantités manquantes à la réception (négatif) ou en trop (positif). */
  gap_value: Fcfa;
}

export interface TransferLine {
  article_id: string;
  code: string;
  name: string;
  unit: 'piece' | 'kg' | 'litre';
  unit_name: string | null;
  packs: { position: number; name: string; units: Milli }[];
  qty: Milli;
  pack_position: number;
  received_qty: Milli | null;
  unit_cost: Fcfa;
  value: Fcfa;
  /** Stock du dépôt de départ (et d'arrivée) aujourd'hui. */
  from_stock: Milli;
  to_stock: Milli;
}

export interface TransferInput {
  fromWarehouseId: string;
  toWarehouseId: string;
  label?: string | null;
  routeNumber?: string | null;
  lines: { articleId: string; qty: Milli; packPosition?: number }[];
}

/**
 * Bons de transfert entre dépôts. Brouillon modifiable, puis expédié : le
 * stock quitte le dépôt de départ (bon de route). À la réception, on saisit
 * les quantités arrivées : elles entrent dans le dépôt d'arrivée avec leurs
 * lots et dates ; l'écart éventuel reste visible sur le bon.
 */
export class TransferService extends Base {
  constructor(
    db: Db,
    clock: Clock,
    private readonly stock: StockService,
  ) {
    super(db, clock);
  }

  list(storeId: string, opts: { status?: TransferStatus | null; id?: string } = {}): Transfer[] {
    return this.db
      .prepare(
        `SELECT t.*, wf.name AS from_name, wt.name AS to_name, uc.name AS created_by_name, us.name AS shipped_by_name, ur.name AS received_by_name,
                (SELECT COUNT(*) FROM transfer_lines l WHERE l.transfer_id = t.id) AS line_count,
                (SELECT COALESCE(SUM(ROUND(l.qty * COALESCE(l.unit_cost, (SELECT s.avg_cost FROM stock s WHERE s.article_id = l.article_id AND s.warehouse_id = t.from_warehouse_id), 0) / 1000.0)), 0)
                   FROM transfer_lines l WHERE l.transfer_id = t.id) AS value,
                (SELECT COALESCE(SUM(ROUND((l.received_qty - l.qty) * l.unit_cost / 1000.0)), 0) FROM transfer_lines l WHERE l.transfer_id = t.id AND l.received_qty IS NOT NULL) AS gap_value
         FROM transfers t
         JOIN warehouses wf ON wf.id = t.from_warehouse_id JOIN warehouses wt ON wt.id = t.to_warehouse_id
         JOIN users uc ON uc.id = t.created_by LEFT JOIN users us ON us.id = t.shipped_by LEFT JOIN users ur ON ur.id = t.received_by
         WHERE t.store_id = @storeId AND (@status IS NULL OR t.status = @status) AND (@id IS NULL OR t.id = @id)
         ORDER BY t.number DESC`,
      )
      .all({ storeId, status: opts.status ?? null, id: opts.id ?? null }) as Transfer[];
  }

  private header(id: string): Transfer {
    const storeId = this.db.prepare('SELECT store_id FROM transfers WHERE id = ?').pluck().get(id) as string | undefined;
    const t = storeId ? this.list(storeId, { id })[0] : undefined;
    if (!t) throw new AppError('Bon de transfert introuvable', 'NOT_FOUND');
    return t;
  }

  get(id: string): { transfer: Transfer; lines: TransferLine[] } {
    const transfer = this.header(id);
    const rows = this.db
      .prepare(
        `SELECT l.article_id, a.code, a.name, a.unit, a.unit_name, l.qty, l.pack_position, l.received_qty, l.unit_cost,
                COALESCE((SELECT qty FROM stock WHERE article_id = l.article_id AND warehouse_id = @from), 0) AS from_stock,
                COALESCE((SELECT avg_cost FROM stock WHERE article_id = l.article_id AND warehouse_id = @from), a.purchase_price, 0) AS cost_now,
                COALESCE((SELECT qty FROM stock WHERE article_id = l.article_id AND warehouse_id = @to), 0) AS to_stock
         FROM transfer_lines l JOIN articles a ON a.id = l.article_id
         WHERE l.transfer_id = @id ORDER BY l.position`,
      )
      .all({ id, from: transfer.from_warehouse_id, to: transfer.to_warehouse_id }) as (Omit<TransferLine, 'packs' | 'value'> & { unit_cost: number | null; cost_now: number })[];
    const packs = this.db.prepare('SELECT position, name, units FROM article_packs WHERE article_id = ? ORDER BY position');
    return {
      transfer,
      lines: rows.map(({ cost_now, ...r }) => {
        const unit_cost = r.unit_cost ?? cost_now;
        return { ...r, unit_cost, value: Math.round((r.qty * unit_cost) / 1000), packs: packs.all(r.article_id) as TransferLine['packs'] };
      }),
    };
  }

  private requireStatus(id: string, ...allowed: TransferStatus[]): Transfer {
    const t = this.header(id);
    if (!allowed.includes(t.status)) throw new AppError(`Le transfert n° ${t.number} est ${TRANSFER_STATUS[t.status].toLowerCase()}`, 'INVALID');
    return t;
  }

  private check(input: TransferInput): void {
    if (input.fromWarehouseId === input.toWarehouseId) throw new AppError('Dépôts de départ et d’arrivée identiques', 'INVALID');
    if (!input.lines.length) throw new AppError('Ajoutez au moins un produit', 'INVALID');
    const seen = new Set<string>();
    for (const l of input.lines) {
      if (!Number.isSafeInteger(l.qty) || l.qty <= 0) throw new AppError('Quantité invalide', 'INVALID');
      if (seen.has(l.articleId)) throw new AppError('Un produit apparaît deux fois dans le transfert', 'INVALID');
      seen.add(l.articleId);
    }
  }

  private writeLines(id: string, lines: TransferInput['lines']): void {
    this.db.prepare('DELETE FROM transfer_lines WHERE transfer_id = ?').run(id);
    const ins = this.db.prepare('INSERT INTO transfer_lines (id, transfer_id, position, article_id, qty, pack_position) VALUES (?, ?, ?, ?, ?, ?)');
    lines.forEach((l, i) => ins.run(newId(), id, i + 1, l.articleId, l.qty, l.packPosition ?? 0));
  }

  create(ctx: Context, input: TransferInput): Transfer {
    this.check(input);
    return this.tx(() => {
      const last = this.db.prepare('SELECT MAX(number) FROM transfers WHERE store_id = ?').pluck().get(ctx.storeId) as number | null;
      if (last) this.raiseCounter(`transfer:${ctx.storeId}`, last);
      const id = newId();
      this.db
        .prepare(
          `INSERT INTO transfers (id, number, store_id, from_warehouse_id, to_warehouse_id, label, route_number, created_at, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, this.nextCounter(`transfer:${ctx.storeId}`), ctx.storeId, input.fromWarehouseId, input.toWarehouseId, input.label?.trim() || null, input.routeNumber?.trim() || null, this.now(), ctx.userId);
      this.writeLines(id, input.lines);
      this.audit(ctx.userId, 'transfer.create', 'transfer', id, { lines: input.lines.length });
      return this.header(id);
    });
  }

  update(ctx: Context, id: string, input: TransferInput): Transfer {
    this.requireStatus(id, 'draft');
    this.check(input);
    return this.tx(() => {
      this.db
        .prepare('UPDATE transfers SET from_warehouse_id = ?, to_warehouse_id = ?, label = ?, route_number = ? WHERE id = ?')
        .run(input.fromWarehouseId, input.toWarehouseId, input.label?.trim() || null, input.routeNumber?.trim() || null, id);
      this.writeLines(id, input.lines);
      this.audit(ctx.userId, 'transfer.update', 'transfer', id, { lines: input.lines.length });
      return this.header(id);
    });
  }

  /** Expédition : le stock quitte le dépôt de départ, au CMUP du jour. */
  ship(ctx: Context, id: string, routeNumber?: string | null): Transfer {
    const t = this.requireStatus(id, 'draft');
    return this.tx(() => {
      const reason = `Transfert n° ${t.number} vers ${t.to_name}`;
      const lines = this.db.prepare('SELECT id, article_id, qty FROM transfer_lines WHERE transfer_id = ?').all(id) as { id: string; article_id: string; qty: Milli }[];
      const save = this.db.prepare('UPDATE transfer_lines SET unit_cost = ?, lots = ? WHERE id = ?');
      for (const l of lines) {
        const out = this.stock.transferOut(ctx, { articleId: l.article_id, warehouseId: t.from_warehouse_id, qty: l.qty, refId: id, reason });
        save.run(out.unitCost, JSON.stringify(out.lots), l.id);
      }
      this.db
        .prepare("UPDATE transfers SET status = 'shipped', shipped_at = ?, shipped_by = ?, route_number = COALESCE(?, route_number) WHERE id = ?")
        .run(this.now(), ctx.userId, routeNumber?.trim() || null, id);
      this.audit(ctx.userId, 'transfer.ship', 'transfer', id);
      return this.header(id);
    });
  }

  /** Réception : quantités arrivées (par défaut celles expédiées), entrées dans le dépôt d'arrivée. */
  receive(ctx: Context, id: string, input: { receptionNumber?: string | null; lines?: { articleId: string; receivedQty: Milli }[] } = {}): Transfer {
    const t = this.requireStatus(id, 'shipped');
    const given = new Map((input.lines ?? []).map((l) => [l.articleId, l.receivedQty]));
    for (const q of given.values()) if (!Number.isSafeInteger(q) || q < 0) throw new AppError('Quantité reçue invalide', 'INVALID');
    return this.tx(() => {
      const reason = `Transfert n° ${t.number} depuis ${t.from_name}`;
      const lines = this.db.prepare('SELECT id, article_id, qty, unit_cost, lots FROM transfer_lines WHERE transfer_id = ?').all(id) as {
        id: string;
        article_id: string;
        qty: Milli;
        unit_cost: Fcfa;
        lots: string | null;
      }[];
      const save = this.db.prepare('UPDATE transfer_lines SET received_qty = ? WHERE id = ?');
      for (const l of lines) {
        const received = given.get(l.article_id) ?? l.qty;
        if (received > 0)
          this.stock.transferIn(ctx, { articleId: l.article_id, warehouseId: t.to_warehouse_id, qty: received, unitCost: l.unit_cost, lots: JSON.parse(l.lots ?? '[]') as TransferLot[], refId: id, reason });
        save.run(received, l.id);
      }
      this.db
        .prepare("UPDATE transfers SET status = 'received', received_at = ?, received_by = ?, reception_number = ? WHERE id = ?")
        .run(this.now(), ctx.userId, input.receptionNumber?.trim() || null, id);
      this.audit(ctx.userId, 'transfer.receive', 'transfer', id);
      return this.header(id);
    });
  }

  /** Brouillon : abandonné. Expédié : la marchandise revient dans le dépôt de départ. */
  cancel(ctx: Context, id: string): Transfer {
    const t = this.requireStatus(id, 'draft', 'shipped');
    return this.tx(() => {
      if (t.status === 'shipped') {
        const lines = this.db.prepare('SELECT article_id, qty, unit_cost, lots FROM transfer_lines WHERE transfer_id = ?').all(id) as {
          article_id: string;
          qty: Milli;
          unit_cost: Fcfa;
          lots: string | null;
        }[];
        for (const l of lines)
          this.stock.transferIn(ctx, {
            articleId: l.article_id,
            warehouseId: t.from_warehouse_id,
            qty: l.qty,
            unitCost: l.unit_cost,
            lots: JSON.parse(l.lots ?? '[]') as TransferLot[],
            refId: id,
            reason: `Annulation du transfert n° ${t.number}`,
          });
      }
      this.db.prepare("UPDATE transfers SET status = 'cancelled', cancelled_at = ?, cancelled_by = ? WHERE id = ?").run(this.now(), ctx.userId, id);
      this.audit(ctx.userId, 'transfer.cancel', 'transfer', id);
      return this.header(id);
    });
  }

  markPrinted(id: string): void {
    this.db.prepare('UPDATE transfers SET printed_at = ? WHERE id = ?').run(this.now(), id);
  }

  /** Mouvements de stock du transfert (sorties, entrées, retours). */
  movements(id: string) {
    return this.db
      .prepare(
        `SELECT m.type, m.qty, m.unit_cost, m.reason, m.at, a.code, a.name AS article_name, a.unit, w.name AS warehouse_name, u.name AS user_name
         FROM stock_movements m JOIN articles a ON a.id = m.article_id JOIN warehouses w ON w.id = m.warehouse_id LEFT JOIN users u ON u.id = m.user_id
         WHERE m.ref_type = 'transfer' AND m.ref_id = ? ORDER BY m.at, a.name`,
      )
      .all(id) as { type: string; qty: Milli; unit_cost: Fcfa; reason: string | null; at: string; code: string; article_name: string; unit: 'piece' | 'kg' | 'litre'; warehouse_name: string; user_name: string | null }[];
  }
}
