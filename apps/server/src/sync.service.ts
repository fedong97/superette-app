import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import type { Pool } from 'pg';
import { CONFIG, type ServerConfig } from './config';
import { PG } from './database';

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
];

const KNOWN_ENTITIES = new Set([...GLOBAL_ENTITIES, 'lot', 'stock_movement', 'cash_session', 'cash_operation', 'sale', 'purchase_order', 'reception', 'supplier_invoice', 'supplier_payment']);

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
    @Inject(PG) private readonly pg: Pool,
    @Inject(CONFIG) private readonly config: ServerConfig,
  ) {}

  private async createDevice(name: string, storeId: string, registerId: string) {
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
    const given = Buffer.from(String(input.enrollmentKey ?? ''));
    const expected = Buffer.from(this.config.enrollmentKey);
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

  async authenticate(authorization: string | undefined): Promise<Device> {
    const token = authorization?.startsWith('Bearer ') ? authorization.slice(7) : null;
    if (!token) throw new UnauthorizedException('Jeton manquant');
    const { rows } = await this.pg.query<Device>(
      'UPDATE devices SET last_seen_at = now() WHERE token_hash = $1 AND revoked_at IS NULL RETURNING id, name, store_id, register_id',
      [hashToken(token)],
    );
    if (!rows[0]) throw new UnauthorizedException('Poste inconnu ou révoqué');
    return rows[0];
  }

  /** Enregistre les opérations d'un poste. Une opération déjà reçue est ignorée. */
  async push(device: Device, events: SyncEvent[]): Promise<{ accepted: string[] }> {
    if (!Array.isArray(events) || events.length > 2000) throw new BadRequestException('Lot d’opérations invalide (2000 maximum)');
    for (const e of events) {
      if (typeof e?.id !== 'string' || typeof e.entityId !== 'string' || !KNOWN_ENTITIES.has(e.entity) || !['upsert', 'delete'].includes(e.op)) {
        throw new BadRequestException(`Opération invalide : ${JSON.stringify(e).slice(0, 200)}`);
      }
    }
    const client = await this.pg.connect();
    try {
      await client.query('BEGIN');
      for (const e of events) {
        await client.query(
          `INSERT INTO events (id, device_id, entity, entity_id, op, store_id, register_id, payload, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (id) DO NOTHING`,
          [e.id, device.id, e.entity, e.entityId, e.op, e.storeId, e.registerId, e.payload === null ? null : JSON.stringify(e.payload), e.createdAt],
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    return { accepted: events.map((e) => e.id) };
  }

  /** Opérations des autres postes : données partagées + celles du magasin du poste. */
  async pull(device: Device, since: number, limit: number): Promise<{ events: SyncEvent[]; cursor: number; hasMore: boolean }> {
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
    };
  }
}
