import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { CONFIG, type ServerConfig } from './config';
import { type Db, PG } from './database';

/** Sauvegardes gardées pour chaque PC : les plus anciennes au-delà sont effacées. */
const KEEP = 10;
/** Taille maximale d'une sauvegarde envoyée par un PC (fichier chiffré). */
export const MAX_STATION_BACKUP = 200 * 1024 * 1024;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Nom montré à l'utilisateur : sans dossier ni caractère gênant. */
export function safeBackupName(raw: unknown): string {
  const base = String(raw ?? '')
    .split(/[\\/]/)
    .pop()!
    .replace(/[^\w.\- ()]/g, '_')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 120);
  return base || 'sauvegarde.fbk';
}

/** Morceau de chemin sûr pour un identifiant (magasin, poste). */
const segment = (v: string) => v.replace(/[^\w-]/g, '_').slice(0, 80) || '_';

interface Row {
  id: string;
  store_id: string;
  device_id: string;
  name: string;
  size: number;
  file: string;
  created_at: Date;
}

/**
 * Sauvegarde en ligne des PC : le PC envoie une copie de sa base déjà chiffrée
 * (AES-256-GCM, la clé reste au magasin). Le serveur range le fichier tel quel
 * dans `station-backups/<magasin>/<poste>/`, vérifie son empreinte SHA-256 et
 * garde les 10 plus récentes de chaque PC. Un PC du même magasin peut la
 * récupérer pour remonter un poste.
 */
@Injectable()
export class StationBackupService {
  constructor(
    @Inject(PG) private readonly pg: Db,
    @Inject(CONFIG) private readonly config: ServerConfig,
  ) {}

  /** Dossier des sauvegardes des PC : à côté de la base intégrée, sinon avec les sauvegardes du serveur. */
  root(): string {
    if (this.config.dataDir) return resolve(dirname(this.config.dataDir), 'station-backups');
    if (this.config.backupDir) return resolve(this.config.backupDir, 'station-backups');
    return resolve(process.cwd(), 'station-backups');
  }

  /** Chemin d'un fichier, toujours à l'intérieur du dossier des sauvegardes. */
  private path(file: string): string {
    const root = this.root();
    const full = resolve(root, file);
    if (!full.startsWith(root + sep)) throw new BadRequestException('Chemin de sauvegarde invalide');
    return full;
  }

  async upload(device: { id: string; store_id: string }, input: unknown): Promise<{ id: string; at: string }> {
    const body = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
    const name = safeBackupName(body['name']);
    const sha256 = String(body['sha256'] ?? '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(sha256)) throw new BadRequestException('Empreinte SHA-256 de la sauvegarde invalide');
    if (typeof body['data'] !== 'string' || !body['data']) throw new BadRequestException('Sauvegarde vide');
    const data = Buffer.from(body['data'], 'base64');
    if (!data.length) throw new BadRequestException('Sauvegarde vide');
    if (data.length > MAX_STATION_BACKUP) throw new BadRequestException('Sauvegarde trop lourde (200 Mo au plus)');
    if (body['size'] !== undefined && Number(body['size']) !== data.length) throw new BadRequestException('Sauvegarde incomplète : la taille reçue ne correspond pas. Renvoyez-la.');
    if (createHash('sha256').update(data).digest('hex') !== sha256) throw new BadRequestException('Sauvegarde abîmée pendant l’envoi (empreinte différente). Renvoyez-la.');

    const id = randomUUID();
    const file = join(segment(device.store_id), segment(device.id), `${id}.fbk`);
    const full = this.path(file);
    mkdirSync(dirname(full), { recursive: true });
    // Écrit à côté puis renommé : un envoi coupé ne laisse pas de fichier à moitié écrit.
    writeFileSync(`${full}.part`, data);
    renameSync(`${full}.part`, full);
    const { rows } = await this.pg.query<{ created_at: Date }>(
      'INSERT INTO station_backups (id, store_id, device_id, name, size, sha256, file) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING created_at',
      [id, device.store_id, device.id, name, data.length, sha256, file],
    );
    // Les plus récentes de ce PC sont gardées.
    const { rows: old } = await this.pg.query<{ id: string; file: string }>(
      'SELECT id, file FROM station_backups WHERE device_id = $1 ORDER BY created_at DESC, id OFFSET $2',
      [device.id, KEEP],
    );
    for (const o of old) {
      rmSync(this.path(o.file), { force: true });
      await this.pg.query('DELETE FROM station_backups WHERE id = $1', [o.id]);
    }
    return { id, at: new Date(rows[0]!.created_at).toISOString() };
  }

  /** Sauvegardes des PC du magasin, de la plus récente à la plus ancienne. */
  async list(storeId: string) {
    const { rows } = await this.pg.query<Row & { device_name: string | null }>(
      `SELECT b.id, b.name, b.size, b.created_at, d.name AS device_name FROM station_backups b
       LEFT JOIN devices d ON d.id = b.device_id WHERE b.store_id = $1 ORDER BY b.created_at DESC LIMIT 200`,
      [storeId],
    );
    return { backups: rows.map((r) => ({ id: r.id, name: r.name, size: Number(r.size), at: new Date(r.created_at).toISOString(), device: r.device_name ?? null })) };
  }

  /** Fichier d'une sauvegarde du même magasin (toujours chiffré). */
  async download(storeId: string, id: string): Promise<{ name: string; data: string }> {
    if (!UUID.test(id)) throw new NotFoundException('Sauvegarde introuvable');
    const { rows } = await this.pg.query<Row>('SELECT id, store_id, name, file FROM station_backups WHERE id = $1 AND store_id = $2', [id, storeId]);
    const r = rows[0];
    if (!r) throw new NotFoundException('Sauvegarde introuvable');
    try {
      return { name: r.name, data: readFileSync(this.path(r.file)).toString('base64') };
    } catch {
      throw new NotFoundException('Le fichier de cette sauvegarde n’est plus sur le serveur');
    }
  }
}
