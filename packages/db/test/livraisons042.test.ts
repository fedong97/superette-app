import { describe, expect, it } from 'vitest';
import { DELIVERY_FEE_ARTICLE_ID, createServices, openDatabase } from '../src';

function setup() {
  const s = createServices(openDatabase(':memory:'), () => new Date('2026-10-13T09:00:00Z'));
  const { store, register, admin } = s.admin.bootstrap({ storeCode: 'DLA1', storeName: 'Superette Akwa', adminName: 'Steve', adminLogin: 'steve', adminPin: '1234' });
  const ctx = { storeId: store.id, registerId: register.id, userId: admin.id };
  const tva = s.admin.listVatRates().find((r) => r.rate_bp === 1925)!.id;
  const castel = s.catalogue.saveArticle(admin.id, { name: 'CASTEL 65CL', unit: 'piece', vatRateId: tva, purchasePrice: 450, salePrice: 650, wholesalePrice: 600 });
  const shop = s.admin.salesWarehouse(store.id);
  const reserve = s.admin.createWarehouse(store.id, 'Réserve', 'reserve');
  s.stock.receive(ctx, { warehouseId: shop.id, lines: [{ articleId: castel.id, qty: 2_000, unitCost: 450 }] });
  s.stock.receive(ctx, { warehouseId: reserve.id, lines: [{ articleId: castel.id, qty: 10_000, unitCost: 450 }] });
  s.pos.openSession(ctx, 0);
  const qty = (warehouseId: string) => s.db.prepare('SELECT COALESCE(SUM(qty), 0) FROM stock WHERE article_id = ? AND warehouse_id = ?').pluck().get(castel.id, warehouseId) as number;
  return { s, ctx, castel, shop, reserve, qty };
}

describe('caisse : tarif et dépôt choisis pour la fiche', () => {
  it('vend au tarif gros et sort la marchandise de la réserve', () => {
    const { s, ctx, castel, shop, reserve, qty } = setup();
    expect(s.pos.searchForSale(ctx.storeId, 'castel', { priceLevel: 'wholesale', warehouseId: reserve.id }).map((r) => [r.price, r.stock, r.warehouse])).toEqual([[600, 10_000, 'Réserve']]);
    // 5 bouteilles : la surface de vente n'en a que 2, la réserve en a 10.
    expect(() => s.pos.completeSale(ctx, { lines: [{ articleId: castel.id, qty: 5_000 }], payments: [{ method: 'CASH', amount: 3_250 }] })).toThrow(/Stock insuffisant/);
    const sale = s.pos.completeSale(ctx, {
      lines: [{ articleId: castel.id, qty: 5_000 }],
      payments: [{ method: 'CASH', amount: 3_000 }],
      priceLevel: 'wholesale',
      warehouseId: reserve.id,
    });
    expect([sale.total_ttc, sale.price_level]).toEqual([3_000, 'wholesale']);
    expect([qty(shop.id), qty(reserve.id)]).toEqual([2_000, 5_000]);
    // Annulée : la marchandise revient dans la réserve.
    s.pos.cancelSale(ctx, sale.id, ctx.userId, 'erreur');
    expect(qty(reserve.id)).toBe(10_000);
  });

  it("refuse un dépôt d'un autre magasin", () => {
    const { s, ctx, castel } = setup();
    expect(() => s.pos.completeSale(ctx, { lines: [{ articleId: castel.id, qty: 1_000 }], payments: [{ method: 'CASH', amount: 650 }], warehouseId: 'inconnu' })).toThrow(/Dépôt indisponible/);
  });
});

describe('livraisons', () => {
  it('ajoute les frais au ticket sans toucher au stock et suit la livraison', () => {
    const { s, ctx, castel, shop, qty } = setup();
    const sale = s.pos.completeSale(ctx, {
      lines: [{ articleId: castel.id, qty: 2_000 }],
      payments: [{ method: 'CASH', amount: 2_300 }],
      delivery: { address: 'Bonapriso, rue Njo-Njo', phone: '699 11 22 33', courier: 'Paul', slot: '14h–16h', fee: 1_000, note: 'Portail bleu' },
    });
    expect(sale.total_ttc).toBe(2_300);
    expect(sale.lines.map((l) => [l.label, l.total_ttc])).toEqual([
      ['CASTEL 65CL', 1_300],
      ['Frais de livraison', 1_000],
    ]);
    expect(qty(shop.id)).toBe(0);
    // Le service n'apparaît pas dans les recherches ni dans le stock.
    expect(s.pos.searchForSale(ctx.storeId, 'livraison')).toEqual([]);
    expect(s.catalogue.getArticle(DELIVERY_FEE_ARTICLE_ID, ctx.storeId).active).toBe(0);
    expect(s.catalogue.searchArticles('livraison', ctx.storeId, { includeInactive: true })).toEqual([]);

    const [d] = s.deliveries.list(ctx.storeId, { from: '2026-10-13', to: '2026-10-13' });
    expect([d!.status, d!.planned_date, d!.sale_number, d!.fee, d!.to_collect]).toEqual(['pending', '2026-10-13', sale.number, 1_000, 0]);
    expect(s.deliveries.couriers(ctx.storeId)).toEqual(['Paul']);
    // Par l'IPC, l'option absente arrive à null.
    s.deliveries.setStatus(ctx, d!.id, 'out', null);
    expect(() => s.deliveries.setStatus(ctx, d!.id, 'out')).toThrow(/déjà partie/);
    const done = s.deliveries.setStatus(ctx, d!.id, 'delivered');
    expect([done.status, done.delivered_at]).toEqual(['delivered', '2026-10-13T09:00:00.000Z']);
    expect(s.deliveries.list(ctx.storeId, { open: true })).toEqual([]);
  });

  it("refuse une livraison sans adresse et annule la livraison d'une vente annulée", () => {
    const { s, ctx, castel } = setup();
    expect(() =>
      s.pos.completeSale(ctx, { lines: [{ articleId: castel.id, qty: 1_000 }], payments: [{ method: 'CASH', amount: 650 }], delivery: { address: '  ' } }),
    ).toThrow(/adresse de livraison/);
    const sale = s.pos.completeSale(ctx, { lines: [{ articleId: castel.id, qty: 1_000 }], payments: [{ method: 'CASH', amount: 650 }], delivery: { address: 'Akwa' } });
    s.pos.cancelSale(ctx, sale.id, ctx.userId, 'client absent');
    expect(s.deliveries.forSale(sale.id)!.status).toBe('cancelled');
  });

  it('montre la part à crédit que le livreur encaisse', () => {
    const { s, ctx, castel } = setup();
    const c = s.customers.saveCustomer(ctx.userId, { name: 'Ets Mballa', address: 'Bonapriso', creditLimit: 100_000 } as never);
    s.pos.completeSale(ctx, {
      lines: [{ articleId: castel.id, qty: 1_000 }],
      payments: [{ method: 'CUSTOMER_CREDIT', amount: 650 }],
      customerId: c.id,
      delivery: { address: 'Bonapriso' },
    });
    expect(s.deliveries.list(ctx.storeId, { open: true }).map((d) => [d.customer_name, d.to_collect])).toEqual([['Ets Mballa', 650]]);
  });
});
