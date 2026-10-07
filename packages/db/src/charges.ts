import type { Fcfa } from '@superette/core';
import { EXPENSE_PAYMENT_METHODS, type ExpensePaymentMethod } from './expenses';
import { AppError, Base, type Context, newId } from './util';

export type ChargeFrequency = 'monthly' | 'quarterly' | 'yearly';

export const CHARGE_FREQUENCIES: Record<ChargeFrequency, string> = {
  monthly: 'Tous les mois',
  quarterly: 'Tous les trimestres',
  yearly: 'Tous les ans',
};

const STEP: Record<ChargeFrequency, number> = { monthly: 1, quarterly: 3, yearly: 12 };

export interface ChargePlan {
  id: string;
  store_id: string;
  category_id: string;
  category_name: string;
  label: string;
  beneficiary: string | null;
  amount: Fcfa;
  frequency: ChargeFrequency;
  due_day: number;
  start_month: string;
  end_month: string | null;
  method: ExpensePaymentMethod;
  active: number;
}

export interface ChargePlanInput {
  categoryId: string;
  label: string;
  beneficiary?: string | null;
  amount: Fcfa;
  frequency: ChargeFrequency;
  dueDay: number;
  /** AAAA-MM : première échéance. */
  startMonth: string;
  endMonth?: string | null;
  method?: ExpensePaymentMethod;
  active?: boolean;
}

export type ChargeState = 'paid' | 'late' | 'due' | 'upcoming';

export const CHARGE_STATES: Record<ChargeState, string> = {
  paid: 'Constatée',
  late: 'En retard',
  due: 'À payer cette semaine',
  upcoming: 'À venir',
};

export interface ChargeOccurrence {
  plan_id: string;
  label: string;
  category_id: string;
  category_name: string;
  beneficiary: string | null;
  method: ExpensePaymentMethod;
  /** AAAA-MM de l'échéance. */
  period: string;
  due_date: string;
  expected: Fcfa;
  paid: Fcfa;
  expense_id: string | null;
  expense_number: string | null;
  state: ChargeState;
}

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

/** AAAA-MM décalé de `n` mois. */
export function addMonths(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const total = y * 12 + (m - 1) + n;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`;
}

/** Mois des échéances d'une charge entre `from` et `to` (AAAA-MM compris). */
export function chargePeriods(plan: Pick<ChargePlan, 'frequency' | 'start_month' | 'end_month'>, from: string, to: string): string[] {
  const out: string[] = [];
  const step = STEP[plan.frequency];
  const last = plan.end_month && plan.end_month < to ? plan.end_month : to;
  for (let m = plan.start_month; m <= last; m = addMonths(m, step)) if (m >= from) out.push(m);
  return out;
}

/**
 * Charges fixes : définition des charges qui reviennent (loyer, ENEO,
 * salaires, CNPS…) et constat de chaque échéance par la dépense qui la paie.
 * L'état d'une échéance (constatée, en retard, à payer) se calcule ; seule
 * la dépense est enregistrée.
 */
export class ChargeService extends Base {
  listPlans(storeId: string, includeInactive = false): ChargePlan[] {
    return this.db
      .prepare(
        `SELECT p.*, c.name AS category_name FROM charge_plans p JOIN expense_categories c ON c.id = p.category_id
         WHERE p.store_id = ? AND (? = 1 OR p.active = 1) ORDER BY p.active DESC, p.due_day, p.label`,
      )
      .all(storeId, includeInactive ? 1 : 0) as ChargePlan[];
  }

  getPlan(id: string): ChargePlan {
    const row = this.db
      .prepare('SELECT p.*, c.name AS category_name FROM charge_plans p JOIN expense_categories c ON c.id = p.category_id WHERE p.id = ?')
      .get(id) as ChargePlan | undefined;
    if (!row) throw new AppError('Charge introuvable', 'NOT_FOUND');
    return row;
  }

  savePlan(ctx: Context, input: ChargePlanInput, id?: string | null): ChargePlan {
    const label = input.label.trim();
    if (!label) throw new AppError('Indiquez le libellé de la charge', 'INVALID');
    if (!Number.isSafeInteger(input.amount) || input.amount <= 0) throw new AppError('Montant invalide', 'INVALID');
    if (!(input.frequency in STEP)) throw new AppError('Rythme inconnu', 'INVALID');
    if (!Number.isInteger(input.dueDay) || input.dueDay < 1 || input.dueDay > 28) throw new AppError("Le jour d'échéance va du 1 au 28", 'INVALID');
    if (!MONTH.test(input.startMonth)) throw new AppError('Mois de début invalide', 'INVALID');
    if (input.endMonth && (!MONTH.test(input.endMonth) || input.endMonth < input.startMonth)) throw new AppError('Mois de fin invalide', 'INVALID');
    const method = input.method ?? 'CASH';
    if (!(method in EXPENSE_PAYMENT_METHODS)) throw new AppError(`Mode de paiement inconnu : ${method}`, 'INVALID');
    const category = this.db.prepare('SELECT active FROM expense_categories WHERE id = ?').pluck().get(input.categoryId);
    if (!category) throw new AppError('Choisissez la catégorie de la charge', 'INVALID');
    return this.tx(() => {
      const now = this.now();
      const params = {
        category: input.categoryId,
        label,
        beneficiary: input.beneficiary?.trim() || null,
        amount: input.amount,
        frequency: input.frequency,
        dueDay: input.dueDay,
        start: input.startMonth,
        end: input.endMonth || null,
        method,
        active: input.active === false ? 0 : 1,
        now,
      };
      let planId = id;
      if (planId) {
        const existing = this.getPlan(planId);
        if (existing.store_id !== ctx.storeId) throw new AppError("Cette charge appartient à un autre magasin", 'INVALID');
        this.db
          .prepare(
            `UPDATE charge_plans SET category_id = @category, label = @label, beneficiary = @beneficiary, amount = @amount, frequency = @frequency,
               due_day = @dueDay, start_month = @start, end_month = @end, method = @method, active = @active, updated_at = @now WHERE id = @id`,
          )
          .run({ ...params, id: planId });
      } else {
        planId = newId();
        this.db
          .prepare(
            `INSERT INTO charge_plans (id, store_id, category_id, label, beneficiary, amount, frequency, due_day, start_month, end_month, method, active, created_at, updated_at)
             VALUES (@id, @store, @category, @label, @beneficiary, @amount, @frequency, @dueDay, @start, @end, @method, @active, @now, @now)`,
          )
          .run({ ...params, id: planId, store: ctx.storeId });
      }
      this.enqueue(ctx, 'charge_plan', planId, 'upsert', {});
      this.audit(ctx.userId, 'charge.plan', 'charge_plan', planId, { label, amount: input.amount, frequency: input.frequency });
      return this.getPlan(planId);
    });
  }

  /**
   * Échéancier des charges entre deux mois (AAAA-MM) : chaque échéance avec la
   * dépense qui l'a constatée. Une échéance non payée est « en retard » après
   * sa date, « à payer » dans les 7 jours qui viennent.
   */
  schedule(storeId: string, from: string, to: string): { occurrences: ChargeOccurrence[]; totals: Record<ChargeState, Fcfa> & { expected: Fcfa; paid: Fcfa } } {
    if (!MONTH.test(from) || !MONTH.test(to) || from > to) throw new AppError('Période invalide', 'INVALID');
    const today = this.today();
    const soon = new Date(Date.parse(`${today}T00:00:00Z`) + 7 * 86_400_000).toISOString().slice(0, 10);
    const paid = new Map<string, { amount: Fcfa; id: string; number: string }>();
    for (const e of this.db
      .prepare(
        `SELECT plan_id, plan_period, SUM(amount) AS amount, MIN(id) AS id, MIN(number) AS number FROM expenses
         WHERE store_id = ? AND status = 'active' AND plan_id IS NOT NULL GROUP BY plan_id, plan_period`,
      )
      .all(storeId) as { plan_id: string; plan_period: string; amount: Fcfa; id: string; number: string }[]) {
      paid.set(`${e.plan_id}|${e.plan_period}`, e);
    }
    const occurrences: ChargeOccurrence[] = [];
    for (const p of this.listPlans(storeId, true)) {
      for (const period of chargePeriods(p, from, to)) {
        const e = paid.get(`${p.id}|${period}`);
        // Une charge désactivée ne laisse que ses échéances déjà constatées.
        if (!p.active && !e) continue;
        const due = `${period}-${String(p.due_day).padStart(2, '0')}`;
        const state: ChargeState = e ? 'paid' : due < today ? 'late' : due <= soon ? 'due' : 'upcoming';
        occurrences.push({
          plan_id: p.id,
          label: p.label,
          category_id: p.category_id,
          category_name: p.category_name,
          beneficiary: p.beneficiary,
          method: p.method,
          period,
          due_date: due,
          expected: p.amount,
          paid: e?.amount ?? 0,
          expense_id: e?.id ?? null,
          expense_number: e?.number ?? null,
          state,
        });
      }
    }
    occurrences.sort((a, b) => (a.due_date === b.due_date ? a.label.localeCompare(b.label) : a.due_date < b.due_date ? -1 : 1));
    const totals = { paid: 0, late: 0, due: 0, upcoming: 0, expected: 0 } as Record<ChargeState, Fcfa> & { expected: Fcfa };
    for (const o of occurrences) {
      totals.expected += o.expected;
      if (o.state === 'paid') totals.paid += o.paid;
      else totals[o.state] += o.expected;
    }
    return { occurrences, totals };
  }

  /** Échéances non constatées dont la date est passée (sur les 12 derniers mois). */
  late(storeId: string): { count: number; amount: Fcfa } {
    const month = this.today().slice(0, 7);
    const late = this.schedule(storeId, addMonths(month, -11), month).occurrences.filter((o) => o.state === 'late');
    return { count: late.length, amount: late.reduce((t, o) => t + o.expected, 0) };
  }

  /** Vérifie qu'une dépense peut constater cette échéance (charge du magasin, pas déjà payée). */
  assertOpen(storeId: string, planId: string, period: string): ChargePlan {
    const plan = this.getPlan(planId);
    if (plan.store_id !== storeId) throw new AppError('Cette charge appartient à un autre magasin', 'INVALID');
    if (!MONTH.test(period) || !chargePeriods(plan, period, period).length) throw new AppError("Ce mois n'est pas une échéance de la charge", 'INVALID');
    const done = this.db
      .prepare("SELECT number FROM expenses WHERE plan_id = ? AND plan_period = ? AND status = 'active'")
      .pluck()
      .get(planId, period) as string | undefined;
    if (done) throw new AppError(`L'échéance ${period} de « ${plan.label} » est déjà constatée (${done})`, 'INVALID');
    return plan;
  }
}
