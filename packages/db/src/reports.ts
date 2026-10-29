import { type Fcfa, type Milli, PAYMENT_METHODS, type XlsxCell, type XlsxSheet } from '@superette/core';
import { AppError, Base } from './util';

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
/** Feuille sans colonnes ni lignes HT/TVA, et sans « TTC » dans les libellés (magasin sans TVA). */
function withoutVat(sheet: XlsxSheet): XlsxSheet {
  const strip = (v: string) => v.replace(/\s*\b(?:HT|TTC)\b/g, '');
  const drop = new Set(sheet.columns.flatMap((c, i) => (/\bHT\b/.test(c.header) || c.header === 'TVA' ? [i] : [])));
  const keep = <T,>(cells: T[]) => cells.filter((_, i) => !drop.has(i));
  const label = (cell: XlsxCell) => (typeof cell === 'string' ? strip(cell) : cell);
  // Synthèse : la ligne « Chiffre d'affaires HT » double « Chiffre d'affaires ».
  const rows = sheet.rows.filter((r) => !(typeof r[0] === 'string' && /\bHT\b/.test(r[0]) && /affaires/.test(r[0])));
  return {
    ...sheet,
    columns: keep(sheet.columns).map((c) => ({ ...c, header: strip(c.header) })),
    rows: rows.map((r) => keep(r).map(label)),
    totalRow: sheet.totalRow ? keep(sheet.totalRow) : undefined,
  };
}

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
    // Magasin sans TVA : ni colonne de taux, ni mention TTC (les lignes taxées d'avant gardent leur taux).
    const noVat = (this.db.prepare('SELECT vat_enabled FROM stores WHERE id = ?').pluck().get(storeId) as number) !== 1 && rows.every((r) => Number(r.vat_rate_bp) === 0);
    const header = noVat
      ? ['Ticket', 'Type', 'Date', 'Article', 'Quantité', 'Prix unitaire', 'Remise', 'Total']
      : ['Ticket', 'Type', 'Date', 'Article', 'Quantité', 'Prix unitaire TTC', 'Remise', 'Taux TVA %', 'Total TTC'];
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
        ...(noVat ? [] : [(Number(r.vat_rate_bp) / 100).toString().replace('.', ',')]),
        r.total_ttc,
      ]
        .map(esc)
        .join(';'),
    );
    return '﻿' + [header.join(';'), ...lines].join('\r\n');
  }

  // --- Rapports de ventes -----------------------------------------------------

  /** Lignes de vente de la période, retours compris (coût des retours repris du ticket d'origine). */
  private static readonly LINES = `
    WITH x AS (
      SELECT s.id AS sale_id, s.kind, s.created_at, s.user_id, s.register_id, s.customer_id, s.field_rep_id, s.field_zone, s.field_city,
             l.article_id, l.label, l.qty, l.unit_price, l.discount, l.vat_rate_bp, l.total_ttc,
             ROUND(l.total_ttc * 10000.0 / (10000 + l.vat_rate_bp)) AS ht,
             ROUND(l.qty * (CASE WHEN s.kind = 'return' THEN COALESCE(ol.unit_cost, 0) ELSE l.unit_cost END) / 1000.0) AS cost
      FROM sale_lines l JOIN sales s ON s.id = l.sale_id
      LEFT JOIN sale_lines ol ON s.kind = 'return' AND ol.sale_id = s.original_sale_id AND ol.line_no = l.line_no
      WHERE s.store_id = @storeId AND s.status = 'completed' AND date(s.created_at, 'localtime') BETWEEN @from AND @to
    )`;

  private static readonly DIMENSIONS: Record<Exclude<SalesDimension, 'payment'>, { key: string; label: string; joins?: string; extra?: string }> = {
    day: { key: "date(x.created_at, 'localtime')", label: "date(x.created_at, 'localtime')" },
    week: { key: "date(x.created_at, 'localtime', 'weekday 0', '-6 days')", label: "date(x.created_at, 'localtime', 'weekday 0', '-6 days')" },
    month: { key: "strftime('%Y-%m', x.created_at, 'localtime')", label: "strftime('%Y-%m', x.created_at, 'localtime')" },
    hour: { key: "strftime('%H', x.created_at, 'localtime')", label: "strftime('%H', x.created_at, 'localtime')" },
    weekday: { key: "strftime('%w', x.created_at, 'localtime')", label: "strftime('%w', x.created_at, 'localtime')" },
    department: {
      key: "COALESCE(d.id, '')",
      label: "COALESCE(d.name, 'Sans rayon')",
      joins: 'JOIN articles a ON a.id = x.article_id LEFT JOIN families f ON f.id = a.family_id LEFT JOIN departments d ON d.id = f.department_id',
    },
    family: {
      key: "COALESCE(f.id, '')",
      label: "COALESCE(d.name || ' › ' || f.name, 'Sans famille')",
      joins: 'JOIN articles a ON a.id = x.article_id LEFT JOIN families f ON f.id = a.family_id LEFT JOIN departments d ON d.id = f.department_id',
    },
    article: { key: 'x.article_id', label: 'a.name', joins: 'JOIN articles a ON a.id = x.article_id', extra: ', a.code AS code, a.unit AS unit' },
    cashier: { key: 'x.user_id', label: "COALESCE(u.name, '?')", joins: 'LEFT JOIN users u ON u.id = x.user_id' },
    register: { key: 'x.register_id', label: "COALESCE(r.name, '?')", joins: 'LEFT JOIN registers r ON r.id = x.register_id' },
    customer: { key: "COALESCE(x.customer_id, '')", label: "COALESCE(c.name, 'Client comptoir')", joins: 'LEFT JOIN customers c ON c.id = x.customer_id' },
    // Zone et ville figées sur la vente : un commercial qui change de secteur ne déplace pas ses anciennes ventes.
    field_rep: { key: "COALESCE(x.field_rep_id, '')", label: "COALESCE(fr.name, 'Sans commercial')", joins: 'LEFT JOIN field_reps fr ON fr.id = x.field_rep_id' },
    field_zone: { key: "COALESCE(x.field_city || ' › ' || x.field_zone, '')", label: "COALESCE(x.field_city || ' › ' || x.field_zone, 'Sans zone')" },
    field_city: { key: "COALESCE(x.field_city, '')", label: "COALESCE(x.field_city, 'Sans ville')" },
  };

  private rows(storeId: string, from: string, to: string, dimension: SalesDimension): SalesReportRow[] {
    const params = { storeId, from, to };
    if (dimension === 'payment') {
      const change = this.db
        .prepare(
          `SELECT COALESCE(SUM(change_given), 0) FROM sales
           WHERE store_id = @storeId AND status = 'completed' AND date(created_at, 'localtime') BETWEEN @from AND @to`,
        )
        .pluck()
        .get(params) as Fcfa;
      return (
        this.db
          .prepare(
            `SELECT p.method AS key, COUNT(DISTINCT CASE WHEN s.kind = 'sale' THEN s.id END) AS tickets, SUM(p.amount) AS revenueTtc,
                    SUM(CASE WHEN s.kind = 'return' THEN p.amount ELSE 0 END) AS returnsTtc
             FROM sale_payments p JOIN sales s ON s.id = p.sale_id
             WHERE s.store_id = @storeId AND s.status = 'completed' AND date(s.created_at, 'localtime') BETWEEN @from AND @to
             GROUP BY p.method ORDER BY revenueTtc DESC`,
          )
          .all(params) as { key: string; tickets: number; revenueTtc: Fcfa; returnsTtc: Fcfa }[]
      ).map((r) => ({
        ...r,
        // Espèces : montant remis moins la monnaie rendue, comme au Z.
        revenueTtc: r.key === 'CASH' ? r.revenueTtc - change : r.revenueTtc,
        label: PAYMENT_METHODS[r.key as keyof typeof PAYMENT_METHODS] ?? r.key,
        qty: null,
        unit: null,
        code: null,
        revenueHt: null,
        cost: null,
        margin: null,
      }));
    }
    const d = ReportService.DIMENSIONS[dimension];
    const raw = this.db
      .prepare(
        `${ReportService.LINES}
         SELECT ${d.key} AS key, ${d.label} AS label${d.extra ?? ''},
                COUNT(DISTINCT CASE WHEN x.kind = 'sale' THEN x.sale_id END) AS tickets,
                SUM(x.qty) AS qty, SUM(x.total_ttc) AS revenueTtc, SUM(x.ht) AS revenueHt, SUM(x.cost) AS cost,
                SUM(CASE WHEN x.kind = 'return' THEN x.total_ttc ELSE 0 END) AS returnsTtc
         FROM x ${d.joins ?? ''}
         GROUP BY 1 ORDER BY ${TIME_DIMENSIONS.has(dimension) ? '1' : 'revenueTtc DESC'}`,
      )
      .all(params) as (Omit<SalesReportRow, 'margin' | 'code' | 'unit'> & { code?: string; unit?: SalesReportRow['unit'] })[];
    const rows = raw.map((r) => ({
      ...r,
      label: labelOf(dimension, r.label),
      qty: dimension === 'article' ? r.qty : null,
      code: r.code ?? null,
      unit: r.unit ?? null,
      margin: (r.revenueHt ?? 0) - (r.cost ?? 0),
    }));
    // Semaine française : du lundi au dimanche.
    if (dimension === 'weekday') rows.sort((a, b) => ((Number(a.key) + 6) % 7) - ((Number(b.key) + 6) % 7));
    return rows;
  }

  private totals(storeId: string, from: string, to: string): SalesReportTotals {
    const params = { storeId, from, to };
    const head = this.db
      .prepare(
        `SELECT COALESCE(SUM(CASE WHEN kind = 'sale' THEN 1 END), 0) AS tickets,
                COALESCE(SUM(total_ttc), 0) AS revenueTtc,
                COALESCE(SUM(CASE WHEN kind = 'sale' THEN total_ttc END), 0) AS salesTtc,
                COALESCE(SUM(CASE WHEN kind = 'return' THEN total_ttc END), 0) AS returnsTtc,
                COALESCE(SUM(total_discount), 0) AS discounts, COALESCE(SUM(total_promo), 0) AS promotions
         FROM sales WHERE store_id = @storeId AND status = 'completed' AND date(created_at, 'localtime') BETWEEN @from AND @to`,
      )
      .get(params) as Omit<SalesReportTotals, 'revenueHt' | 'cost' | 'margin' | 'averageBasket'> & { salesTtc: Fcfa };
    // HT et coût ligne à ligne, comme les regroupements : le total du rapport est la somme de ses lignes.
    const lines = this.db.prepare(`${ReportService.LINES} SELECT COALESCE(SUM(ht), 0) AS ht, COALESCE(SUM(cost), 0) AS cost FROM x`).get(params) as { ht: Fcfa; cost: Fcfa };
    const { salesTtc, ...rest } = head;
    return { ...rest, revenueHt: lines.ht, cost: lines.cost, margin: lines.ht - lines.cost, averageBasket: head.tickets ? Math.round(salesTtc / head.tickets) : 0 };
  }

  /**
   * Ventes d'une période regroupées par jour, semaine, mois, heure, jour de la
   * semaine, rayon, famille, article, caissier, caisse, client ou moyen de
   * paiement, avec marge et comparaison à la période précédente ou à l'an passé.
   */
  sales(storeId: string, input: SalesReportInput): SalesReport {
    const { from, to } = input;
    if (!DATE.test(from) || !DATE.test(to) || to < from) throw new AppError('Période invalide', 'INVALID');
    if (!(input.dimension in ReportService.DIMENSIONS) && input.dimension !== 'payment') throw new AppError('Regroupement inconnu', 'INVALID');
    const rows = this.rows(storeId, from, to, input.dimension);
    const totals = this.totals(storeId, from, to);
    let previous: SalesReport['previous'] = null;
    if (input.compare) {
      const p = comparePeriod(from, to, input.compare);
      const prevRows = TIME_DIMENSIONS.has(input.dimension) ? [] : this.rows(storeId, p.from, p.to, input.dimension);
      const byKey = new Map(prevRows.map((r) => [r.key, r.revenueTtc]));
      for (const r of rows) r.previousTtc = TIME_DIMENSIONS.has(input.dimension) ? null : (byKey.get(r.key) ?? 0);
      previous = { ...p, totals: this.totals(storeId, p.from, p.to) };
    }
    return { from, to, dimension: input.dimension, rows, totals, previous };
  }

  /**
   * Rapport en colonnes : le regroupement choisi en lignes, une colonne par
   * jour, semaine, mois ou année jusqu'à `end` (aujourd'hui par défaut), et le total.
   */
  periodMatrix(storeId: string, input: { dimension: MatrixDimension; step: MatrixStep; measure: MatrixMeasure; end?: string | null }): PeriodMatrix {
    const d = ReportService.DIMENSIONS[input.dimension as keyof typeof ReportService.DIMENSIONS];
    if (!d || TIME_DIMENSIONS.has(input.dimension)) throw new AppError('Regroupement inconnu', 'INVALID');
    if (!(input.step in MATRIX_STEPS)) throw new AppError('Période inconnue', 'INVALID');
    if (!(input.measure in MATRIX_MEASURES)) throw new AppError('Mesure inconnue', 'INVALID');
    const to = input.end && DATE.test(input.end) ? input.end : this.today();
    const columns: { key: string; label: string }[] = [];
    let column: string;
    if (input.step === 'day30') {
      for (let i = 29; i >= 0; i--) {
        const k = addDays(to, -i);
        columns.push({ key: k, label: `${k.slice(8, 10)}/${k.slice(5, 7)}` });
      }
      column = "date(x.created_at, 'localtime')";
    } else if (input.step === 'week12') {
      const monday = addDays(to, -((new Date(`${to}T12:00:00Z`).getUTCDay() + 6) % 7));
      for (let i = 11; i >= 0; i--) {
        const k = addDays(monday, -7 * i);
        columns.push({ key: k, label: `Sem. ${k.slice(8, 10)}/${k.slice(5, 7)}` });
      }
      column = "date(x.created_at, 'localtime', 'weekday 0', '-6 days')";
    } else if (input.step === 'month12') {
      const [y, m] = to.split('-').map(Number) as [number, number];
      for (let i = 11; i >= 0; i--) {
        const k = new Date(Date.UTC(y, m - 1 - i, 1)).toISOString().slice(0, 7);
        columns.push({ key: k, label: `${MONTHS[Number(k.slice(5, 7)) - 1]!.slice(0, 4)}. ${k.slice(2, 4)}` });
      }
      column = "strftime('%Y-%m', x.created_at, 'localtime')";
    } else {
      const y = Number(to.slice(0, 4));
      for (let i = 9; i >= 0; i--) columns.push({ key: String(y - i), label: String(y - i) });
      column = "strftime('%Y', x.created_at, 'localtime')";
    }
    const first = columns[0]!.key;
    const from = input.step === 'month12' ? `${first}-01` : input.step === 'year10' ? `${first}-01-01` : first;
    const measure = { ttc: 'SUM(x.total_ttc)', margin: 'SUM(x.ht) - SUM(x.cost)', qty: 'SUM(x.qty)', tickets: "COUNT(DISTINCT CASE WHEN x.kind = 'sale' THEN x.sale_id END)" }[input.measure];
    const raw = this.db
      .prepare(
        `${ReportService.LINES}
         SELECT ${d.key} AS key, ${d.label} AS label, ${column} AS col, ${measure} AS value
         FROM x ${d.joins ?? ''} GROUP BY 1, 3`,
      )
      .all({ storeId, from, to }) as { key: string; label: string; col: string; value: number }[];
    const index = new Map(columns.map((c, i) => [c.key, i]));
    const byRow = new Map<string, { key: string; label: string; values: number[]; total: number }>();
    for (const r of raw) {
      const i = index.get(r.col);
      if (i === undefined) continue;
      let row = byRow.get(r.key);
      if (!row) byRow.set(r.key, (row = { key: r.key, label: r.label, values: columns.map(() => 0), total: 0 }));
      row.values[i] = (row.values[i] ?? 0) + (r.value ?? 0);
      row.total += r.value ?? 0;
    }
    const rows = [...byRow.values()].sort((a, b) => b.total - a.total).slice(0, 500);
    const totals = columns.map((_, i) => rows.reduce((t, r) => t + r.values[i]!, 0));
    return { step: input.step, measure: input.measure, dimension: input.dimension, from, to, columns, rows, totals, total: totals.reduce((t, v) => t + v, 0) };
  }

  /** Classeur Excel du rapport en colonnes. */
  periodMatrixWorkbook(storeId: string, input: { dimension: MatrixDimension; step: MatrixStep; measure: MatrixMeasure; end?: string | null }): XlsxSheet[] {
    const m = this.periodMatrix(storeId, input);
    const store = this.db.prepare('SELECT name FROM stores WHERE id = ?').pluck().get(storeId) as string;
    const format = input.measure === 'qty' ? ('qty' as const) : input.measure === 'tickets' ? ('int' as const) : ('money' as const);
    return [
      {
        name: 'En colonnes',
        title: [`${store} · ${MATRIX_MEASURES[m.measure]} par ${DIMENSION_LABELS[m.dimension].toLowerCase()}`, `${MATRIX_STEPS[m.step]} : du ${frDate(m.from)} au ${frDate(m.to)}`],
        columns: [{ header: DIMENSION_LABELS[m.dimension], width: 30 }, ...m.columns.map((c) => ({ header: c.label, format, width: 11 })), { header: 'Total', format, width: 14 }],
        rows: [...m.rows.map((r) => [r.label, ...r.values, r.total]), ['Total', ...m.totals, m.total]],
      },
    ];
  }

  /**
   * Produits sans vente sur la période (articles actifs, services exclus) : le
   * stock qui dort, avec sa valeur au coût moyen et la date de la dernière vente.
   */
  unsold(storeId: string, from: string, to: string): { id: string; code: string; name: string; department: string | null; unit: string; qty: number; value: Fcfa; last_sale: string | null }[] {
    if (!DATE.test(from) || !DATE.test(to) || to < from) throw new AppError('Période invalide', 'INVALID');
    return this.db
      .prepare(
        `SELECT a.id, a.code, a.name, d.name AS department, a.unit,
                COALESCE((SELECT SUM(s.qty) FROM stock s JOIN warehouses w ON w.id = s.warehouse_id WHERE s.article_id = a.id AND w.store_id = @storeId), 0) AS qty,
                COALESCE((SELECT SUM(ROUND(s.qty * s.avg_cost / 1000.0)) FROM stock s JOIN warehouses w ON w.id = s.warehouse_id WHERE s.article_id = a.id AND w.store_id = @storeId AND s.qty > 0), 0) AS value,
                (SELECT MAX(date(x.created_at, 'localtime')) FROM sale_lines l JOIN sales x ON x.id = l.sale_id
                  WHERE l.article_id = a.id AND x.store_id = @storeId AND x.kind = 'sale' AND x.status = 'completed') AS last_sale
         FROM articles a LEFT JOIN families f ON f.id = a.family_id LEFT JOIN departments d ON d.id = f.department_id
         WHERE a.active = 1 AND a.is_service = 0
           AND NOT EXISTS (SELECT 1 FROM sale_lines l JOIN sales x ON x.id = l.sale_id
                           WHERE l.article_id = a.id AND x.store_id = @storeId AND x.status = 'completed' AND x.kind = 'sale'
                             AND date(x.created_at, 'localtime') BETWEEN @from AND @to)
         ORDER BY value DESC, qty DESC, a.name`,
      )
      .all({ storeId, from, to }) as never;
  }

  /** TVA collectée par taux sur la période (base HT, TVA, TTC), retours déduits. */
  vatByRate(storeId: string, from: string, to: string): { rate_bp: number; ht: Fcfa; tva: Fcfa; ttc: Fcfa }[] {
    return (
      this.db
        .prepare(`${ReportService.LINES} SELECT vat_rate_bp AS rate_bp, SUM(ht) AS ht, SUM(total_ttc) AS ttc FROM x GROUP BY vat_rate_bp ORDER BY vat_rate_bp DESC`)
        .all({ storeId, from, to }) as { rate_bp: number; ht: Fcfa; ttc: Fcfa }[]
    ).map((r) => ({ ...r, tva: r.ttc - r.ht }));
  }

  /** Classeur Excel du rapport : synthèse, regroupement choisi, paiements, TVA et détail des lignes. */
  salesWorkbook(storeId: string, input: SalesReportInput): XlsxSheet[] {
    const report = this.sales(storeId, input);
    const store = this.db.prepare('SELECT name FROM stores WHERE id = ?').pluck().get(storeId) as string;
    const period = `Du ${frDate(input.from)} au ${frDate(input.to)}`;
    const title = (t: string) => [`${store} · ${t}`, period];
    const t = report.totals;
    const pct = (a: number, b: number) => (b ? a / b : null);
    const prev = report.previous?.totals;
    const synth: XlsxSheet = {
      name: 'Synthèse',
      title: title('Rapport des ventes'),
      columns: [{ header: 'Indicateur', width: 30 }, { header: 'Période', format: 'money', width: 16 }, ...(prev ? [{ header: 'Comparaison', format: 'money' as const, width: 16 }, { header: 'Évolution', format: 'pct' as const }] : [])],
      rows: (
        [
          ['Chiffre d’affaires TTC', t.revenueTtc, prev?.revenueTtc],
          ['Chiffre d’affaires HT', t.revenueHt, prev?.revenueHt],
          ['Coût d’achat des ventes', t.cost, prev?.cost],
          ['Marge brute HT', t.margin, prev?.margin],
          ['Tickets', t.tickets, prev?.tickets],
          ['Panier moyen TTC', t.averageBasket, prev?.averageBasket],
          ['Retours TTC', t.returnsTtc, prev?.returnsTtc],
          ['Remises accordées', t.discounts, prev?.discounts],
          ['Promotions', t.promotions, prev?.promotions],
        ] as [string, number, number | undefined][]
      ).map(([k, v, p]) => (prev ? [k, v, p ?? null, p ? (v - p) / Math.abs(p) : null] : [k, v])),
    };
    if (prev) synth.title!.push(`Comparé au ${frDate(report.previous!.from)} – ${frDate(report.previous!.to)}`);
    const isPayment = input.dimension === 'payment';
    const hasPrev = report.rows.some((r) => r.previousTtc !== undefined && r.previousTtc !== null);
    const dim: XlsxSheet = {
      name: DIMENSION_LABELS[input.dimension],
      title: title(`Ventes par ${DIMENSION_LABELS[input.dimension].toLowerCase()}`),
      columns: [
        ...(input.dimension === 'article' ? [{ header: 'Code', width: 14 }] : []),
        { header: DIMENSION_LABELS[input.dimension], width: 32 },
        { header: 'Tickets', format: 'int' as const },
        ...(input.dimension === 'article' ? [{ header: 'Quantité', format: 'qty' as const }] : []),
        { header: 'CA TTC', format: 'money' as const, width: 14 },
        ...(isPayment ? [] : [{ header: 'CA HT', format: 'money' as const, width: 14 }, { header: 'Coût', format: 'money' as const, width: 14 }, { header: 'Marge', format: 'money' as const, width: 14 }, { header: 'Taux de marge', format: 'pct' as const }]),
        { header: 'Part du CA', format: 'pct' as const },
        { header: 'Retours TTC', format: 'money' as const, width: 14 },
        ...(hasPrev ? [{ header: 'CA comparé', format: 'money' as const, width: 14 }, { header: 'Évolution', format: 'pct' as const }] : []),
      ],
      rows: report.rows.map((r) => [
        ...(input.dimension === 'article' ? [r.code] : []),
        r.label,
        r.tickets,
        ...(input.dimension === 'article' ? [r.qty === null ? null : r.qty / 1000] : []),
        r.revenueTtc,
        ...(isPayment ? [] : [r.revenueHt, r.cost, r.margin, pct(r.margin ?? 0, r.revenueHt ?? 0)]),
        pct(r.revenueTtc, isPayment ? report.rows.reduce((s, x) => s + x.revenueTtc, 0) : t.revenueTtc),
        r.returnsTtc,
        ...(hasPrev ? [r.previousTtc ?? 0, r.previousTtc ? (r.revenueTtc - r.previousTtc) / Math.abs(r.previousTtc) : null] : []),
      ]),
      totalRow: [
        ...(input.dimension === 'article' ? [null] : []),
        'Total',
        isPayment ? null : t.tickets,
        ...(input.dimension === 'article' ? [null] : []),
        isPayment ? report.rows.reduce((s, x) => s + x.revenueTtc, 0) : t.revenueTtc,
        ...(isPayment ? [] : [t.revenueHt, t.cost, t.margin, pct(t.margin, t.revenueHt)]),
        1,
        t.returnsTtc,
        ...(hasPrev ? [report.rows.reduce((s, x) => s + (x.previousTtc ?? 0), 0), null] : []),
      ],
    };
    const sheets = [synth, dim];
    if (!isPayment) {
      const pay = this.rows(storeId, input.from, input.to, 'payment');
      sheets.push({
        name: 'Paiements',
        title: title('Encaissements par moyen de paiement'),
        columns: [{ header: 'Moyen de paiement', width: 24 }, { header: 'Tickets', format: 'int' }, { header: 'Montant', format: 'money', width: 14 }, { header: 'Dont remboursements', format: 'money', width: 20 }],
        rows: pay.map((p) => [p.label, p.tickets, p.revenueTtc, p.returnsTtc]),
        totalRow: ['Total', null, pay.reduce((s, p) => s + p.revenueTtc, 0), pay.reduce((s, p) => s + p.returnsTtc, 0)],
      });
    }
    const vat = this.vatByRate(storeId, input.from, input.to);
    sheets.push({
      name: 'TVA',
      title: title('TVA collectée par taux'),
      columns: [{ header: 'Taux', format: 'pct' }, { header: 'Base HT', format: 'money', width: 14 }, { header: 'TVA', format: 'money', width: 14 }, { header: 'TTC', format: 'money', width: 14 }],
      rows: vat.map((v) => [v.rate_bp / 10000, v.ht, v.tva, v.ttc]),
      totalRow: ['Total', vat.reduce((s, v) => s + v.ht, 0), vat.reduce((s, v) => s + v.tva, 0), vat.reduce((s, v) => s + v.ttc, 0)],
    });
    const lines = this.db
      .prepare(
        `${ReportService.LINES}
         SELECT x.created_at, s.number, x.kind, COALESCE(u.name, '') AS cashier, COALESCE(c.name, '') AS customer,
                a.code, x.label, COALESCE(d.name, '') AS department, x.qty, a.unit, x.unit_price, x.discount, x.vat_rate_bp,
                x.total_ttc, x.ht, x.cost
         FROM x JOIN sales s ON s.id = x.sale_id JOIN articles a ON a.id = x.article_id
         LEFT JOIN families f ON f.id = a.family_id LEFT JOIN departments d ON d.id = f.department_id
         LEFT JOIN users u ON u.id = x.user_id LEFT JOIN customers c ON c.id = x.customer_id
         ORDER BY x.created_at, s.number LIMIT 200000`,
      )
      .all({ storeId, from: input.from, to: input.to }) as {
      created_at: string;
      number: string;
      kind: string;
      cashier: string;
      customer: string;
      code: string;
      label: string;
      department: string;
      qty: Milli;
      unit: 'piece' | 'kg' | 'litre';
      unit_price: Fcfa;
      discount: Fcfa;
      vat_rate_bp: number;
      total_ttc: Fcfa;
      ht: Fcfa;
      cost: Fcfa;
    }[];
    sheets.push({
      name: 'Lignes',
      title: title('Détail des lignes vendues'),
      columns: [
        { header: 'Date', width: 17 },
        { header: 'Ticket', width: 18 },
        { header: 'Type' },
        { header: 'Caissier', width: 16 },
        { header: 'Client', width: 20 },
        { header: 'Code', width: 14 },
        { header: 'Article', width: 30 },
        { header: 'Rayon', width: 16 },
        { header: 'Quantité', format: 'qty' },
        { header: 'Prix unitaire TTC', format: 'money', width: 16 },
        { header: 'Remise', format: 'money' },
        { header: 'TVA', format: 'pct' },
        { header: 'Total TTC', format: 'money', width: 13 },
        { header: 'Total HT', format: 'money', width: 13 },
        { header: 'Coût', format: 'money', width: 13 },
        { header: 'Marge', format: 'money', width: 13 },
      ],
      rows: lines.map((l) => [
        frDateTime(l.created_at),
        l.number,
        l.kind === 'sale' ? 'Vente' : 'Retour',
        l.cashier,
        l.customer,
        l.code,
        l.label,
        l.department,
        l.qty / 1000,
        l.unit_price,
        l.discount,
        l.vat_rate_bp / 10000,
        l.total_ttc,
        l.ht,
        l.cost,
        l.ht - l.cost,
      ]),
    });
    // Magasin sans TVA, période sans vente taxée : ni feuille TVA, ni colonne HT ou TVA, ni mention TTC.
    const noVat = (this.db.prepare('SELECT vat_enabled FROM stores WHERE id = ?').pluck().get(storeId) as number) !== 1 && vat.every((v) => v.rate_bp === 0);
    return noVat ? sheets.filter((sh) => sh.name !== 'TVA').map(withoutVat) : sheets;
  }
}

export type SalesDimension =
  | 'day'
  | 'week'
  | 'month'
  | 'hour'
  | 'weekday'
  | 'department'
  | 'family'
  | 'article'
  | 'cashier'
  | 'register'
  | 'customer'
  | 'field_rep'
  | 'field_zone'
  | 'field_city'
  | 'payment';

export const DIMENSION_LABELS: Record<SalesDimension, string> = {
  day: 'Jour',
  week: 'Semaine',
  month: 'Mois',
  hour: 'Heure',
  weekday: 'Jour de la semaine',
  department: 'Rayon',
  family: 'Famille',
  article: 'Article',
  cashier: 'Caissier',
  register: 'Caisse',
  customer: 'Client',
  field_rep: 'Commercial',
  field_zone: 'Zone',
  field_city: 'Ville',
  payment: 'Paiement',
};

/** Rapport en colonnes : chaque colonne est une période (30 jours, 12 semaines, 12 mois ou 10 ans). */
export type MatrixStep = 'day30' | 'week12' | 'month12' | 'year10';
export type MatrixMeasure = 'ttc' | 'margin' | 'qty' | 'tickets';
export type MatrixDimension = Exclude<SalesDimension, 'day' | 'week' | 'month' | 'hour' | 'weekday' | 'payment'>;

export const MATRIX_STEPS: Record<MatrixStep, string> = { day30: '30 derniers jours', week12: '12 dernières semaines', month12: '12 derniers mois', year10: '10 dernières années' };
export const MATRIX_MEASURES: Record<MatrixMeasure, string> = { ttc: 'CA TTC', margin: 'Marge HT', qty: 'Quantité', tickets: 'Tickets' };

export interface PeriodMatrix {
  step: MatrixStep;
  measure: MatrixMeasure;
  dimension: MatrixDimension;
  from: string;
  to: string;
  columns: { key: string; label: string }[];
  /** Une ligne par élément du regroupement ; une case à 0 : rien sur la période. */
  rows: { key: string; label: string; values: number[]; total: number }[];
  totals: number[];
  total: number;
}

const TIME_DIMENSIONS = new Set<SalesDimension>(['day', 'week', 'month', 'hour', 'weekday']);
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const WEEKDAYS = ['Dimanche', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi'];
const MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
const frDate = (ymd: string) => `${ymd.slice(8, 10)}/${ymd.slice(5, 7)}/${ymd.slice(0, 4)}`;
const frDateTime = (iso: string) =>
  new Date(iso).toLocaleString('fr-FR', { timeZone: 'Africa/Douala', dateStyle: 'short', timeStyle: 'short' });

function labelOf(dimension: SalesDimension, raw: string): string {
  if (dimension === 'day') return frDate(raw);
  if (dimension === 'week') return `Semaine du ${frDate(raw)}`;
  if (dimension === 'month') return `${MONTHS[Number(raw.slice(5, 7)) - 1]} ${raw.slice(0, 4)}`;
  if (dimension === 'hour') return `${raw} h – ${String(Number(raw) + 1).padStart(2, '0')} h`;
  if (dimension === 'weekday') return WEEKDAYS[Number(raw)]!;
  return raw;
}

const addDays = (ymd: string, n: number) => {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** Période de comparaison : la même durée juste avant, ou les mêmes dates un an plus tôt. */
export function comparePeriod(from: string, to: string, mode: 'previous' | 'last_year'): { from: string; to: string } {
  if (mode === 'last_year') {
    const back = (ymd: string) => {
      const y = Number(ymd.slice(0, 4)) - 1;
      // 29 février : on retombe sur le 28.
      const md = ymd.slice(5) === '02-29' ? '02-28' : ymd.slice(5);
      return `${y}-${md}`;
    };
    return { from: back(from), to: back(to) };
  }
  const days = Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000) + 1;
  // Un mois entier se compare au mois entier d'avant (septembre a 30 jours, octobre 31).
  const firstOfMonth = from.slice(8) === '01';
  const lastOfMonth = addDays(to, 1).slice(8) === '01';
  if (firstOfMonth && lastOfMonth && from.slice(0, 7) === to.slice(0, 7)) {
    const prevEnd = addDays(from, -1);
    return { from: `${prevEnd.slice(0, 7)}-01`, to: prevEnd };
  }
  return { from: addDays(from, -days), to: addDays(from, -1) };
}

export interface SalesReportInput {
  from: string;
  to: string;
  dimension: SalesDimension;
  compare?: 'previous' | 'last_year' | null;
}

export interface SalesReportRow {
  key: string;
  label: string;
  /** Code et unité de l'article (regroupement par article). */
  code: string | null;
  unit: 'piece' | 'kg' | 'litre' | null;
  tickets: number;
  /** Quantité vendue (articles seulement : les unités ne s'additionnent pas entre articles). */
  qty: Milli | null;
  revenueTtc: Fcfa;
  /** Null pour les moyens de paiement. */
  revenueHt: Fcfa | null;
  cost: Fcfa | null;
  margin: Fcfa | null;
  returnsTtc: Fcfa;
  /** CA TTC de la période de comparaison (regroupements hors dates). */
  previousTtc?: Fcfa | null;
}

export interface SalesReportTotals {
  tickets: number;
  revenueTtc: Fcfa;
  revenueHt: Fcfa;
  cost: Fcfa;
  margin: Fcfa;
  averageBasket: Fcfa;
  returnsTtc: Fcfa;
  discounts: Fcfa;
  promotions: Fcfa;
}

export interface SalesReport {
  from: string;
  to: string;
  dimension: SalesDimension;
  rows: SalesReportRow[];
  totals: SalesReportTotals;
  previous: { from: string; to: string; totals: SalesReportTotals } | null;
}

