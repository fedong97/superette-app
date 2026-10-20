import { useState } from 'react';
import { type Result, call } from '../api';
import { Empty, Field, Modal, askConfirm, dateFr, fcfa, parseAmount, today, useLoad, useToast } from '../ui';

type Received = Result<'cheques.received'>[number];

/** Chèques revenus impayés : le chèque et les frais de la banque retournent au débit du client. */
export function ChequeRejections() {
  const toast = useToast();
  const [tick, setTick] = useState(0);
  const received = useLoad(() => call('cheques.received'), [tick]);
  const rejections = useLoad(() => call('cheques.rejections'), [tick]);
  const [rejecting, setRejecting] = useState<Received | null>(null);
  const cheques = received.data ?? [];
  const list = rejections.data ?? [];
  return (
    <>
      <p className="muted">
        Quand la banque renvoie un chèque impayé, le montant du chèque et les frais prélevés retournent au compte du client et apparaissent sur son relevé. L'écriture
        comptable reprend la banque (ou le compte 513 « Chèques à encaisser » si le chèque n'était pas encore remis en banque).
      </p>
      <h3>Chèques reçus ces 90 derniers jours</h3>
      {cheques.length === 0 ? (
        <Empty>Aucun chèque reçu ces 90 derniers jours.</Empty>
      ) : (
        <table className="list compact">
          <thead>
            <tr>
              <th>Reçu le</th>
              <th>Pièce</th>
              <th>N° du chèque</th>
              <th>Tireur</th>
              <th className="r">Montant</th>
              <th>Banque</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {cheques.map((c) => (
              <tr key={c.payment_id}>
                <td>{dateFr(c.received_at.slice(0, 10))}</td>
                <td>{c.doc_number}</td>
                <td>{c.reference}</td>
                <td>{c.drawer ?? <span className="muted">Client comptoir</span>}</td>
                <td className="r">{fcfa(c.amount)}</td>
                <td>{c.deposited ? 'Remis en banque' : <span className="muted">À remettre</span>}</td>
                <td>
                  <button className="link" onClick={() => setRejecting(c)}>
                    Revenu impayé
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <h3>Impayés enregistrés</h3>
      {list.length === 0 ? (
        <p className="muted">Aucun chèque revenu impayé.</p>
      ) : (
        <table className="list">
          <thead>
            <tr>
              <th>N°</th>
              <th>Rejeté le</th>
              <th>Client</th>
              <th>N° du chèque</th>
              <th>Pièce</th>
              <th className="r">Montant</th>
              <th className="r">Frais</th>
              <th>Motif</th>
              <th>État</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {list.map((x) => (
              <tr key={x.id} className={x.status === 'cancelled' ? 'muted' : ''}>
                <td>{x.number}</td>
                <td>{dateFr(x.rejected_on)}</td>
                <td>{x.customer_name}</td>
                <td>{x.reference}</td>
                <td>{x.doc_number}</td>
                <td className="r">{fcfa(x.amount)}</td>
                <td className="r">{x.fees ? fcfa(x.fees) : ''}</td>
                <td>{x.reason}</td>
                <td>{x.status === 'cancelled' ? 'Annulé' : x.deposited ? 'Repris à la banque' : 'Repris au 513'}</td>
                <td>
                  {x.status === 'active' && (
                    <button
                      className="link"
                      onClick={async () => {
                        if (!(await askConfirm(`Annuler l'impayé ${x.number} ? Le chèque redevient bon et ${fcfa(x.amount + x.fees)} sortent du compte de ${x.customer_name}.`))) return;
                        try {
                          await call('cheques.cancelRejection', x.id);
                          setTick((t) => t + 1);
                        } catch (e) {
                          toast.error(e);
                        }
                      }}
                    >
                      Annuler
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {rejecting && (
        <RejectDialog
          cheque={rejecting}
          onClose={() => setRejecting(null)}
          onDone={() => {
            setRejecting(null);
            setTick((t) => t + 1);
          }}
        />
      )}
    </>
  );
}

function RejectDialog({ cheque, onClose, onDone }: { cheque: Received; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [date, setDate] = useState(today);
  const [fees, setFees] = useState('');
  const [reason, setReason] = useState('');
  const [block, setBlock] = useState(true);
  const [search, setSearch] = useState(cheque.customer_id ? '' : (cheque.drawer ?? ''));
  const [customerId, setCustomerId] = useState('');
  const counter = !cheque.customer_id;
  const found = useLoad(() => (counter && search.trim().length >= 2 ? call('customers.list', { search: search.trim() }) : Promise.resolve([])), [search]);
  const feeValue = fees.trim() ? parseAmount(fees) : 0;
  const save = async () => {
    if (feeValue === null) return toast.error('Frais invalides');
    if (counter && !customerId) return toast.error('Choisissez le client à qui réclamer ce chèque');
    try {
      const x = await call('cheques.reject', { paymentId: cheque.payment_id, date, fees: feeValue, reason: reason || null, customerId: counter ? customerId : null, blockCheques: block });
      toast.ok(`Impayé ${x.number} : ${fcfa(x.amount + x.fees)} au débit de ${x.customer_name}`);
      onDone();
    } catch (e) {
      toast.error(e);
    }
  };
  return (
    <Modal title={`Chèque ${cheque.reference ?? cheque.doc_number} revenu impayé`} onClose={onClose}>
      <p>
        Chèque de {fcfa(cheque.amount)} reçu le {dateFr(cheque.received_at.slice(0, 10))} ({cheque.doc_number}){cheque.drawer ? `, tiré par ${cheque.drawer}` : ''}.
      </p>
      <Field label="Date du rejet">
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      </Field>
      <Field label="Frais prélevés par la banque" hint="Ils sont réclamés au client avec le chèque.">
        <input inputMode="numeric" value={fees} onChange={(e) => setFees(e.target.value)} placeholder="0" />
      </Field>
      <Field label="Motif">
        <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Provision insuffisante, signature non conforme…" />
      </Field>
      {counter && (
        <Field label="Client à qui réclamer le chèque" hint="Le chèque a été reçu d'un client comptoir : choisissez sa fiche client.">
          <input placeholder="Nom, code ou téléphone" value={search} onChange={(e) => setSearch(e.target.value)} />
          <select value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
            <option value="">Choisir le client…</option>
            {(found.data ?? []).slice(0, 30).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {c.phone ? ` · ${c.phone}` : ''}
              </option>
            ))}
          </select>
        </Field>
      )}
      <label className="check">
        <input type="checkbox" checked={block} onChange={(e) => setBlock(e.target.checked)} /> Interdire les chèques à ce client
      </label>
      <p className="muted">
        {fcfa(cheque.amount + (feeValue ?? 0))} retournent au débit du client. {cheque.deposited ? "L'écriture reprend le montant à la banque." : "Le chèque n'était pas encore remis en banque : l'écriture reprend le compte 513."}
      </p>
      <div className="actions">
        <button onClick={onClose}>Fermer</button>
        <button className="primary" onClick={save}>
          Enregistrer l'impayé
        </button>
      </div>
    </Modal>
  );
}
