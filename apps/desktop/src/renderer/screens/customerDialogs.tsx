import { useState } from 'react';
import { type Result, call } from '../api';
import { Field, Modal, fcfa, parseAmount, useLoad, useToast } from '../ui';

export type Customer = Result<'customers.get'>;
type User = NonNullable<Result<'app.state'>['user']>;

export const CUSTOMER_PAY_METHODS = {
  CASH: 'Espèces',
  MTN_MOMO: 'MTN MoMo',
  ORANGE_MONEY: 'Orange Money',
  BANK_TRANSFER: 'Virement',
  CHEQUE: 'Chèque',
  CARD: 'Carte',
} as const;

/** Champs de la fiche client, partagés par la caisse (création rapide) et l'écran Clients. */
export function CustomerFields({
  value,
  onChange,
  canSetCredit,
}: {
  value: CustomerDraft;
  onChange: (v: CustomerDraft) => void;
  canSetCredit: boolean;
}) {
  const set = (patch: Partial<CustomerDraft>) => onChange({ ...value, ...patch });
  return (
    <>
      <div className="grid2">
        <Field label="Nom ou raison sociale">
          <input autoFocus value={value.name} onChange={(e) => set({ name: e.target.value })} required />
        </Field>
        <Field label="Téléphone">
          <input value={value.phone} onChange={(e) => set({ phone: e.target.value })} />
        </Field>
        <Field label="Interlocuteur">
          <input value={value.contact} onChange={(e) => set({ contact: e.target.value })} />
        </Field>
        <Field label="Adresse">
          <input value={value.address} onChange={(e) => set({ address: e.target.value })} />
        </Field>
        <Field label="NIU (numéro contribuable)">
          <input value={value.taxpayerNumber} onChange={(e) => set({ taxpayerNumber: e.target.value })} />
        </Field>
        <Field label="E-mail">
          <input value={value.email} onChange={(e) => set({ email: e.target.value })} />
        </Field>
      </div>
      <div className="grid3">
        <Field label="Plafond de crédit (FCFA)" hint={canSetCredit ? '0 = pas de vente à crédit sans accord du gérant' : 'Fixé par le gérant ou le comptable'}>
          <input inputMode="numeric" value={value.creditLimit} disabled={!canSetCredit} onChange={(e) => set({ creditLimit: e.target.value })} />
        </Field>
        <Field label="Délai de paiement (jours)">
          <input inputMode="numeric" value={value.terms} onChange={(e) => set({ terms: e.target.value })} />
        </Field>
        <Field label="Notes">
          <input value={value.notes} onChange={(e) => set({ notes: e.target.value })} />
        </Field>
      </div>
    </>
  );
}

export interface CustomerDraft {
  name: string;
  phone: string;
  contact: string;
  address: string;
  taxpayerNumber: string;
  email: string;
  creditLimit: string;
  terms: string;
  notes: string;
  active: boolean;
}

export const draftOf = (c: Customer | null): CustomerDraft => ({
  name: c?.name ?? '',
  phone: c?.phone ?? '',
  contact: c?.contact ?? '',
  address: c?.address ?? '',
  taxpayerNumber: c?.taxpayer_number ?? '',
  email: c?.email ?? '',
  creditLimit: String(c?.credit_limit ?? 0),
  terms: String(c?.payment_terms_days ?? 30),
  notes: c?.notes ?? '',
  active: c ? c.active === 1 : true,
});

export function inputOf(d: CustomerDraft) {
  const limit = parseAmount(d.creditLimit || '0');
  const terms = Number(d.terms || '0');
  if (limit === null || !Number.isInteger(terms) || terms < 0) throw new Error('Plafond ou délai de paiement invalide');
  return {
    name: d.name,
    phone: d.phone || null,
    contact: d.contact || null,
    address: d.address || null,
    taxpayerNumber: d.taxpayerNumber || null,
    email: d.email || null,
    creditLimit: limit,
    paymentTermsDays: terms,
    notes: d.notes || null,
    active: d.active,
  };
}

export const canSetCredit = (user: User) => user.role === 'admin' || user.role === 'manager' || user.role === 'accountant';

/** Choix du client depuis la fiche de facturation, avec création rapide. */
export function CustomerPickDialog({ user, onClose, onPick }: { user: User; onClose: () => void; onPick: (c: Customer) => void }) {
  const toast = useToast();
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState<CustomerDraft | null>(null);
  const list = useLoad(() => call('customers.list', { search }), [search]);

  if (creating) {
    return (
      <Modal title="Nouveau client" onClose={() => setCreating(null)} wide>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              onPick(await call('customers.save', inputOf(creating)));
            } catch (err) {
              toast.error(err);
            }
          }}
        >
          <CustomerFields value={creating} onChange={setCreating} canSetCredit={canSetCredit(user)} />
          <div className="actions">
            <button type="button" onClick={() => setCreating(null)}>
              Retour
            </button>
            <button type="submit" className="primary">
              Créer et choisir
            </button>
          </div>
        </form>
      </Modal>
    );
  }

  return (
    <Modal title="Choisir le client" onClose={onClose} wide>
      <div className="toolbar">
        <input autoFocus placeholder="Nom, code ou téléphone" value={search} onChange={(e) => setSearch(e.target.value)} />
        <button className="primary" onClick={() => setCreating({ ...draftOf(null), name: search })}>
          Nouveau client
        </button>
      </div>
      <table className="list compact">
        <thead>
          <tr>
            <th>Code</th>
            <th>Client</th>
            <th>Téléphone</th>
            <th className="r">Plafond</th>
            <th className="r">Doit</th>
          </tr>
        </thead>
        <tbody>
          {(list.data ?? []).map((c) => (
            <tr key={c.id} className="clickable" onClick={() => onPick(c)}>
              <td>{c.code}</td>
              <td>{c.name}</td>
              <td>{c.phone}</td>
              <td className="r">{fcfa(c.credit_limit)}</td>
              <td className={`r ${c.overdue > 0 ? 'neg' : ''}`}>{c.balance ? fcfa(c.balance) : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Modal>
  );
}

/**
 * Règlement d'un client sur son compte. À la caisse (atRegister), il entre dans
 * la session ouverte et les espèces comptent dans le tiroir.
 */
export function CustomerPaymentDialog({
  customer,
  atRegister,
  onClose,
  onPaid,
}: {
  customer?: Customer | null;
  atRegister: boolean;
  onClose: () => void;
  onPaid: (paymentId: string) => void;
}) {
  const toast = useToast();
  const [chosen, setChosen] = useState<string>(customer?.id ?? '');
  const customers = useLoad(() => (customer ? Promise.resolve([]) : call('customers.list', { withBalance: true })), []);
  const account = useLoad(() => (chosen ? call('customers.account', chosen) : Promise.resolve(null)), [chosen]);
  const [method, setMethod] = useState<keyof typeof CUSTOMER_PAY_METHODS>('CASH');
  const [amount, setAmount] = useState('');
  const [reference, setReference] = useState('');
  const balance = account.data?.balance ?? 0;

  return (
    <Modal title={customer ? `Règlement de ${customer.name}` : 'Règlement client'} onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          const v = parseAmount(amount || String(balance));
          if (!chosen) return toast.error('Choisissez le client');
          if (!v) return toast.error('Montant invalide');
          try {
            const p = await call('customers.pay', { customerId: chosen, method, amount: v, reference: reference || null, atRegister });
            toast.ok(`Règlement ${p.number} enregistré`);
            onPaid(p.id);
          } catch (err) {
            toast.error(err);
          }
        }}
      >
        {!customer && (
          <Field label="Client">
            <select value={chosen} onChange={(e) => setChosen(e.target.value)} required>
              <option value="">Choisir…</option>
              {(customers.data ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} · doit {fcfa(c.balance)}
                </option>
              ))}
            </select>
          </Field>
        )}
        {account.data && (
          <p>
            Doit <strong>{fcfa(balance)}</strong>
            {account.data.overdue > 0 && <span className="neg"> dont {fcfa(account.data.overdue)} en retard</span>}
          </p>
        )}
        <div className="methods">
          {(Object.keys(CUSTOMER_PAY_METHODS) as (keyof typeof CUSTOMER_PAY_METHODS)[]).map((m) => (
            <button type="button" key={m} className={method === m ? 'active' : ''} onClick={() => setMethod(m)}>
              {CUSTOMER_PAY_METHODS[m]}
            </button>
          ))}
        </div>
        <Field label="Montant (FCFA)" hint={balance ? `Vide = tout le solde (${fcfa(balance)})` : undefined}>
          <input autoFocus inputMode="numeric" value={amount} placeholder={balance ? String(balance) : ''} onChange={(e) => setAmount(e.target.value)} />
        </Field>
        {method !== 'CASH' && (
          <Field label={method === 'CHEQUE' ? 'N° de chèque' : 'Référence de la transaction'}>
            <input value={reference} onChange={(e) => setReference(e.target.value)} required />
          </Field>
        )}
        {atRegister && method === 'CASH' && <p className="muted">Les espèces entrent dans le tiroir et apparaissent sur le Z.</p>}
        <div className="actions">
          <button type="submit" className="primary" disabled={!chosen || !balance}>
            Valider le règlement
          </button>
        </div>
      </form>
    </Modal>
  );
}
