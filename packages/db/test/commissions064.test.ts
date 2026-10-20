import { describe, expect, it } from 'vitest';
import { createServices, openDatabase } from '../src';

describe('objectifs et commissions des vendeurs', () => {
  it('calcule les ventes du mois moins les retours, le taux atteint et la commission par famille, puis la passe dans le salaire', () => {
    const s = createServices(openDatabase(':memory:'), () => new Date('2026-10-18T09:00:00Z'));
    const { store, register, admin } = s.admin.bootstrap({ storeCode: 'DLA1', storeName: 'Superette Akwa', adminName: 'Steve', adminLogin: 'steve', adminPin: '1234' });
    const tva = s.admin.listVatRates().find((r) => r.rate_bp === 0)?.id ?? s.admin.listVatRates()[0]!.id;
    const dep = s.catalogue.createDepartment('Boissons');
    const beer = s.catalogue.createFamily(dep.id, 'Bières');
    const castel = s.catalogue.saveArticle(admin.id, { name: 'CASTEL 65CL', unit: 'piece', vatRateId: tva, purchasePrice: 450, salePrice: 1_000, familyId: beer.id });
    const riz = s.catalogue.saveArticle(admin.id, { name: 'RIZ 1 KG', unit: 'piece', vatRateId: tva, purchasePrice: 700, salePrice: 1_000 });
    const awaUser = s.admin.createUser(admin.id, { name: 'Awa', login: 'awa', pin: '5678', role: 'cashier', storeId: store.id, registerId: register.id });
    const ctxAdmin = { storeId: store.id, registerId: register.id, userId: admin.id };
    s.stock.receive(ctxAdmin, { warehouseId: s.admin.salesWarehouse(store.id).id, lines: [{ articleId: castel.id, qty: 50_000, unitCost: 450 }, { articleId: riz.id, qty: 50_000, unitCost: 700 }] });
    const awa = s.staff.save(ctxAdmin, { name: 'Awa Ndiaye', baseSalary: 60_000, userId: awaUser.id, declared: false });

    // Awa vend 10 bières et 20 kg de riz, puis rend 2 kg de riz.
    const ctxAwa = { ...ctxAdmin, userId: awaUser.id };
    s.pos.openSession(ctxAwa, 0);
    s.pos.completeSale(ctxAwa, { lines: [{ articleId: castel.id, qty: 10_000 }], payments: [{ method: 'CASH', amount: 10_000 }] });
    const rice = s.pos.completeSale(ctxAwa, { lines: [{ articleId: riz.id, qty: 20_000 }], payments: [{ method: 'CASH', amount: 20_000 }] });
    s.pos.returnSale(ctxAwa, { originalSaleId: rice.id, lines: [{ lineId: rice.lines[0]!.id, qty: 2_000 }], refundMethod: 'CASH', supervisorId: admin.id, reason: 'abîmé' });

    // 1 % sur tout, 3 % sur les bières ; objectif 56 000 FCFA par mois, 7 000 par jour.
    expect(() => s.commissions.setTarget(ctxAdmin, awa.id, { monthTarget: 56_000, dayTarget: 7_000, rateBp: 9_000 })).toThrow(/Taux/);
    s.commissions.setTarget(ctxAdmin, awa.id, { monthTarget: 56_000, dayTarget: 7_000, rateBp: 100, familyRates: { [beer.id]: 300 } });
    const [row] = s.commissions.month(store.id, '2026-10');
    expect(row).toMatchObject({ staff_name: 'Awa Ndiaye', user_name: 'Awa', month_sales: 28_000, day_sales: 28_000, tickets: 2, month_rate: 50, day_rate: 400 });
    // 10 000 × 3 % + 18 000 × 1 % = 480.
    expect(row!.commission).toBe(480);
    expect(s.commissions.commissions(store.id, '2026-10')).toEqual({ [awa.id]: 480 });
    expect(s.commissions.month(store.id, '2026-09')[0]).toMatchObject({ month_sales: 0, commission: 0 });

    const [salary] = s.staff.recordSalaries(ctxAdmin, '2026-10', [{ staffId: awa.id, gross: 60_480, commission: 480 }]);
    expect([salary!.gross, salary!.label]).toEqual([60_480, 'Salaire de octobre 2026, commission comprise']);
    expect(s.db.prepare('SELECT commission FROM staff_salaries WHERE id = ?').pluck().get(salary!.id)).toBe(480);
  });
});
