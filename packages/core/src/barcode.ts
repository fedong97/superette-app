/**
 * Codes-barres : EAN-13, EAN-8, UPC-A, et étiquettes balance (préfixes 2x,
 * zone GS1 « à diffusion restreinte » utilisée en magasin).
 */

export function eanCheckDigit(body: string): number {
  // Pondération 3/1 en partant de la droite du corps (sans la clé).
  let sum = 0;
  for (let i = 0; i < body.length; i++) {
    const digit = body.charCodeAt(body.length - 1 - i) - 48;
    sum += digit * (i % 2 === 0 ? 3 : 1);
  }
  return (10 - (sum % 10)) % 10;
}

export function isValidEan(code: string): boolean {
  if (!/^\d+$/.test(code) || ![8, 12, 13].includes(code.length)) return false;
  return eanCheckDigit(code.slice(0, -1)) === Number(code.at(-1));
}

/** Normalise un scan : retire espaces, convertit UPC-A (12) en EAN-13. */
export function normalizeBarcode(raw: string): string {
  const code = raw.trim().replace(/\s+/g, '');
  if (/^\d{12}$/.test(code) && isValidEan(code)) return `0${code}`;
  return code;
}

export interface ScaleBarcodeConfig {
  /** Préfixes à 2 chiffres réservés aux étiquettes balance, ex. ["21","22"]. */
  prefixes: string[];
  /** Ce que contient la zone valeur : prix en FCFA ou poids en grammes. */
  valueType: 'price' | 'weight';
}

export interface ScaleBarcode {
  /** Code article PLU (5 chiffres) servant à retrouver l'article. */
  plu: string;
  /** Prix FCFA si valueType = price, sinon poids en grammes (= millièmes de kg). */
  value: number;
  valueType: 'price' | 'weight';
}

/**
 * Format EAN-13 balance : PP CCCCC VVVVV K
 * (préfixe, code article, valeur, clé).
 */
export function parseScaleBarcode(code: string, config: ScaleBarcodeConfig): ScaleBarcode | null {
  if (code.length !== 13 || !isValidEan(code)) return null;
  if (!config.prefixes.includes(code.slice(0, 2))) return null;
  return {
    plu: code.slice(2, 7),
    value: Number(code.slice(7, 12)),
    valueType: config.valueType,
  };
}

/**
 * Code interne pour un article sans code-barres (vrac, boulangerie) :
 * préfixe 20 + numéro sur 10 chiffres + clé.
 */
export function internalEan13(sequence: number): string {
  if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence > 9_999_999_999) {
    throw new Error(`Numéro de code interne hors plage : ${sequence}`);
  }
  const body = `20${sequence.toString().padStart(10, '0')}`;
  return body + eanCheckDigit(body);
}
