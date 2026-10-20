import { useEffect, useState } from 'react';
import { type Result, call } from '../api';
import { askConfirm, Empty, Field, Modal, Tabs, dateTime, fcfa, has, parseQty, qty, today, useCan, useLoad, useToast } from '../ui';
import { ArticlePicker, WarehouseSelect } from './pickers';

type User = NonNullable<Result<'app.state'>['user']>;
type Recipe = Result<'production.recipes'>[number];
type Order = Result<'production.orders'>[number];
type Article = Result<'catalogue.get'>;

export type ProductionTab = 'orders' | 'recipes' | 'new';

const STATUS = { draft: 'Brouillon', done: 'Fabriqué', cancelled: 'Annulé' } as const;
const STATUS_TAG = { draft: 'alerte', done: 'normal', cancelled: 'rupture' } as const;
const units = (v: number) => String(v / 1000).replace('.', ',');

/**
 * Fabrication : des recettes (un
 * produit fini fait de composants) et des ordres de fabrication qui sortent
 * les composants du stock et entrent le produit fini au coût de revient.
 */
export function Production({ user, initialTab = 'orders' }: { user: User; initialTab?: ProductionTab }) {
  const [tab, setTab] = useState<ProductionTab>(initialTab === 'new' ? 'orders' : initialTab);
  const [creating, setCreating] = useState(initialTab === 'new');
  const manage = has(user, 'production_create');
  return (
    <div className="page production">
      <header className="page-head">
        <h1>Fabrication</h1>
      </header>
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          ['orders', 'Ordres de fabrication'],
          ['recipes', 'Recettes'],
        ]}
      />
      {tab === 'orders' && <Orders manage={manage} creating={creating} setCreating={setCreating} />}
      {tab === 'recipes' && <Recipes manage={has(user, 'production_recipes')} />}
    </div>
  );
}

// --- Ordres de fabrication ----------------------------------------------------------

function Orders({ manage, creating, setCreating }: { manage: boolean; creating: boolean; setCreating: (v: boolean) => void }) {
  const [status, setStatus] = useState<'' | 'draft' | 'done' | 'cancelled'>('');
  const list = useLoad(() => call('production.orders', status || null), [status]);
  const [open, setOpen] = useState<string | null>(null);
  const rows = list.data ?? [];
  return (
    <>
      <div className="filters">
        {manage && (
          <button data-new title="Ctrl+J" className="primary" onClick={() => setCreating(true)}>
            Nouvel ordre de fabrication
          </button>
        )}
        <select value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
          <option value="">Tous les statuts</option>
          <option value="draft">Brouillons</option>
          <option value="done">Fabriqués</option>
          <option value="cancelled">Annulés</option>
        </select>
        <span className="muted">Un ordre fabriqué sort les composants du stock et entre le produit fini au coût de revient.</span>
      </div>
      {rows.length === 0 ? (
        <Empty>Aucun ordre de fabrication. Créez d’abord une recette, puis un ordre.</Empty>
      ) : (
        <table className="list">
          <thead>
            <tr>
              <th>N°</th>
              <th>Date</th>
              <th>Produit fabriqué</th>
              <th className="r">Quantité</th>
              <th>Dépôt</th>
              <th>Motif</th>
              <th>Statut</th>
              <th className="r">Coût unitaire</th>
              <th className="r">Coût total</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((o) => {
              const short = o.status === 'draft' && o.components.some((c) => c.available < c.qty);
              return (
                <tr key={o.id} className="clickable" onClick={() => setOpen(o.id)}>
                  <td>{o.number}</td>
                  <td className="nowrap">{dateTime(o.created_at)}</td>
                  <td>{o.article_name}</td>
                  <td className="r">{qty(o.qty, o.unit as 'piece')}</td>
                  <td>{o.warehouse_name}</td>
                  <td>{o.label ?? ''}</td>
                  <td>
                    <span className={`tag ${STATUS_TAG[o.status]}`}>{STATUS[o.status]}</span>
                    {short && <span className="tag rupture">composants manquants</span>}
                  </td>
                  <td className="r">{o.unit_cost !== null ? fcfa(o.unit_cost) : ''}</td>
                  <td className="r">{o.total_cost !== null ? fcfa(o.total_cost) : ''}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {creating && (
        <NewOrder
          onClose={() => setCreating(false)}
          onDone={(id) => {
            setCreating(false);
            list.reload();
            setOpen(id);
          }}
        />
      )}
      {open && (
        <OrderDetail
          id={open}
          onClose={() => setOpen(null)}
          onChanged={() => {
            list.reload();
          }}
        />
      )}
    </>
  );
}

function NewOrder({ onClose, onDone }: { onClose: () => void; onDone: (id: string) => void }) {
  const toast = useToast();
  const recipes = useLoad(() => call('production.recipes'), []);
  const [recipeId, setRecipeId] = useState('');
  const [warehouseId, setWarehouseId] = useState('');
  const [amount, setAmount] = useState('');
  const [label, setLabel] = useState('');
  const [expiry, setExpiry] = useState('');
  const recipe = (recipes.data ?? []).find((r) => r.id === recipeId);
  const n = parseQty(amount);
  return (
    <Modal title="Nouvel ordre de fabrication" onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (!recipe || n === null) return toast.error('Choisissez une recette et une quantité');
          try {
            const o = await call('production.create', { recipeId: recipe.id, warehouseId, qty: n, label: label || null, expiry: expiry || null });
            toast.ok(`Ordre ${o.number} créé`);
            onDone(o.id);
          } catch (err) {
            toast.error(err);
          }
        }}
      >
        <Field label="Produit à fabriquer (recette)">
          <select autoFocus className="key" value={recipeId} onChange={(e) => setRecipeId(e.target.value)} required>
            <option value="">Choisir…</option>
            {(recipes.data ?? []).map((r) => (
              <option key={r.id} value={r.id}>
                {r.article_name} (lot de {units(r.yield_qty)})
              </option>
            ))}
          </select>
        </Field>
        <div className="grid2">
          <Field label="Quantité à fabriquer (unités)">
            <input className="key" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder={recipe ? units(recipe.yield_qty) : ''} required />
          </Field>
          <WarehouseSelect value={warehouseId} onChange={setWarehouseId} />
        </div>
        <div className="grid2">
          <Field label="Motif (facultatif)">
            <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Fête des mères, commande de M. Etoundi…" />
          </Field>
          <Field label="À consommer avant (facultatif)">
            <input type="date" value={expiry} min={today()} onChange={(e) => setExpiry(e.target.value)} />
          </Field>
        </div>
        {recipe && n !== null && (
          <table className="list compact">
            <thead>
              <tr>
                <th>Composant</th>
                <th className="r">Nécessaire</th>
              </tr>
            </thead>
            <tbody>
              {recipe.lines.map((l) => (
                <tr key={l.article_id}>
                  <td>{l.name}</td>
                  <td className="r">{qty(Math.ceil((l.qty * n) / recipe.yield_qty), l.unit as 'piece')}</td>
                </tr>
              ))}
              <tr className="total">
                <td>Coût de revient estimé</td>
                <td className="r">{fcfa(Math.round((recipe.unit_cost * n) / 1000))}</td>
              </tr>
            </tbody>
          </table>
        )}
        <div className="actions">
          <button type="button" onClick={onClose}>
            Annuler
          </button>
          <button type="submit" className="primary">
            Créer l’ordre
          </button>
        </div>
      </form>
    </Modal>
  );
}

function OrderDetail({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const toast = useToast();
  const can = useCan();
  const order = useLoad(() => call('production.order', id), [id]);
  const o: Order | undefined = order.data;
  const act = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      toast.ok(ok);
      order.reload();
      onChanged();
    } catch (e) {
      toast.error(e);
    }
  };
  if (!o) return null;
  const total = o.total_cost ?? o.components.reduce((t, c) => t + Math.round((c.qty * c.unit_cost) / 1000), 0);
  return (
    <Modal title={`Ordre de fabrication ${o.number}`} onClose={onClose} wide>
      <p>
        <b>{o.article_name}</b> · {qty(o.qty, o.unit as 'piece')} · {o.warehouse_name}
        {o.label ? ` · ${o.label}` : ''} · <span className={`tag ${STATUS_TAG[o.status]}`}>{STATUS[o.status]}</span>
      </p>
      <table className="list compact">
        <thead>
          <tr>
            <th>Composant</th>
            <th className="r">{o.status === 'done' ? 'Sorti' : 'Nécessaire'}</th>
            {o.status === 'draft' && <th className="r">En stock</th>}
            <th className="r">CMUP</th>
            <th className="r">Valeur</th>
          </tr>
        </thead>
        <tbody>
          {o.components.map((c) => (
            <tr key={c.article_id} className={o.status === 'draft' && c.available < c.qty ? 'short' : ''}>
              <td>{c.name}</td>
              <td className="r">{qty(c.qty, c.unit as 'piece')}</td>
              {o.status === 'draft' && <td className={`r ${c.available < c.qty ? 'neg' : ''}`}>{qty(c.available, c.unit as 'piece')}</td>}
              <td className="r">{fcfa(c.unit_cost)}</td>
              <td className="r">{fcfa(Math.round((c.qty * c.unit_cost) / 1000))}</td>
            </tr>
          ))}
          <tr className="total">
            <td colSpan={o.status === 'draft' ? 4 : 3}>Coût de revient total{o.status === 'draft' ? ' (estimé)' : ''}</td>
            <td className="r">{fcfa(total)}</td>
          </tr>
          <tr className="total">
            <td colSpan={o.status === 'draft' ? 4 : 3}>Coût de revient unitaire</td>
            <td className="r">{fcfa(o.unit_cost ?? Math.round((total * 1000) / o.qty))}</td>
          </tr>
        </tbody>
      </table>
      <p className="muted">
        Créé le {dateTime(o.created_at)} par {o.created_by_name}
        {o.done_at ? ` · fabriqué le ${dateTime(o.done_at)} par ${o.done_by_name ?? ''}` : ''}
      </p>
      <div className="actions">
        <button onClick={() => call('production.print', o.id).catch(toast.error)}>Imprimer</button>
        {can('production_cancel') && o.status === 'draft' && (
          <button className="danger" onClick={async () => (await askConfirm('Annuler cet ordre de fabrication ?')) && act(() => call('production.cancel', o.id), 'Ordre annulé')}>
            Annuler l’ordre
          </button>
        )}
        {can('production_validate') && o.status === 'draft' && (
          <button className="primary" onClick={() => act(() => call('production.produce', o.id), 'Fabrication enregistrée : stock mis à jour')}>
            Fabriquer
          </button>
        )}
      </div>
    </Modal>
  );
}

// --- Recettes -------------------------------------------------------------------------

function Recipes({ manage }: { manage: boolean }) {
  const list = useLoad(() => call('production.recipes'), []);
  const [editing, setEditing] = useState<Recipe | 'new' | null>(null);
  const rows = list.data ?? [];
  return (
    <>
      <div className="filters">
        {manage && (
          <button data-new title="Ctrl+J" className="primary" onClick={() => setEditing('new')}>
            Nouvelle recette
          </button>
        )}
        <span className="muted">Le coût de revient est calculé au CMUP actuel des composants.</span>
      </div>
      {rows.length === 0 ? (
        <Empty>Aucune recette. Exemple : un panier garni fait de riz, d’huile et de sucre.</Empty>
      ) : (
        <table className="list">
          <thead>
            <tr>
              <th>Produit fini</th>
              <th className="r">Lot</th>
              <th>Composants</th>
              <th className="r">Coût de revient</th>
              <th className="r">Prix de vente</th>
              <th className="r">Marge</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="clickable" onClick={() => setEditing(r)}>
                <td>
                  {r.article_name} <small className="muted">{r.article_code}</small>
                </td>
                <td className="r">{qty(r.yield_qty, r.unit as 'piece')}</td>
                <td>{r.lines.map((l) => `${units(l.qty)} × ${l.name}`).join(', ')}</td>
                <td className="r">{fcfa(r.unit_cost)}</td>
                <td className="r">{fcfa(r.sale_price)}</td>
                <td className={`r ${r.sale_price < r.unit_cost ? 'neg' : 'pos'}`}>
                  {fcfa(r.sale_price - r.unit_cost)}
                  {r.sale_price > 0 && <small className="muted"> ({Math.round(((r.sale_price - r.unit_cost) / r.sale_price) * 100)} %)</small>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {editing && (
        <RecipeEditor
          recipe={editing === 'new' ? null : editing}
          manage={manage}
          onClose={() => setEditing(null)}
          onDone={() => {
            setEditing(null);
            list.reload();
          }}
        />
      )}
    </>
  );
}

interface Line {
  articleId: string;
  name: string;
  unit: string;
  qty: string;
}

function RecipeEditor({ recipe, manage, onClose, onDone }: { recipe: Recipe | null; manage: boolean; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [product, setProduct] = useState<{ id: string; name: string } | null>(recipe ? { id: recipe.article_id, name: recipe.article_name } : null);
  const [yieldQty, setYieldQty] = useState(recipe ? units(recipe.yield_qty) : '1');
  const [notes, setNotes] = useState(recipe?.notes ?? '');
  const [lines, setLines] = useState<Line[]>([]);
  useEffect(() => setLines((recipe?.lines ?? []).map((l) => ({ articleId: l.article_id, name: l.name, unit: l.unit, qty: units(l.qty) }))), [recipe]);
  const addLine = (a: Article) => {
    if (lines.some((l) => l.articleId === a.id)) return toast.error('Ce composant est déjà dans la recette');
    setLines((ls) => [...ls, { articleId: a.id, name: a.name, unit: a.unit, qty: '1' }]);
  };
  const save = async () => {
    const y = parseQty(yieldQty);
    if (!product || y === null) return toast.error('Choisissez le produit fini et la quantité produite');
    const out = [];
    for (const l of lines) {
      const q = parseQty(l.qty);
      if (q === null) return toast.error(`Quantité invalide pour ${l.name}`);
      out.push({ articleId: l.articleId, qty: q });
    }
    try {
      await call('production.saveRecipe', { articleId: product.id, yieldQty: y, notes: notes || null, lines: out }, recipe?.id ?? null);
      toast.ok('Recette enregistrée');
      onDone();
    } catch (e) {
      toast.error(e);
    }
  };
  return (
    <Modal title={recipe ? `Recette : ${recipe.article_name}` : 'Nouvelle recette'} onClose={onClose} wide>
      <div className="grid2">
        <Field label="Produit fini">
          {product ? (
            <button className="mon-chosen" disabled={!manage} onClick={() => setProduct(null)}>
              {product.name} <small>✕</small>
            </button>
          ) : (
            <ArticlePicker placeholder="Produit fabriqué : taper le début du nom" onPick={(a) => setProduct({ id: a.id, name: a.name })} />
          )}
        </Field>
        <Field label="Quantité obtenue par lot (unités)">
          <input className="key" disabled={!manage} value={yieldQty} onChange={(e) => setYieldQty(e.target.value)} />
        </Field>
      </div>
      <h3 className="section">Composants pour un lot</h3>
      <table className="list compact">
        <thead>
          <tr>
            <th>Composant</th>
            <th className="r">Quantité</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {lines.map((l, i) => (
            <tr key={l.articleId}>
              <td>{l.name}</td>
              <td className="r">
                <input
                  className="key num"
                  disabled={!manage}
                  value={l.qty}
                  onChange={(e) => setLines((ls) => ls.map((x, j) => (j === i ? { ...x, qty: e.target.value } : x)))}
                />
              </td>
              <td>
                {manage && (
                  <button className="ghost" title="Retirer" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>
                    ✕
                  </button>
                )}
              </td>
            </tr>
          ))}
          {lines.length === 0 && (
            <tr>
              <td colSpan={3} className="muted">
                Ajoutez les composants avec la recherche ci-dessous.
              </td>
            </tr>
          )}
        </tbody>
      </table>
      {manage && <ArticlePicker placeholder="Ajouter un composant : scanner ou taper le début du nom" onPick={addLine} />}
      <Field label="Notes (préparation, conditionnement…)">
        <input disabled={!manage} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </Field>
      {manage && (
        <div className="actions">
          {recipe && (
            <button
              className="danger"
              onClick={async () => {
                if (!(await askConfirm('Archiver cette recette ?'))) return;
                await call('production.archiveRecipe', recipe.id).then(onDone, toast.error);
              }}
            >
              Archiver
            </button>
          )}
          <button onClick={onClose}>Annuler</button>
          <button className="primary" onClick={save}>
            Enregistrer la recette
          </button>
        </div>
      )}
    </Modal>
  );
}
