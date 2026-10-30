import { beforeEach, describe, expect, it } from 'vitest';
import { type Services, createServices, openDatabase } from '@superette/db';
import { createApi } from '../src/main/api';

let s: Services;
let api: Record<string, (...a: unknown[]) => unknown>;
let registerId: string;
let storeId: string;
let riz: string;

const printer = new Proxy({}, { get: () => async () => undefined }) as never;
const sync = { now: async () => undefined, status: () => null } as never;
const system = { chooseFolder: async () => null, chooseBackupFile: async () => null, openFolder: async () => undefined, restore: () => undefined };
const login = (u: string, p: string) => api['auth.login']!(u, p);
type Overview = {
  today: { revenue: number; tickets: number; top: { name: string }[] } | null;
  yesterday: unknown;
  registers: { id: string; status: string }[];
  attention: { key: string; count: number }[];
  activity: { type: string }[];
  stock: { rupture: { count: number } } | null;
  mine: { id: string; status: string; net: number } | null;
  cashInDrawer: number;
};
const overview = () => api['home.overview']!() as Promise<Overview>;

beforeEach(() => {
  s = createServices(openDatabase(':memory:'));
  const { store, register, admin } = s.admin.bootstrap({ storeCode: 'DLA1', storeName: 'Superette Akwa', adminName: 'Steve', adminLogin: 'steve', adminPin: '1234' });
  storeId = store.id;
  registerId = register.id;
  s.admin.createUser(admin.id, { name: 'Awa', login: 'awa', pin: '5555', role: 'cashier', storeId, registerId });
  const tva = s.admin.listVatRates()[0]!.id;
  riz = s.catalogue.saveArticle(admin.id, { name: 'Riz', unit: 'piece', vatRateId: tva, purchasePrice: 700, salePrice: 1_000 }).id;
  s.catalogue.saveArticle(admin.id, { name: 'Sucre', unit: 'piece', vatRateId: tva, purchasePrice: 500, salePrice: 800 });
  s.stock.receive({ storeId, registerId, userId: admin.id }, { warehouseId: s.admin.salesWarehouse(storeId).id, lines: [{ articleId: riz, qty: 10_000, unitCost: 700 }] });
  api = createApi(s, printer, sync, 'test', system) as never;
});

describe("page d'accueil (0.103.0)", () => {
  it('le gérant voit ses chiffres, ses caisses, ses points d’attention et l’activité ; le caissier seulement sa caisse', async () => {
    login('awa', '5555');
    api['treasury.open']!(5_000);
    s.pos.completeSale({ storeId, registerId, userId: s.admin.listUsers().find((u) => u.login === 'awa')!.id }, { lines: [{ articleId: riz, qty: 2_000 }], payments: [{ method: 'CASH', amount: 2_000 }] });
    const cashier = await overview();
    expect(cashier).toMatchObject({ today: null, yesterday: null, registers: [], attention: [], activity: [], stock: null });
    expect(cashier.mine).toMatchObject({ id: registerId, status: 'open', net: 2_000 });

    login('steve', '1234');
    const manager = await overview();
    expect(manager.today).toMatchObject({ revenue: 2_000, tickets: 1, top: [{ name: 'Riz' }] });
    expect(manager.registers.find((r) => r.id === registerId)).toMatchObject({ status: 'open' });
    expect(manager.cashInDrawer).toBe(7_000);
    expect(manager.activity.map((a) => a.type)).toEqual(['sale', 'reception']);
    // Le sucre n'a jamais été reçu : il est en rupture, et le point d'attention le dit.
    expect(manager.stock?.rupture.count).toBe(1);
    expect(manager.attention.find((a) => a.key === 'rupture')?.count).toBe(1);
  });
});
