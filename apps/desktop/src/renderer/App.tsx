import { useEffect, useState } from 'react';
import { DEFAULT_STORE_SETTINGS, type Permission } from '@superette/core';
import { type Result, call } from './api';
import { type QuickTab, type WinKind } from './nav';
import { Accounting, type AccountingTab } from './screens/Accounting';
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
import { SaleDetail, Sales, type SalesTab } from './screens/Sales';
import { Setup } from './screens/Setup';
import { Staff, type StaffTab } from './screens/Staff';
import { Stock, type StockTab } from './screens/Stock';
import { Suppliers, type SuppliersTab } from './screens/Suppliers';
import { Treasury, type TreasuryTab } from './screens/Treasury';
import { CommandPalette, GettingStarted, HelpDialog, type PaletteEntry, QuickTabsEditor, WhatsNew } from './screens/Guide';
import { ROLE_TILES } from './guide';
import { Field, Modal, RightsProvider, StoreSettingsProvider, ToastProvider, fcfa, useLoad, useToast } from './ui';

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
    perm: ['stock', 'stock_moves', 'stock_monitoring', 'stock_receive', 'stock_loss', 'stock_request', 'stock_adjust', 'stock_decide', 'transfer_view', 'transfer_create', 'transfer_direct', 'inventory', 'inventory_count'],
  },
  purchases: { label: 'Achats', perm: ['purchases', 'purchase_orders', 'reorder', 'purchase_invoices', 'supplier_pay', 'purchase_due'] },
  suppliers: { label: 'Fournisseurs', perm: ['suppliers', 'supplier_statement'] },
  customers: { label: 'Clients', perm: ['customers', 'receivables', 'rebates', 'customer_statement'] },
  expenses: { label: 'Dépenses', perm: ['expenses', 'expense_record', 'expense_categories', 'charge_plans'] },
  quotes: { label: 'Devis et proformas', perm: ['quotes', 'quote_save'] },
  promotions: { label: 'Promotions', perm: ['promotions', 'promotion_save', 'promotion_stop'] },
  labels: { label: 'Étiquettes', perm: ['labels'] },
  reports: { label: 'Rapports de ventes', perm: ['reports'] },
  accounting: { label: 'Comptabilité', perm: ['accounting', 'vat_return', 'tax', 'tax_settings', 'bank_reconciliation', 'statements', 'journal_entry', 'chart_accounts'] },
  treasury: { label: 'Opérations de trésorerie', perm: ['treasury', 'cash_history', 'central_cash'] },
  dashboard: { label: 'Tableau de bord', perm: ['dashboard'] },
  admin: { label: 'Administration', perm: ['admin'] },
  production: { label: 'Fabrication', perm: ['production', 'production_recipes', 'production_create', 'production_validate'] },
  staff: { label: 'Collaborateurs', perm: ['staff', 'staff_edit', 'staff_salaries'] },
};

interface MenuItem {
  label: string;
  open?: [WinKind, string?];
  action?: 'logout' | 'sync' | 'shortcuts' | 'about' | 'quit' | 'openInvoice' | 'help' | 'palette' | 'guide' | 'news' | 'tabs';
  /** Trait de séparation entre deux groupes, comme dans KONTROL. */
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

const MENUS: [string, MenuItem[]][] = [
  [
    'Fichier',
    [
      { label: 'Synchroniser maintenant', action: 'sync' },
      { label: 'Personnaliser les onglets rapides', action: 'tabs' },
      { label: "Changer d'utilisateur", action: 'logout' },
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
      SEP,
      { label: "Retours d'articles des clients", open: ['sales', 'returns'] },
      { label: 'Tickets et factures annulés', open: ['sales', 'cancelled'] },
      SEP,
      { label: 'Devis et factures proforma', open: ['quotes'] },
      { label: 'Factures cumulées par client', open: ['reports', 'customer'], perm: 'reports' },
      { label: 'Alertes sur les ventes', open: ['sales', 'alerts'], perm: 'sales_alerts' },
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
      { label: 'Registre des achats', open: ['purchases', 'invoices'], perm: 'purchase_invoices' },
      { label: 'Registre des achats par produits', open: ['purchases', 'byproduct'] },
      SEP,
      { label: 'Registre des réceptions', open: ['purchases', 'receptions'] },
      { label: 'Saisir une nouvelle réception (sans commande)', open: ['stock', 'receive'], perm: 'stock_receive' },
      SEP,
      { label: 'Bons de commande', open: ['purchases', 'orders'], perm: ['purchases', 'purchase_orders', 'order_receive'] },
      { label: 'Proposition de commande', open: ['purchases', 'reorder'], perm: 'reorder' },
      { label: 'Promotions', open: ['promotions'], perm: 'promotions' },
      SEP,
      { label: 'Marchandises non encore reçues', open: ['purchases', 'pending'] },
      { label: 'Échéancier fournisseurs', open: ['purchases', 'due'], perm: 'purchase_due' },
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
      { label: 'Étiquettes de rayon', open: ['labels'] },
      { label: 'Promotions', open: ['promotions'], perm: 'promotions' },
      SEP,
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
      { label: 'Extrait de compte d’un collaborateur', open: ['staff', 'statement'] },
    ],
  ],
  ['Transfert', [{ label: 'Transfert entre dépôts', open: ['stock', 'transfer'], perm: ['transfer_view', 'transfer_create', 'transfer_direct'] }]],
  [
    'Magasinier',
    [
      { label: 'État du stock', open: ['stock', 'state'], perm: 'stock' },
      { label: 'Mouvements de stock', open: ['stock', 'moves'], perm: 'stock_moves' },
      { label: 'Monitoring du stock', open: ['stock', 'monitoring'], perm: ['stock_monitoring', 'stock_request', 'stock_decide'] },
      { label: 'Pertes et casse', open: ['stock', 'loss'], perm: 'stock_loss' },
      { label: 'Inventaires', open: ['stock', 'inventory'], perm: ['inventory', 'inventory_count', 'inventory_close', 'inventory_print'] },
      { label: 'Péremptions', open: ['stock', 'expiry'], perm: 'stock' },
      { label: 'Étiquettes de rayon', open: ['labels'] },
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
      { label: 'Sauvegardes', open: ['admin', 'backups'], perm: 'backups' },
      { label: 'Serveur central', open: ['admin', 'server'] },
      { label: 'Licence', open: ['admin', 'license'] },
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

/** Barre d'onglets rapides, comme celle de KONTROL : les onglets d'origine, que chacun peut personnaliser. */
const QUICK: QuickTab[] = [
  { label: 'V. cash 1', open: ['cash1'] },
  { label: 'V. cash 2', open: ['cash2'] },
  { label: 'V. crédit', open: ['credit'], credit: true },
  { label: 'Mes factures', open: ['sales', 'tickets'] },
  { label: 'Registre', open: ['sales', 'z'] },
  { label: 'Produits', open: ['articles'] },
  { label: 'Stock', open: ['stock', 'state'] },
  { label: 'Stock MM', open: ['stock', 'moves'] },
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
  const refresh = () => call('app.state').then(setState);
  useEffect(() => void refresh(), []);

  if (!state) return <div className="splash">Chargement…</div>;

  return (
    <ToastProvider>
      {!state.initialized ? (
        <Setup onDone={refresh} />
      ) : !state.user ? (
        <Login station={state.station} onDone={refresh} />
      ) : (
        <Workspace key={state.user.id} state={state} user={state.user} refresh={refresh} />
      )}
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
  const [menu, setMenu] = useState<string | null>(null);
  const [chooseRegister, setChooseRegister] = useState(false);
  const [help, setHelp] = useState<'shortcuts' | 'about' | 'page' | 'palette' | 'guide' | 'news' | 'tabs' | null>(null);
  const [finding, setFinding] = useState(false);
  const [found, setFound] = useState<Result<'pos.sale'> | null>(null);
  // Menu du clic droit : sur un onglet rapide (le déplacer, le retirer) ou sur un écran d'un menu (l'épingler).
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; tab?: number; pin?: QuickTab } | null>(null);
  const [prefs, setPrefs] = useState<Record<string, unknown>>(state.prefs ?? {});
  const sync = useLoad(() => call('sync.state'), []);
  const backupLate = useLoad(() => call('backup.overdue'), []);
  const chargesLate = useLoad(() => call('charges.late'), []);
  const gaps = useLoad(() => call('treasury.pendingGaps'), []);

  const savePref = (key: string, value: unknown) => {
    setPrefs((p) => ({ ...p, [key]: value }));
    call('prefs.set', key, value).catch(toast.error);
  };
  const quickTabs = ((prefs.quickTabs as QuickTab[] | undefined) ?? QUICK).filter((q) => canWin(q.open[0]));
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
    document.title = `Superette Gestion v${state.version} : ${state.station?.store.name ?? ''}, ${state.register?.name ?? 'sans caisse'}, utilisateur ${user.name}`;
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
      if (e.ctrlKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setHelp('palette');
      } else if (e.key === 'F1' && !onPos) {
        e.preventDefault();
        setHelp('page');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onPos]);

  const open = (kind: WinKind, tab?: string, crumb?: string) => {
    if (!canWin(kind)) return toast.error("Vous n'avez pas les droits pour ouvrir cette fenêtre");
    setWins((ws) => {
      const existing = ws.find((w) => w.kind === kind);
      if (!existing) return [...ws, { kind, tab, nonce: 0, crumb }];
      if (tab && tab !== existing.tab) return ws.map((w) => (w === existing ? { ...w, tab, crumb, nonce: w.nonce + 1 } : w));
      return crumb ? ws.map((w) => (w === existing ? { ...w, crumb } : w)) : ws;
    });
    setActive(kind);
  };
  const close = (kind: WinKind | null) => {
    if (!kind) return;
    const rest = wins.filter((w) => w.kind !== kind);
    setWins(rest);
    // Sans fenêtre ouverte, la page d'accueil s'affiche.
    if (active === kind) setActive(rest[rest.length - 1]?.kind ?? null);
  };

  /**
   * Éléments permis à l'utilisateur, sans séparateur en tête, en fin ni en double.
   * Comme dans KONTROL, ce qui n'est pas permis ne s'affiche pas du tout (pas de ligne grisée).
   */
  const supervisor = user.role === 'admin' || user.role === 'manager';
  const visibleItems = (items: MenuItem[]) =>
    items
      .filter((i) => (!i.perm || [i.perm].flat().some(can)) && (!i.adminOnly || user.role === 'admin'))
      .filter((i) => (!i.open || canWin(i.open[0])) && (!i.soon || supervisor))
      .filter((i) => i.open?.[0] !== 'sales' || can('sales') || Boolean(i.perm) || i.open[1] === 'tickets')
      .filter((i, n, all) => !i.sep || (n > 0 && n < all.length - 1 && !all[n - 1]!.sep));
  const visibleMenus = MENUS.filter(([, items]) => visibleItems(items).some((i) => !i.sep));

  const run = async (item: MenuItem, menuName: string) => {
    setMenu(null);
    if (item.soon) return;
    if (item.open) return open(item.open[0], item.open[1], `${menuName} › ${item.label}`);
    if (item.action === 'logout') return call('auth.logout').then(refresh);
    if (item.action === 'quit') return window.close();
    if (item.action === 'shortcuts' || item.action === 'about' || item.action === 'palette' || item.action === 'guide' || item.action === 'news' || item.action === 'tabs') return setHelp(item.action);
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

  const syncLabel = !sync.data?.connected ? 'Serveur : non relié' : sync.data.lastError ? 'Serveur : hors ligne' : `Serveur : connecté (${sync.data.pending} en attente)`;
  const activeWin = wins.find((w) => w.kind === active);
  const showHome = !activeWin;
  const tiles = ROLE_TILES[user.role].filter((t) => canWin(t.open[0]));

  return (
    <RightsProvider value={user.rights}>
    <StoreSettingsProvider value={state.storeSettings ?? DEFAULT_STORE_SETTINGS}>
    <div className="desk">
      <nav className="menubar">
        {visibleMenus.map(([name, items]) => (
          <div key={name} className="menu">
            <button
              className={menu === name ? 'open' : ''}
              onClick={(e) => {
                e.stopPropagation();
                setMenu(menu === name ? null : name);
                chargesLate.reload();
                gaps.reload();
              }}
              onMouseEnter={() => menu && setMenu(name)}
            >
              {name}
            </button>
            {menu === name && (
              <div className="menu-drop">
                {visibleItems(items).map((i, n) =>
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
            )}
          </div>
        ))}
        <button className="menu-search" title="Rechercher un écran (Ctrl+K)" onClick={() => setHelp('palette')}>
          🔍 Rechercher un écran <kbd>Ctrl+K</kbd>
        </button>
      </nav>
      <nav className="quickbar">
        <div className="quick-tabs">
        <button className={`home-tab ${showHome ? 'active' : ''}`} title="Page d'accueil" onClick={() => setActive(null)}>
          🏠 Accueil
        </button>
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
        <button className="help-btn" title="Aide sur cette page (F1)" onClick={() => setHelp('page')}>
          ?
        </button>
        <button className="win-close" title="Fermer la fenêtre active" disabled={showHome} onClick={() => close(active)}>
          ✕
        </button>
      </nav>
      <div className="crumbs">
        <button className="link" onClick={() => setActive(null)}>
          Accueil
        </button>
        {activeWin &&
          (activeWin.crumb ?? WINDOWS[activeWin.kind].label).split(' › ').map((part, i) => (
            <span key={`${part}-${i}`}>
              <span className="crumb-sep">›</span>
              {part}
            </span>
          ))}
        <span className="spacer" />
        <button className="link" onClick={() => setHelp('page')}>
          Comment utiliser cette page ?
        </button>
      </div>
      <main className="windows">
        {showHome && (
          <section className="home">
            <div className="home-card">
              <div className="home-mark">{(state.station?.store.name ?? 'S').replace(/^(superette|supérette)\s+/i, '').slice(0, 1).toUpperCase()}</div>
              <h1>{state.station?.store.name}</h1>
              {(state.station?.store.address || state.station?.store.phone) && (
                <p>{[state.station?.store.address, state.station?.store.phone].filter(Boolean).join(' · ')}</p>
              )}
              <p className="home-sub">
                Bonjour {user.name.split(' ')[0]} · {ROLE_LABELS[user.role]}
              </p>
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
        )}
        {wins.map((w) => (
          <section key={`${w.kind}-${w.nonce}`} className="window" hidden={w.kind !== active}>
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
                active={w.kind === active}
                title={w.kind === 'cash1' ? 'Fiche de facturation 1' : w.kind === 'cash2' ? 'Fiche de facturation 2' : 'Facture à crédit'}
                onClose={() => close(w.kind)}
                onListing={() => open('sales', 'tickets', 'Facturation › Mes factures')}
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
            {w.kind === 'promotions' && <Promotions active={w.kind === active} />}
            {w.kind === 'labels' && <Labels active={w.kind === active} />}
            {w.kind === 'reports' && <Reports view={w.tab} />}
            {w.kind === 'expenses' && <Expenses user={user} initialTab={w.tab as ExpensesTab | undefined} />}
            {w.kind === 'staff' && <Staff user={user} initialTab={w.tab as StaffTab | undefined} />}
            {w.kind === 'accounting' && <Accounting user={user} initialTab={w.tab as AccountingTab | undefined} />}
            {w.kind === 'treasury' && <Treasury user={user} registerId={state.register?.id ?? null} initialTab={w.tab as TreasuryTab | undefined} onChanged={() => (refresh(), gaps.reload())} />}
            {w.kind === 'dashboard' && <Dashboard initialTab={w.tab as DashboardTab | undefined} onOpen={([kind, tab]) => open(kind, tab)} />}
            {w.kind === 'admin' && <Admin user={user} onChanged={refresh} initialTab={w.tab as AdminTab | undefined} />}
          </section>
        ))}
      </main>
      <footer className="statusbar">
        <span>Superette Gestion v{state.version}</span>
        <span>Magasin : {state.station?.store.name}</span>
        {state.canChooseRegister ? (
          <button className="link reg" title="Choisir la caisse sur laquelle vous vendez" onClick={() => setChooseRegister(true)}>
            {state.register?.name ?? 'Sans caisse'} · changer
          </button>
        ) : (
          <span>{state.register?.name ?? 'Sans caisse'}</span>
        )}
        <span>
          Utilisateur : {user.name} ({ROLE_LABELS[user.role]})
        </span>
        <span className={sync.data?.connected && !sync.data.lastError ? 'ok' : ''}>{syncLabel}</span>
        {backupLate.data && canWin('admin') && (
          <button className="warn" onClick={() => open('admin', 'backups', 'Administration › Sauvegardes')} title="Aucune sauvegarde réussie depuis plus de 2 jours">
            Sauvegarde en retard
          </button>
        )}
        {Boolean(chargesLate.data?.count) && canWin('expenses') && (
          <button className="warn" onClick={() => open('expenses', 'schedule', 'Charge › Constats de charges')} title={`${fcfa(chargesLate.data!.amount)} de charges fixes non constatées`}>
            {chargesLate.data!.count} charge(s) en retard
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
        {Boolean(gaps.data?.length) && (
          <button className="warn" onClick={() => open('treasury', 'history', 'Trésorerie › Historique des journées de caisse')} title="Clôtures dont l'écart attend votre motif">
            {gaps.data!.length} écart(s) de caisse à justifier
          </button>
        )}
        <button className="link" onClick={() => call('auth.logout').then(refresh)}>
          Changer d'utilisateur
        </button>
      </footer>
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
                ['F4 ou Entrée sur saisie vide', 'Valider la fiche (espèces si l’encaissé couvre le total)'],
                ['Ctrl+E', 'Encaisser : Mobile Money, carte, paiements mixtes'],
                ['F3', 'Mettre la fiche en attente'],
                ['F10', 'Rappeler un ticket en attente'],
                ['F2', 'Réimprimer le dernier ticket'],
                ['F6', 'Remise sur la ligne sélectionnée'],
                ['F7', 'Listing des factures'],
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
            Superette Gestion v{state.version}
            <br />
            Gestion commerciale pour superettes au Cameroun : caisse, stock, multi-magasins.
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
