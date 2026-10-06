const UNITS = ['zéro', 'un', 'deux', 'trois', 'quatre', 'cinq', 'six', 'sept', 'huit', 'neuf', 'dix', 'onze', 'douze', 'treize', 'quatorze', 'quinze', 'seize'];
const TENS = ['', 'dix', 'vingt', 'trente', 'quarante', 'cinquante', 'soixante'];

/** 0 à 99, orthographe rectifiée de 1990 (traits d'union partout). */
function belowHundred(n: number): string {
  if (n <= 16) return UNITS[n]!;
  if (n < 20) return `dix-${UNITS[n - 10]}`;
  if (n < 70) {
    const t = Math.floor(n / 10);
    const u = n % 10;
    return u === 0 ? TENS[t]! : u === 1 ? `${TENS[t]}-et-un` : `${TENS[t]}-${UNITS[u]}`;
  }
  if (n < 80) return n === 71 ? 'soixante-et-onze' : `soixante-${belowHundred(n - 60)}`;
  return n === 80 ? 'quatre-vingts' : `quatre-vingt-${belowHundred(n - 80)}`;
}

function belowThousand(n: number): string {
  const h = Math.floor(n / 100);
  const r = n % 100;
  const head = h === 0 ? '' : h === 1 ? 'cent' : `${UNITS[h]}-cent${r === 0 ? 's' : ''}`;
  if (!r) return head;
  return head ? `${head}-${belowHundred(r)}` : belowHundred(r);
}

/**
 * Montant en toutes lettres pour les factures et devis :
 * 113 000 → « cent-treize-mille ». Entiers positifs jusqu'à 999 999 999 999.
 */
export function numberToWordsFr(n: number): string {
  if (!Number.isSafeInteger(n) || n < 0 || n >= 1e12) throw new Error(`Nombre hors limites : ${n}`);
  if (n === 0) return 'zéro';
  const parts: string[] = [];
  const billions = Math.floor(n / 1e9);
  const millions = Math.floor((n % 1e9) / 1e6);
  const thousands = Math.floor((n % 1e6) / 1000);
  const rest = n % 1000;
  if (billions) parts.push(`${belowThousand(billions)}-milliard${billions > 1 ? 's' : ''}`);
  if (millions) parts.push(`${belowThousand(millions)}-million${millions > 1 ? 's' : ''}`);
  // « mille » est invariable ; « cent » et « quatre-vingt » ne prennent pas de s devant mille.
  if (thousands) parts.push(thousands === 1 ? 'mille' : `${belowThousand(thousands).replace(/(cent|vingt)s$/, '$1')}-mille`);
  if (rest) parts.push(belowThousand(rest));
  return parts.join('-');
}
