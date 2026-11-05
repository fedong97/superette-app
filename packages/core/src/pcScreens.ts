import type { Permission } from './permissions';

/**
 * Écrans de gestion du PC ouverts sur le téléphone (ONIX 360 Mobile, « Gérer la
 * boutique ») : une seule liste, lue par l'appli (menu) et par la page du PC sur
 * le téléphone. Un écran est ouvert à la personne qui a l'un de ses droits.
 */
export type PcScreenId = 'dashboard' | 'sales' | 'treasury' | 'customers' | 'suppliers' | 'payments' | 'expenses' | 'accounting' | 'articles' | 'stock' | 'staff' | 'admin';

export interface PcScreen {
  id: PcScreenId;
  label: string;
  hint: string;
  perm: readonly Permission[];
}

export const PC_SCREENS: readonly PcScreen[] = [
  { id: 'dashboard', label: 'Tableau de bord', hint: 'Journée, caisses, mois', perm: ['dashboard', 'team_board', 'owner_report'] },
  { id: 'sales', label: 'Ventes', hint: 'Factures, retours, annulations', perm: ['sales', 'sale_edit_approve', 'vouchers'] },
  { id: 'treasury', label: 'Trésorerie et caisses', hint: 'Ouvrir, clôturer, verser, caisse centrale', perm: ['treasury', 'cash_history', 'central_cash', 'cash_live'] },
  { id: 'customers', label: 'Clients', hint: 'Fiches, crédits, règlements', perm: ['customers', 'receivables', 'customer_statement'] },
  { id: 'suppliers', label: 'Fournisseurs', hint: 'Fiches, comptes, situation', perm: ['suppliers', 'supplier_statement'] },
  { id: 'payments', label: 'Achats et paiements', hint: 'Commandes, factures, échéances', perm: ['purchases', 'purchase_orders', 'purchase_invoices', 'supplier_pay', 'purchase_due'] },
  { id: 'expenses', label: 'Dépenses', hint: 'Saisir, approuver, charges', perm: ['expenses', 'expense_record', 'expense_approve'] },
  { id: 'accounting', label: 'Comptabilité', hint: 'Écritures, journaux, banque', perm: ['accounting', 'journal_entry', 'bank_reconciliation'] },
  { id: 'articles', label: 'Produits et prix', hint: 'Créer, modifier, changer un prix', perm: ['articles', 'article_create'] },
  { id: 'stock', label: 'Stock', hint: 'État, entrées, corrections', perm: ['stock', 'stock_moves', 'stock_adjust', 'stock_decide', 'inventory'] },
  { id: 'staff', label: 'Équipe et planning', hint: 'Personnel, présences, planning, congés', perm: ['staff', 'staff_edit', 'staff_attendance', 'staff_leaves'] },
  { id: 'admin', label: 'Caisses et utilisateurs', hint: 'Caisses, comptes, droits, délégation', perm: ['admin', 'users_manage', 'delegate', 'user_limits'] },
];

export const pcScreen = (id: PcScreenId): PcScreen => PC_SCREENS.find((s) => s.id === id)!;

/** L'écran est ouvert à la personne qui a ces droits. */
export const pcScreenAllowed = (s: PcScreen, rights: readonly string[]) => s.perm.some((p) => rights.includes(p));
