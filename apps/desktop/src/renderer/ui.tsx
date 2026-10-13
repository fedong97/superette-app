import { DEFAULT_STORE_SETTINGS, type Permission, type StoreSettings } from '@superette/core';
import { type ReactNode, createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { formatFcfa, formatQty } from '@superette/core';

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

type Toast = { id: number; kind: 'ok' | 'error'; text: string };
const ToastCtx = createContext<(kind: Toast['kind'], text: string) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((kind: Toast['kind'], text: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, kind, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 6000 : 3000);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            {t.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export function useToast() {
  const push = useContext(ToastCtx);
  return {
    ok: (text: string) => push('ok', text),
    error: (e: unknown) => push('error', e instanceof Error ? e.message : String(e)),
  };
}

/** Charge des données et les recharge à la demande. */
export function useLoad<T>(loader: () => Promise<T>, deps: unknown[] = []): { data: T | undefined; reload: () => void; error: unknown } {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<unknown>();
  const [tick, setTick] = useState(0);
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
  }, [...deps, tick]);
  return { data, error, reload: () => setTick((t) => t + 1) };
}

// --- Composants --------------------------------------------------------------

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'wide' : ''}`}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="ghost" onClick={onClose} aria-label="Fermer">
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
export function Empty({ children, action }: { children: ReactNode; action?: { label: string; onClick: () => void } }) {
  return (
    <div className="empty">
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
