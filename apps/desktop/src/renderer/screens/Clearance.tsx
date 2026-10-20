import { useState } from 'react';
import type { MovementType } from '@superette/core';
import { type Result, call } from '../api';
import { Empty, Field, dateFr, fcfa, parseAmount, qty, today, useLoad, useToast } from '../ui';
import { WarehouseSelect } from './pickers';

type Candidate = Result<'clearance.candidates'>[number];

/**
 * Déstockage avant péremption : les produits dont un lot périme bientôt, avec
 * la remise proposée par les paliers du magasin ; les promotions se créent en
 * un clic.
 */
export function Clearance() {
  const toast = useToast();
  const list = useLoad(() => call('clearance.candidates'));
  const [edits, setEdits] = useState<Record<string, { pct?: string; price?: string; on?: boolean }>>({});
  const [busy, setBusy] = useState(false);
  const rows = (list.data ?? []).map((r) => {
    const e = edits[r.article_id] ?? {};
    const price = e.price ?? String(r.promo_price);
    const promo = parseAmount(price) ?? 0;
    return { ...r, pctText: e.pct ?? String(r.pct), priceText: price, promo, on: e.on ?? !r.running_promo, belowCost: promo > 0 && promo < r.unit_cost };
  });
  const set = (r: Candidate, patch: { pct?: string; price?: string; on?: boolean }) => setEdits((e) => ({ ...e, [r.article_id]: { ...e[r.article_id], ...patch } }));
  // Changer le pourcentage recalcule le prix (arrondi à 5 F), et inversement.
  const setPct = (r: Candidate, text: string) => {
    const pct = Number(text.replace(',', '.'));
    const price = Number.isFinite(pct) && pct > 0 && pct < 100 ? String(Math.max(1, Math.round((r.price * (100 - pct)) / 100 / 5) * 5)) : undefined;
    set(r, { pct: text, ...(price ? { price } : {}) });
  };
  const setPrice = (r: Candidate, text: string) => {
    const p = parseAmount(text);
    set(r, { price: text, ...(p && r.price ? { pct: String(Math.round((1 - p / r.price) * 100)) } : {}) });
  };
  const chosen = rows.filter((r) => r.on && !r.running_promo);
  const atRisk = rows.reduce((t, r) => t + r.at_risk, 0);
  const create = async () => {
    setBusy(true);
    try {
      const items = chosen.map((r) => {
        if (!r.promo || r.promo >= r.price) throw new Error(`Prix promotionnel invalide : ${r.article_name}`);
        return { articleId: r.article_id, promoPrice: r.promo };
      });
      const res = await call('clearance.createPromotions', items);
      toast.ok(
        `${res.created} promotion(s) créée(s) jusqu'à la date limite des lots${res.skipped.length ? ` ; déjà en promotion : ${res.skipped.join(', ')}` : ''}`,
      );
      setEdits({});
      list.reload();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <p className="muted">
        Produits dont un lot arrive bientôt à sa date limite. La remise proposée suit les paliers réglés dans Administration › Paramètres (réglage « paliers de
        déstockage », par exemple « 14:10,7:20,3:30 » : 10 % à 14 jours, 20 % à 7 jours, 30 % à 3 jours). Vous pouvez changer la remise ou le prix de chaque ligne ; la
        promotion court jusqu'à la date limite du lot, dans ce magasin seulement.
      </p>
      {atRisk > 0 && (
        <div className="kpis">
          <div className="neg">
            <small>Valeur menacée (au prix de revient)</small>
            <strong>{fcfa(atRisk)}</strong>
          </div>
          <div>
            <small>Produits concernés</small>
            <strong>{rows.length}</strong>
          </div>
        </div>
      )}
      {rows.length === 0 ? (
        <Empty>Aucun produit n'approche de sa date limite dans les paliers de déstockage.</Empty>
      ) : (
        <table className="list">
          <thead>
            <tr>
              <th>
                <input
                  type="checkbox"
                  checked={chosen.length > 0 && chosen.length === rows.filter((r) => !r.running_promo).length}
                  onChange={(e) => setEdits((ed) => Object.fromEntries(rows.map((r) => [r.article_id, { ...ed[r.article_id], on: e.target.checked }])))}
                />
              </th>
              <th>Article</th>
              <th>Lot</th>
              <th>Date limite</th>
              <th className="r">Jours restants</th>
              <th className="r">Quantité</th>
              <th className="r">Prix de revient</th>
              <th className="r">Prix de vente</th>
              <th className="r">Remise %</th>
              <th className="r">Prix promotionnel</th>
              <th className="r">Valeur menacée</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.article_id} className={r.on && !r.running_promo ? '' : 'inactive'}>
                <td>
                  <input type="checkbox" disabled={Boolean(r.running_promo)} checked={r.on && !r.running_promo} onChange={(e) => set(r, { on: e.target.checked })} />
                </td>
                <td>
                  {r.article_name} <small className="muted">{r.article_code}</small>
                  {r.department_name && <small className="muted block">{r.department_name}</small>}
                  {r.running_promo && (
                    <span className="tag info" title={r.running_promo}>
                      promotion en cours
                    </span>
                  )}
                  {r.belowCost && <span className="tag alerte">sous le prix de revient</span>}
                </td>
                <td>{r.lot_number ?? ''}</td>
                <td>{dateFr(r.expiry)}</td>
                <td className={`r ${r.days_left <= 3 ? 'neg' : ''}`}>{r.days_left}</td>
                <td className="r">{qty(r.qty, r.unit)}</td>
                <td className="r">{fcfa(r.unit_cost)}</td>
                <td className="r">{fcfa(r.price)}</td>
                <td className="r">
                  <input className="qty" value={r.pctText} disabled={Boolean(r.running_promo)} onChange={(e) => setPct(r, e.target.value)} />
                </td>
                <td className="r">
                  <input className="qty" value={r.priceText} disabled={Boolean(r.running_promo)} onChange={(e) => setPrice(r, e.target.value)} />
                </td>
                <td className="r">{fcfa(r.at_risk)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="actions">
        <button className="primary" disabled={busy || !chosen.length} onClick={() => void create()}>
          Créer les promotions ({chosen.length})
        </button>
      </div>
    </>
  );
}

const monthStart = () => `${today().slice(0, 7)}-01`;

/** Démarque : pertes par rayon et par motif, au prix de revient, et leur poids dans les ventes. */
export function Losses() {
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(today());
  const labels = useLoad(() => call('clearance.lossLabels'));
  const rows = useLoad(() => call('clearance.losses', from, to), [from, to]);
  const kinds = Object.keys(labels.data ?? {}) as MovementType[];
  const list = rows.data ?? [];
  const sum = (f: (r: (typeof list)[number]) => number) => list.reduce((t, r) => t + f(r), 0);
  const total = sum((r) => r.total);
  const sales = sum((r) => r.sales);
  return (
    <>
      <div className="filters">
        <Field label="Du">
          <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value || monthStart())} />
        </Field>
        <Field label="Au">
          <input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value || today())} />
        </Field>
      </div>
      <p className="muted">
        Pertes déclarées (casse, vol, périmés, consommation interne) et écarts d'inventaire en moins, comptés au prix de revient, rayon par rayon, comparés au chiffre
        d'affaires du rayon sur la même période.
      </p>
      {rows.error ? <p className="neg">{rows.error instanceof Error ? rows.error.message : String(rows.error)}</p> : null}
      {list.length === 0 ? (
        <Empty>Aucune perte enregistrée sur cette période.</Empty>
      ) : (
        <table className="list">
          <thead>
            <tr>
              <th>Rayon</th>
              {kinds.map((k) => (
                <th key={k} className="r">
                  {labels.data?.[k]}
                </th>
              ))}
              <th className="r">Total des pertes</th>
              <th className="r">Ventes</th>
              <th className="r">% des ventes</th>
            </tr>
          </thead>
          <tbody>
            {list.map((r) => (
              <tr key={r.department_id ?? '-'}>
                <td>{r.department_name}</td>
                {kinds.map((k) => (
                  <td key={k} className="r">
                    {r.by_type[k] ? fcfa(r.by_type[k]!) : ''}
                  </td>
                ))}
                <td className="r">
                  <b>{fcfa(r.total)}</b>
                </td>
                <td className="r">{fcfa(r.sales)}</td>
                <td className={`r ${r.pct >= 2 ? 'neg' : ''}`}>{r.sales ? `${r.pct.toLocaleString('fr-FR')} %` : ''}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th>Total</th>
              {kinds.map((k) => (
                <th key={k} className="r">
                  {fcfa(sum((r) => r.by_type[k] ?? 0))}
                </th>
              ))}
              <th className="r">{fcfa(total)}</th>
              <th className="r">{fcfa(sales)}</th>
              <th className="r">{sales ? `${(Math.round((total / sales) * 10_000) / 100).toLocaleString('fr-FR')} %` : ''}</th>
            </tr>
          </tfoot>
        </table>
      )}
    </>
  );
}

/** Inventaire tournant : la courte liste de produits à compter cette semaine. */
export function CycleCount({ onOpenInventory }: { onOpenInventory?: () => void }) {
  const toast = useToast();
  const [warehouseId, setWarehouseId] = useState('');
  const [size, setSize] = useState('');
  const [off, setOff] = useState<Set<string>>(new Set());
  const [opened, setOpened] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const n = Number(size);
  const list = useLoad(
    () => (warehouseId ? call('cycleCount.proposal', warehouseId, n > 0 ? Math.round(n) : undefined) : Promise.resolve([])),
    [warehouseId, size, opened],
  );
  const rows = list.data ?? [];
  const chosen = rows.filter((r) => !off.has(r.article_id));
  const toggle = (id: string, on: boolean) =>
    setOff((s) => {
      const next = new Set(s);
      if (on) next.delete(id);
      else next.add(id);
      return next;
    });
  const start = async () => {
    setBusy(true);
    try {
      const inv = await call(
        'cycleCount.start',
        warehouseId,
        chosen.map((r) => r.article_id),
      );
      setOpened(inv.label ?? 'Inventaire tournant');
      setOff(new Set());
      toast.ok("L'inventaire de la semaine est ouvert dans l'onglet Inventaires");
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <p className="muted">
        Chaque semaine, une courte liste de produits à compter, choisis pour leur valeur en stock, leurs écarts passés et le temps depuis leur dernier comptage. Le magasin
        ne ferme jamais pour un grand inventaire : tout le stock finit par être compté, les produits chers et sensibles plus souvent.
      </p>
      <div className="grid3">
        <WarehouseSelect value={warehouseId} onChange={setWarehouseId} />
        <Field label="Nombre de produits" hint="Vide : le réglage du magasin (Administration › Paramètres).">
          <input type="number" min={1} max={500} value={size} onChange={(e) => setSize(e.target.value)} />
        </Field>
      </div>
      {opened && (
        <div className="warn">
          {opened} : l'inventaire est ouvert dans l'onglet Inventaires, où l'on saisit les quantités comptées puis on le clôture.{' '}
          {onOpenInventory && (
            <button className="link" onClick={onOpenInventory}>
              Aller aux inventaires
            </button>
          )}
        </div>
      )}
      {rows.length === 0 ? (
        <Empty>Aucun produit à compter dans ce dépôt cette semaine (les produits comptés depuis moins de 4 semaines attendent leur tour).</Empty>
      ) : (
        <table className="list">
          <thead>
            <tr>
              <th>
                <input type="checkbox" checked={chosen.length === rows.length} onChange={(e) => setOff(e.target.checked ? new Set() : new Set(rows.map((r) => r.article_id)))} />
              </th>
              <th>Article</th>
              <th>Rayon</th>
              <th className="r">Stock</th>
              <th className="r">Valeur</th>
              <th>Dernier comptage</th>
              <th>Pourquoi</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.article_id} className={off.has(r.article_id) ? 'inactive' : ''}>
                <td>
                  <input type="checkbox" checked={!off.has(r.article_id)} onChange={(e) => toggle(r.article_id, e.target.checked)} />
                </td>
                <td>
                  {r.article_name} <small className="muted">{r.article_code}</small>
                </td>
                <td>{r.department_name ?? ''}</td>
                <td className="r">{qty(r.stock)}</td>
                <td className="r">{fcfa(r.value)}</td>
                <td>{r.last_counted ? dateFr(r.last_counted) : <span className="muted">jamais</span>}</td>
                <td>{r.reasons.join(', ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="actions">
        <button className="primary" disabled={busy || !chosen.length} onClick={() => void start()}>
          Ouvrir l'inventaire de la semaine ({chosen.length})
        </button>
      </div>
    </>
  );
}
