/**
 * Bons d'achat : un code « BA » suivi de 10 chiffres, imprimé en code-barres
 * sur le bon. Le dernier chiffre est une clé (comme l'EAN) : une faute de
 * frappe sur le code est refusée au lieu de tomber sur un autre bon.
 */
export const VOUCHER_PREFIX = 'BA';

const key = (digits: string) => {
  const sum = [...digits].reduce((t, d, i) => t + Number(d) * (i % 2 === 0 ? 3 : 1), 0);
  return String((10 - (sum % 10)) % 10);
};

/** Code d'un nouveau bon, à partir de 9 chiffres tirés au hasard. */
export function voucherCode(random: () => number = Math.random): string {
  let digits = '';
  for (let i = 0; i < 9; i++) digits += String(Math.floor(random() * 10) % 10);
  return `${VOUCHER_PREFIX}${digits}${key(digits)}`;
}

/** Code tapé ou scanné, remis en forme (« ba 1234 567 890 » → « BA1234567890 ») ; null s'il n'est pas valable. */
export function normalizeVoucherCode(raw: string | null | undefined): string | null {
  const s = (raw ?? '').toUpperCase().replace(/[\s-]/g, '');
  const m = /^BA(\d{9})(\d)$/.exec(s);
  if (!m || key(m[1]!) !== m[2]) return null;
  return s;
}

export const VOUCHER_KINDS = { sold: 'Bon vendu', refund: "Bon d'avoir (retour)", change: 'Bon de monnaie' } as const;
export type VoucherKind = keyof typeof VOUCHER_KINDS;
