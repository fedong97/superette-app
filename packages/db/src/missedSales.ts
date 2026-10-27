import type { Milli } from '@superette/core';
import { AppError, Base, type Context, newId } from './util';

export type MissedReason = 'absent' | 'rupture' | 'prix' | 'autre';

export const MISSED_REASONS: Record<MissedReason, string> = {
  absent: 'Pas vendu au magasin',
  rupture: 'En rupture',
  prix: 'Trop cher',
  autre: 'Autre raison',
};

export interface MissedSaleInput {
  /** Article du catalogue ; vide pour un produit que le magasin ne vend pas. */
  articleId?: string | null;
  /** Ce que le client a demandé, en clair (« Lait Nido 900 g »). */
  label?: string | null;
  qty?: Milli;
  reason?: MissedReason;
  note?: string | null;
  source?: 'pc' | 'phone';
  /** Nom et téléphone du client, pour le prévenir quand le produit arrive. */
  customerName?: string | null;
  phone?: string | null;
}

export interface MissedSale {
  id: string;
  article_id: string | null;
  article_code: string | null;
  label: string;
  qty: Milli;
  reason: MissedReason;
  note: string | null;
  user_name: string | null;
  source: string;
  created_at: string;
  customer_name: string | null;
  phone: string | null;
  notified_at: string | null;
}

/** Client à prévenir : il voulait un produit qui est maintenant en stock. */
export interface MissedToNotify extends MissedSale {
  stock: Milli;
  price: number;
}

/** Produits les plus demandés sans être vendus, sur une période. */
export interface MissedTop {
  key: string;
  article_id: string | null;
  label: string;
  times: number;
  qty: Milli;
  /** Raison la plus fréquente. */
  reason: MissedReason;
  last_at: string;
  /** Stock actuel du magasin (null pour un produit hors catalogue). */
  stock: Milli | null;
}

/**
 * Ventes manquées : « le client voulait… ». Le vendeur note en quelques
 * secondes un produit absent, en rupture ou jugé trop cher ; le gérant voit
 * les plus demandés et la proposition de commande en tient compte.
 */
export class MissedSaleService extends Base {
  record(ctx: Context, input: MissedSaleInput): MissedSale {
    const article = input.articleId
      ? (this.db.prepare('SELECT id, name FROM articles WHERE id = ?').get(input.articleId) as { id: string; name: string } | undefined)
      : undefined;
    if (input.articleId && !article) throw new AppError('Produit introuvable', 'NOT_FOUND');
    const label = (article?.name ?? input.label ?? '').trim().slice(0, 120);
    if (label.length < 2) throw new AppError('Indiquez le produit demandé par le client', 'INVALID');
    const qty = input.qty ?? 1000;
    if (!Number.isSafeInteger(qty) || qty <= 0 || qty > 10_000_000) throw new AppError('Quantité invalide', 'INVALID');
    const reason: MissedReason = input.reason && input.reason in MISSED_REASONS ? input.reason : article ? 'rupture' : 'absent';
    const phone = normalizePhone(input.phone);
    if (input.phone?.trim() && !phone) throw new AppError('Numéro de téléphone invalide (ex. 677 12 34 56)', 'INVALID');
    const id = newId();
    const now = this.now();
    return this.tx(() => {
      this.db
        .prepare(
          `INSERT INTO missed_sales (id, store_id, article_id, label, qty, reason, note, user_id, source, customer_name, phone, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, ctx.storeId, article?.id ?? null, label, qty, reason, input.note?.trim() || null, ctx.userId, input.source === 'phone' ? 'phone' : 'pc',
          input.customerName?.trim().slice(0, 80) || null, phone, now, now);
      this.enqueue(ctx, 'missed_sale', id, 'upsert', {});
      return this.get(id);
    });
  }

  /** Une demande notée par erreur se retire (le jour même, par celui qui l'a notée ou le gérant). */
  remove(ctx: Context, id: string, asManager: boolean): void {
    const row = this.db.prepare('SELECT user_id, store_id, created_at FROM missed_sales WHERE id = ?').get(id) as { user_id: string | null; store_id: string; created_at: string } | undefined;
    if (!row || row.store_id !== ctx.storeId) throw new AppError('Demande introuvable', 'NOT_FOUND');
    if (!asManager && row.user_id !== ctx.userId) throw new AppError('Seul celui qui a noté la demande, ou le gérant, peut la retirer', 'FORBIDDEN');
    this.tx(() => {
      this.db.prepare('DELETE FROM missed_sales WHERE id = ?').run(id);
      this.enqueue(ctx, 'missed_sale', id, 'delete', null);
    });
  }

  get(id: string): MissedSale {
    const row = this.db.prepare(`${SELECT} WHERE m.id = ?`).get(id) as MissedSale | undefined;
    if (!row) throw new AppError('Demande introuvable', 'NOT_FOUND');
    return row;
  }

  list(storeId: string, opts: { from?: string | null; to?: string | null; limit?: number } = {}): MissedSale[] {
    return this.db
      .prepare(`${SELECT} WHERE m.store_id = @storeId AND (@from IS NULL OR m.created_at >= @from) AND (@to IS NULL OR m.created_at < @to) ORDER BY m.created_at DESC LIMIT @limit`)
      .all({ storeId, from: opts.from ?? null, to: opts.to ? nextDay(opts.to) : null, limit: opts.limit ?? 500 }) as MissedSale[];
  }

  /** Les plus demandés depuis `days` jours : par article, ou par nom pour les produits hors catalogue. */
  top(storeId: string, days = 30): MissedTop[] {
    const since = new Date(this.clock().getTime() - days * 86_400_000).toISOString();
    const rows = this.db
      .prepare(
        `SELECT COALESCE(m.article_id, lower(trim(m.label))) AS key, m.article_id, MAX(COALESCE(a.name, m.label)) AS label,
                COUNT(*) AS times, SUM(m.qty) AS qty, MAX(m.created_at) AS last_at,
                (SELECT x.reason FROM missed_sales x WHERE x.store_id = m.store_id AND COALESCE(x.article_id, lower(trim(x.label))) = COALESCE(m.article_id, lower(trim(m.label)))
                   AND x.created_at >= @since GROUP BY x.reason ORDER BY COUNT(*) DESC LIMIT 1) AS reason,
                CASE WHEN m.article_id IS NULL THEN NULL ELSE COALESCE((SELECT SUM(s.qty) FROM stock s JOIN warehouses w ON w.id = s.warehouse_id
                  WHERE s.article_id = m.article_id AND w.store_id = m.store_id AND w.purpose = 'stock'), 0) END AS stock
         FROM missed_sales m LEFT JOIN articles a ON a.id = m.article_id
         WHERE m.store_id = @storeId AND m.created_at >= @since
         GROUP BY key ORDER BY times DESC, qty DESC LIMIT 100`,
      )
      .all({ storeId, since }) as MissedTop[];
    return rows;
  }

  /**
   * Clients qui ont laissé leur numéro pour un produit du catalogue qui est
   * maintenant en stock, et qui n'ont pas encore été prévenus (60 derniers jours).
   */
  toNotify(storeId: string): MissedToNotify[] {
    const since = new Date(this.clock().getTime() - 60 * 86_400_000).toISOString();
    return this.db
      .prepare(
        `SELECT * FROM (
           SELECT x.*, COALESCE((SELECT SUM(s.qty) FROM stock s JOIN warehouses w ON w.id = s.warehouse_id
                    WHERE s.article_id = x.article_id AND w.store_id = @storeId AND w.purpose = 'stock'), 0) AS stock,
                  COALESCE((SELECT sp.sale_price FROM store_prices sp WHERE sp.article_id = x.article_id AND sp.store_id = @storeId), a.sale_price) AS price
           FROM (${SELECT} WHERE m.store_id = @storeId AND m.phone IS NOT NULL AND m.notified_at IS NULL AND m.article_id IS NOT NULL AND m.created_at >= @since) x
           JOIN articles a ON a.id = x.article_id
         ) WHERE stock > 0 ORDER BY created_at`,
      )
      .all({ storeId, since }) as MissedToNotify[];
  }

  /** Le client a été prévenu (message WhatsApp envoyé ou appel). */
  markNotified(ctx: Context, id: string): MissedSale {
    const row = this.get(id);
    if (row.notified_at) return row;
    const now = this.now();
    this.tx(() => {
      this.db.prepare('UPDATE missed_sales SET notified_at = ?, notified_by = ?, updated_at = ? WHERE id = ? AND store_id = ?').run(now, ctx.userId, now, id, ctx.storeId);
      this.enqueue(ctx, 'missed_sale', id, 'upsert', {});
      this.audit(ctx.userId, 'missed.notified', 'missed_sale', id);
    });
    return this.get(id);
  }

  /** Quantités demandées sans être vendues, par article, depuis une date (pour la proposition de commande). */
  demandSince(storeId: string, since: string): Map<string, Milli> {
    const rows = this.db
      .prepare('SELECT article_id, SUM(qty) AS qty FROM missed_sales WHERE store_id = ? AND article_id IS NOT NULL AND created_at >= ? GROUP BY article_id')
      .all(storeId, since) as { article_id: string; qty: Milli }[];
    return new Map(rows.map((r) => [r.article_id, r.qty]));
  }
}

const SELECT = `SELECT m.id, m.article_id, a.code AS article_code, COALESCE(a.name, m.label) AS label, m.qty, m.reason, m.note,
                       u.name AS user_name, m.source, m.created_at, m.customer_name, m.phone, m.notified_at
                FROM missed_sales m LEFT JOIN articles a ON a.id = m.article_id LEFT JOIN users u ON u.id = m.user_id`;

const nextDay = (d: string) => new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

/** Numéro gardé en chiffres (8 à 15) ; null s'il est vide ou trop court. */
export function normalizePhone(raw: string | null | undefined): string | null {
  const d = (raw ?? '').replace(/\D/g, '');
  return d.length >= 8 && d.length <= 15 ? d : null;
}
