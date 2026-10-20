import { DOC_LANGS, DOC_LANG_LABELS, type DocLang, PRICE_LEVELS, type PriceLevel, parseFamilyDiscounts } from '@superette/core';
import { useState } from 'react';
import { type Result, call } from '../api';
import { Field, Modal, fcfa, has, parseAmount, useLoad, useStoreSettings, useToast } from '../ui';

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
  canSetLevel = canSetCredit,
}: {
  value: CustomerDraft;
  onChange: (v: CustomerDraft) => void;
  canSetCredit: boolean;
  canSetLevel?: boolean;
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
          <input inputMode="numeric" value={value.terms} disabled={!canSetCredit} onChange={(e) => set({ terms: e.target.value })} />
        </Field>
        <Field label="Tarif" hint={canSetLevel ? 'Prix appliqués en caisse : détail, gros (revendeurs) ou super gros' : 'Fixé par le gérant ou le comptable'}>
          <select value={value.priceLevel} disabled={!canSetLevel} onChange={(e) => set({ priceLevel: e.target.value as PriceLevel })}>
            {(Object.keys(PRICE_LEVELS) as PriceLevel[]).map((k) => (
              <option key={k} value={k}>
                {PRICE_LEVELS[k]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Langue des tickets et factures">
          <select translate="no" value={value.language} onChange={(e) => set({ language: e.target.value as DocLang })}>
            {DOC_LANGS.map((k) => (
              <option key={k} value={k}>
                {DOC_LANG_LABELS[k]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Notes">
          <input value={value.notes} onChange={(e) => set({ notes: e.target.value })} />
        </Field>
      </div>
      {canSetLevel && <FamilyDiscountFields value={value.discounts} onChange={(discounts) => set({ discounts })} />}
    </>
  );
}

/** Remises convenues par famille d'articles (catégorie tarifaire) : appliquées en caisse sans code du gérant. */
function FamilyDiscountFields({ value, onChange }: { value: Record<string, string>; onChange: (v: Record<string, string>) => void }) {
  const departments = useLoad(() => call('catalogue.departments'), []);
  const [adding, setAdding] = useState('');
  const families = (departments.data ?? []).flatMap((d) => d.families.map((f) => ({ id: f.id, label: `${d.name} › ${f.name}` })));
  const rows = Object.keys(value);
  return (
    <div className="family-discounts">
      <h4>Remises par famille</h4>
      <p className="muted">Pourcentage retiré du prix en caisse sur les articles de la famille, sans code du gérant.</p>
      {rows.map((id) => (
        <div key={id} className="inline">
          <span>{families.find((f) => f.id === id)?.label ?? 'Famille'}</span>
          <input inputMode="decimal" style={{ width: 70 }} value={value[id]} onChange={(e) => onChange({ ...value, [id]: e.target.value })} /> %
          <button
            type="button"
            className="link"
            onClick={() => {
              const next = { ...value };
              delete next[id];
              onChange(next);
            }}
          >
            Retirer
          </button>
        </div>
      ))}
      <div className="inline">
        <select value={adding} onChange={(e) => setAdding(e.target.value)}>
          <option value="">Ajouter une famille…</option>
          {families
            .filter((f) => !rows.includes(f.id))
            .map((f) => (
              <option key={f.id} value={f.id}>
                {f.label}
              </option>
            ))}
        </select>
        <button
          type="button"
          disabled={!adding}
          onClick={() => {
            onChange({ ...value, [adding]: '' });
            setAdding('');
          }}
        >
          Ajouter
        </button>
      </div>
    </div>
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
  priceLevel: PriceLevel;
  language: DocLang;
  /** Remise en % (texte saisi) par famille. */
  discounts: Record<string, string>;
}

/** Brouillon de la fiche ; un nouveau client prend le plafond et le délai des paramètres du magasin. */
export const draftOf = (c: Customer | null, defaults?: { creditDefaultLimit: number; creditDefaultDays: number }): CustomerDraft => ({
  name: c?.name ?? '',
  phone: c?.phone ?? '',
  contact: c?.contact ?? '',
  address: c?.address ?? '',
  taxpayerNumber: c?.taxpayer_number ?? '',
  email: c?.email ?? '',
  creditLimit: String(c?.credit_limit ?? defaults?.creditDefaultLimit ?? 0),
  terms: String(c?.payment_terms_days ?? defaults?.creditDefaultDays ?? 30),
  notes: c?.notes ?? '',
  active: c ? c.active === 1 : true,
  priceLevel: c?.price_level ?? 'retail',
  language: c?.language ?? 'fr',
  discounts: Object.fromEntries(Object.entries(parseFamilyDiscounts(c?.family_discounts)).map(([k, bp]) => [k, String(bp / 100).replace('.', ',')])),
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
    priceLevel: d.priceLevel,
    language: d.language,
    familyDiscounts: Object.fromEntries(
      Object.entries(d.discounts)
        .filter(([, v]) => v.trim())
        .map(([k, v]) => {
          const pct = Number(v.replace(',', '.'));
          if (!Number.isFinite(pct) || pct <= 0 || pct > 50) throw new Error('Remise par famille invalide : entre 0 et 50 %');
          return [k, Math.round(pct * 100)];
        }),
    ),
  };
}

/** Plafond de crédit et délai de paiement : droit « Situation des comptes clients ». */
export const canSetCredit = (user: User) => has(user, 'receivables');
/** Tarif du client (détail, gros, super gros). */
export const canSetLevel = (user: User) => has(user, 'customer_price_level');

/** Choix du client depuis la fiche de facturation, avec création rapide. */
export function CustomerPickDialog({ user, onClose, onPick }: { user: User; onClose: () => void; onPick: (c: Customer) => void }) {
  const toast = useToast();
  const settings = useStoreSettings();
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
          <CustomerFields value={creating} onChange={setCreating} canSetCredit={canSetCredit(user)} canSetLevel={canSetLevel(user)} />
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
        {has(user, 'customer_create') && (
          <button className="primary" onClick={() => setCreating({ ...draftOf(null, settings), name: search })}>
            Nouveau client
          </button>
        )}
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
