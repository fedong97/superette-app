import type { Fcfa } from './money';
import type { Milli } from './quantity';

/**
 * Conditionnements d'un article, du plus grand au plus petit, sur le modèle de
 * KONTROL : un carton contient 10 paquets, un paquet contient 10 ampoules.
 * L'unité de détail (l'ampoule) est l'article lui-même : le stock est toujours
 * tenu dans cette unité, les conditionnements n'en sont que des multiples.
 */

/** Tarifs : détail (comptoir), gros et super gros (clients revendeurs). */
export type PriceLevel = 'retail' | 'wholesale' | 'super_wholesale';

export const PRICE_LEVELS: Record<PriceLevel, string> = {
  retail: 'Détail',
  wholesale: 'Gros',
  super_wholesale: 'Super gros',
};

export interface Tariff {
  retail: Fcfa;
  /** Prix de gros ; vide = prix de détail. */
  wholesale: Fcfa | null;
  /** Prix super gros ; vide = prix de gros. */
  superWholesale: Fcfa | null;
}

/** Prix d'un tarif, en retombant sur le niveau inférieur quand il n'est pas renseigné. */
export function tariffPrice(t: Tariff, level: PriceLevel): Fcfa {
  if (level === 'super_wholesale') return t.superWholesale ?? t.wholesale ?? t.retail;
  if (level === 'wholesale') return t.wholesale ?? t.retail;
  return t.retail;
}

export interface PackLevel {
  name: string;
  /** Nombre de conditionnements du niveau suivant (ou d'unités de détail pour le dernier) contenus. */
  contains: number;
}

/**
 * Unités de détail contenues dans chaque conditionnement (en millièmes), calculées
 * de proche en proche : carton = 10 paquets × 10 ampoules = 100 ampoules.
 */
export function packUnits(levels: readonly PackLevel[]): Milli[] {
  const out: Milli[] = [];
  let units = 1000;
  for (let i = levels.length - 1; i >= 0; i--) {
    units *= levels[i]!.contains;
    out[i] = units;
  }
  return out;
}

/** Contrôle des conditionnements avant enregistrement ; renvoie le message d'erreur ou null. */
export function checkPacks(levels: readonly (PackLevel & { salePrice: Fcfa })[], unit: 'piece' | 'kg' | 'litre'): string | null {
  if (levels.length > 0 && unit !== 'piece') return 'Les conditionnements ne valent que pour les articles vendus à la pièce';
  if (levels.length > 3) return 'Trois conditionnements au plus au-dessus de l’unité de détail';
  const names = new Set<string>();
  for (const l of levels) {
    if (!l.name.trim()) return 'Donnez un nom à chaque conditionnement';
    const key = l.name.trim().toLowerCase();
    if (names.has(key)) return `Conditionnement « ${l.name.trim()} » en double`;
    names.add(key);
    if (!Number.isSafeInteger(l.contains) || l.contains < 2 || l.contains > 10_000) return `Contenu du conditionnement « ${l.name.trim()} » invalide (2 à 10 000)`;
    if (!Number.isSafeInteger(l.salePrice) || l.salePrice <= 0) return `Prix de vente du conditionnement « ${l.name.trim()} » invalide`;
  }
  return null;
}

/**
 * Quantité exprimée en conditionnements : 234 ampoules = « 2 Carton 3 Paquet 4 Ampoule ».
 * `packs` du plus grand au plus petit.
 */
export function describeInPacks(qty: Milli, packs: readonly { name: string; units: Milli }[], unitName: string): string {
  if (qty <= 0 || packs.length === 0 || qty % 1000 !== 0) return '';
  let left = qty;
  const parts: string[] = [];
  for (const p of packs) {
    const n = Math.floor(left / p.units);
    if (n > 0) parts.push(`${n} ${p.name}`);
    left -= n * p.units;
  }
  if (left > 0) parts.push(`${left / 1000} ${unitName}`);
  return parts.join(' ');
}

/**
 * Fiche KONTROL : chaque conditionnement de vente donne son diviseur par rapport
 * au conditionnement d'achat (PALETTE 1, PACK 4, CANETTE 24). Renvoie ce que
 * contient chaque niveau sauf le dernier (PALETTE 4 PACK, PACK 6 CANETTE), ou le
 * message d'erreur.
 */
export function containsFromDivisors(levels: readonly { name: string; divisor: number }[]): number[] | string {
  if (levels.length === 0) return 'Indiquez le conditionnement d’achat';
  if (levels[0]!.divisor !== 1) return 'Le conditionnement d’achat a toujours le diviseur 1';
  const out: number[] = [];
  for (let i = 1; i < levels.length; i++) {
    const prev = levels[i - 1]!;
    const l = levels[i]!;
    const name = l.name.trim() || `n° ${i + 1}`;
    if (!Number.isSafeInteger(l.divisor) || l.divisor < 2 || l.divisor > 10_000) return `Diviseur du conditionnement « ${name} » invalide (2 à 10 000)`;
    if (l.divisor <= prev.divisor) return `Les conditionnements vont du plus grand au plus petit : le diviseur de « ${name} » doit dépasser ${prev.divisor}`;
    if (l.divisor % prev.divisor !== 0) return `Le diviseur de « ${name} » (${l.divisor}) doit être un multiple de celui de « ${prev.name.trim()} » (${prev.divisor})`;
    out.push(l.divisor / prev.divisor);
  }
  return out;
}

/** Part d'un prix du conditionnement d'achat revenant à un conditionnement plus petit : 17 000 / 24 = 708. */
export function dividePrice(price: Fcfa, divisor: number): Fcfa {
  return Math.round(price / divisor);
}
