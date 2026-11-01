import { DEFAULT_STORE_SETTINGS, type PcScreen, pcScreen, pcScreenAllowed } from '@superette/core';
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { type Result, call } from './api';
import { type Lang, setLang, storedLang } from './i18n';
import { backToApp, installRemote, remoteLink } from './remote';
import { Accounting } from './screens/Accounting';
import { Admin } from './screens/Admin';
import { Articles } from './screens/Articles';
import { Customers } from './screens/Customers';
import { Dashboard } from './screens/Dashboard';
import { Expenses } from './screens/Expenses';
import { Purchases } from './screens/Purchases';
import { Sales } from './screens/Sales';
import { Staff } from './screens/Staff';
import { Stock } from './screens/Stock';
import { Suppliers } from './screens/Suppliers';
import { Treasury } from './screens/Treasury';
import { setVatOn } from './tax';
import { applyBrand } from './theme';
import { AskHost, RefreshCtx, RightsProvider, StoreSettingsProvider, ToastProvider } from './ui';
import './styles.css';
import './design.css';
import './mobile.css';

/**
 * Gestion sur le téléphone du gérant (ONIX 360 Mobile) : les écrans du PC qui
 * font tourner la boutique, et seulement eux. Chaque action est exécutée par
 * un PC allumé du magasin, avec les droits de la personne connectée.
 */

installRemote();

type AppState = Result<'app.state'>;
type User = NonNullable<AppState['user']>;

interface Module extends PcScreen {
  icon: string;
  render: (user: User, state: AppState, refresh: () => void) => React.ReactNode;
}

const GROUPS: [string, Module[]][] = [
  [
    'Suivi',
    [
      { ...pcScreen('dashboard'), icon: '📊', render: (u) => <Dashboard user={u} onOpen={() => undefined} /> },
      { ...pcScreen('sales'), icon: '🧾', render: (u) => <Sales rights={u.rights} /> },
    ],
  ],
  [
    'Argent',
    [
      { ...pcScreen('treasury'), icon: '💰', render: (u, s, r) => <Treasury user={u} registerId={s.register?.id ?? null} onChanged={r} /> },
      { ...pcScreen('customers'), icon: '👥', render: (u) => <Customers user={u} /> },
      { ...pcScreen('suppliers'), icon: '🚚', render: (u) => <Suppliers user={u} /> },
      { ...pcScreen('payments'), icon: '📦', render: (u) => <Purchases user={u} initialTab="due" /> },
      { ...pcScreen('expenses'), icon: '💸', render: (u) => <Expenses user={u} /> },
      { ...pcScreen('accounting'), icon: '📒', render: (u) => <Accounting user={u} /> },
    ],
  ],
  [
    'Boutique',
    [
      { ...pcScreen('articles'), icon: '🏷️', render: (u) => <Articles user={u} /> },
      { ...pcScreen('stock'), icon: '📋', render: (u) => <Stock user={u} /> },
    ],
  ],
  [
    'Équipe',
    [
      { ...pcScreen('staff'), icon: '🗓️', render: (u) => <Staff user={u} /> },
      {
        ...pcScreen('admin'),
        icon: '⚙️',
        render: (u, _s, r) => <Admin user={u} onChanged={r} only={['registers', 'warehouses', 'users', 'privileges', 'delegation', 'settings']} initialTab={u.rights.includes('admin') ? 'registers' : 'delegation'} />,
      },
    ],
  ],
];

function MobileApp() {
  const [state, setState] = useState<AppState | null>(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState<Module | null>(null);
  // Écran demandé par le menu de l'appli (mobile.html#customers) : ouvert directement, le retour revient à l'appli.
  const [deep] = useState(() => decodeURIComponent(location.hash.slice(1)));
  const [rev, setRev] = useState(0);
  const refresh = () =>
    call('app.state').then(
      (s) => {
        setVatOn(s.station?.store.vat_enabled !== 0);
        setLang(s.user && s.prefs.lang ? (s.prefs.lang as Lang) : storedLang());
        applyBrand(s.storeSettings?.brandColor, s.storeSettings?.brandColor2);
        setState(s);
        setError('');
      },
      (e: Error) => setError(e.message),
    );
  useEffect(() => void refresh(), []);
  // Bouton « retour » d'Android : revenir au menu, puis à l'appli.
  useEffect(() => {
    const onPop = () => setOpen(null);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  const go = (m: Module | null) => {
    if (m) history.pushState({ m: m.id }, '');
    setOpen(m);
    window.scrollTo(0, 0);
  };

  if (!remoteLink()) return <Shell title="Gestion" onBack={backToApp}><p className="mpc-note">Ouvrez cet écran depuis ONIX 360 Mobile.</p></Shell>;
  if (error && !state)
    return (
      <Shell title="Gestion" onBack={backToApp}>
        <div className="mpc-error">{error}</div>
        <button className="btn primary" onClick={() => void refresh()}>
          Réessayer
        </button>
      </Shell>
    );
  if (!state) return <Shell title="Gestion" onBack={backToApp}><p className="mpc-note">Connexion au PC du magasin…</p></Shell>;
  const user = state.user;
  if (!user) return <Shell title="Gestion" onBack={backToApp}><div className="mpc-error">Session refusée par le PC : reconnectez-vous dans l’appli.</div></Shell>;
  const allowed = (m: Module) => pcScreenAllowed(m, user.rights);
  const direct = deep ? GROUPS.flatMap(([, mods]) => mods).find((m) => m.id === deep && allowed(m)) : undefined;
  if (direct && !open)
    return (
      <RightsProvider value={user.rights}>
        <StoreSettingsProvider value={state.storeSettings ?? DEFAULT_STORE_SETTINGS}>
          <Shell title={direct.label} onBack={backToApp} onRefresh={() => setRev((r) => r + 1)}>
            <RefreshCtx.Provider value={rev}>
              <div className="mpc-screen" key={`${direct.id}:${rev}`}>
                {direct.render(user, state, () => void refresh())}
              </div>
            </RefreshCtx.Provider>
          </Shell>
        </StoreSettingsProvider>
      </RightsProvider>
    );

  return (
    <RightsProvider value={user.rights}>
      <StoreSettingsProvider value={state.storeSettings ?? DEFAULT_STORE_SETTINGS}>
        {open ? (
          <Shell title={open.label} onBack={() => history.back()} onRefresh={() => setRev((r) => r + 1)}>
            <RefreshCtx.Provider value={rev}>
              <div className="mpc-screen" key={`${open.id}:${rev}`}>
                {open.render(user, state, () => void refresh())}
              </div>
            </RefreshCtx.Provider>
          </Shell>
        ) : (
          <Shell title={`Gestion · ${state.station?.store.name ?? ''}`} onBack={backToApp}>
            <p className="mpc-note">
              Connecté en tant que <b>{user.name}</b>. Ce que vous faites ici est fait par un PC du magasin, avec vos droits, comme si vous étiez à son poste.
            </p>
            {GROUPS.map(([title, mods]) => {
              const list = mods.filter(allowed);
              if (!list.length) return null;
              return (
                <section key={title} className="mpc-group">
                  <h2>{title}</h2>
                  <div className="mpc-tiles">
                    {list.map((m) => (
                      <button key={m.id} className="mpc-tile" onClick={() => go(m)}>
                        <span className="mpc-icon" aria-hidden>
                          {m.icon}
                        </span>
                        <b>{m.label}</b>
                        <small>{m.hint}</small>
                      </button>
                    ))}
                  </div>
                </section>
              );
            })}
          </Shell>
        )}
      </StoreSettingsProvider>
    </RightsProvider>
  );
}

function Shell({ title, onBack, onRefresh, children }: { title: string; onBack: () => void; onRefresh?: () => void; children: React.ReactNode }) {
  return (
    <div className="mpc">
      <header className="mpc-bar">
        <button className="mpc-back" onClick={onBack} aria-label="Retour">
          ‹
        </button>
        <b className="mpc-title">{title}</b>
        {onRefresh ? (
          <button className="mpc-back" onClick={onRefresh} aria-label="Actualiser">
            ⟳
          </button>
        ) : null}
      </header>
      <main className="mpc-main">{children}</main>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ToastProvider>
      <MobileApp />
      <AskHost />
    </ToastProvider>
  </StrictMode>,
);
