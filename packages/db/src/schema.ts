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
  {
    version: 3,
    name: 'fournisseurs et achats',
    sql: `
CREATE TABLE suppliers (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  contact TEXT,
  phone TEXT,
  email TEXT,
  address TEXT,
  taxpayer_number TEXT,
  payment_terms_days INTEGER NOT NULL DEFAULT 0,
  lead_time_days INTEGER NOT NULL DEFAULT 2,
  franco INTEGER,
  notes TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX suppliers_name ON suppliers(name);

-- Articles référencés chez un fournisseur : référence, prix négocié HT, colisage.
CREATE TABLE supplier_articles (
  id TEXT PRIMARY KEY,
  supplier_id TEXT NOT NULL REFERENCES suppliers(id),
  article_id TEXT NOT NULL REFERENCES articles(id),
  supplier_ref TEXT,
  unit_cost INTEGER NOT NULL DEFAULT 0,
  pack_qty INTEGER NOT NULL DEFAULT 1000,
  is_main INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  UNIQUE (supplier_id, article_id)
);
CREATE INDEX supplier_articles_article ON supplier_articles(article_id);

-- Bon de commande. « Partiellement reçu » et « reçu » se déduisent des réceptions.
CREATE TABLE purchase_orders (
  id TEXT PRIMARY KEY,
  number TEXT NOT NULL UNIQUE,
  store_id TEXT NOT NULL REFERENCES stores(id),
  warehouse_id TEXT NOT NULL REFERENCES warehouses(id),
  supplier_id TEXT NOT NULL REFERENCES suppliers(id),
  status TEXT NOT NULL CHECK (status IN ('draft', 'sent', 'closed', 'cancelled')),
  order_date TEXT NOT NULL,
  expected_date TEXT,
  notes TEXT,
  user_id TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX purchase_orders_supplier ON purchase_orders(supplier_id, order_date);

CREATE TABLE purchase_order_lines (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  line_no INTEGER NOT NULL,
  article_id TEXT NOT NULL REFERENCES articles(id),
  qty INTEGER NOT NULL,
  unit_cost INTEGER NOT NULL
);
CREATE INDEX purchase_order_lines_order ON purchase_order_lines(order_id);

-- Bon de réception (avec ou sans commande). Les mouvements de stock portent ref_type 'reception'.
CREATE TABLE receptions (
  id TEXT PRIMARY KEY,
  number TEXT NOT NULL UNIQUE,
  store_id TEXT NOT NULL REFERENCES stores(id),
  warehouse_id TEXT NOT NULL REFERENCES warehouses(id),
  supplier_id TEXT REFERENCES suppliers(id),
  order_id TEXT REFERENCES purchase_orders(id),
  delivery_note TEXT,
  invoice_id TEXT,
  user_id TEXT REFERENCES users(id),
  received_at TEXT NOT NULL
);
CREATE INDEX receptions_supplier ON receptions(supplier_id, received_at);
CREATE INDEX receptions_order ON receptions(order_id);

CREATE TABLE reception_lines (
  id TEXT PRIMARY KEY,
  reception_id TEXT NOT NULL REFERENCES receptions(id) ON DELETE CASCADE,
  line_no INTEGER NOT NULL,
  article_id TEXT NOT NULL REFERENCES articles(id),
  order_line_id TEXT,
  qty INTEGER NOT NULL,
  unit_cost INTEGER NOT NULL,
  vat_rate_bp INTEGER NOT NULL DEFAULT 0,
  lot_id TEXT,
  lot_number TEXT,
  expiry TEXT
);
CREATE INDEX reception_lines_reception ON reception_lines(reception_id);
CREATE INDEX reception_lines_order_line ON reception_lines(order_line_id);

-- Facture ou avoir fournisseur ; l'état payé se déduit des règlements.
CREATE TABLE supplier_invoices (
  id TEXT PRIMARY KEY,
  number TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('invoice', 'credit_note')),
  supplier_id TEXT NOT NULL REFERENCES suppliers(id),
  store_id TEXT NOT NULL REFERENCES stores(id),
  supplier_number TEXT NOT NULL,
  invoice_date TEXT NOT NULL,
  due_date TEXT NOT NULL,
  total_ht INTEGER NOT NULL,
  total_tva INTEGER NOT NULL,
  total_ttc INTEGER NOT NULL,
  received_ht INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  user_id TEXT REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE INDEX supplier_invoices_supplier ON supplier_invoices(supplier_id, invoice_date);
CREATE UNIQUE INDEX supplier_invoices_ref ON supplier_invoices(supplier_id, kind, supplier_number);

CREATE TABLE supplier_payments (
  id TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL REFERENCES supplier_invoices(id),
  supplier_id TEXT NOT NULL REFERENCES suppliers(id),
  store_id TEXT NOT NULL REFERENCES stores(id),
  method TEXT NOT NULL,
  amount INTEGER NOT NULL,
  reference TEXT,
  paid_at TEXT NOT NULL,
  user_id TEXT REFERENCES users(id)
);
CREATE INDEX supplier_payments_invoice ON supplier_payments(invoice_id);
`,
  },
  {
    version: 4,
    name: 'clients et ventes à crédit',
    sql: `
-- Fiche client, commune à tous les magasins ; le compte (ce que le client doit)
-- se calcule par magasin à partir des ventes à crédit et des règlements.
CREATE TABLE customers (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  contact TEXT,
  phone TEXT,
  email TEXT,
  address TEXT,
  taxpayer_number TEXT,
  credit_limit INTEGER NOT NULL DEFAULT 0 CHECK (credit_limit >= 0),
  payment_terms_days INTEGER NOT NULL DEFAULT 30,
  notes TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX customers_name ON customers(name);

ALTER TABLE sales ADD COLUMN customer_id TEXT REFERENCES customers(id);
ALTER TABLE sales ADD COLUMN due_date TEXT;
CREATE INDEX sales_customer ON sales(customer_id, created_at);

-- Règlement d'un client sur son compte. Encaissé à une caisse ouverte, il
-- entre dans le tiroir et apparaît sur le Z de la session.
CREATE TABLE customer_payments (
  id TEXT PRIMARY KEY,
  number TEXT NOT NULL UNIQUE,
  customer_id TEXT NOT NULL REFERENCES customers(id),
  store_id TEXT NOT NULL REFERENCES stores(id),
  register_id TEXT REFERENCES registers(id),
  session_id TEXT REFERENCES cash_sessions(id),
  method TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (amount > 0),
  reference TEXT,
  notes TEXT,
  paid_at TEXT NOT NULL,
  user_id TEXT REFERENCES users(id)
);
CREATE INDEX customer_payments_customer ON customer_payments(customer_id, paid_at);
CREATE INDEX customer_payments_session ON customer_payments(session_id);
`,
  },
  {
    version: 5,
    name: 'comptabilité SYSCOHADA',
    sql: `
-- Plan comptable (numéro de compte = identifiant). « role » désigne le compte
-- utilisé par les écritures automatiques (caisse, ventes, TVA…) : un seul compte par rôle.
CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  role TEXT UNIQUE,
  active INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT ''
);
INSERT INTO accounts (id, label, role) VALUES
  ('101', 'Capital social', NULL),
  ('121', 'Report à nouveau créditeur', NULL),
  ('129', 'Report à nouveau débiteur', NULL),
  ('131', 'Résultat net : bénéfice', NULL),
  ('139', 'Résultat net : perte', NULL),
  ('162', 'Emprunts auprès des établissements de crédit', NULL),
  ('2441', 'Matériel et mobilier de bureau', NULL),
  ('2451', 'Matériel de transport', NULL),
  ('311', 'Marchandises', 'stock'),
  ('401', 'Fournisseurs', 'suppliers'),
  ('411', 'Clients', 'customers'),
  ('4211', 'Personnel, rémunérations dues', NULL),
  ('4311', 'CNPS, sécurité sociale', NULL),
  ('4471', 'État, impôts retenus à la source', NULL),
  ('4191', 'Clients, avances reçues (bons d''achat)', 'voucher'),
  ('4431', 'État, TVA facturée sur ventes', 'vat_collected'),
  ('4441', 'État, TVA due', 'vat_due'),
  ('4449', 'État, crédit de TVA à reporter', 'vat_credit'),
  ('4452', 'État, TVA récupérable sur achats', 'vat_deductible'),
  ('521', 'Banques', 'bank'),
  ('5215', 'Banque, encaissements par carte', 'card'),
  ('5521', 'Monnaie électronique, MTN Mobile Money', 'mtn'),
  ('5522', 'Monnaie électronique, Orange Money', 'orange'),
  ('571', 'Caisse', 'cash'),
  ('585', 'Virements de fonds', 'transfer'),
  ('601', 'Achats de marchandises', 'purchases'),
  ('6031', 'Variations des stocks de marchandises', 'stock_variation'),
  ('6052', 'Eau et électricité', NULL),
  ('6222', 'Loyers des locaux', NULL),
  ('6281', 'Téléphone et internet', NULL),
  ('631', 'Frais bancaires et de Mobile Money', NULL),
  ('641', 'Impôts et taxes directs (patente…)', NULL),
  ('661', 'Rémunérations du personnel', NULL),
  ('664', 'Charges sociales', NULL),
  ('658', 'Charges diverses (manquants de caisse)', 'cash_short'),
  ('701', 'Ventes de marchandises', 'sales'),
  ('758', 'Produits divers (excédents de caisse)', 'cash_over');

-- Écritures saisies à la main (à-nouveaux, opérations diverses, frais bancaires…).
-- Les autres écritures se calculent à partir des tickets, factures et règlements.
CREATE TABLE manual_entries (
  id TEXT PRIMARY KEY,
  number TEXT NOT NULL UNIQUE,
  store_id TEXT NOT NULL REFERENCES stores(id),
  journal TEXT NOT NULL CHECK (journal IN ('AN', 'OD', 'BQ', 'CA', 'MM')),
  entry_date TEXT NOT NULL,
  label TEXT NOT NULL,
  user_id TEXT REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE INDEX manual_entries_date ON manual_entries(store_id, entry_date);
CREATE TABLE manual_entry_lines (
  id TEXT PRIMARY KEY,
  entry_id TEXT NOT NULL REFERENCES manual_entries(id),
  line_no INTEGER NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  aux TEXT,
  label TEXT,
  debit INTEGER NOT NULL DEFAULT 0,
  credit INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX manual_entry_lines_entry ON manual_entry_lines(entry_id);
`,
  },
];
