import { useMemo, useState } from 'react';
import { type Result, call } from '../api';
import { Empty, Modal, fcfa, qty, today, useCan, useLoad, useToast } from '../ui';
import { saveXlsx } from './Controls';
import { tx } from '../tax';
import { SavedFilters } from './savedFilters';

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
  ['field_rep', 'Commercial'],
  ['field_zone', 'Zone'],
  ['field_city', 'Ville'],
  ['payment', 'Paiement'],
];

/** Rapport en colonnes : regroupement en lignes, une période par colonne. */
type MatrixDim = Result<'reports.matrix'>['dimension'];
type Step = Result<'reports.matrix'>['step'];
type Measure = Result<'reports.matrix'>['measure'];
const MATRIX_DIMS = DIMENSIONS.filter(([d]) => !['day', 'week', 'month', 'hour', 'weekday', 'payment'].includes(d)) as [MatrixDim, string][];
const STEPS: [Step, string][] = [
  ['day30', '30 derniers jours'],
  ['week12', '12 dernières semaines'],
  ['month12', '12 derniers mois'],
  ['year10', '10 dernières années'],
];
const MEASURES: [Measure, string][] = [
  ['ttc', 'CA TTC'],
  ['margin', 'Marge HT'],
  ['tickets', 'Tickets'],
  ['qty', 'Quantités (articles)'],
];

/** Critères gardés par un filtre enregistré. */
type Saved = { mode: 'table' | 'matrix'; presetId: string; from: string; to: string; dimension: Dimension; compare: Compare; step: Step; measure: Measure };
const TIME = new Set<Dimension>(['day', 'week', 'month', 'hour', 'weekday']);
const RANKED = new Set<Dimension>(['department', 'family', 'article']);

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
  const can = useCan();
  // « evolution » : mois par mois depuis janvier, comparé à l'an dernier.
  const yearly = view === 'evolution';
  const [period, setPeriod] = useState(() => preset(yearly ? 'year' : 'month'));
  const [presetId, setPresetId] = useState(yearly ? 'year' : 'month');
  const [dimension, setDimension] = useState<Dimension>(yearly ? 'month' : DIMENSIONS.some(([d]) => d === view) ? (view as Dimension) : 'department');
  const [compare, setCompare] = useState<Compare>(yearly ? 'last_year' : 'previous');
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean } | null>(null);
  const [mode, setMode] = useState<'table' | 'matrix'>(view === 'matrix' ? 'matrix' : 'table');
  const [step, setStep] = useState<Step>('month12');
  const [measure, setMeasure] = useState<Measure>('ttc');
  const input = { from: period.from, to: period.to, dimension, compare: compare || null };
  const report = useLoad(() => (mode === 'table' ? call('reports.sales', input) : Promise.resolve(undefined)), [period.from, period.to, dimension, compare, mode]);
  const saved: Saved = { mode, presetId, from: period.from, to: period.to, dimension, compare, step, measure };
  const applySaved = (p: Saved) => {
    setMode(p.mode === 'matrix' ? 'matrix' : 'table');
    if (p.presetId && p.presetId !== 'custom') {
      setPresetId(p.presetId);
      setPeriod(preset(p.presetId));
    } else if (p.from && p.to) {
      setPresetId('custom');
      setPeriod({ from: p.from, to: p.to });
    }
    if (DIMENSIONS.some(([d]) => d === p.dimension)) setDimension(p.dimension);
    setCompare(p.compare ?? '');
    if (STEPS.some(([k]) => k === p.step)) setStep(p.step);
    if (MEASURES.some(([k]) => k === p.measure)) setMeasure(p.measure);
    setSort(null);
  };
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
  // Palmarès : rang au chiffre d'affaires et classe ABC (A : 80 % du CA, B : 15 %, C : le reste).
  const ranked = RANKED.has(dimension);
  const abc = useMemo(() => {
    const out = new Map<string, { rank: number; cls: 'A' | 'B' | 'C' }>();
    const list = [...(r?.rows ?? [])].sort((a, b) => b.revenueTtc - a.revenueTtc);
    const total = list.reduce((t, x) => t + Math.max(0, x.revenueTtc), 0);
    let cumul = 0;
    list.forEach((x, i) => {
      const before = total ? cumul / total : 1;
      cumul += Math.max(0, x.revenueTtc);
      out.set(x.key, { rank: i + 1, cls: before < 0.8 ? 'A' : before < 0.95 ? 'B' : 'C' });
    });
    return out;
  }, [r]);
  const [unsold, setUnsold] = useState(false);

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
        <div className="seg">
          <button className={mode === 'table' ? 'active' : ''} onClick={() => setMode('table')}>
            Tableau
          </button>
          <button className={mode === 'matrix' ? 'active' : ''} onClick={() => (setMode('matrix'), TIME.has(dimension) || dimension === 'payment' ? setDimension('department') : null)}>
            En colonnes
          </button>
        </div>
        <SavedFilters screen="reports" current={saved} onApply={applySaved} />
        <button
          className="primary"
          hidden={mode === 'matrix'}
          disabled={!r || !can('report_export')}
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
      {mode === 'matrix' && <Matrix dimension={MATRIX_DIMS.some(([d]) => d === dimension) ? (dimension as MatrixDim) : 'department'} step={step} measure={measure} onDimension={setDimension} onStep={setStep} onMeasure={setMeasure} />}
      {mode === 'table' && (
      <>
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
            <small>{tx("Chiffre d'affaires TTC")}</small>
            <strong>{fcfa(t.revenueTtc)}</strong>
            <Trend now={t.revenueTtc} before={p?.revenueTtc} />
          </div>
          <div>
            <small>{tx('Marge brute HT')}</small>
            <strong>{fcfa(t.margin)}</strong>
            <small>
              {pct(t.revenueHt ? t.margin / t.revenueHt : null)}{tx(' du CA HT ')}<Trend now={t.margin} before={p?.margin} />
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

      <div className="filters">
        <div className="seg dims">
          {DIMENSIONS.map(([d, label]) => (
            <button key={d} className={dimension === d ? 'active' : ''} onClick={() => (setDimension(d), setSort(null))}>
              {label}
            </button>
          ))}
        </div>
        <button style={{ marginLeft: 'auto' }} onClick={() => setUnsold(true)} title="Articles actifs qui ne se sont pas vendus sur la période">
          Produits sans vente
        </button>
      </div>
      {unsold && <UnsoldDialog from={period.from} to={period.to} onClose={() => setUnsold(false)} />}

      {r && rows.length === 0 ? (
        <Empty>Aucune vente sur cette période. Choisissez une autre période en haut.</Empty>
      ) : (
        <table className="list compact report">
          <thead>
            <tr>
              {ranked && <th className="r" title="Rang au chiffre d'affaires">N°</th>}
              {ranked && <th title="A : les ventes qui font 80 % du chiffre d'affaires ; B : les 15 % suivants ; C : le reste">Classe</th>}
              {dimension === 'article' && <th>Code</th>}
              {th('label', DIMENSIONS.find(([d]) => d === dimension)![1], false)}
              {th('tickets', 'Tickets')}
              {dimension === 'article' && th('qty', 'Quantité')}
              {th('revenueTtc', tx('CA TTC'))}
              <th className="r">Part</th>
              {!isPayment && th('margin', tx('Marge HT'))}
              {!isPayment && th('rate', 'Taux')}
              {th('returnsTtc', 'Retours')}
              {showPrev && <th className="r">CA comparé</th>}
              {showPrev && th('evolution', 'Évolution')}
            </tr>
          </thead>
          <tbody>
            {rows.map((x) => (
              <tr key={x.key}>
                {ranked && <td className="r muted">{abc.get(x.key)?.rank}</td>}
                {ranked && <td><span className={`tag abc-${abc.get(x.key)?.cls}`}>{abc.get(x.key)?.cls}</span></td>}
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
                {ranked && <td />}
                {ranked && <td />}
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
      </>
      )}
      <p className="muted small">
        Marge = {tx('CA HT')} − coût d'achat moyen (CMUP) des articles au moment de la vente. Les retours sont déduits au coût de la vente d'origine.
      </p>
    </div>
  );
}

/**
 * Rapport en colonnes : le regroupement choisi en lignes, une colonne par jour,
 * semaine, mois ou année, et le total. Une case vide : rien sur la période.
 */
function Matrix({
  dimension,
  step,
  measure,
  onDimension,
  onStep,
  onMeasure,
}: {
  dimension: MatrixDim;
  step: Step;
  measure: Measure;
  onDimension: (d: MatrixDim) => void;
  onStep: (s: Step) => void;
  onMeasure: (m: Measure) => void;
}) {
  const toast = useToast();
  const can = useCan();
  const input = { dimension, step, measure };
  const m = useLoad(() => call('reports.matrix', input), [dimension, step, measure]).data;
  const show = (v: number) => (!v ? '' : measure === 'qty' ? qty(v) : measure === 'tickets' ? String(v) : fcfa(v));
  return (
    <>
      <div className="filters">
        <select value={step} onChange={(e) => onStep(e.target.value as Step)}>
          {STEPS.map(([k, l]) => (
            <option key={k} value={k}>
              {l}
            </option>
          ))}
        </select>
        <select value={measure} onChange={(e) => onMeasure(e.target.value as Measure)}>
          {MEASURES.map(([k, l]) => (
            <option key={k} value={k}>
              {l}
            </option>
          ))}
        </select>
        <div className="seg dims">
          {MATRIX_DIMS.map(([d, label]) => (
            <button key={d} className={dimension === d ? 'active' : ''} onClick={() => onDimension(d)}>
              {label}
            </button>
          ))}
        </div>
        <button
          className="primary"
          style={{ marginLeft: 'auto' }}
          disabled={!m || !can('report_export')}
          onClick={async () => {
            try {
              const bytes = await call('reports.matrixXlsx', input);
              const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
              const a = document.createElement('a');
              a.href = url;
              a.download = `ventes-en-colonnes-${dimension}-${step}.xlsx`;
              a.click();
              setTimeout(() => URL.revokeObjectURL(url), 1000);
            } catch (err) {
              toast.error(err);
            }
          }}
        >
          Exporter vers Excel
        </button>
      </div>
      {m && m.rows.length === 0 ? (
        <Empty>Aucune vente sur ces périodes.</Empty>
      ) : (
        m && (
          <div className="matrix-wrap">
            <table className="list compact report">
              <thead>
                <tr>
                  <th>{DIMENSIONS.find(([d]) => d === dimension)?.[1]}</th>
                  {m.columns.map((c) => (
                    <th key={c.key} className="r nowrap">
                      {c.label}
                    </th>
                  ))}
                  <th className="r">Total</th>
                </tr>
              </thead>
              <tbody>
                {m.rows.map((r) => (
                  <tr key={r.key}>
                    <td className="nowrap">{r.label}</td>
                    {r.values.map((v, i) => (
                      <td key={m.columns[i]!.key} className={`r nowrap ${v ? '' : 'zero'}`}>
                        {show(v)}
                      </td>
                    ))}
                    <td className="r nowrap">
                      <strong>{show(r.total)}</strong>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="total">
                  <td>Total</td>
                  {m.totals.map((v, i) => (
                    <td key={m.columns[i]!.key} className="r nowrap">
                      {show(v)}
                    </td>
                  ))}
                  <td className="r nowrap">{show(m.total)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        )
      )}
    </>
  );
}

/** Produits sans vente sur la période : le stock qui dort, du plus cher au moins cher. */
function UnsoldDialog({ from, to, onClose }: { from: string; to: string; onClose: () => void }) {
  const list = useLoad(() => call('reports.unsold', from, to), [from, to]);
  const rows = list.data ?? [];
  const value = rows.reduce((t, x) => t + x.value, 0);
  const fr = (d: string) => d.split('-').reverse().join('/');
  return (
    <Modal title={`Produits sans vente du ${fr(from)} au ${fr(to)}`} onClose={onClose} wide>
      {list.data && (
        <p>
          {rows.length} produit{rows.length > 1 ? 's' : ''} actif{rows.length > 1 ? 's' : ''} sans vente ; stock immobilisé : <b>{fcfa(value)}</b> au coût moyen.
        </p>
      )}
      <div style={{ maxHeight: 420, overflowY: 'auto' }}>
        <table className="list compact">
          <thead>
            <tr>
              <th>Code</th>
              <th>Article</th>
              <th>Rayon</th>
              <th className="r">Stock</th>
              <th className="r">Valeur</th>
              <th>Dernière vente</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((x) => (
              <tr key={x.id}>
                <td className="muted">{x.code}</td>
                <td>{x.name}</td>
                <td>{x.department ?? ''}</td>
                <td className="r">{qty(x.qty, x.unit as 'piece' | 'kg' | 'litre')}</td>
                <td className="r">{fcfa(x.value)}</td>
                <td>{x.last_sale ? fr(x.last_sale) : <small className="muted">jamais vendu</small>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="actions">
        <button
          onClick={() =>
            saveXlsx(`produits-sans-vente-${from}-au-${to}.xlsx`, {
              name: 'Sans vente',
              title: [`Produits sans vente du ${fr(from)} au ${fr(to)}`],
              columns: [
                { header: 'Code', width: 14 },
                { header: 'Article', width: 36 },
                { header: 'Rayon', width: 18 },
                { header: 'Stock', format: 'qty' },
                { header: 'Valeur', format: 'money', width: 14 },
                { header: 'Dernière vente', width: 14 },
              ],
              rows: rows.map((x) => [x.code, x.name, x.department, x.qty / 1000, x.value, x.last_sale ? fr(x.last_sale) : 'jamais']),
            })
          }
          disabled={!rows.length}
        >
          Exporter vers Excel
        </button>
        <button className="primary" onClick={onClose}>
          Fermer
        </button>
      </div>
    </Modal>
  );
}
