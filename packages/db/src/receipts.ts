import { PAYMENT_METHODS, PRICE_LEVELS, formatFcfa, formatQty, formatRate, splitTtc, type Receipt } from '@superette/core';
import type { AdminService } from './admin';
import { CUSTOMER_PAYMENT_METHODS, type CustomerService } from './customers';
import { EXPENSE_PAYMENT_METHODS, type ExpenseService } from './expenses';
import type { Db } from './database';
import type { PosService } from './pos';
import type { TreasuryService } from './treasury';
import { Base, type Clock, type Context } from './util';

const money = (v: number) => formatFcfa(v, false);
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
  ) {
    super(db, clock);
  }

  private header(): Receipt {
    const station = this.admin.station();
    if (!station) return [];
    const st = station.store;
    return [
      { t: 'text', text: st.name, align: 'center', bold: true, big: true },
      ...[st.address, st.phone].filter((v): v is string => Boolean(v)).map((text) => ({ t: 'text' as const, text, align: 'center' as const })),
      ...(st.taxpayer_number ? [{ t: 'text' as const, text: `NIU : ${st.taxpayer_number}`, align: 'center' as const }] : []),
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
    if (z.customerReceipts.length) r.push(title('Règlements clients (crédit)'), ...z.customerReceipts.map((m) => row(m.label, m.amount)), { t: 'rule' });
    if (z.expenses.length) r.push(title('Dépenses payées en caisse'), ...z.expenses.map((e) => row(`${e.number} ${e.label}`, e.amount)), { t: 'rule' });
    if (z.vat.some((v) => v.rate > 0)) r.push(title('TVA'), ...z.vat.map((v) => row(`${formatRate(v.rate)} HT ${money(v.ht)}`, v.tva)), { t: 'rule' });
    else r.push({ t: 'text', text: 'TVA non applicable' }, { t: 'rule' });
    r.push(title('Espèces'), row('Fond de caisse', z.cash.openingFloat), row('Ventes espèces', z.cash.cashSales));
    r.push(row('Remboursements', -z.cash.cashRefunds), row('Apports', z.cash.cashIn), row('Prélèvements', -z.cash.cashOut));
    if (z.cash.customerReceipts) r.push(row('Règlements clients', z.cash.customerReceipts));
    if (z.cash.expenses) r.push(row('Dépenses payées', -z.cash.expenses));
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
