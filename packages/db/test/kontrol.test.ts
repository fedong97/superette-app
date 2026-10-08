import { containsFromDivisors, dividePrice } from '@superette/core';
import { describe, expect, it } from 'vitest';
import { createServices, openDatabase } from '../src';

function setup() {
  const s = createServices(openDatabase(':memory:'), () => new Date('2026-10-10T09:00:00Z'));
  const { store, register, admin } = s.admin.bootstrap({ storeCode: 'DLA1', storeName: 'Superette Akwa', adminName: 'Steve', adminLogin: 'steve', adminPin: '1234' });
  const ctx = { storeId: store.id, registerId: register.id, userId: admin.id };
  const tva = s.admin.listVatRates().find((r) => r.rate_bp === 1925)!.id;
  // Fiche KONTROL : PALETTE (achat 17 000, revient 17 500), vendue aussi à la CANETTE (diviseur 24).
  const mutzig = s.catalogue.saveArticle(admin.id, {
    name: 'BIERE MUTZIG 50CL',
    code: 'BM501',
    otherRef: 'MUTZ50',
    unit: 'piece',
    unitName: 'CANETTE',
    vatRateId: tva,
    purchasePrice: 0,
    packPurchasePrice: 17_000,
    packCostPrice: 17_500,
    salePrice: 1_000,
    wholesalePrice: 950,
    packs: [{ name: 'PALETTE', contains: 24, salePrice: 24_000, wholesalePrice: 23_000, superWholesalePrice: 22_500 }],
  });
  const warehouseId = s.admin.salesWarehouse(store.id).id;
  return { s, ctx, mutzig, tva, warehouseId };
}

describe('fiche article à la KONTROL', () => {
  it('déduit le contenu de chaque niveau des diviseurs', () => {
    expect(containsFromDivisors([{ name: 'PALETTE', divisor: 1 }, { name: 'PACK', divisor: 4 }, { name: 'CANETTE', divisor: 24 }])).toEqual([4, 6]);
    expect(containsFromDivisors([{ name: 'PALETTE', divisor: 1 }])).toEqual([]);
    expect(containsFromDivisors([{ name: 'PALETTE', divisor: 1 }, { name: 'PACK', divisor: 5 }, { name: 'CANETTE', divisor: 24 }])).toMatch(/multiple/);
    expect(containsFromDivisors([{ name: 'PALETTE', divisor: 1 }, { name: 'PACK', divisor: 24 }, { name: 'CANETTE', divisor: 6 }])).toMatch(/plus grand au plus petit/);
    expect(dividePrice(17_000, 24)).toBe(708);
  });

  it('garde les prix exacts du conditionnement d’achat et en déduit l’unité', () => {
    const { s, ctx, mutzig, warehouseId } = setup();
    expect(mutzig).toMatchObject({ purchase_price: 708, pack_purchase_price: 17_000, pack_cost_price: 17_500, other_ref: 'MUTZ50' });
    expect(mutzig.packs.map((p) => [p.name, p.units, p.is_purchase])).toEqual([['PALETTE', 24_000, 1]]);
    // Réception d'une palette à 18 000 : le revient garde ses 500 de frais.
    s.stock.receive(ctx, { warehouseId, lines: [{ articleId: mutzig.id, qty: 48_000, unitCost: 750, packCost: 18_000, packUnits: 24_000 }] });
    expect(s.catalogue.getArticle(mutzig.id)).toMatchObject({ purchase_price: 750, pack_purchase_price: 18_000, pack_cost_price: 18_500 });
    // Modifier la fiche sans toucher aux prix d'achat ne les arrondit pas.
    const again = s.catalogue.saveArticle(ctx.userId, { name: 'BIERE MUTZIG 50CL', unit: 'piece', vatRateId: mutzig.vat_rate_id, purchasePrice: 750, salePrice: 1_100 }, mutzig.id);
    expect(again).toMatchObject({ pack_purchase_price: 18_000, pack_cost_price: 18_500, sale_price: 1_100 });
  });

  it('garde l’unité de stock une fois l’article mouvementé', () => {
    const { s, ctx, mutzig, warehouseId } = setup();
    const base = { name: mutzig.name, unit: 'piece' as const, vatRateId: mutzig.vat_rate_id, purchasePrice: 708, salePrice: 1_000 };
    const withLiquid = { ...base, unitName: 'DEMI', packs: [{ name: 'PALETTE', contains: 24, salePrice: 24_000 }, { name: 'CANETTE', contains: 2, salePrice: 1_000 }] };
    // Sans mouvement, on peut encore descendre d'un niveau…
    const fresh = s.catalogue.saveArticle(ctx.userId, { ...withLiquid, name: 'Essai' }, s.catalogue.saveArticle(ctx.userId, { ...base, name: 'Essai', unitName: 'CANETTE' }).id);
    expect(fresh.unit_name).toBe('DEMI');
    // …mais plus après une réception : la CANETTE resterait comptée comme un DEMI.
    s.stock.receive(ctx, { warehouseId, lines: [{ articleId: mutzig.id, qty: 24_000, unitCost: 708 }] });
    expect(() => s.catalogue.saveArticle(ctx.userId, withLiquid, mutzig.id)).toThrow(/ne peut plus changer/);
    expect(() => s.catalogue.saveArticle(ctx.userId, { ...base, unitName: 'PALETTE', packs: [] }, mutzig.id)).toThrow(/ne peut plus changer/);
    // Renommer l'unité reste permis.
    expect(s.catalogue.saveArticle(ctx.userId, { ...base, unitName: 'CANETTE 50CL', packs: [{ name: 'PALETTE', contains: 24, salePrice: 24_000 }] }, mutzig.id).unit_name).toBe('CANETTE 50CL');
  });

  it('achète toujours dans le plus grand conditionnement', () => {
    const { s, ctx, tva } = setup();
    const a = s.catalogue.saveArticle(ctx.userId, {
      name: 'Ampoule',
      unit: 'piece',
      vatRateId: tva,
      purchasePrice: 100,
      salePrice: 200,
      packs: [
        { name: 'Carton', contains: 10, salePrice: 10_500 },
        { name: 'Paquet', contains: 10, salePrice: 1_500, purchase: true },
      ],
    });
    expect(a.packs.map((p) => p.is_purchase)).toEqual([1, 0]);
    expect(a.pack_purchase_price).toBe(10_000);
  });

  it('cherche en caisse une ligne par conditionnement, avec stock et dernier prix', () => {
    const { s, ctx, mutzig, warehouseId } = setup();
    s.stock.receive(ctx, { warehouseId, lines: [{ articleId: mutzig.id, qty: 30_000, unitCost: 708 }] });
    const rows = s.pos.searchForSale(ctx.storeId, 'mut');
    expect(rows.map((r) => [r.code, r.pack_name, r.stock, r.price, r.warehouse])).toEqual([
      ['BM501', 'PALETTE', 30_000, 24_000, 'Surface de vente'],
      ['BM501', 'CANETTE', 30_000, 1_000, 'Surface de vente'],
    ]);
    expect(s.pos.searchForSale(ctx.storeId, 'MUTZ50')).toHaveLength(2);

    s.pos.openSession(ctx, 0);
    const palette = mutzig.packs[0]!;
    s.pos.completeSale(ctx, {
      lines: [
        { articleId: mutzig.id, qty: 24_000, packId: palette.id },
        { articleId: mutzig.id, qty: 2_000 },
      ],
      payments: [{ method: 'CASH', amount: 26_000 }],
    });
    // Il reste 4 canettes : la palette reste listée mais marquée épuisée, sauf si on masque les épuisés.
    const after = s.pos.searchForSale(ctx.storeId, 'mutzig');
    expect(after.map((r) => [r.pack_name, r.stock, r.last_price, r.out_of_stock])).toEqual([
      ['PALETTE', 4_000, 24_000, true],
      ['CANETTE', 4_000, 1_000, false],
    ]);
    expect(s.pos.searchForSale(ctx.storeId, 'mutzig', { includeEmpty: false }).map((r) => r.pack_name)).toEqual(['CANETTE']);

    // Client au tarif de gros : prix de gros, et pas encore de dernier prix pour lui.
    const pro = s.customers.saveCustomer(ctx.userId, { name: 'Bar Le Relais', priceLevel: 'wholesale' });
    expect(s.pos.searchForSale(ctx.storeId, 'mutzig', { customerId: pro.id, includeEmpty: true }).map((r) => [r.pack_name, r.price, r.last_price])).toEqual([
      ['PALETTE', 23_000, null],
      ['CANETTE', 950, null],
    ]);
  });
});
