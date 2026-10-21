import type { Db } from './database';
import type { PosService } from './pos';
import { AppError, Base, type Clock, type Context, newId } from './util';

export type EditRequestStatus = 'pending' | 'approved' | 'rejected' | 'used';

export const EDIT_REQUEST_STATUS: Record<EditRequestStatus, string> = {
  pending: 'En attente',
  approved: 'Accordée',
  rejected: 'Refusée',
  used: 'Facture modifiée',
};

export interface SaleEditRequest {
  id: string;
  number: string;
  store_id: string;
  sale_id: string;
  sale_number: string;
  sale_total: number;
  customer_name: string | null;
  requested_by: string;
  requester_name: string | null;
  reason: string;
  status: EditRequestStatus;
  decided_by: string | null;
  decider_name: string | null;
  decided_at: string | null;
  decision_note: string | null;
  new_sale_id: string | null;
  new_sale_number: string | null;
  created_at: string;
}

/**
 * Demande de modification d'une facture validée : le vendeur sans le droit
 * « Modifier une facture » la demande avec un motif, le gérant l'accorde ou la
 * refuse. Accordée, elle permet une seule modification de cette facture, par
 * celui qui l'a demandée ; l'ancienne facture reste dans le registre, annulée
 * et reliée à la nouvelle.
 */
export class SaleEditRequestService extends Base {
  constructor(
    db: Db,
    clock: Clock,
    private readonly pos: PosService,
  ) {
    super(db, clock);
  }

  request(ctx: Context, saleId: string, reason: string): SaleEditRequest {
    const sale = this.pos.getSale(saleId);
    if (sale.store_id !== ctx.storeId) throw new AppError("Cette facture est d'un autre magasin", 'FORBIDDEN');
    const why = reason.trim();
    if (why.length < 3) throw new AppError('Expliquez ce qu’il faut changer sur la facture', 'REASON_REQUIRED');
    // La facture doit encore pouvoir se modifier (journée ouverte, pas de retour).
    this.pos.editableSale(saleId);
    const open = this.db
      .prepare("SELECT number FROM sale_edit_requests WHERE sale_id = ? AND requested_by = ? AND status IN ('pending', 'approved')")
      .pluck()
      .get(saleId, ctx.userId) as string | undefined;
    if (open) throw new AppError(`Une demande est déjà en cours pour cette facture (${open})`, 'DUPLICATE');
    return this.tx(() => {
      const id = newId();
      const now = this.now();
      const number = `DM-${this.stationPrefix()}-${String(this.nextCounter('sale_edit_request.number')).padStart(5, '0')}`;
      this.db
        .prepare(
          `INSERT INTO sale_edit_requests (id, number, store_id, sale_id, requested_by, reason, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
        )
        .run(id, number, ctx.storeId, saleId, ctx.userId, why, now, now);
      this.enqueue(ctx, 'sale_edit_request', id, 'upsert', {});
      this.audit(ctx.userId, 'sale.edit_request', 'sale', saleId, { number, sale: sale.number, reason: why });
      return this.get(id);
    });
  }

  /** Le gérant accorde ou refuse ; il ne décide jamais de sa propre demande. */
  decide(ctx: Context, id: string, approve: boolean, note?: string | null): SaleEditRequest {
    const r = this.get(id);
    if (r.store_id !== ctx.storeId) throw new AppError("Cette demande est d'un autre magasin", 'FORBIDDEN');
    if (r.status !== 'pending') throw new AppError(`Cette demande est déjà traitée (${EDIT_REQUEST_STATUS[r.status].toLowerCase()})`, 'INVALID');
    if (r.requested_by === ctx.userId) throw new AppError('Une demande se fait accorder par un autre utilisateur', 'FORBIDDEN');
    if (!approve && !note?.trim()) throw new AppError('Indiquez pourquoi la demande est refusée', 'REASON_REQUIRED');
    return this.tx(() => {
      const now = this.now();
      this.db
        .prepare('UPDATE sale_edit_requests SET status = ?, decided_by = ?, decided_at = ?, decision_note = ?, updated_at = ? WHERE id = ?')
        .run(approve ? 'approved' : 'rejected', ctx.userId, now, note?.trim() || null, now, id);
      this.enqueue(ctx, 'sale_edit_request', id, 'upsert', {});
      this.audit(ctx.userId, approve ? 'sale.edit_request.approve' : 'sale.edit_request.reject', 'sale', r.sale_id, { number: r.number, sale: r.sale_number, note: note?.trim() || null });
      return this.get(id);
    });
  }

  /** Demande accordée et pas encore utilisée qui permet à cet utilisateur de modifier cette facture. */
  granted(userId: string, saleId: string): SaleEditRequest | null {
    const id = this.db
      .prepare("SELECT id FROM sale_edit_requests WHERE sale_id = ? AND requested_by = ? AND status = 'approved' ORDER BY decided_at DESC LIMIT 1")
      .pluck()
      .get(saleId, userId) as string | undefined;
    return id ? this.get(id) : null;
  }

  /** La modification accordée vient d'être faite : la demande ne resservira pas. */
  markUsed(ctx: Context, id: string, newSaleId: string): void {
    this.tx(() => {
      this.db.prepare("UPDATE sale_edit_requests SET status = 'used', new_sale_id = ?, updated_at = ? WHERE id = ? AND status = 'approved'").run(newSaleId, this.now(), id);
      this.enqueue(ctx, 'sale_edit_request', id, 'upsert', {});
    });
  }

  get(id: string): SaleEditRequest {
    const row = this.query('r.id = @id').get({ id }) as SaleEditRequest | undefined;
    if (!row) throw new AppError('Demande introuvable', 'NOT_FOUND');
    return row;
  }

  list(storeId: string, opts: { status?: EditRequestStatus | null; requestedBy?: string | null } = {}): SaleEditRequest[] {
    return this.query('r.store_id = @storeId AND (@status IS NULL OR r.status = @status) AND (@by IS NULL OR r.requested_by = @by)').all({
      storeId,
      status: opts.status ?? null,
      by: opts.requestedBy ?? null,
    }) as SaleEditRequest[];
  }

  private query(where: string) {
    return this.db.prepare(
      `SELECT r.id, r.number, r.store_id, r.sale_id, s.number AS sale_number, s.total_ttc AS sale_total,
              COALESCE(c.name, s.client_name) AS customer_name, r.requested_by, u.name AS requester_name, r.reason, r.status,
              r.decided_by, d.name AS decider_name, r.decided_at, r.decision_note, r.new_sale_id, n.number AS new_sale_number, r.created_at
       FROM sale_edit_requests r JOIN sales s ON s.id = r.sale_id LEFT JOIN customers c ON c.id = s.customer_id
       LEFT JOIN users u ON u.id = r.requested_by LEFT JOIN users d ON d.id = r.decided_by LEFT JOIN sales n ON n.id = r.new_sale_id
       WHERE ${where} ORDER BY r.status = 'pending' DESC, r.created_at DESC LIMIT 300`,
    );
  }
}
