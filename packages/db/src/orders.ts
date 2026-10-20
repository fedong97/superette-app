import { type Fcfa, type Milli, lineAmount } from '@superette/core';
import type { AdminService } from './admin';
import type { CatalogueService, Unit } from './catalogue';
import { AppError, Base, type Context, newId } from './util';

/** D'où vient la commande : appel, message WhatsApp, ou client passé au magasin. */
export type OrderChannel = 'phone' | 'whatsapp' | 'shop';
/**
 * Nouvelle (à préparer), Préparée (marchandise mise de côté : le stock est réservé),
 * Facturée (chargée et validée à la caisse), Annulée.
 */
export type OrderStatus = 'new' | 'prepared' | 'invoiced' | 'cancelled';

export const ORDER_STATUS: Record<OrderStatus, string> = { new: 'À préparer', prepared: 'Préparée', invoiced: 'Facturée', cancelled: 'Annulée' };
export const ORDER_CHANNELS: Record<OrderChannel, string> = { phone: 'Téléphone', whatsapp: 'WhatsApp', shop: 'Au magasin' };

export interface OrderLine {
  id: string;
  line_no: number;
  article_id: string;
  label: string;
  unit: Unit;
  qty: Milli;
  unit_price: Fcfa;
  total_ttc: Fcfa;
}

export interface CustomerOrder {
  id: string;
  number: string;
  store_id: string;
  customer_id: string | null;
  customer_name: string;
  phone: string | null;
  address: string | null;
  channel: OrderChannel;
  planned_date: string;
  slot: string | null;
  delivery_fee: Fcfa;
  courier: string | null;
  note: string | null;
  status: OrderStatus;
  sale_id: string | null;
  sale_number: string | null;
  total_ttc: Fcfa;
  user_name: string | null;
  prepared_at: string | null;
  created_at: string;
  lines: OrderLine[];
}

export interface OrderInput {
  customerId?: string | null;
  customerName?: string | null;
  phone?: string | null;
  /** Adresse de livraison ; vide = le client vient chercher sa commande. */
  address?: string | null;
  channel?: OrderChannel;
  /** Jour de livraison ou de retrait (AAAA-MM-JJ), aujourd'hui par défaut. */
  plannedDate?: string | null;
  slot?: string | null;
  deliveryFee?: Fcfa;
  courier?: string | null;
  note?: string | null;
  lines: { articleId: string; qty: Milli }[];
}

/**
 * Commandes clients prises avant la vente (téléphone, WhatsApp) : on les prépare,
 * la marchandise préparée est réservée (la caisse ne la vend pas à un autre), puis
 * la commande est chargée à la caisse et validée au moment de la livraison ou du
 * retrait. Les prix sont ceux du jour de la vente ; la livraison suit ensuite
 * dans Vente › Livraisons du jour.
 */
export class OrderService extends Base {
  constructor(
    db: ConstructorParameters<typeof Base>[0],
    clock: ConstructorParameters<typeof Base>[1],
    private readonly admin: AdminService,
    private readonly catalogue: CatalogueService,
  ) {
    super(db, clock);
  }

  save(ctx: Context, input: OrderInput, id?: string): CustomerOrder {
    if (input.lines.length === 0) throw new AppError('Ajoutez au moins un article', 'EMPTY');
    let customerName = input.customerName?.trim() || null;
    let phone = input.phone?.trim() || null;
    let address = input.address?.trim() || null;
    if (input.customerId) {
      const c = this.db.prepare('SELECT name, phone, address FROM customers WHERE id = ?').get(input.customerId) as { name: string; phone: string | null; address: string | null } | undefined;
      if (!c) throw new AppError('Client introuvable', 'NOT_FOUND');
      customerName = c.name;
      phone ??= c.phone;
      address ??= c.address;
    }
    if (!customerName) throw new AppError('Indiquez le client', 'CUSTOMER_REQUIRED');
    if (!phone) throw new AppError('Indiquez le téléphone du client', 'PHONE_REQUIRED');
    const channel = input.channel ?? 'phone';
    if (!(channel in ORDER_CHANNELS)) throw new AppError('Origine de la commande inconnue', 'INVALID');
    const plannedDate = input.plannedDate || this.today();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(plannedDate)) throw new AppError('Date de livraison invalide', 'INVALID');
    const fee = input.deliveryFee ?? 0;
    if (!Number.isSafeInteger(fee) || fee < 0) throw new AppError('Frais de livraison invalides', 'INVALID');
    if (fee > 0 && !address) throw new AppError('Des frais de livraison demandent une adresse', 'INVALID');
    const lines = input.lines.map((l) => {
      if (!Number.isSafeInteger(l.qty) || l.qty <= 0) throw new AppError('Quantité invalide', 'INVALID');
      const a = this.catalogue.getArticle(l.articleId, ctx.storeId);
      if (!a.active) throw new AppError(`Article inactif : ${a.name}`, 'INACTIVE');
      return { articleId: a.id, label: a.name, qty: l.qty, unitPrice: a.store_price, total: lineAmount(a.store_price, l.qty) };
    });
    // Modifier une commande préparée la remet « à préparer » : le magasinier revoit ce qui est mis de côté.
    if (id) {
      const current = this.get(id);
      if (current.status === 'invoiced' || current.status === 'cancelled') throw new AppError('Cette commande est clôturée : elle ne peut plus être modifiée', 'INVALID');
    }
    const total = lines.reduce((t, l) => t + l.total, 0) + fee;
    return this.tx(() => {
      const orderId = id ?? newId();
      const now = this.now();
      const row = {
        id: orderId,
        customer: input.customerId ?? null,
        customerName,
        phone,
        address,
        channel,
        plannedDate,
        slot: input.slot?.trim() || null,
        fee,
        courier: input.courier?.trim() || null,
        note: input.note?.trim() || null,
        total,
        now,
      };
      if (id) {
        this.db
          .prepare(
            `UPDATE customer_orders SET customer_id = @customer, customer_name = @customerName, phone = @phone, address = @address, channel = @channel,
               planned_date = @plannedDate, slot = @slot, delivery_fee = @fee, courier = @courier, note = @note, total_ttc = @total,
               status = 'new', prepared_at = NULL, updated_at = @now WHERE id = @id`,
          )
          .run(row);
        this.db.prepare('DELETE FROM customer_order_lines WHERE order_id = ?').run(orderId);
      } else {
        const prefix = this.admin.storeSettings(ctx.storeId).prefixCustomerOrder || 'CC';
        const number = `${prefix}-${this.stationPrefix()}-${String(this.nextCounter('customer_order')).padStart(5, '0')}`;
        this.db
          .prepare(
            `INSERT INTO customer_orders (id, number, store_id, customer_id, customer_name, phone, address, channel, planned_date, slot, delivery_fee,
               courier, note, status, total_ttc, user_id, created_at, updated_at)
             VALUES (@id, @number, @store, @customer, @customerName, @phone, @address, @channel, @plannedDate, @slot, @fee, @courier, @note, 'new',
               @total, @user, @now, @now)`,
          )
          .run({ ...row, number, store: ctx.storeId, user: ctx.userId });
      }
      const insert = this.db.prepare(
        'INSERT INTO customer_order_lines (id, order_id, line_no, article_id, label, qty, unit_price, total_ttc) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      );
      lines.forEach((l, i) => insert.run(newId(), orderId, i + 1, l.articleId, l.label, l.qty, l.unitPrice, l.total));
      this.enqueue(ctx, 'customer_order', orderId, 'upsert', {});
      this.audit(ctx.userId, id ? 'order.update' : 'order.create', 'customer_order', orderId, { total, channel });
      return this.get(orderId);
    });
  }

  /** Marchandise mise de côté : à partir de là, la caisse ne la vend plus à un autre client. */
  prepare(ctx: Context, id: string): CustomerOrder {
    const o = this.get(id);
    if (o.status !== 'new') throw new AppError(o.status === 'prepared' ? 'Commande déjà préparée' : 'Cette commande est clôturée', 'INVALID');
    this.setStatus(ctx, id, 'prepared', 'order.prepare');
    return this.get(id);
  }

  /** Remet une commande préparée « à préparer » : sa réservation est libérée. */
  unprepare(ctx: Context, id: string): CustomerOrder {
    const o = this.get(id);
    if (o.status !== 'prepared') throw new AppError("Cette commande n'est pas préparée", 'INVALID');
    this.setStatus(ctx, id, 'new', 'order.unprepare');
    return this.get(id);
  }

  cancel(ctx: Context, id: string, reason: string): CustomerOrder {
    const o = this.get(id);
    if (o.status === 'invoiced' || o.status === 'cancelled') throw new AppError('Cette commande est déjà clôturée', 'INVALID');
    if (!reason.trim()) throw new AppError("Indiquez le motif de l'annulation", 'REASON_REQUIRED');
    this.setStatus(ctx, id, 'cancelled', 'order.cancel', reason.trim());
    return this.get(id);
  }

  get(id: string): CustomerOrder {
    const head = this.query('o.id = @id').get({ id }) as Omit<CustomerOrder, 'lines'> | undefined;
    if (!head) throw new AppError('Commande introuvable', 'NOT_FOUND');
    const lines = this.db
      .prepare(
        `SELECT l.id, l.line_no, l.article_id, l.label, a.unit, l.qty, l.unit_price, l.total_ttc
         FROM customer_order_lines l JOIN articles a ON a.id = l.article_id WHERE l.order_id = ? ORDER BY l.line_no`,
      )
      .all(id) as OrderLine[];
    return { ...head, lines };
  }

  list(storeId: string, opts: { status?: OrderStatus | 'open'; search?: string; date?: string } = {}): Omit<CustomerOrder, 'lines'>[] {
    const search = opts.search?.trim() ? `%${opts.search.trim()}%` : null;
    return this.query(
      `o.store_id = @storeId
       AND (@status IS NULL OR (@status = 'open' AND o.status IN ('new', 'prepared')) OR o.status = @status)
       AND (@date IS NULL OR o.planned_date = @date)
       AND (@search IS NULL OR o.number LIKE @search OR o.customer_name LIKE @search OR o.phone LIKE @search)`,
      500,
    ).all({ storeId, status: opts.status ?? null, date: opts.date ?? null, search }) as Omit<CustomerOrder, 'lines'>[];
  }

  /** Quantités mises de côté par les commandes préparées du magasin, par article (sauf `exceptId`). */
  reserved(storeId: string, exceptId?: string | null): Map<string, Milli> {
    const rows = this.db
      .prepare(
        `SELECT l.article_id, SUM(l.qty) AS qty FROM customer_order_lines l JOIN customer_orders o ON o.id = l.order_id
         WHERE o.store_id = ? AND o.status = 'prepared' AND o.id <> ? GROUP BY l.article_id`,
      )
      .all(storeId, exceptId ?? '') as { article_id: string; qty: Milli }[];
    return new Map(rows.map((r) => [r.article_id, r.qty]));
  }

  /** Lignes et livraison à charger dans la caisse. */
  saleLines(storeId: string, id: string): {
    lines: { articleId: string; qty: Milli }[];
    customerId: string | null;
    clientName: string;
    delivery: { address: string; phone: string | null; courier: string | null; slot: string | null; plannedDate: string; fee: Fcfa; note: string | null } | null;
  } {
    const o = this.get(id);
    if (o.store_id !== storeId) throw new AppError("Cette commande est d'un autre magasin", 'INVALID');
    if (o.status === 'invoiced') throw new AppError(`La commande ${o.number} a déjà été facturée (${o.sale_number ?? ''})`, 'INVALID');
    if (o.status === 'cancelled') throw new AppError(`La commande ${o.number} est annulée`, 'INVALID');
    return {
      lines: o.lines.map((l) => ({ articleId: l.article_id, qty: l.qty })),
      customerId: o.customer_id,
      clientName: o.customer_name,
      delivery: o.address
        ? { address: o.address, phone: o.phone, courier: o.courier, slot: o.slot, plannedDate: o.planned_date, fee: o.delivery_fee, note: o.note }
        : null,
    };
  }

  /** Appelé dans la transaction de la vente. */
  markInvoiced(ctx: Context, id: string, saleId: string): void {
    const status = this.db.prepare('SELECT status FROM customer_orders WHERE id = ?').pluck().get(id) as OrderStatus | undefined;
    if (!status) throw new AppError('Commande introuvable', 'NOT_FOUND');
    if (status === 'invoiced' || status === 'cancelled') throw new AppError('Cette commande est déjà clôturée', 'INVALID');
    this.db.prepare("UPDATE customer_orders SET status = 'invoiced', sale_id = ?, updated_at = ? WHERE id = ?").run(saleId, this.now(), id);
    this.enqueue(ctx, 'customer_order', id, 'upsert', {});
  }

  /** Message de confirmation prêt à envoyer par WhatsApp. */
  confirmationText(id: string, storeName: string): string {
    const o = this.get(id);
    const items = o.lines.map((l) => `- ${l.label} x ${String(l.qty / 1000).replace('.', ',')}`).join('\n');
    const when = o.planned_date.split('-').reverse().join('/');
    const fcfa = (n: number) => `${n.toLocaleString('fr-FR').replace(/ | /g, ' ')} FCFA`;
    return [
      `Bonjour ${o.customer_name},`,
      `${storeName} a bien reçu votre commande ${o.number} :`,
      items,
      o.delivery_fee > 0 ? `Livraison : ${fcfa(o.delivery_fee)}` : null,
      `Total estimé : ${fcfa(o.total_ttc)}`,
      o.address ? `Livraison le ${when}${o.slot ? ` (${o.slot})` : ''} : ${o.address}.` : `À retirer au magasin le ${when}${o.slot ? ` (${o.slot})` : ''}.`,
      'Paiement à la livraison en espèces ou Mobile Money. Merci !',
    ]
      .filter(Boolean)
      .join('\n');
  }

  private setStatus(ctx: Context, id: string, status: OrderStatus, action: string, reason?: string): void {
    this.tx(() => {
      this.db
        .prepare('UPDATE customer_orders SET status = ?, prepared_at = ?, cancel_reason = COALESCE(?, cancel_reason), updated_at = ? WHERE id = ?')
        .run(status, status === 'prepared' ? this.now() : null, reason ?? null, this.now(), id);
      this.enqueue(ctx, 'customer_order', id, 'upsert', {});
      this.audit(ctx.userId, action, 'customer_order', id, reason ? { reason } : undefined);
    });
  }

  private query(where: string, limit = 1) {
    return this.db.prepare(
      `SELECT o.id, o.number, o.store_id, o.customer_id, COALESCE(c.name, o.customer_name) AS customer_name, o.phone, o.address, o.channel,
              o.planned_date, o.slot, o.delivery_fee, o.courier, o.note, o.status, o.sale_id, s.number AS sale_number, o.total_ttc,
              u.name AS user_name, o.prepared_at, o.created_at
       FROM customer_orders o LEFT JOIN customers c ON c.id = o.customer_id LEFT JOIN sales s ON s.id = o.sale_id LEFT JOIN users u ON u.id = o.user_id
       WHERE ${where} ORDER BY o.planned_date, o.created_at LIMIT ${limit}`,
    );
  }
}
