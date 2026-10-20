import type { Fcfa } from '@superette/core';
import { AppError, Base, type Context, newId } from './util';

/** Chèque reçu (vente ou règlement client) qui attend d'être remis en banque. */
export interface PendingCheque {
  source: 'sale' | 'customer_payment';
  payment_id: string;
  /** N° du ticket ou du reçu de règlement. */
  doc_number: string;
  amount: Fcfa;
  reference: string | null;
  drawer: string | null;
  received_at: string;
}

/** Chèque revenu impayé : il retourne au débit du client, avec les frais de la banque. */
export interface ChequeRejection {
  id: string;
  number: string;
  store_id: string;
  customer_id: string;
  customer_name: string;
  source: 'sale' | 'customer_payment';
  payment_id: string;
  doc_number: string;
  reference: string | null;
  amount: Fcfa;
  fees: Fcfa;
  deposited: number;
  rejected_on: string;
  reason: string | null;
  status: 'active' | 'cancelled';
  user_name: string | null;
  created_at: string;
}

/** Chèque reçu qui peut revenir impayé : remis en banque ou encore à remettre. */
export interface ReceivedCheque {
  source: 'sale' | 'customer_payment';
  payment_id: string;
  doc_number: string;
  amount: Fcfa;
  reference: string | null;
  customer_id: string | null;
  drawer: string | null;
  received_at: string;
  deposited: boolean;
}

export interface ChequeDeposit {
  id: string;
  number: string;
  store_id: string;
  deposit_date: string;
  bank: string | null;
  total: Fcfa;
  count: number;
  status: 'active' | 'cancelled';
  user_name: string | null;
  created_at: string;
}

export interface ChequeDepositDetail extends ChequeDeposit {
  lines: { line_no: number; source: PendingCheque['source']; payment_id: string; amount: Fcfa; reference: string | null; drawer: string | null; received_at: string }[];
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Bordereau de remise de chèques : les chèques reçus à la caisse ou au bureau
 * restent au compte 513 « Chèques à encaisser » ; le bordereau les remet en
 * banque en une seule écriture (521 / 513), facile à rapprocher du relevé.
 */
export class ChequeService extends Base {
  pending(storeId: string): PendingCheque[] {
    const deposited = `SELECT l.payment_id FROM cheque_deposit_lines l JOIN cheque_deposits d ON d.id = l.deposit_id WHERE d.status = 'active'
      UNION SELECT payment_id FROM cheque_rejections WHERE status = 'active'`;
    return this.db
      .prepare(
        `SELECT 'sale' AS source, p.id AS payment_id, s.number AS doc_number, p.amount, p.reference,
                COALESCE(c.name, s.client_name) AS drawer, s.created_at AS received_at
         FROM sale_payments p JOIN sales s ON s.id = p.sale_id LEFT JOIN customers c ON c.id = s.customer_id
         WHERE s.store_id = @storeId AND s.status = 'completed' AND p.method = 'CHEQUE' AND p.clearing = 1 AND p.id NOT IN (${deposited})
         UNION ALL
         SELECT 'customer_payment', p.id, p.number, p.amount, p.reference, c.name, p.paid_at
         FROM customer_payments p JOIN customers c ON c.id = p.customer_id
         WHERE p.store_id = @storeId AND p.method = 'CHEQUE' AND p.clearing = 1 AND p.id NOT IN (${deposited})
         ORDER BY received_at`,
      )
      .all({ storeId }) as PendingCheque[];
  }

  /** Bordereau des chèques choisis (tous ceux en attente sans choix), remis en banque à cette date. */
  create(ctx: Context, input: { date: string; bank?: string | null; paymentIds?: string[] }): ChequeDepositDetail {
    if (!DAY.test(input.date)) throw new AppError('Date de remise invalide', 'INVALID');
    this.assertPeriodOpen(ctx.storeId, input.date);
    const all = this.pending(ctx.storeId);
    const wanted = input.paymentIds ? new Set(input.paymentIds) : null;
    const cheques = wanted ? all.filter((c) => wanted.has(c.payment_id)) : all;
    if (wanted && cheques.length !== wanted.size) throw new AppError('Un des chèques est déjà remis en banque ou introuvable', 'INVALID');
    if (cheques.length === 0) throw new AppError('Aucun chèque à remettre en banque', 'EMPTY');
    const late = cheques.find((c) => c.received_at.slice(0, 10) > input.date);
    if (late) throw new AppError(`Le chèque ${late.reference ?? late.doc_number} a été reçu après la date de remise`, 'INVALID');
    const total = cheques.reduce((t, c) => t + c.amount, 0);
    return this.tx(() => {
      const id = newId();
      const now = this.now();
      const number = `RCH-${this.stationPrefix()}-${String(this.nextCounter('cheque_deposit.number')).padStart(5, '0')}`;
      this.db
        .prepare(
          `INSERT INTO cheque_deposits (id, number, store_id, deposit_date, bank, total, status, user_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
        )
        .run(id, number, ctx.storeId, input.date, input.bank?.trim() || null, total, ctx.userId, now, now);
      const insert = this.db.prepare(
        `INSERT INTO cheque_deposit_lines (id, deposit_id, line_no, source, payment_id, amount, reference, drawer, received_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      cheques.forEach((c, i) => insert.run(newId(), id, i + 1, c.source, c.payment_id, c.amount, c.reference, c.drawer, c.received_at));
      this.enqueue(ctx, 'cheque_deposit', id, 'upsert', {});
      this.audit(ctx.userId, 'cheque_deposit.create', 'cheque_deposit', id, { count: cheques.length, total });
      return this.get(id);
    });
  }

  /** Annule un bordereau (erreur, chèque refusé avant remise) : ses chèques redeviennent à remettre. */
  cancel(ctx: Context, id: string): ChequeDepositDetail {
    const d = this.get(id);
    if (d.store_id !== ctx.storeId) throw new AppError("Ce bordereau est d'un autre magasin", 'FORBIDDEN');
    if (d.status === 'cancelled') return d;
    this.assertPeriodOpen(ctx.storeId, d.deposit_date);
    const rejected = this.db
      .prepare("SELECT 1 FROM cheque_rejections x JOIN cheque_deposit_lines l ON l.payment_id = x.payment_id WHERE l.deposit_id = ? AND x.status = 'active'")
      .get(id);
    if (rejected) throw new AppError("Un chèque de ce bordereau est revenu impayé : annulez d'abord l'impayé", 'INVALID');
    this.tx(() => {
      this.db.prepare("UPDATE cheque_deposits SET status = 'cancelled', updated_at = ? WHERE id = ?").run(this.now(), id);
      this.enqueue(ctx, 'cheque_deposit', id, 'upsert', {});
      this.audit(ctx.userId, 'cheque_deposit.cancel', 'cheque_deposit', id, { number: d.number });
    });
    return this.get(id);
  }

  /** Chèques reçus (90 derniers jours par défaut) qui ne sont pas déjà revenus impayés. */
  received(storeId: string, opts: { since?: string | null } = {}): ReceivedCheque[] {
    const since = opts.since ?? new Date(this.clock().getTime() - 90 * 86_400_000).toISOString().slice(0, 10);
    const rows = this.db
      .prepare(
        `SELECT 'sale' AS source, p.id AS payment_id, s.number AS doc_number, p.amount, p.reference, s.customer_id, COALESCE(c.name, s.client_name) AS drawer,
                s.created_at AS received_at, p.clearing
         FROM sale_payments p JOIN sales s ON s.id = p.sale_id LEFT JOIN customers c ON c.id = s.customer_id
         WHERE s.store_id = @storeId AND s.status = 'completed' AND p.method = 'CHEQUE' AND date(s.created_at, 'localtime') >= @since
         UNION ALL
         SELECT 'customer_payment', p.id, p.number, p.amount, p.reference, p.customer_id, c.name, p.paid_at, p.clearing
         FROM customer_payments p JOIN customers c ON c.id = p.customer_id
         WHERE p.store_id = @storeId AND p.method = 'CHEQUE' AND date(p.paid_at, 'localtime') >= @since
         ORDER BY received_at DESC`,
      )
      .all({ storeId, since }) as (Omit<ReceivedCheque, 'deposited'> & { clearing: number })[];
    const rejected = new Set(this.db.prepare("SELECT payment_id FROM cheque_rejections WHERE status = 'active'").pluck().all() as string[]);
    return rows.filter((r) => !rejected.has(r.payment_id)).map(({ clearing, ...r }) => ({ ...r, deposited: !clearing || this.isDeposited(r.payment_id) }));
  }

  private isDeposited(paymentId: string): boolean {
    return Boolean(
      this.db.prepare("SELECT 1 FROM cheque_deposit_lines l JOIN cheque_deposits d ON d.id = l.deposit_id WHERE l.payment_id = ? AND d.status = 'active'").get(paymentId),
    );
  }

  /**
   * Chèque revenu impayé : il est remis au débit du client (avec les frais que
   * la banque a prélevés) et, au choix, le client ne paie plus par chèque.
   * Un chèque de client comptoir est rattaché au client choisi.
   */
  reject(
    ctx: Context,
    input: { paymentId: string; date: string; fees?: Fcfa; reason?: string | null; customerId?: string | null; blockCheques?: boolean },
  ): ChequeRejection {
    if (!DAY.test(input.date)) throw new AppError('Date du rejet invalide', 'INVALID');
    this.assertPeriodOpen(ctx.storeId, input.date);
    const fees = input.fees ?? 0;
    if (!Number.isSafeInteger(fees) || fees < 0) throw new AppError('Frais invalides', 'INVALID');
    const all = this.received(ctx.storeId, { since: '0000-01-01' });
    const ch = all.find((c) => c.payment_id === input.paymentId);
    if (!ch) throw new AppError('Chèque introuvable ou déjà revenu impayé', 'NOT_FOUND');
    if (ch.received_at.slice(0, 10) > input.date) throw new AppError('Le rejet ne peut pas précéder la réception du chèque', 'INVALID');
    const customerId = ch.customer_id ?? input.customerId ?? null;
    if (!customerId) throw new AppError('Chèque d’un client comptoir : choisissez le client à qui le réclamer', 'INVALID');
    if (!this.db.prepare('SELECT 1 FROM customers WHERE id = ?').get(customerId)) throw new AppError('Client introuvable', 'NOT_FOUND');
    return this.tx(() => {
      const id = newId();
      const now = this.now();
      const number = `CI-${this.stationPrefix()}-${String(this.nextCounter('cheque_rejection.number')).padStart(5, '0')}`;
      this.db
        .prepare(
          `INSERT INTO cheque_rejections (id, number, store_id, customer_id, source, payment_id, doc_number, reference, amount, fees, deposited, rejected_on, reason, status, user_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
        )
        .run(id, number, ctx.storeId, customerId, ch.source, ch.payment_id, ch.doc_number, ch.reference, ch.amount, fees, ch.deposited ? 1 : 0, input.date, input.reason?.trim() || null, ctx.userId, now, now);
      this.enqueue(ctx, 'cheque_rejection', id, 'upsert', {});
      if (input.blockCheques) {
        this.db.prepare('UPDATE customers SET no_cheque = 1, updated_at = ? WHERE id = ?').run(now, customerId);
        this.enqueue(null, 'customer', customerId, 'upsert', {});
      }
      this.audit(ctx.userId, 'cheque.reject', 'cheque_rejection', id, { amount: ch.amount, fees, payment: ch.payment_id, block: Boolean(input.blockCheques) });
      return this.getRejection(id);
    });
  }

  /** Annule un impayé saisi par erreur : le chèque redevient bon. */
  cancelRejection(ctx: Context, id: string): ChequeRejection {
    const x = this.getRejection(id);
    if (x.store_id !== ctx.storeId) throw new AppError("Cet impayé est d'un autre magasin", 'FORBIDDEN');
    if (x.status === 'cancelled') return x;
    this.assertPeriodOpen(ctx.storeId, x.rejected_on);
    this.tx(() => {
      this.db.prepare("UPDATE cheque_rejections SET status = 'cancelled', updated_at = ? WHERE id = ?").run(this.now(), id);
      this.enqueue(ctx, 'cheque_rejection', id, 'upsert', {});
      this.audit(ctx.userId, 'cheque.reject_cancel', 'cheque_rejection', id, { number: x.number });
    });
    return this.getRejection(id);
  }

  rejections(storeId: string): ChequeRejection[] {
    return this.rejectionQuery('x.store_id = ?').all(storeId) as ChequeRejection[];
  }

  getRejection(id: string): ChequeRejection {
    const x = this.rejectionQuery('x.id = ?').get(id) as ChequeRejection | undefined;
    if (!x) throw new AppError('Impayé introuvable', 'NOT_FOUND');
    return x;
  }

  private rejectionQuery(where: string) {
    return this.db.prepare(
      `SELECT x.id, x.number, x.store_id, x.customer_id, c.name AS customer_name, x.source, x.payment_id, x.doc_number, x.reference, x.amount, x.fees, x.deposited,
              x.rejected_on, x.reason, x.status, u.name AS user_name, x.created_at
       FROM cheque_rejections x JOIN customers c ON c.id = x.customer_id LEFT JOIN users u ON u.id = x.user_id
       WHERE ${where} ORDER BY x.rejected_on DESC, x.number DESC LIMIT 500`,
    );
  }

  list(storeId: string): ChequeDeposit[] {
    return this.query('d.store_id = @storeId', 300).all({ storeId }) as ChequeDeposit[];
  }

  get(id: string): ChequeDepositDetail {
    const head = this.query('d.id = @id', 1).get({ id }) as ChequeDeposit | undefined;
    if (!head) throw new AppError('Bordereau introuvable', 'NOT_FOUND');
    const lines = this.db
      .prepare('SELECT line_no, source, payment_id, amount, reference, drawer, received_at FROM cheque_deposit_lines WHERE deposit_id = ? ORDER BY line_no')
      .all(id) as ChequeDepositDetail['lines'];
    return { ...head, lines };
  }

  private query(where: string, limit: number) {
    return this.db.prepare(
      `SELECT d.id, d.number, d.store_id, d.deposit_date, d.bank, d.total, d.status, u.name AS user_name, d.created_at,
              (SELECT COUNT(*) FROM cheque_deposit_lines l WHERE l.deposit_id = d.id) AS count
       FROM cheque_deposits d LEFT JOIN users u ON u.id = d.user_id WHERE ${where} ORDER BY d.deposit_date DESC, d.number DESC LIMIT ${limit}`,
    );
  }
}
