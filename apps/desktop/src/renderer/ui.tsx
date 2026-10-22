import { DEFAULT_STORE_SETTINGS, type EagleMood, type Permission, type StoreSettings, eagleMascotSvg } from '@superette/core';
import { type ReactNode, createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { formatFcfa, formatQty } from '@superette/core';
import { ApiError, type ErrorFix, call } from './api';

export const fcfa = (v: number) => formatFcfa(v);
export const qty = formatQty;
export const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
export const dateTime = (iso: string) => new Date(iso).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
/**
 * Lit un fichier texte (CSV, relevé) : UTF-8, ou Windows-1252 quand Excel
 * l'a enregistré en « CSV (séparateur point-virgule) », pour garder les accents.
 */
export async function readTextFile(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder('windows-1252').decode(buf);
  }
}
export const dateFr = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString('fr-FR');

/** Saisie d'une quantité « 1,5 » ou « 2 » en millièmes. */
export function parseQty(input: string): number | null {
  const v = Number(input.replace(',', '.').trim());
  return Number.isFinite(v) && v > 0 ? Math.round(v * 1000) : null;
}

export function parseAmount(input: string): number | null {
  const v = Number(input.replace(/[\s ]/g, ''));
  return Number.isSafeInteger(v) && v >= 0 ? v : null;
}

// --- Notifications -----------------------------------------------------------

type Toast = {
  id: number;
  kind: 'ok' | 'error' | 'undo';
  text: string;
  /** Solutions proposées avec l'erreur (boutons). */
  fixes?: ErrorFix[];
  /** Action retardée : faite à la fin du délai, sauf si « Annuler ». */
  run?: () => unknown;
  /** Remet l'écran comme avant quand l'utilisateur annule. */
  onUndo?: () => void;
  until?: number;
};
type Push = (t: Omit<Toast, 'id'>) => void;
const ToastCtx = createContext<Push>(() => {});

/** Ouvre un écran depuis n'importe où (solutions des messages d'erreur, tâches du jour…). */
export const OPEN_EVENT = 'fedonix:open';
export const openScreen = (kind: string, tab?: string) => window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: [kind, tab] }));

/** Délai pendant lequel une action simple peut être annulée. */
export const UNDO_SECONDS = 10;

/**
 * La mascotte ONIX, l'aigle, dans l'humeur du moment : veille (attente),
 * bonjour (accueil), compte (calcul, impression), alerte (erreur, écart),
 * bravo (réussite), dort (caisse fermée).
 */
export function Mascot({ mood, size = 96, branch = true, className = '' }: { mood: EagleMood; size?: number; branch?: boolean; className?: string }) {
  const svg = useMemo(() => eagleMascotSvg(mood, { branch }), [mood, branch]);
  return (
    <svg
      className={`aigle aigle-${mood} ${className}`}
      viewBox="0 0 200 230"
      width={size}
      height={(size * 230) / 200}
      role="img"
      aria-label={`Aigle ONIX : ${mood}`}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

const TOAST_MOOD: Record<Toast['kind'], EagleMood> = { ok: 'bravo', error: 'alerte', undo: 'compte' };

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [, tick] = useState(0);
  const pending = useRef(new Map<number, Toast>());
  const drop = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const push = useCallback<Push>(
    (t) => {
      const id = Date.now() + Math.random();
      const toast = { ...t, id };
      setToasts((list) => [...list, toast]);
      if (t.kind === 'undo') {
        pending.current.set(id, toast);
        setTimeout(() => {
          const p = pending.current.get(id);
          if (!p) return;
          pending.current.delete(id);
          drop(id);
          void p.run?.();
        }, UNDO_SECONDS * 1000);
        return;
      }
      setTimeout(() => drop(id), t.kind === 'error' ? (t.fixes?.length ? 20000 : 6000) : 3000);
    },
    [drop],
  );
  const undo = useCallback(
    (id?: number) => {
      const key = id ?? [...pending.current.keys()].pop();
      if (key === undefined) return false;
      const p = pending.current.get(key);
      pending.current.delete(key);
      drop(key);
      p?.onUndo?.();
      return true;
    },
    [drop],
  );
  // Ctrl+Z (hors d'un champ de saisie) annule la dernière action encore annulable.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.key.toLowerCase() !== 'z' || !pending.current.size) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      e.preventDefault();
      undo();
    };
    // Fermeture du logiciel pendant le délai : l'action est faite tout de suite.
    const flush = () => {
      for (const p of pending.current.values()) void p.run?.();
      pending.current.clear();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('beforeunload', flush);
    const t = setInterval(() => pending.current.size && tick((n) => n + 1), 1000);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('beforeunload', flush);
      clearInterval(t);
    };
  }, [undo]);
  const runFix = async (t: Toast, f: ErrorFix) => {
    drop(t.id);
    if (f.open) return openScreen(f.open[0], f.open[1]);
    if (f.run) {
      try {
        await (call as (name: string, ...args: unknown[]) => Promise<unknown>)(f.run.api, ...f.run.args);
        push({ kind: 'ok', text: `${f.label} : fait. Vous pouvez recommencer.` });
      } catch (e) {
        push({ kind: 'error', text: e instanceof Error ? e.message : String(e) });
      }
    }
  };
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind} ${t.fixes?.length ? 'with-fixes' : ''}`}>
            <Mascot mood={TOAST_MOOD[t.kind]} size={34} branch={false} className="toast-aigle" />
            <span>{t.text}</span>
            {t.kind === 'undo' && (
              <button type="button" className="toast-btn" onClick={() => undo(t.id)} title="Ctrl+Z">
                Annuler ({Math.max(0, Math.ceil(((t.until ?? 0) - Date.now()) / 1000))} s)
              </button>
            )}
            {t.fixes?.map((f) => (
              <button key={f.label} type="button" className="toast-btn" onClick={() => void runFix(t, f)}>
                {f.label}
              </button>
            ))}
            {Boolean(t.fixes?.length) && (
              <button type="button" className="toast-x" aria-label="Fermer" onClick={() => drop(t.id)}>
                ✕
              </button>
            )}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export function useToast() {
  const push = useContext(ToastCtx);
  return {
    ok: (text: string) => push({ kind: 'ok', text }),
    error: (e: unknown) => push({ kind: 'error', text: e instanceof Error ? e.message : String(e), fixes: e instanceof ApiError ? e.fixes : undefined }),
    /**
     * Action simple sans « Êtes-vous sûr ? » : elle se fait au bout de
     * 10 secondes, sauf si l'utilisateur clique « Annuler » ou tape Ctrl+Z.
     * Jamais pour une vente, un règlement ou une écriture.
     */
    later: (text: string, run: () => unknown, onUndo?: () => void) => push({ kind: 'undo', text, run, onUndo, until: Date.now() + UNDO_SECONDS * 1000 }),
  };
}

/**
 * Numéro d'actualisation de la fenêtre : le bouton ⟳ (ou F5) l'augmente et
 * toutes les données chargées par `useLoad` dans la fenêtre se rechargent,
 * sans perdre l'onglet ni la saisie en cours.
 */
export const RefreshCtx = createContext(0);

/** Charge des données et les recharge à la demande (et à chaque actualisation de la fenêtre). */
export function useLoad<T>(loader: () => Promise<T>, deps: unknown[] = []): { data: T | undefined; reload: () => void; error: unknown } {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<unknown>();
  const [tick, setTick] = useState(0);
  const refresh = useContext(RefreshCtx);
  useEffect(() => {
    let alive = true;
    loader().then(
      (d) => alive && (setData(d), setError(undefined)),
      (e) => alive && setError(e),
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick, refresh]);
  return { data, error, reload: () => setTick((t) => t + 1) };
}

// --- Composants --------------------------------------------------------------

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const back = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Fenêtre ouverte par-dessus une autre : Échap ne ferme que celle du dessus.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const all = document.querySelectorAll('.modal-back');
      if (!back.current || all[all.length - 1] === back.current) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div ref={back} className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'wide' : ''}`}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button type="button" className="ghost" onClick={onClose} aria-label="Fermer">
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

// --- Questions (remplacent confirm() et prompt()) ---------------------------
// Les fenêtres natives confirm()/prompt() font perdre le clavier à la fenêtre
// sous Windows (défaut d'Electron) : après « OK », les champs ne prennent plus
// la saisie. Ces questions s'affichent dans la page et rendent le clavier.

type Ask = { id: number; message: string; input: boolean; resolve: (v: string | null) => void };
let askSeq = 0;
let showAsk: ((a: Ask) => void) | null = null;

function ask(message: string, input: boolean): Promise<string | null> {
  return new Promise((resolve) => {
    if (!showAsk) return resolve(null);
    showAsk({ id: ++askSeq, message, input, resolve });
  });
}

/** « OK / Annuler » dans la page : vrai si l'utilisateur confirme. */
export const askConfirm = (message: string) => ask(message, false).then((v) => v !== null);
/** Demande un texte ; null si l'utilisateur annule ou laisse vide. */
export const askText = (message: string) => ask(message, true).then((v) => (v && v.trim() ? v.trim() : null));

/** Affiche les questions posées par askConfirm / askText, une à la fois. */
export function AskHost() {
  const [queue, setQueue] = useState<Ask[]>([]);
  const [text, setText] = useState('');
  const box = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const ok = useRef<HTMLButtonElement>(null);
  const back = useRef<Element | null>(null);
  const cur = queue[0];
  useEffect(() => {
    showAsk = (a) => setQueue((q) => [...q, a]);
    return () => void (showAsk = null);
  }, []);
  const answer = useCallback(
    (v: string | null) => {
      if (!cur) return;
      cur.resolve(v);
      setText('');
      setQueue((q) => q.slice(1));
      // Rend le clavier au champ qui l'avait (la recherche de la caisse…).
      const prev = back.current;
      setTimeout(() => prev instanceof HTMLElement && prev.isConnected && document.activeElement === document.body && prev.focus(), 0);
    },
    [cur],
  );
  useEffect(() => {
    if (!cur) return;
    if (!box.current?.contains(document.activeElement)) back.current = document.activeElement;
    (cur.input ? field.current : ok.current)?.focus();
    // Capture : la question passe avant les raccourcis des écrans (F4, Entrée…).
    const onKey = (e: KeyboardEvent) => {
      const inside = box.current?.contains(e.target as Node);
      if (e.key === 'Escape' || (e.key === 'Enter' && !(inside && e.target instanceof HTMLButtonElement))) {
        e.preventDefault();
        e.stopPropagation();
        answer(e.key === 'Escape' ? null : cur.input ? (field.current?.value ?? '') : '');
      } else if (!inside) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    // Bulle : les touches tapées dans la question ne vont pas aux écrans.
    const stop = (e: KeyboardEvent) => e.stopPropagation();
    const el = box.current;
    window.addEventListener('keydown', onKey, true);
    el?.addEventListener('keydown', stop);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      el?.removeEventListener('keydown', stop);
    };
  }, [cur, answer]);
  if (!cur) return null;
  return (
    <div className="modal-back ask-back">
      <div className="modal ask" ref={box} role="dialog" aria-modal="true">
        <p>{cur.message}</p>
        {cur.input && <input ref={field} value={text} onChange={(e) => setText(e.target.value)} />}
        <div className="actions">
          <button type="button" className="ghost" onClick={() => answer(null)}>
            Annuler
          </button>
          <button type="button" ref={ok} className="primary" onClick={() => answer(cur.input ? text : '')}>
            OK
          </button>
        </div>
      </div>
    </div>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}

/** Demande le code d'un gérant (annulation, retour, remise, prélèvement). */
/**
 * Accord du gérant sur son téléphone : la caisse demande, le gérant accepte
 * avec son code sur la page du gérant. Le code renvoyé (« @accord:… ») vaut
 * code du gérant pendant 2 minutes sur ce PC. Rien n'est montré si le PC
 * n'est pas relié au serveur.
 */
export function PhoneApproval({ action, onCode }: { action: string; onCode: (code: string) => void }) {
  const [available, setAvailable] = useState(false);
  const [waiting, setWaiting] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    call('approval.available').then(setAvailable, () => setAvailable(false));
  }, []);
  useEffect(() => {
    if (!waiting) return;
    let stop = false;
    const tick = async () => {
      if (stop) return;
      try {
        const r = await call('approval.poll', waiting);
        if (stop) return;
        if (r.status === 'approved' && r.code) {
          setWaiting(null);
          setMessage(`Accordé par ${r.name ?? 'le gérant'}`);
          return onCode(r.code);
        }
        if (r.status !== 'pending') {
          setWaiting(null);
          return setMessage(r.status === 'refused' ? 'Le gérant a refusé.' : 'Pas de réponse à temps : redemandez.');
        }
      } catch (e) {
        setWaiting(null);
        return setMessage(e instanceof Error ? e.message : String(e));
      }
      setTimeout(tick, 2_000);
    };
    const t = setTimeout(tick, 2_000);
    return () => {
      stop = true;
      clearTimeout(t);
    };
  }, [waiting]);
  if (!available) return null;
  return (
    <div className="phone-approval">
      {waiting ? (
        <>
          <span className="spinner-dot" /> En attente de la réponse du gérant sur son téléphone…
          <button type="button" className="link" onClick={() => setWaiting(null)}>
            Annuler
          </button>
        </>
      ) : (
        <button
          type="button"
          onClick={async () => {
            setMessage(null);
            try {
              setWaiting((await call('approval.request', action)).id);
            } catch (e) {
              setMessage(e instanceof Error ? e.message : String(e));
            }
          }}
        >
          Demander sur le téléphone du gérant
        </button>
      )}
      {message && <small className="muted">{message}</small>}
    </div>
  );
}

export function SupervisorPrompt({ action, onCancel, onConfirm }: { action: string; onCancel: () => void; onConfirm: (pin: string) => void }) {
  const [pin, setPin] = useState('');
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <Modal title="Validation du gérant" onClose={onCancel}>
      <p>{action}</p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onConfirm(pin);
        }}
      >
        <Field label="Code gérant">
          <input ref={ref} type="password" inputMode="numeric" value={pin} onChange={(e) => setPin(e.target.value)} />
        </Field>
        <PhoneApproval action={action} onCode={onConfirm} />
        <div className="actions">
          <button type="button" className="ghost" onClick={onCancel}>
            Annuler
          </button>
          <button type="submit" className="primary" disabled={pin.length < 4}>
            Valider
          </button>
        </div>
      </form>
    </Modal>
  );
}

/**
 * Liste ou page vide : le message dit quoi faire ensuite, et le bouton
 * facultatif le fait tout de suite (« Ouvrir la caisse », « Nouveau client »…).
 */
export function Empty({ children, action, mood = 'veille' }: { children: ReactNode; action?: { label: string; onClick: () => void }; mood?: EagleMood }) {
  return (
    <div className="empty">
      <Mascot mood={mood} size={64} branch={false} />
      <div>{children}</div>
      {action && (
        <button className="primary empty-action" onClick={action.onClick}>
          {action.label}
        </button>
      )}
    </div>
  );
}

export function Tabs<T extends string>({ value, onChange, tabs }: { value: T; onChange: (v: T) => void; tabs: [T, string][] }) {
  return (
    <div className="tabs">
      {tabs.map(([key, label]) => (
        <button key={key} className={value === key ? 'active' : ''} onClick={() => onChange(key)}>
          {label}
        </button>
      ))}
    </div>
  );
}

export function downloadText(filename: string, content: string, mime = 'text/csv;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Droit de l'utilisateur connecté (Administration › Droits). */
export const has = (user: { rights: readonly string[] }, right: Permission) => user.rights.includes(right);

/** Droits de l'utilisateur connecté, pour les écrans qui ne reçoivent pas l'utilisateur. */
const RightsContext = createContext<readonly string[]>([]);
export const RightsProvider = RightsContext.Provider;
/** Paramètres du magasin utiles aux écrans (arrondi, remise maximale…), sans le logo. */
const StoreSettingsContext = createContext<Omit<StoreSettings, 'logo'>>(DEFAULT_STORE_SETTINGS);
export const StoreSettingsProvider = StoreSettingsContext.Provider;
export const useStoreSettings = () => useContext(StoreSettingsContext);

/** `can('a', 'b')` : vrai si l'utilisateur a l'un des droits. */
export function useCan(): (...rights: Permission[]) => boolean {
  const rights = useContext(RightsContext);
  return (...wanted) => wanted.some((r) => rights.includes(r));
}

// --- Brouillons --------------------------------------------------------------

/** Écran qui rouvre un brouillon, d'après sa clé (« order:new », « quote:new »…). */
export const DRAFT_SCREENS: Record<string, [string, string?]> = {
  order: ['purchases', 'new-order'],
  quote: ['quotes', 'new'],
  article: ['articles', 'new'],
  reception: ['purchases', 'orders'],
};

/**
 * Saisie gardée toute seule sur ce PC (bon de commande, devis, fiche article,
 * réception) : après une coupure de courant ou une fermeture, elle est
 * proposée à la réouverture de l'écran. `clear()` après l'enregistrement.
 */
export function useDraft<T>(key: string | null, label: string, value: T, restore: (v: T) => void, isEmpty: (v: T) => boolean) {
  const [found, setFound] = useState<{ data: T; updated_at: string; label: string } | null>(null);
  const ready = useRef(false);
  const done = useRef(false);
  const json = JSON.stringify(value);
  useEffect(() => {
    ready.current = false;
    done.current = false;
    if (!key) return;
    call('drafts.get', key).then(
      (d) => {
        if (d && !isEmpty(d.data as T)) setFound(d as { data: T; updated_at: string; label: string });
        ready.current = true;
      },
      () => (ready.current = true),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  useEffect(() => {
    if (!key || found) return;
    const t = setTimeout(() => {
      if (!ready.current || done.current) return;
      if (isEmpty(value)) void call('drafts.clear', key).catch(() => undefined);
      else void call('drafts.save', key, label, value).catch(() => undefined);
    }, 1200);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, json, found]);
  const clear = () => {
    done.current = true;
    if (key) void call('drafts.clear', key).catch(() => undefined);
  };
  const banner = found ? (
    <div className="draft-banner">
      <span>
        Saisie retrouvée du {dateTime(found.updated_at)} : <b>{found.label}</b>. Elle avait été gardée avant la fermeture.
      </span>
      <button type="button" className="primary" onClick={() => (restore(found.data), setFound(null))}>
        Reprendre
      </button>
      <button
        type="button"
        onClick={() => {
          if (key) void call('drafts.clear', key).catch(() => undefined);
          setFound(null);
        }}
      >
        Jeter
      </button>
    </div>
  ) : null;
  return { banner, clear };
}

// --- Clavier ---------------------------------------------------------------------

/** Touche écrite dans l'infobulle d'un bouton : « Valider (F2) », « Ctrl+J »… */
const KEY_IN_TITLE = /\b(F(?:1[0-2]|[1-9])|Ctrl\+(?:Entrée|[A-Z/]|\w)|Alt\+\w|Suppr|Échap|Entrée)\b/;

/**
 * Clavier partout : la touche est écrite sur chaque bouton qui en a une ;
 * dans une fenêtre, Ctrl+Entrée valide (bouton principal) et Échap ferme.
 */
export function KeyHints() {
  useEffect(() => {
    let pending = false;
    const mark = () => {
      pending = false;
      observer.disconnect();
      for (const b of document.querySelectorAll<HTMLButtonElement>('button[title]:not([data-kbd]), button.primary:not([data-kbd])')) {
        if (b.closest('.pos-screen, .rail, .quick-tabs, .lv-tools, .statusbar, .toasts')) {
          b.dataset.kbd = '';
          continue;
        }
        const m = KEY_IN_TITLE.exec(b.title ?? '');
        const inModal = b.closest('.modal .actions');
        const key = m?.[1] ?? (inModal && b.classList.contains('primary') && b.closest('.modal')?.querySelectorAll('.actions button.primary').length === 1 ? 'Ctrl+Entrée' : '');
        b.dataset.kbd = key && !(b.textContent ?? '').includes(key) ? key : '';
      }
      for (const b of document.querySelectorAll<HTMLButtonElement>('.modal .actions button:not(.primary):not([data-kbd])')) {
        b.dataset.kbd = /^(Annuler|Fermer|Retour)$/.test(b.textContent?.trim() ?? '') ? 'Échap' : '';
      }
      observer.observe(document.body, { childList: true, subtree: true });
    };
    const observer = new MutationObserver(() => {
      if (pending) return;
      pending = true;
      requestAnimationFrame(mark);
    });
    mark();
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.key !== 'Enter') return;
      const modals = document.querySelectorAll('.modal');
      const top = modals[modals.length - 1];
      const primary = top?.querySelectorAll<HTMLButtonElement>('.actions button.primary');
      if (primary?.length === 1 && !primary[0]!.disabled) {
        e.preventDefault();
        primary[0]!.click();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      observer.disconnect();
      window.removeEventListener('keydown', onKey);
    };
  }, []);
  return null;
}

/** Raccourcis de la page affichée : ceux du logiciel et ceux des boutons de la fenêtre de devant. */
export function pageShortcuts(): [string, string][] {
  const root = document.querySelector('.modal-back:last-of-type .modal') ?? document.querySelector('.mdi.active') ?? document.body;
  const seen = new Set<string>();
  const out: [string, string][] = [];
  for (const b of root.querySelectorAll<HTMLButtonElement>('button')) {
    const key = b.dataset.kbd || KEY_IN_TITLE.exec(b.title ?? '')?.[1];
    const label = (b.textContent ?? '').replace(key ?? '', '').trim() || b.title.replace(/\s*\(.*?\)\s*/g, '').trim();
    if (!key || !label || seen.has(key + label)) continue;
    seen.add(key + label);
    out.push([key, label]);
  }
  return out;
}

// --- Thème -----------------------------------------------------------------------

export type Theme = 'light' | 'dark' | 'contrast';
export const THEMES: Record<Theme, string> = { light: 'Clair (normal)', dark: 'Sombre (le soir)', contrast: 'Contraste fort (plein soleil)' };

export function applyTheme(theme: Theme | undefined): void {
  const root = document.documentElement;
  root.classList.toggle('theme-dark', theme === 'dark');
  root.classList.toggle('theme-contrast', theme === 'contrast');
}
