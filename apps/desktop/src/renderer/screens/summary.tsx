import type { ReactNode } from 'react';

/**
 * Résumés en haut d'une liste (4 chiffres) et pastilles de filtre, avec les
 * cartes `.kpis` et le sélecteur `.seg` déjà utilisés par ONIX. Un résumé
 * cliquable choisit le filtre correspondant de la liste.
 */
export interface SummaryTile {
  label: string;
  value: ReactNode;
  note?: ReactNode;
  tone?: 'up' | 'down' | 'flat';
  onClick?: () => void;
  active?: boolean;
}

export function SummaryTiles({ tiles }: { tiles: SummaryTile[] }) {
  return (
    <div className="kpis summary-tiles">
      {tiles.map((t) => (
        <div
          key={t.label}
          className={`${t.onClick ? 'clickable' : ''} ${t.active ? 'on' : ''}`}
          role={t.onClick ? 'button' : undefined}
          tabIndex={t.onClick ? 0 : undefined}
          onClick={t.onClick}
          onKeyDown={t.onClick ? (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), t.onClick!()) : undefined}
        >
          <small>{t.label}</small>
          <strong>{t.value}</strong>
          {t.note !== undefined && t.note !== '' && <span className={`stat-trend ${t.tone ?? 'flat'}`}>{t.note}</span>}
        </div>
      ))}
    </div>
  );
}

export interface Pill<K extends string> {
  key: K;
  label: string;
  count?: number;
}

export function FilterPills<K extends string>({ pills, value, onChange, label }: { pills: Pill<K>[]; value: K; onChange: (k: K) => void; label: string }) {
  return (
    <div className="seg filter-pills" role="group" aria-label={label}>
      {pills.map((p) => (
        <button key={p.key} type="button" className={value === p.key ? 'active' : ''} aria-pressed={value === p.key} onClick={() => onChange(p.key)}>
          {p.label}
          {p.count !== undefined && <span className="pill-count">{p.count}</span>}
        </button>
      ))}
    </div>
  );
}

/** Jours de vente couverts par le stock, avec une petite jauge (pleine à 30 jours). */
export function Coverage({ stock, daily }: { stock: number; daily: number }) {
  if (daily <= 0) return <span className="muted">—</span>;
  const days = Math.max(0, stock) / daily;
  const tone = days < 3 ? 'low' : days < 7 ? 'mid' : 'ok';
  return (
    <span className={`coverage ${tone}`} title={`${days.toLocaleString('fr-FR', { maximumFractionDigits: 1 })} jour(s) de vente`}>
      {days < 1 ? '< 1 j' : `${Math.round(days)} j`}
      <i aria-hidden="true">
        <u style={{ width: `${Math.min(100, (days / 30) * 100)}%` }} />
      </i>
    </span>
  );
}
