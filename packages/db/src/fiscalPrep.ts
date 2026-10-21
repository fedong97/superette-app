import { createHash } from 'node:crypto';
import { type Fcfa, formatRate, splitTtc } from '@superette/core';
import type { TaxRegime, TaxService } from './tax';
import { TAX_DEFAULTS } from './tax';
import { AppError, Base, type Clock, type Context, newId } from './util';
import type { Db } from './database';

/**
 * Avoir : réduction d'une vente réelle (geste commercial, erreur de prix) sans retour d'articles.
 * Correction : montant en plus ou en moins sur une vente réelle, justifié par une pièce.
 * Reclassement : une partie d'une vente passée dans la mauvaise catégorie fiscale (taux de TVA).
 */
export type FiscalAdjustmentKind = 'credit_note' | 'correction' | 'reclass';
export type FiscalAdjustmentStatus = 'pending' | 'approved' | 'rejected' | 'withdrawn';

export const FISCAL_KIND_LABELS: Record<FiscalAdjustmentKind, string> = {
  credit_note: 'Avoir',
  correction: 'Correction justifiée',
  reclass: 'Reclassement de catégorie',
};

export interface FiscalAdjustmentInput {
  /** Vente réelle concernée (identifiant ou numéro). */
  saleId?: string | null;
  saleNumber?: string | null;
  kind: FiscalAdjustmentKind;
  /** Catégorie fiscale touchée (taux de TVA en points de base). */
  vatRateBp: number;
  /** Reclassement : catégorie d'arrivée. */
  toVatRateBp?: number | null;
  /** TTC : positif pour un avoir et un reclassement ; signé pour une correction. */
  amountTtc: Fcfa;
  reason: string;
  /** Pièce justificative : n° d'avoir remis au client, réclamation, courrier, PV… */
  reference: string;
}

export interface FiscalEffect {
  rate: number;
  ttc: Fcfa;
  ht: Fcfa;
  tva: Fcfa;
}

export interface FiscalAdjustment {
  id: string;
  number: string;
  store_id: string;
  kind: FiscalAdjustmentKind;
  sale_id: string;
  sale_number: string;
  vat_rate_bp: number;
  to_vat_rate_bp: number | null;
  amount_ttc: Fcfa;
  reason: string;
  reference: string;
  created_by: string;
  created_by_name: string | null;
  created_at: string;
  status: FiscalAdjustmentStatus;
  decided_by: string | null;
  decided_by_name: string | null;
  decided_at: string | null;
  decision_reason: string | null;
  /** Effet sur l'état déclaré, catégorie par catégorie. */
  effects: FiscalEffect[];
}

export interface FiscalLogEntry {
  id: string;
  entity: 'adjustment' | 'statement';
  entity_id: string;
  number: string | null;
  action: 'propose' | 'approve' | 'reject' | 'withdraw' | 'generate';
  user_id: string;
  user_name: string | null;
  reason: string | null;
  at: string;
  hash: string;
  prev_hash: string | null;
}

export interface SaleFiscalSituation {
  sale_id: string;
  sale_number: string;
  created_at: string;
  customer_name: string | null;
  /** Par catégorie : vendu, remboursé par les retours, ajusté (en cours ou approuvé), reste. */
  categories: { rate: number; label: string; sold: Fcfa; returned: Fcfa; adjusted: Fcfa; remaining: Fcfa }[];
  adjustments: FiscalAdjustment[];
}

export interface FiscalCategory {
  rate: number;
  label: string;
  real: { ttc: Fcfa; ht: Fcfa; tva: Fcfa };
  adjustments: { ttc: Fcfa; ht: Fcfa; tva: Fcfa };
  declared: { ttc: Fcfa; ht: Fcfa; tva: Fcfa };
}

export interface FiscalStatement {
  store: { id: string; code: string; name: string; vatEnabled: boolean };
  from: string;
  to: string;
  regime: TaxRegime;
  categories: FiscalCategory[];
  real: { ttc: Fcfa; ht: Fcfa; tva: Fcfa; sales: number; returns: number; cancelled: number; cancelledTtc: Fcfa };
  adjustments: { ttc: Fcfa; ht: Fcfa; tva: Fcfa };
  declared: { ttc: Fcfa; ht: Fcfa; tva: Fcfa };
  /** Rapprochement : CA réel + ajustements approuvés = CA déclaré ; aucun autre écart possible. */
  reconciliation: { realHt: Fcfa; adjustmentsHt: Fcfa; declaredHt: Fcfa; unexplained: Fcfa; balanced: boolean };
  /** Contrôle de la source : totaux des tickets contre leurs lignes. */
  sourceCheck: { headersTtc: Fcfa; linesTtc: Fcfa; ok: boolean };
  /** Ajustements approuvés pendant la période (pris en compte). */
  applied: FiscalAdjustment[];
  /** Ajustements en attente d'approbation : pas pris en compte. */
  pending: FiscalAdjustment[];
  obligations: {
    vatCollected: Fcfa;
    /** Acompte (minimum de perception) sur le CA déclaré HT, avec les CAC. */
    instalment: { rate: number; principal: Fcfa; cac: Fcfa; total: Fcfa };
  };
}

export interface GeneratedStatement {
  id: string;
  number: string;
  period_from: string;
  period_to: string;
  real_ht: Fcfa;
  declared_ht: Fcfa;
  generated_by: string;
  generated_by_name: string | null;
  generated_at: string;
  hash: string;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const sha = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const pct = (amount: number, bp: number) => Math.round((amount * bp) / 10_000);
const zero = () => ({ ttc: 0, ht: 0, tva: 0 });
const esc = (v: string | number | null | undefined) => {
  const s = String(v ?? '');
  return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

interface AdjustmentRow {
  id: string;
  number: string;
  store_id: string;
  kind: FiscalAdjustmentKind;
  sale_id: string;
  sale_number: string;
  vat_rate_bp: number;
  to_vat_rate_bp: number | null;
  amount_ttc: number;
  reason: string;
  reference: string;
  created_by: string;
  created_at: string;
  hash: string;
}

/** Contenu signé d'un ajustement : ce que son empreinte protège. */
const adjustmentContent = (a: AdjustmentRow) => [a.id, a.number, a.store_id, a.kind, a.sale_id, a.sale_number, a.vat_rate_bp, a.to_vat_rate_bp, a.amount_ttc, a.reason, a.reference, a.created_by, a.created_at];

/** Effet d'un ajustement sur l'état déclaré, catégorie par catégorie. */
export function adjustmentEffects(a: Pick<AdjustmentRow, 'kind' | 'vat_rate_bp' | 'to_vat_rate_bp' | 'amount_ttc'>): FiscalEffect[] {
  const at = (rate: number, ttc: number): FiscalEffect => ({ rate, ttc, ...splitTtc(ttc, rate) });
  if (a.kind === 'credit_note') return [at(a.vat_rate_bp, -a.amount_ttc)];
  if (a.kind === 'correction') return [at(a.vat_rate_bp, a.amount_ttc)];
  return [at(a.vat_rate_bp, -a.amount_ttc), at(a.to_vat_rate_bp!, a.amount_ttc)];
}

/**
 * Préparation fiscale : état comptable et fiscal d'une période, tiré des ventes réelles.
 *
 * Elle lit les ventes (sales, sale_lines) et ne les modifie jamais. Le chiffre déclaré est
 * toujours le chiffre réel plus les seuls ajustements approuvés, et chacun est :
 * - rattaché à une vente réelle existante (même identifiant dans les deux modules) ;
 * - borné par ce qui reste de cette vente (on ne retire pas plus que ce qui a été vendu) ;
 * - motivé, appuyé d'une pièce, proposé par un utilisateur et approuvé par un autre ;
 * - inscrit dans un journal chaîné qu'on ne peut ni modifier ni effacer.
 * Il n'y a ni montant cible à atteindre, ni opération générée, ni vente écartée de l'état.
 */
export class FiscalPrepService extends Base {
  constructor(
    db: Db,
    clock: Clock,
    private readonly tax: TaxService,
  ) {
    super(db, clock);
  }

  private period(from: string, to: string): void {
    if (!DATE.test(from) || !DATE.test(to) || from > to) throw new AppError('Période invalide', 'INVALID');
  }

  private vatEnabled(storeId: string): boolean {
    return (this.db.prepare('SELECT vat_enabled FROM stores WHERE id = ?').pluck().get(storeId) as number | undefined) === 1;
  }

  categoryLabel(storeId: string, rate: number): string {
    if (rate === 0) return this.vatEnabled(storeId) ? 'Exonéré ou non taxable (0 %)' : 'TVA non applicable (non assujetti)';
    return `Taxable à la TVA ${formatRate(rate)}`;
  }

  /** Catégories fiscales connues du magasin : taux de TVA paramétrés et taux trouvés sur les ventes. */
  categories(storeId: string): { rate: number; label: string }[] {
    const rates = this.db
      .prepare(
        `SELECT rate_bp FROM vat_rates UNION SELECT DISTINCT l.vat_rate_bp FROM sale_lines l JOIN sales s ON s.id = l.sale_id WHERE s.store_id = ?
         ORDER BY 1 DESC`,
      )
      .pluck()
      .all(storeId) as number[];
    return rates.map((rate) => ({ rate, label: this.categoryLabel(storeId, rate) }));
  }

  // --- Lecture des ventes réelles ---------------------------------------------

  /** Ventes réelles de la période par catégorie, au même calcul que les tickets (TVA taux par taux, vente par vente). */
  private realBase(storeId: string, from: string, to: string) {
    const perSale = this.db
      .prepare(
        `SELECT l.sale_id, l.vat_rate_bp AS rate, SUM(l.total_ttc) AS ttc FROM sale_lines l JOIN sales s ON s.id = l.sale_id
         WHERE s.store_id = ? AND s.status = 'completed' AND date(s.created_at, 'localtime') BETWEEN ? AND ?
         GROUP BY l.sale_id, l.vat_rate_bp`,
      )
      .all(storeId, from, to) as { sale_id: string; rate: number; ttc: number }[];
    const byRate = new Map<number, { ttc: number; ht: number; tva: number }>();
    for (const r of perSale) {
      const { ht, tva } = splitTtc(r.ttc, r.rate);
      const c = byRate.get(r.rate) ?? zero();
      byRate.set(r.rate, { ttc: c.ttc + r.ttc, ht: c.ht + ht, tva: c.tva + tva });
    }
    const counts = this.db
      .prepare(
        `SELECT COUNT(CASE WHEN status = 'completed' AND kind = 'sale' THEN 1 END) AS sales,
                COUNT(CASE WHEN status = 'completed' AND kind = 'return' THEN 1 END) AS returns,
                COUNT(CASE WHEN status = 'cancelled' THEN 1 END) AS cancelled,
                COALESCE(SUM(CASE WHEN status = 'cancelled' THEN total_ttc END), 0) AS cancelledTtc,
                COALESCE(SUM(CASE WHEN status = 'completed' THEN total_ttc END), 0) AS headersTtc
         FROM sales WHERE store_id = ? AND date(created_at, 'localtime') BETWEEN ? AND ?`,
      )
      .get(storeId, from, to) as { sales: number; returns: number; cancelled: number; cancelledTtc: number; headersTtc: number };
    return { byRate, counts };
  }

  /** Sommes d'une vente réelle par catégorie : vendu, remboursé par les retours. */
  private saleAmounts(saleId: string): Map<number, { sold: number; returned: number }> {
    const out = new Map<number, { sold: number; returned: number }>();
    for (const r of this.db.prepare('SELECT vat_rate_bp AS rate, SUM(total_ttc) AS ttc FROM sale_lines WHERE sale_id = ? GROUP BY vat_rate_bp').all(saleId) as { rate: number; ttc: number }[]) {
      out.set(r.rate, { sold: r.ttc, returned: 0 });
    }
    for (const r of this.db
      .prepare(
        `SELECT l.vat_rate_bp AS rate, -SUM(l.total_ttc) AS ttc FROM sale_lines l JOIN sales s ON s.id = l.sale_id
         WHERE s.original_sale_id = ? AND s.kind = 'return' AND s.status = 'completed' GROUP BY l.vat_rate_bp`,
      )
      .all(saleId) as { rate: number; ttc: number }[]) {
      const c = out.get(r.rate) ?? { sold: 0, returned: 0 };
      out.set(r.rate, { ...c, returned: c.returned + r.ttc });
    }
    return out;
  }

  // --- Ajustements --------------------------------------------------------------

  private readonly SELECT = `SELECT a.*, u.name AS created_by_name, d.action AS decision, d.user_id AS decided_by, du.name AS decided_by_name, d.at AS decided_at, d.reason AS decision_reason
    FROM fiscal_adjustments a
    LEFT JOIN users u ON u.id = a.created_by
    LEFT JOIN fiscal_log d ON d.id = (SELECT l.id FROM fiscal_log l WHERE l.entity_id = a.id AND l.action IN ('approve', 'reject', 'withdraw') ORDER BY l.at, l.id LIMIT 1)
    LEFT JOIN users du ON du.id = d.user_id`;

  private toAdjustment(r: AdjustmentRow & { created_by_name: string | null; decision: string | null; decided_by: string | null; decided_by_name: string | null; decided_at: string | null; decision_reason: string | null }): FiscalAdjustment {
    const { decision, hash: _hash, ...rest } = r;
    const status: FiscalAdjustmentStatus = decision === 'approve' ? 'approved' : decision === 'reject' ? 'rejected' : decision === 'withdraw' ? 'withdrawn' : 'pending';
    return { ...rest, status, effects: adjustmentEffects(r) };
  }

  get(id: string): FiscalAdjustment {
    const row = this.db.prepare(`${this.SELECT} WHERE a.id = ?`).get(id) as Parameters<FiscalPrepService['toAdjustment']>[0] | undefined;
    if (!row) throw new AppError('Ajustement introuvable', 'NOT_FOUND');
    return this.toAdjustment(row);
  }

  list(storeId: string, opts: { status?: FiscalAdjustmentStatus | null; saleId?: string | null } = {}): FiscalAdjustment[] {
    const rows = this.db
      .prepare(`${this.SELECT} WHERE a.store_id = @storeId AND (@saleId IS NULL OR a.sale_id = @saleId) ORDER BY a.created_at DESC, a.number DESC`)
      .all({ storeId, saleId: opts.saleId ?? null }) as Parameters<FiscalPrepService['toAdjustment']>[0][];
    const list = rows.map((r) => this.toAdjustment(r));
    return opts.status ? list.filter((a) => a.status === opts.status) : list;
  }

  private findSale(storeId: string, input: Pick<FiscalAdjustmentInput, 'saleId' | 'saleNumber'>) {
    const sale = (
      input.saleId
        ? this.db.prepare('SELECT * FROM sales WHERE id = ?').get(input.saleId)
        : input.saleNumber?.trim()
          ? this.db.prepare('SELECT * FROM sales WHERE number = ?').get(input.saleNumber.trim().toUpperCase())
          : undefined
    ) as { id: string; number: string; store_id: string; kind: string; status: string; created_at: string; customer_id: string | null; client_name: string | null } | undefined;
    if (!sale || sale.store_id !== storeId) throw new AppError('Vente introuvable dans les ventes réelles du magasin', 'NOT_FOUND');
    return sale;
  }

  /** Situation fiscale d'une vente réelle : ce qui peut encore faire l'objet d'un avoir ou d'une correction. */
  saleSituation(storeId: string, ref: { saleId?: string | null; saleNumber?: string | null }): SaleFiscalSituation {
    const sale = this.findSale(storeId, ref);
    const adjustments = this.list(storeId, { saleId: sale.id });
    const amounts = this.saleAmounts(sale.id);
    const adjusted = new Map<number, number>();
    for (const a of adjustments) {
      if (a.status === 'rejected' || a.status === 'withdrawn') continue;
      for (const e of a.effects) adjusted.set(e.rate, (adjusted.get(e.rate) ?? 0) + e.ttc);
    }
    const rates = new Set([...amounts.keys(), ...adjusted.keys()]);
    const customer = sale.customer_id ? (this.db.prepare('SELECT name FROM customers WHERE id = ?').pluck().get(sale.customer_id) as string | undefined) : undefined;
    return {
      sale_id: sale.id,
      sale_number: sale.number,
      created_at: sale.created_at,
      customer_name: customer ?? sale.client_name,
      categories: [...rates]
        .sort((a, b) => b - a)
        .map((rate) => {
          const m = amounts.get(rate) ?? { sold: 0, returned: 0 };
          const adj = adjusted.get(rate) ?? 0;
          return { rate, label: this.categoryLabel(storeId, rate), sold: m.sold, returned: m.returned, adjusted: adj, remaining: m.sold - m.returned + adj };
        }),
      adjustments,
    };
  }

  /** Propose un avoir, une correction ou un reclassement sur une vente réelle. Il ne compte qu'une fois approuvé. */
  propose(ctx: Context, input: FiscalAdjustmentInput): FiscalAdjustment {
    const sale = this.findSale(ctx.storeId, input);
    if (sale.kind !== 'sale') throw new AppError('Un ajustement se fait sur une vente, pas sur un retour (le retour figure déjà dans les ventes réelles)', 'INVALID');
    if (sale.status !== 'completed') throw new AppError('Cette vente est annulée : elle ne figure déjà plus dans le chiffre d’affaires', 'INVALID');
    if (!['credit_note', 'correction', 'reclass'].includes(input.kind)) throw new AppError("Type d'ajustement inconnu", 'INVALID');
    const reason = input.reason?.trim() ?? '';
    const reference = input.reference?.trim() ?? '';
    if (reason.length < 10) throw new AppError('Expliquez le motif de l’ajustement (10 caractères au moins)', 'INVALID');
    if (!reference) throw new AppError('La pièce justificative est obligatoire (n° d’avoir, réclamation, courrier…)', 'INVALID');
    const amount = input.amountTtc;
    if (!Number.isSafeInteger(amount) || amount === 0) throw new AppError('Montant invalide', 'INVALID');
    if (input.kind !== 'correction' && amount < 0) throw new AppError('Saisissez le montant de l’avoir ou du reclassement en positif', 'INVALID');
    const rate = input.vatRateBp;
    const toRate = input.kind === 'reclass' ? (input.toVatRateBp ?? null) : null;
    if (!Number.isInteger(rate) || rate < 0 || rate > 10_000) throw new AppError('Catégorie fiscale invalide', 'INVALID');
    if (input.kind === 'reclass') {
      if (toRate === null || !Number.isInteger(toRate) || toRate < 0 || toRate > 10_000) throw new AppError('Choisissez la catégorie d’arrivée du reclassement', 'INVALID');
      if (toRate === rate) throw new AppError('La catégorie d’arrivée doit être différente', 'INVALID');
    }
    this.assertPeriodOpen(ctx.storeId, this.today());

    return this.tx(() => {
      // Ce qui sort d'une catégorie ne dépasse jamais ce qui reste de la vente dans cette catégorie.
      const situation = this.saleSituation(ctx.storeId, { saleId: sale.id });
      const effects = adjustmentEffects({ kind: input.kind, vat_rate_bp: rate, to_vat_rate_bp: toRate, amount_ttc: amount });
      for (const e of effects) {
        if (e.ttc >= 0) continue;
        const remaining = situation.categories.find((c) => c.rate === e.rate)?.remaining ?? 0;
        if (-e.ttc > remaining) {
          throw new AppError(
            `L’ajustement dépasse ce qui reste de la vente ${sale.number} en « ${this.categoryLabel(ctx.storeId, e.rate)} » : ${remaining.toLocaleString('fr-FR')} FCFA (vendu, moins retours et ajustements déjà faits)`,
            'INVALID',
          );
        }
      }
      const row: AdjustmentRow = {
        id: newId(),
        number: `AJF-${this.stationPrefix()}-${String(this.nextCounter('fiscal_adjustment.number')).padStart(5, '0')}`,
        store_id: ctx.storeId,
        kind: input.kind,
        sale_id: sale.id,
        sale_number: sale.number,
        vat_rate_bp: rate,
        to_vat_rate_bp: toRate,
        amount_ttc: amount,
        reason,
        reference,
        created_by: ctx.userId,
        created_at: this.now(),
        hash: '',
      };
      row.hash = sha(adjustmentContent(row));
      this.db
        .prepare(
          `INSERT INTO fiscal_adjustments (id, number, store_id, kind, sale_id, sale_number, vat_rate_bp, to_vat_rate_bp, amount_ttc, reason, reference, created_by, created_at, hash)
           VALUES (@id, @number, @store_id, @kind, @sale_id, @sale_number, @vat_rate_bp, @to_vat_rate_bp, @amount_ttc, @reason, @reference, @created_by, @created_at, @hash)`,
        )
        .run(row);
      this.enqueue(ctx, 'fiscal_adjustment', row.id, 'upsert', {});
      this.log(ctx, 'adjustment', row.id, 'propose', null, { number: row.number, sale: row.sale_number, kind: row.kind, amount: row.amount_ttc, contentHash: row.hash });
      this.audit(ctx.userId, 'fiscal.propose', 'fiscal_adjustment', row.id, { number: row.number, sale: sale.number, kind: row.kind, amount, reason, reference });
      return this.get(row.id);
    });
  }

  /**
   * Décision sur un ajustement en attente : approuver ou refuser (un autre utilisateur que l'auteur),
   * ou retirer (l'auteur). Une décision est définitive ; pour revenir sur un ajustement approuvé,
   * on en propose un autre en sens inverse.
   */
  decide(ctx: Context, id: string, action: 'approve' | 'reject' | 'withdraw', reason?: string | null): FiscalAdjustment {
    const adj = this.get(id);
    if (adj.store_id !== ctx.storeId) throw new AppError('Ajustement introuvable', 'NOT_FOUND');
    if (adj.status !== 'pending') throw new AppError('Cet ajustement a déjà été traité', 'INVALID');
    if (action === 'withdraw' && adj.created_by !== ctx.userId) throw new AppError('Seul l’auteur retire sa proposition', 'FORBIDDEN');
    if (action !== 'withdraw' && adj.created_by === ctx.userId) throw new AppError('Un ajustement est approuvé ou refusé par un autre utilisateur que son auteur', 'FORBIDDEN');
    if (action === 'reject' && !reason?.trim()) throw new AppError('Donnez le motif du refus', 'INVALID');
    if (action === 'approve') this.assertPeriodOpen(ctx.storeId, this.today());
    return this.tx(() => {
      // La vente peut avoir eu un retour depuis la proposition : la borne est vérifiée de nouveau.
      if (action === 'approve') {
        const situation = this.saleSituation(ctx.storeId, { saleId: adj.sale_id });
        const negative = situation.categories.find((c) => c.remaining < 0);
        if (negative) throw new AppError(`La vente ${adj.sale_number} a changé depuis la proposition (retour) : l’ajustement dépasserait ce qui reste. Refusez-le.`, 'INVALID');
      }
      this.log(ctx, 'adjustment', id, action, reason?.trim() || null, { number: adj.number });
      this.audit(ctx.userId, `fiscal.${action}`, 'fiscal_adjustment', id, { number: adj.number, reason: reason?.trim() || null });
      return this.get(id);
    });
  }

  // --- Journal chaîné -----------------------------------------------------------

  private log(ctx: Context, entity: FiscalLogEntry['entity'], entityId: string, action: FiscalLogEntry['action'], reason: string | null, data: unknown): void {
    const prev = this.db.prepare('SELECT hash FROM fiscal_log WHERE store_id = ? ORDER BY at DESC, rowid DESC LIMIT 1').pluck().get(ctx.storeId) as string | undefined;
    const row = { id: newId(), store_id: ctx.storeId, entity, entity_id: entityId, action, user_id: ctx.userId, reason, data: JSON.stringify(data), at: this.now(), prev_hash: prev ?? null };
    const hash = sha([row.prev_hash, row.id, row.store_id, row.entity, row.entity_id, row.action, row.user_id, row.reason, row.data, row.at]);
    this.db
      .prepare('INSERT INTO fiscal_log (id, store_id, entity, entity_id, action, user_id, reason, data, at, prev_hash, hash) VALUES (@id, @store_id, @entity, @entity_id, @action, @user_id, @reason, @data, @at, @prev_hash, @hash)')
      .run({ ...row, hash });
    this.enqueue(ctx, 'fiscal_log', row.id, 'upsert', {});
  }

  journal(storeId: string, opts: { entityId?: string | null; limit?: number } = {}): FiscalLogEntry[] {
    return this.db
      .prepare(
        `SELECT l.id, l.entity, l.entity_id, COALESCE(a.number, st.number) AS number, l.action, l.user_id, u.name AS user_name, l.reason, l.at, l.hash, l.prev_hash
         FROM fiscal_log l LEFT JOIN users u ON u.id = l.user_id
         LEFT JOIN fiscal_adjustments a ON a.id = l.entity_id LEFT JOIN fiscal_statements st ON st.id = l.entity_id
         WHERE l.store_id = @storeId AND (@entityId IS NULL OR l.entity_id = @entityId)
         ORDER BY l.at DESC, l.rowid DESC LIMIT @limit`,
      )
      .all({ storeId, entityId: opts.entityId ?? null, limit: opts.limit ?? 1000 }) as FiscalLogEntry[];
  }

  /** Vérifie le journal : empreinte de chaque ligne, maillons de la chaîne, ajustements et états non retouchés. */
  verify(storeId: string): { ok: boolean; checked: number; problems: string[] } {
    const problems: string[] = [];
    const rows = this.db.prepare('SELECT * FROM fiscal_log WHERE store_id = ?').all(storeId) as (Omit<FiscalLogEntry, 'number' | 'user_name'> & { store_id: string; data: string })[];
    const hashes = new Set(rows.map((r) => r.hash));
    for (const r of rows) {
      const expected = sha([r.prev_hash, r.id, r.store_id, r.entity, r.entity_id, r.action, r.user_id, r.reason, r.data, r.at]);
      if (expected !== r.hash) problems.push(`Ligne du journal du ${r.at} modifiée (${r.action})`);
      if (r.prev_hash && !hashes.has(r.prev_hash)) problems.push(`Une ligne du journal manque avant celle du ${r.at} (${r.action})`);
    }
    const proposals = new Map(rows.filter((r) => r.action === 'propose').map((r) => [r.entity_id, JSON.parse(r.data) as { contentHash: string }]));
    for (const a of this.db.prepare('SELECT * FROM fiscal_adjustments WHERE store_id = ?').all(storeId) as AdjustmentRow[]) {
      if (sha(adjustmentContent(a)) !== a.hash || proposals.get(a.id)?.contentHash !== a.hash) problems.push(`Ajustement ${a.number} modifié ou absent du journal`);
    }
    const generated = new Map(rows.filter((r) => r.action === 'generate').map((r) => [r.entity_id, JSON.parse(r.data) as { payloadHash: string }]));
    for (const st of this.db.prepare('SELECT id, number, payload, hash FROM fiscal_statements WHERE store_id = ?').all(storeId) as { id: string; number: string; payload: string; hash: string }[]) {
      if (sha(st.payload) !== st.hash || generated.get(st.id)?.payloadHash !== st.hash) problems.push(`État fiscal ${st.number} modifié ou absent du journal`);
    }
    return { ok: problems.length === 0, checked: rows.length, problems };
  }

  // --- État fiscal ------------------------------------------------------------

  /** Ajustements approuvés dont l'approbation tombe dans la période : c'est là qu'ils comptent. */
  private appliedIn(storeId: string, from: string, to: string): FiscalAdjustment[] {
    return this.list(storeId, { status: 'approved' })
      .filter((a) => {
        const day = this.db.prepare("SELECT date(?, 'localtime')").pluck().get(a.decided_at) as string;
        return day >= from && day <= to;
      })
      .reverse();
  }

  statement(storeId: string, from: string, to: string): FiscalStatement {
    this.period(from, to);
    const store = this.db.prepare('SELECT id, code, name, vat_enabled FROM stores WHERE id = ?').get(storeId) as { id: string; code: string; name: string; vat_enabled: number } | undefined;
    if (!store) throw new AppError('Magasin introuvable', 'NOT_FOUND');
    const { byRate, counts } = this.realBase(storeId, from, to);
    const applied = this.appliedIn(storeId, from, to);
    const pending = this.list(storeId, { status: 'pending' });
    const adjByRate = new Map<number, { ttc: number; ht: number; tva: number }>();
    for (const a of applied) {
      for (const e of a.effects) {
        const c = adjByRate.get(e.rate) ?? zero();
        adjByRate.set(e.rate, { ttc: c.ttc + e.ttc, ht: c.ht + e.ht, tva: c.tva + e.tva });
      }
    }
    const rates = [...new Set([...byRate.keys(), ...adjByRate.keys()])].sort((a, b) => b - a);
    const categories: FiscalCategory[] = rates.map((rate) => {
      const real = byRate.get(rate) ?? zero();
      const adj = adjByRate.get(rate) ?? zero();
      return { rate, label: this.categoryLabel(storeId, rate), real, adjustments: adj, declared: { ttc: real.ttc + adj.ttc, ht: real.ht + adj.ht, tva: real.tva + adj.tva } };
    });
    const sum = (k: 'real' | 'adjustments' | 'declared') =>
      categories.reduce((t, c) => ({ ttc: t.ttc + c[k].ttc, ht: t.ht + c[k].ht, tva: t.tva + c[k].tva }), zero());
    const real = sum('real');
    const adjustments = sum('adjustments');
    const declared = sum('declared');
    const unexplained = declared.ht - real.ht - adjustments.ht;
    const settings = this.tax.settings(storeId, Number(from.slice(0, 4)));
    const principal = pct(Math.max(declared.ht, 0), settings.rates.minimumRate);
    const cac = pct(principal, TAX_DEFAULTS.cacRate);
    return {
      store: { id: store.id, code: store.code, name: store.name, vatEnabled: store.vat_enabled === 1 },
      from,
      to,
      regime: settings.regime,
      categories,
      real: { ...real, sales: counts.sales, returns: counts.returns, cancelled: counts.cancelled, cancelledTtc: counts.cancelledTtc },
      adjustments,
      declared,
      reconciliation: { realHt: real.ht, adjustmentsHt: adjustments.ht, declaredHt: declared.ht, unexplained, balanced: unexplained === 0 },
      sourceCheck: { headersTtc: counts.headersTtc, linesTtc: real.ttc, ok: counts.headersTtc === real.ttc },
      applied,
      pending,
      obligations: {
        vatCollected: store.vat_enabled === 1 ? declared.tva : 0,
        instalment: { rate: settings.rates.minimumRate, principal, cac, total: principal + cac },
      },
    };
  }

  /** Fige l'état de la période : il est gardé tel quel, avec son empreinte, et ne se modifie plus. */
  generate(ctx: Context, from: string, to: string): GeneratedStatement {
    const st = this.statement(ctx.storeId, from, to);
    if (!st.reconciliation.balanced) throw new AppError('L’état ne se rapproche pas des ventes réelles : il ne peut pas être généré', 'INVALID');
    return this.tx(() => {
      const id = newId();
      const number = `EF-${this.stationPrefix()}-${String(this.nextCounter('fiscal_statement.number')).padStart(5, '0')}`;
      const payload = JSON.stringify(st);
      const hash = sha(payload);
      this.db
        .prepare(
          `INSERT INTO fiscal_statements (id, number, store_id, period_from, period_to, real_ht, declared_ht, payload, generated_by, generated_at, hash)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, number, ctx.storeId, from, to, st.real.ht, st.declared.ht, payload, ctx.userId, this.now(), hash);
      this.enqueue(ctx, 'fiscal_statement', id, 'upsert', {});
      this.log(ctx, 'statement', id, 'generate', null, { number, from, to, realHt: st.real.ht, declaredHt: st.declared.ht, payloadHash: hash });
      this.audit(ctx.userId, 'fiscal.generate', 'fiscal_statement', id, { number, from, to });
      return this.statements(ctx.storeId).find((s) => s.id === id)!;
    });
  }

  statements(storeId: string): GeneratedStatement[] {
    return this.db
      .prepare(
        `SELECT f.id, f.number, f.period_from, f.period_to, f.real_ht, f.declared_ht, f.generated_by, u.name AS generated_by_name, f.generated_at, f.hash
         FROM fiscal_statements f LEFT JOIN users u ON u.id = f.generated_by WHERE f.store_id = ? ORDER BY f.generated_at DESC`,
      )
      .all(storeId) as GeneratedStatement[];
  }

  /** État généré, tel qu'il a été figé, et si son empreinte est toujours bonne. */
  getStatement(id: string): GeneratedStatement & { statement: FiscalStatement; intact: boolean } {
    const row = this.db.prepare('SELECT store_id, payload, hash FROM fiscal_statements WHERE id = ?').get(id) as { store_id: string; payload: string; hash: string } | undefined;
    if (!row) throw new AppError('État fiscal introuvable', 'NOT_FOUND');
    const head = this.statements(row.store_id).find((s) => s.id === id)!;
    return { ...head, statement: JSON.parse(row.payload) as FiscalStatement, intact: sha(row.payload) === row.hash };
  }

  /** Export de la préparation fiscale, séparé de celui des ventes réelles : chaque ajustement porte l'identifiant de sa vente. */
  exportCsv(st: FiscalStatement, ref?: { number: string; generated_at: string; hash: string } | null): string {
    const out: (string | number | null)[][] = [];
    out.push(['Préparation fiscale', st.store.name, `Du ${st.from} au ${st.to}`, ref ? `État ${ref.number} généré le ${ref.generated_at}` : 'État provisoire (non généré)', ref ? `Empreinte ${ref.hash}` : '']);
    out.push([]);
    out.push(['Catégorie fiscale', 'Taux TVA %', 'Réel TTC', 'Réel HT', 'Réel TVA', 'Ajustements TTC', 'Ajustements HT', 'Ajustements TVA', 'Déclaré TTC', 'Déclaré HT', 'Déclaré TVA']);
    for (const c of st.categories) {
      out.push([c.label, (c.rate / 100).toString().replace('.', ','), c.real.ttc, c.real.ht, c.real.tva, c.adjustments.ttc, c.adjustments.ht, c.adjustments.tva, c.declared.ttc, c.declared.ht, c.declared.tva]);
    }
    out.push(['Total', '', st.real.ttc, st.real.ht, st.real.tva, st.adjustments.ttc, st.adjustments.ht, st.adjustments.tva, st.declared.ttc, st.declared.ht, st.declared.tva]);
    out.push([]);
    out.push(['Rapprochement', 'CA réel HT', 'Ajustements approuvés HT', 'CA déclaré HT', 'Écart non justifié']);
    out.push(['', st.reconciliation.realHt, st.reconciliation.adjustmentsHt, st.reconciliation.declaredHt, st.reconciliation.unexplained]);
    out.push([]);
    out.push(['N° ajustement', 'Type', 'Identifiant vente', 'N° vente', 'Catégorie', 'Vers', 'Effet TTC', 'Effet HT', 'Effet TVA', 'Motif', 'Pièce', 'Proposé par', 'Le', 'Approuvé par', 'Le']);
    for (const a of st.applied) {
      const e = a.effects.reduce((t, x) => ({ ttc: t.ttc + x.ttc, ht: t.ht + x.ht, tva: t.tva + x.tva }), zero());
      out.push([
        a.number,
        FISCAL_KIND_LABELS[a.kind],
        a.sale_id,
        a.sale_number,
        (a.vat_rate_bp / 100).toString().replace('.', ','),
        a.to_vat_rate_bp === null ? '' : (a.to_vat_rate_bp / 100).toString().replace('.', ','),
        e.ttc,
        e.ht,
        e.tva,
        a.reason,
        a.reference,
        a.created_by_name,
        a.created_at,
        a.decided_by_name,
        a.decided_at,
      ]);
    }
    out.push([]);
    out.push(['TVA collectée déclarée', st.obligations.vatCollected]);
    out.push([`Acompte (minimum de perception ${(st.obligations.instalment.rate / 100).toString().replace('.', ',')} % + CAC)`, st.obligations.instalment.total]);
    return '﻿' + out.map((r) => r.map(esc).join(';')).join('\r\n');
  }
}
