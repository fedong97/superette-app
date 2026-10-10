import {
  type ExpiryAlert,
  type Fcfa,
  type Milli,
  type MovementType,
  type StockLevel,
  LOSS_TYPES,
  allocateFefo,
  daysUntil,
  describeInPacks,
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
  /** Ligne de bon de commande soldée par cette réception. */
  orderLineId?: string | null;
  /** Prix payé pour un conditionnement (la palette) et unités qu'il contient : garde le prix exact. */
  packCost?: Fcfa;
  packUnits?: Milli;
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
  /** Quantité en conditionnements (« 2 Carton 3 Paquet 4 Ampoule ») ; vide sans conditionnement. */
  in_packs: string;
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

/** Lot sorti par un transfert, recréé à l'arrivée avec ses dates. */
export interface TransferLot {
  qty: Milli;
  lot_number: string | null;
  expiry: string | null;
  received_at: string;
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
  /** Date du mouvement, si ce n'est pas maintenant (inventaire arrêté à une date passée). */
  at?: string;
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
      at: m.at ?? this.now(),
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

  /** Crée un lot ; sa quantité est ensuite tenue par les mouvements qui le citent. */
  private insertLot(
    ctx: Context,
    lot: { id: string; articleId: string; warehouseId: string; lotNumber?: string | null; expiry?: string | null; qty: Milli; receivedAt?: string },
  ): void {
    const row = {
      id: lot.id,
      article_id: lot.articleId,
      warehouse_id: lot.warehouseId,
      lot_number: lot.lotNumber ?? null,
      expiry: lot.expiry ?? null,
      qty: lot.qty,
      received_at: lot.receivedAt ?? this.now(),
    };
    this.db
      .prepare(
        `INSERT INTO lots (id, article_id, warehouse_id, lot_number, expiry, qty, received_at)
         VALUES (@id, @article_id, @warehouse_id, @lot_number, @expiry, @qty, @received_at)`,
      )
      .run(row);
    this.enqueue(ctx, 'lot', lot.id, 'upsert', row);
  }

  /**
   * Recalcule le stock d'un article dans un dépôt en rejouant ses mouvements
   * dans l'ordre chronologique (quantité et CMUP). Utilisé après réception de
   * mouvements d'autres caisses : tous les postes obtiennent le même résultat.
   */
  recompute(articleId: string, warehouseId: string): void {
    const moves = this.db
      .prepare('SELECT type, qty, unit_cost FROM stock_movements WHERE article_id = ? AND warehouse_id = ? ORDER BY at, id')
      .all(articleId, warehouseId) as { type: MovementType; qty: number; unit_cost: number }[];
    let qty = 0;
    let avg = 0;
    for (const m of moves) {
      if (m.qty > 0 && (m.type === 'RECEPTION' || m.type === 'TRANSFER_IN')) avg = weightedAverageCost(qty, avg, m.qty, m.unit_cost);
      qty += m.qty;
    }
    this.db
      .prepare(
        `INSERT INTO stock (article_id, warehouse_id, qty, avg_cost) VALUES (?, ?, ?, ?)
         ON CONFLICT(article_id, warehouse_id) DO UPDATE SET qty = excluded.qty, avg_cost = excluded.avg_cost`,
      )
      .run(articleId, warehouseId, qty, avg);
  }

  /**
   * Valeur du stock d'un magasin au soir d'une date (CMUP rejoué à partir des
   * mouvements), pour l'inventaire de fin d'exercice. Un stock négatif compte zéro.
   */
  valueAt(storeId: string, date: string): Fcfa {
    const moves = this.db
      .prepare(
        `SELECT m.article_id, m.warehouse_id, m.type, m.qty, m.unit_cost FROM stock_movements m
         JOIN warehouses w ON w.id = m.warehouse_id
         WHERE w.store_id = ? AND date(m.at, 'localtime') <= ? ORDER BY m.article_id, m.warehouse_id, m.at, m.id`,
      )
      .all(storeId, date) as { article_id: string; warehouse_id: string; type: MovementType; qty: number; unit_cost: number }[];
    let total = 0;
    let key = '';
    let qty = 0;
    let avg = 0;
    const flush = () => {
      total += Math.round((Math.max(0, qty) * avg) / 1000);
    };
    for (const m of moves) {
      const k = `${m.article_id}|${m.warehouse_id}`;
      if (k !== key) {
        if (key) flush();
        key = k;
        qty = 0;
        avg = 0;
      }
      if (m.qty > 0 && (m.type === 'RECEPTION' || m.type === 'TRANSFER_IN')) avg = weightedAverageCost(qty, avg, m.qty, m.unit_cost);
      qty += m.qty;
    }
    if (key) flush();
    return total;
  }

  /** Quantité d'un lot = somme des mouvements qui le citent. */
  recomputeLot(lotId: string): void {
    this.db
      .prepare('UPDATE lots SET qty = (SELECT COALESCE(SUM(qty), 0) FROM stock_movements WHERE lot_id = ?) WHERE id = ?')
      .run(lotId, lotId);
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
      this.insertLot(ctx, { id: lotId, articleId: m.articleId, warehouseId: m.warehouseId, qty: m.qty });
    }
    this.applyMovement(ctx, { type: 'RETURN', articleId: m.articleId, warehouseId: m.warehouseId, qty: m.qty, lotId, refType: m.refType, refId: m.refId });
  }

  /**
   * Réception de marchandise (bon de réception simplifié ; la chaîne
   * commande/réception/facture fournisseur arrive en phase 2).
   */
  receive(
    ctx: Context,
    input: { warehouseId: string; reference?: string; supplier?: string; supplierId?: string | null; orderId?: string | null; lines: ReceptionLine[] },
  ): { id: string; number: string } {
    if (input.lines.length === 0) throw new AppError('Réception vide', 'INVALID');
    return this.tx(() => {
      const receptionId = newId();
      const number = `BR-${this.stationPrefix()}-${String(this.nextCounter('reception.number')).padStart(5, '0')}`;
      const now = this.now();
      const supplierName = input.supplierId
        ? ((this.db.prepare('SELECT name FROM suppliers WHERE id = ?').pluck().get(input.supplierId) as string | undefined) ?? input.supplier)
        : input.supplier;
      const reception = {
        id: receptionId,
        number,
        store_id: ctx.storeId,
        warehouse_id: input.warehouseId,
        supplier_id: input.supplierId ?? null,
        order_id: input.orderId ?? null,
        delivery_note: input.reference?.trim() || null,
        invoice_id: null,
        user_id: ctx.userId,
        received_at: now,
      };
      this.db
        .prepare(
          `INSERT INTO receptions (id, number, store_id, warehouse_id, supplier_id, order_id, delivery_note, invoice_id, user_id, received_at)
           VALUES (@id, @number, @store_id, @warehouse_id, @supplier_id, @order_id, @delivery_note, @invoice_id, @user_id, @received_at)`,
        )
        .run(reception);
      // Magasin non assujetti : le coût saisi est le prix payé, sans TVA récupérable.
      const vatEnabled = (this.db.prepare('SELECT vat_enabled FROM stores WHERE id = ?').pluck().get(ctx.storeId) as number | undefined) !== 0;
      const insertLine = this.db.prepare(
        `INSERT INTO reception_lines (id, reception_id, line_no, article_id, order_line_id, qty, unit_cost, vat_rate_bp, lot_id, lot_number, expiry)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      input.lines.forEach((line, i) => {
        if (line.qty <= 0) throw new AppError('Quantité reçue invalide', 'INVALID');
        if (!Number.isSafeInteger(line.unitCost) || line.unitCost < 0) throw new AppError("Coût d'achat invalide", 'INVALID');
        const article = this.db
          .prepare('SELECT a.perishable, a.name, v.rate_bp FROM articles a JOIN vat_rates v ON v.id = a.vat_rate_id WHERE a.id = ?')
          .get(line.articleId) as { perishable: number; name: string; rate_bp: number } | undefined;
        if (!article) throw new AppError('Article introuvable', 'NOT_FOUND');
        if (article.perishable && !line.expiry) {
          throw new AppError(`Date limite obligatoire pour « ${article.name} » (article périssable)`, 'EXPIRY_REQUIRED');
        }
        // Stock négatif (vendu sans stock) : la réception en couvre d'abord le manque.
        const before = (this.db.prepare('SELECT qty FROM stock WHERE article_id = ? AND warehouse_id = ?').pluck().get(line.articleId, input.warehouseId) as Milli | undefined) ?? 0;
        const lotId = newId();
        this.insertLot(ctx, {
          id: lotId,
          articleId: line.articleId,
          warehouseId: input.warehouseId,
          lotNumber: line.lotNumber,
          expiry: line.expiry,
          qty: line.qty,
          receivedAt: now,
        });
        this.applyMovement(ctx, {
          type: 'RECEPTION',
          articleId: line.articleId,
          warehouseId: input.warehouseId,
          qty: line.qty,
          unitCost: line.unitCost,
          lotId,
          reason: [supplierName, input.reference].filter(Boolean).join(' · ') || null,
          refType: 'reception',
          refId: receptionId,
        });
        if (before < 0) this.regularize(ctx, line.articleId, input.warehouseId, lotId, Math.min(line.qty, -before), receptionId);
        insertLine.run(
          newId(),
          receptionId,
          i + 1,
          line.articleId,
          line.orderLineId ?? null,
          line.qty,
          line.unitCost,
          vatEnabled ? article.rate_bp : 0,
          lotId,
          line.lotNumber ?? null,
          line.expiry ?? null,
        );
        this.updatePurchasePrice(line, now);
        this.enqueue(null, 'article', line.articleId, 'upsert', {});
      });
      this.enqueue(ctx, 'reception', receptionId, 'upsert', reception);
      this.audit(ctx.userId, 'stock.receive', 'reception', receptionId, { number, reference: input.reference, lines: input.lines.length });
      return { id: receptionId, number };
    });
  }

  /**
   * Régularisation des ventes faites sans stock (« Ignorer la gestion des
   * stocks ») : la quantité vendue sans lot est imputée au lot qui vient
   * d'arriver. Deux mouvements de même quantité, l'un sur le lot, l'autre sans
   * lot : le stock ne bouge pas, le lot reçu baisse de ce qui était déjà vendu.
   */
  private regularize(ctx: Context, articleId: string, warehouseId: string, lotId: string, qty: Milli, receptionId: string): void {
    this.db.prepare('UPDATE lots SET qty = qty - ? WHERE id = ?').run(qty, lotId);
    const base = { type: 'REGULARIZATION' as const, articleId, warehouseId, reason: 'Ventes faites sans stock', refType: 'reception', refId: receptionId };
    this.applyMovement(ctx, { ...base, qty: -qty, lotId });
    this.applyMovement(ctx, { ...base, qty, lotId: null });
    this.audit(ctx.userId, 'stock.regularize', 'article', articleId, { qty, receptionId });
  }

  /**
   * Dernier prix d'achat de l'article, à l'unité et au conditionnement d'achat.
   * Le prix de revient garde son écart avec l'achat (transport, manutention).
   */
  private updatePurchasePrice(line: ReceptionLine, now: string): void {
    const a = this.db
      .prepare(
        `SELECT a.pack_purchase_price, a.pack_cost_price, COALESCE((SELECT units FROM article_packs p WHERE p.article_id = a.id AND p.position = 1), 1000) AS units
         FROM articles a WHERE a.id = ?`,
      )
      .get(line.articleId) as { pack_purchase_price: Fcfa | null; pack_cost_price: Fcfa | null; units: Milli };
    const packPrice =
      line.packCost !== undefined && line.packUnits === a.units && Number.isSafeInteger(line.packCost) && line.packCost >= 0
        ? line.packCost
        : Math.round((line.unitCost * a.units) / 1000);
    const cost = a.pack_cost_price !== null && a.pack_purchase_price !== null ? Math.max(0, a.pack_cost_price + packPrice - a.pack_purchase_price) : packPrice;
    this.db
      .prepare('UPDATE articles SET purchase_price = ?, pack_purchase_price = ?, pack_cost_price = ?, updated_at = ? WHERE id = ?')
      .run(line.unitCost, packPrice, cost, now, line.articleId);
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
        const out = this.transferOut(ctx, { articleId: line.articleId, warehouseId: input.fromWarehouseId, qty: line.qty, refId: transferId });
        this.transferIn(ctx, { articleId: line.articleId, warehouseId: input.toWarehouseId, qty: line.qty, unitCost: out.unitCost, lots: out.lots, refId: transferId });
      }
      this.audit(ctx.userId, 'stock.transfer', 'transfer', transferId, input);
      return { id: transferId };
    });
  }

  /** Sortie d'un transfert : FEFO, et les lots sortis (numéro, péremption, date d'entrée) pour les recréer à l'arrivée. */
  transferOut(
    ctx: Context,
    m: { articleId: string; warehouseId: string; qty: Milli; refId: string; reason?: string | null },
  ): { unitCost: Fcfa; lots: TransferLot[] } {
    const out = this.issue(ctx, { type: 'TRANSFER_OUT', articleId: m.articleId, warehouseId: m.warehouseId, qty: m.qty, refType: 'transfer', refId: m.refId, reason: m.reason ?? null });
    const lotOf = this.db.prepare('SELECT lot_number, expiry, received_at FROM lots WHERE id = ?');
    const lots = out.lots.map((part) => {
      const src = part.lotId ? (lotOf.get(part.lotId) as { lot_number: string | null; expiry: string | null; received_at: string }) : null;
      return { qty: part.qty, lot_number: src?.lot_number ?? null, expiry: src?.expiry ?? null, received_at: src?.received_at ?? this.now() };
    });
    return { unitCost: out.unitCost, lots };
  }

  /** Entrée d'un transfert : `qty` répartie sur les lots sortis, dans l'ordre ; le surplus éventuel dans le dernier lot. */
  transferIn(
    ctx: Context,
    m: { articleId: string; warehouseId: string; qty: Milli; unitCost: Fcfa; lots: TransferLot[]; refId: string; reason?: string | null },
  ): void {
    let left = m.qty;
    const lots = m.lots.length ? m.lots : [{ qty: m.qty, lot_number: null, expiry: null, received_at: this.now() }];
    lots.forEach((src, i) => {
      const qty = i === lots.length - 1 ? left : Math.min(left, src.qty);
      if (qty <= 0) return;
      left -= qty;
      const lotId = newId();
      this.insertLot(ctx, { id: lotId, articleId: m.articleId, warehouseId: m.warehouseId, lotNumber: src.lot_number, expiry: src.expiry, qty, receivedAt: src.received_at });
      this.applyMovement(ctx, { type: 'TRANSFER_IN', articleId: m.articleId, warehouseId: m.warehouseId, qty, unitCost: m.unitCost, lotId, refType: 'transfer', refId: m.refId, reason: m.reason ?? null });
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

  private restockAdjust(ctx: Context, articleId: string, warehouseId: string, qty: Milli, inventoryId: string, reason = 'Inventaire', at?: string, refType = 'inventory'): void {
    const lotId = newId();
    this.insertLot(ctx, { id: lotId, articleId, warehouseId, qty, receivedAt: at });
    this.applyMovement(ctx, {
      type: 'INVENTORY_ADJUST',
      articleId,
      warehouseId,
      qty,
      lotId,
      reason,
      refType,
      refId: inventoryId,
      at,
    });
  }

  /**
   * Correction d'inventaire d'un article : entrée (lot sans date) ou sortie
   * FEFO de l'écart constaté. À appeler dans une transaction.
   */
  adjustForInventory(ctx: Context, m: { articleId: string; warehouseId: string; difference: Milli; inventoryId: string; reason: string; at?: string; refType?: string }): void {
    if (m.difference > 0) this.restockAdjust(ctx, m.articleId, m.warehouseId, m.difference, m.inventoryId, m.reason, m.at, m.refType);
    else if (m.difference < 0)
      this.issue(ctx, {
        type: 'INVENTORY_ADJUST',
        articleId: m.articleId,
        warehouseId: m.warehouseId,
        qty: -m.difference,
        reason: m.reason,
        refType: m.refType ?? 'inventory',
        refId: m.inventoryId,
        at: m.at,
      });
  }

  /** État du stock d'un magasin (tous dépôts) ou d'un dépôt. */
  list(storeId: string, opts: { warehouseId?: string; search?: string; level?: StockLevel } = {}): StockRow[] {
    const rows = this.db
      .prepare(
        `SELECT a.id AS article_id, a.code, a.name, a.unit, a.unit_name, d.name AS department_name, a.alert_qty, a.max_qty,
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
      .all({ storeId, warehouseId: opts.warehouseId ?? null, search: opts.search ? `%${opts.search}%` : null }) as (Omit<
      StockRow,
      'level' | 'value' | 'in_packs'
    > & { unit_name: string | null })[];
    const packs = new Map<string, { name: string; units: Milli }[]>();
    for (const p of this.db.prepare('SELECT article_id, name, units FROM article_packs ORDER BY article_id, position').all() as { article_id: string; name: string; units: Milli }[]) {
      const list = packs.get(p.article_id) ?? [];
      list.push(p);
      packs.set(p.article_id, list);
    }
    return rows
      .map(({ unit_name, ...r }) => ({
        ...r,
        value: Math.round((Math.max(0, r.qty) * r.avg_cost) / 1000),
        level: stockLevel(r.qty, { alert: r.alert_qty, max: r.max_qty }),
        in_packs: packs.has(r.article_id) ? describeInPacks(r.qty, packs.get(r.article_id)!, unit_name || 'Pièce') : '',
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

  movements(storeId: string, opts: { articleId?: string; limit?: number; types?: MovementType[] } = {}) {
    return this.db
      .prepare(
        `SELECT m.id, m.type, m.qty, m.unit_cost, m.reason, m.ref_type, m.at, a.name AS article_name, a.unit,
                w.name AS warehouse_name, u.name AS user_name
         FROM stock_movements m
         JOIN articles a ON a.id = m.article_id
         JOIN warehouses w ON w.id = m.warehouse_id
         LEFT JOIN users u ON u.id = m.user_id
         WHERE w.store_id = @storeId AND (@articleId IS NULL OR m.article_id = @articleId)
           AND (@types IS NULL OR m.type IN (SELECT value FROM json_each(@types)))
         ORDER BY m.at DESC LIMIT @limit`,
      )
      .all({ storeId, articleId: opts.articleId ?? null, limit: opts.limit ?? 300, types: opts.types?.length ? JSON.stringify(opts.types) : null }) as {
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
