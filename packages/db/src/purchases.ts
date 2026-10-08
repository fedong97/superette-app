import { type Fcfa, type Milli, dueDate, lineAmount, suggestReorder, ttcFromHt } from '@superette/core';
import type { Db } from './database';
import type { ReceptionLine, StockService } from './stock';
import { AppError, Base, type Clock, type Context, newId } from './util';

export interface Supplier {
  id: string;
  code: string;
  name: string;
  contact: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  taxpayer_number: string | null;
  payment_terms_days: number;
  lead_time_days: number;
  franco: Fcfa | null;
  notes: string | null;
  active: number;
}

export interface SupplierInput {
  name: string;
  contact?: string | null;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  taxpayerNumber?: string | null;
  paymentTermsDays?: number;
  leadTimeDays?: number;
  franco?: Fcfa | null;
  notes?: string | null;
  active?: boolean;
}

export interface SupplierArticle {
  id: string;
  supplier_id: string;
  supplier_name: string;
  article_id: string;
  article_code: string;
  article_name: string;
  unit: 'piece' | 'kg' | 'litre';
  supplier_ref: string | null;
  unit_cost: Fcfa;
  pack_qty: Milli;
  is_main: number;
  /** Dernier coût réellement payé à ce fournisseur (réceptions). */
  last_cost: Fcfa | null;
}

/** État affiché d'un bon de commande ; « partiel » et « reçu » se déduisent des réceptions. */
export type OrderState = 'draft' | 'sent' | 'partial' | 'received' | 'closed' | 'cancelled';

export const ORDER_STATES: Record<OrderState, string> = {
  draft: 'Brouillon',
  sent: 'Envoyée',
  partial: 'Reçue en partie',
  received: 'Reçue',
  closed: 'Soldée',
  cancelled: 'Annulée',
};

export interface PurchaseOrderLineInput {
  articleId: string;
  qty: Milli;
  unitCost: Fcfa;
}

export interface PurchaseOrder {
  id: string;
  number: string;
  store_id: string;
  warehouse_id: string;
  warehouse_name: string;
  supplier_id: string;
  supplier_name: string;
  status: 'draft' | 'sent' | 'closed' | 'cancelled';
  state: OrderState;
  order_date: string;
  expected_date: string | null;
  notes: string | null;
  user_name: string | null;
  total_ht: Fcfa;
  lines: {
    id: string;
    line_no: number;
    article_id: string;
    article_code: string;
    article_name: string;
    unit: 'piece' | 'kg' | 'litre';
    perishable: number;
    supplier_ref: string | null;
    qty: Milli;
    unit_cost: Fcfa;
    received: Milli;
    total_ht: Fcfa;
  }[];
}

export interface Reception {
  id: string;
  number: string;
  store_id: string;
  warehouse_id: string;
  warehouse_name: string;
  supplier_id: string | null;
  supplier_name: string | null;
  order_id: string | null;
  order_number: string | null;
  delivery_note: string | null;
  invoice_id: string | null;
  invoice_number: string | null;
  user_name: string | null;
  received_at: string;
  total_ht: Fcfa;
  total_tva: Fcfa;
  total_ttc: Fcfa;
}

export interface ReceptionDetail extends Reception {
  lines: {
    id: string;
    article_id: string;
    article_code: string;
    article_name: string;
    unit: 'piece' | 'kg' | 'litre';
    qty: Milli;
    unit_cost: Fcfa;
    vat_rate_bp: number;
    lot_number: string | null;
    expiry: string | null;
    total_ht: Fcfa;
  }[];
}

export type InvoiceState = 'unpaid' | 'partial' | 'paid';

export interface SupplierInvoice {
  id: string;
  number: string;
  kind: 'invoice' | 'credit_note';
  supplier_id: string;
  supplier_name: string;
  store_id: string;
  supplier_number: string;
  invoice_date: string;
  due_date: string;
  total_ht: Fcfa;
  total_tva: Fcfa;
  total_ttc: Fcfa;
  /** Valeur HT des réceptions rattachées, pour le rapprochement. */
  received_ht: Fcfa;
  notes: string | null;
  paid: Fcfa;
  balance: Fcfa;
  state: InvoiceState;
  overdue: boolean;
}

export const SUPPLIER_PAYMENT_METHODS = {
  CASH: 'Espèces',
  BANK_TRANSFER: 'Virement',
  CHEQUE: 'Chèque',
  MTN_MOMO: 'MTN Mobile Money',
  ORANGE_MONEY: 'Orange Money',
} as const;
export type SupplierPaymentMethod = keyof typeof SUPPLIER_PAYMENT_METHODS;

export interface ReorderRow {
  article_id: string;
  article_code: string;
  article_name: string;
  unit: 'piece' | 'kg' | 'litre';
  supplier_id: string | null;
  supplier_name: string | null;
  supplier_ref: string | null;
  unit_cost: Fcfa;
  pack_qty: Milli;
  stock: Milli;
  on_order: Milli;
  avg_daily_sales: Milli;
  reorder_point: Milli;
  target: Milli;
  qty: Milli;
}

/**
 * Fournisseurs et achats, sur la chaîne documentaire de Sage : fiche
 * fournisseur et articles référencés, bon de commande, bon de réception,
 * facture ou avoir, règlements, et proposition de commande automatique.
 */
export class PurchaseService extends Base {
  constructor(
    db: Db,
    clock: Clock,
    private readonly stock: StockService,
  ) {
    super(db, clock);
  }

  private number(prefix: string, counter: string): string {
    return `${prefix}-${this.stationPrefix()}-${String(this.nextCounter(counter)).padStart(5, '0')}`;
  }

  // --- Fournisseurs -----------------------------------------------------------

  listSuppliers(opts: { search?: string; includeInactive?: boolean } = {}): (Supplier & { balance: Fcfa; article_count: number })[] {
    return this.db
      .prepare(
        `SELECT s.*,
                (SELECT COUNT(*) FROM supplier_articles sa WHERE sa.supplier_id = s.id) AS article_count,
                COALESCE((SELECT SUM(CASE WHEN i.kind = 'invoice' THEN i.total_ttc ELSE -i.total_ttc END) FROM supplier_invoices i WHERE i.supplier_id = s.id), 0)
                - COALESCE((SELECT SUM(p.amount) FROM supplier_payments p WHERE p.supplier_id = s.id), 0) AS balance
         FROM suppliers s
         WHERE (@all = 1 OR s.active = 1) AND (@search IS NULL OR s.name LIKE @search OR s.code LIKE @search OR s.phone LIKE @search)
         ORDER BY s.name`,
      )
      .all({ all: opts.includeInactive ? 1 : 0, search: opts.search ? `%${opts.search}%` : null }) as never;
  }

  getSupplier(id: string): Supplier {
    const row = this.db.prepare('SELECT * FROM suppliers WHERE id = ?').get(id) as Supplier | undefined;
    if (!row) throw new AppError('Fournisseur introuvable', 'NOT_FOUND');
    return row;
  }

  saveSupplier(userId: string, input: SupplierInput, id?: string): Supplier {
    const name = input.name.trim();
    if (!name) throw new AppError('Le nom du fournisseur est obligatoire', 'INVALID');
    const terms = input.paymentTermsDays ?? 0;
    const lead = input.leadTimeDays ?? 2;
    if (!Number.isInteger(terms) || terms < 0 || !Number.isInteger(lead) || lead < 0) throw new AppError('Délai invalide', 'INVALID');
    const now = this.now();
    const values = {
      name,
      contact: input.contact?.trim() || null,
      phone: input.phone?.trim() || null,
      email: input.email?.trim() || null,
      address: input.address?.trim() || null,
      taxpayer_number: input.taxpayerNumber?.trim() || null,
      payment_terms_days: terms,
      lead_time_days: lead,
      franco: input.franco ?? null,
      notes: input.notes?.trim() || null,
      active: input.active === false ? 0 : 1,
      updated_at: now,
    };
    return this.tx(() => {
      let supplierId = id;
      if (supplierId) {
        this.getSupplier(supplierId);
        this.db
          .prepare(
            `UPDATE suppliers SET name = @name, contact = @contact, phone = @phone, email = @email, address = @address,
               taxpayer_number = @taxpayer_number, payment_terms_days = @payment_terms_days, lead_time_days = @lead_time_days,
               franco = @franco, notes = @notes, active = @active, updated_at = @updated_at WHERE id = @id`,
          )
          .run({ ...values, id: supplierId });
      } else {
        supplierId = newId();
        this.db
          .prepare(
            `INSERT INTO suppliers (id, code, name, contact, phone, email, address, taxpayer_number, payment_terms_days, lead_time_days,
               franco, notes, active, created_at, updated_at)
             VALUES (@id, @code, @name, @contact, @phone, @email, @address, @taxpayer_number, @payment_terms_days, @lead_time_days,
               @franco, @notes, @active, @created_at, @updated_at)`,
          )
          .run({ ...values, id: supplierId, code: this.number('FRN', 'supplier.code'), created_at: now });
      }
      this.enqueue(null, 'supplier', supplierId, 'upsert', {});
      this.audit(userId, id ? 'supplier.update' : 'supplier.create', 'supplier', supplierId, { name });
      return this.getSupplier(supplierId);
    });
  }

  private supplierArticleQuery(where: string) {
    return this.db.prepare(
      `SELECT sa.id, sa.supplier_id, s.name AS supplier_name, sa.article_id, a.code AS article_code, a.name AS article_name, a.unit,
              sa.supplier_ref, sa.unit_cost, sa.pack_qty, sa.is_main,
              (SELECT rl.unit_cost FROM reception_lines rl JOIN receptions r ON r.id = rl.reception_id
                WHERE rl.article_id = sa.article_id AND r.supplier_id = sa.supplier_id ORDER BY r.received_at DESC LIMIT 1) AS last_cost
       FROM supplier_articles sa JOIN suppliers s ON s.id = sa.supplier_id JOIN articles a ON a.id = sa.article_id
       WHERE ${where} ORDER BY sa.is_main DESC, a.name, s.name`,
    );
  }

  supplierArticles(supplierId: string): SupplierArticle[] {
    return this.supplierArticleQuery('sa.supplier_id = ?').all(supplierId) as SupplierArticle[];
  }

  articleSuppliers(articleId: string): SupplierArticle[] {
    return this.supplierArticleQuery('sa.article_id = ?').all(articleId) as SupplierArticle[];
  }

  /** Référence un article chez un fournisseur (ou met à jour sa référence, son prix, son colisage). */
  setSupplierArticle(
    userId: string,
    input: { supplierId: string; articleId: string; supplierRef?: string | null; unitCost: Fcfa; packQty?: Milli; isMain?: boolean },
  ): SupplierArticle {
    if (!Number.isSafeInteger(input.unitCost) || input.unitCost < 0) throw new AppError("Prix d'achat invalide", 'INVALID');
    const pack = input.packQty ?? 1000;
    if (!Number.isSafeInteger(pack) || pack <= 0) throw new AppError('Colisage invalide', 'INVALID');
    this.getSupplier(input.supplierId);
    return this.tx(() => {
      const now = this.now();
      const existing = this.db
        .prepare('SELECT id FROM supplier_articles WHERE supplier_id = ? AND article_id = ?')
        .pluck()
        .get(input.supplierId, input.articleId) as string | undefined;
      const hasMain = this.db.prepare('SELECT 1 FROM supplier_articles WHERE article_id = ? AND is_main = 1 AND id IS NOT ?').get(input.articleId, existing ?? null);
      // Le premier fournisseur d'un article devient son fournisseur principal.
      const isMain = input.isMain ?? !hasMain;
      if (isMain) {
        for (const other of this.db
          .prepare('SELECT id FROM supplier_articles WHERE article_id = ? AND is_main = 1 AND id IS NOT ?')
          .pluck()
          .all(input.articleId, existing ?? null) as string[]) {
          this.db.prepare('UPDATE supplier_articles SET is_main = 0, updated_at = ? WHERE id = ?').run(now, other);
          this.enqueue(null, 'supplier_article', other, 'upsert', {});
        }
      }
      const id = existing ?? newId();
      this.db
        .prepare(
          `INSERT INTO supplier_articles (id, supplier_id, article_id, supplier_ref, unit_cost, pack_qty, is_main, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET supplier_ref = excluded.supplier_ref, unit_cost = excluded.unit_cost,
             pack_qty = excluded.pack_qty, is_main = excluded.is_main, updated_at = excluded.updated_at`,
        )
        .run(id, input.supplierId, input.articleId, input.supplierRef?.trim() || null, input.unitCost, pack, isMain ? 1 : 0, now);
      this.enqueue(null, 'supplier_article', id, 'upsert', {});
      this.audit(userId, 'supplier.article', 'supplier', input.supplierId, { articleId: input.articleId, unitCost: input.unitCost });
      return this.supplierArticleQuery('sa.id = ?').get(id) as SupplierArticle;
    });
  }

  removeSupplierArticle(userId: string, id: string): void {
    this.tx(() => {
      this.db.prepare('DELETE FROM supplier_articles WHERE id = ?').run(id);
      this.enqueue(null, 'supplier_article', id, 'delete', null);
      this.audit(userId, 'supplier.article.remove', 'supplier_article', id);
    });
  }

  // --- Bons de commande -------------------------------------------------------

  private validateLines(lines: PurchaseOrderLineInput[]): void {
    if (lines.length === 0) throw new AppError('La commande est vide', 'EMPTY');
    for (const l of lines) {
      if (!Number.isSafeInteger(l.qty) || l.qty <= 0) throw new AppError('Quantité commandée invalide', 'INVALID');
      if (!Number.isSafeInteger(l.unitCost) || l.unitCost < 0) throw new AppError("Prix d'achat invalide", 'INVALID');
    }
  }

  private writeLines(orderId: string, lines: PurchaseOrderLineInput[]): void {
    this.db.prepare('DELETE FROM purchase_order_lines WHERE order_id = ?').run(orderId);
    const insert = this.db.prepare('INSERT INTO purchase_order_lines (id, order_id, line_no, article_id, qty, unit_cost) VALUES (?, ?, ?, ?, ?, ?)');
    lines.forEach((l, i) => insert.run(newId(), orderId, i + 1, l.articleId, l.qty, l.unitCost));
  }

  createOrder(
    ctx: Context,
    input: { supplierId: string; warehouseId: string; expectedDate?: string | null; notes?: string | null; lines: PurchaseOrderLineInput[] },
  ): PurchaseOrder {
    this.validateLines(input.lines);
    const supplier = this.getSupplier(input.supplierId);
    return this.tx(() => {
      const id = newId();
      const now = this.now();
      const today = this.today();
      const expected = input.expectedDate ?? dueDate(today, supplier.lead_time_days);
      this.db
        .prepare(
          `INSERT INTO purchase_orders (id, number, store_id, warehouse_id, supplier_id, status, order_date, expected_date, notes, user_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, this.number('BC', 'order.number'), ctx.storeId, input.warehouseId, input.supplierId, today, expected, input.notes?.trim() || null, ctx.userId, now, now);
      this.writeLines(id, input.lines);
      this.enqueue(ctx, 'purchase_order', id, 'upsert', {});
      this.audit(ctx.userId, 'order.create', 'purchase_order', id, { supplier: supplier.name, lines: input.lines.length });
      return this.getOrder(id);
    });
  }

  updateOrder(
    ctx: Context,
    id: string,
    input: { supplierId: string; warehouseId: string; expectedDate?: string | null; notes?: string | null; lines: PurchaseOrderLineInput[] },
  ): PurchaseOrder {
    this.validateLines(input.lines);
    const order = this.getOrder(id);
    if (order.status !== 'draft') throw new AppError('Seule une commande en brouillon peut être modifiée', 'INVALID_STATE');
    this.getSupplier(input.supplierId);
    return this.tx(() => {
      this.db
        .prepare('UPDATE purchase_orders SET supplier_id = ?, warehouse_id = ?, expected_date = ?, notes = ?, updated_at = ? WHERE id = ?')
        .run(input.supplierId, input.warehouseId, input.expectedDate ?? order.expected_date, input.notes?.trim() || null, this.now(), id);
      this.writeLines(id, input.lines);
      this.enqueue(ctx, 'purchase_order', id, 'upsert', {});
      return this.getOrder(id);
    });
  }

  /**
   * Envoyer (brouillon → envoyée), solder le reliquat d'une commande reçue en
   * partie, ou annuler une commande dont rien n'a été reçu.
   */
  setOrderStatus(ctx: Context, id: string, status: 'sent' | 'closed' | 'cancelled'): PurchaseOrder {
    const order = this.getOrder(id);
    const received = order.lines.some((l) => l.received > 0);
    if (status === 'sent' && order.status !== 'draft') throw new AppError('Cette commande a déjà été envoyée', 'INVALID_STATE');
    if (status === 'cancelled' && (received || order.status === 'closed' || order.status === 'cancelled')) {
      throw new AppError('Une commande déjà reçue, même en partie, se solde au lieu de s’annuler', 'INVALID_STATE');
    }
    if (status === 'closed' && order.status !== 'sent') throw new AppError('Seule une commande envoyée peut être soldée', 'INVALID_STATE');
    return this.tx(() => {
      this.db.prepare('UPDATE purchase_orders SET status = ?, updated_at = ? WHERE id = ?').run(status, this.now(), id);
      this.enqueue(ctx, 'purchase_order', id, 'upsert', {});
      this.audit(ctx.userId, `order.${status}`, 'purchase_order', id, { number: order.number });
      return this.getOrder(id);
    });
  }

  private orderState(status: PurchaseOrder['status'], lines: { qty: number; received: number }[]): OrderState {
    if (status !== 'sent') return status;
    if (lines.length && lines.every((l) => l.received >= l.qty)) return 'received';
    return lines.some((l) => l.received > 0) ? 'partial' : 'sent';
  }

  getOrder(id: string): PurchaseOrder {
    const head = this.db
      .prepare(
        `SELECT o.*, s.name AS supplier_name, w.name AS warehouse_name, u.name AS user_name
         FROM purchase_orders o JOIN suppliers s ON s.id = o.supplier_id JOIN warehouses w ON w.id = o.warehouse_id
         LEFT JOIN users u ON u.id = o.user_id WHERE o.id = ?`,
      )
      .get(id) as Omit<PurchaseOrder, 'lines' | 'state' | 'total_ht'> | undefined;
    if (!head) throw new AppError('Bon de commande introuvable', 'NOT_FOUND');
    const lines = (
      this.db
        .prepare(
          `SELECT l.id, l.line_no, l.article_id, a.code AS article_code, a.name AS article_name, a.unit, a.perishable,
                  sa.supplier_ref, l.qty, l.unit_cost,
                  COALESCE((SELECT SUM(rl.qty) FROM reception_lines rl WHERE rl.order_line_id = l.id), 0) AS received
           FROM purchase_order_lines l JOIN articles a ON a.id = l.article_id
           LEFT JOIN supplier_articles sa ON sa.article_id = l.article_id AND sa.supplier_id = ?
           WHERE l.order_id = ? ORDER BY l.line_no`,
        )
        .all(head.supplier_id, id) as Omit<PurchaseOrder['lines'][number], 'total_ht'>[]
    ).map((l) => ({ ...l, total_ht: lineAmount(l.unit_cost, l.qty) }));
    return {
      ...head,
      lines,
      state: this.orderState(head.status, lines),
      total_ht: lines.reduce((t, l) => t + l.total_ht, 0),
    };
  }

  listOrders(storeId: string, opts: { supplierId?: string; open?: boolean; limit?: number } = {}): Omit<PurchaseOrder, 'lines'>[] {
    const ids = this.db
      .prepare(
        `SELECT id FROM purchase_orders
         WHERE store_id = @storeId AND (@supplierId IS NULL OR supplier_id = @supplierId)
           AND (@open = 0 OR status IN ('draft', 'sent'))
         ORDER BY order_date DESC, number DESC LIMIT @limit`,
      )
      .pluck()
      .all({ storeId, supplierId: opts.supplierId ?? null, open: opts.open ? 1 : 0, limit: opts.limit ?? 200 }) as string[];
    return ids
      .map((id) => {
        const { lines: _, ...order } = this.getOrder(id);
        return order;
      })
      .filter((o) => !opts.open || o.state !== 'received');
  }

  /**
   * Réception d'une commande : chaque ligne reçue entre en stock (lot, date
   * limite, CMUP) et s'impute sur la ligne commandée. Des articles non
   * commandés peuvent être ajoutés (sans ligne de commande).
   */
  receiveOrder(
    ctx: Context,
    orderId: string,
    input: { deliveryNote?: string; lines: (Omit<ReceptionLine, 'orderLineId'> & { orderLineId?: string | null })[] },
  ): { id: string; number: string } {
    const order = this.getOrder(orderId);
    if (order.status !== 'sent') throw new AppError('Envoyez la commande avant de la réceptionner', 'INVALID_STATE');
    if (order.store_id !== ctx.storeId) throw new AppError("Cette commande appartient à un autre magasin", 'FORBIDDEN');
    const lines = input.lines.filter((l) => l.qty > 0);
    for (const l of lines) {
      if (l.orderLineId && !order.lines.some((ol) => ol.id === l.orderLineId)) throw new AppError('Ligne de commande inconnue', 'INVALID');
    }
    const result = this.stock.receive(ctx, {
      warehouseId: order.warehouse_id,
      reference: input.deliveryNote,
      supplierId: order.supplier_id,
      orderId,
      lines,
    });
    this.tx(() => this.enqueue(ctx, 'purchase_order', orderId, 'upsert', {}));
    return result;
  }

  // --- Réceptions ---------------------------------------------------------------

  private receptionTotals(id: string): { total_ht: Fcfa; total_tva: Fcfa; total_ttc: Fcfa } {
    const lines = this.db.prepare('SELECT qty, unit_cost, vat_rate_bp FROM reception_lines WHERE reception_id = ?').all(id) as {
      qty: number;
      unit_cost: number;
      vat_rate_bp: number;
    }[];
    return taxTotals(lines.map((l) => ({ ht: lineAmount(l.unit_cost, l.qty), rate: l.vat_rate_bp })));
  }

  listReceptions(storeId: string, opts: { supplierId?: string; uninvoiced?: boolean; limit?: number } = {}): Reception[] {
    const rows = this.db
      .prepare(
        `SELECT r.*, s.name AS supplier_name, w.name AS warehouse_name, o.number AS order_number, i.number AS invoice_number, u.name AS user_name
         FROM receptions r JOIN warehouses w ON w.id = r.warehouse_id
         LEFT JOIN suppliers s ON s.id = r.supplier_id LEFT JOIN purchase_orders o ON o.id = r.order_id
         LEFT JOIN supplier_invoices i ON i.id = r.invoice_id LEFT JOIN users u ON u.id = r.user_id
         WHERE r.store_id = @storeId AND (@supplierId IS NULL OR r.supplier_id = @supplierId) AND (@uninvoiced = 0 OR r.invoice_id IS NULL)
         ORDER BY r.received_at DESC LIMIT @limit`,
      )
      .all({ storeId, supplierId: opts.supplierId ?? null, uninvoiced: opts.uninvoiced ? 1 : 0, limit: opts.limit ?? 200 }) as Omit<
      Reception,
      'total_ht' | 'total_tva' | 'total_ttc'
    >[];
    return rows.map((r) => ({ ...r, ...this.receptionTotals(r.id) }));
  }

  getReception(id: string): ReceptionDetail {
    const head = this.listReceptionById(id);
    const lines = (
      this.db
        .prepare(
          `SELECT rl.id, rl.article_id, a.code AS article_code, a.name AS article_name, a.unit, rl.qty, rl.unit_cost, rl.vat_rate_bp,
                  rl.lot_number, rl.expiry
           FROM reception_lines rl JOIN articles a ON a.id = rl.article_id WHERE rl.reception_id = ? ORDER BY rl.line_no`,
        )
        .all(id) as Omit<ReceptionDetail['lines'][number], 'total_ht'>[]
    ).map((l) => ({ ...l, total_ht: lineAmount(l.unit_cost, l.qty) }));
    return { ...head, lines };
  }

  private listReceptionById(id: string): Reception {
    const row = this.db
      .prepare(
        `SELECT r.*, s.name AS supplier_name, w.name AS warehouse_name, o.number AS order_number, i.number AS invoice_number, u.name AS user_name
         FROM receptions r JOIN warehouses w ON w.id = r.warehouse_id
         LEFT JOIN suppliers s ON s.id = r.supplier_id LEFT JOIN purchase_orders o ON o.id = r.order_id
         LEFT JOIN supplier_invoices i ON i.id = r.invoice_id LEFT JOIN users u ON u.id = r.user_id WHERE r.id = ?`,
      )
      .get(id) as Omit<Reception, 'total_ht' | 'total_tva' | 'total_ttc'> | undefined;
    if (!row) throw new AppError('Bon de réception introuvable', 'NOT_FOUND');
    return { ...row, ...this.receptionTotals(id) };
  }

  // --- Factures et règlements ---------------------------------------------------

  /** Montants proposés pour une facture à partir des réceptions cochées (rapprochement). */
  invoicePreview(receptionIds: string[]): { total_ht: Fcfa; total_tva: Fcfa; total_ttc: Fcfa } {
    const parts = receptionIds.map((id) => this.receptionTotals(id));
    return {
      total_ht: parts.reduce((t, p) => t + p.total_ht, 0),
      total_tva: parts.reduce((t, p) => t + p.total_tva, 0),
      total_ttc: parts.reduce((t, p) => t + p.total_ttc, 0),
    };
  }

  createInvoice(
    ctx: Context,
    input: {
      supplierId: string;
      kind?: 'invoice' | 'credit_note';
      supplierNumber: string;
      invoiceDate: string;
      dueDate?: string | null;
      totalHt: Fcfa;
      totalTva: Fcfa;
      receptionIds?: string[];
      notes?: string | null;
    },
  ): SupplierInvoice {
    const supplier = this.getSupplier(input.supplierId);
    const supplierNumber = input.supplierNumber.trim();
    if (!supplierNumber) throw new AppError('Le numéro de la facture du fournisseur est obligatoire', 'INVALID');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.invoiceDate)) throw new AppError('Date de facture invalide', 'INVALID');
    for (const v of [input.totalHt, input.totalTva]) {
      if (!Number.isSafeInteger(v) || v < 0) throw new AppError('Montant invalide', 'INVALID');
    }
    if (input.totalHt + input.totalTva <= 0) throw new AppError('Le montant de la facture doit être positif', 'INVALID');
    const kind = input.kind ?? 'invoice';
    const receptionIds = kind === 'invoice' ? (input.receptionIds ?? []) : [];
    for (const rid of receptionIds) {
      const r = this.listReceptionById(rid);
      if (r.supplier_id !== supplier.id) throw new AppError(`Le bon ${r.number} n'est pas de ce fournisseur`, 'INVALID');
      if (r.invoice_id) throw new AppError(`Le bon ${r.number} est déjà facturé (${r.invoice_number})`, 'INVALID');
    }
    const duplicate = this.db
      .prepare('SELECT number FROM supplier_invoices WHERE supplier_id = ? AND kind = ? AND supplier_number = ?')
      .pluck()
      .get(supplier.id, kind, supplierNumber) as string | undefined;
    if (duplicate) throw new AppError(`Cette facture fournisseur est déjà saisie (${duplicate})`, 'DUPLICATE');
    // Magasin non assujetti : la TVA du fournisseur n'est pas récupérable, elle fait partie du coût d'achat.
    const vatEnabled = (this.db.prepare('SELECT vat_enabled FROM stores WHERE id = ?').pluck().get(ctx.storeId) as number | undefined) !== 0;
    const totalHt = vatEnabled ? input.totalHt : input.totalHt + input.totalTva;
    const totalTva = vatEnabled ? input.totalTva : 0;
    return this.tx(() => {
      const id = newId();
      const row = {
        id,
        number: this.number(kind === 'invoice' ? 'FF' : 'AF', 'supplier_invoice.number'),
        kind,
        supplier_id: supplier.id,
        store_id: ctx.storeId,
        supplier_number: supplierNumber,
        invoice_date: input.invoiceDate,
        due_date: input.dueDate || dueDate(input.invoiceDate, supplier.payment_terms_days),
        total_ht: totalHt,
        total_tva: totalTva,
        total_ttc: totalHt + totalTva,
        received_ht: this.invoicePreview(receptionIds).total_ht,
        notes: input.notes?.trim() || null,
        user_id: ctx.userId,
        created_at: this.now(),
      };
      this.db
        .prepare(
          `INSERT INTO supplier_invoices (id, number, kind, supplier_id, store_id, supplier_number, invoice_date, due_date, total_ht, total_tva,
             total_ttc, received_ht, notes, user_id, created_at)
           VALUES (@id, @number, @kind, @supplier_id, @store_id, @supplier_number, @invoice_date, @due_date, @total_ht, @total_tva,
             @total_ttc, @received_ht, @notes, @user_id, @created_at)`,
        )
        .run(row);
      this.enqueue(ctx, 'supplier_invoice', id, 'upsert', {});
      for (const rid of receptionIds) {
        this.db.prepare('UPDATE receptions SET invoice_id = ? WHERE id = ?').run(id, rid);
        this.enqueue(ctx, 'reception', rid, 'upsert', {});
      }
      this.audit(ctx.userId, `supplier_invoice.${kind}`, 'supplier_invoice', id, { supplier: supplier.name, ttc: row.total_ttc });
      return this.getInvoice(id);
    });
  }

  private invoiceQuery(where: string) {
    return this.db.prepare(
      `SELECT i.*, s.name AS supplier_name,
              COALESCE((SELECT SUM(p.amount) FROM supplier_payments p WHERE p.invoice_id = i.id), 0) AS paid
       FROM supplier_invoices i JOIN suppliers s ON s.id = i.supplier_id
       WHERE ${where} ORDER BY i.due_date, i.invoice_date`,
    );
  }

  private withState(row: Omit<SupplierInvoice, 'balance' | 'state' | 'overdue'>): SupplierInvoice {
    const balance = row.total_ttc - row.paid;
    const state: InvoiceState = balance <= 0 ? 'paid' : row.paid > 0 ? 'partial' : 'unpaid';
    return { ...row, balance, state, overdue: state !== 'paid' && row.kind === 'invoice' && row.due_date < this.today() };
  }

  getInvoice(id: string): SupplierInvoice {
    const row = this.invoiceQuery('i.id = ?').get(id) as Omit<SupplierInvoice, 'balance' | 'state' | 'overdue'> | undefined;
    if (!row) throw new AppError('Facture fournisseur introuvable', 'NOT_FOUND');
    return this.withState(row);
  }

  listInvoices(storeId: string, opts: { supplierId?: string; unpaid?: boolean } = {}): SupplierInvoice[] {
    const rows = this.invoiceQuery('i.store_id = @storeId AND (@supplierId IS NULL OR i.supplier_id = @supplierId)').all({
      storeId,
      supplierId: opts.supplierId ?? null,
    }) as Omit<SupplierInvoice, 'balance' | 'state' | 'overdue'>[];
    return rows.map((r) => this.withState(r)).filter((r) => !opts.unpaid || r.state !== 'paid');
  }

  invoicePayments(invoiceId: string): { id: string; method: SupplierPaymentMethod; amount: Fcfa; reference: string | null; paid_at: string; user_name: string | null }[] {
    return this.db
      .prepare(
        `SELECT p.id, p.method, p.amount, p.reference, p.paid_at, u.name AS user_name
         FROM supplier_payments p LEFT JOIN users u ON u.id = p.user_id WHERE p.invoice_id = ? ORDER BY p.paid_at`,
      )
      .all(invoiceId) as never;
  }

  /** Règlement (total ou partiel) d'une facture fournisseur ; pour un avoir, c'est un remboursement reçu. */
  paySupplier(ctx: Context, input: { invoiceId: string; method: SupplierPaymentMethod; amount: Fcfa; reference?: string | null; paidAt?: string }): SupplierInvoice {
    const invoice = this.getInvoice(input.invoiceId);
    if (!(input.method in SUPPLIER_PAYMENT_METHODS)) throw new AppError('Mode de règlement inconnu', 'INVALID');
    if (!Number.isSafeInteger(input.amount) || input.amount <= 0) throw new AppError('Montant invalide', 'INVALID');
    if (input.amount > invoice.balance) throw new AppError(`Le montant dépasse le reste à payer (${invoice.balance} FCFA)`, 'INVALID');
    if (input.method !== 'CASH' && !input.reference?.trim()) throw new AppError('La référence du règlement est obligatoire', 'INVALID');
    return this.tx(() => {
      const id = newId();
      this.db
        .prepare(
          `INSERT INTO supplier_payments (id, invoice_id, supplier_id, store_id, method, amount, reference, paid_at, user_id, from_central)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        // Espèces payées au bureau : elles sortent de la caisse centrale.
        .run(id, invoice.id, invoice.supplier_id, ctx.storeId, input.method, input.amount, input.reference?.trim() || null, input.paidAt ?? this.now(), ctx.userId, input.method === 'CASH' ? 1 : 0);
      this.enqueue(ctx, 'supplier_payment', id, 'upsert', {});
      this.audit(ctx.userId, 'supplier.payment', 'supplier_invoice', invoice.id, { amount: input.amount, method: input.method });
      return this.getInvoice(invoice.id);
    });
  }

  /** Échéancier : factures restant à payer, par date d'échéance. */
  dueSchedule(storeId: string): { invoices: SupplierInvoice[]; overdue: Fcfa; dueThisWeek: Fcfa; total: Fcfa } {
    const invoices = this.listInvoices(storeId, { unpaid: true }).filter((i) => i.kind === 'invoice');
    const week = dueDate(this.today(), 7);
    return {
      invoices,
      overdue: invoices.filter((i) => i.overdue).reduce((t, i) => t + i.balance, 0),
      dueThisWeek: invoices.filter((i) => !i.overdue && i.due_date <= week).reduce((t, i) => t + i.balance, 0),
      total: invoices.reduce((t, i) => t + i.balance, 0),
    };
  }

  // --- Réapprovisionnement ------------------------------------------------------

  /**
   * Proposition de commande pour un magasin : articles dont le stock, plus ce
   * qui est déjà commandé, passe sous le point de commande (stock d'alerte ou
   * ventes pendant le délai du fournisseur principal).
   */
  reorderProposal(storeId: string, opts: { coverDays?: number; historyDays?: number } = {}): ReorderRow[] {
    const historyDays = opts.historyDays ?? 28;
    const since = new Date(this.clock().getTime() - historyDays * 86_400_000).toISOString();
    const rows = this.db
      .prepare(
        `SELECT a.id AS article_id, a.code AS article_code, a.name AS article_name, a.unit, a.min_qty, a.alert_qty, a.max_qty,
                a.purchase_price,
                COALESCE((SELECT SUM(s.qty) FROM stock s JOIN warehouses w ON w.id = s.warehouse_id
                           WHERE s.article_id = a.id AND w.store_id = @storeId), 0) AS stock,
                COALESCE((SELECT SUM(MAX(l.qty - COALESCE((SELECT SUM(rl.qty) FROM reception_lines rl WHERE rl.order_line_id = l.id), 0), 0))
                           FROM purchase_order_lines l JOIN purchase_orders o ON o.id = l.order_id
                           WHERE l.article_id = a.id AND o.store_id = @storeId AND o.status IN ('draft', 'sent')), 0) AS on_order,
                COALESCE((SELECT -SUM(m.qty) FROM stock_movements m JOIN warehouses w ON w.id = m.warehouse_id
                           WHERE m.article_id = a.id AND w.store_id = @storeId AND m.type IN ('SALE', 'RETURN') AND m.at >= @since), 0) AS sold
         FROM articles a WHERE a.active = 1`,
      )
      .all({ storeId, since }) as {
      article_id: string;
      article_code: string;
      article_name: string;
      unit: ReorderRow['unit'];
      min_qty: number | null;
      alert_qty: number | null;
      max_qty: number | null;
      purchase_price: number;
      stock: number;
      on_order: number;
      sold: number;
    }[];
    const mainSupplier = this.db.prepare(
      `SELECT sa.supplier_id, s.name AS supplier_name, s.lead_time_days, sa.supplier_ref, sa.unit_cost, sa.pack_qty
       FROM supplier_articles sa JOIN suppliers s ON s.id = sa.supplier_id
       WHERE sa.article_id = ? AND s.active = 1 ORDER BY sa.is_main DESC, sa.unit_cost LIMIT 1`,
    );
    const result: ReorderRow[] = [];
    for (const r of rows) {
      const sup = mainSupplier.get(r.article_id) as
        | { supplier_id: string; supplier_name: string; lead_time_days: number; supplier_ref: string | null; unit_cost: number; pack_qty: number }
        | undefined;
      const avgDaily = Math.max(0, Math.round(r.sold / historyDays));
      const s = suggestReorder({
        stock: r.stock,
        onOrder: r.on_order,
        avgDailySales: avgDaily,
        leadTimeDays: sup?.lead_time_days ?? 2,
        coverDays: opts.coverDays ?? 7,
        minQty: r.min_qty,
        alertQty: r.alert_qty,
        maxQty: r.max_qty,
        packQty: sup?.pack_qty,
      });
      if (s.qty <= 0) continue;
      result.push({
        article_id: r.article_id,
        article_code: r.article_code,
        article_name: r.article_name,
        unit: r.unit,
        supplier_id: sup?.supplier_id ?? null,
        supplier_name: sup?.supplier_name ?? null,
        supplier_ref: sup?.supplier_ref ?? null,
        unit_cost: sup?.unit_cost || r.purchase_price,
        pack_qty: sup?.pack_qty ?? 1000,
        stock: r.stock,
        on_order: r.on_order,
        avg_daily_sales: avgDaily,
        reorder_point: s.reorderPoint,
        target: s.target,
        qty: s.qty,
      });
    }
    return result.sort((a, b) => (a.supplier_name ?? '~').localeCompare(b.supplier_name ?? '~') || a.article_name.localeCompare(b.article_name));
  }

  /** Transforme une proposition validée en bons de commande brouillon, un par fournisseur. */
  createOrdersFromProposal(
    ctx: Context,
    input: { warehouseId: string; lines: (PurchaseOrderLineInput & { supplierId: string })[] },
  ): PurchaseOrder[] {
    const bySupplier = new Map<string, PurchaseOrderLineInput[]>();
    for (const l of input.lines.filter((l) => l.qty > 0)) {
      if (!l.supplierId) throw new AppError('Choisissez un fournisseur pour chaque article', 'INVALID');
      bySupplier.set(l.supplierId, [...(bySupplier.get(l.supplierId) ?? []), { articleId: l.articleId, qty: l.qty, unitCost: l.unitCost }]);
    }
    if (bySupplier.size === 0) throw new AppError('Aucune ligne à commander', 'EMPTY');
    return this.tx(() =>
      [...bySupplier].map(([supplierId, lines]) => this.createOrder(ctx, { supplierId, warehouseId: input.warehouseId, lines })),
    );
  }
}

/** Totaux HT, TVA, TTC d'un document d'achat, TVA calculée par taux sur le cumul HT. */
function taxTotals(lines: { ht: Fcfa; rate: number }[]): { total_ht: Fcfa; total_tva: Fcfa; total_ttc: Fcfa } {
  const byRate = new Map<number, number>();
  for (const l of lines) byRate.set(l.rate, (byRate.get(l.rate) ?? 0) + l.ht);
  let ht = 0;
  let ttc = 0;
  for (const [rate, base] of byRate) {
    ht += base;
    ttc += ttcFromHt(base, rate);
  }
  return { total_ht: ht, total_tva: ttc - ht, total_ttc: ttc };
}

