import type { ReactNode } from 'react';
import type { IconName } from './modules';

/**
 * Composants communs de l'interface : une seule famille d'icônes (trait fin,
 * style Lucide), en-tête, cartes de chiffres, actions rapides, états vides et
 * squelettes de chargement.
 */

type AnyIcon =
  | IconName
  | 'back'
  | 'chevron'
  | 'bell'
  | 'refresh'
  | 'search'
  | 'logout'
  | 'alert'
  | 'info'
  | 'check'
  | 'x'
  | 'sliders'
  | 'menu'
  | 'upload'
  | 'trend-up'
  | 'trend-down'
  | 'user'
  | 'file'
  | 'wifi-off'
  | 'smartphone';

const PATHS: Record<AnyIcon, ReactNode> = {
  home: <path d="m3 10 9-7 9 7v10a2 2 0 0 1-2 2h-4v-7H9v7H5a2 2 0 0 1-2-2z" />,
  cart: (
    <>
      <circle cx="8" cy="21" r="1" />
      <circle cx="19" cy="21" r="1" />
      <path d="M2.05 2.05h2l2.66 12.42a2 2 0 0 0 2 1.58h9.78a2 2 0 0 0 1.95-1.57l1.65-7.43H5.12" />
    </>
  ),
  receipt: (
    <>
      <path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1Z" />
      <path d="M16 8H8M16 12H8M13 16H8" />
    </>
  ),
  box: (
    <>
      <path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" />
      <path d="m3.3 7 8.7 5 8.7-5M12 22V12" />
    </>
  ),
  clipboard: (
    <>
      <rect x="8" y="2" width="8" height="4" rx="1" />
      <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
      <path d="m9 14 2 2 4-4" />
    </>
  ),
  truck: (
    <>
      <path d="M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2" />
      <path d="M15 18H9" />
      <path d="M19 18h2a1 1 0 0 0 1-1v-3.65a1 1 0 0 0-.22-.62L18.3 9.38a1 1 0 0 0-.78-.38H14" />
      <circle cx="17" cy="18" r="2" />
      <circle cx="7" cy="18" r="2" />
    </>
  ),
  scan: <path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2M7 12h10" />,
  'check-circle': (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="m9 12 2 2 4-4" />
    </>
  ),
  wallet: (
    <>
      <path d="M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1" />
      <path d="M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4" />
    </>
  ),
  users: (
    <>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
    </>
  ),
  'user-check': (
    <>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="m16 11 2 2 4-4" />
    </>
  ),
  store: (
    <>
      <path d="m2 7 4.41-4.41A2 2 0 0 1 7.83 2h8.34a2 2 0 0 1 1.42.59L22 7" />
      <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8" />
      <path d="M15 22v-4a2 2 0 0 0-2-2h-2a2 2 0 0 0-2 2v4M2 7h20" />
    </>
  ),
  grid: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </>
  ),
  back: <path d="m15 18-6-6 6-6" />,
  chevron: <path d="m9 18 6-6-6-6" />,
  bell: (
    <>
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    </>
  ),
  refresh: (
    <>
      <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
      <path d="M8 16H3v5" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
    </>
  ),
  logout: (
    <>
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <path d="m16 17 5-5-5-5M21 12H9" />
    </>
  ),
  alert: (
    <>
      <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" />
      <path d="M12 9v4M12 17h.01" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 16v-4M12 8h.01" />
    </>
  ),
  check: <path d="M20 6 9 17l-5-5" />,
  x: <path d="M18 6 6 18M6 6l12 12" />,
  sliders: <path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6" />,
  menu: <path d="M4 6h16M4 12h16M4 18h16" />,
  upload: (
    <>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="m17 8-5-5-5 5M12 3v12" />
    </>
  ),
  'trend-up': (
    <>
      <path d="m22 7-8.5 8.5-5-5L2 17" />
      <path d="M16 7h6v6" />
    </>
  ),
  'trend-down': (
    <>
      <path d="m22 17-8.5-8.5-5 5L2 7" />
      <path d="M16 17h6v-6" />
    </>
  ),
  user: (
    <>
      <circle cx="12" cy="8" r="5" />
      <path d="M20 21a8 8 0 0 0-16 0" />
    </>
  ),
  file: (
    <>
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
      <path d="M14 2v4a2 2 0 0 0 2 2h4" />
    </>
  ),
  'wifi-off': <path d="M12 20h.01M8.5 16.43a5 5 0 0 1 7 0M2 8.82a15 15 0 0 1 4.17-2.65M10.66 5c4.01-.36 8.14.9 11.34 3.76M16.85 11.25a10 10 0 0 1 2.22 1.68M5 13a10 10 0 0 1 5.24-2.76M2 2l20 20" />,
  smartphone: (
    <>
      <rect x="5" y="2" width="14" height="20" rx="2" />
      <path d="M12 18h.01" />
    </>
  ),
};

export type { AnyIcon };

export function Icon({ name, size = 22 }: { name: AnyIcon; size?: number }) {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {PATHS[name]}
    </svg>
  );
}

/** En-tête simple : retour (ou rien), titre, une ou deux actions. */
export function AppHeader({ title, subtitle, onBack, children }: { title: ReactNode; subtitle?: ReactNode; onBack?: (() => void) | null; children?: ReactNode }) {
  return (
    <header className="bar">
      {onBack ? (
        <button className="ghost" onClick={onBack} aria-label="Retour">
          <Icon name="back" />
        </button>
      ) : null}
      <div className="grow">
        <b>{title}</b>
        {subtitle ? <small>{subtitle}</small> : null}
      </div>
      {children}
    </header>
  );
}

export type Tone = 'brand' | 'success' | 'warning' | 'danger' | 'info' | 'neutral';

/** Chiffre clé : valeur, libellé, et l'évolution quand elle est connue. */
export function StatCard({ label, value, hint, icon, tone = 'brand', trend, onClick }: { label: string; value: ReactNode; hint?: ReactNode; icon?: AnyIcon; tone?: Tone; trend?: number | null; onClick?: () => void }) {
  const body = (
    <>
      {icon ? (
        <span className={`stat-icon ${tone}`}>
          <Icon name={icon} size={20} />
        </span>
      ) : null}
      <span className="stat-label">{label}</span>
      <b className="stat-value">{value}</b>
      {trend !== undefined && trend !== null ? (
        <span className={`trend ${trend >= 0 ? 'up' : 'down'}`}>
          <Icon name={trend >= 0 ? 'trend-up' : 'trend-down'} size={14} />
          {trend >= 0 ? '+' : ''}
          {trend} %
        </span>
      ) : null}
      {hint ? <span className="stat-hint">{hint}</span> : null}
    </>
  );
  return onClick ? (
    <button className="stat" onClick={onClick}>
      {body}
    </button>
  ) : (
    <div className="stat">{body}</div>
  );
}

export function QuickAction({ icon, label, onClick, primary }: { icon: AnyIcon; label: string; onClick: () => void; primary?: boolean }) {
  return (
    <button className={`quick ${primary ? 'on' : ''}`} onClick={onClick}>
      <span className="quick-icon">
        <Icon name={icon} />
      </span>
      <span>{label}</span>
    </button>
  );
}

export function SectionTitle({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="section-title">
      <h3>{children}</h3>
      {action}
    </div>
  );
}

/** Ligne de liste touchable : icône, titre, détail, valeur à droite. */
export function ListItem({ icon, tone = 'neutral', title, detail, value, onClick }: { icon?: AnyIcon; tone?: Tone; title: ReactNode; detail?: ReactNode; value?: ReactNode; onClick?: () => void }) {
  const body = (
    <>
      {icon ? (
        <span className={`li-icon ${tone}`}>
          <Icon name={icon} size={20} />
        </span>
      ) : null}
      <span className="grow">
        <span className="li-title">{title}</span>
        {detail ? <small>{detail}</small> : null}
      </span>
      {value ? <span className="li-value">{value}</span> : null}
      {onClick ? (
        <span className="chev">
          <Icon name="chevron" size={18} />
        </span>
      ) : null}
    </>
  );
  return onClick ? (
    <button className="li" onClick={onClick}>
      {body}
    </button>
  ) : (
    <div className="li">{body}</div>
  );
}

export function EmptyState({ icon, title, text, children }: { icon: AnyIcon; title: string; text?: ReactNode; children?: ReactNode }) {
  return (
    <div className="empty-state">
      <span className="empty-icon">
        <Icon name={icon} size={28} />
      </span>
      <b>{title}</b>
      {text ? <p>{text}</p> : null}
      {children}
    </div>
  );
}

/** Squelette de chargement : la forme de l'écran apparaît tout de suite. */
export function Skeleton({ rows = 3, stats = false }: { rows?: number; stats?: boolean }) {
  return (
    <div className="skeleton" aria-busy="true" aria-label="Chargement">
      {stats ? (
        <div className="kpis">
          <div className="sk sk-stat" />
          <div className="sk sk-stat" />
        </div>
      ) : null}
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="sk sk-row" />
      ))}
    </div>
  );
}

/** Initiales du nom, pour l'avatar. */
export const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('') || '?';

/** Petits souvenirs de l'écran (onglet ouvert, inventaire choisi), le temps de la session de l'appli. */
export const remember = (key: string, value: string | null) => {
  try {
    if (value) sessionStorage.setItem(key, value);
    else sessionStorage.removeItem(key);
  } catch {
    /* rien */
  }
};
export const recall = (key: string) => {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
};
