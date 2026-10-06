import { describe, expect, it } from 'vitest';
import { createServices, openDatabase } from '../src';

describe('tableau des flux de trésorerie', () => {
  it('passe du résultat à la variation de trésorerie, les à-nouveaux faisant partie de l’ouverture', () => {
    let now = new Date('2025-03-01T09:00:00Z');
    const s = createServices(openDatabase(':memory:'), () => now);
    const { store, register, admin } = s.admin.bootstrap({ storeCode: 'DLA1', storeName: 'Superette Akwa', adminName: 'Steve', adminLogin: 'steve', adminPin: '1234' });
    const ctx = { storeId: store.id, registerId: register.id, userId: admin.id };
    for (const [id, label] of [['104', "Compte de l'exploitant"], ['2844', 'Amortissements du matériel de bureau'], ['6813', 'Dotations aux amortissements'], ['671', 'Intérêts des emprunts']]) {
      s.accounting.saveAccount(admin.id, { id: id!, label: label! });
    }
    const tva = s.admin.listVatRates().find((r) => r.rate_bp === 1925)!.id;
    const riz = s.catalogue.saveArticle(admin.id, { name: 'Riz 5 kg', unit: 'piece', vatRateId: tva, purchasePrice: 3_000, salePrice: 5_000 }).id;
    const entry = (journal: 'AN' | 'BQ' | 'OD', date: string, label: string, lines: [string, number, number][]) =>
      s.accounting.addManualEntry(ctx, { journal, date, label, lines: lines.map(([account, debit, credit]) => ({ account, debit, credit })) });
    entry('AN', '2025-03-01', 'Apport initial', [['521', 2_000_000, 0], ['101', 0, 2_000_000]]);
    s.stock.receive(ctx, { warehouseId: s.admin.salesWarehouse(store.id).id, lines: [{ articleId: riz, qty: 100_000, unitCost: 3_000 }] });
    const sup = s.purchases.saveSupplier(admin.id, { name: 'Grossiste Mboppi' });
    s.purchases.createInvoice(ctx, { supplierId: sup.id, supplierNumber: 'FA-1', invoiceDate: '2025-03-01', totalHt: 300_000, totalTva: 57_750 });
    s.pos.openSession(ctx, 0);
    s.pos.completeSale(ctx, { lines: [{ articleId: riz, qty: 40_000 }], payments: [{ method: 'CASH', amount: 200_000 }] });
    s.expenses.record(ctx, { categoryId: 'cat-loyer', label: 'Loyer mars', amount: 50_000, method: 'BANK_TRANSFER', reference: 'VIR-1' });
    entry('BQ', '2025-04-01', 'Achat congélateur', [['2441', 500_000, 0], ['521', 0, 500_000]]);
    entry('BQ', '2025-04-02', 'Prêt Afriland', [['521', 1_000_000, 0], ['162', 0, 1_000_000]]);
    entry('BQ', '2025-10-01', 'Échéance du prêt', [['162', 100_000, 0], ['671', 12_000, 0], ['521', 0, 112_000]]);
    entry('BQ', '2025-11-01', 'Prélèvement de l’exploitant', [['104', 30_000, 0], ['521', 0, 30_000]]);
    entry('OD', '2025-12-31', 'Amortissement 2025', [['6813', 50_000, 0], ['2844', 0, 50_000]]);

    const t = s.statements.cashFlow(store.id, { from: '2025-01-01', to: '2025-12-31' });
    const v = Object.fromEntries(t.rows.map((l) => [l.ref, l.net]));
    expect(v).toMatchObject({
      ZA: 2_000_000,
      FA: -14_285, // résultat -64 285 + amortissement 50 000
      FC: -180_000,
      FD: -57_750,
      FE: 390_035,
      ZB: 138_000,
      FG: -500_000,
      ZC: -500_000,
      FM: -30_000,
      FO: 1_000_000,
      FQ: -100_000,
      ZF: 870_000,
      ZG: 508_000,
      ZH: 2_508_000,
    });
    expect(t.check).toMatchObject({ treasury: 2_508_000, gap: 0 });
    const st = s.statements.statements(store.id, { from: '2025-01-01', to: '2025-12-31' });
    expect(st.result).toBe(-64_285);

    now = new Date('2026-02-01T09:00:00Z');
    s.pos.completeSale(ctx, { lines: [{ articleId: riz, qty: 10_000 }], payments: [{ method: 'CASH', amount: 50_000 }] });
    const t2 = s.statements.cashFlow(store.id, { from: '2026-01-01', to: '2026-12-31' });
    const v2 = Object.fromEntries(t2.rows.map((l) => [l.ref, [l.net, l.previous]]));
    expect(v2.ZA).toEqual([2_508_000, 2_000_000]);
    expect(v2.ZG).toEqual([50_000, 508_000]);
    expect(v2.FC).toEqual([30_000, -180_000]);
    expect(t2.check.gap).toBe(0);
    expect(t2.check.previousGap).toBe(0);
    expect(s.statements.exportCsv(store.id, { from: '2026-01-01', to: '2026-12-31' })).toContain('Flux de tresorerie;ZG;"VARIATION DE LA TRÉSORERIE NETTE DE LA PÉRIODE";;;50000;508000');
  });
});
