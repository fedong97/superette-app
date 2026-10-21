import { createHash } from 'node:crypto';
import { type Fcfa, formatRate, splitTtc } from '@superette/core';
import type { AccountingService } from './accounting';
import type { TaxRegime, TaxService } from './tax';
import { TAX_DEFAULTS } from './tax';
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

export interface FiscalLogEntry {
  id: string;
  entity: 'statement';
  entity_id: string;
  number: string | null;
  action: 'generate';
  user_id: string;
  user_name: string | null;
  at: string;
  hash: string;
  prev_hash: string | null;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
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
      obligations: {
        vatCollected: store.vat_enabled === 1 ? totals.tva : 0,
        instalment: { rate: settings.rates.minimumRate, principal, cac, total: principal + cac },
      },
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
      this.log(ctx, id, { number, from, to, turnoverHt: st.totals.ht, payloadHash: hash });
      this.audit(ctx.userId, 'fiscal.generate', 'fiscal_statement', id, { number, from, to });
      return this.statements(ctx.storeId).find((s) => s.id === id)!;
    });
  }

  private log(ctx: Context, entityId: string, data: unknown): void {
    const prev = this.db.prepare('SELECT hash FROM fiscal_log WHERE store_id = ? ORDER BY at DESC, rowid DESC LIMIT 1').pluck().get(ctx.storeId) as string | undefined;
    const row = { id: newId(), store_id: ctx.storeId, entity: 'statement', entity_id: entityId, action: 'generate', user_id: ctx.userId, data: JSON.stringify(data), at: this.now(), prev_hash: prev ?? null };
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
        `SELECT l.id, l.entity, l.entity_id, st.number, l.action, l.user_id, u.name AS user_name, l.at, l.hash, l.prev_hash
         FROM fiscal_log l LEFT JOIN users u ON u.id = l.user_id LEFT JOIN fiscal_statements st ON st.id = l.entity_id
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
    const generated = new Map(rows.map((r) => [r.entity_id, JSON.parse(r.data) as { payloadHash: string }]));
    for (const st of this.db.prepare('SELECT id, number, payload, hash FROM fiscal_statements WHERE store_id = ?').all(storeId) as { id: string; number: string; payload: string; hash: string }[]) {
      if (sha(st.payload) !== st.hash || generated.get(st.id)?.payloadHash !== st.hash) problems.push(`État fiscal ${st.number} modifié ou absent du journal`);
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
