import type { Fcfa } from '@superette/core';
import { DELIVERY_FEE_ARTICLE_ID } from './deliveries';
import { AppError, Base, type Context } from './util';

/** Objectif et commission d'un collaborateur (un réglage par collaborateur, valable tous les mois). */
export interface SalesTarget {
  /** Identifiant du collaborateur. */
  id: string;
  store_id: string;
  month_target: Fcfa;
  day_target: Fcfa;
  /** Commission en points de base (150 = 1,5 %) sur les ventes du mois. */
  rate_bp: number;
  /** Taux propre à certaines familles d'articles : {"<famille>": 300}. */
  family_rates: string | null;
  updated_at: string;
}

export interface SalesTargetInput {
  monthTarget: Fcfa;
  dayTarget: Fcfa;
  rateBp: number;
  familyRates?: Record<string, number>;
}

/** Ligne de l'état des objectifs : un collaborateur relié à un utilisateur qui vend. */
export interface TargetRow {
  staff_id: string;
  staff_name: string;
  position: string | null;
  user_id: string | null;
  user_name: string | null;
  month_target: Fcfa;
  day_target: Fcfa;
  rate_bp: number;
  family_rates: Record<string, number>;
  /** Ventes du mois moins les retours (frais de livraison exclus). */
  month_sales: Fcfa;
  /** Ventes du jour (aujourd'hui, ou le dernier jour du mois passé). */
  day_sales: Fcfa;
  tickets: number;
  /** Part de l'objectif du mois atteinte, en pour cent (null sans objectif). */
  month_rate: number | null;
  day_rate: number | null;
  commission: Fcfa;
}

/**
 * Objectifs de vente et commissions des vendeurs. Les ventes d'un collaborateur
 * sont celles faites sous son compte utilisateur (fiche collaborateur › utilisateur) :
 * ventes validées, au comptant ou à crédit, moins ses retours. La commission du mois
 * s'ajoute au brut du salaire dans Salaires du mois.
 */
export class CommissionService extends Base {
  setTarget(ctx: Context, staffId: string, input: SalesTargetInput): SalesTarget {
    const staff = this.db.prepare('SELECT store_id FROM staff WHERE id = ?').get(staffId) as { store_id: string } | undefined;
    if (!staff || staff.store_id !== ctx.storeId) throw new AppError('Collaborateur introuvable', 'NOT_FOUND');
    const amounts = [input.monthTarget, input.dayTarget];
    if (amounts.some((a) => !Number.isSafeInteger(a) || a < 0)) throw new AppError('Objectif invalide', 'INVALID');
    const rates = { '': input.rateBp, ...(input.familyRates ?? {}) };
    if (Object.values(rates).some((r) => !Number.isInteger(r) || r < 0 || r > 5_000)) throw new AppError('Taux de commission invalide (0 à 50 %)', 'INVALID');
    const families = Object.keys(input.familyRates ?? {});
    for (const f of families) {
      if (!this.db.prepare('SELECT 1 FROM families WHERE id = ?').pluck().get(f)) throw new AppError('Famille introuvable', 'NOT_FOUND');
    }
    const row = {
      id: staffId,
      store_id: ctx.storeId,
      month_target: input.monthTarget,
      day_target: input.dayTarget,
      rate_bp: input.rateBp,
      family_rates: families.length ? JSON.stringify(input.familyRates) : null,
      updated_at: this.now(),
    };
    this.tx(() => {
      this.db
        .prepare(
          `INSERT INTO sales_targets (id, store_id, month_target, day_target, rate_bp, family_rates, updated_at)
           VALUES (@id, @store_id, @month_target, @day_target, @rate_bp, @family_rates, @updated_at)
           ON CONFLICT(id) DO UPDATE SET month_target = excluded.month_target, day_target = excluded.day_target, rate_bp = excluded.rate_bp,
             family_rates = excluded.family_rates, updated_at = excluded.updated_at`,
        )
        .run(row);
      this.enqueue(ctx, 'sales_target', staffId, 'upsert', {});
      this.audit(ctx.userId, 'staff.target', 'staff', staffId, { month: input.monthTarget, day: input.dayTarget, rate: input.rateBp, families: input.familyRates ?? {} });
    });
    return row;
  }

  /** État du mois (AAAA-MM) : chaque collaborateur actif relié à un utilisateur, ou qui a un objectif. */
  month(storeId: string, period: string): TargetRow[] {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) throw new AppError('Mois invalide (AAAA-MM)', 'INVALID');
    const today = this.today();
    const day = today.startsWith(period) ? today : lastDayOf(period);
    const staff = this.db
      .prepare(
        `SELECT st.id, st.name, st.position, st.user_id, u.name AS user_name, t.month_target, t.day_target, t.rate_bp, t.family_rates
         FROM staff st LEFT JOIN users u ON u.id = st.user_id LEFT JOIN sales_targets t ON t.id = st.id
         WHERE st.store_id = ? AND st.active = 1 AND (st.user_id IS NOT NULL OR t.id IS NOT NULL) ORDER BY st.name`,
      )
      .all(storeId) as {
      id: string;
      name: string;
      position: string | null;
      user_id: string | null;
      user_name: string | null;
      month_target: Fcfa | null;
      day_target: Fcfa | null;
      rate_bp: number | null;
      family_rates: string | null;
    }[];
    // Les lignes d'un retour portent des montants négatifs : elles se déduisent d'elles-mêmes.
    const lines = this.db.prepare(
      `SELECT a.family_id, date(s.created_at, 'localtime') AS day,
              SUM(l.total_ttc) AS amount
       FROM sale_lines l JOIN sales s ON s.id = l.sale_id JOIN articles a ON a.id = l.article_id
       WHERE s.store_id = @storeId AND s.user_id = @userId AND s.status = 'completed' AND l.article_id <> @fee
         AND strftime('%Y-%m', s.created_at, 'localtime') = @period
       GROUP BY a.family_id, day`,
    );
    return staff.map((st) => {
      const familyRates = st.family_rates ? (JSON.parse(st.family_rates) as Record<string, number>) : {};
      const rows = st.user_id
        ? (lines.all({ storeId, userId: st.user_id, fee: DELIVERY_FEE_ARTICLE_ID, period }) as { family_id: string | null; day: string; amount: Fcfa }[])
        : [];
      const monthSales = rows.reduce((t, r) => t + r.amount, 0);
      const daySales = rows.filter((r) => r.day === day).reduce((t, r) => t + r.amount, 0);
      const commission = Math.max(
        0,
        Math.round(rows.reduce((t, r) => t + (r.amount * (familyRates[r.family_id ?? ''] ?? st.rate_bp ?? 0)) / 10_000, 0)),
      );
      const monthTarget = st.month_target ?? 0;
      const dayTarget = st.day_target ?? 0;
      return {
        staff_id: st.id,
        staff_name: st.name,
        position: st.position,
        user_id: st.user_id,
        user_name: st.user_name,
        month_target: monthTarget,
        day_target: dayTarget,
        rate_bp: st.rate_bp ?? 0,
        family_rates: familyRates,
        month_sales: monthSales,
        day_sales: daySales,
        tickets: this.db
          .prepare(
            `SELECT COUNT(*) FROM sales WHERE store_id = ? AND user_id = ? AND kind = 'sale' AND status = 'completed' AND strftime('%Y-%m', created_at, 'localtime') = ?`,
          )
          .pluck()
          .get(storeId, st.user_id ?? '', period) as number,
        month_rate: monthTarget > 0 ? Math.round((monthSales * 1000) / monthTarget) / 10 : null,
        day_rate: dayTarget > 0 ? Math.round((daySales * 1000) / dayTarget) / 10 : null,
        commission,
      };
    });
  }

  /**
   * « Ma journée » du vendeur ou du caissier : ses propres ventes du jour,
   * ses tickets, son objectif et sa commission du mois, ses commandes en cours.
   */
  myDay(storeId: string, userId: string) {
    const today = this.today();
    const sums = this.db
      .prepare(
        `SELECT COALESCE(SUM(CASE WHEN kind = 'sale' THEN total_ttc ELSE 0 END), 0) AS sales,
                COALESCE(SUM(CASE WHEN kind <> 'sale' THEN -ABS(total_ttc) ELSE 0 END), 0) AS returns,
                COALESCE(SUM(CASE WHEN kind = 'sale' THEN 1 ELSE 0 END), 0) AS tickets
         FROM sales WHERE store_id = ? AND user_id = ? AND status = 'completed' AND date(created_at, 'localtime') = ?`,
      )
      .get(storeId, userId, today) as { sales: Fcfa; returns: Fcfa; tickets: number };
    const staffId = this.db.prepare('SELECT id FROM staff WHERE user_id = ? AND active = 1').pluck().get(userId) as string | undefined;
    const target = staffId ? (this.month(storeId, today.slice(0, 7)).find((r) => r.staff_id === staffId) ?? null) : null;
    const orders = this.db
      .prepare("SELECT COUNT(*) FROM customer_orders WHERE store_id = ? AND user_id = ? AND status IN ('new', 'prepared')")
      .pluck()
      .get(storeId, userId) as number;
    return {
      day: today,
      sales: sums.sales,
      returns: sums.returns,
      net: sums.sales + sums.returns,
      tickets: sums.tickets,
      average: sums.tickets ? Math.round(sums.sales / sums.tickets) : 0,
      target: target && {
        month_target: target.month_target,
        day_target: target.day_target,
        month_sales: target.month_sales,
        day_sales: target.day_sales,
        month_rate: target.month_rate,
        day_rate: target.day_rate,
        commission: target.commission,
      },
      open_orders: orders,
    };
  }

  /** Commission du mois de chaque collaborateur, pour la feuille des salaires. */
  commissions(storeId: string, period: string): Record<string, Fcfa> {
    return Object.fromEntries(this.month(storeId, period).filter((r) => r.commission > 0).map((r) => [r.staff_id, r.commission]));
  }
}

function lastDayOf(period: string): string {
  const [y, m] = period.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m, 0));
  return d.toISOString().slice(0, 10);
}
