import type { Fcfa, Milli } from '@superette/core';
import type { Db } from './database';
import type { StockService } from './stock';
import { AppError, Base, type Clock, type Context, newId } from './util';

export interface RecipeLine {
  article_id: string;
  code: string;
  name: string;
  unit: string;
  /** Quantité pour un lot de la recette. */
  qty: Milli;
  avg_cost: Fcfa;
}

export interface Recipe {
  id: string;
  article_id: string;
  article_code: string;
  article_name: string;
  unit: string;
  sale_price: Fcfa;
  /** Unités de produit fini obtenues par lot. */
  yield_qty: Milli;
  notes: string | null;
  active: number;
  lines: RecipeLine[];
  /** Coût de revient estimé d'une unité, au CMUP actuel des composants. */
  unit_cost: Fcfa;
  updated_at: string;
}

export interface RecipeInput {
  articleId: string;
  yieldQty: Milli;
  notes?: string | null;
  lines: { articleId: string; qty: Milli }[];
}

export type ProductionStatus = 'draft' | 'done' | 'cancelled';
export const PRODUCTION_STATUS: Record<ProductionStatus, string> = { draft: 'Brouillon', done: 'Fabriqué', cancelled: 'Annulé' };

export interface ProductionComponent {
  article_id: string;
  code: string;
  name: string;
  unit: string;
  qty: Milli;
  unit_cost: Fcfa;
  /** Stock du dépôt (pour un brouillon : de quoi fabriquer ?). */
  available: Milli;
}

export interface ProductionOrder {
  id: string;
  number: string;
  warehouse_id: string;
  warehouse_name: string;
  recipe_id: string;
  article_id: string;
  article_code: string;
  article_name: string;
  unit: string;
  qty: Milli;
  status: ProductionStatus;
  label: string | null;
  expiry: string | null;
  unit_cost: Fcfa | null;
  total_cost: Fcfa | null;
  created_at: string;
  created_by_name: string;
  done_at: string | null;
  done_by_name: string | null;
  components: ProductionComponent[];
}

/**
 * Fabrication (menu Fabrication : une recette décrit un
 * produit fini fait de composants (panier garni, jus maison, lot promo…).
 * Un ordre de fabrication sort les composants du stock et entre le produit
 * fini au coût de revient (somme des CMUP des composants sortis).
 */
export class ProductionService extends Base {
  constructor(
    db: Db,
    clock: Clock,
    private readonly stock: StockService,
  ) {
    super(db, clock);
  }

  private avgCost(articleId: string, warehouseId?: string | null): Fcfa {
    const row = warehouseId
      ? (this.db.prepare('SELECT avg_cost FROM stock WHERE article_id = ? AND warehouse_id = ?').get(articleId, warehouseId) as { avg_cost: number } | undefined)
      : (this.db.prepare('SELECT CAST(ROUND(SUM(qty * avg_cost) * 1.0 / NULLIF(SUM(qty), 0)) AS INTEGER) AS avg_cost FROM stock WHERE article_id = ? AND qty > 0').get(articleId) as
          | { avg_cost: number | null }
          | undefined);
    if (row?.avg_cost) return row.avg_cost;
    return (this.db.prepare('SELECT purchase_price FROM articles WHERE id = ?').pluck().get(articleId) as number | undefined) ?? 0;
  }

  // --- Recettes -----------------------------------------------------------------

  recipes(opts: { includeInactive?: boolean; id?: string } = {}): Recipe[] {
    const rows = this.db
      .prepare(
        `SELECT r.id, r.article_id, a.code AS article_code, a.name AS article_name, a.unit, a.sale_price, r.yield_qty, r.notes, r.active, r.updated_at
         FROM recipes r JOIN articles a ON a.id = r.article_id
         WHERE (@all = 1 OR r.active = 1) AND (@id IS NULL OR r.id = @id)
         ORDER BY a.name`,
      )
      .all({ all: opts.includeInactive || opts.id ? 1 : 0, id: opts.id ?? null }) as Omit<Recipe, 'lines' | 'unit_cost'>[];
    const lines = this.db.prepare(
      `SELECT l.article_id, a.code, a.name, a.unit, l.qty FROM recipe_lines l JOIN articles a ON a.id = l.article_id WHERE l.recipe_id = ? ORDER BY l.position`,
    );
    return rows.map((r) => {
      const ls = (lines.all(r.id) as Omit<RecipeLine, 'avg_cost'>[]).map((l) => ({ ...l, avg_cost: this.avgCost(l.article_id) }));
      const batch = ls.reduce((t, l) => t + (l.qty * l.avg_cost) / 1000, 0);
      return { ...r, lines: ls, unit_cost: Math.round((batch * 1000) / r.yield_qty) };
    });
  }

  getRecipe(id: string): Recipe {
    const r = this.recipes({ id })[0];
    if (!r) throw new AppError('Recette introuvable', 'NOT_FOUND');
    return r;
  }

  saveRecipe(ctx: Context, input: RecipeInput, id?: string): Recipe {
    if (!Number.isSafeInteger(input.yieldQty) || input.yieldQty <= 0) throw new AppError('Quantité produite invalide', 'INVALID');
    if (!input.lines.length) throw new AppError('Ajoutez au moins un composant', 'INVALID');
    const seen = new Set<string>();
    for (const l of input.lines) {
      if (l.articleId === input.articleId) throw new AppError('Le produit fini ne peut pas être son propre composant', 'INVALID');
      if (seen.has(l.articleId)) throw new AppError('Un composant apparaît deux fois', 'INVALID');
      if (!Number.isSafeInteger(l.qty) || l.qty <= 0) throw new AppError('Quantité de composant invalide', 'INVALID');
      seen.add(l.articleId);
    }
    const other = this.db.prepare('SELECT id FROM recipes WHERE article_id = ? AND active = 1 AND id IS NOT ?').pluck().get(input.articleId, id ?? null);
    if (other) throw new AppError('Ce produit a déjà une recette', 'INVALID');
    return this.tx(() => {
      const now = this.now();
      const recipeId = id ?? newId();
      if (id) {
        const r = this.db.prepare('UPDATE recipes SET article_id = ?, yield_qty = ?, notes = ?, active = 1, updated_at = ? WHERE id = ?').run(input.articleId, input.yieldQty, input.notes?.trim() || null, now, id);
        if (!r.changes) throw new AppError('Recette introuvable', 'NOT_FOUND');
        this.db.prepare('DELETE FROM recipe_lines WHERE recipe_id = ?').run(id);
      } else {
        this.db
          .prepare('INSERT INTO recipes (id, article_id, yield_qty, notes, active, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)')
          .run(recipeId, input.articleId, input.yieldQty, input.notes?.trim() || null, now, now);
      }
      const ins = this.db.prepare('INSERT INTO recipe_lines (id, recipe_id, position, article_id, qty) VALUES (?, ?, ?, ?, ?)');
      input.lines.forEach((l, i) => ins.run(newId(), recipeId, i + 1, l.articleId, l.qty));
      this.audit(ctx.userId, id ? 'recipe.update' : 'recipe.create', 'recipe', recipeId, { lines: input.lines.length });
      // Les produits sont communs aux magasins : leurs recettes aussi.
      this.enqueue(null, 'recipe', recipeId, 'upsert', {});
      return this.getRecipe(recipeId);
    });
  }

  archiveRecipe(ctx: Context, id: string): void {
    this.db.prepare('UPDATE recipes SET active = 0, updated_at = ? WHERE id = ?').run(this.now(), id);
    this.audit(ctx.userId, 'recipe.archive', 'recipe', id);
    this.enqueue(null, 'recipe', id, 'upsert', {});
  }

  // --- Ordres de fabrication ----------------------------------------------------------

  orders(storeId: string, opts: { status?: ProductionStatus | null; id?: string } = {}): ProductionOrder[] {
    const rows = this.db
      .prepare(
        `SELECT o.id, o.number, o.warehouse_id, w.name AS warehouse_name, o.recipe_id, o.article_id, a.code AS article_code, a.name AS article_name, a.unit,
                o.qty, o.status, o.label, o.expiry, o.unit_cost, o.total_cost, o.created_at, uc.name AS created_by_name, o.done_at, ud.name AS done_by_name, o.components
         FROM production_orders o JOIN warehouses w ON w.id = o.warehouse_id JOIN articles a ON a.id = o.article_id
         JOIN users uc ON uc.id = o.created_by LEFT JOIN users ud ON ud.id = o.done_by
         WHERE o.store_id = @storeId AND (@status IS NULL OR o.status = @status) AND (@id IS NULL OR o.id = @id)
         ORDER BY o.created_at DESC`,
      )
      .all({ storeId, status: opts.status ?? null, id: opts.id ?? null }) as (Omit<ProductionOrder, 'components'> & { components: string })[];
    const art = this.db.prepare('SELECT code, name, unit FROM articles WHERE id = ?');
    const avail = this.db.prepare('SELECT qty FROM stock WHERE article_id = ? AND warehouse_id = ?').pluck();
    return rows.map((o) => ({
      ...o,
      components: (JSON.parse(o.components) as { article_id: string; qty: Milli; unit_cost: Fcfa }[]).map((c) => ({
        ...(art.get(c.article_id) as { code: string; name: string; unit: string }),
        article_id: c.article_id,
        qty: c.qty,
        unit_cost: o.status === 'draft' ? this.avgCost(c.article_id, o.warehouse_id) : c.unit_cost,
        available: (avail.get(c.article_id, o.warehouse_id) as number | undefined) ?? 0,
      })),
    }));
  }

  getOrder(id: string): ProductionOrder {
    const storeId = this.db.prepare('SELECT store_id FROM production_orders WHERE id = ?').pluck().get(id) as string | undefined;
    const o = storeId ? this.orders(storeId, { id })[0] : undefined;
    if (!o) throw new AppError('Ordre de fabrication introuvable', 'NOT_FOUND');
    return o;
  }

  /** Composants nécessaires pour fabriquer `qty` unités (règle de trois sur le lot de la recette). */
  private needs(recipe: Recipe, qty: Milli): { article_id: string; qty: Milli; unit_cost: Fcfa }[] {
    return recipe.lines.map((l) => ({ article_id: l.article_id, qty: Math.ceil((l.qty * qty) / recipe.yield_qty), unit_cost: 0 }));
  }

  create(ctx: Context, input: { recipeId: string; warehouseId: string; qty: Milli; label?: string | null; expiry?: string | null }): ProductionOrder {
    if (!Number.isSafeInteger(input.qty) || input.qty <= 0) throw new AppError('Quantité à fabriquer invalide', 'INVALID');
    const recipe = this.getRecipe(input.recipeId);
    if (!recipe.active) throw new AppError('Cette recette est archivée', 'INVALID');
    return this.tx(() => {
      const id = newId();
      this.db
        .prepare(
          `INSERT INTO production_orders (id, number, store_id, warehouse_id, recipe_id, article_id, qty, status, label, expiry, components, created_at, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          `OF-${this.docNumber('production_orders', `production:${ctx.storeId}`, ctx.storeId)}`,
          ctx.storeId,
          input.warehouseId,
          recipe.id,
          recipe.article_id,
          input.qty,
          input.label?.trim() || null,
          input.expiry || null,
          JSON.stringify(this.needs(recipe, input.qty)),
          this.now(),
          ctx.userId,
        );
      this.audit(ctx.userId, 'production.create', 'production', id, { qty: input.qty });
      this.enqueue(ctx, 'production_order', id, 'upsert', {});
      return this.getOrder(id);
    });
  }

  /**
   * Fabrication : les composants sortent du dépôt (FEFO, au CMUP), le produit
   * fini entre au coût de revient. Refusé si un composant manque, sauf si le
   * magasin vend sans gestion de stock.
   */
  produce(ctx: Context, id: string): ProductionOrder {
    const o = this.getOrder(id);
    if (o.status !== 'draft') throw new AppError(`L'ordre ${o.number} est ${PRODUCTION_STATUS[o.status].toLowerCase()}`, 'INVALID');
    const ignoreStock = (this.db.prepare('SELECT ignore_stock FROM stores WHERE id = ?').pluck().get(ctx.storeId) as number | undefined) === 1;
    const missing = o.components.filter((c) => c.available < c.qty);
    if (missing.length && !ignoreStock) throw new AppError(`Stock insuffisant : ${missing.map((c) => c.name).join(', ')}`, 'OUT_OF_STOCK');
    return this.tx(() => {
      const reason = `Fabrication ${o.number} : ${o.article_name}`;
      let total = 0;
      const used = o.components.map((c) => {
        const out = this.stock.issue(ctx, { type: 'PRODUCTION_OUT', articleId: c.article_id, warehouseId: o.warehouse_id, qty: c.qty, refType: 'production', refId: id, reason });
        total += Math.round((c.qty * out.unitCost) / 1000);
        return { article_id: c.article_id, qty: c.qty, unit_cost: out.unitCost };
      });
      const unitCost = Math.round((total * 1000) / o.qty);
      const lotId = newId();
      this.stock.insertLot(ctx, { id: lotId, articleId: o.article_id, warehouseId: o.warehouse_id, lotNumber: o.number, expiry: o.expiry, qty: o.qty });
      this.stock.applyMovement(ctx, { type: 'PRODUCTION_IN', articleId: o.article_id, warehouseId: o.warehouse_id, qty: o.qty, unitCost, lotId, refType: 'production', refId: id, reason });
      this.db
        .prepare("UPDATE production_orders SET status = 'done', done_at = ?, done_by = ?, components = ?, unit_cost = ?, total_cost = ? WHERE id = ?")
        .run(this.now(), ctx.userId, JSON.stringify(used), unitCost, total, id);
      this.audit(ctx.userId, 'production.done', 'production', id, { qty: o.qty, total });
      this.enqueue(ctx, 'production_order', id, 'upsert', {});
      return this.getOrder(id);
    });
  }

  cancel(ctx: Context, id: string): ProductionOrder {
    const o = this.getOrder(id);
    if (o.status !== 'draft') throw new AppError('Seul un brouillon peut être annulé', 'INVALID');
    this.db.prepare("UPDATE production_orders SET status = 'cancelled', cancelled_at = ?, cancelled_by = ? WHERE id = ?").run(this.now(), ctx.userId, id);
    this.audit(ctx.userId, 'production.cancel', 'production', id);
    this.enqueue(ctx, 'production_order', id, 'upsert', {});
    return this.getOrder(id);
  }
}
