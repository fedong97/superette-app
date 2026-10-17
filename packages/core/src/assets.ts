/**
 * Registre des immobilisations : catégories proposées et modes de
 * comptabilisation de l'achat, communs au calcul et aux écrans.
 */

/** Catégories proposées : compte SYSCOHADA et durée d'usage courante (modifiable sur chaque fiche). */
export const ASSET_CATEGORIES = [
  { key: 'software', label: 'Logiciels et site internet', account: '213', years: 3 },
  { key: 'building', label: 'Bâtiment sur sol propre', account: '231', years: 20 },
  { key: 'fittings', label: 'Aménagements et agencements du magasin', account: '234', years: 10 },
  { key: 'equipment', label: 'Matériel commercial (réfrigérateurs, congélateurs, balances, rayonnages)', account: '241', years: 5 },
  { key: 'office', label: 'Matériel de bureau', account: '2441', years: 5 },
  { key: 'computer', label: 'Matériel informatique (PC de caisse, imprimantes, douchettes)', account: '2442', years: 3 },
  { key: 'furniture', label: 'Mobilier', account: '2444', years: 10 },
  { key: 'vehicle', label: 'Véhicule', account: '2451', years: 4 },
  { key: 'land', label: 'Terrain (non amortissable)', account: '222', years: 0 },
] as const;

/** Comment l'acquisition est passée en comptabilité. */
export const ASSET_FUNDINGS = {
  supplier: "À payer au fournisseur d'investissement (481)",
  bank: 'Payé par la banque (521)',
  opening: 'Bien repris à la mise en service (à-nouveaux, 4711)',
  none: 'Déjà passé en comptabilité (aucune écriture)',
} as const;
export type AssetFunding = keyof typeof ASSET_FUNDINGS;

