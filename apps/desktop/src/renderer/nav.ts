/** Fenêtres de travail, ouvertes côte à côte (une seule visible à la fois). */
export type WinKind =
  | 'cash1'
  | 'cash2'
  | 'credit'
  | 'sales'
  | 'articles'
  | 'stock'
  | 'purchases'
  | 'suppliers'
  | 'customers'
  | 'expenses'
  | 'quotes'
  | 'deliveries'
  | 'orders'
  | 'promotions'
  | 'labels'
  | 'reports'
  | 'accounting'
  | 'treasury'
  | 'dashboard'
  | 'admin'
  | 'production'
  | 'staff'
  | 'containers'
  | 'agent'
  | 'control'
  | 'exit';

/** Onglets rapides au plus : deux lignes dans la barre du haut. */
export const MAX_QUICK_TABS = 12;

/** Onglet rapide : une fenêtre, éventuellement ouverte sur un de ses onglets. */
export interface QuickTab {
  label: string;
  open: [WinKind, string?];
  credit?: boolean;
}

/** Sans accents ni majuscules, pour chercher « cloture » et trouver « Clôture ». */
export const fold = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
