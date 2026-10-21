import { describe, expect, it } from 'vitest';
import { createServices, openDatabase } from '@superette/db';
import { createApi } from '../src/main/api';

const printer = new Proxy({}, { get: () => async () => undefined }) as never;
const sync = { now: async () => undefined, status: () => null } as never;
const system = { chooseFolder: async () => null, chooseBackupFile: async () => null, openFolder: async () => undefined, restore: () => undefined };

describe('ventes réelles et préparation fiscale par les écrans', () => {
  it('droits : le caissier n’y entre pas, et la préparation fiscale n’a aucune commande d’écriture', () => {
    const s = createServices(openDatabase(':memory:'));
    const { store, register, admin } = s.admin.bootstrap({ storeCode: 'DLA1', storeName: 'Superette Akwa', adminName: 'Steve', adminLogin: 'steve', adminPin: '1234' });
    s.admin.createUser(admin.id, { name: 'Awa', login: 'awa', pin: '5555', role: 'cashier', storeId: store.id, registerId: register.id });
    const tva = s.admin.listVatRates().find((r) => r.rate_bp === 1925)!.id;
    const riz = s.catalogue.saveArticle(admin.id, { name: 'Riz 5 kg', unit: 'piece', vatRateId: tva, purchasePrice: 3_000, salePrice: 5_000 }).id;
    const ctx = { storeId: store.id, registerId: register.id, userId: admin.id };
    s.stock.receive(ctx, { warehouseId: s.admin.salesWarehouse(store.id).id, lines: [{ articleId: riz, qty: 10_000, unitCost: 3_000 }] });
    s.pos.openSession(ctx, 0);
    const sale = s.pos.completeSale(ctx, { lines: [{ articleId: riz, qty: 2_000 }], payments: [{ method: 'CASH', amount: 10_000 }] });
    const api = createApi(s, printer, sync, 'test', system) as unknown as Record<string, (...a: unknown[]) => unknown>;
    const period = { from: '2000-01-01', to: '2100-12-31' };

    api['auth.login']!('awa', '5555');
    expect(() => api['realSales.operations']!(period)).toThrow(/droits/);
    expect(() => api['fiscalPrep.statement']!(period.from, period.to)).toThrow(/droits/);

    api['auth.login']!('steve', '1234');
    expect((api['realSales.operations']!(period) as unknown[]).length).toBe(1);
    const st = api['fiscalPrep.statement']!(period.from, period.to) as { totals: { ttc: number }; books: { matches: boolean } };
    expect(st).toMatchObject({ totals: { ttc: 10_000 }, books: { matches: true } });
    expect(api['fiscalPrep.propose']).toBeUndefined();
    expect(api['realSales.detail']!(sale.id)).toMatchObject({ total_ttc: 10_000 });
  });
});
