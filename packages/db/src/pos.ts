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
  type RegisterKind,
  applyPromotions,
  paymentRegisterKind,
  ELECTRONIC_METHODS,
  BANK_METHODS,
  closingDifference,
  computeTotals,
  lineTotal,
  requiresReference,
  settle,
  splitTtc,
  formatFcfa,
  roundCash,
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
import { DELIVERY_FEE_ARTICLE_ID, type DeliveryInput, type DeliveryService } from './deliveries';
import { ENTRY_KINDS, type EmoneyRow, type EmoneyService, type EntryKind, isEmoney } from './emoney';
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
  /** Gérant qui a justifié l'écart, à la clôture ou après coup. */
  gap_approved_by: string | null;
  gap_approved_by_name?: string | null;
  gap_justified_at: string | null;
}

/** Ligne d'entrée ou de sortie d'espèces d'une journée de caisse. */
/** Pièce d'où vient une ligne d'entrée ou de sortie de caisse. */
export type JournalSource =
  | 'sale'
  | 'refund'
  | 'customer_payment'
  | 'cash_operation'
  | 'expense'
  | 'central'
  | 'entry'
  | 'supplier_payment'
  | 'movement'
  | 'rebate';

export interface CashJournalRow {
  source: JournalSource;
  id: string;
  number?: string;
  /** Nature d'une pièce d'« Encaisser » ou « Décaisser » (avance, salaire, autre…). */
  kind?: string | null;
  method_label?: string;
  reference?: string | null;
  at: string;
  amount: Fcfa;
  nature: string;
  label: string;
  party: string | null;
  user_name: string | null;
  /** Auteur de l'opération (null pour le versement de clôture). */
  user_id: string | null;
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
  /** Caisse électronique avec centrale : recette versée vers la centrale, par moyen, avec la référence du transfert. */
  deposit?: Partial<Record<PaymentMethod, { amount: Fcfa; reference?: string | null }>>;
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
  /** Stock de chaque dépôt où le vendeur peut vendre, dépôt choisi en premier : la vente s'y complète. */
  stocks: { warehouse_id: string; name: string; qty: Milli }[];
  /** Total vendable : la somme de ces dépôts. */
  available: Milli;
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
  /** Tarif choisi à la caisse pour cette fiche ; sinon celui du client (détail pour le client comptoir). */
  priceLevel?: PriceLevel | null;
  /** Dépôt d'où sort la marchandise ; sinon le dépôt de vente du magasin. */
  warehouseId?: string | null;
  /** Livraison chez le client : ses frais s'ajoutent au ticket. */
  delivery?: DeliveryInput | null;
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
  /** Arrondi des espèces accordé (compris dans les remises). */
  rounding: Fcfa;
  /** Tickets et factures (A4, listing) déjà imprimés : la réimpression porte « DUPLICATA ». */
  ticket_prints: number;
  invoice_prints: number;
  /** Facture remplacée par celle-ci (modification). */
  replaces_id: string | null;
  /** Annulée puis « supprimée » : masquée du registre. */
  hidden: number;
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
  cash: { openingFloat: Fcfa; cashSales: Fcfa; cashRefunds: Fcfa; cashIn: Fcfa; cashOut: Fcfa; customerReceipts: Fcfa; expenses: Fcfa; otherIn: Fcfa; otherOut: Fcfa; expected: Fcfa };
  counted: Fcfa | null;
  difference: Fcfa | null;
  /** Type de la caisse : une caisse électronique ou banque n'a ni tiroir ni fond. */
  registerKind: RegisterKind;
  /** Caisse électronique ou banque : attendu et solde relevé par moyen de paiement. */
  declared: DeclaredLine[] | null;
  /** Caisse électronique : entrées et sorties de la journée, ligne par ligne. */
  emoneyJournal: { entries: EmoneyRow[]; exits: EmoneyRow[] } | null;
  /** Caisse électronique versée à la centrale : nom de la centrale et numéro du bon. */
  emoneyDeposit: { centralName: string; number: string } | null;
  /** Tickets de cette caisse payés sur la caisse électronique ou banque du caissier. */
  elsewhere: { method: PaymentMethod; label: string; registerName: string; amount: Fcfa }[];
}

/** Détail enregistré à la clôture d'une caisse électronique ou banque, par moyen de paiement. */
export interface DeclaredDetail {
  declared: Record<string, Fcfa>;
  expected: Record<string, Fcfa>;
  /** Caisse électronique : solde de départ, sorties, versé à la centrale et reste pour le lendemain. */
  opening?: Record<string, Fcfa>;
  outflows?: Record<string, Fcfa>;
  inflows?: Record<string, Fcfa>;
  deposited?: Record<string, Fcfa>;
  left?: Record<string, Fcfa>;
  depositNumber?: string | null;
}

/** Clôture d'une caisse électronique ou banque : un moyen de paiement. */
export interface DeclaredLine {
  method: PaymentMethod;
  label: string;
  /** Solde de départ (reste de la dernière clôture et mouvements depuis). */
  opening: Fcfa;
  /** Encaissé dans la journée : ventes, retours et règlements clients. */
  received: Fcfa;
  /** Dépenses, fournisseurs et transferts sortis de la caisse dans la journée (sans le versement de clôture). */
  outflows: Fcfa;
  /** Transferts reçus dans la journée. */
  inflows: Fcfa;
  /** Attendu : départ + encaissé + reçu − sorties. */
  expected: Fcfa;
  /** Montant relevé sur le téléphone, le terminal ou le relevé (null : pas encore clôturée). */
  declared: Fcfa | null;
  /** Versé à la caisse électronique centrale à la clôture. */
  deposited: Fcfa;
  /** Reste sur le compte pour le lendemain (null : pas encore clôturée). */
  left: Fcfa | null;
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
    private readonly emoney: EmoneyService,
    private readonly deliveries: DeliveryService,
  ) {
    super(db, clock);
  }

  /** Dépôt de sortie d'une vente : celui choisi à la caisse (du magasin, actif) ou le dépôt de vente. */
  saleWarehouse(storeId: string, warehouseId?: string | null) {
    if (!warehouseId) return this.admin.salesWarehouse(storeId);
    const wh = this.admin.listWarehouses(storeId).find((w) => w.id === warehouseId);
    if (!wh) throw new AppError('Dépôt indisponible pour ce magasin', 'INVALID');
    return wh;
  }

  /** Ligne « Frais de livraison » (service, sans stock) au montant TTC saisi. */
  deliveryFeeLine(ctx: Pick<Context, 'storeId' | 'registerId'>, fee: Fcfa): PricedLine {
    const article = this.catalogue.getArticle(this.deliveries.feeArticleId(ctx), ctx.storeId);
    return { articleId: article.id, label: article.name, unitPrice: fee, qty: 1000, vatRate: article.vat_rate_bp, discount: 0, barcode: null, packId: null, packName: null, promo: 0, promotionId: null, promotionName: null };
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
        `SELECT s.*, u.name AS user_name, c.name AS closed_by_name, g.name AS gap_approved_by_name FROM cash_sessions s JOIN users u ON u.id = s.user_id
         LEFT JOIN users c ON c.id = s.closed_by LEFT JOIN users g ON g.id = s.gap_approved_by WHERE s.id = ?`,
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

  /** Caisses électronique et banque attribuées à l'utilisateur (null : pas de caisse de ce type). */
  linkedRegisters(userId: string): Record<Exclude<RegisterKind, 'cash'>, string | null> {
    const u = this.admin.getUser(userId);
    return { electronic: u.emoney_register_id, bank: u.bank_register_id };
  }

  /**
   * Journée qui reçoit un paiement : celle de la caisse électronique ou banque
   * du caissier pour ces moyens, sinon celle du ticket. Une caisse attribuée mais
   * fermée refuse le paiement plutôt que de le ranger dans le tiroir.
   */
  sessionFor(ctx: Context, method: string, cashSessionId: string): string {
    const kind = paymentRegisterKind(method);
    if (kind === 'cash') return cashSessionId;
    const registerId = this.linkedRegisters(ctx.userId)[kind];
    if (!registerId) return cashSessionId;
    const open = this.currentSession(registerId);
    if (!open) throw new AppError(`${this.admin.getRegister(registerId).name} est fermée : ouvrez-la dans Trésorerie › Opérations de trésorerie`, 'SESSION_CLOSED');
    return open.id;
  }

  /**
   * Ouvre les caisses électronique et banque de l'utilisateur qui ne le sont pas
   * encore : elles n'ont ni fond ni tiroir. Renvoie les journées ouvertes.
   */
  openLinked(ctx: Context): CashSession[] {
    const opened: CashSession[] = [];
    for (const registerId of Object.values(this.linkedRegisters(ctx.userId))) {
      if (!registerId || this.currentSession(registerId)) continue;
      const reg = this.admin.getRegister(registerId);
      if (!reg.active) continue;
      const id = newId();
      // Caisse électronique : elle repart du reste laissé à sa dernière clôture.
      const opening = reg.kind === 'electronic' ? JSON.stringify(this.emoney.balance(registerId)) : null;
      this.tx(() => {
        this.db
          .prepare(
            `INSERT INTO cash_sessions (id, store_id, register_id, user_id, opened_at, opening_float, carried_float, status, opening_detail)
             VALUES (?, ?, ?, ?, ?, 0, NULL, 'open', ?)`,
          )
          .run(id, ctx.storeId, registerId, ctx.userId, this.now(), opening);
        this.enqueue(ctx, 'cash_session', id, 'upsert', this.getSession(id));
        this.audit(ctx.userId, 'cash.open', 'cash_session', id, { kind: reg.kind });
      });
      opened.push(this.getSession(id));
    }
    return opened;
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
    if (register.kind !== 'cash') throw new AppError(`${register.name} n'est pas une caisse espèces`, 'INVALID');
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
    // Une seule ouverture pour toutes les caisses du caissier.
    this.openLinked(ctx);
    return this.getSession(id);
  }

  /**
   * Apport (IN) ou prélèvement (OUT) d'espèces en cours de journée : l'apport
   * vient de la caisse centrale, le prélèvement y est versé.
   */
  cashOperation(ctx: Context, type: 'IN' | 'OUT', amount: Fcfa, reason: string): string {
    const session = this.requireOpenSession(ctx);
    if (!Number.isSafeInteger(amount) || amount <= 0) throw new AppError('Montant invalide', 'INVALID');
    if (!reason.trim()) throw new AppError('Le motif est obligatoire', 'INVALID');
    const register = this.admin.getRegister(session.register_id);
    return this.tx(() => {
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
      return id;
    });
  }

  // --- Ventes ---------------------------------------------------------------

  private nextTicketNumber(ctx: Context, kind: 'sale' | 'return' = 'sale'): string {
    const store = this.admin.getStore(ctx.storeId);
    const register = this.admin.getRegister(this.requireRegister(ctx));
    // Préfixe des factures ou des avoirs, réglé dans les paramètres (vide par défaut).
    const set = this.admin.storeSettings(ctx.storeId);
    const doc = kind === 'sale' ? set.prefixSale : set.prefixReturn;
    // La caisse suit l'utilisateur d'un PC à l'autre : la suite reprend après le plus
    // grand numéro connu pour cette caisse (ventes reçues des autres PC comprises).
    const prefix = `${doc ? `${doc}-` : ''}${store.code}-${register.number}-`;
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
        // Paramètre « vente sous le prix de revient » : permise si le magasin l'autorise (tracée dans le journal).
        if (price < floor && !this.admin.storeSettings(storeId).allowBelowCost) {
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
  searchForSale(
    storeId: string,
    query: string,
    opts: { customerId?: string | null; includeEmpty?: boolean; limit?: number; priceLevel?: PriceLevel | null; warehouseId?: string | null; userId?: string | null } = {},
  ): SaleSearchRow[] {
    const articles = this.catalogue.suggestArticles(query, storeId, 50);
    if (articles.length === 0) return [];
    const level = opts.priceLevel ?? (opts.customerId ? this.customers.getCustomer(opts.customerId).price_level : 'retail');
    const warehouse = this.saleWarehouse(storeId, opts.warehouseId);
    const sources = this.saleSources(storeId, opts.userId ?? null, warehouse);
    const ids = articles.map((a) => a.id);
    const marks = ids.map(() => '?').join(',');
    const stock = new Map<string, Milli>();
    for (const r of this.db
      .prepare(`SELECT article_id, warehouse_id, qty FROM stock WHERE warehouse_id IN (${sources.map(() => '?').join(',')}) AND article_id IN (${marks})`)
      .all(...sources.map((w) => w.id), ...ids) as { article_id: string; warehouse_id: string; qty: Milli }[]) {
      stock.set(`${r.article_id}|${r.warehouse_id}`, r.qty);
    }
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
      const stocks = sources.map((w) => ({ warehouse_id: w.id, name: w.name, qty: stock.get(`${a.id}|${w.id}`) ?? 0 }));
      // Seul le stock positif d'un dépôt d'appoint complète la vente.
      const qty = stocks.reduce((t, w, i) => t + (i === 0 ? w.qty : Math.max(0, w.qty)), 0);
      const base = { article_id: a.id, code: a.code, other_ref: a.other_ref, name: a.name, unit: a.unit, stock: stocks[0]!.qty, warehouse: warehouse.name, stocks, available: qty };
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
   * Dépôts d'où sort une vente : le dépôt choisi, puis les autres dépôts où le
   * vendeur peut vendre (dépôt de vente d'abord), qui complètent une ligne que
   * le dépôt choisi ne couvre pas.
   */
  private saleSources(storeId: string, userId: string | null, chosen: { id: string; name: string }): { id: string; name: string }[] {
    const others = userId ? this.admin.saleWarehousesFor(storeId, userId).filter((w) => w.id !== chosen.id) : [];
    return [chosen, ...others];
  }

  /**
   * Un produit épuisé ne se vend pas : chaque ligne sort du dépôt choisi, et ce
   * qui y manque se complète dans les autres dépôts du vendeur. Avec « Ignorer
   * la gestion des stocks », le reste sort quand même du dépôt choisi et la
   * vente renvoie les lignes vendues sans stock, que la prochaine réception régularise.
   */
  private planStock(
    storeId: string,
    sources: { id: string; name: string }[],
    lines: { articleId: string; label: string; qty: Milli }[],
  ): { parts: { warehouseId: string; qty: Milli }[][]; short: { label: string; qty: Milli; stock: Milli }[]; complement: { article: string; from: string; qty: Milli }[] } {
    const ignore = this.admin.getStore(storeId).ignore_stock === 1;
    const chosen = sources[0]!;
    const get = this.db.prepare('SELECT a.unit, a.unit_name, a.is_service, COALESCE(s.qty, 0) AS qty FROM articles a LEFT JOIN stock s ON s.article_id = a.id AND s.warehouse_id = ? WHERE a.id = ?');
    const left = new Map<string, Milli>();
    const short = new Map<string, { label: string; qty: Milli; stock: Milli }>();
    const complement: { article: string; from: string; qty: Milli }[] = [];
    const parts = lines.map((l) => {
      const head = get.get(chosen.id, l.articleId) as { unit: string; unit_name: string | null; is_service: number; qty: Milli } | undefined;
      if (l.articleId === DELIVERY_FEE_ARTICLE_ID || !head || head.is_service === 1) return [{ warehouseId: chosen.id, qty: l.qty }];
      const out: { warehouseId: string; qty: Milli }[] = [];
      let need = l.qty;
      for (const w of sources) {
        const key = `${l.articleId}|${w.id}`;
        if (!left.has(key)) left.set(key, (get.get(w.id, l.articleId) as { qty: Milli }).qty);
        const take = Math.min(need, Math.max(0, left.get(key)!));
        if (take <= 0) continue;
        left.set(key, left.get(key)! - take);
        out.push({ warehouseId: w.id, qty: take });
        if (w.id !== chosen.id) complement.push({ article: l.label, from: w.name, qty: take });
        need -= take;
        if (need === 0) break;
      }
      if (need > 0) {
        const total = sources.reduce((t, w) => t + Math.max(0, (get.get(w.id, l.articleId) as { qty: Milli }).qty), 0);
        if (!ignore) {
          const unit = head.unit === 'piece' ? (head.unit_name ?? 'pièce').toLowerCase() : head.unit === 'kg' ? 'kg' : 'L';
          const rest = total <= 0 ? 'épuisé' : `il reste ${String(total / 1000).replace('.', ',')} ${unit}`;
          throw new AppError(`Stock insuffisant pour ${l.label} : ${rest}`, 'OUT_OF_STOCK');
        }
        const s = short.get(l.articleId);
        short.set(l.articleId, { label: l.label, qty: (s?.qty ?? 0) + l.qty, stock: total });
        const own = out.find((p) => p.warehouseId === chosen.id);
        if (own) own.qty += need;
        else out.unshift({ warehouseId: chosen.id, qty: need });
      }
      return out;
    });
    return { parts, short: [...short.values()], complement };
  }

  completeSale(ctx: Context, input: SaleInput): Sale {
    const session = this.requireOpenSession(ctx);
    if (input.lines.length === 0) throw new AppError('Ticket vide', 'EMPTY');
    if (input.lines.some((l) => l.qty < 0)) throw new AppError('Quantité négative : utilisez le retour client', 'INVALID');
    const level = input.priceLevel ?? (input.customerId ? this.customers.getCustomer(input.customerId).price_level : 'retail');
    const set = this.admin.storeSettings(ctx.storeId);
    const warehouse = this.saleWarehouse(ctx.storeId, input.warehouseId);
    const lines = this.priceLines(ctx.storeId, input.lines, level);
    if (input.delivery) {
      this.deliveries.check(input.delivery);
      const fee = input.delivery.fee ?? 0;
      if (fee > 0) lines.push(this.deliveryFeeLine(ctx, fee));
    }
    // Arrondi des espèces : un ticket payé tout en espèces descend au multiple inférieur, en remise sur la dernière ligne.
    const allCash = input.payments.length > 0 && input.payments.every((p) => p.method === 'CASH');
    const rounding = allCash ? computeTotals(lines).totalTtc - roundCash(computeTotals(lines).totalTtc, set.cashRounding) : 0;
    if (rounding > 0) {
      // Sur la ligne la plus chère : elle ne passe jamais sous zéro.
      const i = lines.reduce((best, l, n) => (lineTotal(l) > lineTotal(lines[best]!) ? n : best), 0);
      lines[i] = { ...lines[i]!, discount: lines[i]!.discount + rounding };
    }
    const totals = computeTotals(lines);
    if (set.customerRequiredAbove > 0 && totals.totalTtc > set.customerRequiredAbove && !input.customerId && !input.clientName?.trim()) {
      throw new AppError(`Au-delà de ${formatFcfa(set.customerRequiredAbove)}, le nom du client est obligatoire`, 'CUSTOMER_REQUIRED');
    }
    const quote = input.quoteId ? this.quotes.authorizeSaleDiscounts(ctx.storeId, input.quoteId, lines) : null;
    let discountBy = input.discountAuthorizedBy ?? null;
    if (quote) discountBy ??= quote.by;
    // L'arrondi des espèces n'est pas une remise à valider.
    const granted = totals.totalDiscount - rounding;
    if (granted > 0 && !quote) {
      const user = this.admin.getUser(ctx.userId);
      const authorizer = input.discountAuthorizedBy ? this.admin.getUser(input.discountAuthorizedBy) : null;
      // Droit « remise sans code » du vendeur, code d'un gérant, ou remise sous le maximum fixé dans les paramètres.
      const supervisor = authorizer !== null && (authorizer.role === 'admin' || authorizer.role === 'manager');
      const underMax = set.maxDiscountPct > 0 && granted * 100 <= set.maxDiscountPct * (totals.totalTtc + totals.totalDiscount);
      if (!this.admin.hasRight(user, 'discount') && !supervisor && !underMax) throw new AppError('Remise soumise à validation du gérant', 'SUPERVISOR_REQUIRED');
      if (underMax && !supervisor) discountBy ??= ctx.userId;
    }
    for (const p of input.payments) {
      if (!(p.method in PAYMENT_METHODS)) throw new AppError(`Moyen de paiement inconnu : ${p.method}`, 'INVALID');
      if (requiresReference(p.method) && !p.reference?.trim()) {
        throw new AppError(`Référence de transaction obligatoire pour ${PAYMENT_METHODS[p.method]}`, 'REFERENCE_REQUIRED');
      }
    }
    const plan = this.planStock(ctx.storeId, this.saleSources(ctx.storeId, ctx.userId, warehouse), lines);
    const withoutStock = plan.short;
    // Chaque paiement va à la journée de la caisse de son type (espèces, électronique, banque).
    const paymentSessions = input.payments.map((p) => this.sessionFor(ctx, p.method, session.id));
    const settlement = settle(totals.totalTtc, input.payments);
    if (!settlement.complete) throw new AppError('Le ticket n’est pas entièrement réglé', 'UNPAID');
    const onCredit = input.payments.filter((p) => p.method === 'CUSTOMER_CREDIT').reduce((t, p) => t + p.amount, 0);
    if (onCredit > 0 && !input.customerId) throw new AppError('Choisissez le client pour une vente à crédit', 'CUSTOMER_REQUIRED');
    const customer = input.customerId
      ? onCredit > 0
        ? this.customers.assertCredit(ctx.storeId, input.customerId, onCredit, input.creditAuthorizedBy ? this.admin.getUser(input.creditAuthorizedBy) : null, {
            blockLate: set.creditBlockLate,
          })
        : this.customers.getCustomer(input.customerId)
      : null;
    const due = customer && onCredit > 0 ? this.customers.dueDateFor(customer) : null;

    return this.tx(() => {
      const saleId = newId();
      const number = this.nextTicketNumber(ctx);
      const now = this.now();
      this.db
        .prepare(
          `INSERT INTO sales (id, number, kind, store_id, register_id, session_id, user_id, status, total_ttc, total_ht,
             total_tva, total_discount, total_promo, price_level, change_given, customer_id, client_name, due_date, created_at, rounding, warehouse_id)
           VALUES (?, ?, 'sale', ?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          rounding,
          warehouse.is_sales_default ? null : warehouse.id,
        );
      const insertLine = this.db.prepare(
        `INSERT INTO sale_lines (id, sale_id, line_no, article_id, label, barcode, qty, unit_price, discount, vat_rate_bp, total_ttc, unit_cost, promo, promotion_id,
           pack_name, pack_units, pack_price)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      lines.forEach((line, i) => {
        // Une ligne complétée dans un autre dépôt sort de chacun : son coût est la moyenne pondérée.
        let cost = 0;
        for (const part of plan.parts[i]!) {
          const { unitCost } = this.stock.issue(ctx, { type: 'SALE', articleId: line.articleId, warehouseId: part.warehouseId, qty: part.qty, refType: 'sale', refId: saleId });
          cost += unitCost * part.qty;
        }
        const unitCost = line.qty > 0 ? Math.round(cost / line.qty) : 0;
        insertLine.run(newId(), saleId, i + 1, line.articleId, line.label, line.barcode, line.qty, line.unitPrice, line.discount, line.vatRate, lineTotal(line), unitCost, line.promo, line.promotionId,
          line.packName, line.packUnits ?? null, line.packPrice ?? null,
        );
      });
      const insertPayment = this.db.prepare('INSERT INTO sale_payments (id, sale_id, method, amount, reference, session_id) VALUES (?, ?, ?, ?, ?, ?)');
      input.payments.forEach((p, i) => insertPayment.run(newId(), saleId, p.method, p.amount, p.reference?.trim() || null, paymentSessions[i]));
      if (granted > 0) {
        this.audit(ctx.userId, 'sale.discount', 'sale', saleId, { amount: granted, authorizedBy: discountBy, quoteId: input.quoteId ?? null });
      }
      if (rounding > 0) this.audit(ctx.userId, 'sale.rounding', 'sale', saleId, { amount: rounding, step: set.cashRounding });
      const changed = lines.filter((l) => l.priceSet);
      if (changed.length) {
        this.audit(ctx.userId, 'sale.price_set', 'sale', saleId, {
          lines: changed.map((l) => ({ article: l.label, pack: l.packName, price: l.packPrice ?? l.unitPrice })),
        });
      }
      if (withoutStock.length) this.audit(ctx.userId, 'sale.without_stock', 'sale', saleId, { number, lines: withoutStock });
      if (plan.complement.length) this.audit(ctx.userId, 'sale.complement', 'sale', saleId, { number, warehouse: warehouse.name, lines: plan.complement });
      if (input.quoteId) this.quotes.markAccepted(ctx, input.quoteId, saleId);
      if (level !== (customer?.price_level ?? 'retail') || !warehouse.is_sales_default) {
        this.audit(ctx.userId, 'sale.options', 'sale', saleId, { number, level, warehouse: warehouse.name });
      }
      const sale = this.getSale(saleId);
      this.enqueue(ctx, 'sale', saleId, 'upsert', sale);
      if (input.delivery) this.deliveries.create(ctx, saleId, input.delivery);
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

  /** Le ticket ou la facture de la vente vient d'être imprimé : le suivant portera « DUPLICATA ». */
  markSalePrinted(id: string, doc: 'ticket' | 'invoice'): void {
    this.db.prepare(`UPDATE sales SET ${doc === 'ticket' ? 'ticket_prints = ticket_prints' : 'invoice_prints = invoice_prints'} + 1 WHERE id = ?`).run(id);
  }

  listSales(opts: { sessionId?: string; storeId?: string; date?: string; customerId?: string; userId?: string; limit?: number }): Omit<Sale, 'lines' | 'payments'>[] {
    return this.db
      .prepare(
        `SELECT s.*, u.name AS user_name, COALESCE(c.name, s.client_name) AS customer_name FROM sales s JOIN users u ON u.id = s.user_id
         LEFT JOIN customers c ON c.id = s.customer_id
         WHERE (@sessionId IS NULL OR s.session_id = @sessionId)
           AND (@storeId IS NULL OR s.store_id = @storeId)
           AND (@date IS NULL OR date(s.created_at, 'localtime') = @date)
           AND (@customerId IS NULL OR s.customer_id = @customerId)
           AND (@userId IS NULL OR s.user_id = @userId)
           AND s.hidden = 0
         ORDER BY s.created_at DESC, s.number DESC LIMIT @limit`,
      )
      .all({ sessionId: opts.sessionId ?? null, storeId: opts.storeId ?? null, date: opts.date ?? null, customerId: opts.customerId ?? null, userId: opts.userId ?? null, limit: opts.limit ?? 500 }) as never;
  }

  /**
   * Annule une vente de la journée en cours de sa caisse : le stock revient et elle sort des totaux.
   * `byRight` : l'auteur a le droit d'annuler sans le code du gérant (sinon il doit être gérant).
   */
  cancelSale(ctx: Context, saleId: string, supervisorId: string, reason: string, opts: { byRight?: boolean } = {}): Sale {
    const supervisor = this.admin.getUser(supervisorId);
    if (!opts.byRight && supervisor.role !== 'admin' && supervisor.role !== 'manager') throw new AppError('Annulation réservée au gérant', 'SUPERVISOR_REQUIRED');
    if (!reason.trim()) throw new AppError("Le motif d'annulation est obligatoire", 'INVALID');
    const sale = this.getSale(saleId);
    if (sale.status !== 'completed' || sale.kind !== 'sale') throw new AppError('Ce ticket ne peut pas être annulé', 'INVALID');
    const hasReturns = this.db.prepare("SELECT 1 FROM sales WHERE original_sale_id = ? AND status = 'completed'").get(saleId);
    if (hasReturns) throw new AppError('Ce ticket a déjà fait l’objet d’un retour client', 'INVALID');
    if (!this.dayOpen(sale)) throw new AppError('Seuls les tickets d’une journée de caisse encore ouverte peuvent être annulés ; faites un retour client', 'INVALID');
    return this.tx(() => {
      this.db.prepare("UPDATE sales SET status = 'cancelled', cancelled_by = ?, cancel_reason = ? WHERE id = ?").run(supervisorId, reason.trim(), saleId);
      this.restockSaleMovements(ctx, saleId, 'sale_cancel', saleId);
      this.deliveries.cancelForSale(ctx, saleId);
      this.audit(supervisorId, 'sale.cancel', 'sale', saleId, { number: sale.number, total: sale.total_ttc, reason, cashier: ctx.userId });
      const updated = this.getSale(saleId);
      this.enqueue(ctx, 'sale', saleId, 'upsert', updated);
      return updated;
    });
  }

  /** La journée de caisse de la vente est encore ouverte (son Z n'est pas fait). */
  dayOpen(sale: Pick<Sale, 'session_id'>): boolean {
    return this.db.prepare("SELECT 1 FROM cash_sessions WHERE id = ? AND status = 'open'").get(sale.session_id) !== undefined;
  }

  /**
   * Annule une facture depuis le registre : directement si sa journée de caisse est ouverte,
   * sinon par un avoir de toute la facture sur la caisse du jour (le Z déjà fait ne bouge pas).
   * `hide` : « Supprimer », la facture sort aussi du registre.
   */
  voidSale(ctx: Context, saleId: string, byId: string, reason: string, opts: { byRight?: boolean; hide?: boolean } = {}): Sale {
    const sale = this.getSale(saleId);
    return this.tx(() => {
      let result: Sale;
      if (this.dayOpen(sale)) result = this.cancelSale(ctx, saleId, byId, reason, opts);
      else {
        const credit = sale.payments.some((p) => p.method === 'CUSTOMER_CREDIT');
        result = this.returnSale(ctx, {
          originalSaleId: saleId,
          lines: sale.lines.map((l) => ({ lineId: l.id, qty: l.qty })),
          refundMethod: credit ? 'CUSTOMER_CREDIT' : 'CASH',
          supervisorId: byId,
          reason,
          byRight: opts.byRight,
        });
      }
      if (opts.hide) {
        this.db.prepare('UPDATE sales SET hidden = 1 WHERE id = ?').run(saleId);
        this.audit(byId, 'sale.hide', 'sale', saleId, { number: sale.number, total: sale.total_ttc, reason });
        this.enqueue(ctx, 'sale', saleId, 'upsert', this.getSale(saleId));
      }
      return result;
    });
  }

  /**
   * Lignes d'une facture à modifier, rechargées à la caisse : quantités, conditionnements et
   * remises accordées (sans l'arrondi des espèces, recalculé à la validation).
   */
  editableSale(saleId: string): { lines: SaleLineInput[]; customerId: string | null; clientName: string | null; priceLevel: PriceLevel; paid: Fcfa } {
    const sale = this.getSale(saleId);
    if (sale.status !== 'completed' || sale.kind !== 'sale') throw new AppError('Cette facture ne peut pas être modifiée', 'INVALID');
    if (!this.dayOpen(sale)) throw new AppError('La journée de caisse de cette facture est clôturée : annulez-la (avoir) puis refaites-la', 'INVALID');
    if (this.db.prepare("SELECT 1 FROM sales WHERE original_sale_id = ? AND status = 'completed'").get(saleId)) {
      throw new AppError('Cette facture a déjà fait l’objet d’un retour client', 'INVALID');
    }
    let rounding = sale.rounding;
    const packs = this.db.prepare('SELECT id FROM article_packs WHERE article_id = ? AND name = ? ORDER BY position LIMIT 1').pluck();
    const lines = sale.lines.map((l) => {
      let discount = l.discount;
      if (rounding > 0 && discount >= rounding) (discount -= rounding), (rounding = 0);
      const packId = l.pack_name ? ((packs.get(l.article_id, l.pack_name) as string | undefined) ?? null) : null;
      return { articleId: l.article_id, qty: l.qty, barcode: l.barcode, discount, packId };
    });
    return { lines, customerId: sale.customer_id, clientName: sale.customer_id ? null : sale.customer_name, priceLevel: sale.price_level, paid: this.carriedPaid(sale) };
  }

  /** Ce que le client a déjà réglé sur la facture (espèces nettes du rendu). */
  private carriedPayments(sale: Sale): Payment[] {
    const out: Payment[] = [];
    let change = sale.change_given;
    for (const p of sale.payments) {
      let amount = p.amount;
      if (p.method === 'CASH' && change > 0) {
        const taken = Math.min(change, amount);
        amount -= taken;
        change -= taken;
      }
      if (amount > 0) out.push({ method: p.method, amount, reference: p.reference } as Payment);
    }
    return out;
  }

  private carriedPaid(sale: Sale): Fcfa {
    return this.carriedPayments(sale).reduce((t, p) => t + p.amount, 0);
  }

  /**
   * Modifie une facture de la journée : l'ancienne est annulée (stock remis) et la nouvelle
   * reprend ce qui était déjà réglé ; `input.payments` ne porte que la différence encaissée.
   */
  replaceSale(ctx: Context, replacesId: string, input: SaleInput, byId: string): Sale {
    const original = this.getSale(replacesId);
    this.editableSale(replacesId);
    // L'argent déjà reçu est dans le tiroir de cette caisse : la facture se modifie sur la même journée.
    if (original.session_id !== this.requireOpenSession(ctx).id) throw new AppError(`Modifiez cette facture depuis sa caisse (${(this.db.prepare("SELECT name FROM registers WHERE id = ?").pluck().get(original.register_id) as string | undefined) ?? "autre caisse"})`, 'INVALID');
    return this.tx(() => {
      this.cancelSale(ctx, replacesId, byId, 'Facture modifiée', { byRight: true });
      const carried = this.carriedPayments(original);
      const total = () => computeTotals(this.priceLines(ctx.storeId, input.lines, input.priceLevel ?? original.price_level)).totalTtc;
      // Moins d'articles qu'avant : la part à crédit baisse d'abord ; un paiement électronique ne se rend pas en espèces.
      const nonCash = (ps: Payment[]) => ps.filter((p) => p.method !== 'CASH').reduce((t, p) => t + p.amount, 0);
      let excess = nonCash([...carried, ...input.payments]) - total();
      if (excess > 0) {
        for (const p of carried.filter((x) => x.method === 'CUSTOMER_CREDIT')) {
          const cut = Math.min(excess, p.amount);
          p.amount -= cut;
          excess -= cut;
        }
        if (excess > 0) throw new AppError('Le client a payé par MoMo, carte ou banque plus que le nouveau total : annulez la facture et remboursez-le, puis refaites-la', 'INVALID');
      }
      const sale = this.completeSale(ctx, { ...input, payments: [...carried.filter((p) => p.amount > 0), ...input.payments] });
      this.db.prepare('UPDATE sales SET replaces_id = ? WHERE id = ?').run(replacesId, sale.id);
      this.db.prepare('UPDATE sales SET cancel_reason = ? WHERE id = ?').run(`Facture modifiée : remplacée par ${sale.number}`, replacesId);
      this.audit(byId, 'sale.edit', 'sale', sale.id, { replaces: original.number, number: sale.number, before: original.total_ttc, after: sale.total_ttc });
      const updated = this.getSale(sale.id);
      this.enqueue(ctx, 'sale', sale.id, 'upsert', updated);
      this.enqueue(ctx, 'sale', replacesId, 'upsert', this.getSale(replacesId));
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
    input: { originalSaleId: string; lines: { lineId: string; qty: Milli }[]; refundMethod: PaymentMethod; supervisorId: string; reason: string; byRight?: boolean },
  ): Sale {
    const session = this.requireOpenSession(ctx);
    const supervisor = this.admin.getUser(input.supervisorId);
    if (!input.byRight && supervisor.role !== 'admin' && supervisor.role !== 'manager') throw new AppError('Retour réservé au gérant', 'SUPERVISOR_REQUIRED');
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
    const refundSession = this.sessionFor(ctx, input.refundMethod, session.id);

    return this.tx(() => {
      const id = newId();
      const number = this.nextTicketNumber(ctx, 'return');
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
      this.db
        .prepare('INSERT INTO sale_payments (id, sale_id, method, amount, reference, session_id) VALUES (?, ?, ?, ?, NULL, ?)')
        .run(newId(), id, input.refundMethod, -total, refundSession);
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
         WHERE COALESCE(p.session_id, s.session_id) = ? AND s.status = 'completed' GROUP BY p.method`,
      )
      .all(sessionId) as { method: PaymentMethod; received: number; refunded: number }[];
    const elsewhere = (
      this.db
        .prepare(
          `SELECT p.method, r.name AS registerName, SUM(p.amount) AS amount
           FROM sale_payments p JOIN sales s ON s.id = p.sale_id JOIN cash_sessions cs ON cs.id = p.session_id JOIN registers r ON r.id = cs.register_id
           WHERE s.session_id = ? AND p.session_id <> s.session_id AND s.status = 'completed' GROUP BY p.method, r.name ORDER BY r.name, p.method`,
        )
        .all(sessionId) as { method: PaymentMethod; registerName: string; amount: number }[]
    ).map((r) => ({ ...r, label: PAYMENT_METHODS[r.method] }));
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
      .prepare("SELECT number, label, amount FROM expenses WHERE session_id = ? AND status = 'active' AND method = 'CASH' ORDER BY created_at")
      .all(sessionId) as ZReport['expenses'];
    // « Encaisser » et « Décaisser » : pièces de trésorerie, fournisseurs payés ou remboursés en espèces à cette caisse.
    const other = this.db
      .prepare(
        `SELECT COALESCE(SUM(CASE WHEN direction = 'IN' THEN amount END), 0) AS inflow, COALESCE(SUM(CASE WHEN direction = 'OUT' THEN amount END), 0) AS outflow FROM (
           SELECT direction, amount FROM treasury_entries WHERE session_id = @id AND status = 'active' AND method = 'CASH'
           UNION ALL
           SELECT CASE WHEN i.kind = 'invoice' THEN 'OUT' ELSE 'IN' END, p.amount FROM supplier_payments p JOIN supplier_invoices i ON i.id = p.invoice_id
           WHERE p.session_id = @id AND p.method = 'CASH')`,
      )
      .get({ id: sessionId }) as { inflow: number; outflow: number };
    const cash = {
      openingFloat: session.opening_float,
      cashSales,
      cashRefunds,
      cashIn,
      cashOut,
      customerReceipts: receiptsCash,
      expenses: expenses.reduce((t, e) => t + e.amount, 0),
      otherIn: other.inflow,
      otherOut: other.outflow,
    };
    const { expected } = closingDifference(cash, {});
    return {
      session,
      storeName: store.name,
      registerName: register.name,
      registerKind: register.kind,
      declared: register.kind === 'cash' ? null : this.declaredLines(session),
      emoneyJournal: register.kind === 'electronic' ? { entries: this.emoney.sessionEntries(sessionId), exits: this.emoney.sessionExits(sessionId) } : null,
      emoneyDeposit: this.emoneyDeposit(session),
      elsewhere,
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

  /** Moyens de paiement reçus par une caisse électronique ou banque. */
  private kindMethods(kind: RegisterKind): PaymentMethod[] {
    return kind === 'electronic' ? [...ELECTRONIC_METHODS] : kind === 'bank' ? [...BANK_METHODS] : ['CASH'];
  }

  /** Encaissé par moyen de paiement dans une journée : ventes, retours et règlements clients. */
  private receivedByMethod(sessionId: string): Map<string, Fcfa> {
    const out = new Map<string, Fcfa>();
    const rows = this.db
      .prepare(
        `SELECT p.method, SUM(p.amount) AS amount FROM sale_payments p JOIN sales s ON s.id = p.sale_id
         WHERE COALESCE(p.session_id, s.session_id) = ? AND s.status = 'completed' GROUP BY p.method`,
      )
      .all(sessionId) as { method: string; amount: number }[];
    for (const r of rows) out.set(r.method, r.amount);
    for (const r of this.customers.sessionReceipts(sessionId)) out.set(r.method, (out.get(r.method) ?? 0) + r.amount);
    return out;
  }

  /** Ce qui fait l'attendu d'une journée électronique ou banque, par moyen : départ, encaissé, entrées et sorties. */
  private expectedParts(session: CashSession, kind: RegisterKind) {
    const methods = this.kindMethods(kind);
    const received = this.receivedByMethod(session.id);
    const openingRaw = (session as CashSession & { opening_detail?: string | null }).opening_detail;
    const openingAll = openingRaw ? (JSON.parse(openingRaw) as Record<string, Fcfa>) : {};
    const adj = kind === 'electronic' ? this.emoney.sessionAdjustments(session.id) : null;
    const pick = (f: (m: PaymentMethod) => Fcfa) => Object.fromEntries(methods.map((m) => [m, f(m)])) as Record<string, Fcfa>;
    const opening = pick((m) => openingAll[m] ?? 0);
    const rec = pick((m) => received.get(m) ?? 0);
    const outflows = pick((m) => (adj && isEmoney(m) ? adj.outflows[m] : 0));
    const inflows = pick((m) => (adj && isEmoney(m) ? adj.inflows[m] : 0));
    const expected = pick((m) => opening[m]! + rec[m]! + inflows[m]! - outflows[m]!);
    return { methods, opening, received: rec, outflows, inflows, expected };
  }

  private declaredLines(session: CashSession): DeclaredLine[] {
    const kind = this.admin.getRegister(session.register_id).kind;
    const live = this.expectedParts(session, kind);
    // Clôturée : attendu et relevé tels qu'enregistrés à la clôture.
    const stored = session.status === 'closed' ? (JSON.parse((session as CashSession & { counted_detail?: string }).counted_detail ?? '{}') as Partial<DeclaredDetail>) : null;
    return live.methods.map((m) => {
      const declared = stored ? (stored.declared?.[m] ?? 0) : null;
      return {
        method: m,
        label: PAYMENT_METHODS[m],
        opening: stored?.opening?.[m] ?? (stored ? 0 : live.opening[m]!),
        received: live.received[m]!,
        outflows: stored?.outflows?.[m] ?? live.outflows[m]!,
        inflows: stored?.inflows?.[m] ?? live.inflows[m]!,
        expected: stored?.expected?.[m] ?? live.expected[m]!,
        declared,
        deposited: stored?.deposited?.[m] ?? 0,
        left: stored ? (stored.left?.[m] ?? declared) : null,
      };
    });
  }

  private emoneyDeposit(session: CashSession): ZReport['emoneyDeposit'] {
    if (session.status !== 'closed') return null;
    const detail = JSON.parse((session as CashSession & { counted_detail?: string }).counted_detail ?? '{}') as Partial<DeclaredDetail>;
    if (!detail.depositNumber) return null;
    const central = this.db
      .prepare("SELECT r.name FROM emoney_movements m JOIN registers r ON r.id = m.other_register_id WHERE m.session_id = ? AND m.nature = 'deposit' AND m.direction = 'OUT' LIMIT 1")
      .pluck()
      .get(session.id) as string | undefined;
    return { centralName: central ?? 'Caisse électronique centrale', number: detail.depositNumber };
  }

  /** Paiements reçus par une journée, un par ligne : tickets et règlements clients, avec leur référence. */
  sessionPayments(sessionId: string): { at: string; number: string; method: string; label: string; amount: Fcfa; reference: string | null; user_name: string | null }[] {
    const rows = this.db
      .prepare(
        `SELECT s.created_at AS at, s.number, p.method, p.amount, p.reference, u.name AS user_name
         FROM sale_payments p JOIN sales s ON s.id = p.sale_id LEFT JOIN users u ON u.id = s.user_id
         WHERE COALESCE(p.session_id, s.session_id) = ? AND s.status = 'completed'
         UNION ALL
         SELECT c.paid_at, c.number, c.method, c.amount, c.reference, u.name
         FROM customer_payments c LEFT JOIN users u ON u.id = c.user_id WHERE c.session_id = ?
         ORDER BY 1`,
      )
      .all(sessionId, sessionId) as { at: string; number: string; method: string; amount: number; reference: string | null; user_name: string | null }[];
    return rows.map((r) => ({ ...r, label: PAYMENT_METHODS[r.method as PaymentMethod] ?? r.method }));
  }

  /**
   * Clôture d'une caisse électronique ou banque : le caissier relève le solde
   * de chaque téléphone, terminal ou relevé. L'écart avec l'encaissé de la
   * journée se justifie comme celui des espèces (motif du gérant au-delà du seuil).
   */
  closeDeclared(ctx: Context, registerId: string, declared: Partial<Record<PaymentMethod, Fcfa>>, opts: Omit<CloseOptions, 'floatLeft'> = {}): ZReport {
    const register = this.admin.getRegister(registerId);
    if (register.kind === 'cash') throw new AppError('Une caisse espèces se clôture par le comptage des coupures', 'INVALID');
    const session = this.currentSession(registerId);
    if (!session) throw new AppError(`${register.name} n'est pas ouverte`, 'SESSION_CLOSED');
    const parts = this.expectedParts(session, register.kind);
    const methods = parts.methods;
    const detail: Record<string, Fcfa> = {};
    for (const m of methods) {
      const v = declared[m] ?? 0;
      if (!Number.isSafeInteger(v) || v < 0) throw new AppError(`Montant invalide pour ${PAYMENT_METHODS[m]}`, 'INVALID');
      detail[m] = v;
    }
    const expectedDetail = parts.expected;
    const expected = methods.reduce((t, m) => t + expectedDetail[m]!, 0);
    const counted = methods.reduce((t, m) => t + detail[m]!, 0);
    const difference = counted - expected;
    // Versement de la recette vers la caisse électronique centrale (mode centrale) : le reste repart le lendemain.
    const mode = register.kind === 'electronic' ? this.emoney.mode(session.store_id) : null;
    const deposited: Record<string, Fcfa> = {};
    const references: Record<string, string> = {};
    for (const m of methods) {
      const d = opts.deposit?.[m];
      const amount = d?.amount ?? 0;
      if (!amount) continue;
      if (m === 'CARD') throw new AppError('Les paiements par carte vont à la banque : rien à verser', 'INVALID');
      if (!mode?.centralId) throw new AppError("Pas de caisse électronique centrale : choisissez-la dans Administration › Paramètres", 'INVALID');
      if (!Number.isSafeInteger(amount) || amount < 0) throw new AppError(`Versement invalide pour ${PAYMENT_METHODS[m]}`, 'INVALID');
      if (amount > detail[m]!) throw new AppError(`Le versement ${PAYMENT_METHODS[m]} dépasse le solde relevé`, 'INVALID');
      const reference = d?.reference?.trim();
      if (!reference) throw new AppError(`Indiquez la référence du transfert ${PAYMENT_METHODS[m]}`, 'REFERENCE_REQUIRED');
      deposited[m] = amount;
      references[m] = reference;
    }
    // Le terminal de carte vire chaque jour à la banque : rien ne reste sur la caisse.
    const left = Object.fromEntries(methods.map((m) => [m, m === 'CARD' ? 0 : detail[m]! - (deposited[m] ?? 0)])) as Record<string, Fcfa>;
    const threshold = this.admin.getStore(session.store_id).cash_gap_threshold;
    const gapReason = Math.abs(difference) > threshold && opts.gapApprovedBy ? opts.gapReason?.trim() || null : null;
    const gapApprovedBy = gapReason ? opts.gapApprovedBy! : null;
    this.tx(() => {
      const lastZ = this.db.prepare('SELECT MAX(z_number) FROM cash_sessions WHERE register_id = ?').pluck().get(registerId) as number | null;
      if (lastZ) this.raiseCounter(`z:${registerId}`, lastZ);
      const zNumber = this.nextCounter(`z:${registerId}`);
      let depositNumber: string | null = null;
      for (const m of methods) {
        if (!deposited[m] || !isEmoney(m)) continue;
        const mv = this.emoney.transfer(ctx, {
          fromId: registerId,
          toId: mode!.centralId!,
          method: m,
          amount: deposited[m]!,
          reference: references[m]!,
          nature: 'deposit',
          label: `Recette de ${register.name}, Z${zNumber}`,
          fromSessionId: session.id,
          number: depositNumber,
        });
        depositNumber = mv.number;
      }
      const stored: DeclaredDetail = { declared: detail, expected: expectedDetail };
      if (register.kind === 'electronic') Object.assign(stored, { opening: parts.opening, outflows: parts.outflows, inflows: parts.inflows, deposited, left, depositNumber });
      this.db
        .prepare(
          `UPDATE cash_sessions SET status = 'closed', closed_at = ?, closed_by = ?, counted_detail = ?, expected_cash = ?, counted_cash = ?,
             difference = ?, z_number = ?, first_counted = COALESCE(first_counted, ?), gap_reason = ?, gap_approved_by = ?, gap_justified_at = ? WHERE id = ?`,
        )
        .run(this.now(), ctx.userId, JSON.stringify(stored), expected, counted, difference, zNumber, counted, gapReason, gapApprovedBy, gapReason ? this.now() : null, session.id);
      this.enqueue(ctx, 'cash_session', session.id, 'upsert', this.getSession(session.id));
      this.audit(ctx.userId, 'cash.close', 'cash_session', session.id, { zNumber, kind: register.kind, expected, counted, difference, gapReason, deposited });
    });
    return this.zReport(session.id);
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
    // La caisse se ferme sur le comptage saisi : un écart au-delà du seuil reste « à justifier »
    // jusqu'à ce que le gérant en donne le motif (justifyGap), à la clôture ou après coup.
    const gapReason = Math.abs(result.difference) > threshold && opts.gapApprovedBy ? opts.gapReason?.trim() || null : null;
    const gapApprovedBy = gapReason ? opts.gapApprovedBy! : null;
    const register = this.admin.getRegister(session.register_id);
    this.tx(() => {
      const lastZ = this.db.prepare('SELECT MAX(z_number) FROM cash_sessions WHERE register_id = ?').pluck().get(session.register_id) as number | null;
      if (lastZ) this.raiseCounter(`z:${session.register_id}`, lastZ);
      const zNumber = this.nextCounter(`z:${session.register_id}`);
      this.db
        .prepare(
          `UPDATE cash_sessions SET status = 'closed', closed_at = ?, closed_by = ?, counted_detail = ?, expected_cash = ?,
             counted_cash = ?, difference = ?, z_number = ?, first_counted = COALESCE(first_counted, ?), float_left = ?, deposit = ?,
             gap_reason = ?, gap_approved_by = ?, gap_justified_at = ? WHERE id = ?`,
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
          gapApprovedBy,
          gapReason ? this.now() : null,
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
      this.audit(ctx.userId, 'cash.close', 'cash_session', session.id, { zNumber, ...result, floatLeft, deposit, gapReason, gapApprovedBy });
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
        `SELECT s.id, s.created_at AS at, s.number, s.kind, COALESCE(c.name, s.client_name) AS party, u.name AS user_name, s.user_id,
                SUM(p.amount) - s.change_given AS amount
         FROM sales s JOIN sale_payments p ON p.sale_id = s.id AND p.method = 'CASH' JOIN users u ON u.id = s.user_id
         LEFT JOIN customers c ON c.id = s.customer_id
         WHERE s.session_id = ? AND s.status = 'completed' GROUP BY s.id ORDER BY s.created_at`,
      )
      .all(sessionId) as { id: string; at: string; number: string; kind: 'sale' | 'return'; party: string | null; user_name: string; user_id: string; amount: number }[];
    const receipts = this.db
      .prepare(
        `SELECT p.id, p.paid_at AS at, p.number, p.reference, c.name AS party, u.name AS user_name, p.user_id, p.amount FROM customer_payments p
         JOIN customers c ON c.id = p.customer_id LEFT JOIN users u ON u.id = p.user_id
         WHERE p.session_id = ? AND p.method = 'CASH' ORDER BY p.paid_at`,
      )
      .all(sessionId) as { id: string; at: string; number: string; reference: string | null; party: string; user_name: string | null; user_id: string | null; amount: number }[];
    const ops = this.db
      .prepare('SELECT o.id, o.at, o.type, o.amount, o.reason, u.name AS user_name, o.user_id FROM cash_operations o LEFT JOIN users u ON u.id = o.user_id WHERE o.session_id = ? ORDER BY o.at')
      .all(sessionId) as { id: string; at: string; type: 'IN' | 'OUT'; amount: number; reason: string; user_name: string | null; user_id: string | null }[];
    const expenses = this.db
      .prepare(
        `SELECT e.id, e.created_at AS at, e.number, e.label, e.beneficiary, e.reference, e.amount, u.name AS user_name, e.user_id FROM expenses e LEFT JOIN users u ON u.id = e.user_id
         WHERE e.session_id = ? AND e.status = 'active' AND e.method = 'CASH' ORDER BY e.created_at`,
      )
      .all(sessionId) as { id: string; at: string; number: string; label: string; beneficiary: string | null; reference: string | null; amount: number; user_name: string | null; user_id: string | null }[];
    const suppliers = this.db
      .prepare(
        `SELECT p.id, p.paid_at AS at, i.number, i.kind, i.supplier_number, p.reference, f.name AS party, p.amount, u.name AS user_name, p.user_id
         FROM supplier_payments p JOIN supplier_invoices i ON i.id = p.invoice_id JOIN suppliers f ON f.id = p.supplier_id LEFT JOIN users u ON u.id = p.user_id
         WHERE p.session_id = ? AND p.method = 'CASH' ORDER BY p.paid_at`,
      )
      .all(sessionId) as { id: string; at: string; number: string; kind: 'invoice' | 'credit_note'; supplier_number: string; reference: string | null; party: string; amount: number; user_name: string | null; user_id: string | null }[];
    const pieces = this.desk(sessionId, 'CASH');
    const closing = this.db
      .prepare("SELECT id, at, number, amount, label FROM central_cash_movements WHERE session_id = ? AND kind = 'DEPOSIT' AND cash_operation_id IS NULL ORDER BY at")
      .all(sessionId) as { id: string; at: string; number: string; amount: number; label: string }[];
    const credit = this.db
      .prepare(
        `SELECT COALESCE(SUM(p.amount), 0) FROM sale_payments p JOIN sales s ON s.id = p.sale_id
         WHERE s.session_id = ? AND s.status = 'completed' AND p.method = 'CUSTOMER_CREDIT'`,
      )
      .pluck()
      .get(sessionId) as number;
    const cash = PAYMENT_METHODS.CASH;
    const entries: CashJournalRow[] = [
      ...sales.filter((x) => x.amount > 0).map((x) => ({ source: 'sale' as const, id: x.id, number: x.number, at: x.at, amount: x.amount, nature: 'Vente', label: `Ticket ${x.number}`, party: x.party, user_name: x.user_name, user_id: x.user_id })),
      ...receipts.map((x) => ({ source: 'customer_payment' as const, id: x.id, number: x.number, reference: x.reference, at: x.at, amount: x.amount, nature: 'Règlement client', label: `Reçu ${x.number}`, party: x.party, user_name: x.user_name, user_id: x.user_id })),
      ...ops.filter((x) => x.type === 'IN').map((x) => ({ source: 'cash_operation' as const, id: x.id, at: x.at, amount: x.amount, nature: 'Apport', label: x.reason, party: 'Caisse centrale', user_name: x.user_name, user_id: x.user_id })),
      ...suppliers.filter((x) => x.kind === 'credit_note').map((x) => ({ source: 'supplier_payment' as const, id: x.id, number: x.number, reference: x.reference, at: x.at, amount: x.amount, nature: 'Fournisseur', label: `Avoir ${x.supplier_number} remboursé`, party: x.party, user_name: x.user_name, user_id: x.user_id })),
      ...pieces.entries,
    ]
      .map((r) => ({ method_label: cash, ...r }))
      .sort((a, b) => a.at.localeCompare(b.at));
    const exits: CashJournalRow[] = [
      ...sales.filter((x) => x.amount < 0).map((x) => ({ source: 'refund' as const, id: x.id, number: x.number, at: x.at, amount: -x.amount, nature: 'Remboursement', label: `Retour ${x.number}`, party: x.party, user_name: x.user_name, user_id: x.user_id })),
      ...ops.filter((x) => x.type === 'OUT').map((x) => ({ source: 'cash_operation' as const, id: x.id, at: x.at, amount: x.amount, nature: 'Prélèvement', label: x.reason, party: 'Caisse centrale', user_name: x.user_name, user_id: x.user_id })),
      ...expenses.map((x) => ({ source: 'expense' as const, id: x.id, number: x.number, reference: x.reference, at: x.at, amount: x.amount, nature: 'Dépense', label: `${x.number} ${x.label}`, party: x.beneficiary, user_name: x.user_name, user_id: x.user_id })),
      ...suppliers.filter((x) => x.kind === 'invoice').map((x) => ({ source: 'supplier_payment' as const, id: x.id, number: x.number, reference: x.reference, at: x.at, amount: x.amount, nature: 'Règlement fournisseur', label: `Facture ${x.supplier_number}`, party: x.party, user_name: x.user_name, user_id: x.user_id })),
      ...pieces.exits,
      ...closing.map((x) => ({ source: 'central' as const, id: x.id, number: x.number, at: x.at, amount: x.amount, nature: 'Versement', label: `${x.number} ${x.label}`, party: 'Caisse centrale', user_name: null, user_id: null, closing: true })),
    ]
      .map((r) => ({ method_label: cash, ...r }))
      .sort((a, b) => a.at.localeCompare(b.at));
    return { entries, exits, creditSales: credit };
  }

  /**
   * Pièces d'« Encaisser » et « Décaisser » d'une journée (avances, salaires,
   * remboursements, autres), en espèces ou par MoMo/OM selon la caisse.
   */
  desk(sessionId: string, method: 'CASH' | 'EMONEY'): { entries: CashJournalRow[]; exits: CashJournalRow[] } {
    const rows = this.db
      .prepare(
        `SELECT e.id, e.at, e.number, e.direction, e.kind, e.amount, e.method, e.reference, e.piece, e.label,
                COALESCE(s.name, c.name, e.party) AS party, u.name AS user_name, e.user_id
         FROM treasury_entries e LEFT JOIN staff s ON s.id = e.staff_id LEFT JOIN customers c ON c.id = e.customer_id LEFT JOIN users u ON u.id = e.user_id
         WHERE e.session_id = ? AND e.status = 'active' AND ${method === 'CASH' ? "e.method = 'CASH'" : "e.method <> 'CASH'"} ORDER BY e.at`,
      )
      .all(sessionId) as { id: string; at: string; number: string; direction: 'IN' | 'OUT'; kind: EntryKind; amount: number; method: PaymentMethod; reference: string | null; piece: string | null; label: string; party: string | null; user_name: string | null; user_id: string | null }[];
    const map = (x: (typeof rows)[number]): CashJournalRow => ({
      source: 'entry',
      id: x.id,
      number: x.number,
      kind: x.kind,
      method_label: PAYMENT_METHODS[x.method] ?? x.method,
      reference: x.reference ?? x.piece,
      at: x.at,
      amount: x.amount,
      nature: ENTRY_KINDS[x.kind],
      label: `${x.number} ${x.label}`,
      party: x.party,
      user_name: x.user_name,
      user_id: x.user_id,
    });
    return { entries: rows.filter((x) => x.direction === 'IN').map(map), exits: rows.filter((x) => x.direction === 'OUT').map(map) };
  }

  /** Entrées et sorties d'une journée, quelle que soit la caisse : espèces, ou comptes MoMo/OM d'une caisse électronique. */
  journal(sessionId: string): { entries: CashJournalRow[]; exits: CashJournalRow[] } {
    const se = this.getSession(sessionId);
    const kind = this.admin.getRegister(se.register_id).kind;
    if (kind !== 'electronic') return this.cashJournal(sessionId);
    const map = (r: EmoneyRow): CashJournalRow => ({ ...r, label: r.label, source: r.source === 'sale' ? 'sale' : r.source });
    return { entries: this.emoney.sessionEntries(sessionId).map(map), exits: this.emoney.sessionExits(sessionId).map(map) };
  }

  /** Écart au-delà du seuil, pas encore justifié par un gérant. */
  gapPending(session: Pick<CashSession, 'status' | 'difference' | 'gap_reason' | 'store_id'>): boolean {
    if (session.status !== 'closed' || session.difference === null || session.gap_reason) return false;
    return Math.abs(session.difference) > this.admin.getStore(session.store_id).cash_gap_threshold;
  }

  /** Journées clôturées dont l'écart attend le motif du gérant. */
  pendingGaps(storeId: string): CashSession[] {
    const threshold = this.admin.getStore(storeId).cash_gap_threshold;
    return this.db
      .prepare(
        `SELECT s.*, u.name AS user_name, c.name AS closed_by_name FROM cash_sessions s JOIN users u ON u.id = s.user_id
         LEFT JOIN users c ON c.id = s.closed_by
         WHERE s.store_id = ? AND s.status = 'closed' AND s.gap_reason IS NULL AND ABS(s.difference) > ? ORDER BY s.closed_at DESC`,
      )
      .all(storeId, threshold) as CashSession[];
  }

  /** Le gérant, après avoir interpellé le caissier, donne le motif de l'écart d'une journée clôturée. */
  justifyGap(ctx: Context, sessionId: string, reason: string): CashSession {
    const session = this.getSession(sessionId);
    if (session.status !== 'closed') throw new AppError("La caisse n'est pas encore clôturée", 'INVALID');
    if (!reason.trim()) throw new AppError("Indiquez le motif de l'écart", 'INVALID');
    this.tx(() => {
      this.db.prepare('UPDATE cash_sessions SET gap_reason = ?, gap_approved_by = ?, gap_justified_at = ? WHERE id = ?').run(reason.trim(), ctx.userId, this.now(), sessionId);
      this.enqueue(ctx, 'cash_session', sessionId, 'upsert', this.getSession(sessionId));
      this.audit(ctx.userId, 'cash.gap_justified', 'cash_session', sessionId, { difference: session.difference, reason: reason.trim(), previous: session.gap_reason });
    });
    return this.getSession(sessionId);
  }

  listSessions(storeId: string, limit = 60, registerId?: string | null): CashSession[] {
    return this.db
      .prepare(
        `SELECT s.*, u.name AS user_name, c.name AS closed_by_name, g.name AS gap_approved_by_name FROM cash_sessions s JOIN users u ON u.id = s.user_id
         LEFT JOIN users c ON c.id = s.closed_by LEFT JOIN users g ON g.id = s.gap_approved_by
         WHERE s.store_id = ? AND (? IS NULL OR s.register_id = ?) ORDER BY s.opened_at DESC LIMIT ?`,
      )
      .all(storeId, registerId ?? null, registerId ?? null, limit) as CashSession[];
  }
}
