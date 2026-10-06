import { Pool } from 'pg';

export const PG = Symbol('PG');

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
];

export async function migrate(pool: Pool): Promise<void> {
  await pool.query('CREATE TABLE IF NOT EXISTS schema_migrations (version INT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
  const { rows } = await pool.query<{ version: number }>('SELECT version FROM schema_migrations');
  const applied = new Set(rows.map((r) => r.version));
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(m.sql);
      await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [m.version]);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }
}
