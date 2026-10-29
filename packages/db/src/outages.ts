import type { Fcfa } from '@superette/core';
import { AppError, Base, type Context, newId } from './util';

/**
 * Coupure (courant, panne du PC) : le caissier a vendu à la main. Il déclare la
 * coupure avec le total noté sur le cahier, puis saisit les ventes une à une ;
 * ONIX compare ce qui est saisi au total déclaré et signale l'écart au gérant.
 */
export interface Outage {
  id: string;
  number: string;
  store_id: string;
  register_id: string | null;
  register_name: string | null;
  started_at: string;
  ended_at: string;
  declared_total: Fcfa;
  note: string | null;
  status: 'open' | 'closed' | 'cancelled';
  /** Ventes saisies pour cette coupure (en cours, ou figé à la clôture). */
  entered_total: Fcfa;
  sales: number;
  /** Total déclaré moins ventes saisies : positif, il manque des ventes ; négatif, il y en a trop. */
  gap: Fcfa;
  gap_reason: string | null;
  user_name: string | null;
  closed_by_name: string | null;
  closed_at: string | null;
  created_at: string;
}

const STATUS_LABEL = { open: 'en cours de saisie', closed: 'clôturée', cancelled: 'annulée' } as const;

export class OutageService extends Base {
  private query(where: string, ...args: unknown[]): Outage[] {
    const rows = this.db
      .prepare(
        `SELECT o.id, o.number, o.store_id, o.register_id, r.name AS register_name, o.started_at, o.ended_at, o.declared_total, o.note, o.status,
           o.entered_total AS frozen, o.gap AS frozen_gap, o.gap_reason, u.name AS user_name, c.name AS closed_by_name, o.closed_at, o.created_at,
           (SELECT COALESCE(SUM(s.total_ttc), 0) FROM sales s WHERE s.outage_id = o.id AND s.status = 'completed') AS live,
           (SELECT COUNT(*) FROM sales s WHERE s.outage_id = o.id AND s.status = 'completed') AS sales
         FROM outages o LEFT JOIN registers r ON r.id = o.register_id LEFT JOIN users u ON u.id = o.user_id LEFT JOIN users c ON c.id = o.closed_by ${where}`,
      )
      .all(...args) as (Omit<Outage, 'entered_total' | 'gap'> & { frozen: Fcfa | null; frozen_gap: Fcfa | null; live: Fcfa })[];
    return rows.map(({ frozen, frozen_gap, live, ...o }) => {
      const entered = o.status === 'closed' && frozen !== null ? frozen : live;
      return { ...o, entered_total: entered, gap: o.status === 'closed' && frozen_gap !== null ? frozen_gap : o.declared_total - entered };
    });
  }

  list(storeId: string, opts: { status?: Outage['status'] | null; limit?: number } = {}): Outage[] {
    return this.query('WHERE o.store_id = ? AND (? IS NULL OR o.status = ?) ORDER BY o.started_at DESC LIMIT ?', storeId, opts.status ?? null, opts.status ?? null, opts.limit ?? 100);
  }

  get(id: string): Outage {
    const o = this.query('WHERE o.id = ?', id)[0];
    if (!o) throw new AppError('Coupure introuvable', 'NOT_FOUND');
    return o;
  }

  /** Coupure en cours de saisie sur cette caisse, s'il y en a une. */
  openFor(ctx: Context): Outage | null {
    return this.query("WHERE o.store_id = ? AND o.status = 'open' AND (o.register_id IS ? OR o.register_id = ?) ORDER BY o.created_at DESC LIMIT 1", ctx.storeId, ctx.registerId, ctx.registerId)[0] ?? null;
  }

  declare(ctx: Context, input: { startedAt: string; endedAt: string; declaredTotal: Fcfa; note?: string | null }): Outage {
    if (!ctx.registerId) throw new AppError("Ce poste n'est pas activé comme caisse", 'NO_REGISTER');
    const start = new Date(input.startedAt);
    const end = new Date(input.endedAt);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) throw new AppError('Indiquez le début et la fin de la coupure', 'INVALID');
    if (end <= start) throw new AppError('La fin de la coupure est avant son début', 'INVALID');
    const now = this.clock().getTime();
    if (end.getTime() > now + 60_000) throw new AppError('La fin de la coupure est dans le futur', 'INVALID');
    if (start.getTime() < now - 7 * 86_400_000) throw new AppError('Une coupure se saisit dans les 7 jours', 'INVALID');
    const total = Math.floor(Number(input.declaredTotal));
    if (!Number.isSafeInteger(total) || total <= 0) throw new AppError('Indiquez le total noté sur le cahier pendant la coupure', 'INVALID');
    const open = this.openFor(ctx);
    if (open) throw new AppError(`La coupure n° ${open.number} est encore en cours de saisie : clôturez-la d'abord`, 'INVALID');
    const overlap = this.db
      .prepare("SELECT number FROM outages WHERE store_id = ? AND register_id = ? AND status <> 'cancelled' AND started_at < ? AND ended_at > ? LIMIT 1")
      .pluck()
      .get(ctx.storeId, ctx.registerId, end.toISOString(), start.toISOString()) as string | undefined;
    if (overlap) throw new AppError(`Cette période est déjà couverte par la coupure n° ${overlap}`, 'DUPLICATE');
    const id = newId();
    this.tx(() => {
      const at = this.now();
      const number = this.docNumber('outages', `outage:${ctx.storeId}`, ctx.storeId);
      this.db
        .prepare(
          `INSERT INTO outages (id, number, store_id, register_id, started_at, ended_at, declared_total, note, status, user_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)`,
        )
        .run(id, number, ctx.storeId, ctx.registerId, start.toISOString(), end.toISOString(), total, input.note?.trim().slice(0, 200) || null, ctx.userId, at, at);
      this.enqueue(ctx, 'outage', id, 'upsert', {});
      this.audit(ctx.userId, 'outage.declare', 'outage', id, { number, declared: total, from: start.toISOString(), to: end.toISOString() });
    });
    return this.get(id);
  }

  /**
   * Vente saisie pour une coupure : la coupure est en cours de saisie, du
   * magasin, et l'heure de la vente tombe pendant la coupure (son début sinon).
   */
  forSale(ctx: Context, outageId: string, at?: string | null): { id: string; at: string } {
    const o = this.get(outageId);
    if (o.store_id !== ctx.storeId) throw new AppError("Cette coupure n'est pas celle de ce magasin", 'INVALID');
    if (o.status !== 'open') throw new AppError(`La coupure n° ${o.number} est ${STATUS_LABEL[o.status]} : plus de vente à y saisir`, 'INVALID');
    const when = at ? new Date(at) : new Date(o.started_at);
    if (Number.isNaN(when.getTime())) throw new AppError('Heure de la vente invalide', 'INVALID');
    if (when.toISOString() < o.started_at || when.toISOString() > o.ended_at) throw new AppError("L'heure de la vente doit tomber pendant la coupure", 'INVALID');
    return { id: o.id, at: when.toISOString() };
  }

  /**
   * Clôture : le total saisi est figé et comparé au total déclaré. Un écart
   * demande un motif ; l'écran demande le code du gérant si le caissier n'a pas
   * le droit de clôturer une coupure avec écart.
   */
  close(ctx: Context, id: string, opts: { reason?: string | null; closedBy?: string | null } = {}): Outage {
    const o = this.get(id);
    if (o.store_id !== ctx.storeId) throw new AppError("Cette coupure n'est pas celle de ce magasin", 'INVALID');
    if (o.status !== 'open') throw new AppError(`La coupure n° ${o.number} est déjà ${STATUS_LABEL[o.status]}`, 'INVALID');
    if (o.sales === 0) throw new AppError("Aucune vente n'est saisie pour cette coupure : saisissez-les, ou annulez la coupure", 'INVALID');
    const reason = opts.reason?.trim().slice(0, 200) || null;
    if (o.gap !== 0 && !reason) {
      throw new AppError(`${o.gap > 0 ? 'Il manque' : 'Il y a en trop'} ${Math.abs(o.gap).toLocaleString('fr-FR')} FCFA de ventes par rapport au cahier : indiquez le motif de l'écart`, 'REASON_REQUIRED');
    }
    this.tx(() => {
      const at = this.now();
      this.db
        .prepare("UPDATE outages SET status = 'closed', entered_total = ?, gap = ?, gap_reason = ?, closed_by = ?, closed_at = ?, updated_at = ? WHERE id = ?")
        .run(o.entered_total, o.gap, reason, opts.closedBy ?? ctx.userId, at, at, id);
      this.enqueue(ctx, 'outage', id, 'upsert', {});
      this.audit(ctx.userId, 'outage.close', 'outage', id, { number: o.number, declared: o.declared_total, entered: o.entered_total, gap: o.gap, reason, by: opts.closedBy ?? ctx.userId });
    });
    return this.get(id);
  }

  /** Coupure déclarée par erreur : annulable tant qu'aucune vente n'y est saisie. */
  cancel(ctx: Context, id: string): Outage {
    const o = this.get(id);
    if (o.status !== 'open') throw new AppError(`La coupure n° ${o.number} est déjà ${STATUS_LABEL[o.status]}`, 'INVALID');
    if (o.sales > 0) throw new AppError(`${o.sales} vente(s) sont déjà saisies pour cette coupure : clôturez-la plutôt`, 'INVALID');
    this.tx(() => {
      this.db.prepare("UPDATE outages SET status = 'cancelled', closed_by = ?, closed_at = ?, updated_at = ? WHERE id = ?").run(ctx.userId, this.now(), this.now(), id);
      this.enqueue(ctx, 'outage', id, 'upsert', {});
      this.audit(ctx.userId, 'outage.cancel', 'outage', id, { number: o.number });
    });
    return this.get(id);
  }
}
