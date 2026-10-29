import { type Fcfa, formatFcfa } from '@superette/core';
import type { CustomerService } from './customers';
import type { Db } from './database';
import type { PosService } from './pos';
import type { PurchaseService } from './purchases';
import type { RebateService } from './rebates';
import type { StockService } from './stock';
import type { StockAnomalyService } from './anomalies';
import { Base, type Clock } from './util';

export type AttentionKey =
  | 'rupture'
  | 'alerte'
  | 'cash_gaps'
  | 'transfers'
  | 'stock_requests'
  | 'sale_edit_requests'
  | 'rebates_pending'
  | 'rebates_balance'
  | 'inventories'
  | 'supplier_invoices'
  | 'late_customers'
  | 'production'
  | 'cash_alerts'
  | 'to_notify'
  | 'store_requests'
  | 'stock_anomalies'
  | 'expenses_pending'
  | 'outages_open';

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

/** 2026-09-30 → 30/09/2026. */
const frDate = (d: string) => d.split('-').reverse().join('/');

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
    private readonly anomalies: StockAnomalyService,
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

    if (want('sale_edit_requests')) {
      const rows = this.db
        .prepare(
          `SELECT s.number || ' (' || u.name || ')' FROM sale_edit_requests r JOIN sales s ON s.id = r.sale_id LEFT JOIN users u ON u.id = r.requested_by
           WHERE r.store_id = ? AND r.status = 'pending' ORDER BY r.created_at`,
        )
        .pluck()
        .all(storeId) as string[];
      items.push({
        key: 'sale_edit_requests',
        label: 'Demandes de modification de facture',
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
          detail: rows.length ? `Du ${frDate(period.from)} au ${frDate(period.to)} : ${firstNames(rows.map((r) => r.customer_name))}` : 'Le mois dernier est constaté',
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

    if (want('cash_alerts')) {
      const rows = this.db
        .prepare(
          `SELECT r.name, a.amount FROM cash_alerts a JOIN registers r ON r.id = a.register_id JOIN cash_sessions s ON s.id = a.session_id
           WHERE a.store_id = ? AND s.status = 'open' ORDER BY a.created_at DESC`,
        )
        .all(storeId) as { name: string; amount: Fcfa }[];
      const byRegister = [...new Map(rows.map((r) => [r.name, r])).values()];
      items.push({
        key: 'cash_alerts',
        label: 'Trop d’espèces dans un tiroir',
        count: byRegister.length,
        amount: byRegister.reduce((t, r) => t + r.amount, 0),
        detail: byRegister.length ? firstNames(byRegister.map((r) => `${r.name} (${formatFcfa(r.amount)})`)) : 'Aucun tiroir au-dessus du plafond',
        tone: 'warning',
      });
    }

    if (want('to_notify')) {
      const since = new Date(this.clock().getTime() - 60 * 86_400_000).toISOString();
      const rows = this.db
        .prepare(
          `SELECT COALESCE(m.customer_name, m.phone) AS who FROM missed_sales m
           WHERE m.store_id = @storeId AND m.phone IS NOT NULL AND m.notified_at IS NULL AND m.article_id IS NOT NULL AND m.created_at >= @since
             AND (SELECT COALESCE(SUM(s.qty), 0) FROM stock s JOIN warehouses w ON w.id = s.warehouse_id WHERE s.article_id = m.article_id AND w.store_id = @storeId AND w.purpose = 'stock') > 0`,
        )
        .pluck()
        .all({ storeId, since }) as string[];
      items.push({
        key: 'to_notify',
        label: 'Clients à prévenir : leur produit est arrivé',
        count: rows.length,
        amount: null,
        detail: rows.length ? firstNames(rows) : 'Personne à prévenir',
        tone: 'info',
      });
    }

    if (want('store_requests')) {
      const r = this.db
        .prepare(
          `SELECT COUNT(CASE WHEN from_store_id = @storeId AND status = 'requested' THEN 1 END) AS ship,
                  COUNT(CASE WHEN to_store_id = @storeId AND status = 'shipped' THEN 1 END) AS receive
           FROM store_transfer_requests WHERE status IN ('requested', 'shipped')`,
        )
        .get({ storeId }) as { ship: number; receive: number };
      items.push({
        key: 'store_requests',
        label: 'Demandes de marchandise entre magasins',
        count: r.ship + r.receive,
        amount: null,
        detail: r.ship + r.receive ? [r.ship ? `${r.ship} à expédier` : '', r.receive ? `${r.receive} à réceptionner` : ''].filter(Boolean).join(', ') : 'Rien à expédier ni à réceptionner',
        tone: 'warning',
      });
    }

    if (want('stock_anomalies')) {
      const cases = this.anomalies.cached(storeId);
      items.push({
        key: 'stock_anomalies',
        label: 'Anomalies de stock à vérifier',
        count: cases.length,
        amount: null,
        detail: cases.length ? firstNames(cases.map((c) => c.title)) : 'Aucun cas douteux trouvé',
        tone: 'warning',
      });
    }

    if (want('expenses_pending')) {
      const r = this.db
        .prepare("SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS total, group_concat(label, '|') AS labels FROM expenses WHERE store_id = ? AND status = 'active' AND approval = 'pending'")
        .get(storeId) as { n: number; total: Fcfa; labels: string | null };
      items.push({
        key: 'expenses_pending',
        label: 'Dépenses à approuver',
        count: r.n,
        amount: r.n ? r.total : null,
        detail: r.n ? firstNames((r.labels ?? '').split('|')) : 'Aucune dépense en attente',
        tone: 'warning',
      });
    }

    if (want('outages_open')) {
      const rows = this.db
        .prepare("SELECT number, declared_total FROM outages WHERE store_id = ? AND status = 'open' ORDER BY started_at")
        .all(storeId) as { number: string; declared_total: Fcfa }[];
      items.push({
        key: 'outages_open',
        label: 'Coupures à finir de saisir',
        count: rows.length,
        amount: rows.length ? rows.reduce((t, r) => t + r.declared_total, 0) : null,
        detail: rows.length ? `Coupure${rows.length > 1 ? 's' : ''} n° ${firstNames(rows.map((r) => r.number))} : saisissez les ventes du cahier puis clôturez` : 'Aucune coupure en cours',
        tone: 'info',
      });
    }

    return items;
  }
}
