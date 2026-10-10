import { beforeEach, describe, expect, it } from 'vitest';
import { type Context, type Services, createServices, openDatabase } from '../src';

let s: Services;
let admin: Context;
let rose: Context;
let wh: string;
let biere: string;
let now = new Date('2026-10-09T08:00:00Z');

beforeEach(() => {
  now = new Date('2026-10-09T08:00:00Z');
  s = createServices(openDatabase(':memory:'), () => now);
  const b = s.admin.bootstrap({ storeCode: 'DLA1', storeName: 'Superette Akwa', adminName: 'Steve', adminLogin: 'steve', adminPin: '1234' });
  admin = { storeId: b.store.id, registerId: b.register.id, userId: b.admin.id };
  const r = s.admin.createUser(b.admin.id, { name: 'Rose', login: 'rose', pin: '7777', role: 'stock', storeId: b.store.id });
  rose = { ...admin, userId: r.id };
  wh = s.admin.salesWarehouse(b.store.id).id;
  const tva = s.admin.listVatRates()[0]!.id;
  biere = s.catalogue.saveArticle(b.admin.id, { name: 'Bière 33 Export', unit: 'piece', vatRateId: tva, purchasePrice: 500, salePrice: 650 }).id;
  s.stock.receive(admin, { warehouseId: wh, lines: [{ articleId: biere, qty: 15_000, unitCost: 500 }] });
});

describe('monitoring du stock', () => {
  it('stock avant et après chaque modification, demande validée par le gérant', () => {
    now = new Date('2026-10-09T10:00:00Z');
    s.pos.openSession(admin, 0);
    s.pos.completeSale(admin, { lines: [{ articleId: biere, qty: 3_000 }], payments: [{ method: 'CASH', amount: 1_950 }] });

    now = new Date('2026-10-09T11:00:00Z');
    const req = s.monitoring.request(rose, { articleId: biere, warehouseId: wh, newQty: 10_000, reason: 'Casier cassé non déclaré' });
    expect(req).toMatchObject({ status: 'pending', before_qty: 12_000, requested_qty: 10_000, delta: -2_000, requested_by_name: 'Rose' });
    expect(s.stock.list(admin.storeId, { warehouseId: wh })[0]!.qty).toBe(12_000); // pas encore validée
    expect(() => s.monitoring.decide(admin, req.id, false, '')).toThrow(/pourquoi/);
    s.monitoring.decide(admin, req.id, true, null);
    expect(s.stock.list(admin.storeId, { warehouseId: wh })[0]!.qty).toBe(10_000);
    expect(() => s.monitoring.decide(admin, req.id, true, null)).toThrow(/déjà traitée/);

    const h = s.monitoring.changes(admin.storeId, { articleId: biere, warehouseId: wh, from: '2026-10-09T09:00:00Z', to: '2026-10-09T23:59:59Z' });
    expect(h.opening).toBe(15_000);
    expect(h.rows.map((r) => [r.type, r.before, r.delta, r.after])).toEqual([
      ['SALE', 15_000, -3_000, 12_000],
      ['INVENTORY_ADJUST', 12_000, -2_000, 10_000],
    ]);
    expect(h.rows[1]!.reason).toBe('Correction n° 1 : Casier cassé non déclaré');

    const direct = s.monitoring.request(admin, { articleId: biere, warehouseId: wh, newQty: 11_000, reason: 'Recomptage' }, true);
    expect(direct.status).toBe('approved');
    expect(s.stock.list(admin.storeId, { warehouseId: wh })[0]!.qty).toBe(11_000);
  });
});
