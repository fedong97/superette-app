import { useState } from 'react';
import { type Result, call } from '../api';
import { Empty, Tabs, fcfa, qty, today, useCan, useLoad } from '../ui';
import { OwnerReport, PriceReview, TeamBoard } from './Floor';
import { tx } from '../tax';

export type DashboardTab = 'day' | 'attention' | 'prices' | 'team' | 'owner';
type Item = Result<'attention.list'>[number];
/** Fenêtre et onglet qui traitent chaque point d'attention. */
export type AttentionTarget = ['stock' | 'treasury' | 'purchases' | 'customers' | 'production' | 'sales', string];

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
};

/** Tableau de bord : la journée en chiffres, et les points d'attention du gérant. */
export function Dashboard({ initialTab = 'day', onOpen }: { initialTab?: DashboardTab; onOpen: (target: AttentionTarget) => void }) {
  const can = useCan();
  // Sans le tableau de bord, seuls les onglets permis (prix, équipe, rapport) restent.
  const first: DashboardTab = can('dashboard') ? 'day' : can('price_review') ? 'prices' : can('team_board') ? 'team' : 'owner';
  const [tab, setTab] = useState<DashboardTab>((initialTab === 'day' || initialTab === 'attention') && !can('dashboard') ? first : initialTab);
  return (
    <div className="page">
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          ...(can('dashboard')
            ? ([
                ['day', 'La journée'],
                ['attention', "Points d'attention"],
              ] as [DashboardTab, string][])
            : []),
          ...(can('price_review') ? ([['prices', 'Prix à revoir']] as [DashboardTab, string][]) : []),
          ...(can('team_board') ? ([['team', 'Équipe de la semaine']] as [DashboardTab, string][]) : []),
          ...(can('owner_report') ? ([['owner', 'Rapport du mois']] as [DashboardTab, string][]) : []),
        ]}
      />
      {tab === 'day' && can('dashboard') && <Day />}
      {tab === 'attention' && can('dashboard') && <Attention onOpen={onOpen} />}
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

function Day() {
  const [date, setDate] = useState(today());
  const day = useLoad(() => call('reports.daily', date), [date]);
  const alerts = useLoad(() => call('stock.list', { level: 'rupture' }), []);
  const lowStock = useLoad(() => call('stock.list', { level: 'alerte' }), []);
  const expiring = useLoad(() => call('stock.expiring', 3), []);
  const d = day.data;
  const maxHour = Math.max(1, ...(d?.byHour ?? []).map((h) => h.revenueTtc));
  return (
    <>
      <header className="page-head">
        <h1>Tableau de bord</h1>
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      </header>
      {d && (
        <div className="kpis">
          <div>
            <small>{tx("Chiffre d'affaires TTC")}</small>
            <strong>{fcfa(d.revenueTtc)}</strong>
          </div>
          <div>
            <small>Tickets</small>
            <strong>{d.ticketCount}</strong>
          </div>
          <div>
            <small>Panier moyen</small>
            <strong>{fcfa(d.averageBasket)}</strong>
          </div>
          <div>
            <small>{tx('Marge brute HT')}</small>
            <strong>{fcfa(d.grossMargin)}</strong>
            <small>{d.revenueHt ? `${Math.round((d.grossMargin / d.revenueHt) * 100)} %` : ''}</small>
          </div>
        </div>
      )}
      <div className="grid2">
        <section className="card">
          <h3>Ventes par heure</h3>
          {d?.byHour.length ? (
            <div className="bars">
              {d.byHour.map((h) => (
                <div key={h.hour} className="bar-row">
                  <span>{String(h.hour).padStart(2, '0')} h</span>
                  <div className="bar" style={{ width: `${(h.revenueTtc / maxHour) * 100}%` }} />
                  <span>{fcfa(h.revenueTtc)}</span>
                </div>
              ))}
            </div>
          ) : (
            <Empty>Aucune vente ce jour pour l’instant. Les chiffres s’affichent ici dès le premier ticket validé à la caisse.</Empty>
          )}
        </section>
        <section className="card">
          <h3>Marge par rayon</h3>
          <table className="list compact">
            <tbody>
              {(d?.byDepartment ?? []).map((r) => (
                <tr key={r.department}>
                  <td>{r.department}</td>
                  <td className="r">{fcfa(r.revenueHt)}{tx(' HT')}</td>
                  <td className="r">{fcfa(r.margin)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
        <section className="card">
          <h3>Meilleures ventes</h3>
          <table className="list compact">
            <tbody>
              {(d?.topArticles ?? []).map((a) => (
                <tr key={a.name}>
                  <td>{a.name}</td>
                  <td className="r">{qty(a.qty)}</td>
                  <td className="r">{fcfa(a.revenueTtc)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
        <section className="card">
          <h3>À surveiller</h3>
          <ul className="watch">
            <li>
              <span className="tag rupture">{alerts.data?.length ?? 0}</span> article(s) en rupture
            </li>
            <li>
              <span className="tag alerte">{lowStock.data?.length ?? 0}</span> article(s) sous le seuil d'alerte
            </li>
            <li>
              <span className="tag alerte">{expiring.data?.length ?? 0}</span> lot(s) périmant sous 3 jours
            </li>
          </ul>
        </section>
      </div>
    </>
  );
}
