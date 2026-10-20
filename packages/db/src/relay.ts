import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { Db } from './database';
import type { SyncEvent, SyncService } from './sync';
import { AppError, Base, type Clock, newId } from './util';

/**
 * Remontée des postes distants :
 * un dépôt sans réseau ni serveur produit chaque jour un petit fichier de ses
 * opérations, que la boutique intègre ; la boutique lui renvoie de la même façon
 * le catalogue, les prix et les utilisateurs. Le fichier voyage par clé USB,
 * e-mail ou WhatsApp ; l'intégration passe par la synchronisation (la plus récente l'emporte).
 */
export const RELAY_EXTENSION = 'fedonix-journee';

export type RelayKind = 'remontee' | 'miseajour';

interface RelayFile {
  v: 1;
  id: string;
  kind: RelayKind;
  /** Magasin du poste distant (expéditeur d'une remontée, destinataire d'une mise à jour). */
  storeId: string;
  storeCode: string;
  storeName: string;
  at: string;
  byName: string | null;
  toSeq: number;
  events: SyncEvent[];
}

export interface RelayLogRow {
  id: string;
  kind: RelayKind;
  direction: 'out' | 'in';
  store_id: string;
  store_name: string | null;
  file: string;
  events: number;
  at: string;
  summary: string | null;
}

export interface RelayStatus {
  /** « distant » : ce PC est un poste distant ; sinon c'est la boutique. */
  role: 'distant' | 'boutique';
  /** Boutique : magasins dont un poste distant a été installé (date du dernier envoi et de la dernière remontée). */
  remotes: { store_id: string; code: string; name: string; last_out: string | null; last_in: string | null }[];
  /** Poste distant : opérations faites ici depuis la dernière remontée. */
  pending: number;
  log: RelayLogRow[];
}

const pad = (n: number) => String(n).padStart(2, '0');
const stamp = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
const slug = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'magasin';

export class RelayService extends Base {
  constructor(
    db: Db,
    clock: Clock,
    private readonly sync: SyncService,
  ) {
    super(db, clock);
  }

  private setting(key: string): string | null {
    return (this.db.prepare('SELECT value FROM settings WHERE key = ?').pluck().get(key) as string | undefined) ?? null;
  }

  private setSetting(key: string, value: string): void {
    this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  private stationStore(): { id: string; code: string; name: string } {
    const store = this.db.prepare("SELECT s.id, s.code, s.name FROM settings k JOIN stores s ON s.id = k.value WHERE k.key = 'station.storeId'").get() as
      | { id: string; code: string; name: string }
      | undefined;
    if (!store) throw new AppError("Ce poste n'est pas configuré", 'NO_STATION');
    return store;
  }

  isRemote(): boolean {
    return this.setting('relay.role') === 'distant';
  }

  status(): RelayStatus {
    const log = this.db
      .prepare('SELECT l.id, l.kind, l.direction, l.store_id, s.name AS store_name, l.file, l.events, l.at, l.summary FROM relay_log l LEFT JOIN stores s ON s.id = l.store_id ORDER BY l.at DESC LIMIT 50')
      .all() as RelayLogRow[];
    if (this.isRemote()) {
      const since = Number(this.setting('relay.lastSeq') ?? 0);
      const pending = this.db.prepare("SELECT COUNT(DISTINCT entity || entity_id) FROM outbox WHERE seq > ? AND entity <> 'stock_level'").pluck().get(since) as number;
      return { role: 'distant', remotes: [], pending, log };
    }
    const keys = this.db.prepare("SELECT key FROM settings WHERE key LIKE 'relay.out.%'").pluck().all() as string[];
    const remotes = keys
      .map((k) => k.slice('relay.out.'.length))
      .map((id) => this.db.prepare('SELECT id, code, name FROM stores WHERE id = ?').get(id) as { id: string; code: string; name: string } | undefined)
      .filter((s): s is { id: string; code: string; name: string } => Boolean(s))
      .map((s) => ({
        store_id: s.id,
        code: s.code,
        name: s.name,
        last_out: this.db.prepare("SELECT MAX(at) FROM relay_log WHERE store_id = ? AND direction = 'out'").pluck().get(s.id) as string | null,
        last_in: this.db.prepare("SELECT MAX(at) FROM relay_log WHERE store_id = ? AND direction = 'in'").pluck().get(s.id) as string | null,
      }));
    return { role: 'boutique', remotes, pending: 0, log };
  }

  private write(dir: string, data: RelayFile, userId: string | null): { file: string; events: number } {
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${slug(data.storeName)}-${data.kind}-${stamp(this.clock())}.${RELAY_EXTENSION}`);
    const tmp = `${file}.part`;
    try {
      writeFileSync(tmp, gzipSync(JSON.stringify(data), { level: 9 }));
      renameSync(tmp, file);
    } catch (e) {
      rmSync(tmp, { force: true });
      throw new AppError(`Fichier impossible dans ${dir} : ${e instanceof Error ? e.message : String(e)}`, 'RELAY_FAILED');
    }
    this.db
      .prepare('INSERT INTO relay_log (id, kind, direction, store_id, file, events, at, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(data.id, data.kind, 'out', data.storeId, file, data.events.length, data.at, userId);
    this.audit(userId, `relay.${data.kind}`, 'store', data.storeId, { file, events: data.events.length });
    return { file, events: data.events.length };
  }

  /**
   * Poste distant : fichier des opérations faites ici depuis la dernière remontée
   * (ventes, journées de caisse, réceptions…). Refaire une remontée ne perd rien :
   * la suivante repart de là où celle-ci s'arrête.
   */
  exportRemontee(user: { id: string; name: string } | null, dir: string): { file: string; events: number } {
    if (!this.isRemote()) throw new AppError("Ce PC n'est pas un poste distant : il se synchronise par le serveur ou par les fiches", 'INVALID');
    const store = this.stationStore();
    const toSeq = this.sync.lastSeq();
    const events = this.sync.eventsSince(Number(this.setting('relay.lastSeq') ?? 0));
    const out = this.write(dir, { v: 1, id: newId(), kind: 'remontee', storeId: store.id, storeCode: store.code, storeName: store.name, at: this.now(), byName: user?.name ?? null, toSeq, events }, user?.id ?? null);
    this.setSetting('relay.lastSeq', String(toSeq));
    return out;
  }

  /**
   * Boutique : mise à jour pour un poste distant, avec ce qui a changé ici depuis le
   * dernier envoi (catalogue, prix, utilisateurs, réglages et ce qui concerne son magasin).
   * Les ventes et la caisse des autres magasins ne partent pas.
   */
  exportUpdate(user: { id: string; name: string } | null, storeId: string, dir: string): { file: string; events: number } {
    if (this.isRemote()) throw new AppError('Un poste distant envoie des remontées, pas des mises à jour', 'INVALID');
    const store = this.db.prepare('SELECT id, code, name FROM stores WHERE id = ?').get(storeId) as { id: string; code: string; name: string } | undefined;
    const since = this.setting(`relay.out.${storeId}`);
    if (!store || since === null) throw new AppError("Ce magasin n'a pas de poste distant installé depuis ce PC", 'INVALID');
    const toSeq = this.sync.lastSeq();
    const events = this.sync.eventsSince(Number(since)).filter((e) => e.storeId === null || e.storeId === storeId);
    const out = this.write(dir, { v: 1, id: newId(), kind: 'miseajour', storeId, storeCode: store.code, storeName: store.name, at: this.now(), byName: user?.name ?? null, toSeq, events }, user?.id ?? null);
    this.setSetting(`relay.out.${storeId}`, String(toSeq));
    return out;
  }

  /** Lit un fichier de journée sans l'intégrer. */
  read(file: string): Omit<RelayFile, 'events'> & { events: number; integrated_at: string | null } {
    const data = this.parse(file);
    const done = this.db.prepare("SELECT at FROM relay_log WHERE id = ? AND direction = 'in'").pluck().get(data.id) as string | undefined;
    const { events, ...rest } = data;
    return { ...rest, events: events.length, integrated_at: done ?? null };
  }

  private parse(file: string): RelayFile {
    let data: RelayFile;
    try {
      data = JSON.parse(gunzipSync(readFileSync(file)).toString('utf8')) as RelayFile;
    } catch {
      throw new AppError("Ce fichier n'est pas une remontée ni une mise à jour FEDONIX 360 (ou il est incomplet)", 'INVALID');
    }
    if (data?.v !== 1 || !Array.isArray(data.events) || !['remontee', 'miseajour'].includes(data.kind)) throw new AppError('Fichier de journée inconnu', 'INVALID');
    return data;
  }

  /**
   * Intègre une remontée (dans la boutique) ou une mise à jour (sur le poste distant).
   * Une remontée repart ensuite vers le serveur central et les autres PC de la boutique.
   */
  integrate(userId: string, file: string): { kind: RelayKind; storeName: string; events: number; applied: number; conflicts: number } {
    const data = this.parse(file);
    const remote = this.isRemote();
    if (data.kind === 'remontee' && remote) throw new AppError('Une remontée s’intègre dans la boutique, pas sur un poste distant', 'INVALID');
    if (data.kind === 'miseajour' && !remote) throw new AppError('Une mise à jour s’intègre sur le poste distant', 'INVALID');
    if (data.kind === 'miseajour' && data.storeId !== this.stationStore().id) throw new AppError(`Cette mise à jour est pour ${data.storeName}`, 'INVALID');
    if (data.kind === 'remontee' && !this.db.prepare('SELECT 1 FROM stores WHERE id = ?').get(data.storeId)) throw new AppError(`Cette remontée vient d'une autre société (${data.storeName})`, 'INVALID');
    const done = this.db.prepare("SELECT at FROM relay_log WHERE id = ? AND direction = 'in'").pluck().get(data.id) as string | undefined;
    if (done) throw new AppError(`Ce fichier a déjà été intégré le ${new Date(done).toLocaleString('fr-FR')}`, 'ALREADY_DONE');
    const { applied, conflicts } = data.kind === 'remontee' ? this.sync.adopt(data.events) : this.sync.applyRemote(data.events);
    const summary = { applied, conflicts, from: data.at, by: data.byName };
    this.db
      .prepare('INSERT INTO relay_log (id, kind, direction, store_id, file, events, at, user_id, summary) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(data.id, data.kind, 'in', data.storeId, file, data.events.length, this.now(), userId, JSON.stringify(summary));
    this.audit(userId, `relay.integrate.${data.kind}`, 'store', data.storeId, { file, ...summary });
    return { kind: data.kind, storeName: data.storeName, events: data.events.length, applied, conflicts };
  }
}
