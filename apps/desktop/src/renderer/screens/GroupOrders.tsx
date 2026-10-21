import { useEffect, useState } from 'react';
import { type Result, call } from '../api';
import { Empty, Field, Modal, dateFr, fcfa, parseAmount, parseQty, qty, today, useLoad, useToast } from '../ui';
import { tx } from '../tax';
import { ArticlePicker, SupplierSelect } from './pickers';

type Article = Result<'catalogue.get'>;
type Needs = Result<'purchases.groupNeeds'>;
type GroupDetail = Result<'purchases.groupOrder'>;
type Order = GroupDetail['orders'][number];

const STATES: Record<Order['state'], string> = {
  draft: 'Brouillon',
  sent: 'Envoyée',
  partial: 'Reçue en partie',
  received: 'Reçue',
  closed: 'Soldée',
  cancelled: 'Annulée',
};

const num = (milli: number) => String(milli / 1000).replace('.', ',');

/** Quantité proposée : de quoi vendre 14 jours (d'après les 28 derniers jours), moins le stock, arrondie à l'unité supérieure. */
const suggest = (n: { stock: number; sold28: number } | undefined) => {
  if (!n) return 0;
  const need = (n.sold28 / 28) * 14 - Math.max(0, n.stock);
  return need > 0 ? Math.ceil(need / 1000) * 1000 : 0;
};

interface Line {
  article: Article;
  cost: string;
  /** Quantité saisie par magasin (texte). */
  qty: Record<string, string>;
}

/**
 * Commandes groupées : une négociation avec un fournisseur pour plusieurs
 * magasins. Chaque magasin reçoit son propre bon de commande, sous un même
 * numéro « CG- », et réceptionne lui-même sa marchandise.
 */
export function GroupOrders() {
  const [created, setCreated] = useState<GroupDetail | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const list = useLoad(() => call('purchases.groupOrders'), [created]);
  return (
    <>
      <p className="muted">Chaque magasin reçoit son propre bon de commande, livré à son dépôt de vente, et réceptionne lui-même la marchandise.</p>
      <GroupForm onCreated={(ref) => call('purchases.groupOrder', ref).then(setCreated)} />
      <h3>Commandes groupées passées</h3>
      {(list.data ?? []).length === 0 ? (
        <Empty>Aucune commande groupée pour le moment.</Empty>
      ) : (
        <table className="list">
          <thead>
            <tr>
              <th>N°</th>
              <th>Date</th>
              <th>Fournisseur</th>
              <th className="r">Magasins</th>
              <th className="r">Reçues</th>
              <th className="r">{tx('Total HT')}</th>
            </tr>
          </thead>
          <tbody>
            {(list.data ?? []).map((g) => (
              <tr key={g.ref} className="clickable" onClick={() => setOpen(g.ref)}>
                <td>{g.ref}</td>
                <td>{dateFr(g.order_date.slice(0, 10))}</td>
                <td>{g.supplier_name}</td>
                <td className="r">{g.stores}</td>
                <td className="r">
                  {g.received === g.stores ? <span className="tag normal">toutes</span> : `${g.received} sur ${g.stores}`}
                </td>
                <td className="r">{fcfa(g.total_ht)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {created && (
        <Modal title={`Commande groupée ${created.ref} créée`} onClose={() => setCreated(null)} wide>
          <p>Un bon de commande brouillon a été créé pour chaque magasin. Il part vers les PC du magasin par la synchronisation ; chaque magasin le réceptionne à l'arrivée.</p>
          <GroupOrderView group={created} />
        </Modal>
      )}
      {open && <GroupDetailModal reference={open} onClose={() => setOpen(null)} />}
    </>
  );
}

function GroupForm({ onCreated }: { onCreated: (ref: string) => void }) {
  const toast = useToast();
  const [supplierId, setSupplierId] = useState('');
  const [expected, setExpected] = useState('');
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<Line[]>([]);
  const [busy, setBusy] = useState(false);
  const stores = useLoad(() => call('admin.stores'));
  const supplierArticles = useLoad(() => (supplierId ? call('suppliers.articles', supplierId) : Promise.resolve([])), [supplierId]);
  const ids = lines.map((l) => l.article.id).join(',');
  const [needs, setNeeds] = useState<Needs>([]);
  useEffect(() => {
    if (!ids) return setNeeds([]);
    call('purchases.groupNeeds', ids.split(',')).then(setNeeds, toast.error);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids]);
  const storeList = needs.length ? needs.map((n) => ({ id: n.storeId, name: n.storeName })) : (stores.data ?? []).map((s) => ({ id: s.id, name: s.name }));
  const need = (storeId: string, articleId: string) => needs.find((n) => n.storeId === storeId)?.articles[articleId];
  // Proposition par défaut dès que les besoins des magasins sont connus.
  useEffect(() => {
    if (!needs.length) return;
    setLines((ls) =>
      ls.map((l) => {
        const q = { ...l.qty };
        for (const n of needs) if (q[n.storeId] === undefined && n.articles[l.article.id]) q[n.storeId] = num(suggest(n.articles[l.article.id]));
        return { ...l, qty: q };
      }),
    );
  }, [needs]);
  const set = (i: number, patch: Partial<Line>) => setLines(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const lineQty = (l: Line) => storeList.reduce((t, s) => t + (parseQty(l.qty[s.id] ?? '') ?? 0), 0);
  const total = lines.reduce((t, l) => t + Math.round((lineQty(l) * (parseAmount(l.cost) ?? 0)) / 1000), 0);
  const add = (a: Article) => {
    if (lines.some((l) => l.article.id === a.id)) return toast.ok(`${a.name} est déjà dans la commande`);
    const ref = (supplierArticles.data ?? []).find((x) => x.article_id === a.id);
    setLines([...lines, { article: a, cost: String(ref?.unit_cost || a.purchase_price), qty: {} }]);
  };
  const save = async () => {
    setBusy(true);
    try {
      if (!supplierId) throw new Error('Choisissez le fournisseur');
      const input = lines.map((l) => {
        const unitCost = parseAmount(l.cost);
        if (unitCost === null) throw new Error(`Prix d'achat invalide : ${l.article.name}`);
        const qtyByStore: Record<string, number> = {};
        for (const s of storeList) {
          const text = (l.qty[s.id] ?? '').trim();
          if (!text) continue;
          const q = parseQty(text);
          if (q === null || q < 0) throw new Error(`Quantité invalide : ${l.article.name}, ${s.name}`);
          if (q) qtyByStore[s.id] = q;
        }
        return { articleId: l.article.id, unitCost, qtyByStore };
      });
      const r = await call('purchases.createGroupOrder', { supplierId, expectedDate: expected || null, notes: notes || null, lines: input });
      toast.ok(`Commande groupée ${r.ref} créée : ${r.orders.length} bon(s) de commande`);
      setLines([]);
      setNotes('');
      onCreated(r.ref);
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="card">
      <h3>Nouvelle commande groupée</h3>
      <div className="grid3">
        <SupplierSelect value={supplierId} onChange={setSupplierId} />
        <Field label="Livraison prévue">
          <input type="date" value={expected} min={today()} onChange={(e) => setExpected(e.target.value)} />
        </Field>
        <Field label="Notes">
          <input value={notes} placeholder="Conditions négociées, remise de volume…" onChange={(e) => setNotes(e.target.value)} />
        </Field>
      </div>
      <ArticlePicker placeholder="Article à commander (code, nom ou code-barres)" onPick={add} />
      {lines.length === 0 ? (
        <p className="muted">
          Ajoutez les articles : pour chaque magasin, vous voyez son stock et ses ventes des 28 derniers jours. La quantité proposée couvre 14 jours de vente, moins le
          stock ; modifiez-la librement.
        </p>
      ) : (
        <table className="list compact">
          <thead>
            <tr>
              <th>Article</th>
              <th className="r">{tx("Prix d'achat HT")}</th>
              {storeList.map((s) => (
                <th key={s.id}>{s.name}</th>
              ))}
              <th className="r">Total</th>
              <th className="r">{tx('Montant HT')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={l.article.id}>
                <td>
                  {l.article.name} <small className="muted">{l.article.code}</small>
                </td>
                <td className="r">
                  <input className="qty" value={l.cost} onChange={(e) => set(i, { cost: e.target.value })} />
                </td>
                {storeList.map((s) => {
                  const n = need(s.id, l.article.id);
                  return (
                    <td key={s.id}>
                      <input className="qty" value={l.qty[s.id] ?? ''} onChange={(e) => set(i, { qty: { ...l.qty, [s.id]: e.target.value } })} />
                      {n && (
                        <small className="muted block">
                          stock {qty(n.stock, l.article.unit)} · vendu {qty(n.sold28, l.article.unit)} en 28 j
                        </small>
                      )}
                    </td>
                  );
                })}
                <td className="r">{qty(lineQty(l), l.article.unit)}</td>
                <td className="r">{fcfa(Math.round((lineQty(l) * (parseAmount(l.cost) ?? 0)) / 1000))}</td>
                <td>
                  <button className="link" onClick={() => setLines(lines.filter((_, j) => j !== i))}>
                    Retirer
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="actions">
        <span className="big-total">
          {fcfa(total)}
          {tx(' HT')}
        </span>
        <button className="primary" disabled={busy || !lines.length || !supplierId} onClick={() => void save()}>
          Créer la commande groupée
        </button>
      </div>
    </div>
  );
}

function GroupOrderView({ group }: { group: GroupDetail }) {
  return (
    <>
      <p className="muted">Fournisseur : {group.supplier_name}</p>
      {group.orders.map((o) => (
        <section key={o.id}>
          <h4>
            {o.store_name} : bon {o.number} <span className="tag">{STATES[o.state]}</span>
          </h4>
          <p className="muted">
            Livré au dépôt {o.warehouse_name}
            {o.expected_date ? `, prévu le ${dateFr(o.expected_date)}` : ''} · {fcfa(o.total_ht)}
            {tx(' HT')}
          </p>
          <table className="list compact">
            <thead>
              <tr>
                <th>Article</th>
                <th className="r">Quantité</th>
                <th className="r">{tx('PU HT')}</th>
              </tr>
            </thead>
            <tbody>
              {o.lines.map((l) => (
                <tr key={l.id}>
                  <td>
                    {l.article_name} <small className="muted">{l.article_code}</small>
                  </td>
                  <td className="r">{qty(l.qty, l.unit)}</td>
                  <td className="r">{fcfa(l.unit_cost)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}
    </>
  );
}

function GroupDetailModal({ reference, onClose }: { reference: string; onClose: () => void }) {
  const g = useLoad(() => call('purchases.groupOrder', reference), [reference]);
  return (
    <Modal title={`Commande groupée ${reference}`} onClose={onClose} wide>
      {g.data ? <GroupOrderView group={g.data} /> : <p className="muted">Chargement…</p>}
    </Modal>
  );
}
