import { describe, expect, it } from 'vitest';
import { barcodeModules, barcodeSvg, labelsHtml } from '../src';

// Références : python-barcode.
describe('codes-barres des étiquettes', () => {
  it('dessine les EAN-13, EAN-8 et Code 128 comme la norme', () => {
    expect(barcodeModules('5449000131805')).toEqual({
      kind: 'ean13',
      modules: '10101000110011101001011100011010001101010011101010110011010000101100110100100011100101001110101',
    });
    expect(barcodeModules('96385074')?.modules).toBe('1010001011010111101111010110111010101001110111001010001001011100101');
    expect(barcodeModules('DLA-Xab')).toEqual({
      kind: 'code128',
      modules: '1101001000010110001000100011011101010001100010011011100111000101101001011000010010000110101100100001100011101011',
    });
    // Un EAN à la clé fausse passe en Code 128 plutôt que d'imprimer un EAN illisible.
    expect(barcodeModules('5449000131806')?.kind).toBe('code128');
    expect(barcodeModules('')).toBeNull();
    expect(barcodeSvg('5449000131805', 38, 8)).toMatch(/^<svg[^>]*width="38mm" height="8mm"/);
  });

  it('remplit les planches en sautant les étiquettes déjà utilisées', () => {
    const l = { name: 'Riz <parfumé>', price: 12_500, barcode: '5449000131805', code: 'A1', date: '07/10/2026' };
    const html = labelsHtml(Array(25).fill(l), 'a4_24', 2);
    expect(html.match(/class="page"/g)).toHaveLength(2);
    expect(html.match(/class="label empty"/g)).toHaveLength(2);
    expect(html).toContain('Riz &lt;parfumé&gt;');
    expect(html).toMatch(/12\s500/);
  });
});
