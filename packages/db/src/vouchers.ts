import { type Fcfa, type VoucherKind, VOUCHER_KINDS, formatFcfa, normalizeVoucherCode, voucherCode } from '@superette/core';
import type { AdminService } from './admin';
import type { Db } from './database';
import { AppError, Base, type Clock, type Context, newId } from './util';

export interface GiftVoucher {
  id: string;
  store_id: string;
  code: string;
  kind: VoucherKind;
  amount: Fcfa;
  expires_on: string | null;
  customer_id: string | null;
  customer_name: string | null;
  /** Nom écrit sur le bon (cadeau pour…), facultatif. */
  holder: string | null;
  /** Pièce « Encaisser » du bon vendu. */
  entry_id: string | null;
  /** Ticket d'où vient le bon (retour remboursé en bon, monnaie gardée). */
  sale_id: string | null;
  sale_number: string | null;
  user_name: string | null;
  status: 'active' | 'cancelled';
  cancel_reason: string | null;
  created_at: string;
  /** Calculé : déjà payé avec ce bon, et ce qui reste. */
  used: Fcfa;
  balance: Fcfa;
  /** Calculé : valable, épuisé, périmé, annulé (ou ticket d'origine annulé). */
  state: 'valid' | 'spent' | 'expired' | 'void';
}

export interface VoucherUse {
  sale_id: string;
  number: string;
  amount: Fcfa;
  user_name: string | null;
  at: string;
}

const SELECT = `SELECT v.*, c.name AS customer_name, s.number AS sale_number, u.name AS user_name,
    COALESCE((SELECT SUM(p.amount) FROM sale_payments p JOIN sales x ON x.id = p.sale_id
              WHERE p.method = 'VOUCHER' AND p.reference = v.code AND x.status = 'completed' AND x.kind = 'sale' AND p.amount > 0), 0) AS used,
    CASE WHEN v.sale_id IS NULL THEN 1 ELSE (SELECT s2.status = 'completed' FROM sales s2 WHERE s2.id = v.sale_id) END AS origin_ok,
    CASE WHEN v.entry_id IS NULL THEN 1 ELSE (SELECT e.status = 'active' FROM treasury_entries e WHERE e.id = v.entry_id) END AS entry_ok
  FROM gift_vouchers v LEFT JOIN customers c ON c.id = v.customer_id LEFT JOIN sales s ON s.id = v.sale_id LEFT JOIN users u ON u.id = v.user_id`;

type Row = Omit<GiftVoucher, 'balance' | 'state'> & { origin_ok: number | null; entry_ok: number | null };

/**
 * Bons d'achat suivis : chaque bon a un code (« BA » + 10 chiffres, imprimé en
 * code-barres), un montant, une date de validité et un solde. Le solde se
 * recalcule d'après les tickets payés avec le code : un bon épuisé, périmé ou
 * annulé est refusé à la caisse, et le même bon ne sert pas deux fois.
 */
export class VoucherService extends Base {
  constructor(
    db: Db,
    clock: Clock,
    private readonly admin: AdminService,
  ) {
    super(db, clock);
  }

  private shape(r: Row): GiftVoucher {
    const { origin_ok, entry_ok, ...v } = r;
    const balance = Math.max(0, v.amount - v.used);
    const state: GiftVoucher['state'] =
      v.status !== 'active' || !origin_ok || !entry_ok ? 'void' : balance <= 0 ? 'spent' : v.expires_on && v.expires_on < this.today() ? 'expired' : 'valid';
    return { ...v, balance, state };
  }

  get(id: string): GiftVoucher {
    const r = this.db.prepare(`${SELECT} WHERE v.id = ?`).get(id) as Row | undefined;
    if (!r) throw new AppError('Bon introuvable', 'NOT_FOUND');
    return this.shape(r);
  }

  byCode(code: string): GiftVoucher | null {
    const r = this.db.prepare(`${SELECT} WHERE v.code = ?`).get(code) as Row | undefined;
    return r ? this.shape(r) : null;
  }

  list(storeId: string, opts: { state?: GiftVoucher['state'] | null; search?: string | null; limit?: number } = {}): GiftVoucher[] {
    const q = opts.search?.trim() ? `%${opts.search.trim()}%` : null;
    return (
      this.db
        .prepare(`${SELECT} WHERE v.store_id = @storeId AND (@q IS NULL OR v.code LIKE @q OR v.holder LIKE @q OR c.name LIKE @q) ORDER BY v.created_at DESC LIMIT @limit`)
        .all({ storeId, q, limit: opts.limit ?? 1000 }) as Row[]
    )
      .map((r) => this.shape(r))
      .filter((v) => !opts.state || v.state === opts.state);
  }

  /** Tickets payés avec le bon. */
  uses(code: string): VoucherUse[] {
    return this.db
      .prepare(
        `SELECT s.id AS sale_id, s.number, p.amount, u.name AS user_name, s.created_at AS at FROM sale_payments p JOIN sales s ON s.id = p.sale_id
         LEFT JOIN users u ON u.id = s.user_id WHERE p.method = 'VOUCHER' AND p.reference = ? AND s.status = 'completed' AND s.kind = 'sale' AND p.amount > 0
         ORDER BY s.created_at`,
      )
      .all(code) as VoucherUse[];
  }

  /** Ce que vaut un code à la caisse : le bon, son solde et ce qui l'empêche de servir. */
  lookup(storeId: string, raw: string): { voucher: GiftVoucher; uses: VoucherUse[]; problem: string | null } {
    const code = normalizeVoucherCode(raw);
    if (!code) throw new AppError('Code de bon invalide : vérifiez les 12 caractères (BA et 10 chiffres)', 'INVALID');
    const v = this.byCode(code);
    if (!v) throw new AppError('Bon inconnu sur ce PC : il vient peut-être d’un autre magasin, ou il n’est pas encore synchronisé', 'NOT_FOUND');
    let problem: string | null = null;
    if (v.store_id !== storeId) problem = 'Ce bon a été émis par un autre magasin';
    else if (v.state === 'void') problem = 'Ce bon est annulé';
    else if (v.state === 'spent') problem = 'Ce bon est épuisé : il a déjà servi en entier';
    else if (v.state === 'expired') problem = `Ce bon a expiré le ${v.expires_on!.split('-').reverse().join('/')}`;
    return { voucher: v, uses: this.uses(code), problem };
  }

  /**
   * Contrôle des paiements « Bon d'achat » d'un ticket : un code du logiciel doit
   * être valable et couvrir le montant ; un bon papier d'avant (autre référence)
   * ne sert qu'une fois. Renvoie les références remises en forme.
   */
  checkPayments(storeId: string, payments: { method: string; amount: Fcfa; reference?: string | null }[]): void {
    const byRef = new Map<string, Fcfa>();
    for (const p of payments) {
      if (p.method !== 'VOUCHER' || p.amount <= 0) continue;
      const code = normalizeVoucherCode(p.reference) ?? p.reference?.trim() ?? '';
      byRef.set(code, (byRef.get(code) ?? 0) + p.amount);
    }
    for (const [ref, amount] of byRef) {
      if (normalizeVoucherCode(ref)) {
        const { voucher, problem } = this.lookup(storeId, ref);
        if (problem) throw new AppError(`${problem} (${voucher.code})`, 'VOUCHER_INVALID');
        if (amount > voucher.balance) throw new AppError(`Le bon ${voucher.code} n’a plus que ${formatFcfa(voucher.balance)}`, 'VOUCHER_INVALID');
      } else if (ref) {
        const used = this.db
          .prepare(
            `SELECT s.number, s.created_at FROM sale_payments p JOIN sales s ON s.id = p.sale_id
             WHERE p.method = 'VOUCHER' AND upper(replace(p.reference, ' ', '')) = upper(replace(?, ' ', '')) AND s.status = 'completed' AND s.kind = 'sale' AND s.store_id = ? LIMIT 1`,
          )
          .get(ref, storeId) as { number: string; created_at: string } | undefined;
        if (used) throw new AppError(`Le bon n° ${ref} a déjà servi (ticket ${used.number} du ${new Date(used.created_at).toLocaleDateString('fr-FR')})`, 'VOUCHER_USED');
      }
    }
  }

  /** Référence enregistrée sur le paiement : le code remis en forme. */
  normalize(reference: string | null | undefined): string | null {
    return normalizeVoucherCode(reference) ?? (reference?.trim() || null);
  }

  /** Nouveau code, jamais donné sur ce PC. */
  newCode(): string {
    for (;;) {
      const code = voucherCode();
      if (!this.db.prepare('SELECT 1 FROM gift_vouchers WHERE code = ?').get(code)) return code;
    }
  }

  /** Crée le bon (dans la transaction de la vente, du retour ou de l'encaissement). */
  issue(
    ctx: Context,
    input: { kind: VoucherKind; amount: Fcfa; code?: string; customerId?: string | null; holder?: string | null; entryId?: string | null; saleId?: string | null; validityDays?: number | null },
  ): GiftVoucher {
    if (!(input.kind in VOUCHER_KINDS)) throw new AppError('Sorte de bon inconnue', 'INVALID');
    if (!Number.isSafeInteger(input.amount) || input.amount <= 0) throw new AppError('Montant du bon invalide', 'INVALID');
    const days = input.validityDays ?? this.admin.storeSettings(ctx.storeId).voucherValidityDays;
    const expires = days > 0 ? new Date(Date.parse(`${this.today()}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10) : null;
    const id = newId();
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO gift_vouchers (id, store_id, code, kind, amount, expires_on, customer_id, holder, entry_id, sale_id, user_id, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      )
      .run(id, ctx.storeId, input.code ?? this.newCode(), input.kind, input.amount, expires, input.customerId ?? null, input.holder?.trim().slice(0, 80) || null, input.entryId ?? null, input.saleId ?? null, ctx.userId, now, now);
    this.enqueue(ctx, 'gift_voucher', id, 'upsert', {});
    this.audit(ctx.userId, 'voucher.issue', 'gift_voucher', id, { kind: input.kind, amount: input.amount });
    return this.get(id);
  }

  /** Bon annulé (vendu par erreur et remboursé) : il ne sert plus. */
  markCancelled(ctx: Context, id: string, reason: string): GiftVoucher {
    this.db.prepare("UPDATE gift_vouchers SET status = 'cancelled', cancel_reason = ?, updated_at = ? WHERE id = ?").run(reason, this.now(), id);
    this.enqueue(ctx, 'gift_voucher', id, 'upsert', {});
    this.audit(ctx.userId, 'voucher.cancel', 'gift_voucher', id, { reason });
    return this.get(id);
  }

  /** Bons encore valables du magasin : leur solde est une dette envers les clients (compte 4191). */
  outstanding(storeId: string): { count: number; total: Fcfa } {
    const valid = this.list(storeId, { state: 'valid', limit: 100_000 });
    return { count: valid.length, total: valid.reduce((t, v) => t + v.balance, 0) };
  }
}
