import { type Fcfa, type LoyaltyRules, earnedPoints, pointsForAmount } from '@superette/core';
import type { AdminService } from './admin';
import type { Db } from './database';
import { AppError, Base, type Clock, type Context, newId } from './util';

export interface LoyaltyMove {
  id: string;
  customer_id: string;
  store_id: string;
  store_name: string | null;
  sale_id: string | null;
  sale_number: string | null;
  kind: 'earn' | 'redeem' | 'cancel' | 'return' | 'adjust';
  points: number;
  reason: string | null;
  user_name: string | null;
  created_at: string;
}

export interface LoyaltyStatus {
  enabled: boolean;
  rules: LoyaltyRules;
  balance: number;
  /** Valeur du solde en FCFA. */
  value: Fcfa;
}

/**
 * Carte de fidélité : un client enregistré gagne des points sur ses achats
 * (1 point par tranche, réglage du magasin) et paie avec (« Points fidélité »).
 * Chaque mouvement est gardé et part à tous les magasins : le solde est le même partout.
 */
export class LoyaltyService extends Base {
  constructor(
    db: Db,
    clock: Clock,
    private readonly admin: AdminService,
  ) {
    super(db, clock);
  }

  rules(storeId: string): LoyaltyRules & { enabled: boolean } {
    const s = this.admin.storeSettings(storeId);
    return { enabled: s.loyaltyEnabled, spendPerPoint: s.loyaltySpendPerPoint, pointValue: s.loyaltyPointValue, minRedeem: s.loyaltyMinRedeem };
  }

  balance(customerId: string): number {
    return (this.db.prepare('SELECT COALESCE(SUM(points), 0) FROM loyalty_moves WHERE customer_id = ?').pluck().get(customerId) as number) ?? 0;
  }

  /** Soldes de plusieurs clients (liste des clients). */
  balances(): Map<string, number> {
    const rows = this.db.prepare('SELECT customer_id, SUM(points) AS points FROM loyalty_moves GROUP BY customer_id').all() as { customer_id: string; points: number }[];
    return new Map(rows.map((r) => [r.customer_id, r.points]));
  }

  status(storeId: string, customerId: string): LoyaltyStatus {
    const { enabled, ...rules } = this.rules(storeId);
    const balance = this.balance(customerId);
    return { enabled, rules, balance, value: Math.max(0, balance) * rules.pointValue };
  }

  history(customerId: string, limit = 200): LoyaltyMove[] {
    return this.db
      .prepare(
        `SELECT m.*, st.name AS store_name, s.number AS sale_number, u.name AS user_name
         FROM loyalty_moves m LEFT JOIN stores st ON st.id = m.store_id LEFT JOIN sales s ON s.id = m.sale_id LEFT JOIN users u ON u.id = m.user_id
         WHERE m.customer_id = ? ORDER BY m.created_at DESC, m.rowid DESC LIMIT ?`,
      )
      .all(customerId, limit) as LoyaltyMove[];
  }

  /**
   * Contrôle d'un paiement en points avant la vente : carte active, client choisi,
   * montant juste en points, minimum atteint et solde suffisant. Renvoie les points dépensés.
   */
  checkRedeem(storeId: string, customerId: string | null | undefined, amount: Fcfa): number {
    if (amount <= 0) return 0;
    const r = this.rules(storeId);
    if (!r.enabled) throw new AppError('La carte de fidélité n’est pas activée dans ce magasin', 'INVALID');
    if (!customerId) throw new AppError('Choisissez le client pour payer avec ses points', 'CUSTOMER_REQUIRED');
    let points: number;
    try {
      points = pointsForAmount(amount, r);
    } catch (e) {
      throw new AppError(e instanceof Error ? e.message : String(e), 'INVALID');
    }
    const balance = this.balance(customerId);
    if (balance < r.minRedeem) throw new AppError(`Il faut au moins ${r.minRedeem} points pour payer avec (solde : ${balance})`, 'INVALID');
    if (points > balance) throw new AppError(`Points insuffisants : ${points} demandés, ${balance} disponibles`, 'INVALID');
    return points;
  }

  private insert(ctx: Pick<Context, 'storeId' | 'userId'>, m: { customerId: string; saleId: string | null; kind: LoyaltyMove['kind']; points: number; reason?: string | null }) {
    if (!m.points) return;
    const id = newId();
    this.db
      .prepare('INSERT INTO loyalty_moves (id, customer_id, store_id, sale_id, kind, points, reason, user_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, m.customerId, ctx.storeId, m.saleId, m.kind, m.points, m.reason ?? null, ctx.userId, this.now());
    // Commun à tous les magasins : envoyé sans magasin, comme la fiche du client.
    this.enqueue(null, 'loyalty_move', id, 'upsert', {});
  }

  /** Vente validée : points dépensés puis points gagnés sur la part payée autrement. */
  recordSale(ctx: Context, sale: { id: string; customer_id: string | null; total_ttc: Fcfa; payments: { method: string; amount: Fcfa }[] }): { earned: number; redeemed: number } {
    const r = this.rules(ctx.storeId);
    if (!sale.customer_id) return { earned: 0, redeemed: 0 };
    const paidInPoints = sale.payments.filter((p) => p.method === 'LOYALTY').reduce((t, p) => t + p.amount, 0);
    const redeemed = paidInPoints > 0 ? this.checkRedeem(ctx.storeId, sale.customer_id, paidInPoints) : 0;
    const earned = r.enabled ? earnedPoints(sale.total_ttc - paidInPoints, r) : 0;
    this.insert(ctx, { customerId: sale.customer_id, saleId: sale.id, kind: 'redeem', points: -redeemed });
    this.insert(ctx, { customerId: sale.customer_id, saleId: sale.id, kind: 'earn', points: earned });
    return { earned, redeemed };
  }

  /** Vente annulée : ses points gagnés sont retirés et ses points dépensés rendus. */
  cancelSale(ctx: Context, saleId: string, customerId: string | null): void {
    if (!customerId) return;
    const net = this.db.prepare('SELECT COALESCE(SUM(points), 0) FROM loyalty_moves WHERE sale_id = ?').pluck().get(saleId) as number;
    this.insert(ctx, { customerId, saleId, kind: 'cancel', points: -net });
  }

  /**
   * Retour client : les points gagnés sur la vente reculent au prorata du montant rendu ;
   * un remboursement en points les rend au client.
   */
  recordReturn(ctx: Context, original: { id: string; customer_id: string | null; total_ttc: Fcfa }, returnId: string, refunded: Fcfa, refundMethod: string): void {
    if (!original.customer_id) return;
    const earned = this.db.prepare("SELECT COALESCE(SUM(points), 0) FROM loyalty_moves WHERE sale_id = ? AND kind = 'earn'").pluck().get(original.id) as number;
    const taken = -(this.db.prepare("SELECT COALESCE(SUM(points), 0) FROM loyalty_moves WHERE sale_id IN (SELECT id FROM sales WHERE original_sale_id = ?) AND kind = 'return' AND points < 0").pluck().get(original.id) as number);
    const share = original.total_ttc > 0 ? Math.round((earned * refunded) / original.total_ttc) : 0;
    const back = Math.min(Math.max(0, earned - taken), share);
    this.insert(ctx, { customerId: original.customer_id, saleId: returnId, kind: 'return', points: -back });
    if (refundMethod === 'LOYALTY') {
      // Remboursé en points : arrondi au point inférieur.
      const r = this.rules(ctx.storeId);
      this.insert(ctx, { customerId: original.customer_id, saleId: returnId, kind: 'return', points: r.pointValue > 0 ? Math.floor(refunded / r.pointValue) : 0 });
    }
  }

  /** Correction à la main par un gérant (carte perdue, geste commercial…), avec motif. */
  adjust(ctx: Pick<Context, 'storeId' | 'userId'>, customerId: string, points: number, reason: string): number {
    if (!Number.isSafeInteger(points) || points === 0) throw new AppError('Nombre de points entier, différent de zéro', 'INVALID');
    if (!reason.trim()) throw new AppError('Le motif de la correction est obligatoire', 'INVALID');
    const balance = this.balance(customerId);
    if (balance + points < 0) throw new AppError(`Le solde ne peut pas devenir négatif (solde : ${balance})`, 'INVALID');
    return this.tx(() => {
      this.insert(ctx, { customerId, saleId: null, kind: 'adjust', points, reason: reason.trim() });
      this.audit(ctx.userId, 'loyalty.adjust', 'customer', customerId, { points, reason: reason.trim() });
      return this.balance(customerId);
    });
  }
}
