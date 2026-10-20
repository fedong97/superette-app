/**
 * Modèles d'impression des documents, comme les « variantes des états » de
 * Pour chaque document (facture client…), chaque
 * format (ticket de caisse, A4, listing) et chaque variante (comptant, à
 * terme), un ou plusieurs modèles réglables champ par champ.
 *
 * Les modèles livrés avec le logiciel sont décrits ici ; le magasin garde
 * dans ses paramètres ses modèles modifiés ou ajoutés, et le modèle choisi
 * par défaut pour chaque emplacement. Le rendu est pur (sans base ni
 * Electron) : le même code imprime et affiche l'aperçu.
 */
import { isHexColor, mixColors } from './brand';
import { formatFcfa } from './money';
import { formatRate, splitTtc } from './tax';
import { numberToWordsFr } from './words';
import type { Receipt, ReceiptLine } from './escpos';

export const DOC_KINDS = {
  invoice: 'Facture client',
  quote: 'Devis et proforma',
  delivery: 'Bon de livraison',
  purchaseOrder: 'Bon de commande',
  purchaseInvoice: 'Facture d’achat',
} as const;
export type DocKind = keyof typeof DOC_KINDS;
export const DOC_FORMATS = { ticket: 'Ticket de caisse', a4: 'A4', listing: 'Listing' } as const;
export type DocFormat = keyof typeof DOC_FORMATS;
export const DOC_VARIANTS = {
  cash: 'Comptant',
  credit: 'À terme',
  quote: 'Devis',
  proforma: 'Proforma',
  delivery: 'Bon de livraison',
  order: 'Commande fournisseur',
  supplierInvoice: 'Facture fournisseur',
} as const;
export type DocVariant = keyof typeof DOC_VARIANTS;
/** Variantes de chaque document. */
export const DOC_KIND_VARIANTS: Record<DocKind, DocVariant[]> = {
  invoice: ['cash', 'credit'],
  quote: ['quote', 'proforma'],
  delivery: ['delivery'],
  purchaseOrder: ['order'],
  purchaseInvoice: ['supplierInvoice'],
};
export const DOC_PAPERS = { '80mm': 'Rouleau 80 mm', '58mm': 'Rouleau 58 mm', A4: 'A4', A5: 'A5', listing: 'Listing 240 mm (hauteur selon le contenu)' } as const;
export type DocPaper = keyof typeof DOC_PAPERS;
export const DOC_FONTS = { sans: 'Arial (sans empattement)', serif: 'Times (avec empattement)', mono: 'Courier (machine à écrire)' } as const;
export type DocFont = keyof typeof DOC_FONTS;
/**
 * Disposition d'un modèle. Ticket : simple, encadré (nom du produit sur sa ligne,
 * puis QTE / COND. / P.U. / TOTAL) ou détaillé (colonne code, détail HT, TVA,
 * colis, TTC). A4 et listing : simple, listing avec logo ou listing sans logo
 * (cadre, cases DATE / CLIENT / RÉF., montant en lettres, NB COLIS, NET À PAYER).
 */
export const DOC_STYLES = {
  plain: 'Simple',
  boxed: 'Ticket encadré',
  detailed: 'Ticket détaillé (code et taxes)',
  framed: 'Listing avec logo',
  side: 'Listing sans logo',
} as const;
export type DocStyle = keyof typeof DOC_STYLES;
/** Dispositions possibles pour un format. */
export const stylesFor = (format: DocFormat): DocStyle[] => (format === 'ticket' ? ['plain', 'boxed', 'detailed'] : ['plain', 'framed', 'side']);

/** Colonnes possibles du tableau des articles, avec leur titre par défaut. */
export const DOC_COLUMNS = {
  line: 'N°',
  supplierRef: 'Réf. fournisseur',
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
  freeQty: 'Gratuits',
  netCost: 'Coût net',
} as const;
export type DocColumnKey = keyof typeof DOC_COLUMNS;
const COLUMN_KEYS = Object.keys(DOC_COLUMNS) as DocColumnKey[];
const NUMERIC_COLUMNS: DocColumnKey[] = ['qty', 'unitPrice', 'unitPriceHt', 'discount', 'vat', 'totalHt', 'totalTtc', 'freeQty', 'netCost'];

export interface DocColumn {
  key: DocColumnKey;
  /** Titre imprimé en tête de colonne. */
  label: string;
  show: boolean;
  /** Largeur en % du tableau (A4 et listing) ; 0 : le reste de la place. */
  width: number;
  /** Alignement du contenu ; absent : texte à gauche, nombres à droite. */
  align?: DocAlign;
}

export type DocAlign = 'left' | 'center' | 'right';
export const DOC_ALIGNS: DocAlign[] = ['left', 'center', 'right'];

/** Lignes qui se placent une à une à gauche, au centre ou à droite. */
export const DOC_LINES = {
  storeName: 'Nom du magasin',
  message: 'Message d’en-tête',
  address: 'Adresse',
  phone: 'Téléphone',
  niu: 'NIU et RCCM',
  number: 'Titre et numéro',
  seller: 'Date, vendeur, caisse',
  customer: 'Client',
  words: 'Montant en lettres',
  footerText: 'Mentions',
  thanks: 'Remerciement',
} as const;
export type DocLineKey = keyof typeof DOC_LINES;
const LINE_KEYS = Object.keys(DOC_LINES) as DocLineKey[];

/** Sections d'un document, dans l'ordre par défaut. */
export const DOC_SECTIONS = {
  header: 'En-tête : le magasin',
  title: 'Titre, numéro, date et client',
  lines: 'Articles',
  totals: 'Totaux',
  payments: 'Règlement, rendu et montant en lettres',
  footer: 'Pied : notes, TVA, signatures, remerciements',
} as const;
export type DocSectionKey = keyof typeof DOC_SECTIONS;
const SECTION_KEYS = Object.keys(DOC_SECTIONS) as DocSectionKey[];
/** Largeur imprimée par défaut d'un rouleau : la tête d'une imprimante 80 mm n'imprime que sur 72 mm. */
const ROLL_PRINT_WIDTH: Partial<Record<string, number>> = { '80mm': 72, '58mm': 48 };

/** Sections dans l'ordre du modèle : toutes une fois, celles qui manquent à leur place par défaut. */
export function docSections(t: Pick<DocTemplate, 'sections'>): DocSection[] {
  const out: DocSection[] = [];
  for (const x of t.sections ?? []) {
    if (x && SECTION_KEYS.includes(x.key) && !out.some((o) => o.key === x.key)) {
      const align = DOC_ALIGNS.includes(x.align as DocAlign) ? (x.align as DocAlign) : undefined;
      out.push({ key: x.key, space: clamp(x.space, 0, 50, 0), ...(align ? { align } : {}) });
    }
  }
  for (const k of SECTION_KEYS) if (!out.some((o) => o.key === k)) out.push({ key: k, space: 0 });
  return out;
}

export interface DocSection {
  key: DocSectionKey;
  space: number;
  /** Alignement des lignes de la section ; absent : celui du modèle. */
  align?: DocAlign;
}

/** Alignement d'une ligne : le sien s'il est choisi, sinon celui de sa section, sinon celui du modèle. */
export function lineAlign(t: Pick<DocTemplate, 'sections' | 'align'>, section: DocSectionKey, line: DocLineKey | null, def: DocAlign): DocAlign {
  return (line && t.align?.[line]) || (t.sections ?? []).find((x) => x.key === section)?.align || def;
}

/** Alignement d'une colonne : le sien, sinon nombres à droite et texte à gauche. */
export function columnAlign(c: Pick<DocColumn, 'key' | 'align'>, def?: DocAlign): DocAlign {
  return c.align ?? def ?? (NUMERIC_COLUMNS.includes(c.key) ? 'right' : 'left');
}

/** Zones de signature deux par deux : gauche et droite, puis 3e et 4e. */
function signPairs(t: DocTemplate, d: DocData): [string, string][] {
  if (!t.footer.signatures) return [];
  const f = (x: string | undefined) => fill(x ?? '', d).trim();
  const pairs: [string, string][] = [
    [f(t.footer.signLeft), f(t.footer.signRight)],
    [f(t.footer.sign3), f(t.footer.sign4)],
  ];
  return pairs.filter(([a, b]) => a || b);
}

/** Signatures d'un ticket ESC/POS : la première à gauche, la seconde à droite sur la même ligne. */
function receiptSigns(t: DocTemplate, d: DocData): Receipt {
  const r: Receipt = [];
  for (const [a, b] of signPairs(t, d)) {
    const left = a ? `${a.replace(/\n/g, ' ')} :` : '';
    const right = b ? `${b.replace(/\n/g, ' ')} :` : '';
    r.push({ t: 'feed' }, a ? { t: 'row', left, right } : { t: 'text', text: right, align: 'right' }, { t: 'feed' }, { t: 'feed' });
  }
  return r;
}

/** Marges, largeur imprimée et espacements d'un modèle, avec leurs valeurs par défaut. */
export function pageLayout(t: DocTemplate): { left: number; right: number; printWidth: number; lineSpacing: number; sectionGap: number } {
  const p = t.page;
  const { width, height } = pageSize(t);
  const roll = !height && t.format === 'ticket';
  return {
    left: p.marginLeft ?? p.margin,
    right: p.marginRight ?? p.margin,
    printWidth: roll ? Math.min(width, p.printWidth || ROLL_PRINT_WIDTH[p.paper] || width) : width,
    lineSpacing: p.lineSpacing ?? 100,
    sectionGap: p.sectionGap ?? 0,
  };
}

type SectionParts<T> = Partial<Record<DocSectionKey, T>>;

/** Ticket en sections remises dans l'ordre du modèle, avec l'espace voulu entre elles. */
function arrangeReceipt(t: DocTemplate, parts: SectionParts<Receipt>): Receipt {
  const { lineSpacing, sectionGap } = pageLayout(t);
  const out: Receipt = lineSpacing !== 100 ? [{ t: 'spacing', pct: lineSpacing }] : [];
  let first = true;
  for (const { key, space, align } of docSections(t)) {
    const part = parts[key];
    if (!part?.length) continue;
    const gap = first ? space : sectionGap + space;
    if (gap > 0) out.push({ t: 'space', mm: gap });
    // L'alignement de la section va aux lignes de texte qui n'en ont pas choisi un.
    out.push(...(align ? part.map((l): ReceiptLine => (l.t === 'text' && !l.align ? { ...l, align } : l)) : part));
    first = false;
  }
  return out;
}

/** Même chose pour une page HTML. */
function arrangeHtml(t: DocTemplate, parts: SectionParts<string>): string {
  const { sectionGap } = pageLayout(t);
  let first = true;
  return docSections(t)
    .map(({ key, space, align }) => {
      const part = parts[key]?.trim();
      if (!part) return '';
      const gap = first ? space : sectionGap + space;
      first = false;
      const style = [gap ? `margin-top:${gap}mm` : '', align ? `text-align:${align}` : ''].filter(Boolean).join(';');
      return `<div class="sec sec-${key}"${style ? ` style="${style}"` : ''}>${part}</div>`;
    })
    .join('');
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
    /** Présentation simple ou encadrée. */
    style: DocStyle;
    /** Marges gauche et droite en mm (sinon « Marges »). */
    marginLeft?: number;
    marginRight?: number;
    /** Rouleau : largeur réellement imprimée en mm (72 sur un rouleau de 80, 48 sur un 58). */
    printWidth?: number;
    /** Interligne à l'intérieur des sections, en % (100 : normal). */
    lineSpacing?: number;
    /** Espace entre les sections, en mm. */
    sectionGap?: number;
  };
  /** Ordre des sections du document (glisser-déposer), espace en plus au-dessus de chacune (mm) et alignement. */
  sections?: DocSection[];
  /** Alignement choisi ligne par ligne (sinon celui de la section). */
  align?: Partial<Record<DocLineKey, DocAlign>>;
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
    /** Date de validité (devis et proforma). */
    validUntil: boolean;
  };
  columns: DocColumn[];
  totals: {
    /** Total TTC (à décocher pour un bon de livraison sans prix). */
    ttc: boolean;
    ht: boolean;
    vatDetail: boolean;
    discount: boolean;
    promo: boolean;
    rounding: boolean;
    payments: boolean;
    change: boolean;
    remaining: boolean;
    words: boolean;
    /** Nombre de colis (somme des quantités). */
    parcels?: boolean;
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
    /** Remarque à gauche du montant en lettres (présentation encadrée), « Merci de votre fidélité ». */
    remark: string;
    /** Troisième et quatrième zones de signature (listing : « Le chauffeur », « Le contrôleur »). */
    sign3?: string;
    sign4?: string;
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
    /** Couleur de l'entreprise (#rrggbb) : fond des en-têtes de tableau des documents A4. */
    color?: string;
    /** Message d'en-tête du ticket (paramètres). */
    message: string;
    /** Message de pied du ticket (paramètres du poste). */
    thanks: string;
    vatEnabled: boolean;
  };
  /** Client, ou fournisseur pour les documents d'achat. */
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
  /** « Client » (par défaut) ou « Fournisseur ». */
  partyLabel?: string;
  /** Carte de fidélité du client : points de ce ticket et solde. */
  loyalty?: { earned: number; redeemed: number; balance: number } | null;
  doc: {
    kind: 'sale' | 'return' | 'quote' | 'purchase';
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
    /** Date de validité d'un devis. */
    validUntil?: string | null;
    /** Observations saisies sur le document. */
    notes?: string | null;
    /** Dépôt d'où sort la marchandise (« MAG. DE LIVR. » sur la facture listing). */
    warehouse?: string | null;
    /** Autres informations du document (« Facture fournisseur n° 123 du 10/10/2026 », « Livrer à : Magasin »). */
    extra?: string[];
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
  /** Unité de vente d'un article à la pièce (« Sac », « Pièce ») : colonne COND. de la facture listing. */
  unitName?: string;
  /** Achats : référence chez le fournisseur, remise en %, gratuits, coût net. */
  supplierRef?: string | null;
  discountLabel?: string;
  freeQty?: string;
  netCost?: number;
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
  page: { paper: '80mm', landscape: false, margin: 2, font: 'mono', fontSize: 11, headerHeight: 0, footerHeight: 0, lineHeight: 0, copies: 1, borders: false, style: 'plain' },
  header: { logo: true, logoSize: 25, logoAlign: 'center', storeName: true, address: true, phone: true, niu: true, rccm: true, message: '' },
  customer: { show: true, code: false, address: false, phone: false, niu: false, balance: false },
  info: { title: '', number: true, date: true, time: true, seller: true, register: false, priceLevel: true, dueDate: true, validUntil: false },
  columns: cols({ label: 0, qty: 0, unitPrice: 0, discount: 0, totalTtc: 0 }),
  totals: { ttc: true, ht: false, vatDetail: true, discount: false, promo: true, rounding: true, payments: true, change: true, remaining: false, words: false, parcels: false },
  footer: { text: '', thanks: '', signatures: false, signLeft: 'Le client', signRight: '', duplicate: true, remark: '', sign3: '', sign4: '' },
};

const A4_BASE: Omit<DocTemplate, 'id' | 'variant' | 'name'> = {
  doc: 'invoice',
  format: 'a4',
  builtin: true,
  page: { paper: 'A4', landscape: false, margin: 15, font: 'sans', fontSize: 12, headerHeight: 0, footerHeight: 0, lineHeight: 0, copies: 1, borders: true, style: 'plain' },
  header: { logo: true, logoSize: 22, logoAlign: 'left', storeName: true, address: true, phone: true, niu: true, rccm: true, message: '' },
  customer: { show: true, code: true, address: true, phone: true, niu: true, balance: false },
  info: { title: 'Facture', number: true, date: true, time: false, seller: true, register: false, priceLevel: false, dueDate: true, validUntil: false },
  columns: cols({ label: 0, qty: 10, unitPrice: 12, discount: 9, vat: 9, totalHt: 12, totalTtc: 13 }),
  totals: { ttc: true, ht: true, vatDetail: true, discount: false, promo: false, rounding: false, payments: true, change: false, remaining: false, words: false, parcels: false },
  footer: { text: '', thanks: '', signatures: true, signLeft: 'Le client', signRight: 'Pour {magasin}', duplicate: true, remark: '', sign3: '', sign4: '' },
};

const LISTING_BASE: Omit<DocTemplate, 'id' | 'variant' | 'name'> = {
  ...A4_BASE,
  format: 'listing',
  page: { paper: 'A4', landscape: false, margin: 10, font: 'mono', fontSize: 10, headerHeight: 0, footerHeight: 0, lineHeight: 0, copies: 1, borders: false, style: 'plain' },
  header: { ...A4_BASE.header, logo: false },
  customer: { show: true, code: true, address: false, phone: true, niu: true, balance: false },
  columns: cols({ code: 12, label: 0, qty: 11, unitPrice: 12, discount: 10, totalTtc: 13 }),
  totals: { ttc: true, ht: true, vatDetail: true, discount: true, promo: false, rounding: false, payments: true, change: false, remaining: false, words: false, parcels: false },
};

/**
 * Facture listing (touche F7) : imprimante à papier continu, 240 mm de large,
 * hauteur selon le contenu ; cadre, cases DATE / CLIENT / RÉF., tableau
 * encadré, montant en lettres, nombre de colis et NET À PAYER.
 */
const LISTING_INVOICE: Omit<DocTemplate, 'id' | 'variant' | 'name'> = {
  ...LISTING_BASE,
  page: { ...LISTING_BASE.page, paper: 'listing', margin: 6, fontSize: 11, lineHeight: 0, borders: true, style: 'framed' },
  header: { ...LISTING_BASE.header, logo: true, logoSize: 22, logoAlign: 'left' },
  customer: { show: true, code: true, address: false, phone: false, niu: false, balance: false },
  info: { ...LISTING_BASE.info, title: 'Facture', time: true, dueDate: false },
  columns: cols({ code: [13, 'RÉF'], label: [0, 'DÉSIGNATION'], qty: [7, 'QTÉ'], unit: [9, 'COND.'], unitPrice: [10, 'PU'], totalTtc: [12, 'TOTAL'] }),
  totals: { ttc: true, ht: false, vatDetail: false, discount: false, promo: false, rounding: false, payments: false, change: false, remaining: false, words: true, parcels: true },
  footer: {
    text: 'Veuillez toujours vérifier la qualité et la quantité de vos marchandises avant de les emporter.',
    thanks: '',
    signatures: false,
    signLeft: '',
    signRight: '',
    duplicate: true,
    remark: 'Merci de votre fidélité',
    sign3: '',
    sign4: '',
  },
};

/** Listing sans logo : magasin à gauche, FACTURE et la case DATE / CLIENT / RÉF. à droite, quatre signatures. */
const LISTING_SIDE: Omit<DocTemplate, 'id' | 'variant' | 'name'> = {
  ...LISTING_INVOICE,
  page: { ...LISTING_INVOICE.page, style: 'side' },
  header: { ...LISTING_INVOICE.header, logo: false },
  info: { ...LISTING_INVOICE.info, title: 'Facture', number: true },
  footer: { ...LISTING_INVOICE.footer, text: '', remark: '', signatures: true, signLeft: 'Le gestionnaire', signRight: 'Le client', sign3: 'Le chauffeur', sign4: 'Le contrôleur' },
};

/** Ticket encadré : nom du produit sur sa ligne, puis QTE / COND. / P.U. / TOTAL ; colis, net à payer encadré. */
const TICKET_BOXED: Omit<DocTemplate, 'id' | 'variant' | 'name'> = {
  ...TICKET_BASE,
  page: { ...TICKET_BASE.page, style: 'boxed', font: 'sans', borders: true },
  header: { ...TICKET_BASE.header, rccm: false },
  info: { ...TICKET_BASE.info, title: 'Facture', time: true, priceLevel: false },
  columns: cols({ label: 0, qty: [0, 'QTE'], unit: [0, 'COND.'], unitPrice: [0, 'P.U.'], totalTtc: [0, 'TOTAL'] }),
  totals: { ttc: true, ht: false, vatDetail: true, discount: false, promo: false, rounding: false, payments: false, change: false, remaining: false, words: true, parcels: true },
  footer: { ...TICKET_BASE.footer, thanks: 'Chez nous, le roi c’est vous !' },
};

/** Ticket détaillé : colonne code, sous-total, puis TOTAL HT, TVA, remise, NB COLIS et MONTANT TTC. */
const TICKET_DETAILED: Omit<DocTemplate, 'id' | 'variant' | 'name'> = {
  ...TICKET_BASE,
  page: { ...TICKET_BASE.page, style: 'detailed', font: 'sans', borders: true },
  header: { ...TICKET_BASE.header, rccm: false },
  info: { ...TICKET_BASE.info, title: 'Facture', time: true, priceLevel: false },
  columns: cols({ code: [0, 'CODE'], qty: [0, 'QTE'], unitPrice: [0, 'P.U'], totalTtc: [0, 'TOTAL'] }),
  totals: { ttc: true, ht: true, vatDetail: true, discount: true, promo: false, rounding: false, payments: false, change: false, remaining: false, words: false, parcels: true },
  footer: { ...TICKET_BASE.footer, thanks: '' },
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
  { ...LISTING_INVOICE, id: 'invoice-listing-cash', variant: 'cash', name: 'Facture listing comptant' },
  {
    ...LISTING_INVOICE,
    id: 'invoice-listing-credit',
    variant: 'credit',
    name: 'Facture listing à terme',
    info: { ...LISTING_INVOICE.info, title: 'Facture à terme', dueDate: true },
    customer: { ...LISTING_INVOICE.customer, balance: true },
    totals: { ...LISTING_INVOICE.totals, remaining: true },
  },
  ...(['cash', 'credit'] as const).flatMap((variant): DocTemplate[] => {
    const credit = variant === 'credit';
    const label = credit ? 'à terme' : 'comptant';
    const owed = (t: Omit<DocTemplate, 'id' | 'variant' | 'name'>) =>
      credit ? { info: { ...t.info, dueDate: true }, customer: { ...t.customer, balance: true }, totals: { ...t.totals, remaining: true } } : {};
    return [
      { ...TICKET_BOXED, id: `invoice-ticket-${variant}-boxed`, variant, name: `Ticket encadré ${label}`, ...owed(TICKET_BOXED) },
      { ...TICKET_DETAILED, id: `invoice-ticket-${variant}-detailed`, variant, name: `Ticket détaillé ${label}`, ...owed(TICKET_DETAILED) },
      { ...LISTING_SIDE, id: `invoice-listing-${variant}-side`, variant, name: `Listing sans logo ${label}`, ...owed(LISTING_SIDE) },
    ];
  }),
  ...(['quote', 'proforma'] as const).flatMap((variant): DocTemplate[] => {
    const proforma = variant === 'proforma';
    const label = proforma ? 'Facture proforma' : 'Devis';
    const info = { title: label, number: true, date: true, time: false, seller: true, register: false, priceLevel: false, dueDate: false, validUntil: true };
    const totals = { ttc: true, ht: true, vatDetail: true, discount: false, promo: false, rounding: false, payments: false, change: false, remaining: false, words: true };
    const footer = {
      text: `Prix garantis jusqu'au {validite} dans la limite des stocks disponibles. Ce document n'est pas une facture définitive.`,
      thanks: '',
      signatures: true,
      signLeft: 'Bon pour accord, le client\nDate et signature',
      signRight: 'Pour {magasin}',
      duplicate: false,
      remark: '',
    };
    return [
      { ...A4_BASE, doc: 'quote', id: `quote-a4-${variant}`, variant, name: `${label} A4`, info, totals, footer },
      { ...LISTING_BASE, doc: 'quote', id: `quote-listing-${variant}`, variant, name: `${label} listing`, info, totals: { ...totals, discount: true }, footer },
      {
        ...TICKET_BASE,
        doc: 'quote',
        id: `quote-ticket-${variant}`,
        variant,
        name: `${label} ticket`,
        customer: { ...TICKET_BASE.customer, phone: true },
        info: { ...info, title: label.toUpperCase(), priceLevel: true },
        totals: { ...totals, words: false },
        footer: { ...footer, signatures: false },
      },
    ];
  }),
  ...((): DocTemplate[] => {
    const info = { title: 'Bon de livraison', number: true, date: true, time: false, seller: true, register: false, priceLevel: false, dueDate: false, validUntil: false };
    const totals = { ttc: false, ht: false, vatDetail: false, discount: false, promo: false, rounding: false, payments: false, change: false, remaining: false, words: false };
    const footer = {
      text: 'Marchandises reçues en bon état et conformes à la commande.',
      thanks: '',
      signatures: true,
      signLeft: 'Livré par',
      signRight: 'Reçu par\n(nom, date et signature)',
      duplicate: true,
      remark: '',
    };
    const customer = { show: true, code: true, address: true, phone: true, niu: false, balance: false };
    return [
      { ...A4_BASE, doc: 'delivery', id: 'delivery-a4-delivery', variant: 'delivery', name: 'Bon de livraison A4', customer, info, totals, footer, columns: cols({ line: 6, code: 14, label: 0, qty: 12, unit: 14 }) },
      { ...LISTING_BASE, doc: 'delivery', id: 'delivery-listing-delivery', variant: 'delivery', name: 'Bon de livraison listing', customer, info, totals, footer, columns: cols({ code: 14, label: 0, qty: 12, unit: 14 }) },
      {
        ...TICKET_BASE,
        doc: 'delivery',
        id: 'delivery-ticket-delivery',
        variant: 'delivery',
        name: 'Bon de livraison ticket',
        customer: { ...customer, address: false },
        info: { ...info, title: 'BON DE LIVRAISON' },
        totals,
        footer,
        columns: cols({ code: 0, label: 0, qty: 0 }),
      },
    ];
  })(),
  ...((): DocTemplate[] => {
    const supplier = { show: true, code: false, address: true, phone: true, niu: true, balance: false };
    const noTotals = { ttc: false, ht: false, vatDetail: false, discount: false, promo: false, rounding: false, payments: false, change: false, remaining: false, words: false };
    const order = {
      info: { title: 'Bon de commande', number: true, date: true, time: false, seller: true, register: false, priceLevel: false, dueDate: false, validUntil: false },
      totals: { ...noTotals, ht: true },
      footer: { text: '', thanks: '', signatures: true, signLeft: 'Établi par {vendeur}', signRight: 'Signature et cachet', duplicate: false, remark: '' },
    };
    const invoice = {
      info: { title: 'Facture d’achat', number: true, date: true, time: false, seller: false, register: false, priceLevel: false, dueDate: true, validUntil: false },
      totals: { ...noTotals, ttc: true, ht: true, vatDetail: true, discount: true, payments: true, remaining: true },
      footer: { text: '', thanks: '', signatures: true, signLeft: 'Contrôlé par', signRight: 'Visa', duplicate: false, remark: '' },
    };
    const ticket = { ...TICKET_BASE, customer: { ...supplier, address: false, niu: false } };
    return [
      { ...A4_BASE, doc: 'purchaseOrder', id: 'purchaseOrder-a4-order', variant: 'order', name: 'Bon de commande A4', customer: supplier, ...order, columns: cols({ supplierRef: 13, code: 10, label: 0, qty: 8, unitPrice: [11, 'PU HT'], discount: 10, freeQty: 9, totalHt: 13 }) },
      { ...LISTING_BASE, doc: 'purchaseOrder', id: 'purchaseOrder-listing-order', variant: 'order', name: 'Bon de commande listing', customer: supplier, ...order, columns: cols({ supplierRef: 14, code: 12, label: 0, qty: 10, unitPrice: [12, 'PU HT'], totalHt: 13 }) },
      { ...ticket, doc: 'purchaseOrder', id: 'purchaseOrder-ticket-order', variant: 'order', name: 'Bon de commande ticket', ...order, info: { ...order.info, title: 'BON DE COMMANDE' }, footer: { ...order.footer, signatures: false }, columns: cols({ label: 0, qty: 0, unitPrice: 0, totalHt: 0 }) },
      {
        ...A4_BASE,
        doc: 'purchaseInvoice',
        id: 'purchaseInvoice-a4-supplierInvoice',
        variant: 'supplierInvoice',
        name: 'Facture d’achat A4',
        customer: supplier,
        ...invoice,
        columns: cols({ code: 9, label: 0, qty: 8, unitPrice: [10, 'PU HT'], discount: 10, freeQty: 9, netCost: 10, totalHt: 12 }),
      },
      { ...LISTING_BASE, doc: 'purchaseInvoice', id: 'purchaseInvoice-listing-supplierInvoice', variant: 'supplierInvoice', name: 'Facture d’achat listing', customer: supplier, ...invoice, columns: cols({ code: 12, label: 0, qty: 10, netCost: 12, totalHt: 13 }) },
      {
        ...ticket,
        doc: 'purchaseInvoice',
        id: 'purchaseInvoice-ticket-supplierInvoice',
        variant: 'supplierInvoice',
        name: 'Facture d’achat ticket',
        ...invoice,
        info: { ...invoice.info, title: 'FACTURE D’ACHAT' },
        footer: { ...invoice.footer, signatures: false },
        columns: cols({ label: 0, qty: 0, netCost: 0, totalHt: 0 }),
      },
    ];
  })(),
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
  const variant = pick(r.variant, DOC_KIND_VARIANTS[doc], DOC_KIND_VARIANTS[doc][0]!);
  const id = str(r.id, 60).trim();
  if (!/^[\w-]{1,60}$/.test(id)) throw new Error('Modèle : identifiant invalide');
  // Un modèle du logiciel modifié se complète avec ses propres valeurs, sinon avec celles de son emplacement.
  const base = BUILTIN_TEMPLATES.find((b) => b.id === id && b.doc === doc && b.format === format && b.variant === variant) ?? builtinFor(doc, format, variant);
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
    const align = DOC_ALIGNS.includes(c.align as DocAlign) ? (c.align as DocAlign) : undefined;
    columns.push({ key, label: str(c.label, 40, DOC_COLUMNS[key]), show: bool(c.show, false), width: clamp(c.width, 0, 100, 0), ...(align ? { align } : {}) });
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
      style: pick(p.style, stylesFor(format), stylesFor(format).includes(base.page.style) ? base.page.style : 'plain'),
      marginLeft: clamp(p.marginLeft, 0, 40, clamp(p.margin, 0, 40, base.page.margin)),
      marginRight: clamp(p.marginRight, 0, 40, clamp(p.margin, 0, 40, base.page.margin)),
      printWidth: clamp(p.printWidth, 0, 240, 0),
      lineSpacing: clamp(p.lineSpacing, 50, 300, 100),
      sectionGap: clamp(p.sectionGap, 0, 30, 0),
    },
    sections: docSections(r),
    align: Object.fromEntries(
      Object.entries((r.align ?? {}) as Record<string, unknown>).filter(([k, v]) => LINE_KEYS.includes(k as DocLineKey) && DOC_ALIGNS.includes(v as DocAlign)),
    ) as Partial<Record<DocLineKey, DocAlign>>,
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
    .replace(/\{echeance\}/g, d.doc.dueDate ? dayFr(d.doc.dueDate) : '')
    .replace(/\{validite\}/g, d.doc.validUntil ? dayFr(d.doc.validUntil) : '')
    .replace(/\{vendeur\}/g, d.doc.seller);
}

function vatByRate(d: DocData) {
  const byRate = new Map<number, number>();
  for (const l of d.lines) byRate.set(l.vatRate, (byRate.get(l.vatRate) ?? 0) + l.totalTtc);
  return [...byRate.entries()].map(([rate, ttc]) => ({ rate, ttc, tva: splitTtc(ttc, rate).tva }));
}

/** Titre : celui du modèle, sauf pour un retour (« Avoir », « Avoir fournisseur »). */
const docTitle = (t: DocTemplate, d: DocData) =>
  d.doc.kind === 'return' && t.doc === 'invoice' ? 'Avoir' : d.doc.kind === 'return' && t.doc === 'purchaseInvoice' ? 'Avoir fournisseur' : fill(t.info.title, d);
const sellerLabel = (d: DocData) => (d.partyLabel ? 'Établi par' : 'Vendeur');
/** TVA par taux (ventes, à partir du TTC) ; un document d'achat donne seulement le total de TVA. */
const vatRows = (d: DocData) => (d.partyLabel ? (d.totals.tva ? [{ label: 'TVA', base: null as number | null, tva: d.totals.tva }] : []) : vatByRate(d).map((v) => ({ label: `TVA ${formatRate(v.rate)}`, base: v.ttc as number | null, tva: v.tva })));

const shown = (t: DocTemplate, d: DocData) => {
  const noVat = docWithoutVat(d);
  return t.columns.filter((c) => c.show && !(noVat && (c.key === 'vat' || c.key === 'totalHt' || c.key === 'unitPriceHt')));
};

/** Ticket de caisse selon le modèle : la même description sert au pilote Windows et à l'ESC/POS. */
/** Réimpression d'un document dont le modèle affiche la mention. */
const duplicata = (t: DocTemplate, d: DocData) => d.doc.duplicate && t.footer.duplicate;
/** Une imprimante à ticket ne sait pas faire de filigrane : bandeau en gros caractères en haut et en bas. */
const DUPLICATA_BANNER: ReceiptLine = { t: 'text', text: 'DUPLICATA', align: 'center', bold: true, big: true };

/** Filigrane « DUPLICATA » en diagonale, répété sur chaque page imprimée. */
function watermark(t: DocTemplate): { css: string; html: string } {
  const size = t.format === 'ticket' ? '12mm' : '36mm';
  return {
    css: `.wm { position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%) rotate(-35deg); font: bold ${size} Arial, sans-serif; letter-spacing: 0.1em;
      color: rgba(0, 0, 0, 0.13); white-space: nowrap; pointer-events: none; z-index: 10; -webkit-print-color-adjust: exact; print-color-adjust: exact; }`,
    html: '<div class="wm">DUPLICATA</div>',
  };
}

export function renderDocTicket(t: DocTemplate, d: DocData): Receipt {
  if (t.page.style === 'boxed' || t.page.style === 'detailed') return styledTicket(t, d);
  let r: Receipt = [];
  const parts: SectionParts<Receipt> = {};
  const noVat = docWithoutVat(d);
  const centered = (text: string): ReceiptLine => ({ t: 'text', text, align: 'center' });
  const lines = (text: string) => fill(text, d).split('\n').map((s) => s.trim()).filter(Boolean);
  const h = t.header;
  const hd = (line: DocLineKey, text: string): Extract<ReceiptLine, { t: 'text' }> => ({ t: 'text', text, align: lineAlign(t, 'header', line, 'center') });
  if (h.logo && d.store.logo) r.push({ t: 'image', src: d.store.logo });
  if (h.storeName) r.push({ ...hd('storeName', d.store.name), bold: true, big: true });
  for (const m of [...lines(d.store.message), ...lines(h.message)]) r.push(hd('message', m));
  if (h.address && d.store.address) r.push(hd('address', d.store.address));
  if (h.phone && d.store.phone) r.push(hd('phone', d.store.phone));
  if (h.niu && d.store.niu) r.push(hd('niu', `NIU : ${d.store.niu}`));
  if (h.rccm && d.store.rccm) r.push(hd('niu', `RCCM : ${d.store.rccm}`));
  if (r.length) r.push({ t: 'rule' });
  (parts.header = r), (r = []);

  const ti = (line: DocLineKey) => t.align?.[line];
  const title = d.doc.kind === 'return' && t.doc === 'invoice' ? 'RETOUR CLIENT' : docTitle(t, d);
  if (title) r.push({ t: 'text', text: title, bold: true, align: ti('number') });
  if (d.doc.cancelled) r.push({ t: 'text', text: 'ANNULÉ', bold: true, align: ti('number') });
  if (duplicata(t, d)) r.push(DUPLICATA_BANNER);
  if (t.info.number) r.push({ t: 'text', text: `${title ? 'N°' : 'Ticket'} ${d.doc.number}`, align: ti('number') });
  const when = t.info.date ? (t.info.time ? dateTimeFr(d.doc.date) : dayFr(d.doc.date)) : '';
  const meta = [when, t.info.seller ? d.doc.seller : '', t.info.register ? (d.doc.register ?? '') : ''].filter(Boolean).join(' · ');
  if (meta) r.push({ t: 'text', text: meta, align: ti('seller') });
  const c = d.customer;
  if (t.customer.show && c) {
    r.push({ t: 'text', text: `${d.partyLabel ?? 'Client'} : ${c.name}`, align: ti('customer') });
    if (t.customer.code && c.code) r.push({ t: 'text', text: `Compte : ${c.code}` });
    if (t.customer.phone && c.phone) r.push({ t: 'text', text: `Tél. : ${c.phone}` });
    if (t.customer.address && c.address) r.push({ t: 'text', text: c.address });
    if (t.customer.niu && c.niu) r.push({ t: 'text', text: `NIU : ${c.niu}` });
  }
  if (t.info.priceLevel && d.doc.priceLevel) r.push({ t: 'text', text: `Tarif : ${d.doc.priceLevel}` });
  if (t.info.validUntil && d.doc.validUntil) r.push({ t: 'text', text: `Valable jusqu'au ${dayFr(d.doc.validUntil)}` });
  for (const x of d.doc.extra ?? []) r.push({ t: 'text', text: x });
  r.push({ t: 'rule' });

  (parts.title = r), (r = []);
  const on = new Set(shown(t, d).map((x) => x.key));
  for (const l of d.lines) {
    const left = [on.has('line') ? `${d.lines.indexOf(l) + 1}.` : '', on.has('code') && l.code ? l.code : '', l.label].filter(Boolean).join(' ');
    r.push({ t: 'row', left, right: on.has('totalTtc') ? money(l.totalTtc + l.promo) : on.has('totalHt') ? money(l.totalHt) : '' });
    const qty = `${l.qty}${l.unit ? ` ${l.unit}` : ''}`;
    const price = on.has('unitPrice') ? l.unitPrice : on.has('unitPriceHt') ? l.unitPriceHt : on.has('netCost') ? l.netCost : undefined;
    const priced = price !== undefined;
    const parts = [
      priced ? `${qty} x ${money(price)}` : on.has('qty') ? `Qté : ${qty}` : '',
      on.has('discount') && (l.discountLabel || l.discount) ? `(remise ${l.discountLabel ?? money(l.discount)})` : '',
      on.has('freeQty') && l.freeQty ? `+ ${l.freeQty} gratuits` : '',
      on.has('vat') ? `TVA ${formatRate(l.vatRate)}` : '',
    ].filter(Boolean);
    if (parts.length && (l.detail || !priced || (on.has('discount') && l.discount) || on.has('vat'))) r.push({ t: 'row', left: parts.join(' '), right: '', indent: 2 });
    if (on.has('barcode') && l.barcode) r.push({ t: 'row', left: l.barcode, right: '', indent: 2 });
    if (t.totals.promo && l.promo) r.push({ t: 'row', left: `Promo ${l.promoName ?? ''}`.trim(), right: `-${money(l.promo)}`, indent: 2 });
  }
  (parts.lines = r), (r = []);
  if (t.totals.ttc || t.totals.ht || t.totals.payments) r.push({ t: 'rule' });
  const tot = d.totals;
  if (t.totals.ht && (!noVat || !t.totals.ttc)) r.push({ t: 'row', left: tx('TOTAL HT FCFA', noVat), right: money(tot.ht), bold: !t.totals.ttc, big: !t.totals.ttc });
  if (t.totals.discount && tot.discount) r.push({ t: 'row', left: 'Remises', right: money(tot.discount) });
  if (t.totals.ttc) r.push({ t: 'row', left: 'TOTAL FCFA', right: money(tot.ttc), bold: true, big: true });
  if (t.totals.rounding && tot.rounding) r.push({ t: 'row', left: 'dont arrondi espèces', right: `-${money(tot.rounding)}`, indent: 2 });
  if (t.totals.promo && tot.promo > 0) r.push({ t: 'row', left: 'Vous avez économisé', right: money(tot.promo), bold: true });
  (parts.totals = r), (r = []);
  if (t.totals.payments) for (const p of d.payments) r.push({ t: 'row', left: p.label, right: money(p.amount) });
  if (t.totals.change && tot.change) r.push({ t: 'row', left: 'Rendu monnaie', right: money(tot.change), bold: true });
  if (t.totals.remaining && tot.remaining) r.push({ t: 'row', left: 'Reste à payer', right: money(tot.remaining), bold: true });
  if (t.customer.show && t.customer.balance && c?.balance != null) r.push({ t: 'row', left: 'Solde de votre compte', right: money(c.balance) });
  if (t.customer.show && d.loyalty) {
    if (d.loyalty.redeemed) r.push({ t: 'row', left: 'Points utilisés', right: `-${d.loyalty.redeemed}` });
    if (d.loyalty.earned) r.push({ t: 'row', left: 'Points gagnés', right: `${d.loyalty.earned > 0 ? '+' : ''}${d.loyalty.earned}` });
    r.push({ t: 'row', left: 'Vos points fidélité', right: String(d.loyalty.balance), bold: true });
  }
  if (t.info.dueDate && d.doc.dueDate) r.push({ t: 'text', text: `À régler avant le ${dayFr(d.doc.dueDate)}` });
  if (t.totals.words && tot.ttc >= 0) r.push({ t: 'text', text: `Arrêté à la somme de ${numberToWordsFr(tot.ttc)} francs CFA`, align: t.align?.words });
  (parts.payments = r), (r = []);
  if (d.doc.notes) r.push({ t: 'rule' }, ...d.doc.notes.split('\n').filter(Boolean).map((text): ReceiptLine => ({ t: 'text', text })));
  if (t.totals.vatDetail) {
    r.push({ t: 'rule' });
    if (noVat) r.push(centered('TVA non applicable'));
    else {
      for (const v of vatRows(d)) r.push({ t: 'row', left: v.base === null ? v.label : `${v.label} sur ${money(v.base)}`, right: money(v.tva) });
      if (!d.partyLabel) r.push({ t: 'row', left: 'dont TVA', right: money(tot.tva) });
    }
  }
  r.push(...receiptSigns(t, d));
  const ft = (line: DocLineKey) => (text: string): ReceiptLine => ({ t: 'text', text, align: lineAlign(t, 'footer', line, 'center') });
  const bottom = [...lines(t.footer.text).map(ft('footerText')), ...lines(t.footer.thanks || d.store.thanks).map(ft('thanks'))];
  if (bottom.length) r.push({ t: 'rule' }, ...bottom);
  if (duplicata(t, d)) r.push({ t: 'feed' }, DUPLICATA_BANNER);
  parts.footer = r;
  return arrangeReceipt(t, parts);
}

/** Rendu HTML d'un ticket (pilote Windows et aperçu). */
export function receiptToHtml(receipt: Receipt): string {
  return receipt
    .map((l) => {
      if (l.t === 'rule') return '<hr>';
      if (l.t === 'feed') return '<br>';
      if (l.t === 'space') return `<div style="height:${l.mm}mm"></div>`;
      if (l.t === 'spacing') return '';
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
const PAPER_MM: Record<DocPaper, [number, number]> = { '80mm': [80, 0], '58mm': [58, 0], A4: [210, 297], A5: [148, 210], listing: [240, 0] };

/** Dimensions de la page en mm (largeur, hauteur ; hauteur 0 : rouleau). */
export function pageSize(t: DocTemplate): { width: number; height: number } {
  const [w, h] = PAPER_MM[t.page.paper];
  return t.page.landscape && h ? { width: h, height: w } : { width: w, height: h };
}

function pageCss(t: DocTemplate): string {
  const { width, height } = pageSize(t);
  const m = t.page.margin;
  const { left, right, printWidth, lineSpacing } = pageLayout(t);
  const pad = t.format === 'ticket' ? `0 ${right}mm 0 ${left}mm` : `${m}mm ${right}mm ${m}mm ${left}mm`;
  return `
  @page { size: ${height ? `${width}mm ${height}mm` : `${printWidth}mm auto`}; margin: ${height ? `${m}mm ${right}mm ${m}mm ${left}mm` : '0'}; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body { font: ${t.page.fontSize}px/${((1.35 * lineSpacing) / 100).toFixed(2)} ${FONTS[t.page.font]}; color: #111; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .sheet { ${height ? '' : `width: ${printWidth}mm; padding: ${pad};`} }
  @media screen {
    html { background: #8a8f98; }
    body { padding: 16px 0; }
    .sheet { background: #fff; margin: 0 auto; box-shadow: 0 2px 10px rgba(0,0,0,.35); width: ${height ? width : printWidth}mm; padding: ${height ? `${m}mm ${right}mm ${m}mm ${left}mm` : t.format === 'ticket' ? `3mm ${right}mm 3mm ${left}mm` : pad}; ${height ? `min-height: ${height}mm;` : ''} }
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

function documentCss(t: DocTemplate, color?: string): string {
  const listing = t.format === 'listing';
  const b = t.page.borders;
  // En-têtes de tableau teintés aux couleurs de l'entreprise (très clair : le texte reste noir).
  const tint = isHexColor(color) ? mixColors(color, '#ffffff', 0.86) : '#e8eef7';
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
  table.lines th { ${b ? `background: ${tint};` : 'border-bottom: 1px solid #000;'} font-weight: bold; }
  ${listing && !b ? 'table.lines tbody tr td { border-bottom: 1px dotted #bbb; }' : ''}
  ${t.page.lineHeight ? `table.lines tbody td { height: ${t.page.lineHeight}mm; }` : ''}
  table.lines thead { display: table-header-group; }
  .r { text-align: right !important; }
  .bottom { display: flex; justify-content: space-between; gap: 16px; margin-top: 8px; break-inside: avoid; }
  .bottom .left { flex: 1; }
  table.totals { width: 45%; }
  table.totals td { padding: 2px 6px; ${b ? 'border: 1px solid #bbb;' : ''} }
  table.totals tr.total td { font-weight: bold; ${b ? `background: ${tint};` : 'border-top: 1px solid #000;'} }
  .dup { font-weight: bold; letter-spacing: 2px; color: #a00; }
  footer { margin-top: 14px; break-inside: avoid; ${t.page.footerHeight ? `min-height: ${t.page.footerHeight}mm;` : ''} }
  .sign { margin-top: 10px; display: flex; justify-content: space-between; min-height: 22mm; }
  .notes { white-space: pre-line; }
  .thanks { text-align: center; margin-top: 10px; }
  `;
}

const nl = (s: string) => esc(s).replace(/\n/g, '<br>');
/** Style d'alignement d'un élément HTML, rien quand il n'est pas choisi. */
const sa = (a: DocAlign | undefined) => (a ? ` style="text-align:${a}"` : '');
/** Classe d'une cellule selon l'alignement de sa colonne. */
const cellClass = (a: DocAlign) => (a === 'right' ? ' class="r"' : a === 'center' ? ' class="c"' : '');
/** Cellule d'un tableau texte : complétée à la largeur de la colonne selon son alignement. */
const padCell = (v: string, w: number, a: DocAlign) =>
  a === 'right' ? v.padStart(w) : a === 'center' ? v.padStart(Math.floor((w + v.length) / 2)).padEnd(w) : v.padEnd(w);

/** Page HTML complète d'une facture selon son modèle : imprimée telle quelle et affichée en aperçu. */
export function renderDocHtml(t: DocTemplate, d: DocData): string {
  const wm = duplicata(t, d) ? watermark(t) : { css: '', html: '' };
  const wrap = (css: string, body: string) =>
    `<!doctype html><html><head><meta charset="utf-8"><style>${pageCss(t)}${css}${wm.css}</style></head><body>${wm.html}<div class="sheet">${body}</div></body></html>`;
  if (t.format === 'ticket' && (t.page.style === 'boxed' || t.page.style === 'detailed')) return wrap(styledTicketCss(t), styledTicketHtml(t, d));
  if (t.format === 'ticket') return wrap(`${TICKET_CSS} .c img { max-height: ${t.header.logoSize}mm !important; }`, receiptToHtml(renderDocTicket(t, d)));
  if (t.page.style === 'framed' || t.page.style === 'side') return wrap(framedCss(t), framedBody(t, d));

  const noVat = docWithoutVat(d);
  const h = t.header;
  const logo = h.logo && d.store.logo ? `<img src="${esc(d.store.logo)}" alt="">` : '';
  const al = (line: DocLineKey) => sa(t.align?.[line]);
  const ident = [
    h.storeName ? `<h1${al('storeName')}>${esc(d.store.name)}</h1>` : '',
    h.address && d.store.address ? `<div${al('address')}>${esc(d.store.address)}</div>` : '',
    h.phone && d.store.phone ? `<div${al('phone')}>${esc(d.store.phone)}</div>` : '',
    h.niu && d.store.niu ? `<div${al('niu')}>NIU ${esc(d.store.niu)}</div>` : '',
    h.rccm && d.store.rccm ? `<div${al('niu')}>RCCM ${esc(d.store.rccm)}</div>` : '',
    h.message ? `<div class="notes"${al('message')}>${nl(fill(h.message, d))}</div>` : '',
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

  const title = docTitle(t, d);
  const titleLine = `<h2${al('number')}>${esc(title)}${t.info.number ? ` ${esc(d.doc.number)}` : ''}${d.doc.cancelled ? ' (annulé)' : ''}${
    d.doc.duplicate && t.footer.duplicate ? ' <span class="dup">DUPLICATA</span>' : ''
  }</h2>`;
  const meta = [
    t.info.date ? `Date : ${t.info.time ? dateTimeFr(d.doc.date) : dayFr(d.doc.date)}` : '',
    t.info.dueDate && d.doc.dueDate ? `Échéance : ${dayFr(d.doc.dueDate)}` : '',
    t.info.validUntil && d.doc.validUntil ? `Valable jusqu'au ${dayFr(d.doc.validUntil)}` : '',
    t.info.seller && d.doc.seller ? `${sellerLabel(d)} : ${esc(d.doc.seller)}` : '',
    t.info.register && d.doc.register ? `Caisse : ${esc(d.doc.register)}` : '',
    t.info.priceLevel && d.doc.priceLevel ? `Tarif : ${esc(d.doc.priceLevel)}` : '',
    ...(d.doc.extra ?? []).map(esc),
  ].filter(Boolean);

  const columns = shown(t, d);
  const showUnit = columns.some((x) => x.key === 'unit');
  const cell = (key: DocColumnKey, l: DocLine, i: number): string => {
    switch (key) {
      case 'line': return String(i + 1);
      case 'supplierRef': return esc(l.supplierRef ?? '');
      case 'freeQty': return esc(l.freeQty ?? '');
      case 'netCost': return l.netCost === undefined ? '' : money(l.netCost);
      case 'code': return esc(l.code ?? '');
      case 'barcode': return esc(l.barcode ?? '');
      case 'label': return esc(l.label);
      case 'qty': return esc(`${l.qty}${!showUnit && l.unit ? ` ${l.unit}` : ''}`);
      case 'unit': return esc(l.unit);
      case 'unitPrice': return money(l.unitPrice);
      case 'unitPriceHt': return money(l.unitPriceHt);
      case 'discount': return l.discountLabel ? esc(l.discountLabel) : l.discount ? money(l.discount) : '';
      case 'vat': return formatRate(l.vatRate);
      case 'totalHt': return money(l.totalHt);
      case 'totalTtc': return money(l.totalTtc);
    }
  };
  const right = (x: DocColumn) => {
    const a = columnAlign(x);
    return a === 'center' ? ' style="text-align:center"' : a === 'right' ? ' class="r"' : '';
  };
  const table = !d.lines.length ? '' : `<table class="lines"><colgroup>${columns.map((x) => `<col${x.width ? ` style="width:${x.width}%"` : ''}>`).join('')}</colgroup>
    <thead><tr>${columns.map((x) => `<th${right(x)}>${esc(tx(x.label, noVat))}</th>`).join('')}</tr></thead>
    <tbody>${d.lines.map((l, i) => `<tr>${columns.map((x) => `<td${right(x)}>${cell(x.key, l, i)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;

  const tot = d.totals;
  const row = (label: string, v: number, cls = '') => `<tr${cls ? ` class="${cls}"` : ''}><td>${label}</td><td class="r">${money(v)}</td></tr>`;
  const totals = [
    t.totals.ht && (!noVat || !t.totals.ttc) ? row(tx('Total HT (FCFA)', noVat && !t.totals.ttc), tot.ht, t.totals.ttc ? '' : 'total') : '',
    t.totals.vatDetail && !noVat ? vatRows(d).filter((v) => v.tva).map((v) => row(v.label, v.tva)).join('') : '',
    t.totals.discount && tot.discount ? row('Remises accordées', tot.discount) : '',
    t.totals.promo && tot.promo ? row('Promotions', tot.promo) : '',
    t.totals.rounding && tot.rounding ? row('Arrondi espèces', -tot.rounding) : '',
    t.totals.ttc ? row(noVat ? 'Total (FCFA)' : 'Total TTC (FCFA)', tot.ttc, 'total') : '',
    t.totals.payments ? d.payments.map((p) => row(esc(p.label), p.amount)).join('') : '',
    t.totals.change && tot.change ? row('Rendu monnaie', tot.change) : '',
    t.totals.remaining && tot.remaining ? row('Reste à payer', tot.remaining, 'total') : '',
  ].join('');
  const left = [
    t.totals.words && tot.ttc >= 0 ? `<p${al('words')}>Arrêté à la somme de <b>${esc(numberToWordsFr(tot.ttc))} francs CFA</b>${noVat ? '' : ' toutes taxes comprises'}.</p>` : '',
    t.totals.vatDetail && noVat ? '<p class="muted">TVA non applicable.</p>' : '',
    d.doc.notes ? `<p class="notes">${nl(d.doc.notes)}</p>` : '',
  ].join('');
  const footer = [
    t.footer.text ? `<div class="notes"${al('footerText')}>${nl(fill(t.footer.text, d))}</div>` : '',
    t.footer.signatures ? `<div class="sign">${signLabels(t, d).map((x) => `<div>${nl(x)}</div>`).join('')}</div>` : '',
    t.footer.thanks ? `<div class="thanks"${al('thanks')}>${nl(fill(t.footer.thanks, d))}</div>` : '',
  ].join('');

  return wrap(
    documentCss(t, d.store.color),
    arrangeHtml(t, {
      header: head,
      title: `${titleLine}${meta.length ? `<div class="meta"${al('seller')}>${meta.join(' · ')}</div>` : ''}`,
      lines: table,
      totals: left || totals ? `<div class="bottom"><div class="left">${left}</div>${totals ? `<table class="totals">${totals}</table>` : ''}</div>` : '',
      footer: footer ? `<footer>${footer}</footer>` : '',
    }),
  );
}

/** Nombre de colis : somme des quantités entières, une ligne au poids compte pour un colis. */
export function parcelCount(lines: readonly DocLine[]): number {
  return lines.reduce((n, l) => {
    const q = Number(/^-?[\d\s ]*[.,]?\d*/.exec(l.qty)?.[0].replace(/[\s ]/g, '').replace(',', '.') ?? 0);
    return n + (Number.isFinite(q) && q > 0 ? (Number.isInteger(q) ? q : 1) : 0);
  }, 0);
}

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter((w) => /^[\p{L}\d]/u.test(w))
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('');

function framedCss(t: DocTemplate): string {
  const lh = t.page.lineHeight;
  return `
  .frame { border: 2px solid #111; padding: 3mm 3.5mm; }
  .fhead { display: flex; gap: 4mm; align-items: center; }
  .fhead img { height: ${t.header.logoSize}mm; width: auto; }
  .flogo { width: ${t.header.logoSize}mm; height: ${t.header.logoSize}mm; border: 3px solid #111; border-radius: 50%; display: grid; place-items: center; font: 900 ${Math.round(t.header.logoSize * 1.3)}px Georgia, serif; flex: none; }
  .fhead h1 { margin: 0; font: 900 1.75em Arial, sans-serif; }
  .fhead p { margin: 0; }
  .fhead .notes { white-space: pre-line; }
  .ftitle { display: flex; flex-direction: column; align-items: center; margin: 2mm 0 1.5mm; }
  .ftitle h2 { margin: 0 0 1mm; font: 900 1.6em Georgia, serif; }
  .fside { display: flex; justify-content: space-between; align-items: flex-start; gap: 6mm; }
  .fside .fhead h1 { font-size: 1.45em; }
  .ftitle.left { align-items: flex-start; margin: 0; }
  .ftitle.left h2 { font-size: 1.35em; }
  .fsigns { display: flex; justify-content: space-around; min-height: 16mm; margin-top: 3mm; font-weight: bold; text-align: center; }
  table { border-collapse: collapse; }
  .fbox td, .fbox th, .fsum td, .fsum th { border: 1px solid #111; padding: 1px 3mm; text-align: center; }
  .fbox th, .fsum th, .flines th { background: #eee; font-weight: bold; }
  .fmag { margin: 1.5mm 0 2mm; }
  .flines { width: 100%; table-layout: fixed; border: 1px solid #111; }
  .flines th { border: 1px solid #111; padding: 1px 1.5mm; text-align: left; }
  .flines td { border-left: 1px solid #111; border-right: 1px solid #111; padding: 0 1.5mm; vertical-align: top; overflow-wrap: anywhere; ${lh ? `height: ${lh}mm;` : ''} }
  .flines tbody tr.fill td { height: 12mm; }
  .flines tbody td.up { text-transform: uppercase; }
  .flines thead { display: table-header-group; }
  .r { text-align: right !important; }
  .ftotal { display: flex; justify-content: flex-end; }
  .ftotal div { border: 1px solid #111; border-top: none; padding: 1px 1.5mm; font-weight: bold; text-align: right; font-size: 1.1em; }
  .fbottom { display: flex; gap: 4mm; align-items: flex-start; margin-top: 2.5mm; break-inside: avoid; }
  .fremark { flex: 0 0 34%; font-style: italic; padding: 0 1.5mm; white-space: pre-line; }
  .fsum { flex: 1; width: 100%; }
  .fsum td { padding: 1px 2mm; }
  .fsum .words { width: 62%; }
  .fextra { margin-top: 1.5mm; }
  .fslogan { text-align: center; font: bold 1.15em Arial, sans-serif; margin-top: 2.5mm; text-transform: uppercase; }
  .notes { white-space: pre-line; }
  .fids, .fby { display: flex; justify-content: space-between; margin-top: 1.5mm; }
  .dup { font-weight: bold; letter-spacing: 2px; color: #a00; }
  .muted { color: #444; }`;
}

/** Facture encadrée (listing) : cadre, cases DATE / CLIENT / RÉF., tableau, montant en lettres, NB COLIS, NET À PAYER. */
function framedBody(t: DocTemplate, d: DocData): string {
  const noVat = docWithoutVat(d);
  const h = t.header;
  const logo = !h.logo ? '' : d.store.logo ? `<img src="${esc(d.store.logo)}" alt="">` : `<div class="flogo">${esc(initials(d.store.name))}</div>`;
  const ident = [
    h.storeName ? `<h1>${esc(d.store.name)}</h1>` : '',
    ...[d.store.message, h.message].filter(Boolean).map((m) => `<p class="notes">${nl(fill(m, d))}</p>`),
    h.address && d.store.address ? `<p>${esc(d.store.address)}</p>` : '',
    h.phone && d.store.phone ? `<p>Tél ${esc(d.store.phone)}</p>` : '',
  ].join('');
  const c = d.customer;
  const cu = t.customer;
  const title = docTitle(t, d);
  const when = t.info.time ? dateTimeFr(d.doc.date) : dayFr(d.doc.date);
  const heads = [t.info.date ? 'DATE' : '', cu.show ? (d.partyLabel ?? 'Client').toUpperCase() : '', cu.show && cu.code ? 'RÉF.' : ''];
  const vals = [t.info.date ? esc(when) : '', cu.show ? esc((c?.name ?? 'Client comptoir').toUpperCase()) : '', cu.show && cu.code ? esc(c?.code ?? '') : ''];
  const box = heads.some(Boolean)
    ? `<table class="fbox"><tr>${heads.filter(Boolean).map((x) => `<th>${x}</th>`).join('')}</tr><tr>${vals.filter((_, i) => heads[i]).map((x) => `<td>${x}</td>`).join('')}</tr></table>`
    : '';
  const extra = [
    d.doc.warehouse ? `MAG. DE LIVR. : ${esc(d.doc.warehouse.toUpperCase())}` : '',
    cu.show && c && !c.counter && cu.phone && c.phone ? `Tél. client : ${esc(c.phone)}` : '',
    cu.show && c && !c.counter && cu.address && c.address ? esc(c.address) : '',
    cu.show && c && !c.counter && cu.niu && c.niu ? `NIU client : ${esc(c.niu)}` : '',
    t.info.dueDate && d.doc.dueDate ? `Échéance : ${dayFr(d.doc.dueDate)}` : '',
    t.info.validUntil && d.doc.validUntil ? `Valable jusqu'au ${dayFr(d.doc.validUntil)}` : '',
    t.info.priceLevel && d.doc.priceLevel ? `Tarif : ${esc(d.doc.priceLevel)}` : '',
    t.info.register && d.doc.register ? `Caisse : ${esc(d.doc.register)}` : '',
    ...(d.doc.extra ?? []).map(esc),
  ].filter(Boolean);

  const columns = shown(t, d);
  const showUnit = columns.some((x) => x.key === 'unit');
  const cell = (key: DocColumnKey, l: DocLine, i: number): string => {
    switch (key) {
      case 'line': return String(i + 1);
      case 'supplierRef': return esc(l.supplierRef ?? '');
      case 'freeQty': return esc(l.freeQty ?? '');
      case 'netCost': return l.netCost === undefined ? '' : money(l.netCost);
      case 'code': return esc(l.code ?? '');
      case 'barcode': return esc(l.barcode ?? '');
      case 'label': return esc(l.label);
      case 'qty': return esc(`${l.qty}${!showUnit && l.unit ? ` ${l.unit}` : ''}`);
      case 'unit': return esc(l.unit || l.unitName || '');
      case 'unitPrice': return money(l.unitPrice);
      case 'unitPriceHt': return money(l.unitPriceHt);
      case 'discount': return l.discountLabel ? esc(l.discountLabel) : l.discount ? money(l.discount) : '';
      case 'vat': return formatRate(l.vatRate);
      case 'totalHt': return money(l.totalHt);
      case 'totalTtc': return money(l.totalTtc);
    }
  };
  const cls = (k: DocColumnKey) => (NUMERIC_COLUMNS.includes(k) ? ' class="r"' : k === 'label' || k === 'unit' ? ' class="up"' : '');
  const lastWidth = columns.at(-1)?.width || 12;
  const table = `<table class="flines"><colgroup>${columns.map((x) => `<col${x.width ? ` style="width:${x.width}%"` : ''}>`).join('')}</colgroup>
    <thead><tr>${columns.map((x) => `<th${NUMERIC_COLUMNS.includes(x.key) ? ' class="r"' : ''}>${esc(tx(x.label, noVat))}</th>`).join('')}</tr></thead>
    <tbody>${d.lines.map((l, i) => `<tr>${columns.map((x) => `<td${cls(x.key)}>${cell(x.key, l, i)}</td>`).join('')}</tr>`).join('')}<tr class="fill">${columns.map(() => '<td></td>').join('')}</tr></tbody></table>`;
  const tot = d.totals;
  const total = t.totals.ttc || t.totals.ht ? `<div class="ftotal"><div style="width:${lastWidth}%">${money(t.totals.ttc ? tot.ttc : tot.ht)}</div></div>` : '';
  const sumHeads = [t.totals.words ? '<th class="words">MONTANT EN LETTRES</th>' : '', t.totals.parcels ? '<th>NB COLIS</th>' : '', t.totals.ttc ? '<th>NET À PAYER</th>' : ''].join('');
  const sumVals = [
    t.totals.words ? `<td class="words">${esc(cap(numberToWordsFr(Math.max(0, tot.ttc))))}</td>` : '',
    t.totals.parcels ? `<td>${parcelCount(d.lines)}</td>` : '',
    t.totals.ttc ? `<td><b>${money(tot.ttc)}</b></td>` : '',
  ].join('');
  const after = [
    t.totals.ht && !noVat ? `${tx('Total HT', false)} : ${money(tot.ht)}` : '',
    t.totals.vatDetail && !noVat ? vatRows(d).filter((v) => v.tva).map((v) => `${v.label} : ${money(v.tva)}`).join(' · ') : '',
    t.totals.vatDetail && noVat ? 'TVA non applicable' : '',
    t.totals.discount && tot.discount ? `Remises accordées : ${money(tot.discount)}` : '',
    t.totals.payments ? d.payments.map((p) => `${esc(p.label)} : ${money(p.amount)}`).join(' · ') : '',
    t.totals.change && tot.change ? `Rendu monnaie : ${money(tot.change)}` : '',
    t.totals.remaining && tot.remaining ? `<b>Reste à payer : ${money(tot.remaining)}</b>` : '',
    cu.show && cu.balance && c?.balance != null ? `Solde de votre compte : <b>${money(c.balance)}</b>` : '',
  ].filter(Boolean);
  const ids = [h.niu && d.store.niu ? `N° CONTR. : ${esc(d.store.niu)}` : '', h.rccm && d.store.rccm ? `RCCM : ${esc(d.store.rccm)}` : ''];
  const titleHtml = `<h2>${esc(title.toUpperCase())}${t.info.number ? ` N° ${esc(d.doc.number)}` : ''}${d.doc.cancelled ? ' (ANNULÉE)' : ''}${
    d.doc.duplicate && t.footer.duplicate ? ' <span class="dup">DUPLICATA</span>' : ''
  }</h2>`;
  const side = t.page.style === 'side';
  const signs = signLabels(t, d);
  const body = `<div class="frame">
    ${
      side
        ? `<div class="fside"><div class="fhead">${logo}<div>${ident}</div></div><div class="ftitle left">${titleHtml}${box}</div></div>`
        : `<div class="fhead">${logo}<div>${ident}</div></div><div class="ftitle">${titleHtml}${box}</div>`
    }
    ${extra.length ? `<div class="fmag">${extra.join(' · ')}</div>` : ''}
    ${table}${total}
    <div class="fbottom"><div class="fremark">${nl(fill(t.footer.remark, d))}</div><table class="fsum"><tr>${sumHeads}</tr><tr>${sumVals}</tr></table></div>
    ${after.length ? `<div class="fextra">${after.join(' · ')}</div>` : ''}
    ${d.doc.notes ? `<div class="fextra notes">${nl(d.doc.notes)}</div>` : ''}
    ${t.footer.thanks ? `<div class="fslogan">${nl(fill(t.footer.thanks, d))}</div>` : ''}
    ${t.footer.text ? `<div class="notes">${nl(fill(t.footer.text, d))}</div>` : ''}
    ${ids.some(Boolean) ? `<div class="fids"><span>${ids[0]}</span><span>${ids[1]}</span></div>` : ''}
    ${signs.length ? `<div class="fsigns">${signs.map((x) => `<span>${nl(x.toUpperCase())}</span>`).join('')}</div>` : ''}
    <div class="fby"><span>${t.info.seller && d.doc.seller ? `${d.partyLabel ? 'ÉTABLI' : 'FACTURÉ'} PAR : ${esc(d.doc.seller.toUpperCase())}` : ''}</span><span>FEDONIX 360</span><span></span></div>
  </div>`;
  return body;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Zones de signature remplies (jusqu'à quatre), dans l'ordre gauche, 3e, 4e, droite. */
function signLabels(t: DocTemplate, d: DocData): string[] {
  if (!t.footer.signatures) return [];
  return [t.footer.signLeft, t.footer.sign3 ?? '', t.footer.sign4 ?? '', t.footer.signRight].map((x) => fill(x, d).trim()).filter(Boolean);
}

/** Lignes de totaux d'un ticket encadré ou détaillé : la partie TVA disparaît sans TVA ou décochée. */
function ticketTotals(t: DocTemplate, d: DocData) {
  const noVat = docWithoutVat(d);
  const tot = d.totals;
  const vat = t.totals.vatDetail && !noVat;
  return {
    noVat,
    vat,
    ht: t.totals.ht && !noVat,
    rows: vat ? vatRows(d).filter((v) => v.tva).map((v) => ({ label: v.label, value: v.tva })) : [],
    discount: t.totals.discount ? tot.discount : null,
    parcels: t.totals.parcels ? parcelCount(d.lines) : null,
  };
}

/** Valeur d'une colonne pour les tickets encadré et détaillé. */
function ticketCell(key: DocColumnKey, l: DocLine, i: number): string {
  switch (key) {
    case 'line': return String(i + 1);
    case 'code': return l.code ?? '';
    case 'barcode': return l.barcode ?? '';
    case 'label': return l.label;
    case 'qty': return l.qty;
    case 'unit': return (l.unit || l.unitName || '').toUpperCase();
    case 'unitPrice': return money(l.unitPrice);
    case 'unitPriceHt': return money(l.unitPriceHt);
    case 'discount': return l.discountLabel ?? (l.discount ? money(l.discount) : '');
    case 'vat': return formatRate(l.vatRate);
    case 'totalHt': return money(l.totalHt);
    case 'totalTtc': return money(l.totalTtc);
    case 'supplierRef': return l.supplierRef ?? '';
    case 'freeQty': return l.freeQty ?? '';
    case 'netCost': return l.netCost === undefined ? '' : money(l.netCost);
  }
}

function styledTicketCss(t: DocTemplate): string {
  return `
  .c { text-align: center; } .r { text-align: right !important; } .b { font-weight: bold; }
  h1 { font: 900 1.55em Georgia, serif; text-align: center; margin: 0 0 1mm; }
  .logo { text-align: center; } .logo img { max-height: ${t.header.logoSize}mm; max-width: 70%; }
  .id div { margin: 0; } .notes { white-space: pre-line; }
  .meta { margin-top: 2mm; }
  .wh { display: flex; justify-content: space-between; align-items: baseline; margin: 1.5mm 0 1mm; }
  .wh b { font: 900 1.2em Georgia, serif; }
  table { width: 100%; border-collapse: collapse; }
  .tb th { border: 1px solid #111; background: #e6e6e6; font-weight: bold; padding: 1px 3px; }
  .tb td { border-left: 1px solid #111; border-right: 1px solid #111; padding: 1px 3px; }
  .tb tr.n td { border-top: 1px solid #111; border-bottom: 1px dashed #111; padding-top: 2px; }
  .tb tr.q td { border-bottom: 1px solid #111; }
  .tb tr.s td { border: 1px solid #111; font-weight: bold; }
  .box { border: 1px solid #111; padding: 1px 6px; min-width: 30mm; text-align: center; font-weight: bold; display: inline-block; }
  .row { display: flex; justify-content: space-between; align-items: center; gap: 2mm; margin-top: 1mm; }
  .net { display: flex; justify-content: center; align-items: center; gap: 3mm; margin-top: 2mm; }
  .words { border: 1px solid #111; padding: 1.2mm; text-align: center; margin-top: 2mm; }
  .sum td { padding: 0.4mm 0; } .sum tr.ttc td { font-weight: bold; font-size: 1.25em; } .sum tr.ttc td.r { border-left: 1px solid #111; }
  .thanks { text-align: center; font-style: italic; margin-top: 2mm; }
  .soft { text-align: center; margin-top: 1.5mm; }
  .dup { font-weight: bold; letter-spacing: 2px; }
  .signs { display: flex; justify-content: space-between; gap: 4mm; margin-top: 3mm; min-height: 14mm; }
  .signs span:last-child { text-align: right; }`;
}

/** Ticket encadré ou détaillé en HTML (pilote Windows et aperçu). */
function styledTicketHtml(t: DocTemplate, d: DocData): string {
  const h = t.header;
  const detailed = t.page.style === 'detailed';
  const c = d.customer;
  const tt = ticketTotals(t, d);
  const tot = d.totals;
  const al = (line: DocLineKey) => sa(t.align?.[line]);
  const id = [
    h.logo && d.store.logo ? `<div class="logo"><img src="${esc(d.store.logo)}" alt=""></div>` : '',
    h.storeName ? `<h1${al('storeName')}>${esc(d.store.name)}</h1>` : '',
    `<div class="id${detailed ? ' c' : ''}">`,
    ...[d.store.message, h.message].filter(Boolean).map((m) => `<div class="notes"${al('message')}>${nl(fill(m, d))}</div>`),
    h.address && d.store.address ? `<div${al('address')}>${esc(d.store.address)}</div>` : '',
    h.niu && d.store.niu ? `<div${al('niu')}>NIU : ${esc(d.store.niu)}</div>` : '',
    h.rccm && d.store.rccm ? `<div${al('niu')}>RCCM : ${esc(d.store.rccm)}</div>` : '',
    h.phone && d.store.phone ? `<div${al('phone')}>Tél : ${esc(d.store.phone)}</div>` : '',
    '</div>',
  ].join('');
  const title = docTitle(t, d) || 'Facture';
  const when = t.info.date ? (t.info.time ? dateTimeFr(d.doc.date) : dayFr(d.doc.date)) : '';
  const client = t.customer.show ? `<div${al('customer')}>Client : ${esc((c?.name ?? 'Client comptoir').toUpperCase())}</div>` : '';
  const meta = [
    detailed ? client : '',
    t.info.number ? `<div${al('number')}>${esc(title.toUpperCase())} N° ${esc(d.doc.number)}${d.doc.cancelled ? ' (ANNULÉE)' : ''}</div>` : '',
    d.doc.duplicate && t.footer.duplicate ? '<div class="dup">DUPLICATA</div>' : '',
    t.info.seller && d.doc.seller ? `<div${al('seller')}>Vendeur : ${esc(d.doc.seller.toUpperCase())}</div>` : '',
    detailed ? '' : client,
    t.customer.show && c && !c.counter && t.customer.phone && c.phone ? `<div>Tél. client : ${esc(c.phone)}</div>` : '',
    t.info.priceLevel && d.doc.priceLevel ? `<div>Tarif : ${esc(d.doc.priceLevel)}</div>` : '',
    t.info.dueDate && d.doc.dueDate ? `<div>À régler avant le ${dayFr(d.doc.dueDate)}</div>` : '',
    ...(d.doc.extra ?? []).map((x) => `<div>${esc(x)}</div>`),
  ].join('');
  const wh = `<div class="wh"><b>${esc((d.doc.warehouse ?? '').toUpperCase())}</b><span>${when}</span></div>`;
  const columns = shown(t, d);
  const grid = columns.filter((x) => detailed || (x.key !== 'label' && x.key !== 'code'));
  const num = (x: DocColumn) => cellClass(columnAlign(x, x.key === 'qty' ? 'center' : undefined));
  const head = `<tr>${grid.map((x) => `<th${num(x)}>${esc(tx(x.label, tt.noVat))}</th>`).join('')}</tr>`;
  const rows = d.lines
    .map((l, i) => {
      const cells = `<tr class="q">${grid.map((x) => `<td${num(x)}>${esc(ticketCell(x.key, l, i))}</td>`).join('')}</tr>`;
      if (detailed) return cells;
      const name = [columns.some((x) => x.key === 'code') && l.code ? l.code : '', l.label].filter(Boolean).join(' ');
      return `<tr class="n"><td colspan="${grid.length}">${esc(name.toUpperCase())}</td></tr>${cells}`;
    })
    .join('');
  const sub = detailed && t.totals.ttc ? `<tr class="s"><td colspan="${grid.length}" class="r">${money(tot.ttc)}</td></tr>` : '';
  const table = `<table class="tb">${head}${rows}${sub}</table>`;
  const bottom = detailed
    ? `<table class="sum" style="margin-top:2mm">${[
        tt.ht ? `<tr><td>TOTAL HT</td><td class="r">${money(tot.ht)}</td></tr>` : '',
        ...tt.rows.map((v) => `<tr><td>${esc(v.label.toUpperCase())}</td><td class="r">${money(v.value)}</td></tr>`),
        tt.discount !== null ? `<tr><td>REMISE</td><td class="r">${money(tt.discount)}</td></tr>` : '',
        tt.parcels !== null ? `<tr><td>NB COLIS</td><td class="r">${tt.parcels}</td></tr>` : '',
        t.totals.ttc ? `<tr class="ttc"><td>${tt.noVat ? 'MONTANT' : 'MONTANT TTC'}</td><td class="r">${money(tot.ttc)}</td></tr>` : '',
      ].join('')}</table>`
    : [
        `<div class="row"><span>TOTAUX</span><span>${tt.parcels !== null ? `${tt.parcels} Colis` : ''}</span><span class="box">${money(tot.ttc)}</span></div>`,
        tt.vat || tt.ht ? `<div class="row" style="justify-content:center;gap:8mm">${tt.ht ? `<span>HT ${money(tot.ht)}</span>` : ''}${tt.vat ? `<span>TVA ${money(tot.tva)}</span>` : ''}</div>` : '',
        tt.discount ? `<div class="row" style="justify-content:center">Remise ${money(tt.discount)}</div>` : '',
        t.totals.ttc ? `<div class="net"><span>${tt.noVat ? 'Net à payer' : 'Net à payer TTC'} :</span><span class="box">${money(tot.ttc)}</span></div>` : '',
      ].join('');
  const pay = [
    t.totals.payments ? d.payments.map((p) => `<div class="row"><span>${esc(p.label)}</span><span>${money(p.amount)}</span></div>`).join('') : '',
    t.totals.change && tot.change ? `<div class="row"><span>Rendu monnaie</span><span>${money(tot.change)}</span></div>` : '',
    t.totals.remaining && tot.remaining ? `<div class="row b"><span>Reste à payer</span><span>${money(tot.remaining)}</span></div>` : '',
    t.customer.show && t.customer.balance && c?.balance != null ? `<div class="row"><span>Solde de votre compte</span><span>${money(c.balance)}</span></div>` : '',
    t.totals.words && tot.ttc >= 0 ? `<div class="words"${sa(lineAlign(t, 'payments', 'words', 'center'))}>${esc(cap(numberToWordsFr(tot.ttc)))}</div>` : '',
  ].join('');
  const foot = [
    d.doc.notes ? `<div class="notes" style="margin-top:2mm">${nl(d.doc.notes)}</div>` : '',
    ...signPairs(t, d).map(([a, b]) => `<div class="signs"><span>${a ? `${nl(a)} :` : ''}</span><span>${b ? `${nl(b)} :` : ''}</span></div>`),
    t.footer.text ? `<div class="notes c" style="margin-top:2mm;text-align:${lineAlign(t, 'footer', 'footerText', 'center')}">${nl(fill(t.footer.text, d))}</div>` : '',
    t.footer.thanks || d.store.thanks ? `<div class="thanks"${sa(lineAlign(t, 'footer', 'thanks', 'center'))}>${nl(fill(t.footer.thanks || d.store.thanks, d))}</div>` : '',
    '<div class="soft">FEDONIX 360</div>',
  ].join('');
  return arrangeHtml(t, { header: id, title: `<div class="meta">${meta}</div>${wh}`, lines: table, totals: bottom, payments: pay, footer: foot });
}

/** Ticket encadré ou détaillé pour l'imprimante ESC/POS (texte) : même contenu, sans cadres. */
function styledTicket(t: DocTemplate, d: DocData): Receipt {
  let r: Receipt = [];
  const parts: SectionParts<Receipt> = {};
  const h = t.header;
  const detailed = t.page.style === 'detailed';
  const c = d.customer;
  const tt = ticketTotals(t, d);
  const tot = d.totals;
  const centered = (text: string): ReceiptLine => ({ t: 'text', text, align: 'center' });
  const split = (text: string) => fill(text, d).split('\n').map((x) => x.trim()).filter(Boolean);
  const hd = (line: DocLineKey, text: string): Extract<ReceiptLine, { t: 'text' }> => ({ t: 'text', text, align: lineAlign(t, 'header', line, 'center') });
  if (h.logo && d.store.logo) r.push({ t: 'image', src: d.store.logo });
  if (h.storeName) r.push({ ...hd('storeName', d.store.name), bold: true, big: true });
  for (const m of [...split(d.store.message), ...split(h.message)]) r.push(hd('message', m));
  if (h.address && d.store.address) r.push(hd('address', d.store.address));
  if (h.niu && d.store.niu) r.push(hd('niu', `NIU : ${d.store.niu}`));
  if (h.rccm && d.store.rccm) r.push(hd('niu', `RCCM : ${d.store.rccm}`));
  if (h.phone && d.store.phone) r.push(hd('phone', `Tél : ${d.store.phone}`));
  (parts.header = r), (r = []);
  r.push({ t: 'feed' });
  const title = (docTitle(t, d) || 'Facture').toUpperCase();
  if (t.info.number) r.push({ t: 'text', text: `${title} N° ${d.doc.number}${d.doc.cancelled ? ' (ANNULÉE)' : ''}`, align: t.align?.number });
  if (duplicata(t, d)) r.push(DUPLICATA_BANNER);
  if (t.info.seller && d.doc.seller) r.push({ t: 'text', text: `Vendeur : ${d.doc.seller.toUpperCase()}`, align: t.align?.seller });
  if (t.customer.show) r.push({ t: 'text', text: `Client : ${(c?.name ?? 'Client comptoir').toUpperCase()}`, align: t.align?.customer });
  if (t.customer.show && c && !c.counter && t.customer.phone && c.phone) r.push({ t: 'text', text: `Tél. client : ${c.phone}` });
  if (t.info.priceLevel && d.doc.priceLevel) r.push({ t: 'text', text: `Tarif : ${d.doc.priceLevel}` });
  if (t.info.dueDate && d.doc.dueDate) r.push({ t: 'text', text: `À régler avant le ${dayFr(d.doc.dueDate)}` });
  for (const x of d.doc.extra ?? []) r.push({ t: 'text', text: x });
  const when = t.info.date ? (t.info.time ? dateTimeFr(d.doc.date) : dayFr(d.doc.date)) : '';
  r.push({ t: 'row', left: (d.doc.warehouse ?? '').toUpperCase(), right: when, bold: true });
  r.push({ t: 'rule' });
  (parts.title = r), (r = []);
  const columns = shown(t, d);
  const grid = columns.filter((x) => detailed || (x.key !== 'label' && x.key !== 'code'));
  // Colonnes alignées : chaque colonne prend la largeur de sa plus longue valeur ; la dernière est calée à droite.
  const lastKey = grid.at(-1)?.key;
  const lead = grid.slice(0, -1);
  const widths = lead.map((x) => Math.max(tx(x.label, tt.noVat).length, ...d.lines.map((l, i) => ticketCell(x.key, l, i).length)));
  const lineText = (cells: string[]) => cells.map((v, k) => padCell(v, widths[k]!, columnAlign(lead[k]!))).join('  ');
  r.push({ t: 'row', left: lineText(lead.map((x) => tx(x.label, tt.noVat))), right: grid.length ? tx(grid.at(-1)!.label, tt.noVat) : '', bold: true });
  d.lines.forEach((l, i) => {
    if (!detailed) r.push({ t: 'text', text: [columns.some((x) => x.key === 'code') && l.code ? l.code : '', l.label].filter(Boolean).join(' ').toUpperCase() });
    r.push({ t: 'row', left: lineText(lead.map((x) => ticketCell(x.key, l, i))), right: lastKey ? ticketCell(lastKey, l, i) : '' });
  });
  (parts.lines = r), (r = []);
  r.push({ t: 'rule' });
  if (detailed) {
    if (tt.ht) r.push({ t: 'row', left: 'TOTAL HT', right: money(tot.ht) });
    for (const v of tt.rows) r.push({ t: 'row', left: v.label.toUpperCase(), right: money(v.value) });
    if (tt.discount !== null) r.push({ t: 'row', left: 'REMISE', right: money(tt.discount) });
    if (tt.parcels !== null) r.push({ t: 'row', left: 'NB COLIS', right: String(tt.parcels) });
    if (t.totals.ttc) r.push({ t: 'row', left: tt.noVat ? 'MONTANT' : 'MONTANT TTC', right: money(tot.ttc), bold: true, big: true });
  } else {
    r.push({ t: 'row', left: `TOTAUX${tt.parcels !== null ? `   ${tt.parcels} Colis` : ''}`, right: money(tot.ttc) });
    if (tt.ht) r.push({ t: 'row', left: 'Total HT', right: money(tot.ht) });
    if (tt.vat) r.push({ t: 'row', left: 'TVA', right: money(tot.tva) });
    if (tt.discount) r.push({ t: 'row', left: 'Remise', right: money(tt.discount) });
    if (t.totals.ttc) r.push({ t: 'row', left: tt.noVat ? 'Net à payer' : 'Net à payer TTC', right: money(tot.ttc), bold: true, big: true });
  }
  (parts.totals = r), (r = []);
  if (t.totals.payments) for (const p of d.payments) r.push({ t: 'row', left: p.label, right: money(p.amount) });
  if (t.totals.change && tot.change) r.push({ t: 'row', left: 'Rendu monnaie', right: money(tot.change) });
  if (t.totals.remaining && tot.remaining) r.push({ t: 'row', left: 'Reste à payer', right: money(tot.remaining), bold: true });
  if (t.customer.show && t.customer.balance && c?.balance != null) r.push({ t: 'row', left: 'Solde de votre compte', right: money(c.balance) });
  if (t.totals.words && tot.ttc >= 0) r.push({ t: 'text', text: cap(numberToWordsFr(tot.ttc)), align: lineAlign(t, 'payments', 'words', 'center') });
  (parts.payments = r), (r = []);
  if (d.doc.notes) for (const x of d.doc.notes.split('\n').filter(Boolean)) r.push({ t: 'text', text: x });
  r.push(...receiptSigns(t, d));
  const ft = (line: DocLineKey) => (text: string): ReceiptLine => ({ t: 'text', text, align: lineAlign(t, 'footer', line, 'center') });
  const bottom = [...split(t.footer.text).map(ft('footerText')), ...split(t.footer.thanks || d.store.thanks).map(ft('thanks'))];
  if (bottom.length) r.push({ t: 'rule' }, ...bottom);
  r.push(centered('FEDONIX 360'));
  if (duplicata(t, d)) r.push({ t: 'feed' }, DUPLICATA_BANNER);
  parts.footer = r;
  return arrangeReceipt(t, parts);
}

/** Facture d'exemple pour l'aperçu d'un modèle quand le magasin n'a pas encore vendu. */
export function sampleDocData(variant: DocVariant, store?: Partial<DocData['store']>): DocData {
  const credit = variant === 'credit';
  const line = (code: string, label: string, qty: number, unit: string, unitPrice: number, vatRate: number, discount = 0): DocLine => {
    const totalTtc = qty * unitPrice - discount;
    const totalHt = splitTtc(totalTtc, vatRate).ht;
    return { code, barcode: `61${code.replace(/\D/g, '').padStart(11, '0')}`, label, qty: String(qty), unit, unitPrice, unitPriceHt: splitTtc(unitPrice, vatRate).ht, discount, vatRate, totalHt, totalTtc, promo: 0, promoName: null, detail: qty !== 1 || Boolean(unit), unitName: unit ? undefined : 'Pièce' };
  };
  const lines = [
    line('BOI012', 'Bière Castel 65 cl', 2, 'CASIER', 7800, 1925),
    line('RIZ005', "Riz parfumé Uncle Ben's 5 kg", 3, '', 4500, 0, 500),
    line('HUI010', 'Huile Diamaor 1 L', 1, '', 1350, 1925),
  ];
  const ttc = lines.reduce((s, l) => s + l.totalTtc, 0);
  const ht = lines.reduce((s, l) => s + l.totalHt, 0);
  if (variant === 'order' || variant === 'supplierInvoice') return samplePurchase(variant, store);
  const quote = variant === 'quote' || variant === 'proforma';
  const known = credit || quote || variant === 'delivery';
  const paid = credit ? 10000 : quote ? 0 : ttc + 650;
  const inDays = (n: number) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
  return {
    store: { name: 'Mon magasin', address: 'Rue principale, Douala', phone: '6 99 00 00 00', niu: 'M000000000000A', rccm: '', logo: '', message: '', thanks: 'Merci de votre visite !', vatEnabled: true, ...store },
    customer: known
      ? { name: 'Ets MBALLA & Fils', code: 'C0012', address: 'Marché central, Douala', phone: '6 77 12 34 56', niu: 'P123456789012B', balance: credit ? 245000 : null, counter: false }
      : null,
    doc: {
      kind: quote ? 'quote' : 'sale',
      number: quote ? `${variant === 'proforma' ? 'PF' : 'DV'}-DLA1-00012` : 'DLA1-1-000123',
      date: new Date().toISOString(),
      dueDate: credit ? inDays(30) : null,
      seller: 'Awa',
      register: quote ? null : 'Caisse 1',
      priceLevel: credit || quote ? 'Gros' : null,
      cancelled: false,
      duplicate: false,
      validUntil: quote ? inDays(15) : null,
      notes: quote ? 'Livraison possible à Bonabéri.' : null,
      warehouse: quote ? null : 'Surface de vente',
    },
    lines,
    payments: credit ? [{ label: 'Espèces', amount: 10000 }, { label: 'Crédit client', amount: ttc - 10000 }] : quote ? [] : [{ label: 'Espèces', amount: paid }],
    totals: { ht, tva: ttc - ht, ttc, discount: 500, promo: 0, rounding: 0, change: credit || quote ? 0 : paid - ttc, remaining: credit ? ttc - 10000 : 0 },
  };
}

/** Bon de commande ou facture d'achat d'exemple. */
function samplePurchase(variant: 'order' | 'supplierInvoice', store?: Partial<DocData['store']>): DocData {
  const invoice = variant === 'supplierInvoice';
  const line = (ref: string, code: string, label: string, qty: number, gross: number, discountPct: number, free: number): DocLine => {
    const net = Math.round((gross * (100 - discountPct)) / 100);
    const totalHt = qty * net;
    return {
      code, barcode: null, label, qty: String(qty), unit: '', unitPrice: gross, unitPriceHt: gross, discount: 0, vatRate: 1925, totalHt, totalTtc: totalHt,
      promo: 0, promoName: null, detail: true, supplierRef: ref, discountLabel: discountPct ? `${discountPct} %` : '', freeQty: free ? String(free) : '', netCost: net,
    };
  };
  const lines = [line('CAS-65', 'BOI012', 'Bière Castel 65 cl (casier de 12)', 20, 6500, 0, 1), line('UB5', 'RIZ005', "Riz parfumé Uncle Ben's 5 kg", 30, 3800, 5, 0), line('DIA1', 'HUI010', 'Huile Diamaor 1 L', 48, 1050, 0, 0)];
  const ht = lines.reduce((s, l) => s + l.totalHt, 0);
  const tva = Math.round((ht * 1925) / 10000);
  const inDays = (n: number) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
  return {
    store: { name: 'Mon magasin', address: 'Rue principale, Douala', phone: '6 99 00 00 00', niu: 'M000000000000A', rccm: '', logo: '', message: '', thanks: '', vatEnabled: true, ...store },
    customer: { name: 'SABC Distribution', code: 'F0003', address: 'Zone industrielle de Bassa, Douala', phone: '2 33 40 00 00', niu: 'M098765432109C', balance: null, counter: false },
    partyLabel: 'Fournisseur',
    doc: {
      kind: 'purchase',
      number: invoice ? 'FA-DLA1-00045' : 'BC-DLA1-00031',
      date: new Date().toISOString().slice(0, 10),
      dueDate: invoice ? inDays(30) : null,
      seller: 'Steve',
      register: null,
      priceLevel: null,
      cancelled: false,
      duplicate: false,
      notes: invoice ? null : 'Livraison le matin avant 10 h.',
      extra: invoice ? [`Facture du fournisseur n° 2026-8841 du ${new Date().toLocaleDateString('fr-FR')}`] : [`Livraison souhaitée : ${new Date(Date.now() + 3 * 86400000).toLocaleDateString('fr-FR')}`, 'Livrer à : Magasin principal'],
    },
    lines,
    payments: invoice ? [{ label: 'Virement', amount: 300000 }] : [],
    totals: { ht, tva: invoice ? tva : 0, ttc: invoice ? ht + tva : ht, discount: 0, promo: 0, rounding: 0, change: 0, remaining: invoice ? ht + tva - 300000 : 0 },
  };
}
