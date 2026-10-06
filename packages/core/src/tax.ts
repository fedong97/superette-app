import { type Fcfa, roundFcfa } from './money';

/**
 * Taux de TVA exprimés en points de base (1925 = 19,25 %).
 * Au Cameroun : 17,5 % + 10 % de centimes additionnels communaux = 19,25 %.
 * Les taux sont paramétrables en base car ils évoluent avec les lois de finances.
 */
export type RateBp = number;

export const TVA_CAMEROUN_NORMAL: RateBp = 1925;
export const TVA_EXONERE: RateBp = 0;

/** Décompose un montant TTC en HT + TVA (le TTC est la référence en caisse). */
export function splitTtc(ttc: Fcfa, rate: RateBp): { ht: Fcfa; tva: Fcfa } {
  const ht = roundFcfa((ttc * 10000) / (10000 + rate));
  return { ht, tva: ttc - ht };
}

export function ttcFromHt(ht: Fcfa, rate: RateBp): Fcfa {
  return roundFcfa((ht * (10000 + rate)) / 10000);
}

export function formatRate(rate: RateBp): string {
  return `${(rate / 100).toLocaleString('fr-FR', { maximumFractionDigits: 2 })} %`;
}
