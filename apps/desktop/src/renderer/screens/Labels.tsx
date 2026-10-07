import { useEffect, useMemo, useState } from 'react';
import { LABEL_FORMATS, type LabelFormatId } from '@superette/core';
import { type Result, call } from '../api';
import { Empty, fcfa, useLoad, useToast } from '../ui';

type Candidate = Result<'labels.candidates'>[number];
const keyOf = (c: Pick<Candidate, 'article_id' | 'pack'>) => `${c.article_id}|${c.pack}`;

const FORMAT_KEY = 'labels.format';
const readFormat = (): LabelFormatId => {
  try {
    const v = localStorage.getItem(FORMAT_KEY);
    return v && v in LABEL_FORMATS ? (v as LabelFormatId) : 'a4_24';
  } catch {
    return 'a4_24';
  }
};

/**
 * Étiquettes de rayon : la liste « à refaire » (articles reçus jamais étiquetés,
 * prix changés depuis la dernière impression) ou tout le catalogue, un aperçu
 * fidèle de la planche, puis l'impression qui retient le prix imprimé.
 */
export function Labels({ active }: { active: boolean }) {
  const toast = useToast();
  const [redo, setRedo] = useState(true);
  const [departmentId, setDepartmentId] = useState('');
  const [search, setSearch] = useState('');
  const list = useLoad(() => call('labels.candidates', { redo, departmentId: departmentId || null, search: search || undefined }), [redo, departmentId, search]);
  const departments = useLoad(() => call('catalogue.departments'), []);
  // Un prix changé ailleurs pendant que la fenêtre était cachée doit apparaître.
  useEffect(() => {
    if (active) list.reload();
  }, [active]);
  const [copies, setCopies] = useState<Record<string, string>>({});
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [format, setFormatState] = useState<LabelFormatId>(readFormat);
  const [skip, setSkip] = useState('0');
  const [preview, setPreview] = useState('');
  const setFormat = (f: LabelFormatId) => {
    setFormatState(f);
    try {
      localStorage.setItem(FORMAT_KEY, f);
    } catch {
      /* préférence du poste seulement */
    }
  };

  const rows = list.data ?? [];
  // « À refaire » : tout est coché d'office.
  useEffect(() => {
    if (redo) setChecked(new Set(rows.map(keyOf)));
  }, [list.data]);

  const items = useMemo(
    () =>
      rows
        .filter((c) => checked.has(keyOf(c)))
        .map((c) => ({ articleId: c.article_id, pack: c.pack || null, copies: Math.max(0, Math.floor(Number(copies[keyOf(c)] ?? '1') || 0)) }))
        .filter((i) => i.copies > 0),
    [rows, checked, copies],
  );
  const total = items.reduce((s, i) => s + i.copies, 0);
  const skipN = Math.max(0, Math.floor(Number(skip) || 0));

  useEffect(() => {
    if (!items.length) return setPreview('');
    const t = setTimeout(() => {
      call('labels.preview', items, format, skipN).then(setPreview, (e) => toast.error(e));
    }, 250);
    return () => clearTimeout(t);
  }, [items, format, skipN]);

  const toggle = (k: string) => {
    const next = new Set(checked);
    if (next.has(k)) next.delete(k);
    else next.add(k);
    setChecked(next);
  };
  const f = LABEL_FORMATS[format];
  const perPage = f.cols * f.rows;
  const pages = Math.ceil((total + (f.cols === 1 ? 0 : Math.min(skipN, perPage - 1))) / perPage);

  return (
    <div className="page labels-page">
      <header className="page-head">
        <h1>Étiquettes</h1>
        <span className="muted">Prix du magasin, promotions comprises, avec le code-barres de l'unité ou du carton</span>
      </header>
      <div className="filters">
        <div className="seg">
          <button className={redo ? 'active' : ''} onClick={() => setRedo(true)}>
            À refaire
          </button>
          <button className={!redo ? 'active' : ''} onClick={() => (setRedo(false), setChecked(new Set()))}>
            Tous les articles
          </button>
        </div>
        <select value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}>
          <option value="">Tous les rayons</option>
          {(departments.data ?? []).map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
        <input className="search" placeholder="Rechercher" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>
      <div className="labels-body">
        <div className="labels-list">
          {rows.length === 0 ? (
            <Empty>{redo ? 'Toutes les étiquettes sont à jour.' : 'Aucun article.'}</Empty>
          ) : (
            <table className="list compact">
              <thead>
                <tr>
                  <th>
                    <input
                      type="checkbox"
                      checked={rows.length > 0 && rows.every((c) => checked.has(keyOf(c)))}
                      onChange={(e) => setChecked(e.target.checked ? new Set(rows.map(keyOf)) : new Set())}
                      title="Tout cocher"
                    />
                  </th>
                  <th>Article</th>
                  <th>Étiquette</th>
                  <th className="r">Prix</th>
                  <th>Exemplaires</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => {
                  const k = keyOf(c);
                  return (
                    <tr key={k} className={checked.has(k) ? 'selected' : ''}>
                      <td>
                        <input type="checkbox" checked={checked.has(k)} onChange={() => toggle(k)} />
                      </td>
                      <td onClick={() => toggle(k)} className="clickable">
                        {c.name} <small className="muted">{c.code}</small>
                        {c.reason === 'new' && <span className="tag normal">Nouveau</span>}
                        {c.reason === 'price' && <span className="tag alerte">Prix changé</span>}
                      </td>
                      <td>{c.pack_label}</td>
                      <td className="r">
                        {c.reason === 'price' && c.last_price !== null && <s className="muted">{fcfa(c.last_price)}</s>} {fcfa(c.price)}
                      </td>
                      <td>
                        <input
                          className="qty small"
                          inputMode="numeric"
                          value={copies[k] ?? '1'}
                          onChange={(e) => {
                            setCopies({ ...copies, [k]: e.target.value });
                            if (!checked.has(k)) toggle(k);
                          }}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
        <aside className="labels-side">
          <label>
            Format
            <select value={format} onChange={(e) => setFormat(e.target.value as LabelFormatId)}>
              {Object.entries(LABEL_FORMATS).map(([id, v]) => (
                <option key={id} value={id}>
                  {v.name}
                </option>
              ))}
            </select>
          </label>
          {f.cols > 1 && (
            <label>
              Étiquettes déjà utilisées sur la planche
              <input inputMode="numeric" value={skip} onChange={(e) => setSkip(e.target.value)} />
            </label>
          )}
          <div className="labels-preview">
            {preview ? <iframe title="Aperçu des étiquettes" srcDoc={preview} style={{ width: `${f.pageW}mm`, height: `${f.pageH * Math.max(1, pages)}mm` }} /> : <Empty>Cochez des étiquettes pour voir l'aperçu.</Empty>}
          </div>
          <div className="actions">
            <span className="muted">
              {total} étiquette{total > 1 ? 's' : ''}
              {f.cols > 1 && total > 0 ? ` · ${pages} planche${pages > 1 ? 's' : ''}` : ''}
            </span>
            <button
              className="primary"
              disabled={!total}
              onClick={async () => {
                try {
                  if (await call('labels.print', items, format, skipN)) {
                    toast.ok(`${total} étiquette${total > 1 ? 's' : ''} envoyée${total > 1 ? 's' : ''} à l'imprimante`);
                    setSkip('0');
                    list.reload();
                  }
                } catch (err) {
                  toast.error(err);
                }
              }}
            >
              Imprimer
            </button>
          </div>
        </aside>
      </div>
    </div>
  );
}
