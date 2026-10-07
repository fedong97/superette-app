import { describe, expect, it } from 'vitest';
import { drawerKick, formatFcfa, layoutRow, receiptToEscPos, receiptToText, toPrinterText, wrapText, type Receipt } from '../src';

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

describe('tickets ESC/POS', () => {
  it('ramène le texte aux caractères de la table de l’imprimante', () => {
    expect(toPrinterText('Crème brûlée · 12 500 – l’œuf', 'pc850')).toBe('Crème brûlée · 12 500 - l\'oeuf');
    expect(toPrinterText('Prix 5 € ñ', 'pc850')).toBe('Prix 5 EUR n');
    expect(toPrinterText('Prix 5 €', 'pc858')).toBe('Prix 5 €');
    expect(toPrinterText('Épicerie à côté 漢', 'ascii')).toBe('Epicerie a cote ?');
    expect(toPrinterText(formatFcfa(1_250_000, false), 'ascii')).toBe('1 250 000');
  });

  it('coupe les libellés entre deux mots et aligne les montants à droite', () => {
    expect(wrapText('Huile de palme raffinée Mayor 1 litre', 16)).toEqual(['Huile de palme', 'raffinée Mayor 1', 'litre']);
    expect(wrapText('ABCDEFGHIJKLMNOPQRST', 8)).toEqual(['ABCDEFGH', 'IJKLMNOP', 'QRST']);
    expect(layoutRow('Riz 5 kg', '4 500', 20)).toEqual(['Riz 5 kg       4 500']);
    expect(layoutRow('Lait concentré sucré Nestlé', '1 200', 20)).toEqual(['Lait concentré sucré', 'Nestlé         1 200']);
    expect(layoutRow('Sardines à l’huile Pacific', '12 500', 20)).toEqual(['Sardines à l’huile', 'Pacific       12 500']);
    expect(layoutRow('2 x 600', '', 20, 2)).toEqual(['  2 x 600']);
  });

  it('produit les commandes ESC/POS : initialisation, table, styles, coupe et tiroir', () => {
    const receipt: Receipt = [
      { t: 'text', text: 'Épicerie', align: 'center', bold: true },
      { t: 'rule' },
      { t: 'row', left: 'TOTAL', right: '50', big: true },
    ];
    const bytes = receiptToEscPos(receipt, { columns: 16, codepage: 'pc850', kick: true });
    const h = hex(bytes);
    expect(h.startsWith('1b40' + '1b700019fa' + '1b7402')).toBe(true);
    // Titre centré en gras : « É » = 0x90 en PC850.
    expect(h).toContain('1b4501' + '1d2100' + '1b6101' + '90' + Buffer.from('picerie').toString('hex') + '0a');
    expect(h).toContain(Buffer.from('-'.repeat(16)).toString('hex') + '0a');
    // Ligne en double taille : 8 colonnes seulement.
    expect(h).toContain('1d2111' + '1b6100' + Buffer.from('TOTAL 50').toString('hex') + '0a');
    expect(h.endsWith('1b640' + '4' + '1d5601')).toBe(true);

    const noCut = hex(receiptToEscPos(receipt, { columns: 16, codepage: 'ascii', cut: false }));
    expect(noCut).not.toContain('1b74');
    expect(noCut).not.toContain('1b7000');
    expect(noCut.endsWith('1b6402')).toBe(true);
    expect(hex(drawerKick())).toBe('1b700019fa');
  });

  it('encode en WPC1252 et PC858', () => {
    const r: Receipt = [{ t: 'text', text: 'é€' }];
    expect(hex(receiptToEscPos(r, { columns: 32, codepage: 'wpc1252' }))).toContain('1b7410' + '1b4500' + '1d2100' + '1b6100' + 'e980' + '0a');
    expect(hex(receiptToEscPos(r, { columns: 32, codepage: 'pc858' }))).toContain('1b7413' + '1b4500' + '1d2100' + '1b6100' + '82d5' + '0a');
  });

  it('donne un aperçu texte fidèle à la largeur du papier', () => {
    const text = receiptToText(
      [
        { t: 'text', text: 'SUPERETTE', align: 'center' },
        { t: 'row', left: 'Savon', right: '350' },
        { t: 'row', left: '2 x 175', right: '', indent: 2 },
        { t: 'rule' },
      ],
      20,
    );
    expect(text.split('\n')).toEqual(['     SUPERETTE', 'Savon            350', '  2 x 175', '-'.repeat(20)]);
  });
});
