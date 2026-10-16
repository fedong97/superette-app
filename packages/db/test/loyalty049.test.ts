import { earnedPoints, maxRedeemable, pointsForAmount } from '@superette/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { type Context, type Services, createServices, openDatabase } from '../src';

let s: Services;
let ctx: Context;
let articleId: string;
let customerId: string;

const RULES = { spendPerPoint: 1000, pointValue: 10, minRedeem: 100 };

function setup(enabled = true) {
  const now = new Date('2026-10-16T08:00:00Z');
  s = createServices(openDatabase(':memory:'), () => now);
  const { store, register, admin } = s.admin.bootstrap({ storeCode: 'DLA1', storeName: 'Superette Akwa', adminName: 'Steve', adminLogin: 'steve', adminPin: '1234' });
  ctx = { storeId: store.id, registerId: register.id, userId: admin.id };
  const tva = s.admin.listVatRates().find((r) => r.rate_bp === 0)?.id ?? s.admin.listVatRates()[0]!.id;
  articleId = s.catalogue.saveArticle(admin.id, { name: 'Riz 5 kg', unit: 'piece', vatRateId: tva, purchasePrice: 3_000, salePrice: 5_000 }).id;
  s.stock.receive(ctx, { warehouseId: s.admin.salesWarehouse(store.id).id, lines: [{ articleId, qty: 500_000, unitCost: 3_000 }] });
  customerId = s.customers.saveCustomer(admin.id, { name: 'Mme Ngo', phone: '699 11 22 33' }).id;
  if (enabled) s.admin.saveStoreSettings(admin.id, store.id, { loyaltyEnabled: true });
  s.pos.openSession(ctx, 10_000);
}

const sell = (qty: number, payments: { method: 'CASH' | 'LOYALTY' | 'CUSTOMER_CREDIT'; amount: number }[], customer: string | null = customerId) =>
  s.pos.completeSale(ctx, { lines: [{ articleId, qty: qty * 1000 }], payments, customerId: customer });

describe('fidélité (règles)', () => {
  it('compte les points, leur valeur et le maximum payable', () => {
    expect(earnedPoints(25_900, RULES)).toBe(25);
    expect(earnedPoints(999, RULES)).toBe(0);
    expect(pointsForAmount(1_500, RULES)).toBe(150);
    expect(() => pointsForAmount(1_505, RULES)).toThrow(/multiple de 10/);
    expect(maxRedeemable(250, 1_200, RULES)).toBe(1_200);
    expect(maxRedeemable(250, 5_000, RULES)).toBe(2_500);
    expect(maxRedeemable(99, 5_000, RULES)).toBe(0);
  });
});

describe('carte de fidélité', () => {
  beforeEach(() => setup());

  it('donne les points d’un achat au client, pas au client comptoir', () => {
    sell(5, [{ method: 'CASH', amount: 25_000 }]);
    expect(s.loyalty.balance(customerId)).toBe(25);
    sell(5, [{ method: 'CASH', amount: 25_000 }], null);
    expect(s.loyalty.history(customerId)).toHaveLength(1);
  });

  it('paie avec les points : solde, minimum, multiple et compta en remise accordée (7019)', () => {
    sell(30, [{ method: 'CASH', amount: 150_000 }]);
    expect(s.loyalty.balance(customerId)).toBe(150);
    expect(() => sell(1, [{ method: 'LOYALTY', amount: 2_000 }, { method: 'CASH', amount: 3_000 }])).toThrow(/insuffisants/);
    expect(() => sell(1, [{ method: 'LOYALTY', amount: 1_005 }, { method: 'CASH', amount: 3_995 }])).toThrow(/multiple/);
    expect(() => sell(1, [{ method: 'LOYALTY', amount: 1_000 }, { method: 'CASH', amount: 4_000 }], null)).toThrow(/client/);
    const sale = sell(1, [{ method: 'LOYALTY', amount: 1_000 }, { method: 'CASH', amount: 4_000 }]);
    // 150 − 100 dépensés + 4 gagnés sur les 4 000 payés en espèces.
    expect(s.loyalty.balance(customerId)).toBe(54);
    expect(() => sell(1, [{ method: 'LOYALTY', amount: 500 }, { method: 'CASH', amount: 4_500 }])).toThrow(/au moins 100 points/);
    const ve = s.accounting.entries(ctx.storeId, { journal: 'VE' });
    const lines = ve.flatMap((e) => e.lines);
    expect(lines.find((l) => l.account === '7019')?.debit).toBe(1_000);
    expect(sale.payments.find((p) => p.method === 'LOYALTY')?.amount).toBe(1_000);
  });

  it('annulation : rend les points dépensés et retire les points gagnés', () => {
    sell(30, [{ method: 'CASH', amount: 150_000 }]);
    const sale = sell(2, [{ method: 'LOYALTY', amount: 1_000 }, { method: 'CASH', amount: 9_000 }]);
    expect(s.loyalty.balance(customerId)).toBe(59);
    s.pos.cancelSale(ctx, sale.id, ctx.userId, 'erreur');
    expect(s.loyalty.balance(customerId)).toBe(150);
  });

  it('retour : retire les points au prorata, et rend en points si on rembourse en points', () => {
    const sale = sell(10, [{ method: 'CASH', amount: 50_000 }]);
    expect(s.loyalty.balance(customerId)).toBe(50);
    s.pos.returnSale(ctx, { originalSaleId: sale.id, lines: [{ lineId: sale.lines[0]!.id, qty: 4_000 }], refundMethod: 'CASH', supervisorId: ctx.userId, reason: 'abîmé' });
    expect(s.loyalty.balance(customerId)).toBe(30);
    s.pos.returnSale(ctx, { originalSaleId: sale.id, lines: [{ lineId: sale.lines[0]!.id, qty: 1_000 }], refundMethod: 'LOYALTY', supervisorId: ctx.userId, reason: 'abîmé' });
    // −5 points gagnés sur ce riz, +500 points pour les 5 000 FCFA rendus.
    expect(s.loyalty.balance(customerId)).toBe(525);
  });

  it('correction à la main avec motif, jamais sous zéro', () => {
    expect(() => s.loyalty.adjust(ctx, customerId, 20, '')).toThrow(/motif/);
    expect(s.loyalty.adjust(ctx, customerId, 20, 'Carte remplacée')).toBe(20);
    expect(() => s.loyalty.adjust(ctx, customerId, -21, 'Erreur')).toThrow(/négatif/);
    expect(s.loyalty.history(customerId)[0]).toMatchObject({ kind: 'adjust', points: 20, reason: 'Carte remplacée', user_name: 'Steve' });
  });

  it('les mouvements partent au serveur sans magasin (communs à tous les magasins)', () => {
    sell(2, [{ method: 'CASH', amount: 10_000 }]);
    const out = s.sync.pending(500).filter((e) => e.entity === 'loyalty_move');
    expect(out).toHaveLength(1);
    expect(out[0]!.storeId).toBeNull();
    expect(out[0]!.payload).toMatchObject({ customer_id: customerId, points: 10, kind: 'earn' });
  });
});

describe('carte de fidélité désactivée', () => {
  beforeEach(() => setup(false));

  it('ne donne pas de points et refuse le paiement en points', () => {
    sell(5, [{ method: 'CASH', amount: 25_000 }]);
    expect(s.loyalty.balance(customerId)).toBe(0);
    expect(() => sell(1, [{ method: 'LOYALTY', amount: 1_000 }, { method: 'CASH', amount: 4_000 }])).toThrow(/pas activée/);
  });
});

describe('carte scannée à la caisse', () => {
  beforeEach(() => setup());

  it('retrouve le client par son code ou son téléphone', () => {
    const code = s.customers.getCustomer(customerId).code;
    expect(s.customers.findByCard(code.toLowerCase())?.id).toBe(customerId);
    expect(s.customers.findByCard('699112233')?.id).toBe(customerId);
    expect(s.customers.findByCard('+237 699 11 22 33')?.id).toBe(customerId);
    expect(s.customers.findByCard('6991')).toBeNull();
    expect(s.customers.findByCard('riz')).toBeNull();
  });
});

describe('ticket du client fidèle', () => {
  beforeEach(() => setup());

  it('imprime les points utilisés, gagnés et le solde', () => {
    sell(30, [{ method: 'CASH', amount: 150_000 }]);
    const sale = sell(1, [{ method: 'LOYALTY', amount: 1_000 }, { method: 'CASH', amount: 4_000 }]);
    const text = JSON.stringify(s.receipts.ticket(sale.id));
    expect(text).toContain('Points utilisés');
    expect(text).toContain('-100');
    expect(text).toContain('Points gagnés');
    expect(text).toContain('Vos points fidélité');
    expect(text).toContain('Points fidélité');
  });
});
