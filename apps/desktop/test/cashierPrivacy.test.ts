import { beforeEach, describe, expect, it } from 'vitest';
import { type Services, createServices, openDatabase } from '@superette/db';
import { createApi } from '../src/main/api';

let s: Services;
let api: Record<string, (...a: unknown[]) => unknown>;
let riz: string;
const printed: string[] = [];

const printer = new Proxy({}, { get: (_t, name) => async (...a: unknown[]) => void printed.push(`${String(name)}:${String(a[0])}`) }) as never;
const sync = { now: async () => undefined, status: () => null } as never;
const system = { chooseFolder: async () => null, chooseBackupFile: async () => null, openFolder: async () => undefined, restore: () => undefined };

const login = (u: string, p: string) => api['auth.login']!(u, p);
const sell = (n: number) =>
  api['pos.sell']!({ lines: [{ articleId: riz, qty: n * 1000 }], payments: [{ method: 'CASH', amount: n * 5_000 }] }) as { id: string; number: string };

beforeEach(() => {
  printed.length = 0;
  s = createServices(openDatabase(':memory:'));
  const { store, register, admin } = s.admin.bootstrap({ storeCode: 'DLA1', storeName: 'Superette Akwa', adminName: 'Steve', adminLogin: 'steve', adminPin: '1234' });
  s.admin.createUser(admin.id, { name: 'Mireille', login: 'mireille', pin: '2222', role: 'manager', storeId: store.id });
  s.admin.createUser(admin.id, { name: 'Awa', login: 'awa', pin: '5555', role: 'cashier', storeId: store.id, registerId: register.id });
  const tva = s.admin.listVatRates()[0]!.id;
  riz = s.catalogue.saveArticle(admin.id, { name: 'Riz 5 kg', unit: 'piece', vatRateId: tva, purchasePrice: 3_000, salePrice: 5_000 }).id;
  s.stock.receive({ storeId: store.id, registerId: register.id, userId: admin.id }, { warehouseId: s.admin.salesWarehouse(store.id).id, lines: [{ articleId: riz, qty: 50_000, unitCost: 3_000 }] });
  api = createApi(s, printer, sync, 'test', system) as never;
});

describe('caissier sans les montants de la caisse', () => {
  it('ne voit ni attendu, ni ventes, ni journées, ni Z', async () => {
    login('awa', '5555');
    api['treasury.open']!(10_000, '2222');
    for (let i = 1; i <= 5; i++) sell(i);
    const state = api['treasury.state']!() as { canSeeAmounts: boolean };
    expect(state.canSeeAmounts).toBe(false);
    const day = api['treasury.myDay']!() as { session: { id: string }; exits: unknown[] };
    expect(day.exits).toEqual([]);
    expect(day.session).not.toHaveProperty('expected_cash');
    expect(() => api['treasury.session']!(day.session.id)).toThrow(/droits/);
    expect(() => api['treasury.sessions']!()).toThrow(/droits/);
    expect(() => api['pos.zReport']!(day.session.id)).toThrow(/droits/);
    expect(() => api['pos.printZ']!(day.session.id)).toThrow(/droits/);
    expect(() => api['treasury.printReport']!(day.session.id)).toThrow(/droits/);
    expect(() => api['treasury.countPreview']!({ 10000: 1 })).toThrow(/code/i);
    expect(() => api['treasury.close']!({ 10000: 1 }, { floatLeft: 0 })).toThrow(/droits/);
  });

  it('ne revoit et ne réimprime que ses trois dernières factures', async () => {
    login('awa', '5555');
    api['treasury.open']!(10_000, '2222');
    const sales = [1, 2, 3, 4, 5].map(sell);
    const listed = api['pos.sales']!({}) as { id: string }[];
    expect(listed.map((x) => x.id)).toEqual([sales[4]!.id, sales[3]!.id, sales[2]!.id]);
    expect(api['pos.sale']!(sales[2]!.id)).toMatchObject({ number: sales[2]!.number });
    expect(() => api['pos.sale']!(sales[1]!.id)).toThrow(/trois dernières/);
    await api['pos.printTicket']!(sales[4]!.id);
    expect(() => api['pos.printTicket']!(sales[0]!.id, { newSale: true })).toThrow(/trois dernières/);
    expect(() => api['pos.printInvoice']!(sales[0]!.id)).toThrow(/trois dernières/);
  });

  it('clôture à l’aveugle : bon de versement seul, écart validé par le gérant qui en saisit le motif', async () => {
    login('awa', '5555');
    api['treasury.open']!(10_000, '2222');
    sell(2); // 10 000 en espèces : attendu 20 000
    // Le gérant prélève, la caissière fait une dépense : elle ne voit que la sienne.
    const storeId = s.admin.station()!.store.id;
    const registerId = s.admin.listRegisters(storeId)[0]!.id;
    const id = (login: string) => s.admin.listUsers().find((u) => u.login === login)!.id;
    s.pos.cashOperation({ storeId, registerId, userId: id('mireille') }, 'OUT', 1_000, 'Tiroir trop plein');
    const cat = s.expenses.listCategories()[0]!;
    s.expenses.record({ storeId, registerId, userId: id('awa') }, { categoryId: cat.id, label: 'Sachets', amount: 500, method: 'CASH', atRegister: true });
    const day = api['treasury.myDay']!() as { exits: { nature: string; user_name: string }[] };
    expect(day.exits.map((x) => [x.nature, x.user_name])).toEqual([['Dépense', 'Awa']]);

    const short = { 10000: 1, 2000: 2 }; // 14 000 au lieu de 18 500 (ou 19 500)
    const blind = api['treasury.blindCount']!(short) as Record<string, unknown>;
    expect(blind).toEqual({ counted: 14_000, needsApproval: true });
    expect(() => api['treasury.closeBlind']!(short, { floatLeft: 5_000, gapReason: 'x' })).toThrow(/gérant/);
    const preview = api['treasury.countPreview']!(short, undefined, '2222') as { difference: number };
    expect(preview.difference).toBeLessThan(0);
    const done = api['treasury.closeBlind']!(short, { floatLeft: 5_000, gapReason: 'Monnaie mal rendue', supervisorPin: '2222' }) as Record<string, unknown>;
    expect(done).toMatchObject({ counted: 14_000, floatLeft: 5_000, deposit: 9_000 });
    expect(Object.keys(done).sort()).toEqual(['counted', 'deposit', 'floatLeft', 'sessionId', 'voucherId', 'voucherNumber']);
  });

  it('le gérant voit tout, et le droit se donne au caissier dans Droits par rôle', () => {
    login('mireille', '2222');
    expect((api['treasury.state']!() as { canSeeAmounts: boolean }).canSeeAmounts).toBe(true);
    login('steve', '1234');
    const matrix = s.admin.rightsMatrix();
    const cashier = matrix.find((r) => r.role === 'cashier')!;
    expect(cashier.rights).not.toContain('cash_amounts');
    expect(cashier.rights).not.toContain('sales');
    expect(matrix.find((r) => r.role === 'accountant')!.rights).toEqual(expect.arrayContaining(['cash_amounts', 'sales']));
  });
});
