import { type Fcfa, formatFcfa } from './money';

/** Contenu net d'un produit, ramené au kilo ou au litre (qty en millièmes : 900 g → 900). */
export interface NetContent {
  qty: number;
  unit: 'kg' | 'l';
}

const UNITS: Record<string, { unit: 'kg' | 'l'; factor: number }> = {
  mg: { unit: 'kg', factor: 0.001 },
  g: { unit: 'kg', factor: 1 },
  gr: { unit: 'kg', factor: 1 },
  grs: { unit: 'kg', factor: 1 },
  kg: { unit: 'kg', factor: 1000 },
  kgs: { unit: 'kg', factor: 1000 },
  ml: { unit: 'l', factor: 1 },
  cl: { unit: 'l', factor: 10 },
  dl: { unit: 'l', factor: 100 },
  l: { unit: 'l', factor: 1000 },
  lt: { unit: 'l', factor: 1000 },
  litre: { unit: 'l', factor: 1000 },
  litres: { unit: 'l', factor: 1000 },
};

/**
 * Lit le contenu net dans un texte : « 900 g », « 1,5L », « 50 cl », « 6 x 1,5 L »
 * (lot de 6 : 9 litres), « 25KG ». Le dernier contenu du texte compte
 * (« Lait 3 en 1 400 g » donne 400 g). Rien de lisible : null.
 */
export function parseNetContent(text: string | null | undefined): NetContent | null {
  const s = (text ?? '').toLowerCase().replace(/(\d),(\d)/g, '$1.$2');
  const re = /(?:(\d{1,3})\s*[x×*]\s*)?(\d+(?:\.\d+)?)\s*(mg|grs|gr|g|kgs|kg|ml|cl|dl|litres|litre|lt|l)(?![a-z])/g;
  let found: NetContent | null = null;
  for (const m of s.matchAll(re)) {
    const u = UNITS[m[3]!]!;
    const count = m[1] ? Number(m[1]) : 1;
    const qty = Math.round(Number(m[2]) * u.factor * count);
    if (qty > 0 && qty < 1e9) found = { qty, unit: u.unit };
  }
  return found;
}

/** Prix au kilo ou au litre (arrondi au franc) ; null sans contenu connu. */
export function unitPriceOf(price: Fcfa, content: NetContent | null): { price: Fcfa; unit: 'kg' | 'l' } | null {
  if (!content || content.qty <= 0 || price <= 0) return null;
  return { price: Math.round((price * 1000) / content.qty), unit: content.unit };
}

/** « 1 111 F le kg », « 667 F le litre ». */
export function unitPriceText(price: Fcfa, content: NetContent | null): string | null {
  const u = unitPriceOf(price, content);
  return u ? `${formatFcfa(u.price, false)} F ${u.unit === 'kg' ? 'le kg' : 'le litre'}` : null;
}
