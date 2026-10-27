import { normalizeVoucherCode, parseNetContent, promoPostersHtml, unitPriceText, voucherCode } from '@superette/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { AppError, type Context, type Services, createServices, openDatabase } from '../src';

let now = new Date('2026-10-26T08:00:00Z');
let s: Services;
let ctx: Context;
let tva: string;
let shop: string;

beforeEach(() => {
  now = new Date('2026-10-26T08:00:00Z');
  s = createServices(openDatabase(':memory:'), () => now);
  const { store, register, admin } = s.admin.bootstrap({ storeCode: 'DLA1', storeName: 'Superette Akwa', adminName: 'Steve', adminLogin: 'steve', adminPin: '1234' });
  ctx = { storeId: store.id, registerId: register.id, userId: admin.id };
  tva = s.admin.listVatRates().find((r) => r.rate_bp === 1925)!.id;
  shop = s.admin.salesWarehouse(ctx.storeId).id;
});

const article = (name: string, price = 1000, stock = 0, lot?: { lotNumber?: string; expiry?: string }) => {
  const a = s.catalogue.saveArticle(ctx.userId, { name, unit: 'piece', vatRateId: tva, purchasePrice: Math.round(price * 0.7), salePrice: price });
  if (stock) s.stock.receive(ctx, { warehouseId: shop, lines: [{ articleId: a.id, qty: stock, unitCost: Math.round(price * 0.7), ...lot }] });
  return a;
};

const errorOf = (fn: () => unknown): AppError | null => {
  try {
    fn();
  } catch (e) {
    return e as AppError;
  }
  return null;
};

const balanced = () => {
  for (const e of s.accounting.entries(ctx.storeId)) expect(e.lines.reduce((t, l) => t + l.debit - l.credit, 0), `${e.ref} ${e.label}`).toBe(0);
};

describe('0.87.0 : bons d’achat', () => {
  it('fabrique des codes avec clé de contrôle et refuse une faute de frappe', () => {
    const code = voucherCode();
    expect(code).toMatch(/^BA\d{10}$/);
    expect(normalizeVoucherCode(code.toLowerCase())).toBe(code);
    const wrong = `${code.slice(0, -1)}${(Number(code.at(-1)) + 1) % 10}`;
    expect(normalizeVoucherCode(wrong)).toBeNull();
  });

  it('vend un bon, le dépense en deux fois, refuse de payer au-delà du solde et compte le bon en 4191', () => {
    const riz = article('Riz 5 kg', 5000, 10_000);
    const session = s.pos.openSession(ctx, 0);
    const bon = s.cashdesk.sellVoucher(ctx, session.id, { amount: 8000, method: 'CASH', holder: 'Pour Marie' });
    expect(bon).toMatchObject({ kind: 'sold', amount: 8000, balance: 8000, state: 'valid' });
    s.pos.completeSale(ctx, { lines: [{ articleId: riz.id, qty: 1000 }], payments: [{ method: 'VOUCHER', amount: 5000, reference: bon.code.toLowerCase() }] });
    expect(s.vouchers.get(bon.id).balance).toBe(3000);
    const err = errorOf(() => s.pos.completeSale(ctx, { lines: [{ articleId: riz.id, qty: 1000 }], payments: [{ method: 'VOUCHER', amount: 5000, reference: bon.code }] }));
    expect(err?.message).toMatch(/3\s000/);
    s.pos.completeSale(ctx, { lines: [{ articleId: riz.id, qty: 1000 }], payments: [{ method: 'VOUCHER', amount: 3000, reference: bon.code }, { method: 'CASH', amount: 2000 }] });
    expect(s.vouchers.get(bon.id)).toMatchObject({ balance: 0, state: 'spent' });
    // Un bon déjà utilisé ne s'annule plus.
    expect(errorOf(() => s.cashdesk.cancelVoucher(ctx, bon.id, ctx.userId, 'erreur'))).not.toBeNull();
    // L'argent du bon est dans le tiroir : il compte dans les espèces attendues.
    const z = s.pos.zReport(session.id);
    expect(z.cash.expected).toBe(8000 + 2000);
    balanced();
  });

  it('refuse un ancien bon papier déjà utilisé et rembourse un retour en bon d’avoir', () => {
    const riz = article('Riz 5 kg', 5000, 10_000);
    s.pos.openSession(ctx, 0);
    s.pos.completeSale(ctx, { lines: [{ articleId: riz.id, qty: 1000 }], payments: [{ method: 'VOUCHER', amount: 5000, reference: 'Papier 0042' }] });
    expect(errorOf(() => s.pos.completeSale(ctx, { lines: [{ articleId: riz.id, qty: 1000 }], payments: [{ method: 'VOUCHER', amount: 5000, reference: 'papier 0042' }] }))?.code).toBe('VOUCHER_USED');
    const sale = s.pos.completeSale(ctx, { lines: [{ articleId: riz.id, qty: 2000 }], payments: [{ method: 'CASH', amount: 10_000 }] });
    const ret = s.pos.returnSale(ctx, { originalSaleId: sale.id, lines: [{ lineId: s.pos.getSale(sale.id).lines[0]!.id, qty: 1000 }], refundMethod: 'VOUCHER', supervisorId: ctx.userId, reason: 'abîmé' });
    const code = s.pos.getSale(ret.id).payments[0]!.reference!;
    expect(s.vouchers.lookup(ctx.storeId, code)).toMatchObject({ voucher: { kind: 'refund', amount: 5000, balance: 5000 }, problem: null });
    balanced();
  });
});

describe('0.87.0 : tiroir, carnet et monnaie', () => {
  it('alerte quand le tiroir dépasse le plafond et propose le versement', () => {
    s.admin.saveStoreSettings(ctx.userId, ctx.storeId, { cashCeiling: 50_000 });
    const riz = article('Riz 5 kg', 5000, 50_000);
    s.pos.openSession(ctx, 0);
    s.pos.completeSale(ctx, { lines: [{ articleId: riz.id, qty: 12_000 }], payments: [{ method: 'CASH', amount: 60_000 }] });
    const st = s.pos.drawerStatus(ctx)!;
    expect(st).toMatchObject({ cash: 60_000, ceiling: 50_000, over: true });
    expect(st.suggested).toBeGreaterThanOrEqual(10_000);
    s.pos.drawerStatus(ctx);
    expect(s.pos.cashAlerts(ctx.storeId)).toHaveLength(1);
  });

  it('saisit une vente du carnet à souches, refuse la même souche deux fois et la montre dans le Z', () => {
    const riz = article('Riz 5 kg', 5000, 10_000);
    const session = s.pos.openSession(ctx, 0);
    const book = { number: '0012', at: '2026-10-26T07:30:00.000Z' };
    s.pos.completeSale(ctx, { lines: [{ articleId: riz.id, qty: 1000 }], payments: [{ method: 'CASH', amount: 5000 }], book });
    expect(errorOf(() => s.pos.completeSale(ctx, { lines: [{ articleId: riz.id, qty: 1000 }], payments: [{ method: 'CASH', amount: 5000 }], book }))?.code).toBe('DUPLICATE');
    expect(errorOf(() => s.pos.completeSale(ctx, { lines: [{ articleId: riz.id, qty: 1000 }], payments: [{ method: 'CASH', amount: 5000 }], book: { number: '13', at: '2026-10-27T07:30:00.000Z' } }))).not.toBeNull();
    expect(s.pos.zReport(session.id).bookSales).toEqual({ count: 1, total: 5000 });
    expect(s.pos.bookSales(ctx.storeId)[0]).toMatchObject({ book_number: '0012' });
  });

  it('laisse la monnaie sur le compte du client, ou en bon de monnaie pour un client de passage', () => {
    const riz = article('Riz 5 kg', 4500, 10_000);
    const client = s.customers.saveCustomer(ctx.userId, { name: 'Restaurant Chez Mama', phone: '677000000' });
    const session = s.pos.openSession(ctx, 0);
    s.pos.completeSale(ctx, { lines: [{ articleId: riz.id, qty: 1000 }], payments: [{ method: 'CASH', amount: 5000 }], customerId: client.id, keepChange: 500 });
    const st = s.customers.statement(ctx.storeId, client.id);
    expect(st.lines.some((l) => l.kind === 'change' && l.credit === 500)).toBe(true);
    expect(st.closing).toBe(-500);
    const sale = s.pos.completeSale(ctx, { lines: [{ articleId: riz.id, qty: 1000 }], payments: [{ method: 'CASH', amount: 5000 }], keepChange: 500 });
    const got = s.pos.getSale(sale.id);
    expect(got).toMatchObject({ change_kept: 500, change_given: 0 });
    expect(s.vouchers.lookup(ctx.storeId, got.change_voucher!).voucher).toMatchObject({ kind: 'change', amount: 500 });
    const z = s.pos.zReport(session.id);
    expect(z.keptChange).toBe(1000);
    expect(z.cash.expected).toBe(10_000);
    balanced();
  });
});

describe('0.87.0 : contrôle à la sortie', () => {
  it('montre les articles payés, puis signale un ticket déjà contrôlé ou annulé', () => {
    const riz = article('Riz 5 kg', 5000, 10_000);
    s.pos.openSession(ctx, 0);
    const sale = s.pos.completeSale(ctx, { lines: [{ articleId: riz.id, qty: 2000 }], payments: [{ method: 'CASH', amount: 10_000 }] });
    const first = s.exitChecks.lookup(ctx.storeId, String(sale.number));
    expect(first).toMatchObject({ verdict: 'ok', lines: [{ qty: 2000 }] });
    s.exitChecks.record(ctx, sale.id, { status: 'ok', source: 'phone' });
    const again = s.exitChecks.lookup(ctx.storeId, String(sale.number));
    expect(again.verdict).toBe('warn');
    expect(again.warnings.join(' ')).toMatch(/DÉJÀ CONTRÔLÉ/);
    expect(errorOf(() => s.exitChecks.record(ctx, sale.id, { status: 'problem' }))).not.toBeNull();
    expect(s.exitChecks.record(ctx, sale.id, { status: 'problem', note: 'Un sac en plus' })).toMatchObject({ repeat: 1 });
    expect(s.exitChecks.coverage(ctx.storeId, '2026-10-26')).toMatchObject({ tickets: 1, checked: 1, problems: 1 });
  });
});

describe('0.87.0 : rappel de lot', () => {
  it('bloque le lot rappelé à la caisse, retrouve les clients qui l’ont acheté et prépare le retour', () => {
    const lait = article('Lait Nido 900 g', 4500, 5000, { lotNumber: 'L-A', expiry: '2027-03-01' });
    s.stock.receive(ctx, { warehouseId: shop, lines: [{ articleId: lait.id, qty: 2000, unitCost: 3150, lotNumber: 'L-B', expiry: '2027-06-01' }] });
    const client = s.customers.saveCustomer(ctx.userId, { name: 'Awa', phone: '699112233' });
    s.pos.openSession(ctx, 0);
    s.pos.completeSale(ctx, { lines: [{ articleId: lait.id, qty: 1000 }], payments: [{ method: 'CASH', amount: 4500 }], customerId: client.id });
    const supplier = s.purchases.saveSupplier(ctx.userId, { name: 'Nestlé Cameroun' });
    const recall = s.recalls.create(ctx, { articleId: lait.id, lotNumber: 'l-a', reason: 'Rappel du fabricant' });
    expect(recall.buyers).toMatchObject([{ name: 'Awa', phone: '699112233', qty: 1000 }]);
    expect(recall.lots.reduce((t, w) => t + w.qty, 0)).toBe(4000);
    // Seul le lot sain se vend.
    s.pos.completeSale(ctx, { lines: [{ articleId: lait.id, qty: 2000 }], payments: [{ method: 'CASH', amount: 9000 }] });
    expect(errorOf(() => s.pos.completeSale(ctx, { lines: [{ articleId: lait.id, qty: 1000 }], payments: [{ method: 'CASH', amount: 4500 }] }))?.code).toBe('RECALLED');
    s.recalls.returnToSupplier(ctx, recall.recall.id, { supplierId: supplier.id, warehouseId: shop });
    expect(s.recalls.detail(recall.recall.id).lots.reduce((t, w) => t + w.qty, 0)).toBe(0);
  });
});

describe('0.87.0 : prix programmés, prix au kilo et affiches', () => {
  it('lit le contenu net et calcule le prix au kilo ou au litre', () => {
    expect(parseNetContent('Lait Nido 900 g')).toEqual({ qty: 900, unit: 'kg' });
    expect(parseNetContent('Coca 6 x 1,5 L')).toEqual({ qty: 9000, unit: 'l' });
    expect(unitPriceText(1000, parseNetContent('Biscuit 200g'))).toMatch(/^5\s000 F le kg$/);
    expect(promoPostersHtml([{ name: 'Riz', offer: 'PROMO', price: 4500, oldPrice: 5000, unitPrice: null, dates: 'Jusqu’au 31/10', store: 'Akwa' }], 'a5')).toContain('Riz');
  });

  it('prépare les étiquettes la veille et applique les nouveaux prix à leur date, une seule fois', () => {
    const lait = article('Lait Nido 900 g', 4500, 1000);
    expect(errorOf(() => s.priceSchedules.create(ctx, { label: 'Hausse', effectiveOn: '2026-10-26', prices: [{ articleId: lait.id, salePrice: 4800 }] }))).not.toBeNull();
    const plan = s.priceSchedules.create(ctx, { label: 'Hausse Nestlé', effectiveOn: '2026-10-27', prices: [{ articleId: lait.id, salePrice: 4800 }] });
    expect(plan).toMatchObject({ status: 'pending', articles: 1 });
    const labels = s.priceSchedules.labelsFor(ctx.storeId);
    expect(labels[0]).toMatchObject({ price: 4800, date: '27/10/2026' });
    expect(labels[0]!.detail).toMatch(/le kg/);
    expect(s.priceSchedules.applyDue(ctx).schedules).toBe(0);
    now = new Date('2026-10-27T06:00:00Z');
    expect(s.priceSchedules.applyDue(ctx)).toEqual({ schedules: 1, articles: 1 });
    expect(s.catalogue.getArticle(lait.id, ctx.storeId).store_price).toBe(4800);
    expect(s.priceSchedules.applyDue(ctx).schedules).toBe(0);
    expect(s.priceSchedules.get(plan.id).status).toBe('applied');
  });
});

describe('0.87.0 : clients à prévenir', () => {
  it('liste le client quand le produit qu’il voulait arrive, puis le marque prévenu', () => {
    const lait = article('Lait Nido 900 g', 4500);
    s.missedSales.record(ctx, { articleId: lait.id, customerName: 'Awa', phone: '699 11 22 33' });
    expect(errorOf(() => s.missedSales.record(ctx, { articleId: lait.id, phone: '12' }))).not.toBeNull();
    expect(s.missedSales.toNotify(ctx.storeId)).toHaveLength(0);
    s.stock.receive(ctx, { warehouseId: shop, lines: [{ articleId: lait.id, qty: 6000, unitCost: 3000 }] });
    const list = s.missedSales.toNotify(ctx.storeId);
    expect(list).toMatchObject([{ customer_name: 'Awa', phone: '699112233', price: 4500 }]);
    s.missedSales.markNotified(ctx, list[0]!.id);
    expect(s.missedSales.toNotify(ctx.storeId)).toHaveLength(0);
  });
});

describe('0.87.0 : commandes répétées', () => {
  it('crée la commande de la semaine avant la livraison, stock réservé, et ne la recrée pas', () => {
    const riz = article('Riz 5 kg', 5000, 20_000);
    // Le 26/10/2026 est un lundi : livraison le mardi, préparée la veille.
    const rule = s.recurringOrders.save(ctx, { customerName: 'École Les Lauriers', phone: '677889900', weekdays: [2], leadDays: 1, lines: [{ articleId: riz.id, qty: 5000 }] });
    expect(rule.next_date).toBe('2026-10-27');
    const created = s.recurringOrders.generate(ctx);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ status: 'prepared', planned_date: '2026-10-27', total_ttc: 25_000 });
    expect(s.orders.reserved(ctx.storeId).get(riz.id)).toBe(5000);
    expect(s.recurringOrders.generate(ctx)).toHaveLength(0);
    s.orders.cancel(ctx, created[0]!.id, 'fermé');
    expect(s.recurringOrders.generate(ctx)).toHaveLength(0);
    now = new Date('2026-11-02T08:00:00Z');
    expect(s.recurringOrders.generate(ctx).map((o) => o.planned_date)).toEqual(['2026-11-03']);
  });
});

describe('0.87.0 : marchandise d’un autre magasin', () => {
  it('propose de demander à l’autre magasin, qui expédie ; le premier réceptionne au même coût', () => {
    const riz = s.catalogue.saveArticle(ctx.userId, { name: 'Riz 5 kg', unit: 'piece', vatRateId: tva, purchasePrice: 3500, salePrice: 5000, alertQty: 5000 });
    s.stock.receive(ctx, { warehouseId: shop, lines: [{ articleId: riz.id, qty: 2000, unitCost: 3500 }] });
    const bonamoussadi = s.admin.createStore(ctx.userId, { storeCode: 'DLA2', storeName: 'Bonamoussadi' });
    const other = s.admin.salesWarehouse(bonamoussadi.id).id;
    const ctx2: Context = { storeId: bonamoussadi.id, registerId: null, userId: ctx.userId };
    s.stock.receive(ctx2, { warehouseId: other, lines: [{ articleId: riz.id, qty: 40_000, unitCost: 3400 }] });
    // Le stock de l'autre magasin arrive ici par la synchronisation.
    s.db.prepare('INSERT INTO stock_levels (warehouse_id, article_id, qty, updated_at) VALUES (?, ?, ?, ?)').run(other, riz.id, 40_000, now.toISOString());
    const [sugg] = s.storeTransfers.suggestions(ctx.storeId);
    expect(sugg).toMatchObject({ article_id: riz.id, from_store_id: bonamoussadi.id, qty: 8000 });
    const req = s.storeTransfers.request(ctx, { fromStoreId: bonamoussadi.id, articleId: riz.id, qty: sugg!.qty });
    expect(s.storeTransfers.suggestions(ctx.storeId)).toHaveLength(0);
    expect(errorOf(() => s.storeTransfers.ship(ctx, req.id))?.code).toBe('FORBIDDEN');
    expect(s.storeTransfers.pending(bonamoussadi.id)).toEqual({ toShip: 1, toReceive: 0 });
    const shipped = s.storeTransfers.ship(ctx2, req.id, { qty: 6000 });
    expect(shipped).toMatchObject({ status: 'shipped', shipped_qty: 6000, unit_cost: 3400, direction: 'out' });
    const got = s.storeTransfers.receive(ctx, req.id);
    expect(got).toMatchObject({ status: 'received', received_qty: 6000, direction: 'in' });
    const mine = s.db.prepare('SELECT SUM(s.qty) FROM stock s JOIN warehouses w ON w.id = s.warehouse_id WHERE w.store_id = ? AND s.article_id = ?').pluck().get(ctx.storeId, riz.id);
    expect(mine).toBe(8000);
  });
});
