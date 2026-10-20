import { beforeEach, describe, expect, it } from 'vitest';
import { type Context, type Services, createServices, openDatabase } from '../src';

let s: Services;
let ctx: Context;
let tva: string;
let now: Date;
let shop: string;
let coca: string;
let riz: string;
let boissons: string;

beforeEach(() => {
  now = new Date('2026-10-12T09:00:00Z');
  s = createServices(openDatabase(':memory:'), () => now);
  const { store, register, admin } = s.admin.bootstrap({ storeCode: 'DLA1', storeName: 'Superette Akwa', adminName: 'Steve', adminLogin: 'steve', adminPin: '1234' });
  ctx = { storeId: store.id, registerId: register.id, userId: admin.id };
  tva = s.admin.listVatRates().find((r) => r.rate_bp === 1925)!.id;
  shop = s.admin.salesWarehouse(store.id).id;
  const dep = s.catalogue.createDepartment('Boissons');
  boissons = s.catalogue.createFamily(dep.id, 'Sodas').id;
  const epicerie = s.catalogue.createFamily(s.catalogue.createDepartment('Épicerie').id, 'Riz').id;
  coca = s.catalogue.saveArticle(admin.id, { name: 'Coca-Cola 50 cl', unit: 'piece', vatRateId: tva, purchasePrice: 300, salePrice: 500, familyId: boissons }).id;
  riz = s.catalogue.saveArticle(admin.id, { name: 'Riz 5 kg', unit: 'piece', vatRateId: tva, purchasePrice: 3_000, salePrice: 4_200, familyId: epicerie }).id;
  s.stock.receive(ctx, { warehouseId: shop, lines: [{ articleId: coca, qty: 100_000, unitCost: 300 }, { articleId: riz, qty: 20_000, unitCost: 3_000 }] });
  s.pos.openSession(ctx, 0);
});

const stockOf = (articleId: string) => s.db.prepare('SELECT COALESCE(SUM(qty), 0) FROM stock WHERE article_id = ?').pluck().get(articleId) as number;
const balanceOf = (account: string) => s.accounting.trialBalance(ctx.storeId).rows.find((r) => r.account === account)?.closing ?? 0;

describe('tarifs par quantité et remises par famille', () => {
  it('baisse le prix à partir du palier atteint, sans remise à valider', () => {
    s.catalogue.setQtyTiers(ctx.userId, coca, [
      { minQty: 12_000, price: 450 },
      { minQty: 48_000, price: 420 },
    ]);
    expect(s.pos.priceLines(ctx.storeId, [{ articleId: coca, qty: 6_000 }])[0]!.unitPrice).toBe(500);
    expect(s.pos.priceLines(ctx.storeId, [{ articleId: coca, qty: 12_000 }])[0]!.unitPrice).toBe(450);
    expect(s.pos.priceLines(ctx.storeId, [{ articleId: coca, qty: 50_000 }])[0]!.unitPrice).toBe(420);
    const sale = s.pos.completeSale(ctx, { lines: [{ articleId: coca, qty: 12_000 }], payments: [{ method: 'CASH', amount: 5_400 }] });
    expect(sale.total_ttc).toBe(5_400);
    expect(sale.total_discount).toBe(0);
    expect(() => s.catalogue.setQtyTiers(ctx.userId, coca, [{ minQty: 12_000, price: 600 }])).toThrow(/plus bas/);
    expect(() =>
      s.catalogue.setQtyTiers(ctx.userId, coca, [
        { minQty: 12_000, price: 450 },
        { minQty: 24_000, price: 460 },
      ]),
    ).toThrow(/baisser/);
  });

  it('applique la remise du client sur sa famille seulement', () => {
    const c = s.customers.saveCustomer(ctx.userId, { name: 'Boutique Ngono', familyDiscounts: { [boissons]: 300 } });
    const lines = s.pos.priceLines(ctx.storeId, [{ articleId: coca, qty: 10_000 }, { articleId: riz, qty: 1_000 }], 'retail', c.id);
    expect(lines.map((l) => l.unitPrice)).toEqual([485, 4_200]);
    const sale = s.pos.completeSale(ctx, { lines: [{ articleId: coca, qty: 10_000 }], payments: [{ method: 'CASH', amount: 4_850 }], customerId: c.id });
    expect(sale.total_ttc).toBe(4_850);
    expect(() => s.customers.saveCustomer(ctx.userId, { name: 'X', familyDiscounts: { [boissons]: 6_000 } })).toThrow(/50 %/);
  });
});

describe('retour de marchandise au fournisseur', () => {
  it('sort du stock, attend l’avoir puis le rattache et réduit la dette', () => {
    const sup = s.purchases.saveSupplier(ctx.userId, { name: 'SABC' });
    const r = s.supplierReturns.create(ctx, { supplierId: sup.id, warehouseId: shop, reason: 'Bouteilles cassées', lines: [{ articleId: coca, qty: 24_000 }] });
    expect(r).toMatchObject({ status: 'open', total_ht: 7_200, total_tva: 1_386 });
    expect(stockOf(coca)).toBe(76_000);
    expect(s.supplierReturns.pending(ctx.storeId)).toEqual([expect.objectContaining({ supplier_name: 'SABC', count: 1, total_ttc: 8_586 })]);
    const moves = s.stock.movements(ctx.storeId, { articleId: coca, types: ['SUPPLIER_RETURN'] });
    expect(moves).toHaveLength(1);
    const done = s.supplierReturns.credit(ctx, r.id, { supplierNumber: 'AV-77', invoiceDate: '2026-10-12' });
    expect(done).toMatchObject({ status: 'credited', credit_note_ttc: 8_586 });
    expect(s.supplierReturns.pending(ctx.storeId)).toEqual([]);
    expect(() => s.supplierReturns.credit(ctx, r.id, { supplierNumber: 'AV-78', invoiceDate: '2026-10-12' })).toThrow(/déjà/);
    expect(() => s.supplierReturns.create(ctx, { supplierId: sup.id, warehouseId: shop, reason: 'x', lines: [{ articleId: riz, qty: 99_000 }] })).toThrow(/insuffisant/);
  });
});

describe('facture récapitulative', () => {
  it('regroupe les ventes du client sur la période, une seule fois', () => {
    const c = s.customers.saveCustomer(ctx.userId, { name: 'Hôtel du Lac', creditLimit: 500_000 });
    s.pos.completeSale(ctx, { lines: [{ articleId: coca, qty: 10_000 }], payments: [{ method: 'CUSTOMER_CREDIT', amount: 5_000 }], customerId: c.id });
    now = new Date('2026-10-20T09:00:00Z');
    s.pos.completeSale(ctx, { lines: [{ articleId: riz, qty: 2_000 }], payments: [{ method: 'CUSTOMER_CREDIT', amount: 8_400 }], customerId: c.id });
    expect(s.summaryInvoices.candidates(ctx.storeId, c.id, '2026-10-01', '2026-10-31')).toHaveLength(2);
    const inv = s.summaryInvoices.create(ctx, { customerId: c.id, from: '2026-10-01', to: '2026-10-31' });
    expect(inv).toMatchObject({ total_ttc: 13_400, sale_count: 2, on_credit: 13_400 });
    expect(inv.sales.flatMap((x) => x.lines.map((l) => l.label))).toEqual(['Coca-Cola 50 cl', 'Riz 5 kg']);
    expect(inv.vat.reduce((t, v) => t + v.ht + v.tva, 0)).toBe(13_400);
    expect(() => s.summaryInvoices.create(ctx, { customerId: c.id, from: '2026-10-01', to: '2026-10-31' })).toThrow(/Aucune vente/);
    s.summaryInvoices.cancel(ctx, inv.id);
    expect(s.summaryInvoices.candidates(ctx.storeId, c.id, '2026-10-01', '2026-10-31')).toHaveLength(2);
  });
});

describe('contremarque', () => {
  it('commande au fournisseur ce que le stock ne couvre pas et garde le lien', () => {
    const sup = s.purchases.saveSupplier(ctx.userId, { name: 'Olam' });
    s.purchases.setSupplierArticle(ctx.userId, { supplierId: sup.id, articleId: riz, unitCost: 2_900, isMain: true });
    const order = s.orders.save(ctx, { customerName: 'Mme Eko', phone: '699000000', lines: [{ articleId: riz, qty: 25_000 }, { articleId: coca, qty: 5_000 }] });
    expect(s.purchases.backOrderNeeds(ctx.storeId, order.id)).toEqual([expect.objectContaining({ articleId: riz, missing: 5_000, supplierName: 'Olam', unitCost: 2_900 })]);
    const [po] = s.purchases.backOrder(ctx, order.id);
    expect(po!.lines.map((l) => [l.article_id, l.qty])).toEqual([[riz, 5_000]]);
    const line = s.orders.get(order.id).lines.find((l) => l.article_id === riz)!;
    expect(line).toMatchObject({ purchase_order_number: po!.number, purchase_received: 0 });
    // Une deuxième commande de riz rejoint le même brouillon.
    const other = s.orders.save(ctx, { customerName: 'M. Abena', phone: '677000000', lines: [{ articleId: riz, qty: 3_000 }] });
    s.orders.prepare(ctx, order.id);
    const [po2] = s.purchases.backOrder(ctx, other.id);
    expect(po2!.id).toBe(po!.id);
    expect(po2!.lines[0]!.qty).toBe(8_000);
    expect(() => s.purchases.backOrder(ctx, other.id)).toThrow(/rien à commander/);
    // Modifier la commande client garde le bon où le riz est commandé.
    s.orders.save(ctx, { customerName: 'Mme Eko', phone: '699000000', lines: [{ articleId: riz, qty: 26_000 }] }, order.id);
    expect(s.orders.get(order.id).lines[0]!.purchase_order_id).toBe(po!.id);
  });
});

describe('remise de chèques', () => {
  it('garde les chèques au 513 puis les remet en banque en une écriture', () => {
    const c = s.customers.saveCustomer(ctx.userId, { name: 'Pharmacie du Port', creditLimit: 100_000 });
    s.pos.completeSale(ctx, { lines: [{ articleId: riz, qty: 1_000 }], payments: [{ method: 'CHEQUE', amount: 4_200, reference: 'CHQ 1001' }], customerId: c.id });
    s.pos.completeSale(ctx, { lines: [{ articleId: riz, qty: 2_000 }], payments: [{ method: 'CUSTOMER_CREDIT', amount: 8_400 }], customerId: c.id });
    s.customers.receivePayment(ctx, { customerId: c.id, method: 'CHEQUE', amount: 8_400, reference: 'CHQ 1002' });
    expect(s.cheques.pending(ctx.storeId).map((x) => x.amount)).toEqual([4_200, 8_400]);
    expect(balanceOf('513')).toBe(12_600);
    const bank = balanceOf('521');
    const d = s.cheques.create(ctx, { date: '2026-10-13', bank: 'Afriland' });
    expect(d).toMatchObject({ total: 12_600, count: 2 });
    expect(s.cheques.pending(ctx.storeId)).toEqual([]);
    expect(balanceOf('513')).toBe(0);
    expect(balanceOf('521')).toBe(bank + 12_600);
    s.cheques.cancel(ctx, d.id);
    expect(s.cheques.pending(ctx.storeId)).toHaveLength(2);
    expect(balanceOf('513')).toBe(12_600);
    expect(() => s.cheques.create(ctx, { date: '2026-10-01' })).toThrow(/après la date/);
  });
});

describe('pilotage', () => {
  it('trésorerie prévisionnelle : échéances clients, fournisseurs et charges par semaine', () => {
    const c = s.customers.saveCustomer(ctx.userId, { name: 'Hôtel du Lac', creditLimit: 500_000, paymentTermsDays: 10 });
    s.pos.completeSale(ctx, { lines: [{ articleId: riz, qty: 5_000 }], payments: [{ method: 'CUSTOMER_CREDIT', amount: 21_000 }], customerId: c.id });
    const sup = s.purchases.saveSupplier(ctx.userId, { name: 'Olam', paymentTermsDays: 3 });
    s.purchases.createInvoice(ctx, { supplierId: sup.id, supplierNumber: 'F-1', invoiceDate: '2026-10-12', totalHt: 50_000, totalTva: 0 });
    const loyer = s.expenses.listCategories().find((x) => x.name === 'Loyer')!;
    s.charges.savePlan(ctx, { categoryId: loyer.id, label: 'Loyer boutique', amount: 150_000, frequency: 'monthly', dueDay: 25, startMonth: '2026-10' });
    const f = s.planning.forecast(ctx.storeId, { weeks: 4, estimates: false });
    expect(f.weeks).toHaveLength(4);
    expect(f.weeks[0]).toMatchObject({ from: '2026-10-12', suppliers: -50_000, customers: 0 });
    expect(f.weeks[1]).toMatchObject({ customers: 21_000, charges: -150_000 });
    expect(f.weeks[1]!.opening).toBe(f.weeks[0]!.closing);
    expect(f.weeks[1]!.charges + f.weeks[2]!.charges).toBe(-150_000);
    expect(f.weeks[3]!.closing).toBe(f.opening + 21_000 - 50_000 - 150_000);
  });

  it('budgets : le mois et le cumul comparés au réel', () => {
    const cat = s.expenses.listCategories().find((x) => x.name === 'Transport et carburant')!;
    s.expenses.record(ctx, { categoryId: cat.id, label: 'Carburant', amount: 30_000, method: 'CASH', date: '2026-10-12' });
    s.planning.saveBudget(ctx, { year: 2026, account: '618', months: Array(12).fill(25_000) });
    const r = s.planning.budgetReport(ctx.storeId, 2026, 10);
    expect(r.rows[0]).toMatchObject({ account: '618', budget: 25_000, real: 30_000, gap: -5_000, budgetToDate: 250_000, realToDate: 30_000 });
    expect(() => s.planning.saveBudget(ctx, { year: 2026, account: '411', months: Array(12).fill(1) })).toThrow(/charges/);
  });

  it('analytique : marge et charges réparties par rayon', () => {
    s.pos.completeSale(ctx, { lines: [{ articleId: coca, qty: 10_000 }, { articleId: riz, qty: 5_000 }], payments: [{ method: 'CASH', amount: 26_000 }] });
    const cat = s.expenses.listCategories().find((x) => x.name === 'Divers')!;
    s.expenses.record(ctx, { categoryId: cat.id, label: 'Sacs', amount: 10_000, method: 'CASH', date: '2026-10-12' });
    const a = s.planning.analyticByDepartment(ctx.storeId, '2026-10-01', '2026-10-31');
    expect(a.rows.map((r) => r.label)).toEqual(['Épicerie', 'Boissons']);
    expect(a.rows.reduce((t, r) => t + r.charges, 0)).toBe(10_000);
    expect(a.total.result).toBe(a.total.margin - 10_000);
    expect(s.planning.analyticByStore('2026-10-01', '2026-10-31').rows).toHaveLength(1);
  });
});
