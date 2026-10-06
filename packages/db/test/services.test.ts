import { eanCheckDigit } from '@superette/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { type Context, type Services, createServices, openDatabase } from '../src';

let now = new Date('2026-10-06T08:00:00Z');
const clock = () => now;
const advance = (minutes: number) => {
  now = new Date(now.getTime() + minutes * 60_000);
};

let s: Services;
let ctx: Context;
let managerId: string;
let cashierCtx: Context;
let tva: string;
let exo: string;

function setup() {
  now = new Date('2026-10-06T08:00:00Z');
  s = createServices(openDatabase(':memory:'), clock);
  const { store, register, admin } = s.admin.bootstrap({
    storeCode: 'DLA1',
    storeName: 'Superette Akwa',
    adminName: 'Steve',
    adminLogin: 'Steve',
    adminPin: '1234',
  });
  ctx = { storeId: store.id, registerId: register.id, userId: admin.id };
  managerId = admin.id;
  const cashier = s.admin.createUser(admin.id, { name: 'Awa', login: 'awa', pin: '5678', role: 'cashier', storeId: store.id });
  cashierCtx = { ...ctx, userId: cashier.id };
  const rates = s.admin.listVatRates();
  tva = rates.find((r) => r.rate_bp === 1925)!.id;
  exo = rates.find((r) => r.rate_bp === 0)!.id;
}

function article(name: string, salePrice: number, opts: Partial<Parameters<Services['catalogue']['saveArticle']>[1]> = {}) {
  return s.catalogue.saveArticle(ctx.userId, { name, unit: 'piece', vatRateId: tva, purchasePrice: 0, salePrice, ...opts });
}

describe('administration', () => {
  beforeEach(setup);

  it('initialise magasin, caisse 1, dépôts et poste', () => {
    expect(s.admin.isInitialized()).toBe(true);
    expect(s.admin.listWarehouses(ctx.storeId).map((w) => w.kind)).toEqual(['shop', 'reserve']);
    expect(s.admin.station()?.register?.number).toBe(1);
    expect(s.admin.login('STEVE', '1234').role).toBe('admin');
    expect(() => s.admin.login('steve', '0000')).toThrow('Identifiant ou code incorrect');
  });

  it('ajoute un magasin et des caisses sans développement', () => {
    const yde = s.admin.createStore(ctx.userId, { storeCode: 'yde1', storeName: 'Superette Bastos' });
    const reg2 = s.admin.createRegister(ctx.userId, yde.id);
    expect(yde.code).toBe('YDE1');
    expect(reg2.number).toBe(2);
    expect(reg2.activation_code).toMatch(/^\d{6}$/);
    expect(s.admin.activateRegister(reg2.activation_code).id).toBe(reg2.id);
    expect(s.admin.station()?.store.id).toBe(yde.id);
  });

  it('valide un code superviseur uniquement pour un gérant', () => {
    expect(s.admin.authorizeSupervisor('1234').id).toBe(managerId);
    expect(() => s.admin.authorizeSupervisor('5678')).toThrow('Code superviseur refusé');
  });
});

describe('catalogue', () => {
  beforeEach(setup);

  it('retrouve un article par code-barres, conditionnement et code interne', () => {
    const coca = article('Coca-Cola 33 cl', 400, {
      barcodes: [{ code: '5449000000996' }, { code: '5449000131805', packQty: 24000 }],
    });
    expect(s.catalogue.scan('5449000000996', ctx.storeId)).toMatchObject({ qty: 1000, article: { id: coca.id } });
    expect(s.catalogue.scan('5449000131805', ctx.storeId)?.qty).toBe(24000);
    expect(s.catalogue.scan(coca.code, ctx.storeId)?.article.id).toBe(coca.id);
    expect(s.catalogue.scan('0000000000000', ctx.storeId)).toBeNull();
  });

  it('refuse un code-barres en double ou à la clé fausse', () => {
    article('A', 100, { barcodes: [{ code: '5449000000996' }] });
    expect(() => article('B', 100, { barcodes: [{ code: '5449000000996' }] })).toThrow('déjà attribué');
    expect(() => article('C', 100, { barcodes: [{ code: '5449000000997' }] })).toThrow('clé de contrôle');
  });

  it('lit une étiquette balance à prix intégré', () => {
    const tomate = article('Tomates', 800, { unit: 'kg', vatRateId: exo, plu: '123' });
    const body = '21001230' + '1000';
    const code = body + eanCheckDigit(body);
    expect(s.catalogue.scan(code, ctx.storeId)).toMatchObject({ article: { id: tomate.id }, qty: 1250, fixedAmount: 1000 });
  });

  it('applique un prix magasin et garde l’historique', () => {
    const riz = article('Riz 5 kg', 4500);
    s.catalogue.saveArticle(ctx.userId, { name: 'Riz 5 kg', unit: 'piece', vatRateId: tva, purchasePrice: 0, salePrice: 4700 }, riz.id);
    s.catalogue.setStorePrice(ctx.userId, riz.id, ctx.storeId, 4600);
    expect(s.catalogue.getArticle(riz.id, ctx.storeId).store_price).toBe(4600);
    expect(s.catalogue.getArticle(riz.id, null).store_price).toBe(4700);
    expect(s.catalogue.priceHistory(riz.id).map((h) => [h.store_id === null ? 'national' : 'magasin', h.new_price]).sort()).toEqual([
      ['magasin', 4600],
      ['national', 4500],
      ['national', 4700],
    ]);
  });

  it('importe un catalogue et met à jour les codes existants', () => {
    const res = s.catalogue.importArticles(ctx.userId, [
      { name: 'Huile 1 L', barcode: '5449000000996', salePrice: 1500, department: 'Épicerie' },
      { name: 'Sucre 1 kg', salePrice: 900, vatRateBp: 0, department: 'Épicerie', family: 'Sucres' },
      { name: 'Erreur', salePrice: 100, vatRateBp: 550 },
    ]);
    expect(res).toMatchObject({ created: 2, updated: 0 });
    expect(res.errors).toHaveLength(1);
    const again = s.catalogue.importArticles(ctx.userId, [{ name: 'Huile 1 L', barcode: '5449000000996', salePrice: 1600 }]);
    expect(again.updated).toBe(1);
    expect(s.catalogue.scan('5449000000996', ctx.storeId)?.article.sale_price).toBe(1600);
    expect(s.catalogue.listDepartments()[0]?.families.map((f) => f.name).sort()).toEqual(['Sucres', 'Épicerie']);
  });
});

describe('stock', () => {
  beforeEach(setup);

  it('réceptionne en CMUP, exige la DLC des périssables, sort en FEFO', () => {
    const yaourt = article('Yaourt', 350, { perishable: true });
    const shop = s.admin.salesWarehouse(ctx.storeId).id;
    expect(() => s.stock.receive(ctx, { warehouseId: shop, lines: [{ articleId: yaourt.id, qty: 10000, unitCost: 200 }] })).toThrow('Date limite');
    s.stock.receive(ctx, { warehouseId: shop, lines: [{ articleId: yaourt.id, qty: 10000, unitCost: 200, expiry: '2026-10-20' }] });
    s.stock.receive(ctx, { warehouseId: shop, lines: [{ articleId: yaourt.id, qty: 10000, unitCost: 260, expiry: '2026-10-09' }] });
    const row = s.stock.list(ctx.storeId).find((r) => r.article_id === yaourt.id)!;
    expect(row).toMatchObject({ qty: 20000, avg_cost: 230, value: 4600, next_expiry: '2026-10-09' });
    s.stock.recordLoss(ctx, { warehouseId: shop, articleId: yaourt.id, qty: 3000, type: 'BREAKAGE', reason: 'Pots écrasés' });
    const lots = s.stock.lotsOf(yaourt.id, ctx.storeId);
    expect(lots.map((l) => [l.expiry, l.qty])).toEqual([
      ['2026-10-09', 7000],
      ['2026-10-20', 10000],
    ]);
    expect(s.stock.expiringLots(ctx.storeId, 7)).toMatchObject([{ expiry: '2026-10-09', alert: 'J-3', days: 3 }]);
  });

  it('transfère de la réserve au rayon en gardant les dates', () => {
    const lait = article('Lait', 700, { perishable: true });
    const [shop, reserve] = s.admin.listWarehouses(ctx.storeId);
    s.stock.receive(ctx, { warehouseId: reserve!.id, lines: [{ articleId: lait.id, qty: 12000, unitCost: 500, expiry: '2026-11-01' }] });
    s.stock.transfer(ctx, { fromWarehouseId: reserve!.id, toWarehouseId: shop!.id, lines: [{ articleId: lait.id, qty: 5000 }] });
    expect(s.stock.list(ctx.storeId, { warehouseId: shop!.id }).find((r) => r.article_id === lait.id)).toMatchObject({
      qty: 5000,
      avg_cost: 500,
      next_expiry: '2026-11-01',
    });
    expect(s.stock.list(ctx.storeId).find((r) => r.article_id === lait.id)?.qty).toBe(12000);
  });

  it('inventaire tournant : les ventes pendant le comptage ne faussent pas l’écart', () => {
    const savon = article('Savon', 500);
    const shop = s.admin.salesWarehouse(ctx.storeId).id;
    s.stock.receive(ctx, { warehouseId: shop, lines: [{ articleId: savon.id, qty: 20000, unitCost: 300 }] });
    advance(10);
    const countedAt = clock().toISOString();
    advance(5);
    s.pos.openSession(ctx, 0);
    s.pos.completeSale(ctx, { lines: [{ articleId: savon.id, qty: 2000 }], payments: [{ method: 'CASH', amount: 1000 }] });
    advance(5);
    // Le magasinier avait compté 18 savons (2 manquants) avant les 2 ventes.
    const inv = s.stock.applyInventory(ctx, { warehouseId: shop, counts: [{ articleId: savon.id, counted: 18000, countedAt }] });
    expect(inv.lines[0]).toMatchObject({ expected: 20000, difference: -2000, value: -600 });
    expect(s.stock.list(ctx.storeId).find((r) => r.article_id === savon.id)?.qty).toBe(16000);
  });
});

describe('caisse', () => {
  beforeEach(setup);

  function stocked() {
    const shop = s.admin.salesWarehouse(ctx.storeId).id;
    const biere = article('Bière 65 cl', 650, { barcodes: [{ code: '5449000000996' }] });
    const riz = article('Riz 5 kg', 4500, { vatRateId: exo });
    s.stock.receive(ctx, {
      warehouseId: shop,
      lines: [
        { articleId: biere.id, qty: 48000, unitCost: 450 },
        { articleId: riz.id, qty: 10000, unitCost: 3800 },
      ],
    });
    return { biere, riz, shop };
  }

  it('encaisse un ticket mixte, décrémente le stock et numérote', () => {
    const { biere, riz } = stocked();
    expect(() => s.pos.completeSale(cashierCtx, { lines: [{ articleId: riz.id, qty: 1000 }], payments: [] })).toThrow("n'est pas ouverte");
    s.pos.openSession(cashierCtx, 20000);
    const sale = s.pos.completeSale(cashierCtx, {
      lines: [
        { articleId: biere.id, qty: 6000, barcode: '5449000000996' },
        { articleId: riz.id, qty: 1000 },
      ],
      payments: [
        { method: 'MTN_MOMO', amount: 3000, reference: 'MP261006.1234' },
        { method: 'CASH', amount: 10000 },
      ],
    });
    expect(sale).toMatchObject({ number: 'DLA1-1-000001', total_ttc: 8400, change_given: 4600, total_tva: 630 });
    expect(s.stock.list(ctx.storeId).find((r) => r.article_id === biere.id)?.qty).toBe(42000);
    expect(s.db.prepare('SELECT COUNT(*) FROM outbox WHERE entity = ?').pluck().get('sale')).toBe(1);
  });

  it('exige la référence mobile money et refuse un ticket non soldé', () => {
    const { riz } = stocked();
    s.pos.openSession(cashierCtx, 0);
    expect(() =>
      s.pos.completeSale(cashierCtx, { lines: [{ articleId: riz.id, qty: 1000 }], payments: [{ method: 'ORANGE_MONEY', amount: 4500 }] }),
    ).toThrow('Référence de transaction');
    expect(() =>
      s.pos.completeSale(cashierCtx, { lines: [{ articleId: riz.id, qty: 1000 }], payments: [{ method: 'CASH', amount: 4000 }] }),
    ).toThrow('entièrement réglé');
  });

  it('soumet les remises du caissier à un gérant', () => {
    const { riz } = stocked();
    s.pos.openSession(cashierCtx, 0);
    const input = { lines: [{ articleId: riz.id, qty: 1000, discount: 500 }], payments: [{ method: 'CASH' as const, amount: 4000 }] };
    expect(() => s.pos.completeSale(cashierCtx, input)).toThrow('validation du gérant');
    expect(s.pos.completeSale(cashierCtx, { ...input, discountAuthorizedBy: managerId }).total_ttc).toBe(4000);
  });

  it('annule sous code superviseur et remet en stock', () => {
    const { riz } = stocked();
    s.pos.openSession(cashierCtx, 0);
    const sale = s.pos.completeSale(cashierCtx, { lines: [{ articleId: riz.id, qty: 2000 }], payments: [{ method: 'CASH', amount: 9000 }] });
    expect(() => s.pos.cancelSale(cashierCtx, sale.id, cashierCtx.userId, 'erreur')).toThrow('réservée au gérant');
    s.pos.cancelSale(cashierCtx, sale.id, managerId, 'Client sans argent');
    expect(s.stock.list(ctx.storeId).find((r) => r.article_id === riz.id)?.qty).toBe(10000);
    const z = s.pos.zReport(s.pos.currentSession(ctx.registerId!)!.id);
    expect(z).toMatchObject({ ticketCount: 0, netTtc: 0, cancelled: { count: 1, amount: 9000 } });
  });

  it('gère un retour partiel et la clôture Z avec écart', () => {
    const { biere, riz } = stocked();
    s.pos.openSession(cashierCtx, 20000);
    const sale = s.pos.completeSale(cashierCtx, {
      lines: [
        { articleId: biere.id, qty: 6000 },
        { articleId: riz.id, qty: 1000 },
      ],
      payments: [
        { method: 'ORANGE_MONEY', amount: 4500, reference: 'OM-889' },
        { method: 'CASH', amount: 5000 },
      ],
    });
    const biereLine = sale.lines.find((l) => l.article_id === biere.id)!;
    const ret = s.pos.returnSale(cashierCtx, {
      originalSaleId: sale.id,
      lines: [{ lineId: biereLine.id, qty: 2000 }],
      refundMethod: 'CASH',
      supervisorId: managerId,
      reason: 'Bouteilles cassées',
    });
    expect(ret).toMatchObject({ kind: 'return', total_ttc: -1300, number: 'DLA1-1-000002' });
    expect(() =>
      s.pos.returnSale(cashierCtx, { originalSaleId: sale.id, lines: [{ lineId: biereLine.id, qty: 5000 }], refundMethod: 'CASH', supervisorId: managerId, reason: 'x' }),
    ).toThrow('supérieure');
    s.pos.cashOperation(cashierCtx, 'OUT', 10000, 'Mise au coffre');
    s.pos.holdTicket(cashierCtx, 'Client 2', [{ articleId: riz.id, qty: 1000 }]);
    // Ticket 8 400 : 4 500 Orange Money + 5 000 espèces, 1 100 rendus, soit 3 900 en espèces.
    // Théorique : 20 000 + 3 900 - 1 300 remboursés - 10 000 au coffre = 12 600
    const z = s.pos.closeSession(cashierCtx, { 10000: 1, 2000: 1, 500: 1 });
    expect(z.cash).toMatchObject({ cashSales: 3900, cashRefunds: 1300, cashOut: 10000, expected: 12600 });
    expect(z).toMatchObject({ ticketCount: 1, salesTtc: 8400, returnsTtc: -1300, netTtc: 7100, counted: 12500, difference: -100 });
    expect(z.byMethod).toEqual([
      { method: 'ORANGE_MONEY', label: 'Orange Money', amount: 4500 },
      { method: 'CASH', label: 'Espèces', amount: 2600 },
    ]);
    expect(z.session.z_number).toBe(1);
    expect(s.pos.listHeld(ctx.registerId!)).toEqual([]);
    expect(s.stock.list(ctx.storeId).find((r) => r.article_id === biere.id)?.qty).toBe(48000 - 6000 + 2000);
  });

  it('calcule le résumé du jour et l’export des ventes', () => {
    const { biere, riz } = stocked();
    s.pos.openSession(cashierCtx, 0);
    s.pos.completeSale(cashierCtx, {
      lines: [
        { articleId: biere.id, qty: 2000 },
        { articleId: riz.id, qty: 1000 },
      ],
      payments: [{ method: 'CASH', amount: 5800 }],
    });
    const day = s.reports.daily(ctx.storeId, '2026-10-06');
    expect(day).toMatchObject({ ticketCount: 1, revenueTtc: 5800, averageBasket: 5800, costOfSales: 900 + 3800 });
    expect(day.grossMargin).toBe(day.revenueHt - 4700);
    const csv = s.reports.salesExportCsv(ctx.storeId, '2026-10-06', '2026-10-06');
    expect(csv.split('\r\n')).toHaveLength(3);
    expect(csv).toContain('DLA1-1-000001;Vente');
  });
});
