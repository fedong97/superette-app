import { createHash } from 'node:crypto';
import { type Fcfa, formatRate, splitTtc } from '@superette/core';
import type { AccountingService } from './accounting';
import type { ReportService } from './reports';
import type { TaxRegime, TaxService } from './tax';
import { TAX_DEFAULTS } from './tax';
import { type RegimeCode, rulesetFor } from './taxRules';
import { AppError, Base, type Clock, type Context, newId } from './util';
import type { Db } from './database';

export interface FiscalCategory {
  rate: number;
  label: string;
  ttc: Fcfa;
  ht: Fcfa;
  tva: Fcfa;
}

/** Avoir client de la période : un retour enregistré dans les ventes réelles, donc en caisse et en comptabilité. */
export interface FiscalCreditNote {
  sale_id: string;
  number: string;
  created_at: string;
  original_sale_id: string | null;
  original_number: string | null;
  customer_name: string | null;
  reason: string | null;
  ttc: Fcfa;
  ht: Fcfa;
  tva: Fcfa;
}

export interface FiscalStatement {
  store: { id: string; code: string; name: string; vatEnabled: boolean };
  from: string;
  to: string;
  regime: TaxRegime;
  /** Chiffre d'affaires par catégorie fiscale : ventes moins avoirs, tels qu'enregistrés. */
  categories: FiscalCategory[];
  totals: { ttc: Fcfa; ht: Fcfa; tva: Fcfa };
  counts: { sales: number; creditNotes: number; cancelled: number; cancelledTtc: Fcfa };
  /** Ventes de la période avant avoirs. */
  gross: { ttc: Fcfa; ht: Fcfa; tva: Fcfa };
  creditNotes: FiscalCreditNote[];
  /**
   * Contrôle avec la comptabilité : le chiffre d'affaires et la TVA des comptes (ventes de
   * marchandises, TVA collectée) sur la période, comparés aux ventes réelles. Un écart vient
   * d'une écriture manuelle sur ces comptes : il se corrige en comptabilité, jamais ici.
   */
  books: {
    salesAccount: string;
    vatAccount: string;
    salesHt: Fcfa;
    vatCollected: Fcfa;
    differenceHt: Fcfa;
    differenceTva: Fcfa;
    /** Ristournes et remises accordées après coup (compte des ristournes) : à titre d'information. */
    rebatesAccount: string;
    rebates: Fcfa;
    matches: boolean;
  };
  /** Contrôle de la source : totaux des tickets contre leurs lignes. */
  sourceCheck: { headersTtc: Fcfa; linesTtc: Fcfa; ok: boolean };
  /**
   * Concordance des vues : le journal des ventes, la vue de gestion (rapports de ventes) et
   * cet état totalisent le même chiffre d'affaires TTC. Aucune vue ne peut afficher moins.
   */
  concordance: { journalTtc: Fcfa; managementTtc: Fcfa; fiscalTtc: Fcfa; ok: boolean };
  obligations: {
    vatCollected: Fcfa;
    /** Acompte (minimum de perception) sur le chiffre d'affaires HT, avec les CAC. */
    instalment: { rate: number; principal: Fcfa; cac: Fcfa; total: Fcfa };
  };
}

export interface GeneratedStatement {
  id: string;
  number: string;
  period_from: string;
  period_to: string;
  turnover_ht: Fcfa;
  generated_by: string;
  generated_by_name: string | null;
  generated_at: string;
  hash: string;
}

export type DeclarationKind = 'initial' | 'rectificative';

/** Ce qui a été reporté sur une déclaration réellement déposée à l'administration. */
export interface DeclarationInput {
  /** Mois déclaré, AAAA-MM. */
  period: string;
  kind: DeclarationKind;
  turnoverHt: Fcfa;
  vat: Fcfa;
  /** Numéro de télédéclaration ou de quittance. */
  reference: string;
  filedOn: string;
  note?: string | null;
}

export interface FiscalDeclaration {
  id: string;
  period: string;
  kind: DeclarationKind;
  turnover_ht: Fcfa;
  vat: Fcfa;
  reference: string;
  filed_on: string;
  note: string | null;
  user_id: string;
  user_name: string | null;
  created_at: string;
}

/** Pièce réelle qui explique un écart : avoir, ticket annulé, écriture comptable, déclaration rectificative ; « autre » sans pièce. */
export type JustificationKind = 'credit_note' | 'cancellation' | 'entry' | 'rectificative' | 'other';

export interface JustificationInput {
  declarationId: string;
  kind: JustificationKind;
  refId?: string | null;
  explanation: string;
}

export interface FiscalJustification {
  id: string;
  declaration_id: string;
  kind: JustificationKind;
  ref_id: string | null;
  ref_label: string | null;
  explanation: string;
  user_id: string;
  user_name: string | null;
  created_at: string;
}

export type ReconciliationStatus = 'not_declared' | 'concordant' | 'under' | 'over';

/** Un mois : ventes réelles, dernière déclaration déposée, écart (déclaré moins réel) et justifications. */
export interface ReconciliationMonth {
  period: string;
  from: string;
  to: string;
  real: { ht: Fcfa; tva: Fcfa };
  declared: FiscalDeclaration | null;
  declarations: FiscalDeclaration[];
  gapHt: Fcfa;
  gapTva: Fcfa;
  status: ReconciliationStatus;
  justifications: FiscalJustification[];
}

/** Ligne du registre des ventes : chaque document, dans l'ordre de sa numérotation. */
export interface RegisterRow {
  id: string;
  number: string;
  created_at: string;
  kind: 'sale' | 'return';
  status: 'completed' | 'cancelled';
  customer_name: string | null;
  original_number: string | null;
  ht: Fcfa;
  tva: Fcfa;
  ttc: Fcfa;
}

/** Dossier de contrôle : tout ce que l'administration demande, dans l'ordre où elle le lit. */
export interface ControlFile {
  store: { name: string; code: string; taxpayerNumber: string | null; address: string | null };
  editedAt: string;
  statement: FiscalStatement;
  register: RegisterRow[];
  vat: { month: string; collected: Fcfa; deductible: Fcfa; due: Fcfa; credit: Fcfa }[];
  reconciliation: ReconciliationMonth[];
  generated: GeneratedStatement[];
}

export type RegimeStatus = 'applicable' | 'option' | 'excluded';

export interface RegimeSimulation {
  code: RegimeCode;
  label: string;
  status: RegimeStatus;
  threshold: string;
  minimum: { rate: number; principal: Fcfa; cac: Fcfa; total: Fcfa } | null;
  /** Impôt sur le résultat, null pour un forfait. */
  resultTax: Fcfa | null;
  /** Montant dû : le plus élevé de l'impôt sur le résultat et du minimum ; null pour un forfait communal. */
  due: Fcfa | null;
  obligations: string;
}

/** Ce que coûterait chaque régime, calculé sur les ventes réelles et le résultat comptable de l'année. */
export interface TaxSimulation {
  year: number;
  provisional: boolean;
  form: 'company' | 'individual';
  turnoverHt: Fcfa;
  taxableIncome: Fcfa;
  resultTax: { rate: number; principal: Fcfa; cac: Fcfa; total: Fcfa };
  regimes: RegimeSimulation[];
  ruleset: { validFrom: string; source: string; checkedOn: string };
}

export interface FiscalLogEntry {
  id: string;
  entity: 'statement' | 'declaration' | 'justification';
  entity_id: string;
  number: string | null;
  action: 'generate' | 'record' | 'justify';
  user_id: string;
  user_name: string | null;
  at: string;
  hash: string;
  prev_hash: string | null;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH = /^\d{4}-\d{2}$/;
const lastDay = (month: string) => {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return `${month}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`;
};
export const STATUS_LABEL: Record<ReconciliationStatus, string> = {
  not_declared: 'Pas encore déclaré',
  concordant: 'Concordant',
  under: 'Sous-déclaré : à régulariser par une déclaration rectificative',
  over: 'Sur-déclaré : à régulariser par une déclaration rectificative',
};
export const JUSTIFICATION_LABEL: Record<JustificationKind, string> = {
  credit_note: 'Avoir client',
  cancellation: 'Ticket annulé',
  entry: 'Écriture comptable',
  rectificative: 'Déclaration rectificative',
  other: 'Autre explication',
};
const JUSTIFICATION_KINDS: JustificationKind[] = ['credit_note', 'cancellation', 'entry', 'rectificative', 'other'];
const sha = (v: unknown) => createHash('sha256').update(typeof v === 'string' ? v : JSON.stringify(v)).digest('hex');
const pct = (amount: number, bp: number) => Math.round((amount * bp) / 10_000);
const zero = () => ({ ttc: 0, ht: 0, tva: 0 });
const esc = (v: string | number | null | undefined) => {
  const s = String(v ?? '');
  return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/**
 * Préparation fiscale : état comptable et fiscal d'une période, lu uniquement dans les
 * ventes réelles et la comptabilité.
 *
 * Ce module n'enregistre aucune opération et ne modifie rien : il n'a ni avoir, ni
 * correction, ni ajustement à lui. Un avoir est un vrai avoir client (retour ou
 * annulation faits à la caisse), déjà dans les ventes réelles et comptabilisé ; une
 * correction se fait en comptabilité. Le chiffre de l'état est donc toujours celui des
 * livres, et le contrôle avec les comptes le montre. Seul l'état d'une période peut être
 * figé (« généré »), avec son empreinte, dans un journal qu'on ne peut ni modifier ni effacer.
 */
export class FiscalPrepService extends Base {
  constructor(
    db: Db,
    clock: Clock,
    private readonly accounting: AccountingService,
    private readonly tax: TaxService,
    private readonly reports: ReportService,
  ) {
    super(db, clock);
  }

  private vatEnabled(storeId: string): boolean {
    return (this.db.prepare('SELECT vat_enabled FROM stores WHERE id = ?').pluck().get(storeId) as number | undefined) === 1;
  }

  categoryLabel(storeId: string, rate: number): string {
    if (rate === 0) return this.vatEnabled(storeId) ? 'Exonéré ou non taxable (0 %)' : 'TVA non applicable (non assujetti)';
    return `Taxable à la TVA ${formatRate(rate)}`;
  }

  statement(storeId: string, from: string, to: string): FiscalStatement {
    if (!DATE.test(from) || !DATE.test(to) || from > to) throw new AppError('Période invalide', 'INVALID');
    const store = this.db.prepare('SELECT id, code, name, vat_enabled FROM stores WHERE id = ?').get(storeId) as { id: string; code: string; name: string; vat_enabled: number } | undefined;
    if (!store) throw new AppError('Magasin introuvable', 'NOT_FOUND');

    // Même calcul que les tickets : TVA taux par taux, document par document.
    const perDoc = this.db
      .prepare(
        `SELECT l.sale_id, s.kind, l.vat_rate_bp AS rate, SUM(l.total_ttc) AS ttc FROM sale_lines l JOIN sales s ON s.id = l.sale_id
         WHERE s.store_id = ? AND s.status = 'completed' AND date(s.created_at, 'localtime') BETWEEN ? AND ?
         GROUP BY l.sale_id, l.vat_rate_bp`,
      )
      .all(storeId, from, to) as { sale_id: string; kind: 'sale' | 'return'; rate: number; ttc: number }[];
    const byRate = new Map<number, { ttc: number; ht: number; tva: number }>();
    const gross = zero();
    const creditByDoc = new Map<string, { ttc: number; ht: number; tva: number }>();
    for (const r of perDoc) {
      const { ht, tva } = splitTtc(r.ttc, r.rate);
      const c = byRate.get(r.rate) ?? zero();
      byRate.set(r.rate, { ttc: c.ttc + r.ttc, ht: c.ht + ht, tva: c.tva + tva });
      if (r.kind === 'sale') {
        gross.ttc += r.ttc;
        gross.ht += ht;
        gross.tva += tva;
      } else {
        const d = creditByDoc.get(r.sale_id) ?? zero();
        creditByDoc.set(r.sale_id, { ttc: d.ttc + r.ttc, ht: d.ht + ht, tva: d.tva + tva });
      }
    }
    const categories = [...byRate.entries()].sort(([a], [b]) => b - a).map(([rate, v]) => ({ rate, label: this.categoryLabel(storeId, rate), ...v }));
    const totals = categories.reduce((t, c) => ({ ttc: t.ttc + c.ttc, ht: t.ht + c.ht, tva: t.tva + c.tva }), zero());

    const creditNotes = (
      this.db
        .prepare(
          `SELECT s.id AS sale_id, s.number, s.created_at, s.original_sale_id, o.number AS original_number, COALESCE(c.name, o.client_name) AS customer_name, s.cancel_reason AS reason
           FROM sales s LEFT JOIN sales o ON o.id = s.original_sale_id LEFT JOIN customers c ON c.id = s.customer_id
           WHERE s.store_id = ? AND s.kind = 'return' AND s.status = 'completed' AND date(s.created_at, 'localtime') BETWEEN ? AND ?
           ORDER BY s.created_at, s.number`,
        )
        .all(storeId, from, to) as Omit<FiscalCreditNote, 'ttc' | 'ht' | 'tva'>[]
    ).map((r) => ({ ...r, ...(creditByDoc.get(r.sale_id) ?? zero()) }));

    const counts = this.db
      .prepare(
        `SELECT COUNT(CASE WHEN status = 'completed' AND kind = 'sale' THEN 1 END) AS sales,
                COUNT(CASE WHEN status = 'completed' AND kind = 'return' THEN 1 END) AS creditNotes,
                COUNT(CASE WHEN status = 'cancelled' THEN 1 END) AS cancelled,
                COALESCE(SUM(CASE WHEN status = 'cancelled' THEN total_ttc END), 0) AS cancelledTtc,
                COALESCE(SUM(CASE WHEN status = 'completed' THEN total_ttc END), 0) AS headersTtc
         FROM sales WHERE store_id = ? AND date(created_at, 'localtime') BETWEEN ? AND ?`,
      )
      .get(storeId, from, to) as { sales: number; creditNotes: number; cancelled: number; cancelledTtc: number; headersTtc: number };

    // Comptabilité de la période : solde créditeur des comptes de ventes, de TVA collectée et de ristournes.
    const roles = this.accounting.roles();
    const net = new Map<string, number>();
    for (const e of this.accounting.entries(storeId, { from, to })) {
      if (e.closing) continue;
      for (const l of e.lines) net.set(l.account, (net.get(l.account) ?? 0) + l.credit - l.debit);
    }
    const salesHt = net.get(roles.sales) ?? 0;
    const vatCollected = net.get(roles.vat_collected) ?? 0;
    const rebates = -(net.get(roles.rebates) ?? 0);

    const settings = this.tax.settings(storeId, Number(from.slice(0, 4)));
    const principal = pct(Math.max(totals.ht, 0), settings.rates.minimumRate);
    const cac = pct(principal, TAX_DEFAULTS.cacRate);
    const { headersTtc, ...docCounts } = counts;
    const managementTtc = this.reports.sales(storeId, { from, to, dimension: 'day' }).totals.revenueTtc;
    return {
      store: { id: store.id, code: store.code, name: store.name, vatEnabled: store.vat_enabled === 1 },
      from,
      to,
      regime: settings.regime,
      categories,
      totals,
      counts: docCounts,
      gross,
      creditNotes,
      books: {
        salesAccount: roles.sales,
        vatAccount: roles.vat_collected,
        salesHt,
        vatCollected,
        differenceHt: salesHt - totals.ht,
        differenceTva: vatCollected - totals.tva,
        rebatesAccount: roles.rebates,
        rebates,
        matches: salesHt === totals.ht && vatCollected === totals.tva,
      },
      sourceCheck: { headersTtc, linesTtc: totals.ttc, ok: headersTtc === totals.ttc },
      concordance: { journalTtc: headersTtc, managementTtc, fiscalTtc: totals.ttc, ok: headersTtc === totals.ttc && managementTtc === totals.ttc },
      obligations: {
        vatCollected: store.vat_enabled === 1 ? totals.tva : 0,
        instalment: { rate: settings.rates.minimumRate, principal, cac, total: principal + cac },
      },
    };
  }

  // --- Rapprochement avec les déclarations déposées ------------------------------

  /**
   * Inscrit une déclaration réellement déposée (ce qui a été reporté sur le formulaire). Elle ne
   * change jamais l'état fiscal : elle sert à montrer l'écart avec les ventes réelles. Une erreur se
   * régularise par une déclaration rectificative, inscrite à son tour.
   */
  recordDeclaration(ctx: Context, input: DeclarationInput): FiscalDeclaration {
    const period = String(input.period ?? '');
    if (!MONTH.test(period)) throw new AppError('Mois déclaré invalide (AAAA-MM)', 'INVALID');
    if (period > this.today().slice(0, 7)) throw new AppError('On ne déclare pas un mois qui n’a pas commencé', 'INVALID');
    if (!['initial', 'rectificative'].includes(input.kind)) throw new AppError('Type de déclaration inconnu', 'INVALID');
    for (const v of [input.turnoverHt, input.vat]) if (!Number.isInteger(v) || v < 0) throw new AppError('Montant déclaré invalide', 'INVALID');
    const reference = String(input.reference ?? '').trim();
    if (reference.length < 3) throw new AppError('Indiquez le numéro de la télédéclaration ou de la quittance', 'INVALID');
    if (!DATE.test(input.filedOn ?? '') || input.filedOn < `${period}-01` || input.filedOn > this.today()) throw new AppError('Date de dépôt invalide', 'INVALID');
    const existing = this.declarations(ctx.storeId).filter((d) => d.period === period);
    if (input.kind === 'initial' && existing.length) throw new AppError('Ce mois a déjà une déclaration : enregistrez une déclaration rectificative', 'INVALID');
    if (input.kind === 'rectificative' && !existing.length) throw new AppError('Une déclaration rectificative suit une déclaration initiale', 'INVALID');
    return this.tx(() => {
      const id = newId();
      this.db
        .prepare(
          `INSERT INTO fiscal_declarations (id, store_id, period, kind, turnover_ht, vat, reference, filed_on, note, user_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, ctx.storeId, period, input.kind, input.turnoverHt, input.vat, reference, input.filedOn, input.note?.trim() || null, ctx.userId, this.now());
      const row = this.db.prepare('SELECT * FROM fiscal_declarations WHERE id = ?').get(id);
      this.enqueue(ctx, 'fiscal_declaration', id, 'upsert', {});
      this.log(ctx, 'declaration', 'record', id, { period, kind: input.kind, turnoverHt: input.turnoverHt, vat: input.vat, reference, rowHash: sha(row) });
      this.audit(ctx.userId, 'fiscal.declaration', 'fiscal_declaration', id, { period, kind: input.kind, reference });
      return this.declarations(ctx.storeId).find((d) => d.id === id)!;
    });
  }

  declarations(storeId: string): FiscalDeclaration[] {
    return this.db
      .prepare(
        `SELECT d.id, d.period, d.kind, d.turnover_ht, d.vat, d.reference, d.filed_on, d.note, d.user_id, u.name AS user_name, d.created_at
         FROM fiscal_declarations d LEFT JOIN users u ON u.id = d.user_id WHERE d.store_id = ? ORDER BY d.period, d.created_at, d.rowid`,
      )
      .all(storeId) as FiscalDeclaration[];
  }

  /**
   * Explique un écart par une vraie pièce : avoir client, ticket annulé, écriture comptable ou
   * déclaration rectificative (ou « autre », sans pièce, expliqué en clair). La justification
   * documente l'écart ; elle ne change aucun montant, ni des ventes, ni de l'état, ni du déclaré.
   */
  justify(ctx: Context, input: JustificationInput): FiscalJustification {
    const decl = this.db.prepare('SELECT * FROM fiscal_declarations WHERE id = ? AND store_id = ?').get(input.declarationId, ctx.storeId) as
      | { id: string; period: string; created_at: string }
      | undefined;
    if (!decl) throw new AppError('Déclaration introuvable', 'NOT_FOUND');
    if (!JUSTIFICATION_KINDS.includes(input.kind)) throw new AppError('Type de justification inconnu', 'INVALID');
    const explanation = String(input.explanation ?? '').trim();
    if (explanation.length < 15) throw new AppError('Expliquez l’écart en une phrase (15 caractères au moins)', 'INVALID');
    const refId = input.refId?.trim() || null;
    let refLabel: string | null = null;
    if (input.kind === 'other') {
      if (refId) throw new AppError('« Autre » ne porte pas de pièce : choisissez le type de la pièce', 'INVALID');
    } else {
      if (!refId) throw new AppError('Choisissez la pièce qui explique l’écart', 'INVALID');
      refLabel = this.pieceLabel(ctx.storeId, input.kind, refId, decl);
    }
    return this.tx(() => {
      const id = newId();
      this.db
        .prepare(
          `INSERT INTO fiscal_justifications (id, store_id, declaration_id, kind, ref_id, ref_label, explanation, user_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, ctx.storeId, decl.id, input.kind, refId, refLabel, explanation, ctx.userId, this.now());
      const row = this.db.prepare('SELECT * FROM fiscal_justifications WHERE id = ?').get(id);
      this.enqueue(ctx, 'fiscal_justification', id, 'upsert', {});
      this.log(ctx, 'justification', 'justify', id, { declarationId: decl.id, kind: input.kind, refId, rowHash: sha(row) });
      this.audit(ctx.userId, 'fiscal.justify', 'fiscal_justification', id, { declarationId: decl.id, kind: input.kind, refId });
      return this.justifications(ctx.storeId).find((j) => j.id === id)!;
    });
  }

  /** Libellé de la pièce, qui doit exister dans les ventes réelles, la comptabilité ou les déclarations du magasin. */
  private pieceLabel(storeId: string, kind: Exclude<JustificationKind, 'other'>, refId: string, decl: { id: string; period: string; created_at: string }): string {
    if (kind === 'credit_note' || kind === 'cancellation') {
      const sale = this.db.prepare('SELECT number, kind, status FROM sales WHERE id = ? AND store_id = ?').get(refId, storeId) as { number: string; kind: string; status: string } | undefined;
      if (kind === 'credit_note' && sale?.kind === 'return' && sale.status === 'completed') return `Avoir ${sale.number}`;
      if (kind === 'cancellation' && sale?.status === 'cancelled') return `Ticket annulé ${sale.number}`;
      throw new AppError(kind === 'credit_note' ? 'Avoir introuvable dans les ventes réelles' : 'Ticket annulé introuvable dans les ventes réelles', 'INVALID');
    }
    if (kind === 'entry') {
      const e = this.db.prepare('SELECT number, label FROM manual_entries WHERE id = ? AND store_id = ?').get(refId, storeId) as { number: string; label: string } | undefined;
      if (!e) throw new AppError('Écriture introuvable en comptabilité', 'INVALID');
      return `Écriture ${e.number} : ${e.label}`;
    }
    const r = this.db.prepare('SELECT period, kind, reference, created_at FROM fiscal_declarations WHERE id = ? AND store_id = ?').get(refId, storeId) as
      | { period: string; kind: string; reference: string; created_at: string }
      | undefined;
    if (!r || r.kind !== 'rectificative' || r.period !== decl.period || refId === decl.id || r.created_at < decl.created_at)
      throw new AppError('Déclaration rectificative introuvable pour ce mois', 'INVALID');
    return `Déclaration rectificative ${r.reference}`;
  }

  justifications(storeId: string): FiscalJustification[] {
    return this.db
      .prepare(
        `SELECT j.id, j.declaration_id, j.kind, j.ref_id, j.ref_label, j.explanation, j.user_id, u.name AS user_name, j.created_at
         FROM fiscal_justifications j LEFT JOIN users u ON u.id = j.user_id WHERE j.store_id = ? ORDER BY j.created_at, j.rowid`,
      )
      .all(storeId) as FiscalJustification[];
  }

  /**
   * Rapprochement mois par mois : ventes réelles, dernière déclaration déposée, écart (déclaré
   * moins réel) et ses justifications. Le réel est toujours celui des ventes : rien ici ne le
   * rapproche du déclaré. Un mois sous-déclaré le reste tant qu'une rectificative ne l'a pas réglé.
   */
  reconciliation(storeId: string, from: string, to: string): ReconciliationMonth[] {
    if (!DATE.test(from) || !DATE.test(to) || from > to) throw new AppError('Période invalide', 'INVALID');
    const declarations = this.declarations(storeId);
    const justifications = this.justifications(storeId);
    const out: ReconciliationMonth[] = [];
    const current = this.today().slice(0, 7);
    for (let period = from.slice(0, 7); period <= to.slice(0, 7) && period <= current; ) {
      const mFrom = `${period}-01`;
      const mTo = lastDay(period);
      const st = this.statement(storeId, mFrom, mTo);
      const real = { ht: st.totals.ht, tva: st.totals.tva };
      const list = declarations.filter((d) => d.period === period);
      const declared = list.at(-1) ?? null;
      const gapHt = declared ? declared.turnover_ht - real.ht : 0;
      const gapTva = declared ? declared.vat - real.tva : 0;
      const ids = new Set(list.map((d) => d.id));
      out.push({
        period,
        from: mFrom,
        to: mTo,
        real,
        declared,
        declarations: list,
        gapHt,
        gapTva,
        status: !declared ? 'not_declared' : !gapHt && !gapTva ? 'concordant' : gapHt < 0 || gapTva < 0 ? 'under' : 'over',
        justifications: justifications.filter((j) => ids.has(j.declaration_id)),
      });
      const [y, m] = period.split('-').map(Number) as [number, number];
      period = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
    }
    return out;
  }

  // --- Dossier de contrôle ---------------------------------------------------------

  /** Dossier de contrôle de la période : identification, registre, avoirs, TVA, contrôles, rapprochement, états figés. */
  controlFile(storeId: string, from: string, to: string): ControlFile {
    const statement = this.statement(storeId, from, to);
    const store = this.db.prepare('SELECT name, code, taxpayer_number, address FROM stores WHERE id = ?').get(storeId) as {
      name: string;
      code: string;
      taxpayer_number: string | null;
      address: string | null;
    };
    const register = this.db
      .prepare(
        `SELECT s.id, s.number, s.created_at, s.kind, s.status, COALESCE(c.name, s.client_name) AS customer_name, o.number AS original_number,
                s.total_ht AS ht, s.total_tva AS tva, s.total_ttc AS ttc
         FROM sales s LEFT JOIN customers c ON c.id = s.customer_id LEFT JOIN sales o ON o.id = s.original_sale_id
         WHERE s.store_id = ? AND s.status IN ('completed', 'cancelled') AND date(s.created_at, 'localtime') BETWEEN ? AND ?
         ORDER BY s.created_at, s.number`,
      )
      .all(storeId, from, to) as RegisterRow[];
    const reconciliation = this.reconciliation(storeId, from, to);
    const vat: ControlFile['vat'] = [];
    for (const m of reconciliation) {
      const r = this.accounting.vatReturn(storeId, m.period);
      vat.push({ month: m.period, collected: r.collected, deductible: r.deductible, due: r.due, credit: r.credit });
    }
    return {
      store: { name: store.name, code: store.code, taxpayerNumber: store.taxpayer_number, address: store.address },
      editedAt: this.now(),
      statement,
      register,
      vat,
      reconciliation,
      generated: this.statements(storeId).filter((g) => g.period_from <= to && g.period_to >= from),
    };
  }

  /** Dossier de contrôle en CSV, dans l'ordre de lecture du contrôleur ; chaque document porte son identifiant de vente. */
  exportControlCsv(f: ControlFile): string {
    const st = f.statement;
    const rate = (bp: number) => (bp / 100).toString().replace('.', ',');
    const out: (string | number | null)[][] = [];
    out.push(['Dossier de contrôle', f.store.name, f.store.taxpayerNumber ? `NIU ${f.store.taxpayerNumber}` : '', `Du ${st.from} au ${st.to}`, `Édité le ${f.editedAt}`]);
    out.push(['Régime', st.regime === 'reel' ? 'Réel' : 'Simplifié']);
    out.push([]);
    out.push(['1. Registre des ventes']);
    out.push(['N°', 'Identifiant vente', 'Date', 'Type', 'Statut', 'Client', 'Facture d’origine', 'HT', 'TVA', 'TTC']);
    for (const r of f.register)
      out.push([r.number, r.id, r.created_at, r.kind === 'return' ? 'Avoir' : 'Vente', r.status === 'cancelled' ? 'Annulée (hors chiffre d’affaires)' : 'Validée', r.customer_name, r.original_number, r.ht, r.tva, r.ttc]);
    out.push([]);
    out.push(['2. Avoirs clients']);
    out.push(['N° avoir', 'Identifiant vente', 'Date', 'Facture d’origine', 'Identifiant facture d’origine', 'Client', 'TTC', 'HT', 'TVA', 'Motif']);
    for (const a of st.creditNotes) out.push([a.number, a.sale_id, a.created_at, a.original_number, a.original_sale_id, a.customer_name, a.ttc, a.ht, a.tva, a.reason]);
    out.push([]);
    out.push(['3. Chiffre d’affaires par catégorie fiscale']);
    out.push(['Catégorie fiscale', 'Taux TVA %', 'TTC', 'HT', 'TVA']);
    for (const c of st.categories) out.push([c.label, rate(c.rate), c.ttc, c.ht, c.tva]);
    out.push(['Total', '', st.totals.ttc, st.totals.ht, st.totals.tva]);
    out.push([]);
    out.push(['4. TVA du mois']);
    out.push(['Mois', 'Collectée', 'Déductible (achats et frais)', 'À payer', 'Crédit à reporter']);
    for (const v of f.vat) out.push([v.month, v.collected, v.deductible, v.due, v.credit]);
    out.push([]);
    out.push(['5. Contrôle avec la comptabilité', 'Compte', 'Comptabilité', 'Ventes réelles', 'Écart']);
    out.push(['Ventes HT', st.books.salesAccount, st.books.salesHt, st.totals.ht, st.books.differenceHt]);
    out.push(['TVA collectée', st.books.vatAccount, st.books.vatCollected, st.totals.tva, st.books.differenceTva]);
    out.push([]);
    out.push(['6. Concordance des vues (TTC)', 'Journal des ventes', 'Vue de gestion', 'État fiscal', 'Concordent']);
    out.push(['', st.concordance.journalTtc, st.concordance.managementTtc, st.concordance.fiscalTtc, st.concordance.ok ? 'Oui' : 'Non']);
    out.push([]);
    out.push(['7. Rapprochement avec les déclarations déposées']);
    out.push(['Mois', 'Réel HT', 'Réel TVA', 'Déclaré HT', 'Déclaré TVA', 'Écart HT', 'Écart TVA', 'Situation', 'Déclaration', 'Déposée le']);
    for (const m of f.reconciliation) {
      const d = m.declared;
      out.push([m.period, m.real.ht, m.real.tva, d?.turnover_ht ?? '', d?.vat ?? '', d ? m.gapHt : '', d ? m.gapTva : '', STATUS_LABEL[m.status], d ? `${d.kind === 'rectificative' ? 'Rectificative' : 'Initiale'} ${d.reference}` : '', d?.filed_on ?? '']);
      for (const j of m.justifications) out.push(['', 'Justification', JUSTIFICATION_LABEL[j.kind], j.ref_label, j.ref_id, j.explanation, j.user_name, j.created_at]);
    }
    out.push([]);
    out.push(['8. Montants à reporter']);
    out.push(['TVA collectée', st.obligations.vatCollected]);
    out.push([`Acompte (minimum de perception ${rate(st.obligations.instalment.rate)} % + CAC)`, st.obligations.instalment.total]);
    out.push([]);
    out.push(['9. États figés de la période', 'Période', 'Chiffre d’affaires HT', 'Généré le', 'Empreinte']);
    for (const g of f.generated) out.push([g.number, `${g.period_from} au ${g.period_to}`, g.turnover_ht, g.generated_at, g.hash]);
    return '﻿' + out.map((r) => r.map(esc).join(';')).join('\r\n');
  }

  // --- Simulateur des régimes --------------------------------------------------------

  /**
   * Ce que l'entreprise paierait sous chaque régime, sur ses ventes réelles et son résultat
   * comptable de l'année, d'après le barème daté en vigueur. Rien ne se saisit : ni chiffre
   * d'affaires, ni résultat. Un régime inférieur à celui qu'impose le chiffre d'affaires est exclu.
   */
  simulate(storeId: string, year: number): TaxSimulation {
    if (!Number.isInteger(year) || year < 2000 || year > 2100) throw new AppError('Année invalide', 'INVALID');
    const today = this.today();
    const to = `${year}-12-31` < today ? `${year}-12-31` : today;
    if (to < `${year}-01-01`) throw new AppError('Année à venir', 'INVALID');
    const rs = rulesetFor(`${year}-01-01`);
    const turnoverHt = Math.max(this.statement(storeId, `${year}-01-01`, to).totals.ht, 0);
    const a = this.tax.assessment(storeId, year);
    const form = a.settings.form;
    let principal = 0;
    let rateApplied: number;
    if (form === 'company') {
      rateApplied = turnoverHt <= rs.reducedThreshold ? rs.reducedRate : rs.isRate;
      principal = pct(a.taxableIncome, rateApplied);
    } else {
      let floor = 0;
      for (const [ceiling, bp] of rs.irppBrackets) {
        if (a.taxableIncome <= floor) break;
        principal += pct(Math.min(a.taxableIncome, ceiling) - floor, bp);
        floor = ceiling;
      }
      rateApplied = a.taxableIncome ? Math.round((principal * 10_000) / a.taxableIncome) : 0;
    }
    const resultTax = { rate: rateApplied, principal, cac: pct(principal, rs.cacRate), total: 0 };
    resultTax.total = resultTax.principal + resultTax.cac;
    const fmt = (n: number) => n.toLocaleString('fr-FR');
    const regimes = rs.regimes.map((r): RegimeSimulation => {
      const inRange = turnoverHt >= r.minTurnoverHt && (r.maxTurnoverHt === null || turnoverHt < r.maxTurnoverHt);
      // On peut opter pour un régime plus exigeant, jamais pour un régime inférieur au sien.
      const status: RegimeStatus = inRange ? 'applicable' : r.minTurnoverHt > turnoverHt ? 'option' : 'excluded';
      const minimum =
        r.minimumRate === null
          ? null
          : (() => {
              const p = pct(turnoverHt, r.minimumRate);
              const cac = pct(p, rs.cacRate);
              return { rate: r.minimumRate, principal: p, cac, total: p + cac };
            })();
      return {
        code: r.code,
        label: r.label,
        status,
        threshold: r.maxTurnoverHt === null ? `à partir de ${fmt(r.minTurnoverHt)} FCFA HT` : `de ${fmt(r.minTurnoverHt)} à moins de ${fmt(r.maxTurnoverHt)} FCFA HT`,
        minimum,
        resultTax: r.resultTax ? resultTax.total : null,
        due: r.resultTax ? Math.max(resultTax.total, minimum?.total ?? 0) : null,
        obligations: r.obligations,
      };
    });
    return {
      year,
      provisional: a.provisional,
      form,
      turnoverHt,
      taxableIncome: a.taxableIncome,
      resultTax,
      regimes,
      ruleset: { validFrom: rs.validFrom, source: rs.source, checkedOn: rs.checkedOn },
    };
  }

  // --- États générés et journal --------------------------------------------------

  /** Fige l'état de la période : il est gardé tel quel, avec son empreinte, et ne se modifie plus. */
  generate(ctx: Context, from: string, to: string): GeneratedStatement {
    const st = this.statement(ctx.storeId, from, to);
    return this.tx(() => {
      const id = newId();
      const number = `EF-${this.stationPrefix()}-${String(this.nextCounter('fiscal_statement.number')).padStart(5, '0')}`;
      const payload = JSON.stringify(st);
      const hash = sha(payload);
      this.db
        .prepare(
          `INSERT INTO fiscal_statements (id, number, store_id, period_from, period_to, turnover_ht, payload, generated_by, generated_at, hash)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, number, ctx.storeId, from, to, st.totals.ht, payload, ctx.userId, this.now(), hash);
      this.enqueue(ctx, 'fiscal_statement', id, 'upsert', {});
      this.log(ctx, 'statement', 'generate', id, { number, from, to, turnoverHt: st.totals.ht, payloadHash: hash });
      this.audit(ctx.userId, 'fiscal.generate', 'fiscal_statement', id, { number, from, to });
      return this.statements(ctx.storeId).find((s) => s.id === id)!;
    });
  }

  private log(ctx: Context, entity: FiscalLogEntry['entity'], action: FiscalLogEntry['action'], entityId: string, data: unknown): void {
    const prev = this.db.prepare('SELECT hash FROM fiscal_log WHERE store_id = ? ORDER BY at DESC, rowid DESC LIMIT 1').pluck().get(ctx.storeId) as string | undefined;
    const row = { id: newId(), store_id: ctx.storeId, entity, entity_id: entityId, action, user_id: ctx.userId, data: JSON.stringify(data), at: this.now(), prev_hash: prev ?? null };
    const hash = sha([row.prev_hash, row.id, row.store_id, row.entity, row.entity_id, row.action, row.user_id, row.data, row.at]);
    this.db
      .prepare('INSERT INTO fiscal_log (id, store_id, entity, entity_id, action, user_id, data, at, prev_hash, hash) VALUES (@id, @store_id, @entity, @entity_id, @action, @user_id, @data, @at, @prev_hash, @hash)')
      .run({ ...row, hash });
    this.enqueue(ctx, 'fiscal_log', row.id, 'upsert', {});
  }

  statements(storeId: string): GeneratedStatement[] {
    return this.db
      .prepare(
        `SELECT f.id, f.number, f.period_from, f.period_to, f.turnover_ht, f.generated_by, u.name AS generated_by_name, f.generated_at, f.hash
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

  journal(storeId: string): FiscalLogEntry[] {
    return this.db
      .prepare(
        `SELECT l.id, l.entity, l.entity_id, COALESCE(st.number, d.period || ' · ' || d.reference, j.ref_label, d2.period || ' · ' || d2.reference) AS number,
                l.action, l.user_id, u.name AS user_name, l.at, l.hash, l.prev_hash
         FROM fiscal_log l LEFT JOIN users u ON u.id = l.user_id LEFT JOIN fiscal_statements st ON st.id = l.entity_id
         LEFT JOIN fiscal_declarations d ON d.id = l.entity_id LEFT JOIN fiscal_justifications j ON j.id = l.entity_id
         LEFT JOIN fiscal_declarations d2 ON d2.id = j.declaration_id
         WHERE l.store_id = ? ORDER BY l.at DESC, l.rowid DESC`,
      )
      .all(storeId) as FiscalLogEntry[];
  }

  /** Vérifie le journal : empreinte de chaque ligne, maillons de la chaîne, états non retouchés. */
  verify(storeId: string): { ok: boolean; checked: number; problems: string[] } {
    const problems: string[] = [];
    const rows = this.db.prepare('SELECT * FROM fiscal_log WHERE store_id = ?').all(storeId) as (Omit<FiscalLogEntry, 'number' | 'user_name'> & { store_id: string; data: string })[];
    const hashes = new Set(rows.map((r) => r.hash));
    for (const r of rows) {
      if (sha([r.prev_hash, r.id, r.store_id, r.entity, r.entity_id, r.action, r.user_id, r.data, r.at]) !== r.hash) problems.push(`Ligne du journal du ${r.at} modifiée`);
      if (r.prev_hash && !hashes.has(r.prev_hash)) problems.push(`Une ligne du journal manque avant celle du ${r.at}`);
    }
    const logged = new Map(rows.map((r) => [r.entity_id, JSON.parse(r.data) as { payloadHash?: string; rowHash?: string }]));
    for (const st of this.db.prepare('SELECT id, number, payload, hash FROM fiscal_statements WHERE store_id = ?').all(storeId) as { id: string; number: string; payload: string; hash: string }[]) {
      if (sha(st.payload) !== st.hash || logged.get(st.id)?.payloadHash !== st.hash) problems.push(`État fiscal ${st.number} modifié ou absent du journal`);
    }
    for (const d of this.db.prepare('SELECT * FROM fiscal_declarations WHERE store_id = ?').all(storeId) as Record<string, unknown>[]) {
      if (logged.get(d.id as string)?.rowHash !== sha(d)) problems.push(`Déclaration ${d.period} (${d.reference}) modifiée ou absente du journal`);
    }
    for (const j of this.db.prepare('SELECT * FROM fiscal_justifications WHERE store_id = ?').all(storeId) as Record<string, unknown>[]) {
      if (logged.get(j.id as string)?.rowHash !== sha(j)) problems.push(`Justification du ${j.created_at} modifiée ou absente du journal`);
    }
    return { ok: problems.length === 0, checked: rows.length, problems };
  }

  /** Export de la préparation fiscale, séparé de celui des ventes réelles : chaque avoir porte l'identifiant de sa vente. */
  exportCsv(st: FiscalStatement, ref?: { number: string; generated_at: string; hash: string } | null): string {
    const rate = (bp: number) => (bp / 100).toString().replace('.', ',');
    const out: (string | number | null)[][] = [];
    out.push(['Préparation fiscale', st.store.name, `Du ${st.from} au ${st.to}`, ref ? `État ${ref.number} généré le ${ref.generated_at}` : 'État provisoire (non généré)', ref ? `Empreinte ${ref.hash}` : '']);
    out.push([]);
    out.push(['Catégorie fiscale', 'Taux TVA %', 'Chiffre d’affaires TTC', 'HT', 'TVA']);
    for (const c of st.categories) out.push([c.label, rate(c.rate), c.ttc, c.ht, c.tva]);
    out.push(['Total', '', st.totals.ttc, st.totals.ht, st.totals.tva]);
    out.push([]);
    out.push(['Ventes avant avoirs', '', st.gross.ttc, st.gross.ht, st.gross.tva]);
    out.push(['Avoirs clients (retours)', '', st.totals.ttc - st.gross.ttc, st.totals.ht - st.gross.ht, st.totals.tva - st.gross.tva]);
    out.push([]);
    out.push(['N° avoir', 'Identifiant vente', 'Date', 'Facture d’origine', 'Identifiant facture d’origine', 'Client', 'TTC', 'HT', 'TVA', 'Motif']);
    for (const a of st.creditNotes) out.push([a.number, a.sale_id, a.created_at, a.original_number, a.original_sale_id, a.customer_name, a.ttc, a.ht, a.tva, a.reason]);
    out.push([]);
    out.push(['Contrôle comptable', 'Compte', 'Comptabilité', 'Ventes réelles', 'Écart']);
    out.push(['Ventes HT', st.books.salesAccount, st.books.salesHt, st.totals.ht, st.books.differenceHt]);
    out.push(['TVA collectée', st.books.vatAccount, st.books.vatCollected, st.totals.tva, st.books.differenceTva]);
    out.push(['Ristournes accordées (information)', st.books.rebatesAccount, st.books.rebates, '', '']);
    out.push([]);
    out.push(['TVA collectée', st.obligations.vatCollected]);
    out.push([`Acompte (minimum de perception ${rate(st.obligations.instalment.rate)} % + CAC)`, st.obligations.instalment.total]);
    return '﻿' + out.map((r) => r.map(esc).join(';')).join('\r\n');
  }
}
