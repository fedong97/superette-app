import { type Fcfa, formatFcfa } from '@superette/core';
import type { CustomerService } from './customers';
import type { PurchaseService, SupplierInvoice } from './purchases';
import { AppError, Base, type Clock, type Context, newId } from './util';
import type { Db } from './database';

export interface AccountOffset {
  id: string;
  number: string;
  store_id: string;
  customer_id: string;
  customer_name: string;
  supplier_id: string;
  supplier_name: string;
  invoice_id: string;
  invoice_number: string;
  supplier_number: string;
  amount: Fcfa;
  offset_date: string;
  notes: string | null;
  status: 'active' | 'cancelled';
  user_name: string | null;
  created_at: string;
}

/**
 * Compensation entre le compte client et le compte fournisseur d'un même tiers
 * (un grossiste à qui l'on achète et qui nous achète) : ce qu'il nous doit est
 * soldé par ce qu'on lui doit, sans mouvement d'argent. Une pièce CP- est
 * imputée à une facture fournisseur et vient en règlement côté client ;
 * l'écriture passe en OD (401 au débit, 411 au crédit).
 */
export class OffsetService extends Base {
  constructor(
    db: Db,
    clock: Clock,
    private readonly customers: CustomerService,
    private readonly purchases: PurchaseService,
  ) {
    super(db, clock);
  }

  /** Ce qui peut se compenser pour ce client : son solde, son fournisseur lié et les factures de celui-ci encore dues. */
  candidates(storeId: string, customerId: string): { customerBalance: Fcfa; supplier: { id: string; name: string } | null; supplierBalance: Fcfa; invoices: SupplierInvoice[]; max: Fcfa } {
    const customer = this.customers.getCustomer(customerId);
    const customerBalance = this.customers.account(storeId, customerId).balance;
    if (!customer.supplier_id) return { customerBalance, supplier: null, supplierBalance: 0, invoices: [], max: 0 };
    const supplier = this.purchases.getSupplier(customer.supplier_id);
    const invoices = this.purchases.listInvoices(storeId, { supplierId: supplier.id, unpaid: true }).filter((i) => i.kind === 'invoice');
    const supplierBalance = invoices.reduce((t, i) => t + i.balance, 0);
    return { customerBalance, supplier: { id: supplier.id, name: supplier.name }, supplierBalance, invoices, max: Math.max(0, Math.min(customerBalance, supplierBalance)) };
  }

  create(ctx: Context, input: { customerId: string; invoiceId: string; amount: Fcfa; date?: string | null; notes?: string | null }): AccountOffset {
    const customer = this.customers.getCustomer(input.customerId);
    if (!customer.supplier_id) throw new AppError(`${customer.name} n'est relié à aucune fiche fournisseur : reliez-les d'abord sur sa fiche client`, 'INVALID');
    const invoice = this.purchases.getInvoice(input.invoiceId);
    if (invoice.supplier_id !== customer.supplier_id) throw new AppError("Cette facture n'est pas du fournisseur relié à ce client", 'INVALID');
    if (invoice.store_id !== ctx.storeId) throw new AppError("Cette facture est d'un autre magasin", 'FORBIDDEN');
    if (invoice.kind !== 'invoice') throw new AppError('Un avoir fournisseur ne se compense pas', 'INVALID');
    if (!Number.isSafeInteger(input.amount) || input.amount <= 0) throw new AppError('Montant invalide', 'INVALID');
    if (input.amount > invoice.balance) throw new AppError(`Le montant dépasse le reste dû sur cette facture (${formatFcfa(invoice.balance)})`, 'INVALID');
    const owed = this.customers.account(ctx.storeId, customer.id).balance;
    if (input.amount > owed) throw new AppError(`Le montant dépasse ce que doit le client (${formatFcfa(Math.max(0, owed))})`, 'INVALID');
    const date = input.date?.trim() || this.today();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new AppError('Date invalide', 'INVALID');
    this.assertPeriodOpen(ctx.storeId, date);
    return this.tx(() => {
      const id = newId();
      const now = this.now();
      const number = `CP-${this.stationPrefix()}-${String(this.nextCounter('account_offset.number')).padStart(5, '0')}`;
      this.db
        .prepare(
          `INSERT INTO account_offsets (id, number, store_id, customer_id, supplier_id, invoice_id, amount, offset_date, notes, status, user_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
        )
        .run(id, number, ctx.storeId, customer.id, invoice.supplier_id, invoice.id, input.amount, date, input.notes?.trim() || null, ctx.userId, now, now);
      this.enqueue(ctx, 'account_offset', id, 'upsert', {});
      this.audit(ctx.userId, 'offset.create', 'account_offset', id, { number, customer: customer.name, invoice: invoice.number, amount: input.amount });
      return this.get(id);
    });
  }

  /** Annule une compensation (erreur de saisie) : le client redoit, la facture fournisseur aussi. */
  cancel(ctx: Context, id: string, reason: string): AccountOffset {
    const o = this.get(id);
    if (o.store_id !== ctx.storeId) throw new AppError("Cette compensation est d'un autre magasin", 'FORBIDDEN');
    if (o.status === 'cancelled') return o;
    if (!reason.trim()) throw new AppError("Indiquez le motif de l'annulation", 'REASON_REQUIRED');
    this.assertPeriodOpen(ctx.storeId, o.offset_date);
    return this.tx(() => {
      this.db.prepare("UPDATE account_offsets SET status = 'cancelled', notes = ?, updated_at = ? WHERE id = ?").run(`${o.notes ? `${o.notes} · ` : ''}Annulée : ${reason.trim()}`, this.now(), id);
      this.enqueue(ctx, 'account_offset', id, 'upsert', {});
      this.audit(ctx.userId, 'offset.cancel', 'account_offset', id, { number: o.number, reason: reason.trim() });
      return this.get(id);
    });
  }

  get(id: string): AccountOffset {
    const row = this.query('o.id = @id').get({ id }) as AccountOffset | undefined;
    if (!row) throw new AppError('Compensation introuvable', 'NOT_FOUND');
    return row;
  }

  list(storeId: string, opts: { customerId?: string | null } = {}): AccountOffset[] {
    return this.query('o.store_id = @storeId AND (@customerId IS NULL OR o.customer_id = @customerId)').all({ storeId, customerId: opts.customerId ?? null }) as AccountOffset[];
  }

  private query(where: string) {
    return this.db.prepare(
      `SELECT o.id, o.number, o.store_id, o.customer_id, c.name AS customer_name, o.supplier_id, s.name AS supplier_name, o.invoice_id,
              i.number AS invoice_number, i.supplier_number, o.amount, o.offset_date, o.notes, o.status, u.name AS user_name, o.created_at
       FROM account_offsets o JOIN customers c ON c.id = o.customer_id JOIN suppliers s ON s.id = o.supplier_id
       JOIN supplier_invoices i ON i.id = o.invoice_id LEFT JOIN users u ON u.id = o.user_id
       WHERE ${where} ORDER BY o.offset_date DESC, o.number DESC LIMIT 500`,
    );
  }
}
