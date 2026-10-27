import { type Fcfa, formatFcfa } from './money';

/** Une affichette de promotion à poser en rayon ou en vitrine. */
export interface PromoPoster {
  name: string;
  /** Offre en gros caractères : « PROMO », « 3 POUR 2 ». */
  offer: string;
  /** Prix promo (ou du lot) affiché en très grand. */
  price: Fcfa | null;
  /** Ancien prix, barré. */
  oldPrice: Fcfa | null;
  /** « Soit 1 111 F le kg ». */
  unitPrice: string | null;
  /** « Du 01/11 au 15/11 ». */
  dates: string;
  store: string | null;
}

export type PosterSize = 'a4' | 'a5';
export const POSTER_SIZES: Record<PosterSize, string> = { a4: 'A4 (une par page)', a5: 'A5 (deux par page A4)' };

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/**
 * Affichettes de promotion : grand prix, ancien prix barré, offre, dates et
 * prix au kilo. A4 : une par page en portrait ; A5 : deux par page A4 posée à
 * l'horizontale, à couper en deux. Le même HTML sert à l'aperçu et à l'impression.
 */
export function promoPostersHtml(posters: readonly PromoPoster[], size: PosterSize): string {
  const a5 = size === 'a5';
  const w = a5 ? 148 : 210;
  const h = a5 ? 210 : 297;
  const k = a5 ? 0.7 : 1;
  const one = (p: PromoPoster) => `<div class="poster">
  <div class="offer">${esc(p.offer)}</div>
  <div class="name">${esc(p.name)}</div>
  ${p.oldPrice ? `<div class="old">Au lieu de <s>${formatFcfa(p.oldPrice, false)} F</s></div>` : ''}
  ${p.price !== null ? `<div class="price">${formatFcfa(p.price, false)}<small> F</small></div>` : ''}
  ${p.unitPrice ? `<div class="unit">Soit ${esc(p.unitPrice)}</div>` : ''}
  <div class="dates">${esc(p.dates)}</div>
  ${p.store ? `<div class="store">${esc(p.store)}</div>` : ''}
</div>`;
  const pages: string[] = [];
  const perPage = a5 ? 2 : 1;
  for (let i = 0; i < posters.length; i += perPage) pages.push(`<div class="page">${posters.slice(i, i + perPage).map(one).join('')}</div>`);
  const style = `
@page { size: ${a5 ? '297mm 210mm' : '210mm 297mm'}; margin: 0; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body { font-family: Arial, Helvetica, sans-serif; color: #000; }
.page { width: ${a5 ? 297 : 210}mm; height: ${a5 ? 210 : 297}mm; display: flex; break-after: page; overflow: hidden; }
.page:last-child { break-after: auto; }
.poster { width: ${w}mm; height: ${h}mm; padding: ${12 * k}mm ${10 * k}mm; display: flex; flex-direction: column; align-items: center; text-align: center;
  border: ${a5 ? '0.3mm dashed #999' : 'none'}; }
.offer { background: #d00; color: #fff; font-weight: 900; font-size: ${26 * k}mm; line-height: 1; padding: ${4 * k}mm ${10 * k}mm; border-radius: ${4 * k}mm; letter-spacing: 1mm; }
.name { font-size: ${15 * k}mm; font-weight: bold; line-height: 1.1; margin-top: ${12 * k}mm; max-height: ${52 * k}mm; overflow: hidden; }
.old { font-size: ${11 * k}mm; margin-top: ${10 * k}mm; color: #333; }
.old s { color: #000; }
.price { font-size: ${58 * k}mm; font-weight: 900; line-height: 1; margin-top: ${6 * k}mm; color: #d00; white-space: nowrap; }
.price small { font-size: ${22 * k}mm; }
.unit { font-size: ${9 * k}mm; margin-top: ${4 * k}mm; }
.dates { margin-top: auto; font-size: ${10 * k}mm; font-weight: bold; }
.store { font-size: ${6 * k}mm; color: #444; margin-top: ${3 * k}mm; }
`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>Affichettes</title><style>${style}</style></head><body>${pages.join('')}</body></html>`;
}
