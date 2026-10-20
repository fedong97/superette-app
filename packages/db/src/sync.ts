import type { Db } from './database';
import type { StockService } from './stock';
import { Base, type Clock, newId } from './util';

/** Une opération échangée avec le serveur central. */
export interface SyncEvent {
  /** Identifiant unique de l'opération (rejouer deux fois ne crée pas de doublon). */
  id: string;
  entity: string;
  entityId: string;
  op: 'upsert' | 'delete';
  storeId: string | null;
  registerId: string | null;
  createdAt: string;
  payload: Record<string, unknown> | null;
}

export interface SyncState {
  url: string | null;
  deviceId: string | null;
  connected: boolean;
  cursor: number;
  pending: number;
  conflicts: number;
  lastSyncAt: string | null;
  lastError: string | null;
}

/** Entités stockées telles quelles dans une table (clé `id`). */
const TABLES: Record<string, string> = {
  vat_rate: 'vat_rates',
  store: 'stores',
  warehouse: 'warehouses',
  register: 'registers',
  user: 'users',
  attendance: 'attendance',
  cash_handover: 'cash_handovers',
  department: 'departments',
  family: 'families',
  lot: 'lots',
  stock_movement: 'stock_movements',
  cash_session: 'cash_sessions',
  cash_operation: 'cash_operations',
  supplier: 'suppliers',
  supplier_article: 'supplier_articles',
  supplier_invoice: 'supplier_invoices',
  supplier_payment: 'supplier_payments',
  customer: 'customers',
  customer_payment: 'customer_payments',
  account: 'accounts',
  expense_category: 'expense_categories',
  expense: 'expenses',
  bank_line: 'bank_lines',
  tax_year: 'tax_years',
  dsf_disclosure: 'dsf_disclosures',
  promotion: 'promotions',
  charge_plan: 'charge_plans',
  role_rights: 'role_rights',
  user_rights: 'user_rights',
  central_cash_movement: 'central_cash_movements',
  emoney_movement: 'emoney_movements',
  inventory_entry: 'inventory_entries',
  rebate_entry: 'rebate_entries',
  staff: 'staff',
  staff_salary: 'staff_salaries',
  treasury_entry: 'treasury_entries',
  sale_delivery: 'sale_deliveries',
  fiscal_year: 'fiscal_years',
  loyalty_move: 'loyalty_moves',
  customer_reminder: 'customer_reminders',
  opening_balance: 'opening_balances',
  fixed_asset: 'fixed_assets',
  sales_target: 'sales_targets',
  summary_invoice: 'summary_invoices',
  budget: 'budgets',
};

/** Entités qui ne changent plus une fois créées : un doublon reçu est ignoré. */
const IMMUTABLE = new Set(['stock_movement', 'cash_operation', 'supplier_payment', 'customer_payment', 'central_cash_movement', 'emoney_movement', 'inventory_entry', 'rebate_entry', 'loyalty_move', 'customer_reminder', 'opening_balance']);

/** Ordre des statuts : une version plus ancienne reçue d'un autre PC ne fait jamais reculer un document. */
const STATUS_RANK: Record<string, Record<string, number>> = {
  // Annulé est définitif : un transfert réceptionné puis annulé ne redevient pas réceptionné.
  transfers: { draft: 0, shipped: 1, received: 2, cancelled: 3 },
  inventories: { open: 0, closed: 1, cancelled: 1 },
  stock_requests: { pending: 0, approved: 1, rejected: 1 },
  production_orders: { draft: 0, done: 1, cancelled: 1 },
  sale_deliveries: { pending: 0, out: 1, delivered: 2, cancelled: 2 },
  supplier_returns: { open: 0, credited: 1 },
  summary_invoices: { active: 0, cancelled: 1 },
  cheque_deposits: { active: 0, cancelled: 1 },
};

/** Documents avec lignes : l'en-tête et ses lignes voyagent ensemble. */
const WITH_LINES: Record<string, { table: string; lines: string; fk: string }> = {
  purchase_order: { table: 'purchase_orders', lines: 'purchase_order_lines', fk: 'order_id' },
  reception: { table: 'receptions', lines: 'reception_lines', fk: 'reception_id' },
  manual_entry: { table: 'manual_entries', lines: 'manual_entry_lines', fk: 'entry_id' },
  quote: { table: 'quotes', lines: 'quote_lines', fk: 'quote_id' },
  customer_order: { table: 'customer_orders', lines: 'customer_order_lines', fk: 'order_id' },
  supplier_return: { table: 'supplier_returns', lines: 'supplier_return_lines', fk: 'return_id' },
  cheque_deposit: { table: 'cheque_deposits', lines: 'cheque_deposit_lines', fk: 'deposit_id' },
};

/**
 * Données qu'un serveur doit avoir pour que les autres PC et les téléphones
 * voient le magasin, dans l'ordre des dépendances. Un serveur réinstallé, ou
 * une base restaurée depuis une sauvegarde, peut ne pas les avoir alors que la
 * file d'envoi du PC est vide : elles sont renvoyées (voir `resendTargets`).
 */
const RESEND: { entity: string; ids: string; store?: boolean }[] = [
  { entity: 'vat_rate', ids: 'SELECT id FROM vat_rates' },
  { entity: 'store', ids: 'SELECT id FROM stores' },
  { entity: 'warehouse', ids: 'SELECT id FROM warehouses' },
  { entity: 'register', ids: 'SELECT id FROM registers' },
  { entity: 'user', ids: 'SELECT id FROM users' },
  { entity: 'role_rights', ids: 'SELECT id FROM role_rights' },
  { entity: 'user_rights', ids: 'SELECT id FROM user_rights' },
  { entity: 'department', ids: 'SELECT id FROM departments' },
  { entity: 'family', ids: 'SELECT id FROM families' },
  { entity: 'article', ids: 'SELECT id FROM articles' },
  { entity: 'store_price', ids: "SELECT article_id || ':' || store_id FROM store_prices" },
  { entity: 'supplier', ids: 'SELECT id FROM suppliers' },
  { entity: 'supplier_article', ids: 'SELECT id FROM supplier_articles' },
  { entity: 'customer', ids: 'SELECT id FROM customers' },
  { entity: 'account', ids: 'SELECT id FROM accounts' },
  { entity: 'expense_category', ids: 'SELECT id FROM expense_categories' },
  { entity: 'promotion', ids: 'SELECT id FROM promotions' },
  { entity: 'rebate_rules', ids: "SELECT DISTINCT COALESCE(customer_id, 'base') FROM rebate_rules" },
  { entity: 'recipe', ids: 'SELECT id FROM recipes' },
  { entity: 'stock_level', ids: "SELECT s.warehouse_id || ':' || s.article_id FROM stock s JOIN warehouses w ON w.id = s.warehouse_id WHERE w.store_id = ?", store: true },
  { entity: 'inventory', ids: 'SELECT id FROM inventories WHERE store_id = ?', store: true },
];

/**
 * Synchronisation avec le serveur central, côté poste.
 *
 * - Envoi : chaque ligne de la file `outbox` part avec l'état actuel de
 *   l'entité, relu en base au moment de l'envoi (lignes complètes).
 * - Réception : les opérations des autres postes sont appliquées sans
 *   repasser par la file d'envoi. Le stock n'est jamais copié : il est
 *   recalculé à partir des mouvements, ce qui donne le même résultat sur
 *   toutes les caisses, quel que soit l'ordre d'arrivée.
 */
export class SyncService extends Base {
  private columns = new Map<string, Set<string>>();

  constructor(
    db: Db,
    clock: Clock,
    private readonly stock: StockService,
  ) {
    super(db, clock);
  }

  // --- État et paramètres -----------------------------------------------------

  private get(key: string): string | null {
    return (this.db.prepare('SELECT value FROM settings WHERE key = ?').pluck().get(key) as string | undefined) ?? null;
  }

  private set(key: string, value: string | null): void {
    if (value === null) this.db.prepare('DELETE FROM settings WHERE key = ?').run(key);
    else this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  state(): SyncState {
    return {
      url: this.get('sync.url'),
      deviceId: this.get('sync.deviceId'),
      connected: Boolean(this.get('sync.token')),
      cursor: Number(this.get('sync.cursor') ?? 0),
      pending: this.db.prepare('SELECT COUNT(*) FROM outbox WHERE sent_at IS NULL').pluck().get() as number,
      conflicts: this.db.prepare('SELECT COUNT(*) FROM sync_conflicts').pluck().get() as number,
      lastSyncAt: this.get('sync.lastSyncAt'),
      lastError: this.get('sync.lastError'),
    };
  }

  credentials(): { url: string; token: string } | null {
    const url = this.get('sync.url');
    const token = this.get('sync.token');
    return url && token ? { url, token } : null;
  }

  saveCredentials(url: string, deviceId: string, token: string): void {
    this.set('sync.url', url.replace(/\/+$/, ''));
    this.set('sync.deviceId', deviceId);
    this.set('sync.token', token);
  }

  disconnect(): void {
    for (const k of ['sync.token', 'sync.deviceId', 'sync.lastError']) this.set(k, null);
  }

  setCursor(cursor: number): void {
    this.set('sync.cursor', String(cursor));
  }

  recordResult(error: string | null): void {
    if (error === null) this.set('sync.lastSyncAt', this.now());
    this.set('sync.lastError', error);
  }

  conflicts(limit = 100): { id: string; entity: string; entity_id: string; message: string; at: string }[] {
    return this.db.prepare('SELECT id, entity, entity_id, message, at FROM sync_conflicts ORDER BY at DESC LIMIT ?').all(limit) as never;
  }

  // --- Envoi ------------------------------------------------------------------

  /**
   * Stock multi-magasin : met en file le stock de chaque article et dépôt de ce magasin
   * qui a changé depuis le dernier envoi (un seul envoi par article, même après cent ventes).
   */
  publishStock(storeId: string): number {
    return this.tx(() => {
      const changed = this.db
        .prepare(
          `SELECT s.warehouse_id, s.article_id, s.qty FROM stock s JOIN warehouses w ON w.id = s.warehouse_id
           LEFT JOIN stock_published p ON p.warehouse_id = s.warehouse_id AND p.article_id = s.article_id
           WHERE w.store_id = ? AND (p.qty IS NULL OR p.qty <> s.qty)`,
        )
        .all(storeId) as { warehouse_id: string; article_id: string; qty: number }[];
      const mark = this.db.prepare(
        'INSERT INTO stock_published (warehouse_id, article_id, qty) VALUES (?, ?, ?) ON CONFLICT (warehouse_id, article_id) DO UPDATE SET qty = excluded.qty',
      );
      for (const c of changed) {
        mark.run(c.warehouse_id, c.article_id, c.qty);
        this.enqueue(null, 'stock_level', `${c.warehouse_id}:${c.article_id}`, 'upsert', {});
      }
      return changed.length;
    });
  }

  /** Opérations à envoyer, dans l'ordre où elles ont été faites. */
  pending(limit = 500): SyncEvent[] {
    const rows = this.db
      .prepare('SELECT id, entity, entity_id, op, store_id, register_id, created_at FROM outbox WHERE sent_at IS NULL ORDER BY seq LIMIT ?')
      .all(limit) as { id: string; entity: string; entity_id: string; op: 'upsert' | 'delete'; store_id: string | null; register_id: string | null; created_at: string }[];
    return rows.map((r) => {
      const payload = r.op === 'delete' ? null : this.serialize(r.entity, r.entity_id);
      return {
        id: r.id,
        entity: r.entity,
        entityId: r.entity_id,
        op: payload === null ? 'delete' : 'upsert',
        storeId: r.store_id,
        registerId: r.register_id,
        createdAt: r.created_at,
        payload,
      };
    });
  }

  /** Ce PC a-t-il déjà vérifié que ce serveur a toutes ses données de référence ? */
  resendChecked(): boolean {
    const deviceId = this.get('sync.deviceId');
    return Boolean(deviceId) && this.get('sync.resendChecked') === deviceId;
  }

  markResendChecked(): void {
    const deviceId = this.get('sync.deviceId');
    if (deviceId) this.set('sync.resendChecked', deviceId);
  }

  /** Identifiants de chaque donnée de référence de ce PC (le stock et les inventaires : seulement ceux du magasin). */
  resendTargets(storeId: string | null): { entity: string; ids: string[]; storeId: string | null }[] {
    return RESEND.filter((r) => !r.store || storeId).map((r) => ({
      entity: r.entity,
      ids: (r.store ? this.db.prepare(r.ids).pluck().all(storeId) : this.db.prepare(r.ids).pluck().all()) as string[],
      // Le stock part comme celui de `publishStock` : visible de tous les magasins.
      storeId: r.entity === 'inventory' ? storeId : null,
    }));
  }

  /** Remet des données dans la file d'envoi (sauf celles qui y attendent déjà). */
  requeue(entity: string, ids: string[], storeId: string | null): number {
    if (ids.length === 0) return 0;
    const pending = new Set(this.db.prepare('SELECT entity_id FROM outbox WHERE sent_at IS NULL AND entity = ?').pluck().all(entity) as string[]);
    const fresh = ids.filter((id) => !pending.has(id));
    this.tx(() => fresh.forEach((id) => this.enqueue(storeId ? { storeId, registerId: null } : null, entity, id, 'upsert', {})));
    return fresh.length;
  }

  markSent(ids: string[]): void {
    const stmt = this.db.prepare('UPDATE outbox SET sent_at = ? WHERE id = ?');
    const now = this.now();
    this.tx(() => ids.forEach((id) => stmt.run(now, id)));
  }

  /** Dernier numéro de la file d'envoi : les opérations faites ensuite sont celles d'une fiche sortie. */
  lastSeq(): number {
    return (this.db.prepare('SELECT MAX(seq) FROM outbox').pluck().get() as number | null) ?? 0;
  }

  /**
   * Opérations faites après `seq`, envoyées ou non, avec l'état actuel de chaque
   * entité : une entité modifiée dix fois ne part qu'une fois, à la place de sa
   * première modification (un article avant son lot, un lot avant ses mouvements).
   */
  eventsSince(seq: number): SyncEvent[] {
    const rows = this.db
      .prepare('SELECT id, entity, entity_id, op, store_id, register_id, created_at FROM outbox WHERE seq > ? ORDER BY seq')
      .all(seq) as { id: string; entity: string; entity_id: string; op: 'upsert' | 'delete'; store_id: string | null; register_id: string | null; created_at: string }[];
    const seen = new Set<string>();
    const events: SyncEvent[] = [];
    for (const r of rows) {
      // Le stock se recalcule à partir des mouvements.
      if (r.entity === 'stock_level') continue;
      const key = `${r.entity}|${r.entity_id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const payload = this.serialize(r.entity, r.entity_id);
      events.push({
        id: r.id,
        entity: r.entity,
        entityId: r.entity_id,
        op: payload === null ? 'delete' : 'upsert',
        storeId: r.store_id,
        registerId: r.register_id,
        createdAt: r.created_at,
        payload,
      });
    }
    return events;
  }

  /**
   * Applique des opérations venues d'une fiche rapportée, puis les remet dans la
   * file d'envoi : les autres PC du magasin les reçoivent par le serveur.
   */
  adopt(events: SyncEvent[]): { applied: number; conflicts: number } {
    const result = this.applyRemote(events);
    this.tx(() => {
      for (const e of events) this.enqueue(e.storeId ? { storeId: e.storeId, registerId: e.registerId } : null, e.entity, e.entityId, e.op, {});
    });
    return result;
  }

  /** État complet et actuel d'une entité, prêt à être appliqué sur un autre poste. */
  serialize(entity: string, entityId: string): Record<string, unknown> | null {
    const table = TABLES[entity];
    if (table) return (this.db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(entityId) as Record<string, unknown> | undefined) ?? null;
    const doc = WITH_LINES[entity];
    if (doc) {
      const row = this.db.prepare(`SELECT * FROM ${doc.table} WHERE id = ?`).get(entityId) as Record<string, unknown> | undefined;
      if (!row) return null;
      return { ...row, lines: this.db.prepare(`SELECT * FROM ${doc.lines} WHERE ${doc.fk} = ? ORDER BY line_no`).all(entityId) };
    }
    switch (entity) {
      case 'article': {
        const row = this.db.prepare('SELECT * FROM articles WHERE id = ?').get(entityId) as Record<string, unknown> | undefined;
        if (!row) return null;
        return {
          ...row,
          barcodes: this.db.prepare('SELECT code, pack_qty FROM barcodes WHERE article_id = ?').all(entityId),
          packs: this.db.prepare('SELECT * FROM article_packs WHERE article_id = ? ORDER BY position').all(entityId),
          photo: this.db.prepare('SELECT photo, thumb, updated_at FROM article_photos WHERE article_id = ?').get(entityId) ?? null,
        };
      }
      case 'stock_level': {
        const [warehouseId, articleId] = entityId.split(':');
        const qty = this.db.prepare('SELECT qty FROM stock WHERE warehouse_id = ? AND article_id = ?').pluck().get(warehouseId, articleId) as number | undefined;
        return qty === undefined ? null : { warehouse_id: warehouseId, article_id: articleId, qty, updated_at: this.now() };
      }
      case 'store_price': {
        const [articleId, storeId] = entityId.split(':');
        return (
          (this.db.prepare('SELECT * FROM store_prices WHERE article_id = ? AND store_id = ?').get(articleId, storeId) as
            | Record<string, unknown>
            | undefined) ?? null
        );
      }
      case 'inventory': {
        const row = this.db.prepare('SELECT * FROM inventories WHERE id = ?').get(entityId) as Record<string, unknown> | undefined;
        if (!row) return null;
        return { ...row, lines: this.db.prepare('SELECT * FROM inventory_lines WHERE inventory_id = ?').all(entityId) };
      }
      case 'inventory_line':
        return (this.db.prepare('SELECT * FROM inventory_lines WHERE id = ?').get(entityId) as Record<string, unknown> | undefined) ?? null;
      case 'transfer': {
        const row = this.db.prepare('SELECT * FROM transfers WHERE id = ?').get(entityId) as Record<string, unknown> | undefined;
        if (!row) return null;
        return { ...row, lines: this.db.prepare('SELECT * FROM transfer_lines WHERE transfer_id = ? ORDER BY position').all(entityId) };
      }
      case 'stock_request':
        return (this.db.prepare('SELECT * FROM stock_requests WHERE id = ?').get(entityId) as Record<string, unknown> | undefined) ?? null;
      case 'rebate_rules': {
        const customerId = entityId === 'base' ? null : entityId;
        const rules = this.db.prepare('SELECT * FROM rebate_rules WHERE customer_id IS ? ORDER BY created_at').all(customerId) as Record<string, unknown>[];
        const updatedAt = (this.db.prepare('SELECT MAX(updated_at) FROM rebate_rules WHERE customer_id IS ?').pluck().get(customerId) as string | null) ?? this.now();
        return { customer_id: customerId, updated_at: updatedAt, rules };
      }
      case 'recipe': {
        const row = this.db.prepare('SELECT * FROM recipes WHERE id = ?').get(entityId) as Record<string, unknown> | undefined;
        if (!row) return null;
        return { ...row, lines: this.db.prepare('SELECT * FROM recipe_lines WHERE recipe_id = ? ORDER BY position').all(entityId) };
      }
      case 'production_order':
        return (this.db.prepare('SELECT * FROM production_orders WHERE id = ?').get(entityId) as Record<string, unknown> | undefined) ?? null;
      case 'sale': {
        const row = this.db.prepare('SELECT * FROM sales WHERE id = ?').get(entityId) as Record<string, unknown> | undefined;
        if (!row) return null;
        return {
          ...row,
          lines: this.db.prepare('SELECT * FROM sale_lines WHERE sale_id = ? ORDER BY line_no').all(entityId),
          payments: this.db.prepare('SELECT * FROM sale_payments WHERE sale_id = ?').all(entityId),
        };
      }
      default:
        return null;
    }
  }

  // --- Réception --------------------------------------------------------------

  private tableColumns(table: string): Set<string> {
    let cols = this.columns.get(table);
    if (!cols) {
      cols = new Set((this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name));
      this.columns.set(table, cols);
    }
    return cols;
  }

  /**
   * Dernière écriture gagnante : garde la version locale si elle est plus récente. À égalité
   * d'horodatage (deux PC dans la même milliseconde), le contenu départage, pour que tous les PC
   * gardent la même version au lieu de chacun la sienne.
   */
  private keepsLocal(table: string, id: string, remote: Record<string, unknown>): boolean {
    const local = this.db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    if (!local) return false;
    const lu = String(local['updated_at']);
    const ru = String(remote['updated_at']);
    if (lu !== ru) return lu > ru;
    const content = (row: Record<string, unknown>) => JSON.stringify(Object.keys(local).sort().map((k) => (row[k] ?? null) === null ? null : String(row[k])));
    return content(local) >= content(remote);
  }

  private upsert(table: string, row: Record<string, unknown>, keys: string[] = ['id'], ignoreExisting = false): void {
    const cols = [...this.tableColumns(table)].filter((c) => c in row);
    const values = Object.fromEntries(cols.map((c) => [c, row[c] ?? null]));
    const updates = cols.filter((c) => !keys.includes(c)).map((c) => `${c} = excluded.${c}`);
    const conflict = ignoreExisting || updates.length === 0 ? 'DO NOTHING' : `DO UPDATE SET ${updates.join(', ')}`;
    this.db
      .prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((c) => `@${c}`).join(', ')}) ON CONFLICT(${keys.join(', ')}) ${conflict}`)
      .run(values);
  }

  private conflict(event: SyncEvent, message: string): void {
    this.db
      .prepare('INSERT INTO sync_conflicts (id, entity, entity_id, message, payload, at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(newId(), event.entity, event.entityId, message, JSON.stringify(event.payload), this.now());
  }

  /**
   * Applique les opérations reçues des autres postes. Une opération qui
   * échoue (code-barres déjà pris par un autre article…) est notée dans
   * `sync_conflicts` sans bloquer les suivantes.
   */
  applyRemote(events: SyncEvent[]): { applied: number; conflicts: number } {
    const stockToRecompute = new Map<string, [string, string]>();
    const lotsToRecompute = new Set<string>();
    let applied = 0;
    let conflicts = 0;
    // Les clés étrangères sont vérifiées à la source ; ici l'ordre d'arrivée
    // entre postes n'est pas garanti (un mouvement peut précéder son lot).
    this.db.pragma('foreign_keys = OFF');
    try {
      this.tx(() => {
        for (const event of events) {
          try {
            this.db.transaction(() => this.applyOne(event, stockToRecompute, lotsToRecompute))();
            applied++;
          } catch (e) {
            conflicts++;
            this.conflict(event, e instanceof Error ? e.message : String(e));
          }
        }
        for (const [articleId, warehouseId] of stockToRecompute.values()) this.stock.recompute(articleId, warehouseId);
        for (const lotId of lotsToRecompute) this.stock.recomputeLot(lotId);
      });
    } finally {
      this.db.pragma('foreign_keys = ON');
    }
    return { applied, conflicts };
  }

  /** Le document local est-il plus avancé (expédié, clôturé…) que la version reçue ? */
  private isAhead(table: string, id: string, remoteStatus: unknown): boolean {
    const local = this.db.prepare(`SELECT status FROM ${table} WHERE id = ?`).pluck().get(id) as string | undefined;
    if (local === undefined) return false;
    const rank = STATUS_RANK[table]!;
    return (rank[local] ?? 0) > (rank[String(remoteStatus)] ?? 0);
  }

  /**
   * Inventaires, transferts, demandes de correction, ristournes et fabrication.
   * Renvoie vrai si l'opération a été traitée ici.
   */
  private applyDocument(event: SyncEvent): boolean {
    const p = event.payload;
    switch (event.entity) {
      case 'inventory': {
        if (!p) return true;
        if (this.isAhead('inventories', event.entityId, p['status'])) return true;
        this.upsert('inventories', p);
        // En cours : les lignes reçues ne remplacent pas les comptages faits ici. Clôturé ou annulé : la version reçue fait foi.
        const final = p['status'] !== 'open';
        for (const line of (p['lines'] as Record<string, unknown>[]) ?? []) {
          if (final) this.db.prepare('DELETE FROM inventory_lines WHERE inventory_id = ? AND article_id = ? AND id <> ?').run(event.entityId, line['article_id'], line['id']);
          this.upsert('inventory_lines', line, ['id'], !final);
        }
        return true;
      }
      case 'inventory_line': {
        if (event.op === 'delete' || !p) {
          this.db.prepare('DELETE FROM inventory_lines WHERE id = ? AND counted IS NULL').run(event.entityId);
          return true;
        }
        const status = this.db.prepare('SELECT status FROM inventories WHERE id = ?').pluck().get(p['inventory_id']) as string | undefined;
        if (status && status !== 'open') return true;
        // Le même produit compté sur deux PC : la saisie la plus récente l'emporte.
        const local = this.db.prepare('SELECT counted_at FROM inventory_lines WHERE id = ?').pluck().get(event.entityId) as string | null | undefined;
        if (local && p['counted_at'] && String(local) > String(p['counted_at'])) return true;
        this.upsert('inventory_lines', p);
        return true;
      }
      case 'transfer': {
        if (event.op === 'delete' || !p) {
          // Seul un brouillon est effacé ; un bon déjà expédié ici reste.
          if (this.db.prepare("SELECT 1 FROM transfers WHERE id = ? AND status = 'draft'").get(event.entityId)) {
            this.db.prepare('DELETE FROM transfer_lines WHERE transfer_id = ?').run(event.entityId);
            this.db.prepare('DELETE FROM transfers WHERE id = ?').run(event.entityId);
          }
          return true;
        }
        if (this.isAhead('transfers', event.entityId, p['status'])) return true;
        this.upsert('transfers', p);
        this.db.prepare('DELETE FROM transfer_lines WHERE transfer_id = ?').run(event.entityId);
        for (const line of (p['lines'] as Record<string, unknown>[]) ?? []) this.upsert('transfer_lines', line);
        return true;
      }
      case 'stock_request': {
        if (!p) return true;
        if (this.isAhead('stock_requests', event.entityId, p['status'])) return true;
        this.upsert('stock_requests', p);
        return true;
      }
      case 'production_order': {
        if (!p) return true;
        if (this.isAhead('production_orders', event.entityId, p['status'])) return true;
        this.upsert('production_orders', p);
        return true;
      }
      case 'rebate_rules': {
        if (!p) return true;
        const customerId = (p['customer_id'] as string | null) ?? null;
        const local = this.db.prepare('SELECT MAX(updated_at) FROM rebate_rules WHERE customer_id IS ?').pluck().get(customerId) as string | null;
        if (local && local > String(p['updated_at'])) return true;
        this.db.prepare('DELETE FROM rebate_rules WHERE customer_id IS ?').run(customerId);
        for (const r of (p['rules'] as Record<string, unknown>[]) ?? []) this.upsert('rebate_rules', r);
        return true;
      }
      case 'recipe': {
        if (event.op === 'delete' || !p) return true;
        if (this.keepsLocal('recipes', event.entityId, p)) return true;
        this.upsert('recipes', p);
        this.db.prepare('DELETE FROM recipe_lines WHERE recipe_id = ?').run(event.entityId);
        for (const line of (p['lines'] as Record<string, unknown>[]) ?? []) this.upsert('recipe_lines', line);
        return true;
      }
      default:
        return false;
    }
  }

  private applyOne(event: SyncEvent, stock: Map<string, [string, string]>, lots: Set<string>): void {
    const p = event.payload;
    if (event.entity === 'store_price') {
      const [articleId, storeId] = event.entityId.split(':');
      if (event.op === 'delete' || !p) {
        this.db.prepare('DELETE FROM store_prices WHERE article_id = ? AND store_id = ?').run(articleId, storeId);
      } else {
        this.upsert('store_prices', p, ['article_id', 'store_id']);
      }
      return;
    }
    if (this.applyDocument(event)) return;
    const doc = WITH_LINES[event.entity];
    if (doc && (event.op === 'delete' || !p)) {
      this.db.prepare(`DELETE FROM ${doc.lines} WHERE ${doc.fk} = ?`).run(event.entityId);
      this.db.prepare(`DELETE FROM ${doc.table} WHERE id = ?`).run(event.entityId);
      return;
    }
    if (!p) {
      const table = TABLES[event.entity];
      if (event.op === 'delete' && table && !IMMUTABLE.has(event.entity)) this.db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(event.entityId);
      return;
    }
    if (doc) {
      // Un devis facturé ou annulé ne redevient pas ouvert si une version plus ancienne arrive.
      if (event.entity === 'quote' && p['status'] === 'open') {
        const local = this.db.prepare('SELECT status FROM quotes WHERE id = ?').pluck().get(event.entityId);
        if (local && local !== 'open') return;
      }
      // Une commande facturée ou annulée ne revient pas en arrière.
      if (event.entity === 'customer_order') {
        const local = this.db.prepare('SELECT status FROM customer_orders WHERE id = ?').pluck().get(event.entityId) as string | undefined;
        if (local === 'invoiced' || local === 'cancelled') return;
      }
      this.upsert(doc.table, p);
      // Un bon de commande brouillon, un devis ou une écriture saisie peuvent être réécrits : on remplace leurs lignes.
      // Les lignes d'une réception ne changent jamais.
      const rewritable = event.entity === 'purchase_order' || event.entity === 'quote' || event.entity === 'customer_order' || event.entity === 'manual_entry';
      if (rewritable) this.db.prepare(`DELETE FROM ${doc.lines} WHERE ${doc.fk} = ?`).run(event.entityId);
      for (const line of (p['lines'] as Record<string, unknown>[]) ?? []) this.upsert(doc.lines, line, ['id'], !rewritable);
      return;
    }
    switch (event.entity) {
      case 'expense': {
        // Une annulation est définitive : une version plus ancienne ne la défait pas.
        const local = this.db.prepare('SELECT status FROM expenses WHERE id = ?').pluck().get(event.entityId);
        if (local === 'cancelled') return;
        this.upsert('expenses', p);
        return;
      }
      case 'bank_line': {
        // Pointage fait sur deux PC : la modification la plus récente l'emporte.
        if (this.keepsLocal('bank_lines', event.entityId, p)) return;
        this.upsert('bank_lines', p);
        return;
      }
      case 'tax_year': {
        // Paramètres fiscaux modifiés sur deux PC : la modification la plus récente l'emporte.
        if (this.keepsLocal('tax_years', event.entityId, p)) return;
        this.upsert('tax_years', p);
        return;
      }
      case 'fiscal_year': {
        // Exercice clôturé ou rouvert sur deux PC : la modification la plus récente l'emporte.
        if (this.keepsLocal('fiscal_years', event.entityId, p)) return;
        this.upsert('fiscal_years', p);
        return;
      }
      case 'charge_plan': {
        // Charge modifiée sur deux PC : la modification la plus récente l'emporte.
        if (this.keepsLocal('charge_plans', event.entityId, p)) return;
        this.upsert('charge_plans', p);
        return;
      }
      case 'promotion': {
        // Promotion modifiée sur deux PC : la modification la plus récente l'emporte.
        if (this.keepsLocal('promotions', event.entityId, p)) return;
        this.upsert('promotions', p);
        return;
      }
      case 'dsf_disclosure': {
        // Notes déclaratives saisies sur deux PC : la modification la plus récente l'emporte.
        if (this.keepsLocal('dsf_disclosures', event.entityId, p)) return;
        this.upsert('dsf_disclosures', p);
        return;
      }
      case 'account': {
        // Un rôle (caisse, TVA collectée…) n'est porté que par un compte : il quitte l'ancien.
        const local = this.db.prepare('SELECT updated_at FROM accounts WHERE id = ?').pluck().get(event.entityId) as string | undefined;
        if (local && local > String(p['updated_at'])) return;
        if (p['role']) this.db.prepare('UPDATE accounts SET role = NULL WHERE role = ? AND id <> ?').run(p['role'], event.entityId);
        this.upsert('accounts', p);
        return;
      }
      case 'article': {
        // La modification la plus récente l'emporte.
        const local = this.db.prepare('SELECT updated_at FROM articles WHERE id = ?').pluck().get(event.entityId) as string | undefined;
        if (local && local > String(p['updated_at'])) return;
        this.upsert('articles', p);
        this.db.prepare('DELETE FROM barcodes WHERE article_id = ?').run(event.entityId);
        const insert = this.db.prepare('INSERT INTO barcodes (code, article_id, pack_qty) VALUES (?, ?, ?)');
        for (const b of (p['barcodes'] as { code: string; pack_qty: number }[]) ?? []) {
          const owner = this.db.prepare('SELECT article_id FROM barcodes WHERE code = ?').pluck().get(b.code) as string | undefined;
          if (owner) {
            this.conflict(event, `Code-barres ${b.code} déjà attribué à un autre article sur ce poste`);
            continue;
          }
          insert.run(b.code, event.entityId, b.pack_qty);
        }
        // Conditionnements : la liste reçue remplace la liste locale (un poste ancien n'en envoie pas).
        if (Array.isArray(p['packs'])) {
          this.db.prepare('DELETE FROM article_packs WHERE article_id = ?').run(event.entityId);
          for (const pack of p['packs'] as Record<string, unknown>[]) this.upsert('article_packs', pack);
        }
        // Photo : null la retire ; un poste ancien n'envoie pas la clé.
        if ('photo' in p) {
          const ph = p['photo'] as { photo: string; thumb: string; updated_at: string } | null;
          if (ph) this.upsert('article_photos', { article_id: event.entityId, ...ph }, ['article_id']);
          else this.db.prepare('DELETE FROM article_photos WHERE article_id = ?').run(event.entityId);
        }
        return;
      }
      case 'sale': {
        this.upsert('sales', p);
        for (const line of (p['lines'] as Record<string, unknown>[]) ?? []) this.upsert('sale_lines', line, ['id'], true);
        for (const pay of (p['payments'] as Record<string, unknown>[]) ?? []) this.upsert('sale_payments', pay, ['id'], true);
        return;
      }
      case 'lot': {
        this.upsert('lots', { ...p, qty: 0 }, ['id'], true);
        lots.add(event.entityId);
        return;
      }
      case 'stock_level': {
        // Stock d'un dépôt d'un autre magasin ; celui de ce magasin vient de ses propres mouvements.
        const own = this.db
          .prepare("SELECT 1 FROM warehouses w JOIN settings k ON k.key = 'station.storeId' AND k.value = w.store_id WHERE w.id = ?")
          .get(String(p['warehouse_id']));
        if (own) return;
        this.db
          .prepare(
            `INSERT INTO stock_levels (warehouse_id, article_id, qty, updated_at) VALUES (@warehouse_id, @article_id, @qty, @updated_at)
             ON CONFLICT (warehouse_id, article_id) DO UPDATE SET qty = excluded.qty, updated_at = excluded.updated_at
             WHERE excluded.updated_at >= stock_levels.updated_at`,
          )
          .run({ warehouse_id: p['warehouse_id'], article_id: p['article_id'], qty: p['qty'], updated_at: p['updated_at'] });
        return;
      }
      case 'stock_movement': {
        this.upsert('stock_movements', p, ['id'], true);
        const articleId = String(p['article_id']);
        const warehouseId = String(p['warehouse_id']);
        stock.set(`${articleId}|${warehouseId}`, [articleId, warehouseId]);
        if (p['lot_id']) lots.add(String(p['lot_id']));
        return;
      }
      case 'attendance': {
        // Pointé sur deux PC le même jour : la première arrivée et le dernier départ.
        // Une correction du gérant (plus récente) remplace tout.
        const local = this.db.prepare('SELECT * FROM attendance WHERE id = ?').get(event.entityId) as Record<string, string | null> | undefined;
        if (!local) return this.upsert('attendance', p);
        const remoteNewer = String(p['updated_at']) > String(local['updated_at']);
        if (p['corrected_by'] && remoteNewer) return this.upsert('attendance', p);
        if (local['corrected_by'] && !remoteNewer) return;
        const pick = (a: unknown, b: unknown, first: boolean) => {
          const x = (a as string | null) ?? null;
          const y = (b as string | null) ?? null;
          if (!x || !y) return x ?? y;
          return first ? (x < y ? x : y) : x > y ? x : y;
        };
        this.upsert('attendance', {
          ...local,
          arrived_at: pick(local['arrived_at'], p['arrived_at'], true),
          left_at: pick(local['left_at'], p['left_at'], false),
          updated_at: remoteNewer ? p['updated_at'] : local['updated_at'],
        });
        return;
      }
      case 'sale_delivery': {
        // « Livrée » sur un PC ne redevient pas « à préparer » si une version plus ancienne arrive.
        if (this.isAhead('sale_deliveries', event.entityId, p['status'])) return;
        this.upsert('sale_deliveries', p);
        return;
      }
      default: {
        const table = TABLES[event.entity];
        if (!table) throw new Error(`Type d'opération inconnu : ${event.entity}`);
        this.upsert(table, p, ['id'], IMMUTABLE.has(event.entity));
      }
    }
  }
}
