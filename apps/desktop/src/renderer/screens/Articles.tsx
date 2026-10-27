import { useState } from 'react';
import { parseNetContent, parseQtyTiers, splitTtc, unitPriceText } from '@superette/core';
import { type Result, call } from '../api';
import { Empty, Field, Modal, Tabs, dateTime, fcfa, parseAmount, parseQty, useLoad, useToast, has, useCan, useStoreSettings, useDraft } from '../ui';
import { ExportDialog, ImportDialog, type ListFilter, PriceUpdateDialog } from './articleFiles';
import { useArticleSuggestions, SuggestionList } from './pickers';
import { Shelving } from './Controls';
import { PriceSchedules } from './PriceSchedules';
import { LevelGrid, MAX_LEVELS, emptyLevel, levelsFromArticle, levelsToInput } from './packs';
import { type ArticlePhoto, PhotoField } from './photo';
import { BarcodeChip, BarcodePrintDialog, barcodeRowsOf } from './barcodePrint';
import { tx } from '../tax';

type Article = Result<'catalogue.get'>;
type User = NonNullable<Result<'app.state'>['user']>;

/** Prix au kilo ou au litre imprimé sur l'étiquette, d'après le contenu net (ou la désignation). */
const unitPriceHint = (text: string, price: number) => {
  const t = unitPriceText(price, parseNetContent(text));
  return t ? `Étiquette : ${t}` : 'Pour le prix au kilo ou au litre sur l’étiquette';
};

export type ArticlesView = 'list' | 'new' | 'search' | 'shelving' | 'schedules';

export function Articles({ user, view = 'list' }: { user: User; view?: ArticlesView }) {
  const schedules = has(user, 'price_schedule') || has(user, 'price_update');
  const [tab, setTab] = useState<'list' | 'shelving' | 'schedules'>(view === 'shelving' ? 'shelving' : view === 'schedules' && schedules ? 'schedules' : 'list');
  const canEdit = has(user, 'article_families');
  return (
    <div className="page">
      <header className="page-head">
        <h1>Produits</h1>
      </header>
      <Tabs
        main
        value={tab}
        onChange={setTab}
        tabs={[
          ['list', 'Liste des produits'],
          ['shelving', 'Rayonnage'],
          ...(schedules ? ([['schedules', 'Prix programmés']] as ['schedules', string][]) : []),
        ]}
      />
      {tab === 'list' && <ArticleList user={user} startNew={view === 'new'} focusSearch={view === 'search'} />}
      {tab === 'shelving' && <Shelving canEdit={canEdit} />}
      {tab === 'schedules' && <PriceSchedules />}
    </div>
  );
}

function ArticleList({ user, startNew, focusSearch }: { user: User; startNew: boolean; focusSearch: boolean }) {
  const [search, setSearch] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [status, setStatus] = useState<ListFilter['status']>('all');
  const [editing, setEditing] = useState<Article | 'new' | null>(startNew ? 'new' : null);
  const [dialog, setDialog] = useState<'import' | 'xlsx' | 'csv' | 'prices' | null>(null);
  const departments = useLoad(() => call('catalogue.departments'), []);
  const app = useLoad(() => call('app.state'), []);
  const noVat = app.data?.station?.store.vat_enabled === 0;
  const loaded = useLoad(() => call('catalogue.search', search, { includeInactive: status !== 'active' }), [search, status]);
  const families = new Set(departments.data?.find((d) => d.id === departmentId)?.families.map((f) => f.id) ?? []);
  const articles = {
    ...loaded,
    data: loaded.data?.filter((a) => (status !== 'inactive' || !a.active) && (!departmentId || (a.family_id !== null && families.has(a.family_id)))),
  };
  const filter: ListFilter = { query: search, departmentId, familyId: '', status };
  return (
    <>
      <div className="filters">
        <input className="search" autoFocus={focusSearch} placeholder="Rechercher (nom, code, code-barres, marque)" value={search} onChange={(e) => setSearch(e.target.value)} />
        <select value={departmentId} onChange={(e) => setDepartmentId(e.target.value)} title="Rayon">
          <option value="">Tous les rayons</option>
          {(departments.data ?? []).map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
        <select value={status} onChange={(e) => setStatus(e.target.value as ListFilter['status'])} title="État">
          <option value="all">Actifs et en sommeil</option>
          <option value="active">Actifs</option>
          <option value="inactive">En sommeil</option>
        </select>
        {has(user, 'import') && <button onClick={() => setDialog('import')}>Importer (Excel, CSV)</button>}
        {has(user, 'article_export') && (
          <>
            <button onClick={() => setDialog('xlsx')} title="Catalogue, liste de prix, codes-barres, fiche de comptage, stock valorisé">
              Exporter Excel
            </button>
            <button onClick={() => setDialog('csv')}>Exporter CSV</button>
          </>
        )}
        {has(user, 'price_update') && <button onClick={() => setDialog('prices')}>Mise à jour des prix…</button>}
        {has(user, 'article_create') && (
          <button data-new title="Ctrl+J" className="primary" style={{ marginLeft: 'auto' }} onClick={() => setEditing('new')}>
            Nouvel article
          </button>
        )}
      </div>
      {loaded.data?.length === 200 && <p className="muted small">Les 200 premiers produits sont affichés : affinez la recherche. L'export, lui, prend tous les produits.</p>}
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
                  <td>{!a.active && <span className="tag">en sommeil</span>}</td>
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
            loaded.reload();
          }}
        />
      )}
      {dialog === 'import' && (
        <ImportDialog
          onClose={() => {
            setDialog(null);
            loaded.reload();
          }}
        />
      )}
      {(dialog === 'xlsx' || dialog === 'csv') && <ExportDialog kind={dialog} filter={filter} noVat={noVat} onClose={() => setDialog(null)} />}
      {dialog === 'prices' && (
        <PriceUpdateDialog
          onClose={() => setDialog(null)}
          onDone={() => {
            setDialog(null);
            loaded.reload();
          }}
        />
      )}
    </>
  );
}

/**
 * Fiche article (« Ajouter/Paramétrer une marchandise »). Depuis la
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
  const [netContent, setNetContent] = useState(article?.net_content ?? '');
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
  const [printing, setPrinting] = useState(false);
  const [renaming, setRenaming] = useState(false);
  // Emballage consigné (casier, bouteille) : un emballage pour `units` unités vendues.
  const canContainer = can('containers', 'article_edit');
  const containerTypes = useLoad(() => (canContainer ? call('containers.types') : Promise.resolve([])), []);
  const withContainer = article as (Article & { container_id?: string | null; container_units?: number }) | null;
  const initialContainer = { id: withContainer?.container_id ?? '', units: withContainer?.container_units ?? 1000 };
  const [container, setContainer] = useState({ id: initialContainer.id, units: String(initialContainer.units / 1000) });
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
  const [substitute, setSubstitute] = useState<{ id: string; label: string } | null>(
    article?.substitute_id ? { id: article.substitute_id, label: `${article.substitute_code ?? ''} · ${article.substitute_name ?? ''}` } : null,
  );
  const warehouses = useLoad(() => call('admin.warehouses'), []);
  const initialLocations = (() => {
    try {
      return article?.locations ? (JSON.parse(article.locations) as Record<string, string>) : {};
    } catch {
      return {};
    }
  })();
  const [locations, setLocations] = useState<Record<string, string>>(initialLocations);
  // Prix par quantité de l'unité de détail : trois paliers au plus à l'écran.
  const initialTiers = parseQtyTiers(article?.qty_tiers);
  const [tiers, setTiers] = useState(
    [0, 1, 2].map((i) => ({ qty: initialTiers[i] ? String(initialTiers[i]!.minQty / 1000) : '', price: initialTiers[i] ? String(initialTiers[i]!.price) : '' })),
  );
  const [newDept, setNewDept] = useState('');
  const [shelfQty, setShelfQty] = useState(milli(article?.shelf_qty));
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

  // Nouvel article en cours de saisie : gardé sur ce PC (coupure de courant, fermeture).
  const draft = useDraft(
    article || initialName ? null : 'article:new',
    f.name.trim() ? `Nouvel article ${f.name.trim()}` : 'Nouvel article',
    { f, levels, buy, barcodes },
    (d) => (setF(d.f), setLevels(d.levels), setBuy(d.buy), setBarcodes(d.barcodes)),
    (d) => !d.f.name.trim(),
  );

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
          substituteId: substitute?.id ?? null,
        },
        article?.id,
      );
      for (const w of warehouses.data ?? []) {
        const v = (locations[w.id] ?? '').trim().toUpperCase();
        if (v !== (initialLocations[w.id] ?? '')) await call('catalogue.setLocation', saved.id, w.id, v);
      }
      if (canContainer) {
        const units = parseQty(container.units) ?? 1000;
        if (container.id !== initialContainer.id || (container.id && units !== initialContainer.units))
          await call('containers.setArticle', saved.id, container.id || null, container.id ? units : 1000);
      }
      const nextTiers = tiers
        .filter((t) => t.qty.trim() && t.price.trim())
        .map((t) => ({ minQty: Math.round(Number(t.qty.replace(',', '.')) * 1000), price: parseAmount(t.price) ?? 0 }));
      if (JSON.stringify(nextTiers) !== JSON.stringify(initialTiers)) await call('catalogue.setQtyTiers', saved.id, nextTiers);
      if (canSetStorePrice) {
        const sp = storePrice.trim() ? parseAmount(storePrice) : null;
        const current = article && article.store_price !== article.sale_price ? article.store_price : null;
        if (sp !== current) await call('catalogue.setStorePrice', saved.id, sp);
      }
      if (photo !== undefined) await call('catalogue.setPhoto', saved.id, photo);
      if (netContent.trim() !== (article?.net_content ?? '')) await call('articles.setNetContent', saved.id, netContent.trim() || null);
      if (shelfQty !== milli(article?.shelf_qty) && can('restock', 'article_edit')) await call('restock.setShelfQty', saved.id, shelfQty.trim() ? parseQty(shelfQty) : null);
      draft.clear();
      toast.ok('Article enregistré');
      onSaved(saved);
    } catch (err) {
      toast.error(err);
    }
  };

  return (
    <Modal title={article ? `${article.code} · ${f.name}` : 'Nouvel article'} onClose={onClose} wide>
      {renaming && article && (
        <RenameDialog
          articleId={article.id}
          current={f.name}
          onClose={() => setRenaming(false)}
          onDone={(name) => {
            setRenaming(false);
            setF({ ...f, name });
          }}
        />
      )}
      <form onSubmit={save}>
        {draft.banner}
        <div className="article-top">
        <div className="grid3">
          {article ? (
            <Field label="Désignation">
              <div className="inline">
                <input value={f.name} disabled title="Cliquez sur « Modifier le nom » pour changer le nom" />
                <button type="button" disabled={!can('article_rename')} title={can('article_rename') ? undefined : 'Vous n’avez pas le droit de changer le nom d’un produit'} onClick={() => setRenaming(true)}>
                  Modifier le nom
                </button>
              </div>
            </Field>
          ) : (
            <Field label="Désignation">
              <input autoFocus value={f.name} onChange={set('name')} required />
            </Field>
          )}
          <Field label="Code article" hint="Laisser vide pour numérotation automatique">
            <input value={f.code} onChange={set('code')} />
          </Field>
          <Field label="Autre réf." hint="Référence fournisseur, ancien code : cherchée en caisse">
            <input value={f.otherRef} onChange={set('otherRef')} />
          </Field>
          <Field label="Contenu net" hint={unitPriceHint(netContent || f.name, parseAmount(levels.filter((l) => l.enabled).at(-1)?.sale ?? '') ?? article?.sale_price ?? 0)}>
            <input value={netContent} placeholder={tx('ex. 900 g, 1,5 L')} onChange={(e) => setNetContent(e.target.value)} />
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
          <Field label="Article de remplacement" hint="Proposé en caisse quand celui-ci est épuisé">
            <SubstituteInput value={substitute} exclude={article?.id ?? null} onChange={setSubstitute} />
          </Field>
          {canContainer && (container.id || (containerTypes.data ?? []).length > 0) && (
            <>
              <Field label="Emballage consigné" hint="Casier ou bouteille dont la consigne se paie à la caisse">
                <select value={container.id} onChange={(e) => setContainer({ ...container, id: e.target.value })}>
                  <option value="">Aucun</option>
                  {(containerTypes.data ?? []).map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name} · consigne {fcfa(c.deposit)}
                    </option>
                  ))}
                  {container.id && !(containerTypes.data ?? []).some((c) => c.id === container.id) && <option value={container.id}>Emballage désactivé</option>}
                </select>
              </Field>
              {container.id && (
                <Field label="Unités par emballage" hint="12 pour un casier de 12 bouteilles, 1 pour une bouteille">
                  <input inputMode="decimal" value={container.units} onChange={(e) => setContainer({ ...container, units: e.target.value })} />
                </Field>
              )}
            </>
          )}
          {piece &&
            tiers.map((t, i) => (
              <Field key={`tier${i}`} label={`Prix par quantité ${i + 1}`} hint={i === 0 ? 'À partir de combien d’unités, et le prix de l’unité' : undefined}>
                <span className="inline">
                  <input inputMode="numeric" placeholder="À partir de" value={t.qty} onChange={(e) => setTiers(tiers.map((x, j) => (j === i ? { ...x, qty: e.target.value } : x)))} />
                  <input inputMode="numeric" placeholder="Prix unitaire" value={t.price} onChange={(e) => setTiers(tiers.map((x, j) => (j === i ? { ...x, price: e.target.value } : x)))} />
                </span>
              </Field>
            ))}
          {(warehouses.data ?? []).map((w) => (
            <Field key={w.id} label={`Emplacement · ${w.name}`} hint="Allée, étagère (ex. A3-2)">
              <input value={locations[w.id] ?? ''} maxLength={20} disabled={!can('article_edit', 'stock_location')} onChange={(e) => setLocations({ ...locations, [w.id]: e.target.value })} />
            </Field>
          ))}
          <Field label="Quantité voulue en rayon" hint="Réassort du rayon ; vide : deux jours de ventes">
            <input inputMode="decimal" value={shelfQty} disabled={!can('restock', 'article_edit')} onChange={(e) => setShelfQty(e.target.value)} />
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
            {!f.active && <small className="muted"> · en sommeil : il garde son historique mais ne se vend plus et ne se commande plus</small>}
          </label>
        </div>
        <h3>{piece && lastOn > 0 ? `Codes-barres de l'unité de détail (${unitName})` : 'Codes-barres'}</h3>
        <table className="list compact bc-codes">
          <tbody>
            {barcodes.map((b, i) => (
              <tr key={i}>
                <td>
                  <input value={b.code} onChange={(e) => setBarcodes(barcodes.map((x, j) => (j === i ? { ...x, code: e.target.value } : x)))} placeholder="Scanner le code" />
                </td>
                <td>{b.code.trim() && <BarcodeChip code={b.code.trim()} />}</td>
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
            {levels
              .filter((l) => l.enabled && l.barcode.trim())
              .map((l) => (
                <tr key={l.key}>
                  <td>
                    <span className="bc-num">{l.barcode.trim()}</span>
                  </td>
                  <td>
                    <BarcodeChip code={l.barcode.trim()} />
                  </td>
                  <td colSpan={2}>
                    <b>{l.name}</b> <small className="muted">· modifiable dans le tableau des conditionnements</small>
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
        {settings.barcodeAuto && (
          <p className="muted">
            Ce qui n'a pas de code fabricant reçoit un code interne {settings.barcodeKind === 'ean8' ? 'EAN-8' : 'EAN-13'} à l'enregistrement
            {article ? ' (chaque nouveau carton ou pack)' : " (l'unité, chaque carton et pack)"}.
          </p>
        )}
        <div className="inline">
          <button type="button" onClick={() => setBarcodes([...barcodes, { code: '', pack: '1' }])}>
            Ajouter un code fabricant (scanner)
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
          <span className="spacer" />
          {article && (
            <button type="button" className="primary" onClick={() => setPrinting(true)} title="Étiquettes code-barres de cet article (codes enregistrés)">
              🖨 Imprimer les codes-barres…
            </button>
          )}
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
      {printing && article && (
        <BarcodePrintDialog title={`Imprimer les codes-barres · ${article.name}`} rows={barcodeRowsOf(article)} onClose={() => setPrinting(false)} />
      )}
    </Modal>
  );
}

/** Choix de l'article de remplacement dans la fiche (sans formulaire imbriqué). */
function SubstituteInput({ value, exclude, onChange }: { value: { id: string; label: string } | null; exclude: string | null; onChange: (v: { id: string; label: string } | null) => void }) {
  const [q, setQ] = useState('');
  const s = useArticleSuggestions(q);
  const pick = (a: Article) => {
    if (a.id === exclude) return;
    onChange({ id: a.id, label: `${a.code} · ${a.name}` });
    setQ('');
  };
  if (value) {
    return (
      <div className="inline">
        <span>{value.label}</span>
        <button type="button" className="ghost" onClick={() => onChange(null)} title="Retirer">
          ✕
        </button>
      </div>
    );
  }
  return (
    <div className="picker">
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (s.onKeyDown(e, pick)) return;
          if (e.key === 'Enter') e.preventDefault();
        }}
        onBlur={s.close}
        placeholder="Taper le début du nom"
        autoComplete="off"
      />
      <SuggestionList s={s} onPick={pick} query={q} />
    </div>
  );
}

/**
 * Changer le nom d'un produit déjà créé : sur la fiche, le nom est grisé pour
 * ne pas le modifier par erreur ; ce bouton ouvre cette petite fenêtre.
 * L'ancien nom reste dans le journal d'audit.
 */
function RenameDialog({ articleId, current, onClose, onDone }: { articleId: string; current: string; onClose: () => void; onDone: (name: string) => void }) {
  const toast = useToast();
  const [name, setName] = useState(current);
  const [reason, setReason] = useState('');
  const clean = name.trim();
  return (
    <Modal title="Modifier le nom du produit" onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await call('catalogue.rename', articleId, clean, reason);
            toast.ok('Nom du produit changé');
            onDone(clean);
          } catch (err) {
            toast.error(err);
          }
        }}
      >
        <p className="muted">
          Nom actuel : <b>{current}</b>. Le nouveau nom apparaîtra sur les tickets, les factures, les étiquettes et les inventaires.
        </p>
        <Field label="Nouveau nom">
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Motif (facultatif)" hint="Gardé dans le journal d'audit avec l'ancien nom">
          <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Faute de frappe, nouveau format du fournisseur…" />
        </Field>
        <div className="actions">
          <button type="button" onClick={onClose}>
            Annuler
          </button>
          <button type="submit" className="primary" disabled={!clean || clean === current}>
            Enregistrer le nom
          </button>
        </div>
      </form>
    </Modal>
  );
}
