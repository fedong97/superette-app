import { describe, expect, it } from 'vitest';
import { barcodeLabelsHtml, barcodeModules, barcodeSvg, barcodeWithDigitsSvg, internalEan8, isInternalBarcode, isValidEan, labelsHtml } from '../src';

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

describe('étiquettes produit (code-barres à coller)', () => {
  it('crée des codes internes EAN-8 commençant par 2, à la clé juste', () => {
    expect(internalEan8(1)).toBe('20000011');
    expect(isValidEan(internalEan8(300_042))).toBe(true);
    expect(internalEan8(999_999)).toMatch(/^2999999\d$/);
    expect(() => internalEan8(1_000_000)).toThrow();
    expect(isInternalBarcode('20000017')).toBe(true);
    expect(isInternalBarcode('2000000000015')).toBe(true);
    expect(isInternalBarcode('65833254')).toBe(false);
    expect(isInternalBarcode('5449000131805')).toBe(false);
  });

  it('dessine le code avec ses chiffres par moitié, barres sur des points entiers', () => {
    const svg = barcodeWithDigitsSvg('65833254', 27, 12);
    expect(svg).toContain('>6583</text>');
    expect(svg).toContain('>3254</text>');
    // 81 modules sur 27 mm : module ramené à 0,25 mm (2 points à 203 dpi).
    expect(svg).toMatch(/width="20\.25mm"/);
    const ean13 = barcodeWithDigitsSvg('5449000131805', 38, 12);
    expect(ean13).toContain('>5</text>');
    expect(ean13).toContain('>449000</text>');
    expect(ean13).toContain('>131805</text>');
  });

  it('imprime le nom, le prix et le magasin seulement si on les demande', () => {
    const l = { barcode: '20000011', name: 'Arachides 100 g', price: 200, store: 'Superette Akwa' };
    const full = barcodeLabelsHtml([l, l], 'roll_30x20', { name: true, price: true, store: true });
    expect(full).toContain('@page { size: 30mm 20mm');
    expect(full.match(/class="label"/g)).toHaveLength(2);
    expect(full).toContain('Arachides 100 g');
    expect(full).toContain('Superette Akwa');
    expect(full).toMatch(/200<small> F/);
    const bare = barcodeLabelsHtml([l], 'roll_30x20', { name: false, price: false, store: false });
    expect(bare).not.toContain('Arachides');
    expect(bare).not.toContain('<small> F');
    expect(bare).toContain('>2000</text>');
    // Planche A4 : cases déjà utilisées laissées vides.
    const sheet = barcodeLabelsHtml([l], 'a4_65', { name: true, price: true, store: false }, 3);
    expect(sheet.match(/class="label"/g)).toHaveLength(4);
  });
});
