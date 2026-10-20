import type { Fcfa } from '@superette/core';
import type { AccountingService, Entry } from './accounting';
import type { ChargeService } from './charges';
import type { CustomerService } from './customers';
import type { PurchaseService } from './purchases';
import type { ReportService } from './reports';
import { AppError, Base, type Clock, type Context } from './util';
import type { Db } from './database';

export interface ForecastWeek {
  /** Premier et dernier jour de la semaine (AAAA-MM-JJ). */
  from: string;
  to: string;
  opening: Fcfa;
  /** Échéances des clients (ventes à crédit). */
  customers: Fcfa;
  /** Ventes payées comptant, estimées d'après les 4 dernières semaines. */
  sales: Fcfa;
  /** Factures fournisseurs à payer. */
  suppliers: Fcfa;
  /** Achats de marchandises payés comptant, estimés d'après les 4 dernières semaines. */
  purchases: Fcfa;
  /** Charges fixes prévues (loyer, salaires, ENEO…). */
  charges: Fcfa;
  closing: Fcfa;
}

export interface Forecast {
  today: string;
  /** Caisses, banques, Mobile Money et chèques à encaisser aujourd'hui. */
  opening: Fcfa;
  positions: { account: string; label: string; balance: Fcfa }[];
  estimates: boolean;
  weeks: ForecastWeek[];
  /** Ce qui est déjà en retard (compté dans la première semaine). */
  late: { customers: Fcfa; suppliers: Fcfa; charges: Fcfa };
  /** Détail des échéances, pour la liste sous le tableau. */
  items: { date: string; kind: 'customer' | 'supplier' | 'charge'; label: string; amount: Fcfa; late: boolean }[];
}

export interface BudgetRow {
  account: string;
  label: string;
  /** Produit (classe 7) : le réel compte au crédit ; charge : au débit. */
  income: boolean;
  months: Fcfa[];
  budget: Fcfa;
  real: Fcfa;
  gap: Fcfa;
  budgetToDate: Fcfa;
  realToDate: Fcfa;
  gapToDate: Fcfa;
}

export interface AnalyticRow {
  key: string;
  label: string;
  revenueHt: Fcfa;
  cost: Fcfa;
  margin: Fcfa;
  /** Charges (classe 6 hors achats de marchandises), réparties au prorata du chiffre d'affaires HT. */
  charges: Fcfa;
  result: Fcfa;
  /** Part du chiffre d'affaires (points de base). */
  shareBp: number;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
/** Charges d'exploitation : classe 6 sauf les achats de marchandises et leur variation de stock (60). */
const isCharge = (account: string) => account.startsWith('6') && !account.startsWith('60');

/**
 * Pilotage, comme les modules de Sage Comptabilité : trésorerie prévisionnelle
 * (échéances clients, fournisseurs et charges fixes semaine par semaine),
 * budgets mensuels par compte comparés au réel, et analytique par magasin et
 * par rayon (marge, part des charges, résultat).
 */
export class PlanningService extends Base {
  constructor(
    db: Db,
    clock: Clock,
    private readonly accounting: AccountingService,
    private readonly customers: CustomerService,
    private readonly purchases: PurchaseService,
    private readonly charges: ChargeService,
    private readonly reports: ReportService,
  ) {
    super(db, clock);
  }

  // --- Trésorerie prévisionnelle ---------------------------------------------------

  forecast(storeId: string, opts: { weeks?: number; estimates?: boolean } = {}): Forecast {
    const weeksCount = opts.weeks ?? 8;
    if (!Number.isInteger(weeksCount) || weeksCount < 1 || weeksCount > 26) throw new AppError('Entre 1 et 26 semaines', 'INVALID');
    const estimates = opts.estimates ?? true;
    const today = this.today();
    const end = addDays(today, weeksCount * 7 - 1);
    const positions = this.accounting.treasury(storeId);
    const opening = positions.reduce((t, p) => t + p.balance, 0);
    const items: Forecast['items'] = [];
    const late = { customers: 0, suppliers: 0, charges: 0 };

    for (const c of this.customers.receivables(storeId).customers) {
      for (const i of this.customers.account(storeId, c.id).openItems) {
        const due = (i.due_date ?? i.created_at).slice(0, 10);
        if (due > end || i.remaining <= 0) continue;
        if (due < today) late.customers += i.remaining;
        items.push({ date: due, kind: 'customer', label: `${c.name} · ${i.number}`, amount: i.remaining, late: due < today });
      }
    }
    for (const inv of this.purchases.listInvoices(storeId, { unpaid: true })) {
      if (inv.kind !== 'invoice' || inv.balance <= 0 || inv.due_date > end) continue;
      if (inv.due_date < today) late.suppliers += inv.balance;
      items.push({ date: inv.due_date, kind: 'supplier', label: `${inv.supplier_name} · ${inv.supplier_number}`, amount: -inv.balance, late: inv.due_date < today });
    }
    // Charges fixes : 12 mois en arrière (les retards) jusqu'à la fin de la période.
    const month = today.slice(0, 7);
    const back = `${Number(month.slice(0, 4)) - 1}${month.slice(4)}`;
    for (const o of this.charges.schedule(storeId, back, end.slice(0, 7)).occurrences) {
      if (o.state === 'paid' || o.due_date > end) continue;
      if (o.due_date < today) late.charges += o.expected;
      items.push({ date: o.due_date, kind: 'charge', label: o.label, amount: -o.expected, late: o.due_date < today });
    }
    items.sort((a, b) => a.date.localeCompare(b.date) || a.label.localeCompare(b.label));

    // Moyennes des 4 dernières semaines : ventes encaissées tout de suite, achats payés comptant.
    const since = addDays(today, -28);
    const cashSales = estimates
      ? Math.round(
          ((this.db
            .prepare(
              `SELECT COALESCE(SUM(p.amount), 0) - COALESCE((SELECT SUM(change_given) FROM sales WHERE store_id = @storeId AND status = 'completed'
                        AND date(created_at, 'localtime') >= @since AND date(created_at, 'localtime') < @today), 0)
               FROM sale_payments p JOIN sales s ON s.id = p.sale_id
               WHERE s.store_id = @storeId AND s.status = 'completed' AND p.method NOT IN ('CUSTOMER_CREDIT', 'LOYALTY', 'VOUCHER')
                 AND date(s.created_at, 'localtime') >= @since AND date(s.created_at, 'localtime') < @today`,
            )
            .pluck()
            .get({ storeId, since, today }) as number) /
            4),
        )
      : 0;
    const cashPurchases = estimates
      ? Math.round(
          ((this.db
            .prepare(
              `SELECT COALESCE(SUM(p.amount), 0) FROM supplier_payments p JOIN supplier_invoices i ON i.id = p.invoice_id
               WHERE p.store_id = @storeId AND i.kind = 'invoice' AND date(p.paid_at, 'localtime') >= @since AND date(p.paid_at, 'localtime') < @today
                 AND date(p.paid_at, 'localtime') <= i.invoice_date`,
            )
            .pluck()
            .get({ storeId, since, today }) as number) /
            4),
        )
      : 0;

    const weeks: ForecastWeek[] = [];
    let balance = opening;
    for (let w = 0; w < weeksCount; w++) {
      const from = addDays(today, w * 7);
      const to = addDays(from, 6);
      // Les retards sont attendus dès la première semaine.
      const inWeek = items.filter((i) => (w === 0 ? i.date <= to : i.date >= from && i.date <= to));
      const sum = (kind: Forecast['items'][number]['kind']) => inWeek.filter((i) => i.kind === kind).reduce((t, i) => t + i.amount, 0);
      const week = { from, to, opening: balance, customers: sum('customer'), sales: cashSales, suppliers: sum('supplier'), purchases: -cashPurchases, charges: sum('charge'), closing: 0 };
      week.closing = week.opening + week.customers + week.sales + week.suppliers + week.purchases + week.charges;
      balance = week.closing;
      weeks.push(week);
    }
    return { today, opening, positions, estimates, weeks, late, items };
  }

  // --- Budgets ---------------------------------------------------------------------

  /** Budget d'un compte pour l'année : 12 montants mensuels ; tout à zéro le retire. */
  saveBudget(ctx: Context, input: { year: number; account: string; months: Fcfa[] }): void {
    if (!Number.isInteger(input.year) || input.year < 2000 || input.year > 2100) throw new AppError('Année invalide', 'INVALID');
    if (input.months.length !== 12 || input.months.some((m) => !Number.isSafeInteger(m) || m < 0)) throw new AppError('Douze montants positifs, un par mois', 'INVALID');
    const account = this.db.prepare('SELECT id FROM accounts WHERE id = ?').pluck().get(input.account.trim()) as string | undefined;
    if (!account || !/^[67]/.test(account)) throw new AppError('Choisissez un compte de charges (6) ou de produits (7) du plan comptable', 'INVALID');
    const id = `${ctx.storeId}:${input.year}:${account}`;
    this.tx(() => {
      if (input.months.every((m) => m === 0)) {
        this.db.prepare('DELETE FROM budgets WHERE id = ?').run(id);
        this.enqueue(ctx, 'budget', id, 'delete', {});
      } else {
        this.db
          .prepare(
            `INSERT INTO budgets (id, store_id, year, account, months, updated_at) VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET months = excluded.months, updated_at = excluded.updated_at`,
          )
          .run(id, ctx.storeId, input.year, account, JSON.stringify(input.months), this.now());
        this.enqueue(ctx, 'budget', id, 'upsert', {});
      }
      this.audit(ctx.userId, 'budget.save', 'budget', id, { total: input.months.reduce((t, m) => t + m, 0) });
    });
  }

  /** Réel d'un compte (ou de tous) mois par mois sur l'année : débit − crédit pour une charge, l'inverse pour un produit. */
  realByMonth(storeId: string, year: number, entries?: Entry[]): Map<string, Fcfa[]> {
    const list = entries ?? this.accounting.entries(storeId, { from: `${year}-01-01`, to: `${year}-12-31` });
    const out = new Map<string, Fcfa[]>();
    for (const e of list) {
      if (e.closing || e.journal === 'AN') continue;
      const m = Number(e.date.slice(5, 7)) - 1;
      for (const l of e.lines) {
        if (!/^[67]/.test(l.account)) continue;
        const row = out.get(l.account) ?? Array<Fcfa>(12).fill(0);
        row[m]! += l.account.startsWith('7') ? l.credit - l.debit : l.debit - l.credit;
        out.set(l.account, row);
      }
    }
    return out;
  }

  /** Budgets de l'année comparés au réel : le mois choisi et le cumul depuis janvier. */
  budgetReport(storeId: string, year: number, month: number): { year: number; month: number; rows: BudgetRow[]; totals: { charges: BudgetRow; income: BudgetRow } } {
    if (!Number.isInteger(month) || month < 1 || month > 12) throw new AppError('Mois invalide', 'INVALID');
    const budgets = this.db.prepare('SELECT account, months FROM budgets WHERE store_id = ? AND year = ? ORDER BY account').all(storeId, year) as { account: string; months: string }[];
    const real = this.realByMonth(storeId, year);
    const labels = new Map(this.accounting.listAccounts(true).map((a) => [a.id, a.label]));
    // Le réel d'un compte budgété comprend ses sous-comptes (6052 pour un budget sur 605).
    const realOf = (account: string) => {
      const sum = Array<Fcfa>(12).fill(0);
      for (const [acc, months] of real) if (acc.startsWith(account)) months.forEach((v, i) => (sum[i]! += v));
      return sum;
    };
    const rows = budgets.map((b) => {
      const months = JSON.parse(b.months) as Fcfa[];
      const r = realOf(b.account);
      const upTo = (arr: Fcfa[]) => arr.slice(0, month).reduce((t, v) => t + v, 0);
      const row: BudgetRow = {
        account: b.account,
        label: labels.get(b.account) ?? b.account,
        income: b.account.startsWith('7'),
        months,
        budget: months[month - 1] ?? 0,
        real: r[month - 1] ?? 0,
        gap: 0,
        budgetToDate: upTo(months),
        realToDate: upTo(r),
        gapToDate: 0,
      };
      // Écart favorable positif : moins de charges, ou plus de produits, que prévu.
      row.gap = row.income ? row.real - row.budget : row.budget - row.real;
      row.gapToDate = row.income ? row.realToDate - row.budgetToDate : row.budgetToDate - row.realToDate;
      return row;
    });
    const total = (income: boolean): BudgetRow => {
      const part = rows.filter((r) => r.income === income);
      const add = (k: 'budget' | 'real' | 'gap' | 'budgetToDate' | 'realToDate' | 'gapToDate') => part.reduce((t, r) => t + r[k], 0);
      return {
        account: '',
        label: income ? 'Total des produits' : 'Total des charges',
        income,
        months: Array<Fcfa>(12)
          .fill(0)
          .map((_, i) => part.reduce((t, r) => t + (r.months[i] ?? 0), 0)),
        budget: add('budget'),
        real: add('real'),
        gap: add('gap'),
        budgetToDate: add('budgetToDate'),
        realToDate: add('realToDate'),
        gapToDate: add('gapToDate'),
      };
    };
    return { year, month, rows, totals: { charges: total(false), income: total(true) } };
  }

  // --- Analytique --------------------------------------------------------------------

  /** Résultat par rayon : marge des ventes, charges réparties au prorata du chiffre d'affaires. */
  analyticByDepartment(storeId: string, from: string, to: string): { rows: AnalyticRow[]; total: AnalyticRow; charges: { account: string; label: string; amount: Fcfa }[] } {
    if (!DAY.test(from) || !DAY.test(to) || to < from) throw new AppError('Période invalide', 'INVALID');
    const report = this.reports.sales(storeId, { from, to, dimension: 'department' });
    const charges = this.chargesOf(storeId, from, to);
    const chargesTotal = charges.reduce((t, c) => t + c.amount, 0);
    const revenue = report.rows.reduce((t, r) => t + (r.revenueHt ?? 0), 0);
    let left = chargesTotal;
    const sorted = [...report.rows].sort((a, b) => (b.revenueHt ?? 0) - (a.revenueHt ?? 0));
    const rows = sorted.map((r, i) => {
      const ht = r.revenueHt ?? 0;
      // La dernière ligne prend le reste : la somme retombe juste sur le total des charges.
      const share = i === sorted.length - 1 ? left : revenue > 0 ? Math.round((chargesTotal * ht) / revenue) : 0;
      left -= share;
      const margin = r.margin ?? ht - (r.cost ?? 0);
      return { key: r.key, label: r.label, revenueHt: ht, cost: r.cost ?? 0, margin, charges: share, result: margin - share, shareBp: revenue > 0 ? Math.round((ht * 10_000) / revenue) : 0 };
    });
    return { rows, total: this.sumRows('Total du magasin', rows, chargesTotal), charges };
  }

  /** Résultat par magasin (ceux dont les ventes sont sur ce poste ou ce serveur). */
  analyticByStore(from: string, to: string): { rows: AnalyticRow[]; total: AnalyticRow } {
    if (!DAY.test(from) || !DAY.test(to) || to < from) throw new AppError('Période invalide', 'INVALID');
    const stores = this.db.prepare('SELECT id, name FROM stores ORDER BY name').all() as { id: string; name: string }[];
    const rows = stores
      .map((s) => {
        const t = this.reports.sales(s.id, { from, to, dimension: 'department' }).totals;
        const charges = this.chargesOf(s.id, from, to).reduce((x, c) => x + c.amount, 0);
        return { key: s.id, label: s.name, revenueHt: t.revenueHt, cost: t.cost, margin: t.margin, charges, result: t.margin - charges, shareBp: 0 };
      })
      .filter((r) => r.revenueHt !== 0 || r.charges !== 0);
    const revenue = rows.reduce((t, r) => t + r.revenueHt, 0);
    for (const r of rows) r.shareBp = revenue > 0 ? Math.round((r.revenueHt * 10_000) / revenue) : 0;
    return { rows, total: this.sumRows('Total', rows, rows.reduce((t, r) => t + r.charges, 0)) };
  }

  private chargesOf(storeId: string, from: string, to: string): { account: string; label: string; amount: Fcfa }[] {
    const labels = new Map(this.accounting.listAccounts(true).map((a) => [a.id, a.label]));
    const sums = new Map<string, Fcfa>();
    for (const e of this.accounting.entries(storeId, { from, to })) {
      if (e.closing || e.journal === 'AN') continue;
      for (const l of e.lines) if (isCharge(l.account)) sums.set(l.account, (sums.get(l.account) ?? 0) + l.debit - l.credit);
    }
    return [...sums]
      .filter(([, v]) => v !== 0)
      .map(([account, amount]) => ({ account, label: labels.get(account) ?? account, amount }))
      .sort((a, b) => a.account.localeCompare(b.account));
  }

  private sumRows(label: string, rows: AnalyticRow[], charges: Fcfa): AnalyticRow {
    const add = (k: 'revenueHt' | 'cost' | 'margin') => rows.reduce((t, r) => t + r[k], 0);
    const margin = add('margin');
    return { key: 'total', label, revenueHt: add('revenueHt'), cost: add('cost'), margin, charges, result: margin - charges, shareBp: 10_000 };
  }
}
