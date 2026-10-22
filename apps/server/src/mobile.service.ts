import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { BadRequestException, ForbiddenException, HttpException, HttpStatus, Inject, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { type Db, PG } from './database';

type Json = Record<string, unknown>;

/** Le QR affiché au gérant reste valable 15 minutes. */
const PAIRING_MS = 15 * 60_000;
/** Cinq codes faux de suite sur un téléphone : il attend 15 minutes. */
const MAX_FAILURES = 5;
const LOCK_MS = 15 * 60_000;
/** Un téléphone vu depuis moins de 2 minutes est « en ligne ». */
const ONLINE_MS = 2 * 60_000;
/** Écart qui fait recompter un produit par un autre compteur : 2 unités et 10 % du stock attendu. */
const RECOUNT_MIN = 2_000;
const RECOUNT_RATIO = 0.1;
/** Photo d'un code inconnu : 600 ko au plus (le téléphone la réduit avant l'envoi). */
const MAX_PHOTO = 600_000;
/** Vignette d'un article envoyée au téléphone : les plus lourdes sont laissées de côté. */
const MAX_THUMB = 30_000;
/** Durée maximale d'un accès d'aide. */
const GUEST_MS = 24 * 3_600_000;
/** Codes d'aide faux tolérés sur tout le serveur avant une pause (6 chiffres : on ne les devine pas). */
const GUEST_MAX_FAILURES = 20;
export const GUEST_PREFIX = 'guest:';

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
const str = (v: unknown) => (v === null || v === undefined ? '' : String(v));
const json = <T>(v: unknown, fallback: T): T => {
  if (typeof v !== 'string') return (v as T) ?? fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
};

/** Même calcul que les PC (scrypt) : le code saisi sur le téléphone est vérifié ici. */
export function verifyPin(pin: string, stored: string): boolean {
  const [scheme, saltHex, hashHex] = stored.split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex || !/^\d{4,8}$/.test(pin)) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = scryptSync(pin, Buffer.from(saltHex, 'hex'), expected.length);
  return timingSafeEqual(actual, expected);
}

export interface MobileDevice {
  id: string;
  name: string;
  store_id: string;
}

export interface MobileCaller {
  device: MobileDevice;
  user: { id: string; name: string; role: string };
  /** Aide sans compte : un seul inventaire, comptages signés sur les PC au nom de `onBehalfOf`. */
  guest?: { id: string; inventoryId: string; onBehalfOf: string };
}

interface GuestRow {
  id: string;
  store_id: string;
  inventory_id: string;
  name: string;
  code: string;
  on_behalf_of: string;
  created_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
}

export interface MobileCountInput {
  id: string;
  inventoryId: string;
  articleId: string;
  location?: string;
  /** Quantité comptée à cet endroit, en millièmes de l'unité de stock ; null efface le comptage de l'endroit. */
  qty: number | null;
  /** Détail par conditionnement (cartons, paquets, unités), comme sur le PC. */
  detail?: number[] | null;
  countedAt: string;
}

interface Line extends Json {
  id: string;
  article_id: string;
  counted: number | null;
  counted_at: string | null;
  counted_by: string | null;
}

interface OpenInventory {
  id: string;
  storeId: string;
  number: string;
  label: string | null;
  kind: string;
  warehouseId: string;
  inventoryDate: string;
  openedAt: string;
  departmentIds: string[];
}

/**
 * Inventaire sur téléphone (ONIX 360 Inventaire, application Android).
 * Le téléphone est relié au magasin par un QR code que le gérant affiche,
 * le compteur s'y connecte avec son identifiant et son code, télécharge le
 * catalogue et les inventaires ouverts, compte (hors ligne au besoin) puis
 * envoie ses quantités par endroit. Le serveur en fait des saisies
 * d'inventaire ordinaires (`inventory_line`, `inventory_entry`) que les PC
 * reçoivent par la synchronisation : la clôture reste sur le PC.
 */
@Injectable()
export class MobileService {
  private readonly failures = new Map<string, { count: number; until: number }>();
  private guestFailures = { count: 0, until: 0 };

  constructor(@Inject(PG) private readonly pg: Db) {}

  // ——— Lecture du journal ———

  /** Dernier état de chaque fiche d'une entité (les fiches supprimées sont écartées). */
  private async latest(entity: string, extra = '', params: unknown[] = [], select = 'payload'): Promise<{ entity_id: string; seq: string; payload: Json }[]> {
    const { rows } = await this.pg.query<{ entity_id: string; seq: string; op: string; payload: Json | null }>(
      `SELECT DISTINCT ON (entity_id) entity_id, seq, op, ${select} AS payload FROM events
       WHERE entity = $1 ${extra} ORDER BY entity_id, seq DESC`,
      [entity, ...params],
    );
    return rows.filter((r) => r.op !== 'delete' && r.payload).map((r) => ({ entity_id: r.entity_id, seq: r.seq, payload: r.payload! }));
  }

  private async one(entity: string, id: string): Promise<Json | null> {
    return (await this.latest(entity, 'AND entity_id = $2', [id]))[0]?.payload ?? null;
  }

  private async setting(key: string, fallback: string): Promise<string> {
    const { rows } = await this.pg.query<{ value: string }>('SELECT value FROM settings WHERE key = $1', [key]);
    return rows[0]?.value ?? fallback;
  }

  async settings() {
    return {
      showExpected: (await this.setting('mobile_show_expected', '0')) === '1',
      recount: (await this.setting('mobile_recount', '1')) === '1',
    };
  }

  async saveSettings(input: { showExpected?: boolean; recount?: boolean }) {
    for (const [key, value] of [
      ['mobile_show_expected', input.showExpected],
      ['mobile_recount', input.recount],
    ] as const) {
      if (typeof value !== 'boolean') continue;
      await this.pg.query('INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = excluded.value', [key, value ? '1' : '0']);
    }
    return this.settings();
  }

  /** Inventaires ouverts (d'un magasin, ou de tous). */
  private async openInventories(storeId?: string): Promise<OpenInventory[]> {
    const rows = await this.latest('inventory', storeId ? 'AND store_id = $2' : '', storeId ? [storeId] : [], "payload - 'lines'");
    return rows
      .filter((r) => r.payload['status'] === 'open')
      .map((r) => ({
        id: r.entity_id,
        storeId: str(r.payload['store_id']),
        number: str(r.payload['number']),
        label: (r.payload['label'] as string | null) ?? null,
        kind: str(r.payload['kind']),
        warehouseId: str(r.payload['warehouse_id']),
        inventoryDate: str(r.payload['inventory_date']),
        openedAt: str(r.payload['opened_at']),
        departmentIds: json<string[]>(r.payload['department_ids'], []),
      }))
      .sort((a, b) => b.openedAt.localeCompare(a.openedAt));
  }

  private async inventory(id: string): Promise<{ inv: OpenInventory | null; status: string | null }> {
    const row = (await this.latest('inventory', 'AND entity_id = $2', [id], "payload - 'lines'"))[0];
    if (!row) return { inv: null, status: null };
    const all = await this.openInventories(str(row.payload['store_id']));
    return { inv: all.find((i) => i.id === id) ?? null, status: str(row.payload['status']) };
  }

  /**
   * Lignes d'un inventaire telles que les PC les voient : celles envoyées à
   * l'ouverture, puis chaque ligne ajoutée, comptée ou retirée ensuite.
   */
  private async lines(inventoryId: string): Promise<Map<string, Line>> {
    const { rows: inv } = await this.pg.query<{ seq: string; lines: Line[] | null }>(
      "SELECT seq, payload->'lines' AS lines FROM events WHERE entity = 'inventory' AND entity_id = $1 ORDER BY seq DESC LIMIT 1",
      [inventoryId],
    );
    const byId = new Map<string, { seq: number; line: Line | null }>();
    const base = inv[0]?.lines ?? [];
    for (const l of base) byId.set(l.id, { seq: Number(inv[0]!.seq), line: l });
    const { rows } = await this.pg.query<{ entity_id: string; seq: string; op: string; payload: Line | null }>(
      `SELECT DISTINCT ON (entity_id) entity_id, seq, op, payload FROM events
       WHERE entity = 'inventory_line' AND (entity_id = ANY($2) OR entity_id IN (
         SELECT entity_id FROM events WHERE entity = 'inventory_line' AND payload->>'inventory_id' = $1))
       ORDER BY entity_id, seq DESC`,
      [inventoryId, base.map((l) => l.id)],
    );
    for (const r of rows) {
      const cur = byId.get(r.entity_id);
      if (cur && cur.seq > Number(r.seq)) continue;
      byId.set(r.entity_id, { seq: Number(r.seq), line: r.op === 'delete' ? null : r.payload });
    }
    const byArticle = new Map<string, Line>();
    for (const { line } of byId.values()) {
      if (!line) continue;
      const other = byArticle.get(line.article_id);
      if (!other || str(line.counted_at) > str(other.counted_at)) byArticle.set(line.article_id, line);
    }
    return byArticle;
  }

  /** Stock du dépôt envoyé par les PC (écran « Stock multi-magasin »), par article. */
  private async stockLevels(warehouseId: string): Promise<Map<string, number>> {
    const rows = await this.latest('stock_level', "AND entity_id LIKE $2 || ':%'", [warehouseId]);
    return new Map(rows.map((r) => [str(r.payload['article_id']), Number(r.payload['qty'] ?? 0)]));
  }

  private async userNames(): Promise<Map<string, string>> {
    const rows = await this.latest('user', '', [], "jsonb_build_object('name', payload->'name')");
    const names = new Map(rows.map((r) => [r.entity_id, str(r.payload['name'])]));
    const { rows: guests } = await this.pg.query<{ id: string; name: string }>('SELECT id, name FROM mobile_guests');
    for (const g of guests) names.set(`${GUEST_PREFIX}${g.id}`, `${g.name} (aide)`);
    return names;
  }

  /** Utilisateur inscrit sur les PC pour une saisie : l'aide compte au nom de son responsable. */
  private async pcUser(userId: string): Promise<string> {
    if (!userId.startsWith(GUEST_PREFIX)) return userId;
    const { rows } = await this.pg.query<{ on_behalf_of: string }>('SELECT on_behalf_of FROM mobile_guests WHERE id = $1', [userId.slice(GUEST_PREFIX.length)]);
    return rows[0]?.on_behalf_of ?? userId;
  }

  private async departments(): Promise<{ departments: Map<string, string>; families: Map<string, string> }> {
    const d = await this.latest('department', '', [], "jsonb_build_object('name', payload->'name')");
    const f = await this.latest('family', '', [], "jsonb_build_object('department_id', payload->'department_id')");
    return {
      departments: new Map(d.map((r) => [r.entity_id, str(r.payload['name'])])),
      families: new Map(f.map((r) => [r.entity_id, str(r.payload['department_id'])])),
    };
  }

  /** Un droit de l'utilisateur, comme sur les PC : rôle, réglages du rôle, privilèges personnels. */
  private async hasRight(userId: string, role: string, right: string, defaults: string[]): Promise<boolean> {
    if (role === 'admin') return true;
    const ur = await this.one('user_rights', userId);
    if (json<string[]>(ur?.['revokes'], []).includes(right)) return false;
    if (json<string[]>(ur?.['grants'], []).includes(right)) return true;
    const rr = await this.one('role_rights', role);
    const saved = json<Record<string, boolean>>(rr?.['rights'], {})[right];
    return saved ?? defaults.includes(role);
  }

  /** Droit « Saisir le stock physique dans un inventaire ». */
  private canCount(userId: string, role: string): Promise<boolean> {
    return this.hasRight(userId, role, 'inventory_count', ['manager', 'stock']);
  }

  /** Droit « Préparer un panier au rayon sur le téléphone ». */
  private canCart(userId: string, role: string): Promise<boolean> {
    return this.hasRight(userId, role, 'shelf_cart', ['manager', 'cashier', 'seller']);
  }

  /**
   * Droit qui suit son parent quand il n'est pas réglé (comme sur les PC) :
   * `chain` va du droit demandé au droit racine, `defaults` sont les rôles de la racine.
   */
  private async hasChainRight(userId: string, role: string, chain: string[], defaults: string[]): Promise<boolean> {
    if (role === 'admin') return true;
    const ur = await this.one('user_rights', userId);
    const rr = json<Record<string, boolean>>((await this.one('role_rights', role))?.['rights'], {});
    const revokes = json<string[]>(ur?.['revokes'], []);
    const grants = json<string[]>(ur?.['grants'], []);
    const [right] = chain;
    if (revokes.includes(right!)) return false;
    if (grants.includes(right!)) return true;
    for (const r of chain) if (rr[r] !== undefined) return rr[r]!;
    return defaults.includes(role);
  }

  /** Ce que la personne connectée peut faire sur le téléphone. */
  async rights(caller: MobileCaller): Promise<{ count: boolean; cart: boolean; missed: boolean; receive: boolean }> {
    if (caller.guest) return { count: true, cart: false, missed: false, receive: false };
    const { id, role } = caller.user;
    return {
      count: await this.canCount(id, role),
      cart: await this.canCart(id, role),
      missed: await this.hasRight(id, role, 'missed_sale', ['manager', 'cashier', 'seller', 'accountant', 'stock']),
      receive: await this.hasChainRight(id, role, ['mobile_reception', 'order_receive', 'purchase_orders'], ['manager', 'stock', 'buyer']),
    };
  }

  // ——— Rattachement du téléphone ———

  /** Code du QR affiché par le gérant pour relier un téléphone à un magasin. */
  async createPairing(storeId: string) {
    const store = storeId ? await this.one('store', storeId) : null;
    if (!store) throw new BadRequestException('Choisissez le magasin');
    const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    const code = Array.from(randomBytes(8), (b) => alphabet[b % alphabet.length]).join('');
    const expiresAt = new Date(Date.now() + PAIRING_MS);
    await this.pg.query('DELETE FROM mobile_pairings WHERE expires_at < now()');
    await this.pg.query('INSERT INTO mobile_pairings (code, store_id, expires_at) VALUES ($1, $2, $3)', [code, storeId, expiresAt]);
    return { code, storeId, storeName: str(store['name']), expiresAt: expiresAt.toISOString() };
  }

  async pair(input: { code?: string; guest?: string; name?: string }) {
    if (input?.guest) return this.pairGuest(str(input.guest), str(input.name));
    const code = str(input?.code)
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '');
    if (code.length !== 8) throw new BadRequestException('Code du QR invalide');
    const deviceId = randomUUID();
    const token = randomBytes(32).toString('base64url');
    const storeId = await this.pg.transaction(async (tx) => {
      const { rows } = await tx.query<{ store_id: string }>(
        'UPDATE mobile_pairings SET used_at = now() WHERE code = $1 AND used_at IS NULL AND expires_at > now() RETURNING store_id',
        [code],
      );
      if (!rows[0]) throw new NotFoundException('Code expiré ou déjà utilisé : demandez au gérant d’afficher un nouveau QR code');
      await tx.query("INSERT INTO devices (id, name, store_id, register_id, token_hash, kind) VALUES ($1, $2, $3, $4, $5, 'mobile')", [
        deviceId,
        str(input.name).trim().slice(0, 60) || 'Téléphone d’inventaire',
        rows[0].store_id,
        `mobile:${deviceId}`,
        hashToken(token),
      ]);
      return rows[0].store_id;
    });
    const store = await this.one('store', storeId);
    return { deviceId, token, storeId, storeName: str(store?.['name']) };
  }

  // ——— Aides sans compte ———

  /** Accès d'un aide à un inventaire : un code à 6 chiffres, affiché au gérant avec son QR code. */
  async createGuest(input: { inventoryId: string; name: string; onBehalfOf: string; hours?: number }) {
    const name = str(input?.name).trim().slice(0, 40);
    if (!name) throw new BadRequestException('Indiquez le nom de l’aide');
    const { inv } = await this.inventory(str(input?.inventoryId));
    if (!inv) throw new BadRequestException('Inventaire introuvable ou déjà clôturé');
    const boss = await this.one('user', str(input?.onBehalfOf));
    if (!boss || boss['active'] === 0) throw new BadRequestException('Choisissez le responsable au nom duquel l’aide compte');
    const hours = Math.min(24, Math.max(1, Math.round(Number(input?.hours) || 24)));
    let code = '';
    for (let i = 0; i < 20 && !code; i++) {
      const c = String(randomBytes(4).readUInt32BE() % 1_000_000).padStart(6, '0');
      const { rows } = await this.pg.query('SELECT 1 FROM mobile_guests WHERE code = $1 AND revoked_at IS NULL AND expires_at > now()', [c]);
      if (!rows.length) code = c;
    }
    if (!code) throw new HttpException('Réessayez', HttpStatus.SERVICE_UNAVAILABLE);
    const id = randomUUID();
    const expiresAt = new Date(Date.now() + hours * 3_600_000);
    await this.pg.query('INSERT INTO mobile_guests (id, store_id, inventory_id, name, code, on_behalf_of, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7)', [
      id,
      inv.storeId,
      inv.id,
      name,
      code,
      str(input.onBehalfOf),
      expiresAt,
    ]);
    return { id, name, code, inventoryId: inv.id, expiresAt: expiresAt.toISOString() };
  }

  async revokeGuest(id: string) {
    const { rows } = await this.pg.query('UPDATE mobile_guests SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL RETURNING id', [id]);
    if (!rows[0]) throw new NotFoundException('Accès introuvable ou déjà coupé');
    await this.pg.query('DELETE FROM mobile_sessions WHERE user_id = $1', [`${GUEST_PREFIX}${id}`]);
    return { ok: true };
  }

  /** Aide encore valable : pas coupé, pas expiré, inventaire toujours ouvert. */
  private async activeGuest(where: 'id' | 'code', value: string): Promise<GuestRow | null> {
    const { rows } = await this.pg.query<GuestRow>(`SELECT * FROM mobile_guests WHERE ${where} = $1 AND revoked_at IS NULL AND expires_at > now() ORDER BY created_at DESC LIMIT 1`, [
      value,
    ]);
    const g = rows[0];
    if (!g) return null;
    const { inv } = await this.inventory(g.inventory_id);
    return inv ? g : null;
  }

  private async guestByCode(raw: string): Promise<GuestRow> {
    const now = Date.now();
    if (this.guestFailures.until > now && this.guestFailures.count >= GUEST_MAX_FAILURES) {
      throw new HttpException('Trop de codes faux : réessayez dans quelques minutes', HttpStatus.TOO_MANY_REQUESTS);
    }
    const code = raw.replace(/\D/g, '');
    const g = code.length === 6 ? await this.activeGuest('code', code) : null;
    if (!g) {
      if (this.guestFailures.until <= now) this.guestFailures = { count: 0, until: now + LOCK_MS };
      this.guestFailures.count++;
      throw new UnauthorizedException('Code d’aide incorrect, expiré, ou inventaire clôturé');
    }
    return g;
  }

  private async guestSession(deviceId: string, g: GuestRow) {
    const session = randomBytes(32).toString('base64url');
    await this.pg.query('INSERT INTO mobile_sessions (token_hash, device_id, user_id, last_seen_at) VALUES ($1, $2, $3, now())', [
      hashToken(session),
      deviceId,
      `${GUEST_PREFIX}${g.id}`,
    ]);
    const store = await this.one('store', g.store_id);
    return { session, user: { id: `${GUEST_PREFIX}${g.id}`, name: `${g.name} (aide)`, role: 'guest' }, storeName: str(store?.['name']) };
  }

  /** Connexion d'un aide sur un téléphone déjà relié au magasin. */
  async loginGuest(device: MobileDevice, input: { code: string }) {
    const g = await this.guestByCode(str(input?.code));
    if (g.store_id !== device.store_id) throw new ForbiddenException('Ce code est pour un autre magasin');
    return this.guestSession(device.id, g);
  }

  /** Téléphone de l'aide, pas encore relié : le QR (ou le code) de l'aide le relie et le connecte. */
  private async pairGuest(code: string, name: string) {
    const g = await this.guestByCode(code);
    const deviceId = randomUUID();
    const token = randomBytes(32).toString('base64url');
    await this.pg.query("INSERT INTO devices (id, name, store_id, register_id, token_hash, kind) VALUES ($1, $2, $3, $4, $5, 'mobile')", [
      deviceId,
      name.trim().slice(0, 60) || `Téléphone de ${g.name}`,
      g.store_id,
      `mobile:${deviceId}`,
      hashToken(token),
    ]);
    const login = await this.guestSession(deviceId, g);
    return { deviceId, token, storeId: g.store_id, storeName: login.storeName, session: login.session, user: login.user };
  }

  async device(authorization: string | undefined): Promise<MobileDevice> {
    const token = authorization?.startsWith('Bearer ') ? authorization.slice(7) : null;
    if (!token) throw new UnauthorizedException('Téléphone non relié');
    const { rows } = await this.pg.query<MobileDevice>(
      "UPDATE devices SET last_seen_at = now() WHERE token_hash = $1 AND revoked_at IS NULL AND kind = 'mobile' RETURNING id, name, store_id",
      [hashToken(token)],
    );
    if (!rows[0]) throw new UnauthorizedException('Téléphone délié par le gérant : reliez-le de nouveau');
    return rows[0];
  }

  /** Connexion du compteur : identifiant et code, comme sur les PC. */
  async login(device: MobileDevice, input: { login: string; pin: string }) {
    const now = Date.now();
    const f = this.failures.get(device.id);
    if (f && f.until > now && f.count >= MAX_FAILURES) {
      throw new HttpException(`Trop de codes faux : réessayez dans ${Math.ceil((f.until - now) / 60_000)} minute(s)`, HttpStatus.TOO_MANY_REQUESTS);
    }
    const login = str(input?.login).trim().toLowerCase();
    const users = login ? await this.latest('user', "AND payload->>'login' = $2", [login]) : [];
    const user = users.find((u) => u.payload['active'] !== 0);
    if (!user || !verifyPin(str(input?.pin), str(user.payload['pin_hash']))) {
      const cur = f && f.until > now ? f : { count: 0, until: now + LOCK_MS };
      this.failures.set(device.id, { ...cur, count: cur.count + 1 });
      throw new UnauthorizedException('Identifiant ou code incorrect');
    }
    this.failures.delete(device.id);
    const storeId = user.payload['store_id'] as string | null;
    if (storeId && storeId !== device.store_id) throw new ForbiddenException('Cet utilisateur appartient à un autre magasin');
    const role = str(user.payload['role']);
    const can = await this.rights({ device, user: { id: user.entity_id, name: str(user.payload['name']), role } });
    if (!can.count && !can.cart && !can.receive)
      throw new ForbiddenException('Vous n’avez ni le droit de compter un inventaire, ni celui de préparer un panier, ni celui de réceptionner. Demandez-le au gérant.');
    const session = randomBytes(32).toString('base64url');
    await this.pg.query('INSERT INTO mobile_sessions (token_hash, device_id, user_id, last_seen_at) VALUES ($1, $2, $3, now())', [hashToken(session), device.id, user.entity_id]);
    const store = await this.one('store', device.store_id);
    return { session, user: { id: user.entity_id, name: str(user.payload['name']), role }, storeName: str(store?.['name']), can };
  }

  async caller(authorization: string | undefined, session: string | undefined): Promise<MobileCaller> {
    const device = await this.device(authorization);
    if (!session) throw new UnauthorizedException('Connectez-vous');
    const { rows } = await this.pg.query<{ user_id: string }>('UPDATE mobile_sessions SET last_seen_at = now() WHERE token_hash = $1 AND device_id = $2 RETURNING user_id', [
      hashToken(session),
      device.id,
    ]);
    if (!rows[0]) throw new UnauthorizedException('Connectez-vous');
    if (rows[0].user_id.startsWith(GUEST_PREFIX)) {
      const g = await this.activeGuest('id', rows[0].user_id.slice(GUEST_PREFIX.length));
      if (!g) {
        await this.pg.query('DELETE FROM mobile_sessions WHERE token_hash = $1', [hashToken(session)]);
        throw new UnauthorizedException('Accès d’aide terminé (inventaire clôturé, accès coupé ou expiré)');
      }
      return {
        device,
        user: { id: rows[0].user_id, name: `${g.name} (aide)`, role: 'guest' },
        guest: { id: g.id, inventoryId: g.inventory_id, onBehalfOf: g.on_behalf_of },
      };
    }
    const user = await this.one('user', rows[0].user_id);
    if (!user || user['active'] === 0) throw new UnauthorizedException('Utilisateur désactivé');
    return { device, user: { id: rows[0].user_id, name: str(user['name']), role: str(user['role']) } };
  }

  async logout(authorization: string | undefined, session: string | undefined) {
    const device = await this.device(authorization);
    if (session) await this.pg.query('DELETE FROM mobile_sessions WHERE token_hash = $1 AND device_id = $2', [hashToken(session), device.id]);
    return { ok: true };
  }

  // ——— Panier préparé au rayon ———

  /**
   * Panier préparé par un vendeur sur le téléphone : il part à la caisse, qui
   * le charge comme un ticket en attente, au nom du vendeur (commission).
   * Le même panier renvoyé (réseau coupé) n'est enregistré qu'une fois.
   */
  async pushCart(caller: MobileCaller, input: { id: string; label?: string | null; lines: { articleId: string; qty: number; packId?: string | null }[] }) {
    if (!(await this.rights(caller)).cart) throw new ForbiddenException('Vous n’avez pas le droit de préparer un panier. Demandez-le au gérant.');
    const id = str(input?.id).trim();
    if (!/^[\w-]{8,64}$/.test(id)) throw new BadRequestException('Panier invalide');
    const lines = (Array.isArray(input?.lines) ? input.lines : [])
      .map((l) => ({ articleId: str(l?.articleId), qty: Math.round(Number(l?.qty)), packId: l?.packId ? str(l.packId) : null }))
      .filter((l) => l.articleId && Number.isSafeInteger(l.qty) && l.qty > 0);
    if (!lines.length || lines.length > 200) throw new BadRequestException('Le panier est vide (200 lignes au plus)');
    const label = str(input?.label).trim().slice(0, 60) || null;
    const { rows } = await this.pg.query<{ number: number }>(
      `INSERT INTO shelf_carts (id, device_id, store_id, user_id, user_name, label, lines, number)
       VALUES ($1, $2, $3, $4, $5, $6, $7, (SELECT COALESCE(MAX(number), 0) + 1 FROM shelf_carts WHERE store_id = $3 AND created_at >= date_trunc('day', now())))
       ON CONFLICT (id) DO NOTHING RETURNING number`,
      [id, caller.device.id, caller.device.store_id, caller.user.id, caller.user.name, label, JSON.stringify(lines)],
    );
    const number = rows[0]?.number ?? (await this.pg.query<{ number: number }>('SELECT number FROM shelf_carts WHERE id = $1', [id])).rows[0]?.number ?? null;
    return { id, number };
  }

  /** Paniers du vendeur aujourd'hui : envoyés, pris en caisse. */
  async myCarts(caller: MobileCaller) {
    const { rows } = await this.pg.query<{ id: string; number: number; label: string | null; lines: unknown[]; created_at: Date; taken_at: Date | null }>(
      "SELECT id, number, label, lines, created_at, taken_at FROM shelf_carts WHERE user_id = $1 AND store_id = $2 AND created_at >= now() - interval '1 day' ORDER BY created_at DESC",
      [caller.user.id, caller.device.store_id],
    );
    return { carts: rows.map((r) => ({ id: r.id, number: r.number, label: r.label, lines: r.lines.length, at: new Date(r.created_at).toISOString(), takenAt: r.taken_at ? new Date(r.taken_at).toISOString() : null })) };
  }

  /** Paniers des vendeurs qui attendent une caisse du magasin du PC. */
  async waitingCarts(storeId: string) {
    const { rows } = await this.pg.query<{ id: string; number: number; label: string | null; user_id: string; user_name: string; lines: unknown; created_at: Date }>(
      "SELECT id, number, label, user_id, user_name, lines, created_at FROM shelf_carts WHERE store_id = $1 AND taken_at IS NULL AND created_at >= now() - interval '12 hours' ORDER BY created_at",
      [storeId],
    );
    return { carts: rows.map((r) => ({ id: r.id, number: r.number, label: r.label, sellerId: r.user_id, sellerName: r.user_name, lines: r.lines, at: new Date(r.created_at).toISOString() })) };
  }

  /** La caisse prend le panier : une seule caisse l'obtient. */
  async takeCart(device: { id: string; store_id: string }, id: string) {
    const { rows } = await this.pg.query<{ id: string; number: number; label: string | null; user_id: string; user_name: string; lines: unknown; created_at: Date }>(
      'UPDATE shelf_carts SET taken_at = now(), taken_by = $3 WHERE id = $1 AND store_id = $2 AND taken_at IS NULL RETURNING id, number, label, user_id, user_name, lines, created_at',
      [id, device.store_id, device.id],
    );
    const r = rows[0];
    if (!r) throw new HttpException('Ce panier a déjà été pris par une caisse', HttpStatus.CONFLICT);
    return { id: r.id, number: r.number, label: r.label, sellerId: r.user_id, sellerName: r.user_name, lines: r.lines, at: new Date(r.created_at).toISOString() };
  }

  // ——— Le client voulait… ———

  /**
   * Vente manquée notée au rayon : elle part aux PC comme une saisie faite sur
   * un PC (`missed_sale`) ; le gérant la voit et la commande en tient compte.
   */
  async recordMissed(caller: MobileCaller, input: { id?: string; articleId?: string | null; label?: string | null; qty?: number; reason?: string; note?: string | null }) {
    if (!(await this.rights(caller)).missed) throw new ForbiddenException('Vous n’avez pas le droit de noter une vente manquée. Demandez-le au gérant.');
    const id = str(input?.id).trim() || randomUUID();
    if (!/^[\w-]{8,64}$/.test(id)) throw new BadRequestException('Demande invalide');
    const articleId = input?.articleId ? str(input.articleId) : null;
    const article = articleId ? await this.one('article', articleId) : null;
    if (articleId && !article) throw new BadRequestException('Produit inconnu');
    const label = article ? str(article['name']) : str(input?.label).trim().slice(0, 80);
    if (label.length < 2) throw new BadRequestException('Dites quel produit le client voulait');
    const qty = Math.round(Number(input?.qty ?? 1000));
    if (!Number.isSafeInteger(qty) || qty <= 0 || qty > 1_000_000_000) throw new BadRequestException('Quantité invalide');
    const reason = ['absent', 'rupture', 'prix', 'autre'].includes(str(input?.reason)) ? str(input!.reason) : article ? 'rupture' : 'absent';
    const { rows: dup } = await this.pg.query("SELECT 1 FROM events WHERE entity = 'missed_sale' AND entity_id = $1 LIMIT 1", [id]);
    if (dup.length) return { id };
    const now = new Date().toISOString();
    const payload = {
      id,
      store_id: caller.device.store_id,
      article_id: articleId,
      label,
      qty,
      reason: !article && reason === 'rupture' ? 'absent' : reason,
      note: str(input?.note).trim().slice(0, 200) || null,
      user_id: caller.user.id,
      source: 'phone',
      created_at: now,
      updated_at: now,
    };
    await this.pg.query(
      `INSERT INTO events (id, device_id, entity, entity_id, op, store_id, register_id, payload, created_at)
       VALUES ($1, $2, 'missed_sale', $3, 'upsert', $4, NULL, $5, now())`,
      [randomUUID(), caller.device.id, id, caller.device.store_id, JSON.stringify(payload)],
    );
    return { id };
  }

  // ——— Fiche produit : stock ailleurs, prochaine livraison, remplaçant ———

  /** Bons de commande envoyés et pas encore soldés (d'un magasin, ou de tous). */
  private async openOrders(storeId?: string) {
    const orders = (await this.latest('purchase_order', storeId ? 'AND store_id = $2' : '', storeId ? [storeId] : [])).filter((r) => r.payload['status'] === 'sent');
    if (!orders.length) return [];
    const ids = orders.map((o) => o.entity_id);
    const receptions = await this.latest('reception', "AND payload->>'order_id' = ANY($2)", [ids]);
    const received = new Map<string, number>();
    for (const r of receptions) {
      for (const l of (r.payload['lines'] as { order_line_id?: string | null; qty?: number }[] | undefined) ?? []) {
        if (l.order_line_id) received.set(l.order_line_id, (received.get(l.order_line_id) ?? 0) + Number(l.qty ?? 0));
      }
    }
    return orders.map((o) => ({
      id: o.entity_id,
      number: str(o.payload['number']),
      storeId: str(o.payload['store_id']),
      warehouseId: str(o.payload['warehouse_id']),
      supplierId: str(o.payload['supplier_id']),
      orderDate: str(o.payload['order_date']),
      expectedDate: (o.payload['expected_date'] as string | null) ?? null,
      lines: ((o.payload['lines'] as { id: string; article_id: string; qty: number }[] | undefined) ?? []).map((l) => ({
        id: l.id,
        articleId: l.article_id,
        qty: Number(l.qty),
        received: received.get(l.id) ?? 0,
      })),
    }));
  }

  /**
   * Ce que le vendeur répond au client devant le rayon : stock dans les autres
   * dépôts et magasins, prochaine livraison attendue, produit de remplacement.
   */
  async productInfo(caller: MobileCaller, articleId: string) {
    const article = await this.one('article', articleId);
    if (!article) throw new NotFoundException('Produit inconnu');
    const warehouses = await this.latest('warehouse', '', [], "jsonb_build_object('name', payload->'name', 'store_id', payload->'store_id', 'active', payload->'active')");
    const stores = new Map((await this.latest('store', '', [], "jsonb_build_object('name', payload->'name')")).map((r) => [r.entity_id, str(r.payload['name'])]));
    const levels = await this.latest('stock_level', "AND entity_id LIKE '%:' || $2", [articleId]);
    const qtyOf = new Map(levels.map((r) => [str(r.payload['warehouse_id']), Number(r.payload['qty'] ?? 0)]));
    const stock = warehouses
      .filter((w) => w.payload['active'] !== 0 && qtyOf.has(w.entity_id))
      .map((w) => ({
        warehouseId: w.entity_id,
        warehouse: str(w.payload['name']),
        store: stores.get(str(w.payload['store_id'])) ?? '',
        here: str(w.payload['store_id']) === caller.device.store_id,
        qty: qtyOf.get(w.entity_id) ?? 0,
      }))
      .sort((a, b) => Number(b.here) - Number(a.here) || b.qty - a.qty);
    const coming = (await this.openOrders(caller.device.store_id))
      .flatMap((o) => o.lines.filter((l) => l.articleId === articleId && l.qty > l.received).map((l) => ({ number: o.number, expectedDate: o.expectedDate ?? o.orderDate, qty: l.qty - l.received })))
      .sort((a, b) => a.expectedDate.localeCompare(b.expectedDate));
    const subId = article['substitute_id'] ? str(article['substitute_id']) : null;
    const sub = subId ? await this.one('article', subId) : null;
    const subStock = subId
      ? (await this.latest('stock_level', "AND entity_id LIKE '%:' || $2", [subId]))
          .filter((r) => warehouses.some((w) => w.entity_id === str(r.payload['warehouse_id']) && str(w.payload['store_id']) === caller.device.store_id))
          .reduce((t, r) => t + Number(r.payload['qty'] ?? 0), 0)
      : 0;
    return {
      id: articleId,
      name: str(article['name']),
      unit: str(article['unit']) || 'piece',
      price: Number(article['sale_price'] ?? 0) || 0,
      stock,
      nextDelivery: coming[0] ?? null,
      substitute: sub ? { id: subId!, name: str(sub['name']), price: Number(sub['sale_price'] ?? 0) || 0, stockHere: subStock } : null,
    };
  }

  // ——— Réception sur le téléphone ———

  /** Bons de commande du magasin à réceptionner, avec ce qui reste à recevoir par ligne. */
  async receptionOrders(caller: MobileCaller) {
    if (!(await this.rights(caller)).receive) throw new ForbiddenException('Vous n’avez pas le droit de réceptionner. Demandez-le au gérant.');
    const suppliers = new Map((await this.latest('supplier', '', [], "jsonb_build_object('name', payload->'name')")).map((r) => [r.entity_id, str(r.payload['name'])]));
    const { rows: waiting } = await this.pg.query<{ order_id: string }>('SELECT order_id FROM mobile_receptions WHERE store_id = $1 AND taken_at IS NULL', [caller.device.store_id]);
    const pending = new Set(waiting.map((w) => w.order_id));
    const orders = (await this.openOrders(caller.device.store_id)).filter((o) => o.lines.some((l) => l.qty > l.received));
    return {
      orders: orders
        .map((o) => ({
          id: o.id,
          number: o.number,
          supplier: suppliers.get(o.supplierId) ?? '',
          expectedDate: o.expectedDate,
          waitingOnPc: pending.has(o.id),
          lines: o.lines.filter((l) => l.qty > l.received).map((l) => ({ id: l.id, articleId: l.articleId, ordered: l.qty, remaining: l.qty - l.received })),
        }))
        .sort((a, b) => str(a.expectedDate).localeCompare(str(b.expectedDate))),
    };
  }

  /** Livraison comptée devant le camion : un PC du magasin la reprend et la valide. */
  async pushReception(
    caller: MobileCaller,
    input: { id: string; orderId: string; deliveryNote?: string | null; note?: string | null; lines: { orderLineId: string; articleId: string; qty: number; damaged?: number; lot?: string | null; expiry?: string | null }[] },
  ) {
    if (!(await this.rights(caller)).receive) throw new ForbiddenException('Vous n’avez pas le droit de réceptionner. Demandez-le au gérant.');
    const id = str(input?.id).trim();
    if (!/^[\w-]{8,64}$/.test(id)) throw new BadRequestException('Réception invalide');
    const order = (await this.openOrders(caller.device.store_id)).find((o) => o.id === str(input?.orderId));
    if (!order) throw new BadRequestException('Ce bon de commande n’est plus à réceptionner');
    const known = new Map(order.lines.map((l) => [l.id, l]));
    const lines = (Array.isArray(input?.lines) ? input.lines : [])
      .map((l) => ({
        orderLineId: str(l?.orderLineId),
        articleId: str(l?.articleId),
        qty: Math.round(Number(l?.qty)),
        damaged: Math.max(0, Math.round(Number(l?.damaged ?? 0))) || 0,
        lot: str(l?.lot).trim().slice(0, 40) || null,
        expiry: /^\d{4}-\d{2}-\d{2}$/.test(str(l?.expiry)) ? str(l!.expiry) : null,
      }))
      .filter((l) => known.get(l.orderLineId)?.articleId === l.articleId && Number.isSafeInteger(l.qty) && l.qty >= 0);
    if (!lines.length) throw new BadRequestException('Rien n’a été compté');
    await this.pg.query(
      `INSERT INTO mobile_receptions (id, device_id, store_id, order_id, order_number, user_id, user_name, delivery_note, note, lines)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT (id) DO NOTHING`,
      [id, caller.device.id, caller.device.store_id, order.id, order.number, caller.user.id, caller.user.name, str(input?.deliveryNote).trim().slice(0, 40) || null, str(input?.note).trim().slice(0, 200) || null, JSON.stringify(lines)],
    );
    return { id };
  }

  private receptionRow(r: { id: string; order_id: string; order_number: string | null; user_name: string; delivery_note: string | null; note: string | null; lines: unknown; created_at: Date }) {
    return { id: r.id, orderId: r.order_id, orderNumber: r.order_number, userName: r.user_name, deliveryNote: r.delivery_note, note: r.note, lines: typeof r.lines === 'string' ? JSON.parse(r.lines) : r.lines, at: new Date(r.created_at).toISOString() };
  }

  /** Réceptions du téléphone qui attendent un PC du magasin. */
  async waitingReceptions(storeId: string) {
    const { rows } = await this.pg.query<{ id: string; order_id: string; order_number: string | null; user_name: string; delivery_note: string | null; note: string | null; lines: unknown; created_at: Date }>(
      "SELECT id, order_id, order_number, user_name, delivery_note, note, lines, created_at FROM mobile_receptions WHERE store_id = $1 AND taken_at IS NULL AND created_at >= now() - interval '7 days' ORDER BY created_at",
      [storeId],
    );
    return { receptions: rows.map((r) => this.receptionRow(r)) };
  }

  /** Le PC prend la réception : un seul PC l'obtient. */
  async takeReception(device: { id: string; store_id: string }, id: string) {
    const { rows } = await this.pg.query<{ id: string; order_id: string; order_number: string | null; user_name: string; delivery_note: string | null; note: string | null; lines: unknown; created_at: Date }>(
      'UPDATE mobile_receptions SET taken_at = now(), taken_by = $3 WHERE id = $1 AND store_id = $2 AND taken_at IS NULL RETURNING id, order_id, order_number, user_name, delivery_note, note, lines, created_at',
      [id, device.store_id, device.id],
    );
    if (!rows[0]) throw new HttpException('Cette réception a déjà été reprise par un autre PC', HttpStatus.CONFLICT);
    return this.receptionRow(rows[0]);
  }

  /** Réceptions envoyées par cette personne ces derniers jours. */
  async myReceptions(caller: MobileCaller) {
    const { rows } = await this.pg.query<{ id: string; order_number: string | null; created_at: Date; taken_at: Date | null }>(
      "SELECT id, order_number, created_at, taken_at FROM mobile_receptions WHERE user_id = $1 AND store_id = $2 AND created_at >= now() - interval '3 days' ORDER BY created_at DESC",
      [caller.user.id, caller.device.store_id],
    );
    return { receptions: rows.map((r) => ({ id: r.id, orderNumber: r.order_number, at: new Date(r.created_at).toISOString(), takenAt: r.taken_at ? new Date(r.taken_at).toISOString() : null })) };
  }

  // ——— Données pour le téléphone ———

  private async catalogVersion(): Promise<string> {
    const { rows } = await this.pg.query<{ v: string | null }>("SELECT MAX(seq)::text AS v FROM events WHERE entity IN ('article', 'family', 'department')");
    return rows[0]?.v ?? '0';
  }

  /** Articles vendus du magasin, au format du téléphone (sans photo). */
  private async phoneArticles(families: Map<string, string>, extra = '', params: unknown[] = []) {
    const rows = await this.latest('article', extra, params, "payload - 'photo'");
    return rows
      .filter((r) => r.payload['active'] !== 0 && r.payload['is_service'] !== 1)
      .map((r) => {
        const p = r.payload;
        return {
          id: r.entity_id,
          code: str(p['code']),
          name: str(p['name']),
          unit: str(p['unit']) || 'piece',
          unitName: (p['unit_name'] as string | null) ?? null,
          otherRef: (p['other_ref'] as string | null) ?? null,
          departmentId: families.get(str(p['family_id'])) || null,
          barcodes: ((p['barcodes'] as { code: string; pack_qty: number }[] | undefined) ?? []).map((b) => ({ code: String(b.code).trim(), packQty: Number(b.pack_qty ?? 1000) || 1000 })),
          packs:
            p['unit'] === 'piece'
              ? ((p['packs'] as { name: string; units: number; barcode: string | null }[] | undefined) ?? []).map((k) => ({
                  name: k.name,
                  units: Number(k.units),
                  barcode: k.barcode ? String(k.barcode).trim() : null,
                }))
              : [],
          // Les photos partent à part (une par fiche ouverte) : le catalogue reste léger.
          thumb: null as string | null,
          /** Prix de vente indicatif (la caisse refait le prix du magasin et les promotions). */
          price: Number(p['sale_price'] ?? 0) || 0,
        };
      });
  }

  /**
   * Catalogue : articles, codes-barres, conditionnements et rayons, sans les
   * photos. Rien n'est renvoyé s'il n'a pas changé.
   */
  async catalog(since?: string) {
    const version = await this.catalogVersion();
    if (since && since === version) return { version, unchanged: true };
    const { departments, families } = await this.departments();
    const articles = (await this.phoneArticles(families)).sort((a, b) => a.name.localeCompare(b.name, 'fr'));
    return { version, articles, departments: [...departments].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name, 'fr')) };
  }

  /**
   * Recherche faite par le serveur quand le téléphone ne trouve pas : code
   * article, code-barres, code d'un conditionnement, autre référence, ou mots
   * du nom. Couvre un catalogue pas encore (ou mal) téléchargé.
   */
  async find(query: string) {
    const q = (query ?? '').trim();
    if (q.length < 2) return { articles: [] };
    const { families } = await this.departments();
    const all = await this.phoneArticles(families);
    const fold = (v: string) => v.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const variants = new Set([q, q.replace(/^0+/, ''), `0${q}`]);
    const exact = all.filter(
      (a) => variants.has(a.code) || (a.otherRef && variants.has(a.otherRef)) || a.barcodes.some((b) => variants.has(b.code)) || a.packs.some((k) => k.barcode && variants.has(k.barcode)),
    );
    if (exact.length) return { articles: exact.slice(0, 20) };
    const words = fold(q).split(/\s+/);
    const byName = all.filter((a) => words.every((w) => fold(a.name).includes(w)) || a.code.toLowerCase().startsWith(q.toLowerCase()));
    return { articles: byName.sort((a, b) => a.name.localeCompare(b.name, 'fr')).slice(0, 40) };
  }

  /** Vignette d'un article, pour la fiche produit du téléphone. */
  async thumb(articleId: string) {
    const rows = await this.latest('article', 'AND entity_id = $2', [articleId], "jsonb_build_object('thumb', payload->'photo'->'thumb')");
    const t = rows[0]?.payload['thumb'];
    return { thumb: typeof t === 'string' && t.length <= MAX_THUMB ? t : null };
  }

  /** Comptages des téléphones pour un produit : le dernier par endroit. */
  private async locationCounts(inventoryId: string, articleId?: string) {
    const { rows } = await this.pg.query<{ article_id: string; location: string; qty: string | null; detail: number[] | null; counted_at: Date; user_id: string }>(
      `SELECT DISTINCT ON (article_id, location) article_id, location, qty, detail, counted_at, user_id FROM mobile_counts
       WHERE inventory_id = $1 ${articleId ? 'AND article_id = $2' : ''}
       ORDER BY article_id, location, counted_at DESC, received_at DESC`,
      articleId ? [inventoryId, articleId] : [inventoryId],
    );
    return rows.map((r) => ({ ...r, qty: r.qty === null ? null : Number(r.qty) }));
  }

  /** Produits dont le comptage d'une seule personne s'écarte beaucoup du stock attendu. */
  private async toRecount(inventoryId: string, lines: Map<string, Line>, levels: Map<string, number>) {
    const { rows } = await this.pg.query<{ article_id: string; users: string[] }>(
      'SELECT article_id, array_agg(DISTINCT user_id) AS users FROM mobile_counts WHERE inventory_id = $1 GROUP BY article_id',
      [inventoryId],
    );
    const out: { articleId: string; counted: number; expected: number; by: string }[] = [];
    for (const r of rows) {
      if (r.users.length !== 1) continue;
      const line = lines.get(r.article_id);
      const expected = levels.get(r.article_id);
      if (!line || line.counted === null || expected === undefined) continue;
      // Compté ensuite sur un PC : la vérification se fait là-bas.
      if (line.counted_by && line.counted_by !== (await this.pcUser(r.users[0]!))) continue;
      const gap = Math.abs(Number(line.counted) - expected);
      if (gap >= RECOUNT_MIN && gap >= Math.abs(expected) * RECOUNT_RATIO) out.push({ articleId: r.article_id, counted: Number(line.counted), expected, by: r.users[0]! });
    }
    return out;
  }

  /** Inventaires ouverts du magasin, avec ce qui est déjà compté (par les PC et les téléphones). */
  async inventories(caller: MobileCaller) {
    const settings = await this.settings();
    const warehouses = new Map((await this.latest('warehouse', '', [], "jsonb_build_object('name', payload->'name')")).map((w) => [w.entity_id, str(w.payload['name'])]));
    const users = await this.userNames();
    const out = [];
    const showExpected = settings.showExpected && !caller.guest;
    const can = await this.rights(caller);
    for (const inv of can.count ? await this.openInventories(caller.device.store_id) : []) {
      if (caller.guest && inv.id !== caller.guest.inventoryId) continue;
      const lines = await this.lines(inv.id);
      const levels = settings.showExpected || settings.recount ? await this.stockLevels(inv.warehouseId) : new Map<string, number>();
      const { rows: assigned } = await this.pg.query<{ department_ids: string[] }>('SELECT department_ids FROM mobile_assignments WHERE inventory_id = $1 AND user_id = $2', [
        inv.id,
        caller.user.id,
      ]);
      const counted = [...lines.values()]
        .filter((l) => l.counted !== null)
        .map((l) => ({ articleId: l.article_id, qty: Number(l.counted), at: l.counted_at, by: users.get(str(l.counted_by)) ?? '' }));
      const mine = (await this.locationCounts(inv.id))
        .filter((c) => c.user_id === caller.user.id && c.qty !== null)
        .map((c) => ({ articleId: c.article_id, location: c.location, qty: c.qty, detail: c.detail, at: c.counted_at.toISOString() }));
      const recount = settings.recount ? (await this.toRecount(inv.id, lines, levels)).filter((r) => r.by !== caller.user.id).map((r) => r.articleId) : [];
      out.push({
        id: inv.id,
        number: inv.number,
        label: inv.label,
        kind: inv.kind,
        warehouseId: inv.warehouseId,
        warehouseName: warehouses.get(inv.warehouseId) ?? '',
        inventoryDate: inv.inventoryDate,
        departmentIds: inv.departmentIds,
        articleIds: [...lines.keys()],
        counted,
        mine,
        assigned: assigned[0]?.department_ids ?? [],
        recount,
        expected: showExpected ? Object.fromEntries([...lines.keys()].map((a) => [a, levels.get(a) ?? 0])) : null,
      });
    }
    return { inventories: out, catalogVersion: await this.catalogVersion(), showExpected, user: caller.user, can };
  }

  /**
   * Comptages envoyés par le téléphone (déjà reçus : ignorés). Pour chaque
   * produit touché, le total des endroits devient la quantité comptée de la
   * ligne d'inventaire, envoyée aux PC comme une saisie faite sur un PC.
   */
  /**
   * `sentAt` : heure du téléphone à l'envoi. Une horloge de téléphone en avance
   * ou en retard décale ses comptages d'autant ; on les remet à l'heure du serveur
   * pour que les ventes faites après le comptage soient bien déduites.
   */
  async pushCounts(caller: MobileCaller, counts: MobileCountInput[], sentAt?: string) {
    if (!Array.isArray(counts) || counts.length > 1000) throw new BadRequestException('Lot de comptages invalide (1000 au plus)');
    if (!(await this.rights(caller)).count) throw new ForbiddenException('Vous n’avez pas le droit de compter un inventaire. Demandez-le au gérant.');
    const accepted: string[] = [];
    const rejected: { id: string; reason: string }[] = [];
    const touched = new Map<string, Set<string>>();
    const inventories = new Map<string, Awaited<ReturnType<MobileService['inventory']>>>();
    const articles = new Map<string, boolean>();
    const soon = Date.now() + 10 * 60_000;
    const sent = Date.parse(str(sentAt));
    const skew = Number.isFinite(sent) && Math.abs(Date.now() - sent) > 60_000 ? Date.now() - sent : 0;
    for (const c of counts) {
      const id = str(c?.id);
      if (!/^[\w-]{8,64}$/.test(id)) throw new BadRequestException('Comptage sans identifiant');
      const at = Date.parse(str(c.countedAt)) + skew;
      const qtyOk = c.qty === null || (Number.isSafeInteger(c.qty) && c.qty >= 0 && c.qty < 1e12);
      const detail = Array.isArray(c.detail) && c.detail.length <= 4 && c.detail.every((n) => Number.isFinite(n) && n >= 0) ? c.detail : null;
      if (!qtyOk || !Number.isFinite(at) || at > soon) {
        rejected.push({ id, reason: 'Comptage invalide' });
        continue;
      }
      const invId = str(c.inventoryId);
      if (!inventories.has(invId)) inventories.set(invId, await this.inventory(invId));
      const { inv, status } = inventories.get(invId)!;
      if (caller.guest && invId !== caller.guest.inventoryId) {
        rejected.push({ id, reason: 'Inventaire non confié à cet aide' });
        continue;
      }
      if (!inv || inv.storeId !== caller.device.store_id) {
        rejected.push({ id, reason: status === 'closed' ? 'Inventaire clôturé' : status === 'cancelled' ? 'Inventaire annulé' : 'Inventaire introuvable' });
        continue;
      }
      const articleId = str(c.articleId);
      if (!articles.has(articleId)) articles.set(articleId, (await this.one('article', articleId)) !== null);
      if (!articles.get(articleId)) {
        rejected.push({ id, reason: 'Article inconnu' });
        continue;
      }
      const location = str(c.location).trim().slice(0, 40) || 'Rayon';
      const { rows } = await this.pg.query(
        `INSERT INTO mobile_counts (id, device_id, user_id, inventory_id, article_id, location, qty, detail, counted_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (id) DO NOTHING RETURNING id`,
        [id, caller.device.id, caller.user.id, invId, articleId, location, c.qty, detail ? JSON.stringify(detail) : null, new Date(at)],
      );
      accepted.push(id);
      if (!rows.length) continue;
      if (!touched.has(invId)) touched.set(invId, new Set());
      touched.get(invId)!.add(articleId);
    }
    for (const [invId, ids] of touched) await this.publish(caller, inventories.get(invId)!.inv!, ids);
    return { accepted, rejected };
  }

  /** Envoie aux PC la nouvelle quantité comptée de chaque produit (total des endroits). */
  private async publish(caller: MobileCaller, inv: OpenInventory, articleIds: Set<string>) {
    const lines = await this.lines(inv.id);
    const levels = await this.stockLevels(inv.warehouseId);
    const now = new Date();
    // Tout est lu avant la transaction : la base intégrée n'a qu'une connexion.
    const events: [string, string, Json][] = [];
    const me = await this.pcUser(caller.user.id);
    for (const articleId of articleIds) {
      const places = (await this.locationCounts(inv.id, articleId)).filter((p) => p.qty !== null);
      const latestPlace = [...places].sort((a, b) => b.counted_at.getTime() - a.counted_at.getTime())[0];
      const counted = places.length ? places.reduce((t, p) => t + p.qty!, 0) : null;
      const details = places.map((p) => p.detail);
      const width = details[0]?.length ?? 0;
      const detail =
        counted !== null && width && details.every((d) => Array.isArray(d) && d.length === width)
          ? Array.from({ length: width }, (_, i) => details.reduce((t, d) => t + Number(d![i] ?? 0), 0))
          : null;
      const countedAt = (latestPlace?.counted_at ?? now).toISOString();
      const base: Line = lines.get(articleId) ?? {
        // Produit hors de la liste (inventaire partiel, article créé depuis) : la ligne est ajoutée.
        id: randomUUID(),
        inventory_id: inv.id,
        article_id: articleId,
        opening_qty: levels.get(articleId) ?? 0,
        counted: null,
        counted_detail: null,
        counted_at: null,
        counted_by: null,
        expected: null,
        difference: null,
        unit_cost: null,
      };
      const line = {
        ...base,
        counted,
        counted_detail: detail ? JSON.stringify(detail) : null,
        counted_at: counted === null ? null : countedAt,
        counted_by: counted === null ? null : latestPlace ? await this.pcUser(latestPlace.user_id) : me,
      };
      // `counter` : la personne qui a vraiment compté (un aide), pour le suivi du gérant ; les PC l'ignorent.
      const entry = { id: randomUUID(), inventory_id: inv.id, article_id: articleId, user_id: me, counter: caller.user.id, counted, at: countedAt };
      events.push(['inventory_line', line.id, line], ['inventory_entry', entry.id, entry]);
    }
    await this.pg.transaction(async (tx) => {
      for (const [entity, entityId, payload] of events) {
        await tx.query(
          `INSERT INTO events (id, device_id, entity, entity_id, op, store_id, register_id, payload, created_at)
           VALUES ($1, $2, $3, $4, 'upsert', $5, NULL, $6, $7)`,
          [randomUUID(), caller.device.id, entity, entityId, inv.storeId, JSON.stringify(payload), now],
        );
      }
    });
  }

  /** Code-barres inconnu : photo, nom lu sur l'emballage et quantité, pour que le gérant crée l'article. */
  async addUnknown(
    caller: MobileCaller,
    input: { id: string; inventoryId?: string; code?: string; note?: string; qty?: number | null; location?: string; photo?: string | null; at?: string },
  ) {
    const id = str(input?.id);
    if (!/^[\w-]{8,64}$/.test(id)) throw new BadRequestException('Relevé sans identifiant');
    const photo = typeof input.photo === 'string' && input.photo.startsWith('data:image/') ? input.photo : null;
    if (photo && photo.length > MAX_PHOTO) throw new BadRequestException('Photo trop lourde');
    if (!str(input.code).trim() && !str(input.note).trim() && !photo) throw new BadRequestException('Indiquez le code, le nom ou une photo');
    const at = Date.parse(str(input.at));
    await this.pg.query(
      `INSERT INTO mobile_unknowns (id, device_id, user_id, inventory_id, code, note, qty, location, photo, at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT (id) DO NOTHING`,
      [
        id,
        caller.device.id,
        caller.user.id,
        str(input.inventoryId) || null,
        str(input.code).trim().slice(0, 64) || null,
        str(input.note).trim().slice(0, 200) || null,
        Number.isSafeInteger(input.qty) && input.qty! >= 0 ? input.qty : null,
        str(input.location).trim().slice(0, 40) || null,
        photo,
        Number.isFinite(at) ? new Date(at) : new Date(),
      ],
    );
    return { ok: true };
  }

  // ——— Suivi par le gérant ———

  async overview() {
    const settings = await this.settings();
    const stores = (await this.latest('store', '', [], "jsonb_build_object('name', payload->'name', 'active', payload->'active')"))
      .filter((s) => s.payload['active'] !== 0)
      .map((s) => ({ id: s.entity_id, name: str(s.payload['name']) }));
    const storeName = new Map(stores.map((s) => [s.id, s.name]));
    const users = await this.userNames();
    const warehouses = new Map((await this.latest('warehouse', '', [], "jsonb_build_object('name', payload->'name')")).map((w) => [w.entity_id, str(w.payload['name'])]));
    const { departments, families } = await this.departments();
    const articleRows = await this.latest('article', '', [], "jsonb_build_object('name', payload->'name', 'family_id', payload->'family_id', 'unit', payload->'unit')");
    const articles = new Map(
      articleRows.map((a) => [a.entity_id, { name: str(a.payload['name']), unit: str(a.payload['unit']), departmentId: families.get(str(a.payload['family_id'])) ?? '' }]),
    );

    const { rows: devices } = await this.pg.query<{ id: string; name: string; store_id: string; created_at: Date; last_seen_at: Date | null; revoked_at: Date | null }>(
      "SELECT id, name, store_id, created_at, last_seen_at, revoked_at FROM devices WHERE kind = 'mobile' ORDER BY revoked_at NULLS FIRST, created_at DESC",
    );
    const now = Date.now();
    const eligible = [];
    for (const u of await this.latest(
      'user',
      '',
      [],
      "jsonb_build_object('name', payload->'name', 'role', payload->'role', 'store_id', payload->'store_id', 'active', payload->'active')",
    )) {
      if (u.payload['active'] === 0) continue;
      const role = str(u.payload['role']);
      if (await this.canCount(u.entity_id, role)) eligible.push({ id: u.entity_id, name: str(u.payload['name']), role, storeId: (u.payload['store_id'] as string | null) ?? null });
    }

    const { rows: guests } = await this.pg.query<GuestRow>('SELECT * FROM mobile_guests WHERE created_at > now() - interval \'7 days\' ORDER BY created_at DESC');
    const inventories = [];
    for (const inv of await this.openInventories()) {
      const lines = await this.lines(inv.id);
      const levels = await this.stockLevels(inv.warehouseId);
      const byDept = new Map<string, { id: string; name: string; total: number; counted: number }>();
      for (const l of lines.values()) {
        const deptId = articles.get(l.article_id)?.departmentId ?? '';
        const d = byDept.get(deptId) ?? { id: deptId, name: departments.get(deptId) || 'Sans rayon', total: 0, counted: 0 };
        d.total++;
        if (l.counted !== null) d.counted++;
        byDept.set(deptId, d);
      }
      // Compteurs : chaque saisie, sur un PC ou un téléphone, avec sa personne et son heure.
      const { rows: entries } = await this.pg.query<{ user_id: string; n: number; first: string; last: string }>(
        `SELECT COALESCE(payload->>'counter', payload->>'user_id') AS user_id, COUNT(DISTINCT payload->>'article_id')::int AS n, MIN(payload->>'at') AS first, MAX(payload->>'at') AS last
         FROM events WHERE entity = 'inventory_entry' AND payload->>'inventory_id' = $1 GROUP BY COALESCE(payload->>'counter', payload->>'user_id')`,
        [inv.id],
      );
      const { rows: phoneUsers } = await this.pg.query<{ user_id: string }>('SELECT DISTINCT user_id FROM mobile_counts WHERE inventory_id = $1', [inv.id]);
      const onPhone = new Set(phoneUsers.map((p) => p.user_id));
      const counters = entries
        .map((e) => {
          const hours = (Date.parse(e.last) - Date.parse(e.first)) / 3_600_000;
          return {
            userId: e.user_id,
            name: users.get(e.user_id) ?? '',
            products: e.n,
            first: e.first,
            last: e.last,
            perHour: hours >= 1 / 12 ? Math.round(e.n / hours) : null,
            phone: onPhone.has(e.user_id),
          };
        })
        .sort((a, b) => b.products - a.products);
      const { rows: assignments } = await this.pg.query<{ user_id: string; department_ids: string[] }>(
        'SELECT user_id, department_ids FROM mobile_assignments WHERE inventory_id = $1',
        [inv.id],
      );
      const recount = (await this.toRecount(inv.id, lines, levels)).map((r) => ({
        ...r,
        name: articles.get(r.articleId)?.name ?? '',
        unit: articles.get(r.articleId)?.unit ?? 'piece',
        byName: users.get(r.by) ?? '',
      }));
      const counted = [...lines.values()].filter((l) => l.counted !== null).length;
      inventories.push({
        id: inv.id,
        number: inv.number,
        label: inv.label,
        kind: inv.kind,
        storeId: inv.storeId,
        store: storeName.get(inv.storeId) ?? '',
        warehouse: warehouses.get(inv.warehouseId) ?? '',
        openedAt: inv.openedAt,
        inventoryDate: inv.inventoryDate,
        total: lines.size,
        counted,
        departments: [...byDept.values()].sort((a, b) => a.name.localeCompare(b.name, 'fr')),
        counters,
        assignments: assignments.map((a) => ({ userId: a.user_id, departmentIds: a.department_ids })),
        recount: settings.recount ? recount : [],
        guests: guests
          .filter((g) => g.inventory_id === inv.id)
          .map((g) => ({
            id: g.id,
            name: g.name,
            code: g.code,
            onBehalfOf: users.get(g.on_behalf_of) ?? '',
            expiresAt: g.expires_at,
            active: !g.revoked_at && new Date(g.expires_at).getTime() > now,
          })),
      });
    }

    const { rows: unknowns } = await this.pg.query<{
      id: string;
      inventory_id: string | null;
      code: string | null;
      note: string | null;
      qty: string | null;
      location: string | null;
      user_id: string;
      at: Date;
      has_photo: boolean;
    }>('SELECT id, inventory_id, code, note, qty, location, user_id, at, photo IS NOT NULL AS has_photo FROM mobile_unknowns WHERE done_at IS NULL ORDER BY at DESC LIMIT 200');
    return {
      settings,
      stores,
      devices: devices.map((d) => ({
        id: d.id,
        name: d.name,
        store: storeName.get(d.store_id) ?? '',
        createdAt: d.created_at,
        lastSeenAt: d.last_seen_at,
        online: !d.revoked_at && d.last_seen_at !== null && now - new Date(d.last_seen_at).getTime() < ONLINE_MS,
        revoked: d.revoked_at !== null,
      })),
      users: eligible.sort((a, b) => a.name.localeCompare(b.name, 'fr')),
      inventories,
      unknowns: unknowns.map((u) => ({
        id: u.id,
        inventoryId: u.inventory_id,
        code: u.code,
        note: u.note,
        qty: u.qty === null ? null : Number(u.qty),
        location: u.location,
        user: users.get(u.user_id) ?? '',
        at: u.at,
        hasPhoto: u.has_photo,
      })),
    };
  }

  async assign(input: { inventoryId: string; userId: string; departmentIds: string[] }) {
    const ids = Array.isArray(input?.departmentIds) ? input.departmentIds.filter((d) => typeof d === 'string').slice(0, 200) : null;
    if (!input?.inventoryId || !input.userId || !ids) throw new BadRequestException('Inventaire, compteur et rayons obligatoires');
    if (!ids.length) {
      await this.pg.query('DELETE FROM mobile_assignments WHERE inventory_id = $1 AND user_id = $2', [input.inventoryId, input.userId]);
    } else {
      await this.pg.query(
        'INSERT INTO mobile_assignments (inventory_id, user_id, department_ids) VALUES ($1, $2, $3) ON CONFLICT (inventory_id, user_id) DO UPDATE SET department_ids = excluded.department_ids',
        [input.inventoryId, input.userId, JSON.stringify(ids)],
      );
    }
    return { ok: true };
  }

  async unknownDone(id: string) {
    const { rows } = await this.pg.query('UPDATE mobile_unknowns SET done_at = now() WHERE id = $1 AND done_at IS NULL RETURNING id', [id]);
    if (!rows[0]) throw new NotFoundException('Relevé introuvable');
    return { ok: true };
  }

  async unknownPhoto(id: string): Promise<{ type: string; data: Buffer } | null> {
    const { rows } = await this.pg.query<{ photo: string | null }>('SELECT photo FROM mobile_unknowns WHERE id = $1', [id]);
    const m = /^data:(image\/[\w+.-]+);base64,(.+)$/.exec(rows[0]?.photo ?? '');
    return m ? { type: m[1]!, data: Buffer.from(m[2]!, 'base64') } : null;
  }

  async revoke(id: string) {
    const { rows } = await this.pg.query("UPDATE devices SET revoked_at = now() WHERE id = $1 AND kind = 'mobile' AND revoked_at IS NULL RETURNING id", [id]);
    if (!rows[0]) throw new NotFoundException('Téléphone introuvable ou déjà délié');
    await this.pg.query('DELETE FROM mobile_sessions WHERE device_id = $1', [id]);
    return { ok: true };
  }
}
