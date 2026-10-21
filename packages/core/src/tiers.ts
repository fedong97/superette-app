/**
 * Tarifs par quantité et remises du client par famille (catégories tarifaires
 * de Sage). Les deux baissent le prix de la ligne, sans remise à faire valider :
 * ce sont des prix convenus à l'avance. Le même calcul sert à l'écran de caisse
 * et à l'enregistrement de la vente.
 */
import type { Fcfa } from './money';
import type { Milli } from './quantity';

/** Prix de l'unité de détail à partir d'une quantité (« 480 F à partir de 12 »). */
export interface QtyTier {
  /** Quantité minimale de la ligne, en millièmes (12 000 = 12 unités). */
  minQty: Milli;
  /** Prix TTC de l'unité de détail à partir de cette quantité. */
  price: Fcfa;
}

/** Remises par famille d'articles : identifiant de la famille → points de base (300 = 3 %). */
export type FamilyDiscounts = Record<string, number>;

/** Prix négociés d'un client : identifiant de l'article → prix TTC de l'unité de détail. */
export type ArticlePrices = Record<string, Fcfa>;

/** Paliers lus sans jamais échouer, du plus petit au plus grand. */
export function parseQtyTiers(json: string | null | undefined): QtyTier[] {
  if (!json) return [];
  try {
    const raw = JSON.parse(json) as unknown;
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((t): t is QtyTier => !!t && Number.isSafeInteger((t as QtyTier).minQty) && Number.isSafeInteger((t as QtyTier).price))
      .filter((t) => t.minQty > 0 && t.price > 0)
      .sort((a, b) => a.minQty - b.minQty);
  } catch {
    return [];
  }
}

/** Remises par famille lues sans jamais échouer. */
export function parseFamilyDiscounts(json: string | null | undefined): FamilyDiscounts {
  if (!json) return {};
  try {
    const raw = JSON.parse(json) as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    return Object.fromEntries(Object.entries(raw as Record<string, unknown>).filter((e): e is [string, number] => Number.isSafeInteger(e[1]) && (e[1] as number) > 0 && (e[1] as number) < 10_000));
  } catch {
    return {};
  }
}

/** Prix négociés lus sans jamais échouer. */
export function parseArticlePrices(json: string | null | undefined): ArticlePrices {
  if (!json) return {};
  try {
    const raw = JSON.parse(json) as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    return Object.fromEntries(Object.entries(raw as Record<string, unknown>).filter((e): e is [string, number] => Number.isSafeInteger(e[1]) && (e[1] as number) > 0));
  } catch {
    return {};
  }
}

/** Contrôle des paliers avant enregistrement ; renvoie le message d'erreur ou null. */
export function checkQtyTiers(tiers: readonly QtyTier[], retail: Fcfa): string | null {
  if (tiers.length > 5) return 'Cinq prix par quantité au plus';
  let last: QtyTier | null = null;
  for (const t of [...tiers].sort((a, b) => a.minQty - b.minQty)) {
    if (!Number.isSafeInteger(t.minQty) || t.minQty <= 1000) return 'Un prix par quantité commence à partir de 2 unités';
    if (!Number.isSafeInteger(t.price) || t.price <= 0) return 'Prix par quantité invalide';
    if (t.price >= retail) return 'Un prix par quantité doit être plus bas que le prix de détail';
    if (last && t.minQty === last.minQty) return 'Deux prix pour la même quantité';
    if (last && t.price >= last.price) return 'Plus la quantité est grande, plus le prix doit baisser';
    last = t;
  }
  return null;
}

/** Prix de l'unité pour cette quantité : le palier atteint le plus bas, sans jamais remonter au-dessus du prix donné. */
export function tierPrice(base: Fcfa, tiers: readonly QtyTier[], qty: Milli): Fcfa {
  let price = base;
  for (const t of tiers) if (qty >= t.minQty && t.price < price) price = t.price;
  return price;
}

/** Prix après la remise du client sur la famille de l'article (arrondi au franc). */
export function familyPrice(price: Fcfa, discounts: FamilyDiscounts, familyId: string | null | undefined): Fcfa {
  const bp = familyId ? (discounts[familyId] ?? 0) : 0;
  return bp > 0 ? Math.round((price * (10_000 - bp)) / 10_000) : price;
}

/**
 * Prix convenus d'une ligne de ticket : palier de quantité sur l'unité de
 * détail, puis remise du client sur la famille (unité ou conditionnement).
 * Un prix saisi à la caisse n'est pas touché.
 */
export function agreedPrices<L extends { unitPrice: Fcfa; packPrice?: Fcfa; packUnits?: Milli; qty: Milli; priceSet?: boolean }>(
  line: L,
  article: { tiers: readonly QtyTier[]; familyId: string | null; id?: string },
  discounts: FamilyDiscounts,
  /** Prix négociés du client par article : ils remplacent paliers et remises quand ils sont plus bas. */
  negotiated: ArticlePrices = {},
): L {
  if (line.priceSet) return line;
  const deal = article.id ? negotiated[article.id] : undefined;
  if (line.packPrice !== undefined) {
    const usual = familyPrice(line.packPrice, discounts, article.familyId);
    const dealPack = deal !== undefined && line.packUnits ? Math.round((deal * line.packUnits) / 1000) : undefined;
    return { ...line, packPrice: dealPack !== undefined && dealPack < usual ? dealPack : usual };
  }
  const usual = familyPrice(tierPrice(line.unitPrice, article.tiers, line.qty), discounts, article.familyId);
  return { ...line, unitPrice: deal !== undefined && deal < usual ? deal : usual };
}
