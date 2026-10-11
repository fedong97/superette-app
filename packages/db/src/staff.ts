import type { Fcfa } from '@superette/core';
import { AppError, Base, type Context, newId } from './util';

/** Racines des sous-comptes de tiers du personnel : rémunérations dues et avances. */
export const STAFF_SALARY_ROOT = '4211';
export const STAFF_ADVANCE_ROOT = '4251';
/** Compte de charge des salaires constatés. */
export const STAFF_WAGES_ACCOUNT = '661';

export interface Staff {
  id: string;
  store_id: string;
  code: string;
  name: string;
  position: string | null;
  phone: string | null;
  id_card: string | null;
  base_salary: Fcfa;
  hired_on: string | null;
  user_id: string | null;
  user_name: string | null;
  salary_account: string;
  advance_account: string;
  active: number;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface StaffInput {
  name: string;
  position?: string | null;
  phone?: string | null;
  idCard?: string | null;
  baseSalary?: Fcfa;
  /** AAAA-MM-JJ. */
  hiredOn?: string | null;
  /** Compte utilisateur du collaborateur (caissier…), facultatif. */
  userId?: string | null;
  active?: boolean;
  notes?: string | null;
}

/** Ce que le magasin doit au collaborateur (salaires constatés non payés) et ce qu'il doit (avances non remboursées). */
export interface StaffBalance {
  due: Fcfa;
  advances: Fcfa;
}

export interface StaffSalary {
  id: string;
  number: string;
  store_id: string;
  staff_id: string;
  staff_name: string;
  period: string;
  gross: Fcfa;
  deducted: Fcfa;
  /** Net à payer : brut moins les avances retenues. */
  net: Fcfa;
  paid: Fcfa;
  rest: Fcfa;
  label: string;
  status: 'active' | 'cancelled';
  cancel_reason: string | null;
  user_name: string | null;
  at: string;
}

/** Ligne de l'extrait de compte d'un collaborateur, avec ses deux soldes après l'opération. */
export interface StaffStatementLine {
  at: string;
  number: string;
  label: string;
  /** Salaire constaté (+) ou payé (−) : ce que le magasin lui doit. */
  due: Fcfa;
  /** Avance versée (+) ou remboursée, retenue (−) : ce qu'il doit au magasin. */
  advance: Fcfa;
  dueBalance: Fcfa;
  advanceBalance: Fcfa;
}

const MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
export const periodLabel = (period: string) => `${MONTHS[Number(period.slice(5, 7)) - 1] ?? ''} ${period.slice(0, 4)}`;

/**
 * Collaborateurs (employés, livreurs…) et leur paie. Chaque collaborateur a ses
 * deux sous-comptes en comptabilité : 4211… (rémunérations dues) et 4251…
 * (avances). Le salaire du mois se constate (661 contre 4211…) puis se paie
 * depuis une caisse ou le bureau ; les avances non remboursées se retiennent sur
 * le salaire.
 */
export class StaffService extends Base {
  private query(where: string) {
    return this.db.prepare(`SELECT s.*, u.name AS user_name FROM staff s LEFT JOIN users u ON u.id = s.user_id WHERE ${where} ORDER BY s.active DESC, s.name`);
  }

  list(storeId: string, opts: { includeInactive?: boolean } = {}): (Staff & StaffBalance)[] {
    const rows = this.query('s.store_id = ? AND (? = 1 OR s.active = 1)').all(storeId, opts.includeInactive ? 1 : 0) as Staff[];
    return rows.map((s) => ({ ...s, ...this.balance(s.id) }));
  }

  get(id: string): Staff & StaffBalance {
    const s = this.query('s.id = ?').get(id) as Staff | undefined;
    if (!s) throw new AppError('Collaborateur introuvable', 'NOT_FOUND');
    return { ...s, ...this.balance(id) };
  }

  /** Premier numéro libre pour les deux sous-comptes (4211001 et 4251001, puis 002…). */
  private nextAccounts(): { salary: string; advance: string } {
    const exists = this.db.prepare('SELECT 1 FROM accounts WHERE id = ?').pluck();
    for (let n = 1; n < 1000; n++) {
      const suffix = String(n).padStart(3, '0');
      const salary = `${STAFF_SALARY_ROOT}${suffix}`;
      const advance = `${STAFF_ADVANCE_ROOT}${suffix}`;
      if (!exists.get(salary) && !exists.get(advance)) return { salary, advance };
    }
    throw new AppError('Plus de numéro de sous-compte libre pour le personnel', 'INVALID');
  }

  private saveAccount(id: string, label: string, now: string): void {
    this.db
      .prepare(
        `INSERT INTO accounts (id, label, role, active, updated_at) VALUES (?, ?, NULL, 1, ?)
         ON CONFLICT(id) DO UPDATE SET label = excluded.label, updated_at = excluded.updated_at`,
      )
      .run(id, label, now);
    this.enqueue(null, 'account', id, 'upsert', {});
  }

  save(ctx: Context, input: StaffInput, id?: string): Staff & StaffBalance {
    const name = input.name.trim();
    if (!name) throw new AppError('Le nom du collaborateur est obligatoire', 'INVALID');
    const baseSalary = input.baseSalary ?? 0;
    if (!Number.isSafeInteger(baseSalary) || baseSalary < 0) throw new AppError('Salaire de base invalide', 'INVALID');
    if (input.hiredOn && !/^\d{4}-\d{2}-\d{2}$/.test(input.hiredOn)) throw new AppError("Date d'entrée invalide", 'INVALID');
    if (input.userId) {
      const linked = this.db.prepare('SELECT id FROM staff WHERE user_id = ? AND id <> ?').pluck().get(input.userId, id ?? '') as string | undefined;
      if (linked) throw new AppError('Cet utilisateur est déjà rattaché à un autre collaborateur', 'INVALID');
    }
    const current = id ? this.get(id) : null;
    if (current && input.active === false && (current.due || current.advances)) {
      throw new AppError('Soldez son compte (salaire dû, avances) avant de le marquer parti', 'INVALID');
    }
    return this.tx(() => {
      const now = this.now();
      const values = {
        name,
        position: input.position?.trim() || null,
        phone: input.phone?.trim() || null,
        id_card: input.idCard?.trim() || null,
        base_salary: baseSalary,
        hired_on: input.hiredOn || null,
        user_id: input.userId || null,
        active: input.active === false ? 0 : 1,
        notes: input.notes?.trim() || null,
        now,
      };
      let staffId = id;
      if (current) {
        this.db
          .prepare(
            `UPDATE staff SET name = @name, position = @position, phone = @phone, id_card = @id_card, base_salary = @base_salary,
               hired_on = @hired_on, user_id = @user_id, active = @active, notes = @notes, updated_at = @now WHERE id = @id`,
          )
          .run({ ...values, id: current.id });
      } else {
        staffId = newId();
        const accounts = this.nextAccounts();
        this.db
          .prepare(
            `INSERT INTO staff (id, store_id, code, name, position, phone, id_card, base_salary, hired_on, user_id, salary_account, advance_account, active, notes, created_at, updated_at)
             VALUES (@id, @store, @code, @name, @position, @phone, @id_card, @base_salary, @hired_on, @user_id, @salary, @advance, @active, @notes, @now, @now)`,
          )
          .run({
            ...values,
            id: staffId,
            store: ctx.storeId,
            code: `COL-${this.stationPrefix()}-${String(this.nextCounter('staff.code')).padStart(4, '0')}`,
            salary: accounts.salary,
            advance: accounts.advance,
          });
      }
      const s = this.query('s.id = ?').get(staffId) as Staff;
      // Les libellés des sous-comptes suivent le nom du collaborateur.
      this.saveAccount(s.salary_account, `Rémunérations dues, ${name}`, now);
      this.saveAccount(s.advance_account, `Avances, ${name}`, now);
      this.enqueue(ctx, 'staff', s.id, 'upsert', {});
      this.audit(ctx.userId, current ? 'staff.update' : 'staff.create', 'staff', s.id, { name, baseSalary });
      return this.get(s.id);
    });
  }

  // --- Soldes et extrait de compte ---------------------------------------------------

  balance(staffId: string): StaffBalance {
    const sal = this.db
      .prepare("SELECT COALESCE(SUM(gross), 0) AS gross, COALESCE(SUM(deducted), 0) AS deducted FROM staff_salaries WHERE staff_id = ? AND status = 'active'")
      .get(staffId) as { gross: number; deducted: number };
    const ent = this.db
      .prepare(
        `SELECT COALESCE(SUM(CASE WHEN kind = 'staff_salary' THEN amount END), 0) AS paid,
                COALESCE(SUM(CASE WHEN kind = 'staff_advance' THEN amount END), 0) AS lent,
                COALESCE(SUM(CASE WHEN kind = 'staff_repayment' THEN amount END), 0) AS repaid
         FROM treasury_entries WHERE staff_id = ? AND status = 'active'`,
      )
      .get(staffId) as { paid: number; lent: number; repaid: number };
    return { due: sal.gross - sal.deducted - ent.paid, advances: ent.lent - ent.repaid - sal.deducted };
  }

  /** Extrait de compte : salaires constatés et payés, avances versées, remboursées ou retenues. */
  statement(staffId: string, opts: { from?: string; to?: string } = {}): { staff: Staff & StaffBalance; opening: StaffBalance; lines: StaffStatementLine[] } {
    const staff = this.get(staffId);
    const raw = this.db
      .prepare(
        `SELECT at, number, label, gross AS due, 0 AS advance FROM staff_salaries WHERE staff_id = @id AND status = 'active'
         UNION ALL
         SELECT at, number, 'Avances retenues sur ' || label, -deducted, -deducted FROM staff_salaries WHERE staff_id = @id AND status = 'active' AND deducted > 0
         UNION ALL
         SELECT at, number, label,
                CASE kind WHEN 'staff_salary' THEN -amount ELSE 0 END,
                CASE kind WHEN 'staff_advance' THEN amount WHEN 'staff_repayment' THEN -amount ELSE 0 END
         FROM treasury_entries WHERE staff_id = @id AND status = 'active'
         ORDER BY 1, 2`,
      )
      .all({ id: staffId }) as { at: string; number: string; label: string; due: number; advance: number }[];
    const local = (iso: string) => {
      const d = new Date(iso);
      const pad = (n: number) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    };
    const opening = { due: 0, advances: 0 };
    let due = 0;
    let advances = 0;
    const lines: StaffStatementLine[] = [];
    for (const r of raw) {
      const d = local(r.at);
      if (opts.to && d > opts.to) break;
      due += r.due;
      advances += r.advance;
      if (opts.from && d < opts.from) {
        opening.due = due;
        opening.advances = advances;
        continue;
      }
      lines.push({ ...r, dueBalance: due, advanceBalance: advances });
    }
    return { staff, opening, lines };
  }

  // --- Salaires -------------------------------------------------------------------------

  private salaryQuery(where: string) {
    return this.db.prepare(
      `SELECT x.*, s.name AS staff_name, u.name AS user_name, x.gross - x.deducted AS net,
              COALESCE((SELECT SUM(e.amount) FROM treasury_entries e WHERE e.salary_id = x.id AND e.status = 'active'), 0) AS paid
       FROM staff_salaries x JOIN staff s ON s.id = x.staff_id LEFT JOIN users u ON u.id = x.user_id WHERE ${where} ORDER BY x.period DESC, s.name`,
    );
  }

  private withRest(rows: Omit<StaffSalary, 'rest'>[]): StaffSalary[] {
    return rows.map((r) => ({ ...r, rest: r.status === 'active' ? r.net - r.paid : 0 }));
  }

  getSalary(id: string): StaffSalary {
    const [row] = this.withRest(this.salaryQuery('x.id = ?').all(id) as Omit<StaffSalary, 'rest'>[]);
    if (!row) throw new AppError('Salaire introuvable', 'NOT_FOUND');
    return row;
  }

  salaries(storeId: string, opts: { period?: string | null; staffId?: string | null; unpaid?: boolean } = {}): StaffSalary[] {
    const rows = this.withRest(
      this.salaryQuery("x.store_id = @storeId AND (@period IS NULL OR x.period = @period) AND (@staffId IS NULL OR x.staff_id = @staffId) AND (@unpaid = 0 OR x.status = 'active')").all({
        storeId,
        period: opts.period ?? null,
        staffId: opts.staffId ?? null,
        unpaid: opts.unpaid ? 1 : 0,
      }) as Omit<StaffSalary, 'rest'>[],
    );
    return opts.unpaid ? rows.filter((r) => r.rest > 0) : rows;
  }

  /** Feuille du mois : chaque collaborateur actif, son salaire de base, ses avances à retenir et le salaire déjà constaté. */
  month(storeId: string, period: string) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) throw new AppError('Mois invalide (AAAA-MM)', 'INVALID');
    const done = this.salaries(storeId, { period }).filter((x) => x.status === 'active');
    return this.list(storeId, { includeInactive: true })
      .filter((s) => s.active || done.some((d) => d.staff_id === s.id))
      .map((s) => ({ staff: s, salary: done.find((d) => d.staff_id === s.id) ?? null }));
  }

  /** Constate les salaires du mois : brut et avances retenues, un salaire par collaborateur et par mois. */
  recordSalaries(ctx: Context, period: string, lines: { staffId: string; gross: Fcfa; deducted?: Fcfa }[]): StaffSalary[] {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) throw new AppError('Mois invalide (AAAA-MM)', 'INVALID');
    if (period > this.today().slice(0, 7)) throw new AppError("On ne constate pas le salaire d'un mois à venir", 'INVALID');
    const todo = lines.filter((l) => l.gross > 0);
    if (!todo.length) throw new AppError('Indiquez au moins un salaire', 'INVALID');
    return this.tx(() => {
      const ids: string[] = [];
      for (const l of todo) {
        const s = this.get(l.staffId);
        if (s.store_id !== ctx.storeId) throw new AppError('Collaborateur introuvable', 'NOT_FOUND');
        const deducted = l.deducted ?? 0;
        if (!Number.isSafeInteger(l.gross) || !Number.isSafeInteger(deducted) || deducted < 0) throw new AppError(`Montants invalides pour ${s.name}`, 'INVALID');
        if (deducted > l.gross) throw new AppError(`La retenue de ${s.name} dépasse son salaire`, 'INVALID');
        if (deducted > Math.max(0, s.advances)) throw new AppError(`${s.name} n'a que ${s.advances} FCFA d'avances à retenir`, 'INVALID');
        const already = this.db.prepare("SELECT 1 FROM staff_salaries WHERE staff_id = ? AND period = ? AND status = 'active'").pluck().get(s.id, period);
        if (already) throw new AppError(`Le salaire de ${periodLabel(period)} de ${s.name} est déjà constaté`, 'INVALID');
        const id = newId();
        const now = this.now();
        this.db
          .prepare(
            `INSERT INTO staff_salaries (id, number, store_id, staff_id, period, gross, deducted, label, status, user_id, at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
          )
          .run(id, `SAL-${this.stationPrefix()}-${String(this.nextCounter('staff.salary')).padStart(5, '0')}`, ctx.storeId, s.id, period, l.gross, deducted, `Salaire de ${periodLabel(period)}`, ctx.userId, now, now);
        this.enqueue(ctx, 'staff_salary', id, 'upsert', {});
        this.audit(ctx.userId, 'staff.salary', 'staff', s.id, { period, gross: l.gross, deducted });
        ids.push(id);
      }
      return ids.map((id) => this.getSalary(id));
    });
  }

  /** Annule un salaire constaté par erreur, tant que rien n'est payé dessus. */
  cancelSalary(ctx: Context, id: string, reason: string): StaffSalary {
    const x = this.getSalary(id);
    if (x.status !== 'active') throw new AppError('Ce salaire est déjà annulé', 'INVALID');
    if (x.paid > 0) throw new AppError("Une partie de ce salaire est payée : supprimez d'abord le paiement", 'INVALID');
    if (!reason.trim()) throw new AppError("Indiquez le motif de l'annulation", 'INVALID');
    this.tx(() => {
      this.db.prepare("UPDATE staff_salaries SET status = 'cancelled', cancel_reason = ?, updated_at = ? WHERE id = ?").run(reason.trim(), this.now(), id);
      this.enqueue(ctx, 'staff_salary', id, 'upsert', {});
      this.audit(ctx.userId, 'staff.salary_cancel', 'staff', x.staff_id, { number: x.number, reason });
    });
    return this.getSalary(id);
  }

  /** Bulletin de paie simplifié : brut, avances retenues, net, paiements et reste. */
  slip(salaryId: string) {
    const salary = this.getSalary(salaryId);
    const staff = this.get(salary.staff_id);
    const payments = this.db
      .prepare(
        `SELECT e.number, e.at, e.amount, e.method, e.reference, r.name AS register_name FROM treasury_entries e LEFT JOIN registers r ON r.id = e.register_id
         WHERE e.salary_id = ? AND e.status = 'active' ORDER BY e.at`,
      )
      .all(salaryId) as { number: string; at: string; amount: number; method: string; reference: string | null; register_name: string | null }[];
    return { salary, staff, payments, periodLabel: periodLabel(salary.period) };
  }
}
