/** Petits éléments des chiffres du jour, partagés par l'accueil et le tableau de bord. */

const WEEKDAY = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];

/**
 * Variation par rapport à hier à la même heure ; quand hier n'a rien (jour de
 * fermeture, première journée), par rapport au même jour de la semaine passée.
 */
export function Versus({ now, before, lastWeek, date, sameHour = true }: { now: number; before: number | undefined; lastWeek?: number; date?: string; sameHour?: boolean }) {
  const ref = before || lastWeek;
  if (!ref) return <span className="stat-trend flat">— vs hier</span>;
  const day = WEEKDAY[(date ? new Date(`${date}T12:00:00`) : new Date()).getDay()];
  const label = before ? 'vs hier' : `vs ${day} dernier`;
  const when = sameHour ? ' à la même heure' : '';
  const pct = ((now - ref) / Math.abs(ref)) * 100;
  const tone = Math.abs(pct) < 0.5 ? 'flat' : pct > 0 ? 'up' : 'down';
  return (
    <span className={`stat-trend ${tone}`} title={before ? `Par rapport à hier${when}` : `Hier sans vente : par rapport à ${day} dernier${when}`}>
      {tone === 'up' ? '↑' : tone === 'down' ? '↓' : '='} {Math.abs(pct).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} % {label}
    </span>
  );
}

/** Taux de marge du jour comparé à l'objectif des paramètres (0 : pas d'objectif). */
export function MarginRate({ rate, target }: { rate: number | null; target: number }) {
  if (rate === null) return <span className="stat-trend flat">taux —</span>;
  if (!target) return <span className="stat-trend flat">taux {rate} %</span>;
  return (
    <span className={`stat-trend ${rate >= target ? 'up' : 'down'}`} title="Objectif de marge réglable dans Paramètres › Ventes et caisse">
      taux {rate} % · objectif {target} %
    </span>
  );
}

/** Courbe du chiffre d'affaires cumulé heure par heure, en vert ONIX. */
export function RevenueSpark({ byHour, width = 120 }: { byHour: { hour: number; revenueTtc: number }[]; width?: number }) {
  if (!byHour.length) return null;
  const first = Math.min(...byHour.map((h) => h.hour));
  const last = Math.max(new Date().getHours(), ...byHour.map((h) => h.hour));
  let sum = 0;
  const pts = [0];
  for (let h = first; h <= last; h++) {
    sum += byHour.find((x) => x.hour === h)?.revenueTtc ?? 0;
    pts.push(sum);
  }
  const max = Math.max(1, sum);
  const height = 28;
  const step = width / Math.max(1, pts.length - 1);
  const y = (v: number) => (height - 3 - (v / max) * (height - 6)).toFixed(1);
  const line = pts.map((v, i) => `${(i * step).toFixed(1)},${y(v)}`).join(' ');
  return (
    <svg className="rev-spark" width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      <polyline points={line} />
      <circle cx={((pts.length - 1) * step).toFixed(1)} cy={y(sum)} r="2.5" />
    </svg>
  );
}

/** Haut d'axe arrondi (1, 2 ou 5 × 10ⁿ) au-dessus du plus grand montant. */
export function niceMax(v: number): number {
  const p = 10 ** Math.floor(Math.log10(Math.max(1, v)));
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((x) => x >= v) ?? 10 * p;
}

const short = (v: number) => (v >= 1_000_000 ? `${(v / 1_000_000).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} M` : v >= 1000 ? `${(v / 1000).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} k` : String(v));

/** Axe des montants à gauche d'un graphique en barres (haut, milieu, zéro). */
export function AmountAxis({ top }: { top: number }) {
  return (
    <div className="amount-axis" aria-hidden="true">
      {[top, (top * 3) / 4, top / 2, top / 4, 0].map((v) => (
        <span key={v}>{short(v)}</span>
      ))}
    </div>
  );
}

