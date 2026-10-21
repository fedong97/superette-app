import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import type { Db } from './database';

export type Clock = () => Date;

/** Poste courant : magasin, caisse et utilisateur connecté. */
export interface Context {
  storeId: string;
  registerId: string | null;
  userId: string;
}

/**
 * Solution proposée avec un message d'erreur : un bouton qui ouvre l'écran
 * où se règle le problème, ou qui fait l'action tout de suite.
 */
export interface ErrorFix {
  label: string;
  /** Écran à ouvrir : fenêtre et onglet. */
  open?: [string, string?];
  /** Action à lancer (nom de l'action et ses arguments), puis l'opération est à refaire. */
  run?: { api: string; args: unknown[] };
}

export class AppError extends Error {
  constructor(
    message: string,
    readonly code: string = 'APP_ERROR',
    readonly fixes: ErrorFix[] = [],
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

  /**
   * Numéro de document propre à ce poste (« DLA11-4 ») : deux PC qui créent
   * un document en même temps ne prennent jamais le même numéro. La suite
   * reprend après les anciens numéros entiers du magasin.
   */
  protected docNumber(table: string, counter: string, storeId: string): string {
    const last = this.db.prepare(`SELECT MAX(number) FROM ${table} WHERE store_id = ? AND typeof(number) = 'integer'`).pluck().get(storeId) as number | null;
    if (last) this.raiseCounter(counter, last);
    return `${this.stationPrefix()}-${this.nextCounter(counter)}`;
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
  /**
   * Refuse une écriture datée dans un exercice clôturé : la clôture fige les
   * comptes et les à-nouveaux de l'exercice suivant. Il faut d'abord le rouvrir.
   */
  protected assertPeriodOpen(storeId: string, date: string): void {
    const closed = this.db
      .prepare("SELECT start_date, end_date FROM fiscal_years WHERE store_id = ? AND status = 'closed' AND start_date <= ? AND end_date >= ?")
      .get(storeId, date.slice(0, 10), date.slice(0, 10)) as { start_date: string; end_date: string } | undefined;
    if (closed) {
      const fr = (d: string) => d.split('-').reverse().join('/');
      throw new AppError(`L'exercice du ${fr(closed.start_date)} au ${fr(closed.end_date)} est clôturé : rouvrez-le d'abord (Comptabilité › Exercices)`, 'PERIOD_CLOSED');
    }
  }

  protected stationPrefix(): string {
    const row = this.db
      .prepare(
        `SELECT s.code, r.number FROM settings k
         JOIN registers r ON r.id = k.value JOIN stores s ON s.id = r.store_id
         WHERE k.key = 'station.registerId'`,
      )
      .get() as { code: string; number: number } | undefined;
    if (!row) return 'A';
    // Fiche d'intervention ou copie comptable : ses numéros ne croisent jamais ceux que la boutique crée pendant ce temps.
    const fiche = this.db.prepare("SELECT 1 FROM settings WHERE key = 'fiche.meta' AND json_extract(value, '$.kind') <> 'installation'").get();
    return `${row.code}${row.number}${fiche ? 'T' : ''}`;
  }

  protected tx<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }
}
