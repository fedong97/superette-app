import type { Session } from './state';

/**
 * Navigation selon les droits : chaque module du téléphone dit de quel droit il
 * dépend, et ce droit est celui que le serveur envoie déjà (`session.can`, calculé
 * avec le rôle, les privilèges et les délégations). Rien n'est recalculé ici :
 * l'interface montre seulement ce que le serveur autorise, et le serveur
 * continue de tout vérifier à chaque action.
 */

export type Can = NonNullable<Session['can']>;

export type ModuleId = 'accueil' | 'vente' | 'ventes' | 'valider' | 'stock' | 'caisses' | 'clients' | 'equipe' | 'gestion' | 'inventaires' | 'reception' | 'sortie';

export type IconName =
  | 'home'
  | 'cart'
  | 'receipt'
  | 'box'
  | 'clipboard'
  | 'truck'
  | 'scan'
  | 'check-circle'
  | 'wallet'
  | 'users'
  | 'user-check'
  | 'store'
  | 'grid';

export type GroupId = 'ventes' | 'stock' | 'finances' | 'gestion';

export interface ModuleDef {
  id: ModuleId;
  /** Nom complet (menu Plus, titre de l'écran). */
  label: string;
  /** Nom court de la barre du bas. */
  short: string;
  hint: string;
  icon: IconName;
  group: GroupId | null;
  /** Droit du serveur qui ouvre ce module. */
  allowed: (can: Can) => boolean;
  /** Ouvre l'écran du PC sur le téléphone au lieu d'un écran de l'appli. */
  external?: boolean;
}

const manage = (c: Can) => Boolean(c.manage);

export const MODULES: readonly ModuleDef[] = [
  { id: 'accueil', label: 'Accueil', short: 'Accueil', hint: '', icon: 'home', group: null, allowed: () => true },
  { id: 'vente', label: 'Panier au rayon', short: 'Vente', hint: 'Préparer le panier d’un client', icon: 'cart', group: 'ventes', allowed: (c) => c.cart },
  { id: 'ventes', label: 'Ventes', short: 'Ventes', hint: 'Factures du jour, annulations', icon: 'receipt', group: 'ventes', allowed: manage },
  { id: 'clients', label: 'Clients', short: 'Clients', hint: 'Crédits et plafonds', icon: 'users', group: 'ventes', allowed: manage },
  { id: 'sortie', label: 'Contrôle sortie', short: 'Sortie', hint: 'Vérifier les tickets à la porte', icon: 'scan', group: 'ventes', allowed: (c) => Boolean(c.exit) },
  { id: 'stock', label: 'Stock', short: 'Stock', hint: 'Ruptures, stock bas, commandes', icon: 'box', group: 'stock', allowed: manage },
  { id: 'inventaires', label: 'Inventaires', short: 'Inventaire', hint: 'Compter les produits', icon: 'clipboard', group: 'stock', allowed: (c) => c.count },
  { id: 'reception', label: 'Réceptions', short: 'Réception', hint: 'Recevoir une livraison', icon: 'truck', group: 'stock', allowed: (c) => Boolean(c.receive) },
  { id: 'caisses', label: 'Caisses', short: 'Caisses', hint: 'État des caisses, écarts', icon: 'wallet', group: 'finances', allowed: manage },
  { id: 'valider', label: 'À valider', short: 'Valider', hint: 'Demandes des caisses et du magasin', icon: 'check-circle', group: 'gestion', allowed: manage },
  { id: 'equipe', label: 'Équipe', short: 'Équipe', hint: 'Personnel et délégation', icon: 'user-check', group: 'gestion', allowed: manage },
  {
    id: 'gestion',
    label: 'Gérer la boutique',
    short: 'Gérer',
    hint: 'Clients, fournisseurs, trésorerie, caisses, dépenses…',
    icon: 'store',
    group: 'gestion',
    allowed: (c) => c.manage === 'full',
    external: true,
  },
];

export const GROUPS: readonly { id: GroupId; label: string }[] = [
  { id: 'ventes', label: 'Ventes' },
  { id: 'stock', label: 'Stock' },
  { id: 'finances', label: 'Finances' },
  { id: 'gestion', label: 'Gestion' },
];

/** Modules ouverts à la personne connectée, dans l'ordre du catalogue. */
export function modulesFor(can: Can | undefined): ModuleDef[] {
  if (!can) return MODULES.filter((m) => m.id === 'accueil');
  return MODULES.filter((m) => m.allowed(can));
}

/** Ordre de la barre du bas : le travail de tous les jours d'abord. */
const PRIMARY = ['vente', 'inventaires', 'reception', 'sortie', 'ventes', 'stock', 'valider', 'caisses', 'clients', 'equipe'] as const;
const PRIMARY_MANAGER = ['ventes', 'stock', 'valider', 'vente', 'inventaires', 'reception', 'sortie', 'caisses', 'clients', 'equipe'] as const;

/**
 * Barre du bas : Accueil, puis au plus trois modules ; Plus (toujours là : profil,
 * réglages, tous les modules autorisés) est ajouté par la barre elle-même.
 */
export function bottomTabs(mods: readonly ModuleDef[], can: Can | undefined): ModuleDef[] {
  const order: readonly string[] = can?.manage ? PRIMARY_MANAGER : PRIMARY;
  const screens = mods.filter((m) => m.id !== 'accueil' && !m.external);
  const main = order.map((id) => screens.find((m) => m.id === id)).filter((m): m is ModuleDef => Boolean(m)).slice(0, 3);
  const home = mods.find((m) => m.id === 'accueil')!;
  return [home, ...main];
}

/** Menu Plus : les catégories qui ont au moins un module autorisé. */
export function groupsFor(mods: readonly ModuleDef[]): { id: GroupId; label: string; modules: ModuleDef[] }[] {
  return GROUPS.map((g) => ({ ...g, modules: mods.filter((m) => m.group === g.id) })).filter((g) => g.modules.length > 0);
}

/** Écran demandé par une notification touchée, s'il est ouvert à la personne. */
export function screenFor(screen: string, mods: readonly ModuleDef[]): ModuleId {
  const hit = mods.find((m) => m.id === screen && !m.external);
  return hit ? hit.id : 'accueil';
}

/** Libellé du rôle, tel qu'il est enregistré sur le PC. */
export const ROLE_LABELS: Record<string, string> = {
  admin: 'Administrateur',
  manager: 'Gérant',
  cashier: 'Caissier',
  seller: 'Vendeur',
  buyer: 'Responsable d’achat',
  stock: 'Magasinier',
  accountant: 'Comptable',
  guest: 'Invité',
};
export const roleLabel = (role: string | undefined) => (role ? (ROLE_LABELS[role] ?? role) : '');
