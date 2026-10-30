import {
  AGING_LABELS,
  type AgingBucket,
  type ArticlePrices,
  type DocLang,
  DOC_LANGS,
  type Fcfa,
  type FamilyDiscounts,
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
  /** Langue de ses tickets, factures et relevés. */
  language: DocLang;
  /** Remises convenues par famille d'articles (JSON : {"<famille>": 300} = 3 %). */
  family_discounts: string | null;
  /** Interdit de chèque (chèque revenu impayé) : la caisse refuse ses chèques. */
  no_cheque: number;
  /** Prix négociés par article (JSON : {"<article>": 450}), prix TTC de l'unité de détail. */
  article_prices: string | null;
  /** Zone ou tournée (quartier, ligne de livraison). */
  zone: string | null;
  /** Fiche fournisseur du même tiers : ses dettes et créances se compensent. */
  supplier_id: string | null;
  /** Commercial de terrain qui suit ce client : ses ventes lui sont attribuées. */
  field_rep_id: string | null;
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
  language?: DocLang;
  /** Remises par famille (points de base) ; absent = inchangées. */
  familyDiscounts?: FamilyDiscounts;
  /** Interdit de chèque ; absent = inchangé. */
  noCheque?: boolean;
  /** Prix négociés par article ; absent = inchangés. */
  articlePrices?: ArticlePrices;
  zone?: string | null;
  /** Fournisseur du même tiers ; absent = inchangé. */
  supplierId?: string | null;
  /** Commercial de terrain qui suit le client ; absent = inchangé. */
  fieldRepId?: string | null;
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

export interface CustomerReminder {
  customer_id: string;
  at: string;
  channel: 'whatsapp' | 'pdf';
  balance: Fcfa;
  overdue: Fcfa;
  user_name: string | null;
  /** Nombre de relances envoyées à ce client. */
  count: number;
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
  kind: 'sale' | 'return' | 'payment' | 'rebate' | 'refund' | 'opening' | 'rejected' | 'offset' | 'change';
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
  /** Dépôt d'avance : versé sans dette à régler, ses achats à crédit viennent en déduction. */
  advance: number;
}

/**
 * Clients et ventes à crédit : fiches, plafond, compte par magasin, lettrage
 * automatique des règlements sur les ventes les plus anciennes, balance âgée.
 * Rien n'est stocké comme « payé » : tout se recalcule, donc deux caisses qui
 * encaissent hors ligne le même client finissent avec le même compte.
 */
/** Libellé d'une pièce de solde : reprise, solde d'ouverture saisi sur la fiche, ou ajustement. */
function openingLabel(o: { doc_ref: string | null; kind: string; label: string | null } | undefined): string {
  if (o?.kind === 'adjustment') return `Ajustement de solde${o.label ? ` : ${o.label}` : ''}`;
  if (o?.label) return `Solde d'ouverture (${o.label})`;
  return `Solde repris${o?.doc_ref ? ` (pièce ${o.doc_ref})` : ''}`;
}

export class CustomerService extends Base {
  private number(prefix: string, counter: string): string {
    return `${prefix}-${this.stationPrefix()}-${String(this.nextCounter(counter)).padStart(5, '0')}`;
  }

  // --- Fiches -----------------------------------------------------------------

  listCustomers(
    storeId: string,
    opts: { search?: string; includeInactive?: boolean; withBalance?: boolean; zone?: string | null } = {},
  ): (Customer & { balance: Fcfa; overdue: Fcfa; last_sale: string | null })[] {
    const rows = this.db
      .prepare(
        `SELECT c.*, (SELECT MAX(s.created_at) FROM sales s WHERE s.customer_id = c.id AND s.store_id = @storeId) AS last_sale
         FROM customers c
         WHERE (@all = 1 OR c.active = 1)
           AND (@search IS NULL OR c.name LIKE @search OR c.code LIKE @search OR c.phone LIKE @search OR c.zone LIKE @search)
           AND (@zone IS NULL OR COALESCE(c.zone, '') = @zone)
         ORDER BY c.name`,
      )
      .all({ storeId, all: opts.includeInactive ? 1 : 0, search: opts.search?.trim() ? `%${opts.search.trim()}%` : null, zone: opts.zone ?? null }) as (Customer & {
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

  /**
   * Client d'une carte scannée : son code (CLI-DLA11-00001), ou son numéro de
   * téléphone (8 chiffres au moins, espaces et indicatif 237 ignorés). Null sinon.
   */
  findByCard(code: string): Customer | null {
    const c = code.trim();
    if (!c) return null;
    const byCode = this.db.prepare('SELECT * FROM customers WHERE code = ? AND active = 1').get(c.toUpperCase()) as Customer | undefined;
    if (byCode) return byCode;
    const digits = c.replace(/\D/g, '').replace(/^237(?=\d{9}$)/, '');
    if (!/^[\d\s.+-]+$/.test(c) || digits.length < 8) return null;
    const rows = this.db.prepare("SELECT * FROM customers WHERE active = 1 AND phone IS NOT NULL AND phone <> ''").all() as Customer[];
    const found = rows.filter((r) => (r.phone ?? '').replace(/\D/g, '').replace(/^237(?=\d{9}$)/, '') === digits);
    return found.length === 1 ? found[0]! : null;
  }

  /** Remises par famille contrôlées (famille connue, entre 0,01 % et 50 %), en JSON ; null sans remise. */
  private discountsJson(discounts: FamilyDiscounts): string | null {
    const clean: FamilyDiscounts = {};
    for (const [familyId, bp] of Object.entries(discounts)) {
      if (!bp) continue;
      if (!Number.isSafeInteger(bp) || bp < 0 || bp > 5_000) throw new AppError('Remise par famille invalide : entre 0 et 50 %', 'INVALID');
      if (!this.db.prepare('SELECT 1 FROM families WHERE id = ?').get(familyId)) throw new AppError('Famille inconnue', 'INVALID');
      clean[familyId] = bp;
    }
    return Object.keys(clean).length ? JSON.stringify(clean) : null;
  }

  /** Prix négociés contrôlés (article connu, prix entier positif), en JSON ; null sans prix. */
  private pricesJson(prices: ArticlePrices): string | null {
    const clean: ArticlePrices = {};
    for (const [articleId, price] of Object.entries(prices)) {
      if (!price) continue;
      if (!Number.isSafeInteger(price) || price < 0) throw new AppError('Prix négocié invalide', 'INVALID');
      const a = this.db.prepare('SELECT name, purchase_price, unit FROM articles WHERE id = ?').get(articleId) as { name: string; purchase_price: number; unit: string } | undefined;
      if (!a) throw new AppError('Article inconnu', 'INVALID');
      clean[articleId] = price;
    }
    return Object.keys(clean).length ? JSON.stringify(clean) : null;
  }

  /** Zones déjà données aux clients, pour les proposer à la saisie et filtrer les listes. */
  zones(): { zone: string; count: number }[] {
    return this.db
      .prepare("SELECT zone, COUNT(*) AS count FROM customers WHERE zone IS NOT NULL AND zone <> '' AND active = 1 GROUP BY zone ORDER BY zone")
      .all() as { zone: string; count: number }[];
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
      language: input.language ?? (id ? this.getCustomer(id).language : 'fr'),
      family_discounts: input.familyDiscounts === undefined ? (id ? this.getCustomer(id).family_discounts : null) : this.discountsJson(input.familyDiscounts),
      no_cheque: input.noCheque === undefined ? (id ? this.getCustomer(id).no_cheque : 0) : input.noCheque ? 1 : 0,
      article_prices: input.articlePrices === undefined ? (id ? this.getCustomer(id).article_prices : null) : this.pricesJson(input.articlePrices),
      zone: input.zone === undefined ? (id ? this.getCustomer(id).zone : null) : input.zone?.trim().replace(/\s+/g, ' ').toUpperCase() || null,
      supplier_id: input.supplierId === undefined ? (id ? this.getCustomer(id).supplier_id : null) : input.supplierId || null,
      field_rep_id: input.fieldRepId === undefined ? (id ? this.getCustomer(id).field_rep_id : null) : input.fieldRepId || null,
      updated_at: now,
    };
    if (values.field_rep_id && !this.db.prepare('SELECT 1 FROM field_reps WHERE id = ?').get(values.field_rep_id)) throw new AppError('Commercial introuvable', 'INVALID');
    if (values.supplier_id && !this.db.prepare('SELECT 1 FROM suppliers WHERE id = ?').get(values.supplier_id)) throw new AppError('Fournisseur introuvable', 'INVALID');
    if (values.zone && values.zone.length > 40) throw new AppError('Nom de zone trop long (40 caractères au plus)', 'INVALID');
    if (!(values.price_level in PRICE_LEVELS)) throw new AppError('Tarif inconnu', 'INVALID');
    if (!DOC_LANGS.includes(values.language)) throw new AppError('Langue inconnue', 'INVALID');
    return this.tx(() => {
      let customerId = id;
      if (customerId) {
        const before = this.getCustomer(customerId);
        this.db
          .prepare(
            `UPDATE customers SET name = @name, contact = @contact, phone = @phone, email = @email, address = @address,
               taxpayer_number = @taxpayer_number, credit_limit = @credit_limit, payment_terms_days = @payment_terms_days,
               notes = @notes, active = @active, price_level = @price_level, language = @language, family_discounts = @family_discounts,
               no_cheque = @no_cheque, article_prices = @article_prices, zone = @zone, supplier_id = @supplier_id, field_rep_id = @field_rep_id, updated_at = @updated_at WHERE id = @id`,
          )
          .run({ ...values, id: customerId });
        if (before.credit_limit !== limit) this.audit(userId, 'customer.credit_limit', 'customer', customerId, { from: before.credit_limit, to: limit });
        if ((before.family_discounts ?? null) !== values.family_discounts) {
          this.audit(userId, 'customer.family_discounts', 'customer', customerId, { from: before.family_discounts, to: values.family_discounts });
        }
        if ((before.article_prices ?? null) !== values.article_prices) {
          this.audit(userId, 'customer.article_prices', 'customer', customerId, { from: before.article_prices, to: values.article_prices });
        }
      } else {
        customerId = newId();
        this.db
          .prepare(
            `INSERT INTO customers (id, code, name, contact, phone, email, address, taxpayer_number, credit_limit, payment_terms_days,
               notes, active, price_level, language, family_discounts, no_cheque, article_prices, zone, supplier_id, field_rep_id, created_at, updated_at)
             VALUES (@id, @code, @name, @contact, @phone, @email, @address, @taxpayer_number, @credit_limit, @payment_terms_days,
               @notes, @active, @price_level, @language, @family_discounts, @no_cheque, @article_prices, @zone, @supplier_id, @field_rep_id, @created_at, @updated_at)`,
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
    // Soldes repris à la mise en service : une créance comme une vente à crédit, un avoir comme un règlement.
    const opening = this.db
      .prepare('SELECT id, number, doc_date AS created_at, due_date, amount FROM opening_balances WHERE store_id = ? AND customer_id = ? ORDER BY doc_date, number')
      .all(storeId, customerId) as { id: string; number: string; created_at: string; due_date: string; amount: number }[];
    debits.unshift(...opening.filter((o) => o.amount > 0));
    // Chèques revenus impayés : la somme (et les frais) redevient due tout de suite.
    debits.push(
      ...(this.db
        .prepare(
          "SELECT id, number, rejected_on AS created_at, rejected_on AS due_date, amount + fees AS amount FROM cheque_rejections WHERE store_id = ? AND customer_id = ? AND status = 'active'",
        )
        .all(storeId, customerId) as { id: string; number: string; created_at: string; due_date: string; amount: number }[]),
    );
    debits.sort((a, b) => a.created_at.slice(0, 10).localeCompare(b.created_at.slice(0, 10)));
    const openingCredit = -opening.filter((o) => o.amount < 0).reduce((t, o) => t + o.amount, 0);
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
              + (SELECT COALESCE(SUM(amount), 0) FROM rebate_entries WHERE store_id = @s AND customer_id = @c AND kind = 'credit')
              - (SELECT COALESCE(SUM(amount), 0) FROM treasury_entries WHERE store_id = @s AND customer_id = @c AND kind = 'customer_refund' AND status = 'active')
              + (SELECT COALESCE(SUM(amount), 0) FROM account_offsets WHERE store_id = @s AND customer_id = @c AND status = 'active')
              + (SELECT COALESCE(SUM(change_kept), 0) FROM sales WHERE store_id = @s AND customer_id = @c AND status = 'completed' AND change_kept > 0 AND change_voucher IS NULL)`,
      )
      .pluck()
      .get({ s: storeId, c: customerId }) as number;
    const total = debits.reduce((t, d) => t + d.amount, 0);
    const today = this.today();
    // Lettrage manuel : la part d'un règlement imputée à une vente précise la solde d'abord ; le reste va aux plus anciennes.
    const lettered = this.lettered(storeId, customerId);
    let letteredTotal = 0;
    const afterLetters = debits.map((d) => {
      const used = Math.min(d.amount, lettered.get(d.id) ?? 0);
      letteredTotal += used;
      return { ...d, amount: d.amount - used, original: d.amount };
    });
    const openItems = allocateOldestFirst(afterLetters, returned + paid + openingCredit - letteredTotal)
      .filter((d) => d.remaining > 0)
      .map(({ original, ...d }) => {
        const due = d.due_date ?? d.created_at.slice(0, 10);
        return { ...d, amount: original, due_date: due, days_late: daysLate(due, today), bucket: agingBucket(due, today) };
      });
    return { balance: total - returned - paid - openingCredit, openItems };
  }

  /** Lettrage manuel du client : vente → montant imputé, chaque règlement plafonné à son montant. */
  private lettered(storeId: string, customerId: string): Map<string, Fcfa> {
    const rows = this.db
      .prepare(
        `SELECT a.payment_id, a.sale_id, a.amount, p.amount AS paid FROM payment_allocations a JOIN customer_payments p ON p.id = a.payment_id
         WHERE a.store_id = ? AND a.customer_id = ? AND a.amount > 0 ORDER BY a.payment_id, a.updated_at`,
      )
      .all(storeId, customerId) as { payment_id: string; sale_id: string; amount: number; paid: number }[];
    const left = new Map<string, number>();
    const out = new Map<string, Fcfa>();
    for (const r of rows) {
      const room = left.get(r.payment_id) ?? r.paid;
      const used = Math.min(room, r.amount);
      left.set(r.payment_id, room - used);
      if (used > 0) out.set(r.sale_id, (out.get(r.sale_id) ?? 0) + used);
    }
    return out;
  }

  /** Lettrage d'un règlement : les ventes qu'il solde, et pour combien. */
  allocations(paymentId: string): { sale_id: string; number: string; amount: Fcfa }[] {
    return this.db
      .prepare('SELECT a.sale_id, s.number, a.amount FROM payment_allocations a JOIN sales s ON s.id = a.sale_id WHERE a.payment_id = ? AND a.amount > 0 ORDER BY s.created_at')
      .all(paymentId) as { sale_id: string; number: string; amount: Fcfa }[];
  }

  /**
   * Lettrage manuel d'un règlement sur des ventes à crédit choisies (une facture en litige
   * reste due, celle que le client désigne est soldée). Remplace le lettrage précédent du
   * règlement ; ce qui n'est pas lettré continue de solder les ventes les plus anciennes.
   */
  setAllocations(ctx: Context, paymentId: string, allocations: { saleId: string; amount: Fcfa }[]): { sale_id: string; number: string; amount: Fcfa }[] {
    const payment = this.getPayment(paymentId);
    if (payment.store_id !== ctx.storeId) throw new AppError("Ce règlement est d'un autre magasin", 'FORBIDDEN');
    const clean = allocations.filter((a) => a.amount !== 0);
    let total = 0;
    const credit = this.db.prepare(
      `SELECT s.number, s.customer_id, s.store_id, s.status, s.kind, COALESCE(SUM(p.amount), 0) AS amount FROM sales s
       LEFT JOIN sale_payments p ON p.sale_id = s.id AND p.method = 'CUSTOMER_CREDIT' WHERE s.id = ? GROUP BY s.id`,
    );
    const others = this.db.prepare('SELECT COALESCE(SUM(amount), 0) FROM payment_allocations WHERE sale_id = ? AND payment_id <> ?').pluck();
    const seen = new Set<string>();
    for (const a of clean) {
      if (!Number.isSafeInteger(a.amount) || a.amount < 0) throw new AppError('Montant lettré invalide', 'INVALID');
      if (seen.has(a.saleId)) throw new AppError('La même facture est lettrée deux fois', 'INVALID');
      seen.add(a.saleId);
      const sale = credit.get(a.saleId) as { number: string; customer_id: string | null; store_id: string; status: string; kind: string; amount: number } | undefined;
      if (!sale || sale.customer_id !== payment.customer_id || sale.store_id !== ctx.storeId || sale.status !== 'completed' || sale.kind !== 'sale' || sale.amount <= 0) {
        throw new AppError('Seules les ventes à crédit de ce client se lettrent', 'INVALID');
      }
      const free = sale.amount - (others.get(a.saleId, paymentId) as number);
      if (a.amount > free) throw new AppError(`La facture ${sale.number} n'a plus que ${formatFcfa(Math.max(0, free))} à lettrer`, 'INVALID');
      total += a.amount;
    }
    if (total > payment.amount) throw new AppError(`Le lettrage dépasse le règlement (${formatFcfa(payment.amount)})`, 'INVALID');
    return this.tx(() => {
      const now = this.now();
      const before = this.db.prepare('SELECT id FROM payment_allocations WHERE payment_id = ? AND amount > 0').pluck().all(paymentId) as string[];
      const upsert = this.db.prepare(
        `INSERT INTO payment_allocations (id, payment_id, sale_id, store_id, customer_id, amount, user_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET amount = excluded.amount, user_id = excluded.user_id, updated_at = excluded.updated_at`,
      );
      const kept = new Set<string>();
      for (const a of clean) {
        const id = `${paymentId}:${a.saleId}`;
        kept.add(id);
        upsert.run(id, paymentId, a.saleId, ctx.storeId, payment.customer_id, a.amount, ctx.userId, now);
        this.enqueue(ctx, 'payment_allocation', id, 'upsert', {});
      }
      // Une imputation retirée passe à zéro : elle voyage comme les autres vers les autres PC.
      for (const id of before.filter((x) => !kept.has(x))) {
        this.db.prepare('UPDATE payment_allocations SET amount = 0, user_id = ?, updated_at = ? WHERE id = ?').run(ctx.userId, now, id);
        this.enqueue(ctx, 'payment_allocation', id, 'upsert', {});
      }
      this.audit(ctx.userId, 'customer.lettering', 'customer_payment', paymentId, { number: payment.number, allocations: clean });
      return this.allocations(paymentId);
    });
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
  assertCredit(storeId: string, customerId: string, amount: Fcfa, authorizedBy: { id: string; role: string } | null, opts: { blockLate?: boolean } = {}): Customer {
    const customer = this.getCustomer(customerId);
    if (!customer.active) throw new AppError(`Le client ${customer.name} est désactivé`, 'INVALID');
    const { balance, openItems } = this.ledger(storeId, customerId);
    const manager = authorizedBy && (authorizedBy.role === 'admin' || authorizedBy.role === 'manager');
    // Paramètre « bloquer les clients en retard » : une facture échue non payée bloque le crédit, sauf accord du gérant.
    const late = openItems.filter((i) => i.days_late > 0).reduce((t, i) => t + i.remaining, 0);
    if (opts.blockLate && late > 0) {
      if (!manager) throw new AppError(`${customer.name} a ${formatFcfa(late)} de factures échues non payées : accord du gérant nécessaire`, 'CUSTOMER_LATE');
      this.audit(authorizedBy.id, 'customer.late_override', 'customer', customerId, { late, amount });
    }
    const check = creditCheck(balance, customer.credit_limit, amount);
    if (!check.allowed) {
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
         SELECT doc_date, 'opening', id, number, amount FROM opening_balances WHERE store_id = @storeId AND customer_id = @customerId
         UNION ALL
         SELECT paid_at, 'payment', id, number, -amount FROM customer_payments WHERE store_id = @storeId AND customer_id = @customerId
         UNION ALL
         SELECT at, 'rebate', id, number, -amount FROM rebate_entries WHERE store_id = @storeId AND customer_id = @customerId AND kind = 'credit'
         UNION ALL
         SELECT at, 'refund', id, number, amount FROM treasury_entries WHERE store_id = @storeId AND customer_id = @customerId AND kind = 'customer_refund' AND status = 'active'
         UNION ALL
         SELECT rejected_on, 'rejected', id, number, amount + fees FROM cheque_rejections WHERE store_id = @storeId AND customer_id = @customerId AND status = 'active'
         UNION ALL
         SELECT offset_date, 'offset', id, number, -amount FROM account_offsets WHERE store_id = @storeId AND customer_id = @customerId AND status = 'active'
         UNION ALL
         SELECT created_at, 'change', id, number, -change_kept FROM sales
         WHERE store_id = @storeId AND customer_id = @customerId AND status = 'completed' AND change_kept > 0 AND change_voucher IS NULL
         ORDER BY 1, 4`,
      )
      .all({ storeId, customerId }) as { date: string; kind: StatementLine['kind']; ref_id: string; number: string; amount: number }[];
    const inRange = (d: string) => (!opts.from || d.slice(0, 10) >= opts.from) && (!opts.to || d.slice(0, 10) <= opts.to);
    const methods = new Map(
      (this.db.prepare('SELECT id, method, reference, advance FROM customer_payments WHERE customer_id = ?').all(customerId) as { id: string; method: string; reference: string | null; advance: number }[]).map(
        (p) => [p.id, p],
      ),
    );
    const openingRefs = new Map(
      (this.db.prepare('SELECT id, doc_ref, kind, label FROM opening_balances WHERE customer_id = ?').all(customerId) as { id: string; doc_ref: string | null; kind: string; label: string | null }[]).map(
        (o) => [o.id, o],
      ),
    );
    // Règlements annulés le jour même : l'argent rendu au client les contre-passe.
    const reversed = new Set(
      this.db.prepare("SELECT payment_id FROM treasury_entries WHERE customer_id = ? AND payment_id IS NOT NULL AND status = 'active'").pluck().all(customerId) as string[],
    );
    const refundLabel = new Map(
      (
        this.db
          .prepare(
            `SELECT e.id, p.number FROM treasury_entries e JOIN customer_payments p ON p.id = e.payment_id
             WHERE e.customer_id = ? AND e.kind = 'customer_refund' AND e.status = 'active'`,
          )
          .all(customerId) as { id: string; number: string }[]
      ).map((x) => [x.id, `Annulation du règlement ${x.number}`]),
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
        r.kind === 'opening'
          ? openingLabel(openingRefs.get(r.ref_id))
          : r.kind === 'sale'
          ? 'Vente à crédit'
          : r.kind === 'return'
            ? 'Retour de marchandise'
            : r.kind === 'rebate'
              ? 'Ristourne accordée en avoir'
              : r.kind === 'refund'
                ? refundLabel.get(r.ref_id) ?? 'Avance ou avoir rendu au client'
                : r.kind === 'rejected'
                  ? 'Chèque revenu impayé (frais compris)'
                : r.kind === 'offset'
                  ? 'Compensation avec son compte fournisseur'
                : r.kind === 'change'
                  ? 'Monnaie laissée sur le compte'
                  : `${pay?.advance ? "Dépôt d'avance" : 'Règlement'} ${CUSTOMER_PAYMENT_METHODS[pay?.method as CustomerPaymentMethod] ?? ''}${pay?.reference ? ` (${pay.reference})` : ''}${reversed.has(r.ref_id) ? ' (annulé)' : ''}`;
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
    input: {
      customerId: string;
      method: CustomerPaymentMethod;
      amount: Fcfa;
      reference?: string | null;
      notes?: string | null;
      sessionId?: string | null;
      /** Lettrage manuel : les factures que ce règlement solde ; sinon les plus anciennes. */
      allocations?: { saleId: string; amount: Fcfa }[] | null;
      /** Dépôt d'avance : accepté même au-delà de ce que doit le client (il solde d'abord sa dette). */
      advance?: boolean;
    },
  ): CustomerPayment {
    if (!(input.method in CUSTOMER_PAYMENT_METHODS)) throw new AppError(`Mode de règlement inconnu : ${input.method}`, 'INVALID');
    if (!Number.isSafeInteger(input.amount) || input.amount <= 0) throw new AppError('Montant invalide', 'INVALID');
    if (input.method !== 'CASH' && !input.reference?.trim()) {
      throw new AppError(`Référence obligatoire pour un règlement par ${CUSTOMER_PAYMENT_METHODS[input.method]}`, 'REFERENCE_REQUIRED');
    }
    if (input.method === 'CHEQUE' && this.getCustomer(input.customerId).no_cheque) {
      throw new AppError('Ce client est interdit de chèque (chèque revenu impayé)', 'NO_CHEQUE');
    }
    const customer = this.getCustomer(input.customerId);
    if (input.advance && !customer.active) throw new AppError(`Le client ${customer.name} est désactivé`, 'INVALID');
    const { balance } = this.ledger(ctx.storeId, input.customerId);
    if (!input.advance && input.amount > balance) {
      throw new AppError(`Le montant dépasse ce que doit le client (${formatFcfa(balance)})`, 'INVALID');
    }
    return this.tx(() => {
      const id = newId();
      this.db
        .prepare(
          `INSERT INTO customer_payments (id, number, customer_id, store_id, register_id, session_id, method, amount, reference, notes, paid_at, user_id, from_central, clearing, advance)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          this.number('RC', 'customer_payment'),
          input.customerId,
          ctx.storeId,
          input.sessionId ? ((this.db.prepare('SELECT register_id FROM cash_sessions WHERE id = ?').pluck().get(input.sessionId) as string | undefined) ?? ctx.registerId) : null,
          input.sessionId ?? null,
          input.method,
          input.amount,
          input.reference?.trim() || null,
          input.notes?.trim() || null,
          this.now(),
          ctx.userId,
          // Espèces reçues au bureau : elles entrent dans la caisse centrale.
          input.method === 'CASH' && !input.sessionId ? 1 : 0,
          // Chèque : au 513 jusqu'à sa remise en banque (bordereau).
          input.method === 'CHEQUE' ? 1 : 0,
          input.advance ? 1 : 0,
        );
      this.enqueue(ctx, 'customer_payment', id, 'upsert', {});
      this.audit(ctx.userId, input.advance ? 'customer.advance' : 'customer.payment', 'customer', input.customerId, { amount: input.amount, method: input.method });
      if (input.allocations?.length) this.setAllocations(ctx, id, input.allocations);
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
              p.paid_at, u.name AS user_name, p.advance
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
    customers: {
      id: string;
      code: string;
      name: string;
      phone: string | null;
      zone: string | null;
      credit_limit: Fcfa;
      balance: Fcfa;
      buckets: Record<AgingBucket, Fcfa>;
      last_reminder: CustomerReminder | null;
    }[];
    totals: Record<AgingBucket, Fcfa> & { balance: Fcfa };
    labels: typeof AGING_LABELS;
  } {
    const ids = this.db
      .prepare(
        `SELECT DISTINCT customer_id FROM sales WHERE store_id = ? AND customer_id IS NOT NULL
         UNION SELECT customer_id FROM customer_payments WHERE store_id = ?
         UNION SELECT customer_id FROM opening_balances WHERE store_id = ?`,
      )
      .pluck()
      .all(storeId, storeId, storeId) as string[];
    const zones = new Map((this.db.prepare('SELECT id, zone FROM customers').all() as { id: string; zone: string | null }[]).map((c) => [c.id, c.zone]));
    const empty = (): Record<AgingBucket, Fcfa> => ({ current: 0, d30: 0, d60: 0, d90: 0, older: 0 });
    const totals = { ...empty(), balance: 0 };
    const reminders = this.lastReminders(storeId);
    const customers = ids
      .map((id) => {
        const c = this.getCustomer(id);
        const { balance, openItems } = this.ledger(storeId, id);
        const buckets = empty();
        for (const i of openItems) buckets[i.bucket] += i.remaining;
        return { id, code: c.code, name: c.name, phone: c.phone, zone: zones.get(id) ?? null, credit_limit: c.credit_limit, balance, buckets, last_reminder: reminders.get(id) ?? null };
      })
      .filter((c) => c.balance !== 0)
      .sort((a, b) => b.balance - a.balance);
    for (const c of customers) {
      totals.balance += c.balance;
      for (const k of Object.keys(c.buckets) as AgingBucket[]) totals[k] += c.buckets[k];
    }
    return { customers, totals, labels: AGING_LABELS };
  }

  /** Ce qu'il faut pour relancer un client : nom, téléphone, montants et factures dues. */
  reminderData(storeId: string, customerId: string): { customer: Customer; balance: Fcfa; overdue: Fcfa; items: OpenItem[]; last: CustomerReminder | null } {
    const acc = this.account(storeId, customerId);
    return { customer: acc.customer, balance: acc.balance, overdue: acc.overdue, items: acc.openItems, last: this.lastReminders(storeId).get(customerId) ?? null };
  }

  /** Une relance vient d'être envoyée (ou son relevé enregistré) : on la garde avec les montants du moment. */
  recordReminder(ctx: Pick<Context, 'storeId' | 'registerId' | 'userId'>, customerId: string, channel: 'whatsapp' | 'pdf'): CustomerReminder {
    const acc = this.account(ctx.storeId, customerId);
    const id = newId();
    const at = this.now();
    this.db
      .prepare('INSERT INTO customer_reminders (id, customer_id, store_id, channel, balance, overdue, user_id, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, customerId, ctx.storeId, channel, acc.balance, acc.overdue, ctx.userId, at);
    this.enqueue(ctx, 'customer_reminder', id, 'upsert', {});
    this.audit(ctx.userId, 'customer.reminder', 'customer', customerId, { channel, balance: acc.balance, overdue: acc.overdue });
    return this.lastReminders(ctx.storeId).get(customerId)!;
  }

  /** Dernière relance de chaque client du magasin. */
  lastReminders(storeId: string): Map<string, CustomerReminder> {
    const rows = this.db
      .prepare(
        `SELECT r.customer_id, r.at, r.channel, r.balance, r.overdue, u.name AS user_name,
                (SELECT COUNT(*) FROM customer_reminders x WHERE x.store_id = r.store_id AND x.customer_id = r.customer_id) AS count
         FROM customer_reminders r LEFT JOIN users u ON u.id = r.user_id
         WHERE r.store_id = ? AND r.at = (SELECT MAX(at) FROM customer_reminders y WHERE y.store_id = r.store_id AND y.customer_id = r.customer_id)`,
      )
      .all(storeId) as CustomerReminder[];
    return new Map(rows.map((r) => [r.customer_id, r]));
  }
}
