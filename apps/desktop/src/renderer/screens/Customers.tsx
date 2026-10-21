import { useState } from 'react';
import { type Result, call } from '../api';
import { Empty, Field, Modal, Tabs, dateFr, has, dateTime, fcfa, today, useCan, useLoad, useStoreSettings, useToast } from '../ui';
import { CreditControl, RecentAccounts } from './Controls';
import { Rebates, type RebatesTab } from './Rebates';
import { type Customer, CUSTOMER_PAY_METHODS, CustomerFields, CustomerPaymentDialog, canLinkSupplier, canSetCredit, canSetLevel, draftOf, inputOf } from './customerDialogs';
import { OffsetDialog, Offsets } from './Offsets';
import { Consignment } from './Consignment';
import { tx } from '../tax';
import { InvoicePreview } from './docPreview';
import { SummaryInvoices } from './SummaryInvoices';

type User = NonNullable<Result<'app.state'>['user']>;
export type CustomersTab = 'list' | 'statement' | 'receivables' | 'limits' | 'recent' | 'payments' | 'rebates' | 'summary' | 'offsets' | 'consignment' | `rebates-${RebatesTab}`;

/** Clients : fiches, comptes à crédit, balance âgée et règlements reçus. */
export function Customers({ user, initialTab = 'list' }: { user: User; initialTab?: CustomersTab }) {
  const accounting = has(user, 'receivables');
  const [tab, setTab] = useState<CustomersTab>(initialTab.startsWith('rebates') ? 'rebates' : initialTab);
  const rebateTab = (initialTab.startsWith('rebates-') ? initialTab.slice(8) : 'state') as RebatesTab;
  const tabs: [CustomersTab, string][] = [
    ['list', 'Liste'],
    ...(has(user, 'customer_statement') || accounting ? ([['statement', 'Extrait de compte']] as [CustomersTab, string][]) : []),
    ...(accounting
      ? ([
          ['receivables', 'Situation (balance âgée)'],
          ['limits', "Plafonds d'autorisation"],
        ] as [CustomersTab, string][])
      : []),
    ['recent', 'Soldes qui ont bougé'],
    ['payments', 'Règlements reçus'],
    ...(has(user, 'summary_invoices') ? ([['summary', 'Factures récapitulatives']] as [CustomersTab, string][]) : []),
    ...(has(user, 'rebates') ? ([['rebates', 'Ristournes']] as [CustomersTab, string][]) : []),
    ...(has(user, 'account_offsets') ? ([['offsets', 'Compensations']] as [CustomersTab, string][]) : []),
    ...(has(user, 'consignment') ? ([['consignment', 'Dépôt-vente']] as [CustomersTab, string][]) : []),
  ];
  return (
    <div className="page">
      <header className="page-head">
        <h1>Clients</h1>
      </header>
      <Tabs value={tab} onChange={setTab} tabs={tabs} />
      {tab === 'list' && <CustomerList user={user} />}
      {tab === 'statement' && <StatementPicker />}
      {tab === 'receivables' && accounting && <Receivables user={user} />}
      {tab === 'limits' && accounting && <CreditControl />}
      {tab === 'recent' && <RecentAccounts party="customer" />}
      {tab === 'payments' && <Payments />}
      {tab === 'summary' && has(user, 'summary_invoices') && <SummaryInvoices />}
      {tab === 'rebates' && has(user, 'rebates') && <Rebates user={user} initialTab={rebateTab} />}
      {tab === 'offsets' && has(user, 'account_offsets') && <Offsets />}
      {tab === 'consignment' && has(user, 'consignment') && <Consignment />}
    </div>
  );
}

function CustomerList({ user }: { user: User }) {
  const [search, setSearch] = useState('');
  const [inactive, setInactive] = useState(false);
  const [debtors, setDebtors] = useState(false);
  const [zone, setZone] = useState('');
  const zones = useLoad(() => call('customers.zones'), []);
  const list = useLoad(() => call('customers.list', { search: search || undefined, includeInactive: inactive, withBalance: debtors, zone: zone || null }), [search, inactive, debtors, zone]);
  const [open, setOpen] = useState<Customer | 'new' | null>(null);
  const loyaltyOn = useStoreSettings().loyaltyEnabled;
  const points = useLoad(() => (loyaltyOn ? call('loyalty.balances') : Promise.resolve({} as Record<string, number>)), [loyaltyOn, list.data]);
  return (
    <>
      <div className="filters">
        <input className="search" placeholder="Nom, code ou téléphone" value={search} onChange={(e) => setSearch(e.target.value)} />
        {(zones.data ?? []).length > 0 && (
          <select value={zone} onChange={(e) => setZone(e.target.value)} title="Zone ou tournée">
            <option value="">Toutes les zones</option>
            {zones.data!.map((z) => (
              <option key={z.zone} value={z.zone}>
                {z.zone} ({z.count})
              </option>
            ))}
          </select>
        )}
        <label>
          <input type="checkbox" checked={debtors} onChange={(e) => setDebtors(e.target.checked)} /> Qui doivent seulement
        </label>
        <label>
          <input type="checkbox" checked={inactive} onChange={(e) => setInactive(e.target.checked)} /> Inactifs
        </label>
        {has(user, 'customer_create') && (
          <button data-new title="Ctrl+J" className="primary" style={{ marginLeft: 'auto' }} onClick={() => setOpen('new')}>
            Nouveau client
          </button>
        )}
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
              <th>Zone</th>
              <th className="r">Délai</th>
              <th className="r">Plafond</th>
              <th className="r">Doit</th>
              <th className="r">En retard</th>
              {loyaltyOn && <th className="r">Points</th>}
              <th>Dernier achat</th>
            </tr>
          </thead>
          <tbody>
            {(list.data ?? []).map((c) => (
              <tr key={c.id} className={`clickable ${c.active ? '' : 'inactive'}`} onClick={() => setOpen(c)}>
                <td>{c.code}</td>
                <td>
                  {c.name}
                  {c.no_cheque === 1 && <span className="tag rupture" style={{ marginLeft: 6 }}>Interdit de chèque</span>}
                </td>
                <td>{c.phone}</td>
                <td>{c.zone ?? ''}</td>
                <td className="r">{c.payment_terms_days} j</td>
                <td className="r">{c.credit_limit ? fcfa(c.credit_limit) : '—'}</td>
                <td className={`r ${c.balance > c.credit_limit ? 'neg' : ''}`}>{c.balance ? fcfa(c.balance) : ''}</td>
                <td className="r neg">{c.overdue ? fcfa(c.overdue) : ''}</td>
                {loyaltyOn && <td className="r">{points.data?.[c.id] || ''}</td>}
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
  const [tab, setTab] = useState<'card' | 'account' | 'statement' | 'sales' | 'points'>(customer ? 'account' : 'card');
  const statement = has(user, 'customer_statement') || has(user, 'receivables');
  const loyaltyOn = useStoreSettings().loyaltyEnabled;
  return (
    <Modal title={customer ? `${customer.code} · ${customer.name}` : 'Nouveau client'} onClose={onClose} wide>
      {customer && (
        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            ['account', 'Compte'],
            ...(statement ? ([['statement', 'Relevé']] as ['statement', string][]) : []),
            ['sales', 'Achats'],
            ...(loyaltyOn ? ([['points', 'Fidélité']] as ['points', string][]) : []),
            ['card', 'Fiche'],
          ]}
        />
      )}
      {tab === 'card' && <CustomerCard user={user} customer={customer} onSaved={onSaved} />}
      {tab === 'account' && customer && <Account customer={customer} />}
      {tab === 'statement' && customer && statement && <Statement customer={customer} />}
      {tab === 'sales' && customer && <CustomerSales customer={customer} />}
      {tab === 'points' && customer && <LoyaltyCard user={user} customer={customer} />}
    </Modal>
  );
}

const LOYALTY_KINDS: Record<string, string> = { earn: 'Gagnés', redeem: 'Dépensés', cancel: 'Vente annulée', return: 'Retour', adjust: 'Correction' };

/** Carte de fidélité du client : solde, mouvements, correction et impression de la carte. */
function LoyaltyCard({ user, customer }: { user: User; customer: Customer }) {
  const toast = useToast();
  const status = useLoad(() => call('loyalty.status', customer.id), [customer.id]);
  const history = useLoad(() => call('loyalty.history', customer.id), [customer.id]);
  const [points, setPoints] = useState('');
  const [reason, setReason] = useState('');
  const st = status.data;
  if (!st) return null;
  return (
    <div>
      <div className="kpis">
        <div>
          <span>Points</span>
          <strong>{st.balance}</strong>
        </div>
        <div>
          <span>Valeur en remise</span>
          <strong>{fcfa(st.value)}</strong>
        </div>
      </div>
      <p className="muted">
        1 point pour {fcfa(st.rules.spendPerPoint)} d'achat ; 1 point vaut {fcfa(st.rules.pointValue)} ; il faut {st.rules.minRedeem} points pour payer avec. À la caisse, scannez la
        carte ou tapez le téléphone du client pour le choisir.
      </p>
      <div className="actions">
        <button onClick={() => call('loyalty.printCard', customer.id).catch((e) => toast.error(e))}>Imprimer sa carte</button>
      </div>
      {has(user, 'loyalty_adjust') && (
        <form
          className="filters"
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              const n = await call('loyalty.adjust', customer.id, Math.trunc(Number(points)), reason);
              toast.ok(`Nouveau solde : ${n} points`);
              setPoints('');
              setReason('');
              status.reload();
              history.reload();
            } catch (err) {
              toast.error(err);
            }
          }}
        >
          <Field label="Corriger (+ ou −)">
            <input inputMode="numeric" value={points} onChange={(e) => setPoints(e.target.value)} placeholder="ex. 50 ou -20" style={{ width: 110 }} />
          </Field>
          <Field label="Motif">
            <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Carte perdue, geste commercial…" />
          </Field>
          <button type="submit" disabled={!points || !reason.trim()}>
            Enregistrer la correction
          </button>
        </form>
      )}
      {(history.data ?? []).length === 0 ? (
        <Empty>Aucun point pour l'instant : le client en gagne à chaque achat.</Empty>
      ) : (
        <table className="list">
          <thead>
            <tr>
              <th>Date</th>
              <th>Mouvement</th>
              <th>Pièce</th>
              <th>Magasin</th>
              <th>Par</th>
              <th className="r">Points</th>
            </tr>
          </thead>
          <tbody>
            {history.data!.map((m) => (
              <tr key={m.id}>
                <td>{dateTime(m.created_at)}</td>
                <td>
                  {LOYALTY_KINDS[m.kind]}
                  {m.reason && <small className="muted"> · {m.reason}</small>}
                </td>
                <td>{m.sale_number ?? ''}</td>
                <td>{m.store_name ?? ''}</td>
                <td>{m.user_name ?? ''}</td>
                <td className={`r ${m.points < 0 ? 'neg' : 'pos'}`}>
                  {m.points > 0 ? '+' : ''}
                  {m.points}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function CustomerCard({ user, customer, onSaved }: { user: User; customer: Customer | null; onSaved: (c: Customer) => void }) {
  const toast = useToast();
  const settings = useStoreSettings();
  const [draft, setDraft] = useState(() => draftOf(customer, settings));
  // Un client existant : la fiche se corrige avec « Modifier un client » ; plafond, tarif et activité ont leurs propres droits.
  const canSave = customer
    ? has(user, 'customer_edit') || has(user, 'receivables') || has(user, 'customer_price_level') || has(user, 'customer_deactivate')
    : has(user, 'customer_create');
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
      <CustomerFields value={draft} onChange={setDraft} canSetCredit={canSetCredit(user)} canSetLevel={canSetLevel(user)} canLinkSupplier={canLinkSupplier(user)} />
      {customer && (
        <label>
          <input type="checkbox" checked={draft.active} disabled={!has(user, 'customer_deactivate')} onChange={(e) => setDraft({ ...draft, active: e.target.checked })} /> Client actif
        </label>
      )}
      <div className="actions">
        <button type="submit" className="primary" disabled={!canSave}>
          Enregistrer
        </button>
      </div>
    </form>
  );
}

function Account({ customer }: { customer: Customer }) {
  const toast = useToast();
  const can = useCan();
  const acc = useLoad(() => call('customers.account', customer.id), [customer.id]);
  const [paying, setPaying] = useState(false);
  const [offsetting, setOffsetting] = useState(false);
  const [reminding, setReminding] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  if (!acc.data) return null;
  const a = acc.data;
  return (
    <>
      {a.customer.no_cheque === 1 && (
        <p>
          <span className="tag rupture">Interdit de chèque</span> <span className="muted">Ce client ne peut plus payer par chèque (case à décocher dans sa fiche).</span>
        </p>
      )}
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
                  {can('sale_reprint') && (
                    <button className="ghost" onClick={() => setPreview(i.id)}>
                      Facture…
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="actions">
        {can('customer_statement', 'receivables') && <button onClick={() => call('customers.printStatement', customer.id).catch(toast.error)}>Imprimer le relevé</button>}
        {can('customer_statement', 'receivables') && (
          <button disabled={!a.balance} onClick={() => setReminding(true)}>
            Relancer par WhatsApp…
          </button>
        )}
        {can('account_offsets') && customer.supplier_id && (
          <button disabled={a.balance <= 0} title="Solder ce qu’il doit par ce qu’on lui doit comme fournisseur" onClick={() => setOffsetting(true)}>
            Compenser avec son compte fournisseur…
          </button>
        )}
        {can('customer_payment') && (
          <button className="primary" disabled={!a.balance} onClick={() => setPaying(true)}>
            Encaisser un règlement
          </button>
        )}
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
      {offsetting && (
        <OffsetDialog
          customerId={customer.id}
          onClose={() => setOffsetting(false)}
          onDone={() => {
            setOffsetting(false);
            acc.reload();
          }}
        />
      )}
      {preview && <InvoicePreview saleId={preview} onClose={() => setPreview(null)} />}
      {reminding && <ReminderDialog queue={[customer.id]} onClose={() => setReminding(false)} />}
    </>
  );
}

/**
 * Relance par WhatsApp : le message rempli pour le client (modifiable), « Ouvrir WhatsApp »
 * avec le message prêt, relevé en PDF à joindre. Avec plusieurs clients, « Suivant » passe au prochain.
 */
export function ReminderDialog({ queue, onClose, onSent }: { queue: string[]; onClose: () => void; onSent?: () => void }) {
  const toast = useToast();
  const [index, setIndex] = useState(0);
  const id = queue[index]!;
  const data = useLoad(() => call('customers.reminder', id), [id]);
  const [text, setText] = useState<string | null>(null);
  const d = data.data;
  const message = text ?? d?.text ?? '';
  const next = () => {
    setText(null);
    if (index + 1 < queue.length) setIndex(index + 1);
    else onClose();
  };
  const sent = async (channel: 'whatsapp' | 'pdf') => {
    await call('customers.reminderSent', id, channel);
    data.reload();
    onSent?.();
  };
  return (
    <Modal title={`Relancer ${d?.customer.name ?? '…'}${queue.length > 1 ? ` (${index + 1} sur ${queue.length})` : ''}`} onClose={onClose} wide>
      {d && (
        <>
          <div className="kpis">
            <div>
              <small>Doit</small>
              <strong>{fcfa(d.balance)}</strong>
            </div>
            <div className={d.overdue ? 'neg' : ''}>
              <small>Dont en retard</small>
              <strong>{fcfa(d.overdue)}</strong>
            </div>
            <div>
              <small>Téléphone</small>
              <strong>{d.customer.phone || '—'}</strong>
            </div>
            <div>
              <small>Dernière relance</small>
              <strong>{d.last ? dateTime(d.last.at) : 'jamais'}</strong>
            </div>
          </div>
          {d.last && (
            <p className="muted">
              {d.last.count} relance{d.last.count > 1 ? 's' : ''} envoyée{d.last.count > 1 ? 's' : ''} ; la dernière par {d.last.user_name ?? '—'}, quand il devait {fcfa(d.last.balance)}.
            </p>
          )}
          <Field label="Message" hint="Modifiable avant l'envoi. Le modèle se règle dans Administration › Paramètres › Crédit clients.">
            <textarea rows={12} value={message} onChange={(e) => setText(e.target.value)} />
          </Field>
          {!d.link && <p className="neg">Pas de numéro de téléphone valable sur la fiche : complétez-la, ou copiez le message.</p>}
          <div className="actions">
            <button
              onClick={() =>
                navigator.clipboard.writeText(message).then(
                  () => toast.ok('Message copié'),
                  () => toast.error('Copie impossible'),
                )
              }
            >
              Copier le message
            </button>
            <button
              onClick={async () => {
                try {
                  if (await call('customers.reminderPdf', id)) toast.ok('Relevé enregistré : joignez-le dans WhatsApp avec le trombone');
                } catch (err) {
                  toast.error(err);
                }
              }}
            >
              Relevé en PDF…
            </button>
            <button
              className="primary"
              disabled={!d.link}
              onClick={async () => {
                const link = `${d.link!.split('?')[0]}?text=${encodeURIComponent(message)}`;
                window.open(link, '_blank');
                try {
                  await sent('whatsapp');
                  toast.ok('Relance notée');
                } catch (err) {
                  toast.error(err);
                }
              }}
            >
              Ouvrir WhatsApp
            </button>
            {queue.length > 1 && <button onClick={next}>{index + 1 < queue.length ? 'Suivant ›' : 'Terminer'}</button>}
          </div>
        </>
      )}
    </Modal>
  );
}

/** Extrait de compte d'un client choisi dans la liste. */
function StatementPicker() {
  const list = useLoad(() => call('customers.list', {}), []);
  const [id, setId] = useState('');
  const customer = list.data?.find((c) => c.id === id);
  return (
    <>
      <div className="filters">
        <select value={id} onChange={(e) => setId(e.target.value)} autoFocus>
          <option value="">Choisir le client…</option>
          {list.data?.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name} {c.balance ? `(doit ${fcfa(c.balance)})` : ''}
            </option>
          ))}
        </select>
      </div>
      {customer ? <Statement customer={customer} /> : <Empty>Choisissez un client pour voir son compte.</Empty>}
    </>
  );
}

export function Statement({ customer }: { customer: Customer }) {
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
  const can = useCan();
  const sales = useLoad(() => call('customers.sales', customer.id), [customer.id]);
  const [preview, setPreview] = useState<string | null>(null);
  if (sales.data?.length === 0) return <p className="muted">Aucun achat enregistré à son nom dans ce magasin.</p>;
  return (
    <>
      <table className="list compact">
        <thead>
          <tr>
            <th>Ticket</th>
            <th>Date</th>
            <th className="r">{tx('Total TTC')}</th>
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
                {can('sale_reprint') && (
                  <button className="ghost" onClick={() => setPreview(s.id)}>
                    {s.kind === 'return' ? 'Avoir…' : 'Facture…'}
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {preview && <InvoicePreview saleId={preview} onClose={() => setPreview(null)} />}
    </>
  );
}

function Receivables({ user }: { user: User }) {
  const data = useLoad(() => call('customers.receivables'), []);
  const [open, setOpen] = useState<Customer | null>(null);
  const [remind, setRemind] = useState<string[] | null>(null);
  const [zone, setZone] = useState('');
  if (!data.data) return null;
  const { labels } = data.data;
  const buckets = Object.keys(labels) as (keyof typeof labels)[];
  // Une zone choisie : la tournée du recouvreur, avec ses totaux.
  const zones = [...new Set(data.data.customers.map((c) => c.zone).filter((z): z is string => Boolean(z)))].sort();
  const customers = zone ? data.data.customers.filter((c) => c.zone === zone) : data.data.customers;
  const totals = zone
    ? customers.reduce(
        (t, c) => {
          t.balance += c.balance;
          for (const b of buckets) t[b] += c.buckets[b];
          return t;
        },
        { ...data.data.totals, ...Object.fromEntries([['balance', 0], ...buckets.map((b) => [b, 0])]) } as typeof data.data.totals,
      )
    : data.data.totals;
  const late = totals.balance - totals.current;
  const lateIds = customers.filter((c) => c.balance > 0 && c.balance > c.buckets.current).map((c) => c.id);
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
      {zones.length > 0 && (
        <div className="filters">
          <select value={zone} onChange={(e) => setZone(e.target.value)} title="Zone ou tournée">
            <option value="">Toutes les zones</option>
            {zones.map((z) => (
              <option key={z} value={z}>
                {z}
              </option>
            ))}
          </select>
        </div>
      )}
      {lateIds.length > 0 && (
        <div className="actions" style={{ justifyContent: 'flex-start' }}>
          <button className="primary" onClick={() => setRemind(lateIds)}>
            Relancer les {lateIds.length} client{lateIds.length > 1 ? 's' : ''} en retard par WhatsApp…
          </button>
        </div>
      )}
      {customers.length === 0 ? (
        <Empty>Aucun client ne doit d'argent au magasin.</Empty>
      ) : (
        <table className="list aging">
          <thead>
            <tr>
              <th>Client</th>
              <th>Téléphone</th>
              <th>Zone</th>
              <th className="r">Doit</th>
              {buckets.map((b) => (
                <th key={b} className="r">
                  {labels[b]}
                </th>
              ))}
              <th>Dernière relance</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {customers.map((c) => (
              <tr key={c.id} className="clickable" onClick={() => void call('customers.get', c.id).then(setOpen)}>
                <td>{c.name}</td>
                <td>{c.phone}</td>
                <td>{c.zone ?? ''}</td>
                <td className="r b">{fcfa(c.balance)}</td>
                {buckets.map((b) => (
                  <td key={b} className={`r ${b !== 'current' && c.buckets[b] ? 'neg' : ''}`}>
                    {c.buckets[b] ? fcfa(c.buckets[b]) : ''}
                  </td>
                ))}
                <td className="nowrap">{c.last_reminder ? dateFr(c.last_reminder.at.slice(0, 10)) : ''}</td>
                <td>
                  {c.balance > 0 && (
                    <button
                      className="ghost"
                      onClick={(e) => {
                        e.stopPropagation();
                        setRemind([c.id]);
                      }}
                    >
                      Relancer
                    </button>
                  )}
                </td>
              </tr>
            ))}
            <tr className="b">
              <td colSpan={3}>Total</td>
              <td className="r">{fcfa(totals.balance)}</td>
              {buckets.map((b) => (
                <td key={b} className="r">
                  {totals[b] ? fcfa(totals[b]) : ''}
                </td>
              ))}
              <td colSpan={2}></td>
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
      {remind && (
        <ReminderDialog
          queue={remind}
          onClose={() => {
            setRemind(null);
            data.reload();
          }}
        />
      )}
    </>
  );
}

function Payments() {
  const toast = useToast();
  const list = useLoad(() => call('customers.payments', { limit: 200 }), []);
  if (list.data?.length === 0) return <Empty>Aucun règlement client enregistré. Encaissez un règlement depuis le compte du client, ou à la caisse par Action › Règlement client.</Empty>;
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
