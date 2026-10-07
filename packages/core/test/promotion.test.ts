import { describe, expect, it } from 'vitest';
import { type CartLine, type PromotionRule, applyPromotions, checkPromotion, computeTotals, promotionLabel } from '../src';

const line = (articleId: string, qty: number, unitPrice: number, extra: Partial<CartLine> = {}): CartLine => ({
  articleId,
  label: articleId,
  unitPrice,
  qty,
  vatRate: 1925,
  discount: 0,
  ...extra,
});

describe('promotions', () => {
  const savon: PromotionRule = { id: 'p1', name: 'Savon 3 pour 2', articleId: 'savon', kind: 'x_for_y', buyQty: 3, payQty: 2 };
  const lait: PromotionRule = { id: 'p2', name: 'Lait en promo', articleId: 'lait', kind: 'price', promoPrice: 900 };
  const sucre: PromotionRule = { id: 'p3', name: 'Sucre 3 pour 1000', articleId: 'sucre', kind: 'lot', buyQty: 3, lotPrice: 1000 };

  it('3 pour 2 : un article offert par groupe complet, même sur plusieurs lignes', () => {
    const out = applyPromotions([line('savon', 2000, 400), line('riz', 1000, 4500), line('savon', 5000, 400)], [savon]);
    // 7 savons : 2 groupes de 3, 2 offerts = 800, portés par la dernière ligne.
    expect(out.map((l) => l.promo)).toEqual([0, 0, 800]);
    expect(out[2]).toMatchObject({ promotionId: 'p1', promotionName: 'Savon 3 pour 2' });
    expect(computeTotals(out)).toMatchObject({ totalTtc: 800 + 4500 + 2000 - 800, totalPromo: 800, totalDiscount: 0 });
  });

  it('prix promo à l’unité ou au kilo, lot à prix fixe', () => {
    const out = applyPromotions([line('lait', 2000, 1100), line('sucre', 4000, 400), line('viande', 1500, 3000)], [lait, sucre, { ...lait, id: 'p4', articleId: 'viande', promoPrice: 2500 }]);
    expect(out.map((l) => l.promo)).toEqual([400, 200, 750]);
  });

  it('garde la meilleure offre et ignore étiquettes balance et quantités incomplètes', () => {
    const better: PromotionRule = { ...savon, id: 'p5', name: 'Savon 2 pour 1', buyQty: 2, payQty: 1 };
    expect(applyPromotions([line('savon', 4000, 400)], [savon, better])[0]).toMatchObject({ promo: 800, promotionId: 'p5' });
    expect(applyPromotions([line('savon', 2000, 400)], [savon])[0]!.promo).toBe(0);
    expect(applyPromotions([line('lait', 1000, 1100, { fixedAmount: 1100 })], [lait])[0]!.promo).toBe(0);
    // Prix promo supérieur au prix du jour : aucun effet.
    expect(applyPromotions([line('lait', 1000, 850)], [lait])[0]!.promo).toBe(0);
    // L'économie ne dépasse jamais le montant restant après remise manuelle.
    expect(applyPromotions([line('savon', 3000, 400, { discount: 1000 })], [savon])[0]!.promo).toBe(200);
  });

  it('contrôle les règles et les décrit', () => {
    expect(checkPromotion({ name: 'x', kind: 'price', promoPrice: 1200 }, 1100, 'piece')).toMatch(/inférieur au prix normal/);
    expect(checkPromotion({ name: 'x', kind: 'x_for_y', buyQty: 3, payQty: 3 }, 400, 'piece')).toMatch(/payés/);
    expect(checkPromotion({ name: 'x', kind: 'lot', buyQty: 3, lotPrice: 1000 }, 400, 'kg')).toMatch(/à la pièce/);
    expect(checkPromotion({ name: 'x', kind: 'lot', buyQty: 3, lotPrice: 1200 }, 400, 'piece')).toMatch(/inférieur au prix des articles/);
    expect(checkPromotion({ name: ' ', kind: 'price', promoPrice: 900 }, 1100, 'piece')).toMatch(/nom/);
    expect(checkPromotion(sucre, 400, 'piece')).toBeNull();
    expect([savon, lait, sucre].map((r) => promotionLabel(r))).toEqual(['3 pour 2', 'Prix promo 900', '3 pour 1000']);
  });
});
