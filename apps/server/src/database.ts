import { existsSync, renameSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { Pool, type PoolClient } from 'pg';

export const PG = Symbol('PG');

/** Requêtes SQL, sur PostgreSQL ou sur la base intégrée. */
export interface Queryable {
  query<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: R[] }>;
  /** Plusieurs instructions sans paramètres (migrations). */
  exec(sql: string): Promise<void>;
}

export interface Db extends Queryable {
  /** « postgres » : serveur PostgreSQL ; « integree » : base dans un dossier, sans rien installer. */
  readonly kind: 'postgres' | 'integree';
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
  /** Base intégrée seulement : copie complète, compressée. */
  dump?(): Promise<Buffer>;
  /** Base intégrée seulement : remplace toute la base par une copie. */
  load?(data: Buffer): Promise<void>;
}

class PostgresDb implements Db {
  readonly kind = 'postgres';
  constructor(private readonly pool: Pool) {}
  query<R>(sql: string, params?: unknown[]) {
    return this.pool.query(sql, params) as unknown as Promise<{ rows: R[] }>;
  }
  async exec(sql: string) {
    await this.pool.query(sql);
  }
  async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    const client: PoolClient = await this.pool.connect();
    const tx: Queryable = {
      query: (sql, params) => client.query(sql, params) as never,
      exec: async (sql) => void (await client.query(sql)),
    };
    try {
      await client.query('BEGIN');
      const result = await fn(tx);
      await client.query('COMMIT');
      return result;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }
  close() {
    return this.pool.end();
  }
}

/** PostgreSQL intégré (PGlite) : la base vit dans un dossier, le serveur s'installe sans PostgreSQL. */
class EmbeddedDb implements Db {
  readonly kind = 'integree';
  constructor(
    private pg: PGlite,
    private readonly dataDir: string,
  ) {}
  query<R>(sql: string, params?: unknown[]) {
    return this.pg.query<R>(sql, params) as Promise<{ rows: R[] }>;
  }
  async exec(sql: string) {
    await this.pg.exec(sql);
  }
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    return this.pg.transaction((t) =>
      fn({
        query: (sql, params) => t.query(sql, params) as never,
        exec: async (sql) => void (await t.exec(sql)),
      }),
    );
  }
  close() {
    return this.pg.close();
  }
  async dump(): Promise<Buffer> {
    const file = await this.pg.dumpDataDir('gzip');
    return Buffer.from(await file.arrayBuffer());
  }
  async load(data: Buffer): Promise<void> {
    const blob = new Blob([new Uint8Array(data)]);
    // La copie est d'abord ouverte à part : un fichier abîmé ne touche pas la base en service.
    const check = await PGlite.create({ loadDataDir: blob });
    try {
      await check.query('SELECT count(*) FROM events');
    } finally {
      await check.close();
    }
    await this.pg.close();
    // L'ancienne base est gardée à côté, renommée, au cas où.
    if (existsSync(this.dataDir)) renameSync(this.dataDir, `${this.dataDir}.avant-restauration-${Date.now()}`);
    this.pg = await PGlite.create({ dataDir: this.dataDir, loadDataDir: blob });
    await migrate(this);
  }
}

export async function openDb(config: { databaseUrl?: string; dataDir?: string }): Promise<Db> {
  const db = config.dataDir
    ? new EmbeddedDb(await PGlite.create({ dataDir: config.dataDir }), config.dataDir)
    : new PostgresDb(new Pool({ connectionString: config.databaseUrl }));
  await migrate(db);
  return db;
}

const MIGRATIONS: { version: number; sql: string }[] = [
  {
    version: 1,
    sql: `
CREATE TABLE devices (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL,
  store_id TEXT NOT NULL,
  register_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX one_active_device_per_register ON devices (register_id) WHERE revoked_at IS NULL;

-- Journal de toutes les opérations reçues des postes, dans l'ordre d'arrivée.
CREATE TABLE events (
  seq BIGSERIAL PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  device_id UUID NOT NULL REFERENCES devices(id),
  entity TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  op TEXT NOT NULL CHECK (op IN ('upsert', 'delete')),
  store_id TEXT,
  register_id TEXT,
  payload JSONB,
  created_at TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX events_entity ON events (entity, entity_id);
CREATE INDEX events_store ON events (store_id, seq);
CREATE INDEX events_activation_code ON events ((payload->>'activation_code')) WHERE entity = 'register';
`,
  },
  {
    version: 2,
    sql: `
-- Licences reçues des PC : la plus récente fixe le nombre de PC permis et part aux autres PC.
CREATE TABLE licenses (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL,
  client TEXT NOT NULL,
  stations INT NOT NULL,
  issued TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`,
  },
  {
    version: 3,
    sql: `
-- Réglages du serveur : clé d'enrôlement créée au premier démarrage, mot de passe de l'interface…
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE INDEX events_received ON events (received_at);
`,
  },
];

export async function migrate(db: Db): Promise<void> {
  await db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
  const { rows } = await db.query<{ version: number }>('SELECT version FROM schema_migrations');
  const applied = new Set(rows.map((r) => r.version));
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    await db.transaction(async (tx) => {
      await tx.exec(m.sql);
      await tx.query('INSERT INTO schema_migrations (version) VALUES ($1)', [m.version]);
    });
  }
}
