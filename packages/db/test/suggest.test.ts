import { describe, expect, it } from 'vitest';
import { createServices, openDatabase } from '../src';

describe('suggestions de produits pendant la saisie', () => {
  it('trouve par début de mot, plusieurs mots, sans accents, et met devant les noms qui commencent par la saisie', () => {
    const s = createServices(openDatabase(':memory:'), () => new Date('2026-10-06T08:00:00Z'));
    const { store, admin } = s.admin.bootstrap({ storeCode: 'DLA1', storeName: 'Superette Akwa', adminName: 'Steve', adminLogin: 'steve', adminPin: '1234' });
    const tva = s.admin.listVatRates().find((r) => r.rate_bp === 1925)!.id;
    const art = (name: string, brand?: string, active = true) => {
      const a = s.catalogue.saveArticle(admin.id, { name, brand, unit: 'piece', vatRateId: tva, purchasePrice: 100, salePrice: 200 });
      if (!active) s.catalogue.saveArticle(admin.id, { name, brand, unit: 'piece', vatRateId: tva, purchasePrice: 100, salePrice: 200, active: false }, a.id);
      return a;
    };
    art('Riz parfumé 5 kg');
    art("Riz Uncle Ben's 1 kg");
    art('Riz brisé 25 kg');
    art('Farine de riz 1 kg');
    art('Crème fraîche 20 cl', 'Président');
    art('Riz ancien', undefined, false);
    const names = (q: string) => s.catalogue.suggestArticles(q, store.id).map((a) => a.name);

    expect(names('ri')).toEqual(['Riz brisé 25 kg', 'Riz parfumé 5 kg', "Riz Uncle Ben's 1 kg", 'Farine de riz 1 kg']);
    expect(names('riz 5')).toEqual(['Riz brisé 25 kg', 'Riz parfumé 5 kg']);
    expect(names('PARFUME')).toEqual(['Riz parfumé 5 kg']);
    expect(names('creme')).toEqual(['Crème fraîche 20 cl']);
    expect(names('president')).toEqual(['Crème fraîche 20 cl']);
    expect(names('50%')).toEqual([]);
    expect(names('  ')).toEqual([]);
  });
});
