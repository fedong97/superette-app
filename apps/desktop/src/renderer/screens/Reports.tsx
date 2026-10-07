import { useMemo, useState } from 'react';
import { type Result, call } from '../api';
import { Empty, fcfa, qty, today, useLoad, useToast } from '../ui';

type Report = Result<'reports.sales'>;
type Row = Report['rows'][number];
type Dimension = Report['dimension'];
type Compare = 'previous' | 'last_year' | '';

const DIMENSIONS: [Dimension, string][] = [
  ['day', 'Jour'],
  ['week', 'Semaine'],
  ['month', 'Mois'],
  ['hour', 'Heure'],
  ['weekday', 'Jour de la semaine'],
  ['department', 'Rayon'],
  ['family', 'Famille'],
  ['article', 'Article'],
  ['cashier', 'Caissier'],
  ['register', 'Caisse'],
  ['customer', 'Client'],
  ['payment', 'Paiement'],
];
const TIME = new Set<Dimension>(['day', 'week', 'month', 'hour', 'weekday']);

const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** Périodes toutes faites, calculées à partir d'aujourd'hui. */
function preset(id: string): { from: string; to: string } {
  const now = new Date();
  const d = (y: number, m: number, day: number) => ymd(new Date(y, m, day));
  const y = now.getFullYear();
  const m = now.getMonth();
  switch (id) {
    case 'yesterday':
      return { from: d(y, m, now.getDate() - 1), to: d(y, m, now.getDate() - 1) };
    case 'week': {
      const monday = now.getDate() - ((now.getDay() + 6) % 7);
      return { from: d(y, m, monday), to: today() };
    }
    case '7days':
      return { from: d(y, m, now.getDate() - 6), to: today() };
    case 'month':
      return { from: d(y, m, 1), to: today() };
    case 'lastmonth':
      return { from: d(y, m - 1, 1), to: d(y, m, 0) };
    case 'year':
      return { from: d(y, 0, 1), to: today() };
    default:
      return { from: today(), to: today() };
  }
}

const PRESETS: [string, string][] = [
  ['today', "Aujourd'hui"],
  ['yesterday', 'Hier'],
  ['week', 'Cette semaine'],
  ['7days', '7 derniers jours'],
  ['month', 'Ce mois'],
  ['lastmonth', 'Mois dernier'],
  ['year', 'Cette année'],
];

const pct = (v: number | null) => (v === null || !Number.isFinite(v) ? '—' : `${(v * 100).toFixed(1).replace('.', ',')} %`);
const evolution = (now: number, before: number | null | undefined) => (before ? (now - before) / Math.abs(before) : null);

function Trend({ now, before }: { now: number; before: number | null | undefined }) {
  const e = evolution(now, before);
  if (e === null) return null;
  return <small className={e >= 0 ? 'trend up' : 'trend down'}>{`${e >= 0 ? '▲' : '▼'} ${pct(Math.abs(e))}`}</small>;
}

type SortKey = 'label' | 'tickets' | 'qty' | 'revenueTtc' | 'margin' | 'rate' | 'returnsTtc' | 'evolution';

/**
 * Rapports de ventes : une période (avec comparaison), un regroupement au
 * choix et l'export Excel complet pour le comptable (synthèse, regroupement,
 * paiements, TVA, détail des lignes).
 */
export function Reports({ view }: { view?: string }) {
  const toast = useToast();
  // « evolution » : mois par mois depuis janvier, comparé à l'an dernier.
  const yearly = view === 'evolution';
  const [period, setPeriod] = useState(() => preset(yearly ? 'year' : 'month'));
  const [presetId, setPresetId] = useState(yearly ? 'year' : 'month');
  const [dimension, setDimension] = useState<Dimension>(yearly ? 'month' : DIMENSIONS.some(([d]) => d === view) ? (view as Dimension) : 'department');
  const [compare, setCompare] = useState<Compare>(yearly ? 'last_year' : 'previous');
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean } | null>(null);
  const input = { from: period.from, to: period.to, dimension, compare: compare || null };
  const report = useLoad(() => call('reports.sales', input), [period.from, period.to, dimension, compare]);
  const r = report.data;
  const t = r?.totals;
  const p = r?.previous?.totals;
  const isPayment = dimension === 'payment';
  const showPrev = Boolean(r?.previous) && !TIME.has(dimension);
  const totalForShare = r ? (isPayment ? r.rows.reduce((s, x) => s + x.revenueTtc, 0) : r.totals.revenueTtc) : 0;

  const rows = useMemo(() => {
    const list = [...(r?.rows ?? [])];
    if (!sort) return list;
    const val = (x: Row): number | string => {
      if (sort.key === 'label') return x.label.toLowerCase();
      if (sort.key === 'rate') return x.revenueHt ? (x.margin ?? 0) / x.revenueHt : -Infinity;
      if (sort.key === 'evolution') return evolution(x.revenueTtc, x.previousTtc) ?? -Infinity;
      return (x[sort.key] as number | null) ?? -Infinity;
    };
    return list.sort((a, b) => {
      const va = val(a);
      const vb = val(b);
      const c = va < vb ? -1 : va > vb ? 1 : 0;
      return sort.desc ? -c : c;
    });
  }, [r, sort]);
  const maxTtc = Math.max(1, ...rows.map((x) => Math.abs(x.revenueTtc)));

  const th = (key: SortKey, label: string, right = true) => (
    <th
      className={`${right ? 'r ' : ''}sortable`}
      onClick={() => setSort(sort?.key === key ? { key, desc: !sort.desc } : { key, desc: key !== 'label' })}
      title="Trier"
    >
      {label}
      {sort?.key === key ? (sort.desc ? ' ▼' : ' ▲') : ''}
    </th>
  );

  return (
    <div className="page">
      <header className="page-head">
        <h1>Rapports de ventes</h1>
        <button
          className="primary"
          disabled={!r}
          onClick={async () => {
            try {
              const bytes = await call('reports.salesXlsx', input);
              const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
              const a = document.createElement('a');
              a.href = url;
              a.download = `ventes-${dimension}-${period.from}-au-${period.to}.xlsx`;
              a.click();
              setTimeout(() => URL.revokeObjectURL(url), 1000);
            } catch (err) {
              toast.error(err);
            }
          }}
        >
          Exporter vers Excel
        </button>
      </header>
      <div className="filters">
        <select
          value={presetId}
          onChange={(e) => {
            setPresetId(e.target.value);
            if (e.target.value !== 'custom') setPeriod(preset(e.target.value));
            // Depuis le 1er janvier : on compare à la même période de l'an dernier.
            if (e.target.value === 'year' && compare === 'previous') setCompare('last_year');
          }}
        >
          {PRESETS.map(([id, label]) => (
            <option key={id} value={id}>
              {label}
            </option>
          ))}
          <option value="custom">Période libre</option>
        </select>
        <input type="date" value={period.from} onChange={(e) => (setPresetId('custom'), setPeriod({ ...period, from: e.target.value }))} />
        <span className="muted">au</span>
        <input type="date" value={period.to} onChange={(e) => (setPresetId('custom'), setPeriod({ ...period, to: e.target.value }))} />
        <select value={compare} onChange={(e) => setCompare(e.target.value as Compare)} title="Période de comparaison">
          <option value="">Sans comparaison</option>
          <option value="previous">Comparer à la période précédente</option>
          <option value="last_year">Comparer à l'an dernier</option>
        </select>
        {r?.previous && (
          <span className="muted">
            comparé au {r.previous.from.split('-').reverse().join('/')} – {r.previous.to.split('-').reverse().join('/')}
          </span>
        )}
      </div>

      {t && (
        <div className="kpis kpis-6">
          <div>
            <small>Chiffre d'affaires TTC</small>
            <strong>{fcfa(t.revenueTtc)}</strong>
            <Trend now={t.revenueTtc} before={p?.revenueTtc} />
          </div>
          <div>
            <small>Marge brute HT</small>
            <strong>{fcfa(t.margin)}</strong>
            <small>
              {pct(t.revenueHt ? t.margin / t.revenueHt : null)} du CA HT <Trend now={t.margin} before={p?.margin} />
            </small>
          </div>
          <div>
            <small>Tickets</small>
            <strong>{t.tickets}</strong>
            <Trend now={t.tickets} before={p?.tickets} />
          </div>
          <div>
            <small>Panier moyen</small>
            <strong>{fcfa(t.averageBasket)}</strong>
            <Trend now={t.averageBasket} before={p?.averageBasket} />
          </div>
          <div>
            <small>Retours</small>
            <strong>{fcfa(-t.returnsTtc)}</strong>
          </div>
          <div>
            <small>Remises et promotions</small>
            <strong>{fcfa(t.discounts + t.promotions)}</strong>
          </div>
        </div>
      )}

      <div className="seg dims">
        {DIMENSIONS.map(([d, label]) => (
          <button key={d} className={dimension === d ? 'active' : ''} onClick={() => (setDimension(d), setSort(null))}>
            {label}
          </button>
        ))}
      </div>

      {r && rows.length === 0 ? (
        <Empty>Aucune vente sur cette période.</Empty>
      ) : (
        <table className="list compact report">
          <thead>
            <tr>
              {dimension === 'article' && <th>Code</th>}
              {th('label', DIMENSIONS.find(([d]) => d === dimension)![1], false)}
              {th('tickets', 'Tickets')}
              {dimension === 'article' && th('qty', 'Quantité')}
              {th('revenueTtc', 'CA TTC')}
              <th className="r">Part</th>
              {!isPayment && th('margin', 'Marge HT')}
              {!isPayment && th('rate', 'Taux')}
              {th('returnsTtc', 'Retours')}
              {showPrev && <th className="r">CA comparé</th>}
              {showPrev && th('evolution', 'Évolution')}
            </tr>
          </thead>
          <tbody>
            {rows.map((x) => (
              <tr key={x.key}>
                {dimension === 'article' && <td className="muted">{x.code}</td>}
                <td>{x.label}</td>
                <td className="r">{isPayment && !x.tickets ? '' : x.tickets}</td>
                {dimension === 'article' && <td className="r">{x.qty === null ? '' : qty(x.qty, x.unit ?? undefined)}</td>}
                <td className="r share">
                  <div className="share-bar" style={{ width: `${(Math.max(0, x.revenueTtc) / maxTtc) * 100}%` }} />
                  <span>{fcfa(x.revenueTtc)}</span>
                </td>
                <td className="r muted">{pct(totalForShare ? x.revenueTtc / totalForShare : null)}</td>
                {!isPayment && <td className={`r ${(x.margin ?? 0) < 0 ? 'neg' : ''}`}>{fcfa(x.margin ?? 0)}</td>}
                {!isPayment && <td className="r">{pct(x.revenueHt ? (x.margin ?? 0) / x.revenueHt : null)}</td>}
                <td className="r">{x.returnsTtc ? fcfa(-x.returnsTtc) : ''}</td>
                {showPrev && <td className="r muted">{fcfa(x.previousTtc ?? 0)}</td>}
                {showPrev && (
                  <td className="r">
                    {x.previousTtc ? <Trend now={x.revenueTtc} before={x.previousTtc} /> : <small className="muted">nouveau</small>}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
          {t && (
            <tfoot>
              <tr>
                {dimension === 'article' && <td />}
                <td>Total</td>
                <td className="r">{isPayment ? '' : t.tickets}</td>
                {dimension === 'article' && <td />}
                <td className="r">{fcfa(totalForShare)}</td>
                <td className="r">100 %</td>
                {!isPayment && <td className="r">{fcfa(t.margin)}</td>}
                {!isPayment && <td className="r">{pct(t.revenueHt ? t.margin / t.revenueHt : null)}</td>}
                <td className="r">{t.returnsTtc ? fcfa(-t.returnsTtc) : ''}</td>
                {showPrev && <td className="r">{fcfa(rows.reduce((s, x) => s + (x.previousTtc ?? 0), 0))}</td>}
                {showPrev && <td />}
              </tr>
            </tfoot>
          )}
        </table>
      )}
      <p className="muted small">
        Marge = CA HT − coût d'achat moyen (CMUP) des articles au moment de la vente. Les retours sont déduits au coût de la vente d'origine.
      </p>
    </div>
  );
}
