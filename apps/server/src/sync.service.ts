import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { CONFIG, type ServerConfig } from './config';
import { type Db, PG } from './database';
import { readLicense } from './license';

/** Données partagées entre tous les magasins ; le reste ne circule qu'à l'intérieur d'un magasin. */
export const GLOBAL_ENTITIES = [
  'vat_rate',
  'store',
  'warehouse',
  'register',
  'user',
  'department',
  'family',
  'article',
  'store_price',
  'supplier',
  'supplier_article',
  'customer',
  'account',
  'expense_category',
  'promotion',
  'role_rights',
  'user_rights',
  'rebate_rules',
  'recipe',
  // Stock de chaque dépôt, pour l'écran « Stock multi-magasin » de tous les magasins.
  'stock_level',
  // Points de fidélité : le client les gagne et les dépense dans tous les magasins.
  'loyalty_move',
  // Types d'emballages consignés (casiers, bouteilles) : les mêmes partout.
  'container',
  // Sociétés : elles regroupent des magasins.
  'company',
  // Demandes de marchandise d'un magasin à l'autre : vues par les deux magasins.
  'store_transfer_request',
  // Prix programmés : chaque magasin prépare ses étiquettes la veille.
  'price_schedule',
  // Commerciaux de terrain, codes de réduction et filtres de rapport : les mêmes dans tous les magasins.
  'field_rep',
  'promo_code',
  'report_preset',
];

export const KNOWN_ENTITIES = new Set([...GLOBAL_ENTITIES, 'lot', 'stock_movement', 'cash_session', 'cash_operation', 'sale', 'purchase_order', 'reception', 'supplier_invoice', 'supplier_payment', 'customer_payment', 'manual_entry', 'expense', 'quote', 'bank_line', 'tax_year', 'dsf_disclosure', 'charge_plan', 'central_cash_movement', 'emoney_movement', 'inventory', 'inventory_line', 'inventory_entry', 'transfer', 'stock_request', 'rebate_entry', 'production_order', 'staff', 'staff_salary', 'treasury_entry', 'sale_delivery', 'fiscal_year', 'customer_reminder', 'customer_order', 'sales_target', 'supplier_return', 'summary_invoice', 'cheque_deposit', 'budget', 'attendance', 'cash_handover', 'fixed_asset', 'opening_balance', 'container_move', 'agent_account', 'agent_operation', 'staff_leave', 'staff_schedule', 'cheque_rejection', 'courier_return', 'account_offset', 'payment_allocation', 'sale_edit_request', 'consignment_count', 'missed_sale', 'staff_agency', 'entrance', 'staff_team', 'time_punch', 'staff_document', 'fingerprint_device', 'staff_warning', 'staff_alert', 'gift_voucher', 'cash_alert', 'exit_check', 'lot_recall', 'recurring_order', 'expense_attachment', 'outage', 'stock_anomaly_decision']);

export interface SyncEvent {
  id: string;
  entity: string;
  entityId: string;
  op: 'upsert' | 'delete';
  storeId: string | null;
  registerId: string | null;
  createdAt: string;
  payload: Record<string, unknown> | null;
}

export interface Device {
  id: string;
  name: string;
  store_id: string;
  register_id: string;
}

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

@Injectable()
export class SyncService {
  constructor(
    @Inject(PG) private readonly pg: Db,
    @Inject(CONFIG) private readonly config: ServerConfig,
  ) {}

  /** Clé d'enrôlement : celle de la configuration, sinon celle créée au premier démarrage. */
  async enrollmentKey(): Promise<string> {
    if (this.config.enrollmentKey) return this.config.enrollmentKey;
    const { rows } = await this.pg.query<{ value: string }>("SELECT value FROM settings WHERE key = 'enrollment_key'");
    if (rows[0]) return rows[0].value;
    // Facile à recopier : pas de 0/O ni de 1/I/L.
    const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    const bytes = randomBytes(12);
    const key = Array.from(bytes, (b) => alphabet[b % alphabet.length])
      .join('')
      .replace(/(.{4})(?!$)/g, '$1-');
    await this.pg.query("INSERT INTO settings (key, value) VALUES ('enrollment_key', $1) ON CONFLICT (key) DO NOTHING", [key]);
    return this.enrollmentKey();
  }

  /** Nouvelle clé d'enrôlement (les PC déjà reliés ne sont pas touchés). */
  async renewEnrollmentKey(): Promise<string> {
    await this.pg.query("DELETE FROM settings WHERE key = 'enrollment_key'");
    return this.enrollmentKey();
  }

  /** Licence la plus récente reçue d'un PC, s'il y en a une. */
  async currentLicense(): Promise<{ key: string; stations: number } | null> {
    const { rows } = await this.pg.query<{ key: string; stations: number }>('SELECT key, stations FROM licenses ORDER BY issued DESC LIMIT 1');
    return rows[0] ?? null;
  }

  /** Un PC envoie la licence activée chez lui ; on rend la plus récente connue. */
  async uploadLicense(key: string): Promise<{ license: string | null }> {
    const lic = readLicense(key, this.config.licensePublicKey);
    if (!lic) throw new BadRequestException('Licence invalide');
    await this.pg.query(
      'INSERT INTO licenses (id, key, client, stations, issued) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (id) DO NOTHING',
      [lic.id, String(key).replace(/\s+/g, ''), lic.client, lic.stations, lic.issued],
    );
    return { license: (await this.currentLicense())?.key ?? null };
  }

  /** Avec une licence, le nombre de PC reliés ne dépasse pas celui qu'elle permet. */
  private async checkStations() {
    const license = await this.currentLicense();
    if (!license) return;
    const { rows } = await this.pg.query<{ n: string }>("SELECT COUNT(*) AS n FROM devices WHERE revoked_at IS NULL AND kind = 'pc'");
    if (Number(rows[0]!.n) >= license.stations) {
      throw new ForbiddenException(`La licence permet ${license.stations} PC : demandez une licence pour plus de postes.`);
    }
  }

  private async createDevice(name: string, storeId: string, registerId: string) {
    await this.checkStations();
    const id = randomUUID();
    const token = randomBytes(32).toString('base64url');
    try {
      await this.pg.query('INSERT INTO devices (id, name, store_id, register_id, token_hash) VALUES ($1, $2, $3, $4, $5)', [
        id,
        name,
        storeId,
        registerId,
        hashToken(token),
      ]);
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw new ConflictException('Cette caisse est déjà reliée à un autre PC');
      throw e;
    }
    return { deviceId: id, token, storeId, registerId };
  }

  /** Premier poste d'un magasin : rattaché avec la clé d'enrôlement du serveur. */
  async enroll(input: { enrollmentKey: string; storeId: string; registerId: string; name?: string }) {
    const typed = String(input.enrollmentKey ?? '').trim();
    // La clé créée par le serveur est en majuscules : on accepte qu'elle soit tapée en minuscules.
    const given = Buffer.from(this.config.enrollmentKey ? typed : typed.toUpperCase());
    const expected = Buffer.from(await this.enrollmentKey());
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new ForbiddenException("Clé d'enrôlement incorrecte");
    if (!input.storeId || !input.registerId) throw new BadRequestException('Magasin et caisse obligatoires');
    return this.createDevice(input.name?.trim() || 'Poste', input.storeId, input.registerId);
  }

  /** Nouveau PC : rattaché à une caisse déclarée dans l'administration, avec son code d'activation. */
  async activate(input: { activationCode: string; name?: string }) {
    const code = String(input.activationCode ?? '').trim();
    if (!/^\d{6}$/.test(code)) throw new BadRequestException("Code d'activation invalide");
    const { rows } = await this.pg.query<{ entity_id: string; payload: { store_id: string; activation_code: string; active: number } }>(
      `SELECT DISTINCT ON (entity_id) entity_id, payload FROM events
       WHERE entity = 'register' AND entity_id IN (
         SELECT entity_id FROM events WHERE entity = 'register' AND payload->>'activation_code' = $1)
       ORDER BY entity_id, seq DESC`,
      [code],
    );
    const register = rows.find((r) => r.payload.activation_code === code && r.payload.active !== 0);
    if (!register) throw new NotFoundException("Code d'activation inconnu. Vérifiez que le poste principal s'est bien synchronisé.");
    return this.createDevice(input.name?.trim() || 'Poste', register.payload.store_id, register.entity_id);
  }

  async authenticate(authorization: string | undefined, appVersion?: string): Promise<Device> {
    const token = authorization?.startsWith('Bearer ') ? authorization.slice(7) : null;
    if (!token) throw new UnauthorizedException('Jeton manquant');
    const { rows } = await this.pg.query<Device>(
      "UPDATE devices SET last_seen_at = now(), app_version = COALESCE($2, app_version) WHERE token_hash = $1 AND revoked_at IS NULL AND kind = 'pc' RETURNING id, name, store_id, register_id",
      [hashToken(token), /^\d+\.\d+\.\d+$/.test(appVersion ?? '') ? appVersion : null],
    );
    if (!rows[0]) throw new UnauthorizedException('Poste inconnu ou révoqué');
    return rows[0];
  }

  /** État du PC (sauvegarde, imprimante, envois en attente, licence), gardé pour l'écran « État des PC ». */
  async saveStatus(device: Device, status: unknown): Promise<{ ok: true }> {
    const text = JSON.stringify(status ?? null);
    if (!status || typeof status !== 'object' || text.length > 8000) throw new BadRequestException('État du poste invalide');
    await this.pg.query('UPDATE devices SET status = $2, status_at = now() WHERE id = $1', [device.id, text]);
    return { ok: true };
  }

  /** PC du magasin et leur dernier état connu. */
  async statuses(device: Device) {
    const { rows } = await this.pg.query<{ id: string; name: string; last_seen_at: Date | null; app_version: string | null; status: unknown }>(
      "SELECT id, name, last_seen_at, app_version, status FROM devices WHERE store_id = $1 AND revoked_at IS NULL AND kind = 'pc' ORDER BY name",
      [device.store_id],
    );
    return {
      devices: rows.map((r) => ({
        deviceId: r.id,
        name: r.name,
        lastSeenAt: r.last_seen_at ? new Date(r.last_seen_at).toISOString() : null,
        appVersion: r.app_version,
        status: typeof r.status === 'string' ? (JSON.parse(r.status) as unknown) : (r.status ?? null),
      })),
    };
  }

  /**
   * Enregistre les opérations d'un poste. Une opération déjà reçue est ignorée.
   * Une opération refusée (donnée qu'un serveur plus ancien ne connaît pas) ne
   * bloque pas les autres : elle reste en attente sur le PC jusqu'à la mise à jour du serveur.
   */
  async push(device: Device, events: SyncEvent[]): Promise<{ accepted: string[]; rejected: { id: string; reason: string }[] }> {
    if (!Array.isArray(events) || events.length > 2000) throw new BadRequestException('Lot d’opérations invalide (2000 maximum)');
    const valid: SyncEvent[] = [];
    const rejected: { id: string; reason: string }[] = [];
    for (const e of events) {
      if (typeof e?.id !== 'string' || typeof e.entityId !== 'string' || !['upsert', 'delete'].includes(e.op)) {
        throw new BadRequestException(`Opération invalide : ${JSON.stringify(e).slice(0, 200)}`);
      }
      if (KNOWN_ENTITIES.has(e.entity)) valid.push(e);
      else rejected.push({ id: e.id, reason: `Donnée inconnue du serveur : ${String(e.entity).slice(0, 50)}` });
    }
    await this.pg.transaction(async (tx) => {
      for (const e of valid) {
        await tx.query(
          `INSERT INTO events (id, device_id, entity, entity_id, op, store_id, register_id, payload, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (id) DO NOTHING`,
          [e.id, device.id, e.entity, e.entityId, e.op, e.storeId, e.registerId, e.payload === null ? null : JSON.stringify(e.payload), e.createdAt],
        );
      }
    });
    return { accepted: valid.map((e) => e.id), rejected };
  }

  /**
   * Identifiants que le serveur a pour une entité (partagée, ou du magasin du
   * poste) : le PC renvoie ce qui manque après une réinstallation du serveur.
   */
  async known(device: Device, entity: string): Promise<{ ids: string[] }> {
    if (!KNOWN_ENTITIES.has(entity)) throw new BadRequestException(`Entité inconnue : ${String(entity).slice(0, 50)}`);
    const global = GLOBAL_ENTITIES.includes(entity);
    const { rows } = await this.pg.query<{ entity_id: string }>(
      `SELECT DISTINCT entity_id FROM events WHERE entity = $1 ${global ? '' : 'AND (store_id = $2 OR store_id IS NULL)'}`,
      global ? [entity] : [entity, device.store_id],
    );
    return { ids: rows.map((r) => r.entity_id) };
  }

  /** Opérations des autres postes : données partagées + celles du magasin du poste. */
  async pull(device: Device, since: number, limit: number): Promise<{ events: SyncEvent[]; cursor: number; hasMore: boolean; license: string | null }> {
    const max = Math.min(Math.max(limit || 1000, 1), 5000);
    const { rows } = await this.pg.query<{
      seq: string;
      id: string;
      entity: string;
      entity_id: string;
      op: 'upsert' | 'delete';
      store_id: string | null;
      register_id: string | null;
      payload: Record<string, unknown> | null;
      created_at: Date;
      device_id: string;
    }>(
      `SELECT seq, id, entity, entity_id, op, store_id, register_id, payload, created_at, device_id FROM events
       WHERE seq > $1 AND (entity = ANY($2) OR store_id IS NULL OR store_id = $3)
       ORDER BY seq LIMIT $4`,
      [since || 0, GLOBAL_ENTITIES, device.store_id, max + 1],
    );
    const page = rows.slice(0, max);
    const cursor = page.length ? Number(page[page.length - 1]!.seq) : since || 0;
    return {
      // Les opérations du poste lui-même avancent le curseur sans lui être renvoyées.
      events: page
        .filter((r) => r.device_id !== device.id)
        .map((r) => ({
          id: r.id,
          entity: r.entity,
          entityId: r.entity_id,
          op: r.op,
          storeId: r.store_id,
          registerId: r.register_id,
          createdAt: r.created_at.toISOString(),
          payload: r.payload,
        })),
      cursor,
      hasMore: rows.length > max,
      // Licence du magasin : les PC où elle n'a pas été activée la reçoivent ainsi.
      license: (await this.currentLicense())?.key ?? null,
    };
  }
}
