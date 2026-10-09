import {
  type CartLine,
  type DenominationCount,
  type Fcfa,
  type Milli,
  type Payment,
  type PaymentMethod,
  type PriceLevel,
  type PromotedLine,
  PAYMENT_METHODS,
  applyPromotions,
  closingDifference,
  computeTotals,
  lineTotal,
  requiresReference,
  settle,
  splitTtc,
  formatFcfa,
  levelCost,
  tariffPrice,
} from '@superette/core';
import type { AdminService } from './admin';
import type { CatalogueService } from './catalogue';
import type { CustomerService } from './customers';
import type { PromotionService } from './promotions';
import type { QuoteService } from './quotes';
import type { StockService } from './stock';
import type { TreasuryService } from './treasury';
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
  closed_by: string | null;
  closed_by_name?: string | null;
  /** Fond laissé dans le tiroir à la clôture précédente (null : première journée ou ancienne version). */
  carried_float: Fcfa | null;
  /** Premier comptage saisi à la clôture, avant que l'attendu soit montré. */
  first_counted: Fcfa | null;
  /** Fond laissé dans le tiroir pour la journée suivante. */
  float_left: Fcfa | null;
  /** Espèces versées à la caisse centrale à la clôture. */
  deposit: Fcfa | null;
  gap_reason: string | null;
  gap_approved_by: string | null;
}

/** Ligne d'entrée ou de sortie d'espèces d'une journée de caisse. */
export interface CashJournalRow {
  at: string;
  amount: Fcfa;
  nature: string;
  label: string;
  party: string | null;
  user_name: string | null;
  /** Versement de clôture : après le comptage, il ne compte pas dans l'attendu. */
  closing?: boolean;
}

/** Clôture : fond laissé dans le tiroir, le reste est versé à la caisse centrale. */
export interface CloseOptions {
  /** Fond laissé pour le lendemain ; tout ce qui est compté au-delà va à la centrale. Absent : rien n'est versé. */
  floatLeft?: Fcfa;
  /** Motif d'un écart au-delà du seuil du magasin. */
  gapReason?: string | null;
  /** Gérant qui valide un écart au-delà du seuil. */
  gapApprovedBy?: string | null;
}

/** Ligne envoyée par l'écran de caisse : le prix est relu en base, jamais pris de l'écran. */
export interface SaleLineInput {
  articleId: string;
  /** En unités de détail, même pour une vente par conditionnement. */
  qty: Milli;
  barcode?: string | null;
  discount?: Fcfa;
  /** Conditionnement vendu (carton, paquet) : la quantité en est un multiple. */
  packId?: string | null;
  /** Prix TTC saisi à la caisse pour l'unité ou le conditionnement vendu ; jamais sous le revient. */
  price?: Fcfa | null;
}

export type PricedLine = PromotedLine<CartLine & { barcode: string | null; packId: string | null; packName: string | null }>;

/**
 * Ligne de la recherche « Rechercher/Facturer des marchandises » : un article
 * apparaît une fois par conditionnement (PALETTE, puis CANETTE), avec son prix
 * au tarif du client.
 */
export interface SaleSearchRow {
  article_id: string;
  code: string;
  other_ref: string | null;
  name: string;
  unit: 'piece' | 'kg' | 'litre';
  /** Conditionnement (null = unité de détail). */
  pack_id: string | null;
  pack_name: string;
  /** Unités de détail contenues (millièmes). */
  units: Milli;
  /** Stock du dépôt de vente, en unités de détail. */
  stock: Milli;
  warehouse: string;
  /** PV TTC au tarif du client. */
  price: Fcfa;
  /** Dernier prix de vente de ce conditionnement (à ce client s'il est choisi). */
  last_price: Fcfa | null;
  /** Coût de revient du conditionnement : plancher du prix saisi. */
  cost: Fcfa;
  /** Stock insuffisant pour en vendre un seul : la ligne est « Épuisé » et ne se vend pas. */
  out_of_stock: boolean;
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
  /** Nom donné par un client comptoir (sans fiche client), imprimé sur le ticket et la facture. */
  clientName?: string | null;
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
  total_promo: Fcfa;
  price_level: PriceLevel;
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
    promo: Fcfa;
    promotion_name: string | null;
    pack_name: string | null;
    pack_units: Milli | null;
    pack_price: Fcfa | null;
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
  /** Économies accordées par les promotions. */
  promotions: Fcfa;
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
    private readonly promotions: PromotionService,
    private readonly treasury: TreasuryService,
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
      .prepare(
        `SELECT s.*, u.name AS user_name, c.name AS closed_by_name FROM cash_sessions s JOIN users u ON u.id = s.user_id
         LEFT JOIN users c ON c.id = s.closed_by WHERE s.id = ?`,
      )
      .get(id) as CashSession | undefined;
    if (!s) throw new AppError('Session de caisse introuvable', 'NOT_FOUND');
    return s;
  }

  /** Jour local (AAAA-MM-JJ) d'un horodatage, comme `today()`. */
  private localDay(iso: string): string {
    const d = new Date(iso);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  /** Caisse ouverte : sans elle, aucune vente ni opération d'espèces. */
  private requireOpenSession(ctx: Context): CashSession {
    const session = this.currentSession(this.requireRegister(ctx));
    if (!session) throw new AppError("La caisse n'est pas ouverte : ouvrez-la dans Trésorerie › Opérations de trésorerie", 'SESSION_CLOSED');
    return session;
  }

  /** Journée ouverte un jour précédent et pas encore clôturée (signalée à l'écran). */
  isStale(session: Pick<CashSession, 'opened_at'>): boolean {
    return this.localDay(session.opened_at) < this.today();
  }

  /** Dernière journée clôturée de la caisse. */
  lastClosedSession(registerId: string): CashSession | null {
    const id = this.db
      .prepare("SELECT id FROM cash_sessions WHERE register_id = ? AND status = 'closed' ORDER BY closed_at DESC LIMIT 1")
      .pluck()
      .get(registerId) as string | undefined;
    return id ? this.getSession(id) : null;
  }

  /**
   * Fond trouvé dans le tiroir à l'ouverture : celui laissé à la dernière
   * clôture. Null si aucune clôture ne l'a noté (première journée, ancienne version).
   */
  carriedFloat(registerId: string): Fcfa | null {
    return this.lastClosedSession(registerId)?.float_left ?? null;
  }

  /**
   * Ouverture de la journée avec son fond de caisse. Le fond reprend celui
   * laissé la veille ; un complément est pris dans la caisse centrale, un
   * excédent lui est rendu, chacun tracé dans le livre de la centrale.
   */
  openSession(ctx: Context, openingFloat: Fcfa): CashSession {
    const registerId = this.requireRegister(ctx);
    if (!Number.isSafeInteger(openingFloat) || openingFloat < 0) throw new AppError('Fond de caisse invalide', 'INVALID');
    const open = this.currentSession(registerId);
    if (open) {
      throw new AppError(this.isStale(open) ? 'La journée précédente n’est pas clôturée : fermez d’abord la caisse' : 'La caisse est déjà ouverte', 'SESSION_OPEN');
    }
    const carried = this.carriedFloat(registerId);
    const register = this.admin.getRegister(registerId);
    const id = newId();
    this.tx(() => {
      this.db
        .prepare(
          `INSERT INTO cash_sessions (id, store_id, register_id, user_id, opened_at, opening_float, carried_float, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'open')`,
        )
        .run(id, ctx.storeId, registerId, ctx.userId, this.now(), openingFloat, carried);
      if (carried !== null && openingFloat !== carried) {
        const delta = openingFloat - carried;
        this.treasury.insertMovement(ctx, {
          kind: delta > 0 ? 'FLOAT' : 'DEPOSIT',
          nature: 'register',
          amount: Math.abs(delta),
          label: delta > 0 ? `Complément du fond de ${register.name}` : `Fond excédentaire de ${register.name} rendu à la centrale`,
          registerId,
          sessionId: id,
        });
      }
      this.enqueue(ctx, 'cash_session', id, 'upsert', this.getSession(id));
      this.audit(ctx.userId, 'cash.open', 'cash_session', id, { openingFloat, carried });
    });
    return this.getSession(id);
  }

  /**
   * Apport (IN) ou prélèvement (OUT) d'espèces en cours de journée : l'apport
   * vient de la caisse centrale, le prélèvement y est versé.
   */
  cashOperation(ctx: Context, type: 'IN' | 'OUT', amount: Fcfa, reason: string): void {
    const session = this.requireOpenSession(ctx);
    if (!Number.isSafeInteger(amount) || amount <= 0) throw new AppError('Montant invalide', 'INVALID');
    if (!reason.trim()) throw new AppError('Le motif est obligatoire', 'INVALID');
    const register = this.admin.getRegister(session.register_id);
    this.tx(() => {
      const id = newId();
      const row = { id, session_id: session.id, type, amount, reason: reason.trim(), user_id: ctx.userId, at: this.now() };
      this.db
        .prepare('INSERT INTO cash_operations (id, session_id, type, amount, reason, user_id, at) VALUES (@id, @session_id, @type, @amount, @reason, @user_id, @at)')
        .run(row);
      this.enqueue(ctx, 'cash_operation', id, 'upsert', row);
      this.treasury.insertMovement(ctx, {
        kind: type === 'IN' ? 'FLOAT' : 'DEPOSIT',
        nature: 'register',
        amount,
        label: `${type === 'IN' ? 'Apport à' : 'Prélèvement de'} ${register.name} : ${reason.trim()}`,
        registerId: session.register_id,
        sessionId: session.id,
        cashOperationId: id,
      });
      this.audit(ctx.userId, type === 'IN' ? 'cash.in' : 'cash.out', 'cash_session', session.id, { amount, reason });
    });
  }

  // --- Ventes ---------------------------------------------------------------

  private nextTicketNumber(ctx: Context): string {
    const store = this.admin.getStore(ctx.storeId);
    const register = this.admin.getRegister(this.requireRegister(ctx));
    // La caisse suit l'utilisateur d'un PC à l'autre : la suite reprend après le plus
    // grand numéro connu pour cette caisse (ventes reçues des autres PC comprises).
    const prefix = `${store.code}-${register.number}-`;
    const known = this.db
      .prepare('SELECT MAX(CAST(substr(number, ?) AS INTEGER)) FROM sales WHERE register_id = ? AND number LIKE ?')
      .pluck()
      .get(prefix.length + 1, register.id, `${prefix}%`) as number | null;
    if (known) this.raiseCounter(`ticket:${register.id}`, known);
    const seq = this.nextCounter(`ticket:${register.id}`);
    return `${prefix}${String(seq).padStart(6, '0')}`;
  }

  /** Recalcule les lignes à partir des prix en base (prix magasin, étiquettes balance). */
  /** Prix des lignes au tarif du magasin, promotions du jour comprises. */
  /**
   * Prix des lignes au tarif du client (détail, gros, super gros) : prix du magasin pour
   * l'unité au détail, prix du conditionnement pour un carton ou un paquet. Les
   * promotions ne valent qu'au détail.
   */
  priceLines(storeId: string, input: SaleLineInput[], level: PriceLevel = 'retail'): PricedLine[] {
    // Magasin non assujetti (régime simplifié) : aucune TVA sur ses ventes.
    const vat = this.admin.getStore(storeId).vat_enabled === 1;
    const lines = input.map((l) => {
      if (!Number.isSafeInteger(l.qty) || l.qty === 0) throw new AppError('Quantité invalide', 'INVALID');
      const article = this.catalogue.getArticle(l.articleId, storeId);
      if (!article.active) throw new AppError(`Article inactif : ${article.name}`, 'INACTIVE');
      const scan = l.barcode ? this.catalogue.scan(l.barcode, storeId) : null;
      const fixedAmount = scan && scan.article.id === article.id && scan.fixedAmount !== undefined && l.qty === scan.qty ? scan.fixedAmount : undefined;
      const discount = l.discount ?? 0;
      if (!Number.isSafeInteger(discount) || discount < 0) throw new AppError('Remise invalide', 'INVALID');
      const pack = l.packId ? article.packs.find((p) => p.id === l.packId) : undefined;
      if (l.packId && !pack) throw new AppError(`Conditionnement inconnu pour ${article.name}`, 'INVALID');
      if (pack && l.qty % pack.units !== 0) throw new AppError(`${article.name} : la quantité doit être un nombre entier de ${pack.name}`, 'INVALID');
      const price = l.price ?? null;
      if (price !== null) {
        if (!Number.isSafeInteger(price) || price <= 0) throw new AppError(`Prix invalide : ${article.name}`, 'INVALID');
        const floor = levelCost(article, pack?.units ?? 1000);
        if (price < floor) {
          throw new AppError(`${article.name} : le prix ne peut pas descendre sous le coût de revient (${formatFcfa(floor)} ${pack ? `par ${pack.name.toLowerCase()}` : 'par unité'})`, 'BELOW_COST');
        }
      }
      const line: CartLine & { barcode: string | null; packId: string | null; packName: string | null } = {
        articleId: article.id,
        label: article.name,
        unitPrice: tariffPrice({ retail: article.store_price, wholesale: article.wholesale_price, superWholesale: article.super_wholesale_price }, level),
        qty: l.qty,
        vatRate: vat ? article.vat_rate_bp : 0,
        discount,
        fixedAmount,
        barcode: l.barcode ?? null,
        packId: pack?.id ?? null,
        packName: pack?.name ?? null,
        ...(pack
          ? {
              packPrice: price ?? tariffPrice({ retail: pack.sale_price, wholesale: pack.wholesale_price, superWholesale: pack.super_wholesale_price }, level),
              packUnits: pack.units,
            }
          : {}),
        ...(price !== null && !pack ? { unitPrice: price } : {}),
        ...(price !== null ? { priceSet: true } : {}),
      };
      if (lineTotal(line) < 0) throw new AppError(`Remise supérieure au prix : ${article.name}`, 'INVALID');
      return line;
    });
    return applyPromotions(lines, level === 'retail' ? this.promotions.activeRules(storeId) : []);
  }

  /**
   * Recherche en caisse, une ligne par conditionnement, du plus grand au plus
   * petit. Les lignes épuisées sont listées et marquées (sauf `includeEmpty: false`).
   */
  searchForSale(storeId: string, query: string, opts: { customerId?: string | null; includeEmpty?: boolean; limit?: number } = {}): SaleSearchRow[] {
    const articles = this.catalogue.suggestArticles(query, storeId, 50);
    if (articles.length === 0) return [];
    const level = opts.customerId ? this.customers.getCustomer(opts.customerId).price_level : 'retail';
    const warehouse = this.admin.salesWarehouse(storeId);
    const ids = articles.map((a) => a.id);
    const marks = ids.map(() => '?').join(',');
    const stock = new Map(
      (this.db.prepare(`SELECT article_id, qty FROM stock WHERE warehouse_id = ? AND article_id IN (${marks})`).all(warehouse.id, ...ids) as { article_id: string; qty: Milli }[]).map(
        (r) => [r.article_id, r.qty],
      ),
    );
    // Dernier prix : la ligne la plus récente pour chaque article et conditionnement (MAX ramène sa ligne).
    const last = new Map(
      (
        this.db
          .prepare(
            `SELECT l.article_id, COALESCE(l.pack_name, '') AS pack, COALESCE(l.pack_price, l.unit_price) AS price, MAX(s.created_at) AS at
             FROM sale_lines l JOIN sales s ON s.id = l.sale_id
             WHERE s.store_id = ? AND s.kind = 'sale' AND s.status = 'completed' AND l.article_id IN (${marks})
               AND (? IS NULL OR s.customer_id = ?)
             GROUP BY l.article_id, COALESCE(l.pack_name, '')`,
          )
          .all(storeId, ...ids, opts.customerId ?? null, opts.customerId ?? null) as { article_id: string; pack: string; price: Fcfa }[]
      ).map((r) => [`${r.article_id}|${r.pack}`, r.price]),
    );
    const unitLabel = { piece: 'Pièce', kg: 'Kg', litre: 'Litre' } as const;
    const rows: SaleSearchRow[] = [];
    for (const a of articles) {
      const qty = stock.get(a.id) ?? 0;
      const base = { article_id: a.id, code: a.code, other_ref: a.other_ref, name: a.name, unit: a.unit, stock: qty, warehouse: warehouse.name };
      for (const p of a.packs) {
        rows.push({
          ...base,
          pack_id: p.id,
          pack_name: p.name,
          units: p.units,
          cost: levelCost(a, p.units),
          out_of_stock: qty < p.units,
          price: tariffPrice({ retail: p.sale_price, wholesale: p.wholesale_price, superWholesale: p.super_wholesale_price }, level),
          last_price: last.get(`${a.id}|${p.name}`) ?? null,
        });
      }
      rows.push({
        ...base,
        pack_id: null,
        pack_name: a.unit_name ?? unitLabel[a.unit],
        units: 1000,
        cost: levelCost(a, 1000),
        out_of_stock: a.unit === 'piece' ? qty < 1000 : qty <= 0,
        price: tariffPrice({ retail: a.store_price, wholesale: a.wholesale_price, superWholesale: a.super_wholesale_price }, level),
        last_price: last.get(`${a.id}|`) ?? null,
      });
    }
    const shown = opts.includeEmpty === false ? rows.filter((r) => !r.out_of_stock) : rows;
    return shown.slice(0, opts.limit ?? 60);
  }

  /**
   * Un produit épuisé ne se vend pas : le stock du dépôt de vente doit couvrir
   * le ticket. Avec « Ignorer la gestion des stocks », la vente passe et renvoie
   * les lignes vendues sans stock, que la prochaine réception régularise.
   */
  private assertInStock(storeId: string, lines: { articleId: string; label: string; qty: Milli }[]): { label: string; qty: Milli; stock: Milli }[] {
    const warehouse = this.admin.salesWarehouse(storeId);
    const ignore = this.admin.getStore(storeId).ignore_stock === 1;
    const short: { label: string; qty: Milli; stock: Milli }[] = [];
    const wanted = new Map<string, { label: string; qty: Milli }>();
    for (const l of lines) {
      const w = wanted.get(l.articleId);
      wanted.set(l.articleId, { label: l.label, qty: (w?.qty ?? 0) + l.qty });
    }
    const get = this.db.prepare('SELECT a.unit, a.unit_name, COALESCE(s.qty, 0) AS qty FROM articles a LEFT JOIN stock s ON s.article_id = a.id AND s.warehouse_id = ? WHERE a.id = ?');
    for (const [articleId, w] of wanted) {
      const a = get.get(warehouse.id, articleId) as { unit: string; unit_name: string | null; qty: Milli };
      if (w.qty <= a.qty) continue;
      if (ignore) {
        short.push({ label: w.label, qty: w.qty, stock: a.qty });
        continue;
      }
      const unit = a.unit === 'piece' ? (a.unit_name ?? 'pièce').toLowerCase() : a.unit === 'kg' ? 'kg' : 'L';
      const left = a.qty <= 0 ? 'épuisé' : `il reste ${String(a.qty / 1000).replace('.', ',')} ${unit}`;
      throw new AppError(`Stock insuffisant pour ${w.label} : ${left}`, 'OUT_OF_STOCK');
    }
    return short;
  }

  completeSale(ctx: Context, input: SaleInput): Sale {
    const session = this.requireOpenSession(ctx);
    if (input.lines.length === 0) throw new AppError('Ticket vide', 'EMPTY');
    if (input.lines.some((l) => l.qty < 0)) throw new AppError('Quantité négative : utilisez le retour client', 'INVALID');
    const level = input.customerId ? this.customers.getCustomer(input.customerId).price_level : 'retail';
    const lines = this.priceLines(ctx.storeId, input.lines, level);
    const totals = computeTotals(lines);
    const quote = input.quoteId ? this.quotes.authorizeSaleDiscounts(ctx.storeId, input.quoteId, lines) : null;
    let discountBy = input.discountAuthorizedBy ?? null;
    if (quote) discountBy ??= quote.by;
    if (totals.totalDiscount > 0 && !quote) {
      const user = this.admin.getUser(ctx.userId);
      const authorizer = input.discountAuthorizedBy ? this.admin.getUser(input.discountAuthorizedBy) : null;
      // Droit « remise sans code » du vendeur, ou code d'un gérant.
      const supervisor = authorizer !== null && (authorizer.role === 'admin' || authorizer.role === 'manager');
      if (!this.admin.hasRight(user, 'discount') && !supervisor) throw new AppError('Remise soumise à validation du gérant', 'SUPERVISOR_REQUIRED');
    }
    for (const p of input.payments) {
      if (!(p.method in PAYMENT_METHODS)) throw new AppError(`Moyen de paiement inconnu : ${p.method}`, 'INVALID');
      if (requiresReference(p.method) && !p.reference?.trim()) {
        throw new AppError(`Référence de transaction obligatoire pour ${PAYMENT_METHODS[p.method]}`, 'REFERENCE_REQUIRED');
      }
    }
    const withoutStock = this.assertInStock(ctx.storeId, lines);
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
             total_tva, total_discount, total_promo, price_level, change_given, customer_id, client_name, due_date, created_at)
           VALUES (?, ?, 'sale', ?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          totals.totalPromo,
          level,
          settlement.change,
          customer?.id ?? null,
          customer ? null : input.clientName?.trim().slice(0, 80) || null,
          due,
          now,
        );
      const insertLine = this.db.prepare(
        `INSERT INTO sale_lines (id, sale_id, line_no, article_id, label, barcode, qty, unit_price, discount, vat_rate_bp, total_ttc, unit_cost, promo, promotion_id,
           pack_name, pack_units, pack_price)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        insertLine.run(newId(), saleId, i + 1, line.articleId, line.label, line.barcode, line.qty, line.unitPrice, line.discount, line.vatRate, lineTotal(line), unitCost, line.promo, line.promotionId,
          line.packName, line.packUnits ?? null, line.packPrice ?? null,
        );
      });
      const insertPayment = this.db.prepare('INSERT INTO sale_payments (id, sale_id, method, amount, reference) VALUES (?, ?, ?, ?, ?)');
      for (const p of input.payments) insertPayment.run(newId(), saleId, p.method, p.amount, p.reference?.trim() || null);
      if (totals.totalDiscount > 0) {
        this.audit(ctx.userId, 'sale.discount', 'sale', saleId, { amount: totals.totalDiscount, authorizedBy: discountBy, quoteId: input.quoteId ?? null });
      }
      const changed = lines.filter((l) => l.priceSet);
      if (changed.length) {
        this.audit(ctx.userId, 'sale.price_set', 'sale', saleId, {
          lines: changed.map((l) => ({ article: l.label, pack: l.packName, price: l.packPrice ?? l.unitPrice })),
        });
      }
      if (withoutStock.length) this.audit(ctx.userId, 'sale.without_stock', 'sale', saleId, { number, lines: withoutStock });
      if (input.quoteId) this.quotes.markAccepted(ctx, input.quoteId, saleId);
      const sale = this.getSale(saleId);
      this.enqueue(ctx, 'sale', saleId, 'upsert', sale);
      return sale;
    });
  }

  getSale(id: string): Sale {
    const sale = this.db
      .prepare(
        `SELECT s.*, u.name AS user_name, COALESCE(c.name, s.client_name) AS customer_name FROM sales s JOIN users u ON u.id = s.user_id
         LEFT JOIN customers c ON c.id = s.customer_id WHERE s.id = ?`,
      )
      .get(id) as Omit<Sale, 'lines' | 'payments'> | undefined;
    if (!sale) throw new AppError('Ticket introuvable', 'NOT_FOUND');
    const lines = this.db
      .prepare(
        `SELECT l.id, l.line_no, l.article_id, l.label, l.barcode, l.qty, l.unit_price, l.discount, l.vat_rate_bp, l.total_ttc, a.unit,
           l.promo, p.name AS promotion_name, l.pack_name, l.pack_units, l.pack_price
         FROM sale_lines l JOIN articles a ON a.id = l.article_id LEFT JOIN promotions p ON p.id = l.promotion_id
         WHERE l.sale_id = ? ORDER BY l.line_no`,
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
        `SELECT s.*, u.name AS user_name, COALESCE(c.name, s.client_name) AS customer_name FROM sales s JOIN users u ON u.id = s.user_id
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
           COALESCE(SUM(CASE WHEN status = 'completed' THEN total_promo END), 0) AS promotions,
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
      promotions: number;
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
      promotions: agg.promotions,
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

  /**
   * Comptage à l'aveugle : le premier total saisi est gardé avant que
   * l'attendu soit montré. Renvoie l'écart et s'il faut un motif et le code du gérant.
   */
  countPreview(ctx: Context, counted: DenominationCount): { expected: Fcfa; counted: Fcfa; difference: Fcfa; threshold: Fcfa; needsApproval: boolean } {
    const session = this.requireOpenSession(ctx);
    const result = closingDifference(this.zReport(session.id).cash, counted);
    if (session.first_counted === null) {
      this.db.prepare('UPDATE cash_sessions SET first_counted = ? WHERE id = ?').run(result.counted, session.id);
    }
    this.audit(ctx.userId, 'cash.count', 'cash_session', session.id, result);
    const threshold = this.admin.getStore(session.store_id).cash_gap_threshold;
    return { ...result, threshold, needsApproval: Math.abs(result.difference) > threshold };
  }

  /**
   * Clôture Z : comptage par coupure, écart, fond laissé pour le lendemain et
   * versement du reste à la caisse centrale. Un écart au-delà du seuil du
   * magasin exige un motif et la validation d'un gérant.
   */
  closeSession(ctx: Context, counted: DenominationCount, opts: CloseOptions = {}): ZReport {
    const session = this.requireOpenSession(ctx);
    const before = this.zReport(session.id);
    const result = closingDifference(before.cash, counted);
    const floatLeft = opts.floatLeft ?? result.counted;
    if (!Number.isSafeInteger(floatLeft) || floatLeft < 0) throw new AppError('Fond laissé invalide', 'INVALID');
    if (floatLeft > result.counted) throw new AppError('Le fond laissé dépasse les espèces comptées', 'INVALID');
    const deposit = result.counted - floatLeft;
    const threshold = this.admin.getStore(session.store_id).cash_gap_threshold;
    const gapReason = opts.gapReason?.trim() || null;
    if (Math.abs(result.difference) > threshold) {
      if (!gapReason) throw new AppError("Écart au-delà du seuil : indiquez le motif de l'écart", 'GAP_REASON_REQUIRED');
      if (!opts.gapApprovedBy) throw new AppError("Écart au-delà du seuil : la validation d'un gérant est nécessaire", 'SUPERVISOR_REQUIRED');
    }
    const register = this.admin.getRegister(session.register_id);
    this.tx(() => {
      const lastZ = this.db.prepare('SELECT MAX(z_number) FROM cash_sessions WHERE register_id = ?').pluck().get(session.register_id) as number | null;
      if (lastZ) this.raiseCounter(`z:${session.register_id}`, lastZ);
      const zNumber = this.nextCounter(`z:${session.register_id}`);
      this.db
        .prepare(
          `UPDATE cash_sessions SET status = 'closed', closed_at = ?, closed_by = ?, counted_detail = ?, expected_cash = ?,
             counted_cash = ?, difference = ?, z_number = ?, first_counted = COALESCE(first_counted, ?), float_left = ?, deposit = ?,
             gap_reason = ?, gap_approved_by = ? WHERE id = ?`,
        )
        .run(
          this.now(),
          ctx.userId,
          JSON.stringify(counted),
          result.expected,
          result.counted,
          result.difference,
          zNumber,
          result.counted,
          floatLeft,
          deposit,
          gapReason,
          opts.gapApprovedBy ?? null,
          session.id,
        );
      if (deposit > 0) {
        this.treasury.insertMovement(ctx, {
          kind: 'DEPOSIT',
          nature: 'register',
          amount: deposit,
          label: `Recette de ${register.name}, Z${zNumber}`,
          registerId: session.register_id,
          sessionId: session.id,
        });
      }
      this.db.prepare('DELETE FROM held_tickets WHERE register_id = ?').run(session.register_id);
      this.enqueue(ctx, 'cash_session', session.id, 'upsert', this.getSession(session.id));
      this.audit(ctx.userId, 'cash.close', 'cash_session', session.id, { zNumber, ...result, floatLeft, deposit, gapReason, gapApprovedBy: opts.gapApprovedBy ?? null });
    });
    return this.zReport(session.id);
  }

  /**
   * Entrées et sorties d'espèces d'une journée, ligne par ligne (comme les
   * « Opérations de trésorerie » de KONTROL) : ventes et règlements encaissés,
   * apports ; remboursements, prélèvements, dépenses et versement de clôture.
   */
  cashJournal(sessionId: string): { entries: CashJournalRow[]; exits: CashJournalRow[]; creditSales: Fcfa } {
    const sales = this.db
      .prepare(
        `SELECT s.created_at AS at, s.number, s.kind, COALESCE(c.name, s.client_name) AS party, u.name AS user_name,
                SUM(p.amount) - s.change_given AS amount
         FROM sales s JOIN sale_payments p ON p.sale_id = s.id AND p.method = 'CASH' JOIN users u ON u.id = s.user_id
         LEFT JOIN customers c ON c.id = s.customer_id
         WHERE s.session_id = ? AND s.status = 'completed' GROUP BY s.id ORDER BY s.created_at`,
      )
      .all(sessionId) as { at: string; number: string; kind: 'sale' | 'return'; party: string | null; user_name: string; amount: number }[];
    const receipts = this.db
      .prepare(
        `SELECT p.paid_at AS at, p.number, c.name AS party, u.name AS user_name, p.amount FROM customer_payments p
         JOIN customers c ON c.id = p.customer_id LEFT JOIN users u ON u.id = p.user_id
         WHERE p.session_id = ? AND p.method = 'CASH' ORDER BY p.paid_at`,
      )
      .all(sessionId) as { at: string; number: string; party: string; user_name: string | null; amount: number }[];
    const ops = this.db
      .prepare('SELECT o.at, o.type, o.amount, o.reason, u.name AS user_name FROM cash_operations o LEFT JOIN users u ON u.id = o.user_id WHERE o.session_id = ? ORDER BY o.at')
      .all(sessionId) as { at: string; type: 'IN' | 'OUT'; amount: number; reason: string; user_name: string | null }[];
    const expenses = this.db
      .prepare(
        `SELECT e.created_at AS at, e.number, e.label, e.beneficiary, e.amount, u.name AS user_name FROM expenses e LEFT JOIN users u ON u.id = e.user_id
         WHERE e.session_id = ? AND e.status = 'active' ORDER BY e.created_at`,
      )
      .all(sessionId) as { at: string; number: string; label: string; beneficiary: string | null; amount: number; user_name: string | null }[];
    const closing = this.db
      .prepare("SELECT at, number, amount, label FROM central_cash_movements WHERE session_id = ? AND kind = 'DEPOSIT' AND cash_operation_id IS NULL ORDER BY at")
      .all(sessionId) as { at: string; number: string; amount: number; label: string }[];
    const credit = this.db
      .prepare(
        `SELECT COALESCE(SUM(p.amount), 0) FROM sale_payments p JOIN sales s ON s.id = p.sale_id
         WHERE s.session_id = ? AND s.status = 'completed' AND p.method = 'CUSTOMER_CREDIT'`,
      )
      .pluck()
      .get(sessionId) as number;
    const entries: CashJournalRow[] = [
      ...sales.filter((x) => x.amount > 0).map((x) => ({ at: x.at, amount: x.amount, nature: 'Vente', label: `Ticket ${x.number}`, party: x.party, user_name: x.user_name })),
      ...receipts.map((x) => ({ at: x.at, amount: x.amount, nature: 'Règlement client', label: `Reçu ${x.number}`, party: x.party, user_name: x.user_name })),
      ...ops.filter((x) => x.type === 'IN').map((x) => ({ at: x.at, amount: x.amount, nature: 'Apport', label: x.reason, party: 'Caisse centrale', user_name: x.user_name })),
    ].sort((a, b) => a.at.localeCompare(b.at));
    const exits: CashJournalRow[] = [
      ...sales.filter((x) => x.amount < 0).map((x) => ({ at: x.at, amount: -x.amount, nature: 'Remboursement', label: `Retour ${x.number}`, party: x.party, user_name: x.user_name })),
      ...ops.filter((x) => x.type === 'OUT').map((x) => ({ at: x.at, amount: x.amount, nature: 'Prélèvement', label: x.reason, party: 'Caisse centrale', user_name: x.user_name })),
      ...expenses.map((x) => ({ at: x.at, amount: x.amount, nature: 'Dépense', label: `${x.number} ${x.label}`, party: x.beneficiary, user_name: x.user_name })),
      ...closing.map((x) => ({ at: x.at, amount: x.amount, nature: 'Versement', label: `${x.number} ${x.label}`, party: 'Caisse centrale', user_name: null, closing: true })),
    ].sort((a, b) => a.at.localeCompare(b.at));
    return { entries, exits, creditSales: credit };
  }

  listSessions(storeId: string, limit = 60, registerId?: string | null): CashSession[] {
    return this.db
      .prepare(
        `SELECT s.*, u.name AS user_name, c.name AS closed_by_name FROM cash_sessions s JOIN users u ON u.id = s.user_id
         LEFT JOIN users c ON c.id = s.closed_by
         WHERE s.store_id = ? AND (? IS NULL OR s.register_id = ?) ORDER BY s.opened_at DESC LIMIT ?`,
      )
      .all(storeId, registerId ?? null, registerId ?? null, limit) as CashSession[];
  }
}
