import type { Fcfa } from '@superette/core';
import { AppError, Base, type Context, newId } from './util';

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
}

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
  /** Payée avec les espèces du tiroir de la caisse ouverte : elle sort du Z. */
  atRegister?: boolean;
  /** Gérant qui a autorisé une sortie de caisse faite par un caissier. */
  authorizedBy?: string | null;
}

/**
 * Dépenses courantes (loyer, ENEO, salaires, transport…). Chacune passe en
 * comptabilité sur le compte de sa catégorie ; payée au tiroir, elle diminue
 * les espèces attendues au Z.
 */
export class ExpenseService extends Base {
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
    const vat = input.vat ?? 0;
    if (!Number.isSafeInteger(vat) || vat < 0 || vat >= input.amount) throw new AppError('La TVA doit être inférieure au montant payé', 'INVALID');
    if (!input.label.trim()) throw new AppError("Indiquez l'objet de la dépense", 'INVALID');
    if (input.method !== 'CASH' && !input.reference?.trim()) {
      throw new AppError(`Référence obligatoire pour un paiement par ${EXPENSE_PAYMENT_METHODS[input.method]}`, 'REFERENCE_REQUIRED');
    }
    const category = this.db.prepare('SELECT id, account_id, active FROM expense_categories WHERE id = ?').get(input.categoryId) as
      | { id: string; account_id: string; active: number }
      | undefined;
    if (!category || !category.active) throw new AppError('Choisissez la catégorie de la dépense', 'INVALID');
    let sessionId: string | null = null;
    let date = input.date || this.today();
    if (input.atRegister) {
      if (input.method !== 'CASH') throw new AppError('Une sortie de caisse se paie en espèces', 'INVALID');
      if (!ctx.registerId) throw new AppError("Ce poste n'a pas de caisse", 'NO_REGISTER');
      sessionId = this.db.prepare("SELECT id FROM cash_sessions WHERE register_id = ? AND status = 'open'").pluck().get(ctx.registerId) as string | null;
      if (!sessionId) throw new AppError("Ouvrez la caisse avant d'y prendre de l'argent", 'NO_SESSION');
      date = this.today();
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new AppError('Date invalide', 'INVALID');
    if (date > this.today()) throw new AppError('La date de la dépense ne peut pas être dans le futur', 'INVALID');
    return this.tx(() => {
      const id = newId();
      const now = this.now();
      this.db
        .prepare(
          `INSERT INTO expenses (id, number, store_id, category_id, account_id, expense_date, label, beneficiary, amount, vat, method, reference,
             register_id, session_id, user_id, authorized_by, status, created_at, updated_at)
           VALUES (@id, @number, @store, @category, @account, @date, @label, @beneficiary, @amount, @vat, @method, @reference,
             @register, @session, @user, @authorizedBy, 'active', @now, @now)`,
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
          register: sessionId ? ctx.registerId : null,
          session: sessionId,
          user: ctx.userId,
          authorizedBy: input.authorizedBy ?? null,
          now,
        });
      this.enqueue(ctx, 'expense', id, 'upsert', {});
      this.audit(input.authorizedBy ?? ctx.userId, 'expense.record', 'expense', id, { amount: input.amount, method: input.method, atRegister: !!sessionId, by: ctx.userId });
      return this.get(id);
    });
  }

  /** Annulation (erreur de saisie). Une sortie de caisse ne s'annule plus une fois le Z clôturé. */
  cancel(ctx: Context, id: string, supervisorId: string, reason: string): Expense {
    const e = this.get(id);
    if (e.status === 'cancelled') throw new AppError('Cette dépense est déjà annulée', 'INVALID');
    if (!reason.trim()) throw new AppError("Le motif de l'annulation est obligatoire", 'INVALID');
    if (e.session_id) {
      const status = this.db.prepare('SELECT status FROM cash_sessions WHERE id = ?').pluck().get(e.session_id);
      if (status !== 'open') throw new AppError("Le Z de cette caisse est clôturé : la sortie d'espèces ne peut plus être annulée", 'SESSION_CLOSED');
    }
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
    opts: { from?: string; to?: string; categoryId?: string; sessionId?: string; includeCancelled?: boolean; limit?: number } = {},
  ): Expense[] {
    return this.query(
      `e.store_id = @storeId AND (@from IS NULL OR e.expense_date >= @from) AND (@to IS NULL OR e.expense_date <= @to)
       AND (@category IS NULL OR e.category_id = @category) AND (@session IS NULL OR e.session_id = @session)
       AND (@cancelled = 1 OR e.status = 'active')`,
      opts.limit ?? 1000,
    ).all({
      storeId,
      from: opts.from ?? null,
      to: opts.to ?? null,
      category: opts.categoryId ?? null,
      session: opts.sessionId ?? null,
      cancelled: opts.includeCancelled ? 1 : 0,
    }) as Expense[];
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
              a.name AS authorized_by_name, e.status, e.cancel_reason, x.name AS cancelled_by_name, e.created_at
       FROM expenses e JOIN expense_categories c ON c.id = e.category_id
       LEFT JOIN registers g ON g.id = e.register_id LEFT JOIN users u ON u.id = e.user_id
       LEFT JOIN users a ON a.id = e.authorized_by LEFT JOIN users x ON x.id = e.cancelled_by
       WHERE ${where} ORDER BY e.expense_date DESC, e.created_at DESC LIMIT ${limit}`,
    );
  }
}
