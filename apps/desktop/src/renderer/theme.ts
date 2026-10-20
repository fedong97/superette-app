import { brandCssVars } from '@superette/core';

/**
 * Couleurs de l'entreprise appliquées à tout l'écran : les variables CSS
 * (`--brand`, `--brand-soft`…) sont réécrites, chaque écran les suit.
 */
export function applyBrand(color?: string | null, color2?: string | null): void {
  const root = document.documentElement.style;
  for (const [k, v] of Object.entries(brandCssVars(color, color2))) root.setProperty(k, v);
}
