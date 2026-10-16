import { DEFAULT_REMINDER_TEMPLATE, reminderMessage, whatsappLink, whatsappNumber } from '@superette/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { type Context, type Services, createServices, openDatabase } from '../src';

describe('relances (règles)', () => {
  it('met le numéro au format international', () => {
    expect(whatsappNumber('677 00 11 22')).toBe('237677001122');
    expect(whatsappNumber('+237 6 77 00 11 22')).toBe('237677001122');
    expect(whatsappNumber('00237677001122')).toBe('237677001122');
    expect(whatsappNumber('1234')).toBeNull();
    expect(whatsappLink(null, 'x')).toBeNull();
    expect(whatsappLink('677001122', 'Bonjour à vous')).toBe('https://wa.me/237677001122?text=Bonjour%20%C3%A0%20vous');
  });

  it('remplit le modèle avec le client, les montants et les factures', () => {
    const text = reminderMessage('', {
      customer: 'Chez Mballa',
      store: 'Superette Akwa',
      storePhone: '233 00 00 00',
      balance: 45_000,
      overdue: 30_000,
      items: [
        { number: 'T-12', date: '2026-09-01T10:00:00Z', dueDate: '2026-09-16', remaining: 30_000, daysLate: 30 },
        { number: 'T-40', date: '2026-10-10T10:00:00Z', dueDate: '2026-10-25', remaining: 15_000, daysLate: 0 },
      ],
    });
    expect(text).toContain('Bonjour Chez Mballa');
    expect(text).toMatch(/solde de 45.000 FCFA/);
    expect(text).toContain('Facture T-12 du 01/09/2026');
    expect(text).toContain('échue depuis 30 j');
    expect(text).toContain('à régler avant le 25/10/2026');
    expect(text).not.toContain('{');
    expect(reminderMessage('Salut {client}, {inconnu}', { customer: 'A', store: 'B', storePhone: null, balance: 0, overdue: 0, items: [] })).toBe('Salut A, {inconnu}');
    expect(DEFAULT_REMINDER_TEMPLATE).toContain('{factures}');
  });
});

describe('relances des clients', () => {
  let s: Services;
  let ctx: Context;
  let now = new Date('2026-09-01T08:00:00Z');

  beforeEach(() => {
    now = new Date('2026-09-01T08:00:00Z');
    s = createServices(openDatabase(':memory:'), () => now);
    const { store, register, admin } = s.admin.bootstrap({ storeCode: 'DLA1', storeName: 'Superette Akwa', adminName: 'Steve', adminLogin: 'steve', adminPin: '1234' });
    ctx = { storeId: store.id, registerId: register.id, userId: admin.id };
  });

  it('garde chaque relance avec les montants du moment et la montre dans la balance âgée', () => {
    const tva = s.admin.listVatRates()[0]!.id;
    const articleId = s.catalogue.saveArticle(ctx.userId, { name: 'Riz', unit: 'piece', vatRateId: tva, purchasePrice: 3_000, salePrice: 5_000 }).id;
    s.stock.receive(ctx, { warehouseId: s.admin.salesWarehouse(ctx.storeId).id, lines: [{ articleId, qty: 100_000, unitCost: 3_000 }] });
    const c = s.customers.saveCustomer(ctx.userId, { name: 'Chez Mballa', phone: '677 00 11 22', creditLimit: 100_000, paymentTermsDays: 15 });
    s.pos.openSession(ctx, 0);
    s.pos.completeSale(ctx, { lines: [{ articleId, qty: 6_000 }], payments: [{ method: 'CUSTOMER_CREDIT', amount: 30_000 }], customerId: c.id });
    now = new Date('2026-10-16T08:00:00Z');
    const d = s.customers.reminderData(ctx.storeId, c.id);
    expect(d).toMatchObject({ balance: 30_000, overdue: 30_000, last: null });
    const r = s.customers.recordReminder(ctx, c.id, 'whatsapp');
    expect(r).toMatchObject({ channel: 'whatsapp', balance: 30_000, overdue: 30_000, user_name: 'Steve', count: 1 });
    now = new Date('2026-10-20T08:00:00Z');
    s.customers.recordReminder(ctx, c.id, 'pdf');
    const row = s.customers.receivables(ctx.storeId).customers.find((x) => x.id === c.id)!;
    expect(row.last_reminder).toMatchObject({ channel: 'pdf', count: 2 });
    expect(s.sync.pending(500).filter((e) => e.entity === 'customer_reminder')).toHaveLength(2);
  });
});
