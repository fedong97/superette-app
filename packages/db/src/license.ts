import { execFileSync } from 'node:child_process';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import type { Db } from './database';
import { AppError, Base, type Clock } from './util';

/**
 * Clé publique de l'éditeur. Elle vérifie les licences mais ne peut pas en
 * fabriquer : la clé secrète qui les signe reste dans le générateur de l'éditeur
 * (tools/generateur-licences.html). La même clé est recopiée dans le serveur
 * central (apps/server/src/license.ts).
 */
export const LICENSE_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAFN0JKMfb8/004ITtjE6SQUCW0mIEhx+wKm11o+bLs+w=
-----END PUBLIC KEY-----`;

/** Jours d'essai d'une installation sans licence. */
export const TRIAL_DAYS = 15;
/** Jours pendant lesquels la caisse vend encore après la fin de la licence. */
export const GRACE_DAYS = 15;
/** L'avertissement de renouvellement s'affiche à partir de ce nombre de jours. */
export const WARN_DAYS = 15;

export type LicensePlan = 'monthly' | 'annual' | 'lifetime';

export const LICENSE_PLAN_LABELS: Record<LicensePlan, string> = { monthly: 'mensuelle', annual: 'annuelle', lifetime: 'à vie' };

/** Contenu signé d'une licence (créé par le générateur de l'éditeur). */
export interface LicensePayload {
  v: 1;
  /** Numéro de la licence. */
  id: string;
  /** Client : nom du magasin ou de la société. */
  client: string;
  /** Code machine du PC sur lequel la licence est activée. */
  machine: string;
  plan: LicensePlan;
  /** Premier jour de validité (AAAA-MM-JJ). */
  start: string;
  /** Dernier jour de validité (AAAA-MM-JJ), null pour une licence à vie. */
  expires: string | null;
  /** Nombre de PC reliés au serveur central. */
  stations: number;
  /** Nombre de magasins. */
  stores: number;
  /** Date et heure de création : la plus récente remplace l'ancienne. */
  issued: string;
  /** Téléphone ou nom de l'éditeur, affiché pour le renouvellement. */
  contact?: string;
}

export type LicenseState = 'trial' | 'trial_over' | 'valid' | 'grace' | 'expired' | 'invalid' | 'other_machine' | 'clock';

export interface LicenseStatus {
  state: LicenseState;
  /** La caisse peut-elle encore vendre ? */
  canSell: boolean;
  /** Avertir l'utilisateur (essai, fin proche, délai de grâce, blocage). */
  warn: boolean;
  /** Jours restants : d'essai, de licence ou de délai de grâce selon l'état ; null pour une licence à vie. */
  daysLeft: number | null;
  machineCode: string;
  license: LicensePayload | null;
  message: string;
}

const PREFIX = 'SG1';
const DAY = 86_400_000;
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Identifiant de Windows (MachineGuid), à défaut celui du système ou le nom du PC. */
export function readMachineId(): string {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid', '/reg:64'], {
        encoding: 'utf8',
        windowsHide: true,
      });
      const m = /MachineGuid\s+REG_SZ\s+(\S+)/i.exec(out);
      if (m) return m[1]!;
    } else if (process.platform === 'linux') {
      const id = readFileSync('/etc/machine-id', 'utf8').trim();
      if (id) return id;
    }
  } catch {
    // Lecture impossible : on se rabat sur le nom du PC.
  }
  return hostname();
}

/** Code machine lisible, à dicter ou envoyer par WhatsApp : « 7KQ2-M9XA-3DTR-P0WF ». */
export function machineCodeFrom(machineId: string): string {
  const bytes = createHash('sha256').update(`superette-gestion:${machineId}`).digest().subarray(0, 10);
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += CROCKFORD[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return out.match(/.{4}/g)!.join('-');
}

/** Majuscules, sans espaces : un code machine recopié à la main reste comparable. */
export const normalizeMachineCode = (code: string) => {
  const c = code.toUpperCase().replace(/[^0-9A-Z]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  return c.length === 16 ? c.match(/.{4}/g)!.join('-') : c;
};

/** La clé collée peut avoir été coupée en plusieurs lignes (WhatsApp, e-mail). */
export const normalizeLicenseKey = (key: string) => key.replace(/\s+/g, '');

const isDate = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

/** Vérifie la signature d'une clé de licence et en rend le contenu. */
export function parseLicenseKey(key: string, publicKey: string = LICENSE_PUBLIC_KEY): LicensePayload {
  const parts = normalizeLicenseKey(key).split('.');
  if (parts.length !== 3 || parts[0] !== PREFIX) throw new AppError("Ce texte n'est pas une clé de licence FEDONIX 360", 'LICENSE_INVALID');
  const data = Buffer.from(parts[1]!, 'base64url');
  const signature = Buffer.from(parts[2]!, 'base64url');
  let ok = false;
  try {
    ok = verify(null, data, createPublicKey(publicKey), signature);
  } catch {
    ok = false;
  }
  if (!ok) throw new AppError('Clé de licence incorrecte : vérifiez qu’elle a été copiée en entier', 'LICENSE_INVALID');
  let p: LicensePayload;
  try {
    p = JSON.parse(data.toString('utf8')) as LicensePayload;
  } catch {
    throw new AppError('Clé de licence illisible', 'LICENSE_INVALID');
  }
  const valid =
    p.v === 1 &&
    typeof p.id === 'string' &&
    typeof p.client === 'string' &&
    typeof p.machine === 'string' &&
    ['monthly', 'annual', 'lifetime'].includes(p.plan) &&
    isDate(p.start) &&
    (p.plan === 'lifetime' ? p.expires === null : isDate(p.expires)) &&
    Number.isInteger(p.stations) &&
    p.stations >= 1 &&
    Number.isInteger(p.stores) &&
    p.stores >= 1 &&
    typeof p.issued === 'string';
  if (!valid) throw new AppError('Clé de licence incomplète : demandez une nouvelle clé', 'LICENSE_INVALID');
  return { ...p, machine: normalizeMachineCode(p.machine) };
}

const frDate = (d: string) => d.split('-').reverse().join('/');
const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY);
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const plural = (n: number, word: string) => `${n} ${word}${n > 1 ? 's' : ''}`;

/**
 * Licence de ce PC. Sans licence, l'installation tourne en essai ; à la fin de
 * la licence, un délai de grâce laisse vendre puis la caisse s'arrête. Tout le
 * reste (consultation, clôture, sauvegardes) reste possible : les données du
 * client ne sont jamais bloquées.
 *
 * Un PC relié au serveur central reçoit la licence du magasin par la
 * synchronisation : elle est valable sur lui même si elle a été activée sur un
 * autre PC (le serveur limite le nombre de PC).
 */
export class LicenseService extends Base {
  private machine: string | null = null;

  constructor(
    db: Db,
    clock: Clock,
    private readonly connected: () => boolean,
    private readonly machineId: () => string = readMachineId,
    private readonly publicKey: string = LICENSE_PUBLIC_KEY,
  ) {
    super(db, clock);
  }

  private get(key: string): string | null {
    return (this.db.prepare('SELECT value FROM settings WHERE key = ?').pluck().get(key) as string | undefined) ?? null;
  }

  private set(key: string, value: string): void {
    this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  machineCode(): string {
    return (this.machine ??= machineCodeFrom(this.machineId()));
  }

  /** Licence enregistrée, si sa signature est bonne. */
  current(): LicensePayload | null {
    const key = this.get('license.key');
    if (!key) return null;
    try {
      return parseLicenseKey(key, this.publicKey);
    } catch {
      return null;
    }
  }

  status(): LicenseStatus {
    const machineCode = this.machineCode();
    const base = { machineCode, license: null as LicensePayload | null, daysLeft: null as number | null };
    // Date reculée : on refuse de vendre plutôt que de prolonger une licence.
    const now = this.clock().getTime();
    const lastSeen = Date.parse(this.get('license.lastSeen') ?? '');
    if (Number.isFinite(lastSeen) && now < lastSeen - DAY) {
      return {
        ...base,
        state: 'clock',
        canSell: false,
        warn: true,
        license: this.current(),
        message: `La date de ce PC (${frDate(this.today())}) est antérieure à sa dernière utilisation : corrigez la date et l'heure de Windows.`,
      };
    }
    if (!Number.isFinite(lastSeen) || now > lastSeen) this.set('license.lastSeen', this.now());

    const today = this.today();
    const key = this.get('license.key');
    if (!key) {
      let start = this.get('license.trialStart');
      if (!isDate(start)) this.set('license.trialStart', (start = today));
      const left = daysBetween(today, addDays(start, TRIAL_DAYS - 1));
      return left >= 0
        ? { ...base, state: 'trial', canSell: true, warn: true, daysLeft: left + 1, message: `Version d'essai : il reste ${plural(left + 1, 'jour')}. Activez votre licence dans Administration › Licence.` }
        : { ...base, state: 'trial_over', canSell: false, warn: true, daysLeft: 0, message: "La période d'essai est terminée : la caisse ne vend plus. Activez votre licence dans Administration › Licence." };
    }
    let license: LicensePayload;
    try {
      license = parseLicenseKey(key, this.publicKey);
    } catch {
      return { ...base, state: 'invalid', canSell: false, warn: true, message: "La licence enregistrée n'est pas valable : activez une nouvelle licence dans Administration › Licence." };
    }
    const contact = license.contact ? ` Contact : ${license.contact}.` : '';
    if (license.machine !== machineCode && !this.connected()) {
      return {
        ...base,
        license,
        state: 'other_machine',
        canSell: false,
        warn: true,
        message: `Cette licence a été activée sur un autre PC : la caisse ne vend plus. Reliez ce PC au serveur central ou demandez une licence pour le code ${machineCode}.${contact}`,
      };
    }
    const label = LICENSE_PLAN_LABELS[license.plan];
    if (!license.expires) return { ...base, license, state: 'valid', canSell: true, warn: false, message: `Licence à vie au nom de ${license.client}.` };
    const left = daysBetween(today, license.expires);
    if (left >= 0) {
      return {
        ...base,
        license,
        state: 'valid',
        canSell: true,
        warn: left < WARN_DAYS,
        daysLeft: left + 1,
        message:
          left < WARN_DAYS
            ? `Licence ${label} valable jusqu'au ${frDate(license.expires)} : il reste ${plural(left + 1, 'jour')}. Pensez à la renouveler.${contact}`
            : `Licence ${label} au nom de ${license.client}, valable jusqu'au ${frDate(license.expires)}.`,
      };
    }
    const grace = GRACE_DAYS + left;
    if (grace >= 0) {
      return {
        ...base,
        license,
        state: 'grace',
        canSell: true,
        warn: true,
        daysLeft: grace + 1,
        message: `Licence expirée le ${frDate(license.expires)} : la caisse s'arrête de vendre dans ${plural(grace + 1, 'jour')}. Renouvelez-la.${contact}`,
      };
    }
    return {
      ...base,
      license,
      state: 'expired',
      canSell: false,
      warn: true,
      daysLeft: 0,
      message: `Licence expirée le ${frDate(license.expires)} : la caisse ne vend plus. Renouvelez votre licence.${contact}`,
    };
  }

  /** Refuse la vente quand la licence ne le permet plus. */
  assertCanSell(): void {
    const st = this.status();
    if (!st.canSell) throw new AppError(st.message, 'LICENSE');
  }

  /** Nombre de magasins permis par la licence (sans limite pendant l'essai). */
  assertCanAddStore(storeCount: number): void {
    const lic = this.current();
    if (lic && storeCount >= lic.stores) {
      throw new AppError(`Votre licence couvre ${plural(lic.stores, 'magasin')} : demandez une licence étendue pour en ouvrir un autre.`, 'LICENSE');
    }
  }

  /** Active la clé reçue de l'éditeur sur ce PC. */
  activate(userId: string, key: string): LicenseStatus {
    const license = parseLicenseKey(key, this.publicKey);
    const machineCode = this.machineCode();
    if (license.machine !== machineCode) {
      throw new AppError(`Cette licence a été créée pour un autre PC (code ${license.machine}). Le code de ce PC est ${machineCode}.`, 'LICENSE_MACHINE');
    }
    if (license.expires && license.expires < this.today()) throw new AppError(`Cette licence a expiré le ${frDate(license.expires)}`, 'LICENSE_EXPIRED');
    this.set('license.key', normalizeLicenseKey(key));
    // Une date mal réglée puis corrigée ne bloque plus après une nouvelle licence.
    this.set('license.lastSeen', this.now());
    this.audit(userId, 'license_activate', 'license', license.id, { client: license.client, plan: license.plan, expires: license.expires, stations: license.stations });
    return this.status();
  }

  /** Licence du magasin reçue du serveur central : gardée si elle est plus récente. */
  acceptFromServer(key: string | null | undefined): boolean {
    if (!key) return false;
    let license: LicensePayload;
    try {
      license = parseLicenseKey(key, this.publicKey);
    } catch {
      return false;
    }
    const cur = this.current();
    if (cur && cur.issued >= license.issued) return false;
    const normalized = normalizeLicenseKey(key);
    this.set('license.key', normalized);
    this.set('license.sent', normalized);
    return true;
  }

  /** Licence à envoyer au serveur central (activée ici, pas encore envoyée). */
  pendingUpload(): string | null {
    const key = this.get('license.key');
    return key && key !== this.get('license.sent') ? key : null;
  }

  markUploaded(key: string): void {
    this.set('license.sent', key);
  }
}
