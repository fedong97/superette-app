import { useState } from 'react';
import { PAYMENT_METHODS, type PaymentMethod, type XlsxSheet, xlsxWorkbook } from '@superette/core';
import { type Result, call } from '../api';
import { Empty, Field, Modal, dateFr, dateTime, fcfa, qty, today, useLoad, useToast } from '../ui';
import { SaleDetail } from './Sales';

/**
 * Registres et contrôles rangés comme les menus de KONTROL : registre des
 * ventes, alertes, opérations de caisse, achats par produit, marchandises non
 * reçues, articles par dépôt, comptes fournisseurs et clients.
 */

const monthStart = () => `${today().slice(0, 7)}-01`;

/** Période avec raccourcis (aujourd'hui, ce mois, mois dernier). */
function PeriodPicker({ from, to, onChange }: { from: string; to: string; onChange: (p: { from: string; to: string }) => void }) {
  const lastMonth = () => {
    const d = new Date();
    const first = new Date(d.getFullYear(), d.getMonth() - 1, 1);
    const last = new Date(d.getFullYear(), d.getMonth(), 0);
    const ymd = (x: Date) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
    return { from: ymd(first), to: ymd(last) };
  };
  return (
    <>
      <input type="date" value={from} onChange={(e) => onChange({ from: e.target.value, to })} />
      <span className="muted">au</span>
      <input type="date" value={to} onChange={(e) => onChange({ from, to: e.target.value })} />
      <div className="seg">
        <button onClick={() => onChange({ from: today(), to: today() })}>Aujourd'hui</button>
        <button onClick={() => onChange({ from: monthStart(), to: today() })}>Ce mois</button>
        <button onClick={() => onChange(lastMonth())}>Mois dernier</button>
      </div>
    </>
  );
}

function usePeriod(initial: 'today' | 'month' = 'month') {
  return useState(() => ({ from: initial === 'today' ? today() : monthStart(), to: today() }));
}

/** Enregistre une feuille Excel produite à l'écran. */
export function saveXlsx(filename: string, sheet: XlsxSheet) {
  const url = URL.createObjectURL(new Blob([new Uint8Array(xlsxWorkbook([sheet]))], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const periodTitle = (p: { from: string; to: string }) => (p.from === p.to ? `Le ${dateFr(p.from)}` : `Du ${dateFr(p.from)} au ${dateFr(p.to)}`);
const methodsOf = (m: string | null) =>
  (m ?? '')
    .split(',')
    .filter(Boolean)
    .map((x) => PAYMENT_METHODS[x as PaymentMethod] ?? x)
    .join(', ');

// --- Vente --------------------------------------------------------------------

export type RegisterPreset = 'all' | 'returns' | 'cancelled';

/** Registre des ventes : tous les tickets d'une période, toutes caisses, avec recherche. */
export function SalesRegister({ preset = 'all', focusSearch = false }: { preset?: RegisterPreset; focusSearch?: boolean }) {
  const toast = useToast();
  // Recherche d'une facture : sur toute l'année, pour retrouver un ancien ticket.
  const [period, setPeriod] = useState(() => ({ from: focusSearch ? `${today().slice(0, 4)}-01-01` : preset === 'all' ? today() : monthStart(), to: today() }));
  const [kind, setKind] = useState<'' | 'sale' | 'return'>(preset === 'returns' ? 'return' : '');
  const [status, setStatus] = useState<'' | 'completed' | 'cancelled'>(preset === 'cancelled' ? 'cancelled' : '');
  const [registerId, setRegisterId] = useState('');
  const [userId, setUserId] = useState('');
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState<Result<'pos.sale'> | null>(null);
  const reg = useLoad(
    () => call('controls.salesRegister', { ...period, kind: kind || null, status: status || null, registerId: registerId || null, userId: userId || null, search: search || null }),
    [period.from, period.to, kind, status, registerId, userId, search],
  );
  const r = reg.data;
  return (
    <>
      <div className="filters">
        <PeriodPicker from={period.from} to={period.to} onChange={setPeriod} />
        <input className="search" placeholder="N° de ticket, client ou montant" value={search} onChange={(e) => setSearch(e.target.value)} autoFocus={focusSearch} />
        <select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
          <option value="">Ventes et retours</option>
          <option value="sale">Ventes</option>
          <option value="return">Retours clients</option>
        </select>
        <select value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
          <option value="">Tous états</option>
          <option value="completed">Validés</option>
          <option value="cancelled">Annulés</option>
        </select>
        <select value={registerId} onChange={(e) => setRegisterId(e.target.value)}>
          <option value="">Toutes les caisses</option>
          {r?.registers.map((x) => (
            <option key={x.id} value={x.id}>
              {x.name}
            </option>
          ))}
        </select>
        <select value={userId} onChange={(e) => setUserId(e.target.value)}>
          <option value="">Tous les caissiers</option>
          {r?.users.map((x) => (
            <option key={x.id} value={x.id}>
              {x.name}
            </option>
          ))}
        </select>
        <button
          disabled={!r?.rows.length}
          onClick={() =>
            r &&
            saveXlsx(`registre-ventes-${period.from}-au-${period.to}.xlsx`, {
              name: 'Registre des ventes',
              title: ['Registre des ventes', periodTitle(period)],
              columns: [
                { header: 'N°', width: 18 },
                { header: 'Date', width: 17 },
                { header: 'Type' },
                { header: 'État' },
                { header: 'Caisse', width: 14 },
                { header: 'Caissier', width: 16 },
                { header: 'Client', width: 24 },
                { header: 'Paiement', width: 22 },
                { header: 'Remises', format: 'money' },
                { header: 'Total TTC', format: 'money' },
              ],
              rows: r.rows.map((x) => [
                x.number,
                dateTime(x.created_at),
                x.kind === 'sale' ? 'Vente' : 'Retour',
                x.status === 'cancelled' ? 'Annulé' : 'Validé',
                x.register_name,
                x.user_name,
                x.customer_name ?? '',
                methodsOf(x.methods),
                x.total_discount + x.total_promo,
                x.total_ttc,
              ]),
              totalRow: ['Total net', '', '', '', '', '', '', '', r.totals.discounts, r.totals.net],
            })
          }
        >
          Exporter vers Excel
        </button>
      </div>
      {r && (
        <div className="kpis kpis-6">
          <div>
            <small>Ventes</small>
            <strong>{fcfa(r.totals.sales)}</strong>
            <small>{r.totals.count} ticket(s)</small>
          </div>
          <div>
            <small>Retours</small>
            <strong>{fcfa(r.totals.returns)}</strong>
            <small>{r.totals.returnCount} retour(s)</small>
          </div>
          <div>
            <small>Net encaissé</small>
            <strong>{fcfa(r.totals.net)}</strong>
          </div>
          <div>
            <small>Remises et promotions</small>
            <strong>{fcfa(r.totals.discounts)}</strong>
          </div>
          <div className={r.totals.cancelledCount ? 'neg' : ''}>
            <small>Annulés</small>
            <strong>{fcfa(r.totals.cancelled)}</strong>
            <small>{r.totals.cancelledCount} ticket(s)</small>
          </div>
          <div>
            <small>Panier moyen</small>
            <strong>{fcfa(r.totals.count ? Math.round(r.totals.sales / r.totals.count) : 0)}</strong>
          </div>
        </div>
      )}
      {r && r.rows.length === 0 ? (
        <Empty>Aucun ticket ne correspond.</Empty>
      ) : (
        <table className="list compact">
          <thead>
            <tr>
              <th>N°</th>
              <th>Date</th>
              <th>Caisse</th>
              <th>Caissier</th>
              <th>Client</th>
              <th>Paiement</th>
              <th className="r">Remises</th>
              <th className="r">Total TTC</th>
              <th>État</th>
            </tr>
          </thead>
          <tbody>
            {r?.rows.map((x) => (
              <tr key={x.id} className={`clickable ${x.status === 'cancelled' ? 'inactive' : ''}`} onClick={() => call('pos.sale', x.id).then(setOpen, toast.error)}>
                <td>{x.number}</td>
                <td>{dateTime(x.created_at)}</td>
                <td>{x.register_name}</td>
                <td>{x.user_name}</td>
                <td>{x.customer_name}</td>
                <td>{methodsOf(x.methods)}</td>
                <td className="r">{x.total_discount + x.total_promo ? fcfa(x.total_discount + x.total_promo) : ''}</td>
                <td className={`r ${x.total_ttc < 0 ? 'neg' : ''}`}>{fcfa(x.total_ttc)}</td>
                <td>
                  {x.status === 'cancelled' && <span className="tag rupture" title={x.cancel_reason ?? ''}>Annulé</span>}
                  {x.kind === 'return' && <span className="tag alerte">Retour de {x.original_number}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {r?.truncated && <p className="muted small">Seuls les 5 000 tickets les plus récents sont affichés : réduisez la période.</p>}
      {open && <SaleDetail sale={open} onClose={() => setOpen(null)} />}
    </>
  );
}

const ALERT_LABELS: Record<Result<'controls.salesAlerts'>['alerts'][number]['kind'], string> = {
  below_cost: 'Ventes à perte',
  discount: 'Remises importantes',
  cancelled: 'Tickets annulés',
  return: 'Retours clients',
  credit_override: 'Plafonds forcés',
};

/** Alertes sur les ventes : ce qu'un gérant doit vérifier chaque jour. */
export function SalesAlerts() {
  const toast = useToast();
  const [period, setPeriod] = usePeriod('today');
  const [rate, setRate] = useState(10);
  const [kind, setKind] = useState<keyof typeof ALERT_LABELS | ''>('');
  const [open, setOpen] = useState<Result<'pos.sale'> | null>(null);
  const data = useLoad(() => call('controls.salesAlerts', { ...period, discountRate: rate / 100 }), [period.from, period.to, rate]);
  const rows = (data.data?.alerts ?? []).filter((a) => !kind || a.kind === kind);
  return (
    <>
      <div className="filters">
        <PeriodPicker from={period.from} to={period.to} onChange={setPeriod} />
        <label>
          Remise signalée à partir de{' '}
          <select value={rate} onChange={(e) => setRate(Number(e.target.value))}>
            {[5, 10, 15, 20, 30].map((v) => (
              <option key={v} value={v}>
                {v} %
              </option>
            ))}
          </select>
        </label>
      </div>
      {data.data && (
        <div className="kpis kpis-5">
          {(Object.keys(ALERT_LABELS) as (keyof typeof ALERT_LABELS)[]).map((k) => (
            <div key={k} className={`clickable ${data.data!.counts[k] ? 'neg' : ''} ${kind === k ? 'selected' : ''}`} onClick={() => setKind(kind === k ? '' : k)}>
              <small>{ALERT_LABELS[k]}</small>
              <strong>{data.data!.counts[k]}</strong>
            </div>
          ))}
        </div>
      )}
      {rows.length === 0 ? (
        <Empty>Aucune alerte sur cette période.</Empty>
      ) : (
        <table className="list compact">
          <thead>
            <tr>
              <th>Date</th>
              <th>Alerte</th>
              <th>Ticket</th>
              <th>Caissier</th>
              <th>Article ou client</th>
              <th>Détail</th>
              <th className="r">Montant</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((a, i) => (
              <tr key={i} className={a.sale_id ? 'clickable' : ''} onClick={() => a.sale_id && call('pos.sale', a.sale_id).then(setOpen, toast.error)}>
                <td>{dateTime(a.at)}</td>
                <td>
                  <span className={`tag ${a.kind === 'below_cost' || a.kind === 'cancelled' ? 'rupture' : 'alerte'}`}>{ALERT_LABELS[a.kind]}</span>
                </td>
                <td>{a.number}</td>
                <td>{a.user_name}</td>
                <td>{a.label}</td>
                <td className="muted">{a.detail}</td>
                <td className="r">{fcfa(a.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="muted small">Vente à perte : prix de vente HT, remise déduite, sous le coût d'achat moyen (CMUP) au moment de la vente.</p>
      {open && <SaleDetail sale={open} onClose={() => setOpen(null)} />}
    </>
  );
}

// --- Trésorerie ---------------------------------------------------------------

const CASH_LABELS: Record<Result<'controls.cashOperations'>['rows'][number]['kind'], string> = {
  float: 'Fonds de caisse',
  in: 'Apport',
  out: 'Prélèvement',
  expense: 'Dépense en caisse',
  customer_payment: 'Règlement client',
  gap: 'Écart de clôture',
};

/** Listing des opérations de caisse hors ventes : tout ce qui fait bouger le tiroir. */
export function CashOperations() {
  const [period, setPeriod] = usePeriod('today');
  const [registerId, setRegisterId] = useState('');
  const data = useLoad(() => call('controls.cashOperations', { ...period, registerId: registerId || null }), [period.from, period.to, registerId]);
  const d = data.data;
  return (
    <>
      <div className="filters">
        <PeriodPicker from={period.from} to={period.to} onChange={setPeriod} />
        <select value={registerId} onChange={(e) => setRegisterId(e.target.value)}>
          <option value="">Toutes les caisses</option>
          {d?.registers.map((x) => (
            <option key={x.id} value={x.id}>
              {x.name}
            </option>
          ))}
        </select>
      </div>
      {d && (
        <div className="kpis kpis-6">
          {(Object.keys(CASH_LABELS) as (keyof typeof CASH_LABELS)[]).map((k) => (
            <div key={k} className={d.totals[k] < 0 ? 'neg' : ''}>
              <small>{CASH_LABELS[k]}</small>
              <strong>{fcfa(d.totals[k])}</strong>
            </div>
          ))}
        </div>
      )}
      {d && d.rows.length === 0 ? (
        <Empty>Aucune opération de caisse sur cette période.</Empty>
      ) : (
        <table className="list compact">
          <thead>
            <tr>
              <th>Date</th>
              <th>Caisse</th>
              <th>Opération</th>
              <th>Motif</th>
              <th>Pièce</th>
              <th>Par</th>
              <th className="r">Entrée</th>
              <th className="r">Sortie</th>
            </tr>
          </thead>
          <tbody>
            {d?.rows.map((r) => (
              <tr key={r.id}>
                <td>{dateTime(r.at)}</td>
                <td>{r.register_name}</td>
                <td>{CASH_LABELS[r.kind]}</td>
                <td>{r.label}</td>
                <td className="muted">{r.reference}</td>
                <td>{r.user_name}</td>
                <td className="r">{r.amount > 0 ? fcfa(r.amount) : ''}</td>
                <td className="r neg">{r.amount < 0 ? fcfa(-r.amount) : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="muted small">Les ventes ne figurent pas ici : voyez le registre des ventes ou les rapports Z.</p>
    </>
  );
}

// --- Achats -------------------------------------------------------------------

/** Registre des achats par produit : ce qui est entré, à quel coût, chez qui. */
export function PurchasesByProduct() {
  const [period, setPeriod] = usePeriod('month');
  const [supplierId, setSupplierId] = useState('');
  const suppliers = useLoad(() => call('suppliers.list', {}), []);
  const data = useLoad(() => call('controls.purchasesByProduct', { ...period, supplierId: supplierId || null }), [period.from, period.to, supplierId]);
  const d = data.data;
  return (
    <>
      <div className="filters">
        <PeriodPicker from={period.from} to={period.to} onChange={setPeriod} />
        <select value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
          <option value="">Tous les fournisseurs</option>
          {suppliers.data?.map((x) => (
            <option key={x.id} value={x.id}>
              {x.name}
            </option>
          ))}
        </select>
        <button
          disabled={!d?.rows.length}
          onClick={() =>
            d &&
            saveXlsx(`achats-par-produit-${period.from}-au-${period.to}.xlsx`, {
              name: 'Achats par produit',
              title: ['Registre des achats par produit', periodTitle(period)],
              columns: [
                { header: 'Code', width: 12 },
                { header: 'Article', width: 32 },
                { header: 'Réceptions', format: 'int' },
                { header: 'Quantité', format: 'qty' },
                { header: 'Montant HT', format: 'money' },
                { header: 'Coût mini', format: 'money' },
                { header: 'Coût maxi', format: 'money' },
                { header: 'Dernier coût', format: 'money' },
                { header: 'Fournisseurs', width: 28 },
              ],
              rows: d.rows.map((r) => [r.code, r.name, r.receptions, r.qty / 1000, r.amount_ht, r.min_cost, r.max_cost, r.last_cost, r.suppliers ?? '']),
              totalRow: ['Total', '', '', '', d.total, '', '', '', ''],
            })
          }
        >
          Exporter vers Excel
        </button>
      </div>
      {d && d.rows.length === 0 ? (
        <Empty>Aucune réception sur cette période.</Empty>
      ) : (
        <table className="list compact">
          <thead>
            <tr>
              <th>Code</th>
              <th>Article</th>
              <th className="r">Réceptions</th>
              <th className="r">Quantité</th>
              <th className="r">Montant HT</th>
              <th className="r">Coût mini</th>
              <th className="r">Coût maxi</th>
              <th className="r">Dernier coût</th>
              <th>Fournisseurs</th>
              <th>Dernière entrée</th>
            </tr>
          </thead>
          <tbody>
            {d?.rows.map((r) => (
              <tr key={r.article_id}>
                <td className="muted">{r.code}</td>
                <td>{r.name}</td>
                <td className="r">{r.receptions}</td>
                <td className="r">{qty(r.qty, r.unit)}</td>
                <td className="r">{fcfa(r.amount_ht)}</td>
                <td className="r">{fcfa(r.min_cost)}</td>
                <td className={`r ${r.max_cost > r.min_cost ? 'neg' : ''}`}>{fcfa(r.max_cost)}</td>
                <td className="r">{fcfa(r.last_cost)}</td>
                <td>{r.suppliers ?? <span className="muted">réception libre</span>}</td>
                <td>{dateTime(r.last_at)}</td>
              </tr>
            ))}
          </tbody>
          {d && (
            <tfoot>
              <tr>
                <td />
                <td>Total</td>
                <td colSpan={2} />
                <td className="r">{fcfa(d.total)}</td>
                <td colSpan={5} />
              </tr>
            </tfoot>
          )}
        </table>
      )}
      <p className="muted small">Coût maxi en rouge : le prix d'achat a varié sur la période.</p>
    </>
  );
}

/** Marchandises commandées (bons envoyés) et pas encore reçues. */
export function PendingReceipts() {
  const data = useLoad(() => call('controls.pendingReceipts'), []);
  const d = data.data;
  return (
    <>
      {d && (
        <div className="kpis">
          <div>
            <small>Bons de commande en attente</small>
            <strong>{d.orders}</strong>
          </div>
          <div>
            <small>Valeur à recevoir (HT)</small>
            <strong>{fcfa(d.value)}</strong>
          </div>
          <div className={d.late ? 'neg' : ''}>
            <small>Dont en retard de livraison</small>
            <strong>{fcfa(d.late)}</strong>
          </div>
          <div>
            <small>Lignes</small>
            <strong>{d.lines.length}</strong>
          </div>
        </div>
      )}
      {d && d.lines.length === 0 ? (
        <Empty>Toutes les commandes envoyées ont été reçues.</Empty>
      ) : (
        <table className="list compact">
          <thead>
            <tr>
              <th>Commande</th>
              <th>Fournisseur</th>
              <th>Commandé le</th>
              <th>Livraison prévue</th>
              <th>Article</th>
              <th className="r">Commandé</th>
              <th className="r">Reçu</th>
              <th className="r">Reste</th>
              <th className="r">Valeur HT</th>
            </tr>
          </thead>
          <tbody>
            {d?.lines.map((l, i) => (
              <tr key={i}>
                <td>{l.number}</td>
                <td>{l.supplier_name}</td>
                <td>{dateFr(l.order_date)}</td>
                <td>{l.expected_date ? <span className={l.late ? 'tag rupture' : ''}>{dateFr(l.expected_date)}</span> : '—'}</td>
                <td>{l.name}</td>
                <td className="r">{qty(l.ordered, l.unit)}</td>
                <td className="r">{l.received ? qty(l.received, l.unit) : ''}</td>
                <td className="r b">{qty(l.remaining, l.unit)}</td>
                <td className="r">{fcfa(l.value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="muted small">Pour recevoir une commande : Achats › Registre des réceptions, ou soldez le reliquat depuis le bon de commande.</p>
    </>
  );
}

// --- Produit ------------------------------------------------------------------

/** Articles par dépôt : une colonne par dépôt du magasin. */
export function StockByWarehouse() {
  const [search, setSearch] = useState('');
  const [inStock, setInStock] = useState(true);
  const data = useLoad(() => call('stock.byWarehouse', { search: search || null, inStockOnly: inStock }), [search, inStock]);
  const d = data.data;
  return (
    <>
      <div className="filters">
        <input className="search" placeholder="Rechercher un article" value={search} onChange={(e) => setSearch(e.target.value)} />
        <label>
          <input type="checkbox" checked={inStock} onChange={(e) => setInStock(e.target.checked)} /> Avec du stock seulement
        </label>
      </div>
      {d && d.articles.length === 0 ? (
        <Empty>Aucun article.</Empty>
      ) : (
        <table className="list compact">
          <thead>
            <tr>
              <th>Code</th>
              <th>Article</th>
              {d?.warehouses.map((w) => (
                <th key={w.id} className="r">
                  {w.name}
                </th>
              ))}
              <th className="r">Total</th>
            </tr>
          </thead>
          <tbody>
            {d?.articles.map((a) => (
              <tr key={a.article_id}>
                <td className="muted">{a.code}</td>
                <td>{a.name}</td>
                {d.warehouses.map((w) => (
                  <td key={w.id} className={`r ${(a.qty[w.id] ?? 0) < 0 ? 'neg' : ''}`}>
                    {a.qty[w.id] ? qty(a.qty[w.id]!, a.unit) : ''}
                  </td>
                ))}
                <td className="r b">{qty(a.total, a.unit)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

// --- Fournisseurs et clients --------------------------------------------------

/** Extrait de compte fournisseur : factures, avoirs, règlements et solde progressif. */
export function SupplierStatement() {
  const suppliers = useLoad(() => call('suppliers.list', {}), []);
  const [supplierId, setSupplierId] = useState('');
  const [period, setPeriod] = useState({ from: `${today().slice(0, 4)}-01-01`, to: today() });
  const data = useLoad(() => (supplierId ? call('controls.supplierStatement', supplierId, period) : Promise.resolve(null)), [supplierId, period.from, period.to]);
  const d = data.data;
  const kinds = { invoice: 'Facture', credit_note: 'Avoir', payment: 'Règlement', sale: 'Vente', return: 'Retour' } as const;
  return (
    <>
      <div className="filters">
        <select value={supplierId} onChange={(e) => setSupplierId(e.target.value)} autoFocus>
          <option value="">Choisir le fournisseur…</option>
          {suppliers.data?.map((x) => (
            <option key={x.id} value={x.id}>
              {x.name}
            </option>
          ))}
        </select>
        <PeriodPicker from={period.from} to={period.to} onChange={setPeriod} />
        <button
          disabled={!d}
          onClick={() =>
            d &&
            saveXlsx(`extrait-${d.supplier.code}-${period.from}-au-${period.to}.xlsx`, {
              name: 'Extrait de compte',
              title: [`Extrait de compte · ${d.supplier.name}`, periodTitle(period)],
              columns: [{ header: 'Date', width: 12 }, { header: 'Pièce', width: 18 }, { header: 'Libellé', width: 32 }, { header: 'Débit', format: 'money' }, { header: 'Crédit', format: 'money' }, { header: 'Solde', format: 'money' }],
              rows: [['', '', 'Solde au début', '', '', d.opening], ...d.lines.map((l) => [dateFr(l.date.slice(0, 10)), l.number, l.label, l.debit || '', l.credit || '', l.balance])],
              totalRow: ['', '', 'Solde dû', d.debit, d.credit, d.closing],
            })
          }
        >
          Exporter vers Excel
        </button>
      </div>
      {!supplierId ? (
        <Empty>Choisissez un fournisseur pour voir son compte.</Empty>
      ) : (
        d && (
          <>
            <div className="kpis">
              <div>
                <small>Solde au {dateFr(period.from)}</small>
                <strong>{fcfa(d.opening)}</strong>
              </div>
              <div>
                <small>Facturé sur la période</small>
                <strong>{fcfa(d.debit)}</strong>
              </div>
              <div>
                <small>Réglé et avoirs</small>
                <strong>{fcfa(d.credit)}</strong>
              </div>
              <div className={d.closing > 0 ? 'neg' : ''}>
                <small>Solde dû</small>
                <strong>{fcfa(d.closing)}</strong>
              </div>
            </div>
            <table className="list compact">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Type</th>
                  <th>Pièce</th>
                  <th>Libellé</th>
                  <th className="r">Facturé</th>
                  <th className="r">Réglé</th>
                  <th className="r">Solde</th>
                </tr>
              </thead>
              <tbody>
                <tr className="muted">
                  <td colSpan={6}>Solde au début de la période</td>
                  <td className="r">{fcfa(d.opening)}</td>
                </tr>
                {d.lines.map((l, i) => (
                  <tr key={i}>
                    <td>{dateFr(l.date.slice(0, 10))}</td>
                    <td>{kinds[l.kind]}</td>
                    <td>{l.number}</td>
                    <td>{l.label}</td>
                    <td className="r">{l.debit ? fcfa(l.debit) : ''}</td>
                    <td className="r">{l.credit ? fcfa(l.credit) : ''}</td>
                    <td className="r b">{fcfa(l.balance)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )
      )}
    </>
  );
}

/** Situation des fournisseurs : ce que l'on doit à chacun et ce qui est échu. */
export function SupplierSituation() {
  const data = useLoad(() => call('controls.supplierSituation'), []);
  const d = data.data;
  return (
    <>
      {d && (
        <div className="kpis">
          <div>
            <small>Facturé (factures − avoirs)</small>
            <strong>{fcfa(d.totals.invoiced - d.totals.credits)}</strong>
          </div>
          <div>
            <small>Réglé</small>
            <strong>{fcfa(d.totals.paid)}</strong>
          </div>
          <div>
            <small>Solde dû</small>
            <strong>{fcfa(d.totals.balance)}</strong>
          </div>
          <div className={d.totals.overdue ? 'neg' : ''}>
            <small>Dont échu</small>
            <strong>{fcfa(d.totals.overdue)}</strong>
          </div>
        </div>
      )}
      {d && d.rows.length === 0 ? (
        <Empty>Aucune facture fournisseur saisie.</Empty>
      ) : (
        <table className="list compact">
          <thead>
            <tr>
              <th>Code</th>
              <th>Fournisseur</th>
              <th>Téléphone</th>
              <th className="r">Délai</th>
              <th className="r">Factures</th>
              <th className="r">Facturé</th>
              <th className="r">Avoirs</th>
              <th className="r">Réglé</th>
              <th className="r">Solde dû</th>
              <th className="r">Échu</th>
            </tr>
          </thead>
          <tbody>
            {d?.rows.map((r) => (
              <tr key={r.id}>
                <td className="muted">{r.code}</td>
                <td>{r.name}</td>
                <td>{r.phone}</td>
                <td className="r">{r.payment_terms_days ? `${r.payment_terms_days} j` : 'comptant'}</td>
                <td className="r">{r.invoices}</td>
                <td className="r">{fcfa(r.invoiced)}</td>
                <td className="r">{r.credits ? fcfa(r.credits) : ''}</td>
                <td className="r">{fcfa(r.paid)}</td>
                <td className="r b">{fcfa(r.balance)}</td>
                <td className={`r ${r.overdue ? 'neg' : ''}`}>{r.overdue ? fcfa(r.overdue) : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

/** Comptes dont le solde a bougé récemment (fournisseurs ou clients). */
export function RecentAccounts({ party }: { party: 'supplier' | 'customer' }) {
  const [days, setDays] = useState(7);
  const data = useLoad(() => call('controls.recentAccounts', party, days), [party, days]);
  return (
    <>
      <div className="filters">
        <span>Mouvements des</span>
        <div className="seg">
          {[1, 7, 30].map((d) => (
            <button key={d} className={days === d ? 'active' : ''} onClick={() => setDays(d)}>
              {d === 1 ? "aujourd'hui" : `${d} derniers jours`}
            </button>
          ))}
        </div>
      </div>
      {data.data && data.data.length === 0 ? (
        <Empty>Aucun compte n'a bougé sur cette période.</Empty>
      ) : (
        <table className="list compact">
          <thead>
            <tr>
              <th>Code</th>
              <th>{party === 'supplier' ? 'Fournisseur' : 'Client'}</th>
              <th>Téléphone</th>
              <th>Dernier mouvement</th>
              <th className="r">Mouvements</th>
              <th className="r">Variation</th>
              <th className="r">{party === 'supplier' ? 'Solde dû' : 'Doit'}</th>
            </tr>
          </thead>
          <tbody>
            {data.data?.map((r) => (
              <tr key={r.id}>
                <td className="muted">{r.code}</td>
                <td>{r.name}</td>
                <td>{r.phone}</td>
                <td>{r.last_at.length > 10 ? dateTime(r.last_at) : dateFr(r.last_at)}</td>
                <td className="r">{r.movements}</td>
                <td className={`r ${r.change > 0 ? 'neg' : r.change < 0 ? 'pos' : ''}`}>
                  {r.change > 0 ? '+' : ''}
                  {fcfa(r.change)}
                </td>
                <td className="r b">{fcfa(r.balance)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="muted small">Variation positive : la dette a augmenté ({party === 'supplier' ? 'nouvelle facture' : 'achat à crédit'}) ; négative : un règlement l'a diminuée.</p>
    </>
  );
}

const CREDIT_LABELS = { over: 'Plafond dépassé', near: 'Proche du plafond', ok: 'Dans le plafond', no_limit: 'Sans plafond' } as const;

/** Contrôle des plafonds d'autorisation des clients à crédit. */
export function CreditControl() {
  const data = useLoad(() => call('controls.creditControl'), []);
  const d = data.data;
  return (
    <>
      {d && (
        <div className="kpis">
          <div className={d.counts.over ? 'neg' : ''}>
            <small>Plafond dépassé</small>
            <strong>{d.counts.over}</strong>
          </div>
          <div>
            <small>À plus de 80 % du plafond</small>
            <strong>{d.counts.near}</strong>
          </div>
          <div className={d.counts.noLimit ? 'neg' : ''}>
            <small>Doivent sans plafond</small>
            <strong>{d.counts.noLimit}</strong>
          </div>
          <div>
            <small>Clients à crédit</small>
            <strong>{d.rows.length}</strong>
          </div>
        </div>
      )}
      {d && d.rows.length === 0 ? (
        <Empty>Aucun client n'a de plafond de crédit.</Empty>
      ) : (
        <table className="list compact report">
          <thead>
            <tr>
              <th>Code</th>
              <th>Client</th>
              <th>Téléphone</th>
              <th className="r">Plafond</th>
              <th className="r">Doit</th>
              <th>Utilisation</th>
              <th className="r">Disponible</th>
              <th className="r">En retard</th>
              <th>État</th>
            </tr>
          </thead>
          <tbody>
            {d?.rows.map((r) => (
              <tr key={r.id}>
                <td className="muted">{r.code}</td>
                <td>{r.name}</td>
                <td>{r.phone}</td>
                <td className="r">{r.credit_limit ? fcfa(r.credit_limit) : '—'}</td>
                <td className="r b">{fcfa(r.balance)}</td>
                <td className="share">
                  {r.used !== null && (
                    <>
                      <div className={`share-bar ${r.status}`} style={{ width: `${Math.min(100, Math.max(0, r.used * 100))}%` }} />
                      <span>{Math.round(r.used * 100)} %</span>
                    </>
                  )}
                </td>
                <td className="r">{r.credit_limit ? fcfa(r.available) : ''}</td>
                <td className={`r ${r.overdue ? 'neg' : ''}`}>{r.overdue ? fcfa(r.overdue) : ''}</td>
                <td>
                  <span className={`tag ${r.status === 'over' ? 'rupture' : r.status === 'ok' ? 'normal' : 'alerte'}`}>{CREDIT_LABELS[r.status]}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="muted small">Au-delà du plafond, une vente à crédit demande le code du gérant ; chaque dépassement accordé figure dans Vente › Alertes sur les ventes.</p>
    </>
  );
}

/** Rayonnage des articles : rayons et familles avec articles, stock et ruptures. */
export function Shelving({ canEdit }: { canEdit: boolean }) {
  const data = useLoad(() => call('stock.shelving'), []);
  const departments = useLoad(() => call('catalogue.departments'), []);
  const d = data.data;
  const [adding, setAdding] = useState<'department' | 'family' | null>(null);
  let last = '';
  return (
    <>
      <div className="filters">
        {d && (
          <span className="muted">
            {d.articles} articles actifs · valeur du stock {fcfa(d.value)}
          </span>
        )}
        {canEdit && (
          <>
            <button style={{ marginLeft: 'auto' }} onClick={() => setAdding('department')}>
              Nouveau rayon
            </button>
            <button onClick={() => setAdding('family')} disabled={!departments.data?.length}>
              Nouvelle famille
            </button>
          </>
        )}
      </div>
      <table className="list compact">
        <thead>
          <tr>
            <th>Rayon</th>
            <th>Famille</th>
            <th className="r">Articles</th>
            <th className="r">En stock</th>
            <th className="r">Sans stock</th>
            <th className="r">Valeur du stock</th>
            <th className="r">Part</th>
          </tr>
        </thead>
        <tbody>
          {d?.rows.map((r) => {
            const first = r.department !== last;
            last = r.department;
            return (
              <tr key={`${r.department_id}-${r.family_id}`} className={first ? 'group-start' : ''}>
                <td className="b">{first ? r.department : ''}</td>
                <td>{r.family}</td>
                <td className="r">{r.articles}</td>
                <td className="r">{r.in_stock}</td>
                <td className={`r ${r.out_of_stock ? 'neg' : ''}`}>{r.out_of_stock || ''}</td>
                <td className="r">{fcfa(r.value)}</td>
                <td className="r muted">{d.value ? `${((r.value / d.value) * 100).toFixed(1).replace('.', ',')} %` : ''}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {adding && (
        <ShelfDialog
          kind={adding}
          departments={departments.data ?? []}
          onClose={() => setAdding(null)}
          onSaved={() => {
            setAdding(null);
            data.reload();
            departments.reload();
          }}
        />
      )}
    </>
  );
}

function ShelfDialog({
  kind,
  departments,
  onClose,
  onSaved,
}: {
  kind: 'department' | 'family';
  departments: { id: string; name: string }[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [departmentId, setDepartmentId] = useState('');
  const [name, setName] = useState('');
  return (
    <Modal title={kind === 'department' ? 'Nouveau rayon' : 'Nouvelle famille'} onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            if (kind === 'department') await call('catalogue.createDepartment', name);
            else await call('catalogue.createFamily', departmentId, name);
            toast.ok(kind === 'department' ? 'Rayon créé' : 'Famille créée');
            onSaved();
          } catch (err) {
            toast.error(err);
          }
        }}
      >
        {kind === 'family' && (
          <Field label="Rayon">
            <select value={departmentId} onChange={(e) => setDepartmentId(e.target.value)} required>
              <option value="">Choisir…</option>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field label="Nom">
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={kind === 'department' ? 'Boissons, Épicerie, Hygiène…' : 'Sodas, Bières, Eaux…'} required />
        </Field>
        <div className="actions">
          <button type="button" onClick={onClose}>
            Annuler
          </button>
          <button type="submit" className="primary">
            Créer
          </button>
        </div>
      </form>
    </Modal>
  );
}
