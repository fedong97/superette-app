import { describe, expect, it } from 'vitest';
import { createServices, openDatabase } from '../src';

describe('états financiers SYSCOHADA', () => {
  it('bilan équilibré, compte de résultat avec variation de stock au CMUP, report sur l’exercice suivant', () => {
    let now = new Date('2025-03-01T09:00:00Z');
    const s = createServices(openDatabase(':memory:'), () => now);
    const { store, register, admin } = s.admin.bootstrap({ storeCode: 'DLA1', storeName: 'Superette Akwa', adminName: 'Steve', adminLogin: 'steve', adminPin: '1234' });
    const ctx = { storeId: store.id, registerId: register.id, userId: admin.id };
    const tva = s.admin.listVatRates().find((r) => r.rate_bp === 1925)!.id;
    const riz = s.catalogue.saveArticle(admin.id, { name: 'Riz 5 kg', unit: 'piece', vatRateId: tva, purchasePrice: 3_000, salePrice: 5_000 }).id;
    s.accounting.addManualEntry(ctx, {
      journal: 'AN',
      date: '2025-03-01',
      label: 'Apport initial',
      lines: [
        { account: '521', debit: 2_000_000, credit: 0 },
        { account: '101', debit: 0, credit: 2_000_000 },
      ],
    });
    s.stock.receive(ctx, { warehouseId: s.admin.salesWarehouse(store.id).id, lines: [{ articleId: riz, qty: 100_000, unitCost: 3_000 }] });
    const sabc = s.purchases.saveSupplier(admin.id, { name: 'Grossiste Mboppi' });
    s.purchases.createInvoice(ctx, { supplierId: sabc.id, supplierNumber: 'FA-1', invoiceDate: '2025-03-01', totalHt: 300_000, totalTva: 57_750 });
    s.pos.openSession(ctx, 0);
    s.pos.completeSale(ctx, { lines: [{ articleId: riz, qty: 40_000 }], payments: [{ method: 'CASH', amount: 200_000 }] });
    s.expenses.record(ctx, { categoryId: 'cat-loyer', label: 'Loyer mars', amount: 50_000, method: 'BANK_TRANSFER', reference: 'VIR-1' });

    const y1 = s.statements.statements(store.id, { from: '2025-01-01', to: '2025-12-31' });
    const inc = Object.fromEntries(y1.income.map((l) => [l.ref, l.net]));
    expect(y1.stock).toEqual({ opening: 0, closing: 180_000, variation: -180_000 });
    expect(inc).toMatchObject({ TA: 167_715, RA: 300_000, RB: -180_000, XA: 47_715, XB: 167_715, RH: 50_000, XC: -2_285, XI: -2_285 });
    expect(y1.result).toBe(-2_285);
    const act = Object.fromEntries(y1.assets.map((l) => [l.ref, l.net]));
    const pas = Object.fromEntries(y1.liabilities.map((l) => [l.ref, l.net]));
    expect(act).toMatchObject({ BB: 180_000, BJ: 57_750, BS: 2_150_000, BZ: 2_387_750 });
    expect(pas).toMatchObject({ CA: 2_000_000, CJ: -2_285, DJ: 357_750, DK: 32_285, DZ: 2_387_750 });
    expect(y1.unmapped).toEqual([]);

    // Exercice suivant : la perte 2025 passe en report à nouveau, le stock de départ est celui du 31/12/2025.
    now = new Date('2026-02-01T09:00:00Z');
    s.pos.completeSale(ctx, { lines: [{ articleId: riz, qty: 10_000 }], payments: [{ method: 'CASH', amount: 50_000 }] });
    const y2 = s.statements.statements(store.id, { from: '2026-01-01', to: '2026-12-31' });
    const inc2 = Object.fromEntries(y2.income.map((l) => [l.ref, [l.net, l.previous]]));
    expect(y2.stock).toEqual({ opening: 180_000, closing: 150_000, variation: 30_000 });
    expect(inc2.TA).toEqual([41_929, 167_715]);
    expect(inc2.RB).toEqual([30_000, -180_000]);
    expect(inc2.XI).toEqual([11_929, -2_285]);
    const pas2 = Object.fromEntries(y2.liabilities.map((l) => [l.ref, l]));
    const act2 = Object.fromEntries(y2.assets.map((l) => [l.ref, l]));
    expect(pas2.CH!.net).toBe(-2_285);
    expect(pas2.CJ!.net).toBe(11_929);
    expect(act2.BB!.previous).toBe(180_000);
    expect(act2.BZ!.net).toBe(pas2.DZ!.net);
    expect(act2.BZ!.previous).toBe(2_387_750);

    const csv = s.statements.exportCsv(store.id, { from: '2026-01-01', to: '2026-12-31' });
    expect(csv).toContain('Compte de resultat;XI;"RÉSULTAT NET";;;11929;-2285');
  });
});
