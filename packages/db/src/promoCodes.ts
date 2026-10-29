import { type Fcfa, normalizePromoCode, promoCodeAmount } from '@superette/core';
import { AppError, Base, newId } from './util';

/** Code de réduction distribué aux clients (WhatsApp, flyer, radio), donné à la caisse. */
export interface PromoCode {
  id: string;
  code: string;
  label: string;
  kind: 'percent' | 'amount';
  /** % (1 à 100) ou montant en FCFA. */
  value: number;
  /** Ticket minimum (avant le code) ; 0 : sans minimum. */
  min_total: Fcfa;
  starts_on: string | null;
  ends_on: string | null;
  /** Nombre d'utilisations au plus, tous clients confondus ; null : sans limite. */
  max_uses: number | null;
  /** Une seule fois par client (il faut alors choisir le client). */
  once_per_customer: number;
  /** Magasin où il vaut ; null : tous les magasins. */
  store_id: string | null;
  store_name: string | null;
  active: number;
  /** Tickets qui l'ont utilisé, et la remise totale accordée. */
  uses: number;
  discount: Fcfa;
  /** Chiffre d'affaires des tickets qui l'ont utilisé. */
  revenue: Fcfa;
}

export interface PromoCodeInput {
  code: string;
  label: string;
  kind: 'percent' | 'amount';
  value: number;
  minTotal?: Fcfa;
  startsOn?: string | null;
  endsOn?: string | null;
  maxUses?: number | null;
  oncePerCustomer?: boolean;
  storeId?: string | null;
  active?: boolean;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Codes de réduction. La remise du code s'ajoute à celles du ticket, répartie
 * sur ses lignes ; la vente garde le code et son montant pour le rapport.
 */
export class PromoCodeService extends Base {
  private query(where: string, ...args: unknown[]): PromoCode[] {
    return this.db
      .prepare(
        `SELECT p.id, p.code, p.label, p.kind, p.value, p.min_total, p.starts_on, p.ends_on, p.max_uses, p.once_per_customer, p.store_id, st.name AS store_name, p.active,
           (SELECT COUNT(*) FROM sales s WHERE s.promo_code = p.code AND s.kind = 'sale' AND s.status = 'completed') AS uses,
           (SELECT COALESCE(SUM(s.promo_code_discount), 0) FROM sales s WHERE s.promo_code = p.code AND s.kind = 'sale' AND s.status = 'completed') AS discount,
           (SELECT COALESCE(SUM(s.total_ttc), 0) FROM sales s WHERE s.promo_code = p.code AND s.kind = 'sale' AND s.status = 'completed') AS revenue
         FROM promo_codes p LEFT JOIN stores st ON st.id = p.store_id ${where}`,
      )
      .all(...args) as PromoCode[];
  }

  list(includeInactive = true): PromoCode[] {
    return this.query(`WHERE (? = 1 OR p.active = 1) ORDER BY p.active DESC, p.created_at DESC`, includeInactive ? 1 : 0);
  }

  get(id: string): PromoCode {
    const code = this.query('WHERE p.id = ?', id)[0];
    if (!code) throw new AppError('Code de réduction introuvable', 'NOT_FOUND');
    return code;
  }

  save(userId: string, input: PromoCodeInput, id?: string | null): PromoCode {
    const code = normalizePromoCode(input.code);
    if (code.length < 3 || code.length > 20) throw new AppError('Le code fait de 3 à 20 lettres ou chiffres (exemple : NOEL25)', 'INVALID');
    const label = input.label?.trim().replace(/\s+/g, ' ').slice(0, 80);
    if (!label) throw new AppError('Donnez un libellé au code (exemple : Flyer de Noël)', 'INVALID');
    if (input.kind !== 'percent' && input.kind !== 'amount') throw new AppError('Type de remise invalide', 'INVALID');
    const value = Math.floor(Number(input.value));
    if (!Number.isSafeInteger(value) || value <= 0) throw new AppError('Indiquez la remise du code', 'INVALID');
    if (input.kind === 'percent' && value > 100) throw new AppError('La remise ne dépasse pas 100 %', 'INVALID');
    const minTotal = Math.max(0, Math.floor(input.minTotal ?? 0));
    const startsOn = input.startsOn || null;
    const endsOn = input.endsOn || null;
    for (const d of [startsOn, endsOn]) if (d && !DATE.test(d)) throw new AppError('Date invalide', 'INVALID');
    if (startsOn && endsOn && endsOn < startsOn) throw new AppError('La fin est avant le début', 'INVALID');
    const maxUses = input.maxUses ? Math.floor(input.maxUses) : null;
    if (maxUses !== null && maxUses <= 0) throw new AppError("Nombre d'utilisations invalide", 'INVALID');
    const twin = this.db.prepare('SELECT id FROM promo_codes WHERE code = ? AND id <> ?').pluck().get(code, id ?? '') as string | undefined;
    if (twin) throw new AppError(`Le code ${code} existe déjà`, 'DUPLICATE');
    const codeId = id ?? newId();
    const before = id ? this.get(id) : null;
    // Un code déjà utilisé ne change plus de nom : les ventes le retrouvent par son code.
    if (before && before.uses > 0 && before.code !== code) throw new AppError(`Le code ${before.code} a déjà servi : créez-en un nouveau plutôt que de le renommer`, 'INVALID');
    this.tx(() => {
      const now = this.now();
      this.db
        .prepare(
          `INSERT INTO promo_codes (id, code, label, kind, value, min_total, starts_on, ends_on, max_uses, once_per_customer, store_id, active, created_by, created_at, updated_at)
           VALUES (@id, @code, @label, @kind, @value, @minTotal, @startsOn, @endsOn, @maxUses, @once, @storeId, @active, @userId, @now, @now)
           ON CONFLICT(id) DO UPDATE SET code = @code, label = @label, kind = @kind, value = @value, min_total = @minTotal, starts_on = @startsOn, ends_on = @endsOn,
             max_uses = @maxUses, once_per_customer = @once, store_id = @storeId, active = @active, updated_at = @now`,
        )
        .run({
          id: codeId,
          code,
          label,
          kind: input.kind,
          value,
          minTotal,
          startsOn,
          endsOn,
          maxUses,
          once: input.oncePerCustomer ? 1 : 0,
          storeId: input.storeId || null,
          active: input.active === false ? 0 : 1,
          userId,
          now,
        });
      this.enqueue(null, 'promo_code', codeId, 'upsert', {});
      this.audit(userId, before ? 'promo_code.update' : 'promo_code.create', 'promo_code', codeId, { code, kind: input.kind, value });
    });
    return this.get(codeId);
  }

  setActive(userId: string, id: string, active: boolean): PromoCode {
    const code = this.get(id);
    this.tx(() => {
      this.db.prepare('UPDATE promo_codes SET active = ?, updated_at = ? WHERE id = ?').run(active ? 1 : 0, this.now(), id);
      this.enqueue(null, 'promo_code', id, 'upsert', {});
      this.audit(userId, active ? 'promo_code.enable' : 'promo_code.disable', 'promo_code', id, { code: code.code });
    });
    return this.get(id);
  }

  /**
   * Remise d'un code sur un ticket, ou la raison du refus. Le sous-total est
   * celui du ticket après promotions et remises, hors frais de livraison.
   */
  check(storeId: string, raw: string, subtotal: Fcfa, customerId: string | null): { code: PromoCode; amount: Fcfa } {
    const wanted = normalizePromoCode(raw);
    if (!wanted) throw new AppError('Tapez le code de réduction', 'INVALID');
    const code = this.query('WHERE p.code = ?', wanted)[0];
    if (!code || !code.active) throw new AppError(`Le code ${wanted} n'existe pas ou n'est plus actif`, 'PROMO_CODE');
    if (code.store_id && code.store_id !== storeId) throw new AppError(`Le code ${wanted} ne vaut pas dans ce magasin`, 'PROMO_CODE');
    const today = this.today();
    const fr = (d: string) => d.split('-').reverse().join('/');
    if (code.starts_on && today < code.starts_on) throw new AppError(`Le code ${wanted} vaut à partir du ${fr(code.starts_on)}`, 'PROMO_CODE');
    if (code.ends_on && today > code.ends_on) throw new AppError(`Le code ${wanted} a expiré le ${fr(code.ends_on)}`, 'PROMO_CODE');
    if (code.max_uses !== null && code.uses >= code.max_uses) throw new AppError(`Le code ${wanted} a déjà servi ${code.max_uses} fois : il est épuisé`, 'PROMO_CODE');
    if (code.min_total > 0 && subtotal < code.min_total) throw new AppError(`Le code ${wanted} vaut à partir de ${code.min_total.toLocaleString('fr-FR')} FCFA d'achat`, 'PROMO_CODE');
    if (code.once_per_customer) {
      if (!customerId) throw new AppError(`Le code ${wanted} vaut une fois par client : choisissez le client`, 'CUSTOMER_REQUIRED');
      const used = this.db
        .prepare("SELECT number FROM sales WHERE promo_code = ? AND customer_id = ? AND kind = 'sale' AND status = 'completed' LIMIT 1")
        .pluck()
        .get(wanted, customerId) as string | undefined;
      if (used) throw new AppError(`Ce client a déjà utilisé le code ${wanted} (ticket ${used})`, 'PROMO_CODE');
    }
    return { code, amount: promoCodeAmount(code.kind, code.value, subtotal) };
  }

  /** Tickets qui ont utilisé un code, les plus récents d'abord. */
  uses(id: string, limit = 200): { sale_id: string; number: string; created_at: string; customer: string | null; cashier: string; total_ttc: Fcfa; discount: Fcfa }[] {
    const code = this.get(id);
    return this.db
      .prepare(
        `SELECT s.id AS sale_id, s.number, s.created_at, COALESCE(c.name, s.client_name) AS customer, u.name AS cashier, s.total_ttc, s.promo_code_discount AS discount
         FROM sales s JOIN users u ON u.id = s.user_id LEFT JOIN customers c ON c.id = s.customer_id
         WHERE s.promo_code = ? AND s.kind = 'sale' AND s.status = 'completed' ORDER BY s.created_at DESC LIMIT ?`,
      )
      .all(code.code, limit) as { sale_id: string; number: string; created_at: string; customer: string | null; cashier: string; total_ttc: Fcfa; discount: Fcfa }[];
  }
}
