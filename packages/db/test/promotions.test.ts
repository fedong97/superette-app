import { receiptToText } from '@superette/core';
import { describe, expect, it } from 'vitest';
import { createServices, openDatabase } from '../src';

function setup() {
  let now = new Date('2026-10-10T09:00:00Z');
  const s = createServices(openDatabase(':memory:'), () => now);
  const { store, register, admin } = s.admin.bootstrap({ storeCode: 'DLA1', storeName: 'Superette Akwa', adminName: 'Steve', adminLogin: 'steve', adminPin: '1234' });
  const ctx = { storeId: store.id, registerId: register.id, userId: admin.id };
  const cashier = s.admin.createUser(admin.id, { name: 'Awa', login: 'awa', pin: '5678', role: 'cashier', storeId: store.id });
  const tva = s.admin.listVatRates().find((r) => r.rate_bp === 1925)!.id;
  const savon = s.catalogue.saveArticle(admin.id, { name: 'Savon Azur', unit: 'piece', vatRateId: tva, purchasePrice: 0, salePrice: 400 });
  const lait = s.catalogue.saveArticle(admin.id, { name: 'Lait Nido 400 g', unit: 'piece', vatRateId: tva, purchasePrice: 0, salePrice: 2500 });
  s.stock.receive(ctx, { warehouseId: s.admin.salesWarehouse(store.id).id, lines: [{ articleId: savon.id, qty: 50_000, unitCost: 250 }, { articleId: lait.id, qty: 20_000, unitCost: 1800 }] });
  return { s, ctx, cashierCtx: { ...ctx, userId: cashier.id }, savon, lait, setNow: (iso: string) => (now = new Date(iso)) };
}

describe('promotions en caisse', () => {
  it('applique les promotions du jour sans accord du gérant, sur le ticket et au rapport Z', () => {
    const { s, ctx, cashierCtx, savon, lait } = setup();
    const p3 = s.promotions.save(ctx.userId, { name: 'Savon 3 pour 2', kind: 'x_for_y', articleId: savon.id, storeId: null, startsOn: '2026-10-01', endsOn: '2026-10-31', buyQty: 3, payQty: 2 });
    s.promotions.save(ctx.userId, { name: 'Nido à 2 200', kind: 'price', articleId: lait.id, storeId: ctx.storeId, startsOn: '2026-10-10', endsOn: '2026-10-12', promoPrice: 2200 });
    expect(s.promotions.activeRules(ctx.storeId).map((r) => r.name).sort()).toEqual(['Nido à 2 200', 'Savon 3 pour 2']);

    s.pos.openSession(cashierCtx, 0);
    const sale = s.pos.completeSale(cashierCtx, {
      lines: [
        { articleId: savon.id, qty: 3000 },
        { articleId: lait.id, qty: 2000 },
      ],
      payments: [{ method: 'CASH', amount: 10_000 }],
    });
    // 3 savons = 1 200 - 400 ; 2 laits = 5 000 - 600.
    expect(sale).toMatchObject({ total_ttc: 800 + 4400, total_promo: 1000, total_discount: 0, change_given: 4800 });
    expect(sale.lines.map((l) => [l.promo, l.promotion_name, l.total_ttc])).toEqual([
      [400, 'Savon 3 pour 2', 800],
      [600, 'Nido à 2 200', 4400],
    ]);
    const text = receiptToText(s.receipts.ticket(sale.id), 48);
    expect(text).toMatch(/Savon Azur\s+1 200\n\s+3 x 400\n\s+Promo Savon 3 pour 2\s+-400/);
    expect(text).toMatch(/Vous avez économisé\s+1 000/);
    expect(s.pos.zReport(sale.session_id).promotions).toBe(1000);
    expect(s.promotions.get(p3.id)).toMatchObject({ status: 'running', sold_qty: 3000, given: 400 });
  });

  it('respecte les dates, le magasin et l’arrêt de la promotion', () => {
    const { s, ctx, savon, lait, setNow } = setup();
    const other = s.admin.createStore(ctx.userId, { storeCode: 'YDE1', storeName: 'Superette Bastos' });
    const p = s.promotions.save(ctx.userId, { name: 'Lait Bastos', kind: 'price', articleId: lait.id, storeId: other.id, startsOn: '2026-10-01', endsOn: '2026-10-31', promoPrice: 2000 });
    expect(s.pos.priceLines(ctx.storeId, [{ articleId: lait.id, qty: 1000 }])[0]!.promo).toBe(0);
    expect(s.pos.priceLines(other.id, [{ articleId: lait.id, qty: 1000 }])[0]!.promo).toBe(500);
    const lot = s.promotions.save(ctx.userId, { name: 'Savon 3 pour 1 000', kind: 'lot', articleId: savon.id, storeId: null, startsOn: '2026-11-01', endsOn: '2026-11-30', buyQty: 3, lotPrice: 1000 });
    expect(s.promotions.get(lot.id).status).toBe('scheduled');
    expect(s.pos.priceLines(ctx.storeId, [{ articleId: savon.id, qty: 3000 }])[0]!.promo).toBe(0);
    setNow('2026-11-02T09:00:00Z');
    expect(s.pos.priceLines(ctx.storeId, [{ articleId: savon.id, qty: 3000 }])[0]!.promo).toBe(200);
    expect(s.promotions.get(p.id).status).toBe('ended');
    s.promotions.setActive(ctx.userId, lot.id, false);
    expect(s.promotions.get(lot.id).status).toBe('stopped');
    expect(s.pos.priceLines(ctx.storeId, [{ articleId: savon.id, qty: 3000 }])[0]!.promo).toBe(0);
    expect(s.db.prepare("SELECT COUNT(*) FROM outbox WHERE entity = 'promotion'").pluck().get()).toBe(3);
  });

  it('refuse les promotions incohérentes', () => {
    const { s, ctx, savon } = setup();
    const base = { name: 'Savon', articleId: savon.id, storeId: null, startsOn: '2026-10-01', endsOn: '2026-10-31' };
    expect(() => s.promotions.save(ctx.userId, { ...base, kind: 'price', promoPrice: 450 })).toThrow('inférieur au prix normal');
    expect(() => s.promotions.save(ctx.userId, { ...base, kind: 'x_for_y', buyQty: 2, payQty: 2 })).toThrow('payés');
    expect(() => s.promotions.save(ctx.userId, { ...base, kind: 'price', promoPrice: 300, endsOn: '2026-09-30' })).toThrow('finit avant');
  });
});
