import { useState } from 'react';
import { type Result, call } from '../api';
import { Empty, Field, Modal, dateFr, fcfa, parseAmount, parseQty, qty, today, useLoad, useToast } from '../ui';
import { type Customer, CustomerPickDialog } from './customerDialogs';
import { ArticlePicker } from './pickers';

type User = NonNullable<Result<'app.state'>['user']>;
type Rule = Result<'recurring.list'>[number];
const DAYS = ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'];
const FULL_DAYS = ['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche'];

const rhythm = (r: Pick<Rule, 'weekdays' | 'every_weeks'>) =>
  `${r.every_weeks === 1 ? 'Chaque' : r.every_weeks === 2 ? 'Une semaine sur deux, le' : `Toutes les ${r.every_weeks} semaines, le`} ${r.weekdays.map((d) => FULL_DAYS[d - 1]).join(', ')}`;

/**
 * Commandes répétées des clients pros : la commande se crée seule avant chaque
 * livraison et passe « préparée » (le stock lui est réservé).
 */
export function RecurringOrders({ user }: { user: User }) {
  const toast = useToast();
  const list = useLoad(() => call('recurring.list'), []);
  const [editing, setEditing] = useState<Rule | 'new' | null>(null);
  return (
    <>
      <div className="filters">
        <span className="muted">Restaurant, école, boutiquier : la commande de la semaine se prépare toute seule, le stock lui est réservé.</span>
        <button style={{ marginLeft: 'auto' }} onClick={() => call('recurring.generate').then((n) => toast.ok(n ? `${n} commande(s) créée(s)` : 'Rien à créer pour l’instant'), toast.error)}>
          Créer les commandes dues
        </button>
        <button className="primary" onClick={() => setEditing('new')}>
          Nouvelle commande répétée
        </button>
      </div>
      {list.data?.length === 0 ? (
        <Empty action={{ label: 'Nouvelle commande répétée', onClick: () => setEditing('new') }}>Aucune commande répétée.</Empty>
      ) : (
        <table className="list compact">
          <thead>
            <tr>
              <th>Client</th>
              <th>Rythme</th>
              <th className="r">Articles</th>
              <th className="r">Montant</th>
              <th>Prochaine livraison</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(list.data ?? []).map((r) => (
              <tr key={r.id} className={r.active ? 'clickable' : 'clickable muted'} onClick={() => setEditing(r)}>
                <td>
                  {r.customer_name} <small className="muted">{r.phone}</small>
                </td>
                <td>{rhythm(r)}</td>
                <td className="r">{r.lines.length}</td>
                <td className="r">{fcfa(r.total)}</td>
                <td>{r.active ? (r.next_date ? dateFr(r.next_date) : '-') : <span className="tag">arrêtée</span>}</td>
                <td className="r" onClick={(e) => e.stopPropagation()}>
                  <button onClick={() => call('recurring.setActive', r.id, !r.active).then(list.reload, toast.error)}>{r.active ? 'Arrêter' : 'Reprendre'}</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {editing && <RuleForm user={user} rule={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={() => (setEditing(null), list.reload())} />}
    </>
  );
}

function RuleForm({ user, rule, onClose, onSaved }: { user: User; rule: Rule | null; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [customer, setCustomer] = useState<{ id: string | null; name: string } | null>(rule ? { id: rule.customer_id, name: rule.customer_name } : null);
  const [picking, setPicking] = useState(false);
  const [name, setName] = useState(rule?.customer_id ? '' : (rule?.customer_name ?? ''));
  const [phone, setPhone] = useState(rule?.phone ?? '');
  const [address, setAddress] = useState(rule?.address ?? '');
  const [days, setDays] = useState<number[]>(rule?.weekdays ?? [1]);
  const [every, setEvery] = useState(rule?.every_weeks ?? 1);
  const [lead, setLead] = useState(rule?.lead_days ?? 1);
  const [start, setStart] = useState(rule?.start_date ?? today());
  const [fee, setFee] = useState(rule ? String(rule.delivery_fee) : '0');
  const [note, setNote] = useState(rule?.note ?? '');
  const [lines, setLines] = useState<{ articleId: string; name: string; qty: string }[]>(rule?.lines.map((l) => ({ articleId: l.articleId, name: l.name, qty: String(l.qty / 1000) })) ?? []);
  const submit = async () => {
    try {
      await call(
        'recurring.save',
        {
          customerId: customer?.id ?? null,
          customerName: customer?.id ? null : name,
          phone: phone || null,
          address: address || null,
          weekdays: days,
          everyWeeks: every,
          leadDays: lead,
          startDate: start,
          deliveryFee: parseAmount(fee) ?? 0,
          note: note || null,
          lines: lines.map((l) => ({ articleId: l.articleId, qty: parseQty(l.qty) ?? 0 })),
        },
        rule?.id ?? null,
      );
      toast.ok('Commande répétée enregistrée');
      onSaved();
    } catch (err) {
      toast.error(err);
    }
  };
  return (
    <Modal title={rule ? `Commande répétée : ${rule.customer_name}` : 'Nouvelle commande répétée'} onClose={onClose} wide>
      <div className="grid3">
        <Field label="Client">
          {customer?.id ? (
            <div className="filters">
              <b>{customer.name}</b>
              <button type="button" className="link" onClick={() => setCustomer(null)}>
                changer
              </button>
            </div>
          ) : (
            <div className="filters">
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Nom du client" />
              <button type="button" onClick={() => setPicking(true)}>
                Fiche client…
              </button>
            </div>
          )}
        </Field>
        <Field label="Téléphone">
          <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder={customer?.id ? 'Celui de la fiche' : ''} />
        </Field>
        <Field label="Adresse de livraison" hint="Vide : le client vient chercher">
          <input value={address} onChange={(e) => setAddress(e.target.value)} />
        </Field>
      </div>
      <Field label="Jours de livraison">
        <div className="seg">
          {DAYS.map((d, i) => (
            <button key={d} type="button" className={days.includes(i + 1) ? 'active' : ''} onClick={() => setDays(days.includes(i + 1) ? days.filter((x) => x !== i + 1) : [...days, i + 1])}>
              {d}
            </button>
          ))}
        </div>
      </Field>
      <div className="grid3">
        <Field label="Fréquence">
          <select value={every} onChange={(e) => setEvery(Number(e.target.value))}>
            <option value={1}>Toutes les semaines</option>
            <option value={2}>Une semaine sur deux</option>
            <option value={4}>Toutes les 4 semaines</option>
          </select>
        </Field>
        <Field label="Préparée" hint="La commande est créée et le stock réservé">
          <select value={lead} onChange={(e) => setLead(Number(e.target.value))}>
            <option value={0}>Le jour même</option>
            <option value={1}>La veille</option>
            <option value={2}>2 jours avant</option>
            <option value={3}>3 jours avant</option>
          </select>
        </Field>
        <Field label="À partir du">
          <input type="date" value={start} onChange={(e) => setStart(e.target.value)} />
        </Field>
        <Field label="Frais de livraison">
          <input inputMode="numeric" value={fee} onChange={(e) => setFee(e.target.value)} />
        </Field>
        <Field label="Remarque">
          <input value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
      </div>
      <ArticlePicker placeholder="Ajouter un article" onPick={(a) => !lines.some((l) => l.articleId === a.id) && setLines([...lines, { articleId: a.id, name: a.name, qty: '1' }])} />
      {lines.length > 0 && (
        <table className="list compact">
          <tbody>
            {lines.map((l, i) => (
              <tr key={l.articleId}>
                <td>{l.name}</td>
                <td>
                  <input className="qty" value={l.qty} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, qty: e.target.value } : x)))} />
                </td>
                <td>
                  <button className="ghost" onClick={() => setLines(lines.filter((_, j) => j !== i))}>
                    ✕
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {rule && rule.last_date && <p className="muted">Dernière commande créée pour le {dateFr(rule.last_date)} · {qty(rule.lines.reduce((t, l) => t + l.qty, 0))} articles</p>}
      <div className="actions">
        <button onClick={onClose}>Annuler</button>
        <button className="primary" disabled={!lines.length || !days.length} onClick={() => void submit()}>
          Enregistrer
        </button>
      </div>
      {picking && <CustomerPickDialog user={user} onClose={() => setPicking(false)} onPick={(c: Customer) => (setCustomer({ id: c.id, name: c.name }), setPhone(phone || (c.phone ?? '')), setAddress(address || (c.address ?? '')), setPicking(false))} />}
    </Modal>
  );
}
