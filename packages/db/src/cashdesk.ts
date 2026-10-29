import { type Fcfa, PAYMENT_METHODS, parseStoreSettings } from '@superette/core';
import type { CustomerPaymentMethod, CustomerService } from './customers';
import { ENTRY_KINDS, EmoneyService, type EntryKind, isPayout } from './emoney';
import type { ExpenseService } from './expenses';
import type { CashJournalRow, PosService } from './pos';
import type { PurchaseService, SupplierPaymentMethod } from './purchases';
import { type StaffService, periodLabel } from './staff';
import type { TreasuryService } from './treasury';
import { AppError, Base, type Clock, type Context, newId } from './util';
import { CONTAINER_ACCOUNT } from './containers';
import type { GiftVoucher, VoucherService } from './vouchers';
import type { Db } from './database';


/** Sens de chaque nature : une avance sort, un remboursement du personnel entre. */
const ENTRY_DIRECTION: Record<EntryKind, 'IN' | 'OUT' | null> = {
  staff_advance: 'OUT',
  staff_salary: 'OUT',
  staff_repayment: 'IN',
  customer_refund: 'OUT',
  container_deposit: 'IN',
  container_refund: 'OUT',
  agent_in: 'IN',
  agent_out: 'OUT',
  voucher_sale: 'IN',
  other: null,
};

/** Moyens d'une entrée ou sortie saisie au bureau. */
export const OFFICE_METHODS = { CASH: 'Espèces (caisse centrale)', MTN_MOMO: 'MTN MoMo', ORANGE_MONEY: 'Orange Money', BANK_TRANSFER: 'Virement', CHEQUE: 'Chèque' } as const;

export interface TreasuryEntry {
  id: string;
  number: string;
  store_id: string;
  direction: 'IN' | 'OUT';
  kind: EntryKind;
  amount: Fcfa;
  method: string;
  reference: string | null;
  piece: string | null;
  label: string;
  party: string | null;
  staff_id: string | null;
  staff_name: string | null;
  salary_id: string | null;
  customer_id: string | null;
  customer_name: string | null;
  account_id: string | null;
  account_label: string | null;
  register_id: string | null;
  register_name: string | null;
  session_id: string | null;
  from_central: number;
  status: 'active' | 'cancelled';
  cancel_reason: string | null;
  authorized_by_name: string | null;
  printed: number;
  user_id: string | null;
  user_name: string | null;
  at: string;
}

export interface EntryInput {
  direction: 'IN' | 'OUT';
  kind: EntryKind;
  amount: Fcfa;
  method: string;
  reference?: string | null;
  /** N° de pièce ou de reçu écrit à la main. */
  piece?: string | null;
  label?: string | null;
  /** Tiers ou bénéficiaire en clair (autre entrée ou sortie). */
  party?: string | null;
  staffId?: string | null;
  salaryId?: string | null;
  customerId?: string | null;
  accountId?: string | null;
  /** Dans cette journée ouverte (« Encaisser », « Décaisser ») ; sinon au bureau. */
  sessionId?: string | null;
  /** Au bureau, par MoMo/OM : caisse électronique d'où part l'argent (la centrale par défaut). */
  registerId?: string | null;
  authorizedBy?: string | null;
}

/** Commun aux deux fenêtres : montant, mode, référence de la transaction, n° de pièce et motif. */
interface DeskBase {
  amount: Fcfa;
  method: string;
  reference?: string | null;
  piece?: string | null;
  label?: string | null;
}

/** « Encaisser » : client, fournisseur (avoir remboursé), personnel (avance remboursée) ou autre. */
export type CashInInput = DeskBase &
  (
    /** `advance` : dépôt d'avance, accepté même si le client ne doit rien. */
    | { type: 'customer'; customerId: string; advance?: boolean }
    | { type: 'supplier'; invoiceId: string }
    | { type: 'staff'; staffId: string }
    | { type: 'other'; accountId: string; party?: string | null }
  );

/** « Décaisser » : reversement, règlement fournisseur, charge, avance ou salaire, remboursement client, autre. */
export type CashOutInput = DeskBase &
  (
    | { type: 'transfer'; toRegisterId?: string | null }
    | { type: 'supplier'; invoiceId: string }
    | { type: 'expense'; categoryId: string; beneficiary?: string | null }
    | { type: 'staff_advance'; staffId: string }
    | { type: 'staff_salary'; salaryId: string }
    | { type: 'customer_refund'; customerId: string }
    | { type: 'other'; accountId: string; party?: string | null }
  );

/** Pièce créée par « Encaisser » ou « Décaisser » : de quoi la retrouver et l'imprimer. */
export interface DeskResult {
  source: CashJournalRow['source'];
  id: string;
}

/** Comptes qu'on ne choisit pas pour une autre entrée ou sortie : la trésorerie elle-même. */
const isTreasuryAccount = (id: string) => id.startsWith('5');

/**
 * « Encaisser » et « Décaisser » des Opérations de trésorerie,
 * et les pièces qu'ils créent quand ce n'est ni une vente, ni un règlement client
 * ou fournisseur, ni une dépense : avances et salaires du personnel, remboursement
 * d'un client, autre entrée ou sortie. Une sortie d'espèces ou de MoMo/OM compte
 * dans l'attendu de la journée de la caisse.
 */
export class CashDeskService extends Base {
  constructor(
    db: Db,
    clock: Clock,
    private readonly pos: PosService,
    private readonly customers: CustomerService,
    private readonly purchases: PurchaseService,
    private readonly expenses: ExpenseService,
    private readonly staff: StaffService,
    private readonly treasury: TreasuryService,
    private readonly vouchers: VoucherService,
  ) {
    super(db, clock);
  }

  // --- Bons d'achat -------------------------------------------------------------

  /**
   * Bon d'achat vendu à la caisse : l'argent entre dans la journée (espèces,
   * MoMo, carte…) comme une avance du client, et le bon numéroté est créé.
   */
  sellVoucher(ctx: Context, sessionId: string, input: { amount: Fcfa; method: string; reference?: string | null; holder?: string | null; customerId?: string | null; validityDays?: number | null }): GiftVoucher {
    const c = this.deskCtx(ctx, sessionId);
    if (!Number.isSafeInteger(input.amount) || input.amount < 500) throw new AppError("Un bon d'achat vaut au moins 500 FCFA", 'INVALID');
    if (input.amount > 10_000_000) throw new AppError('Montant du bon trop élevé', 'INVALID');
    if (!['CASH', 'MTN_MOMO', 'ORANGE_MONEY'].includes(input.method)) throw new AppError("Un bon d'achat se paie en espèces, MTN MoMo ou Orange Money", 'INVALID');
    return this.tx(() => {
      const code = this.vouchers.newCode();
      const entry = this.record(c, {
        direction: 'IN',
        kind: 'voucher_sale',
        amount: input.amount,
        method: input.method,
        reference: input.reference ?? null,
        label: `Bon d'achat ${code}${input.holder?.trim() ? ` pour ${input.holder.trim()}` : ''}`,
        customerId: null,
        // Espèces au tiroir ; MoMo ou Orange Money sur la caisse électronique du caissier.
        sessionId: this.pos.sessionFor(c, input.method, sessionId),
      });
      return this.vouchers.issue(c, { kind: 'sold', amount: input.amount, code, holder: input.holder, customerId: input.customerId ?? null, entryId: entry.id, validityDays: input.validityDays ?? null });
    });
  }

  /** Bon vendu par erreur, pas encore utilisé : il est annulé et son encaissement supprimé (journée encore ouverte). */
  cancelVoucher(ctx: Context, id: string, by: string, reason: string): GiftVoucher {
    const v = this.vouchers.get(id);
    if (v.store_id !== ctx.storeId) throw new AppError('Bon introuvable', 'NOT_FOUND');
    if (v.kind !== 'sold' || !v.entry_id) throw new AppError("Seul un bon vendu s'annule ; un bon d'avoir ou de monnaie reste valable jusqu'à sa date", 'INVALID');
    if (v.used > 0) throw new AppError('Ce bon a déjà servi : il ne peut plus être annulé', 'INVALID');
    if (!reason.trim()) throw new AppError("Indiquez le motif de l'annulation", 'INVALID');
    return this.tx(() => {
      this.cancel(ctx, v.entry_id!, by, `Bon ${v.code} annulé : ${reason.trim()}`);
      return this.vouchers.markCancelled(ctx, id, reason.trim());
    });
  }

  private get emoney() {
    return new EmoneyService(this.db, this.clock);
  }

  get(id: string): TreasuryEntry {
    const e = this.db
      .prepare(
        `SELECT e.*, s.name AS staff_name, c.name AS customer_name, a.label AS account_label, r.name AS register_name, u.name AS user_name, v.name AS authorized_by_name
         FROM treasury_entries e LEFT JOIN staff s ON s.id = e.staff_id LEFT JOIN customers c ON c.id = e.customer_id LEFT JOIN accounts a ON a.id = e.account_id
         LEFT JOIN registers r ON r.id = e.register_id LEFT JOIN users u ON u.id = e.user_id LEFT JOIN users v ON v.id = e.authorized_by WHERE e.id = ?`,
      )
      .get(id) as TreasuryEntry | undefined;
    if (!e) throw new AppError('Opération introuvable', 'NOT_FOUND');
    return e;
  }

  /** Avances, salaires et autres entrées ou sorties faites au bureau (hors caisse). */
  officeEntries(storeId: string, opts: { from?: string; to?: string; staffId?: string | null } = {}): TreasuryEntry[] {
    const ids = this.db
      .prepare(
        `SELECT id FROM treasury_entries WHERE store_id = @storeId AND (@staffId IS NULL OR staff_id = @staffId)
         AND (@from IS NULL OR date(at, 'localtime') >= @from) AND (@to IS NULL OR date(at, 'localtime') <= @to) ORDER BY at DESC`,
      )
      .pluck()
      .all({ storeId, staffId: opts.staffId ?? null, from: opts.from ?? null, to: opts.to ?? null }) as string[];
    return ids.map((id) => this.get(id));
  }

  /** Enregistre une avance, un salaire, un remboursement ou une autre entrée ou sortie. */
  record(ctx: Context, input: EntryInput): TreasuryEntry {
    const kind = input.kind;
    if (!(kind in ENTRY_KINDS)) throw new AppError('Nature inconnue', 'INVALID');
    const expected = ENTRY_DIRECTION[kind];
    if (expected && expected !== input.direction) throw new AppError(`Sens invalide pour : ${ENTRY_KINDS[kind]}`, 'INVALID');
    if (!Number.isSafeInteger(input.amount) || input.amount <= 0) throw new AppError('Montant invalide', 'INVALID');
    const method = input.method;
    if (!(method in PAYMENT_METHODS) || method === 'CUSTOMER_CREDIT' || method === 'VOUCHER') throw new AppError('Mode de paiement invalide', 'INVALID');
    const reference = input.reference?.trim() || null;
    if (method !== 'CASH' && !reference) throw new AppError('Indiquez la référence de la transaction', 'REFERENCE_REQUIRED');

    // Où passe l'argent : la journée ouverte, ou le bureau (caisse centrale, caisse électronique, banque).
    let registerId: string | null = null;
    let sessionId: string | null = null;
    let fromCentral = 0;
    if (input.sessionId) {
      ({ registerId, sessionId } = this.emoney.openSession(ctx.storeId, input.sessionId, method));
    } else if (method === 'CASH') {
      fromCentral = 1;
      if (input.direction === 'OUT') {
        const balance = this.treasury.balance(ctx.storeId);
        if (input.amount > balance) throw new AppError(`La caisse centrale n'a que ${balance} FCFA`, 'INSUFFICIENT');
      }
    } else if (isPayout(method)) {
      const src = this.emoney.source(ctx.storeId, method, input.registerId);
      if (!src.registerId) throw new AppError('Choisissez la caisse électronique (aucune centrale dans les paramètres)', 'INVALID');
      ({ registerId, sessionId } = src);
    } else if (method !== 'BANK_TRANSFER' && method !== 'CHEQUE') {
      throw new AppError('Au bureau, on paie en espèces, par MoMo/OM, virement ou chèque', 'INVALID');
    }

    let label = input.label?.trim() || '';
    let staffId: string | null = null;
    let salaryId: string | null = null;
    let customerId: string | null = null;
    let accountId: string | null = null;
    if (kind === 'staff_advance' || kind === 'staff_repayment' || kind === 'staff_salary') {
      const salary = kind === 'staff_salary' ? this.staff.getSalary(input.salaryId ?? '') : null;
      const s = this.staff.get(salary?.staff_id ?? input.staffId ?? '');
      if (s.store_id !== ctx.storeId) throw new AppError('Collaborateur introuvable', 'NOT_FOUND');
      staffId = s.id;
      if (kind === 'staff_advance') {
        if (!s.active) throw new AppError(`${s.name} ne fait plus partie du personnel`, 'INVALID');
        // Plafond des avances (paramètre du magasin) : au-delà, il faut le code d'un gérant.
        const maxPct = parseStoreSettings((this.db.prepare('SELECT settings FROM stores WHERE id = ?').pluck().get(ctx.storeId) as string | null) ?? null).advanceMaxPct;
        if (maxPct > 0 && s.base_salary > 0) {
          const ceiling = Math.floor((s.base_salary * maxPct) / 100);
          const after = Math.max(0, s.advances) + input.amount;
          const boss = input.authorizedBy ? (this.db.prepare("SELECT 1 FROM users WHERE id = ? AND role IN ('admin', 'manager')").get(input.authorizedBy) as unknown) : null;
          if (after > ceiling && !boss) {
            throw new AppError(`Avances de ${s.name} limitées à ${ceiling} FCFA (${maxPct} % du salaire) : il en doit déjà ${Math.max(0, s.advances)}. Code du gérant nécessaire`, 'SUPERVISOR_REQUIRED');
          }
        }
        label ||= `Avance à ${s.name}`;
      } else if (kind === 'staff_repayment') {
        if (input.amount > s.advances) throw new AppError(`${s.name} ne doit que ${Math.max(0, s.advances)} FCFA d'avances`, 'INVALID');
        label ||= `Remboursement d'avance de ${s.name}`;
      } else {
        if (!salary || salary.status !== 'active') throw new AppError('Choisissez le salaire à payer', 'INVALID');
        if (input.amount > salary.rest) throw new AppError(`Il ne reste que ${salary.rest} FCFA à payer sur ce salaire`, 'INVALID');
        salaryId = salary.id;
        label ||= `Salaire de ${periodLabel(salary.period)}, ${s.name}`;
      }
    } else if (kind === 'customer_refund') {
      const acc = this.customers.account(ctx.storeId, input.customerId ?? '');
      const credit = Math.max(0, -acc.balance);
      if (input.amount > credit) throw new AppError(credit ? `Le client n'a que ${credit} FCFA d'avance ou d'avoir` : "Ce client n'a ni avance ni avoir à rendre", 'INVALID');
      customerId = acc.customer.id;
      label ||= `Avance rendue à ${acc.customer.name}`;
    } else if (kind === 'container_deposit' || kind === 'container_refund') {
      // Consigne d'emballages : dette envers les clients (4194), pas une vente.
      if (method !== 'CASH') throw new AppError('La consigne se paie en espèces', 'INVALID');
      accountId = CONTAINER_ACCOUNT;
      label ||= ENTRY_KINDS[kind];
    } else if (kind === 'voucher_sale') {
      // Bon d'achat vendu : une avance du client (4191), pas encore une vente.
      accountId = (this.db.prepare("SELECT id FROM accounts WHERE role = 'voucher'").pluck().get() as string | undefined) ?? '4191';
      label ||= ENTRY_KINDS[kind];
    } else if (kind === 'agent_in' || kind === 'agent_out') {
      // Point Mobile Money : les espèces contre la flotte de l'agent (55xx) ou les frais (7072).
      if (method !== 'CASH') throw new AppError('Le point Mobile Money se paie en espèces', 'INVALID');
      const account = this.db.prepare('SELECT id FROM accounts WHERE id = ?').pluck().get(input.accountId ?? '') as string | undefined;
      if (!account) throw new AppError('Compte de la flotte introuvable', 'INVALID');
      accountId = account;
      if (!label) throw new AppError('Indiquez le motif', 'INVALID');
    } else {
      const account = this.db.prepare('SELECT id FROM accounts WHERE id = ? AND active = 1').pluck().get(input.accountId ?? '') as string | undefined;
      if (!account) throw new AppError('Choisissez le compte de cette opération', 'INVALID');
      if (isTreasuryAccount(account)) throw new AppError('Un mouvement entre caisses se fait par un reversement ou un virement', 'INVALID');
      accountId = account;
      if (!label) throw new AppError('Indiquez le motif', 'INVALID');
    }

    return this.tx(() => {
      const id = newId();
      const now = this.now();
      const prefix = input.direction === 'IN' ? 'EN' : 'DE';
      this.db
        .prepare(
          `INSERT INTO treasury_entries (id, number, store_id, direction, kind, amount, method, reference, piece, label, party, staff_id, salary_id, customer_id, account_id,
             register_id, session_id, from_central, status, authorized_by, printed, user_id, at, updated_at)
           VALUES (@id, @number, @store, @direction, @kind, @amount, @method, @reference, @piece, @label, @party, @staff, @salary, @customer, @account,
             @register, @session, @fromCentral, 'active', @authorizedBy, 0, @user, @now, @now)`,
        )
        .run({
          id,
          number: `${prefix}-${this.stationPrefix()}-${String(this.nextCounter(`treasury_entry.${prefix}`)).padStart(5, '0')}`,
          store: ctx.storeId,
          direction: input.direction,
          kind,
          amount: input.amount,
          method,
          reference,
          piece: input.piece?.trim() || null,
          label,
          party: input.party?.trim() || null,
          staff: staffId,
          salary: salaryId,
          customer: customerId,
          account: accountId,
          register: registerId,
          session: sessionId,
          fromCentral,
          authorizedBy: input.authorizedBy ?? null,
          user: ctx.userId,
          now,
        });
      this.enqueue(ctx, 'treasury_entry', id, 'upsert', {});
      this.audit(input.authorizedBy ?? ctx.userId, `treasury_entry.${input.direction.toLowerCase()}`, 'treasury_entry', id, { kind, amount: input.amount, method, by: ctx.userId });
      return this.get(id);
    });
  }

  // --- Encaisser, Décaisser ---------------------------------------------------------

  /** Journée ouverte où l'on encaisse ou décaisse, et le moyen par défaut de sa caisse. */
  desk(sessionId: string) {
    const se = this.pos.getSession(sessionId);
    const reg = this.db.prepare('SELECT id, name, kind, number FROM registers WHERE id = ?').get(se.register_id) as { id: string; name: string; kind: string; number: number };
    const methods = reg.kind === 'cash' ? ['CASH'] : reg.kind === 'electronic' ? ['MTN_MOMO', 'ORANGE_MONEY'] : [];
    const central = this.emoney.mode(se.store_id);
    return { session: se, register: reg, methods, open: se.status === 'open', emoneyCentralId: reg.kind === 'electronic' && central.centralId !== reg.id ? central.centralId : null };
  }

  private deskCtx(ctx: Context, sessionId: string): Context {
    const se = this.pos.getSession(sessionId);
    if (se.store_id !== ctx.storeId) throw new AppError('Journée de caisse introuvable', 'NOT_FOUND');
    if (se.status !== 'open') throw new AppError('Cette journée est clôturée : rien ne peut plus y entrer ni en sortir', 'SESSION_CLOSED');
    return { ...ctx, registerId: se.register_id };
  }

  cashIn(ctx: Context, sessionId: string, input: CashInInput): DeskResult {
    const c = this.deskCtx(ctx, sessionId);
    const piece = input.piece?.trim() || null;
    if (input.type === 'customer') {
      const p = this.customers.receivePayment(c, {
        customerId: input.customerId,
        method: input.method as CustomerPaymentMethod,
        amount: input.amount,
        reference: input.reference ?? (input.method === 'CASH' ? piece : null),
        notes: [piece && input.method !== 'CASH' ? `Pièce ${piece}` : null, input.label?.trim() || null].filter(Boolean).join(' · ') || null,
        sessionId: this.emoney.openSession(c.storeId, sessionId, input.method).sessionId,
        advance: input.advance,
      });
      return { source: 'customer_payment', id: p.id };
    }
    if (input.type === 'supplier') {
      const inv = this.purchases.getInvoice(input.invoiceId);
      if (inv.kind !== 'credit_note') throw new AppError('Choisissez un avoir du fournisseur : une facture se règle par « Décaisser »', 'INVALID');
      return this.supplierPayment(c, sessionId, input.invoiceId, input);
    }
    const e =
      input.type === 'staff'
        ? this.record(c, { ...input, direction: 'IN', kind: 'staff_repayment', staffId: input.staffId, sessionId })
        : this.record(c, { ...input, direction: 'IN', kind: 'other', accountId: input.accountId, party: input.party, sessionId });
    return { source: 'entry', id: e.id };
  }

  cashOut(ctx: Context, sessionId: string, input: CashOutInput, authorizedBy: string | null): DeskResult {
    const c = this.deskCtx(ctx, sessionId);
    const desk = this.desk(sessionId);
    const label = input.label?.trim() || null;
    switch (input.type) {
      case 'transfer': {
        if (desk.register.kind === 'cash') {
          if (input.method !== 'CASH') throw new AppError('Une caisse espèces reverse des espèces', 'INVALID');
          const id = this.pos.cashOperation(c, 'OUT', input.amount, label ?? 'Reversement à la caisse centrale');
          return { source: 'cash_operation', id };
        }
        const to = input.toRegisterId || desk.emoneyCentralId;
        if (!to) throw new AppError('Choisissez la caisse électronique qui reçoit', 'INVALID');
        const m = this.emoney.record(c, {
          registerId: desk.register.id,
          direction: 'OUT',
          nature: 'register',
          method: input.method,
          amount: input.amount,
          reference: input.reference,
          label: label ?? 'Reversement',
          toRegisterId: to,
        });
        return { source: 'movement', id: m.id };
      }
      case 'supplier': {
        const inv = this.purchases.getInvoice(input.invoiceId);
        if (inv.kind !== 'invoice') throw new AppError('Choisissez une facture du fournisseur : un avoir remboursé se saisit par « Encaisser »', 'INVALID');
        return this.supplierPayment(c, sessionId, input.invoiceId, input);
      }
      case 'expense': {
        const e = this.expenses.record(c, {
          categoryId: input.categoryId,
          label: label ?? '',
          beneficiary: input.beneficiary ?? null,
          amount: input.amount,
          method: input.method as 'CASH',
          reference: input.reference ?? input.piece ?? null,
          sessionId,
          atRegister: true,
          authorizedBy,
        });
        return { source: 'expense', id: e.id };
      }
      case 'staff_advance':
        return { source: 'entry', id: this.record(c, { ...input, direction: 'OUT', kind: 'staff_advance', staffId: input.staffId, sessionId, authorizedBy }).id };
      case 'staff_salary':
        return { source: 'entry', id: this.record(c, { ...input, direction: 'OUT', kind: 'staff_salary', salaryId: input.salaryId, sessionId, authorizedBy }).id };
      case 'customer_refund':
        return { source: 'entry', id: this.record(c, { ...input, direction: 'OUT', kind: 'customer_refund', customerId: input.customerId, sessionId, authorizedBy }).id };
      case 'other':
        return { source: 'entry', id: this.record(c, { ...input, direction: 'OUT', kind: 'other', accountId: input.accountId, party: input.party, sessionId, authorizedBy }).id };
      default:
        throw new AppError('Type de sortie inconnu', 'INVALID');
    }
  }

  private supplierPayment(c: Context, sessionId: string, invoiceId: string, input: DeskBase): DeskResult {
    const before = new Set(this.db.prepare('SELECT id FROM supplier_payments WHERE invoice_id = ?').pluck().all(invoiceId) as string[]);
    this.purchases.paySupplier(c, {
      invoiceId,
      method: input.method as SupplierPaymentMethod,
      amount: input.amount,
      reference: input.reference?.trim() || input.piece?.trim() || null,
      sessionId,
    });
    const id = (this.db.prepare('SELECT id FROM supplier_payments WHERE invoice_id = ? ORDER BY paid_at DESC').pluck().all(invoiceId) as string[]).find((x) => !before.has(x))!;
    return { source: 'supplier_payment', id };
  }

  // --- Actions sur une ligne de la journée -------------------------------------------

  /** Ligne d'une journée (entrée ou sortie), comme l'écran l'affiche : pour l'imprimer ou la décharge. */
  row(sessionId: string, source: string, id: string): { row: CashJournalRow; direction: 'IN' | 'OUT'; register: string } {
    const desk = this.desk(sessionId);
    const journal = this.pos.journal(sessionId);
    for (const direction of ['IN', 'OUT'] as const) {
      const row = (direction === 'IN' ? journal.entries : journal.exits).find((r) => r.source === source && r.id === id);
      if (row) return { row, direction, register: desk.register.name };
    }
    throw new AppError("Cette opération n'est pas dans la journée", 'NOT_FOUND');
  }

  /** Une pièce comme une ligne de journée, pour l'imprimer même faite au bureau. */
  entryRow(id: string): { row: CashJournalRow; direction: 'IN' | 'OUT'; register: string } {
    const e = this.get(id);
    return {
      direction: e.direction,
      register: e.from_central ? 'Caisse centrale' : (e.register_name ?? (e.method === 'BANK_TRANSFER' || e.method === 'CHEQUE' ? 'Banque' : 'Bureau')),
      row: {
        source: 'entry',
        id: e.id,
        number: e.number,
        kind: e.kind,
        method_label: PAYMENT_METHODS[e.method as 'CASH'] ?? e.method,
        reference: e.reference ?? e.piece,
        at: e.at,
        amount: e.amount,
        nature: ENTRY_KINDS[e.kind],
        label: e.label,
        party: e.staff_name ?? e.customer_name ?? e.party,
        user_name: e.user_name,
        user_id: e.user_id,
      },
    };
  }

  /** Pièce d'« Encaisser » ou « Décaisser » d'une journée encore ouverte. */
  private editable(id: string): TreasuryEntry {
    const e = this.get(id);
    if (e.status !== 'active') throw new AppError('Cette opération est déjà supprimée', 'INVALID');
    if (e.session_id) {
      const status = this.db.prepare('SELECT status FROM cash_sessions WHERE id = ?').pluck().get(e.session_id);
      if (status !== 'open') throw new AppError('La journée de cette opération est clôturée : elle ne se modifie plus', 'SESSION_CLOSED');
    } else if (e.register_id) {
      this.emoney.assertNotCarried(e.register_id, null, e.at);
    }
    return e;
  }

  /**
   * Corrige une entrée ou sortie de la journée ouverte : motif, tiers, référence
   * et, pour une autre entrée ou sortie, une avance, un salaire ou un avoir
   * remboursé, le montant (dans la limite de ce que la personne doit ou a).
   */
  update(ctx: Context, id: string, by: string, patch: { amount?: Fcfa; label?: string; party?: string | null; reference?: string | null; piece?: string | null }): TreasuryEntry {
    const e = this.editable(id);
    const amount = patch.amount ?? e.amount;
    if (!Number.isSafeInteger(amount) || amount <= 0) throw new AppError('Montant invalide', 'INVALID');
    if (amount !== e.amount) {
      const delta = amount - e.amount;
      switch (e.kind) {
        case 'other':
          break;
        case 'staff_advance':
          if (this.staff.balance(e.staff_id!).advances + delta < 0) throw new AppError("Cette avance est déjà retenue ou remboursée en partie : le montant ne peut pas descendre si bas", 'INVALID');
          break;
        case 'staff_repayment': {
          const left = this.staff.balance(e.staff_id!).advances;
          if (delta > left) throw new AppError(`Il ne doit plus que ${Math.max(0, left)} FCFA d'avances`, 'INVALID');
          break;
        }
        case 'staff_salary': {
          const rest = this.staff.getSalary(e.salary_id!).rest;
          if (delta > rest) throw new AppError(`Il ne reste que ${rest} FCFA à payer sur ce salaire`, 'INVALID');
          break;
        }
        case 'customer_refund': {
          const credit = Math.max(0, -this.customers.account(e.store_id, e.customer_id!).balance);
          if (delta > credit) throw new AppError(`Le client n'a plus que ${credit} FCFA d'avoir`, 'INVALID');
          break;
        }
        default:
          throw new AppError('Le montant de cette opération ne se modifie pas : supprimez-la et refaites-la', 'INVALID');
      }
    }
    const label = patch.label === undefined ? e.label : patch.label.trim();
    if (!label) throw new AppError('Indiquez le motif', 'INVALID');
    const reference = patch.reference === undefined ? e.reference : patch.reference?.trim() || null;
    if (e.method !== 'CASH' && !reference) throw new AppError('Indiquez la référence de la transaction', 'REFERENCE_REQUIRED');
    const party = e.kind === 'other' && patch.party !== undefined ? patch.party?.trim() || null : e.party;
    const piece = patch.piece === undefined ? e.piece : patch.piece?.trim() || null;
    this.tx(() => {
      this.db.prepare('UPDATE treasury_entries SET amount = ?, label = ?, party = ?, reference = ?, piece = ?, updated_at = ? WHERE id = ?').run(amount, label, party, reference, piece, this.now(), id);
      this.enqueue(ctx, 'treasury_entry', id, 'upsert', {});
      this.audit(by, 'treasury_entry.update', 'treasury_entry', id, {
        number: e.number,
        from: { amount: e.amount, label: e.label, party: e.party, reference: e.reference, piece: e.piece },
        to: { amount, label, party, reference, piece },
        by: ctx.userId,
      });
    });
    return this.get(id);
  }

  /** Supprime une entrée ou sortie saisie par erreur : elle reste dans l'historique, barrée. */
  cancel(ctx: Context, id: string, by: string, reason: string): TreasuryEntry {
    const e = this.editable(id);
    if (!reason.trim()) throw new AppError('Indiquez le motif de la suppression', 'INVALID');
    if (e.kind === 'staff_advance') {
      // Une avance déjà retenue sur un salaire ne peut plus disparaître.
      const left = this.staff.balance(e.staff_id!).advances;
      if (left < e.amount) throw new AppError("Cette avance est déjà retenue ou remboursée : supprimez d'abord la retenue ou le remboursement", 'INVALID');
    }
    this.tx(() => {
      this.db.prepare("UPDATE treasury_entries SET status = 'cancelled', cancel_reason = ?, cancelled_by = ?, updated_at = ? WHERE id = ?").run(reason.trim(), by, this.now(), id);
      this.enqueue(ctx, 'treasury_entry', id, 'upsert', {});
      this.audit(by, 'treasury_entry.cancel', 'treasury_entry', id, { number: e.number, amount: e.amount, reason, by: ctx.userId });
    });
    return this.get(id);
  }

  /**
   * Antidate une entrée ou sortie de la journée ouverte (oubli de saisie) : la
   * nouvelle heure reste entre l'ouverture de la journée et maintenant.
   */
  backdate(ctx: Context, source: 'entry' | 'expense', id: string, at: string): void {
    const when = new Date(at);
    if (Number.isNaN(when.getTime())) throw new AppError('Date invalide', 'INVALID');
    const iso = when.toISOString();
    const current =
      source === 'entry'
        ? (() => {
            const e = this.editable(id);
            return { session: e.session_id, at: e.at, number: e.number };
          })()
        : (() => {
            const e = this.expenses.get(id);
            if (e.status !== 'active') throw new AppError('Cette dépense est annulée', 'INVALID');
            return { session: e.session_id, at: e.created_at, number: e.number };
          })();
    if (!current.session) throw new AppError('Seule une opération faite dans une caisse ouverte peut être antidatée', 'INVALID');
    const se = this.pos.getSession(current.session);
    if (se.status !== 'open') throw new AppError('La journée est clôturée', 'SESSION_CLOSED');
    if (iso < se.opened_at) throw new AppError(`La journée a été ouverte le ${new Date(se.opened_at).toLocaleString('fr-FR')} : choisissez une heure après`, 'INVALID');
    if (iso > this.now()) throw new AppError('Une opération ne peut pas être datée dans le futur', 'INVALID');
    this.assertPeriodOpen(ctx.storeId, iso);
    this.tx(() => {
      if (source === 'entry') {
        this.db.prepare('UPDATE treasury_entries SET at = ?, updated_at = ? WHERE id = ?').run(iso, this.now(), id);
        this.enqueue(ctx, 'treasury_entry', id, 'upsert', {});
      } else {
        const pad = (n: number) => String(n).padStart(2, '0');
        const day = `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}`;
        this.db.prepare('UPDATE expenses SET created_at = ?, expense_date = ?, updated_at = ? WHERE id = ?').run(iso, day, this.now(), id);
        this.enqueue(ctx, 'expense', id, 'upsert', {});
      }
      this.audit(ctx.userId, `${source}.backdate`, source === 'entry' ? 'treasury_entry' : 'expense', id, { number: current.number, from: current.at, to: iso });
    });
  }

  /** Le reçu vient d'être imprimé : la prochaine impression portera « DUPLICATA ». Renvoie le nombre d'impressions d'avant. */
  markPrinted(id: string): number {
    const before = this.get(id).printed;
    this.db.prepare('UPDATE treasury_entries SET printed = printed + 1, updated_at = ? WHERE id = ?').run(this.now(), id);
    return before;
  }

  /** Annule l'impression du reçu (papier coincé, mauvaise imprimante) : il se réimprime comme un original. */
  unprint(ctx: Context, id: string): void {
    const e = this.get(id);
    this.tx(() => {
      this.db.prepare('UPDATE treasury_entries SET printed = 0, updated_at = ? WHERE id = ?').run(this.now(), id);
      this.enqueue(ctx, 'treasury_entry', id, 'upsert', {});
      this.audit(ctx.userId, 'treasury_entry.unprint', 'treasury_entry', id, { number: e.number });
    });
  }

  /**
   * Une « autre sortie » était en fait un règlement fournisseur ou un avoir
   * remboursé à un client : elle est supprimée et remplacée par la bonne pièce,
   * même montant, même caisse.
   */
  convert(ctx: Context, id: string, target: { type: 'supplier'; invoiceId: string } | { type: 'customer'; customerId: string }, by: string): DeskResult {
    const e = this.editable(id);
    if (e.kind !== 'other' || e.direction !== 'OUT') throw new AppError('Seule une « autre sortie » se convertit', 'INVALID');
    return this.tx(() => {
      this.cancel(ctx, id, by, target.type === 'supplier' ? 'Convertie en règlement fournisseur' : 'Convertie en remboursement client');
      const base = { amount: e.amount, method: e.method, reference: e.reference, piece: e.piece, label: e.label };
      if (e.session_id) {
        return target.type === 'supplier'
          ? this.cashOut(ctx, e.session_id, { ...base, type: 'supplier', invoiceId: target.invoiceId }, by)
          : this.cashOut(ctx, e.session_id, { ...base, type: 'customer_refund', customerId: target.customerId }, by);
      }
      if (target.type === 'supplier') {
        const before = new Set(this.db.prepare('SELECT id FROM supplier_payments WHERE invoice_id = ?').pluck().all(target.invoiceId) as string[]);
        this.purchases.paySupplier(ctx, { invoiceId: target.invoiceId, method: e.method as SupplierPaymentMethod, amount: e.amount, reference: e.reference, registerId: e.register_id });
        const pid = (this.db.prepare('SELECT id FROM supplier_payments WHERE invoice_id = ?').pluck().all(target.invoiceId) as string[]).find((x) => !before.has(x))!;
        return { source: 'supplier_payment' as const, id: pid };
      }
      const r = this.record(ctx, { direction: 'OUT', kind: 'customer_refund', customerId: target.customerId, amount: e.amount, method: e.method, reference: e.reference, piece: e.piece, registerId: e.register_id, authorizedBy: by });
      return { source: 'entry' as const, id: r.id };
    });
  }
}
