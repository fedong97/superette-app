import { useState } from 'react';
import { type Result, call } from '../api';
import { Empty, Field, Modal, Tabs, dateFr, dateTime, fcfa, today, useLoad, useToast } from '../ui';
import { type Customer, CUSTOMER_PAY_METHODS, CustomerFields, CustomerPaymentDialog, canSetCredit, draftOf, inputOf } from './customerDialogs';

type User = NonNullable<Result<'app.state'>['user']>;
export type CustomersTab = 'list' | 'receivables' | 'payments';

/** Clients : fiches, comptes à crédit, balance âgée et règlements reçus. */
export function Customers({ user, initialTab = 'list' }: { user: User; initialTab?: CustomersTab }) {
  const accounting = ['admin', 'manager', 'accountant'].includes(user.role);
  const [tab, setTab] = useState<CustomersTab>(initialTab);
  const tabs: [CustomersTab, string][] = [
    ['list', 'Fiches clients'],
    ...(accounting ? ([['receivables', 'Créances (balance âgée)']] as [CustomersTab, string][]) : []),
    ['payments', 'Règlements reçus'],
  ];
  return (
    <div className="page">
      <header className="page-head">
        <h1>Clients</h1>
      </header>
      <Tabs value={tab} onChange={setTab} tabs={tabs} />
      {tab === 'list' && <CustomerList user={user} />}
      {tab === 'receivables' && accounting && <Receivables user={user} />}
      {tab === 'payments' && <Payments />}
    </div>
  );
}

function CustomerList({ user }: { user: User }) {
  const [search, setSearch] = useState('');
  const [inactive, setInactive] = useState(false);
  const [debtors, setDebtors] = useState(false);
  const list = useLoad(() => call('customers.list', { search: search || undefined, includeInactive: inactive, withBalance: debtors }), [search, inactive, debtors]);
  const [open, setOpen] = useState<Customer | 'new' | null>(null);
  return (
    <>
      <div className="filters">
        <input className="search" placeholder="Nom, code ou téléphone" value={search} onChange={(e) => setSearch(e.target.value)} />
        <label>
          <input type="checkbox" checked={debtors} onChange={(e) => setDebtors(e.target.checked)} /> Qui doivent seulement
        </label>
        <label>
          <input type="checkbox" checked={inactive} onChange={(e) => setInactive(e.target.checked)} /> Inactifs
        </label>
        <button className="primary" style={{ marginLeft: 'auto' }} onClick={() => setOpen('new')}>
          Nouveau client
        </button>
      </div>
      {list.data?.length === 0 ? (
        <Empty>Aucun client. Créez les clients qui achètent à crédit (restaurants, boutiques, employés…) avec leur plafond.</Empty>
      ) : (
        <table className="list">
          <thead>
            <tr>
              <th>Code</th>
              <th>Client</th>
              <th>Téléphone</th>
              <th className="r">Délai</th>
              <th className="r">Plafond</th>
              <th className="r">Doit</th>
              <th className="r">En retard</th>
              <th>Dernier achat</th>
            </tr>
          </thead>
          <tbody>
            {(list.data ?? []).map((c) => (
              <tr key={c.id} className={`clickable ${c.active ? '' : 'inactive'}`} onClick={() => setOpen(c)}>
                <td>{c.code}</td>
                <td>{c.name}</td>
                <td>{c.phone}</td>
                <td className="r">{c.payment_terms_days} j</td>
                <td className="r">{c.credit_limit ? fcfa(c.credit_limit) : '—'}</td>
                <td className={`r ${c.balance > c.credit_limit ? 'neg' : ''}`}>{c.balance ? fcfa(c.balance) : ''}</td>
                <td className="r neg">{c.overdue ? fcfa(c.overdue) : ''}</td>
                <td>{c.last_sale ? dateTime(c.last_sale) : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {open && (
        <CustomerDialog
          user={user}
          customer={open === 'new' ? null : open}
          onClose={() => {
            setOpen(null);
            list.reload();
          }}
          onSaved={(c) => {
            list.reload();
            setOpen(c);
          }}
        />
      )}
    </>
  );
}

function CustomerDialog({ user, customer, onClose, onSaved }: { user: User; customer: Customer | null; onClose: () => void; onSaved: (c: Customer) => void }) {
  const [tab, setTab] = useState<'card' | 'account' | 'statement' | 'sales'>(customer ? 'account' : 'card');
  return (
    <Modal title={customer ? `${customer.code} · ${customer.name}` : 'Nouveau client'} onClose={onClose} wide>
      {customer && (
        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            ['account', 'Compte'],
            ['statement', 'Relevé'],
            ['sales', 'Achats'],
            ['card', 'Fiche'],
          ]}
        />
      )}
      {tab === 'card' && <CustomerCard user={user} customer={customer} onSaved={onSaved} />}
      {tab === 'account' && customer && <Account customer={customer} />}
      {tab === 'statement' && customer && <Statement customer={customer} />}
      {tab === 'sales' && customer && <CustomerSales customer={customer} />}
    </Modal>
  );
}

function CustomerCard({ user, customer, onSaved }: { user: User; customer: Customer | null; onSaved: (c: Customer) => void }) {
  const toast = useToast();
  const [draft, setDraft] = useState(() => draftOf(customer));
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        try {
          const saved = await call('customers.save', inputOf(draft), customer?.id);
          toast.ok(customer ? 'Fiche client enregistrée' : `Client ${saved.code} créé`);
          onSaved(saved);
        } catch (err) {
          toast.error(err);
        }
      }}
    >
      <CustomerFields value={draft} onChange={setDraft} canSetCredit={canSetCredit(user)} />
      {customer && (
        <label>
          <input type="checkbox" checked={draft.active} onChange={(e) => setDraft({ ...draft, active: e.target.checked })} /> Client actif
        </label>
      )}
      <div className="actions">
        <button type="submit" className="primary">
          Enregistrer
        </button>
      </div>
    </form>
  );
}

function Account({ customer }: { customer: Customer }) {
  const toast = useToast();
  const acc = useLoad(() => call('customers.account', customer.id), [customer.id]);
  const [paying, setPaying] = useState(false);
  if (!acc.data) return null;
  const a = acc.data;
  return (
    <>
      <div className="kpis">
        <div>
          <small>Doit</small>
          <strong>{fcfa(a.balance)}</strong>
        </div>
        <div className={a.overdue ? 'neg' : ''}>
          <small>Dont en retard</small>
          <strong>{fcfa(a.overdue)}</strong>
        </div>
        <div>
          <small>Plafond</small>
          <strong>{fcfa(a.customer.credit_limit)}</strong>
        </div>
        <div>
          <small>Encore disponible</small>
          <strong>{fcfa(a.available)}</strong>
        </div>
      </div>
      <h3>Ventes à crédit restant dues</h3>
      {a.openItems.length === 0 ? (
        <p className="muted">Rien à régler.</p>
      ) : (
        <table className="list compact">
          <thead>
            <tr>
              <th>Ticket</th>
              <th>Date</th>
              <th>Échéance</th>
              <th className="r">Montant à crédit</th>
              <th className="r">Reste dû</th>
              <th>Retard</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {a.openItems.map((i) => (
              <tr key={i.id}>
                <td className="nowrap">{i.number}</td>
                <td className="nowrap">{dateTime(i.created_at)}</td>
                <td className={i.days_late ? 'neg' : ''}>{dateFr(i.due_date)}</td>
                <td className="r">{fcfa(i.amount)}</td>
                <td className="r">{fcfa(i.remaining)}</td>
                <td className="neg">{i.days_late ? `${i.days_late} j` : ''}</td>
                <td>
                  <button className="ghost" onClick={() => call('pos.printInvoice', i.id).catch(toast.error)}>
                    Facture A4
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="actions">
        <button onClick={() => call('customers.printStatement', customer.id).catch(toast.error)}>Imprimer le relevé</button>
        <button className="primary" disabled={!a.balance} onClick={() => setPaying(true)}>
          Encaisser un règlement
        </button>
      </div>
      {paying && (
        <CustomerPaymentDialog
          customer={customer}
          atRegister={false}
          onClose={() => setPaying(false)}
          onPaid={() => {
            setPaying(false);
            acc.reload();
          }}
        />
      )}
    </>
  );
}

function Statement({ customer }: { customer: Customer }) {
  const toast = useToast();
  const [from, setFrom] = useState(() => `${today().slice(0, 8)}01`);
  const [to, setTo] = useState(today);
  const st = useLoad(() => call('customers.statement', customer.id, from || null, to || null), [customer.id, from, to]);
  return (
    <>
      <div className="filters">
        <Field label="Du">
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        <Field label="Au">
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </Field>
        <button style={{ marginLeft: 'auto' }} onClick={() => call('customers.printStatement', customer.id, from || null, to || null).catch(toast.error)}>
          Imprimer (A4)
        </button>
      </div>
      {st.data && (
        <table className="list compact">
          <thead>
            <tr>
              <th>Date</th>
              <th>Pièce</th>
              <th>Libellé</th>
              <th className="r">Débit</th>
              <th className="r">Crédit</th>
              <th className="r">Solde</th>
            </tr>
          </thead>
          <tbody>
            {from && (
              <tr className="b">
                <td colSpan={5}>Solde au {dateFr(from)}</td>
                <td className="r">{fcfa(st.data.opening)}</td>
              </tr>
            )}
            {st.data.lines.map((l) => (
              <tr key={l.ref_id}>
                <td className="nowrap">{dateTime(l.date)}</td>
                <td className="nowrap">{l.number}</td>
                <td>{l.label}</td>
                <td className="r">{l.debit ? fcfa(l.debit) : ''}</td>
                <td className="r">{l.credit ? fcfa(l.credit) : ''}</td>
                <td className="r">{fcfa(l.balance)}</td>
              </tr>
            ))}
            <tr className="b">
              <td colSpan={5}>Solde dû</td>
              <td className="r">{fcfa(st.data.closing)}</td>
            </tr>
          </tbody>
        </table>
      )}
    </>
  );
}

function CustomerSales({ customer }: { customer: Customer }) {
  const toast = useToast();
  const sales = useLoad(() => call('customers.sales', customer.id), [customer.id]);
  if (sales.data?.length === 0) return <p className="muted">Aucun achat enregistré à son nom dans ce magasin.</p>;
  return (
    <table className="list compact">
      <thead>
        <tr>
          <th>Ticket</th>
          <th>Date</th>
          <th className="r">Total TTC</th>
          <th>Échéance</th>
          <th>État</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        {(sales.data ?? []).map((s) => (
          <tr key={s.id} className={s.status === 'cancelled' ? 'inactive' : ''}>
            <td>{s.number}</td>
            <td>{dateTime(s.created_at)}</td>
            <td className="r">{fcfa(s.total_ttc)}</td>
            <td>{s.due_date ? dateFr(s.due_date) : 'comptant'}</td>
            <td>{s.status === 'cancelled' ? 'Annulé' : s.kind === 'return' ? 'Retour' : ''}</td>
            <td>
              <button className="ghost" onClick={() => call('pos.printInvoice', s.id).catch(toast.error)}>
                {s.kind === 'return' ? 'Avoir A4' : 'Facture A4'}
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Receivables({ user }: { user: User }) {
  const data = useLoad(() => call('customers.receivables'), []);
  const [open, setOpen] = useState<Customer | null>(null);
  if (!data.data) return null;
  const { customers, totals, labels } = data.data;
  const buckets = Object.keys(labels) as (keyof typeof labels)[];
  const late = totals.balance - totals.current;
  return (
    <>
      <div className="kpis">
        <div>
          <small>Total dû par les clients</small>
          <strong>{fcfa(totals.balance)}</strong>
        </div>
        <div className={late ? 'neg' : ''}>
          <small>En retard</small>
          <strong>{fcfa(late)}</strong>
        </div>
        <div className={totals.d90 + totals.older ? 'neg' : ''}>
          <small>Plus de 60 jours de retard</small>
          <strong>{fcfa(totals.d90 + totals.older)}</strong>
        </div>
        <div>
          <small>Clients débiteurs</small>
          <strong>{customers.length}</strong>
        </div>
      </div>
      {customers.length === 0 ? (
        <Empty>Aucun client ne doit d'argent au magasin.</Empty>
      ) : (
        <table className="list aging">
          <thead>
            <tr>
              <th>Client</th>
              <th>Téléphone</th>
              <th className="r">Doit</th>
              {buckets.map((b) => (
                <th key={b} className="r">
                  {labels[b]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {customers.map((c) => (
              <tr key={c.id} className="clickable" onClick={() => void call('customers.get', c.id).then(setOpen)}>
                <td>{c.name}</td>
                <td>{c.phone}</td>
                <td className="r b">{fcfa(c.balance)}</td>
                {buckets.map((b) => (
                  <td key={b} className={`r ${b !== 'current' && c.buckets[b] ? 'neg' : ''}`}>
                    {c.buckets[b] ? fcfa(c.buckets[b]) : ''}
                  </td>
                ))}
              </tr>
            ))}
            <tr className="b">
              <td colSpan={2}>Total</td>
              <td className="r">{fcfa(totals.balance)}</td>
              {buckets.map((b) => (
                <td key={b} className="r">
                  {totals[b] ? fcfa(totals[b]) : ''}
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      )}
      {open && (
        <CustomerDialog
          user={user}
          customer={open}
          onClose={() => {
            setOpen(null);
            data.reload();
          }}
          onSaved={setOpen}
        />
      )}
    </>
  );
}

function Payments() {
  const toast = useToast();
  const list = useLoad(() => call('customers.payments', { limit: 200 }), []);
  if (list.data?.length === 0) return <Empty>Aucun règlement client enregistré.</Empty>;
  return (
    <table className="list">
      <thead>
        <tr>
          <th>N°</th>
          <th>Date</th>
          <th>Client</th>
          <th>Mode</th>
          <th>Référence</th>
          <th>Reçu par</th>
          <th className="r">Montant</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        {(list.data ?? []).map((p) => (
          <tr key={p.id}>
            <td>{p.number}</td>
            <td>{dateTime(p.paid_at)}</td>
            <td>{p.customer_name}</td>
            <td>
              {CUSTOMER_PAY_METHODS[p.method]}
              {p.session_id ? ' (caisse)' : ''}
            </td>
            <td>{p.reference}</td>
            <td>{p.user_name}</td>
            <td className="r">{fcfa(p.amount)}</td>
            <td>
              <button className="ghost" onClick={() => call('customers.printReceipt', p.id).catch(toast.error)}>
                Reçu
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
