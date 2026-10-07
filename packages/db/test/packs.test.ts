import { receiptToText } from '@superette/core';
import { describe, expect, it } from 'vitest';
import { createServices, openDatabase } from '../src';

function setup() {
  const s = createServices(openDatabase(':memory:'), () => new Date('2026-10-10T09:00:00Z'));
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
    wholesalePrice: 180,
    barcodes: [{ code: '6001234567899' }],
    packs: [
      { name: 'Carton', contains: 10, salePrice: 10_500, wholesalePrice: 10_000, barcode: '6001234567905', purchase: true },
      { name: 'Paquet', contains: 10, salePrice: 1_500 },
    ],
  });
  s.stock.receive(ctx, { warehouseId: s.admin.salesWarehouse(store.id).id, lines: [{ articleId: ampoule.id, qty: 500_000, unitCost: 100 }] });
  s.pos.openSession(ctx, 0);
  return { s, ctx, ampoule };
}

describe('vente par conditionnement', () => {
  it('enregistre les niveaux carton > paquet > ampoule et retrouve le carton au scan', () => {
    const { s, ctx, ampoule } = setup();
    expect(ampoule.packs.map((p) => [p.name, p.contains, p.units, p.sale_price, p.is_purchase])).toEqual([
      ['Carton', 10, 100_000, 10_500, 1],
      ['Paquet', 10, 10_000, 1_500, 0],
    ]);
    expect(ampoule.barcodes).toContainEqual({ code: '6001234567905', pack_qty: 100_000 });
    const hit = s.catalogue.scan('6001234567905', ctx.storeId)!;
    expect(hit).toMatchObject({ qty: 100_000, pack: { name: 'Carton' } });
    expect(s.catalogue.scan('6001234567899', ctx.storeId)!.pack).toBeUndefined();
  });

  it('vend au carton, au paquet et à l’unité, au détail comme au tarif de gros', () => {
    const { s, ctx, ampoule } = setup();
    const [carton, paquet] = ampoule.packs;
    const sale = s.pos.completeSale(ctx, {
      lines: [
        { articleId: ampoule.id, qty: 200_000, packId: carton!.id, barcode: '6001234567905' },
        { articleId: ampoule.id, qty: 10_000, packId: paquet!.id },
        { articleId: ampoule.id, qty: 3000 },
      ],
      payments: [{ method: 'CASH', amount: 30_000 }],
    });
    expect(sale.lines.map((l) => [l.pack_name, l.qty, l.total_ttc])).toEqual([
      ['Carton', 200_000, 21_000],
      ['Paquet', 10_000, 1_500],
      [null, 3000, 600],
    ]);
    expect(sale.total_ttc).toBe(23_100);
    // Le stock est tenu à l'ampoule : 500 - 213.
    expect(s.stock.list(ctx.storeId).find((r) => r.article_id === ampoule.id)!.qty).toBe(287_000);
    expect(s.stock.list(ctx.storeId).find((r) => r.article_id === ampoule.id)!.in_packs).toBe('2 Carton 8 Paquet 7 Ampoule');
    const text = receiptToText(s.receipts.ticket(sale.id), 48);
    expect(text).toMatch(/Ampoule ronde 100W\s+21 000\n\s+2 Carton x 10 500/);
    expect(text).toMatch(/1 Paquet x 1 500/);

    // Client revendeur au tarif de gros : carton à 10 000, ampoule à 180, paquet sans prix de gros = détail.
    const pro = s.customers.saveCustomer(ctx.userId, { name: 'Quincaillerie Mboppi', priceLevel: 'wholesale' });
    const gros = s.pos.completeSale(ctx, {
      lines: [
        { articleId: ampoule.id, qty: 100_000, packId: carton!.id },
        { articleId: ampoule.id, qty: 10_000, packId: paquet!.id },
        { articleId: ampoule.id, qty: 2000 },
      ],
      payments: [{ method: 'CASH', amount: 12_000 }],
      customerId: pro.id,
    });
    expect(gros).toMatchObject({ total_ttc: 10_000 + 1_500 + 360, price_level: 'wholesale' });
    expect(receiptToText(s.receipts.ticket(gros.id), 48)).toMatch(/Tarif : Gros/);
  });

  it('refuse une quantité qui n’est pas un nombre entier de cartons', () => {
    const { s, ctx, ampoule } = setup();
    expect(() => s.pos.priceLines(ctx.storeId, [{ articleId: ampoule.id, qty: 150_000, packId: ampoule.packs[0]!.id }])).toThrow(/nombre entier de Carton/);
  });

  it('garde les conditionnements quand on modifie la fiche sans les toucher', () => {
    const { s, ctx, ampoule } = setup();
    const tva = ampoule.vat_rate_id;
    const after = s.catalogue.saveArticle(ctx.userId, { name: 'Ampoule ronde 100 W', unit: 'piece', vatRateId: tva, purchasePrice: 100, salePrice: 220, barcodes: ampoule.barcodes.map((b) => ({ code: b.code, packQty: b.pack_qty })) }, ampoule.id);
    expect(after.packs).toHaveLength(2);
    expect(after.unit_name).toBe('Ampoule');
    expect(s.catalogue.scan('6001234567905', ctx.storeId)!.pack!.name).toBe('Carton');
  });
});
