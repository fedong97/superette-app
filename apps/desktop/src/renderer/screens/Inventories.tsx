import { useRef, useState } from 'react';
import { readXlsxRows } from '@superette/core';
import { type Result, call } from '../api';
import { Empty, Field, Modal, dateFr, dateTime, downloadText, fcfa, has, qty, today, useLoad, useToast } from '../ui';
import { saveXlsx } from './Controls';
import { ArticlePicker, WarehouseSelect } from './pickers';

type User = NonNullable<Result<'app.state'>['user']>;
type Inventory = Result<'inventories.list'>[number];
type Detail = Result<'inventories.get'>;
type Line = Detail['lines'][number];

const STATUS = { open: 'En cours', closed: 'Clôturé', cancelled: 'Annulé' } as const;
const KIND = { global: 'Global', partial: 'Partiel' } as const;

/** « L'inventaire est déficitaire de … », comme dans KONTROL. */
const observation = (gap: number) => (gap < 0 ? `Déficitaire de ${fcfa(-gap)}` : gap > 0 ? `Excédentaire de ${fcfa(gap)}` : 'Sans écart');

/**
 * Inventaires enregistrés : liste des inventaires, puis fiche de saisie où la
 * liste des produits s'affiche et où l'on tape seulement les quantités comptées.
 */
export function Inventories({ user }: { user: User }) {
  const [openId, setOpenId] = useState<string | null>(null);
  return openId ? <InventoryDetail id={openId} user={user} onBack={() => setOpenId(null)} /> : <InventoryList user={user} onOpen={setOpenId} />;
}

function InventoryList({ user, onOpen }: { user: User; onOpen: (id: string) => void }) {
  const list = useLoad(() => call('inventories.list'), []);
  const [creating, setCreating] = useState<'global' | 'partial' | null>(null);
  const canManage = has(user, 'inventory');
  const rows = list.data ?? [];
  return (
    <div className="inventories">
      <div className="filters">
        {canManage && (
          <>
            <button className="primary" onClick={() => setCreating('global')}>
              Nouvel inventaire global
            </button>
            <button onClick={() => setCreating('partial')}>Nouvel inventaire partiel</button>
          </>
        )}
        <span className="muted">Cliquez un inventaire pour saisir les quantités ou voir le résultat.</span>
      </div>
      {rows.length === 0 ? (
        <Empty>Aucun inventaire. {canManage ? 'Créez un inventaire global (tous les produits) ou partiel (des rayons ou des produits choisis).' : ''}</Empty>
      ) : (
        <table className="list">
          <thead>
            <tr>
              <th>N°</th>
              <th>Date</th>
              <th>Dépôt</th>
              <th>Rayons</th>
              <th>Statut</th>
              <th>Type</th>
              <th>Clôturé le</th>
              <th className="r">Produits</th>
              <th className="r">Valeur comptée</th>
              <th className="r">Montant écart</th>
              <th>Observation</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((i) => (
              <tr key={i.id} className="clickable" onClick={() => onOpen(i.id)}>
                <td>{i.number}</td>
                <td>{dateFr(i.inventory_date)}</td>
                <td>{i.warehouse_name}</td>
                <td>{i.kind === 'global' ? 'Tous' : i.departments.join(', ') || 'Produits choisis'}</td>
                <td>
                  <span className={`tag ${i.status === 'open' ? 'alerte' : i.status === 'closed' ? 'normal' : ''}`}>{STATUS[i.status]}</span>
                </td>
                <td>{KIND[i.kind]}</td>
                <td>{i.closed_at ? dateTime(i.closed_at) : ''}</td>
                <td className="r">
                  {i.counted_count} / {i.line_count}
                </td>
                <td className="r">{fcfa(i.counted_value)}</td>
                <td className={`r ${i.gap_value < 0 ? 'neg' : i.gap_value > 0 ? 'pos' : ''}`}>{fcfa(i.gap_value)}</td>
                <td className="muted">{i.status === 'cancelled' ? '' : `${observation(i.gap_value)}${i.status === 'open' ? ' (provisoire)' : ''}`}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th colSpan={8}>Somme (inventaires clôturés)</th>
              <th className="r">{fcfa(rows.filter((i) => i.status === 'closed').reduce((t, i) => t + i.counted_value, 0))}</th>
              <th className="r">{fcfa(rows.filter((i) => i.status === 'closed').reduce((t, i) => t + i.gap_value, 0))}</th>
              <th />
            </tr>
          </tfoot>
        </table>
      )}
      {creating && (
        <NewInventory
          kind={creating}
          onClose={() => setCreating(null)}
          onCreated={(id) => {
            setCreating(null);
            onOpen(id);
          }}
        />
      )}
    </div>
  );
}

function NewInventory({ kind, onClose, onCreated }: { kind: 'global' | 'partial'; onClose: () => void; onCreated: (id: string) => void }) {
  const toast = useToast();
  const departments = useLoad(() => call('catalogue.departments'), []);
  const [warehouseId, setWarehouseId] = useState('');
  const [date, setDate] = useState(today());
  const [label, setLabel] = useState('');
  const [chosen, setChosen] = useState<string[]>([]);
  return (
    <Modal title={kind === 'global' ? 'Nouvel inventaire global' : 'Nouvel inventaire partiel'} onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            const inv = await call('inventories.create', { warehouseId, kind, departmentIds: chosen, date, label: label || null });
            toast.ok(`Inventaire n° ${inv.number} ouvert : ${inv.line_count} produits`);
            onCreated(inv.id);
          } catch (err) {
            toast.error(err);
          }
        }}
      >
        <p className="muted">
          {kind === 'global'
            ? 'Tous les produits actifs du dépôt. À la clôture, les produits non comptés passent à zéro.'
            : 'Les produits des rayons cochés ; vous pourrez aussi ajouter des produits un par un. À la clôture, les produits non comptés ne changent pas.'}
        </p>
        <div className="grid2">
          <WarehouseSelect value={warehouseId} onChange={setWarehouseId} />
          <Field label="Date d'inventaire" hint="Une date passée (fin d'exercice) arrête le stock à la fin de ce jour-là">
            <input type="date" value={date} max={today()} onChange={(e) => setDate(e.target.value)} required />
          </Field>
        </div>
        <Field label="Libellé (facultatif)">
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Inventaire de fin d'année, rayon boissons…" />
        </Field>
        {kind === 'partial' && (
          <Field label="Rayons à inventorier">
            <div className="checks">
              {(departments.data ?? []).map((d) => (
                <label key={d.id}>
                  <input
                    type="checkbox"
                    checked={chosen.includes(d.id)}
                    onChange={(e) => setChosen(e.target.checked ? [...chosen, d.id] : chosen.filter((x) => x !== d.id))}
                  />{' '}
                  {d.name}
                </label>
              ))}
            </div>
          </Field>
        )}
        <div className="actions">
          <button type="button" onClick={onClose}>
            Annuler
          </button>
          <button type="submit" className="primary" disabled={!warehouseId}>
            Créer l'inventaire
          </button>
        </div>
      </form>
    </Modal>
  );
}

type Filter = 'all' | 'todo' | 'counted' | 'gaps' | 'surplus' | 'shortage' | 'ok';
const FILTERS: [Filter, string][] = [
  ['all', 'Pas de filtre'],
  ['todo', 'Non comptés'],
  ['counted', 'Comptés'],
  ['gaps', 'Avec écart'],
  ['surplus', 'Excédentaires'],
  ['shortage', 'Déficitaires'],
  ['ok', 'Sans écart'],
];

/** Cases de saisie d'une ligne : une par conditionnement (carton, paquet…) puis l'unité. */
const levels = (l: Line) =>
  l.unit === 'piece'
    ? [...l.packs.map((p) => ({ name: p.name, units: p.units })), { name: l.unit_name || 'Pièce', units: 1000 }]
    : [{ name: l.unit === 'kg' ? 'kg' : 'litres', units: 1000 }];

/** Valeurs affichées dans les cases : la saisie en cours, sinon le détail ou le total compté. */
const shownParts = (l: Line): string[] => {
  const lv = levels(l);
  if (l.counted === null) return lv.map(() => '');
  if (l.counted_detail && l.counted_detail.length === lv.length) return l.counted_detail.map((n) => (n ? String(n) : ''));
  return lv.map((_, i) => (i === lv.length - 1 ? String(l.counted! / 1000).replace('.', ',') : ''));
};

const toNumber = (v: string) => Number(v.trim().replace(/\s/g, '').replace(',', '.'));

function InventoryDetail({ id, user, onBack }: { id: string; user: User; onBack: () => void }) {
  const toast = useToast();
  const data = useLoad(() => call('inventories.get', id), [id]);
  const history = useLoad(() => call('inventories.history', id), [id]);
  const [edits, setEdits] = useState<Record<string, string[]>>({});
  const [search, setSearch] = useState('');
  const [filter, setFilterState] = useState<Filter>('all');
  // Lignes saisies depuis le choix du filtre : elles restent affichées (« Non comptés »).
  const [kept, setKept] = useState<string[]>([]);
  const setFilter = (f: Filter) => {
    setFilterState(f);
    setKept([]);
  };
  const [hideIdle, setHideIdle] = useState(false);
  const [closing, setClosing] = useState(false);
  const [sheetFormat, setSheetFormat] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const tableRef = useRef<HTMLTableSectionElement>(null);
  const reload = () => {
    data.reload();
    history.reload();
  };

  if (!data.data) return null;
  const { inventory: inv, lines } = data.data;
  const open = inv.status === 'open';
  const canManage = has(user, 'inventory');
  const q = search.trim().toLowerCase();
  const shown = lines.filter((l) => {
    if (hideIdle && l.opening_qty === 0 && l.period_qty === 0 && l.counted === null) return false;
    if (q && !l.name.toLowerCase().includes(q) && !l.code.toLowerCase().includes(q) && !l.barcodes.includes(search.trim())) return false;
    if (kept.includes(l.article_id)) return true;
    const d = l.difference;
    switch (filter) {
      case 'todo':
        return l.counted === null;
      case 'counted':
        return l.counted !== null;
      case 'gaps':
        return d !== null && d !== 0;
      case 'surplus':
        return d !== null && d > 0;
      case 'shortage':
        return d !== null && d < 0;
      case 'ok':
        return d === 0;
      default:
        return true;
    }
  });
  const counted = lines.filter((l) => l.counted !== null);
  const totalGap = lines.reduce((t, l) => t + (l.gap_value ?? 0), 0);
  const totalCounted = lines.reduce((t, l) => t + (l.counted_value ?? 0), 0);

  /** Enregistre la saisie d'une ligne (Entrée ou sortie de la case). */
  const commit = async (l: Line) => {
    const parts = edits[l.article_id];
    if (!parts) return;
    const lv = levels(l);
    let total: number | null = null;
    if (parts.some((p) => p.trim() !== '')) {
      total = 0;
      for (const [i, p] of parts.entries()) {
        if (!p.trim()) continue;
        const n = toNumber(p);
        if (!Number.isFinite(n) || n < 0) return toast.error(`Quantité invalide pour ${l.name}`);
        total += Math.round(n * lv[i]!.units);
      }
    }
    try {
      await call('inventories.setCount', id, l.article_id, total, total === null || lv.length === 1 ? null : parts.map((p) => (p.trim() ? toNumber(p) : 0)));
      setEdits(({ [l.article_id]: _, ...rest }) => rest);
      setKept((k) => (k.includes(l.article_id) ? k : [...k, l.article_id]));
      reload();
    } catch (err) {
      toast.error(err);
    }
  };
  /** Entrée : passe à la case suivante, puis à la ligne suivante. */
  const next = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const inputs = [...(tableRef.current?.querySelectorAll<HTMLInputElement>('input.inv-count') ?? [])];
    const at = inputs.indexOf(e.currentTarget);
    const to = inputs[at + 1];
    if (!to) return e.currentTarget.blur();
    to.focus();
    to.select();
  };
  /** Recherche ou scan : Entrée sur un code exact place le curseur sur ce produit. */
  const jump = () => {
    const code = search.trim();
    const hit = lines.find((l) => l.code === code || l.barcodes.includes(code)) ?? (shown.length === 1 ? shown[0] : undefined);
    if (!hit) return;
    const input = tableRef.current?.querySelector<HTMLInputElement>(`tr[data-article="${hit.article_id}"] input.inv-count`);
    input?.focus();
    input?.select();
  };

  const file = `inventaire-${inv.number}-${inv.inventory_date}`;
  const exportXlsx = () =>
    saveXlsx(`${file}.xlsx`, {
      name: `Inventaire ${inv.number}`,
      title: [`Inventaire n° ${inv.number} (${KIND[inv.kind].toLowerCase()}) · ${inv.warehouse_name} · ${dateFr(inv.inventory_date)} · ${STATUS[inv.status]}`],
      columns: [
        { header: 'Code', width: 14 },
        { header: 'Produit', width: 32 },
        { header: 'Rayon', width: 16 },
        { header: "Stock à l'ouverture", format: 'qty' },
        { header: 'Mvts période', format: 'qty' },
        { header: 'Stock attendu', format: 'qty' },
        { header: 'Compté', format: 'qty' },
        { header: 'Écart', format: 'qty' },
        { header: 'CMUP', format: 'money' },
        { header: 'Montant écart', format: 'money' },
        { header: 'Valeur comptée', format: 'money' },
        { header: 'Saisi par', width: 16 },
      ],
      rows: lines.map((l) => [
        l.code,
        l.name,
        l.department_name ?? '',
        l.opening_qty / 1000,
        l.period_qty / 1000,
        l.expected / 1000,
        l.counted === null ? null : l.counted / 1000,
        l.difference === null ? null : l.difference / 1000,
        l.unit_cost,
        l.gap_value,
        l.counted_value,
        l.counted_by_name ?? '',
      ]),
      totalRow: ['Totaux', '', '', null, null, null, null, null, null, totalGap, totalCounted, ''],
    });
  const exportCsv = () => {
    const n = (v: number | null) => (v === null ? '' : String(v / 1000).replace('.', ','));
    const cell = (v: string) => (/[;"\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    const csv = [
      'Code;Produit;Rayon;Stock attendu;Compté;Écart;CMUP;Montant écart',
      ...lines.map((l) =>
        [cell(l.code), cell(l.name), cell(l.department_name ?? ''), n(l.expected), n(l.counted), n(l.difference), String(l.unit_cost), l.gap_value === null ? '' : String(l.gap_value)].join(';'),
      ),
    ].join('\r\n');
    downloadText(`${file}.csv`, `﻿${csv}`);
  };
  /** Fiche Excel à remplir : un nombre de conditionnements principaux et d'unités par produit, à réimporter ensuite. */
  const exportBlankXlsx = (model: SheetModel) => {
    const withExpected = model === 'withStock' || model === 'control';
    const filled = model === 'control' || model === 'counted';
    saveXlsx(`${file}-fiche-a-remplir.xlsx`, {
      name: `Comptage ${inv.number}`,
      title: [`Inventaire n° ${inv.number} · ${inv.warehouse_name} · fiche de comptage à remplir puis à réimporter (bouton Importer)`],
      columns: [
        { header: 'Code', width: 14 },
        { header: 'Produit', width: 32 },
        { header: 'Rayon', width: 16 },
        { header: 'Conditionnement', width: 18 },
        ...(withExpected ? [{ header: 'Attendu (unités)', format: 'qty' as const }] : []),
        { header: 'Compté (conditionnements)', width: 16, format: 'qty' as const },
        { header: 'Compté (unités)', width: 14, format: 'qty' as const },
      ],
      rows: lines.map((l) => {
        const pack = l.unit === 'piece' ? l.packs[0] : undefined;
        const counted = filled && l.counted !== null ? l.counted / 1000 : null;
        return [
          l.code,
          l.name,
          l.department_name ?? '',
          pack ? `${pack.name} de ${pack.units / 1000}` : '',
          ...(withExpected ? [l.expected / 1000] : []),
          null,
          counted,
        ];
      }),
    });
  };
  /** Lignes d'un CSV ou d'un classeur : colonne Code, puis Compté / Quantité, ou conditionnements + unités. */
  const importRows = async (rows: string[][]) => {
    const headAt = rows.findIndex((r) => r.some((c) => c.trim().toLowerCase().startsWith('code')));
    const head = headAt >= 0 ? rows[headAt]!.map((h) => h.trim().toLowerCase()) : [];
    const codeAt = headAt >= 0 ? head.findIndex((h) => h.startsWith('code')) : 0;
    const packAt = head.findIndex((h) => /compt.*condition/.test(h));
    const unitAt = head.findIndex((h) => /compt.*unit/.test(h));
    const qtyAt = headAt < 0 ? 1 : unitAt >= 0 ? unitAt : head.findIndex((h) => /compt|quant|qt/.test(h));
    if (qtyAt < 0) return toast.error('Colonne « Compté » ou « Quantité » introuvable');
    const byCode = new Map(lines.flatMap((l) => [[l.code, l] as const, ...l.barcodes.map((b) => [b, l] as const)]));
    const parsed: { code: string; qty: number }[] = [];
    for (const c of rows.slice(headAt + 1)) {
      const code = c[codeAt]?.trim();
      const units = c[qtyAt]?.trim() ?? '';
      const packs = packAt >= 0 ? (c[packAt]?.trim() ?? '') : '';
      if (!code || (units === '' && packs === '')) continue;
      const line = byCode.get(code);
      const per = line && line.unit === 'piece' && line.packs[0] ? line.packs[0].units / 1000 : 0;
      const n = (units ? toNumber(units) : 0) + (packs ? toNumber(packs) * per : 0);
      if (!Number.isFinite(n) || n < 0) return toast.error(`Quantité invalide pour le code ${code}`);
      parsed.push({ code, qty: n });
    }
    try {
      const r = await call('inventories.import', id, parsed);
      toast.ok(`${r.imported} quantités importées${r.unknown.length ? ` · codes inconnus : ${r.unknown.slice(0, 5).join(', ')}${r.unknown.length > 5 ? '…' : ''}` : ''}`);
      reload();
    } catch (err) {
      toast.error(err);
    }
  };
  const importFile = async (f: File) => {
    try {
      if (/\.xlsx$/i.test(f.name)) return void (await importRows(await readXlsxRows(new Uint8Array(await f.arrayBuffer()))));
      const text = (await f.text()).replace(/^\uFEFF/, '');
      const raw = text.split(/\r?\n/).filter((r) => r.trim());
      if (!raw.length) return toast.error('Fichier vide');
      const sep = raw[0]!.includes(';') ? ';' : raw[0]!.includes('\t') ? '\t' : ',';
      await importRows(raw.map((r) => r.split(sep).map((c) => c.trim().replace(/^"|"$/g, ''))));
    } catch (err) {
      toast.error(err);
    }
  };

  return (
    <div className="inventory">
      <div className="inv-head">
        <Field label="N°">
          <input readOnly value={inv.number} />
        </Field>
        <Field label="Date">
          <input readOnly value={dateFr(inv.inventory_date)} />
        </Field>
        <Field label="Dépôt">
          <input readOnly value={inv.warehouse_name} />
        </Field>
        <Field label="Rayons">
          <input readOnly value={inv.kind === 'global' ? 'Tous (global)' : inv.departments.join(', ') || 'Produits choisis'} />
        </Field>
        <Field label="Statut">
          <input readOnly value={STATUS[inv.status]} />
        </Field>
        <Field label="Clôturé le">
          <input readOnly value={inv.closed_at ? `${dateTime(inv.closed_at)} · ${inv.closed_by_name ?? ''}` : ''} />
        </Field>
      </div>
      {inv.label && <p className="muted">{inv.label}</p>}
      <div className="inv-actions">
        <button onClick={onBack}>← Liste des inventaires</button>
        <button onClick={() => setSheetFormat(true)}>Fiche de comptage…</button>
        <button onClick={exportXlsx}>Exporter Excel</button>
        <button onClick={exportCsv}>Exporter CSV</button>
        {open && <button onClick={() => fileRef.current?.click()}>Importer (Excel ou CSV)</button>}
        <button onClick={() => call('inventories.printResult', id).catch(toast.error)}>Imprimer le résultat</button>
        <span className="spacer" />
        {open && canManage && (
          <>
            <button
              className="ghost"
              onClick={async () => {
                if (!confirm(`Annuler l'inventaire n° ${inv.number} ? Le stock ne sera pas modifié.`)) return;
                try {
                  await call('inventories.cancel', id);
                  reload();
                } catch (err) {
                  toast.error(err);
                }
              }}
            >
              Annuler l'inventaire
            </button>
            <button className="danger" onClick={() => setClosing(true)}>
              Clôturer l'inventaire…
            </button>
          </>
        )}
        <input
          ref={fileRef}
          type="file"
          accept=".csv,.txt,.xlsx"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) void importFile(f);
          }}
        />
      </div>
      <div className="filters">
        <input
          className="inv-search"
          placeholder="Rechercher ou scanner un produit, puis Entrée"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && jump()}
        />
        <select value={filter} onChange={(e) => setFilter(e.target.value as Filter)}>
          {FILTERS.map(([k, label]) => (
            <option key={k} value={k}>
              {label}
            </option>
          ))}
        </select>
        <label>
          <input type="checkbox" checked={hideIdle} onChange={(e) => setHideIdle(e.target.checked)} /> Masquer les produits sans mouvement ni stock
        </label>
        {open && (
          <div className="inv-add">
            <ArticlePicker
              placeholder="Ajouter un produit à l'inventaire"
              onPick={(a) =>
                call('inventories.addArticle', id, a.id).then(() => {
                  toast.ok(`${a.name} ajouté`);
                  reload();
                }, toast.error)
              }
            />
          </div>
        )}
      </div>
      <div className="inv-scroll">
        <table className="list compact inv-table">
          <thead>
            <tr>
              <th>Réf.</th>
              <th>Produit</th>
              <th>Rayon</th>
              <th className="r">Stock à l'ouverture</th>
              <th className="r">Mvts période</th>
              <th className="r">Stock attendu</th>
              <th>Stock physique compté</th>
              <th className="r">Écart</th>
              <th className="r">CMUP</th>
              <th className="r">Montant écart</th>
              <th className="r">Valeur comptée</th>
              <th>Saisi par</th>
              {open && <th />}
            </tr>
          </thead>
          <tbody ref={tableRef}>
            {shown.map((l) => {
              const lv = levels(l);
              const parts = edits[l.article_id] ?? shownParts(l);
              const d = l.difference;
              const cls = d === null ? '' : d < 0 ? 'inv-short' : d > 0 ? 'inv-surplus' : 'inv-ok';
              return (
                <tr key={l.article_id} data-article={l.article_id} className={cls}>
                  <td>{l.code}</td>
                  <td>{l.name}</td>
                  <td>{l.department_name ?? ''}</td>
                  <td className="r">{qty(l.opening_qty, l.unit)}</td>
                  <td className="r">{l.period_qty ? qty(l.period_qty, l.unit) : ''}</td>
                  <td className="r">{qty(l.expected, l.unit)}</td>
                  <td>
                    <div className="inv-parts">
                    {open ? (
                      lv.map((v, k) => (
                        <label key={v.name}>
                          <input
                            className="inv-count"
                            inputMode="decimal"
                            value={parts[k] ?? ''}
                            placeholder="—"
                            onChange={(e) => setEdits({ ...edits, [l.article_id]: parts.map((p, m) => (m === k ? e.target.value : p)) })}
                            onBlur={(e) => {
                              // Enregistre en quittant la ligne, pas en passant du carton aux pièces.
                              if (!e.currentTarget.closest('tr')?.contains(e.relatedTarget as Node | null)) void commit(l);
                            }}
                            onKeyDown={next}
                          />
                          {lv.length > 1 && <small>{v.name}</small>}
                        </label>
                      ))
                    ) : (
                      <span>{l.counted === null ? '—' : qty(l.counted, l.unit)}</span>
                    )}
                    {open && lv.length > 1 && l.counted !== null && <small className="muted"> = {qty(l.counted, l.unit)}</small>}
                    </div>
                  </td>
                  <td className="r">{d === null ? '' : qty(d, l.unit)}</td>
                  <td className="r">{fcfa(l.unit_cost)}</td>
                  <td className="r">{l.gap_value === null ? '' : fcfa(l.gap_value)}</td>
                  <td className="r">{l.counted_value === null ? '' : fcfa(l.counted_value)}</td>
                  <td title={l.counted_at ? dateTime(l.counted_at) : ''}>{l.counted_by_name ?? ''}</td>
                  {open && (
                    <td>
                      {l.counted === null && canManage && (
                        <button
                          className="link"
                          title="Retirer ce produit de l'inventaire"
                          onClick={() => call('inventories.removeArticle', id, l.article_id).then(reload, toast.error)}
                        >
                          ✕
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              );
            })}
            {!shown.length && (
              <tr>
                <td colSpan={13} className="muted">
                  Aucun produit pour ce filtre
                </td>
              </tr>
            )}
          </tbody>
          <tfoot>
            <tr>
              <th colSpan={9}>
                Somme · {counted.length} produits comptés sur {lines.length}
              </th>
              <th className="r">{fcfa(totalGap)}</th>
              <th className="r">{fcfa(totalCounted)}</th>
              <th colSpan={open ? 2 : 1} />
            </tr>
          </tfoot>
        </table>
      </div>
      <div className="inv-foot">
        <div className="inv-legend">
          <span className="inv-ok">Sans écart</span>
          <span className="inv-surplus">Excédentaire</span>
          <span className="inv-short">Déficitaire</span>
          <span>Non compté</span>
        </div>
        <table className="list compact inv-history">
          <thead>
            <tr>
              <th>Historique des saisies</th>
              <th className="r">Saisies</th>
              <th>Date</th>
            </tr>
          </thead>
          <tbody>
            {(history.data ?? []).map((h, i) => (
              <tr key={i}>
                <td>{h.user_name}</td>
                <td className="r">{h.count}</td>
                <td>{dateTime(h.at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <strong className={totalGap < 0 ? 'neg' : totalGap > 0 ? 'pos' : ''}>
          L'inventaire est {totalGap < 0 ? `déficitaire de ${fcfa(-totalGap)}` : totalGap > 0 ? `excédentaire de ${fcfa(totalGap)}` : 'sans écart'}
          {open ? ' (provisoire)' : ''}
        </strong>
      </div>
      {sheetFormat && (
        <SheetFormatDialog
          onClose={() => setSheetFormat(false)}
          onChoose={async (model, output) => {
            setSheetFormat(false);
            if (output === 'excel') return exportBlankXlsx(model);
            try {
              await call('inventories.printSheet', id, { model, output });
            } catch (err) {
              toast.error(err);
            }
          }}
        />
      )}
      {closing && (
        <CloseInventory
          inventory={inv}
          lines={lines}
          onClose={() => setClosing(false)}
          onDone={() => {
            setClosing(false);
            reload();
          }}
        />
      )}
    </div>
  );
}

function CloseInventory({ inventory: inv, lines, onClose, onDone }: { inventory: Inventory; lines: Line[]; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const todo = lines.filter((l) => l.counted === null);
  const gap = lines.reduce((t, l) => t + (l.gap_value ?? 0), 0);
  // Inventaire global : un non compté passe à zéro ; son stock attendu part en écart.
  const zeroed = inv.kind === 'global' ? todo.filter((l) => l.expected !== 0) : [];
  const zeroValue = zeroed.reduce((t, l) => t - Math.round((l.expected * l.unit_cost) / 1000), 0);
  return (
    <Modal title={`Clôturer l'inventaire n° ${inv.number}`} onClose={onClose} wide={zeroed.length > 0}>
      <p>
        {lines.length - todo.length} produits comptés sur {lines.length}. Écart des produits comptés : <b>{fcfa(gap)}</b>.
      </p>
      {inv.kind === 'global' ? (
        zeroed.length ? (
          <>
            <p className="danger-text">
              {zeroed.length} produit(s) non compté(s) avec du stock en machine passeront à zéro, soit {fcfa(zeroValue)} de plus :
            </p>
            <div className="inv-scroll short">
              <table className="list compact">
                <tbody>
                  {zeroed.map((l) => (
                    <tr key={l.article_id}>
                      <td>{l.name}</td>
                      <td className="r">{qty(l.expected, l.unit)}</td>
                      <td className="r">{fcfa(-Math.round((l.expected * l.unit_cost) / 1000))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ) : (
          <p className="muted">Tous les produits avec du stock ont été comptés.</p>
        )
      ) : (
        todo.length > 0 && <p className="muted">{todo.length} produit(s) non compté(s) : leur stock ne change pas (inventaire partiel).</p>
      )}
      <p>Le stock sera corrigé (mouvements « Inventaire n° {inv.number} ») et l'inventaire ne pourra plus être modifié.</p>
      <div className="actions">
        <button onClick={onClose}>Revenir à la saisie</button>
        <button
          className="danger"
          onClick={async () => {
            try {
              const r = await call('inventories.close', inv.id);
              toast.ok(`Inventaire n° ${r.number} clôturé : ${observation(r.gap_value).replace(/^./, (c) => c.toLowerCase())}`);
              onDone();
            } catch (err) {
              toast.error(err);
            }
          }}
        >
          Clôturer et corriger le stock
        </button>
      </div>
    </Modal>
  );
}

type SheetModel = 'blind' | 'withStock' | 'control' | 'counted';
type SheetOutput = 'a4' | 'ticket' | 'pdf' | 'excel';
const SHEET_MODELS: [SheetModel, string, string][] = [
  ['blind', 'Modèle classique, sans stock', 'Comptage à l’aveugle : le compteur ne voit pas le stock'],
  ['withStock', 'Modèle classique, avec stock', 'Le stock attendu est imprimé à côté des cases'],
  ['control', 'Stock compté + stock attendu', 'Pour contrôler les écarts après le comptage'],
  ['counted', 'Stock compté uniquement', 'Les quantités déjà saisies'],
];
const SHEET_OUTPUTS: [SheetOutput, string, string][] = [
  ['a4', 'Imprimante A4 ou de listing', 'La fenêtre d’impression Windows permet de choisir l’imprimante'],
  ['ticket', 'Imprimante de tickets (80 mm)', 'Sur l’imprimante de caisse réglée dans Administration'],
  ['pdf', 'Enregistrer en PDF', 'Pour l’envoyer ou l’imprimer ailleurs'],
  ['excel', 'Fichier Excel à remplir', 'À remplir sur un autre PC puis à réimporter avec « Importer »'],
];

/** Choix du modèle et de la sortie de la fiche de comptage, comme dans KONTROL. */
function SheetFormatDialog({ onClose, onChoose }: { onClose: () => void; onChoose: (model: SheetModel, output: SheetOutput) => void }) {
  const [model, setModel] = useState<SheetModel>('blind');
  const [output, setOutput] = useState<SheetOutput>('a4');
  return (
    <Modal title="Choisir un format de la fiche de comptage" onClose={onClose}>
      <h3>Modèle de document</h3>
      <div className="radio-list">
        {SHEET_MODELS.map(([k, label, hint]) => (
          <label key={k}>
            <input type="radio" name="model" checked={model === k} onChange={() => setModel(k)} />
            <span>
              {label}
              <small>{hint}</small>
            </span>
          </label>
        ))}
      </div>
      <h3>Sortie</h3>
      <div className="radio-list">
        {SHEET_OUTPUTS.map(([k, label, hint]) => (
          <label key={k}>
            <input type="radio" name="output" checked={output === k} onChange={() => setOutput(k)} />
            <span>
              {label}
              <small>{hint}</small>
            </span>
          </label>
        ))}
      </div>
      <div className="actions">
        <button onClick={onClose}>Fermer</button>
        <button className="primary" onClick={() => onChoose(model, output)}>
          OK
        </button>
      </div>
    </Modal>
  );
}
