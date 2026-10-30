/**
 * Lecture d'une page du carnet de coupure : des probabilités de chiffres case
 * par case jusqu'aux ventes proposées au caissier. Le catalogue sert de garde-fou :
 * un code d'article se lit parmi les codes qui existent, un prix s'accorde au
 * prix du catalogue quand l'écriture le permet, une heure doit tomber pendant
 * la coupure. Ce qui reste incertain est signalé, jamais deviné en silence.
 */
import { readDigit } from './digitNet';
import type { Fcfa } from './money';
import { BOOK_MARKERS, type BookField, type GrayImage, bookBoxes, cellInk, cellToDigit, findMarkers, homography } from './outageBook';
import type { Milli } from './quantity';

/** Probabilités 0 à 9 d'une case, ou `null` pour une case vide. */
export type CellRead = number[] | null;

export interface PageCells {
  /** Lignes 0 à 19 : les cases de chaque zone, de gauche à droite. */
  rows: Record<BookField, CellRead[]>[];
  total: CellRead[];
  /** Page (mm) vers photo (points) : sert à montrer chaque case dans la vérification. */
  pageToPhoto: number[];
}

/** Lit toutes les cases de la photo. `null` : les quatre carrés des coins ne sont pas trouvés. */
export function readBookCells(img: GrayImage): PageCells | null {
  const markers = findMarkers(img);
  if (!markers) return null;
  const pageToPhoto = homography([...BOOK_MARKERS], markers);
  const rows: Record<BookField, CellRead[]>[] = [];
  const total: CellRead[] = [];
  for (const box of bookBoxes()) {
    const digit = cellToDigit(cellInk(img, pageToPhoto, box));
    const read = digit ? readDigit(digit) : null;
    if (box.field === 'total') {
      total[box.index] = read;
      continue;
    }
    const row = (rows[box.row] ??= { sale: [], hour: [], minute: [], code: [], qty: [], qtyDec: [], price: [] });
    row[box.field][box.index] = read;
  }
  return { rows, total, pageToPhoto };
}

/** Un article du carnet : son code, ce qu'il désigne et son prix au catalogue. */
export interface BookArticle {
  code: number;
  articleId: string;
  packId: string | null;
  units: Milli;
  label: string;
  unit: 'piece' | 'kg' | 'litre';
  price: Fcfa;
}

export type DoubtReason = 'code' | 'unknown_code' | 'qty' | 'price' | 'price_differs' | 'time' | 'time_outside' | 'sale';

export interface ReadLine {
  /** Ligne du carnet (1 à 20). */
  row: number;
  sale: number | null;
  /** Heure lue ou reprise de la ligne précédente, « HH:MM ». */
  time: string | null;
  code: number | null;
  article: BookArticle | null;
  /** En unités de détail (millièmes), conditionnement compris. */
  qty: Milli;
  /** Prix de l'unité ou du conditionnement écrit. */
  price: Fcfa | null;
  /** Ce qui reste à vérifier sur la ligne ; vide = lecture sûre. */
  doubts: DoubtReason[];
}

export interface ReadSale {
  sale: number | null;
  time: string | null;
  lines: ReadLine[];
  total: Fcfa;
}

export interface PageReading {
  lines: ReadLine[];
  sales: ReadSale[];
  /** Total de la page écrit par le caissier, s'il est lisible, et la somme des lignes. */
  writtenTotal: Fcfa | null;
  writtenTotalSure: boolean;
  computedTotal: Fcfa;
}

/** Au-dessous, un chiffre est douteux (le réseau, appris avec un léger lissage, ne dépasse guère 0,96). */
const SURE = 0.8;

const filled = (cells: CellRead[]) => cells.filter((c): c is number[] => c !== null);
const argmax = (p: number[]) => p.reduce((b, v, i) => (v > p[b]! ? i : b), 0);

/** Nombre lu sans contrainte : chiffre le plus probable de chaque case remplie. */
function freeNumber(cells: CellRead[]): { value: number; sure: boolean } | null {
  const f = filled(cells);
  if (f.length === 0) return null;
  let value = 0;
  let sure = true;
  for (const p of f) {
    const d = argmax(p);
    value = value * 10 + d;
    if (p[d]! < SURE) sure = false;
  }
  return { value, sure };
}

/** Probabilité que les cases remplies portent exactement ces chiffres. */
function scoreDigits(cells: number[][], digits: string): number {
  if (digits.length !== cells.length) return 0;
  let s = 1;
  for (let i = 0; i < digits.length; i++) s *= cells[i]![digits.charCodeAt(i) - 48]!;
  return s;
}

/**
 * Le meilleur choix parmi des valeurs permises (codes existants, heures
 * valides). Sûr si sa probabilité est bonne et nettement au-dessus de la suivante.
 */
function bestOf<T>(cells: CellRead[], options: { digits: string[]; value: T }[]): { value: T; sure: boolean } | null {
  const f = filled(cells);
  if (f.length === 0) return null;
  let best: { value: T; score: number } | null = null;
  let second = 0;
  for (const o of options) {
    let score = 0;
    for (const d of o.digits) score = Math.max(score, scoreDigits(f, d));
    if (score <= 0) continue;
    if (!best || score > best.score) {
      second = best?.score ?? 0;
      best = { value: o.value, score };
    } else if (score > second) second = score;
  }
  if (!best) return null;
  return { value: best.value, sure: best.score >= 0.5 && best.score >= 10 * second };
}

/** Heures permises : celles de la coupure, à la minute (une coupure de plus d'un jour est rare : on accepte tout le jour). */
function timeOptions(cells: CellRead[], minutes: Set<number> | null): { digits: string[]; value: number }[] {
  const out: { digits: string[]; value: number }[] = [];
  for (let h = 0; h < 24; h++) {
    for (let m = 0; m < 60; m++) {
      const v = h * 60 + m;
      if (minutes && !minutes.has(v)) continue;
      out.push({ value: v, digits: [`${String(h).padStart(2, '0')}${String(m).padStart(2, '0')}`, `${h}${String(m).padStart(2, '0')}`] });
    }
  }
  return cells.length ? out : [];
}

const hhmm = (v: number) => `${String(Math.floor(v / 60)).padStart(2, '0')}:${String(v % 60).padStart(2, '0')}`;

/**
 * Ventes proposées à partir des cases lues.
 * `window` : minutes du jour (0 à 1439) que couvre la coupure, d'après son début et sa fin.
 */
export function decodeBookPage(cells: PageCells, catalogue: BookArticle[], window: { from: number; to: number } | null): PageReading {
  const byCode = new Map(catalogue.map((a) => [a.code, a]));
  const codeOptions = catalogue.map((a) => ({ value: a.code, digits: [String(a.code).padStart(4, '0'), String(a.code)] }));
  let inWindow: Set<number> | null = null;
  if (window) {
    inWindow = new Set();
    // Coupure qui passe minuit : de « from » à 23:59 puis de 00:00 à « to ».
    if (window.to >= window.from) for (let v = window.from; v <= window.to; v++) inWindow.add(v);
    else {
      for (let v = window.from; v < 1440; v++) inWindow.add(v);
      for (let v = 0; v <= window.to; v++) inWindow.add(v);
    }
  }
  const lines: ReadLine[] = [];
  let lastSale: number | null = null;
  let lastTime: string | null = null;
  cells.rows.forEach((r, i) => {
    if (filled(r.code).length === 0 && filled(r.qty).length === 0 && filled(r.price).length === 0) return;
    const doubts: DoubtReason[] = [];
    // N° de vente : vide = celle de la ligne précédente.
    const saleRead = freeNumber(r.sale);
    if (saleRead && !saleRead.sure) doubts.push('sale');
    const sale = saleRead ? saleRead.value : lastSale;
    // Heure : vide = celle de la ligne précédente ; lue parmi les minutes de la coupure, sinon de la journée.
    const timeCells = [...r.hour, ...r.minute];
    let time = lastTime;
    if (filled(timeCells).length > 0) {
      const any = bestOf(timeCells, timeOptions(timeCells, null));
      const inside = inWindow ? bestOf(timeCells, timeOptions(timeCells, inWindow)) : null;
      if (inside && (!any || inside.value === any.value)) {
        time = hhmm(inside.value);
        if (!inside.sure) doubts.push('time');
      } else if (any) {
        // L'écriture se lit mieux comme une heure hors de la coupure : on le dit.
        time = hhmm(any.value);
        if (inWindow) doubts.push('time_outside');
        else if (!any.sure) doubts.push('time');
      } else doubts.push('time');
    }
    // Code : seulement parmi les codes qui existent.
    let article: BookArticle | null = null;
    let code: number | null = null;
    const codeRead = bestOf(r.code, codeOptions);
    if (codeRead) {
      code = codeRead.value;
      article = byCode.get(code) ?? null;
      if (!codeRead.sure) doubts.push('code');
    } else {
      const free = freeNumber(r.code);
      code = free?.value ?? null;
      doubts.push('unknown_code');
    }
    // Quantité : vide = 1 ; décimales pour le kilo et le litre.
    const q = freeNumber(r.qty);
    const dec = filled(r.qtyDec);
    let qty: Milli = (q?.value ?? (dec.length ? 0 : 1)) * 1000;
    if (q && !q.sure) doubts.push('qty');
    if (dec.length) {
      const d = freeNumber(r.qtyDec)!;
      qty += dec.length === 1 ? d.value * 100 : d.value * 10;
      if (!d.sure && !doubts.includes('qty')) doubts.push('qty');
    }
    if (qty <= 0) {
      qty = 1000;
      if (!doubts.includes('qty')) doubts.push('qty');
    }
    if (article && article.units !== 1000) qty *= article.units / 1000;
    // Prix : celui du catalogue s'il colle à l'écriture ; sinon ce qui est écrit, signalé.
    let price: Fcfa | null = null;
    const priceCells = filled(r.price);
    if (priceCells.length === 0) {
      price = article?.price ?? null;
      if (!article) doubts.push('price');
    } else {
      const free = freeNumber(r.price)!;
      const best = priceCells.reduce((s, p) => s * p[argmax(p)]!, 1);
      const catalog = article ? scoreDigits(priceCells, String(article.price)) : 0;
      if (article && free.value === article.price) {
        price = article.price;
        if (!free.sure) doubts.push('price');
      } else if (article && catalog >= best * 0.05) {
        price = article.price;
        if (catalog < best * 0.3) doubts.push('price');
      } else {
        price = free.value;
        if (!free.sure) doubts.push('price');
        if (article) doubts.push('price_differs');
      }
    }
    lines.push({ row: i + 1, sale, time, code, article, qty, price, doubts });
    lastSale = sale;
    lastTime = time;
  });
  // Ventes : lignes qui se suivent avec le même n° (ou sans n° du tout).
  const sales: ReadSale[] = [];
  for (const l of lines) {
    const cur = sales[sales.length - 1];
    if (cur && cur.sale === l.sale) cur.lines.push(l);
    else sales.push({ sale: l.sale, time: l.time, lines: [l], total: 0 });
  }
  for (const s of sales) s.total = s.lines.reduce((t, l) => t + readLineAmount(l), 0);
  const computedTotal = sales.reduce((t, s) => t + s.total, 0);
  const tot = freeNumber(cells.total);
  return { lines, sales, writtenTotal: tot?.value ?? null, writtenTotalSure: tot?.sure ?? false, computedTotal };
}

/** Montant d'une ligne lue : prix du conditionnement ou de l'unité, fois la quantité écrite. */
export function readLineAmount(l: Pick<ReadLine, 'qty' | 'price' | 'article'>): Fcfa {
  if (l.price === null) return 0;
  const units = l.article?.units ?? 1000;
  return Math.round((l.price * l.qty) / units);
}

export const DOUBT_LABEL: Record<DoubtReason, string> = {
  code: 'Code peu lisible',
  unknown_code: 'Code introuvable dans la liste',
  qty: 'Quantité peu lisible',
  price: 'Prix peu lisible',
  price_differs: 'Prix différent du catalogue',
  time: 'Heure peu lisible',
  time_outside: 'Heure hors de la coupure',
  sale: 'N° de vente peu lisible',
};
