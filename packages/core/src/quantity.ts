/**
 * Quantités stockées en millièmes d'unité (entiers) : 1 pièce = 1000,
 * 1,250 kg = 1250. Évite les erreurs d'arrondi des flottants sur le stock.
 */
export type Milli = number;

export const ONE: Milli = 1000;

export function toMilli(units: number): Milli {
  return Math.round(units * 1000);
}

export function fromMilli(qty: Milli): number {
  return qty / 1000;
}

export function formatQty(qty: Milli, unit: 'piece' | 'kg' | 'litre' = 'piece'): string {
  if (unit === 'piece' && qty % 1000 === 0) return String(qty / 1000);
  const value = (qty / 1000).toLocaleString('fr-FR', { minimumFractionDigits: 3, maximumFractionDigits: 3 });
  return unit === 'piece' ? value : `${value} ${unit === 'kg' ? 'kg' : 'L'}`;
}

/** Prix d'une ligne : prix unitaire × quantité, arrondi au franc. */
export function lineAmount(unitPrice: number, qty: Milli): number {
  return Math.round((unitPrice * qty) / 1000);
}
