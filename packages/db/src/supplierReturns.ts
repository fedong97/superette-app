import { type Fcfa, type Milli, lineAmount } from '@superette/core';
import type { Db } from './database';
import { type PurchaseService, type SupplierInvoice, taxTotals } from './purchases';
import type { StockService } from './stock';
import { AppError, Base, type Clock, type Context, newId } from './util';

/** Ouvert : l'avoir du fournisseur est attendu. Avoir reçu : l'avoir est saisi et rattaché. */
export type SupplierReturnStatus = 'open' | 'credited';

export const SUPPLIER_RETURN_STATUS: Record<SupplierReturnStatus, string> = { open: 'Avoir attendu', credited: 'Avoir reçu' };

export interface SupplierReturnLineInput {
  articleId: string;
  qty: Milli;
  /** Prix d'achat HT à rembourser par unité ; absent : le dernier prix d'achat de la fiche. */
  unitCost?: Fcfa | null;
  /** Lot rendu (produits périmés) ; absent : les plus vieux d'abord. */
  lotId?: string | null;
}

export interface SupplierReturn {
  id: string;
  number: string;
  store_id: string;
  warehouse_id: string;
  warehouse_name: string;
  supplier_id: string;
  supplier_name: string;
  reason: string;
  status: SupplierReturnStatus;
  total_ht: Fcfa;
  total_tva: Fcfa;
  total_ttc: Fcfa;
  credit_note_id: string | null;
  credit_note_number: string | null;
  credit_note_ttc: Fcfa | null;
  user_name: string | null;
  created_at: string;
  lines: {
    id: string;
    line_no: number;
    article_id: string;
    code: string;
    name: string;
    unit: 'piece' | 'kg' | 'litre';
    qty: Milli;
    unit_cost: Fcfa;
    vat_rate_bp: number;
    total_ht: Fcfa;
    lot_number: string | null;
    expiry: string | null;
  }[];
}

/**
 * Retours de marchandise au fournisseur (casse, périmés, erreur de livraison) :
 * le bon de retour fait sortir la marchandise du stock et ouvre un avoir
 * attendu ; quand le fournisseur envoie son avoir, il est saisi depuis le bon
 * et vient en déduction de ce qu'on lui doit.
 */
export class SupplierReturnService extends Base {
  constructor(
    db: Db,
    clock: Clock,
    private readonly stock: StockService,
    private readonly purchases: PurchaseService,
  ) {
    super(db, clock);
  }

  create(ctx: Context, input: { supplierId: string; warehouseId: string; reason: string; lines: SupplierReturnLineInput[] }): SupplierReturn {
    const supplier = this.purchases.getSupplier(input.supplierId);
    const reason = input.reason.trim();
    if (!reason) throw new AppError('Indiquez le motif du retour (casse, périmés, erreur de livraison…)', 'REASON_REQUIRED');
    const wh = this.db.prepare('SELECT store_id, active FROM warehouses WHERE id = ?').get(input.warehouseId) as { store_id: string; active: number } | undefined;
    if (!wh || wh.store_id !== ctx.storeId) throw new AppError("Ce dépôt n'est pas dans ce magasin", 'FORBIDDEN');
    const lines = input.lines.filter((l) => l.qty !== 0);
    if (lines.length === 0) throw new AppError('Ajoutez au moins un article à rendre', 'EMPTY');
    const vat = (this.db.prepare('SELECT vat_enabled FROM stores WHERE id = ?').pluck().get(ctx.storeId) as number | undefined) !== 0;
    const priced = lines.map((l) => {
      if (!Number.isSafeInteger(l.qty) || l.qty <= 0) throw new AppError('Quantité rendue invalide', 'INVALID');
      const a = this.db
        .prepare('SELECT a.id, a.name, a.purchase_price, v.rate_bp, a.is_service FROM articles a JOIN vat_rates v ON v.id = a.vat_rate_id WHERE a.id = ?')
        .get(l.articleId) as { id: string; name: string; purchase_price: number; rate_bp: number; is_service: number } | undefined;
      if (!a) throw new AppError('Article introuvable', 'NOT_FOUND');
      if (a.is_service) throw new AppError(`${a.name} est un service : il ne se rend pas`, 'INVALID');
      const unitCost = l.unitCost ?? a.purchase_price;
      if (!Number.isSafeInteger(unitCost) || unitCost < 0) throw new AppError(`Prix d'achat invalide : ${a.name}`, 'INVALID');
      const stocked = (this.db.prepare('SELECT qty FROM stock WHERE article_id = ? AND warehouse_id = ?').pluck().get(a.id, input.warehouseId) as number | undefined) ?? 0;
      if (stocked < l.qty) throw new AppError(`Stock insuffisant dans ce dépôt pour rendre ${a.name}`, 'OUT_OF_STOCK');
      return { ...l, name: a.name, unitCost, rate: vat ? a.rate_bp : 0 };
    });
    const totals = taxTotals(priced.map((l) => ({ ht: lineAmount(l.unitCost, l.qty), rate: l.rate })));
    return this.tx(() => {
      const id = newId();
      const now = this.now();
      const number = `RF-${this.stationPrefix()}-${String(this.nextCounter('supplier_return.number')).padStart(5, '0')}`;
      this.db
        .prepare(
          `INSERT INTO supplier_returns (id, number, store_id, warehouse_id, supplier_id, reason, status, total_ht, total_tva, user_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?)`,
        )
        .run(id, number, ctx.storeId, input.warehouseId, supplier.id, reason, totals.total_ht, totals.total_tva, ctx.userId, now, now);
      const insert = this.db.prepare(
        `INSERT INTO supplier_return_lines (id, return_id, line_no, article_id, qty, unit_cost, vat_rate_bp, lot_number, expiry)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const lotOf = this.db.prepare('SELECT lot_number, expiry FROM lots WHERE id = ?');
      priced.forEach((l, i) => {
        const out = this.stock.issue(ctx, {
          type: 'SUPPLIER_RETURN',
          articleId: l.articleId,
          warehouseId: input.warehouseId,
          qty: l.qty,
          lotId: l.lotId ?? null,
          reason: `Retour ${supplier.name} : ${reason}`,
          refType: 'supplier_return',
          refId: id,
        });
        // Le lot rendu (n° et date limite) figure sur le bon, utile pour les périmés.
        const lot = out.lots.length === 1 && out.lots[0]!.lotId ? (lotOf.get(out.lots[0]!.lotId) as { lot_number: string | null; expiry: string | null } | undefined) : undefined;
        insert.run(newId(), id, i + 1, l.articleId, l.qty, l.unitCost, l.rate, lot?.lot_number ?? null, lot?.expiry ?? null);
      });
      this.enqueue(ctx, 'supplier_return', id, 'upsert', {});
      this.audit(ctx.userId, 'supplier_return.create', 'supplier_return', id, { supplier: supplier.name, ht: totals.total_ht, reason });
      return this.get(id);
    });
  }

  /**
   * Avoir reçu du fournisseur pour ce retour : il est enregistré (au montant du
   * bon, ou à celui que le fournisseur accorde) et vient en déduction de sa dette.
   */
  credit(ctx: Context, id: string, input: { supplierNumber: string; invoiceDate: string; totalHt?: Fcfa | null; totalTva?: Fcfa | null }): SupplierReturn {
    const r = this.get(id);
    if (r.store_id !== ctx.storeId) throw new AppError("Ce retour est d'un autre magasin", 'FORBIDDEN');
    if (r.status === 'credited') throw new AppError(`L'avoir de ce retour est déjà saisi (${r.credit_note_number ?? ''})`, 'INVALID');
    return this.tx(() => {
      const note: SupplierInvoice = this.purchases.createInvoice(ctx, {
        supplierId: r.supplier_id,
        kind: 'credit_note',
        supplierNumber: input.supplierNumber,
        invoiceDate: input.invoiceDate,
        totalHt: input.totalHt ?? r.total_ht,
        totalTva: input.totalTva ?? r.total_tva,
        notes: `Retour ${r.number} : ${r.reason}`,
      });
      this.db.prepare("UPDATE supplier_returns SET status = 'credited', credit_note_id = ?, updated_at = ? WHERE id = ?").run(note.id, this.now(), id);
      this.enqueue(ctx, 'supplier_return', id, 'upsert', {});
      this.audit(ctx.userId, 'supplier_return.credit', 'supplier_return', id, { creditNote: note.number, ttc: note.total_ttc });
      return this.get(id);
    });
  }

  get(id: string): SupplierReturn {
    const head = this.query('r.id = @id', 1).get({ id }) as Omit<SupplierReturn, 'lines'> | undefined;
    if (!head) throw new AppError('Bon de retour introuvable', 'NOT_FOUND');
    const lines = (
      this.db
        .prepare(
          `SELECT l.id, l.line_no, l.article_id, a.code, a.name, a.unit, l.qty, l.unit_cost, l.vat_rate_bp, l.lot_number, l.expiry
           FROM supplier_return_lines l JOIN articles a ON a.id = l.article_id WHERE l.return_id = ? ORDER BY l.line_no`,
        )
        .all(id) as Omit<SupplierReturn['lines'][number], 'total_ht'>[]
    ).map((l) => ({ ...l, total_ht: lineAmount(l.unit_cost, l.qty) }));
    return { ...head, lines };
  }

  list(storeId: string, opts: { supplierId?: string | null; open?: boolean } = {}): Omit<SupplierReturn, 'lines'>[] {
    return this.query(
      `r.store_id = @storeId AND (@supplierId IS NULL OR r.supplier_id = @supplierId) AND (@open = 0 OR r.status = 'open')`,
      500,
    ).all({ storeId, supplierId: opts.supplierId ?? null, open: opts.open ? 1 : 0 }) as Omit<SupplierReturn, 'lines'>[];
  }

  /** Avoirs attendus par fournisseur : ce que chacun doit encore pour la marchandise rendue. */
  pending(storeId: string): { supplier_id: string; supplier_name: string; count: number; total_ttc: Fcfa }[] {
    return this.db
      .prepare(
        `SELECT r.supplier_id, s.name AS supplier_name, COUNT(*) AS count, SUM(r.total_ht + r.total_tva) AS total_ttc
         FROM supplier_returns r JOIN suppliers s ON s.id = r.supplier_id
         WHERE r.store_id = ? AND r.status = 'open' GROUP BY r.supplier_id ORDER BY total_ttc DESC`,
      )
      .all(storeId) as { supplier_id: string; supplier_name: string; count: number; total_ttc: Fcfa }[];
  }

  private query(where: string, limit: number) {
    return this.db.prepare(
      `SELECT r.id, r.number, r.store_id, r.warehouse_id, w.name AS warehouse_name, r.supplier_id, s.name AS supplier_name, r.reason, r.status,
              r.total_ht, r.total_tva, r.total_ht + r.total_tva AS total_ttc, r.credit_note_id, i.number AS credit_note_number,
              i.total_ttc AS credit_note_ttc, u.name AS user_name, r.created_at
       FROM supplier_returns r JOIN suppliers s ON s.id = r.supplier_id JOIN warehouses w ON w.id = r.warehouse_id
       LEFT JOIN supplier_invoices i ON i.id = r.credit_note_id LEFT JOIN users u ON u.id = r.user_id
       WHERE ${where} ORDER BY r.created_at DESC LIMIT ${limit}`,
    );
  }
}
