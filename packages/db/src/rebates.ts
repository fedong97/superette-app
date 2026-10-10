import { type Fcfa, type Milli, formatFcfa } from '@superette/core';
import type { Db } from './database';
import type { TreasuryService } from './treasury';
import { AppError, Base, type Clock, type Context, newId } from './util';

export interface RebateRule {
  id: string;
  customer_id: string | null;
  customer_name: string | null;
  customer_code: string | null;
  /** Famille d'articles ; null = toutes les familles. */
  family_id: string | null;
  family_name: string | null;
  /** Taux en points de base (250 = 2,50 %) du montant TTC acheté. */
  rate_bp: number;
  /** Montant par unité achetée (par pièce, kg ou litre). */
  unit_amount: Fcfa;
  /** Quantité minimale sur la période pour avoir droit à la ristourne. */
  min_qty: Milli;
  /** Frais d'enlèvement par unité, déduits quand la superette livre le client. */
  pickup_fee: Fcfa;
}

export interface RebateRuleInput {
  familyId: string | null;
  rateBp: number;
  unitAmount: Fcfa;
  minQty: Milli;
  pickupFee: Fcfa;
}

export interface RebateLine {
  family_id: string | null;
  family_name: string;
  qty: Milli;
  amount: Fcfa;
  rule: 'client' | 'base';
  rate_bp: number;
  unit_amount: Fcfa;
  min_qty: Milli;
  pickup_fee: Fcfa;
  /** Ristourne de la famille (0 sous la quantité minimale). */
  rebate: Fcfa;
}

export interface RebateState {
  customer_id: string;
  customer_code: string;
  customer_name: string;
  delivered: boolean;
  /** Solde de ristourne reporté au début de la période (report à nouveau). */
  opening: Fcfa;
  /** Ristourne calculée sur les achats de la période. */
  computed: Fcfa;
  /** Déjà constatée pour une période qui chevauche celle-ci. */
  earned: Fcfa;
  /** Calculée mais pas encore constatée. */
  pending: Fcfa;
  /** Régularisations et ristournes accordées datées de la période. */
  adjusted: Fcfa;
  granted: Fcfa;
  /** Reste à accorder aujourd'hui (compte de ristourne du client). */
  balance: Fcfa;
  lines: RebateLine[];
}

export type RebateEntryKind = 'earned' | 'adjust' | 'credit' | 'cash';
export const REBATE_KINDS: Record<RebateEntryKind, string> = {
  earned: 'Ristourne acquise',
  adjust: 'Régularisation',
  credit: 'Accordée en avoir',
  cash: 'Payée en espèces',
};

export interface RebateEntry {
  id: string;
  number: string;
  customer_id: string;
  customer_name: string;
  kind: RebateEntryKind;
  amount: Fcfa;
  period_from: string | null;
  period_to: string | null;
  label: string;
  at: string;
  user_name: string | null;
}

const dayFr = (ymd: string) => new Date(`${ymd}T12:00:00`).toLocaleDateString('fr-FR');

/**
 * Ristournes des clients spécifiques (KONTROL : Client › Ristournes & Autres).
 * Un réglage de base par famille d'articles (taux, montant par unité,
 * quantité minimale, frais d'enlèvement) vaut pour les clients cochés « à
 * ristourne » ; un réglage propre à un client le remplace. Le compte de
 * ristourne du client reçoit la ristourne constatée sur une période, les
 * régularisations, et se vide quand elle est accordée en avoir ou en espèces.
 */
export class RebateService extends Base {
  constructor(
    db: Db,
    clock: Clock,
    private readonly treasury: TreasuryService,
  ) {
    super(db, clock);
  }

  private number(): string {
    return `RI-${this.stationPrefix()}-${String(this.nextCounter('rebate')).padStart(5, '0')}`;
  }

  // --- Réglages ---------------------------------------------------------------

  rules(scope: { customerId?: string | null; all?: boolean } = {}): RebateRule[] {
    return this.db
      .prepare(
        `SELECT r.id, r.customer_id, c.name AS customer_name, c.code AS customer_code, r.family_id, f.name AS family_name, r.rate_bp, r.unit_amount, r.min_qty, r.pickup_fee
         FROM rebate_rules r LEFT JOIN customers c ON c.id = r.customer_id LEFT JOIN families f ON f.id = r.family_id
         WHERE @all = 1 OR (@customerId IS NULL AND r.customer_id IS NULL) OR r.customer_id = @customerId
         ORDER BY c.name, f.name, r.created_at`,
      )
      .all({ all: scope.all ? 1 : 0, customerId: scope.customerId ?? null }) as RebateRule[];
  }

  /** Remplace les réglages de base (customerId null) ou ceux d'un client. */
  saveRules(ctx: Context, customerId: string | null, rules: RebateRuleInput[]): RebateRule[] {
    const seen = new Set<string>();
    for (const r of rules) {
      const key = r.familyId ?? '*';
      if (seen.has(key)) throw new AppError('Une même famille apparaît deux fois', 'INVALID');
      seen.add(key);
      for (const v of [r.rateBp, r.unitAmount, r.minQty, r.pickupFee])
        if (!Number.isSafeInteger(v) || v < 0) throw new AppError('Montant, taux ou quantité invalide', 'INVALID');
      if (r.rateBp > 10_000) throw new AppError('Taux supérieur à 100 %', 'INVALID');
    }
    return this.tx(() => {
      if (customerId) this.db.prepare('DELETE FROM rebate_rules WHERE customer_id = ?').run(customerId);
      else this.db.prepare('DELETE FROM rebate_rules WHERE customer_id IS NULL').run();
      const ins = this.db.prepare(
        `INSERT INTO rebate_rules (id, customer_id, family_id, rate_bp, unit_amount, min_qty, pickup_fee, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const now = this.now();
      for (const r of rules) ins.run(newId(), customerId, r.familyId, r.rateBp, r.unitAmount, r.minQty, r.pickupFee, now, now);
      if (customerId) this.db.prepare('UPDATE customers SET rebate_enabled = 1 WHERE id = ?').run(customerId);
      this.audit(ctx.userId, 'rebate.rules', 'customer', customerId ?? undefined, { rules: rules.length });
      return this.rules({ customerId });
    });
  }

  /** Coche un client « à ristourne » et indique si la superette le livre (frais d'enlèvement déduits). */
  setCustomer(ctx: Context, customerId: string, opts: { enabled: boolean; delivered: boolean }): void {
    this.db.prepare('UPDATE customers SET rebate_enabled = ?, rebate_delivered = ? WHERE id = ?').run(opts.enabled ? 1 : 0, opts.delivered ? 1 : 0, customerId);
    this.audit(ctx.userId, 'rebate.customer', 'customer', customerId, opts);
  }

  /** Clients à ristourne : cochés, ou avec un réglage propre, ou avec un solde. */
  customers(): { id: string; code: string; name: string; rebate_enabled: number; rebate_delivered: number; own_rules: number }[] {
    return this.db
      .prepare(
        `SELECT c.id, c.code, c.name, c.rebate_enabled, c.rebate_delivered,
                (SELECT COUNT(*) FROM rebate_rules r WHERE r.customer_id = c.id) AS own_rules
         FROM customers c
         WHERE c.rebate_enabled = 1 OR EXISTS (SELECT 1 FROM rebate_rules r WHERE r.customer_id = c.id) OR EXISTS (SELECT 1 FROM rebate_entries e WHERE e.customer_id = c.id)
         ORDER BY c.name`,
      )
      .all() as { id: string; code: string; name: string; rebate_enabled: number; rebate_delivered: number; own_rules: number }[];
  }

  // --- Calcul -----------------------------------------------------------------

  /** Achats nets (ventes moins retours) d'un client par famille, entre deux dates locales incluses. */
  private purchases(storeId: string, customerId: string, from: string, to: string): { family_id: string | null; family_name: string | null; qty: Milli; amount: Fcfa }[] {
    return this.db
      .prepare(
        `SELECT a.family_id, f.name AS family_name,
                SUM(CASE WHEN s.kind = 'return' THEN -ABS(l.qty) ELSE l.qty END) AS qty,
                SUM(CASE WHEN s.kind = 'return' THEN -ABS(l.total_ttc) ELSE l.total_ttc END) AS amount
         FROM sales s JOIN sale_lines l ON l.sale_id = s.id JOIN articles a ON a.id = l.article_id LEFT JOIN families f ON f.id = a.family_id
         WHERE s.store_id = @storeId AND s.customer_id = @customerId AND s.status = 'completed'
           AND date(s.created_at, 'localtime') BETWEEN @from AND @to
         GROUP BY a.family_id ORDER BY f.name`,
      )
      .all({ storeId, customerId, from, to }) as { family_id: string | null; family_name: string | null; qty: Milli; amount: Fcfa }[];
  }

  /** Ristourne d'un client sur la période, famille par famille. */
  compute(storeId: string, customerId: string, from: string, to: string): RebateLine[] {
    const c = this.db.prepare('SELECT rebate_enabled, rebate_delivered FROM customers WHERE id = ?').get(customerId) as { rebate_enabled: number; rebate_delivered: number } | undefined;
    if (!c) throw new AppError('Client introuvable', 'NOT_FOUND');
    const own = this.rules({ customerId });
    const base = c.rebate_enabled ? this.rules() : [];
    const pick = (list: RebateRule[], familyId: string | null) => list.find((r) => r.family_id === familyId) ?? list.find((r) => r.family_id === null);
    const lines: RebateLine[] = [];
    for (const p of this.purchases(storeId, customerId, from, to)) {
      const ownRule = pick(own, p.family_id);
      const rule = ownRule ?? pick(base, p.family_id);
      if (!rule) continue;
      const units = p.qty / 1000;
      const reached = p.qty > 0 && p.qty >= rule.min_qty;
      const raw = Math.round((p.amount * rule.rate_bp) / 10_000) + Math.round(units * rule.unit_amount) - (c.rebate_delivered ? Math.round(units * rule.pickup_fee) : 0);
      lines.push({
        family_id: p.family_id,
        family_name: p.family_name ?? 'Sans famille',
        qty: p.qty,
        amount: p.amount,
        rule: ownRule ? 'client' : 'base',
        rate_bp: rule.rate_bp,
        unit_amount: rule.unit_amount,
        min_qty: rule.min_qty,
        pickup_fee: rule.pickup_fee,
        rebate: reached ? Math.max(0, raw) : 0,
      });
    }
    return lines;
  }

  /** Solde du compte de ristourne d'un client (reste à accorder), avant une date locale si donnée. */
  balance(storeId: string, customerId: string, before?: string): Fcfa {
    return this.db
      .prepare(
        `SELECT COALESCE(SUM(CASE WHEN kind IN ('credit', 'cash') THEN -amount ELSE amount END), 0)
         FROM rebate_entries WHERE store_id = ? AND customer_id = ? AND (? IS NULL OR date(at, 'localtime') < ?)`,
      )
      .pluck()
      .get(storeId, customerId, before ?? null, before ?? null) as number;
  }

  /** État des ristournes sur une période : report à nouveau, calculée, constatée, accordée, reste. */
  state(storeId: string, from: string, to: string): RebateState[] {
    if (from > to) throw new AppError('La date de début est après la date de fin', 'INVALID');
    const sums = this.db.prepare(
      `SELECT kind, COALESCE(SUM(amount), 0) AS total FROM rebate_entries
       WHERE store_id = ? AND customer_id = ? AND kind <> 'earned' AND date(at, 'localtime') BETWEEN ? AND ? GROUP BY kind`,
    );
    const earnedFor = this.db.prepare(
      "SELECT COALESCE(SUM(amount), 0) FROM rebate_entries WHERE store_id = ? AND customer_id = ? AND kind = 'earned' AND period_from <= ? AND period_to >= ?",
    );
    return this.customers().map((c) => {
      const lines = this.compute(storeId, c.id, from, to);
      const by = Object.fromEntries((sums.all(storeId, c.id, from, to) as { kind: RebateEntryKind; total: number }[]).map((r) => [r.kind, r.total])) as Partial<Record<RebateEntryKind, number>>;
      const computed = lines.reduce((t, l) => t + l.rebate, 0);
      const earned = earnedFor.pluck().get(storeId, c.id, to, from) as number;
      return {
        customer_id: c.id,
        customer_code: c.code,
        customer_name: c.name,
        delivered: c.rebate_delivered === 1,
        opening: this.balance(storeId, c.id, from),
        computed,
        earned,
        pending: earned ? 0 : computed,
        adjusted: by.adjust ?? 0,
        granted: (by.credit ?? 0) + (by.cash ?? 0),
        balance: this.balance(storeId, c.id),
        lines,
      };
    });
  }

  private insert(ctx: Context, e: { customerId: string; kind: RebateEntryKind; amount: Fcfa; label: string; from?: string | null; to?: string | null }): string {
    const id = newId();
    this.db
      .prepare(
        `INSERT INTO rebate_entries (id, number, store_id, customer_id, kind, amount, period_from, period_to, label, at, user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, this.number(), ctx.storeId, e.customerId, e.kind, e.amount, e.from ?? null, e.to ?? null, e.label, this.now(), ctx.userId);
    this.enqueue(ctx, 'rebate_entry', id, 'upsert', {});
    this.audit(ctx.userId, `rebate.${e.kind}`, 'customer', e.customerId, { amount: e.amount });
    return id;
  }

  /**
   * Constate la ristourne de la période : elle entre dans le compte de
   * ristourne de chaque client. Une période déjà constatée pour un client
   * (même en partie) n'est pas comptée deux fois.
   */
  close(ctx: Context, from: string, to: string, customerIds?: string[]): { customer_id: string; amount: Fcfa }[] {
    if (from > to) throw new AppError('La date de début est après la date de fin', 'INVALID');
    if (to >= this.today()) throw new AppError("Constatez une période terminée (jusqu'à hier au plus tard)", 'INVALID');
    const overlap = this.db.prepare(
      "SELECT period_from, period_to FROM rebate_entries WHERE customer_id = ? AND kind = 'earned' AND period_from <= ? AND period_to >= ? LIMIT 1",
    );
    return this.tx(() => {
      const done: { customer_id: string; amount: Fcfa }[] = [];
      for (const c of this.customers()) {
        if (customerIds && !customerIds.includes(c.id)) continue;
        const amount = this.compute(ctx.storeId, c.id, from, to).reduce((t, l) => t + l.rebate, 0);
        if (amount <= 0) continue;
        const clash = overlap.get(c.id, to, from) as { period_from: string; period_to: string } | undefined;
        if (clash) throw new AppError(`La ristourne de ${c.name} est déjà constatée du ${dayFr(clash.period_from)} au ${dayFr(clash.period_to)}`, 'INVALID');
        this.insert(ctx, { customerId: c.id, kind: 'earned', amount, label: `Ristourne du ${dayFr(from)} au ${dayFr(to)}`, from, to });
        done.push({ customer_id: c.id, amount });
      }
      return done;
    });
  }

  /** Régularisation à la main (positive ou négative), avec un motif. */
  adjust(ctx: Context, customerId: string, amount: Fcfa, reason: string): RebateEntry {
    if (!Number.isSafeInteger(amount) || amount === 0) throw new AppError('Montant invalide', 'INVALID');
    if (!reason.trim()) throw new AppError('Le motif est obligatoire', 'INVALID');
    if (amount < 0 && -amount > this.balance(ctx.storeId, customerId)) throw new AppError('La régularisation dépasse le solde de ristourne du client', 'INVALID');
    return this.tx(() => this.getEntry(this.insert(ctx, { customerId, kind: 'adjust', amount, label: `Régularisation : ${reason.trim()}` })));
  }

  /** Accorde tout ou partie du solde : en avoir sur le compte client, ou en espèces depuis la caisse centrale. */
  grant(ctx: Context, customerId: string, amount: Fcfa, mode: 'credit' | 'cash'): RebateEntry {
    if (!Number.isSafeInteger(amount) || amount <= 0) throw new AppError('Montant invalide', 'INVALID');
    const due = this.balance(ctx.storeId, customerId);
    if (amount > due) throw new AppError(`Le client n'a que ${formatFcfa(due)} de ristourne à accorder`, 'INVALID');
    if (mode === 'cash' && amount > this.treasury.balance(ctx.storeId)) throw new AppError(`La caisse centrale n'a que ${formatFcfa(this.treasury.balance(ctx.storeId))}`, 'INSUFFICIENT');
    return this.tx(() =>
      this.getEntry(this.insert(ctx, { customerId, kind: mode, amount, label: mode === 'credit' ? 'Ristourne accordée en avoir' : 'Ristourne payée en espèces' })),
    );
  }

  entries(storeId: string, opts: { customerId?: string | null; from?: string | null; to?: string | null; id?: string } = {}): RebateEntry[] {
    return this.db
      .prepare(
        `SELECT e.id, e.number, e.customer_id, c.name AS customer_name, e.kind, e.amount, e.period_from, e.period_to, e.label, e.at, u.name AS user_name
         FROM rebate_entries e JOIN customers c ON c.id = e.customer_id LEFT JOIN users u ON u.id = e.user_id
         WHERE e.store_id = @storeId AND (@customerId IS NULL OR e.customer_id = @customerId) AND (@id IS NULL OR e.id = @id)
           AND (@from IS NULL OR date(e.at, 'localtime') >= @from) AND (@to IS NULL OR date(e.at, 'localtime') <= @to)
         ORDER BY e.at DESC, e.number DESC`,
      )
      .all({ storeId, customerId: opts.customerId ?? null, from: opts.from ?? null, to: opts.to ?? null, id: opts.id ?? null }) as RebateEntry[];
  }

  getEntry(id: string): RebateEntry {
    const storeId = this.db.prepare('SELECT store_id FROM rebate_entries WHERE id = ?').pluck().get(id) as string | undefined;
    const e = storeId ? this.entries(storeId, { id })[0] : undefined;
    if (!e) throw new AppError('Écriture de ristourne introuvable', 'NOT_FOUND');
    return e;
  }

  /** Reports à nouveau : solde de ristourne de chaque client au début d'un jour. */
  carryForward(storeId: string, date: string): { customer_id: string; customer_code: string; customer_name: string; balance: Fcfa }[] {
    return this.customers()
      .map((c) => ({ customer_id: c.id, customer_code: c.code, customer_name: c.name, balance: this.balance(storeId, c.id, date) }))
      .filter((c) => c.balance !== 0);
  }
}
