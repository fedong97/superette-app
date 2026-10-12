import { beforeEach, describe, expect, it } from 'vitest';
import { type Services, createServices, openDatabase } from '@superette/db';
import { createApi } from '../src/main/api';

let s: Services;
let api: Record<string, (...a: unknown[]) => unknown>;
let riz: string;
let now: Date;

const printer = new Proxy({}, { get: () => async () => undefined }) as never;
const sync = { now: async () => undefined } as never;
const system = { chooseFolder: async () => null, chooseBackupFile: async () => null, openFolder: async () => undefined, restore: () => undefined };
const sell = () => api['pos.sell']!({ lines: [{ articleId: riz, qty: 1_000 }], payments: [{ method: 'CASH', amount: 5_000 }] });

beforeEach(() => {
  now = new Date('2026-10-12T10:00:00');
  s = createServices(openDatabase(':memory:'), () => now, () => 'pc-de-la-caisse');
  const { store, register, admin } = s.admin.bootstrap({ storeCode: 'DLA1', storeName: 'Superette Akwa', adminName: 'Steve', adminLogin: 'steve', adminPin: '1234' });
  s.admin.createUser(admin.id, { name: 'Awa', login: 'awa', pin: '5555', role: 'cashier', storeId: store.id, registerId: register.id });
  const tva = s.admin.listVatRates()[0]!.id;
  riz = s.catalogue.saveArticle(admin.id, { name: 'Riz 5 kg', unit: 'piece', vatRateId: tva, purchasePrice: 3_000, salePrice: 5_000 }).id;
  const ctx = { storeId: store.id, registerId: register.id, userId: admin.id };
  s.stock.receive(ctx, { warehouseId: s.admin.salesWarehouse(store.id).id, lines: [{ articleId: riz, qty: 10_000, unitCost: 3_000 }] });
  s.pos.openSession(ctx, 10_000);
  api = createApi(s, printer, sync, 'test', system) as never;
});

describe('licence dans l’application', () => {
  it('vend pendant l’essai, plus après ; seul l’administrateur active une licence', () => {
    api['auth.login']!('awa', '5555');
    expect((api['app.state']!() as { license: { state: string; daysLeft: number } }).license).toMatchObject({ state: 'trial', daysLeft: 15 });
    expect(sell()).toMatchObject({ number: expect.anything() });

    now = new Date('2026-10-30T10:00:00');
    expect(sell).toThrow(/essai est terminée/);
    expect((api['app.state']!() as { license: { canSell: boolean } }).license.canSell).toBe(false);
    expect(() => api['license.activate']!('SG1.x.y')).toThrow(/administrateur/);

    api['auth.login']!('steve', '1234');
    expect(() => api['license.activate']!('SG1.x.y')).toThrow(/incorrecte/);
    expect(api['license.status']!()).toMatchObject({ state: 'trial_over', machineCode: s.license.machineCode() });
  });
});
