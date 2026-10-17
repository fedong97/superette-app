import type { Fcfa } from '@superette/core';
import type { AccountingService } from './accounting';
import type { FinancialStatementsService } from './statements';
import { AppError, Base, type Clock, type Context } from './util';
import type { Db } from './database';

export interface FiscalYear {
  id: string;
  store_id: string;
  start_date: string;
  end_date: string;
  status: 'open' | 'closed';
  /** Résultat reporté à la clôture (bénéfice positif, perte négative). */
  result: Fcfa | null;
  closed_at: string | null;
  closed_by: string | null;
  closed_by_name: string | null;
  /** N° des à-nouveaux générés par la clôture. */
  closing_ref: string | null;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const fr = (d: string) => d.split('-').reverse().join('/');

/** Lendemain (ou veille) d'une date AAAA-MM-JJ. */
const shiftDay = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
/** Dernier jour de l'exercice de 12 mois qui commence le `start`. */
const yearEnd = (start: string) => shiftDay(`${Number(start.slice(0, 4)) + 1}${start.slice(4)}`, -1);

/**
 * Exercices comptables. Un exercice ouvert reçoit les écritures ; sa clôture
 * vérifie l'équilibre, génère les à-nouveaux (comptes de bilan, stock au CMUP,
 * tiers, résultat en report à nouveau) au premier jour de l'exercice suivant,
 * puis interdit toute écriture datée dedans tant qu'il n'est pas rouvert.
 */
export interface CloseCheck {
  key: string;
  label: string;
  status: 'ok' | 'warning' | 'blocking';
  detail: string;
}

export class FiscalYearService extends Base {
  constructor(
    db: Db,
    clock: Clock,
    private readonly accounting: AccountingService,
    private readonly statements: FinancialStatementsService,
  ) {
    super(db, clock);
  }

  /** Exercices du magasin, le plus récent d'abord. Sans exercice, celui de l'année en cours est créé. */
  list(storeId: string): FiscalYear[] {
    const rows = () =>
      this.db
        .prepare(
          `SELECT f.id, f.store_id, f.start_date, f.end_date, f.status, f.result, f.closed_at, f.closed_by, u.name AS closed_by_name,
                  (SELECT number FROM manual_entries m WHERE m.closing_of = f.id) AS closing_ref
           FROM fiscal_years f LEFT JOIN users u ON u.id = f.closed_by WHERE f.store_id = ? ORDER BY f.start_date DESC`,
        )
        .all(storeId) as FiscalYear[];
    const list = rows();
    if (list.length) return list;
    const year = this.today().slice(0, 4);
    this.insert({ storeId, registerId: null, userId: '' }, `${year}-01-01`, `${year}-12-31`);
    return rows();
  }

  get(id: string): FiscalYear {
    const storeId = this.db.prepare('SELECT store_id FROM fiscal_years WHERE id = ?').pluck().get(id) as string | undefined;
    const fy = storeId ? this.list(storeId).find((f) => f.id === id) : undefined;
    if (!fy) throw new AppError('Exercice introuvable', 'NOT_FOUND');
    return fy;
  }

  /** Exercice qui contient la date (aujourd'hui par défaut), s'il est défini. */
  at(storeId: string, date = this.today()): FiscalYear | null {
    return this.list(storeId).find((f) => f.start_date <= date && f.end_date >= date) ?? null;
  }

  private insert(ctx: Context, start: string, end: string): string {
    const id = `${ctx.storeId}:${start}`;
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO fiscal_years (id, store_id, start_date, end_date, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'open', ?, ?)`,
      )
      .run(id, ctx.storeId, start, end, now, now);
    this.enqueue(ctx, 'fiscal_year', id, 'upsert', {});
    return id;
  }

  /** Ouvre un exercice (dates libres, 18 mois au plus), sans chevaucher un autre. */
  open(ctx: Context, input: { start: string; end: string }): FiscalYear {
    if (!DATE.test(input.start) || !DATE.test(input.end) || input.start > input.end) throw new AppError("Dates de l'exercice invalides", 'INVALID');
    if (input.end > shiftDay(yearEnd(input.start), 183)) throw new AppError('Un exercice dure au plus 18 mois', 'INVALID');
    const overlap = this.list(ctx.storeId).find((f) => f.start_date <= input.end && f.end_date >= input.start);
    if (overlap) throw new AppError(`Ces dates chevauchent l'exercice du ${fr(overlap.start_date)} au ${fr(overlap.end_date)}`, 'INVALID');
    return this.tx(() => {
      const id = this.insert(ctx, input.start, input.end);
      this.audit(ctx.userId, 'fiscal_year.open', 'fiscal_year', id, input);
      return this.get(id);
    });
  }

  /** Ouvre l'exercice de 12 mois qui suit le dernier. */
  openNext(ctx: Context): FiscalYear {
    const last = this.list(ctx.storeId)[0]!;
    const start = shiftDay(last.end_date, 1);
    return this.open(ctx, { start, end: yearEnd(start) });
  }

  /** Change les dates d'un exercice ouvert (par exemple un premier exercice plus long). */
  setDates(ctx: Context, id: string, input: { start: string; end: string }): FiscalYear {
    const fy = this.get(id);
    if (fy.status === 'closed') throw new AppError('Rouvrez l’exercice avant de changer ses dates', 'INVALID');
    if (fy.start_date !== input.start) throw new AppError("La date de début d'un exercice ne change pas : supprimez-le et ouvrez-en un autre", 'INVALID');
    if (!DATE.test(input.end) || input.end < input.start || input.end > shiftDay(yearEnd(input.start), 183)) throw new AppError('Date de fin invalide (18 mois au plus)', 'INVALID');
    const overlap = this.list(ctx.storeId).find((f) => f.id !== id && f.start_date <= input.end && f.end_date >= input.start);
    if (overlap) throw new AppError(`Ces dates chevauchent l'exercice du ${fr(overlap.start_date)} au ${fr(overlap.end_date)}`, 'INVALID');
    this.db.prepare('UPDATE fiscal_years SET end_date = ?, updated_at = ? WHERE id = ?').run(input.end, this.now(), id);
    this.enqueue(ctx, 'fiscal_year', id, 'upsert', {});
    this.audit(ctx.userId, 'fiscal_year.dates', 'fiscal_year', id, input);
    return this.get(id);
  }

  /** Lignes des à-nouveaux : soldes de bilan à la fin de l'exercice, résultat en report à nouveau. */
  closingLines(storeId: string, fy: Pick<FiscalYear, 'start_date' | 'end_date'>) {
    const { sheet, result } = this.statements.closingBalances(storeId, fy.start_date, fy.end_date);
    const lines = sheet.map((x) => ({
      account: x.account,
      aux: x.aux,
      label: null as string | null,
      debit: x.balance > 0 ? x.balance : 0,
      credit: x.balance < 0 ? -x.balance : 0,
    }));
    if (result > 0) lines.push({ account: '121', aux: null, label: "Report à nouveau : bénéfice de l'exercice", debit: 0, credit: result });
    if (result < 0) lines.push({ account: '129', aux: null, label: "Report à nouveau : perte de l'exercice", debit: -result, credit: 0 });
    return { lines, result };
  }

  /**
   * Contrôle avant clôture, comme la Maintenance de Sage : ce qui bloque la clôture
   * (pièces déséquilibrées, journées de caisse ouvertes…) et ce qui mérite d'être vu
   * (fiches d'intervention pas rapportées, opérations pas encore envoyées au serveur).
   */
  checkClose(storeId: string, id: string): CloseCheck[] {
    const fy = this.get(id);
    const checks: CloseCheck[] = [];
    const add = (key: string, label: string, ok: boolean, blocking: boolean, detail: string) => checks.push({ key, label, status: ok ? 'ok' : blocking ? 'blocking' : 'warning', detail });
    add('ended', "Fin de l'exercice", this.today() > fy.end_date, true, this.today() > fy.end_date ? `Terminé le ${fr(fy.end_date)}.` : `L'exercice se termine le ${fr(fy.end_date)}.`);
    const before = this.list(storeId).find((f) => f.start_date < fy.start_date && f.status === 'open');
    add('previous', 'Exercices précédents', !before, true, before ? `Clôturez d'abord l'exercice du ${fr(before.start_date)} au ${fr(before.end_date)}.` : 'Tous clôturés.');
    const tb = this.accounting.trialBalance(storeId, { from: fy.start_date, to: fy.end_date });
    add('balance', 'Balance', tb.totals.debit === tb.totals.credit, true, tb.totals.debit === tb.totals.credit ? 'Débit et crédit égaux.' : `Débit ${tb.totals.debit} ≠ crédit ${tb.totals.credit}.`);
    const bad = this.accounting
      .entries(storeId, { from: fy.start_date, to: fy.end_date })
      .filter((e) => e.lines.reduce((t, l) => t + (l.debit || 0) - (l.credit || 0), 0) !== 0);
    add('entries', 'Pièces', bad.length === 0, true, bad.length ? `${bad.length} pièce(s) déséquilibrée(s) : ${bad.slice(0, 5).map((e) => `${e.journal} ${e.ref}`).join(', ')}${bad.length > 5 ? '…' : ''}.` : 'Chaque pièce est équilibrée.');
    const open = this.db
      .prepare("SELECT COUNT(*) FROM cash_sessions WHERE store_id = ? AND status = 'open' AND date(opened_at, 'localtime') <= ?")
      .pluck()
      .get(storeId, fy.end_date) as number;
    // Les ventes sont comptées au jour le jour ; seul l'écart de caisse attend le Z.
    add('cash', 'Journées de caisse', open === 0, false, open ? `${open} journée(s) de caisse ouverte(s) avant la fin de l'exercice : leur écart de caisse ne sera compté qu'au Z.` : 'Toutes clôturées.');
    const fiches = this.db.prepare("SELECT COUNT(*) FROM fiche_log WHERE kind = 'intervention' AND returned_at IS NULL AND created_at <= ?").pluck().get(`${fy.end_date}T23:59:59`) as number;
    add('fiches', "Fiches d'intervention", fiches === 0, false, fiches ? `${fiches} fiche(s) d'intervention sortie(s) et pas encore rapportée(s) : leurs écritures manqueraient.` : 'Toutes rapportées.');
    const linked = this.db.prepare("SELECT 1 FROM settings WHERE key = 'sync.token'").get();
    if (linked) {
      const pending = this.db.prepare('SELECT COUNT(*) FROM outbox WHERE sent_at IS NULL').pluck().get() as number;
      const conflicts = this.db.prepare('SELECT COUNT(*) FROM sync_conflicts').pluck().get() as number;
      add('sync', 'Serveur central', pending === 0 && conflicts === 0, false, pending || conflicts ? `${pending} opération(s) pas encore envoyée(s), ${conflicts} conflit(s) : synchronisez avant de clôturer.` : 'Tout est envoyé.');
    }
    return checks;
  }

  /**
   * Clôture : l'exercice doit être terminé, les précédents clôturés et les
   * écritures équilibrées. L'exercice suivant est ouvert s'il n'existe pas.
   */
  close(ctx: Context, id: string): FiscalYear {
    const blocking = this.checkClose(ctx.storeId, id).filter((c) => c.status === 'blocking' && c.key === 'entries');
    if (blocking.length) throw new AppError(`Clôture impossible : ${blocking.map((c) => c.detail).join(' ')}`, 'CLOSE_CHECK');
    const fy = this.get(id);
    if (fy.store_id !== ctx.storeId) throw new AppError('Cet exercice appartient à un autre magasin', 'INVALID');
    if (fy.status === 'closed') throw new AppError('Cet exercice est déjà clôturé', 'INVALID');
    if (this.today() <= fy.end_date) throw new AppError(`L'exercice se termine le ${fr(fy.end_date)} : clôturez-le après cette date`, 'INVALID');
    const before = this.list(ctx.storeId).find((f) => f.start_date < fy.start_date && f.status === 'open');
    if (before) throw new AppError(`Clôturez d'abord l'exercice du ${fr(before.start_date)} au ${fr(before.end_date)}`, 'INVALID');
    const tb = this.accounting.trialBalance(ctx.storeId, { from: fy.start_date, to: fy.end_date });
    if (tb.totals.debit !== tb.totals.credit) throw new AppError(`Écritures déséquilibrées sur l'exercice : débit ${tb.totals.debit} ≠ crédit ${tb.totals.credit}`, 'UNBALANCED');
    const { lines, result } = this.closingLines(ctx.storeId, fy);
    const next = shiftDay(fy.end_date, 1);
    return this.tx(() => {
      if (!this.list(ctx.storeId).some((f) => f.start_date === next)) {
        const overlap = this.list(ctx.storeId).find((f) => f.start_date <= next && f.end_date >= next);
        if (overlap) throw new AppError(`L'exercice suivant doit commencer le ${fr(next)}`, 'INVALID');
        this.insert(ctx, next, yearEnd(next));
      }
      if (lines.length)
        this.accounting.addManualEntry(
          ctx,
          { journal: 'AN', date: next, label: `À-nouveaux de l'exercice du ${fr(fy.start_date)} au ${fr(fy.end_date)}`, lines },
          { closingOf: id },
        );
      this.db.prepare("UPDATE fiscal_years SET status = 'closed', result = ?, closed_at = ?, closed_by = ?, updated_at = ? WHERE id = ?").run(result, this.now(), ctx.userId, this.now(), id);
      this.enqueue(ctx, 'fiscal_year', id, 'upsert', {});
      this.audit(ctx.userId, 'fiscal_year.close', 'fiscal_year', id, { result, lines: lines.length });
      return this.get(id);
    });
  }

  /** Rouvre le dernier exercice clôturé : ses à-nouveaux sont supprimés, les écritures redeviennent possibles. */
  reopen(ctx: Context, id: string): FiscalYear {
    const fy = this.get(id);
    if (fy.store_id !== ctx.storeId) throw new AppError('Cet exercice appartient à un autre magasin', 'INVALID');
    if (fy.status !== 'closed') throw new AppError("Cet exercice n'est pas clôturé", 'INVALID');
    const later = this.list(ctx.storeId).find((f) => f.start_date > fy.start_date && f.status === 'closed');
    if (later) throw new AppError(`Rouvrez d'abord l'exercice du ${fr(later.start_date)} au ${fr(later.end_date)}`, 'INVALID');
    return this.tx(() => {
      const an = this.db.prepare('SELECT id FROM manual_entries WHERE closing_of = ?').pluck().all(id) as string[];
      for (const entryId of an) {
        this.db.prepare('DELETE FROM manual_entry_lines WHERE entry_id = ?').run(entryId);
        this.db.prepare('DELETE FROM manual_entries WHERE id = ?').run(entryId);
        this.enqueue(ctx, 'manual_entry', entryId, 'delete', {});
      }
      this.db.prepare("UPDATE fiscal_years SET status = 'open', result = NULL, closed_at = NULL, closed_by = NULL, updated_at = ? WHERE id = ?").run(this.now(), id);
      this.enqueue(ctx, 'fiscal_year', id, 'upsert', {});
      this.audit(ctx.userId, 'fiscal_year.reopen', 'fiscal_year', id);
      return this.get(id);
    });
  }

  /** Supprime un exercice ouvert sans écriture de clôture (créé par erreur). */
  remove(ctx: Context, id: string): void {
    const fy = this.get(id);
    if (fy.status === 'closed') throw new AppError('Rouvrez l’exercice avant de le supprimer', 'INVALID');
    if (this.db.prepare('SELECT 1 FROM manual_entries WHERE store_id = ? AND closing_of IS NOT NULL AND entry_date = ?').get(ctx.storeId, fy.start_date)) {
      throw new AppError("Cet exercice porte les à-nouveaux de l'exercice précédent : rouvrez d'abord celui-ci", 'INVALID');
    }
    this.db.prepare('DELETE FROM fiscal_years WHERE id = ?').run(id);
    this.enqueue(ctx, 'fiscal_year', id, 'delete', {});
    this.audit(ctx.userId, 'fiscal_year.delete', 'fiscal_year', id);
  }

  /**
   * Exercice clôturé dont les soldes ont changé depuis (pièce arrivée d'un autre
   * PC après la clôture) : ses à-nouveaux ne correspondent plus.
   */
  stale(storeId: string, id: string): boolean {
    const fy = this.get(id);
    if (fy.status !== 'closed') return false;
    const expected = this.closingLines(storeId, fy).lines;
    const key = (l: { account: string; aux: string | null; debit: number; credit: number }) => `${l.account}|${l.aux ?? ''}|${l.debit - l.credit}`;
    const booked = this.accounting
      .entries(storeId, { from: shiftDay(fy.end_date, 1), to: shiftDay(fy.end_date, 1), journal: 'AN' })
      .filter((e) => e.closing)
      .flatMap((e) => e.lines);
    const a = expected.map(key).sort();
    const b = booked.map(key).sort();
    return a.length !== b.length || a.some((x, i) => x !== b[i]);
  }
}
