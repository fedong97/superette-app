import { type CartLine, type Fcfa, type Milli, computeTotals, lineAmount, lineTotal } from '@superette/core';
import type { AdminService } from './admin';
import type { CatalogueService, Unit } from './catalogue';
import { AppError, Base, type Context, newId } from './util';

export type QuoteKind = 'quote' | 'proforma';
export type QuoteState = 'open' | 'expired' | 'accepted' | 'cancelled';

export interface QuoteLine {
  id: string;
  line_no: number;
  article_id: string;
  label: string;
  unit: Unit;
  qty: Milli;
  unit_price: Fcfa;
  discount: Fcfa;
  vat_rate_bp: number;
  total_ttc: Fcfa;
}

export interface Quote {
  id: string;
  number: string;
  kind: QuoteKind;
  store_id: string;
  customer_id: string | null;
  customer_code: string | null;
  /** Nom de la fiche client, ou nom libre du prospect. */
  customer_name: string | null;
  quote_date: string;
  valid_until: string;
  status: 'open' | 'accepted' | 'cancelled';
  /** État affiché : un devis ouvert dont la date de validité est passée est « expiré ». */
  state: QuoteState;
  sale_id: string | null;
  sale_number: string | null;
  total_ttc: Fcfa;
  total_ht: Fcfa;
  total_tva: Fcfa;
  total_discount: Fcfa;
  notes: string | null;
  user_name: string | null;
  discount_authorized_by_name: string | null;
  created_at: string;
  lines: QuoteLine[];
}

export interface QuoteInput {
  kind: QuoteKind;
  customerId?: string | null;
  customerName?: string | null;
  /** Durée de validité en jours (15 par défaut). */
  validDays?: number;
  notes?: string | null;
  lines: { articleId: string; qty: Milli; discount?: Fcfa }[];
}

const KIND_PREFIX: Record<QuoteKind, string> = { quote: 'DV', proforma: 'PF' };

/**
 * Devis et factures proforma. Les prix du document sont garantis jusqu'à sa
 * date de validité : à la caisse, la vente reprend ces prix même si le tarif
 * a changé entre-temps.
 */
export class QuoteService extends Base {
  constructor(
    db: ConstructorParameters<typeof Base>[0],
    clock: ConstructorParameters<typeof Base>[1],
    private readonly admin: AdminService,
    private readonly catalogue: CatalogueService,
  ) {
    super(db, clock);
  }

  save(ctx: Context, input: QuoteInput, opts: { id?: string; discountAuthorizedBy?: string | null } = {}): Quote {
    if (input.kind !== 'quote' && input.kind !== 'proforma') throw new AppError('Type de document inconnu', 'INVALID');
    if (input.lines.length === 0) throw new AppError('Ajoutez au moins un article', 'EMPTY');
    const validDays = input.validDays ?? 15;
    if (!Number.isInteger(validDays) || validDays < 1 || validDays > 365) throw new AppError('Durée de validité invalide (1 à 365 jours)', 'INVALID');
    let customerName = input.customerName?.trim() || null;
    if (input.customerId) {
      const c = this.db.prepare('SELECT name FROM customers WHERE id = ?').pluck().get(input.customerId) as string | undefined;
      if (!c) throw new AppError('Client introuvable', 'NOT_FOUND');
      customerName = c;
    }
    if (!customerName) throw new AppError('Indiquez le client', 'CUSTOMER_REQUIRED');
    const vatEnabled = this.admin.getStore(ctx.storeId).vat_enabled === 1;
    const lines: (CartLine & { unit: string })[] = input.lines.map((l) => {
      if (!Number.isSafeInteger(l.qty) || l.qty <= 0) throw new AppError('Quantité invalide', 'INVALID');
      const discount = l.discount ?? 0;
      if (!Number.isSafeInteger(discount) || discount < 0) throw new AppError('Remise invalide', 'INVALID');
      const a = this.catalogue.getArticle(l.articleId, ctx.storeId);
      if (!a.active) throw new AppError(`Article inactif : ${a.name}`, 'INACTIVE');
      const line = { articleId: a.id, label: a.name, unitPrice: a.store_price, qty: l.qty, vatRate: vatEnabled ? a.vat_rate_bp : 0, discount, unit: a.unit };
      if (lineTotal(line) <= 0) throw new AppError(`Remise supérieure au prix : ${a.name}`, 'INVALID');
      return line;
    });
    const totals = computeTotals(lines);
    if (totals.totalDiscount > 0) {
      const ok = (id: string | null | undefined) => {
        if (!id) return false;
        const role = this.admin.getUser(id).role;
        return role === 'admin' || role === 'manager';
      };
      if (!ok(ctx.userId) && !ok(opts.discountAuthorizedBy)) throw new AppError('Remise soumise à validation du gérant', 'SUPERVISOR_REQUIRED');
    }
    if (opts.id) {
      const current = this.get(opts.id);
      if (current.status !== 'open') throw new AppError('Ce document est clôturé : il ne peut plus être modifié', 'INVALID');
    }
    return this.tx(() => {
      const id = opts.id ?? newId();
      const now = this.now();
      const date = this.today();
      const validUntil = addDays(date, validDays);
      const authorizedBy = totals.totalDiscount > 0 ? (opts.discountAuthorizedBy ?? ctx.userId) : null;
      const row = {
        id,
        customer: input.customerId ?? null,
        customerName,
        validUntil,
        ttc: totals.totalTtc,
        ht: totals.totalHt,
        tva: totals.totalTva,
        discount: totals.totalDiscount,
        notes: input.notes?.trim() || null,
        authorizedBy,
        now,
      };
      if (opts.id) {
        this.db
          .prepare(
            `UPDATE quotes SET customer_id = @customer, customer_name = @customerName, valid_until = @validUntil, total_ttc = @ttc, total_ht = @ht,
               total_tva = @tva, total_discount = @discount, notes = @notes, discount_authorized_by = @authorizedBy, updated_at = @now WHERE id = @id`,
          )
          .run(row);
        this.db.prepare('DELETE FROM quote_lines WHERE quote_id = ?').run(id);
      } else {
        const number = `${KIND_PREFIX[input.kind]}-${this.stationPrefix()}-${String(this.nextCounter(`quote:${input.kind}`)).padStart(5, '0')}`;
        this.db
          .prepare(
            `INSERT INTO quotes (id, number, kind, store_id, customer_id, customer_name, quote_date, valid_until, status, total_ttc, total_ht, total_tva,
               total_discount, notes, user_id, discount_authorized_by, created_at, updated_at)
             VALUES (@id, @number, @kind, @store, @customer, @customerName, @date, @validUntil, 'open', @ttc, @ht, @tva, @discount, @notes, @user,
               @authorizedBy, @now, @now)`,
          )
          .run({ ...row, number, kind: input.kind, store: ctx.storeId, date, user: ctx.userId });
      }
      const insert = this.db.prepare(
        `INSERT INTO quote_lines (id, quote_id, line_no, article_id, label, qty, unit_price, discount, vat_rate_bp, total_ttc)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      lines.forEach((l, i) => insert.run(newId(), id, i + 1, l.articleId, l.label, l.qty, l.unitPrice, l.discount, l.vatRate, lineTotal(l)));
      this.enqueue(ctx, 'quote', id, 'upsert', {});
      this.audit(ctx.userId, opts.id ? 'quote.update' : 'quote.create', 'quote', id, { total: totals.totalTtc, discount: totals.totalDiscount, authorizedBy });
      return this.get(id);
    });
  }

  cancel(ctx: Context, id: string): Quote {
    const q = this.get(id);
    if (q.status !== 'open') throw new AppError('Ce document est déjà clôturé', 'INVALID');
    this.tx(() => {
      this.db.prepare("UPDATE quotes SET status = 'cancelled', updated_at = ? WHERE id = ?").run(this.now(), id);
      this.enqueue(ctx, 'quote', id, 'upsert', {});
      this.audit(ctx.userId, 'quote.cancel', 'quote', id, { number: q.number });
    });
    return this.get(id);
  }

  get(id: string): Quote {
    const head = this.query('q.id = @id').get({ id, today: this.today() }) as Omit<Quote, 'lines'> | undefined;
    if (!head) throw new AppError('Devis introuvable', 'NOT_FOUND');
    const lines = this.db
      .prepare(
        `SELECT l.id, l.line_no, l.article_id, l.label, a.unit, l.qty, l.unit_price, l.discount, l.vat_rate_bp, l.total_ttc
         FROM quote_lines l JOIN articles a ON a.id = l.article_id WHERE l.quote_id = ? ORDER BY l.line_no`,
      )
      .all(id) as QuoteLine[];
    return { ...head, lines };
  }

  list(storeId: string, opts: { state?: QuoteState; customerId?: string; search?: string; limit?: number } = {}): Omit<Quote, 'lines'>[] {
    const search = opts.search?.trim() ? `%${opts.search.trim()}%` : null;
    return (
      this.query(
        `q.store_id = @storeId AND (@customer IS NULL OR q.customer_id = @customer)
         AND (@search IS NULL OR q.number LIKE @search OR q.customer_name LIKE @search)`,
        opts.limit ?? 300,
      ).all({ storeId, customer: opts.customerId ?? null, search, today: this.today() }) as Omit<Quote, 'lines'>[]
    ).filter((q) => !opts.state || q.state === opts.state);
  }

  /**
   * Remises dues au devis pour une vente : pour chaque ligne, ce qu'il faut
   * retirer au tarif du jour pour revenir au prix garanti (jamais négatif).
   * Sert à charger le devis à la caisse.
   */
  saleLines(storeId: string, id: string): { articleId: string; qty: Milli; discount: Fcfa }[] {
    const q = this.requireUsable(storeId, id);
    return q.lines.map((l) => {
      const a = this.catalogue.getArticle(l.article_id, storeId);
      const today = lineAmount(a.store_price, l.qty);
      return { articleId: l.article_id, qty: l.qty, discount: Math.max(0, today - l.total_ttc) };
    });
  }

  /**
   * Vérifie qu'une vente ne remise pas plus que ce que garantit le devis :
   * chaque ligne remisée doit rester au-dessus du prix du devis (au prorata de
   * la quantité). Retourne l'auteur des remises du devis, ou false si la
   * vente remise davantage que le devis.
   */
  authorizeSaleDiscounts(storeId: string, id: string, lines: readonly CartLine[]): { by: string | null } | false {
    const q = this.requireUsable(storeId, id);
    for (const l of lines.filter((x) => x.discount > 0)) {
      const ql = q.lines.filter((x) => x.article_id === l.articleId);
      const qty = ql.reduce((t, x) => t + x.qty, 0);
      const total = ql.reduce((t, x) => t + x.total_ttc, 0);
      if (!qty) return false;
      const floor = Math.ceil((total * Math.min(l.qty, qty)) / qty) + (l.qty > qty ? lineAmount(l.unitPrice, l.qty - qty) : 0);
      if (lineTotal(l) < floor) return false;
    }
    return { by: (this.db.prepare('SELECT COALESCE(discount_authorized_by, user_id) FROM quotes WHERE id = ?').pluck().get(id) as string | null) ?? null };
  }

  /** Appelé dans la transaction de la vente. */
  markAccepted(ctx: Context, id: string, saleId: string): void {
    this.db.prepare("UPDATE quotes SET status = 'accepted', sale_id = ?, updated_at = ? WHERE id = ?").run(saleId, this.now(), id);
    this.enqueue(ctx, 'quote', id, 'upsert', {});
  }

  private requireUsable(storeId: string, id: string): Quote {
    const q = this.get(id);
    if (q.store_id !== storeId) throw new AppError("Ce devis est d'un autre magasin", 'INVALID');
    if (q.state === 'accepted') throw new AppError(`Le devis ${q.number} a déjà été facturé (${q.sale_number ?? ''})`, 'INVALID');
    if (q.state === 'cancelled') throw new AppError(`Le devis ${q.number} est annulé`, 'INVALID');
    if (q.state === 'expired') throw new AppError(`Le devis ${q.number} a expiré le ${q.valid_until.split('-').reverse().join('/')}`, 'EXPIRED');
    return q;
  }

  private query(where: string, limit = 1) {
    return this.db.prepare(
      `SELECT q.id, q.number, q.kind, q.store_id, q.customer_id, c.code AS customer_code, COALESCE(c.name, q.customer_name) AS customer_name,
              q.quote_date, q.valid_until, q.status,
              CASE WHEN q.status = 'open' AND q.valid_until < @today THEN 'expired' ELSE q.status END AS state,
              q.sale_id, s.number AS sale_number, q.total_ttc, q.total_ht, q.total_tva, q.total_discount, q.notes,
              u.name AS user_name, a.name AS discount_authorized_by_name, q.created_at
       FROM quotes q LEFT JOIN customers c ON c.id = q.customer_id LEFT JOIN sales s ON s.id = q.sale_id
       LEFT JOIN users u ON u.id = q.user_id LEFT JOIN users a ON a.id = q.discount_authorized_by
       WHERE ${where} ORDER BY q.created_at DESC LIMIT ${limit}`,
    );
  }
}

function addDays(ymd: string, days: number): string {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
