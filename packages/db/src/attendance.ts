import { attendancePay, type AttendancePayFacts, type PayLine, STAFF_KINDS_SHORT, type PunchMethod, type StaffKind } from '@superette/core';
import type { AdminService } from './admin';
import type { Db } from './database';
import type { PersonnelService } from './personnel';
import type { PunchService } from './punches';
import type { StaffTimeService } from './staffTime';
import { AppError, Base, type Clock } from './util';

/** Une journée pointée : arrivée à la première connexion, départ à la clôture de caisse ou par « Je pars ». */
export interface Attendance {
  id: string;
  store_id: string | null;
  user_id: string;
  day: string;
  arrived_at: string | null;
  left_at: string | null;
  corrected_by: string | null;
  correction_reason: string | null;
  updated_at: string;
}

export interface AttendanceDay {
  day: string;
  arrived_at: string | null;
  left_at: string | null;
  /** Minutes entre l'arrivée et le départ (0 sans départ). */
  minutes: number;
  /** Minutes de retard au-delà de l'heure d'arrivée et de la tolérance. */
  late_minutes: number;
  /** Minutes de départ avant la fin prévue au planning. */
  early_minutes: number;
  corrected: boolean;
  correction_reason: string | null;
  /** Présences du jour (deux avec une pause pointée). */
  sessions?: number;
  /** Arrivée sans départ pointé. */
  open?: boolean;
  methods?: PunchMethod[];
  /** Jour férié travaillé. */
  holiday?: string | null;
}

export interface AttendanceMonthRow {
  /** « staff:… » pour une fiche collaborateur, « user:… » pour un utilisateur sans fiche. */
  key: string;
  staff_id: string | null;
  user_id: string | null;
  name: string;
  /** Rôle de l'utilisateur, ou catégorie du collaborateur (Employé, Journalier…). */
  role: string;
  category: StaffKind | null;
  agency_name: string | null;
  position: string | null;
  days: AttendanceDay[];
  present: number;
  minutes: number;
  late: number;
  late_minutes: number;
  /** Jours travaillés passés du mois sans aucun pointage (congés accordés exclus). */
  absences: string[];
  /** Jours de congé accordés dans le mois. */
  leave_days: string[];
  /** Heures prévues au planning sur les jours passés du mois (congés exclus), en minutes. */
  scheduled_minutes: number;
  /** Jours fériés du mois (ni absence ni retard). */
  holidays: string[];
  /** Jours fériés où il a travaillé. */
  worked_holidays: number;
}

/** Salaire du mois proposé d'après le pointage, pour un collaborateur. */
export interface PayProposal {
  staff_id: string;
  name: string;
  facts: AttendancePayFacts;
  lines: PayLine[];
  gross: number;
}

const pad = (n: number) => String(n).padStart(2, '0');
const localDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** Minutes après minuit, à l'heure locale du poste. */
const toMinutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const localMinutes = (iso: string) => {
  const d = new Date(iso);
  return d.getHours() * 60 + d.getMinutes();
};

/**
 * Pointage du personnel : chaque utilisateur est pointé arrivé à sa première
 * connexion du jour, parti à sa clôture de caisse ou quand il clique
 * « Je pars ». Le gérant corrige un oubli avec un motif.
 */
export class AttendanceService extends Base {
  constructor(
    db: Db,
    clock: Clock,
    private readonly admin: AdminService,
    private readonly time: StaffTimeService,
    private readonly personnel: PersonnelService,
    private readonly punches: PunchService,
  ) {
    super(db, clock);
  }

  get(userId: string, day = this.today()): Attendance | null {
    return (this.db.prepare('SELECT * FROM attendance WHERE id = ?').get(`${userId}:${day}`) as Attendance | undefined) ?? null;
  }

  private save(row: Attendance): Attendance {
    this.db
      .prepare(
        `INSERT INTO attendance (id, store_id, user_id, day, arrived_at, left_at, corrected_by, correction_reason, updated_at)
         VALUES (@id, @store_id, @user_id, @day, @arrived_at, @left_at, @corrected_by, @correction_reason, @updated_at)
         ON CONFLICT(id) DO UPDATE SET arrived_at = excluded.arrived_at, left_at = excluded.left_at, corrected_by = excluded.corrected_by,
           correction_reason = excluded.correction_reason, updated_at = excluded.updated_at`,
      )
      .run(row);
    this.enqueue(row.store_id ? { storeId: row.store_id, registerId: null } : null, 'attendance', row.id, 'upsert', row);
    return row;
  }

  /** Pointage à la connexion : désactivable dans les paramètres (la borne de l'entrée suffit alors). */
  private loginPunches(storeId: string | null): boolean {
    return !storeId || this.admin.storeSettings(storeId).punchLogin;
  }

  /** Première connexion du jour : l'arrivée est notée (une seule fois par jour). */
  arrive(userId: string, storeId: string | null): Attendance | null {
    if (!this.loginPunches(storeId)) return null;
    if (storeId) this.punches.loginArrive(userId, storeId);
    const day = this.today();
    const cur = this.get(userId, day);
    if (cur?.arrived_at) return cur;
    const now = this.now();
    return this.save({
      id: `${userId}:${day}`,
      store_id: cur?.store_id ?? storeId,
      user_id: userId,
      day,
      arrived_at: now,
      left_at: cur?.left_at ?? null,
      corrected_by: cur?.corrected_by ?? null,
      correction_reason: cur?.correction_reason ?? null,
      updated_at: now,
    });
  }

  /** Départ : clôture de sa caisse ou « Je pars ». Un second départ remplace le premier (il est revenu). */
  leave(userId: string, storeId: string | null): Attendance | null {
    if (!this.loginPunches(storeId)) return null;
    if (storeId) this.punches.loginLeave(userId, storeId);
    const day = this.today();
    const cur = this.get(userId, day);
    const now = this.now();
    return this.save({
      id: `${userId}:${day}`,
      store_id: cur?.store_id ?? storeId,
      user_id: userId,
      day,
      arrived_at: cur?.arrived_at ?? now,
      left_at: now,
      corrected_by: cur?.corrected_by ?? null,
      correction_reason: cur?.correction_reason ?? null,
      updated_at: now,
    });
  }

  /** Correction du gérant : heures d'arrivée et de départ (HH:MM, vide pour effacer), avec un motif. */
  correct(byUserId: string, userId: string, day: string, input: { arrived: string | null; left: string | null; reason: string }): Attendance {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new AppError('Date invalide', 'INVALID');
    if (day > this.today()) throw new AppError('On ne pointe pas un jour à venir', 'INVALID');
    if (!input.reason.trim()) throw new AppError('Indiquez le motif de la correction', 'INVALID');
    const at = (hm: string | null) => {
      if (!hm) return null;
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(hm)) throw new AppError('Heure attendue au format HH:MM', 'INVALID');
      const [y, m, d] = day.split('-').map(Number);
      const [h, min] = hm.split(':').map(Number);
      return new Date(y!, m! - 1, d!, h!, min!).toISOString();
    };
    const arrived = at(input.arrived);
    const left = at(input.left);
    if (arrived && left && left < arrived) throw new AppError("Le départ est avant l'arrivée", 'INVALID');
    const user = this.admin.getUser(userId);
    const cur = this.get(userId, day);
    const row = this.save({
      id: `${userId}:${day}`,
      store_id: cur?.store_id ?? user.store_id,
      user_id: userId,
      day,
      arrived_at: arrived,
      left_at: left,
      corrected_by: byUserId,
      correction_reason: input.reason.trim(),
      updated_at: this.now(),
    });
    this.audit(byUserId, 'attendance.correct', 'user', userId, { day, arrived: input.arrived, left: input.left, reason: input.reason.trim() });
    return row;
  }

  /**
   * État du mois (AAAA-MM) : chaque collaborateur du magasin (avec ou sans accès
   * au logiciel), et les utilisateurs sans fiche. Présences, heures, retards,
   * absences, congés et jours fériés, d'après l'horaire prévu de chacun.
   */
  month(storeId: string, period: string, opts: { category?: StaffKind | null; agencyId?: string | null } = {}): AttendanceMonthRow[] {
    if (!/^\d{4}-\d{2}$/.test(period)) throw new AppError('Mois invalide', 'INVALID');
    const today = this.today();
    const [y, m] = period.split('-').map(Number);
    const monthDays: string[] = [];
    for (let d = new Date(y!, m! - 1, 1); d.getMonth() === m! - 1; d.setDate(d.getDate() + 1)) {
      const day = localDay(d);
      if (day >= today) break;
      monthDays.push(day);
    }
    const first = `${period}-01`;
    const last = `${period}-31`;
    const holidays = this.personnel.holidays(storeId, first, last);
    const staff = this.db
      .prepare(
        `SELECT s.id, s.name, s.position, s.category, s.user_id, s.active, COALESCE(s.hired_on, substr(s.created_at, 1, 10)) AS since, ag.name AS agency_name FROM staff s LEFT JOIN staff_agencies ag ON ag.id = s.agency_id
         WHERE s.store_id = @store AND (s.active = 1 OR EXISTS (SELECT 1 FROM time_punches p WHERE p.staff_id = s.id AND p.at >= @first AND p.status = 'active'))
           AND (@category IS NULL OR s.category = @category) AND (@agency IS NULL OR s.agency_id = @agency) ORDER BY s.name`,
      )
      .all({ store: storeId, first: `${first}T00:00:00`, category: opts.category ?? null, agency: opts.agencyId ?? null }) as {
      id: string;
      name: string;
      position: string | null;
      category: StaffKind;
      user_id: string | null;
      active: number;
      since: string;
      agency_name: string | null;
    }[];
    const rows: AttendanceMonthRow[] = staff.map((s) => {
      const days: AttendanceDay[] = this.punches.days(s.id, first, last, holidays);
      const leaves = this.time.leaveDays(s.id, first, last);
      const seen = new Set(days.map((d) => d.day));
      // Pas d'absence avant son entrée au magasin.
      const plans = monthDays.filter((day) => day >= s.since).map((day) => ({ day, plan: this.personnel.plan(s.id, day, { holidays }) }));
      const expected = plans.filter((p) => p.plan.shift);
      return {
        key: `staff:${s.id}`,
        staff_id: s.id,
        user_id: s.user_id,
        name: s.name,
        role: STAFF_KINDS_SHORT[s.category] ?? s.category,
        category: s.category,
        agency_name: s.agency_name,
        position: s.position,
        days,
        present: days.filter((d) => d.arrived_at || d.left_at).length,
        minutes: days.reduce((a, d) => a + d.minutes, 0),
        late: days.filter((d) => d.late_minutes > 0).length,
        late_minutes: days.reduce((a, d) => a + d.late_minutes, 0),
        absences: expected.filter((p) => !seen.has(p.day) && !leaves.has(p.day)).map((p) => p.day),
        leave_days: [...leaves.keys()].filter((d) => d.startsWith(period)).sort(),
        scheduled_minutes: expected.filter((p) => !leaves.has(p.day)).reduce((t, p) => t + p.plan.shift!.minutes, 0),
        holidays: [...holidays.keys()].sort(),
        worked_holidays: days.filter((d) => d.holiday && d.minutes > 0).length,
      };
    });
    if (opts.category || opts.agencyId) return rows;
    return [...rows, ...this.usersWithoutFiche(storeId, period, monthDays, holidays)].sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Salaires du mois (AAAA-MM) proposés d'après le pointage, avec les règles
   * choisies dans les paramètres : base ou jours de présence (journaliers),
   * retenues d'absence et de retard, heures supplémentaires, fériés
   * travaillés, prime d'assiduité et primes fixes. Les agents des sociétés
   * prestataires n'y sont pas : leur société les paie.
   */
  payProposals(storeId: string, period: string): PayProposal[] {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) throw new AppError('Mois invalide (AAAA-MM)', 'INVALID');
    const set = this.admin.storeSettings(storeId);
    const today = this.today();
    const [y, m] = period.split('-').map(Number);
    const allDays: string[] = [];
    for (let d = new Date(y!, m! - 1, 1); d.getMonth() === m! - 1; d.setDate(d.getDate() + 1)) allDays.push(localDay(d));
    const first = allDays[0]!;
    const last = allDays[allDays.length - 1]!;
    const holidays = this.personnel.holidays(storeId, first, last);
    const staff = this.db
      .prepare(
        `SELECT id, name, base_salary, daily_rate, allowance, COALESCE(hired_on, substr(created_at, 1, 10)) AS since FROM staff
         WHERE store_id = ? AND active = 1 AND category <> 'contractor' ORDER BY name`,
      )
      .all(storeId) as { id: string; name: string; base_salary: number; daily_rate: number; allowance: number; since: string }[];
    return staff.map((st) => {
      const leaves = this.time.leaveDays(st.id, first, last);
      const plans = new Map(allDays.filter((d) => d >= st.since).map((d) => [d, this.personnel.plan(st.id, d, { holidays })]));
      const planned = [...plans.entries()].filter(([, p]) => p.shift);
      const days = this.punches.days(st.id, first, last, holidays);
      const seen = new Set(days.filter((d) => d.arrived_at || d.left_at).map((d) => d.day));
      let overtime = 0;
      let holidayMinutes = 0;
      for (const d of days) {
        if (!d.minutes) continue;
        if (d.holiday) {
          holidayMinutes += d.minutes;
          continue;
        }
        const shift = plans.get(d.day)?.shift;
        const extra = shift ? d.minutes - shift.minutes : d.minutes;
        if (extra > 0 && extra >= set.overtimeMinMinutes) overtime += extra;
      }
      const facts: AttendancePayFacts = {
        base: st.base_salary,
        dailyRate: st.daily_rate,
        allowance: st.allowance,
        plannedDays: planned.length,
        presentDays: seen.size,
        absences: planned.filter(([d]) => d < today && !seen.has(d) && !leaves.has(d)).length,
        unpaidLeave: planned.filter(([d]) => leaves.get(d) === 'unpaid').length,
        lateMinutes: days.reduce((t, d) => t + d.late_minutes, 0),
        lateCount: days.filter((d) => d.late_minutes > 0).length,
        overtimeMinutes: overtime,
        holidayMinutes,
      };
      const { lines, gross } = attendancePay(facts, set);
      return { staff_id: st.id, name: st.name, facts, lines, gross };
    });
  }

  /** Utilisateurs qui n'ont pas de fiche collaborateur : pointés à la connexion, d'après les jours et l'heure du magasin. */
  private usersWithoutFiche(storeId: string, period: string, monthDays: string[], holidays: Map<string, string>): AttendanceMonthRow[] {
    const settings = this.admin.storeSettings(storeId);
    const users = this.db
      .prepare(
        `SELECT id, name, role FROM users u WHERE deleted_at IS NULL AND active = 1 AND role <> 'admin' AND (store_id = ? OR store_id IS NULL)
           AND NOT EXISTS (SELECT 1 FROM staff s WHERE s.user_id = u.id AND s.store_id = ?) ORDER BY name`,
      )
      .all(storeId, storeId) as { id: string; name: string; role: string }[];
    const rows = this.db.prepare("SELECT * FROM attendance WHERE day LIKE ? || '-%' ORDER BY day").all(period) as Attendance[];
    const byUser = new Map<string, Attendance[]>();
    for (const r of rows) byUser.set(r.user_id, [...(byUser.get(r.user_id) ?? []), r]);
    const isWorkday = (day: string) => settings.workDays.includes(String(new Date(`${day}T12:00:00`).getDay())) && !holidays.has(day);
    return users.map((u) => {
      const days: AttendanceDay[] = (byUser.get(u.id) ?? [])
        .filter((r) => r.arrived_at || r.left_at)
        .map((r) => {
          const minutes = r.arrived_at && r.left_at ? Math.max(0, Math.round((Date.parse(r.left_at) - Date.parse(r.arrived_at)) / 60_000)) : 0;
          const start = isWorkday(r.day) ? toMinutes(settings.workStart) : null;
          const arrived = r.arrived_at ? localMinutes(r.arrived_at) : null;
          const late = start !== null && arrived !== null && arrived > start + settings.lateToleranceMinutes ? arrived - start : 0;
          return { day: r.day, arrived_at: r.arrived_at, left_at: r.left_at, minutes, late_minutes: late, early_minutes: 0, corrected: Boolean(r.corrected_by), correction_reason: r.correction_reason, holiday: holidays.get(r.day) ?? null };
        });
      const seen = new Set(days.map((d) => d.day));
      return {
        key: `user:${u.id}`,
        staff_id: null,
        user_id: u.id,
        name: u.name,
        role: u.role,
        category: null,
        agency_name: null,
        position: null,
        days,
        present: days.length,
        minutes: days.reduce((a, d) => a + d.minutes, 0),
        late: days.filter((d) => d.late_minutes > 0).length,
        late_minutes: days.reduce((a, d) => a + d.late_minutes, 0),
        absences: monthDays.filter((d) => isWorkday(d) && !seen.has(d)),
        leave_days: [],
        scheduled_minutes: 0,
        holidays: [...holidays.keys()].sort(),
        worked_holidays: days.filter((d) => d.holiday && d.minutes > 0).length,
      };
    });
  }
}
