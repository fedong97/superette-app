import { describe, expect, it } from 'vitest';
import { createServices, openDatabase } from '../src';

function setup() {
  const clock = { now: new Date('2025-03-01T09:00:00Z') };
  const s = createServices(openDatabase(':memory:'), () => clock.now);
  const { store, register, admin } = s.admin.bootstrap({ storeCode: 'DLA1', storeName: 'Superette Akwa', adminName: 'Steve', adminLogin: 'steve', adminPin: '1234' });
  const ctx = { storeId: store.id, registerId: register.id, userId: admin.id };
  const tva = s.admin.listVatRates().find((r) => r.rate_bp === 1925)!.id;
  const riz = s.catalogue.saveArticle(admin.id, { name: 'Riz 5 kg', unit: 'piece', vatRateId: tva, purchasePrice: 3_000, salePrice: 5_000 }).id;
  s.accounting.addManualEntry(ctx, { journal: 'AN', date: '2025-03-01', label: 'Apport', lines: [{ account: '521', debit: 2_000_000, credit: 0 }, { account: '101', debit: 0, credit: 2_000_000 }] });
  s.stock.receive(ctx, { warehouseId: s.admin.salesWarehouse(store.id).id, lines: [{ articleId: riz, qty: 100_000, unitCost: 3_000 }] });
  const sup = s.purchases.saveSupplier(admin.id, { name: 'Grossiste Mboppi' });
  s.purchases.createInvoice(ctx, { supplierId: sup.id, supplierNumber: 'FA-1', invoiceDate: '2025-03-01', totalHt: 300_000, totalTva: 57_750 });
  s.pos.openSession(ctx, 0);
  s.pos.completeSale(ctx, { lines: [{ articleId: riz, qty: 40_000 }], payments: [{ method: 'CASH', amount: 200_000 }] });
  s.expenses.record(ctx, { categoryId: 'cat-loyer', label: 'Loyer mars', amount: 50_000, method: 'BANK_TRANSFER', reference: 'VIR-1' });
  return { s, ctx, store, clock };
}

describe('impôt sur le résultat', () => {
  it('acompte mensuel, minimum de perception quand le résultat est en perte, écriture de fin d’exercice', () => {
    const { s, ctx, store, clock } = setup();
    expect(s.tax.instalment(store.id, '2025-03')).toEqual({ month: '2025-03', turnoverHt: 167_715, rate: 200, principal: 3_354, cac: 335, total: 3_689 });
    expect(s.tax.instalment(store.id, '2025-04').total).toBe(0);

    // En cours d'exercice : calcul provisoire, pas d'écriture possible.
    expect(s.tax.assessment(store.id, 2025).provisional).toBe(true);
    expect(() => s.tax.book(ctx, 2025)).toThrow(/clos/);

    clock.now = new Date('2026-02-15T09:00:00Z');
    const a = s.tax.assessment(store.id, 2025);
    expect(a.provisional).toBe(false);
    expect(a.instalments).toHaveLength(12);
    expect(a).toMatchObject({ turnoverHt: 167_715, resultBeforeTax: -2_285, fiscalResult: -2_285, taxableIncome: 0, lossCarriedForward: 2_285 });
    expect(a).toMatchObject({ tax: { principal: 0, cac: 0, total: 0 }, minimum: 3_689, due: 3_689, balance: 0, toBook: 3_689 });

    expect(s.tax.book(ctx, 2025)).toBe(3_689);
    const after = s.tax.assessment(store.id, 2025);
    expect(after).toMatchObject({ bookedTax: 3_689, resultBeforeTax: -2_285, toBook: 0 });
    expect(s.statements.statements(store.id, { from: '2025-01-01', to: '2025-12-31' }).result).toBe(-5_974);
    expect(() => s.tax.book(ctx, 2025)).toThrow(/déjà passé/);
  });

  it('réintégrations, déficits antérieurs, taux réduit des sociétés, barème de l’entrepreneur individuel', () => {
    const { s, ctx, store, clock } = setup();
    clock.now = new Date('2026-02-15T09:00:00Z');
    s.tax.saveSettings(ctx, 2025, { adjustments: [{ kind: 'add', label: 'Amendes et pénalités', amount: 500_000 }], priorLosses: 100_000 });
    let a = s.tax.assessment(store.id, 2025);
    expect(a).toMatchObject({ additions: 500_000, fiscalResult: 497_715, lossesUsed: 100_000, taxableIncome: 397_715, rateApplied: 2500 });
    expect(a.tax).toEqual({ principal: 99_429, cac: 9_943, total: 109_372 });
    expect(a).toMatchObject({ due: 109_372, balance: 105_683 });

    // Entrepreneur individuel : IRPP au barème (10 / 15 / 25 / 35 %).
    s.tax.saveSettings(ctx, 2025, { form: 'individual', adjustments: [{ kind: 'add', label: 'Rémunération de l’exploitant', amount: 6_002_285 }], priorLosses: 0 });
    a = s.tax.assessment(store.id, 2025);
    expect(a.taxableIncome).toBe(6_000_000);
    expect(a.tax).toEqual({ principal: 1_200_000, cac: 120_000, total: 1_320_000 });
    expect(a.rateApplied).toBe(2000);

    // Régime simplifié : minimum de 5 % ; un taux saisi égal au CGI n'est pas figé.
    const set = s.tax.saveSettings(ctx, 2025, { regime: 'simplifie', rates: { minimumRate: 500 } });
    expect(set.rates.minimumRate).toBe(500);
    expect(s.tax.instalment(store.id, '2025-03').principal).toBe(8_386);
    expect(s.tax.saveSettings(ctx, 2025, { regime: 'reel' }).rates.minimumRate).toBe(200);
    expect(() => s.tax.saveSettings(ctx, 2025, { adjustments: [{ kind: 'add', label: '', amount: 10 }] })).toThrow();
  });
});
