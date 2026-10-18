import { describe, expect, it } from 'vitest';
import { frenchWordsToNumber, numberToWordsEn, numberToWordsFr, translateDocHtml, translateDocText, translateReceipt } from '../src';

describe('documents en anglais', () => {
  it('relit chaque montant écrit en lettres et le réécrit en anglais', () => {
    for (let n = 0; n < 2_000; n++) expect(frenchWordsToNumber(numberToWordsFr(n))).toBe(n);
    for (const n of [71_080, 180_000, 1_000_001, 2_480_399, 999_999_999_999]) expect(frenchWordsToNumber(numberToWordsFr(n))).toBe(n);
    expect(numberToWordsEn(113_000)).toBe('one hundred and thirteen thousand');
    expect(numberToWordsEn(2_480_399)).toBe('two million four hundred and eighty thousand three hundred and ninety-nine');
  });

  it('traduit les textes du ticket et de la facture, sans toucher aux produits ni aux numéros', () => {
    expect(translateDocText('Arrêté à la somme de cent-treize-mille francs CFA', 'en')).toBe('Amount in words: one hundred and thirteen thousand CFA francs');
    expect(translateDocText('Rendu monnaie', 'en')).toBe('Change');
    expect(translateDocText('N° DLA1-1-000123', 'en')).toBe('No. DLA1-1-000123');
    expect(translateDocText('18/10/2026 09:00 · Awa · Caisse 1', 'en')).toBe('18/10/2026 09:00 · Awa · Register 1');
    expect(translateDocText('RIZ PARFUMÉ 1 KG', 'en')).toBe('RIZ PARFUMÉ 1 KG');
    expect(translateDocText('Rendu monnaie', 'fr')).toBe('Rendu monnaie');
    expect(translateReceipt([{ t: 'row', left: 'TOTAL FCFA', right: '2 000' }, { t: 'text', text: 'Merci de votre visite !' }], 'en')).toEqual([
      { t: 'row', left: 'TOTAL FCFA', right: '2 000' },
      { t: 'text', text: 'Thank you for your visit!' },
    ]);
    const html = translateDocHtml('<html><head><style>.total{}</style></head><body><h2>Facture DLA1-1-1</h2><td class="total">Reste à payer</td></body></html>', 'en');
    expect(html).toContain('<style>.total{}</style>');
    expect(html).toContain('<td class="total">Balance due</td>');
    expect(html).toContain('<h2>Invoice DLA1-1-1</h2>');
    expect(translateDocText('Facture à terme DLA1-1-9 (annulé)', 'en')).toBe('Credit invoice DLA1-1-9 (cancelled)');
  });
});
