import { receiptToText } from '@superette/core';
import { describe, expect, it } from 'vitest';
import { type Context, type Entry, type Services, createServices, openDatabase } from '../src';

/**
 * Une journée complète de superette, du matin au soir, puis l'ouverture du
 * lendemain : commande et réception fournisseur, caisse ouverte avec son fond,
 * ventes au comptant, MoMo et à crédit, retour, règlement client, dépense au
 * tiroir, clôture Z avec versement à la centrale, facture et règlement du
 * fournisseur. À la fin, stock, comptes de tiers, caisse et comptabilité
 * doivent tous raconter la même histoire.
 *
 * Ce test protège la caisse : s'il casse, une nouvelle version a changé un
 * chiffre que le gérant voit tous les soirs.
 */

let now = new Date('2026-10-12T07:00:00Z');
const at = (iso: string) => {
  now = new Date(iso);
};

const balanced = (entries: Entry[]) => entries.every((e) => e.lines.reduce((t, l) => t + l.debit, 0) === e.lines.reduce((t, l) => t + l.credit, 0));

function openShop() {
  const s = createServices(openDatabase(':memory:'), () => now);
  const { store, register, admin } = s.admin.bootstrap({ storeCode: 'DLA1', storeName: 'Superette Akwa', adminName: 'Steve', adminLogin: 'steve', adminPin: '1234' });
  const ctx: Context = { storeId: store.id, registerId: register.id, userId: admin.id };
  const shop = s.admin.salesWarehouse(store.id).id;
  const tva = s.admin.listVatRates().find((r) => r.rate_bp === 1925)!.id;
  return { s, ctx, shop, tva };
}

const stockOf = (s: Services, storeId: string, articleId: string) => s.stock.list(storeId).find((r) => r.article_id === articleId)!;

describe("journée complète d'une superette", () => {
  it('du bon de commande au Z, puis le lendemain : stock, tiers, caisse et comptabilité concordent', () => {
    at('2026-10-12T07:00:00Z');
    const { s, ctx, shop, tva } = openShop();

    // --- Fiches -------------------------------------------------------------
    const riz = s.catalogue.saveArticle(ctx.userId, { name: 'RIZ PARFUME 5 KG', unit: 'piece', vatRateId: tva, purchasePrice: 3_000, salePrice: 5_000, barcodes: [{ code: '6181100000016' }] });
    const huile = s.catalogue.saveArticle(ctx.userId, { name: 'HUILE DIAMAOR 1L', unit: 'piece', vatRateId: tva, purchasePrice: 1_000, salePrice: 1_500 });
    const sabc = s.purchases.saveSupplier(ctx.userId, { name: 'SODICAM', paymentTermsDays: 30, leadTimeDays: 1 });
    const mballa = s.customers.saveCustomer(ctx.userId, { name: 'Chez Mballa', phone: '677 00 00 01', creditLimit: 50_000, paymentTermsDays: 15 });

    // --- 7 h : la commande arrive ----------------------------------------------
    const order = s.purchases.createOrder(ctx, {
      supplierId: sabc.id,
      warehouseId: shop,
      lines: [
        { articleId: riz.id, qty: 20_000, unitCost: 3_000 },
        { articleId: huile.id, qty: 50_000, unitCost: 1_000 },
      ],
    });
    s.purchases.setOrderStatus(ctx, order.id, 'sent');
    const reception = s.purchases.receiveOrder(ctx, order.id, {
      deliveryNote: 'BL-778',
      lines: order.lines.map((l) => ({ orderLineId: l.id, articleId: l.article_id, qty: l.qty, unitCost: l.unit_cost })),
    });
    expect(s.purchases.getOrder(order.id).state).toBe('received');
    expect(stockOf(s, ctx.storeId, riz.id)).toMatchObject({ qty: 20_000, avg_cost: 3_000 });
    expect(stockOf(s, ctx.storeId, huile.id)).toMatchObject({ qty: 50_000, avg_cost: 1_000 });

    // --- 8 h : ouverture de la caisse avec 10 000 de fond ---------------------
    at('2026-10-12T08:00:00Z');
    expect(() => s.pos.completeSale(ctx, { lines: [{ articleId: riz.id, qty: 1000 }], payments: [{ method: 'CASH', amount: 5_000 }] })).toThrow();
    const session = s.pos.openSession(ctx, 10_000);

    // Ventes : comptant avec monnaie rendue, MoMo, crédit.
    const scanned = s.catalogue.scan('6181100000016', ctx.storeId);
    expect(scanned?.article.id).toBe(riz.id);
    const cash = s.pos.completeSale(ctx, {
      lines: [
        { articleId: riz.id, qty: 2000 },
        { articleId: huile.id, qty: 4000 },
      ],
      payments: [{ method: 'CASH', amount: 20_000 }],
    });
    expect(cash.total_ttc).toBe(16_000);
    expect(receiptToText(s.receipts.ticket(cash.id), 48)).toMatch(/RIZ PARFUME 5 KG/);
    at('2026-10-12T10:30:00Z');
    s.pos.completeSale(ctx, { lines: [{ articleId: riz.id, qty: 1000 }], payments: [{ method: 'MTN_MOMO', amount: 5_000, reference: 'MP261012.1030' }] });
    at('2026-10-12T11:00:00Z');
    const credit = s.pos.completeSale(ctx, {
      lines: [
        { articleId: riz.id, qty: 4000 },
        { articleId: huile.id, qty: 10_000 },
      ],
      payments: [{ method: 'CUSTOMER_CREDIT', amount: 35_000 }],
      customerId: mballa.id,
    });
    expect(credit.total_ttc).toBe(35_000);
    // Au-delà du plafond (50 000), il faut le gérant.
    expect(() =>
      s.pos.completeSale({ ...ctx, userId: ctx.userId }, { lines: [{ articleId: riz.id, qty: 4000 }], payments: [{ method: 'CUSTOMER_CREDIT', amount: 20_000 }], customerId: mballa.id }),
    ).toThrow(/Plafond de crédit dépassé/);

    // Retour d'un bidon d'huile au compte du client, puis règlement en espèces à la caisse.
    at('2026-10-12T15:00:00Z');
    const huileLine = credit.lines.find((l) => l.article_id === huile.id)!;
    s.pos.returnSale(ctx, { originalSaleId: credit.id, lines: [{ lineId: huileLine.id, qty: 1000 }], refundMethod: 'CUSTOMER_CREDIT', supervisorId: ctx.userId, reason: 'Bidon percé' });
    s.customers.receivePayment(ctx, { customerId: mballa.id, method: 'CASH', amount: 20_000, sessionId: session.id });
    expect(s.customers.account(ctx.storeId, mballa.id)).toMatchObject({ balance: 13_500, available: 36_500 });

    // Dépense payée avec les espèces du tiroir (sacs plastiques).
    const sacs = s.expenses.listCategories()[0]!;
    s.expenses.record(ctx, { categoryId: sacs.id, label: 'Sacs plastiques', amount: 2_000, method: 'CASH', atRegister: true });
    // Prélèvement vers le coffre en cours de journée.
    s.pos.cashOperation(ctx, 'OUT', 10_000, 'Coffre');

    // --- 20 h : clôture Z, on laisse 10 000 de fond -----------------------------
    at('2026-10-12T20:00:00Z');
    const before = s.pos.zReport(session.id);
    // Fond 10 000 + ventes 16 000 + règlement 20 000 − dépense 2 000 − coffre 10 000.
    expect(before.cash).toMatchObject({ openingFloat: 10_000, cashSales: 16_000, customerReceipts: 20_000, expenses: 2_000, cashOut: 10_000, expected: 34_000 });
    expect(s.pos.countPreview(ctx, { 10000: 3, 2000: 2 })).toMatchObject({ expected: 34_000, counted: 34_000, difference: 0, needsApproval: false });
    const z = s.pos.closeSession(ctx, { 10000: 3, 2000: 2 }, { floatLeft: 10_000 });
    expect(z.session).toMatchObject({ status: 'closed', z_number: 1, difference: 0, deposit: 24_000, float_left: 10_000 });
    expect(z.ticketCount).toBe(3);
    // Ventes 56 000 TTC, retour 1 500.
    expect(z.salesTtc).toBe(56_000);
    expect(z.returnsTtc).toBe(-1_500);
    expect(z.netTtc).toBe(54_500);
    expect(Object.fromEntries(z.byMethod.map((m) => [m.method, m.amount]))).toMatchObject({ CASH: 16_000, MTN_MOMO: 5_000, CUSTOMER_CREDIT: 33_500 });
    expect(z.vat.reduce((t, v) => t + v.ttc, 0)).toBe(54_500);
    // La centrale reçoit le prélèvement du coffre et le versement du soir.
    expect(s.treasury.balance(ctx.storeId)).toBe(34_000);
    expect(() => s.pos.completeSale(ctx, { lines: [{ articleId: riz.id, qty: 1000 }], payments: [{ method: 'CASH', amount: 5_000 }] })).toThrow();

    // --- Facture du fournisseur et acompte payé au bureau depuis la centrale ---------
    at('2026-10-12T20:30:00Z');
    const invoice = s.purchases.createInvoice(ctx, {
      supplierId: sabc.id,
      supplierNumber: 'FA-2026-551',
      invoiceDate: '2026-10-12',
      totalHt: 110_000,
      totalTva: 21_175,
      receptionIds: [reception.id],
    });
    expect(invoice).toMatchObject({ total_ttc: 131_175, due_date: '2026-11-11', balance: 131_175 });
    s.purchases.paySupplier(ctx, { invoiceId: invoice.id, method: 'CASH', amount: 20_000 });
    expect(s.purchases.getInvoice(invoice.id).balance).toBe(111_175);
    expect(s.purchases.listSuppliers().find((x) => x.id === sabc.id)!.balance).toBe(111_175);
    expect(s.treasury.balance(ctx.storeId)).toBe(14_000);

    // --- Le soir : tout concorde ----------------------------------------------------
    // Stock : 20 − 2 − 1 − 4 = 13 riz ; 50 − 4 − 10 + 1 = 37 huiles, au même CMUP.
    expect(stockOf(s, ctx.storeId, riz.id)).toMatchObject({ qty: 13_000, avg_cost: 3_000 });
    expect(stockOf(s, ctx.storeId, huile.id)).toMatchObject({ qty: 37_000, avg_cost: 1_000 });

    const entries = s.accounting.entries(ctx.storeId);
    expect(balanced(entries)).toBe(true);
    const tb = s.accounting.trialBalance(ctx.storeId);
    expect(tb.totals.debit).toBe(tb.totals.credit);
    const row = (acc: string) => tb.rows.find((r) => r.account === acc)?.closing ?? 0;
    // Chiffre d'affaires TTC = ventes nettes du Z.
    expect(-(row('701') + row('4431'))).toBe(54_500);
    // Clients : le compte 411 du tiers égale le compte client de la caisse.
    expect(s.accounting.ledger(ctx.storeId, { account: '411', aux: mballa.code }).closing).toBe(13_500);
    // Fournisseurs : 401 égale le reste à payer.
    expect(s.accounting.ledger(ctx.storeId, { account: '401' }).closing).toBe(-111_175);
    // Trésorerie : MoMo 5 000 ; la caisse centrale du livre égale celle de la comptabilité ;
    // le tiroir garde le fond de départ, entré dans la caisse avant toute écriture (solde 571 inchangé).
    const treasury = Object.fromEntries(s.accounting.treasury(ctx.storeId).map((t) => [t.account, t.balance]));
    expect(treasury).toMatchObject({ '571': 0, '5712': 14_000, '5521': 5_000, '585': 0 });
    expect(treasury['5712']).toBe(s.treasury.balance(ctx.storeId));
    // Charges : la dépense passe sur le compte de sa catégorie.
    expect(row(sacs.account_id)).toBe(2_000);

    // Le résumé du jour reprend les mêmes chiffres.
    const digest = s.digest.build(ctx.storeId, '2026-10-12');
    expect(digest).toMatchObject({ tickets: 3, revenue: 54_500, customerPayments: 20_000, expenses: 2_000 });
    expect(digest.sessions).toMatchObject({ closed: 1, open: 0, gaps: [] });

    // Tout part vers le serveur central à la prochaine connexion.
    const outbox = s.db.prepare('SELECT entity, COUNT(*) AS n FROM outbox GROUP BY entity').all() as { entity: string; n: number }[];
    const sent = new Set(outbox.map((o) => o.entity));
    for (const e of ['sale', 'cash_session', 'customer_payment', 'purchase_order', 'supplier_invoice', 'supplier_payment', 'expense']) expect(sent).toContain(e);

    // --- Le lendemain : le fond de la veille est proposé ---------------------------
    at('2026-10-13T07:30:00Z');
    expect(s.pos.carriedFloat(ctx.registerId!)).toBe(10_000);
    const day2 = s.pos.openSession(ctx, 10_000);
    expect(day2.opening_float).toBe(10_000);
    s.pos.completeSale(ctx, { lines: [{ articleId: riz.id, qty: 1000 }], payments: [{ method: 'CASH', amount: 5_000 }] });
    expect(stockOf(s, ctx.storeId, riz.id).qty).toBe(12_000);
    const z2 = s.pos.closeSession(ctx, { 10000: 1, 5000: 1 }, { floatLeft: 10_000 });
    expect(z2.session).toMatchObject({ z_number: 2, difference: 0, deposit: 5_000 });
    expect(balanced(s.accounting.entries(ctx.storeId))).toBe(true);
  });

  it('un écart de caisse au-delà du seuil reste à justifier et passe en manquant', () => {
    at('2026-10-12T08:00:00Z');
    const { s, ctx, shop, tva } = openShop();
    const savon = s.catalogue.saveArticle(ctx.userId, { name: 'SAVON AZUR', unit: 'piece', vatRateId: tva, purchasePrice: 200, salePrice: 350 });
    s.stock.receive(ctx, { warehouseId: shop, lines: [{ articleId: savon.id, qty: 100_000, unitCost: 200 }] });
    const session = s.pos.openSession(ctx, 5_000);
    s.pos.completeSale(ctx, { lines: [{ articleId: savon.id, qty: 20_000 }], payments: [{ method: 'CASH', amount: 7_000 }] });
    // 12 000 attendus, 11 000 comptés : 1 000 de manquant, au-delà du seuil de 500.
    expect(s.pos.countPreview(ctx, { 10000: 1, 1000: 1 })).toMatchObject({ expected: 12_000, difference: -1_000, needsApproval: true });
    s.pos.closeSession(ctx, { 10000: 1, 1000: 1 });
    expect(s.pos.pendingGaps(ctx.storeId).map((g) => g.id)).toEqual([session.id]);
    s.pos.justifyGap(ctx, session.id, 'Erreur de rendu de monnaie');
    expect(s.pos.pendingGaps(ctx.storeId)).toHaveLength(0);
    const tb = s.accounting.trialBalance(ctx.storeId);
    expect(tb.rows.find((r) => r.account === '658')?.closing).toBe(1_000);
    expect(balanced(s.accounting.entries(ctx.storeId))).toBe(true);
  });
});
