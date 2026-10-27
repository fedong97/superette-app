import { useEffect, useRef, useState } from 'react';
import { DEFAULT_STORE_SETTINGS, type MascotMood, type Permission } from '@superette/core';
import { type Result, call } from './api';
import logo from './assets/logo.png';
import { type QuickTab, type WinKind } from './nav';
import { applyBrand } from './theme';
import { Ico, MenuIcon } from './icons';
import { Accounting, type AccountingTab } from './screens/Accounting';
import { Deliveries } from './screens/Deliveries';
import { Orders } from './screens/Orders';
import { ExitChecks, type ExitTab } from './screens/ExitCheck';
import { Admin, type AdminTab } from './screens/Admin';
import { Articles, type ArticlesView } from './screens/Articles';
import { Customers, type CustomersTab } from './screens/Customers';
import { Dashboard, type DashboardTab } from './screens/Dashboard';
import { Expenses, type ExpensesTab } from './screens/Expenses';
import { Login } from './screens/Login';
import { Pos, RegisterChooser } from './screens/Pos';
import { Labels } from './screens/Labels';
import { Production, type ProductionTab } from './screens/Production';
import { Promotions } from './screens/Promotions';
import { Reports } from './screens/Reports';
import { Quotes } from './screens/Quotes';
import { Purchases, type PurchasesTab } from './screens/Purchases';
import { EDIT_SALE_EVENT, SaleDetail, Sales, type SalesTab } from './screens/Sales';
import { Setup } from './screens/Setup';
import { DossierPicker, FicheBanner, saveFicheCopy } from './screens/Dossiers';
import { Staff, type StaffTab } from './screens/Staff';
import { Kiosk } from './screens/Kiosk';
import { Stock, type StockTab } from './screens/Stock';
import { Suppliers, type SuppliersTab } from './screens/Suppliers';
import { Treasury, type TreasuryTab } from './screens/Treasury';
import { Containers, type ContainersTab } from './screens/Containers';
import { AgentPoint, type AgentTab } from './screens/AgentPoint';
import { CashierControl } from './screens/CashierControl';
import { CommandPalette, GettingStarted, HelpDialog, type PaletteEntry, QuickTabsEditor, RailEditor, WhatsNew } from './screens/Guide';
import { ROLE_TILES } from './guide';
import { AskHost, DRAFT_SCREENS, KeyHints, THEMES, type Theme, applyTheme, askConfirm, Field, Mascot, Modal, OPEN_EVENT, RefreshCtx, SingleViewCtx, dateTime, pageShortcuts, RightsProvider, StoreSettingsProvider, ToastProvider, fcfa, useLoad, useToast } from './ui';
import { hasVat, setVatOn } from './tax';
import { ctrlJ } from './newShortcut';
import { type ListPrefs, ListTools } from './listTools';
import { DayTasks } from './screens/Floor';
import { type Area, type Geo, MdiWindow, defaultGeo, dialogGeo, tileGeos } from './mdi';
import { type Lang, currentLang, setLang, storedLang } from './i18n';

type AppState = Result<'app.state'>;
type User = NonNullable<AppState['user']>;
type Role = User['role'];

interface Win {
  /** Un écran = une fenêtre : « admin:settings » (Paramètres) n'est pas « admin:users ». */
  id: string;
  kind: WinKind;
  tab?: string;
  /** Réduite dans la barre du bas. */
  min?: boolean;
  /** Chemin affiché en haut de la page : « Trésorerie › Opérations de trésorerie ». */
  crumb?: string;
  /** Change à chaque réouverture sur un autre onglet, pour repartir de cet onglet. */
  nonce: number;
  /** Augmente à chaque actualisation (⟳ ou F5) : les données de la fenêtre se rechargent. */
  rev?: number;
}



/** Droits qui ouvrent une fenêtre : il suffit d'un seul (un droit précis ouvre la fenêtre sur ce qu'il permet). */
const WINDOWS: Record<WinKind, { label: string; perm: Permission[] }> = {
  cash1: { label: 'Fiche de facturation 1', perm: ['cash'] },
  cash2: { label: 'Fiche de facturation 2', perm: ['cash'] },
  credit: { label: 'Vente à crédit', perm: ['credit'] },
  sales: { label: 'Mes factures', perm: ['sales', 'cash_z', 'cash_operations', 'sales_alerts', 'sale_edit_approve', 'vouchers'] },
  articles: { label: 'Produits', perm: ['articles', 'article_create'] },
  stock: {
    label: 'Stock',
    perm: ['stock', 'stock_moves', 'stock_monitoring', 'stock_receive', 'stock_loss', 'stock_request', 'stock_adjust', 'stock_decide', 'transfer_view', 'transfer_create', 'transfer_direct', 'inventory', 'inventory_count', 'clearance', 'cycle_count', 'restock', 'day_tasks', 'store_transfers', 'lot_recall'],
  },
  purchases: { label: 'Achats', perm: ['purchases', 'purchase_orders', 'reorder', 'purchase_invoices', 'supplier_pay', 'purchase_due', 'supplier_returns', 'group_orders', 'supplier_calendar', 'missed_report', 'mobile_reception'] },
  suppliers: { label: 'Fournisseurs', perm: ['suppliers', 'supplier_statement', 'free_goods'] },
  customers: { label: 'Clients', perm: ['customers', 'receivables', 'rebates', 'customer_statement', 'summary_invoices', 'account_offsets', 'consignment'] },
  expenses: { label: 'Dépenses', perm: ['expenses', 'expense_record', 'expense_categories', 'charge_plans'] },
  quotes: { label: 'Devis et proformas', perm: ['quotes', 'quote_save'] },
  deliveries: { label: 'Livraisons du jour', perm: ['deliveries'] },
  orders: { label: 'Commandes clients', perm: ['customer_orders', 'recurring_orders'] },
  promotions: { label: 'Promotions', perm: ['promotions', 'promotion_save', 'promotion_stop'] },
  labels: { label: 'Étiquettes', perm: ['labels'] },
  reports: { label: 'Rapports de ventes', perm: ['reports'] },
  accounting: { label: 'Comptabilité', perm: ['accounting', 'vat_return', 'tax', 'tax_settings', 'bank_reconciliation', 'statements', 'journal_entry', 'journal_edit', 'chart_accounts', 'fiscal_years', 'cash_forecast', 'budgets', 'analytics', 'cheque_deposits', 'patrimony', 'cheque_rejections'] },
  treasury: { label: 'Opérations de trésorerie', perm: ['treasury', 'cash_history', 'central_cash'] },
  dashboard: { label: 'Tableau de bord', perm: ['dashboard', 'price_review', 'team_board', 'owner_report'] },
  admin: { label: 'Administration', perm: ['admin'] },
  production: { label: 'Fabrication', perm: ['production', 'production_recipes', 'production_create', 'production_validate'] },
  staff: { label: 'Collaborateurs', perm: ['staff', 'staff_edit', 'staff_salaries', 'staff_targets', 'staff_attendance', 'staff_leaves'] },
  containers: { label: 'Emballages consignés', perm: ['containers', 'containers_counter'] },
  agent: { label: 'Point Mobile Money', perm: ['agent_point', 'agent_accounts'] },
  control: { label: 'Contrôle des caissiers', perm: ['cashier_control'] },
  exit: { label: 'Contrôle à la sortie', perm: ['exit_check', 'exit_report'] },
};

const winId = (kind: WinKind, tab?: string) => `${kind}:${tab ?? ''}`;

/** Fiches de vente qu'on passe l'une à l'autre en mode « Caisse seule ». */
const POS_SWITCH: [WinKind, string][] = [
  ['cash1', 'V. cash 1'],
  ['cash2', 'V. cash 2'],
  ['credit', 'V. crédit'],
];

/**
 * Écrans qui s'ouvrent en boîte de dialogue, comme les paramètres dans Sage :
 * réglages qu'on fait puis qu'on quitte, opérations de caisse, traitements et
 * impressions. Ils n'ont que ✕ ; les listes et les saisies se réduisent.
 */
const DIALOG_WINDOWS = new Set([
  // Réglages du magasin et des utilisateurs
  'admin:settings',
  'admin:brand',
  'admin:templates',
  'admin:fiches',
  'admin:shopTemplates',
  'admin:users',
  'admin:rights',
  'admin:privileges',
  'admin:mobilepay',
  // Technique
  'admin:backups',
  'admin:server',
  'admin:relay',
  'admin:takeover',
  'admin:repair',
  'admin:updates',
  'admin:license',
  // Réglages des autres menus
  'accounting:fiscal',
  'expenses:categories',
  'expenses:plans',
  'staff:teams',
  // Opérations de caisse : ouverture, fond de caisse, versement, clôture
  'treasury:day',
  // Traitements et impressions
  'purchases:reorder',
  'labels:',
  'containers:types',
  'sales:export',
]);

interface MenuItem {
  label: string;
  open?: [WinKind, string?];
  action?: 'logout' | 'leave' | 'training' | 'dossiers' | 'sync' | 'shortcuts' | 'about' | 'quit' | 'openInvoice' | 'help' | 'palette' | 'guide' | 'news' | 'tabs' | 'rail' | 'theme' | 'kiosk';
  /** Option du magasin (Administration › Paramètres) dont dépend l'écran : il suffit d'une seule. */
  setting?: ('punchKiosk' | 'staffTeams' | 'multiEntrances' | 'contractorStaff' | 'fingerprint' | 'exitCheck')[];
  /** Trait de séparation entre deux groupes. */
  sep?: boolean;
  /** Avec sep : petit titre qui regroupe les écrans qui le suivent. */
  head?: boolean;
  /** Module pas encore développé : affiché grisé. */
  soon?: boolean;
  /** Droit nécessaire en plus de celui de la fenêtre (Administration › Droits). */
  perm?: Permission | Permission[];
  /** Réservé au rôle Administrateur. */
  adminOnly?: boolean;
  /** Autres mots qui le trouvent avec Ctrl+K : synonymes et anciens noms. */
  words?: string;
  /** Compteur affiché à côté du libellé. */
  badge?: 'gaps';
}

const SEP: MenuItem = { label: '', sep: true };
/** Petit titre dans un menu : il regroupe les écrans qui le suivent. */
const H = (label: string): MenuItem => ({ label, sep: true, head: true });

/** Icônes et couleurs des menus : barre verte de gauche et écran « Tous les menus ». */
const MENU_ICONS: Record<string, string> = {
  Fichier: '📁',
  Vente: '🧾',
  Trésorerie: '💰',
  Stock: '🗄️',
  Articles: '📦',
  Achats: '🛒',
  Clients: '👥',
  Dépenses: '💸',
  Personnel: '🪪',
  Suivi: '📈',
  Compta: '📒',
  Administration: '⚙️',
  Aide: '❔',
};

/** Icône d'un écran : celle du premier menu qui l'ouvre. */
const winIcon = (kind: WinKind) => MENU_ICONS[MENUS.find(([, items]) => items.some((it) => it.open?.[0] === kind))?.[0] ?? ''] ?? '▣';
const MENU_COLORS: Record<string, string> = {
  Fichier: '#64748b',
  Vente: 'var(--brand)',
  Trésorerie: '#e0a800',
  Stock: '#65a30d',
  Articles: '#0891b2',
  Achats: '#2563eb',
  Clients: '#db2777',
  Dépenses: '#dc2626',
  Personnel: '#ea580c',
  Suivi: 'var(--brand2)',
  Compta: '#4f46e5',
  Administration: '#64748b',
  Aide: '#94a3b8',
};
/** Réglages et Aide restent en bas de la barre verte ; les autres menus s'y affichent au choix de chacun. */
const RAIL_FIXED = ['Administration', 'Aide'];
const RAIL_LABELS: Record<string, string> = {
  Administration: 'Réglages',
};
/** 0.88.0 : anciens noms de menus (barre verte personnalisée) → menus qui les remplacent. */
const OLD_MENUS: Record<string, string[]> = {
  Facturation: ['Vente'],
  Vente: ['Vente', 'Suivi'],
  Produit: ['Articles', 'Stock'],
  Magasinier: ['Stock'],
  Transfert: ['Stock'],
  Fabrication: ['Articles'],
  Fournisseur: ['Achats'],
  Client: ['Clients'],
  Charge: ['Dépenses'],
  Comptabilité: ['Compta'],
  Fiscal: ['Compta'],
};

/** Menu du nom de l'utilisateur (en haut à droite) : son compte et ses réglages à lui. */
const FILE_MENU: MenuItem[] = [
  { label: 'Synchroniser maintenant', action: 'sync' },
  SEP,
  { label: 'Personnaliser les onglets rapides', action: 'tabs' },
  { label: 'Personnaliser la barre latérale', action: 'rail' },
  { label: 'Thème : clair, sombre ou contraste fort', action: 'theme' },
  SEP,
  { label: "Changer d'utilisateur", action: 'logout' },
  { label: 'Je pars (fin de journée)', action: 'leave' },
  { label: 'Mode formation (caisse d’entraînement)…', action: 'training', perm: 'training' },
  { label: 'Ouvrir une boutique…', action: 'dossiers', adminOnly: true },
  { label: 'Quitter', action: 'quit' },
];

/**
 * Les menus de la barre verte, du plus utilisé dans la journée au moins utilisé.
 * Chaque écran n'y est rangé qu'une fois ; Ctrl+K et les onglets rapides le retrouvent d'ailleurs.
 */
const MENUS: [string, MenuItem[]][] = [
  [
    'Vente',
    [
      H('Encaisser'),
      { label: 'Vente au comptant 1', words: 'nouvelle vente facture caisse ticket facturation', open: ['cash1'] },
      { label: 'Vente au comptant 2', words: 'nouvelle vente facture caisse ticket facturation', open: ['cash2'] },
      { label: 'Vente à crédit', words: 'facture à crédit client en compte', open: ['credit'] },
      H('Préparer'),
      { label: 'Devis et factures proforma', open: ['quotes'] },
      { label: 'Commandes clients (téléphone, WhatsApp)', open: ['orders'], perm: 'customer_orders' },
      { label: 'Commandes répétées des clients pros', open: ['orders', 'recurring'], perm: 'recurring_orders' },
      { label: 'Livraisons du jour', open: ['deliveries'], perm: 'deliveries' },
      H('Au comptoir'),
      { label: 'Point Mobile Money (dépôts, retraits, factures)', open: ['agent', 'counter'], perm: 'agent_point' },
      { label: 'Historique du Point Mobile Money', open: ['agent', 'history'], perm: ['agent_point', 'agent_accounts'] },
      { label: 'Emballages consignés', open: ['containers', 'situation'], perm: ['containers', 'containers_counter'] },
      { label: 'Mouvements des emballages', open: ['containers', 'moves'], perm: ['containers', 'containers_counter'] },
      { label: "Types d'emballages", words: 'casier bouteille consigne', open: ['containers', 'types'], perm: 'containers' },
      { label: "Bons d'achat et bons d'avoir", words: 'avoir bon cadeau', open: ['sales', 'vouchers'], perm: 'vouchers' },
      { label: 'Contrôle des tickets à la sortie', open: ['exit', 'door'], perm: 'exit_check', setting: ['exitCheck'] },
      H('Factures'),
      { label: 'Mes factures', words: 'tickets dernières factures réimprimer', open: ['sales', 'tickets'] },
      { label: 'Ouvrir une facture', words: 'retrouver facture ticket numéro', action: 'openInvoice', perm: 'sales' },
      { label: "Retours d'articles des clients", words: 'retour avoir client remboursement', open: ['sales', 'returns'] },
      { label: 'Tickets et factures annulés', open: ['sales', 'cancelled'] },
      { label: 'Demandes de modification de facture', open: ['sales', 'requests'], perm: ['sale_edit_approve', 'sale_edit_request'] },
    ],
  ],
  [
    'Trésorerie',
    [
      H('Ma caisse'),
      { label: 'Opérations de trésorerie (ouverture, clôture)', words: 'ouvrir fermer clôturer caisse fond de caisse', open: ['treasury', 'day'], perm: 'treasury' },
      { label: 'Registre de caisse (Z)', words: 'z clôture journal de caisse registre', open: ['sales', 'z'], perm: 'cash_z' },
      { label: 'Historique des journées de caisse', words: 'écarts journées z', open: ['treasury', 'history'], perm: 'cash_history', badge: 'gaps' },
      H('Toutes les caisses'),
      { label: 'Caisse centrale', open: ['treasury', 'central'], perm: 'central_cash' },
      { label: 'Caisses électroniques (MoMo, OM)', words: 'mobile money orange money mtn', open: ['treasury', 'emoney'], perm: 'central_cash' },
      { label: 'Positions (caisses, banques, Mobile Money)', open: ['accounting', 'treasury'] },
      { label: 'Listing des opérations de caisse', open: ['sales', 'cashops'], perm: 'cash_operations' },
      { label: 'Rechercher dans les caisses', words: 'retrouver opération', open: ['sales', 'find'], perm: 'cash_operations' },
      { label: 'Contrôle des caissiers', open: ['control'], perm: 'cashier_control' },
      H('Encaissements'),
      { label: 'Règlements clients reçus', words: 'paiement encaissement client', open: ['customers', 'payments'] },
      { label: 'Point Mobile Money : comptes et bilan', open: ['agent', 'accounts'], perm: 'agent_accounts' },
      H('Banque'),
      { label: 'Remises de chèques en banque', words: 'chèque dépôt banque', open: ['accounting', 'cheques'], perm: 'cheque_deposits' },
      { label: 'Chèques revenus impayés', open: ['accounting', 'unpaid'], perm: 'cheque_rejections' },
      { label: 'Rapprochement bancaire', words: 'banque relevé', open: ['accounting', 'bank'], perm: 'bank_reconciliation' },
    ],
  ],
  [
    'Stock',
    [
      H('Au quotidien'),
      { label: 'Tâches du jour', open: ['stock', 'tasks'], perm: 'day_tasks' },
      { label: 'Réassort du rayon', open: ['stock', 'restock'], perm: 'restock' },
      { label: 'État du stock', words: 'stocks quantités magasinier', open: ['stock', 'state'], perm: 'stock' },
      { label: 'Stocks critiques', words: 'stock faible minimum rupture', open: ['stock', 'critical'], perm: 'stock' },
      H('Compter'),
      { label: 'Inventaires', words: 'inventaire comptage compter', open: ['stock', 'inventory'], perm: ['inventory', 'inventory_count', 'inventory_close', 'inventory_print'] },
      { label: 'Inventaire tournant de la semaine', open: ['stock', 'cycle'], perm: 'cycle_count' },
      H('Sorties'),
      { label: 'Pertes et casse', words: 'perte casse déstockage abîmé', open: ['stock', 'loss'], perm: 'stock_loss' },
      { label: 'Péremptions', words: 'date expiration périmé dlc', open: ['stock', 'expiry'], perm: 'stock' },
      { label: 'Déstockage avant péremption', open: ['stock', 'clearance'], perm: 'clearance' },
      { label: 'Démarque (pertes par rayon)', open: ['stock', 'losses'], perm: 'clearance' },
      { label: 'Rappels de lots', open: ['stock', 'recalls'], perm: 'lot_recall' },
      H('Suivre'),
      { label: 'Mouvements de stock', words: 'entrées sorties historique magasinier', open: ['stock', 'moves'], perm: 'stock_moves' },
      { label: 'Historique des ajustements', open: ['stock', 'adjustments'], perm: 'stock_moves' },
      { label: 'Monitoring du stock', open: ['stock', 'monitoring'], perm: ['stock_monitoring', 'stock_request', 'stock_decide'] },
      { label: 'Stock multi-magasin', open: ['stock', 'multi'], perm: 'stock' },
      { label: 'Articles par dépôt', open: ['stock', 'warehouses'], perm: 'stock' },
      H('Transferts'),
      { label: 'Nouveau transfert', words: 'transfert envoyer réserve', open: ['stock', 'transferNew'], perm: 'transfer_create' },
      { label: 'Liste des transferts', words: 'transfert', open: ['stock', 'transfer'], perm: ['transfer_view', 'transfer_create', 'transfer_ship', 'transfer_receive', 'transfer_cancel', 'transfer_direct'] },
      { label: 'Demandes entre magasins', open: ['stock', 'stores'], perm: 'store_transfers' },
    ],
  ],
  [
    'Articles',
    [
      { label: 'Liste des produits', words: 'articles marchandises catalogue', open: ['articles', 'list'], perm: 'articles' },
      { label: 'Ajouter / paramétrer une marchandise', words: 'nouveau produit article créer', open: ['articles', 'new'], perm: 'article_create' },
      { label: 'Recherche', open: ['articles', 'search'], perm: 'articles' },
      { label: 'Rayonnage', words: 'rayon famille catégorie', open: ['articles', 'shelving'] },
      H('Prix et étiquettes'),
      { label: 'Prix programmés (à une date)', open: ['articles', 'schedules'], perm: ['price_schedule', 'price_update'] },
      { label: 'Promotions', words: 'promo remise réduction', open: ['promotions'], perm: 'promotions' },
      { label: 'Étiquettes et codes-barres', words: 'étiquette prix code barre imprimer', open: ['labels'] },
      H('Fabrication'),
      { label: 'Nouvel ordre de fabrication', open: ['production', 'new'], perm: 'production_create' },
      { label: 'Ordres de fabrication', open: ['production', 'orders'], perm: ['production', 'production_create', 'production_validate'] },
      { label: 'Recettes (produits fabriqués)', open: ['production', 'recipes'], perm: ['production', 'production_recipes'] },
    ],
  ],
  [
    'Achats',
    [
      H('Commander'),
      { label: 'Proposition de commande', open: ['purchases', 'reorder'], perm: 'reorder' },
      { label: 'Nouveau bon de commande', words: 'nouvel achat commander fournisseur', open: ['purchases', 'new-order'], perm: 'purchase_orders' },
      { label: 'Bons de commande', open: ['purchases', 'orders'], perm: ['purchases', 'purchase_orders', 'order_receive'] },
      { label: 'Commandes groupées (plusieurs magasins)', open: ['purchases', 'group'], perm: 'group_orders' },
      { label: 'Calendrier des passages fournisseurs', open: ['purchases', 'calendar'], perm: 'supplier_calendar' },
      { label: 'Ventes manquées (le client voulait…)', open: ['purchases', 'missed'], perm: 'missed_report' },
      H('Recevoir'),
      { label: 'Registre des réceptions', words: 'réception fournisseur livraison bl', open: ['purchases', 'receptions'] },
      { label: 'Réception sans commande', words: 'réception fournisseur entrée stock livraison', open: ['stock', 'receive'], perm: 'stock_receive' },
      { label: 'Réceptions comptées au téléphone', open: ['purchases', 'phone'], perm: 'mobile_reception' },
      { label: 'Marchandises non encore reçues', open: ['purchases', 'pending'] },
      H('Payer'),
      { label: 'Factures fournisseurs (à partir des BL)', words: 'facture d\'achat registre des achats avoirs', open: ['purchases', 'invoices'], perm: 'purchase_invoices' },
      { label: 'Facture directe (sans bon de commande)', open: ['purchases', 'direct'], perm: 'purchase_invoices' },
      { label: 'Échéancier fournisseurs', words: 'dettes fournisseurs payer échéances', open: ['purchases', 'due'], perm: 'purchase_due' },
      { label: 'Retours fournisseur et avoirs attendus', open: ['purchases', 'returns'], perm: 'supplier_returns' },
      { label: 'Achats par produit', open: ['purchases', 'byproduct'] },
      H('Fournisseurs'),
      { label: 'Liste des fournisseurs', words: 'fournisseur nouveau fournisseur', open: ['suppliers', 'list'], perm: 'suppliers' },
      { label: 'Extrait de compte fournisseur', open: ['suppliers', 'statement'], perm: 'supplier_statement' },
      { label: 'Situation des fournisseurs', open: ['suppliers', 'situation'], perm: 'supplier_statement' },
      { label: 'Bonus fournisseurs (unités gratuites)', open: ['suppliers', 'bonus'], perm: 'free_goods' },
      { label: 'Fournisseurs dont le solde a bougé', open: ['suppliers', 'recent'], perm: 'supplier_statement' },
    ],
  ],
  [
    'Clients',
    [
      { label: 'Liste des clients', words: 'client nouveau client', open: ['customers', 'list'], perm: 'customers' },
      { label: 'Situation et échéances', words: 'créances impayés retard situation des clients', open: ['customers', 'receivables'], perm: 'receivables' },
      { label: "Plafonds d'autorisation", open: ['customers', 'limits'], perm: 'receivables' },
      { label: 'Extrait de compte client', open: ['customers', 'statement'], perm: ['customer_statement', 'receivables'] },
      { label: 'Clients dont le solde a bougé', open: ['customers', 'recent'] },
      H('Facturer et compenser'),
      { label: 'Factures récapitulatives (fin de mois)', open: ['customers', 'summary'], perm: 'summary_invoices' },
      { label: 'Compensations client / fournisseur', open: ['customers', 'offsets'], perm: 'account_offsets' },
      { label: 'Dépôt-vente chez les revendeurs', open: ['customers', 'consignment'], perm: 'consignment' },
      { label: 'Ristournes', open: ['customers', 'rebates-state'], perm: 'rebates' },
    ],
  ],
  [
    'Dépenses',
    [
      { label: 'Nouvelle dépense', words: 'dépense charge sortie de caisse', open: ['expenses', 'new'], perm: 'expense_record' },
      { label: 'Historique des dépenses', words: 'charges dépenses', open: ['expenses', 'list'], perm: 'expenses' },
      { label: 'Dépenses par catégorie', open: ['expenses', 'summary'], perm: 'expenses' },
      H('Charges fixes'),
      { label: 'Définition des charges fixes', open: ['expenses', 'plans'], perm: 'charge_plans' },
      { label: 'Constats de charges', open: ['expenses', 'schedule'], perm: 'charge_plans' },
      { label: 'Types de charge', open: ['expenses', 'categories'], perm: 'expense_categories' },
    ],
  ],
  [
    'Personnel',
    [
      { label: 'Collaborateurs (fiches, comptes tiers)', open: ['staff', 'list'] },
      { label: 'Qui est là (présences du jour)', open: ['staff', 'presence'], perm: ['staff_presence', 'staff_attendance'] },
      { label: 'Pointage du personnel', open: ['staff', 'attendance'], perm: 'staff_attendance' },
      { label: 'Borne de pointage', action: 'kiosk', perm: 'staff_kiosk', setting: ['punchKiosk'] },
      H('Organiser'),
      { label: 'Planning de la semaine', open: ['staff', 'planning'], perm: 'staff_leaves' },
      { label: 'Congés du personnel', open: ['staff', 'leaves'], perm: 'staff_leaves' },
      { label: 'Équipes, rotations et pointeuses', open: ['staff', 'teams'], perm: ['staff_teams', 'staff_kiosk', 'staff_attendance'], setting: ['staffTeams', 'multiEntrances', 'fingerprint'] },
      { label: 'Sociétés prestataires (gardiennage, nettoyage)', open: ['staff', 'agencies'], perm: 'staff_agencies', setting: ['contractorStaff'] },
      { label: 'Avertissements', open: ['staff', 'warnings'], perm: ['staff_edit', 'staff_attendance'] },
      H('Payer'),
      { label: 'Salaires du mois', open: ['staff', 'salaries'], perm: 'staff_salaries' },
      { label: 'Objectifs et commissions des vendeurs', open: ['staff', 'targets'], perm: 'staff_targets' },
      { label: 'Extrait de compte d’un collaborateur', open: ['staff', 'statement'] },
    ],
  ],
  [
    'Suivi',
    [
      H('Aujourd’hui'),
      { label: 'Tableau de bord', words: 'tabord chiffres du jour accueil', open: ['dashboard', 'day'], perm: 'dashboard' },
      { label: "Points d'attention", open: ['dashboard', 'attention'], perm: 'dashboard' },
      { label: 'Résumé du jour', open: ['admin', 'digest'], perm: 'dashboard' },
      { label: 'Alertes sur les ventes', open: ['sales', 'alerts'], perm: 'sales_alerts' },
      H('Ventes'),
      { label: 'Registre des ventes', words: 'historique des ventes', open: ['sales', 'register'] },
      { label: 'Situation des ventes', words: 'rapport ventes chiffre d\'affaires', open: ['reports', 'department'], perm: 'reports' },
      { label: 'Évolution périodique', open: ['reports', 'evolution'], perm: 'reports' },
      { label: 'Factures cumulées par client', open: ['reports', 'customer'], perm: 'reports' },
      { label: 'Rapport des contrôles à la sortie', open: ['exit', 'report'], perm: 'exit_report', setting: ['exitCheck'] },
      H('Gérer'),
      { label: 'Prix à revoir (hausses fournisseurs)', open: ['dashboard', 'prices'], perm: 'price_review' },
      { label: "Tableau de l'équipe de la semaine", open: ['dashboard', 'team'], perm: 'team_board' },
      { label: 'Rapport du mois pour le propriétaire', open: ['dashboard', 'owner'], perm: 'owner_report' },
    ],
  ],
  [
    'Compta',
    [
      H('Comptabilité'),
      { label: 'Journaux', open: ['accounting', 'journals'], perm: 'accounting' },
      { label: 'Grand livre', open: ['accounting', 'ledger'], perm: 'accounting' },
      { label: 'Balance générale', open: ['accounting', 'balance'], perm: 'accounting' },
      { label: 'Plan comptable', open: ['accounting', 'accounts'], perm: ['accounting', 'chart_accounts'] },
      { label: 'Immobilisations et amortissements', open: ['accounting', 'assets'], perm: 'fixed_assets' },
      { label: 'Exercices comptables', open: ['accounting', 'fiscal'], perm: ['accounting', 'fiscal_years'] },
      H('Pilotage'),
      { label: 'Trésorerie prévisionnelle', open: ['accounting', 'forecast'], perm: 'cash_forecast' },
      { label: 'Courbe du patrimoine', open: ['accounting', 'patrimony'], perm: 'patrimony' },
      { label: 'Budgets', open: ['accounting', 'budgets'], perm: 'budgets' },
      { label: 'Analytique par rayon et par magasin', open: ['accounting', 'analytics'], perm: 'analytics' },
      { label: 'Export des ventes (CSV)', open: ['sales', 'export'], perm: 'accounting_export' },
      H('Fiscal'),
      { label: 'Déclaration de TVA', words: 'tva impôt', open: ['accounting', 'vat'], perm: 'vat_return' },
      { label: 'Bilan, compte de résultat et DSF', words: 'états financiers bilan', open: ['accounting', 'statements'], perm: 'statements' },
      { label: 'Notes déclaratives de la DSF', open: ['accounting', 'dsf'], perm: ['tax', 'tax_settings'] },
      { label: 'Impôt sur le résultat', open: ['accounting', 'tax'], perm: ['tax', 'tax_settings'] },
    ],
  ],
  [
    'Administration',
    [
      H('Magasin'),
      { label: 'Paramètres', open: ['admin', 'settings'] },
      { label: 'Magasins', open: ['admin', 'stores'], adminOnly: true },
      { label: 'Sociétés et magasins', open: ['admin', 'companies'], perm: 'companies' },
      { label: 'Caisses', open: ['admin', 'registers'] },
      { label: 'Dépôts', open: ['admin', 'warehouses'] },
      { label: 'Couleurs et badges', open: ['admin', 'brand'] },
      { label: "Modèles d'impression", open: ['admin', 'templates'] },
      { label: 'Fiches boutique', open: ['admin', 'fiches'] },
      { label: 'Modèles de boutique', open: ['admin', 'shopTemplates'], adminOnly: true },
      { label: 'Paiement mobile (MTN, Orange)', words: 'momo om marchand', open: ['admin', 'mobilepay'], perm: 'settings_edit' },
      H('Utilisateurs'),
      { label: 'Utilisateurs', open: ['admin', 'users'] },
      { label: 'Droits par rôle', words: 'rôles permissions', open: ['admin', 'rights'] },
      { label: 'Privilèges par utilisateur', words: 'permissions', open: ['admin', 'privileges'] },
      { label: "Journal d'audit", open: ['admin', 'audit'], perm: 'audit' },
      H('Technique'),
      { label: 'Sauvegardes', open: ['admin', 'backups'], perm: 'backups' },
      { label: 'Serveur central', open: ['admin', 'server'] },
      { label: 'État des PC du magasin', open: ['admin', 'stations'], perm: 'stations' },
      { label: 'Postes distants', words: 'caisse à distance relais', open: ['admin', 'relay'] },
      { label: 'Reprise des données (clients, fournisseurs, stock)', open: ['admin', 'takeover'], perm: 'data_takeover' },
      { label: 'Réparation', open: ['admin', 'repair'], adminOnly: true },
      { label: 'Mises à jour', words: 'nouvelle version', open: ['admin', 'updates'] },
      { label: 'Licence', open: ['admin', 'license'] },
    ],
  ],
  [
    'Aide',
    [
      { label: 'Aide sur cette page (F1)', action: 'help' },
      { label: 'Rechercher un écran (Ctrl+K)', action: 'palette' },
      { label: 'Guide de démarrage', action: 'guide' },
      { label: 'Quoi de neuf', action: 'news' },
      SEP,
      { label: 'Raccourcis clavier (Ctrl+/)', action: 'shortcuts' },
      { label: 'À propos', action: 'about' },
    ],
  ],
];

/** Titre d'une fenêtre : « Menu › Écran », d'après le menu qui ouvre cet écran. */
function crumbOf(kind: WinKind, tab?: string): string | undefined {
  for (const [name, items] of MENUS) {
    const item = items.find((i) => i.open && i.open[0] === kind && (i.open[1] ?? '') === (tab ?? ''));
    if (item) return `${name} › ${item.label}`;
  }
  return undefined;
}

/** Onglets rapides en haut de l'écran : quelques écrans du jour selon le rôle, que chacun peut personnaliser. */
const QUICK_BY_ROLE: Record<Role, QuickTab[]> = {
  cashier: [
    { label: 'V. cash 1', open: ['cash1'] },
    { label: 'V. cash 2', open: ['cash2'] },
    { label: 'V. crédit', open: ['credit'], credit: true },
    { label: 'Mes factures', open: ['sales', 'tickets'] },
    { label: 'Ma caisse', open: ['treasury', 'day'] },
  ],
  seller: [
    { label: 'V. cash 1', open: ['cash1'] },
    { label: 'Devis', open: ['quotes'] },
    { label: 'Commandes clients', open: ['orders'] },
    { label: 'Mes factures', open: ['sales', 'tickets'] },
  ],
  stock: [
    { label: 'Tâches du jour', open: ['stock', 'tasks'] },
    { label: 'Réception', open: ['stock', 'receive'] },
    { label: 'État du stock', open: ['stock', 'state'] },
    { label: 'Inventaires', open: ['stock', 'inventory'] },
    { label: 'Transferts', open: ['stock', 'transfer'] },
  ],
  buyer: [
    { label: 'Proposition de commande', open: ['purchases', 'reorder'] },
    { label: 'Bons de commande', open: ['purchases', 'orders'] },
    { label: 'Réceptions', open: ['purchases', 'receptions'] },
    { label: 'Échéancier', open: ['purchases', 'due'] },
  ],
  accountant: [
    { label: 'Journaux', open: ['accounting', 'journals'] },
    { label: 'Grand livre', open: ['accounting', 'ledger'] },
    { label: 'Balance', open: ['accounting', 'balance'] },
    { label: 'Rapprochement', open: ['accounting', 'bank'] },
  ],
  manager: [
    { label: 'V. cash 1', open: ['cash1'] },
    { label: 'Tableau de bord', open: ['dashboard', 'day'] },
    { label: "Points d'attention", open: ['dashboard', 'attention'] },
    { label: 'Journées de caisse', open: ['treasury', 'history'] },
    { label: 'Bons de commande', open: ['purchases', 'orders'] },
    { label: 'État du stock', open: ['stock', 'state'] },
  ],
  admin: [],
};
QUICK_BY_ROLE.admin = QUICK_BY_ROLE.manager;
/** Onglets d'avant 0.88.0, encore proposés dans « Personnaliser les onglets rapides ». */
const QUICK: QuickTab[] = [
  { label: 'Caisse 1', open: ['cash1'] },
  { label: 'Caisse 2', open: ['cash2'] },
  { label: 'Crédit', open: ['credit'], credit: true },
  { label: 'Mes factures', open: ['sales', 'tickets'] },
  { label: 'Registre', open: ['sales', 'z'] },
  { label: 'Produits', open: ['articles'] },
  { label: 'Stock', open: ['stock', 'state'] },
  { label: 'Multi-magasin', open: ['stock', 'multi'] },
  { label: 'Transfert', open: ['stock', 'transfer'] },
  { label: 'Devis', open: ['quotes'] },
  { label: 'Dépenses', open: ['expenses', 'list'] },
  { label: 'Achats', open: ['purchases', 'orders'] },
  { label: 'Trésorerie', open: ['treasury', 'day'] },
  { label: 'Tableau de bord', open: ['dashboard', 'day'] },
  { label: 'Attention', open: ['dashboard', 'attention'] },
];

export const ROLE_LABELS: Record<Role, string> = {
  admin: 'Administrateur',
  manager: 'Gérant',
  cashier: 'Caissier',
  seller: 'Vendeur',
  buyer: "Responsable d'achat (appro)",
  stock: 'Magasinier',
  accountant: 'Comptable',
};

export function App() {
  const [state, setState] = useState<AppState>();
  const refresh = () =>
    call('app.state').then((s) => {
      setVatOn(s.station?.store.vat_enabled !== 0);
      // Langue de l'utilisateur connecté ; avant la connexion, la dernière choisie sur ce PC.
      setLang(s.user && s.prefs.lang ? (s.prefs.lang as Lang) : storedLang());
      setState(s);
    });
  useEffect(() => void refresh(), []);
  // Couleurs de l'entreprise, dès l'écran de connexion.
  const brand = state?.storeSettings;
  useEffect(() => applyBrand(brand?.brandColor, brand?.brandColor2), [brand?.brandColor, brand?.brandColor2]);

  if (!state) return <div className="splash">Chargement…</div>;

  return (
    <ToastProvider>
      {!state.initialized ? (
        <Setup onDone={refresh} />
      ) : !state.user ? (
        <LoginOrKiosk state={state} refresh={refresh} />
      ) : (
        <Workspace key={state.user.id} state={state} user={state.user} refresh={refresh} />
      )}
      <AskHost />
    </ToastProvider>
  );
}

/**
 * PC réglé en borne de pointage : la borne s'affiche à la place de l'écran de
 * connexion ; « Connexion » ouvre l'écran habituel, qui revient à la borne
 * après une minute sans saisie.
 */
function LoginOrKiosk({ state, refresh }: { state: AppState; refresh: () => void }) {
  const kiosk = useLoad(() => (state.station ? call('kiosk.state') : Promise.resolve(null)), []);
  const [login, setLogin] = useState(false);
  useEffect(() => {
    if (!login) return;
    let last = Date.now();
    const bump = () => (last = Date.now());
    window.addEventListener('keydown', bump, true);
    window.addEventListener('mousedown', bump, true);
    const t = setInterval(() => Date.now() - last > 60_000 && setLogin(false), 5000);
    return () => {
      clearInterval(t);
      window.removeEventListener('keydown', bump, true);
      window.removeEventListener('mousedown', bump, true);
    };
  }, [login]);
  if (kiosk.data === undefined && state.station) return <div className="splash">Chargement…</div>;
  if (kiosk.data?.here && !login) return <Kiosk onLogin={() => setLogin(true)} />;
  return <Login station={state.station} fiche={state.dossier.fiche} onDone={refresh} />;
}

/** Texte court de la barre d'état ; le message complet est dans l'infobulle et Administration › Licence. */
/** La mascotte de l'accueil dit bonjour le jour et dort tard le soir. */
function homeMood(): MascotMood {
  const h = new Date().getHours();
  return h >= 22 || h < 5 ? 'dort' : 'bonjour';
}

function licenseLabel(l: AppState['license']): string {
  const days = l.daysLeft === null ? '' : ` (${l.daysLeft} j)`;
  switch (l.state) {
    case 'trial':
      return `Version d'essai${days}`;
    case 'valid':
      return `Licence à renouveler${days}`;
    case 'grace':
      return `Licence expirée : ventes arrêtées dans ${l.daysLeft} j`;
    case 'fiche':
      return l.canSell ? 'Mode formation' : 'Fiche emportée : pas de vente';
    default:
      return 'Licence : ventes bloquées';
  }
}

function Workspace({ state, user, refresh }: { state: AppState; user: User; refresh: () => void }) {
  const toast = useToast();
  const can = (perm: Permission) => user.rights.includes(perm);
  // Sans tout le registre, le caissier garde « Mes factures » pour ses trois dernières.
  const canWin = (kind: WinKind) => WINDOWS[kind].perm.some(can) || (kind === 'sales' && (can('cash') || can('credit')));
  const first: WinKind = (['cash1', 'stock', 'sales', 'articles', 'purchases', 'accounting', 'customers'] as WinKind[]).find(canWin) ?? 'sales';
  // Rôles cochés dans Paramètres › Écran de caisse : leur fiche de vente s'ouvre en mode « Caisse seule ».
  const fullRole = (state.storeSettings?.posFullRoles ?? '').split(',').includes(user.role);
  // Le caissier et le vendeur arrivent sur leur fiche de facturation ; les autres sur la page d'accueil.
  const startOnPos = ['cashier', 'seller'].includes(user.role) || (fullRole && canWin('cash1'));
  const [wins, setWins] = useState<Win[]>(() => (startOnPos ? [{ id: winId(first), kind: first, nonce: 0, crumb: crumbOf(first) }] : []));
  // Fenêtre de devant ; null : la page d'accueil.
  const [active, setActive] = useState<string | null>(startOnPos ? winId(first) : null);
  /** Ordre des fenêtres, de la plus en arrière à celle de devant. */
  const [stack, setStack] = useState<string[]>(() => (startOnPos ? [winId(first)] : []));
  /** Menu « Fenêtres » ouvert (liste des fenêtres, cascade, mosaïque…). */
  const [winMenu, setWinMenu] = useState(false);
  const [area, setArea] = useState<Area>({ w: 0, h: 0 });
  const areaRef = useRef<HTMLElement>(null);
  const [menu, setMenu] = useState<string | null>(null);
  /** Écran « Tous les menus » : chaque menu en tuile, avec tous ses écrans. */
  const [allMenus, setAllMenus] = useState(false);
  const [chooseRegister, setChooseRegister] = useState(false);
  const [help, setHelp] = useState<'shortcuts' | 'about' | 'page' | 'palette' | 'guide' | 'news' | 'tabs' | 'rail' | 'theme' | null>(null);
  /** Place du menu ouvert depuis la barre verte (elle défile : le menu s'affiche par-dessus). */
  const [menuAt, setMenuAt] = useState<{ left: number; top: number; bottom: number } | null>(null);
  const [finding, setFinding] = useState(false);
  /** Borne de pointage ouverte en plein écran par le gérant sur ce PC. */
  const [kiosk, setKiosk] = useState(false);
  /** Mode « Caisse seule » voulu : coché pour le rôle, ou laissé ainsi par l'utilisateur à sa dernière session. */
  const [posFull, setPosFull] = useState(() => fullRole || state.prefs?.posFull === true);
  const [dossiers, setDossiers] = useState(false);
  const [found, setFound] = useState<Result<'pos.sale'> | null>(null);
  // Menu du clic droit : sur un onglet rapide (le déplacer, le retirer) ou sur un écran d'un menu (l'épingler).
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; tab?: number; pin?: QuickTab } | null>(null);
  const [prefs, setPrefs] = useState<Record<string, unknown>>(state.prefs ?? {});
  const sync = useLoad(() => call('sync.state'), []);
  const backupLate = useLoad(() => call('backup.overdue'), []);
  // Fiches déposées dans le dossier partagé : regardé moins souvent (dossier réseau ou cloud).
  const fichesWaiting = useLoad(() => (user.role === 'admin' ? call('fiche.pendingCount') : Promise.resolve(0)), []);
  useEffect(() => {
    const t = setInterval(() => fichesWaiting.reload(), 120_000);
    return () => clearInterval(t);
  }, []);
  const chargesLate = useLoad(() => call('charges.late'), []);
  const gaps = useLoad(() => call('treasury.pendingGaps'), []);
  const attention = useLoad(() => (user.rights.includes('dashboard') ? call('attention.list').catch(() => []) : Promise.resolve([])), []);
  useEffect(() => {
    const t = setInterval(() => attention.reload(), 5 * 60_000);
    return () => clearInterval(t);
  }, []);
  /** Barre latérale large (icônes et noms) ou étroite (icônes seules), gardée sur ce poste ; tiroir sur téléphone. */
  const [side, setSide] = useState<'wide' | 'narrow'>(() => {
    try {
      return localStorage.getItem('onix.side') === 'narrow' || (!localStorage.getItem('onix.side') && window.innerWidth < 1100) ? 'narrow' : 'wide';
    } catch {
      return 'wide';
    }
  });
  const [sideOpen, setSideOpen] = useState(false);
  useEffect(() => setSideOpen(false), [active, help]);
  const toggleSide = () => {
    const next = side === 'wide' ? 'narrow' : 'wide';
    setSide(next);
    setMenu(null);
    try {
      localStorage.setItem('onix.side', next);
    } catch {
      /* poste sans stockage : le choix vaut pour la session */
    }
  };
  const update = useLoad(() => call('update.state'), []);
  useEffect(() => {
    const t = setInterval(update.reload, 5 * 60_000);
    return () => clearInterval(t);
  }, []);

  const [lang, setLangState] = useState<Lang>(currentLang);
  const savePref = (key: string, value: unknown) => {
    setPrefs((p) => ({ ...p, [key]: value }));
    call('prefs.set', key, value).catch(toast.error);
  };
  const quickTabs = ((prefs.quickTabs as QuickTab[] | undefined) ?? QUICK_BY_ROLE[user.role])
    // 0.36.0 : « Stock MM » ouvre le stock multi-magasin (il ouvrait les mouvements).
    .map((q) => (q.label === 'Stock MM' && q.open[0] === 'stock' && q.open[1] === 'moves' ? { ...q, open: ['stock', 'multi'] as QuickTab['open'] } : q))
    // 0.88.0 : des noms en clair.
    .map((q) => ({ ...q, label: q.label === 'TABORD' ? 'Tableau de bord' : q.label === 'Stock MM' ? 'Multi-magasin' : q.label }))
    .filter((q) => canWin(q.open[0]));
  const saveTabs = (tabs: QuickTab[] | null) => {
    savePref('quickTabs', tabs);
    setHelp(null);
  };
  const pin = (t: QuickTab) => {
    const key = (q: QuickTab) => `${q.open[0]}:${q.open[1] ?? ''}`;
    if (quickTabs.some((q) => key(q) === key(t))) return toast.ok(`« ${t.label} » est déjà dans les onglets`);
    saveTabs([...quickTabs, t]);
    toast.ok(`« ${t.label} » ajouté aux onglets rapides`);
  };

  // Après une mise à jour, « Quoi de neuf » s'affiche une fois ; à la première connexion, le guide de démarrage.
  useEffect(() => {
    if (prefs.seenVersion === state.version) return;
    setHelp(prefs.seenVersion ? 'news' : 'guide');
    savePref('seenVersion', state.version);
  }, []);

  useEffect(() => {
    const t = setInterval(() => {
      sync.reload();
      backupLate.reload();
      chargesLate.reload();
      gaps.reload();
    }, 15000);
    return () => clearInterval(t);
  }, []);
  // Paramètres › Affichage : grande taille de texte sur ce PC.
  useEffect(() => {
    document.documentElement.classList.toggle('large-text', state.display === 'large');
  }, [state.display]);
  // Thème choisi par l'utilisateur : clair, sombre ou contraste fort.
  useEffect(() => applyTheme(prefs.theme as Theme | undefined), [prefs.theme]);
  useEffect(() => () => applyTheme('light'), []);
  /** Raccourcis des boutons de la page de devant, relevés à l'ouverture de l'aide clavier. */
  const [pageKeys, setPageKeys] = useState<[string, string][]>([]);
  /** Saisies en cours gardées sur ce PC (coupure de courant) : proposées sur la page d'accueil. */
  const drafts = useLoad(() => call('drafts.list'), []);
  // Paramètres › Sécurité : déconnexion après quelques minutes sans clavier ni souris.
  const idleMinutes = state.storeSettings?.idleMinutes ?? 0;
  useEffect(() => {
    if (!idleMinutes) return;
    let last = Date.now();
    const bump = () => {
      last = Date.now();
    };
    const events = ['mousemove', 'mousedown', 'keydown', 'wheel', 'touchstart'];
    for (const e of events) window.addEventListener(e, bump, true);
    const t = setInterval(() => {
      if (Date.now() - last > idleMinutes * 60000) void call('auth.logout').then(refresh);
    }, 10000);
    return () => {
      for (const e of events) window.removeEventListener(e, bump, true);
      clearInterval(t);
    };
  }, [idleMinutes]);
  useEffect(() => {
    document.title = `ONIX 360 v${state.version} : ${state.station?.store.name ?? ''}, ${state.register?.name ?? 'sans caisse'}, utilisateur ${user.name}`;
  }, [state, user]);
  useEffect(() => {
    if (!menu && !ctxMenu && !winMenu) return;
    const close = () => {
      setMenu(null);
      setCtxMenu(null);
      setWinMenu(false);
    };
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [menu, ctxMenu, winMenu]);
  // Ctrl+K cherche un écran ; F1 ouvre l'aide de la page (sauf à la caisse, où F1 cherche un produit).
  const activeWin = wins.find((w) => w.id === active);
  const onPos = activeWin?.kind === 'cash1' || activeWin?.kind === 'cash2' || activeWin?.kind === 'credit';
  // La caisse seule à l'écran tant qu'une fiche de vente est devant ; ailleurs (trésorerie, clôture) l'affichage habituel revient.
  const full = posFull && onPos && !activeWin?.min;
  const toggleFull = () => {
    setPosFull(!full);
    savePref('posFull', !full);
  };
  useEffect(() => {
    call('window.fullScreen', full).catch(() => undefined);
  }, [full]);
  useEffect(() => () => void call('window.fullScreen', false).catch(() => undefined), []);
  // F11 est gardée par le logiciel avant Electron, qui l'envoie ici.
  useEffect(() => window.superette.onShortcut?.((key) => key === 'F11' && onPos && toggleFull()));
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setAllMenus(false);
      if (e.key === 'F11' && onPos) {
        e.preventDefault();
        toggleFull();
      }
      if (e.ctrlKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setAllMenus(false);
        setHelp('palette');
      } else if (e.ctrlKey && (e.key === '/' || e.code === 'Slash' || e.key === ':')) {
        // Ctrl+/ : les raccourcis de la page affichée.
        e.preventDefault();
        setPageKeys(pageShortcuts());
        setHelp('shortcuts');
      } else if (e.key === 'F1' && !onPos) {
        e.preventDefault();
        setHelp('page');
      } else if (e.key === 'F2' && !onPos && !help && canWin('cash1')) {
        // F2 hors de la caisse : nouvelle vente (à la caisse, F2 valide et imprime le ticket).
        e.preventDefault();
        open('cash1', undefined, 'Vente › Vente au comptant 1');
      } else if (e.ctrlKey && e.key.toLowerCase() === 'j' && !onPos) {
        // Ctrl+J : nouveau ; dans un formulaire, enregistre et en rouvre un vide.
        e.preventDefault();
        ctrlJ();
      } else if (e.key === 'F5' && !onPos && !e.ctrlKey) {
        // F5 actualise la fenêtre de devant (à la caisse, F5 ouvre le tiroir).
        e.preventDefault();
        if (active) refreshWin(active);
      } else if (e.ctrlKey && e.key === 'F4' && !onPos) {
        // Ctrl+F4 ferme la fenêtre de devant, comme dans Sage (pas à la caisse : la fiche en cours y resterait).
        e.preventDefault();
        if (active) close(active);
      } else if (e.ctrlKey && e.key === 'Tab') {
        // Ctrl+Tab passe à la fenêtre suivante (Ctrl+Maj+Tab : la précédente).
        e.preventDefault();
        cycle(e.shiftKey ? -1 : 1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // Taille de la zone de travail : les fenêtres restent dedans quand l'écran change.
  useEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    const measure = () => setArea({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  /** Place de chaque fenêtre sur ce poste ; la caisse s'ouvre en plein écran. */
  const geos = (prefs.winGeo as Record<string, Geo> | undefined) ?? {};
  const isPosKind = (kind: WinKind) => kind === 'cash1' || kind === 'cash2' || kind === 'credit';
  // Place donnée à l'ouverture (en cascade) tant que la fenêtre n'a pas été déplacée.
  const [placed, setPlaced] = useState<Record<string, Geo>>({});
  const isDialog = (id: string) => DIALOG_WINDOWS.has(id);
  // Avant 0.90.0 la place était gardée par module (« admin ») : elle sert encore à son premier écran.
  const geoOf = (w: Win): Geo => (isDialog(w.id) ? placed[w.id] ?? dialogGeo(area) : geos[w.id] ?? geos[w.kind] ?? placed[w.id] ?? defaultGeo(area, 0, isPosKind(w.kind)));
  const saveGeo = (w: Win, g: Geo) => (isDialog(w.id) ? setPlaced((p) => ({ ...p, [w.id]: g })) : savePref('winGeo', { ...geos, [w.id]: g }));
  /** Met une fenêtre devant les autres (et la sort de la barre du bas si elle était réduite). */
  const focus = (id: string | null) => {
    setActive(id);
    if (!id) return;
    setWins((ws) => (ws.some((w) => w.id === id && w.min) ? ws.map((w) => (w.id === id ? { ...w, min: false } : w)) : ws));
    setStack((st) => (st[st.length - 1] === id ? st : [...st.filter((k) => k !== id), id]));
  };

  const open = (kind: WinKind, tab?: string, crumb?: string) => {
    if (!canWin(kind)) return toast.error("Vous n'avez pas les droits pour ouvrir cette fenêtre");
    const id = winId(kind, tab);
    if (!wins.some((w) => w.id === id)) setPlaced((p) => ({ ...p, [id]: isDialog(id) ? dialogGeo(area) : defaultGeo(area, wins.filter((w) => !w.min).length, isPosKind(kind)) }));
    // Le titre vient du menu (« Administration › Paramètres ») ; à défaut, du libellé reçu.
    // Un chemin complet reçu (« Vente › Modifier la facture … ») remplace le titre d'une fenêtre déjà ouverte.
    const full = crumb?.includes(' › ') ? crumb : undefined;
    const title = full ?? crumbOf(kind, tab) ?? crumb;
    setWins((ws) => (!ws.some((w) => w.id === id) ? [...ws, { id, kind, tab, nonce: 0, crumb: title }] : full ? ws.map((w) => (w.id === id ? { ...w, crumb: full } : w)) : ws));
    // Un écran déjà ouvert revient devant au lieu de s'ouvrir une deuxième fois.
    focus(id);
  };
  /** – : la fenêtre va dans la barre du bas ; celle de derrière passe devant. */
  const minimize = (id: string) => {
    setWins((ws) => ws.map((w) => (w.id === id ? { ...w, min: true } : w)));
    if (active === id) setActive([...stack].reverse().find((k) => k !== id && !wins.find((w) => w.id === k)?.min) ?? null);
  };
  /** Ctrl+Tab : fenêtre suivante dans l'ordre d'ouverture, réduites comprises. */
  const cycle = (step: 1 | -1) => {
    if (!wins.length) return;
    const at = wins.findIndex((w) => w.id === active);
    const next = wins[(at + step + wins.length) % wins.length] ?? wins[0]!;
    focus(next.id);
  };
  /** Fenêtres › Cascade ou Mosaïque : ressort les fenêtres réduites et les replace (les boîtes de dialogue gardent leur place). */
  const arrange = (how: 'cascade' | 'tile') => {
    const shown = wins.filter((w) => !isDialog(w.id));
    const tiles = tileGeos(area, shown.length);
    const next = { ...geos };
    shown.forEach((w, i) => (next[w.id] = how === 'cascade' ? defaultGeo(area, i, false) : tiles[i]!));
    savePref('winGeo', next);
    setWins((ws) => ws.map((w) => (w.min && !isDialog(w.id) ? { ...w, min: false } : w)));
    const last = shown[shown.length - 1];
    if (last) focus(last.id);
    setWinMenu(false);
  };
  const minimizeAll = () => {
    setWins((ws) => ws.map((w) => ({ ...w, min: true })));
    setActive(null);
    setWinMenu(false);
  };
  const closeAll = () => {
    setWins([]);
    setStack([]);
    setActive(null);
    setWinMenu(false);
  };
  /** L'écran passe de lui-même à une autre vue (« Privilèges… » depuis Utilisateurs) : la fenêtre en prend le nom. */
  const retitle = (id: string, label: string) =>
    setWins((ws) => ws.map((w) => (w.id === id ? { ...w, crumb: `${(w.crumb ?? WINDOWS[w.kind].label).split(' › ')[0]} › ${label}` } : w)));
  /** Facture à modifier : elle se recharge dans la fiche au comptant 1, ou à crédit pour une vente à crédit. */
  const [editReq, setEditReq] = useState<{ kind: WinKind; sale: Result<'sales.editable'> & { id: string }; nonce: number } | null>(null);
  useEffect(() => {
    const onEdit = (e: Event) => {
      const id = (e as CustomEvent<string>).detail;
      call('sales.editable', id).then((sale) => {
        const kind: WinKind = sale.credit ? 'credit' : 'cash1';
        open(kind, undefined, `Vente › Modifier la facture ${sale.number}`);
        setEditReq((r) => ({ kind, sale: { ...sale, id }, nonce: (r?.nonce ?? 0) + 1 }));
      }, toast.error);
    };
    window.addEventListener(EDIT_SALE_EVENT, onEdit);
    return () => window.removeEventListener(EDIT_SALE_EVENT, onEdit);
  });
  // Écran demandé ailleurs : solution d'un message d'erreur, tâche du jour, réassort…
  useEffect(() => {
    const onOpen = (e: Event) => {
      const [kind, tab] = (e as CustomEvent<[WinKind, string?]>).detail;
      if (kind in WINDOWS) open(kind, tab);
    };
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_EVENT, onOpen);
  });
  /** ⟳ : recharge les données de la fenêtre sans la fermer. */
  const refreshWin = (id: string) => setWins((ws) => ws.map((w) => (w.id === id ? { ...w, rev: (w.rev ?? 0) + 1 } : w)));
  const close = (id: string | null) => {
    if (!id) return;
    setWins(wins.filter((w) => w.id !== id));
    const rest = stack.filter((k) => k !== id);
    setStack(rest);
    // La fenêtre juste derrière passe devant ; sans fenêtre ouverte, la page d'accueil s'affiche.
    if (active === id) setActive([...rest].reverse().find((k) => !wins.find((w) => w.id === k)?.min) ?? null);
  };

  /**
   * Éléments permis à l'utilisateur, sans séparateur en tête, en fin ni en double.
   * Ce qui n'est pas permis ne s'affiche pas du tout (pas de ligne grisée).
   */
  const supervisor = user.role === 'admin' || user.role === 'manager';
  const visibleItems = (items: MenuItem[]) =>
    items
      .filter((i) => (!i.perm || [i.perm].flat().some(can)) && (!i.adminOnly || user.role === 'admin'))
      .filter((i) => (!i.open || canWin(i.open[0])) && (!i.soon || supervisor))
      // Magasin sans TVA : pas de déclaration de TVA.
      .filter((i) => hasVat() || i.open?.[1] !== 'vat')
      // Options du personnel que le magasin n'a pas choisies : leurs écrans ne s'affichent pas.
      .filter((i) => !i.setting || i.setting.some((k) => Boolean(state.storeSettings?.[k])))
      .filter((i) => i.open?.[0] !== 'sales' || can('sales') || Boolean(i.perm) || i.open[1] === 'tickets')
      // Un petit titre sans écran sous lui disparaît ; un trait ni en tête, ni en fin, ni à côté d'un titre.
      .filter((i, n, all) => !i.head || (n < all.length - 1 && !all[n + 1]!.sep))
      .filter((i, n, all) => !i.sep || i.head || (n > 0 && n < all.length - 1 && !all[n - 1]!.sep && !all[n + 1]!.sep));
  const visibleMenus = MENUS.filter(([, items]) => visibleItems(items).some((i) => !i.sep));

  const startTraining = async () => {
    if (state.dossier.fiche?.kind === 'formation') return toast.ok('Vous êtes déjà en mode formation');
    const ok = await askConfirm(
      "Ouvrir le mode formation ? ONIX 360 redémarre sur une copie de la boutique : on y vend pour s'entraîner, avec les vrais articles et les vrais comptes, mais rien ne compte dans la boutique (ni stock, ni caisse, ni comptabilité, ni serveur). « Quitter la formation » ramène à la boutique.",
    );
    if (!ok) return;
    try {
      await call('training.start');
    } catch (e) {
      toast.error(e);
    }
  };
  const leave = async () => {
    if (!(await askConfirm('Noter votre départ (pointage) et vous déconnecter ?'))) return;
    try {
      const row = await call('attendance.leave');
      if (row?.left_at) toast.ok(`Départ noté à ${new Date(row.left_at).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}. Bonne soirée !`);
    } catch (e) {
      toast.error(e);
    }
    refresh();
  };
  const run = async (item: MenuItem, menuName: string) => {
    setMenu(null);
    setAllMenus(false);
    if (item.soon) return;
    if (item.open) return open(item.open[0], item.open[1], `${menuName} › ${item.label}`);
    if (item.action === 'logout') return call('auth.logout').then(refresh);
    if (item.action === 'leave') return leave();
    if (item.action === 'kiosk') return setKiosk(true);
    if (item.action === 'training') return startTraining();
    if (item.action === 'dossiers') return setDossiers(true);
    if (item.action === 'quit') return window.close();
    if (item.action === 'shortcuts') setPageKeys(pageShortcuts());
    if (item.action === 'shortcuts' || item.action === 'about' || item.action === 'palette' || item.action === 'guide' || item.action === 'news' || item.action === 'tabs' || item.action === 'rail' || item.action === 'theme') return setHelp(item.action);
    if (item.action === 'help') return setHelp('page');
    if (item.action === 'openInvoice') return setFinding(true);
    if (item.action === 'sync') {
      try {
        const r = await call('sync.now');
        toast.ok(`Synchronisé : ${r.sent} envoyée(s), ${r.received} reçue(s)`);
      } catch (err) {
        toast.error(err);
      }
      sync.reload();
    }
  };

  // Tous les écrans permis, pour la recherche Ctrl+K.
  const paletteEntries: PaletteEntry[] = [
    ...[['Mon compte', FILE_MENU] as [string, MenuItem[]], ...visibleMenus].flatMap(([name, items]) =>
      visibleItems(items)
        .filter((i) => !i.sep && !i.soon && i.action !== 'palette')
        .map((i) => ({ menu: name, label: i.label, words: i.words, run: () => void run(i, name) })),
    ),
    { menu: 'Accueil', label: "Page d'accueil", run: () => setActive(null) },
  ];

  /**
   * Un menu de la barre verte s'affiche en entier, sans défiler : sur plusieurs colonnes
   * si l'écran est trop bas, puis placé à hauteur de son bouton sans sortir de l'écran.
   */
  const fitMenu = (el: HTMLElement, at: NonNullable<typeof menuAt>) => {
    const overflows = () => el.scrollHeight > el.clientHeight + 2 || el.scrollWidth > el.clientWidth + 2;
    for (let cols = 1; cols <= 4; cols++) {
      el.classList.toggle('cols', cols > 1);
      el.style.columnCount = cols > 1 ? String(cols) : '';
      el.style.width = cols > 1 ? `${cols * 300}px` : '';
      if (!overflows()) break;
    }
    const h = el.offsetHeight;
    const top = at.top > window.innerHeight / 2 ? at.bottom - h : at.top;
    el.style.top = `${Math.max(10, Math.min(top, window.innerHeight - h - 10))}px`;
  };
  /** Liste d'un menu, ouverte à côté de la barre verte (ou sous le nom de l'utilisateur). */
  const MenuDrop = ({ name, items, up, right, at }: { name: string; items: MenuItem[]; up?: boolean; right?: boolean; at?: typeof menuAt }) => {
    const groups = items.reduce<MenuItem[][]>((g, i) => (i.sep || !g.length ? [...g, [i]] : (g[g.length - 1]!.push(i), g)), []);
    return (
    <div
      className={`menu-drop ${up ? 'up' : ''} ${right ? 'right' : ''} ${at ? 'fixed' : ''}`}
      style={at ? { left: at.left, top: 10, maxHeight: window.innerHeight - 20 } : undefined}
      ref={(el) => {
        if (at && el) fitMenu(el, at);
      }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="menu-title">{name}</div>
      {groups.map((g, k) => (
        <div key={k} className="menu-group">
      {g.map((i, n) =>
        i.head ? (
          <div key={`head-${n}`} className="menu-head">
            {i.label}
          </div>
        ) : i.sep ? (
          <hr key={`sep-${n}`} />
        ) : (
          <button
            key={i.label}
            disabled={i.soon}
            onClick={() => void run(i, name)}
            onContextMenu={(e) => {
              if (!i.open) return;
              e.preventDefault();
              e.stopPropagation();
              setCtxMenu({ x: e.clientX, y: e.clientY, pin: { label: i.label, open: i.open } });
            }}
          >
            {i.label}
            {i.badge === 'gaps' && Boolean(gaps.data?.length) && <small className="neg">{gaps.data!.length} écart(s) à justifier</small>}
            {i.soon && <small>bientôt</small>}
          </button>
        ),
      )}
        </div>
      ))}
    </div>
    );
  };
  // Barre verte : les menus choisis par l'utilisateur, dans son ordre ; par défaut tous.
  const railChoice = prefs.railMenus as string[] | undefined;
  const railMenus = railChoice
    ? [...new Set(railChoice.flatMap((n) => OLD_MENUS[n] ?? [n]))].flatMap((n) => visibleMenus.filter(([name]) => name === n && !RAIL_FIXED.includes(name)))
    : visibleMenus.filter(([name]) => !RAIL_FIXED.includes(name));
  const railBottom = visibleMenus.filter(([name]) => RAIL_FIXED.includes(name));
  /** Ouvre un menu de la barre verte à hauteur de son bouton (vers le haut dans la moitié basse de l'écran). */
  const toggleRailMenu = (name: string, btn: HTMLElement) => {
    setAllMenus(false);
    if (menu === name) return setMenu(null);
    const r = btn.getBoundingClientRect();
    setMenuAt({ left: r.right + 8, top: r.top, bottom: r.bottom });
    setMenu(name);
  };

  const syncLabel = !sync.data?.connected ? 'Serveur : non relié' : sync.data.lastError ? 'Serveur : hors ligne' : sync.data.pending ? `Serveur : ${sync.data.pending} en attente` : 'Serveur : connecté';
  const showHome = !activeWin || activeWin.min;
  // Retour à l'accueil : les saisies en cours sont relues (l'une vient peut-être d'être enregistrée).
  useEffect(() => {
    if (showHome) drafts.reload();
  }, [showHome]);
  const tiles = ROLE_TILES[user.role].filter((t) => canWin(t.open[0]));
  const attentionCount = (attention.data ?? []).reduce((n, i) => n + (i.count ? 1 : 0), 0);

  return (
    <RightsProvider value={user.rights}>
    <StoreSettingsProvider value={state.storeSettings ?? DEFAULT_STORE_SETTINGS}>
    <div className={`desk side-${side} ${onPos ? 'on-pos' : ''} ${full ? 'pos-full' : ''}`}>
      {sideOpen && <div className="side-back" onClick={() => setSideOpen(false)} aria-hidden />}
      <nav className={`rail ${sideOpen ? 'open' : ''}`} aria-label="Menus">
        <div className="side-head">
          <button className={`rail-logo ${showHome ? 'on' : ''}`} title="Page d'accueil" onClick={() => (setAllMenus(false), setActive(null), setSideOpen(false))}>
            <img src={logo} alt="" />
          </button>
          <span className="side-brand">
            <b>ONIX 360</b>
            <small>{state.station?.store.name}</small>
          </span>
        </div>
        <button className={`rail-link side-home ${showHome && !allMenus ? 'on' : ''}`} data-tip="Accueil" onClick={() => (setAllMenus(false), setActive(null), setSideOpen(false))}>
          <i aria-hidden>
            <Ico.House size={18} strokeWidth={1.9} />
          </i>
          <span className="rail-label">Accueil</span>
        </button>
        {/* Faire défiler la barre ferme le menu ouvert ; la roulette dans le menu lui-même le fait défiler. */}
        <div className="rail-scroll" onWheel={(e) => menu && !(e.target as HTMLElement).closest('.menu-drop') && setMenu(null)}>
          {railMenus.map(([name, items]) => (
            <div key={name} className="menu">
              <button
                className={`rail-item ${menu === name ? 'open' : ''}`}
                title={name}
                data-tip={RAIL_LABELS[name] ?? name}
                aria-haspopup="menu"
                aria-expanded={menu === name}
                onClick={(e) => {
                  e.stopPropagation();
                  // « Tous les menus » couvre l'écran : on le ferme pour voir le menu choisi.
                  toggleRailMenu(name, e.currentTarget);
                  chargesLate.reload();
                  gaps.reload();
                }}
              >
                <i aria-hidden>
                  <MenuIcon name={name} fallback={MENU_ICONS[name]} />
                </i>
                <span className="rail-label">{RAIL_LABELS[name] ?? name}</span>
                <Ico.ChevronRight className="rail-chev" size={15} aria-hidden />
              </button>
              {menu === name && <MenuDrop name={name} items={visibleItems(items)} at={menuAt} />}
            </div>
          ))}
        </div>
        <button className="rail-link side-search" data-tip="Rechercher (Ctrl+K)" onClick={() => (setSideOpen(false), setHelp('palette'))}>
          <i aria-hidden>
            <Ico.Search size={18} strokeWidth={1.9} />
          </i>
          <span className="rail-label">Rechercher</span>
          <kbd className="rail-kbd">Ctrl K</kbd>
        </button>
        <button
          className={`rail-item ${allMenus ? 'open' : ''}`}
          data-tip="Tous les menus"
          onClick={(e) => {
            e.stopPropagation();
            setMenu(null);
            setAllMenus((v) => !v);
            chargesLate.reload();
            gaps.reload();
          }}
        >
          <i aria-hidden>
            <Ico.LayoutGrid size={18} strokeWidth={1.9} />
          </i>
          <span className="rail-label">Tous les menus</span>
        </button>
        {railBottom.map(([name, items]) => (
          <div key={name} className="menu">
            <button
              className={`rail-item ${menu === name ? 'open' : ''}`}
              data-tip={RAIL_LABELS[name] ?? name}
              aria-haspopup="menu"
              aria-expanded={menu === name}
              onClick={(e) => {
                e.stopPropagation();
                toggleRailMenu(name, e.currentTarget);
              }}
            >
              <i aria-hidden>
                <MenuIcon name={name} fallback={MENU_ICONS[name]} />
              </i>
              <span className="rail-label">{RAIL_LABELS[name] ?? name}</span>
              <Ico.ChevronRight className="rail-chev" size={15} aria-hidden />
            </button>
            {menu === name && <MenuDrop name={name} items={visibleItems(items)} at={menuAt} />}
          </div>
        ))}
        <div className="menu side-user-wrap">
          <button
            className={`side-user ${menu === '__side_user' ? 'open' : ''}`}
            data-tip={`${user.name} (${ROLE_LABELS[user.role]})`}
            onClick={(e) => {
              e.stopPropagation();
              toggleRailMenu('__side_user', e.currentTarget);
            }}
          >
            <b aria-hidden>{user.name.slice(0, 1).toUpperCase()}</b>
            <span className="rail-label">
              {user.name}
              <small>{ROLE_LABELS[user.role]}</small>
            </span>
          </button>
          {menu === '__side_user' && <MenuDrop name="Mon compte" items={visibleItems(FILE_MENU)} at={menuAt} />}
        </div>
        <button className="side-toggle" title={side === 'narrow' ? 'Agrandir la barre latérale' : 'Réduire la barre latérale'} onClick={toggleSide}>
          {side === 'narrow' ? <Ico.PanelLeftOpen size={17} /> : <Ico.PanelLeftClose size={17} />}
          <span className="rail-label">Réduire</span>
        </button>
      </nav>
      <header className="topbar">
        <button className="top-icon side-burger" aria-label="Ouvrir les menus" title="Menus" onClick={() => (window.innerWidth < 760 ? setSideOpen((v) => !v) : toggleSide())}>
          <Ico.Menu size={18} />
        </button>
        <div className="quick-tabs">
          {quickTabs.map((q, idx) => {
            // Chaque onglet rapide a sa fenêtre : en relief quand elle est devant, marqué quand elle est ouverte.
            const id = winId(q.open[0], q.open[1]);
            const isOpen = wins.some((w) => w.id === id);
            const isActive = isOpen && active === id && !showHome;
            return (
              <button
                key={`${q.label}-${idx}`}
                className={`${isActive ? 'active' : isOpen ? 'open' : ''} ${q.credit ? 'credit' : ''}`}
                title="Clic droit : déplacer ou retirer cet onglet"
                onClick={() => open(q.open[0], q.open[1], q.label)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setCtxMenu({ x: e.clientX, y: e.clientY, tab: idx });
                }}
              >
                {q.label}
              </button>
            );
          })}
        </div>
        {wins.length > 0 && (
          <div className="menu">
            <button
              className={`top-icon win-btn ${winMenu ? 'open' : ''}`}
              title="Fenêtres ouvertes : passer de l'une à l'autre, cascade, mosaïque"
              onClick={(e) => {
                e.stopPropagation();
                setMenu(null);
                setWinMenu((v) => !v);
              }}
            >
              ❐ <small>{wins.length}</small>
            </button>
            {winMenu && (
              <div className="menu-drop right win-menu" onClick={(e) => e.stopPropagation()}>
                <div className="menu-title">Fenêtres</div>
                {wins.map((w) => (
                  <button key={w.id} className={w.id === active && !w.min ? 'on' : ''} onClick={() => (focus(w.id), setWinMenu(false))}>
                    {w.crumb ?? WINDOWS[w.kind].label}
                    {w.min && <small>réduite</small>}
                  </button>
                ))}
                <hr />
                <button onClick={() => arrange('cascade')}>Cascade</button>
                <button onClick={() => arrange('tile')}>Mosaïque</button>
                <button onClick={minimizeAll}>Tout réduire</button>
                <button onClick={closeAll}>Tout fermer</button>
              </div>
            )}
          </div>
        )}
        <button className="top-icon tab-add" title="Personnaliser les onglets rapides" onClick={() => setHelp('tabs')}>
          ＋
        </button>
        <button className="top-search" title="Rechercher un écran, un produit, un client (Ctrl+K)" onClick={() => setHelp('palette')}>
          <Ico.Search size={16} aria-hidden />
          <span>Rechercher…</span>
          <kbd>Ctrl K</kbd>
        </button>
        {can('dashboard') && (
          <button className="top-icon top-bell" title="Points d'attention" aria-label={`Points d'attention : ${attentionCount}`} onClick={() => open('dashboard', 'attention', "Suivi › Points d'attention")}>
            <Ico.Bell size={17} aria-hidden />
            {attentionCount > 0 && <span className="dot">{attentionCount > 99 ? '99+' : attentionCount}</span>}
          </button>
        )}
        <div className="menu">
          <button
            className={`user-chip ${menu === '__user' ? 'open' : ''}`}
            title={`${user.name} (${ROLE_LABELS[user.role]})`}
            onClick={(e) => {
              e.stopPropagation();
              setMenu(menu === '__user' ? null : '__user');
            }}
          >
            <b>{user.name.slice(0, 1).toUpperCase()}</b>
          </button>
          {menu === '__user' && <MenuDrop name="Mon compte" items={visibleItems(FILE_MENU)} right />}
        </div>
        <button className="help-btn" title="Aide sur cette page (F1)" onClick={() => setHelp('page')}>
          ?
        </button>
      </header>
      {state.dossier.fiche && (
        <FicheBanner
          fiche={state.dossier.fiche}
          onSaveCopy={() => void saveFicheCopy(toast)}
          onStopTraining={() => call('training.stop').catch(toast.error)}
        />
      )}
      <main className="windows" ref={areaRef}>
        {/* La page d'accueil est le fond de la zone de travail ; le logo la met devant les fenêtres. */}
        <section className={`home ${showHome ? 'front' : ''}`}>
          <div className="home-wrap">
            <header className="home-hello">
              <Mascot mood={homeMood()} size={64} className="home-mascotte" />
              <div>
                <p className="home-date">{new Date().toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' })}</p>
                <h1>Bonjour {user.name.split(' ')[0]}</h1>
                <p className="home-sub">
                  {state.station?.store.name} · {ROLE_LABELS[user.role]}
                  {(state.station?.store.address || state.station?.store.phone) && (
                    <span className="muted"> · {[state.station?.store.address, state.station?.store.phone].filter(Boolean).join(' · ')}</span>
                  )}
                </p>
              </div>
              {canWin('cash1') && (
                <button className="primary home-cta" onClick={() => open('cash1', undefined, 'Vente › Vente au comptant 1')}>
                  <Ico.Plus size={17} aria-hidden /> Nouvelle vente <kbd>F2</kbd>
                </button>
              )}
            </header>
            {(can('cash') || can('credit')) && showHome && <MyDay />}
            {Boolean(drafts.data?.length) && showHome && (
              <div className="home-drafts">
                <h2>Saisies en cours retrouvées</h2>
                {drafts.data!.map((d) => {
                  const target = DRAFT_SCREENS[d.key.split(':')[0]!];
                  return (
                    <button key={d.key} disabled={!target || !canWin(target[0] as WinKind)} onClick={() => target && open(target[0] as WinKind, target[1])}>
                      {d.label} <small className="muted">· gardée le {dateTime(d.updated_at)}</small>
                    </button>
                  );
                })}
              </div>
            )}
            {can('day_tasks') && showHome && <DayTasks compact />}
            <h2 className="home-section">Accès rapides</h2>
            <div className="role-tiles">
              {tiles.map((t) => (
                <button key={t.label} onClick={() => open(t.open[0], t.open[1], t.label)}>
                  <span className="tile-icon" aria-hidden>
                    {t.icon}
                  </span>
                  <span className="tile-text">
                    <strong>{t.label}</strong>
                    <small>{t.desc}</small>
                  </span>
                </button>
              ))}
            </div>
            <p className="home-links">
              <button className="link" onClick={() => setHelp('palette')}>
                Chercher un autre écran <kbd>Ctrl K</kbd>
              </button>
              <button className="link" onClick={() => setHelp('guide')}>
                Guide de démarrage
              </button>
              <button className="link" onClick={() => setHelp('news')}>
                Quoi de neuf
              </button>
            </p>
          </div>
        </section>
        {wins.map((w) => (
          <MdiWindow
            key={`${w.id}-${w.nonce}`}
            title={w.crumb ?? WINDOWS[w.kind].label}
            icon={<MenuIcon name={(w.crumb ?? '').split(' › ')[0]!} fallback={MENU_ICONS[(w.crumb ?? '').split(' › ')[0]!] ?? winIcon(w.kind)} size={15} />}
            geo={geoOf(w)}
            area={area}
            z={stack.indexOf(w.id) + 1}
            active={w.id === active}
            dialog={isDialog(w.id)}
            minimized={w.min}
            onMinimize={() => minimize(w.id)}
            onFocus={() => focus(w.id)}
            onChange={(g) => saveGeo(w, g)}
            onClose={() => close(w.id)}
            onRefresh={() => refreshWin(w.id)}
            onFull={isPosKind(w.kind) ? toggleFull : undefined}
            full={full && w.id === active}
            extra={
              full && w.id === active ? (
                <span className="pos-switch" onPointerDown={(e) => e.stopPropagation()}>
                  {POS_SWITCH.filter(([kind]) => canWin(kind)).map(([kind, label]) => (
                    <button key={kind} type="button" className={w.kind === kind ? 'on' : ''} title="Passer à cette fiche de vente sans quitter le plein écran" onClick={() => open(kind)}>
                      {label}
                    </button>
                  ))}
                </span>
              ) : undefined
            }
          >
            <SingleViewCtx.Provider value={{ onView: (label) => retitle(w.id, label) }}>
            <RefreshCtx.Provider value={w.rev ?? 0}>
            {(w.kind === 'cash1' || w.kind === 'cash2' || w.kind === 'credit') && (
              <Pos
                user={user}
                mode={w.kind === 'credit' ? 'credit' : 'cash'}
                hasRegister={Boolean(state.register)}
                registerId={state.register?.id ?? null}
                canChooseRegister={state.canChooseRegister}
                onRegisterChosen={refresh}
                vatEnabled={state.station?.store.vat_enabled !== 0}
                ignoreStock={state.station?.store.ignore_stock === 1}
                layout={state.posLayout}
                edit={editReq?.kind === w.kind ? editReq : null}
                active={w.id === active && !w.min}
                title={w.kind === 'cash1' ? 'Fiche de facturation 1' : w.kind === 'cash2' ? 'Fiche de facturation 2' : 'Facture à crédit'}
                onClose={() => close(w.id)}
                onSwitchMode={() => (w.kind === 'credit' ? open('cash1', undefined, 'Vente › Vente au comptant 1') : open('credit', undefined, 'Vente › Vente à crédit'))}
                onTreasury={() => open('treasury', 'day', 'Trésorerie › Opérations de trésorerie')}
              />
            )}
            {w.kind === 'articles' && <Articles user={user} view={w.tab as ArticlesView | undefined} />}
            {w.kind === 'stock' && <Stock user={user} initialTab={w.tab as StockTab | undefined} />}
            {w.kind === 'sales' && <Sales initialTab={w.tab as SalesTab | undefined} rights={user.rights} />}
            {w.kind === 'purchases' && <Purchases user={user} initialTab={w.tab as PurchasesTab | undefined} />}
            {w.kind === 'suppliers' && <Suppliers user={user} initialTab={w.tab as SuppliersTab | undefined} />}
            {w.kind === 'customers' && <Customers user={user} initialTab={w.tab as CustomersTab | undefined} />}
            {w.kind === 'production' && <Production user={user} initialTab={w.tab as ProductionTab | undefined} />}
            {w.kind === 'quotes' && <Quotes user={user} startNew={w.tab === 'new'} />}
            {w.kind === 'deliveries' && <Deliveries active={w.id === active && !w.min} />}
            {w.kind === 'orders' && <Orders user={user} initialView={w.tab === 'recurring' ? 'recurring' : 'orders'} />}
            {w.kind === 'exit' && <ExitChecks initialTab={w.tab as ExitTab | undefined} />}
            {w.kind === 'promotions' && <Promotions active={w.id === active && !w.min} />}
            {w.kind === 'labels' && <Labels active={w.id === active && !w.min} />}
            {w.kind === 'reports' && <Reports view={w.tab} />}
            {w.kind === 'expenses' && <Expenses user={user} initialTab={w.tab as ExpensesTab | undefined} />}
            {w.kind === 'staff' && <Staff user={user} initialTab={w.tab as StaffTab | undefined} />}
            {w.kind === 'containers' && <Containers initialTab={w.tab as ContainersTab | undefined} />}
            {w.kind === 'agent' && <AgentPoint initialTab={w.tab as AgentTab | undefined} />}
            {w.kind === 'control' && <CashierControl />}
            {w.kind === 'accounting' && <Accounting user={user} initialTab={w.tab as AccountingTab | undefined} />}
            {w.kind === 'treasury' && <Treasury user={user} registerId={state.register?.id ?? null} initialTab={w.tab as TreasuryTab | undefined} onChanged={() => (refresh(), gaps.reload())} />}
            {w.kind === 'dashboard' && <Dashboard initialTab={w.tab as DashboardTab | undefined} onOpen={([kind, tab]) => open(kind, tab)} />}
            {w.kind === 'admin' && <Admin user={user} onChanged={() => (refresh(), backupLate.reload(), fichesWaiting.reload())} initialTab={w.tab as AdminTab | undefined} />}
            </RefreshCtx.Provider>
            </SingleViewCtx.Provider>
          </MdiWindow>
        ))}
        {wins.some((w) => w.min) && (
          <div className="mdi-tray" aria-label="Fenêtres réduites">
            {wins
              .filter((w) => w.min)
              .map((w) => (
                <div key={w.id} className="mdi-tray-item">
                  <button className="mdi-tray-open" title="Rouvrir cette fenêtre" onClick={() => focus(w.id)}>
                    <i aria-hidden>{MENU_ICONS[(w.crumb ?? '').split(' › ')[0]!] ?? winIcon(w.kind)}</i>
                    {(w.crumb ?? WINDOWS[w.kind].label).split(' › ').pop()}
                  </button>
                  <button className="mdi-tray-x" title="Fermer cette fenêtre" onClick={() => close(w.id)}>
                    ✕
                  </button>
                </div>
              ))}
          </div>
        )}
      </main>
      <footer className="statusbar">
        <span title="Version du logiciel">ONIX 360 v{state.version}</span>
        <span title="Magasin">{state.station?.store.name}</span>
        {state.canChooseRegister ? (
          <button className="link reg" title="Choisir la caisse sur laquelle vous vendez" onClick={() => setChooseRegister(true)}>
            {state.register?.name ?? 'Sans caisse'} · changer
          </button>
        ) : (
          <span>{state.register?.name ?? 'Sans caisse'}</span>
        )}
        <span title="Utilisateur connecté">
          {user.name} ({ROLE_LABELS[user.role]})
        </span>
        <span className={sync.data?.connected && !sync.data.lastError ? 'ok' : ''}>{syncLabel}</span>
        {Boolean(fichesWaiting.data) && canWin('admin') && (
          <button className="warn soft" onClick={() => open('admin', 'fiches', 'Administration › Fiches boutique')} title="Fiches déposées dans le dossier partagé">
            {fichesWaiting.data === 1 ? '1 fiche à rapporter' : `${fichesWaiting.data} fiches à rapporter`}
          </button>
        )}
        {backupLate.data && canWin('admin') && (
          <button className="warn" onClick={() => open('admin', 'backups', 'Administration › Sauvegardes')} title="Aucune sauvegarde réussie depuis plus de 2 jours">
            Sauvegarde en retard
          </button>
        )}
        {Boolean(chargesLate.data?.count) && canWin('expenses') && (
          <button className="warn" onClick={() => open('expenses', 'schedule', 'Dépenses › Constats de charges')} title={`${fcfa(chargesLate.data!.amount)} de charges fixes non constatées`}>
            {chargesLate.data!.count === 1 ? '1 charge en retard' : `${chargesLate.data!.count} charges en retard`}
          </button>
        )}
        {state.license.warn &&
          (canWin('admin') ? (
            <button className={state.license.canSell ? 'warn soft' : 'warn'} onClick={() => open('admin', 'license', 'Administration › Licence')} title={state.license.message}>
              {licenseLabel(state.license)}
            </button>
          ) : (
            <span className={state.license.canSell ? 'warn-text' : 'neg'} title={state.license.message}>
              {licenseLabel(state.license)}
            </span>
          ))}
        {update.data?.status === 'ready' && (
          <button
            className="warn soft"
            title="La nouvelle version s'installe à la fermeture du logiciel"
            onClick={async () => {
              if (!(await askConfirm(`Fermer ONIX 360 et installer la version ${update.data!.available} ? Le logiciel se rouvre tout seul après l'installation.`))) return;
              call('update.install').catch(() => update.reload());
            }}
          >
            Mise à jour {update.data.available} prête
          </button>
        )}
        {Boolean(gaps.data?.length) && (
          <button className="warn" onClick={() => open('treasury', 'history', 'Trésorerie › Historique des journées de caisse')} title="Clôtures dont l'écart attend votre motif">
            {gaps.data!.length === 1 ? '1 écart à justifier' : `${gaps.data!.length} écarts à justifier`}
          </button>
        )}
        <button
          className="link"
          translate="no"
          title={lang === 'en' ? 'Afficher les écrans en français' : 'Show the screens in English'}
          onClick={() => {
            const next: Lang = lang === 'en' ? 'fr' : 'en';
            setLang(next);
            setLangState(next);
            savePref('lang', next);
          }}
        >
          {lang === 'en' ? 'Français' : 'English'}
        </button>
        <button className="link" onClick={() => call('auth.logout').then(refresh)}>
          Changer d'utilisateur
        </button>
        <button className="link" title="Note votre départ pour le pointage, puis vous déconnecte" onClick={() => void leave()}>
          Je pars
        </button>
        <Clock />
      </footer>
      {allMenus && (
        <div className="all-menus" onClick={() => setAllMenus(false)}>
          <div className="all-menus-head" onClick={(e) => e.stopPropagation()}>
            <h1>Tous les menus</h1>
            <button className="top-search" onClick={() => (setAllMenus(false), setHelp('palette'))}>
              🔍 Aller à un écran <kbd>Ctrl+K</kbd>
            </button>
            <button className="all-close" title="Fermer (Échap)" onClick={() => setAllMenus(false)}>
              ✕
            </button>
          </div>
          <div className="all-menus-grid">
            {visibleMenus.map(([name, items]) => (
              <section key={name} className="menu-card" style={{ '--c': MENU_COLORS[name] } as React.CSSProperties} onClick={(e) => e.stopPropagation()}>
                <h2>
                  <i aria-hidden>{MENU_ICONS[name]}</i>
                  {name}
                </h2>
                {visibleItems(items)
                  .filter((i) => !i.sep || i.head)
                  .map((i, n) =>
                    i.head ? (
                      <h3 key={`head-${n}`}>{i.label}</h3>
                    ) : (
                    <button
                      key={i.label}
                      disabled={i.soon}
                      onClick={() => void run(i, name)}
                      onContextMenu={(e) => {
                        if (!i.open) return;
                        e.preventDefault();
                        e.stopPropagation();
                        setCtxMenu({ x: e.clientX, y: e.clientY, pin: { label: i.label, open: i.open } });
                      }}
                    >
                      {i.label}
                      {i.badge === 'gaps' && Boolean(gaps.data?.length) && <small className="neg"> · {gaps.data!.length} écart(s)</small>}
                    </button>
                    ),
                  )}
              </section>
            ))}
          </div>
        </div>
      )}
      {ctxMenu && (
        <div className="ctx-menu" style={{ left: ctxMenu.x, top: ctxMenu.y }} onClick={(e) => e.stopPropagation()}>
          {ctxMenu.pin && (
            <button
              onClick={() => {
                pin(ctxMenu.pin!);
                setCtxMenu(null);
                setMenu(null);
              }}
            >
              📌 Épingler dans les onglets rapides
            </button>
          )}
          {ctxMenu.tab !== undefined && (
            <>
              {(
                [
                  ['◀ Déplacer à gauche', -1],
                  ['Déplacer à droite ▶', 1],
                ] as const
              ).map(([label, d]) => (
                <button
                  key={label}
                  disabled={ctxMenu.tab! + d < 0 || ctxMenu.tab! + d >= quickTabs.length}
                  onClick={() => {
                    const next = [...quickTabs];
                    const i = ctxMenu.tab!;
                    [next[i], next[i + d]] = [next[i + d]!, next[i]!];
                    saveTabs(next);
                    setCtxMenu(null);
                  }}
                >
                  {label}
                </button>
              ))}
              <button
                className="danger"
                onClick={() => {
                  saveTabs(quickTabs.filter((_, n) => n !== ctxMenu.tab));
                  setCtxMenu(null);
                }}
              >
                ✕ Retirer « {quickTabs[ctxMenu.tab]?.label} »
              </button>
              <hr />
              <button
                onClick={() => {
                  setCtxMenu(null);
                  setHelp('tabs');
                }}
              >
                Personnaliser les onglets…
              </button>
            </>
          )}
        </div>
      )}
      {chooseRegister && (
        <Modal title="Choisir ma caisse" onClose={() => setChooseRegister(false)}>
          <RegisterChooser
            current={state.register?.id ?? null}
            onChosen={() => {
              setChooseRegister(false);
              refresh();
            }}
          />
        </Modal>
      )}
      {help === 'page' && <HelpDialog kind={activeWin?.kind ?? null} tab={activeWin?.tab} rights={user.rights} onClose={() => setHelp(null)} onGuide={() => setHelp('guide')} />}
      {help === 'palette' && <CommandPalette entries={paletteEntries} onClose={() => setHelp(null)} />}
      {help === 'guide' && <GettingStarted role={user.role} canOpen={canWin} onOpen={([kind, tab]) => open(kind, tab)} onClose={() => setHelp(null)} />}
      {help === 'news' && <WhatsNew version={state.version} onClose={() => setHelp(null)} />}
      {help === 'rail' && (
        <RailEditor
          menus={visibleMenus.map(([name]) => name).filter((n) => !RAIL_FIXED.includes(n))}
          current={railMenus.map(([name]) => name)}
          label={(n) => `${MENU_ICONS[n] ?? ''} ${RAIL_LABELS[n] ?? n}`}
          onSave={(list) => {
            savePref('railMenus', list);
            setHelp(null);
          }}
          onClose={() => setHelp(null)}
        />
      )}
      {help === 'tabs' && (
        <QuickTabsEditor
          current={quickTabs}
          available={[...QUICK_BY_ROLE[user.role], ...QUICK, ...MENUS.flatMap(([, items]) => visibleItems(items).flatMap((i) => (i.open && !i.sep ? [{ label: i.label, open: i.open }] : [])))].filter(
            (t, n, all) => canWin(t.open[0]) && all.findIndex((x) => x.open[0] === t.open[0] && x.open[1] === t.open[1]) === n,
          )}
          onSave={saveTabs}
          onClose={() => setHelp(null)}
        />
      )}
      {help === 'theme' && (
        <Modal title="Thème de l'écran" onClose={() => setHelp(null)}>
          <p className="muted">Votre choix ne change que votre écran ; chaque utilisateur garde le sien.</p>
          <div className="theme-choices">
            {(Object.keys(THEMES) as Theme[]).map((t) => (
              <button key={t} className={(prefs.theme ?? 'light') === t ? 'primary' : ''} onClick={() => savePref('theme', t)}>
                {THEMES[t]}
              </button>
            ))}
          </div>
          <div className="actions">
            <button className="primary" onClick={() => setHelp(null)}>
              Fermer
            </button>
          </div>
        </Modal>
      )}
      {help === 'shortcuts' && (
        <Modal title="Raccourcis clavier" onClose={() => setHelp(null)}>
          {pageKeys.length > 0 && (
            <>
              <h3>Sur cette page</h3>
              <table className="list compact shortcut-list" data-lv-off>
                <tbody>
                  {pageKeys.map(([k, v]) => (
                    <tr key={k + v}>
                      <th>
                        <kbd>{k}</kbd>
                      </th>
                      <td>{v}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <h3>Partout</h3>
            </>
          )}
          <table className="list compact shortcut-list" data-lv-off>
            <tbody>
              {[
                ['Ctrl+K', 'Rechercher un écran par son nom'],
                ['Ctrl+/', 'Raccourcis de la page affichée'],
                ['Entrée', 'Valider le champ ou le formulaire'],
                ['Ctrl+Entrée', 'Valider la fenêtre ouverte (bouton principal)'],
                ['Échap', 'Fermer la fenêtre ouverte'],
                ['Ctrl+Z', 'Annuler la dernière action (pendant 10 secondes)'],
                ['F1', 'Aide sur la page (à la caisse : rechercher un produit)'],
                ['F2', 'Nouvelle vente ; à la caisse : valider et imprimer le ticket (fiche vide : réimprimer le dernier)'],
                ['F7', 'Valider et imprimer la facture listing (fiche vide : réimprimer la dernière en listing)'],
                ['F5', 'Actualiser la page (à la caisse : ouvrir le tiroir)'],
                ['Ctrl+Tab', 'Passer à la fenêtre suivante (Ctrl+Maj+Tab : la précédente)'],
                ['Ctrl+F4', 'Fermer la fenêtre de devant (sauf à la caisse)'],
                ['Ctrl+J', 'Nouveau (article, client, fournisseur…) ; dans un formulaire : enregistrer et en ouvrir un nouveau'],
                ['F4 ou Entrée sur saisie vide', 'Enregistrer la fiche sans imprimer'],
                ['Ctrl+E', 'Encaisser : Mobile Money, carte, paiements mixtes'],
                ['F3', 'Mettre la fiche en attente'],
                ['F10', 'Rappeler un ticket en attente'],
                ['F6', 'Remise sur la ligne sélectionnée'],
                ['+ / −', 'Quantité de la ligne sélectionnée'],
                ['Suppr', 'Enlever la ligne sélectionnée'],
                ['3*code', 'Ajouter 3 unités du code scanné'],
              ].map(([k, v]) => (
                <tr key={k}>
                  <th>{k}</th>
                  <td>{v}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Modal>
      )}
      <KeyHints />
      <ListTools prefs={(prefs.lists as ListPrefs | undefined) ?? {}} onSave={(p) => savePref('lists', p)} />
      {dossiers && <DossierPicker onClose={() => setDossiers(false)} />}
      {kiosk && <Kiosk overlay onExit={() => setKiosk(false)} />}
      {finding && (
        <OpenInvoice
          onClose={() => setFinding(false)}
          onFound={(sale) => {
            setFinding(false);
            setFound(sale);
          }}
        />
      )}
      {found && <SaleDetail sale={found} onClose={() => setFound(null)} />}
      {help === 'about' && (
        <Modal title="À propos" onClose={() => setHelp(null)}>
          <p>
            <span style={{ float: 'left', marginRight: 12 }}>
              <Mascot mood="bonjour" size={64} />
            </span>
            <strong>ONIX 360</strong> v{state.version}
            <br />
            Gestion commerciale pour superettes et boutiques au Cameroun : caisse, stock, multi-magasins.
            <br />© FEDONG
          </p>
        </Modal>
      )}
    </div>
    </StoreSettingsProvider>
    </RightsProvider>
  );
}

/** Ouvrir une facture : par son numéro, sur n'importe quelle caisse du magasin. */
function OpenInvoice({ onClose, onFound }: { onClose: () => void; onFound: (sale: Result<'pos.sale'>) => void }) {
  const toast = useToast();
  const [number, setNumber] = useState('');
  return (
    <Modal title="Ouvrir une facture" onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            const sale = await call('pos.findSale', number);
            if (sale) onFound(sale);
            else toast.error(`Aucun ticket ni facture n° ${number.trim().toUpperCase()}`);
          } catch (err) {
            toast.error(err);
          }
        }}
      >
        <Field label="N° du ticket ou de la facture" hint="Tel qu'imprimé sur le ticket, par exemple DLA1-1-000123">
          <input autoFocus value={number} onChange={(e) => setNumber(e.target.value)} required />
        </Field>
        <div className="actions">
          <button type="button" onClick={onClose}>
            Annuler
          </button>
          <button type="submit" className="primary">
            Ouvrir
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** Heure en haut à droite, mise à jour chaque minute. */
function Clock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 15000);
    return () => clearInterval(t);
  }, []);
  return <span className="top-clock">{now.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}</span>;
}

/**
 * « Ma journée » : ce que le vendeur ou le caissier a fait aujourd'hui, son
 * objectif et sa commission du mois. Il ne voit que ses propres chiffres.
 */
function MyDay() {
  const day = useLoad(() => call('me.day'), []);
  useEffect(() => {
    const t = setInterval(day.reload, 60_000);
    return () => clearInterval(t);
  }, []);
  const d = day.data;
  if (!d) return null;
  const bar = (label: string, done: number, target: number, rate: number | null) =>
    target > 0 && (
      <div className="myday-goal">
        <span>{label}</span>
        <span className="myday-bar">
          <i style={{ width: `${Math.min(100, rate ?? 0)}%` }} className={(rate ?? 0) >= 100 ? 'ok' : ''} />
        </span>
        <small>
          {fcfa(done)} / {fcfa(target)} ({String(rate ?? 0).replace('.', ',')} %)
        </small>
      </div>
    );
  return (
    <div className="myday">
      <h2>Ma journée</h2>
      <div className="myday-figures">
        <div>
          <b>{fcfa(d.net)}</b>
          <small>ventes{d.returns ? ` (retours ${fcfa(-d.returns)})` : ''}</small>
        </div>
        <div>
          <b>{d.tickets}</b>
          <small>tickets</small>
        </div>
        <div>
          <b>{fcfa(d.average)}</b>
          <small>panier moyen</small>
        </div>
        {d.target && (
          <div>
            <b>{fcfa(d.target.commission)}</b>
            <small>commission du mois</small>
          </div>
        )}
        {d.open_orders > 0 && (
          <div>
            <b>{d.open_orders}</b>
            <small>commande(s) client en cours</small>
          </div>
        )}
      </div>
      {d.target && bar('Objectif du jour', d.target.day_sales, d.target.day_target, d.target.day_rate)}
      {d.target && bar('Objectif du mois', d.target.month_sales, d.target.month_target, d.target.month_rate)}
    </div>
  );
}
