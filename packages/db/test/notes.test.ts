import { describe, expect, it } from 'vitest';
import { createServices, openDatabase } from '../src';

describe('notes annexes', () => {
  it('établit les tableaux de mouvements, les détails de postes, la synthèse et le passage au résultat fiscal', () => {
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
    entry('BQ', '2025-11-01', 'Prélèvement', [['104', 30_000, 0], ['521', 0, 30_000]]);
    entry('OD', '2025-12-31', 'Amortissement 2025', [['6813', 50_000, 0], ['2844', 0, 50_000]]);
    now = new Date('2026-02-01T09:00:00Z');

    const { notes } = s.notes.notes(store.id, 2025);
    const note = (id: string) => notes.find((n) => n.id === id)!;
    const row = (id: string, label: string) => note(id).rows.find((r) => r.label.startsWith(label))!.values;
    expect(row('3A', '2441')).toEqual([0, 500_000, 0, 500_000]);
    expect(row('3C', '2844')).toEqual([0, 50_000, 0, 50_000]);
    expect(row('6', '311')).toEqual([180_000, 0, 180_000]);
    expect(note('7').rows).toEqual([]);
    expect(row('11', '521')).toEqual([2_308_000, 2_000_000, 308_000]);
    expect(row('11', 'Total')).toEqual([2_508_000, 2_000_000, 508_000]);
    expect(row('13', '104')).toEqual([-30_000, 0, -30_000]);
    expect(row('16A', '162')).toEqual([0, 1_000_000, 100_000, 900_000]);
    expect(row('17', '401')[0]).toBe(357_750);
    expect(row('17', '401')).toHaveLength(3);
    expect(note('17').rows[0]!.label).toContain('Grossiste Mboppi');
    expect(row('21', '701')).toEqual([167_715, 0, 167_715]);
    expect(row('24', 'Total')[0]).toBe(50_000);
    expect(row('28', '6813')).toEqual([50_000, 0, 50_000]);
    expect(row('34', 'Résultat net')[0]).toBe(-64_285);
    expect(row('34', "Capacité d'autofinancement")[0]).toBe(-14_285);
    expect(row('RF', 'Impôt dû')[0]).toBe(3_689);

    const csv = s.notes.exportCsv(store.id, 2025);
    expect(csv).toContain('16A;"Dettes financières et ressources assimilées";"162 Emprunts auprès des établissements de crédit";0;1000000;100000;900000');
  });
});
