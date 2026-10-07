import { describe, expect, it } from 'vitest';
import { addMonths, chargePeriods, createServices, openDatabase } from '../src';

function setup() {
  let now = new Date('2026-10-05T09:00:00Z');
  const s = createServices(openDatabase(':memory:'), () => now);
  const { store, register, admin } = s.admin.bootstrap({ storeCode: 'DLA1', storeName: 'Superette Akwa', adminName: 'Steve', adminLogin: 'steve', adminPin: '1234' });
  const ctx = { storeId: store.id, registerId: register.id, userId: admin.id };
  const tva = s.admin.listVatRates().find((r) => r.rate_bp === 1925)!.id;
  const shop = s.admin.salesWarehouse(store.id).id;
  const coca = s.catalogue.saveArticle(admin.id, { name: 'Coca-Cola 50 cl', unit: 'piece', vatRateId: tva, purchasePrice: 300, salePrice: 500 });
  const riz = s.catalogue.saveArticle(admin.id, { name: 'Riz parfumé 5 kg', unit: 'piece', vatRateId: tva, purchasePrice: 3000, salePrice: 4200 });
  s.stock.receive(ctx, { warehouseId: shop, lines: [{ articleId: coca.id, qty: 100_000, unitCost: 300 }, { articleId: riz.id, qty: 20_000, unitCost: 3000 }] });
  const session = s.pos.openSession(ctx, 10_000);
  const at = (iso: string) => {
    now = new Date(iso);
  };
  return { s, ctx, shop, coca, riz, session, at, store };
}

describe('registres et contrôles', () => {
  it('registre des ventes : filtres, recherche et totaux', () => {
    const { s, ctx, coca, riz, at } = setup();
    at('2026-10-05T10:00:00Z');
    const a = s.pos.completeSale(ctx, { lines: [{ articleId: coca.id, qty: 2000 }], payments: [{ method: 'CASH', amount: 1000 }] });
    at('2026-10-05T11:00:00Z');
    const b = s.pos.completeSale(ctx, { lines: [{ articleId: riz.id, qty: 1000 }], payments: [{ method: 'MTN_MOMO', amount: 4200, reference: 'TX1' }] });
    s.pos.returnSale(ctx, { originalSaleId: b.id, lines: [{ lineId: b.lines[0]!.id, qty: 1000 }], refundMethod: 'CASH', supervisorId: ctx.userId, reason: 'Sac percé' });
    const c = s.pos.completeSale(ctx, { lines: [{ articleId: coca.id, qty: 1000 }], payments: [{ method: 'CASH', amount: 500 }] });
    s.pos.cancelSale(ctx, c.id, ctx.userId, 'Erreur de saisie');

    const all = s.controls.salesRegister(ctx.storeId, { from: '2026-10-05', to: '2026-10-05' });
    expect(all.rows).toHaveLength(4);
    expect(all.totals).toMatchObject({ count: 2, sales: 5200, returns: -4200, returnCount: 1, net: 1000, cancelled: 500, cancelledCount: 1 });
    expect(all.registers).toHaveLength(1);
    const returns = s.controls.salesRegister(ctx.storeId, { from: '2026-10-05', to: '2026-10-05', kind: 'return' });
    expect(returns.rows.map((r) => r.original_number)).toEqual([b.number]);
    expect(s.controls.salesRegister(ctx.storeId, { from: '2026-10-05', to: '2026-10-05', search: a.number }).rows.map((r) => r.id)).toEqual([a.id]);
    // Recherche par montant : le retour de 4 200 F et la vente d'origine.
    expect(s.controls.salesRegister(ctx.storeId, { from: '2026-10-05', to: '2026-10-05', search: '4 200' }).rows).toHaveLength(2);
    expect(s.controls.salesRegister(ctx.storeId, { from: '2026-10-05', to: '2026-10-05', status: 'cancelled' }).rows[0]).toMatchObject({ cancel_reason: 'Erreur de saisie' });
    expect(() => s.controls.salesRegister(ctx.storeId, { from: '2026-10-06', to: '2026-10-05' })).toThrow(/Période|début/);
  });

  it('alertes : vente à perte, remise importante, annulation, retour, plafond forcé', () => {
    const { s, ctx, coca, riz, at } = setup();
    at('2026-10-05T10:00:00Z');
    // Riz à 4 200 TTC − 1 500 de remise = 2 700 TTC, soit 2 264 HT pour un coût de 3 000.
    s.pos.completeSale(ctx, { lines: [{ articleId: riz.id, qty: 1000, discount: 1500 }], payments: [{ method: 'CASH', amount: 2700 }], discountAuthorizedBy: ctx.userId });
    // Petite remise (2 %) : pas d'alerte.
    s.pos.completeSale(ctx, { lines: [{ articleId: coca.id, qty: 10_000, discount: 100 }], payments: [{ method: 'CASH', amount: 4900 }], discountAuthorizedBy: ctx.userId });
    const c = s.pos.completeSale(ctx, { lines: [{ articleId: coca.id, qty: 1000 }], payments: [{ method: 'CASH', amount: 500 }] });
    s.pos.cancelSale(ctx, c.id, ctx.userId, 'Client parti');
    const client = s.customers.saveCustomer(ctx.userId, { name: 'M. Etoundi' });
    s.pos.completeSale(ctx, { lines: [{ articleId: coca.id, qty: 2000 }], payments: [{ method: 'CUSTOMER_CREDIT', amount: 1000 }], customerId: client.id, creditAuthorizedBy: ctx.userId });

    const { alerts, counts } = s.controls.salesAlerts(ctx.storeId, { from: '2026-10-05', to: '2026-10-05' });
    expect(counts).toEqual({ below_cost: 1, discount: 1, cancelled: 1, return: 0, credit_override: 1 });
    expect(alerts.find((x) => x.kind === 'below_cost')).toMatchObject({ label: 'Riz parfumé 5 kg', amount: 3000 - 2264 });
    expect(alerts.find((x) => x.kind === 'discount')).toMatchObject({ amount: 1500, detail: expect.stringMatching(/^36 % de remise sur 4\s200 FCFA$/) });
    expect(alerts.find((x) => x.kind === 'credit_override')).toMatchObject({ label: 'M. Etoundi', amount: 1000 });
  });

  it('achats par produit et marchandises non encore reçues', () => {
    const { s, ctx, shop, coca, riz, at } = setup();
    const sabc = s.purchases.saveSupplier(ctx.userId, { name: 'SABC' });
    const order = s.purchases.createOrder(ctx, {
      supplierId: sabc.id,
      warehouseId: shop,
      lines: [
        { articleId: coca.id, qty: 48_000, unitCost: 310 },
        { articleId: riz.id, qty: 10_000, unitCost: 3100 },
      ],
    });
    s.purchases.setOrderStatus(ctx, order.id, 'sent');
    at('2026-10-06T08:00:00Z');
    s.purchases.receiveOrder(ctx, order.id, { lines: [{ orderLineId: order.lines[0]!.id, articleId: coca.id, qty: 24_000, unitCost: 310 }] });

    const pending = s.controls.pendingReceipts(ctx.storeId);
    expect(pending.lines.map((l) => [l.name, l.remaining, l.value])).toEqual([
      ['Coca-Cola 50 cl', 24_000, 7440],
      ['Riz parfumé 5 kg', 10_000, 31_000],
    ]);
    expect(pending).toMatchObject({ orders: 1, value: 38_440, late: 0 });
    at('2026-10-20T08:00:00Z');
    expect(s.controls.pendingReceipts(ctx.storeId).late).toBe(38_440);

    const byProduct = s.controls.purchasesByProduct(ctx.storeId, { from: '2026-10-01', to: '2026-10-31' });
    // Coca : 100 reçus à 300 (sans fournisseur) puis 24 à 310.
    expect(byProduct.rows.find((r) => r.name === 'Coca-Cola 50 cl')).toMatchObject({ receptions: 2, qty: 124_000, amount_ht: 37_440, min_cost: 300, max_cost: 310, last_cost: 310, suppliers: 'SABC' });
    expect(s.controls.purchasesByProduct(ctx.storeId, { from: '2026-10-01', to: '2026-10-31', supplierId: sabc.id }).total).toBe(7440);
  });

  it('opérations de caisse, stock par dépôt', () => {
    const { s, ctx, shop, coca, store, at } = setup();
    at('2026-10-05T12:00:00Z');
    s.pos.cashOperation(ctx, 'OUT', 5000, 'Mise au coffre');
    at('2026-10-05T12:10:00Z');
    s.pos.cashOperation(ctx, 'IN', 2000, 'Monnaie');
    at('2026-10-05T12:20:00Z');
    s.expenses.record(ctx, { categoryId: 'cat-transport', label: 'Taxi livraison', amount: 1500, method: 'CASH', atRegister: true });
    const ops = s.controls.cashOperations(ctx.storeId, { from: '2026-10-05', to: '2026-10-05' });
    expect(ops.rows.map((r) => [r.kind, r.amount])).toEqual([
      ['expense', -1500],
      ['in', 2000],
      ['out', -5000],
      ['float', 10_000],
    ]);
    expect(ops.totals).toMatchObject({ float: 10_000, in: 2000, out: -5000, expense: -1500 });

    const reserve = s.admin.createWarehouse(store.id, 'Chambre froide', 'cold');
    s.stock.transfer(ctx, { fromWarehouseId: shop, toWarehouseId: reserve.id, lines: [{ articleId: coca.id, qty: 40_000 }] });
    const by = s.controls.stockByWarehouse(ctx.storeId, { search: 'coca' });
    expect(by.warehouses.map((w) => w.name)).toEqual(['Chambre froide', 'Réserve', 'Surface de vente']);
    expect(by.articles[0]).toMatchObject({ total: 100_000, qty: { [shop]: 60_000, [reserve.id]: 40_000 } });
    expect(s.stock.movements(ctx.storeId, { types: ['TRANSFER_IN'] })).toHaveLength(1);
    const boissons = s.catalogue.createDepartment('Boissons');
    s.catalogue.createFamily(boissons.id, 'Sodas');
    const shelf = s.controls.shelving(ctx.storeId);
    // Coca : 100 × 300 ; riz : 20 × 3 000 ; la famille Sodas est encore vide.
    expect(shelf.rows.map((r) => [r.department, r.family, r.articles, r.value])).toEqual([
      ['Boissons', 'Sodas', 0, 0],
      ['Sans rayon', 'Sans famille', 2, 90_000],
    ]);
  });

  it('comptes fournisseurs et clients : extrait, situation, soldes qui ont bougé, plafonds', () => {
    const { s, ctx, shop, coca, at } = setup();
    const sabc = s.purchases.saveSupplier(ctx.userId, { name: 'SABC', paymentTermsDays: 30 });
    at('2026-09-01T08:00:00Z');
    s.purchases.createInvoice(ctx, { supplierId: sabc.id, supplierNumber: 'FA-1', invoiceDate: '2026-09-01', totalHt: 10_000, totalTva: 0 });
    at('2026-10-04T08:00:00Z');
    const inv2 = s.purchases.createInvoice(ctx, { supplierId: sabc.id, supplierNumber: 'FA-2', invoiceDate: '2026-10-04', totalHt: 5000, totalTva: 0 });
    s.purchases.paySupplier(ctx, { invoiceId: inv2.id, method: 'CASH', amount: 2000 });
    at('2026-10-05T08:00:00Z');

    const st = s.controls.supplierStatement(ctx.storeId, sabc.id, { from: '2026-10-01' });
    expect(st).toMatchObject({ opening: 10_000, closing: 13_000, debit: 5000, credit: 2000 });
    expect(st.lines.map((l) => [l.kind, l.balance])).toEqual([
      ['invoice', 15_000],
      ['payment', 13_000],
    ]);
    expect(st.lines[1]!.label).toBe('Règlement Espèces');
    const sit = s.controls.supplierSituation(ctx.storeId);
    // FA-1 échue le 1er octobre ; FA-2 pas encore.
    expect(sit.rows[0]).toMatchObject({ name: 'SABC', invoiced: 15_000, paid: 2000, balance: 13_000, overdue: 10_000 });
    expect(s.controls.recentAccounts(ctx.storeId, 'supplier', 7).map((r) => [r.name, r.movements, r.change, r.balance])).toEqual([['SABC', 2, 3000, 13_000]]);

    const mballa = s.customers.saveCustomer(ctx.userId, { name: 'Chez Mballa', creditLimit: 10_000 });
    const ngo = s.customers.saveCustomer(ctx.userId, { name: 'Mme Ngo', creditLimit: 50_000 });
    s.customers.saveCustomer(ctx.userId, { name: 'Sans crédit' });
    s.pos.completeSale(ctx, { lines: [{ articleId: coca.id, qty: 18_000 }], payments: [{ method: 'CUSTOMER_CREDIT', amount: 9000 }], customerId: mballa.id });
    s.pos.completeSale(ctx, { lines: [{ articleId: coca.id, qty: 4000 }], payments: [{ method: 'CUSTOMER_CREDIT', amount: 2000 }], customerId: mballa.id, creditAuthorizedBy: ctx.userId });
    at('2026-10-05T10:00:00Z');
    s.pos.completeSale(ctx, { lines: [{ articleId: coca.id, qty: 2000 }], payments: [{ method: 'CUSTOMER_CREDIT', amount: 1000 }], customerId: ngo.id });
    const credit = s.controls.creditControl(ctx.storeId);
    expect(credit.rows.map((r) => [r.name, r.status, r.balance])).toEqual([
      ['Chez Mballa', 'over', 11_000],
      ['Mme Ngo', 'ok', 1000],
    ]);
    expect(credit.counts).toEqual({ over: 1, near: 0, noLimit: 0 });
    expect(s.controls.recentAccounts(ctx.storeId, 'customer').map((r) => [r.name, r.movements, r.change])).toEqual([
      ['Mme Ngo', 1, 1000],
      ['Chez Mballa', 2, 11_000],
    ]);
    expect(shop).toBeTruthy();
  });
});

describe('charges fixes', () => {
  it('calcule les échéances selon le rythme', () => {
    expect(addMonths('2026-11', 3)).toBe('2027-02');
    expect(chargePeriods({ frequency: 'quarterly', start_month: '2026-01', end_month: null }, '2026-03', '2026-12')).toEqual(['2026-04', '2026-07', '2026-10']);
    expect(chargePeriods({ frequency: 'monthly', start_month: '2026-08', end_month: '2026-09' }, '2026-01', '2026-12')).toEqual(['2026-08', '2026-09']);
  });

  it('constate les échéances par les dépenses et signale les retards', () => {
    const { s, ctx, at } = setup();
    const loyer = s.charges.savePlan(ctx, { categoryId: 'cat-loyer', label: 'Loyer boutique', beneficiary: 'M. Kamga', amount: 150_000, frequency: 'monthly', dueDay: 5, startMonth: '2026-08' });
    const eneo = s.charges.savePlan(ctx, { categoryId: 'cat-eneo', label: 'ENEO', amount: 40_000, frequency: 'monthly', dueDay: 10, startMonth: '2026-09' });
    expect(() => s.charges.savePlan(ctx, { categoryId: 'cat-loyer', label: 'X', amount: 1, frequency: 'monthly', dueDay: 31, startMonth: '2026-08' })).toThrow('1 au 28');

    at('2026-08-05T08:00:00Z');
    s.expenses.record(ctx, { categoryId: 'cat-loyer', label: 'Loyer août', amount: 150_000, method: 'CASH', planId: loyer.id, planPeriod: '2026-08' });
    expect(() =>
      s.expenses.record(ctx, { categoryId: 'cat-loyer', label: 'Loyer août', amount: 150_000, method: 'CASH', planId: loyer.id, planPeriod: '2026-08' }),
    ).toThrow('déjà constatée');
    expect(() => s.expenses.record(ctx, { categoryId: 'cat-eneo', label: 'ENEO', amount: 1, method: 'CASH', planId: eneo.id, planPeriod: '2026-08' })).toThrow("pas une échéance");

    at('2026-10-06T08:00:00Z');
    const { occurrences, totals } = s.charges.schedule(ctx.storeId, '2026-08', '2026-10');
    expect(occurrences.map((o) => [o.label, o.period, o.state])).toEqual([
      ['Loyer boutique', '2026-08', 'paid'],
      ['Loyer boutique', '2026-09', 'late'],
      ['ENEO', '2026-09', 'late'],
      ['Loyer boutique', '2026-10', 'late'],
      ['ENEO', '2026-10', 'due'],
    ]);
    expect(totals).toMatchObject({ expected: 530_000, paid: 150_000, late: 340_000, due: 40_000 });
    expect(s.charges.late(ctx.storeId)).toEqual({ count: 3, amount: 340_000 });

    // Une charge arrêtée ne compte plus que ses échéances déjà payées.
    s.charges.savePlan(ctx, { categoryId: 'cat-loyer', label: 'Loyer boutique', amount: 150_000, frequency: 'monthly', dueDay: 5, startMonth: '2026-08', active: false }, loyer.id);
    expect(s.charges.schedule(ctx.storeId, '2026-08', '2026-10').occurrences.filter((o) => o.plan_id === loyer.id).map((o) => o.state)).toEqual(['paid']);
    expect(s.db.prepare("SELECT COUNT(*) FROM outbox WHERE entity = 'charge_plan'").pluck().get()).toBe(3);
  });
});
