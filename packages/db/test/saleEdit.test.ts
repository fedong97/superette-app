import { describe, expect, it } from 'vitest';
import { createServices, openDatabase } from '../src';

function setup() {
  const s = createServices(openDatabase(':memory:'), () => new Date('2026-10-10T09:00:00Z'));
  const { store, register, admin } = s.admin.bootstrap({ storeCode: 'DLA1', storeName: 'Superette Akwa', adminName: 'Steve', adminLogin: 'steve', adminPin: '1234' });
  const cashier = s.admin.createUser(admin.id, { name: 'Awa', login: 'awa', pin: '5555', role: 'cashier', storeId: store.id, registerId: register.id });
  const ctx = { storeId: store.id, registerId: register.id, userId: cashier.id };
  const tva = s.admin.listVatRates()[0]!.id;
  const riz = s.catalogue.saveArticle(admin.id, { name: 'RIZ 5 KG', unit: 'piece', vatRateId: tva, purchasePrice: 3_000, salePrice: 5_000 });
  const huile = s.catalogue.saveArticle(admin.id, { name: 'HUILE 1 L', unit: 'piece', vatRateId: tva, purchasePrice: 1_000, salePrice: 1_500 });
  const wh = s.admin.salesWarehouse(store.id).id;
  s.stock.receive(ctx, { warehouseId: wh, lines: [{ articleId: riz.id, qty: 20_000, unitCost: 3_000 }, { articleId: huile.id, qty: 20_000, unitCost: 1_000 }] });
  s.pos.openSession(ctx, 0);
  const qty = (name: string) => s.stock.list(store.id, { search: name })[0]!.qty / 1000;
  return { s, ctx, riz, huile, cashier, qty };
}

describe('modifier, annuler et supprimer une facture', () => {
  it('modifie une facture : la nouvelle remplace l’ancienne et ne fait payer que la différence', () => {
    const { s, ctx, riz, huile, cashier, qty } = setup();
    const first = s.pos.completeSale(ctx, { lines: [{ articleId: riz.id, qty: 2000 }], payments: [{ method: 'CASH', amount: 15_000 }] });
    expect(first.change_given).toBe(5_000);
    expect(s.pos.editableSale(first.id)).toMatchObject({ paid: 10_000, lines: [{ articleId: riz.id, qty: 2000, discount: 0, packId: null }] });
    // Un riz de moins, deux huiles de plus : 8 000 au lieu de 10 000, on rend 2 000.
    const edited = s.pos.replaceSale(ctx, first.id, { lines: [{ articleId: riz.id, qty: 1000 }, { articleId: huile.id, qty: 2000 }], payments: [] }, cashier.id);
    expect(edited).toMatchObject({ total_ttc: 8_000, change_given: 2_000, replaces_id: first.id });
    expect(s.pos.getSale(first.id)).toMatchObject({ status: 'cancelled', cancel_reason: `Facture modifiée : remplacée par ${edited.number}` });
    expect([qty('RIZ'), qty('HUILE')]).toEqual([19, 18]);
    const z = s.pos.zReport(s.pos.getSale(edited.id).session_id);
    expect(z.salesTtc).toBe(8_000);
    expect(z.cash.cashSales).toBe(8_000);
    // Plus d'articles : la différence s'encaisse en plus de ce qui était payé.
    const again = s.pos.replaceSale(ctx, edited.id, { lines: [{ articleId: riz.id, qty: 3000 }], payments: [{ method: 'CASH', amount: 7_000 }] }, cashier.id);
    expect(again).toMatchObject({ total_ttc: 15_000, change_given: 0 });
    expect(() => s.pos.replaceSale(ctx, again.id, { lines: [{ articleId: riz.id, qty: 4000 }], payments: [] }, cashier.id)).toThrow(/entièrement réglé/);
  });

  it('refuse de baisser une facture payée par MoMo sous le montant déjà reçu', () => {
    const { s, ctx, riz, cashier } = setup();
    const sale = s.pos.completeSale(ctx, { lines: [{ articleId: riz.id, qty: 2000 }], payments: [{ method: 'MTN_MOMO', amount: 10_000, reference: 'MP1' }] });
    expect(() => s.pos.replaceSale(ctx, sale.id, { lines: [{ articleId: riz.id, qty: 1000 }], payments: [] }, cashier.id)).toThrow(/MoMo, carte ou banque/);
    expect(s.pos.getSale(sale.id).status).toBe('completed');
  });

  it('le caissier annule avec le droit ; « supprimer » masque la facture du registre', () => {
    const { s, ctx, riz, cashier, qty } = setup();
    const a = s.pos.completeSale(ctx, { lines: [{ articleId: riz.id, qty: 1000 }], payments: [{ method: 'CASH', amount: 5_000 }] });
    const b = s.pos.completeSale(ctx, { lines: [{ articleId: riz.id, qty: 1000 }], payments: [{ method: 'CASH', amount: 5_000 }] });
    expect(() => s.pos.voidSale(ctx, a.id, cashier.id, 'Erreur')).toThrow(/gérant/);
    s.pos.voidSale(ctx, a.id, cashier.id, 'Erreur de saisie', { byRight: true });
    s.pos.voidSale(ctx, b.id, cashier.id, 'Doublon', { byRight: true, hide: true });
    expect(qty('RIZ')).toBe(20);
    const period = { from: '2026-10-01', to: '2026-10-31' };
    expect(s.controls.salesRegister(ctx.storeId, period).rows.map((r) => r.number)).toEqual([a.number]);
    expect(s.controls.salesRegister(ctx.storeId, { ...period, status: 'cancelled' }).rows.map((r) => r.number).sort()).toEqual([a.number, b.number].sort());
  });

  it('journée clôturée : l’annulation passe par un avoir sur la caisse du jour', () => {
    const { s, ctx, riz, cashier, qty } = setup();
    const sale = s.pos.completeSale(ctx, { lines: [{ articleId: riz.id, qty: 1000 }], payments: [{ method: 'CASH', amount: 5_000 }] });
    s.pos.closeSession(ctx, { 5000: 1 } as never);
    s.pos.openSession(ctx, 0);
    expect(() => s.pos.editableSale(sale.id)).toThrow(/clôturée/);
    const avoir = s.pos.voidSale(ctx, sale.id, cashier.id, 'Client parti', { byRight: true });
    expect(avoir).toMatchObject({ kind: 'return', total_ttc: -5_000, original_sale_id: sale.id });
    expect(s.pos.getSale(sale.id).status).toBe('completed');
    expect(qty('RIZ')).toBe(20);
  });
});
