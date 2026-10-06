import {
  type ExpiryAlert,
  type Fcfa,
  type Milli,
  type MovementType,
  type StockLevel,
  LOSS_TYPES,
  allocateFefo,
  daysUntil,
  expiryAlert,
  stockLevel,
  weightedAverageCost,
} from '@superette/core';
import { AppError, Base, type Context, newId } from './util';

export interface ReceptionLine {
  articleId: string;
  qty: Milli;
  /** Coût d'achat unitaire HT (par pièce ou par kg). */
  unitCost: Fcfa;
  lotNumber?: string | null;
  expiry?: string | null;
}

export interface StockRow {
  article_id: string;
  code: string;
  name: string;
  unit: 'piece' | 'kg' | 'litre';
  department_name: string | null;
  qty: Milli;
  avg_cost: Fcfa;
  value: Fcfa;
  alert_qty: Milli | null;
  max_qty: Milli | null;
  level: StockLevel;
  next_expiry: string | null;
}

export interface ExpiringLot {
  lot_id: string;
  article_id: string;
  name: string;
  warehouse_name: string;
  lot_number: string | null;
  expiry: string;
  qty: Milli;
  days: number;
  alert: ExpiryAlert;
}

interface MovementInput {
  type: MovementType;
  articleId: string;
  warehouseId: string;
  /** Signé : positif = entrée, négatif = sortie. */
  qty: Milli;
  /** Coût unitaire de l'entrée ; ignoré pour une sortie (valorisée au CMUP). */
  unitCost?: Fcfa;
  lotId?: string | null;
  reason?: string | null;
  refType?: string | null;
  refId?: string | null;
}

export class StockService extends Base {
  /**
   * Écrit un mouvement et met à jour le stock du dépôt. Les entrées
   * valorisées (réception, transfert) recalculent le CMUP.
   * À appeler dans une transaction.
   */
  applyMovement(ctx: Context, m: MovementInput): { unitCost: Fcfa } {
    this.db.prepare('INSERT OR IGNORE INTO stock (article_id, warehouse_id, qty, avg_cost) VALUES (?, ?, 0, 0)').run(m.articleId, m.warehouseId);
    const current = this.db
      .prepare('SELECT qty, avg_cost FROM stock WHERE article_id = ? AND warehouse_id = ?')
      .get(m.articleId, m.warehouseId) as { qty: number; avg_cost: number };
    const valuedEntry = m.qty > 0 && m.unitCost !== undefined && (m.type === 'RECEPTION' || m.type === 'TRANSFER_IN');
    const avgCost = valuedEntry ? weightedAverageCost(current.qty, current.avg_cost, m.qty, m.unitCost!) : current.avg_cost;
    const unitCost = m.qty > 0 && m.unitCost !== undefined ? m.unitCost : current.avg_cost;
    this.db
      .prepare('UPDATE stock SET qty = qty + ?, avg_cost = ? WHERE article_id = ? AND warehouse_id = ?')
      .run(m.qty, avgCost, m.articleId, m.warehouseId);
    const id = newId();
    const row = {
      id,
      type: m.type,
      article_id: m.articleId,
      warehouse_id: m.warehouseId,
      lot_id: m.lotId ?? null,
      qty: m.qty,
      unit_cost: unitCost,
      reason: m.reason ?? null,
      ref_type: m.refType ?? null,
      ref_id: m.refId ?? null,
      user_id: ctx.userId,
      at: this.now(),
    };
    this.db
      .prepare(
        `INSERT INTO stock_movements (id, type, article_id, warehouse_id, lot_id, qty, unit_cost, reason, ref_type, ref_id, user_id, at)
         VALUES (@id, @type, @article_id, @warehouse_id, @lot_id, @qty, @unit_cost, @reason, @ref_type, @ref_id, @user_id, @at)`,
      )
      .run(row);
    this.enqueue(ctx, 'stock_movement', id, 'upsert', row);
    return { unitCost };
  }

  private lots(articleId: string, warehouseId: string) {
    return this.db
      .prepare('SELECT id, qty, expiry, received_at AS receivedAt FROM lots WHERE article_id = ? AND warehouse_id = ? AND qty > 0')
      .all(articleId, warehouseId) as { id: string; qty: number; expiry: string | null; receivedAt: string }[];
  }

  /**
   * Sortie de stock en FEFO, lot par lot. Si `lotId` est donné, sort de ce
   * lot précis (démarque d'un lot périmé). Ne bloque jamais : le reliquat
   * sans lot est sorti quand même et le stock peut passer en négatif.
   * À appeler dans une transaction.
   */
  issue(
    ctx: Context,
    m: Omit<MovementInput, 'qty' | 'unitCost' | 'lotId'> & { qty: Milli; lotId?: string | null },
  ): { unitCost: Fcfa; lots: { lotId: string | null; qty: Milli }[] } {
    if (m.qty <= 0) throw new AppError('Quantité à sortir invalide', 'INVALID');
    const candidates = this.lots(m.articleId, m.warehouseId).filter((l) => !m.lotId || l.id === m.lotId);
    const { allocations, unallocated } = allocateFefo(candidates, m.qty);
    const parts: { lotId: string | null; qty: Milli }[] = allocations.map((a) => ({ lotId: a.lotId, qty: a.qty }));
    if (unallocated > 0) parts.push({ lotId: null, qty: unallocated });
    const decLot = this.db.prepare('UPDATE lots SET qty = qty - ? WHERE id = ?');
    let unitCost = 0;
    for (const part of parts) {
      if (part.lotId) decLot.run(part.qty, part.lotId);
      unitCost = this.applyMovement(ctx, { ...m, qty: -part.qty, lotId: part.lotId }).unitCost;
    }
    return { unitCost, lots: parts };
  }

  /** Remet en stock (retour client) dans le lot d'origine s'il est connu, sinon dans un lot sans date. */
  restock(ctx: Context, m: { articleId: string; warehouseId: string; qty: Milli; lotId?: string | null; refType: string; refId: string }): void {
    let lotId = m.lotId ?? null;
    if (lotId) {
      this.db.prepare('UPDATE lots SET qty = qty + ? WHERE id = ?').run(m.qty, lotId);
    } else {
      lotId = newId();
      this.db
        .prepare('INSERT INTO lots (id, article_id, warehouse_id, lot_number, expiry, qty, received_at) VALUES (?, ?, ?, NULL, NULL, ?, ?)')
        .run(lotId, m.articleId, m.warehouseId, m.qty, this.now());
    }
    this.applyMovement(ctx, { type: 'RETURN', articleId: m.articleId, warehouseId: m.warehouseId, qty: m.qty, lotId, refType: m.refType, refId: m.refId });
  }

  /**
   * Réception de marchandise (bon de réception simplifié ; la chaîne
   * commande/réception/facture fournisseur arrive en phase 2).
   */
  receive(ctx: Context, input: { warehouseId: string; reference?: string; supplier?: string; lines: ReceptionLine[] }): { id: string } {
    if (input.lines.length === 0) throw new AppError('Réception vide', 'INVALID');
    return this.tx(() => {
      const receptionId = newId();
      const now = this.now();
      for (const line of input.lines) {
        if (line.qty <= 0) throw new AppError('Quantité reçue invalide', 'INVALID');
        if (!Number.isSafeInteger(line.unitCost) || line.unitCost < 0) throw new AppError("Coût d'achat invalide", 'INVALID');
        const article = this.db.prepare('SELECT perishable, name FROM articles WHERE id = ?').get(line.articleId) as
          | { perishable: number; name: string }
          | undefined;
        if (!article) throw new AppError('Article introuvable', 'NOT_FOUND');
        if (article.perishable && !line.expiry) {
          throw new AppError(`Date limite obligatoire pour « ${article.name} » (article périssable)`, 'EXPIRY_REQUIRED');
        }
        const lotId = newId();
        this.db
          .prepare('INSERT INTO lots (id, article_id, warehouse_id, lot_number, expiry, qty, received_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(lotId, line.articleId, input.warehouseId, line.lotNumber ?? null, line.expiry ?? null, line.qty, now);
        this.applyMovement(ctx, {
          type: 'RECEPTION',
          articleId: line.articleId,
          warehouseId: input.warehouseId,
          qty: line.qty,
          unitCost: line.unitCost,
          lotId,
          reason: [input.supplier, input.reference].filter(Boolean).join(' · ') || null,
          refType: 'reception',
          refId: receptionId,
        });
        this.db.prepare('UPDATE articles SET purchase_price = ?, updated_at = ? WHERE id = ?').run(line.unitCost, now, line.articleId);
      }
      this.audit(ctx.userId, 'stock.receive', 'reception', receptionId, { reference: input.reference, lines: input.lines.length });
      return { id: receptionId };
    });
  }

  /** Sortie en perte (casse, vol, péremption, consommation interne), motif obligatoire. */
  recordLoss(
    ctx: Context,
    input: { warehouseId: string; articleId: string; qty: Milli; type: MovementType; reason: string; lotId?: string | null },
  ): void {
    if (!LOSS_TYPES.includes(input.type)) throw new AppError('Type de sortie invalide', 'INVALID');
    if (!input.reason.trim()) throw new AppError('Le motif est obligatoire', 'INVALID');
    this.tx(() => {
      const ref = newId();
      this.issue(ctx, { ...input, refType: 'loss', refId: ref });
      this.audit(ctx.userId, 'stock.loss', 'article', input.articleId, { type: input.type, qty: input.qty, reason: input.reason });
    });
  }

  /** Transfert entre deux dépôts (réserve vers rayon, chambre froide…), lots et dates conservés. */
  transfer(ctx: Context, input: { fromWarehouseId: string; toWarehouseId: string; lines: { articleId: string; qty: Milli }[] }): { id: string } {
    if (input.fromWarehouseId === input.toWarehouseId) throw new AppError('Dépôts de départ et d’arrivée identiques', 'INVALID');
    return this.tx(() => {
      const transferId = newId();
      for (const line of input.lines) {
        const out = this.issue(ctx, {
          type: 'TRANSFER_OUT',
          articleId: line.articleId,
          warehouseId: input.fromWarehouseId,
          qty: line.qty,
          refType: 'transfer',
          refId: transferId,
        });
        for (const part of out.lots) {
          const source = part.lotId
            ? (this.db.prepare('SELECT lot_number, expiry, received_at FROM lots WHERE id = ?').get(part.lotId) as {
                lot_number: string | null;
                expiry: string | null;
                received_at: string;
              })
            : { lot_number: null, expiry: null, received_at: this.now() };
          const lotId = newId();
          this.db
            .prepare('INSERT INTO lots (id, article_id, warehouse_id, lot_number, expiry, qty, received_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
            .run(lotId, line.articleId, input.toWarehouseId, source.lot_number, source.expiry, part.qty, source.received_at);
          this.applyMovement(ctx, {
            type: 'TRANSFER_IN',
            articleId: line.articleId,
            warehouseId: input.toWarehouseId,
            qty: part.qty,
            unitCost: out.unitCost,
            lotId,
            refType: 'transfer',
            refId: transferId,
          });
        }
      }
      this.audit(ctx.userId, 'stock.transfer', 'transfer', transferId, input);
      return { id: transferId };
    });
  }

  /**
   * Inventaire (complet ou tournant) sans fermer le magasin. Chaque comptage
   * porte l'heure à laquelle le rayon a été compté : les ventes et entrées
   * passées depuis sont prises en compte, seul l'écart réel est corrigé.
   */
  applyInventory(
    ctx: Context,
    input: { warehouseId: string; counts: { articleId: string; counted: Milli; countedAt: string }[] },
  ): { id: string; lines: { articleId: string; expected: Milli; counted: Milli; difference: Milli; value: Fcfa }[]; totalValue: Fcfa } {
    return this.tx(() => {
      const inventoryId = newId();
      const lines = [];
      let totalValue = 0;
      for (const c of input.counts) {
        const stock = this.db
          .prepare('SELECT qty, avg_cost FROM stock WHERE article_id = ? AND warehouse_id = ?')
          .get(c.articleId, input.warehouseId) as { qty: number; avg_cost: number } | undefined;
        const since = this.db
          .prepare('SELECT COALESCE(SUM(qty), 0) FROM stock_movements WHERE article_id = ? AND warehouse_id = ? AND at > ?')
          .pluck()
          .get(c.articleId, input.warehouseId, c.countedAt) as number;
        const expected = (stock?.qty ?? 0) - since;
        const difference = c.counted - expected;
        const value = Math.round((difference * (stock?.avg_cost ?? 0)) / 1000);
        if (difference > 0) {
          this.restockAdjust(ctx, c.articleId, input.warehouseId, difference, inventoryId);
        } else if (difference < 0) {
          this.issue(ctx, {
            type: 'INVENTORY_ADJUST',
            articleId: c.articleId,
            warehouseId: input.warehouseId,
            qty: -difference,
            reason: 'Inventaire',
            refType: 'inventory',
            refId: inventoryId,
          });
        }
        totalValue += value;
        lines.push({ articleId: c.articleId, expected, counted: c.counted, difference, value });
      }
      this.audit(ctx.userId, 'stock.inventory', 'inventory', inventoryId, { warehouseId: input.warehouseId, lines: lines.length, totalValue });
      return { id: inventoryId, lines, totalValue };
    });
  }

  private restockAdjust(ctx: Context, articleId: string, warehouseId: string, qty: Milli, inventoryId: string): void {
    const lotId = newId();
    this.db
      .prepare('INSERT INTO lots (id, article_id, warehouse_id, lot_number, expiry, qty, received_at) VALUES (?, ?, ?, NULL, NULL, ?, ?)')
      .run(lotId, articleId, warehouseId, qty, this.now());
    this.applyMovement(ctx, {
      type: 'INVENTORY_ADJUST',
      articleId,
      warehouseId,
      qty,
      lotId,
      reason: 'Inventaire',
      refType: 'inventory',
      refId: inventoryId,
    });
  }

  /** État du stock d'un magasin (tous dépôts) ou d'un dépôt. */
  list(storeId: string, opts: { warehouseId?: string; search?: string; level?: StockLevel } = {}): StockRow[] {
    const rows = this.db
      .prepare(
        `SELECT a.id AS article_id, a.code, a.name, a.unit, d.name AS department_name, a.alert_qty, a.max_qty,
                COALESCE(SUM(s.qty), 0) AS qty,
                CASE WHEN SUM(CASE WHEN s.qty > 0 THEN s.qty END) > 0
                     THEN CAST(ROUND(SUM(CASE WHEN s.qty > 0 THEN s.qty * s.avg_cost END) * 1.0 / SUM(CASE WHEN s.qty > 0 THEN s.qty END)) AS INTEGER)
                     ELSE COALESCE(MAX(s.avg_cost), a.purchase_price) END AS avg_cost,
                (SELECT MIN(l.expiry) FROM lots l JOIN warehouses lw ON lw.id = l.warehouse_id
                  WHERE l.article_id = a.id AND l.qty > 0 AND l.expiry IS NOT NULL AND lw.store_id = @storeId
                    AND (@warehouseId IS NULL OR l.warehouse_id = @warehouseId)) AS next_expiry
         FROM articles a
         LEFT JOIN families f ON f.id = a.family_id
         LEFT JOIN departments d ON d.id = f.department_id
         LEFT JOIN stock s ON s.article_id = a.id
              AND s.warehouse_id IN (SELECT id FROM warehouses WHERE store_id = @storeId AND (@warehouseId IS NULL OR id = @warehouseId))
         WHERE a.active = 1 AND (@search IS NULL OR a.name LIKE @search OR a.code LIKE @search)
         GROUP BY a.id
         ORDER BY a.name`,
      )
      .all({ storeId, warehouseId: opts.warehouseId ?? null, search: opts.search ? `%${opts.search}%` : null }) as Omit<
      StockRow,
      'level' | 'value'
    >[];
    return rows
      .map((r) => ({
        ...r,
        value: Math.round((Math.max(0, r.qty) * r.avg_cost) / 1000),
        level: stockLevel(r.qty, { alert: r.alert_qty, max: r.max_qty }),
      }))
      .filter((r) => !opts.level || r.level === opts.level);
  }

  /** Lots qui périment dans les `days` prochains jours (ou déjà périmés). */
  expiringLots(storeId: string, days = 7): ExpiringLot[] {
    const today = this.today();
    const limit = new Date(Date.parse(`${today}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
    const rows = this.db
      .prepare(
        `SELECT l.id AS lot_id, l.article_id, a.name, w.name AS warehouse_name, l.lot_number, l.expiry, l.qty
         FROM lots l JOIN articles a ON a.id = l.article_id JOIN warehouses w ON w.id = l.warehouse_id
         WHERE w.store_id = ? AND l.qty > 0 AND l.expiry IS NOT NULL AND l.expiry <= ?
         ORDER BY l.expiry, a.name`,
      )
      .all(storeId, limit) as Omit<ExpiringLot, 'days' | 'alert'>[];
    return rows.map((r) => ({ ...r, days: daysUntil(r.expiry, today), alert: expiryAlert(r.expiry, today) }));
  }

  lotsOf(articleId: string, storeId: string) {
    return this.db
      .prepare(
        `SELECT l.id, l.lot_number, l.expiry, l.qty, l.received_at, w.name AS warehouse_name
         FROM lots l JOIN warehouses w ON w.id = l.warehouse_id
         WHERE l.article_id = ? AND w.store_id = ? AND l.qty > 0 ORDER BY l.expiry IS NULL, l.expiry, l.received_at`,
      )
      .all(articleId, storeId) as { id: string; lot_number: string | null; expiry: string | null; qty: number; received_at: string; warehouse_name: string }[];
  }

  movements(storeId: string, opts: { articleId?: string; limit?: number } = {}) {
    return this.db
      .prepare(
        `SELECT m.id, m.type, m.qty, m.unit_cost, m.reason, m.ref_type, m.at, a.name AS article_name, a.unit,
                w.name AS warehouse_name, u.name AS user_name
         FROM stock_movements m
         JOIN articles a ON a.id = m.article_id
         JOIN warehouses w ON w.id = m.warehouse_id
         LEFT JOIN users u ON u.id = m.user_id
         WHERE w.store_id = @storeId AND (@articleId IS NULL OR m.article_id = @articleId)
         ORDER BY m.at DESC LIMIT @limit`,
      )
      .all({ storeId, articleId: opts.articleId ?? null, limit: opts.limit ?? 300 }) as {
      id: string;
      type: MovementType;
      qty: number;
      unit_cost: number;
      reason: string | null;
      ref_type: string | null;
      at: string;
      article_name: string;
      unit: 'piece' | 'kg' | 'litre';
      warehouse_name: string;
      user_name: string | null;
    }[];
  }
}
