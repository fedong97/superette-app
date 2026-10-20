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

/* ---------- Étiquettes produit : le code-barres à coller sur l'article ---------- */

export type BarcodeLabelFormatId = 'roll_30x20' | 'roll_40x25' | 'roll_50x30' | 'a4_24' | 'a4_40' | 'a4_65';

const roll = (w: number, h: number): LabelFormat => ({ name: `Rouleau ${w} × ${h} mm`, pageW: w, pageH: h, cols: 1, rows: 1, w, h, top: 0, left: 0, gap: 0 });

/** Rouleaux d'imprimante d'étiquettes (une étiquette par page) et planches A4 autocollantes. */
export const BARCODE_LABEL_FORMATS: Record<BarcodeLabelFormatId, LabelFormat> = {
  roll_30x20: roll(30, 20),
  roll_40x25: roll(40, 25),
  roll_50x30: roll(50, 30),
  a4_24: { ...LABEL_FORMATS.a4_24, name: 'Planche A4 · 24 étiquettes (70 × 37 mm)' },
  a4_40: { ...LABEL_FORMATS.a4_40, name: 'Planche A4 · 40 étiquettes (52,5 × 29,7 mm)' },
  a4_65: { ...LABEL_FORMATS.a4_65, name: 'Planche A4 · 65 étiquettes (38 × 21 mm)' },
};

export const isBarcodeLabelFormat = (v: unknown): v is BarcodeLabelFormatId => typeof v === 'string' && v in BARCODE_LABEL_FORMATS;

/** Une étiquette produit : le code-barres, et ce qu'on veut lire à côté. */
export interface BarcodeLabel {
  barcode: string;
  name: string;
  price: Fcfa | null;
  store?: string | null;
}

/** Ce qui figure sur l'étiquette en plus du code-barres et de ses chiffres. */
export interface BarcodeLabelOptions {
  name: boolean;
  price: boolean;
  store: boolean;
}

/**
 * Code-barres avec ses chiffres, en millimètres réels. Comme sur les produits :
 * barres de garde plus longues, chiffres de l'EAN par moitié (4 + 4, ou
 * 1 + 6 + 6). Le module est ramené à un multiple de 1/8 mm pour que chaque
 * barre tombe sur des points entiers d'une imprimante thermique à 203 dpi.
 */
export function barcodeWithDigitsSvg(code: string, maxWidthMm: number, heightMm: number): string {
  const b = barcodeModules(code);
  if (!b) return '';
  const qL = b.kind === 'ean13' ? 11 : b.kind === 'ean8' ? 7 : 10;
  const qR = b.kind === 'code128' ? 10 : 7;
  const total = qL + b.modules.length + qR;
  let m = maxWidthMm / total;
  const snapped = Math.floor(m / 0.125) * 0.125;
  if (snapped >= 0.25) m = snapped;
  const w = total * m;
  const fs = Math.min(heightMm * 0.3, m * (b.kind === 'code128' ? 8 : 9));
  const barBottom = heightMm - fs * 0.95;
  const guardBottom = heightMm - fs * 0.45;
  const guards =
    b.kind === 'ean8' ? new Set([0, 1, 2, 31, 32, 33, 34, 35, 64, 65, 66]) : b.kind === 'ean13' ? new Set([0, 1, 2, 45, 46, 47, 48, 49, 92, 93, 94]) : new Set<number>();
  const r = (v: number) => Math.round(v * 1000) / 1000;
  let rects = '';
  for (let i = 0; i < b.modules.length; ) {
    if (b.modules[i] === '0') {
      i++;
      continue;
    }
    let j = i;
    while (b.modules[j] === '1') j++;
    const h = b.kind === 'code128' || !guards.has(i) ? barBottom : guardBottom;
    rects += `<rect x="${r((qL + i) * m)}" y="0" width="${r((j - i) * m)}" height="${r(h)}"/>`;
    i = j;
  }
  const text = (s: string, centerModule: number, spanModules: number | null) =>
    `<text x="${r(centerModule * m)}" y="${r(heightMm - fs * 0.08)}" font-size="${r(fs)}" text-anchor="middle"${
      spanModules ? ` textLength="${r(spanModules * m)}" lengthAdjust="spacing"` : ''
    }>${s}</text>`;
  let digits = '';
  if (b.kind === 'ean8') digits = text(code.slice(0, 4), qL + 17, 24) + text(code.slice(4), qL + 50, 24);
  else if (b.kind === 'ean13') digits = text(code[0]!, qL - 4.5, null) + text(code.slice(1, 7), qL + 24, 38) + text(code.slice(7), qL + 71, 38);
  else digits = text(esc(code), total / 2, null);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${r(w)}mm" height="${r(heightMm)}mm" viewBox="0 0 ${r(w)} ${r(heightMm)}" shape-rendering="crispEdges" font-family="Arial, Helvetica, sans-serif">${rects}${digits}</svg>`;
}

/** Planches ou rouleau d'étiquettes produit, prêts à imprimer (et à afficher en aperçu). */
export function barcodeLabelsHtml(labels: readonly BarcodeLabel[], formatId: BarcodeLabelFormatId, opts: BarcodeLabelOptions, skip = 0): string {
  const f = BARCODE_LABEL_FORMATS[formatId];
  const perPage = f.cols * f.rows;
  const cells: (BarcodeLabel | null)[] = [...Array<null>(f.cols === 1 ? 0 : Math.max(0, Math.min(skip, perPage - 1))).fill(null), ...labels];
  const pages: (BarcodeLabel | null)[][] = [];
  for (let i = 0; i < cells.length; i += perPage) pages.push(cells.slice(i, i + perPage));
  const padY = f.h < 24 ? 1 : 1.5;
  const nameSize = f.h < 24 ? 2.4 : f.h < 32 ? 2.8 : 3.4;
  const priceSize = f.h < 24 ? 3.4 : f.h < 32 ? 4.4 : 5.6;
  const storeSize = f.h < 24 ? 1.8 : 2.1;
  const label = (l: BarcodeLabel | null) => {
    if (!l) return '<div class="label"></div>';
    const store = opts.store && l.store ? l.store : '';
    const price = opts.price && l.price !== null ? l.price : null;
    const used = 2 * padY + (store ? storeSize * 1.2 : 0) + (opts.name ? nameSize * 1.25 : 0) + (price !== null ? priceSize * 1.15 + 0.4 : 0);
    const bar = barcodeWithDigitsSvg(l.barcode, Math.min(f.w - 3, 40), Math.max(6, Math.min(f.h - used, 22)));
    return `<div class="label">${store ? `<div class="store">${esc(store)}</div>` : ''}${opts.name ? `<div class="name">${esc(l.name)}</div>` : ''}<div class="bar">${bar}</div>${
      price !== null ? `<div class="price">${formatFcfa(price, false)}<small> F</small></div>` : ''
    }</div>`;
  };
  const style = `
@page { size: ${f.pageW}mm ${f.pageH}mm; margin: 0; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body { font-family: Arial, Helvetica, sans-serif; color: #000; }
.page { width: ${f.pageW}mm; height: ${f.pageH}mm; padding: ${f.top}mm 0 0 ${f.left}mm; display: grid;
  grid-template-columns: repeat(${f.cols}, ${f.w}mm); grid-auto-rows: ${f.h}mm; column-gap: ${f.gap}mm; overflow: hidden; break-after: page; }
.page:last-child { break-after: auto; }
.label { overflow: hidden; padding: ${padY}mm 1.5mm; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; }
.store { font-size: ${storeSize}mm; line-height: 1.2; text-transform: uppercase; letter-spacing: 0.1mm; white-space: nowrap; overflow: hidden; max-width: 100%; }
.name { font-size: ${nameSize}mm; font-weight: bold; line-height: 1.2; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }
.bar { line-height: 0; margin-bottom: 0.4mm; }
.bar svg { display: block; }
.price { font-size: ${priceSize}mm; font-weight: bold; line-height: 1.1; white-space: nowrap; }
.price small { font-size: ${priceSize * 0.45}mm; }
`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>Codes-barres</title><style>${style}</style></head><body>${pages
    .map((p) => `<div class="page">${p.map(label).join('')}</div>`)
    .join('')}</body></html>`;
}

/**
 * Carte de fidélité au format carte bancaire (85,6 × 54 mm), à découper :
 * magasin, nom du client et code-barres de son code (scanné à la caisse).
 */
export function loyaltyCardHtml(card: { store: string; customer: string; code: string; phone?: string | null; logo?: string | null }, copies = 1): string {
  const one =
    `<div class="fid">` +
    `<div class="fid-head">${card.logo ? `<img src="${esc(card.logo)}" alt="">` : ''}<div><div class="fid-store">${esc(card.store)}</div><div class="fid-title">Carte de fidélité</div></div></div>` +
    `<div class="fid-name">${esc(card.customer)}</div>${card.phone ? `<div class="fid-phone">${esc(card.phone)}</div>` : ''}` +
    `<div class="fid-code">${barcodeWithDigitsSvg(card.code, 70, 14)}</div></div>`;
  const style =
    '<style>.fid-grid{display:flex;flex-wrap:wrap;gap:6mm}.fid{box-sizing:border-box;width:85.6mm;height:54mm;border:0.3mm dashed #999;border-radius:3mm;padding:3mm 4mm;font-family:Arial,Helvetica,sans-serif;display:flex;flex-direction:column;page-break-inside:avoid}' +
    '.fid-head{display:flex;gap:2.5mm;align-items:center}.fid-head img{max-height:10mm;max-width:18mm}.fid-store{font-weight:bold;font-size:3.6mm}.fid-title{font-size:2.8mm;color:#1f7a3a;font-weight:bold;text-transform:uppercase;letter-spacing:0.3mm}' +
    '.fid-name{margin-top:2.5mm;font-size:4mm;font-weight:bold}.fid-phone{font-size:2.8mm;color:#555}.fid-code{margin-top:auto;text-align:center}</style>';
  return `${style}<div class="fid-grid">${Array.from({ length: Math.max(1, Math.min(10, copies)) }, () => one).join('')}</div>`;
}

/** Badge d'employé au format carte bancaire : nom, rôle, code-barres scanné à la connexion. */
export function staffBadgeHtml(card: { store: string; name: string; role: string; code: string; logo?: string | null }): string {
  const one =
    `<div class="fid">` +
    `<div class="fid-head">${card.logo ? `<img src="${esc(card.logo)}" alt="">` : ''}<div><div class="fid-store">${esc(card.store)}</div><div class="fid-title">Badge du personnel</div></div></div>` +
    `<div class="fid-name">${esc(card.name)}</div><div class="fid-phone">${esc(card.role)}</div>` +
    `<div class="fid-code">${barcodeWithDigitsSvg(card.code, 70, 14)}</div></div>`;
  return loyaltyCardHtml({ store: '', customer: '', code: '' }).replace(/<div class="fid-grid">[\s\S]*$/, `<div class="fid-grid">${one}</div>`);
}
