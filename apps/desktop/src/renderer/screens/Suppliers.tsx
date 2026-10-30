import { useState } from 'react';
import { type Result, call } from '../api';
import { askConfirm, Empty, Field, Modal, Tabs, dateFr, fcfa, parseAmount, parseQty, qty, today, useCan, useLoad, useStoreSettings, useToast, has } from '../ui';
import { BalanceDialog, EMPTY_OPENING, OpeningField, saveOpening } from './balanceAdjust';
import { RecentAccounts, SupplierSituation, SupplierStatement } from './Controls';
import { ArticlePicker } from './pickers';
import { tx } from '../tax';

type Supplier = Result<'suppliers.get'>;
type User = NonNullable<Result<'app.state'>['user']>;

export type SuppliersTab = 'list' | 'statement' | 'situation' | 'recent' | 'bonus';

/** Fournisseurs : fiches, extrait de compte, situation et comptes qui ont bougé. */
export function Suppliers({ user, initialTab = 'list' }: { user: User; initialTab?: SuppliersTab }) {
  const [tab, setTab] = useState<SuppliersTab>(initialTab);
  const accounting = has(user, 'supplier_statement');
  return (
    <div className="page">
      <header className="page-head">
        <h1>Fournisseurs</h1>
      </header>
      <Tabs
        main
        value={tab}
        onChange={setTab}
        tabs={[
          ['list', 'Liste des fournisseurs'],
          ...(accounting ? ([['statement', 'Extrait de compte']] as [SuppliersTab, string][]) : []),
          ...(accounting ? ([['situation', 'Situation des fournisseurs']] as [SuppliersTab, string][]) : []),
          ['recent', 'Soldes qui ont bougé'],
          ...(has(user, 'free_goods') ? ([['bonus', 'Bonus fournisseurs']] as [SuppliersTab, string][]) : []),
        ]}
      />
      {tab === 'list' && <SupplierList user={user} />}
      {tab === 'statement' && accounting && <SupplierStatement />}
      {tab === 'situation' && accounting && <SupplierSituation />}
      {tab === 'recent' && <RecentAccounts party="supplier" />}
      {tab === 'bonus' && has(user, 'free_goods') && <FreeGoods />}
    </div>
  );
}

/** Fiches fournisseurs : identité, conditions, articles référencés et compte. */
function SupplierList({ user }: { user: User }) {
  const [search, setSearch] = useState('');
  const [inactive, setInactive] = useState(false);
  const list = useLoad(() => call('suppliers.list', { search: search || undefined, includeInactive: inactive }), [search, inactive]);
  const [open, setOpen] = useState<Supplier | 'new' | null>(null);
  const canEdit = has(user, 'supplier_edit');
  const canArticles = has(user, 'supplier_articles');
  return (
    <>
      <div className="filters">
        <input className="search" placeholder="Rechercher un fournisseur" value={search} onChange={(e) => setSearch(e.target.value)} />
        <label>
          <input type="checkbox" checked={inactive} onChange={(e) => setInactive(e.target.checked)} /> Inactifs
        </label>
        {canEdit && (
          <button data-new title="Ctrl+J" className="primary" style={{ marginLeft: 'auto' }} onClick={() => setOpen('new')}>
            Nouveau fournisseur
          </button>
        )}
      </div>
      {list.data?.length === 0 ? (
        <Empty>Aucun fournisseur. Créez vos fournisseurs habituels (SABC, Guinness, Nestlé, grossistes…) pour passer vos commandes.</Empty>
      ) : (
        <table className="list">
          <thead>
            <tr>
              <th>Code</th>
              <th>Nom</th>
              <th>Contact</th>
              <th>Téléphone</th>
              <th className="r">Délai livraison</th>
              <th className="r">Paiement</th>
              <th className="r">Articles</th>
              <th className="r">Solde dû</th>
            </tr>
          </thead>
          <tbody>
            {(list.data ?? []).map((f) => (
              <tr key={f.id} className={`clickable ${f.active ? '' : 'inactive'}`} onClick={() => setOpen(f)}>
                <td>{f.code}</td>
                <td>{f.name}</td>
                <td>{f.contact}</td>
                <td>{f.phone}</td>
                <td className="r">{f.lead_time_days} j</td>
                <td className="r">{f.payment_terms_days ? `${f.payment_terms_days} j` : 'comptant'}</td>
                <td className="r">{f.article_count}</td>
                <td className={`r ${f.balance > 0 ? 'neg' : ''}`}>{fcfa(f.balance)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {open && (
        <SupplierDialog
          supplier={open === 'new' ? null : open}
          canEdit={canEdit}
          canArticles={canArticles}
          onClose={() => setOpen(null)}
          onSaved={(f) => {
            list.reload();
            setOpen(f);
          }}
        />
      )}
    </>
  );
}

function SupplierDialog({
  supplier,
  canEdit,
  canArticles,
  onClose,
  onSaved,
}: {
  supplier: Supplier | null;
  canEdit: boolean;
  canArticles: boolean;
  onClose: () => void; onSaved: (s: Supplier) => void }) {
  const [tab, setTab] = useState<'card' | 'articles' | 'account'>('card');
  return (
    <Modal title={supplier ? `${supplier.code} · ${supplier.name}` : 'Nouveau fournisseur'} onClose={onClose} wide>
      {supplier && (
        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            ['card', 'Fiche'],
            ['articles', 'Articles référencés'],
            ['account', 'Compte fournisseur'],
          ]}
        />
      )}
      {tab === 'card' && <SupplierForm supplier={supplier} canEdit={canEdit} onSaved={onSaved} />}
      {tab === 'articles' && supplier && <SupplierArticles supplierId={supplier.id} canEdit={canArticles} />}
      {tab === 'account' && supplier && <SupplierAccount supplierId={supplier.id} name={supplier.name} />}
    </Modal>
  );
}

function SupplierForm({ supplier, canEdit, onSaved }: { supplier: Supplier | null; canEdit: boolean; onSaved: (s: Supplier) => void }) {
  const toast = useToast();
  const settings = useStoreSettings();
  const can = useCan();
  const [opening, setOpening] = useState(EMPTY_OPENING);
  const [f, setF] = useState({
    name: supplier?.name ?? '',
    contact: supplier?.contact ?? '',
    phone: supplier?.phone ?? '',
    email: supplier?.email ?? '',
    address: supplier?.address ?? '',
    taxpayerNumber: supplier?.taxpayer_number ?? '',
    paymentTermsDays: String(supplier?.payment_terms_days ?? settings.supplierDefaultDays),
    leadTimeDays: String(supplier?.lead_time_days ?? 2),
    franco: supplier?.franco ? String(supplier.franco) : '',
    notes: supplier?.notes ?? '',
    active: supplier ? supplier.active === 1 : true,
  });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        try {
          const saved = await call(
            'suppliers.save',
            {
              ...f,
              paymentTermsDays: Number(f.paymentTermsDays) || 0,
              leadTimeDays: Number(f.leadTimeDays) || 0,
              franco: f.franco ? parseAmount(f.franco) : null,
            },
            supplier?.id,
          );
          // Nouveau fournisseur : ce qu'on lui doit déjà devient son solde d'ouverture.
          const withOpening = !supplier && (await saveOpening('supplier', saved.id, opening).catch((err) => (toast.error(err), false)));
          toast.ok(withOpening ? "Fournisseur enregistré avec son solde d'ouverture" : 'Fournisseur enregistré');
          onSaved(saved);
        } catch (err) {
          toast.error(err);
        }
      }}
    >
      <fieldset disabled={!canEdit} className="plain">
        <div className="grid2">
          <Field label="Raison sociale">
            <input value={f.name} onChange={set('name')} required autoFocus />
          </Field>
          <Field label="Interlocuteur">
            <input value={f.contact} onChange={set('contact')} />
          </Field>
          <Field label="Téléphone">
            <input value={f.phone} onChange={set('phone')} />
          </Field>
          <Field label="E-mail">
            <input type="email" value={f.email} onChange={set('email')} />
          </Field>
          <Field label="Adresse">
            <input value={f.address} onChange={set('address')} />
          </Field>
          <Field label="NIU (numéro contribuable)">
            <input value={f.taxpayerNumber} onChange={set('taxpayerNumber')} />
          </Field>
        </div>
        <div className="grid3">
          <Field label="Délai de paiement (jours)" hint="0 = comptant">
            <input inputMode="numeric" value={f.paymentTermsDays} onChange={set('paymentTermsDays')} />
          </Field>
          <Field label="Délai de livraison (jours)" hint="Sert au réapprovisionnement">
            <input inputMode="numeric" value={f.leadTimeDays} onChange={set('leadTimeDays')} />
          </Field>
          <Field label="Franco de port (FCFA)" hint="Minimum de commande livré gratuitement">
            <input inputMode="numeric" value={f.franco} onChange={set('franco')} />
          </Field>
        </div>
        <Field label="Notes">
          <input value={f.notes} onChange={set('notes')} />
        </Field>
        {!supplier && can('balance_adjust') && <OpeningField party="supplier" value={opening} onChange={setOpening} />}
        {supplier && (
          <label>
            <input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> Fournisseur actif
          </label>
        )}
      </fieldset>
      {canEdit && (
        <div className="actions">
          <button className="primary" type="submit">
            Enregistrer
          </button>
        </div>
      )}
    </form>
  );
}

function SupplierArticles({ supplierId, canEdit }: { supplierId: string; canEdit: boolean }) {
  const toast = useToast();
  const list = useLoad(() => call('suppliers.articles', supplierId), [supplierId]);
  // Retraits en attente (10 s pour annuler) : déjà masqués.
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [edit, setEdit] = useState<{ articleId: string; name: string; unit: 'piece' | 'kg' | 'litre'; ref: string; cost: string; pack: string; main: boolean; buy: string; pay: string } | null>(null);
  return (
    <>
      {canEdit && (
        <ArticlePicker
          placeholder="Ajouter un article : scanner ou rechercher"
          onPick={(a) => setEdit({ articleId: a.id, name: a.name, unit: a.unit, ref: '', cost: String(a.purchase_price || ''), pack: '1', main: false, buy: '', pay: '' })}
        />
      )}
      <table className="list">
        <thead>
          <tr>
            <th>Réf. fournisseur</th>
            <th>Article</th>
            <th className="r">{tx('Prix négocié HT')}</th>
            <th className="r">Dernier prix payé</th>
            <th className="r">Colisage</th>
            <th>Bonus</th>
            <th>Principal</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {(list.data ?? []).filter((a) => !hidden.has(a.id)).map((a) => (
            <tr
              key={a.id}
              className={canEdit ? 'clickable' : ''}
              onClick={() =>
                canEdit &&
                setEdit({
                  articleId: a.article_id,
                  name: a.article_name,
                  unit: a.unit,
                  ref: a.supplier_ref ?? '',
                  cost: String(a.unit_cost),
                  pack: String(a.pack_qty / 1000).replace('.', ','),
                  main: a.is_main === 1,
                  buy: a.promo_buy ? String(a.promo_buy) : '',
                  pay: a.promo_pay ? String(a.promo_pay) : '',
                })
              }
            >
              <td>{a.supplier_ref}</td>
              <td>
                {a.article_name} <small className="muted">{a.article_code}</small>
              </td>
              <td className="r">{fcfa(a.unit_cost)}</td>
              <td className={`r ${a.last_cost !== null && a.last_cost > a.unit_cost ? 'neg' : ''}`}>{a.last_cost === null ? '' : fcfa(a.last_cost)}</td>
              <td className="r">{qty(a.pack_qty, a.unit)}</td>
              <td>{a.promo_buy ? `${a.promo_buy} achetés, ${a.promo_pay} payés` : ''}</td>
              <td>{a.is_main ? 'Oui' : ''}</td>
              <td>
                {canEdit && (
                  <button
                    className="ghost"
                    onClick={(e) => {
                      e.stopPropagation();
                      setHidden((h) => new Set(h).add(a.id));
                      toast.later(
                        `« ${a.article_name} » n'est plus référencé chez ce fournisseur`,
                        () => call('suppliers.removeArticle', a.id).then(list.reload, toast.error),
                        () => setHidden((h) => (h.delete(a.id), new Set(h))),
                      );
                    }}
                  >
                    ✕
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {edit && (
        <Modal title={edit.name} onClose={() => setEdit(null)}>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const cost = parseAmount(edit.cost);
              const pack = parseQty(edit.pack);
              if (cost === null || !pack) return toast.error('Prix ou colisage invalide');
              const promoBuy = edit.buy.trim() ? Number(edit.buy) : null;
              const promoPay = edit.pay.trim() ? Number(edit.pay) : null;
              try {
                await call('suppliers.setArticle', { supplierId, articleId: edit.articleId, supplierRef: edit.ref, unitCost: cost, packQty: pack, isMain: edit.main || undefined, promoBuy, promoPay });
                setEdit(null);
                list.reload();
              } catch (err) {
                toast.error(err);
              }
            }}
          >
            <Field label="Référence chez le fournisseur">
              <input value={edit.ref} onChange={(e) => setEdit({ ...edit, ref: e.target.value })} autoFocus />
            </Field>
            <div className="grid2">
              <Field label={tx('Prix négocié HT (FCFA)')} hint={edit.unit === 'piece' ? 'par pièce' : `par ${edit.unit === 'kg' ? 'kg' : 'litre'}`}>
                <input inputMode="numeric" value={edit.cost} onChange={(e) => setEdit({ ...edit, cost: e.target.value })} />
              </Field>
              <Field label="Colisage" hint="On commande par multiples de cette quantité (ex. 24 pour un casier)">
                <input inputMode="decimal" value={edit.pack} onChange={(e) => setEdit({ ...edit, pack: e.target.value })} />
              </Field>
            </div>
            <div className="grid2">
              <Field label="Bonus : quantité achetée" hint="Ex. 12 dans « 12 achetés, 10 payés » ; vide = pas de bonus">
                <input inputMode="numeric" value={edit.buy} onChange={(e) => setEdit({ ...edit, buy: e.target.value })} />
              </Field>
              <Field label="Bonus : quantité payée" hint="Les unités gratuites entrent en stock à la réception, sans être payées">
                <input inputMode="numeric" value={edit.pay} onChange={(e) => setEdit({ ...edit, pay: e.target.value })} />
              </Field>
            </div>
            <label>
              <input type="checkbox" checked={edit.main} onChange={(e) => setEdit({ ...edit, main: e.target.checked })} /> Fournisseur principal de cet article
            </label>
            <div className="actions">
              <button className="primary" type="submit">
                Enregistrer
              </button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}

function SupplierAccount({ supplierId, name }: { supplierId: string; name: string }) {
  const can = useCan();
  const invoices = useLoad(() => call('purchases.invoices', { supplierId }).catch(() => null), [supplierId]);
  const orders = useLoad(() => call('purchases.orders', { supplierId }), [supplierId]);
  const [adjusting, setAdjusting] = useState(false);
  const balance = (invoices.data ?? []).reduce((t, i) => t + (i.kind === 'invoice' ? i.balance : -i.balance), 0);
  return (
    <div className="grid2 top">
      {adjusting && (
        <BalanceDialog
          party="supplier"
          id={supplierId}
          name={name}
          balance={balance}
          onClose={() => setAdjusting(false)}
          onDone={() => {
            setAdjusting(false);
            invoices.reload();
          }}
        />
      )}
      <section>
        <h3>Factures et avoirs</h3>
        {invoices.data === null ? (
          <p className="muted">Réservé au gérant et au comptable.</p>
        ) : (
          <table className="list compact">
            <tbody>
              {(invoices.data ?? []).map((i) => (
                <tr key={i.id}>
                  <td className="nowrap">{i.kind === 'invoice' ? 'Facture' : 'Avoir'} {i.supplier_number}</td>
                  <td>{dateFr(i.invoice_date)}</td>
                  <td className="r">{fcfa(i.total_ttc)}</td>
                  <td className={`r ${i.overdue ? 'neg' : ''}`}>{i.state === 'paid' ? 'Réglée' : `reste ${fcfa(i.balance)}`}</td>
                </tr>
              ))}
              <tr className="b">
                <td colSpan={3}>Solde dû</td>
                <td className="r">{fcfa(balance)}</td>
              </tr>
            </tbody>
          </table>
        )}
        {can('balance_adjust') && invoices.data !== null && (
          <div className="actions">
            <button onClick={() => setAdjusting(true)} title="Solde d’ouverture oublié à la création, ou correction du solde avec son motif">
              Ajuster le solde…
            </button>
          </div>
        )}
      </section>
      <section>
        <h3>Dernières commandes</h3>
        <table className="list compact">
          <tbody>
            {(orders.data ?? []).slice(0, 15).map((o) => (
              <tr key={o.id}>
                <td>{o.number}</td>
                <td>{dateFr(o.order_date)}</td>
                <td className="r">{fcfa(o.total_ht)}{tx(' HT')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}

/** Unités gratuites reçues des fournisseurs (bonus « 12 achetés, 10 payés ») et ce qu'elles valent au prix d'achat. */
function FreeGoods() {
  const [from, setFrom] = useState(`${today().slice(0, 8)}01`);
  const [to, setTo] = useState(today());
  const data = useLoad(() => call('purchases.freeGoods', from, to), [from, to]);
  return (
    <>
      <div className="filters">
        <Field label="Du">
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        <Field label="Au">
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </Field>
      </div>
      {data.data?.rows.length === 0 ? (
        <Empty>Aucune unité gratuite reçue sur la période.</Empty>
      ) : (
        <table className="list">
          <thead>
            <tr>
              <th>Fournisseur</th>
              <th>Article</th>
              <th className="r">Unités gratuites</th>
              <th className="r">Réceptions</th>
              <th className="r">{tx('Valeur (prix d’achat HT)')}</th>
            </tr>
          </thead>
          <tbody>
            {(data.data?.rows ?? []).map((r) => (
              <tr key={`${r.supplier_id}:${r.article_id}`}>
                <td>{r.supplier_name}</td>
                <td>{r.article_name}</td>
                <td className="r">{qty(r.free_qty, r.unit as 'piece')}</td>
                <td className="r">{r.receptions}</td>
                <td className="r">{fcfa(r.value)}</td>
              </tr>
            ))}
            <tr className="b">
              <td colSpan={4}>Total des bonus reçus</td>
              <td className="r">{fcfa(data.data?.total ?? 0)}</td>
            </tr>
          </tbody>
        </table>
      )}
    </>
  );
}
