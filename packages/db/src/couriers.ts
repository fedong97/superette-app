import type { Fcfa } from '@superette/core';
import type { CustomerService } from './customers';
import type { Db } from './database';
import type { DeliveryRow, DeliveryService } from './deliveries';
import type { PosService } from './pos';
import { AppError, Base, type Clock, type Context, newId } from './util';

/** Retour d'un livreur : ce qu'il devait rapporter et ce qu'il a remis. */
export interface CourierReturn {
  id: string;
  number: string;
  store_id: string;
  courier: string;
  /** Total à encaisser des livraisons rendues. */
  expected: Fcfa;
  /** Espèces remises à la caisse. */
  returned: Fcfa;
  session_id: string | null;
  note: string | null;
  user_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface CourierReturnRow extends CourierReturn {
  /** Encaissé chez les clients d'après le livreur (le reste reste sur leur compte). */
  collected: Fcfa;
  /** Écart entre l'argent remis et l'encaissé : négatif quand il manque de l'argent. */
  difference: Fcfa;
  deliveries: number;
  user_name: string | null;
}

/** Feuille de route d'un livreur : ses livraisons à faire, adresse et montant à encaisser. */
export interface CourierSheet {
  courier: string;
  date: string;
  deliveries: DeliveryRow[];
  to_collect: Fcfa;
}

/**
 * Tournées des livreurs : la feuille de route à imprimer avant le départ, puis
 * le retour du livreur. Ce qu'il rapporte pour les livraisons à encaisser
 * entre dans la caisse ouverte comme règlement de chaque client ; l'écart entre
 * ce qu'il devait rapporter et ce qu'il remet reste noté.
 */
export class CourierService extends Base {
  constructor(
    db: Db,
    clock: Clock,
    private readonly deliveries: DeliveryService,
    private readonly customers: CustomerService,
    private readonly pos: PosService,
  ) {
    super(db, clock);
  }

  /** Livraisons du livreur pour le jour donné (pas encore livrées ou annulées). */
  sheet(storeId: string, courier: string, date: string): CourierSheet {
    const rows = this.deliveries.list(storeId, { open: true, to: date, courier }).filter((d) => d.sale_status === 'completed');
    return { courier, date, deliveries: rows, to_collect: rows.reduce((t, d) => t + d.to_collect, 0) };
  }

  /** Livraisons livrées par ce livreur qui attendent son retour à la caisse. */
  pending(storeId: string, courier?: string | null): DeliveryRow[] {
    return this.deliveries
      .list(storeId, { courier: courier ?? null })
      .filter((d) => d.status === 'delivered' && d.sale_status === 'completed' && !this.returnOf(d.id) && d.courier);
  }

  private returnOf(deliveryId: string): string | null {
    return (this.db.prepare('SELECT courier_return_id FROM sale_deliveries WHERE id = ?').pluck().get(deliveryId) as string | null) ?? null;
  }

  /**
   * Retour du livreur : pour chaque livraison, ce qu'il a encaissé chez le
   * client. Les montants entrent dans la caisse ouverte comme règlements des
   * comptes clients ; le total remis est comparé à ce qui était attendu.
   */
  settle(ctx: Context, input: { courier: string; deliveries: { id: string; collected: Fcfa }[]; returned: Fcfa; note?: string | null }): CourierReturn {
    const courier = input.courier?.trim();
    if (!courier) throw new AppError('Indiquez le livreur', 'INVALID');
    if (!input.deliveries.length) throw new AppError('Choisissez au moins une livraison', 'EMPTY');
    if (!Number.isSafeInteger(input.returned) || input.returned < 0) throw new AppError('Montant remis invalide', 'INVALID');
    const session = ctx.registerId ? this.pos.currentSession(ctx.registerId) : null;
    const collecting = input.deliveries.some((d) => d.collected > 0) || input.returned > 0;
    if (collecting && !session) throw new AppError("Ouvrez la caisse : l'argent du livreur entre dans le tiroir", 'NO_SESSION');
    const rows = new Map(this.deliveries.list(ctx.storeId, {}).map((d) => [d.id, d]));
    return this.tx(() => {
      let expected = 0;
      let collected = 0;
      const id = newId();
      const now = this.now();
      const number = `RL-${this.stationPrefix()}-${String(this.nextCounter('courier_return.number')).padStart(5, '0')}`;
      this.db
        .prepare(
          `INSERT INTO courier_returns (id, number, store_id, courier, expected, returned, session_id, note, user_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, number, ctx.storeId, courier, input.returned, session?.id ?? null, input.note?.trim().slice(0, 300) || null, ctx.userId, now, now);
      for (const it of input.deliveries) {
        const d = rows.get(it.id);
        if (!d) throw new AppError('Livraison introuvable', 'NOT_FOUND');
        if (d.status !== 'delivered') throw new AppError(`La livraison du ticket ${d.sale_number} n'est pas marquée livrée`, 'INVALID');
        if (this.returnOf(d.id)) throw new AppError(`La livraison du ticket ${d.sale_number} est déjà rendue`, 'INVALID');
        if (!Number.isSafeInteger(it.collected) || it.collected < 0) throw new AppError('Montant encaissé invalide', 'INVALID');
        if (it.collected > d.to_collect) throw new AppError(`Le ticket ${d.sale_number} n'a que ${d.to_collect} F à encaisser`, 'INVALID');
        expected += d.to_collect;
        collected += it.collected;
        if (it.collected > 0 && d.customer_id) {
          this.customers.receivePayment(ctx, {
            customerId: d.customer_id,
            method: 'CASH',
            amount: it.collected,
            sessionId: session?.id ?? null,
            notes: `Encaissé par ${courier} (livraison du ticket ${d.sale_number}, ${number})`,
          });
        }
        this.db.prepare('UPDATE sale_deliveries SET collected = ?, courier_return_id = ?, updated_at = ? WHERE id = ?').run(it.collected, id, now, d.id);
        this.enqueue(ctx, 'sale_delivery', d.id, 'upsert', {});
      }
      // Un manquant du livreur reste noté au retour et apparaît au Z ; un surplus n'a pas d'origine.
      if (input.returned > collected) throw new AppError('Le montant remis dépasse ce qui a été encaissé chez les clients', 'INVALID');
      this.db.prepare('UPDATE courier_returns SET expected = ? WHERE id = ?').run(expected, id);
      this.audit(ctx.userId, 'courier.return', 'courier_return', id, { courier, expected, collected, returned: input.returned });
      this.enqueue(ctx, 'courier_return', id, 'upsert', {});
      return this.get(id);
    });
  }

  get(id: string): CourierReturn {
    const r = this.db.prepare('SELECT * FROM courier_returns WHERE id = ?').get(id) as CourierReturn | undefined;
    if (!r) throw new AppError('Retour introuvable', 'NOT_FOUND');
    return r;
  }

  list(storeId: string, opts: { from?: string; to?: string } = {}): CourierReturnRow[] {
    return this.db
      .prepare(
        `SELECT r.*, COALESCE((SELECT SUM(d.collected) FROM sale_deliveries d WHERE d.courier_return_id = r.id), 0) AS collected,
                r.returned - COALESCE((SELECT SUM(d.collected) FROM sale_deliveries d WHERE d.courier_return_id = r.id), 0) AS difference, u.name AS user_name,
                (SELECT COUNT(*) FROM sale_deliveries d WHERE d.courier_return_id = r.id) AS deliveries
         FROM courier_returns r LEFT JOIN users u ON u.id = r.user_id
         WHERE r.store_id = @storeId AND (@from IS NULL OR date(r.created_at, 'localtime') >= @from) AND (@to IS NULL OR date(r.created_at, 'localtime') <= @to)
         ORDER BY r.created_at DESC LIMIT 500`,
      )
      .all({ storeId, from: opts.from ?? null, to: opts.to ?? null }) as CourierReturnRow[];
  }
}
