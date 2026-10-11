import { type Fcfa, formatFcfa } from '@superette/core';
import type { CustomerService } from './customers';
import type { Db } from './database';
import type { PosService } from './pos';
import type { PurchaseService } from './purchases';
import type { RebateService } from './rebates';
import type { StockService } from './stock';
import { Base, type Clock } from './util';

export type AttentionKey =
  | 'rupture'
  | 'alerte'
  | 'cash_gaps'
  | 'transfers'
  | 'stock_requests'
  | 'rebates_pending'
  | 'rebates_balance'
  | 'inventories'
  | 'supplier_invoices'
  | 'late_customers'
  | 'production';

export interface AttentionItem {
  key: AttentionKey;
  label: string;
  /** Nombre d'éléments à traiter : 0 quand tout est en ordre. */
  count: number;
  amount: Fcfa | null;
  /** Une ligne d'explication, avec les premiers noms concernés. */
  detail: string;
  tone: 'danger' | 'warning' | 'info';
}

/** Les premiers noms d'une liste, pour la ligne d'explication d'une tuile. */
const firstNames = (names: string[], max = 3) => (names.length > max ? `${names.slice(0, max).join(', ')}…` : names.join(', '));

/**
 * Points d'attention du gérant : ce qui attend une action dans le magasin.
 * L'appelant choisit les points selon les droits de l'utilisateur.
 */
export class AttentionService extends Base {
  constructor(
    db: Db,
    clock: Clock,
    private readonly stock: StockService,
    private readonly pos: PosService,
    private readonly purchases: PurchaseService,
    private readonly customers: CustomerService,
    private readonly rebates: RebateService,
  ) {
    super(db, clock);
  }

  /** Mois précédent, terminé : la période de ristourne à constater. */
  lastMonth(): { from: string; to: string } {
    const [y, m] = this.today().split('-').map(Number) as [number, number];
    const first = new Date(Date.UTC(y, m - 2, 1));
    const last = new Date(Date.UTC(y, m - 1, 0));
    return { from: first.toISOString().slice(0, 10), to: last.toISOString().slice(0, 10) };
  }

  list(storeId: string, keys: ReadonlySet<AttentionKey>): AttentionItem[] {
    const items: AttentionItem[] = [];
    const want = (k: AttentionKey) => keys.has(k);

    for (const level of ['rupture', 'alerte'] as const) {
      if (!want(level)) continue;
      const rows = this.stock.list(storeId, { level });
      const names = [...new Set(rows.map((r) => r.name))];
      items.push({
        key: level,
        label: level === 'rupture' ? 'Ruptures de stock' : 'Stocks en alerte',
        count: names.length,
        amount: null,
        detail: names.length ? firstNames(names) : level === 'rupture' ? 'Aucun article en rupture' : 'Aucun article sous le stock d’alerte',
        tone: level === 'rupture' ? 'danger' : 'warning',
      });
    }

    if (want('cash_gaps')) {
      const gaps = this.pos.pendingGaps(storeId);
      items.push({
        key: 'cash_gaps',
        label: 'Écarts de caisse à justifier',
        count: gaps.length,
        amount: gaps.reduce((t, g) => t + Math.abs(g.difference ?? 0), 0),
        detail: gaps.length ? firstNames(gaps.map((g) => `${g.user_name} (${(g.difference ?? 0) > 0 ? '+' : ''}${formatFcfa(g.difference ?? 0)})`)) : 'Aucun écart en attente de motif',
        tone: 'danger',
      });
    }

    if (want('transfers')) {
      const rows = this.db
        .prepare(
          `SELECT t.number, w.name AS to_name FROM transfers t JOIN warehouses w ON w.id = t.to_warehouse_id
           WHERE t.store_id = ? AND t.status = 'shipped' ORDER BY t.shipped_at`,
        )
        .all(storeId) as { number: string; to_name: string }[];
      items.push({
        key: 'transfers',
        label: 'Transferts expédiés non reçus',
        count: rows.length,
        amount: null,
        detail: rows.length ? firstNames(rows.map((r) => `n° ${r.number} vers ${r.to_name}`)) : 'Tous les transferts expédiés sont reçus',
        tone: 'warning',
      });
    }

    if (want('stock_requests')) {
      const rows = this.db
        .prepare(
          `SELECT a.name FROM stock_requests r JOIN articles a ON a.id = r.article_id
           WHERE r.store_id = ? AND r.status = 'pending' ORDER BY r.requested_at`,
        )
        .pluck()
        .all(storeId) as string[];
      items.push({
        key: 'stock_requests',
        label: 'Demandes de correction de stock',
        count: rows.length,
        amount: null,
        detail: rows.length ? firstNames(rows) : 'Aucune demande en attente',
        tone: 'warning',
      });
    }

    if (want('rebates_pending') || want('rebates_balance')) {
      const period = this.lastMonth();
      const state = this.rebates.state(storeId, period.from, period.to);
      if (want('rebates_pending')) {
        const rows = state.filter((r) => r.pending > 0);
        items.push({
          key: 'rebates_pending',
          label: 'Ristournes à constater',
          count: rows.length,
          amount: rows.reduce((t, r) => t + r.pending, 0),
          detail: rows.length ? `Mois du ${period.from} au ${period.to} : ${firstNames(rows.map((r) => r.customer_name))}` : 'Le mois dernier est constaté',
          tone: 'info',
        });
      }
      if (want('rebates_balance')) {
        const rows = state.filter((r) => r.balance > 0);
        items.push({
          key: 'rebates_balance',
          label: 'Ristournes à accorder',
          count: rows.length,
          amount: rows.reduce((t, r) => t + r.balance, 0),
          detail: rows.length ? firstNames(rows.map((r) => r.customer_name)) : 'Aucun solde de ristourne dû',
          tone: 'info',
        });
      }
    }

    if (want('inventories')) {
      const rows = this.db
        .prepare("SELECT number, label FROM inventories WHERE store_id = ? AND status = 'open' ORDER BY opened_at")
        .all(storeId) as { number: string; label: string | null }[];
      items.push({
        key: 'inventories',
        label: 'Inventaires en cours',
        count: rows.length,
        amount: null,
        detail: rows.length ? firstNames(rows.map((r) => `n° ${r.number}${r.label ? ` ${r.label}` : ''}`)) : 'Aucun inventaire ouvert',
        tone: 'info',
      });
    }

    if (want('supplier_invoices')) {
      const due = this.purchases.dueSchedule(storeId);
      const late = due.invoices.filter((i) => i.overdue);
      items.push({
        key: 'supplier_invoices',
        label: 'Factures fournisseurs en retard',
        count: late.length,
        amount: due.overdue,
        detail: late.length ? firstNames([...new Set(late.map((i) => i.supplier_name))]) : 'Aucune facture échue impayée',
        tone: 'danger',
      });
    }

    if (want('late_customers')) {
      const late = this.customers
        .receivables(storeId)
        .customers.map((c) => ({ name: c.name, late: c.buckets.d30 + c.buckets.d60 + c.buckets.d90 + c.buckets.older }))
        .filter((c) => c.late > 0);
      items.push({
        key: 'late_customers',
        label: 'Clients en retard de paiement',
        count: late.length,
        amount: late.reduce((t, c) => t + c.late, 0),
        detail: late.length ? firstNames(late.map((c) => c.name)) : 'Aucune échéance client dépassée',
        tone: 'danger',
      });
    }

    if (want('production')) {
      const rows = this.db
        .prepare("SELECT number FROM production_orders WHERE store_id = ? AND status = 'draft' ORDER BY created_at")
        .pluck()
        .all(storeId) as string[];
      items.push({
        key: 'production',
        label: 'Ordres de fabrication à exécuter',
        count: rows.length,
        amount: null,
        detail: rows.length ? firstNames(rows.map((n) => `n° ${n}`)) : 'Aucun ordre en brouillon',
        tone: 'info',
      });
    }

    return items;
  }
}
