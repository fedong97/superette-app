/**
 * Modèles d'impression des documents, comme les « variantes des états » de
 * Sage Saari ou KONTROL : pour chaque document (facture client…), chaque
 * format (ticket de caisse, A4, listing) et chaque variante (comptant, à
 * terme), un ou plusieurs modèles réglables champ par champ.
 *
 * Les modèles livrés avec le logiciel sont décrits ici ; le magasin garde
 * dans ses paramètres ses modèles modifiés ou ajoutés, et le modèle choisi
 * par défaut pour chaque emplacement. Le rendu est pur (sans base ni
 * Electron) : le même code imprime et affiche l'aperçu.
 */
import { formatFcfa } from './money';
import { formatRate, splitTtc } from './tax';
import { numberToWordsFr } from './words';
import type { Receipt, ReceiptLine } from './escpos';

export const DOC_KINDS = { invoice: 'Facture client' } as const;
export type DocKind = keyof typeof DOC_KINDS;
export const DOC_FORMATS = { ticket: 'Ticket de caisse', a4: 'A4', listing: 'Listing' } as const;
export type DocFormat = keyof typeof DOC_FORMATS;
export const DOC_VARIANTS = { cash: 'Comptant', credit: 'À terme' } as const;
export type DocVariant = keyof typeof DOC_VARIANTS;
export const DOC_PAPERS = { '80mm': 'Rouleau 80 mm', '58mm': 'Rouleau 58 mm', A4: 'A4', A5: 'A5' } as const;
export type DocPaper = keyof typeof DOC_PAPERS;
export const DOC_FONTS = { sans: 'Arial (sans empattement)', serif: 'Times (avec empattement)', mono: 'Courier (machine à écrire)' } as const;
export type DocFont = keyof typeof DOC_FONTS;

/** Colonnes possibles du tableau des articles, avec leur titre par défaut. */
export const DOC_COLUMNS = {
  line: 'N°',
  code: 'Code',
  barcode: 'Code-barres',
  label: 'Désignation',
  qty: 'Qté',
  unit: 'Unité',
  unitPrice: 'PU TTC',
  unitPriceHt: 'PU HT',
  discount: 'Remise',
  vat: 'TVA',
  totalHt: 'Total HT',
  totalTtc: 'Total TTC',
} as const;
export type DocColumnKey = keyof typeof DOC_COLUMNS;
const COLUMN_KEYS = Object.keys(DOC_COLUMNS) as DocColumnKey[];
const NUMERIC_COLUMNS: DocColumnKey[] = ['qty', 'unitPrice', 'unitPriceHt', 'discount', 'vat', 'totalHt', 'totalTtc'];

export interface DocColumn {
  key: DocColumnKey;
  /** Titre imprimé en tête de colonne. */
  label: string;
  show: boolean;
  /** Largeur en % du tableau (A4 et listing) ; 0 : le reste de la place. */
  width: number;
}

export interface DocTemplate {
  id: string;
  doc: DocKind;
  format: DocFormat;
  variant: DocVariant;
  name: string;
  /** Modèle livré avec le logiciel : il ne se supprime pas et se rétablit. */
  builtin: boolean;
  page: {
    paper: DocPaper;
    landscape: boolean;
    /** Marges en mm. */
    margin: number;
    font: DocFont;
    /** Taille du texte, en points d'écran. */
    fontSize: number;
    /** Hauteurs minimales en mm (0 : selon le contenu), comme « Ht entête/pied » et « Ht ligne tab ». */
    headerHeight: number;
    footerHeight: number;
    lineHeight: number;
    /** Exemplaires imprimés. */
    copies: number;
    /** Cadres autour des cellules du tableau. */
    borders: boolean;
  };
  header: {
    logo: boolean;
    /** Hauteur du logo en mm. */
    logoSize: number;
    logoAlign: 'left' | 'center' | 'right';
    storeName: boolean;
    address: boolean;
    phone: boolean;
    niu: boolean;
    rccm: boolean;
    /** Texte libre sous l'identité du magasin. */
    message: string;
  };
  customer: { show: boolean; code: boolean; address: boolean; phone: boolean; niu: boolean; balance: boolean };
  info: {
    /** Titre du document (« Facture », « FACTURE À TERME »…) ; vide sur le ticket : « Ticket n° ». */
    title: string;
    number: boolean;
    date: boolean;
    time: boolean;
    seller: boolean;
    register: boolean;
    priceLevel: boolean;
    dueDate: boolean;
  };
  columns: DocColumn[];
  totals: {
    ht: boolean;
    vatDetail: boolean;
    discount: boolean;
    promo: boolean;
    rounding: boolean;
    payments: boolean;
    change: boolean;
    remaining: boolean;
    words: boolean;
  };
  footer: {
    /** Mentions libres (conditions de vente…). */
    text: string;
    /** Message de remerciement ; vide sur le ticket : celui des paramètres. */
    thanks: string;
    signatures: boolean;
    signLeft: string;
    signRight: string;
    /** « DUPLICATA » sur les réimpressions. */
    duplicate: boolean;
  };
}

/** Contenu d'une facture, indépendamment de sa mise en page. */
export interface DocData {
  store: {
    name: string;
    address: string | null;
    phone: string | null;
    niu: string | null;
    rccm: string;
    /** Logo en data URL, ou vide. */
    logo: string;
    /** Message d'en-tête du ticket (paramètres). */
    message: string;
    /** Message de pied du ticket (paramètres du poste). */
    thanks: string;
    vatEnabled: boolean;
  };
  customer: {
    name: string;
    code: string | null;
    address: string | null;
    phone: string | null;
    niu: string | null;
    /** Solde du compte client après la facture ; null : client comptoir. */
    balance: number | null;
    /** Client de passage (nom saisi à la caisse, sans compte). */
    counter: boolean;
  } | null;
  doc: {
    kind: 'sale' | 'return';
    number: string;
    /** Date et heure ISO. */
    date: string;
    dueDate: string | null;
    seller: string;
    register: string | null;
    /** Tarif appliqué s'il n'est pas le détail. */
    priceLevel: string | null;
    cancelled: boolean;
    duplicate: boolean;
  };
  lines: DocLine[];
  payments: { label: string; amount: number }[];
  totals: { ht: number; tva: number; ttc: number; discount: number; promo: number; rounding: number; change: number; remaining: number };
}

export interface DocLine {
  code: string | null;
  barcode: string | null;
  label: string;
  /** Quantité affichée (« 6 », « 1,250 kg »). */
  qty: string;
  /** Conditionnement vendu (« CARTON »), vide pour l'unité. */
  unit: string;
  /** Prix TTC de l'unité ou du conditionnement vendu. */
  unitPrice: number;
  unitPriceHt: number;
  discount: number;
  vatRate: number;
  totalHt: number;
  /** Total TTC net (après remise et promotion). */
  totalTtc: number;
  promo: number;
  promoName: string | null;
  /** Plus d'une unité ou un conditionnement : le ticket détaille « 6 x 650 ». */
  detail: boolean;
}

/** Emplacement d'un modèle : un document, un format, une variante. */
export const slotKey = (doc: DocKind, format: DocFormat, variant: DocVariant) => `${doc}.${format}.${variant}`;

const cols = (spec: Partial<Record<DocColumnKey, number | false | [number, string]>>): DocColumn[] =>
  COLUMN_KEYS.map((key) => {
    const s = spec[key];
    const [width, label] = Array.isArray(s) ? s : [typeof s === 'number' ? s : 0, DOC_COLUMNS[key]];
    return { key, label, show: s !== undefined && s !== false, width };
  });

const TICKET_BASE: Omit<DocTemplate, 'id' | 'variant' | 'name'> = {
  doc: 'invoice',
  format: 'ticket',
  builtin: true,
  page: { paper: '80mm', landscape: false, margin: 4, font: 'mono', fontSize: 11, headerHeight: 0, footerHeight: 0, lineHeight: 0, copies: 1, borders: false },
  header: { logo: true, logoSize: 25, logoAlign: 'center', storeName: true, address: true, phone: true, niu: true, rccm: true, message: '' },
  customer: { show: true, code: false, address: false, phone: false, niu: false, balance: false },
  info: { title: '', number: true, date: true, time: true, seller: true, register: false, priceLevel: true, dueDate: true },
  columns: cols({ label: 0, qty: 0, unitPrice: 0, discount: 0, totalTtc: 0 }),
  totals: { ht: false, vatDetail: true, discount: false, promo: true, rounding: true, payments: true, change: true, remaining: false, words: false },
  footer: { text: '', thanks: '', signatures: false, signLeft: 'Le client', signRight: '', duplicate: true },
};

const A4_BASE: Omit<DocTemplate, 'id' | 'variant' | 'name'> = {
  doc: 'invoice',
  format: 'a4',
  builtin: true,
  page: { paper: 'A4', landscape: false, margin: 15, font: 'sans', fontSize: 12, headerHeight: 0, footerHeight: 0, lineHeight: 0, copies: 1, borders: true },
  header: { logo: true, logoSize: 22, logoAlign: 'left', storeName: true, address: true, phone: true, niu: true, rccm: true, message: '' },
  customer: { show: true, code: true, address: true, phone: true, niu: true, balance: false },
  info: { title: 'Facture', number: true, date: true, time: false, seller: true, register: false, priceLevel: false, dueDate: true },
  columns: cols({ label: 0, qty: 10, unitPrice: 12, discount: 9, vat: 9, totalHt: 12, totalTtc: 13 }),
  totals: { ht: true, vatDetail: true, discount: false, promo: false, rounding: false, payments: true, change: false, remaining: false, words: false },
  footer: { text: '', thanks: '', signatures: true, signLeft: 'Le client', signRight: 'Pour {magasin}', duplicate: true },
};

const LISTING_BASE: Omit<DocTemplate, 'id' | 'variant' | 'name'> = {
  ...A4_BASE,
  format: 'listing',
  page: { paper: 'A4', landscape: false, margin: 10, font: 'mono', fontSize: 10, headerHeight: 0, footerHeight: 0, lineHeight: 0, copies: 1, borders: false },
  header: { ...A4_BASE.header, logo: false },
  customer: { show: true, code: true, address: false, phone: true, niu: true, balance: false },
  columns: cols({ code: 12, label: 0, qty: 11, unitPrice: 12, discount: 10, totalTtc: 13 }),
  totals: { ht: true, vatDetail: true, discount: true, promo: false, rounding: false, payments: true, change: false, remaining: false, words: false },
};

/** Modèles livrés avec le logiciel, un par emplacement. */
export const BUILTIN_TEMPLATES: DocTemplate[] = [
  { ...TICKET_BASE, id: 'invoice-ticket-cash', variant: 'cash', name: 'Ticket comptant' },
  {
    ...TICKET_BASE,
    id: 'invoice-ticket-credit',
    variant: 'credit',
    name: 'Ticket à terme',
    customer: { show: true, code: true, address: false, phone: true, niu: false, balance: true },
    info: { ...TICKET_BASE.info, title: 'FACTURE À TERME' },
    totals: { ...TICKET_BASE.totals, remaining: true },
    footer: { ...TICKET_BASE.footer, signatures: true },
  },
  { ...A4_BASE, id: 'invoice-a4-cash', variant: 'cash', name: 'Facture A4 comptant' },
  {
    ...A4_BASE,
    id: 'invoice-a4-credit',
    variant: 'credit',
    name: 'Facture A4 à terme',
    customer: { ...A4_BASE.customer, balance: true },
    info: { ...A4_BASE.info, title: 'Facture à terme' },
    totals: { ...A4_BASE.totals, remaining: true, words: true },
  },
  { ...LISTING_BASE, id: 'invoice-listing-cash', variant: 'cash', name: 'Facture listing comptant' },
  {
    ...LISTING_BASE,
    id: 'invoice-listing-credit',
    variant: 'credit',
    name: 'Facture listing à terme',
    info: { ...LISTING_BASE.info, title: 'Facture à terme' },
    customer: { ...LISTING_BASE.customer, balance: true },
    totals: { ...LISTING_BASE.totals, remaining: true, words: true },
  },
];

const builtinFor = (doc: DocKind, format: DocFormat, variant: DocVariant) =>
  BUILTIN_TEMPLATES.find((t) => t.doc === doc && t.format === format && t.variant === variant)!;

/** Modèles du magasin : ceux du logiciel (ou leur version modifiée), puis ceux ajoutés. */
export function effectiveTemplates(stored: readonly DocTemplate[] | null | undefined): DocTemplate[] {
  const byId = new Map((stored ?? []).map((t) => [t.id, t]));
  return [...BUILTIN_TEMPLATES.map((b) => byId.get(b.id) ?? b), ...(stored ?? []).filter((t) => !BUILTIN_TEMPLATES.some((b) => b.id === t.id))];
}

/**
 * Modèle à utiliser : celui demandé s'il convient, sinon celui choisi par
 * défaut pour l'emplacement, sinon celui du logiciel.
 */
export function resolveTemplate(
  settings: { printTemplates?: readonly DocTemplate[]; printDefaults?: Readonly<Record<string, string>> },
  doc: DocKind,
  format: DocFormat | null,
  variant: DocVariant,
  id?: string | null,
): DocTemplate {
  const all = effectiveTemplates(settings.printTemplates);
  if (id) {
    const t = all.find((x) => x.id === id && x.doc === doc);
    if (t) return t;
  }
  const f = format ?? 'a4';
  const want = settings.printDefaults?.[slotKey(doc, f, variant)];
  return all.find((x) => x.id === want && x.doc === doc && x.format === f && x.variant === variant) ?? all.find((x) => x.id === builtinFor(doc, f, variant).id)!;
}

// --- Contrôle des modèles enregistrés -----------------------------------------

const clamp = (v: unknown, min: number, max: number, def: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : def;
};
const str = (v: unknown, max: number, def = '') => (typeof v === 'string' ? v.slice(0, max) : def);
const bool = (v: unknown, def: boolean) => (typeof v === 'boolean' ? v : def);
const pick = <T extends string>(v: unknown, allowed: readonly T[], def: T): T => (allowed.includes(v as T) ? (v as T) : def);
function bools<T extends Record<string, unknown>>(raw: unknown, def: T): T {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out = { ...def } as Record<string, unknown>;
  for (const [k, d] of Object.entries(def)) {
    if (typeof d === 'boolean') out[k] = bool(r[k], d);
    else if (typeof d === 'string') out[k] = str(r[k], 300, d);
  }
  return out as T;
}

/** Modèle complété et borné : un champ manquant ou faux prend la valeur du modèle du logiciel. */
export function normalizeTemplate(raw: unknown): DocTemplate {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<DocTemplate> & Record<string, unknown>;
  const doc = pick(r.doc, Object.keys(DOC_KINDS) as DocKind[], 'invoice');
  const format = pick(r.format, Object.keys(DOC_FORMATS) as DocFormat[], 'a4');
  const variant = pick(r.variant, Object.keys(DOC_VARIANTS) as DocVariant[], 'cash');
  const base = builtinFor(doc, format, variant);
  const id = str(r.id, 60).trim();
  if (!/^[\w-]{1,60}$/.test(id)) throw new Error('Modèle : identifiant invalide');
  const name = str(r.name, 60).trim();
  if (!name) throw new Error('Donnez un nom au modèle');
  const p = (r.page ?? {}) as Partial<DocTemplate['page']>;
  const h = (r.header ?? {}) as Partial<DocTemplate['header']>;
  const rawCols = Array.isArray(r.columns) ? (r.columns as Partial<DocColumn>[]) : [];
  const seen = new Set<DocColumnKey>();
  const columns: DocColumn[] = [];
  for (const c of rawCols) {
    if (!c || !COLUMN_KEYS.includes(c.key as DocColumnKey) || seen.has(c.key as DocColumnKey)) continue;
    const key = c.key as DocColumnKey;
    seen.add(key);
    columns.push({ key, label: str(c.label, 40, DOC_COLUMNS[key]), show: bool(c.show, false), width: clamp(c.width, 0, 100, 0) });
  }
  for (const c of base.columns) if (!seen.has(c.key)) columns.push({ ...c, show: rawCols.length ? false : c.show });
  if (!columns.some((c) => c.show)) throw new Error('Gardez au moins une colonne dans le tableau');
  return {
    id,
    doc,
    format,
    variant,
    name,
    builtin: BUILTIN_TEMPLATES.some((b) => b.id === id),
    page: {
      paper: pick(p.paper, Object.keys(DOC_PAPERS) as DocPaper[], base.page.paper),
      landscape: bool(p.landscape, base.page.landscape),
      margin: clamp(p.margin, 0, 40, base.page.margin),
      font: pick(p.font, Object.keys(DOC_FONTS) as DocFont[], base.page.font),
      fontSize: clamp(p.fontSize, 7, 20, base.page.fontSize),
      headerHeight: clamp(p.headerHeight, 0, 150, 0),
      footerHeight: clamp(p.footerHeight, 0, 150, 0),
      lineHeight: clamp(p.lineHeight, 0, 30, 0),
      copies: clamp(p.copies, 1, 5, 1),
      borders: bool(p.borders, base.page.borders),
    },
    header: {
      ...bools(h, base.header),
      logoSize: clamp(h.logoSize, 5, 60, base.header.logoSize),
      logoAlign: pick(h.logoAlign, ['left', 'center', 'right'] as const, base.header.logoAlign),
    },
    customer: bools(r.customer, base.customer),
    info: bools(r.info, base.info),
    columns,
    totals: bools(r.totals, base.totals),
    footer: bools(r.footer, base.footer),
  };
}

/** Modèles du magasin contrôlés (identifiants uniques). */
export function normalizeTemplates(raw: unknown): DocTemplate[] {
  if (!Array.isArray(raw)) throw new Error('Modèles d’impression : liste attendue');
  if (raw.length > 60) throw new Error('60 modèles d’impression au plus');
  const list = raw.map(normalizeTemplate);
  if (new Set(list.map((t) => t.id)).size !== list.length) throw new Error('Deux modèles portent le même identifiant');
  return list;
}

/** Modèles par défaut : emplacement → identifiant de modèle. */
export function normalizeDefaults(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Modèles par défaut invalides');
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!/^[a-z]+\.[a-z0-9]+\.[a-z]+$/.test(k) || typeof v !== 'string' || !/^[\w-]{1,60}$/.test(v)) continue;
    out[k] = v;
  }
  return out;
}

// --- Rendu -----------------------------------------------------------------

const money = (v: number) => formatFcfa(v, false);
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const dayFr = (iso: string) => new Date(iso.length <= 10 ? `${iso}T12:00:00` : iso).toLocaleDateString('fr-FR', { timeZone: 'Africa/Douala' });
const dateTimeFr = (iso: string) =>
  new Date(iso).toLocaleString('fr-FR', { timeZone: 'Africa/Douala', dateStyle: 'short', timeStyle: 'short' });

/** Magasin sans TVA : ni colonne ni total de TVA, et « Total » au lieu de « Total TTC ». */
export const docWithoutVat = (d: DocData) => !d.store.vatEnabled && d.lines.every((l) => l.vatRate === 0);
const tx = (label: string, noVat: boolean) => (noVat ? label.replace(/\s*\b(?:HT|TTC)\b/g, '') : label);

/** Textes libres : {magasin}, {client}, {numero}, {date}, {echeance}. */
function fill(text: string, d: DocData): string {
  return text
    .replace(/\{magasin\}/g, d.store.name)
    .replace(/\{client\}/g, d.customer?.name ?? '')
    .replace(/\{numero\}/g, d.doc.number)
    .replace(/\{date\}/g, dayFr(d.doc.date))
    .replace(/\{echeance\}/g, d.doc.dueDate ? dayFr(d.doc.dueDate) : '');
}

function vatByRate(d: DocData) {
  const byRate = new Map<number, number>();
  for (const l of d.lines) byRate.set(l.vatRate, (byRate.get(l.vatRate) ?? 0) + l.totalTtc);
  return [...byRate.entries()].map(([rate, ttc]) => ({ rate, ttc, tva: splitTtc(ttc, rate).tva }));
}

const shown = (t: DocTemplate, d: DocData) => {
  const noVat = docWithoutVat(d);
  return t.columns.filter((c) => c.show && !(noVat && (c.key === 'vat' || c.key === 'totalHt' || c.key === 'unitPriceHt')));
};

/** Ticket de caisse selon le modèle : la même description sert au pilote Windows et à l'ESC/POS. */
export function renderDocTicket(t: DocTemplate, d: DocData): Receipt {
  const r: Receipt = [];
  const noVat = docWithoutVat(d);
  const centered = (text: string): ReceiptLine => ({ t: 'text', text, align: 'center' });
  const lines = (text: string) => fill(text, d).split('\n').map((s) => s.trim()).filter(Boolean);
  const h = t.header;
  if (h.logo && d.store.logo) r.push({ t: 'image', src: d.store.logo });
  if (h.storeName) r.push({ t: 'text', text: d.store.name, align: 'center', bold: true, big: true });
  for (const m of [...lines(d.store.message), ...lines(h.message)]) r.push(centered(m));
  if (h.address && d.store.address) r.push(centered(d.store.address));
  if (h.phone && d.store.phone) r.push(centered(d.store.phone));
  if (h.niu && d.store.niu) r.push(centered(`NIU : ${d.store.niu}`));
  if (h.rccm && d.store.rccm) r.push(centered(`RCCM : ${d.store.rccm}`));
  if (r.length) r.push({ t: 'rule' });

  const title = d.doc.kind === 'return' ? 'RETOUR CLIENT' : fill(t.info.title, d);
  if (title) r.push({ t: 'text', text: title, bold: true });
  if (d.doc.cancelled) r.push({ t: 'text', text: 'ANNULÉ', bold: true });
  if (d.doc.duplicate && t.footer.duplicate) r.push({ t: 'text', text: 'DUPLICATA', bold: true });
  if (t.info.number) r.push({ t: 'text', text: `${title ? 'N°' : 'Ticket'} ${d.doc.number}` });
  const when = t.info.date ? (t.info.time ? dateTimeFr(d.doc.date) : dayFr(d.doc.date)) : '';
  const meta = [when, t.info.seller ? d.doc.seller : '', t.info.register ? (d.doc.register ?? '') : ''].filter(Boolean).join(' · ');
  if (meta) r.push({ t: 'text', text: meta });
  const c = d.customer;
  if (t.customer.show && c) {
    r.push({ t: 'text', text: `Client : ${c.name}` });
    if (t.customer.code && c.code) r.push({ t: 'text', text: `Compte : ${c.code}` });
    if (t.customer.phone && c.phone) r.push({ t: 'text', text: `Tél. : ${c.phone}` });
    if (t.customer.address && c.address) r.push({ t: 'text', text: c.address });
    if (t.customer.niu && c.niu) r.push({ t: 'text', text: `NIU : ${c.niu}` });
  }
  if (t.info.priceLevel && d.doc.priceLevel) r.push({ t: 'text', text: `Tarif : ${d.doc.priceLevel}` });
  r.push({ t: 'rule' });

  const on = new Set(shown(t, d).map((x) => x.key));
  for (const l of d.lines) {
    const left = [on.has('line') ? `${d.lines.indexOf(l) + 1}.` : '', on.has('code') && l.code ? l.code : '', l.label].filter(Boolean).join(' ');
    r.push({ t: 'row', left, right: on.has('totalTtc') ? money(l.totalTtc + l.promo) : on.has('totalHt') ? money(l.totalHt) : '' });
    const qty = `${l.qty}${l.unit ? ` ${l.unit}` : ''}`;
    const parts = [
      on.has('qty') || on.has('unitPrice') ? `${qty} x ${money(on.has('unitPrice') || !on.has('unitPriceHt') ? l.unitPrice : l.unitPriceHt)}` : '',
      on.has('discount') && l.discount ? `(remise ${money(l.discount)})` : '',
      on.has('vat') ? `TVA ${formatRate(l.vatRate)}` : '',
    ].filter(Boolean);
    if (parts.length && (l.detail || (on.has('discount') && l.discount) || on.has('vat'))) r.push({ t: 'row', left: parts.join(' '), right: '', indent: 2 });
    if (on.has('barcode') && l.barcode) r.push({ t: 'row', left: l.barcode, right: '', indent: 2 });
    if (t.totals.promo && l.promo) r.push({ t: 'row', left: `Promo ${l.promoName ?? ''}`.trim(), right: `-${money(l.promo)}`, indent: 2 });
  }
  r.push({ t: 'rule' });
  const tot = d.totals;
  if (t.totals.ht && !noVat) r.push({ t: 'row', left: 'Total HT', right: money(tot.ht) });
  if (t.totals.discount && tot.discount) r.push({ t: 'row', left: 'Remises', right: money(tot.discount) });
  r.push({ t: 'row', left: 'TOTAL FCFA', right: money(tot.ttc), bold: true, big: true });
  if (t.totals.rounding && tot.rounding) r.push({ t: 'row', left: 'dont arrondi espèces', right: `-${money(tot.rounding)}`, indent: 2 });
  if (t.totals.promo && tot.promo > 0) r.push({ t: 'row', left: 'Vous avez économisé', right: money(tot.promo), bold: true });
  if (t.totals.payments) for (const p of d.payments) r.push({ t: 'row', left: p.label, right: money(p.amount) });
  if (t.totals.change && tot.change) r.push({ t: 'row', left: 'Rendu monnaie', right: money(tot.change), bold: true });
  if (t.totals.remaining && tot.remaining) r.push({ t: 'row', left: 'Reste à payer', right: money(tot.remaining), bold: true });
  if (t.customer.show && t.customer.balance && c?.balance != null) r.push({ t: 'row', left: 'Solde de votre compte', right: money(c.balance) });
  if (t.info.dueDate && d.doc.dueDate) r.push({ t: 'text', text: `À régler avant le ${dayFr(d.doc.dueDate)}` });
  if (t.totals.words && tot.ttc >= 0) r.push({ t: 'text', text: `Arrêté à la somme de ${numberToWordsFr(tot.ttc)} francs CFA` });
  if (t.totals.vatDetail) {
    r.push({ t: 'rule' });
    if (noVat) r.push(centered('TVA non applicable'));
    else {
      for (const v of vatByRate(d)) r.push({ t: 'row', left: `TVA ${formatRate(v.rate)} sur ${money(v.ttc)}`, right: money(v.tva) });
      r.push({ t: 'row', left: 'dont TVA', right: money(tot.tva) });
    }
  }
  if (t.footer.signatures) {
    r.push({ t: 'feed' });
    for (const s of [t.footer.signLeft, t.footer.signRight].map((x) => fill(x, d).trim()).filter(Boolean)) r.push({ t: 'text', text: `${s} :` }, { t: 'feed' }, { t: 'feed' });
  }
  const bottom = [...lines(t.footer.text), ...lines(t.footer.thanks || d.store.thanks)];
  if (bottom.length) r.push({ t: 'rule' }, ...bottom.map(centered));
  return r;
}

/** Rendu HTML d'un ticket (pilote Windows et aperçu). */
export function receiptToHtml(receipt: Receipt): string {
  return receipt
    .map((l) => {
      if (l.t === 'rule') return '<hr>';
      if (l.t === 'feed') return '<br>';
      if (l.t === 'image') return `<div class="c"><img src="${esc(l.src)}" style="max-width:60%;max-height:30mm"></div>`;
      const cls = [l.bold ? 'b' : '', l.big ? 'big' : ''];
      if (l.t === 'text') return `<div class="${[...cls, l.align === 'center' ? 'c' : l.align === 'right' ? 'r' : ''].join(' ').trim()}">${esc(l.text)}</div>`;
      const pad = l.indent ? ` style="padding-left:${l.indent}ch"` : '';
      return `<div class="row ${cls.join(' ').trim()}"><span${pad}>${esc(l.left)}</span><span>${esc(l.right)}</span></div>`;
    })
    .join('\n');
}

const FONTS: Record<DocFont, string> = {
  sans: "'Segoe UI', Arial, sans-serif",
  serif: "'Times New Roman', Georgia, serif",
  mono: "Consolas, 'Courier New', monospace",
};
const PAPER_MM: Record<DocPaper, [number, number]> = { '80mm': [80, 0], '58mm': [58, 0], A4: [210, 297], A5: [148, 210] };

/** Dimensions de la page en mm (largeur, hauteur ; hauteur 0 : rouleau). */
export function pageSize(t: DocTemplate): { width: number; height: number } {
  const [w, h] = PAPER_MM[t.page.paper];
  return t.page.landscape && h ? { width: h, height: w } : { width: w, height: h };
}

function pageCss(t: DocTemplate): string {
  const { width, height } = pageSize(t);
  const m = t.page.margin;
  return `
  @page { size: ${height ? `${width}mm ${height}mm` : `${width}mm auto`}; margin: ${height ? `${m}mm` : '0'}; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body { font: ${t.page.fontSize}px/1.35 ${FONTS[t.page.font]}; color: #111; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .sheet { ${height ? '' : `width: ${width}mm; padding: 0 ${m}mm;`} }
  @media screen {
    html { background: #8a8f98; }
    body { padding: 16px 0; }
    .sheet { background: #fff; margin: 0 auto; box-shadow: 0 2px 10px rgba(0,0,0,.35); width: ${width}mm; padding: ${height ? `${m}mm` : `3mm ${m}mm`}; ${height ? `min-height: ${height}mm;` : ''} }
  }`;
}

const TICKET_CSS = `
  .c { text-align: center; } .r { text-align: right; } .b { font-weight: bold; }
  hr { border: 0; border-top: 1px dashed #000; margin: 4px 0; }
  .big { font-size: 1.35em; font-weight: bold; }
  .row { display: flex; justify-content: space-between; gap: 6px; }
  .row span:last-child { white-space: nowrap; }
  img { display: inline-block; }
`;

function documentCss(t: DocTemplate): string {
  const listing = t.format === 'listing';
  const b = t.page.borders;
  return `
  h1 { font-size: 1.6em; margin: 0 0 2px; }
  h2 { font-size: 1.45em; margin: 10px 0 2px; }
  .head { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; ${t.page.headerHeight ? `min-height: ${t.page.headerHeight}mm;` : ''} }
  .store { display: flex; gap: 10px; align-items: flex-start; }
  .logo { text-align: ${t.header.logoAlign}; }
  .logo img, .store img { height: ${t.header.logoSize}mm; width: auto; }
  .box { border: 1px solid #999; padding: 6px 10px; min-width: 38%; }
  .muted { color: #555; }
  .meta { margin-bottom: 6px; }
  table { width: 100%; border-collapse: collapse; }
  table.lines { table-layout: fixed; margin-top: 6px; }
  table.lines th, table.lines td { padding: ${listing ? '1px 4px' : '4px 6px'}; text-align: left; vertical-align: top; overflow-wrap: anywhere; ${b ? 'border: 1px solid #bbb;' : ''} }
  table.lines th { ${b ? 'background: #e8eef7;' : 'border-bottom: 1px solid #000;'} font-weight: bold; }
  ${listing && !b ? 'table.lines tbody tr td { border-bottom: 1px dotted #bbb; }' : ''}
  ${t.page.lineHeight ? `table.lines tbody td { height: ${t.page.lineHeight}mm; }` : ''}
  table.lines thead { display: table-header-group; }
  .r { text-align: right !important; }
  .bottom { display: flex; justify-content: space-between; gap: 16px; margin-top: 8px; break-inside: avoid; }
  .bottom .left { flex: 1; }
  table.totals { width: 45%; }
  table.totals td { padding: 2px 6px; ${b ? 'border: 1px solid #bbb;' : ''} }
  table.totals tr.total td { font-weight: bold; ${b ? 'background: #e8eef7;' : 'border-top: 1px solid #000;'} }
  .dup { font-weight: bold; letter-spacing: 2px; color: #a00; }
  footer { margin-top: 14px; break-inside: avoid; ${t.page.footerHeight ? `min-height: ${t.page.footerHeight}mm;` : ''} }
  .sign { margin-top: 10px; display: flex; justify-content: space-between; min-height: 22mm; }
  .notes { white-space: pre-line; }
  .thanks { text-align: center; margin-top: 10px; }
  `;
}

const nl = (s: string) => esc(s).replace(/\n/g, '<br>');

/** Page HTML complète d'une facture selon son modèle : imprimée telle quelle et affichée en aperçu. */
export function renderDocHtml(t: DocTemplate, d: DocData): string {
  const wrap = (css: string, body: string) =>
    `<!doctype html><html><head><meta charset="utf-8"><style>${pageCss(t)}${css}</style></head><body><div class="sheet">${body}</div></body></html>`;
  if (t.format === 'ticket') return wrap(`${TICKET_CSS} .c img { max-height: ${t.header.logoSize}mm !important; }`, receiptToHtml(renderDocTicket(t, d)));

  const noVat = docWithoutVat(d);
  const h = t.header;
  const logo = h.logo && d.store.logo ? `<img src="${esc(d.store.logo)}" alt="">` : '';
  const ident = [
    h.storeName ? `<h1>${esc(d.store.name)}</h1>` : '',
    [h.address ? d.store.address : null, h.phone ? d.store.phone : null, h.niu && d.store.niu ? `NIU ${d.store.niu}` : null, h.rccm && d.store.rccm ? `RCCM ${d.store.rccm}` : null]
      .filter(Boolean)
      .map((v) => esc(v!))
      .join('<br>'),
    h.message ? `<div class="notes">${nl(fill(h.message, d))}</div>` : '',
  ].join('');
  const c = d.customer;
  const cu = t.customer;
  const client = !cu.show
    ? ''
    : `<div class="box">${
        c && !c.counter
          ? `<b>${esc(c.name)}</b><br>${[cu.address ? c.address : null, cu.phone ? c.phone : null, cu.niu && c.niu ? `NIU ${c.niu}` : null, cu.code && c.code ? `Compte ${c.code}` : null]
              .filter(Boolean)
              .map((v) => esc(v!))
              .join('<br>')}${cu.balance && c.balance != null ? `<br>Solde du compte : <b>${money(c.balance)} FCFA</b>` : ''}`
          : c
            ? `<b>${esc(c.name)}</b><br>Client comptoir`
            : '<b>Client comptoir</b>'
      }</div>`;
  const head =
    h.logoAlign === 'left'
      ? `<div class="head"><div class="store">${logo}<div>${ident}</div></div>${client}</div>`
      : `${logo ? `<div class="logo">${logo}</div>` : ''}<div class="head"><div class="store"><div>${ident}</div></div>${client}</div>`;

  const title = d.doc.kind === 'return' ? 'Avoir' : fill(t.info.title, d);
  const titleLine = `<h2>${esc(title)}${t.info.number ? ` ${esc(d.doc.number)}` : ''}${d.doc.cancelled ? ' (annulée)' : ''}${
    d.doc.duplicate && t.footer.duplicate ? ' <span class="dup">DUPLICATA</span>' : ''
  }</h2>`;
  const meta = [
    t.info.date ? `Date : ${t.info.time ? dateTimeFr(d.doc.date) : dayFr(d.doc.date)}` : '',
    t.info.dueDate && d.doc.dueDate ? `Échéance : ${dayFr(d.doc.dueDate)}` : '',
    t.info.seller ? `Vendeur : ${esc(d.doc.seller)}` : '',
    t.info.register && d.doc.register ? `Caisse : ${esc(d.doc.register)}` : '',
    t.info.priceLevel && d.doc.priceLevel ? `Tarif : ${esc(d.doc.priceLevel)}` : '',
  ].filter(Boolean);

  const columns = shown(t, d);
  const showUnit = columns.some((x) => x.key === 'unit');
  const cell = (key: DocColumnKey, l: DocLine, i: number): string => {
    switch (key) {
      case 'line': return String(i + 1);
      case 'code': return esc(l.code ?? '');
      case 'barcode': return esc(l.barcode ?? '');
      case 'label': return esc(l.label);
      case 'qty': return esc(`${l.qty}${!showUnit && l.unit ? ` ${l.unit}` : ''}`);
      case 'unit': return esc(l.unit);
      case 'unitPrice': return money(l.unitPrice);
      case 'unitPriceHt': return money(l.unitPriceHt);
      case 'discount': return l.discount ? money(l.discount) : '';
      case 'vat': return formatRate(l.vatRate);
      case 'totalHt': return money(l.totalHt);
      case 'totalTtc': return money(l.totalTtc);
    }
  };
  const right = (k: DocColumnKey) => (NUMERIC_COLUMNS.includes(k) ? ' class="r"' : '');
  const table = `<table class="lines"><colgroup>${columns.map((x) => `<col${x.width ? ` style="width:${x.width}%"` : ''}>`).join('')}</colgroup>
    <thead><tr>${columns.map((x) => `<th${right(x.key)}>${esc(tx(x.label, noVat))}</th>`).join('')}</tr></thead>
    <tbody>${d.lines.map((l, i) => `<tr>${columns.map((x) => `<td${right(x.key)}>${cell(x.key, l, i)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;

  const tot = d.totals;
  const row = (label: string, v: number, cls = '') => `<tr${cls ? ` class="${cls}"` : ''}><td>${label}</td><td class="r">${money(v)}</td></tr>`;
  const totals = [
    t.totals.ht && !noVat ? row('Total HT', tot.ht) : '',
    t.totals.vatDetail && !noVat ? vatByRate(d).filter((v) => v.rate > 0).map((v) => row(`TVA ${formatRate(v.rate)}`, v.tva)).join('') : '',
    t.totals.discount && tot.discount ? row('Remises accordées', tot.discount) : '',
    t.totals.promo && tot.promo ? row('Promotions', tot.promo) : '',
    t.totals.rounding && tot.rounding ? row('Arrondi espèces', -tot.rounding) : '',
    row(noVat ? 'Total (FCFA)' : 'Total TTC (FCFA)', tot.ttc, 'total'),
    t.totals.payments ? d.payments.map((p) => row(esc(p.label), p.amount)).join('') : '',
    t.totals.change && tot.change ? row('Rendu monnaie', tot.change) : '',
    t.totals.remaining && tot.remaining ? row('Reste à payer', tot.remaining, 'total') : '',
  ].join('');
  const left = [
    t.totals.words && tot.ttc >= 0 ? `<p>Arrêté à la somme de <b>${esc(numberToWordsFr(tot.ttc))} francs CFA</b>${noVat ? '' : ' toutes taxes comprises'}.</p>` : '',
    t.totals.vatDetail && noVat ? '<p class="muted">TVA non applicable.</p>' : '',
  ].join('');
  const footer = [
    t.footer.text ? `<div class="notes">${nl(fill(t.footer.text, d))}</div>` : '',
    t.footer.signatures ? `<div class="sign"><div>${nl(fill(t.footer.signLeft, d))}</div><div>${nl(fill(t.footer.signRight, d))}</div></div>` : '',
    t.footer.thanks ? `<div class="thanks">${nl(fill(t.footer.thanks, d))}</div>` : '',
  ].join('');

  return wrap(
    documentCss(t),
    `${head}${titleLine}${meta.length ? `<div class="meta">${meta.join(' · ')}</div>` : ''}${table}
    <div class="bottom"><div class="left">${left}</div><table class="totals">${totals}</table></div>
    ${footer ? `<footer>${footer}</footer>` : ''}`,
  );
}

/** Facture d'exemple pour l'aperçu d'un modèle quand le magasin n'a pas encore vendu. */
export function sampleDocData(variant: DocVariant, store?: Partial<DocData['store']>): DocData {
  const credit = variant === 'credit';
  const line = (code: string, label: string, qty: number, unit: string, unitPrice: number, vatRate: number, discount = 0): DocLine => {
    const totalTtc = qty * unitPrice - discount;
    const totalHt = splitTtc(totalTtc, vatRate).ht;
    return { code, barcode: `61${code.replace(/\D/g, '').padStart(11, '0')}`, label, qty: String(qty), unit, unitPrice, unitPriceHt: splitTtc(unitPrice, vatRate).ht, discount, vatRate, totalHt, totalTtc, promo: 0, promoName: null, detail: qty !== 1 || Boolean(unit) };
  };
  const lines = [
    line('BOI012', 'Bière Castel 65 cl', 2, 'CASIER', 7800, 1925),
    line('RIZ005', "Riz parfumé Uncle Ben's 5 kg", 3, '', 4500, 0, 500),
    line('HUI010', 'Huile Diamaor 1 L', 1, '', 1350, 1925),
  ];
  const ttc = lines.reduce((s, l) => s + l.totalTtc, 0);
  const ht = lines.reduce((s, l) => s + l.totalHt, 0);
  const paid = credit ? 10000 : ttc + 650;
  return {
    store: { name: 'Mon magasin', address: 'Rue principale, Douala', phone: '6 99 00 00 00', niu: 'M000000000000A', rccm: '', logo: '', message: '', thanks: 'Merci de votre visite !', vatEnabled: true, ...store },
    customer: credit
      ? { name: 'Ets MBALLA & Fils', code: 'C0012', address: 'Marché central, Douala', phone: '6 77 12 34 56', niu: 'P123456789012B', balance: 245000, counter: false }
      : null,
    doc: { kind: 'sale', number: 'DLA1-1-000123', date: new Date().toISOString(), dueDate: credit ? new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10) : null, seller: 'Awa', register: 'Caisse 1', priceLevel: credit ? 'Gros' : null, cancelled: false, duplicate: false },
    lines,
    payments: credit ? [{ label: 'Espèces', amount: 10000 }, { label: 'Crédit client', amount: ttc - 10000 }] : [{ label: 'Espèces', amount: paid }],
    totals: { ht, tva: ttc - ht, ttc, discount: 500, promo: 0, rounding: 0, change: credit ? 0 : paid - ttc, remaining: credit ? ttc - 10000 : 0 },
  };
}
