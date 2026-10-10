import { beforeEach, describe, expect, it } from 'vitest';
import { type Context, type Services, createServices, openDatabase } from '../src';

let s: Services;
let ctx: Context;
let shop: string;
let reserve: string;
let lait: string;
let riz: string;

beforeEach(() => {
  s = createServices(openDatabase(':memory:'), () => new Date('2026-10-10T08:00:00Z'));
  const { store, register, admin } = s.admin.bootstrap({ storeCode: 'DLA1', storeName: 'Superette Akwa', adminName: 'Steve', adminLogin: 'steve', adminPin: '1234' });
  ctx = { storeId: store.id, registerId: register.id, userId: admin.id };
  shop = s.admin.salesWarehouse(store.id).id;
  reserve = s.admin.listWarehouses(store.id).find((w) => w.name === 'Réserve')!.id;
  const tva = s.admin.listVatRates()[0]!.id;
  lait = s.catalogue.saveArticle(admin.id, { name: 'Lait Nido', unit: 'piece', vatRateId: tva, purchasePrice: 2_700, salePrice: 3_250 }).id;
  riz = s.catalogue.saveArticle(admin.id, { name: 'Riz 5 kg', unit: 'piece', vatRateId: tva, purchasePrice: 3_600, salePrice: 4_500 }).id;
  s.stock.receive(ctx, {
    warehouseId: reserve,
    lines: [
      { articleId: lait, qty: 24_000, unitCost: 2_700, lotNumber: 'L42', expiry: '2027-03-01' },
      { articleId: riz, qty: 10_000, unitCost: 3_600 },
    ],
  });
});

const qtyIn = (wh: string, article: string) => s.stock.list(ctx.storeId, { warehouseId: wh }).find((r) => r.article_id === article)?.qty ?? 0;

describe('bons de transfert', () => {
  it('brouillon, expédition, réception partielle avec écart et lots conservés', () => {
    const t = s.transfers.create(ctx, { fromWarehouseId: reserve, toWarehouseId: shop, lines: [{ articleId: lait, qty: 12_000 }] });
    expect(t).toMatchObject({ number: 1, status: 'draft', from_name: 'Réserve', to_name: 'Surface de vente', line_count: 1, value: 32_400 });
    s.transfers.update(ctx, t.id, { fromWarehouseId: reserve, toWarehouseId: shop, lines: [{ articleId: lait, qty: 12_000 }, { articleId: riz, qty: 4_000, packPosition: 0 }] });
    expect(qtyIn(reserve, lait)).toBe(24_000);

    const shipped = s.transfers.ship(ctx, t.id, 'BR-77');
    expect(shipped).toMatchObject({ status: 'shipped', route_number: 'BR-77' });
    expect(qtyIn(reserve, lait)).toBe(12_000);
    expect(qtyIn(shop, lait)).toBe(0); // en route
    expect(() => s.transfers.update(ctx, t.id, { fromWarehouseId: reserve, toWarehouseId: shop, lines: [{ articleId: lait, qty: 1_000 }] })).toThrow(/expédié/);

    const done = s.transfers.receive(ctx, t.id, { receptionNumber: 'RC-5', lines: [{ articleId: lait, receivedQty: 11_000 }] });
    expect(done).toMatchObject({ status: 'received', reception_number: 'RC-5', gap_value: -2_700 });
    expect(qtyIn(shop, lait)).toBe(11_000);
    expect(qtyIn(shop, riz)).toBe(4_000);
    const lot = s.db.prepare('SELECT lot_number, expiry FROM lots WHERE warehouse_id = ? AND article_id = ?').get(shop, lait);
    expect(lot).toEqual({ lot_number: 'L42', expiry: '2027-03-01' });
    expect(s.transfers.movements(t.id).map((m) => [m.type, m.qty])).toEqual(
      expect.arrayContaining([['TRANSFER_OUT', -12_000], ['TRANSFER_IN', 11_000], ['TRANSFER_IN', 4_000]]),
    );
  });

  it('annuler un transfert expédié remet la marchandise au départ', () => {
    const t = s.transfers.create(ctx, { fromWarehouseId: reserve, toWarehouseId: shop, lines: [{ articleId: riz, qty: 3_000 }] });
    s.transfers.ship(ctx, t.id);
    expect(qtyIn(reserve, riz)).toBe(7_000);
    expect(s.transfers.cancel(ctx, t.id).status).toBe('cancelled');
    expect(qtyIn(reserve, riz)).toBe(10_000);
    expect(() => s.transfers.create(ctx, { fromWarehouseId: shop, toWarehouseId: shop, lines: [{ articleId: riz, qty: 1 }] })).toThrow(/identiques/);
  });
});
