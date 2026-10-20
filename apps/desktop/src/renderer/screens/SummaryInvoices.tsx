import { useEffect, useState } from 'react';
import { call } from '../api';
import { Empty, Modal, askConfirm, dateFr, dateTime, fcfa, today, useLoad, useToast } from '../ui';
import { hasVat, tx } from '../tax';

const monthStart = (d: string) => `${d.slice(0, 8)}01`;
/** Mois précédent : la récapitulative se fait d'habitude en début de mois pour le mois écoulé. */
function lastMonth(): [string, string] {
  const d = new Date();
  const first = new Date(d.getFullYear(), d.getMonth() - 1, 1);
  const last = new Date(d.getFullYear(), d.getMonth(), 0);
  const iso = (x: Date) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
  return [iso(first), iso(last)];
}

/**
 * Factures récapitulatives : les tickets et factures d'un client sur une
 * période, regroupés sur une seule facture de fin de mois.
 */
export function SummaryInvoices() {
  const toast = useToast();
  const customers = useLoad(() => call('customers.list', {}), []);
  const [customerId, setCustomerId] = useState('');
  const [[from, to], setPeriod] = useState<[string, string]>(lastMonth);
  const [picked, setPicked] = useState<string[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const candidates = useLoad(() => (customerId && from && to && from <= to ? call('summaryInvoices.candidates', customerId, from, to) : Promise.resolve([])), [customerId, from, to, tick]);
  const list = useLoad(() => call('summaryInvoices.list', customerId || null), [customerId, tick, open]);
  useEffect(() => setPicked(null), [candidates.data]);
  const sales = candidates.data ?? [];
  const chosen = picked ?? sales.map((s) => s.id);
  const total = sales.filter((s) => chosen.includes(s.id)).reduce((t, s) => t + s.total_ttc, 0);
  const create = async () => {
    try {
      const inv = await call('summaryInvoices.create', { customerId, from, to, saleIds: chosen });
      toast.ok(`Facture récapitulative ${inv.number} créée`);
      setTick((t) => t + 1);
      setOpen(inv.id);
    } catch (e) {
      toast.error(e);
    }
  };
  return (
    <>
      <div className="filters">
        <select value={customerId} onChange={(e) => setCustomerId(e.target.value)} autoFocus>
          <option value="">Choisir le client…</option>
          {customers.data?.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <label className="inline">
          Du <input type="date" value={from} onChange={(e) => setPeriod([e.target.value, to])} />
        </label>
        <label className="inline">
          au <input type="date" value={to} onChange={(e) => setPeriod([from, e.target.value])} />
        </label>
        <button onClick={() => setPeriod([monthStart(today()), today()])}>Ce mois-ci</button>
        <button onClick={() => setPeriod(lastMonth())}>Mois dernier</button>
      </div>
      {customerId && (
        <>
          <h3>Ventes à regrouper</h3>
          {sales.length === 0 ? (
            <p className="muted">Aucune vente de ce client sur la période qui ne soit pas déjà sur une facture récapitulative.</p>
          ) : (
            <>
              <table className="list compact">
                <thead>
                  <tr>
                    <th />
                    <th>Date</th>
                    <th>N°</th>
                    <th className="r">{tx('TTC')}</th>
                    <th className="r">Dont à crédit</th>
                  </tr>
                </thead>
                <tbody>
                  {sales.map((s) => (
                    <tr key={s.id}>
                      <td>
                        <input
                          type="checkbox"
                          checked={chosen.includes(s.id)}
                          onChange={(e) => setPicked(e.target.checked ? [...chosen, s.id] : chosen.filter((x) => x !== s.id))}
                        />
                      </td>
                      <td>{dateFr(s.date)}</td>
                      <td>
                        {s.kind === 'return' ? 'Retour ' : ''}
                        {s.number}
                      </td>
                      <td className="r">{fcfa(s.total_ttc)}</td>
                      <td className="r">{s.on_credit ? fcfa(s.on_credit) : ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="actions">
                <span>
                  {chosen.length} ventes · {fcfa(total)}
                </span>
                <button className="primary" disabled={chosen.length === 0} onClick={create}>
                  Créer la facture récapitulative
                </button>
              </div>
            </>
          )}
        </>
      )}
      <h3>Factures récapitulatives</h3>
      {(list.data ?? []).length === 0 ? (
        <Empty>Aucune facture récapitulative. Choisissez un client et la période : ses tickets et factures sont regroupés sur une seule facture.</Empty>
      ) : (
        <table className="list">
          <thead>
            <tr>
              <th>N°</th>
              <th>Client</th>
              <th>Période</th>
              <th className="r">Ventes</th>
              <th className="r">{tx('TTC')}</th>
              <th>Créée le</th>
              <th>État</th>
            </tr>
          </thead>
          <tbody>
            {(list.data ?? []).map((i) => (
              <tr key={i.id} className={`clickable ${i.status === 'cancelled' ? 'muted' : ''}`} onClick={() => setOpen(i.id)}>
                <td>{i.number}</td>
                <td>{i.customer_name}</td>
                <td>
                  {dateFr(i.period_from)} au {dateFr(i.period_to)}
                </td>
                <td className="r">{i.sale_count}</td>
                <td className="r">{fcfa(i.total_ttc)}</td>
                <td>{dateTime(i.created_at)}</td>
                <td>{i.status === 'cancelled' ? 'Annulée' : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {open && <SummaryDetail id={open} onClose={() => setOpen(null)} onChanged={() => setTick((t) => t + 1)} />}
    </>
  );
}

function SummaryDetail({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const toast = useToast();
  const inv = useLoad(() => call('summaryInvoices.get', id), [id]);
  if (!inv.data) return null;
  const d = inv.data;
  return (
    <Modal title={`Facture récapitulative ${d.number}`} onClose={onClose} wide>
      <p>
        <b>{d.customer_name}</b> · du {dateFr(d.period_from)} au {dateFr(d.period_to)} · {d.sale_count} ventes
        {d.status === 'cancelled' ? ' · annulée' : ''}
      </p>
      <table className="list compact">
        <thead>
          <tr>
            <th>Date</th>
            <th>N°</th>
            <th className="r">Articles</th>
            <th className="r">{tx('TTC')}</th>
          </tr>
        </thead>
        <tbody>
          {d.sales.map((s) => (
            <tr key={s.id}>
              <td>{dateFr(s.date)}</td>
              <td>{s.number}</td>
              <td className="r">{s.lines.length}</td>
              <td className="r">{fcfa(s.total_ttc)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p>
        {hasVat() ? `HT ${fcfa(d.total_ht)} · TVA ${fcfa(d.total_tva)} · ` : ''}
        <b>{tx('TTC')} {fcfa(d.total_ttc)}</b>
        {d.on_credit ? ` · dont passé au compte du client ${fcfa(d.on_credit)}` : ''}
      </p>
      <p className="muted">Chaque vente est déjà comptabilisée à sa date : la facture récapitulative les regroupe pour le client, sans nouvelle écriture.</p>
      <div className="actions">
        <button className="primary" onClick={() => call('summaryInvoices.print', id).catch(toast.error)}>
          Imprimer
        </button>
        {d.status === 'active' && (
          <button
            onClick={async () => {
              if (!(await askConfirm(`Annuler la facture récapitulative ${d.number} ? Ses ventes pourront être reprises sur une autre.`))) return;
              try {
                await call('summaryInvoices.cancel', id);
                inv.reload();
                onChanged();
              } catch (e) {
                toast.error(e);
              }
            }}
          >
            Annuler la facture
          </button>
        )}
        <button onClick={onClose}>Fermer</button>
      </div>
    </Modal>
  );
}
