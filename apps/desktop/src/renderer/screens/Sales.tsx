import { useState } from 'react';
import { PAYMENT_METHODS } from '@superette/core';
import { type Result, call } from '../api';
import { Field, Modal, Tabs, dateTime, downloadText, fcfa, qty, today, useLoad, useToast } from '../ui';
import { ZView } from './PosDialogs';

export type SalesTab = 'tickets' | 'z' | 'export';

export function Sales({ initialTab = 'tickets' }: { initialTab?: SalesTab }) {
  const [tab, setTab] = useState<SalesTab>(initialTab);
  return (
    <div className="page">
      <header className="page-head">
        <h1>Ventes et clôtures</h1>
      </header>
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          ['tickets', 'Tickets'],
          ['z', 'Clôtures Z'],
          ['export', 'Export comptable'],
        ]}
      />
      {tab === 'tickets' && <Tickets />}
      {tab === 'z' && <Sessions />}
      {tab === 'export' && <Export />}
    </div>
  );
}

function Tickets() {
  const toast = useToast();
  const [date, setDate] = useState(today());
  const [open, setOpen] = useState<Result<'pos.sale'> | null>(null);
  const sales = useLoad(() => call('pos.sales', { date }), [date]);
  return (
    <>
      <div className="filters">
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      </div>
      <table className="list">
        <thead>
          <tr>
            <th>Ticket</th>
            <th>Heure</th>
            <th>Caissier</th>
            <th>Type</th>
            <th className="r">Total TTC</th>
            <th>État</th>
          </tr>
        </thead>
        <tbody>
          {(sales.data ?? []).map((s) => (
            <tr key={s.id} className="clickable" onClick={() => call('pos.sale', s.id).then(setOpen, toast.error)}>
              <td>{s.number}</td>
              <td>{dateTime(s.created_at)}</td>
              <td>{s.user_name}</td>
              <td>{s.kind === 'sale' ? 'Vente' : 'Retour'}</td>
              <td className={`r ${s.total_ttc < 0 ? 'neg' : ''}`}>{fcfa(s.total_ttc)}</td>
              <td>{s.status === 'cancelled' ? <span className="tag rupture">Annulé</span> : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {open && (
        <Modal title={`Ticket ${open.number}`} onClose={() => setOpen(null)}>
          <p className="muted">
            {dateTime(open.created_at)} · {open.user_name}
            {open.cancel_reason && ` · ${open.status === 'cancelled' ? 'Annulé' : 'Motif'} : ${open.cancel_reason}`}
          </p>
          <table className="list compact">
            <tbody>
              {open.lines.map((l) => (
                <tr key={l.id}>
                  <td>{l.label}</td>
                  <td className="r">{qty(l.qty, l.unit)}</td>
                  <td className="r">{fcfa(l.total_ttc)}</td>
                </tr>
              ))}
              <tr className="b">
                <td>Total</td>
                <td />
                <td className="r">{fcfa(open.total_ttc)}</td>
              </tr>
              {open.payments.map((p, i) => (
                <tr key={i}>
                  <td>
                    {PAYMENT_METHODS[p.method]} {p.reference && <small>· {p.reference}</small>}
                  </td>
                  <td />
                  <td className="r">{fcfa(p.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="actions">
            <button onClick={() => call('pos.printTicket', open.id).then(() => toast.ok('Ticket réimprimé'), toast.error)}>Réimprimer</button>
          </div>
        </Modal>
      )}
    </>
  );
}

function Sessions() {
  const toast = useToast();
  const sessions = useLoad(() => call('pos.sessions'));
  const [z, setZ] = useState<Result<'pos.zReport'> | null>(null);
  return (
    <>
      <table className="list">
        <thead>
          <tr>
            <th>Z n°</th>
            <th>Ouverture</th>
            <th>Clôture</th>
            <th>Caissier</th>
            <th className="r">Théorique</th>
            <th className="r">Compté</th>
            <th className="r">Écart</th>
          </tr>
        </thead>
        <tbody>
          {(sessions.data ?? []).map((s) => (
            <tr key={s.id} className="clickable" onClick={() => call('pos.zReport', s.id).then(setZ, toast.error)}>
              <td>{s.z_number ?? 'en cours'}</td>
              <td>{dateTime(s.opened_at)}</td>
              <td>{s.closed_at ? dateTime(s.closed_at) : '—'}</td>
              <td>{s.user_name}</td>
              <td className="r">{s.expected_cash === null ? '—' : fcfa(s.expected_cash)}</td>
              <td className="r">{s.counted_cash === null ? '—' : fcfa(s.counted_cash)}</td>
              <td className={`r ${(s.difference ?? 0) < 0 ? 'neg' : (s.difference ?? 0) > 0 ? 'pos' : ''}`}>{s.difference === null ? '—' : fcfa(s.difference)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {z && (
        <Modal title={z.session.z_number ? `Rapport Z n° ${z.session.z_number}` : 'Rapport X (caisse ouverte)'} onClose={() => setZ(null)} wide>
          <ZView z={z} />
          <div className="actions">
            <button onClick={() => call('pos.printZ', z.session.id).then(() => toast.ok('Rapport imprimé'), toast.error)}>Imprimer</button>
          </div>
        </Modal>
      )}
    </>
  );
}

function Export() {
  const toast = useToast();
  const [from, setFrom] = useState(today());
  const [to, setTo] = useState(today());
  return (
    <div className="narrow">
      <p className="muted">
        En attendant le module Comptabilité (phase 3), exportez les ventes ligne par ligne pour votre comptable ou votre logiciel actuel (CSV compatible Excel).
      </p>
      <div className="grid2">
        <Field label="Du">
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        <Field label="Au">
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </Field>
      </div>
      <button
        className="primary"
        onClick={async () => {
          try {
            downloadText(`ventes_${from}_${to}.csv`, await call('reports.salesCsv', from, to));
          } catch (err) {
            toast.error(err);
          }
        }}
      >
        Télécharger le CSV
      </button>
    </div>
  );
}
