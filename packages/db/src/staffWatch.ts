import { WARNING_KINDS, type WarningKind } from '@superette/core';
import type { AdminService } from './admin';
import type { Db } from './database';
import type { PunchService } from './punches';
import { AppError, Base, type Clock, type Context, newId } from './util';

/** Retard ou absence signalé au responsable. */
export interface AttendanceAlert {
  id: string;
  store_id: string;
  staff_id: string;
  staff_name: string;
  staff_phone: string | null;
  position: string | null;
  category: string;
  agency_name: string | null;
  agency_phone: string | null;
  day: string;
  kind: 'late' | 'absent';
  minutes: number;
  text: string;
  handled_by: string | null;
  handler_name: string | null;
  handled_at: string | null;
  created_at: string;
}

export interface StaffWarning {
  id: string;
  store_id: string;
  staff_id: string;
  staff_name: string;
  day: string;
  kind: WarningKind;
  reason: string;
  user_id: string | null;
  user_name: string | null;
  status: 'active' | 'cancelled';
  created_at: string;
}

/** Collaborateur à qui un avertissement est proposé : trop de retards dans le mois. */
export interface WarningSuggestion {
  staff_id: string;
  name: string;
  late: number;
  late_minutes: number;
}

const pad = (n: number) => String(n).padStart(2, '0');
const duration = (m: number) => (m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${pad(m % 60)}`);
const localDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/**
 * Suivi du personnel : alertes de retard et d'absence d'après l'horaire
 * prévu (« Qui est là »), et avertissements donnés aux collaborateurs.
 * Une alerte porte une clé (personne, jour, sorte) : deux PC qui la lèvent
 * n'en font qu'une après la synchronisation.
 */
export class StaffWatchService extends Base {
  constructor(
    db: Db,
    clock: Clock,
    private readonly admin: AdminService,
    private readonly punches: PunchService,
  ) {
    super(db, clock);
  }

  /**
   * Regarde qui est en retard ou absent et lève les alertes nouvelles.
   * Appelé chaque minute par le PC ouvert ; renvoie seulement les nouvelles.
   */
  scan(storeId: string): AttendanceAlert[] {
    const set = this.admin.storeSettings(storeId);
    if (!set.staffAlerts) return [];
    const day = this.today();
    const fresh: string[] = [];
    const exists = this.db.prepare('SELECT 1 FROM staff_alerts WHERE id = ?');
    for (const r of this.punches.presence(storeId)) {
      let kind: 'late' | 'absent' | null = null;
      if (r.state === 'absent') kind = 'absent';
      else if (r.state === 'late' && set.alertLateMinutes > 0 && r.late_minutes >= set.alertLateMinutes) kind = 'late';
      if (!kind) continue;
      // Une absence remplace le retard du même jour : une seule alerte par sorte.
      const id = `${kind}:${r.staff_id}:${day}`;
      if (exists.get(id)) continue;
      const who = `${r.name}${r.position ? ` (${r.position}${r.agency_name ? `, ${r.agency_name}` : ''})` : r.agency_name ? ` (${r.agency_name})` : ''}`;
      const text =
        kind === 'absent'
          ? `Absence : ${who}, attendu de ${r.expected_start} à ${r.expected_end}, aucun passage.`
          : `Retard : ${who}, attendu à ${r.expected_start}, toujours pas là après ${duration(r.late_minutes)}.`;
      const now = this.now();
      this.tx(() => {
        this.db
          .prepare('INSERT INTO staff_alerts (id, store_id, staff_id, day, kind, minutes, text, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(id, storeId, r.staff_id, day, kind, r.late_minutes, text, now, now);
        this.enqueue({ storeId, registerId: null }, 'staff_alert', id, 'upsert', {});
      });
      fresh.push(id);
    }
    return fresh.length ? this.alerts(storeId, { ids: fresh }) : [];
  }

  /** Alertes des derniers jours (aujourd'hui et la veille par défaut), les plus récentes d'abord. */
  alerts(storeId: string, opts: { days?: number; ids?: string[] } = {}): AttendanceAlert[] {
    const since = new Date(this.clock());
    since.setDate(since.getDate() - Math.max(0, (opts.days ?? 2) - 1));
    const rows = this.db
      .prepare(
        `SELECT a.*, s.name AS staff_name, s.phone AS staff_phone, s.position, s.category, ag.name AS agency_name, ag.phone AS agency_phone, u.name AS handler_name
         FROM staff_alerts a JOIN staff s ON s.id = a.staff_id LEFT JOIN staff_agencies ag ON ag.id = s.agency_id LEFT JOIN users u ON u.id = a.handled_by
         WHERE a.store_id = ? AND a.day >= ? ORDER BY a.created_at DESC`,
      )
      .all(storeId, localDay(since)) as AttendanceAlert[];
    return opts.ids ? rows.filter((r) => opts.ids!.includes(r.id)) : rows;
  }

  /** Le responsable a traité l'alerte (appelé la personne, prévenu la société…). */
  handle(ctx: Context, id: string): void {
    const a = this.db.prepare('SELECT store_id, handled_at FROM staff_alerts WHERE id = ?').get(id) as { store_id: string; handled_at: string | null } | undefined;
    if (!a) throw new AppError('Alerte introuvable', 'NOT_FOUND');
    if (a.store_id !== ctx.storeId) throw new AppError("Cette alerte est d'un autre magasin", 'FORBIDDEN');
    if (a.handled_at) return;
    const now = this.now();
    this.tx(() => {
      this.db.prepare('UPDATE staff_alerts SET handled_by = ?, handled_at = ?, updated_at = ? WHERE id = ?').run(ctx.userId, now, now, id);
      this.enqueue(ctx, 'staff_alert', id, 'upsert', {});
    });
  }

  // --- Avertissements -------------------------------------------------------------------------

  warnings(storeId: string, opts: { staffId?: string | null; includeCancelled?: boolean } = {}): StaffWarning[] {
    return this.db
      .prepare(
        `SELECT w.*, s.name AS staff_name, u.name AS user_name FROM staff_warnings w JOIN staff s ON s.id = w.staff_id LEFT JOIN users u ON u.id = w.user_id
         WHERE w.store_id = @store AND (@staff IS NULL OR w.staff_id = @staff) AND (@all = 1 OR w.status = 'active') ORDER BY w.day DESC, w.created_at DESC`,
      )
      .all({ store: storeId, staff: opts.staffId ?? null, all: opts.includeCancelled ? 1 : 0 }) as StaffWarning[];
  }

  addWarning(ctx: Context, staffId: string, input: { day: string; kind: WarningKind; reason: string }): StaffWarning {
    const s = this.db.prepare('SELECT store_id FROM staff WHERE id = ?').get(staffId) as { store_id: string } | undefined;
    if (!s) throw new AppError('Collaborateur introuvable', 'NOT_FOUND');
    if (s.store_id !== ctx.storeId) throw new AppError("Ce collaborateur est d'un autre magasin", 'FORBIDDEN');
    if (!(input.kind in WARNING_KINDS)) throw new AppError("Sorte d'avertissement inconnue", 'INVALID');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.day) || input.day > this.today()) throw new AppError('Date invalide', 'INVALID');
    const reason = input.reason?.trim();
    if (!reason) throw new AppError("Indiquez le motif de l'avertissement", 'INVALID');
    const id = newId();
    const now = this.now();
    this.tx(() => {
      this.db
        .prepare("INSERT INTO staff_warnings (id, store_id, staff_id, day, kind, reason, user_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)")
        .run(id, ctx.storeId, staffId, input.day, input.kind, reason.slice(0, 1000), ctx.userId, now, now);
      this.enqueue(ctx, 'staff_warning', id, 'upsert', {});
      this.audit(ctx.userId, 'staff.warning', 'staff', staffId, { day: input.day, kind: input.kind, reason });
    });
    return this.warning(id);
  }

  warning(id: string): StaffWarning {
    const w = this.db
      .prepare('SELECT w.*, s.name AS staff_name, u.name AS user_name FROM staff_warnings w JOIN staff s ON s.id = w.staff_id LEFT JOIN users u ON u.id = w.user_id WHERE w.id = ?')
      .get(id) as StaffWarning | undefined;
    if (!w) throw new AppError('Avertissement introuvable', 'NOT_FOUND');
    return w;
  }

  /** Retire un avertissement donné par erreur (gardé, marqué annulé). */
  cancelWarning(ctx: Context, id: string): void {
    const w = this.warning(id);
    if (w.store_id !== ctx.storeId) throw new AppError("Cet avertissement est d'un autre magasin", 'FORBIDDEN');
    if (w.status === 'cancelled') return;
    this.tx(() => {
      this.db.prepare("UPDATE staff_warnings SET status = 'cancelled', updated_at = ? WHERE id = ?").run(this.now(), id);
      this.enqueue(ctx, 'staff_warning', id, 'upsert', {});
      this.audit(ctx.userId, 'staff.warning_cancel', 'staff', w.staff_id, { day: w.day, kind: w.kind });
    });
  }

  /**
   * Avertissements à envisager ce mois : les collaborateurs qui ont au moins
   * le nombre de retards réglé dans les paramètres, et pas encore
   * d'avertissement ce mois-ci.
   */
  suggestions(storeId: string, rows: { staff_id: string | null; name: string; late: number; late_minutes: number }[], period: string): WarningSuggestion[] {
    const n = this.admin.storeSettings(storeId).warnLateCount;
    if (!n) return [];
    const warned = new Set(
      this.db.prepare("SELECT staff_id FROM staff_warnings WHERE store_id = ? AND status = 'active' AND day LIKE ? || '-%'").pluck().all(storeId, period) as string[],
    );
    return rows
      .filter((r): r is typeof r & { staff_id: string } => Boolean(r.staff_id) && r.late >= n && !warned.has(r.staff_id!))
      .map((r) => ({ staff_id: r.staff_id, name: r.name, late: r.late, late_minutes: r.late_minutes }));
  }
}
