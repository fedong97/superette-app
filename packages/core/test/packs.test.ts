import { describe, expect, it } from 'vitest';
import { checkPacks, describeInPacks, lineTotal, packUnits, tariffPrice } from '../src';

describe('conditionnements', () => {
  it('calcule les unités contenues de proche en proche et décrit une quantité', () => {
    const levels = [
      { name: 'Carton', contains: 10 },
      { name: 'Paquet', contains: 10 },
    ];
    expect(packUnits(levels)).toEqual([100_000, 10_000]);
    const packs = levels.map((l, i) => ({ name: l.name, units: packUnits(levels)[i]! }));
    expect(describeInPacks(234_000, packs, 'Ampoule')).toBe('2 Carton 3 Paquet 4 Ampoule');
    expect(describeInPacks(200_000, packs, 'Ampoule')).toBe('2 Carton');
    expect(describeInPacks(0, packs, 'Ampoule')).toBe('');
  });

  it('refuse les conditionnements incohérents', () => {
    expect(checkPacks([{ name: 'Carton', contains: 12, salePrice: 6000 }], 'kg')).toMatch(/à la pièce/);
    expect(checkPacks([{ name: 'Carton', contains: 1, salePrice: 6000 }], 'piece')).toMatch(/Contenu/);
    expect(checkPacks([{ name: 'Pack', contains: 6, salePrice: 3000 }, { name: 'pack', contains: 2, salePrice: 1000 }], 'piece')).toMatch(/double/);
    expect(checkPacks([{ name: 'Palette', contains: 80, salePrice: 1_000_000 }, { name: 'Pack', contains: 6, salePrice: 3000 }], 'piece')).toBeNull();
  });

  it('retombe sur le tarif inférieur et prix une ligne vendue au carton', () => {
    expect(tariffPrice({ retail: 200, wholesale: null, superWholesale: null }, 'super_wholesale')).toBe(200);
    expect(tariffPrice({ retail: 200, wholesale: 180, superWholesale: null }, 'super_wholesale')).toBe(180);
    expect(lineTotal({ articleId: 'a', label: 'Ampoule', unitPrice: 200, qty: 200_000, vatRate: 1925, discount: 500, packPrice: 10_500, packUnits: 100_000 })).toBe(20_500);
  });
});
