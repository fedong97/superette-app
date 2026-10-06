import {
  type CartLine,
  type DenominationCount,
  type Fcfa,
  type Milli,
  type Payment,
  type PaymentMethod,
  PAYMENT_METHODS,
  closingDifference,
  computeTotals,
  lineTotal,
  requiresReference,
  settle,
  splitTtc,
} from '@superette/core';
import type { AdminService } from './admin';
import type { CatalogueService } from './catalogue';
import type { CustomerService } from './customers';
import type { QuoteService } from './quotes';
import type { StockService } from './stock';
import { AppError, Base, type Clock, type Context, newId } from './util';
import type { Db } from './database';

export interface CashSession {
  id: string;
  store_id: string;
  register_id: string;
  user_id: string;
  user_name: string;
  opened_at: string;
  opening_float: Fcfa;
  closed_at: string | null;
  expected_cash: Fcfa | null;
  counted_cash: Fcfa | null;
  difference: Fcfa | null;
  z_number: number | null;
  status: 'open' | 'closed';
}

/** Ligne envoyée par l'écran de caisse : le prix est relu en base, jamais pris de l'écran. */
export interface SaleLineInput {
  articleId: string;
  qty: Milli;
  barcode?: string | null;
  discount?: Fcfa;
}

export interface SaleInput {
  lines: SaleLineInput[];
  payments: Payment[];
  /** Gérant qui a validé les remises, si le caissier n'a pas ce droit. */
  discountAuthorizedBy?: string | null;
  /** Client de la vente : obligatoire pour une vente à crédit, facultatif sinon (nom sur la facture). */
  customerId?: string | null;
  /** Gérant qui a accepté un dépassement du plafond de crédit. */
  creditAuthorizedBy?: string | null;
  /** Devis ou proforma facturé : ses prix garantis valent accord de remise. */
  quoteId?: string | null;
}

export interface Sale {
  id: string;
  number: string;
  kind: 'sale' | 'return';
  status: 'completed' | 'cancelled';
  store_id: string;
  register_id: string;
  session_id: string;
  user_id: string;
  user_name: string;
  total_ttc: Fcfa;
  total_ht: Fcfa;
  total_tva: Fcfa;
  total_discount: Fcfa;
  change_given: Fcfa;
  original_sale_id: string | null;
  cancel_reason: string | null;
  customer_id: string | null;
  customer_name: string | null;
  due_date: string | null;
  created_at: string;
  lines: {
    id: string;
    line_no: number;
    article_id: string;
    label: string;
    barcode: string | null;
    qty: Milli;
    unit_price: Fcfa;
    discount: Fcfa;
    vat_rate_bp: number;
    total_ttc: Fcfa;
    unit: 'piece' | 'kg' | 'litre';
  }[];
  payments: { method: PaymentMethod; amount: Fcfa; reference: string | null }[];
}

export interface ZReport {
  session: CashSession;
  storeName: string;
  registerName: string;
  ticketCount: number;
  salesTtc: Fcfa;
  returnsTtc: Fcfa;
  netTtc: Fcfa;
  discounts: Fcfa;
  cancelled: { count: number; amount: Fcfa };
  byMethod: { method: PaymentMethod; label: string; amount: Fcfa }[];
  vat: { rate: number; ht: Fcfa; tva: Fcfa; ttc: Fcfa }[];
  cashOperations: { type: 'IN' | 'OUT'; amount: Fcfa; reason: string; at: string }[];
  customerReceipts: { method: string; label: string; amount: Fcfa }[];
  /** Dépenses payées avec les espèces du tiroir. */
  expenses: { number: string; label: string; amount: Fcfa }[];
  cash: { openingFloat: Fcfa; cashSales: Fcfa; cashRefunds: Fcfa; cashIn: Fcfa; cashOut: Fcfa; customerReceipts: Fcfa; expenses: Fcfa; expected: Fcfa };
  counted: Fcfa | null;
  difference: Fcfa | null;
}

export class PosService extends Base {
  constructor(
    db: Db,
    clock: Clock,
    private readonly admin: AdminService,
    private readonly catalogue: CatalogueService,
    private readonly stock: StockService,
    private readonly customers: CustomerService,
    private readonly quotes: QuoteService,
  ) {
    super(db, clock);
  }

  private requireRegister(ctx: Context): string {
    if (!ctx.registerId) throw new AppError("Ce poste n'est pas activé comme caisse", 'NO_REGISTER');
    return ctx.registerId;
  }

  // --- Sessions de caisse ---------------------------------------------------

  currentSession(registerId: string): CashSession | null {
    return (
      (this.db
        .prepare(
          `SELECT s.*, u.name AS user_name FROM cash_sessions s JOIN users u ON u.id = s.user_id
           WHERE s.register_id = ? AND s.status = 'open'`,
        )
        .get(registerId) as CashSession | undefined) ?? null
    );
  }

  getSession(id: string): CashSession {
    const s = this.db
      .prepare('SELECT s.*, u.name AS user_name FROM cash_sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?')
      .get(id) as CashSession | undefined;
    if (!s) throw new AppError('Session de caisse introuvable', 'NOT_FOUND');
    return s;
  }

  private requireOpenSession(ctx: Context): CashSession {
    const session = this.currentSession(this.requireRegister(ctx));
    if (!session) throw new AppError("La caisse n'est pas ouverte", 'SESSION_CLOSED');
    return session;
  }

  openSession(ctx: Context, openingFloat: Fcfa): CashSession {
    const registerId = this.requireRegister(ctx);
    if (!Number.isSafeInteger(openingFloat) || openingFloat < 0) throw new AppError('Fond de caisse invalide', 'INVALID');
    if (this.currentSession(registerId)) throw new AppError('La caisse est déjà ouverte', 'SESSION_OPEN');
    const id = newId();
    this.tx(() => {
      this.db
        .prepare(
          `INSERT INTO cash_sessions (id, store_id, register_id, user_id, opened_at, opening_float, status)
           VALUES (?, ?, ?, ?, ?, ?, 'open')`,
        )
        .run(id, ctx.storeId, registerId, ctx.userId, this.now(), openingFloat);
      this.enqueue(ctx, 'cash_session', id, 'upsert', this.getSession(id));
      this.audit(ctx.userId, 'cash.open', 'cash_session', id, { openingFloat });
    });
    return this.getSession(id);
  }

  /** Apport (IN) ou prélèvement (OUT) d'espèces en cours de journée. */
  cashOperation(ctx: Context, type: 'IN' | 'OUT', amount: Fcfa, reason: string): void {
    const session = this.requireOpenSession(ctx);
    if (!Number.isSafeInteger(amount) || amount <= 0) throw new AppError('Montant invalide', 'INVALID');
    if (!reason.trim()) throw new AppError('Le motif est obligatoire', 'INVALID');
    this.tx(() => {
      const id = newId();
      const row = { id, session_id: session.id, type, amount, reason: reason.trim(), user_id: ctx.userId, at: this.now() };
      this.db
        .prepare('INSERT INTO cash_operations (id, session_id, type, amount, reason, user_id, at) VALUES (@id, @session_id, @type, @amount, @reason, @user_id, @at)')
        .run(row);
      this.enqueue(ctx, 'cash_operation', id, 'upsert', row);
      this.audit(ctx.userId, type === 'IN' ? 'cash.in' : 'cash.out', 'cash_session', session.id, { amount, reason });
    });
  }

  // --- Ventes ---------------------------------------------------------------

  private nextTicketNumber(ctx: Context): string {
    const store = this.admin.getStore(ctx.storeId);
    const register = this.admin.getRegister(this.requireRegister(ctx));
    const seq = this.nextCounter(`ticket:${register.id}`);
    return `${store.code}-${register.number}-${String(seq).padStart(6, '0')}`;
  }

  /** Recalcule les lignes à partir des prix en base (prix magasin, étiquettes balance). */
  priceLines(storeId: string, input: SaleLineInput[]): (CartLine & { barcode: string | null })[] {
    return input.map((l) => {
      if (!Number.isSafeInteger(l.qty) || l.qty === 0) throw new AppError('Quantité invalide', 'INVALID');
      const article = this.catalogue.getArticle(l.articleId, storeId);
      if (!article.active) throw new AppError(`Article inactif : ${article.name}`, 'INACTIVE');
      const scan = l.barcode ? this.catalogue.scan(l.barcode, storeId) : null;
      const fixedAmount = scan && scan.article.id === article.id && scan.fixedAmount !== undefined && l.qty === scan.qty ? scan.fixedAmount : undefined;
      const discount = l.discount ?? 0;
      if (!Number.isSafeInteger(discount) || discount < 0) throw new AppError('Remise invalide', 'INVALID');
      const line: CartLine & { barcode: string | null } = {
        articleId: article.id,
        label: article.name,
        unitPrice: article.store_price,
        qty: l.qty,
        vatRate: article.vat_rate_bp,
        discount,
        fixedAmount,
        barcode: l.barcode ?? null,
      };
      if (lineTotal(line) < 0) throw new AppError(`Remise supérieure au prix : ${article.name}`, 'INVALID');
      return line;
    });
  }

  completeSale(ctx: Context, input: SaleInput): Sale {
    const session = this.requireOpenSession(ctx);
    if (input.lines.length === 0) throw new AppError('Ticket vide', 'EMPTY');
    if (input.lines.some((l) => l.qty < 0)) throw new AppError('Quantité négative : utilisez le retour client', 'INVALID');
    const lines = this.priceLines(ctx.storeId, input.lines);
    const totals = computeTotals(lines);
    const quote = input.quoteId ? this.quotes.authorizeSaleDiscounts(ctx.storeId, input.quoteId, lines) : null;
    let discountBy = input.discountAuthorizedBy ?? null;
    if (quote) discountBy ??= quote.by;
    if (totals.totalDiscount > 0 && !quote) {
      const user = this.admin.getUser(ctx.userId);
      const authorizer = input.discountAuthorizedBy ? this.admin.getUser(input.discountAuthorizedBy) : null;
      const allowed = (u: { role: string } | null) => u !== null && (u.role === 'admin' || u.role === 'manager');
      if (!allowed(user) && !allowed(authorizer)) throw new AppError('Remise soumise à validation du gérant', 'SUPERVISOR_REQUIRED');
    }
    for (const p of input.payments) {
      if (!(p.method in PAYMENT_METHODS)) throw new AppError(`Moyen de paiement inconnu : ${p.method}`, 'INVALID');
      if (requiresReference(p.method) && !p.reference?.trim()) {
        throw new AppError(`Référence de transaction obligatoire pour ${PAYMENT_METHODS[p.method]}`, 'REFERENCE_REQUIRED');
      }
    }
    const settlement = settle(totals.totalTtc, input.payments);
    if (!settlement.complete) throw new AppError('Le ticket n’est pas entièrement réglé', 'UNPAID');
    const onCredit = input.payments.filter((p) => p.method === 'CUSTOMER_CREDIT').reduce((t, p) => t + p.amount, 0);
    if (onCredit > 0 && !input.customerId) throw new AppError('Choisissez le client pour une vente à crédit', 'CUSTOMER_REQUIRED');
    const customer = input.customerId
      ? onCredit > 0
        ? this.customers.assertCredit(ctx.storeId, input.customerId, onCredit, input.creditAuthorizedBy ? this.admin.getUser(input.creditAuthorizedBy) : null)
        : this.customers.getCustomer(input.customerId)
      : null;
    const due = customer && onCredit > 0 ? this.customers.dueDateFor(customer) : null;

    return this.tx(() => {
      const saleId = newId();
      const number = this.nextTicketNumber(ctx);
      const warehouse = this.admin.salesWarehouse(ctx.storeId);
      const now = this.now();
      this.db
        .prepare(
          `INSERT INTO sales (id, number, kind, store_id, register_id, session_id, user_id, status, total_ttc, total_ht,
             total_tva, total_discount, change_given, customer_id, due_date, created_at)
           VALUES (?, ?, 'sale', ?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          saleId,
          number,
          ctx.storeId,
          ctx.registerId,
          session.id,
          ctx.userId,
          totals.totalTtc,
          totals.totalHt,
          totals.totalTva,
          totals.totalDiscount,
          settlement.change,
          customer?.id ?? null,
          due,
          now,
        );
      const insertLine = this.db.prepare(
        `INSERT INTO sale_lines (id, sale_id, line_no, article_id, label, barcode, qty, unit_price, discount, vat_rate_bp, total_ttc, unit_cost)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      lines.forEach((line, i) => {
        const { unitCost } = this.stock.issue(ctx, {
          type: 'SALE',
          articleId: line.articleId,
          warehouseId: warehouse.id,
          qty: line.qty,
          refType: 'sale',
          refId: saleId,
        });
        insertLine.run(newId(), saleId, i + 1, line.articleId, line.label, line.barcode, line.qty, line.unitPrice, line.discount, line.vatRate, lineTotal(line), unitCost);
      });
      const insertPayment = this.db.prepare('INSERT INTO sale_payments (id, sale_id, method, amount, reference) VALUES (?, ?, ?, ?, ?)');
      for (const p of input.payments) insertPayment.run(newId(), saleId, p.method, p.amount, p.reference?.trim() || null);
      if (totals.totalDiscount > 0) {
        this.audit(ctx.userId, 'sale.discount', 'sale', saleId, { amount: totals.totalDiscount, authorizedBy: discountBy, quoteId: input.quoteId ?? null });
      }
      if (input.quoteId) this.quotes.markAccepted(ctx, input.quoteId, saleId);
      const sale = this.getSale(saleId);
      this.enqueue(ctx, 'sale', saleId, 'upsert', sale);
      return sale;
    });
  }

  getSale(id: string): Sale {
    const sale = this.db
      .prepare(
        `SELECT s.*, u.name AS user_name, c.name AS customer_name FROM sales s JOIN users u ON u.id = s.user_id
         LEFT JOIN customers c ON c.id = s.customer_id WHERE s.id = ?`,
      )
      .get(id) as Omit<Sale, 'lines' | 'payments'> | undefined;
    if (!sale) throw new AppError('Ticket introuvable', 'NOT_FOUND');
    const lines = this.db
      .prepare(
        `SELECT l.id, l.line_no, l.article_id, l.label, l.barcode, l.qty, l.unit_price, l.discount, l.vat_rate_bp, l.total_ttc, a.unit
         FROM sale_lines l JOIN articles a ON a.id = l.article_id WHERE l.sale_id = ? ORDER BY l.line_no`,
      )
      .all(id) as Sale['lines'];
    const payments = this.db.prepare('SELECT method, amount, reference FROM sale_payments WHERE sale_id = ?').all(id) as Sale['payments'];
    return { ...sale, lines, payments };
  }

  findSaleByNumber(number: string): Sale | null {
    const id = this.db.prepare('SELECT id FROM sales WHERE number = ?').pluck().get(number.trim().toUpperCase()) as string | undefined;
    return id ? this.getSale(id) : null;
  }

  listSales(opts: { sessionId?: string; storeId?: string; date?: string; customerId?: string; limit?: number }): Omit<Sale, 'lines' | 'payments'>[] {
    return this.db
      .prepare(
        `SELECT s.*, u.name AS user_name, c.name AS customer_name FROM sales s JOIN users u ON u.id = s.user_id
         LEFT JOIN customers c ON c.id = s.customer_id
         WHERE (@sessionId IS NULL OR s.session_id = @sessionId)
           AND (@storeId IS NULL OR s.store_id = @storeId)
           AND (@date IS NULL OR date(s.created_at, 'localtime') = @date)
           AND (@customerId IS NULL OR s.customer_id = @customerId)
         ORDER BY s.created_at DESC LIMIT @limit`,
      )
      .all({ sessionId: opts.sessionId ?? null, storeId: opts.storeId ?? null, date: opts.date ?? null, customerId: opts.customerId ?? null, limit: opts.limit ?? 500 }) as never;
  }

  /**
   * Annulation d'un ticket de la session en cours, sous code superviseur.
   * La marchandise est remise en stock ; le ticket reste tracé comme annulé.
   */
  cancelSale(ctx: Context, saleId: string, supervisorId: string, reason: string): Sale {
    const session = this.requireOpenSession(ctx);
    const supervisor = this.admin.getUser(supervisorId);
    if (supervisor.role !== 'admin' && supervisor.role !== 'manager') throw new AppError('Annulation réservée au gérant', 'SUPERVISOR_REQUIRED');
    if (!reason.trim()) throw new AppError("Le motif d'annulation est obligatoire", 'INVALID');
    const sale = this.getSale(saleId);
    if (sale.status !== 'completed' || sale.kind !== 'sale') throw new AppError('Ce ticket ne peut pas être annulé', 'INVALID');
    const hasReturns = this.db.prepare("SELECT 1 FROM sales WHERE original_sale_id = ? AND status = 'completed'").get(saleId);
    if (hasReturns) throw new AppError('Ce ticket a déjà fait l’objet d’un retour client', 'INVALID');
    if (sale.session_id !== session.id) throw new AppError('Seuls les tickets de la session en cours peuvent être annulés ; faites un retour client', 'INVALID');
    return this.tx(() => {
      this.db.prepare("UPDATE sales SET status = 'cancelled', cancelled_by = ?, cancel_reason = ? WHERE id = ?").run(supervisorId, reason.trim(), saleId);
      this.restockSaleMovements(ctx, saleId, 'sale_cancel', saleId);
      this.audit(supervisorId, 'sale.cancel', 'sale', saleId, { number: sale.number, total: sale.total_ttc, reason, cashier: ctx.userId });
      const updated = this.getSale(saleId);
      this.enqueue(ctx, 'sale', saleId, 'upsert', updated);
      return updated;
    });
  }

  /** Remet en stock les quantités sorties pour un ticket, dans leurs lots d'origine. */
  private restockSaleMovements(ctx: Context, saleId: string, refType: string, refId: string, only?: Map<string, Milli>): void {
    const moves = this.db
      .prepare("SELECT article_id, warehouse_id, lot_id, -qty AS qty FROM stock_movements WHERE ref_type = 'sale' AND ref_id = ? ORDER BY at")
      .all(saleId) as { article_id: string; warehouse_id: string; lot_id: string | null; qty: number }[];
    const remaining = only ? new Map(only) : null;
    for (const m of moves) {
      let qty = m.qty;
      if (remaining) {
        const left = remaining.get(m.article_id) ?? 0;
        qty = Math.min(qty, left);
        if (qty <= 0) continue;
        remaining.set(m.article_id, left - qty);
      }
      this.stock.restock(ctx, { articleId: m.article_id, warehouseId: m.warehouse_id, qty, lotId: m.lot_id, refType, refId });
    }
  }

  /**
   * Retour client sur un ticket existant, sous code superviseur : ticket de
   * retour en négatif, remboursement, remise en stock.
   */
  returnSale(
    ctx: Context,
    input: { originalSaleId: string; lines: { lineId: string; qty: Milli }[]; refundMethod: PaymentMethod; supervisorId: string; reason: string },
  ): Sale {
    const session = this.requireOpenSession(ctx);
    const supervisor = this.admin.getUser(input.supervisorId);
    if (supervisor.role !== 'admin' && supervisor.role !== 'manager') throw new AppError('Retour réservé au gérant', 'SUPERVISOR_REQUIRED');
    if (!input.reason.trim()) throw new AppError('Le motif du retour est obligatoire', 'INVALID');
    const original = this.getSale(input.originalSaleId);
    if (original.kind !== 'sale' || original.status !== 'completed') throw new AppError('Ce ticket ne peut pas faire l’objet d’un retour', 'INVALID');
    const alreadyReturned = new Map<number, number>();
    for (const r of this.db
      .prepare(
        `SELECT l.line_no, -SUM(l.qty) AS qty FROM sale_lines l JOIN sales s ON s.id = l.sale_id
         WHERE s.original_sale_id = ? AND s.status = 'completed' GROUP BY l.line_no`,
      )
      .all(original.id) as { line_no: number; qty: number }[]) {
      alreadyReturned.set(r.line_no, r.qty);
    }
    const returned = input.lines
      .filter((l) => l.qty > 0)
      .map((l) => {
        const line = original.lines.find((o) => o.id === l.lineId);
        if (!line) throw new AppError('Ligne de ticket introuvable', 'NOT_FOUND');
        const max = line.qty - (alreadyReturned.get(line.line_no) ?? 0);
        if (l.qty > max) throw new AppError(`Quantité retournée supérieure à la quantité vendue : ${line.label}`, 'INVALID');
        // Montant remboursé au prorata de ce qui a été payé sur la ligne (remise et prix balance compris).
        const amount = Math.round((line.total_ttc * l.qty) / line.qty);
        return { line, qty: l.qty, amount };
      });
    if (returned.length === 0) throw new AppError('Aucun article retourné', 'EMPTY');
    if (input.refundMethod === 'CUSTOMER_CREDIT' && !original.customer_id) {
      throw new AppError('Ce ticket n’a pas de client : remboursez en espèces ou par un autre moyen', 'INVALID');
    }

    return this.tx(() => {
      const id = newId();
      const number = this.nextTicketNumber(ctx);
      const total = returned.reduce((s, r) => s + r.amount, 0);
      const byRate = new Map<number, number>();
      for (const r of returned) byRate.set(r.line.vat_rate_bp, (byRate.get(r.line.vat_rate_bp) ?? 0) + r.amount);
      const ht = [...byRate.entries()].reduce((s, [rate, ttc]) => s + splitTtc(ttc, rate).ht, 0);
      this.db
        .prepare(
          `INSERT INTO sales (id, number, kind, store_id, register_id, session_id, user_id, status, total_ttc, total_ht, total_tva,
             total_discount, change_given, original_sale_id, cancel_reason, customer_id, created_at)
           VALUES (?, ?, 'return', ?, ?, ?, ?, 'completed', ?, ?, ?, 0, 0, ?, ?, ?, ?)`,
        )
        .run(id, number, ctx.storeId, ctx.registerId, session.id, ctx.userId, -total, -ht, -(total - ht), original.id, input.reason.trim(), original.customer_id, this.now());
      const insertLine = this.db.prepare(
        `INSERT INTO sale_lines (id, sale_id, line_no, article_id, label, barcode, qty, unit_price, discount, vat_rate_bp, total_ttc, unit_cost)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 0)`,
      );
      for (const r of returned) {
        insertLine.run(newId(), id, r.line.line_no, r.line.article_id, r.line.label, r.line.barcode, -r.qty, r.line.unit_price, r.line.vat_rate_bp, -r.amount);
      }
      this.db.prepare('INSERT INTO sale_payments (id, sale_id, method, amount, reference) VALUES (?, ?, ?, ?, NULL)').run(newId(), id, input.refundMethod, -total);
      const qtyByArticle = new Map<string, Milli>();
      for (const r of returned) qtyByArticle.set(r.line.article_id, (qtyByArticle.get(r.line.article_id) ?? 0) + r.qty);
      this.restockSaleMovements(ctx, original.id, 'sale_return', id, qtyByArticle);
      this.audit(input.supervisorId, 'sale.return', 'sale', id, { original: original.number, total, reason: input.reason, cashier: ctx.userId });
      const sale = this.getSale(id);
      this.enqueue(ctx, 'sale', id, 'upsert', sale);
      return sale;
    });
  }

  // --- Tickets en attente ---------------------------------------------------

  holdTicket(ctx: Context, label: string, lines: SaleLineInput[]): { id: string } {
    const id = newId();
    this.db
      .prepare('INSERT INTO held_tickets (id, register_id, user_id, label, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, this.requireRegister(ctx), ctx.userId, label.trim() || 'Ticket en attente', JSON.stringify(lines), this.now());
    return { id };
  }

  listHeld(registerId: string): { id: string; label: string; created_at: string; line_count: number }[] {
    return (
      this.db.prepare('SELECT id, label, payload, created_at FROM held_tickets WHERE register_id = ? ORDER BY created_at').all(registerId) as {
        id: string;
        label: string;
        payload: string;
        created_at: string;
      }[]
    ).map((h) => ({ id: h.id, label: h.label, created_at: h.created_at, line_count: (JSON.parse(h.payload) as unknown[]).length }));
  }

  resumeHeld(id: string): SaleLineInput[] {
    const row = this.db.prepare('SELECT payload FROM held_tickets WHERE id = ?').get(id) as { payload: string } | undefined;
    if (!row) throw new AppError('Ticket en attente introuvable', 'NOT_FOUND');
    this.db.prepare('DELETE FROM held_tickets WHERE id = ?').run(id);
    return JSON.parse(row.payload) as SaleLineInput[];
  }

  // --- Clôture --------------------------------------------------------------

  zReport(sessionId: string): ZReport {
    const session = this.getSession(sessionId);
    const store = this.admin.getStore(session.store_id);
    const register = this.admin.getRegister(session.register_id);
    const agg = this.db
      .prepare(
        `SELECT
           COALESCE(SUM(CASE WHEN kind = 'sale' AND status = 'completed' THEN 1 END), 0) AS ticketCount,
           COALESCE(SUM(CASE WHEN kind = 'sale' AND status = 'completed' THEN total_ttc END), 0) AS salesTtc,
           COALESCE(SUM(CASE WHEN kind = 'return' AND status = 'completed' THEN total_ttc END), 0) AS returnsTtc,
           COALESCE(SUM(CASE WHEN status = 'completed' THEN total_discount END), 0) AS discounts,
           COALESCE(SUM(CASE WHEN status = 'cancelled' THEN 1 END), 0) AS cancelledCount,
           COALESCE(SUM(CASE WHEN status = 'cancelled' THEN total_ttc END), 0) AS cancelledAmount,
           COALESCE(SUM(CASE WHEN status = 'completed' THEN change_given END), 0) AS changeGiven
         FROM sales WHERE session_id = ?`,
      )
      .get(sessionId) as {
      ticketCount: number;
      salesTtc: number;
      returnsTtc: number;
      discounts: number;
      cancelledCount: number;
      cancelledAmount: number;
      changeGiven: number;
    };
    const methods = this.db
      .prepare(
        `SELECT p.method, SUM(CASE WHEN p.amount > 0 THEN p.amount ELSE 0 END) AS received, SUM(CASE WHEN p.amount < 0 THEN -p.amount ELSE 0 END) AS refunded
         FROM sale_payments p JOIN sales s ON s.id = p.sale_id
         WHERE s.session_id = ? AND s.status = 'completed' GROUP BY p.method`,
      )
      .all(sessionId) as { method: PaymentMethod; received: number; refunded: number }[];
    const cashRow = methods.find((m) => m.method === 'CASH');
    const cashSales = (cashRow?.received ?? 0) - agg.changeGiven;
    const cashRefunds = cashRow?.refunded ?? 0;
    const byMethod = methods
      .map((m) => ({
        method: m.method,
        label: PAYMENT_METHODS[m.method],
        amount: m.method === 'CASH' ? cashSales - cashRefunds : m.received - m.refunded,
      }))
      .sort((a, b) => b.amount - a.amount);
    const vatRows = this.db
      .prepare(
        `SELECT l.vat_rate_bp AS rate, SUM(l.total_ttc) AS ttc FROM sale_lines l JOIN sales s ON s.id = l.sale_id
         WHERE s.session_id = ? AND s.status = 'completed' GROUP BY l.vat_rate_bp ORDER BY l.vat_rate_bp DESC`,
      )
      .all(sessionId) as { rate: number; ttc: number }[];
    const vat = vatRows.map((v) => ({ rate: v.rate, ttc: v.ttc, ...splitTtc(v.ttc, v.rate) }));
    const cashOperations = this.db
      .prepare('SELECT type, amount, reason, at FROM cash_operations WHERE session_id = ? ORDER BY at')
      .all(sessionId) as ZReport['cashOperations'];
    const cashIn = cashOperations.filter((o) => o.type === 'IN').reduce((s, o) => s + o.amount, 0);
    const cashOut = cashOperations.filter((o) => o.type === 'OUT').reduce((s, o) => s + o.amount, 0);
    const customerReceipts = this.customers.sessionReceipts(sessionId);
    const receiptsCash = customerReceipts.find((r) => r.method === 'CASH')?.amount ?? 0;
    const expenses = this.db
      .prepare("SELECT number, label, amount FROM expenses WHERE session_id = ? AND status = 'active' ORDER BY created_at")
      .all(sessionId) as ZReport['expenses'];
    const cash = {
      openingFloat: session.opening_float,
      cashSales,
      cashRefunds,
      cashIn,
      cashOut,
      customerReceipts: receiptsCash,
      expenses: expenses.reduce((t, e) => t + e.amount, 0),
    };
    const { expected } = closingDifference(cash, {});
    return {
      session,
      storeName: store.name,
      registerName: register.name,
      ticketCount: agg.ticketCount,
      salesTtc: agg.salesTtc,
      returnsTtc: agg.returnsTtc,
      netTtc: agg.salesTtc + agg.returnsTtc,
      discounts: agg.discounts,
      cancelled: { count: agg.cancelledCount, amount: agg.cancelledAmount },
      byMethod,
      vat,
      cashOperations,
      customerReceipts,
      expenses,
      cash: { ...cash, expected },
      counted: session.counted_cash,
      difference: session.difference,
    };
  }

  /** Clôture Z : comptage par coupure, écart affiché, session fermée. */
  closeSession(ctx: Context, counted: DenominationCount): ZReport {
    const session = this.requireOpenSession(ctx);
    const before = this.zReport(session.id);
    const result = closingDifference(before.cash, counted);
    this.tx(() => {
      const zNumber = this.nextCounter(`z:${session.register_id}`);
      this.db
        .prepare(
          `UPDATE cash_sessions SET status = 'closed', closed_at = ?, closed_by = ?, counted_detail = ?, expected_cash = ?,
             counted_cash = ?, difference = ?, z_number = ? WHERE id = ?`,
        )
        .run(this.now(), ctx.userId, JSON.stringify(counted), result.expected, result.counted, result.difference, zNumber, session.id);
      this.db.prepare('DELETE FROM held_tickets WHERE register_id = ?').run(session.register_id);
      this.enqueue(ctx, 'cash_session', session.id, 'upsert', this.getSession(session.id));
      this.audit(ctx.userId, 'cash.close', 'cash_session', session.id, { zNumber, ...result });
    });
    return this.zReport(session.id);
  }

  listSessions(storeId: string, limit = 60): CashSession[] {
    return this.db
      .prepare(
        `SELECT s.*, u.name AS user_name FROM cash_sessions s JOIN users u ON u.id = s.user_id
         WHERE s.store_id = ? ORDER BY s.opened_at DESC LIMIT ?`,
      )
      .all(storeId, limit) as CashSession[];
  }
}
