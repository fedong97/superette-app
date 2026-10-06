import { useEffect, useState } from 'react';
import { type Result, call } from './api';
import { Admin, type AdminTab } from './screens/Admin';
import { Articles } from './screens/Articles';
import { Dashboard } from './screens/Dashboard';
import { Login } from './screens/Login';
import { Pos } from './screens/Pos';
import { Purchases, type PurchasesTab } from './screens/Purchases';
import { Sales, type SalesTab } from './screens/Sales';
import { Setup } from './screens/Setup';
import { Stock, type StockTab } from './screens/Stock';
import { Suppliers } from './screens/Suppliers';
import { Modal, ToastProvider, useLoad, useToast } from './ui';

type AppState = Result<'app.state'>;
type User = NonNullable<AppState['user']>;
type Role = User['role'];

/** Fenêtres de travail, ouvertes côte à côte comme dans KONTROL (une seule visible à la fois). */
type WinKind = 'cash1' | 'cash2' | 'sales' | 'articles' | 'stock' | 'purchases' | 'suppliers' | 'dashboard' | 'admin';
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
const PURCHASING: Role[] = ['admin', 'manager', 'stock', 'accountant'];

const WINDOWS: Record<WinKind, { label: string; roles: Role[] }> = {
  cash1: { label: 'Fiche de facturation 1', roles: POS },
  cash2: { label: 'Fiche de facturation 2', roles: POS },
  sales: { label: 'Mes factures', roles: ACCOUNTING },
  articles: { label: 'Produits', roles: STOCK },
  stock: { label: 'Stock', roles: STOCK },
  purchases: { label: 'Achats', roles: PURCHASING },
  suppliers: { label: 'Fournisseurs', roles: PURCHASING },
  dashboard: { label: 'Tableau de bord', roles: MANAGE },
  admin: { label: 'Administration', roles: MANAGE },
};

interface MenuItem {
  label: string;
  open?: [WinKind, string?];
  action?: 'logout' | 'sync' | 'shortcuts' | 'about' | 'quit';
  /** Module pas encore développé : affiché grisé. */
  soon?: boolean;
  roles?: Role[];
}

const MENUS: [string, MenuItem[]][] = [
  ['Fichier', [{ label: 'Synchroniser maintenant', action: 'sync' }, { label: "Changer d'utilisateur", action: 'logout' }, { label: 'Quitter', action: 'quit' }]],
  [
    'Facturation',
    [
      { label: 'Vente au comptant 1', open: ['cash1'] },
      { label: 'Vente au comptant 2', open: ['cash2'] },
      { label: 'Vente à crédit', soon: true },
      { label: 'Mes factures', open: ['sales', 'tickets'] },
      { label: 'Registre (clôtures Z)', open: ['sales', 'z'] },
    ],
  ],
  [
    'Vente',
    [
      { label: 'Tickets du jour', open: ['sales', 'tickets'] },
      { label: 'Tableau de bord des ventes', open: ['dashboard'] },
      { label: 'Devis et proformas', soon: true },
    ],
  ],
  [
    'Achats',
    [
      { label: 'Bons de commande fournisseur', open: ['purchases', 'orders'], roles: BUY },
      { label: 'Proposition de commande', open: ['purchases', 'reorder'], roles: BUY },
      { label: 'Réceptions fournisseur', open: ['purchases', 'receptions'] },
      { label: 'Réception libre (sans commande)', open: ['stock', 'receive'] },
      { label: 'Factures fournisseur', open: ['purchases', 'invoices'], roles: ACCOUNTING },
      { label: 'Échéancier fournisseurs', open: ['purchases', 'due'], roles: ACCOUNTING },
    ],
  ],
  ['Fabrication', [{ label: 'Recettes et ordres de fabrication', soon: true }]],
  [
    'Trésorerie',
    [
      { label: 'Registre de caisse (Z)', open: ['sales', 'z'] },
      { label: 'Échéancier fournisseurs', open: ['purchases', 'due'], roles: ACCOUNTING },
      { label: 'Banques et Mobile Money', soon: true },
    ],
  ],
  [
    'Produit',
    [
      { label: 'Fiches produits', open: ['articles'] },
      { label: 'État du stock', open: ['stock', 'state'] },
    ],
  ],
  [
    'Fournisseur',
    [
      { label: 'Fiches fournisseurs', open: ['suppliers'] },
      { label: 'Factures et règlements', open: ['purchases', 'invoices'], roles: ACCOUNTING },
    ],
  ],
  ['Client', [{ label: 'Fiches clients', soon: true }, { label: 'Comptes clients (crédit)', soon: true }]],
  ['Charge', [{ label: 'Dépenses', soon: true }]],
  ['Transfert', [{ label: 'Transfert entre dépôts', open: ['stock', 'transfer'] }]],
  [
    'Magasinier',
    [
      { label: 'État du stock', open: ['stock', 'state'] },
      { label: 'Mouvements de stock', open: ['stock', 'moves'] },
      { label: 'Pertes et casse', open: ['stock', 'loss'] },
      { label: 'Inventaire', open: ['stock', 'inventory'], roles: MANAGE },
      { label: 'Péremptions', open: ['stock', 'expiry'] },
    ],
  ],
  [
    'Comptabilité',
    [
      { label: 'Export des ventes (CSV)', open: ['sales', 'export'] },
      { label: 'Journaux et grand livre SYSCOHADA', soon: true },
    ],
  ],
  ['Fiscal', [{ label: 'Déclaration de TVA', soon: true }, { label: 'DSF', soon: true }]],
  [
    'Administration',
    [
      { label: 'Magasins', open: ['admin', 'stores'], roles: ['admin'] },
      { label: 'Caisses', open: ['admin', 'registers'] },
      { label: 'Dépôts', open: ['admin', 'warehouses'] },
      { label: 'Utilisateurs', open: ['admin', 'users'] },
      { label: 'Paramètres', open: ['admin', 'settings'] },
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
  { label: 'V. crédit', soon: true, credit: true },
  { label: 'Mes factures', open: ['sales', 'tickets'] },
  { label: 'Registre', open: ['sales', 'z'] },
  { label: 'Produits', open: ['articles'] },
  { label: 'Stock', open: ['stock', 'state'] },
  { label: 'Stock MM', open: ['stock', 'moves'] },
  { label: 'Transfert', open: ['stock', 'transfer'] },
  { label: 'Dépenses', soon: true },
  { label: 'Achats', open: ['purchases', 'orders'] },
  { label: 'Trésorerie', soon: true },
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
  const sync = useLoad(() => call('sync.state'), []);

  useEffect(() => {
    const t = setInterval(sync.reload, 15000);
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

  const run = async (item: MenuItem) => {
    setMenu(null);
    if (item.soon) return;
    if (item.open) return open(...item.open);
    if (item.action === 'logout') return call('auth.logout').then(refresh);
    if (item.action === 'quit') return window.close();
    if (item.action === 'shortcuts' || item.action === 'about') return setHelp(item.action);
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
              }}
              onMouseEnter={() => menu && setMenu(name)}
            >
              {name}
            </button>
            {menu === name && (
              <div className="menu-drop">
                {items
                  .filter((i) => !i.roles || can(i.roles))
                  .map((i) => (
                    <button key={i.label} disabled={i.soon || (i.open && !can(WINDOWS[i.open[0]].roles))} onClick={() => void run(i)}>
                      {i.label}
                      {i.soon && <small>bientôt</small>}
                    </button>
                  ))}
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
            {(w.kind === 'cash1' || w.kind === 'cash2') && (
              <Pos
                user={user}
                hasRegister={Boolean(state.station?.register)}
                active={w.kind === active}
                title={w.kind === 'cash1' ? 'Fiche de facturation 1' : 'Fiche de facturation 2'}
                onClose={() => close(w.kind)}
                onListing={() => open('sales', 'tickets')}
              />
            )}
            {w.kind === 'articles' && <Articles user={user} />}
            {w.kind === 'stock' && <Stock user={user} initialTab={w.tab as StockTab | undefined} />}
            {w.kind === 'sales' && <Sales initialTab={w.tab as SalesTab | undefined} />}
            {w.kind === 'purchases' && <Purchases user={user} initialTab={w.tab as PurchasesTab | undefined} />}
            {w.kind === 'suppliers' && <Suppliers user={user} />}
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
