import { useState } from 'react';
import { type Result, call } from '../api';
import { Empty, Field, Modal, dateTime, fcfa, today, useLoad } from '../ui';

type Row = Result<'cashierControl.report'>[number];
type Kind = keyof Row['metrics'];

const LABELS: Record<Kind, string> = {
  cancellations: 'Tickets annulés',
  returns: 'Retours clients',
  returns_without_ticket: 'Retours sans ticket d’origine',
  discounts: 'Remises accordées',
  prices: 'Prix modifiés à la caisse',
  drawer: 'Tiroir ouvert sans vente',
  hidden: 'Factures supprimées du registre',
  shortage: 'Manquants de caisse',
};
const KINDS = Object.keys(LABELS) as Kind[];
/** Gestes comptés sans montant (journal de ce PC). */
const COUNT_ONLY: Kind[] = ['prices', 'drawer', 'hidden'];

const scoreTag = (score: number) => (score >= 60 ? 'rupture' : score >= 30 ? 'alerte' : 'normal');
const scoreText = (score: number) => (score >= 60 ? 'à vérifier' : score >= 30 ? 'à surveiller' : 'rien à signaler');

/**
 * Contrôle des caissiers : annulations, retours, remises, prix modifiés,
 * tiroir ouvert sans vente, factures supprimées et manquants de chaque
 * caissier sur la période, comparés à la moyenne de l'équipe.
 */
export function CashierControl() {
  const [from, setFrom] = useState(`${today().slice(0, 7)}-01`);
  const [to, setTo] = useState(today());
  const [open, setOpen] = useState<Row | null>(null);
  const report = useLoad(() => call('cashierControl.report', from, to), [from, to]);
  const rows = report.data ?? [];
  return (
    <div className="page">
      <header className="page-head">
        <h1>Contrôle des caissiers</h1>
        <span className="muted">Les gestes qui font perdre de l'argent quand ils sont abusés, caissier par caissier.</span>
      </header>
      <div className="filters">
        <Field label="Du">
          <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value || `${today().slice(0, 7)}-01`)} />
        </Field>
        <Field label="Au">
          <input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value || today())} />
        </Field>
      </div>
      <p className="muted">
        Chaque caissier est comparé à la moyenne de l'équipe, rapportée au nombre de tickets : les cases en rouge sont nettement au-dessus. Les ouvertures de tiroir, les
        prix modifiés et les factures supprimées sont ceux enregistrés sur ce PC. Une note élevée n'est pas une preuve : cliquez un caissier pour vérifier chaque geste.
      </p>
      {report.error ? <p className="neg">{report.error instanceof Error ? report.error.message : String(report.error)}</p> : null}
      {rows.length === 0 ? (
        <Empty>Aucune vente ni aucun geste à contrôler sur cette période.</Empty>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table className="list compact">
            <thead>
              <tr>
                <th>Caissier</th>
                <th className="r">Tickets</th>
                <th className="r">Ventes</th>
                {KINDS.map((k) => (
                  <th key={k} className="r">
                    {LABELS[k]}
                  </th>
                ))}
                <th>Note</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.user_id} className="clickable" onClick={() => setOpen(r)}>
                  <td>
                    <b>{r.name}</b>
                    <small className="muted block">{r.role}</small>
                  </td>
                  <td className="r">{r.tickets}</td>
                  <td className="r">{fcfa(r.sales)}</td>
                  {KINDS.map((k) => {
                    const m = r.metrics[k];
                    return (
                      <td key={k} className={`r ${r.flags.includes(k) ? 'flagged' : ''}`} title={r.flags.includes(k) ? 'Nettement au-dessus de la moyenne de l’équipe' : ''}>
                        {m.count ? (
                          <>
                            {m.count}
                            {!COUNT_ONLY.includes(k) && m.amount ? <small className="block">{fcfa(m.amount)}</small> : null}
                          </>
                        ) : (
                          ''
                        )}
                      </td>
                    );
                  })}
                  <td>
                    <span className={`tag ${scoreTag(r.score)}`} title={scoreText(r.score)}>
                      {r.score}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {open && <EventsDialog row={open} from={from} to={to} onClose={() => setOpen(null)} />}
    </div>
  );
}

function EventsDialog({ row, from, to, onClose }: { row: Row; from: string; to: string; onClose: () => void }) {
  const events = useLoad(() => call('cashierControl.events', row.user_id, from, to), [row.user_id, from, to]);
  const list = events.data ?? [];
  return (
    <Modal title={`Gestes de ${row.name}`} onClose={onClose} wide>
      <p className="muted">
        Note {row.score} sur 100 ({scoreText(row.score)}).
        {row.flags.length ? ` Au-dessus de la moyenne : ${row.flags.map((k) => LABELS[k].toLowerCase()).join(', ')}.` : ''}
      </p>
      {!events.data ? (
        <p className="muted">Chargement…</p>
      ) : list.length === 0 ? (
        <Empty>Aucun geste à vérifier sur cette période.</Empty>
      ) : (
        <table className="list compact">
          <thead>
            <tr>
              <th>Date</th>
              <th>Geste</th>
              <th>N°</th>
              <th className="r">Montant</th>
              <th>Détail</th>
            </tr>
          </thead>
          <tbody>
            {list.map((e, i) => (
              <tr key={i} className={row.flags.includes(e.kind) ? 'flagged' : ''}>
                <td>{dateTime(e.at)}</td>
                <td>{LABELS[e.kind]}</td>
                <td>{e.number ?? ''}</td>
                <td className="r">{e.amount ? fcfa(e.amount) : ''}</td>
                <td>{e.detail ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Modal>
  );
}
