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

import { SYSCOHADA_SQL } from './syscohada';

export const MIGRATIONS: { version: number; name: string; sql: string; /** Reconstruit une table : clés étrangères suspendues le temps de la migration. */ rebuild?: boolean }[] = [
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
  {
    version: 6,
    name: 'dépenses',
    sql: `
INSERT OR IGNORE INTO accounts (id, label, role) VALUES
  ('6047', 'Fournitures de bureau', NULL),
  ('6081', 'Achats d''emballages (sacs, papier)', NULL),
  ('618', 'Autres frais de transport', NULL),
  ('624', 'Entretien, réparations et maintenance', NULL),
  ('638', 'Autres charges externes (gardiennage, nettoyage…)', NULL);

-- Catégories de dépenses : chacune passe sur un compte de charges (classe 6).
-- Identifiants fixes pour que tous les PC aient les mêmes catégories d'origine.
CREATE TABLE expense_categories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  active INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT ''
);
INSERT INTO expense_categories (id, name, account_id) VALUES
  ('cat-loyer', 'Loyer', '6222'),
  ('cat-eneo', 'Électricité et eau (ENEO, CDE)', '6052'),
  ('cat-telephone', 'Téléphone et internet', '6281'),
  ('cat-salaires', 'Salaires', '661'),
  ('cat-cnps', 'Cotisations CNPS', '664'),
  ('cat-transport', 'Transport et carburant', '618'),
  ('cat-emballages', 'Sacs et emballages', '6081'),
  ('cat-fournitures', 'Fournitures de bureau', '6047'),
  ('cat-entretien', 'Entretien et réparations', '624'),
  ('cat-gardiennage', 'Gardiennage et nettoyage', '638'),
  ('cat-impots', 'Impôts et taxes (patente, communales…)', '641'),
  ('cat-frais', 'Frais bancaires et Mobile Money', '631'),
  ('cat-divers', 'Divers', '658');

CREATE TABLE expenses (
  id TEXT PRIMARY KEY,
  number TEXT NOT NULL UNIQUE,
  store_id TEXT NOT NULL REFERENCES stores(id),
  category_id TEXT NOT NULL REFERENCES expense_categories(id),
  -- Compte de charges au moment de la dépense : changer la catégorie ne réécrit pas le passé.
  account_id TEXT NOT NULL,
  expense_date TEXT NOT NULL,
  label TEXT NOT NULL,
  beneficiary TEXT,
  amount INTEGER NOT NULL CHECK (amount > 0),
  vat INTEGER NOT NULL DEFAULT 0 CHECK (vat >= 0),
  method TEXT NOT NULL CHECK (method IN ('CASH', 'MTN_MOMO', 'ORANGE_MONEY', 'BANK_TRANSFER', 'CHEQUE', 'CARD')),
  reference TEXT,
  register_id TEXT,
  session_id TEXT,
  user_id TEXT,
  authorized_by TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cancelled')),
  cancel_reason TEXT,
  cancelled_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX expenses_date ON expenses(store_id, expense_date);
CREATE INDEX expenses_session ON expenses(session_id);
`,
  },
  {
    version: 7,
    name: 'devis et proformas',
    sql: `
CREATE TABLE quotes (
  id TEXT PRIMARY KEY,
  number TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('quote', 'proforma')),
  store_id TEXT NOT NULL REFERENCES stores(id),
  customer_id TEXT REFERENCES customers(id),
  -- Prospect sans fiche client : nom libre.
  customer_name TEXT,
  quote_date TEXT NOT NULL,
  valid_until TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'accepted', 'cancelled')),
  sale_id TEXT,
  total_ttc INTEGER NOT NULL,
  total_ht INTEGER NOT NULL,
  total_tva INTEGER NOT NULL,
  total_discount INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  user_id TEXT,
  discount_authorized_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX quotes_store ON quotes(store_id, quote_date);
CREATE TABLE quote_lines (
  id TEXT PRIMARY KEY,
  quote_id TEXT NOT NULL REFERENCES quotes(id),
  line_no INTEGER NOT NULL,
  article_id TEXT NOT NULL REFERENCES articles(id),
  label TEXT NOT NULL,
  qty INTEGER NOT NULL CHECK (qty > 0),
  unit_price INTEGER NOT NULL,
  discount INTEGER NOT NULL DEFAULT 0,
  vat_rate_bp INTEGER NOT NULL,
  total_ttc INTEGER NOT NULL
);
CREATE INDEX quote_lines_quote ON quote_lines(quote_id);
`,
  },
  {
    version: 8,
    name: 'rapprochement bancaire',
    sql: `
CREATE TABLE bank_lines (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL REFERENCES stores(id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  op_date TEXT NOT NULL,
  label TEXT NOT NULL,
  reference TEXT,
  -- Positif : argent reçu sur le compte ; négatif : argent sorti.
  amount INTEGER NOT NULL CHECK (amount <> 0),
  -- Empreinte de la ligne importée, pour ne pas l'importer deux fois.
  import_key TEXT NOT NULL,
  -- Ligne de comptabilité pointée (clé calculée par le rapprochement).
  match_key TEXT,
  matched_at TEXT,
  matched_by TEXT REFERENCES users(id),
  deleted INTEGER NOT NULL DEFAULT 0,
  user_id TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (store_id, account_id, import_key)
);
CREATE INDEX bank_lines_account ON bank_lines(store_id, account_id, op_date);
`,
  },
  {
    version: 9,
    name: 'impôt sur le résultat',
    sql: `
INSERT OR IGNORE INTO accounts (id, label, role) VALUES
  ('441', 'État, impôt sur les bénéfices', NULL),
  ('891', 'Impôts sur les bénéfices de l''exercice', NULL);

-- Paramètres fiscaux d'un exercice : forme (société à l'IS ou entreprise individuelle à l'IRPP),
-- régime, taux (si différents de ceux du CGI), réintégrations et déductions extra-comptables.
-- Identifiant fixe « magasin:année » pour que deux PC ne créent pas deux fiches.
CREATE TABLE tax_years (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL REFERENCES stores(id),
  year INTEGER NOT NULL,
  form TEXT NOT NULL DEFAULT 'company' CHECK (form IN ('company', 'individual')),
  regime TEXT NOT NULL DEFAULT 'reel' CHECK (regime IN ('reel', 'simplifie')),
  -- JSON : { isRate, reducedRate, minimumRate } en points de base, absents = taux du CGI.
  rates TEXT NOT NULL DEFAULT '{}',
  -- JSON : [{ kind: 'add' | 'deduct', label, amount }]
  adjustments TEXT NOT NULL DEFAULT '[]',
  -- Déficits des exercices antérieurs encore reportables.
  prior_losses INTEGER NOT NULL DEFAULT 0 CHECK (prior_losses >= 0),
  user_id TEXT REFERENCES users(id),
  updated_at TEXT NOT NULL,
  UNIQUE (store_id, year)
);
`,
  },
  {
    version: 10,
    name: 'notes déclaratives de la DSF',
    sql: `
-- Saisie des notes déclaratives d'un exercice (engagements, méthodes, associés, effectifs,
-- informations sociales), en JSON. Identifiant fixe « magasin:année », comme tax_years.
CREATE TABLE dsf_disclosures (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL REFERENCES stores(id),
  year INTEGER NOT NULL,
  data TEXT NOT NULL DEFAULT '{}',
  user_id TEXT REFERENCES users(id),
  updated_at TEXT NOT NULL,
  UNIQUE (store_id, year)
);
`,
  },
  {
    version: 11,
    name: 'promotions',
    sql: `
-- Promotions datées : prix promo, N achetés M payés, lot à prix fixe. store_id NULL = tous les magasins.
CREATE TABLE promotions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('price', 'x_for_y', 'lot')),
  article_id TEXT NOT NULL REFERENCES articles(id),
  store_id TEXT REFERENCES stores(id),
  starts_on TEXT NOT NULL,
  ends_on TEXT NOT NULL,
  promo_price INTEGER,
  buy_qty INTEGER,
  pay_qty INTEGER,
  lot_price INTEGER,
  active INTEGER NOT NULL DEFAULT 1,
  user_id TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX promotions_article ON promotions(article_id, starts_on, ends_on);

-- Économie accordée par la promotion sur la ligne (en plus de la remise manuelle).
ALTER TABLE sale_lines ADD COLUMN promo INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sale_lines ADD COLUMN promotion_id TEXT;
ALTER TABLE sales ADD COLUMN total_promo INTEGER NOT NULL DEFAULT 0;
`,
  },
  {
    version: 12,
    name: 'conditionnements',
    sql: `
-- Conditionnements d'un article, du plus grand (position 1) au plus petit : carton, paquet…
-- L'unité de détail est l'article lui-même ; units = unités de détail contenues (millièmes).
CREATE TABLE article_packs (
  id TEXT PRIMARY KEY,
  article_id TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  name TEXT NOT NULL,
  contains INTEGER NOT NULL,
  units INTEGER NOT NULL,
  sale_price INTEGER NOT NULL,
  wholesale_price INTEGER,
  super_wholesale_price INTEGER,
  barcode TEXT,
  is_purchase INTEGER NOT NULL DEFAULT 0,
  UNIQUE (article_id, position)
);
CREATE INDEX article_packs_barcode ON article_packs(barcode);

-- Unité de détail nommée (Ampoule, Bouteille) et tarifs gros / super gros de cette unité.
ALTER TABLE articles ADD COLUMN unit_name TEXT;
ALTER TABLE articles ADD COLUMN wholesale_price INTEGER;
ALTER TABLE articles ADD COLUMN super_wholesale_price INTEGER;

-- Tarif appliqué au client : détail, gros ou super gros.
ALTER TABLE customers ADD COLUMN price_level TEXT NOT NULL DEFAULT 'retail' CHECK (price_level IN ('retail', 'wholesale', 'super_wholesale'));

-- Ligne vendue par conditionnement, et tarif du ticket.
ALTER TABLE sale_lines ADD COLUMN pack_name TEXT;
ALTER TABLE sale_lines ADD COLUMN pack_units INTEGER;
ALTER TABLE sale_lines ADD COLUMN pack_price INTEGER;
ALTER TABLE sales ADD COLUMN price_level TEXT NOT NULL DEFAULT 'retail';
`,
  },
  {
    version: 13,
    name: 'etiquettes',
    sql: `
-- Dernier prix imprimé sur l'étiquette de chaque article (pack = '' pour l'unité,
-- sinon le nom du conditionnement) : sert à lister les étiquettes à refaire.
-- Propre au poste, comme l'imprimante : non synchronisé.
CREATE TABLE label_prints (
  store_id TEXT NOT NULL REFERENCES stores(id),
  article_id TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  pack TEXT NOT NULL DEFAULT '',
  price INTEGER NOT NULL,
  printed_at TEXT NOT NULL,
  PRIMARY KEY (store_id, article_id, pack)
);
`,
  },
  {
    version: 14,
    name: 'charges fixes',
    sql: `
-- Charges fixes prévues (loyer, ENEO, salaires…) : montant attendu, rythme et
-- jour d'échéance. Chaque échéance est « constatée » par la dépense qui la paie.
CREATE TABLE charge_plans (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL REFERENCES stores(id),
  category_id TEXT NOT NULL REFERENCES expense_categories(id),
  label TEXT NOT NULL,
  beneficiary TEXT,
  amount INTEGER NOT NULL CHECK (amount > 0),
  frequency TEXT NOT NULL CHECK (frequency IN ('monthly', 'quarterly', 'yearly')),
  due_day INTEGER NOT NULL CHECK (due_day BETWEEN 1 AND 28),
  start_month TEXT NOT NULL,
  end_month TEXT,
  method TEXT NOT NULL DEFAULT 'CASH',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX charge_plans_store ON charge_plans(store_id);

-- Échéance payée par la dépense : charge prévue et mois de l'échéance (AAAA-MM).
ALTER TABLE expenses ADD COLUMN plan_id TEXT REFERENCES charge_plans(id);
ALTER TABLE expenses ADD COLUMN plan_period TEXT;
CREATE INDEX expenses_plan ON expenses(plan_id, plan_period);
`,
  },
  {
    version: 15,
    name: 'fiche KONTROL',
    sql: `
-- Fiche article à la KONTROL : le conditionnement d'achat vient en tête (le plus
-- grand), avec son prix d'achat et son prix de revient exacts ; ceux des
-- conditionnements de vente s'en déduisent par le diviseur.
ALTER TABLE articles ADD COLUMN other_ref TEXT;
ALTER TABLE articles ADD COLUMN pack_purchase_price INTEGER;
ALTER TABLE articles ADD COLUMN pack_cost_price INTEGER;

-- Le conditionnement d'achat est désormais toujours le plus grand.
UPDATE article_packs SET is_purchase = CASE WHEN position = 1 THEN 1 ELSE 0 END;
UPDATE articles SET
  pack_purchase_price = purchase_price * COALESCE((SELECT units FROM article_packs p WHERE p.article_id = articles.id AND p.position = 1), 1000) / 1000,
  pack_cost_price = purchase_price * COALESCE((SELECT units FROM article_packs p WHERE p.article_id = articles.id AND p.position = 1), 1000) / 1000;
CREATE INDEX articles_other_ref ON articles(other_ref);
`,
  },
  {
    version: 16,
    name: 'client comptoir et droits',
    sql: `
-- Nom donné par un client comptoir (sans fiche client).
ALTER TABLE sales ADD COLUMN client_name TEXT;

-- Droits de chaque rôle (id = rôle), réglés par l'administrateur, qui a tous les droits.
-- rights : objet JSON { droit: true/false } ; un droit absent prend sa valeur par défaut.
CREATE TABLE role_rights (
  id TEXT PRIMARY KEY,
  rights TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`,
  },
  {
    version: 17,
    name: 'trésorerie des caisses, TVA facultative, rôles vendeur et appro',
    rebuild: true,
    sql: `
-- Rôles Vendeur (seller) et Responsable d'achat (buyer) : la contrainte du rôle
-- ne se modifie pas en SQLite, la table des utilisateurs est reconstruite.
CREATE TABLE users_new (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  login TEXT NOT NULL UNIQUE,
  pin_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'manager', 'cashier', 'seller', 'buyer', 'stock', 'accountant')),
  store_id TEXT REFERENCES stores(id),
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
INSERT INTO users_new (id, name, login, pin_hash, role, store_id, active, created_at)
  SELECT id, name, login, pin_hash, role, store_id, active, created_at FROM users;
DROP TABLE users;
ALTER TABLE users_new RENAME TO users;

-- Options du magasin : assujetti à la TVA (les magasins existants le restent),
-- vente sans stock autorisée (régularisée à la réception), seuil d'écart de caisse.
ALTER TABLE stores ADD COLUMN vat_enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE stores ADD COLUMN ignore_stock INTEGER NOT NULL DEFAULT 0;
ALTER TABLE stores ADD COLUMN cash_gap_threshold INTEGER NOT NULL DEFAULT 500;

-- Journée de caisse : qui a ouvert, fond repris de la veille, premier comptage
-- (comptage à l'aveugle), fond laissé dans le tiroir, versement à la centrale, motif d'écart.
ALTER TABLE cash_sessions ADD COLUMN carried_float INTEGER;
ALTER TABLE cash_sessions ADD COLUMN first_counted INTEGER;
ALTER TABLE cash_sessions ADD COLUMN float_left INTEGER;
ALTER TABLE cash_sessions ADD COLUMN deposit INTEGER;
ALTER TABLE cash_sessions ADD COLUMN gap_reason TEXT;
ALTER TABLE cash_sessions ADD COLUMN gap_approved_by TEXT;

-- Caisse centrale du magasin : reçoit la recette des caisses, donne les fonds,
-- dépose en banque. Les mouvements ne se modifient pas (une erreur se corrige
-- par un mouvement inverse). Sens : + entre dans la centrale, - en sort.
CREATE TABLE central_cash_movements (
  id TEXT PRIMARY KEY,
  number TEXT NOT NULL UNIQUE,
  store_id TEXT NOT NULL REFERENCES stores(id),
  kind TEXT NOT NULL CHECK (kind IN ('DEPOSIT', 'FLOAT', 'IN', 'OUT')),
  nature TEXT NOT NULL CHECK (nature IN ('register', 'bank', 'owner', 'other')),
  amount INTEGER NOT NULL CHECK (amount > 0),
  register_id TEXT,
  session_id TEXT,
  cash_operation_id TEXT,
  label TEXT NOT NULL,
  user_id TEXT,
  at TEXT NOT NULL
);
CREATE INDEX central_cash_store ON central_cash_movements(store_id, at);
CREATE INDEX central_cash_session ON central_cash_movements(session_id);

-- Paiements en espèces faits au bureau : ils sortent de (ou entrent dans) la caisse centrale.
ALTER TABLE expenses ADD COLUMN from_central INTEGER NOT NULL DEFAULT 0;
ALTER TABLE supplier_payments ADD COLUMN from_central INTEGER NOT NULL DEFAULT 0;
ALTER TABLE customer_payments ADD COLUMN from_central INTEGER NOT NULL DEFAULT 0;

INSERT OR IGNORE INTO accounts (id, label, role) VALUES
  ('5712', 'Caisse centrale', 'central_cash'),
  ('104', 'Compte de l''exploitant', 'owner');
-- Comptes déjà créés à la main : ils prennent le rôle s'il est libre.
UPDATE accounts SET role = 'central_cash' WHERE id = '5712' AND role IS NULL AND NOT EXISTS (SELECT 1 FROM accounts WHERE role = 'central_cash');
UPDATE accounts SET role = 'owner' WHERE id = '104' AND role IS NULL AND NOT EXISTS (SELECT 1 FROM accounts WHERE role = 'owner');
`,
  },
  {
    version: 18,
    name: 'caisse attribuée à chaque utilisateur',
    sql: `
-- Caisse de travail de l'utilisateur : ses ventes et sa journée de caisse s'y font, quel que soit le PC.
ALTER TABLE users ADD COLUMN register_id TEXT REFERENCES registers(id);
-- Caissiers déjà en place : on leur attribue la caisse de leur dernière vente, pour qu'ils continuent de vendre après la mise à jour.
UPDATE users SET register_id = (
  SELECT s.register_id FROM sales s JOIN registers r ON r.id = s.register_id
  WHERE s.user_id = users.id AND r.active = 1 ORDER BY s.created_at DESC LIMIT 1
) WHERE role IN ('cashier', 'seller');
`,
  },
  {
    version: 19,
    name: 'écart de clôture justifié après coup par le gérant',
    sql: `
-- Le caissier clôture sans code du gérant ; le gérant justifie l'écart ensuite, depuis son compte.
ALTER TABLE cash_sessions ADD COLUMN gap_justified_at TEXT;
UPDATE cash_sessions SET gap_justified_at = closed_at WHERE gap_reason IS NOT NULL;
`,
  },
  {
    version: 20,
    name: 'inventaires enregistrés (global ou partiel)',
    sql: `
-- Inventaire : la liste des produits est figée à l'ouverture, on saisit les quantités comptées
-- au fil de l'eau, puis la clôture corrige le stock (mouvements « Inventaire n° X »).
CREATE TABLE inventories (
  id TEXT PRIMARY KEY,
  number INTEGER NOT NULL,
  store_id TEXT NOT NULL REFERENCES stores(id),
  warehouse_id TEXT NOT NULL REFERENCES warehouses(id),
  kind TEXT NOT NULL CHECK (kind IN ('global', 'partial')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed', 'cancelled')),
  label TEXT,
  department_ids TEXT,
  -- Date d'inventaire : aujourd'hui, ou une date passée (fin d'exercice) à laquelle le stock est arrêté.
  inventory_date TEXT NOT NULL,
  backdated INTEGER NOT NULL DEFAULT 0,
  opened_at TEXT NOT NULL,
  opened_by TEXT NOT NULL REFERENCES users(id),
  closed_at TEXT,
  closed_by TEXT REFERENCES users(id),
  cancelled_at TEXT,
  cancelled_by TEXT REFERENCES users(id),
  counted_value INTEGER,
  gap_value INTEGER
);
CREATE TABLE inventory_lines (
  id TEXT PRIMARY KEY,
  inventory_id TEXT NOT NULL REFERENCES inventories(id) ON DELETE CASCADE,
  article_id TEXT NOT NULL REFERENCES articles(id),
  opening_qty INTEGER NOT NULL,
  counted INTEGER,
  counted_detail TEXT,
  counted_at TEXT,
  counted_by TEXT REFERENCES users(id),
  -- À la clôture : stock attendu à l'heure du comptage, écart et coût unitaire retenus.
  expected INTEGER,
  difference INTEGER,
  unit_cost INTEGER,
  UNIQUE (inventory_id, article_id)
);
-- Historique des saisies : qui a compté quoi et quand.
CREATE TABLE inventory_entries (
  id TEXT PRIMARY KEY,
  inventory_id TEXT NOT NULL REFERENCES inventories(id) ON DELETE CASCADE,
  article_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  counted INTEGER,
  at TEXT NOT NULL
);
CREATE INDEX inventory_entries_inventory ON inventory_entries(inventory_id, at);
`,
  },
  {
    version: 21,
    name: 'bons de transfert, demandes de correction de stock, ristournes',
    sql: `
-- Bon de transfert entre dépôts : brouillon, expédié (le stock quitte le départ), réceptionné.
CREATE TABLE transfers (
  id TEXT PRIMARY KEY,
  number INTEGER NOT NULL,
  store_id TEXT NOT NULL REFERENCES stores(id),
  from_warehouse_id TEXT NOT NULL REFERENCES warehouses(id),
  to_warehouse_id TEXT NOT NULL REFERENCES warehouses(id),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'shipped', 'received', 'cancelled')),
  label TEXT,
  route_number TEXT,
  reception_number TEXT,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  shipped_at TEXT,
  shipped_by TEXT REFERENCES users(id),
  printed_at TEXT,
  received_at TEXT,
  received_by TEXT REFERENCES users(id),
  cancelled_at TEXT,
  cancelled_by TEXT REFERENCES users(id)
);
CREATE TABLE transfer_lines (
  id TEXT PRIMARY KEY,
  transfer_id TEXT NOT NULL REFERENCES transfers(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  article_id TEXT NOT NULL REFERENCES articles(id),
  qty INTEGER NOT NULL CHECK (qty > 0),
  -- Conditionnement choisi à la saisie (affichage) : 0 = unité, sinon la position du conditionnement.
  pack_position INTEGER NOT NULL DEFAULT 0,
  received_qty INTEGER,
  unit_cost INTEGER,
  -- Lots sortis à l'expédition (numéro, péremption, date d'entrée), recréés à l'arrivée.
  lots TEXT
);
CREATE INDEX transfer_lines_transfer ON transfer_lines(transfer_id, position);

-- Demande de correction de stock : le magasinier propose, le gérant valide ou refuse.
CREATE TABLE stock_requests (
  id TEXT PRIMARY KEY,
  number INTEGER NOT NULL,
  store_id TEXT NOT NULL REFERENCES stores(id),
  warehouse_id TEXT NOT NULL REFERENCES warehouses(id),
  article_id TEXT NOT NULL REFERENCES articles(id),
  before_qty INTEGER NOT NULL,
  requested_qty INTEGER NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  requested_at TEXT NOT NULL,
  requested_by TEXT NOT NULL REFERENCES users(id),
  decided_at TEXT,
  decided_by TEXT REFERENCES users(id),
  decision_note TEXT,
  applied_delta INTEGER
);
CREATE INDEX stock_requests_article ON stock_requests(article_id, requested_at);

-- Ristournes : réglage de base (customer_id NULL) ou propre à un client, par famille (NULL = toutes).
ALTER TABLE customers ADD COLUMN rebate_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE customers ADD COLUMN rebate_delivered INTEGER NOT NULL DEFAULT 0;
CREATE TABLE rebate_rules (
  id TEXT PRIMARY KEY,
  customer_id TEXT REFERENCES customers(id),
  family_id TEXT REFERENCES families(id),
  rate_bp INTEGER NOT NULL DEFAULT 0 CHECK (rate_bp >= 0),
  unit_amount INTEGER NOT NULL DEFAULT 0 CHECK (unit_amount >= 0),
  min_qty INTEGER NOT NULL DEFAULT 0 CHECK (min_qty >= 0),
  pickup_fee INTEGER NOT NULL DEFAULT 0 CHECK (pickup_fee >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- Compte de ristourne du client : acquise (période constatée), régularisation, accordée en avoir ou en espèces.
CREATE TABLE rebate_entries (
  id TEXT PRIMARY KEY,
  number TEXT NOT NULL UNIQUE,
  store_id TEXT NOT NULL REFERENCES stores(id),
  customer_id TEXT NOT NULL REFERENCES customers(id),
  kind TEXT NOT NULL CHECK (kind IN ('earned', 'adjust', 'credit', 'cash')),
  amount INTEGER NOT NULL,
  period_from TEXT,
  period_to TEXT,
  label TEXT NOT NULL,
  at TEXT NOT NULL,
  user_id TEXT REFERENCES users(id)
);
CREATE INDEX rebate_entries_customer ON rebate_entries(customer_id, at);
INSERT OR IGNORE INTO accounts (id, label, role) VALUES ('4198', 'Clients, rabais, remises et ristournes à accorder', 'rebates_due');
INSERT OR IGNORE INTO accounts (id, label, role) VALUES ('7019', 'Rabais, remises et ristournes accordés', 'rebates');
UPDATE accounts SET role = 'rebates_due' WHERE id = '4198' AND role IS NULL AND NOT EXISTS (SELECT 1 FROM accounts WHERE role = 'rebates_due');
UPDATE accounts SET role = 'rebates' WHERE id = '7019' AND role IS NULL AND NOT EXISTS (SELECT 1 FROM accounts WHERE role = 'rebates');
`,
  },
  {
    version: 22,
    name: 'fabrication : recettes et ordres de fabrication',
    sql: `
-- Recette : un produit fini fait de composants, pour un lot de « yield_qty » unités.
CREATE TABLE recipes (
  id TEXT PRIMARY KEY,
  article_id TEXT NOT NULL REFERENCES articles(id),
  yield_qty INTEGER NOT NULL CHECK (yield_qty > 0),
  notes TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX recipes_article ON recipes(article_id);
CREATE TABLE recipe_lines (
  id TEXT PRIMARY KEY,
  recipe_id TEXT NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  article_id TEXT NOT NULL REFERENCES articles(id),
  qty INTEGER NOT NULL CHECK (qty > 0)
);
CREATE INDEX recipe_lines_recipe ON recipe_lines(recipe_id, position);
-- Ordre de fabrication : brouillon, puis fabriqué (composants sortis, produit entré au coût de revient).
CREATE TABLE production_orders (
  id TEXT PRIMARY KEY,
  number TEXT NOT NULL,
  store_id TEXT NOT NULL REFERENCES stores(id),
  warehouse_id TEXT NOT NULL REFERENCES warehouses(id),
  recipe_id TEXT NOT NULL REFERENCES recipes(id),
  article_id TEXT NOT NULL REFERENCES articles(id),
  qty INTEGER NOT NULL CHECK (qty > 0),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'done', 'cancelled')),
  label TEXT,
  expiry TEXT,
  -- Composants à la création (prévus), puis réellement sortis avec leur coût : [{article_id, qty, unit_cost}].
  components TEXT NOT NULL,
  unit_cost INTEGER,
  total_cost INTEGER,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  done_at TEXT,
  done_by TEXT REFERENCES users(id),
  cancelled_at TEXT,
  cancelled_by TEXT REFERENCES users(id)
);
CREATE INDEX production_orders_store ON production_orders(store_id, created_at);
`,
  },
  {
    version: 23,
    name: 'caisses espèces, électroniques et banque',
    sql: `
-- Type de caisse : espèces (tiroir), électronique (Mobile Money, carte) ou banque (virement, chèque).
ALTER TABLE registers ADD COLUMN kind TEXT NOT NULL DEFAULT 'cash' CHECK (kind IN ('cash', 'electronic', 'bank'));
-- Un caissier peut tenir une caisse de chaque type : register_id reste sa caisse espèces.
ALTER TABLE users ADD COLUMN emoney_register_id TEXT REFERENCES registers(id);
ALTER TABLE users ADD COLUMN bank_register_id TEXT REFERENCES registers(id);
-- Journée de caisse qui a reçu le paiement (caisse électronique ou banque) ; vide : celle du ticket.
ALTER TABLE sale_payments ADD COLUMN session_id TEXT;
CREATE INDEX sale_payments_session ON sale_payments(session_id);
`,
  },
  {
    version: 24,
    name: 'préférences des utilisateurs',
    sql: `
-- Préférences propres à chaque utilisateur sur ce PC : onglets rapides épinglés, dernière version vue.
CREATE TABLE user_prefs (
  user_id TEXT NOT NULL REFERENCES users(id),
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (user_id, key)
);
`,
  },
  {
    version: 25,
    name: 'droits détaillés, privilèges par utilisateur et paramètres du magasin',
    sql: `
-- Paramètres du magasin (ventes, crédit, stock, achats, sécurité, numérotation) : objet JSON.
ALTER TABLE stores ADD COLUMN settings TEXT;
-- Arrondi des espèces accordé sur le ticket (compris dans les remises).
ALTER TABLE sales ADD COLUMN rounding INTEGER NOT NULL DEFAULT 0;
-- Privilèges personnels : droits accordés en plus du rôle et droits retirés (listes JSON).
CREATE TABLE user_rights (
  id TEXT PRIMARY KEY REFERENCES users(id),
  grants TEXT NOT NULL DEFAULT '[]',
  revokes TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL
);
-- Codes faux de suite, sur ce PC : au-delà du maximum, l'utilisateur est bloqué un moment.
CREATE TABLE login_attempts (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  failures INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT
);
`,
  },
  {
    version: 26,
    name: 'sorties et versements des caisses électroniques',
    sql: `
-- Mouvement d'une caisse électronique hors ventes : versement de la recette vers la
-- centrale électronique (deposit), transfert entre caisses électroniques (register),
-- dépôt ou retrait en banque (bank), apport ou retrait de l'exploitant (owner), autre.
-- Un versement ou un transfert s'écrit en deux lignes : la sortie et l'entrée (counterpart_id).
CREATE TABLE emoney_movements (
  id TEXT PRIMARY KEY,
  number TEXT NOT NULL,
  store_id TEXT NOT NULL REFERENCES stores(id),
  register_id TEXT NOT NULL REFERENCES registers(id),
  session_id TEXT,
  method TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('IN', 'OUT')),
  nature TEXT NOT NULL CHECK (nature IN ('deposit', 'register', 'bank', 'owner', 'other')),
  amount INTEGER NOT NULL CHECK (amount > 0),
  reference TEXT,
  label TEXT NOT NULL,
  other_register_id TEXT,
  counterpart_id TEXT,
  user_id TEXT,
  at TEXT NOT NULL
);
CREATE INDEX emoney_movements_register ON emoney_movements(register_id, at);
CREATE INDEX emoney_movements_session ON emoney_movements(session_id);
-- Solde de départ d'une journée électronique, par moyen de paiement (JSON) : le reste laissé à la clôture d'avant.
ALTER TABLE cash_sessions ADD COLUMN opening_detail TEXT;
-- Règlement fournisseur payé par Mobile Money : il sort de cette caisse électronique (et de sa journée si elle est ouverte).
ALTER TABLE supplier_payments ADD COLUMN register_id TEXT;
ALTER TABLE supplier_payments ADD COLUMN session_id TEXT;
`,
  },
  {
    version: 27,
    name: 'ristournes payées par Mobile Money',
    sql: `
-- Ristourne payée : en espèces (caisse centrale) ou par MoMo/OM depuis une caisse électronique.
ALTER TABLE rebate_entries ADD COLUMN method TEXT NOT NULL DEFAULT 'CASH';
ALTER TABLE rebate_entries ADD COLUMN reference TEXT;
ALTER TABLE rebate_entries ADD COLUMN register_id TEXT;
ALTER TABLE rebate_entries ADD COLUMN session_id TEXT;
`,
  },
  {
    version: 28,
    name: 'collaborateurs, salaires, encaisser et décaisser',
    sql: `
-- Collaborateurs (employés, livreurs, gérants…) : chacun a deux sous-comptes de tiers,
-- ses rémunérations dues (4211…) et ses avances (4251…).
CREATE TABLE staff (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL REFERENCES stores(id),
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  position TEXT,
  phone TEXT,
  id_card TEXT,
  base_salary INTEGER NOT NULL DEFAULT 0 CHECK (base_salary >= 0),
  hired_on TEXT,
  user_id TEXT,
  salary_account TEXT NOT NULL,
  advance_account TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- Salaire du mois constaté : le brut au 661 contre le sous-compte du collaborateur,
-- les avances retenues passent de son compte d'avances à son compte de rémunérations.
CREATE TABLE staff_salaries (
  id TEXT PRIMARY KEY,
  number TEXT NOT NULL UNIQUE,
  store_id TEXT NOT NULL REFERENCES stores(id),
  staff_id TEXT NOT NULL REFERENCES staff(id),
  period TEXT NOT NULL,
  gross INTEGER NOT NULL CHECK (gross > 0),
  deducted INTEGER NOT NULL DEFAULT 0 CHECK (deducted >= 0),
  label TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cancelled')),
  cancel_reason TEXT,
  user_id TEXT,
  at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX staff_salaries_staff ON staff_salaries(staff_id, period);
-- Entrées et sorties saisies par « Encaisser » et « Décaisser » qui ne sont ni une vente,
-- ni un règlement client ou fournisseur, ni une dépense : avance, salaire ou remboursement
-- d'un collaborateur, remboursement d'un client, autre entrée ou sortie (compte choisi).
-- Faites à une caisse ouverte (session_id), au bureau en espèces (from_central) ou par MoMo/OM, banque.
CREATE TABLE treasury_entries (
  id TEXT PRIMARY KEY,
  number TEXT NOT NULL UNIQUE,
  store_id TEXT NOT NULL REFERENCES stores(id),
  direction TEXT NOT NULL CHECK (direction IN ('IN', 'OUT')),
  kind TEXT NOT NULL CHECK (kind IN ('staff_advance', 'staff_salary', 'staff_repayment', 'customer_refund', 'other')),
  amount INTEGER NOT NULL CHECK (amount > 0),
  method TEXT NOT NULL,
  reference TEXT,
  piece TEXT,
  label TEXT NOT NULL,
  party TEXT,
  staff_id TEXT,
  salary_id TEXT,
  customer_id TEXT,
  account_id TEXT,
  register_id TEXT,
  session_id TEXT,
  from_central INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cancelled')),
  cancel_reason TEXT,
  cancelled_by TEXT,
  authorized_by TEXT,
  printed INTEGER NOT NULL DEFAULT 0,
  user_id TEXT,
  at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX treasury_entries_session ON treasury_entries(session_id);
CREATE INDEX treasury_entries_staff ON treasury_entries(staff_id);
INSERT OR IGNORE INTO accounts (id, label, role) VALUES
  ('4251', 'Personnel, avances et acomptes', NULL),
  ('4711', 'Débiteurs et créditeurs divers (compte d''attente)', NULL);
`,
  },
  {
    version: 29,
    name: 'photo article, remises et promos à l’achat, facture directe, rattachement des collaborateurs',
    sql: `
-- Photo de l'article : l'image réduite (fiche, caisse) et sa miniature (listes). À part pour garder les listes légères.
CREATE TABLE article_photos (
  article_id TEXT PRIMARY KEY REFERENCES articles(id) ON DELETE CASCADE,
  photo TEXT NOT NULL,
  thumb TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- Remise en % (points de base) et unités gratuites (« N achetés, M payés ») de chaque ligne d'achat.
ALTER TABLE purchase_order_lines ADD COLUMN discount_bp INTEGER NOT NULL DEFAULT 0;
ALTER TABLE purchase_order_lines ADD COLUMN free_qty INTEGER NOT NULL DEFAULT 0;
ALTER TABLE purchase_order_lines ADD COLUMN promo_buy INTEGER;
ALTER TABLE purchase_order_lines ADD COLUMN promo_pay INTEGER;
-- Réception : unit_cost reste le coût net qui entre en stock ; gross_cost est le prix avant remises,
-- amount le montant HT net de la ligne (remise globale de la facture directe comprise).
ALTER TABLE reception_lines ADD COLUMN gross_cost INTEGER;
ALTER TABLE reception_lines ADD COLUMN discount_bp INTEGER NOT NULL DEFAULT 0;
ALTER TABLE reception_lines ADD COLUMN free_qty INTEGER NOT NULL DEFAULT 0;
ALTER TABLE reception_lines ADD COLUMN promo_buy INTEGER;
ALTER TABLE reception_lines ADD COLUMN promo_pay INTEGER;
ALTER TABLE reception_lines ADD COLUMN amount INTEGER;
-- Facture directe : saisie avec ses articles, sans bon de commande ; sa remise globale (HT).
ALTER TABLE supplier_invoices ADD COLUMN direct INTEGER NOT NULL DEFAULT 0;
ALTER TABLE supplier_invoices ADD COLUMN discount INTEGER NOT NULL DEFAULT 0;
ALTER TABLE receptions ADD COLUMN discount INTEGER NOT NULL DEFAULT 0;
-- Compte de rattachement du collaborateur : le compte parent de son sous-compte (4211 par défaut).
ALTER TABLE staff ADD COLUMN parent_account TEXT NOT NULL DEFAULT '4211';
INSERT OR IGNORE INTO accounts (id, label, role) VALUES
  ('4621', 'Associés, comptes courants', NULL);
`,
  },
  {
    version: 30,
    name: 'stock multi-magasin',
    sql: `
-- Stock des dépôts des autres magasins, reçu par la synchronisation (les mouvements, eux, restent dans leur magasin).
CREATE TABLE stock_levels (
  warehouse_id TEXT NOT NULL,
  article_id TEXT NOT NULL,
  qty INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (warehouse_id, article_id)
);
-- Dernier stock de ce magasin envoyé aux autres : seules les quantités qui ont changé repartent.
CREATE TABLE stock_published (
  warehouse_id TEXT NOT NULL,
  article_id TEXT NOT NULL,
  qty INTEGER NOT NULL,
  PRIMARY KEY (warehouse_id, article_id)
);
`,
  },
  {
    version: 31,
    name: 'livraisons, tarif et dépôt à la caisse',
    sql: `
-- Article de service (frais de livraison) : il se vend sans sortir de stock.
ALTER TABLE articles ADD COLUMN is_service INTEGER NOT NULL DEFAULT 0;
-- Dépôt d'où la vente est sortie (NULL : dépôt de vente du magasin, comme avant).
ALTER TABLE sales ADD COLUMN warehouse_id TEXT REFERENCES warehouses(id);
-- Livraison d'une vente chez le client : adresse, créneau, livreur, suivi.
CREATE TABLE sale_deliveries (
  id TEXT PRIMARY KEY,
  sale_id TEXT NOT NULL UNIQUE REFERENCES sales(id),
  store_id TEXT NOT NULL REFERENCES stores(id),
  address TEXT NOT NULL,
  phone TEXT,
  courier TEXT,
  slot TEXT,
  planned_date TEXT NOT NULL,
  fee INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'out', 'delivered', 'cancelled')),
  out_at TEXT,
  delivered_at TEXT,
  updated_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX sale_deliveries_day ON sale_deliveries(store_id, planned_date);
`,
  },
  {
    version: 32,
    name: 'plan SYSCOHADA complet, exercices comptables, correction des écritures, dépôts de vente par utilisateur',
    sql: `
-- Plan comptable SYSCOHADA révisé : les comptes manquants (les comptes déjà là gardent leur libellé et leur rôle).
${SYSCOHADA_SQL}
-- Exercices comptables : ouverts, puis clôturés (plus aucune écriture datée dedans, à-nouveaux générés).
-- Identifiant fixe « magasin:date de début » pour que deux PC ne créent pas deux fois le même exercice.
CREATE TABLE fiscal_years (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL REFERENCES stores(id),
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  result INTEGER,
  closed_at TEXT,
  closed_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX fiscal_years_store ON fiscal_years(store_id, start_date);
-- À-nouveaux générés par la clôture d'un exercice (identifiant de l'exercice clôturé).
ALTER TABLE manual_entries ADD COLUMN closing_of TEXT;
-- Écriture de correction d'une écriture automatique : « journal|date|pièce » de l'écriture corrigée.
ALTER TABLE manual_entries ADD COLUMN corrects TEXT;
ALTER TABLE manual_entries ADD COLUMN updated_at TEXT NOT NULL DEFAULT '';
-- Dépôts où l'utilisateur peut vendre (liste JSON d'identifiants ; NULL : le dépôt de vente seulement).
ALTER TABLE users ADD COLUMN sale_warehouses TEXT;
`,
  },
  {
    // 33 : la 32 est prise par le plan SYSCOHADA et les exercices (version 0.43).
    version: 33,
    name: 'impressions du ticket et de la facture',
    sql: `
-- Impressions déjà faites de chaque document de la vente : à partir de la deuxième, il porte « DUPLICATA ».
ALTER TABLE sales ADD COLUMN ticket_prints INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sales ADD COLUMN invoice_prints INTEGER NOT NULL DEFAULT 0;
`,
  },
  {
    version: 34,
    name: 'factures modifiées et masquées',
    sql: `
-- Facture modifiée : la nouvelle cite celle qu'elle remplace (annulée dans la même opération).
ALTER TABLE sales ADD COLUMN replaces_id TEXT REFERENCES sales(id);
-- « Supprimer » : facture annulée et masquée du registre (toujours visible avec le filtre Annulés et dans le journal).
ALTER TABLE sales ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;
`,
  },
  {
    version: 35,
    name: 'carte de fidélité',
    sql: `
-- Points de fidélité : chaque mouvement est gardé (gagnés, dépensés, annulés, corrigés) ;
-- le solde d'un client est leur somme. Communs à tous les magasins, comme les clients.
CREATE TABLE loyalty_moves (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id),
  store_id TEXT NOT NULL,
  sale_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('earn', 'redeem', 'cancel', 'return', 'adjust')),
  points INTEGER NOT NULL,
  reason TEXT,
  user_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX loyalty_moves_customer ON loyalty_moves(customer_id, created_at);
CREATE INDEX loyalty_moves_sale ON loyalty_moves(sale_id);
`,
  },
  {
    version: 36,
    name: 'relances des clients',
    sql: `
-- Relances envoyées aux clients en retard (WhatsApp) : date, auteur et montants du moment.
CREATE TABLE customer_reminders (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id),
  store_id TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('whatsapp', 'pdf')),
  balance INTEGER NOT NULL,
  overdue INTEGER NOT NULL,
  user_id TEXT,
  at TEXT NOT NULL
);
CREATE INDEX customer_reminders_customer ON customer_reminders(store_id, customer_id, at);
`,
  },
  {
    version: 37,
    name: 'retenues légales sur salaire',
    sql: `
-- Retenues légales du salaire (CNPS salariale ; IRPP, CAC, CFC, RAV, TDL) et charges patronales
-- (CNPS patronale ; CFC patronal et FNE), avec le détail ligne par ligne en JSON pour le bulletin.
ALTER TABLE staff_salaries ADD COLUMN cnps INTEGER NOT NULL DEFAULT 0;
ALTER TABLE staff_salaries ADD COLUMN tax INTEGER NOT NULL DEFAULT 0;
ALTER TABLE staff_salaries ADD COLUMN employer_social INTEGER NOT NULL DEFAULT 0;
ALTER TABLE staff_salaries ADD COLUMN employer_tax INTEGER NOT NULL DEFAULT 0;
ALTER TABLE staff_salaries ADD COLUMN payroll TEXT;
-- Collaborateur déclaré à la CNPS et aux impôts : ses salaires portent les retenues légales.
ALTER TABLE staff ADD COLUMN declared INTEGER NOT NULL DEFAULT 1;
ALTER TABLE staff ADD COLUMN cnps_number TEXT;
`,
  },
  {
    version: 38,
    name: 'paiement mobile automatique',
    sql: `
-- Demandes de paiement envoyées au téléphone du client (MTN MoMo, Orange Money), propres à ce poste.
CREATE TABLE mobile_payments (
  id TEXT PRIMARY KEY,
  method TEXT NOT NULL CHECK (method IN ('MTN_MOMO', 'ORANGE_MONEY')),
  mode TEXT NOT NULL,
  phone TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (amount > 0),
  currency TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'success', 'failed', 'cancelled')),
  provider_ref TEXT,
  transaction_id TEXT,
  reason TEXT,
  store_id TEXT,
  register_id TEXT,
  user_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX mobile_payments_store ON mobile_payments(store_id, created_at);
`,
  },
];
