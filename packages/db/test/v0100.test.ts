import { describe, expect, it } from 'vitest';
import { createServices, openDatabase } from '../src';

function setup() {
  let now = new Date('2026-10-05T14:00:00Z');
  const s = createServices(openDatabase(':memory:'), () => now);
  const { store, register, admin } = s.admin.bootstrap({ storeCode: 'DLA1', storeName: 'Superette Akwa', adminName: 'Steve', adminLogin: 'steve', adminPin: '1234' });
  const ctx = { storeId: store.id, registerId: register.id, userId: admin.id };
  const tva = s.admin.listVatRates().find((r) => r.rate_bp === 1925)!.id;
  const shop = s.admin.salesWarehouse(store.id).id;
  const coca = s.catalogue.saveArticle(admin.id, {
    name: 'Coca-Cola 50 cl',
    unit: 'piece',
    vatRateId: tva,
    purchasePrice: 300,
    salePrice: 500,
    packs: [{ name: 'Casier', contains: 12, salePrice: 5800 }],
  });
  const riz = s.catalogue.saveArticle(admin.id, { name: 'Riz au kilo', unit: 'kg', vatRateId: tva, purchasePrice: 450, salePrice: 650 });
  s.stock.receive(ctx, { warehouseId: shop, lines: [{ articleId: coca.id, qty: 100_000, unitCost: 300 }, { articleId: riz.id, qty: 50_000, unitCost: 450 }] });
  s.pos.openSession(ctx, 10_000);
  const at = (iso: string) => {
    now = new Date(iso);
  };
  return { s, ctx, coca, riz, at };
}

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

describe('0.100.0 : carnet de coupure lu en photo', () => {
  it('codes du carnet : un par article et par conditionnement, stables', () => {
    const { s, ctx, coca, riz } = setup();
    expect(s.bookCodes.assign(ctx.userId)).toEqual({ created: 3, renumbered: 0 });
    const list = s.bookCodes.list(ctx.storeId);
    expect(list.map((c) => [c.article_name, c.pack_name, c.units, c.price])).toEqual([
      ['Coca-Cola 50 cl', 'Unité', 1000, 500],
      ['Coca-Cola 50 cl', 'Casier', 12_000, 5800],
      ['Riz au kilo', 'Kg', 1000, 650],
    ]);
    expect(new Set(list.map((c) => c.code)).size).toBe(3);
    // Rien ne bouge au second passage ; un doublon venu d'un autre PC est renuméroté.
    expect(s.bookCodes.assign(ctx.userId)).toEqual({ created: 0, renumbered: 0 });
    const first = list[0]!.code;
    s.db.prepare("INSERT INTO book_codes (id, code, article_id, units, created_at, updated_at) VALUES ('autre-pc', ?, ?, 1000, '2026-10-06T00:00:00Z', '2026-10-06T00:00:00Z')").run(first, riz.id);
    expect(s.bookCodes.assign(ctx.userId).renumbered).toBe(1);
    expect(s.db.prepare("SELECT code FROM book_codes WHERE id = 'autre-pc'").pluck().get()).not.toBe(first);
    expect(s.bookCodes.list(ctx.storeId).find((c) => c.code === first)?.article_id).toBe(coca.id);
  });

  it('photo de la page jointe, ventes de la page enregistrées ensemble ou pas du tout', () => {
    const { s, ctx, coca, riz } = setup();
    const o = s.outages.declare(ctx, { startedAt: '2026-10-05T09:00:00Z', endedAt: '2026-10-05T12:00:00Z', declaredTotal: 7775 });
    expect(() => s.outages.addPage(ctx, o.id, { name: 'page.pdf', mime: 'application/pdf', data: PNG })).toThrow(/photo/);
    const page = s.outages.addPage(ctx, o.id, { name: 'page 1.jpg', mime: 'image/png', data: `data:image/png;base64,${PNG}` });
    expect(page.page).toBe(1);
    expect(s.outages.get(o.id).pages).toBe(1);
    expect(s.outages.page(page.id).data).toBe(PNG);
    const casier = s.catalogue.getArticle(coca.id).packs[0]!;
    // Une ligne refusée (heure hors de la coupure) : rien n'est enregistré.
    expect(() =>
      s.pos.completeOutageSales(ctx, o.id, [
        { at: '2026-10-05T09:25:00Z', number: `${o.number}/1/1`, lines: [{ articleId: coca.id, qty: 2000 }] },
        { at: '2026-10-05T13:00:00Z', number: `${o.number}/1/2`, lines: [{ articleId: riz.id, qty: 1500 }] },
      ]),
    ).toThrow(/Vente 2 \(souche .*\/1\/2\) : .*pendant la coupure/);
    expect(s.outages.get(o.id).sales).toBe(0);
    const sales = s.pos.completeOutageSales(ctx, o.id, [
      { at: '2026-10-05T09:25:00Z', number: `${o.number}/1/1`, lines: [{ articleId: coca.id, qty: 2000 }, { articleId: coca.id, packId: casier.id, qty: 12_000 }] },
      { at: '2026-10-05T09:40:00Z', number: `${o.number}/1/2`, lines: [{ articleId: riz.id, qty: 1500 }] },
    ]);
    expect(sales.map((v) => [v.total_ttc, v.outage_id, v.book_at])).toEqual([
      [6800, o.id, '2026-10-05T09:25:00.000Z'],
      [975, o.id, '2026-10-05T09:40:00.000Z'],
    ]);
    expect(s.outages.get(o.id)).toMatchObject({ entered_total: 7775, gap: 0, sales: 2 });
    // La même page ne s'enregistre pas deux fois : ses numéros de vente sont déjà pris.
    expect(() => s.pos.completeOutageSales(ctx, o.id, [{ at: '2026-10-05T09:25:00Z', number: `${o.number}/1/1`, lines: [{ articleId: coca.id, qty: 1000 }] }])).toThrow(/déjà saisie/);
    s.outages.close(ctx, o.id);
    expect(() => s.outages.removePage(ctx, page.id)).toThrow(/preuve/);
  });
});
