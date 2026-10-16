/**
 * Règles de l'application d'inventaire, sans écran ni réseau : lecture du QR
 * code, recherche d'un code-barres, quantités en conditionnements, total d'un
 * produit par endroit. Les quantités sont en millièmes de l'unité de stock,
 * comme dans FEDONIX 360 (1 pièce = 1000, 1,5 kg = 1500).
 */

export interface Article {
  id: string;
  code: string;
  name: string;
  unit: 'piece' | 'kg' | 'litre' | string;
  unitName: string | null;
  otherRef: string | null;
  departmentId: string | null;
  barcodes: { code: string; packQty: number }[];
  packs: { name: string; units: number; barcode: string | null }[];
  thumb: string | null;
}

export interface Catalog {
  version: string;
  articles: Article[];
  departments: { id: string; name: string }[];
}

export interface Level {
  name: string;
  /** Unités de stock contenues (millièmes). */
  units: number;
}

/** Ce que désigne un code lu : l'article et, pour un code de carton, le conditionnement. */
export interface Hit {
  article: Article;
  /** Niveau de saisie proposé (index dans `levels`). */
  level: number;
  /** Quantité d'un scan, en millièmes (un carton de 24 : 24 000). */
  qty: number;
}

export interface Pairing {
  urls: string[];
  code: string;
}

/** QR code affiché par le gérant : « FEDONIX360:{"u":[adresses],"c":"CODE"} ». */
export function parsePairing(text: string): Pairing | null {
  const m = /^FEDONIX360:(\{.*\})$/s.exec(text.trim());
  if (!m) return null;
  try {
    const data = JSON.parse(m[1]!) as { u?: unknown; c?: unknown };
    const urls = (Array.isArray(data.u) ? data.u : []).filter((u): u is string => typeof u === 'string' && /^https?:\/\//.test(u));
    const code = typeof data.c === 'string' ? data.c : '';
    return urls.length && code ? { urls, code } : null;
  } catch {
    return null;
  }
}

/** Adresse saisie à la main : « 192.168.1.10 », « 192.168.1.10:3000 » ou une adresse complète. */
export function normalizeUrl(input: string): string | null {
  let s = input.trim().replace(/\/+$/, '');
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = `http://${s}`;
  try {
    const u = new URL(s);
    if (!u.port && u.protocol === 'http:' && /^\d+\.\d+\.\d+\.\d+$/.test(u.hostname)) u.port = '3000';
    return u.origin;
  } catch {
    return null;
  }
}

/** Cases de saisie : un conditionnement par case (carton, paquet…), puis l'unité. */
export function levels(a: Pick<Article, 'unit' | 'unitName' | 'packs'>): Level[] {
  if (a.unit !== 'piece') return [{ name: a.unit === 'kg' ? 'kg' : 'litres', units: 1000 }];
  return [...a.packs.map((p) => ({ name: p.name, units: p.units })), { name: a.unitName || 'Pièce', units: 1000 }];
}

/** Index des codes : code article, autre référence, codes-barres et codes des conditionnements. */
export function buildIndex(articles: Article[]): Map<string, Hit> {
  const index = new Map<string, Hit>();
  const add = (code: string | null | undefined, hit: Hit, strong: boolean) => {
    const k = code?.trim();
    if (!k) return;
    if (strong || !index.has(k)) index.set(k, hit);
  };
  for (const a of articles) {
    const lv = levels(a);
    const unitLevel = lv.length - 1;
    add(a.code, { article: a, level: unitLevel, qty: 1000 }, false);
    add(a.otherRef, { article: a, level: unitLevel, qty: 1000 }, false);
    a.packs.forEach((p, i) => add(p.barcode, { article: a, level: i, qty: p.units }, true));
    for (const b of a.barcodes) {
      const i = lv.findIndex((l) => l.units === b.packQty);
      add(b.code, { article: a, level: i >= 0 ? i : unitLevel, qty: b.packQty || 1000 }, true);
    }
  }
  return index;
}

/** Code lu par la caméra ou la douchette : aussi sans les zéros de tête (UPC-A lu en EAN-13). */
export function lookup(index: Map<string, Hit>, raw: string): Hit | null {
  const code = raw.trim();
  if (!code) return null;
  return index.get(code) ?? (code.startsWith('0') ? index.get(code.replace(/^0+/, '')) : index.get(`0${code}`)) ?? null;
}

const fold = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

/** Recherche par le nom (tous les mots, dans n'importe quel ordre) ou le début d'un code. */
export function search(articles: Article[], query: string, limit = 50): Article[] {
  const q = fold(query.trim());
  if (!q) return [];
  const words = q.split(/\s+/);
  const out: Article[] = [];
  for (const a of articles) {
    const name = fold(a.name);
    const hit = words.every((w) => name.includes(w)) || a.code.toLowerCase().startsWith(q) || a.barcodes.some((b) => b.code.startsWith(q)) || fold(a.otherRef ?? '').startsWith(q);
    if (hit) out.push(a);
    if (out.length >= limit) break;
  }
  return out;
}

/** Nombre tapé sur le téléphone : « 12 », « 1,5 », « 2.25 ». */
export function parseNumber(v: string): number | null {
  const s = v.trim().replace(/\s/g, '').replace(',', '.');
  if (!s) return 0;
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  return Number(s);
}

/** Total en millièmes des cases saisies ; null si une case est invalide. */
export function partsToQty(lv: Level[], parts: string[]): number | null {
  let total = 0;
  for (let i = 0; i < lv.length; i++) {
    const n = parseNumber(parts[i] ?? '');
    if (n === null) return null;
    total += Math.round(n * lv[i]!.units);
  }
  return total;
}

/** Nombres saisis dans chaque case, pour le détail envoyé au PC. */
export function partsToDetail(lv: Level[], parts: string[]): number[] | null {
  if (lv.length < 2) return null;
  const d = lv.map((_, i) => parseNumber(parts[i] ?? '') ?? 0);
  return d.every((n) => Number.isInteger(n)) ? d : null;
}

const nf = (n: number) => n.toLocaleString('fr-FR', { maximumFractionDigits: 3 });

/** « 2 CARTON + 3 » pour 51 pièces en cartons de 24 ; « 1,5 kg » au poids. */
export function formatQty(milli: number, a: Pick<Article, 'unit' | 'unitName' | 'packs'>): string {
  if (a.unit === 'kg') return `${nf(milli / 1000)} kg`;
  if (a.unit === 'litre') return `${nf(milli / 1000)} L`;
  const lv = levels(a);
  if (lv.length === 1 || milli < lv[lv.length - 2]!.units) return nf(milli / 1000);
  let rest = milli;
  const parts: string[] = [];
  for (let i = 0; i < lv.length; i++) {
    const l = lv[i]!;
    const n = i === lv.length - 1 ? rest / l.units : Math.floor(rest / l.units);
    rest -= Math.floor(n) * l.units;
    if (n > 0) parts.push(i === lv.length - 1 ? nf(n) : `${n} ${l.name}`);
  }
  return `${parts.join(' + ') || '0'} (${nf(milli / 1000)})`;
}

/** Comptage d'un produit à un endroit, sur ce téléphone. */
export interface PlaceCount {
  qty: number;
  detail: number[] | null;
  at: string;
}

export const placeKey = (inventoryId: string, articleId: string, location: string) => `${inventoryId}|${articleId}|${location}`;

/** Total d'un produit sur ce téléphone, tous endroits confondus. */
export function phoneTotal(counts: Record<string, PlaceCount>, inventoryId: string, articleId: string): { total: number; places: { location: string; qty: number }[] } {
  const prefix = `${inventoryId}|${articleId}|`;
  const places = Object.entries(counts)
    .filter(([k]) => k.startsWith(prefix))
    .map(([k, v]) => ({ location: k.slice(prefix.length), qty: v.qty }));
  return { total: places.reduce((t, p) => t + p.qty, 0), places };
}

/** Somme de deux détails de même forme (ajout de 2 cartons à 1 carton + 3). */
export function addDetail(a: number[] | null, b: number[] | null): number[] | null {
  if (!a || !b || a.length !== b.length) return null;
  return a.map((n, i) => n + b[i]!);
}

/** Identifiant unique d'une saisie (le serveur ignore une saisie reçue deux fois). */
export function newId(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c?.randomUUID) return c.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}-${Math.random().toString(36).slice(2, 12)}`;
}
