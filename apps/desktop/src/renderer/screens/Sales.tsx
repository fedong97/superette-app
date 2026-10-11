import { useState } from 'react';
import { PAYMENT_METHODS } from '@superette/core';
import { type Result, call } from '../api';
import { Field, Modal, Tabs, dateTime, downloadText, fcfa, qty, today, useCan, useLoad, useToast } from '../ui';
import { CashOperations, type RegisterPreset, SalesAlerts, SalesRegister } from './Controls';
import { ZView } from './PosDialogs';
import { tx } from '../tax';

export type SalesTab = 'tickets' | 'register' | 'returns' | 'cancelled' | 'find' | 'alerts' | 'cashops' | 'z' | 'export';
type ShownTab = Exclude<SalesTab, 'returns' | 'cancelled' | 'find'>;

/**
 * `rights` : sans « Voir tout le registre des factures », l'écran ne montre que
 * les trois dernières factures de l'utilisateur, pour les réimprimer.
 */
export function Sales({ initialTab = 'tickets', rights }: { initialTab?: SalesTab; rights: string[] }) {
  const wide = ['sales', 'sales_alerts', 'cash_operations', 'cash_z', 'accounting_export', 'report_export'].some((r) => rights.includes(r));
  return wide ? <AllSales initialTab={initialTab} rights={rights} /> : <MyLastInvoices />;
}

function AllSales({ initialTab, rights }: { initialTab: SalesTab; rights: string[] }) {
  const can = (...r: string[]) => r.some((x) => rights.includes(x));
  // Chaque onglet suit son droit ; « Mes dernières factures » reste à tous.
  const tabs: [ShownTab, string][] = [
    ['tickets', can('sales') ? 'Factures du jour' : 'Mes dernières factures'],
    ...(can('sales') ? ([['register', 'Registre des ventes']] as [ShownTab, string][]) : []),
    ...(can('sales_alerts') ? ([['alerts', 'Alertes sur les ventes']] as [ShownTab, string][]) : []),
    ...(can('cash_operations') ? ([['cashops', 'Opérations de caisse']] as [ShownTab, string][]) : []),
    ...(can('cash_amounts') && can('cash_z') ? ([['z', 'Clôtures Z']] as [ShownTab, string][]) : []),
    ...(can('accounting_export', 'report_export') ? ([['export', 'Export comptable']] as [ShownTab, string][]) : []),
  ];
  // Retours, annulés et recherche s'ouvrent sur le registre, déjà filtré.
  const preset: RegisterPreset = initialTab === 'returns' ? 'returns' : initialTab === 'cancelled' ? 'cancelled' : 'all';
  const wanted: ShownTab = initialTab === 'returns' || initialTab === 'cancelled' || initialTab === 'find' ? 'register' : initialTab;
  const [tab, setTab] = useState<ShownTab>(tabs.some(([t]) => t === wanted) ? wanted : 'tickets');
  return (
    <div className="page">
      <header className="page-head">
        <h1>Ventes et caisses</h1>
      </header>
      <Tabs value={tab} onChange={setTab} tabs={tabs} />
      {tab === 'tickets' && (can('sales') ? <Tickets /> : <MyLastInvoices embedded />)}
      {tab === 'register' && <SalesRegister preset={preset} focusSearch={initialTab === 'find'} />}
      {tab === 'alerts' && <SalesAlerts />}
      {tab === 'cashops' && <CashOperations />}
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
            <th className="r">{tx('Total TTC')}</th>
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
      {open && <SaleDetail sale={open} onClose={() => setOpen(null)} />}
    </>
  );
}

/** Les trois dernières factures du caissier, à réimprimer au besoin. */
function MyLastInvoices({ embedded }: { embedded?: boolean }) {
  const toast = useToast();
  const [open, setOpen] = useState<Result<'pos.sale'> | null>(null);
  const sales = useLoad(() => call('pos.sales', {}));
  return (
    <div className={embedded ? '' : 'page'}>
      {!embedded && (
        <header className="page-head">
          <h1>Mes dernières factures</h1>
        </header>
      )}
      <p className="muted">Vos trois dernières factures, à réimprimer si le client le demande.</p>
      <table className="list">
        <thead>
          <tr>
            <th>Ticket</th>
            <th>Heure</th>
            <th>Client</th>
            <th>Type</th>
            <th className="r">Total</th>
            <th>État</th>
          </tr>
        </thead>
        <tbody>
          {(sales.data ?? []).map((s) => (
            <tr key={s.id} className="clickable" onClick={() => call('pos.sale', s.id).then(setOpen, toast.error)}>
              <td>{s.number}</td>
              <td>{dateTime(s.created_at)}</td>
              <td>{s.customer_name ?? ''}</td>
              <td>{s.kind === 'sale' ? 'Vente' : 'Retour'}</td>
              <td className={`r ${s.total_ttc < 0 ? 'neg' : ''}`}>{fcfa(s.total_ttc)}</td>
              <td>{s.status === 'cancelled' ? <span className="tag rupture">Annulé</span> : ''}</td>
            </tr>
          ))}
          {sales.data && !sales.data.length && (
            <tr>
              <td colSpan={6} className="muted">
                Aucune facture
              </td>
            </tr>
          )}
        </tbody>
      </table>
      {open && <SaleDetail sale={open} onClose={() => setOpen(null)} />}
    </div>
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

/** Détail d'un ticket ou d'une facture, avec réimpression. */
export function SaleDetail({ sale, onClose }: { sale: Result<'pos.sale'>; onClose: () => void }) {
  const toast = useToast();
  const can = useCan();
  return (
    <Modal title={`Ticket ${sale.number}`} onClose={() => onClose()}>
      <p className="muted">
        {dateTime(sale.created_at)} · {sale.user_name}
        {sale.cancel_reason && ` · ${sale.status === 'cancelled' ? 'Annulé' : 'Motif'} : ${sale.cancel_reason}`}
      </p>
      <table className="list compact">
        <tbody>
          {sale.lines.map((l) => (
            <tr key={l.id}>
              <td>{l.label}</td>
              <td className="r">{qty(l.qty, l.unit)}</td>
              <td className="r">{fcfa(l.total_ttc)}</td>
            </tr>
          ))}
          <tr className="b">
            <td>Total</td>
            <td />
            <td className="r">{fcfa(sale.total_ttc)}</td>
          </tr>
          {sale.payments.map((p, i) => (
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
        {!can('sale_reprint') && <span className="muted">Réimpression non permise (droit « Réimprimer un ticket ou une facture »).</span>}
        <button disabled={!can('sale_reprint')} onClick={() => call('pos.printInvoice', sale.id).then(() => toast.ok('Facture imprimée'), toast.error)}>
          Facture A4
        </button>
        <button className="primary" disabled={!can('sale_reprint')} onClick={() => call('pos.printTicket', sale.id).then(() => toast.ok('Ticket réimprimé'), toast.error)}>
          Réimprimer le ticket
        </button>
      </div>
    </Modal>
  );
}
