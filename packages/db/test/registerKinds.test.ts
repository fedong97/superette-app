import { beforeEach, describe, expect, it } from 'vitest';
import { type Context, type Services, createServices, openDatabase } from '../src';

let s: Services;
let ctx: Context;
let riz: string;
let adminId: string;
let mobile: string;
let banque: string;
let awa: string;

beforeEach(() => {
  s = createServices(openDatabase(':memory:'), () => new Date('2026-10-11T09:00:00Z'));
  const { store, register, admin } = s.admin.bootstrap({ storeCode: 'DLA1', storeName: 'Superette Akwa', adminName: 'Steve', adminLogin: 'steve', adminPin: '1234' });
  adminId = admin.id;
  const tva = s.admin.listVatRates()[0]!.id;
  riz = s.catalogue.saveArticle(admin.id, { name: 'Riz 5 kg', unit: 'piece', vatRateId: tva, purchasePrice: 3_000, salePrice: 5_000 }).id;
  s.stock.receive({ storeId: store.id, registerId: register.id, userId: admin.id }, { warehouseId: s.admin.salesWarehouse(store.id).id, lines: [{ articleId: riz, qty: 20_000, unitCost: 3_000 }] });
  mobile = s.admin.createRegister(adminId, store.id, '', 'electronic').id;
  banque = s.admin.createRegister(adminId, store.id, 'Banque SGC', 'bank').id;
  awa = s.admin.createUser(adminId, { name: 'Awa', login: 'awa', pin: '5555', role: 'cashier', storeId: store.id, registerId: register.id, emoneyRegisterId: mobile, bankRegisterId: banque }).id;
  ctx = { storeId: store.id, registerId: register.id, userId: awa };
});

const sell = (payments: { method: 'CASH' | 'MTN_MOMO' | 'ORANGE_MONEY' | 'CHEQUE'; amount: number; reference?: string }[], qty = 1) =>
  s.pos.completeSale(ctx, { lines: [{ articleId: riz, qty: qty * 1000 }], payments });

describe('caisses espèces, électroniques et banque', () => {
  it('crée une caisse par type et n’attribue que le bon type', () => {
    expect(s.admin.getRegister(mobile)).toMatchObject({ kind: 'electronic', name: 'Mobile 1' });
    expect(s.admin.getRegister(banque)).toMatchObject({ kind: 'bank', name: 'Banque SGC' });
    expect(s.admin.getUser(awa)).toMatchObject({ emoney_register_id: mobile, bank_register_id: banque });
    expect(() => s.admin.updateUser(adminId, awa, { registerId: mobile })).toThrow(/pas une caisse espèces/);
    expect(() => s.admin.updateUser(adminId, awa, { emoneyRegisterId: banque })).toThrow(/pas une caisse électronique/);
    expect(() => s.admin.activateRegister(s.admin.getRegister(mobile).activation_code)).toThrow(/espèces/);
  });

  it('une ouverture ouvre toutes les caisses ; chaque paiement va dans la caisse de son type', () => {
    s.pos.openSession(ctx, 10_000);
    const cash = s.pos.currentSession(ctx.registerId!)!;
    const emoney = s.pos.currentSession(mobile)!;
    expect(emoney).toMatchObject({ user_id: awa, opening_float: 0 });
    expect(s.pos.currentSession(banque)).not.toBeNull();

    // Moitié espèces, moitié MTN ; puis Orange et un chèque.
    sell([{ method: 'CASH', amount: 5_000 }, { method: 'MTN_MOMO', amount: 5_000, reference: 'MP1' }], 2);
    sell([{ method: 'ORANGE_MONEY', amount: 5_000, reference: 'OM1' }]);
    sell([{ method: 'CHEQUE', amount: 5_000, reference: 'CHQ 0042' }]);

    const zCash = s.pos.zReport(cash.id);
    expect(zCash).toMatchObject({ registerKind: 'cash', ticketCount: 3, netTtc: 20_000, declared: null });
    expect(zCash.byMethod.map((m) => [m.method, m.amount])).toEqual([['CASH', 5_000]]);
    expect(zCash.cash.expected).toBe(15_000);
    // Le reste des tickets de la caisse est montré avec la caisse qui l'a reçu.
    expect(zCash.elsewhere.map((m) => [m.method, m.registerName, m.amount])).toEqual([
      ['CHEQUE', 'Banque SGC', 5_000],
      ['MTN_MOMO', 'Mobile 1', 5_000],
      ['ORANGE_MONEY', 'Mobile 1', 5_000],
    ]);

    const zMobile = s.pos.zReport(emoney.id);
    expect(zMobile.declared!.map((d) => [d.method, d.expected, d.declared])).toEqual([
      ['MTN_MOMO', 5_000, null],
      ['ORANGE_MONEY', 5_000, null],
      ['CARD', 0, null],
    ]);

    // Clôture : le téléphone Orange montre 4 000, il manque 1 000.
    const closed = s.pos.closeDeclared(ctx, mobile, { MTN_MOMO: 5_000, ORANGE_MONEY: 4_000 });
    expect(closed.session).toMatchObject({ status: 'closed', expected_cash: 10_000, counted_cash: 9_000, difference: -1_000, z_number: 1 });
    expect(closed.declared!.find((d) => d.method === 'ORANGE_MONEY')).toMatchObject({ expected: 5_000, declared: 4_000 });
    expect(s.pos.pendingGaps(ctx.storeId).map((g) => g.register_id)).toEqual([mobile]);

    // L'écart va au compte Orange Money, pas au tiroir.
    const gap = s.accounting.entries(ctx.storeId).find((e) => e.label.includes('Mobile 1'))!;
    const accounts = s.accounting.listAccounts();
    const orange = accounts.find((a) => a.role === 'orange')!.id;
    const cashAccount = accounts.find((a) => a.role === 'cash')!.id;
    expect(gap.lines.find((l) => l.account === orange)).toMatchObject({ credit: 1_000 });
    expect(gap.lines.some((l) => l.account === cashAccount)).toBe(false);

    // Caisse électronique fermée : plus de paiement MTN tant qu'elle n'est pas rouverte.
    expect(() => sell([{ method: 'MTN_MOMO', amount: 5_000, reference: 'MP2' }])).toThrow(/Mobile 1 est fermée/);
    expect(s.pos.openLinked(ctx).map((x) => x.register_id)).toEqual([mobile]);
    expect(sell([{ method: 'MTN_MOMO', amount: 5_000, reference: 'MP2' }]).total_ttc).toBe(5_000);
  });

  it('un règlement client par MTN entre dans la caisse électronique', () => {
    s.pos.openSession(ctx, 0);
    const c = s.customers.saveCustomer(adminId, { name: 'Bar Le Wouri', creditLimit: 100_000 });
    sell([{ method: 'CASH', amount: 0 + 5_000 }]);
    s.pos.completeSale(ctx, { lines: [{ articleId: riz, qty: 2000 }], payments: [{ method: 'CUSTOMER_CREDIT', amount: 10_000 }], customerId: c.id });
    const session = s.pos.sessionFor(ctx, 'MTN_MOMO', s.pos.currentSession(ctx.registerId!)!.id);
    s.customers.receivePayment(ctx, { customerId: c.id, method: 'MTN_MOMO', amount: 10_000, reference: 'MP9', sessionId: session });
    expect(s.pos.zReport(session).declared!.find((d) => d.method === 'MTN_MOMO')!.expected).toBe(10_000);
  });
});
