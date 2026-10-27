import { useState } from 'react';
import { type Result, call } from '../api';
import { Empty, Field, Modal, askText, dateTime, parseQty, qty, useLoad, useToast } from '../ui';
import { ArticlePicker } from './pickers';

type Request = Result<'storeTransfers.list'>[number];

const STATUS: Record<Request['status'], [string, string]> = {
  requested: ['demandée', 'alerte'],
  shipped: ['expédiée', 'surstock'],
  received: ['réceptionnée', 'normal'],
  refused: ['refusée', 'rupture'],
  cancelled: ['annulée', ''],
};

/**
 * Marchandise entre magasins : avant d'acheter au fournisseur, on la demande
 * au magasin qui en a trop. Lui expédie (le stock sort chez lui), on réceptionne.
 */
export function StoreTransfers() {
  const toast = useToast();
  const list = useLoad(() => call('storeTransfers.list'), []);
  const sugg = useLoad(() => call('storeTransfers.suggestions'), []);
  const stores = useLoad(() => call('admin.stores'), []);
  const [asking, setAsking] = useState<{ articleId?: string; name?: string; fromStoreId?: string; qty?: number } | null>(null);
  const reload = () => (list.reload(), sugg.reload());
  const act = (p: Promise<unknown>, ok: string) => p.then(() => (toast.ok(ok), reload()), toast.error);
  const ship = async (r: Request) => {
    const v = await askText(`Quantité expédiée à ${r.to_store_name} (demandé : ${qty(r.qty)}) :`);
    if (!v) return;
    act(call('storeTransfers.ship', r.id, { qty: parseQty(v) ?? r.qty }), 'Expédié : le stock est sorti de votre magasin');
  };
  const receive = async (r: Request) => {
    const v = await askText(`Quantité arrivée (expédié : ${qty(r.shipped_qty ?? r.qty)}) :`);
    if (!v) return;
    act(call('storeTransfers.receive', r.id, { qty: parseQty(v) ?? 0 }), 'Réceptionné : le stock est entré');
  };
  const refuse = async (r: Request) => {
    const v = await askText('Pourquoi refuser ? (le demandeur le verra)');
    if (v) act(call('storeTransfers.refuse', r.id, v), 'Demande refusée');
  };
  const others = (stores.data ?? []).length > 1;
  return (
    <>
      <div className="filters">
        <span className="muted">Avant d'acheter au fournisseur, demandez la marchandise au magasin qui en a trop.</span>
        <button className="primary" style={{ marginLeft: 'auto' }} disabled={!others} onClick={() => setAsking({})}>
          Demander à un autre magasin
        </button>
      </div>
      {!others && <Empty>Un seul magasin : les demandes entre magasins servent quand la société en a plusieurs.</Empty>}
      {Boolean(sugg.data?.length) && (
        <section className="card">
          <h3>À demander plutôt qu'acheter</h3>
          <table className="list compact">
            <thead>
              <tr>
                <th>Article</th>
                <th className="r">Chez nous</th>
                <th className="r">Seuil</th>
                <th>Magasin qui en a trop</th>
                <th className="r">Son stock</th>
                <th className="r">À demander</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {sugg.data!.map((s) => (
                <tr key={s.article_id}>
                  <td>
                    {s.code} · {s.name}
                  </td>
                  <td className="r neg">{qty(s.stock)}</td>
                  <td className="r">{qty(s.alert_qty)}</td>
                  <td>
                    {s.from_store_name}
                    {s.updated_at && <small className="muted"> (stock du {dateTime(s.updated_at)})</small>}
                  </td>
                  <td className="r">{qty(s.from_stock)}</td>
                  <td className="r">
                    <b>{qty(s.qty)}</b>
                  </td>
                  <td className="r">
                    <button onClick={() => act(call('storeTransfers.request', { fromStoreId: s.from_store_id, articleId: s.article_id, qty: s.qty }), `Demande envoyée à ${s.from_store_name}`)}>Demander</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
      {list.data?.length === 0 ? (
        others && <Empty>Aucune demande entre magasins ces 60 derniers jours.</Empty>
      ) : (
        <table className="list compact">
          <thead>
            <tr>
              <th>N°</th>
              <th>Date</th>
              <th>Sens</th>
              <th>Article</th>
              <th className="r">Demandé</th>
              <th className="r">Expédié</th>
              <th className="r">Reçu</th>
              <th>État</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(list.data ?? []).map((r) => (
              <tr key={r.id}>
                <td>{r.number}</td>
                <td>{dateTime(r.created_at)}</td>
                <td>{r.direction === 'in' ? `Demandé à ${r.from_store_name}` : `Demandé par ${r.to_store_name}`}</td>
                <td>
                  {r.article_code} · {r.article_name}
                  {r.note && <small className="muted"> · {r.note}</small>}
                  {r.answer && <small className="muted"> · {r.answer}</small>}
                </td>
                <td className="r">{qty(r.qty)}</td>
                <td className="r">{r.shipped_qty === null ? '' : qty(r.shipped_qty)}</td>
                <td className="r">{r.received_qty === null ? '' : qty(r.received_qty)}</td>
                <td>
                  <span className={`tag ${STATUS[r.status][1]}`}>{STATUS[r.status][0]}</span>
                </td>
                <td className="r nowrap">
                  {r.direction === 'out' && r.status === 'requested' && (
                    <>
                      <button className="primary" onClick={() => void ship(r)}>
                        Expédier
                      </button>{' '}
                      <button onClick={() => void refuse(r)}>Refuser</button>
                    </>
                  )}
                  {r.direction === 'in' && r.status === 'requested' && <button onClick={() => act(call('storeTransfers.cancel', r.id), 'Demande annulée')}>Annuler</button>}
                  {r.direction === 'in' && r.status === 'shipped' && (
                    <button className="primary" onClick={() => void receive(r)}>
                      Réceptionner
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {asking && <AskDialog stores={stores.data ?? []} onClose={() => setAsking(null)} onDone={() => (setAsking(null), reload())} />}
    </>
  );
}

function AskDialog({ stores, onClose, onDone }: { stores: Result<'admin.stores'>; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const app = useLoad(() => call('app.state'), []);
  const mine = app.data?.station?.store.id;
  const [article, setArticle] = useState<{ id: string; name: string } | null>(null);
  const [from, setFrom] = useState('');
  const [quantity, setQuantity] = useState('');
  const [note, setNote] = useState('');
  const submit = async () => {
    if (!article) return toast.error("Choisissez l'article");
    try {
      await call('storeTransfers.request', { fromStoreId: from, articleId: article.id, qty: parseQty(quantity) ?? 0, note: note || null });
      toast.ok('Demande envoyée');
      onDone();
    } catch (err) {
      toast.error(err);
    }
  };
  return (
    <Modal title="Demander à un autre magasin" onClose={onClose}>
      {article ? (
        <p>
          <b>{article.name}</b>{' '}
          <button type="button" className="link" onClick={() => setArticle(null)}>
            changer
          </button>
        </p>
      ) : (
        <ArticlePicker onPick={(a) => setArticle({ id: a.id, name: a.name })} />
      )}
      <div className="grid3">
        <Field label="Magasin">
          <select value={from} onChange={(e) => setFrom(e.target.value)}>
            <option value="">—</option>
            {stores
              .filter((s) => s.id !== mine)
              .map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
          </select>
        </Field>
        <Field label="Quantité">
          <input className="qty" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
        </Field>
        <Field label="Remarque">
          <input value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
      </div>
      <div className="actions">
        <button onClick={onClose}>Annuler</button>
        <button className="primary" disabled={!article || !from || !parseQty(quantity)} onClick={() => void submit()}>
          Envoyer la demande
        </button>
      </div>
    </Modal>
  );
}
