/**
 * Montants en francs CFA (XAF). Le FCFA n'a pas de subdivision utilisée :
 * tous les montants sont des entiers, jamais des flottants.
 */
export type Fcfa = number;

export function assertFcfa(value: number, label = 'montant'): void {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${label} invalide : ${value} (entier FCFA attendu)`);
  }
}

/** Arrondi commercial au franc le plus proche (0,5 vers le haut). */
export function roundFcfa(value: number): Fcfa {
  return Math.sign(value) * Math.round(Math.abs(value));
}

/** 12500 -> "12 500 FCFA" (espace insécable fine comme séparateur de milliers). */
export function formatFcfa(value: Fcfa, withUnit = true): string {
  const sign = value < 0 ? '-' : '';
  const digits = Math.abs(value).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return withUnit ? `${sign}${digits} FCFA` : `${sign}${digits}`;
}
