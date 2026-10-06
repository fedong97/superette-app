import { parseStatementCsv } from '@superette/core';
import { describe, expect, it } from 'vitest';
import { createServices, openDatabase } from '../src';

describe('rapprochement bancaire', () => {
  it('importe le relevé sans doublon, pointe, comptabilise les frais et calcule l’état de rapprochement', () => {
    let now = new Date('2026-10-01T09:00:00Z');
    const s = createServices(openDatabase(':memory:'), () => now);
    const { store, register, admin } = s.admin.bootstrap({ storeCode: 'DLA1', storeName: 'Superette Akwa', adminName: 'Steve', adminLogin: 'steve', adminPin: '1234' });
    const ctx = { storeId: store.id, registerId: register.id, userId: admin.id };
    s.accounting.addManualEntry(ctx, {
      journal: 'AN',
      date: '2026-10-01',
      label: 'Solde banque au 1er octobre',
      lines: [
        { account: '521', debit: 1_000_000, credit: 0 },
        { account: '101', debit: 0, credit: 1_000_000 },
      ],
    });
    const sabc = s.purchases.saveSupplier(admin.id, { name: 'SABC' });
    const inv = s.purchases.createInvoice(ctx, { supplierId: sabc.id, supplierNumber: 'FA-1', invoiceDate: '2026-10-01', totalHt: 300_000, totalTva: 57_750 });
    now = new Date('2026-10-06T09:00:00Z');
    s.purchases.paySupplier(ctx, { invoiceId: inv.id, method: 'CHEQUE', amount: 357_750, reference: '0012' });
    s.expenses.record(ctx, { categoryId: 'cat-loyer', label: 'Loyer octobre', amount: 150_000, method: 'BANK_TRANSFER', reference: 'VIR-1006' });

    const csv = [
      'Date opération;Libellé;Référence;Débit;Crédit',
      ';Solde au 30/09/2026;;;1 000 000',
      '07/10/2026;VIREMENT LOYER OCTOBRE;VIR-1006;150 000;',
      '08/10/2026;FRAIS TENUE DE COMPTE;;5 000;',
    ].join('\n');
    const lines = parseStatementCsv(csv).lines;
    expect(() => s.reconciliation.importLines(ctx, '571', lines)).toThrow('52 à 55');
    expect(s.reconciliation.importLines(ctx, '521', lines)).toEqual({ added: 2, duplicates: 0 });
    expect(s.reconciliation.importLines(ctx, '521', lines)).toEqual({ added: 0, duplicates: 2 });

    expect(s.reconciliation.autoMatch(ctx, '521')).toBe(1);
    let st = s.reconciliation.state(store.id, '521', '2026-10-31');
    expect(st.matched.map((m) => m.book.label)).toEqual([expect.stringContaining('Loyer')]);
    expect(st.bookOnly.map((b) => b.amount)).toEqual([-357_750]);
    const fee = st.bankOnly[0]!;
    expect(fee).toMatchObject({ label: 'FRAIS TENUE DE COMPTE', amount: -5_000 });
    expect(() => s.reconciliation.match(ctx, fee.id, st.bookOnly[0]!.key)).toThrow('Montants différents');

    s.reconciliation.bookLine(ctx, fee.id, { account: '631', label: 'Frais de tenue de compte octobre' });
    st = s.reconciliation.state(store.id, '521', '2026-10-31');
    expect(st.bankOnly).toEqual([]);
    expect(st.matched).toHaveLength(2);
    expect(st.bookBalance).toBe(1_000_000 - 357_750 - 150_000 - 5_000);
    // Le chèque SABC n'est pas encore passé à la banque : le relevé doit afficher 845 000.
    expect(st.expectedBankBalance).toBe(845_000);
    expect(s.accounting.entries(store.id, { journal: 'BQ' }).some((e) => e.label === 'Frais de tenue de compte octobre' && e.lines[0]!.account === '631')).toBe(true);

    // À une date antérieure au relevé, le loyer pointé le 07/10 est encore en suspens.
    const early = s.reconciliation.state(store.id, '521', '2026-10-06');
    expect(early.bookOnly.map((b) => b.amount).sort()).toEqual([-150_000, -357_750].sort());
    expect(early.matched).toEqual([]);

    const loyer = st.matched.find((m) => m.bank.amount === -150_000)!.bank;
    expect(() => s.reconciliation.deleteLine(ctx, loyer.id)).toThrow('Dépointez');
    s.reconciliation.unmatch(ctx, loyer.id);
    s.reconciliation.deleteLine(ctx, loyer.id);
    expect(s.reconciliation.state(store.id, '521', '2026-10-31').bankOnly).toEqual([]);
    expect(s.reconciliation.importLines(ctx, '521', lines)).toEqual({ added: 1, duplicates: 1 });
  });

  it('ne pointe pas tout seul quand deux écritures sont aussi plausibles', () => {
    const now = new Date('2026-10-06T09:00:00Z');
    const s = createServices(openDatabase(':memory:'), () => now);
    const { store, register, admin } = s.admin.bootstrap({ storeCode: 'DLA1', storeName: 'Superette Akwa', adminName: 'Steve', adminLogin: 'steve', adminPin: '1234' });
    const ctx = { storeId: store.id, registerId: register.id, userId: admin.id };
    for (const ref of ['MP1', 'MP2']) s.expenses.record(ctx, { categoryId: 'cat-transport', label: 'Carburant', amount: 10_000, method: 'MTN_MOMO', reference: ref });
    s.reconciliation.importLines(ctx, '5521', [{ date: '2026-10-06', label: 'Paiement', reference: null, amount: -10_000 }]);
    expect(s.reconciliation.autoMatch(ctx, '5521')).toBe(0);
    s.reconciliation.importLines(ctx, '5521', [{ date: '2026-10-06', label: 'Paiement DEP-DLA11-00002', reference: 'MP2', amount: -10_000 }]);
    expect(s.reconciliation.autoMatch(ctx, '5521')).toBe(1);
  });
});
