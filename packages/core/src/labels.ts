import { isValidEan } from './barcode';
import { type Fcfa, formatFcfa } from './money';

/**
 * Étiquettes de rayon : codes-barres dessinés en SVG (EAN-13, EAN-8, sinon
 * Code 128) et planches prêtes à imprimer. Le même HTML sert à l'aperçu à
 * l'écran et à l'impression, pour que l'un ressemble exactement à l'autre.
 */

const EAN_L = ['0001101', '0011001', '0010011', '0111101', '0100011', '0110001', '0101111', '0111011', '0110111', '0001011'];
const EAN_G = ['0100111', '0110011', '0011011', '0100001', '0011101', '0111001', '0000101', '0010001', '0001001', '0010111'];
const EAN_R = ['1110010', '1100110', '1101100', '1000010', '1011100', '1001110', '1010000', '1000100', '1001000', '1110100'];
const EAN_PARITY = ['LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG', 'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL'];

// Largeurs barre/espace des 107 symboles Code 128 (le dernier est l'arrêt).
const C128 = (
  '212222 222122 222221 121223 121322 131222 122213 122312 132212 221213 221312 231212 112232 122132 122231 113222 ' +
  '123122 123221 223211 221132 221231 213212 223112 312131 311222 321122 321221 312212 322112 322211 212123 212321 ' +
  '232121 111323 131123 131321 112313 132113 132311 211313 231113 231311 112133 112331 132131 113123 113321 133121 ' +
  '313121 211331 231131 213113 213311 213131 311123 311321 331121 312113 312311 332111 314111 221411 431111 111224 ' +
  '111422 121124 121421 141122 141221 112214 112412 122114 122411 142112 142211 241211 221114 413111 241112 134111 ' +
  '111242 121142 121241 114212 124112 124211 411212 421112 421211 212141 214121 412121 111143 111341 131141 114113 ' +
  '114311 411113 411311 113141 114131 311141 411131 211412 211214 211232 2331112'
).split(' ');

const widthsToModules = (widths: string) =>
  [...widths].map((w, i) => (i % 2 === 0 ? '1' : '0').repeat(Number(w))).join('');

/** Code 128 jeu B (caractères imprimables) : départ, données, clé modulo 103, arrêt. */
function code128(text: string): string | null {
  if (!text || ![...text].every((c) => c >= ' ' && c <= '~')) return null;
  const values = [...text].map((c) => c.charCodeAt(0) - 32);
  const check = (104 + values.reduce((s, v, i) => s + v * (i + 1), 0)) % 103;
  return [104, ...values, check, 106].map((v) => widthsToModules(C128[v]!)).join('');
}

function ean(code: string): string {
  const d = [...code].map(Number);
  if (code.length === 8) return `101${d.slice(0, 4).map((x) => EAN_L[x]).join('')}01010${d.slice(4).map((x) => EAN_R[x]).join('')}101`;
  const parity = EAN_PARITY[d[0]!]!;
  const left = d.slice(1, 7).map((x, i) => (parity[i] === 'L' ? EAN_L : EAN_G)[x]).join('');
  return `101${left}01010${d.slice(7).map((x) => EAN_R[x]).join('')}101`;
}

/** Suite de modules (1 = barre, 0 = espace) ; EAN quand le code est un EAN valide, sinon Code 128. */
export function barcodeModules(code: string): { kind: 'ean13' | 'ean8' | 'code128'; modules: string } | null {
  if (/^\d{13}$/.test(code) && isValidEan(code)) return { kind: 'ean13', modules: ean(code) };
  if (/^\d{8}$/.test(code) && isValidEan(code)) return { kind: 'ean8', modules: ean(code) };
  const modules = code128(code);
  return modules ? { kind: 'code128', modules } : null;
}

/** Code-barres en SVG, à la largeur et à la hauteur données (mm), avec la marge blanche obligatoire. */
export function barcodeSvg(code: string, widthMm: number, heightMm: number): string {
  const b = barcodeModules(code);
  if (!b) return '';
  const quiet = b.kind === 'code128' ? 10 : 9;
  const total = b.modules.length + 2 * quiet;
  let rects = '';
  for (let i = 0; i < b.modules.length; ) {
    if (b.modules[i] === '0') {
      i++;
      continue;
    }
    let j = i;
    while (b.modules[j] === '1') j++;
    rects += `<rect x="${i + quiet}" y="0" width="${j - i}" height="1"/>`;
    i = j;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${widthMm}mm" height="${heightMm}mm" viewBox="0 0 ${total} 1" preserveAspectRatio="none" shape-rendering="crispEdges">${rects}</svg>`;
}

export interface LabelFormat {
  name: string;
  /** Largeur et hauteur de la page en mm. */
  pageW: number;
  pageH: number;
  cols: number;
  rows: number;
  /** Taille d'une étiquette et position de la première, en mm. */
  w: number;
  h: number;
  top: number;
  left: number;
  /** Écart horizontal entre deux colonnes. */
  gap: number;
  /** Petite étiquette : nom et prix seulement, sans ligne de détail. */
  compact?: boolean;
}

export type LabelFormatId = 'a4_24' | 'a4_40' | 'a4_65' | 'roll_50x30';

export const LABEL_FORMATS: Record<LabelFormatId, LabelFormat> = {
  a4_24: { name: 'Planche A4 · 24 étiquettes (70 × 37 mm)', pageW: 210, pageH: 297, cols: 3, rows: 8, w: 70, h: 37, top: 0.5, left: 0, gap: 0 },
  a4_40: { name: 'Planche A4 · 40 étiquettes (52,5 × 29,7 mm)', pageW: 210, pageH: 297, cols: 4, rows: 10, w: 52.5, h: 29.7, top: 0, left: 0, gap: 0 },
  a4_65: { name: 'Planche A4 · 65 étiquettes (38,1 × 21,2 mm)', pageW: 210, pageH: 297, cols: 5, rows: 13, w: 38.1, h: 21.2, top: 10.7, left: 4.75, gap: 2.5, compact: true },
  roll_50x30: { name: 'Rouleau d’imprimante d’étiquettes (50 × 30 mm)', pageW: 50, pageH: 30, cols: 1, rows: 1, w: 50, h: 30, top: 0, left: 0, gap: 0 },
};

export interface LabelData {
  name: string;
  /** Prix TTC affiché en grand. */
  price: Fcfa;
  /** Ancien prix barré pendant une promotion. */
  oldPrice?: Fcfa | null;
  /** Bandeau de promotion (« Promo », « 3 pour 2 »). */
  promo?: string | null;
  /** Détail sous le prix : « Carton de 100 · 105 F l’ampoule ». */
  detail?: string | null;
  barcode: string | null;
  code: string;
  /** Date d'impression, pour savoir si l'étiquette est à jour. */
  date: string;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/**
 * Document HTML complet d'une ou plusieurs planches. `skip` laisse vides les
 * premières étiquettes d'une planche déjà entamée.
 */
export function labelsHtml(labels: readonly LabelData[], formatId: LabelFormatId, skip = 0): string {
  const f = LABEL_FORMATS[formatId];
  const perPage = f.cols * f.rows;
  const cells: (LabelData | null)[] = [...Array<null>(f.cols === 1 ? 0 : Math.max(0, Math.min(skip, perPage - 1))).fill(null), ...labels];
  const pages: (LabelData | null)[][] = [];
  for (let i = 0; i < cells.length; i += perPage) pages.push(cells.slice(i, i + perPage));
  const small = f.h < 25;
  const priceSize = small ? 4.6 : f.h < 32 ? 6 : 7.5;
  const barH = small ? 5 : f.h < 32 ? 7 : 8;
  const label = (l: LabelData | null) => {
    if (!l) return '<div class="label empty"></div>';
    const bar = l.barcode ? barcodeSvg(l.barcode, Math.min(f.w - 6, 38), barH) : '';
    return `<div class="label${l.promo ? ' promo' : ''}">
  <div class="name">${esc(l.name)}</div>
  ${l.promo ? `<div class="flag">${esc(l.promo)}</div>` : ''}
  <div class="price">${l.oldPrice ? `<s>${formatFcfa(l.oldPrice, false)}</s> ` : ''}${formatFcfa(l.price, false)}<small> F</small></div>
  ${l.detail && !f.compact ? `<div class="detail">${esc(l.detail)}</div>` : ''}
  ${bar ? `<div class="bar">${bar}<div class="digits">${esc(l.barcode!)}</div></div>` : ''}
  <div class="meta${bar ? '' : ' alone'}">${esc(l.code)}${f.compact ? '' : ` · ${esc(l.date)}`}</div>
</div>`;
  };
  const style = `
@page { size: ${f.pageW}mm ${f.pageH}mm; margin: 0; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body { font-family: Arial, Helvetica, sans-serif; color: #000; }
.page { width: ${f.pageW}mm; height: ${f.pageH}mm; padding: ${f.top}mm 0 0 ${f.left}mm; display: grid;
  grid-template-columns: repeat(${f.cols}, ${f.w}mm); grid-auto-rows: ${f.h}mm; column-gap: ${f.gap}mm; overflow: hidden; break-after: page; }
.page:last-child { break-after: auto; }
.label { position: relative; overflow: hidden; padding: ${small ? 1 : 2}mm ${small ? 1.5 : 2.5}mm; display: flex; flex-direction: column; align-items: center; text-align: center; }
.name { font-size: ${small ? 2.4 : 3}mm; font-weight: bold; line-height: 1.15; max-height: ${small ? 5.6 : 7}mm; overflow: hidden; width: 100%; }
.flag { position: absolute; top: 0; right: 0; background: #000; color: #fff; font-size: 2.4mm; font-weight: bold; padding: 0.4mm 1.5mm; }
.price { font-size: ${priceSize}mm; font-weight: bold; line-height: 1.05; margin-top: 0.6mm; white-space: nowrap; }
.price small { font-size: ${priceSize * 0.45}mm; }
.price s { font-size: ${priceSize * 0.45}mm; font-weight: normal; }
.detail { font-size: 2.3mm; line-height: 1.2; }
.bar { margin-top: auto; line-height: 0; }
.bar svg { display: block; margin: 0 auto; }
.digits { font: ${small ? 1.9 : 2.2}mm/1.2 'Consolas', 'Courier New', monospace; letter-spacing: 0.3mm; }
.meta { font-size: 1.8mm; color: #333; }
.meta.alone { margin-top: auto; }
`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>Étiquettes</title><style>${style}</style></head><body>${pages
    .map((p) => `<div class="page">${p.map(label).join('')}</div>`)
    .join('')}</body></html>`;
}
