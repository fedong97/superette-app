import { useEffect, useState } from 'react';
import { LOSS_TYPES, MOVEMENT_TYPES, type MovementType } from '@superette/core';
import { type Result, call } from '../api';
import { Empty, Field, Tabs, dateFr, dateTime, fcfa, parseAmount, parseQty, qty, useLoad, useToast } from '../ui';

type Article = Result<'catalogue.get'>;
type User = NonNullable<Result<'app.state'>['user']>;
export type StockTab = Tab;
type Tab = 'state' | 'receive' | 'loss' | 'transfer' | 'inventory' | 'expiry' | 'moves';

const LEVEL_LABEL = { rupture: 'Rupture', alerte: 'Alerte', normal: 'Normal', surstock: 'Surstock' } as const;

export function Stock({ user, initialTab = 'state' }: { user: User; initialTab?: Tab }) {
  const [tab, setTab] = useState<Tab>(initialTab);
  const canInventory = user.role === 'admin' || user.role === 'manager';
  const tabs: [Tab, string][] = [
    ['state', 'État du stock'],
    ['receive', 'Réception'],
    ['loss', 'Pertes et casse'],
    ['transfer', 'Transfert'],
    ...(canInventory ? ([['inventory', 'Inventaire']] as [Tab, string][]) : []),
    ['expiry', 'Péremptions'],
    ['moves', 'Mouvements'],
  ];
  return (
    <div className="page">
      <header className="page-head">
        <h1>Stock</h1>
      </header>
      <Tabs value={tab} onChange={setTab} tabs={tabs} />
      {tab === 'state' && <StockState />}
      {tab === 'receive' && <Reception />}
      {tab === 'loss' && <Loss />}
      {tab === 'transfer' && <Transfer />}
      {tab === 'inventory' && <Inventory />}
      {tab === 'expiry' && <Expiry />}
      {tab === 'moves' && <Moves />}
    </div>
  );
}

/** Recherche d'article par scan ou par nom. */
function ArticlePicker({ onPick, placeholder }: { onPick: (a: Article) => void; placeholder?: string }) {
  const toast = useToast();
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Article[]>([]);
  return (
    <div className="picker">
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (!q.trim()) return;
          try {
            const hit = await call('catalogue.scan', q);
            if (hit) {
              onPick(hit.article);
              setQ('');
              setResults([]);
              return;
            }
            const found = await call('catalogue.search', q);
            if (found.length === 1) {
              onPick(found[0]!);
              setQ('');
              setResults([]);
            } else if (found.length === 0) toast.error('Article introuvable');
            else setResults(found);
          } catch (err) {
            toast.error(err);
          }
        }}
      >
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={placeholder ?? 'Scanner ou rechercher un article'} autoFocus />
      </form>
      {results.length > 0 && (
        <div className="pick-list dropdown">
          {results.map((a) => (
            <button
              key={a.id}
              onClick={() => {
                onPick(a);
                setQ('');
                setResults([]);
              }}
            >
              <span>{a.name}</span>
              <span>{a.code}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function WarehouseSelect({ value, onChange, label = 'Dépôt' }: { value: string; onChange: (v: string) => void; label?: string }) {
  const wh = useLoad(() => call('admin.warehouses'));
  useEffect(() => {
    if (!value && wh.data?.[0]) onChange(wh.data[0].id);
  }, [value, wh.data, onChange]);
  return (
    <Field label={label}>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {(wh.data ?? []).map((w) => (
          <option key={w.id} value={w.id}>
            {w.name}
          </option>
        ))}
      </select>
    </Field>
  );
}

function StockState() {
  const [warehouseId, setWarehouseId] = useState('');
  const [search, setSearch] = useState('');
  const [level, setLevel] = useState<'' | 'rupture' | 'alerte' | 'surstock'>('');
  const rows = useLoad(() => call('stock.list', { warehouseId: warehouseId || undefined, search: search || undefined, level: level || undefined }), [warehouseId, search, level]);
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
              <td className={`r ${r.qty < 0 ? 'neg' : ''}`}>{qty(r.qty, r.unit)}</td>
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
  qty: string;
  cost: string;
  lot: string;
  expiry: string;
}

function Reception() {
  const toast = useToast();
  const [warehouseId, setWarehouseId] = useState('');
  const [supplier, setSupplier] = useState('');
  const [reference, setReference] = useState('');
  const [lines, setLines] = useState<RecLine[]>([]);
  const update = (i: number, patch: Partial<RecLine>) => setLines(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const total = lines.reduce((s, l) => s + Math.round(((parseQty(l.qty) ?? 0) * (parseAmount(l.cost) ?? 0)) / 1000), 0);
  return (
    <div>
      <p className="muted">Entrée de marchandise avec lot et date limite. La commande fournisseur et la facture arrivent avec le module Achats (phase 2).</p>
      <div className="grid3">
        <WarehouseSelect value={warehouseId} onChange={setWarehouseId} />
        <Field label="Fournisseur">
          <input value={supplier} onChange={(e) => setSupplier(e.target.value)} />
        </Field>
        <Field label="N° bon de livraison">
          <input value={reference} onChange={(e) => setReference(e.target.value)} />
        </Field>
      </div>
      <ArticlePicker onPick={(a) => setLines([...lines, { article: a, qty: '1', cost: String(a.purchase_price || ''), lot: '', expiry: '' }])} />
      {lines.length > 0 && (
        <table className="list">
          <thead>
            <tr>
              <th>Article</th>
              <th>Quantité</th>
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
                supplier: supplier || undefined,
                reference: reference || undefined,
                lines: lines.map((l) => {
                  const q = parseQty(l.qty);
                  const c = parseAmount(l.cost);
                  if (!q || c === null) throw new Error(`Quantité ou coût invalide : ${l.article.name}`);
                  return { articleId: l.article.id, qty: q, unitCost: c, lotNumber: l.lot || null, expiry: l.expiry || null };
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

function Transfer() {
  const toast = useToast();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [lines, setLines] = useState<{ article: Article; qty: string }[]>([]);
  return (
    <div>
      <div className="grid2">
        <WarehouseSelect label="Depuis" value={from} onChange={setFrom} />
        <WarehouseSelect label="Vers" value={to} onChange={setTo} />
      </div>
      <ArticlePicker onPick={(a) => setLines([...lines, { article: a, qty: '1' }])} />
      <table className="list">
        <tbody>
          {lines.map((l, i) => (
            <tr key={i}>
              <td>{l.article.name}</td>
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
      <div className="actions">
        <button
          className="primary"
          disabled={!lines.length || from === to}
          onClick={async () => {
            try {
              await call('stock.transfer', {
                fromWarehouseId: from,
                toWarehouseId: to,
                lines: lines.map((l) => ({ articleId: l.article.id, qty: parseQty(l.qty) ?? 0 })),
              });
              toast.ok('Transfert enregistré');
              setLines([]);
            } catch (err) {
              toast.error(err);
            }
          }}
        >
          Valider le transfert
        </button>
      </div>
    </div>
  );
}

/** Inventaire tournant : chaque comptage est horodaté, les ventes en cours sont prises en compte. */
function Inventory() {
  const toast = useToast();
  const [warehouseId, setWarehouseId] = useState('');
  const [counts, setCounts] = useState<{ article: Article; counted: string; countedAt: string }[]>([]);
  const [result, setResult] = useState<Result<'stock.inventory'> | null>(null);
  const names = new Map(counts.map((c) => [c.article.id, c.article.name]));
  return (
    <div>
      <p className="muted">
        Scannez et comptez rayon par rayon sans fermer le magasin : l'heure de chaque comptage est enregistrée et les ventes passées depuis sont déduites automatiquement.
      </p>
      <WarehouseSelect value={warehouseId} onChange={setWarehouseId} />
      <ArticlePicker
        placeholder="Scanner l'article compté"
        onPick={(a) => {
          if (counts.some((c) => c.article.id === a.id)) return toast.error('Article déjà dans le comptage');
          setCounts([{ article: a, counted: '', countedAt: new Date().toISOString() }, ...counts]);
        }}
      />
      <table className="list">
        <tbody>
          {counts.map((c, i) => (
            <tr key={c.article.id}>
              <td>{c.article.name}</td>
              <td>
                <input
                  className="qty"
                  autoFocus={i === 0}
                  value={c.counted}
                  placeholder="Compté"
                  onChange={(e) => setCounts(counts.map((x, j) => (j === i ? { ...x, counted: e.target.value, countedAt: new Date().toISOString() } : x)))}
                />
              </td>
              <td className="muted">compté à {new Date(c.countedAt).toLocaleTimeString('fr-FR')}</td>
              <td>
                <button className="ghost" onClick={() => setCounts(counts.filter((_, j) => j !== i))}>
                  ✕
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="actions">
        <button
          className="primary"
          disabled={!counts.length || counts.some((c) => c.counted.trim() === '' || Number.isNaN(Number(c.counted.replace(',', '.'))))}
          onClick={async () => {
            if (!confirm('Valider l’inventaire et corriger le stock ?')) return;
            try {
              const res = await call('stock.inventory', {
                warehouseId,
                counts: counts.map((c) => ({ articleId: c.article.id, counted: Math.round(Number(c.counted.replace(',', '.')) * 1000), countedAt: c.countedAt })),
              });
              setResult(res);
              setCounts([]);
            } catch (err) {
              toast.error(err);
            }
          }}
        >
          Valider l'inventaire
        </button>
      </div>
      {result && (
        <>
          <h3>Écarts constatés · {fcfa(result.totalValue)}</h3>
          <table className="list">
            <thead>
              <tr>
                <th>Article</th>
                <th className="r">Théorique</th>
                <th className="r">Compté</th>
                <th className="r">Écart</th>
                <th className="r">Valeur</th>
              </tr>
            </thead>
            <tbody>
              {result.lines.map((l) => (
                <tr key={l.articleId}>
                  <td>{names.get(l.articleId) ?? l.articleId}</td>
                  <td className="r">{qty(l.expected)}</td>
                  <td className="r">{qty(l.counted)}</td>
                  <td className={`r ${l.difference < 0 ? 'neg' : l.difference > 0 ? 'pos' : ''}`}>{qty(l.difference)}</td>
                  <td className="r">{fcfa(l.value)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
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

function Moves() {
  const moves = useLoad(() => call('stock.movements'));
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
