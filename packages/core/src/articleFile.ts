/**
 * Fichiers du catalogue : lecture d'un fichier d'articles (Excel ou CSV, avec
 * les en-têtes de FEDONIX ou d'autres logiciels de gestion, ou selon un format paramétrable)
 * et modèles d'export de la liste des produits. Une ligne = un article, avec
 * jusqu'à trois conditionnements dans des colonnes « Cond. 1 nom », « Cond. 1
 * contient »… Le catalogue exporté se réimporte tel quel.
 */
import { type ImportField, type ImportFormat, type Separator, guessSeparator, parseNumber, splitDelimited } from './formats';
import { parseFrNumber } from './takeover';
import type { XlsxColumn, XlsxFormat } from './xlsx';

export interface PackImportRow {
  name: string;
  /** Nombre du conditionnement suivant (ou d'unités de détail pour le dernier). */
  contains: number;
  salePrice: number;
  wholesalePrice?: number;
  superWholesalePrice?: number;
  barcode?: string;
}

/** Article lu dans un fichier ; un champ absent garde la valeur de la fiche existante. */
export interface ArticleImportRow {
  /** Ligne du fichier (1 = première ligne), pour les messages d'erreur. */
  line?: number;
  name: string;
  code?: string;
  barcode?: string;
  /** Obligatoire pour créer un article ; absent : l'article existant garde son prix. */
  salePrice?: number;
  purchasePrice?: number;
  vatRateBp?: number;
  unit?: 'piece' | 'kg' | 'litre';
  department?: string;
  family?: string;
  brand?: string;
  unitName?: string;
  wholesalePrice?: number;
  superWholesalePrice?: number;
  /** Seuils en millièmes (1 000 = 1 unité). */
  minQty?: number;
  alertQty?: number;
  maxQty?: number;
  perishable?: boolean;
  plu?: string;
  otherRef?: string;
  active?: boolean;
  /** Code (ou code-barres) de l'article proposé quand celui-ci est épuisé. */
  substitute?: string;
  /** Conditionnements du plus grand au plus petit ; absents : ceux de la fiche sont gardés. */
  packs?: PackImportRow[];
  /** Cellule illisible : la ligne n'est pas importée, avec ce message. */
  invalid?: string;
}

/** En-tête réduit à ses lettres et chiffres, sans accents : « Prix de vente » → « prixdevente ». */
export const headerKey = (h: string) =>
  h
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/g, '');

const PACK_KEYS = {
  Name: ['nom', 'nomconditionnement', 'conditionnement', ''],
  Contains: ['contient', 'contenance', 'qte', 'quantite', 'diviseur'],
  Price: ['prix', 'prixvente', 'prixdevente', 'pv'],
  Wholesale: ['gros', 'prixgros', 'prixdegros'],
  SuperWholesale: ['supergros', 'prixsupergros'],
  Barcode: ['codebarres', 'codebarre', 'ean'],
} as const;

/** En-têtes reconnus pour chaque colonne (FEDONIX, autres logiciels de gestion, tableurs). */
export const ARTICLE_HEADERS: Record<ImportField, string[]> = {
  code: ['code', 'codearticle', 'reference', 'referencearticle', 'ref', 'refarticle'],
  name: ['designation', 'designation1', 'nom', 'libelle', 'intitule', 'produit', 'nomduproduit', 'designationarticle', 'article'],
  barcode: ['codebarres', 'codebarre', 'codebarresunite', 'ean', 'ean13', 'gencod', 'codebarreeanupcc39', 'codeean'],
  salePrice: ['prixdevente', 'prixvente', 'prix', 'pv', 'pvttc', 'prixventettc', 'prixdeventettc', 'prixdetail', 'prixunitaire'],
  purchasePrice: ['prixdachat', 'prixachat', 'pa', 'prixachatstandard', 'prixachatht', 'prixdachatht', 'coutachat'],
  vat: ['tva', 'tauxtva', 'tauxdetva'],
  unit: ['unite', 'unit', 'unitedegestion', 'unitevente', 'unitedevente', 'uv'],
  department: ['rayon', 'departement', 'categorie'],
  family: ['famille', 'codefamille', 'sousfamille', 'familledarticles'],
  brand: ['marque', 'fabricant'],
  unitName: ['unitededetail', 'unitedetail', 'nomunite', 'nomdelunite'],
  wholesalePrice: ['prixdegros', 'prixgros', 'gros', 'pvgros'],
  superWholesalePrice: ['prixsupergros', 'supergros', 'pvsupergros'],
  minQty: ['stockmini', 'stockminimum', 'seuilmini', 'seuilminimum', 'mini'],
  alertQty: ['seuildalerte', 'seuilalerte', 'stockdalerte', 'stockalerte', 'alerte'],
  maxQty: ['stockmaxi', 'stockmaximum', 'seuilmaxi', 'maxi'],
  perishable: ['perissable', 'datelimite', 'dlc'],
  plu: ['plu', 'codebalance', 'codeplu'],
  otherRef: ['autrereference', 'autreref', 'referencefournisseur', 'reffournisseur', 'anciencode'],
  active: ['actif', 'active', 'enservice'],
  substitute: ['remplacant', 'articlederemplacement', 'remplacement', 'substitution', 'articledesubstitution'],
  ...packHeaders(1),
  ...packHeaders(2),
  ...packHeaders(3),
};

function packHeaders(n: 1 | 2 | 3): Record<`pack${1 | 2 | 3}${keyof typeof PACK_KEYS}`, string[]> {
  return Object.fromEntries(
    Object.entries(PACK_KEYS).map(([k, words]) => [`pack${n}${k}`, words.flatMap((w) => [`cond${n}${w}`, `conditionnement${n}${w}`])]),
  ) as Record<`pack${1 | 2 | 3}${keyof typeof PACK_KEYS}`, string[]>;
}

const yesNo = (raw: string): boolean | undefined => {
  const s = headerKey(raw);
  if (['oui', 'o', 'yes', 'y', '1', 'x', 'vrai', 'true'].includes(s)) return true;
  if (['non', 'n', 'no', '0', 'faux', 'false'].includes(s)) return false;
  return undefined;
};

/** Unité lue : kg et litre reconnus, le reste est vendu à la pièce (un nom comme « Bouteille » devient l'unité de détail). */
function readUnit(raw: string): { unit: 'piece' | 'kg' | 'litre'; name?: string } {
  const s = headerKey(raw);
  if (['kg', 'kilo', 'kilos', 'kilogramme', 'kilogrammes', 'kgs'].includes(s)) return { unit: 'kg' };
  if (['l', 'litre', 'litres', 'lt', 'ltr'].includes(s)) return { unit: 'litre' };
  if (['', 'piece', 'pieces', 'pce', 'pc', 'pi', 'u', 'un', 'uni', 'unite', 'unites', 'unit', 'ml'].includes(s)) return { unit: 'piece' };
  return { unit: 'piece', name: raw.trim().toUpperCase() };
}

type Getter = (k: ImportField) => string;

/** Construit une ligne d'article à partir de ses cellules ; `num` lit les nombres du fichier. */
function readRow(get: Getter, num: (v: string) => number | null, line: number): ArticleImportRow {
  const problems: string[] = [];
  const amount = (k: ImportField, label: string): number | undefined => {
    const v = get(k);
    if (!v) return undefined;
    const n = num(v);
    if (n === null || !Number.isFinite(n) || n < 0) {
      problems.push(`${label} illisible (« ${v} »)`);
      return undefined;
    }
    return Math.round(n);
  };
  const quantity = (k: ImportField, label: string): number | undefined => {
    const v = get(k);
    if (!v) return undefined;
    const n = num(v);
    if (n === null || !Number.isFinite(n) || n < 0) {
      problems.push(`${label} illisible (« ${v} »)`);
      return undefined;
    }
    return Math.round(n * 1000);
  };
  const flag = (k: ImportField, label: string): boolean | undefined => {
    const v = get(k);
    if (!v) return undefined;
    const b = yesNo(v);
    if (b === undefined) problems.push(`${label} : écrivez oui ou non (« ${v} »)`);
    return b;
  };
  const text = (k: ImportField) => get(k) || undefined;
  const unitRaw = get('unit');
  const unit = unitRaw ? readUnit(unitRaw) : null;
  const vatRaw = get('vat');
  let vatRateBp: number | undefined;
  if (vatRaw) {
    const n = num(vatRaw.replace('%', ''));
    if (n === null || !Number.isFinite(n) || n < 0 || n > 100) problems.push(`TVA illisible (« ${vatRaw} »)`);
    else vatRateBp = Math.round(n * 100);
  }
  const packs: PackImportRow[] = [];
  for (const n of [1, 2, 3] as const) {
    const name = get(`pack${n}Name`);
    if (!name) continue;
    const containsRaw = get(`pack${n}Contains`);
    const contains = containsRaw ? num(containsRaw) : null;
    if (contains === null || !Number.isInteger(contains)) {
      problems.push(`conditionnement « ${name} » : indiquez combien il contient (nombre entier)`);
      continue;
    }
    const salePrice = amount(`pack${n}Price`, `prix du conditionnement « ${name} »`);
    if (salePrice === undefined) {
      if (!get(`pack${n}Price`)) problems.push(`conditionnement « ${name} » : prix de vente manquant`);
      continue;
    }
    packs.push({
      name: name.toUpperCase(),
      contains,
      salePrice,
      wholesalePrice: amount(`pack${n}Wholesale`, `prix de gros du conditionnement « ${name} »`),
      superWholesalePrice: amount(`pack${n}SuperWholesale`, `prix super gros du conditionnement « ${name} »`),
      barcode: text(`pack${n}Barcode`),
    });
  }
  const row: ArticleImportRow = {
    line,
    name: get('name'),
    code: text('code')?.toUpperCase(),
    barcode: text('barcode'),
    salePrice: amount('salePrice', 'prix de vente'),
    purchasePrice: amount('purchasePrice', "prix d'achat"),
    vatRateBp,
    unit: unit?.unit,
    department: text('department'),
    family: text('family'),
    brand: text('brand'),
    unitName: text('unitName')?.toUpperCase() ?? unit?.name,
    wholesalePrice: amount('wholesalePrice', 'prix de gros'),
    superWholesalePrice: amount('superWholesalePrice', 'prix super gros'),
    minQty: quantity('minQty', 'stock minimum'),
    alertQty: quantity('alertQty', "seuil d'alerte"),
    maxQty: quantity('maxQty', 'stock maximum'),
    perishable: flag('perishable', 'périssable'),
    plu: text('plu'),
    otherRef: text('otherRef'),
    active: flag('active', 'actif'),
    substitute: text('substitute')?.toUpperCase(),
    packs: packs.length ? packs : undefined,
    invalid: problems.length ? problems.join(' ; ') : undefined,
  };
  // Les champs absents restent absents : à la mise à jour, la fiche garde sa valeur.
  for (const k of Object.keys(row) as (keyof ArticleImportRow)[]) if (row[k] === undefined) delete row[k];
  return row;
}

/**
 * Articles d'un tableau de cellules (CSV découpé ou feuille Excel). Sans
 * format, la première ligne non vide porte les en-têtes, reconnus avec ou sans
 * accents ; avec un format paramétrable, chaque donnée est à son numéro de colonne.
 */
export function articlesFromCells(cells: string[][], format: ImportFormat | null = null): ArticleImportRow[] {
  const clean = cells.map((r) => r.map((c) => String(c ?? '').trim()));
  if (format) {
    const num = (v: string) => {
      const n = parseNumber(v, format.decimal);
      return Number.isNaN(n) ? null : n;
    };
    return clean
      .map((r, i) => ({ r, line: i + 1 }))
      .slice(format.skipRows)
      .map(({ r, line }) => readRow((k) => (format.columns[k] === undefined ? '' : (r[format.columns[k]!] ?? '')), num, line))
      .filter((r) => r.name);
  }
  const headAt = clean.findIndex((r) => r.some((c) => c));
  if (headAt < 0) return [];
  const head = clean[headAt]!.map(headerKey);
  const at = {} as Partial<Record<ImportField, number>>;
  for (const [field, names] of Object.entries(ARTICLE_HEADERS) as [ImportField, string[]][]) {
    const i = names.map((n) => head.indexOf(n)).find((x) => x >= 0);
    if (i !== undefined) at[field] = i;
  }
  if (at.name === undefined) throw new Error('Colonne « Désignation » introuvable : la première ligne doit porter les en-têtes (Désignation ; Prix de vente ; Code-barres…)');
  return clean
    .map((r, i) => ({ r, line: i + 1 }))
    .slice(headAt + 1)
    .filter(({ r }) => r.some((c) => c))
    .map(({ r, line }) => readRow((k) => (at[k] === undefined ? '' : (r[at[k]!] ?? '')), parseFrNumber, line))
    .filter((r) => r.name || r.code);
}

/** Catalogue d'un fichier texte (CSV, TXT) : séparateur deviné, en-têtes reconnus ou format paramétrable. */
export function parseArticlesText(text: string, format: ImportFormat | null = null): ArticleImportRow[] {
  return articlesFromCells(splitDelimited(text, format?.separator ?? guessSeparator(text)), format);
}

/** Lit un catalogue selon un format : une ligne d'article par ligne du fichier. */
export function parseArticlesWith(text: string, f: ImportFormat): ArticleImportRow[] {
  return parseArticlesText(text, f);
}

// --- Export de la liste des produits ------------------------------------------------

/** Article tel que l'export le reçoit (fiche, conditionnements, stock par dépôt). */
export interface ExportArticle {
  code: string;
  name: string;
  department_name: string | null;
  family_name: string | null;
  brand: string | null;
  unit: 'piece' | 'kg' | 'litre';
  unit_name: string | null;
  vat_rate_bp: number;
  purchase_price: number;
  /** Prix TTC appliqué dans le magasin. */
  store_price: number;
  wholesale_price: number | null;
  super_wholesale_price: number | null;
  min_qty: number | null;
  alert_qty: number | null;
  max_qty: number | null;
  perishable: number;
  plu: string | null;
  other_ref: string | null;
  active: number;
  substitute_code: string | null;
  barcodes: { code: string; pack_qty: number }[];
  packs: { name: string; contains: number; units: number; sale_price: number; wholesale_price: number | null; super_wholesale_price: number | null; barcode: string | null }[];
  /** Quantité (millièmes), coût moyen et emplacement par dépôt. */
  stock: { warehouse_id: string; qty: number; avg_cost: number; location: string | null }[];
}

export type ExportModelId = 'catalogue' | 'prices' | 'barcodes' | 'count' | 'inventoryApp' | 'stockValue' | 'custom';

export const EXPORT_MODELS: { id: ExportModelId; name: string; description: string }[] = [
  { id: 'catalogue', name: 'Catalogue complet (réimportable)', description: 'Toute la fiche, conditionnements et prix compris. Corrigez-le dans Excel puis réimportez-le.' },
  { id: 'prices', name: 'Liste de prix', description: 'Une ligne par conditionnement : prix détail, gros et super gros. Pour les grossistes ou l’affichage.' },
  { id: 'barcodes', name: 'Codes-barres', description: 'Un code-barres par ligne (unité et conditionnements), pour les étiquettes ou une autre caisse.' },
  { id: 'count', name: 'Fiche de comptage', description: 'Article, emplacement, stock théorique au choix et colonne « Compté » vide ; elle se réimporte dans un inventaire.' },
  { id: 'inventoryApp', name: 'Application d’inventaire (.txt)', description: 'CODE;NOM (CONDITIONNEMENT);QUANTITÉ, une ligne par produit, pour l’application de comptage sur téléphone.' },
  { id: 'stockValue', name: 'Stock valorisé', description: 'Quantité par dépôt, coût moyen (CMUP) et valeur du stock.' },
  { id: 'custom', name: 'Modèle personnalisé', description: 'Choisissez les colonnes ; enregistrez le modèle pour le retrouver.' },
];

/** Colonnes au choix du modèle personnalisé (celles du catalogue complet). */
export type ArticleColumn =
  | 'code'
  | 'name'
  | 'barcode'
  | 'department'
  | 'family'
  | 'brand'
  | 'unit'
  | 'unitName'
  | 'vat'
  | 'purchasePrice'
  | 'salePrice'
  | 'wholesalePrice'
  | 'superWholesalePrice'
  | 'margin'
  | 'packs'
  | 'minQty'
  | 'alertQty'
  | 'maxQty'
  | 'perishable'
  | 'plu'
  | 'otherRef'
  | 'active'
  | 'substitute'
  | 'stock';

export const ARTICLE_COLUMNS: Record<ArticleColumn, string> = {
  code: 'Code',
  name: 'Désignation',
  barcode: 'Code-barres',
  department: 'Rayon',
  family: 'Famille',
  brand: 'Marque',
  unit: 'Unité',
  unitName: 'Unité de détail',
  vat: 'TVA (%)',
  purchasePrice: "Prix d'achat",
  salePrice: 'Prix de vente',
  wholesalePrice: 'Prix de gros',
  superWholesalePrice: 'Prix super gros',
  margin: 'Marge (%)',
  packs: 'Conditionnements (3 × 6 colonnes)',
  minQty: 'Stock minimum',
  alertQty: "Seuil d'alerte",
  maxQty: 'Stock maximum',
  perishable: 'Périssable',
  plu: 'PLU',
  otherRef: 'Autre référence',
  active: 'Actif',
  substitute: 'Remplaçant',
  stock: 'Stock total',
};

const CATALOGUE_COLUMNS: ArticleColumn[] = [
  'code',
  'name',
  'barcode',
  'department',
  'family',
  'brand',
  'unit',
  'unitName',
  'vat',
  'purchasePrice',
  'salePrice',
  'wholesalePrice',
  'superWholesalePrice',
  'packs',
  'minQty',
  'alertQty',
  'maxQty',
  'perishable',
  'plu',
  'otherRef',
  'active',
  'substitute',
];

export type ExportCell = string | number | null;

export interface ArticleExport {
  columns: XlsxColumn[];
  rows: ExportCell[][];
}

export interface ArticleExportOptions {
  /** Colonnes du modèle personnalisé. */
  columns?: ArticleColumn[];
  /** Dépôts (dans l'ordre) pour le stock valorisé et la fiche de comptage ; vide : tous ceux reçus. */
  warehouses?: { id: string; name: string }[];
  /** Fiche de comptage : ajouter le stock théorique. */
  withExpected?: boolean;
  /** Magasin sans TVA : pas de colonne TVA. */
  noVat?: boolean;
}

const UNIT_LABEL = { piece: 'Pièce', kg: 'Kg', litre: 'Litre' } as const;
const yes = (v: number | boolean) => (v ? 'Oui' : 'Non');
const qtyOf = (v: number | null) => (v === null ? null : v / 1000);
const unitOf = (a: ExportArticle) => (a.unit === 'piece' ? (a.unit_name ?? 'Pièce') : UNIT_LABEL[a.unit]);
/** Code-barres de l'unité de détail (pas celui d'un carton). */
const unitBarcode = (a: ExportArticle) => {
  const packCodes = new Set(a.packs.map((p) => p.barcode).filter(Boolean));
  return a.barcodes.find((b) => b.pack_qty === 1000 && !packCodes.has(b.code))?.code ?? null;
};
const marginPct = (a: ExportArticle) => {
  const ht = Math.round((a.store_price * 10000) / (10000 + a.vat_rate_bp));
  return ht > 0 && a.purchase_price > 0 ? Math.round(((ht - a.purchase_price) / ht) * 1000) / 10 : null;
};
const totalStock = (a: ExportArticle, warehouses?: { id: string }[]) =>
  a.stock.filter((s) => !warehouses?.length || warehouses.some((w) => w.id === s.warehouse_id)).reduce((t, s) => t + s.qty, 0);

function columnDefs(c: ArticleColumn, noVat: boolean): XlsxColumn[] {
  const money: XlsxFormat = 'money';
  switch (c) {
    case 'name':
      return [{ header: ARTICLE_COLUMNS.name, width: 36 }];
    case 'code':
    case 'barcode':
    case 'plu':
    case 'otherRef':
    case 'substitute':
      return [{ header: ARTICLE_COLUMNS[c], width: 16 }];
    case 'department':
    case 'family':
    case 'brand':
      return [{ header: ARTICLE_COLUMNS[c], width: 18 }];
    case 'vat':
      return noVat ? [] : [{ header: ARTICLE_COLUMNS.vat, width: 8 }];
    case 'purchasePrice':
    case 'salePrice':
    case 'wholesalePrice':
    case 'superWholesalePrice':
      return [{ header: ARTICLE_COLUMNS[c], format: money, width: 13 }];
    case 'margin':
      return [{ header: ARTICLE_COLUMNS.margin, width: 10 }];
    case 'minQty':
    case 'alertQty':
    case 'maxQty':
    case 'stock':
      return [{ header: ARTICLE_COLUMNS[c], format: 'qty', width: 12 }];
    case 'packs':
      return ([1, 2, 3] as const).flatMap((n) => [
        { header: `Cond. ${n} nom`, width: 12 },
        { header: `Cond. ${n} contient`, format: 'int' as const, width: 10 },
        { header: `Cond. ${n} prix`, format: money, width: 12 },
        { header: `Cond. ${n} gros`, format: money, width: 12 },
        { header: `Cond. ${n} super gros`, format: money, width: 12 },
        { header: `Cond. ${n} code-barres`, width: 16 },
      ]);
    default:
      return [{ header: ARTICLE_COLUMNS[c], width: 12 }];
  }
}

function cells(a: ExportArticle, c: ArticleColumn, noVat: boolean): ExportCell[] {
  switch (c) {
    case 'code':
      return [a.code];
    case 'name':
      return [a.name];
    case 'barcode':
      return [unitBarcode(a)];
    case 'department':
      return [a.department_name];
    case 'family':
      return [a.family_name];
    case 'brand':
      return [a.brand];
    case 'unit':
      return [UNIT_LABEL[a.unit]];
    case 'unitName':
      return [a.unit === 'piece' ? a.unit_name : null];
    case 'vat':
      return noVat ? [] : [a.vat_rate_bp / 100];
    case 'purchasePrice':
      return [a.purchase_price];
    case 'salePrice':
      return [a.store_price];
    case 'wholesalePrice':
      return [a.wholesale_price];
    case 'superWholesalePrice':
      return [a.super_wholesale_price];
    case 'margin':
      return [marginPct(a)];
    case 'packs':
      return [0, 1, 2].flatMap((i) => {
        const p = a.packs[i];
        return p ? [p.name, p.contains, p.sale_price, p.wholesale_price, p.super_wholesale_price, p.barcode] : [null, null, null, null, null, null];
      });
    case 'minQty':
      return [qtyOf(a.min_qty)];
    case 'alertQty':
      return [qtyOf(a.alert_qty)];
    case 'maxQty':
      return [qtyOf(a.max_qty)];
    case 'perishable':
      return [yes(a.perishable)];
    case 'plu':
      return [a.plu];
    case 'otherRef':
      return [a.other_ref];
    case 'active':
      return [yes(a.active)];
    case 'substitute':
      return [a.substitute_code];
    case 'stock':
      return [totalStock(a) / 1000];
  }
}

/** Tableau d'un modèle d'export (colonnes et lignes), prêt pour Excel ou CSV. */
export function buildArticleExport(model: ExportModelId, articles: ExportArticle[], opts: ArticleExportOptions = {}): ArticleExport {
  const noVat = opts.noVat ?? false;
  const warehouses = opts.warehouses ?? [];
  const plain = (cols: ArticleColumn[]): ArticleExport => ({
    columns: cols.flatMap((c) => columnDefs(c, noVat)),
    rows: articles.map((a) => cols.flatMap((c) => cells(a, c, noVat))),
  });
  switch (model) {
    case 'catalogue':
      return plain(CATALOGUE_COLUMNS);
    case 'custom':
      return plain(opts.columns?.length ? opts.columns : ['code', 'name', 'salePrice']);
    case 'prices': {
      const rows = articles.flatMap((a) => [
        ...a.packs.map((p) => [a.code, a.name, a.department_name, p.name, p.units / 1000, p.sale_price, p.wholesale_price, p.super_wholesale_price, p.barcode] as ExportCell[]),
        [a.code, a.name, a.department_name, unitOf(a), 1, a.store_price, a.wholesale_price, a.super_wholesale_price, unitBarcode(a)],
      ]);
      return {
        columns: [
          { header: 'Code', width: 14 },
          { header: 'Désignation', width: 36 },
          { header: 'Rayon', width: 18 },
          { header: 'Conditionnement', width: 16 },
          { header: 'Unités', format: 'qty', width: 9 },
          { header: 'Prix détail', format: 'money', width: 12 },
          { header: 'Prix de gros', format: 'money', width: 12 },
          { header: 'Prix super gros', format: 'money', width: 13 },
          { header: 'Code-barres', width: 16 },
        ],
        rows,
      };
    }
    case 'barcodes': {
      const rows = articles.flatMap((a) => {
        const packByCode = new Map(a.packs.filter((p) => p.barcode).map((p) => [p.barcode!, p]));
        return a.barcodes.map((b) => {
          const p = packByCode.get(b.code);
          const level = p ? p.name : b.pack_qty === 1000 ? unitOf(a) : `${unitOf(a)} × ${b.pack_qty / 1000}`;
          return [a.code, a.name, level, b.code, p ? p.sale_price : Math.round((a.store_price * b.pack_qty) / 1000)] as ExportCell[];
        });
      });
      return {
        columns: [
          { header: 'Code', width: 14 },
          { header: 'Désignation', width: 36 },
          { header: 'Conditionnement', width: 16 },
          { header: 'Code-barres', width: 18 },
          { header: 'Prix', format: 'money', width: 12 },
        ],
        rows,
      };
    }
    case 'count': {
      const at = warehouses[0];
      const location = (a: ExportArticle) => (at ? (a.stock.find((s) => s.warehouse_id === at.id)?.location ?? null) : null);
      const sorted = [...articles].sort(
        (x, y) => (location(x) ?? '￿').localeCompare(location(y) ?? '￿', 'fr') || (x.department_name ?? '').localeCompare(y.department_name ?? '', 'fr') || x.name.localeCompare(y.name, 'fr'),
      );
      return {
        columns: [
          { header: 'Code', width: 14 },
          { header: 'Désignation', width: 36 },
          { header: 'Rayon', width: 18 },
          { header: 'Emplacement', width: 12 },
          { header: 'Unité', width: 10 },
          ...(opts.withExpected ? [{ header: 'Stock théorique', format: 'qty' as const, width: 12 }] : []),
          { header: 'Compté', format: 'qty', width: 12 },
        ],
        rows: sorted.map((a) => [a.code, a.name, a.department_name, location(a), unitOf(a), ...(opts.withExpected ? [totalStock(a, at ? [at] : []) / 1000] : []), null]),
      };
    }
    case 'inventoryApp': {
      const at = warehouses[0];
      return {
        columns: [{ header: 'Code' }, { header: 'Nom (conditionnement)' }, { header: 'Quantité', format: 'qty' }],
        rows: articles.map((a) => [a.code, `${a.name} (${unitOf(a).toUpperCase()})`, opts.withExpected ? totalStock(a, at ? [at] : []) / 1000 : 0]),
      };
    }
    case 'stockValue': {
      const list = warehouses.length ? warehouses : [];
      const rows = articles.map((a) => {
        const per = list.map((w) => (a.stock.find((s) => s.warehouse_id === w.id)?.qty ?? 0) / 1000);
        const own = a.stock.filter((s) => !list.length || list.some((w) => w.id === s.warehouse_id));
        const qty = own.reduce((t, s) => t + s.qty, 0);
        const value = own.reduce((t, s) => t + Math.round((s.qty * s.avg_cost) / 1000), 0);
        const cost = qty > 0 ? Math.round((value * 1000) / qty) : (own[0]?.avg_cost ?? a.purchase_price);
        return [a.code, a.name, a.department_name, unitOf(a), ...(list.length > 1 ? per : []), qty / 1000, cost, value] as ExportCell[];
      });
      return {
        columns: [
          { header: 'Code', width: 14 },
          { header: 'Désignation', width: 36 },
          { header: 'Rayon', width: 18 },
          { header: 'Unité', width: 10 },
          ...(list.length > 1 ? list.map((w) => ({ header: w.name, format: 'qty' as const, width: 12 })) : []),
          { header: 'Quantité', format: 'qty', width: 12 },
          { header: 'Coût moyen (CMUP)', format: 'money', width: 14 },
          { header: 'Valeur', format: 'money', width: 14 },
        ],
        rows,
      };
    }
  }
}

/** Écrit un export en texte délimité : séparateur, virgule ou point décimal, en-têtes au choix. */
export function exportToDelimited(data: ArticleExport, opts: { separator: Separator; decimal: ',' | '.'; header: boolean }): string {
  const sep = opts.separator;
  const esc = (v: ExportCell): string => {
    if (v === null || v === undefined) return '';
    const s = typeof v === 'number' ? (opts.decimal === ',' ? String(v).replace('.', ',') : String(v)) : v;
    return s.includes(sep) || /["\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [...(opts.header ? [data.columns.map((c) => esc(c.header))] : []), ...data.rows.map((r) => r.map(esc))];
  return `${lines.map((l) => l.join(sep)).join('\r\n')}\r\n`;
}
