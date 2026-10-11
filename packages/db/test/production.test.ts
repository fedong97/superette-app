import { beforeEach, describe, expect, it } from 'vitest';
import { type Context, type Services, createServices, openDatabase } from '../src';

let s: Services;
let ctx: Context;
let shop: string;
let riz: string;
let huile: string;
let sucre: string;
let panier: string;

beforeEach(() => {
  s = createServices(openDatabase(':memory:'), () => new Date('2026-10-11T08:00:00Z'));
  const { store, register, admin } = s.admin.bootstrap({ storeCode: 'DLA1', storeName: 'Superette Akwa', adminName: 'Steve', adminLogin: 'steve', adminPin: '1234' });
  ctx = { storeId: store.id, registerId: register.id, userId: admin.id };
  shop = s.admin.salesWarehouse(store.id).id;
  const tva = s.admin.listVatRates()[0]!.id;
  const art = (name: string, buy: number, sell: number) => s.catalogue.saveArticle(admin.id, { name, unit: 'piece', vatRateId: tva, purchasePrice: buy, salePrice: sell }).id;
  riz = art('Riz 5 kg', 3_600, 4_500);
  huile = art('Huile 1 L', 1_250, 1_500);
  sucre = art('Sucre 1 kg', 800, 1_000);
  panier = art('Panier garni', 0, 12_000);
  s.stock.receive(ctx, {
    warehouseId: shop,
    lines: [
      { articleId: riz, qty: 10_000, unitCost: 3_600 },
      { articleId: huile, qty: 20_000, unitCost: 1_250 },
      { articleId: sucre, qty: 3_000, unitCost: 800 },
    ],
  });
});

const qtyOf = (article: string) => s.stock.list(ctx.storeId, { warehouseId: shop }).find((r) => r.article_id === article)?.qty ?? 0;

describe('fabrication', () => {
  it('recette au coût de revient, ordre de fabrication, composants sortis et produit fini entré au coût', () => {
    // Un lot de 2 paniers : 2 riz, 4 huiles, 2 sucres.
    const recipe = s.production.saveRecipe(ctx, { articleId: panier, yieldQty: 2_000, lines: [{ articleId: riz, qty: 2_000 }, { articleId: huile, qty: 4_000 }, { articleId: sucre, qty: 2_000 }] });
    expect(recipe.unit_cost).toBe((2 * 3_600 + 4 * 1_250 + 2 * 800) / 2);
    expect(() => s.production.saveRecipe(ctx, { articleId: panier, yieldQty: 1_000, lines: [{ articleId: riz, qty: 1_000 }] })).toThrow(/déjà une recette/);
    expect(() => s.production.saveRecipe(ctx, { articleId: riz, yieldQty: 1_000, lines: [{ articleId: riz, qty: 1_000 }] })).toThrow(/propre composant/);

    const order = s.production.create(ctx, { recipeId: recipe.id, warehouseId: shop, qty: 3_000, label: 'Fête des mères' });
    expect(order).toMatchObject({ number: 'OF-DLA11-1', status: 'draft' });
    expect(order.components.map((c) => [c.name, c.qty, c.available])).toEqual([
      ['Riz 5 kg', 3_000, 10_000],
      ['Huile 1 L', 6_000, 20_000],
      ['Sucre 1 kg', 3_000, 3_000],
    ]);

    const done = s.production.produce(ctx, order.id);
    expect(done).toMatchObject({ status: 'done', total_cost: 3 * 3_600 + 6 * 1_250 + 3 * 800, unit_cost: 6_900 });
    expect([qtyOf(riz), qtyOf(huile), qtyOf(sucre), qtyOf(panier)]).toEqual([7_000, 14_000, 0, 3_000]);
    const row = s.stock.list(ctx.storeId, { warehouseId: shop }).find((r) => r.article_id === panier)!;
    expect(row.avg_cost).toBe(6_900);
    expect(s.stock.movements(ctx.storeId, { articleId: panier })[0]).toMatchObject({ type: 'PRODUCTION_IN', qty: 3_000 });
    expect(() => s.production.produce(ctx, order.id)).toThrow(/fabriqué/);
  });

  it('refuse de fabriquer sans les composants, et un brouillon peut être annulé', () => {
    const recipe = s.production.saveRecipe(ctx, { articleId: panier, yieldQty: 1_000, lines: [{ articleId: sucre, qty: 2_000 }] });
    const order = s.production.create(ctx, { recipeId: recipe.id, warehouseId: shop, qty: 2_000 });
    expect(() => s.production.produce(ctx, order.id)).toThrow(/Stock insuffisant : Sucre 1 kg/);
    expect(qtyOf(sucre)).toBe(3_000);
    expect(s.production.cancel(ctx, order.id).status).toBe('cancelled');
    s.production.archiveRecipe(ctx, recipe.id);
    expect(s.production.recipes()).toHaveLength(0);
    expect(() => s.production.create(ctx, { recipeId: recipe.id, warehouseId: shop, qty: 1_000 })).toThrow(/archivée/);
  });
});
