import { agingBucket, allocateOldestFirst, creditCheck } from '@superette/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { type Context, type Services, createServices, openDatabase } from '../src';

let now = new Date('2026-10-06T08:00:00Z');
const clock = () => now;
const advanceDays = (d: number) => {
  now = new Date(now.getTime() + d * 86_400_000);
};

let s: Services;
let ctx: Context;
let tva: string;
let articleId: string;
let cashierId: string;

function setup() {
  now = new Date('2026-10-06T08:00:00Z');
  s = createServices(openDatabase(':memory:'), clock);
  const { store, register, admin } = s.admin.bootstrap({ storeCode: 'DLA1', storeName: 'Superette Akwa', adminName: 'Steve', adminLogin: 'steve', adminPin: '1234' });
  ctx = { storeId: store.id, registerId: register.id, userId: admin.id };
  tva = s.admin.listVatRates().find((r) => r.rate_bp === 1925)!.id;
  articleId = s.catalogue.saveArticle(admin.id, { name: 'Riz 5 kg', unit: 'piece', vatRateId: tva, purchasePrice: 3_000, salePrice: 5_000 }).id;
  s.stock.receive(ctx, { warehouseId: s.admin.salesWarehouse(store.id).id, lines: [{ articleId, qty: 100_000, unitCost: 3_000 }] });
  cashierId = s.admin.createUser(admin.id, { name: 'Awa', login: 'awa', role: 'cashier', pin: '5678', storeId: store.id }).id;
  s.pos.openSession(ctx, 10_000);
}

const sell = (customerId: string | null, qty: number, payments: { method: 'CASH' | 'CUSTOMER_CREDIT'; amount: number }[], extra = {}) =>
  s.pos.completeSale(ctx, { lines: [{ articleId, qty: qty * 1000 }], payments, customerId, ...extra });

describe('crédit client (règles)', () => {
  it('lettre les règlements sur les ventes les plus anciennes', () => {
    const items = allocateOldestFirst(
      [
        { id: 'a', amount: 10_000 },
        { id: 'b', amount: 5_000 },
        { id: 'c', amount: 8_000 },
      ],
      12_000,
    );
    expect(items.map((i) => i.remaining)).toEqual([0, 3_000, 8_000]);
  });

  it('classe le retard et contrôle le plafond', () => {
    expect(agingBucket('2026-10-06', '2026-10-06')).toBe('current');
    expect(agingBucket('2026-10-01', '2026-10-06')).toBe('d30');
    expect(agingBucket('2026-07-01', '2026-10-06')).toBe('older');
    expect(creditCheck(40_000, 50_000, 15_000)).toEqual({ allowed: false, available: 10_000, over: 5_000 });
  });
});

describe('clients et ventes à crédit', () => {
  beforeEach(setup);

  it('vend à crédit dans la limite du plafond, au-delà avec un gérant', () => {
    const mballa = s.customers.saveCustomer(ctx.userId, { name: 'Restaurant Chez Mballa', phone: '677 00 11 22', creditLimit: 50_000, paymentTermsDays: 15 });
    expect(mballa.code).toBe('CLI-DLA11-00001');
    const nolimit = s.customers.saveCustomer(ctx.userId, { name: 'M. Etoundi' });

    expect(() => sell(null, 1, [{ method: 'CUSTOMER_CREDIT', amount: 5_000 }])).toThrow('Choisissez le client');
    expect(() => sell(nolimit.id, 1, [{ method: 'CUSTOMER_CREDIT', amount: 5_000 }])).toThrow("pas de plafond");

    // 8 sacs : acompte de 10 000 en espèces, 30 000 à crédit, échéance à 15 jours.
    const sale = sell(mballa.id, 8, [
      { method: 'CASH', amount: 10_000 },
      { method: 'CUSTOMER_CREDIT', amount: 30_000 },
    ]);
    expect(sale).toMatchObject({ customer_id: mballa.id, customer_name: 'Restaurant Chez Mballa', due_date: '2026-10-21' });
    expect(s.customers.account(ctx.storeId, mballa.id)).toMatchObject({ balance: 30_000, available: 20_000, overdue: 0 });

    expect(() => sell(mballa.id, 5, [{ method: 'CUSTOMER_CREDIT', amount: 25_000 }])).toThrow(/dépassé de 5.000 FCFA/);
    const cashier = { ...ctx, userId: cashierId };
    expect(() =>
      s.pos.completeSale(cashier, { lines: [{ articleId, qty: 5000 }], payments: [{ method: 'CUSTOMER_CREDIT', amount: 25_000 }], customerId: mballa.id, creditAuthorizedBy: cashierId }),
    ).toThrow('accord du gérant');
    s.pos.completeSale(cashier, { lines: [{ articleId, qty: 5000 }], payments: [{ method: 'CUSTOMER_CREDIT', amount: 25_000 }], customerId: mballa.id, creditAuthorizedBy: ctx.userId });
    expect(s.customers.account(ctx.storeId, mballa.id).balance).toBe(55_000);
    // Une vente au comptant avec un client nommé ne change pas son compte.
    sell(mballa.id, 1, [{ method: 'CASH', amount: 5_000 }]);
    expect(s.customers.account(ctx.storeId, mballa.id).balance).toBe(55_000);
  });

  it('retour au compte, règlements, retard, relevé et balance âgée', () => {
    const c = s.customers.saveCustomer(ctx.userId, { name: 'Boulangerie du Port', creditLimit: 200_000, paymentTermsDays: 30 });
    const first = sell(c.id, 10, [{ method: 'CUSTOMER_CREDIT', amount: 50_000 }]);
    advanceDays(10);
    sell(c.id, 4, [{ method: 'CUSTOMER_CREDIT', amount: 20_000 }]);

    // Deux sacs rendus sur la première vente : le compte est crédité.
    s.pos.returnSale(ctx, { originalSaleId: first.id, lines: [{ lineId: first.lines[0]!.id, qty: 2000 }], refundMethod: 'CUSTOMER_CREDIT', supervisorId: ctx.userId, reason: 'Sacs abîmés' });
    expect(s.customers.account(ctx.storeId, c.id).balance).toBe(60_000);
    const walkIn = sell(null, 1, [{ method: 'CASH', amount: 5_000 }]);
    expect(() =>
      s.pos.returnSale(ctx, { originalSaleId: walkIn.id, lines: [{ lineId: walkIn.lines[0]!.id, qty: 1000 }], refundMethod: 'CUSTOMER_CREDIT', supervisorId: ctx.userId, reason: 'x' }),
    ).toThrow('pas de client');

    expect(() => s.customers.receivePayment(ctx, { customerId: c.id, method: 'MTN_MOMO', amount: 10_000 })).toThrow('Référence obligatoire');
    expect(() => s.customers.receivePayment(ctx, { customerId: c.id, method: 'CASH', amount: 70_000 })).toThrow('dépasse');
    const session = s.pos.currentSession(ctx.registerId!)!;
    const pay = s.customers.receivePayment(ctx, { customerId: c.id, method: 'CASH', amount: 25_000, sessionId: session.id });
    expect(pay.number).toBe('RC-DLA11-00001');
    s.customers.receivePayment(ctx, { customerId: c.id, method: 'ORANGE_MONEY', amount: 5_000, reference: 'PP261016.0912.B5', sessionId: session.id });

    // Lettrage : 30 000 réglés + 10 000 retournés soldent la première vente (50 000) à 10 000 près.
    advanceDays(25);
    const account = s.customers.account(ctx.storeId, c.id);
    expect(account.balance).toBe(30_000);
    expect(account.openItems.map((i) => [i.remaining, i.days_late, i.bucket])).toEqual([
      [10_000, 5, 'd30'],
      [20_000, 0, 'current'],
    ]);
    expect(account.overdue).toBe(10_000);

    const st = s.customers.statement(ctx.storeId, c.id);
    expect(st.lines.map((l) => [l.kind, l.debit, l.credit, l.balance])).toEqual([
      ['sale', 50_000, 0, 50_000],
      ['sale', 20_000, 0, 70_000],
      ['return', 0, 10_000, 60_000],
      ['payment', 0, 25_000, 35_000],
      ['payment', 0, 5_000, 30_000],
    ]);
    expect(s.customers.statement(ctx.storeId, c.id, { from: '2026-10-10' })).toMatchObject({ opening: 50_000, closing: 30_000 });

    const aging = s.customers.receivables(ctx.storeId);
    expect(aging.customers).toHaveLength(1);
    expect(aging.totals).toMatchObject({ balance: 30_000, current: 20_000, d30: 10_000 });
    expect(s.customers.listCustomers(ctx.storeId)[0]).toMatchObject({ balance: 30_000, overdue: 10_000 });

    // Le règlement en espèces entre dans le tiroir : le Z l'attend.
    const z = s.pos.zReport(session.id);
    expect(z.customerReceipts.map((r) => [r.method, r.amount])).toEqual([
      ['CASH', 25_000],
      ['ORANGE_MONEY', 5_000],
    ]);
    expect(z.cash.expected).toBe(10_000 + 5_000 + 25_000);
  });
});
