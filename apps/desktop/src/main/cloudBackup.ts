import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { AppError, type Services, downloadStationBackup, stationBackups, uploadStationBackup } from '@superette/db';

/** En-tête d'une sauvegarde chiffrée : « FEDOBK1 », sel (16), IV (12), étiquette GCM (16), puis les données. */
const MAGIC = Buffer.from('FEDOBK1');
const SALT = 16;
const IV = 12;
const TAG = 16;
/** Une copie en ligne par jour suffit : les sauvegardes de la journée restent sur le PC. */
const MIN_INTERVAL_MS = 20 * 3_600_000;

const derive = (passphrase: string, salt: Buffer) => scryptSync(passphrase, salt, 32, { N: 16_384, r: 8, p: 1 });

export function encryptBackup(data: Buffer, key: Buffer, salt: Buffer): Buffer {
  const iv = randomBytes(IV);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(gzipSync(data)), cipher.final()]);
  return Buffer.concat([MAGIC, salt, iv, cipher.getAuthTag(), body]);
}

export function decryptBackup(blob: Buffer, passphrase: string): Buffer {
  if (blob.length < MAGIC.length + SALT + IV + TAG || !blob.subarray(0, MAGIC.length).equals(MAGIC)) throw new AppError("Ce fichier n'est pas une sauvegarde en ligne", 'INVALID');
  let at = MAGIC.length;
  const salt = blob.subarray(at, (at += SALT));
  const iv = blob.subarray(at, (at += IV));
  const tag = blob.subarray(at, (at += TAG));
  const decipher = createDecipheriv('aes-256-gcm', derive(passphrase, salt), iv);
  decipher.setAuthTag(tag);
  try {
    return gunzipSync(Buffer.concat([decipher.update(blob.subarray(at)), decipher.final()]));
  } catch {
    throw new AppError('Phrase secrète incorrecte (ou fichier abîmé)', 'BAD_PASSPHRASE');
  }
}

/**
 * Sauvegarde en ligne : la sauvegarde du jour, compressée et chiffrée sur ce PC
 * (AES-256-GCM, clé tirée de la phrase secrète du magasin), part sur le serveur.
 * Le serveur ne garde que des fichiers illisibles ; sans la phrase secrète,
 * personne ne peut les relire, l'éditeur non plus.
 */
export function createCloudBackup(s: Services) {
  const get = (k: string) => s.admin.getSetting(k);
  const set = (k: string, v: string | null) => (v === null ? s.db.prepare('DELETE FROM settings WHERE key = ?').run(k) : s.admin.setSetting(k, v));
  const storeId = () => s.admin.station()?.store.id ?? null;
  const enabled = () => {
    const id = storeId();
    return id ? s.admin.storeSettings(id).cloudBackup : false;
  };
  const key = () => {
    const k = get('cloud.key');
    const salt = get('cloud.salt');
    return k && salt ? { key: Buffer.from(k, 'base64'), salt: Buffer.from(salt, 'base64') } : null;
  };

  const upload = async (file: string, name: string) => {
    const k = key();
    if (!k) throw new AppError('Choisissez d’abord la phrase secrète de la sauvegarde en ligne', 'NO_KEY');
    const blob = encryptBackup(readFileSync(file), k.key, k.salt);
    const sha256 = createHash('sha256').update(blob).digest('hex');
    try {
      const r = await uploadStationBackup(s, { name: `${name}.enc`, data: blob, sha256 });
      set('cloud.lastAt', r.at);
      set('cloud.lastFile', name);
      set('cloud.lastError', null);
      return { name, at: r.at };
    } catch (e) {
      set('cloud.lastError', e instanceof Error ? e.message : String(e));
      set('cloud.lastTry', new Date().toISOString());
      throw e;
    }
  };

  return {
    status() {
      const lastAt = get('cloud.lastAt');
      const error = get('cloud.lastError');
      const lastTry = get('cloud.lastTry');
      const last = error && lastTry && (!lastAt || lastTry > lastAt) ? { at: lastTry, ok: false, error } : lastAt ? { at: lastAt, ok: true, error: null } : null;
      return { enabled: enabled(), linked: Boolean(s.sync.credentials()), hasKey: Boolean(key()), last };
    },

    /** Phrase secrète du magasin : la même sur tous ses PC pour relire leurs sauvegardes. */
    setKey(passphrase: string) {
      if ((passphrase ?? '').length < 8) throw new AppError('La phrase secrète doit faire au moins 8 caractères', 'INVALID');
      const salt = randomBytes(SALT);
      set('cloud.salt', salt.toString('base64'));
      set('cloud.key', derive(passphrase, salt).toString('base64'));
      // Contrôle sans garder la phrase : on peut vérifier qu'une phrase retapée est la même.
      set('cloud.check', createHash('sha256').update(derive(passphrase, salt)).digest('hex'));
    },

    /** Vérifie une phrase secrète retapée (sans la garder). */
    checkKey(passphrase: string): boolean {
      const k = key();
      const check = get('cloud.check');
      if (!k || !check) return false;
      const h = createHash('sha256').update(derive(passphrase, k.salt)).digest();
      return timingSafeEqual(h, Buffer.from(check, 'hex'));
    },

    /** Envoie tout de suite la dernière sauvegarde (ou en fait une). */
    async now(userId: string | null) {
      if (!s.sync.credentials()) throw new AppError("Ce PC n'est pas relié au serveur", 'SYNC_NOT_CONFIGURED');
      const info = await s.backups.saveNow(userId);
      return upload(info.file, info.name);
    },

    /** Après la sauvegarde automatique : une copie en ligne par jour, si elle est activée. */
    async maybeUpload() {
      if (!enabled() || !key() || !s.sync.credentials()) return null;
      const last = get('cloud.lastAt');
      const lastTry = get('cloud.lastTry');
      const now = Date.now();
      if (last && now - Date.parse(last) < MIN_INTERVAL_MS) return null;
      // Après un échec (pas d'internet), on réessaie une heure plus tard.
      if (lastTry && (!last || lastTry > last) && now - Date.parse(lastTry) < 3_600_000) return null;
      const st = s.backups.status();
      if (!st.last_file) return null;
      const name = st.last_file.split(/[\\/]/).pop()!;
      return upload(st.last_file, name).catch(() => null);
    },

    list: () => stationBackups(s),

    /** Télécharge et déchiffre une sauvegarde en ligne dans le dossier des sauvegardes : elle se restaure ensuite comme les autres. */
    async download(id: string, passphrase: string) {
      const dir = s.backups.status().dir;
      if (!dir) throw new AppError('Choisissez le dossier des sauvegardes', 'INVALID');
      const file = await downloadStationBackup(s, id);
      const data = decryptBackup(file.data, passphrase);
      const name = file.name.replace(/\.enc$/, '').replace(/[^\w.-]/g, '_');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, name), data);
      return { name };
    },
  };
}

export type CloudBackup = ReturnType<typeof createCloudBackup>;
