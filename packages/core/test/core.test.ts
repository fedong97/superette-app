import { describe, expect, it } from 'vitest';
import {
  allocateFefo,
  closingDifference,
  computeTotals,
  eanCheckDigit,
  expiryAlert,
  formatFcfa,
  internalEan13,
  isValidEan,
  normalizeBarcode,
  parseScaleBarcode,
  settle,
  splitTtc,
  stockLevel,
  weightedAverageCost,
} from '../src';

describe('montants et TVA', () => {
  it('formate les FCFA avec séparateur de milliers', () => {
    expect(formatFcfa(1250000)).toBe('1 250 000 FCFA');
    expect(formatFcfa(-500, false)).toBe('-500');
  });

  it('décompose un TTC à 19,25 %', () => {
    expect(splitTtc(1193, 1925)).toEqual({ ht: 1000, tva: 193 });
    expect(splitTtc(500, 0)).toEqual({ ht: 500, tva: 0 });
  });
});

describe('codes-barres', () => {
  it('vérifie la clé EAN-13 et EAN-8', () => {
    expect(isValidEan('3017620422003')).toBe(true);
    expect(isValidEan('3017620422004')).toBe(false);
    expect(isValidEan('96385074')).toBe(true);
  });

  it('convertit un UPC-A en EAN-13', () => {
    expect(normalizeBarcode(' 036000291452 ')).toBe('0036000291452');
  });

  it('génère des codes internes valides en préfixe 20', () => {
    const code = internalEan13(42);
    expect(code).toMatch(/^20\d{11}$/);
    expect(isValidEan(code)).toBe(true);
  });

  it('lit une étiquette balance à prix intégré', () => {
    const body = '21' + '00123' + '01450';
    const code = body + eanCheckDigit(body);
    expect(parseScaleBarcode(code, { prefixes: ['21'], valueType: 'price' })).toEqual({
      plu: '00123',
      value: 1450,
      valueType: 'price',
    });
    expect(parseScaleBarcode(code, { prefixes: ['22'], valueType: 'price' })).toBeNull();
  });
});

describe('ticket', () => {
  it('totalise par taux de TVA, remises et articles au poids', () => {
    const totals = computeTotals([
      { articleId: 'a', label: 'Riz 5 kg', unitPrice: 4500, qty: 2000, vatRate: 0, discount: 0 },
      { articleId: 'b', label: 'Bière', unitPrice: 650, qty: 6000, vatRate: 1925, discount: 300 },
      { articleId: 'c', label: 'Tomates', unitPrice: 800, qty: 1250, vatRate: 0, discount: 0 },
    ]);
    expect(totals.totalTtc).toBe(9000 + 3600 + 1000);
    expect(totals.totalDiscount).toBe(300);
    expect(totals.itemCount).toBe(2 + 6 + 1);
    expect(totals.vat).toEqual([
      { rate: 1925, ttc: 3600, ht: 3019, tva: 581 },
      { rate: 0, ttc: 10000, ht: 10000, tva: 0 },
    ]);
    expect(totals.totalHt + totals.totalTva).toBe(totals.totalTtc);
  });
});

describe('règlement', () => {
  it('rend la monnaie sur les espèces avec paiement mixte', () => {
    expect(
      settle(12500, [
        { method: 'MTN_MOMO', amount: 5000, reference: 'MP123' },
        { method: 'CASH', amount: 10000 },
      ]),
    ).toEqual({ paid: 15000, remaining: 0, change: 2500, complete: true });
  });

  it('refuse un mobile money supérieur au ticket', () => {
    expect(() => settle(1000, [{ method: 'ORANGE_MONEY', amount: 2000 }])).toThrow();
  });

  it('signale un reste dû', () => {
    expect(settle(1000, [{ method: 'CASH', amount: 400 }]).remaining).toBe(600);
  });
});

describe('stock', () => {
  it('calcule le CMUP', () => {
    expect(weightedAverageCost(10000, 100, 10000, 200)).toBe(150);
    expect(weightedAverageCost(-2000, 100, 5000, 180)).toBe(180);
  });

  it('sort les lots en FEFO et signale le reliquat', () => {
    const lots = [
      { id: 'sans-date', qty: 5000, expiry: null, receivedAt: '2026-01-01' },
      { id: 'tard', qty: 3000, expiry: '2026-12-01', receivedAt: '2026-09-01' },
      { id: 'tot', qty: 2000, expiry: '2026-10-10', receivedAt: '2026-09-15' },
    ];
    expect(allocateFefo(lots, 4000)).toEqual({
      allocations: [
        { lotId: 'tot', qty: 2000 },
        { lotId: 'tard', qty: 2000 },
      ],
      unallocated: 0,
    });
    expect(allocateFefo(lots, 12000).unallocated).toBe(2000);
  });

  it('classe le niveau de stock', () => {
    expect(stockLevel(0, { alert: 5000, max: null })).toBe('rupture');
    expect(stockLevel(4000, { alert: 5000, max: null })).toBe('alerte');
    expect(stockLevel(60000, { alert: 5000, max: 50000 })).toBe('surstock');
  });

  it('alerte J-7, J-3, J-1 et périmé', () => {
    expect(expiryAlert('2026-10-13', '2026-10-06')).toBe('J-7');
    expect(expiryAlert('2026-10-09', '2026-10-06')).toBe('J-3');
    expect(expiryAlert('2026-10-07', '2026-10-06')).toBe('J-1');
    expect(expiryAlert('2026-10-05', '2026-10-06')).toBe('perime');
    expect(expiryAlert('2026-11-30', '2026-10-06')).toBeNull();
  });
});

describe('clôture Z', () => {
  it('compare le comptage par coupure au théorique', () => {
    const result = closingDifference(
      { openingFloat: 20000, cashSales: 153500, cashRefunds: 1500, cashIn: 0, cashOut: 100000 },
      { 10000: 5, 5000: 2, 1000: 1, 500: 1, 100: 4 },
    );
    expect(result).toEqual({ expected: 72000, counted: 61900, difference: -10100 });
  });
});
