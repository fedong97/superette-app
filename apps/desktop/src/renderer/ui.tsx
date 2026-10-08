import type { Permission } from '@superette/core';
import { type ReactNode, createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { formatFcfa, formatQty } from '@superette/core';

export const fcfa = (v: number) => formatFcfa(v);
export const qty = formatQty;
export const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
export const dateTime = (iso: string) => new Date(iso).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
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

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
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
