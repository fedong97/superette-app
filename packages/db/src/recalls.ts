import type { Fcfa, Milli } from '@superette/core';
import type { Db } from './database';
import type { SupplierReturn, SupplierReturnService } from './supplierReturns';
import { AppError, Base, type Clock, type Context, newId } from './util';

/**
 * Condition SQL : le lot `alias` est visé par un rappel ouvert (même article, même
 * n° de lot, et même date limite si le rappel en donne une).
 */
export function recalledLot(alias: string): string {
  return `EXISTS (SELECT 1 FROM lot_recalls rc WHERE rc.status = 'open' AND rc.article_id = ${alias}.article_id
    AND (rc.lot_number IS NULL OR lower(trim(COALESCE(${alias}.lot_number, ''))) = lower(trim(rc.lot_number)))
    AND (rc.expiry IS NULL OR ${alias}.expiry = rc.expiry))`;
}

export interface LotRecall {
  id: string;
  store_id: string;
  article_id: string;
  article_code: string;
  article_name: string;
  lot_number: string | null;
  expiry: string | null;
  reason: string;
  status: 'open' | 'closed';
  note: string | null;
  user_name: string | null;
  closed_at: string | null;
  created_at: string;
}

export interface RecallDetail {
  recall: LotRecall;
  /** Stock du lot, dépôt par dépôt, et son fournisseur (celui de la réception). */
  lots: { lot_id: string; warehouse_id: string; warehouse_name: string; qty: Milli; expiry: string | null; received_at: string; supplier_id: string | null; supplier_name: string | null }[];
  /** Clients connus qui ont acheté ce lot (vente à crédit, carte de fidélité, client choisi en caisse). */
  buyers: { customer_id: string; name: string; phone: string | null; qty: Milli; last_at: string; sales: string }[];
  /** Ce qui a été vendu du lot à des clients de passage (sans fiche). */
  anonymous: { qty: Milli; tickets: number };
  /** Retours au fournisseur déjà faits pour ce rappel. */
  returns: { id: string; number: string; supplier_name: string; total: Fcfa }[];
}

/**
 * Rappel d'un lot (fournisseur, ministère) : tant que le rappel est ouvert, le
 * lot ne sort plus à la caisse ; l'écran montre son stock dans chaque dépôt,
 * les clients connus qui l'ont acheté (pour les prévenir) et prépare le
 * retour au fournisseur.
 */
export class RecallService extends Base {
  constructor(
    db: Db,
    clock: Clock,
    private readonly supplierReturns: SupplierReturnService,
  ) {
    super(db, clock);
  }

  create(ctx: Context, input: { articleId: string; lotNumber?: string | null; expiry?: string | null; reason: string; note?: string | null }): RecallDetail {
    const article = this.db.prepare('SELECT id, name FROM articles WHERE id = ?').get(input.articleId) as { id: string; name: string } | undefined;
    if (!article) throw new AppError('Produit introuvable', 'NOT_FOUND');
    const lot = input.lotNumber?.trim().slice(0, 40) || null;
    const expiry = input.expiry?.trim() || null;
    if (!lot && !expiry) throw new AppError('Indiquez le numéro du lot rappelé, ou sa date limite', 'INVALID');
    if (expiry && !/^\d{4}-\d{2}-\d{2}$/.test(expiry)) throw new AppError('Date limite invalide', 'INVALID');
    const reason = input.reason.trim();
    if (!reason) throw new AppError('Indiquez le motif du rappel (avis du fournisseur, du ministère…)', 'REASON_REQUIRED');
    const twin = this.db
      .prepare("SELECT 1 FROM lot_recalls WHERE store_id = ? AND article_id = ? AND status = 'open' AND COALESCE(lower(lot_number), '') = COALESCE(lower(?), '') AND COALESCE(expiry, '') = COALESCE(?, '')")
      .get(ctx.storeId, article.id, lot, expiry);
    if (twin) throw new AppError('Ce lot est déjà rappelé', 'DUPLICATE');
    const id = newId();
    const now = this.now();
    this.tx(() => {
      this.db
        .prepare(
          `INSERT INTO lot_recalls (id, store_id, article_id, lot_number, expiry, reason, status, note, user_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)`,
        )
        .run(id, ctx.storeId, article.id, lot, expiry, reason, input.note?.trim() || null, ctx.userId, now, now);
      this.enqueue(ctx, 'lot_recall', id, 'upsert', {});
      this.audit(ctx.userId, 'recall.create', 'lot_recall', id, { article: article.name, lot, expiry, reason });
    });
    return this.detail(id);
  }

  get(id: string): LotRecall {
    const r = this.db
      .prepare(
        `SELECT r.*, a.code AS article_code, a.name AS article_name, u.name AS user_name FROM lot_recalls r JOIN articles a ON a.id = r.article_id
         LEFT JOIN users u ON u.id = r.user_id WHERE r.id = ?`,
      )
      .get(id) as LotRecall | undefined;
    if (!r) throw new AppError('Rappel introuvable', 'NOT_FOUND');
    return r;
  }

  list(storeId: string, opts: { open?: boolean } = {}): (LotRecall & { stock: Milli; buyers: number })[] {
    const ids = this.db
      .prepare(`SELECT id FROM lot_recalls WHERE store_id = ? ${opts.open ? "AND status = 'open'" : ''} ORDER BY status = 'open' DESC, created_at DESC LIMIT 500`)
      .pluck()
      .all(storeId) as string[];
    return ids.map((id) => {
      const d = this.detail(id);
      return { ...d.recall, stock: d.lots.reduce((t, l) => t + l.qty, 0), buyers: d.buyers.length };
    });
  }

  /** Lots du magasin touchés par le rappel (avec ou sans stock), dans l'ordre des dépôts. */
  private lotIds(recall: LotRecall): string[] {
    return this.db
      .prepare(
        `SELECT l.id FROM lots l JOIN warehouses w ON w.id = l.warehouse_id WHERE w.store_id = ? AND l.article_id = ?
         AND (? IS NULL OR lower(trim(COALESCE(l.lot_number, ''))) = lower(trim(?))) AND (? IS NULL OR l.expiry = ?)`,
      )
      .pluck()
      .all(recall.store_id, recall.article_id, recall.lot_number, recall.lot_number, recall.expiry, recall.expiry) as string[];
  }

  detail(id: string): RecallDetail {
    const recall = this.get(id);
    const ids = this.lotIds(recall);
    const marks = ids.map(() => '?').join(',') || "''";
    const lots = this.db
      .prepare(
        `SELECT l.id AS lot_id, l.warehouse_id, w.name AS warehouse_name, l.qty, l.expiry, l.received_at,
                (SELECT r.supplier_id FROM stock_movements m JOIN receptions r ON r.id = m.ref_id WHERE m.lot_id = l.id AND m.ref_type = 'reception' LIMIT 1) AS supplier_id,
                (SELECT f.name FROM stock_movements m JOIN receptions r ON r.id = m.ref_id JOIN suppliers f ON f.id = r.supplier_id WHERE m.lot_id = l.id AND m.ref_type = 'reception' LIMIT 1) AS supplier_name
         FROM lots l JOIN warehouses w ON w.id = l.warehouse_id WHERE l.id IN (${marks}) ORDER BY w.name, l.received_at`,
      )
      .all(...ids) as RecallDetail['lots'];
    // Ventes de ces lots, moins ce qui en est revenu (retours clients).
    const sold = this.db
      .prepare(
        `SELECT s.customer_id, c.name, c.phone, -SUM(m.qty) AS qty, MAX(s.created_at) AS last_at, GROUP_CONCAT(DISTINCT s.number) AS sales, COUNT(DISTINCT s.id) AS tickets
         FROM stock_movements m JOIN sales s ON s.id = m.ref_id AND m.ref_type = 'sale' LEFT JOIN customers c ON c.id = s.customer_id
         WHERE m.lot_id IN (${marks}) AND m.type = 'SALE' AND s.status = 'completed'
         GROUP BY s.customer_id ORDER BY last_at DESC`,
      )
      .all(...ids) as { customer_id: string | null; name: string | null; phone: string | null; qty: Milli; last_at: string; sales: string; tickets: number }[];
    const anon = sold.find((s) => !s.customer_id);
    const returns = this.db
      .prepare(
        `SELECT DISTINCT x.id, x.number, f.name AS supplier_name, x.total_ht + x.total_tva AS total FROM supplier_returns x JOIN suppliers f ON f.id = x.supplier_id
         JOIN stock_movements m ON m.ref_type = 'supplier_return' AND m.ref_id = x.id WHERE m.lot_id IN (${marks}) ORDER BY x.created_at`,
      )
      .all(...ids) as RecallDetail['returns'];
    return {
      recall,
      lots,
      buyers: sold.filter((s) => s.customer_id).map((s) => ({ customer_id: s.customer_id!, name: s.name ?? '', phone: s.phone, qty: s.qty, last_at: s.last_at, sales: s.sales })),
      anonymous: { qty: anon?.qty ?? 0, tickets: anon?.tickets ?? 0 },
      returns,
    };
  }

  /**
   * Rend au fournisseur tout le stock du lot rappelé dans un dépôt : bon de
   * retour (sortie de stock et avoir attendu), au prix d'achat de l'article.
   */
  returnToSupplier(ctx: Context, id: string, input: { supplierId: string; warehouseId: string }): SupplierReturn {
    const d = this.detail(id);
    if (d.recall.store_id !== ctx.storeId) throw new AppError('Rappel introuvable', 'NOT_FOUND');
    const lots = d.lots.filter((l) => l.warehouse_id === input.warehouseId && l.qty > 0);
    if (!lots.length) throw new AppError('Plus rien de ce lot dans ce dépôt', 'EMPTY');
    const lotLabel = d.recall.lot_number ? `lot ${d.recall.lot_number}` : `DLC ${d.recall.expiry!.split('-').reverse().join('/')}`;
    return this.supplierReturns.create(ctx, {
      supplierId: input.supplierId,
      warehouseId: input.warehouseId,
      reason: `Rappel du ${lotLabel} : ${d.recall.reason}`,
      lines: lots.map((l) => ({ articleId: d.recall.article_id, qty: l.qty, lotId: l.lot_id })),
    });
  }

  close(ctx: Context, id: string, note?: string | null): LotRecall {
    const r = this.get(id);
    if (r.store_id !== ctx.storeId) throw new AppError('Rappel introuvable', 'NOT_FOUND');
    if (r.status === 'closed') return r;
    const now = this.now();
    this.tx(() => {
      this.db.prepare("UPDATE lot_recalls SET status = 'closed', closed_at = ?, note = COALESCE(?, note), updated_at = ? WHERE id = ?").run(now, note?.trim() || null, now, id);
      this.enqueue(ctx, 'lot_recall', id, 'upsert', {});
      this.audit(ctx.userId, 'recall.close', 'lot_recall', id, { note });
    });
    return this.get(id);
  }

  /** Rappels ouverts d'un article (la caisse prévient le caissier). */
  openFor(articleId: string): LotRecall[] {
    const ids = this.db.prepare("SELECT id FROM lot_recalls WHERE article_id = ? AND status = 'open'").pluck().all(articleId) as string[];
    return ids.map((id) => this.get(id));
  }

  /** Articles du magasin sous rappel ouvert, avec le lot : la caisse les signale dès qu'on les scanne. */
  openArticles(storeId: string): { article_id: string; lot_number: string | null; expiry: string | null; reason: string }[] {
    return this.db.prepare("SELECT article_id, lot_number, expiry, reason FROM lot_recalls WHERE store_id = ? AND status = 'open'").all(storeId) as never;
  }
}

/** Quantité d'un article dans un dépôt qui appartient à un lot rappelé (elle ne se vend plus). */
export function recalledQty(db: Db, articleId: string, warehouseId: string): Milli {
  return (
    (db.prepare(`SELECT COALESCE(SUM(l.qty), 0) FROM lots l WHERE l.article_id = ? AND l.warehouse_id = ? AND l.qty > 0 AND ${recalledLot('l')}`).pluck().get(articleId, warehouseId) as number) ?? 0
  );
}
