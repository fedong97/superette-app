import { type Fcfa } from './money';
import { type Milli } from './quantity';

/**
 * Coût moyen unitaire pondéré (CMUP) après une entrée, comme Sage 100.
 * Un stock négatif ou nul avant l'entrée prend le coût de l'entrée.
 */
export function weightedAverageCost(
  stockQty: Milli,
  stockCost: Fcfa,
  inQty: Milli,
  inCost: Fcfa,
): Fcfa {
  if (inQty <= 0) return stockCost;
  if (stockQty <= 0) return inCost;
  return Math.round((stockQty * stockCost + inQty * inCost) / (stockQty + inQty));
}

export interface Lot {
  id: string;
  qty: Milli;
  /** Date limite (AAAA-MM-JJ) ; null si l'article n'est pas périssable. */
  expiry: string | null;
  receivedAt: string;
}

export interface LotAllocation {
  allocations: { lotId: string; qty: Milli }[];
  /** Quantité vendue sans lot disponible (le stock passera en négatif). */
  unallocated: Milli;
}

/**
 * Sortie FEFO : premier périmé, premier sorti ; à date égale ou sans date,
 * le plus ancien reçu sort d'abord. La caisse ne bloque jamais une vente :
 * le reliquat non couvert est signalé pour l'inventaire.
 */
export function allocateFefo(lots: readonly Lot[], qty: Milli): LotAllocation {
  const sorted = lots
    .filter((l) => l.qty > 0)
    .sort((a, b) => {
      if (a.expiry !== b.expiry) {
        if (a.expiry === null) return 1;
        if (b.expiry === null) return -1;
        return a.expiry < b.expiry ? -1 : 1;
      }
      return a.receivedAt < b.receivedAt ? -1 : a.receivedAt > b.receivedAt ? 1 : 0;
    });
  const allocations: { lotId: string; qty: Milli }[] = [];
  let left = qty;
  for (const lot of sorted) {
    if (left <= 0) break;
    const take = Math.min(lot.qty, left);
    allocations.push({ lotId: lot.id, qty: take });
    left -= take;
  }
  return { allocations, unallocated: left };
}

export type StockLevel = 'rupture' | 'alerte' | 'normal' | 'surstock';

export function stockLevel(
  qty: Milli,
  thresholds: { alert: Milli | null; max: Milli | null },
): StockLevel {
  if (qty <= 0) return 'rupture';
  if (thresholds.alert !== null && qty <= thresholds.alert) return 'alerte';
  if (thresholds.max !== null && qty > thresholds.max) return 'surstock';
  return 'normal';
}

export const MOVEMENT_TYPES = {
  RECEPTION: 'Réception',
  SALE: 'Vente',
  RETURN: 'Retour client',
  TRANSFER_OUT: 'Transfert sortant',
  TRANSFER_IN: 'Transfert entrant',
  BREAKAGE: 'Casse',
  THEFT: 'Vol constaté',
  EXPIRY: 'Péremption',
  INTERNAL_USE: 'Consommation interne',
  INVENTORY_ADJUST: "Écart d'inventaire",
  REGULARIZATION: 'Régularisation (vendu sans stock)',
} as const;

export type MovementType = keyof typeof MOVEMENT_TYPES;

/** Types de sortie manuelle autorisés (pertes, avec motif obligatoire). */
export const LOSS_TYPES: MovementType[] = ['BREAKAGE', 'THEFT', 'EXPIRY', 'INTERNAL_USE'];
