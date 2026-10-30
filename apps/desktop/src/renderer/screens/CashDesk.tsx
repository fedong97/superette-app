import { useEffect, useRef, useState } from 'react';
import { PAYMENT_METHODS } from '@superette/core';
import { type Result, call } from '../api';
import { Field, Modal, fcfa, parseAmount, useLoad, useToast, PhoneApproval } from '../ui';

type Options = Result<'cashdesk.options'>;
type Method = 'CASH' | 'MTN_MOMO' | 'ORANGE_MONEY';

/** Ligne d'entrée ou de sortie de la journée, telle que les volets l'affichent. */
export interface DeskRow {
  source: string;
  id: string;
  number?: string;
  kind?: string | null;
  at: string;
  amount: number;
  nature: string;
  label: string;
  party: string | null;
  reference?: string | null;
  closing?: boolean;
}

/** Ce qu'un volet d'entrées ou de sorties sait faire dans une journée ouverte. */
export interface DeskProps {
  sessionId: string;
  /** Journée ouverte : on peut encaisser, décaisser, antidater, supprimer. */
  open: boolean;
  onChanged: () => void;
}

const IN_TYPES = [
  ['customer', 'Client'],
  ['supplier', 'Fournisseur'],
  ['staff', 'Personnel'],
  ['other', 'Autre'],
] as const;
type InType = (typeof IN_TYPES)[number][0];

const OUT_TYPES = [
  ['transfer', 'Reversement / Virement'],
  ['supplier', 'Règlement'],
  ['advance', 'Avance fournisseur'],
  ['expense', 'Charge'],
  ['refund', "Rendre l'avance d'un client"],
  ['loan', 'Personnel (avance, salaire)'],
  ['other', 'Autre'],
] as const;
type OutType = (typeof OUT_TYPES)[number][0];
type LoanType = 'staff_advance' | 'staff_salary';

const nowLabel = () => new Date().toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
const periodFr = (p: string) => new Date(`${p}-15T12:00:00`).toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });

/** Champs communs : caisse et date, montant et mode. */
function Head({ o, amount, setAmount, method, setMethod }: { o: Options; amount: string; setAmount: (v: string) => void; method: Method; setMethod: (m: Method) => void }) {
  return (
    <div className="desk-head">
      <Field label="Caisse">
        <input readOnly value={`${String(o.register.number).padStart(2, '0')} · ${o.register.name}`} />
      </Field>
      <Field label="Date">
        <input readOnly value={nowLabel()} />
      </Field>
      <Field label="Montant (FCFA)">
        <input autoFocus inputMode="numeric" className="r" value={amount} onChange={(e) => setAmount(e.target.value)} />
      </Field>
      <Field label="Mode">
        <select value={method} onChange={(e) => setMethod(e.target.value as Method)}>
          {o.methods.map((m) => (
            <option key={m} value={m}>
              {PAYMENT_METHODS[m as Method]}
            </option>
          ))}
        </select>
      </Field>
    </div>
  );
}

/** Référence (MoMo/OM), n° de pièce et motif. */
function Tail({
  method,
  reference,
  setReference,
  piece,
  setPiece,
  pieceLabel,
  label,
  setLabel,
  labelRequired,
}: {
  method: Method;
  reference: string;
  setReference: (v: string) => void;
  piece: string;
  setPiece: (v: string) => void;
  pieceLabel: string;
  label: string;
  setLabel: (v: string) => void;
  labelRequired: boolean;
}) {
  return (
    <>
      {method !== 'CASH' && (
        <Field label="Référence de la transaction">
          <input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="MP2410…" />
        </Field>
      )}
      <div className="desk-head two">
        <Field label={pieceLabel}>
          <input value={piece} onChange={(e) => setPiece(e.target.value)} />
        </Field>
        <Field label={`Motif${labelRequired ? '' : ' (facultatif)'}`}>
          <input value={label} onChange={(e) => setLabel(e.target.value)} />
        </Field>
      </div>
    </>
  );
}

export function useDeskOptions(sessionId: string | null) {
  return useLoad(() => (sessionId ? call('cashdesk.options', sessionId) : Promise.resolve(null)), [sessionId]);
}

/** « Encaisser » : client, fournisseur (avoir remboursé), personnel (avance remboursée) ou autre recette. */
export function CashInDialog({ sessionId, onClose, onDone }: { sessionId: string; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const opts = useDeskOptions(sessionId);
  const o = opts.data;
  const [type, setType] = useState<InType>('customer');
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<Method>('CASH');
  const [reference, setReference] = useState('');
  const [piece, setPiece] = useState('');
  const [label, setLabel] = useState('');
  const [party, setParty] = useState('');
  const [target, setTarget] = useState('');
  const [print, setPrint] = useState(true);
  /** Client : règlement de ce qu'il doit, ou dépôt d'avance sur son compte. */
  const [advance, setAdvance] = useState(false);
  useEffect(() => {
    if (o) setMethod(o.methods[0] as Method);
  }, [o?.register.id]);
  useEffect(() => setTarget(type === 'other' ? '4711' : ''), [type, advance]);
  if (!o) return null;
  const value = parseAmount(amount) ?? 0;
  const owed = o.customers.filter((c) => c.balance > 0);
  const credits = o.invoices.filter((i) => i.kind === 'credit_note');
  const lenders = o.staff.filter((x) => x.advances > 0);
  const choose = (id: string, rest?: number) => {
    setTarget(id);
    if (rest && !amount) setAmount(String(rest));
  };
  const ready = value > 0 && Boolean(target) && (method === 'CASH' || reference.trim()) && (type !== 'other' || label.trim());
  return (
    <Modal title="Encaisser" onClose={onClose} wide>
      <form
        className="desk-form"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            const base = { amount: value, method, reference: reference || null, piece: piece || null, label: label || null };
            const input =
              type === 'customer'
                ? { ...base, type, customerId: target, advance }
                : type === 'supplier'
                  ? { ...base, type, invoiceId: target }
                  : type === 'staff'
                    ? { ...base, type, staffId: target }
                    : { ...base, type, accountId: target, party: party || null };
            const r = await call('cashdesk.in', sessionId, input);
            toast.ok('Entrée enregistrée');
            if (print) call('cashdesk.print', sessionId, r.source, r.id).catch(toast.error);
            onDone();
          } catch (err) {
            toast.error(err);
          }
        }}
      >
        <Head o={o} amount={amount} setAmount={setAmount} method={method} setMethod={setMethod} />
        <div className="desk-types">
          {IN_TYPES.map(([k, l]) => (
            <label key={k}>
              <input type="radio" name="in-type" checked={type === k} onChange={() => setType(k)} /> {l}
            </label>
          ))}
        </div>
        {type === 'customer' && (
          <div className="desk-types sub">
            <label>
              <input type="radio" name="in-customer" checked={!advance} onChange={() => setAdvance(false)} /> Règlement de ce qu'il doit
            </label>
            <label>
              <input type="radio" name="in-customer" checked={advance} onChange={() => setAdvance(true)} /> Dépôt d'avance
            </label>
          </div>
        )}
        {type === 'customer' && advance && (
          <Field label="Client qui dépose une avance" hint="Ses achats sur son compte (« Compte client » à la caisse) seront payés par cette avance.">
            <select value={target} onChange={(e) => setTarget(e.target.value)}>
              <option value="">Choisir…</option>
              {o.customers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                  {c.balance > 0 ? ` · doit ${fcfa(c.balance)}` : c.balance < 0 ? ` · avance ${fcfa(-c.balance)}` : ''}
                </option>
              ))}
            </select>
          </Field>
        )}
        {type === 'customer' && !advance && (
          <Field label="Client qui règle" hint={owed.length ? undefined : 'Aucun client ne doit d’argent en ce moment.'}>
            <select value={target} onChange={(e) => choose(e.target.value, owed.find((c) => c.id === e.target.value)?.balance)}>
              <option value="">Choisir…</option>
              {owed.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} · doit {fcfa(c.balance)}
                </option>
              ))}
            </select>
          </Field>
        )}
        {type === 'supplier' && (
          <Field label="Avoir remboursé par le fournisseur" hint={credits.length ? undefined : 'Aucun avoir fournisseur à rembourser.'}>
            <select value={target} onChange={(e) => choose(e.target.value, credits.find((i) => i.id === e.target.value)?.balance)}>
              <option value="">Choisir…</option>
              {credits.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.supplier_name} · avoir {i.supplier_number} · reste {fcfa(i.balance)}
                </option>
              ))}
            </select>
          </Field>
        )}
        {type === 'staff' && (
          <Field label="Collaborateur qui rembourse son avance" hint={lenders.length ? undefined : 'Aucun collaborateur n’a d’avance à rembourser.'}>
            <select value={target} onChange={(e) => choose(e.target.value, lenders.find((x) => x.id === e.target.value)?.advances)}>
              <option value="">Choisir…</option>
              {lenders.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name} · doit {fcfa(x.advances)}
                </option>
              ))}
            </select>
          </Field>
        )}
        {type === 'other' && (
          <div className="desk-head two">
            <Field label="Compte">
              <AccountSelect accounts={o.accounts} value={target} onChange={setTarget} />
            </Field>
            <Field label="Reçu de (facultatif)">
              <input value={party} onChange={(e) => setParty(e.target.value)} />
            </Field>
          </div>
        )}
        <Tail method={method} reference={reference} setReference={setReference} piece={piece} setPiece={setPiece} pieceLabel="N° pièce" label={label} setLabel={setLabel} labelRequired={type === 'other'} />
        <label className="check">
          <input type="checkbox" checked={print} onChange={(e) => setPrint(e.target.checked)} /> Imprimer le reçu
        </label>
        <div className="actions">
          <button type="button" onClick={onClose}>
            Fermer
          </button>
          <button type="submit" className="primary" disabled={!ready}>
            OK
          </button>
        </div>
      </form>
    </Modal>
  );
}

function AccountSelect({ accounts, value, onChange }: { accounts: Options['accounts']; value: string; onChange: (v: string) => void }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}>
      {accounts.map((a) => (
        <option key={a.id} value={a.id}>
          {a.id} · {a.label}
        </option>
      ))}
    </select>
  );
}

/** « Décaisser » : reversement, règlement fournisseur, charge, avance ou salaire, avoir client, autre. */
export function CashOutDialog({ sessionId, onClose, onDone }: { sessionId: string; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const opts = useDeskOptions(sessionId);
  const o = opts.data;
  const [type, setType] = useState<OutType>('transfer');
  const [loan, setLoan] = useState<LoanType>('staff_advance');
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<Method>('CASH');
  const [reference, setReference] = useState('');
  const [piece, setPiece] = useState('');
  const [label, setLabel] = useState('');
  const [party, setParty] = useState('');
  const [target, setTarget] = useState('');
  const [pin, setPin] = useState('');
  const [print, setPrint] = useState(true);
  // Avance au-delà du plafond du magasin : le code d'un gérant est demandé.
  const [overCeiling, setOverCeiling] = useState(false);
  useEffect(() => {
    if (o) setMethod(o.methods[0] as Method);
  }, [o?.register.id]);
  useEffect(() => {
    setTarget(type === 'other' ? '4711' : type === 'transfer' ? (o?.emoneyCentralId ?? '') : '');
  }, [type, loan, o?.register.id]);
  if (!o) return null;
  const value = parseAmount(amount) ?? 0;
  const electronic = o.register.kind === 'electronic';
  const invoices = o.invoices.filter((i) => i.kind === 'invoice');
  const credits = o.customers.filter((c) => c.balance < 0);
  const choose = (id: string, rest?: number) => {
    setTarget(id);
    if (rest && !amount) setAmount(String(rest));
  };
  const needsTarget = type !== 'transfer' || electronic;
  const ready =
    value > 0 &&
    (!needsTarget || Boolean(target)) &&
    (method === 'CASH' || reference.trim()) &&
    ((type !== 'other' && type !== 'expense') || label.trim()) &&
    (!(o.needsPin || overCeiling) || pin.length >= 4);
  return (
    <Modal title="Décaisser" onClose={onClose} wide>
      <form
        className="desk-form"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            const base = { amount: value, method, reference: reference || null, piece: piece || null, label: label || null };
            const input =
              type === 'transfer'
                ? { ...base, type, toRegisterId: target || null }
                : type === 'supplier'
                  ? { ...base, type, invoiceId: target }
                  : type === 'advance'
                    ? { ...base, type: 'supplier_advance' as const, supplierId: target }
                  : type === 'expense'
                    ? { ...base, type, categoryId: target, beneficiary: party || null }
                    : type === 'other'
                      ? { ...base, type, accountId: target, party: party || null }
                      : type === 'refund'
                        ? { ...base, type: 'customer_refund' as const, customerId: target }
                        : loan === 'staff_advance'
                          ? { ...base, type: loan, staffId: target }
                          : { ...base, type: loan, salaryId: target };
            const r = await call('cashdesk.out', sessionId, input, o.needsPin || overCeiling ? pin : undefined);
            toast.ok('Sortie enregistrée');
            if (print) {
              const printing = r.source === 'cash_operation' ? Promise.resolve() : r.source === 'movement' ? call('emoney.print', r.id) : call('cashdesk.print', sessionId, r.source, r.id);
              printing.catch(toast.error);
            }
            onDone();
          } catch (err) {
            if ((err as { code?: string }).code === 'SUPERVISOR_REQUIRED') setOverCeiling(true);
            toast.error(err);
          }
        }}
      >
        <Head o={o} amount={amount} setAmount={setAmount} method={method} setMethod={setMethod} />
        <div className="desk-types">
          {OUT_TYPES.filter(([k]) => k !== 'advance' || o.canSupplierAdvance).map(([k, l]) => (
            <label key={k}>
              <input type="radio" name="out-type" checked={type === k} onChange={() => setType(k)} /> {l}
            </label>
          ))}
        </div>
        {type === 'transfer' &&
          (electronic ? (
            <Field label="Vers la caisse électronique">
              <select value={target} onChange={(e) => setTarget(e.target.value)}>
                <option value="">Choisir…</option>
                {o.emoneyRegisters.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                    {r.central ? ' (centrale)' : ''}
                  </option>
                ))}
              </select>
            </Field>
          ) : (
            <Field label="Vers" hint="Les espèces vont à la caisse centrale, avec un bon de versement.">
              <input readOnly value="99 · Caisse centrale" />
            </Field>
          ))}
        {type === 'supplier' && (
          <Field label="Facture fournisseur à régler" hint={invoices.length ? undefined : 'Aucune facture fournisseur à payer.'}>
            <select value={target} onChange={(e) => choose(e.target.value, invoices.find((i) => i.id === e.target.value)?.balance)}>
              <option value="">Choisir…</option>
              {invoices.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.supplier_name} · facture {i.supplier_number} · reste {fcfa(i.balance)}
                </option>
              ))}
            </select>
          </Field>
        )}
        {type === 'advance' && (
          <Field label="Fournisseur" hint="L’avance baisse ce qu’on lui doit (ou devient ce qu’il nous doit). Elle se supprime le jour même tant qu’il ne l’a pas remboursée.">
            <select value={target} onChange={(e) => setTarget(e.target.value)}>
              <option value="">Choisir…</option>
              {o.suppliers.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                  {x.balance ? ` · solde ${fcfa(x.balance)}` : ''}
                </option>
              ))}
            </select>
          </Field>
        )}
        {type === 'expense' && (
          <div className="desk-head two">
            <Field label="Type de charge">
              <select value={target} onChange={(e) => setTarget(e.target.value)}>
                <option value="">Choisir…</option>
                {o.categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Bénéficiaire (facultatif)">
              <input value={party} onChange={(e) => setParty(e.target.value)} />
            </Field>
          </div>
        )}
        {type === 'loan' && (
          <>
            <div className="desk-types sub">
              {(
                [
                  ['staff_advance', 'Avance ou prêt à un collaborateur'],
                  ['staff_salary', "Salaire d'un collaborateur"],
                ] as const
              ).map(([k, l]) => (
                <label key={k}>
                  <input type="radio" name="loan" checked={loan === k} onChange={() => setLoan(k)} /> {l}
                </label>
              ))}
            </div>
            {loan === 'staff_advance' && (
              <Field label="Collaborateur" hint={o.staff.length ? undefined : 'Ajoutez d’abord vos collaborateurs dans Personnel › Collaborateurs.'}>
                <select value={target} onChange={(e) => setTarget(e.target.value)}>
                  <option value="">Choisir…</option>
                  {o.staff.map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.name}
                      {x.position ? ` · ${x.position}` : ''}
                      {x.advances > 0 ? ` · doit déjà ${fcfa(x.advances)}` : ''}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            {loan === 'staff_salary' && (
              <Field label="Salaire à payer" hint={o.salaries.length ? undefined : 'Aucun salaire constaté à payer : constatez-les dans Personnel › Salaires du mois.'}>
                <select value={target} onChange={(e) => choose(e.target.value, o.salaries.find((x) => x.id === e.target.value)?.rest)}>
                  <option value="">Choisir…</option>
                  {o.salaries.map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.staff_name} · {periodFr(x.period)} · reste {fcfa(x.rest)}
                    </option>
                  ))}
                </select>
              </Field>
            )}
          </>
        )}
        {type === 'refund' && (
          <Field label="Client à qui rendre son avance" hint={credits.length ? 'On ne rend pas plus que ce qui reste sur son compte.' : 'Aucun client n’a d’avance (ni d’avoir) sur son compte.'}>
            <select value={target} onChange={(e) => choose(e.target.value, -(credits.find((c) => c.id === e.target.value)?.balance ?? 0))}>
              <option value="">Choisir…</option>
              {credits.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} · avance {fcfa(-c.balance)}
                </option>
              ))}
            </select>
          </Field>
        )}
        {type === 'other' && (
          <div className="desk-head two">
            <Field label="Compte">
              <AccountSelect accounts={o.accounts} value={target} onChange={setTarget} />
            </Field>
            <Field label="Bénéficiaire (facultatif)">
              <input value={party} onChange={(e) => setParty(e.target.value)} />
            </Field>
          </div>
        )}
        <Tail method={method} reference={reference} setReference={setReference} piece={piece} setPiece={setPiece} pieceLabel="N° reçu" label={label} setLabel={setLabel} labelRequired={type === 'other' || type === 'expense'} />
        {(o.needsPin || overCeiling) && (
          <>
            <Field label="Code du gérant">
              <input type="password" inputMode="numeric" value={pin} onChange={(e) => setPin(e.target.value)} />
            </Field>
            <PhoneApproval action="Autoriser une sortie de caisse" onCode={setPin} />
          </>
        )}
        <label className="check">
          <input type="checkbox" checked={print} onChange={(e) => setPrint(e.target.checked)} /> Imprimer le bon de sortie
        </label>
        <div className="actions">
          <button type="button" onClick={onClose}>
            Fermer
          </button>
          <button type="submit" className="primary" disabled={!ready}>
            OK
          </button>
        </div>
      </form>
    </Modal>
  );
}

type ActionDialog = null | 'edit' | 'backdate' | 'delete' | 'unprint' | 'to-supplier' | 'to-customer';

/**
 * « Plus ▾ » d'un volet, sur la ligne choisie : à côté d'« Encaisser » ou de
 * « Décaisser », c'est le seul autre bouton. Entrées : imprimer le reçu,
 * modifier, supprimer, puis A4 et antidater. Sorties : imprimer, décharge,
 * modifier, supprimer, puis A4, antidater et convertir.
 */
export function DeskActions({ direction, row, desk }: { direction: 'IN' | 'OUT'; row: DeskRow | null; desk: DeskProps }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [dialog, setDialog] = useState<ActionDialog>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);
  const entry = row?.source === 'entry';
  const editable = Boolean(row && desk.open && !row.closing && (entry || row.source === 'expense'));
  // Un règlement ou un dépôt d'avance du jour s'annule : l'argent est rendu par une pièce de contre-passation.
  const reversible = Boolean(row && desk.open && (row.source === 'customer_payment' || row.source === 'supplier_payment'));
  const otherOut = Boolean(row && desk.open && entry && row.kind === 'other');
  const why = !row ? 'Choisissez d’abord une ligne' : !desk.open ? 'La journée est clôturée' : undefined;
  const onlyDesk = direction === 'IN' ? 'Seulement une entrée faite par « Encaisser »' : 'Seulement une sortie faite par « Décaisser » ou une dépense';
  const run = (fn: () => Promise<unknown>) => {
    setOpen(false);
    fn().catch(toast.error);
  };
  const item = (label: string, enabled: boolean, onClick: () => void, hint?: string) => (
    <button type="button" disabled={!enabled} title={enabled ? undefined : (hint ?? why)} onClick={onClick}>
      {label}
    </button>
  );
  const print = (format: 'ticket' | 'a4') => run(() => call('cashdesk.print', desk.sessionId, row!.source, row!.id, format));
  return (
    <span className="desk-action-buttons">
      <div className="menu desk-action" ref={ref}>
        <button type="button" onClick={() => setOpen(!open)} title={row ? undefined : 'Choisissez d’abord une ligne, puis « Plus »'}>
          Plus ▾
        </button>
        {open && (
          <div className="menu-drop right">
            {!row && <small className="menu-hint">Cliquez d'abord sur une ligne du tableau</small>}
            {direction === 'IN' ? (
              item('Imprimer le reçu', Boolean(row), () => print('ticket'))
            ) : (
              <>
                {item('Imprimer le bon de sortie', Boolean(row && !row.closing), () => print('ticket'))}
                {item('Décharge', Boolean(row && !row.closing), () => run(() => call('cashdesk.discharge', desk.sessionId, row!.source, row!.id)))}
              </>
            )}
            {item('Modifier', editable, () => (setOpen(false), setDialog('edit')), why ?? onlyDesk)}
            {item(
              reversible ? 'Annuler ce règlement…' : 'Supprimer',
              editable || reversible,
              () => (setOpen(false), setDialog('delete')),
              why ?? onlyDesk,
            )}
            <hr />
            {direction === 'IN' ? (
              <>
                {item('Reçu en page A4', Boolean(row), () => print('a4'))}
                {item("Annuler l'impression du reçu", Boolean(row && entry), () => (setOpen(false), setDialog('unprint')), 'Seulement pour une entrée faite par « Encaisser »')}
                <hr />
                {item('Antidater…', editable, () => (setOpen(false), setDialog('backdate')), why ?? onlyDesk)}
              </>
            ) : (
              <>
                {item('Bon de sortie en page A4', Boolean(row && !row.closing), () => print('a4'))}
                {item('Antidater…', editable, () => (setOpen(false), setDialog('backdate')), why ?? onlyDesk)}
                <hr />
                {item('Convertir en règlement fournisseur', otherOut, () => (setOpen(false), setDialog('to-supplier')), why ?? 'Seulement une sortie de type « Autre »')}
                {item('Convertir en remboursement client', otherOut, () => (setOpen(false), setDialog('to-customer')), why ?? 'Seulement une sortie de type « Autre »')}
              </>
            )}
          </div>
        )}
      </div>
      {dialog && row && (
        <RowDialog
          kind={dialog}
          row={row}
          desk={desk}
          onClose={() => setDialog(null)}
          onDone={() => {
            setDialog(null);
            desk.onChanged();
          }}
        />
      )}
    </span>
  );
}

const localInput = (iso: string) => {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/** Antidater, supprimer, annuler l'impression, convertir : le gérant, ou son code. */
function RowDialog({ kind, row, desk, onClose, onDone }: { kind: Exclude<ActionDialog, null>; row: DeskRow; desk: DeskProps; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const opts = useDeskOptions(desk.sessionId);
  const o = opts.data;
  const [at, setAt] = useState(localInput(row.at));
  const [reason, setReason] = useState('');
  const [target, setTarget] = useState('');
  const [pin, setPin] = useState('');
  const [amount, setAmount] = useState(String(row.amount));
  const [label, setLabel] = useState(row.label);
  const [party, setParty] = useState(row.party ?? '');
  const [reference, setReference] = useState(row.reference ?? '');
  if (!o) return null;
  const source = row.source as 'entry' | 'expense';
  const payment = row.source === 'customer_payment' || row.source === 'supplier_payment' ? row.source : null;
  // Le tiers se corrige sur une autre entrée ou sortie et sur une dépense (bénéficiaire) ; le montant, sauf consigne, point MoMo, bon d'achat.
  const partyEditable = source === 'expense' || row.kind === 'other';
  const amountEditable = source === 'expense' || ['other', 'staff_advance', 'staff_repayment', 'staff_salary', 'customer_refund'].includes(row.kind ?? '');
  const title = { edit: 'Modifier', backdate: 'Antidater', delete: row.source === 'customer_payment' || row.source === 'supplier_payment' ? 'Annuler le règlement' : 'Supprimer', unprint: "Annuler l'impression du reçu", 'to-supplier': 'Convertir en règlement fournisseur', 'to-customer': 'Convertir en remboursement client' }[kind];
  const invoices = o.invoices.filter((i) => i.kind === 'invoice' && i.balance >= row.amount);
  const credits = o.customers.filter((c) => -c.balance >= row.amount);
  const allowed = payment ? o.canReverse : o.canEdit;
  const p = allowed ? undefined : pin;
  const ready = (allowed || pin.length >= 4) && (kind !== 'delete' || reason.trim()) && (!kind.startsWith('to-') || target) && (kind !== 'edit' || (label.trim() && parseAmount(amount)));
  return (
    <Modal title={title} onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            if (kind === 'edit')
              await call(
                'cashdesk.update',
                source,
                row.id,
                { amount: amountEditable ? (parseAmount(amount) ?? row.amount) : undefined, label, party: partyEditable ? party : undefined, reference: reference || null },
                p,
              );
            if (kind === 'backdate') await call('cashdesk.backdate', source, row.id, new Date(at).toISOString(), p);
            if (kind === 'delete' && payment) await call('cashdesk.reverse', payment, row.id, reason, p);
            else if (kind === 'delete') await call('cashdesk.cancel', source, row.id, reason, p);
            if (kind === 'unprint') await call('cashdesk.unprint', row.id, p);
            if (kind === 'to-supplier') await call('cashdesk.convert', row.id, { type: 'supplier', invoiceId: target }, p);
            if (kind === 'to-customer') await call('cashdesk.convert', row.id, { type: 'customer', customerId: target }, p);
            toast.ok('Fait');
            onDone();
          } catch (err) {
            toast.error(err);
          }
        }}
      >
        <p>
          <b>{row.nature}</b> · {row.label} · {fcfa(row.amount)}
          {row.party ? ` · ${row.party}` : ''}
        </p>
        {kind === 'edit' && (
          <>
            <Field label="Montant (FCFA)" hint={amountEditable ? undefined : 'Le montant de cette opération ne se modifie pas : supprimez-la et refaites-la'}>
              <input autoFocus inputMode="numeric" className="r" value={amount} disabled={!amountEditable} onChange={(e) => setAmount(e.target.value)} />
            </Field>
            <Field label="Motif">
              <input value={label} onChange={(e) => setLabel(e.target.value)} />
            </Field>
            {partyEditable && (
              <Field label={source === 'expense' ? 'Bénéficiaire' : 'Tiers / bénéficiaire'}>
                <input value={party} onChange={(e) => setParty(e.target.value)} />
              </Field>
            )}
            <Field label="Référence ou n° de pièce">
              <input value={reference} onChange={(e) => setReference(e.target.value)} />
            </Field>
            <p className="muted small">L’ancienne version reste dans le journal d’audit.</p>
          </>
        )}
        {kind === 'backdate' && (
          <Field label="Nouvelle date et heure" hint="Entre l’ouverture de la journée et maintenant.">
            <input type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} />
          </Field>
        )}
        {kind === 'delete' && payment && (
          <p className="muted">
            {payment === 'customer_payment'
              ? 'L’argent est rendu au client par une sortie de cette journée ; son compte retrouve le solde d’avant le règlement.'
              : 'L’argent revient dans cette journée ; la facture du fournisseur redevient à payer.'}{' '}
            Supprimer ensuite cette pièce d’annulation rétablit le règlement.
          </p>
        )}
        {kind === 'delete' && (
          <Field label={payment ? "Motif de l'annulation" : 'Motif de la suppression'} hint={payment ? undefined : 'La ligne reste dans l’historique, barrée, avec ce motif.'}>
            <input autoFocus value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
        )}
        {kind === 'unprint' && <p className="muted">Le prochain reçu imprimé sera un original, sans la mention « DUPLICATA ».</p>}
        {kind === 'to-supplier' && (
          <Field label="Facture payée par cette sortie" hint={invoices.length ? undefined : `Aucune facture fournisseur n'a ${fcfa(row.amount)} à payer.`}>
            <select value={target} onChange={(e) => setTarget(e.target.value)}>
              <option value="">Choisir…</option>
              {invoices.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.supplier_name} · facture {i.supplier_number} · reste {fcfa(i.balance)}
                </option>
              ))}
            </select>
          </Field>
        )}
        {kind === 'to-customer' && (
          <Field label="Client remboursé" hint={credits.length ? undefined : `Aucun client n'a ${fcfa(row.amount)} d'avoir.`}>
            <select value={target} onChange={(e) => setTarget(e.target.value)}>
              <option value="">Choisir…</option>
              {credits.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} · avoir {fcfa(-c.balance)}
                </option>
              ))}
            </select>
          </Field>
        )}
        {!allowed && (
          <>
            <Field label="Code du gérant">
              <input type="password" inputMode="numeric" value={pin} onChange={(e) => setPin(e.target.value)} />
            </Field>
            <PhoneApproval action="Autoriser une opération de caisse" onCode={setPin} />
          </>
        )}
        <div className="actions">
          <button type="button" onClick={onClose}>
            Fermer
          </button>
          <button type="submit" className={kind === 'delete' ? 'danger' : 'primary'} disabled={!ready}>
            {title}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** « Totaux par nature d'entrée / sortie » de la journée. */
export function NatureTotals({ entries, exits }: { entries: DeskRow[]; exits: DeskRow[] }) {
  const natures = new Map<string, { in: number; out: number; n: number }>();
  for (const [rows, side] of [
    [entries, 'in'],
    [exits, 'out'],
  ] as const) {
    for (const r of rows) {
      if (r.closing) continue;
      const t = natures.get(r.nature) ?? { in: 0, out: 0, n: 0 };
      t[side] += r.amount;
      t.n += 1;
      natures.set(r.nature, t);
    }
  }
  const rows = [...natures.entries()].sort((a, b) => b[1].in + b[1].out - (a[1].in + a[1].out));
  const total = (k: 'in' | 'out') => rows.reduce((t, [, v]) => t + v[k], 0);
  return (
    <table className="list compact desk-totals">
      <thead>
        <tr>
          <th>Nature</th>
          <th className="r">Opérations</th>
          <th className="r">Entrées</th>
          <th className="r">Sorties</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(([n, v]) => (
          <tr key={n}>
            <td>{n}</td>
            <td className="r">{v.n}</td>
            <td className="r">{v.in ? fcfa(v.in) : ''}</td>
            <td className="r">{v.out ? fcfa(v.out) : ''}</td>
          </tr>
        ))}
        <tr className="total">
          <td>Total</td>
          <td></td>
          <td className="r">{fcfa(total('in'))}</td>
          <td className="r">{fcfa(total('out'))}</td>
        </tr>
      </tbody>
    </table>
  );
}
