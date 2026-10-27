import { useEffect, useState } from 'react';
import { LOSS_TYPES, MOVEMENT_TYPES, type MovementType, type Permission } from '@superette/core';
import { type Result, call } from '../api';
import { StockByWarehouse, saveXlsx } from './Controls';
import { Inventories } from './Inventories';
import { Transfers } from './Transfers';
import { Monitoring } from './Monitoring';
import { Clearance, CycleCount, Losses } from './Clearance';
import { packCostText, purchaseUnits } from './packs';
import { type ExtraTerms, type TermsText, lineNet, lineTerms, noTerms } from './purchaseTerms';
import { ArticlePicker, SupplierSelect, WarehouseSelect } from './pickers';
import { Empty, Field, Modal, Tabs, dateFr, dateTime, fcfa, parseAmount, parseQty, qty, today, useLoad, useToast, has } from '../ui';
import { tx } from '../tax';
import { ReceptionLabels } from './barcodePrint';
import { PurchaseEntry } from './purchaseEntry';
import { DayTasks, Restock } from './Floor';
import { Recalls } from './Recalls';
import { StoreTransfers } from './StoreTransfers';

type Article = Result<'catalogue.get'>;
type User = NonNullable<Result<'app.state'>['user']>;
export type StockTab = Tab;
type Tab = 'state' | 'critical' | 'multi' | 'warehouses' | 'receive' | 'loss' | 'transfer' | 'transferNew' | 'inventory' | 'expiry' | 'moves' | 'adjustments' | 'monitoring' | 'clearance' | 'losses' | 'cycle' | 'restock' | 'tasks' | 'stores' | 'recalls';

const LEVEL_LABEL = { rupture: 'Rupture', alerte: 'Alerte', normal: 'Normal', surstock: 'Surstock' } as const;

export function Stock({ user, initialTab = 'state' }: { user: User; initialTab?: Tab }) {
  // Les stocks critiques sont l'état du stock filtré sur les ruptures et alertes.
  // « Nouveau transfert » (menu Transfert) ouvre l'onglet Transfert sur un bon vierge.
  const [tab, setTab] = useState<Tab>(initialTab === 'critical' ? 'state' : initialTab === 'transferNew' ? 'transfer' : initialTab);
  const any = (...rights: Permission[]) => rights.some((r) => has(user, r));
  const allowed: Record<Tab, boolean> = {
    state: true,
    critical: true,
    multi: true,
    warehouses: true,
    receive: has(user, 'stock_receive'),
    loss: has(user, 'stock_loss'),
    transfer: any('transfer_view', 'transfer_create', 'transfer_ship', 'transfer_receive', 'transfer_cancel'),
    transferNew: has(user, 'transfer_create'),
    inventory: any('inventory', 'inventory_count', 'inventory_close', 'inventory_cancel', 'inventory_edit', 'inventory_import', 'inventory_print'),
    expiry: true,
    moves: any('stock_moves', 'stock'),
    adjustments: any('stock_moves', 'stock'),
    monitoring: any('stock_monitoring', 'stock_request', 'stock_adjust', 'stock_decide'),
    clearance: has(user, 'clearance'),
    losses: has(user, 'clearance'),
    cycle: has(user, 'cycle_count'),
    restock: has(user, 'restock'),
    tasks: has(user, 'day_tasks'),
    stores: has(user, 'store_transfers'),
    recalls: has(user, 'lot_recall'),
  };
  const tabs = (
    [
      ['tasks', 'Tâches du jour'],
      ['state', 'État du stock'],
      ['multi', 'Stock multi-magasin'],
      ['warehouses', 'Articles par dépôt'],
      ['receive', 'Réception'],
      ['loss', 'Pertes et casse'],
      ['restock', 'Réassort du rayon'],
      ['transfer', 'Transfert'],
      ['stores', 'Entre magasins'],
      ['inventory', 'Inventaires'],
      ['expiry', 'Péremptions'],
      ['recalls', 'Rappels de lots'],
      ['moves', 'Mouvements'],
      ['adjustments', 'Ajustements'],
      ['monitoring', 'Monitoring'],
      ['clearance', 'Déstockage'],
      ['losses', 'Démarque'],
      ['cycle', 'Inventaire tournant'],
    ] as [Tab, string][]
  ).filter(([k]) => allowed[k]);
  return (
    <div className="page">
      <header className="page-head">
        <h1>Stock</h1>
      </header>
      <Tabs main value={tab} onChange={setTab} tabs={tabs} />
      {!allowed[tab] && <Empty>Vous n'avez pas accès à cet onglet.</Empty>}
      {tab === 'state' && <StockState critical={initialTab === 'critical'} />}
      {tab === 'multi' && <StockByStore />}
      {tab === 'warehouses' && <StockByWarehouse />}
      {tab === 'receive' && allowed.receive && <Reception />}
      {tab === 'loss' && allowed.loss && <Loss />}
      {tab === 'transfer' && allowed.transfer && <Transfers startNew={initialTab === 'transferNew' && allowed.transferNew} />}
      {tab === 'inventory' && allowed.inventory && <Inventories user={user} />}
      {tab === 'expiry' && <Expiry />}
      {tab === 'moves' && allowed.moves && <Moves />}
      {tab === 'adjustments' && allowed.adjustments && <Moves adjustments />}
      {tab === 'monitoring' && allowed.monitoring && <Monitoring user={user} />}
      {tab === 'clearance' && allowed.clearance && <Clearance />}
      {tab === 'losses' && allowed.losses && <Losses />}
      {tab === 'restock' && allowed.restock && <Restock />}
      {tab === 'tasks' && allowed.tasks && <DayTasks />}
      {tab === 'stores' && allowed.stores && <StoreTransfers />}
      {tab === 'recalls' && allowed.recalls && <Recalls />}
      {tab === 'cycle' && allowed.cycle && <CycleCount onOpenInventory={allowed.inventory ? () => setTab('inventory') : undefined} />}
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
  // Tous les dépôts : une colonne par dépôt, puis le total ; un clic détaille l'article par dépôt et par lot.
  const perWarehouse = !warehouseId && (wh.data?.length ?? 0) > 1 ? wh.data! : [];
  const [detail, setDetail] = useState<StockRowT | null>(null);
  const exportXlsx = () =>
    saveXlsx(`etat-du-stock-${today()}.xlsx`, {
      name: 'État du stock',
      title: ['État du stock', `${warehouseId ? (wh.data?.find((w) => w.id === warehouseId)?.name ?? '') : 'Tous les dépôts'} · au ${dateFr(today())}`],
      columns: [
        { header: 'Code', width: 14 },
        { header: 'Article', width: 32 },
        { header: 'Rayon', width: 18 },
        ...perWarehouse.map((w) => ({ header: w.name, format: 'qty' as const, width: 14 })),
        { header: perWarehouse.length ? 'Total' : 'Quantité', format: 'qty' as const },
        { header: 'CMUP', format: 'money' as const },
        { header: 'Valeur', format: 'money' as const },
      ],
      rows: (rows.data ?? []).map((r) => [r.code, r.name, r.department_name, ...perWarehouse.map((w) => (r.by_warehouse[w.id] ?? 0) / 1000), r.qty / 1000, r.avg_cost, r.value]),
    });
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
        <button disabled={!rows.data} onClick={exportXlsx}>
          Exporter vers Excel
        </button>
      </div>
      <table className="list">
        <thead>
          <tr>
            <th>Article</th>
            <th>Rayon</th>
            {perWarehouse.map((w) => (
              <th key={w.id} className="r">
                {w.name}
              </th>
            ))}
            <th className="r">{perWarehouse.length ? 'Total' : 'Quantité'}</th>
            <th className="r">CMUP</th>
            <th className="r">Valeur</th>
            <th>Prochaine DLC</th>
            <th>Niveau</th>
          </tr>
        </thead>
        <tbody>
          {(rows.data ?? []).map((r) => (
            <tr key={r.article_id} className="clickable" title="Détail par dépôt et par lot" onClick={() => setDetail(r)}>
              <td>{r.name}</td>
              <td>{r.department_name ?? '—'}</td>
              {perWarehouse.map((w) => {
                const v = r.by_warehouse[w.id] ?? 0;
                return (
                  <td key={w.id} className={`r ${v < 0 ? 'neg' : v === 0 ? 'muted' : ''}`}>
                    {qty(v, r.unit)}
                  </td>
                );
              })}
              <td className={`r ${r.qty < 0 ? 'neg' : ''} ${perWarehouse.length ? 'b' : ''}`}>
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
      {detail && <StockDetail row={detail} warehouses={wh.data ?? []} onClose={() => setDetail(null)} />}
    </>
  );
}

type StockRowT = Result<'stock.list'>[number];

/** Aperçu d'un article : stock de chaque dépôt, puis ses lots (numéro, péremption) dépôt par dépôt. */
function StockDetail({ row, warehouses, onClose }: { row: StockRowT; warehouses: Result<'admin.warehouses'>; onClose: () => void }) {
  const lots = useLoad(() => call('stock.lots', row.article_id), [row.article_id]);
  return (
    <Modal title={`${row.name} · stock par dépôt`} onClose={onClose}>
      <table className="list compact">
        <thead>
          <tr>
            <th>Dépôt</th>
            <th className="r">Stock</th>
          </tr>
        </thead>
        <tbody>
          {warehouses.map((w) => {
            const v = row.by_warehouse[w.id] ?? 0;
            return (
              <tr key={w.id}>
                <td>
                  {w.name}
                  {w.is_sales_default ? <small className="muted"> · dépôt de vente</small> : null}
                </td>
                <td className={`r ${v < 0 ? 'neg' : ''}`}>{qty(v, row.unit)}</td>
              </tr>
            );
          })}
          <tr className="total">
            <td>Total</td>
            <td className="r">
              {qty(row.qty, row.unit)}
              {row.in_packs && <small className="muted block">{row.in_packs}</small>}
            </td>
          </tr>
        </tbody>
      </table>
      {Boolean(lots.data?.length) && (
        <>
          <h3>Lots</h3>
          <table className="list compact">
            <thead>
              <tr>
                <th>Dépôt</th>
                <th>N° de lot</th>
                <th>Péremption</th>
                <th>Entré le</th>
                <th className="r">Quantité</th>
              </tr>
            </thead>
            <tbody>
              {lots.data!.map((l) => (
                <tr key={l.id}>
                  <td>{l.warehouse_name}</td>
                  <td>{l.lot_number ?? '—'}</td>
                  <td>{l.expiry ? dateFr(l.expiry) : '—'}</td>
                  <td>{dateFr(l.received_at.slice(0, 10))}</td>
                  <td className="r">{qty(l.qty, row.unit)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </Modal>
  );
}

export interface RecLine extends TermsText, ExtraTerms {
  article: Article;
  /** Quantité et coût HT dans le conditionnement choisi (`packUnits` unités, en millièmes). */
  qty: string;
  cost: string;
  packUnits: number;
  lot: string;
  expiry: string;
  /** Référence de l'article chez le fournisseur (bon de commande). */
  supplierRef?: string | null;
  /** Transport et manutention par conditionnement saisi : vides, le prix de revient garde son écart. */
  transport?: string;
  handling?: string;
}

/** Transport et manutention d'un conditionnement, ou undefined s'ils ne sont pas saisis. */
export function recExtraCost(l: Pick<RecLine, 'transport' | 'handling'>): number | undefined {
  const t = (l.transport ?? '').trim();
  const h = (l.handling ?? '').trim();
  if (!t && !h) return undefined;
  return (t ? parseAmount(t) ?? 0 : 0) + (h ? parseAmount(h) ?? 0 : 0);
}

/** Nouvelle ligne : un conditionnement d'achat au dernier prix. */
export function newRecLine(a: Article): RecLine {
  const units = purchaseUnits(a);
  return { article: a, qty: '1', cost: packCostText(a, units), packUnits: units, lot: '', expiry: '', ...noTerms };
}

/** Ligne prête à envoyer : unités de base, remise, gratuits, lot. */
export function recLineInput(l: RecLine) {
  const t = lineTerms(l);
  if (typeof t === 'string') throw new Error(`${t} : ${l.article.name}`);
  return {
    articleId: l.article.id,
    qty: t.qty,
    unitCost: t.unitCost,
    discountBp: t.discountBp,
    freeQty: t.freeQty,
    promoBuy: t.promoBuy,
    promoPay: t.promoPay,
    packCost: parseAmount(l.cost) ?? undefined,
    packUnits: l.packUnits,
    lotNumber: l.lot || null,
    expiry: l.expiry || null,
    extraCost: recExtraCost(l),
  };
}

function Reception() {
  const toast = useToast();
  const [warehouseId, setWarehouseId] = useState('');
  const [supplierId, setSupplierId] = useState('');
  const [reference, setReference] = useState('');
  const [lines, setLines] = useState<RecLine[]>([]);
  const [received, setReceived] = useState<{ articleId: string; qty: number; packUnits: number }[] | null>(null);
  const total = lines.reduce((s, l) => s + lineNet(l), 0);
  return (
    <div>
      {received && <ReceptionLabels title="Réception enregistrée · imprimer les étiquettes ?" lines={received} onClose={() => setReceived(null)} />}
      <p className="muted">
        Réception libre, sans bon de commande (lot et date limite). Pour réceptionner une commande : Achats › Bons de commande. Pour saisir la facture en même temps :
        Achats › Facture directe.
      </p>
      <div className="grid3">
        <WarehouseSelect value={warehouseId} onChange={setWarehouseId} />
        <SupplierSelect value={supplierId} onChange={setSupplierId} optional />
        <Field label="N° bon de livraison">
          <input value={reference} onChange={(e) => setReference(e.target.value)} />
        </Field>
      </div>
      <PurchaseEntry lines={lines} setLines={setLines}>
      <div className="actions">
        <span className="big-total">{fcfa(total)}{tx(' HT')}</span>
        <button
          className="primary"
          disabled={!lines.length}
          onClick={async () => {
            try {
              const input = lines.map(recLineInput);
              await call('stock.receive', {
                warehouseId,
                supplierId: supplierId || null,
                reference: reference || undefined,
                lines: input,
              });
              toast.ok('Réception enregistrée');
              setReceived(input.map((l) => ({ articleId: l.articleId, qty: l.qty, packUnits: l.packUnits })));
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
      </PurchaseEntry>
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
/**
 * Stock multi-magasin (onglet Stock MM) : chaque article avec son stock dans chaque magasin,
 * en pièces avec l'équivalent en cartons ; un clic sur un magasin détaille ses dépôts.
 */
function StockByStore() {
  const toast = useToast();
  const [search, setSearch] = useState('');
  const [familyId, setFamilyId] = useState('');
  const [shortage, setShortage] = useState(false);
  const [detail, setDetail] = useState<{ articleId: string; storeId: string } | null>(null);
  const opts = { search: search || null, familyId: familyId || null, shortage };
  const data = useLoad(() => call('stock.byStore', opts), [search, familyId, shortage]);
  const deps = useLoad(() => call('catalogue.departments'), []);
  const d = data.data;
  const unitName = (r: { unit: 'piece' | 'kg' | 'litre'; unit_name: string | null }) => (r.unit === 'piece' ? (r.unit_name || 'pièce').toLowerCase() : r.unit === 'kg' ? 'kg' : 'l');
  const shown = (v: number | undefined, r: { unit: 'piece' | 'kg' | 'litre'; unit_name: string | null }) => (v === undefined ? '' : `${qty(v, r.unit)} ${r.unit === 'piece' ? unitName(r) + (Math.abs(v) >= 2000 && !unitName(r).endsWith('s') ? 's' : '') : ''}`.trim());
  /** « 3 cartons + 2 » : l'équivalent dans le plus grand conditionnement. */
  const inPacks = (v: number | undefined, r: { pack: { name: string; units: number } | null }) => {
    if (!v || v <= 0 || !r.pack || v < r.pack.units) return '';
    const n = Math.floor(v / r.pack.units);
    const rest = (v - n * r.pack.units) / 1000;
    const name = r.pack.name.toLowerCase();
    return `${n} ${name}${n > 1 && !name.endsWith('s') ? 's' : ''}${rest ? ` + ${rest.toLocaleString('fr-FR')}` : ''}`;
  };
  const row = detail && d?.rows.find((r) => r.article_id === detail.articleId);
  const store = detail && d?.stores.find((x) => x.id === detail.storeId);
  return (
    <>
      <div className="filters">
        <input className="search" placeholder="Rechercher un article (nom ou code)" value={search} onChange={(e) => setSearch(e.target.value)} autoFocus />
        <select value={familyId} onChange={(e) => setFamilyId(e.target.value)}>
          <option value="">Toutes les familles</option>
          {deps.data?.map((dep) => (
            <optgroup key={dep.id} label={dep.name}>
              {dep.families.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        <label>
          <input type="checkbox" checked={shortage} onChange={(e) => setShortage(e.target.checked)} /> En rupture dans au moins un magasin
        </label>
        <button disabled={!d} onClick={() => void call('stock.printByStore', opts).catch(toast.error)}>
          Imprimer (A4)
        </button>
        <button
          disabled={!d}
          onClick={() =>
            d &&
            saveXlsx(`stock-multi-magasin-${today()}.xlsx`, {
              name: 'Stock multi-magasin',
              title: ['Stock multi-magasin', `Au ${dateFr(today())}`],
              columns: [{ header: 'Code', width: 14 }, { header: 'Article', width: 32 }, { header: 'Famille', width: 18 }, ...d.stores.map((st) => ({ header: st.name, format: 'qty' as const, width: 14 })), { header: 'Total', format: 'qty' as const }],
              rows: d.rows.map((r) => [r.code, r.name, r.family_name, ...d.stores.map((st) => (r.byStore[st.id] === undefined ? null : r.byStore[st.id]! / 1000)), r.total / 1000]),
            })
          }
        >
          Exporter vers Excel
        </button>
      </div>
      {d && (
        <p className="muted small">
          {d.stores
            .map((st) => `${st.name} : ${st.own ? 'stock de ce poste, en direct' : st.updated_at ? `à jour au ${dateTime(st.updated_at)}` : 'pas encore reçu (serveur central)'}`)
            .join(' · ')}
        </p>
      )}
      {d && d.rows.length === 0 ? (
        <Empty>Aucun article ne correspond à ces filtres.</Empty>
      ) : (
        <table className="list compact stock-mm">
          <thead>
            <tr>
              <th>Code</th>
              <th>Article</th>
              {d?.stores.map((st) => (
                <th key={st.id} className="r">
                  {st.name}
                  {st.own && <small> (ici)</small>}
                </th>
              ))}
              <th className="r">Total</th>
            </tr>
          </thead>
          <tbody>
            {d?.rows.map((r) => (
              <tr key={r.article_id}>
                <td className="muted">{r.code}</td>
                <td>
                  {r.name}
                  {r.family_name && <small className="muted"> · {r.family_name}</small>}
                </td>
                {d.stores.map((st) => {
                  const v = r.byStore[st.id];
                  // Rouge : rupture ; orange : sous le stock d'alerte de l'article.
                  const level = v === undefined ? '' : v <= 0 ? 'neg' : r.alert_qty !== null && v <= r.alert_qty ? 'low' : '';
                  return (
                    <td key={st.id} className={`r ${level}`}>
                      {v === undefined ? (
                        <span className="muted">—</span>
                      ) : (
                        <button type="button" className="link" title="Détail par dépôt" onClick={() => setDetail({ articleId: r.article_id, storeId: st.id })}>
                          {shown(v, r)}
                        </button>
                      )}
                      {inPacks(v, r) && <small className="muted block">{inPacks(v, r)}</small>}
                    </td>
                  );
                })}
                <td className="r b">
                  {shown(r.total, r)}
                  {inPacks(r.total, r) && <small className="muted block">{inPacks(r.total, r)}</small>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {row && store && d && (
        <Modal title={`${row.name} · ${store.name}`} onClose={() => setDetail(null)}>
          <table className="list compact">
            <thead>
              <tr>
                <th>Dépôt</th>
                <th className="r">Stock</th>
              </tr>
            </thead>
            <tbody>
              {d.warehouses
                .filter((w) => w.store_id === store.id)
                .map((w) => (
                  <tr key={w.id}>
                    <td>{w.name}</td>
                    <td className={`r ${(row.byWarehouse[w.id] ?? 0) < 0 ? 'neg' : ''}`}>{row.byWarehouse[w.id] === undefined ? '—' : shown(row.byWarehouse[w.id], row)}</td>
                  </tr>
                ))}
              <tr className="b">
                <td>Total {store.name}</td>
                <td className="r">{shown(row.byStore[store.id], row)}</td>
              </tr>
            </tbody>
          </table>
          {!store.own && <p className="muted small">{store.updated_at ? `Stock envoyé par ${store.name}, à jour au ${dateTime(store.updated_at)}.` : ''}</p>}
        </Modal>
      )}
    </>
  );
}

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
