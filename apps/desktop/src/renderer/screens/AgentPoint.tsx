import { useState } from 'react';
import { type Result, call } from '../api';
import { Empty, Field, Modal, Tabs, askConfirm, askText, dateTime, fcfa, parseAmount, today, useCan, useLoad, useToast } from '../ui';

export type AgentTab = 'counter' | 'history' | 'accounts';

type Account = Result<'agent.accounts'>[number];
type Operation = Result<'agent.list'>[number];
type Kind = Operation['kind'];
type Operator = Account['operator'];

const KINDS: Record<Kind, string> = {
  deposit: 'Dépôt',
  withdrawal: 'Retrait',
  airtime: 'Crédit de communication',
  bill: 'Paiement de facture',
  float_in: 'Achat de flotte',
  float_out: 'Flotte revendue',
  commission: "Commission de l'opérateur",
};

/** Opérations faites pour un client, au comptoir. */
const CLIENT_KINDS: { kind: Kind; icon: string; hint: string }[] = [
  { kind: 'deposit', icon: '⬆', hint: 'Le client verse des espèces sur son compte' },
  { kind: 'withdrawal', icon: '⬇', hint: 'Le client retire des espèces' },
  { kind: 'airtime', icon: '📱', hint: 'Vente de crédit de communication' },
  { kind: 'bill', icon: '🧾', hint: 'ENEO, CAMWATER, Canal+…' },
];

const OPERATORS: Record<Operator, string> = { MTN: 'MTN Mobile Money', ORANGE: 'Orange Money', OTHER: 'Autres services (crédit, factures)' };
const BILLERS = ['ENEO', 'CAMWATER', 'Canal+', 'StarTimes', 'DStv', 'CAMTEL', 'Impôts (DGI)'];

const monthStart = () => `${today().slice(0, 8)}01`;
/** Points de base → pourcentage affiché (50 → « 0,5 »). */
const bpToPct = (bp: number | undefined) => (bp ? (bp / 100).toLocaleString('fr-FR', { maximumFractionDigits: 2 }) : '');
const pctToBp = (v: string): number | null => {
  const t = v.trim().replace(',', '.').replace('%', '').trim();
  if (!t) return 0;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null;
};

/**
 * Point Mobile Money et services : dépôts, retraits, crédit de communication
 * et factures pour les clients ; la flotte de chaque compte agent, ses
 * approvisionnements et les commissions.
 */
export function AgentPoint({ initialTab = 'counter' }: { initialTab?: AgentTab }) {
  const can = useCan();
  const allowed: Record<AgentTab, boolean> = {
    counter: can('agent_point'),
    history: can('agent_point', 'agent_accounts'),
    accounts: can('agent_accounts'),
  };
  const [tab, setTab] = useState<AgentTab>(allowed[initialTab] ? initialTab : ((Object.keys(allowed) as AgentTab[]).find((k) => allowed[k]) ?? 'history'));
  return (
    <div className="page">
      <header className="page-head">
        <h1>Point Mobile Money</h1>
        <span className="muted">Dépôts, retraits, crédit de communication et factures : les espèces passent par la journée de la caisse</span>
      </header>
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={(
          [
            ['counter', 'Comptoir'],
            ['history', 'Historique'],
            ['accounts', 'Comptes et flotte'],
          ] as [AgentTab, string][]
        ).filter(([k]) => allowed[k])}
      />
      {!allowed[tab] && <Empty>Vous n'avez pas accès à cet onglet.</Empty>}
      {tab === 'counter' && allowed.counter && <Counter canCancel={can('agent_cancel')} />}
      {tab === 'history' && allowed.history && <History canCancel={can('agent_cancel')} />}
      {tab === 'accounts' && allowed.accounts && <Accounts />}
    </div>
  );
}

/** Annule une opération (journée de caisse encore ouverte) : ses espèces sont annulées avec. */
async function cancelOperation(op: Operation, toast: ReturnType<typeof useToast>, done: () => void) {
  const reason = await askText(`Annuler l'opération ${op.number} (${KINDS[op.kind]}, ${fcfa(op.amount)}) ? Ses espèces sont annulées avec. Indiquez le motif.`);
  if (!reason) return;
  try {
    await call('agent.cancel', op.id, reason);
    toast.ok(`Opération ${op.number} annulée`);
    done();
  } catch (e) {
    toast.error(e);
  }
}

function OperationsTable({ rows, canCancel, onChanged, showAccount = true }: { rows: Operation[]; canCancel: boolean; onChanged: () => void; showAccount?: boolean }) {
  const toast = useToast();
  return (
    <table className="list">
      <thead>
        <tr>
          <th>N°</th>
          <th>Date</th>
          {showAccount && <th>Compte</th>}
          <th>Opération</th>
          <th className="r">Montant</th>
          <th className="r">Frais</th>
          <th className="r">Commission</th>
          <th>Téléphone ou facture</th>
          <th>Référence</th>
          <th>Par</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {rows.map((o) => (
          <tr key={o.id} className={o.status === 'cancelled' ? 'muted' : ''}>
            <td>{o.number}</td>
            <td>{dateTime(o.created_at)}</td>
            {showAccount && <td>{o.account_name}</td>}
            <td>{KINDS[o.kind]}</td>
            <td className="r">{fcfa(o.amount)}</td>
            <td className="r">{o.fee ? fcfa(o.fee) : ''}</td>
            <td className="r">{o.commission ? fcfa(o.commission) : ''}</td>
            <td>{[o.phone, o.biller].filter(Boolean).join(' · ')}</td>
            <td>{o.reference ?? ''}</td>
            <td>{o.user_name ?? ''}</td>
            <td>
              {o.status === 'cancelled' ? (
                <span className="tag" title={o.cancel_reason ?? ''}>
                  Annulée
                </span>
              ) : (
                <span className="inline">
                  {o.session_id && o.kind !== 'commission' && (
                    <button className="link" onClick={() => call('agent.print', o.id).catch(toast.error)}>
                      Reçu
                    </button>
                  )}
                  {canCancel && (
                    <button className="link" onClick={() => void cancelOperation(o, toast, onChanged)}>
                      Annuler
                    </button>
                  )}
                </span>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// --- Comptoir ---------------------------------------------------------------------------

function Counter({ canCancel }: { canCancel: boolean }) {
  const toast = useToast();
  const accounts = useLoad(() => call('agent.accounts'), []);
  const session = useLoad(() => call('pos.session'), []);
  const [accountId, setAccountId] = useState('');
  const [kind, setKind] = useState<Kind>('deposit');
  const [amount, setAmount] = useState('');
  const [phone, setPhone] = useState('');
  const [reference, setReference] = useState('');
  const [biller, setBiller] = useState('');
  const [fee, setFee] = useState('');
  const [busy, setBusy] = useState(false);
  const account = (accounts.data ?? []).find((a) => a.id === accountId) ?? (accounts.data ?? [])[0];
  const value = parseAmount(amount) ?? 0;
  const commission = useLoad(() => (account && value > 0 ? call('agent.commissionFor', account.id, kind, value) : Promise.resolve(0)), [account?.id, kind, value]);
  const sessionId = session.data?.id ?? null;
  const ops = useLoad(() => (sessionId ? call('agent.list', { sessionId }) : Promise.resolve([])), [sessionId]);
  const isBill = kind === 'bill';

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!account) return;
    setBusy(true);
    try {
      const op = await call('agent.record', {
        accountId: account.id,
        kind,
        amount: value,
        fee: isBill ? (parseAmount(fee) ?? 0) : 0,
        phone: phone.trim() || null,
        reference: reference.trim() || null,
        biller: isBill ? biller.trim() || null : null,
      });
      toast.ok(`Opération ${op.number} enregistrée`);
      setAmount('');
      setPhone('');
      setReference('');
      setBiller('');
      setFee('');
      accounts.reload();
      ops.reload();
      if (await askConfirm('Imprimer le reçu pour le client ?')) await call('agent.print', op.id).catch(toast.error);
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };

  if (accounts.data && accounts.data.length === 0)
    return <Empty>Aucun compte agent actif. Le gérant crée les comptes MTN Mobile Money et Orange Money dans l'onglet Comptes et flotte.</Empty>;
  const cashIn = kind !== 'withdrawal';
  const total = value + (isBill ? (parseAmount(fee) ?? 0) : 0);
  return (
    <>
      {session.data === null && <p className="warn">La caisse n'est pas ouverte : ouvrez la journée pour encaisser ou payer les espèces du point Mobile Money.</p>}
      <form onSubmit={save}>
        <div className="grid3">
          <Field label="Compte agent">
            <select value={account?.id ?? ''} onChange={(e) => setAccountId(e.target.value)}>
              {(accounts.data ?? []).map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} · {OPERATORS[a.operator]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Flotte disponible">
            <strong className={account && account.float <= 0 ? 'neg' : ''}>{account ? fcfa(account.float) : ''}</strong>
          </Field>
        </div>
        <div className="role-tiles agent-kinds">
          {CLIENT_KINDS.map((k) => (
            <button type="button" key={k.kind} className={kind === k.kind ? 'active' : ''} onClick={() => setKind(k.kind)}>
              <span className="tile-icon">{k.icon}</span>
              <strong>{KINDS[k.kind]}</strong>
              <small>{k.hint}</small>
            </button>
          ))}
        </div>
        <div className="grid3">
          <Field label="Montant (FCFA)">
            <input autoFocus inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} required />
          </Field>
          <Field label="Téléphone du client" hint={isBill ? 'Facultatif' : '9 chiffres'}>
            <input inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} required={!isBill} placeholder="6XX XX XX XX" />
          </Field>
          <Field label="Référence de la transaction" hint="Numéro du SMS de confirmation">
            <input value={reference} onChange={(e) => setReference(e.target.value)} />
          </Field>
          {isBill && (
            <>
              <Field label="Facture payée">
                <input list="agent-billers" value={biller} onChange={(e) => setBiller(e.target.value)} required placeholder="ENEO, CAMWATER, Canal+…" />
                <datalist id="agent-billers">
                  {BILLERS.map((b) => (
                    <option key={b} value={b} />
                  ))}
                </datalist>
              </Field>
              <Field label="Frais payés par le client (FCFA)">
                <input inputMode="numeric" value={fee} onChange={(e) => setFee(e.target.value)} />
              </Field>
            </>
          )}
        </div>
        <div className="kpis">
          <div className={cashIn ? 'pos' : 'neg'}>
            <small>{cashIn ? 'Espèces à recevoir du client' : 'Espèces à donner au client'}</small>
            <strong>{fcfa(total)}</strong>
          </div>
          <div>
            <small>Commission de l'opérateur</small>
            <strong>{fcfa(commission.data ?? 0)}</strong>
          </div>
        </div>
        <div className="actions">
          <button type="submit" className="primary" disabled={busy || !account || value <= 0 || !sessionId}>
            Valider l'opération
          </button>
        </div>
      </form>
      <h3>Opérations de la journée de caisse</h3>
      {(ops.data ?? []).length === 0 ? (
        <p className="muted">Aucune opération dans la journée en cours.</p>
      ) : (
        <OperationsTable
          rows={ops.data ?? []}
          canCancel={canCancel}
          onChanged={() => {
            ops.reload();
            accounts.reload();
          }}
        />
      )}
    </>
  );
}

// --- Historique -------------------------------------------------------------------------

function History({ canCancel }: { canCancel: boolean }) {
  const accounts = useLoad(() => call('agent.accounts', true), []);
  const [accountId, setAccountId] = useState('');
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(today());
  const list = useLoad(() => call('agent.list', { accountId: accountId || null, from: from || null, to: to || null }), [accountId, from, to]);
  const active = (list.data ?? []).filter((o) => o.status === 'active');
  return (
    <>
      <div className="filters">
        <label className="inline">
          Compte{' '}
          <select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            <option value="">Tous</option>
            {(accounts.data ?? []).map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
        <label className="inline">
          Du <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="inline">
          au <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        <span className="muted">
          {active.length} opération(s) · commissions {fcfa(active.reduce((t, o) => t + (o.kind === 'commission' ? 0 : o.commission), 0))} · frais{' '}
          {fcfa(active.reduce((t, o) => t + o.fee, 0))}
        </span>
      </div>
      {(list.data ?? []).length === 0 ? <Empty>Aucune opération sur la période.</Empty> : <OperationsTable rows={list.data ?? []} canCancel={canCancel} onChanged={list.reload} />}
    </>
  );
}

// --- Comptes et flotte ------------------------------------------------------------------

function Accounts() {
  const accounts = useLoad(() => call('agent.accounts', true), []);
  const [editing, setEditing] = useState<Account | 'new' | null>(null);
  const [floatOp, setFloatOp] = useState<'float_in' | 'float_out' | 'commission' | null>(null);
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(today());
  const summary = useLoad(() => call('agent.summary', from, to), [from, to, accounts.data]);
  const amountOf = (r: Result<'agent.summary'>[number], k: Kind) => r.by_kind[k]?.amount ?? 0;
  return (
    <>
      <div className="toolbar">
        <button className="primary" onClick={() => setEditing('new')}>
          Nouveau compte agent
        </button>
        <button onClick={() => setFloatOp('float_in')}>Approvisionner la flotte (espèces de la caisse)</button>
        <button onClick={() => setFloatOp('float_out')}>Revendre de la flotte</button>
        <button onClick={() => setFloatOp('commission')}>Commission reçue de l'opérateur</button>
      </div>
      {(accounts.data ?? []).length === 0 ? (
        <Empty action={{ label: 'Nouveau compte agent', onClick: () => setEditing('new') }}>
          Aucun compte agent. Créez un compte par puce agent (MTN Mobile Money, Orange Money) avec ses taux de commission, puis approvisionnez sa flotte.
        </Empty>
      ) : (
        <table className="list">
          <thead>
            <tr>
              <th>Compte</th>
              <th>Opérateur</th>
              <th className="r">Dépôt</th>
              <th className="r">Retrait</th>
              <th className="r">Crédit</th>
              <th className="r">Facture</th>
              <th className="r">Flotte</th>
              <th>État</th>
            </tr>
          </thead>
          <tbody>
            {(accounts.data ?? []).map((a) => (
              <tr key={a.id} className="clickable" onClick={() => setEditing(a)}>
                <td>{a.name}</td>
                <td>{OPERATORS[a.operator]}</td>
                {(['deposit', 'withdrawal', 'airtime', 'bill'] as Kind[]).map((k) => (
                  <td key={k} className="r">
                    {a.rates[k] ? `${bpToPct(a.rates[k])} %` : ''}
                  </td>
                ))}
                <td className={`r ${a.float < 0 ? 'neg' : ''}`}>{fcfa(a.float)}</td>
                <td>{a.active ? 'Actif' : <span className="tag">Désactivé</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <h3>Bilan de la période</h3>
      <div className="filters">
        <label className="inline">
          Du <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="inline">
          au <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
      </div>
      {(summary.data ?? []).length > 0 && (
        <table className="list">
          <thead>
            <tr>
              <th>Compte</th>
              <th className="r">Opérations</th>
              <th className="r">Dépôts</th>
              <th className="r">Retraits</th>
              <th className="r">Crédit</th>
              <th className="r">Factures</th>
              <th className="r">Flotte achetée</th>
              <th className="r">Flotte revendue</th>
              <th className="r">Commissions</th>
              <th className="r">Frais</th>
              <th className="r">Espèces nettes</th>
              <th className="r">Flotte actuelle</th>
            </tr>
          </thead>
          <tbody>
            {(summary.data ?? []).map((r) => (
              <tr key={r.account_id}>
                <td>{r.name}</td>
                <td className="r">{r.count}</td>
                {(['deposit', 'withdrawal', 'airtime', 'bill', 'float_in', 'float_out'] as Kind[]).map((k) => (
                  <td key={k} className="r">
                    {amountOf(r, k) ? fcfa(amountOf(r, k)) : ''}
                  </td>
                ))}
                <td className="r">{fcfa(r.commissions)}</td>
                <td className="r">{r.fees ? fcfa(r.fees) : ''}</td>
                <td className={`r ${r.cash_net < 0 ? 'neg' : r.cash_net > 0 ? 'pos' : ''}`}>{fcfa(r.cash_net)}</td>
                <td className="r">{fcfa(r.float)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="muted">
        Espèces nettes : reçues des clients moins données (retraits, achats de flotte), frais compris. Les commissions et les frais sont un produit du magasin (compte 7072).
      </p>
      {editing && (
        <AccountForm
          account={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            accounts.reload();
          }}
        />
      )}
      {floatOp && (
        <FloatDialog
          kind={floatOp}
          accounts={(accounts.data ?? []).filter((a) => a.active)}
          onClose={() => setFloatOp(null)}
          onDone={() => {
            setFloatOp(null);
            accounts.reload();
          }}
        />
      )}
    </>
  );
}

function AccountForm({ account, onClose, onSaved }: { account: Account | null; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [name, setName] = useState(account?.name ?? '');
  const [operator, setOperator] = useState<Operator>(account?.operator ?? 'MTN');
  const [active, setActive] = useState(account ? account.active === 1 : true);
  const [rates, setRates] = useState<Record<string, string>>(() =>
    Object.fromEntries(CLIENT_KINDS.map(({ kind }) => [kind, bpToPct(account?.rates[kind])])),
  );
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const parsed: Partial<Record<Kind, number>> = {};
    for (const { kind } of CLIENT_KINDS) {
      const bp = pctToBp(rates[kind] ?? '');
      if (bp === null) return toast.error(`Commission invalide pour ${KINDS[kind].toLowerCase()}`);
      if (bp) parsed[kind] = bp;
    }
    try {
      await call('agent.saveAccount', { name, operator, rates: parsed, active }, account?.id ?? null);
      toast.ok('Compte agent enregistré');
      onSaved();
    } catch (err) {
      toast.error(err);
    }
  };
  return (
    <Modal title={account ? account.name : 'Nouveau compte agent'} onClose={onClose}>
      <form onSubmit={save}>
        <Field label="Nom du compte" hint="Par exemple « Agent MTN principal »">
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} required />
        </Field>
        <Field label="Opérateur">
          <select value={operator} onChange={(e) => setOperator(e.target.value as Operator)}>
            {(Object.keys(OPERATORS) as Operator[]).map((o) => (
              <option key={o} value={o}>
                {OPERATORS[o]}
              </option>
            ))}
          </select>
        </Field>
        <h3>Commission de l'opérateur (en %)</h3>
        <div className="grid3">
          {CLIENT_KINDS.map(({ kind }) => (
            <Field key={kind} label={KINDS[kind]} hint="Par exemple 0,5">
              <input inputMode="decimal" value={rates[kind] ?? ''} onChange={(e) => setRates({ ...rates, [kind]: e.target.value })} />
            </Field>
          ))}
        </div>
        <label className="inline">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> Actif
        </label>
        <div className="actions">
          <button type="button" onClick={onClose}>
            Annuler
          </button>
          <button type="submit" className="primary">
            Enregistrer
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** Approvisionnement de la flotte, flotte revendue, commission versée par l'opérateur. */
function FloatDialog({ kind, accounts, onClose, onDone }: { kind: 'float_in' | 'float_out' | 'commission'; accounts: Account[]; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? '');
  const [amount, setAmount] = useState('');
  const [reference, setReference] = useState('');
  const [busy, setBusy] = useState(false);
  const account = accounts.find((a) => a.id === accountId);
  const title = { float_in: 'Approvisionner la flotte', float_out: 'Revendre de la flotte', commission: "Commission reçue de l'opérateur" }[kind];
  const save = async () => {
    setBusy(true);
    try {
      const op = await call('agent.record', { accountId, kind, amount: parseAmount(amount) ?? 0, commission: 0, reference: reference.trim() || null });
      toast.ok(`Opération ${op.number} enregistrée`);
      onDone();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={title} onClose={onClose}>
      <Field label="Compte agent">
        <select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name} · flotte {fcfa(a.float)}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Montant (FCFA)">
        <input autoFocus inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} />
      </Field>
      <Field label="Référence" hint="Numéro de la transaction de l'opérateur">
        <input value={reference} onChange={(e) => setReference(e.target.value)} />
      </Field>
      <p className="muted">
        {kind === 'float_in'
          ? 'Les espèces sortent de la journée de la caisse ouverte et la flotte du compte augmente.'
          : kind === 'float_out'
            ? 'La flotte du compte diminue et les espèces reçues entrent dans la journée de la caisse ouverte.'
            : "La commission versée par l'opérateur sur la puce augmente la flotte, sans espèces."}
        {account ? ` Flotte actuelle : ${fcfa(account.float)}.` : ''}
      </p>
      <div className="actions">
        <button onClick={onClose}>Annuler</button>
        <button className="primary" disabled={busy || !accountId || !parseAmount(amount)} onClick={save}>
          Enregistrer
        </button>
      </div>
    </Modal>
  );
}
