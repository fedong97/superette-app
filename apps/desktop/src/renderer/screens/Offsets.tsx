import { useState } from 'react';
import { call } from '../api';
import { Empty, Field, Modal, askText, dateFr, fcfa, parseAmount, today, useLoad, useToast } from '../ui';

/**
 * Compensations entre le compte client et le compte fournisseur d'un même tiers :
 * ce qu'il nous doit est soldé par ce qu'on lui doit, sans mouvement d'argent.
 */
export function Offsets() {
  const toast = useToast();
  const list = useLoad(() => call('offsets.list'), []);
  const customers = useLoad(() => call('customers.list', { withBalance: true }), []);
  const [creating, setCreating] = useState<string | null>(null);
  const [picked, setPicked] = useState('');
  const linked = (customers.data ?? []).filter((c) => c.supplier_id && c.balance > 0);
  return (
    <>
      <div className="filters">
        <select value={picked} onChange={(e) => setPicked(e.target.value)}>
          <option value="">Client aussi fournisseur…</option>
          {linked.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name} · doit {fcfa(c.balance)}
            </option>
          ))}
        </select>
        <button className="primary" disabled={!picked} onClick={() => setCreating(picked)}>
          Nouvelle compensation
        </button>
        <span className="muted">Reliez d’abord le client à sa fiche fournisseur (fiche client, « Aussi fournisseur »).</span>
      </div>
      {list.data?.length === 0 ? (
        <Empty>Aucune compensation.</Empty>
      ) : (
        <table className="list">
          <thead>
            <tr>
              <th>Pièce</th>
              <th>Date</th>
              <th>Client</th>
              <th>Facture fournisseur</th>
              <th className="r">Montant</th>
              <th>Par</th>
              <th>Notes</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {(list.data ?? []).map((o) => (
              <tr key={o.id} className={o.status === 'cancelled' ? 'inactive' : ''}>
                <td>{o.number}</td>
                <td>{dateFr(o.offset_date)}</td>
                <td>{o.customer_name}</td>
                <td>
                  {o.invoice_number}
                  {o.supplier_number ? ` (${o.supplier_number})` : ''}
                </td>
                <td className="r">{fcfa(o.amount)}</td>
                <td>{o.user_name ?? ''}</td>
                <td>{o.notes ?? ''}</td>
                <td>
                  {o.status === 'active' ? (
                    <button
                      className="ghost"
                      onClick={async () => {
                        const reason = await askText(`Annuler ${o.number} : motif`);
                        if (!reason) return;
                        try {
                          await call('offsets.cancel', o.id, reason);
                          toast.ok(`${o.number} annulée`);
                          list.reload();
                        } catch (err) {
                          toast.error(err);
                        }
                      }}
                    >
                      Annuler
                    </button>
                  ) : (
                    <span className="tag rupture">Annulée</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {creating && (
        <OffsetDialog
          customerId={creating}
          onClose={() => setCreating(null)}
          onDone={() => {
            setCreating(null);
            list.reload();
            customers.reload();
          }}
        />
      )}
    </>
  );
}

/** Compenser une facture fournisseur due avec la dette du client. */
export function OffsetDialog({ customerId, onClose, onDone }: { customerId: string; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const data = useLoad(() => call('offsets.candidates', customerId), [customerId]);
  const [invoiceId, setInvoiceId] = useState('');
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(today());
  const [notes, setNotes] = useState('');
  const d = data.data;
  const invoice = d?.invoices.find((i) => i.id === invoiceId);
  const max = invoice && d ? Math.min(invoice.balance, d.customerBalance) : 0;
  return (
    <Modal title="Compensation client / fournisseur" onClose={onClose}>
      {d && !d.supplier && <p className="neg">Ce client n’est relié à aucune fiche fournisseur.</p>}
      {d?.supplier && (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            const v = parseAmount(amount || String(max));
            if (!v) return toast.error('Montant invalide');
            try {
              const o = await call('offsets.create', { customerId, invoiceId, amount: v, date, notes: notes || null });
              toast.ok(`Compensation ${o.number} enregistrée`);
              onDone();
            } catch (err) {
              toast.error(err);
            }
          }}
        >
          <div className="kpis">
            <div>
              <small>Le client doit</small>
              <strong>{fcfa(d.customerBalance)}</strong>
            </div>
            <div>
              <small>On doit à {d.supplier.name}</small>
              <strong>{fcfa(d.supplierBalance)}</strong>
            </div>
            <div>
              <small>Compensable</small>
              <strong>{fcfa(d.max)}</strong>
            </div>
          </div>
          <Field label="Facture fournisseur soldée">
            <select value={invoiceId} onChange={(e) => setInvoiceId(e.target.value)} required>
              <option value="">Choisir…</option>
              {d.invoices.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.number} {i.supplier_number ? `(${i.supplier_number})` : ''} · reste {fcfa(i.balance)}
                </option>
              ))}
            </select>
          </Field>
          <div className="grid2">
            <Field label="Montant (FCFA)" hint={max ? `Vide = ${fcfa(max)}` : undefined}>
              <input inputMode="numeric" value={amount} placeholder={max ? String(max) : ''} onChange={(e) => setAmount(e.target.value)} />
            </Field>
            <Field label="Date">
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </Field>
          </div>
          <Field label="Notes">
            <input value={notes} onChange={(e) => setNotes(e.target.value)} />
          </Field>
          <p className="muted">Aucun argent ne bouge : le compte client baisse, la facture fournisseur est réglée d’autant, l’écriture passe en opérations diverses (401 au débit, 411 au crédit).</p>
          <div className="actions">
            <button type="button" onClick={onClose}>
              Retour
            </button>
            <button type="submit" className="primary" disabled={!invoiceId || !max}>
              Compenser
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}
