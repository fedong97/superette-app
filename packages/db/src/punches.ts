import { type PunchMethod } from '@superette/core';
import type { AdminService } from './admin';
import type { Db } from './database';
import type { PersonnelService, ExpectedShift } from './personnel';
import type { StaffTimeService } from './staffTime';
import { AppError, Base, type Clock, type Context, newId, verifyPin } from './util';

/** Un passage pointé : arrivée ou départ. */
export interface TimePunch {
  id: string;
  store_id: string;
  staff_id: string;
  entrance_id: string | null;
  at: string;
  kind: 'in' | 'out';
  method: PunchMethod;
  photo: string | null;
  station: string | null;
  user_id: string | null;
  reason: string | null;
  status: 'active' | 'cancelled';
  created_at: string;
  updated_at: string;
}

/** Une présence : de l'arrivée au départ (départ absent tant qu'il n'est pas pointé). */
export interface WorkSession {
  day: string;
  in: TimePunch | null;
  out: TimePunch | null;
  minutes: number;
}

/** Une journée d'un collaborateur : présences, retard et départ anticipé d'après l'horaire prévu. */
export interface StaffDay {
  day: string;
  arrived_at: string | null;
  left_at: string | null;
  minutes: number;
  late_minutes: number;
  early_minutes: number;
  /** Nombre de présences (pause de midi : deux présences). */
  sessions: number;
  /** Arrivée sans départ pointé (jour passé). */
  open: boolean;
  methods: PunchMethod[];
  corrected: boolean;
  correction_reason: string | null;
  holiday: string | null;
}

/** Ce que la borne affiche après un passage. */
export interface PunchResult {
  staff: { id: string; name: string; position: string | null; photo: string | null; category: string };
  punch: TimePunch;
  /** Passage déjà noté il y a moins de quelques minutes : rien de nouveau. */
  duplicate: boolean;
  late_minutes: number;
  /** Heure prévue de début ou de fin (HH:MM), pour le message. */
  expected: string | null;
}

/** Présences du jour, pour l'écran « Qui est là ». */
export interface PresenceRow {
  staff_id: string;
  name: string;
  position: string | null;
  category: string;
  agency_name: string | null;
  team: string | null;
  state: 'present' | 'left' | 'expected' | 'late' | 'absent' | 'leave' | 'off';
  since: string | null;
  left_at: string | null;
  entrance: string | null;
  method: PunchMethod | null;
  expected_start: string | null;
  expected_end: string | null;
  late_minutes: number;
  has_photo: boolean;
}

/** Au-delà de ce délai, une arrivée sans départ ne s'apparie plus : le passage suivant est une nouvelle arrivée. */
const MAX_SESSION_MS = 20 * 3_600_000;
const pad = (n: number) => String(n).padStart(2, '0');
const localDay = (iso: string | Date) => {
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const hm = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const addDays = (day: string, n: number) => {
  const d = new Date(`${day}T12:00:00`);
  d.setDate(d.getDate() + n);
  return localDay(d);
};
/** Début du jour à l'heure locale, en ISO (UTC). */
const dayStartIso = (day: string) => {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y!, m! - 1, d!).toISOString();
};

/**
 * Passages à la borne de l'entrée (badge, numéro et code, photo), à la
 * connexion au logiciel ou saisis par le gérant. Les passages se suivent :
 * arrivée, départ, arrivée… La journée d'une présence est celle de
 * l'arrivée : une garde de nuit compte pour le jour où elle commence.
 */
export class PunchService extends Base {
  /** Codes faux tapés à la borne : numéro de pointage → essais et fin du blocage. */
  private readonly failures = new Map<string, { count: number; until: number }>();

  constructor(
    db: Db,
    clock: Clock,
    private readonly admin: AdminService,
    private readonly personnel: PersonnelService,
    private readonly time: StaffTimeService,
  ) {
    super(db, clock);
  }

  private staffInfo(id: string) {
    const s = this.db
      .prepare(
        `SELECT s.id, s.store_id, s.name, s.position, s.category, s.active, s.user_id, s.punch_pin_hash, ag.name AS agency_name
         FROM staff s LEFT JOIN staff_agencies ag ON ag.id = s.agency_id WHERE s.id = ?`,
      )
      .get(id) as
      | { id: string; store_id: string; name: string; position: string | null; category: string; active: number; user_id: string | null; punch_pin_hash: string | null; agency_name: string | null }
      | undefined;
    if (!s) throw new AppError('Collaborateur introuvable', 'NOT_FOUND');
    return s;
  }

  /** Dernier passage actif d'un collaborateur. */
  last(staffId: string): TimePunch | null {
    return (this.db.prepare("SELECT * FROM time_punches WHERE staff_id = ? AND status = 'active' ORDER BY at DESC LIMIT 1").get(staffId) as TimePunch | undefined) ?? null;
  }

  /** Le collaborateur est-il là : dernière arrivée il y a moins de 20 heures, sans départ depuis ? */
  isIn(staffId: string): boolean {
    const l = this.last(staffId);
    return Boolean(l && l.kind === 'in' && this.clock().getTime() - Date.parse(l.at) < MAX_SESSION_MS);
  }

  private insert(row: Omit<TimePunch, 'id' | 'created_at' | 'updated_at' | 'status'> & { status?: TimePunch['status'] }): TimePunch {
    const now = this.now();
    const punch: TimePunch = { id: newId(), status: 'active', created_at: now, updated_at: now, ...row } as TimePunch;
    this.db
      .prepare(
        `INSERT INTO time_punches (id, store_id, staff_id, entrance_id, at, kind, method, photo, station, user_id, reason, status, created_at, updated_at)
         VALUES (@id, @store_id, @staff_id, @entrance_id, @at, @kind, @method, @photo, @station, @user_id, @reason, @status, @created_at, @updated_at)`,
      )
      .run(punch);
    this.enqueue({ storeId: punch.store_id, registerId: null }, 'time_punch', punch.id, 'upsert', {});
    return punch;
  }

  // --- La borne -----------------------------------------------------------------------------

  /**
   * Retrouve la personne à la borne : badge de pointage (FP…), badge de son
   * compte utilisateur (FX…), ou numéro de pointage et code personnel.
   */
  identify(storeId: string, input: { badge?: string | null; number?: number | string | null; pin?: string | null }): string {
    const set = this.admin.storeSettings(storeId);
    if (input.badge) {
      if (!set.punchBadge) throw new AppError('Le pointage par badge n’est pas activé (Administration › Paramètres › Pointage)', 'FORBIDDEN');
      const code = input.badge.trim().toUpperCase();
      const id =
        (this.db.prepare('SELECT id FROM staff WHERE badge = ? AND store_id = ?').pluck().get(code, storeId) as string | undefined) ??
        (this.db
          .prepare('SELECT s.id FROM staff s JOIN users u ON u.id = s.user_id WHERE u.badge = ? AND s.store_id = ? AND u.deleted_at IS NULL ORDER BY s.active DESC, s.created_at LIMIT 1')
          .pluck()
          .get(code, storeId) as string | undefined);
      if (!id) {
        const user = this.db.prepare('SELECT 1 FROM users WHERE badge = ?').get(code);
        throw new AppError(user ? 'Ce badge n’a pas de fiche collaborateur dans ce magasin : demandez au gérant de la créer' : 'Badge inconnu', 'NOT_FOUND');
      }
      return id;
    }
    if (input.number !== undefined && input.number !== null && input.number !== '') {
      if (!set.punchPin) throw new AppError('Le pointage par numéro et code n’est pas activé', 'FORBIDDEN');
      const n = Math.round(Number(input.number));
      const key = `${storeId}:${n}`;
      const fail = this.failures.get(key);
      if (fail && fail.until > Date.now()) throw new AppError('Trop de codes faux : réessayez dans 5 minutes ou appelez le gérant', 'LOCKED');
      const rows = this.db.prepare('SELECT id, punch_pin_hash FROM staff WHERE store_id = ? AND punch_number = ? AND active = 1').all(storeId, n) as { id: string; punch_pin_hash: string | null }[];
      if (rows.length > 1) throw new AppError('Ce numéro de pointage est donné deux fois : le gérant doit en refaire un (fiche du collaborateur)', 'INVALID');
      const row = rows[0];
      if (!row || !row.punch_pin_hash || !input.pin || !verifyPin(input.pin, row.punch_pin_hash)) {
        const count = (fail && fail.until <= Date.now() && fail.count >= 5 ? 0 : (fail?.count ?? 0)) + 1;
        this.failures.set(key, { count, until: count >= 5 ? Date.now() + 5 * 60_000 : 0 });
        throw new AppError(row && !row.punch_pin_hash ? 'Pas encore de code de pointage : demandez-le au gérant' : 'Numéro ou code incorrect', 'INVALID_PIN');
      }
      this.failures.delete(key);
      return row.id;
    }
    throw new AppError('Passez votre badge ou tapez votre numéro', 'INVALID');
  }

  /**
   * Passage à la borne : arrivée si la personne n'est pas là, départ sinon.
   * Deux passages rapprochés (double scan) comptent pour un seul.
   */
  punch(
    storeId: string,
    input: { badge?: string | null; number?: number | string | null; pin?: string | null; entranceId?: string | null; photo?: string | null; station?: string | null },
  ): PunchResult {
    const set = this.admin.storeSettings(storeId);
    if (!set.punchKiosk) throw new AppError('La borne de pointage n’est pas activée (Administration › Paramètres › Pointage)', 'FORBIDDEN');
    const staffId = this.identify(storeId, input);
    const s = this.staffInfo(staffId);
    if (!s.active) throw new AppError(`${s.name} est marqué parti : pointage refusé`, 'FORBIDDEN');
    if (input.photo && (!/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(input.photo) || input.photo.length > 80_000)) throw new AppError('Photo de la caméra illisible', 'INVALID');
    let entranceId = input.entranceId ?? null;
    if (entranceId) {
      const e = this.personnel.getEntrance(entranceId);
      if (e.store_id !== storeId) throw new AppError("Cette entrée est d'un autre magasin", 'FORBIDDEN');
    } else entranceId = this.personnel.mainEntrance({ storeId, registerId: null }).id;
    const info = { id: s.id, name: s.name, position: s.position, photo: this.personnel.photo(s.id), category: s.category };
    const last = this.last(staffId);
    const now = this.clock();
    if (last && now.getTime() - Date.parse(last.at) < set.punchGapMinutes * 60_000) {
      return { staff: info, punch: last, duplicate: true, late_minutes: 0, expected: null };
    }
    const kind: 'in' | 'out' = last && last.kind === 'in' && now.getTime() - Date.parse(last.at) < MAX_SESSION_MS ? 'out' : 'in';
    const punch = this.tx(() =>
      this.insert({
        store_id: storeId,
        staff_id: staffId,
        entrance_id: entranceId,
        at: now.toISOString(),
        kind,
        method: input.badge ? 'badge' : 'pin',
        photo: set.punchPhoto ? (input.photo ?? null) : null,
        station: input.station ?? null,
        user_id: null,
        reason: null,
      }),
    );
    const { late, expected } = this.lateness(staffId, punch);
    return { staff: info, punch, duplicate: false, late_minutes: late, expected };
  }

  /** Retard d'une arrivée (ou avance d'un départ) d'après l'horaire prévu du jour. */
  private lateness(staffId: string, punch: TimePunch): { late: number; expected: string | null } {
    const day = localDay(punch.at);
    const shift = this.shiftAround(staffId, punch.kind === 'in' ? day : this.sessionDay(staffId, punch));
    if (!shift) return { late: 0, expected: null };
    const at = Date.parse(punch.at);
    if (punch.kind === 'in') {
      const late = Math.round((at - shift.start.getTime()) / 60_000);
      return { late: late > shift.tolerance ? late : 0, expected: hm(shift.start) };
    }
    return { late: 0, expected: hm(shift.end) };
  }

  /** Jour de la présence qu'un départ termine (celui de l'arrivée). */
  private sessionDay(staffId: string, out: TimePunch): string {
    const prev = this.db
      .prepare("SELECT at FROM time_punches WHERE staff_id = ? AND status = 'active' AND kind = 'in' AND at < ? ORDER BY at DESC LIMIT 1")
      .pluck()
      .get(staffId, out.at) as string | undefined;
    return prev && Date.parse(out.at) - Date.parse(prev) < MAX_SESSION_MS ? localDay(prev) : localDay(out.at);
  }

  private shiftAround(staffId: string, day: string): ExpectedShift | null {
    const leave = this.time.leaveDays(staffId, day, day);
    if (leave.size) return null;
    return this.personnel.plan(staffId, day).shift;
  }

  // --- Connexion au logiciel ------------------------------------------------------------------

  /** Première connexion du jour d'un utilisateur qui a une fiche : arrivée, s'il n'est pas déjà pointé. */
  loginArrive(userId: string, storeId: string): TimePunch | null {
    const staffId = this.staffOfUser(userId, storeId);
    if (!staffId || this.isIn(staffId)) return null;
    const today = this.today();
    const already = this.db.prepare("SELECT 1 FROM time_punches WHERE staff_id = ? AND status = 'active' AND at >= ?").get(staffId, dayStartIso(today));
    if (already) return null;
    return this.tx(() => this.insert({ store_id: storeId, staff_id: staffId, entrance_id: null, at: this.now(), kind: 'in', method: 'login', photo: null, station: null, user_id: userId, reason: null }));
  }

  /** « Je pars » ou clôture de caisse : départ. Un second départ par la connexion remplace le premier (il était revenu). */
  loginLeave(userId: string, storeId: string): TimePunch | null {
    const staffId = this.staffOfUser(userId, storeId);
    if (!staffId) return null;
    const last = this.last(staffId);
    if (last && last.kind === 'in' && this.clock().getTime() - Date.parse(last.at) < MAX_SESSION_MS) {
      return this.tx(() => this.insert({ store_id: storeId, staff_id: staffId, entrance_id: null, at: this.now(), kind: 'out', method: 'login', photo: null, station: null, user_id: userId, reason: null }));
    }
    if (last && last.kind === 'out' && last.method === 'login' && localDay(last.at) === this.today()) {
      const now = this.now();
      this.db.prepare('UPDATE time_punches SET at = ?, updated_at = ? WHERE id = ?').run(now, now, last.id);
      this.enqueue({ storeId, registerId: null }, 'time_punch', last.id, 'upsert', {});
      return { ...last, at: now, updated_at: now };
    }
    return null;
  }

  private staffOfUser(userId: string, storeId: string): string | null {
    return (this.db.prepare('SELECT id FROM staff WHERE user_id = ? AND store_id = ? AND active = 1 ORDER BY created_at LIMIT 1').pluck().get(userId, storeId) as string | undefined) ?? null;
  }

  // --- Journées -----------------------------------------------------------------------------

  /** Présences d'un collaborateur dont l'arrivée tombe entre deux jours (compris). */
  sessions(staffId: string, from: string, to: string): WorkSession[] {
    const punches = this.db
      .prepare("SELECT * FROM time_punches WHERE staff_id = ? AND status = 'active' AND at >= ? AND at < ? ORDER BY at, created_at")
      .all(staffId, dayStartIso(addDays(from, -1)), dayStartIso(addDays(to, 2))) as TimePunch[];
    const out: WorkSession[] = [];
    let open: TimePunch | null = null;
    for (const p of punches) {
      if (p.kind === 'in') {
        if (open) out.push({ day: localDay(open.at), in: open, out: null, minutes: 0 });
        open = p;
      } else if (open && Date.parse(p.at) - Date.parse(open.at) < MAX_SESSION_MS) {
        out.push({ day: localDay(open.at), in: open, out: p, minutes: Math.max(0, Math.round((Date.parse(p.at) - Date.parse(open.at)) / 60_000)) });
        open = null;
      } else {
        if (open) out.push({ day: localDay(open.at), in: open, out: null, minutes: 0 });
        open = null;
        out.push({ day: localDay(p.at), in: null, out: p, minutes: 0 });
      }
    }
    if (open) out.push({ day: localDay(open.at), in: open, out: null, minutes: 0 });
    return out.filter((x) => x.day >= from && x.day <= to);
  }

  /**
   * Journées d'un collaborateur sur une période : présences pointées, et pour
   * les jours sans passage, la connexion au logiciel notée avant cette version.
   */
  days(staffId: string, from: string, to: string, holidays?: Map<string, string>): StaffDay[] {
    const s = this.staffInfo(staffId);
    const hol = holidays ?? this.personnel.holidays(s.store_id, from, to);
    const byDay = new Map<string, WorkSession[]>();
    for (const x of this.sessions(staffId, from, to)) byDay.set(x.day, [...(byDay.get(x.day) ?? []), x]);
    // Pointage par la connexion d'avant les passages : une ligne par jour.
    if (s.user_id) {
      const rows = this.db
        .prepare('SELECT day, arrived_at, left_at, corrected_by, correction_reason FROM attendance WHERE user_id = ? AND day >= ? AND day <= ?')
        .all(s.user_id, from, to) as { day: string; arrived_at: string | null; left_at: string | null; corrected_by: string | null; correction_reason: string | null }[];
      for (const r of rows) {
        if (byDay.has(r.day) || (!r.arrived_at && !r.left_at)) continue;
        const legacy = (at: string | null, kind: 'in' | 'out'): TimePunch | null =>
          at
            ? { id: '', store_id: s.store_id, staff_id: s.id, entrance_id: null, at, kind, method: r.corrected_by ? 'manual' : 'login', photo: null, station: null, user_id: s.user_id, reason: r.correction_reason, status: 'active', created_at: at, updated_at: at }
            : null;
        const minutes = r.arrived_at && r.left_at ? Math.max(0, Math.round((Date.parse(r.left_at) - Date.parse(r.arrived_at)) / 60_000)) : 0;
        byDay.set(r.day, [{ day: r.day, in: legacy(r.arrived_at, 'in'), out: legacy(r.left_at, 'out'), minutes }]);
      }
    }
    const today = this.today();
    return [...byDay.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([day, list]) => {
        const ins = list.map((x) => x.in?.at).filter(Boolean) as string[];
        const outs = list.map((x) => x.out?.at).filter(Boolean) as string[];
        const arrived = ins.length ? ins.reduce((a, b) => (a < b ? a : b)) : null;
        const left = outs.length ? outs.reduce((a, b) => (a > b ? a : b)) : null;
        const plan = this.personnel.plan(staffId, day, { holidays: hol });
        const shift = plan.shift;
        const late = shift && arrived ? Math.round((Date.parse(arrived) - shift.start.getTime()) / 60_000) : 0;
        const early = shift && left ? Math.round((shift.end.getTime() - Date.parse(left)) / 60_000) : 0;
        const manual = list.flatMap((x) => [x.in, x.out]).filter((p): p is TimePunch => Boolean(p && p.method === 'manual'));
        return {
          day,
          arrived_at: arrived,
          left_at: left,
          minutes: list.reduce((t, x) => t + x.minutes, 0),
          late_minutes: shift && late > shift.tolerance ? late : 0,
          early_minutes: early > 0 ? early : 0,
          sessions: list.length,
          open: day < today && list.some((x) => x.in && !x.out),
          methods: [...new Set(list.flatMap((x) => [x.in?.method, x.out?.method]).filter(Boolean) as PunchMethod[])],
          corrected: manual.length > 0,
          correction_reason: manual.find((p) => p.reason)?.reason ?? null,
          holiday: plan.holiday,
        };
      });
  }

  /** Passages d'un jour (photos comprises), pour le détail et la vérification. */
  dayPunches(staffId: string, day: string): (TimePunch & { entrance_name: string | null; user_name: string | null })[] {
    const ids = new Set(this.sessions(staffId, day, day).flatMap((x) => [x.in?.id, x.out?.id]).filter(Boolean) as string[]);
    const rows = this.db
      .prepare(
        `SELECT p.*, e.name AS entrance_name, u.name AS user_name FROM time_punches p LEFT JOIN entrances e ON e.id = p.entrance_id LEFT JOIN users u ON u.id = p.user_id
         WHERE p.staff_id = ? AND p.at >= ? AND p.at < ? ORDER BY p.at`,
      )
      .all(staffId, dayStartIso(addDays(day, -1)), dayStartIso(addDays(day, 2))) as (TimePunch & { entrance_name: string | null; user_name: string | null })[];
    // Passages actifs de la journée, et ceux annulés du même jour (traçabilité).
    return rows.filter((p) => ids.has(p.id) || (p.status === 'cancelled' && localDay(p.at) === day));
  }

  /**
   * Correction du gérant pour un jour : les passages de la journée sont
   * annulés (gardés pour la trace) et remplacés par l'arrivée et le départ
   * saisis, avec un motif. Un départ avant l'arrivée tombe le lendemain (garde de nuit).
   */
  correctDay(ctx: Context, staffId: string, day: string, input: { arrived: string | null; left: string | null; reason: string }): StaffDay | null {
    const s = this.staffInfo(staffId);
    if (s.store_id !== ctx.storeId) throw new AppError("Ce collaborateur est d'un autre magasin", 'FORBIDDEN');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new AppError('Date invalide', 'INVALID');
    if (day > this.today()) throw new AppError('On ne pointe pas un jour à venir', 'INVALID');
    const reason = input.reason?.trim();
    if (!reason) throw new AppError('Indiquez le motif de la correction', 'INVALID');
    const at = (hhmm: string | null, nextDay = false) => {
      if (!hhmm) return null;
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(hhmm)) throw new AppError('Heure attendue au format HH:MM', 'INVALID');
      const [y, m, d] = day.split('-').map(Number);
      return new Date(y!, m! - 1, d! + (nextDay ? 1 : 0), Number(hhmm.slice(0, 2)), Number(hhmm.slice(3, 5))).toISOString();
    };
    const arrived = at(input.arrived);
    let left = at(input.left);
    if (arrived && left && left <= arrived) left = at(input.left, true);
    if (left && Date.parse(left) > this.clock().getTime() + 60_000) throw new AppError('Le départ est dans le futur', 'INVALID');
    const now = this.now();
    this.tx(() => {
      for (const x of this.sessions(staffId, day, day)) {
        for (const p of [x.in, x.out]) {
          if (!p) continue;
          this.db.prepare("UPDATE time_punches SET status = 'cancelled', reason = ?, updated_at = ? WHERE id = ?").run(`Corrigé : ${reason}`, now, p.id);
          this.enqueue(ctx, 'time_punch', p.id, 'upsert', {});
        }
      }
      const base = { store_id: s.store_id, staff_id: staffId, entrance_id: null, method: 'manual' as const, photo: null, station: null, user_id: ctx.userId, reason };
      if (arrived) this.insert({ ...base, at: arrived, kind: 'in' });
      if (left) this.insert({ ...base, at: left, kind: 'out' });
      this.audit(ctx.userId, 'attendance.correct', 'staff', staffId, { day, arrived: input.arrived, left: input.left, reason });
    });
    return this.days(staffId, day, day)[0] ?? null;
  }

  /** Annule un passage (double badge, erreur), avec un motif. */
  cancel(ctx: Context, id: string, reason: string): void {
    const p = this.db.prepare('SELECT * FROM time_punches WHERE id = ?').get(id) as TimePunch | undefined;
    if (!p) throw new AppError('Passage introuvable', 'NOT_FOUND');
    if (p.store_id !== ctx.storeId) throw new AppError("Ce passage est d'un autre magasin", 'FORBIDDEN');
    if (!reason?.trim()) throw new AppError("Indiquez le motif de l'annulation", 'INVALID');
    if (p.status === 'cancelled') return;
    this.tx(() => {
      this.db.prepare("UPDATE time_punches SET status = 'cancelled', reason = ?, updated_at = ? WHERE id = ?").run(reason.trim(), this.now(), id);
      this.enqueue(ctx, 'time_punch', id, 'upsert', {});
      this.audit(ctx.userId, 'attendance.cancel_punch', 'staff', p.staff_id, { at: p.at, kind: p.kind, reason: reason.trim() });
    });
  }

  // --- Qui est là ---------------------------------------------------------------------------

  /** Le personnel du magasin aujourd'hui : présent, parti, attendu, en retard, absent, en congé ou de repos. */
  presence(storeId: string): PresenceRow[] {
    const today = this.today();
    const now = this.clock().getTime();
    const holidays = this.personnel.holidays(storeId, addDays(today, -1), today);
    const staff = this.db
      .prepare(
        `SELECT s.id, s.name, s.position, s.category, s.user_id, s.photo IS NOT NULL AS has_photo, ag.name AS agency_name
         FROM staff s LEFT JOIN staff_agencies ag ON ag.id = s.agency_id WHERE s.store_id = ? AND s.active = 1 ORDER BY s.name`,
      )
      .all(storeId) as { id: string; name: string; position: string | null; category: string; user_id: string | null; has_photo: number; agency_name: string | null }[];
    const entranceName = this.db.prepare('SELECT name FROM entrances WHERE id = ?').pluck();
    const legacy = this.db.prepare('SELECT arrived_at, left_at FROM attendance WHERE user_id = ? AND day = ?');
    return staff.map((s) => {
      const last = this.last(s.id);
      const plan = this.personnel.plan(s.id, today, { holidays });
      // Garde de nuit commencée la veille et pas encore finie.
      const yesterday = this.personnel.plan(s.id, addDays(today, -1), { holidays }).shift;
      const shift = plan.shift ?? (yesterday && yesterday.end.getTime() > now ? yesterday : null);
      const onLeave = this.time.leaveDays(s.id, today, today).size > 0;
      const row: PresenceRow = {
        staff_id: s.id,
        name: s.name,
        position: s.position,
        category: s.category,
        agency_name: s.agency_name,
        team: shift?.team ?? null,
        state: 'off',
        since: null,
        left_at: null,
        entrance: null,
        method: null,
        expected_start: shift ? hm(shift.start) : null,
        expected_end: shift ? hm(shift.end) : null,
        late_minutes: 0,
        has_photo: Boolean(s.has_photo),
      };
      const inNow = last && last.kind === 'in' && now - Date.parse(last.at) < MAX_SESSION_MS;
      if (inNow) {
        const late = shift ? Math.round((Date.parse(last.at) - shift.start.getTime()) / 60_000) : 0;
        return { ...row, state: 'present', since: last.at, entrance: last.entrance_id ? ((entranceName.get(last.entrance_id) as string | undefined) ?? null) : null, method: last.method, late_minutes: shift && late > shift.tolerance ? late : 0 };
      }
      // Parti aujourd'hui, sauf s'il a encore une présence prévue plus tard (garde de nuit après une garde finie le matin).
      if (last && last.kind === 'out' && localDay(last.at) === today && !(shift && Date.parse(last.at) < shift.start.getTime())) {
        return { ...row, state: 'left', left_at: last.at, method: last.method };
      }
      if (s.user_id && !last) {
        const l = legacy.get(s.user_id, today) as { arrived_at: string | null; left_at: string | null } | undefined;
        if (l?.arrived_at && !l.left_at) return { ...row, state: 'present', since: l.arrived_at, method: 'login' };
        if (l?.left_at) return { ...row, state: 'left', left_at: l.left_at, method: 'login' };
      }
      if (onLeave) return { ...row, state: 'leave' };
      if (!shift) return row;
      const delay = Math.round((now - shift.start.getTime()) / 60_000);
      if (now >= shift.end.getTime()) return { ...row, state: 'absent' };
      if (delay > shift.tolerance) return { ...row, state: 'late', late_minutes: delay };
      return { ...row, state: 'expected' };
    });
  }
}
