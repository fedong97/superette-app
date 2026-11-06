/// <reference path="./pdfjs-worker.d.ts" />
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import * as pdfjsWorker from 'pdfjs-dist/legacy/build/pdf.worker.mjs';

// Le lecteur de PDF tourne dans le processus principal, sans fil séparé : pdf.js
// prend le « worker » déjà chargé (intégré au programme) au lieu d'aller le chercher.
(globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = pdfjsWorker;

interface TextPiece {
  str: string;
  transform: number[];
  width: number;
  height: number;
}

/** Pages lues au plus (une facture fait rarement plus de quelques pages). */
const MAX_PAGES = 20;

/**
 * Texte d'un PDF ligne par ligne (0.116.0) : les morceaux de texte d'une même
 * hauteur, de gauche à droite, séparés par un espace. Un PDF scanné (une image)
 * ne contient pas de texte : la liste revient vide.
 */
export async function pdfLines(data: Uint8Array): Promise<string[]> {
  const doc = await pdfjs.getDocument({ data, useSystemFonts: false, isEvalSupported: false, disableFontFace: true, verbosity: 0 }).promise;
  const out: string[] = [];
  try {
    for (let p = 1; p <= Math.min(doc.numPages, MAX_PAGES); p++) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      const pieces = (content.items as TextPiece[]).filter((i) => typeof i.str === 'string' && i.str.trim());
      // Regroupement par hauteur : deux morceaux à moins de la moitié d'une hauteur de lettre sont sur la même ligne.
      const rows: { y: number; h: number; items: TextPiece[] }[] = [];
      for (const it of pieces) {
        const y = it.transform[5] ?? 0;
        const h = Math.max(2, Math.abs(it.height || it.transform[3] || 8));
        const row = rows.find((r) => Math.abs(r.y - y) < Math.min(r.h, h) / 2);
        if (row) row.items.push(it);
        else rows.push({ y, h, items: [it] });
      }
      rows.sort((a, b) => b.y - a.y);
      for (const r of rows) {
        r.items.sort((a, b) => (a.transform[4] ?? 0) - (b.transform[4] ?? 0));
        let line = '';
        let end = -Infinity;
        for (const it of r.items) {
          const x = it.transform[4] ?? 0;
          // Un vide entre deux morceaux (mots, colonnes) devient un espace ; deux morceaux collés restent un seul mot.
          if (line && !/\s$/.test(line) && x - end > r.h * 0.15) line += ' ';
          line += it.str;
          end = x + (it.width || 0);
        }
        out.push(line.replace(/\s+/g, ' ').trim());
      }
      page.cleanup();
    }
  } finally {
    await doc.destroy();
  }
  return out.filter(Boolean);
}
