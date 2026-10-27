import { type Fcfa, type Milli, dueDate, lineAmount, parseStoreSettings, purchaseAmounts, purchaseTermsError, spreadDiscount, suggestReorder, ttcFromHt } from '@superette/core';
import type { Db } from './database';
import type { ReceptionLine, StockService } from './stock';
import { AppError, Base, type Clock, type Context, newId } from './util';
import { EmoneyService } from './emoney';

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
  /** Jours de passage (1 = lundi … 7 = dimanche), « 1,4 » ; null sans calendrier. */
  visit_days: string | null;
}

/** Ligne du calendrier des fournisseurs. */
export interface SupplierVisit {
  supplier_id: string;
  supplier_name: string;
  phone: string | null;
  days: number[];
  next_visit: string | null;
  /** Articles à commander pour ce fournisseur d'après la proposition de commande. */
  to_order: number;
  /** Montant HT estimé de cette commande. */
  amount: Fcfa;
  /** Bon de commande déjà préparé et pas encore reçu. */
  open_order: string | null;
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
  /** Bonus convenu : « promo_buy achetés, promo_pay payés » (12/10), proposé à la commande et à la réception. */
  promo_buy: number | null;
  promo_pay: number | null;
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
  /** Remise en points de base (1 000 = 10 %). */
  discountBp?: number;
  /** Unités gratuites comprises dans qty (« N achetés, M payés »). */
  freeQty?: Milli;
  /** Promo saisie, gardée pour l'affichage : N achetés, M payés. */
  promoBuy?: number | null;
  promoPay?: number | null;
}

/** Remise, gratuits et promo d'une ligne d'achat, tels qu'enregistrés. */
export interface PurchaseLineTerms {
  discount_bp: number;
  free_qty: Milli;
  promo_buy: number | null;
  promo_pay: number | null;
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
    discount_bp: number;
    free_qty: Milli;
    promo_buy: number | null;
    promo_pay: number | null;
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
  /** Remise globale (facture directe), déjà répartie sur les lignes. */
  discount: Fcfa;
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
    /** Coût net qui est entré en stock. */
    unit_cost: Fcfa;
    /** Prix avant remise et gratuits (null : réception d'avant la 0.35.0). */
    gross_cost: Fcfa | null;
    discount_bp: number;
    free_qty: Milli;
    promo_buy: number | null;
    promo_pay: number | null;
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
  /** Facture saisie avec ses articles, sans bon de commande. */
  direct: number;
  /** Remise globale HT de la facture directe. */
  discount: Fcfa;
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
  /** Rayon et famille, pour filtrer la proposition. */
  department_id: string | null;
  department_name: string | null;
  family_name: string | null;
  unit_name: string | null;
  /** Conditionnements de l'article (carton, casier…), pour lire la quantité en cartons et pièces. */
  packs: { name: string; units: Milli }[];
  /** Méthode « saison » : ventes par jour des semaines à venir, l'an dernier (null sans historique). */
  last_year_daily?: Milli | null;
  /** Méthode « saison » : évolution des ventes récentes par rapport à l'an dernier (1 = pareil). */
  trend?: number | null;
  /** Demandes des clients non servies sur la période (ventes manquées), comptées dans les ventes par jour. */
  missed: Milli;
  /** Prochain jour de passage du fournisseur principal (AAAA-MM-JJ), null sans calendrier. */
  next_visit: string | null;
}

/** Options de la proposition de commande. */
export interface ReorderOptions {
  coverDays?: number;
  historyDays?: number;
  /**
   * « recent » : moyenne des dernières semaines. « season » : ventes des mêmes
   * semaines l'an dernier, corrigées de l'évolution récente (fêtes, rentrée…).
   */
  method?: 'recent' | 'season';
  /** Majoration en % pour un événement (fêtes de fin d'année, Ramadan…), -50 à +300. */
  boostPct?: number;
  /** Seulement les articles de ce fournisseur principal (proposition prête la veille de son passage). */
  supplierId?: string | null;
}

/**
 * Fournisseurs et achats, en chaîne documentaire : fiche
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

  /** Préfixe des bons de commande réglé dans les paramètres du magasin (BC par défaut). */
  private orderPrefix(storeId: string): string {
    return parseStoreSettings(this.db.prepare('SELECT settings FROM stores WHERE id = ?').pluck().get(storeId) as string | null).prefixOrder || 'BC';
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
                - COALESCE((SELECT SUM(p.amount) FROM supplier_payments p WHERE p.supplier_id = s.id), 0)
                - COALESCE((SELECT SUM(o.amount) FROM account_offsets o WHERE o.supplier_id = s.id AND o.status = 'active'), 0) AS balance
         FROM suppliers s
         WHERE (@all = 1 OR s.active = 1) AND (@search IS NULL OR s.name LIKE @search OR s.code LIKE @search OR s.phone LIKE @search)
         ORDER BY s.name`,
      )
      .all({ all: opts.includeInactive ? 1 : 0, search: opts.search ? `%${opts.search}%` : null }) as never;
  }

  /** Jours de passage du fournisseur (calendrier des fournisseurs). */
  setVisitDays(userId: string, id: string, days: number[]): Supplier {
    this.getSupplier(id);
    const clean = parseVisitDays(days.join(','));
    return this.tx(() => {
      this.db.prepare('UPDATE suppliers SET visit_days = ?, updated_at = ? WHERE id = ?').run(clean.length ? clean.join(',') : null, this.now(), id);
      this.enqueue(null, 'supplier', id, 'upsert', {});
      this.audit(userId, 'supplier.visit_days', 'supplier', id, { days: clean });
      return this.getSupplier(id);
    });
  }

  /**
   * Calendrier des fournisseurs : jour de passage de chacun et ce qu'il faut
   * lui commander. La veille de son passage, sa proposition est prête.
   */
  visitCalendar(storeId: string): SupplierVisit[] {
    const suppliers = this.db.prepare('SELECT id, name, phone, visit_days FROM suppliers WHERE active = 1 ORDER BY name').all() as { id: string; name: string; phone: string | null; visit_days: string | null }[];
    const proposal = this.reorderProposal(storeId);
    const today = this.today();
    const openOrder = this.db.prepare("SELECT number FROM purchase_orders WHERE supplier_id = ? AND store_id = ? AND status IN ('draft', 'sent') ORDER BY created_at DESC LIMIT 1").pluck();
    return suppliers
      .map((f) => {
        const lines = proposal.filter((r) => r.supplier_id === f.id);
        return {
          supplier_id: f.id,
          supplier_name: f.name,
          phone: f.phone,
          days: parseVisitDays(f.visit_days),
          next_visit: nextVisit(f.visit_days, today),
          to_order: lines.length,
          amount: lines.reduce((t, l) => t + Math.round((l.qty * l.unit_cost) / 1000), 0),
          open_order: (openOrder.get(f.id, storeId) as string | undefined) ?? null,
        };
      })
      .filter((v) => v.days.length || v.to_order)
      .sort((a, b) => (a.next_visit ?? '9999').localeCompare(b.next_visit ?? '9999') || a.supplier_name.localeCompare(b.supplier_name, 'fr'));
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
              sa.supplier_ref, sa.unit_cost, sa.pack_qty, sa.is_main, sa.promo_buy, sa.promo_pay,
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
    input: {
      supplierId: string;
      articleId: string;
      supplierRef?: string | null;
      unitCost: Fcfa;
      packQty?: Milli;
      isMain?: boolean;
      /** Bonus convenu (« 12 achetés, 10 payés ») ; null le retire, absent le garde. */
      promoBuy?: number | null;
      promoPay?: number | null;
    },
  ): SupplierArticle {
    if (!Number.isSafeInteger(input.unitCost) || input.unitCost < 0) throw new AppError("Prix d'achat invalide", 'INVALID');
    if (input.promoBuy !== undefined || input.promoPay !== undefined) {
      const buy = input.promoBuy ?? null;
      const pay = input.promoPay ?? null;
      if ((buy === null) !== (pay === null)) throw new AppError('Bonus : indiquez les quantités achetées et payées', 'INVALID');
      if (buy !== null && (!Number.isInteger(buy) || !Number.isInteger(pay) || pay! < 1 || buy <= pay! || buy > 1000)) {
        throw new AppError('Bonus invalide : la quantité achetée doit dépasser la quantité payée (12 achetés, 10 payés)', 'INVALID');
      }
    }
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
      const kept = existing ? (this.db.prepare('SELECT promo_buy, promo_pay FROM supplier_articles WHERE id = ?').get(existing) as { promo_buy: number | null; promo_pay: number | null }) : null;
      const promoBuy = input.promoBuy !== undefined ? input.promoBuy : (kept?.promo_buy ?? null);
      const promoPay = input.promoPay !== undefined ? input.promoPay : (kept?.promo_pay ?? null);
      this.db
        .prepare(
          `INSERT INTO supplier_articles (id, supplier_id, article_id, supplier_ref, unit_cost, pack_qty, is_main, promo_buy, promo_pay, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET supplier_ref = excluded.supplier_ref, unit_cost = excluded.unit_cost,
             pack_qty = excluded.pack_qty, is_main = excluded.is_main, promo_buy = excluded.promo_buy, promo_pay = excluded.promo_pay, updated_at = excluded.updated_at`,
        )
        .run(id, input.supplierId, input.articleId, input.supplierRef?.trim() || null, input.unitCost, pack, isMain ? 1 : 0, promoBuy, promoPay, now);
      this.enqueue(null, 'supplier_article', id, 'upsert', {});
      this.audit(userId, 'supplier.article', 'supplier', input.supplierId, { articleId: input.articleId, unitCost: input.unitCost, promoBuy, promoPay });
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
      const err = purchaseTermsError({ qty: l.qty, unitCost: l.unitCost, discountBp: l.discountBp, freeQty: l.freeQty });
      if (err) throw new AppError(err, 'INVALID');
    }
  }

  private writeLines(orderId: string, lines: PurchaseOrderLineInput[]): void {
    this.db.prepare('DELETE FROM purchase_order_lines WHERE order_id = ?').run(orderId);
    const insert = this.db.prepare(
      `INSERT INTO purchase_order_lines (id, order_id, line_no, article_id, qty, unit_cost, discount_bp, free_qty, promo_buy, promo_pay)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    lines.forEach((l, i) =>
      insert.run(newId(), orderId, i + 1, l.articleId, l.qty, l.unitCost, l.discountBp ?? 0, l.freeQty ?? 0, l.promoBuy ?? null, l.promoPay ?? null),
    );
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
        .run(id, this.number(this.orderPrefix(ctx.storeId), 'order.number'), ctx.storeId, input.warehouseId, input.supplierId, today, expected, input.notes?.trim() || null, ctx.userId, now, now);
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
                  sa.supplier_ref, l.qty, l.unit_cost, l.discount_bp, l.free_qty, l.promo_buy, l.promo_pay,
                  COALESCE((SELECT SUM(rl.qty) FROM reception_lines rl WHERE rl.order_line_id = l.id), 0) AS received
           FROM purchase_order_lines l JOIN articles a ON a.id = l.article_id
           LEFT JOIN supplier_articles sa ON sa.article_id = l.article_id AND sa.supplier_id = ?
           WHERE l.order_id = ? ORDER BY l.line_no`,
        )
        .all(head.supplier_id, id) as Omit<PurchaseOrder['lines'][number], 'total_ht'>[]
    ).map((l) => ({ ...l, total_ht: purchaseAmounts({ qty: l.qty, unitCost: l.unit_cost, discountBp: l.discount_bp, freeQty: l.free_qty }).net }));
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

  // --- Commandes groupées ---------------------------------------------------------

  /**
   * Commande groupée : une négociation, un fournisseur, plusieurs magasins. Un
   * bon de commande brouillon par magasin (livré à son dépôt de vente), tous
   * sous le même numéro « CG- » ; chaque magasin réceptionne le sien. Les bons
   * partent vers les PC de chaque magasin par la synchronisation.
   */
  createGroupOrder(
    ctx: Context,
    input: { supplierId: string; expectedDate?: string | null; notes?: string | null; lines: { articleId: string; unitCost: Fcfa; qtyByStore: Record<string, Milli> }[] },
  ): { ref: string; orders: PurchaseOrder[] } {
    const supplier = this.getSupplier(input.supplierId);
    if (!input.lines.length) throw new AppError('Ajoutez au moins un article', 'EMPTY');
    const stores = new Map<string, PurchaseOrderLineInput[]>();
    for (const l of input.lines) {
      for (const [storeId, qty] of Object.entries(l.qtyByStore)) {
        if (!qty) continue;
        if (!Number.isSafeInteger(qty) || qty < 0) throw new AppError('Quantité invalide', 'INVALID');
        stores.set(storeId, [...(stores.get(storeId) ?? []), { articleId: l.articleId, qty, unitCost: l.unitCost }]);
      }
    }
    if (stores.size === 0) throw new AppError('Indiquez les quantités de chaque magasin', 'EMPTY');
    const warehouseOf = this.db.prepare("SELECT id FROM warehouses WHERE store_id = ? AND active = 1 ORDER BY is_sales_default DESC, CASE kind WHEN 'shop' THEN 0 ELSE 1 END, name LIMIT 1");
    return this.tx(() => {
      const ref = `CG-${this.stationPrefix()}-${String(this.nextCounter('order.group')).padStart(5, '0')}`;
      const orders: PurchaseOrder[] = [];
      for (const [storeId, lines] of stores) {
        const store = this.db.prepare('SELECT name FROM stores WHERE id = ?').pluck().get(storeId) as string | undefined;
        if (!store) throw new AppError('Magasin introuvable', 'NOT_FOUND');
        const warehouseId = warehouseOf.pluck().get(storeId) as string | undefined;
        if (!warehouseId) throw new AppError(`Le magasin ${store} n'a pas de dépôt`, 'INVALID');
        const o = this.createOrder(
          { ...ctx, storeId },
          { supplierId: supplier.id, warehouseId, expectedDate: input.expectedDate, notes: [`Commande groupée ${ref}`, input.notes?.trim()].filter(Boolean).join(' · '), lines },
        );
        this.db.prepare('UPDATE purchase_orders SET group_ref = ? WHERE id = ?').run(ref, o.id);
        this.enqueue({ ...ctx, storeId }, 'purchase_order', o.id, 'upsert', {});
        orders.push(this.getOrder(o.id));
      }
      this.audit(ctx.userId, 'order.group', 'purchase_order', ref, { supplier: supplier.name, stores: stores.size });
      return { ref, orders };
    });
  }

  /** Commandes groupées : numéro, fournisseur, magasins et total. */
  groupOrders(): { ref: string; supplier_name: string; order_date: string; stores: number; total_ht: Fcfa; received: number }[] {
    const refs = this.db
      .prepare('SELECT group_ref AS ref, MAX(order_date) AS d FROM purchase_orders WHERE group_ref IS NOT NULL GROUP BY group_ref ORDER BY d DESC, group_ref DESC LIMIT 200')
      .all() as { ref: string; d: string }[];
    return refs.map((r) => {
      const g = this.groupOrder(r.ref);
      return {
        ref: r.ref,
        supplier_name: g.supplier_name,
        order_date: r.d,
        stores: g.orders.length,
        total_ht: g.orders.reduce((t, o) => t + o.total_ht, 0),
        received: g.orders.filter((o) => o.state === 'received' || o.status === 'closed').length,
      };
    });
  }

  /** Détail d'une commande groupée : un bon par magasin. */
  groupOrder(ref: string): { ref: string; supplier_name: string; orders: (PurchaseOrder & { store_name: string })[] } {
    const ids = this.db.prepare('SELECT id FROM purchase_orders WHERE group_ref = ? ORDER BY number').pluck().all(ref) as string[];
    if (!ids.length) throw new AppError('Commande groupée introuvable', 'NOT_FOUND');
    const storeName = this.db.prepare('SELECT name FROM stores WHERE id = ?').pluck();
    const orders = ids.map((id) => {
      const o = this.getOrder(id);
      return { ...o, store_name: (storeName.get(o.store_id) as string | undefined) ?? '' };
    });
    return { ref, supplier_name: orders[0]!.supplier_name, orders };
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

  // --- Contremarque ---------------------------------------------------------------

  /**
   * Lignes d'une commande client que le stock ne couvre pas : quantité commandée
   * moins le stock du magasin non réservé par d'autres commandes préparées.
   */
  backOrderNeeds(storeId: string, customerOrderId: string): { lineId: string; articleId: string; name: string; missing: Milli; supplierId: string | null; supplierName: string | null; unitCost: Fcfa }[] {
    const lines = this.db
      .prepare(
        `SELECT l.id, l.article_id, a.name, l.qty, a.purchase_price FROM customer_order_lines l JOIN customer_orders o ON o.id = l.order_id
         JOIN articles a ON a.id = l.article_id WHERE o.id = ? AND o.store_id = ? AND l.purchase_order_id IS NULL AND a.is_service = 0 ORDER BY l.line_no`,
      )
      .all(customerOrderId, storeId) as { id: string; article_id: string; name: string; qty: number; purchase_price: number }[];
    const stocked = this.db.prepare('SELECT COALESCE(SUM(s.qty), 0) FROM stock s JOIN warehouses w ON w.id = s.warehouse_id WHERE w.store_id = ? AND s.article_id = ?').pluck();
    const reserved = this.db
      .prepare(
        `SELECT COALESCE(SUM(l.qty), 0) FROM customer_order_lines l JOIN customer_orders o ON o.id = l.order_id
         WHERE o.store_id = ? AND o.status = 'prepared' AND o.id <> ? AND l.article_id = ?`,
      )
      .pluck();
    const main = this.db.prepare(
      `SELECT sa.supplier_id, s.name, sa.unit_cost FROM supplier_articles sa JOIN suppliers s ON s.id = sa.supplier_id
       WHERE sa.article_id = ? AND s.active = 1 ORDER BY sa.is_main DESC, sa.updated_at DESC LIMIT 1`,
    );
    const left = new Map<string, number>();
    const out: ReturnType<PurchaseService['backOrderNeeds']> = [];
    for (const l of lines) {
      if (!left.has(l.article_id)) left.set(l.article_id, Math.max(0, (stocked.get(storeId, l.article_id) as number) - (reserved.get(storeId, customerOrderId, l.article_id) as number)));
      const free = left.get(l.article_id)!;
      const missing = Math.max(0, l.qty - free);
      left.set(l.article_id, Math.max(0, free - l.qty));
      if (missing <= 0) continue;
      const sup = main.get(l.article_id) as { supplier_id: string; name: string; unit_cost: number } | undefined;
      out.push({ lineId: l.id, articleId: l.article_id, name: l.name, missing, supplierId: sup?.supplier_id ?? null, supplierName: sup?.name ?? null, unitCost: sup?.unit_cost || l.purchase_price });
    }
    return out;
  }

  /**
   * Contremarque : ce qui manque pour une commande client part dans le bon de
   * commande en brouillon de son fournisseur (créé au besoin), et la ligne de la
   * commande client garde le bon où elle est commandée.
   */
  backOrder(ctx: Context, customerOrderId: string, opts: { supplierId?: string | null; warehouseId?: string | null } = {}): PurchaseOrder[] {
    const status = this.db.prepare('SELECT status FROM customer_orders WHERE id = ? AND store_id = ?').pluck().get(customerOrderId, ctx.storeId) as string | undefined;
    if (!status) throw new AppError('Commande client introuvable', 'NOT_FOUND');
    if (status === 'invoiced' || status === 'cancelled') throw new AppError('Cette commande client est clôturée', 'INVALID');
    const needs = this.backOrderNeeds(ctx.storeId, customerOrderId).map((n) => (opts.supplierId ? { ...n, supplierId: opts.supplierId } : n));
    if (needs.length === 0) throw new AppError('Le stock couvre déjà toute la commande : rien à commander', 'EMPTY');
    const orphan = needs.find((n) => !n.supplierId);
    if (orphan) throw new AppError(`${orphan.name} n'a pas de fournisseur : choisissez le fournisseur à qui commander`, 'SUPPLIER_REQUIRED');
    const warehouseId =
      opts.warehouseId ?? (this.db.prepare('SELECT id FROM warehouses WHERE store_id = ? AND active = 1 ORDER BY is_sales_default DESC, name LIMIT 1').pluck().get(ctx.storeId) as string);
    const bySupplier = new Map<string, typeof needs>();
    for (const n of needs) bySupplier.set(n.supplierId!, [...(bySupplier.get(n.supplierId!) ?? []), n]);
    const ref = this.db.prepare('SELECT number FROM customer_orders WHERE id = ?').pluck().get(customerOrderId) as string;
    return this.tx(() =>
      [...bySupplier].map(([supplierId, ns]) => {
        // Un brouillon en cours chez ce fournisseur reçoit les lignes ; sinon un nouveau bon.
        const draft = this.db
          .prepare("SELECT id FROM purchase_orders WHERE store_id = ? AND supplier_id = ? AND status = 'draft' ORDER BY created_at DESC LIMIT 1")
          .pluck()
          .get(ctx.storeId, supplierId) as string | undefined;
        const add = ns.map((n) => ({ articleId: n.articleId, qty: n.missing, unitCost: n.unitCost }));
        let order: PurchaseOrder;
        if (draft) {
          const current = this.getOrder(draft);
          const lines: PurchaseOrderLineInput[] = current.lines.map((l) => ({
            articleId: l.article_id,
            qty: l.qty,
            unitCost: l.unit_cost,
            discountBp: l.discount_bp,
            freeQty: l.free_qty,
            promoBuy: l.promo_buy,
            promoPay: l.promo_pay,
          }));
          for (const a of add) {
            const same = lines.find((l) => l.articleId === a.articleId && !l.freeQty);
            if (same) same.qty += a.qty;
            else lines.push(a);
          }
          const notes = [current.notes, `Contremarque ${ref}`].filter(Boolean).join(' · ');
          order = this.updateOrder(ctx, draft, { supplierId, warehouseId: current.warehouse_id, expectedDate: current.expected_date, notes, lines });
        } else {
          order = this.createOrder(ctx, { supplierId, warehouseId, notes: `Contremarque ${ref}`, lines: add });
        }
        const link = this.db.prepare('UPDATE customer_order_lines SET purchase_order_id = ? WHERE id = ?');
        for (const n of ns) link.run(order.id, n.lineId);
        this.enqueue(ctx, 'customer_order', customerOrderId, 'upsert', {});
        this.audit(ctx.userId, 'order.back_order', 'customer_order', customerOrderId, { purchaseOrder: order.number, lines: ns.length });
        return order;
      }),
    );
  }

  // --- Réceptions ---------------------------------------------------------------

  private receptionTotals(id: string): { total_ht: Fcfa; total_tva: Fcfa; total_ttc: Fcfa } {
    const lines = this.db.prepare('SELECT qty, unit_cost, amount, vat_rate_bp FROM reception_lines WHERE reception_id = ?').all(id) as {
      qty: number;
      unit_cost: number;
      amount: number | null;
      vat_rate_bp: number;
    }[];
    return taxTotals(lines.map((l) => ({ ht: l.amount ?? lineAmount(l.unit_cost, l.qty), rate: l.vat_rate_bp })));
  }

  listReceptions(storeId: string, opts: { supplierId?: string; uninvoiced?: boolean; limit?: number } = {}): Reception[] {
    const rows = this.db
      .prepare(
        `SELECT r.*, s.name AS supplier_name, w.name AS warehouse_name, o.number AS order_number, i.number AS invoice_number, u.name AS user_name
         FROM receptions r JOIN warehouses w ON w.id = r.warehouse_id
         LEFT JOIN suppliers s ON s.id = r.supplier_id LEFT JOIN purchase_orders o ON o.id = r.order_id
         LEFT JOIN supplier_invoices i ON i.id = r.invoice_id LEFT JOIN users u ON u.id = r.user_id
         WHERE r.store_id = @storeId AND (@supplierId IS NULL OR r.supplier_id = @supplierId) AND (@uninvoiced = 0 OR (r.invoice_id IS NULL AND r.opening = 0))
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
          `SELECT rl.id, rl.article_id, a.code AS article_code, a.name AS article_name, a.unit, rl.qty, rl.unit_cost, rl.gross_cost,
                  rl.discount_bp, rl.free_qty, rl.promo_buy, rl.promo_pay, rl.amount, rl.vat_rate_bp, rl.lot_number, rl.expiry
           FROM reception_lines rl JOIN articles a ON a.id = rl.article_id WHERE rl.reception_id = ? ORDER BY rl.line_no`,
        )
        .all(id) as (Omit<ReceptionDetail['lines'][number], 'total_ht'> & { amount: number | null })[]
    ).map(({ amount, ...l }) => ({ ...l, total_ht: amount ?? lineAmount(l.unit_cost, l.qty) }));
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
    this.assertPeriodOpen(ctx.storeId, input.invoiceDate);
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

  /**
   * Facture d'achat directe, sans bon de commande : la marchandise entre en
   * stock au coût net (remises, gratuits, part de la remise globale), un bon de
   * réception est créé et rattaché à la facture, et la facture peut être
   * réglée tout de suite.
   */
  directInvoice(
    ctx: Context,
    input: {
      supplierId: string;
      supplierNumber: string;
      invoiceDate: string;
      dueDate?: string | null;
      warehouseId: string;
      notes?: string | null;
      lines: ReceptionLine[];
      /** Remise globale en % (points de base) ou en montant HT. */
      discountBp?: number;
      discountAmount?: Fcfa;
      /** Règlement immédiat ; sans montant, toute la facture. */
      payment?: { method: SupplierPaymentMethod; amount?: Fcfa | null; reference?: string | null; registerId?: string | null } | null;
    },
  ): SupplierInvoice {
    const supplier = this.getSupplier(input.supplierId);
    if (input.lines.length === 0) throw new AppError('La facture est vide : ajoutez au moins un article', 'EMPTY');
    const nets = input.lines.map((l) => {
      const err = purchaseTermsError({ qty: l.qty, unitCost: l.unitCost, discountBp: l.discountBp, freeQty: l.freeQty });
      if (err) throw new AppError(err, 'INVALID');
      return purchaseAmounts({ qty: l.qty, unitCost: l.unitCost, discountBp: l.discountBp, freeQty: l.freeQty }).net;
    });
    const sum = nets.reduce((a, n) => a + n, 0);
    const bp = input.discountBp ?? 0;
    if (!Number.isSafeInteger(bp) || bp < 0 || bp > 10_000) throw new AppError('Remise globale invalide : entre 0 et 100 %', 'INVALID');
    const global = input.discountAmount !== undefined && input.discountAmount !== null && input.discountAmount > 0 ? input.discountAmount : Math.round((sum * bp) / 10_000);
    if (!Number.isSafeInteger(global) || global < 0 || global > sum) throw new AppError('La remise globale dépasse le montant de la facture', 'INVALID');
    const shares = spreadDiscount(nets, global);
    return this.tx(() => {
      const rec = this.stock.receive(ctx, {
        warehouseId: input.warehouseId,
        reference: input.supplierNumber,
        supplierId: supplier.id,
        discount: global,
        lines: input.lines.map((l, i) => ({ ...l, globalDiscount: shares[i] })),
      });
      const totals = this.receptionTotals(rec.id);
      const invoice = this.createInvoice(ctx, {
        supplierId: supplier.id,
        supplierNumber: input.supplierNumber,
        invoiceDate: input.invoiceDate,
        dueDate: input.dueDate,
        totalHt: totals.total_ht,
        totalTva: totals.total_tva,
        receptionIds: [rec.id],
        notes: input.notes,
      });
      this.db.prepare('UPDATE supplier_invoices SET direct = 1, discount = ? WHERE id = ?').run(global, invoice.id);
      this.enqueue(ctx, 'supplier_invoice', invoice.id, 'upsert', {});
      if (input.payment) this.paySupplier(ctx, { ...input.payment, amount: input.payment.amount || this.getInvoice(invoice.id).balance, invoiceId: invoice.id });
      return this.getInvoice(invoice.id);
    });
  }

  /**
   * Modifie une facture ou un avoir fournisseur déjà saisi : n° de la pièce,
   * dates, notes et, hors facture directe (dont les montants viennent des
   * articles), les montants. Le total ne descend pas sous ce qui est déjà réglé.
   */
  updateInvoice(
    ctx: Context,
    id: string,
    input: { supplierNumber: string; invoiceDate: string; dueDate?: string | null; notes?: string | null; totalHt?: Fcfa; totalTva?: Fcfa },
  ): SupplierInvoice {
    const inv = this.getInvoice(id);
    if (inv.store_id !== ctx.storeId) throw new AppError('Facture fournisseur introuvable', 'NOT_FOUND');
    const supplierNumber = input.supplierNumber.trim();
    if (!supplierNumber) throw new AppError('Le numéro de la facture du fournisseur est obligatoire', 'INVALID');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.invoiceDate)) throw new AppError('Date de facture invalide', 'INVALID');
    if (input.dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(input.dueDate)) throw new AppError("Date d'échéance invalide", 'INVALID');
    this.assertPeriodOpen(ctx.storeId, inv.invoice_date);
    this.assertPeriodOpen(ctx.storeId, input.invoiceDate);
    const duplicate = this.db
      .prepare('SELECT number FROM supplier_invoices WHERE supplier_id = ? AND kind = ? AND supplier_number = ? AND id <> ?')
      .pluck()
      .get(inv.supplier_id, inv.kind, supplierNumber, id) as string | undefined;
    if (duplicate) throw new AppError(`Cette facture fournisseur est déjà saisie (${duplicate})`, 'DUPLICATE');
    let totalHt = inv.total_ht;
    let totalTva = inv.total_tva;
    if (!inv.direct && (input.totalHt !== undefined || input.totalTva !== undefined)) {
      const ht = input.totalHt ?? inv.total_ht;
      const tva = input.totalTva ?? inv.total_tva;
      for (const v of [ht, tva]) if (!Number.isSafeInteger(v) || v < 0) throw new AppError('Montant invalide', 'INVALID');
      if (ht + tva <= 0) throw new AppError('Le montant de la facture doit être positif', 'INVALID');
      const vatEnabled = (this.db.prepare('SELECT vat_enabled FROM stores WHERE id = ?').pluck().get(ctx.storeId) as number | undefined) !== 0;
      totalHt = vatEnabled ? ht : ht + tva;
      totalTva = vatEnabled ? tva : 0;
    }
    if (totalHt + totalTva < inv.paid) throw new AppError(`${inv.paid} FCFA sont déjà réglés sur cette pièce : le total ne peut pas être plus petit`, 'INVALID');
    const supplier = this.getSupplier(inv.supplier_id);
    const due = input.dueDate || (input.invoiceDate !== inv.invoice_date ? dueDate(input.invoiceDate, supplier.payment_terms_days) : inv.due_date);
    return this.tx(() => {
      this.db
        .prepare('UPDATE supplier_invoices SET supplier_number = ?, invoice_date = ?, due_date = ?, notes = ?, total_ht = ?, total_tva = ?, total_ttc = ? WHERE id = ?')
        .run(supplierNumber, input.invoiceDate, due, input.notes === undefined ? inv.notes : input.notes?.trim() || null, totalHt, totalTva, totalHt + totalTva, id);
      this.enqueue(ctx, 'supplier_invoice', id, 'upsert', {});
      this.audit(ctx.userId, 'supplier_invoice.update', 'supplier_invoice', id, {
        number: inv.number,
        from: { supplierNumber: inv.supplier_number, invoiceDate: inv.invoice_date, dueDate: inv.due_date, ttc: inv.total_ttc },
        to: { supplierNumber, invoiceDate: input.invoiceDate, dueDate: due, ttc: totalHt + totalTva },
      });
      return this.getInvoice(id);
    });
  }

  /**
   * Corrige les articles d'une facture directe (quantité, prix, remise, article
   * oublié ou en trop) : le stock reçu est refait (voir `StockService.rewriteReception`)
   * et les montants de la facture suivent.
   */
  correctDirectInvoice(
    ctx: Context,
    id: string,
    input: {
      supplierNumber: string;
      invoiceDate: string;
      dueDate?: string | null;
      notes?: string | null;
      lines: ReceptionLine[];
      discountBp?: number;
      discountAmount?: Fcfa;
    },
  ): SupplierInvoice {
    const inv = this.getInvoice(id);
    if (inv.store_id !== ctx.storeId) throw new AppError('Facture fournisseur introuvable', 'NOT_FOUND');
    if (!inv.direct) throw new AppError("Seule une facture directe (saisie avec ses articles) se corrige article par article", 'INVALID');
    const recIds = this.db.prepare('SELECT id FROM receptions WHERE invoice_id = ?').pluck().all(id) as string[];
    if (recIds.length !== 1) throw new AppError('Bon de réception de la facture introuvable', 'NOT_FOUND');
    if (input.lines.length === 0) throw new AppError('La facture est vide : ajoutez au moins un article', 'EMPTY');
    const nets = input.lines.map((l) => {
      const err = purchaseTermsError({ qty: l.qty, unitCost: l.unitCost, discountBp: l.discountBp, freeQty: l.freeQty });
      if (err) throw new AppError(err, 'INVALID');
      return purchaseAmounts({ qty: l.qty, unitCost: l.unitCost, discountBp: l.discountBp, freeQty: l.freeQty }).net;
    });
    const sum = nets.reduce((a, n) => a + n, 0);
    const bp = input.discountBp ?? 0;
    if (!Number.isSafeInteger(bp) || bp < 0 || bp > 10_000) throw new AppError('Remise globale invalide : entre 0 et 100 %', 'INVALID');
    const global = input.discountAmount !== undefined && input.discountAmount !== null && input.discountAmount > 0 ? input.discountAmount : Math.round((sum * bp) / 10_000);
    if (!Number.isSafeInteger(global) || global < 0 || global > sum) throw new AppError('La remise globale dépasse le montant de la facture', 'INVALID');
    const shares = spreadDiscount(nets, global);
    return this.tx(() => {
      this.updateInvoice(ctx, id, { supplierNumber: input.supplierNumber, invoiceDate: input.invoiceDate, dueDate: input.dueDate, notes: input.notes });
      this.stock.rewriteReception(ctx, recIds[0]!, {
        lines: input.lines.map((l, i) => ({ ...l, globalDiscount: shares[i] })),
        discount: global,
        reference: input.supplierNumber,
        reason: `${inv.supplier_name} · correction de la facture ${inv.number}`,
      });
      const totals = this.receptionTotals(recIds[0]!);
      if (totals.total_ttc < inv.paid) throw new AppError(`${inv.paid} FCFA sont déjà réglés sur cette facture : le nouveau total (${totals.total_ttc} FCFA) ne peut pas être plus petit`, 'INVALID');
      this.db
        .prepare('UPDATE supplier_invoices SET total_ht = ?, total_tva = ?, total_ttc = ?, received_ht = ?, discount = ? WHERE id = ?')
        .run(totals.total_ht, totals.total_tva, totals.total_ttc, totals.total_ht, global, id);
      this.enqueue(ctx, 'supplier_invoice', id, 'upsert', {});
      this.audit(ctx.userId, 'supplier_invoice.correct', 'supplier_invoice', id, { number: inv.number, from: inv.total_ttc, to: totals.total_ttc, lines: input.lines.length });
      return this.getInvoice(id);
    });
  }

  /** Lignes d'une facture directe (son bon de réception), pour l'affichage et l'impression. */
  invoiceLines(invoiceId: string): ReceptionDetail['lines'] {
    const ids = this.db.prepare('SELECT id FROM receptions WHERE invoice_id = ? ORDER BY received_at').pluck().all(invoiceId) as string[];
    return ids.flatMap((id) => this.getReception(id).lines);
  }

  private invoiceQuery(where: string) {
    return this.db.prepare(
      `SELECT i.*, s.name AS supplier_name,
              COALESCE((SELECT SUM(p.amount) FROM supplier_payments p WHERE p.invoice_id = i.id), 0)
              + COALESCE((SELECT SUM(o.amount) FROM account_offsets o WHERE o.invoice_id = i.id AND o.status = 'active'), 0) AS paid
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
  paySupplier(
    ctx: Context,
    input: {
      invoiceId: string;
      method: SupplierPaymentMethod;
      amount: Fcfa;
      reference?: string | null;
      paidAt?: string;
      registerId?: string | null;
      /** Payé ou remboursé dans une caisse ouverte (« Décaisser », « Encaisser ») : espèces du tiroir ou compte MoMo/OM de la caisse. */
      sessionId?: string | null;
    },
  ): SupplierInvoice {
    const invoice = this.getInvoice(input.invoiceId);
    if (!(input.method in SUPPLIER_PAYMENT_METHODS)) throw new AppError('Mode de règlement inconnu', 'INVALID');
    if (!Number.isSafeInteger(input.amount) || input.amount <= 0) throw new AppError('Montant invalide', 'INVALID');
    if (input.amount > invoice.balance) throw new AppError(`Le montant dépasse le reste à payer (${invoice.balance} FCFA)`, 'INVALID');
    if (input.method !== 'CASH' && !input.reference?.trim()) throw new AppError('La référence du règlement est obligatoire', 'INVALID');
    if (input.paidAt) this.assertPeriodOpen(ctx.storeId, input.paidAt);
    // Payé par MoMo/OM : il sort de la caisse électronique choisie, sinon de la centrale (un avoir remboursé n'y est pas rattaché).
    const src = input.sessionId
      ? new EmoneyService(this.db, this.clock).openSession(ctx.storeId, input.sessionId, input.method)
      : invoice.kind === 'invoice'
        ? new EmoneyService(this.db, this.clock).source(ctx.storeId, input.method, input.registerId)
        : { registerId: null, sessionId: null };
    return this.tx(() => {
      const id = newId();
      this.db
        .prepare(
          `INSERT INTO supplier_payments (id, invoice_id, supplier_id, store_id, method, amount, reference, paid_at, user_id, from_central, register_id, session_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        // Espèces payées au bureau : elles sortent de la caisse centrale.
        .run(
          id,
          invoice.id,
          invoice.supplier_id,
          ctx.storeId,
          input.method,
          input.amount,
          input.reference?.trim() || null,
          input.paidAt ?? this.now(),
          ctx.userId,
          input.method === 'CASH' && !src.sessionId ? 1 : 0,
          src.registerId,
          src.sessionId,
        );
      this.enqueue(ctx, 'supplier_payment', id, 'upsert', {});
      this.audit(ctx.userId, 'supplier.payment', 'supplier_invoice', invoice.id, { amount: input.amount, method: input.method });
      return this.getInvoice(invoice.id);
    });
  }

  /**
   * Gratuits reçus des fournisseurs (bonus « N achetés, M payés » et unités offertes) sur une
   * période : quantité et valeur au prix du fournisseur, par fournisseur et par article.
   */
  freeGoods(storeId: string, from: string, to: string): {
    rows: { supplier_id: string | null; supplier_name: string; article_id: string; article_name: string; unit: string; free_qty: Milli; value: Fcfa; receptions: number }[];
    total: Fcfa;
  } {
    const rows = this.db
      .prepare(
        `SELECT r.supplier_id, COALESCE(s.name, 'Sans fournisseur') AS supplier_name, l.article_id, a.name AS article_name, a.unit,
                SUM(l.free_qty) AS free_qty, CAST(ROUND(SUM(l.free_qty * COALESCE(l.gross_cost, l.unit_cost) / 1000.0)) AS INTEGER) AS value,
                COUNT(DISTINCT r.id) AS receptions
         FROM reception_lines l JOIN receptions r ON r.id = l.reception_id JOIN articles a ON a.id = l.article_id LEFT JOIN suppliers s ON s.id = r.supplier_id
         WHERE r.store_id = ? AND l.free_qty > 0 AND date(r.received_at, 'localtime') BETWEEN ? AND ?
         GROUP BY r.supplier_id, l.article_id ORDER BY supplier_name, value DESC`,
      )
      .all(storeId, from, to) as { supplier_id: string | null; supplier_name: string; article_id: string; article_name: string; unit: string; free_qty: Milli; value: Fcfa; receptions: number }[];
    return { rows, total: rows.reduce((t, r) => t + r.value, 0) };
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
  reorderProposal(storeId: string, opts: ReorderOptions = {}): ReorderRow[] {
    const historyDays = opts.historyDays ?? 28;
    const boost = opts.boostPct ?? 0;
    if (!Number.isFinite(boost) || boost < -50 || boost > 300) throw new AppError('Majoration entre -50 % et +300 %', 'INVALID');
    const nowMs = this.clock().getTime();
    const since = new Date(nowMs - historyDays * 86_400_000).toISOString();
    // Même période l'an dernier : les semaines passées (évolution) et celles à venir (saison).
    const lyNow = nowMs - 364 * 86_400_000;
    const coverAhead = Math.max(historyDays, (opts.coverDays ?? 7) + 7);
    const lyPastFrom = new Date(lyNow - historyDays * 86_400_000).toISOString();
    const lyNowIso = new Date(lyNow).toISOString();
    const lyNextTo = new Date(lyNow + coverAhead * 86_400_000).toISOString();
    const rows = this.db
      .prepare(
        `SELECT a.id AS article_id, a.code AS article_code, a.name AS article_name, a.unit, a.unit_name, a.min_qty, a.alert_qty, a.max_qty,
                a.purchase_price, f.name AS family_name, d.id AS department_id, d.name AS department_name,
                COALESCE((SELECT SUM(s.qty) FROM stock s JOIN warehouses w ON w.id = s.warehouse_id
                           WHERE s.article_id = a.id AND w.store_id = @storeId AND w.purpose = 'stock'), 0) AS stock,
                COALESCE((SELECT SUM(MAX(l.qty - COALESCE((SELECT SUM(rl.qty) FROM reception_lines rl WHERE rl.order_line_id = l.id), 0), 0))
                           FROM purchase_order_lines l JOIN purchase_orders o ON o.id = l.order_id
                           WHERE l.article_id = a.id AND o.store_id = @storeId AND o.status IN ('draft', 'sent')), 0) AS on_order,
                COALESCE((SELECT -SUM(m.qty) FROM stock_movements m JOIN warehouses w ON w.id = m.warehouse_id
                           WHERE m.article_id = a.id AND w.store_id = @storeId AND m.type IN ('SALE', 'RETURN') AND m.at >= @since), 0) AS sold,
                COALESCE((SELECT -SUM(m.qty) FROM stock_movements m JOIN warehouses w ON w.id = m.warehouse_id
                           WHERE @season = 1 AND m.article_id = a.id AND w.store_id = @storeId AND m.type IN ('SALE', 'RETURN') AND m.at >= @lyPastFrom AND m.at < @lyNow), 0) AS sold_ly_past,
                COALESCE((SELECT -SUM(m.qty) FROM stock_movements m JOIN warehouses w ON w.id = m.warehouse_id
                           WHERE @season = 1 AND m.article_id = a.id AND w.store_id = @storeId AND m.type IN ('SALE', 'RETURN') AND m.at >= @lyNow AND m.at < @lyNextTo), 0) AS sold_ly_next,
                COALESCE((SELECT SUM(x.qty) FROM missed_sales x WHERE x.article_id = a.id AND x.store_id = @storeId AND x.created_at >= @since), 0) AS missed
         FROM articles a LEFT JOIN families f ON f.id = a.family_id LEFT JOIN departments d ON d.id = f.department_id WHERE a.active = 1`,
      )
      .all({ storeId, since, season: opts.method === 'season' ? 1 : 0, lyPastFrom, lyNow: lyNowIso, lyNextTo }) as {
      article_id: string;
      article_code: string;
      article_name: string;
      unit: ReorderRow['unit'];
      min_qty: number | null;
      alert_qty: number | null;
      max_qty: number | null;
      purchase_price: number;
      unit_name: string | null;
      family_name: string | null;
      department_id: string | null;
      department_name: string | null;
      stock: number;
      on_order: number;
      sold: number;
      sold_ly_past: number;
      sold_ly_next: number;
      missed: number;
    }[];
    const mainSupplier = this.db.prepare(
      `SELECT sa.supplier_id, s.name AS supplier_name, s.lead_time_days, s.visit_days, sa.supplier_ref, sa.unit_cost, sa.pack_qty
       FROM supplier_articles sa JOIN suppliers s ON s.id = sa.supplier_id
       WHERE sa.article_id = ? AND s.active = 1 ORDER BY sa.is_main DESC, sa.unit_cost LIMIT 1`,
    );
    const packsOf = this.db.prepare('SELECT name, units FROM article_packs WHERE article_id = ? ORDER BY units DESC');
    const result: ReorderRow[] = [];
    for (const r of rows) {
      const sup = mainSupplier.get(r.article_id) as
        | { supplier_id: string; supplier_name: string; lead_time_days: number; visit_days: string | null; supplier_ref: string | null; unit_cost: number; pack_qty: number }
        | undefined;
      if (opts.supplierId && sup?.supplier_id !== opts.supplierId) continue;
      // Les demandes non servies comptent comme des ventes : le rayon vide ne fait pas baisser la commande.
      const recentDaily = Math.max(0, (r.sold + r.missed) / historyDays);
      let avg = recentDaily;
      let lastYearDaily: number | null = null;
      let trend: number | null = null;
      if (opts.method === 'season' && r.sold_ly_next > 0) {
        lastYearDaily = r.sold_ly_next / coverAhead;
        // Évolution : ventes récentes comparées aux mêmes semaines de l'an dernier, bornée de ×0,5 à ×2.
        trend = r.sold_ly_past > 0 ? Math.min(2, Math.max(0.5, r.sold / r.sold_ly_past)) : 1;
        avg = lastYearDaily * trend;
      }
      const avgDaily = Math.max(0, Math.round(avg * (1 + boost / 100)));
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
        department_id: r.department_id,
        department_name: r.department_name,
        family_name: r.family_name,
        unit_name: r.unit_name,
        packs: packsOf.all(r.article_id) as { name: string; units: Milli }[],
        missed: r.missed,
        next_visit: nextVisit(sup?.visit_days ?? null, this.today()),
        ...(opts.method === 'season' ? { last_year_daily: lastYearDaily === null ? null : Math.round(lastYearDaily), trend: trend === null ? null : Math.round(trend * 100) / 100 } : {}),
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
export function taxTotals(lines: { ht: Fcfa; rate: number }[]): { total_ht: Fcfa; total_tva: Fcfa; total_ttc: Fcfa } {
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

/** Jours de passage « 1,4 » (lundi, jeudi) → liste triée de 1 à 7. */
export function parseVisitDays(v: string | null | undefined): number[] {
  return [...new Set((v ?? '').split(/[,\s]+/).map(Number).filter((d) => Number.isInteger(d) && d >= 1 && d <= 7))].sort();
}

/** Prochain jour de passage à partir d'aujourd'hui compris (AAAA-MM-JJ), null sans calendrier. */
export function nextVisit(visitDays: string | null, today: string): string | null {
  const days = parseVisitDays(visitDays);
  if (!days.length) return null;
  const t = new Date(`${today}T00:00:00Z`);
  for (let i = 0; i < 7; i++) {
    const d = new Date(t.getTime() + i * 86_400_000);
    const iso = d.getUTCDay() === 0 ? 7 : d.getUTCDay();
    if (days.includes(iso)) return d.toISOString().slice(0, 10);
  }
  return null;
}
