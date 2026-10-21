import { useEffect, useState } from 'react';
import { DENOMINATIONS_FCFA, type LoyaltyRules, PAYMENT_METHODS, type Payment, type PaymentMethod, countedTotal, formatRate, maxRedeemable, paymentRegisterKind, pointsForAmount, requiresReference, roundCash, settle } from '@superette/core';
import { type Result, call } from '../api';
import { Empty, Field, Modal, SupervisorPrompt, dateTime, fcfa, parseAmount, qty, useLoad, useStoreSettings, useToast } from '../ui';
import { hasVat, tx } from '../tax';

const METHODS: PaymentMethod[] = ['CASH', 'MTN_MOMO', 'ORANGE_MONEY', 'CARD', 'VOUCHER'];

/**
 * Moyens proposés au caissier : virement et chèque seulement s'il a une caisse
 * banque. Pour chaque moyen, la caisse qui le reçoit (électronique ou banque).
 */
function useMethods(): { methods: PaymentMethod[]; target: (m: PaymentMethod) => string | null } {
  const app = useLoad(() => call('app.state'), []);
  const linked = app.data?.linkedRegisters;
  const methods = linked?.bank ? [...METHODS, 'BANK_TRANSFER', 'CHEQUE' as PaymentMethod] : METHODS;
  const target = (m: PaymentMethod) => {
    const kind = paymentRegisterKind(m);
    return kind === 'cash' ? null : (linked?.[kind]?.name ?? null);
  };
  return { methods: methods as PaymentMethod[], target };
}

/** Règlement : paiements mixtes, rendu monnaie, références mobile money. */
export function PaymentDialog({
  total,
  needsSupervisor,
  cashRounding = 1,
  allowCredit = false,
  loyalty = null,
  payerPhone = null,
  onClose,
  onPaid,
}: {
  total: number;
  needsSupervisor: boolean;
  /** Arrondi des ventes payées tout en espèces (Paramètres › Ventes et caisse). */
  cashRounding?: number;
  /** Un client est choisi : le reste peut aller à son compte. */
  allowCredit?: boolean;
  /** Carte de fidélité du client choisi : il peut payer avec ses points. */
  loyalty?: { balance: number; rules: LoyaltyRules } | null;
  /** Téléphone du client choisi, proposé pour la demande de paiement mobile. */
  payerPhone?: string | null;
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
  const { methods, target } = useMethods();
  const auto = useLoad(() => call('mobilepay.methods'), []);
  const autoMethod = method === 'MTN_MOMO' || method === 'ORANGE_MONEY' ? (auto.data ?? []).includes(method) : false;
  // Tant que tout est payé en espèces, le total descend à l'arrondi réglé.
  const allCash = payments.every((p) => p.method === 'CASH') && (payments.length > 0 || method === 'CASH');
  const due = allCash ? roundCash(total, cashRounding) : total;
  const state = settle(due, payments);
  // Points pas encore utilisés sur ce ticket, et montant payable avec.
  const pointsLeft = loyalty ? loyalty.balance - payments.filter((p) => p.method === 'LOYALTY').reduce((t, p) => t + p.amount / loyalty.rules.pointValue, 0) : 0;
  const usedPoints = loyalty ? loyalty.balance - pointsLeft : 0;
  const redeemable = loyalty ? (usedPoints > 0 ? Math.min(pointsLeft * loyalty.rules.pointValue, Math.floor(state.remaining / loyalty.rules.pointValue) * loyalty.rules.pointValue) : maxRedeemable(loyalty.balance, state.remaining, loyalty.rules)) : 0;
  const suggestions = [...new Set([state.remaining, ...[1000, 2000, 5000, 10000].map((n) => Math.ceil(state.remaining / n) * n)])].filter((v) => v > 0).slice(0, 5);

  /** Vérifie un paiement avant de l'ajouter, ou avant d'envoyer la demande au téléphone du client. */
  const check = (v: number | null, ref: string): Payment[] | null => {
    if (!v) return (toast.error('Montant invalide'), null);
    const next = [...payments, { method, amount: v, reference: ref.trim() || undefined }];
    try {
      settle(next.every((p) => p.method === 'CASH') ? roundCash(total, cashRounding) : total, next);
    } catch (e) {
      return (toast.error(e), null);
    }
    return next;
  };

  const add = (value?: number) => {
    const v = value ?? parseAmount(amount || String(method === 'LOYALTY' ? redeemable : state.remaining));
    if (!v) return toast.error('Montant invalide');
    if (method === 'LOYALTY' && loyalty) {
      try {
        if (pointsForAmount(v, loyalty.rules) > pointsLeft) return toast.error(`Points insuffisants : ${pointsLeft} disponibles`);
      } catch (e) {
        return toast.error(e);
      }
      if (loyalty.balance < loyalty.rules.minRedeem) return toast.error(`Il faut au moins ${loyalty.rules.minRedeem} points pour payer avec`);
    }
    if (requiresReference(method) && !reference.trim()) return toast.error(`Saisissez la référence de la transaction ${PAYMENT_METHODS[method]}`);
    const next = [...payments, { method, amount: v, reference: reference.trim() || undefined }];
    try {
      settle(next.every((p) => p.method === 'CASH') ? roundCash(total, cashRounding) : total, next);
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
          <div className="big-total">{fcfa(due)}</div>
          {due < total && <p className="muted">Arrondi espèces : {fcfa(total - due)} de moins (total exact {fcfa(total)})</p>}
          <div className="methods">
            {[...methods, ...(allowCredit ? (['CUSTOMER_CREDIT'] as PaymentMethod[]) : [])].map((m) => (
              <button key={m} className={method === m ? 'active' : ''} onClick={() => setMethod(m)}>
                {PAYMENT_METHODS[m]}
              </button>
            ))}
            {loyalty && (
              <button
                className={method === 'LOYALTY' ? 'active' : ''}
                disabled={redeemable <= 0}
                title={redeemable <= 0 ? `Il faut au moins ${loyalty.rules.minRedeem} points (solde : ${pointsLeft})` : `Jusqu'à ${fcfa(redeemable)}`}
                onClick={() => setMethod('LOYALTY')}
              >
                Points fidélité ({pointsLeft} pts)
              </button>
            )}
          </div>
          {method === 'LOYALTY' && loyalty && (
            <p className="muted method-target">
              {pointsLeft} points, soit {fcfa(pointsLeft * loyalty.rules.pointValue)} ; payable sur ce ticket : {fcfa(redeemable)}
            </p>
          )}
          {target(method) && <p className="muted method-target">Encaissé sur {target(method)}</p>}
          {!state.complete && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                add();
              }}
            >
              <Field label={`Montant ${PAYMENT_METHODS[method]}`}>
                <input autoFocus inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder={String(method === 'LOYALTY' ? redeemable : state.remaining)} />
              </Field>
              {autoMethod && (
                <MobilePayRequest
                  method={method as 'MTN_MOMO' | 'ORANGE_MONEY'}
                  amount={() => {
                    const v = parseAmount(amount || String(state.remaining));
                    return check(v, 'auto') ? v : null;
                  }}
                  phone={payerPhone}
                  onPaid={(v, ref) => {
                    const next = check(v, ref);
                    if (!next) return;
                    setPayments(next);
                    setAmount('');
                    setReference('');
                    setMethod('CASH');
                    toast.ok(`${PAYMENT_METHODS[method]} : ${fcfa(v)} reçus`);
                  }}
                />
              )}
              {requiresReference(method) && (
                <Field
                  label={method === 'CHEQUE' ? 'Numéro du chèque' : 'Référence de la transaction'}
                  hint={method === 'CHEQUE' ? 'Banque et numéro inscrits sur le chèque' : method === 'BANK_TRANSFER' ? 'Référence du virement sur le relevé' : 'Numéro reçu par SMS de confirmation'}
                >
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

/**
 * Demande de paiement envoyée au téléphone du client (MTN MoMo, Orange Money) :
 * le client confirme avec son code, la caisse ajoute le paiement avec le
 * numéro de transaction, sans saisie.
 */
function MobilePayRequest({ method, amount, phone, onPaid }: { method: 'MTN_MOMO' | 'ORANGE_MONEY'; amount: () => number | null; phone: string | null; onPaid: (amount: number, reference: string) => void }) {
  const toast = useToast();
  const [number, setNumber] = useState(phone ?? '');
  const [request, setRequest] = useState<Result<'mobilepay.request'> | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!request || request.status !== 'pending') return;
    let stop = false;
    const timer = setInterval(async () => {
      try {
        const r = await call('mobilepay.status', request.id);
        if (stop) return;
        if (r.status === 'success') {
          setRequest(null);
          onPaid(r.amount, r.transaction_id ?? r.id);
        } else if (r.status !== 'pending') {
          setRequest(null);
          setError(r.reason ?? 'Paiement refusé');
        }
      } catch {
        // Réseau coupé un instant : on réessaie au tour suivant.
      }
    }, 3000);
    return () => {
      stop = true;
      clearInterval(timer);
    };
  }, [request?.id]);

  if (request) {
    return (
      <div className="mobile-pay pending">
        <div>
          <b>En attente du client</b> : demande de {fcfa(request.amount)} envoyée au {request.phone}. Le client confirme avec son code secret {method === 'MTN_MOMO' ? 'MTN MoMo' : 'Orange Money'}.
          {request.mode === 'simulation' && <small className="muted"> (simulation : confirmé dans quelques secondes)</small>}
        </div>
        <button
          type="button"
          className="ghost"
          onClick={async () => {
            await call('mobilepay.cancel', request.id).catch(toast.error);
            setRequest(null);
          }}
        >
          Abandonner
        </button>
      </div>
    );
  }
  return (
    <div className="mobile-pay">
      <Field label="Téléphone du client" hint="Le client reçoit la demande de paiement et confirme avec son code ; la référence s'ajoute toute seule.">
        <div className="inline">
          <input inputMode="tel" value={number} onChange={(e) => setNumber(e.target.value)} placeholder="6XX XX XX XX" />
          <button
            type="button"
            className="primary"
            disabled={!number.trim()}
            onClick={async () => {
              const v = amount();
              if (!v) return;
              setError(null);
              try {
                setRequest(await call('mobilepay.request', { method, phone: number, amount: v, label: 'Achat en magasin' }));
              } catch (e) {
                setError(e instanceof Error ? e.message : String(e));
              }
            }}
          >
            Demander le paiement
          </button>
        </div>
      </Field>
      {error && <p className="neg">{error}</p>}
      <p className="muted">Ou saisissez ci-dessous la référence reçue par SMS si le client a payé autrement.</p>
    </div>
  );
}

export function HeldDialog({ onClose, onResume, onTakeCart }: { onClose: () => void; onResume: (id: string) => void; onTakeCart?: (id: string) => void }) {
  const held = useLoad(() => call('pos.held'));
  const carts = useLoad(() => call('pos.shelfCarts'));
  return (
    <Modal title="Tickets en attente" onClose={onClose}>
      {Boolean(carts.data?.length) && onTakeCart && (
        <>
          <h3>Paniers des vendeurs</h3>
          <div className="pick-list">
            {carts.data!.map((c) => (
              <button key={c.id} onClick={() => onTakeCart(c.id)}>
                <span>
                  Panier n° {c.number} · {c.sellerName}
                  {c.label ? ` · ${c.label}` : ''} · {new Date(c.at).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}
                </span>
                <span>{c.lines} ligne(s)</span>
              </button>
            ))}
          </div>
          <h3>Tickets mis en attente</h3>
        </>
      )}
      {Boolean(held.data?.length) && <p className="muted">Entrée reprend le ticket sélectionné, ↑ ↓ pour changer.</p>}
      {held.data?.length === 0 && <Empty>Aucun ticket en attente. À la caisse, F3 met la fiche en cours en attente pour servir un autre client.</Empty>}
      <div
        className="pick-list"
        onKeyDown={(e) => {
          if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
          e.preventDefault();
          const b = [...e.currentTarget.querySelectorAll('button')];
          const at = b.indexOf(document.activeElement as HTMLButtonElement);
          b[Math.max(0, Math.min(b.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)))]?.focus();
        }}
      >
        {(held.data ?? []).map((h, i) => (
          <button key={h.id} autoFocus={i === 0} onClick={() => onResume(h.id)}>
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
          {list.length === 0 && <Empty>Aucun ticket dans cette session. Les tickets validés depuis l’ouverture de la caisse s’affichent ici.</Empty>}
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

export function ReturnDialog({ onClose, initialSale = null }: { onClose: () => void; initialSale?: Result<'pos.sale'> | null }) {
  const toast = useToast();
  const [number, setNumber] = useState('');
  const [sale, setSale] = useState<Result<'pos.sale'> | null>(initialSale && initialSale.kind === 'sale' && initialSale.status === 'completed' ? initialSale : null);
  const [qtys, setQtys] = useState<Record<string, number>>({});
  const [refund, setRefund] = useState<PaymentMethod>('CASH');
  const { methods } = useMethods();
  const [reason, setReason] = useState('');
  const [askPin, setAskPin] = useState(false);
  const loyaltyOn = useStoreSettings().loyaltyEnabled;
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
                {[...methods, ...(sale.customer_id ? (['CUSTOMER_CREDIT', ...(loyaltyOn ? ['LOYALTY'] : [])] as PaymentMethod[]) : [])].map((m) => (
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
              call('pos.printTicket', ret.id, { newSale: true }).catch(toast.error);
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

/**
 * Ticket retrouvé en scannant son code-barres : retour (toujours avec le code
 * du gérant), réimpression du ticket (DUPLICATA) ou facture A4.
 */
export function ScannedTicketDialog({ sale, canReturn, canReprint, onReturn, onClose }: { sale: Result<'pos.sale'>; canReturn: boolean; canReprint: boolean; onReturn: () => void; onClose: () => void }) {
  const toast = useToast();
  const returnable = sale.kind === 'sale' && sale.status === 'completed';
  return (
    <Modal title={`Ticket ${sale.number}`} onClose={onClose}>
      <p>
        {dateTime(sale.created_at)} · <b>{fcfa(sale.total_ttc)}</b> · {sale.lines.length} article{sale.lines.length > 1 ? 's' : ''}
        {sale.status !== 'completed' && <span className="tag rupture"> annulé</span>}
        {sale.kind !== 'sale' && <span className="tag alerte"> retour</span>}
      </p>
      <ul className="plain">
        {sale.lines.slice(0, 8).map((l) => (
          <li key={l.id}>
            {l.label} <small className="muted">× {qty(l.qty, l.unit)}</small>
          </li>
        ))}
        {sale.lines.length > 8 && <li className="muted">…</li>}
      </ul>
      <div className="actions">
        <button type="button" onClick={onClose}>
          Fermer
        </button>
        <button type="button" disabled={!canReprint} onClick={() => call('pos.printTicket', sale.id).then(onClose, toast.error)} title={canReprint ? '' : "Vous n'avez pas le droit de réimprimer"}>
          Réimprimer le ticket
        </button>
        <button type="button" onClick={() => call('pos.printInvoice', sale.id).then(onClose, toast.error)}>
          Facture A4
        </button>
        <button type="button" className="primary" disabled={!canReturn || !returnable} onClick={onReturn} title="Le retour demande toujours le code du gérant">
          Retour d'articles…
        </button>
      </div>
    </Modal>
  );
}

export function CashOpDialog({ type, needsSupervisor, onClose }: { type: 'IN' | 'OUT'; needsSupervisor: boolean; onClose: () => void }) {
  const toast = useToast();
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState(type === 'OUT' ? 'Versement à la caisse centrale' : 'Complément de fond');
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
      <p className="muted">
        {type === 'OUT' ? 'Les espèces prélevées entrent dans la caisse centrale.' : 'Les espèces apportées sortent de la caisse centrale.'}
      </p>
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

export function ZView({ z, compact = false }: { z: Result<'pos.zReport'>; compact?: boolean }) {
  const diffClass = z.difference === null ? '' : z.difference < 0 ? 'neg' : z.difference > 0 ? 'pos' : '';
  if (z.declared) return <DeclaredZView z={z} lines={z.declared} diffClass={diffClass} compact={compact} />;
  return (
    <div className="zview">
      <div className="kpis">
        <div>
          <small>Tickets</small>
          <strong>{z.ticketCount}</strong>
        </div>
        <div>
          <small>{tx('CA net TTC')}</small>
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
            {z.elsewhere.map((m) => (
              <tr key={`ew-${m.method}-${m.registerName}`} className="muted">
                <td>
                  {m.label} (sur {m.registerName})
                </td>
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
            {z.cash.expenses > 0 && (
              <tr title={z.expenses.map((e) => `${e.number} ${e.label}`).join('\n')}>
                <td>Dépenses payées ({z.expenses.length})</td>
                <td className="r">{fcfa(-z.cash.expenses)}</td>
              </tr>
            )}
            {z.cash.otherIn > 0 && <tr><td>Autres entrées (Encaisser)</td><td className="r">{fcfa(z.cash.otherIn)}</td></tr>}
            {z.cash.otherOut > 0 && <tr><td>Autres sorties (Décaisser)</td><td className="r">{fcfa(-z.cash.otherOut)}</td></tr>}
            <tr><td>Compté</td><td className="r">{z.counted === null ? '—' : fcfa(z.counted)}</td></tr>
            {z.session.deposit !== null && <tr><td>Versé à la caisse centrale</td><td className="r">{fcfa(z.session.deposit)}</td></tr>}
            {z.session.float_left !== null && <tr><td>Fond laissé dans le tiroir</td><td className="r">{fcfa(z.session.float_left)}</td></tr>}
          </tbody>
        </table>
        {(hasVat() || z.vat.some((v) => v.rate > 0)) && (
          <table className="list">
            <caption>TVA</caption>
            <tbody>
              {!z.vat.some((v) => v.rate > 0) && (
                <tr>
                  <td colSpan={2}>TVA non applicable</td>
                </tr>
              )}
              {z.vat.filter((v) => v.rate > 0).map((v) => (
                <tr key={v.rate}>
                  <td>
                    {formatRate(v.rate)} sur {fcfa(v.ht)}{tx(' HT')}
                  </td>
                  <td className="r">{fcfa(v.tva)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <table className="list">
          <caption>Contrôles</caption>
          <tbody>
            <tr><td>{tx('Ventes TTC')}</td><td className="r">{fcfa(z.salesTtc)}</td></tr>
            <tr><td>Retours</td><td className="r">{fcfa(z.returnsTtc)}</td></tr>
            <tr><td>Remises accordées</td><td className="r">{fcfa(z.discounts)}</td></tr>
            <tr><td>Annulations ({z.cancelled.count})</td><td className="r">{fcfa(z.cancelled.amount)}</td></tr>
          </tbody>
        </table>
        {z.byCashier.length > 0 && (
          <table className="list">
            <caption>Par caissier{z.handovers.length ? ` (${z.handovers.length} relève${z.handovers.length > 1 ? 's' : ''})` : ''}</caption>
            <thead>
              <tr>
                <th>Caissier</th>
                <th className="r">Tickets</th>
                <th className="r">Net TTC</th>
                <th className="r">Écart</th>
              </tr>
            </thead>
            <tbody>
              {z.byCashier.map((c) => (
                <tr key={c.user_id}>
                  <td>{c.name}</td>
                  <td className="r">{c.tickets}</td>
                  <td className="r">{fcfa(c.net)}</td>
                  <td className={`r ${c.difference && c.difference < 0 ? 'neg' : ''}`}>{c.difference === null ? '—' : fcfa(c.difference)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

/** Z d'une caisse électronique ou banque : encaissé, solde relevé et écart par moyen, puis les règlements clients. */
function DeclaredZView({ z, lines, diffClass, compact }: { z: Result<'pos.zReport'>; lines: NonNullable<Result<'pos.zReport'>['declared']>; diffClass: string; compact: boolean }) {
  const expected = lines.reduce((t, l) => t + l.expected, 0);
  const electronic = z.registerKind === 'electronic';
  const has = (f: (l: (typeof lines)[number]) => number | null) => lines.some((l) => (f(l) ?? 0) !== 0);
  const opening = electronic && has((l) => l.opening);
  const moves = electronic && (has((l) => l.outflows) || has((l) => l.inflows));
  const deposit = electronic && has((l) => l.deposited);
  const cell = (v: number | null) => <td className="r">{v === null ? '—' : fcfa(v)}</td>;
  return (
    <div className="zview">
      {!compact && (
        <div className="kpis">
          <div>
            <small>{electronic ? 'Attendu' : 'Encaissé'}</small>
            <strong>{fcfa(expected)}</strong>
          </div>
          <div>
            <small>Solde relevé</small>
            <strong>{z.counted === null ? '—' : fcfa(z.counted)}</strong>
          </div>
          <div className={diffClass}>
            <small>Écart</small>
            <strong>{z.difference === null ? '—' : fcfa(z.difference)}</strong>
          </div>
        </div>
      )}
      <table className="list">
        <thead>
          <tr>
            <th>Moyen</th>
            {opening && <th className="r">Solde de départ</th>}
            <th className="r">Encaissé</th>
            {moves && <th className="r">Transferts reçus</th>}
            {moves && <th className="r">Sorties</th>}
            {electronic && <th className="r">Attendu</th>}
            <th className="r">Solde relevé</th>
            <th className="r">Écart</th>
            {deposit && <th className="r">Versé à la centrale</th>}
            {deposit && <th className="r">Reste</th>}
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => {
            const gap = l.declared === null ? null : l.declared - l.expected;
            return (
              <tr key={l.method}>
                <td>{l.label}</td>
                {opening && cell(l.opening)}
                {cell(electronic ? l.received : l.expected)}
                {moves && cell(l.inflows)}
                {moves && cell(-l.outflows)}
                {electronic && cell(l.expected)}
                {cell(l.declared)}
                <td className={`r ${gap ? (gap < 0 ? 'neg' : 'pos') : ''}`}>{gap === null ? '—' : fcfa(gap)}</td>
                {deposit && cell(l.deposited)}
                {deposit && cell(l.left)}
              </tr>
            );
          })}
        </tbody>
      </table>
      {z.emoneyDeposit && (
        <p className="muted">
          Versement {z.emoneyDeposit.number} vers {z.emoneyDeposit.centralName}.
        </p>
      )}
      {z.customerReceipts.length > 0 && (
        <p className="muted">Dont règlements clients : {z.customerReceipts.map((m) => `${m.label} ${fcfa(m.amount)}`).join(', ')}</p>
      )}
    </div>
  );
}

/**
 * Ticket envoyé au client par WhatsApp : le numéro de sa fiche est proposé,
 * la facture A4 peut être enregistrée en PDF pour la joindre au message.
 */
export function WhatsappTicketDialog({ saleId, number, onClose }: { saleId: string; number: string; onClose: () => void }) {
  const toast = useToast();
  const [phone, setPhone] = useState('');
  const [pdf, setPdf] = useState(false);
  useEffect(() => {
    call('pos.ticketPhone', saleId).then((p) => p && setPhone(p), () => undefined);
  }, [saleId]);
  return (
    <Modal title={`Envoyer le ticket ${number} par WhatsApp`} onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            if (pdf && !(await call('pos.printInvoice', saleId, { output: 'pdf' }))) return;
            const r = await call('pos.whatsappTicket', saleId, phone);
            window.open(r.link);
            toast.ok(pdf ? 'WhatsApp est ouvert : joignez le PDF enregistré, puis envoyez.' : 'WhatsApp est ouvert avec le ticket : il ne reste qu’à envoyer.');
            onClose();
          } catch (err) {
            toast.error(err);
          }
        }}
      >
        <Field label="Numéro WhatsApp du client" hint="9 chiffres : l’indicatif 237 est ajouté.">
          <input autoFocus inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="6XX XX XX XX" required />
        </Field>
        <label className="inline">
          <input type="checkbox" checked={pdf} onChange={(e) => setPdf(e.target.checked)} /> Enregistrer aussi la facture A4 en PDF pour la joindre
        </label>
        <div className="actions">
          <button className="primary" type="submit">
            Ouvrir WhatsApp
          </button>
        </div>
      </form>
    </Modal>
  );
}

type ContainerNeed = Result<'containers.needsFor'>[number];

/**
 * Consigne des emballages au comptoir : emballages qui partent avec le client
 * et vides qu'il rapporte. La différence s'encaisse ou se rend en espèces dans
 * la journée de la caisse. Après une vente, les emballages des articles vendus
 * sont proposés ; sans vente, la fenêtre sert aux retours de vides.
 */
export function ContainerCounterDialog({
  saleId = null,
  needs = [],
  customer: initialCustomer = null,
  clientName: initialName = '',
  onClose,
  onDone,
}: {
  saleId?: string | null;
  needs?: ContainerNeed[];
  customer?: { id: string; name: string } | null;
  clientName?: string | null;
  onClose: () => void;
  onDone?: () => void;
}) {
  const toast = useToast();
  const types = useLoad(() => call('containers.types'), []);
  const [customer, setCustomer] = useState(initialCustomer);
  const [clientName, setClientName] = useState(initialName ?? '');
  const [search, setSearch] = useState('');
  const found = useLoad(() => (search.trim().length >= 2 ? call('customers.list', { search: search.trim() }) : Promise.resolve([])), [search]);
  const [rows, setRows] = useState<Record<string, { out: string; back: string }>>(() =>
    Object.fromEntries(needs.map((n) => [n.container_id, { out: String(n.count), back: '0' }])),
  );
  const [onAccount, setOnAccount] = useState(false);
  const [busy, setBusy] = useState(false);
  const count = (v: string | undefined) => {
    const n = Number((v ?? '').trim() || '0');
    return Number.isSafeInteger(n) && n >= 0 ? n : null;
  };
  // Les emballages de la vente d'abord, puis les autres.
  const list = [...(types.data ?? [])].sort((a, b) => Number(Boolean(rows[b.id])) - Number(Boolean(rows[a.id])));
  const invalid = list.some((t) => count(rows[t.id]?.out) === null || count(rows[t.id]?.back) === null);
  const lines = list.map((t) => ({ containerId: t.id, out: count(rows[t.id]?.out) ?? 0, back: count(rows[t.id]?.back) ?? 0, deposit: t.deposit }));
  const net = onAccount ? 0 : lines.reduce((s, l) => s + (l.out - l.back) * l.deposit, 0);
  const empty = !lines.some((l) => l.out > 0 || l.back > 0);
  const set = (id: string, patch: Partial<{ out: string; back: string }>) => setRows({ ...rows, [id]: { out: '0', back: '0', ...rows[id], ...patch } });

  const save = async () => {
    setBusy(true);
    try {
      await call('containers.counter', {
        lines: lines.map(({ containerId, out, back }) => ({ containerId, out, back })),
        saleId,
        customerId: customer?.id ?? null,
        clientName: customer ? null : clientName.trim() || null,
        onAccount: onAccount && Boolean(customer),
      });
      toast.ok(net > 0 ? `Consigne encaissée : ${fcfa(net)}` : net < 0 ? `Consigne rendue : ${fcfa(-net)}` : 'Emballages enregistrés');
      onDone?.();
      onClose();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Consigne des emballages" onClose={onClose} wide>
      {saleId && <p className="muted">Emballages des articles vendus : corrigez si le client rapporte des vides ou garde moins d'emballages.</p>}
      <div className="grid3">
        {customer ? (
          <Field label="Client en compte">
            <span className="inline">
              <b>{customer.name}</b>
              <button
                type="button"
                className="link"
                onClick={() => {
                  setCustomer(null);
                  setOnAccount(false);
                }}
              >
                Changer
              </button>
            </span>
          </Field>
        ) : (
          <>
            <Field label="Client en compte (facultatif)">
              <input placeholder="Nom, code ou téléphone" value={search} onChange={(e) => setSearch(e.target.value)} />
            </Field>
            <Field label="Nom du client comptoir" hint="Facultatif">
              <input value={clientName} onChange={(e) => setClientName(e.target.value)} />
            </Field>
          </>
        )}
      </div>
      {!customer && (found.data ?? []).length > 0 && (
        <div className="inline">
          {(found.data ?? []).slice(0, 6).map((c) => (
            <button
              type="button"
              key={c.id}
              onClick={() => {
                setCustomer({ id: c.id, name: c.name });
                setSearch('');
              }}
            >
              {c.name}
            </button>
          ))}
        </div>
      )}
      {types.data && types.data.length === 0 ? (
        <Empty>Aucun emballage consigné. Le gérant les crée dans Stock › Emballages consignés.</Empty>
      ) : (
        <table className="list compact">
          <thead>
            <tr>
              <th>Emballage</th>
              <th className="r">Consigne</th>
              <th className="r">Sortis</th>
              <th className="r">Rapportés</th>
              <th className="r">Montant</th>
            </tr>
          </thead>
          <tbody>
            {list.map((t) => {
              const l = lines.find((x) => x.containerId === t.id)!;
              return (
                <tr key={t.id}>
                  <td>{t.name}</td>
                  <td className="r">{fcfa(t.deposit)}</td>
                  <td className="r">
                    <input className="num" inputMode="numeric" value={rows[t.id]?.out ?? '0'} onChange={(e) => set(t.id, { out: e.target.value })} />
                  </td>
                  <td className="r">
                    <input className="num" inputMode="numeric" value={rows[t.id]?.back ?? '0'} onChange={(e) => set(t.id, { back: e.target.value })} />
                  </td>
                  <td className="r">{onAccount || l.out === l.back ? '' : fcfa((l.out - l.back) * t.deposit)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <label className="inline">
        <input type="checkbox" checked={onAccount} disabled={!customer} onChange={(e) => setOnAccount(e.target.checked)} /> Le client garde les emballages sans payer la
        consigne (client en compte)
      </label>
      {!customer && <p className="muted small">Choisissez un client en compte pour lui laisser les emballages sans consigne.</p>}
      <div className="kpis">
        <div className={net > 0 ? 'pos' : net < 0 ? 'neg' : ''}>
          <small>{net > 0 ? 'À encaisser' : net < 0 ? 'À rendre' : 'Rien à payer'}</small>
          <strong>{fcfa(Math.abs(net))}</strong>
        </div>
      </div>
      <div className="actions">
        <button type="button" onClick={onClose}>
          {saleId ? 'Passer' : 'Annuler'}
        </button>
        <button type="button" className="primary" disabled={busy || empty || invalid} onClick={save}>
          Enregistrer la consigne
        </button>
      </div>
    </Modal>
  );
}
