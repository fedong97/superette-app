import { beforeEach, describe, expect, it } from 'vitest';
import { AppError, type Context, type Services, createServices, nextVisit, openDatabase } from '../src';

let clock = new Date('2026-10-06T08:00:00Z');
let s: Services;
let ctx: Context;
let tva: string;
let shop: string;

beforeEach(() => {
  clock = new Date('2026-10-06T08:00:00Z');
  s = createServices(openDatabase(':memory:'), () => clock);
  const { store, register, admin } = s.admin.bootstrap({ storeCode: 'DLA1', storeName: 'Superette Akwa', adminName: 'Steve', adminLogin: 'steve', adminPin: '1234' });
  ctx = { storeId: store.id, registerId: register.id, userId: admin.id };
  tva = s.admin.listVatRates().find((r) => r.rate_bp === 1925)!.id;
  shop = s.admin.salesWarehouse(ctx.storeId).id;
});

const article = (name: string, price = 650) => s.catalogue.saveArticle(ctx.userId, { name, unit: 'piece', vatRateId: tva, purchasePrice: 0, salePrice: price });

describe('0.81.0 : le client voulait…', () => {
  it('note les ventes manquées, les regroupe pour le gérant et les compte dans la proposition de commande', () => {
    const lait = article('Lait Nido 900 g', 4500);
    s.missedSales.record(ctx, { articleId: lait.id, qty: 2000, reason: 'rupture' });
    s.missedSales.record(ctx, { articleId: lait.id, qty: 1000, reason: 'rupture' });
    s.missedSales.record(ctx, { label: 'Couches taille 5', reason: 'absent' });
    const top = s.missedSales.top(ctx.storeId, 30);
    expect(top[0]).toMatchObject({ article_id: lait.id, times: 2, qty: 3000 });
    expect(top.some((t) => t.label === 'Couches taille 5' && t.article_id === null)).toBe(true);
    const row = s.purchases.reorderProposal(ctx.storeId).find((r) => r.article_id === lait.id);
    expect(row?.missed).toBe(3000);
  });

  it('propose de monter du stock ou de noter la demande quand la caisse manque de stock', () => {
    const biere = article('Bière Castel 65 cl');
    const reserve = s.admin.createWarehouse(ctx.storeId, 'Réserve du fond', 'reserve').id;
    s.stock.receive(ctx, { warehouseId: reserve, lines: [{ articleId: biere.id, qty: 24000, unitCost: 450 }] });
    // Une caissière vend depuis le magasin seul : la réserve n'est pas dans ses dépôts de vente.
    const anne = s.admin.createUser(ctx.userId, { name: 'Anne', login: 'anne', pin: '4321', role: 'cashier', storeId: ctx.storeId, registerId: ctx.registerId });
    const caisse = { ...ctx, userId: anne.id };
    s.pos.openSession(caisse, 0);
    let err: AppError | null = null;
    try {
      s.pos.completeSale(caisse, { lines: [{ articleId: biere.id, qty: 2000 }], payments: [{ method: 'CASH', amount: 1300 }] });
    } catch (e) {
      err = e as AppError;
    }
    expect(err?.code).toBe('OUT_OF_STOCK');
    expect(err?.fixes.map((f) => f.run?.api)).toEqual(['stock.transfer', 'missed.record']);
  });
});

describe('0.81.0 : magasinier', () => {
  it('calcule le réassort du rayon depuis la réserve et le fait en un transfert', () => {
    const riz = article('Riz 5 kg', 4500);
    const reserve = s.admin.createWarehouse(ctx.storeId, 'Réserve du fond', 'reserve').id;
    s.stock.receive(ctx, { warehouseId: reserve, lines: [{ articleId: riz.id, qty: 50000, unitCost: 3800 }] });
    s.stock.receive(ctx, { warehouseId: shop, lines: [{ articleId: riz.id, qty: 2000, unitCost: 3800 }] });
    s.floor.setShelfQty(ctx, riz.id, 10000);
    const plan = s.floor.restockList(ctx.storeId);
    const row = plan.rows.find((r) => r.article_id === riz.id)!;
    expect(row).toMatchObject({ from_warehouse_id: reserve, qty: 8000 });
    s.floor.restock(ctx, [{ articleId: riz.id, fromWarehouseId: reserve, qty: row.qty }]);
    expect(s.floor.restockList(ctx.storeId).rows.find((r) => r.article_id === riz.id)).toBeUndefined();
  });

  it('donne le prochain jour de passage du fournisseur', () => {
    // Mardi 6 octobre 2026 ; passages le lundi et le jeudi.
    expect(nextVisit('1,4', '2026-10-06')).toBe('2026-10-08');
    expect(nextVisit('2', '2026-10-06')).toBe('2026-10-06');
    expect(nextVisit(null, '2026-10-06')).toBeNull();
  });
});

describe('0.81.0 : caissier et gérant', () => {
  it('liste ce qui reste ouvert avant de clôturer', () => {
    const biere = article('Bière Castel 65 cl');
    s.pos.openSession(ctx, 0);
    s.pos.holdTicket(ctx, 'Client au bonnet rouge', [{ articleId: biere.id, qty: 1000 }]);
    const items = s.floor.beforeClose(ctx.storeId, ctx.registerId!);
    expect(items.find((i) => i.key === 'held')).toMatchObject({ count: 1 });
  });

  it('le rapport du propriétaire reprend les ventes réellement enregistrées', () => {
    const biere = article('Bière Castel 65 cl');
    s.stock.receive(ctx, { warehouseId: shop, lines: [{ articleId: biere.id, qty: 48000, unitCost: 450 }] });
    s.pos.openSession(ctx, 0);
    s.pos.completeSale(ctx, { lines: [{ articleId: biere.id, qty: 6000 }], payments: [{ method: 'CASH', amount: 3900 }] });
    const r = s.insights.ownerReport(ctx.storeId, '2026-10');
    expect(r.current.sales_ttc).toBe(3900);
    expect(r.text).toContain('3 900 FCFA');
  });
});

describe('0.81.0 : administration', () => {
  it('copie un utilisateur avec son rôle et ses privilèges', () => {
    const anne = s.admin.createUser(ctx.userId, { name: 'Anne', login: 'anne', pin: '4321', role: 'cashier', storeId: ctx.storeId, registerId: ctx.registerId });
    s.admin.savePrivileges(ctx.userId, anne.id, { grants: ['missed_report'], revokes: [] });
    const paul = s.admin.copyUser(ctx.userId, anne.id, { name: 'Paul', login: 'paul', pin: '8765' });
    expect(paul).toMatchObject({ role: 'cashier', store_id: ctx.storeId, register_id: ctx.registerId });
    expect(s.admin.privileges(paul.id).grants).toEqual(['missed_report']);
  });

  it('cherche dans le journal d’audit par produit et par mot', () => {
    const lait = article('Lait Nido 900 g', 4500);
    s.floor.setShelfQty(ctx, lait.id, 6000);
    expect(s.admin.auditSearch({ entityId: lait.id }).some((a) => a.action === 'article.shelf_qty' && a.entity_name === 'Lait Nido 900 g')).toBe(true);
    expect(s.admin.auditSearch({ text: 'nido' }).length).toBeGreaterThan(0);
  });

  it('garde les saisies en cours par utilisateur', () => {
    s.admin.saveDraft(ctx.userId, 'order:new', 'Nouveau bon de commande', { lines: [1] });
    expect(s.admin.drafts(ctx.userId).map((d) => d.key)).toEqual(['order:new']);
    s.admin.clearDraft(ctx.userId, 'order:new');
    expect(s.admin.drafts(ctx.userId)).toEqual([]);
  });
});
