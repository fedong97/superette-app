import { useEffect, useState } from 'react';
import { type Result, call } from '../api';
import { Field, useLoad, useToast } from '../ui';

type Article = Result<'catalogue.get'>;

/** Recherche d'article par scan ou par nom. */
export function ArticlePicker({ onPick, placeholder }: { onPick: (a: Article) => void; placeholder?: string }) {
  const toast = useToast();
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Article[]>([]);
  return (
    <div className="picker">
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (!q.trim()) return;
          try {
            const hit = await call('catalogue.scan', q);
            if (hit) {
              onPick(hit.article);
              setQ('');
              setResults([]);
              return;
            }
            const found = await call('catalogue.search', q);
            if (found.length === 1) {
              onPick(found[0]!);
              setQ('');
              setResults([]);
            } else if (found.length === 0) toast.error('Article introuvable');
            else setResults(found);
          } catch (err) {
            toast.error(err);
          }
        }}
      >
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={placeholder ?? 'Scanner ou rechercher un article'} autoFocus />
      </form>
      {results.length > 0 && (
        <div className="pick-list dropdown">
          {results.map((a) => (
            <button
              key={a.id}
              onClick={() => {
                onPick(a);
                setQ('');
                setResults([]);
              }}
            >
              <span>{a.name}</span>
              <span>{a.code}</span>
            </button>
          ))}
        </div>
      )}
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
