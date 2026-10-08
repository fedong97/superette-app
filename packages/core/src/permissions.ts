/**
 * Droits d'utilisateur. Chaque rôle reçoit une liste de droits que
 * l'administrateur règle dans Administration › Droits ; l'administrateur les a
 * tous. Les valeurs par défaut reprennent la répartition d'origine.
 */
export type UserRole = 'admin' | 'manager' | 'cashier' | 'stock' | 'accountant';

/** Rôles réglables (l'administrateur a toujours tout). */
export const EDITABLE_ROLES: UserRole[] = ['manager', 'cashier', 'stock', 'accountant'];

export interface PermissionDef {
  label: string;
  group: 'Fenêtres' | 'Caisse' | 'Gestion';
  roles: UserRole[];
}

const POS: UserRole[] = ['manager', 'cashier'];
const STOCK: UserRole[] = ['manager', 'stock'];
const MANAGE: UserRole[] = ['manager'];
const ACCOUNTING: UserRole[] = ['manager', 'accountant'];

export const PERMISSIONS = {
  cash: { label: 'Facturation au comptant (caisse)', group: 'Fenêtres', roles: POS },
  credit: { label: 'Vente à crédit', group: 'Fenêtres', roles: POS },
  sales: { label: 'Factures et registre des ventes', group: 'Fenêtres', roles: ACCOUNTING },
  reports: { label: 'Rapports de ventes', group: 'Fenêtres', roles: ACCOUNTING },
  articles: { label: 'Produits (fiches et prix)', group: 'Fenêtres', roles: STOCK },
  stock: { label: 'Stock (réceptions, pertes, transferts)', group: 'Fenêtres', roles: STOCK },
  labels: { label: 'Étiquettes de rayon', group: 'Fenêtres', roles: STOCK },
  purchases: { label: 'Achats', group: 'Fenêtres', roles: ['manager', 'stock', 'accountant'] },
  suppliers: { label: 'Fournisseurs', group: 'Fenêtres', roles: ['manager', 'stock', 'accountant'] },
  customers: { label: 'Clients', group: 'Fenêtres', roles: ['manager', 'cashier', 'accountant'] },
  quotes: { label: 'Devis et proformas', group: 'Fenêtres', roles: ['manager', 'cashier', 'accountant'] },
  expenses: { label: 'Dépenses et charges', group: 'Fenêtres', roles: ACCOUNTING },
  accounting: { label: 'Comptabilité et trésorerie', group: 'Fenêtres', roles: ACCOUNTING },
  promotions: { label: 'Promotions', group: 'Fenêtres', roles: MANAGE },
  dashboard: { label: 'Tableau de bord', group: 'Fenêtres', roles: MANAGE },
  admin: { label: 'Administration (utilisateurs, caisses, sauvegardes)', group: 'Fenêtres', roles: MANAGE },
  price: { label: 'Modifier le prix à la saisie (jamais sous le revient)', group: 'Caisse', roles: POS },
  discount: { label: 'Accorder une remise sans le code du gérant', group: 'Caisse', roles: MANAGE },
  cashout: { label: 'Prélèvement et dépense en caisse sans le code du gérant', group: 'Caisse', roles: MANAGE },
  purchase_orders: { label: 'Bons de commande et propositions de commande', group: 'Gestion', roles: STOCK },
  purchase_invoices: { label: 'Factures fournisseurs, échéancier et situation', group: 'Gestion', roles: ACCOUNTING },
  receivables: { label: 'Comptes clients : échéances et plafonds', group: 'Gestion', roles: ACCOUNTING },
  inventory: { label: 'Inventaires', group: 'Gestion', roles: MANAGE },
  import: { label: 'Importer le catalogue (CSV)', group: 'Gestion', roles: MANAGE },
  store_price: { label: 'Prix propre au magasin', group: 'Gestion', roles: MANAGE },
} satisfies Record<string, PermissionDef>;

export type Permission = keyof typeof PERMISSIONS;
export const PERMISSION_KEYS = Object.keys(PERMISSIONS) as Permission[];

/** Droits effectifs d'un rôle : réglages enregistrés, sinon valeurs par défaut. */
export function roleRights(role: UserRole, saved: Partial<Record<Permission, boolean>> | null): Permission[] {
  if (role === 'admin') return [...PERMISSION_KEYS];
  return PERMISSION_KEYS.filter((k) => saved?.[k] ?? (PERMISSIONS[k].roles as UserRole[]).includes(role));
}
