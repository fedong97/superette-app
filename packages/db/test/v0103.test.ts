import { beforeEach, describe, expect, it } from 'vitest';
import { type Context, type Services, createServices, openDatabase } from '../src';

let s: Services;
let ctx: Context;
let adminId: string;
let storeId: string;
let registerId: string;
let riz: string;
let now = new Date('2026-10-30T09:00:00Z');

const later = (minutes: number) => {
  now = new Date(now.getTime() + minutes * 60_000);
};
const localDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const localTime = (d: Date) => d.toTimeString().slice(0, 8);

beforeEach(() => {
  now = new Date('2026-10-30T09:00:00Z');
  s = createServices(openDatabase(':memory:'), () => now);
  const { store, register, admin } = s.admin.bootstrap({ storeCode: 'DLA1', storeName: 'Superette Akwa', adminName: 'Steve', adminLogin: 'steve', adminPin: '1234' });
  adminId = admin.id;
  storeId = store.id;
  registerId = register.id;
  ctx = { storeId, registerId, userId: adminId };
  const tva = s.admin.listVatRates()[0]!.id;
  riz = s.catalogue.saveArticle(adminId, { name: 'Riz', unit: 'piece', vatRateId: tva, purchasePrice: 700, salePrice: 1_000 }).id;
  s.stock.receive(ctx, { warehouseId: s.admin.salesWarehouse(storeId).id, lines: [{ articleId: riz, qty: 10_000, unitCost: 700 }] });
});

describe("accueil du gérant (0.103.0)", () => {
  it('compare la journée à la même heure, et donne les règlements du jour', () => {
    s.pos.openSession(ctx, 5_000);
    later(10);
    const before = new Date(now);
    later(10);
    s.pos.completeSale(ctx, { lines: [{ articleId: riz, qty: 2_000 }], payments: [{ method: 'CASH', amount: 2_000 }] });
    const day = localDay(now);
    expect(s.reports.daily(storeId, day)).toMatchObject({ ticketCount: 1, revenueTtc: 2_000 });
    expect(s.reports.daily(storeId, day, localTime(before))).toMatchObject({ ticketCount: 0, revenueTtc: 0, byHour: [] });
    expect(s.reports.daily(storeId, day, localTime(now))).toMatchObject({ ticketCount: 1 });

    const jean = s.customers.saveCustomer(adminId, { name: 'JEAN', creditLimit: 50_000 });
    s.pos.completeSale(ctx, { customerId: jean.id, lines: [{ articleId: riz, qty: 3_000 }], payments: [{ method: 'CUSTOMER_CREDIT', amount: 3_000 }] });
    later(5);
    s.customers.receivePayment(ctx, { customerId: jean.id, amount: 1_500, method: 'CASH' });
    expect(s.reports.receipts(storeId, day)).toBe(1_500);
    expect(s.reports.receipts(storeId, day, localTime(before))).toBe(0);
  });

  it("montre l'activité du magasin, la plus récente d'abord, sans les pièces annulées", () => {
    s.pos.openSession(ctx, 5_000);
    later(1);
    const sale = s.pos.completeSale(ctx, { lines: [{ articleId: riz, qty: 1_000 }], payments: [{ method: 'CASH', amount: 1_000 }] });
    later(1);
    const session = s.pos.currentSession(registerId)!.id;
    s.cashdesk.cashOut(ctx, session, { type: 'other', accountId: '4711', amount: 500, method: 'CASH', label: 'Taxi' }, adminId);
    later(1);
    const entry = s.cashdesk.cashIn(ctx, session, { type: 'other', accountId: '4711', amount: 300, method: 'CASH', label: 'Erreur' });
    s.cashdesk.cancel(ctx, entry.id, adminId, 'Saisie en double');
    const feed = s.reports.activity(storeId, 10);
    expect(feed.map((a) => [a.type, a.amount])).toEqual([
      ['cash_out', 500],
      ['sale', 1_000],
      ['reception', 7_000],
    ]);
    expect(feed[1]).toMatchObject({ number: sale.number, who: 'Steve', register: expect.any(String) });
    expect(feed[0]).toMatchObject({ label: 'Taxi' });
  });
});
