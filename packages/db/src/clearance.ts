import { type Fcfa, type Milli, MOVEMENT_TYPES, type MovementType, clearancePct, parseClearanceRules } from '@superette/core';
import type { AdminService } from './admin';
import type { CatalogueService } from './catalogue';
import type { Db } from './database';
import type { PromotionService } from './promotions';
import { AppError, Base, type Clock } from './util';

/** Produit dont un lot approche de sa date limite, avec la remise proposée. */
export interface ClearanceRow {
  article_id: string;
  article_code: string;
  article_name: string;
  unit: 'piece' | 'kg' | 'litre';
  department_name: string | null;
  /** Lot le plus proche de sa date limite. */
  lot_number: string | null;
  expiry: string;
  days_left: number;
  /** Quantité des lots qui périment dans la période des paliers. */
  qty: Milli;
  unit_cost: Fcfa;
  price: Fcfa;
  /** Remise proposée d'après les paliers (Administration › Paramètres). */
  pct: number;
  promo_price: Fcfa;
  /** Le prix proposé passe sous le prix de revient : la perte est moindre qu'une péremption. */
  below_cost: boolean;
  /** Promotion déjà en cours sur l'article. */
  running_promo: string | null;
  /** Valeur au prix de revient de ce qui risque d'être perdu. */
  at_risk: Fcfa;
}

/** Démarque d'un rayon : pertes par motif et poids dans le chiffre d'affaires. */
export interface LossRow {
  department_id: string | null;
  department_name: string;
  by_type: Partial<Record<MovementType, Fcfa>>;
  total: Fcfa;
  sales: Fcfa;
  /** Pertes en % du chiffre d'affaires TTC du rayon (deux décimales). */
  pct: number;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** Sorties comptées dans la démarque : pertes déclarées et écarts d'inventaire en moins. */
const LOSS_KINDS: MovementType[] = ['BREAKAGE', 'THEFT', 'EXPIRY', 'INTERNAL_USE', 'INVENTORY_ADJUST'];

/**
 * Déstockage avant péremption et démarque : les produits dont un lot périme
 * bientôt reçoivent une remise proposée par paliers (14 jours : 10 %, 7 jours :
 * 20 %, 3 jours : 30 % par défaut) et deviennent des promotions en un clic ; le
 * rapport des pertes montre ce que coûtent la casse, les vols, les périmés et
 * les écarts d'inventaire, rayon par rayon.
 */
export class ClearanceService extends Base {
  constructor(
    db: Db,
    clock: Clock,
    private readonly admin: AdminService,
    private readonly catalogue: CatalogueService,
    private readonly promotions: PromotionService,
  ) {
    super(db, clock);
  }

  candidates(storeId: string): ClearanceRow[] {
    const rules = parseClearanceRules(this.admin.storeSettings(storeId).clearanceRules);
    if (!rules.length) return [];
    const horizon = Math.max(...rules.map((r) => r.days));
    const today = this.today();
    const until = new Date(Date.parse(`${today}T00:00:00Z`) + horizon * 86_400_000).toISOString().slice(0, 10);
    const lots = this.db
      .prepare(
        `SELECT l.article_id, l.lot_number, l.expiry, l.qty FROM lots l JOIN warehouses w ON w.id = l.warehouse_id
         WHERE w.store_id = ? AND l.qty > 0 AND l.expiry IS NOT NULL AND l.expiry >= ? AND l.expiry <= ? ORDER BY l.expiry`,
      )
      .all(storeId, today, until) as { article_id: string; lot_number: string | null; expiry: string; qty: number }[];
    const byArticle = new Map<string, { lot_number: string | null; expiry: string; qty: number }>();
    for (const l of lots) {
      const cur = byArticle.get(l.article_id);
      if (cur) cur.qty += l.qty;
      else byArticle.set(l.article_id, { lot_number: l.lot_number, expiry: l.expiry, qty: l.qty });
    }
    const running = this.db.prepare(
      "SELECT name FROM promotions WHERE article_id = ? AND active = 1 AND starts_on <= ? AND ends_on >= ? AND (store_id IS NULL OR store_id = ?) ORDER BY updated_at DESC LIMIT 1",
    );
    const cost = this.db.prepare('SELECT COALESCE(MAX(s.avg_cost), 0) FROM stock s JOIN warehouses w ON w.id = s.warehouse_id WHERE s.article_id = ? AND w.store_id = ?');
    const dept = this.db.prepare('SELECT d.name FROM articles a LEFT JOIN families f ON f.id = a.family_id LEFT JOIN departments d ON d.id = f.department_id WHERE a.id = ?');
    const out: ClearanceRow[] = [];
    for (const [articleId, l] of byArticle) {
      const a = this.catalogue.getArticle(articleId, storeId);
      if (!a.active) continue;
      const daysLeft = Math.round((Date.parse(`${l.expiry}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
      const pct = clearancePct(rules, daysLeft);
      if (!pct) continue;
      const price = a.store_price;
      const unitCost = (cost.pluck().get(articleId, storeId) as number) || a.purchase_price;
      const promo = Math.max(1, Math.round((price * (100 - pct)) / 100 / 5) * 5);
      out.push({
        article_id: a.id,
        article_code: a.code,
        article_name: a.name,
        unit: a.unit,
        department_name: ((dept.get(articleId) as { name: string | null } | undefined)?.name ?? null) || null,
        lot_number: l.lot_number,
        expiry: l.expiry,
        days_left: daysLeft,
        qty: l.qty,
        unit_cost: unitCost,
        price,
        pct,
        promo_price: promo,
        below_cost: promo < unitCost,
        running_promo: (running.pluck().get(articleId, today, today, storeId) as string | undefined) ?? null,
        at_risk: Math.round((l.qty * unitCost) / 1000),
      });
    }
    return out.sort((a, b) => a.days_left - b.days_left || b.at_risk - a.at_risk);
  }

  /**
   * Crée les promotions de déstockage choisies, jusqu'à la date limite du lot,
   * pour ce magasin seulement. Une promotion déjà en cours sur l'article est laissée.
   */
  createPromotions(userId: string, storeId: string, items: { articleId: string; promoPrice: Fcfa; until?: string | null }[]): { created: number; skipped: string[] } {
    if (!items.length) throw new AppError('Choisissez au moins un produit', 'EMPTY');
    const today = this.today();
    const rows = new Map(this.candidates(storeId).map((r) => [r.article_id, r]));
    let created = 0;
    const skipped: string[] = [];
    this.tx(() => {
      for (const it of items) {
        const r = rows.get(it.articleId);
        if (!r) throw new AppError('Produit sans lot proche de sa date limite', 'INVALID');
        if (r.running_promo) {
          skipped.push(r.article_name);
          continue;
        }
        const until = it.until && DAY.test(it.until) ? it.until : r.expiry;
        if (until < today) throw new AppError('La date de fin est passée', 'INVALID');
        this.promotions.save(userId, {
          name: `Déstockage ${r.article_name} (DLC ${r.expiry.split('-').reverse().join('/')})`,
          kind: 'price',
          articleId: r.article_id,
          storeId,
          startsOn: today,
          endsOn: until,
          promoPrice: it.promoPrice,
        });
        created += 1;
      }
    });
    return { created, skipped };
  }

  /** Démarque par rayon et par motif sur la période, en valeur au prix de revient. */
  losses(storeId: string, from: string, to: string): LossRow[] {
    if (!DAY.test(from) || !DAY.test(to) || to < from) throw new AppError('Période invalide', 'INVALID');
    const moves = this.db
      .prepare(
        `SELECT d.id AS department_id, d.name AS department_name, m.type, SUM(-m.qty * m.unit_cost / 1000.0) AS value
         FROM stock_movements m JOIN warehouses w ON w.id = m.warehouse_id JOIN articles a ON a.id = m.article_id
         LEFT JOIN families f ON f.id = a.family_id LEFT JOIN departments d ON d.id = f.department_id
         WHERE w.store_id = @storeId AND m.qty < 0 AND m.type IN (${LOSS_KINDS.map((k) => `'${k}'`).join(', ')})
           AND date(m.at, 'localtime') BETWEEN @from AND @to
         GROUP BY d.id, m.type`,
      )
      .all({ storeId, from, to }) as { department_id: string | null; department_name: string | null; type: MovementType; value: number }[];
    const sales = this.db
      .prepare(
        `SELECT f.department_id, SUM(l.total_ttc) AS total FROM sale_lines l JOIN sales s ON s.id = l.sale_id JOIN articles a ON a.id = l.article_id
         LEFT JOIN families f ON f.id = a.family_id
         WHERE s.store_id = @storeId AND s.status = 'completed' AND date(s.created_at, 'localtime') BETWEEN @from AND @to GROUP BY f.department_id`,
      )
      .all({ storeId, from, to }) as { department_id: string | null; total: number }[];
    const rows = new Map<string, LossRow>();
    for (const m of moves) {
      const key = m.department_id ?? '';
      const r = rows.get(key) ?? { department_id: m.department_id, department_name: m.department_name ?? 'Sans rayon', by_type: {}, total: 0, sales: 0, pct: 0 };
      const v = Math.round(m.value);
      r.by_type[m.type] = (r.by_type[m.type] ?? 0) + v;
      r.total += v;
      rows.set(key, r);
    }
    for (const r of rows.values()) {
      r.sales = sales.find((x) => (x.department_id ?? '') === (r.department_id ?? ''))?.total ?? 0;
      r.pct = r.sales ? Math.round((r.total / r.sales) * 10_000) / 100 : 0;
    }
    return [...rows.values()].sort((a, b) => b.total - a.total);
  }

  /** Libellés des motifs de la démarque. */
  static lossLabels(): Partial<Record<MovementType, string>> {
    return Object.fromEntries(LOSS_KINDS.map((k) => [k, MOVEMENT_TYPES[k]]));
  }
}
