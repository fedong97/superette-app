import { useEffect, useState } from 'react';
import { type Result, call } from './api';
import { Accounting, type AccountingTab } from './screens/Accounting';
import { Admin, type AdminTab } from './screens/Admin';
import { Articles, type ArticlesView } from './screens/Articles';
import { Customers, type CustomersTab } from './screens/Customers';
import { Dashboard } from './screens/Dashboard';
import { Expenses, type ExpensesTab } from './screens/Expenses';
import { Login } from './screens/Login';
import { Pos } from './screens/Pos';
import { Labels } from './screens/Labels';
import { Promotions } from './screens/Promotions';
import { Reports } from './screens/Reports';
import { Quotes } from './screens/Quotes';
import { Purchases, type PurchasesTab } from './screens/Purchases';
import { SaleDetail, Sales, type SalesTab } from './screens/Sales';
import { Setup } from './screens/Setup';
import { Stock, type StockTab } from './screens/Stock';
import { Suppliers, type SuppliersTab } from './screens/Suppliers';
import { Field, Modal, ToastProvider, fcfa, useLoad, useToast } from './ui';

type AppState = Result<'app.state'>;
type User = NonNullable<AppState['user']>;
type Role = User['role'];

/** Fenêtres de travail, ouvertes côte à côte comme dans KONTROL (une seule visible à la fois). */
type WinKind = 'cash1' | 'cash2' | 'credit' | 'sales' | 'articles' | 'stock' | 'purchases' | 'suppliers' | 'customers' | 'expenses' | 'quotes' | 'promotions' | 'labels' | 'reports' | 'accounting' | 'dashboard' | 'admin';
interface Win {
  kind: WinKind;
  tab?: string;
  /** Change à chaque réouverture sur un autre onglet, pour repartir de cet onglet. */
  nonce: number;
}

const ALL: Role[] = ['admin', 'manager', 'cashier', 'stock', 'accountant'];
const POS: Role[] = ['admin', 'manager', 'cashier'];
const STOCK: Role[] = ['admin', 'manager', 'stock'];
const MANAGE: Role[] = ['admin', 'manager'];
const ACCOUNTING: Role[] = ['admin', 'manager', 'accountant'];
const BUY: Role[] = ['admin', 'manager', 'stock'];
const QUOTES: Role[] = ['admin', 'manager', 'cashier', 'accountant'];
const PURCHASING: Role[] = ['admin', 'manager', 'stock', 'accountant'];
const CUSTOMERS: Role[] = ['admin', 'manager', 'cashier', 'accountant'];

const WINDOWS: Record<WinKind, { label: string; roles: Role[] }> = {
  cash1: { label: 'Fiche de facturation 1', roles: POS },
  cash2: { label: 'Fiche de facturation 2', roles: POS },
  credit: { label: 'Vente à crédit', roles: POS },
  sales: { label: 'Mes factures', roles: ACCOUNTING },
  articles: { label: 'Produits', roles: STOCK },
  stock: { label: 'Stock', roles: STOCK },
  purchases: { label: 'Achats', roles: PURCHASING },
  suppliers: { label: 'Fournisseurs', roles: PURCHASING },
  customers: { label: 'Clients', roles: CUSTOMERS },
  expenses: { label: 'Dépenses', roles: ACCOUNTING },
  quotes: { label: 'Devis et proformas', roles: QUOTES },
  promotions: { label: 'Promotions', roles: MANAGE },
  labels: { label: 'Étiquettes', roles: STOCK },
  reports: { label: 'Rapports de ventes', roles: ACCOUNTING },
  accounting: { label: 'Comptabilité', roles: ACCOUNTING },
  dashboard: { label: 'Tableau de bord', roles: MANAGE },
  admin: { label: 'Administration', roles: MANAGE },
};

interface MenuItem {
  label: string;
  open?: [WinKind, string?];
  action?: 'logout' | 'sync' | 'shortcuts' | 'about' | 'quit' | 'openInvoice';
  /** Trait de séparation entre deux groupes, comme dans KONTROL. */
  sep?: boolean;
  /** Module pas encore développé : affiché grisé. */
  soon?: boolean;
  roles?: Role[];
}

const SEP: MenuItem = { label: '', sep: true };

const MENUS: [string, MenuItem[]][] = [
  ['Fichier', [{ label: 'Synchroniser maintenant', action: 'sync' }, { label: "Changer d'utilisateur", action: 'logout' }, { label: 'Quitter', action: 'quit' }]],
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
      { label: 'Ouvrir une facture', action: 'openInvoice' },
      { label: 'Facture à crédit (client en compte)', open: ['credit'] },
      { label: 'Mes dernières factures', open: ['sales', 'tickets'] },
      { label: 'Registre des ventes', open: ['sales', 'register'] },
      SEP,
      { label: "Retours d'articles des clients", open: ['sales', 'returns'] },
      { label: 'Tickets et factures annulés', open: ['sales', 'cancelled'] },
      SEP,
      { label: 'Devis et factures proforma', open: ['quotes'] },
      { label: 'Factures cumulées par client', open: ['reports', 'customer'], roles: ACCOUNTING },
      { label: 'Alertes sur les ventes', open: ['sales', 'alerts'] },
      SEP,
      { label: 'Promotions', open: ['promotions'], roles: MANAGE },
      { label: 'Situation des ventes', open: ['reports', 'department'], roles: ACCOUNTING },
      { label: 'Évolution périodique', open: ['reports', 'evolution'], roles: ACCOUNTING },
      { label: 'Tableau de bord', open: ['dashboard'] },
    ],
  ],
  [
    'Achats',
    [
      { label: 'Saisir un nouvel achat (bon de commande)', open: ['purchases', 'new-order'], roles: BUY },
      { label: 'Saisir une facture à partir des BL', open: ['purchases', 'invoices'], roles: ACCOUNTING },
      { label: 'Registre des achats', open: ['purchases', 'invoices'], roles: ACCOUNTING },
      { label: 'Registre des achats par produits', open: ['purchases', 'byproduct'] },
      SEP,
      { label: 'Registre des réceptions', open: ['purchases', 'receptions'] },
      { label: 'Saisir une nouvelle réception (sans commande)', open: ['stock', 'receive'] },
      SEP,
      { label: 'Bons de commande', open: ['purchases', 'orders'] },
      { label: 'Proposition de commande', open: ['purchases', 'reorder'], roles: BUY },
      { label: 'Promotions', open: ['promotions'], roles: MANAGE },
      SEP,
      { label: 'Marchandises non encore reçues', open: ['purchases', 'pending'] },
      { label: 'Échéancier fournisseurs', open: ['purchases', 'due'], roles: ACCOUNTING },
    ],
  ],
  ['Fabrication', [{ label: 'Recettes et ordres de fabrication', soon: true }]],
  [
    'Trésorerie',
    [
      { label: 'Opérations (journaux de trésorerie)', open: ['accounting', 'journals'], roles: ACCOUNTING },
      { label: 'Positions (caisses, banques, Mobile Money)', open: ['accounting', 'treasury'] },
      { label: 'Extrait de compte (grand livre)', open: ['accounting', 'ledger'] },
      { label: 'Listing des opérations de caisse', open: ['sales', 'cashops'] },
      SEP,
      { label: 'Règlements clients reçus', open: ['customers', 'payments'] },
      { label: 'Rechercher dans les caisses', open: ['sales', 'find'] },
      SEP,
      { label: 'Registre de caisse (Z)', open: ['sales', 'z'] },
      { label: 'Rapprochement bancaire', open: ['accounting', 'bank'], roles: ACCOUNTING },
    ],
  ],
  [
    'Produit',
    [
      { label: 'Liste des produits', open: ['articles', 'list'] },
      { label: 'Ajouter / paramétrer une marchandise', open: ['articles', 'new'] },
      { label: 'Recherche', open: ['articles', 'search'] },
      SEP,
      { label: 'Péremptions', open: ['stock', 'expiry'] },
      { label: 'Étiquettes de rayon', open: ['labels'] },
      { label: 'Promotions', open: ['promotions'], roles: MANAGE },
      SEP,
      { label: 'Articles par dépôt', open: ['stock', 'warehouses'] },
      { label: 'Rayonnage des articles', open: ['articles', 'shelving'] },
      SEP,
      { label: 'Stocks', open: ['stock', 'state'] },
      { label: 'Historique des ajustements de stock', open: ['stock', 'adjustments'] },
      { label: 'Mouvements de stock', open: ['stock', 'moves'] },
      SEP,
      { label: 'Inventaires', open: ['stock', 'inventory'], roles: MANAGE },
      { label: 'Déstockages (pertes et casse)', open: ['stock', 'loss'] },
      SEP,
      { label: 'Stocks critiques', open: ['stock', 'critical'] },
      { label: 'Proposition de commande', open: ['purchases', 'reorder'], roles: BUY },
    ],
  ],
  [
    'Fournisseur',
    [
      { label: 'Liste des fournisseurs', open: ['suppliers', 'list'] },
      SEP,
      { label: 'Consulter un extrait de compte', open: ['suppliers', 'statement'] },
      { label: 'Situation des fournisseurs', open: ['suppliers', 'situation'], roles: ACCOUNTING },
      { label: 'Les comptes dont le solde a bougé récemment', open: ['suppliers', 'recent'] },
      SEP,
      { label: 'Factures et avoirs fournisseurs', open: ['purchases', 'invoices'], roles: ACCOUNTING },
      { label: 'Échéancier fournisseurs', open: ['purchases', 'due'], roles: ACCOUNTING },
    ],
  ],
  [
    'Client',
    [
      { label: 'Liste', open: ['customers', 'list'] },
      { label: 'Contrôle des échéances', open: ['customers', 'receivables'], roles: ACCOUNTING },
      { label: "Contrôle des plafonds d'autorisation", open: ['customers', 'limits'], roles: ACCOUNTING },
      SEP,
      { label: 'Consulter un extrait de compte', open: ['customers', 'statement'] },
      { label: 'Situation des clients', open: ['customers', 'receivables'], roles: ACCOUNTING },
      { label: 'Les comptes dont le solde a bougé récemment', open: ['customers', 'recent'] },
      SEP,
      { label: 'Règlements reçus', open: ['customers', 'payments'] },
      { label: 'Retours et avoirs clients', open: ['sales', 'returns'] },
    ],
  ],
  [
    'Charge',
    [
      { label: 'Types de charge', open: ['expenses', 'categories'] },
      { label: 'Définition des charges fixes', open: ['expenses', 'plans'] },
      { label: 'Dépenses (nouvelle dépense)', open: ['expenses', 'new'] },
      SEP,
      { label: 'Historique des dépenses', open: ['expenses', 'list'] },
      { label: 'Dépenses par catégorie', open: ['expenses', 'summary'] },
      SEP,
      { label: 'Constats de charges', open: ['expenses', 'schedule'] },
    ],
  ],
  ['Transfert', [{ label: 'Transfert entre dépôts', open: ['stock', 'transfer'] }]],
  [
    'Magasinier',
    [
      { label: 'État du stock', open: ['stock', 'state'] },
      { label: 'Mouvements de stock', open: ['stock', 'moves'] },
      { label: 'Pertes et casse', open: ['stock', 'loss'] },
      { label: 'Inventaire', open: ['stock', 'inventory'], roles: MANAGE },
      { label: 'Péremptions', open: ['stock', 'expiry'] },
      { label: 'Étiquettes de rayon', open: ['labels'] },
    ],
  ],
  [
    'Comptabilité',
    [
      { label: 'Journaux', open: ['accounting', 'journals'] },
      { label: 'Grand livre', open: ['accounting', 'ledger'] },
      { label: 'Balance générale', open: ['accounting', 'balance'] },
      { label: 'Bilan et compte de résultat', open: ['accounting', 'statements'] },
      { label: 'Plan comptable', open: ['accounting', 'accounts'] },
      { label: 'Export des ventes (CSV)', open: ['sales', 'export'] },
    ],
  ],
  ['Fiscal', [{ label: 'Déclaration de TVA', open: ['accounting', 'vat'] }, { label: 'États financiers et DSF', open: ['accounting', 'statements'] }, { label: 'Notes déclaratives de la DSF', open: ['accounting', 'dsf'] }, { label: 'Impôt sur le résultat', open: ['accounting', 'tax'] }]],
  [
    'Administration',
    [
      { label: 'Magasins', open: ['admin', 'stores'], roles: ['admin'] },
      { label: 'Caisses', open: ['admin', 'registers'] },
      { label: 'Dépôts', open: ['admin', 'warehouses'] },
      { label: 'Utilisateurs', open: ['admin', 'users'] },
      { label: 'Paramètres', open: ['admin', 'settings'] },
      { label: 'Sauvegardes', open: ['admin', 'backups'] },
      { label: 'Serveur central', open: ['admin', 'server'] },
      { label: "Journal d'audit", open: ['admin', 'audit'] },
    ],
  ],
  ['Aide', [{ label: 'Raccourcis clavier', action: 'shortcuts' }, { label: 'À propos', action: 'about' }]],
];

/** Barre d'onglets rapides, comme celle de KONTROL. */
const QUICK: { label: string; open?: [WinKind, string?]; soon?: boolean; credit?: boolean }[] = [
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
  { label: 'Trésorerie', open: ['accounting', 'treasury'] },
  { label: 'TABORD', open: ['dashboard'] },
];

export const ROLE_LABELS: Record<Role, string> = {
  admin: 'Administrateur',
  manager: 'Gérant',
  cashier: 'Caissier',
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

function Workspace({ state, user, refresh }: { state: AppState; user: User; refresh: () => void }) {
  const toast = useToast();
  const can = (roles: Role[]) => roles.includes(user.role);
  const first: WinKind = can(POS) ? 'cash1' : can(STOCK) ? 'stock' : 'sales';
  const [wins, setWins] = useState<Win[]>([{ kind: first, nonce: 0 }]);
  const [active, setActive] = useState<WinKind>(first);
  const [menu, setMenu] = useState<string | null>(null);
  const [help, setHelp] = useState<'shortcuts' | 'about' | null>(null);
  const [finding, setFinding] = useState(false);
  const [found, setFound] = useState<Result<'pos.sale'> | null>(null);
  const sync = useLoad(() => call('sync.state'), []);
  const backupLate = useLoad(() => call('backup.overdue'), []);
  const chargesLate = useLoad(() => call('charges.late'), []);

  useEffect(() => {
    const t = setInterval(() => {
      sync.reload();
      backupLate.reload();
      chargesLate.reload();
    }, 15000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    document.title = `Superette Gestion v${state.version} : ${state.station?.store.name ?? ''}, ${state.station?.register?.name ?? 'poste de gestion'}, utilisateur ${user.name}`;
  }, [state, user]);
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [menu]);

  const open = (kind: WinKind, tab?: string) => {
    if (!can(WINDOWS[kind].roles)) return toast.error("Vous n'avez pas les droits pour ouvrir cette fenêtre");
    setWins((ws) => {
      const existing = ws.find((w) => w.kind === kind);
      if (!existing) return [...ws, { kind, tab, nonce: 0 }];
      if (tab && tab !== existing.tab) return ws.map((w) => (w === existing ? { ...w, tab, nonce: w.nonce + 1 } : w));
      return ws;
    });
    setActive(kind);
  };
  const close = (kind: WinKind) => {
    const rest = wins.filter((w) => w.kind !== kind);
    setWins(rest);
    if (active === kind) setActive(rest[rest.length - 1]?.kind ?? first);
    if (!rest.length) setWins([{ kind: first, nonce: 0 }]);
  };

  /** Éléments permis à l'utilisateur, sans séparateur en tête, en fin ni en double. */
  const visibleItems = (items: MenuItem[]) =>
    items
      .filter((i) => !i.roles || can(i.roles))
      .filter((i, n, all) => !i.sep || (n > 0 && n < all.length - 1 && !all[n - 1]!.sep));

  const run = async (item: MenuItem) => {
    setMenu(null);
    if (item.soon) return;
    if (item.open) return open(...item.open);
    if (item.action === 'logout') return call('auth.logout').then(refresh);
    if (item.action === 'quit') return window.close();
    if (item.action === 'shortcuts' || item.action === 'about') return setHelp(item.action);
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

  const syncLabel = !sync.data?.connected ? 'Serveur : non relié' : sync.data.lastError ? 'Serveur : hors ligne' : `Serveur : connecté (${sync.data.pending} en attente)`;

  return (
    <div className="desk">
      <nav className="menubar">
        {MENUS.map(([name, items]) => (
          <div key={name} className="menu">
            <button
              className={menu === name ? 'open' : ''}
              onClick={(e) => {
                e.stopPropagation();
                setMenu(menu === name ? null : name);
                chargesLate.reload();
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
                    <button key={i.label} disabled={i.soon || (i.open && !can(WINDOWS[i.open[0]].roles))} onClick={() => void run(i)}>
                      {i.label}
                      {i.soon && <small>bientôt</small>}
                    </button>
                  ),
                )}
              </div>
            )}
          </div>
        ))}
      </nav>
      <nav className="quickbar">
        {QUICK.map((q) => {
          // Plusieurs onglets rapides partagent la fenêtre Stock ou Ventes : seul celui de l'onglet affiché est en relief.
          const win = q.open && wins.find((w) => w.kind === q.open![0] && (!q.open![1] || w.tab === q.open![1]));
          const isOpen = Boolean(win);
          const isActive = isOpen && active === q.open![0];
          return (
            <button
              key={q.label}
              className={`${isActive ? 'active' : isOpen ? 'open' : ''} ${q.credit ? 'credit' : ''}`}
              disabled={q.soon || (q.open && !can(WINDOWS[q.open[0]].roles))}
              title={q.soon ? 'Module à venir' : undefined}
              onClick={() => q.open && open(...q.open)}
            >
              {q.label}
            </button>
          );
        })}
        <button className="win-close" title="Fermer la fenêtre active" onClick={() => close(active)}>
          ✕
        </button>
      </nav>
      <main className="windows">
        {wins.map((w) => (
          <section key={`${w.kind}-${w.nonce}`} className="window" hidden={w.kind !== active}>
            {(w.kind === 'cash1' || w.kind === 'cash2' || w.kind === 'credit') && (
              <Pos
                user={user}
                mode={w.kind === 'credit' ? 'credit' : 'cash'}
                hasRegister={Boolean(state.station?.register)}
                active={w.kind === active}
                title={w.kind === 'cash1' ? 'Fiche de facturation 1' : w.kind === 'cash2' ? 'Fiche de facturation 2' : 'Facture à crédit'}
                onClose={() => close(w.kind)}
                onListing={() => open('sales', 'tickets')}
              />
            )}
            {w.kind === 'articles' && <Articles user={user} view={w.tab as ArticlesView | undefined} />}
            {w.kind === 'stock' && <Stock user={user} initialTab={w.tab as StockTab | undefined} />}
            {w.kind === 'sales' && <Sales initialTab={w.tab as SalesTab | undefined} />}
            {w.kind === 'purchases' && <Purchases user={user} initialTab={w.tab as PurchasesTab | undefined} />}
            {w.kind === 'suppliers' && <Suppliers user={user} initialTab={w.tab as SuppliersTab | undefined} />}
            {w.kind === 'customers' && <Customers user={user} initialTab={w.tab as CustomersTab | undefined} />}
            {w.kind === 'quotes' && <Quotes user={user} />}
            {w.kind === 'promotions' && <Promotions active={w.kind === active} />}
            {w.kind === 'labels' && <Labels active={w.kind === active} />}
            {w.kind === 'reports' && <Reports view={w.tab} />}
            {w.kind === 'expenses' && <Expenses user={user} initialTab={w.tab as ExpensesTab | undefined} />}
            {w.kind === 'accounting' && <Accounting user={user} initialTab={w.tab as AccountingTab | undefined} />}
            {w.kind === 'dashboard' && <Dashboard />}
            {w.kind === 'admin' && <Admin user={user} onChanged={refresh} initialTab={w.tab as AdminTab | undefined} />}
          </section>
        ))}
      </main>
      <footer className="statusbar">
        <span>Superette Gestion v{state.version}</span>
        <span>Magasin : {state.station?.store.name}</span>
        <span>{state.station?.register?.name ?? 'Poste de gestion'}</span>
        <span>
          Utilisateur : {user.name} ({ROLE_LABELS[user.role]})
        </span>
        <span className={sync.data?.connected && !sync.data.lastError ? 'ok' : ''}>{syncLabel}</span>
        {backupLate.data && (
          <button className="warn" disabled={!can(WINDOWS.admin.roles)} onClick={() => open('admin', 'backups')} title="Aucune sauvegarde réussie depuis plus de 2 jours">
            Sauvegarde en retard
          </button>
        )}
        {Boolean(chargesLate.data?.count) && (
          <button className="warn" onClick={() => open('expenses', 'schedule')} title={`${fcfa(chargesLate.data!.amount)} de charges fixes non constatées`}>
            {chargesLate.data!.count} charge(s) en retard
          </button>
        )}
        <button className="link" onClick={() => call('auth.logout').then(refresh)}>
          Changer d'utilisateur
        </button>
      </footer>
      {help === 'shortcuts' && (
        <Modal title="Raccourcis clavier" onClose={() => setHelp(null)}>
          <table className="list compact">
            <tbody>
              {[
                ['F4 ou Entrée sur saisie vide', 'Valider la fiche (espèces si l’encaissé couvre le total)'],
                ['Ctrl+E', 'Encaisser : Mobile Money, carte, paiements mixtes'],
                ['F3', 'Mettre la fiche en attente'],
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
