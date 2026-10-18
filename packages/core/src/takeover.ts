/**
 * Reprise des données d'un magasin existant (KONTROL, Sage, cahier, Excel) :
 * lecture des fichiers clients, fournisseurs et stock de départ, une ligne par
 * fiche. Les en-têtes sont reconnus sans accents ni majuscules, dans l'ordre
 * qu'on veut ; une ligne illisible est signalée avec son numéro, sans bloquer
 * les autres.
 */
import type { PriceLevel } from './packs';

export type TakeoverKind = 'customers' | 'suppliers' | 'stock';

export const TAKEOVER_KINDS: Record<TakeoverKind, string> = {
  customers: 'Clients et ce qu’ils doivent',
  suppliers: 'Fournisseurs et ce qu’on leur doit',
  stock: 'Stock de départ',
};

/** Client repris : fiche, et ce qu'il doit à la date de reprise (négatif : avoir du client). */
export interface TakeoverCustomer {
  line: number;
  name: string;
  phone: string | null;
  address: string | null;
  taxpayerNumber: string | null;
  creditLimit: number | null;
  paymentTermsDays: number | null;
  priceLevel: PriceLevel | null;
  balance: number;
  docRef: string | null;
  docDate: string | null;
  dueDate: string | null;
}

/** Fournisseur repris : fiche, et ce qu'on lui doit (négatif : avoir chez lui). */
export interface TakeoverSupplier {
  line: number;
  name: string;
  phone: string | null;
  address: string | null;
  taxpayerNumber: string | null;
  paymentTermsDays: number | null;
  balance: number;
  docRef: string | null;
  docDate: string | null;
  dueDate: string | null;
}

/** Stock de départ d'un article : quantité en unités de stock (pièce, kg, litre), coût de revient unitaire. */
export interface TakeoverStock {
  line: number;
  /** Code-barres, code interne ou désignation exacte. */
  ref: string;
  qty: number;
  unitCost: number | null;
  lotNumber: string | null;
  expiry: string | null;
}

export interface TakeoverParsed<T> {
  rows: T[];
  errors: { line: number; message: string }[];
}

/** En-têtes reconnus pour chaque champ (sans accents, minuscules, espaces et tirets en _). */
const HEADERS = {
  name: ['nom', 'name', 'client', 'fournisseur', 'raison_sociale', 'intitule', 'libelle', 'designation_tiers', 'intitule_tiers', 'nom_du_tiers', 'nom_reduit'],
  phone: ['telephone', 'tel', 'phone', 'portable', 'contact_tel', 'mobile', 'n_telephone', 'numero_de_telephone', 'telephone_1'],
  address: ['adresse', 'address', 'adresse_1', 'adresse1', 'ville', 'quartier', 'complement'],
  taxpayer: ['niu', 'nif', 'numero_contribuable', 'contribuable', 'n_identifiant', 'identifiant', 'n_contribuable', 'numero_identifiant', 'n_siret', 'n_de_siret'],
  limit: ['plafond', 'plafond_credit', 'credit_max', 'encours_max', 'limite', 'encours_autorise', 'encours_maximum', 'plafond_autorise'],
  terms: ['delai', 'delai_paiement', 'delai_de_paiement', 'jours', 'echeance_jours'],
  level: ['tarif', 'categorie_tarifaire', 'prix'],
  balance: ['solde', 'doit', 'montant_du', 'reste_a_payer', 'du', 'dette', 'creance', 'montant', 'solde_tiers', 'solde_du_compte', 'solde_comptable', 'reste_du', 'encours'],
  docRef: ['facture', 'piece', 'reference', 'ref', 'numero_facture', 'n_facture', 'n_piece', 'numero_piece', 'n_document'],
  docDate: ['date', 'date_facture', 'date_piece'],
  dueDate: ['echeance', 'date_echeance', 'date_limite_paiement', 'date_d_echeance'],
  ref: ['code_barres', 'codebarre', 'code_barre', 'ean', 'code', 'code_article', 'reference', 'reference_article', 'ref', 'article', 'designation', 'designation_1', 'produit', 'nom'],
  qty: ['quantite', 'qte', 'qty', 'stock', 'stock_reel', 'quantite_en_stock', 'qte_en_stock', 'qte_stock', 'stock_physique'],
  cost: ['cout', 'cout_unitaire', 'prix_revient', 'prix_de_revient', 'cmup', 'pmp', 'prix_achat', 'cout_achat', 'prix_unitaire_moyen', 'pump', 'prix_d_achat', 'prix_achat_standard'],
  lot: ['lot', 'numero_lot', 'n_lot'],
  expiry: ['peremption', 'dlc', 'date_limite', 'date_peremption', 'expiration', 'dluo'],
} as const;

const norm = (h: string) =>
  h
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[°º.]/g, '')
    .replace(/[\s'’/-]+/g, '_')
    .replace(/^_+|_+$/g, '');

/** Montant ou quantité tapé à la française : « 1 500 », « 1 500,50 », « 1.500 » (milliers), « -2 000 ». */
export function parseFrNumber(raw: string): number | null {
  let s = raw.replace(/[\s  ]/g, '').replace(/(fcfa|f|cfa|xaf)$/i, '');
  if (!s) return null;
  const negative = /^\(.*\)$/.test(s) || s.startsWith('-');
  s = s.replace(/^[(-]|\)$/g, '');
  // « 1.500 » ou « 1.500.000 » : points des milliers ; « 1,5 » ou « 1.5 » : décimales.
  if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
  else if (/^\d{1,3}(,\d{3})+$/.test(s) && !s.includes('.')) s = s.replace(/,/g, '');
  else s = s.replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return negative ? -n : n;
}

/** Date en JJ/MM/AAAA, JJ-MM-AA, AAAA-MM-JJ ou numéro de série Excel ; null si vide, undefined si illisible. */
export function parseFrDate(raw: string): string | null | undefined {
  const s = raw.trim();
  if (!s) return null;
  const pad = (n: number) => String(n).padStart(2, '0');
  const valid = (y: number, m: number, d: number) => {
    const t = new Date(Date.UTC(y, m - 1, d));
    return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d ? `${y}-${pad(m)}-${pad(d)}` : undefined;
  };
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return valid(Number(m[1]), Number(m[2]), Number(m[3]));
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/);
  if (m) {
    const y = Number(m[3]);
    return valid(y < 100 ? 2000 + y : y, Number(m[2]), Number(m[1]));
  }
  // Cellule date d'Excel lue comme un nombre de jours depuis le 30/12/1899.
  if (/^\d{5}(\.\d+)?$/.test(s)) {
    const t = new Date(Date.UTC(1899, 11, 30) + Math.floor(Number(s)) * 86_400_000);
    return valid(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
  }
  return undefined;
}

function parseLevel(raw: string): PriceLevel | null | undefined {
  const s = norm(raw);
  if (!s) return null;
  if (s.startsWith('super')) return 'super_wholesale';
  if (s.startsWith('gros') || s === 'grossiste') return 'wholesale';
  if (s.startsWith('detail') || s === 'normal') return 'retail';
  return undefined;
}

function table(rows: string[][]) {
  const clean = rows.map((r) => r.map((c) => (c ?? '').toString().replace(/^"|"$/g, '').trim()));
  const headerAt = clean.findIndex((r) => r.some((c) => c));
  const head = (clean[headerAt] ?? []).map(norm);
  const index = (names: readonly string[]) => {
    for (const n of names) {
      const i = head.indexOf(n);
      if (i >= 0) return i;
    }
    return -1;
  };
  const body = clean
    .map((cells, i) => ({ cells, line: i + 1 }))
    .slice(headerAt + 1)
    .filter((r) => r.cells.some((c) => c));
  return { head, index, body };
}

/** Champs communs aux clients et fournisseurs. */
function readParty(rows: string[][], kind: 'customers' | 'suppliers') {
  const { index, body } = table(rows);
  const col = {
    name: index(HEADERS.name),
    phone: index(HEADERS.phone),
    address: index(HEADERS.address),
    taxpayer: index(HEADERS.taxpayer),
    limit: index(HEADERS.limit),
    terms: index(HEADERS.terms),
    level: index(HEADERS.level),
    balance: index(HEADERS.balance),
    docRef: index(HEADERS.docRef),
    docDate: index(HEADERS.docDate),
    dueDate: index(HEADERS.dueDate),
  };
  const errors: { line: number; message: string }[] = [];
  if (col.name < 0) {
    errors.push({ line: 1, message: `Colonne « nom » introuvable : la première ligne doit porter les en-têtes (nom ; telephone ; solde…)` });
    return { parsed: [], errors };
  }
  const parsed = body.flatMap(({ cells, line }) => {
    const get = (i: number) => (i >= 0 ? (cells[i] ?? '') : '');
    const name = get(col.name);
    const fail = (message: string) => {
      errors.push({ line, message: `${name || 'Ligne sans nom'} : ${message}` });
      return [];
    };
    if (!name) return fail(`le nom ${kind === 'customers' ? 'du client' : 'du fournisseur'} est vide`);
    const balanceRaw = get(col.balance);
    const balance = balanceRaw ? parseFrNumber(balanceRaw) : 0;
    if (balance === null) return fail(`solde illisible (« ${balanceRaw} »)`);
    const limitRaw = get(col.limit);
    const limit = limitRaw ? parseFrNumber(limitRaw) : null;
    if (limitRaw && (limit === null || limit < 0)) return fail(`plafond illisible (« ${limitRaw} »)`);
    const termsRaw = get(col.terms);
    const terms = termsRaw ? parseFrNumber(termsRaw.replace(/j(ours?)?$/i, '')) : null;
    if (termsRaw && (terms === null || terms < 0 || !Number.isInteger(terms))) return fail(`délai de paiement illisible (« ${termsRaw} »), indiquez un nombre de jours`);
    const docDate = parseFrDate(get(col.docDate));
    if (docDate === undefined) return fail(`date illisible (« ${get(col.docDate)} »), écrivez-la JJ/MM/AAAA`);
    const dueDate = parseFrDate(get(col.dueDate));
    if (dueDate === undefined) return fail(`échéance illisible (« ${get(col.dueDate)} »), écrivez-la JJ/MM/AAAA`);
    const level = parseLevel(get(col.level));
    if (level === undefined) return fail(`tarif inconnu (« ${get(col.level)} ») : détail, gros ou super gros`);
    return [
      {
        line,
        name,
        phone: get(col.phone) || null,
        address: get(col.address) || null,
        taxpayerNumber: get(col.taxpayer) || null,
        creditLimit: limit === null ? null : Math.round(limit),
        paymentTermsDays: terms,
        priceLevel: level,
        balance: Math.round(balance),
        docRef: get(col.docRef) || null,
        docDate,
        dueDate,
      },
    ];
  });
  return { parsed, errors };
}

export function parseTakeoverCustomers(rows: string[][]): TakeoverParsed<TakeoverCustomer> {
  const { parsed, errors } = readParty(rows, 'customers');
  return { rows: parsed, errors };
}

export function parseTakeoverSuppliers(rows: string[][]): TakeoverParsed<TakeoverSupplier> {
  const { parsed, errors } = readParty(rows, 'suppliers');
  return { rows: parsed.map(({ creditLimit: _l, priceLevel: _p, ...r }) => r), errors };
}

export function parseTakeoverStock(rows: string[][]): TakeoverParsed<TakeoverStock> {
  const { index, body } = table(rows);
  const col = { ref: index(HEADERS.ref), qty: index(HEADERS.qty), cost: index(HEADERS.cost), lot: index(HEADERS.lot), expiry: index(HEADERS.expiry) };
  const errors: { line: number; message: string }[] = [];
  if (col.ref < 0 || col.qty < 0) {
    errors.push({ line: 1, message: 'Colonnes « code » (ou « designation ») et « quantite » introuvables : la première ligne doit porter les en-têtes' });
    return { rows: [], errors };
  }
  const parsed = body.flatMap(({ cells, line }) => {
    const get = (i: number) => (i >= 0 ? (cells[i] ?? '') : '');
    const ref = get(col.ref);
    const fail = (message: string) => {
      errors.push({ line, message: `${ref || 'Ligne sans code'} : ${message}` });
      return [];
    };
    if (!ref) return fail('code ou désignation vide');
    const qty = parseFrNumber(get(col.qty));
    if (qty === null) return fail(`quantité illisible (« ${get(col.qty)} »)`);
    if (qty < 0) return fail('quantité négative : le stock de départ se reprend positif');
    const costRaw = get(col.cost);
    const cost = costRaw ? parseFrNumber(costRaw) : null;
    if (costRaw && (cost === null || cost < 0)) return fail(`coût illisible (« ${costRaw} »)`);
    const expiry = parseFrDate(get(col.expiry));
    if (expiry === undefined) return fail(`date de péremption illisible (« ${get(col.expiry)} »), écrivez-la JJ/MM/AAAA`);
    return [{ line, ref, qty, unitCost: cost === null ? null : Math.round(cost), lotNumber: get(col.lot) || null, expiry }];
  });
  return { rows: parsed, errors };
}

/** Modèle à remplir pour chaque fichier : en-têtes et deux lignes d'exemple. */
export const TAKEOVER_TEMPLATES: Record<TakeoverKind, string[][]> = {
  customers: [
    ['nom', 'telephone', 'adresse', 'niu', 'plafond', 'delai', 'tarif', 'solde', 'facture', 'date', 'echeance'],
    ['Chez Mballa', '677 00 00 01', 'Akwa, Douala', '', '200 000', '30', 'gros', '85 000', 'FA-1204', '28/09/2026', '28/10/2026'],
    ['Mme Ngo Bassa', '699 12 34 56', 'Bonapriso', '', '50 000', '15', 'détail', '0', '', '', ''],
  ],
  suppliers: [
    ['nom', 'telephone', 'adresse', 'niu', 'delai', 'solde', 'facture', 'date', 'echeance'],
    ['SABC', '233 42 31 44', 'Koumassi, Douala', 'M0123456789', '30', '1 250 000', 'F-55821', '30/09/2026', '30/10/2026'],
    ['Grossiste Mokolo', '677 55 44 33', 'Yaoundé', '', '0', '0', '', '', ''],
  ],
  stock: [
    ['code', 'designation', 'quantite', 'cout', 'lot', 'peremption'],
    ['6111234567895', 'Riz parfumé 5 kg', '48', '3 800', '', ''],
    ['6009876543219', 'Lait concentré 397 g', '120', '520', 'L2409', '31/03/2027'],
  ],
};
