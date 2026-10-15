import { type ReactNode, useRef, useState } from 'react';

/** Place et taille d'une fenêtre dans la zone de travail (en pixels), ou plein écran. */
export interface Geo {
  x: number;
  y: number;
  w: number;
  h: number;
  max: boolean;
}

export interface Area {
  w: number;
  h: number;
}

const MIN_W = 480;
const MIN_H = 300;

/** Première ouverture : en cascade, un peu plus petite que la zone de travail. */
export function defaultGeo(area: Area, index: number, max: boolean): Geo {
  const step = 28 * (index % 6);
  const w = Math.max(MIN_W, Math.round(area.w * 0.84));
  const h = Math.max(MIN_H, Math.round(area.h * 0.86));
  return fit({ x: 16 + step, y: 12 + step, w, h, max }, area);
}

/** Garde la fenêtre entière dans la zone de travail (écran plus petit, fenêtre tirée trop loin). */
export function fit(g: Geo, area: Area): Geo {
  if (!area.w || !area.h) return g;
  const w = Math.min(Math.max(g.w, MIN_W), area.w);
  const h = Math.min(Math.max(g.h, MIN_H), area.h);
  const x = Math.min(Math.max(g.x, 0), area.w - w);
  const y = Math.min(Math.max(g.y, 0), area.h - h);
  return { x, y, w, h, max: g.max };
}

/**
 * Fenêtre à l'intérieur du logiciel : on la déplace par sa barre verte, on
 * l'agrandit par le coin, ▢ (ou double-clic sur la barre) la met en plein
 * écran et ✕ la ferme. Pendant un déplacement seule la fenêtre se redessine ;
 * la nouvelle place est enregistrée au lâcher.
 */
export function MdiWindow({
  title,
  icon,
  geo,
  area,
  z,
  active,
  onFocus,
  onChange,
  onClose,
  onRefresh,
  children,
}: {
  title: string;
  icon: string;
  geo: Geo;
  area: Area;
  z: number;
  active: boolean;
  onFocus: () => void;
  onChange: (g: Geo) => void;
  onClose: () => void;
  /** ⟳ : recharge les données de la fenêtre. */
  onRefresh?: () => void;
  children: ReactNode;
}) {
  const [live, setLive] = useState<Geo | null>(null);
  const liveRef = useRef<Geo | null>(null);
  const g = fit(live ?? geo, area);

  const drag = (e: React.PointerEvent, mode: 'move' | 'size') => {
    if (e.button !== 0 || g.max) return;
    e.preventDefault();
    const start = { px: e.clientX, py: e.clientY, ...g };
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - start.px;
      const dy = ev.clientY - start.py;
      const next = fit(mode === 'move' ? { ...start, x: start.x + dx, y: start.y + dy } : { ...start, w: start.w + dx, h: start.h + dy }, area);
      liveRef.current = next;
      setLive(next);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.classList.remove('mdi-dragging');
      if (liveRef.current) onChange(liveRef.current);
      liveRef.current = null;
      setLive(null);
    };
    document.body.classList.add('mdi-dragging');
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const toggleMax = () => onChange({ ...g, max: !g.max });

  return (
    <section
      className={`mdi ${active ? 'active' : ''} ${g.max ? 'max' : ''}`}
      style={g.max ? { zIndex: z } : { zIndex: z, left: g.x, top: g.y, width: g.w, height: g.h }}
      onPointerDownCapture={() => !active && onFocus()}
    >
      <header className="mdi-bar" onPointerDown={(e) => drag(e, 'move')} onDoubleClick={toggleMax}>
        <i aria-hidden>{icon}</i>
        <span className="mdi-title">{title}</span>
        {onRefresh && (
          <button type="button" className="mdi-refresh" title="Actualiser la page (F5)" onPointerDown={(e) => e.stopPropagation()} onClick={onRefresh}>
            ⟳
          </button>
        )}
        <button type="button" title={g.max ? 'Remettre en fenêtre' : 'Plein écran'} onPointerDown={(e) => e.stopPropagation()} onClick={toggleMax}>
          {g.max ? '❐' : '▢'}
        </button>
        <button type="button" className="mdi-x" title="Fermer cette fenêtre" onPointerDown={(e) => e.stopPropagation()} onClick={onClose}>
          ✕
        </button>
      </header>
      <div className="window">{children}</div>
      {!g.max && <span className="mdi-grip" title="Tirer pour agrandir" onPointerDown={(e) => drag(e, 'size')} />}
    </section>
  );
}
