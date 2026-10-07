import { describe, expect, it } from 'vitest';
import { createServices, openDatabase } from '../src';

function setup() {
  let now = new Date('2026-10-10T09:00:00Z');
  const s = createServices(openDatabase(':memory:'), () => now);
  const { store, register, admin } = s.admin.bootstrap({ storeCode: 'DLA1', storeName: 'Superette Akwa', adminName: 'Steve', adminLogin: 'steve', adminPin: '1234' });
  const ctx = { storeId: store.id, registerId: register.id, userId: admin.id };
  const tva = s.admin.listVatRates().find((r) => r.rate_bp === 1925)!.id;
  const ampoule = s.catalogue.saveArticle(admin.id, {
    name: 'Ampoule ronde 100W',
    unit: 'piece',
    unitName: 'Ampoule',
    vatRateId: tva,
    purchasePrice: 100,
    salePrice: 200,
    barcodes: [{ code: '6001234567899' }],
    packs: [{ name: 'Carton', contains: 100, salePrice: 10_500, barcode: '6001234567905', purchase: true }],
  });
  const lait = s.catalogue.saveArticle(admin.id, { name: 'Lait Nido 400 g', unit: 'piece', vatRateId: tva, purchasePrice: 2000, salePrice: 2500 });
  const riz = s.catalogue.saveArticle(admin.id, { name: 'Riz vrac', unit: 'kg', vatRateId: tva, purchasePrice: 400, salePrice: 550 });
  s.stock.receive(ctx, { warehouseId: s.admin.salesWarehouse(store.id).id, lines: [{ articleId: ampoule.id, qty: 500_000, unitCost: 100 }] });
  return { s, ctx, ampoule, lait, riz, setNow: (iso: string) => (now = new Date(iso)) };
}

describe('étiquettes', () => {
  it('prépare les étiquettes de l’unité, du carton, du vrac et des promotions', () => {
    const { s, ctx, ampoule, lait, riz } = setup();
    s.promotions.save(ctx.userId, { name: 'Nido', kind: 'price', articleId: lait.id, storeId: null, startsOn: '2026-10-01', endsOn: '2026-10-31', promoPrice: 2200 });
    const labels = s.labels.build(ctx.storeId, [
      { articleId: ampoule.id, copies: 2 },
      { articleId: ampoule.id, pack: 'Carton', copies: 1 },
      { articleId: lait.id, copies: 1 },
      { articleId: riz.id, copies: 1 },
    ]);
    expect(labels).toHaveLength(5);
    expect(labels[0]).toMatchObject({ name: 'Ampoule ronde 100W', price: 200, barcode: '6001234567899', date: '10/10/2026' });
    expect(labels[0]!.detail).toMatch(/^Carton de 100 : 10\s500 F$/);
    expect(labels[2]).toMatchObject({ name: 'Ampoule ronde 100W · Carton', price: 10_500, barcode: '6001234567905' });
    expect(labels[2]!.detail).toMatch(/^Carton de 100 ampoules · 105 F l’unité$/);
    expect(labels[3]).toMatchObject({ price: 2200, oldPrice: 2500, promo: 'PROMO', barcode: null });
    expect(labels[4]).toMatchObject({ price: 550, detail: 'Prix le kg', barcode: null });
    expect(() => s.labels.build(ctx.storeId, [{ articleId: ampoule.id, copies: 0 }])).toThrow(/Aucune étiquette/);
  });

  it('liste les étiquettes à refaire : article reçu jamais étiqueté, puis prix changé', () => {
    const { s, ctx, ampoule, lait } = setup();
    // Seule l'ampoule est en stock : ses deux étiquettes sont à faire, pas celles du lait.
    const redo = s.labels.candidates(ctx.storeId, { redo: true });
    expect(redo.map((c) => [c.pack_label, c.reason])).toEqual([
      ['Carton de 100', 'new'],
      ['Ampoule', 'new'],
    ]);
    s.labels.markPrinted(ctx.storeId, [
      { articleId: ampoule.id, copies: 3 },
      { articleId: ampoule.id, pack: 'Carton', copies: 1 },
    ]);
    expect(s.labels.candidates(ctx.storeId, { redo: true })).toEqual([]);

    // Hausse du prix magasin de l'ampoule : seule son étiquette est à refaire.
    s.catalogue.setStorePrice(ctx.userId, ampoule.id, ctx.storeId, 225);
    expect(s.labels.candidates(ctx.storeId, { redo: true })).toMatchObject([{ pack: '', price: 225, last_price: 200, reason: 'price' }]);
    // Toutes les étiquettes restent proposées hors filtre.
    expect(s.labels.candidates(ctx.storeId, { search: 'Nido' })).toMatchObject([{ article_id: lait.id, reason: null }]);
  });
});
