import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import type { Db } from './database';
import { MIGRATIONS } from './schema';
import { AppError, Base, type Clock } from './util';

export type BackupKind = 'auto' | 'manual' | 'safety';

export interface BackupInfo {
  file: string;
  name: string;
  size: number;
  kind: BackupKind;
  /** Date de la sauvegarde (heure du fichier). */
  created_at: string;
  ok: boolean;
  /** Raison pour laquelle la sauvegarde ne peut pas être restaurée. */
  error: string | null;
  version: number;
  store_name: string | null;
  articles: number;
  sales: number;
  last_sale_at: string | null;
}

export interface BackupStatus {
  /** Dossier des sauvegardes automatiques. */
  dir: string | null;
  /** Second dossier (clé USB, dossier OneDrive / Google Drive) qui reçoit une copie de chaque sauvegarde automatique. */
  copy_dir: string | null;
  keep: number;
  last_at: string | null;
  last_file: string | null;
  last_error: string | null;
  /** Aucune sauvegarde réussie depuis plus de 2 jours. */
  overdue: boolean;
}

const NAME = /^superette-.+-(\d{4}-\d{2}-\d{2})-(\d{4}(?:\d{2})?)-(auto|manual|safety)\.db$/;
const DEFAULT_KEEP = 14;
/** Clé de tri chronologique tirée du nom (date et heure de la sauvegarde). */
const when = (name: string) => {
  const m = NAME.exec(name);
  return m ? `${m[1]}-${m[2]!.padEnd(6, '0')}` : '';
};
const CURRENT_VERSION = Math.max(...MIGRATIONS.map((m) => m.version));

/** Ramène un fichier de base en un seul fichier autonome (sans -wal ni -shm), pour la clé USB. */
function standalone(file: string): void {
  const db = new Database(file);
  try {
    db.pragma('journal_mode = DELETE');
  } finally {
    db.close();
  }
}

/** Lit une sauvegarde sans la modifier et dit si elle peut être restaurée. */
export function inspectBackup(file: string): BackupInfo {
  const kind = (NAME.exec(basename(file))?.[3] as BackupKind | undefined) ?? 'manual';
  const info: BackupInfo = {
    file,
    name: basename(file),
    size: 0,
    kind,
    created_at: '',
    ok: false,
    error: null,
    version: 0,
    store_name: null,
    articles: 0,
    sales: 0,
    last_sale_at: null,
  };
  try {
    const st = statSync(file);
    info.size = st.size;
    info.created_at = st.mtime.toISOString();
  } catch {
    return { ...info, error: 'Fichier introuvable' };
  }
  let db: Db | null = null;
  try {
    db = new Database(file, { readonly: true, fileMustExist: true });
    const check = db.pragma('quick_check', { simple: true });
    if (check !== 'ok') return { ...info, error: `Fichier abîmé (${String(check)})` };
    const hasMigrations = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").pluck().get();
    if (!hasMigrations) return { ...info, error: "Ce fichier n'est pas une base Superette Gestion" };
    info.version = (db.prepare('SELECT MAX(version) FROM schema_migrations').pluck().get() as number | null) ?? 0;
    info.store_name =
      (db.prepare("SELECT s.name FROM settings k JOIN stores s ON s.id = k.value WHERE k.key = 'station.storeId'").pluck().get() as string | undefined) ?? null;
    info.articles = db.prepare('SELECT COUNT(*) FROM articles').pluck().get() as number;
    info.sales = db.prepare("SELECT COUNT(*) FROM sales WHERE status = 'completed'").pluck().get() as number;
    info.last_sale_at = (db.prepare('SELECT MAX(created_at) FROM sales').pluck().get() as string | null) ?? null;
    if (info.version > CURRENT_VERSION) return { ...info, error: "Sauvegarde faite par une version plus récente de l'application : mettez-la à jour d'abord" };
    return { ...info, ok: true };
  } catch (e) {
    return { ...info, error: `Fichier illisible : ${e instanceof Error ? e.message : String(e)}` };
  } finally {
    db?.close();
  }
}

/**
 * Remplace la base par une sauvegarde. La base doit être fermée. La base actuelle
 * est d'abord copiée dans `safetyFile` (« avant restauration »).
 */
export function restoreDatabase(dbFile: string, backupFile: string, safetyFile: string, keepSettings: Record<string, string | null> = {}): void {
  const info = inspectBackup(backupFile);
  if (!info.ok) throw new AppError(info.error ?? 'Sauvegarde invalide', 'INVALID');
  mkdirSync(dirname(safetyFile), { recursive: true });
  if (existsSync(dbFile)) {
    copyFileSync(dbFile, safetyFile);
    standalone(safetyFile);
  }
  const tmp = `${dbFile}.restore`;
  copyFileSync(backupFile, tmp);
  for (const ext of ['-wal', '-shm']) rmSync(`${dbFile}${ext}`, { force: true });
  renameSync(tmp, dbFile);
  const db = new Database(dbFile);
  try {
    for (const [key, value] of Object.entries(keepSettings)) {
      if (value === null) db.prepare('DELETE FROM settings WHERE key = ?').run(key);
      else db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
    }
  } finally {
    db.close();
  }
}

/**
 * Sauvegardes de la base locale : copie à chaud (la caisse continue de vendre),
 * vérifiée en la relisant, une fois par jour automatiquement avec un nombre de
 * copies gardées, plus une copie vers un second dossier (clé USB, cloud).
 */
export class BackupService extends Base {
  constructor(db: Db, clock?: Clock) {
    super(db, clock);
  }

  private setting(key: string): string | null {
    return (this.db.prepare('SELECT value FROM settings WHERE key = ?').pluck().get(key) as string | undefined) ?? null;
  }

  private setSetting(key: string, value: string | null): void {
    if (value === null) this.db.prepare('DELETE FROM settings WHERE key = ?').run(key);
    else this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  /** Fichier de la base ouverte, ou null pour une base en mémoire (tests). */
  databaseFile(): string | null {
    return this.db.memory ? null : this.db.name;
  }

  /** Dossier par défaut : « sauvegardes » à côté de la base. */
  defaultDir(): string | null {
    const file = this.databaseFile();
    return file ? join(dirname(file), 'sauvegardes') : null;
  }

  status(): BackupStatus {
    const lastAt = this.setting('backup.lastAt');
    const overdue = !lastAt || this.clock().getTime() - new Date(lastAt).getTime() > 2 * 86_400_000;
    return {
      dir: this.setting('backup.dir') ?? this.defaultDir(),
      copy_dir: this.setting('backup.copyDir'),
      keep: Number(this.setting('backup.keep')) || DEFAULT_KEEP,
      last_at: lastAt,
      last_file: this.setting('backup.lastFile'),
      last_error: this.setting('backup.lastError'),
      overdue,
    };
  }

  configure(userId: string, input: { dir?: string | null; copyDir?: string | null; keep?: number }): BackupStatus {
    if (input.keep !== undefined) {
      if (!Number.isInteger(input.keep) || input.keep < 1 || input.keep > 365) throw new AppError('Nombre de sauvegardes gardées invalide (1 à 365)', 'INVALID');
      this.setSetting('backup.keep', String(input.keep));
    }
    if (input.dir !== undefined) this.setSetting('backup.dir', input.dir?.trim() || null);
    if (input.copyDir !== undefined) this.setSetting('backup.copyDir', input.copyDir?.trim() || null);
    this.audit(userId, 'backup.configure', undefined, undefined, input);
    return this.status();
  }

  private stamp(): string {
    const d = this.clock();
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  }

  /** Préfixe des fichiers : code du magasin et numéro de caisse, pour distinguer les PC. */
  private prefix(): string {
    return `superette-${this.stationPrefix()}`;
  }

  /** Copie de la base dans `dir` (dossier automatique par défaut), vérifiée. */
  async backup(userId: string | null, opts: { dir?: string; kind?: BackupKind } = {}): Promise<BackupInfo> {
    const kind = opts.kind ?? 'manual';
    const dir = opts.dir ?? this.status().dir;
    if (!dir) throw new AppError('Choisissez le dossier des sauvegardes', 'INVALID');
    try {
      mkdirSync(dir, { recursive: true });
    } catch (e) {
      throw new AppError(`Dossier inaccessible : ${dir} (${e instanceof Error ? e.message : String(e)})`, 'INVALID');
    }
    const file = join(dir, `${this.prefix()}-${this.stamp()}-${kind}.db`);
    const tmp = `${file}.part`;
    try {
      // Copie à chaud par l'API de sauvegarde SQLite : cohérente même pendant une vente.
      await this.db.backup(tmp);
      standalone(tmp);
      renameSync(tmp, file);
    } catch (e) {
      rmSync(tmp, { force: true });
      throw new AppError(`Sauvegarde impossible dans ${dir} : ${e instanceof Error ? e.message : String(e)}`, 'BACKUP_FAILED');
    }
    const info = inspectBackup(file);
    if (!info.ok) throw new AppError(`La copie relue est invalide : ${info.error}`, 'BACKUP_FAILED');
    this.audit(userId, 'backup.create', undefined, undefined, { file, kind, size: info.size });
    return info;
  }

  /** Où copier la base actuelle juste avant une restauration. */
  safetyFile(): string {
    const dir = this.status().dir;
    if (!dir) throw new AppError('Choisissez le dossier des sauvegardes', 'INVALID');
    return join(dir, `${this.prefix()}-${this.stamp()}-safety.db`);
  }

  /** Sauvegarde du jour déjà faite dans le dossier automatique ? */
  doneToday(): boolean {
    const lastAt = this.setting('backup.lastAt');
    if (!lastAt) return false;
    const d = (x: Date) => `${x.getFullYear()}-${x.getMonth()}-${x.getDate()}`;
    return d(new Date(lastAt)) === d(this.clock());
  }

  /**
   * Sauvegarde du jour dans le dossier des sauvegardes : les plus anciennes au-delà
   * du nombre gardé sont effacées, puis copie vers le second dossier s'il est réglé
   * (une copie impossible n'annule pas la sauvegarde, elle est signalée).
   */
  async saveNow(userId: string | null): Promise<BackupInfo> {
    const status = this.status();
    if (!status.dir) throw new AppError('Choisissez le dossier des sauvegardes', 'INVALID');
    try {
      const info = await this.backup(userId, { dir: status.dir, kind: 'auto' });
      this.setSetting('backup.lastAt', this.clock().toISOString());
      this.setSetting('backup.lastFile', info.file);
      this.prune(status.dir, status.keep);
      let error: string | null = null;
      if (status.copy_dir) {
        try {
          mkdirSync(status.copy_dir, { recursive: true });
          copyFileSync(info.file, join(status.copy_dir, info.name));
          this.prune(status.copy_dir, status.keep);
        } catch (e) {
          error = `Copie vers ${status.copy_dir} impossible (clé USB débranchée ?) : ${e instanceof Error ? e.message : String(e)}`;
        }
      }
      this.setSetting('backup.lastError', error);
      return info;
    } catch (e) {
      this.setSetting('backup.lastError', e instanceof Error ? e.message : String(e));
      throw e;
    }
  }

  /** Sauvegarde automatique : une par jour, n'échoue jamais (l'erreur est gardée pour l'afficher). */
  async runAutomatic(force = false): Promise<BackupInfo | null> {
    if (!force && this.doneToday()) return null;
    if (!this.status().dir) return null;
    try {
      return await this.saveNow(null);
    } catch {
      return null;
    }
  }

  /** Réglages propres au PC, gardés quand on restaure une sauvegarde plus ancienne. */
  localSettings(): Record<string, string | null> {
    return Object.fromEntries(['backup.dir', 'backup.copyDir', 'backup.keep', 'backup.lastAt', 'backup.lastFile', 'backup.lastError'].map((k) => [k, this.setting(k)]));
  }

  /** Efface les sauvegardes automatiques les plus anciennes au-delà de `keep`. */
  private prune(dir: string, keep: number): void {
    const autos = this.files(dir)
      .filter((f) => NAME.exec(f)?.[3] === 'auto')
      .sort((a, b) => when(b).localeCompare(when(a)));
    for (const f of autos.slice(keep)) rmSync(join(dir, f), { force: true });
  }

  private files(dir: string): string[] {
    try {
      return readdirSync(dir).filter((f) => NAME.test(f));
    } catch {
      return [];
    }
  }

  /** Sauvegardes trouvées dans un dossier (le dossier automatique par défaut), les plus récentes d'abord. */
  list(dir?: string | null): BackupInfo[] {
    const target = dir ?? this.status().dir;
    if (!target) return [];
    return this.files(target)
      .map((f) => inspectBackup(join(target, f)))
      .sort((a, b) => when(b.name).localeCompare(when(a.name)));
  }

  /** Trace la restauration dans le journal d'audit de la base restaurée (appelé au redémarrage). */
  recordRestore(userId: string | null, details: unknown): void {
    this.audit(userId, 'backup.restore', undefined, undefined, details);
  }
}
