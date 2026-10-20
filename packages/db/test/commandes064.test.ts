import { describe, expect, it } from 'vitest';
import { createServices, openDatabase } from '../src';

function setup() {
  const s = createServices(openDatabase(':memory:'), () => new Date('2026-10-18T09:00:00Z'));
  const { store, register, admin } = s.admin.bootstrap({ storeCode: 'DLA1', storeName: 'Superette Akwa', adminName: 'Steve', adminLogin: 'steve', adminPin: '1234' });
  const ctx = { storeId: store.id, registerId: register.id, userId: admin.id };
  const tva = s.admin.listVatRates().find((r) => r.rate_bp === 1925)!.id;
  const castel = s.catalogue.saveArticle(admin.id, { name: 'CASTEL 65CL', unit: 'piece', vatRateId: tva, purchasePrice: 450, salePrice: 650 });
  const shop = s.admin.salesWarehouse(store.id);
  s.stock.receive(ctx, { warehouseId: shop.id, lines: [{ articleId: castel.id, qty: 10_000, unitCost: 450 }] });
  s.pos.openSession(ctx, 0);
  const client = s.customers.saveCustomer(ctx.userId, { name: 'Mme Ngo Bassa', phone: '699 11 22 33', address: 'Bonapriso, rue Njo-Njo' });
  return { s, ctx, castel, client };
}

describe('commandes clients', () => {
  it('prend une commande par WhatsApp, la prépare, réserve le stock puis la facture à la caisse avec sa livraison', () => {
    const { s, ctx, castel, client } = setup();
    const order = s.orders.save(ctx, { customerId: client.id, channel: 'whatsapp', deliveryFee: 1_000, slot: '14h–16h', lines: [{ articleId: castel.id, qty: 8_000 }] });
    expect([order.number, order.status, order.phone, order.address, order.total_ttc]).toEqual(['CC-DLA11-00001', 'new', '699 11 22 33', 'Bonapriso, rue Njo-Njo', 6_200]);
    expect(s.orders.confirmationText(order.id, 'Superette Akwa')).toContain('CC-DLA11-00001');

    // Préparée : 8 bouteilles sur 10 sont mises de côté, un client comptoir ne peut plus en acheter 3.
    s.orders.prepare(ctx, order.id);
    expect(s.orders.reserved(ctx.storeId).get(castel.id)).toBe(8_000);
    expect(() => s.pos.completeSale(ctx, { lines: [{ articleId: castel.id, qty: 3_000 }], payments: [{ method: 'CASH', amount: 1_950 }] })).toThrow(/Stock réservé pour CASTEL 65CL/);
    s.pos.completeSale(ctx, { lines: [{ articleId: castel.id, qty: 2_000 }], payments: [{ method: 'CASH', amount: 1_300 }] });

    // À la livraison : la commande chargée à la caisse peut prendre sa marchandise réservée.
    const load = s.orders.saleLines(ctx.storeId, order.id);
    expect(load.delivery).toMatchObject({ address: 'Bonapriso, rue Njo-Njo', fee: 1_000, slot: '14h–16h' });
    const sale = s.pos.completeSale(ctx, {
      lines: load.lines,
      payments: [{ method: 'CASH', amount: 6_200 }],
      customerId: load.customerId,
      delivery: load.delivery,
      orderId: order.id,
    });
    expect(sale.total_ttc).toBe(6_200);
    const done = s.orders.get(order.id);
    expect([done.status, done.sale_number]).toEqual(['invoiced', sale.number]);
    expect(s.orders.reserved(ctx.storeId).size).toBe(0);
    expect(s.deliveries.forSale(sale.id)?.address).toBe('Bonapriso, rue Njo-Njo');
    expect(() => s.orders.saleLines(ctx.storeId, order.id)).toThrow(/déjà été facturée/);
    expect(() => s.orders.cancel(ctx, order.id, 'erreur')).toThrow(/clôturée/);
  });

  it('modifier une commande préparée la remet à préparer ; annuler demande un motif et libère le stock', () => {
    const { s, ctx, castel } = setup();
    expect(() => s.orders.save(ctx, { customerName: 'Paul', lines: [{ articleId: castel.id, qty: 1_000 }] })).toThrow(/téléphone/);
    expect(() => s.orders.save(ctx, { customerName: 'Paul', phone: '677', deliveryFee: 500, lines: [{ articleId: castel.id, qty: 1_000 }] })).toThrow(/adresse/);
    const o = s.orders.save(ctx, { customerName: 'Paul', phone: '677 00 00 00', lines: [{ articleId: castel.id, qty: 1_000 }] });
    expect(o.address).toBeNull();
    s.orders.prepare(ctx, o.id);
    const edited = s.orders.save(ctx, { customerName: 'Paul', phone: '677 00 00 00', lines: [{ articleId: castel.id, qty: 2_000 }] }, o.id);
    expect([edited.status, edited.total_ttc]).toEqual(['new', 1_300]);
    expect(s.orders.list(ctx.storeId, { status: 'open' }).map((x) => x.number)).toEqual([o.number]);
    s.orders.prepare(ctx, o.id);
    expect(() => s.orders.cancel(ctx, o.id, ' ')).toThrow(/motif/);
    s.orders.cancel(ctx, o.id, 'Client injoignable');
    expect(s.orders.reserved(ctx.storeId).size).toBe(0);
    expect(s.orders.list(ctx.storeId, { status: 'open' })).toEqual([]);
  });
});
