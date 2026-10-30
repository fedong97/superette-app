import { useState } from 'react';
import { call } from '../api';
import { Empty, dateTime, fcfa, useLoad } from '../ui';
import { BookPrintButtons } from './outageBook';

const STATUS = { open: 'En cours de saisie', closed: 'Clôturée', cancelled: 'Annulée' } as const;
const TAG = { open: 'alerte', closed: 'normal', cancelled: '' } as const;

/** Coupures déclarées : total du cahier, ventes saisies, écart et son motif. */
export function Outages() {
  const [status, setStatus] = useState<'' | 'open' | 'closed' | 'cancelled'>('');
  const list = useLoad(() => call('outages.list', status || null), [status]);
  const rows = list.data ?? [];
  return (
    <>
      <div className="filters">
        <select value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
          <option value="">Toutes les coupures</option>
          <option value="open">En cours de saisie</option>
          <option value="closed">Clôturées</option>
          <option value="cancelled">Annulées</option>
        </select>
        <span className="muted">Les ventes d'une coupure se saisissent à la caisse (bouton « Coupure »), à la main ou en photographiant les pages du carnet ONIX.</span>
        <BookPrintButtons />
      </div>
      {rows.length === 0 ? (
        <Empty>Aucune coupure déclarée.</Empty>
      ) : (
        <table className="list compact">
          <thead>
            <tr>
              <th>N°</th>
              <th>Caisse</th>
              <th>Du</th>
              <th>Au</th>
              <th className="r">Cahier</th>
              <th className="r">Saisi</th>
              <th className="r">Écart</th>
              <th>Motif de l'écart</th>
              <th>État</th>
              <th>Par</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((o) => (
              <tr key={o.id}>
                <td>{o.number}</td>
                <td>{o.register_name ?? ''}</td>
                <td>{dateTime(o.started_at)}</td>
                <td>{dateTime(o.ended_at)}</td>
                <td className="r">{fcfa(o.declared_total)}</td>
                <td className="r">
                  {fcfa(o.entered_total)} <span className="muted">({o.sales})</span>
                  {o.pages > 0 && <div className="muted small">{o.pages} page(s) du carnet en photo</div>}
                </td>
                <td className={`r ${o.gap ? 'neg' : ''}`}>{fcfa(o.gap)}</td>
                <td>{o.gap_reason ?? ''}</td>
                <td>
                  <span className={`tag ${TAG[o.status]}`}>{STATUS[o.status]}</span>
                </td>
                <td>
                  {o.user_name ?? ''}
                  {o.closed_by_name && o.closed_by_name !== o.user_name ? ` · clôturée par ${o.closed_by_name}` : ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
