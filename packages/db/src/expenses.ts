import type { Fcfa } from '@superette/core';
import type { AdminService } from './admin';
import { ChargeService } from './charges';
import type { Db } from './database';
import { EmoneyService, isPayout } from './emoney';
import { AppError, Base, type Clock, type Context, newId } from './util';

export const EXPENSE_PAYMENT_METHODS = {
  CASH: 'Espèces',
  MTN_MOMO: 'MTN MoMo',
  ORANGE_MONEY: 'Orange Money',
  BANK_TRANSFER: 'Virement',
  CHEQUE: 'Chèque',
  CARD: 'Carte',
} as const;
export type ExpensePaymentMethod = keyof typeof EXPENSE_PAYMENT_METHODS;

export interface ExpenseCategory {
  id: string;
  name: string;
  account_id: string;
  account_label: string | null;
  active: number;
}

export interface Expense {
  id: string;
  number: string;
  store_id: string;
  category_id: string;
  category_name: string;
  account_id: string;
  expense_date: string;
  label: string;
  beneficiary: string | null;
  amount: Fcfa;
  vat: Fcfa;
  method: ExpensePaymentMethod;
  reference: string | null;
  register_id: string | null;
  register_name: string | null;
  session_id: string | null;
  user_name: string | null;
  authorized_by_name: string | null;
  status: 'active' | 'cancelled';
  cancel_reason: string | null;
  cancelled_by_name: string | null;
  created_at: string;
  plan_id: string | null;
  plan_period: string | null;
  /** À approuver par le gérant (au-delà du montant des paramètres), approuvée ou refusée. */
  approval: ExpenseApproval;
  approved_by_name: string | null;
  approved_at: string | null;
  approval_note: string | null;
  /** Justificatifs joints (photo de la facture, PDF, fiche signée). */
  attachments: number;
}

export type ExpenseApproval = 'pending' | 'approved' | 'rejected';

export const EXPENSE_APPROVALS: Record<ExpenseApproval, string> = {
  pending: 'À approuver',
  approved: 'Approuvée',
  rejected: 'Refusée',
};

/** Justificatif d'une dépense, sans son contenu (liste). */
export interface ExpenseAttachment {
  id: string;
  expense_id: string;
  name: string;
  mime: string;
  size: number;
  user_name: string | null;
  created_at: string;
}

/** Types de fichiers acceptés en justificatif, et taille maximale (le fichier voyage vers les autres PC). */
export const ATTACHMENT_TYPES: Record<string, string> = {
  'image/jpeg': 'Photo (JPEG)',
  'image/png': 'Image (PNG)',
  'image/webp': 'Image (WebP)',
  'application/pdf': 'PDF',
};
export const ATTACHMENT_MAX_BYTES = 3 * 1024 * 1024;

export interface ExpenseInput {
  categoryId: string;
  /** AAAA-MM-JJ ; aujourd'hui par défaut (toujours aujourd'hui pour une sortie de caisse). */
  date?: string | null;
  label: string;
  beneficiary?: string | null;
  /** Montant payé, TTC. */
  amount: Fcfa;
  /** TVA récupérable figurant sur la facture (0 si pas de facture avec TVA). */
  vat?: Fcfa;
  method: ExpensePaymentMethod;
  reference?: string | null;
  /** Payée à la caisse ouverte (espèces du tiroir, ou compte MoMo/OM du caissier) : elle sort du Z. */
  atRegister?: boolean;
  /** Payée par MoMo/OM au bureau : caisse électronique d'où elle sort (la centrale par défaut). */
  registerId?: string | null;
  /** Payée dans cette journée ouverte (« Décaisser » de l'écran de trésorerie) : espèces du tiroir ou compte MoMo/OM de la caisse. */
  sessionId?: string | null;
  /** Gérant qui a autorisé une sortie de caisse faite par un caissier. */
  authorizedBy?: string | null;
  /** Échéance de charge fixe que la dépense constate (charge et mois AAAA-MM). */
  planId?: string | null;
  planPeriod?: string | null;
}

/**
 * Dépenses courantes (loyer, ENEO, salaires, transport…). Chacune passe en
 * comptabilité sur le compte de sa catégorie ; payée au tiroir, elle diminue
 * les espèces attendues au Z.
 */
export class ExpenseService extends Base {
  constructor(
    db: Db,
    clock: Clock,
    private readonly admin?: AdminService,
  ) {
    super(db, clock);
  }

  /**
   * Une dépense saisie par quelqu'un qui n'a pas le droit d'approuver, au-delà du
   * montant réglé dans les paramètres, attend l'accord du gérant. Un gérant qui
   * a donné son code pour une sortie de caisse l'a déjà approuvée.
   */
  private approvalFor(ctx: Context, amount: Fcfa, authorizedBy: string | null | undefined): ExpenseApproval {
    if (!this.admin) return 'approved';
    const above = this.admin.storeSettings(ctx.storeId).expenseApprovalAbove;
    if (above <= 0 || amount <= above) return 'approved';
    const may = (id: string) => this.admin!.hasRight(this.admin!.getUser(id), 'expense_approve');
    return may(ctx.userId) || (authorizedBy && may(authorizedBy)) ? 'approved' : 'pending';
  }

  // --- Catégories ---------------------------------------------------------------

  listCategories(includeInactive = false): ExpenseCategory[] {
    return this.db
      .prepare(
        `SELECT c.id, c.name, c.account_id, a.label AS account_label, c.active FROM expense_categories c
         LEFT JOIN accounts a ON a.id = c.account_id WHERE (? = 1 OR c.active = 1) ORDER BY c.name`,
      )
      .all(includeInactive ? 1 : 0) as ExpenseCategory[];
  }

  saveCategory(userId: string, input: { id?: string | null; name: string; accountId: string; active?: boolean }): ExpenseCategory {
    const name = input.name.trim();
    if (!name) throw new AppError('Le nom de la catégorie est obligatoire', 'INVALID');
    const account = this.db.prepare('SELECT id FROM accounts WHERE id = ?').pluck().get(input.accountId) as string | undefined;
    if (!account) throw new AppError(`Compte inconnu : ${input.accountId}`, 'INVALID');
    if (!account.startsWith('6')) throw new AppError('Une dépense passe sur un compte de charges (classe 6)', 'INVALID');
    const id = input.id ?? newId();
    this.tx(() => {
      this.db
        .prepare(
          `INSERT INTO expense_categories (id, name, account_id, active, updated_at) VALUES (@id, @name, @account, @active, @now)
           ON CONFLICT(id) DO UPDATE SET name = @name, account_id = @account, active = @active, updated_at = @now`,
        )
        .run({ id, name, account, active: input.active === false ? 0 : 1, now: this.now() });
      this.enqueue(null, 'expense_category', id, 'upsert', {});
      this.audit(userId, 'expense.category', 'expense_category', id, { name, account });
    });
    return this.listCategories(true).find((c) => c.id === id)!;
  }

  // --- Dépenses -----------------------------------------------------------------

  record(ctx: Context, input: ExpenseInput): Expense {
    if (!(input.method in EXPENSE_PAYMENT_METHODS)) throw new AppError(`Mode de paiement inconnu : ${input.method}`, 'INVALID');
    if (!Number.isSafeInteger(input.amount) || input.amount <= 0) throw new AppError('Montant invalide', 'INVALID');
    // Magasin non assujetti : la TVA payée n'est pas récupérable, elle reste dans la charge.
    const vatEnabled = (this.db.prepare('SELECT vat_enabled FROM stores WHERE id = ?').pluck().get(ctx.storeId) as number | undefined) !== 0;
    const vat = vatEnabled ? (input.vat ?? 0) : 0;
    if (!Number.isSafeInteger(vat) || vat < 0 || vat >= input.amount) throw new AppError('La TVA doit être inférieure au montant payé', 'INVALID');
    if (!input.label.trim()) throw new AppError("Indiquez l'objet de la dépense", 'INVALID');
    if (input.method !== 'CASH' && !input.reference?.trim()) {
      throw new AppError(`Référence obligatoire pour un paiement par ${EXPENSE_PAYMENT_METHODS[input.method]}`, 'REFERENCE_REQUIRED');
    }
    const category = this.db.prepare('SELECT id, account_id, active FROM expense_categories WHERE id = ?').get(input.categoryId) as
      | { id: string; account_id: string; active: number }
      | undefined;
    if (!category || !category.active) throw new AppError('Choisissez la catégorie de la dépense', 'INVALID');
    if (input.planId) {
      if (!input.planPeriod) throw new AppError("Indiquez le mois de l'échéance", 'INVALID');
      new ChargeService(this.db, this.clock).assertOpen(ctx.storeId, input.planId, input.planPeriod);
    }
    let sessionId: string | null = null;
    let registerId: string | null = null;
    let date = input.date || this.today();
    this.assertPeriodOpen(ctx.storeId, date);
    const emoney = new EmoneyService(this.db, this.clock);
    if (input.sessionId) {
      ({ registerId, sessionId } = emoney.openSession(ctx.storeId, input.sessionId, input.method));
      date = this.today();
    } else if (input.atRegister) {
      if (isPayout(input.method)) {
        // Payée avec le compte MoMo/OM du caissier : elle sort de sa caisse électronique.
        const own = emoney.userRegister(ctx.userId, input.method);
        if (!own.registerId && !own.any) throw new AppError("Vous n'avez pas de caisse électronique : payez en espèces", 'INVALID');
        if (!own.registerId) throw new AppError(`Aucune de vos caisses électroniques ne reçoit ${EXPENSE_PAYMENT_METHODS[input.method as keyof typeof EXPENSE_PAYMENT_METHODS] ?? input.method} : payez en espèces`, 'INVALID');
        if (!own.sessionId) throw new AppError("Ouvrez la caisse avant d'y prendre de l'argent", 'NO_SESSION');
        registerId = own.registerId;
        sessionId = own.sessionId;
      } else {
        if (input.method !== 'CASH') throw new AppError('Une sortie de caisse se paie en espèces ou avec votre compte MoMo/OM', 'INVALID');
        if (!ctx.registerId) throw new AppError("Ce poste n'a pas de caisse", 'NO_REGISTER');
        sessionId = this.db.prepare("SELECT id FROM cash_sessions WHERE register_id = ? AND status = 'open'").pluck().get(ctx.registerId) as string | null;
        if (!sessionId) throw new AppError("Ouvrez la caisse avant d'y prendre de l'argent", 'NO_SESSION');
        registerId = ctx.registerId;
      }
      date = this.today();
    } else {
      // Au bureau : MoMo/OM sort de la caisse électronique choisie, sinon de la centrale.
      const src = emoney.source(ctx.storeId, input.method, input.registerId);
      registerId = src.registerId;
      sessionId = src.sessionId;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new AppError('Date invalide', 'INVALID');
    if (date > this.today()) throw new AppError('La date de la dépense ne peut pas être dans le futur', 'INVALID');
    const approval = this.approvalFor(ctx, input.amount, input.authorizedBy);
    return this.tx(() => {
      const id = newId();
      const now = this.now();
      this.db
        .prepare(
          `INSERT INTO expenses (id, number, store_id, category_id, account_id, expense_date, label, beneficiary, amount, vat, method, reference,
             register_id, session_id, user_id, authorized_by, status, plan_id, plan_period, from_central, approval, created_at, updated_at)
           VALUES (@id, @number, @store, @category, @account, @date, @label, @beneficiary, @amount, @vat, @method, @reference,
             @register, @session, @user, @authorizedBy, 'active', @planId, @planPeriod, @fromCentral, @approval, @now, @now)`,
        )
        .run({
          id,
          number: `DEP-${this.stationPrefix()}-${String(this.nextCounter('expense')).padStart(5, '0')}`,
          store: ctx.storeId,
          category: category.id,
          account: category.account_id,
          date,
          label: input.label.trim(),
          beneficiary: input.beneficiary?.trim() || null,
          amount: input.amount,
          vat,
          method: input.method,
          reference: input.reference?.trim() || null,
          register: registerId,
          session: sessionId,
          user: ctx.userId,
          authorizedBy: input.authorizedBy ?? null,
          planId: input.planId || null,
          planPeriod: input.planId ? input.planPeriod : null,
          // Espèces payées au bureau : elles sortent de la caisse centrale.
          fromCentral: input.method === 'CASH' && !sessionId ? 1 : 0,
          approval,
          now,
        });
      this.enqueue(ctx, 'expense', id, 'upsert', {});
      this.audit(input.authorizedBy ?? ctx.userId, 'expense.record', 'expense', id, { amount: input.amount, method: input.method, atRegister: !!sessionId, by: ctx.userId, approval });
      return this.get(id);
    });
  }

  /**
   * Corrige une dépense (objet, bénéficiaire, montant, référence) tant que sa
   * journée de caisse est ouverte ; une dépense faite au bureau se corrige tant
   * que sa période comptable est ouverte.
   */
  update(ctx: Context, id: string, by: string, patch: { amount?: Fcfa; label?: string; beneficiary?: string | null; reference?: string | null }): Expense {
    const e = this.get(id);
    if (e.status === 'cancelled') throw new AppError('Cette dépense est annulée', 'INVALID');
    if (e.session_id) {
      const status = this.db.prepare('SELECT status FROM cash_sessions WHERE id = ?').pluck().get(e.session_id);
      if (status !== 'open') throw new AppError('La journée de cette dépense est clôturée : elle ne se modifie plus', 'SESSION_CLOSED');
    }
    if (e.method !== 'CASH') new EmoneyService(this.db, this.clock).assertNotCarried(e.register_id, e.session_id, e.created_at);
    this.assertPeriodOpen(ctx.storeId, e.expense_date);
    const amount = patch.amount ?? e.amount;
    if (!Number.isSafeInteger(amount) || amount <= 0) throw new AppError('Montant invalide', 'INVALID');
    if (e.vat >= amount) throw new AppError('Le montant doit rester supérieur à la TVA de la dépense', 'INVALID');
    const label = patch.label === undefined ? e.label : patch.label.trim();
    if (!label) throw new AppError("Indiquez l'objet de la dépense", 'INVALID');
    const reference = patch.reference === undefined ? e.reference : patch.reference?.trim() || null;
    if (e.method !== 'CASH' && !reference) throw new AppError('Référence obligatoire pour ce mode de paiement', 'REFERENCE_REQUIRED');
    const beneficiary = patch.beneficiary === undefined ? e.beneficiary : patch.beneficiary?.trim() || null;
    this.tx(() => {
      this.db.prepare('UPDATE expenses SET amount = ?, label = ?, beneficiary = ?, reference = ?, updated_at = ? WHERE id = ?').run(amount, label, beneficiary, reference, this.now(), id);
      this.enqueue(ctx, 'expense', id, 'upsert', {});
      this.audit(by, 'expense.update', 'expense', id, { number: e.number, from: { amount: e.amount, label: e.label, beneficiary: e.beneficiary, reference: e.reference }, to: { amount, label, beneficiary, reference }, by: ctx.userId });
    });
    return this.get(id);
  }

  /** Annulation (erreur de saisie). Une sortie de caisse ne s'annule plus une fois le Z clôturé. */
  cancel(ctx: Context, id: string, supervisorId: string, reason: string): Expense {
    const e = this.get(id);
    if (e.status === 'cancelled') throw new AppError('Cette dépense est déjà annulée', 'INVALID');
    if (!reason.trim()) throw new AppError("Le motif de l'annulation est obligatoire", 'INVALID');
    if (e.session_id) {
      const status = this.db.prepare('SELECT status FROM cash_sessions WHERE id = ?').pluck().get(e.session_id);
      if (status !== 'open') throw new AppError("Le Z de cette caisse est clôturé : la sortie de caisse ne peut plus être annulée", 'SESSION_CLOSED');
    }
    if (e.method !== 'CASH') new EmoneyService(this.db, this.clock).assertNotCarried(e.register_id, e.session_id, e.created_at);
    this.tx(() => {
      this.db
        .prepare("UPDATE expenses SET status = 'cancelled', cancel_reason = ?, cancelled_by = ?, updated_at = ? WHERE id = ?")
        .run(reason.trim(), supervisorId, this.now(), id);
      this.enqueue(ctx, 'expense', id, 'upsert', {});
      this.audit(supervisorId, 'expense.cancel', 'expense', id, { number: e.number, amount: e.amount, reason, by: ctx.userId });
    });
    return this.get(id);
  }

  get(id: string): Expense {
    const row = this.query('e.id = @id').get({ id }) as Expense | undefined;
    if (!row) throw new AppError('Dépense introuvable', 'NOT_FOUND');
    return row;
  }

  list(
    storeId: string,
    opts: { from?: string; to?: string; categoryId?: string; sessionId?: string; includeCancelled?: boolean; approval?: ExpenseApproval; limit?: number } = {},
  ): Expense[] {
    return this.query(
      `e.store_id = @storeId AND (@from IS NULL OR e.expense_date >= @from) AND (@to IS NULL OR e.expense_date <= @to)
       AND (@category IS NULL OR e.category_id = @category) AND (@session IS NULL OR e.session_id = @session)
       AND (@cancelled = 1 OR e.status = 'active') AND (@approval IS NULL OR e.approval = @approval)`,
      opts.limit ?? 1000,
    ).all({
      storeId,
      from: opts.from ?? null,
      to: opts.to ?? null,
      category: opts.categoryId ?? null,
      session: opts.sessionId ?? null,
      cancelled: opts.includeCancelled ? 1 : 0,
      approval: opts.approval ?? null,
    }) as Expense[];
  }

  // --- Approbation --------------------------------------------------------------

  /** Le gérant approuve une dépense en attente ; avec le réglage, seulement si son justificatif est joint. */
  approve(ctx: Context, id: string, note?: string | null): Expense {
    const e = this.get(id);
    if (e.status === 'cancelled') throw new AppError('Cette dépense est annulée', 'INVALID');
    if (e.approval === 'approved') throw new AppError('Cette dépense est déjà approuvée', 'INVALID');
    if (this.admin?.storeSettings(ctx.storeId).expenseProofRequired && e.attachments === 0) {
      throw new AppError('Joignez le justificatif (photo de la facture, fiche signée) avant d’approuver cette dépense', 'PROOF_REQUIRED');
    }
    return this.decide(ctx, e, 'approved', note?.trim() || null);
  }

  /**
   * Le gérant refuse une dépense : elle reste enregistrée (l'argent est sorti)
   * et signalée ; il la corrige ou l'annule ensuite, ou demande des comptes.
   */
  reject(ctx: Context, id: string, note: string): Expense {
    const e = this.get(id);
    if (e.status === 'cancelled') throw new AppError('Cette dépense est annulée', 'INVALID');
    if (!note?.trim()) throw new AppError('Indiquez pourquoi la dépense est refusée', 'INVALID');
    if (e.approval === 'rejected') throw new AppError('Cette dépense est déjà refusée', 'INVALID');
    return this.decide(ctx, e, 'rejected', note.trim());
  }

  private decide(ctx: Context, e: Expense, approval: ExpenseApproval, note: string | null): Expense {
    this.tx(() => {
      this.db
        .prepare('UPDATE expenses SET approval = ?, approved_by = ?, approved_at = ?, approval_note = ?, updated_at = ? WHERE id = ?')
        .run(approval, ctx.userId, this.now(), note, this.now(), e.id);
      this.enqueue(ctx, 'expense', e.id, 'upsert', {});
      this.audit(ctx.userId, `expense.${approval === 'approved' ? 'approve' : 'reject'}`, 'expense', e.id, { number: e.number, amount: e.amount, note });
    });
    return this.get(e.id);
  }

  // --- Justificatifs --------------------------------------------------------------

  /** Joint un justificatif (photo, PDF) à une dépense, en base64. */
  attach(ctx: Context, expenseId: string, file: { name: string; mime: string; data: string }): ExpenseAttachment {
    const e = this.get(expenseId);
    if (e.status === 'cancelled') throw new AppError('Cette dépense est annulée', 'INVALID');
    if (!(file.mime in ATTACHMENT_TYPES)) throw new AppError('Joignez une photo (JPEG, PNG) ou un PDF', 'INVALID');
    const data = String(file.data ?? '').replace(/^data:[^,]*,/, '');
    if (!/^[A-Za-z0-9+/]+=*$/.test(data)) throw new AppError('Fichier illisible', 'INVALID');
    const size = Math.floor((data.length * 3) / 4) - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0);
    if (size <= 0) throw new AppError('Fichier vide', 'INVALID');
    if (size > ATTACHMENT_MAX_BYTES) throw new AppError('Fichier trop lourd : 3 Mo au plus (réduisez la photo ou scannez en noir et blanc)', 'INVALID');
    const count = this.db.prepare("SELECT COUNT(*) FROM expense_attachments WHERE expense_id = ? AND status = 'active'").pluck().get(expenseId) as number;
    if (count >= 5) throw new AppError('Cinq justificatifs au plus par dépense', 'INVALID');
    const name = (file.name ?? '').trim().slice(0, 120) || 'justificatif';
    const id = newId();
    this.tx(() => {
      const now = this.now();
      this.db
        .prepare(
          `INSERT INTO expense_attachments (id, expense_id, store_id, name, mime, size, data, user_id, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
        )
        .run(id, expenseId, e.store_id, name, file.mime, size, data, ctx.userId, now, now);
      this.enqueue(ctx, 'expense_attachment', id, 'upsert', {});
      this.audit(ctx.userId, 'expense.attach', 'expense', expenseId, { number: e.number, name, size });
    });
    return this.attachments(expenseId).find((a) => a.id === id)!;
  }

  attachments(expenseId: string): ExpenseAttachment[] {
    return this.db
      .prepare(
        `SELECT j.id, j.expense_id, j.name, j.mime, j.size, u.name AS user_name, j.created_at FROM expense_attachments j
         LEFT JOIN users u ON u.id = j.user_id WHERE j.expense_id = ? AND j.status = 'active' ORDER BY j.created_at`,
      )
      .all(expenseId) as ExpenseAttachment[];
  }

  /** Contenu d'un justificatif (base64), pour l'ouvrir. */
  attachment(id: string): ExpenseAttachment & { data: string } {
    const row = this.db
      .prepare(
        `SELECT j.id, j.expense_id, j.name, j.mime, j.size, u.name AS user_name, j.created_at, j.data FROM expense_attachments j
         LEFT JOIN users u ON u.id = j.user_id WHERE j.id = ? AND j.status = 'active'`,
      )
      .get(id) as (ExpenseAttachment & { data: string }) | undefined;
    if (!row) throw new AppError('Justificatif introuvable', 'NOT_FOUND');
    return row;
  }

  /** Retire un justificatif joint par erreur (pas après l'approbation de la dépense). */
  removeAttachment(ctx: Context, id: string): void {
    const a = this.attachment(id);
    const e = this.get(a.expense_id);
    if (e.approval === 'approved' && this.admin?.storeSettings(ctx.storeId).expenseProofRequired && e.attachments <= 1) {
      throw new AppError('La dépense est approuvée sur ce justificatif : il ne se retire plus', 'INVALID');
    }
    this.tx(() => {
      this.db.prepare("UPDATE expense_attachments SET status = 'deleted', data = '', updated_at = ? WHERE id = ?").run(this.now(), id);
      this.enqueue(ctx, 'expense_attachment', id, 'upsert', {});
      this.audit(ctx.userId, 'expense.detach', 'expense', a.expense_id, { number: e.number, name: a.name });
    });
  }

  /** Totaux par catégorie et par mode de paiement sur une période. */
  summary(storeId: string, opts: { from?: string; to?: string } = {}) {
    const params = { storeId, from: opts.from ?? null, to: opts.to ?? null };
    const where = `e.store_id = @storeId AND e.status = 'active' AND (@from IS NULL OR e.expense_date >= @from) AND (@to IS NULL OR e.expense_date <= @to)`;
    const byCategory = this.db
      .prepare(
        `SELECT c.id, c.name, e.account_id, COUNT(*) AS count, SUM(e.amount) AS amount, SUM(e.vat) AS vat
         FROM expenses e JOIN expense_categories c ON c.id = e.category_id WHERE ${where}
         GROUP BY c.id, e.account_id ORDER BY amount DESC`,
      )
      .all(params) as { id: string; name: string; account_id: string; count: number; amount: Fcfa; vat: Fcfa }[];
    const byMethod = (
      this.db.prepare(`SELECT e.method, SUM(e.amount) AS amount FROM expenses e WHERE ${where} GROUP BY e.method ORDER BY amount DESC`).all(params) as {
        method: ExpensePaymentMethod;
        amount: Fcfa;
      }[]
    ).map((m) => ({ ...m, label: EXPENSE_PAYMENT_METHODS[m.method] }));
    const byMonth = this.db
      .prepare(`SELECT substr(e.expense_date, 1, 7) AS month, SUM(e.amount) AS amount FROM expenses e WHERE ${where} GROUP BY month ORDER BY month`)
      .all(params) as { month: string; amount: Fcfa }[];
    const total = byCategory.reduce((t, c) => t + c.amount, 0);
    return { byCategory, byMethod, byMonth, total, vat: byCategory.reduce((t, c) => t + c.vat, 0) };
  }

  private query(where: string, limit = 1) {
    return this.db.prepare(
      `SELECT e.id, e.number, e.store_id, e.category_id, c.name AS category_name, e.account_id, e.expense_date, e.label, e.beneficiary,
              e.amount, e.vat, e.method, e.reference, e.register_id, g.name AS register_name, e.session_id, u.name AS user_name,
              a.name AS authorized_by_name, e.status, e.cancel_reason, x.name AS cancelled_by_name, e.created_at,
              e.plan_id, e.plan_period, e.approval, p.name AS approved_by_name, e.approved_at, e.approval_note,
              (SELECT COUNT(*) FROM expense_attachments j WHERE j.expense_id = e.id AND j.status = 'active') AS attachments
       FROM expenses e JOIN expense_categories c ON c.id = e.category_id
       LEFT JOIN registers g ON g.id = e.register_id LEFT JOIN users u ON u.id = e.user_id
       LEFT JOIN users a ON a.id = e.authorized_by LEFT JOIN users x ON x.id = e.cancelled_by LEFT JOIN users p ON p.id = e.approved_by
       WHERE ${where} ORDER BY e.expense_date DESC, e.created_at DESC LIMIT ${limit}`,
    );
  }
}
