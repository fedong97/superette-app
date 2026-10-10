import { useEffect, useState } from 'react';
import { LOSS_TYPES, MOVEMENT_TYPES, type MovementType } from '@superette/core';
import { type Result, call } from '../api';
import { StockByWarehouse } from './Controls';
import { Inventories } from './Inventories';
import { Transfers } from './Transfers';
import { Monitoring } from './Monitoring';
import { PackUnitSelect, packChoices, packCostText, purchaseUnits, switchUnits, toBase } from './packs';
import { ArticlePicker, SupplierSelect, WarehouseSelect } from './pickers';
import { Empty, Field, Tabs, dateFr, dateTime, fcfa, parseAmount, parseQty, qty, useLoad, useToast, has } from '../ui';

type Article = Result<'catalogue.get'>;
type User = NonNullable<Result<'app.state'>['user']>;
export type StockTab = Tab;
type Tab = 'state' | 'critical' | 'warehouses' | 'receive' | 'loss' | 'transfer' | 'inventory' | 'expiry' | 'moves' | 'adjustments' | 'monitoring';

const LEVEL_LABEL = { rupture: 'Rupture', alerte: 'Alerte', normal: 'Normal', surstock: 'Surstock' } as const;

export function Stock({ user, initialTab = 'state' }: { user: User; initialTab?: Tab }) {
  // Les stocks critiques sont l'état du stock filtré sur les ruptures et alertes.
  const [tab, setTab] = useState<Tab>(initialTab === 'critical' ? 'state' : initialTab);
  const canInventory = has(user, 'inventory') || has(user, 'inventory_count');
  const tabs: [Tab, string][] = [
    ['state', 'État du stock'],
    ['warehouses', 'Articles par dépôt'],
    ['receive', 'Réception'],
    ['loss', 'Pertes et casse'],
    ['transfer', 'Transfert'],
    ...(canInventory ? ([['inventory', 'Inventaires']] as [Tab, string][]) : []),
    ['expiry', 'Péremptions'],
    ['moves', 'Mouvements'],
    ['adjustments', 'Ajustements'],
    ['monitoring', 'Monitoring'],
  ];
  return (
    <div className="page">
      <header className="page-head">
        <h1>Stock</h1>
      </header>
      <Tabs value={tab} onChange={setTab} tabs={tabs} />
      {tab === 'state' && <StockState critical={initialTab === 'critical'} />}
      {tab === 'warehouses' && <StockByWarehouse />}
      {tab === 'receive' && <Reception />}
      {tab === 'loss' && <Loss />}
      {tab === 'transfer' && <Transfers />}
      {tab === 'inventory' && <Inventories user={user} />}
      {tab === 'expiry' && <Expiry />}
      {tab === 'moves' && <Moves />}
      {tab === 'adjustments' && <Moves adjustments />}
      {tab === 'monitoring' && <Monitoring user={user} />}
    </div>
  );
}

function StockState({ critical = false }: { critical?: boolean }) {
  const [warehouseId, setWarehouseId] = useState('');
  const [search, setSearch] = useState('');
  const [level, setLevel] = useState<'' | 'critical' | 'rupture' | 'alerte' | 'surstock'>(critical ? 'critical' : '');
  const loaded = useLoad(
    () => call('stock.list', { warehouseId: warehouseId || undefined, search: search || undefined, level: level && level !== 'critical' ? level : undefined }),
    [warehouseId, search, level],
  );
  const rows = { ...loaded, data: level === 'critical' ? loaded.data?.filter((r) => r.level === 'rupture' || r.level === 'alerte') : loaded.data };
  const wh = useLoad(() => call('admin.warehouses'));
  const total = (rows.data ?? []).reduce((s, r) => s + r.value, 0);
  return (
    <>
      <div className="filters">
        <select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
          <option value="">Tous les dépôts</option>
          {(wh.data ?? []).map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </select>
        <select value={level} onChange={(e) => setLevel(e.target.value as typeof level)}>
          <option value="">Tous les niveaux</option>
          <option value="critical">Stocks critiques (ruptures et alertes)</option>
          <option value="rupture">Ruptures</option>
          <option value="alerte">Sous le seuil d'alerte</option>
          <option value="surstock">Surstocks</option>
        </select>
        <input className="search" placeholder="Rechercher" value={search} onChange={(e) => setSearch(e.target.value)} />
        <span className="muted">Valeur du stock (CMUP) : {fcfa(total)}</span>
      </div>
      <table className="list">
        <thead>
          <tr>
            <th>Article</th>
            <th>Rayon</th>
            <th className="r">Quantité</th>
            <th className="r">CMUP</th>
            <th className="r">Valeur</th>
            <th>Prochaine DLC</th>
            <th>Niveau</th>
          </tr>
        </thead>
        <tbody>
          {(rows.data ?? []).map((r) => (
            <tr key={r.article_id}>
              <td>{r.name}</td>
              <td>{r.department_name ?? '—'}</td>
              <td className={`r ${r.qty < 0 ? 'neg' : ''}`}>
                {qty(r.qty, r.unit)}
                {r.in_packs && <small className="muted block">{r.in_packs}</small>}
              </td>
              <td className="r">{fcfa(r.avg_cost)}</td>
              <td className="r">{fcfa(r.value)}</td>
              <td>{r.next_expiry ? dateFr(r.next_expiry) : '—'}</td>
              <td>
                <span className={`tag ${r.level}`}>{LEVEL_LABEL[r.level]}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

interface RecLine {
  article: Article;
  /** Quantité et coût HT dans le conditionnement choisi (`packUnits` unités, en millièmes). */
  qty: string;
  cost: string;
  packUnits: number;
  lot: string;
  expiry: string;
}

function Reception() {
  const toast = useToast();
  const [warehouseId, setWarehouseId] = useState('');
  const [supplierId, setSupplierId] = useState('');
  const [reference, setReference] = useState('');
  const [lines, setLines] = useState<RecLine[]>([]);
  const update = (i: number, patch: Partial<RecLine>) => setLines(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const total = lines.reduce((s, l) => s + Math.round(((parseQty(l.qty) ?? 0) * (parseAmount(l.cost) ?? 0)) / 1000), 0);
  return (
    <div>
      <p className="muted">Réception libre, sans bon de commande (lot et date limite). Pour réceptionner une commande : Achats › Bons de commande.</p>
      <div className="grid3">
        <WarehouseSelect value={warehouseId} onChange={setWarehouseId} />
        <SupplierSelect value={supplierId} onChange={setSupplierId} optional />
        <Field label="N° bon de livraison">
          <input value={reference} onChange={(e) => setReference(e.target.value)} />
        </Field>
      </div>
      <ArticlePicker
        onPick={(a) => {
          const units = purchaseUnits(a);
          setLines([...lines, { article: a, qty: '1', cost: packCostText(a, units), packUnits: units, lot: '', expiry: '' }]);
        }}
      />
      {lines.length > 0 && (
        <table className="list">
          <thead>
            <tr>
              <th>Article</th>
              <th>Quantité</th>
              <th>Conditionnement</th>
              <th>Coût unitaire HT</th>
              <th>N° de lot</th>
              <th>Date limite</th>
              <th className="r">Montant</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={i}>
                <td>{l.article.name}</td>
                <td>
                  <input className="qty" value={l.qty} onChange={(e) => update(i, { qty: e.target.value })} />
                </td>
                <td>
                  <PackUnitSelect
                    choices={packChoices(l.article)}
                    value={l.packUnits}
                    onChange={(u) => update(i, { ...switchUnits(l.qty, l.cost, l.packUnits, u), packUnits: u })}
                  />
                </td>
                <td>
                  <input className="qty" value={l.cost} onChange={(e) => update(i, { cost: e.target.value })} />
                </td>
                <td>
                  <input className="qty" value={l.lot} onChange={(e) => update(i, { lot: e.target.value })} />
                </td>
                <td>
                  <input type="date" value={l.expiry} required={l.article.perishable === 1} onChange={(e) => update(i, { expiry: e.target.value })} />
                </td>
                <td className="r">{fcfa(Math.round(((parseQty(l.qty) ?? 0) * (parseAmount(l.cost) ?? 0)) / 1000))}</td>
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
      <div className="actions">
        <span className="big-total">{fcfa(total)} HT</span>
        <button
          className="primary"
          disabled={!lines.length}
          onClick={async () => {
            try {
              await call('stock.receive', {
                warehouseId,
                supplierId: supplierId || null,
                reference: reference || undefined,
                lines: lines.map((l) => {
                  const b = toBase(l.qty, l.cost, l.packUnits);
                  if (!b.qty || b.unitCost === null) throw new Error(`Quantité ou coût invalide : ${l.article.name}`);
                  return { articleId: l.article.id, qty: b.qty, unitCost: b.unitCost, packCost: parseAmount(l.cost) ?? undefined, packUnits: l.packUnits, lotNumber: l.lot || null, expiry: l.expiry || null };
                }),
              });
              toast.ok('Réception enregistrée');
              setLines([]);
              setReference('');
            } catch (err) {
              toast.error(err);
            }
          }}
        >
          Valider la réception
        </button>
      </div>
    </div>
  );
}

function Loss() {
  const toast = useToast();
  const [warehouseId, setWarehouseId] = useState('');
  const [article, setArticle] = useState<Article | null>(null);
  const [type, setType] = useState<MovementType>('BREAKAGE');
  const [q, setQ] = useState('1');
  const [reason, setReason] = useState('');
  const [lotId, setLotId] = useState('');
  const lots = useLoad(() => (article ? call('stock.lots', article.id) : Promise.resolve([])), [article?.id]);
  return (
    <div className="narrow">
      <WarehouseSelect value={warehouseId} onChange={setWarehouseId} />
      {article ? (
        <p>
          <strong>{article.name}</strong>{' '}
          <button className="ghost" onClick={() => setArticle(null)}>
            changer
          </button>
        </p>
      ) : (
        <ArticlePicker onPick={setArticle} />
      )}
      <div className="grid2">
        <Field label="Type de sortie">
          <select value={type} onChange={(e) => setType(e.target.value as MovementType)}>
            {LOSS_TYPES.map((t) => (
              <option key={t} value={t}>
                {MOVEMENT_TYPES[t]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Quantité">
          <input value={q} onChange={(e) => setQ(e.target.value)} />
        </Field>
        <Field label="Lot" hint="Par défaut : le plus proche de sa date (FEFO)">
          <select value={lotId} onChange={(e) => setLotId(e.target.value)}>
            <option value="">Automatique (FEFO)</option>
            {(lots.data ?? []).map((l) => (
              <option key={l.id} value={l.id}>
                {l.warehouse_name} · {l.lot_number ?? 'sans n°'} · {l.expiry ? dateFr(l.expiry) : 'sans date'} · {qty(l.qty)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Motif">
          <input value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
      </div>
      <button
        className="primary"
        disabled={!article || !reason.trim() || !parseQty(q)}
        onClick={async () => {
          try {
            await call('stock.loss', { warehouseId, articleId: article!.id, qty: parseQty(q)!, type, reason, lotId: lotId || null });
            toast.ok('Sortie enregistrée');
            setArticle(null);
            setReason('');
            setQ('1');
            setLotId('');
          } catch (err) {
            toast.error(err);
          }
        }}
      >
        Enregistrer la sortie
      </button>
    </div>
  );
}

function Expiry() {
  const [days, setDays] = useState(7);
  const lots = useLoad(() => call('stock.expiring', days), [days]);
  return (
    <>
      <div className="filters">
        <label className="inline">
          Horizon
          <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
            {[1, 3, 7, 15, 30].map((d) => (
              <option key={d} value={d}>
                {d} jour(s)
              </option>
            ))}
          </select>
        </label>
        <span className="muted">Démarquez ou sortez en perte depuis l'onglet « Pertes et casse » (type Péremption).</span>
      </div>
      {lots.data?.length === 0 ? (
        <Empty>Aucun produit à démarquer sur cette période.</Empty>
      ) : (
        <table className="list">
          <thead>
            <tr>
              <th>Article</th>
              <th>Dépôt</th>
              <th>Lot</th>
              <th>Date limite</th>
              <th className="r">Quantité</th>
              <th>Alerte</th>
            </tr>
          </thead>
          <tbody>
            {(lots.data ?? []).map((l) => (
              <tr key={l.lot_id}>
                <td>{l.name}</td>
                <td>{l.warehouse_name}</td>
                <td>{l.lot_number ?? '—'}</td>
                <td>{dateFr(l.expiry)}</td>
                <td className="r">{qty(l.qty)}</td>
                <td>
                  <span className={`tag ${l.alert === 'perime' ? 'rupture' : 'alerte'}`}>{l.alert === 'perime' ? 'Périmé' : l.alert}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

const ADJUSTMENT_TYPES: MovementType[] = ['BREAKAGE', 'THEFT', 'EXPIRY', 'INTERNAL_USE', 'INVENTORY_ADJUST'];

/** Mouvements de stock ; `adjustments` : seulement les pertes et écarts d'inventaire. */
function Moves({ adjustments = false }: { adjustments?: boolean }) {
  const moves = useLoad(() => call('stock.movements', undefined, adjustments ? ADJUSTMENT_TYPES : undefined), [adjustments]);
  return (
    <table className="list">
      <thead>
        <tr>
          <th>Date</th>
          <th>Type</th>
          <th>Article</th>
          <th>Dépôt</th>
          <th className="r">Quantité</th>
          <th className="r">Coût unit.</th>
          <th>Motif</th>
          <th>Par</th>
        </tr>
      </thead>
      <tbody>
        {(moves.data ?? []).map((m) => (
          <tr key={m.id}>
            <td>{dateTime(m.at)}</td>
            <td>{MOVEMENT_TYPES[m.type]}</td>
            <td>{m.article_name}</td>
            <td>{m.warehouse_name}</td>
            <td className={`r ${m.qty < 0 ? 'neg' : 'pos'}`}>{qty(m.qty, m.unit)}</td>
            <td className="r">{fcfa(m.unit_cost)}</td>
            <td>{m.reason ?? ''}</td>
            <td>{m.user_name}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
