import { DOC_LANGS, DOC_LANG_LABELS, type DocLang, PRICE_LEVELS, type PriceLevel, parseArticlePrices, parseFamilyDiscounts } from '@superette/core';
import { useState } from 'react';
import { type Result, call } from '../api';
import { Field, Modal, dateFr, fcfa, has, parseAmount, useCan, useLoad, useStoreSettings, useToast } from '../ui';
import { ArticlePicker } from './pickers';

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
  canLinkSupplier = false,
}: {
  value: CustomerDraft;
  onChange: (v: CustomerDraft) => void;
  canSetCredit: boolean;
  canSetLevel?: boolean;
  /** Relier la fiche à un fournisseur, pour compenser les deux comptes. */
  canLinkSupplier?: boolean;
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
        <Field label="Zone ou tournée" hint="Quartier ou tournée du livreur : la liste des clients se filtre par zone">
          <input list="customer-zones" value={value.zone} onChange={(e) => set({ zone: e.target.value })} placeholder="BONAMOUSSADI" />
        </Field>
        <CustomerRepField value={value.fieldRepId} onChange={(fieldRepId) => set({ fieldRepId })} />
        {canLinkSupplier && <LinkedSupplier value={value.supplierId} onChange={(supplierId) => set({ supplierId })} />}
      </div>
      <label className="check" title={canSetCredit ? 'Le client ne peut plus payer par chèque, ni en caisse ni en règlement' : 'Fixé par le gérant ou le comptable'}>
        <input type="checkbox" checked={value.noCheque} disabled={!canSetCredit} onChange={(e) => set({ noCheque: e.target.checked })} /> Interdit de chèque
      </label>
      <ZoneList />
      {canSetLevel && <FamilyDiscountFields value={value.discounts} onChange={(discounts) => set({ discounts })} />}
      {canSetLevel && <ArticlePriceFields value={value.prices} onChange={(prices) => set({ prices })} />}
    </>
  );
}

/** Zones déjà utilisées, proposées à la saisie. */
function ZoneList() {
  const zones = useLoad(() => call('customers.zones'), []);
  return (
    <datalist id="customer-zones">
      {(zones.data ?? []).map((z) => (
        <option key={z.zone} value={z.zone} />
      ))}
    </datalist>
  );
}

/** Le même tiers est aussi fournisseur : ses deux comptes peuvent se compenser. */
function LinkedSupplier({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const suppliers = useLoad(() => call('suppliers.list'), []);
  return (
    <Field label="Aussi fournisseur" hint="Pour compenser ce qu’il doit avec ce qu’on lui doit">
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Non</option>
        {(suppliers.data ?? []).map((f) => (
          <option key={f.id} value={f.id}>
            {f.name}
          </option>
        ))}
      </select>
    </Field>
  );
}

/** Prix convenus avec le client, article par article : appliqués en caisse quand ils sont plus bas que le prix du jour. */
function ArticlePriceFields({ value, onChange }: { value: Record<string, { name: string; price: string }>; onChange: (v: Record<string, { name: string; price: string }>) => void }) {
  const [adding, setAdding] = useState(false);
  // Noms des articles d'une fiche déjà enregistrée.
  const missing = Object.keys(value).filter((id) => !value[id]!.name);
  const names = useLoad(async () => {
    const found = await Promise.all(missing.map((id) => call('catalogue.get', id).catch(() => null)));
    return Object.fromEntries(found.map((a, i) => [missing[i]!, a?.name ?? '—']));
  }, [missing.join()]);
  const rows = Object.entries(value);
  return (
    <div className="family-discounts">
      <h4>Prix négociés par article</h4>
      <p className="muted">Prix unitaire TTC convenu : la caisse le prend quand il est plus bas que le prix du jour, sans code du gérant.</p>
      {rows.map(([id, r]) => (
        <div key={id} className="inline">
          <span>{r.name || names.data?.[id] || '…'}</span>
          <input inputMode="numeric" style={{ width: 100 }} value={r.price} onChange={(e) => onChange({ ...value, [id]: { ...r, price: e.target.value } })} /> FCFA
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
      {adding ? (
        <ArticlePicker
          placeholder="Article au prix convenu"
          onPick={(a) => {
            onChange({ ...value, [a.id]: { name: a.name, price: '' } });
            setAdding(false);
          }}
        />
      ) : (
        <button type="button" onClick={() => setAdding(true)}>
          Ajouter un article
        </button>
      )}
    </div>
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
  /** Le client ne peut plus payer par chèque (chèque revenu impayé). */
  noCheque: boolean;
  zone: string;
  /** Commercial de terrain qui suit le client (vide : aucun). */
  fieldRepId: string;
  supplierId: string;
  /** Prix convenu (texte saisi) par article. */
  prices: Record<string, { name: string; price: string }>;
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
  noCheque: c ? c.no_cheque === 1 : false,
  discounts: Object.fromEntries(Object.entries(parseFamilyDiscounts(c?.family_discounts)).map(([k, bp]) => [k, String(bp / 100).replace('.', ',')])),
  zone: c?.zone ?? '',
  fieldRepId: c?.field_rep_id ?? '',
  supplierId: c?.supplier_id ?? '',
  prices: Object.fromEntries(Object.entries(parseArticlePrices(c?.article_prices)).map(([k, price]) => [k, { name: '', price: String(price) }])),
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
    noCheque: d.noCheque,
    familyDiscounts: Object.fromEntries(
      Object.entries(d.discounts)
        .filter(([, v]) => v.trim())
        .map(([k, v]) => {
          const pct = Number(v.replace(',', '.'));
          if (!Number.isFinite(pct) || pct <= 0 || pct > 50) throw new Error('Remise par famille invalide : entre 0 et 50 %');
          return [k, Math.round(pct * 100)];
        }),
    ),
    zone: d.zone.trim() || null,
    fieldRepId: d.fieldRepId || null,
    supplierId: d.supplierId || null,
    articlePrices: Object.fromEntries(
      Object.entries(d.prices)
        .filter(([, r]) => r.price.trim())
        .map(([k, r]) => {
          const price = parseAmount(r.price);
          if (!price) throw new Error(`Prix négocié invalide pour ${r.name}`);
          return [k, price];
        }),
    ),
  };
}

/** Plafond de crédit et délai de paiement : droit « Situation des comptes clients ». */
export const canSetCredit = (user: User) => has(user, 'receivables');
/** Tarif du client (détail, gros, super gros). */
export const canSetLevel = (user: User) => has(user, 'customer_price_level');
/** Fiche fournisseur liée (compensation des comptes). */
export const canLinkSupplier = (user: User) => has(user, 'account_offsets') || has(user, 'receivables');

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
  const can = useCan();
  // Lettrage : factures cochées, réglées dans l'ordre coché ; sinon les plus anciennes d'abord.
  const [picked, setPicked] = useState<string[]>([]);
  const balance = account.data?.balance ?? 0;
  const items = account.data?.openItems ?? [];
  const lettering = can('customer_lettering') && items.length > 1;
  const allocate = (total: number) => {
    let left = total;
    return picked.flatMap((id) => {
      const item = items.find((i) => i.id === id);
      const amount = Math.min(item?.remaining ?? 0, left);
      left -= amount;
      return amount > 0 ? [{ saleId: id, amount }] : [];
    });
  };

  return (
    <Modal title={customer ? `Règlement de ${customer.name}` : 'Règlement client'} onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          const v = parseAmount(amount || String(balance));
          if (!chosen) return toast.error('Choisissez le client');
          if (!v) return toast.error('Montant invalide');
          try {
            const p = await call('customers.pay', { customerId: chosen, method, amount: v, reference: reference || null, atRegister, allocations: picked.length ? allocate(v) : null });
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
        {lettering && (
          <div className="family-discounts">
            <h4>Factures réglées</h4>
            <p className="muted">Cochez les factures que le client règle ; sans choix, les plus anciennes sont soldées d'abord.</p>
            {items.map((i) => (
              <label key={i.id} className="inline">
                <input type="checkbox" checked={picked.includes(i.id)} onChange={(e) => setPicked(e.target.checked ? [...picked, i.id] : picked.filter((x) => x !== i.id))} /> {i.number} ·{' '}
                {dateFr(i.created_at.slice(0, 10))} · reste {fcfa(i.remaining)}
              </label>
            ))}
            {picked.length > 0 && !amount && (
              <button type="button" className="link" onClick={() => setAmount(String(picked.reduce((t, id) => t + (items.find((i) => i.id === id)?.remaining ?? 0), 0)))}>
                Montant des factures cochées
              </button>
            )}
          </div>
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

/** Commercial de terrain qui suit le client : ses ventes lui sont attribuées, avec sa zone et sa ville du jour. */
function CustomerRepField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const can = useCan();
  const reps = useLoad(() => call('fieldReps.list', true), []);
  if (!reps.data?.length) return null;
  return (
    <Field label="Commercial de terrain" hint={can('field_reps') ? 'Ses ventes à ce client comptent pour lui, dans sa zone' : 'Choisi par le gérant'}>
      <select value={value} disabled={!can('field_reps')} onChange={(e) => onChange(e.target.value)}>
        <option value="">Aucun</option>
        {reps.data.map((r) => (
          <option key={r.id} value={r.id} disabled={!r.active && r.id !== value}>
            {r.name} ({r.city} › {r.zone}){r.active ? '' : ' · inactif'}
          </option>
        ))}
      </select>
    </Field>
  );
}
