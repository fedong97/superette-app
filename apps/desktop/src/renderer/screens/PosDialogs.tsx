import { useState } from 'react';
import { DENOMINATIONS_FCFA, PAYMENT_METHODS, type Payment, type PaymentMethod, countedTotal, formatRate, requiresReference, settle } from '@superette/core';
import { type Result, call } from '../api';
import { Empty, Field, Modal, SupervisorPrompt, dateTime, fcfa, parseAmount, qty, useLoad, useToast } from '../ui';

const METHODS: PaymentMethod[] = ['CASH', 'MTN_MOMO', 'ORANGE_MONEY', 'CARD', 'VOUCHER'];

/** Règlement : paiements mixtes, rendu monnaie, références mobile money. */
export function PaymentDialog({
  total,
  needsSupervisor,
  allowCredit = false,
  onClose,
  onPaid,
}: {
  total: number;
  needsSupervisor: boolean;
  /** Un client est choisi : le reste peut aller à son compte. */
  allowCredit?: boolean;
  onClose: () => void;
  onPaid: (payments: Payment[], supervisorPin?: string) => Promise<void>;
}) {
  const toast = useToast();
  const [payments, setPayments] = useState<Payment[]>([]);
  const [method, setMethod] = useState<PaymentMethod>('CASH');
  const [amount, setAmount] = useState('');
  const [reference, setReference] = useState('');
  const [busy, setBusy] = useState(false);
  const [askPin, setAskPin] = useState(false);
  const state = settle(total, payments);
  const suggestions = [...new Set([state.remaining, ...[1000, 2000, 5000, 10000].map((n) => Math.ceil(state.remaining / n) * n)])].filter((v) => v > 0).slice(0, 5);

  const add = (value?: number) => {
    const v = value ?? parseAmount(amount || String(state.remaining));
    if (!v) return toast.error('Montant invalide');
    if (requiresReference(method) && !reference.trim()) return toast.error(`Saisissez la référence de la transaction ${PAYMENT_METHODS[method]}`);
    const next = [...payments, { method, amount: v, reference: reference.trim() || undefined }];
    try {
      settle(total, next);
    } catch (e) {
      return toast.error(e);
    }
    setPayments(next);
    setAmount('');
    setReference('');
    setMethod('CASH');
  };

  const finish = async (pin?: string) => {
    setBusy(true);
    try {
      await onPaid(payments, pin);
    } catch (e) {
      toast.error(e);
      setBusy(false);
    }
  };

  return (
    <Modal title="Encaissement" onClose={onClose} wide>
      <div className="pay-grid">
        <div>
          <div className="big-total">{fcfa(total)}</div>
          <div className="methods">
            {[...METHODS, ...(allowCredit ? (['CUSTOMER_CREDIT'] as PaymentMethod[]) : [])].map((m) => (
              <button key={m} className={method === m ? 'active' : ''} onClick={() => setMethod(m)}>
                {PAYMENT_METHODS[m]}
              </button>
            ))}
          </div>
          {!state.complete && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                add();
              }}
            >
              <Field label={`Montant ${PAYMENT_METHODS[method]}`}>
                <input autoFocus inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder={String(state.remaining)} />
              </Field>
              {requiresReference(method) && (
                <Field label="Référence de la transaction" hint="Numéro reçu par SMS de confirmation">
                  <input value={reference} onChange={(e) => setReference(e.target.value)} />
                </Field>
              )}
              {method === 'CASH' && (
                <div className="quick-cash">
                  {suggestions.map((v) => (
                    <button type="button" key={v} onClick={() => add(v)}>
                      {fcfa(v)}
                    </button>
                  ))}
                </div>
              )}
              <button type="submit" className="primary">
                Ajouter le paiement
              </button>
            </form>
          )}
        </div>
        <div>
          <table className="list">
            <tbody>
              {payments.map((p, i) => (
                <tr key={i}>
                  <td>
                    {PAYMENT_METHODS[p.method]}
                    {p.reference && <small> · {p.reference}</small>}
                  </td>
                  <td className="r">{fcfa(p.amount)}</td>
                  <td>
                    <button className="ghost" onClick={() => setPayments(payments.filter((_, j) => j !== i))}>
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="settle">
            <div>
              Reste à payer <strong>{fcfa(state.remaining)}</strong>
            </div>
            {state.change > 0 && (
              <div className="change">
                Rendu monnaie <strong>{fcfa(state.change)}</strong>
              </div>
            )}
          </div>
          <button className="primary big" disabled={!state.complete || busy} onClick={() => (needsSupervisor ? setAskPin(true) : finish())}>
            Valider le ticket
          </button>
        </div>
      </div>
      {askPin && (
        <SupervisorPrompt
          action="Le ticket comporte une remise."
          onCancel={() => setAskPin(false)}
          onConfirm={(pin) => {
            setAskPin(false);
            void finish(pin);
          }}
        />
      )}
    </Modal>
  );
}

export function HeldDialog({ onClose, onResume }: { onClose: () => void; onResume: (id: string) => void }) {
  const held = useLoad(() => call('pos.held'));
  return (
    <Modal title="Tickets en attente" onClose={onClose}>
      {held.data?.length === 0 && <Empty>Aucun ticket en attente.</Empty>}
      <div className="pick-list">
        {(held.data ?? []).map((h) => (
          <button key={h.id} onClick={() => onResume(h.id)}>
            <span>{h.label}</span>
            <span>{h.line_count} ligne(s)</span>
          </button>
        ))}
      </div>
    </Modal>
  );
}

export function CancelDialog({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const toast = useToast();
  const sales = useLoad(() => call('pos.sales', { sessionId }));
  const [target, setTarget] = useState<Result<'pos.sales'>[number] | null>(null);
  const [reason, setReason] = useState('');
  const [askPin, setAskPin] = useState(false);
  const list = (sales.data ?? []).filter((s) => s.kind === 'sale' && s.status === 'completed');
  return (
    <Modal title="Annuler un ticket" onClose={onClose}>
      {!target ? (
        <div className="pick-list">
          {list.length === 0 && <Empty>Aucun ticket dans cette session.</Empty>}
          {list.map((s) => (
            <button key={s.id} onClick={() => setTarget(s)}>
              <span>
                {s.number} · {dateTime(s.created_at)}
              </span>
              <span>{fcfa(s.total_ttc)}</span>
            </button>
          ))}
        </div>
      ) : (
        <>
          <p>
            Ticket {target.number} de {fcfa(target.total_ttc)}. Les articles seront remis en stock ; rendez le montant au client selon le moyen utilisé.
          </p>
          <Field label="Motif">
            <input autoFocus value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
          <div className="actions">
            <button className="ghost" onClick={() => setTarget(null)}>
              Retour
            </button>
            <button className="danger" disabled={!reason.trim()} onClick={() => setAskPin(true)}>
              Annuler le ticket
            </button>
          </div>
        </>
      )}
      {askPin && target && (
        <SupervisorPrompt
          action={`Annulation du ticket ${target.number}`}
          onCancel={() => setAskPin(false)}
          onConfirm={async (pin) => {
            setAskPin(false);
            try {
              await call('pos.cancel', target.id, pin, reason);
              toast.ok(`Ticket ${target.number} annulé`);
              onClose();
            } catch (e) {
              toast.error(e);
            }
          }}
        />
      )}
    </Modal>
  );
}

export function ReturnDialog({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const [number, setNumber] = useState('');
  const [sale, setSale] = useState<Result<'pos.sale'> | null>(null);
  const [qtys, setQtys] = useState<Record<string, number>>({});
  const [refund, setRefund] = useState<PaymentMethod>('CASH');
  const [reason, setReason] = useState('');
  const [askPin, setAskPin] = useState(false);
  const selected = sale ? sale.lines.filter((l) => (qtys[l.id] ?? 0) > 0) : [];
  const amount = selected.reduce((s, l) => s + Math.round((l.total_ttc * qtys[l.id]!) / l.qty), 0);
  return (
    <Modal title="Retour client" onClose={onClose} wide>
      {!sale ? (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              const found = await call('pos.findSale', number);
              if (!found || found.kind !== 'sale' || found.status !== 'completed') return toast.error('Ticket introuvable ou non éligible');
              setSale(found);
            } catch (err) {
              toast.error(err);
            }
          }}
        >
          <Field label="Numéro du ticket" hint="Imprimé sur le ticket du client, ex. DLA1-1-000123">
            <input autoFocus value={number} onChange={(e) => setNumber(e.target.value)} />
          </Field>
          <button className="primary" type="submit">
            Rechercher
          </button>
        </form>
      ) : (
        <>
          <p>
            Ticket {sale.number} du {dateTime(sale.created_at)} · {fcfa(sale.total_ttc)}
          </p>
          <table className="list">
            <thead>
              <tr>
                <th>Article</th>
                <th className="r">Vendu</th>
                <th className="r">Retourné</th>
              </tr>
            </thead>
            <tbody>
              {sale.lines.map((l) => (
                <tr key={l.id}>
                  <td>{l.label}</td>
                  <td className="r">{qty(l.qty, l.unit)}</td>
                  <td className="r">
                    {l.unit === 'piece' ? (
                      <input
                        className="qty"
                        type="number"
                        min={0}
                        max={l.qty / 1000}
                        value={(qtys[l.id] ?? 0) / 1000}
                        onChange={(e) => setQtys({ ...qtys, [l.id]: Math.max(0, Math.min(l.qty, Math.round(Number(e.target.value) * 1000))) })}
                      />
                    ) : (
                      <input type="checkbox" checked={(qtys[l.id] ?? 0) > 0} onChange={(e) => setQtys({ ...qtys, [l.id]: e.target.checked ? l.qty : 0 })} />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="grid2">
            <Field label="Remboursement">
              <select value={refund} onChange={(e) => setRefund(e.target.value as PaymentMethod)}>
                {[...METHODS, ...(sale.customer_id ? (['CUSTOMER_CREDIT'] as PaymentMethod[]) : [])].map((m) => (
                  <option key={m} value={m}>
                    {PAYMENT_METHODS[m]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Motif">
              <input value={reason} onChange={(e) => setReason(e.target.value)} />
            </Field>
          </div>
          <div className="actions">
            <span className="big-total">{fcfa(amount)}</span>
            <button className="primary" disabled={!selected.length || !reason.trim()} onClick={() => setAskPin(true)}>
              Valider le retour
            </button>
          </div>
        </>
      )}
      {askPin && sale && (
        <SupervisorPrompt
          action={`Retour de ${fcfa(amount)} sur le ticket ${sale.number}`}
          onCancel={() => setAskPin(false)}
          onConfirm={async (pin) => {
            setAskPin(false);
            try {
              const ret = await call('pos.return', {
                originalSaleId: sale.id,
                lines: selected.map((l) => ({ lineId: l.id, qty: qtys[l.id]! })),
                refundMethod: refund,
                supervisorPin: pin,
                reason,
              });
              toast.ok(`Retour ${ret.number} enregistré`);
              call('pos.printTicket', ret.id).catch(toast.error);
              onClose();
            } catch (e) {
              toast.error(e);
            }
          }}
        />
      )}
    </Modal>
  );
}

export function CashOpDialog({ type, needsSupervisor, onClose }: { type: 'IN' | 'OUT'; needsSupervisor: boolean; onClose: () => void }) {
  const toast = useToast();
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState(type === 'OUT' ? 'Mise au coffre' : 'Complément de fond');
  const [askPin, setAskPin] = useState(false);
  const submit = async (pin?: string) => {
    try {
      await call('pos.cashOperation', type, parseAmount(amount) ?? 0, reason, pin);
      toast.ok(type === 'IN' ? 'Apport enregistré' : 'Prélèvement enregistré');
      onClose();
    } catch (e) {
      toast.error(e);
    }
  };
  return (
    <Modal title={type === 'IN' ? 'Apport d’espèces' : 'Prélèvement d’espèces'} onClose={onClose}>
      <Field label="Montant (FCFA)">
        <input autoFocus inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} />
      </Field>
      <Field label="Motif">
        <input value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
      <div className="actions">
        <button className="primary" disabled={!parseAmount(amount)} onClick={() => (type === 'OUT' && needsSupervisor ? setAskPin(true) : submit())}>
          Enregistrer
        </button>
      </div>
      {askPin && (
        <SupervisorPrompt
          action={`Prélèvement de ${fcfa(parseAmount(amount) ?? 0)}`}
          onCancel={() => setAskPin(false)}
          onConfirm={(pin) => {
            setAskPin(false);
            void submit(pin);
          }}
        />
      )}
    </Modal>
  );
}

/** Clôture Z : comptage par coupure, écart avec le théorique. */
export function CloseDialog({ sessionId, onClose, onClosed }: { sessionId: string; onClose: () => void; onClosed: () => void }) {
  const toast = useToast();
  const [count, setCount] = useState<Record<number, number>>({});
  const [report, setReport] = useState<Result<'pos.close'> | null>(null);
  const counted = countedTotal(count);
  return (
    <Modal title={report ? `Rapport Z n° ${report.session.z_number}` : 'Clôture de caisse'} onClose={report ? onClosed : onClose} wide>
      {!report ? (
        <>
          <p>Comptez les espèces du tiroir par coupure. Le montant théorique s'affichera après validation.</p>
          <div className="denoms">
            {DENOMINATIONS_FCFA.map((d) => (
              <label key={d}>
                <span>{fcfa(d)}</span>
                <input
                  type="number"
                  min={0}
                  value={count[d] ?? ''}
                  onChange={(e) => setCount({ ...count, [d]: Math.max(0, Math.floor(Number(e.target.value) || 0)) })}
                />
                <small>{fcfa(d * (count[d] ?? 0))}</small>
              </label>
            ))}
          </div>
          <div className="actions">
            <span className="big-total">{fcfa(counted)}</span>
            <button
              className="danger"
              onClick={async () => {
                if (!confirm(`Clôturer la caisse avec ${fcfa(counted)} comptés ?`)) return;
                try {
                  const z = await call('pos.close', count);
                  setReport(z);
                  call('pos.printZ', sessionId).catch(toast.error);
                } catch (e) {
                  toast.error(e);
                }
              }}
            >
              Clôturer et imprimer le Z
            </button>
          </div>
        </>
      ) : (
        <ZView z={report} />
      )}
    </Modal>
  );
}

export function ZView({ z }: { z: Result<'pos.zReport'> }) {
  const diffClass = z.difference === null ? '' : z.difference < 0 ? 'neg' : z.difference > 0 ? 'pos' : '';
  return (
    <div className="zview">
      <div className="kpis">
        <div>
          <small>Tickets</small>
          <strong>{z.ticketCount}</strong>
        </div>
        <div>
          <small>CA net TTC</small>
          <strong>{fcfa(z.netTtc)}</strong>
        </div>
        <div>
          <small>Espèces théoriques</small>
          <strong>{fcfa(z.cash.expected)}</strong>
        </div>
        <div className={diffClass}>
          <small>Écart</small>
          <strong>{z.difference === null ? '—' : fcfa(z.difference)}</strong>
        </div>
      </div>
      <div className="grid2">
        <table className="list">
          <caption>Encaissements</caption>
          <tbody>
            {z.byMethod.map((m) => (
              <tr key={m.method}>
                <td>{m.label}</td>
                <td className="r">{fcfa(m.amount)}</td>
              </tr>
            ))}
            {z.customerReceipts.map((m) => (
              <tr key={`rc-${m.method}`}>
                <td>Règlement client · {m.label}</td>
                <td className="r">{fcfa(m.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <table className="list">
          <caption>Espèces</caption>
          <tbody>
            <tr><td>Fond de caisse</td><td className="r">{fcfa(z.cash.openingFloat)}</td></tr>
            <tr><td>Ventes espèces</td><td className="r">{fcfa(z.cash.cashSales)}</td></tr>
            <tr><td>Remboursements</td><td className="r">{fcfa(-z.cash.cashRefunds)}</td></tr>
            <tr><td>Apports</td><td className="r">{fcfa(z.cash.cashIn)}</td></tr>
            <tr><td>Prélèvements</td><td className="r">{fcfa(-z.cash.cashOut)}</td></tr>
            {z.cash.customerReceipts > 0 && <tr><td>Règlements clients</td><td className="r">{fcfa(z.cash.customerReceipts)}</td></tr>}
            <tr><td>Compté</td><td className="r">{z.counted === null ? '—' : fcfa(z.counted)}</td></tr>
          </tbody>
        </table>
        <table className="list">
          <caption>TVA</caption>
          <tbody>
            {z.vat.map((v) => (
              <tr key={v.rate}>
                <td>
                  {formatRate(v.rate)} sur {fcfa(v.ht)} HT
                </td>
                <td className="r">{fcfa(v.tva)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <table className="list">
          <caption>Contrôles</caption>
          <tbody>
            <tr><td>Ventes TTC</td><td className="r">{fcfa(z.salesTtc)}</td></tr>
            <tr><td>Retours</td><td className="r">{fcfa(z.returnsTtc)}</td></tr>
            <tr><td>Remises accordées</td><td className="r">{fcfa(z.discounts)}</td></tr>
            <tr><td>Annulations ({z.cancelled.count})</td><td className="r">{fcfa(z.cancelled.amount)}</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
