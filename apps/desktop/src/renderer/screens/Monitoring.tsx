import { useState } from 'react';
import { describeInPacks } from '@superette/core';
import { type Result, call } from '../api';
import { Empty, Field, Modal, dateTime, has, parseQty, qty, today, useLoad, useToast } from '../ui';
import { ArticlePicker } from './pickers';
import { qtyText } from './packs';

type User = NonNullable<Result<'app.state'>['user']>;
type Article = Result<'catalogue.get'>;
type Request = Result<'monitoring.requests'>[number];

const REQUEST_STATUS = { pending: 'En attente', approved: 'Validée', rejected: 'Refusée' } as const;
const REQUEST_TAG = { pending: 'alerte', approved: 'normal', rejected: 'rupture' } as const;

/** Début et fin de journée locale au format ISO, pour les bornes de la période. */
const startOf = (d: string) => new Date(`${d}T00:00:00`).toISOString();
const endOf = (d: string) => new Date(`${d}T23:59:59.999`).toISOString();

/**
 * Monitoring de l'évolution du stock d'un produit, comme dans KONTROL :
 * les demandes de modification (validées par le gérant) et les
 * modifications effectives avec le stock avant et après.
 */
export function Monitoring({ user }: { user: User }) {
  const warehouses = useLoad(() => call('admin.warehouses'), []);
  const [article, setArticle] = useState<Article | null>(null);
  const [from, setFrom] = useState(() => `${today().slice(0, 8)}01`);
  const [to, setTo] = useState(today);
  const [warehouseId, setWarehouseId] = useState('');
  const [nonce, setNonce] = useState(0);
  const [asking, setAsking] = useState(false);
  const canDecide = has(user, 'inventory');
  const canAsk = canDecide || has(user, 'inventory_count');
  const changes = useLoad(
    () => (article ? call('monitoring.changes', article.id, warehouseId || null, startOf(from), endOf(to)) : Promise.resolve(null)),
    [article?.id, warehouseId, from, to, nonce],
  );
  const requests = useLoad(
    () => (canAsk ? call('monitoring.requests', article ? { articleId: article.id, from: startOf(from), to: endOf(to) } : { status: 'pending' }) : Promise.resolve([])),
    [article?.id, from, to, nonce, canAsk],
  );
  const refresh = () => setNonce((n) => n + 1);
  const rows = changes.data?.rows ?? [];
  const inQty = rows.filter((r) => r.delta > 0).reduce((t, r) => t + r.delta, 0);
  const outQty = rows.filter((r) => r.delta < 0).reduce((t, r) => t - r.delta, 0);
  const packs = (q: number) => (article && article.packs.length ? describeInPacks(Math.abs(q), article.packs, article.unit_name || 'Pièce') : '');

  return (
    <div className="monitoring">
      <div className="mon-head">
        <div className="mon-product">
          <span>Produit</span>
          {article ? (
            <button className="mon-chosen" onClick={() => setArticle(null)} title="Choisir un autre produit">
              {article.name} <small>✕</small>
            </button>
          ) : (
            <ArticlePicker placeholder="Scanner ou taper le début du nom" onPick={setArticle} />
          )}
        </div>
        <Field label="Début">
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        <Field label="Fin">
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </Field>
        <Field label="Dépôt">
          <select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
            <option value="">Tous les dépôts</option>
            {(warehouses.data ?? []).map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </Field>
        <button className="primary" onClick={refresh}>
          Actualiser
        </button>
      </div>

      {article && changes.data && (
        <div className="kpis">
          <div>
            <small>Stock au {new Date(`${from}T12:00:00`).toLocaleDateString('fr-FR')}</small>
            <strong>{qty(changes.data.opening, article.unit)}</strong>
          </div>
          <div>
            <small>Entrées</small>
            <strong className="pos">+{qty(inQty, article.unit)}</strong>
          </div>
          <div>
            <small>Sorties</small>
            <strong className="neg">−{qty(outQty, article.unit)}</strong>
          </div>
          <div>
            <small>Stock au {new Date(`${to}T12:00:00`).toLocaleDateString('fr-FR')}</small>
            <strong>{qty(changes.data.closing, article.unit)}</strong>
            {packs(changes.data.closing) && <small>{packs(changes.data.closing)}</small>}
          </div>
        </div>
      )}

      {canAsk && (
        <section className="mon-section">
          <div className="mon-title">
            <h3>{article ? 'Demandes de modification' : 'Demandes de modification en attente (tous produits)'}</h3>
            {article && (
              <button onClick={() => setAsking(true)}>{canDecide ? 'Corriger le stock…' : 'Demander une correction…'}</button>
            )}
          </div>
          <RequestTable rows={requests.data ?? []} canDecide={canDecide} showArticle={!article} onChanged={refresh} />
        </section>
      )}

      {article ? (
        <section className="mon-section">
          <div className="mon-title">
            <h3>Modifications effectives</h3>
          </div>
          {rows.length === 0 ? (
            <Empty>Aucun mouvement sur cette période.</Empty>
          ) : (
            <div className="mon-scroll">
              <table className="list compact">
                <thead>
                  <tr>
                    <th>Date</th>
                    {!warehouseId && <th>Dépôt</th>}
                    <th>Type</th>
                    <th>Motif ou pièce</th>
                    <th className="r">Avant</th>
                    <th className="r">Après</th>
                    <th className="r">Delta</th>
                    <th>Conditionnement</th>
                    <th>Login</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} className={r.delta < 0 ? 'mon-out' : 'mon-in'}>
                      <td className="nowrap">{dateTime(r.at)}</td>
                      {!warehouseId && <td>{r.warehouse_name}</td>}
                      <td>{r.type_label}</td>
                      <td>{r.reason ?? ''}</td>
                      <td className="r">{qty(r.before, article.unit)}</td>
                      <td className="r">{qty(r.after, article.unit)}</td>
                      <td className={`r ${r.delta < 0 ? 'neg' : 'pos'}`}>
                        {r.delta > 0 ? '+' : ''}
                        {qty(r.delta, article.unit)}
                      </td>
                      <td className="muted">{packs(r.delta)}</td>
                      <td>{r.user_name ?? ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ) : (
        <Empty>Choisissez un produit pour voir l'évolution de son stock.</Empty>
      )}

      {asking && article && (
        <RequestDialog
          article={article}
          warehouses={warehouses.data ?? []}
          defaultWarehouse={warehouseId}
          direct={canDecide}
          onClose={() => setAsking(false)}
          onDone={() => {
            setAsking(false);
            refresh();
          }}
        />
      )}
    </div>
  );
}

function RequestTable({ rows, canDecide, showArticle, onChanged }: { rows: Request[]; canDecide: boolean; showArticle: boolean; onChanged: () => void }) {
  const toast = useToast();
  if (!rows.length) return <p className="muted">Aucune demande.</p>;
  return (
    <table className="list compact">
      <thead>
        <tr>
          <th>N°</th>
          <th>Date</th>
          {showArticle && <th>Produit</th>}
          <th>Dépôt</th>
          <th className="r">Avant</th>
          <th className="r">Demandé</th>
          <th className="r">Delta</th>
          <th>Motif</th>
          <th>Demandé par</th>
          <th>Statut</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id}>
            <td>{r.number}</td>
            <td className="nowrap">{dateTime(r.requested_at)}</td>
            {showArticle && <td>{r.article_name}</td>}
            <td>{r.warehouse_name}</td>
            <td className="r">{qty(r.before_qty, r.unit)}</td>
            <td className="r">{qty(r.requested_qty, r.unit)}</td>
            <td className={`r ${r.delta < 0 ? 'neg' : 'pos'}`}>
              {r.delta > 0 ? '+' : ''}
              {qty(r.delta, r.unit)}
            </td>
            <td>{r.reason}</td>
            <td>{r.requested_by_name}</td>
            <td>
              <span className={`tag ${REQUEST_TAG[r.status]}`}>{REQUEST_STATUS[r.status]}</span>
              {r.decided_by_name && (
                <small className="muted block">
                  {r.decided_by_name}
                  {r.decision_note ? ` : ${r.decision_note}` : ''}
                </small>
              )}
            </td>
            <td className="nowrap">
              {canDecide && r.status === 'pending' && (
                <>
                  <button
                    className="primary"
                    onClick={() => call('monitoring.decide', r.id, true, null).then(() => (toast.ok('Correction appliquée au stock'), onChanged()), toast.error)}
                  >
                    Valider
                  </button>{' '}
                  <button
                    onClick={() => {
                      const note = prompt('Motif du refus');
                      if (note) void call('monitoring.decide', r.id, false, note).then(() => (toast.ok('Demande refusée'), onChanged()), toast.error);
                    }}
                  >
                    Refuser
                  </button>
                </>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function RequestDialog({
  article,
  warehouses,
  defaultWarehouse,
  direct,
  onClose,
  onDone,
}: {
  article: Article;
  warehouses: { id: string; name: string; is_sales_default: number }[];
  defaultWarehouse: string;
  direct: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const toast = useToast();
  const [warehouseId, setWarehouseId] = useState(defaultWarehouse || warehouses.find((w) => w.is_sales_default)?.id || warehouses[0]?.id || '');
  const [value, setValue] = useState('');
  const [reason, setReason] = useState('');
  const stock = useLoad(() => (warehouseId ? call('stock.list', { warehouseId, search: article.code }) : Promise.resolve([])), [warehouseId]);
  const current = stock.data?.find((r) => r.article_id === article.id)?.qty ?? 0;
  const n = parseQty(value);
  return (
    <Modal title={direct ? `Corriger le stock : ${article.name}` : `Demander une correction : ${article.name}`} onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (n === null) return toast.error('Quantité invalide');
          try {
            const r = await call('monitoring.request', { articleId: article.id, warehouseId, newQty: n, reason });
            toast.ok(r.status === 'approved' ? 'Stock corrigé' : 'Demande envoyée au gérant');
            onDone();
          } catch (err) {
            toast.error(err);
          }
        }}
      >
        <div className="grid2">
          <Field label="Dépôt">
            <select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
              {warehouses.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Stock en machine">
            <input readOnly value={qtyText(current)} />
          </Field>
        </div>
        <div className="grid2">
          <Field label="Stock réel (unités)">
            <input autoFocus className="key" value={value} onChange={(e) => setValue(e.target.value)} required />
          </Field>
          <Field label="Delta">
            <input readOnly value={n === null ? '' : `${n - current > 0 ? '+' : ''}${qtyText(n - current)}`} className={n !== null && n - current < 0 ? 'gap' : ''} />
          </Field>
        </div>
        <Field label="Motif">
          <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Casse non déclarée, erreur de réception…" required />
        </Field>
        <p className="muted">{direct ? 'Le stock est corrigé tout de suite.' : 'Le stock ne bouge qu’après la validation du gérant.'}</p>
        <div className="actions">
          <button type="button" onClick={onClose}>
            Annuler
          </button>
          <button type="submit" className="primary">
            {direct ? 'Corriger le stock' : 'Envoyer la demande'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
