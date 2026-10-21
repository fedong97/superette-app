import type { Db } from './database';
import type { AdminService } from './admin';
import { AppError, Base, type Clock, type Context, newId } from './util';

export type LeaveKind = 'paid' | 'sick' | 'unpaid' | 'permission';
export const LEAVE_KINDS: Record<LeaveKind, string> = {
  paid: 'Congé payé',
  sick: 'Maladie',
  unpaid: 'Congé sans solde',
  permission: 'Permission exceptionnelle',
};

export type LeaveStatus = 'requested' | 'approved' | 'refused' | 'cancelled';
export const LEAVE_STATUS: Record<LeaveStatus, string> = {
  requested: 'Demandé',
  approved: 'Accordé',
  refused: 'Refusé',
  cancelled: 'Annulé',
};

export interface Leave {
  id: string;
  store_id: string;
  staff_id: string;
  staff_name: string;
  kind: LeaveKind;
  date_from: string;
  date_to: string;
  /** Jours travaillés compris dans la période (jours de repos exclus). */
  days: number;
  status: LeaveStatus;
  reason: string | null;
  decided_by_name: string | null;
  created_at: string;
}

/** Horaire d'un jour de la semaine type ; absent : jour de repos. */
export interface Shift {
  start: string;
  end: string;
}
/** Semaine type : 0 = dimanche … 6 = samedi. */
export type WeekSchedule = Partial<Record<'0' | '1' | '2' | '3' | '4' | '5' | '6', Shift>>;

export interface LeaveBalance {
  staff_id: string;
  name: string;
  year: number;
  /** Jours acquis dans l'année (1,5 jour par mois de service par défaut). */
  acquired: number;
  /** Congés payés accordés dans l'année. */
  taken: number;
  remaining: number;
}

/** Une case du planning : horaire prévu, congé ou repos. */
export interface PlanningCell {
  day: string;
  shift: Shift | null;
  leave: { kind: LeaveKind; status: LeaveStatus } | null;
}

export interface PlanningRow {
  staff_id: string;
  name: string;
  position: string | null;
  user_id: string | null;
  cells: PlanningCell[];
  /** Heures prévues de la semaine (congés exclus), en minutes. */
  minutes: number;
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const pad = (n: number) => String(n).padStart(2, '0');
const localDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const minutesOf = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
export const shiftMinutes = (s: Shift) => Math.max(0, minutesOf(s.end) - minutesOf(s.start));

function eachDay(from: string, to: string, fn: (day: string, weekday: number) => void) {
  for (let d = new Date(`${from}T12:00:00`); localDay(d) <= to; d.setDate(d.getDate() + 1)) fn(localDay(d), d.getDay());
}

/** Semaine type validée : heures HH:MM, fin après le début. */
export function normalizeSchedule(raw: unknown): WeekSchedule {
  const out: WeekSchedule = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^[0-6]$/.test(k) || !v || typeof v !== 'object') continue;
    const { start, end } = v as { start?: unknown; end?: unknown };
    if (typeof start !== 'string' || typeof end !== 'string' || !HHMM.test(start) || !HHMM.test(end)) throw new AppError('Heures au format HH:MM, par exemple 08:00', 'INVALID');
    if (minutesOf(end) <= minutesOf(start)) throw new AppError('La fin doit venir après le début', 'INVALID');
    out[k as '0'] = { start, end };
  }
  return out;
}

/**
 * Congés du personnel et planning : la semaine type de chaque collaborateur
 * (heures par jour), les congés demandés et accordés, le solde de congés payés.
 * Le pointage compare les arrivées et départs à ce planning.
 */
export class StaffTimeService extends Base {
  constructor(
    db: Db,
    clock: Clock,
    private readonly admin: AdminService,
  ) {
    super(db, clock);
  }

  private staff(id: string): { id: string; store_id: string; name: string; hired_on: string | null; created_at: string; active: number } {
    const s = this.db.prepare('SELECT id, store_id, name, hired_on, created_at, active FROM staff WHERE id = ?').get(id) as
      | { id: string; store_id: string; name: string; hired_on: string | null; created_at: string; active: number }
      | undefined;
    if (!s) throw new AppError('Collaborateur introuvable', 'NOT_FOUND');
    return s;
  }

  // --- Semaine type ---------------------------------------------------------------------

  /** Semaine type d'un collaborateur ; sans réglage, les jours et l'heure d'arrivée du magasin. */
  schedule(staffId: string): { schedule: WeekSchedule; custom: boolean } {
    const s = this.staff(staffId);
    const row = this.db.prepare('SELECT days FROM staff_schedules WHERE id = ?').pluck().get(staffId) as string | undefined;
    if (row) {
      try {
        return { schedule: normalizeSchedule(JSON.parse(row)), custom: true };
      } catch {
        // Planning illisible : celui du magasin.
      }
    }
    const set = this.admin.storeSettings(s.store_id);
    const end = `${pad(Math.min(23, Number(set.workStart.slice(0, 2)) + 9))}:${set.workStart.slice(3, 5)}`;
    const schedule: WeekSchedule = {};
    for (const d of set.workDays) schedule[d as '0'] = { start: set.workStart, end };
    return { schedule, custom: false };
  }

  saveSchedule(ctx: Context, staffId: string, days: WeekSchedule | null): WeekSchedule {
    const s = this.staff(staffId);
    if (s.store_id !== ctx.storeId) throw new AppError("Ce collaborateur est d'un autre magasin", 'FORBIDDEN');
    this.tx(() => {
      if (days === null) {
        this.db.prepare('DELETE FROM staff_schedules WHERE id = ?').run(staffId);
        this.enqueue(ctx, 'staff_schedule', staffId, 'delete', null);
      } else {
        const clean = normalizeSchedule(days);
        this.db
          .prepare('INSERT INTO staff_schedules (id, store_id, days, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET days = excluded.days, updated_at = excluded.updated_at')
          .run(staffId, s.store_id, JSON.stringify(clean), this.now());
        this.enqueue(ctx, 'staff_schedule', staffId, 'upsert', {});
      }
      this.audit(ctx.userId, 'staff.schedule', 'staff', staffId, { days });
    });
    return this.schedule(staffId).schedule;
  }

  // --- Congés ----------------------------------------------------------------------------

  /** Jours travaillés (d'après la semaine type) entre deux dates comprises. */
  workingDays(staffId: string, from: string, to: string): number {
    const { schedule } = this.schedule(staffId);
    let n = 0;
    eachDay(from, to, (_d, w) => {
      if (schedule[String(w) as '0']) n += 1;
    });
    return n;
  }

  requestLeave(ctx: Context, input: { staffId: string; kind: LeaveKind; from: string; to: string; reason?: string | null; approved?: boolean }): Leave {
    const s = this.staff(input.staffId);
    if (s.store_id !== ctx.storeId) throw new AppError("Ce collaborateur est d'un autre magasin", 'FORBIDDEN');
    if (!(input.kind in LEAVE_KINDS)) throw new AppError('Type de congé inconnu', 'INVALID');
    if (!DAY.test(input.from) || !DAY.test(input.to)) throw new AppError('Dates invalides', 'INVALID');
    if (input.to < input.from) throw new AppError('La fin du congé précède son début', 'INVALID');
    const days = this.workingDays(s.id, input.from, input.to);
    if (days === 0) throw new AppError('Aucun jour travaillé dans cette période', 'INVALID');
    const overlap = this.db
      .prepare("SELECT 1 FROM staff_leaves WHERE staff_id = ? AND status IN ('requested', 'approved') AND date_from <= ? AND date_to >= ?")
      .get(s.id, input.to, input.from);
    if (overlap) throw new AppError(`${s.name} a déjà un congé sur ces dates`, 'INVALID');
    if (input.kind === 'paid' && input.approved) {
      const b = this.balance(s.id, Number(input.from.slice(0, 4)));
      if (days > b.remaining) throw new AppError(`${s.name} n'a que ${b.remaining} jour(s) de congé payé disponibles`, 'INSUFFICIENT');
    }
    const id = newId();
    const now = this.now();
    return this.tx(() => {
      this.db
        .prepare(
          `INSERT INTO staff_leaves (id, store_id, staff_id, kind, date_from, date_to, days, status, reason, decided_by, user_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, ctx.storeId, s.id, input.kind, input.from, input.to, days, input.approved ? 'approved' : 'requested', input.reason?.trim() || null, input.approved ? ctx.userId : null, ctx.userId, now, now);
      this.enqueue(ctx, 'staff_leave', id, 'upsert', {});
      this.audit(ctx.userId, 'staff.leave', 'staff_leave', id, { staff: s.id, kind: input.kind, from: input.from, to: input.to, days });
      return this.getLeave(id);
    });
  }

  decideLeave(ctx: Context, id: string, decision: 'approved' | 'refused' | 'cancelled'): Leave {
    const l = this.getLeave(id);
    if (l.store_id !== ctx.storeId) throw new AppError("Ce congé est d'un autre magasin", 'FORBIDDEN');
    if (decision !== 'cancelled' && l.status !== 'requested') throw new AppError(`Ce congé est déjà ${LEAVE_STATUS[l.status].toLowerCase()}`, 'INVALID');
    if (decision === 'cancelled' && (l.status === 'cancelled' || l.status === 'refused')) return l;
    if (decision === 'approved' && l.kind === 'paid') {
      const b = this.balance(l.staff_id, Number(l.date_from.slice(0, 4)));
      if (l.days > b.remaining) throw new AppError(`${l.staff_name} n'a que ${b.remaining} jour(s) de congé payé disponibles`, 'INSUFFICIENT');
    }
    this.tx(() => {
      this.db.prepare('UPDATE staff_leaves SET status = ?, decided_by = ?, updated_at = ? WHERE id = ?').run(decision, ctx.userId, this.now(), id);
      this.enqueue(ctx, 'staff_leave', id, 'upsert', {});
      this.audit(ctx.userId, `staff.leave_${decision}`, 'staff_leave', id, { staff: l.staff_id });
    });
    return this.getLeave(id);
  }

  getLeave(id: string): Leave {
    const l = this.leaveQuery('l.id = @id').get({ id }) as Leave | undefined;
    if (!l) throw new AppError('Congé introuvable', 'NOT_FOUND');
    return l;
  }

  leaves(storeId: string, opts: { staffId?: string | null; year?: number | null } = {}): Leave[] {
    return this.leaveQuery('l.store_id = @storeId AND (@staff IS NULL OR l.staff_id = @staff) AND (@year IS NULL OR substr(l.date_from, 1, 4) = @year OR substr(l.date_to, 1, 4) = @year)').all({
      storeId,
      staff: opts.staffId ?? null,
      year: opts.year ? String(opts.year) : null,
    }) as Leave[];
  }

  private leaveQuery(where: string) {
    return this.db.prepare(
      `SELECT l.id, l.store_id, l.staff_id, s.name AS staff_name, l.kind, l.date_from, l.date_to, l.days, l.status, l.reason, u.name AS decided_by_name, l.created_at
       FROM staff_leaves l JOIN staff s ON s.id = l.staff_id LEFT JOIN users u ON u.id = l.decided_by
       WHERE ${where} ORDER BY l.date_from DESC`,
    );
  }

  /** Solde de congés payés de l'année : acquis par mois de service, moins les congés payés accordés. */
  balance(staffId: string, year = Number(this.today().slice(0, 4))): LeaveBalance {
    const s = this.staff(staffId);
    const perMonth = this.admin.storeSettings(s.store_id).leaveDaysPerMonth / 10;
    const start = (s.hired_on ?? s.created_at.slice(0, 10)).slice(0, 10);
    const today = this.today();
    const yearStart = `${year}-01-01`;
    const yearEnd = `${year}-12-31`;
    const from = start > yearStart ? start : yearStart;
    const to = today < yearEnd ? today : yearEnd;
    let months = 0;
    if (from <= to) {
      const [fy, fm, fd] = from.split('-').map(Number);
      const [ty, tm, td] = to.split('-').map(Number);
      months = (ty! - fy!) * 12 + (tm! - fm!) + (td! >= fd! ? 0 : -1);
      months = Math.max(0, months);
    }
    const acquired = Math.round(months * perMonth * 10) / 10;
    const taken = this.db
      .prepare("SELECT COALESCE(SUM(days), 0) FROM staff_leaves WHERE staff_id = ? AND kind = 'paid' AND status = 'approved' AND substr(date_from, 1, 4) = ?")
      .pluck()
      .get(staffId, String(year)) as number;
    return { staff_id: s.id, name: s.name, year, acquired, taken, remaining: Math.max(0, Math.round((acquired - taken) * 10) / 10) };
  }

  balances(storeId: string, year?: number): LeaveBalance[] {
    const ids = this.db.prepare('SELECT id FROM staff WHERE store_id = ? AND active = 1 ORDER BY name').pluck().all(storeId) as string[];
    return ids.map((id) => this.balance(id, year));
  }

  /** Jours de congé accordés d'un collaborateur entre deux dates. */
  leaveDays(staffId: string, from: string, to: string): Map<string, LeaveKind> {
    const rows = this.db
      .prepare("SELECT kind, date_from, date_to FROM staff_leaves WHERE staff_id = ? AND status = 'approved' AND date_from <= ? AND date_to >= ?")
      .all(staffId, to, from) as { kind: LeaveKind; date_from: string; date_to: string }[];
    const out = new Map<string, LeaveKind>();
    for (const r of rows) eachDay(r.date_from > from ? r.date_from : from, r.date_to < to ? r.date_to : to, (d) => out.set(d, r.kind));
    return out;
  }

  // --- Planning ----------------------------------------------------------------------------

  /** Planning de la semaine qui commence ce jour (lundi conseillé) : horaires, congés et repos. */
  week(storeId: string, monday: string): PlanningRow[] {
    if (!DAY.test(monday)) throw new AppError('Date invalide', 'INVALID');
    const days: string[] = [];
    const start = new Date(`${monday}T12:00:00`);
    for (let i = 0; i < 7; i += 1) {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      days.push(localDay(d));
    }
    const staff = this.db.prepare('SELECT id, name, position, user_id FROM staff WHERE store_id = ? AND active = 1 ORDER BY name').all(storeId) as {
      id: string;
      name: string;
      position: string | null;
      user_id: string | null;
    }[];
    const leaves = this.db
      .prepare("SELECT staff_id, kind, status, date_from, date_to FROM staff_leaves WHERE store_id = ? AND status IN ('requested', 'approved') AND date_from <= ? AND date_to >= ?")
      .all(storeId, days[6], days[0]) as { staff_id: string; kind: LeaveKind; status: LeaveStatus; date_from: string; date_to: string }[];
    return staff.map((s) => {
      const { schedule } = this.schedule(s.id);
      const cells = days.map((day) => {
        const w = new Date(`${day}T12:00:00`).getDay();
        const leave = leaves.find((l) => l.staff_id === s.id && l.date_from <= day && l.date_to >= day);
        return { day, shift: schedule[String(w) as '0'] ?? null, leave: leave ? { kind: leave.kind, status: leave.status } : null };
      });
      const minutes = cells.reduce((t, c) => t + (c.shift && !(c.leave?.status === 'approved') ? shiftMinutes(c.shift) : 0), 0);
      return { staff_id: s.id, name: s.name, position: s.position, user_id: s.user_id, cells, minutes };
    });
  }
}
