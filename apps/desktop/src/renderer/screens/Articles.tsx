import { useState } from 'react';
import { splitTtc } from '@superette/core';
import { type Result, call } from '../api';
import { Empty, Field, Modal, Tabs, dateTime, fcfa, parseAmount, parseQty, useLoad, useToast, has, useCan, useStoreSettings } from '../ui';
import { Shelving } from './Controls';
import { LevelGrid, MAX_LEVELS, emptyLevel, levelsFromArticle, levelsToInput } from './packs';
import { type ArticlePhoto, PhotoField } from './photo';
import { tx } from '../tax';

type Article = Result<'catalogue.get'>;
type User = NonNullable<Result<'app.state'>['user']>;

export type ArticlesView = 'list' | 'new' | 'search' | 'shelving';

export function Articles({ user, view = 'list' }: { user: User; view?: ArticlesView }) {
  const [tab, setTab] = useState<'list' | 'shelving'>(view === 'shelving' ? 'shelving' : 'list');
  const canEdit = has(user, 'article_families');
  return (
    <div className="page">
      <header className="page-head">
        <h1>Produits</h1>
      </header>
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          ['list', 'Liste des produits'],
          ['shelving', 'Rayonnage'],
        ]}
      />
      {tab === 'list' && <ArticleList user={user} startNew={view === 'new'} focusSearch={view === 'search'} />}
      {tab === 'shelving' && <Shelving canEdit={canEdit} />}
    </div>
  );
}

function ArticleList({ user, startNew, focusSearch }: { user: User; startNew: boolean; focusSearch: boolean }) {
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<Article | 'new' | null>(startNew ? 'new' : null);
  const [importing, setImporting] = useState(false);
  const articles = useLoad(() => call('catalogue.search', search, { includeInactive: true }), [search]);
  return (
    <>
      <div className="filters">
        <input className="search" autoFocus={focusSearch} placeholder="Rechercher (nom, code, code-barres, marque)" value={search} onChange={(e) => setSearch(e.target.value)} />
        {has(user, 'import') && (
          <button onClick={() => setImporting(true)}>Importer (CSV)</button>
        )}
        {has(user, 'article_create') && (
          <button className="primary" style={{ marginLeft: 'auto' }} onClick={() => setEditing('new')}>
            Nouvel article
          </button>
        )}
      </div>
      {articles.data?.length === 0 ? (
        <Empty>Aucun article. Créez-en un ou importez votre catalogue.</Empty>
      ) : (
        <table className="list">
          <thead>
            <tr>
              <th />
              <th>Code</th>
              <th>Désignation</th>
              <th>Rayon</th>
              <th>Code-barres</th>
              <th className="r">Achat</th>
              <th className="r">{tx('Vente TTC')}</th>
              <th className="r">Marge</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(articles.data ?? []).map((a) => {
              const ht = splitTtc(a.store_price, a.vat_rate_bp).ht;
              const margin = ht > 0 && a.purchase_price > 0 ? Math.round(((ht - a.purchase_price) / ht) * 100) : null;
              return (
                <tr key={a.id} className={a.active ? 'clickable' : 'clickable inactive'} onClick={() => setEditing(a)}>
                  <td className="thumb-cell">{a.photo_thumb && <img className="thumb" src={a.photo_thumb} alt="" />}</td>
                  <td>{a.code}</td>
                  <td>
                    {a.name}
                    {a.brand && <small className="muted"> · {a.brand}</small>}
                    {a.packs.length > 0 && (
                      <small className="muted">
                        {' '}
                        · {a.packs.map((p) => `${p.name} de ${p.units / 1000}`).join(', ')}
                      </small>
                    )}
                  </td>
                  <td>{a.department_name ?? '—'}</td>
                  <td>{a.barcodes[0]?.code ?? (a.plu ? `PLU ${a.plu}` : '—')}</td>
                  <td className="r">{fcfa(a.purchase_price)}</td>
                  <td className="r">
                    {fcfa(a.store_price)}
                    {a.unit !== 'piece' && <small> /{a.unit === 'kg' ? 'kg' : 'L'}</small>}
                  </td>
                  <td className={`r ${margin !== null && margin < 0 ? 'neg' : ''}`}>{margin === null ? '—' : `${margin} %`}</td>
                  <td>{!a.active && <span className="tag">inactif</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {editing && (
        <ArticleForm
          article={editing === 'new' ? null : editing}
          canSetStorePrice={has(user, 'store_price')}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            articles.reload();
          }}
        />
      )}
      {importing && (
        <ImportDialog
          onClose={() => {
            setImporting(false);
            articles.reload();
          }}
        />
      )}
    </>
  );
}

/**
 * Fiche article (« Ajouter/Paramétrer une marchandise » de KONTROL). Depuis la
 * caisse, `addLevel` ouvre la fiche avec un conditionnement à compléter :
 * plus grand (nouveau conditionnement d'achat) ou plus petit.
 */
export function ArticleForm({
  article,
  canSetStorePrice,
  onClose,
  onSaved,
  initialName,
  addLevel,
}: {
  article: Article | null;
  canSetStorePrice: boolean;
  onClose: () => void;
  onSaved: (article: Article) => void;
  initialName?: string;
  addLevel?: 'top' | 'bottom';
}) {
  const toast = useToast();
  const can = useCan();
  const settings = useStoreSettings();
  const rates = useLoad(() => call('admin.vatRates'));
  const app = useLoad(() => call('app.state'));
  const noVat = app.data?.station?.store.vat_enabled === 0;
  const departments = useLoad(() => call('catalogue.departments'));
  const history = useLoad(() => (article ? call('catalogue.priceHistory', article.id) : Promise.resolve([])));
  const milli = (v: number | null | undefined) => (v === null || v === undefined ? '' : String(v / 1000));
  const [f, setF] = useState({
    code: article?.code ?? '',
    name: article?.name ?? initialName?.toUpperCase() ?? '',
    otherRef: article?.other_ref ?? '',
    familyId: article?.family_id ?? '',
    brand: article?.brand ?? '',
    unit: article?.unit ?? ('piece' as Article['unit']),
    vatRateId: article?.vat_rate_id ?? '',
    perishable: article?.perishable === 1,
    plu: article?.plu ?? '',
    quickKey: article?.quick_key === 1,
    minQty: milli(article?.min_qty),
    // Nouveau produit : stock d'alerte proposé par les paramètres du magasin.
    alertQty: article ? milli(article.alert_qty) : settings.defaultAlertQty ? String(settings.defaultAlertQty) : '',
    maxQty: milli(article?.max_qty),
    active: article ? article.active === 1 : true,
  });
  const packCodes = new Set(article?.packs.map((p) => p.barcode).filter(Boolean));
  const [barcodes, setBarcodes] = useState(
    article?.barcodes.filter((b) => !packCodes.has(b.code)).map((b) => ({ code: b.code, pack: String(b.pack_qty / 1000) })) ?? [],
  );
  const [initial] = useState(() => {
    const { levels, buy } = levelsFromArticle(article);
    const used = levels.filter((l) => l.enabled).length;
    if (addLevel === 'bottom' && used < MAX_LEVELS) levels[used] = { ...levels[used]!, enabled: true };
    // Nouveau conditionnement d'achat plus grand : les anciens blocs descendent, leurs diviseurs sont à refaire.
    if (addLevel === 'top' && used < MAX_LEVELS) {
      levels.splice(MAX_LEVELS - 1, 1);
      levels.unshift(emptyLevel(true));
      const ratio = levels.slice(1).map((l) => Number(l.divisor) || 1);
      for (const l of levels.slice(1)) if (l.enabled) l.divisor = '';
      return { levels, buy: { purchase: '', cost: '' }, previous: { name: levels[1]!.name, buy, ratio } };
    }
    return { levels, buy, previous: null };
  });
  const [levels, setLevels] = useState(initial.levels);
  const [buy, setBuy] = useState(initial.buy);
  const previous = initial.previous;
  /**
   * Nouveau conditionnement d'achat au-dessus de l'ancien : dès qu'on dit combien
   * il en contient, ses prix d'achat et de revient et les diviseurs des plus
   * petits s'en déduisent (une PALETTE de 4 CARTONS de 12 : BOUTEILLE 48).
   */
  const onLevels = (next: typeof levels) => {
    const d = Math.floor(Number(next[1]?.divisor) || 0);
    if (previous && d >= 2 && d !== Math.floor(Number(levels[1]?.divisor) || 0)) {
      const p = parseAmount(previous.buy.purchase);
      const c = parseAmount(previous.buy.cost);
      if (p !== null) setBuy({ purchase: String(p * d), cost: c === null ? '' : String(c * d) });
      const sale = parseAmount(next[1]!.sale);
      next = next.map((l, i) =>
        i === 0 && sale !== null && (!l.sale || l.auto) ? { ...l, sale: String(sale * d), auto: true } : i > 1 && l.enabled ? { ...l, divisor: String(previous.ratio[i - 1]! * d) } : l,
      );
    }
    setLevels(next);
  };
  const [photo, setPhoto] = useState<ArticlePhoto | null | undefined>(undefined);
  const [newDept, setNewDept] = useState('');
  const [storePrice, setStorePrice] = useState(article && article.store_price !== article.sale_price ? String(article.store_price) : '');
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setF({ ...f, [k]: e.target.type === 'checkbox' ? (e.target as HTMLInputElement).checked : e.target.value });
  const vatId = f.vatRateId || rates.data?.[0]?.id || '';
  const rate = rates.data?.find((r) => r.id === vatId)?.rate_bp ?? 0;
  const piece = f.unit === 'piece';
  const lastOn = piece ? levels.reduce((last, l, i) => (i === 0 || l.enabled ? i : last), 0) : 0;
  const unitName = piece ? levels[lastOn]!.name.trim() || 'pièce' : f.unit === 'kg' ? 'kg' : 'litre';
  // Prix de vente proposés (Paramètres › Achats : marge par défaut) pour les conditionnements sans prix.
  const cost = parseAmount(buy.cost) ?? parseAmount(buy.purchase);
  const suggested =
    settings.defaultMarginPct > 0 && cost
      ? levels
          .map((l, i) => ({ l, i, d: i === 0 ? 1 : Math.floor(Number(l.divisor) || 0) }))
          .filter(({ l, i, d }) => (i === 0 || (piece && l.enabled)) && d > 0 && !l.sale.trim())
          .map(({ l, i, d }) => ({
            i,
            name: l.name.trim() || (i === 0 ? 'achat' : `niveau ${i + 1}`),
            sale: Math.ceil(((cost / d) * (100 + settings.defaultMarginPct) * (10000 + (noVat ? 0 : rate))) / 1_000_000 / 5) * 5,
          }))
      : [];

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const opt = (v: string) => (v.trim() ? parseQty(v) : null);
    const lv = levelsToInput(levels, buy, piece);
    if (typeof lv === 'string') return toast.error(lv);
    try {
      const saved = await call(
        'catalogue.save',
        {
          code: f.code || undefined,
          name: f.name,
          otherRef: f.otherRef || null,
          familyId: f.familyId || null,
          brand: f.brand || null,
          unit: f.unit,
          vatRateId: vatId,
          purchasePrice: lv.purchasePrice,
          packPurchasePrice: lv.packPurchasePrice,
          packCostPrice: lv.packCostPrice,
          salePrice: lv.salePrice,
          perishable: f.perishable,
          plu: f.plu || null,
          quickKey: f.quickKey,
          minQty: opt(f.minQty),
          alertQty: opt(f.alertQty),
          maxQty: opt(f.maxQty),
          active: f.active,
          barcodes: barcodes.filter((b) => b.code.trim()).map((b) => ({ code: b.code, packQty: parseQty(b.pack) ?? 1000 })),
          unitName: lv.unitName,
          wholesalePrice: lv.wholesalePrice,
          superWholesalePrice: lv.superWholesalePrice,
          packs: lv.packs,
        },
        article?.id,
      );
      if (canSetStorePrice) {
        const sp = storePrice.trim() ? parseAmount(storePrice) : null;
        const current = article && article.store_price !== article.sale_price ? article.store_price : null;
        if (sp !== current) await call('catalogue.setStorePrice', saved.id, sp);
      }
      if (photo !== undefined) await call('catalogue.setPhoto', saved.id, photo);
      toast.ok('Article enregistré');
      onSaved(saved);
    } catch (err) {
      toast.error(err);
    }
  };

  return (
    <Modal title={article ? `${article.code} · ${article.name}` : 'Nouvel article'} onClose={onClose} wide>
      <form onSubmit={save}>
        <div className="article-top">
        <div className="grid3">
          <Field label="Désignation">
            <input autoFocus value={f.name} onChange={set('name')} required />
          </Field>
          <Field label="Code article" hint="Laisser vide pour numérotation automatique">
            <input value={f.code} onChange={set('code')} />
          </Field>
          <Field label="Autre réf." hint="Référence fournisseur, ancien code : cherchée en caisse">
            <input value={f.otherRef} onChange={set('otherRef')} />
          </Field>
          <Field label="Rayon / famille">
            <select value={f.familyId} onChange={set('familyId')}>
              <option value="">—</option>
              {(departments.data ?? []).map((d) => (
                <optgroup key={d.id} label={d.name}>
                  {d.families.map((fam) => (
                    <option key={fam.id} value={fam.id}>
                      {fam.name}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </Field>
          <Field label="Unité de vente">
            <select value={f.unit} onChange={set('unit')}>
              <option value="piece">Pièce</option>
              <option value="kg">Kilogramme</option>
              <option value="litre">Litre</option>
            </select>
          </Field>
          {!noVat && (
            <Field label="TVA">
              <select value={vatId} onChange={set('vatRateId')}>
                {(rates.data ?? []).map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.label}
                  </option>
                ))}
              </select>
            </Field>
          )}
        </div>
        <PhotoField articleId={article?.id ?? null} value={photo} onChange={setPhoto} />
        </div>
        <h3>Conditionnements et prix</h3>
        <p className="muted small">
          {piece
            ? "Ligne 1 : le conditionnement d'achat (PALETTE, CASIER, CARTON) avec ses prix d'achat et de revient. Lignes 2 à 4 : les conditionnements de vente, du plus grand au plus petit, avec leur diviseur par rapport au conditionnement d'achat (une palette de 24 canettes : CANETTE, diviseur 24). Leur achat et leur revient se calculent ; leurs prix de vente se modifient."
            : 'Article vendu au poids ou au volume : prix au ' + unitName + '.'}
        </p>
        {previous && (
          <p className="warn-text small">
            Nouveau conditionnement d'achat au-dessus de {previous.name} (acheté jusqu'ici {fcfa(parseAmount(previous.buy.purchase) ?? 0)}) : donnez son nom, puis le diviseur de{' '}
            {previous.name}. Les prix d'achat et les autres diviseurs se recalculent.
          </p>
        )}
        <LevelGrid levels={levels} buy={buy} rate={noVat ? 0 : rate} piece={piece} unitLabel={unitName.toUpperCase()} onLevels={onLevels} onBuy={setBuy} />
        {suggested.length > 0 && (
          <p className="muted small">
            Marge de {settings.defaultMarginPct} % sur le revient : {suggested.map((x) => `${x.name} ${fcfa(x.sale)}`).join(', ')}{tx(' TTC')}.{' '}
            <button type="button" className="link" onClick={() => setLevels(levels.map((l, i) => (suggested.some((x) => x.i === i) ? { ...l, sale: String(suggested.find((x) => x.i === i)!.sale) } : l)))}>
              Appliquer aux prix vides
            </button>
          </p>
        )}
        <h3>Autres informations</h3>
        <div className="grid3">
          <Field label="Marque">
            <input value={f.brand} onChange={set('brand')} />
          </Field>
          {can('article_families') && (
          <Field label="Nouveau rayon" hint="Crée le rayon et une famille du même nom">
            <div className="inline">
              <input value={newDept} onChange={(e) => setNewDept(e.target.value)} />
              <button
                type="button"
                disabled={!newDept.trim()}
                onClick={async () => {
                  try {
                    const d = await call('catalogue.createDepartment', newDept);
                    const fam = await call('catalogue.createFamily', d.id, newDept);
                    setNewDept('');
                    departments.reload();
                    setF({ ...f, familyId: fam.id });
                  } catch (err) {
                    toast.error(err);
                  }
                }}
              >
                Créer
              </button>
            </div>
          </Field>
          )}
          {canSetStorePrice && article && (
            <Field label={`Prix magasin (${unitName.toLowerCase()})`} hint="Vide = prix national">
              <input inputMode="numeric" value={storePrice} onChange={(e) => setStorePrice(e.target.value)} />
            </Field>
          )}
          <Field label="Code balance (PLU)" hint="5 chiffres, pour les étiquettes balance">
            <input value={f.plu} onChange={set('plu')} maxLength={5} />
          </Field>
          <Field label="Stock minimum">
            <input inputMode="decimal" value={f.minQty} onChange={set('minQty')} />
          </Field>
          <Field label="Stock d'alerte">
            <input inputMode="decimal" value={f.alertQty} onChange={set('alertQty')} />
          </Field>
          <Field label="Stock maximum">
            <input inputMode="decimal" value={f.maxQty} onChange={set('maxQty')} />
          </Field>
        </div>
        <div className="checks">
          <label>
            <input type="checkbox" checked={f.perishable} onChange={set('perishable')} /> Périssable (date limite obligatoire à la réception)
          </label>
          <label>
            <input type="checkbox" checked={f.quickKey} onChange={set('quickKey')} /> Touche rapide en caisse
          </label>
          <label>
            <input type="checkbox" checked={f.active} disabled={!can('article_deactivate')} onChange={set('active')} /> Actif
          </label>
        </div>
        <h3>{piece && lastOn > 0 ? `Codes-barres de l'unité de détail (${unitName})` : 'Codes-barres'}</h3>
        <table className="list compact">
          <tbody>
            {barcodes.map((b, i) => (
              <tr key={i}>
                <td>
                  <input value={b.code} onChange={(e) => setBarcodes(barcodes.map((x, j) => (j === i ? { ...x, code: e.target.value } : x)))} placeholder="Scanner le code" />
                </td>
                <td>
                  <label className="inline">
                    Contient
                    <input className="qty" value={b.pack} onChange={(e) => setBarcodes(barcodes.map((x, j) => (j === i ? { ...x, pack: e.target.value } : x)))} />
                    unité(s)
                  </label>
                </td>
                <td>
                  <button type="button" className="ghost" onClick={() => setBarcodes(barcodes.filter((_, j) => j !== i))}>
                    ✕
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="inline">
          <button type="button" onClick={() => setBarcodes([...barcodes, { code: '', pack: '1' }])}>
            Ajouter un code-barres
          </button>
          <button
            type="button"
            onClick={async () => {
              try {
                const code = await call('catalogue.newInternalBarcode');
                setBarcodes([...barcodes, { code, pack: '1' }]);
              } catch (err) {
                toast.error(err);
              }
            }}
          >
            Générer un code interne
          </button>
        </div>
        {article && (history.data?.length ?? 0) > 0 && (
          <>
            <h3>Historique des prix</h3>
            <table className="list compact">
              <tbody>
                {history.data!.map((h, i) => (
                  <tr key={i}>
                    <td>{dateTime(h.at)}</td>
                    <td>{h.store_id ? 'Prix magasin' : 'Prix national'}</td>
                    <td className="r">
                      {h.old_price === null ? '' : `${fcfa(h.old_price)} → `}
                      {fcfa(h.new_price)}
                    </td>
                    <td>{h.user_name}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
        <div className="actions">
          <button type="button" className="ghost" onClick={onClose}>
            Fermer
          </button>
          <button type="submit" className="primary" disabled={article ? !can('article_edit', 'article_price', 'article_deactivate') : !can('article_create', 'sale_new_article')}>
            Enregistrer
          </button>
        </div>
      </form>
    </Modal>
  );
}

const IMPORT_HELP = `Colonnes attendues (séparateur point-virgule, première ligne = en-têtes) :
designation;code_barres;prix_vente;prix_achat;tva;unite;rayon;famille
Riz parfumé 5 kg;6111234567890;4500;3800;0;piece;Épicerie;Riz
Bière 65 cl;6009876543210;650;450;19,25;piece;Boissons;Bières`;

function parseCsv(text: string) {
  const rows = text
    .replace(/^﻿/, '')
    .split(/\r?\n/)
    .filter((l) => l.trim());
  const sep = rows[0]?.includes(';') ? ';' : ',';
  const head = rows[0]!.split(sep).map((h) => h.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ''));
  const col = (r: string[], ...names: string[]) => {
    const i = head.findIndex((h) => names.includes(h));
    return i >= 0 ? r[i]?.trim() ?? '' : '';
  };
  return rows.slice(1).map((line) => {
    const r = line.split(sep);
    const unit = col(r, 'unite', 'unit').toLowerCase();
    const tva = col(r, 'tva', 'taux_tva');
    return {
      name: col(r, 'designation', 'nom', 'libelle'),
      barcode: col(r, 'code_barres', 'codebarre', 'ean') || undefined,
      salePrice: Number(col(r, 'prix_vente', 'prix').replace(/\s/g, '')),
      purchasePrice: col(r, 'prix_achat') ? Number(col(r, 'prix_achat').replace(/\s/g, '')) : undefined,
      vatRateBp: tva ? Math.round(Number(tva.replace(',', '.').replace('%', '')) * 100) : undefined,
      unit: (unit === 'kg' ? 'kg' : unit.startsWith('l') ? 'litre' : 'piece') as 'piece' | 'kg' | 'litre',
      department: col(r, 'rayon') || undefined,
      family: col(r, 'famille') || undefined,
    };
  });
}

function ImportDialog({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const [rows, setRows] = useState<ReturnType<typeof parseCsv>>([]);
  const [result, setResult] = useState<Result<'catalogue.import'> | null>(null);
  return (
    <Modal title="Importer le catalogue" onClose={onClose} wide>
      <p>Depuis Excel : Fichier, Enregistrer sous, CSV (séparateur point-virgule).</p>
      <pre className="help">{IMPORT_HELP}</pre>
      <input
        type="file"
        accept=".csv,text/csv"
        onChange={async (e) => {
          const file = e.target.files?.[0];
          if (!file) return;
          try {
            setRows(parseCsv(await file.text()));
            setResult(null);
          } catch (err) {
            toast.error(err);
          }
        }}
      />
      {rows.length > 0 && !result && (
        <div className="actions">
          <span>{rows.length} ligne(s) lue(s)</span>
          <button
            className="primary"
            onClick={async () => {
              try {
                setResult(await call('catalogue.import', rows));
              } catch (err) {
                toast.error(err);
              }
            }}
          >
            Importer
          </button>
        </div>
      )}
      {result && (
        <div>
          <p>
            {result.created} article(s) créé(s), {result.updated} mis à jour, {result.errors.length} erreur(s).
          </p>
          {result.errors.length > 0 && (
            <ul className="errors">
              {result.errors.map((e) => (
                <li key={e.row}>
                  Ligne {e.row + 1} : {e.message}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Modal>
  );
}
