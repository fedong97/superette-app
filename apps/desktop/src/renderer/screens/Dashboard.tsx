import { useState } from 'react';
import { type Result, call } from '../api';
import { Empty, Tabs, fcfa, qty, today, useCan, useLoad } from '../ui';
import { OwnerReport, PriceReview, TeamBoard } from './Floor';
import { MonthClear } from './MonthClear';
import { tx } from '../tax';
import { type WinKind } from '../nav';

export type DashboardTab = 'day' | 'attention' | 'month' | 'prices' | 'team' | 'owner';
type Item = Result<'attention.list'>[number];
/** Fenêtre et onglet qui traitent chaque point d'attention. */
export type AttentionTarget = ['stock' | 'treasury' | 'purchases' | 'customers' | 'production' | 'sales' | 'expenses', string];

const TARGET: Record<Item['key'], AttentionTarget> = {
  rupture: ['stock', 'critical'],
  alerte: ['stock', 'critical'],
  cash_gaps: ['treasury', 'history'],
  transfers: ['stock', 'transfer'],
  stock_requests: ['stock', 'monitoring'],
  rebates_pending: ['customers', 'rebates-state'],
  rebates_balance: ['customers', 'rebates-state'],
  inventories: ['stock', 'inventory'],
  supplier_invoices: ['purchases', 'due'],
  late_customers: ['customers', 'receivables'],
  production: ['production', 'orders'],
  cash_alerts: ['treasury', 'day'],
  to_notify: ['purchases', 'missed'],
  store_requests: ['stock', 'stores'],
  sale_edit_requests: ['sales', 'requests'],
  stock_anomalies: ['stock', 'anomalies'],
  expenses_pending: ['expenses', 'approval'],
  outages_open: ['sales', 'outages'],
};

/** Tableau de bord : la journée en chiffres, et les points d'attention du gérant. */
export function Dashboard({ initialTab = 'day', onOpen }: { initialTab?: DashboardTab; onOpen: (target: [WinKind, string?]) => void }) {
  const can = useCan();
  // Sans le tableau de bord, seuls les onglets permis (prix, équipe, rapport) restent.
  const first: DashboardTab = can('dashboard') ? 'day' : can('price_review') ? 'prices' : can('team_board') ? 'team' : 'owner';
  const [tab, setTab] = useState<DashboardTab>((initialTab === 'day' || initialTab === 'attention') && !can('dashboard') ? first : initialTab);
  return (
    <div className="page">
      <Tabs
        main
        value={tab}
        onChange={setTab}
        tabs={[
          ...(can('dashboard')
            ? ([
                ['day', 'La journée'],
                ['attention', "Points d'attention"],
              ] as [DashboardTab, string][])
            : []),
          ...(can('owner_report') || can('dashboard') ? ([['month', 'Mon mois en clair']] as [DashboardTab, string][]) : []),
          ...(can('price_review') ? ([['prices', 'Prix à revoir']] as [DashboardTab, string][]) : []),
          ...(can('team_board') ? ([['team', 'Équipe de la semaine']] as [DashboardTab, string][]) : []),
          ...(can('owner_report') ? ([['owner', 'Rapport du mois']] as [DashboardTab, string][]) : []),
        ]}
      />
      {tab === 'day' && can('dashboard') && <Day onOpen={onOpen} />}
      {tab === 'attention' && can('dashboard') && <Attention onOpen={onOpen} />}
      {tab === 'month' && (can('owner_report') || can('dashboard')) && <MonthClear onOpen={onOpen} />}
      {tab === 'prices' && can('price_review') && <PriceReview />}
      {tab === 'team' && can('team_board') && <TeamBoard />}
      {tab === 'owner' && can('owner_report') && <OwnerReport />}
    </div>
  );
}

function Attention({ onOpen }: { onOpen: (target: AttentionTarget) => void }) {
  const list = useLoad(() => call('attention.list'), []);
  const items = list.data ?? [];
  // Ce qui demande une action d'abord ; les points en ordre restent visibles, en retrait.
  const sorted = [...items.filter((i) => i.count > 0), ...items.filter((i) => i.count === 0)];
  return (
    <>
      <header className="page-head">
        <h1>Points d'attention</h1>
        <button onClick={list.reload}>Actualiser</button>
      </header>
      <p className="muted">Ce qui attend une action dans le magasin. Cliquez une tuile pour ouvrir la fenêtre qui la traite.</p>
      {list.data && (
        <div className="attention">
          {sorted.map((i) => (
            <button key={i.key} className={`tile ${i.count ? i.tone : 'calm'}`} onClick={() => onOpen(TARGET[i.key])}>
              <span className="tile-count">{i.count}</span>
              <span className="tile-label">{i.label}</span>
              {i.amount ? <strong>{fcfa(i.amount)}</strong> : null}
              <small>{i.detail}</small>
            </button>
          ))}
        </div>
      )}
    </>
  );
}

/** Variation d'un chiffre par rapport à la veille : ↑ 12,4 %, ↓ 3 %, ou = s'il n'y a rien à comparer. */
function Trend({ now, before }: { now: number; before: number | undefined }) {
  if (!before) return <span className="stat-trend flat">— vs hier</span>;
  const pct = ((now - before) / Math.abs(before)) * 100;
  const tone = Math.abs(pct) < 0.5 ? 'flat' : pct > 0 ? 'up' : 'down';
  return (
    <span className={`stat-trend ${tone}`} title="Par rapport à la veille">
      {tone === 'up' ? '↑' : tone === 'down' ? '↓' : '='} {Math.abs(pct).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} % vs hier
    </span>
  );
}

const dayBefore = (date: string) => {
  const d = new Date(`${date}T12:00:00`);
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
};

function Day({ onOpen }: { onOpen: (target: [WinKind, string?]) => void }) {
  const can = useCan();
  const [date, setDate] = useState(today());
  const day = useLoad(() => call('reports.daily', date), [date]);
  const prev = useLoad(() => call('reports.daily', dayBefore(date)), [date]);
  const alerts = useLoad(() => call('stock.list', { level: 'rupture' }), []);
  const lowStock = useLoad(() => call('stock.list', { level: 'alerte' }), []);
  const expiring = useLoad(() => call('stock.expiring', 3), []);
  const d = day.data;
  const p = prev.data;
  const hours = d?.byHour ?? [];
  const maxHour = Math.max(1, ...hours.map((h) => h.revenueTtc));
  const maxDept = Math.max(1, ...(d?.byDepartment ?? []).map((r) => r.revenueHt));
  const rate = d?.revenueHt ? Math.round((d.grossMargin / d.revenueHt) * 100) : null;
  const actions: [string, [WinKind, string?], boolean][] = [
    ['Nouvelle vente', ['cash1'], can('cash')],
    ['Nouvelle dépense', ['expenses', 'new'], can('expense_record')],
    ['Réception', ['stock', 'receive'], can('stock_receive')],
    ['Inventaire', ['stock', 'inventory'], can('inventory')],
  ];
  const watch: [number | undefined, string, string, AttentionTarget][] = [
    [alerts.data?.length, 'rupture', 'article(s) en rupture', ['stock', 'critical']],
    [lowStock.data?.length, 'alerte', "article(s) sous le seuil d'alerte", ['stock', 'critical']],
    [expiring.data?.length, 'alerte', 'lot(s) périmant sous 3 jours', ['stock', 'critical']],
  ];
  return (
    <>
      <header className="dash-head">
        <div>
          <h1>Tableau de bord</h1>
          <p>{new Date(`${date}T12:00:00`).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</p>
        </div>
        <div className="dash-actions">
          {actions
            .filter(([, , ok]) => ok)
            .map(([label, target], i) => (
              <button key={label} className={i === 0 ? 'primary' : ''} onClick={() => onOpen(target)}>
                + {label}
              </button>
            ))}
        </div>
        <input type="date" aria-label="Jour affiché" value={date} onChange={(e) => setDate(e.target.value)} />
      </header>
      {d ? (
        <div className="kpis">
          <div>
            <small>{tx("Chiffre d'affaires TTC")}</small>
            <strong>{fcfa(d.revenueTtc)}</strong>
            <Trend now={d.revenueTtc} before={p?.revenueTtc} />
          </div>
          <div>
            <small>Tickets</small>
            <strong>{d.ticketCount}</strong>
            <Trend now={d.ticketCount} before={p?.ticketCount} />
          </div>
          <div>
            <small>Panier moyen</small>
            <strong>{fcfa(d.averageBasket)}</strong>
            <Trend now={d.averageBasket} before={p?.averageBasket} />
          </div>
          <div>
            <small>{tx('Marge brute HT')}</small>
            <strong>{fcfa(d.grossMargin)}</strong>
            <span className="stat-trend flat">{rate === null ? 'taux —' : `taux ${rate} %`}</span>
          </div>
        </div>
      ) : (
        <div className="kpis" aria-busy="true" aria-label="Chargement des chiffres">
          {[0, 1, 2, 3].map((i) => (
            <div key={i}>
              <span className="skeleton" style={{ width: '50%' }} />
              <span className="skeleton" style={{ width: '80%', height: 22 }} />
            </div>
          ))}
        </div>
      )}
      <div className="dash-grid">
        <section className="card">
          <div className="card-head">
            <h3>Ventes par heure</h3>
            {hours.length > 0 && <small>{d!.ticketCount} tickets</small>}
          </div>
          {hours.length ? (
            <>
              <div className="hcols" role="img" aria-label="Chiffre d'affaires par heure">
                {hours.map((h) => (
                  <div key={h.hour} title={`${String(h.hour).padStart(2, '0')} h : ${fcfa(h.revenueTtc)} · ${h.tickets} ticket(s)`}>
                    <i style={{ height: `${Math.max(2, (h.revenueTtc / maxHour) * 100)}%` }} />
                  </div>
                ))}
              </div>
              <div className="hcols-x">
                {hours.map((h) => (
                  <span key={h.hour}>{String(h.hour).padStart(2, '0')} h</span>
                ))}
              </div>
            </>
          ) : (
            <Empty>Aucune vente ce jour pour l’instant. Les chiffres s’affichent ici dès le premier ticket validé à la caisse.</Empty>
          )}
        </section>
        <section className="card">
          <div className="card-head">
            <h3>À surveiller</h3>
          </div>
          <ul className="watch-list">
            {watch.map(([n, tone, label, target]) => (
              <li key={label}>
                <button onClick={() => onOpen(target)}>
                  <span className={`tag num ${n ? tone : 'normal'}`}>{n ?? '…'}</span>
                  {label}
                  <span className="go" aria-hidden>
                    ›
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
        <section className="card">
          <div className="card-head">
            <h3>Meilleures ventes</h3>
            <small>quantité · {tx('CA TTC')}</small>
          </div>
          {d?.topArticles.length ? (
            <table className="list compact">
              <tbody>
                {d.topArticles.map((a, i) => (
                  <tr key={a.name}>
                    <td>
                      <span className="rank">{i + 1}</span>
                      {a.name}
                    </td>
                    <td className="r">{qty(a.qty)}</td>
                    <td className="r">{fcfa(a.revenueTtc)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="muted">Les produits les plus vendus du jour s’afficheront ici.</p>
          )}
        </section>
        <section className="card">
          <div className="card-head">
            <h3>Marge par rayon</h3>
            <small>{tx('CA HT')} · marge</small>
          </div>
          {d?.byDepartment.length ? (
            <div className="hbars">
              {d.byDepartment.map((r) => (
                <div key={r.department} className="hbar">
                  <span>{r.department}</span>
                  <span className="muted">
                    {fcfa(r.revenueHt)} · <b>{fcfa(r.margin)}</b>
                  </span>
                  <div>
                    <i style={{ width: `${(r.revenueHt / maxDept) * 100}%` }} />
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="muted">Rangez les produits par rayon pour voir où se fait la marge.</p>
          )}
        </section>
      </div>
    </>
  );
}
