import { useState } from 'react';
import { type Result, call } from '../api';
import { Empty, Modal, Tabs, dateTime, downloadText, fcfa, qty, today, useLoad, useToast } from '../ui';
import { hasVat, tx } from '../tax';

export type RealSalesTab = 'operations' | 'payments' | 'summary' | 'export';
type Filter = 'all' | 'sales' | 'returns' | 'cancelled';

const monthStart = (d: string) => `${d.slice(0, 8)}01`;

function Period({ from, to, onChange }: { from: string; to: string; onChange: (from: string, to: string) => void }) {
  return (
    <>
      <label className="inline">
        Du <input type="date" value={from} onChange={(e) => onChange(e.target.value, to)} />
      </label>
      <label className="inline">
        au <input type="date" value={to} onChange={(e) => onChange(from, e.target.value)} />
      </label>
      <button onClick={() => onChange(today(), today())}>Aujourd’hui</button>
      <button onClick={() => onChange(monthStart(today()), today())}>Ce mois-ci</button>
    </>
  );
}

/**
 * Ventes réelles : la source de référence de toutes les opérations de vente, telles
 * qu'elles ont eu lieu à la caisse. Écran en lecture seule ; la préparation fiscale
 * part de ces ventes, par leur identifiant, sans jamais les modifier.
 */
export function RealSales({ initialTab = 'operations' }: { initialTab?: RealSalesTab }) {
  const [tab, setTab] = useState<RealSalesTab>(initialTab);
  const [[from, to], setPeriod] = useState<[string, string]>([monthStart(today()), today()]);
  const valid = Boolean(from && to && from <= to);
  return (
    <div className="page">
      <header className="page-head">
        <h1>Ventes réelles</h1>
      </header>
      <p className="muted">
        Source de référence : toutes les ventes, paiements, annulations et remboursements, tels qu’enregistrés à la caisse. Rien n’y est masqué ni modifié ; la préparation fiscale
        s’appuie sur ces ventes sans les toucher.
      </p>
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          ['operations', 'Opérations'],
          ['payments', 'Paiements'],
          ['summary', 'Synthèse'],
          ['export', 'Exports'],
        ]}
      />
      <div className="filters">
        <Period from={from} to={to} onChange={(f, t) => setPeriod([f, t])} />
      </div>
      {!valid ? (
        <p className="muted">Choisissez une période valide.</p>
      ) : (
        <>
          {tab === 'operations' && <Operations from={from} to={to} />}
          {tab === 'payments' && <Payments from={from} to={to} />}
          {tab === 'summary' && <Summary from={from} to={to} />}
          {tab === 'export' && <Exports from={from} to={to} />}
        </>
      )}
    </div>
  );
}

const kindLabel = (r: { kind: string; status: string; hidden: number }) =>
  r.status === 'cancelled' ? (r.hidden ? 'Annulée (supprimée du registre)' : 'Annulée') : r.kind === 'return' ? 'Remboursement' : 'Vente';

function Operations({ from, to }: { from: string; to: string }) {
  const [filter, setFilter] = useState<Filter>('all');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const rows = useLoad(() => call('realSales.operations', { from, to, filter, q: q || null }), [from, to, filter, q]);
  const list = rows.data ?? [];
  return (
    <>
      <div className="filters">
        <select value={filter} onChange={(e) => setFilter(e.target.value as Filter)}>
          <option value="all">Toutes les opérations</option>
          <option value="sales">Ventes</option>
          <option value="returns">Remboursements (retours)</option>
          <option value="cancelled">Annulations</option>
        </select>
        <input placeholder="N° de ticket, client ou identifiant…" value={q} onChange={(e) => setQ(e.target.value)} />
        <span className="muted">{list.length} opérations</span>
      </div>
      {list.length === 0 ? (
        <Empty>Aucune opération de vente sur la période.</Empty>
      ) : (
        <table className="list compact">
          <thead>
            <tr>
              <th>Date</th>
              <th>N°</th>
              <th>Opération</th>
              <th>Caisse</th>
              <th>Caissier</th>
              <th>Client</th>
              <th className="r">{tx('TTC')}</th>
              <th>Paiements</th>
              <th>Lien</th>
            </tr>
          </thead>
          <tbody>
            {list.map((r) => (
              <tr key={r.id} className={`clickable ${r.status === 'cancelled' ? 'muted' : ''}`} onClick={() => setOpen(r.id)}>
                <td>{dateTime(r.created_at)}</td>
                <td>{r.number}</td>
                <td>{kindLabel(r)}</td>
                <td>{r.register_name}</td>
                <td>{r.user_name}</td>
                <td>{r.customer_name}</td>
                <td className="r">{fcfa(r.total_ttc)}</td>
                <td>{r.payments}</td>
                <td>
                  {r.original_number ? `sur ${r.original_number}` : r.replaces_number ? `remplace ${r.replaces_number}` : r.replaced_by_number ? `remplacée par ${r.replaced_by_number}` : ''}
                  {r.fiscal_refs ? ` · ${r.fiscal_refs} ajust. fiscal` : ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {open && <RealSaleDetail id={open} onClose={() => setOpen(null)} onOpen={setOpen} />}
    </>
  );
}

function RealSaleDetail({ id, onClose, onOpen }: { id: string; onClose: () => void; onOpen: (id: string) => void }) {
  const d = useLoad(() => call('realSales.detail', id), [id]).data;
  if (!d) return null;
  return (
    <Modal title={`${kindLabel(d)} ${d.number}`} onClose={onClose} wide>
      <p>
        {dateTime(d.created_at)} · {d.register_name} · {d.user_name}
        {d.customer_name ? ` · ${d.customer_name}` : ''}
      </p>
      <p className="muted">Identifiant commun aux deux modules : {d.id}</p>
      {d.status === 'cancelled' && (
        <p className="warn">
          Annulée{d.cancelled_by_name ? ` par ${d.cancelled_by_name}` : ''} : {d.cancel_reason}
        </p>
      )}
      <table className="list compact">
        <thead>
          <tr>
            <th>Article</th>
            <th className="r">Qté</th>
            <th className="r">Prix</th>
            <th className="r">Remise</th>
            {hasVat() && <th className="r">TVA</th>}
            <th className="r">{tx('Total TTC')}</th>
          </tr>
        </thead>
        <tbody>
          {d.lines.map((l) => (
            <tr key={l.line_no}>
              <td>{l.label}</td>
              <td className="r">{qty(l.qty)}</td>
              <td className="r">{fcfa(l.unit_price)}</td>
              <td className="r">{l.discount ? fcfa(l.discount) : ''}</td>
              {hasVat() && <td className="r">{l.vat_rate_bp / 100} %</td>}
              <td className="r">{fcfa(l.total_ttc)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p>
        {hasVat() ? `HT ${fcfa(d.total_ht)} · TVA ${fcfa(d.total_tva)} · ` : ''}
        <b>
          {tx('TTC')} {fcfa(d.total_ttc)}
        </b>
        {d.total_discount ? ` · remises ${fcfa(d.total_discount)}` : ''}
        {d.change_given ? ` · monnaie rendue ${fcfa(d.change_given)}` : ''}
      </p>
      <h3>Paiements</h3>
      <ul>
        {d.paymentLines.map((p, i) => (
          <li key={i}>
            {p.label} : {fcfa(p.amount)}
            {p.reference ? ` (réf. ${p.reference})` : ''}
          </li>
        ))}
      </ul>
      {(d.original_sale_id || d.returns.length > 0) && (
        <>
          <h3>Documents liés</h3>
          <ul>
            {d.original_sale_id && (
              <li>
                Vente d’origine :{' '}
                <button className="link" onClick={() => onOpen(d.original_sale_id!)}>
                  {d.original_number}
                </button>
              </li>
            )}
            {d.returns.map((r) => (
              <li key={r.id}>
                Remboursement{' '}
                <button className="link" onClick={() => onOpen(r.id)}>
                  {r.number}
                </button>{' '}
                du {dateTime(r.created_at)} : {fcfa(r.total_ttc)}
                {r.cancel_reason ? ` (${r.cancel_reason})` : ''}
              </li>
            ))}
          </ul>
        </>
      )}
      {d.fiscal.length > 0 && (
        <>
          <h3>Références dans la préparation fiscale</h3>
          <p className="muted">Ces ajustements citent cette vente ; ils ne la modifient pas.</p>
          <ul>
            {d.fiscal.map((f) => (
              <li key={f.id}>
                {f.number} ({f.kind === 'credit_note' ? 'avoir' : f.kind === 'reclass' ? 'reclassement' : 'correction'}) du {dateTime(f.created_at)}
              </li>
            ))}
          </ul>
        </>
      )}
      <div className="actions">
        <button onClick={onClose}>Fermer</button>
      </div>
    </Modal>
  );
}

function Payments({ from, to }: { from: string; to: string }) {
  const rows = useLoad(() => call('realSales.payments', { from, to }), [from, to]).data ?? [];
  if (rows.length === 0) return <Empty>Aucun paiement sur la période.</Empty>;
  return (
    <table className="list compact">
      <thead>
        <tr>
          <th>Date</th>
          <th>Document</th>
          <th>Origine</th>
          <th>Moyen</th>
          <th className="r">Montant</th>
          <th>Référence</th>
          <th>Client</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i} className={r.doc_status === 'cancelled' ? 'muted' : ''}>
            <td>{dateTime(r.at)}</td>
            <td>{r.doc_number}</td>
            <td>{r.source === 'sale' ? (r.doc_status === 'cancelled' ? 'Vente annulée' : 'Vente') : 'Règlement client'}</td>
            <td>{r.method_label}</td>
            <td className="r">{fcfa(r.amount)}</td>
            <td>{r.reference}</td>
            <td>{r.customer_name}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Summary({ from, to }: { from: string; to: string }) {
  const s: Result<'realSales.summary'> | undefined = useLoad(() => call('realSales.summary', { from, to }), [from, to]).data;
  if (!s) return null;
  return (
    <div className="narrow">
      <table className="list compact">
        <thead>
          <tr>
            <th />
            <th className="r">Nombre</th>
            <th className="r">{tx('TTC')}</th>
            {hasVat() && <th className="r">HT</th>}
            {hasVat() && <th className="r">TVA</th>}
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Ventes</td>
            <td className="r">{s.sales.count}</td>
            <td className="r">{fcfa(s.sales.ttc)}</td>
            {hasVat() && <td className="r">{fcfa(s.sales.ht)}</td>}
            {hasVat() && <td className="r">{fcfa(s.sales.tva)}</td>}
          </tr>
          <tr>
            <td>Remboursements (retours)</td>
            <td className="r">{s.returns.count}</td>
            <td className="r">{fcfa(s.returns.ttc)}</td>
            {hasVat() && <td className="r">{fcfa(s.returns.ht)}</td>}
            {hasVat() && <td className="r">{fcfa(s.returns.tva)}</td>}
          </tr>
          <tr>
            <td>
              <b>Chiffre d’affaires réel</b>
            </td>
            <td />
            <td className="r">
              <b>{fcfa(s.net.ttc)}</b>
            </td>
            {hasVat() && <td className="r">{fcfa(s.net.ht)}</td>}
            {hasVat() && <td className="r">{fcfa(s.net.tva)}</td>}
          </tr>
          <tr className="muted">
            <td>Annulations (hors chiffre d’affaires)</td>
            <td className="r">{s.cancelled.count}</td>
            <td className="r">{fcfa(s.cancelled.ttc)}</td>
            {hasVat() && <td />}
            {hasVat() && <td />}
          </tr>
        </tbody>
      </table>
      <h3>Encaissements des ventes par moyen de paiement</h3>
      <table className="list compact">
        <tbody>
          {s.byMethod.map((m) => (
            <tr key={m.method}>
              <td>{m.label}</td>
              <td className="r">{fcfa(m.amount)}</td>
            </tr>
          ))}
          <tr>
            <td>Règlements clients reçus ({s.customerPayments.count})</td>
            <td className="r">{fcfa(s.customerPayments.amount)}</td>
          </tr>
        </tbody>
      </table>
      <p className="muted">Remises accordées sur les ventes : {fcfa(s.sales.discount)}</p>
    </div>
  );
}

function Exports({ from, to }: { from: string; to: string }) {
  const toast = useToast();
  const dl = async (what: 'operations' | 'lines' | 'payments', name: string) => {
    try {
      downloadText(`ventes-reelles_${name}_${from}_${to}.csv`, await call('realSales.exportCsv', { from, to }, what));
    } catch (e) {
      toast.error(e);
    }
  };
  return (
    <div className="narrow">
      <p className="muted">
        Exports de la source, séparés de ceux de la préparation fiscale. Chaque ligne porte l’identifiant de la vente : c’est lui qui relie les deux modules.
      </p>
      <div className="actions">
        <button className="primary" onClick={() => dl('operations', 'operations')}>
          Opérations (CSV)
        </button>
        <button onClick={() => dl('lines', 'lignes')}>Lignes d’articles (CSV)</button>
        <button onClick={() => dl('payments', 'paiements')}>Paiements (CSV)</button>
      </div>
    </div>
  );
}
