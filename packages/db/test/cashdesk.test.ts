import { beforeEach, describe, expect, it } from 'vitest';
import { type Context, type Services, createServices, openDatabase } from '../src';

let s: Services;
let ctx: Context;
let office: Context;
let riz: string;
let adminId: string;
let storeId: string;
let mobile: string;
let centrale: string;
let awa: string;
let category: string;
let now = new Date('2026-10-11T09:00:00Z');

beforeEach(() => {
  now = new Date('2026-10-11T09:00:00Z');
  s = createServices(openDatabase(':memory:'), () => now);
  const { store, register, admin } = s.admin.bootstrap({ storeCode: 'DLA1', storeName: 'Superette Akwa', adminName: 'Steve', adminLogin: 'steve', adminPin: '1234' });
  adminId = admin.id;
  storeId = store.id;
  const tva = s.admin.listVatRates()[0]!.id;
  riz = s.catalogue.saveArticle(admin.id, { name: 'Riz 5 kg', unit: 'piece', vatRateId: tva, purchasePrice: 3_000, salePrice: 5_000 }).id;
  s.stock.receive({ storeId, registerId: register.id, userId: admin.id }, { warehouseId: s.admin.salesWarehouse(storeId).id, lines: [{ articleId: riz, qty: 50_000, unitCost: 3_000 }] });
  mobile = s.admin.createRegister(adminId, storeId, 'Mobile Awa', 'electronic').id;
  centrale = s.admin.createRegister(adminId, storeId, 'MoMo magasin', 'electronic').id;
  s.admin.saveStoreSettings(adminId, storeId, { emoneyMode: 'central', emoneyCentralRegisterId: centrale });
  awa = s.admin.createUser(adminId, { name: 'Awa', login: 'awa', pin: '5555', role: 'cashier', storeId, registerId: register.id, emoneyRegisterId: mobile }).id;
  ctx = { storeId, registerId: register.id, userId: awa };
  office = { storeId, registerId: null, userId: adminId };
  category = s.expenses.listCategories()[0]!.id;
});

const later = (minutes: number) => {
  now = new Date(now.getTime() + minutes * 60_000);
};
const open = () => {
  s.pos.openSession(ctx, 10_000);
  return { cash: s.pos.currentSession(ctx.registerId!)!.id, momo: s.pos.currentSession(mobile)!.id };
};
const expected = (sessionId: string) => s.pos.zReport(sessionId).cash.expected;
const balance = (account: string) => s.accounting.trialBalance(storeId).rows.find((r) => r.account === account)?.closing ?? 0;

describe('collaborateurs', () => {
  it('crée les sous-comptes 4211… et 4251… à son nom, et les renomme avec lui', () => {
    const paul = s.staff.save(office, { name: 'Paul Mbarga', position: 'Magasinier', baseSalary: 80_000 });
    const ines = s.staff.save(office, { name: 'Inès', baseSalary: 60_000 });
    expect([paul.salary_account, paul.advance_account, ines.salary_account]).toEqual(['4211001', '4251001', '4211002']);
    expect(s.accounting.listAccounts().find((a) => a.id === '4211001')?.label).toBe('Rémunérations dues, Paul Mbarga');
    s.staff.save(office, { name: 'Paul M.', baseSalary: 80_000 }, paul.id);
    expect(s.accounting.listAccounts().find((a) => a.id === '4251001')?.label).toBe('Avances, Paul M.');
  });

  it('avance à la caisse, salaire constaté avec retenue, paiement du net : comptes soldés', () => {
    const paul = s.staff.save(office, { name: 'Paul', baseSalary: 80_000 });
    const day = open();
    later(5);
    s.cashdesk.cashOut(ctx, day.cash, { type: 'staff_advance', staffId: paul.id, amount: 20_000, method: 'CASH', label: '' }, adminId);
    expect(expected(day.cash)).toBe(10_000 - 20_000);
    expect(s.pos.cashJournal(day.cash).exits.map((r) => [r.nature, r.amount, r.party])).toEqual([['Avance au personnel', 20_000, 'Paul']]);
    expect(s.staff.get(paul.id)).toMatchObject({ advances: 20_000, due: 0 });

    // Il ne peut pas rembourser plus que son avance.
    expect(() => s.cashdesk.cashIn(ctx, day.cash, { type: 'staff', staffId: paul.id, amount: 25_000, method: 'CASH' })).toThrow(/ne doit que 20000/);

    later(1);
    const [salary] = s.staff.recordSalaries(office, '2026-10', [{ staffId: paul.id, gross: 80_000, deducted: 20_000 }]);
    expect(salary).toMatchObject({ net: 60_000, rest: 60_000 });
    expect(() => s.staff.recordSalaries(office, '2026-10', [{ staffId: paul.id, gross: 80_000 }])).toThrow(/déjà constaté/);
    expect(s.staff.get(paul.id)).toMatchObject({ advances: 0, due: 60_000 });

    expect(() => s.cashdesk.cashOut(ctx, day.cash, { type: 'staff_salary', salaryId: salary!.id, amount: 70_000, method: 'CASH' }, adminId)).toThrow(/reste que 60000/);
    later(1);
    s.cashdesk.cashOut(ctx, day.cash, { type: 'staff_salary', salaryId: salary!.id, amount: 60_000, method: 'CASH' }, adminId);
    expect(s.staff.get(paul.id)).toMatchObject({ advances: 0, due: 0 });
    expect(s.staff.getSalary(salary!.id)).toMatchObject({ paid: 60_000, rest: 0 });

    // Comptabilité : 661 au débit du brut, sous-comptes soldés, la caisse a donné 80 000.
    expect(balance('661')).toBe(80_000);
    expect(balance('4211001')).toBe(0);
    expect(balance('4251001')).toBe(0);
    const st = s.staff.statement(paul.id);
    expect(st.lines.map((l) => [l.due, l.advance])).toEqual([
      [0, 20_000],
      [80_000, 0],
      [-20_000, -20_000],
      [-60_000, 0],
    ]);
  });

  it('salaire payé au bureau en espèces : il sort de la caisse centrale', () => {
    const paul = s.staff.save(office, { name: 'Paul', baseSalary: 50_000 });
    s.treasury.record(office, { kind: 'IN', nature: 'owner', amount: 100_000 });
    const [salary] = s.staff.recordSalaries(office, '2026-09', [{ staffId: paul.id, gross: 50_000 }]);
    later(1);
    s.cashdesk.record(office, { direction: 'OUT', kind: 'staff_salary', salaryId: salary!.id, amount: 50_000, method: 'CASH' });
    expect(s.treasury.balance(storeId)).toBe(50_000);
    expect(s.treasury.ledger(storeId).rows.at(-1)).toMatchObject({ source: 'entry', amount: -50_000, party: 'Paul' });
  });
});

describe('Encaisser et Décaisser', () => {
  it('chaque type passe dans le tiroir et l’attendu', () => {
    const sup = s.purchases.saveSupplier(adminId, { name: 'SABC' });
    const invoice = s.purchases.createInvoice(office, { supplierId: sup.id, supplierNumber: 'FA-1', invoiceDate: '2026-10-10', totalHt: 10_000, totalTva: 0 });
    const credit = s.purchases.createInvoice(office, { supplierId: sup.id, kind: 'credit_note', supplierNumber: 'AV-1', invoiceDate: '2026-10-10', totalHt: 2_000, totalTva: 0 });
    const day = open();
    s.cashdesk.cashIn(ctx, day.cash, { type: 'other', accountId: '4711', amount: 3_000, method: 'CASH', label: 'Vente de cartons', piece: 'R-12' });
    later(1);
    s.cashdesk.cashIn(ctx, day.cash, { type: 'supplier', invoiceId: credit.id, amount: 2_000, method: 'CASH' });
    later(1);
    s.cashdesk.cashOut(ctx, day.cash, { type: 'supplier', invoiceId: invoice.id, amount: 10_000, method: 'CASH' }, adminId);
    later(1);
    s.cashdesk.cashOut(ctx, day.cash, { type: 'expense', categoryId: category, amount: 500, method: 'CASH', label: 'Taxi', beneficiary: 'Moto' }, adminId);
    later(1);
    s.cashdesk.cashOut(ctx, day.cash, { type: 'transfer', amount: 1_000, method: 'CASH', label: 'Coffre' }, adminId);
    expect(() => s.cashdesk.cashIn(ctx, day.cash, { type: 'other', accountId: '571', amount: 1, method: 'CASH', label: 'x' })).toThrow(/reversement/);
    expect(() => s.cashdesk.cashOut(ctx, day.cash, { type: 'supplier', invoiceId: credit.id, amount: 1, method: 'CASH' }, adminId)).toThrow(/Encaisser/);
    expect(() => s.cashdesk.cashOut(ctx, day.cash, { type: 'expense', categoryId: category, amount: 500, method: 'MTN_MOMO', reference: 'X', label: 'x' }, adminId)).toThrow(/Espèces/);

    const z = s.pos.zReport(day.cash);
    expect(z.cash).toMatchObject({ otherIn: 5_000, otherOut: 10_000, expenses: 500, cashOut: 1_000 });
    expect(z.cash.expected).toBe(10_000 + 5_000 - 10_000 - 500 - 1_000);
    const j = s.pos.cashJournal(day.cash);
    expect(j.entries.map((r) => [r.source, r.nature])).toEqual([
      ['entry', 'Autre'],
      ['supplier_payment', 'Fournisseur'],
    ]);
    expect(j.exits.map((r) => [r.source, r.nature])).toEqual([
      ['supplier_payment', 'Règlement fournisseur'],
      ['expense', 'Dépense'],
      ['cash_operation', 'Prélèvement'],
    ]);
    expect(s.purchases.getInvoice(invoice.id).balance).toBe(0);
    expect(balance('4711')).toBe(-3_000);
  });

  it('caisse électronique : avance et remboursement par MoMo comptent dans son attendu', () => {
    const paul = s.staff.save(office, { name: 'Paul', baseSalary: 50_000 });
    const day = open();
    s.pos.completeSale(ctx, { lines: [{ articleId: riz, qty: 2_000 }], payments: [{ method: 'MTN_MOMO', amount: 10_000, reference: 'MP1' }] });
    expect(() => s.cashdesk.cashOut(ctx, day.momo, { type: 'staff_advance', staffId: paul.id, amount: 4_000, method: 'MTN_MOMO' }, adminId)).toThrow(/référence/);
    s.cashdesk.cashOut(ctx, day.momo, { type: 'staff_advance', staffId: paul.id, amount: 4_000, method: 'MTN_MOMO', reference: 'MP-AV' }, adminId);
    s.cashdesk.cashIn(ctx, day.momo, { type: 'staff', staffId: paul.id, amount: 1_000, method: 'MTN_MOMO', reference: 'MP-RB' });
    const line = s.pos.zReport(day.momo).declared!.find((d) => d.method === 'MTN_MOMO')!;
    expect(line).toMatchObject({ received: 10_000, outflows: 4_000, inflows: 1_000, expected: 7_000 });
    expect(s.pos.journal(day.momo).exits.map((r) => [r.source, r.nature, r.amount])).toEqual([['entry', 'Avance au personnel', 4_000]]);
    // La caisse espèces n'est pas touchée.
    expect(expected(day.cash)).toBe(10_000);
  });

  it('supprimer, antidater, convertir : seulement tant que la journée est ouverte', () => {
    const sup = s.purchases.saveSupplier(adminId, { name: 'SABC' });
    const invoice = s.purchases.createInvoice(office, { supplierId: sup.id, supplierNumber: 'FA-1', invoiceDate: '2026-10-10', totalHt: 5_000, totalTva: 0 });
    const day = open();
    later(60);
    const a = s.cashdesk.cashOut(ctx, day.cash, { type: 'other', accountId: '4711', amount: 2_000, method: 'CASH', label: 'Divers', party: 'Livreur' }, adminId);
    const b = s.cashdesk.cashOut(ctx, day.cash, { type: 'other', accountId: '4711', amount: 5_000, method: 'CASH', label: 'Facture SABC' }, adminId);
    expect(expected(day.cash)).toBe(3_000);

    expect(() => s.cashdesk.backdate(ctx, 'entry', a.id, '2026-10-11T08:00:00Z')).toThrow(/ouverte le/);
    s.cashdesk.backdate(ctx, 'entry', a.id, '2026-10-11T09:30:00Z');
    expect(s.cashdesk.get(a.id).at).toBe('2026-10-11T09:30:00.000Z');

    s.cashdesk.cancel(ctx, a.id, adminId, 'Erreur de saisie');
    expect(expected(day.cash)).toBe(5_000);

    const r = s.cashdesk.convert(ctx, b.id, { type: 'supplier', invoiceId: invoice.id }, adminId);
    expect(r.source).toBe('supplier_payment');
    expect(s.cashdesk.get(b.id).status).toBe('cancelled');
    expect(s.purchases.getInvoice(invoice.id).balance).toBe(0);
    expect(expected(day.cash)).toBe(5_000);

    later(60);
    s.pos.closeSession(ctx, { 5000: 1 } as never);
    expect(() => s.cashdesk.cancel(ctx, r.id, adminId, 'x')).toThrow();
    expect(() => s.cashdesk.cashIn(ctx, day.cash, { type: 'other', accountId: '4711', amount: 1, method: 'CASH', label: 'x' })).toThrow(/clôturée/);
  });

  it('reçu : la réimpression porte DUPLICATA, sauf si l’impression est annulée', () => {
    const day = open();
    const e = s.cashdesk.cashIn(ctx, day.cash, { type: 'other', accountId: '4711', amount: 3_000, method: 'CASH', label: 'Cartons' });
    const ticket = (dup: boolean) => s.receipts.deskTicket({ ...s.cashdesk.row(day.cash, e.source, e.id), duplicate: dup });
    expect(s.cashdesk.markPrinted(e.id)).toBe(0);
    expect(s.cashdesk.markPrinted(e.id)).toBe(1);
    expect(JSON.stringify(ticket(true))).toContain('DUPLICATA');
    s.cashdesk.unprint(ctx, e.id);
    expect(s.cashdesk.markPrinted(e.id)).toBe(0);
    expect(JSON.stringify(ticket(false))).toContain('REÇU DE CAISSE');
  });

  it('remboursement client : seulement l’avoir qu’il a sur son compte', () => {
    const c = s.customers.saveCustomer(adminId, { name: 'Boutique Bonamoussadi', creditLimit: 100_000 });
    const day = open();
    expect(() => s.cashdesk.cashOut(ctx, day.cash, { type: 'customer_refund', customerId: c.id, amount: 1_000, method: 'CASH' }, adminId)).toThrow(/pas d'avoir/);
    // Il paie d'avance 7 000 sur un achat à crédit de 5 000 : avoir de 2 000.
    s.pos.completeSale(ctx, { lines: [{ articleId: riz, qty: 1_000 }], payments: [{ method: 'CUSTOMER_CREDIT', amount: 5_000 }], customerId: c.id, creditAuthorizedBy: adminId });
    s.customers.receivePayment(ctx, { customerId: c.id, method: 'CASH', amount: 5_000, sessionId: day.cash });
    const ret = s.pos.listSales({ storeId, customerId: c.id })[0]!;
    s.pos.returnSale(ctx, { originalSaleId: ret.id, lines: [{ lineId: s.pos.getSale(ret.id).lines[0]!.id as never, qty: 1_000 }], refundMethod: 'CUSTOMER_CREDIT', supervisorId: adminId, reason: 'Retour' });
    expect(s.customers.account(storeId, c.id).balance).toBe(-5_000);
    later(1);
    s.cashdesk.cashOut(ctx, day.cash, { type: 'customer_refund', customerId: c.id, amount: 5_000, method: 'CASH' }, adminId);
    expect(s.customers.account(storeId, c.id).balance).toBe(0);
    expect(s.customers.statement(storeId, c.id).lines.at(-1)).toMatchObject({ kind: 'refund', debit: 5_000 });
  });
});
