import { useEffect, useRef, useState } from 'react';
import { call } from './api';
import { useToast } from './ui';

/**
 * Listes plus pratiques, sur toutes les listes du logiciel (`table.list`) :
 * tri d'un clic sur l'en-tête, colonnes à cacher et à ranger, filtre rapide,
 * vues enregistrées par utilisateur, impression, Excel et PDF. Les réglages
 * de chaque liste sont gardés dans les préférences de l'utilisateur.
 */

export interface ListView {
  name: string;
  hidden: string[];
  order: string[];
  sort: { col: string; dir: 'asc' | 'desc' } | null;
  filter: string;
}

export type ListPrefs = Record<string, { hidden?: string[]; order?: string[]; sort?: ListView['sort']; views?: ListView[] }>;

const SKIP = '.pos-screen, .modal, [data-lv-off]';

/** Libellés des en-têtes, dans l'ordre d'origine (React) de la liste. */
function headers(table: HTMLTableElement): string[] {
  const row = table.tHead?.rows[0];
  if (!row) return [];
  return [...row.cells].sort((a, b) => idx(a) - idx(b)).map((c, i) => c.textContent?.trim() || `Colonne ${i + 1}`);
}

/** Position d'origine d'une cellule, notée la première fois qu'on la voit. */
function idx(cell: Element): number {
  const el = cell as HTMLElement;
  if (el.dataset.lvI === undefined) el.dataset.lvI = String([...(el.parentElement?.children ?? [])].indexOf(el));
  return Number(el.dataset.lvI);
}

function keyOf(table: HTMLTableElement): string {
  const h = headers(table).join('|');
  let n = 0;
  for (let i = 0; i < h.length; i++) n = (n * 31 + h.charCodeAt(i)) | 0;
  return `t${(n >>> 0).toString(36)}`;
}

/** Valeur triable d'une cellule : nombre (montants, quantités), date, sinon texte. */
function sortValue(text: string): number | string {
  const t = text.trim();
  const date = /^(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2}):(\d{2}))?/.exec(t);
  if (date) return Number(`${date[3]}${date[2]}${date[1]}${date[4] ?? '00'}${date[5] ?? '00'}`);
  const num = t.replace(/[\s  ]|FCFA|F$|%/g, '').replace(',', '.');
  if (/^[-+−]?\d+(\.\d+)?$/.test(num)) return Number(num.replace('−', '-'));
  return t.toLowerCase();
}

function cellsOf(row: HTMLTableRowElement): HTMLTableCellElement[] {
  return [...row.cells].sort((a, b) => idx(a) - idx(b));
}

/** Applique colonnes cachées, ordre, tri et filtre à une liste. */
function apply(table: HTMLTableElement, cfg: { hidden: string[]; order: string[]; sort: ListView['sort']; filter: string }) {
  const names = headers(table);
  const hiddenIdx = new Set(cfg.hidden.map((h) => names.indexOf(h)).filter((i) => i >= 0));
  const orderIdx = cfg.order.map((h) => names.indexOf(h)).filter((i) => i >= 0);
  const position = (i: number) => {
    const p = orderIdx.indexOf(i);
    return p >= 0 ? p : orderIdx.length + i;
  };
  const grouped = [...(table.tBodies[0]?.rows ?? [])].some((r) => [...r.cells].some((c) => c.colSpan > 1));
  for (const row of [...table.rows]) {
    if ([...row.cells].some((c) => c.colSpan > 1)) continue;
    const cells = cellsOf(row);
    cells.forEach((c, i) => {
      if (hiddenIdx.has(i)) c.setAttribute('data-lv-hidden', '');
      else c.removeAttribute('data-lv-hidden');
    });
    // Ordre choisi : les cellules sont replacées dans la ligne.
    const wanted = orderIdx.length ? [...cells].sort((a, b) => position(idx(a)) - position(idx(b))) : cells;
    if (wanted.some((c, i) => row.cells[i] !== c)) for (const c of wanted) row.appendChild(c);
  }
  const body = table.tBodies[0];
  if (body) {
    const q = cfg.filter.trim().toLowerCase();
    for (const r of [...body.rows]) {
      if (q && !(r.textContent ?? '').toLowerCase().includes(q)) r.setAttribute('data-lv-hide', '');
      else r.removeAttribute('data-lv-hide');
    }
    const col = cfg.sort ? names.indexOf(cfg.sort.col) : -1;
    if (col >= 0 && !grouped) {
      const rows = [...body.rows];
      const dir = cfg.sort!.dir === 'asc' ? 1 : -1;
      const sorted = [...rows].sort((a, b) => {
        const va = sortValue(cellsOf(a)[col]?.textContent ?? '');
        const vb = sortValue(cellsOf(b)[col]?.textContent ?? '');
        if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dir;
        return String(va).localeCompare(String(vb), 'fr', { numeric: true }) * dir;
      });
      if (sorted.some((r, i) => rows[i] !== r)) for (const r of sorted) body.appendChild(r);
    }
  }
  for (const th of table.tHead?.rows[0]?.cells ?? []) {
    const name = names[idx(th)];
    if (cfg.sort && name === cfg.sort.col && !grouped) th.setAttribute('data-lv-sort', cfg.sort.dir);
    else th.removeAttribute('data-lv-sort');
  }
}

/** Titre de la liste : la fenêtre et son onglet. */
function titleOf(table: HTMLTableElement): string {
  const win = table.closest('.mdi')?.querySelector('.mdi-title')?.textContent?.trim();
  const tab = table.closest('.window')?.querySelector('.tabs button.active')?.textContent?.trim();
  return [win, tab && !win?.includes(tab) ? tab : null].filter(Boolean).join(' · ') || 'Liste';
}

/** Copie de la liste telle qu'affichée : sans colonnes ni lignes cachées. */
function visibleCopy(table: HTMLTableElement): { html: string; columns: string[]; rows: string[][] } {
  const copy = table.cloneNode(true) as HTMLTableElement;
  copy.querySelectorAll('[data-lv-hidden], [data-lv-hide]').forEach((e) => e.remove());
  copy.querySelectorAll('input, select, button').forEach((e) => {
    const v = (e as HTMLInputElement).value;
    e.replaceWith(document.createTextNode(e.tagName === 'BUTTON' ? '' : (v ?? '')));
  });
  const columns = [...(copy.tHead?.rows[0]?.cells ?? [])].map((c) => c.textContent?.trim() ?? '');
  const rows = [...copy.tBodies].flatMap((b) => [...b.rows]).map((r) => [...r.cells].map((c) => c.textContent?.trim() ?? ''));
  return { html: copy.outerHTML, columns, rows };
}

export function ListTools({ prefs, onSave }: { prefs: ListPrefs; onSave: (p: ListPrefs) => void }) {
  const toast = useToast();
  const [hover, setHover] = useState<{ table: HTMLTableElement; rect: DOMRect } | null>(null);
  const [panel, setPanel] = useState<{ table: HTMLTableElement; key: string } | null>(null);
  const [filter, setFilter] = useState<Record<string, string>>({});
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  const filterRef = useRef(filter);
  filterRef.current = filter;

  const cfgOf = (key: string) => {
    const p = prefsRef.current[key] ?? {};
    return { hidden: p.hidden ?? [], order: p.order ?? [], sort: p.sort ?? null, filter: filterRef.current[key] ?? '' };
  };
  const save = (key: string, patch: ListPrefs[string]) => onSave({ ...prefsRef.current, [key]: { ...prefsRef.current[key], ...patch } });

  // Les listes se réarrangent à chaque changement de l'écran (nouvelles lignes, actualisation).
  useEffect(() => {
    let pending = false;
    const run = () => {
      pending = false;
      observer.disconnect();
      for (const t of document.querySelectorAll<HTMLTableElement>('.windows table.list')) {
        if (t.closest(SKIP) || !t.tHead) continue;
        const key = keyOf(t);
        t.dataset.lv = key;
        apply(t, cfgOf(key));
      }
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    };
    const observer = new MutationObserver(() => {
      if (pending) return;
      pending = true;
      requestAnimationFrame(run);
    });
    run();
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefs, filter]);

  // Tri d'un clic sur l'en-tête (le même clic inverse l'ordre, le troisième l'enlève).
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const th = (e.target as HTMLElement).closest('th');
      const table = th?.closest('table.list') as HTMLTableElement | null;
      if (!th || !table || !table.dataset.lv || table.closest(SKIP) || th.closest('tbody, tfoot')) return;
      const key = table.dataset.lv;
      const col = headers(table)[idx(th)];
      if (!col) return;
      const cur = cfgOf(key).sort;
      const next: ListView['sort'] = cur?.col !== col ? { col, dir: 'asc' } : cur.dir === 'asc' ? { col, dir: 'desc' } : null;
      save(key, { sort: next });
    };
    const onMove = (e: MouseEvent) => {
      const el = e.target as HTMLElement;
      if (el.closest('.lv-tools, .lv-panel')) return;
      const table = el.closest?.('table.list') as HTMLTableElement | null;
      if (table && table.dataset.lv && !table.closest(SKIP)) setHover((h) => (h?.table === table ? h : { table, rect: table.getBoundingClientRect() }));
      else setHover((h) => (h ? null : h));
    };
    document.addEventListener('click', onClick);
    document.addEventListener('mousemove', onMove);
    return () => {
      document.removeEventListener('click', onClick);
      document.removeEventListener('mousemove', onMove);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const exportTo = async (table: HTMLTableElement, kind: 'print' | 'pdf' | 'xlsx') => {
    const title = titleOf(table);
    const v = visibleCopy(table);
    try {
      if (kind === 'xlsx') {
        const numeric = v.columns.map((_, i) => v.rows.length > 0 && v.rows.every((r) => r[i] === '' || typeof sortValue(r[i] ?? '') === 'number'));
        const rows = v.rows.map((r) => r.map((c, i) => (numeric[i] && c !== '' ? (sortValue(c) as number) : c)));
        const bytes = await call('list.xlsx', title, v.columns.map((h, i) => ({ header: h, format: numeric[i] ? 'int' : 'text' })), rows);
        const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
        const a = document.createElement('a');
        a.href = url;
        a.download = `${title.replace(/[\\/:*?"<>|]+/g, ' ').trim()}.xlsx`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      } else if (kind === 'pdf') {
        if (await call('list.pdf', title, v.html)) toast.ok('Liste enregistrée en PDF');
      } else await call('list.print', title, v.html);
    } catch (e) {
      toast.error(e);
    }
  };

  const tools = hover && !panel && (
    <div className="lv-tools" style={{ top: Math.max(4, hover.rect.top - 30), left: Math.max(4, hover.rect.right - 330) }}>
      <input
        placeholder="Filtrer la liste…"
        value={filter[hover.table.dataset.lv!] ?? ''}
        onChange={(e) => setFilter((f) => ({ ...f, [hover.table.dataset.lv!]: e.target.value }))}
      />
      <button type="button" title="Colonnes et vues de cette liste" onClick={() => setPanel({ table: hover.table, key: hover.table.dataset.lv! })}>
        ☰ Colonnes
      </button>
      <button type="button" title="Imprimer la liste" onClick={() => void exportTo(hover.table, 'print')}>
        🖨
      </button>
      <button type="button" title="Exporter vers Excel" onClick={() => void exportTo(hover.table, 'xlsx')}>
        Excel
      </button>
      <button type="button" title="Enregistrer en PDF" onClick={() => void exportTo(hover.table, 'pdf')}>
        PDF
      </button>
    </div>
  );

  return (
    <>
      {tools}
      {panel && (
        <ColumnsPanel
          names={headers(panel.table)}
          cfg={cfgOf(panel.key)}
          views={prefs[panel.key]?.views ?? []}
          onChange={(patch) => save(panel.key, patch)}
          onFilter={(f) => setFilter((x) => ({ ...x, [panel.key]: f }))}
          onClose={() => setPanel(null)}
        />
      )}
    </>
  );
}

function ColumnsPanel({
  names,
  cfg,
  views,
  onChange,
  onFilter,
  onClose,
}: {
  names: string[];
  cfg: { hidden: string[]; order: string[]; sort: ListView['sort']; filter: string };
  views: ListView[];
  onChange: (patch: ListPrefs[string]) => void;
  onFilter: (f: string) => void;
  onClose: () => void;
}) {
  const order = [...cfg.order.filter((n) => names.includes(n)), ...names.filter((n) => !cfg.order.includes(n))];
  const [viewName, setViewName] = useState('');
  const move = (i: number, d: -1 | 1) => {
    const next = [...order];
    [next[i], next[i + d]] = [next[i + d]!, next[i]!];
    onChange({ order: next });
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal lv-panel">
        <div className="modal-head">
          <h2>Colonnes et vues</h2>
          <button type="button" className="ghost" onClick={onClose} aria-label="Fermer">
            ✕
          </button>
        </div>
        <p className="muted">Cochez les colonnes à afficher et rangez-les avec les flèches. Un clic sur un en-tête trie la liste.</p>
        <ul className="lv-cols">
          {order.map((n, i) => (
            <li key={n}>
              <label>
                <input
                  type="checkbox"
                  checked={!cfg.hidden.includes(n)}
                  onChange={(e) => onChange({ hidden: e.target.checked ? cfg.hidden.filter((h) => h !== n) : [...cfg.hidden, n] })}
                />
                {n}
              </label>
              <span>
                <button type="button" className="ghost" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Monter">
                  ▲
                </button>
                <button type="button" className="ghost" disabled={i === order.length - 1} onClick={() => move(i, 1)} aria-label="Descendre">
                  ▼
                </button>
              </span>
            </li>
          ))}
        </ul>
        <h3>Vues enregistrées</h3>
        {views.length === 0 && <p className="muted">Une vue garde les colonnes, le tri et le filtre, par exemple « Ruptures boissons ».</p>}
        <div className="lv-views">
          {views.map((v) => (
            <span key={v.name} className="lv-view">
              <button type="button" onClick={() => (onChange({ hidden: v.hidden, order: v.order, sort: v.sort }), onFilter(v.filter), onClose())}>
                {v.name}
              </button>
              <button type="button" className="ghost" title="Supprimer cette vue" onClick={() => onChange({ views: views.filter((x) => x.name !== v.name) })}>
                ✕
              </button>
            </span>
          ))}
        </div>
        <form
          className="lv-save"
          onSubmit={(e) => {
            e.preventDefault();
            const name = viewName.trim();
            if (!name) return;
            onChange({ views: [...views.filter((v) => v.name !== name), { name, hidden: cfg.hidden, order: cfg.order, sort: cfg.sort, filter: cfg.filter }] });
            setViewName('');
          }}
        >
          <input placeholder="Nom de la vue (colonnes, tri et filtre actuels)" value={viewName} onChange={(e) => setViewName(e.target.value)} />
          <button type="submit" className="primary" disabled={!viewName.trim()}>
            Enregistrer la vue
          </button>
        </form>
        <div className="actions">
          <button type="button" onClick={() => (onChange({ hidden: [], order: [], sort: null }), onFilter(''))}>
            Revenir à la liste d'origine
          </button>
          <button type="button" className="primary" onClick={onClose}>
            Fermer
          </button>
        </div>
      </div>
    </div>
  );
}
