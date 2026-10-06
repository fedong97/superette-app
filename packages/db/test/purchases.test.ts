import { suggestReorder } from '@superette/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { type Context, type Services, createServices, openDatabase } from '../src';

let now = new Date('2026-10-06T08:00:00Z');
const clock = () => now;
const advanceDays = (d: number) => {
  now = new Date(now.getTime() + d * 86_400_000);
};

let s: Services;
let ctx: Context;
let shop: string;
let tva: string;

function setup() {
  now = new Date('2026-10-06T08:00:00Z');
  s = createServices(openDatabase(':memory:'), clock);
  const { store, register, admin } = s.admin.bootstrap({ storeCode: 'DLA1', storeName: 'Superette Akwa', adminName: 'Steve', adminLogin: 'steve', adminPin: '1234' });
  ctx = { storeId: store.id, registerId: register.id, userId: admin.id };
  shop = s.admin.salesWarehouse(store.id).id;
  tva = s.admin.listVatRates().find((r) => r.rate_bp === 1925)!.id;
}

function article(name: string, opts: Partial<Parameters<Services['catalogue']['saveArticle']>[1]> = {}) {
  return s.catalogue.saveArticle(ctx.userId, { name, unit: 'piece', vatRateId: tva, purchasePrice: 0, salePrice: 1000, ...opts });
}

const stockOf = (articleId: string) => s.stock.list(ctx.storeId).find((r) => r.article_id === articleId)!;

describe('proposition de commande (règle)', () => {
  it('commande au colis quand le disponible passe sous le point de commande', () => {
    // 10 ventes par jour, livré en 3 jours, couverture 7 jours : point 30, cible 100.
    const base = { avgDailySales: 10_000, leadTimeDays: 3, coverDays: 7, packQty: 24_000 };
    expect(suggestReorder({ ...base, stock: 40_000, onOrder: 0 }).qty).toBe(0);
    expect(suggestReorder({ ...base, stock: 20_000, onOrder: 0 })).toEqual({ reorderPoint: 30_000, target: 100_000, qty: 96_000 });
    expect(suggestReorder({ ...base, stock: 20_000, onOrder: 48_000 }).qty).toBe(0);
    // Sans historique : le stock d'alerte et le stock maximum de la fiche suffisent.
    expect(suggestReorder({ stock: 2_000, onOrder: 0, avgDailySales: 0, leadTimeDays: 2, coverDays: 7, alertQty: 5_000, maxQty: 20_000 }).qty).toBe(18_000);
  });
});

describe('fournisseurs et achats', () => {
  beforeEach(setup);

  it('fiche fournisseur et articles référencés, le premier devient principal', () => {
    const sabc = s.purchases.saveSupplier(ctx.userId, { name: 'SABC', phone: '233 42 31 44', paymentTermsDays: 30, leadTimeDays: 3 });
    const ucb = s.purchases.saveSupplier(ctx.userId, { name: 'UCB' });
    expect(sabc.code).toBe('FRN-DLA11-00001');
    const biere = article('33 Export 65 cl');
    s.purchases.setSupplierArticle(ctx.userId, { supplierId: sabc.id, articleId: biere.id, supplierRef: 'EXP65', unitCost: 450, packQty: 12_000 });
    s.purchases.setSupplierArticle(ctx.userId, { supplierId: ucb.id, articleId: biere.id, unitCost: 440 });
    expect(s.purchases.articleSuppliers(biere.id).map((a) => [a.supplier_name, a.is_main])).toEqual([
      ['SABC', 1],
      ['UCB', 0],
    ]);
    s.purchases.setSupplierArticle(ctx.userId, { supplierId: ucb.id, articleId: biere.id, unitCost: 440, isMain: true });
    expect(s.purchases.articleSuppliers(biere.id).find((a) => a.is_main)?.supplier_name).toBe('UCB');
    expect(s.db.prepare("SELECT COUNT(*) FROM outbox WHERE entity IN ('supplier', 'supplier_article')").pluck().get()).toBeGreaterThanOrEqual(5);
  });

  it('commande, réception en deux fois, solde du reliquat', () => {
    const sabc = s.purchases.saveSupplier(ctx.userId, { name: 'SABC', leadTimeDays: 3 });
    const biere = article('33 Export 65 cl');
    const yaourt = article('Yaourt nature', { perishable: true });
    const order = s.purchases.createOrder(ctx, {
      supplierId: sabc.id,
      warehouseId: shop,
      lines: [
        { articleId: biere.id, qty: 48_000, unitCost: 450 },
        { articleId: yaourt.id, qty: 24_000, unitCost: 200 },
      ],
    });
    expect(order).toMatchObject({ number: 'BC-DLA11-00001', state: 'draft', total_ht: 26_400, expected_date: '2026-10-09' });
    expect(() => s.purchases.receiveOrder(ctx, order.id, { lines: [] })).toThrow('Envoyez la commande');
    s.purchases.setOrderStatus(ctx, order.id, 'sent');

    const [lBiere, lYaourt] = order.lines;
    expect(() =>
      s.purchases.receiveOrder(ctx, order.id, { lines: [{ orderLineId: lYaourt!.id, articleId: yaourt.id, qty: 24_000, unitCost: 200 }] }),
    ).toThrow('Date limite');
    const r1 = s.purchases.receiveOrder(ctx, order.id, {
      deliveryNote: 'BL 7781',
      lines: [
        { orderLineId: lBiere!.id, articleId: biere.id, qty: 24_000, unitCost: 450 },
        { orderLineId: lYaourt!.id, articleId: yaourt.id, qty: 24_000, unitCost: 210, expiry: '2026-10-20' },
      ],
    });
    expect(r1.number).toBe('BR-DLA11-00001');
    expect(s.purchases.getOrder(order.id).state).toBe('partial');
    expect(stockOf(biere.id).qty).toBe(24_000);
    expect(s.stock.lotsOf(yaourt.id, ctx.storeId)[0]).toMatchObject({ expiry: '2026-10-20', qty: 24_000 });

    const reception = s.purchases.getReception(r1.id);
    // 24 × 450 + 24 × 210 = 15 840 HT, TVA 19,25 % = 3 049.
    expect(reception).toMatchObject({ supplier_name: 'SABC', order_number: 'BC-DLA11-00001', delivery_note: 'BL 7781', total_ht: 15_840, total_tva: 3_049 });

    expect(() => s.purchases.setOrderStatus(ctx, order.id, 'cancelled')).toThrow('se solde');
    s.purchases.setOrderStatus(ctx, order.id, 'closed');
    expect(s.purchases.getOrder(order.id).state).toBe('closed');
    expect(s.purchases.listOrders(ctx.storeId, { open: true })).toHaveLength(0);
  });

  it('facture rapprochée des réceptions, échéance et règlements', () => {
    const sabc = s.purchases.saveSupplier(ctx.userId, { name: 'SABC', paymentTermsDays: 30 });
    const biere = article('33 Export 65 cl');
    const r1 = s.stock.receive(ctx, { warehouseId: shop, supplierId: sabc.id, reference: 'BL 1', lines: [{ articleId: biere.id, qty: 24_000, unitCost: 450 }] });
    const r2 = s.stock.receive(ctx, { warehouseId: shop, supplierId: sabc.id, reference: 'BL 2', lines: [{ articleId: biere.id, qty: 12_000, unitCost: 450 }] });
    expect(s.purchases.listReceptions(ctx.storeId, { supplierId: sabc.id, uninvoiced: true })).toHaveLength(2);
    expect(s.purchases.invoicePreview([r1.id, r2.id])).toEqual({ total_ht: 16_200, total_tva: 3_119, total_ttc: 19_319 });

    const invoice = s.purchases.createInvoice(ctx, {
      supplierId: sabc.id,
      supplierNumber: 'FA-2026-118',
      invoiceDate: '2026-10-06',
      totalHt: 16_200,
      totalTva: 3_119,
      receptionIds: [r1.id, r2.id],
    });
    expect(invoice).toMatchObject({ number: 'FF-DLA11-00001', due_date: '2026-11-05', total_ttc: 19_319, received_ht: 16_200, state: 'unpaid' });
    expect(s.purchases.listReceptions(ctx.storeId, { uninvoiced: true })).toHaveLength(0);
    expect(() =>
      s.purchases.createInvoice(ctx, { supplierId: sabc.id, supplierNumber: 'FA-2026-118', invoiceDate: '2026-10-06', totalHt: 1, totalTva: 0 }),
    ).toThrow('déjà saisie');

    expect(() => s.purchases.paySupplier(ctx, { invoiceId: invoice.id, method: 'MTN_MOMO', amount: 10_000 })).toThrow('référence');
    s.purchases.paySupplier(ctx, { invoiceId: invoice.id, method: 'CASH', amount: 10_000 });
    expect(s.purchases.getInvoice(invoice.id)).toMatchObject({ state: 'partial', balance: 9_319 });
    expect(() => s.purchases.paySupplier(ctx, { invoiceId: invoice.id, method: 'CASH', amount: 10_000 })).toThrow('reste à payer');

    advanceDays(31);
    const due = s.purchases.dueSchedule(ctx.storeId);
    expect(due).toMatchObject({ overdue: 9_319, total: 9_319 });
    expect(s.purchases.listSuppliers()[0]).toMatchObject({ name: 'SABC', balance: 9_319 });

    s.purchases.paySupplier(ctx, { invoiceId: invoice.id, method: 'BANK_TRANSFER', amount: 9_319, reference: 'VIR 55' });
    expect(s.purchases.getInvoice(invoice.id).state).toBe('paid');
    expect(s.purchases.dueSchedule(ctx.storeId).total).toBe(0);
  });

  it('propose les commandes et les crée par fournisseur', () => {
    const sabc = s.purchases.saveSupplier(ctx.userId, { name: 'SABC', leadTimeDays: 3 });
    const nestle = s.purchases.saveSupplier(ctx.userId, { name: 'Nestlé', leadTimeDays: 5 });
    const biere = article('33 Export 65 cl');
    const lait = article('Lait Nido 400 g', { alertQty: 6_000, maxQty: 24_000 });
    const sel = article('Sel 1 kg');
    s.purchases.setSupplierArticle(ctx.userId, { supplierId: sabc.id, articleId: biere.id, unitCost: 450, packQty: 12_000 });
    s.purchases.setSupplierArticle(ctx.userId, { supplierId: nestle.id, articleId: lait.id, unitCost: 2_100, packQty: 6_000 });
    s.stock.receive(ctx, { warehouseId: shop, lines: [{ articleId: biere.id, qty: 100_000, unitCost: 450 }, { articleId: lait.id, qty: 5_000, unitCost: 2_100 }, { articleId: sel.id, qty: 50_000, unitCost: 150 }] });
    // 28 jours à 3 bières par jour = 84 ventes.
    s.pos.openSession(ctx, 0);
    for (let i = 0; i < 28; i++) {
      s.pos.completeSale(ctx, { lines: [{ articleId: biere.id, qty: 3_000 }], payments: [{ method: 'CASH', amount: 3_000 }] });
      advanceDays(1);
    }
    const proposal = s.purchases.reorderProposal(ctx.storeId);
    // Bière : stock 16, point 3 × 3 = 9 : rien. Lait : 5 < alerte 6, on remonte à 24 par cartons de 6.
    expect(proposal.map((p) => [p.article_name, p.supplier_name, p.qty])).toEqual([['Lait Nido 400 g', 'Nestlé', 24_000]]);

    s.pos.completeSale(ctx, { lines: [{ articleId: biere.id, qty: 10_000 }], payments: [{ method: 'CASH', amount: 10_000 }] });
    const again = s.purchases.reorderProposal(ctx.storeId);
    // Bière : 94 vendues en 28 jours, soit 3,357 par jour ; 6 en stock, sous le point de commande (3 jours de délai).
    // Cible 10 jours de vente = 33,57 ; il manque 27,57, arrondi à 3 colis de 12.
    expect(again.find((p) => p.article_id === biere.id)).toMatchObject({ supplier_name: 'SABC', stock: 6_000, avg_daily_sales: 3_357, qty: 36_000 });

    const orders = s.purchases.createOrdersFromProposal(ctx, {
      warehouseId: shop,
      lines: again.map((p) => ({ supplierId: p.supplier_id!, articleId: p.article_id, qty: p.qty, unitCost: p.unit_cost })),
    });
    expect(orders.map((o) => o.supplier_name).sort()).toEqual(['Nestlé', 'SABC']);
    expect(orders.every((o) => o.state === 'draft' && o.lines.length === 1)).toBe(true);
    // Ce qui est commandé n'est plus proposé.
    expect(s.purchases.reorderProposal(ctx.storeId)).toHaveLength(0);
  });
});
