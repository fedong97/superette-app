import { type CartLine, computeTotals, lineTotal } from '@superette/core';
import { useState } from 'react';
import { type ApiError, type Result, call } from '../api';
import { Empty, Field, Modal, SupervisorPrompt, dateFr, fcfa, parseAmount, parseQty, qty, useLoad, useToast } from '../ui';
import { type Customer, CustomerPickDialog } from './customerDialogs';
import { ArticlePicker } from './pickers';

type User = NonNullable<Result<'app.state'>['user']>;
type Quote = Result<'quotes.get'>;
type Article = Result<'catalogue.get'>;
type State = Quote['state'];
type Kind = Quote['kind'];

export const QUOTE_KINDS: Record<Kind, string> = { quote: 'Devis', proforma: 'Facture proforma' };
const STATES: Record<State, [string, string]> = {
  open: ['en cours', 'normal'],
  expired: ['expiré', 'alerte'],
  accepted: ['facturé', 'surstock'],
  cancelled: ['annulé', ''],
};

function StateTag({ state }: { state: State }) {
  const [label, cls] = STATES[state];
  return <span className={`tag ${cls}`}>{label}</span>;
}

/** Devis et factures proforma : prix garantis au client jusqu'à la date de validité, puis facturés à la caisse. */
export function Quotes({ user }: { user: User }) {
  const [state, setState] = useState<State | ''>('open');
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<Quote | 'new' | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const list = useLoad(() => call('quotes.list', { state: state || undefined, search: search || undefined }), [state, search]);
  const rows = list.data ?? [];
  return (
    <div className="page">
      <header className="page-head">
        <h1>Devis et factures proforma</h1>
      </header>
      <div className="filters">
        <select value={state} onChange={(e) => setState(e.target.value as State | '')}>
          <option value="open">En cours</option>
          <option value="expired">Expirés</option>
          <option value="accepted">Facturés</option>
          <option value="cancelled">Annulés</option>
          <option value="">Tous</option>
        </select>
        <input placeholder="N°, client" value={search} onChange={(e) => setSearch(e.target.value)} />
        <button className="primary" style={{ marginLeft: 'auto' }} onClick={() => setEditing('new')}>
          Nouveau devis
        </button>
      </div>
      {rows.length === 0 ? (
        <Empty>Aucun document. Un devis ou une proforma fixe les prix pour le client ; pour le facturer, ouvrez la caisse puis Action › Facturer un devis / proforma.</Empty>
      ) : (
        <table className="list compact">
          <thead>
            <tr>
              <th>Date</th>
              <th>N°</th>
              <th>Type</th>
              <th>Client</th>
              <th>Valable jusqu'au</th>
              <th>État</th>
              <th className="r">Montant TTC</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((q) => (
              <tr key={q.id} className={`clickable ${q.state === 'cancelled' ? 'inactive' : ''}`} onClick={() => setOpen(q.id)}>
                <td>{dateFr(q.quote_date)}</td>
                <td className="nowrap">{q.number}</td>
                <td>{QUOTE_KINDS[q.kind]}</td>
                <td>{q.customer_name}</td>
                <td>{dateFr(q.valid_until)}</td>
                <td>
                  <StateTag state={q.state} />
                  {q.sale_number && <span className="muted"> {q.sale_number}</span>}
                </td>
                <td className="r">{fcfa(q.total_ttc)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {editing && (
        <QuoteEditor
          user={user}
          quote={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(q) => {
            setEditing(null);
            setOpen(q.id);
            list.reload();
          }}
        />
      )}
      {open && (
        <QuoteDetail
          id={open}
          onClose={() => setOpen(null)}
          onEdit={(q) => {
            setOpen(null);
            setEditing(q);
          }}
          onChanged={list.reload}
        />
      )}
    </div>
  );
}

interface DraftLine {
  key: number;
  article: Article;
  qty: string;
  discount: string;
}
let keySeq = 0;

function QuoteEditor({ user, quote, onClose, onSaved }: { user: User; quote: Quote | null; onClose: () => void; onSaved: (q: Quote) => void }) {
  const toast = useToast();
  const [kind, setKind] = useState<Kind>(quote?.kind ?? 'proforma');
  const [customer, setCustomer] = useState<{ id: string; name: string } | null>(quote?.customer_id ? { id: quote.customer_id, name: quote.customer_name ?? '' } : null);
  const [customerName, setCustomerName] = useState(quote && !quote.customer_id ? (quote.customer_name ?? '') : '');
  const [validDays, setValidDays] = useState(quote ? String(Math.max(1, daysBetween(quote.quote_date, quote.valid_until))) : '15');
  const [notes, setNotes] = useState(quote?.notes ?? '');
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [picking, setPicking] = useState(false);
  const [askPin, setAskPin] = useState(false);

  // Un devis modifié reprend ses articles, repris au prix du jour.
  useLoad(async () => {
    if (!quote) return;
    const arts = await Promise.all(quote.lines.map((l) => call('catalogue.get', l.article_id)));
    setLines(quote.lines.map((l, i) => ({ key: ++keySeq, article: arts[i]!, qty: String(l.qty / 1000).replace('.', ','), discount: l.discount ? String(l.discount) : '' })));
  }, [quote?.id]);

  const cart: (CartLine | null)[] = lines.map((l) => {
    const q = parseQty(l.qty);
    const d = l.discount ? parseAmount(l.discount) : 0;
    if (q === null || d === null) return null;
    return { articleId: l.article.id, label: l.article.name, unitPrice: l.article.store_price, qty: q, vatRate: l.article.vat_rate_bp, discount: d };
  });
  const valid = cart.every((c) => c !== null && lineTotal(c) >= 0);
  const totals = computeTotals(cart.filter((c): c is CartLine => c !== null));
  const days = Number(validDays);

  const add = (a: Article) => {
    const existing = lines.find((l) => l.article.id === a.id);
    if (existing) setLines(lines.map((l) => (l === existing ? { ...l, qty: String((parseQty(l.qty) ?? 0) / 1000 + 1).replace('.', ',') } : l)));
    else setLines([...lines, { key: ++keySeq, article: a, qty: '1', discount: '' }]);
  };
  const patch = (key: number, p: Partial<DraftLine>) => setLines(lines.map((l) => (l.key === key ? { ...l, ...p } : l)));

  const submit = async (pin?: string) => {
    try {
      const q = await call(
        'quotes.save',
        {
          kind,
          customerId: customer?.id ?? null,
          customerName: customer ? null : customerName || null,
          validDays: days,
          notes: notes || null,
          lines: cart.map((c) => ({ articleId: c!.articleId, qty: c!.qty, discount: c!.discount })),
        },
        quote?.id ?? null,
        pin,
      );
      toast.ok(`${q.number} enregistré`);
      onSaved(q);
    } catch (err) {
      if ((err as ApiError).code === 'SUPERVISOR_REQUIRED' && !pin) setAskPin(true);
      else toast.error(err);
    }
  };

  return (
    <Modal title={quote ? `Modifier ${quote.number}` : 'Nouveau devis'} onClose={onClose} wide>
      <div>
        <div className="methods">
          {(Object.keys(QUOTE_KINDS) as Kind[]).map((k) => (
            <button type="button" key={k} className={kind === k ? 'active' : ''} onClick={() => setKind(k)}>
              {QUOTE_KINDS[k]}
            </button>
          ))}
        </div>
        <div className="grid2">
          {/* Pas de <label> : un clic sur le libellé déclencherait le bouton « Changer ». */}
          <div className="field">
            <span>Client</span>
            {customer ? (
              <div className="inline">
                <strong>{customer.name}</strong>
                <button type="button" onClick={() => setCustomer(null)}>
                  Changer
                </button>
              </div>
            ) : (
              <div className="inline">
                <input value={customerName} onChange={(e) => setCustomerName(e.target.value)} placeholder="Nom du client" />
                <button type="button" className="nowrap" onClick={() => setPicking(true)}>
                  Fiche client…
                </button>
              </div>
            )}
            {!customer && <small>Client enregistré, ou simplement le nom d’un prospect</small>}
          </div>
          <Field label="Validité (jours)" hint="Les prix sont garantis jusqu'à cette date">
            <input type="number" min={1} max={365} value={validDays} onChange={(e) => setValidDays(e.target.value)} required />
          </Field>
        </div>
        <ArticlePicker onPick={add} />
        {lines.length === 0 ? (
          <Empty>Scannez ou recherchez les articles à chiffrer.</Empty>
        ) : (
          <table className="list compact">
            <thead>
              <tr>
                <th>Article</th>
                <th className="r">Prix unitaire</th>
                <th className="r">Quantité</th>
                <th className="r">Remise (FCFA)</th>
                <th className="r">Montant</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {lines.map((l, i) => (
                <tr key={l.key}>
                  <td>
                    {l.article.name} <span className="muted">{l.article.code}</span>
                  </td>
                  <td className="r">{fcfa(l.article.store_price)}</td>
                  <td className="r">
                    <input className="num" style={{ width: 80 }} value={l.qty} onChange={(e) => patch(l.key, { qty: e.target.value })} />
                  </td>
                  <td className="r">
                    <input className="num" style={{ width: 90 }} inputMode="numeric" value={l.discount} placeholder="0" onChange={(e) => patch(l.key, { discount: e.target.value })} />
                  </td>
                  <td className="r">{cart[i] ? fcfa(lineTotal(cart[i]!)) : '—'}</td>
                  <td>
                    <button type="button" className="link" onClick={() => setLines(lines.filter((x) => x.key !== l.key))}>
                      Retirer
                    </button>
                  </td>
                </tr>
              ))}
              {totals.totalDiscount > 0 && (
                <tr>
                  <td colSpan={4}>dont remises</td>
                  <td className="r">{fcfa(totals.totalDiscount)}</td>
                  <td />
                </tr>
              )}
              <tr className="total">
                <td colSpan={4}>Total TTC</td>
                <td className="r">{fcfa(totals.totalTtc)}</td>
                <td />
              </tr>
            </tbody>
          </table>
        )}
        <Field label="Conditions, remarques">
          <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Livraison comprise, paiement à 30 jours…" />
        </Field>
        {user.role === 'cashier' && totals.totalDiscount > 0 && <p className="muted">Les remises demandent le code du gérant.</p>}
        <div className="actions">
          <button type="button" onClick={onClose}>
            Annuler
          </button>
          <button
            type="button"
            className="primary"
            disabled={!lines.length || !valid || !(customer || customerName.trim()) || !(days >= 1 && days <= 365)}
            onClick={() => void submit()}
          >
            Enregistrer
          </button>
        </div>
      </div>
      {picking && (
        <CustomerPickDialog
          user={user}
          onClose={() => setPicking(false)}
          onPick={(c: Customer) => {
            setCustomer({ id: c.id, name: c.name });
            setPicking(false);
          }}
        />
      )}
      {askPin && (
        <SupervisorPrompt
          action={`Remise de ${fcfa(totals.totalDiscount)} sur le devis`}
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

function QuoteDetail({ id, onClose, onEdit, onChanged }: { id: string; onClose: () => void; onEdit: (q: Quote) => void; onChanged: () => void }) {
  const toast = useToast();
  const loaded = useLoad(() => call('quotes.get', id), [id]);
  const q = loaded.data;
  if (!q) return null;
  const cancel = async () => {
    if (!confirm(`Annuler ${q.number} ? Le document ne pourra plus être facturé.`)) return;
    try {
      await call('quotes.cancel', q.id);
      toast.ok(`${q.number} annulé`);
      loaded.reload();
      onChanged();
    } catch (err) {
      toast.error(err);
    }
  };
  return (
    <Modal title={`${QUOTE_KINDS[q.kind]} ${q.number}`} onClose={onClose} wide>
      <p>
        <StateTag state={q.state} /> {q.customer_name}
        {q.customer_code && <span className="muted"> · {q.customer_code}</span>}
        <span className="muted">
          {' '}
          · du {dateFr(q.quote_date)}, valable jusqu'au {dateFr(q.valid_until)} · établi par {q.user_name}
          {q.discount_authorized_by_name && `, remises accordées par ${q.discount_authorized_by_name}`}
        </span>
      </p>
      {q.sale_number && <p>Facturé par le ticket {q.sale_number}.</p>}
      <table className="list compact">
        <thead>
          <tr>
            <th>Article</th>
            <th className="r">Quantité</th>
            <th className="r">Prix unitaire</th>
            <th className="r">Remise</th>
            <th className="r">Montant</th>
          </tr>
        </thead>
        <tbody>
          {q.lines.map((l) => (
            <tr key={l.id}>
              <td>{l.label}</td>
              <td className="r">{qty(l.qty, l.unit)}</td>
              <td className="r">{fcfa(l.unit_price)}</td>
              <td className="r">{l.discount ? fcfa(l.discount) : ''}</td>
              <td className="r">{fcfa(l.total_ttc)}</td>
            </tr>
          ))}
          <tr>
            <td colSpan={4}>Total HT</td>
            <td className="r">{fcfa(q.total_ht)}</td>
          </tr>
          <tr>
            <td colSpan={4}>TVA</td>
            <td className="r">{fcfa(q.total_tva)}</td>
          </tr>
          <tr className="total">
            <td colSpan={4}>Total TTC</td>
            <td className="r">{fcfa(q.total_ttc)}</td>
          </tr>
        </tbody>
      </table>
      {q.notes && <p className="muted">{q.notes}</p>}
      {q.state === 'open' && <p className="muted">Pour le facturer : caisse › Action › Facturer un devis / proforma.</p>}
      <div className="actions">
        {q.status === 'open' && (
          <button type="button" className="danger" onClick={() => void cancel()}>
            Annuler le document
          </button>
        )}
        {q.status === 'open' && (
          <button type="button" onClick={() => onEdit(q)}>
            Modifier
          </button>
        )}
        <button type="button" className="primary" onClick={() => call('quotes.print', q.id).catch(toast.error)}>
          Imprimer (A4)
        </button>
      </div>
    </Modal>
  );
}

/** Choix, à la caisse, du devis ou de la proforma à facturer. */
export function QuotePickDialog({ onClose, onPick }: { onClose: () => void; onPick: (id: string) => void }) {
  const [search, setSearch] = useState('');
  const list = useLoad(() => call('quotes.list', { state: 'open', search: search || undefined }), [search]);
  const rows = list.data ?? [];
  return (
    <Modal title="Facturer un devis ou une proforma" onClose={onClose} wide>
      <div className="toolbar">
        <input autoFocus placeholder="N° ou client" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>
      {rows.length === 0 ? (
        <Empty>Aucun devis en cours de validité.</Empty>
      ) : (
        <table className="list compact">
          <thead>
            <tr>
              <th>N°</th>
              <th>Client</th>
              <th>Valable jusqu'au</th>
              <th className="r">Montant TTC</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((q) => (
              <tr key={q.id} className="clickable" onClick={() => onPick(q.id)}>
                <td className="nowrap">{q.number}</td>
                <td>{q.customer_name}</td>
                <td>{dateFr(q.valid_until)}</td>
                <td className="r">{fcfa(q.total_ttc)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Modal>
  );
}

function daysBetween(from: string, to: string) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}
