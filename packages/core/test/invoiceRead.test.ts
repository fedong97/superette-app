import { describe, expect, it } from 'vitest';
import { labelSimilarity, readSupplierInvoice } from '../src';

describe('lecture d’une facture fournisseur', () => {
  it('lit l’en-tête, les totaux et les lignes, même avec les milliers séparés par un espace', () => {
    const r = readSupplierInvoice([
      'SOCIÉTÉ ANONYME DES BRASSERIES DU CAMEROUN',
      'NIU : M012345678901A    Tél. 699 12 34 56',
      'FACTURE N° FA-2026-0412',
      'Date : 05/11/2026',
      'Réf. Désignation Qté P.U. HT Montant HT',
      'CAS33 Casier Castel 33 cl x12 10 6 450 64 500',
      '5449000000996 Coca-Cola 1,5 L 24 450 10 800',
      'MUT65 Mutzig 65 cl 2 12 000 24 000',
      'Total HT 99 300',
      'TVA 19,25 % 19 115',
      'Net à payer 118 415 FCFA',
    ]);
    expect(r).toMatchObject({ number: 'FA-2026-0412', date: '2026-11-05', taxpayerNumber: 'M012345678901A', totalHt: 99_300, totalTva: 19_115, totalTtc: 118_415 });
    expect(r.lines.map((l) => [l.reference, l.barcode, l.label, l.qty, l.unitPrice, l.total])).toEqual([
      ['CAS33', null, 'Casier Castel 33 cl x12', 10_000, 6_450, 64_500],
      [null, '5449000000996', 'Coca-Cola 1,5 L', 24_000, 450, 10_800],
      ['MUT65', null, 'Mutzig 65 cl', 2_000, 12_000, 24_000],
    ]);
    expect(r.linesTotal).toBe(99_300);
  });

  it('accepte le point des milliers, les quantités décimales et la colonne de TVA après le montant', () => {
    const r = readSupplierInvoice(['Facture 2211 du 2026-10-30', 'Riz parfumé 25 kg 3 18.500 55.500 19,25', 'Sucre en poudre 2,5 1 200 3 000']);
    expect(r.number).toBe('2211');
    expect(r.date).toBe('2026-10-30');
    expect(r.lines.map((l) => [l.label, l.qty, l.unitPrice, l.total])).toEqual([
      ['Riz parfumé 25 kg', 3_000, 18_500, 55_500],
      ['Sucre en poudre', 2_500, 1_200, 3_000],
    ]);
  });

  it('ne prend pas une adresse ou un téléphone pour un article', () => {
    const r = readSupplierInvoice(['BP 4036 Douala Tél 233 42 51 00', 'Rue 1.234 Akwa 12 15 20']);
    expect(r.lines).toEqual([]);
  });

  it('compare deux désignations', () => {
    expect(labelSimilarity('MUTZIG 65CL', 'Mutzig 65 cl')).toBeGreaterThan(0.3);
    expect(labelSimilarity('Coca-Cola 1,5 L', 'Coca Cola 1,5 L PET')).toBeGreaterThan(0.7);
    expect(labelSimilarity('Riz', 'Savon')).toBe(0);
  });
});
