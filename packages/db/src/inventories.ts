import type { Fcfa, Milli } from '@superette/core';
import type { StockService } from './stock';
import type { Db } from './database';
import { AppError, Base, type Clock, type Context, newId } from './util';

export type InventoryKind = 'global' | 'partial';
export type InventoryStatus = 'open' | 'closed' | 'cancelled';

export interface Inventory {
  id: string;
  number: number;
  store_id: string;
  warehouse_id: string;
  warehouse_name: string;
  kind: InventoryKind;
  status: InventoryStatus;
  label: string | null;
  department_ids: string | null;
  /** Rayons inventoriés (noms), vide pour un inventaire global ou par produits. */
  departments: string[];
  inventory_date: string;
  backdated: number;
  opened_at: string;
  opened_by_name: string;
  closed_at: string | null;
  closed_by_name: string | null;
  cancelled_at: string | null;
  line_count: number;
  counted_count: number;
  /** Valeur du stock compté et montant des écarts : figés à la clôture, provisoires avant. */
  counted_value: Fcfa;
  gap_value: Fcfa;
}

export interface InventoryLine {
  article_id: string;
  code: string;
  name: string;
  unit: 'piece' | 'kg' | 'litre';
  unit_name: string | null;
  department_name: string | null;
  barcodes: string[];
  packs: { name: string; units: Milli }[];
  /** Stock à l'ouverture de l'inventaire (ou à la date d'inventaire). */
  opening_qty: Milli;
  /** Mouvements depuis l'ouverture (ventes, réceptions…), hors corrections de cet inventaire. */
  period_qty: Milli;
  /** Stock attendu : à l'heure du comptage pour une ligne comptée, maintenant sinon. */
  expected: Milli;
  counted: Milli | null;
  counted_detail: number[] | null;
  counted_at: string | null;
  counted_by_name: string | null;
  difference: Milli | null;
  unit_cost: Fcfa;
  gap_value: Fcfa | null;
  counted_value: Fcfa | null;
}

export interface InventoryInput {
  warehouseId: string;
  kind: InventoryKind;
  /** Inventaire partiel : rayons à compter (sinon on ajoute les produits un par un). */
  departmentIds?: string[];
  articleIds?: string[];
  /** Date d'inventaire (AAAA-MM-JJ) ; une date passée arrête le stock à la fin de ce jour-là. */
  date?: string | null;
  label?: string | null;
}

const value = (qty: Milli, cost: Fcfa) => Math.round((qty * cost) / 1000);

/**
 * Inventaires enregistrés, comme dans KONTROL : à l'ouverture la liste des
 * produits s'affiche avec leur stock, on saisit les quantités comptées (le
 * magasin reste ouvert : chaque comptage est horodaté), puis la clôture
 * corrige le stock et passe l'écart en variation de stock.
 */
export class InventoryService extends Base {
  constructor(
    db: Db,
    clock: Clock,
    private readonly stock: StockService,
  ) {
    super(db, clock);
  }

  /** Fin du jour d'inventaire, à l'heure locale du poste, pour un inventaire antidaté. */
  private cutoff(inv: { inventory_date: string; backdated: number }): string | null {
    return inv.backdated ? new Date(`${inv.inventory_date}T23:59:59.999`).toISOString() : null;
  }

  /** Stock d'un article dans le dépôt, et coût moyen. */
  private stockOf(articleId: string, warehouseId: string): { qty: Milli; avg_cost: Fcfa } {
    const row = this.db.prepare('SELECT qty, avg_cost FROM stock WHERE article_id = ? AND warehouse_id = ?').get(articleId, warehouseId) as
      | { qty: number; avg_cost: number }
      | undefined;
    const fallback = this.db.prepare('SELECT purchase_price FROM articles WHERE id = ?').pluck().get(articleId) as number | undefined;
    return { qty: row?.qty ?? 0, avg_cost: row?.avg_cost || fallback || 0 };
  }

  /** Mouvements d'un article passés après `since`, hors corrections de cet inventaire. */
  private movedSince(articleId: string, warehouseId: string, since: string, inventoryId: string): Milli {
    return this.db
      .prepare(
        `SELECT COALESCE(SUM(qty), 0) FROM stock_movements WHERE article_id = ? AND warehouse_id = ? AND at > ?
           AND NOT (ref_type = 'inventory' AND ref_id = ?)`,
      )
      .pluck()
      .get(articleId, warehouseId, since, inventoryId) as number;
  }

  private header(id: string): Inventory {
    const inv = this.list(null, id)[0];
    if (!inv) throw new AppError('Inventaire introuvable', 'NOT_FOUND');
    return inv;
  }

  private requireOpen(id: string): Inventory {
    const inv = this.header(id);
    if (inv.status !== 'open') throw new AppError(inv.status === 'closed' ? 'Cet inventaire est clôturé' : 'Cet inventaire est annulé', 'INVALID');
    return inv;
  }

  /** Inventaires du magasin, du plus récent au plus ancien. */
  list(storeId: string | null, id?: string): Inventory[] {
    const rows = this.db
      .prepare(
        `SELECT i.*, w.name AS warehouse_name, o.name AS opened_by_name, c.name AS closed_by_name,
                (SELECT COUNT(*) FROM inventory_lines l WHERE l.inventory_id = i.id) AS line_count,
                (SELECT COUNT(*) FROM inventory_lines l WHERE l.inventory_id = i.id AND l.counted IS NOT NULL) AS counted_count
         FROM inventories i JOIN warehouses w ON w.id = i.warehouse_id JOIN users o ON o.id = i.opened_by LEFT JOIN users c ON c.id = i.closed_by
         WHERE (@storeId IS NULL OR i.store_id = @storeId) AND (@id IS NULL OR i.id = @id)
         ORDER BY i.number DESC`,
      )
      .all({ storeId, id: id ?? null }) as (Omit<Inventory, 'departments'> & { counted_value: number | null; gap_value: number | null })[];
    const names = new Map((this.db.prepare('SELECT id, name FROM departments').all() as { id: string; name: string }[]).map((d) => [d.id, d.name]));
    return rows.map((r) => {
      let counted = r.counted_value;
      let gap = r.gap_value;
      // Inventaire en cours : valeurs provisoires calculées sur les lignes comptées.
      if (r.status === 'open') {
        const lines = this.lines(r.id);
        counted = lines.reduce((t, l) => t + (l.counted_value ?? 0), 0);
        gap = lines.reduce((t, l) => t + (l.gap_value ?? 0), 0);
      }
      return {
        ...r,
        counted_value: counted ?? 0,
        gap_value: gap ?? 0,
        departments: (JSON.parse(r.department_ids ?? '[]') as string[]).map((d) => names.get(d) ?? '').filter(Boolean),
      };
    });
  }

  /** Ouvre un inventaire : la liste des produits et leur stock sont figés. */
  create(ctx: Context, input: InventoryInput): Inventory {
    const wh = this.db.prepare('SELECT id, store_id FROM warehouses WHERE id = ?').get(input.warehouseId) as { id: string; store_id: string } | undefined;
    if (!wh || wh.store_id !== ctx.storeId) throw new AppError('Choisissez le dépôt à inventorier', 'INVALID');
    const date = input.date || this.today();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new AppError("Date d'inventaire invalide", 'INVALID');
    if (date > this.today()) throw new AppError("La date d'inventaire ne peut pas être dans le futur", 'INVALID');
    const backdated = date < this.today() ? 1 : 0;
    const departmentIds = input.kind === 'partial' ? (input.departmentIds ?? []) : [];
    let articleIds: string[];
    if (input.kind === 'global') {
      articleIds = this.db.prepare('SELECT id FROM articles WHERE active = 1').pluck().all() as string[];
    } else {
      const byDept = departmentIds.length
        ? (this.db
            .prepare(
              `SELECT a.id FROM articles a JOIN families f ON f.id = a.family_id
               WHERE a.active = 1 AND f.department_id IN (${departmentIds.map(() => '?').join(',')})`,
            )
            .pluck()
            .all(...departmentIds) as string[])
        : [];
      articleIds = [...new Set([...byDept, ...(input.articleIds ?? [])])];
    }
    return this.tx(() => {
      const id = newId();
      const last = this.db.prepare('SELECT MAX(number) FROM inventories WHERE store_id = ?').pluck().get(ctx.storeId) as number | null;
      if (last) this.raiseCounter(`inventory:${ctx.storeId}`, last);
      const number = this.nextCounter(`inventory:${ctx.storeId}`);
      const now = this.now();
      this.db
        .prepare(
          `INSERT INTO inventories (id, number, store_id, warehouse_id, kind, status, label, department_ids, inventory_date, backdated, opened_at, opened_by)
           VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, number, ctx.storeId, wh.id, input.kind, input.label?.trim() || null, JSON.stringify(departmentIds), date, backdated, now, ctx.userId);
      const cutoff = this.cutoff({ inventory_date: date, backdated });
      for (const articleId of articleIds) this.insertLine(id, wh.id, articleId, cutoff);
      this.audit(ctx.userId, 'inventory.open', 'inventory', id, { number, kind: input.kind, date, lines: articleIds.length });
      return this.header(id);
    });
  }

  private insertLine(inventoryId: string, warehouseId: string, articleId: string, cutoff: string | null): void {
    const qty = this.stockOf(articleId, warehouseId).qty - (cutoff ? this.movedSince(articleId, warehouseId, cutoff, inventoryId) : 0);
    this.db
      .prepare('INSERT OR IGNORE INTO inventory_lines (id, inventory_id, article_id, opening_qty) VALUES (?, ?, ?, ?)')
      .run(newId(), inventoryId, articleId, qty);
  }

  /** Lignes de l'inventaire avec stock attendu, écart et valeurs. */
  lines(id: string): InventoryLine[] {
    const inv = this.db.prepare('SELECT * FROM inventories WHERE id = ?').get(id) as
      | { id: string; warehouse_id: string; status: InventoryStatus; opened_at: string; inventory_date: string; backdated: number }
      | undefined;
    if (!inv) throw new AppError('Inventaire introuvable', 'NOT_FOUND');
    const rows = this.db
      .prepare(
        `SELECT l.*, a.code, a.name, a.unit, a.unit_name, d.name AS department_name, u.name AS counted_by_name
         FROM inventory_lines l JOIN articles a ON a.id = l.article_id
         LEFT JOIN families f ON f.id = a.family_id LEFT JOIN departments d ON d.id = f.department_id
         LEFT JOIN users u ON u.id = l.counted_by
         WHERE l.inventory_id = ? ORDER BY COALESCE(d.name, '~'), a.name`,
      )
      .all(id) as {
      article_id: string;
      code: string;
      name: string;
      unit: 'piece' | 'kg' | 'litre';
      unit_name: string | null;
      department_name: string | null;
      counted_by_name: string | null;
      opening_qty: number;
      counted: number | null;
      counted_detail: string | null;
      counted_at: string | null;
      expected: number | null;
      difference: number | null;
      unit_cost: number | null;
    }[];
    const packs = this.db.prepare('SELECT name, units FROM article_packs WHERE article_id = ? ORDER BY position');
    const barcodes = this.db.prepare('SELECT code FROM barcodes WHERE article_id = ?').pluck();
    const packCodes = this.db.prepare('SELECT barcode FROM article_packs WHERE article_id = ? AND barcode IS NOT NULL').pluck();
    const cutoff = this.cutoff(inv);
    const start = cutoff ?? inv.opened_at;
    return rows.map((r) => {
      const st = this.stockOf(r.article_id, inv.warehouse_id);
      const closed = inv.status === 'closed' && r.expected !== null;
      const period = cutoff ? 0 : this.movedSince(r.article_id, inv.warehouse_id, start, id);
      const reference = cutoff ?? r.counted_at;
      const expected = closed ? r.expected! : reference ? st.qty - this.movedSince(r.article_id, inv.warehouse_id, reference, id) : r.opening_qty + period;
      const cost = closed ? (r.unit_cost ?? 0) : st.avg_cost;
      const difference = closed ? r.difference : r.counted === null ? null : r.counted - expected;
      return {
        article_id: r.article_id,
        code: r.code,
        name: r.name,
        unit: r.unit,
        unit_name: r.unit_name,
        department_name: r.department_name,
        barcodes: [...(barcodes.all(r.article_id) as string[]), ...(packCodes.all(r.article_id) as string[])],
        packs: r.unit === 'piece' ? (packs.all(r.article_id) as { name: string; units: number }[]) : [],
        opening_qty: r.opening_qty,
        period_qty: period,
        expected,
        counted: r.counted,
        counted_detail: r.counted_detail ? (JSON.parse(r.counted_detail) as number[]) : null,
        counted_at: r.counted_at,
        counted_by_name: r.counted_by_name,
        difference,
        unit_cost: cost,
        gap_value: difference === null ? null : value(difference, cost),
        counted_value: r.counted === null ? null : value(r.counted, cost),
      };
    });
  }

  get(id: string): { inventory: Inventory; lines: InventoryLine[] } {
    return { inventory: this.header(id), lines: this.lines(id) };
  }

  /** Ajoute un produit à un inventaire partiel (ou un produit oublié). */
  addArticle(ctx: Context, id: string, articleId: string): void {
    const inv = this.requireOpen(id);
    const exists = this.db.prepare('SELECT 1 FROM inventory_lines WHERE inventory_id = ? AND article_id = ?').get(id, articleId);
    if (exists) throw new AppError('Ce produit est déjà dans l’inventaire', 'INVALID');
    this.insertLine(id, inv.warehouse_id, articleId, this.cutoff(inv));
    this.audit(ctx.userId, 'inventory.add', 'inventory', id, { articleId });
  }

  /** Retire un produit pas encore compté. */
  removeArticle(ctx: Context, id: string, articleId: string): void {
    this.requireOpen(id);
    const r = this.db.prepare('DELETE FROM inventory_lines WHERE inventory_id = ? AND article_id = ? AND counted IS NULL').run(id, articleId);
    if (!r.changes) throw new AppError('Seul un produit pas encore compté peut être retiré', 'INVALID');
    this.audit(ctx.userId, 'inventory.remove', 'inventory', id, { articleId });
  }

  /**
   * Saisit (ou efface, avec null) la quantité comptée d'un produit. L'heure
   * du comptage est gardée : les ventes faites ensuite ne faussent pas l'écart.
   */
  setCount(ctx: Context, id: string, articleId: string, counted: Milli | null, detail?: number[] | null): void {
    this.requireOpen(id);
    if (counted !== null && (!Number.isSafeInteger(counted) || counted < 0)) throw new AppError('Quantité comptée invalide', 'INVALID');
    this.tx(() => {
      const now = this.now();
      const r = this.db
        .prepare('UPDATE inventory_lines SET counted = ?, counted_detail = ?, counted_at = ?, counted_by = ? WHERE inventory_id = ? AND article_id = ?')
        .run(counted, counted === null || !detail ? null : JSON.stringify(detail), counted === null ? null : now, counted === null ? null : ctx.userId, id, articleId);
      if (!r.changes) throw new AppError('Ce produit n’est pas dans l’inventaire', 'NOT_FOUND');
      this.db.prepare('INSERT INTO inventory_entries (id, inventory_id, article_id, user_id, counted, at) VALUES (?, ?, ?, ?, ?, ?)').run(newId(), id, articleId, ctx.userId, counted, now);
    });
  }

  /**
   * Import d'un fichier de comptage : une ligne par produit, code (ou code-barres)
   * et quantité comptée en unités de détail. Renvoie les codes inconnus.
   */
  importCounts(ctx: Context, id: string, rows: { code: string; qty: number }[]): { imported: number; unknown: string[] } {
    this.requireOpen(id);
    const inLines = new Set(this.db.prepare('SELECT article_id FROM inventory_lines WHERE inventory_id = ?').pluck().all(id) as string[]);
    const find = this.db.prepare(
      `SELECT id FROM articles WHERE code = @c
       UNION SELECT article_id FROM barcodes WHERE code = @c
       UNION SELECT article_id FROM article_packs WHERE barcode = @c LIMIT 1`,
    );
    const unknown: string[] = [];
    let imported = 0;
    this.tx(() => {
      for (const row of rows) {
        const code = row.code.trim();
        if (!code) continue;
        const articleId = (find.pluck().get({ c: code }) as string | undefined) ?? null;
        if (!articleId || !Number.isFinite(row.qty) || row.qty < 0) {
          unknown.push(code);
          continue;
        }
        if (!inLines.has(articleId)) {
          this.addArticle(ctx, id, articleId);
          inLines.add(articleId);
        }
        this.setCount(ctx, id, articleId, Math.round(row.qty * 1000));
        imported++;
      }
      this.audit(ctx.userId, 'inventory.import', 'inventory', id, { imported, unknown: unknown.length });
    });
    return { imported, unknown };
  }

  /** Historique des saisies : par personne et par minute, comme dans KONTROL. */
  history(id: string): { user_name: string; count: number; at: string }[] {
    return this.db
      .prepare(
        `SELECT u.name AS user_name, COUNT(*) AS count, MAX(e.at) AS at FROM inventory_entries e JOIN users u ON u.id = e.user_id
         WHERE e.inventory_id = ? GROUP BY e.user_id, substr(e.at, 1, 16) ORDER BY at`,
      )
      .all(id) as { user_name: string; count: number; at: string }[];
  }

  /**
   * Clôture : chaque écart corrige le stock (mouvement « Inventaire n° X »).
   * Inventaire global : les produits non comptés passent à zéro. Inventaire
   * partiel : ils ne changent pas.
   */
  close(ctx: Context, id: string): Inventory {
    const inv = this.requireOpen(id);
    const cutoff = this.cutoff(inv);
    return this.tx(() => {
      const now = this.now();
      const at = cutoff ?? undefined;
      if (inv.kind === 'global') {
        this.db
          .prepare('UPDATE inventory_lines SET counted = 0, counted_at = ?, counted_by = ? WHERE inventory_id = ? AND counted IS NULL')
          .run(cutoff ?? now, ctx.userId, id);
      }
      const lines = this.lines(id).filter((l) => l.counted !== null);
      let countedValue = 0;
      let gapValue = 0;
      const save = this.db.prepare('UPDATE inventory_lines SET expected = ?, difference = ?, unit_cost = ? WHERE inventory_id = ? AND article_id = ?');
      for (const l of lines) {
        const difference = l.counted! - l.expected;
        this.stock.adjustForInventory(ctx, { articleId: l.article_id, warehouseId: inv.warehouse_id, difference, inventoryId: id, reason: `Inventaire n° ${inv.number}`, at });
        save.run(l.expected, difference, l.unit_cost, id, l.article_id);
        countedValue += value(l.counted!, l.unit_cost);
        gapValue += value(difference, l.unit_cost);
      }
      this.db
        .prepare("UPDATE inventories SET status = 'closed', closed_at = ?, closed_by = ?, counted_value = ?, gap_value = ? WHERE id = ?")
        .run(now, ctx.userId, countedValue, gapValue, id);
      this.audit(ctx.userId, 'inventory.close', 'inventory', id, { number: inv.number, lines: lines.length, countedValue, gapValue });
      return this.header(id);
    });
  }

  /** Abandon d'un inventaire en cours : le stock ne bouge pas. */
  cancel(ctx: Context, id: string): Inventory {
    const inv = this.requireOpen(id);
    this.db.prepare("UPDATE inventories SET status = 'cancelled', cancelled_at = ?, cancelled_by = ? WHERE id = ?").run(this.now(), ctx.userId, id);
    this.audit(ctx.userId, 'inventory.cancel', 'inventory', id, { number: inv.number });
    return this.header(id);
  }
}
