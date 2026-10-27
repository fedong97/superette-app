import { createHash } from 'node:crypto';
import { type Fcfa, type Milli, lineAmount } from '@superette/core';
import type { CatalogueService } from './catalogue';
import type { Db } from './database';
import type { CustomerOrder, OrderService } from './orders';
import { AppError, Base, type Clock, type Context, newId } from './util';

/** Jours de la semaine : 1 = lundi … 7 = dimanche. */
export const WEEKDAYS = ['', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi', 'Dimanche'] as const;

export interface RecurringOrderLine {
  articleId: string;
  qty: Milli;
}

export interface RecurringOrderInput {
  customerId?: string | null;
  customerName?: string | null;
  phone?: string | null;
  address?: string | null;
  /** Jours de livraison (1 = lundi … 7 = dimanche). */
  weekdays: number[];
  /** Toutes les semaines (1), une semaine sur deux (2)… */
  everyWeeks?: number;
  /** Premier jour possible (AAAA-MM-JJ), aujourd'hui par défaut. */
  startDate?: string | null;
  /** La commande est créée et préparée autant de jours avant la livraison. */
  leadDays?: number;
  slot?: string | null;
  deliveryFee?: Fcfa;
  note?: string | null;
  lines: RecurringOrderLine[];
}

export interface RecurringOrder {
  id: string;
  store_id: string;
  customer_id: string | null;
  customer_name: string;
  phone: string;
  address: string | null;
  weekdays: number[];
  every_weeks: number;
  start_date: string;
  lead_days: number;
  slot: string | null;
  delivery_fee: Fcfa;
  note: string | null;
  lines: (RecurringOrderLine & { name: string; code: string; unit_price: Fcfa; total: Fcfa })[];
  active: number;
  last_date: string | null;
  /** Prochaine livraison prévue ; null si la commande est arrêtée. */
  next_date: string | null;
  total: Fcfa;
  created_at: string;
}

/**
 * Commandes répétées des clients pros (restaurant, école, boutiquier du
 * quartier) : chaque semaine, la commande client se crée seule quelques jours
 * avant la livraison et passe « préparée », ce qui réserve le stock. Le même
 * identifiant est calculé sur tous les PC : deux postes ne la créent pas deux fois.
 */
export class RecurringOrderService extends Base {
  constructor(
    db: Db,
    clock: Clock,
    private readonly catalogue: CatalogueService,
    private readonly orders: OrderService,
  ) {
    super(db, clock);
  }

  save(ctx: Context, input: RecurringOrderInput, id?: string): RecurringOrder {
    const weekdays = [...new Set(input.weekdays)].filter((d) => Number.isInteger(d) && d >= 1 && d <= 7).sort();
    if (!weekdays.length) throw new AppError('Choisissez au moins un jour de livraison', 'INVALID');
    const every = input.everyWeeks ?? 1;
    if (!Number.isInteger(every) || every < 1 || every > 8) throw new AppError('Fréquence invalide (toutes les 1 à 8 semaines)', 'INVALID');
    const lead = input.leadDays ?? 1;
    if (!Number.isInteger(lead) || lead < 0 || lead > 7) throw new AppError('La commande se prépare 0 à 7 jours avant la livraison', 'INVALID');
    const start = input.startDate || this.today();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) throw new AppError('Date de début invalide', 'INVALID');
    if (!input.lines.length) throw new AppError('Ajoutez au moins un article', 'EMPTY');
    const lines = input.lines.map((l) => {
      if (!Number.isSafeInteger(l.qty) || l.qty <= 0) throw new AppError('Quantité invalide', 'INVALID');
      const a = this.catalogue.getArticle(l.articleId, ctx.storeId);
      if (!a.active) throw new AppError(`Article inactif : ${a.name}`, 'INACTIVE');
      return { articleId: a.id, qty: l.qty };
    });
    let name = input.customerName?.trim() || null;
    let phone = input.phone?.trim() || null;
    let address = input.address?.trim() || null;
    if (input.customerId) {
      const c = this.db.prepare('SELECT name, phone, address FROM customers WHERE id = ?').get(input.customerId) as { name: string; phone: string | null; address: string | null } | undefined;
      if (!c) throw new AppError('Client introuvable', 'NOT_FOUND');
      name = c.name;
      phone ??= c.phone;
      address ??= c.address;
    }
    if (!name) throw new AppError('Indiquez le client', 'CUSTOMER_REQUIRED');
    if (!phone) throw new AppError('Indiquez le téléphone du client', 'PHONE_REQUIRED');
    const fee = input.deliveryFee ?? 0;
    if (!Number.isSafeInteger(fee) || fee < 0) throw new AppError('Frais de livraison invalides', 'INVALID');
    if (fee > 0 && !address) throw new AppError('Des frais de livraison demandent une adresse', 'INVALID');
    if (id) this.get(id);
    const rowId = id ?? newId();
    const now = this.now();
    const row = {
      id: rowId,
      store: ctx.storeId,
      customer: input.customerId ?? null,
      name,
      phone,
      address,
      weekdays: weekdays.join(','),
      every,
      start,
      lead,
      slot: input.slot?.trim() || null,
      fee,
      note: input.note?.trim() || null,
      lines: JSON.stringify(lines),
      user: ctx.userId,
      now,
    };
    this.tx(() => {
      if (id)
        this.db
          .prepare(
            `UPDATE recurring_orders SET customer_id = @customer, customer_name = @name, phone = @phone, address = @address, weekdays = @weekdays,
               every_weeks = @every, start_date = @start, lead_days = @lead, slot = @slot, delivery_fee = @fee, note = @note, lines = @lines,
               user_id = @user, updated_at = @now WHERE id = @id`,
          )
          .run(row);
      else
        this.db
          .prepare(
            `INSERT INTO recurring_orders (id, store_id, customer_id, customer_name, phone, address, weekdays, every_weeks, start_date, lead_days, slot,
               delivery_fee, note, lines, active, user_id, created_at, updated_at)
             VALUES (@id, @store, @customer, @name, @phone, @address, @weekdays, @every, @start, @lead, @slot, @fee, @note, @lines, 1, @user, @now, @now)`,
          )
          .run(row);
      this.enqueue(ctx, 'recurring_order', rowId, 'upsert', {});
      this.audit(ctx.userId, id ? 'recurring_order.update' : 'recurring_order.create', 'recurring_order', rowId, { weekdays, every });
    });
    return this.get(rowId);
  }

  setActive(ctx: Context, id: string, active: boolean): RecurringOrder {
    this.get(id);
    this.tx(() => {
      this.db.prepare('UPDATE recurring_orders SET active = ?, updated_at = ? WHERE id = ?').run(active ? 1 : 0, this.now(), id);
      this.enqueue(ctx, 'recurring_order', id, 'upsert', {});
      this.audit(ctx.userId, active ? 'recurring_order.resume' : 'recurring_order.stop', 'recurring_order', id);
    });
    return this.get(id);
  }

  get(id: string): RecurringOrder {
    const row = this.db.prepare('SELECT * FROM recurring_orders WHERE id = ?').get(id) as RawRecurring | undefined;
    if (!row) throw new AppError('Commande répétée introuvable', 'NOT_FOUND');
    return this.shape(row);
  }

  list(storeId: string): RecurringOrder[] {
    return (this.db.prepare('SELECT * FROM recurring_orders WHERE store_id = ? ORDER BY active DESC, customer_name').all(storeId) as RawRecurring[]).map((r) => this.shape(r));
  }

  private shape(r: RawRecurring): RecurringOrder {
    const lines = (JSON.parse(r.lines) as RecurringOrderLine[]).map((l) => {
      const a = this.db
        .prepare('SELECT a.name, a.code, COALESCE(sp.sale_price, a.sale_price) AS price FROM articles a LEFT JOIN store_prices sp ON sp.article_id = a.id AND sp.store_id = ? WHERE a.id = ?')
        .get(r.store_id, l.articleId) as { name: string; code: string; price: Fcfa } | undefined;
      const price = a?.price ?? 0;
      return { ...l, name: a?.name ?? '(article supprimé)', code: a?.code ?? '', unit_price: price, total: lineAmount(price, l.qty) };
    });
    const weekdays = r.weekdays.split(',').map(Number);
    const rule = { ...r, weekdays };
    return {
      ...rule,
      lines,
      next_date: r.active ? (this.dates(rule, this.today(), 70)[0] ?? null) : null,
      total: lines.reduce((t, l) => t + l.total, 0) + r.delivery_fee,
    };
  }

  /** Jours de livraison de la règle à partir de `from`, sur `days` jours. */
  private dates(r: { weekdays: number[]; every_weeks: number; start_date: string }, from: string, days: number): string[] {
    const out: string[] = [];
    const start = Date.parse(`${r.start_date}T00:00:00Z`);
    // Semaine du début (lundi) : sert à compter « une semaine sur deux ».
    const startMonday = start - ((new Date(start).getUTCDay() + 6) % 7) * 86_400_000;
    const first = Math.max(Date.parse(`${from}T00:00:00Z`), start);
    for (let t = first; t < first + days * 86_400_000; t += 86_400_000) {
      const wd = ((new Date(t).getUTCDay() + 6) % 7) + 1;
      const week = Math.floor((t - startMonday) / (7 * 86_400_000));
      if (r.weekdays.includes(wd) && week % r.every_weeks === 0) out.push(new Date(t).toISOString().slice(0, 10));
    }
    return out;
  }

  /**
   * Crée et prépare les commandes dont la livraison tombe dans le délai de
   * préparation (aujourd'hui compris). Lancé régulièrement par chaque PC du
   * magasin : une commande déjà créée (ou annulée à la main) ne revient pas.
   */
  generate(ctx: Context): CustomerOrder[] {
    const today = this.today();
    const created: CustomerOrder[] = [];
    for (const raw of this.db.prepare('SELECT * FROM recurring_orders WHERE store_id = ? AND active = 1').all(ctx.storeId) as RawRecurring[]) {
      const rule = this.shape(raw);
      for (const date of this.dates(rule, today, rule.lead_days + 1)) {
        const ref = `REC:${rule.id}:${date}`;
        const orderId = stableId(ref);
        if (this.db.prepare('SELECT 1 FROM customer_orders WHERE web_ref = ? OR id = ?').get(ref, orderId)) continue;
        const lines = rule.lines.filter((l) => {
          const a = this.db.prepare('SELECT active FROM articles WHERE id = ?').get(l.articleId) as { active: number } | undefined;
          return a?.active === 1;
        });
        if (!lines.length) continue;
        const skipped = rule.lines.length - lines.length;
        const as: Context = { ...ctx, userId: raw.user_id ?? ctx.userId };
        const order = this.tx(() => {
          const o = this.orders.save(
            as,
            {
              customerId: rule.customer_id,
              customerName: rule.customer_name,
              phone: rule.phone,
              address: rule.address,
              channel: 'phone',
              plannedDate: date,
              slot: rule.slot,
              deliveryFee: rule.address ? rule.delivery_fee : 0,
              note: [`Commande répétée (${rule.weekdays.map((d) => WEEKDAYS[d]).join(', ')})`, rule.note, skipped ? `${skipped} article(s) inactif(s) non repris` : null]
                .filter(Boolean)
                .join(' · '),
              lines: lines.map((l) => ({ articleId: l.articleId, qty: l.qty })),
            },
            undefined,
            { createId: orderId },
          );
          this.db.prepare('UPDATE customer_orders SET web_ref = ? WHERE id = ?').run(ref, o.id);
          // Préparée : la caisse ne vend plus ce stock à un autre client.
          const prepared = this.orders.prepare(as, o.id);
          this.db.prepare('UPDATE recurring_orders SET last_date = MAX(COALESCE(last_date, \'\'), ?), updated_at = ? WHERE id = ?').run(date, this.now(), rule.id);
          this.enqueue(ctx, 'recurring_order', rule.id, 'upsert', {});
          this.audit(as.userId, 'recurring_order.generated', 'customer_order', o.id, { recurring: rule.id, date });
          return prepared;
        });
        created.push(order);
      }
    }
    return created;
  }
}

interface RawRecurring {
  id: string;
  store_id: string;
  customer_id: string | null;
  customer_name: string;
  phone: string;
  address: string | null;
  weekdays: string;
  every_weeks: number;
  start_date: string;
  lead_days: number;
  slot: string | null;
  delivery_fee: Fcfa;
  note: string | null;
  lines: string;
  active: number;
  last_date: string | null;
  user_id: string | null;
  created_at: string;
}

/** Identifiant au format UUID calculé d'après un texte : le même sur tous les PC. */
function stableId(text: string): string {
  const h = createHash('sha1').update(text).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((parseInt(h[16]!, 16) & 3) | 8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
