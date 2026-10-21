import { useEffect, useRef, useState } from 'react';
import { DEFAULT_STORE_SETTINGS, type Permission } from '@superette/core';
import { type Result, call } from './api';
import logo from './assets/logo.png';
import { type QuickTab, type WinKind } from './nav';
import { applyBrand } from './theme';
import { Accounting, type AccountingTab } from './screens/Accounting';
import { Deliveries } from './screens/Deliveries';
import { Orders } from './screens/Orders';
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
import { RealSales, type RealSalesTab } from './screens/RealSales';
import { FiscalPrep, type FiscalPrepTab } from './screens/FiscalPrep';
import { Purchases, type PurchasesTab } from './screens/Purchases';
import { EDIT_SALE_EVENT, SaleDetail, Sales, type SalesTab } from './screens/Sales';
import { Setup } from './screens/Setup';
import { DossierPicker, FicheBanner, saveFicheCopy } from './screens/Dossiers';
import { Staff, type StaffTab } from './screens/Staff';
import { Stock, type StockTab } from './screens/Stock';
import { Suppliers, type SuppliersTab } from './screens/Suppliers';
import { Treasury, type TreasuryTab } from './screens/Treasury';
import { Containers, type ContainersTab } from './screens/Containers';
import { AgentPoint, type AgentTab } from './screens/AgentPoint';
import { CashierControl } from './screens/CashierControl';
import { CommandPalette, GettingStarted, HelpDialog, type PaletteEntry, QuickTabsEditor, RailEditor, WhatsNew } from './screens/Guide';
import { ROLE_TILES } from './guide';
import { AskHost, askConfirm, Field, Modal, RefreshCtx, RightsProvider, StoreSettingsProvider, ToastProvider, fcfa, useLoad, useToast } from './ui';
import { hasVat, setVatOn } from './tax';
import { ctrlJ } from './newShortcut';
import { type Area, type Geo, MdiWindow, defaultGeo } from './mdi';
import { type Lang, currentLang, setLang, storedLang } from './i18n';

type AppState = Result<'app.state'>;
type User = NonNullable<AppState['user']>;
type Role = User['role'];

interface Win {
  kind: WinKind;
  tab?: string;
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
  sales: { label: 'Mes factures', perm: ['sales', 'cash_z', 'cash_operations', 'sales_alerts'] },
  articles: { label: 'Produits', perm: ['articles', 'article_create'] },
  stock: {
    label: 'Stock',
    perm: ['stock', 'stock_moves', 'stock_monitoring', 'stock_receive', 'stock_loss', 'stock_request', 'stock_adjust', 'stock_decide', 'transfer_view', 'transfer_create', 'transfer_direct', 'inventory', 'inventory_count', 'clearance', 'cycle_count'],
  },
  purchases: { label: 'Achats', perm: ['purchases', 'purchase_orders', 'reorder', 'purchase_invoices', 'supplier_pay', 'purchase_due', 'supplier_returns', 'group_orders'] },
  suppliers: { label: 'Fournisseurs', perm: ['suppliers', 'supplier_statement'] },
  customers: { label: 'Clients', perm: ['customers', 'receivables', 'rebates', 'customer_statement', 'summary_invoices'] },
  expenses: { label: 'Dépenses', perm: ['expenses', 'expense_record', 'expense_categories', 'charge_plans'] },
  quotes: { label: 'Devis et proformas', perm: ['quotes', 'quote_save'] },
  deliveries: { label: 'Livraisons du jour', perm: ['deliveries'] },
  orders: { label: 'Commandes clients', perm: ['customer_orders'] },
  promotions: { label: 'Promotions', perm: ['promotions', 'promotion_save', 'promotion_stop'] },
  labels: { label: 'Étiquettes', perm: ['labels'] },
  reports: { label: 'Rapports de ventes', perm: ['reports'] },
  accounting: { label: 'Comptabilité', perm: ['accounting', 'vat_return', 'tax', 'tax_settings', 'bank_reconciliation', 'statements', 'journal_entry', 'journal_edit', 'chart_accounts', 'fiscal_years', 'cash_forecast', 'budgets', 'analytics', 'cheque_deposits', 'cheque_rejections'] },
  treasury: { label: 'Opérations de trésorerie', perm: ['treasury', 'cash_history', 'central_cash'] },
  dashboard: { label: 'Tableau de bord', perm: ['dashboard'] },
  admin: { label: 'Administration', perm: ['admin'] },
  production: { label: 'Fabrication', perm: ['production', 'production_recipes', 'production_create', 'production_validate'] },
  staff: { label: 'Collaborateurs', perm: ['staff', 'staff_edit', 'staff_salaries', 'staff_targets', 'staff_attendance', 'staff_leaves'] },
  containers: { label: 'Emballages consignés', perm: ['containers', 'containers_counter'] },
  agent: { label: 'Point Mobile Money', perm: ['agent_point', 'agent_accounts'] },
  control: { label: 'Contrôle des caissiers', perm: ['cashier_control'] },
  realSales: { label: 'Ventes réelles', perm: ['real_sales'] },
  fiscalPrep: { label: 'Préparation fiscale', perm: ['fiscal_prep'] },
};

interface MenuItem {
  label: string;
  open?: [WinKind, string?];
  action?: 'logout' | 'leave' | 'training' | 'dossiers' | 'sync' | 'shortcuts' | 'about' | 'quit' | 'openInvoice' | 'help' | 'palette' | 'guide' | 'news' | 'tabs' | 'rail';
  /** Trait de séparation entre deux groupes. */
  sep?: boolean;
  /** Module pas encore développé : affiché grisé. */
  soon?: boolean;
  /** Droit nécessaire en plus de celui de la fenêtre (Administration › Droits). */
  perm?: Permission | Permission[];
  /** Réservé au rôle Administrateur. */
  adminOnly?: boolean;
  /** Compteur affiché à côté du libellé. */
  badge?: 'gaps';
}

const SEP: MenuItem = { label: '', sep: true };

/** Icônes et couleurs des menus : barre verte de gauche et écran « Tous les menus ». */
const MENU_ICONS: Record<string, string> = {
  Fichier: '📁',
  Facturation: '🧾',
  Vente: '📈',
  Achats: '🛒',
  Fabrication: '🏭',
  Trésorerie: '💰',
  Produit: '📦',
  Fournisseur: '🚚',
  Client: '👥',
  Charge: '💸',
  Transfert: '🔁',
  Magasinier: '🗄️',
  Comptabilité: '📒',
  Fiscal: '🏛️',
  Administration: '⚙️',
  Aide: '❔',
};

/** Icône d'un écran : celle du premier menu qui l'ouvre (Magasinier pour le stock). */
const winIcon = (kind: WinKind) =>
  kind === 'stock' ? MENU_ICONS['Magasinier']! : (MENU_ICONS[MENUS.find(([, items]) => items.some((it) => it.open?.[0] === kind))?.[0] ?? ''] ?? '▣');
const MENU_COLORS: Record<string, string> = {
  Fichier: '#64748b',
  Facturation: 'var(--brand)',
  Vente: 'var(--brand2)',
  Achats: '#2563eb',
  Fabrication: '#7c3aed',
  Trésorerie: '#e0a800',
  Produit: '#0891b2',
  Fournisseur: '#0d9488',
  Client: '#db2777',
  Charge: '#dc2626',
  Transfert: '#0284c7',
  Magasinier: '#65a30d',
  Comptabilité: '#4f46e5',
  Fiscal: '#e11d48',
  Administration: '#64748b',
  Aide: '#94a3b8',
};
/** Réglages et Aide restent en bas de la barre verte ; les autres menus s'y affichent au choix de chacun. */
const RAIL_FIXED = ['Administration', 'Aide'];
const RAIL_LABELS: Record<string, string> = {
  Facturation: 'Caisse',
  Vente: 'Ventes',
  Magasinier: 'Stock',
  Client: 'Clients',
  Fournisseur: 'Fournisseurs',
  Charge: 'Charges',
  Transfert: 'Transferts',
  Comptabilité: 'Compta',
  Administration: 'Réglages',
};

const MENUS: [string, MenuItem[]][] = [
  [
    'Fichier',
    [
      { label: 'Synchroniser maintenant', action: 'sync' },
      { label: 'Personnaliser les onglets rapides', action: 'tabs' },
      { label: 'Personnaliser la barre latérale', action: 'rail' },
      { label: "Changer d'utilisateur", action: 'logout' },
      { label: 'Je pars (fin de journée)', action: 'leave' },
      { label: 'Mode formation (caisse d’entraînement)…', action: 'training', perm: 'training' },
      { label: 'Ouvrir une boutique…', action: 'dossiers', adminOnly: true },
      { label: 'Quitter', action: 'quit' },
    ],
  ],
  [
    'Facturation',
    [
      { label: 'Vente au comptant 1', open: ['cash1'] },
      { label: 'Vente au comptant 2', open: ['cash2'] },
      { label: 'Vente à crédit', open: ['credit'] },
      { label: 'Devis et factures proforma', open: ['quotes'] },
      { label: 'Commandes clients (téléphone, WhatsApp)', open: ['orders'], perm: 'customer_orders' },
      { label: 'Livraisons du jour', open: ['deliveries'], perm: 'deliveries' },
      { label: 'Point Mobile Money (dépôts, retraits, factures)', open: ['agent', 'counter'], perm: 'agent_point' },
      { label: 'Emballages consignés', open: ['containers', 'situation'], perm: ['containers', 'containers_counter'] },
      { label: 'Mes factures', open: ['sales', 'tickets'] },
      { label: 'Registre (clôtures Z)', open: ['sales', 'z'] },
    ],
  ],
  [
    'Vente',
    [
      { label: 'Nouvelle fiche de facturation', open: ['cash1'] },
      { label: 'Ouvrir une facture', action: 'openInvoice', perm: 'sales' },
      { label: 'Facture à crédit (client en compte)', open: ['credit'] },
      { label: 'Mes dernières factures', open: ['sales', 'tickets'] },
      { label: 'Registre des ventes', open: ['sales', 'register'] },
      { label: 'Ventes réelles (opérations, paiements, annulations, remboursements)', open: ['realSales', 'operations'], perm: 'real_sales' },
      SEP,
      { label: "Retours d'articles des clients", open: ['sales', 'returns'] },
      { label: 'Tickets et factures annulés', open: ['sales', 'cancelled'] },
      SEP,
      { label: 'Devis et factures proforma', open: ['quotes'] },
      { label: 'Commandes clients (téléphone, WhatsApp)', open: ['orders'], perm: 'customer_orders' },
      { label: 'Livraisons du jour', open: ['deliveries'], perm: 'deliveries' },
      { label: 'Factures cumulées par client', open: ['reports', 'customer'], perm: 'reports' },
      { label: 'Alertes sur les ventes', open: ['sales', 'alerts'], perm: 'sales_alerts' },
      { label: 'Contrôle des caissiers', open: ['control'], perm: 'cashier_control' },
      SEP,
      { label: 'Promotions', open: ['promotions'], perm: 'promotions' },
      { label: 'Situation des ventes', open: ['reports', 'department'], perm: 'reports' },
      { label: 'Évolution périodique', open: ['reports', 'evolution'], perm: 'reports' },
      { label: 'Tableau de bord', open: ['dashboard', 'day'] },
      { label: "Points d'attention", open: ['dashboard', 'attention'] },
    ],
  ],
  [
    'Achats',
    [
      { label: 'Saisir un nouvel achat (bon de commande)', open: ['purchases', 'new-order'], perm: 'purchase_orders' },
      { label: 'Saisir une facture à partir des BL', open: ['purchases', 'invoices'], perm: 'purchase_invoices' },
      { label: 'Saisir une facture directe (sans bon de commande)', open: ['purchases', 'direct'], perm: 'purchase_invoices' },
      { label: 'Registre des achats', open: ['purchases', 'invoices'], perm: 'purchase_invoices' },
      { label: 'Registre des achats par produits', open: ['purchases', 'byproduct'] },
      SEP,
      { label: 'Registre des réceptions', open: ['purchases', 'receptions'] },
      { label: 'Saisir une nouvelle réception (sans commande)', open: ['stock', 'receive'], perm: 'stock_receive' },
      SEP,
      { label: 'Bons de commande', open: ['purchases', 'orders'], perm: ['purchases', 'purchase_orders', 'order_receive'] },
      { label: 'Proposition de commande', open: ['purchases', 'reorder'], perm: 'reorder' },
      { label: 'Commandes groupées (plusieurs magasins)', open: ['purchases', 'group'], perm: 'group_orders' },
      { label: 'Promotions', open: ['promotions'], perm: 'promotions' },
      SEP,
      { label: 'Marchandises non encore reçues', open: ['purchases', 'pending'] },
      { label: 'Échéancier fournisseurs', open: ['purchases', 'due'], perm: 'purchase_due' },
      { label: 'Retours fournisseur et avoirs attendus', open: ['purchases', 'returns'], perm: 'supplier_returns' },
    ],
  ],
  [
    'Fabrication',
    [
      { label: 'Nouvel ordre de fabrication', open: ['production', 'new'], perm: 'production_create' },
      { label: 'Ordres de fabrication', open: ['production', 'orders'], perm: ['production', 'production_create', 'production_validate'] },
      { label: 'Recettes (produits fabriqués)', open: ['production', 'recipes'], perm: ['production', 'production_recipes'] },
    ],
  ],
  [
    'Trésorerie',
    [
      { label: 'Opérations de trésorerie (ouverture, clôture)', open: ['treasury', 'day'], perm: 'treasury' },
      { label: 'Historique des journées de caisse', open: ['treasury', 'history'], perm: 'cash_history', badge: 'gaps' },
      { label: 'Caisse centrale', open: ['treasury', 'central'], perm: 'central_cash' },
      { label: 'Caisses électroniques (MoMo, OM) et centrale', open: ['treasury', 'emoney'], perm: 'central_cash' },
      SEP,
      { label: 'Journaux de trésorerie', open: ['accounting', 'journals'], perm: 'accounting' },
      { label: 'Positions (caisses, banques, Mobile Money)', open: ['accounting', 'treasury'] },
      { label: 'Extrait de compte (grand livre)', open: ['accounting', 'ledger'] },
      { label: 'Listing des opérations de caisse', open: ['sales', 'cashops'], perm: 'cash_operations' },
      SEP,
      { label: 'Règlements clients reçus', open: ['customers', 'payments'] },
      { label: 'Rechercher dans les caisses', open: ['sales', 'find'], perm: 'cash_operations' },
      SEP,
      { label: 'Registre de caisse (Z)', open: ['sales', 'z'], perm: 'cash_z' },
      { label: 'Rapprochement bancaire', open: ['accounting', 'bank'], perm: 'bank_reconciliation' },
      { label: 'Remises de chèques en banque', open: ['accounting', 'cheques'], perm: 'cheque_deposits' },
      { label: 'Chèques revenus impayés', open: ['accounting', 'unpaid'], perm: 'cheque_rejections' },
      { label: 'Trésorerie prévisionnelle', open: ['accounting', 'forecast'], perm: 'cash_forecast' },
      SEP,
      { label: 'Point Mobile Money', open: ['agent', 'counter'], perm: 'agent_point' },
      { label: 'Point Mobile Money : comptes et bilan', open: ['agent', 'accounts'], perm: 'agent_accounts' },
      { label: 'Contrôle des caissiers', open: ['control'], perm: 'cashier_control' },
    ],
  ],
  [
    'Produit',
    [
      { label: 'Liste des produits', open: ['articles', 'list'], perm: 'articles' },
      { label: 'Ajouter / paramétrer une marchandise', open: ['articles', 'new'], perm: 'article_create' },
      { label: 'Recherche', open: ['articles', 'search'], perm: 'articles' },
      SEP,
      { label: 'Péremptions', open: ['stock', 'expiry'], perm: 'stock' },
      { label: 'Étiquettes et codes-barres', open: ['labels'] },
      { label: 'Promotions', open: ['promotions'], perm: 'promotions' },
      SEP,
      { label: 'Stock multi-magasin', open: ['stock', 'multi'], perm: 'stock' },
      { label: 'Articles par dépôt', open: ['stock', 'warehouses'], perm: 'stock' },
      { label: 'Rayonnage des articles', open: ['articles', 'shelving'] },
      SEP,
      { label: 'Stocks', open: ['stock', 'state'], perm: 'stock' },
      { label: 'Historique des ajustements de stock', open: ['stock', 'adjustments'], perm: 'stock_moves' },
      { label: 'Mouvements de stock', open: ['stock', 'moves'], perm: 'stock_moves' },
      { label: "Monitoring de l'évolution du stock", open: ['stock', 'monitoring'], perm: ['stock_monitoring', 'stock_request', 'stock_decide'] },
      SEP,
      { label: 'Inventaires', open: ['stock', 'inventory'], perm: ['inventory', 'inventory_count', 'inventory_close', 'inventory_print'] },
      { label: 'Déstockages (pertes et casse)', open: ['stock', 'loss'], perm: 'stock_loss' },
      { label: 'Inventaire tournant de la semaine', open: ['stock', 'cycle'], perm: 'cycle_count' },
      { label: 'Déstockage avant péremption', open: ['stock', 'clearance'], perm: 'clearance' },
      { label: 'Démarque (pertes par rayon)', open: ['stock', 'losses'], perm: 'clearance' },
      { label: 'Emballages consignés', open: ['containers', 'situation'], perm: 'containers' },
      SEP,
      { label: 'Stocks critiques', open: ['stock', 'critical'], perm: 'stock' },
      { label: 'Proposition de commande', open: ['purchases', 'reorder'], perm: 'reorder' },
    ],
  ],
  [
    'Fournisseur',
    [
      { label: 'Liste des fournisseurs', open: ['suppliers', 'list'], perm: 'suppliers' },
      SEP,
      { label: 'Consulter un extrait de compte', open: ['suppliers', 'statement'], perm: 'supplier_statement' },
      { label: 'Situation des fournisseurs', open: ['suppliers', 'situation'], perm: 'supplier_statement' },
      { label: 'Les comptes dont le solde a bougé récemment', open: ['suppliers', 'recent'], perm: 'supplier_statement' },
      SEP,
      { label: 'Factures et avoirs fournisseurs', open: ['purchases', 'invoices'], perm: 'purchase_invoices' },
      { label: 'Échéancier fournisseurs', open: ['purchases', 'due'], perm: 'purchase_due' },
    ],
  ],
  [
    'Client',
    [
      { label: 'Liste', open: ['customers', 'list'], perm: 'customers' },
      { label: 'Contrôle des échéances', open: ['customers', 'receivables'], perm: 'receivables' },
      { label: "Contrôle des plafonds d'autorisation", open: ['customers', 'limits'], perm: 'receivables' },
      SEP,
      { label: 'Consulter un extrait de compte', open: ['customers', 'statement'], perm: ['customer_statement', 'receivables'] },
      { label: 'Situation des clients', open: ['customers', 'receivables'], perm: 'receivables' },
      { label: 'Les comptes dont le solde a bougé récemment', open: ['customers', 'recent'] },
      SEP,
      { label: 'Règlements reçus', open: ['customers', 'payments'] },
      { label: 'Retours et avoirs clients', open: ['sales', 'returns'] },
      { label: 'Factures récapitulatives (fin de mois)', open: ['customers', 'summary'], perm: 'summary_invoices' },
      SEP,
      { label: 'Ristournes : état des ristournes', open: ['customers', 'rebates-state'], perm: 'rebates' },
      { label: 'Ristournes : reports à nouveau', open: ['customers', 'rebates-carry'], perm: 'rebates' },
      { label: 'Ristournes : réglage de base', open: ['customers', 'rebates-base'], perm: 'rebates' },
      { label: 'Ristournes : réglage des clients spécifiques', open: ['customers', 'rebates-clients'], perm: 'rebates' },
      { label: 'Ristournes : régularisations et bons', open: ['customers', 'rebates-entries'], perm: 'rebates' },
    ],
  ],
  [
    'Charge',
    [
      { label: 'Types de charge', open: ['expenses', 'categories'], perm: 'expense_categories' },
      { label: 'Définition des charges fixes', open: ['expenses', 'plans'], perm: 'charge_plans' },
      { label: 'Dépenses (nouvelle dépense)', open: ['expenses', 'new'], perm: 'expense_record' },
      SEP,
      { label: 'Historique des dépenses', open: ['expenses', 'list'], perm: 'expenses' },
      { label: 'Dépenses par catégorie', open: ['expenses', 'summary'], perm: 'expenses' },
      SEP,
      { label: 'Constats de charges', open: ['expenses', 'schedule'], perm: 'charge_plans' },
      SEP,
      { label: 'Collaborateurs (fiches, comptes tiers)', open: ['staff', 'list'] },
      { label: 'Salaires du mois', open: ['staff', 'salaries'], perm: 'staff_salaries' },
      { label: 'Objectifs et commissions des vendeurs', open: ['staff', 'targets'], perm: 'staff_targets' },
      { label: 'Pointage du personnel', open: ['staff', 'attendance'], perm: 'staff_attendance' },
      { label: 'Congés du personnel', open: ['staff', 'leaves'], perm: 'staff_leaves' },
      { label: 'Planning de la semaine', open: ['staff', 'planning'], perm: 'staff_leaves' },
      { label: 'Extrait de compte d’un collaborateur', open: ['staff', 'statement'] },
    ],
  ],
  [
    'Transfert',
    [
      { label: 'Nouveau transfert', open: ['stock', 'transferNew'], perm: 'transfer_create' },
      { label: 'Liste des transferts', open: ['stock', 'transfer'], perm: ['transfer_view', 'transfer_create', 'transfer_ship', 'transfer_receive', 'transfer_cancel', 'transfer_direct'] },
    ],
  ],
  [
    'Magasinier',
    [
      { label: 'État du stock', open: ['stock', 'state'], perm: 'stock' },
      { label: 'Mouvements de stock', open: ['stock', 'moves'], perm: 'stock_moves' },
      { label: 'Monitoring du stock', open: ['stock', 'monitoring'], perm: ['stock_monitoring', 'stock_request', 'stock_decide'] },
      { label: 'Pertes et casse', open: ['stock', 'loss'], perm: 'stock_loss' },
      { label: 'Inventaires', open: ['stock', 'inventory'], perm: ['inventory', 'inventory_count', 'inventory_close', 'inventory_print'] },
      { label: 'Péremptions', open: ['stock', 'expiry'], perm: 'stock' },
      { label: 'Déstockage avant péremption', open: ['stock', 'clearance'], perm: 'clearance' },
      { label: 'Inventaire tournant de la semaine', open: ['stock', 'cycle'], perm: 'cycle_count' },
      { label: 'Emballages consignés', open: ['containers', 'situation'], perm: 'containers' },
      { label: 'Étiquettes et codes-barres', open: ['labels'] },
    ],
  ],
  [
    'Comptabilité',
    [
      { label: 'Journaux', open: ['accounting', 'journals'], perm: 'accounting' },
      { label: 'Grand livre', open: ['accounting', 'ledger'], perm: 'accounting' },
      { label: 'Balance générale', open: ['accounting', 'balance'], perm: 'accounting' },
      { label: 'Bilan et compte de résultat', open: ['accounting', 'statements'], perm: 'statements' },
      { label: 'Plan comptable', open: ['accounting', 'accounts'], perm: ['accounting', 'chart_accounts'] },
      { label: 'Exercices comptables', open: ['accounting', 'fiscal'], perm: ['accounting', 'fiscal_years'] },
      { label: 'Immobilisations et amortissements', open: ['accounting', 'assets'], perm: 'fixed_assets' },
      SEP,
      { label: 'Trésorerie prévisionnelle', open: ['accounting', 'forecast'], perm: 'cash_forecast' },
      { label: 'Budgets', open: ['accounting', 'budgets'], perm: 'budgets' },
      { label: 'Analytique par rayon et par magasin', open: ['accounting', 'analytics'], perm: 'analytics' },
      { label: 'Remises de chèques en banque', open: ['accounting', 'cheques'], perm: 'cheque_deposits' },
      { label: 'Chèques revenus impayés', open: ['accounting', 'unpaid'], perm: 'cheque_rejections' },
      SEP,
      { label: 'Export des ventes (CSV)', open: ['sales', 'export'], perm: 'accounting_export' },
    ],
  ],
  [
    'Fiscal',
    [
      { label: 'Déclaration de TVA', open: ['accounting', 'vat'], perm: 'vat_return' },
      { label: 'États financiers et DSF', open: ['accounting', 'statements'], perm: 'statements' },
      { label: 'Notes déclaratives de la DSF', open: ['accounting', 'dsf'], perm: ['tax', 'tax_settings'] },
      { label: 'Impôt sur le résultat', open: ['accounting', 'tax'], perm: ['tax', 'tax_settings'] },
      SEP,
      { label: 'Préparation fiscale (état tiré des ventes et de la comptabilité)', open: ['fiscalPrep', 'state'], perm: 'fiscal_prep' },
      { label: 'États fiscaux générés', open: ['fiscalPrep', 'statements'], perm: 'fiscal_prep' },
      { label: 'Ventes réelles (source)', open: ['realSales', 'operations'], perm: 'real_sales' },
    ],
  ],
  [
    'Administration',
    [
      { label: 'Magasins', open: ['admin', 'stores'], adminOnly: true },
      { label: 'Caisses', open: ['admin', 'registers'] },
      { label: 'Dépôts', open: ['admin', 'warehouses'] },
      { label: 'Utilisateurs', open: ['admin', 'users'] },
      { label: 'Droits par rôle', open: ['admin', 'rights'] },
      { label: 'Privilèges par utilisateur', open: ['admin', 'privileges'] },
      { label: 'Paramètres', open: ['admin', 'settings'] },
      { label: 'Couleurs et badges', open: ['admin', 'brand'] },
      { label: 'Exercices comptables', open: ['admin', 'fiscal'], perm: ['accounting', 'fiscal_years'] },
      { label: "Modèles d'impression", open: ['admin', 'templates'] },
      { label: 'Sauvegardes', open: ['admin', 'backups'], perm: 'backups' },
      { label: 'Fiches boutique', open: ['admin', 'fiches'] },
      { label: 'Reprise des données (clients, fournisseurs, stock)', open: ['admin', 'takeover'], perm: 'data_takeover' },
      { label: 'Réparation', open: ['admin', 'repair'], adminOnly: true },
      { label: 'Serveur central', open: ['admin', 'server'] },
      { label: 'Licence', open: ['admin', 'license'] },
      { label: 'Résumé du jour', open: ['admin', 'digest'], perm: 'dashboard' },
      { label: "Journal d'audit", open: ['admin', 'audit'], perm: 'audit' },
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
      { label: 'Raccourcis clavier', action: 'shortcuts' },
      { label: 'À propos', action: 'about' },
    ],
  ],
];

/** Onglets rapides en haut de l'écran : ceux d'origine, que chacun peut personnaliser. */
const QUICK: QuickTab[] = [
  { label: 'Caisse 1', open: ['cash1'] },
  { label: 'Caisse 2', open: ['cash2'] },
  { label: 'Crédit', open: ['credit'], credit: true },
  { label: 'Mes factures', open: ['sales', 'tickets'] },
  { label: 'Registre', open: ['sales', 'z'] },
  { label: 'Produits', open: ['articles'] },
  { label: 'Stock', open: ['stock', 'state'] },
  { label: 'Stock MM', open: ['stock', 'multi'] },
  { label: 'Transfert', open: ['stock', 'transfer'] },
  { label: 'Devis', open: ['quotes'] },
  { label: 'Dépenses', open: ['expenses', 'list'] },
  { label: 'Achats', open: ['purchases', 'orders'] },
  { label: 'Trésorerie', open: ['treasury', 'day'] },
  { label: 'TABORD', open: ['dashboard', 'day'] },
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
        <Login station={state.station} fiche={state.dossier.fiche} onDone={refresh} />
      ) : (
        <Workspace key={state.user.id} state={state} user={state.user} refresh={refresh} />
      )}
      <AskHost />
    </ToastProvider>
  );
}

/** Texte court de la barre d'état ; le message complet est dans l'infobulle et Administration › Licence. */
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
  // Le caissier et le vendeur arrivent sur leur fiche de facturation ; les autres sur la page d'accueil.
  const startOnPos = ['cashier', 'seller'].includes(user.role);
  const [wins, setWins] = useState<Win[]>(() => (startOnPos ? [{ kind: first, nonce: 0, crumb: 'Facturation › Vente au comptant 1' }] : []));
  // null : la page d'accueil.
  const [active, setActive] = useState<WinKind | null>(startOnPos ? first : null);
  /** Ordre des fenêtres, de la plus en arrière à celle de devant. */
  const [stack, setStack] = useState<WinKind[]>(() => (startOnPos ? [first] : []));
  const [area, setArea] = useState<Area>({ w: 0, h: 0 });
  const areaRef = useRef<HTMLElement>(null);
  const [menu, setMenu] = useState<string | null>(null);
  /** Écran « Tous les menus » : chaque menu en tuile, avec tous ses écrans. */
  const [allMenus, setAllMenus] = useState(false);
  const [chooseRegister, setChooseRegister] = useState(false);
  const [help, setHelp] = useState<'shortcuts' | 'about' | 'page' | 'palette' | 'guide' | 'news' | 'tabs' | 'rail' | null>(null);
  /** Place du menu ouvert depuis la barre verte (elle défile : le menu s'affiche par-dessus). */
  const [menuAt, setMenuAt] = useState<{ left: number; top?: number; bottom?: number } | null>(null);
  const [finding, setFinding] = useState(false);
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
  const quickTabs = ((prefs.quickTabs as QuickTab[] | undefined) ?? QUICK)
    // 0.36.0 : « Stock MM » ouvre le stock multi-magasin (il ouvrait les mouvements).
    .map((q) => (q.label === 'Stock MM' && q.open[0] === 'stock' && q.open[1] === 'moves' ? { ...q, open: ['stock', 'multi'] as QuickTab['open'] } : q))
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
    document.title = `FEDONIX 360 v${state.version} : ${state.station?.store.name ?? ''}, ${state.register?.name ?? 'sans caisse'}, utilisateur ${user.name}`;
  }, [state, user]);
  useEffect(() => {
    if (!menu && !ctxMenu) return;
    const close = () => {
      setMenu(null);
      setCtxMenu(null);
    };
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [menu, ctxMenu]);
  // Ctrl+K cherche un écran ; F1 ouvre l'aide de la page (sauf à la caisse, où F1 cherche un produit).
  const onPos = active === 'cash1' || active === 'cash2' || active === 'credit';
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setAllMenus(false);
      if (e.ctrlKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setAllMenus(false);
        setHelp('palette');
      } else if (e.key === 'F1' && !onPos) {
        e.preventDefault();
        setHelp('page');
      } else if (e.ctrlKey && e.key.toLowerCase() === 'j' && !onPos) {
        // Ctrl+J : nouveau ; dans un formulaire, enregistre et en rouvre un vide.
        e.preventDefault();
        ctrlJ();
      } else if (e.key === 'F5' && !onPos && !e.ctrlKey) {
        // F5 actualise la fenêtre de devant (à la caisse, F5 ouvre le tiroir).
        e.preventDefault();
        if (active) refreshWin(active);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onPos, active]);

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
  const geos = (prefs.winGeo as Partial<Record<WinKind, Geo>> | undefined) ?? {};
  const isPosKind = (kind: WinKind) => kind === 'cash1' || kind === 'cash2' || kind === 'credit';
  // Place donnée à l'ouverture (en cascade) tant que la fenêtre n'a pas été déplacée.
  const [placed, setPlaced] = useState<Partial<Record<WinKind, Geo>>>({});
  const geoOf = (kind: WinKind): Geo => geos[kind] ?? placed[kind] ?? defaultGeo(area, 0, isPosKind(kind));
  const saveGeo = (kind: WinKind, g: Geo) => savePref('winGeo', { ...geos, [kind]: g });
  /** Met une fenêtre devant les autres. */
  const focus = (kind: WinKind | null) => {
    setActive(kind);
    if (kind) setStack((st) => (st[st.length - 1] === kind ? st : [...st.filter((k) => k !== kind), kind]));
  };

  const open = (kind: WinKind, tab?: string, crumb?: string) => {
    if (!canWin(kind)) return toast.error("Vous n'avez pas les droits pour ouvrir cette fenêtre");
    if (!wins.some((w) => w.kind === kind)) setPlaced((p) => ({ ...p, [kind]: defaultGeo(area, wins.length, isPosKind(kind)) }));
    setWins((ws) => {
      const existing = ws.find((w) => w.kind === kind);
      if (!existing) return [...ws, { kind, tab, nonce: 0, crumb }];
      if (tab && tab !== existing.tab) return ws.map((w) => (w === existing ? { ...w, tab, crumb, nonce: w.nonce + 1 } : w));
      return crumb ? ws.map((w) => (w === existing ? { ...w, crumb } : w)) : ws;
    });
    // Un écran déjà ouvert revient devant au lieu de s'ouvrir une deuxième fois.
    focus(kind);
  };
  /** Facture à modifier : elle se recharge dans la fiche au comptant 1, ou à crédit pour une vente à crédit. */
  const [editReq, setEditReq] = useState<{ kind: WinKind; sale: Result<'sales.editable'> & { id: string }; nonce: number } | null>(null);
  useEffect(() => {
    const onEdit = (e: Event) => {
      const id = (e as CustomEvent<string>).detail;
      call('sales.editable', id).then((sale) => {
        const kind: WinKind = sale.credit ? 'credit' : 'cash1';
        open(kind, undefined, `Facturation › Modifier la facture ${sale.number}`);
        setEditReq((r) => ({ kind, sale: { ...sale, id }, nonce: (r?.nonce ?? 0) + 1 }));
      }, toast.error);
    };
    window.addEventListener(EDIT_SALE_EVENT, onEdit);
    return () => window.removeEventListener(EDIT_SALE_EVENT, onEdit);
  });
  /** ⟳ : recharge les données de la fenêtre sans la fermer. */
  const refreshWin = (kind: WinKind) => setWins((ws) => ws.map((w) => (w.kind === kind ? { ...w, rev: (w.rev ?? 0) + 1 } : w)));
  const close = (kind: WinKind | null) => {
    if (!kind) return;
    setWins(wins.filter((w) => w.kind !== kind));
    const rest = stack.filter((k) => k !== kind);
    setStack(rest);
    // La fenêtre juste derrière passe devant ; sans fenêtre ouverte, la page d'accueil s'affiche.
    if (active === kind) setActive(rest[rest.length - 1] ?? null);
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
      .filter((i) => i.open?.[0] !== 'sales' || can('sales') || Boolean(i.perm) || i.open[1] === 'tickets')
      .filter((i, n, all) => !i.sep || (n > 0 && n < all.length - 1 && !all[n - 1]!.sep));
  const visibleMenus = MENUS.filter(([, items]) => visibleItems(items).some((i) => !i.sep));

  const startTraining = async () => {
    if (state.dossier.fiche?.kind === 'formation') return toast.ok('Vous êtes déjà en mode formation');
    const ok = await askConfirm(
      "Ouvrir le mode formation ? FEDONIX 360 redémarre sur une copie de la boutique : on y vend pour s'entraîner, avec les vrais articles et les vrais comptes, mais rien ne compte dans la boutique (ni stock, ni caisse, ni comptabilité, ni serveur). « Quitter la formation » ramène à la boutique.",
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
    if (item.action === 'training') return startTraining();
    if (item.action === 'dossiers') return setDossiers(true);
    if (item.action === 'quit') return window.close();
    if (item.action === 'shortcuts' || item.action === 'about' || item.action === 'palette' || item.action === 'guide' || item.action === 'news' || item.action === 'tabs' || item.action === 'rail') return setHelp(item.action);
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
    ...visibleMenus.flatMap(([name, items]) =>
      visibleItems(items)
        .filter((i) => !i.sep && !i.soon && i.action !== 'palette')
        .map((i) => ({ menu: name, label: i.label, run: () => void run(i, name) })),
    ),
    { menu: 'Accueil', label: "Page d'accueil", run: () => setActive(null) },
  ];

  /** Liste d'un menu, ouverte à côté de la barre verte (ou sous le nom de l'utilisateur). */
  const MenuDrop = ({ name, items, up, right, at }: { name: string; items: MenuItem[]; up?: boolean; right?: boolean; at?: typeof menuAt }) => (
    <div
      className={`menu-drop ${up ? 'up' : ''} ${right ? 'right' : ''} ${at ? 'fixed' : ''}`}
      style={at ? { left: at.left, top: at.top ?? 'auto', bottom: at.bottom ?? 'auto', maxHeight: `calc(100vh - ${(at.top ?? at.bottom ?? 0) + 10}px)` } : undefined}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="menu-title">{name}</div>
      {items.map((i, n) =>
        i.sep ? (
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
  );
  // Barre verte : les menus choisis par l'utilisateur, dans son ordre ; par défaut tous.
  const railChoice = prefs.railMenus as string[] | undefined;
  const railMenus = railChoice
    ? railChoice.flatMap((n) => visibleMenus.filter(([name]) => name === n && !RAIL_FIXED.includes(name)))
    : visibleMenus.filter(([name]) => !RAIL_FIXED.includes(name));
  const railBottom = visibleMenus.filter(([name]) => RAIL_FIXED.includes(name));
  /** Ouvre un menu de la barre verte à hauteur de son bouton (vers le haut dans la moitié basse de l'écran). */
  const toggleRailMenu = (name: string, btn: HTMLElement) => {
    setAllMenus(false);
    if (menu === name) return setMenu(null);
    const r = btn.getBoundingClientRect();
    setMenuAt(r.top > window.innerHeight / 2 ? { left: r.right + 8, bottom: Math.max(10, window.innerHeight - r.bottom) } : { left: r.right + 8, top: r.top });
    setMenu(name);
  };

  const syncLabel = !sync.data?.connected ? 'Serveur : non relié' : sync.data.lastError ? 'Serveur : hors ligne' : sync.data.pending ? `Serveur : ${sync.data.pending} en attente` : 'Serveur : connecté';
  const activeWin = wins.find((w) => w.kind === active);
  const showHome = !activeWin;
  const tiles = ROLE_TILES[user.role].filter((t) => canWin(t.open[0]));

  return (
    <RightsProvider value={user.rights}>
    <StoreSettingsProvider value={state.storeSettings ?? DEFAULT_STORE_SETTINGS}>
    <div className={`desk ${onPos ? 'on-pos' : ''}`}>
      <nav className="rail">
        <button className={`rail-logo ${showHome ? 'on' : ''}`} title="Page d'accueil" onClick={() => (setAllMenus(false), setActive(null))}>
          <img src={logo} alt="" />
        </button>
        {/* Faire défiler la barre ferme le menu ouvert ; la roulette dans le menu lui-même le fait défiler. */}
        <div className="rail-scroll" onWheel={(e) => menu && !(e.target as HTMLElement).closest('.menu-drop') && setMenu(null)}>
          {railMenus.map(([name, items]) => (
            <div key={name} className="menu">
              <button
                className={`rail-item ${menu === name ? 'open' : ''}`}
                title={name}
                onClick={(e) => {
                  e.stopPropagation();
                  // « Tous les menus » couvre l'écran : on le ferme pour voir le menu choisi.
                  toggleRailMenu(name, e.currentTarget);
                  chargesLate.reload();
                  gaps.reload();
                }}
              >
                <i aria-hidden>{MENU_ICONS[name]}</i>
                {RAIL_LABELS[name] ?? name}
              </button>
              {menu === name && <MenuDrop name={name} items={visibleItems(items)} at={menuAt} />}
            </div>
          ))}
        </div>
        <button
          className={`rail-item ${allMenus ? 'open' : ''}`}
          title="Tous les menus"
          onClick={(e) => {
            e.stopPropagation();
            setMenu(null);
            setAllMenus((v) => !v);
            chargesLate.reload();
            gaps.reload();
          }}
        >
          <i aria-hidden>▦</i>
          Tous les menus
        </button>
        <button className="rail-item small" title="Choisir les menus de cette barre et leur ordre" onClick={() => (setMenu(null), setHelp('rail'))}>
          <i aria-hidden>✎</i>
          Personnaliser
        </button>
        {railBottom.map(([name, items]) => (
          <div key={name} className="menu">
            <button
              className={`rail-item ${menu === name ? 'open' : ''}`}
              onClick={(e) => {
                e.stopPropagation();
                toggleRailMenu(name, e.currentTarget);
              }}
            >
              <i aria-hidden>{MENU_ICONS[name]}</i>
              {RAIL_LABELS[name] ?? name}
            </button>
            {menu === name && <MenuDrop name={name} items={visibleItems(items)} at={menuAt} />}
          </div>
        ))}
      </nav>
      <header className="topbar">
        <div className="quick-tabs">
          {quickTabs.map((q, idx) => {
            // Plusieurs onglets rapides partagent la fenêtre Stock ou Ventes : seul celui de l'onglet affiché est en relief.
            const win = wins.find((w) => w.kind === q.open[0] && (!q.open[1] || w.tab === q.open[1]));
            const isOpen = Boolean(win);
            const isActive = isOpen && active === q.open[0];
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
        <button className="top-icon tab-add" title="Personnaliser les onglets rapides" onClick={() => setHelp('tabs')}>
          ＋
        </button>
        <button className="top-icon" title="Aller à un écran (Ctrl+K)" onClick={() => setHelp('palette')}>
          🔍
        </button>
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
          {menu === '__user' && <MenuDrop name="Fichier" items={visibleItems(MENUS[0]![1])} right />}
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
          <div className="home-card">
            <div className="home-mark">{(state.station?.store.name ?? 'S').replace(/^(superette|supérette)\s+/i, '').slice(0, 1).toUpperCase()}</div>
            <h1>{state.station?.store.name}</h1>
            {(state.station?.store.address || state.station?.store.phone) && (
              <p>{[state.station?.store.address, state.station?.store.phone].filter(Boolean).join(' · ')}</p>
            )}
            <p className="home-sub">
              Bonjour {user.name.split(' ')[0]} · {ROLE_LABELS[user.role]}
            </p>
            {(can('cash') || can('credit')) && showHome && <MyDay />}
            <div className="role-tiles">
              {tiles.map((t) => (
                <button key={t.label} onClick={() => open(t.open[0], t.open[1], t.label)}>
                  <span className="tile-icon" aria-hidden>
                    {t.icon}
                  </span>
                  <strong>{t.label}</strong>
                  <small>{t.desc}</small>
                </button>
              ))}
            </div>
            <p className="home-links">
              <button className="link" onClick={() => setHelp('palette')}>
                Chercher un autre écran (Ctrl+K)
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
            key={`${w.kind}-${w.nonce}`}
            title={w.crumb ?? WINDOWS[w.kind].label}
            icon={MENU_ICONS[(w.crumb ?? '').split(' › ')[0]!] ?? winIcon(w.kind)}
            geo={geoOf(w.kind)}
            area={area}
            z={stack.indexOf(w.kind) + 1}
            active={w.kind === active}
            onFocus={() => focus(w.kind)}
            onChange={(g) => saveGeo(w.kind, g)}
            onClose={() => close(w.kind)}
            onRefresh={() => refreshWin(w.kind)}
          >
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
                active={w.kind === active}
                title={w.kind === 'cash1' ? 'Fiche de facturation 1' : w.kind === 'cash2' ? 'Fiche de facturation 2' : 'Facture à crédit'}
                onClose={() => close(w.kind)}
                onSwitchMode={() => (w.kind === 'credit' ? open('cash1', undefined, 'Facturation › Vente au comptant 1') : open('credit', undefined, 'Facturation › Vente à crédit'))}
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
            {w.kind === 'quotes' && <Quotes user={user} />}
            {w.kind === 'realSales' && <RealSales initialTab={w.tab as RealSalesTab | undefined} />}
            {w.kind === 'fiscalPrep' && <FiscalPrep initialTab={w.tab as FiscalPrepTab | undefined} />}
            {w.kind === 'deliveries' && <Deliveries active={w.kind === active} />}
            {w.kind === 'orders' && <Orders user={user} />}
            {w.kind === 'promotions' && <Promotions active={w.kind === active} />}
            {w.kind === 'labels' && <Labels active={w.kind === active} />}
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
          </MdiWindow>
        ))}
      </main>
      <footer className="statusbar">
        <span title="Version du logiciel">FEDONIX 360 v{state.version}</span>
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
          <button className="warn" onClick={() => open('expenses', 'schedule', 'Charge › Constats de charges')} title={`${fcfa(chargesLate.data!.amount)} de charges fixes non constatées`}>
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
              if (!(await askConfirm(`Fermer FEDONIX 360 et installer la version ${update.data!.available} ? Le logiciel se rouvre tout seul après l'installation.`))) return;
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
                  .filter((i) => !i.sep)
                  .map((i) => (
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
                  ))}
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
          available={[...QUICK, ...MENUS.flatMap(([, items]) => visibleItems(items).flatMap((i) => (i.open && !i.sep ? [{ label: i.label, open: i.open }] : [])))].filter(
            (t, n, all) => canWin(t.open[0]) && all.findIndex((x) => x.open[0] === t.open[0] && x.open[1] === t.open[1]) === n,
          )}
          onSave={saveTabs}
          onClose={() => setHelp(null)}
        />
      )}
      {help === 'shortcuts' && (
        <Modal title="Raccourcis clavier" onClose={() => setHelp(null)}>
          <table className="list compact">
            <tbody>
              {[
                ['Ctrl+K', 'Rechercher un écran par son nom'],
                ['F1', 'Aide sur la page (à la caisse : rechercher un produit)'],
                ['F2', 'Valider et imprimer le ticket de caisse (fiche vide : réimprimer le dernier)'],
                ['F7', 'Valider et imprimer la facture listing (fiche vide : réimprimer la dernière en listing)'],
                ['F5', 'Actualiser la page (à la caisse : ouvrir le tiroir)'],
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
      {dossiers && <DossierPicker onClose={() => setDossiers(false)} />}
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
            <img src={logo} alt="" width={48} height={48} style={{ float: 'left', marginRight: 12 }} />
            <strong>FEDONIX 360</strong> v{state.version}
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
