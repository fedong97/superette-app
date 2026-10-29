import {
  PAYMENT_METHODS,
  PRICE_LEVELS,
  type DocData,
  type DocFormat,
  type DocTemplate,
  type DocVariant,
  effectiveTemplates,
  formatFcfa,
  formatQty,
  formatRate,
  renderDocTicket,
  resolveTemplate,
  splitTtc,
  type Receipt,
} from '@superette/core';
import type { AdminService } from './admin';
import { CUSTOMER_PAYMENT_METHODS, type CustomerService } from './customers';
import { EXPENSE_PAYMENT_METHODS, type ExpenseService } from './expenses';
import type { Db } from './database';
import type { CashJournalRow, PosService } from './pos';
import type { TreasuryService } from './treasury';
import type { InventoryService } from './inventories';
import { REBATE_KINDS, type RebateService } from './rebates';
import { EmoneyService } from './emoney';
import type { QuoteService } from './quotes';
import { SUPPLIER_PAYMENT_METHODS, type PurchaseService } from './purchases';
import { Base, type Clock, type Context } from './util';
import type { GiftVoucher } from './vouchers';

const money = (v: number) => formatFcfa(v, false);
/** Code-barres du bon « à payer en caisse » : la caisse le scanne pour ouvrir la facture. */
export const counterCode = (number: number) => `ENC-${number}`;

/** Modèles de fiche de comptage. */
export const INVENTORY_SHEET_MODELS = {
  blind: 'Modèle classique, sans stock',
  withStock: 'Modèle classique, avec le stock attendu',
  control: 'Stock compté + stock attendu (contrôle)',
  counted: 'Stock compté uniquement',
} as const;
export type InventorySheetModel = keyof typeof INVENTORY_SHEET_MODELS;
const dateFr = (iso: string) =>
  new Date(iso).toLocaleString('fr-FR', { timeZone: 'Africa/Douala', dateStyle: 'short', timeStyle: 'short' });
const dayFr = (ymd: string) => new Date(`${ymd.slice(0, 10)}T12:00:00`).toLocaleDateString('fr-FR');

/**
 * Contenu des tickets de caisse et du rapport Z, indépendamment de la façon
 * de les imprimer (pilote Windows ou commandes ESC/POS directes).
 */
export class ReceiptService extends Base {
  constructor(
    db: Db,
    clock: Clock,
    private readonly admin: AdminService,
    private readonly pos: PosService,
    private readonly customers: CustomerService,
    private readonly expenses: ExpenseService,
    private readonly treasury: TreasuryService,
    private readonly inventories?: InventoryService,
    private readonly rebates?: RebateService,
    private readonly quotes?: QuoteService,
    private readonly purchases?: PurchaseService,
  ) {
    super(db, clock);
  }

  /** Livraison de la vente : adresse, jour, créneau et livreur sur la facture et le bon de livraison. */
  private deliveryInfo(saleId: string): { extra?: string[]; notes?: string | null } {
    const d = this.db.prepare('SELECT address, phone, courier, slot, planned_date, note FROM sale_deliveries WHERE sale_id = ?').get(saleId) as
      | { address: string; phone: string | null; courier: string | null; slot: string | null; planned_date: string; note: string | null }
      | undefined;
    if (!d) return {};
    return {
      extra: [
        `Livrer à : ${d.address}${d.phone ? ` · tél. ${d.phone}` : ''}`,
        `Livraison le ${dayFr(d.planned_date)}${d.slot ? `, ${d.slot}` : ''}${d.courier ? ` · livreur : ${d.courier}` : ''}`,
      ],
      notes: d.note,
    };
  }

  private header(): Receipt {
    const station = this.admin.station();
    if (!station) return [];
    const st = station.store;
    const set = this.admin.storeSettings(st.id);
    const centered = (text: string) => ({ t: 'text' as const, text, align: 'center' as const });
    return [
      ...(set.logo ? [{ t: 'image' as const, src: set.logo }] : []),
      { t: 'text', text: st.name, align: 'center', bold: true, big: true },
      ...(set.ticketHeader ? [centered(set.ticketHeader)] : []),
      ...[st.address, st.phone].filter((v): v is string => Boolean(v)).map(centered),
      ...(st.taxpayer_number ? [centered(`NIU : ${st.taxpayer_number}`)] : []),
      ...(set.rccm ? [centered(`RCCM : ${set.rccm}`)] : []),
      { t: 'rule' },
    ];
  }

  /** Variante d'une vente : à terme quand une partie passe sur le compte du client ou qu'une échéance est fixée. */
  saleVariant(saleId: string): DocVariant {
    const sale = this.pos.getSale(saleId);
    return sale.due_date || sale.payments.some((p) => p.method === 'CUSTOMER_CREDIT') ? 'credit' : 'cash';
  }

  /**
   * Modèle d'impression d'une vente : celui demandé (facture ou bon de livraison),
   * sinon celui par défaut du document, du format et de la variante.
   */
  saleTemplate(saleId: string, format: DocFormat | null, templateId?: string | null, doc: 'invoice' | 'delivery' = 'invoice'): DocTemplate {
    const set = this.admin.storeSettings(this.pos.getSale(saleId).store_id);
    const asked = templateId ? effectiveTemplates(set.printTemplates).find((t) => t.id === templateId && (t.doc === 'invoice' || t.doc === 'delivery')) : undefined;
    if (asked) return asked;
    return doc === 'delivery' ? resolveTemplate(set, 'delivery', format, 'delivery') : resolveTemplate(set, 'invoice', format, this.saleVariant(saleId));
  }

  /** Modèle d'impression d'un devis ou d'une proforma. */
  quoteTemplate(quoteId: string, format: DocFormat | null, templateId?: string | null): DocTemplate {
    const q = this.quotes!.get(quoteId);
    return resolveTemplate(this.admin.storeSettings(q.store_id), 'quote', format, q.kind, templateId);
  }

  /** Identité du magasin pour les modèles d'impression. */
  private docStore(storeId: string): DocData['store'] {
    const store = this.admin.getStore(storeId);
    const set = this.admin.storeSettings(storeId);
    return {
      name: store.name,
      address: store.address,
      phone: store.phone,
      niu: store.taxpayer_number,
      rccm: set.rccm,
      logo: set.logo,
      color: set.brandColor,
      message: set.ticketHeader,
      thanks: this.admin.getSetting('ticket.footer') ?? 'Merci de votre visite !',
      vatEnabled: store.vat_enabled === 1,
    };
  }

  private articleCodes(ids: string[]): Map<string, string> {
    if (!ids.length) return new Map();
    const rows = this.db.prepare(`SELECT id, code FROM articles WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids) as { id: string; code: string }[];
    return new Map(rows.map((a) => [a.id, a.code]));
  }

  /** Modèle d'impression d'un bon de commande ou d'une facture d'achat. */
  purchaseTemplate(doc: 'purchaseOrder' | 'purchaseInvoice', storeId: string, format: DocFormat | null, templateId?: string | null): DocTemplate {
    return resolveTemplate(this.admin.storeSettings(storeId), doc, format, doc === 'purchaseOrder' ? 'order' : 'supplierInvoice', templateId);
  }

  private supplierParty(supplierId: string): DocData['customer'] {
    const sup = this.purchases!.getSupplier(supplierId);
    return { name: sup.name, code: sup.code, address: sup.address, phone: sup.phone, niu: sup.taxpayer_number, balance: null, counter: false };
  }

  /** Remise en % et gratuits d'une ligne d'achat (« 12 achetés, 10 payés » rappelé sous les gratuits). */
  private purchaseTerms(l: { discount_bp: number; free_qty: number; promo_buy: number | null; promo_pay: number | null; unit: 'piece' | 'kg' | 'litre' }) {
    return {
      discountLabel: l.discount_bp ? `${(l.discount_bp / 100).toLocaleString('fr-FR')} %` : '',
      freeQty: l.free_qty ? `${formatQty(l.free_qty, l.unit)}${l.promo_buy && l.promo_pay !== null ? ` (${l.promo_buy} achetés, ${l.promo_pay} payés)` : ''}` : '',
    };
  }

  /** Contenu d'un bon de commande fournisseur pour les modèles d'impression. */
  purchaseOrderDoc(orderId: string): DocData {
    const o = this.purchases!.getOrder(orderId);
    return {
      store: this.docStore(o.store_id),
      customer: this.supplierParty(o.supplier_id),
      partyLabel: 'Fournisseur',
      doc: {
        kind: 'purchase',
        number: o.number,
        date: o.order_date,
        dueDate: null,
        seller: o.user_name ?? '',
        register: null,
        priceLevel: null,
        cancelled: o.status === 'cancelled',
        duplicate: false,
        notes: o.notes,
        extra: [...(o.expected_date ? [`Livraison souhaitée : ${dayFr(o.expected_date)}`] : []), `Livrer à : ${o.warehouse_name}`],
      },
      lines: o.lines.map((l) => ({
        code: l.article_code,
        barcode: null,
        label: l.article_name,
        qty: formatQty(l.qty, l.unit),
        unit: '',
        unitPrice: l.unit_cost,
        unitPriceHt: l.unit_cost,
        discount: 0,
        vatRate: 0,
        totalHt: l.total_ht,
        totalTtc: l.total_ht,
        promo: 0,
        promoName: null,
        detail: true,
        supplierRef: l.supplier_ref,
        netCost: l.qty ? Math.round((l.total_ht * 1000) / l.qty) : l.unit_cost,
        ...this.purchaseTerms(l),
      })),
      payments: [],
      totals: { ht: o.total_ht, tva: 0, ttc: o.total_ht, discount: 0, promo: 0, rounding: 0, change: 0, remaining: 0 },
    };
  }

  /** Contenu d'une facture d'achat ou d'un avoir fournisseur pour les modèles d'impression. */
  purchaseInvoiceDoc(invoiceId: string): DocData {
    const i = this.purchases!.getInvoice(invoiceId);
    const lines = this.purchases!.invoiceLines(invoiceId);
    return {
      store: this.docStore(i.store_id),
      customer: this.supplierParty(i.supplier_id),
      partyLabel: 'Fournisseur',
      doc: {
        kind: i.kind === 'invoice' ? 'purchase' : 'return',
        number: i.number,
        date: i.invoice_date,
        dueDate: i.due_date,
        seller: '',
        register: null,
        priceLevel: null,
        cancelled: false,
        duplicate: false,
        notes: i.notes,
        extra: [`Facture du fournisseur n° ${i.supplier_number} du ${dayFr(i.invoice_date)}`, ...(i.direct ? ['Saisie directe, sans bon de commande'] : [])],
      },
      lines: lines.map((l) => ({
        code: l.article_code,
        barcode: null,
        label: l.article_name,
        qty: formatQty(l.qty, l.unit),
        unit: '',
        unitPrice: l.gross_cost ?? l.unit_cost,
        unitPriceHt: l.gross_cost ?? l.unit_cost,
        discount: 0,
        vatRate: l.vat_rate_bp,
        totalHt: l.total_ht,
        totalTtc: l.total_ht,
        promo: 0,
        promoName: null,
        detail: true,
        netCost: l.unit_cost,
        ...this.purchaseTerms(l),
      })),
      payments: this.purchases!.invoicePayments(invoiceId).map((p) => ({
        label: `${dayFr(p.paid_at)} · ${SUPPLIER_PAYMENT_METHODS[p.method] ?? p.method}${p.reference ? ` (${p.reference})` : ''}`,
        amount: p.amount,
      })),
      totals: { ht: i.total_ht, tva: i.total_tva, ttc: i.total_ttc, discount: i.discount, promo: 0, rounding: 0, change: 0, remaining: i.balance },
    };
  }

  /** Contenu d'un devis ou d'une proforma pour les modèles d'impression. */
  quoteDoc(quoteId: string): DocData {
    const q = this.quotes!.get(quoteId);
    const c = q.customer_id ? this.customers.getCustomer(q.customer_id) : null;
    const codes = this.articleCodes(q.lines.map((l) => l.article_id));
    return {
      store: this.docStore(q.store_id),
      customer: c
        ? { name: c.name, code: c.code, address: c.address, phone: c.phone, niu: c.taxpayer_number, balance: null, counter: false }
        : q.customer_name
          ? { name: q.customer_name, code: null, address: null, phone: null, niu: null, balance: null, counter: false }
          : null,
      doc: {
        kind: 'quote',
        number: q.number,
        date: q.quote_date,
        dueDate: null,
        seller: q.user_name ?? '',
        register: null,
        priceLevel: c && c.price_level !== 'retail' ? PRICE_LEVELS[c.price_level] : null,
        cancelled: q.state === 'cancelled',
        duplicate: false,
        validUntil: q.valid_until,
        notes: q.notes,
      },
      lines: q.lines.map((l) => ({
        code: codes.get(l.article_id) ?? null,
        barcode: null,
        label: l.label,
        qty: formatQty(l.qty, l.unit),
        unit: '',
        unitPrice: l.unit_price,
        unitPriceHt: splitTtc(l.unit_price, l.vat_rate_bp).ht,
        discount: l.discount,
        vatRate: l.vat_rate_bp,
        totalHt: splitTtc(l.total_ttc, l.vat_rate_bp).ht,
        totalTtc: l.total_ttc,
        promo: 0,
        promoName: null,
        detail: l.qty !== 1000,
      })),
      payments: [],
      totals: { ht: q.total_ht, tva: q.total_tva, ttc: q.total_ttc, discount: q.total_discount, promo: 0, rounding: 0, change: 0, remaining: 0 },
    };
  }

  /** Contenu d'une vente pour les modèles de facture (ticket, A4, listing). */
  saleDoc(saleId: string, opts?: { duplicate?: boolean }): DocData {
    const sale = this.pos.getSale(saleId);
    const codes = this.articleCodes(sale.lines.map((l) => l.article_id));
    const register = this.db.prepare('SELECT name FROM registers WHERE id = ?').pluck().get(sale.register_id) as string | undefined;
    const c = sale.customer_id ? this.customers.getCustomer(sale.customer_id) : null;
    const balance = c ? this.customers.account(sale.store_id, c.id).balance : null;
    // Carte de fidélité : points de cette vente (gagnés moins dépensés) et solde du client.
    const loyalty = c
      ? (this.db
          .prepare(
            `SELECT COALESCE((SELECT SUM(points) FROM loyalty_moves WHERE sale_id = @sale AND kind IN ('earn', 'return')), 0) AS earned,
                    COALESCE((SELECT -SUM(points) FROM loyalty_moves WHERE sale_id = @sale AND kind = 'redeem'), 0) AS redeemed,
                    COALESCE((SELECT SUM(points) FROM loyalty_moves WHERE customer_id = @customer), 0) AS balance,
                    EXISTS (SELECT 1 FROM loyalty_moves WHERE customer_id = @customer) AS any`,
          )
          .get({ sale: sale.id, customer: c.id }) as { earned: number; redeemed: number; balance: number; any: number })
      : null;
    const unitNames = new Map(
      sale.lines.length
        ? (
            this.db
              .prepare(`SELECT id, unit, unit_name FROM articles WHERE id IN (${sale.lines.map(() => '?').join(',')})`)
              .all(...sale.lines.map((l) => l.article_id)) as { id: string; unit: string; unit_name: string | null }[]
          ).map((a) => [a.id, a.unit === 'piece' ? (a.unit_name ?? 'Pièce') : ''])
        : [],
    );
    // Dépôt de sortie : celui choisi à la caisse, sinon celui des mouvements de stock de la vente.
    const warehouse = this.db
      .prepare(
        `SELECT w.name FROM warehouses w WHERE w.id = COALESCE((SELECT warehouse_id FROM sales WHERE id = ?),
           (SELECT warehouse_id FROM stock_movements WHERE ref_type = 'sale' AND ref_id = ? LIMIT 1))`,
      )
      .pluck()
      .get(sale.id, sale.id) as string | undefined;
    return {
      store: this.docStore(sale.store_id),
      customer: c
        ? { name: c.name, code: c.code, address: c.address, phone: c.phone, niu: c.taxpayer_number, balance, counter: false }
        : sale.customer_name
          ? { name: sale.customer_name, code: null, address: null, phone: null, niu: null, balance: null, counter: true }
          : null,
      loyalty: loyalty?.any ? { earned: loyalty.earned, redeemed: loyalty.redeemed, balance: loyalty.balance } : null,
      doc: {
        kind: sale.kind,
        number: sale.number,
        date: sale.created_at,
        dueDate: sale.due_date,
        seller: sale.user_name,
        register: register ?? null,
        priceLevel: sale.price_level && sale.price_level !== 'retail' ? PRICE_LEVELS[sale.price_level] : null,
        cancelled: sale.status === 'cancelled',
        duplicate: Boolean(opts?.duplicate),
        warehouse: warehouse ?? null,
        ...this.deliveryInfo(sale.id),
      },
      lines: sale.lines.map((l) => {
        const pack = Boolean(l.pack_name && l.pack_units && l.pack_price !== null);
        const unitPrice = pack ? l.pack_price! : l.unit_price;
        return {
          code: codes.get(l.article_id) ?? null,
          barcode: l.barcode,
          label: l.label,
          qty: pack ? String(Math.abs(l.qty) / l.pack_units!) : formatQty(Math.abs(l.qty), l.unit),
          unit: pack ? l.pack_name! : '',
          unitPrice,
          unitPriceHt: splitTtc(unitPrice, l.vat_rate_bp).ht,
          discount: l.discount,
          vatRate: l.vat_rate_bp,
          totalHt: splitTtc(l.total_ttc, l.vat_rate_bp).ht,
          totalTtc: l.total_ttc,
          promo: l.promo,
          promoName: l.promotion_name,
          detail: pack || l.qty !== 1000,
          unitName: pack ? undefined : unitNames.get(l.article_id),
        };
      }),
      // La part payée par le dépôt d'avance du client s'affiche à part : ce n'est pas un crédit à régler.
      payments: sale.payments.flatMap((p) => {
        const advance = p.method === 'CUSTOMER_CREDIT' ? Math.min(p.amount, sale.advance_used ?? 0) : 0;
        return [
          ...(advance ? [{ label: "Payé sur l'avance", amount: advance }] : []),
          ...(p.amount > advance ? [{ label: `${PAYMENT_METHODS[p.method]}${p.reference ? ` ${p.reference}` : ''}`, amount: p.amount - advance }] : []),
        ];
      }),
      totals: {
        ht: sale.total_ht,
        tva: sale.total_tva,
        ttc: sale.total_ttc,
        discount: sale.total_discount,
        promo: sale.total_promo,
        rounding: sale.rounding,
        change: sale.change_given,
        remaining: Math.max(0, sale.payments.filter((p) => p.method === 'CUSTOMER_CREDIT').reduce((t, p) => t + p.amount, 0) - (sale.advance_used ?? 0)),
      },
    };
  }

  /** Ticket de caisse d'une vente, selon le modèle ticket choisi (ou celui par défaut de sa variante). */
  ticket(saleId: string, opts?: { templateId?: string | null; duplicate?: boolean }): Receipt {
    const template = this.saleTemplate(saleId, 'ticket', opts?.templateId);
    // Un modèle A4 ou listing demandé au ticket : on prend le ticket par défaut.
    const t = template.format === 'ticket' ? template : this.saleTemplate(saleId, 'ticket');
    return renderDocTicket(t, this.saleDoc(saleId, opts));
  }

  zReport(sessionId: string): Receipt {
    const z = this.pos.zReport(sessionId);
    const row = (left: string, v: number) => ({ t: 'row' as const, left, right: money(v) });
    const title = (text: string) => ({ t: 'text' as const, text, bold: true });
    const r: Receipt = this.header();
    r.push(
      { t: 'text', text: `RAPPORT Z${z.session.z_number ? ` N° ${z.session.z_number}` : ' (provisoire)'}`, align: 'center', bold: true },
      { t: 'text', text: `${z.registerName} · ${z.session.user_name}` },
      { t: 'text', text: `Ouverture ${dateFr(z.session.opened_at)}` },
    );
    if (z.session.closed_at) r.push({ t: 'text', text: `Clôture ${dateFr(z.session.closed_at)}` });
    if (z.declared) {
      // Caisse électronique ou banque : départ, encaissé, sorties, solde relevé et écart par moyen.
      r.push({ t: 'rule' });
      const used = z.declared.filter((l) => l.opening || l.received || l.outflows || l.inflows || l.declared);
      for (const l of used.length ? used : z.declared) {
        r.push(title(l.label));
        if (l.opening) r.push(row('  Solde de départ', l.opening));
        r.push(row('  Encaissé', l.received));
        if (l.inflows) r.push(row('  Transferts reçus', l.inflows));
        if (l.outflows) r.push(row('  Sorties', -l.outflows));
        if (l.opening || l.inflows || l.outflows) r.push(row('  Attendu', l.expected));
        if (l.declared !== null) r.push(row('  Relevé', l.declared), row('  Écart', l.declared - l.expected));
        if (l.deposited) r.push(row('  Versé à la centrale', l.deposited));
        if (l.left !== null && l.deposited) r.push(row('  Reste sur le compte', l.left));
      }
      r.push({ t: 'rule' }, { ...row('Total attendu', z.declared.reduce((t, l) => t + l.expected, 0)), bold: true });
      if (z.counted !== null) r.push(row('Total relevé', z.counted), { ...row('Écart', z.difference ?? 0), bold: true });
      if (z.session.gap_reason) r.push({ t: 'text', text: `Motif de l'écart : ${z.session.gap_reason}` });
      const exits = z.emoneyJournal?.exits.filter((e) => !e.closing) ?? [];
      if (exits.length) {
        r.push({ t: 'rule' }, title('Sorties du compte'));
        for (const e of exits) r.push(row(`${e.nature} ${e.label}`.slice(0, 40), e.amount), { t: 'row', left: `${e.method_label}${e.reference ? ` ${e.reference}` : ''}`, right: '', indent: 2 });
      }
      if (z.emoneyDeposit) r.push({ t: 'rule' }, { t: 'text', text: `Versement ${z.emoneyDeposit.number} vers ${z.emoneyDeposit.centralName}` });
      return r;
    }
    r.push(
      { t: 'rule' },
      { t: 'row', left: 'Tickets', right: String(z.ticketCount) },
      row('Ventes TTC', z.salesTtc),
      row('Retours', z.returnsTtc),
      { ...row('CA net TTC', z.netTtc), bold: true },
      row('Remises', z.discounts),
      row('Promotions', z.promotions),
      row(`Annulations (${z.cancelled.count})`, z.cancelled.amount),
      { t: 'rule' },
      title('Encaissements'),
      ...z.byMethod.map((m) => row(m.label, m.amount)),
      { t: 'rule' },
    );
    if (z.elsewhere.length) r.push(title('Payé sur une autre caisse'), ...z.elsewhere.map((m) => row(`${m.label} (${m.registerName})`, m.amount)), { t: 'rule' });
    if (z.customerReceipts.length) r.push(title('Règlements clients (crédit)'), ...z.customerReceipts.map((m) => row(m.label, m.amount)), { t: 'rule' });
    if (z.expenses.length) r.push(title('Dépenses payées en caisse'), ...z.expenses.map((e) => row(`${e.number} ${e.label}`, e.amount)), { t: 'rule' });
    if (z.vat.some((v) => v.rate > 0)) r.push(title('TVA'), ...z.vat.map((v) => row(`${formatRate(v.rate)} HT ${money(v.ht)}`, v.tva)), { t: 'rule' });
    else r.push({ t: 'text', text: 'TVA non applicable' }, { t: 'rule' });
    r.push(title('Espèces'), row('Fond de caisse', z.cash.openingFloat), row('Ventes espèces', z.cash.cashSales));
    r.push(row('Remboursements', -z.cash.cashRefunds), row('Apports', z.cash.cashIn), row('Prélèvements', -z.cash.cashOut));
    if (z.cash.customerReceipts) r.push(row('Règlements clients', z.cash.customerReceipts));
    if (z.cash.expenses) r.push(row('Dépenses payées', -z.cash.expenses));
    if (z.cash.otherIn) r.push(row('Autres entrées (Encaisser)', z.cash.otherIn));
    if (z.cash.otherOut) r.push(row('Autres sorties (Décaisser)', -z.cash.otherOut));
    r.push({ ...row('Théorique', z.cash.expected), bold: true });
    if (z.counted !== null) r.push(row('Compté', z.counted), { ...row('Écart', z.difference ?? 0), bold: true });
    if (z.session.gap_reason) r.push({ t: 'text', text: `Motif de l'écart : ${z.session.gap_reason}` });
    if (z.session.deposit !== null) r.push({ t: 'rule' }, row('Versé à la caisse centrale', z.session.deposit), row('Fond laissé dans le tiroir', z.session.float_left ?? 0));
    if (z.byCashier.length) {
      // Relève d'équipe : la part de chaque caissier dans la même journée.
      r.push({ t: 'rule' }, title('Par caissier'));
      for (const c of z.byCashier) {
        r.push(row(`${c.name} (${c.tickets} t.)`.slice(0, 32), c.net));
        if (c.difference !== null) r.push({ t: 'row', left: 'Écart de son tour', right: money(c.difference), indent: 2 });
      }
      for (const h of z.handovers) r.push({ t: 'text', text: `Relève ${dateFr(h.at).slice(-5)} : ${h.from_name} > ${h.to_name}` });
    }
    return r;
  }

  /**
   * Bon de versement à la caisse centrale (recette du jour, prélèvement) ou
   * bon de remise de fond : à signer par celui qui remet et celui qui reçoit.
   */
  /** Fiche de comptage d'inventaire sur l'imprimante de tickets (80 mm), selon le modèle choisi. */
  inventorySheet(inventoryId: string, model: InventorySheetModel): Receipt {
    if (!this.inventories) return [];
    const { inventory: inv, lines } = this.inventories.get(inventoryId);
    const r: Receipt = [
      ...this.header(),
      { t: 'text', text: `INVENTAIRE N° ${inv.number}`, align: 'center', bold: true },
      { t: 'text', text: `${INVENTORY_SHEET_MODELS[model]}`, align: 'center' },
      { t: 'text', text: `${inv.warehouse_name} · ${dayFr(inv.inventory_date)} · ${lines.length} produits` },
      { t: 'rule' },
    ];
    let dept: string | null | undefined;
    for (const l of lines) {
      if (l.department_name !== dept) {
        dept = l.department_name;
        r.push({ t: 'text', text: (dept ?? 'Sans rayon').toUpperCase(), bold: true });
      }
      r.push({ t: 'text', text: `${l.code} ${l.name}` });
      const levels = l.unit === 'piece' ? [...l.packs.map((p) => p.name), l.unit_name || 'Pièce'] : [l.unit === 'kg' ? 'kg' : 'litres'];
      const blanks = levels.map((v) => `....${v}`).join(' ');
      const q = (v: number | null) => (v === null ? '' : formatQty(v, l.unit));
      if (model === 'blind') r.push({ t: 'text', text: `  ${blanks}` });
      else if (model === 'withStock') r.push({ t: 'row', left: `  ${blanks}`, right: `att. ${q(l.expected)}` });
      else if (model === 'control') r.push({ t: 'row', left: `  att. ${q(l.expected)} cpt. ${q(l.counted) || '-'}`, right: l.difference === null ? '' : `écart ${q(l.difference)}` });
      else r.push({ t: 'row', left: '  Compté', right: q(l.counted) || '-' });
    }
    r.push({ t: 'rule' }, { t: 'feed' }, { t: 'row', left: 'Compté par', right: 'Signature' }, { t: 'feed' }, { t: 'feed' }, { t: 'row', left: '................', right: '................' });
    return r;
  }

  /** Bon de passation d'une relève d'équipe : à signer par le caissier qui part et celui qui arrive. */
  handoverSlip(handoverId: string): Receipt {
    const h = this.pos.getHandover(handoverId);
    const register = this.admin.getRegister(h.register_id);
    const row = (left: string, v: number, bold = false) => ({ t: 'row' as const, left, right: money(v), bold });
    return [
      ...this.header(),
      { t: 'text', text: "BON DE PASSATION (RELÈVE D'ÉQUIPE)", align: 'center', bold: true },
      { t: 'text', text: `${register.name} · relève n° ${h.number}` },
      { t: 'text', text: dateFr(h.at) },
      { t: 'rule' },
      { t: 'text', text: `Part : ${h.from_name}` },
      { t: 'text', text: `Arrive : ${h.to_name}` },
      { t: 'rule' },
      row('Espèces attendues', h.expected),
      row('Espèces comptées', h.counted),
      row(`Écart de ${h.from_name}`.slice(0, 32), h.difference, true),
      { t: 'text', text: 'La journée continue : même fond, même Z.' },
      { t: 'rule' },
      { t: 'feed' },
      { t: 'row', left: 'Remis par', right: 'Reçu par' },
      { t: 'feed' },
      { t: 'feed' },
      { t: 'row', left: '................', right: '................' },
    ];
  }

  centralVoucher(movementId: string): Receipt {
    const m = this.treasury.getMovement(movementId);
    const titles = { DEPOSIT: 'BON DE VERSEMENT', FLOAT: 'BON DE REMISE DE FOND', IN: 'ENTRÉE EN CAISSE CENTRALE', OUT: 'SORTIE DE CAISSE CENTRALE' } as const;
    const session = m.session_id ? this.pos.getSession(m.session_id) : null;
    const r: Receipt = [
      ...this.header(),
      { t: 'text', text: titles[m.kind], align: 'center', bold: true },
      { t: 'text', text: m.number },
      { t: 'text', text: [dateFr(m.at), m.user_name].filter(Boolean).join(' · ') },
      { t: 'rule' },
      { t: 'text', text: m.label, bold: true },
    ];
    if (m.register_name) r.push({ t: 'text', text: m.kind === 'FLOAT' ? `De : caisse centrale · À : ${m.register_name}` : `De : ${m.register_name} · À : caisse centrale` });
    if (session?.z_number && m.kind === 'DEPOSIT' && !m.cash_operation_id) {
      r.push({ t: 'row', left: `Espèces comptées (Z${session.z_number})`, right: money(session.counted_cash ?? 0) });
      r.push({ t: 'row', left: 'Fond laissé dans le tiroir', right: money(session.float_left ?? 0) });
    }
    r.push(
      { t: 'row', left: 'Montant FCFA', right: money(m.amount), bold: true },
      { t: 'rule' },
      { t: 'feed' },
      { t: 'row', left: m.kind === 'FLOAT' ? 'Remis par' : 'Versé par', right: 'Reçu par' },
      { t: 'feed' },
      { t: 'feed' },
      { t: 'row', left: '................', right: '................' },
    );
    return r;
  }

  /** Bon d'achat imprimé : montant, code-barres à scanner en caisse, date de fin. */
  giftVoucher(v: GiftVoucher): Receipt {
    const titles = { sold: "BON D'ACHAT", refund: "BON D'AVOIR", change: 'BON DE MONNAIE' } as const;
    const r: Receipt = [
      ...this.header(),
      { t: 'text', text: titles[v.kind], align: 'center', bold: true, big: true },
      { t: 'text', text: `${money(v.amount)} FCFA`, align: 'center', bold: true, big: true },
      { t: 'feed' },
    ];
    if (v.holder || v.customer_name) r.push({ t: 'text', text: `Pour : ${v.holder ?? v.customer_name}`, align: 'center' });
    r.push(
      { t: 'text', text: `Émis le ${dateFr(v.created_at)}${v.sale_number ? ` (ticket ${v.sale_number})` : ''}`, align: 'center' },
      { t: 'text', text: v.expires_on ? `Valable jusqu'au ${v.expires_on.split('-').reverse().join('/')}` : 'Sans date de fin', align: 'center', bold: true },
      { t: 'barcode', code: v.code },
      { t: 'text', text: 'À présenter en caisse, dans ce magasin. Utilisable en plusieurs fois ; non remboursable en espèces.', align: 'center' },
    );
    return r;
  }

  /**
   * Bon d'un mouvement de caisse électronique : versement de la recette vers la
   * centrale (tous les moyens du même bon), transfert, dépôt à la banque…
   */
  emoneyVoucher(movementId: string): Receipt {
    const emoney = new EmoneyService(this.db, this.clock);
    const m = emoney.get(movementId);
    const out = m.direction === 'OUT' ? m : m.counterpart_id ? emoney.get(m.counterpart_id) : m;
    const lines = this.db
      .prepare("SELECT id FROM emoney_movements WHERE number = ? AND direction = ? ORDER BY method")
      .pluck()
      .all(out.number, out.direction)
      .map((id) => emoney.get(id as string));
    const title =
      out.nature === 'deposit'
        ? 'BON DE VERSEMENT ÉLECTRONIQUE'
        : out.nature === 'register'
          ? 'TRANSFERT ÉLECTRONIQUE'
          : out.direction === 'IN'
            ? 'ENTRÉE CAISSE ÉLECTRONIQUE'
            : 'SORTIE CAISSE ÉLECTRONIQUE';
    const r: Receipt = [
      ...this.header(),
      { t: 'text', text: title, align: 'center', bold: true },
      { t: 'text', text: out.number },
      { t: 'text', text: [dateFr(out.at), out.user_name].filter(Boolean).join(' · ') },
      { t: 'rule' },
      { t: 'text', text: out.label, bold: true },
      { t: 'text', text: out.other_name ? `De : ${out.register_name} · À : ${out.other_name}` : out.register_name },
      { t: 'rule' },
    ];
    for (const l of lines) r.push({ t: 'row', left: PAYMENT_METHODS[l.method], right: money(l.amount) }, ...(l.reference ? [{ t: 'row' as const, left: `Réf. ${l.reference}`, right: '', indent: 2 }] : []));
    if (lines.length > 1) r.push({ t: 'row', left: 'Total FCFA', right: money(lines.reduce((t, l) => t + l.amount, 0)), bold: true });
    // Versement de clôture : solde relevé et reste laissé sur le compte du caissier.
    if (out.nature === 'deposit' && out.session_id) {
      const z = this.pos.zReport(out.session_id);
      for (const l of z.declared ?? []) if (l.deposited) r.push({ t: 'row', left: `${l.label} : relevé ${money(l.declared ?? 0)}`, right: `reste ${money(l.left ?? 0)}` });
    }
    r.push(
      { t: 'rule' },
      { t: 'feed' },
      { t: 'row', left: out.nature === 'deposit' ? 'Versé par' : 'Fait par', right: out.nature === 'deposit' || out.nature === 'register' ? 'Reçu par' : 'Le responsable' },
      { t: 'feed' },
      { t: 'feed' },
      { t: 'row', left: '................', right: '................' },
    );
    return r;
  }

  /** Reçu de règlement d'un client à crédit. */
  customerReceipt(paymentId: string): Receipt {
    const p = this.customers.getPayment(paymentId);
    const acc = this.customers.account(p.store_id, p.customer_id);
    return [
      ...this.header(),
      { t: 'text', text: p.advance ? "REÇU DE DÉPÔT D'AVANCE" : 'REÇU DE RÈGLEMENT', align: 'center', bold: true },
      { t: 'text', text: p.number },
      { t: 'text', text: `${dateFr(p.paid_at)}${p.user_name ? ` · ${p.user_name}` : ''}` },
      { t: 'text', text: `Client : ${p.customer_name}` },
      { t: 'rule' },
      { t: 'row', left: 'Reçu FCFA', right: money(p.amount), bold: true, big: true },
      { t: 'text', text: `${CUSTOMER_PAYMENT_METHODS[p.method]}${p.reference ? ` ${p.reference}` : ''}` },
      acc.balance < 0 ? { t: 'row', left: 'Avance disponible', right: money(-acc.balance), bold: true } : { t: 'row', left: 'Reste dû après règlement', right: money(acc.balance) },
      { t: 'rule' },
      { t: 'text', text: 'Merci !', align: 'center' },
    ];
  }

  /**
   * Bon remis au client par le vendeur (vendeur et caissier séparés) : il le
   * présente à la caisse, qui retrouve la facture par son numéro ou son code-barres.
   */
  counterSlip(slip: {
    number: number;
    version: number;
    sellerName: string;
    customerName: string | null;
    at: string;
    total: number;
    lines: { label: string; qty: string; amount: number }[];
  }): Receipt {
    const r: Receipt = [
      ...this.header(),
      { t: 'text', text: 'FACTURE À PAYER EN CAISSE', align: 'center', bold: true },
      { t: 'text', text: `N° ${slip.number}`, align: 'center', bold: true, big: true },
      { t: 'text', text: `${dateFr(slip.at)} · Vendeur : ${slip.sellerName}${slip.version > 1 ? ' · modifiée' : ''}`, align: 'center' },
    ];
    if (slip.customerName) r.push({ t: 'text', text: `Client : ${slip.customerName}`, align: 'center' });
    r.push({ t: 'rule' });
    for (const l of slip.lines) r.push({ t: 'text', text: l.label }, { t: 'row', left: `  ${l.qty}`, right: money(l.amount) });
    r.push(
      { t: 'rule' },
      { t: 'row', left: 'À PAYER FCFA', right: money(slip.total), bold: true, big: true },
      { t: 'barcode', code: counterCode(slip.number) },
      { t: 'text', text: 'Présentez ce bon à la caisse. Le ticket de caisse fait foi.', align: 'center' },
    );
    return r;
  }

  /** Bon de ristourne : avoir sur le compte du client ou paiement en espèces, à faire signer. */
  rebateVoucher(entryId: string): Receipt {
    if (!this.rebates) throw new Error('Ristournes indisponibles');
    const e = this.rebates.getEntry(entryId);
    const left = this.rebates.balance(this.db.prepare('SELECT store_id FROM rebate_entries WHERE id = ?').pluck().get(entryId) as string, e.customer_id);
    const r: Receipt = [
      ...this.header(),
      { t: 'text', text: 'BON DE RISTOURNE', align: 'center', bold: true },
      { t: 'text', text: e.number },
      { t: 'text', text: `${dateFr(e.at)}${e.user_name ? ` · ${e.user_name}` : ''}` },
      { t: 'text', text: `Client : ${e.customer_name}` },
      { t: 'rule' },
      { t: 'text', text: e.label },
    ];
    if (e.period_from && e.period_to) r.push({ t: 'text', text: `Période du ${dayFr(e.period_from)} au ${dayFr(e.period_to)}` });
    r.push(
      { t: 'row', left: `${REBATE_KINDS[e.kind]} FCFA`, right: money(e.amount), bold: true, big: true },
      ...(e.kind === 'cash' && e.method !== 'CASH'
        ? [{ t: 'text' as const, text: `${PAYMENT_METHODS[e.method as 'MTN_MOMO'] ?? e.method}${e.reference ? ` · Réf. ${e.reference}` : ''}${e.register_name ? ` · ${e.register_name}` : ''}` }]
        : []),
      { t: 'row', left: 'Reste de ristourne à accorder', right: money(left) },
      { t: 'rule' },
      { t: 'row', left: 'Le client', right: 'Le responsable' },
      { t: 'feed' },
      { t: 'feed' },
      { t: 'feed' },
    );
    return r;
  }

  /** Bon de sortie de caisse ou pièce de dépense, à faire signer. */
  expenseVoucher(expenseId: string): Receipt {
    const e = this.expenses.get(expenseId);
    const r: Receipt = [
      ...this.header(),
      { t: 'text', text: e.session_id ? 'BON DE SORTIE DE CAISSE' : 'PIÈCE DE DÉPENSE', align: 'center', bold: true },
      { t: 'text', text: `${e.number}${e.status === 'cancelled' ? ' · ANNULÉE' : ''}`, bold: e.status === 'cancelled' },
      { t: 'text', text: [dayFr(e.expense_date), e.register_name, e.user_name].filter(Boolean).join(' · ') },
      { t: 'rule' },
      { t: 'text', text: e.category_name },
      { t: 'text', text: e.label, bold: true },
    ];
    if (e.beneficiary) r.push({ t: 'text', text: `Bénéficiaire : ${e.beneficiary}` });
    r.push({ t: 'rule' }, { t: 'row', left: 'Montant FCFA', right: money(e.amount), bold: true, big: true });
    if (e.vat) r.push({ t: 'row', left: 'dont TVA récupérable', right: money(e.vat) });
    r.push({ t: 'text', text: `${EXPENSE_PAYMENT_METHODS[e.method]}${e.reference ? ` ${e.reference}` : ''}` });
    if (e.authorized_by_name) r.push({ t: 'text', text: `Autorisé par ${e.authorized_by_name}` });
    r.push({ t: 'rule' }, { t: 'row', left: 'Le bénéficiaire', right: 'Le responsable' }, { t: 'feed' }, { t: 'feed' }, { t: 'feed' });
    return r;
  }

  /**
   * Reçu d'une entrée ou bon d'une sortie de caisse, tels que les montrent les
   * Opérations de trésorerie (« Imprimer le reçu », bon de « Décaisser »).
   */
  deskTicket(input: { row: CashJournalRow; direction: 'IN' | 'OUT'; register: string; duplicate?: boolean; authorizedBy?: string | null }): Receipt {
    const { row: x, direction } = input;
    const r: Receipt = [
      ...this.header(),
      { t: 'text', text: direction === 'IN' ? 'REÇU DE CAISSE' : 'BON DE SORTIE DE CAISSE', align: 'center', bold: true },
      ...(input.duplicate ? [{ t: 'text' as const, text: 'DUPLICATA', align: 'center' as const, bold: true }] : []),
      ...(x.number ? [{ t: 'text' as const, text: x.number }] : []),
      { t: 'text', text: [dateFr(x.at), input.register, x.user_name].filter(Boolean).join(' · ') },
      { t: 'rule' },
      { t: 'text', text: x.nature },
      // Le n° de pièce est déjà en tête : le motif seul.
      { t: 'text', text: x.number && x.label.startsWith(x.number) ? x.label.slice(x.number.length).trim() || x.nature : x.label, bold: true },
    ];
    if (x.party) r.push({ t: 'text', text: `${direction === 'IN' ? 'Reçu de' : 'Bénéficiaire'} : ${x.party}` });
    r.push(
      { t: 'rule' },
      { t: 'row', left: 'Montant FCFA', right: money(x.amount), bold: true, big: true },
      { t: 'text', text: `${x.method_label ?? PAYMENT_METHODS.CASH}${x.reference ? ` · Réf. ${x.reference}` : ''}` },
    );
    if (input.authorizedBy) r.push({ t: 'text', text: `Autorisé par ${input.authorizedBy}` });
    r.push(
      { t: 'rule' },
      { t: 'row', left: direction === 'IN' ? 'Le client' : 'Le bénéficiaire', right: 'Le caissier' },
      { t: 'feed' },
      { t: 'feed' },
      { t: 'feed' },
    );
    return r;
  }

  /** Page de test : vérifie la largeur du papier, les accents et la coupe. */
  testPage(columns: number): Receipt {
    const ruler = Array.from({ length: columns }, (_, i) => String((i + 1) % 10)).join('');
    return [
      ...this.header(),
      { t: 'text', text: 'PAGE DE TEST', align: 'center', bold: true, big: true },
      { t: 'text', text: dateFr(this.now()), align: 'center' },
      { t: 'rule' },
      { t: 'text', text: `Largeur : ${columns} caractères` },
      { t: 'text', text: ruler },
      { t: 'text', text: 'Accents : é è ê à â ç ù û ô î' },
      { t: 'text', text: 'Majuscules : É È À Ç' },
      { t: 'row', left: 'Libellé à gauche', right: money(12_500) },
      { t: 'row', left: 'TOTAL FCFA', right: money(1_250_000), bold: true, big: true },
      { t: 'rule' },
      { t: 'text', text: 'Si les accents sont faux, changez la table de caractères dans Paramètres.', align: 'center' },
    ];
  }

  /** Trace chaque ouverture du tiroir hors encaissement (bouton « Ouvrir le tiroir »). */
  drawerOpened(ctx: Context): void {
    this.audit(ctx.userId, 'drawer.open', 'register', ctx.registerId ?? undefined, { reason: 'manual' });
  }
}
