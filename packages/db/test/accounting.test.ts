import { beforeEach, describe, expect, it } from 'vitest';
import { type Context, type Entry, type Services, createServices, openDatabase } from '../src';

let now = new Date('2026-09-28T08:00:00Z');
const clock = () => now;

let s: Services;
let ctx: Context;
let riz: string;
let lait: string;

function setup() {
  now = new Date('2026-09-28T08:00:00Z');
  s = createServices(openDatabase(':memory:'), clock);
  const { store, register, admin } = s.admin.bootstrap({ storeCode: 'DLA1', storeName: 'Superette Akwa', adminName: 'Steve', adminLogin: 'steve', adminPin: '1234' });
  ctx = { storeId: store.id, registerId: register.id, userId: admin.id };
  const rates = s.admin.listVatRates();
  const tva = rates.find((r) => r.rate_bp === 1925)!.id;
  const exo = rates.find((r) => r.rate_bp === 0)!.id;
  riz = s.catalogue.saveArticle(admin.id, { name: 'Riz 5 kg', unit: 'piece', vatRateId: tva, purchasePrice: 3_000, salePrice: 5_000 }).id;
  lait = s.catalogue.saveArticle(admin.id, { name: 'Lait infantile', unit: 'piece', vatRateId: exo, purchasePrice: 2_000, salePrice: 2_500 }).id;
  const wh = s.admin.salesWarehouse(store.id).id;
  s.stock.receive(ctx, { warehouseId: wh, lines: [{ articleId: riz, qty: 100_000, unitCost: 3_000 }, { articleId: lait, qty: 100_000, unitCost: 2_000 }] });
}

const balanced = (entries: Entry[]) =>
  entries.every((e) => e.lines.reduce((t, l) => t + l.debit, 0) === e.lines.reduce((t, l) => t + l.credit, 0));

describe('comptabilité SYSCOHADA', () => {
  beforeEach(setup);

  it('passe les écritures de ventes, caisse, clients, achats et fournisseurs, toutes équilibrées', () => {
    // Septembre : un achat sans vente, donc un crédit de TVA.
    const sabc = s.purchases.saveSupplier(ctx.userId, { name: 'SABC' });
    s.purchases.createInvoice(ctx, { supplierId: sabc.id, supplierNumber: 'FA-1', invoiceDate: '2026-09-28', totalHt: 100_000, totalTva: 19_250 });

    now = new Date('2026-10-06T08:00:00Z');
    s.pos.openSession(ctx, 10_000);
    const mballa = s.customers.saveCustomer(ctx.userId, { name: 'Chez Mballa', creditLimit: 100_000 });
    // 2 riz + 1 lait payés 20 000 en espèces : 7 500 rendus.
    s.pos.completeSale(ctx, { lines: [{ articleId: riz, qty: 2000 }, { articleId: lait, qty: 1000 }], payments: [{ method: 'CASH', amount: 20_000 }] });
    s.pos.completeSale(ctx, { lines: [{ articleId: riz, qty: 1000 }], payments: [{ method: 'MTN_MOMO', amount: 5_000, reference: 'MP1' }] });
    const credit = s.pos.completeSale(ctx, { lines: [{ articleId: riz, qty: 4000 }], payments: [{ method: 'CUSTOMER_CREDIT', amount: 20_000 }], customerId: mballa.id });
    s.pos.returnSale(ctx, { originalSaleId: credit.id, lines: [{ lineId: credit.lines[0]!.id, qty: 1000 }], refundMethod: 'CUSTOMER_CREDIT', supervisorId: ctx.userId, reason: 'Sac abîmé' });
    const session = s.pos.currentSession(ctx.registerId!)!;
    s.customers.receivePayment(ctx, { customerId: mballa.id, method: 'CASH', amount: 5_000, sessionId: session.id });
    s.pos.cashOperation(ctx, 'OUT', 10_000, 'Coffre');
    // Fond 10 000 + ventes 12 500 + règlement 5 000 − prélèvement 10 000 = 17 500 attendus ; 17 000 comptés.
    s.pos.closeSession(ctx, { 10000: 1, 5000: 1, 1000: 2 });

    const sabcInvoice = s.purchases.createInvoice(ctx, { supplierId: sabc.id, supplierNumber: 'FA-2', invoiceDate: '2026-10-06', totalHt: 10_000, totalTva: 1_925 });
    s.purchases.createInvoice(ctx, { supplierId: sabc.id, kind: 'credit_note', supplierNumber: 'AV-1', invoiceDate: '2026-10-06', totalHt: 1_000, totalTva: 193 });
    s.purchases.paySupplier(ctx, { invoiceId: sabcInvoice.id, method: 'ORANGE_MONEY', amount: 5_000, reference: 'OM1' });

    const entries = s.accounting.entries(ctx.storeId);
    expect(balanced(entries)).toBe(true);
    expect(entries.map((e) => e.journal).sort()).toEqual(['AC', 'AC', 'AC', 'CA', 'CA', 'CA', 'MM', 'VE']);

    const sales = entries.find((e) => e.journal === 'VE')!;
    expect(sales.ref).toBe('Z1');
    const line = (acc: string) => sales.lines.filter((l) => l.account === acc);
    expect(line('571')[0]!.debit).toBe(12_500);
    expect(line('5521')[0]!.debit).toBe(5_000);
    expect(line('411')[0]).toMatchObject({ aux: mballa.code, debit: 15_000 });
    // CA TTC : 12 500 + 5 000 + 20 000 − 5 000 = 32 500, dont 2 500 exonérés.
    const tb = s.accounting.trialBalance(ctx.storeId, { from: '2026-10-01' });
    expect(tb.totals.debit).toBe(tb.totals.credit);
    const row = (acc: string) => tb.rows.find((r) => r.account === acc)!;
    expect(row('701').closing + row('4431').closing).toBe(-32_500);
    expect(row('658').closing).toBe(500);
    // 411 : 15 000 à crédit, 5 000 réglés en espèces.
    expect(s.accounting.ledger(ctx.storeId, { account: '411', aux: mballa.code }).closing).toBe(10_000);
    expect(s.customers.account(ctx.storeId, mballa.id).balance).toBe(10_000);
    // 401 : 119 250 + 11 925 − 1 193 − 5 000 réglés, avec le report de septembre.
    const suppliers = s.accounting.ledger(ctx.storeId, { account: '401', from: '2026-10-01' });
    expect(suppliers.opening).toBe(-119_250);
    expect(suppliers.closing).toBe(-124_982);

    const treasury = s.accounting.treasury(ctx.storeId);
    expect(treasury.find((t) => t.account === '571')!.balance).toBe(7_000);
    expect(treasury.find((t) => t.account === '5522')!.balance).toBe(-5_000);

    // TVA d'octobre : collectée sur la part taxable, déductible nette de l'avoir, crédit de septembre reporté.
    const vat = s.accounting.vatReturn(ctx.storeId, '2026-10');
    expect(vat.collected).toBe(row('4431').credit - row('4431').debit);
    expect(vat.exemptHt).toBe(2_500);
    expect(vat.deductible).toBe(1_732);
    expect(vat.previousCredit).toBe(19_250);
    expect(vat.due).toBe(0);
    expect(vat.credit).toBe(19_250 + 1_732 - vat.collected);
    expect(s.accounting.vatReturn(ctx.storeId, '2026-09')).toMatchObject({ collected: 0, deductible: 19_250, credit: 19_250 });

    const csv = s.accounting.exportCsv(ctx.storeId, { from: '2026-10-01' });
    expect(csv.split('\r\n')[0]).toBe('Journal;Date;Pièce;Compte;Tiers;Libellé;Débit;Crédit');
    expect(csv).toContain(`VE;06/10/2026;Z1;411;${mballa.code};Vente à crédit Chez Mballa;15000;`);
  });

  it('enregistre les à-nouveaux et refuse une écriture déséquilibrée', () => {
    const lines = [
      { account: '521', debit: 500_000, credit: 0 },
      { account: '101', debit: 0, credit: 400_000 },
    ];
    expect(() => s.accounting.addManualEntry(ctx, { journal: 'AN', date: '2026-01-01', label: 'À-nouveaux', lines })).toThrow('déséquilibrée');
    expect(() => s.accounting.addManualEntry(ctx, { journal: 'VE' as 'OD', date: '2026-01-01', label: 'x', lines })).toThrow('non autorisé');
    expect(() =>
      s.accounting.addManualEntry(ctx, { journal: 'OD', date: '2026-01-01', label: 'x', lines: [{ account: '999', debit: 1, credit: 0 }, { account: '101', debit: 0, credit: 1 }] }),
    ).toThrow('Compte inconnu');
    const entry = s.accounting.addManualEntry(ctx, {
      journal: 'AN',
      date: '2026-01-01',
      label: 'À-nouveaux',
      lines: [...lines, { account: '121', debit: 0, credit: 100_000 }],
    });
    expect(entry).toMatchObject({ ref: 'OD-DLA11-00001', source: 'manual' });
    expect(s.accounting.treasury(ctx.storeId).find((t) => t.account === '521')!.balance).toBe(500_000);
    expect(s.accounting.entries(ctx.storeId, { journal: 'AN' })).toHaveLength(1);
  });

  it("déplace un rôle d'un compte à l'autre", () => {
    s.accounting.saveAccount(ctx.userId, { id: '5711', label: 'Caisse magasin', role: 'cash' });
    const accounts = s.accounting.listAccounts();
    expect(accounts.find((a) => a.id === '5711')!.role).toBe('cash');
    expect(accounts.find((a) => a.id === '571')!.role).toBeNull();
    s.pos.openSession(ctx, 0);
    s.pos.completeSale(ctx, { lines: [{ articleId: riz, qty: 1000 }], payments: [{ method: 'CASH', amount: 5_000 }] });
    expect(s.accounting.treasury(ctx.storeId)[0]).toMatchObject({ account: '5711', balance: 5_000 });
    expect(() => s.accounting.saveAccount(ctx.userId, { id: 'abc', label: 'x' })).toThrow('invalide');
    expect(() => s.accounting.saveAccount(ctx.userId, { id: '5711', label: 'Caisse', role: null })).toThrow("désignez d'abord");
    expect(() => s.accounting.saveAccount(ctx.userId, { id: '5711', label: 'Caisse', role: 'cash', active: false })).toThrow('désactivé');
  });
});
