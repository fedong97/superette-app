import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { columnName, crc32, xlsxFiles, xlsxWorkbook } from '../src';

describe('classeur Excel', () => {
  it('nomme les colonnes et calcule le CRC des archives ZIP', () => {
    expect([0, 25, 26, 27, 701, 702].map(columnName)).toEqual(['A', 'Z', 'AA', 'AB', 'ZZ', 'AAA']);
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });

  it('écrit un classeur ouvrable, avec titres, total en gras et noms de feuilles uniques', () => {
    const sheets = [
      {
        name: 'Ventes/rayon',
        title: ['Ventes par rayon', 'Du 01/10/2026 au 07/10/2026'],
        columns: [{ header: 'Rayon', width: 24 }, { header: 'CA TTC', format: 'money' as const }, { header: 'Marge', format: 'pct' as const }],
        rows: [
          ['Épicerie & <boissons>', 125_000, 0.225],
          ['Sans rayon', 3_500, null],
        ],
        totalRow: ['Total', 128_500, 0.22],
      },
      { name: 'Ventes/rayon', columns: [{ header: 'Vide' }], rows: [] },
    ];
    const files = xlsxFiles(sheets);
    expect(files.find((f) => f.name === 'xl/workbook.xml')!.content).toContain('name="Ventes rayon (2)"');
    const sheet = files.find((f) => f.name === 'xl/worksheets/sheet1.xml')!.content;
    expect(sheet).toContain('Épicerie &amp; &lt;boissons&gt;');
    expect(sheet).toContain('<pane ySplit="4" topLeftCell="A5"');
    const bytes = xlsxWorkbook(sheets);
    expect([...bytes.slice(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
    if (process.env.XLSX_OUT) writeFileSync(process.env.XLSX_OUT, bytes);
  });
});

describe('lecture xlsx', () => {
  it('relit un classeur écrit par xlsxWorkbook', async () => {
    const { readXlsxRows, xlsxWorkbook } = await import('../src');
    const book = xlsxWorkbook([
      { name: 'Fiche', title: ['Inventaire n° 2'], columns: [{ header: 'Code' }, { header: 'Produit' }, { header: 'Compté', format: 'qty' }], rows: [['DLA1-001', 'Bière & eau <33>', 12.5], ['DLA1-002', 'Riz', null]] },
    ]);
    const rows = await readXlsxRows(book);
    expect(rows.filter((r) => r.length)).toEqual([['Inventaire n° 2'], ['Code', 'Produit', 'Compté'], ['DLA1-001', 'Bière & eau <33>', '12.5'], ['DLA1-002', 'Riz', '']]);
  });
});
