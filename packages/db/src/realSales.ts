import { type Fcfa, PAYMENT_METHODS, splitTtc } from '@superette/core';
import { AppError, Base } from './util';

/** Période de consultation, dates locales AAAA-MM-JJ incluses. */
export interface SalesPeriod {
  from: string;
  to: string;
}

export type RealSaleFilter = 'all' | 'sales' | 'returns' | 'cancelled';

/** Une opération de vente telle qu'elle a eu lieu : vente, remboursement (retour) ou annulation. */
export interface RealSaleRow {
  /** Identifiant commun avec la préparation fiscale. */
  id: string;
  number: string;
  kind: 'sale' | 'return';
  status: 'completed' | 'cancelled';
  /** Annulée puis « supprimée » du registre : gardée ici, la source ne cache rien. */
  hidden: number;
  created_at: string;
  register_name: string | null;
  user_name: string | null;
  customer_id: string | null;
  customer_name: string | null;
  total_ttc: Fcfa;
  total_ht: Fcfa;
  total_tva: Fcfa;
  total_discount: Fcfa;
  change_given: Fcfa;
  original_sale_id: string | null;
  original_number: string | null;
  replaces_id: string | null;
  replaces_number: string | null;
  replaced_by_number: string | null;
  cancel_reason: string | null;
  cancelled_by_name: string | null;
  /** Moyens de paiement : « Espèces 5 000 · MTN Mobile Money 2 000 ». */
  payments: string;
}

export interface RealSaleDetail extends RealSaleRow {
  ticket_prints: number;
  invoice_prints: number;
  lines: { line_no: number; article_id: string; label: string; barcode: string | null; qty: number; unit_price: Fcfa; discount: Fcfa; vat_rate_bp: number; total_ttc: Fcfa }[];
  paymentLines: { method: string; label: string; amount: Fcfa; reference: string | null }[];
  /** TVA de la vente, taux par taux. */
  vat: { rate: number; ttc: Fcfa; ht: Fcfa; tva: Fcfa }[];
  /** Retours faits sur cette vente. */
  returns: { id: string; number: string; created_at: string; status: string; total_ttc: Fcfa; cancel_reason: string | null }[];
}

export interface RealPaymentRow {
  at: string;
  source: 'sale' | 'customer_payment';
  doc_id: string;
  doc_number: string;
  /** Statut de la vente payée (un paiement d'une vente annulée ne compte plus). */
  doc_status: string | null;
  method: string;
  method_label: string;
  amount: Fcfa;
  reference: string | null;
  customer_name: string | null;
  user_name: string | null;
}

export interface RealSalesSummary {
  period: SalesPeriod;
  sales: { count: number; ttc: Fcfa; ht: Fcfa; tva: Fcfa; discount: Fcfa };
  returns: { count: number; ttc: Fcfa; ht: Fcfa; tva: Fcfa };
  cancelled: { count: number; ttc: Fcfa };
  /** Chiffre d'affaires réel : ventes moins remboursements, annulations exclues. */
  net: { ttc: Fcfa; ht: Fcfa; tva: Fcfa };
  byMethod: { method: string; label: string; amount: Fcfa }[];
  customerPayments: { count: number; amount: Fcfa };
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const methodLabel = (m: string) => PAYMENT_METHODS[m as keyof typeof PAYMENT_METHODS] ?? m;
const esc = (v: string | number | null | undefined) => {
  const s = String(v ?? '');
  return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const csv = (header: string[], rows: (string | number | null)[][]) => '﻿' + [header.join(';'), ...rows.map((r) => r.map(esc).join(';'))].join('\r\n');

/**
 * Ventes réelles : la source de référence de toutes les opérations de vente
 * (factures, tickets, paiements, annulations, remboursements), telles qu'elles
 * ont été enregistrées à la caisse. Ce module ne fait que lire : rien n'est
 * masqué, pas même les factures « supprimées » du registre.
 */
export class RealSalesService extends Base {
  private check(p: SalesPeriod): void {
    if (!DATE.test(p.from) || !DATE.test(p.to) || p.from > p.to) throw new AppError('Période invalide', 'INVALID');
  }

  operations(storeId: string, p: SalesPeriod & { filter?: RealSaleFilter; q?: string | null; limit?: number }): RealSaleRow[] {
    this.check(p);
    const filter = p.filter ?? 'all';
    const q = p.q?.trim() ? `%${p.q.trim().toLowerCase()}%` : null;
    const rows = this.db
      .prepare(
        `SELECT s.id, s.number, s.kind, s.status, s.hidden, s.created_at, r.name AS register_name, u.name AS user_name,
           s.customer_id, COALESCE(c.name, s.client_name) AS customer_name, s.total_ttc, s.total_ht, s.total_tva, s.total_discount,
           s.change_given, s.original_sale_id, o.number AS original_number, s.replaces_id, rp.number AS replaces_number,
           (SELECT n.number FROM sales n WHERE n.replaces_id = s.id LIMIT 1) AS replaced_by_number,
           s.cancel_reason, cb.name AS cancelled_by_name,
           (SELECT GROUP_CONCAT(p.method || ':' || p.amount, '|') FROM sale_payments p WHERE p.sale_id = s.id) AS pay
         FROM sales s
         LEFT JOIN registers r ON r.id = s.register_id
         LEFT JOIN users u ON u.id = s.user_id
         LEFT JOIN users cb ON cb.id = s.cancelled_by
         LEFT JOIN customers c ON c.id = s.customer_id
         LEFT JOIN sales o ON o.id = s.original_sale_id
         LEFT JOIN sales rp ON rp.id = s.replaces_id
         WHERE s.store_id = @storeId AND date(s.created_at, 'localtime') BETWEEN @from AND @to
           AND (@filter = 'all' OR (@filter = 'sales' AND s.kind = 'sale') OR (@filter = 'returns' AND s.kind = 'return') OR (@filter = 'cancelled' AND s.status = 'cancelled'))
           AND (@q IS NULL OR lower(s.number) LIKE @q OR lower(COALESCE(c.name, s.client_name, '')) LIKE @q OR s.id = @raw)
         ORDER BY s.created_at, s.number LIMIT @limit`,
      )
      .all({ storeId, from: p.from, to: p.to, filter, q, raw: p.q?.trim() ?? '', limit: p.limit ?? 5000 }) as (Omit<RealSaleRow, 'payments'> & { pay: string | null })[];
    return rows.map(({ pay, ...r }) => ({ ...r, payments: this.payLabel(pay) }));
  }

  private payLabel(pay: string | null): string {
    if (!pay) return '';
    return pay
      .split('|')
      .map((x) => {
        const [m, a] = x.split(':');
        return `${methodLabel(m!)} ${Number(a).toLocaleString('fr-FR').replace(/ | /g, ' ')}`;
      })
      .join(' · ');
  }

  detail(id: string): RealSaleDetail {
    const head = this.db.prepare('SELECT store_id, created_at FROM sales WHERE id = ?').get(id) as { store_id: string; created_at: string } | undefined;
    if (!head) throw new AppError('Vente introuvable', 'NOT_FOUND');
    const day = this.db.prepare("SELECT date(?, 'localtime')").pluck().get(head.created_at) as string;
    const row = this.operations(head.store_id, { from: day, to: day, q: id, limit: 1 }).find((r) => r.id === id)!;
    const extra = this.db.prepare('SELECT ticket_prints, invoice_prints FROM sales WHERE id = ?').get(id) as { ticket_prints: number; invoice_prints: number };
    const lines = this.db
      .prepare('SELECT line_no, article_id, label, barcode, qty, unit_price, discount, vat_rate_bp, total_ttc FROM sale_lines WHERE sale_id = ? ORDER BY line_no')
      .all(id) as RealSaleDetail['lines'];
    const paymentLines = (this.db.prepare('SELECT method, amount, reference FROM sale_payments WHERE sale_id = ?').all(id) as { method: string; amount: number; reference: string | null }[]).map((p) => ({
      ...p,
      label: methodLabel(p.method),
    }));
    const byRate = new Map<number, number>();
    for (const l of lines) byRate.set(l.vat_rate_bp, (byRate.get(l.vat_rate_bp) ?? 0) + l.total_ttc);
    const vat = [...byRate.entries()].sort(([a], [b]) => b - a).map(([rate, ttc]) => ({ rate, ttc, ...splitTtc(ttc, rate) }));
    const returns = this.db
      .prepare('SELECT id, number, created_at, status, total_ttc, cancel_reason FROM sales WHERE original_sale_id = ? ORDER BY created_at')
      .all(id) as RealSaleDetail['returns'];
    return { ...row, ...extra, lines, paymentLines, vat, returns };
  }

  payments(storeId: string, p: SalesPeriod): RealPaymentRow[] {
    this.check(p);
    const rows = this.db
      .prepare(
        `SELECT s.created_at AS at, 'sale' AS source, s.id AS doc_id, s.number AS doc_number, s.status AS doc_status, p.method, p.amount, p.reference,
                COALESCE(c.name, s.client_name) AS customer_name, u.name AS user_name
         FROM sale_payments p JOIN sales s ON s.id = p.sale_id LEFT JOIN customers c ON c.id = s.customer_id LEFT JOIN users u ON u.id = s.user_id
         WHERE s.store_id = @storeId AND date(s.created_at, 'localtime') BETWEEN @from AND @to
         UNION ALL
         SELECT cp.paid_at, 'customer_payment', cp.id, cp.number, NULL, cp.method, cp.amount, cp.reference, c.name, u.name
         FROM customer_payments cp LEFT JOIN customers c ON c.id = cp.customer_id LEFT JOIN users u ON u.id = cp.user_id
         WHERE cp.store_id = @storeId AND date(cp.paid_at, 'localtime') BETWEEN @from AND @to
         ORDER BY 1, 4`,
      )
      .all({ storeId, from: p.from, to: p.to }) as Omit<RealPaymentRow, 'method_label'>[];
    return rows.map((r) => ({ ...r, method_label: methodLabel(r.method) }));
  }

  summary(storeId: string, p: SalesPeriod): RealSalesSummary {
    this.check(p);
    const agg = this.db
      .prepare(
        `SELECT
           COUNT(CASE WHEN kind = 'sale' AND status = 'completed' THEN 1 END) AS sc,
           COALESCE(SUM(CASE WHEN kind = 'sale' AND status = 'completed' THEN total_ttc END), 0) AS sttc,
           COALESCE(SUM(CASE WHEN kind = 'sale' AND status = 'completed' THEN total_ht END), 0) AS sht,
           COALESCE(SUM(CASE WHEN kind = 'sale' AND status = 'completed' THEN total_tva END), 0) AS stva,
           COALESCE(SUM(CASE WHEN kind = 'sale' AND status = 'completed' THEN total_discount END), 0) AS sdisc,
           COUNT(CASE WHEN kind = 'return' AND status = 'completed' THEN 1 END) AS rc,
           COALESCE(SUM(CASE WHEN kind = 'return' AND status = 'completed' THEN total_ttc END), 0) AS rttc,
           COALESCE(SUM(CASE WHEN kind = 'return' AND status = 'completed' THEN total_ht END), 0) AS rht,
           COALESCE(SUM(CASE WHEN kind = 'return' AND status = 'completed' THEN total_tva END), 0) AS rtva,
           COUNT(CASE WHEN status = 'cancelled' THEN 1 END) AS cc,
           COALESCE(SUM(CASE WHEN status = 'cancelled' THEN total_ttc END), 0) AS cttc
         FROM sales WHERE store_id = ? AND date(created_at, 'localtime') BETWEEN ? AND ?`,
      )
      .get(storeId, p.from, p.to) as Record<string, number>;
    const byMethod = (
      this.db
        .prepare(
          `SELECT p.method, SUM(p.amount) AS amount FROM sale_payments p JOIN sales s ON s.id = p.sale_id
           WHERE s.store_id = ? AND s.status = 'completed' AND date(s.created_at, 'localtime') BETWEEN ? AND ?
           GROUP BY p.method ORDER BY amount DESC`,
        )
        .all(storeId, p.from, p.to) as { method: string; amount: number }[]
    ).map((m) => ({ ...m, label: methodLabel(m.method) }));
    const cp = this.db
      .prepare("SELECT COUNT(*) AS count, COALESCE(SUM(amount), 0) AS amount FROM customer_payments WHERE store_id = ? AND date(paid_at, 'localtime') BETWEEN ? AND ?")
      .get(storeId, p.from, p.to) as { count: number; amount: number };
    const n = (k: string) => agg[k] ?? 0;
    return {
      period: { from: p.from, to: p.to },
      sales: { count: n('sc'), ttc: n('sttc'), ht: n('sht'), tva: n('stva'), discount: n('sdisc') },
      returns: { count: n('rc'), ttc: n('rttc'), ht: n('rht'), tva: n('rtva') },
      cancelled: { count: n('cc'), ttc: n('cttc') },
      net: { ttc: n('sttc') + n('rttc'), ht: n('sht') + n('rht'), tva: n('stva') + n('rtva') },
      byMethod,
      customerPayments: cp,
    };
  }

  /** Exports de la source : une ligne par opération, par ligne d'article ou par paiement, avec l'identifiant de la vente. */
  exportCsv(storeId: string, p: SalesPeriod, what: 'operations' | 'lines' | 'payments'): string {
    this.check(p);
    const kindLabel = (k: string, status: string) => (status === 'cancelled' ? 'Annulation' : k === 'return' ? 'Remboursement' : 'Vente');
    if (what === 'operations') {
      return csv(
        ['Identifiant vente', 'N°', 'Type', 'Statut', 'Date', 'Caisse', 'Caissier', 'Client', 'Total TTC', 'Total HT', 'TVA', 'Remise', 'Paiements', 'Vente d’origine', 'Remplace', 'Motif'],
        this.operations(storeId, p).map((r) => [
          r.id,
          r.number,
          kindLabel(r.kind, r.status),
          r.status === 'cancelled' ? (r.hidden ? 'Annulée (supprimée du registre)' : 'Annulée') : 'Validée',
          r.created_at,
          r.register_name,
          r.user_name,
          r.customer_name,
          r.total_ttc,
          r.total_ht,
          r.total_tva,
          r.total_discount,
          r.payments,
          r.original_number,
          r.replaces_number,
          r.cancel_reason,
        ]),
      );
    }
    if (what === 'payments') {
      return csv(
        ['Identifiant document', 'Document', 'Origine', 'Statut de la vente', 'Date', 'Moyen', 'Montant', 'Référence', 'Client', 'Utilisateur'],
        this.payments(storeId, p).map((r) => [
          r.doc_id,
          r.doc_number,
          r.source === 'sale' ? 'Vente' : 'Règlement client',
          r.doc_status === 'cancelled' ? 'Annulée' : r.doc_status ? 'Validée' : '',
          r.at,
          r.method_label,
          r.amount,
          r.reference,
          r.customer_name,
          r.user_name,
        ]),
      );
    }
    const rows = this.db
      .prepare(
        `SELECT s.id, s.number, s.kind, s.status, s.created_at, l.line_no, l.label, l.barcode, l.qty, l.unit_price, l.discount, l.vat_rate_bp, l.total_ttc
         FROM sale_lines l JOIN sales s ON s.id = l.sale_id
         WHERE s.store_id = ? AND date(s.created_at, 'localtime') BETWEEN ? AND ? ORDER BY s.created_at, s.number, l.line_no`,
      )
      .all(storeId, p.from, p.to) as Record<string, string | number>[];
    return csv(
      ['Identifiant vente', 'N°', 'Type', 'Statut', 'Date', 'Ligne', 'Article', 'Code-barres', 'Quantité', 'Prix unitaire TTC', 'Remise', 'Taux TVA %', 'Total TTC'],
      rows.map((r) => [
        r.id as string,
        r.number as string,
        kindLabel(String(r.kind), String(r.status)),
        r.status === 'cancelled' ? 'Annulée' : 'Validée',
        r.created_at as string,
        r.line_no as number,
        r.label as string,
        r.barcode as string,
        (Number(r.qty) / 1000).toString().replace('.', ','),
        r.unit_price as number,
        r.discount as number,
        (Number(r.vat_rate_bp) / 100).toString().replace('.', ','),
        r.total_ttc as number,
      ]),
    );
  }
}
