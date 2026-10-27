import type { Fcfa } from '@superette/core';
import type { CatalogueService, PriceUpdateInput, PriceUpdatePlan } from './catalogue';
import type { Db } from './database';
import type { LabelItem, LabelService } from './labels';
import { AppError, Base, type Clock, type Context, newId } from './util';

export type PriceScheduleStatus = 'pending' | 'applied' | 'cancelled';

export interface PriceSchedule {
  id: string;
  store_id: string;
  store_name: string | null;
  label: string;
  effective_on: string;
  status: PriceScheduleStatus;
  applied_at: string | null;
  user_name: string | null;
  created_at: string;
  articles: number;
  lines: number;
}

export interface PriceScheduleDetail extends PriceSchedule {
  plan: PriceUpdatePlan;
}

export interface PriceScheduleInput {
  label: string;
  /** Jour où les nouveaux prix s'appliquent (AAAA-MM-JJ). */
  effectiveOn: string;
  /** Hausse ou baisse calculée comme une mise à jour des prix en masse… */
  update?: PriceUpdateInput | null;
  /** …ou nouveaux prix de vente fixés article par article. */
  prices?: { articleId: string; salePrice: Fcfa }[] | null;
}

/**
 * Prix programmés : une hausse du fournisseur, une baisse de fin de mois,
 * préparées à l'avance. Les nouveaux prix sont calculés le jour de la
 * préparation et s'appliquent seuls à leur date, sur un PC du magasin qui les
 * a préparés ; la veille, les étiquettes sont prêtes à imprimer.
 */
export class PriceScheduleService extends Base {
  constructor(
    db: Db,
    clock: Clock,
    private readonly catalogue: CatalogueService,
    private readonly labels: LabelService,
  ) {
    super(db, clock);
  }

  create(ctx: Context, input: PriceScheduleInput): PriceScheduleDetail {
    const label = input.label.trim().slice(0, 80);
    if (label.length < 2) throw new AppError('Donnez un nom à ce changement de prix (ex. « Hausse Nestlé du 1er »)', 'INVALID');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.effectiveOn)) throw new AppError('Date d’application invalide', 'INVALID');
    const today = this.today();
    if (input.effectiveOn <= today) throw new AppError('Choisissez une date à partir de demain : pour aujourd’hui, faites la mise à jour des prix directement', 'INVALID');
    if (input.effectiveOn > addDays(today, 366)) throw new AppError('Date trop lointaine (un an au plus)', 'INVALID');
    const plan = input.prices?.length ? this.fixedPlan(ctx.storeId, input.prices) : input.update ? this.catalogue.planPriceUpdate(ctx.storeId, input.update) : null;
    if (!plan || !plan.articles.length) throw new AppError('Aucun prix ne change avec ces réglages', 'INVALID');
    const id = newId();
    const now = this.now();
    this.tx(() => {
      this.db
        .prepare(
          `INSERT INTO price_schedules (id, store_id, label, effective_on, plan, status, user_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
        )
        .run(id, ctx.storeId, label, input.effectiveOn, JSON.stringify(plan), ctx.userId, now, now);
      this.enqueue(ctx, 'price_schedule', id, 'upsert', {});
      this.audit(ctx.userId, 'price.schedule', 'price_schedule', id, { effectiveOn: input.effectiveOn, articles: plan.articles.length });
    });
    return this.get(id);
  }

  /** Plan d'un prix de vente fixé par article (conditionnements et autres prix inchangés). */
  private fixedPlan(storeId: string, prices: { articleId: string; salePrice: Fcfa }[]): PriceUpdatePlan {
    const articles: PriceUpdatePlan['articles'] = [];
    for (const p of prices) {
      if (!Number.isSafeInteger(p.salePrice) || p.salePrice <= 0) throw new AppError('Prix de vente invalide', 'INVALID');
      const a = this.catalogue.getArticle(p.articleId, storeId);
      const store = a.store_price !== a.sale_price ? a.store_price : null;
      const old = store ?? a.sale_price;
      if (old === p.salePrice) continue;
      const unitName = a.unit === 'piece' ? (a.unit_name ?? 'Pièce') : a.unit === 'kg' ? 'Kg' : 'Litre';
      articles.push({
        articleId: a.id,
        code: a.code,
        name: a.name,
        purchase: a.purchase_price,
        // Un prix propre au magasin change seul ; sinon le prix national change.
        unit: store === null ? p.salePrice : a.sale_price,
        store: store === null ? null : p.salePrice,
        wholesale: a.wholesale_price,
        superWholesale: a.super_wholesale_price,
        packs: a.packs,
        lines: [{ level: unitName, field: 'sale', old, next: p.salePrice }],
      });
    }
    return { articles, lines: articles.length };
  }

  get(id: string): PriceScheduleDetail {
    const row = this.db.prepare(`${SELECT} WHERE p.id = ?`).get(id) as (PriceSchedule & { plan: string }) | undefined;
    if (!row) throw new AppError('Prix programmés introuvables', 'NOT_FOUND');
    return { ...row, plan: JSON.parse(row.plan) as PriceUpdatePlan };
  }

  /** À venir d'abord, puis les derniers appliqués ou annulés (tous les magasins). */
  list(opts: { all?: boolean } = {}): PriceSchedule[] {
    const rows = this.db
      .prepare(
        `${SELECT} WHERE p.status = 'pending' OR (@all = 1) OR p.updated_at >= @since
         ORDER BY p.status <> 'pending', CASE WHEN p.status = 'pending' THEN p.effective_on END, p.effective_on DESC LIMIT 200`,
      )
      .all({ all: opts.all ? 1 : 0, since: new Date(this.clock().getTime() - 30 * 86_400_000).toISOString() }) as (PriceSchedule & { plan: string })[];
    return rows.map(({ plan: _plan, ...r }) => r);
  }

  cancel(ctx: Context, id: string): PriceScheduleDetail {
    const s = this.get(id);
    if (s.status !== 'pending') throw new AppError(s.status === 'applied' ? 'Ces prix sont déjà appliqués : faites une nouvelle mise à jour pour revenir en arrière' : 'Déjà annulé', 'INVALID');
    const now = this.now();
    this.tx(() => {
      this.db.prepare("UPDATE price_schedules SET status = 'cancelled', updated_at = ? WHERE id = ?").run(now, id);
      this.enqueue(ctx, 'price_schedule', id, 'upsert', {});
      this.audit(ctx.userId, 'price.schedule_cancel', 'price_schedule', id);
    });
    return this.get(id);
  }

  /**
   * Applique les prix arrivés à leur date, sur un PC du magasin qui les a
   * préparés (les autres magasins reçoivent les articles par la synchronisation).
   */
  applyDue(ctx: Context): { schedules: number; articles: number } {
    const due = this.db
      .prepare("SELECT id FROM price_schedules WHERE status = 'pending' AND store_id = ? AND effective_on <= ? ORDER BY effective_on, created_at")
      .pluck()
      .all(ctx.storeId, this.today()) as string[];
    let articles = 0;
    for (const id of due) {
      const s = this.get(id);
      const userId = (this.db.prepare('SELECT user_id FROM price_schedules WHERE id = ?').pluck().get(id) as string | null) ?? ctx.userId;
      this.tx(() => {
        articles += this.catalogue.applyPlan(userId, s.store_id, s.plan);
        const now = this.now();
        this.db.prepare("UPDATE price_schedules SET status = 'applied', applied_at = ?, updated_at = ? WHERE id = ? AND status = 'pending'").run(now, now, id);
        this.enqueue(ctx, 'price_schedule', id, 'upsert', {});
        this.audit(userId, 'price.schedule_applied', 'price_schedule', id, { articles: s.plan.articles.length });
      });
    }
    return { schedules: due.length, articles };
  }

  /** Prix de l'unité qui changent à une date (demain par défaut), pour ce magasin. */
  pricesOn(storeId: string, day?: string): { day: string; prices: Map<string, Fcfa>; schedules: PriceSchedule[] } {
    const d = day ?? addDays(this.today(), 1);
    const rows = this.db
      .prepare(`${SELECT} WHERE p.status = 'pending' AND p.effective_on = ? ORDER BY p.created_at`)
      .all(d) as (PriceSchedule & { plan: string })[];
    const prices = new Map<string, Fcfa>();
    for (const r of rows) {
      const plan = JSON.parse(r.plan) as PriceUpdatePlan;
      // Un prix propre à un autre magasin ne change pas l'étiquette ici.
      for (const a of plan.articles) {
        if (r.store_id === storeId && a.store !== null) prices.set(a.articleId, a.store);
        else if (a.store === null || r.store_id === storeId) prices.set(a.articleId, a.unit);
      }
    }
    return { day: d, prices, schedules: rows.map(({ plan: _plan, ...r }) => r) };
  }

  /** Étiquettes aux nouveaux prix, à imprimer la veille et poser le matin. */
  labelsFor(storeId: string, day?: string, copies = 1) {
    const { day: d, prices } = this.pricesOn(storeId, day);
    if (!prices.size) throw new AppError('Aucun prix programmé pour ce jour', 'INVALID');
    const items: LabelItem[] = [...prices.keys()].map((articleId) => ({ articleId, copies }));
    return this.labels.build(storeId, items, { prices, date: d });
  }
}

const SELECT = `SELECT p.id, p.store_id, s.name AS store_name, p.label, p.effective_on, p.status, p.applied_at, u.name AS user_name, p.created_at, p.plan,
                       json_array_length(p.plan, '$.articles') AS articles, json_extract(p.plan, '$.lines') AS lines
                FROM price_schedules p LEFT JOIN stores s ON s.id = p.store_id LEFT JOIN users u ON u.id = p.user_id`;

const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
