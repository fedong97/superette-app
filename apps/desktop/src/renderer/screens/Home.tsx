import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from 'react';
import { type Result, call } from '../api';
import { Modal, fcfa, findIn, openScreen, qty, useCan, useLoad } from '../ui';
import { tx } from '../tax';
import { ATTENTION_TARGET } from './Dashboard';
import { DayTasks } from './Floor';

type Overview = Result<'home.overview'>;
type Figures = NonNullable<Overview['today']>;
type Till = Overview['registers'][number];
type Activity = Overview['activity'][number];

/** Rafraîchissement de l'accueil : les ventes des autres caisses arrivent par le serveur central. */
const REFRESH_MS = 30_000;

/** Blocs de l'accueil, dans l'ordre d'affichage ; le gérant masque ceux qui ne lui servent pas. */
export const HOME_BLOCKS = [
  ['figures', 'Chiffres du jour'],
  ['tills', 'Caisses en direct'],
  ['attention', "Points d'attention"],
  ['hours', 'Ventes heure par heure'],
  ['activity', 'Activité en direct'],
  ['top', 'Meilleures ventes et stock critique'],
  ['mine', 'Ma caisse et mes factures'],
  ['tasks', 'Tâches du jour'],
] as const;
export type HomeBlock = (typeof HOME_BLOCKS)[number][0];

const hiddenKey = (userId: string) => `onix.accueil.masques.${userId}`;
function loadHidden(userId: string): Set<HomeBlock> {
  try {
    return new Set(JSON.parse(localStorage.getItem(hiddenKey(userId)) ?? '[]') as HomeBlock[]);
  } catch {
    return new Set();
  }
}
function saveHidden(userId: string, hidden: Set<HomeBlock>) {
  try {
    localStorage.setItem(hiddenKey(userId), JSON.stringify([...hidden]));
  } catch {
    // Préférence de confort : sans stockage, tous les blocs restent affichés.
  }
}

const reducedMotion = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** Chiffre qui défile jusqu'à sa valeur (à l'ouverture et à chaque changement). */
function useCountUp(value: number, ms = 700): number {
  const [shown, setShown] = useState(reducedMotion() ? value : 0);
  const from = useRef(shown);
  useEffect(() => {
    if (reducedMotion()) return setShown(value);
    const start = performance.now();
    const origin = from.current;
    let frame = 0;
    const step = (t: number) => {
      const k = Math.min(1, (t - start) / ms);
      const eased = 1 - (1 - k) ** 3;
      const v = Math.round(origin + (value - origin) * eased);
      from.current = v;
      setShown(v);
      if (k < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [value]);
  return shown;
}

function CountUp({ value, money = true }: { value: number; money?: boolean }) {
  const v = useCountUp(value);
  return <>{money ? fcfa(v) : v.toLocaleString('fr-FR')}</>;
}

/** Variation par rapport à la veille à la même heure. */
function Versus({ now, before }: { now: number; before: number | undefined }) {
  if (!before) return <span className="stat-trend flat">— vs hier</span>;
  const pct = ((now - before) / Math.abs(before)) * 100;
  const tone = Math.abs(pct) < 0.5 ? 'flat' : pct > 0 ? 'up' : 'down';
  return (
    <span className={`stat-trend ${tone}`} title="Par rapport à hier à la même heure">
      {tone === 'up' ? '↑' : tone === 'down' ? '↓' : '='} {Math.abs(pct).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} % vs hier
    </span>
  );
}

const hour = (iso: string) => new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });

/** Bloc de l'accueil : titre, lien « Tout voir » et entrée en cascade. */
function Block({ index, title, more, children, className = '' }: { index: number; title: string; more?: [string, () => void]; children: ReactNode; className?: string }) {
  return (
    <section className={`home-block ${className}`} style={{ '--i': index } as CSSProperties}>
      <div className="home-block-head">
        <h2>{title}</h2>
        {more && (
          <button type="button" className="link" onClick={more[1]}>
            {more[0]} ›
          </button>
        )}
      </div>
      {children}
    </section>
  );
}

// --- Chiffres du jour --------------------------------------------------------------

function DayFigures({ today, yesterday, cashInDrawer, showCash }: { today: Figures; yesterday: Figures | null; cashInDrawer: number; showCash: boolean }) {
  const rate = today.revenueHt ? Math.round((today.margin / today.revenueHt) * 100) : null;
  const go = () => openScreen('dashboard', 'day');
  const tiles: [string, ReactNode, ReactNode, () => void][] = [
    [tx("Chiffre d'affaires TTC"), <CountUp value={today.revenue} />, <Versus now={today.revenue} before={yesterday?.revenue} />, go],
    ['Tickets', <CountUp value={today.tickets} money={false} />, <Versus now={today.tickets} before={yesterday?.tickets} />, go],
    ['Panier moyen', <CountUp value={today.average} />, <Versus now={today.average} before={yesterday?.average} />, go],
    [tx('Marge brute HT'), <CountUp value={today.margin} />, <span className="stat-trend flat">{rate === null ? 'taux —' : `taux ${rate} %`}</span>, go],
    ['Règlements clients', <CountUp value={today.receipts} />, <Versus now={today.receipts} before={yesterday?.receipts} />, () => openScreen('customers', 'payments')],
  ];
  if (showCash) tiles.push(['Espèces en caisse', <CountUp value={cashInDrawer} />, <span className="stat-trend flat">caisses ouvertes</span>, () => openScreen('treasury', 'live')]);
  return (
    <div className="home-kpis">
      {tiles.map(([label, value, trend, open]) => (
        <button key={label} type="button" onClick={open}>
          <small>{label}</small>
          <strong>{value}</strong>
          {trend}
        </button>
      ))}
    </div>
  );
}

// --- Caisses en direct (compact) -----------------------------------------------------------

/** Une carte par caisse : point vert qui pulse si elle est ouverte ; un clic l'ouvre dans les Caisses en direct. */
export function TillsStrip({ registers }: { registers: Till[] }) {
  if (!registers.length) return <p className="muted">Aucune caisse : créez-en dans Administration › Caisses.</p>;
  const open = (id: string) => {
    findIn('live', id);
    openScreen('treasury', 'live');
  };
  return (
    <div className="tills-strip">
      {registers.map((r) => (
        <button key={r.id} type="button" className={`till-mini ${r.status}`} onClick={() => open(r.id)} title="Voir cette caisse dans les Caisses en direct">
          <span className="till-mini-head">
            <i className={`live-dot ${r.status === 'open' ? (r.stale ? 'stale' : 'on') : ''}`} aria-hidden />
            <b>{r.name}</b>
          </span>
          <small>
            {r.status === 'open' ? (r.stale ? 'Ouverte un autre jour' : (r.cashier ?? 'Ouverte')) : r.status === 'closed' ? 'Fermée' : 'Jamais ouverte'}
          </small>
          {r.session && r.status === 'open' && (
            <span className="till-mini-figures">
              <span>
                {fcfa(r.net)} <small>· {r.tickets} ticket{r.tickets > 1 ? 's' : ''}</small>
              </span>
              {r.kind === 'cash' && r.expected !== null && <small>Attendu {fcfa(r.expected)}</small>}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

/** Caisses en direct en haut de Tableau de bord › La journée, rafraîchies seules. */
export function DashboardTills() {
  const live = useLoad(() => call('treasury.live'), []);
  useEffect(() => {
    const t = setInterval(live.reload, REFRESH_MS);
    return () => clearInterval(t);
  }, []);
  if (!live.data) return null;
  return (
    <section className="card dash-tills">
      <div className="card-head">
        <h3>Caisses en direct</h3>
        <button type="button" className="link" onClick={() => openScreen('treasury', 'live')}>
          Tout voir ›
        </button>
      </div>
      <TillsStrip registers={live.data.registers} />
    </section>
  );
}

// --- Ventes heure par heure --------------------------------------------------------------

function HourChart({ today, yesterday }: { today: Figures['byHour']; yesterday: Figures['byHour'] }) {
  const hours = [...today, ...yesterday].map((h) => h.hour);
  if (!hours.length) return <p className="muted">Aucune vente pour l'instant : le graphique se remplit dès le premier ticket.</p>;
  // Toute la journée du magasin (7 h à 20 h au moins), pour que la première heure ne remplisse pas le graphique.
  const from = Math.min(7, ...hours);
  const to = Math.max(20, new Date().getHours(), ...hours);
  const max = Math.max(1, ...today.map((h) => h.revenueTtc), ...yesterday.map((h) => h.revenueTtc));
  const at = (list: Figures['byHour'], h: number) => list.find((x) => x.hour === h);
  const slots = Array.from({ length: to - from + 1 }, (_, i) => from + i);
  return (
    <>
      <div className="home-hours" role="img" aria-label="Ventes par heure, aujourd'hui et hier">
        {slots.map((h) => {
          const t = at(today, h);
          const y = at(yesterday, h);
          return (
            <div key={h} title={`${String(h).padStart(2, '0')} h : ${fcfa(t?.revenueTtc ?? 0)} aujourd'hui · ${fcfa(y?.revenueTtc ?? 0)} hier`}>
              <i className="yday" style={{ height: `${((y?.revenueTtc ?? 0) / max) * 100}%` }} />
              <i className="now" style={{ height: `${((t?.revenueTtc ?? 0) / max) * 100}%` }} />
            </div>
          );
        })}
      </div>
      <div className="home-hours-x">
        {slots.map((h) => (
          <span key={h}>{String(h).padStart(2, '0')}h</span>
        ))}
      </div>
      <p className="home-legend">
        <i className="now" /> Aujourd'hui <i className="yday" /> Hier
      </p>
    </>
  );
}

// --- Activité en direct -------------------------------------------------------------------

const ACTIVITY: Record<Activity['type'], { label: string; sign: 1 | -1 | 0; open: () => void }> = {
  sale: { label: 'Vente', sign: 1, open: () => openScreen('sales', 'find') },
  return: { label: 'Retour', sign: -1, open: () => openScreen('sales', 'find') },
  cancelled: { label: 'Vente annulée', sign: 1, open: () => openScreen('sales', 'find') },
  receipt: { label: 'Règlement client', sign: 1, open: () => openScreen('customers', 'payments') },
  supplier_payment: { label: 'Paiement fournisseur', sign: -1, open: () => openScreen('purchases', 'invoices') },
  cash_in: { label: 'Entrée de caisse', sign: 1, open: () => openScreen('treasury', 'day') },
  cash_out: { label: 'Sortie de caisse', sign: -1, open: () => openScreen('treasury', 'day') },
  expense: { label: 'Dépense', sign: -1, open: () => openScreen('expenses', 'list') },
  reception: { label: 'Réception', sign: 0, open: () => openScreen('purchases', 'receptions') },
};

function ActivityFeed({ items }: { items: Activity[] }) {
  if (!items.length) return <p className="muted">Aucune opération pour l'instant.</p>;
  return (
    <ul className="home-feed">
      {items.map((a) => {
        const k = ACTIVITY[a.type];
        const open = () => {
          // La facture retrouvée par son numéro dans le registre des ventes.
          if ((a.type === 'sale' || a.type === 'return' || a.type === 'cancelled') && a.number) findIn('sales', a.number);
          k.open();
        };
        return (
          <li key={`${a.type}-${a.id}`}>
            <button type="button" onClick={open}>
              <span className={`feed-kind ${a.type}`}>{k.label}</span>
              <span className="feed-what">
                {a.number && <b>{a.number}</b>} {a.label ?? a.party ?? ''}
                <small>
                  {hour(a.at)}
                  {a.register ? ` · ${a.register}` : ''}
                  {a.who ? ` · ${a.who}` : ''}
                </small>
              </span>
              <span className={`feed-amount ${a.type === 'cancelled' ? 'void' : k.sign < 0 ? 'out' : k.sign > 0 ? 'in' : ''}`}>
                {k.sign < 0 ? '− ' : k.sign > 0 ? '+ ' : ''}
                {fcfa(a.amount)}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

// --- Meilleures ventes et stock critique -------------------------------------------------------

const findArticle = (name: string) => {
  findIn('articles', name);
  openScreen('articles', 'list');
};

function TopAndStock({ top, stock }: { top: Figures['top']; stock: Overview['stock'] }) {
  return (
    <div className="home-two">
      <div>
        <h3>Meilleures ventes du jour</h3>
        {top.length ? (
          <ol className="home-rank">
            {top.map((a) => (
              <li key={a.name}>
                <button type="button" className="link" onClick={() => findArticle(a.name)}>
                  {a.name}
                </button>
                <small>
                  {qty(a.qty)} · {fcfa(a.revenueTtc)}
                </small>
              </li>
            ))}
          </ol>
        ) : (
          <p className="muted">Pas encore de vente aujourd'hui.</p>
        )}
      </div>
      {stock && (
        <div>
          <h3>
            Stock critique{' '}
            <button type="button" className="link" onClick={() => openScreen('stock', 'critical')}>
              {stock.rupture.count} en rupture · {stock.alerte.count} en alerte ›
            </button>
          </h3>
          {stock.rupture.items.length + stock.alerte.items.length ? (
            <ul className="home-rank">
              {[...stock.rupture.items.map((i) => ['rupture', i] as const), ...stock.alerte.items.map((i) => ['alerte', i] as const)].slice(0, 6).map(([level, i]) => (
                <li key={i.id}>
                  <button type="button" className="link" onClick={() => findArticle(i.name)}>
                    {i.name}
                  </button>
                  <span className={`tag ${level}`}>{level === 'rupture' ? 'Rupture' : `Reste ${qty(i.qty)}`}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">Aucun article en rupture ni sous le seuil d'alerte.</p>
          )}
        </div>
      )}
    </div>
  );
}

// --- Ma caisse et mes factures (vendeur, caissier) -------------------------------------------------

function MyTill({ mine, sent }: { mine: Overview['mine']; sent: Overview['sent'] }) {
  return (
    <div className="home-mine">
      {mine && (
        <button type="button" className={`till-mini ${mine.status}`} onClick={() => openScreen('treasury', 'day')}>
          <span className="till-mini-head">
            <i className={`live-dot ${mine.status === 'open' ? (mine.stale ? 'stale' : 'on') : ''}`} aria-hidden />
            <b>{mine.name}</b>
          </span>
          <small>
            {mine.status === 'open'
              ? mine.stale
                ? 'Ouverte un autre jour : à clôturer'
                : `Ouverte à ${hour(mine.session!.opened_at)}`
              : mine.status === 'closed'
                ? 'Fermée'
                : 'Pas encore ouverte'}
          </small>
          {mine.status === 'open' && (
            <span className="till-mini-figures">
              <span>
                {fcfa(mine.net)} <small>· {mine.tickets} ticket{mine.tickets > 1 ? 's' : ''}</small>
              </span>
              {mine.kind === 'cash' && mine.expected !== null && <small>Attendu dans le tiroir {fcfa(mine.expected)}</small>}
            </span>
          )}
        </button>
      )}
      {sent && (
        <button type="button" className="home-sent" onClick={() => openScreen('sales', 'tickets')}>
          <b>Mes factures envoyées</b>
          <span>
            <strong>{sent.waiting}</strong> en attente à la caisse
          </span>
          {sent.returned > 0 && (
            <span className="warn-text">
              <strong>{sent.returned}</strong> renvoyée{sent.returned > 1 ? 's' : ''} par la caisse
            </span>
          )}
          <span>
            <strong>{sent.paid}</strong> encaissée{sent.paid > 1 ? 's' : ''}
          </span>
        </button>
      )}
    </div>
  );
}

// --- Accueil -----------------------------------------------------------------------------

/**
 * Accueil (0.103.0) : « Mon magasin maintenant » pour le gérant (chiffres du jour
 * comparés à hier à la même heure, caisses en direct, points d'attention, ventes
 * par heure, activité, meilleures ventes et stock critique), « Ma caisse et mes
 * factures » pour le vendeur et le caissier. Chaque élément ouvre l'écran qui le traite.
 */
export function HomeOverview({ userId, myDay }: { userId: string; myDay: ReactNode }) {
  const can = useCan();
  const data = useLoad(() => call('home.overview'), []);
  const [hidden, setHidden] = useState(() => loadHidden(userId));
  const [custom, setCustom] = useState(false);
  useEffect(() => {
    const t = setInterval(data.reload, REFRESH_MS);
    return () => clearInterval(t);
  }, []);
  const d = data.data;
  if (!d) return myDay ? <>{myDay}</> : null;
  const available: HomeBlock[] = [
    ...(d.today ? (['figures'] as const) : []),
    ...(d.canLive || d.today ? (['tills'] as const) : []),
    ...(d.today ? (['attention', 'hours', 'activity', 'top'] as const) : []),
    ...(d.mine || d.sent ? (['mine'] as const) : []),
    ...(can('day_tasks') ? (['tasks'] as const) : []),
  ];
  const show = (b: HomeBlock) => available.includes(b) && !hidden.has(b);
  let i = 0;
  const toggle = (b: HomeBlock, on: boolean) => {
    const next = new Set(hidden);
    if (on) next.delete(b);
    else next.add(b);
    setHidden(next);
    saveHidden(userId, next);
  };
  return (
    <>
      {!d.today && myDay}
      {show('figures') && d.today && (
        <Block index={i++} title="Mon magasin maintenant" more={['Tableau de bord', () => openScreen('dashboard', 'day')]}>
          <DayFigures today={d.today} yesterday={d.yesterday} cashInDrawer={d.cashInDrawer} showCash={d.registers.length > 0} />
        </Block>
      )}
      {show('tills') && (
        <Block index={i++} title="Caisses en direct" more={['Tout voir', () => openScreen('treasury', 'live')]}>
          <TillsStrip registers={d.registers} />
        </Block>
      )}
      {show('attention') && d.attention.length > 0 && (
        <Block index={i++} title="Points d'attention" more={['Tout voir', () => openScreen('dashboard', 'attention')]}>
          <div className="home-pills">
            {d.attention.map((a) => (
              <button key={a.key} type="button" className={`home-pill ${a.tone}`} onClick={() => openScreen(...ATTENTION_TARGET[a.key])} title={a.detail}>
                <b>{a.count}</b>
                <span>{a.label}</span>
                {a.amount ? <small>{fcfa(a.amount)}</small> : null}
                <em>Traiter ›</em>
              </button>
            ))}
          </div>
        </Block>
      )}
      {(show('hours') || show('activity')) && d.today && (
        <div className="home-grid">
          {show('hours') && (
            <Block index={i++} title="Ventes heure par heure" more={['Détail', () => openScreen('dashboard', 'day')]}>
              <HourChart today={d.today.byHour} yesterday={d.yesterday?.byHour ?? []} />
            </Block>
          )}
          {show('activity') && (
            <Block index={i++} title="Activité en direct" className="home-activity">
              <ActivityFeed items={d.activity} />
            </Block>
          )}
        </div>
      )}
      {show('top') && d.today && (
        <Block index={i++} title="Articles du jour" more={['Rapports', () => openScreen('reports')]}>
          <TopAndStock top={d.today.top} stock={d.stock} />
        </Block>
      )}
      {show('mine') && (
        <Block index={i++} title="Ma caisse et mes factures">
          <MyTill mine={d.mine} sent={d.sent} />
        </Block>
      )}
      {show('tasks') && <DayTasks compact />}
      {available.length > 1 && (
        <p className="home-custom">
          <span className="muted small">Mis à jour à {hour(d.at)}</span>
          <button type="button" className="link" onClick={() => setCustom(true)}>
            Personnaliser l'accueil
          </button>
        </p>
      )}
      {custom && (
        <Modal title="Personnaliser l'accueil" onClose={() => setCustom(false)}>
          <p className="muted">Choisissez les blocs affichés sur votre page d'accueil. Ce choix est gardé sur ce PC.</p>
          <div className="home-custom-list">
            {HOME_BLOCKS.filter(([b]) => available.includes(b)).map(([b, label]) => (
              <label key={b}>
                <input type="checkbox" checked={!hidden.has(b)} onChange={(e) => toggle(b, e.target.checked)} /> {label}
              </label>
            ))}
          </div>
          <div className="actions">
            <button type="button" className="primary" onClick={() => setCustom(false)}>
              Fermer
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
