import { useState } from 'react';
import { type Result, call } from '../api';
import { Empty, Field, Modal, Tabs, dateFr, fcfa, parseAmount, parseQty, qty, useLoad, useToast, has } from '../ui';
import { RecentAccounts, SupplierSituation, SupplierStatement } from './Controls';
import { ArticlePicker } from './pickers';

type Supplier = Result<'suppliers.get'>;
type User = NonNullable<Result<'app.state'>['user']>;

export type SuppliersTab = 'list' | 'statement' | 'situation' | 'recent';

/** Fournisseurs : fiches, extrait de compte, situation et comptes qui ont bougé. */
export function Suppliers({ user, initialTab = 'list' }: { user: User; initialTab?: SuppliersTab }) {
  const [tab, setTab] = useState<SuppliersTab>(initialTab);
  const accounting = ['admin', 'manager', 'accountant'].includes(user.role);
  return (
    <div className="page">
      <header className="page-head">
        <h1>Fournisseurs</h1>
      </header>
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          ['list', 'Liste des fournisseurs'],
          ['statement', 'Extrait de compte'],
          ...(accounting ? ([['situation', 'Situation des fournisseurs']] as [SuppliersTab, string][]) : []),
          ['recent', 'Soldes qui ont bougé'],
        ]}
      />
      {tab === 'list' && <SupplierList user={user} />}
      {tab === 'statement' && <SupplierStatement />}
      {tab === 'situation' && <SupplierSituation />}
      {tab === 'recent' && <RecentAccounts party="supplier" />}
    </div>
  );
}

/** Fiches fournisseurs : identité, conditions, articles référencés et compte. */
function SupplierList({ user }: { user: User }) {
  const [search, setSearch] = useState('');
  const [inactive, setInactive] = useState(false);
  const list = useLoad(() => call('suppliers.list', { search: search || undefined, includeInactive: inactive }), [search, inactive]);
  const [open, setOpen] = useState<Supplier | 'new' | null>(null);
  const canEdit = has(user, 'purchase_orders');
  return (
    <>
      <div className="filters">
        <input className="search" placeholder="Rechercher un fournisseur" value={search} onChange={(e) => setSearch(e.target.value)} />
        <label>
          <input type="checkbox" checked={inactive} onChange={(e) => setInactive(e.target.checked)} /> Inactifs
        </label>
        {canEdit && (
          <button className="primary" style={{ marginLeft: 'auto' }} onClick={() => setOpen('new')}>
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

function SupplierDialog({ supplier, canEdit, onClose, onSaved }: { supplier: Supplier | null; canEdit: boolean; onClose: () => void; onSaved: (s: Supplier) => void }) {
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
      {tab === 'articles' && supplier && <SupplierArticles supplierId={supplier.id} canEdit={canEdit} />}
      {tab === 'account' && supplier && <SupplierAccount supplierId={supplier.id} />}
    </Modal>
  );
}

function SupplierForm({ supplier, canEdit, onSaved }: { supplier: Supplier | null; canEdit: boolean; onSaved: (s: Supplier) => void }) {
  const toast = useToast();
  const [f, setF] = useState({
    name: supplier?.name ?? '',
    contact: supplier?.contact ?? '',
    phone: supplier?.phone ?? '',
    email: supplier?.email ?? '',
    address: supplier?.address ?? '',
    taxpayerNumber: supplier?.taxpayer_number ?? '',
    paymentTermsDays: String(supplier?.payment_terms_days ?? 0),
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
          toast.ok('Fournisseur enregistré');
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
  const [edit, setEdit] = useState<{ articleId: string; name: string; unit: 'piece' | 'kg' | 'litre'; ref: string; cost: string; pack: string; main: boolean } | null>(null);
  return (
    <>
      {canEdit && (
        <ArticlePicker
          placeholder="Ajouter un article : scanner ou rechercher"
          onPick={(a) => setEdit({ articleId: a.id, name: a.name, unit: a.unit, ref: '', cost: String(a.purchase_price || ''), pack: '1', main: false })}
        />
      )}
      <table className="list">
        <thead>
          <tr>
            <th>Réf. fournisseur</th>
            <th>Article</th>
            <th className="r">Prix négocié HT</th>
            <th className="r">Dernier prix payé</th>
            <th className="r">Colisage</th>
            <th>Principal</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {(list.data ?? []).map((a) => (
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
              <td>{a.is_main ? 'Oui' : ''}</td>
              <td>
                {canEdit && (
                  <button
                    className="ghost"
                    onClick={async (e) => {
                      e.stopPropagation();
                      if (!confirm(`Ne plus référencer « ${a.article_name} » chez ce fournisseur ?`)) return;
                      await call('suppliers.removeArticle', a.id).catch(toast.error);
                      list.reload();
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
              try {
                await call('suppliers.setArticle', { supplierId, articleId: edit.articleId, supplierRef: edit.ref, unitCost: cost, packQty: pack, isMain: edit.main || undefined });
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
              <Field label="Prix négocié HT (FCFA)" hint={edit.unit === 'piece' ? 'par pièce' : `par ${edit.unit === 'kg' ? 'kg' : 'litre'}`}>
                <input inputMode="numeric" value={edit.cost} onChange={(e) => setEdit({ ...edit, cost: e.target.value })} />
              </Field>
              <Field label="Colisage" hint="On commande par multiples de cette quantité (ex. 24 pour un casier)">
                <input inputMode="decimal" value={edit.pack} onChange={(e) => setEdit({ ...edit, pack: e.target.value })} />
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

function SupplierAccount({ supplierId }: { supplierId: string }) {
  const invoices = useLoad(() => call('purchases.invoices', { supplierId }).catch(() => null), [supplierId]);
  const orders = useLoad(() => call('purchases.orders', { supplierId }), [supplierId]);
  const balance = (invoices.data ?? []).reduce((t, i) => t + (i.kind === 'invoice' ? i.balance : -i.balance), 0);
  return (
    <div className="grid2 top">
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
      </section>
      <section>
        <h3>Dernières commandes</h3>
        <table className="list compact">
          <tbody>
            {(orders.data ?? []).slice(0, 15).map((o) => (
              <tr key={o.id}>
                <td>{o.number}</td>
                <td>{dateFr(o.order_date)}</td>
                <td className="r">{fcfa(o.total_ht)} HT</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
