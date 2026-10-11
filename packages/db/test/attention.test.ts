import { beforeEach, describe, expect, it } from 'vitest';
import { type AttentionKey, type Context, type Services, createServices, openDatabase } from '../src';

let s: Services;
let ctx: Context;
let shop: string;
let reserve: string;
let riz: string;
let sucre: string;
let panier: string;

const ALL = new Set<AttentionKey>(['rupture', 'alerte', 'cash_gaps', 'transfers', 'stock_requests', 'rebates_pending', 'rebates_balance', 'inventories', 'supplier_invoices', 'late_customers', 'production']);

beforeEach(() => {
  s = createServices(openDatabase(':memory:'), () => new Date('2026-10-11T08:00:00Z'));
  const { store, register, admin } = s.admin.bootstrap({ storeCode: 'DLA1', storeName: 'Superette Akwa', adminName: 'Steve', adminLogin: 'steve', adminPin: '1234' });
  ctx = { storeId: store.id, registerId: register.id, userId: admin.id };
  shop = s.admin.salesWarehouse(store.id).id;
  reserve = s.admin.listWarehouses(store.id).find((w) => w.name === 'Réserve')!.id;
  const tva = s.admin.listVatRates()[0]!.id;
  riz = s.catalogue.saveArticle(admin.id, { name: 'Riz 5 kg', unit: 'piece', vatRateId: tva, purchasePrice: 3_600, salePrice: 4_500 }).id;
  sucre = s.catalogue.saveArticle(admin.id, { name: 'Sucre 1 kg', unit: 'piece', vatRateId: tva, purchasePrice: 800, salePrice: 1_000, alertQty: 5_000 }).id;
  panier = s.catalogue.saveArticle(admin.id, { name: 'Panier garni', unit: 'piece', vatRateId: tva, purchasePrice: 0, salePrice: 12_000 }).id;
  s.stock.receive(ctx, { warehouseId: reserve, lines: [{ articleId: riz, qty: 10_000, unitCost: 3_600 }] });
  s.stock.receive(ctx, { warehouseId: shop, lines: [{ articleId: sucre, qty: 2_000, unitCost: 800 }] });
});

const byKey = () => Object.fromEntries(s.attention.list(ctx.storeId, ALL).map((i) => [i.key, i]));

describe("points d'attention", () => {
  it('compte ce qui attend une action, et rien quand tout est en ordre', () => {
    const calm = byKey();
    expect(Object.keys(calm)).toHaveLength(ALL.size);
    for (const k of ['cash_gaps', 'transfers', 'stock_requests', 'inventories', 'supplier_invoices', 'late_customers', 'production', 'rebates_pending', 'rebates_balance']) expect(calm[k]!.count).toBe(0);
    expect(calm.alerte).toMatchObject({ count: 1, detail: 'Sucre 1 kg' });

    const t = s.transfers.create(ctx, { fromWarehouseId: reserve, toWarehouseId: shop, lines: [{ articleId: riz, qty: 2_000 }] });
    s.transfers.ship(ctx, t.id);
    s.inventories.create(ctx, { warehouseId: reserve, kind: 'global' });
    s.monitoring.request(ctx, { articleId: sucre, warehouseId: shop, newQty: 1_000, reason: 'Paquet déchiré' });
    const recipe = s.production.saveRecipe(ctx, { articleId: panier, yieldQty: 1_000, lines: [{ articleId: sucre, qty: 1_000 }] });
    s.production.create(ctx, { recipeId: recipe.id, warehouseId: shop, qty: 1_000 });

    const busy = byKey();
    expect(busy.transfers).toMatchObject({ count: 1, detail: 'n° DLA11-1 vers Surface de vente' });
    expect(busy.inventories!.count).toBe(1);
    expect(busy.stock_requests).toMatchObject({ count: 1, detail: 'Sucre 1 kg' });
    expect(busy.production).toMatchObject({ count: 1, detail: 'n° OF-DLA11-1' });
  });

  it('ne rend que les points demandés', () => {
    expect(s.attention.list(ctx.storeId, new Set<AttentionKey>(['production', 'inventories'])).map((i) => i.key)).toEqual(['inventories', 'production']);
    expect(s.attention.lastMonth()).toEqual({ from: '2026-09-01', to: '2026-09-30' });
  });
});
