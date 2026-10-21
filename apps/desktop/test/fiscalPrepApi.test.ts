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

  it('cloisonne les vues : la gestion et la vue fiscale sont deux droits, et inscrire une déclaration en est un troisième', () => {
    const s = createServices(openDatabase(':memory:'));
    const { store, register, admin } = s.admin.bootstrap({ storeCode: 'DLA1', storeName: 'Superette Akwa', adminName: 'Steve', adminLogin: 'steve', adminPin: '1234' });
    s.admin.createUser(admin.id, { name: 'Gérant', login: 'gestion', pin: '2222', role: 'seller', storeId: store.id, registerId: register.id });
    s.admin.createUser(admin.id, { name: 'Comptable', login: 'compta', pin: '3333', role: 'accountant', storeId: store.id, registerId: register.id });
    s.admin.saveRights(admin.id, 'seller', ['reports', 'sales']);
    s.admin.saveRights(admin.id, 'accountant', ['fiscal_prep']);
    const api = createApi(s, printer, sync, 'test', system) as unknown as Record<string, (...a: unknown[]) => unknown>;
    const day = new Date().toISOString().slice(0, 10);
    const report = { from: day, to: day, dimension: 'day' };

    api['auth.login']!('gestion', '2222');
    expect(api['reports.sales']!(report)).toBeTruthy();
    expect(() => api['fiscalPrep.statement']!(day, day)).toThrow(/droits/);
    expect(() => api['fiscalPrep.simulate']!(2026)).toThrow(/droits/);

    api['auth.login']!('compta', '3333');
    expect(() => api['reports.sales']!(report)).toThrow(/droits/);
    expect(api['fiscalPrep.statement']!(day, day)).toMatchObject({ concordance: { ok: true } });
    expect(() => api['fiscalPrep.recordDeclaration']!({ period: day.slice(0, 7), kind: 'initial', turnoverHt: 0, vat: 0, reference: 'TD-1', filedOn: day })).toThrow(/droits/);

    api['auth.login']!('steve', '1234');
    expect(api['fiscalPrep.recordDeclaration']!({ period: day.slice(0, 7), kind: 'initial', turnoverHt: 0, vat: 0, reference: 'TD-1', filedOn: day })).toMatchObject({ reference: 'TD-1' });
    expect((api['fiscalPrep.reconciliation']!(day, day) as { status: string }[])[0]!.status).toBe('concordant');
  });
});
