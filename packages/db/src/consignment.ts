import { type Fcfa, type Milli, computeTotals } from '@superette/core';
import type { AdminService, Warehouse } from './admin';
import type { CustomerService } from './customers';
import type { Db } from './database';
import type { PosService, Sale } from './pos';
import type { StockService } from './stock';
import { AppError, Base, type Clock, type Context, newId } from './util';

export interface ConsignmentDepot {
  warehouse_id: string;
  name: string;
  customer_id: string;
  customer_name: string;
  articles: number;
  /** Valeur au prix de revient (CMUP) de la marchandise chez le revendeur. */
  value: Fcfa;
  last_count: string | null;
}

export interface ConsignmentStockLine {
  article_id: string;
  code: string;
  name: string;
  unit: 'piece' | 'kg' | 'litre';
  qty: Milli;
  avg_cost: Fcfa;
}

export interface ConsignmentCount {
  id: string;
  number: string;
  store_id: string;
  warehouse_id: string;
  warehouse_name: string;
  customer_id: string;
  customer_name: string;
  sale_id: string | null;
  sale_number: string | null;
  total_ttc: Fcfa;
  notes: string | null;
  user_name: string | null;
  created_at: string;
  lines: { article_id: string; name: string; unit: string; expected: Milli; counted: Milli; sold: Milli; returned: Milli }[];
}

/**
 * Dépôt-vente : de la marchandise confiée à un client revendeur reste au stock
 * du magasin, dans un dépôt à son nom. À chaque passage, la fiche de contrôle
 * compte ce qui reste chez lui : le manque est facturé à crédit à son tarif
 * (depuis ce dépôt), ce qui reste peut être repris au magasin.
 */
export class ConsignmentService extends Base {
  constructor(
    db: Db,
    clock: Clock,
    private readonly admin: AdminService,
    private readonly stock: StockService,
    private readonly pos: PosService,
    private readonly customers: CustomerService,
  ) {
    super(db, clock);
  }

  depots(storeId: string): ConsignmentDepot[] {
    return this.db
      .prepare(
        `SELECT w.id AS warehouse_id, w.name, w.customer_id, c.name AS customer_name,
                (SELECT COUNT(*) FROM stock s WHERE s.warehouse_id = w.id AND s.qty > 0) AS articles,
                COALESCE((SELECT CAST(ROUND(SUM(s.qty * s.avg_cost / 1000.0)) AS INTEGER) FROM stock s WHERE s.warehouse_id = w.id AND s.qty > 0), 0) AS value,
                (SELECT MAX(k.created_at) FROM consignment_counts k WHERE k.warehouse_id = w.id) AS last_count
         FROM warehouses w JOIN customers c ON c.id = w.customer_id
         WHERE w.store_id = ? AND w.purpose = 'consignment' AND w.active = 1 ORDER BY c.name`,
      )
      .all(storeId) as ConsignmentDepot[];
  }

  /** Ouvre un dépôt-vente pour un client revendeur (un dépôt par client). */
  openDepot(ctx: Context, customerId: string): Warehouse {
    const customer = this.customers.getCustomer(customerId);
    const existing = this.db.prepare("SELECT id FROM warehouses WHERE store_id = ? AND purpose = 'consignment' AND customer_id = ?").pluck().get(ctx.storeId, customerId) as string | undefined;
    if (existing) {
      const wh = this.admin.getWarehouse(existing);
      return wh.active ? wh : this.admin.setWarehouseActive(ctx.userId, existing, true);
    }
    const wh = this.admin.createWarehouse(ctx.storeId, `Dépôt-vente ${customer.name}`.slice(0, 60), 'reserve', false, { purpose: 'consignment', customerId });
    this.audit(ctx.userId, 'consignment.open', 'warehouse', wh.id, { customer: customer.name });
    return wh;
  }

  private depot(ctx: Context, warehouseId: string): Warehouse {
    const wh = this.admin.getWarehouse(warehouseId);
    if (wh.store_id !== ctx.storeId) throw new AppError("Ce dépôt n'est pas dans ce magasin", 'FORBIDDEN');
    if (wh.purpose !== 'consignment' || !wh.customer_id) throw new AppError(`« ${wh.name} » n'est pas un dépôt-vente`, 'INVALID');
    return wh;
  }

  stockAt(warehouseId: string): ConsignmentStockLine[] {
    return this.db
      .prepare(
        `SELECT s.article_id, a.code, a.name, a.unit, s.qty, s.avg_cost FROM stock s JOIN articles a ON a.id = s.article_id
         WHERE s.warehouse_id = ? AND s.qty > 0 ORDER BY a.name`,
      )
      .all(warehouseId) as ConsignmentStockLine[];
  }

  /** Marchandise confiée au revendeur : elle passe du dépôt du magasin à son dépôt-vente (lots et coûts gardés). */
  send(ctx: Context, input: { warehouseId: string; fromWarehouseId: string; lines: { articleId: string; qty: Milli }[] }): ConsignmentStockLine[] {
    const wh = this.depot(ctx, input.warehouseId);
    const from = this.admin.getWarehouse(input.fromWarehouseId);
    if (from.store_id !== ctx.storeId || from.purpose !== 'stock') throw new AppError('La marchandise part d’un dépôt de stock du magasin', 'INVALID');
    const lines = input.lines.filter((l) => l.qty !== 0);
    if (!lines.length) throw new AppError('Ajoutez au moins un article à confier', 'EMPTY');
    for (const l of lines) {
      if (!Number.isSafeInteger(l.qty) || l.qty <= 0) throw new AppError('Quantité invalide', 'INVALID');
      const have = (this.db.prepare('SELECT qty FROM stock WHERE article_id = ? AND warehouse_id = ?').pluck().get(l.articleId, from.id) as number | undefined) ?? 0;
      if (have < l.qty) {
        const name = this.db.prepare('SELECT name FROM articles WHERE id = ?').pluck().get(l.articleId) as string | undefined;
        throw new AppError(`Stock insuffisant dans « ${from.name} » pour ${name ?? 'cet article'}`, 'OUT_OF_STOCK');
      }
    }
    this.tx(() => {
      const moved = this.stock.transfer(ctx, { fromWarehouseId: from.id, toWarehouseId: wh.id, lines });
      this.audit(ctx.userId, 'consignment.send', 'warehouse', wh.id, { transfer: moved.id, lines: lines.length });
    });
    return this.stockAt(wh.id);
  }

  /**
   * Fiche de contrôle : ce qui reste chez le revendeur est compté ; la différence
   * avec le stock confié est facturée à crédit au client (vente depuis son
   * dépôt-vente, sur la caisse ouverte de l'utilisateur). Avec `takeBack`, ce
   * qui reste revient au dépôt choisi du magasin.
   */
  count(
    ctx: Context,
    input: { warehouseId: string; lines: { articleId: string; counted: Milli }[]; takeBack?: { toWarehouseId: string } | null; notes?: string | null },
  ): ConsignmentCount {
    const wh = this.depot(ctx, input.warehouseId);
    const customerId = wh.customer_id!;
    const held = new Map(this.stockAt(wh.id).map((l) => [l.article_id, l]));
    const counted = new Map<string, Milli>();
    for (const l of input.lines) {
      if (!Number.isSafeInteger(l.counted) || l.counted < 0) throw new AppError('Quantité comptée invalide', 'INVALID');
      const line = held.get(l.articleId);
      if (!line) throw new AppError("Cet article n'est pas dans ce dépôt-vente", 'INVALID');
      if (l.counted > line.qty) throw new AppError(`${line.name} : plus de marchandise comptée que confiée — enregistrez d'abord l'envoi manquant`, 'INVALID');
      counted.set(l.articleId, l.counted);
    }
    // Un article non saisi est compté tel que confié : rien de vendu.
    const rows = [...held.values()].map((l) => {
      const c = counted.get(l.article_id) ?? l.qty;
      return { ...l, counted: c, sold: l.qty - c };
    });
    const sold = rows.filter((r) => r.sold > 0);
    const back = input.takeBack ? this.admin.getWarehouse(input.takeBack.toWarehouseId) : null;
    if (back && (back.store_id !== ctx.storeId || back.purpose !== 'stock')) throw new AppError('La marchandise reprise revient dans un dépôt de stock du magasin', 'INVALID');
    if (!sold.length && !back) throw new AppError('Rien de vendu et rien à reprendre : la fiche ne change rien', 'EMPTY');
    const level = this.customers.getCustomer(customerId).price_level;
    const saleLines = sold.map((r) => ({ articleId: r.article_id, qty: r.sold }));
    const total = sold.length ? computeTotals(this.pos.priceLines(ctx.storeId, saleLines, level, customerId)).totalTtc : 0;
    return this.tx(() => {
      const id = newId();
      const now = this.now();
      const number = `FC-${this.stationPrefix()}-${String(this.nextCounter('consignment_count.number')).padStart(5, '0')}`;
      let sale: Sale | null = null;
      if (sold.length) {
        sale = this.pos.completeSale(ctx, {
          lines: saleLines,
          payments: [{ method: 'CUSTOMER_CREDIT', amount: total }],
          customerId,
          warehouseId: wh.id,
          fromConsignment: true,
          // La marchandise est déjà chez le client : le gérant qui contrôle accepte la créance.
          creditAuthorizedBy: ctx.userId,
        });
      }
      this.db
        .prepare(
          `INSERT INTO consignment_counts (id, number, store_id, warehouse_id, customer_id, sale_id, total_ttc, notes, user_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, number, ctx.storeId, wh.id, customerId, sale?.id ?? null, sale?.total_ttc ?? 0, input.notes?.trim() || null, ctx.userId, now, now);
      const insert = this.db.prepare(
        'INSERT INTO consignment_count_lines (id, count_id, line_no, article_id, expected, counted, sold, returned) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      );
      const toReturn = back ? rows.filter((r) => r.counted > 0).map((r) => ({ articleId: r.article_id, qty: r.counted })) : [];
      if (back && toReturn.length) this.stock.transfer(ctx, { fromWarehouseId: wh.id, toWarehouseId: back.id, lines: toReturn });
      rows.forEach((r, i) => insert.run(newId(), id, i + 1, r.article_id, r.qty, r.counted, r.sold, back ? r.counted : 0));
      this.enqueue(ctx, 'consignment_count', id, 'upsert', {});
      this.audit(ctx.userId, 'consignment.count', 'warehouse', wh.id, { number, sale: sale?.number ?? null, total: sale?.total_ttc ?? 0, takenBack: toReturn.length });
      return this.get(id);
    });
  }

  get(id: string): ConsignmentCount {
    const head = this.db
      .prepare(
        `SELECT k.id, k.number, k.store_id, k.warehouse_id, w.name AS warehouse_name, k.customer_id, c.name AS customer_name, k.sale_id,
                s.number AS sale_number, k.total_ttc, k.notes, u.name AS user_name, k.created_at
         FROM consignment_counts k JOIN warehouses w ON w.id = k.warehouse_id JOIN customers c ON c.id = k.customer_id
         LEFT JOIN sales s ON s.id = k.sale_id LEFT JOIN users u ON u.id = k.user_id WHERE k.id = ?`,
      )
      .get(id) as Omit<ConsignmentCount, 'lines'> | undefined;
    if (!head) throw new AppError('Fiche de contrôle introuvable', 'NOT_FOUND');
    const lines = this.db
      .prepare(
        `SELECT l.article_id, a.name, a.unit, l.expected, l.counted, l.sold, l.returned FROM consignment_count_lines l JOIN articles a ON a.id = l.article_id
         WHERE l.count_id = ? ORDER BY l.line_no`,
      )
      .all(id) as ConsignmentCount['lines'];
    return { ...head, lines };
  }

  history(storeId: string, warehouseId?: string | null): Omit<ConsignmentCount, 'lines'>[] {
    return this.db
      .prepare(
        `SELECT k.id, k.number, k.store_id, k.warehouse_id, w.name AS warehouse_name, k.customer_id, c.name AS customer_name, k.sale_id,
                s.number AS sale_number, k.total_ttc, k.notes, u.name AS user_name, k.created_at
         FROM consignment_counts k JOIN warehouses w ON w.id = k.warehouse_id JOIN customers c ON c.id = k.customer_id
         LEFT JOIN sales s ON s.id = k.sale_id LEFT JOIN users u ON u.id = k.user_id
         WHERE k.store_id = @storeId AND (@wh IS NULL OR k.warehouse_id = @wh) ORDER BY k.created_at DESC LIMIT 200`,
      )
      .all({ storeId, wh: warehouseId ?? null }) as Omit<ConsignmentCount, 'lines'>[];
  }
}
