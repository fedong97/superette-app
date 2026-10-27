import { AppError, Base, newId } from './util';

/**
 * Données d'essai effacées par la remise à zéro : tout ce que les ventes, les
 * achats, la caisse, le stock et la paie ont produit pendant la formation.
 */
const WIPED = [
  'account_offsets',
  'agent_operations',
  'attendance',
  'bank_lines',
  'cash_alerts',
  'cash_handovers',
  'cash_operations',
  'cash_sessions',
  'central_cash_movements',
  'cheque_deposit_lines',
  'cheque_deposits',
  'cheque_rejections',
  'consignment_count_lines',
  'consignment_counts',
  'container_moves',
  'courier_returns',
  'customer_order_lines',
  'customer_orders',
  'customer_payments',
  'customer_reminders',
  'day_task_checks',
  'emoney_movements',
  'exit_checks',
  'expenses',
  'gift_vouchers',
  'held_tickets',
  'inventories',
  'inventory_entries',
  'inventory_lines',
  'label_prints',
  'login_attempts',
  'lot_recalls',
  'loyalty_moves',
  'manual_entries',
  'manual_entry_lines',
  'missed_sales',
  'mobile_payments',
  'payment_allocations',
  'production_orders',
  'purchase_order_lines',
  'purchase_orders',
  'quote_lines',
  'quotes',
  'rebate_entries',
  'reception_lines',
  'receptions',
  'sale_deliveries',
  'sale_edit_requests',
  'sale_lines',
  'sale_payments',
  'sales',
  'staff_alerts',
  'staff_leaves',
  'staff_salaries',
  'staff_warnings',
  'stock_movements',
  'stock_requests',
  'store_transfer_requests',
  'summary_invoices',
  'supplier_payments',
  'supplier_return_lines',
  'supplier_returns',
  'sync_conflicts',
  'time_punches',
  'transfer_lines',
  'transfers',
  'treasury_entries',
  'ui_drafts',
];

/** Stock : effacé avec ses lots, sauf si l'on garde les quantités comme stock de départ. */
const STOCK = ['stock', 'lots', 'stock_levels', 'stock_published'];

/**
 * Entités de la file d'envoi qui restent après la remise à zéro (réglages,
 * fiches) ; les autres (ventes, mouvements…) n'ont plus rien à envoyer.
 */
const KEPT_ENTITIES = new Set([
  'vat_rate', 'company', 'store', 'warehouse', 'register', 'user', 'role_rights', 'user_rights', 'department', 'family', 'article', 'store_price',
  'supplier', 'supplier_article', 'customer', 'account', 'expense_category', 'promotion', 'rebate_rules', 'recipe', 'staff', 'staff_agency', 'staff_team',
  'staff_schedule', 'staff_document', 'entrance', 'fingerprint_device', 'charge_plan', 'budget', 'sales_target', 'container', 'agent_account',
  'price_schedule', 'recurring_order', 'fixed_asset', 'tax_year', 'dsf_disclosure', 'fiscal_year', 'opening_balance',
]);

/** Compteurs gardés : codes des fiches (articles, clients, fournisseurs, personnel) et codes-barres internes. */
const KEPT_COUNTER = "name LIKE 'article.code%' OR name LIKE 'barcode.%' OR name IN ('customer.code', 'supplier.code', 'staff.code', 'fixed_asset.code')";

export interface ResetOptions {
  /** Garder les quantités en stock comme stock de départ (sinon tout le stock repart de zéro). */
  keepStock?: boolean;
}

export interface ResetPreview {
  sales: number;
  receptions: number;
  supplierInvoices: number;
  cashSessions: number;
  expenses: number;
  movements: number;
  articles: number;
  customers: number;
  suppliers: number;
  users: number;
}

/**
 * Remise à zéro après l'installation : efface les ventes, achats, caisses,
 * mouvements de stock, dépenses et paies faits pendant les essais, et garde les
 * réglages, les utilisateurs et leurs droits, les caisses, les dépôts, les
 * produits (prix, codes-barres, conditionnements, rayons), les clients, les
 * fournisseurs, le personnel et le plan comptable. La reprise des soldes de
 * départ (clients, fournisseurs) est gardée aussi.
 */
export class ResetService extends Base {
  preview(): ResetPreview {
    const n = (sql: string) => this.db.prepare(sql).pluck().get() as number;
    return {
      sales: n('SELECT COUNT(*) FROM sales'),
      receptions: n('SELECT COUNT(*) FROM receptions'),
      supplierInvoices: n('SELECT COUNT(*) FROM supplier_invoices WHERE opening = 0'),
      cashSessions: n('SELECT COUNT(*) FROM cash_sessions'),
      expenses: n('SELECT COUNT(*) FROM expenses'),
      movements: n('SELECT COUNT(*) FROM stock_movements'),
      articles: n('SELECT COUNT(*) FROM articles'),
      customers: n('SELECT COUNT(*) FROM customers'),
      suppliers: n('SELECT COUNT(*) FROM suppliers'),
      users: n('SELECT COUNT(*) FROM users WHERE deleted_at IS NULL'),
    };
  }

  run(userId: string, opts: ResetOptions = {}): ResetPreview {
    const before = this.preview();
    const tables = new Set(this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").pluck().all() as string[]);
    // Les tables se citent entre elles : l'ordre des suppressions n'importe pas, les liens sont vérifiés à la fin.
    const fk = this.db.pragma('foreign_keys', { simple: true }) as number;
    if (fk) this.db.pragma('foreign_keys = OFF');
    try {
      this.tx(() => {
        // Stock gardé : les quantités actuelles deviennent un mouvement de départ par article et par dépôt.
        const opening = opts.keepStock
          ? (this.db.prepare('SELECT article_id, warehouse_id, qty, avg_cost FROM stock WHERE qty <> 0').all() as { article_id: string; warehouse_id: string; qty: number; avg_cost: number }[])
          : [];
        for (const t of WIPED) if (tables.has(t)) this.db.prepare(`DELETE FROM ${t}`).run();
        // Factures fournisseurs des essais ; la reprise des soldes de départ reste.
        this.db.prepare('DELETE FROM supplier_invoices WHERE opening = 0').run();
        if (opts.keepStock) {
          this.db.prepare('DELETE FROM lots WHERE qty <= 0').run();
        } else {
          for (const t of STOCK) if (tables.has(t)) this.db.prepare(`DELETE FROM ${t}`).run();
        }
        this.db.prepare(`DELETE FROM counters WHERE NOT (${KEPT_COUNTER})`).run();
        const keep = [...KEPT_ENTITIES].map(() => '?').join(',');
        this.db.prepare(`DELETE FROM outbox WHERE entity NOT IN (${keep})`).run(...KEPT_ENTITIES);
        const now = this.now();
        const insert = this.db.prepare(
          `INSERT INTO stock_movements (id, type, article_id, warehouse_id, lot_id, qty, unit_cost, reason, ref_type, ref_id, user_id, at)
           VALUES (@id, 'INVENTORY_ADJUST', @article_id, @warehouse_id, NULL, @qty, @unit_cost, 'Stock de départ (remise à zéro)', 'reset', NULL, @user_id, @at)`,
        );
        for (const s of opening) {
          const row = { id: newId(), article_id: s.article_id, warehouse_id: s.warehouse_id, qty: s.qty, unit_cost: s.avg_cost, user_id: userId, at: now };
          insert.run(row);
          this.enqueue(null, 'stock_movement', row.id, 'upsert', { ...row, type: 'INVENTORY_ADJUST', lot_id: null, reason: 'Stock de départ (remise à zéro)', ref_type: 'reset', ref_id: null });
        }
        const broken = this.db.pragma('foreign_key_check') as { table: string; parent: string }[];
        if (broken.length) {
          const where = [...new Set(broken.map((b) => `${b.table} → ${b.parent}`))].slice(0, 5).join(', ');
          throw new AppError(`Remise à zéro annulée : des fiches gardées renvoient encore à des données effacées (${where}). Rien n'a été effacé.`, 'INVALID');
        }
        this.audit(userId, 'data.reset', undefined, undefined, { keepStock: Boolean(opts.keepStock), before });
      });
    } finally {
      if (fk) this.db.pragma('foreign_keys = ON');
    }
    return this.preview();
  }
}
