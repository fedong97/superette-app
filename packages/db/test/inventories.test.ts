import { beforeEach, describe, expect, it } from 'vitest';
import { type Context, type Services, createServices, openDatabase } from '../src';

let s: Services;
let ctx: Context;
let wh: string;
let now = new Date('2026-10-09T08:00:00Z');
const A: Record<string, string> = {};

beforeEach(() => {
  now = new Date('2026-10-09T08:00:00Z');
  s = createServices(openDatabase(':memory:'), () => now);
  const { store, register, admin } = s.admin.bootstrap({ storeCode: 'DLA1', storeName: 'Superette Akwa', adminName: 'Steve', adminLogin: 'steve', adminPin: '1234' });
  ctx = { storeId: store.id, registerId: register.id, userId: admin.id };
  wh = s.admin.salesWarehouse(store.id).id;
  const tva = s.admin.listVatRates()[0]!.id;
  const boissons = s.catalogue.createDepartment('Boissons');
  const fam = s.catalogue.createFamily(boissons.id, 'Bières');
  A.biere = s.catalogue.saveArticle(admin.id, { name: 'Bière 65 cl', unit: 'piece', vatRateId: tva, purchasePrice: 500, salePrice: 650, familyId: fam.id }).id;
  A.riz = s.catalogue.saveArticle(admin.id, { name: 'Riz 5 kg', unit: 'piece', vatRateId: tva, purchasePrice: 3_000, salePrice: 4_500 }).id;
  A.sucre = s.catalogue.saveArticle(admin.id, { name: 'Sucre 1 kg', unit: 'piece', vatRateId: tva, purchasePrice: 800, salePrice: 1_000 }).id;
  s.stock.receive(ctx, {
    warehouseId: wh,
    lines: [
      { articleId: A.biere!, qty: 24_000, unitCost: 500 },
      { articleId: A.riz!, qty: 10_000, unitCost: 3_000 },
      { articleId: A.sucre!, qty: 5_000, unitCost: 800 },
    ],
  });
  now = new Date('2026-10-09T09:00:00Z');
});

const line = (id: string, article: string) => s.inventories.lines(id).find((l) => l.article_id === article)!;
const qtyOf = (article: string) => s.stock.list(ctx.storeId, { warehouseId: wh }).find((r) => r.article_id === article)!.qty;

describe('inventaires enregistrés', () => {
  it('inventaire global : liste complète, ventes pendant le comptage, non comptés à zéro', () => {
    const inv = s.inventories.create(ctx, { warehouseId: wh, kind: 'global' });
    expect(inv).toMatchObject({ number: 1, status: 'open', kind: 'global', line_count: 3, counted_count: 0 });
    expect(line(inv.id, A.riz!)).toMatchObject({ opening_qty: 10_000, expected: 10_000, counted: null });

    now = new Date('2026-10-09T10:00:00Z');
    s.inventories.setCount(ctx, inv.id, A.riz!, 8_000);
    // Vente après le comptage : elle ne fausse pas l'écart.
    now = new Date('2026-10-09T10:30:00Z');
    s.pos.openSession(ctx, 0);
    s.pos.completeSale(ctx, { lines: [{ articleId: A.riz!, qty: 1_000 }], payments: [{ method: 'CASH', amount: 4_500 }] });
    expect(line(inv.id, A.riz!)).toMatchObject({ period_qty: -1_000, expected: 10_000, counted: 8_000, difference: -2_000, gap_value: -6_000 });

    s.inventories.setCount(ctx, inv.id, A.biere!, 30_000, [1, 6]);
    expect(line(inv.id, A.biere!)).toMatchObject({ difference: 6_000, counted_detail: [1, 6], counted_by_name: 'Steve' });
    expect(s.inventories.history(inv.id).map((h) => [h.user_name, h.count])).toEqual([['Steve', 1], ['Steve', 1]]);

    const closed = s.inventories.close(ctx, inv.id);
    expect(closed).toMatchObject({ status: 'closed', counted_count: 3, gap_value: -6_000 + 3_000 - 4_000 });
    expect(qtyOf(A.riz!)).toBe(7_000); // 8 comptés − 1 vendu après le comptage
    expect(qtyOf(A.biere!)).toBe(30_000);
    expect(qtyOf(A.sucre!)).toBe(0); // non compté dans un inventaire global
    expect(() => s.inventories.setCount(ctx, inv.id, A.riz!, 1_000)).toThrow(/clôturé/);
    const moves = s.db.prepare("SELECT reason FROM stock_movements WHERE ref_type = 'inventory'").pluck().all();
    expect(moves).toContain('Inventaire n° 1');
  });

  it('inventaire partiel : par rayon, ajout de produits, non comptés inchangés, import CSV', () => {
    const dept = s.catalogue.listDepartments().find((d) => d.name === 'Boissons')!;
    const inv = s.inventories.create(ctx, { warehouseId: wh, kind: 'partial', departmentIds: [dept.id] });
    expect(inv.departments).toEqual(['Boissons']);
    expect(s.inventories.lines(inv.id).map((l) => l.name)).toEqual(['Bière 65 cl']);
    s.inventories.addArticle(ctx, inv.id, A.sucre!);
    expect(() => s.inventories.addArticle(ctx, inv.id, A.sucre!)).toThrow(/déjà/);
    const code = s.catalogue.getArticle(A.riz!).code;
    const r = s.inventories.importCounts(ctx, inv.id, [
      { code, qty: 9 },
      { code: 'INCONNU', qty: 3 },
    ]);
    expect(r).toEqual({ imported: 1, unknown: ['INCONNU'] });
    s.inventories.setCount(ctx, inv.id, A.biere!, 20_000);
    s.inventories.close(ctx, inv.id);
    expect(qtyOf(A.biere!)).toBe(20_000);
    expect(qtyOf(A.riz!)).toBe(9_000);
    expect(qtyOf(A.sucre!)).toBe(5_000); // non compté, inchangé
  });

  it('inventaire antidaté : stock arrêté à la fin du jour choisi', () => {
    now = new Date('2026-10-10T09:00:00Z');
    s.pos.openSession(ctx, 0);
    s.pos.completeSale(ctx, { lines: [{ articleId: A.riz!, qty: 2_000 }], payments: [{ method: 'CASH', amount: 9_000 }] });
    const inv = s.inventories.create(ctx, { warehouseId: wh, kind: 'partial', articleIds: [A.riz!], date: '2026-10-09' });
    expect(line(inv.id, A.riz!)).toMatchObject({ opening_qty: 10_000, expected: 10_000 });
    s.inventories.setCount(ctx, inv.id, A.riz!, 9_000);
    s.inventories.close(ctx, inv.id);
    expect(qtyOf(A.riz!)).toBe(7_000);
    const at = s.db.prepare("SELECT at FROM stock_movements WHERE ref_type = 'inventory'").pluck().get() as string;
    expect(at < '2026-10-10T00:00:00Z').toBe(true);
    expect(() => s.inventories.create(ctx, { warehouseId: wh, kind: 'global', date: '2027-01-01' })).toThrow(/futur/);
  });

  it('annulation : le stock ne bouge pas', () => {
    const inv = s.inventories.create(ctx, { warehouseId: wh, kind: 'global' });
    s.inventories.setCount(ctx, inv.id, A.riz!, 1_000);
    expect(s.inventories.cancel(ctx, inv.id).status).toBe('cancelled');
    expect(qtyOf(A.riz!)).toBe(10_000);
    expect(s.inventories.list(ctx.storeId).map((i) => i.status)).toEqual(['cancelled']);
  });
});
