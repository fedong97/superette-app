import { useEffect, useState } from 'react';
import type { Permission } from '@superette/core';
import { type Result, call } from './api';
import { Accounting, type AccountingTab } from './screens/Accounting';
import { Admin, type AdminTab } from './screens/Admin';
import { Articles, type ArticlesView } from './screens/Articles';
import { Customers, type CustomersTab } from './screens/Customers';
import { Dashboard } from './screens/Dashboard';
import { Expenses, type ExpensesTab } from './screens/Expenses';
import { Login } from './screens/Login';
import { Pos, RegisterChooser } from './screens/Pos';
import { Labels } from './screens/Labels';
import { Promotions } from './screens/Promotions';
import { Reports } from './screens/Reports';
import { Quotes } from './screens/Quotes';
import { Purchases, type PurchasesTab } from './screens/Purchases';
import { SaleDetail, Sales, type SalesTab } from './screens/Sales';
import { Setup } from './screens/Setup';
import { Stock, type StockTab } from './screens/Stock';
import { Suppliers, type SuppliersTab } from './screens/Suppliers';
import { Treasury, type TreasuryTab } from './screens/Treasury';
import { Field, Modal, ToastProvider, fcfa, useLoad, useToast } from './ui';

type AppState = Result<'app.state'>;
type User = NonNullable<AppState['user']>;
type Role = User['role'];

/** Fenêtres de travail, ouvertes côte à côte comme dans KONTROL (une seule visible à la fois). */
type WinKind = 'cash1' | 'cash2' | 'credit' | 'sales' | 'articles' | 'stock' | 'purchases' | 'suppliers' | 'customers' | 'expenses' | 'quotes' | 'promotions' | 'labels' | 'reports' | 'accounting' | 'treasury' | 'dashboard' | 'admin';
interface Win {
  kind: WinKind;
  tab?: string;
  /** Change à chaque réouverture sur un autre onglet, pour repartir de cet onglet. */
  nonce: number;
}



const WINDOWS: Record<WinKind, { label: string; perm: Permission }> = {
  cash1: { label: 'Fiche de facturation 1', perm: 'cash' },
  cash2: { label: 'Fiche de facturation 2', perm: 'cash' },
  credit: { label: 'Vente à crédit', perm: 'credit' },
  sales: { label: 'Mes factures', perm: 'sales' },
  articles: { label: 'Produits', perm: 'articles' },
  stock: { label: 'Stock', perm: 'stock' },
  purchases: { label: 'Achats', perm: 'purchases' },
  suppliers: { label: 'Fournisseurs', perm: 'suppliers' },
  customers: { label: 'Clients', perm: 'customers' },
  expenses: { label: 'Dépenses', perm: 'expenses' },
  quotes: { label: 'Devis et proformas', perm: 'quotes' },
  promotions: { label: 'Promotions', perm: 'promotions' },
  labels: { label: 'Étiquettes', perm: 'labels' },
  reports: { label: 'Rapports de ventes', perm: 'reports' },
  accounting: { label: 'Comptabilité', perm: 'accounting' },
  treasury: { label: 'Opérations de trésorerie', perm: 'treasury' },
  dashboard: { label: 'Tableau de bord', perm: 'dashboard' },
  admin: { label: 'Administration', perm: 'admin' },
};

interface MenuItem {
  label: string;
  open?: [WinKind, string?];
  action?: 'logout' | 'sync' | 'shortcuts' | 'about' | 'quit' | 'openInvoice';
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
      { label: 'Alertes sur les ventes', open: ['sales', 'alerts'] },
      SEP,
      { label: 'Promotions', open: ['promotions'], perm: 'promotions' },
      { label: 'Situation des ventes', open: ['reports', 'department'], perm: 'reports' },
      { label: 'Évolution périodique', open: ['reports', 'evolution'], perm: 'reports' },
      { label: 'Tableau de bord', open: ['dashboard'] },
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
      { label: 'Saisir une nouvelle réception (sans commande)', open: ['stock', 'receive'] },
      SEP,
      { label: 'Bons de commande', open: ['purchases', 'orders'] },
      { label: 'Proposition de commande', open: ['purchases', 'reorder'], perm: 'purchase_orders' },
      { label: 'Promotions', open: ['promotions'], perm: 'promotions' },
      SEP,
      { label: 'Marchandises non encore reçues', open: ['purchases', 'pending'] },
      { label: 'Échéancier fournisseurs', open: ['purchases', 'due'], perm: 'purchase_invoices' },
    ],
  ],
  ['Fabrication', [{ label: 'Recettes et ordres de fabrication', soon: true }]],
  [
    'Trésorerie',
    [
      { label: 'Opérations de trésorerie (ouverture, clôture)', open: ['treasury', 'day'], perm: 'treasury' },
      { label: 'Historique des journées de caisse', open: ['treasury', 'history'], perm: 'cash_amounts', badge: 'gaps' },
      { label: 'Caisse centrale', open: ['treasury', 'central'], perm: 'central_cash' },
      SEP,
      { label: 'Journaux de trésorerie', open: ['accounting', 'journals'], perm: 'accounting' },
      { label: 'Positions (caisses, banques, Mobile Money)', open: ['accounting', 'treasury'] },
      { label: 'Extrait de compte (grand livre)', open: ['accounting', 'ledger'] },
      { label: 'Listing des opérations de caisse', open: ['sales', 'cashops'] },
      SEP,
      { label: 'Règlements clients reçus', open: ['customers', 'payments'] },
      { label: 'Rechercher dans les caisses', open: ['sales', 'find'] },
      SEP,
      { label: 'Registre de caisse (Z)', open: ['sales', 'z'], perm: 'cash_amounts' },
      { label: 'Rapprochement bancaire', open: ['accounting', 'bank'], perm: 'accounting' },
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
      { label: 'Promotions', open: ['promotions'], perm: 'promotions' },
      SEP,
      { label: 'Articles par dépôt', open: ['stock', 'warehouses'] },
      { label: 'Rayonnage des articles', open: ['articles', 'shelving'] },
      SEP,
      { label: 'Stocks', open: ['stock', 'state'] },
      { label: 'Historique des ajustements de stock', open: ['stock', 'adjustments'] },
      { label: 'Mouvements de stock', open: ['stock', 'moves'] },
      SEP,
      { label: 'Inventaires', open: ['stock', 'inventory'], perm: ['inventory', 'inventory_count'] },
      { label: 'Déstockages (pertes et casse)', open: ['stock', 'loss'] },
      SEP,
      { label: 'Stocks critiques', open: ['stock', 'critical'] },
      { label: 'Proposition de commande', open: ['purchases', 'reorder'], perm: 'purchase_orders' },
    ],
  ],
  [
    'Fournisseur',
    [
      { label: 'Liste des fournisseurs', open: ['suppliers', 'list'] },
      SEP,
      { label: 'Consulter un extrait de compte', open: ['suppliers', 'statement'] },
      { label: 'Situation des fournisseurs', open: ['suppliers', 'situation'], perm: 'purchase_invoices' },
      { label: 'Les comptes dont le solde a bougé récemment', open: ['suppliers', 'recent'] },
      SEP,
      { label: 'Factures et avoirs fournisseurs', open: ['purchases', 'invoices'], perm: 'purchase_invoices' },
      { label: 'Échéancier fournisseurs', open: ['purchases', 'due'], perm: 'purchase_invoices' },
    ],
  ],
  [
    'Client',
    [
      { label: 'Liste', open: ['customers', 'list'] },
      { label: 'Contrôle des échéances', open: ['customers', 'receivables'], perm: 'receivables' },
      { label: "Contrôle des plafonds d'autorisation", open: ['customers', 'limits'], perm: 'receivables' },
      SEP,
      { label: 'Consulter un extrait de compte', open: ['customers', 'statement'] },
      { label: 'Situation des clients', open: ['customers', 'receivables'], perm: 'receivables' },
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
      { label: 'Inventaires', open: ['stock', 'inventory'], perm: ['inventory', 'inventory_count'] },
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
      { label: 'Magasins', open: ['admin', 'stores'], adminOnly: true },
      { label: 'Caisses', open: ['admin', 'registers'] },
      { label: 'Dépôts', open: ['admin', 'warehouses'] },
      { label: 'Utilisateurs', open: ['admin', 'users'] },
      { label: 'Droits par rôle', open: ['admin', 'rights'] },
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
  { label: 'Trésorerie', open: ['treasury', 'day'] },
  { label: 'TABORD', open: ['dashboard'] },
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

function Workspace({ state, user, refresh }: { state: AppState; user: User; refresh: () => void }) {
  const toast = useToast();
  const can = (perm: Permission) => user.rights.includes(perm);
  // Sans tout le registre, le caissier garde « Mes factures » pour ses trois dernières.
  const canWin = (kind: WinKind) => can(WINDOWS[kind].perm) || (kind === 'sales' && (can('cash') || can('credit')));
  const first: WinKind = (['cash1', 'stock', 'sales', 'articles', 'purchases', 'accounting', 'customers'] as WinKind[]).find(canWin) ?? 'sales';
  const [wins, setWins] = useState<Win[]>([{ kind: first, nonce: 0 }]);
  const [active, setActive] = useState<WinKind>(first);
  const [menu, setMenu] = useState<string | null>(null);
  const [chooseRegister, setChooseRegister] = useState(false);
  const [help, setHelp] = useState<'shortcuts' | 'about' | null>(null);
  const [finding, setFinding] = useState(false);
  const [found, setFound] = useState<Result<'pos.sale'> | null>(null);
  const sync = useLoad(() => call('sync.state'), []);
  const backupLate = useLoad(() => call('backup.overdue'), []);
  const chargesLate = useLoad(() => call('charges.late'), []);
  const gaps = useLoad(() => call('treasury.pendingGaps'), []);

  useEffect(() => {
    const t = setInterval(() => {
      sync.reload();
      backupLate.reload();
      chargesLate.reload();
      gaps.reload();
    }, 15000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    document.title = `Superette Gestion v${state.version} : ${state.station?.store.name ?? ''}, ${state.register?.name ?? 'sans caisse'}, utilisateur ${user.name}`;
  }, [state, user]);
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [menu]);

  const open = (kind: WinKind, tab?: string) => {
    if (!canWin(kind)) return toast.error("Vous n'avez pas les droits pour ouvrir cette fenêtre");
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
      .filter((i) => (!i.perm || [i.perm].flat().some(can)) && (!i.adminOnly || user.role === 'admin'))
      .filter((i) => i.open?.[0] !== 'sales' || can('sales') || i.open[1] === 'tickets' || i.open[1] === 'z')
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
                    <button key={i.label} disabled={i.soon || (i.open && !canWin(i.open[0]))} onClick={() => void run(i)}>
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
              disabled={q.soon || (q.open && !canWin(q.open[0]))}
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
                hasRegister={Boolean(state.register)}
                registerId={state.register?.id ?? null}
                canChooseRegister={state.canChooseRegister}
                onRegisterChosen={refresh}
                vatEnabled={state.station?.store.vat_enabled !== 0}
                ignoreStock={state.station?.store.ignore_stock === 1}
                active={w.kind === active}
                title={w.kind === 'cash1' ? 'Fiche de facturation 1' : w.kind === 'cash2' ? 'Fiche de facturation 2' : 'Facture à crédit'}
                onClose={() => close(w.kind)}
                onListing={() => open('sales', 'tickets')}
                onTreasury={() => open('treasury', 'day')}
              />
            )}
            {w.kind === 'articles' && <Articles user={user} view={w.tab as ArticlesView | undefined} />}
            {w.kind === 'stock' && <Stock user={user} initialTab={w.tab as StockTab | undefined} />}
            {w.kind === 'sales' && <Sales initialTab={w.tab as SalesTab | undefined} rights={user.rights} />}
            {w.kind === 'purchases' && <Purchases user={user} initialTab={w.tab as PurchasesTab | undefined} />}
            {w.kind === 'suppliers' && <Suppliers user={user} initialTab={w.tab as SuppliersTab | undefined} />}
            {w.kind === 'customers' && <Customers user={user} initialTab={w.tab as CustomersTab | undefined} />}
            {w.kind === 'quotes' && <Quotes user={user} />}
            {w.kind === 'promotions' && <Promotions active={w.kind === active} />}
            {w.kind === 'labels' && <Labels active={w.kind === active} />}
            {w.kind === 'reports' && <Reports view={w.tab} />}
            {w.kind === 'expenses' && <Expenses user={user} initialTab={w.tab as ExpensesTab | undefined} />}
            {w.kind === 'accounting' && <Accounting user={user} initialTab={w.tab as AccountingTab | undefined} />}
            {w.kind === 'treasury' && <Treasury user={user} registerId={state.register?.id ?? null} initialTab={w.tab as TreasuryTab | undefined} onChanged={() => (refresh(), gaps.reload())} />}
            {w.kind === 'dashboard' && <Dashboard />}
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
        {backupLate.data && (
          <button className="warn" disabled={!canWin('admin')} onClick={() => open('admin', 'backups')} title="Aucune sauvegarde réussie depuis plus de 2 jours">
            Sauvegarde en retard
          </button>
        )}
        {Boolean(chargesLate.data?.count) && (
          <button className="warn" onClick={() => open('expenses', 'schedule')} title={`${fcfa(chargesLate.data!.amount)} de charges fixes non constatées`}>
            {chargesLate.data!.count} charge(s) en retard
          </button>
        )}
        {Boolean(gaps.data?.length) && (
          <button className="warn" onClick={() => open('treasury', 'history')} title="Clôtures dont l'écart attend votre motif">
            {gaps.data!.length} écart(s) de caisse à justifier
          </button>
        )}
        <button className="link" onClick={() => call('auth.logout').then(refresh)}>
          Changer d'utilisateur
        </button>
      </footer>
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
