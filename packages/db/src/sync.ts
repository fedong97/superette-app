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
};

/** Entités qui ne changent plus une fois créées : un doublon reçu est ignoré. */
const IMMUTABLE = new Set(['stock_movement', 'cash_operation', 'supplier_payment', 'customer_payment']);

/** Documents avec lignes : l'en-tête et ses lignes voyagent ensemble. */
const WITH_LINES: Record<string, { table: string; lines: string; fk: string }> = {
  purchase_order: { table: 'purchase_orders', lines: 'purchase_order_lines', fk: 'order_id' },
  reception: { table: 'receptions', lines: 'reception_lines', fk: 'reception_id' },
  manual_entry: { table: 'manual_entries', lines: 'manual_entry_lines', fk: 'entry_id' },
  quote: { table: 'quotes', lines: 'quote_lines', fk: 'quote_id' },
};

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

  markSent(ids: string[]): void {
    const stmt = this.db.prepare('UPDATE outbox SET sent_at = ? WHERE id = ?');
    const now = this.now();
    this.tx(() => ids.forEach((id) => stmt.run(now, id)));
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
        return { ...row, barcodes: this.db.prepare('SELECT code, pack_qty FROM barcodes WHERE article_id = ?').all(entityId) };
      }
      case 'store_price': {
        const [articleId, storeId] = entityId.split(':');
        return (
          (this.db.prepare('SELECT * FROM store_prices WHERE article_id = ? AND store_id = ?').get(articleId, storeId) as
            | Record<string, unknown>
            | undefined) ?? null
        );
      }
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
    const doc = WITH_LINES[event.entity];
    if (doc && (event.op === 'delete' || !p)) {
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
      this.upsert(doc.table, p);
      // Un bon de commande brouillon peut être réécrit : on remplace ses lignes.
      // Les lignes d'une réception ne changent jamais.
      if (event.entity === 'purchase_order' || event.entity === 'quote') this.db.prepare(`DELETE FROM ${doc.lines} WHERE ${doc.fk} = ?`).run(event.entityId);
      for (const line of (p['lines'] as Record<string, unknown>[]) ?? []) this.upsert(doc.lines, line, ['id'], event.entity !== 'purchase_order' && event.entity !== 'quote');
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
      case 'stock_movement': {
        this.upsert('stock_movements', p, ['id'], true);
        const articleId = String(p['article_id']);
        const warehouseId = String(p['warehouse_id']);
        stock.set(`${articleId}|${warehouseId}`, [articleId, warehouseId]);
        if (p['lot_id']) lots.add(String(p['lot_id']));
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
