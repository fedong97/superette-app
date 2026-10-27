import { useRef, useState } from 'react';
import { type Result, call } from '../api';
import { Empty, Field, Tabs, askText, dateTime, fcfa, today, useCan, useLoad, useToast } from '../ui';

type Ticket = Result<'exit.lookup'>;
export type ExitTab = 'door' | 'report';

const VERDICT = {
  ok: ['Ticket valable : vérifiez les articles du sac', 'exit-ok'],
  warn: ['Attention : vérifiez avant de laisser sortir', 'exit-warn'],
  stop: ['Le client ne sort pas avec ce ticket', 'exit-stop'],
} as const;

/** Contrôle à la sortie : la porte (le vigile scanne) et le rapport du gérant. */
export function ExitChecks({ initialTab = 'door' }: { initialTab?: ExitTab }) {
  const can = useCan();
  const tabs = ([
    ['door', 'Contrôle à la porte'],
    ['report', 'Rapport des contrôles'],
  ] as [ExitTab, string][]).filter(([t]) => (t === 'door' ? can('exit_check') : can('exit_report')));
  const [tab, setTab] = useState<ExitTab>(tabs.some(([t]) => t === initialTab) ? initialTab : (tabs[0]?.[0] ?? 'door'));
  return (
    <div className="page">
      <header className="page-head">
        <h1>Contrôle à la sortie</h1>
      </header>
      <Tabs value={tab} onChange={setTab} tabs={tabs} />
      {!tabs.length && <Empty>Vous n'avez pas accès au contrôle à la sortie.</Empty>}
      {tab === 'door' && can('exit_check') && <Door />}
      {tab === 'report' && can('exit_report') && <ExitReport />}
    </div>
  );
}

/** PC posé à la porte (douchette) : scan du ticket, articles payés en grand, OK ou problème. */
function Door() {
  const toast = useToast();
  const [code, setCode] = useState('');
  const [ticket, setTicket] = useState<Ticket | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const next = () => {
    setTicket(null);
    setCode('');
    setTimeout(() => input.current?.focus(), 0);
  };
  const look = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      setTicket(await call('exit.lookup', code));
    } catch (err) {
      toast.error(err);
      setCode('');
    }
  };
  const record = async (status: 'ok' | 'problem') => {
    if (!ticket) return;
    const note = status === 'problem' ? await askText('Quel problème ? (article en trop, ticket refusé…)') : null;
    if (status === 'problem' && !note) return;
    try {
      await call('exit.record', ticket.sale.id, { status, note });
      toast.ok(status === 'ok' ? `Ticket ${ticket.sale.number} contrôlé` : 'Problème noté : le gérant est prévenu');
      next();
    } catch (err) {
      toast.error(err);
    }
  };
  return (
    <div className="exit-door">
      <form onSubmit={look}>
        <Field label="Scannez le code-barres du ticket">
          <input ref={input} autoFocus className="search big" value={code} onChange={(e) => setCode(e.target.value)} placeholder="ou tapez le numéro du ticket" />
        </Field>
      </form>
      {ticket && (
        <section className={`card ${VERDICT[ticket.verdict][1]}`}>
          <h2>{VERDICT[ticket.verdict][0]}</h2>
          {ticket.warnings.map((w) => (
            <p key={w} className="exit-warning">
              {w}
            </p>
          ))}
          <p className="muted">
            Ticket {ticket.sale.number} · {dateTime(ticket.sale.created_at)} · {fcfa(ticket.sale.total_ttc)} · caisse : {ticket.sale.user_name}
            {ticket.sale.customer_name ? ` · client : ${ticket.sale.customer_name}` : ''}
          </p>
          <table className="list exit-lines">
            <tbody>
              {ticket.lines.map((l, i) => (
                <tr key={i}>
                  <td>{l.label}</td>
                  <td className="r">
                    <b>{l.text}</b>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="actions">
            <button type="button" onClick={next}>
              Ticket suivant
            </button>
            <button type="button" className="danger" onClick={() => void record('problem')}>
              Problème
            </button>
            <button type="button" className="primary" disabled={ticket.verdict === 'stop'} onClick={() => void record('ok')}>
              Contrôlé, le client sort
            </button>
          </div>
        </section>
      )}
    </div>
  );
}

function ExitReport() {
  const [day, setDay] = useState(today());
  const [problems, setProblems] = useState(false);
  const cover = useLoad(() => call('exit.coverage', day), [day]);
  const list = useLoad(() => call('exit.list', { from: day, to: day, problems }), [day, problems]);
  return (
    <>
      <div className="filters">
        <input type="date" value={day} onChange={(e) => setDay(e.target.value)} />
        <label>
          <input type="checkbox" checked={problems} onChange={(e) => setProblems(e.target.checked)} /> Problèmes seulement (et tickets présentés deux fois)
        </label>
      </div>
      {cover.data && (
        <div className="kpis">
          <div>
            <small>Tickets du jour</small>
            <strong>{cover.data.tickets}</strong>
          </div>
          <div>
            <small>Contrôlés à la sortie</small>
            <strong>
              {cover.data.checked}
              {cover.data.tickets ? ` (${Math.round((cover.data.checked * 100) / cover.data.tickets)} %)` : ''}
            </strong>
          </div>
          <div className={cover.data.problems ? 'neg' : ''}>
            <small>Problèmes</small>
            <strong>{cover.data.problems}</strong>
          </div>
        </div>
      )}
      {list.data?.length === 0 ? (
        <Empty>Aucun contrôle ce jour-là.</Empty>
      ) : (
        <table className="list compact">
          <thead>
            <tr>
              <th>Heure</th>
              <th>Ticket</th>
              <th className="r">Montant</th>
              <th>Caissier</th>
              <th>Contrôlé par</th>
              <th>Résultat</th>
              <th>Remarque</th>
            </tr>
          </thead>
          <tbody>
            {(list.data ?? []).map((c) => (
              <tr key={c.id}>
                <td>{dateTime(c.created_at)}</td>
                <td>{c.sale_number}</td>
                <td className="r">{fcfa(c.total_ttc)}</td>
                <td>{c.cashier}</td>
                <td>
                  {c.user_name}
                  {c.source === 'phone' && <small className="muted"> (téléphone)</small>}
                </td>
                <td>
                  {c.status === 'problem' ? <span className="tag rupture">problème</span> : <span className="tag normal">ok</span>}
                  {c.repeat === 1 && <span className="tag alerte"> 2e passage</span>}
                </td>
                <td>{c.note}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
