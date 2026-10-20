import type { AdminService } from './admin';
import type { Db } from './database';
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
  corrected: boolean;
  correction_reason: string | null;
}

export interface AttendanceMonthRow {
  user_id: string;
  name: string;
  role: string;
  days: AttendanceDay[];
  present: number;
  minutes: number;
  late: number;
  late_minutes: number;
  /** Jours travaillés passés du mois sans aucun pointage. */
  absences: string[];
}

const pad = (n: number) => String(n).padStart(2, '0');
const localDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** Minutes après minuit, à l'heure locale du poste. */
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

  /** Première connexion du jour : l'arrivée est notée (une seule fois par jour). */
  arrive(userId: string, storeId: string | null): Attendance {
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
  leave(userId: string, storeId: string | null): Attendance {
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

  /** État du mois (AAAA-MM) : présence, heures, retards et absences de chaque employé du magasin. */
  month(storeId: string, period: string): AttendanceMonthRow[] {
    if (!/^\d{4}-\d{2}$/.test(period)) throw new AppError('Mois invalide', 'INVALID');
    const settings = this.admin.storeSettings(storeId);
    const [sh, sm] = settings.workStart.split(':').map(Number);
    const startMin = sh! * 60 + sm!;
    const lateAfter = startMin + settings.lateToleranceMinutes;
    const today = this.today();
    const [y, m] = period.split('-').map(Number);
    const workDays: string[] = [];
    for (let d = new Date(y!, m! - 1, 1); d.getMonth() === m! - 1; d.setDate(d.getDate() + 1)) {
      const day = localDay(d);
      if (day >= today) break;
      if (settings.workDays.includes(String(d.getDay()))) workDays.push(day);
    }
    const users = this.db
      .prepare("SELECT id, name, role FROM users WHERE deleted_at IS NULL AND active = 1 AND role <> 'admin' AND (store_id = ? OR store_id IS NULL) ORDER BY name")
      .all(storeId) as { id: string; name: string; role: string }[];
    const rows = this.db.prepare("SELECT * FROM attendance WHERE day LIKE ? || '-%' ORDER BY day").all(period) as Attendance[];
    const byUser = new Map<string, Attendance[]>();
    for (const r of rows) byUser.set(r.user_id, [...(byUser.get(r.user_id) ?? []), r]);
    return users.map((u) => {
      const days: AttendanceDay[] = (byUser.get(u.id) ?? [])
        .filter((r) => r.arrived_at || r.left_at)
        .map((r) => {
          const minutes = r.arrived_at && r.left_at ? Math.max(0, Math.round((Date.parse(r.left_at) - Date.parse(r.arrived_at)) / 60_000)) : 0;
          const late = r.arrived_at && settings.workDays.includes(String(new Date(r.arrived_at).getDay())) ? localMinutes(r.arrived_at) > lateAfter ? localMinutes(r.arrived_at) - startMin : 0 : 0;
          return { day: r.day, arrived_at: r.arrived_at, left_at: r.left_at, minutes, late_minutes: late, corrected: Boolean(r.corrected_by), correction_reason: r.correction_reason };
        });
      const seen = new Set(days.map((d) => d.day));
      return {
        user_id: u.id,
        name: u.name,
        role: u.role,
        days,
        present: days.length,
        minutes: days.reduce((a, d) => a + d.minutes, 0),
        late: days.filter((d) => d.late_minutes > 0).length,
        late_minutes: days.reduce((a, d) => a + d.late_minutes, 0),
        absences: workDays.filter((d) => !seen.has(d)),
      };
    });
  }
}
