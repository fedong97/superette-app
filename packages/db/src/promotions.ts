import { type Fcfa, type PromotionKind, type PromotionRule, checkPromotion } from '@superette/core';
import type { CatalogueService } from './catalogue';
import type { Db } from './database';
import { AppError, Base, type Clock, newId } from './util';

export interface Promotion {
  id: string;
  name: string;
  kind: PromotionKind;
  article_id: string;
  article_name: string;
  article_price: Fcfa;
  article_unit: 'piece' | 'kg' | 'litre';
  /** Magasin concerné, ou null pour tous les magasins. */
  store_id: string | null;
  starts_on: string;
  ends_on: string;
  promo_price: Fcfa | null;
  buy_qty: number | null;
  pay_qty: number | null;
  lot_price: Fcfa | null;
  active: number;
  updated_at: string;
  /** Calculé : en cours, à venir, terminée ou arrêtée. */
  status: 'running' | 'scheduled' | 'ended' | 'stopped';
  /** Quantités vendues et économie accordée aux clients. */
  sold_qty: number;
  given: Fcfa;
}

export interface PromotionInput {
  name: string;
  kind: PromotionKind;
  articleId: string;
  storeId: string | null;
  startsOn: string;
  endsOn: string;
  promoPrice?: Fcfa | null;
  buyQty?: number | null;
  payQty?: number | null;
  lotPrice?: Fcfa | null;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Promotions datées (prix promo, N achetés M payés, lot à prix fixe), communes à tous les
 * magasins ou propres à l'un d'eux. La caisse les applique d'elle-même pendant la période.
 */
export class PromotionService extends Base {
  constructor(
    db: Db,
    clock: Clock,
    private readonly catalogue: CatalogueService,
  ) {
    super(db, clock);
  }

  list(storeId: string | null): Promotion[] {
    const today = this.today();
    const rows = this.db
      .prepare(
        `SELECT p.*, a.name AS article_name, COALESCE(sp.sale_price, a.sale_price) AS article_price, a.unit AS article_unit,
           COALESCE((SELECT SUM(l.qty) FROM sale_lines l JOIN sales s ON s.id = l.sale_id
                     WHERE l.promotion_id = p.id AND s.status = 'completed' AND s.kind = 'sale'), 0) AS sold_qty,
           COALESCE((SELECT SUM(l.promo) FROM sale_lines l JOIN sales s ON s.id = l.sale_id
                     WHERE l.promotion_id = p.id AND s.status = 'completed' AND s.kind = 'sale'), 0) AS given
         FROM promotions p JOIN articles a ON a.id = p.article_id
         LEFT JOIN store_prices sp ON sp.article_id = a.id AND sp.store_id = @storeId
         WHERE @storeId IS NULL OR p.store_id IS NULL OR p.store_id = @storeId
         ORDER BY p.starts_on DESC, p.name`,
      )
      .all({ storeId }) as Omit<Promotion, 'status'>[];
    return rows.map((p) => ({
      ...p,
      status: !p.active ? 'stopped' : p.ends_on < today ? 'ended' : p.starts_on > today ? 'scheduled' : 'running',
    }));
  }

  get(id: string): Promotion {
    const p = this.list(null).find((x) => x.id === id);
    if (!p) throw new AppError('Promotion introuvable', 'NOT_FOUND');
    return p;
  }

  /** Règles en vigueur aujourd'hui dans le magasin, pour la caisse. */
  activeRules(storeId: string, date = this.today()): PromotionRule[] {
    return (
      this.db
        .prepare(
          `SELECT id, name, article_id, kind, promo_price, buy_qty, pay_qty, lot_price FROM promotions
           WHERE active = 1 AND starts_on <= @date AND ends_on >= @date AND (store_id IS NULL OR store_id = @storeId)`,
        )
        .all({ storeId, date }) as { id: string; name: string; article_id: string; kind: PromotionKind; promo_price: number | null; buy_qty: number | null; pay_qty: number | null; lot_price: number | null }[]
    ).map((r) => ({
      id: r.id,
      name: r.name,
      articleId: r.article_id,
      kind: r.kind,
      promoPrice: r.promo_price,
      buyQty: r.buy_qty,
      payQty: r.pay_qty,
      lotPrice: r.lot_price,
    }));
  }

  save(userId: string, input: PromotionInput, id?: string): Promotion {
    if (!['price', 'x_for_y', 'lot'].includes(input.kind)) throw new AppError('Type de promotion inconnu', 'INVALID');
    if (!DATE.test(input.startsOn) || !DATE.test(input.endsOn)) throw new AppError('Dates de la promotion invalides', 'INVALID');
    if (input.endsOn < input.startsOn) throw new AppError('La promotion finit avant de commencer', 'INVALID');
    const article = this.catalogue.getArticle(input.articleId, input.storeId);
    const rule = {
      name: input.name.trim(),
      kind: input.kind,
      promoPrice: input.kind === 'price' ? (input.promoPrice ?? null) : null,
      buyQty: input.kind === 'price' ? null : (input.buyQty ?? null),
      payQty: input.kind === 'x_for_y' ? (input.payQty ?? null) : null,
      lotPrice: input.kind === 'lot' ? (input.lotPrice ?? null) : null,
    };
    const error = checkPromotion(rule, article.store_price, article.unit);
    if (error) throw new AppError(error, 'INVALID');
    if (input.storeId && !this.db.prepare('SELECT 1 FROM stores WHERE id = ?').pluck().get(input.storeId)) throw new AppError('Magasin introuvable', 'NOT_FOUND');
    const row = {
      id: id ?? newId(),
      name: rule.name,
      kind: rule.kind,
      article: article.id,
      store: input.storeId,
      starts: input.startsOn,
      ends: input.endsOn,
      promoPrice: rule.promoPrice,
      buyQty: rule.buyQty,
      payQty: rule.payQty,
      lotPrice: rule.lotPrice,
      user: userId,
      now: this.now(),
    };
    if (id) this.get(id);
    this.db
      .prepare(
        `INSERT INTO promotions (id, name, kind, article_id, store_id, starts_on, ends_on, promo_price, buy_qty, pay_qty, lot_price, active, user_id, created_at, updated_at)
         VALUES (@id, @name, @kind, @article, @store, @starts, @ends, @promoPrice, @buyQty, @payQty, @lotPrice, 1, @user, @now, @now)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, kind = excluded.kind, article_id = excluded.article_id, store_id = excluded.store_id,
           starts_on = excluded.starts_on, ends_on = excluded.ends_on, promo_price = excluded.promo_price, buy_qty = excluded.buy_qty,
           pay_qty = excluded.pay_qty, lot_price = excluded.lot_price, user_id = excluded.user_id, updated_at = excluded.updated_at`,
      )
      .run(row);
    this.enqueue(null, 'promotion', row.id, 'upsert', {});
    this.audit(userId, id ? 'promotion.update' : 'promotion.create', 'promotion', row.id, { name: rule.name, kind: rule.kind, from: input.startsOn, to: input.endsOn });
    return this.get(row.id);
  }

  /** Arrête une promotion avant sa fin (ou la relance) ; les tickets déjà faits ne changent pas. */
  setActive(userId: string, id: string, active: boolean): Promotion {
    this.get(id);
    this.db.prepare('UPDATE promotions SET active = ?, user_id = ?, updated_at = ? WHERE id = ?').run(active ? 1 : 0, userId, this.now(), id);
    this.enqueue(null, 'promotion', id, 'upsert', {});
    this.audit(userId, active ? 'promotion.resume' : 'promotion.stop', 'promotion', id);
    return this.get(id);
  }
}
