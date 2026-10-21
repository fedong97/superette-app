import { beforeEach, describe, expect, it } from 'vitest';
import { type Context, type Services, createServices, openDatabase } from '../src';

let s: Services;
let ctx: Context;
let now: Date;
let shop: string;
let coca: string;
let riz: string;

beforeEach(() => {
  now = new Date('2026-10-21T09:00:00Z');
  s = createServices(openDatabase(':memory:'), () => now);
  const { store, register, admin } = s.admin.bootstrap({ storeCode: 'DLA1', storeName: 'Superette Akwa', adminName: 'Steve', adminLogin: 'steve', adminPin: '1234' });
  ctx = { storeId: store.id, registerId: register.id, userId: admin.id };
  const tva = s.admin.listVatRates().find((r) => r.rate_bp === 1925)!.id;
  shop = s.admin.salesWarehouse(store.id).id;
  const fam = s.catalogue.createFamily(s.catalogue.createDepartment('Boissons').id, 'Sodas').id;
  coca = s.catalogue.saveArticle(admin.id, { name: 'Coca-Cola 50 cl', unit: 'piece', vatRateId: tva, purchasePrice: 300, salePrice: 500, familyId: fam }).id;
  riz = s.catalogue.saveArticle(admin.id, { name: 'Riz 5 kg', unit: 'piece', vatRateId: tva, purchasePrice: 3_000, salePrice: 4_200 }).id;
  s.stock.receive(ctx, { warehouseId: shop, lines: [{ articleId: coca, qty: 100_000, unitCost: 300 }, { articleId: riz, qty: 20_000, unitCost: 3_000 }] });
  s.pos.openSession(ctx, 0);
});

const stockIn = (warehouseId: string, articleId: string) =>
  s.db.prepare('SELECT COALESCE(SUM(qty), 0) FROM stock WHERE warehouse_id = ? AND article_id = ?').pluck().get(warehouseId, articleId) as number;
const creditSale = (customerId: string, articleId: string, qty: number, amount: number) =>
  s.pos.completeSale(ctx, { lines: [{ articleId, qty }], payments: [{ method: 'CUSTOMER_CREDIT', amount }], customerId });

describe('bonus fournisseur', () => {
  it('garde le bonus convenu sur le produit du fournisseur et chiffre les unités gratuites reçues', () => {
    const sup = s.purchases.saveSupplier(ctx.userId, { name: 'SABC' });
    const sa = s.purchases.setSupplierArticle(ctx.userId, { supplierId: sup.id, articleId: coca, unitCost: 300, promoBuy: 12, promoPay: 10 });
    expect(sa).toMatchObject({ promo_buy: 12, promo_pay: 10 });
    // Sans les champs, le bonus reste ; null le retire.
    expect(s.purchases.setSupplierArticle(ctx.userId, { supplierId: sup.id, articleId: coca, unitCost: 310 })).toMatchObject({ promo_buy: 12, unit_cost: 310 });
    expect(() => s.purchases.setSupplierArticle(ctx.userId, { supplierId: sup.id, articleId: coca, unitCost: 300, promoBuy: 10, promoPay: 12 })).toThrow(/Bonus invalide/);
    expect(s.purchases.setSupplierArticle(ctx.userId, { supplierId: sup.id, articleId: coca, unitCost: 300, promoBuy: null, promoPay: null })).toMatchObject({ promo_buy: null });

    s.stock.receive(ctx, { warehouseId: shop, supplierId: sup.id, lines: [{ articleId: coca, qty: 12_000, unitCost: 300, freeQty: 2_000 }] });
    const report = s.purchases.freeGoods(ctx.storeId, '2026-10-01', '2026-10-31');
    expect(report.rows).toEqual([expect.objectContaining({ supplier_name: 'SABC', article_id: coca, free_qty: 2_000, value: 600 })]);
    expect(report.total).toBe(600);
  });
});

describe('prix négocié client × article', () => {
  it('applique le prix convenu à la caisse, seulement s’il est plus bas', () => {
    const c = s.customers.saveCustomer(ctx.userId, { name: 'Hôtel du Lac', articlePrices: { [coca]: 450, [riz]: 9_999 } });
    const lines = s.pos.priceLines(ctx.storeId, [{ articleId: coca, qty: 10_000 }, { articleId: riz, qty: 1_000 }], 'retail', c.id);
    expect(lines.map((l) => l.unitPrice)).toEqual([450, 4_200]);
    const sale = s.pos.completeSale(ctx, { lines: [{ articleId: coca, qty: 10_000 }], payments: [{ method: 'CASH', amount: 4_500 }], customerId: c.id });
    expect(sale.total_ttc).toBe(4_500);
    expect(sale.total_discount).toBe(0);
    // Un autre client paie le prix normal.
    expect(s.pos.priceLines(ctx.storeId, [{ articleId: coca, qty: 1_000 }])[0]!.unitPrice).toBe(500);
  });
});

describe('zones et tournées', () => {
  it('range les clients par zone et filtre la liste', () => {
    s.customers.saveCustomer(ctx.userId, { name: 'Boutique A', zone: ' bonamoussadi ' });
    s.customers.saveCustomer(ctx.userId, { name: 'Boutique B', zone: 'Bonamoussadi' });
    s.customers.saveCustomer(ctx.userId, { name: 'Boutique C', zone: 'Akwa' });
    expect(s.customers.zones()).toEqual([
      { zone: 'AKWA', count: 1 },
      { zone: 'BONAMOUSSADI', count: 2 },
    ]);
    expect(s.customers.listCustomers(ctx.storeId, { zone: 'BONAMOUSSADI' }).map((c) => c.name)).toEqual(['Boutique A', 'Boutique B']);
  });
});

describe('lettrage manuel', () => {
  it('impute un règlement sur la facture choisie au lieu de la plus ancienne', () => {
    const c = s.customers.saveCustomer(ctx.userId, { name: 'Restaurant Mami', creditLimit: 100_000 });
    const first = creditSale(c.id, coca, 10_000, 5_000);
    now = new Date('2026-10-21T10:00:00Z');
    const second = creditSale(c.id, riz, 2_000, 8_400);
    const p = s.customers.receivePayment(ctx, { customerId: c.id, method: 'CASH', amount: 8_400, allocations: [{ saleId: second.id, amount: 8_400 }] });
    expect(s.customers.allocations(p.id)).toEqual([{ sale_id: second.id, number: second.number, amount: 8_400 }]);
    const open = s.customers.account(ctx.storeId, c.id).openItems;
    expect(open.map((i) => [i.id, i.remaining])).toEqual([[first.id, 5_000]]);
    expect(() => s.customers.setAllocations(ctx, p.id, [{ saleId: first.id, amount: 9_000 }])).toThrow();
  });
});

describe('compensation client / fournisseur', () => {
  it('solde ce que le tiers doit par ce qu’on lui doit, avec une écriture en OD', () => {
    const sup = s.purchases.saveSupplier(ctx.userId, { name: 'Grossiste Ndoumbe' });
    const c = s.customers.saveCustomer(ctx.userId, { name: 'Grossiste Ndoumbe', creditLimit: 100_000, supplierId: sup.id });
    creditSale(c.id, riz, 5_000, 21_000);
    const inv = s.purchases.createInvoice(ctx, { supplierId: sup.id, supplierNumber: 'FA-9', invoiceDate: '2026-10-21', totalHt: 15_000, totalTva: 0 });
    const cand = s.offsets.candidates(ctx.storeId, c.id);
    expect(cand).toMatchObject({ customerBalance: 21_000, supplierBalance: 15_000, max: 15_000 });
    expect(() => s.offsets.create(ctx, { customerId: c.id, invoiceId: inv.id, amount: 16_000 })).toThrow(/reste dû/);
    const o = s.offsets.create(ctx, { customerId: c.id, invoiceId: inv.id, amount: 15_000 });
    expect(o.number).toMatch(/^CP-/);
    expect(s.customers.account(ctx.storeId, c.id).balance).toBe(6_000);
    expect(s.purchases.getInvoice(inv.id).balance).toBe(0);
    const od = s.accounting.entries(ctx.storeId).find((e) => e.ref === o.number)!;
    expect(od.journal).toBe('OD');
    expect(od.lines.map((l) => [l.account.slice(0, 3), l.debit, l.credit])).toEqual([
      ['401', 15_000, 0],
      ['411', 0, 15_000],
    ]);
    expect(s.customers.statement(ctx.storeId, c.id).closing).toBe(6_000);

    s.offsets.cancel(ctx, o.id, 'Erreur de facture');
    expect(s.customers.account(ctx.storeId, c.id).balance).toBe(21_000);
    expect(s.purchases.getInvoice(inv.id).balance).toBe(15_000);
  });

  it('refuse un client qui n’est relié à aucun fournisseur', () => {
    const sup = s.purchases.saveSupplier(ctx.userId, { name: 'SABC' });
    const c = s.customers.saveCustomer(ctx.userId, { name: 'Client seul', creditLimit: 50_000 });
    const inv = s.purchases.createInvoice(ctx, { supplierId: sup.id, supplierNumber: 'FA-1', invoiceDate: '2026-10-21', totalHt: 1_000, totalTva: 0 });
    expect(() => s.offsets.create(ctx, { customerId: c.id, invoiceId: inv.id, amount: 500 })).toThrow(/relié/);
  });
});

describe('dépôt des avaries', () => {
  it('ne vend jamais depuis le dépôt des avaries et ne le compte pas dans les besoins de commande', () => {
    const damaged = s.admin.createWarehouse(ctx.storeId, 'Avaries', 'reserve', false, { purpose: 'damaged' });
    expect(damaged.purpose).toBe('damaged');
    expect(() => s.pos.completeSale(ctx, { lines: [{ articleId: coca, qty: 1_000 }], payments: [{ method: 'CASH', amount: 500 }], warehouseId: damaged.id })).toThrow();
    expect(() => s.admin.setSalesWarehouse(ctx.userId, damaged.id)).toThrow();
  });
});

describe('demande de modification de facture', () => {
  it('le vendeur demande, le gérant accorde, la demande ne sert qu’une fois', () => {
    const awa = s.admin.createUser(ctx.userId, { name: 'Awa', login: 'awa', pin: '5678', role: 'cashier', storeId: ctx.storeId });
    const sale = s.pos.completeSale(ctx, { lines: [{ articleId: coca, qty: 2_000 }], payments: [{ method: 'CASH', amount: 1_000 }] });
    const awaCtx = { ...ctx, userId: awa.id };
    const r = s.editRequests.request(awaCtx, sale.id, 'Le client voulait 3 bouteilles');
    expect(r).toMatchObject({ status: 'pending', sale_number: sale.number, requester_name: 'Awa' });
    expect(() => s.editRequests.request(awaCtx, sale.id, 'Encore')).toThrow(/déjà en cours/);
    expect(() => s.editRequests.decide(awaCtx, r.id, true)).toThrow(/autre utilisateur/);
    expect(s.attention.list(ctx.storeId, new Set(['sale_edit_requests'])).find((a) => a.key === 'sale_edit_requests')).toBeTruthy();
    expect(() => s.editRequests.decide(ctx, r.id, false)).toThrow(/pourquoi/);
    s.editRequests.decide(ctx, r.id, true, null);
    const grant = s.editRequests.granted(awa.id, sale.id);
    expect(grant?.id).toBe(r.id);
    const edited = s.pos.replaceSale(awaCtx, sale.id, { lines: [{ articleId: coca, qty: 3_000 }], payments: [{ method: 'CASH', amount: 500 }] }, awa.id);
    s.editRequests.markUsed(awaCtx, r.id, edited.id);
    expect(s.editRequests.get(r.id)).toMatchObject({ status: 'used', new_sale_number: edited.number });
    expect(s.editRequests.granted(awa.id, sale.id)).toBeNull();
  });
});

describe('dépôt-vente chez un revendeur', () => {
  it('confie la marchandise, compte ce qui reste, facture le vendu à crédit et reprend le reste', () => {
    const c = s.customers.saveCustomer(ctx.userId, { name: 'Kiosque Deido', creditLimit: 0 });
    const depot = s.consignment.openDepot(ctx, c.id);
    expect(depot).toMatchObject({ purpose: 'consignment', customer_id: c.id });
    s.consignment.send(ctx, { warehouseId: depot.id, fromWarehouseId: shop, lines: [{ articleId: coca, qty: 24_000 }] });
    expect(stockIn(depot.id, coca)).toBe(24_000);
    expect(stockIn(shop, coca)).toBe(76_000);
    // La caisse ne vend pas depuis un dépôt-vente.
    expect(() => s.pos.completeSale(ctx, { lines: [{ articleId: coca, qty: 1_000 }], payments: [{ method: 'CASH', amount: 500 }], warehouseId: depot.id })).toThrow();

    const fiche = s.consignment.count(ctx, { warehouseId: depot.id, lines: [{ articleId: coca, counted: 4_000 }], takeBack: { toWarehouseId: shop } });
    expect(fiche.number).toMatch(/^FC-/);
    expect(fiche.total_ttc).toBe(10_000);
    expect(fiche.lines[0]).toMatchObject({ expected: 24_000, counted: 4_000, sold: 20_000, returned: 4_000 });
    expect(stockIn(depot.id, coca)).toBe(0);
    expect(stockIn(shop, coca)).toBe(80_000);
    expect(s.customers.account(ctx.storeId, c.id).balance).toBe(10_000);
    expect(s.consignment.history(ctx.storeId, depot.id)).toHaveLength(1);
  });
});

describe('sociétés et patrimoine', () => {
  it('regroupe les magasins et suit le patrimoine mois par mois', () => {
    const co = s.companies.save(ctx.userId, { name: 'MAK SINO SARL', taxpayerNumber: 'm012345678901a' });
    expect(co.taxpayer_number).toBe('M012345678901A');
    expect(() => s.companies.save(ctx.userId, { name: 'mak sino sarl' })).toThrow(/déjà/);
    s.companies.assignStore(ctx.userId, ctx.storeId, co.id);
    expect(s.companies.list()[0]!.stores.map((x) => x.id)).toEqual([ctx.storeId]);

    s.pos.completeSale(ctx, { lines: [{ articleId: coca, qty: 10_000 }], payments: [{ method: 'CASH', amount: 5_000 }] });
    const p = s.companies.patrimonyAt(ctx.storeId, '2026-10-21');
    expect(p.stock).toBe(s.stock.valueAt(ctx.storeId, '2026-10-21'));
    expect(p.patrimony).toBe(p.treasury + p.receivables + p.stock - p.payables);
    expect(p.treasury).toBeGreaterThanOrEqual(5_000);

    const series = s.companies.patrimony({ companyId: co.id }, 6);
    expect(series.points).toHaveLength(6);
    expect(series.points.at(-1)!.date).toBe('2026-10-21');
    expect(series.points[0]!.date).toBe('2026-05-31');
    const cons = s.companies.consolidated(co.id);
    expect(cons.total.sales).toBe(5_000);
    expect(cons.stores).toHaveLength(1);
  });
});
