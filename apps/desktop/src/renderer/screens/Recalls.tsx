import { useState } from 'react';
import { type Result, call } from '../api';
import { Empty, Field, Modal, askConfirm, askText, dateFr, dateTime, fcfa, qty, useLoad, useToast } from '../ui';
import { ArticlePicker, SupplierSelect, WarehouseSelect } from './pickers';

type Recall = Result<'recalls.list'>[number];

/**
 * Rappels de lots (fabricant, distributeur, administration) : le lot est
 * bloqué à la caisse tant que le rappel est ouvert. On voit son stock dépôt
 * par dépôt, les clients connus qui l'ont acheté, et on prépare le retour.
 */
export function Recalls() {
  const [open, setOpen] = useState(true);
  const [creating, setCreating] = useState(false);
  const [detail, setDetail] = useState<string | null>(null);
  const list = useLoad(() => call('recalls.list', { open }), [open]);
  return (
    <>
      <div className="filters">
        <div className="seg">
          <button className={open ? 'active' : ''} onClick={() => setOpen(true)}>
            En cours
          </button>
          <button className={open ? '' : 'active'} onClick={() => setOpen(false)}>
            Tous
          </button>
        </div>
        <button className="primary" style={{ marginLeft: 'auto' }} onClick={() => setCreating(true)}>
          Nouveau rappel de lot
        </button>
      </div>
      {list.data?.length === 0 ? (
        <Empty>Aucun rappel en cours. Quand un fournisseur rappelle un lot, saisissez-le ici : la caisse refusera de le vendre.</Empty>
      ) : (
        <table className="list compact">
          <thead>
            <tr>
              <th>Date</th>
              <th>Article</th>
              <th>Lot</th>
              <th>DLC</th>
              <th>Motif</th>
              <th className="r">Stock bloqué</th>
              <th className="r">Clients à prévenir</th>
              <th>État</th>
            </tr>
          </thead>
          <tbody>
            {(list.data ?? []).map((r) => (
              <tr key={r.id} className="clickable" onClick={() => setDetail(r.id)}>
                <td>{dateTime(r.created_at)}</td>
                <td>
                  {r.article_code} · {r.article_name}
                </td>
                <td>{r.lot_number ?? 'tous les lots'}</td>
                <td>{r.expiry ? dateFr(r.expiry) : '-'}</td>
                <td>{r.reason}</td>
                <td className="r">{qty(r.stock)}</td>
                <td className="r">{r.buyers}</td>
                <td>{r.status === 'open' ? <span className="tag rupture">bloqué</span> : <span className="tag">clos</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {creating && <RecallForm onClose={() => setCreating(false)} onSaved={(id) => (setCreating(false), list.reload(), setDetail(id))} />}
      {detail && <RecallDetail id={detail} onClose={() => (setDetail(null), list.reload())} />}
    </>
  );
}

function RecallForm({ onClose, onSaved }: { onClose: () => void; onSaved: (id: string) => void }) {
  const toast = useToast();
  const [article, setArticle] = useState<{ id: string; name: string } | null>(null);
  const [lot, setLot] = useState('');
  const [expiry, setExpiry] = useState('');
  const [reason, setReason] = useState('');
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!article) return toast.error("Choisissez l'article rappelé");
    try {
      const d = await call('recalls.create', { articleId: article.id, lotNumber: lot || null, expiry: expiry || null, reason });
      toast.ok('Lot bloqué à la caisse');
      onSaved(d.recall.id);
    } catch (err) {
      toast.error(err);
    }
  };
  return (
    <Modal title="Rappel de lot" onClose={onClose}>
      <form onSubmit={submit}>
        {article ? (
          <p>
            <b>{article.name}</b>{' '}
            <button type="button" className="link" onClick={() => setArticle(null)}>
              changer
            </button>
          </p>
        ) : (
          <ArticlePicker onPick={(a) => setArticle({ id: a.id, name: a.name })} placeholder="Article rappelé : scanner ou rechercher" />
        )}
        <div className="grid3">
          <Field label="Numéro de lot" hint="Vide : tous les lots de l'article">
            <input value={lot} onChange={(e) => setLot(e.target.value)} />
          </Field>
          <Field label="Date limite (facultatif)">
            <input type="date" value={expiry} onChange={(e) => setExpiry(e.target.value)} />
          </Field>
          <Field label="Motif">
            <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Rappel du fabricant" required />
          </Field>
        </div>
        <div className="actions">
          <button type="button" onClick={onClose}>
            Annuler
          </button>
          <button className="primary">Bloquer ce lot</button>
        </div>
      </form>
    </Modal>
  );
}

function RecallDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const toast = useToast();
  const d = useLoad(() => call('recalls.detail', id), [id]);
  const buyers = useLoad(() => call('recalls.buyersMessage', id), [id]);
  const [supplierId, setSupplierId] = useState('');
  const [warehouseId, setWarehouseId] = useState('');
  if (!d.data) return null;
  const { recall, lots, anonymous, returns } = d.data;
  const stock = lots.reduce((t, l) => t + l.qty, 0);
  const supplierOf = lots.find((l) => l.supplier_id)?.supplier_id ?? '';
  const giveBack = async () => {
    try {
      const r = await call('recalls.returnToSupplier', id, { supplierId: supplierId || supplierOf, warehouseId: warehouseId || lots.find((l) => l.qty > 0)!.warehouse_id });
      toast.ok(`Retour fournisseur ${r.number} préparé : imprimez-le dans Achats › Retours fournisseur`);
      d.reload();
    } catch (err) {
      toast.error(err);
    }
  };
  const close = async () => {
    const note = stock > 0 ? await askText('Il reste du stock de ce lot. Pourquoi clôturer ? (détruit, fournisseur passé…)') : (await askConfirm('Clôturer le rappel ? Le lot redeviendra vendable s’il en reste.')) ? '' : null;
    if (note === null) return;
    call('recalls.close', id, note || null).then(() => (toast.ok('Rappel clôturé'), onClose()), toast.error);
  };
  return (
    <Modal title={`Rappel : ${recall.article_name}${recall.lot_number ? ` · lot ${recall.lot_number}` : ''}`} onClose={onClose} wide>
      <p className="muted">
        {recall.reason} · saisi le {dateTime(recall.created_at)}
        {recall.user_name ? ` par ${recall.user_name}` : ''}
        {recall.status === 'closed' ? ` · clôturé le ${dateTime(recall.closed_at!)}` : ' · bloqué à la caisse'}
      </p>
      <h3>Stock du lot</h3>
      {lots.length === 0 ? (
        <p>Plus de stock de ce lot.</p>
      ) : (
        <table className="list compact">
          <thead>
            <tr>
              <th>Dépôt</th>
              <th className="r">Quantité</th>
              <th>DLC</th>
              <th>Reçu le</th>
              <th>Fournisseur</th>
            </tr>
          </thead>
          <tbody>
            {lots.map((l) => (
              <tr key={l.lot_id}>
                <td>{l.warehouse_name}</td>
                <td className="r">{qty(l.qty)}</td>
                <td>{l.expiry ? dateFr(l.expiry) : '-'}</td>
                <td>{dateFr(l.received_at.slice(0, 10))}</td>
                <td>{l.supplier_name ?? '-'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {stock > 0 && recall.status === 'open' && (
        <div className="filters">
          <SupplierSelect value={supplierId || supplierOf} onChange={setSupplierId} />
          <WarehouseSelect value={warehouseId || (lots.find((l) => l.qty > 0)?.warehouse_id ?? '')} onChange={setWarehouseId} />
          <button onClick={() => void giveBack()}>Préparer le retour au fournisseur</button>
        </div>
      )}
      {returns.length > 0 && (
        <p className="muted">
          Retours faits : {returns.map((r) => `${r.number} (${r.supplier_name}, ${fcfa(r.total)})`).join(', ')}
        </p>
      )}
      <h3>Clients qui l'ont acheté</h3>
      {(buyers.data ?? []).length === 0 ? (
        <p className="muted">Aucun client connu (fiche client, carte de fidélité ou vente à crédit).</p>
      ) : (
        <table className="list compact">
          <thead>
            <tr>
              <th>Client</th>
              <th>Téléphone</th>
              <th className="r">Quantité</th>
              <th>Dernier achat</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(buyers.data ?? []).map((b) => (
              <tr key={b.customer_id}>
                <td>{b.name}</td>
                <td>{b.phone ?? '-'}</td>
                <td className="r">{qty(b.qty)}</td>
                <td>{dateTime(b.last_at)}</td>
                <td className="r">
                  {b.whatsapp && (
                    <a className="button" href={b.whatsapp} target="_blank" rel="noreferrer">
                      Prévenir par WhatsApp
                    </a>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {anonymous.qty > 0 && (
        <p className="muted">
          Vendu aussi à des clients de passage : {qty(anonymous.qty)} sur {anonymous.tickets} ticket{anonymous.tickets > 1 ? 's' : ''}. Affichez le rappel à l'entrée du magasin.
        </p>
      )}
      <div className="actions">
        <button onClick={onClose}>Fermer</button>
        {recall.status === 'open' && (
          <button className="danger" onClick={() => void close()}>
            Clôturer le rappel
          </button>
        )}
      </div>
    </Modal>
  );
}
