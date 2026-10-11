import { beforeEach, describe, expect, it } from 'vitest';
import { type Services, createServices, openDatabase } from '@superette/db';
import { createApi } from '../src/main/api';

let s: Services;
let api: Record<string, (...a: unknown[]) => unknown>;
let riz: string;
let wh: string;
const printed: string[] = [];

const printer = new Proxy({}, { get: (_t, name) => async (...a: unknown[]) => void printed.push(`${String(name)}:${String(a[0])}`) }) as never;
const sync = { now: async () => undefined, status: () => null } as never;
const system = { chooseFolder: async () => null, chooseBackupFile: async () => null, openFolder: async () => undefined, restore: () => undefined };

beforeEach(() => {
  printed.length = 0;
  s = createServices(openDatabase(':memory:'));
  const { store, register, admin } = s.admin.bootstrap({ storeCode: 'DLA1', storeName: 'Superette Akwa', adminName: 'Steve', adminLogin: 'steve', adminPin: '1234' });
  s.admin.createUser(admin.id, { name: 'Mireille', login: 'mireille', pin: '2222', role: 'manager', storeId: store.id });
  s.admin.createUser(admin.id, { name: 'Jean', login: 'jean', pin: '4444', role: 'stock', storeId: store.id });
  s.admin.createUser(admin.id, { name: 'Awa', login: 'awa', pin: '5555', role: 'cashier', storeId: store.id, registerId: register.id });
  const tva = s.admin.listVatRates()[0]!.id;
  riz = s.catalogue.saveArticle(admin.id, { name: 'Riz 5 kg', unit: 'piece', vatRateId: tva, purchasePrice: 3_000, salePrice: 5_000 }).id;
  wh = s.admin.salesWarehouse(store.id).id;
  s.stock.receive({ storeId: store.id, registerId: register.id, userId: admin.id }, { warehouseId: wh, lines: [{ articleId: riz, qty: 10_000, unitCost: 3_000 }] });
  api = createApi(s, printer, sync, 'test', system) as never;
});

describe('droits des inventaires', () => {
  it('le magasinier compte, seul le gérant crée et clôture', async () => {
    api['auth.login']!('mireille', '2222');
    const inv = api['inventories.create']!({ warehouseId: wh, kind: 'global' }) as { id: string };

    api['auth.login']!('jean', '4444');
    expect(() => api['inventories.create']!({ warehouseId: wh, kind: 'global' })).toThrow(/droits/);
    api['inventories.setCount']!(inv.id, riz, 9_000, null);
    await api['inventories.printSheet']!(inv.id);
    expect(printed).toEqual([`inventorySheet:${inv.id}`]);
    expect(() => api['inventories.close']!(inv.id)).toThrow(/droits/);
    expect(() => api['inventories.cancel']!(inv.id)).toThrow(/droits/);
    expect(() => api['inventories.removeArticle']!(inv.id, riz)).toThrow(/droits/);

    api['auth.login']!('awa', '5555');
    expect(() => api['inventories.list']!()).toThrow(/droits/);
    expect(() => api['inventories.setCount']!(inv.id, riz, 1_000, null)).toThrow(/droits/);

    api['auth.login']!('mireille', '2222');
    expect(api['inventories.close']!(inv.id)).toMatchObject({ status: 'closed', gap_value: -3_000 });
    expect(s.stock.list(s.admin.station()!.store.id, { warehouseId: wh })[0]!.qty).toBe(9_000);
  });
});
