/**
 * Schéma de la base locale SQLite (une base par PC).
 *
 * Conventions :
 * - identifiants UUID texte, générés sur le poste, pour que les données de
 *   plusieurs magasins et caisses se fusionnent sans collision au serveur ;
 * - montants en FCFA entiers, quantités en millièmes (voir @superette/core) ;
 * - dates ISO 8601 en UTC ;
 * - chaque écriture métier ajoute une ligne dans `outbox`, la file d'envoi
 *   vers le serveur central (synchronisation en phase 1, étape suivante).
 */
export const MIGRATIONS: { version: number; name: string; sql: string }[] = [
  {
    version: 1,
    name: 'socle caisse et stock',
    sql: `
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE stores (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  address TEXT,
  phone TEXT,
  taxpayer_number TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE warehouses (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL REFERENCES stores(id),
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('shop', 'reserve', 'cold')),
  is_sales_default INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE registers (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL REFERENCES stores(id),
  number INTEGER NOT NULL,
  name TEXT NOT NULL,
  activation_code TEXT NOT NULL,
  activated_at TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  UNIQUE (store_id, number)
);

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  login TEXT NOT NULL UNIQUE,
  pin_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'manager', 'cashier', 'stock', 'accountant')),
  store_id TEXT REFERENCES stores(id),
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE vat_rates (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  rate_bp INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE departments (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE families (
  id TEXT PRIMARY KEY,
  department_id TEXT NOT NULL REFERENCES departments(id),
  name TEXT NOT NULL,
  UNIQUE (department_id, name)
);

CREATE TABLE articles (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  family_id TEXT REFERENCES families(id),
  brand TEXT,
  unit TEXT NOT NULL CHECK (unit IN ('piece', 'kg', 'litre')),
  vat_rate_id TEXT NOT NULL REFERENCES vat_rates(id),
  purchase_price INTEGER NOT NULL DEFAULT 0,
  sale_price INTEGER NOT NULL,
  perishable INTEGER NOT NULL DEFAULT 0,
  plu TEXT UNIQUE,
  quick_key INTEGER NOT NULL DEFAULT 0,
  min_qty INTEGER,
  alert_qty INTEGER,
  max_qty INTEGER,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX articles_name ON articles(name);

CREATE TABLE barcodes (
  code TEXT PRIMARY KEY,
  article_id TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  pack_qty INTEGER NOT NULL DEFAULT 1000
);
CREATE INDEX barcodes_article ON barcodes(article_id);

CREATE TABLE store_prices (
  article_id TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  store_id TEXT NOT NULL REFERENCES stores(id),
  sale_price INTEGER NOT NULL,
  PRIMARY KEY (article_id, store_id)
);

CREATE TABLE price_history (
  id TEXT PRIMARY KEY,
  article_id TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  store_id TEXT REFERENCES stores(id),
  old_price INTEGER,
  new_price INTEGER NOT NULL,
  user_id TEXT REFERENCES users(id),
  at TEXT NOT NULL
);

CREATE TABLE stock (
  article_id TEXT NOT NULL REFERENCES articles(id),
  warehouse_id TEXT NOT NULL REFERENCES warehouses(id),
  qty INTEGER NOT NULL DEFAULT 0,
  avg_cost INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (article_id, warehouse_id)
);

CREATE TABLE lots (
  id TEXT PRIMARY KEY,
  article_id TEXT NOT NULL REFERENCES articles(id),
  warehouse_id TEXT NOT NULL REFERENCES warehouses(id),
  lot_number TEXT,
  expiry TEXT,
  qty INTEGER NOT NULL,
  received_at TEXT NOT NULL
);
CREATE INDEX lots_article ON lots(article_id, warehouse_id);
CREATE INDEX lots_expiry ON lots(expiry) WHERE qty > 0;

CREATE TABLE stock_movements (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  article_id TEXT NOT NULL REFERENCES articles(id),
  warehouse_id TEXT NOT NULL REFERENCES warehouses(id),
  lot_id TEXT REFERENCES lots(id),
  qty INTEGER NOT NULL,
  unit_cost INTEGER NOT NULL,
  reason TEXT,
  ref_type TEXT,
  ref_id TEXT,
  user_id TEXT REFERENCES users(id),
  at TEXT NOT NULL
);
CREATE INDEX movements_article ON stock_movements(article_id, at);

CREATE TABLE cash_sessions (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL REFERENCES stores(id),
  register_id TEXT NOT NULL REFERENCES registers(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  opened_at TEXT NOT NULL,
  opening_float INTEGER NOT NULL,
  closed_at TEXT,
  closed_by TEXT REFERENCES users(id),
  counted_detail TEXT,
  expected_cash INTEGER,
  counted_cash INTEGER,
  difference INTEGER,
  z_number INTEGER,
  status TEXT NOT NULL CHECK (status IN ('open', 'closed'))
);
CREATE UNIQUE INDEX one_open_session_per_register ON cash_sessions(register_id) WHERE status = 'open';

CREATE TABLE cash_operations (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES cash_sessions(id),
  type TEXT NOT NULL CHECK (type IN ('IN', 'OUT')),
  amount INTEGER NOT NULL CHECK (amount > 0),
  reason TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  at TEXT NOT NULL
);

CREATE TABLE counters (
  name TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);

CREATE TABLE sales (
  id TEXT PRIMARY KEY,
  number TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('sale', 'return')),
  store_id TEXT NOT NULL REFERENCES stores(id),
  register_id TEXT NOT NULL REFERENCES registers(id),
  session_id TEXT NOT NULL REFERENCES cash_sessions(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  status TEXT NOT NULL CHECK (status IN ('completed', 'cancelled')),
  total_ttc INTEGER NOT NULL,
  total_ht INTEGER NOT NULL,
  total_tva INTEGER NOT NULL,
  total_discount INTEGER NOT NULL,
  change_given INTEGER NOT NULL DEFAULT 0,
  original_sale_id TEXT REFERENCES sales(id),
  cancelled_by TEXT REFERENCES users(id),
  cancel_reason TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX sales_session ON sales(session_id);
CREATE INDEX sales_date ON sales(store_id, created_at);

CREATE TABLE sale_lines (
  id TEXT PRIMARY KEY,
  sale_id TEXT NOT NULL REFERENCES sales(id),
  line_no INTEGER NOT NULL,
  article_id TEXT NOT NULL REFERENCES articles(id),
  label TEXT NOT NULL,
  barcode TEXT,
  qty INTEGER NOT NULL,
  unit_price INTEGER NOT NULL,
  discount INTEGER NOT NULL DEFAULT 0,
  vat_rate_bp INTEGER NOT NULL,
  total_ttc INTEGER NOT NULL,
  unit_cost INTEGER NOT NULL
);
CREATE INDEX sale_lines_sale ON sale_lines(sale_id);

CREATE TABLE sale_payments (
  id TEXT PRIMARY KEY,
  sale_id TEXT NOT NULL REFERENCES sales(id),
  method TEXT NOT NULL,
  amount INTEGER NOT NULL,
  reference TEXT
);
CREATE INDEX sale_payments_sale ON sale_payments(sale_id);

CREATE TABLE held_tickets (
  id TEXT PRIMARY KEY,
  register_id TEXT NOT NULL REFERENCES registers(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  label TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id),
  action TEXT NOT NULL,
  entity TEXT,
  entity_id TEXT,
  details TEXT,
  at TEXT NOT NULL
);

CREATE TABLE outbox (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  entity TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  op TEXT NOT NULL,
  payload TEXT NOT NULL,
  store_id TEXT,
  register_id TEXT,
  created_at TEXT NOT NULL,
  sent_at TEXT
);
CREATE INDEX outbox_pending ON outbox(seq) WHERE sent_at IS NULL;
`,
  },
  {
    version: 2,
    name: 'synchronisation avec le serveur central',
    sql: `
CREATE TABLE sync_conflicts (
  id TEXT PRIMARY KEY,
  entity TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  message TEXT NOT NULL,
  payload TEXT,
  at TEXT NOT NULL
);
CREATE INDEX movements_lot ON stock_movements(lot_id);
CREATE INDEX movements_article_warehouse ON stock_movements(article_id, warehouse_id);

-- Données créées avant la synchronisation et absentes de la file d'envoi.
INSERT INTO outbox (id, entity, entity_id, op, payload, store_id, register_id, created_at)
  SELECT lower(hex(randomblob(16))), 'vat_rate', id, 'upsert', '{}', NULL, NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM vat_rates;
INSERT INTO outbox (id, entity, entity_id, op, payload, store_id, register_id, created_at)
  SELECT lower(hex(randomblob(16))), 'lot', l.id, 'upsert', '{}', w.store_id, NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM lots l JOIN warehouses w ON w.id = l.warehouse_id;
INSERT INTO outbox (id, entity, entity_id, op, payload, store_id, register_id, created_at)
  SELECT lower(hex(randomblob(16))), 'user', u.id, 'upsert', '{}', NULL, NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM users u WHERE NOT EXISTS (SELECT 1 FROM outbox o WHERE o.entity = 'user' AND o.entity_id = u.id);
`,
  },
];
