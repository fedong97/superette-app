import { type Fcfa } from './money';
import { type Milli, lineAmount } from './quantity';
import { type RateBp, splitTtc } from './tax';

export interface CartLine {
  articleId: string;
  label: string;
  /** Prix unitaire TTC (par pièce, ou par kg / litre). */
  unitPrice: Fcfa;
  qty: Milli;
  vatRate: RateBp;
  /** Remise sur la ligne, en FCFA TTC. */
  discount: Fcfa;
  /** Montant imposé (étiquette balance à prix intégré), prioritaire sur unitPrice × qty. */
  fixedAmount?: Fcfa;
  /** Économie due à une promotion, en FCFA TTC (n'exige pas l'accord d'un gérant). */
  promo?: Fcfa;
}

export interface VatBreakdown {
  rate: RateBp;
  ht: Fcfa;
  tva: Fcfa;
  ttc: Fcfa;
}

export interface CartTotals {
  totalTtc: Fcfa;
  totalHt: Fcfa;
  totalTva: Fcfa;
  totalDiscount: Fcfa;
  totalPromo: Fcfa;
  itemCount: number;
  vat: VatBreakdown[];
}

export function lineTotal(line: CartLine): Fcfa {
  const gross = line.fixedAmount ?? lineAmount(line.unitPrice, line.qty);
  return gross - line.discount - (line.promo ?? 0);
}

/**
 * Totaux d'un ticket. La TVA est calculée par taux sur le cumul TTC
 * (et non ligne par ligne) pour que le ticket et la comptabilité concordent.
 */
export function computeTotals(lines: readonly CartLine[]): CartTotals {
  const byRate = new Map<RateBp, Fcfa>();
  let totalTtc = 0;
  let totalDiscount = 0;
  let totalPromo = 0;
  let itemCount = 0;
  for (const line of lines) {
    const amount = lineTotal(line);
    totalTtc += amount;
    totalDiscount += line.discount;
    totalPromo += line.promo ?? 0;
    itemCount += line.qty % 1000 === 0 ? line.qty / 1000 : 1;
    byRate.set(line.vatRate, (byRate.get(line.vatRate) ?? 0) + amount);
  }
  const vat = [...byRate.entries()]
    .sort(([a], [b]) => b - a)
    .map(([rate, ttc]) => ({ rate, ttc, ...splitTtc(ttc, rate) }));
  const totalHt = vat.reduce((s, v) => s + v.ht, 0);
  return { totalTtc, totalHt, totalTva: totalTtc - totalHt, totalDiscount, totalPromo, itemCount, vat };
}
