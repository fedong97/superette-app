import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { CONFIG, type ServerConfig } from './config';
import { type Db, PG } from './database';

const NAME = /^fedo-serveur-[\w-]+\.tar\.gz$/;
const DAY_MS = 24 * 3_600_000;

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
    return Number((await this.setting('backup_keep')) ?? 30);
  }

  async configure(input: { dir?: string; keep?: number }) {
    if (input.dir !== undefined) {
      const dir = input.dir.trim();
      if (!dir) throw new BadRequestException('Indiquez un dossier');
      try {
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, '.essai'), '');
        rmSync(join(dir, '.essai'));
      } catch {
        throw new BadRequestException(`Impossible d'écrire dans le dossier ${dir}`);
      }
      await this.setSetting('backup_dir', dir);
    }
    if (input.keep !== undefined) {
      const keep = Math.round(Number(input.keep));
      if (!(keep >= 1 && keep <= 365)) throw new BadRequestException('Nombre de sauvegardes gardées : entre 1 et 365');
      await this.setSetting('backup_keep', String(keep));
    }
  }

  async list(): Promise<BackupFile[]> {
    const dir = await this.dir();
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
      writeFileSync(join(dir, name), await this.pg.dump());
      // On garde les plus récentes.
      const keep = await this.keep();
      const all = await this.list();
      for (const old of all.slice(keep)) rmSync(join(dir, old.name), { force: true });
      this.lastError = null;
      return all.find((b) => b.name === name) ?? { name, size: 0, at: d.toISOString() };
    });
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
    });
  }

  /** Sauvegarde du jour si la dernière a plus de 24 heures. */
  async tick(): Promise<void> {
    if (!this.available) return;
    const last = (await this.list()).find((b) => !b.name.includes('avant-restauration'));
    if (last && Date.now() - Date.parse(last.at) < DAY_MS) return;
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
    this.timer = setInterval(run, 3_600_000);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
