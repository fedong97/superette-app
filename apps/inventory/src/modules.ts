import { type PcScreenId, PC_SCREENS, pcScreenAllowed } from '@superette/core/src/pcScreens';
import type { Session } from './state';

/**
 * Navigation selon les droits. Chaque entrée du menu dépend d'un droit qui
 * existe déjà :
 * - les écrans du téléphone : les droits envoyés par le serveur (`session.can`) ;
 * - les écrans de gestion du PC : les droits du PC, calculés avec le même code
 *   que les PC (@superette/core) à partir du rôle et des privilèges de la personne.
 * L'interface ne fait que refléter ces droits ; le serveur et les PC continuent
 * de tout vérifier à chaque action.
 */

export type Can = NonNullable<Session['can']>;

export type ModuleId =
  | 'accueil'
  | 'vente'
  | 'ventes'
  | 'valider'
  | 'stock'
  | 'caisses'
  | 'clients'
  | 'equipe'
  | 'gestion'
  | 'inventaires'
  | 'reception'
  | 'sortie'
  | `pc:${PcScreenId}`;

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
  | 'grid'
  | 'bag'
  | 'tag'
  | 'coins'
  | 'book'
  | 'settings'
  | 'chart'
  | 'calendar';

export type GroupId = 'pilotage' | 'gestion' | 'terrain';

/** Ce que la personne peut ouvrir : droits du téléphone, et droits du PC quand ils sont connus. */
export interface Access {
  can: Can | undefined;
  /** Droits du PC (écrans de gestion) ; null tant qu'ils ne sont pas chargés ou si le serveur est ancien. */
  pc: readonly string[] | null;
}

export interface ModuleDef {
  id: ModuleId;
  /** Nom complet (menu, titre de l'écran). */
  label: string;
  /** Nom court de la barre du bas. */
  short: string;
  hint: string;
  icon: IconName;
  group: GroupId | null;
  allowed: (a: Access) => boolean;
  /** Écran du PC, ouvert dans la page de gestion (un PC allumé du magasin l'exécute). */
  pc?: PcScreenId;
}

const manage = (a: Access) => Boolean(a.can?.manage);
const full = (a: Access) => a.can?.manage === 'full';
const pcHas = (a: Access, id: PcScreenId) => full(a) && a.pc !== null && pcScreenAllowed(PC_SCREENS.find((s) => s.id === id)!, a.pc);

/** Écran du PC dans le menu : nom et icône du téléphone, droits du PC. */
const pc = (id: PcScreenId, label: string, icon: IconName, hint?: string, group: GroupId | null = 'gestion'): ModuleDef => ({
  id: `pc:${id}`,
  label,
  short: label,
  hint: hint ?? PC_SCREENS.find((s) => s.id === id)!.hint,
  icon,
  group,
  allowed: (a) => pcHas(a, id),
  pc: id,
});

export const MODULES: readonly ModuleDef[] = [
  { id: 'accueil', label: 'Tableau de bord', short: 'Accueil', hint: 'Votre journée en un coup d’œil', icon: 'home', group: 'pilotage', allowed: () => true },
  { id: 'ventes', label: 'Ventes', short: 'Ventes', hint: 'Factures par période, annulations', icon: 'receipt', group: 'pilotage', allowed: manage },
  // Lus sur le serveur : marchent même quand aucun PC du magasin n'est allumé ; l'écran du PC s'ouvre depuis eux.
  { id: 'caisses', label: 'Caisse & Trésorerie', short: 'Caisses', hint: 'État des caisses, écarts, trésorerie', icon: 'coins', group: 'pilotage', allowed: manage },
  { id: 'stock', label: 'Stock', short: 'Stock', hint: 'Ruptures, stock bas, commandes', icon: 'box', group: 'pilotage', allowed: manage },
  { id: 'valider', label: 'À valider', short: 'Valider', hint: 'Demandes des caisses et du magasin', icon: 'check-circle', group: 'pilotage', allowed: manage },

  pc('treasury', 'Trésorerie', 'coins', 'Ouvrir, clôturer, verser, caisse centrale', null),
  pc('payments', 'Achats', 'bag', 'Commandes, factures fournisseurs, échéances'),
  pc('articles', 'Produits', 'tag', 'Créer, modifier, changer un prix'),
  { id: 'clients', label: 'Clients', short: 'Clients', hint: 'Crédits, plafonds, fiches', icon: 'users', group: 'gestion', allowed: manage },
  pc('customers', 'Fiches clients', 'users', 'Fiches, crédits, règlements', null),
  pc('suppliers', 'Fournisseurs', 'truck'),
  pc('expenses', 'Dépenses', 'wallet'),
  pc('accounting', 'Comptabilité', 'book'),
  pc('stock', 'Mouvements de stock', 'box', 'Entrées, corrections, état détaillé', null),
  pc('sales', 'Factures et retours', 'receipt', 'Toutes les factures, retours, bons', null),
  pc('dashboard', 'Rapports complets', 'chart', 'Tableau de bord complet du PC', null),
  pc('staff', 'Personnel et planning', 'calendar', 'Présences, planning, congés', null),
  { id: 'equipe', label: 'Équipe', short: 'Équipe', hint: 'Délégation, personnel, planning', icon: 'user-check', group: 'gestion', allowed: manage },
  pc('admin', 'Administration', 'settings', 'Caisses, utilisateurs, droits, délégation'),
  // Ancien serveur (droits du PC inconnus) : le menu complet du PC, comme avant.
  { id: 'gestion', label: 'Gérer la boutique', short: 'Gérer', hint: 'Clients, fournisseurs, trésorerie, caisses, dépenses…', icon: 'store', group: 'gestion', allowed: (a) => full(a) && a.pc === null, pc: 'dashboard' },

  { id: 'vente', label: 'Panier au rayon', short: 'Vente', hint: 'Préparer le panier d’un client', icon: 'cart', group: 'terrain', allowed: (a) => Boolean(a.can?.cart) },
  { id: 'inventaires', label: 'Inventaires', short: 'Inventaire', hint: 'Compter les produits', icon: 'clipboard', group: 'terrain', allowed: (a) => Boolean(a.can?.count) },
  { id: 'reception', label: 'Réceptions', short: 'Réception', hint: 'Recevoir une livraison', icon: 'truck', group: 'terrain', allowed: (a) => Boolean(a.can?.receive) },
  { id: 'sortie', label: 'Contrôle sortie', short: 'Sortie', hint: 'Vérifier les tickets à la porte', icon: 'scan', group: 'terrain', allowed: (a) => Boolean(a.can?.exit) },
];

export const GROUPS: readonly { id: GroupId; label: string }[] = [
  { id: 'pilotage', label: 'Pilotage' },
  { id: 'gestion', label: 'Gestion de la boutique' },
  { id: 'terrain', label: 'Au magasin' },
];

/** Écrans du PC ouverts depuis un écran du téléphone (« Gérer sur le PC »), au lieu d'encombrer le menu. */
export const PC_LINKS: Partial<Record<ModuleId, PcScreenId[]>> = {
  accueil: ['dashboard'],
  ventes: ['sales'],
  caisses: ['treasury'],
  stock: ['stock'],
  clients: ['customers'],
  equipe: ['staff'],
};
export function pcLinks(id: ModuleId, mods: readonly ModuleDef[]): ModuleDef[] {
  return (PC_LINKS[id] ?? []).flatMap((p) => mods.filter((m) => m.pc === p && m.id !== 'gestion'));
}

/** Modules ouverts à la personne connectée, dans l'ordre du menu. */
export function modulesFor(a: Access): ModuleDef[] {
  if (!a.can) return MODULES.filter((m) => m.id === 'accueil');
  return MODULES.filter((m) => m.allowed(a));
}

/** Ordre de la barre du bas : le travail de tous les jours d'abord. */
const PRIMARY = ['vente', 'inventaires', 'reception', 'sortie', 'ventes', 'stock', 'valider', 'caisses', 'clients', 'equipe'] as const;
const PRIMARY_MANAGER = ['ventes', 'stock', 'valider', 'vente', 'inventaires', 'reception', 'sortie', 'caisses', 'clients', 'equipe'] as const;

/**
 * Barre du bas : Accueil, puis au plus trois écrans du téléphone ; « Plus »
 * (tous les modules autorisés, profil, réglages) est ajouté par la barre.
 */
export function bottomTabs(mods: readonly ModuleDef[], can: Can | undefined): ModuleDef[] {
  const order: readonly string[] = can?.manage ? PRIMARY_MANAGER : PRIMARY;
  const screens = mods.filter((m) => m.id !== 'accueil' && !m.pc);
  const main = order.map((id) => screens.find((m) => m.id === id)).filter((m): m is ModuleDef => Boolean(m)).slice(0, 3);
  return [mods.find((m) => m.id === 'accueil')!, ...main];
}

/** Menu : les catégories qui ont au moins un module autorisé. */
export function groupsFor(mods: readonly ModuleDef[]): { id: GroupId; label: string; modules: ModuleDef[] }[] {
  return GROUPS.map((g) => ({ ...g, modules: mods.filter((m) => m.group === g.id) })).filter((g) => g.modules.length > 0);
}

/** Écran demandé par une notification touchée, s'il est ouvert à la personne. */
export function screenFor(screen: string, mods: readonly ModuleDef[]): ModuleId {
  const hit = mods.find((m) => m.id === screen && !m.pc);
  return hit ? hit.id : 'accueil';
}

/** Actions rapides de l'accueil, par ordre d'importance ; seules celles du rôle apparaissent. */
const QUICK: { id: ModuleId; label: string }[] = [
  { id: 'vente', label: 'Nouveau panier' },
  { id: 'inventaires', label: 'Inventaire' },
  { id: 'pc:treasury', label: 'Trésorerie' },
  { id: 'valider', label: 'À valider' },
  { id: 'pc:expenses', label: 'Dépense' },
  { id: 'pc:customers', label: 'Clients' },
  { id: 'reception', label: 'Réception' },
  { id: 'sortie', label: 'Contrôler un ticket' },
  { id: 'gestion', label: 'Gérer la boutique' },
];
export function quickActions(mods: readonly ModuleDef[], max = 4): (ModuleDef & { quick: string })[] {
  return QUICK.flatMap((q) => {
    const m = mods.find((x) => x.id === q.id);
    return m ? [{ ...m, quick: q.label }] : [];
  }).slice(0, max);
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
