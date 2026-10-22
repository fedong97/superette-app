/**
 * Couleurs de l'entreprise (Administration › Couleurs et badges) : une couleur
 * principale et une couleur secondaire. Toute l'application, le badge et les
 * documents A4 en tirent leurs teintes : foncée pour les titres, claire pour
 * les fonds, et la couleur du texte posé dessus (blanc ou noir, la plus lisible).
 */

export const DEFAULT_BRAND_COLOR = '#1f7a5c';
export const DEFAULT_BRAND_COLOR2 = '#57b083';

/** Palettes toutes prêtes proposées dans Administration. */
export const BRAND_PRESETS: { name: string; color: string; color2: string }[] = [
  { name: 'Vert (ONIX)', color: DEFAULT_BRAND_COLOR, color2: DEFAULT_BRAND_COLOR2 },
  { name: 'Bleu', color: '#1d4ed8', color2: '#38bdf8' },
  { name: 'Rouge', color: '#c62828', color2: '#f2994a' },
  { name: 'Orange', color: '#d9480f', color2: '#f59f00' },
  { name: 'Violet', color: '#6d28d9', color2: '#c084fc' },
  { name: 'Bordeaux', color: '#8b1e3f', color2: '#d4a373' },
  { name: 'Noir et or', color: '#1f2933', color2: '#d4a017' },
  { name: 'Turquoise', color: '#0f766e', color2: '#2dd4bf' },
];

export const isHexColor = (v: unknown): v is string => typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v);

function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function hex([r, g, b]: [number, number, number]): string {
  return `#${[r, g, b].map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('')}`;
}

/** Mélange de deux couleurs : `t` = part de `b` (0 : tout `a`, 1 : tout `b`). */
export function mixColors(a: string, b: string, t: number): string {
  const x = rgb(a);
  const y = rgb(b);
  return hex([x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t]);
}

/** Luminance relative (WCAG), de 0 (noir) à 1 (blanc). */
export function luminance(color: string): number {
  const [r, g, b] = rgb(color).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Contraste entre deux couleurs (de 1 à 21). */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** Texte posé sur cette couleur : blanc ou noir, celui qui se lit le mieux. */
export function inkOn(color: string): string {
  return contrast(color, '#ffffff') >= contrast(color, '#111111') ? '#ffffff' : '#111111';
}

export interface BrandPalette {
  /** Couleur principale : boutons, onglets, bandeaux. */
  brand: string;
  /** Couleur secondaire : dégradés, accents. */
  brand2: string;
  /** Principale foncée (survol) et très foncée (titres). */
  dark: string;
  deep: string;
  /** Fonds clairs : sélection, en-têtes de tableau, fond de l'application. */
  soft: string;
  pale: string;
  bg: string;
  /** Traits et bordures teintés. */
  line: string;
  border: string;
  /** Texte sur la principale et sur la secondaire. */
  ink: string;
  ink2: string;
  /** Texte courant, légèrement teinté. */
  text: string;
  muted: string;
}

/**
 * Toutes les teintes tirées des deux couleurs. Une principale très claire est
 * foncée pour ses titres afin qu'ils restent lisibles sur fond blanc.
 */
export function brandPalette(color?: string | null, color2?: string | null): BrandPalette {
  const brand = isHexColor(color) ? color.toLowerCase() : DEFAULT_BRAND_COLOR;
  const brand2 = isHexColor(color2) ? color2.toLowerCase() : isHexColor(color) ? mixColors(brand, '#ffffff', 0.35) : DEFAULT_BRAND_COLOR2;
  let deep = mixColors(brand, '#000000', 0.35);
  for (let t = 0.45; contrast(deep, '#ffffff') < 7 && t <= 0.9; t += 0.1) deep = mixColors(brand, '#000000', t);
  return {
    brand,
    brand2,
    dark: mixColors(brand, '#000000', 0.22),
    deep,
    soft: mixColors(brand, '#ffffff', 0.88),
    pale: mixColors(brand, '#ffffff', 0.94),
    bg: mixColors(brand, '#ffffff', 0.92),
    line: mixColors(brand, '#ffffff', 0.8),
    border: mixColors(brand, '#ffffff', 0.68),
    ink: inkOn(brand),
    ink2: inkOn(brand2),
    text: mixColors(brand, '#0b0f0d', 0.7),
    muted: mixColors(brand, '#6b7280', 0.75),
  };
}

/** Variables CSS de l'écran (`--brand`, `--brand-soft`…) tirées des deux couleurs. */
export function brandCssVars(color?: string | null, color2?: string | null): Record<string, string> {
  const p = brandPalette(color, color2);
  return {
    '--brand': p.brand,
    '--brand2': p.brand2,
    '--brand-dark': p.dark,
    '--brand-deep': p.deep,
    '--brand-ink': p.ink,
    '--brand2-ink': p.ink2,
    '--brand-soft': p.soft,
    '--brand-pale': p.pale,
    '--brand-line': p.border,
    '--bg': p.bg,
    '--line': p.line,
    '--ink': p.text,
    '--muted': p.muted,
  };
}
