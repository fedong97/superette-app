import { describe, expect, it } from 'vitest';
import { lineTerms } from '../src/renderer/screens/purchaseTerms';

const carton = { qty: '10', cost: '7200', packUnits: 24_000, disc: '', promo: '' };

describe("saisie d'une ligne d'achat", () => {
  it('ajoute le bonus à la quantité payée, gratuit', () => {
    const t = lineTerms({ ...carton, bonus: '1', discType: 'pct' });
    expect(t).toMatchObject({ qty: 264_000, freeQty: 24_000, net: 72_000, freeCount: 1 });
  });

  it('ramène une remise en FCFA à un pourcentage de la ligne', () => {
    const t = lineTerms({ ...carton, discType: 'amount', discAmount: '3600' });
    expect(t).toMatchObject({ discountBp: 500, net: 68_400 });
    expect(lineTerms({ ...carton, discType: 'amount', discAmount: '90000' })).toMatch(/Remise invalide/);
  });

  it('applique seulement le type de remise choisi', () => {
    expect(lineTerms({ ...carton, disc: '5', promo: '12/10', discType: 'promo' })).toMatchObject({ discountBp: 0, net: 72_000 });
    expect(lineTerms({ ...carton, qty: '12', disc: '5', promo: '12/10', discType: 'promo' })).toMatchObject({ discountBp: 0, net: 72_000, freeQty: 48_000 });
    expect(lineTerms({ ...carton, disc: '5', promo: '12/10', discType: 'pct' })).toMatchObject({ discountBp: 500, promoBuy: null, net: 68_400 });
    // Lignes de bon de commande (sans type) : remise et promo ensemble, comme avant.
    expect(lineTerms({ ...carton, qty: '12', disc: '5', promo: '12/10' })).toMatchObject({ discountBp: 500, promoBuy: 12 });
  });

  it('refuse un bonus illisible', () => {
    expect(lineTerms({ ...carton, bonus: 'abc' })).toBe('Bonus invalide');
  });
});
