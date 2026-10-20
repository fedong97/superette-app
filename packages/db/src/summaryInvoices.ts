import { type Fcfa, type Milli, splitTtc } from '@superette/core';
import { AppError, Base, type Context, newId } from './util';

/** Vente (ou retour) d'un client reprise sur une facture récapitulative. */
export interface SummarySale {
  id: string;
  number: string;
  kind: 'sale' | 'return';
  date: string;
  total_ht: Fcfa;
  total_tva: Fcfa;
  total_ttc: Fcfa;
  /** Part de la vente passée au compte du client (à crédit). */
  on_credit: Fcfa;
}

export interface SummaryInvoice {
  id: string;
  number: string;
  store_id: string;
  customer_id: string;
  customer_name: string;
  customer_code: string;
  period_from: string;
  period_to: string;
  total_ht: Fcfa;
  total_tva: Fcfa;
  total_ttc: Fcfa;
  status: 'active' | 'cancelled';
  user_name: string | null;
  created_at: string;
  sale_count: number;
}

export interface SummaryInvoiceDetail extends SummaryInvoice {
  sales: (SummarySale & {
    lines: { label: string; qty: Milli; unit: 'piece' | 'kg' | 'litre'; pack_name: string | null; pack_units: number | null; unit_price: Fcfa; total_ttc: Fcfa; vat_rate_bp: number }[];
  })[];
  /** TVA par taux, sur l'ensemble des ventes. */
  vat: { rate_bp: number; ht: Fcfa; tva: Fcfa }[];
  /** Ce qui reste dû sur la période (ventes à crédit). */
  on_credit: Fcfa;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Facture récapitulative (Sage : facturation des bons de livraison) : les
 * tickets et factures d'un client sur une période, sur une seule facture de
 * fin de mois. Les ventes sont déjà comptabilisées une à une : la
 * récapitulative ne passe pas d'écriture, elle les regroupe pour le client.
 * Une vente ne figure que sur une récapitulative active.
 */
export class SummaryInvoiceService extends Base {
  /** Ventes du client sur la période, pas encore reprises sur une récapitulative. */
  candidates(storeId: string, customerId: string, from: string, to: string): SummarySale[] {
    if (!DAY.test(from) || !DAY.test(to) || to < from) throw new AppError('Période invalide', 'INVALID');
    const taken = this.takenSaleIds(storeId, customerId);
    const rows = this.db
      .prepare(
        `SELECT s.id, s.number, s.kind, date(s.created_at, 'localtime') AS date, s.total_ht, s.total_tva, s.total_ttc,
                COALESCE((SELECT SUM(p.amount) FROM sale_payments p WHERE p.sale_id = s.id AND p.method = 'CUSTOMER_CREDIT'), 0) AS on_credit
         FROM sales s
         WHERE s.store_id = ? AND s.customer_id = ? AND s.status = 'completed' AND s.hidden = 0
           AND date(s.created_at, 'localtime') BETWEEN ? AND ?
         ORDER BY s.created_at, s.number`,
      )
      .all(storeId, customerId, from, to) as SummarySale[];
    return rows.filter((r) => !taken.has(r.id));
  }

  create(ctx: Context, input: { customerId: string; from: string; to: string; saleIds?: string[] }): SummaryInvoiceDetail {
    const customer = this.db.prepare('SELECT id, name FROM customers WHERE id = ?').get(input.customerId) as { id: string; name: string } | undefined;
    if (!customer) throw new AppError('Client introuvable', 'NOT_FOUND');
    let sales = this.candidates(ctx.storeId, customer.id, input.from, input.to);
    if (input.saleIds) {
      const wanted = new Set(input.saleIds);
      sales = sales.filter((s) => wanted.has(s.id));
    }
    if (sales.length === 0) throw new AppError(`Aucune vente de ${customer.name} à reprendre sur cette période`, 'EMPTY');
    const total = (k: 'total_ht' | 'total_tva' | 'total_ttc') => sales.reduce((t, s) => t + s[k], 0);
    return this.tx(() => {
      const id = newId();
      const now = this.now();
      const prefix = 'FR';
      const number = `${prefix}-${this.stationPrefix()}-${String(this.nextCounter('summary_invoice.number')).padStart(5, '0')}`;
      this.db
        .prepare(
          `INSERT INTO summary_invoices (id, number, store_id, customer_id, period_from, period_to, sale_ids, total_ht, total_tva, total_ttc, status, user_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
        )
        .run(id, number, ctx.storeId, customer.id, input.from, input.to, JSON.stringify(sales.map((s) => s.id)), total('total_ht'), total('total_tva'), total('total_ttc'), ctx.userId, now, now);
      this.enqueue(ctx, 'summary_invoice', id, 'upsert', {});
      this.audit(ctx.userId, 'summary_invoice.create', 'summary_invoice', id, { customer: customer.name, sales: sales.length, ttc: total('total_ttc') });
      return this.get(id);
    });
  }

  /** Annule une récapitulative (erreur de période) : ses ventes pourront être reprises sur une autre. */
  cancel(ctx: Context, id: string): SummaryInvoice {
    const inv = this.get(id);
    if (inv.store_id !== ctx.storeId) throw new AppError("Cette facture est d'un autre magasin", 'FORBIDDEN');
    if (inv.status === 'cancelled') return inv;
    this.tx(() => {
      this.db.prepare("UPDATE summary_invoices SET status = 'cancelled', updated_at = ? WHERE id = ?").run(this.now(), id);
      this.enqueue(ctx, 'summary_invoice', id, 'upsert', {});
      this.audit(ctx.userId, 'summary_invoice.cancel', 'summary_invoice', id, { number: inv.number });
    });
    return this.get(id);
  }

  list(storeId: string, opts: { customerId?: string | null } = {}): SummaryInvoice[] {
    return this.query('i.store_id = @storeId AND (@customerId IS NULL OR i.customer_id = @customerId)', 300).all({
      storeId,
      customerId: opts.customerId ?? null,
    }) as SummaryInvoice[];
  }

  get(id: string): SummaryInvoiceDetail {
    const head = this.query('i.id = @id', 1).get({ id }) as SummaryInvoice | undefined;
    if (!head) throw new AppError('Facture récapitulative introuvable', 'NOT_FOUND');
    const ids = JSON.parse((this.db.prepare('SELECT sale_ids FROM summary_invoices WHERE id = ?').pluck().get(id) as string) || '[]') as string[];
    const saleRow = this.db.prepare(
      `SELECT s.id, s.number, s.kind, date(s.created_at, 'localtime') AS date, s.total_ht, s.total_tva, s.total_ttc,
              COALESCE((SELECT SUM(p.amount) FROM sale_payments p WHERE p.sale_id = s.id AND p.method = 'CUSTOMER_CREDIT'), 0) AS on_credit
       FROM sales s WHERE s.id = ?`,
    );
    const lineRows = this.db.prepare(
      `SELECT l.label, l.qty, a.unit, l.pack_name, l.pack_units, l.unit_price, l.total_ttc, l.vat_rate_bp
       FROM sale_lines l JOIN articles a ON a.id = l.article_id WHERE l.sale_id = ? ORDER BY l.line_no`,
    );
    const sales = ids
      .map((sid) => saleRow.get(sid) as SummarySale | undefined)
      .filter((s): s is SummarySale => !!s)
      .map((s) => ({ ...s, lines: lineRows.all(s.id) as SummaryInvoiceDetail['sales'][number]['lines'] }));
    const byRate = new Map<number, number>();
    for (const s of sales) for (const l of s.lines) byRate.set(l.vat_rate_bp, (byRate.get(l.vat_rate_bp) ?? 0) + l.total_ttc);
    const vat = [...byRate.entries()]
      .sort(([a], [b]) => a - b)
      .map(([rate, ttc]) => ({ rate_bp: rate, ...splitTtc(ttc, rate) }))
      .map(({ rate_bp, ht, tva }) => ({ rate_bp, ht, tva }));
    return { ...head, sales, vat, on_credit: sales.reduce((t, s) => t + s.on_credit, 0) };
  }

  private takenSaleIds(storeId: string, customerId: string): Set<string> {
    const rows = this.db
      .prepare("SELECT sale_ids FROM summary_invoices WHERE store_id = ? AND customer_id = ? AND status = 'active'")
      .pluck()
      .all(storeId, customerId) as string[];
    return new Set(rows.flatMap((r) => JSON.parse(r || '[]') as string[]));
  }

  private query(where: string, limit: number) {
    return this.db.prepare(
      `SELECT i.id, i.number, i.store_id, i.customer_id, c.name AS customer_name, c.code AS customer_code, i.period_from, i.period_to,
              i.total_ht, i.total_tva, i.total_ttc, i.status, u.name AS user_name, i.created_at, json_array_length(i.sale_ids) AS sale_count
       FROM summary_invoices i JOIN customers c ON c.id = i.customer_id LEFT JOIN users u ON u.id = i.user_id
       WHERE ${where} ORDER BY i.created_at DESC LIMIT ${limit}`,
    );
  }
}
