import { type Fcfa, type Milli, formatFcfa } from '@superette/core';
import type { CustomerService } from './customers';
import type { Db } from './database';
import { SUPPLIER_PAYMENT_METHODS } from './purchases';
import { AppError, Base, type Clock } from './util';

export interface Period {
  /** AAAA-MM-JJ, bornes comprises. */
  from: string;
  to: string;
}

export interface SalesRegisterFilter extends Period {
  kind?: 'sale' | 'return' | null;
  status?: 'completed' | 'cancelled' | null;
  registerId?: string | null;
  userId?: string | null;
  customerId?: string | null;
  /** Numéro de ticket, nom du client, ou montant exact. */
  search?: string | null;
}

export interface SalesRegisterRow {
  id: string;
  number: string;
  kind: 'sale' | 'return';
  status: 'completed' | 'cancelled';
  created_at: string;
  register_name: string;
  user_name: string;
  customer_name: string | null;
  total_ttc: Fcfa;
  total_discount: Fcfa;
  total_promo: Fcfa;
  methods: string | null;
  original_number: string | null;
  cancel_reason: string | null;
}

export type SalesAlertKind = 'below_cost' | 'discount' | 'cancelled' | 'return' | 'credit_override';

export const SALES_ALERT_LABELS: Record<SalesAlertKind, string> = {
  below_cost: 'Vente à perte',
  discount: 'Remise importante',
  cancelled: 'Ticket annulé',
  return: 'Retour client',
  credit_override: 'Plafond de crédit forcé',
};

export interface SalesAlert {
  kind: SalesAlertKind;
  at: string;
  sale_id: string | null;
  number: string | null;
  user_name: string | null;
  label: string;
  detail: string | null;
  amount: Fcfa;
}

export type CashOperationKind = 'float' | 'in' | 'out' | 'expense' | 'customer_payment' | 'gap';

export const CASH_OPERATION_LABELS: Record<CashOperationKind, string> = {
  float: 'Fonds de caisse',
  in: 'Apport',
  out: 'Prélèvement',
  expense: 'Dépense payée en caisse',
  customer_payment: 'Règlement client',
  gap: 'Écart de clôture',
};

export interface CashOperationRow {
  id: string;
  kind: CashOperationKind;
  at: string;
  register_name: string;
  user_name: string | null;
  label: string;
  /** Positif : entrée d'espèces ; négatif : sortie. */
  amount: Fcfa;
  reference: string | null;
}

export interface AccountLine {
  date: string;
  kind: 'invoice' | 'credit_note' | 'payment' | 'sale' | 'return';
  ref_id: string;
  number: string;
  label: string;
  /** Ce qui augmente la dette (facture fournisseur, vente à crédit). */
  debit: Fcfa;
  credit: Fcfa;
  balance: Fcfa;
}

export interface AccountMovement {
  id: string;
  code: string;
  name: string;
  phone: string | null;
  last_at: string;
  movements: number;
  /** Variation du solde sur la période (positive : la dette a augmenté). */
  change: Fcfa;
  balance: Fcfa;
}

export type CreditStatus = 'over' | 'near' | 'ok' | 'no_limit';

/**
 * Registres et contrôles transverses, rangés comme les menus de KONTROL :
 * registre des ventes, alertes, achats par produit, marchandises non reçues,
 * opérations de caisse, stock par dépôt, comptes fournisseurs et clients.
 * Tout se calcule à partir des documents ; rien n'est stocké ici.
 */
export class ControlService extends Base {
  constructor(
    db: Db,
    clock: Clock,
    private readonly customers: CustomerService,
  ) {
    super(db, clock);
  }

  private checkPeriod(p: Period): void {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(p.from) || !/^\d{4}-\d{2}-\d{2}$/.test(p.to)) throw new AppError('Période invalide', 'INVALID');
    if (p.from > p.to) throw new AppError('La date de début est après la date de fin', 'INVALID');
  }

  // --- Vente ------------------------------------------------------------------

  /** Registre des ventes : tous les tickets et factures d'une période, toutes caisses. */
  salesRegister(storeId: string, f: SalesRegisterFilter, limit = 5000) {
    this.checkPeriod(f);
    const search = f.search?.trim() || null;
    const amount = search && /^-?\d[\d\s]*$/.test(search) ? Number(search.replace(/\s/g, '')) : null;
    const rows = this.db
      .prepare(
        `SELECT s.id, s.number, s.kind, s.status, s.created_at, r.name AS register_name, u.name AS user_name, COALESCE(c.name, s.client_name) AS customer_name,
                s.total_ttc, s.total_discount, s.total_promo, o.number AS original_number, s.cancel_reason,
                (SELECT group_concat(DISTINCT p.method) FROM sale_payments p WHERE p.sale_id = s.id) AS methods
         FROM sales s JOIN registers r ON r.id = s.register_id JOIN users u ON u.id = s.user_id
         LEFT JOIN customers c ON c.id = s.customer_id LEFT JOIN sales o ON o.id = s.original_sale_id
         WHERE s.store_id = @storeId AND date(s.created_at, 'localtime') BETWEEN @from AND @to
           AND (@kind IS NULL OR s.kind = @kind) AND (@status IS NULL OR s.status = @status)
           AND (@register IS NULL OR s.register_id = @register) AND (@user IS NULL OR s.user_id = @user)
           AND (@customer IS NULL OR s.customer_id = @customer)
           AND (@search IS NULL OR s.number LIKE @like OR c.name LIKE @like OR s.client_name LIKE @like OR s.total_ttc = @amount OR -s.total_ttc = @amount)
         ORDER BY s.created_at DESC LIMIT @limit`,
      )
      .all({
        storeId,
        from: f.from,
        to: f.to,
        kind: f.kind ?? null,
        status: f.status ?? null,
        register: f.registerId ?? null,
        user: f.userId ?? null,
        customer: f.customerId ?? null,
        search,
        like: search ? `%${search}%` : null,
        amount,
        limit,
      }) as SalesRegisterRow[];
    const done = rows.filter((r) => r.status === 'completed');
    const sales = done.filter((r) => r.kind === 'sale');
    const returns = done.filter((r) => r.kind === 'return');
    const cancelled = rows.filter((r) => r.status === 'cancelled');
    const sum = (list: SalesRegisterRow[]) => list.reduce((t, r) => t + r.total_ttc, 0);
    return {
      rows,
      truncated: rows.length === limit,
      totals: {
        count: sales.length,
        sales: sum(sales),
        returns: sum(returns),
        returnCount: returns.length,
        net: sum(done),
        discounts: done.reduce((t, r) => t + r.total_discount + r.total_promo, 0),
        cancelled: sum(cancelled),
        cancelledCount: cancelled.length,
      },
      registers: this.db.prepare('SELECT id, name FROM registers WHERE store_id = ? ORDER BY number').all(storeId) as { id: string; name: string }[],
      users: this.db
        .prepare('SELECT DISTINCT u.id, u.name FROM sales s JOIN users u ON u.id = s.user_id WHERE s.store_id = ? ORDER BY u.name')
        .all(storeId) as { id: string; name: string }[],
    };
  }

  /**
   * Alertes sur les ventes : ventes à perte, remises importantes (au moins
   * `discountRate` du prix), annulations, retours et plafonds de crédit forcés.
   */
  salesAlerts(storeId: string, p: Period, opts: { discountRate?: number } = {}): { alerts: SalesAlert[]; counts: Record<SalesAlertKind, number> } {
    this.checkPeriod(p);
    const rate = opts.discountRate ?? 0.1;
    const params = { storeId, from: p.from, to: p.to, rate };
    const inPeriod = "s.store_id = @storeId AND date(s.created_at, 'localtime') BETWEEN @from AND @to";
    const alerts: SalesAlert[] = [];
    // Prix HT de la ligne sous son coût d'achat (CMUP au moment de la vente).
    for (const r of this.db
      .prepare(
        `SELECT s.id, s.number, s.created_at, u.name AS user_name, l.label, l.qty, l.unit_cost,
                ROUND(l.total_ttc * 10000.0 / (10000 + l.vat_rate_bp)) AS ht, ROUND(l.qty * l.unit_cost / 1000.0) AS cost
         FROM sale_lines l JOIN sales s ON s.id = l.sale_id JOIN users u ON u.id = s.user_id
         WHERE ${inPeriod} AND s.kind = 'sale' AND s.status = 'completed' AND l.qty > 0 AND l.unit_cost > 0
           AND ROUND(l.total_ttc * 10000.0 / (10000 + l.vat_rate_bp)) < ROUND(l.qty * l.unit_cost / 1000.0)`,
      )
      .all(params) as { id: string; number: string; created_at: string; user_name: string; label: string; ht: number; cost: number }[]) {
      alerts.push({
        kind: 'below_cost',
        at: r.created_at,
        sale_id: r.id,
        number: r.number,
        user_name: r.user_name,
        label: r.label,
        detail: `Vendu ${formatFcfa(r.ht)} HT pour un coût de ${formatFcfa(r.cost)}`,
        amount: r.cost - r.ht,
      });
    }
    for (const r of this.db
      .prepare(
        `SELECT s.id, s.number, s.created_at, u.name AS user_name, l.label, l.discount, ROUND(l.qty * l.unit_price / 1000.0) AS gross
         FROM sale_lines l JOIN sales s ON s.id = l.sale_id JOIN users u ON u.id = s.user_id
         WHERE ${inPeriod} AND s.kind = 'sale' AND s.status = 'completed' AND l.discount > 0
           AND l.discount >= @rate * ROUND(l.qty * l.unit_price / 1000.0)`,
      )
      .all(params) as { id: string; number: string; created_at: string; user_name: string; label: string; discount: number; gross: number }[]) {
      alerts.push({
        kind: 'discount',
        at: r.created_at,
        sale_id: r.id,
        number: r.number,
        user_name: r.user_name,
        label: r.label,
        detail: `${Math.round((r.discount / r.gross) * 100)} % de remise sur ${formatFcfa(r.gross)}`,
        amount: r.discount,
      });
    }
    for (const r of this.db
      .prepare(
        `SELECT s.id, s.number, s.kind, s.status, s.created_at, s.total_ttc, s.cancel_reason, u.name AS user_name, x.name AS cancelled_by, o.number AS original
         FROM sales s JOIN users u ON u.id = s.user_id LEFT JOIN users x ON x.id = s.cancelled_by LEFT JOIN sales o ON o.id = s.original_sale_id
         WHERE ${inPeriod} AND (s.status = 'cancelled' OR s.kind = 'return')`,
      )
      .all(params) as {
      id: string;
      number: string;
      kind: string;
      status: string;
      created_at: string;
      total_ttc: number;
      cancel_reason: string | null;
      user_name: string;
      cancelled_by: string | null;
      original: string | null;
    }[]) {
      const cancelled = r.status === 'cancelled';
      alerts.push({
        kind: cancelled ? 'cancelled' : 'return',
        at: r.created_at,
        sale_id: r.id,
        number: r.number,
        user_name: r.user_name,
        label: cancelled ? `Annulé${r.cancelled_by ? ` par ${r.cancelled_by}` : ''}` : `Retour sur ${r.original ?? 'ticket inconnu'}`,
        detail: r.cancel_reason,
        amount: Math.abs(r.total_ttc),
      });
    }
    for (const r of this.db
      .prepare(
        `SELECT a.at, a.details, u.name AS user_name, c.name AS customer_name
         FROM audit_log a LEFT JOIN users u ON u.id = a.user_id LEFT JOIN customers c ON c.id = a.entity_id
         WHERE a.action = 'customer.credit_override' AND date(a.at, 'localtime') BETWEEN @from AND @to`,
      )
      .all(params) as { at: string; details: string | null; user_name: string | null; customer_name: string | null }[]) {
      const d = (r.details ? JSON.parse(r.details) : {}) as { balance?: number; limit?: number; amount?: number };
      alerts.push({
        kind: 'credit_override',
        at: r.at,
        sale_id: null,
        number: null,
        user_name: r.user_name,
        label: r.customer_name ?? 'Client',
        detail: d.limit ? `Devait ${formatFcfa(d.balance ?? 0)} pour un plafond de ${formatFcfa(d.limit)}` : `Sans plafond de crédit, devait ${formatFcfa(d.balance ?? 0)}`,
        amount: d.amount ?? 0,
      });
    }
    alerts.sort((a, b) => (a.at < b.at ? 1 : -1));
    const counts = { below_cost: 0, discount: 0, cancelled: 0, return: 0, credit_override: 0 } as Record<SalesAlertKind, number>;
    for (const a of alerts) counts[a.kind]++;
    return { alerts, counts };
  }

  // --- Achats -----------------------------------------------------------------

  /** Registre des achats par produit : quantités et coûts reçus sur la période. */
  purchasesByProduct(storeId: string, p: Period & { supplierId?: string | null }) {
    this.checkPeriod(p);
    const rows = this.db
      .prepare(
        `SELECT a.id AS article_id, a.code, a.name, a.unit, COUNT(DISTINCT r.id) AS receptions,
                SUM(l.qty) AS qty, SUM(ROUND(l.qty * l.unit_cost / 1000.0)) AS amount_ht,
                MIN(l.unit_cost) AS min_cost, MAX(l.unit_cost) AS max_cost,
                (SELECT l2.unit_cost FROM reception_lines l2 JOIN receptions r2 ON r2.id = l2.reception_id
                  WHERE l2.article_id = a.id AND r2.store_id = @storeId ORDER BY r2.received_at DESC LIMIT 1) AS last_cost,
                MAX(r.received_at) AS last_at,
                group_concat(DISTINCT sp.name) AS suppliers
         FROM reception_lines l JOIN receptions r ON r.id = l.reception_id JOIN articles a ON a.id = l.article_id
         LEFT JOIN suppliers sp ON sp.id = r.supplier_id
         WHERE r.store_id = @storeId AND date(r.received_at, 'localtime') BETWEEN @from AND @to
           AND (@supplier IS NULL OR r.supplier_id = @supplier)
         GROUP BY a.id ORDER BY amount_ht DESC`,
      )
      .all({ storeId, from: p.from, to: p.to, supplier: p.supplierId ?? null }) as {
      article_id: string;
      code: string;
      name: string;
      unit: 'piece' | 'kg' | 'litre';
      receptions: number;
      qty: Milli;
      amount_ht: Fcfa;
      min_cost: Fcfa;
      max_cost: Fcfa;
      last_cost: Fcfa;
      last_at: string;
      suppliers: string | null;
    }[];
    return { rows, total: rows.reduce((t, r) => t + r.amount_ht, 0) };
  }

  /** Marchandises commandées et pas encore reçues (bons envoyés, reliquats compris). */
  pendingReceipts(storeId: string) {
    const today = this.today();
    const rows = this.db
      .prepare(
        `SELECT o.id AS order_id, o.number, o.order_date, o.expected_date, sp.name AS supplier_name,
                a.id AS article_id, a.code, a.name, a.unit, l.qty AS ordered, l.unit_cost,
                COALESCE((SELECT SUM(rl.qty) FROM reception_lines rl WHERE rl.order_line_id = l.id), 0) AS received
         FROM purchase_order_lines l JOIN purchase_orders o ON o.id = l.order_id
         JOIN suppliers sp ON sp.id = o.supplier_id JOIN articles a ON a.id = l.article_id
         WHERE o.store_id = ? AND o.status = 'sent'
         ORDER BY COALESCE(o.expected_date, o.order_date), o.number, l.line_no`,
      )
      .all(storeId) as {
      order_id: string;
      number: string;
      order_date: string;
      expected_date: string | null;
      supplier_name: string;
      article_id: string;
      code: string;
      name: string;
      unit: 'piece' | 'kg' | 'litre';
      ordered: Milli;
      unit_cost: Fcfa;
      received: Milli;
    }[];
    const lines = rows
      .filter((r) => r.received < r.ordered)
      .map((r) => {
        const remaining = r.ordered - r.received;
        return { ...r, remaining, value: Math.round((remaining * r.unit_cost) / 1000), late: Boolean(r.expected_date && r.expected_date < today) };
      });
    return {
      lines,
      orders: new Set(lines.map((l) => l.order_id)).size,
      value: lines.reduce((t, l) => t + l.value, 0),
      late: lines.filter((l) => l.late).reduce((t, l) => t + l.value, 0),
    };
  }

  // --- Trésorerie -------------------------------------------------------------

  /**
   * Listing des opérations de caisse : fonds de caisse, apports, prélèvements,
   * dépenses payées au tiroir, règlements clients en espèces et écarts de clôture.
   */
  cashOperations(storeId: string, p: Period & { registerId?: string | null }) {
    this.checkPeriod(p);
    const params = { storeId, from: p.from, to: p.to, register: p.registerId ?? null };
    const session = "cs.store_id = @storeId AND (@register IS NULL OR cs.register_id = @register)";
    const rows = this.db
      .prepare(
        `SELECT 'float:' || cs.id AS id, 'float' AS kind, cs.opened_at AS at, r.name AS register_name, u.name AS user_name,
                'Ouverture de caisse' AS label, cs.opening_float AS amount, NULL AS reference
         FROM cash_sessions cs JOIN registers r ON r.id = cs.register_id LEFT JOIN users u ON u.id = cs.user_id
         WHERE ${session} AND date(cs.opened_at, 'localtime') BETWEEN @from AND @to
         UNION ALL
         SELECT o.id, CASE o.type WHEN 'IN' THEN 'in' ELSE 'out' END, o.at, r.name, u.name, o.reason,
                CASE o.type WHEN 'IN' THEN o.amount ELSE -o.amount END, NULL
         FROM cash_operations o JOIN cash_sessions cs ON cs.id = o.session_id JOIN registers r ON r.id = cs.register_id
         LEFT JOIN users u ON u.id = o.user_id
         WHERE ${session} AND date(o.at, 'localtime') BETWEEN @from AND @to
         UNION ALL
         SELECT e.id, 'expense', e.created_at, r.name, u.name, e.label, -e.amount, e.number
         FROM expenses e JOIN cash_sessions cs ON cs.id = e.session_id JOIN registers r ON r.id = cs.register_id
         LEFT JOIN users u ON u.id = e.user_id
         WHERE ${session} AND e.status = 'active' AND date(e.created_at, 'localtime') BETWEEN @from AND @to
         UNION ALL
         SELECT cp.id, 'customer_payment', cp.paid_at, r.name, u.name, c.name, cp.amount, cp.number
         FROM customer_payments cp JOIN cash_sessions cs ON cs.id = cp.session_id JOIN registers r ON r.id = cs.register_id
         JOIN customers c ON c.id = cp.customer_id LEFT JOIN users u ON u.id = cp.user_id
         WHERE ${session} AND cp.method = 'CASH' AND date(cp.paid_at, 'localtime') BETWEEN @from AND @to
         UNION ALL
         SELECT 'gap:' || cs.id, 'gap', cs.closed_at, r.name, u.name, 'Clôture Z n° ' || cs.z_number, cs.difference, NULL
         FROM cash_sessions cs JOIN registers r ON r.id = cs.register_id LEFT JOIN users u ON u.id = cs.closed_by
         WHERE ${session} AND cs.status = 'closed' AND cs.difference <> 0 AND date(cs.closed_at, 'localtime') BETWEEN @from AND @to
         ORDER BY at DESC`,
      )
      .all(params) as CashOperationRow[];
    const totals = { float: 0, in: 0, out: 0, expense: 0, customer_payment: 0, gap: 0 } as Record<CashOperationKind, Fcfa>;
    for (const r of rows) totals[r.kind] += r.amount;
    return { rows, totals, registers: this.db.prepare('SELECT id, name FROM registers WHERE store_id = ? ORDER BY number').all(storeId) as { id: string; name: string }[] };
  }

  // --- Produit ----------------------------------------------------------------

  /** Articles par dépôt : une colonne de quantité par dépôt du magasin. */
  stockByWarehouse(storeId: string, opts: { search?: string | null; inStockOnly?: boolean } = {}) {
    const warehouses = this.db.prepare('SELECT id, name FROM warehouses WHERE store_id = ? ORDER BY name').all(storeId) as { id: string; name: string }[];
    const rows = this.db
      .prepare(
        `SELECT a.id AS article_id, a.code, a.name, a.unit, s.warehouse_id, s.qty
         FROM articles a LEFT JOIN stock s ON s.article_id = a.id AND s.warehouse_id IN (SELECT id FROM warehouses WHERE store_id = @storeId)
         WHERE a.active = 1 AND (@search IS NULL OR a.name LIKE @search OR a.code LIKE @search)
         ORDER BY a.name`,
      )
      .all({ storeId, search: opts.search?.trim() ? `%${opts.search.trim()}%` : null }) as {
      article_id: string;
      code: string;
      name: string;
      unit: 'piece' | 'kg' | 'litre';
      warehouse_id: string | null;
      qty: Milli | null;
    }[];
    const byArticle = new Map<string, { article_id: string; code: string; name: string; unit: 'piece' | 'kg' | 'litre'; qty: Record<string, Milli>; total: Milli }>();
    for (const r of rows) {
      const a = byArticle.get(r.article_id) ?? { article_id: r.article_id, code: r.code, name: r.name, unit: r.unit, qty: {}, total: 0 };
      if (r.warehouse_id && r.qty) {
        a.qty[r.warehouse_id] = (a.qty[r.warehouse_id] ?? 0) + r.qty;
        a.total += r.qty;
      }
      byArticle.set(r.article_id, a);
    }
    const articles = [...byArticle.values()].filter((a) => !opts.inStockOnly || Object.values(a.qty).some((q) => q !== 0));
    return { warehouses, articles };
  }

  /** Rayonnage : chaque rayon et famille avec ses articles, son stock et ses ruptures. */
  shelving(storeId: string) {
    const rows = this.db
      .prepare(
        `WITH st AS (
           SELECT s.article_id, SUM(s.qty) AS qty, SUM(CASE WHEN s.qty > 0 THEN s.qty * s.avg_cost ELSE 0 END) / 1000 AS value
           FROM stock s JOIN warehouses w ON w.id = s.warehouse_id WHERE w.store_id = @storeId GROUP BY s.article_id
         )
         SELECT d.id AS department_id, COALESCE(d.name, 'Sans rayon') AS department, f.id AS family_id, COALESCE(f.name, 'Sans famille') AS family,
                COUNT(a.id) AS articles, SUM(CASE WHEN COALESCE(st.qty, 0) > 0 THEN 1 ELSE 0 END) AS in_stock,
                SUM(CASE WHEN COALESCE(st.qty, 0) <= 0 THEN 1 ELSE 0 END) AS out_of_stock,
                CAST(ROUND(COALESCE(SUM(st.value), 0)) AS INTEGER) AS value
         FROM articles a LEFT JOIN families f ON f.id = a.family_id LEFT JOIN departments d ON d.id = f.department_id
         LEFT JOIN st ON st.article_id = a.id
         WHERE a.active = 1
         GROUP BY d.id, f.id
         UNION ALL
         SELECT d.id, d.name, f.id, f.name, 0, 0, 0, 0
         FROM families f JOIN departments d ON d.id = f.department_id
         WHERE NOT EXISTS (SELECT 1 FROM articles a WHERE a.family_id = f.id AND a.active = 1)
         ORDER BY 2, 4`,
      )
      .all({ storeId }) as {
      department_id: string | null;
      department: string;
      family_id: string | null;
      family: string;
      articles: number;
      in_stock: number;
      out_of_stock: number;
      value: Fcfa;
    }[];
    return { rows, value: rows.reduce((t, r) => t + r.value, 0), articles: rows.reduce((t, r) => t + r.articles, 0) };
  }

  // --- Fournisseur ------------------------------------------------------------

  private supplierLines(storeId: string, supplierId: string) {
    const rows = this.db
      .prepare(
        `SELECT * FROM (
         SELECT invoice_date AS date, kind, id AS ref_id, number,
                CASE kind WHEN 'invoice' THEN 'Facture ' ELSE 'Avoir ' END || supplier_number AS label,
                CASE kind WHEN 'invoice' THEN total_ttc ELSE -total_ttc END AS amount
         FROM supplier_invoices WHERE store_id = @storeId AND supplier_id = @supplierId
         UNION ALL
         SELECT substr(p.paid_at, 1, 10), 'payment', p.id, i.number, p.method || '|' || COALESCE(p.reference, ''), -p.amount
         FROM supplier_payments p JOIN supplier_invoices i ON i.id = p.invoice_id
         WHERE p.store_id = @storeId AND p.supplier_id = @supplierId
         ) ORDER BY date, kind = 'payment', number`,
      )
      .all({ storeId, supplierId }) as { date: string; kind: 'invoice' | 'credit_note' | 'payment'; ref_id: string; number: string; label: string; amount: number }[];
    for (const l of rows) {
      if (l.kind !== 'payment') continue;
      const [method, reference] = l.label.split('|');
      l.label = `Règlement ${SUPPLIER_PAYMENT_METHODS[method as keyof typeof SUPPLIER_PAYMENT_METHODS] ?? method}${reference ? ` ${reference}` : ''}`;
    }
    return rows;
  }

  /** Extrait de compte fournisseur : factures, avoirs et règlements avec solde progressif. */
  supplierStatement(storeId: string, supplierId: string, p: Partial<Period> = {}) {
    const supplier = this.db.prepare('SELECT id, code, name FROM suppliers WHERE id = ?').get(supplierId) as { id: string; code: string; name: string } | undefined;
    if (!supplier) throw new AppError('Fournisseur introuvable', 'NOT_FOUND');
    return { supplier, ...this.runningStatement(this.supplierLines(storeId, supplierId), p) };
  }

  private runningStatement(
    all: { date: string; kind: AccountLine['kind']; ref_id: string; number: string; label: string; amount: number }[],
    p: Partial<Period>,
  ): { opening: Fcfa; lines: AccountLine[]; closing: Fcfa; debit: Fcfa; credit: Fcfa } {
    let balance = 0;
    let opening = 0;
    const lines: AccountLine[] = [];
    for (const l of all) {
      const d = l.date.slice(0, 10);
      if (p.to && d > p.to) continue;
      balance += l.amount;
      if (p.from && d < p.from) {
        opening = balance;
        continue;
      }
      lines.push({ date: l.date, kind: l.kind, ref_id: l.ref_id, number: l.number, label: l.label, debit: Math.max(0, l.amount), credit: Math.max(0, -l.amount), balance });
    }
    return {
      opening,
      lines,
      closing: balance,
      debit: lines.reduce((t, l) => t + l.debit, 0),
      credit: lines.reduce((t, l) => t + l.credit, 0),
    };
  }

  /** Situation des fournisseurs : facturé, réglé, solde et part échue de chacun. */
  supplierSituation(storeId: string) {
    const today = this.today();
    const invoices = this.db
      .prepare(
        `SELECT i.supplier_id, i.kind, i.total_ttc, i.due_date,
                COALESCE((SELECT SUM(p.amount) FROM supplier_payments p WHERE p.invoice_id = i.id), 0) AS paid
         FROM supplier_invoices i WHERE i.store_id = ?`,
      )
      .all(storeId) as { supplier_id: string; kind: 'invoice' | 'credit_note'; total_ttc: Fcfa; due_date: string; paid: Fcfa }[];
    const suppliers = this.db.prepare('SELECT id, code, name, phone, payment_terms_days FROM suppliers ORDER BY name').all() as {
      id: string;
      code: string;
      name: string;
      phone: string | null;
      payment_terms_days: number;
    }[];
    const rows = suppliers
      .map((s) => {
        const mine = invoices.filter((i) => i.supplier_id === s.id);
        const invoiced = mine.filter((i) => i.kind === 'invoice').reduce((t, i) => t + i.total_ttc, 0);
        const credits = mine.filter((i) => i.kind === 'credit_note').reduce((t, i) => t + i.total_ttc, 0);
        const paid = mine.reduce((t, i) => t + i.paid, 0);
        const overdue = mine.filter((i) => i.kind === 'invoice' && i.due_date < today).reduce((t, i) => t + Math.max(0, i.total_ttc - i.paid), 0);
        return { ...s, invoiced, credits, paid, balance: invoiced - credits - paid, overdue, invoices: mine.length };
      })
      .filter((s) => s.invoices > 0);
    const sum = (k: 'invoiced' | 'credits' | 'paid' | 'balance' | 'overdue') => rows.reduce((t, r) => t + r[k], 0);
    return { rows, totals: { invoiced: sum('invoiced'), credits: sum('credits'), paid: sum('paid'), balance: sum('balance'), overdue: sum('overdue') } };
  }

  /** Comptes fournisseurs ou clients dont le solde a bougé ces `days` derniers jours. */
  recentAccounts(storeId: string, party: 'supplier' | 'customer', days = 7): AccountMovement[] {
    const since = new Date(Date.parse(`${this.today()}T00:00:00Z`) - (days - 1) * 86_400_000).toISOString().slice(0, 10);
    if (party === 'supplier') {
      const moved = this.db
        .prepare(
          `SELECT supplier_id AS id, COUNT(*) AS movements, MAX(date) AS last_at, SUM(amount) AS change FROM (
             SELECT supplier_id, invoice_date AS date, CASE kind WHEN 'invoice' THEN total_ttc ELSE -total_ttc END AS amount
             FROM supplier_invoices WHERE store_id = @storeId AND invoice_date >= @since
             UNION ALL
             SELECT supplier_id, substr(paid_at, 1, 10), -amount FROM supplier_payments WHERE store_id = @storeId AND substr(paid_at, 1, 10) >= @since
           ) GROUP BY supplier_id`,
        )
        .all({ storeId, since }) as { id: string; movements: number; last_at: string; change: number }[];
      return moved
        .map((m) => {
          const s = this.db.prepare('SELECT code, name, phone FROM suppliers WHERE id = ?').get(m.id) as { code: string; name: string; phone: string | null };
          const balance = this.supplierLines(storeId, m.id).reduce((t, l) => t + l.amount, 0);
          return { ...m, ...s, balance };
        })
        .sort((a, b) => (a.last_at < b.last_at ? 1 : -1));
    }
    const moved = this.db
      .prepare(
        `SELECT customer_id AS id, COUNT(*) AS movements, MAX(at) AS last_at, SUM(amount) AS change FROM (
           SELECT s.customer_id, s.created_at AS at, SUM(p.amount) AS amount
           FROM sales s JOIN sale_payments p ON p.sale_id = s.id
           WHERE s.store_id = @storeId AND s.status = 'completed' AND p.method = 'CUSTOMER_CREDIT' AND date(s.created_at, 'localtime') >= @since
           GROUP BY s.id
           UNION ALL
           SELECT customer_id, paid_at, -amount FROM customer_payments WHERE store_id = @storeId AND date(paid_at, 'localtime') >= @since
         ) GROUP BY customer_id`,
      )
      .all({ storeId, since }) as { id: string; movements: number; last_at: string; change: number }[];
    return moved
      .map((m) => {
        const account = this.customers.account(storeId, m.id);
        return { ...m, code: account.customer.code, name: account.customer.name, phone: account.customer.phone, balance: account.balance };
      })
      .sort((a, b) => (a.last_at < b.last_at ? 1 : -1));
  }

  // --- Client -----------------------------------------------------------------

  /**
   * Contrôle des plafonds d'autorisation : chaque client à crédit, ce qu'il doit
   * face à son plafond. « near » à partir de 80 % du plafond.
   */
  creditControl(storeId: string) {
    const rows = this.customers
      .listCustomers(storeId)
      .filter((c) => c.credit_limit > 0 || c.balance !== 0)
      .map((c) => {
        const used = c.credit_limit > 0 ? c.balance / c.credit_limit : null;
        const status: CreditStatus = c.credit_limit === 0 ? 'no_limit' : c.balance > c.credit_limit ? 'over' : used! >= 0.8 ? 'near' : 'ok';
        return {
          id: c.id,
          code: c.code,
          name: c.name,
          phone: c.phone,
          credit_limit: c.credit_limit,
          balance: c.balance,
          overdue: c.overdue,
          available: Math.max(0, c.credit_limit - c.balance),
          used,
          status,
        };
      });
    const order: Record<CreditStatus, number> = { over: 0, no_limit: 1, near: 2, ok: 3 };
    rows.sort((a, b) => order[a.status] - order[b.status] || b.balance - a.balance);
    return {
      rows,
      counts: {
        over: rows.filter((r) => r.status === 'over').length,
        near: rows.filter((r) => r.status === 'near').length,
        noLimit: rows.filter((r) => r.status === 'no_limit' && r.balance > 0).length,
      },
    };
  }
}
