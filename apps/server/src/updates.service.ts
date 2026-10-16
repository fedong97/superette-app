import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Readable } from 'node:stream';
import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { CONFIG, type ServerConfig } from './config';

/** Installateur de FEDONIX 360 : « Fedonix360-Setup-0.49.0.exe » (le nom donne la version). */
const INSTALLER = /^[\w.-]+-(\d+\.\d+\.\d+)\.exe$/;
const MAX_BYTES = 600 * 1024 * 1024;
/** Installateurs gardés : la version publiée et la précédente (un PC peut être en train de la télécharger). */
const KEEP = 2;

export interface PublishedUpdate {
  version: string;
  file: string;
  size: number;
  at: string;
}

/**
 * Mises à jour des PC : l'administrateur dépose le nouvel installateur dans l'interface
 * du serveur, qui écrit lui-même le fichier `latest.yml` lu par la mise à jour
 * automatique des PC (empreinte SHA-512 et taille). Les PC le lisent à l'adresse
 * `/mises-a-jour/`, sans mot de passe : un installateur n'a rien de secret.
 */
@Injectable()
export class UpdatesService {
  private busy = false;

  constructor(@Inject(CONFIG) private readonly config: ServerConfig) {}

  dir(): string {
    return this.config.updatesDir ?? join(dirname(this.config.dataDir ?? '.'), 'mises-a-jour');
  }

  current(): PublishedUpdate | null {
    const yml = join(this.dir(), 'latest.yml');
    if (!existsSync(yml)) return null;
    const text = readFileSync(yml, 'utf8');
    const version = /^version:\s*(.+)$/m.exec(text)?.[1]?.trim();
    const file = /^path:\s*(.+)$/m.exec(text)?.[1]?.trim();
    if (!version || !file || !existsSync(join(this.dir(), file))) return null;
    const st = statSync(join(this.dir(), file));
    return { version, file, size: st.size, at: st.mtime.toISOString() };
  }

  /** Chemin d'un fichier servi aux PC : `latest.yml` ou un installateur présent. */
  file(name: string): string {
    if (name !== 'latest.yml' && !INSTALLER.test(name)) throw new NotFoundException();
    const path = join(this.dir(), name);
    if (!existsSync(path)) throw new NotFoundException();
    return path;
  }

  async publish(name: string, body: Readable): Promise<PublishedUpdate> {
    const match = INSTALLER.exec(name ?? '');
    if (!match) {
      body.resume();
      throw new BadRequestException('Choisissez l\'installateur de FEDONIX 360, par exemple Fedonix360-Setup-0.49.0.exe');
    }
    if (this.busy) {
      body.resume();
      throw new BadRequestException('Un installateur est déjà en cours d\'envoi');
    }
    this.busy = true;
    const dir = this.dir();
    const tmp = join(dir, `${name}.envoi`);
    try {
      mkdirSync(dir, { recursive: true });
      const hash = createHash('sha512');
      let size = 0;
      await new Promise<void>((resolve, reject) => {
        const out = createWriteStream(tmp);
        body.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_BYTES) {
            body.destroy();
            out.destroy();
            reject(new BadRequestException('Fichier trop gros pour un installateur'));
            return;
          }
          hash.update(chunk);
        });
        body.on('error', reject);
        out.on('error', reject);
        out.on('finish', resolve);
        body.pipe(out);
      });
      // Un exécutable Windows commence toujours par « MZ ».
      const head = readFileSync(tmp).subarray(0, 2).toString('latin1');
      if (size < 1024 * 1024 || head !== 'MZ') throw new BadRequestException('Ce fichier n\'est pas un installateur Windows');
      renameSync(tmp, join(dir, name));
      const sha512 = hash.digest('base64');
      const releaseDate = new Date().toISOString();
      writeFileSync(
        join(dir, 'latest.yml'),
        `version: ${match[1]}\nfiles:\n  - url: ${name}\n    sha512: ${sha512}\n    size: ${size}\npath: ${name}\nsha512: ${sha512}\nreleaseDate: '${releaseDate}'\n`,
      );
      this.prune(name);
      return { version: match[1]!, file: name, size, at: releaseDate };
    } finally {
      rmSync(tmp, { force: true });
      this.busy = false;
    }
  }

  /** Efface les vieux installateurs : on garde le publié et le précédent. */
  private prune(published: string) {
    const dir = this.dir();
    const others = readdirSync(dir)
      .filter((f) => INSTALLER.test(f) && f !== published)
      .map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const { f } of others.slice(KEEP - 1)) rmSync(join(dir, f), { force: true });
  }
}
