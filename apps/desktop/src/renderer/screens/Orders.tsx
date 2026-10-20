import { useState } from 'react';
import { type Result, call } from '../api';
import { askConfirm, askText, dateFr, Empty, fcfa, Field, has, Modal, parseAmount, parseQty, qty, today, useCan, useLoad, useToast } from '../ui';
import { type Customer, CustomerPickDialog } from './customerDialogs';
import { ArticlePicker, SupplierSelect } from './pickers';

type User = NonNullable<Result<'app.state'>['user']>;
type Order = Result<'orders.get'>;
type Article = Result<'catalogue.get'>;
type Status = Order['status'];
type Channel = Order['channel'];

const STATUS: Record<Status, [string, string]> = {
  new: ['à préparer', 'alerte'],
  prepared: ['préparée', 'normal'],
  invoiced: ['facturée', 'surstock'],
  cancelled: ['annulée', ''],
};
const CHANNELS: Record<Channel, string> = { phone: 'Téléphone', whatsapp: 'WhatsApp', shop: 'Au magasin', web: 'Boutique en ligne' };
const SLOTS = ['Matin', 'Midi', 'Après-midi', 'Soir'];

function StatusTag({ status }: { status: Status }) {
  const [label, cls] = STATUS[status];
  return <span className={`tag ${cls}`}>{label}</span>;
}

/** Numéro camerounais pour wa.me : 9 chiffres locaux préfixés de 237. */
export function waPhone(phone: string | null): string {
  const d = (phone ?? '').replace(/\D/g, '');
  return d.length === 9 ? `237${d}` : d;
}

/**
 * Commandes clients prises par téléphone ou WhatsApp : on les prépare (la marchandise
 * est mise de côté), puis on les charge à la caisse au moment de la livraison ou du retrait.
 */
export function Orders({ user }: { user: User }) {
  const [status, setStatus] = useState<Status | 'open' | ''>('open');
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<Order | 'new' | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const list = useLoad(() => call('orders.list', { status: status || undefined, search: search || undefined }), [status, search]);
  const rows = list.data ?? [];
  return (
    <div className="page">
      <header className="page-head">
        <h1>Commandes clients</h1>
      </header>
      <div className="filters">
        <select value={status} onChange={(e) => setStatus(e.target.value as Status | 'open' | '')}>
          <option value="open">En cours (à préparer et préparées)</option>
          <option value="new">À préparer</option>
          <option value="prepared">Préparées</option>
          <option value="invoiced">Facturées</option>
          <option value="cancelled">Annulées</option>
          <option value="">Toutes</option>
        </select>
        <input placeholder="N°, client, téléphone" value={search} onChange={(e) => setSearch(e.target.value)} />
        <button data-new title="Ctrl+J" className="primary" style={{ marginLeft: 'auto' }} disabled={!has(user, 'customer_orders')} onClick={() => setEditing('new')}>
          Nouvelle commande
        </button>
      </div>
      {rows.length === 0 ? (
        <Empty action={has(user, 'customer_orders') ? { label: 'Nouvelle commande', onClick: () => setEditing('new') } : undefined}>
          Aucune commande. Un client appelle ou écrit sur WhatsApp : saisissez sa commande, préparez-la (la marchandise est mise de côté), puis chargez-la à la caisse
          (Action › Charger une commande client) au moment de la livraison.
        </Empty>
      ) : (
        <table className="list compact">
          <thead>
            <tr>
              <th>Pour le</th>
              <th>N°</th>
              <th>Client</th>
              <th>Téléphone</th>
              <th>Livraison</th>
              <th>État</th>
              <th className="r">Montant</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((o) => (
              <tr key={o.id} className={`clickable ${o.status === 'cancelled' ? 'inactive' : ''}`} onClick={() => setOpen(o.id)}>
                <td className="nowrap">
                  {dateFr(o.planned_date)} {o.slot && <span className="muted">{o.slot}</span>}
                </td>
                <td className="nowrap">{o.number}</td>
                <td>
                  {o.customer_name} <span className="muted">· {CHANNELS[o.channel]}</span>
                </td>
                <td className="nowrap">{o.phone}</td>
                <td>{o.address ?? <span className="muted">retrait au magasin</span>}</td>
                <td>
                  <StatusTag status={o.status} />
                  {o.sale_number && <span className="muted"> {o.sale_number}</span>}
                </td>
                <td className="r">{fcfa(o.total_ttc)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {editing && (
        <OrderEditor
          user={user}
          order={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(o) => {
            setEditing(null);
            setOpen(o.id);
            list.reload();
          }}
        />
      )}
      {open && (
        <OrderDetail
          id={open}
          onClose={() => setOpen(null)}
          onEdit={(o) => {
            setOpen(null);
            setEditing(o);
          }}
          onChanged={list.reload}
        />
      )}
    </div>
  );
}

interface DraftLine {
  key: number;
  article: Article;
  qty: string;
}
let keySeq = 0;

function OrderEditor({ user, order, onClose, onSaved }: { user: User; order: Order | null; onClose: () => void; onSaved: (o: Order) => void }) {
  const toast = useToast();
  const [customer, setCustomer] = useState<{ id: string; name: string } | null>(order?.customer_id ? { id: order.customer_id, name: order.customer_name } : null);
  const [f, setF] = useState({
    customerName: order && !order.customer_id ? order.customer_name : '',
    phone: order?.phone ?? '',
    address: order?.address ?? '',
    channel: (order?.channel ?? 'phone') as Channel,
    plannedDate: order?.planned_date ?? today(),
    slot: order?.slot ?? '',
    fee: order?.delivery_fee ? String(order.delivery_fee) : '',
    courier: order?.courier ?? '',
    note: order?.note ?? '',
  });
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [picking, setPicking] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  useLoad(async () => {
    if (!order) return;
    const arts = await Promise.all(order.lines.map((l) => call('catalogue.get', l.article_id)));
    setLines(order.lines.map((l, i) => ({ key: ++keySeq, article: arts[i]!, qty: String(l.qty / 1000).replace('.', ',') })));
  }, [order?.id]);

  const parsed = lines.map((l) => parseQty(l.qty));
  const fee = f.fee ? parseAmount(f.fee) : 0;
  const total = lines.reduce((t, l, i) => t + Math.round((l.article.store_price * (parsed[i] ?? 0)) / 1000), 0) + (fee ?? 0);
  const valid = lines.length > 0 && parsed.every((q) => q !== null && q > 0) && fee !== null && (customer || f.customerName.trim()) && (customer || f.phone.trim());

  const add = (a: Article) => {
    const existing = lines.find((l) => l.article.id === a.id);
    if (existing) setLines(lines.map((l) => (l === existing ? { ...l, qty: String((parseQty(l.qty) ?? 0) / 1000 + 1).replace('.', ',') } : l)));
    else setLines([...lines, { key: ++keySeq, article: a, qty: '1' }]);
  };

  const submit = async () => {
    try {
      const o = await call(
        'orders.save',
        {
          customerId: customer?.id ?? null,
          customerName: customer ? null : f.customerName,
          phone: f.phone || null,
          address: f.address || null,
          channel: f.channel,
          plannedDate: f.plannedDate,
          slot: f.slot || null,
          deliveryFee: fee ?? 0,
          courier: f.courier || null,
          note: f.note || null,
          lines: lines.map((l, i) => ({ articleId: l.article.id, qty: parsed[i]! })),
        },
        order?.id ?? null,
      );
      toast.ok(`${o.number} enregistrée`);
      onSaved(o);
    } catch (err) {
      toast.error(err);
    }
  };

  return (
    <Modal title={order ? `Modifier ${order.number}` : 'Nouvelle commande client'} onClose={onClose} wide>
      <div className="methods">
        {(Object.keys(CHANNELS) as Channel[]).filter((c) => c !== 'web').map((c) => (
          <button type="button" key={c} className={f.channel === c ? 'active' : ''} onClick={() => setF({ ...f, channel: c })}>
            {CHANNELS[c]}
          </button>
        ))}
      </div>
      <div className="grid2">
        <div className="field">
          <span>Client</span>
          {customer ? (
            <div className="inline">
              <strong>{customer.name}</strong>
              <button type="button" onClick={() => setCustomer(null)}>
                Changer
              </button>
            </div>
          ) : (
            <div className="inline">
              <input value={f.customerName} onChange={set('customerName')} placeholder="Nom du client" />
              <button type="button" className="nowrap" onClick={() => setPicking(true)}>
                Fiche client…
              </button>
            </div>
          )}
        </div>
        <Field label="Téléphone" hint={customer ? 'Vide : celui de la fiche client' : undefined}>
          <input value={f.phone} onChange={set('phone')} maxLength={40} />
        </Field>
      </div>
      <Field label="Adresse de livraison" hint="Vide : le client vient chercher sa commande au magasin">
        <input value={f.address} onChange={set('address')} maxLength={200} placeholder="Quartier, rue, repère" />
      </Field>
      <div className="grid2">
        <Field label="Pour le">
          <input type="date" value={f.plannedDate} min={today()} onChange={set('plannedDate')} />
        </Field>
        <Field label="Créneau">
          <input value={f.slot} onChange={set('slot')} list="order-slots" maxLength={40} />
          <datalist id="order-slots">
            {SLOTS.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
        </Field>
      </div>
      <div className="grid2">
        <Field label="Frais de livraison (FCFA)">
          <input inputMode="numeric" value={f.fee} onChange={set('fee')} placeholder="0" disabled={!f.address.trim()} />
        </Field>
        <Field label="Livreur">
          <input value={f.courier} onChange={set('courier')} maxLength={60} />
        </Field>
      </div>
      <ArticlePicker onPick={add} />
      {lines.length === 0 ? (
        <Empty>Scannez ou recherchez les articles commandés.</Empty>
      ) : (
        <table className="list compact">
          <thead>
            <tr>
              <th>Article</th>
              <th className="r">Prix du jour</th>
              <th className="r">Quantité</th>
              <th className="r">Montant</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={l.key}>
                <td>{l.article.name}</td>
                <td className="r">{fcfa(l.article.store_price)}</td>
                <td className="r">
                  <input className="num" style={{ width: 80 }} value={l.qty} onChange={(e) => setLines(lines.map((x) => (x.key === l.key ? { ...x, qty: e.target.value } : x)))} />
                </td>
                <td className="r">{parsed[i] != null ? fcfa(Math.round((l.article.store_price * parsed[i]!) / 1000)) : '—'}</td>
                <td>
                  <button type="button" className="link" onClick={() => setLines(lines.filter((x) => x.key !== l.key))}>
                    Retirer
                  </button>
                </td>
              </tr>
            ))}
            <tr className="total">
              <td colSpan={3}>Total estimé{fee ? ', livraison comprise' : ''}</td>
              <td className="r">{fcfa(total)}</td>
              <td />
            </tr>
          </tbody>
        </table>
      )}
      <Field label="Note (préparation, livreur)">
        <input value={f.note} onChange={set('note')} maxLength={300} />
      </Field>
      <p className="muted">Le prix est celui du jour de la vente à la caisse. {order?.status === 'prepared' ? 'Modifier la commande la remet « à préparer ».' : ''}</p>
      <div className="actions">
        <button type="button" onClick={onClose}>
          Annuler
        </button>
        <button type="button" className="primary" disabled={!valid} onClick={() => void submit()}>
          Enregistrer
        </button>
      </div>
      {picking && (
        <CustomerPickDialog
          user={user}
          onClose={() => setPicking(false)}
          onPick={(c: Customer) => {
            setCustomer({ id: c.id, name: c.name });
            setPicking(false);
          }}
        />
      )}
    </Modal>
  );
}

function OrderDetail({ id, onClose, onEdit, onChanged }: { id: string; onClose: () => void; onEdit: (o: Order) => void; onChanged: () => void }) {
  const toast = useToast();
  const can = useCan();
  const loaded = useLoad(() => call('orders.get', id), [id]);
  const [backOrder, setBackOrder] = useState(false);
  const o = loaded.data;
  if (!o) return null;
  const act = async (fn: () => Promise<unknown>, done: string) => {
    try {
      await fn();
      toast.ok(done);
      loaded.reload();
      onChanged();
    } catch (err) {
      toast.error(err);
    }
  };
  const whatsapp = async () => {
    try {
      const text = await call('orders.confirmation', o.id);
      window.open(`https://wa.me/${waPhone(o.phone)}?text=${encodeURIComponent(text)}`);
    } catch (err) {
      toast.error(err);
    }
  };
  const openOrder = o.status === 'new' || o.status === 'prepared';
  const backOrdered = o.lines.some((l) => l.purchase_order_id);
  return (
    <Modal title={`Commande ${o.number}`} onClose={onClose} wide>
      <p>
        <StatusTag status={o.status} /> <strong>{o.customer_name}</strong> · {o.phone} · {CHANNELS[o.channel]}
        <span className="muted"> · prise par {o.user_name}</span>
      </p>
      <p>
        {o.address ? `À livrer le ${dateFr(o.planned_date)}${o.slot ? ` (${o.slot})` : ''} : ${o.address}` : `À retirer au magasin le ${dateFr(o.planned_date)}${o.slot ? ` (${o.slot})` : ''}`}
        {o.courier && <span className="muted"> · livreur {o.courier}</span>}
      </p>
      {o.sale_number && <p>Facturée par le ticket {o.sale_number}.</p>}
      <table className="list compact">
        <thead>
          <tr>
            <th>Article</th>
            <th className="r">Quantité</th>
            <th className="r">Prix</th>
            <th className="r">Montant</th>
            {backOrdered && <th>Chez le fournisseur</th>}
          </tr>
        </thead>
        <tbody>
          {o.lines.map((l) => (
            <tr key={l.id}>
              <td>{l.label}</td>
              <td className="r">{qty(l.qty, l.unit)}</td>
              <td className="r">{fcfa(l.unit_price)}</td>
              <td className="r">{fcfa(l.total_ttc)}</td>
              {backOrdered && <td>{l.purchase_order_number ? `${l.purchase_order_number} · ${l.purchase_received > 0 ? `reçu ${qty(l.purchase_received, l.unit)}` : 'commandé'}` : ''}</td>}
            </tr>
          ))}
          {o.delivery_fee > 0 && (
            <tr>
              <td colSpan={3}>Frais de livraison</td>
              <td className="r">{fcfa(o.delivery_fee)}</td>
            </tr>
          )}
          <tr className="total">
            <td colSpan={3}>Total estimé</td>
            <td className="r">{fcfa(o.total_ttc)}</td>
          </tr>
        </tbody>
      </table>
      {o.note && <p className="muted">{o.note}</p>}
      {o.status === 'new' && <p className="muted">Une fois la marchandise mise de côté, cliquez sur « Préparée » : la caisse ne la vendra plus à un autre client.</p>}
      {o.status === 'prepared' && <p className="muted">Pour l'encaisser : caisse › Action › Charger une commande client, au moment de la livraison ou du retrait.</p>}
      <div className="actions">
        {openOrder && can('customer_order_cancel') && (
          <button
            type="button"
            className="danger"
            onClick={async () => {
              const reason = await askText(`Motif de l'annulation de ${o.number} ?`);
              if (reason) void act(() => call('orders.cancel', o.id, reason), `${o.number} annulée`);
            }}
          >
            Annuler la commande
          </button>
        )}
        {openOrder && can('customer_orders') && (
          <button type="button" onClick={() => onEdit(o)}>
            Modifier
          </button>
        )}
        {openOrder && can('back_orders') && (
          <button type="button" onClick={() => setBackOrder(true)}>
            Commander au fournisseur ce qui manque
          </button>
        )}
        {openOrder && o.phone && (
          <button type="button" onClick={() => void whatsapp()}>
            Confirmer par WhatsApp
          </button>
        )}
        {o.status === 'prepared' && can('customer_orders') && (
          <button
            type="button"
            onClick={async () => {
              if (await askConfirm('Remettre la commande « à préparer » ? La marchandise mise de côté redevient vendable.')) void act(() => call('orders.unprepare', o.id), `${o.number} à préparer`);
            }}
          >
            Remettre à préparer
          </button>
        )}
        {o.status === 'new' && can('customer_orders') && (
          <button type="button" className="primary" onClick={() => void act(() => call('orders.prepare', o.id), `${o.number} préparée : marchandise réservée`)}>
            Préparée
          </button>
        )}
      </div>
      {backOrder && (
        <BackOrderDialog
          order={o}
          onClose={() => setBackOrder(false)}
          onDone={() => {
            setBackOrder(false);
            loaded.reload();
            onChanged();
          }}
        />
      )}
    </Modal>
  );
}

/** Contremarque : ce que le stock ne couvre pas part en bon de commande chez le fournisseur. */
function BackOrderDialog({ order, onClose, onDone }: { order: Order; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const needs = useLoad(() => call('orders.backOrderNeeds', order.id), [order.id]);
  const [supplierId, setSupplierId] = useState('');
  const rows = needs.data ?? [];
  const orphan = rows.some((n) => !n.supplierId);
  return (
    <Modal title={`Commander au fournisseur pour ${order.number}`} onClose={onClose}>
      {needs.data && rows.length === 0 ? (
        <p>Le stock couvre déjà toute la commande : rien à commander.</p>
      ) : (
        <table className="list compact">
          <thead>
            <tr>
              <th>Article</th>
              <th className="r">Manque</th>
              <th>Fournisseur</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((n) => (
              <tr key={n.lineId}>
                <td>{n.name}</td>
                <td className="r">{qty(n.missing, order.lines.find((l) => l.id === n.lineId)?.unit ?? 'piece')}</td>
                <td>{n.supplierName ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {rows.length > 0 && <SupplierSelect value={supplierId} onChange={setSupplierId} optional={!orphan} label={orphan ? 'Fournisseur à qui commander' : 'Autre fournisseur (sinon le fournisseur habituel)'} />}
      <p className="muted">Les articles sont ajoutés au bon de commande en préparation chez le fournisseur, ou à un nouveau bon.</p>
      <div className="actions">
        <button type="button" onClick={onClose}>
          Fermer
        </button>
        <button
          type="button"
          className="primary"
          disabled={rows.length === 0 || (orphan && !supplierId)}
          onClick={async () => {
            try {
              const pos = await call('orders.backOrder', order.id, { supplierId: supplierId || null });
              toast.ok(`Bon de commande ${pos.map((p) => p.number).join(', ')}`);
              onDone();
            } catch (err) {
              toast.error(err);
            }
          }}
        >
          Commander
        </button>
      </div>
    </Modal>
  );
}

/** Choix, à la caisse, de la commande client à encaisser. */
export function OrderPickDialog({ onClose, onPick }: { onClose: () => void; onPick: (id: string) => void }) {
  const [search, setSearch] = useState('');
  const list = useLoad(() => call('orders.list', { status: 'open', search: search || undefined }), [search]);
  const rows = list.data ?? [];
  return (
    <Modal title="Charger une commande client" onClose={onClose} wide>
      <div className="toolbar">
        <input autoFocus placeholder="N°, client ou téléphone" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>
      {rows.length === 0 ? (
        <Empty>Aucune commande en cours.</Empty>
      ) : (
        <table className="list compact">
          <thead>
            <tr>
              <th>Pour le</th>
              <th>N°</th>
              <th>Client</th>
              <th>État</th>
              <th className="r">Montant</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((o) => (
              <tr key={o.id} className="clickable" onClick={() => onPick(o.id)}>
                <td>{dateFr(o.planned_date)}</td>
                <td className="nowrap">{o.number}</td>
                <td>{o.customer_name}</td>
                <td>
                  <StatusTag status={o.status} />
                </td>
                <td className="r">{fcfa(o.total_ttc)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Modal>
  );
}
