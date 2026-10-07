import { describe, expect, it } from 'vitest';
import { xlsxFiles } from '@superette/core';
import { comparePeriod, createServices, openDatabase } from '../src';

function setup() {
  let now = new Date('2026-09-15T09:00:00Z');
  const s = createServices(openDatabase(':memory:'), () => now);
  const { store, register, admin } = s.admin.bootstrap({ storeCode: 'DLA1', storeName: 'Superette Akwa', adminName: 'Steve', adminLogin: 'steve', adminPin: '1234' });
  const ctx = { storeId: store.id, registerId: register.id, userId: admin.id };
  const tva = s.admin.listVatRates().find((r) => r.rate_bp === 1925)!.id;
  const boissons = s.catalogue.createDepartment('Boissons');
  const epicerie = s.catalogue.createDepartment('Épicerie');
  const fam = (d: { id: string }, n: string) => s.catalogue.createFamily(d.id, n).id;
  const coca = s.catalogue.saveArticle(admin.id, { name: 'Coca-Cola 50 cl', unit: 'piece', vatRateId: tva, purchasePrice: 300, salePrice: 500, familyId: fam(boissons, 'Sodas') });
  const riz = s.catalogue.saveArticle(admin.id, { name: 'Riz parfumé 5 kg', unit: 'piece', vatRateId: tva, purchasePrice: 3000, salePrice: 4200, familyId: fam(epicerie, 'Riz') });
  s.stock.receive(ctx, { warehouseId: s.admin.salesWarehouse(store.id).id, lines: [{ articleId: coca.id, qty: 500_000, unitCost: 300 }, { articleId: riz.id, qty: 100_000, unitCost: 3000 }] });
  s.pos.openSession(ctx, 0);
  const sell = (iso: string, lines: { articleId: string; qty: number }[], method: 'CASH' | 'MTN_MOMO' = 'CASH') => {
    now = new Date(iso);
    const priced = s.pos.priceLines(ctx.storeId, lines);
    const total = priced.reduce((t, l) => t + l.unitPrice * (l.qty / 1000), 0);
    // En espèces le client donne un peu plus : la monnaie rendue ne compte pas dans l'encaissement.
    return s.pos.completeSale(ctx, { lines, payments: [{ method, amount: method === 'CASH' ? total + 500 : total, reference: method === 'CASH' ? undefined : 'TX123' }] });
  };
  return { s, ctx, coca, riz, sell };
}

describe('rapports de ventes', () => {
  it('regroupe les ventes par rayon, article, heure et paiement avec marge et retours', () => {
    const { s, ctx, coca, riz, sell } = setup();
    // Septembre : 2 cocas. Octobre : 4 cocas et 2 riz, puis le retour d'un riz.
    sell('2026-09-10T10:00:00Z', [{ articleId: coca.id, qty: 2000 }]);
    sell('2026-10-01T08:15:00Z', [{ articleId: coca.id, qty: 4000 }], 'MTN_MOMO');
    const big = sell('2026-10-02T17:30:00Z', [{ articleId: riz.id, qty: 2000 }]);
    s.pos.returnSale(ctx, { originalSaleId: big.id, lines: [{ lineId: big.lines[0]!.id, qty: 1000 }], refundMethod: 'CASH', supervisorId: ctx.userId, reason: 'Sac percé' });

    const r = s.reports.sales(ctx.storeId, { from: '2026-10-01', to: '2026-10-31', dimension: 'department', compare: 'previous' });
    // CA : 2 000 + 8 400 − 4 200 = 6 200 ; coût : 1 200 + 6 000 − 3 000 (retour au coût d'origine).
    expect(r.totals).toMatchObject({ tickets: 2, revenueTtc: 6200, returnsTtc: -4200, cost: 4200, averageBasket: 5200 });
    expect(r.totals.margin).toBe(r.totals.revenueHt - 4200);
    expect(r.rows.map((x) => [x.label, x.tickets, x.revenueTtc, x.cost, x.returnsTtc, x.previousTtc])).toEqual([
      ['Épicerie', 1, 4200, 3000, -4200, 0],
      ['Boissons', 1, 2000, 1200, 0, 1000],
    ]);
    // Octobre se compare à septembre entier.
    expect(r.previous).toMatchObject({ from: '2026-09-01', to: '2026-09-30', totals: { tickets: 1, revenueTtc: 1000 } });

    const articles = s.reports.sales(ctx.storeId, { from: '2026-10-01', to: '2026-10-31', dimension: 'article' });
    expect(articles.rows.map((x) => [x.label, x.qty, x.unit])).toEqual([
      ['Riz parfumé 5 kg', 1000, 'piece'],
      ['Coca-Cola 50 cl', 4000, 'piece'],
    ]);
    const hours = s.reports.sales(ctx.storeId, { from: '2026-10-01', to: '2026-10-31', dimension: 'hour' });
    // Heure locale du poste (Africa/Douala en magasin).
    const h = (iso: string) => String(new Date(iso).getHours()).padStart(2, '0');
    expect(hours.rows.map((x) => x.label.slice(0, 2))).toEqual([h('2026-10-01T08:15:00Z'), h('2026-10-02T17:30:00Z')]);
    const pay = s.reports.sales(ctx.storeId, { from: '2026-10-01', to: '2026-10-31', dimension: 'payment' });
    expect(pay.rows.map((x) => [x.label, x.revenueTtc, x.returnsTtc])).toEqual([
      ['Espèces', 4200, -4200],
      ['MTN Mobile Money', 2000, 0],
    ]);
    const weekdays = s.reports.sales(ctx.storeId, { from: '2026-09-01', to: '2026-10-31', dimension: 'weekday' });
    expect(weekdays.rows.map((x) => x.label)).toEqual(['Jeudi', 'Vendredi']);
    expect(s.reports.vatByRate(ctx.storeId, '2026-10-01', '2026-10-31')).toEqual([{ rate_bp: 1925, ht: 5199, tva: 1001, ttc: 6200 }]);
    expect(() => s.reports.sales(ctx.storeId, { from: '2026-10-31', to: '2026-10-01', dimension: 'day' })).toThrow(/Période/);
  });

  it('produit un classeur Excel complet', () => {
    const { s, ctx, coca, sell } = setup();
    sell('2026-10-01T08:15:00Z', [{ articleId: coca.id, qty: 3000 }]);
    const sheets = s.reports.salesWorkbook(ctx.storeId, { from: '2026-10-01', to: '2026-10-07', dimension: 'article', compare: 'last_year' });
    expect(sheets.map((x) => x.name)).toEqual(['Synthèse', 'Article', 'Paiements', 'TVA', 'Lignes']);
    expect(sheets[0]!.title).toEqual(['Superette Akwa · Rapport des ventes', 'Du 01/10/2026 au 07/10/2026', 'Comparé au 01/10/2025 – 07/10/2025']);
    expect(sheets[1]!.rows[0]!.slice(0, 5)).toEqual([coca.code, 'Coca-Cola 50 cl', 1, 3, 1500]);
    expect(sheets[4]!.rows).toHaveLength(1);
    expect(xlsxFiles(sheets)).toHaveLength(10);
  });

  it('compare un mois entier au mois d’avant et une période libre à la même durée juste avant', () => {
    expect(comparePeriod('2026-03-01', '2026-03-31', 'previous')).toEqual({ from: '2026-02-01', to: '2026-02-28' });
    expect(comparePeriod('2026-10-01', '2026-10-07', 'previous')).toEqual({ from: '2026-09-24', to: '2026-09-30' });
    expect(comparePeriod('2028-02-29', '2028-02-29', 'last_year')).toEqual({ from: '2027-02-28', to: '2027-02-28' });
  });
});
