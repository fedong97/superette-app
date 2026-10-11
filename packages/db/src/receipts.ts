import { PAYMENT_METHODS, PRICE_LEVELS, formatFcfa, formatQty, formatRate, splitTtc, type Receipt } from '@superette/core';
import type { AdminService } from './admin';
import { CUSTOMER_PAYMENT_METHODS, type CustomerService } from './customers';
import { EXPENSE_PAYMENT_METHODS, type ExpenseService } from './expenses';
import type { Db } from './database';
import type { CashJournalRow, PosService } from './pos';
import type { TreasuryService } from './treasury';
import type { InventoryService } from './inventories';
import { REBATE_KINDS, type RebateService } from './rebates';
import { EmoneyService } from './emoney';
import { Base, type Clock, type Context } from './util';

const money = (v: number) => formatFcfa(v, false);

/** Modèles de fiche de comptage (comme dans KONTROL). */
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
  ) {
    super(db, clock);
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

  ticket(saleId: string): Receipt {
    const sale = this.pos.getSale(saleId);
    const footer = this.admin.getSetting('ticket.footer') ?? 'Merci de votre visite !';
    const r: Receipt = this.header();
    if (sale.kind === 'return') r.push({ t: 'text', text: 'RETOUR CLIENT', bold: true });
    r.push({ t: 'text', text: `Ticket ${sale.number}` }, { t: 'text', text: `${dateFr(sale.created_at)} · ${sale.user_name}` });
    if (sale.customer_name) r.push({ t: 'text', text: `Client : ${sale.customer_name}` });
    if (sale.price_level && sale.price_level !== 'retail') r.push({ t: 'text', text: `Tarif : ${PRICE_LEVELS[sale.price_level]}` });
    r.push({ t: 'rule' });
    for (const l of sale.lines) {
      r.push({ t: 'row', left: l.label, right: money(l.total_ttc + l.promo) });
      const discount = l.discount ? ` (remise ${money(l.discount)})` : '';
      if (l.pack_name && l.pack_units && l.pack_price !== null)
        r.push({ t: 'row', left: `${Math.abs(l.qty) / l.pack_units} ${l.pack_name} x ${money(l.pack_price)}${discount}`, right: '', indent: 2 });
      else if (l.qty !== 1000 || l.discount)
        r.push({ t: 'row', left: `${formatQty(Math.abs(l.qty), l.unit)} x ${money(l.unit_price)}${discount}`, right: '', indent: 2 });
      if (l.promo) r.push({ t: 'row', left: `Promo ${l.promotion_name ?? ''}`.trim(), right: `-${money(l.promo)}`, indent: 2 });
    }
    r.push({ t: 'rule' }, { t: 'row', left: 'TOTAL FCFA', right: money(sale.total_ttc), bold: true, big: true });
    if (sale.rounding) r.push({ t: 'row', left: 'dont arrondi espèces', right: `-${money(sale.rounding)}`, indent: 2 });
    if (sale.total_promo > 0) r.push({ t: 'row', left: 'Vous avez économisé', right: money(sale.total_promo), bold: true });
    for (const p of sale.payments) r.push({ t: 'row', left: `${PAYMENT_METHODS[p.method]}${p.reference ? ` ${p.reference}` : ''}`, right: money(p.amount) });
    if (sale.change_given) r.push({ t: 'row', left: 'Rendu monnaie', right: money(sale.change_given), bold: true });
    if (sale.due_date) r.push({ t: 'text', text: `À régler avant le ${dayFr(sale.due_date)}` });
    r.push({ t: 'rule' });
    if (sale.lines.every((l) => l.vat_rate_bp === 0) && this.admin.getStore(sale.store_id).vat_enabled !== 1) {
      // Magasin non assujetti (régime simplifié).
      r.push({ t: 'text', text: 'TVA non applicable', align: 'center' });
    } else {
      const byRate = new Map<number, number>();
      for (const l of sale.lines) byRate.set(l.vat_rate_bp, (byRate.get(l.vat_rate_bp) ?? 0) + l.total_ttc);
      for (const [rate, ttc] of byRate) r.push({ t: 'row', left: `TVA ${formatRate(rate)} sur ${money(ttc)}`, right: money(splitTtc(ttc, rate).tva) });
      r.push({ t: 'row', left: 'dont TVA', right: money(sale.total_tva) });
    }
    r.push({ t: 'rule' }, { t: 'text', text: footer, align: 'center' });
    return r;
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
      { t: 'text', text: 'REÇU DE RÈGLEMENT', align: 'center', bold: true },
      { t: 'text', text: p.number },
      { t: 'text', text: `${dateFr(p.paid_at)}${p.user_name ? ` · ${p.user_name}` : ''}` },
      { t: 'text', text: `Client : ${p.customer_name}` },
      { t: 'rule' },
      { t: 'row', left: 'Reçu FCFA', right: money(p.amount), bold: true, big: true },
      { t: 'text', text: `${CUSTOMER_PAYMENT_METHODS[p.method]}${p.reference ? ` ${p.reference}` : ''}` },
      { t: 'row', left: 'Reste dû après règlement', right: money(acc.balance) },
      { t: 'rule' },
      { t: 'text', text: 'Merci !', align: 'center' },
    ];
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
      { t: 'text', text: x.label, bold: true },
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
