import { useState } from 'react';
import { type Result, call } from '../api';
import { Empty, Field, Modal, SupervisorPrompt, Tabs, dateFr, dateTime, fcfa, parseAmount, today, useLoad, useToast } from '../ui';

type User = NonNullable<Result<'app.state'>['user']>;
type Expense = Result<'expenses.get'>;
type Category = Result<'expenses.categories'>[number];
export type ExpensesTab = 'list' | 'new' | 'summary' | 'categories' | 'plans' | 'schedule';

export const EXPENSE_METHODS = {
  CASH: 'Espèces',
  MTN_MOMO: 'MTN MoMo',
  ORANGE_MONEY: 'Orange Money',
  BANK_TRANSFER: 'Virement',
  CHEQUE: 'Chèque',
  CARD: 'Carte',
} as const;
type Method = keyof typeof EXPENSE_METHODS;

const isManager = (u: User) => u.role === 'admin' || u.role === 'manager';
const monthStart = () => `${today().slice(0, 7)}-01`;

/** Dépenses courantes : loyer, ENEO, salaires, transport… Elles passent seules en comptabilité. */
export function Expenses({ user, initialTab = 'list' }: { user: User; initialTab?: ExpensesTab }) {
  const [tab, setTab] = useState<ExpensesTab>(initialTab === 'new' ? 'list' : initialTab);
  return (
    <div className="page">
      <header className="page-head">
        <h1>Charges et dépenses</h1>
      </header>
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          ['schedule', 'Constats de charges'],
          ['list', 'Historique des dépenses'],
          ['summary', 'Par catégorie'],
          ['plans', 'Charges fixes'],
          ['categories', 'Types de charge'],
        ]}
      />
      {tab === 'list' && <ExpenseList user={user} autoAdd={initialTab === 'new'} />}
      {tab === 'summary' && <Summary />}
      {tab === 'categories' && <Categories />}
      {tab === 'plans' && <ChargePlans />}
      {tab === 'schedule' && <ChargeSchedule />}
    </div>
  );
}

function ExpenseList({ user, autoAdd = false }: { user: User; autoAdd?: boolean }) {
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(today());
  const [category, setCategory] = useState('');
  const [cancelled, setCancelled] = useState(false);
  const [adding, setAdding] = useState(autoAdd);
  const [open, setOpen] = useState<string | null>(null);
  const categories = useLoad(() => call('expenses.categories', true), []);
  const list = useLoad(
    () => call('expenses.list', { from: from || undefined, to: to || undefined, categoryId: category || undefined, includeCancelled: cancelled }),
    [from, to, category, cancelled],
  );
  const rows = list.data ?? [];
  const total = rows.filter((e) => e.status === 'active').reduce((t, e) => t + e.amount, 0);
  return (
    <>
      <div className="filters">
        <label className="inline">
          Du <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="inline">
          au <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        <select value={category} onChange={(e) => setCategory(e.target.value)}>
          <option value="">Toutes les catégories</option>
          {(categories.data ?? []).map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <label>
          <input type="checkbox" checked={cancelled} onChange={(e) => setCancelled(e.target.checked)} /> Annulées
        </label>
        <button className="primary" style={{ marginLeft: 'auto' }} onClick={() => setAdding(true)}>
          Nouvelle dépense
        </button>
      </div>
      {rows.length === 0 ? (
        <Empty>Aucune dépense sur la période. Saisissez ici le loyer, les factures ENEO, les salaires… ; les petites dépenses payées au tiroir se saisissent depuis la caisse (Action › Dépense payée en caisse).</Empty>
      ) : (
        <table className="list compact">
          <thead>
            <tr>
              <th>Date</th>
              <th>N°</th>
              <th>Catégorie</th>
              <th>Objet</th>
              <th>Bénéficiaire</th>
              <th>Paiement</th>
              <th className="r">Montant</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((e) => (
              <tr key={e.id} className={`clickable ${e.status === 'cancelled' ? 'inactive' : ''}`} onClick={() => setOpen(e.id)}>
                <td>{dateFr(e.expense_date)}</td>
                <td className="nowrap">{e.number}</td>
                <td>{e.category_name}</td>
                <td>
                  {e.label}
                  {e.plan_id && <span className="tag normal">charge {monthLabel(e.plan_period!)}</span>}
                  {e.status === 'cancelled' && <span className="tag">annulée</span>}
                </td>
                <td>{e.beneficiary}</td>
                <td>
                  {EXPENSE_METHODS[e.method]}
                  {e.register_name ? <span className="muted"> · tiroir {e.register_name}</span> : ''}
                </td>
                <td className="r">{fcfa(e.amount)}</td>
              </tr>
            ))}
            <tr className="total">
              <td colSpan={6}>Total des dépenses</td>
              <td className="r">{fcfa(total)}</td>
            </tr>
          </tbody>
        </table>
      )}
      {adding && (
        <ExpenseDialog
          atRegister={false}
          needsSupervisor={false}
          onClose={() => setAdding(false)}
          onSaved={() => {
            setAdding(false);
            list.reload();
          }}
        />
      )}
      {open && (
        <ExpenseDetail
          id={open}
          user={user}
          onClose={() => setOpen(null)}
          onChanged={() => {
            setOpen(null);
            list.reload();
          }}
        />
      )}
    </>
  );
}

export interface ChargePreset {
  planId: string;
  planPeriod: string;
  categoryId: string;
  label: string;
  beneficiary: string | null;
  amount: number;
  method: Method;
}

/** Saisie d'une dépense. À la caisse, elle est payée avec les espèces du tiroir et sort du Z. */
export function ExpenseDialog({
  atRegister,
  needsSupervisor,
  preset,
  onClose,
  onSaved,
}: {
  atRegister: boolean;
  needsSupervisor: boolean;
  /** Échéance de charge fixe à constater : la saisie part de la charge prévue. */
  preset?: ChargePreset;
  onClose: () => void;
  onSaved: (e: Expense) => void;
}) {
  const toast = useToast();
  const categories = useLoad(() => call('expenses.categories'), []);
  const [categoryId, setCategoryId] = useState(preset?.categoryId ?? '');
  const [label, setLabel] = useState(preset?.label ?? '');
  const [beneficiary, setBeneficiary] = useState(preset?.beneficiary ?? '');
  const [amount, setAmount] = useState(preset ? String(preset.amount) : '');
  const [vat, setVat] = useState('');
  const [method, setMethod] = useState<Method>(preset?.method ?? 'CASH');
  const [reference, setReference] = useState('');
  const [date, setDate] = useState(today());
  const [askPin, setAskPin] = useState(false);
  const value = parseAmount(amount);

  const submit = async (pin?: string) => {
    const v = vat ? parseAmount(vat) : 0;
    if (!value) return toast.error('Montant invalide');
    if (v === null) return toast.error('TVA invalide');
    try {
      const e = await call('expenses.record', {
        categoryId,
        label,
        beneficiary: beneficiary || null,
        amount: value,
        vat: v,
        method: atRegister ? 'CASH' : method,
        reference: reference || null,
        date: atRegister ? null : date,
        atRegister,
        supervisorPin: pin,
        planId: preset?.planId ?? null,
        planPeriod: preset?.planPeriod ?? null,
      });
      toast.ok(`Dépense ${e.number} enregistrée`);
      onSaved(e);
    } catch (err) {
      toast.error(err);
    }
  };

  return (
    <Modal title={atRegister ? 'Dépense payée avec les espèces du tiroir' : preset ? `Constater : ${preset.label}` : 'Nouvelle dépense'} onClose={onClose} wide={!atRegister}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (needsSupervisor) setAskPin(true);
          else void submit();
        }}
      >
        <div className={atRegister ? '' : 'grid2'}>
          <Field label="Catégorie">
            <select autoFocus value={categoryId} onChange={(e) => setCategoryId(e.target.value)} required>
              <option value="">Choisir…</option>
              {(categories.data ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Objet">
            <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={atRegister ? 'Taxi livraison, sacs, crédit téléphone…' : 'Loyer d’octobre, facture ENEO…'} required />
          </Field>
          <Field label="Bénéficiaire">
            <input value={beneficiary} onChange={(e) => setBeneficiary(e.target.value)} placeholder="Nom, société" />
          </Field>
          {!atRegister && (
            <Field label="Date">
              <input type="date" value={date} max={today()} onChange={(e) => setDate(e.target.value)} required />
            </Field>
          )}
          <Field label="Montant payé (FCFA)">
            <input inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} required />
          </Field>
          {!atRegister && (
            <Field label="TVA récupérable (FCFA)" hint="Seulement si la facture porte la TVA et votre NIU">
              <div className="inline">
                <input inputMode="numeric" value={vat} onChange={(e) => setVat(e.target.value)} placeholder="0" />
                <button type="button" className="nowrap" disabled={!value} onClick={() => setVat(String(value! - Math.round((value! * 10000) / 11925)))}>
                  19,25 %
                </button>
              </div>
            </Field>
          )}
        </div>
        {!atRegister && (
          <>
            <div className="methods six">
              {(Object.keys(EXPENSE_METHODS) as Method[]).map((m) => (
                <button type="button" key={m} className={method === m ? 'active' : ''} onClick={() => setMethod(m)}>
                  {EXPENSE_METHODS[m]}
                </button>
              ))}
            </div>
            <Field
              label={method === 'CASH' ? 'N° de facture ou de reçu (facultatif)' : method === 'CHEQUE' ? 'N° de chèque' : 'Référence de la transaction'}
              hint={method === 'CASH' ? 'Espèces du coffre ou de la caisse du bureau : le tiroir de la caisse ne bouge pas' : undefined}
            >
              <input value={reference} onChange={(e) => setReference(e.target.value)} required={method !== 'CASH'} />
            </Field>
          </>
        )}
        {atRegister && <p className="muted">Le montant sort du tiroir : il apparaît sur le Z et diminue les espèces attendues. Un bon de sortie s'imprime pour signature.</p>}
        <div className="actions">
          <button type="button" onClick={onClose}>
            Annuler
          </button>
          <button type="submit" className="primary" disabled={!value || !categoryId}>
            Enregistrer la dépense
          </button>
        </div>
      </form>
      {askPin && (
        <SupervisorPrompt
          action={`Sortie de caisse de ${fcfa(value ?? 0)}`}
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

function ExpenseDetail({ id, user, onClose, onChanged }: { id: string; user: User; onClose: () => void; onChanged: () => void }) {
  const toast = useToast();
  const e = useLoad(() => call('expenses.get', id), [id]).data;
  const [reason, setReason] = useState('');
  const [cancelling, setCancelling] = useState(false);
  const [askPin, setAskPin] = useState(false);
  const cancel = async (pin?: string) => {
    try {
      await call('expenses.cancel', id, reason, pin);
      toast.ok('Dépense annulée');
      onChanged();
    } catch (err) {
      toast.error(err);
    }
  };
  if (!e) return null;
  return (
    <Modal title={`Dépense ${e.number}`} onClose={onClose}>
      <table className="list compact">
        <tbody>
          <tr>
            <td>Date</td>
            <td>{dateFr(e.expense_date)}</td>
          </tr>
          <tr>
            <td>Catégorie</td>
            <td>
              {e.category_name} <span className="muted">· compte {e.account_id}</span>
            </td>
          </tr>
          <tr>
            <td>Objet</td>
            <td>{e.label}</td>
          </tr>
          {e.beneficiary && (
            <tr>
              <td>Bénéficiaire</td>
              <td>{e.beneficiary}</td>
            </tr>
          )}
          <tr>
            <td>Montant</td>
            <td>
              <strong>{fcfa(e.amount)}</strong>
              {e.vat > 0 && <span className="muted"> dont TVA récupérable {fcfa(e.vat)}</span>}
            </td>
          </tr>
          <tr>
            <td>Paiement</td>
            <td>
              {EXPENSE_METHODS[e.method]}
              {e.reference ? ` · ${e.reference}` : ''}
              {e.register_name ? ` · tiroir de ${e.register_name}` : ''}
            </td>
          </tr>
          <tr>
            <td>Saisie</td>
            <td>
              {dateTime(e.created_at)} par {e.user_name}
              {e.authorized_by_name ? `, autorisée par ${e.authorized_by_name}` : ''}
            </td>
          </tr>
          {e.status === 'cancelled' && (
            <tr>
              <td>Annulée</td>
              <td className="neg">
                par {e.cancelled_by_name} : {e.cancel_reason}
              </td>
            </tr>
          )}
        </tbody>
      </table>
      {cancelling && (
        <Field label="Motif de l'annulation">
          <input autoFocus value={reason} onChange={(ev) => setReason(ev.target.value)} />
        </Field>
      )}
      <div className="actions">
        <button onClick={() => call('expenses.print', id).catch(toast.error)}>Imprimer la pièce</button>
        {e.status === 'active' &&
          (cancelling ? (
            <button className="danger" disabled={!reason.trim()} onClick={() => (isManager(user) ? void cancel() : setAskPin(true))}>
              Confirmer l'annulation
            </button>
          ) : (
            <button onClick={() => setCancelling(true)}>Annuler la dépense</button>
          ))}
      </div>
      {askPin && (
        <SupervisorPrompt
          action={`Annulation de la dépense ${e.number}`}
          onCancel={() => setAskPin(false)}
          onConfirm={(pin) => {
            setAskPin(false);
            void cancel(pin);
          }}
        />
      )}
    </Modal>
  );
}

function Summary() {
  const [from, setFrom] = useState(`${today().slice(0, 4)}-01-01`);
  const [to, setTo] = useState(today());
  const sum = useLoad(() => call('expenses.summary', { from: from || undefined, to: to || undefined }), [from, to]).data;
  const maxMonth = Math.max(1, ...(sum?.byMonth ?? []).map((m) => m.amount));
  return (
    <>
      <div className="filters">
        <label className="inline">
          Du <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="inline">
          au <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
      </div>
      {sum && (
        <>
          <div className="kpis">
            <div>
              <small>Total des dépenses</small>
              <strong>{fcfa(sum.total)}</strong>
            </div>
            <div>
              <small>dont TVA récupérable</small>
              <strong>{fcfa(sum.vat)}</strong>
            </div>
            <div>
              <small>Nombre de dépenses</small>
              <strong>{sum.byCategory.reduce((t, c) => t + c.count, 0)}</strong>
            </div>
            <div>
              <small>Plus gros poste</small>
              <strong>{sum.byCategory[0]?.name ?? '—'}</strong>
            </div>
          </div>
          <div className="grid2 top">
            <table className="list compact">
              <caption>Par catégorie</caption>
              <thead>
                <tr>
                  <th>Catégorie</th>
                  <th>Compte</th>
                  <th className="r">Nombre</th>
                  <th className="r">Montant</th>
                  <th className="r">Part</th>
                </tr>
              </thead>
              <tbody>
                {sum.byCategory.map((c) => (
                  <tr key={`${c.id}-${c.account_id}`}>
                    <td>{c.name}</td>
                    <td>{c.account_id}</td>
                    <td className="r">{c.count}</td>
                    <td className="r">{fcfa(c.amount)}</td>
                    <td className="r">{sum.total ? (c.amount * 100 < sum.total ? '< 1 %' : `${Math.round((c.amount / sum.total) * 100)} %`) : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div>
              <table className="list compact">
                <caption>Par mode de paiement</caption>
                <tbody>
                  {sum.byMethod.map((m) => (
                    <tr key={m.method}>
                      <td>{m.label}</td>
                      <td className="r">{fcfa(m.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <h3>Par mois</h3>
              <div className="bars">
                {sum.byMonth.map((m) => (
                  <div key={m.month} className="bar-row">
                    <span>{m.month.slice(5)}/{m.month.slice(2, 4)}</span>
                    <div className="bar" style={{ width: `${(m.amount / maxMonth) * 100}%` }} />
                    <span className="r">{fcfa(m.amount)}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </>
      )}
    </>
  );
}

function Categories() {
  const list = useLoad(() => call('expenses.categories', true), []);
  const [open, setOpen] = useState<Category | 'new' | null>(null);
  return (
    <>
      <div className="filters">
        <span className="muted">Chaque catégorie passe sur un compte de charges du plan comptable (classe 6).</span>
        <button className="primary" style={{ marginLeft: 'auto' }} onClick={() => setOpen('new')}>
          Nouvelle catégorie
        </button>
      </div>
      <table className="list compact">
        <thead>
          <tr>
            <th>Catégorie</th>
            <th>Compte</th>
            <th>Intitulé du compte</th>
          </tr>
        </thead>
        <tbody>
          {(list.data ?? []).map((c) => (
            <tr key={c.id} className={`clickable ${c.active ? '' : 'inactive'}`} onClick={() => setOpen(c)}>
              <td>{c.name}</td>
              <td>{c.account_id}</td>
              <td>{c.account_label}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {open && (
        <CategoryDialog
          category={open === 'new' ? null : open}
          onClose={() => setOpen(null)}
          onSaved={() => {
            setOpen(null);
            list.reload();
          }}
        />
      )}
    </>
  );
}

function CategoryDialog({ category, onClose, onSaved }: { category: Category | null; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const accounts = useLoad(() => call('accounting.accounts'), []);
  const [name, setName] = useState(category?.name ?? '');
  const [accountId, setAccountId] = useState(category?.account_id ?? '');
  const [active, setActive] = useState(category ? category.active === 1 : true);
  return (
    <Modal title={category ? category.name : 'Nouvelle catégorie'} onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await call('expenses.saveCategory', { id: category?.id ?? null, name, accountId, active });
            toast.ok('Catégorie enregistrée');
            onSaved();
          } catch (err) {
            toast.error(err);
          }
        }}
      >
        <Field label="Nom">
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} required />
        </Field>
        <Field label="Compte de charges" hint="Les dépenses déjà saisies gardent leur compte">
          <select value={accountId} onChange={(e) => setAccountId(e.target.value)} required>
            <option value="">Choisir…</option>
            {(accounts.data ?? [])
              .filter((a) => a.id.startsWith('6'))
              .map((a) => (
                <option key={a.id} value={a.id}>
                  {a.id} · {a.label}
                </option>
              ))}
          </select>
        </Field>
        <label>
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> Catégorie utilisée
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

// --- Charges fixes ------------------------------------------------------------

type Plan = Result<'charges.plans'>[number];
type Frequency = Plan['frequency'];
const FREQUENCIES: Record<Frequency, string> = { monthly: 'Tous les mois', quarterly: 'Tous les trimestres', yearly: 'Tous les ans' };
const STATES = { paid: 'Constatée', late: 'En retard', due: 'À payer cette semaine', upcoming: 'À venir' } as const;
const MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];

/** « octobre 2026 » pour 2026-10. */
export const monthLabel = (m: string) => `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;
const shiftMonth = (m: string, n: number) => {
  const total = Number(m.slice(0, 4)) * 12 + Number(m.slice(5, 7)) - 1 + n;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`;
};

/** Définition des charges fixes : ce qui revient chaque mois, trimestre ou année. */
function ChargePlans() {
  const plans = useLoad(() => call('charges.plans', true), []);
  const [open, setOpen] = useState<Plan | 'new' | null>(null);
  const monthly = (plans.data ?? [])
    .filter((p) => p.active)
    .reduce((t, p) => t + Math.round(p.amount / (p.frequency === 'monthly' ? 1 : p.frequency === 'quarterly' ? 3 : 12)), 0);
  return (
    <>
      <div className="filters">
        <span className="muted">Loyer, ENEO, CAMWATER, salaires, CNPS, gardiennage… : l'échéancier rappelle chaque échéance jusqu'à ce qu'une dépense la constate.</span>
        <button className="primary" style={{ marginLeft: 'auto' }} onClick={() => setOpen('new')}>
          Nouvelle charge fixe
        </button>
      </div>
      {plans.data?.length === 0 ? (
        <Empty>Aucune charge fixe. Définissez vos charges qui reviennent pour ne plus en oublier.</Empty>
      ) : (
        <table className="list compact">
          <thead>
            <tr>
              <th>Charge</th>
              <th>Type de charge</th>
              <th>Bénéficiaire</th>
              <th>Rythme</th>
              <th className="r">Échéance</th>
              <th>Depuis</th>
              <th>Jusqu'à</th>
              <th>Paiement</th>
              <th className="r">Montant</th>
            </tr>
          </thead>
          <tbody>
            {plans.data?.map((p) => (
              <tr key={p.id} className={`clickable ${p.active ? '' : 'inactive'}`} onClick={() => setOpen(p)}>
                <td>{p.label}</td>
                <td>{p.category_name}</td>
                <td>{p.beneficiary}</td>
                <td>{FREQUENCIES[p.frequency]}</td>
                <td className="r">le {p.due_day}</td>
                <td>{monthLabel(p.start_month)}</td>
                <td>{p.end_month ? monthLabel(p.end_month) : ''}</td>
                <td>{EXPENSE_METHODS[p.method]}</td>
                <td className="r">{fcfa(p.amount)}</td>
              </tr>
            ))}
            <tr className="total">
              <td colSpan={8}>Charges fixes ramenées au mois</td>
              <td className="r">{fcfa(monthly)}</td>
            </tr>
          </tbody>
        </table>
      )}
      {open && (
        <ChargePlanDialog
          plan={open === 'new' ? null : open}
          onClose={() => setOpen(null)}
          onSaved={() => {
            setOpen(null);
            plans.reload();
          }}
        />
      )}
    </>
  );
}

function ChargePlanDialog({ plan, onClose, onSaved }: { plan: Plan | null; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const categories = useLoad(() => call('expenses.categories'), []);
  const [categoryId, setCategoryId] = useState(plan?.category_id ?? '');
  const [label, setLabel] = useState(plan?.label ?? '');
  const [beneficiary, setBeneficiary] = useState(plan?.beneficiary ?? '');
  const [amount, setAmount] = useState(plan ? String(plan.amount) : '');
  const [frequency, setFrequency] = useState<Frequency>(plan?.frequency ?? 'monthly');
  const [dueDay, setDueDay] = useState(String(plan?.due_day ?? 5));
  const [start, setStart] = useState(plan?.start_month ?? today().slice(0, 7));
  const [end, setEnd] = useState(plan?.end_month ?? '');
  const [method, setMethod] = useState<Method>(plan?.method ?? 'CASH');
  const [active, setActive] = useState(plan ? plan.active === 1 : true);
  return (
    <Modal title={plan ? plan.label : 'Nouvelle charge fixe'} onClose={onClose} wide>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          const value = parseAmount(amount);
          if (!value) return toast.error('Montant invalide');
          try {
            await call(
              'charges.savePlan',
              { categoryId, label, beneficiary: beneficiary || null, amount: value, frequency, dueDay: Number(dueDay), startMonth: start, endMonth: end || null, method, active },
              plan?.id ?? null,
            );
            toast.ok('Charge enregistrée');
            onSaved();
          } catch (err) {
            toast.error(err);
          }
        }}
      >
        <div className="grid2">
          <Field label="Libellé">
            <input autoFocus value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Loyer boutique, facture ENEO…" required />
          </Field>
          <Field label="Type de charge">
            <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} required>
              <option value="">Choisir…</option>
              {categories.data?.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Bénéficiaire">
            <input value={beneficiary} onChange={(e) => setBeneficiary(e.target.value)} placeholder="Bailleur, ENEO, employé…" />
          </Field>
          <Field label="Montant prévu (FCFA)" hint="Le montant réel se corrige au moment du paiement">
            <input inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} required />
          </Field>
          <Field label="Rythme">
            <select value={frequency} onChange={(e) => setFrequency(e.target.value as Frequency)}>
              {(Object.keys(FREQUENCIES) as Frequency[]).map((f) => (
                <option key={f} value={f}>
                  {FREQUENCIES[f]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Jour d'échéance" hint="Du 1 au 28">
            <input type="number" min={1} max={28} value={dueDay} onChange={(e) => setDueDay(e.target.value)} required />
          </Field>
          <Field label="Première échéance">
            <input type="month" value={start} onChange={(e) => setStart(e.target.value)} required />
          </Field>
          <Field label="Dernière échéance" hint="Vide : sans fin (bail, abonnement)">
            <input type="month" value={end} onChange={(e) => setEnd(e.target.value)} />
          </Field>
        </div>
        <div className="methods six">
          {(Object.keys(EXPENSE_METHODS) as Method[]).map((m) => (
            <button type="button" key={m} className={method === m ? 'active' : ''} onClick={() => setMethod(m)}>
              {EXPENSE_METHODS[m]}
            </button>
          ))}
        </div>
        {plan && (
          <label>
            <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> Charge en cours (décochez à la fin du bail ou du contrat)
          </label>
        )}
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

/** Constats de charges : chaque échéance des charges fixes, payée ou non. */
function ChargeSchedule() {
  const month = today().slice(0, 7);
  const [from, setFrom] = useState(shiftMonth(month, -2));
  const [to, setTo] = useState(month);
  const [pay, setPay] = useState<ChargePreset | null>(null);
  const data = useLoad(() => call('charges.schedule', from, to), [from, to]);
  const d = data.data;
  return (
    <>
      <div className="filters">
        <label className="inline">
          De <input type="month" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="inline">
          à <input type="month" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        <div className="seg">
          <button onClick={() => (setFrom(month), setTo(month))}>Ce mois</button>
          <button onClick={() => (setFrom(shiftMonth(month, -2)), setTo(month))}>3 derniers mois</button>
          <button onClick={() => (setFrom(`${month.slice(0, 4)}-01`), setTo(`${month.slice(0, 4)}-12`))}>Cette année</button>
        </div>
      </div>
      {d && (
        <div className="kpis">
          <div>
            <small>Prévu sur la période</small>
            <strong>{fcfa(d.totals.expected)}</strong>
          </div>
          <div className="pos">
            <small>Constaté (payé)</small>
            <strong>{fcfa(d.totals.paid)}</strong>
          </div>
          <div className={d.totals.late ? 'neg' : ''}>
            <small>En retard</small>
            <strong>{fcfa(d.totals.late)}</strong>
          </div>
          <div>
            <small>À payer cette semaine</small>
            <strong>{fcfa(d.totals.due)}</strong>
          </div>
        </div>
      )}
      {d && d.occurrences.length === 0 ? (
        <Empty>Aucune échéance : définissez vos charges fixes dans l'onglet Charges fixes.</Empty>
      ) : (
        <table className="list compact">
          <thead>
            <tr>
              <th>Échéance</th>
              <th>Charge</th>
              <th>Type de charge</th>
              <th>Bénéficiaire</th>
              <th>Mois</th>
              <th className="r">Prévu</th>
              <th className="r">Payé</th>
              <th>État</th>
              <th>Dépense</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {d?.occurrences.map((o) => (
              <tr key={`${o.plan_id}-${o.period}`}>
                <td>{dateFr(o.due_date)}</td>
                <td>{o.label}</td>
                <td>{o.category_name}</td>
                <td>{o.beneficiary}</td>
                <td>{monthLabel(o.period)}</td>
                <td className="r">{fcfa(o.expected)}</td>
                <td className={`r ${o.paid && o.paid !== o.expected ? 'neg' : ''}`}>{o.paid ? fcfa(o.paid) : ''}</td>
                <td>
                  <span className={`tag ${o.state === 'paid' ? 'normal' : o.state === 'late' ? 'rupture' : o.state === 'due' ? 'alerte' : ''}`}>
                    {STATES[o.state]}
                  </span>
                </td>
                <td className="muted nowrap">{o.expense_number}</td>
                <td className="r">
                  {o.state !== 'paid' && (
                    <button
                      className="small"
                      onClick={() =>
                        setPay({
                          planId: o.plan_id,
                          planPeriod: o.period,
                          categoryId: o.category_id,
                          label: `${o.label} ${monthLabel(o.period)}`,
                          beneficiary: o.beneficiary,
                          amount: o.expected,
                          method: o.method,
                        })
                      }
                    >
                      Constater
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {pay && (
        <ExpenseDialog
          atRegister={false}
          needsSupervisor={false}
          preset={pay}
          onClose={() => setPay(null)}
          onSaved={() => {
            setPay(null);
            data.reload();
          }}
        />
      )}
    </>
  );
}
