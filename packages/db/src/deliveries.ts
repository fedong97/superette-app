import type { Fcfa } from '@superette/core';
import type { Db } from './database';
import { AppError, Base, type Clock, type Context, newId } from './util';

/** Article de service des frais de livraison : même identifiant sur tous les PC. */
export const DELIVERY_FEE_ARTICLE_ID = 'svc-delivery-fee';

export type DeliveryStatus = 'pending' | 'out' | 'delivered' | 'cancelled';

export const DELIVERY_STATUS: Record<DeliveryStatus, string> = {
  pending: 'À préparer',
  out: 'En route',
  delivered: 'Livrée',
  cancelled: 'Annulée',
};

/** Livraison saisie à la caisse (onglet Livraison du ticket). */
export interface DeliveryInput {
  address: string;
  phone?: string | null;
  courier?: string | null;
  /** Créneau libre : « Tout de suite », « 14h–16h »… */
  slot?: string | null;
  /** Jour prévu (AAAA-MM-JJ) ; aujourd'hui par défaut. */
  plannedDate?: string | null;
  /** Frais de livraison TTC, ajoutés au ticket comme une ligne de service. */
  fee?: Fcfa;
  note?: string | null;
}

export interface Delivery {
  id: string;
  sale_id: string;
  store_id: string;
  address: string;
  phone: string | null;
  courier: string | null;
  slot: string | null;
  planned_date: string;
  fee: Fcfa;
  note: string | null;
  status: DeliveryStatus;
  out_at: string | null;
  delivered_at: string | null;
  created_at: string;
  updated_at: string;
}

/** Livraison avec sa vente : numéro, client, total et reste à encaisser (part à crédit). */
export interface DeliveryRow extends Delivery {
  sale_number: string;
  sale_status: 'completed' | 'cancelled';
  customer_id: string | null;
  customer_name: string | null;
  total_ttc: Fcfa;
  /** Part de la vente mise sur le compte du client : le livreur l'encaisse. */
  to_collect: Fcfa;
}

/**
 * Livraisons des ventes chez le client : saisies à la caisse avec la vente,
 * puis suivies dans « Livraisons du jour » (à préparer, en route, livrée).
 */
export class DeliveryService extends Base {
  constructor(db: Db, clock: Clock) {
    super(db, clock);
  }

  /** Crée au besoin l'article de service « Frais de livraison » (inactif : il n'apparaît dans aucune liste). */
  feeArticleId(ctx: Pick<Context, 'storeId' | 'registerId'>): string {
    const exists = this.db.prepare('SELECT 1 FROM articles WHERE id = ?').pluck().get(DELIVERY_FEE_ARTICLE_ID);
    if (!exists) {
      const vat = this.db.prepare('SELECT id FROM vat_rates WHERE active = 1 ORDER BY rate_bp DESC LIMIT 1').pluck().get() as string | undefined;
      if (!vat) throw new AppError('Aucun taux de TVA défini', 'INVALID');
      const now = this.now();
      this.db
        .prepare(
          `INSERT INTO articles (id, code, name, unit, vat_rate_id, purchase_price, sale_price, active, is_service, created_at, updated_at)
           VALUES (?, 'LIVRAISON', 'Frais de livraison', 'piece', ?, 0, 0, 0, 1, ?, ?)`,
        )
        .run(DELIVERY_FEE_ARTICLE_ID, vat, now, now);
      this.enqueue(ctx, 'article', DELIVERY_FEE_ARTICLE_ID, 'upsert', {});
    }
    return DELIVERY_FEE_ARTICLE_ID;
  }

  /** Contrôle la saisie avant la vente : on ne valide pas une vente dont la livraison serait refusée ensuite. */
  check(input: DeliveryInput): void {
    if (!input.address?.trim()) throw new AppError("Indiquez l'adresse de livraison", 'INVALID');
    const fee = input.fee ?? 0;
    if (!Number.isSafeInteger(fee) || fee < 0) throw new AppError('Frais de livraison invalides', 'INVALID');
    if (input.plannedDate && !/^\d{4}-\d{2}-\d{2}$/.test(input.plannedDate)) throw new AppError('Date de livraison invalide', 'INVALID');
  }

  /** Enregistre la livraison d'une vente (dans la transaction de la vente). */
  create(ctx: Context, saleId: string, input: DeliveryInput): Delivery {
    this.check(input);
    const id = newId();
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO sale_deliveries (id, sale_id, store_id, address, phone, courier, slot, planned_date, fee, note, status, updated_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
      )
      .run(
        id,
        saleId,
        ctx.storeId,
        input.address.trim().slice(0, 200),
        input.phone?.trim().slice(0, 40) || null,
        input.courier?.trim().slice(0, 60) || null,
        input.slot?.trim().slice(0, 40) || null,
        input.plannedDate || this.today(),
        input.fee ?? 0,
        input.note?.trim().slice(0, 300) || null,
        ctx.userId,
        now,
        now,
      );
    const d = this.get(id);
    this.enqueue(ctx, 'sale_delivery', id, 'upsert', d);
    return d;
  }

  get(id: string): Delivery {
    const d = this.db.prepare('SELECT * FROM sale_deliveries WHERE id = ?').get(id) as Delivery | undefined;
    if (!d) throw new AppError('Livraison introuvable', 'NOT_FOUND');
    return d;
  }

  forSale(saleId: string): Delivery | null {
    return (this.db.prepare('SELECT * FROM sale_deliveries WHERE sale_id = ?').get(saleId) as Delivery | undefined) ?? null;
  }

  /**
   * Livraisons d'un magasin : du jour (`date`), d'une période, ou toutes celles
   * qui ne sont pas encore livrées (`open`), les plus anciennes d'abord.
   */
  list(storeId: string, opts: { from?: string; to?: string; open?: boolean; courier?: string | null } = {}): DeliveryRow[] {
    const where = ['d.store_id = @storeId'];
    if (opts.open) where.push("d.status IN ('pending', 'out')");
    if (opts.from) where.push('d.planned_date >= @from');
    if (opts.to) where.push('d.planned_date <= @to');
    if (opts.courier) where.push('d.courier = @courier');
    return this.db
      .prepare(
        `SELECT d.*, s.number AS sale_number, s.status AS sale_status, s.customer_id, COALESCE(c.name, s.client_name) AS customer_name, s.total_ttc,
                COALESCE((SELECT SUM(p.amount) FROM sale_payments p WHERE p.sale_id = s.id AND p.method = 'CUSTOMER_CREDIT'), 0) AS to_collect
         FROM sale_deliveries d JOIN sales s ON s.id = d.sale_id LEFT JOIN customers c ON c.id = s.customer_id
         WHERE ${where.join(' AND ')}
         ORDER BY d.planned_date, CASE d.status WHEN 'out' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END, d.created_at`,
      )
      .all({ storeId, from: opts.from ?? null, to: opts.to ?? null, courier: opts.courier ?? null }) as DeliveryRow[];
  }

  /** Livreurs déjà saisis dans ce magasin, pour la liste de choix. */
  couriers(storeId: string): string[] {
    return this.db
      .prepare("SELECT courier FROM sale_deliveries WHERE store_id = ? AND courier IS NOT NULL AND courier <> '' GROUP BY courier ORDER BY MAX(created_at) DESC LIMIT 20")
      .pluck()
      .all(storeId) as string[];
  }

  /** Fait avancer une livraison : partie (heure notée), livrée (heure notée) ou annulée. */
  setStatus(ctx: Context, id: string, status: Exclude<DeliveryStatus, 'pending'>, patch: { courier?: string | null } | null = {}): Delivery {
    const d = this.get(id);
    if (d.store_id !== ctx.storeId) throw new AppError("Cette livraison est d'un autre magasin", 'FORBIDDEN');
    if (d.status === 'delivered' || d.status === 'cancelled') throw new AppError(`Livraison déjà ${DELIVERY_STATUS[d.status].toLowerCase()}`, 'INVALID');
    if (status === 'out' && d.status !== 'pending') throw new AppError('Cette livraison est déjà partie', 'INVALID');
    const now = this.now();
    this.db
      .prepare(
        `UPDATE sale_deliveries SET status = @status, courier = COALESCE(@courier, courier),
           out_at = CASE WHEN @status = 'out' THEN @now ELSE out_at END,
           delivered_at = CASE WHEN @status = 'delivered' THEN @now ELSE delivered_at END,
           updated_by = @user, updated_at = @now WHERE id = @id`,
      )
      .run({ id, status, courier: patch?.courier?.trim() || null, now, user: ctx.userId });
    const next = this.get(id);
    this.audit(ctx.userId, `delivery.${status}`, 'sale_delivery', id, { sale: d.sale_id });
    this.enqueue(ctx, 'sale_delivery', id, 'upsert', next);
    return next;
  }

  /** Une vente annulée n'est plus à livrer. */
  cancelForSale(ctx: Context, saleId: string): void {
    const d = this.forSale(saleId);
    if (d && (d.status === 'pending' || d.status === 'out')) this.setStatus(ctx, d.id, 'cancelled');
  }
}
