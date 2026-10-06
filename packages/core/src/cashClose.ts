import { type Fcfa } from './money';

/** Billets et pièces en circulation en zone CEMAC (FCFA). */
export const DENOMINATIONS_FCFA: readonly Fcfa[] = [
  10000, 5000, 2000, 1000, 500, 200, 100, 50, 25, 10, 5, 2, 1,
];

export type DenominationCount = Partial<Record<number, number>>;

export function countedTotal(count: DenominationCount): Fcfa {
  let total = 0;
  for (const [denom, n] of Object.entries(count)) {
    if (!n) continue;
    if (!DENOMINATIONS_FCFA.includes(Number(denom))) {
      throw new Error(`Coupure inconnue : ${denom}`);
    }
    total += Number(denom) * n;
  }
  return total;
}

export interface CashMovements {
  openingFloat: Fcfa;
  /** Espèces encaissées sur les ventes, rendu monnaie déjà déduit. */
  cashSales: Fcfa;
  /** Espèces rendues sur des retours clients. */
  cashRefunds: Fcfa;
  /** Apports en caisse (complément de fond). */
  cashIn: Fcfa;
  /** Prélèvements en cours de journée (mise en coffre). */
  cashOut: Fcfa;
  /** Règlements de clients à crédit reçus en espèces à cette caisse. */
  customerReceipts?: Fcfa;
  /** Dépenses payées avec les espèces du tiroir (transport, sacs…). */
  expenses?: Fcfa;
}

export function expectedCash(m: CashMovements): Fcfa {
  return m.openingFloat + m.cashSales - m.cashRefunds + m.cashIn - m.cashOut + (m.customerReceipts ?? 0) - (m.expenses ?? 0);
}

/** Écart de clôture : positif = excédent, négatif = manquant. */
export function closingDifference(m: CashMovements, counted: DenominationCount): {
  expected: Fcfa;
  counted: Fcfa;
  difference: Fcfa;
} {
  const expected = expectedCash(m);
  const total = countedTotal(counted);
  return { expected, counted: total, difference: total - expected };
}
