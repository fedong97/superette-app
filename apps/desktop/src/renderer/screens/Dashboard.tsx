import { useState } from 'react';
import { call } from '../api';
import { Empty, fcfa, qty, today, useLoad } from '../ui';

export function Dashboard() {
  const [date, setDate] = useState(today());
  const day = useLoad(() => call('reports.daily', date), [date]);
  const alerts = useLoad(() => call('stock.list', { level: 'rupture' }), []);
  const lowStock = useLoad(() => call('stock.list', { level: 'alerte' }), []);
  const expiring = useLoad(() => call('stock.expiring', 3), []);
  const d = day.data;
  const maxHour = Math.max(1, ...(d?.byHour ?? []).map((h) => h.revenueTtc));
  return (
    <div className="page">
      <header className="page-head">
        <h1>Tableau de bord</h1>
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      </header>
      {d && (
        <div className="kpis">
          <div>
            <small>Chiffre d'affaires TTC</small>
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
            <small>Marge brute HT</small>
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
            <Empty>Aucune vente ce jour.</Empty>
          )}
        </section>
        <section className="card">
          <h3>Marge par rayon</h3>
          <table className="list compact">
            <tbody>
              {(d?.byDepartment ?? []).map((r) => (
                <tr key={r.department}>
                  <td>{r.department}</td>
                  <td className="r">{fcfa(r.revenueHt)} HT</td>
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
    </div>
  );
}
