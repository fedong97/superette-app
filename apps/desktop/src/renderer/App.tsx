import { useEffect, useState } from 'react';
import { type Result, call } from './api';
import { Admin } from './screens/Admin';
import { Articles } from './screens/Articles';
import { Dashboard } from './screens/Dashboard';
import { Login } from './screens/Login';
import { Pos } from './screens/Pos';
import { Sales } from './screens/Sales';
import { Setup } from './screens/Setup';
import { Stock } from './screens/Stock';
import { ToastProvider } from './ui';

type AppState = Result<'app.state'>;
type Role = NonNullable<AppState['user']>['role'];
type Screen = 'pos' | 'articles' | 'stock' | 'sales' | 'dashboard' | 'admin';

const SCREENS: { key: Screen; label: string; icon: string; roles: Role[] }[] = [
  { key: 'pos', label: 'Caisse', icon: '🛒', roles: ['admin', 'manager', 'cashier'] },
  { key: 'articles', label: 'Articles', icon: '🏷️', roles: ['admin', 'manager', 'stock'] },
  { key: 'stock', label: 'Stock', icon: '📦', roles: ['admin', 'manager', 'stock'] },
  { key: 'sales', label: 'Ventes et Z', icon: '🧾', roles: ['admin', 'manager', 'accountant'] },
  { key: 'dashboard', label: 'Tableau de bord', icon: '📈', roles: ['admin', 'manager'] },
  { key: 'admin', label: 'Administration', icon: '⚙️', roles: ['admin', 'manager'] },
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
  const [screen, setScreen] = useState<Screen>('pos');
  const refresh = () => call('app.state').then(setState);
  useEffect(() => void refresh(), []);

  useEffect(() => {
    const user = state?.user;
    if (user) {
      const allowed = SCREENS.filter((s) => s.roles.includes(user.role));
      if (!allowed.some((s) => s.key === screen)) setScreen(allowed[0]?.key ?? 'pos');
    }
  }, [state?.user]);

  if (!state) return <div className="splash">Chargement…</div>;

  return (
    <ToastProvider>
      {!state.initialized ? (
        <Setup onDone={refresh} />
      ) : !state.user ? (
        <Login station={state.station} onDone={refresh} />
      ) : (
        <div className="shell">
          <nav className="side">
            <div className="brand">
              <strong>{state.station?.store.name}</strong>
              <small>
                {state.station?.register ? state.station.register.name : 'Poste de gestion'} · v{state.version}
              </small>
            </div>
            {SCREENS.filter((s) => s.roles.includes(state.user!.role)).map((s) => (
              <button key={s.key} className={screen === s.key ? 'active' : ''} onClick={() => setScreen(s.key)}>
                <span>{s.icon}</span> {s.label}
              </button>
            ))}
            <div className="who">
              <div>{state.user.name}</div>
              <small>{ROLE_LABELS[state.user.role]}</small>
              <button className="ghost" onClick={() => call('auth.logout').then(refresh)}>
                Se déconnecter
              </button>
            </div>
          </nav>
          <main className="content">
            {screen === 'pos' && <Pos user={state.user} hasRegister={Boolean(state.station?.register)} />}
            {screen === 'articles' && <Articles user={state.user} />}
            {screen === 'stock' && <Stock user={state.user} />}
            {screen === 'sales' && <Sales />}
            {screen === 'dashboard' && <Dashboard />}
            {screen === 'admin' && <Admin user={state.user} onChanged={refresh} />}
          </main>
        </div>
      )}
    </ToastProvider>
  );
}
