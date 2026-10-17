import {
  type Fcfa,
  type TakeoverCustomer,
  type TakeoverKind,
  type TakeoverStock,
  type TakeoverSupplier,
  dueDate,
  formatFcfa,
  parseTakeoverCustomers,
  parseTakeoverStock,
  parseTakeoverSuppliers,
} from '@superette/core';
import type { CatalogueService } from './catalogue';
import type { CustomerService } from './customers';
import type { PurchaseService } from './purchases';
import type { StockService } from './stock';
import { AppError, Base, type Clock, type Context, newId } from './util';
import type { Db } from './database';

/** Contrepartie d'attente des soldes repris, soldée ensuite par les à-nouveaux saisis (capital, banque…). */
export const OPENING_ACCOUNT = '4711';

/** Une ligne du fichier, telle qu'elle sera (ou a été) reprise. */
export interface TakeoverLine {
  line: number;
  label: string;
  /** Ce que la ligne fait : fiche créée ou complétée, solde repris, quantité entrée. */
  action: string;
  amount: Fcfa;
}

export interface TakeoverResult {
  kind: TakeoverKind;
  /** Aperçu : rien n'est enregistré. */
  preview: boolean;
  lines: TakeoverLine[];
  errors: { line: number; message: string }[];
  created: number;
  updated: number;
  /** Total des soldes ou de la valeur du stock repris. */
  total: Fcfa;
}

/** Ce qui a déjà été repris dans ce magasin, pour le gérant et le comptable. */
export interface TakeoverSummary {
  customers: { count: number; total: Fcfa; date: string | null };
  suppliers: { count: number; total: Fcfa; date: string | null };
  stock: { count: number; total: Fcfa; date: string | null };
}

/** Annule la transaction d'un aperçu : tout ce qui a été fait pour le calculer disparaît. */
class PreviewRollback extends Error {}

const lower = (s: string) => s.trim().toLocaleLowerCase('fr').replace(/\s+/g, ' ');
const digits = (s: string | null) => (s ?? '').replace(/\D/g, '').replace(/^237(?=\d{9}$)/, '');

/**
 * Reprise d'un magasin qui passe à FEDONIX 360 : fiches clients et fournisseurs
 * avec ce qu'ils doivent, stock de départ par dépôt. Chaque fichier se vérifie
 * d'abord en aperçu (rien n'est enregistré), puis s'importe d'un bloc.
 *
 * Les soldes clients deviennent des pièces « solde repris » lettrées comme des
 * ventes à crédit ; les dettes fournisseurs, des factures marquées reprises ;
 * le stock, une réception de reprise au coût indiqué. Rien de tout cela n'est
 * un achat ni une vente : la comptabilité les passe en à-nouveaux (journal AN)
 * contre le compte d'attente 4711.
 */
export class OpeningService extends Base {
  constructor(
    db: Db,
    clock: Clock,
    private readonly catalogue: CatalogueService,
    private readonly customers: CustomerService,
    private readonly purchases: PurchaseService,
    private readonly stock: StockService,
  ) {
    super(db, clock);
  }

  /** Lit le fichier (cellules texte) et le reprend, ou montre ce qu'il ferait si `preview`. */
  run(ctx: Context, kind: TakeoverKind, cells: string[][], opts: { preview: boolean; warehouseId?: string | null }): TakeoverResult {
    const result: TakeoverResult = { kind, preview: opts.preview, lines: [], errors: [], created: 0, updated: 0, total: 0 };
    const parsed = kind === 'customers' ? parseTakeoverCustomers(cells) : kind === 'suppliers' ? parseTakeoverSuppliers(cells) : parseTakeoverStock(cells);
    result.errors.push(...parsed.errors);
    if (kind === 'stock' && !opts.warehouseId) throw new AppError('Choisissez le dépôt où entre ce stock', 'INVALID');
    try {
      this.tx(() => {
        if (kind === 'customers') this.importCustomers(ctx, parsed.rows as TakeoverCustomer[], result);
        else if (kind === 'suppliers') this.importSuppliers(ctx, parsed.rows as TakeoverSupplier[], result);
        else this.importStock(ctx, opts.warehouseId!, parsed.rows as TakeoverStock[], result);
        // Une seule erreur bloque tout l'import : le fichier corrigé se reprend en entier, sans doublon.
        if (opts.preview || result.errors.length) throw new PreviewRollback();
        this.audit(ctx.userId, `takeover.${kind}`, 'store', ctx.storeId, { lines: result.lines.length, total: result.total });
      });
    } catch (e) {
      if (!(e instanceof PreviewRollback)) throw e;
      if (!opts.preview) result.preview = true;
    }
    result.errors.sort((a, b) => a.line - b.line);
    return result;
  }

  private attempt(result: TakeoverResult, line: number, fn: () => void): void {
    // Chaque ligne dans son point de reprise : une ligne refusée n'en laisse rien.
    const savepoint = `takeover_${line}`;
    this.db.exec(`SAVEPOINT ${savepoint}`);
    try {
      fn();
      this.db.exec(`RELEASE ${savepoint}`);
    } catch (e) {
      this.db.exec(`ROLLBACK TO ${savepoint}`);
      this.db.exec(`RELEASE ${savepoint}`);
      result.errors.push({ line, message: e instanceof Error ? e.message : String(e) });
    }
  }

  private checkDate(storeId: string, date: string, what: string): void {
    if (date > this.today()) throw new AppError(`${what} est dans le futur`, 'INVALID');
    this.assertPeriodOpen(storeId, date);
  }

  // --- Clients ----------------------------------------------------------------

  private importCustomers(ctx: Context, rows: TakeoverCustomer[], result: TakeoverResult): void {
    const existing = this.db.prepare('SELECT id, name, phone FROM customers').all() as { id: string; name: string; phone: string | null }[];
    const seen = new Set<string>();
    const insert = this.db.prepare(
      `INSERT INTO opening_balances (id, number, store_id, customer_id, amount, doc_ref, doc_date, due_date, user_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const row of rows) {
      this.attempt(result, row.line, () => {
        const key = lower(row.name);
        if (seen.has(key)) throw new AppError(`${row.name} : ce client figure deux fois dans le fichier`, 'INVALID');
        seen.add(key);
        // Même client : même nom, ou même numéro de téléphone.
        const match = existing.find((c) => lower(c.name) === key || (digits(row.phone).length >= 8 && digits(c.phone) === digits(row.phone)));
        const before = match ? this.customers.getCustomer(match.id) : null;
        const customer = this.customers.saveCustomer(
          ctx.userId,
          {
            name: before?.name ?? row.name,
            phone: row.phone ?? before?.phone,
            address: row.address ?? before?.address,
            taxpayerNumber: row.taxpayerNumber ?? before?.taxpayer_number,
            email: before?.email,
            contact: before?.contact,
            notes: before?.notes,
            creditLimit: row.creditLimit ?? before?.credit_limit ?? 0,
            paymentTermsDays: row.paymentTermsDays ?? before?.payment_terms_days ?? 30,
            priceLevel: row.priceLevel ?? before?.price_level,
          },
          match?.id,
        );
        if (!match) existing.push({ id: customer.id, name: customer.name, phone: customer.phone });
        let action = match ? 'Fiche complétée' : 'Fiche créée';
        if (row.balance !== 0) {
          if (this.db.prepare('SELECT 1 FROM opening_balances WHERE store_id = ? AND customer_id = ?').get(ctx.storeId, customer.id)) {
            throw new AppError(`${row.name} : son solde a déjà été repris`, 'DUPLICATE');
          }
          const docDate = row.docDate ?? this.today();
          this.checkDate(ctx.storeId, docDate, `${row.name} : la date de la pièce`);
          const due = row.dueDate ?? dueDate(docDate, customer.payment_terms_days);
          const id = newId();
          insert.run(id, this.number('RO'), ctx.storeId, customer.id, row.balance, row.docRef, docDate, due, ctx.userId, this.now());
          this.enqueue(ctx, 'opening_balance', id, 'upsert', {});
          action += row.balance > 0 ? `, doit ${formatFcfa(row.balance)}` : `, avoir de ${formatFcfa(-row.balance)}`;
          result.total += row.balance;
        }
        if (match) result.updated++;
        else result.created++;
        result.lines.push({ line: row.line, label: customer.name, action, amount: row.balance });
      });
    }
  }

  // --- Fournisseurs -----------------------------------------------------------

  private importSuppliers(ctx: Context, rows: TakeoverSupplier[], result: TakeoverResult): void {
    const existing = this.db.prepare('SELECT id, name, phone FROM suppliers').all() as { id: string; name: string; phone: string | null }[];
    const seen = new Set<string>();
    for (const row of rows) {
      this.attempt(result, row.line, () => {
        const key = lower(row.name);
        if (seen.has(key)) throw new AppError(`${row.name} : ce fournisseur figure deux fois dans le fichier`, 'INVALID');
        seen.add(key);
        const match = existing.find((c) => lower(c.name) === key || (digits(row.phone).length >= 8 && digits(c.phone) === digits(row.phone)));
        const before = match ? this.purchases.getSupplier(match.id) : null;
        const supplier = this.purchases.saveSupplier(
          ctx.userId,
          {
            name: before?.name ?? row.name,
            phone: row.phone ?? before?.phone,
            address: row.address ?? before?.address,
            taxpayerNumber: row.taxpayerNumber ?? before?.taxpayer_number,
            email: before?.email,
            contact: before?.contact,
            notes: before?.notes,
            franco: before?.franco ?? null,
            leadTimeDays: before?.lead_time_days,
            paymentTermsDays: row.paymentTermsDays ?? before?.payment_terms_days ?? 0,
          },
          match?.id,
        );
        if (!match) existing.push({ id: supplier.id, name: supplier.name, phone: supplier.phone });
        let action = match ? 'Fiche complétée' : 'Fiche créée';
        if (row.balance !== 0) {
          if (this.db.prepare('SELECT 1 FROM supplier_invoices WHERE store_id = ? AND supplier_id = ? AND opening = 1').get(ctx.storeId, supplier.id)) {
            throw new AppError(`${row.name} : la dette envers ce fournisseur a déjà été reprise`, 'DUPLICATE');
          }
          const docDate = row.docDate ?? this.today();
          this.checkDate(ctx.storeId, docDate, `${row.name} : la date de la facture`);
          const amount = Math.abs(row.balance);
          const invoice = this.purchases.createInvoice(ctx, {
            supplierId: supplier.id,
            kind: row.balance > 0 ? 'invoice' : 'credit_note',
            supplierNumber: row.docRef ?? 'Solde repris',
            invoiceDate: docDate,
            dueDate: row.dueDate ?? dueDate(docDate, supplier.payment_terms_days),
            totalHt: amount,
            totalTva: 0,
            notes: 'Solde repris à la mise en service de FEDONIX 360',
          });
          this.db.prepare('UPDATE supplier_invoices SET opening = 1 WHERE id = ?').run(invoice.id);
          action += row.balance > 0 ? `, on lui doit ${formatFcfa(amount)}` : `, avoir de ${formatFcfa(amount)}`;
          result.total += row.balance;
        }
        if (match) result.updated++;
        else result.created++;
        result.lines.push({ line: row.line, label: supplier.name, action, amount: row.balance });
      });
    }
  }

  // --- Stock de départ --------------------------------------------------------

  private findArticle(storeId: string, ref: string) {
    const hit = this.catalogue.scan(ref, storeId);
    if (hit) return { article: hit.article, units: hit.qty, pack: hit.pack ?? null };
    const id = this.db.prepare('SELECT id FROM articles WHERE active = 1 AND lower(trim(name)) = ?').pluck().all(lower(ref)) as string[];
    if (id.length > 1) throw new AppError(`${ref} : plusieurs articles portent ce nom, indiquez le code-barres ou le code`, 'INVALID');
    if (id.length === 1) return { article: this.catalogue.getArticle(id[0]!, storeId), units: 1000, pack: null };
    throw new AppError(`${ref} : article introuvable (importez d'abord le catalogue, Produit › Importer)`, 'NOT_FOUND');
  }

  private importStock(ctx: Context, warehouseId: string, rows: TakeoverStock[], result: TakeoverResult): void {
    const warehouse = this.db.prepare('SELECT id, name FROM warehouses WHERE id = ? AND store_id = ?').get(warehouseId, ctx.storeId) as { id: string; name: string } | undefined;
    if (!warehouse) throw new AppError("Ce dépôt n'appartient pas au magasin", 'INVALID');
    const lines: Parameters<StockService['receive']>[1]['lines'] = [];
    const seen = new Map<string, number>();
    for (const row of rows) {
      this.attempt(result, row.line, () => {
        const { article, units, pack } = this.findArticle(ctx.storeId, row.ref);
        const already = seen.get(article.id);
        if (already) throw new AppError(`${article.name} : déjà à la ligne ${already} du fichier`, 'INVALID');
        seen.set(article.id, row.line);
        const inStock = this.db.prepare('SELECT qty FROM stock WHERE article_id = ? AND warehouse_id = ?').pluck().get(article.id, warehouseId) as number | undefined;
        if (inStock) throw new AppError(`${article.name} : il y a déjà du stock dans « ${warehouse.name} », faites plutôt un inventaire`, 'DUPLICATE');
        // Pièces : quantité entière ; kilos et litres : au gramme près.
        const qty = Math.round(row.qty * units);
        if (qty <= 0) return;
        if (article.unit === 'piece' && qty % 1000 !== 0) throw new AppError(`${article.name} : quantité en pièces non entière (${row.qty})`, 'INVALID');
        const cost = row.unitCost ?? (pack ? (article.pack_cost_price ?? null) : article.purchase_price || null);
        if (cost === null || cost <= 0) throw new AppError(`${article.name} : indiquez son coût de revient (colonne « cout »)`, 'INVALID');
        if (article.perishable && !row.expiry) throw new AppError(`${article.name} : date de péremption obligatoire (article périssable)`, 'EXPIRY_REQUIRED');
        const value = pack ? Math.round((cost * qty) / pack.units) : Math.round((cost * qty) / 1000);
        lines.push({
          articleId: article.id,
          qty,
          unitCost: pack ? Math.round((cost * 1000) / pack.units) : cost,
          ...(pack ? { packCost: cost, packUnits: pack.units } : {}),
          lotNumber: row.lotNumber,
          expiry: row.expiry,
        });
        result.total += value;
        result.created++;
        const qtyText = (qty / 1000).toLocaleString('fr-FR', { maximumFractionDigits: 3 });
        result.lines.push({ line: row.line, label: article.name, action: `${qtyText} ${article.unit === 'piece' ? (article.unit_name ?? 'pièce').toLowerCase() : article.unit} à ${formatFcfa(pack ? Math.round((cost * 1000) / pack.units) : cost)}`, amount: value });
      });
    }
    if (lines.length && !result.errors.length) {
      const reception = this.stock.receive(ctx, { warehouseId, reference: 'Reprise du stock de départ', lines });
      this.db.prepare('UPDATE receptions SET opening = 1 WHERE id = ?').run(reception.id);
    }
  }

  // --- Suivi ------------------------------------------------------------------

  summary(storeId: string): TakeoverSummary {
    const customers = this.db
      .prepare('SELECT COUNT(*) AS count, COALESCE(SUM(amount), 0) AS total, MAX(substr(created_at, 1, 10)) AS date FROM opening_balances WHERE store_id = ?')
      .get(storeId) as TakeoverSummary['customers'];
    const suppliers = this.db
      .prepare(
        `SELECT COUNT(*) AS count, COALESCE(SUM(CASE kind WHEN 'invoice' THEN total_ttc ELSE -total_ttc END), 0) AS total, MAX(substr(created_at, 1, 10)) AS date
         FROM supplier_invoices WHERE store_id = ? AND opening = 1`,
      )
      .get(storeId) as TakeoverSummary['suppliers'];
    const stock = this.db
      .prepare(
        `SELECT COUNT(*) AS count, COALESCE(SUM(COALESCE(l.amount, ROUND(l.qty * l.unit_cost / 1000.0))), 0) AS total, MAX(substr(r.received_at, 1, 10)) AS date
         FROM reception_lines l JOIN receptions r ON r.id = l.reception_id WHERE r.store_id = ? AND r.opening = 1`,
      )
      .get(storeId) as TakeoverSummary['stock'];
    return { customers, suppliers, stock };
  }

  private number(prefix: string): string {
    return `${prefix}-${this.stationPrefix()}-${String(this.nextCounter('opening_balance')).padStart(5, '0')}`;
  }
}
