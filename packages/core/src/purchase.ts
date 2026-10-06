import type { Milli } from './quantity';

export interface ReorderInput {
  /** Stock du magasin, tous dépôts. */
  stock: Milli;
  /** Quantité commandée et pas encore reçue. */
  onOrder: Milli;
  /** Ventes moyennes par jour sur la période observée. */
  avgDailySales: Milli;
  /** Délai de livraison du fournisseur, en jours. */
  leadTimeDays: number;
  /** Jours de vente à couvrir après la livraison. */
  coverDays: number;
  minQty?: Milli | null;
  alertQty?: Milli | null;
  maxQty?: Milli | null;
  /** Colisage fournisseur : on commande par multiples de cette quantité. */
  packQty?: Milli;
}

export interface ReorderSuggestion {
  reorderPoint: Milli;
  target: Milli;
  qty: Milli;
}

/**
 * Proposition de commande : on commande quand le stock disponible (stock +
 * commandes en cours) passe sous le point de commande, c'est-à-dire le plus
 * grand du stock d'alerte (ou minimum) et des ventes attendues pendant le
 * délai de livraison. On remonte alors au stock maximum, ou à défaut à de quoi
 * couvrir le délai plus `coverDays` jours de vente, arrondi au colis.
 */
export function suggestReorder(i: ReorderInput): ReorderSuggestion {
  const leadDemand = Math.ceil(i.avgDailySales * i.leadTimeDays);
  const reorderPoint = Math.max(i.alertQty ?? i.minQty ?? 0, leadDemand);
  const target = Math.max(i.maxQty ?? 0, Math.ceil(i.avgDailySales * (i.leadTimeDays + i.coverDays)), reorderPoint);
  const available = i.stock + i.onOrder;
  if (available > reorderPoint || target <= available) return { reorderPoint, target, qty: 0 };
  const pack = i.packQty && i.packQty > 0 ? i.packQty : 1000;
  const qty = Math.ceil((target - available) / pack) * pack;
  return { reorderPoint, target, qty };
}

/** Date d'échéance : date de facture + délai de paiement du fournisseur. */
export function dueDate(invoiceDate: string, termsDays: number): string {
  return new Date(Date.parse(`${invoiceDate}T00:00:00Z`) + termsDays * 86_400_000).toISOString().slice(0, 10);
}
