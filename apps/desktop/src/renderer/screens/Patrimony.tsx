import { useState } from 'react';
import { type Result, call } from '../api';
import { Empty, dateFr, fcfa, useCan, useLoad } from '../ui';

type Point = Result<'patrimony.series'>['points'][number];

const MONTHS = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];
const monthLabel = (d: string) => `${MONTHS[Number(d.slice(5, 7)) - 1]} ${d.slice(2, 4)}`;
/** Montant court pour l'axe : 12,5 M, 850 k. */
const short = (v: number) => {
  const a = Math.abs(v);
  if (a >= 1e6) return `${(v / 1e6).toFixed(a >= 1e7 ? 0 : 1).replace('.', ',')} M`;
  if (a >= 1e3) return `${Math.round(v / 1e3)} k`;
  return String(v);
};

/**
 * Courbe du patrimoine : ce que possède l'entreprise à chaque fin de mois
 * (trésorerie + créances clients + stock − dettes fournisseurs).
 */
export function Patrimony() {
  const can = useCan();
  const [months, setMonths] = useState(12);
  const [scope, setScope] = useState('store');
  const companies = useLoad(() => (can('companies') ? call('companies.list') : Promise.resolve([])), []);
  const data = useLoad(
    () => call('patrimony.series', scope === 'store' ? {} : scope === 'all' ? { allStores: true } : { companyId: scope }, months),
    [scope, months],
  );
  const points = data.data?.points ?? [];
  const last = points.at(-1);
  const first = points[0];
  return (
    <>
      <div className="filters">
        {can('companies') && (
          <select value={scope} onChange={(e) => setScope(e.target.value)}>
            <option value="store">Ce magasin</option>
            <option value="all">Tous les magasins</option>
            {(companies.data ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                Société {c.name}
              </option>
            ))}
          </select>
        )}
        <select value={months} onChange={(e) => setMonths(Number(e.target.value))}>
          <option value={6}>6 mois</option>
          <option value={12}>12 mois</option>
          <option value={24}>24 mois</option>
        </select>
        <span className="muted">Trésorerie + créances clients + stock (prix de revient) − dettes fournisseurs, à chaque fin de mois.</span>
      </div>
      {!last ? (
        <Empty>Chargement…</Empty>
      ) : (
        <>
          <div className="kpis">
            <div>
              <small>Patrimoine au {dateFr(last.date)}</small>
              <strong>{fcfa(last.patrimony)}</strong>
              {first && <small className={last.patrimony >= first.patrimony ? 'pos' : 'neg'}>{`${last.patrimony >= first.patrimony ? '+' : '−'}${fcfa(Math.abs(last.patrimony - first.patrimony))} depuis ${monthLabel(first.date)}`}</small>}
            </div>
            <div>
              <small>Trésorerie</small>
              <strong>{fcfa(last.treasury)}</strong>
            </div>
            <div>
              <small>Créances clients</small>
              <strong>{fcfa(last.receivables)}</strong>
            </div>
            <div>
              <small>Stock</small>
              <strong>{fcfa(last.stock)}</strong>
            </div>
            <div>
              <small>Dettes fournisseurs</small>
              <strong>{fcfa(last.payables)}</strong>
            </div>
          </div>
          <Curve points={points} />
          <table className="list compact">
            <thead>
              <tr>
                <th>Fin de mois</th>
                <th className="r">Trésorerie</th>
                <th className="r">Créances</th>
                <th className="r">Stock</th>
                <th className="r">Dettes</th>
                <th className="r">Patrimoine</th>
              </tr>
            </thead>
            <tbody>
              {[...points].reverse().map((p) => (
                <tr key={p.date}>
                  <td>{dateFr(p.date)}</td>
                  <td className="r">{fcfa(p.treasury)}</td>
                  <td className="r">{fcfa(p.receivables)}</td>
                  <td className="r">{fcfa(p.stock)}</td>
                  <td className="r">{fcfa(p.payables)}</td>
                  <td className="r b">{fcfa(p.patrimony)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </>
  );
}

/** Courbe en SVG : une seule série, axe recessif, survol d'un mois pour voir son détail. */
function Curve({ points }: { points: Point[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 760;
  const H = 240;
  const pad = { l: 56, r: 16, t: 16, b: 28 };
  const values = points.map((p) => p.patrimony);
  let lo = Math.min(0, ...values);
  let hi = Math.max(...values);
  if (hi === lo) hi = lo + 1;
  const span = hi - lo;
  lo -= span * 0.05;
  hi += span * 0.05;
  const x = (i: number) => pad.l + (points.length > 1 ? (i * (W - pad.l - pad.r)) / (points.length - 1) : 0);
  const y = (v: number) => pad.t + ((hi - v) * (H - pad.t - pad.b)) / (hi - lo);
  const ticks = [0, 1, 2, 3].map((k) => lo + ((hi - lo) * k) / 3);
  const path = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.patrimony).toFixed(1)}`).join(' ');
  const h = hover !== null ? points[hover] : null;
  return (
    <div className="patrimony-chart" style={{ position: 'relative', maxWidth: W }}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Évolution du patrimoine" onMouseLeave={() => setHover(null)}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} stroke="var(--line)" strokeWidth={1} />
            <text x={pad.l - 6} y={y(t) + 4} textAnchor="end" fontSize={11} fill="var(--muted)">
              {short(Math.round(t))}
            </text>
          </g>
        ))}
        {lo < 0 && <line x1={pad.l} x2={W - pad.r} y1={y(0)} y2={y(0)} stroke="var(--muted)" strokeWidth={1} />}
        {points.map((p, i) => (
          <text key={p.date} x={x(i)} y={H - 8} textAnchor="middle" fontSize={11} fill="var(--muted)">
            {points.length > 12 && i % 2 ? '' : monthLabel(p.date)}
          </text>
        ))}
        {h && hover !== null && <line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={H - pad.b} stroke="var(--muted)" strokeWidth={1} strokeDasharray="3 3" />}
        <path d={path} fill="none" stroke="var(--brand)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        {points.map((p, i) => (
          <g key={p.date} onMouseEnter={() => setHover(i)}>
            <rect x={x(i) - (W - pad.l - pad.r) / Math.max(1, points.length - 1) / 2} y={pad.t} width={(W - pad.l - pad.r) / Math.max(1, points.length - 1)} height={H - pad.t - pad.b} fill="transparent" />
            <circle cx={x(i)} cy={y(p.patrimony)} r={hover === i ? 5 : 4} fill="var(--brand)" stroke="var(--panel)" strokeWidth={2} />
          </g>
        ))}
      </svg>
      {h && hover !== null && (
        <div
          className="chart-tip"
          style={{
            position: 'absolute',
            top: 8,
            left: `${(x(hover) / W) * 100}%`,
            transform: hover > points.length / 2 ? 'translateX(-105%)' : 'translateX(5%)',
            background: 'var(--panel)',
            border: '1px solid var(--line)',
            borderRadius: 'var(--radius)',
            padding: '6px 10px',
            fontSize: 12,
            pointerEvents: 'none',
            whiteSpace: 'nowrap',
          }}
        >
          <b>{dateFr(h.date)}</b>
          <div>Patrimoine : {fcfa(h.patrimony)}</div>
          <div className="muted">
            Trésorerie {fcfa(h.treasury)} · Créances {fcfa(h.receivables)} · Stock {fcfa(h.stock)} · Dettes {fcfa(h.payables)}
          </div>
        </div>
      )}
    </div>
  );
}
