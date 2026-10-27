import { useState } from 'react';
import {
  ARTICLE_COLUMNS,
  type ArticleColumn,
  type ArticleImportRow,
  EXPORT_MODELS,
  type ExportArticle,
  type ExportModelId,
  IMPORT_FIELDS,
  type ImportField,
  type ImportFormat,
  type Separator,
  articlesFromCells,
  buildArticleExport,
  exportToDelimited,
  guessSeparator,
  readXlsxRows,
  splitDelimited,
} from '@superette/core';
import { type Result, call } from '../api';
import { Field, Modal, askConfirm, downloadText, fcfa, readTextFile, today, useLoad, useToast } from '../ui';
import { saveXlsx } from './Controls';

type ImportResult = Result<'catalogue.import'>;
type ImportMode = 'upsert' | 'create' | 'update';

const SEPARATORS: [Separator, string][] = [
  [';', 'Point-virgule'],
  [',', 'Virgule'],
  ['\t', 'Tabulation'],
];

const MODES: [ImportMode, string][] = [
  ['upsert', 'Créer les nouveaux et mettre à jour les autres'],
  ['create', 'Créer seulement les nouveaux articles'],
  ['update', 'Mettre à jour seulement les articles existants'],
];

/** Lignes d'exemple du modèle à remplir : un article simple, un au poids, un avec deux conditionnements. */
const EXAMPLES: ExportArticle[] = [
  {
    code: '',
    name: 'RIZ PARFUMÉ 5 KG',
    department_name: 'Épicerie',
    family_name: 'Riz',
    brand: 'Uncle Bens',
    unit: 'piece',
    unit_name: null,
    vat_rate_bp: 1925,
    purchase_price: 3800,
    store_price: 4500,
    wholesale_price: 4300,
    super_wholesale_price: null,
    min_qty: 5000,
    alert_qty: 10000,
    max_qty: null,
    perishable: 0,
    plu: null,
    other_ref: null,
    active: 1,
    substitute_code: null,
    barcodes: [{ code: '6111234567890', pack_qty: 1000 }],
    packs: [],
    stock: [],
  },
  {
    code: '',
    name: 'VIANDE DE BŒUF',
    department_name: 'Boucherie',
    family_name: 'Bœuf',
    brand: null,
    unit: 'kg',
    unit_name: null,
    vat_rate_bp: 0,
    purchase_price: 2800,
    store_price: 3500,
    wholesale_price: null,
    super_wholesale_price: null,
    min_qty: null,
    alert_qty: null,
    max_qty: null,
    perishable: 1,
    plu: '00012',
    other_ref: null,
    active: 1,
    substitute_code: null,
    barcodes: [],
    packs: [],
    stock: [],
  },
  {
    code: '',
    name: 'BIÈRE 65 CL',
    department_name: 'Boissons',
    family_name: 'Bières',
    brand: 'Castel',
    unit: 'piece',
    unit_name: 'BOUTEILLE',
    vat_rate_bp: 1925,
    purchase_price: 450,
    store_price: 650,
    wholesale_price: 600,
    super_wholesale_price: 575,
    min_qty: null,
    alert_qty: 24000,
    max_qty: null,
    perishable: 0,
    plu: null,
    other_ref: null,
    active: 1,
    substitute_code: null,
    barcodes: [{ code: '6009876543210', pack_qty: 1000 }],
    packs: [
      { name: 'PALETTE', contains: 50, units: 600_000, sale_price: 360_000, wholesale_price: 340_000, super_wholesale_price: null, barcode: null },
      { name: 'CASIER', contains: 12, units: 12_000, sale_price: 7_500, wholesale_price: 7_000, super_wholesale_price: 6_800, barcode: null },
    ],
    stock: [],
  },
];

/** Modèle Excel à remplir : les colonnes du catalogue complet, avec trois exemples. */
export function downloadImportTemplate() {
  const data = buildArticleExport('catalogue', EXAMPLES);
  saveXlsx('modele-import-articles.xlsx', { name: 'Articles', columns: data.columns, rows: data.rows });
}

async function readCells(file: File, separator: Separator | null): Promise<string[][]> {
  if (/\.xlsx$/i.test(file.name)) return readXlsxRows(new Uint8Array(await file.arrayBuffer()));
  const text = await readTextFile(file);
  return splitDelimited(text, separator ?? guessSeparator(text));
}

/**
 * Import du catalogue : fichier Excel ou CSV, aux en-têtes d'ONIX (ceux
 * de l'export), d'autres logiciels de gestion, ou selon un format paramétrable. Chaque
 * fichier est d'abord vérifié en aperçu (créations, mises à jour, erreurs) ;
 * rien n'est enregistré avant « Importer ».
 */
export function ImportDialog({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const formats = useLoad(() => call('formats.list').then((l) => l.filter((f): f is ImportFormat => f.kind === 'articles')));
  const [formatId, setFormatId] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [cells, setCells] = useState<string[][]>([]);
  const [mode, setMode] = useState<ImportMode>('upsert');
  const [draft, setDraft] = useState<ImportFormat | null>(null);
  const [preview, setPreview] = useState<ImportResult | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [busy, setBusy] = useState(false);
  const format = draft ?? formats.data?.find((f) => f.id === formatId) ?? null;
  let rows: ArticleImportRow[] = [];
  let parseError = '';
  if (cells.length) {
    try {
      rows = articlesFromCells(cells, format);
    } catch (err) {
      parseError = err instanceof Error ? err.message : String(err);
    }
  }
  const load = async (f: File, fmt: ImportFormat | null) => {
    try {
      setCells(await readCells(f, fmt?.separator ?? null));
      setPreview(null);
      setResult(null);
    } catch (err) {
      toast.error(err);
    }
  };
  const check = async (m = mode) => {
    if (!rows.length) return;
    setBusy(true);
    try {
      setPreview(await call('catalogue.import', rows, { mode: m, preview: true }));
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };
  const newFormat = () => {
    setFormatId('');
    setDraft({ id: '', name: '', kind: 'articles', separator: ';', skipRows: 1, decimal: ',', columns: {} });
    setPreview(null);
  };
  const saveDraft = async () => {
    if (!draft) return;
    try {
      const saved = (await call('formats.save', draft)) as ImportFormat;
      formats.reload();
      setDraft(null);
      setFormatId(saved.id);
      toast.ok(`Format « ${saved.name} » enregistré`);
    } catch (err) {
      toast.error(err);
    }
  };
  const chosen = formats.data?.find((f) => f.id === formatId);
  return (
    <Modal title="Importer le catalogue" onClose={onClose} wide>
      <div className="row">
        <Field label="Format du fichier">
          <select
            value={draft ? 'new' : formatId}
            onChange={(e) => {
              if (e.target.value === 'new') return newFormat();
              setDraft(null);
              setFormatId(e.target.value);
              setPreview(null);
              const next = formats.data?.find((f) => f.id === e.target.value) ?? null;
              if (file) void load(file, next);
            }}
          >
            <option value="">Excel ou CSV avec en-têtes</option>
            {(formats.data ?? []).map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
            <option value="new">Nouveau format (catalogue d'un fournisseur)…</option>
          </select>
        </Field>
        <Field label="Que faire">
          <select
            value={mode}
            onChange={(e) => {
              const m = e.target.value as ImportMode;
              setMode(m);
              if (preview) void check(m);
            }}
          >
            {MODES.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </Field>
        {chosen && !chosen.builtin && !draft && (
          <button
            onClick={async () => {
              try {
                await call('formats.delete', formatId);
                setFormatId('');
                formats.reload();
              } catch (err) {
                toast.error(err);
              }
            }}
          >
            Supprimer ce format
          </button>
        )}
      </div>
      {!format && (
        <p className="muted small">
          La première ligne porte les en-têtes : Désignation, Code, Code-barres, Rayon, Famille, Prix d'achat, Prix de vente, Prix de gros, TVA, Unité… et jusqu'à trois
          conditionnements (Cond. 1 nom, Cond. 1 contient, Cond. 1 prix, Cond. 1 code-barres…), du plus grand au plus petit. Un catalogue exporté depuis ONIX, un export
          d’un autre logiciel de gestion ou un tableur maison se lisent tels quels. Chaque ligne retrouve sa fiche par le code article, un code-barres ou la désignation exacte ; une
          colonne vide garde ce qui est sur la fiche.{' '}
          <button type="button" className="link" onClick={downloadImportTemplate}>
            Télécharger le modèle Excel
          </button>
        </p>
      )}
      <input
        type="file"
        accept=".xlsx,.csv,.txt,text/csv,text/plain"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (!f) return;
          setFile(f);
          if (draft && !draft.columns.name && !/\.xlsx$/i.test(f.name)) {
            void readTextFile(f).then((t) => setDraft({ ...draft, separator: guessSeparator(t) }));
          }
          void load(f, format);
        }}
      />
      {draft && (
        <FormatEditor
          draft={draft}
          cells={cells}
          onChange={(d) => {
            if (d.separator !== draft.separator && file && !/\.xlsx$/i.test(file.name)) void load(file, d);
            setDraft(d);
          }}
          onSave={() => void saveDraft()}
          onCancel={() => setDraft(null)}
        />
      )}
      {parseError && <p className="danger-text">{parseError}</p>}
      {rows.length > 0 && !result && (
        <div className="actions">
          <span>
            {rows.length} ligne{rows.length > 1 ? 's' : ''} lue{rows.length > 1 ? 's' : ''}
            {rows[0] ? ` ; première : ${rows[0].name || rows[0].code}${rows[0].salePrice !== undefined ? `, ${fcfa(rows[0].salePrice)}` : ''}` : ''}
            {rows.some((r) => r.packs) ? ` ; ${rows.filter((r) => r.packs).length} avec conditionnements` : ''}
          </span>
          <button disabled={busy} onClick={() => void check()}>
            Vérifier
          </button>
          <button
            className="primary"
            disabled={busy || !preview}
            title={preview ? undefined : "Vérifiez d'abord le fichier"}
            onClick={async () => {
              setBusy(true);
              try {
                const r = await call('catalogue.import', rows, { mode });
                setResult(r);
                toast.ok(`${r.created} créé${r.created > 1 ? 's' : ''}, ${r.updated} mis à jour`);
              } catch (err) {
                toast.error(err);
              } finally {
                setBusy(false);
              }
            }}
          >
            Importer
          </button>
        </div>
      )}
      {(result ?? preview) && <ImportReport r={(result ?? preview)!} done={Boolean(result)} />}
    </Modal>
  );
}

function ImportReport({ r, done }: { r: ImportResult; done: boolean }) {
  const [all, setAll] = useState(false);
  const lines = all ? r.lines : r.lines.slice(0, 12);
  const ACTION = { create: 'Créé', update: 'Mis à jour', skip: 'Laissé' } as const;
  return (
    <section className="card">
      <h3>{done ? 'Import terminé' : 'Aperçu : rien n’est encore enregistré'}</h3>
      <p>
        <b>{r.created}</b> article{r.created > 1 ? 's' : ''} {done ? 'créé' : 'à créer'}
        {r.created > 1 ? 's' : ''}, <b>{r.updated}</b> {done ? 'mis à jour' : 'à mettre à jour'}
        {r.skipped ? `, ${r.skipped} laissé${r.skipped > 1 ? 's' : ''} de côté` : ''}, <b className={r.errors.length ? 'neg' : ''}>{r.errors.length}</b> erreur
        {r.errors.length > 1 ? 's' : ''}.
        {!done && r.errors.length > 0 && ' Les lignes en erreur ne seront pas importées ; corrigez le fichier ou importez le reste.'}
      </p>
      {r.errors.length > 0 && (
        <ul className="errors">
          {r.errors.slice(0, 50).map((e, i) => (
            <li key={i}>
              Ligne {e.row} : {e.message}
            </li>
          ))}
          {r.errors.length > 50 && <li>… et {r.errors.length - 50} autres</li>}
        </ul>
      )}
      {r.lines.length > 0 && (
        <table className="list compact">
          <tbody>
            {lines.map((l, i) => (
              <tr key={i} className={l.action === 'skip' ? 'inactive' : ''}>
                <td className="muted">Ligne {l.row}</td>
                <td>{l.code ?? ''}</td>
                <td>{l.name}</td>
                <td>{ACTION[l.action]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {r.lines.length > 12 && !all && (
        <button className="link" onClick={() => setAll(true)}>
          Voir les {r.lines.length} lignes
        </button>
      )}
    </section>
  );
}

/** Description d'un fichier fournisseur : à chaque colonne sa donnée, vue sur les premières lignes du fichier. */
function FormatEditor({ draft, cells, onChange, onSave, onCancel }: { draft: ImportFormat; cells: string[][]; onChange: (f: ImportFormat) => void; onSave: () => void; onCancel: () => void }) {
  const sample = cells.slice(0, draft.skipRows + 3);
  const width = Math.max(0, ...sample.map((r) => r.length));
  const fieldAt = (i: number) => (Object.entries(draft.columns).find(([, c]) => c === i)?.[0] ?? '') as ImportField | '';
  const setColumn = (i: number, field: ImportField | '') => {
    const columns = Object.fromEntries(Object.entries(draft.columns).filter(([k, c]) => c !== i && k !== field)) as ImportFormat['columns'];
    if (field) columns[field] = i;
    onChange({ ...draft, columns });
  };
  return (
    <section className="card">
      <h3>Nouveau format</h3>
      <div className="grid2">
        <Field label="Nom du format" hint="Ex. Catalogue Brasseries">
          <input value={draft.name} onChange={(e) => onChange({ ...draft, name: e.target.value })} />
        </Field>
        <Field label="Séparateur" hint="Fichier CSV ou TXT ; sans objet pour Excel">
          <select value={draft.separator} onChange={(e) => onChange({ ...draft, separator: e.target.value as Separator })}>
            {SEPARATORS.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Lignes à sauter" hint="En-têtes, titre du fournisseur">
          <input type="number" min={0} value={draft.skipRows} onChange={(e) => onChange({ ...draft, skipRows: Math.max(0, Number(e.target.value) || 0) })} />
        </Field>
        <Field label="Virgule des prix">
          <select value={draft.decimal} onChange={(e) => onChange({ ...draft, decimal: e.target.value as ',' | '.' })}>
            <option value=",">1 250,50</option>
            <option value=".">1,250.50</option>
          </select>
        </Field>
      </div>
      {!cells.length ? (
        <p className="muted">Choisissez un fichier du fournisseur pour indiquer ce que contient chaque colonne.</p>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table className="list">
            <thead>
              <tr>
                {Array.from({ length: width }, (_, i) => (
                  <th key={i}>
                    <select value={fieldAt(i)} onChange={(e) => setColumn(i, e.target.value as ImportField | '')}>
                      <option value="">Colonne {i + 1} : ignorée</option>
                      {(Object.keys(IMPORT_FIELDS) as ImportField[]).map((k) => (
                        <option key={k} value={k}>
                          {IMPORT_FIELDS[k]}
                        </option>
                      ))}
                    </select>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sample.map((r, ri) => (
                <tr key={ri} className={ri < draft.skipRows ? 'muted' : undefined}>
                  {Array.from({ length: width }, (_, i) => (
                    <td key={i}>{r[i] ?? ''}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="actions">
        <button onClick={onCancel}>Annuler</button>
        <button className="primary" disabled={!draft.name.trim() || draft.columns.name === undefined || draft.columns.salePrice === undefined} onClick={onSave}>
          Enregistrer le format
        </button>
      </div>
    </section>
  );
}

// --- Export -------------------------------------------------------------------------

export interface ListFilter {
  query: string;
  departmentId: string;
  familyId: string;
  status: 'active' | 'inactive' | 'all';
}

const DEFAULT_CUSTOM: ArticleColumn[] = ['code', 'name', 'barcode', 'department', 'salePrice'];

/**
 * Export de la liste des produits en Excel ou en CSV : modèle (catalogue
 * réimportable, liste de prix, codes-barres, fiche de comptage, stock
 * valorisé ou colonnes choisies), produits concernés et format du fichier.
 */
export function ExportDialog({ kind, filter, noVat, onClose }: { kind: 'xlsx' | 'csv'; filter: ListFilter; noVat: boolean; onClose: () => void }) {
  const toast = useToast();
  const departments = useLoad(() => call('catalogue.departments'), []);
  const warehouses = useLoad(() => call('admin.warehouses'), []);
  const saved = useLoad(() => call('catalogue.exportModels'), []);
  const [model, setModel] = useState<string>('catalogue');
  const [scope, setScope] = useState<ListFilter>({ ...filter });
  const [warehouseId, setWarehouseId] = useState('');
  const [withExpected, setWithExpected] = useState(false);
  const [columns, setColumns] = useState<ArticleColumn[]>(DEFAULT_CUSTOM);
  const [modelName, setModelName] = useState('');
  const [csv, setCsv] = useState<{ separator: Separator; decimal: ',' | '.'; header: boolean }>({ separator: ';', decimal: ',', header: true });
  const [busy, setBusy] = useState(false);
  const custom = saved.data?.find((m) => m.id === model);
  const modelId: ExportModelId = custom ? 'custom' : (model as ExportModelId);
  const def = EXPORT_MODELS.find((m) => m.id === modelId);
  const appFile = modelId === 'inventoryApp';
  const perWarehouse = modelId === 'count' || modelId === 'inventoryApp' || modelId === 'stockValue';
  const families = departments.data?.find((d) => d.id === scope.departmentId)?.families ?? [];
  const run = async () => {
    setBusy(true);
    try {
      const list = await call('catalogue.exportList', {
        query: scope.query || null,
        departmentId: scope.departmentId || null,
        familyId: scope.familyId || null,
        status: scope.status,
      });
      if (!list.length) return toast.error('Aucun produit à exporter avec ces filtres');
      const wh = warehouses.data ?? [];
      const chosen = warehouseId ? wh.filter((w) => w.id === warehouseId) : modelId === 'stockValue' ? wh : wh.slice(0, 1);
      const data = buildArticleExport(modelId, list, {
        columns: custom?.columns ?? columns,
        warehouses: chosen.map((w) => ({ id: w.id, name: w.name })),
        withExpected,
        noVat,
      });
      const base = `${(custom?.name ?? def?.name ?? 'produits')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')}-${today()}`;
      if (appFile) {
        downloadText(`${base}.txt`, exportToDelimited(data, { separator: ';', decimal: ',', header: false }), 'text/plain;charset=utf-8');
      } else if (kind === 'xlsx') {
        const where = [scope.query && `recherche « ${scope.query} »`, scope.status === 'inactive' ? 'en sommeil' : scope.status === 'active' ? 'actifs' : ''].filter(Boolean).join(', ');
        saveXlsx(`${base}.xlsx`, {
          name: (custom?.name ?? def?.name ?? 'Produits').slice(0, 31),
          title: modelId === 'catalogue' ? undefined : [custom?.name ?? def?.name ?? 'Produits', `${list.length} produits${where ? ` (${where})` : ''} · au ${new Date().toLocaleDateString('fr-FR')}`],
          columns: data.columns,
          rows: data.rows,
        });
      } else {
        downloadText(`${base}.csv`, `﻿${exportToDelimited(data, csv)}`);
      }
      toast.ok(`${list.length} produit${list.length > 1 ? 's' : ''} exporté${list.length > 1 ? 's' : ''}`);
      onClose();
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={kind === 'xlsx' ? 'Exporter les produits vers Excel' : 'Exporter les produits en CSV'} onClose={onClose} wide>
      <div className="grid2">
        <Field label="Modèle d'export">
          <select value={model} onChange={(e) => setModel(e.target.value)}>
            {EXPORT_MODELS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
            {(saved.data ?? []).length > 0 && (
              <optgroup label="Mes modèles">
                {saved.data!.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </Field>
        <p className="muted small">{custom ? `Colonnes : ${custom.columns.map((c) => ARTICLE_COLUMNS[c]).join(', ')}` : def?.description}</p>
      </div>
      <h3>Produits</h3>
      <div className="grid3">
        <Field label="Recherche" hint="Vide : tout le catalogue">
          <input value={scope.query} onChange={(e) => setScope({ ...scope, query: e.target.value })} />
        </Field>
        <Field label="Rayon">
          <select value={scope.departmentId} onChange={(e) => setScope({ ...scope, departmentId: e.target.value, familyId: '' })}>
            <option value="">Tous les rayons</option>
            {(departments.data ?? []).map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Famille">
          <select value={scope.familyId} disabled={!scope.departmentId} onChange={(e) => setScope({ ...scope, familyId: e.target.value })}>
            <option value="">Toutes les familles</option>
            {families.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="État">
          <select value={scope.status} onChange={(e) => setScope({ ...scope, status: e.target.value as ListFilter['status'] })}>
            <option value="active">Actifs</option>
            <option value="inactive">En sommeil</option>
            <option value="all">Actifs et en sommeil</option>
          </select>
        </Field>
        {perWarehouse && (
          <Field label="Dépôt">
            <select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
              <option value="">{modelId === 'stockValue' ? 'Tous les dépôts (une colonne par dépôt)' : (warehouses.data?.[0]?.name ?? 'Dépôt des ventes')}</option>
              {(warehouses.data ?? []).slice(modelId === 'stockValue' ? 0 : 1).map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          </Field>
        )}
        {(modelId === 'count' || appFile) && (
          <label className="inline">
            <input type="checkbox" checked={withExpected} onChange={(e) => setWithExpected(e.target.checked)} /> {appFile ? 'Quantité = stock théorique (sinon 0)' : 'Ajouter le stock théorique'}
          </label>
        )}
      </div>
      {modelId === 'custom' && !custom && (
        <>
          <h3>Colonnes</h3>
          <div className="checks columns3">
            {(Object.keys(ARTICLE_COLUMNS) as ArticleColumn[])
              .filter((c) => !(noVat && c === 'vat'))
              .map((c) => (
                <label key={c}>
                  <input type="checkbox" checked={columns.includes(c)} onChange={(e) => setColumns(e.target.checked ? [...columns, c] : columns.filter((x) => x !== c))} />{' '}
                  {ARTICLE_COLUMNS[c]}
                </label>
              ))}
          </div>
          <div className="inline">
            <input value={modelName} onChange={(e) => setModelName(e.target.value)} placeholder="Nom du modèle (ex. Tarif grossistes)" />
            <button
              disabled={!modelName.trim() || !columns.length}
              onClick={async () => {
                try {
                  const m = await call('catalogue.saveExportModel', { name: modelName, columns });
                  saved.reload();
                  setModel(m.id);
                  toast.ok(`Modèle « ${m.name} » enregistré`);
                } catch (err) {
                  toast.error(err);
                }
              }}
            >
              Enregistrer ce modèle
            </button>
          </div>
        </>
      )}
      {custom && (
        <button
          className="ghost"
          onClick={async () => {
            if (!(await askConfirm(`Supprimer le modèle « ${custom.name} » ?`))) return;
            await call('catalogue.deleteExportModel', custom.id).catch(toast.error);
            setModel('catalogue');
            saved.reload();
          }}
        >
          Supprimer ce modèle
        </button>
      )}
      {kind === 'csv' && !appFile && (
        <>
          <h3>Fichier CSV</h3>
          <div className="grid3">
            <Field label="Séparateur">
              <select value={csv.separator} onChange={(e) => setCsv({ ...csv, separator: e.target.value as Separator })}>
                {SEPARATORS.map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Nombres décimaux">
              <select value={csv.decimal} onChange={(e) => setCsv({ ...csv, decimal: e.target.value as ',' | '.' })}>
                <option value=",">Virgule (1,5)</option>
                <option value=".">Point (1.5)</option>
              </select>
            </Field>
            <label className="inline">
              <input type="checkbox" checked={csv.header} onChange={(e) => setCsv({ ...csv, header: e.target.checked })} /> Ligne d'en-têtes
            </label>
          </div>
          {csv.separator === ',' && csv.decimal === ',' && <p className="warn-text small">Virgule comme séparateur et comme décimale : les nombres seront mis entre guillemets.</p>}
        </>
      )}
      {appFile && <p className="muted small">Fichier texte sans en-têtes, séparé par des points-virgules, que l’application d’inventaire importe ; le fichier qu’elle exporte se réimporte dans l’inventaire (Stock › Inventaire › Importer).</p>}
      <div className="actions">
        <button className="ghost" onClick={onClose}>
          Annuler
        </button>
        <button className="primary" disabled={busy || (modelId === 'custom' && !custom && !columns.length)} onClick={() => void run()}>
          {appFile ? 'Exporter (.txt)' : kind === 'xlsx' ? 'Exporter vers Excel' : 'Exporter en CSV'}
        </button>
      </div>
    </Modal>
  );
}

// --- Mise à jour des prix ----------------------------------------------------------

interface PriceInput {
  departmentId: string | null;
  familyId: string | null;
  supplierId: string | null;
  target: 'sale' | 'purchase';
  method: 'percent' | 'amount' | 'coefficient';
  value: number;
  packs: boolean;
  tiers: boolean;
  followSale: boolean;
  rounding: number;
}
type Plan = Result<'catalogue.pricePlan'>;

const FIELD_LABEL = { purchase: 'Achat', sale: 'Vente', wholesale: 'Gros', superWholesale: 'Super gros' } as const;

/**
 * Assistant de mise à jour des prix : sur un rayon, une famille
 * ou les articles d'un fournisseur, hausse ou baisse en %, montant ajouté, ou
 * prix de vente recalculé par coefficient sur l'achat. Un aperçu montre chaque
 * prix avant et après ; rien ne change avant « Appliquer ».
 */
export function PriceUpdateDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const departments = useLoad(() => call('catalogue.departments'), []);
  const suppliers = useLoad(() => call('suppliers.list'), []);
  const [f, setF] = useState({
    departmentId: '',
    familyId: '',
    supplierId: '',
    target: 'sale' as 'sale' | 'purchase',
    method: 'percent' as 'percent' | 'amount' | 'coefficient',
    value: '',
    packs: true,
    tiers: true,
    followSale: false,
    rounding: 5,
  });
  const [plan, setPlan] = useState<Plan | null>(null);
  const [busy, setBusy] = useState(false);
  // Date d'application : vide = tout de suite ; sinon les prix sont programmés pour ce jour-là.
  const [on, setOn] = useState('');
  const families = departments.data?.find((d) => d.id === f.departmentId)?.families ?? [];
  const value = Number(f.value.replace(',', '.').replace(/\s/g, ''));
  const input = (): PriceInput => ({
    departmentId: f.departmentId || null,
    familyId: f.familyId || null,
    supplierId: f.supplierId || null,
    target: f.target,
    method: f.target === 'purchase' && f.method === 'coefficient' ? 'percent' : f.method,
    value,
    packs: f.packs,
    tiers: f.tiers,
    followSale: f.target === 'purchase' && f.followSale,
    rounding: f.rounding,
  });
  const set = (patch: Partial<typeof f>) => {
    setF({ ...f, ...patch });
    setPlan(null);
  };
  const compute = async () => {
    if (!f.value.trim() || !Number.isFinite(value)) return toast.error('Indiquez la valeur de la mise à jour');
    setBusy(true);
    try {
      setPlan(await call('catalogue.pricePlan', input()));
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };
  const where = f.familyId
    ? families.find((x) => x.id === f.familyId)?.name
    : f.departmentId
      ? departments.data?.find((d) => d.id === f.departmentId)?.name
      : f.supplierId
        ? suppliers.data?.find((s) => s.id === f.supplierId)?.name
        : 'tout le catalogue';
  return (
    <Modal title="Mise à jour des prix" onClose={onClose} wide>
      <h3>1. Articles concernés</h3>
      <div className="grid3">
        <Field label="Rayon">
          <select value={f.departmentId} onChange={(e) => set({ departmentId: e.target.value, familyId: '' })}>
            <option value="">Tous les rayons</option>
            {(departments.data ?? []).map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Famille">
          <select value={f.familyId} disabled={!f.departmentId} onChange={(e) => set({ familyId: e.target.value })}>
            <option value="">Toutes les familles</option>
            {families.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Fournisseur" hint="Articles rattachés à ce fournisseur">
          <select value={f.supplierId} onChange={(e) => set({ supplierId: e.target.value })}>
            <option value="">Tous les fournisseurs</option>
            {(suppliers.data ?? []).map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <h3>2. Mise à jour</h3>
      <div className="grid3">
        <Field label="Prix à changer">
          <select value={f.target} onChange={(e) => set({ target: e.target.value as typeof f.target })}>
            <option value="sale">Prix de vente</option>
            <option value="purchase">Prix d'achat</option>
          </select>
        </Field>
        <Field label="Méthode">
          <select value={f.method} onChange={(e) => set({ method: e.target.value as typeof f.method })}>
            <option value="percent">Hausse ou baisse en % (−5 pour une baisse)</option>
            <option value="amount">Montant ajouté par unité (FCFA, négatif pour baisser)</option>
            {f.target === 'sale' && <option value="coefficient">Coefficient sur le prix d'achat HT</option>}
          </select>
        </Field>
        <Field label={f.method === 'percent' ? 'Pourcentage' : f.method === 'amount' ? 'Montant (FCFA)' : 'Coefficient (ex. 1,25)'}>
          <input autoFocus inputMode="decimal" value={f.value} onChange={(e) => set({ value: e.target.value })} />
        </Field>
        <Field label="Arrondi des prix de vente">
          <select value={f.rounding} onChange={(e) => set({ rounding: Number(e.target.value) })}>
            {[1, 5, 10, 25, 50, 100].map((r) => (
              <option key={r} value={r}>
                {r === 1 ? 'Au franc près' : `Au multiple de ${r} FCFA`}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <div className="checks">
        {f.target === 'purchase' && (
          <label>
            <input type="checkbox" checked={f.followSale} onChange={(e) => set({ followSale: e.target.checked })} /> Le prix de vente suit dans la même proportion (marge gardée)
          </label>
        )}
        <label>
          <input type="checkbox" checked={f.packs} onChange={(e) => set({ packs: e.target.checked })} /> Changer aussi les conditionnements (carton, casier, pack)
        </label>
        {f.method !== 'coefficient' && (
          <label>
            <input type="checkbox" checked={f.tiers} onChange={(e) => set({ tiers: e.target.checked })} /> Changer aussi les prix de gros et super gros
          </label>
        )}
      </div>
      <Field label="Quand" hint="Programmé : les prix changent seuls ce jour-là, les étiquettes sont prêtes la veille">
        <select value={on ? 'later' : 'now'} onChange={(e) => setOn(e.target.value === 'now' ? '' : new Date(Date.now() + 86_400_000).toISOString().slice(0, 10))}>
          <option value="now">Tout de suite</option>
          <option value="later">À une date</option>
        </select>
        {on && <input type="date" value={on} onChange={(e) => setOn(e.target.value)} />}
      </Field>
      {plan && (
        <section className="card">
          <h3>3. Contrôle avant mise à jour</h3>
          {plan.articles.length === 0 ? (
            <p>Aucun prix ne change pour {where}.</p>
          ) : (
            <>
              <p>
                {plan.articles.length} article{plan.articles.length > 1 ? 's' : ''} ({where}), {plan.lines} prix changé{plan.lines > 1 ? 's' : ''}.
              </p>
              <div style={{ maxHeight: 320, overflowY: 'auto' }}>
                <table className="list compact">
                  <thead>
                    <tr>
                      <th>Article</th>
                      <th>Niveau</th>
                      <th>Prix</th>
                      <th className="r">Avant</th>
                      <th className="r">Après</th>
                    </tr>
                  </thead>
                  <tbody>
                    {plan.articles.slice(0, 300).flatMap((a) =>
                      a.lines.map((l, i) => (
                        <tr key={`${a.articleId}-${i}`}>
                          <td>{i === 0 ? `${a.code} · ${a.name}` : ''}</td>
                          <td>{l.level}</td>
                          <td>{FIELD_LABEL[l.field]}</td>
                          <td className="r">{fcfa(l.old)}</td>
                          <td className={`r ${l.next < l.old ? 'neg' : ''}`}>{fcfa(l.next)}</td>
                        </tr>
                      )),
                    )}
                  </tbody>
                </table>
              </div>
              {plan.articles.length > 300 && <p className="muted small">Seuls les 300 premiers articles sont affichés ; tous seront mis à jour.</p>}
            </>
          )}
        </section>
      )}
      <div className="actions">
        <button className="ghost" onClick={onClose}>
          Fermer
        </button>
        <button disabled={busy} onClick={() => void compute()}>
          Calculer
        </button>
        <button
          className="primary"
          disabled={busy || !plan?.articles.length}
          onClick={async () => {
            if (on) {
              setBusy(true);
              try {
                await call('priceSchedules.create', { label: `${f.method === 'percent' ? `${value > 0 ? '+' : ''}${value} %` : f.method === 'amount' ? `${value > 0 ? '+' : ''}${value} F` : `Coefficient ${value}`} sur ${where}`, effectiveOn: on, update: input() });
                toast.ok(`${plan!.articles.length} articles changeront de prix le ${on.split('-').reverse().join('/')}. Étiquettes prêtes la veille (Produits › Prix programmés).`);
                onDone();
              } catch (err) {
                toast.error(err);
              } finally {
                setBusy(false);
              }
              return;
            }
            if (!(await askConfirm(`Mettre à jour ${plan!.lines} prix sur ${plan!.articles.length} articles ? L'historique des prix garde les anciens prix.`))) return;
            setBusy(true);
            try {
              const r = await call('catalogue.priceApply', input());
              toast.ok(`${r.articles} articles mis à jour. Pensez à réimprimer les étiquettes (Produit › Étiquettes).`);
              onDone();
            } catch (err) {
              toast.error(err);
            } finally {
              setBusy(false);
            }
          }}
        >
          {on ? 'Programmer' : 'Appliquer'}
        </button>
      </div>
    </Modal>
  );
}
