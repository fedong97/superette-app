import { type DocTemplate, normalizeDefaults, normalizeTemplates } from './docTemplates';

/**
 * Paramètres du magasin (Administration › Paramètres) : règles de vente, de
 * crédit, de stock, d'achat, de sécurité et de numérotation. Ils voyagent
 * avec la fiche du magasin vers tous ses postes. Une valeur absente prend sa
 * valeur par défaut, qui reprend le fonctionnement d'avant ces paramètres.
 */
export interface StoreSettings {
  /** Registre du commerce, imprimé sous le NIU. */
  rccm: string;
  /** Message imprimé en haut du ticket (sous le nom du magasin). */
  ticketHeader: string;
  /** Logo imprimé sur le ticket et les factures : image PNG en data URL, ou vide. */
  logo: string;

  /** Remise maximale (en % du ticket) que tout vendeur accorde sans le code du gérant ; 0 : aucune. */
  maxDiscountPct: number;
  /** Arrondi des ventes payées entièrement en espèces, au multiple inférieur (en faveur du client). */
  cashRounding: 1 | 5 | 10 | 25 | 50;
  /** Nombre de tickets imprimés à chaque vente. */
  ticketCopies: number;
  /** Au-delà de ce montant, le nom du client est obligatoire ; 0 : jamais. */
  customerRequiredAbove: number;
  /** Délai maximal pour annuler une vente, en minutes ; 0 : sans limite. */
  cancelMinutes: number;
  /** Nombre maximal de factures en attente par caisse ; 0 : sans limite. */
  maxHeld: number;
  /** Autoriser un prix négocié sous le coût de revient (avec le code du gérant). */
  allowBelowCost: boolean;

  /** Plafond de crédit proposé pour un nouveau client ; 0 : pas de crédit. */
  creditDefaultLimit: number;
  /** Délai de paiement proposé pour un nouveau client, en jours. */
  creditDefaultDays: number;
  /** Refuser une vente à crédit au client qui a une facture échue non payée. */
  creditBlockLate: boolean;

  /** Les lots qui périment dans ce nombre de jours sont signalés. */
  expiryAlertDays: number;
  /** Stock d'alerte proposé pour un nouveau produit (en unités) ; 0 : aucun. */
  defaultAlertQty: number;
  /** Un transfert est réceptionné par un autre utilisateur que celui qui l'a expédié. */
  transferTwoUsers: boolean;

  /** Délai de paiement proposé pour un nouveau fournisseur, en jours. */
  supplierDefaultDays: number;
  /** Marge proposée sur le prix de revient pour le prix de vente, en % ; 0 : pas de proposition. */
  defaultMarginPct: number;

  /** Déconnexion automatique après ce nombre de minutes sans activité ; 0 : jamais. */
  idleMinutes: number;
  /** Longueur minimale du code d'un utilisateur. */
  pinMinLength: number;
  /** Blocage de 15 minutes après ce nombre de codes faux de suite ; 0 : jamais. */
  maxLoginAttempts: number;

  /**
   * Caisses électroniques : « central », chaque caissier verse sa recette vers la
   * caisse électronique centrale à la clôture ; « independent », chaque caisse
   * garde son solde d'un jour à l'autre.
   */
  emoneyMode: 'central' | 'independent';
  /** Caisse électronique centrale du magasin (Mobile Money du magasin) ; vide : pas encore choisie. */
  emoneyCentralRegisterId: string;

  /** Préfixes ajoutés devant les numéros des pièces. */
  prefixSale: string;
  prefixReturn: string;
  prefixQuote: string;
  prefixProforma: string;
  prefixOrder: string;

  /** Présentation de l'écran de caisse pour tout le magasin ; un poste peut avoir son exception (Paramètres). */
  posLayout: PosLayout;

  /** Modèles d'impression modifiés ou ajoutés (ceux du logiciel servent pour le reste). */
  printTemplates: DocTemplate[];
  /** Modèle choisi par emplacement (« invoice.a4.credit ») : identifiant de modèle. */
  printDefaults: Record<string, string>;
}

/** Présentations de l'écran de caisse : mêmes fonctions et mêmes touches, disposition différente. */
export type PosLayout = 'modern' | 'classic' | 'conventional';
export const POS_LAYOUTS: Record<PosLayout, string> = { modern: 'Moderne', classic: 'Classique', conventional: 'Conventionnel' };

export const DEFAULT_STORE_SETTINGS: StoreSettings = {
  rccm: '',
  ticketHeader: '',
  logo: '',
  maxDiscountPct: 0,
  cashRounding: 1,
  ticketCopies: 1,
  customerRequiredAbove: 0,
  cancelMinutes: 0,
  maxHeld: 0,
  allowBelowCost: false,
  creditDefaultLimit: 0,
  creditDefaultDays: 30,
  creditBlockLate: false,
  expiryAlertDays: 30,
  defaultAlertQty: 0,
  transferTwoUsers: false,
  supplierDefaultDays: 30,
  defaultMarginPct: 0,
  idleMinutes: 0,
  pinMinLength: 4,
  maxLoginAttempts: 0,
  emoneyMode: 'central',
  emoneyCentralRegisterId: '',
  prefixSale: '',
  prefixReturn: '',
  prefixQuote: 'DV',
  prefixProforma: 'PF',
  prefixOrder: 'BC',
  posLayout: 'modern',
  printTemplates: [],
  printDefaults: {},
};

const ROUNDINGS = [1, 5, 10, 25, 50];
/** Bornes des nombres : [minimum, maximum]. */
const BOUNDS: Partial<Record<keyof StoreSettings, [number, number]>> = {
  maxDiscountPct: [0, 100],
  ticketCopies: [1, 3],
  customerRequiredAbove: [0, 1e10],
  cancelMinutes: [0, 100000],
  maxHeld: [0, 100],
  creditDefaultLimit: [0, 1e10],
  creditDefaultDays: [0, 365],
  expiryAlertDays: [1, 365],
  defaultAlertQty: [0, 1e6],
  supplierDefaultDays: [0, 365],
  defaultMarginPct: [0, 1000],
  idleMinutes: [0, 480],
  pinMinLength: [4, 8],
  maxLoginAttempts: [0, 20],
};
const TEXT_MAX: Partial<Record<keyof StoreSettings, number>> = { rccm: 40, ticketHeader: 120, logo: 400_000 };
const PREFIXES: (keyof StoreSettings)[] = ['prefixSale', 'prefixReturn', 'prefixQuote', 'prefixProforma', 'prefixOrder'];

/**
 * Valide un changement de paramètres et renvoie les paramètres complets.
 * Lève une erreur en français pour une valeur hors bornes.
 */
export function mergeStoreSettings(current: Partial<StoreSettings> | null, patch: Partial<StoreSettings>): StoreSettings {
  const next: StoreSettings = { ...DEFAULT_STORE_SETTINGS, ...(current ?? {}) };
  for (const [k, raw] of Object.entries(patch) as [keyof StoreSettings, unknown][]) {
    if (!(k in DEFAULT_STORE_SETTINGS)) throw new Error(`Paramètre inconnu : ${k}`);
    const def = DEFAULT_STORE_SETTINGS[k];
    if (k === 'printTemplates') {
      next.printTemplates = normalizeTemplates(raw);
    } else if (k === 'printDefaults') {
      next.printDefaults = normalizeDefaults(raw);
    } else if (typeof def === 'boolean') {
      (next as unknown as Record<string, unknown>)[k] = Boolean(raw);
    } else if (typeof def === 'number') {
      const n = Number(raw);
      if (!Number.isFinite(n) || !Number.isInteger(n)) throw new Error('Nombre entier attendu');
      if (k === 'cashRounding' && !ROUNDINGS.includes(n)) throw new Error('Arrondi possible : 1, 5, 10, 25 ou 50 FCFA');
      const b = BOUNDS[k];
      if (b && (n < b[0] || n > b[1])) throw new Error(`Valeur entre ${b[0]} et ${b[1]} attendue`);
      (next as unknown as Record<string, unknown>)[k] = n;
    } else {
      let s = String(raw ?? '').trim();
      if (PREFIXES.includes(k)) {
        s = s.toUpperCase();
        if (!/^[A-Z0-9]{0,6}$/.test(s)) throw new Error('Préfixe : 6 lettres ou chiffres au plus, sans espace');
      }
      if (k === 'logo' && s && !s.startsWith('data:image/')) throw new Error('Logo : image attendue');
      if (k === 'posLayout' && !(s in POS_LAYOUTS)) throw new Error("Présentation de l'écran de caisse : moderne, classique ou conventionnel");
      if (k === 'emoneyMode' && s !== 'central' && s !== 'independent') throw new Error('Mode des caisses électroniques : centrale ou indépendantes');
      const max = TEXT_MAX[k];
      if (max && s.length > max) throw new Error(k === 'logo' ? 'Logo trop lourd : choisissez une image plus petite' : `Texte trop long (${max} caractères au plus)`);
      (next as unknown as Record<string, unknown>)[k] = s;
    }
  }
  return next;
}

/** Paramètres lus depuis la fiche du magasin (JSON), complétés par les valeurs par défaut. */
export function parseStoreSettings(json: string | null | undefined): StoreSettings {
  if (!json) return { ...DEFAULT_STORE_SETTINGS };
  try {
    return { ...DEFAULT_STORE_SETTINGS, ...(JSON.parse(json) as Partial<StoreSettings>) };
  } catch {
    return { ...DEFAULT_STORE_SETTINGS };
  }
}

/** Montant arrondi d'un ticket payé en espèces : au multiple inférieur de l'arrondi. */
export function roundCash(total: number, rounding: number): number {
  if (rounding <= 1 || total <= 0) return total;
  return total - (total % rounding);
}

/** Numéro d'une pièce avec son préfixe : « DV-01-00012 », ou sans préfixe « 01-00012 ». */
export function withPrefix(prefix: string, rest: string): string {
  return prefix ? `${prefix}-${rest}` : rest;
}
