import type { CartLine } from './cart';
import type { Fcfa } from './money';
import { lineAmount } from './quantity';

/**
 * Promotions appliquées automatiquement en caisse :
 * - `price` : prix promotionnel à l'unité (ou au kg) pendant la période ;
 * - `x_for_y` : N achetés, M payés (« 3 pour 2 ») ;
 * - `lot` : N pour un prix fixe (« 3 savons pour 1 000 FCFA »).
 */
export type PromotionKind = 'price' | 'x_for_y' | 'lot';

export const PROMOTION_KINDS: Record<PromotionKind, string> = {
  price: 'Prix promotionnel',
  x_for_y: 'N achetés, M payés',
  lot: 'Lot à prix fixe',
};

export interface PromotionRule {
  id: string;
  name: string;
  articleId: string;
  kind: PromotionKind;
  /** `price` : nouveau prix TTC à l'unité. */
  promoPrice?: Fcfa | null;
  /** `x_for_y` et `lot` : nombre d'articles du lot. */
  buyQty?: number | null;
  /** `x_for_y` : nombre d'articles payés. */
  payQty?: number | null;
  /** `lot` : prix TTC du lot. */
  lotPrice?: Fcfa | null;
}

export type PromotedLine<L extends CartLine = CartLine> = L & { promo: Fcfa; promotionId: string | null; promotionName: string | null };

/** Libellé court de l'offre, pour l'écran et le ticket (« 3 pour 2 », « 3 pour 1 000 »). */
export function promotionLabel(rule: PromotionRule, format: (v: Fcfa) => string = String): string {
  if (rule.kind === 'price') return `Prix promo ${format(rule.promoPrice ?? 0)}`;
  if (rule.kind === 'x_for_y') return `${rule.buyQty} pour ${rule.payQty}`;
  return `${rule.buyQty} pour ${format(rule.lotPrice ?? 0)}`;
}

/** Économie totale d'une règle sur les lignes d'un même article. */
function saving(rule: PromotionRule, lines: CartLine[]): Fcfa {
  if (rule.kind === 'price') {
    const price = rule.promoPrice ?? 0;
    return lines.reduce((t, l) => t + Math.max(0, lineAmount(l.unitPrice, l.qty) - lineAmount(price, l.qty)), 0);
  }
  const n = rule.buyQty ?? 0;
  if (n < 2) return 0;
  // Offres par quantité : uniquement sur des pièces entières.
  const units = lines.reduce((t, l) => t + (l.qty > 0 && l.qty % 1000 === 0 ? l.qty / 1000 : 0), 0);
  const groups = Math.floor(units / n);
  const price = lines[0]!.unitPrice;
  if (rule.kind === 'x_for_y') return groups * Math.max(0, n - (rule.payQty ?? n)) * price;
  return groups * Math.max(0, n * price - (rule.lotPrice ?? n * price));
}

/**
 * Applique la meilleure promotion de chaque article. L'économie d'une offre par quantité est
 * portée par les dernières lignes de l'article (jamais au-delà de leur montant). Les lignes à
 * prix imposé (étiquettes balance), les ventes par conditionnement (carton, paquet : leur prix
 * est déjà un prix de lot) et les quantités négatives n'en bénéficient pas.
 */
export function applyPromotions<L extends CartLine>(lines: readonly L[], rules: readonly PromotionRule[]): PromotedLine<L>[] {
  const out: PromotedLine<L>[] = lines.map((l) => ({ ...l, promo: 0, promotionId: null, promotionName: null }));
  const byArticle = new Map<string, number[]>();
  out.forEach((l, i) => {
    if (l.fixedAmount !== undefined || l.packPrice !== undefined || l.qty <= 0) return;
    byArticle.set(l.articleId, [...(byArticle.get(l.articleId) ?? []), i]);
  });
  for (const [articleId, idx] of byArticle) {
    const group = idx.map((i) => out[i]!);
    let best: { rule: PromotionRule; amount: Fcfa } | null = null;
    for (const rule of rules) {
      if (rule.articleId !== articleId) continue;
      const amount = saving(rule, group);
      if (amount > 0 && (!best || amount > best.amount)) best = { rule, amount };
    }
    if (!best) continue;
    const mark = (l: PromotedLine<L>, promo: Fcfa) => {
      l.promo = promo;
      l.promotionId = best!.rule.id;
      l.promotionName = best!.rule.name;
    };
    if (best.rule.kind === 'price') {
      for (const l of group) {
        const p = Math.max(0, lineAmount(l.unitPrice, l.qty) - lineAmount(best.rule.promoPrice ?? 0, l.qty));
        if (p) mark(l, Math.min(p, lineAmount(l.unitPrice, l.qty) - l.discount));
      }
      continue;
    }
    let left = best.amount;
    for (const l of [...group].reverse()) {
      if (left <= 0) break;
      const room = Math.max(0, lineAmount(l.unitPrice, l.qty) - l.discount);
      const p = Math.min(left, room);
      if (p) mark(l, p);
      left -= p;
    }
  }
  return out;
}

/** Contrôle d'une règle avant enregistrement ; renvoie le message d'erreur ou null. */
export function checkPromotion(rule: Omit<PromotionRule, 'id' | 'articleId'>, articlePrice: Fcfa, unit: 'piece' | 'kg' | 'litre'): string | null {
  const int = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v);
  if (!rule.name.trim()) return 'Donnez un nom à la promotion';
  if (rule.kind === 'price') {
    if (!int(rule.promoPrice) || rule.promoPrice! <= 0) return 'Prix promotionnel invalide';
    if (rule.promoPrice! >= articlePrice) return `Le prix promotionnel doit être inférieur au prix normal (${articlePrice})`;
    return null;
  }
  if (unit !== 'piece') return 'Les offres par quantité ne valent que pour les articles vendus à la pièce';
  if (!int(rule.buyQty) || rule.buyQty! < 2 || rule.buyQty! > 100) return 'Nombre d’articles du lot invalide (2 à 100)';
  if (rule.kind === 'x_for_y') {
    if (!int(rule.payQty) || rule.payQty! < 1 || rule.payQty! >= rule.buyQty!) return 'Le nombre d’articles payés doit être inférieur au nombre achetés';
    return null;
  }
  if (!int(rule.lotPrice) || rule.lotPrice! <= 0) return 'Prix du lot invalide';
  if (rule.lotPrice! >= rule.buyQty! * articlePrice) return 'Le prix du lot doit être inférieur au prix des articles à l’unité';
  return null;
}
