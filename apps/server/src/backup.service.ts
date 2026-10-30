import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Readable } from 'node:stream';
import { gunzipSync } from 'node:zlib';
import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { CONFIG, type ServerConfig } from './config';
import { type Db, PG } from './database';
import { startEpoch } from './epoch';

const NAME = /^fedo-serveur-[\w-]+\.tar\.gz$/;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** Fréquences proposées, en heures. */
export const BACKUP_EVERY = [1, 2, 4, 6, 12, 24];
/** Une sauvegarde déposée par l'interface ne dépasse pas 2 Go. */
const MAX_UPLOAD = 2 * 1024 ** 3;

/** État des sauvegardes du serveur, montré aussi aux PC dans leur barre d'état. */
export interface ServerBackupState {
  /** Date de la dernière sauvegarde réussie (null : aucune). */
  at: string | null;
  /** Problème à signaler aux PC, en clair (null : tout va bien). */
  problem: string | null;
}

export interface BackupFile {
  name: string;
  size: number;
  at: string;
}

/**
 * Sauvegardes de la base intégrée : une copie complète par jour (et à la demande),
 * rangée dans un dossier ; les plus anciennes au-delà du nombre gardé sont effacées.
 * Avec un serveur PostgreSQL, les sauvegardes se font avec les outils de PostgreSQL.
 */
@Injectable()
export class BackupService {
  private timer: NodeJS.Timeout | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  lastError: string | null = null;
  /** Dernière copie vers le second dossier en échec (clé USB débranchée, dossier introuvable). */
  copyError: string | null = null;

  constructor(
    @Inject(PG) private readonly pg: Db,
    @Inject(CONFIG) private readonly config: ServerConfig,
  ) {}

  get available(): boolean {
    return typeof this.pg.dump === 'function';
  }

  private async setting(key: string): Promise<string | null> {
    const { rows } = await this.pg.query<{ value: string }>('SELECT value FROM settings WHERE key = $1', [key]);
    return rows[0]?.value ?? null;
  }

  private async setSetting(key: string, value: string) {
    await this.pg.query('INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', [key, value]);
  }

  async dir(): Promise<string> {
    const chosen = await this.setting('backup_dir');
    if (chosen) return chosen;
    if (this.config.backupDir) return this.config.backupDir;
    return join(dirname(this.config.dataDir ?? '.'), 'Sauvegardes');
  }

  async keep(): Promise<number> {
    return Number((await this.setting('backup_keep')) ?? 40);
  }

  /** Une sauvegarde toutes les N heures (6 par défaut). */
  async every(): Promise<number> {
    const n = Number((await this.setting('backup_every')) ?? 6);
    return BACKUP_EVERY.includes(n) ? n : 6;
  }

  /** Second dossier où chaque sauvegarde est recopiée (clé USB, autre disque, OneDrive) ; null : aucun. */
  async copyDir(): Promise<string | null> {
    return (await this.setting('backup_copy_dir')) || null;
  }

  private static writable(dir: string) {
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, '.essai'), '');
      rmSync(join(dir, '.essai'));
    } catch {
      throw new BadRequestException(`Impossible d'écrire dans le dossier ${dir}`);
    }
  }

  async configure(input: { dir?: string; keep?: number; every?: number; copyDir?: string | null }) {
    if (input.dir !== undefined) {
      const dir = input.dir.trim();
      if (!dir) throw new BadRequestException('Indiquez un dossier');
      BackupService.writable(dir);
      await this.setSetting('backup_dir', dir);
    }
    if (input.copyDir !== undefined) {
      const dir = (input.copyDir ?? '').trim();
      if (dir) {
        if (dir.replace(/[\\/]+$/, '').toLowerCase() === (await this.dir()).replace(/[\\/]+$/, '').toLowerCase()) {
          throw new BadRequestException('Choisissez un autre dossier que celui des sauvegardes : une clé USB ou un autre disque');
        }
        BackupService.writable(dir);
      }
      await this.setSetting('backup_copy_dir', dir);
      this.copyError = null;
      if (dir) await this.copyAll();
    }
    if (input.every !== undefined) {
      const every = Math.round(Number(input.every));
      if (!BACKUP_EVERY.includes(every)) throw new BadRequestException(`Fréquence : toutes les ${BACKUP_EVERY.join(', ')} heures`);
      await this.setSetting('backup_every', String(every));
    }
    if (input.keep !== undefined) {
      const keep = Math.round(Number(input.keep));
      if (!(keep >= 1 && keep <= 365)) throw new BadRequestException('Nombre de sauvegardes gardées : entre 1 et 365');
      await this.setSetting('backup_keep', String(keep));
    }
  }

  async list(dir?: string): Promise<BackupFile[]> {
    dir ??= await this.dir();
    let names: string[];
    try {
      names = readdirSync(dir).filter((n) => NAME.test(n));
    } catch {
      return [];
    }
    return names
      .map((name) => {
        const st = statSync(join(dir, name));
        return { name, size: st.size, at: st.mtime.toISOString() };
      })
      .sort((a, b) => b.at.localeCompare(a.at));
  }

  /** Une sauvegarde à la fois : les demandes s'enchaînent. */
  private serial<T>(task: () => Promise<T>): Promise<T> {
    const next = this.chain.then(task);
    this.chain = next.catch(() => undefined);
    return next;
  }

  backupNow(label = ''): Promise<BackupFile> {
    return this.serial(async () => {
      if (!this.pg.dump) throw new BadRequestException('Sauvegarde automatique disponible avec la base intégrée seulement');
      const dir = await this.dir();
      mkdirSync(dir, { recursive: true });
      const d = new Date();
      const pad = (n: number) => String(n).padStart(2, '0');
      const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
      const name = `fedo-serveur-${stamp}${label ? `-${label}` : ''}.tar.gz`;
      const data = await this.pg.dump();
      // Écrite sous un nom provisoire puis renommée : une coupure de courant ne laisse pas une sauvegarde à moitié écrite.
      writeFileSync(join(dir, `${name}.part`), data);
      renameSync(join(dir, `${name}.part`), join(dir, name));
      BackupService.check(readFileSync(join(dir, name)), data);
      // On garde les plus récentes.
      const keep = await this.keep();
      const all = await this.list();
      for (const old of all.slice(keep)) rmSync(join(dir, old.name), { force: true });
      this.lastError = null;
      await this.copyAll();
      return all.find((b) => b.name === name) ?? { name, size: 0, at: d.toISOString() };
    });
  }

  /** Relit une sauvegarde écrite : même contenu que la base sortie, archive lisible. */
  private static check(written: Buffer, expected?: Buffer) {
    if (expected && !written.equals(expected)) throw new Error('La sauvegarde relue ne correspond pas à la base');
    try {
      gunzipSync(written);
    } catch {
      throw new Error('La sauvegarde relue est abîmée');
    }
  }

  /**
   * Recopie dans le second dossier les sauvegardes qui n'y sont pas encore (aussi celles
   * faites pendant que la clé USB était débranchée), relit chaque copie, et garde là-bas
   * le même nombre de sauvegardes qu'ici.
   */
  private async copyAll(): Promise<void> {
    const target = await this.copyDir();
    if (!target) {
      this.copyError = null;
      return;
    }
    try {
      if (!existsSync(target)) mkdirSync(target, { recursive: true });
      const here = await this.list();
      const there = new Map((await this.list(target)).map((b) => [b.name, b]));
      const dir = await this.dir();
      for (const b of here) {
        if (there.get(b.name)?.size === b.size) continue;
        const data = readFileSync(join(dir, b.name));
        writeFileSync(join(target, `${b.name}.part`), data);
        renameSync(join(target, `${b.name}.part`), join(target, b.name));
        const copy = readFileSync(join(target, b.name));
        if (createHash('sha256').update(copy).digest('hex') !== createHash('sha256').update(data).digest('hex')) {
          throw new Error(`la copie de ${b.name} relue sur ${target} est différente`);
        }
      }
      const keep = await this.keep();
      for (const old of (await this.list(target)).slice(keep)) rmSync(join(target, old.name), { force: true });
      this.copyError = null;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.copyError = `Copie vers ${target} impossible (clé USB débranchée ?) : ${msg}`;
      console.warn('[sauvegarde]', this.copyError);
    }
  }

  /**
   * Dépose une sauvegarde venue d'ailleurs (clé USB, autre serveur) dans le dossier des
   * sauvegardes, pour la restaurer ensuite. Le fichier arrive tel quel (application/octet-stream).
   */
  async upload(name: string, body: Readable): Promise<BackupFile> {
    const clean = String(name ?? '').replace(/^.*[\\/]/, '');
    if (!NAME.test(clean)) {
      body.resume();
      throw new BadRequestException('Choisissez une sauvegarde du serveur : un fichier fedo-serveur-….tar.gz');
    }
    const dir = await this.dir();
    mkdirSync(dir, { recursive: true });
    const tmp = join(dir, `${clean}.envoi`);
    let size = 0;
    try {
      await new Promise<void>((resolve, reject) => {
        const out = createWriteStream(tmp);
        body.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_UPLOAD) {
            body.destroy();
            out.destroy();
            reject(new BadRequestException('Fichier trop gros'));
          }
        });
        body.on('error', reject);
        out.on('error', reject);
        out.on('finish', resolve);
        body.pipe(out);
      });
      try {
        BackupService.check(readFileSync(tmp));
      } catch {
        throw new BadRequestException("Ce fichier est abîmé ou n'est pas une sauvegarde du serveur");
      }
      renameSync(tmp, join(dir, clean));
    } finally {
      rmSync(tmp, { force: true });
    }
    const st = statSync(join(dir, clean));
    return { name: clean, size: st.size, at: st.mtime.toISOString() };
  }

  /** État montré aux PC : dernière sauvegarde, et problème éventuel (échec, retard, copie impossible). */
  async state(): Promise<ServerBackupState | null> {
    if (!this.available) return null;
    const last = (await this.list()).find((b) => !b.name.includes('avant-restauration')) ?? null;
    let problem: string | null = null;
    if (this.lastError) problem = `Sauvegarde du serveur en échec : ${this.lastError}`;
    else if (this.copyError) problem = this.copyError;
    else if (last && Date.now() - Date.parse(last.at) > Math.max(2 * (await this.every()) * HOUR_MS, DAY_MS) + HOUR_MS) {
      problem = `Sauvegarde du serveur en retard : la dernière date du ${new Date(last.at).toLocaleDateString('fr-FR')}`;
    }
    return { at: last?.at ?? null, problem };
  }

  async file(name: string): Promise<Buffer> {
    if (!NAME.test(name)) throw new BadRequestException('Nom de sauvegarde invalide');
    try {
      return readFileSync(join(await this.dir(), name));
    } catch {
      throw new NotFoundException('Sauvegarde introuvable');
    }
  }

  /** Remet la base dans l'état d'une sauvegarde ; l'état actuel est d'abord sauvegardé. */
  async restore(name: string): Promise<void> {
    if (!this.pg.load) throw new BadRequestException('Restauration disponible avec la base intégrée seulement');
    const data = await this.file(name);
    await this.backupNow('avant-restauration');
    await this.serial(async () => {
      const { rows } = await this.pg.query<{ max: string | number | null }>('SELECT MAX(seq) AS max FROM events');
      try {
        await this.pg.load!(data);
      } catch (e) {
        throw new BadRequestException(`Cette sauvegarde ne peut pas être ouverte : ${e instanceof Error ? e.message : String(e)}`);
      }
      // Les PC ont déjà lu jusqu'à ce numéro : les nouvelles opérations doivent venir après, sinon ils ne les verraient pas.
      const max = Number(rows[0]?.max ?? 0);
      if (max > 0) {
        await this.pg.query("SELECT setval(pg_get_serial_sequence('events', 'seq'), GREATEST($1::bigint, (SELECT COALESCE(MAX(seq), 1) FROM events)))", [max]);
      }
      // Nouvelle époque : chaque PC reprend sa lecture après la sauvegarde et renvoie ce qu'elle n'a pas
      // (indispensable quand la sauvegarde est restaurée sur un autre PC, dont la base était vide).
      await startEpoch(this.pg);
    });
  }

  /** Sauvegarde quand la dernière a plus que la fréquence choisie ; recopie ce qui manque sur la clé. */
  async tick(): Promise<void> {
    if (!this.available) return;
    const last = (await this.list()).find((b) => !b.name.includes('avant-restauration'));
    if (last && Date.now() - Date.parse(last.at) < (await this.every()) * HOUR_MS - 60_000) {
      if (await this.copyDir()) await this.serial(() => this.copyAll());
      return;
    }
    const { rows } = await this.pg.query<{ n: number }>('SELECT COUNT(*)::int AS n FROM events');
    if (!rows[0]?.n) return;
    try {
      await this.backupNow();
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
      console.warn('[sauvegarde]', this.lastError);
    }
  }

  start() {
    if (!this.available || this.timer) return;
    const run = () => void this.tick().catch((e) => console.warn('[sauvegarde]', e));
    setTimeout(run, 60_000).unref();
    this.timer = setInterval(run, 10 * 60_000);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
