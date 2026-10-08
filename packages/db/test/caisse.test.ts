import { receiptToText } from '@superette/core';
import { describe, expect, it } from 'vitest';
import { createServices, openDatabase } from '../src';

function setup() {
  const s = createServices(openDatabase(':memory:'), () => new Date('2026-10-10T09:00:00Z'));
  const { store, register, admin } = s.admin.bootstrap({ storeCode: 'DLA1', storeName: 'Superette Akwa', adminName: 'Steve', adminLogin: 'steve', adminPin: '1234' });
  const ctx = { storeId: store.id, registerId: register.id, userId: admin.id };
  const tva = s.admin.listVatRates().find((r) => r.rate_bp === 1925)!.id;
  const mutzig = s.catalogue.saveArticle(admin.id, {
    name: 'BIERE MUTZIG 50CL',
    unit: 'piece',
    unitName: 'CANETTE',
    vatRateId: tva,
    purchasePrice: 0,
    packPurchasePrice: 17_000,
    packCostPrice: 18_000,
    salePrice: 1_000,
    packs: [{ name: 'PALETTE', contains: 24, salePrice: 24_000 }],
  });
  const guinness = s.catalogue.saveArticle(admin.id, { name: 'GUINNESS 33CL', unit: 'piece', vatRateId: tva, purchasePrice: 600, salePrice: 900 });
  s.stock.receive(ctx, { warehouseId: s.admin.salesWarehouse(store.id).id, lines: [{ articleId: mutzig.id, qty: 30_000, unitCost: 708, packCost: 17_000, packUnits: 24_000 }] });
  s.pos.openSession(ctx, 0);
  return { s, ctx, mutzig, guinness };
}

describe('caisse : épuisés, prix saisi, client comptoir', () => {
  it('liste les produits épuisés en les marquant, et refuse de les vendre', () => {
    const { s, ctx, mutzig, guinness } = setup();
    const rows = s.pos.searchForSale(ctx.storeId, 'e');
    expect(rows.map((r) => [r.name, r.pack_name, r.out_of_stock])).toEqual([
      ['BIERE MUTZIG 50CL', 'PALETTE', false],
      ['BIERE MUTZIG 50CL', 'CANETTE', false],
      ['GUINNESS 33CL', 'Pièce', true],
    ]);
    expect(s.pos.searchForSale(ctx.storeId, 'e', { includeEmpty: false })).toHaveLength(2);
    expect(() => s.pos.completeSale(ctx, { lines: [{ articleId: guinness.id, qty: 1000 }], payments: [{ method: 'CASH', amount: 900 }] })).toThrow(
      /Stock insuffisant pour GUINNESS 33CL : épuisé/,
    );
    // 30 canettes : une palette et 7 canettes dépassent le stock, même réparties sur deux lignes.
    const palette = mutzig.packs[0]!;
    expect(() =>
      s.pos.completeSale(ctx, {
        lines: [
          { articleId: mutzig.id, qty: 24_000, packId: palette.id },
          { articleId: mutzig.id, qty: 7_000 },
        ],
        payments: [{ method: 'CASH', amount: 31_000 }],
      }),
    ).toThrow(/il reste 30 canette/);
  });

  it('accepte un prix saisi au-dessus du revient, jamais en dessous', () => {
    const { s, ctx, mutzig } = setup();
    const palette = mutzig.packs[0]!;
    // Revient : 18 000 la palette, 750 la canette.
    expect(s.pos.searchForSale(ctx.storeId, 'mutzig').map((r) => r.cost)).toEqual([18_000, 750]);
    expect(() => s.pos.priceLines(ctx.storeId, [{ articleId: mutzig.id, qty: 1000, price: 700 }])).toThrow(/coût de revient \(750 FCFA par unité\)/);
    expect(() => s.pos.priceLines(ctx.storeId, [{ articleId: mutzig.id, qty: 24_000, packId: palette.id, price: 17_500 }])).toThrow(/18\s000 FCFA par palette/);
    const sale = s.pos.completeSale(ctx, {
      lines: [
        { articleId: mutzig.id, qty: 24_000, packId: palette.id, price: 22_000 },
        { articleId: mutzig.id, qty: 2_000, price: 800 },
      ],
      payments: [{ method: 'CASH', amount: 23_600 }],
      clientName: '  Mme Ngo Bassa ',
    });
    expect(sale.lines.map((l) => [l.pack_name, l.total_ttc])).toEqual([
      ['PALETTE', 22_000],
      [null, 1_600],
    ]);
    expect(sale.total_ttc).toBe(23_600);
    expect(sale.customer_name).toBe('Mme Ngo Bassa');
    expect(receiptToText(s.receipts.ticket(sale.id), 48)).toMatch(/Client : Mme Ngo Bassa/);
    const audit = s.admin.auditLog().find((a) => a.action === 'sale.price_set');
    expect(audit).toBeDefined();
  });
});

describe('droits par rôle', () => {
  it('reprend la répartition d’origine, se règle par rôle et laisse tout à l’administrateur', () => {
    const { s, ctx } = setup();
    expect(s.admin.rights('cashier')).toEqual(expect.arrayContaining(['cash', 'credit', 'customers', 'quotes', 'price']));
    expect(s.admin.rights('cashier')).not.toContain('discount');
    expect(s.admin.rights('admin')).toContain('admin');
    const cashier = { role: 'cashier' as const };
    s.admin.saveRights(ctx.userId, 'cashier', ['cash', 'discount']);
    expect(s.admin.rights('cashier')).toEqual(['cash', 'discount']);
    expect(s.admin.hasRight(cashier, 'price')).toBe(false);
    expect(s.admin.rightsMatrix().map((r) => r.role)).toEqual(['manager', 'cashier', 'stock', 'accountant']);
    expect(() => s.admin.saveRights(ctx.userId, 'admin', [])).toThrow(/tous les droits/);
    expect(() => s.admin.saveRights(ctx.userId, 'cashier', ['voler' as never])).toThrow(/Droit inconnu/);
    // Les droits voyagent vers les autres postes.
    expect(s.db.prepare("SELECT entity, entity_id FROM outbox WHERE entity = 'role_rights'").all()).toEqual([{ entity: 'role_rights', entity_id: 'cashier' }]);
  });

  it('un caissier avec le droit de remise vend avec remise sans code du gérant', () => {
    const { s, ctx, mutzig } = setup();
    const caissier = s.admin.createUser(ctx.userId, { name: 'Awa', login: 'awa', pin: '5678', role: 'cashier', storeId: ctx.storeId });
    const c = { ...ctx, userId: caissier.id };
    const sell = () => s.pos.completeSale(c, { lines: [{ articleId: mutzig.id, qty: 1000, discount: 100 }], payments: [{ method: 'CASH', amount: 900 }] });
    expect(sell).toThrow(/validation du gérant/);
    s.admin.saveRights(ctx.userId, 'cashier', ['cash', 'discount']);
    expect(sell().total_ttc).toBe(900);
  });
});
