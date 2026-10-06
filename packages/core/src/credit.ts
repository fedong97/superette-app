import { type Fcfa } from './money';

export interface Debit {
  id: string;
  amount: Fcfa;
}

/**
 * Lettrage automatique : les règlements et avoirs du client soldent ses
 * ventes à crédit de la plus ancienne à la plus récente. Renvoie ce qui reste
 * dû sur chaque vente, dans l'ordre reçu (déjà trié par date).
 */
export function allocateOldestFirst<T extends Debit>(debits: readonly T[], credits: Fcfa): (T & { remaining: Fcfa })[] {
  let left = Math.max(0, credits);
  return debits.map((d) => {
    const used = Math.min(left, d.amount);
    left -= used;
    return { ...d, remaining: d.amount - used };
  });
}

export type AgingBucket = 'current' | 'd30' | 'd60' | 'd90' | 'older';

export const AGING_LABELS: Record<AgingBucket, string> = {
  current: 'Non échu',
  d30: '1 à 30 j de retard',
  d60: '31 à 60 j',
  d90: '61 à 90 j',
  older: 'Plus de 90 j',
};

/** Jours de retard entre l'échéance et aujourd'hui (dates AAAA-MM-JJ), 0 si non échu. */
export function daysLate(dueDate: string, today: string): number {
  const ms = Date.parse(`${today}T00:00:00Z`) - Date.parse(`${dueDate}T00:00:00Z`);
  return Math.max(0, Math.round(ms / 86_400_000));
}

export function agingBucket(dueDate: string, today: string): AgingBucket {
  const late = daysLate(dueDate, today);
  if (late === 0) return 'current';
  if (late <= 30) return 'd30';
  if (late <= 60) return 'd60';
  if (late <= 90) return 'd90';
  return 'older';
}

/**
 * Contrôle du plafond de crédit avant une vente : le nouvel encours ne doit
 * pas dépasser le plafond. Un plafond à 0 interdit le crédit.
 */
export function creditCheck(balance: Fcfa, limit: Fcfa, amount: Fcfa): { allowed: boolean; available: Fcfa; over: Fcfa } {
  const available = Math.max(0, limit - balance);
  return { allowed: amount <= available, available, over: Math.max(0, amount - available) };
}
