import { useEffect, useMemo, useState } from 'react';
import { LABEL_FORMATS, type LabelFormatId } from '@superette/core';
import { type Result, call } from '../api';
import { Empty, askConfirm, fcfa, useLoad, useToast } from '../ui';
import { BarcodeChip, BarcodePrintDialog } from './barcodePrint';

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
  const [mode, setMode] = useState<'shelf' | 'barcode'>('shelf');
  const [redoChoice, setRedo] = useState(true);
  // Étiquettes produit : pas de liste « à refaire » (elle suit les prix), tout le catalogue.
  const redo = redoChoice && mode === 'shelf';
  const [printing, setPrinting] = useState(false);
  const [departmentId, setDepartmentId] = useState('');
  const [search, setSearch] = useState('');
  const list = useLoad(
    () =>
      call('labels.candidates', {
        redo,
        departmentId: departmentId || null,
        search: search || undefined,
      }),
    [redo, departmentId, search],
  );
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
        .map((c) => ({
          articleId: c.article_id,
          pack: c.pack || null,
          copies: Math.max(0, Math.floor(Number(copies[keyOf(c)] ?? '1') || 0)),
        }))
        .filter((i) => i.copies > 0),
    [rows, checked, copies],
  );
  const total = items.reduce((s, i) => s + i.copies, 0);
  const missing = mode === 'barcode' ? rows.filter((c) => !c.barcode).length : 0;
  const barcodeTotal =
    mode === 'barcode'
      ? rows.filter((c) => c.barcode && checked.has(keyOf(c))).reduce((t, c) => t + Math.max(0, Math.floor(Number(copies[keyOf(c)] ?? '1') || 0)), 0)
      : 0;
  const skipN = Math.max(0, Math.floor(Number(skip) || 0));

  useEffect(() => {
    if (mode !== 'shelf' || !items.length) return setPreview('');
    const t = setTimeout(() => {
      call('labels.preview', items, format, skipN).then(setPreview, (e) => toast.error(e));
    }, 250);
    return () => clearTimeout(t);
  }, [items, format, skipN, mode]);

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
        <span className="muted">
          {mode === 'shelf'
            ? "Prix du magasin, promotions comprises, avec le code-barres de l'unité ou du carton"
            : "Le code-barres à coller sur l'article ou le carton, lu à la douchette en caisse"}
        </span>
      </header>
      <div className="filters">
        <div className="seg">
          <button className={mode === 'shelf' ? 'active' : ''} onClick={() => (setMode('shelf'), setChecked(new Set()))}>
            Étiquettes de rayon
          </button>
          <button className={mode === 'barcode' ? 'active' : ''} onClick={() => (setMode('barcode'), setChecked(new Set()))}>
            Codes-barres produit
          </button>
        </div>
        {mode === 'shelf' && (
          <div className="seg">
            <button className={redo ? 'active' : ''} onClick={() => setRedo(true)}>
              À refaire
            </button>
            <button className={!redo ? 'active' : ''} onClick={() => (setRedo(false), setChecked(new Set()))}>
              Tous les articles
            </button>
          </div>
        )}
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
            <Empty>{redo ? 'Toutes les étiquettes sont à jour.' : 'Aucun article ne correspond : changez le rayon ou la recherche.'}</Empty>
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
                  {mode === 'barcode' && <th>Code-barres</th>}
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
                        <input type="checkbox" disabled={mode === 'barcode' && !c.barcode} checked={checked.has(k)} onChange={() => toggle(k)} />
                      </td>
                      <td onClick={() => toggle(k)} className="clickable">
                        {c.name} <small className="muted">{c.code}</small>
                        {mode === 'shelf' && c.reason === 'new' && <span className="tag normal">Nouveau</span>}
                        {mode === 'shelf' && c.reason === 'price' && <span className="tag alerte">Prix changé</span>}
                      </td>
                      <td>{c.pack_label}</td>
                      {mode === 'barcode' && (
                        <td>
                          {c.barcode ? (
                            <>
                              <span className="bc-num">{c.barcode}</span> <BarcodeChip code={c.barcode} />
                            </>
                          ) : (
                            <span className="muted">Pas de code</span>
                          )}
                        </td>
                      )}
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
        {mode === 'barcode' ? (
          <aside className="labels-side">
            <p>Cochez les articles et les cartons, indiquez le nombre d'étiquettes, puis imprimez sur rouleau d'étiquettes ou sur planche A4.</p>
            {missing > 0 && (
              <div className="card">
                <p>
                  <b>{missing}</b> article(s) ou carton(s) n'ont pas de code-barres.
                </p>
                <button
                  onClick={async () => {
                    if (!(await askConfirm(`Donner un code-barres interne aux ${missing} article(s) et carton(s) sans code ?`))) return;
                    try {
                      const n = await call('catalogue.assignMissingBarcodes');
                      toast.ok(`${n} code(s)-barres créé(s)`);
                      list.reload();
                    } catch (err) {
                      toast.error(err);
                    }
                  }}
                >
                  Leur donner un code interne
                </button>
              </div>
            )}
            <div className="actions">
              <span className="muted">
                {barcodeTotal} étiquette{barcodeTotal > 1 ? 's' : ''}
              </span>
              <button className="primary" disabled={!barcodeTotal} onClick={() => setPrinting(true)}>
                Imprimer les codes-barres…
              </button>
            </div>
            {printing && (
              <BarcodePrintDialog
                title="Imprimer les codes-barres"
                rows={rows
                  .filter((c) => c.barcode && checked.has(keyOf(c)))
                  .map((c) => ({
                    articleId: c.article_id,
                    pack: c.pack || null,
                    label: `${c.name} · ${c.pack_label}`,
                    barcode: c.barcode,
                    copies: Math.max(0, Math.floor(Number(copies[keyOf(c)] ?? '1') || 0)),
                  }))}
                onClose={() => setPrinting(false)}
              />
            )}
          </aside>
        ) : (
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
              {preview ? (
                <iframe
                  title="Aperçu des étiquettes"
                  srcDoc={preview}
                  style={{
                    width: `${f.pageW}mm`,
                    height: `${f.pageH * Math.max(1, pages)}mm`,
                  }}
                />
              ) : (
                <Empty>Cochez des étiquettes pour voir l'aperçu.</Empty>
              )}
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
        )}
      </div>
    </div>
  );
}
