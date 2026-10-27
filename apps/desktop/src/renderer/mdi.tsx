import { Component, type ReactNode, useRef, useState } from 'react';

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

/**
 * Boîte de dialogue (réglages, traitements) : centrée, à taille fixe, comme
 * les fenêtres de paramètres de Sage qu'on ne peut que fermer.
 */
export function dialogGeo(area: Area): Geo {
  const w = Math.min(area.w, Math.max(MIN_W, Math.min(1040, area.w - 60)));
  const h = Math.min(area.h, Math.max(MIN_H, area.h - 40));
  return fit({ x: Math.round((area.w - w) / 2), y: Math.round((area.h - h) / 2), w, h, max: false }, area);
}

/** Fenêtres côte à côte (Fenêtres › Mosaïque) : en colonnes puis en lignes. */
export function tileGeos(area: Area, n: number): Geo[] {
  const cols = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  const w = Math.floor(area.w / cols);
  const h = Math.floor(area.h / rows);
  return Array.from({ length: n }, (_, i) => ({ x: (i % cols) * w, y: Math.floor(i / cols) * h, w, h, max: false }));
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
 * l'agrandit par le coin, – la réduit dans la barre du bas, ▢ (ou double-clic
 * sur la barre) la met en plein écran et ✕ la ferme. Une boîte de dialogue
 * (`dialog`) n'a que ✕ et garde sa taille. Pendant un déplacement seule la
 * fenêtre se redessine ; la nouvelle place est enregistrée au lâcher.
 */
export function MdiWindow({
  title,
  icon,
  geo,
  area,
  z,
  active,
  dialog,
  minimized,
  onMinimize,
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
  /** Réglage ou traitement : seulement ✕, ni réduire, ni agrandir, ni tirer le coin. */
  dialog?: boolean;
  /** Réduite : cachée (elle garde sa saisie) et rangée dans la barre du bas. */
  minimized?: boolean;
  onMinimize?: () => void;
  onFocus: () => void;
  onChange: (g: Geo) => void;
  onClose: () => void;
  /** ⟳ : recharge les données de la fenêtre. */
  onRefresh?: () => void;
  children: ReactNode;
}) {
  const [live, setLive] = useState<Geo | null>(null);
  const liveRef = useRef<Geo | null>(null);
  const g = fit(live ?? (dialog ? { ...geo, max: false } : geo), area);

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
  const toggleMax = () => !dialog && onChange({ ...g, max: !g.max });

  return (
    <section
      className={`mdi ${active ? 'active' : ''} ${g.max ? 'max' : ''} ${dialog ? 'dialog' : ''} ${minimized ? 'minimized' : ''}`}
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
        {!dialog && onMinimize && (
          <button type="button" className="mdi-min" title="Réduire (la fenêtre garde sa saisie)" onPointerDown={(e) => e.stopPropagation()} onClick={onMinimize}>
            –
          </button>
        )}
        {!dialog && (
          <button type="button" title={g.max ? 'Remettre en fenêtre' : 'Agrandir'} onPointerDown={(e) => e.stopPropagation()} onClick={toggleMax}>
            {g.max ? '❐' : '▢'}
          </button>
        )}
        <button type="button" className="mdi-x" title="Fermer cette fenêtre" onPointerDown={(e) => e.stopPropagation()} onClick={onClose}>
          ✕
        </button>
      </header>
      <div className="window">
        <ScreenGuard>{children}</ScreenGuard>
      </div>
      {!g.max && !dialog && <span className="mdi-grip" title="Tirer pour agrandir" onPointerDown={(e) => drag(e, 'size')} />}
    </section>
  );
}

/**
 * Une erreur dans un écran n'emporte plus toute l'application (écran blanc) :
 * seule sa fenêtre affiche le message, les autres restent utilisables.
 */
class ScreenGuard extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="screen-error">
        <h3>Cet écran a rencontré un problème</h3>
        <p className="muted">Les autres fenêtres continuent de fonctionner. Fermez celle-ci et rouvrez-la ; si le problème revient, notez le message ci-dessous pour le support.</p>
        <pre>{this.state.error.message}</pre>
        <button onClick={() => this.setState({ error: null })}>Réessayer</button>
      </div>
    );
  }
}
