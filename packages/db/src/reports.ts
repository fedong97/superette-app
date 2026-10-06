import { type Fcfa } from '@superette/core';
import { Base } from './util';

export interface DailySummary {
  date: string;
  ticketCount: number;
  revenueTtc: Fcfa;
  revenueHt: Fcfa;
  costOfSales: Fcfa;
  grossMargin: Fcfa;
  averageBasket: Fcfa;
  byDepartment: { department: string; revenueHt: Fcfa; margin: Fcfa }[];
  byHour: { hour: number; revenueTtc: Fcfa; tickets: number }[];
  topArticles: { name: string; qty: number; revenueTtc: Fcfa }[];
}

/** Indicateurs de base de la phase 1 ; les tableaux de bord complets arrivent en phase 4. */
export class ReportService extends Base {
  daily(storeId: string, date: string): DailySummary {
    const base = `FROM sale_lines l JOIN sales s ON s.id = l.sale_id
                  WHERE s.store_id = @storeId AND s.status = 'completed' AND date(s.created_at, 'localtime') = @date`;
    const params = { storeId, date };
    const head = this.db
      .prepare(
        `SELECT COUNT(*) AS tickets, COALESCE(SUM(total_ttc), 0) AS ttc, COALESCE(SUM(total_ht), 0) AS ht
         FROM sales WHERE store_id = @storeId AND status = 'completed' AND date(created_at, 'localtime') = @date`,
      )
      .get(params) as { tickets: number; ttc: number; ht: number };
    const sales = this.db
      .prepare(`SELECT COUNT(*) FROM sales WHERE store_id = @storeId AND status = 'completed' AND kind = 'sale' AND date(created_at, 'localtime') = @date`)
      .pluck()
      .get(params) as number;
    const cost = this.db.prepare(`SELECT COALESCE(SUM(ROUND(l.qty * l.unit_cost / 1000.0)), 0) ${base}`).pluck().get(params) as number;
    const byDepartment = this.db
      .prepare(
        `SELECT COALESCE(d.name, 'Sans rayon') AS department,
                SUM(ROUND(l.total_ttc * 10000.0 / (10000 + l.vat_rate_bp))) AS revenueHt,
                SUM(ROUND(l.total_ttc * 10000.0 / (10000 + l.vat_rate_bp)) - ROUND(l.qty * l.unit_cost / 1000.0)) AS margin
         ${base.replace('FROM sale_lines l', `FROM sale_lines l JOIN articles a ON a.id = l.article_id
              LEFT JOIN families f ON f.id = a.family_id LEFT JOIN departments d ON d.id = f.department_id`)}
         GROUP BY department ORDER BY revenueHt DESC`,
      )
      .all(params) as DailySummary['byDepartment'];
    const byHour = this.db
      .prepare(
        `SELECT CAST(strftime('%H', created_at, 'localtime') AS INTEGER) AS hour, SUM(total_ttc) AS revenueTtc, COUNT(*) AS tickets
         FROM sales WHERE store_id = @storeId AND status = 'completed' AND kind = 'sale' AND date(created_at, 'localtime') = @date
         GROUP BY hour ORDER BY hour`,
      )
      .all(params) as DailySummary['byHour'];
    const topArticles = this.db
      .prepare(`SELECT l.label AS name, SUM(l.qty) AS qty, SUM(l.total_ttc) AS revenueTtc ${base} GROUP BY l.article_id ORDER BY revenueTtc DESC LIMIT 10`)
      .all(params) as DailySummary['topArticles'];
    return {
      date,
      ticketCount: sales,
      revenueTtc: head.ttc,
      revenueHt: head.ht,
      costOfSales: cost,
      grossMargin: head.ht - cost,
      averageBasket: sales > 0 ? Math.round(head.ttc / sales) : 0,
      byDepartment,
      byHour,
      topArticles,
    };
  }

  /** Export des ventes du jour pour la comptabilité existante (en attendant la phase 3). */
  salesExportCsv(storeId: string, from: string, to: string): string {
    const rows = this.db
      .prepare(
        `SELECT s.number, s.kind, s.created_at, l.label, l.qty, l.unit_price, l.discount, l.vat_rate_bp, l.total_ttc
         FROM sale_lines l JOIN sales s ON s.id = l.sale_id
         WHERE s.store_id = ? AND s.status = 'completed' AND date(s.created_at, 'localtime') BETWEEN ? AND ?
         ORDER BY s.created_at, l.line_no`,
      )
      .all(storeId, from, to) as Record<string, string | number>[];
    const header = ['Ticket', 'Type', 'Date', 'Article', 'Quantité', 'Prix unitaire TTC', 'Remise', 'Taux TVA %', 'Total TTC'];
    const esc = (v: string | number | undefined) => {
      const s = String(v ?? '');
      return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = rows.map((r) =>
      [
        r.number,
        r.kind === 'sale' ? 'Vente' : 'Retour',
        r.created_at,
        r.label,
        (Number(r.qty) / 1000).toString().replace('.', ','),
        r.unit_price,
        r.discount,
        (Number(r.vat_rate_bp) / 100).toString().replace('.', ','),
        r.total_ttc,
      ]
        .map(esc)
        .join(';'),
    );
    return '﻿' + [header.join(';'), ...lines].join('\r\n');
  }
}
