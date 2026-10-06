import type { Fcfa } from '@superette/core';
import type { AccountingService } from './accounting';
import type { FinancialStatementsService } from './statements';
import { AppError, Base, type Context } from './util';

export type TaxForm = 'company' | 'individual';
export type TaxRegime = 'reel' | 'simplifie';

/** Taux en points de base (3000 = 30 %), hors centimes additionnels communaux (CAC). */
export interface TaxRates {
  /** Impôt sur les sociétés, taux normal. */
  isRate: number;
  /** Taux réduit des sociétés dont le chiffre d'affaires ne dépasse pas le seuil. */
  reducedRate: number;
  /** Minimum de perception (acompte mensuel) sur le chiffre d'affaires HT. */
  minimumRate: number;
}

/**
 * Taux par défaut (Code général des impôts du Cameroun) : IS 30 %, 25 % jusqu'à 3 milliards de
 * chiffre d'affaires ; minimum de perception 2 % au réel, 5 % au simplifié ; CAC 10 % de l'impôt ;
 * IRPP des bénéfices industriels et commerciaux au barème. Modifiables exercice par exercice.
 */
export const TAX_DEFAULTS = {
  isRate: 3000,
  reducedRate: 2500,
  reducedThreshold: 3_000_000_000,
  cacRate: 1000,
  minimumRate: { reel: 200, simplifie: 500 } as Record<TaxRegime, number>,
  /** Barème annuel de l'IRPP : [plafond de la tranche, taux en points de base]. */
  irppBrackets: [
    [2_000_000, 1000],
    [3_000_000, 1500],
    [5_000_000, 2500],
    [Infinity, 3500],
  ] as [number, number][],
  /** Durée de report des déficits (exercices). */
  lossCarryYears: 4,
};

export interface TaxAdjustment {
  kind: 'add' | 'deduct';
  label: string;
  amount: Fcfa;
}

export interface TaxSettings {
  year: number;
  form: TaxForm;
  regime: TaxRegime;
  rates: TaxRates;
  adjustments: TaxAdjustment[];
  priorLosses: Fcfa;
}

export interface Instalment {
  month: string;
  turnoverHt: Fcfa;
  rate: number;
  principal: Fcfa;
  cac: Fcfa;
  total: Fcfa;
}

export interface TaxAssessment {
  settings: TaxSettings;
  from: string;
  to: string;
  /** Exercice pas encore clos : le calcul est provisoire. */
  provisional: boolean;
  turnoverHt: Fcfa;
  /** Résultat net comptable, impôt sur le résultat déjà passé (89) rajouté. */
  resultBeforeTax: Fcfa;
  bookedTax: Fcfa;
  additions: Fcfa;
  deductions: Fcfa;
  /** Résultat fiscal avant imputation des déficits antérieurs. */
  fiscalResult: Fcfa;
  lossesUsed: Fcfa;
  taxableIncome: Fcfa;
  /** Déficit reportable sur les exercices suivants. */
  lossCarriedForward: Fcfa;
  /** Taux appliqué (IS) ou taux moyen (barème IRPP), en points de base. */
  rateApplied: number;
  tax: { principal: Fcfa; cac: Fcfa; total: Fcfa };
  instalments: Instalment[];
  minimum: Fcfa;
  /** Impôt dû : le plus élevé de l'impôt calculé et du minimum de perception. */
  due: Fcfa;
  /** Reste à payer après les acomptes mensuels. */
  balance: Fcfa;
  /** Écriture à passer pour constater l'impôt de l'exercice (différence avec ce qui est déjà en 89). */
  toBook: Fcfa;
}

interface Row {
  id: string;
  store_id: string;
  year: number;
  form: TaxForm;
  regime: TaxRegime;
  rates: string;
  adjustments: string;
  prior_losses: number;
  updated_at: string;
}

const pct = (amount: number, bp: number) => Math.round((amount * bp) / 10_000);

/**
 * Impôt sur le résultat : acompte mensuel (minimum de perception sur le chiffre d'affaires HT)
 * et liquidation annuelle (IS des sociétés ou IRPP de l'entrepreneur individuel), à partir du
 * résultat comptable, des réintégrations et déductions saisies, et des déficits antérieurs.
 */
export class TaxService extends Base {
  constructor(
    db: ConstructorParameters<typeof Base>[0],
    clock: ConstructorParameters<typeof Base>[1],
    private readonly accounting: AccountingService,
    private readonly statements: FinancialStatementsService,
  ) {
    super(db, clock);
  }

  settings(storeId: string, year: number): TaxSettings {
    const row = this.db.prepare('SELECT * FROM tax_years WHERE store_id = ? AND year = ?').get(storeId, year) as Row | undefined;
    const regime = row?.regime ?? 'reel';
    const rates = { ...(row ? (JSON.parse(row.rates) as Partial<TaxRates>) : {}) };
    return {
      year,
      form: row?.form ?? 'company',
      regime,
      rates: {
        isRate: rates.isRate ?? TAX_DEFAULTS.isRate,
        reducedRate: rates.reducedRate ?? TAX_DEFAULTS.reducedRate,
        minimumRate: rates.minimumRate ?? TAX_DEFAULTS.minimumRate[regime],
      },
      adjustments: row ? (JSON.parse(row.adjustments) as TaxAdjustment[]) : [],
      priorLosses: row?.prior_losses ?? 0,
    };
  }

  saveSettings(ctx: Context, year: number, input: Partial<Omit<TaxSettings, 'year' | 'rates'>> & { rates?: Partial<TaxRates> }): TaxSettings {
    if (!Number.isInteger(year) || year < 2000 || year > 2100) throw new AppError('Exercice invalide', 'INVALID');
    const cur = this.settings(ctx.storeId, year);
    const form = input.form ?? cur.form;
    const regime = input.regime ?? cur.regime;
    if (!['company', 'individual'].includes(form) || !['reel', 'simplifie'].includes(regime)) throw new AppError('Forme ou régime inconnu', 'INVALID');
    // Les taux saisis ne sont gardés que s'ils diffèrent du CGI : un changement de régime reprend le bon minimum.
    const stored = this.db.prepare('SELECT rates FROM tax_years WHERE store_id = ? AND year = ?').pluck().get(ctx.storeId, year) as string | undefined;
    const rates: Partial<TaxRates> = { ...(stored ? JSON.parse(stored) : {}), ...input.rates };
    for (const [k, v] of Object.entries(rates)) {
      if (v === undefined || v === null) delete rates[k as keyof TaxRates];
      else if (!Number.isInteger(v) || v < 0 || v > 10_000) throw new AppError('Taux invalide', 'INVALID');
    }
    if (rates.isRate === TAX_DEFAULTS.isRate) delete rates.isRate;
    if (rates.reducedRate === TAX_DEFAULTS.reducedRate) delete rates.reducedRate;
    if (rates.minimumRate === TAX_DEFAULTS.minimumRate[regime]) delete rates.minimumRate;
    const adjustments = (input.adjustments ?? cur.adjustments).map((a) => ({ kind: a.kind, label: a.label.trim(), amount: a.amount }));
    for (const a of adjustments) {
      if (!['add', 'deduct'].includes(a.kind) || !a.label) throw new AppError('Chaque réintégration ou déduction a un libellé', 'INVALID');
      if (!Number.isSafeInteger(a.amount) || a.amount <= 0) throw new AppError('Montant de réintégration ou de déduction invalide', 'INVALID');
    }
    const priorLosses = input.priorLosses ?? cur.priorLosses;
    if (!Number.isSafeInteger(priorLosses) || priorLosses < 0) throw new AppError('Déficit antérieur invalide', 'INVALID');
    const id = `${ctx.storeId}:${year}`;
    this.db
      .prepare(
        `INSERT INTO tax_years (id, store_id, year, form, regime, rates, adjustments, prior_losses, user_id, updated_at)
         VALUES (@id, @store, @year, @form, @regime, @rates, @adjustments, @losses, @user, @now)
         ON CONFLICT(id) DO UPDATE SET form = excluded.form, regime = excluded.regime, rates = excluded.rates,
           adjustments = excluded.adjustments, prior_losses = excluded.prior_losses, user_id = excluded.user_id, updated_at = excluded.updated_at`,
      )
      .run({ id, store: ctx.storeId, year, form, regime, rates: JSON.stringify(rates), adjustments: JSON.stringify(adjustments), losses: priorLosses, user: ctx.userId, now: this.now() });
    this.enqueue(ctx, 'tax_year', id, 'upsert', {});
    this.audit(ctx.userId, 'tax.settings', 'tax_year', id, { form, regime, priorLosses });
    return this.settings(ctx.storeId, year);
  }

  /** Acompte du mois (minimum de perception) : pourcentage du chiffre d'affaires HT, plus les CAC. */
  instalment(storeId: string, month: string): Instalment {
    if (!/^\d{4}-\d{2}$/.test(month)) throw new AppError('Mois invalide (AAAA-MM)', 'INVALID');
    const rate = this.settings(storeId, Number(month.slice(0, 4))).rates.minimumRate;
    const turnoverHt = this.accounting.vatReturn(storeId, month).turnoverHt;
    const principal = pct(turnoverHt, rate);
    const cac = pct(principal, TAX_DEFAULTS.cacRate);
    return { month, turnoverHt, rate, principal, cac, total: principal + cac };
  }

  assessment(storeId: string, year: number): TaxAssessment {
    const settings = this.settings(storeId, year);
    const from = `${year}-01-01`;
    const to = `${year}-12-31`;
    const today = this.today();
    const provisional = today <= to;
    const lastMonth = provisional ? today.slice(0, 7) : `${year}-12`;
    const instalments: Instalment[] = [];
    for (let m = 1; m <= 12; m++) {
      const month = `${year}-${String(m).padStart(2, '0')}`;
      if (month > lastMonth) break;
      instalments.push(this.instalment(storeId, month));
    }
    const turnoverHt = instalments.reduce((t, i) => t + i.turnoverHt, 0);
    const minimum = instalments.reduce((t, i) => t + i.total, 0);

    const st = this.statements.statements(storeId, { from, to });
    const bookedTax = st.income.find((l) => l.ref === 'RS')!.net;
    const resultBeforeTax = st.result + bookedTax;
    const additions = settings.adjustments.filter((a) => a.kind === 'add').reduce((t, a) => t + a.amount, 0);
    const deductions = settings.adjustments.filter((a) => a.kind === 'deduct').reduce((t, a) => t + a.amount, 0);
    const fiscalResult = resultBeforeTax + additions - deductions;
    const lossesUsed = Math.min(settings.priorLosses, Math.max(fiscalResult, 0));
    const taxableIncome = Math.max(fiscalResult - lossesUsed, 0);
    const lossCarriedForward = fiscalResult < 0 ? -fiscalResult : 0;

    let principal: number;
    let rateApplied: number;
    if (settings.form === 'company') {
      rateApplied = turnoverHt <= TAX_DEFAULTS.reducedThreshold ? settings.rates.reducedRate : settings.rates.isRate;
      principal = pct(taxableIncome, rateApplied);
    } else {
      principal = 0;
      let floor = 0;
      for (const [ceiling, bp] of TAX_DEFAULTS.irppBrackets) {
        if (taxableIncome <= floor) break;
        principal += pct(Math.min(taxableIncome, ceiling) - floor, bp);
        floor = ceiling;
      }
      rateApplied = taxableIncome ? Math.round((principal * 10_000) / taxableIncome) : 0;
    }
    const cac = pct(principal, TAX_DEFAULTS.cacRate);
    const total = principal + cac;
    const due = Math.max(total, minimum);
    return {
      settings,
      from,
      to,
      provisional,
      turnoverHt,
      resultBeforeTax,
      bookedTax,
      additions,
      deductions,
      fiscalResult,
      lossesUsed,
      taxableIncome,
      lossCarriedForward,
      rateApplied,
      tax: { principal, cac, total },
      instalments,
      minimum,
      due,
      balance: due - minimum,
      toBook: due - bookedTax,
    };
  }

  /**
   * Constate l'impôt de l'exercice : débit 891, crédit 441, au 31 décembre, pour la différence avec
   * ce qui est déjà passé. Les acomptes payés se passent au débit du 441 (journal de banque).
   */
  book(ctx: Context, year: number): Fcfa {
    const a = this.assessment(ctx.storeId, year);
    if (a.provisional) throw new AppError("L'impôt se constate une fois l'exercice clos", 'INVALID');
    if (!a.toBook) throw new AppError("L'impôt de l'exercice est déjà passé en comptabilité", 'INVALID');
    const v = Math.abs(a.toBook);
    const label = `${a.settings.form === 'company' ? 'Impôt sur les sociétés' : 'IRPP, bénéfices industriels et commerciaux'} ${year}`;
    this.accounting.addManualEntry(ctx, {
      journal: 'OD',
      date: a.to,
      label: a.toBook > 0 ? label : `${label} (régularisation)`,
      lines:
        a.toBook > 0
          ? [
              { account: '891', debit: v, credit: 0 },
              { account: '441', debit: 0, credit: v },
            ]
          : [
              { account: '441', debit: v, credit: 0 },
              { account: '891', debit: 0, credit: v },
            ],
    });
    return a.toBook;
  }
}
