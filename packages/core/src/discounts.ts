import type { Fcfa } from './money';

/** Motifs proposés à la caisse quand on fait une remise : le gérant lit pourquoi, pas seulement combien. */
export const DISCOUNT_REASONS = [
  'Client fidèle',
  'Achat en gros',
  'Produit abîmé ou date courte',
  'Geste commercial',
  'Erreur de prix affiché',
  'Personnel du magasin',
  'Autre',
] as const;

/** « Autre : … » ou un motif de la liste, nettoyé ; null si vide. */
export function cleanDiscountReason(reason: string | null | undefined): string | null {
  const r = reason?.trim().replace(/\s+/g, ' ').slice(0, 120);
  return r || null;
}

/** Code de réduction tel qu'on le compare : majuscules, sans espace (« noel 25 » → « NOEL25 »). */
export function normalizePromoCode(code: string | null | undefined): string {
  return (code ?? '').toUpperCase().replace(/[^A-Z0-9-]/g, '');
}

/** Remise d'un code sur un sous-total : un pourcentage arrondi au franc, ou un montant, jamais plus que le sous-total. */
export function promoCodeAmount(kind: 'percent' | 'amount', value: number, subtotal: Fcfa): Fcfa {
  if (subtotal <= 0) return 0;
  const raw = kind === 'percent' ? Math.round((subtotal * Math.min(value, 100)) / 100) : value;
  return Math.max(0, Math.min(raw, subtotal));
}

/**
 * Répartit une remise sur des montants de lignes, au prorata, sans qu'une ligne
 * passe sous zéro ; le reste de l'arrondi va à la ligne la plus chère.
 */
export function spreadCodeDiscount(totals: readonly Fcfa[], amount: Fcfa): Fcfa[] {
  const sum = totals.reduce((t, v) => t + Math.max(0, v), 0);
  const out = totals.map(() => 0);
  if (amount <= 0 || sum <= 0) return out;
  const due = Math.min(amount, sum);
  let given = 0;
  totals.forEach((v, i) => {
    const share = Math.floor((Math.max(0, v) * due) / sum);
    out[i] = share;
    given += share;
  });
  let rest = due - given;
  const order = totals.map((v, i) => i).sort((a, b) => totals[b]! - totals[a]!);
  for (const i of order) {
    if (rest <= 0) break;
    const room = Math.max(0, totals[i]!) - out[i]!;
    const take = Math.min(room, rest);
    out[i]! += take;
    rest -= take;
  }
  return out;
}
