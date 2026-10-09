import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import type { Db } from './database';

export type Clock = () => Date;

/** Poste courant : magasin, caisse et utilisateur connecté. */
export interface Context {
  storeId: string;
  registerId: string | null;
  userId: string;
}

export class AppError extends Error {
  constructor(
    message: string,
    readonly code: string = 'APP_ERROR',
  ) {
    super(message);
  }
}

export const newId = (): string => randomUUID();

export function hashPin(pin: string): string {
  if (!/^\d{4,8}$/.test(pin)) throw new AppError('Le code doit faire 4 à 8 chiffres', 'INVALID_PIN');
  const salt = randomBytes(16);
  const hash = scryptSync(pin, salt, 32);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPin(pin: string, stored: string): boolean {
  const [scheme, saltHex, hashHex] = stored.split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = scryptSync(pin, Buffer.from(saltHex, 'hex'), expected.length);
  return timingSafeEqual(actual, expected);
}

/** Services partagés : horloge, file d'envoi, journal d'audit, compteurs. */
export class Base {
  constructor(
    protected readonly db: Db,
    protected readonly clock: Clock = () => new Date(),
  ) {}

  protected now(): string {
    return this.clock().toISOString();
  }

  /** Date du jour à l'heure locale du poste (Africa/Douala sur les PC du magasin). */
  protected today(): string {
    const d = this.clock();
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  protected enqueue(
    ctx: Pick<Context, 'storeId' | 'registerId'> | null,
    entity: string,
    entityId: string,
    op: 'upsert' | 'delete',
    payload: unknown,
  ): void {
    this.db
      .prepare(
        `INSERT INTO outbox (id, entity, entity_id, op, payload, store_id, register_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(newId(), entity, entityId, op, JSON.stringify(payload), ctx?.storeId ?? null, ctx?.registerId ?? null, this.now());
  }

  protected audit(userId: string | null, action: string, entity?: string, entityId?: string, details?: unknown): void {
    this.db
      .prepare('INSERT INTO audit_log (id, user_id, action, entity, entity_id, details, at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(newId(), userId, action, entity ?? null, entityId ?? null, details === undefined ? null : JSON.stringify(details), this.now());
  }

  /** Porte un compteur au moins à `value` (numéros déjà attribués sur un autre PC). */
  protected raiseCounter(name: string, value: number): void {
    this.db
      .prepare('INSERT INTO counters (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = MAX(value, excluded.value)')
      .run(name, value);
  }

  protected nextCounter(name: string): number {
    const row = this.db
      .prepare('INSERT INTO counters (name, value) VALUES (?, 1) ON CONFLICT(name) DO UPDATE SET value = value + 1 RETURNING value')
      .get(name) as { value: number };
    return row.value;
  }

  /**
   * Préfixe propre à ce poste (code magasin + numéro de caisse), pour que
   * deux PC qui créent des fiches hors ligne ne produisent pas le même code.
   */
  protected stationPrefix(): string {
    const row = this.db
      .prepare(
        `SELECT s.code, r.number FROM settings k
         JOIN registers r ON r.id = k.value JOIN stores s ON s.id = r.store_id
         WHERE k.key = 'station.registerId'`,
      )
      .get() as { code: string; number: number } | undefined;
    return row ? `${row.code}${row.number}` : 'A';
  }

  protected tx<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }
}
