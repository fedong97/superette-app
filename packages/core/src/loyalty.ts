import type { Fcfa } from './money';

/** Règles de la carte de fidélité d'un magasin (Administration › Paramètres). */
export interface LoyaltyRules {
  /** Montant d'achat qui donne 1 point (1 000 FCFA). */
  spendPerPoint: Fcfa;
  /** Valeur d'un point en remise (10 FCFA : 100 points = 1 000 FCFA). */
  pointValue: Fcfa;
  /** Points à avoir au minimum pour payer avec. */
  minRedeem: number;
}

/** Points gagnés sur un achat : un point par tranche entière, jamais négatif. */
export function earnedPoints(amount: Fcfa, rules: Pick<LoyaltyRules, 'spendPerPoint'>): number {
  if (rules.spendPerPoint <= 0 || amount <= 0) return 0;
  return Math.floor(amount / rules.spendPerPoint);
}

/** Valeur en FCFA d'un nombre de points. */
export function pointsValue(points: number, rules: Pick<LoyaltyRules, 'pointValue'>): Fcfa {
  return Math.max(0, Math.floor(points)) * rules.pointValue;
}

/**
 * Points dépensés pour payer `amount` : le montant doit tomber juste sur des points entiers.
 * Lève une erreur en français sinon.
 */
export function pointsForAmount(amount: Fcfa, rules: Pick<LoyaltyRules, 'pointValue'>): number {
  if (rules.pointValue <= 0) throw new Error('Valeur du point non réglée');
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error('Montant payé en points invalide');
  if (amount % rules.pointValue !== 0) throw new Error(`Le montant payé en points doit être un multiple de ${rules.pointValue} FCFA (valeur d'un point)`);
  return amount / rules.pointValue;
}

/** Plus grand montant payable en points : le solde, sans dépasser ce qui reste à payer. */
export function maxRedeemable(balance: number, due: Fcfa, rules: LoyaltyRules): Fcfa {
  if (balance < rules.minRedeem || rules.pointValue <= 0) return 0;
  const byBalance = pointsValue(balance, rules);
  const byDue = Math.floor(Math.max(0, due) / rules.pointValue) * rules.pointValue;
  return Math.min(byBalance, byDue);
}
