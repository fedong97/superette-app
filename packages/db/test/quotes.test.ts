import { beforeEach, describe, expect, it } from 'vitest';
import { type Context, type Services, createServices, openDatabase } from '../src';

let now = new Date('2026-10-06T08:00:00Z');
const clock = () => now;
const advanceDays = (d: number) => {
  now = new Date(now.getTime() + d * 86_400_000);
};

let s: Services;
let ctx: Context;
let cashier: Context;
let riz: string;
let huile: string;
let restaurant: string;

beforeEach(() => {
  now = new Date('2026-10-06T08:00:00Z');
  s = createServices(openDatabase(':memory:'), clock);
  const { store, register, admin } = s.admin.bootstrap({ storeCode: 'DLA1', storeName: 'Superette Akwa', adminName: 'Steve', adminLogin: 'steve', adminPin: '1234' });
  ctx = { storeId: store.id, registerId: register.id, userId: admin.id };
  const awa = s.admin.createUser(admin.id, { name: 'Awa', login: 'awa', role: 'cashier', pin: '5678', storeId: store.id });
  cashier = { ...ctx, userId: awa.id };
  const tva = s.admin.listVatRates().find((r) => r.rate_bp === 1925)!.id;
  riz = s.catalogue.saveArticle(admin.id, { name: 'Riz 5 kg', unit: 'piece', vatRateId: tva, purchasePrice: 3_000, salePrice: 5_000 }).id;
  huile = s.catalogue.saveArticle(admin.id, { name: 'Huile 1 L', unit: 'piece', vatRateId: tva, purchasePrice: 1_100, salePrice: 1_500 }).id;
  s.stock.receive(ctx, { warehouseId: s.admin.salesWarehouse(store.id).id, lines: [riz, huile].map((articleId) => ({ articleId, qty: 200_000, unitCost: 1_000 })) });
  restaurant = s.customers.saveCustomer(admin.id, { name: 'Restaurant Chez Mballa', creditLimit: 500_000 }).id;
  s.pos.openSession(ctx, 0);
});

describe('devis et proformas', () => {
  it('chiffre un devis, le remise avec accord du gérant et garde ses prix jusqu’à la fin de validité', () => {
    expect(() => s.quotes.save(ctx, { kind: 'quote', lines: [{ articleId: riz, qty: 1000 }] })).toThrow('client');
    expect(() => s.quotes.save(cashier, { kind: 'quote', customerName: 'Hôtel', lines: [{ articleId: riz, qty: 10_000, discount: 2_000 }] })).toThrow('gérant');

    const q = s.quotes.save(ctx, {
      kind: 'proforma',
      customerId: restaurant,
      validDays: 10,
      notes: 'Livraison comprise',
      lines: [
        { articleId: riz, qty: 20_000, discount: 5_000 },
        { articleId: huile, qty: 12_000 },
      ],
    });
    expect(q).toMatchObject({ number: 'PF-DLA11-00001', state: 'open', valid_until: '2026-10-16', total_ttc: 113_000, total_discount: 5_000, customer_name: 'Restaurant Chez Mballa' });
    expect(q.total_ht + q.total_tva).toBe(113_000);
    expect(s.quotes.save(cashier, { kind: 'quote', customerName: 'M. Etoundi', lines: [{ articleId: huile, qty: 2000 }] }).number).toBe('DV-DLA11-00001');

    // Le riz augmente : le devis garde son prix.
    s.catalogue.setStorePrice(ctx.userId, riz, ctx.storeId, 5_500);
    const lines = s.quotes.saleLines(ctx.storeId, q.id);
    expect(lines).toEqual([
      { articleId: riz, qty: 20_000, discount: 15_000 },
      { articleId: huile, qty: 12_000, discount: 0 },
    ]);

    // Le caissier facture à crédit au prix du devis sans code gérant ; une remise en plus en demanderait un.
    expect(() =>
      s.pos.completeSale(cashier, { lines: lines.map((l, i) => (i === 1 ? { ...l, discount: 500 } : l)), payments: [{ method: 'CUSTOMER_CREDIT', amount: 112_500 }], customerId: restaurant, quoteId: q.id }),
    ).toThrow('gérant');
    const sale = s.pos.completeSale(cashier, { lines, payments: [{ method: 'CUSTOMER_CREDIT', amount: 113_000 }], customerId: restaurant, quoteId: q.id });
    expect(sale.total_ttc).toBe(113_000);
    expect(s.quotes.get(q.id)).toMatchObject({ state: 'accepted', sale_number: sale.number });
    expect(() => s.quotes.saleLines(ctx.storeId, q.id)).toThrow('déjà été facturé');
    expect(() => s.quotes.save(ctx, { kind: 'proforma', customerId: restaurant, lines: [{ articleId: riz, qty: 1000 }] }, { id: q.id })).toThrow('clôturé');
  });

  it('un devis expiré ne se facture plus ; un devis ouvert se modifie ou s’annule', () => {
    const q = s.quotes.save(ctx, { kind: 'quote', customerName: 'Boutique Yassa', validDays: 3, lines: [{ articleId: riz, qty: 5000 }] });
    const updated = s.quotes.save(ctx, { kind: 'quote', customerName: 'Boutique Yassa', validDays: 3, lines: [{ articleId: riz, qty: 6000 }, { articleId: huile, qty: 6000 }] }, { id: q.id });
    expect(updated).toMatchObject({ number: q.number, total_ttc: 39_000 });
    expect(updated.lines).toHaveLength(2);
    advanceDays(4);
    expect(s.quotes.get(q.id).state).toBe('expired');
    expect(s.quotes.list(ctx.storeId, { state: 'expired' }).map((x) => x.number)).toEqual([q.number]);
    expect(() => s.quotes.saleLines(ctx.storeId, q.id)).toThrow('expiré');

    const other = s.quotes.save(ctx, { kind: 'quote', customerName: 'Boutique Yassa', lines: [{ articleId: huile, qty: 1000 }] });
    s.quotes.cancel(ctx, other.id);
    expect(s.quotes.get(other.id).state).toBe('cancelled');
    expect(s.quotes.list(ctx.storeId, { search: 'yassa' })).toHaveLength(2);
  });
});
