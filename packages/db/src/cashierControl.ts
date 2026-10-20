import type { Fcfa } from '@superette/core';
import { AppError, Base } from './util';

/** Gestes suivis pour chaque caissier. */
export type RiskKind = 'cancellations' | 'returns' | 'returns_without_ticket' | 'discounts' | 'prices' | 'drawer' | 'hidden' | 'shortage';

export const RISK_LABELS: Record<RiskKind, string> = {
  cancellations: 'Tickets annulés',
  returns: 'Retours clients',
  returns_without_ticket: 'Retours sans ticket d’origine',
  discounts: 'Remises accordées',
  prices: 'Prix modifiés à la caisse',
  drawer: 'Tiroir ouvert sans vente',
  hidden: 'Factures supprimées du registre',
  shortage: 'Manquants de caisse',
};

export interface RiskMetric {
  count: number;
  amount: Fcfa;
}

/** Contrôle d'un caissier sur la période. */
export interface CashierControlRow {
  user_id: string;
  name: string;
  role: string;
  tickets: number;
  sales: Fcfa;
  metrics: Record<RiskKind, RiskMetric>;
  /** Gestes nettement au-dessus de la moyenne de l'équipe (ou manquant important). */
  flags: RiskKind[];
  /** Note de 0 (rien à signaler) à 100. */
  score: number;
}

/** Un geste précis, pour vérifier : numéro, montant, motif. */
export interface RiskEvent {
  kind: RiskKind;
  at: string;
  number: string | null;
  amount: Fcfa;
  detail: string | null;
}

const KINDS = Object.keys(RISK_LABELS) as RiskKind[];
const empty = (): Record<RiskKind, RiskMetric> => Object.fromEntries(KINDS.map((k) => [k, { count: 0, amount: 0 }])) as Record<RiskKind, RiskMetric>;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Contrôle des caissiers : pour chacun, les gestes qui font perdre de
 * l'argent quand ils sont abusés (annulations, retours, remises, prix
 * modifiés, tiroir ouvert sans vente, factures supprimées, manquants), comparés
 * à la moyenne de l'équipe. Les ventes viennent de tous les PC du magasin ;
 * les ouvertures de tiroir et les prix modifiés sont ceux de ce PC.
 */
export class CashierControlService extends Base {
  report(storeId: string, from: string, to: string): CashierControlRow[] {
    if (!DAY.test(from) || !DAY.test(to) || to < from) throw new AppError('Période invalide', 'INVALID');
    const users = this.db
      .prepare("SELECT id, name, role FROM users WHERE deleted_at IS NULL AND role <> 'admin' AND (store_id = ? OR store_id IS NULL) ORDER BY name")
      .all(storeId) as { id: string; name: string; role: string }[];
    const rows = new Map<string, CashierControlRow>(users.map((u) => [u.id, { user_id: u.id, name: u.name, role: u.role, tickets: 0, sales: 0, metrics: empty(), flags: [], score: 0 }]));
    const p = { storeId, from, to };
    const range = "date(s.created_at, 'localtime') BETWEEN @from AND @to";
    const add = (userId: string, kind: RiskKind, count: number, amount: number) => {
      const r = rows.get(userId);
      if (!r) return;
      r.metrics[kind].count += count;
      r.metrics[kind].amount += amount;
    };
    for (const s of this.db
      .prepare(
        `SELECT s.user_id, COUNT(*) AS n, COALESCE(SUM(s.total_ttc), 0) AS total, COALESCE(SUM(CASE WHEN s.total_discount - s.rounding - s.total_promo > 0 THEN 1 ELSE 0 END), 0) AS disc_n,
                COALESCE(SUM(MAX(s.total_discount - s.rounding - s.total_promo, 0)), 0) AS disc
         FROM sales s WHERE s.store_id = @storeId AND s.kind = 'sale' AND s.status = 'completed' AND ${range} GROUP BY s.user_id`,
      )
      .all(p) as { user_id: string; n: number; total: number; disc_n: number; disc: number }[]) {
      const r = rows.get(s.user_id);
      if (!r) continue;
      r.tickets = s.n;
      r.sales = s.total;
      add(s.user_id, 'discounts', s.disc_n, s.disc);
    }
    for (const s of this.db
      .prepare(`SELECT s.user_id, COUNT(*) AS n, COALESCE(SUM(s.total_ttc), 0) AS total FROM sales s WHERE s.store_id = @storeId AND s.kind = 'sale' AND s.status = 'cancelled' AND ${range} GROUP BY s.user_id`)
      .all(p) as { user_id: string; n: number; total: number }[])
      add(s.user_id, 'cancellations', s.n, s.total);
    for (const s of this.db
      .prepare(
        `SELECT s.user_id, COUNT(*) AS n, COALESCE(SUM(-s.total_ttc), 0) AS total, COALESCE(SUM(CASE WHEN s.original_sale_id IS NULL THEN 1 ELSE 0 END), 0) AS free_n,
                COALESCE(SUM(CASE WHEN s.original_sale_id IS NULL THEN -s.total_ttc ELSE 0 END), 0) AS free
         FROM sales s WHERE s.store_id = @storeId AND s.kind = 'return' AND s.status = 'completed' AND ${range} GROUP BY s.user_id`,
      )
      .all(p) as { user_id: string; n: number; total: number; free_n: number; free: number }[]) {
      add(s.user_id, 'returns', s.n, Math.abs(s.total));
      add(s.user_id, 'returns_without_ticket', s.free_n, Math.abs(s.free));
    }
    // Journal d'audit de ce PC : prix modifiés, tiroir ouvert sans vente, factures supprimées.
    const audit = this.db
      .prepare(
        `SELECT user_id, action, details FROM audit_log WHERE action IN ('sale.price_set', 'drawer.open', 'sale.hide') AND date(at, 'localtime') BETWEEN @from AND @to`,
      )
      .all(p) as { user_id: string | null; action: string; details: string | null }[];
    for (const a of audit) {
      if (!a.user_id) continue;
      const kind: RiskKind = a.action === 'drawer.open' ? 'drawer' : a.action === 'sale.hide' ? 'hidden' : 'prices';
      add(a.user_id, kind, 1, 0);
    }
    // Manquants : écart de chaque relève au caissier qui part, le reste de la journée à celui qui clôture.
    const sessions = this.db
      .prepare(
        `SELECT s.id, s.closed_by, s.user_id, s.difference FROM cash_sessions s
         WHERE s.store_id = @storeId AND s.status = 'closed' AND s.difference IS NOT NULL AND date(s.closed_at, 'localtime') BETWEEN @from AND @to`,
      )
      .all(p) as { id: string; closed_by: string | null; user_id: string; difference: number }[];
    const handovers = this.db.prepare('SELECT from_user, difference FROM cash_handovers WHERE session_id = ?');
    for (const se of sessions) {
      const hs = handovers.all(se.id) as { from_user: string; difference: number }[];
      for (const h of hs) if (h.difference < 0) add(h.from_user, 'shortage', 1, -h.difference);
      const rest = se.difference - hs.reduce((t, h) => t + h.difference, 0);
      if (rest < 0) add(se.closed_by ?? se.user_id, 'shortage', 1, -rest);
    }
    const list = [...rows.values()].filter((r) => r.tickets > 0 || KINDS.some((k) => r.metrics[k].count > 0));
    // Comparaison à l'équipe : gestes rapportés au nombre de tickets.
    const active = list.filter((r) => r.tickets > 0);
    for (const k of KINDS) {
      const totalCount = active.reduce((t, r) => t + r.metrics[k].count, 0);
      const totalTickets = active.reduce((t, r) => t + r.tickets, 0);
      const teamRate = totalTickets ? totalCount / totalTickets : 0;
      for (const r of list) {
        const m = r.metrics[k];
        if (m.count < 3 && !(k === 'shortage' && m.amount >= 5_000)) continue;
        const rate = r.tickets ? m.count / r.tickets : 1;
        if (active.length < 2 || rate > teamRate * 2 || (k === 'shortage' && m.amount >= 5_000)) r.flags.push(k);
      }
    }
    for (const r of list) {
      const discountShare = r.sales ? r.metrics.discounts.amount / r.sales : 0;
      const raw = r.flags.length * 20 + Math.min(20, Math.round(discountShare * 400)) + Math.min(20, Math.round(r.metrics.shortage.amount / 1_000));
      r.score = Math.min(100, raw);
    }
    return list.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  }

  /** Gestes d'un caissier sur la période, pour vérifier ticket par ticket. */
  events(storeId: string, userId: string, from: string, to: string): RiskEvent[] {
    if (!DAY.test(from) || !DAY.test(to)) throw new AppError('Période invalide', 'INVALID');
    const p = { storeId, userId, from, to };
    const range = "date(s.created_at, 'localtime') BETWEEN @from AND @to";
    const out: RiskEvent[] = [
      ...(
        this.db
          .prepare(`SELECT s.created_at AS at, s.number, s.total_ttc AS amount, s.cancel_reason AS detail FROM sales s WHERE s.store_id = @storeId AND s.user_id = @userId AND s.kind = 'sale' AND s.status = 'cancelled' AND ${range}`)
          .all(p) as Omit<RiskEvent, 'kind'>[]
      ).map((e) => ({ ...e, kind: 'cancellations' as const })),
      ...(
        this.db
          .prepare(
            `SELECT s.created_at AS at, s.number, -s.total_ttc AS amount, CASE WHEN s.original_sale_id IS NULL THEN 'sans ticket' ELSE o.number END AS detail, s.original_sale_id IS NULL AS free
             FROM sales s LEFT JOIN sales o ON o.id = s.original_sale_id WHERE s.store_id = @storeId AND s.user_id = @userId AND s.kind = 'return' AND s.status = 'completed' AND ${range}`,
          )
          .all(p) as (Omit<RiskEvent, 'kind'> & { free: number })[]
      ).map(({ free, ...e }) => ({ ...e, amount: Math.abs(e.amount), kind: free ? ('returns_without_ticket' as const) : ('returns' as const) })),
      ...(
        this.db
          .prepare(
            `SELECT s.created_at AS at, s.number, s.total_discount - s.rounding - s.total_promo AS amount, NULL AS detail FROM sales s
             WHERE s.store_id = @storeId AND s.user_id = @userId AND s.kind = 'sale' AND s.status = 'completed' AND s.total_discount - s.rounding - s.total_promo > 0 AND ${range}`,
          )
          .all(p) as Omit<RiskEvent, 'kind'>[]
      ).map((e) => ({ ...e, kind: 'discounts' as const })),
      ...(
        this.db
          .prepare(`SELECT at, action, details FROM audit_log WHERE user_id = @userId AND action IN ('sale.price_set', 'drawer.open', 'sale.hide') AND date(at, 'localtime') BETWEEN @from AND @to`)
          .all(p) as { at: string; action: string; details: string | null }[]
      ).map((a) => ({
        kind: (a.action === 'drawer.open' ? 'drawer' : a.action === 'sale.hide' ? 'hidden' : 'prices') as RiskKind,
        at: a.at,
        number: null,
        amount: 0,
        detail: a.details,
      })),
    ];
    return out.sort((a, b) => b.at.localeCompare(a.at));
  }
}
