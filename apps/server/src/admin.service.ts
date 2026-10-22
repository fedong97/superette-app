import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { BadRequestException, Inject, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { BackupService } from './backup.service';
import { CONFIG, type ServerConfig } from './config';
import { type Db, PG } from './database';
import { ENTITY_GROUPS, ENTITY_LABELS, summarize } from './labels';
import { SyncService } from './sync.service';

const SESSION_MS = 12 * 3_600_000;
/** « Rester connecté » sur le téléphone du gérant : 30 jours. */
export const LONG_SESSION_MS = 30 * 24 * 3_600_000;
/** Un poste qui s'est synchronisé dans la dernière minute est « en ligne » (il le fait toutes les 20 secondes). */
const ONLINE_MS = 60_000;

const hashPassword = (password: string, salt = randomBytes(16).toString('hex')) => `${salt}:${scryptSync(password, salt, 32).toString('hex')}`;

/** Début de la journée, à l'heure du PC du serveur. */
function startOfDay(daysAgo = 0): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - daysAgo);
  return d;
}

const localDay = (iso: string) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** Interface du serveur : état, postes, journal des opérations, ventes, sauvegardes et réglages. */
@Injectable()
export class AdminService {
  private readonly sessions = new Map<string, number>();
  private readonly startedAt = new Date();

  constructor(
    @Inject(PG) private readonly pg: Db,
    @Inject(CONFIG) private readonly config: ServerConfig,
    @Inject(SyncService) private readonly sync: SyncService,
    @Inject(BackupService) private readonly backups: BackupService,
  ) {}

  // ——— Accès ———

  private async passwordHash(): Promise<string | null> {
    const { rows } = await this.pg.query<{ value: string }>("SELECT value FROM settings WHERE key = 'admin_password'");
    if (rows[0]) return rows[0].value;
    // Serveur sur Internet : le premier mot de passe vient de la configuration (ADMIN_PASSWORD).
    if (this.config.adminPassword) {
      await this.setPassword(this.config.adminPassword);
      return this.passwordHash();
    }
    return null;
  }

  async hasPassword(): Promise<boolean> {
    return (await this.passwordHash()) !== null;
  }

  private newSession(ms = SESSION_MS): string {
    const token = randomBytes(24).toString('base64url');
    this.sessions.set(token, Date.now() + ms);
    return token;
  }

  isSession(token: string | undefined): boolean {
    if (!token) return false;
    const until = this.sessions.get(token);
    if (!until || until < Date.now()) {
      this.sessions.delete(token);
      return false;
    }
    return true;
  }

  logout(token: string | undefined) {
    if (token) this.sessions.delete(token);
  }

  /** La fenêtre d’ONIX 360 Serveur s'ouvre avec son jeton : pas de mot de passe à taper sur le PC du serveur. */
  localLogin(token: string): string | null {
    const expected = this.config.localAdminToken;
    if (!expected || token.length !== expected.length || !timingSafeEqual(Buffer.from(token), Buffer.from(expected))) return null;
    return this.newSession();
  }

  async login(password: string, remember = false): Promise<string> {
    const stored = await this.passwordHash();
    if (!stored) throw new UnauthorizedException("Aucun mot de passe n'est encore choisi : ouvrez ONIX 360 Serveur sur le PC du serveur.");
    const [salt] = stored.split(':');
    const given = Buffer.from(hashPassword(String(password ?? ''), salt));
    if (given.length !== stored.length || !timingSafeEqual(given, Buffer.from(stored))) throw new UnauthorizedException('Mot de passe incorrect');
    return this.newSession(remember ? LONG_SESSION_MS : SESSION_MS);
  }

  /**
   * Premier mot de passe, choisi sur le PC du serveur lui-même (base intégrée). Derrière un proxy,
   * toutes les requêtes semblent venir du PC : un serveur PostgreSQL prend son mot de passe dans ADMIN_PASSWORD.
   */
  canChooseFirstPassword(local: boolean): boolean {
    return local && this.pg.kind === 'integree';
  }

  async firstPassword(password: string, local: boolean): Promise<string> {
    if (await this.hasPassword()) throw new BadRequestException('Un mot de passe existe déjà');
    if (!this.canChooseFirstPassword(local)) throw new UnauthorizedException('Le premier mot de passe se choisit sur le PC du serveur.');
    await this.setPassword(password);
    return this.newSession();
  }

  async setPassword(password: string) {
    if (String(password ?? '').length < 6) throw new BadRequestException('Le mot de passe doit faire au moins 6 caractères');
    await this.pg.query(
      "INSERT INTO settings (key, value) VALUES ('admin_password', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
      [hashPassword(password)],
    );
  }

  // ——— Lecture ———

  /** Nom le plus récent de chaque magasin, caisse et utilisateur. */
  private async names(): Promise<Map<string, string>> {
    const { rows } = await this.pg.query<{ entity_id: string; name: string | null }>(
      `SELECT DISTINCT ON (entity, entity_id) entity_id, payload->>'name' AS name FROM events
       WHERE entity IN ('store', 'register', 'user') AND payload IS NOT NULL
       ORDER BY entity, entity_id, seq DESC`,
    );
    return new Map(rows.map((r) => [r.entity_id, r.name ?? '']));
  }

  /** Ventes (dernier état de chaque ticket) depuis une date. */
  private async salesSince(from: Date) {
    const { rows } = await this.pg.query<{ store_id: string | null; payload: Record<string, unknown> }>(
      `SELECT DISTINCT ON (entity_id) store_id, payload FROM events
       WHERE entity = 'sale' AND payload IS NOT NULL AND payload->>'created_at' >= $1
       ORDER BY entity_id, seq DESC`,
      [from.toISOString()],
    );
    return rows.filter((r) => r.payload['status'] !== 'cancelled');
  }

  addresses(): string[] {
    const list: string[] = [];
    for (const nets of Object.values(networkInterfaces())) {
      for (const n of nets ?? []) if (n.family === 'IPv4' && !n.internal) list.push(`http://${n.address}:${this.config.port}`);
    }
    return list;
  }

  async overview() {
    const names = await this.names();
    const { rows: devices } = await this.pg.query<{
      id: string;
      name: string;
      store_id: string;
      register_id: string;
      created_at: Date;
      last_seen_at: Date | null;
      revoked_at: Date | null;
      app_version: string | null;
      kind: string;
    }>('SELECT id, name, store_id, register_id, created_at, last_seen_at, revoked_at, app_version, kind FROM devices ORDER BY revoked_at NULLS FIRST, created_at');
    const { rows: counts } = await this.pg.query<{ total: number; today: number; first: Date | null }>(
      'SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE received_at >= $1)::int AS today, MIN(received_at) AS first FROM events',
      [startOfDay()],
    );
    const { rows: lic } = await this.pg.query<{ client: string; stations: number }>('SELECT client, stations FROM licenses ORDER BY issued DESC LIMIT 1');

    const today = await this.salesSince(startOfDay());
    const stores = new Map<string, { storeId: string; name: string; sales: number; total: number; returns: number; lastSale: string | null }>();
    for (const [id, name] of names) if (devices.some((d) => d.store_id === id && d.kind === 'pc')) stores.set(id, { storeId: id, name, sales: 0, total: 0, returns: 0, lastSale: null });
    for (const s of today) {
      const id = s.store_id ?? '';
      const st = stores.get(id) ?? { storeId: id, name: names.get(id) ?? '—', sales: 0, total: 0, returns: 0, lastSale: null };
      const total = Number(s.payload['total_ttc'] ?? 0);
      if (s.payload['kind'] === 'return') st.returns += Math.abs(total);
      else {
        st.sales++;
        st.total += total;
      }
      const at = String(s.payload['created_at']);
      if (!st.lastSale || at > st.lastSale) st.lastSale = at;
      stores.set(id, st);
    }

    const backups = this.backups.available ? await this.backups.list() : [];
    const now = Date.now();
    return {
      version: this.config.version ?? null,
      startedAt: this.startedAt.toISOString(),
      database: this.pg.kind,
      port: this.config.port,
      addresses: this.addresses(),
      enrollmentKey: await this.sync.enrollmentKey(),
      enrollmentKeyFixed: Boolean(this.config.enrollmentKey),
      events: counts[0] ?? { total: 0, today: 0, first: null },
      license: lic[0] ?? null,
      devices: devices.map((d) => ({
        id: d.id,
        name: d.name,
        store: names.get(d.store_id) ?? '—',
        register: d.kind === 'mobile' ? 'Téléphone d’inventaire' : (names.get(d.register_id) ?? '—'),
        kind: d.kind,
        createdAt: d.created_at,
        lastSeenAt: d.last_seen_at,
        online: !d.revoked_at && d.last_seen_at !== null && now - new Date(d.last_seen_at).getTime() < ONLINE_MS,
        revoked: d.revoked_at !== null,
        appVersion: d.app_version,
      })),
      stores: [...stores.values()],
      backups: {
        available: this.backups.available,
        last: backups[0] ?? null,
        count: backups.length,
        dir: this.backups.available ? await this.backups.dir() : null,
        keep: await this.backups.keep(),
        error: this.backups.lastError,
      },
    };
  }

  groups() {
    return ENTITY_GROUPS;
  }

  async events(input: { group?: string; store?: string; before?: number; limit?: number }) {
    const limit = Math.min(Math.max(Number(input.limit) || 100, 1), 500);
    const where: string[] = [];
    const params: unknown[] = [];
    if (input.group) {
      const g = ENTITY_GROUPS.find((x) => x.key === input.group);
      if (!g) throw new BadRequestException('Famille inconnue');
      params.push(g.entities);
      where.push(`e.entity = ANY($${params.length})`);
    } else {
      // Le stock par dépôt change à chaque vente : il noierait le journal.
      where.push("e.entity <> 'stock_level'");
    }
    if (input.store) {
      params.push(input.store);
      where.push(`e.store_id = $${params.length}`);
    }
    if (input.before) {
      params.push(Number(input.before));
      where.push(`e.seq < $${params.length}`);
    }
    params.push(limit);
    const { rows } = await this.pg.query<{
      seq: string | number;
      entity: string;
      op: string;
      store_id: string | null;
      payload: Record<string, unknown> | null;
      created_at: Date;
      received_at: Date;
      device: string;
    }>(
      `SELECT e.seq, e.entity, e.op, e.store_id, e.payload, e.created_at, e.received_at, d.name AS device
       FROM events e JOIN devices d ON d.id = e.device_id
       WHERE ${where.join(' AND ')} ORDER BY e.seq DESC LIMIT $${params.length}`,
      params,
    );
    const names = await this.names();
    return rows.map((r) => ({
      seq: Number(r.seq),
      at: r.created_at,
      receivedAt: r.received_at,
      type: ENTITY_LABELS[r.entity] ?? r.entity,
      action: r.op === 'delete' ? 'Suppression' : 'Enregistrement',
      summary: summarize(r.entity, r.op, r.payload),
      device: r.device,
      store: r.store_id ? (names.get(r.store_id) ?? '—') : 'Tous les magasins',
    }));
  }

  /** Ventes des 14 derniers jours, par jour et par magasin. */
  async salesByDay() {
    const names = await this.names();
    const sales = await this.salesSince(startOfDay(13));
    const days = new Map<string, Map<string, { sales: number; total: number }>>();
    for (const s of sales) {
      if (s.payload['kind'] === 'return') continue;
      const day = localDay(String(s.payload['created_at']));
      const store = names.get(s.store_id ?? '') ?? '—';
      const byStore = days.get(day) ?? new Map();
      const cur = byStore.get(store) ?? { sales: 0, total: 0 };
      cur.sales++;
      cur.total += Number(s.payload['total_ttc'] ?? 0);
      byStore.set(store, cur);
      days.set(day, byStore);
    }
    return [...days.entries()]
      .sort((a, b) => b[0].localeCompare(a[0]))
      .map(([day, byStore]) => ({ day, stores: [...byStore.entries()].map(([store, v]) => ({ store, ...v })) }));
  }

  // ——— Actions ———

  async revokeDevice(id: string) {
    const { rows } = await this.pg.query('UPDATE devices SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL RETURNING id', [id]);
    if (!rows[0]) throw new NotFoundException('Poste introuvable ou déjà délié');
  }

  async renewEnrollmentKey() {
    if (this.config.enrollmentKey) throw new BadRequestException('La clé est fixée par la configuration du serveur (ENROLLMENT_KEY)');
    return { enrollmentKey: await this.sync.renewEnrollmentKey() };
  }
}
