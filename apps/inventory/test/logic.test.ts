import { describe, expect, it } from 'vitest';
import {
  type Article,
  buildIndex,
  cartTotals,
  csvRows,
  exportCountFile,
  fileArticle,
  formatQty,
  guestCode,
  levels,
  lineGross,
  lineStep,
  lookup,
  normalizeUrl,
  parseCountFile,
  parseDiscount,
  parsePairing,
  partsToDetail,
  partsToQty,
  phoneTotal,
  placeKey,
  recapCsv,
  search,
  tariff,
} from '../src/logic';

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
    // QR d'un aide sans compte : relie le téléphone et connecte l'aide.
    expect(parsePairing('FEDONIX360:{"u":["http://192.168.1.10:3000"],"g":"042917"}')).toEqual({ urls: ['http://192.168.1.10:3000'], code: '', guest: '042917' });
    expect(parsePairing('FEDONIX360:{"u":["http://192.168.1.10:3000"],"g":"12"}')).toBeNull();
    expect(guestCode('042 917')).toBe('042917');
    expect(guestCode('ABCD2345')).toBeNull();
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

  it('ouvre la fiche à remplir du PC (CSV ou Excel) avec ses conditionnements', () => {
    const rows = csvRows(
      [
        'Inventaire n° 12 · Magasin · fiche de comptage à remplir puis à réimporter (bouton Importer)',
        'Code;Produit;Rayon;Conditionnement;Compté (conditionnements);Compté (unités)',
        '20010;Mutzig 50 cl;Boissons;CARTON de 24;;',
        '"30001";"Savon ""Lux"" 100 g";Hygiène;;;3',
        '30002;Biscuit;;PAQUET de 12;2;1',
      ].join('\r\n'),
    );
    const f = parseCountFile(rows);
    expect(f.format).toBe('pc');
    expect(f.title).toContain('Inventaire n° 12');
    expect(f.lines).toEqual([
      { code: '20010', name: 'Mutzig 50 cl', pack: 'CARTON de 24', department: 'Boissons', qty: null },
      { code: '30001', name: 'Savon "Lux" 100 g', pack: null, department: 'Hygiène', qty: 3000 },
      { code: '30002', name: 'Biscuit', pack: 'PAQUET de 12', department: null, qty: 25_000 },
    ]);
    const index = buildIndex([mutzig]);
    // Article connu du téléphone : celui du catalogue ; sinon un article de la fiche.
    expect(fileArticle(f.lines[0]!, index).id).toBe('mutzig');
    expect(fileArticle(f.lines[2]!, index)).toMatchObject({ id: 'f:30002', packs: [{ name: 'PAQUET', units: 12_000 }] });
  });

  it('ouvre un fichier texte « code;nom (conditionnement);quantité » et le rend rempli au même format', () => {
    const f = parseCountFile(csvRows('A12;HUILE MAYOR 1L (CARTON);0\nB7;SUCRE EN MORCEAUX;2,5\n'));
    expect(f.format).toBe('txt');
    expect(f.lines).toEqual([
      { code: 'A12', name: 'HUILE MAYOR 1L', pack: 'CARTON', department: null, qty: 0 },
      { code: 'B7', name: 'SUCRE EN MORCEAUX', pack: null, department: null, qty: 2500 },
    ]);
    const arts = f.lines.map((l) => fileArticle(l, new Map()));
    const out = exportCountFile('txt', arts, new Map([['f:A12', 14_000]]), (a) => f.lines.find((l) => l.code === a.code));
    expect(out).toBe('A12;HUILE MAYOR 1L (CARTON);14\r\nB7;SUCRE EN MORCEAUX;0');
  });

  it('exporte pour le bouton Importer du PC et partage le récapitulatif par endroit', () => {
    const pc = exportCountFile('pc', [mutzig, riz], new Map([['mutzig', 51_000]]), () => undefined);
    expect(pc).toBe('﻿Code;Produit;Rayon;Compté;Détail\r\n20010;Mutzig 50 cl;;51;2 CARTON + 3 (51)');
    const recap = recapCsv([
      { location: 'Réserve', article: mutzig, qty: 48_000 },
      { location: 'Rayon', article: mutzig, qty: 3_000 },
      { location: 'Rayon', article: riz, qty: 1_500 },
    ]);
    expect(recap.split('\r\n')).toEqual([
      '﻿Code;Produit;Endroit;Quantité;Détail;Total du produit',
      '20010;Mutzig 50 cl;Rayon;3;3;51',
      '20010;Mutzig 50 cl;Réserve;48;2 CARTON (48);51',
      '20011;Riz parfumé 25 kg;Rayon;1,5;1,5 kg;1,5',
    ]);
  });
});

describe('panier du vendeur au rayon', () => {
  const savon = art({ id: 's', price: 700, wholesale: 600, packs: [{ id: 'carton', name: 'Carton', units: 24_000, barcode: null, price: 15_000, wholesale: 14_000 }] });
  it('prend le prix du tarif, comme la caisse : le super gros retombe sur le gros, puis sur le détail', () => {
    expect(tariff(savon, 'retail')).toBe(700);
    expect(tariff(savon, 'wholesale')).toBe(600);
    expect(tariff(savon, 'super_wholesale')).toBe(600);
    expect(tariff(art({ price: 500 }), 'super_wholesale')).toBe(500);
  });
  it('vend le carton au prix du carton et avance d’un carton', () => {
    expect(lineGross(savon, { articleId: 's', qty: 3_000 }, 'retail')).toBe(2_100);
    expect(lineGross(savon, { articleId: 's', qty: 48_000, packId: 'carton' }, 'wholesale')).toBe(28_000);
    expect(lineStep(savon, { packId: 'carton' })).toBe(24_000);
    expect(lineStep(art({ unit: 'kg' }), {})).toBe(500);
  });
  it('compte les remises sans dépasser le prix de la ligne', () => {
    const t = cartTotals(
      [
        { article: savon, line: { articleId: 's', qty: 2_000, discount: 200 } },
        { article: savon, line: { articleId: 's', qty: 24_000, packId: 'carton', discount: 99_999 } },
      ],
      'retail',
    );
    expect(t).toEqual({ gross: 16_400, discount: 15_200, total: 1_200 });
  });
  it('lit une remise en FCFA ou en pourcentage', () => {
    expect(parseDiscount('', 1_000)).toBe(0);
    expect(parseDiscount('150', 1_000)).toBe(150);
    expect(parseDiscount('10 %', 1_400)).toBe(140);
    expect(parseDiscount('2,5%', 1_000)).toBe(25);
    expect(parseDiscount('1 500', 1_000)).toBeNull();
    expect(parseDiscount('abc', 1_000)).toBeNull();
  });
});
