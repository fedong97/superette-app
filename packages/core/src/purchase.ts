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

/** Conditions d'une ligne d'achat : remise en % et unités gratuites (« N achetés, M payés »). */
export interface PurchaseTerms {
  qty: Milli;
  /** Prix d'achat unitaire HT avant remise. */
  unitCost: number;
  /** Remise en points de base (1 000 = 10 %). */
  discountBp?: number;
  /** Quantité reçue gratuitement (comprise dans qty). */
  freeQty?: Milli;
}

export interface PurchaseAmounts {
  /** Prix × quantité, avant promo et remise. */
  gross: number;
  /** Valeur des unités gratuites. */
  free: number;
  /** Remise en % sur le montant payé. */
  discount: number;
  /** Montant HT net de la ligne. */
  net: number;
  /** Coût unitaire net qui entre en stock (gratuits et remise compris). */
  netUnitCost: number;
}

/**
 * Montants d'une ligne d'achat. Les unités gratuites ne se paient pas, la
 * remise s'applique au reste : le coût qui entre en stock est le net divisé
 * par toute la quantité reçue, gratuits compris.
 */
export function purchaseAmounts(t: PurchaseTerms): PurchaseAmounts {
  const free = Math.min(Math.max(0, t.freeQty ?? 0), t.qty);
  const gross = Math.round((t.unitCost * t.qty) / 1000);
  const paid = Math.round((t.unitCost * (t.qty - free)) / 1000);
  const discount = Math.round((paid * Math.min(10_000, Math.max(0, t.discountBp ?? 0))) / 10_000);
  const net = paid - discount;
  return { gross, free: gross - paid, discount, net, netUnitCost: t.qty > 0 ? Math.round((net * 1000) / t.qty) : 0 };
}

/** Erreur de saisie d'une ligne d'achat (remise ou gratuits), sinon null. */
export function purchaseTermsError(t: PurchaseTerms): string | null {
  const bp = t.discountBp ?? 0;
  if (!Number.isSafeInteger(bp) || bp < 0 || bp > 10_000) return 'Remise invalide : entre 0 et 100 %';
  const free = t.freeQty ?? 0;
  if (!Number.isSafeInteger(free) || free < 0) return 'Quantité gratuite invalide';
  if (free > t.qty) return 'Plus de gratuits que de quantité reçue';
  return null;
}

/**
 * Promo « N achetés, M payés » : nombre d'unités gratuites dans `count`
 * unités (cartons, pièces), par tranche complète de N. 12 achetés 10 payés
 * sur 30 : deux tranches, 4 gratuits.
 */
export function promoFree(count: number, buy: number, pay: number): number {
  if (!(buy > 0) || !(pay >= 0) || pay >= buy || !(count > 0)) return 0;
  return Math.floor(count / buy) * (buy - pay);
}

/**
 * Remise globale répartie sur les lignes au prorata de leur net ; la dernière
 * ligne prend l'arrondi. Le total des parts vaut toujours la remise.
 */
export function spreadDiscount(nets: number[], discount: number): number[] {
  const total = nets.reduce((t, n) => t + n, 0);
  if (total <= 0 || discount <= 0) return nets.map(() => 0);
  let left = discount;
  return nets.map((n, i) => {
    const part = i === nets.length - 1 ? left : Math.round((discount * n) / total);
    left -= part;
    return part;
  });
}
