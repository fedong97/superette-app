import { useState } from 'react';
import { type Result, call } from '../api';
import { Empty, Field, Modal, dateTime, fcfa, parseQty, qty, useLoad, useToast } from '../ui';
import { ArticlePicker } from './pickers';
import { qtyText } from './packs';

type Transfer = Result<'transfers.list'>[number];
type Status = Transfer['status'];
type Article = Result<'catalogue.get'>;

const STATUS: Record<Status, string> = { draft: 'Brouillon', shipped: 'Expédié', received: 'Réceptionné', cancelled: 'Annulé' };
const STATUS_TAG: Record<Status, string> = { draft: '', shipped: 'alerte', received: 'normal', cancelled: 'rupture' };

/** Ligne en cours de saisie : quantité en unités de détail, conditionnement d'affichage. */
interface Draft {
  articleId: string;
  code: string;
  name: string;
  unit: 'piece' | 'kg' | 'litre';
  packs: { position: number; name: string; units: number }[];
  unitName: string;
  qty: number;
  packPosition: number;
  fromStock: number | null;
  unitCost: number;
  receivedQty: number | null;
}

/**
 * Transferts entre dépôts, sur le modèle de la fiche « Détails du transfert
 * de marchandises » de KONTROL : liste des bons, puis le bon avec ses
 * statuts (brouillon, expédié, réceptionné).
 */
export function Transfers() {
  const [openId, setOpenId] = useState<string | 'new' | null>(null);
  return openId ? <TransferForm id={openId === 'new' ? null : openId} onBack={() => setOpenId(null)} onOpen={setOpenId} /> : <TransferList onOpen={setOpenId} />;
}

function TransferList({ onOpen }: { onOpen: (id: string | 'new') => void }) {
  const [status, setStatus] = useState<Status | ''>('');
  const list = useLoad(() => call('transfers.list', status || null), [status]);
  return (
    <div>
      <div className="filters">
        <button className="primary" onClick={() => onOpen('new')}>
          Nouveau transfert
        </button>
        <select value={status} onChange={(e) => setStatus(e.target.value as Status | '')}>
          <option value="">Tous les statuts</option>
          {(Object.keys(STATUS) as Status[]).map((k) => (
            <option key={k} value={k}>
              {STATUS[k]}
            </option>
          ))}
        </select>
        <span className="muted">Un transfert expédié n'est plus dans le dépôt de départ ; il entre dans le dépôt d'arrivée à la réception.</span>
      </div>
      {list.data?.length === 0 ? (
        <Empty>Aucun transfert.</Empty>
      ) : (
        <table className="list">
          <thead>
            <tr>
              <th>N°</th>
              <th>Date</th>
              <th>Départ</th>
              <th>Destination</th>
              <th>Motif</th>
              <th>Statut</th>
              <th className="r">Produits</th>
              <th className="r">Valeur</th>
              <th>B. route</th>
              <th>B. réception</th>
              <th>Imprimé le</th>
            </tr>
          </thead>
          <tbody>
            {(list.data ?? []).map((t) => (
              <tr key={t.id} className="clickable" onClick={() => onOpen(t.id)}>
                <td>{t.number}</td>
                <td>{dateTime(t.created_at)}</td>
                <td>{t.from_name}</td>
                <td>{t.to_name}</td>
                <td>{t.label ?? ''}</td>
                <td>
                  <span className={`tag ${STATUS_TAG[t.status]}`}>{STATUS[t.status]}</span>
                  {t.status === 'received' && t.gap_value !== 0 && <span className="tag rupture">écart {fcfa(t.gap_value)}</span>}
                </td>
                <td className="r">{t.line_count}</td>
                <td className="r">{fcfa(t.value)}</td>
                <td>{t.route_number ?? ''}</td>
                <td>{t.reception_number ?? ''}</td>
                <td>{t.printed_at ? dateTime(t.printed_at) : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function TransferForm({ id, onBack, onOpen }: { id: string | null; onBack: () => void; onOpen: (id: string | 'new') => void }) {
  const toast = useToast();
  const warehouses = useLoad(() => call('admin.warehouses'), []);
  const [loadedId, setLoadedId] = useState<string | null>(null);
  const [transfer, setTransfer] = useState<Transfer | null>(null);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [label, setLabel] = useState('');
  const [route, setRoute] = useState('');
  const [reception, setReception] = useState('');
  const [lines, setLines] = useState<Draft[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [pending, setPending] = useState<{ article: Article; units: number; qty: string } | null>(null);
  const [moves, setMoves] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = async (tid: string) => {
    const d = await call('transfers.get', tid);
    setTransfer(d.transfer);
    setFrom(d.transfer.from_warehouse_id);
    setTo(d.transfer.to_warehouse_id);
    setLabel(d.transfer.label ?? '');
    setRoute(d.transfer.route_number ?? '');
    setReception(d.transfer.reception_number ?? '');
    setLines(
      d.lines.map((l) => ({
        articleId: l.article_id,
        code: l.code,
        name: l.name,
        unit: l.unit,
        packs: l.packs,
        unitName: l.unit_name || 'Pièce',
        qty: l.qty,
        packPosition: l.pack_position,
        fromStock: l.from_stock,
        unitCost: l.unit_cost,
        receivedQty: l.received_qty ?? (d.transfer.status === 'shipped' ? l.qty : null),
      })),
    );
    setLoadedId(tid);
  };
  if (id && loadedId !== id) {
    setLoadedId(id);
    void load(id).catch(toast.error);
  }
  // Dépôts par défaut : de la réserve vers la surface de vente.
  if (!id && !from && warehouses.data?.length) {
    const shop = warehouses.data.find((w) => w.is_sales_default) ?? warehouses.data[0]!;
    const other = warehouses.data.find((w) => w.id !== shop.id);
    setFrom(other?.id ?? shop.id);
    setTo(shop.id);
  }

  const status: Status = transfer?.status ?? 'draft';
  const editable = status === 'draft';
  const total = lines.reduce((t, l) => t + Math.round((l.qty * l.unitCost) / 1000), 0);
  const input = () => ({
    fromWarehouseId: from,
    toWarehouseId: to,
    label: label || null,
    routeNumber: route || null,
    lines: lines.map((l) => ({ articleId: l.articleId, qty: l.qty, packPosition: l.packPosition })),
  });
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try {
      await fn();
      toast.ok(ok);
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };
  const save = async (): Promise<string> => {
    const t = transfer ? await call('transfers.update', transfer.id, input()) : await call('transfers.create', input());
    await load(t.id);
    return t.id;
  };

  const choose = async (a: Article) => {
    if (lines.some((l) => l.articleId === a.id)) return toast.error(`${a.name} est déjà dans le transfert`);
    setPending({ article: a, units: a.unit === 'piece' && a.packs[0] ? a.packs[0].units : 1000, qty: '' });
  };
  const addPending = async () => {
    if (!pending) return;
    const n = parseQty(pending.qty);
    if (n === null || n <= 0) return toast.error('Quantité invalide');
    const a = pending.article;
    const stock = from ? await call('stock.list', { warehouseId: from, search: a.code }).catch(() => []) : [];
    const row = stock.find((r) => r.article_id === a.id);
    const pack = a.packs.find((p) => p.units === pending.units);
    setLines([
      ...lines,
      {
        articleId: a.id,
        code: a.code,
        name: a.name,
        unit: a.unit,
        packs: a.packs.map((p) => ({ position: p.position, name: p.name, units: p.units })),
        unitName: a.unit_name || 'Pièce',
        qty: Math.round((n * pending.units) / 1000),
        packPosition: pack?.position ?? 0,
        fromStock: row?.qty ?? 0,
        unitCost: row?.avg_cost ?? a.purchase_price,
        receivedQty: null,
      },
    ]);
    setPending(null);
  };
  const packLabel = (l: Draft) => {
    const p = l.packs.find((x) => x.position === l.packPosition);
    if (p && l.qty % p.units === 0) return `${qtyText(l.qty / p.units * 1000)} ${p.name}`;
    return l.unit === 'piece' ? `${qtyText(l.qty)} ${l.unitName}` : '';
  };

  return (
    <div className="transfer">
      <div className="transfer-body">
        <div className="transfer-main">
          <div className="transfer-head">
            <Field label="Transfert n°">
              <input readOnly value={transfer?.number ?? 'Nouveau'} />
            </Field>
            <Field label="Statut">
              <input readOnly className={`status-${status}`} value={STATUS[status]} />
            </Field>
            <Field label="B. route">
              <input value={route} onChange={(e) => setRoute(e.target.value)} disabled={status !== 'draft'} placeholder="N° du bon de route" />
            </Field>
            <Field label="Date">
              <input readOnly value={transfer ? dateTime(transfer.created_at) : dateTime(new Date().toISOString())} />
            </Field>
            <Field label="Impr. le">
              <input readOnly value={transfer?.printed_at ? dateTime(transfer.printed_at) : ''} />
            </Field>
            <Field label="B. réception">
              <input value={reception} onChange={(e) => setReception(e.target.value)} disabled={status !== 'shipped'} placeholder={status === 'shipped' ? 'N° du bon de réception' : ''} />
            </Field>
          </div>
          <h3 className="section">Dépôts</h3>
          <div className="transfer-wh">
            <Field label="Départ">
              <select value={from} disabled={!editable} onChange={(e) => setFrom(e.target.value)}>
                {(warehouses.data ?? []).map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Destination">
              <select value={to} disabled={!editable} onChange={(e) => setTo(e.target.value)}>
                {(warehouses.data ?? []).map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Motif (facultatif)">
              <input value={label} disabled={!editable} onChange={(e) => setLabel(e.target.value)} placeholder="Réassort du rayon, retour en réserve…" />
            </Field>
            <button disabled={!transfer} onClick={() => setMoves(true)}>
              Mouvements des marchandises
            </button>
          </div>
          <h3 className="section">Marchandises transférées</h3>
          {editable && (
            <div className="transfer-add">
              {pending ? (
                <form
                  className="inline"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void addPending();
                  }}
                >
                  <b>{pending.article.name}</b>
                  {pending.article.unit === 'piece' && pending.article.packs.length > 0 && (
                    <label className="inline">
                      Cond.
                      <select value={pending.units} onChange={(e) => setPending({ ...pending, units: Number(e.target.value) })}>
                        {[...pending.article.packs.map((p) => ({ name: `${p.name} (${qtyText(p.units)})`, units: p.units })), { name: pending.article.unit_name || 'Pièce', units: 1000 }].map((c) => (
                          <option key={c.units} value={c.units}>
                            {c.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  <label className="inline">
                    Qté
                    <input autoFocus className="qty key" value={pending.qty} onChange={(e) => setPending({ ...pending, qty: e.target.value })} />
                  </label>
                  <button type="submit" className="primary">
                    Ajouter
                  </button>
                  <button type="button" onClick={() => setPending(null)}>
                    ✕
                  </button>
                </form>
              ) : (
                <ArticlePicker placeholder="Produit : scanner ou taper le début du nom" onPick={(a) => void choose(a)} />
              )}
            </div>
          )}
          <div className="transfer-grid">
            <table className="list compact">
              <thead>
                <tr>
                  <th>Réf.</th>
                  <th>Produit</th>
                  {editable && <th className="r">Stock départ</th>}
                  <th className="r">Qté</th>
                  <th>Conditionnement</th>
                  {(status === 'shipped' || status === 'received') && <th className="r">Reçu</th>}
                  {status === 'received' && <th className="r">Écart</th>}
                  <th className="r">CMUP</th>
                  <th className="r">Valeur</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l, i) => {
                  const gap = l.receivedQty === null ? 0 : l.receivedQty - l.qty;
                  return (
                    <tr key={l.articleId} className={`${selected === i ? 'selected' : ''} ${status === 'received' && gap ? 'gap-row' : ''}`} onClick={() => setSelected(i)}>
                      <td>{l.code}</td>
                      <td>{l.name}</td>
                      {editable && <td className={`r ${l.fromStock !== null && l.fromStock < l.qty ? 'neg' : ''}`}>{l.fromStock === null ? '' : qty(l.fromStock, l.unit)}</td>}
                      <td className="r">{qty(l.qty, l.unit)}</td>
                      <td>{packLabel(l)}</td>
                      {status === 'shipped' && (
                        <td className="r">
                          <input
                            className="qty key"
                            value={l.receivedQty === null ? '' : qtyText(l.receivedQty)}
                            onChange={(e) => {
                              const n = parseQty(e.target.value);
                              setLines(lines.map((x, j) => (j === i ? { ...x, receivedQty: n ?? 0 } : x)));
                            }}
                          />
                        </td>
                      )}
                      {status === 'received' && <td className="r">{qty(l.receivedQty ?? 0, l.unit)}</td>}
                      {status === 'received' && <td className={`r ${gap < 0 ? 'neg' : gap > 0 ? 'pos' : ''}`}>{gap ? qty(gap, l.unit) : ''}</td>}
                      <td className="r">{fcfa(l.unitCost)}</td>
                      <td className="r">{fcfa(Math.round((l.qty * l.unitCost) / 1000))}</td>
                    </tr>
                  );
                })}
                {!lines.length && (
                  <tr>
                    <td colSpan={9} className="muted">
                      Ajoutez les produits à transférer.
                    </td>
                  </tr>
                )}
              </tbody>
              <tfoot>
                <tr>
                  <th colSpan={editable ? 6 : status === 'received' ? 7 : status === 'shipped' ? 6 : 5}>Somme · {lines.length} produit(s)</th>
                  <th className="r">{fcfa(total)}</th>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
        <aside className="transfer-actions">
          <button onClick={() => onOpen('new')} disabled={!transfer}>
            Nouveau transfert
          </button>
          {editable && (
            <button disabled={busy || !lines.length || from === to} onClick={() => void run(save, 'Transfert enregistré (brouillon)')}>
              Enregistrer
            </button>
          )}
          {editable && (
            <button
              className="main"
              disabled={busy || !lines.length || from === to}
              onClick={() =>
                void run(async () => {
                  const tid = await save();
                  await call('transfers.ship', tid, route || null);
                  await call('transfers.print', tid).catch(() => undefined);
                  await load(tid);
                }, 'Transfert expédié : le stock a quitté le dépôt de départ')
              }
            >
              Expédier
            </button>
          )}
          {status === 'shipped' && (
            <button
              className="main"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await call('transfers.receive', transfer!.id, {
                    receptionNumber: reception || null,
                    lines: lines.map((l) => ({ articleId: l.articleId, receivedQty: l.receivedQty ?? l.qty })),
                  });
                  await call('transfers.print', transfer!.id).catch(() => undefined);
                  await load(transfer!.id);
                }, 'Transfert réceptionné : le stock est entré dans le dépôt d’arrivée')
              }
            >
              Réceptionner
            </button>
          )}
          <hr />
          <button
            disabled={!transfer}
            onClick={() =>
              void run(async () => {
                await call('transfers.print', transfer!.id);
                await load(transfer!.id);
              }, 'Bon imprimé')
            }
          >
            Imprimer
          </button>
          {editable && (
            <button disabled={selected === null} onClick={() => (setLines(lines.filter((_, j) => j !== selected)), setSelected(null))}>
              Enlever une ligne
            </button>
          )}
          {(status === 'draft' || status === 'shipped') && transfer && (
            <button
              className="danger"
              disabled={busy}
              onClick={() => {
                if (!confirm(status === 'shipped' ? 'Annuler ce transfert ? La marchandise revient dans le dépôt de départ.' : 'Annuler ce brouillon ?')) return;
                void run(async () => {
                  await call('transfers.cancel', transfer.id);
                  await load(transfer.id);
                }, 'Transfert annulé');
              }}
            >
              Annuler le transfert
            </button>
          )}
          <button className="close" onClick={onBack}>
            Fermer
          </button>
        </aside>
      </div>
      {moves && transfer && <TransferMoves id={transfer.id} number={transfer.number} onClose={() => setMoves(false)} />}
    </div>
  );
}

function TransferMoves({ id, number, onClose }: { id: string; number: number; onClose: () => void }) {
  const moves = useLoad(() => call('transfers.movements', id), [id]);
  return (
    <Modal title={`Mouvements des marchandises · transfert n° ${number}`} onClose={onClose} wide>
      {moves.data?.length === 0 ? (
        <Empty>Aucun mouvement : le transfert n'est pas encore expédié.</Empty>
      ) : (
        <table className="list compact">
          <thead>
            <tr>
              <th>Date</th>
              <th>Dépôt</th>
              <th>Produit</th>
              <th className="r">Quantité</th>
              <th>Motif</th>
              <th>Par</th>
            </tr>
          </thead>
          <tbody>
            {(moves.data ?? []).map((m, i) => (
              <tr key={i}>
                <td>{dateTime(m.at)}</td>
                <td>{m.warehouse_name}</td>
                <td>{m.article_name}</td>
                <td className={`r ${m.qty < 0 ? 'neg' : 'pos'}`}>{qty(m.qty, m.unit)}</td>
                <td>{m.reason ?? ''}</td>
                <td>{m.user_name ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Modal>
  );
}
