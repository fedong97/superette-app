import {
  AGING_LABELS,
  type AgingBucket,
  type Fcfa,
  type PriceLevel,
  PRICE_LEVELS,
  agingBucket,
  allocateOldestFirst,
  creditCheck,
  daysLate,
  dueDate,
  formatFcfa,
} from '@superette/core';
import { AppError, Base, type Context, newId } from './util';

export interface Customer {
  id: string;
  code: string;
  name: string;
  contact: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  taxpayer_number: string | null;
  credit_limit: Fcfa;
  payment_terms_days: number;
  notes: string | null;
  active: number;
  /** Tarif du client : détail, gros ou super gros. */
  price_level: PriceLevel;
  created_at: string;
  updated_at: string;
}

export interface CustomerInput {
  name: string;
  contact?: string | null;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  taxpayerNumber?: string | null;
  creditLimit?: Fcfa;
  paymentTermsDays?: number;
  notes?: string | null;
  active?: boolean;
  priceLevel?: PriceLevel;
}

export const CUSTOMER_PAYMENT_METHODS = {
  CASH: 'Espèces',
  MTN_MOMO: 'MTN Mobile Money',
  ORANGE_MONEY: 'Orange Money',
  BANK_TRANSFER: 'Virement',
  CHEQUE: 'Chèque',
  CARD: 'Carte bancaire',
} as const;
export type CustomerPaymentMethod = keyof typeof CUSTOMER_PAYMENT_METHODS;

/** Vente à crédit encore due, après lettrage des règlements. */
export interface OpenItem {
  id: string;
  number: string;
  created_at: string;
  due_date: string;
  amount: Fcfa;
  remaining: Fcfa;
  days_late: number;
  bucket: AgingBucket;
}

export interface CustomerAccount {
  customer: Customer;
  balance: Fcfa;
  available: Fcfa;
  overdue: Fcfa;
  openItems: OpenItem[];
}

export interface StatementLine {
  date: string;
  kind: 'sale' | 'return' | 'payment' | 'rebate';
  ref_id: string;
  number: string;
  label: string;
  debit: Fcfa;
  credit: Fcfa;
  balance: Fcfa;
}

export interface CustomerPayment {
  id: string;
  number: string;
  customer_id: string;
  customer_name: string;
  store_id: string;
  session_id: string | null;
  method: CustomerPaymentMethod;
  amount: Fcfa;
  reference: string | null;
  notes: string | null;
  paid_at: string;
  user_name: string | null;
}

/**
 * Clients et ventes à crédit : fiches, plafond, compte par magasin, lettrage
 * automatique des règlements sur les ventes les plus anciennes, balance âgée.
 * Rien n'est stocké comme « payé » : tout se recalcule, donc deux caisses qui
 * encaissent hors ligne le même client finissent avec le même compte.
 */
export class CustomerService extends Base {
  private number(prefix: string, counter: string): string {
    return `${prefix}-${this.stationPrefix()}-${String(this.nextCounter(counter)).padStart(5, '0')}`;
  }

  // --- Fiches -----------------------------------------------------------------

  listCustomers(
    storeId: string,
    opts: { search?: string; includeInactive?: boolean; withBalance?: boolean } = {},
  ): (Customer & { balance: Fcfa; overdue: Fcfa; last_sale: string | null })[] {
    const rows = this.db
      .prepare(
        `SELECT c.*, (SELECT MAX(s.created_at) FROM sales s WHERE s.customer_id = c.id AND s.store_id = @storeId) AS last_sale
         FROM customers c
         WHERE (@all = 1 OR c.active = 1)
           AND (@search IS NULL OR c.name LIKE @search OR c.code LIKE @search OR c.phone LIKE @search)
         ORDER BY c.name`,
      )
      .all({ storeId, all: opts.includeInactive ? 1 : 0, search: opts.search?.trim() ? `%${opts.search.trim()}%` : null }) as (Customer & {
      last_sale: string | null;
    })[];
    const result = rows.map((c) => {
      const { balance, openItems } = this.ledger(storeId, c.id);
      return { ...c, balance, overdue: openItems.filter((i) => i.days_late > 0).reduce((t, i) => t + i.remaining, 0) };
    });
    return opts.withBalance ? result.filter((c) => c.balance !== 0) : result;
  }

  getCustomer(id: string): Customer {
    const row = this.db.prepare('SELECT * FROM customers WHERE id = ?').get(id) as Customer | undefined;
    if (!row) throw new AppError('Client introuvable', 'NOT_FOUND');
    return row;
  }

  saveCustomer(userId: string, input: CustomerInput, id?: string): Customer {
    const name = input.name.trim();
    if (!name) throw new AppError('Le nom du client est obligatoire', 'INVALID');
    const terms = input.paymentTermsDays ?? 30;
    const limit = input.creditLimit ?? 0;
    if (!Number.isInteger(terms) || terms < 0) throw new AppError('Délai de paiement invalide', 'INVALID');
    if (!Number.isSafeInteger(limit) || limit < 0) throw new AppError('Plafond de crédit invalide', 'INVALID');
    const now = this.now();
    const values = {
      name,
      contact: input.contact?.trim() || null,
      phone: input.phone?.trim() || null,
      email: input.email?.trim() || null,
      address: input.address?.trim() || null,
      taxpayer_number: input.taxpayerNumber?.trim() || null,
      credit_limit: limit,
      payment_terms_days: terms,
      notes: input.notes?.trim() || null,
      active: input.active === false ? 0 : 1,
      price_level: input.priceLevel ?? (id ? this.getCustomer(id).price_level : 'retail'),
      updated_at: now,
    };
    if (!(values.price_level in PRICE_LEVELS)) throw new AppError('Tarif inconnu', 'INVALID');
    return this.tx(() => {
      let customerId = id;
      if (customerId) {
        const before = this.getCustomer(customerId);
        this.db
          .prepare(
            `UPDATE customers SET name = @name, contact = @contact, phone = @phone, email = @email, address = @address,
               taxpayer_number = @taxpayer_number, credit_limit = @credit_limit, payment_terms_days = @payment_terms_days,
               notes = @notes, active = @active, price_level = @price_level, updated_at = @updated_at WHERE id = @id`,
          )
          .run({ ...values, id: customerId });
        if (before.credit_limit !== limit) this.audit(userId, 'customer.credit_limit', 'customer', customerId, { from: before.credit_limit, to: limit });
      } else {
        customerId = newId();
        this.db
          .prepare(
            `INSERT INTO customers (id, code, name, contact, phone, email, address, taxpayer_number, credit_limit, payment_terms_days,
               notes, active, price_level, created_at, updated_at)
             VALUES (@id, @code, @name, @contact, @phone, @email, @address, @taxpayer_number, @credit_limit, @payment_terms_days,
               @notes, @active, @price_level, @created_at, @updated_at)`,
          )
          .run({ ...values, id: customerId, code: this.number('CLI', 'customer.code'), created_at: now });
      }
      this.enqueue(null, 'customer', customerId, 'upsert', {});
      this.audit(userId, id ? 'customer.update' : 'customer.create', 'customer', customerId, { name });
      return this.getCustomer(customerId);
    });
  }

  // --- Compte -----------------------------------------------------------------

  /** Ventes à crédit (débit) et ce qui vient en déduction (retours au compte, règlements). */
  private ledger(storeId: string, customerId: string): { balance: Fcfa; openItems: OpenItem[] } {
    const debits = this.db
      .prepare(
        `SELECT s.id, s.number, s.created_at, s.due_date, SUM(p.amount) AS amount
         FROM sales s JOIN sale_payments p ON p.sale_id = s.id
         WHERE s.store_id = ? AND s.customer_id = ? AND s.status = 'completed' AND s.kind = 'sale' AND p.method = 'CUSTOMER_CREDIT'
         GROUP BY s.id ORDER BY s.created_at, s.number`,
      )
      .all(storeId, customerId) as { id: string; number: string; created_at: string; due_date: string | null; amount: number }[];
    const returned = this.db
      .prepare(
        `SELECT COALESCE(-SUM(p.amount), 0) FROM sales s JOIN sale_payments p ON p.sale_id = s.id
         WHERE s.store_id = ? AND s.customer_id = ? AND s.status = 'completed' AND s.kind = 'return' AND p.method = 'CUSTOMER_CREDIT'`,
      )
      .pluck()
      .get(storeId, customerId) as number;
    const paid = this.db
      .prepare(
        `SELECT (SELECT COALESCE(SUM(amount), 0) FROM customer_payments WHERE store_id = @s AND customer_id = @c)
              + (SELECT COALESCE(SUM(amount), 0) FROM rebate_entries WHERE store_id = @s AND customer_id = @c AND kind = 'credit')`,
      )
      .pluck()
      .get({ s: storeId, c: customerId }) as number;
    const total = debits.reduce((t, d) => t + d.amount, 0);
    const today = this.today();
    const openItems = allocateOldestFirst(debits, returned + paid)
      .filter((d) => d.remaining > 0)
      .map((d) => {
        const due = d.due_date ?? d.created_at.slice(0, 10);
        return { ...d, due_date: due, days_late: daysLate(due, today), bucket: agingBucket(due, today) };
      });
    return { balance: total - returned - paid, openItems };
  }

  account(storeId: string, customerId: string): CustomerAccount {
    const customer = this.getCustomer(customerId);
    const { balance, openItems } = this.ledger(storeId, customerId);
    return {
      customer,
      balance,
      available: Math.max(0, customer.credit_limit - balance),
      overdue: openItems.filter((i) => i.days_late > 0).reduce((t, i) => t + i.remaining, 0),
      openItems,
    };
  }

  /**
   * Vérifie qu'une vente à crédit est possible. Au-delà du plafond, il faut
   * l'accord d'un gérant (authorizedBy), tracé dans le journal d'audit.
   */
  assertCredit(storeId: string, customerId: string, amount: Fcfa, authorizedBy: { id: string; role: string } | null): Customer {
    const customer = this.getCustomer(customerId);
    if (!customer.active) throw new AppError(`Le client ${customer.name} est désactivé`, 'INVALID');
    const { balance } = this.ledger(storeId, customerId);
    const check = creditCheck(balance, customer.credit_limit, amount);
    if (!check.allowed) {
      const manager = authorizedBy && (authorizedBy.role === 'admin' || authorizedBy.role === 'manager');
      if (!manager) {
        throw new AppError(
          customer.credit_limit === 0
            ? `${customer.name} n'a pas de plafond de crédit : accord du gérant nécessaire`
            : `Plafond de crédit dépassé de ${formatFcfa(check.over)} pour ${customer.name} : accord du gérant nécessaire`,
          'CREDIT_LIMIT',
        );
      }
      this.audit(authorizedBy.id, 'customer.credit_override', 'customer', customerId, { balance, limit: customer.credit_limit, amount });
    }
    return customer;
  }

  /** Échéance d'une vente à crédit faite aujourd'hui pour ce client. */
  dueDateFor(customer: Customer): string {
    return dueDate(this.today(), customer.payment_terms_days);
  }

  /** Relevé de compte : mouvements avec solde progressif, solde d'ouverture avant `from`. */
  statement(storeId: string, customerId: string, opts: { from?: string; to?: string } = {}): { opening: Fcfa; lines: StatementLine[]; closing: Fcfa } {
    const rows = this.db
      .prepare(
        `SELECT s.created_at AS date, s.kind, s.id AS ref_id, s.number, SUM(p.amount) AS amount
         FROM sales s JOIN sale_payments p ON p.sale_id = s.id
         WHERE s.store_id = @storeId AND s.customer_id = @customerId AND s.status = 'completed' AND p.method = 'CUSTOMER_CREDIT'
         GROUP BY s.id
         UNION ALL
         SELECT paid_at, 'payment', id, number, -amount FROM customer_payments WHERE store_id = @storeId AND customer_id = @customerId
         UNION ALL
         SELECT at, 'rebate', id, number, -amount FROM rebate_entries WHERE store_id = @storeId AND customer_id = @customerId AND kind = 'credit'
         ORDER BY 1, 4`,
      )
      .all({ storeId, customerId }) as { date: string; kind: StatementLine['kind']; ref_id: string; number: string; amount: number }[];
    const inRange = (d: string) => (!opts.from || d.slice(0, 10) >= opts.from) && (!opts.to || d.slice(0, 10) <= opts.to);
    const methods = new Map(
      (this.db.prepare('SELECT id, method, reference FROM customer_payments WHERE customer_id = ?').all(customerId) as { id: string; method: string; reference: string | null }[]).map(
        (p) => [p.id, p],
      ),
    );
    let opening = 0;
    let running = 0;
    const lines: StatementLine[] = [];
    for (const r of rows) {
      if (opts.from && r.date.slice(0, 10) < opts.from) {
        opening += r.amount;
        running = opening;
        continue;
      }
      if (!inRange(r.date)) continue;
      running += r.amount;
      const pay = methods.get(r.ref_id);
      const label =
        r.kind === 'sale'
          ? 'Vente à crédit'
          : r.kind === 'return'
            ? 'Retour de marchandise'
            : r.kind === 'rebate'
              ? 'Ristourne accordée en avoir'
            : `Règlement ${CUSTOMER_PAYMENT_METHODS[pay?.method as CustomerPaymentMethod] ?? ''}${pay?.reference ? ` (${pay.reference})` : ''}`;
      lines.push({ date: r.date, kind: r.kind, ref_id: r.ref_id, number: r.number, label, debit: Math.max(0, r.amount), credit: Math.max(0, -r.amount), balance: running });
    }
    return { opening, lines, closing: running };
  }

  // --- Règlements -------------------------------------------------------------

  /**
   * Règlement d'un client. Encaissé à une caisse dont la session est ouverte,
   * il est rattaché à la session : les espèces entrent dans le tiroir et le Z.
   */
  receivePayment(
    ctx: Context,
    input: { customerId: string; method: CustomerPaymentMethod; amount: Fcfa; reference?: string | null; notes?: string | null; sessionId?: string | null },
  ): CustomerPayment {
    if (!(input.method in CUSTOMER_PAYMENT_METHODS)) throw new AppError(`Mode de règlement inconnu : ${input.method}`, 'INVALID');
    if (!Number.isSafeInteger(input.amount) || input.amount <= 0) throw new AppError('Montant invalide', 'INVALID');
    if (input.method !== 'CASH' && !input.reference?.trim()) {
      throw new AppError(`Référence obligatoire pour un règlement par ${CUSTOMER_PAYMENT_METHODS[input.method]}`, 'REFERENCE_REQUIRED');
    }
    const { balance } = this.ledger(ctx.storeId, input.customerId);
    if (input.amount > balance) {
      throw new AppError(`Le montant dépasse ce que doit le client (${formatFcfa(balance)})`, 'INVALID');
    }
    return this.tx(() => {
      const id = newId();
      this.db
        .prepare(
          `INSERT INTO customer_payments (id, number, customer_id, store_id, register_id, session_id, method, amount, reference, notes, paid_at, user_id, from_central)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          this.number('RC', 'customer_payment'),
          input.customerId,
          ctx.storeId,
          input.sessionId ? ctx.registerId : null,
          input.sessionId ?? null,
          input.method,
          input.amount,
          input.reference?.trim() || null,
          input.notes?.trim() || null,
          this.now(),
          ctx.userId,
          // Espèces reçues au bureau : elles entrent dans la caisse centrale.
          input.method === 'CASH' && !input.sessionId ? 1 : 0,
        );
      this.enqueue(ctx, 'customer_payment', id, 'upsert', {});
      this.audit(ctx.userId, 'customer.payment', 'customer', input.customerId, { amount: input.amount, method: input.method });
      return this.getPayment(id);
    });
  }

  getPayment(id: string): CustomerPayment {
    const row = this.paymentQuery('p.id = ?').get(id) as CustomerPayment | undefined;
    if (!row) throw new AppError('Règlement introuvable', 'NOT_FOUND');
    return row;
  }

  listPayments(storeId: string, opts: { customerId?: string; sessionId?: string; limit?: number } = {}): CustomerPayment[] {
    return this.paymentQuery('p.store_id = @storeId AND (@customerId IS NULL OR p.customer_id = @customerId) AND (@sessionId IS NULL OR p.session_id = @sessionId)', opts.limit ?? 200).all({
      storeId,
      customerId: opts.customerId ?? null,
      sessionId: opts.sessionId ?? null,
    }) as CustomerPayment[];
  }

  private paymentQuery(where: string, limit = 1) {
    return this.db.prepare(
      `SELECT p.id, p.number, p.customer_id, c.name AS customer_name, p.store_id, p.session_id, p.method, p.amount, p.reference, p.notes,
              p.paid_at, u.name AS user_name
       FROM customer_payments p JOIN customers c ON c.id = p.customer_id LEFT JOIN users u ON u.id = p.user_id
       WHERE ${where} ORDER BY p.paid_at DESC LIMIT ${limit}`,
    );
  }

  /** Règlements clients reçus pendant une session de caisse, par mode (pour le Z). */
  sessionReceipts(sessionId: string): { method: CustomerPaymentMethod; label: string; amount: Fcfa }[] {
    return (
      this.db.prepare('SELECT method, SUM(amount) AS amount FROM customer_payments WHERE session_id = ? GROUP BY method ORDER BY 2 DESC').all(sessionId) as {
        method: CustomerPaymentMethod;
        amount: number;
      }[]
    ).map((r) => ({ ...r, label: CUSTOMER_PAYMENT_METHODS[r.method] ?? r.method }));
  }

  // --- Créances ---------------------------------------------------------------

  /** Balance âgée du magasin : ce que doivent les clients, par ancienneté du retard. */
  receivables(storeId: string): {
    customers: { id: string; code: string; name: string; phone: string | null; credit_limit: Fcfa; balance: Fcfa; buckets: Record<AgingBucket, Fcfa> }[];
    totals: Record<AgingBucket, Fcfa> & { balance: Fcfa };
    labels: typeof AGING_LABELS;
  } {
    const ids = this.db
      .prepare(
        `SELECT DISTINCT customer_id FROM sales WHERE store_id = ? AND customer_id IS NOT NULL
         UNION SELECT customer_id FROM customer_payments WHERE store_id = ?`,
      )
      .pluck()
      .all(storeId, storeId) as string[];
    const empty = (): Record<AgingBucket, Fcfa> => ({ current: 0, d30: 0, d60: 0, d90: 0, older: 0 });
    const totals = { ...empty(), balance: 0 };
    const customers = ids
      .map((id) => {
        const c = this.getCustomer(id);
        const { balance, openItems } = this.ledger(storeId, id);
        const buckets = empty();
        for (const i of openItems) buckets[i.bucket] += i.remaining;
        return { id, code: c.code, name: c.name, phone: c.phone, credit_limit: c.credit_limit, balance, buckets };
      })
      .filter((c) => c.balance !== 0)
      .sort((a, b) => b.balance - a.balance);
    for (const c of customers) {
      totals.balance += c.balance;
      for (const k of Object.keys(c.buckets) as AgingBucket[]) totals[k] += c.buckets[k];
    }
    return { customers, totals, labels: AGING_LABELS };
  }
}

