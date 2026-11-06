import { describe, expect, it } from 'vitest';
import { readSupplierInvoice } from '@superette/core';
import { pdfLines } from '../src/main/pdfText';

/** PDF minimal écrit à la main : une page, police Helvetica, une ligne de texte par instruction. */
function tinyPdf(rows: [number, number, string][]): Uint8Array {
  const esc = (t: string) => t.replace(/[\\()]/g, (c) => `\\${c}`);
  const stream = rows.map(([x, y, t]) => `BT /F1 10 Tf ${x} ${y} Td (${esc(t)}) Tj ET`).join('\n');
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(pdf, 'latin1'));
}

describe('texte d’une facture en PDF', () => {
  it('rend les lignes du document, colonnes réunies, et la facture se lit', async () => {
    const pdf = tinyPdf([
      [50, 800, 'FACTURE N° FA-77'],
      [50, 785, 'Date : 03/11/2026'],
      [50, 700, 'CAS33'],
      [110, 700, 'Casier Castel 33 cl'],
      [330, 700, '10'],
      [380, 700, '6 450'],
      [450, 700, '64 500'],
      [50, 600, 'Total HT'],
      [450, 600, '64 500'],
    ]);
    const lines = await pdfLines(pdf);
    expect(lines).toEqual(['FACTURE N° FA-77', 'Date : 03/11/2026', 'CAS33 Casier Castel 33 cl 10 6 450 64 500', 'Total HT 64 500']);
    const r = readSupplierInvoice(lines);
    expect(r).toMatchObject({ number: 'FA-77', date: '2026-11-03', totalHt: 64_500 });
    expect(r.lines[0]).toMatchObject({ reference: 'CAS33', qty: 10_000, unitPrice: 6_450, total: 64_500 });
  });
});
