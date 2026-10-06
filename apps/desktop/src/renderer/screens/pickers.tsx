import { useEffect, useState } from 'react';
import { type Result, call } from '../api';
import { Field, fcfa, useLoad, useToast } from '../ui';

type Article = Result<'catalogue.get'>;

/**
 * Suggestions d'articles pendant la saisie (à partir de 2 lettres). Un code
 * tapé ou scanné (que des chiffres) n'ouvre pas de liste : Entrée garde son
 * rôle de validation du code-barres.
 */
export function useArticleSuggestions(query: string) {
  const [items, setItems] = useState<Article[]>([]);
  const [active, setActive] = useState(0);
  const [closed, setClosed] = useState(false);
  useEffect(() => {
    setClosed(false);
    const q = query.trim();
    if (q.length < 2 || /^[\d\s]+$/.test(q)) {
      setItems([]);
      return;
    }
    let live = true;
    const t = setTimeout(() => {
      call('catalogue.suggest', q)
        .then((r) => {
          if (!live) return;
          setItems(r);
          setActive(0);
        })
        .catch(() => live && setItems([]));
    }, 120);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [query]);
  const shown = closed ? [] : items;
  return {
    items: shown,
    active,
    setActive,
    close: () => setClosed(true),
    /** Flèches pour se déplacer, Entrée pour choisir, Échap pour fermer. Renvoie true si la touche a servi. */
    onKeyDown(e: React.KeyboardEvent, pick: (a: Article) => void): boolean {
      if (!shown.length) return false;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        setActive((i) => (i + (e.key === 'ArrowDown' ? 1 : shown.length - 1)) % shown.length);
      } else if (e.key === 'Enter') {
        pick(shown[Math.min(active, shown.length - 1)]!);
      } else if (e.key === 'Escape') {
        setClosed(true);
      } else return false;
      e.preventDefault();
      e.stopPropagation();
      return true;
    },
  };
}

/** Liste déroulante des suggestions, sous le champ de saisie. */
export function SuggestionList({ s, onPick, query }: { s: ReturnType<typeof useArticleSuggestions>; onPick: (a: Article) => void; query: string }) {
  if (!s.items.length) return null;
  return (
    <div className="suggest dropdown" role="listbox">
      {s.items.map((a, i) => (
        <button
          type="button"
          key={a.id}
          role="option"
          aria-selected={i === s.active}
          className={i === s.active ? 'active' : ''}
          // mousedown : choisir avant que le champ perde le focus.
          onMouseDown={(e) => {
            e.preventDefault();
            onPick(a);
          }}
          onMouseEnter={() => s.setActive(i)}
        >
          <span className="suggest-name">
            <Highlight text={a.name} query={query} />
            {a.brand && <span className="muted"> · {a.brand}</span>}
          </span>
          <span className="muted">{a.code}</span>
          <span className="suggest-price">{fcfa(a.store_price)}</span>
        </button>
      ))}
    </div>
  );
}

/** Met en gras les mots tapés, accents compris (« creme » souligne « Crème »). */
function Highlight({ text, query }: { text: string; query: string }) {
  const fold = (v: string) => v.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const folded = fold(text);
  // NFD puis suppression des accents garde une lettre par lettre du texte d'origine (cas courant du français).
  if (folded.length !== text.length) return <>{text}</>;
  const marks = new Array<boolean>(text.length).fill(false);
  for (const w of fold(query).split(/\s+/).filter(Boolean)) {
    let from = 0;
    for (let at = folded.indexOf(w, from); at >= 0; at = folded.indexOf(w, from)) {
      marks.fill(true, at, at + w.length);
      from = at + w.length;
    }
  }
  const parts: { t: string; b: boolean }[] = [];
  for (let i = 0; i < text.length; i++) {
    const last = parts[parts.length - 1];
    if (last && last.b === marks[i]) last.t += text[i];
    else parts.push({ t: text[i]!, b: marks[i]! });
  }
  return <>{parts.map((p, i) => (p.b ? <b key={i}>{p.t}</b> : <span key={i}>{p.t}</span>))}</>;
}

/** Recherche d'article par scan, ou par nom avec suggestions pendant la saisie. */
export function ArticlePicker({ onPick, placeholder }: { onPick: (a: Article) => void; placeholder?: string }) {
  const toast = useToast();
  const [q, setQ] = useState('');
  const s = useArticleSuggestions(q);
  const pick = (a: Article) => {
    onPick(a);
    setQ('');
  };
  return (
    <div className="picker">
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (!q.trim()) return;
          try {
            const hit = await call('catalogue.scan', q);
            if (hit) return pick(hit.article);
            const found = await call('catalogue.suggest', q);
            if (found.length === 1) pick(found[0]!);
            else toast.error(found.length === 0 ? 'Article introuvable' : 'Plusieurs articles : choisissez dans la liste');
          } catch (err) {
            toast.error(err);
          }
        }}
      >
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => s.onKeyDown(e, pick)}
          onBlur={s.close}
          placeholder={placeholder ?? 'Scanner, ou taper le début du nom'}
          autoComplete="off"
          autoFocus
        />
      </form>
      <SuggestionList s={s} onPick={pick} query={q} />
    </div>
  );
}

export function WarehouseSelect({ value, onChange, label = 'Dépôt' }: { value: string; onChange: (v: string) => void; label?: string }) {
  const wh = useLoad(() => call('admin.warehouses'));
  useEffect(() => {
    if (!value && wh.data?.[0]) onChange(wh.data[0].id);
  }, [value, wh.data, onChange]);
  return (
    <Field label={label}>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {(wh.data ?? []).map((w) => (
          <option key={w.id} value={w.id}>
            {w.name}
          </option>
        ))}
      </select>
    </Field>
  );
}


/** Choix d'un fournisseur (facultatif pour une réception libre). */
export function SupplierSelect({ value, onChange, optional, label = 'Fournisseur' }: { value: string; onChange: (v: string) => void; optional?: boolean; label?: string }) {
  const suppliers = useLoad(() => call('suppliers.list'));
  return (
    <Field label={label}>
      <select value={value} onChange={(e) => onChange(e.target.value)} required={!optional}>
        <option value="">{optional ? 'Sans fournisseur' : 'Choisir…'}</option>
        {(suppliers.data ?? []).map((f) => (
          <option key={f.id} value={f.id}>
            {f.name}
          </option>
        ))}
      </select>
    </Field>
  );
}
