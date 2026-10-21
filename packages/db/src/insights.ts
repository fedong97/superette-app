import type { Fcfa, Milli } from '@superette/core';
import type { CashierControlService } from './cashierControl';
import type { CatalogueService } from './catalogue';
import type { CompanyService } from './companies';
import type { Db } from './database';
import { AppError, Base, type Clock } from './util';

/** Article dont le prix d'achat a monté sans que le prix de vente bouge. */
export interface PriceReviewRow {
  article_id: string;
  code: string;
  name: string;
  department_name: string | null;
  /** Prix de vente TTC actuel (à l'unité). */
  sale_price: Fcfa;
  vat_rate_bp: number;
  /** Coût d'achat HT avant la hausse et après. */
  prev_cost: Fcfa;
  last_cost: Fcfa;
  /** Date de la réception qui a porté la hausse. */
  raised_at: string;
  supplier_name: string | null;
  /** Taux de marque (sur le prix HT) avant et maintenant, en %. */
  prev_rate: number;
  rate: number;
  /** Marge perdue par unité et sur les 30 derniers jours de ventes. */
  lost_per_unit: Fcfa;
  sold_30d: Milli;
  lost_30d: Fcfa;
  /** Prix TTC qui retrouve le taux de marque d'avant (arrondi à 5 FCFA). */
  suggested_price: Fcfa;
}

/** Une ligne du tableau de l'équipe sur la semaine. */
export interface TeamRow {
  user_id: string;
  name: string;
  role: string;
  /** Comme caissier : tickets encaissés et montant. */
  tickets: number;
  sales: Fcfa;
  average: Fcfa;
  cancellations: number;
  cancellations_amount: Fcfa;
  discounts: number;
  discounts_amount: Fcfa;
  returns: number;
  /** Manquants de caisse (écarts négatifs à la clôture ou à la relève). */
  shortage: Fcfa;
  /** Temps moyen entre deux tickets, hors pauses de plus de 15 minutes (secondes). */
  seconds_per_ticket: number | null;
  /** Comme vendeur : ventes faites (le vendeur de la fiche). */
  seller_tickets: number;
  seller_sales: Fcfa;
  seller_average: Fcfa;
}

export interface MonthFigures {
  month: string;
  sales_ttc: Fcfa;
  sales_ht: Fcfa;
  tickets: number;
  margin: Fcfa;
  margin_rate: number;
  expenses: Fcfa;
  stock: Fcfa;
  receivables: Fcfa;
  treasury: Fcfa;
  payables: Fcfa;
}

/** Rapport mensuel pour le propriétaire : le mois et celui d'avant. */
export interface OwnerReport {
  store: { name: string; address: string | null; phone: string | null };
  current: MonthFigures;
  previous: MonthFigures;
  /** Rayons qui font la marge du mois. */
  departments: { name: string; sales_ht: Fcfa; margin: Fcfa }[];
  /** Texte court pour WhatsApp. */
  text: string;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MONTH = /^\d{4}-\d{2}$/;
const round5 = (v: number) => Math.round(v / 5) * 5;

/**
 * Tableaux du gérant : prix à revoir après une hausse du fournisseur,
 * tableau de l'équipe sur la semaine, rapport mensuel pour le propriétaire.
 * Les chiffres sont ceux des ventes réellement enregistrées.
 */
export class InsightService extends Base {
  constructor(
    db: Db,
    clock: Clock,
    private readonly catalogue: CatalogueService,
    private readonly cashierControl: CashierControlService,
    private readonly companies: CompanyService,
  ) {
    super(db, clock);
  }

  // --- Prix à revoir -----------------------------------------------------------

  priceReview(storeId: string): PriceReviewRow[] {
    const since30 = new Date(this.clock().getTime() - 30 * 86_400_000).toISOString();
    // Les deux derniers coûts d'achat différents de chaque article, réception par réception.
    const costs = this.db
      .prepare(
        `SELECT rl.article_id, rl.unit_cost, r.received_at, s.name AS supplier_name
         FROM reception_lines rl JOIN receptions r ON r.id = rl.reception_id LEFT JOIN suppliers s ON s.id = r.supplier_id
         WHERE r.store_id = ? AND rl.unit_cost > 0 ORDER BY rl.article_id, r.received_at DESC`,
      )
      .all(storeId) as { article_id: string; unit_cost: Fcfa; received_at: string; supplier_name: string | null }[];
    // Par article : le dernier coût, la date où il est apparu (la hausse) et le coût d'avant.
    const pairs = new Map<string, { last: (typeof costs)[number]; prev: (typeof costs)[number] }>();
    const current = new Map<string, (typeof costs)[number]>();
    for (const c of costs) {
      if (pairs.has(c.article_id)) continue;
      const last = current.get(c.article_id);
      if (!last) current.set(c.article_id, c);
      else if (c.unit_cost === last.unit_cost) current.set(c.article_id, { ...last, received_at: c.received_at });
      else pairs.set(c.article_id, { last, prev: c });
    }
    const lastChange = this.db.prepare('SELECT MAX(at) FROM price_history WHERE article_id = ? AND (store_id IS NULL OR store_id = ?)').pluck();
    const sold = this.db.prepare(
      `SELECT COALESCE(-SUM(m.qty), 0) FROM stock_movements m JOIN warehouses w ON w.id = m.warehouse_id
       WHERE m.article_id = ? AND w.store_id = ? AND m.type IN ('SALE', 'RETURN') AND m.at >= ?`,
    ).pluck();
    const out: PriceReviewRow[] = [];
    for (const [articleId, { last, prev }] of pairs) {
      if (last.unit_cost <= prev.unit_cost) continue;
      // Le prix de vente a-t-il bougé depuis la hausse ? Alors l'article est déjà revu.
      const changed = lastChange.get(articleId, storeId) as string | null;
      if (changed && changed >= last.received_at) continue;
      let a;
      try {
        a = this.catalogue.getArticle(articleId, storeId);
      } catch {
        continue;
      }
      if (!a.active || a.store_price <= 0) continue;
      const ht = Math.round((a.store_price * 10000) / (10000 + a.vat_rate_bp));
      const prevRate = ht > 0 ? (ht - prev.unit_cost) / ht : 0;
      const rate = ht > 0 ? (ht - last.unit_cost) / ht : 0;
      if (prevRate <= 0) continue;
      const lost = last.unit_cost - prev.unit_cost;
      const qty = Math.max(0, sold.get(articleId, storeId, since30) as number);
      const suggestedHt = last.unit_cost / (1 - prevRate);
      const suggested = round5((suggestedHt * (10000 + a.vat_rate_bp)) / 10000);
      if (suggested <= a.store_price) continue;
      out.push({
        article_id: a.id,
        code: a.code,
        name: a.name,
        department_name: a.department_name,
        sale_price: a.store_price,
        vat_rate_bp: a.vat_rate_bp,
        prev_cost: prev.unit_cost,
        last_cost: last.unit_cost,
        raised_at: last.received_at,
        supplier_name: last.supplier_name,
        prev_rate: Math.round(prevRate * 1000) / 10,
        rate: Math.round(rate * 1000) / 10,
        lost_per_unit: lost,
        sold_30d: qty,
        lost_30d: Math.round((lost * qty) / 1000),
        suggested_price: suggested,
      });
    }
    return out.sort((a, b) => b.lost_30d - a.lost_30d || b.lost_per_unit - a.lost_per_unit);
  }

  /**
   * Applique le prix proposé : le prix de vente (et ceux des cartons, du gros)
   * montent dans la même proportion, avec l'historique des prix.
   */
  applyPriceReview(userId: string, storeId: string, articleId: string, price: Fcfa): { articles: number; lines: number } {
    const a = this.catalogue.getArticle(articleId, storeId);
    if (!Number.isSafeInteger(price) || price <= 0) throw new AppError('Prix invalide', 'INVALID');
    if (price === a.store_price) return { articles: 0, lines: 0 };
    const pct = ((price - a.store_price) / a.store_price) * 100;
    return this.catalogue.applyPriceUpdate(userId, storeId, { articleIds: [articleId], target: 'sale', method: 'percent', value: pct, packs: true, tiers: true, rounding: 5 });
  }

  // --- Tableau de l'équipe ---------------------------------------------------------

  team(storeId: string, from: string, to: string): TeamRow[] {
    if (!DAY.test(from) || !DAY.test(to) || to < from) throw new AppError('Période invalide', 'INVALID');
    const control = new Map(this.cashierControl.report(storeId, from, to).map((r) => [r.user_id, r]));
    const users = this.db
      .prepare("SELECT id, name, role FROM users WHERE deleted_at IS NULL AND role <> 'admin' AND (store_id = ? OR store_id IS NULL) ORDER BY name")
      .all(storeId) as { id: string; name: string; role: string }[];
    const range = "date(created_at, 'localtime') BETWEEN @from AND @to";
    const sellers = new Map(
      (
        this.db
          .prepare(`SELECT seller_id, COUNT(*) AS n, COALESCE(SUM(total_ttc), 0) AS total FROM sales WHERE store_id = @storeId AND kind = 'sale' AND status = 'completed' AND seller_id IS NOT NULL AND ${range} GROUP BY seller_id`)
          .all({ storeId, from, to }) as { seller_id: string; n: number; total: number }[]
      ).map((r) => [r.seller_id, r]),
    );
    const times = this.db.prepare(`SELECT created_at FROM sales WHERE store_id = @storeId AND user_id = @userId AND kind = 'sale' AND status = 'completed' AND ${range} ORDER BY created_at`);
    const out: TeamRow[] = [];
    for (const u of users) {
      const c = control.get(u.id);
      const s = sellers.get(u.id);
      if (!c?.tickets && !s?.n) continue;
      // Vitesse : écart entre deux tickets qui se suivent, hors pauses (plus de 15 minutes).
      const at = (times.all({ storeId, userId: u.id, from, to }) as { created_at: string }[]).map((r) => Date.parse(r.created_at));
      const gaps = at.slice(1).map((t, i) => (t - at[i]!) / 1000).filter((g) => g > 0 && g <= 900);
      out.push({
        user_id: u.id,
        name: u.name,
        role: u.role,
        tickets: c?.tickets ?? 0,
        sales: c?.sales ?? 0,
        average: c?.tickets ? Math.round(c.sales / c.tickets) : 0,
        cancellations: c?.metrics.cancellations.count ?? 0,
        cancellations_amount: c?.metrics.cancellations.amount ?? 0,
        discounts: c?.metrics.discounts.count ?? 0,
        discounts_amount: c?.metrics.discounts.amount ?? 0,
        returns: c?.metrics.returns.count ?? 0,
        shortage: c?.metrics.shortage.amount ?? 0,
        seconds_per_ticket: gaps.length >= 5 ? Math.round(gaps.reduce((t, g) => t + g, 0) / gaps.length) : null,
        seller_tickets: s?.n ?? 0,
        seller_sales: s?.total ?? 0,
        seller_average: s?.n ? Math.round(s.total / s.n) : 0,
      });
    }
    return out.sort((a, b) => b.sales + b.seller_sales - (a.sales + a.seller_sales));
  }

  // --- Rapport mensuel du propriétaire ---------------------------------------------

  monthFigures(storeId: string, month: string): MonthFigures {
    if (!MONTH.test(month)) throw new AppError('Mois invalide', 'INVALID');
    const p = { storeId, month };
    const inMonth = "strftime('%Y-%m', s.created_at, 'localtime') = @month";
    const head = this.db
      .prepare(
        `SELECT COALESCE(SUM(s.total_ttc), 0) AS ttc, COALESCE(SUM(s.total_ht), 0) AS ht, COALESCE(SUM(CASE WHEN s.kind = 'sale' THEN 1 ELSE 0 END), 0) AS tickets
         FROM sales s WHERE s.store_id = @storeId AND s.status = 'completed' AND ${inMonth}`,
      )
      .get(p) as { ttc: number; ht: number; tickets: number };
    const cost = this.db
      .prepare(`SELECT COALESCE(SUM(ROUND(l.qty * l.unit_cost / 1000.0)), 0) FROM sale_lines l JOIN sales s ON s.id = l.sale_id WHERE s.store_id = @storeId AND s.status = 'completed' AND ${inMonth}`)
      .pluck()
      .get(p) as number;
    const expenses = this.db
      .prepare("SELECT COALESCE(SUM(amount), 0) FROM expenses WHERE store_id = @storeId AND status = 'active' AND substr(expense_date, 1, 7) = @month")
      .pluck()
      .get(p) as number;
    const [y, m] = month.split('-').map(Number) as [number, number];
    const end = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
    const at = end < this.today() ? end : this.today();
    const pat = this.companies.patrimonyAt(storeId, at);
    const margin = head.ht - cost;
    return {
      month,
      sales_ttc: head.ttc,
      sales_ht: head.ht,
      tickets: head.tickets,
      margin,
      margin_rate: head.ht > 0 ? Math.round((margin / head.ht) * 1000) / 10 : 0,
      expenses,
      stock: pat.stock,
      receivables: pat.receivables,
      treasury: pat.treasury,
      payables: pat.payables,
    };
  }

  ownerReport(storeId: string, month: string): OwnerReport {
    const [y, m] = month.split('-').map(Number) as [number, number];
    const prevMonth = new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7);
    const current = this.monthFigures(storeId, month);
    const previous = this.monthFigures(storeId, prevMonth);
    const store = this.db.prepare('SELECT name, address, phone FROM stores WHERE id = ?').get(storeId) as OwnerReport['store'];
    const departments = this.db
      .prepare(
        `SELECT COALESCE(d.name, 'Sans rayon') AS name, SUM(ROUND(l.total_ttc * 10000.0 / (10000 + l.vat_rate_bp))) AS sales_ht,
                SUM(ROUND(l.total_ttc * 10000.0 / (10000 + l.vat_rate_bp)) - ROUND(l.qty * l.unit_cost / 1000.0)) AS margin
         FROM sale_lines l JOIN sales s ON s.id = l.sale_id JOIN articles a ON a.id = l.article_id
         LEFT JOIN families f ON f.id = a.family_id LEFT JOIN departments d ON d.id = f.department_id
         WHERE s.store_id = @storeId AND s.status = 'completed' AND strftime('%Y-%m', s.created_at, 'localtime') = @month
         GROUP BY 1 ORDER BY margin DESC LIMIT 8`,
      )
      .all({ storeId, month }) as OwnerReport['departments'];
    const money = (v: number) => `${Math.round(v).toLocaleString('fr-FR').replace(/ | /g, ' ')} FCFA`;
    const diff = (a: number, b: number) => (b ? ` (${a >= b ? '+' : ''}${Math.round(((a - b) / Math.abs(b)) * 100)} %)` : '');
    const monthName = new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('fr-FR', { month: 'long', year: 'numeric', timeZone: 'UTC' });
    const text = [
      `*${store.name}* : rapport de ${monthName}`,
      `Ventes : ${money(current.sales_ttc)}${diff(current.sales_ttc, previous.sales_ttc)}`,
      `Marge : ${money(current.margin)} (${String(current.margin_rate).replace('.', ',')} %)${diff(current.margin, previous.margin)}`,
      `Dépenses : ${money(current.expenses)}`,
      `Stock : ${money(current.stock)}`,
      `Crédit clients : ${money(current.receivables)}`,
      `Trésorerie : ${money(current.treasury)}`,
      `Dettes fournisseurs : ${money(current.payables)}`,
    ].join('\n');
    return { store, current, previous, departments, text };
  }
}
