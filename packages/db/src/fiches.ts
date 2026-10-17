import { copyFileSync, createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';
import Database from 'better-sqlite3';
import { type Db, openDatabase } from './database';
import { MIGRATIONS } from './schema';
import { StockService } from './stock';
import { SyncService } from './sync';
import { AppError, Base, type Clock, newId } from './util';

/**
 * Fiche boutique : une copie du dossier d'une boutique dans un seul fichier
 * `.fedonix`, comme les fichiers de gestion de Sage 100.
 *
 * - intervention : le technicien l'emporte, y travaille sur son PC et la rapporte ;
 * - comptable : le comptable l'emporte pour ses états, la rapporter est facultatif ;
 * - installation : une boutique préparée au bureau, installée sur le PC du client.
 *
 * La boutique n'est jamais bloquée : au retour, seules les modifications faites
 * dans la fiche sont ajoutées à la boutique, par le même chemin que la
 * synchronisation entre PC (la plus récente l'emporte, rien n'est écrasé en bloc).
 */
export type FicheKind = 'intervention' | 'comptable' | 'installation';

export const FICHE_EXTENSION = 'fedonix';
/** Fiche compressée pour l'envoyer par e-mail ou WhatsApp (5 à 10 fois plus petite). */
export const PACKED_EXTENSION = 'fedonixz';

export const isPackedFiche = (file: string) => file.toLowerCase().endsWith(`.${PACKED_EXTENSION}`);

/** Compresse une fiche à côté d'elle (« X.fedonixz ») et efface la fiche non compressée. */
export async function packFiche(file: string): Promise<string> {
  const target = file.replace(/\.[^.\\/]+$/, '') + `.${PACKED_EXTENSION}`;
  const tmp = `${target}.part`;
  try {
    await pipeline(createReadStream(file), createGzip({ level: 9 }), createWriteStream(tmp));
    renameSync(tmp, target);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw new AppError(`Compression impossible : ${e instanceof Error ? e.message : String(e)}`, 'FICHE_FAILED');
  }
  rmSync(file, { force: true });
  return target;
}

/** Décompresse une fiche reçue dans `dir` (« X.fedonix ») ; renvoie le chemin de la fiche. */
export async function unpackFiche(file: string, dir: string): Promise<string> {
  mkdirSync(dir, { recursive: true });
  const target = join(dir, basename(file).replace(/\.[^.]+$/, '') + `.${FICHE_EXTENSION}`);
  const tmp = `${target}.part`;
  try {
    await pipeline(createReadStream(file), createGunzip(), createWriteStream(tmp));
    renameSync(tmp, target);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw new AppError(`Fiche compressée illisible (fichier incomplet ?) : ${e instanceof Error ? e.message : String(e)}`, 'INVALID');
  }
  return target;
}

/** Dossier partagé (réseau, OneDrive, Google Drive) : copies du comptable et fiches à rapporter. */
export interface ShareStatus {
  dir: string | null;
  /** Copie pour le comptable déposée toutes les N minutes (0 : jamais). */
  every: number;
  last_at: string | null;
  last_error: string | null;
  /** Fiches déposées dans « Retours », pas encore rapportées. */
  pending: { file: string; name: string; packed: boolean; store_name: string | null; kind: FicheKind | null; at: string | null; by_name: string | null; error: string | null }[];
}

export const SHARE_FREQUENCIES: [number, string][] = [
  [0, 'Jamais'],
  [60, 'Toutes les heures'],
  [240, 'Toutes les 4 heures'],
  [1440, 'Chaque jour'],
];
export const SHARE_COMPTABLE = 'Comptable';
export const SHARE_RETURNS = 'Retours';
const SHARE_DONE = 'Rapportées';

export const FICHE_KIND_LABELS: Record<FicheKind, string> = {
  intervention: "Fiche d'intervention",
  comptable: 'Copie comptable',
  installation: 'Installation préparée',
};

/** Ce que la fiche sait d'elle-même (réglage `fiche.meta`). */
export interface FicheMeta {
  v: 1;
  id: string;
  kind: FicheKind;
  storeId: string;
  storeCode: string;
  storeName: string;
  /** Heure à laquelle les données ont été arrêtées. */
  at: string;
  byId: string | null;
  byName: string | null;
  appVersion: string;
  /** Dernière opération de la file d'envoi au moment de la sortie : ce qui suit a été fait dans la fiche. */
  baseSeq: number;
  /** Réglages de la boutique au moment de la sortie (sans ceux du PC). */
  settings: Record<string, string>;
  /** Compteurs de numéros au moment de la sortie. */
  counters: Record<string, number>;
}

/** Ce qu'on montre d'un dossier ou d'une fiche sans l'ouvrir. */
export interface DossierInfo {
  file: string;
  name: string;
  size: number;
  modified_at: string;
  ok: boolean;
  error: string | null;
  version: number;
  store_name: string | null;
  store_code: string | null;
  articles: number;
  sales: number;
  last_sale_at: string | null;
  fiche: Omit<FicheMeta, 'settings' | 'counters'> | null;
}

export interface FicheReturn {
  kind: FicheKind;
  byName: string | null;
  at: string;
  /** Opérations faites dans la fiche (une par fiche, article, écriture… modifié). */
  changes: number;
  applied: number;
  conflicts: number;
  settings: number;
}

export interface FicheLogRow {
  id: string;
  kind: FicheKind;
  file: string;
  created_at: string;
  user_id: string | null;
  returned_at: string | null;
  returned_by: string | null;
  summary: string | null;
}

/** Réglages propres à un PC : ils ne partent pas dans une fiche et ne reviennent jamais avec elle. */
const POSTE_PREFIXES = ['license.', 'sync.', 'station.', 'backup.', 'printer.', 'drawer.', 'digest.', 'barcode.node', 'mobilepay.', 'display.', 'pos.layout', 'fiche.', 'share.', 'relay.'];
/** Le magasin et la caisse restent dans la fiche (elle s'ouvre sur la bonne boutique), sans jamais revenir. */
const KEPT_IN_FICHE = new Set(['station.storeId', 'station.registerId']);

export const isPosteSetting = (key: string): boolean => POSTE_PREFIXES.some((p) => key.startsWith(p));

const CURRENT_VERSION = Math.max(...MIGRATIONS.map((m) => m.version));

export function readFicheMeta(db: Db): FicheMeta | null {
  try {
    const json = db.prepare("SELECT value FROM settings WHERE key = 'fiche.meta'").pluck().get() as string | undefined;
    return json ? (JSON.parse(json) as FicheMeta) : null;
  } catch {
    return null;
  }
}

/** Lit un dossier ou une fiche sans le modifier (liste des boutiques, choix d'une fiche). */
export function inspectDossier(file: string): DossierInfo {
  const info: DossierInfo = {
    file,
    name: basename(file),
    size: 0,
    modified_at: '',
    ok: false,
    error: null,
    version: 0,
    store_name: null,
    store_code: null,
    articles: 0,
    sales: 0,
    last_sale_at: null,
    fiche: null,
  };
  try {
    const st = statSync(file);
    info.size = st.size;
    info.modified_at = st.mtime.toISOString();
  } catch {
    return { ...info, error: 'Fichier introuvable' };
  }
  let db: Db | null = null;
  try {
    db = new Database(file, { readonly: true, fileMustExist: true });
    const hasMigrations = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").pluck().get();
    if (!hasMigrations) return { ...info, error: "Ce fichier n'est pas un dossier FEDONIX 360" };
    info.version = (db.prepare('SELECT MAX(version) FROM schema_migrations').pluck().get() as number | null) ?? 0;
    const store = db
      .prepare("SELECT s.name, s.code FROM settings k JOIN stores s ON s.id = k.value WHERE k.key = 'station.storeId'")
      .get() as { name: string; code: string } | undefined;
    const first = store ?? (db.prepare('SELECT name, code FROM stores ORDER BY created_at LIMIT 1').get() as { name: string; code: string } | undefined);
    info.store_name = first?.name ?? null;
    info.store_code = first?.code ?? null;
    info.articles = db.prepare('SELECT COUNT(*) FROM articles').pluck().get() as number;
    info.sales = db.prepare("SELECT COUNT(*) FROM sales WHERE status = 'completed'").pluck().get() as number;
    info.last_sale_at = (db.prepare('SELECT MAX(created_at) FROM sales').pluck().get() as string | null) ?? null;
    const meta = readFicheMeta(db);
    if (meta) {
      const { settings: _s, counters: _c, ...rest } = meta;
      info.fiche = rest;
    }
    if (info.version > CURRENT_VERSION) return { ...info, error: "Fichier fait par une version plus récente de l'application : mettez-la à jour d'abord" };
    return { ...info, ok: true };
  } catch (e) {
    return { ...info, error: `Fichier illisible : ${e instanceof Error ? e.message : String(e)}` };
  } finally {
    db?.close();
  }
}

/** Lit la description complète d'une fiche (réglages et compteurs de départ compris). */
function readFicheFile(file: string): FicheMeta | null {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    return readFicheMeta(db);
  } finally {
    db.close();
  }
}

/**
 * Installe une boutique préparée au bureau à la place de `dbFile` (base fermée) :
 * le PC repart avec ses propres réglages (licence d'essai, imprimante à régler).
 */
export function installFiche(dbFile: string, ficheFile: string): DossierInfo {
  const info = inspectDossier(ficheFile);
  if (!info.ok) throw new AppError(info.error ?? 'Fiche invalide', 'INVALID');
  if (info.fiche?.kind !== 'installation') {
    throw new AppError("Ce fichier n'est pas une installation préparée : faites « Préparer l'installation » dans la boutique préparée au bureau", 'INVALID');
  }
  const tmp = `${dbFile}.installation`;
  copyFileSync(ficheFile, tmp);
  const db = new Database(tmp);
  try {
    db.prepare("DELETE FROM settings WHERE key LIKE 'fiche.%'").run();
    db.pragma('journal_mode = DELETE');
  } finally {
    db.close();
  }
  for (const ext of ['-wal', '-shm']) rmSync(`${dbFile}${ext}`, { force: true });
  renameSync(tmp, dbFile);
  return inspectDossier(dbFile);
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Nom de fichier lisible : « Superette-Akwa-intervention-2026-10-17-0825.fedonix ». */
function fileName(storeName: string, kind: FicheKind, d: Date): string {
  const slug =
    storeName
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^A-Za-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'boutique';
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  return `${slug}-${kind}-${stamp}.${FICHE_EXTENSION}`;
}

const frDateTime = (iso: string) => {
  const d = new Date(iso);
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} à ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/** Phrase du bandeau affiché tant qu'une fiche est ouverte. */
export function ficheBanner(meta: Pick<FicheMeta, 'kind' | 'storeName' | 'at'>): string {
  const when = frDateTime(meta.at);
  if (meta.kind === 'installation') return `Installation préparée pour ${meta.storeName}`;
  return `${FICHE_KIND_LABELS[meta.kind]} de ${meta.storeName}, données arrêtées au ${when} : la caisse ne vend pas ici.`;
}

export class FicheService extends Base {
  constructor(
    db: Db,
    clock: Clock,
    private readonly sync: SyncService,
  ) {
    super(db, clock);
  }

  /** La boutique ouverte est-elle une fiche (et laquelle) ? */
  current(): FicheMeta | null {
    return readFicheMeta(this.db);
  }

  history(limit = 50): FicheLogRow[] {
    return this.db.prepare('SELECT id, kind, file, created_at, user_id, returned_at, returned_by, summary FROM fiche_log ORDER BY created_at DESC LIMIT ?').all(limit) as FicheLogRow[];
  }

  /**
   * Sort une fiche de la boutique dans `dir` (clé USB…), sans l'arrêter : copie à
   * chaud, vérifiée, sans les réglages du PC (licence, serveur, imprimantes, clés).
   */
  async export(
    user: { id: string; name: string } | null,
    kind: FicheKind,
    dir: string,
    appVersion: string,
    /** name : nom de fichier fixe (une copie précédente est remplacée) ; log : false pour les copies automatiques. */
    opts: {
      name?: string;
      log?: boolean;
      /** Poste distant (dépôt sans réseau) : installation sur une autre caisse, qui fera ses remontées par fichier. */
      remote?: { registerId: string };
    } = {},
  ): Promise<DossierInfo> {
    if (!(kind in FICHE_KIND_LABELS)) throw new AppError('Sorte de fiche inconnue', 'INVALID');
    const open = this.current();
    if (open) throw new AppError(`Cette boutique est déjà une ${FICHE_KIND_LABELS[open.kind].toLowerCase()} : sortez la fiche depuis la boutique elle-même`, 'FICHE');
    const store = this.db
      .prepare("SELECT s.id, s.code, s.name FROM settings k JOIN stores s ON s.id = k.value WHERE k.key = 'station.storeId'")
      .get() as { id: string; code: string; name: string } | undefined;
    if (!store) throw new AppError("Ce poste n'est pas configuré", 'NO_STATION');
    const remote = opts.remote
      ? (this.db.prepare("SELECT r.id, r.store_id, s.name AS store_name, s.code AS store_code FROM registers r JOIN stores s ON s.id = r.store_id WHERE r.id = ? AND r.kind = 'cash' AND r.active = 1").get(opts.remote.registerId) as
          | { id: string; store_id: string; store_name: string; store_code: string }
          | undefined)
      : undefined;
    if (opts.remote && (kind !== 'installation' || !remote)) throw new AppError('Choisissez une caisse espèces active pour le poste distant', 'INVALID');
    if (kind === 'installation' && !remote) {
      const sales = this.db.prepare('SELECT COUNT(*) FROM sales').pluck().get() as number;
      const sessions = this.db.prepare('SELECT COUNT(*) FROM cash_sessions').pluck().get() as number;
      if (sales > 0 || sessions > 0) {
        throw new AppError(
          "Cette boutique a déjà des ventes ou des journées de caisse : elles partiraient chez le client. Préparez l'installation dans une boutique sans essai de vente.",
          'INVALID',
        );
      }
    }
    try {
      mkdirSync(dir, { recursive: true });
    } catch (e) {
      throw new AppError(`Dossier inaccessible : ${dir} (${e instanceof Error ? e.message : String(e)})`, 'INVALID');
    }
    const now = this.clock();
    const file = join(dir, opts.name ?? fileName(remote?.store_name ?? store.name, kind, now));
    const tmp = `${file}.part`;
    const meta: FicheMeta = {
      v: 1,
      id: newId(),
      kind,
      storeId: remote?.store_id ?? store.id,
      storeCode: remote?.store_code ?? store.code,
      storeName: remote?.store_name ?? store.name,
      at: now.toISOString(),
      byId: user?.id ?? null,
      byName: user?.name ?? null,
      appVersion,
      baseSeq: 0,
      settings: {},
      counters: {},
    };
    try {
      // Copie à chaud : la caisse continue de vendre pendant la sortie de la fiche.
      await this.db.backup(tmp);
      const copy = new Database(tmp);
      try {
        copy.pragma('journal_mode = DELETE');
        copy.transaction(() => {
          meta.baseSeq = (copy.prepare('SELECT MAX(seq) FROM outbox').pluck().get() as number | null) ?? 0;
          const keys = copy.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
          for (const { key, value } of keys) {
            if (!isPosteSetting(key)) meta.settings[key] = value;
            else if (!KEPT_IN_FICHE.has(key)) copy.prepare('DELETE FROM settings WHERE key = ?').run(key);
          }
          for (const c of copy.prepare('SELECT name, value FROM counters').all() as { name: string; value: number }[]) meta.counters[c.name] = c.value;
          copy.prepare('DELETE FROM sync_conflicts').run();
          if (remote) {
            // Le poste distant ouvre sur sa caisse et ne remontera que ce qu'il fera lui-même.
            const set = copy.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
            set.run('station.storeId', remote.store_id);
            set.run('station.registerId', remote.id);
            set.run('relay.role', 'distant');
            set.run('relay.lastSeq', String(meta.baseSeq));
            copy.prepare('UPDATE registers SET activated_at = ? WHERE id = ?').run(meta.at, remote.id);
          }
          copy.prepare("INSERT INTO settings (key, value) VALUES ('fiche.meta', ?)").run(JSON.stringify(meta));
        })();
      } finally {
        copy.close();
      }
      renameSync(tmp, file);
    } catch (e) {
      rmSync(tmp, { force: true });
      throw new AppError(`Fiche impossible dans ${dir} : ${e instanceof Error ? e.message : String(e)}`, 'FICHE_FAILED');
    }
    const info = inspectDossier(file);
    if (!info.ok) throw new AppError(`La fiche relue est invalide : ${info.error}`, 'FICHE_FAILED');
    // La boutique enverra au poste distant ce qu'elle fera à partir de maintenant.
    if (remote) this.setSetting(`relay.out.${remote.store_id}`, String(meta.baseSeq));
    if (opts.log === false) return info;
    this.db
      .prepare('INSERT INTO fiche_log (id, kind, file, base_seq, user_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(meta.id, kind, file, meta.baseSeq, user?.id ?? null, meta.at);
    this.audit(user?.id ?? null, 'fiche.export', 'fiche', meta.id, { kind, file });
    return info;
  }

  private setting(key: string): string | null {
    return (this.db.prepare('SELECT value FROM settings WHERE key = ?').pluck().get(key) as string | undefined) ?? null;
  }

  private setSetting(key: string, value: string | null): void {
    if (value === null) this.db.prepare('DELETE FROM settings WHERE key = ?').run(key);
    else this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  /** Dossier partagé de ce PC et fiches qui y attendent d'être rapportées. */
  shareStatus(): ShareStatus {
    const dir = this.setting('share.dir');
    const pending: ShareStatus['pending'] = [];
    if (dir) {
      const returns = join(dir, SHARE_RETURNS);
      let names: string[] = [];
      try {
        names = readdirSync(returns).filter((f) => /\.(fedonix|fedonixz)$/i.test(f));
      } catch {
        // Dossier absent ou réseau coupé : rien à rapporter pour l'instant.
      }
      for (const name of names) {
        const file = join(returns, name);
        if (isPackedFiche(file)) {
          pending.push({ file, name, packed: true, store_name: null, kind: null, at: null, by_name: null, error: null });
          continue;
        }
        const info = this.check(file);
        if (info.returned_at || info.fiche?.kind === 'installation') continue;
        if (info.fiche && !this.db.prepare('SELECT 1 FROM stores WHERE id = ?').get(info.fiche.storeId)) continue;
        pending.push({ file, name, packed: false, store_name: info.store_name, kind: info.fiche?.kind ?? null, at: info.fiche?.at ?? null, by_name: info.fiche?.byName ?? null, error: info.ok ? (info.fiche ? null : "Ce fichier n'est pas une fiche") : info.error });
      }
    }
    return { dir, every: Number(this.setting('share.every')) || 0, last_at: this.setting('share.lastAt'), last_error: this.setting('share.lastError'), pending };
  }

  configureShare(userId: string, input: { dir?: string | null; every?: number }): ShareStatus {
    if (input.dir !== undefined) {
      if (input.dir) {
        try {
          mkdirSync(join(input.dir, SHARE_COMPTABLE), { recursive: true });
          mkdirSync(join(input.dir, SHARE_RETURNS), { recursive: true });
        } catch (e) {
          throw new AppError(`Dossier inaccessible : ${input.dir} (${e instanceof Error ? e.message : String(e)})`, 'INVALID');
        }
      }
      this.setSetting('share.dir', input.dir || null);
    }
    if (input.every !== undefined) {
      if (!SHARE_FREQUENCIES.some(([m]) => m === input.every)) throw new AppError('Fréquence inconnue', 'INVALID');
      this.setSetting('share.every', String(input.every));
    }
    this.audit(userId, 'fiche.share', undefined, undefined, input);
    return this.shareStatus();
  }

  /**
   * Copie pour le comptable déposée dans le dossier partagé, à la fréquence réglée
   * (une seule copie, remplacée à chaque fois). N'échoue jamais : l'erreur est gardée.
   */
  async autoShare(appVersion: string, force = false): Promise<DossierInfo | null> {
    if (this.current()) return null;
    const { dir, every, last_at } = this.shareStatus();
    if (!dir || (!force && (!every || (last_at && this.clock().getTime() - new Date(last_at).getTime() < every * 60_000)))) return null;
    const store = this.db.prepare("SELECT s.name FROM settings k JOIN stores s ON s.id = k.value WHERE k.key = 'station.storeId'").pluck().get() as string | undefined;
    if (!store) return null;
    try {
      const name = fileName(store, 'comptable', this.clock()).replace(/-\d{4}-\d{2}-\d{2}-\d{4}(?=\.)/, '');
      const info = await this.export(null, 'comptable', join(dir, SHARE_COMPTABLE), appVersion, { name, log: false });
      this.setSetting('share.lastAt', this.now());
      this.setSetting('share.lastError', null);
      return info;
    } catch (e) {
      this.setSetting('share.lastAt', this.now());
      this.setSetting('share.lastError', e instanceof Error ? e.message : String(e));
      return null;
    }
  }

  /** Range une fiche du dossier partagé une fois rapportée (« Retours › Rapportées »). */
  archiveShared(file: string): void {
    const dir = this.setting('share.dir');
    if (!dir || resolve(join(file, '..')) !== resolve(join(dir, SHARE_RETURNS)) || !existsSync(file)) return;
    try {
      mkdirSync(join(dir, SHARE_RETURNS, SHARE_DONE), { recursive: true });
      renameSync(file, join(dir, SHARE_RETURNS, SHARE_DONE, basename(file)));
    } catch {
      // Le fichier reste en place ; il ne peut pas être rapporté deux fois.
    }
  }

  /** Décrit une fiche avant de la rapporter : à quelle boutique elle appartient, quand elle est sortie. */
  check(file: string): DossierInfo & { returned_at: string | null } {
    const info = inspectDossier(file);
    const returned = info.fiche ? (this.db.prepare('SELECT returned_at FROM fiche_log WHERE id = ?').pluck().get(info.fiche.id) as string | null | undefined) : null;
    return { ...info, returned_at: returned ?? null };
  }

  /**
   * Chez le technicien : remet la fiche sur la clé USB pour la rapporter à la
   * boutique (copie à chaud, sous le même nom ; une copie déjà sur la clé est remplacée).
   */
  async saveCopy(dir: string): Promise<DossierInfo> {
    const meta = this.current();
    if (!meta || meta.kind === 'installation') throw new AppError("Seule une fiche d'intervention ou une copie comptable se rapporte à la boutique", 'INVALID');
    const file = join(dir, basename(this.db.name).replace(/\.[^.]+$/, '') + `.${FICHE_EXTENSION}`);
    if (resolve(file) === resolve(this.db.name)) throw new AppError('Choisissez la clé USB ou un autre dossier que celui de la fiche', 'INVALID');
    const tmp = `${file}.part`;
    try {
      mkdirSync(dir, { recursive: true });
      await this.db.backup(tmp);
      const copy = new Database(tmp);
      try {
        copy.pragma('journal_mode = DELETE');
      } finally {
        copy.close();
      }
      renameSync(tmp, file);
    } catch (e) {
      rmSync(tmp, { force: true });
      throw new AppError(`Copie impossible dans ${dir} : ${e instanceof Error ? e.message : String(e)}`, 'FICHE_FAILED');
    }
    this.audit(null, 'fiche.copy', 'fiche', meta.id, { file });
    return inspectDossier(file);
  }

  /**
   * Rapporte une fiche d'intervention ou une copie comptable : ce qui a été fait
   * dans la fiche est ajouté à la boutique, qui a continué de vendre entre-temps.
   */
  bringBack(userId: string, file: string): FicheReturn {
    if (this.current()) throw new AppError('Ouvrez la boutique elle-même pour y rapporter une fiche', 'FICHE');
    const info = inspectDossier(file);
    if (!info.ok) throw new AppError(info.error ?? 'Fiche invalide', 'INVALID');
    const meta = readFicheFile(file);
    if (!meta) throw new AppError("Ce fichier n'est pas une fiche FEDONIX 360", 'INVALID');
    if (meta.kind === 'installation') throw new AppError("Une installation préparée s'installe au premier démarrage d'un PC : elle ne se rapporte pas", 'INVALID');
    if (!this.db.prepare('SELECT 1 FROM stores WHERE id = ?').get(meta.storeId)) {
      throw new AppError(`Cette fiche appartient à une autre boutique (${meta.storeName})`, 'INVALID');
    }
    const returned = this.db.prepare('SELECT returned_at FROM fiche_log WHERE id = ?').pluck().get(meta.id) as string | null | undefined;
    if (returned) throw new AppError(`Cette fiche a déjà été rapportée le ${frDateTime(returned)}`, 'ALREADY_RETURNED');

    // On travaille sur une copie : la fiche sur la clé USB n'est pas modifiée (mise à niveau du schéma comprise).
    const tmp = join(tmpdir(), `fedonix-retour-${newId()}.db`);
    copyFileSync(file, tmp);
    const fiche = openDatabase(tmp);
    try {
      const ficheSync = new SyncService(fiche, this.clock, new StockService(fiche, this.clock));
      const events = ficheSync.eventsSince(meta.baseSeq);
      const { applied, conflicts } = this.sync.adopt(events);
      let settings = 0;
      this.tx(() => {
        // Réglages de la boutique changés dans la fiche (jamais ceux du PC).
        const now = new Map((fiche.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[]).map((r) => [r.key, r.value]));
        const set = this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
        for (const [key, value] of now) {
          if (isPosteSetting(key) || meta.settings[key] === value) continue;
          set.run(key, value);
          settings++;
        }
        for (const key of Object.keys(meta.settings)) {
          if (!now.has(key)) {
            this.db.prepare('DELETE FROM settings WHERE key = ?').run(key);
            settings++;
          }
        }
        // Les numéros pris dans la fiche ne seront pas repris par une prochaine fiche.
        for (const c of fiche.prepare('SELECT name, value FROM counters').all() as { name: string; value: number }[]) {
          if (c.value > (meta.counters[c.name] ?? 0)) this.raiseCounter(c.name, c.value);
        }
        // Ce qui a été fait dans la fiche reste visible dans le journal d'audit de la boutique.
        const insert = this.db.prepare('INSERT OR IGNORE INTO audit_log (id, user_id, action, entity, entity_id, details, at) VALUES (@id, @user_id, @action, @entity, @entity_id, @details, @at)');
        for (const row of fiche.prepare('SELECT * FROM audit_log WHERE at >= ? ORDER BY at').all(meta.at) as Record<string, unknown>[]) {
          try {
            insert.run(row);
          } catch {
            insert.run({ ...row, user_id: null });
          }
        }
        const summary: FicheReturn = { kind: meta.kind, byName: meta.byName, at: meta.at, changes: events.length, applied, conflicts, settings };
        this.db
          .prepare(
            `INSERT INTO fiche_log (id, kind, file, base_seq, user_id, created_at, returned_at, returned_by, summary) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET returned_at = excluded.returned_at, returned_by = excluded.returned_by, summary = excluded.summary`,
          )
          .run(meta.id, meta.kind, file, meta.baseSeq, meta.byId, meta.at, this.now(), userId, JSON.stringify(summary));
        this.audit(userId, 'fiche.return', 'fiche', meta.id, summary);
      });
      return { kind: meta.kind, byName: meta.byName, at: meta.at, changes: events.length, applied, conflicts, settings };
    } finally {
      fiche.close();
      for (const ext of ['', '-wal', '-shm']) rmSync(`${tmp}${ext}`, { force: true });
    }
  }
}
