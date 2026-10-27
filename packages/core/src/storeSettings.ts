import { type BadgeLayout, DEFAULT_BADGE, normalizeBadge } from './badge';
import { DEFAULT_BRAND_COLOR, DEFAULT_BRAND_COLOR2, isHexColor } from './brand';
import { type DocTemplate, normalizeDefaults, normalizeTemplates } from './docTemplates';
import { type BarcodeLabelFormatId, isBarcodeLabelFormat } from './labels';
import { DEFAULT_PAYROLL, normalizePayroll, type PayrollRules } from './payroll';
import { parseHolidays } from './personnel';

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
  /** Couleurs de l'entreprise (#rrggbb) : toute l'application, le badge et les documents A4 les prennent. */
  brandColor: string;
  brandColor2: string;
  /** Format et contenu du badge du personnel. */
  badge: BadgeLayout;

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

  /** Durée de validité d'un bon d'achat, en jours ; 0 : sans limite. */
  voucherValidityDays: number;
  /** Plafond d'espèces dans le tiroir : au-delà, alerte et prélèvement proposé vers la caisse centrale ; 0 : pas de plafond. */
  cashCeiling: number;
  /** Monnaie que le caissier n'a pas : mise sur le compte du client, ou en bon de monnaie. */
  changeToAccount: boolean;
  /** Contrôle des tickets à la sortie du magasin (vigile, téléphone ou PC à la porte). */
  exitCheck: boolean;
  /** Un ticket plus vieux que ce nombre d'heures est signalé au contrôle de sortie. */
  exitCheckHours: number;

  /** Plafond de crédit proposé pour un nouveau client ; 0 : pas de crédit. */
  creditDefaultLimit: number;
  /** Délai de paiement proposé pour un nouveau client, en jours. */
  creditDefaultDays: number;
  /** Refuser une vente à crédit au client qui a une facture échue non payée. */
  creditBlockLate: boolean;
  /** Message de relance des clients par WhatsApp ; vide : le message proposé par le logiciel. */
  reminderTemplate: string;

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
  /** Commandes clients (prises par téléphone ou WhatsApp). */
  prefixCustomerOrder: string;

  /** Présentation de l'écran de caisse pour tout le magasin ; un poste peut avoir son exception (Paramètres). */
  posLayout: PosLayout;
  /** Rôles dont la fiche de vente s'ouvre en mode « Caisse seule » (plein écran, sans menus), séparés par des virgules. */
  posFullRoles: string;

  /** Donner un code-barres interne à l'enregistrement d'un article sans code (unité, cartons et packs). */
  barcodeAuto: boolean;
  /** Format des codes internes : EAN-8 (2xxxxxxx), court, ou EAN-13 (20xxxxxxxxxxx). */
  barcodeKind: BarcodeKind;
  /** Codification des nouveaux articles par famille (BOI-DLA11-0012) au lieu du seul numéro du poste. */
  articleCodeByFamily: boolean;
  /** Étiquettes produit : format et contenu proposés par défaut. */
  labelFormat: BarcodeLabelFormatId;
  labelName: boolean;
  labelPrice: boolean;
  labelStore: boolean;
  /** Après une réception d'achat, proposer les étiquettes des articles à code interne. */
  labelAfterReception: boolean;

  /** Carte de fidélité : les clients enregistrés gagnent des points et paient avec. */
  loyaltyEnabled: boolean;
  /** Montant d'achat qui donne 1 point. */
  loyaltySpendPerPoint: number;
  /** Valeur d'un point en FCFA quand le client paie avec ses points. */
  loyaltyPointValue: number;
  /** Points à avoir au minimum pour payer avec. */
  loyaltyMinRedeem: number;

  /** Pointage : heure d'arrivée attendue (HH:MM), au-delà de la tolérance l'arrivée est en retard. */
  workStart: string;
  lateToleranceMinutes: number;
  /** Jours travaillés (0 = dimanche … 6 = samedi) : « 123456 » du lundi au samedi. */
  workDays: string;

  /**
   * Façons de pointer, au choix de chaque entreprise (elles se combinent) :
   * à la première connexion au logiciel, et à la borne de l'entrée par badge,
   * par numéro et code, avec ou sans photo prise par la caméra.
   */
  punchLogin: boolean;
  punchKiosk: boolean;
  punchBadge: boolean;
  punchPin: boolean;
  punchPhoto: boolean;
  /** Deux passages à la borne à moins de ce nombre de minutes comptent pour un seul. */
  punchGapMinutes: number;
  /** Plusieurs entrées, chacune avec sa borne ; sinon une seule entrée. */
  multiEntrances: boolean;
  /** Personnel d'une société prestataire (gardiennage, nettoyage) : suivi au pointage, sans paie. */
  contractorStaff: boolean;
  /** Équipes (matin, soir, nuit) et rotations ; sinon la semaine type de chacun. */
  staffTeams: boolean;
  /** Jours fériés légaux du Cameroun : ni absence ni retard ces jours-là. */
  holidaysCameroon: boolean;
  /** Autres jours fériés, un par ligne : « AAAA-MM-JJ Libellé » ou « MM-JJ Libellé » chaque année. */
  holidaysExtra: string;
  /** Les contrats qui finissent dans ce nombre de jours sont signalés ; 0 : jamais. */
  contractAlertDays: number;

  /**
   * Paie d'après le pointage : le salaire du mois est proposé avec les règles
   * choisies (retenues d'absence et de retard, heures supplémentaires, fériés
   * travaillés, prime d'assiduité), puis vérifié par le gérant.
   */
  payFromAttendance: boolean;
  payAbsence: boolean;
  payLate: boolean;
  payOvertime: boolean;
  overtimeRatePct: number;
  overtimeMinMinutes: number;
  holidayRatePct: number;
  attendanceBonus: number;
  monthlyHours: number;

  /** Pointeuse à empreinte (ZKTeco) : envoi par le réseau à un PC du magasin, ou fichier de la clé USB. */
  fingerprint: boolean;
  /** Alertes du personnel : retard au-delà de ce nombre de minutes, absence à la fin de l'horaire prévu ; 0 : pas d'alerte de retard. */
  staffAlerts: boolean;
  alertLateMinutes: number;
  /** WhatsApp du responsable qui reçoit les alertes du personnel. */
  alertWhatsapp: string;
  /** Un avertissement est proposé à partir de ce nombre de retards dans le mois ; 0 : jamais. */
  warnLateCount: number;

  /** Congés payés acquis par mois de service, en dixièmes de jour (15 = 1,5 jour, Code du travail). */
  leaveDaysPerMonth: number;
  /** Avances sur salaire : encours maximal en % du salaire de base ; 0 : sans plafond. */
  advanceMaxPct: number;
  /** Déstockage avant péremption : « jours:remise % » séparés par des virgules (14:10,7:20,3:30). */
  clearanceRules: string;
  /** Inventaire tournant : nombre de produits proposés à compter chaque semaine. */
  cycleCountPerWeek: number;

  /** Boutique en ligne : page internet du magasin sur le serveur, les commandes arrivent dans « Commandes clients ». */
  onlineShop: boolean;
  /** Livraison proposée sur la boutique en ligne, et ses frais TTC (0 : à convenir). */
  onlineShopDelivery: boolean;
  onlineShopDeliveryFee: number;
  /** Montant minimal d'une commande en ligne (0 : sans minimum). */
  onlineShopMinOrder: number;
  /** Message affiché en haut de la boutique (horaires, zone de livraison…). */
  onlineShopMessage: string;
  /** Vérificateur de prix : page du serveur ouverte sur un téléphone ou une tablette au rayon. */
  priceChecker: boolean;
  /** Sauvegarde en ligne : copie chiffrée de la base envoyée au serveur après chaque sauvegarde. */
  cloudBackup: boolean;

  /** Paie : retenues légales (CNPS, IRPP, CAC, CFC, RAV, TDL) et charges patronales. */
  payroll: PayrollRules;

  /** Modèles d'impression modifiés ou ajoutés (ceux du logiciel servent pour le reste). */
  printTemplates: DocTemplate[];
  /** Modèle choisi par emplacement (« invoice.a4.credit ») : identifiant de modèle. */
  printDefaults: Record<string, string>;
}

export type BarcodeKind = 'ean8' | 'ean13';

/** Présentations de l'écran de caisse : mêmes fonctions et mêmes touches, disposition différente. */
export type PosLayout = 'modern' | 'classic' | 'conventional';
export const POS_LAYOUTS: Record<PosLayout, string> = { modern: 'Moderne', classic: 'Classique', conventional: 'Conventionnel' };
/** Rôles qui vendent et peuvent passer en mode « Caisse seule » dès la connexion. */
export const POS_FULL_ROLES = ['cashier', 'seller', 'manager', 'admin'] as const;

export const DEFAULT_STORE_SETTINGS: StoreSettings = {
  rccm: '',
  ticketHeader: '',
  logo: '',
  brandColor: DEFAULT_BRAND_COLOR,
  brandColor2: DEFAULT_BRAND_COLOR2,
  badge: DEFAULT_BADGE,
  maxDiscountPct: 0,
  cashRounding: 1,
  ticketCopies: 1,
  customerRequiredAbove: 0,
  cancelMinutes: 0,
  maxHeld: 0,
  allowBelowCost: false,
  voucherValidityDays: 365,
  cashCeiling: 0,
  changeToAccount: true,
  exitCheck: false,
  exitCheckHours: 3,
  creditDefaultLimit: 0,
  creditDefaultDays: 30,
  creditBlockLate: false,
  reminderTemplate: '',
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
  prefixCustomerOrder: 'CC',
  posLayout: 'modern',
  posFullRoles: '',
  barcodeAuto: true,
  barcodeKind: 'ean8',
  articleCodeByFamily: false,
  labelFormat: 'roll_30x20',
  labelName: true,
  labelPrice: true,
  labelStore: false,
  labelAfterReception: true,
  loyaltyEnabled: false,
  loyaltySpendPerPoint: 1000,
  loyaltyPointValue: 10,
  loyaltyMinRedeem: 100,
  workStart: '08:00',
  lateToleranceMinutes: 10,
  workDays: '123456',
  punchLogin: true,
  punchKiosk: false,
  punchBadge: true,
  punchPin: false,
  punchPhoto: false,
  punchGapMinutes: 2,
  multiEntrances: false,
  contractorStaff: false,
  staffTeams: false,
  holidaysCameroon: true,
  holidaysExtra: '',
  contractAlertDays: 30,
  payFromAttendance: false,
  payAbsence: true,
  payLate: false,
  payOvertime: false,
  overtimeRatePct: 20,
  overtimeMinMinutes: 30,
  holidayRatePct: 100,
  attendanceBonus: 0,
  monthlyHours: 173,
  fingerprint: false,
  staffAlerts: false,
  alertLateMinutes: 30,
  alertWhatsapp: '',
  warnLateCount: 3,
  leaveDaysPerMonth: 15,
  advanceMaxPct: 0,
  clearanceRules: '14:10,7:20,3:30',
  cycleCountPerWeek: 30,
  onlineShop: false,
  onlineShopDelivery: true,
  onlineShopDeliveryFee: 0,
  onlineShopMinOrder: 0,
  onlineShopMessage: '',
  priceChecker: false,
  cloudBackup: false,
  payroll: DEFAULT_PAYROLL,
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
  voucherValidityDays: [0, 3650],
  cashCeiling: [0, 1e10],
  exitCheckHours: [1, 72],
  creditDefaultLimit: [0, 1e10],
  creditDefaultDays: [0, 365],
  expiryAlertDays: [1, 365],
  defaultAlertQty: [0, 1e6],
  supplierDefaultDays: [0, 365],
  defaultMarginPct: [0, 1000],
  idleMinutes: [0, 480],
  pinMinLength: [4, 8],
  maxLoginAttempts: [0, 20],
  loyaltySpendPerPoint: [1, 1e7],
  loyaltyPointValue: [1, 1e6],
  loyaltyMinRedeem: [0, 1e7],
  lateToleranceMinutes: [0, 240],
  punchGapMinutes: [0, 120],
  contractAlertDays: [0, 365],
  overtimeRatePct: [0, 200],
  overtimeMinMinutes: [0, 240],
  holidayRatePct: [0, 200],
  attendanceBonus: [0, 1e7],
  monthlyHours: [40, 300],
  alertLateMinutes: [0, 600],
  warnLateCount: [0, 31],
  leaveDaysPerMonth: [0, 50],
  advanceMaxPct: [0, 100],
  cycleCountPerWeek: [5, 500],
  onlineShopDeliveryFee: [0, 1e7],
  onlineShopMinOrder: [0, 1e8],
};
const TEXT_MAX: Partial<Record<keyof StoreSettings, number>> = { rccm: 40, ticketHeader: 120, logo: 400_000, reminderTemplate: 1500, onlineShopMessage: 300, holidaysExtra: 3000, alertWhatsapp: 30 };
const PREFIXES: (keyof StoreSettings)[] = ['prefixSale', 'prefixReturn', 'prefixQuote', 'prefixProforma', 'prefixOrder', 'prefixCustomerOrder'];

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
    } else if (k === 'payroll') {
      next.payroll = normalizePayroll(raw);
    } else if (k === 'badge') {
      next.badge = normalizeBadge(raw);
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
      if ((k === 'brandColor' || k === 'brandColor2') && !isHexColor(s)) throw new Error('Couleur attendue au format #RRVVBB');
      if (k === 'brandColor' || k === 'brandColor2') s = s.toLowerCase();
      if (k === 'logo' && s && !s.startsWith('data:image/')) throw new Error('Logo : image attendue');
      if (k === 'posLayout' && !(s in POS_LAYOUTS)) throw new Error("Présentation de l'écran de caisse : moderne, classique ou conventionnel");
      if (k === 'barcodeKind' && s !== 'ean8' && s !== 'ean13') throw new Error('Format des codes internes : EAN-8 ou EAN-13');
      if (k === 'labelFormat' && !isBarcodeLabelFormat(s)) throw new Error("Format d'étiquette inconnu");
      if (k === 'workStart' && !/^([01]\d|2[0-3]):[0-5]\d$/.test(s)) throw new Error("Heure d'arrivée : HH:MM, par exemple 08:00");
      if (k === 'posFullRoles') {
        const roles = s.split(/[,\s]+/);
        s = POS_FULL_ROLES.filter((r) => roles.includes(r)).join(',');
      }
      if (k === 'workDays') {
        s = [...new Set(s.replace(/[^0-6]/g, ''))].sort().join('');
        if (!s) throw new Error('Choisissez au moins un jour travaillé');
      }
      if (k === 'clearanceRules') {
        const rules = parseClearanceRules(s);
        if (s && !rules.length) throw new Error('Déstockage : « jours:remise » séparés par des virgules, par exemple 14:10,7:20,3:30');
        s = rules.map((r) => `${r.days}:${r.pct}`).join(',');
      }
      if (k === 'holidaysExtra') {
        s = String(raw ?? '')
          .split(/\n/)
          .map((l) => l.trim())
          .filter(Boolean)
          .join('\n');
        parseHolidays(s);
      }
      if (k === 'alertWhatsapp') s = s.replace(/[^\d+ ]/g, '').trim();
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
    const parsed = { ...DEFAULT_STORE_SETTINGS, ...(JSON.parse(json) as Partial<StoreSettings>) };
    return { ...parsed, payroll: { ...DEFAULT_PAYROLL, ...parsed.payroll }, badge: normalizeBadge(parsed.badge) };
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

/** Palier de déstockage : à J-`days` de la péremption, `pct` % de remise. */
export interface ClearanceRule {
  days: number;
  pct: number;
}

/** Paliers de déstockage lus dans le paramètre, du plus proche de la péremption au plus lointain. */
export function parseClearanceRules(text: string): ClearanceRule[] {
  const out: ClearanceRule[] = [];
  for (const part of text.split(/[,;\s]+/).filter(Boolean)) {
    const m = /^(\d{1,3}):(\d{1,2})$/.exec(part);
    if (!m) return [];
    const days = Number(m[1]);
    const pct = Number(m[2]);
    if (days < 0 || days > 365 || pct < 1 || pct > 90) return [];
    out.push({ days, pct });
  }
  return out.sort((a, b) => a.days - b.days);
}

/** Remise proposée pour un lot qui périme dans `daysLeft` jours (0 : aucune). */
export function clearancePct(rules: ClearanceRule[], daysLeft: number): number {
  return rules.find((r) => daysLeft <= r.days)?.pct ?? 0;
}
