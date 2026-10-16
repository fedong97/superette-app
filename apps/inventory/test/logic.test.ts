import { describe, expect, it } from 'vitest';
import { type Article, buildIndex, formatQty, levels, lookup, normalizeUrl, parsePairing, partsToDetail, partsToQty, phoneTotal, placeKey, search } from '../src/logic';

const art = (over: Partial<Article>): Article => ({
  id: 'a',
  code: '20001',
  name: 'Article',
  unit: 'piece',
  unitName: null,
  otherRef: null,
  departmentId: null,
  barcodes: [],
  packs: [],
  thumb: null,
  ...over,
});

const mutzig = art({
  id: 'mutzig',
  code: '20010',
  name: 'Mutzig 50 cl',
  unitName: 'CANETTE',
  barcodes: [{ code: '6001234567899', packQty: 1000 }],
  packs: [{ name: 'CARTON', units: 24_000, barcode: '16001234567896' }],
});
const riz = art({ id: 'riz', code: '20011', name: 'Riz parfumé 25 kg', unit: 'kg', otherRef: 'RZ25' });
const eau = art({ id: 'eau', code: '20012', name: 'Eau Tangui 1,5 L', barcodes: [{ code: '0123456789012', packQty: 6000 }] });

describe('application d’inventaire', () => {
  it('lit le QR code du gérant et les adresses tapées à la main', () => {
    expect(parsePairing('FEDONIX360:{"u":["http://192.168.1.10:3000"],"c":"ABCD2345"}')).toEqual({ urls: ['http://192.168.1.10:3000'], code: 'ABCD2345' });
    expect(parsePairing('https://exemple.cm')).toBeNull();
    expect(parsePairing('FEDONIX360:{"u":[],"c":"X"}')).toBeNull();
    expect(normalizeUrl('192.168.1.10')).toBe('http://192.168.1.10:3000');
    expect(normalizeUrl('192.168.1.10:8080/')).toBe('http://192.168.1.10:8080');
    expect(normalizeUrl('https://fedonix.exemple.cm')).toBe('https://fedonix.exemple.cm');
    expect(normalizeUrl('')).toBeNull();
  });

  it('reconnaît le code de l’unité, du carton, le code article et l’autre référence', () => {
    const index = buildIndex([mutzig, riz, eau]);
    expect(lookup(index, '6001234567899')).toMatchObject({ article: { id: 'mutzig' }, level: 1, qty: 1000 });
    expect(lookup(index, '16001234567896')).toMatchObject({ article: { id: 'mutzig' }, level: 0, qty: 24_000 });
    expect(lookup(index, '20011')).toMatchObject({ article: { id: 'riz' }, level: 0 });
    expect(lookup(index, 'RZ25')).toMatchObject({ article: { id: 'riz' } });
    // Code-barres d'un lot de 6 sans conditionnement : 6 pièces par scan.
    expect(lookup(index, '0123456789012')).toMatchObject({ article: { id: 'eau' }, qty: 6000 });
    // UPC-A lu avec ou sans le zéro de tête.
    expect(lookup(index, '123456789012')).toMatchObject({ article: { id: 'eau' } });
    expect(lookup(index, '999')).toBeNull();
  });

  it('cherche par mots du nom, sans accents, ou par début de code', () => {
    expect(search([mutzig, riz, eau], 'riz parf').map((a) => a.id)).toEqual(['riz']);
    expect(search([mutzig, riz, eau], 'PARFUME').map((a) => a.id)).toEqual(['riz']);
    expect(search([mutzig, riz, eau], '2001').map((a) => a.id)).toEqual(['mutzig', 'riz', 'eau']);
    expect(search([mutzig, riz, eau], '')).toEqual([]);
  });

  it('calcule la quantité en cartons et unités, et l’affiche', () => {
    const lv = levels(mutzig);
    expect(lv).toEqual([
      { name: 'CARTON', units: 24_000 },
      { name: 'CANETTE', units: 1000 },
    ]);
    expect(partsToQty(lv, ['2', '3'])).toBe(51_000);
    expect(partsToQty(lv, ['', '7'])).toBe(7_000);
    expect(partsToQty(lv, ['x', '1'])).toBeNull();
    expect(partsToDetail(lv, ['2', '3'])).toEqual([2, 3]);
    expect(partsToQty(levels(riz), ['1,5'])).toBe(1_500);
    expect(partsToDetail(levels(riz), ['1,5'])).toBeNull();
    expect(formatQty(51_000, mutzig)).toBe('2 CARTON + 3 (51)');
    expect(formatQty(48_000, mutzig)).toBe('2 CARTON (48)');
    expect(formatQty(5_000, mutzig)).toBe('5');
    expect(formatQty(1_500, riz)).toBe('1,5 kg');
  });

  it('additionne les endroits d’un produit sur le téléphone', () => {
    const counts = {
      [placeKey('inv', 'mutzig', 'Rayon')]: { qty: 5_000, detail: null, at: '' },
      [placeKey('inv', 'mutzig', 'Réserve')]: { qty: 48_000, detail: null, at: '' },
      [placeKey('inv', 'riz', 'Rayon')]: { qty: 1_000, detail: null, at: '' },
    };
    expect(phoneTotal(counts, 'inv', 'mutzig')).toEqual({
      total: 53_000,
      places: [
        { location: 'Rayon', qty: 5_000 },
        { location: 'Réserve', qty: 48_000 },
      ],
    });
  });
});
