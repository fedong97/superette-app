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
  {
    version: 4,
    sql: `
-- Version de FEDONIX 360 de chaque PC, pour voir qui n'a pas encore pris la mise à jour.
ALTER TABLE devices ADD COLUMN app_version TEXT;
`,
  },
  {
    version: 5,
    sql: `
-- Téléphones d'inventaire (FEDONIX 360 Inventaire) : des postes à part, hors licence des PC,
-- qui ne lisent que le catalogue et les inventaires ouverts de leur magasin.
ALTER TABLE devices ADD COLUMN kind TEXT NOT NULL DEFAULT 'pc';
-- Code du QR affiché au gérant : une seule utilisation, valable 15 minutes.
CREATE TABLE mobile_pairings (
  code TEXT PRIMARY KEY,
  store_id TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ
);
-- Compteur connecté sur un téléphone avec son identifiant et son code.
CREATE TABLE mobile_sessions (
  token_hash TEXT PRIMARY KEY,
  device_id UUID NOT NULL REFERENCES devices(id),
  user_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ
);
-- Quantité comptée d'un produit à un endroit (rayon, réserve…) : la plus récente par endroit
-- l'emporte, le total des endroits part aux PC comme une saisie de l'inventaire.
CREATE TABLE mobile_counts (
  id TEXT PRIMARY KEY,
  device_id UUID NOT NULL REFERENCES devices(id),
  user_id TEXT NOT NULL,
  inventory_id TEXT NOT NULL,
  article_id TEXT NOT NULL,
  location TEXT NOT NULL,
  qty BIGINT,
  detail JSONB,
  counted_at TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX mobile_counts_article ON mobile_counts (inventory_id, article_id, location, counted_at);
-- Code-barres inconnu relevé pendant le comptage : photo et nom, l'article est créé ensuite sur un PC.
CREATE TABLE mobile_unknowns (
  id TEXT PRIMARY KEY,
  device_id UUID NOT NULL REFERENCES devices(id),
  user_id TEXT NOT NULL,
  inventory_id TEXT,
  code TEXT,
  note TEXT,
  qty BIGINT,
  location TEXT,
  photo TEXT,
  at TIMESTAMPTZ NOT NULL,
  done_at TIMESTAMPTZ
);
CREATE INDEX events_inventory ON events ((payload->>'inventory_id')) WHERE entity IN ('inventory_line', 'inventory_entry');
-- Rayons confiés à chaque compteur pour un inventaire.
CREATE TABLE mobile_assignments (
  inventory_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  department_ids JSONB NOT NULL,
  PRIMARY KEY (inventory_id, user_id)
);
`,
  },
  {
    version: 6,
    sql: `
-- Aide sans compte (famille, intérimaire…) : un code à 6 chiffres pour compter un seul
-- inventaire, 24 heures au plus. Ses comptages arrivent sur les PC au nom d'un responsable.
CREATE TABLE mobile_guests (
  id UUID PRIMARY KEY,
  store_id TEXT NOT NULL,
  inventory_id TEXT NOT NULL,
  name TEXT NOT NULL,
  code TEXT NOT NULL,
  on_behalf_of TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ
);
CREATE INDEX mobile_guests_code ON mobile_guests (code) WHERE revoked_at IS NULL;
`,
  },
  {
    version: 7,
    sql: `
-- Accord du gérant à distance : une caisse demande, le gérant accepte avec son code
-- sur son téléphone (ou refuse). La caisse lit la réponse une seule fois.
CREATE TABLE approvals (
  id UUID PRIMARY KEY,
  device_id UUID NOT NULL REFERENCES devices(id),
  store_id TEXT NOT NULL,
  register_id TEXT,
  action TEXT NOT NULL,
  requested_by TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  decided_by TEXT,
  decided_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at TIMESTAMPTZ,
  fetched_at TIMESTAMPTZ
);
CREATE INDEX approvals_pending ON approvals (created_at) WHERE status = 'pending';
-- Téléphones abonnés aux alertes (notifications du navigateur) et ce qu'ils veulent recevoir.
CREATE TABLE push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  kinds JSONB NOT NULL,
  discount_pct INT NOT NULL DEFAULT 20,
  origin TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`,
  },
  {
    version: 8,
    sql: `
-- Panier préparé au rayon par un vendeur sur son téléphone : la caisse du magasin le
-- charge (une seule fois) et la vente compte pour le vendeur.
CREATE TABLE shelf_carts (
  id TEXT PRIMARY KEY,
  device_id UUID NOT NULL REFERENCES devices(id),
  store_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  user_name TEXT NOT NULL,
  label TEXT,
  number INT NOT NULL,
  lines JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  taken_at TIMESTAMPTZ,
  taken_by UUID
);
CREATE INDEX shelf_carts_waiting ON shelf_carts (store_id, created_at) WHERE taken_at IS NULL;
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
