/**
 * Magasin sans TVA (régime simplifié) : plus aucune mention de TVA, HT ou TTC à l'écran.
 * Le drapeau suit le magasin du poste, mis à jour par App à chaque chargement de l'état.
 */
let vatOn = true;

export function setVatOn(on: boolean): void {
  vatOn = on;
}

/** Vrai si le magasin du poste est assujetti à la TVA. */
export function hasVat(): boolean {
  return vatOn;
}

/** Libellé sans « HT » ni « TTC » quand le magasin n'a pas de TVA : « Total HT » devient « Total ». */
export function tx(label: string): string {
  if (vatOn) return label;
  return label.replace(/\s*\((?:HT|TTC)\)|\s*\b(?:HT|TTC)\b/g, '');
}
