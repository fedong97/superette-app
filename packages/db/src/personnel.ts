import { randomInt } from 'node:crypto';
import { holidaysBetween, isHhmm, parseRotation, rotationTeam, type Rotation, shiftBounds, shiftLength, type ShiftHours } from '@superette/core';
import type { AdminService } from './admin';
import type { Db } from './database';
import type { StaffTimeService } from './staffTime';
import { AppError, Base, type Clock, type Context, hashPin, newId } from './util';

/** Société prestataire : gardiennage, nettoyage… Ses agents pointent, elle les paie. */
export interface StaffAgency {
  id: string;
  store_id: string;
  name: string;
  kind: string | null;
  contact: string | null;
  phone: string | null;
  address: string | null;
  contract_end: string | null;
  notes: string | null;
  active: number;
  /** Agents actifs de la société dans ce magasin. */
  agents: number;
  created_at: string;
}

export interface AgencyInput {
  name: string;
  kind?: string | null;
  contact?: string | null;
  phone?: string | null;
  address?: string | null;
  contractEnd?: string | null;
  notes?: string | null;
  active?: boolean;
}

export interface Entrance {
  id: string;
  store_id: string;
  name: string;
  active: number;
  created_at: string;
}

/** Équipe : horaire commun, jours travaillés (0 = dimanche) et tolérance de retard propre (null : celle du magasin). */
export interface StaffTeam {
  id: string;
  store_id: string;
  name: string;
  start_time: string;
  end_time: string;
  days: string;
  tolerance: number | null;
  color: string | null;
  active: number;
  /** Membres actifs (équipe fixe). */
  members: number;
  /** Garde de nuit : finit le lendemain. */
  overnight: boolean;
  /** Durée prévue, en minutes. */
  minutes: number;
}

export interface TeamInput {
  name: string;
  start: string;
  end: string;
  days: string;
  tolerance?: number | null;
  color?: string | null;
  active?: boolean;
}

export interface StaffDocument {
  id: string;
  staff_id: string;
  label: string;
  file_name: string | null;
  expires_on: string | null;
  user_name: string | null;
  created_at: string;
}

/** Horaire attendu un jour donné : début et fin (la fin peut tomber le lendemain), tolérance et équipe. */
export interface ExpectedShift {
  day: string;
  start: Date;
  end: Date;
  minutes: number;
  tolerance: number;
  team: string | null;
}

/** Ce qu'il faut savoir d'un jour pour un collaborateur : horaire prévu, ou repos, jour férié, congé. */
export interface DayPlan {
  shift: ExpectedShift | null;
  holiday: string | null;
}

/** Contrat ou pièce qui arrive à échéance. */
export interface StaffAlert {
  staff_id: string;
  name: string;
  kind: 'contract' | 'document' | 'agency';
  label: string;
  date: string;
  days: number;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const pad = (n: number) => String(n).padStart(2, '0');
const localDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const COLOR = /^#[0-9a-f]{6}$/i;

/**
 * Le personnel au-delà de la fiche et de la paie : sociétés prestataires,
 * entrées du magasin, équipes et rotations, badge et code de pointage de
 * chacun (même sans compte dans le logiciel), photo et pièces du dossier.
 */
export class PersonnelService extends Base {
  constructor(
    db: Db,
    clock: Clock,
    private readonly admin: AdminService,
    private readonly time: StaffTimeService,
  ) {
    super(db, clock);
  }

  private staffRow(id: string) {
    const s = this.db.prepare('SELECT * FROM staff WHERE id = ?').get(id) as
      | { id: string; store_id: string; name: string; user_id: string | null; team_id: string | null; rotation: string | null; active: number; badge: string | null; photo: string | null }
      | undefined;
    if (!s) throw new AppError('Collaborateur introuvable', 'NOT_FOUND');
    return s;
  }

  private ownStaff(ctx: Context, id: string) {
    const s = this.staffRow(id);
    if (s.store_id !== ctx.storeId) throw new AppError("Ce collaborateur est d'un autre magasin", 'FORBIDDEN');
    return s;
  }

  private touchStaff(ctx: Context, id: string) {
    this.db.prepare('UPDATE staff SET updated_at = ? WHERE id = ?').run(this.now(), id);
    this.enqueue(ctx, 'staff', id, 'upsert', {});
  }

  // --- Sociétés prestataires ------------------------------------------------------------

  agencies(storeId: string, includeInactive = false): StaffAgency[] {
    return this.db
      .prepare(
        `SELECT a.*, (SELECT COUNT(*) FROM staff s WHERE s.agency_id = a.id AND s.active = 1 AND s.category = 'contractor') AS agents
         FROM staff_agencies a WHERE a.store_id = ? AND (? = 1 OR a.active = 1) ORDER BY a.active DESC, a.name`,
      )
      .all(storeId, includeInactive ? 1 : 0) as StaffAgency[];
  }

  saveAgency(ctx: Context, input: AgencyInput, id?: string | null): StaffAgency {
    const name = input.name?.trim();
    if (!name) throw new AppError('Le nom de la société est obligatoire', 'INVALID');
    if (input.contractEnd && !DAY.test(input.contractEnd)) throw new AppError('Date de fin du contrat invalide', 'INVALID');
    const now = this.now();
    const values = {
      name,
      kind: input.kind?.trim() || null,
      contact: input.contact?.trim() || null,
      phone: input.phone?.trim() || null,
      address: input.address?.trim() || null,
      contract_end: input.contractEnd || null,
      notes: input.notes?.trim() || null,
      active: input.active === false ? 0 : 1,
      now,
    };
    const dup = this.db.prepare('SELECT id FROM staff_agencies WHERE store_id = ? AND lower(name) = lower(?) AND id <> ?').pluck().get(ctx.storeId, name, id ?? '');
    if (dup) throw new AppError(`La société « ${name} » existe déjà`, 'INVALID');
    return this.tx(() => {
      let agencyId = id ?? null;
      if (agencyId) {
        const cur = this.db.prepare('SELECT store_id FROM staff_agencies WHERE id = ?').get(agencyId) as { store_id: string } | undefined;
        if (!cur) throw new AppError('Société introuvable', 'NOT_FOUND');
        if (cur.store_id !== ctx.storeId) throw new AppError("Cette société est rattachée à un autre magasin", 'FORBIDDEN');
        if (values.active === 0) {
          const agents = this.db.prepare("SELECT COUNT(*) FROM staff WHERE agency_id = ? AND active = 1 AND category = 'contractor'").pluck().get(agencyId) as number;
          if (agents) throw new AppError(`${agents} agent(s) de cette société sont encore actifs : marquez-les partis d'abord`, 'INVALID');
        }
        this.db
          .prepare(
            `UPDATE staff_agencies SET name = @name, kind = @kind, contact = @contact, phone = @phone, address = @address, contract_end = @contract_end,
               notes = @notes, active = @active, updated_at = @now WHERE id = @id`,
          )
          .run({ ...values, id: agencyId });
      } else {
        agencyId = newId();
        this.db
          .prepare(
            `INSERT INTO staff_agencies (id, store_id, name, kind, contact, phone, address, contract_end, notes, active, created_at, updated_at)
             VALUES (@id, @store, @name, @kind, @contact, @phone, @address, @contract_end, @notes, @active, @now, @now)`,
          )
          .run({ ...values, id: agencyId, store: ctx.storeId });
      }
      this.enqueue(ctx, 'staff_agency', agencyId, 'upsert', {});
      this.audit(ctx.userId, id ? 'staff_agency.update' : 'staff_agency.create', 'staff_agency', agencyId, { name });
      return this.agencies(ctx.storeId, true).find((a) => a.id === agencyId)!;
    });
  }

  // --- Entrées ------------------------------------------------------------------------------

  entrances(storeId: string, includeInactive = false): Entrance[] {
    return this.db.prepare('SELECT id, store_id, name, active, created_at FROM entrances WHERE store_id = ? AND (? = 1 OR active = 1) ORDER BY active DESC, created_at').all(storeId, includeInactive ? 1 : 0) as Entrance[];
  }

  getEntrance(id: string): Entrance {
    const e = this.db.prepare('SELECT id, store_id, name, active, created_at FROM entrances WHERE id = ?').get(id) as Entrance | undefined;
    if (!e) throw new AppError('Entrée introuvable', 'NOT_FOUND');
    return e;
  }

  /** Entrée unique du magasin (créée au besoin) quand il n'en gère pas plusieurs. */
  mainEntrance(ctx: Pick<Context, 'storeId' | 'registerId'>): Entrance {
    const first = this.entrances(ctx.storeId)[0];
    if (first) return first;
    return this.saveEntrance({ ...ctx, userId: null as unknown as string }, { name: 'Entrée principale' });
  }

  saveEntrance(ctx: Context, input: { name: string; active?: boolean }, id?: string | null): Entrance {
    const name = input.name?.trim();
    if (!name) throw new AppError("Le nom de l'entrée est obligatoire", 'INVALID');
    const dup = this.db.prepare('SELECT id FROM entrances WHERE store_id = ? AND lower(name) = lower(?) AND id <> ?').pluck().get(ctx.storeId, name, id ?? '');
    if (dup) throw new AppError(`L'entrée « ${name} » existe déjà`, 'INVALID');
    const now = this.now();
    return this.tx(() => {
      let entranceId = id ?? null;
      if (entranceId) {
        const cur = this.getEntrance(entranceId);
        if (cur.store_id !== ctx.storeId) throw new AppError("Cette entrée est d'un autre magasin", 'FORBIDDEN');
        if (input.active === false && this.entrances(ctx.storeId).filter((e) => e.id !== entranceId).length === 0) {
          throw new AppError('Le magasin garde au moins une entrée', 'INVALID');
        }
        this.db.prepare('UPDATE entrances SET name = ?, active = ?, updated_at = ? WHERE id = ?').run(name, input.active === false ? 0 : 1, now, entranceId);
      } else {
        entranceId = newId();
        this.db.prepare('INSERT INTO entrances (id, store_id, name, active, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)').run(entranceId, ctx.storeId, name, now, now);
      }
      this.enqueue(ctx, 'entrance', entranceId, 'upsert', {});
      if (ctx.userId) this.audit(ctx.userId, id ? 'entrance.update' : 'entrance.create', 'entrance', entranceId, { name });
      return this.getEntrance(entranceId);
    });
  }

  // --- Équipes et rotations -----------------------------------------------------------------

  teams(storeId: string, includeInactive = false): StaffTeam[] {
    const rows = this.db
      .prepare(
        `SELECT t.id, t.store_id, t.name, t.start_time, t.end_time, t.days, t.tolerance, t.color, t.active,
                (SELECT COUNT(*) FROM staff s WHERE s.team_id = t.id AND s.active = 1) AS members
         FROM staff_teams t WHERE t.store_id = ? AND (? = 1 OR t.active = 1) ORDER BY t.active DESC, t.start_time, t.name`,
      )
      .all(storeId, includeInactive ? 1 : 0) as Omit<StaffTeam, 'overnight' | 'minutes'>[];
    return rows.map((t) => ({ ...t, overnight: t.end_time <= t.start_time, minutes: shiftLength({ start: t.start_time, end: t.end_time }) }));
  }

  private team(id: string): StaffTeam | null {
    const t = this.db.prepare('SELECT id, store_id, name, start_time, end_time, days, tolerance, color, active, 0 AS members FROM staff_teams WHERE id = ?').get(id) as
      | Omit<StaffTeam, 'overnight' | 'minutes'>
      | undefined;
    return t ? { ...t, overnight: t.end_time <= t.start_time, minutes: shiftLength({ start: t.start_time, end: t.end_time }) } : null;
  }

  saveTeam(ctx: Context, input: TeamInput, id?: string | null): StaffTeam {
    const name = input.name?.trim();
    if (!name) throw new AppError("Le nom de l'équipe est obligatoire", 'INVALID');
    if (!isHhmm(input.start) || !isHhmm(input.end)) throw new AppError('Heures au format HH:MM, par exemple 06:00', 'INVALID');
    if (input.start === input.end) throw new AppError('Le début et la fin de l’équipe sont identiques', 'INVALID');
    const days = [...new Set(String(input.days ?? '').replace(/[^0-6]/g, ''))].sort().join('');
    if (!days) throw new AppError('Choisissez au moins un jour travaillé', 'INVALID');
    const tolerance = input.tolerance === null || input.tolerance === undefined ? null : Math.round(Number(input.tolerance));
    if (tolerance !== null && (!Number.isFinite(tolerance) || tolerance < 0 || tolerance > 240)) throw new AppError('Tolérance entre 0 et 240 minutes', 'INVALID');
    const color = input.color && COLOR.test(input.color) ? input.color.toLowerCase() : null;
    const dup = this.db.prepare('SELECT id FROM staff_teams WHERE store_id = ? AND lower(name) = lower(?) AND id <> ?').pluck().get(ctx.storeId, name, id ?? '');
    if (dup) throw new AppError(`L'équipe « ${name} » existe déjà`, 'INVALID');
    const now = this.now();
    return this.tx(() => {
      let teamId = id ?? null;
      if (teamId) {
        const cur = this.team(teamId);
        if (!cur) throw new AppError('Équipe introuvable', 'NOT_FOUND');
        if (cur.store_id !== ctx.storeId) throw new AppError("Cette équipe est d'un autre magasin", 'FORBIDDEN');
        this.db
          .prepare('UPDATE staff_teams SET name = ?, start_time = ?, end_time = ?, days = ?, tolerance = ?, color = ?, active = ?, updated_at = ? WHERE id = ?')
          .run(name, input.start, input.end, days, tolerance, color, input.active === false ? 0 : 1, now, teamId);
      } else {
        teamId = newId();
        this.db
          .prepare('INSERT INTO staff_teams (id, store_id, name, start_time, end_time, days, tolerance, color, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)')
          .run(teamId, ctx.storeId, name, input.start, input.end, days, tolerance, color, now, now);
      }
      this.enqueue(ctx, 'staff_team', teamId, 'upsert', {});
      this.audit(ctx.userId, id ? 'staff_team.update' : 'staff_team.create', 'staff_team', teamId, { name, start: input.start, end: input.end, days });
      return this.teams(ctx.storeId, true).find((t) => t.id === teamId)!;
    });
  }

  /** Équipe fixe d'un collaborateur, ou rotation entre plusieurs équipes ; null pour revenir à sa semaine type. */
  setTeam(ctx: Context, staffId: string, input: { teamId?: string | null; rotation?: Rotation | null }): void {
    this.ownStaff(ctx, staffId);
    const check = (id: string) => {
      const t = this.team(id);
      if (!t || t.store_id !== ctx.storeId) throw new AppError('Équipe introuvable', 'NOT_FOUND');
    };
    if (input.teamId) check(input.teamId);
    let rotation: string | null = null;
    if (input.rotation && input.rotation.teams.length) {
      if (input.rotation.teams.length < 2) throw new AppError('Une rotation se fait entre au moins deux équipes', 'INVALID');
      input.rotation.teams.forEach(check);
      if (!DAY.test(input.rotation.start)) throw new AppError('Date de début de la rotation invalide', 'INVALID');
      const weeks = Math.round(Number(input.rotation.weeks));
      if (!(weeks >= 1 && weeks <= 8)) throw new AppError('Chaque équipe dure de 1 à 8 semaines dans la rotation', 'INVALID');
      rotation = JSON.stringify({ teams: input.rotation.teams, start: input.rotation.start, weeks });
    }
    this.tx(() => {
      this.db.prepare('UPDATE staff SET team_id = ?, rotation = ? WHERE id = ?').run(input.teamId || (rotation ? input.rotation!.teams[0] : null), rotation, staffId);
      this.touchStaff(ctx, staffId);
      this.audit(ctx.userId, 'staff.team', 'staff', staffId, { teamId: input.teamId ?? null, rotation: input.rotation ?? null });
    });
  }

  /** Jours fériés d'une période, d'après les paramètres du magasin. */
  holidays(storeId: string, from: string, to: string): Map<string, string> {
    const set = this.admin.storeSettings(storeId);
    return holidaysBetween(from, to, { cameroon: set.holidaysCameroon, extra: set.holidaysExtra });
  }

  /**
   * Horaire prévu d'un collaborateur un jour donné : son équipe (ou celle de sa
   * rotation) si les équipes sont activées, sinon sa semaine type. Rien un jour
   * de repos ou un jour férié.
   */
  plan(staffId: string, day: string, cache?: { holidays?: Map<string, string> }): DayPlan {
    const s = this.staffRow(staffId);
    const set = this.admin.storeSettings(s.store_id);
    const holidays = cache?.holidays ?? this.holidays(s.store_id, day, day);
    const holiday = holidays.get(day) ?? null;
    if (holiday) return { shift: null, holiday };
    const weekday = String(new Date(`${day}T12:00:00`).getDay());
    if (set.staffTeams) {
      const rot = parseRotation(s.rotation);
      const teamId = (rot && rotationTeam(rot, day)) || s.team_id;
      const team = teamId ? this.team(teamId) : null;
      if (team && team.active) {
        if (!team.days.includes(weekday)) return { shift: null, holiday: null };
        return { shift: this.expected(day, { start: team.start_time, end: team.end_time }, team.tolerance ?? set.lateToleranceMinutes, team.name), holiday: null };
      }
    }
    const sh = this.time.schedule(staffId).schedule[weekday as '0'];
    return { shift: sh ? this.expected(day, sh, set.lateToleranceMinutes, null) : null, holiday: null };
  }

  private expected(day: string, hours: ShiftHours, tolerance: number, team: string | null): ExpectedShift {
    const { start, end } = shiftBounds(day, hours);
    return { day, start, end, minutes: shiftLength(hours), tolerance, team };
  }

  // --- Badge, code de pointage, photo -------------------------------------------------------

  /** Donne un badge de pointage au collaborateur (ou le refait : l'ancien ne marche plus). */
  newBadge(ctx: Context, staffId: string): string {
    this.ownStaff(ctx, staffId);
    let badge = '';
    do badge = `FP${String(randomInt(0, 100_000_000)).padStart(8, '0')}`;
    while (this.db.prepare('SELECT 1 FROM staff WHERE badge = ?').get(badge));
    this.tx(() => {
      this.db.prepare('UPDATE staff SET badge = ? WHERE id = ?').run(badge, staffId);
      this.touchStaff(ctx, staffId);
      this.audit(ctx.userId, 'staff.badge', 'staff', staffId);
    });
    return badge;
  }

  /** Code personnel tapé à la borne après le numéro de pointage (4 à 8 chiffres) ; null le retire. */
  setPunchPin(ctx: Context, staffId: string, pin: string | null): void {
    this.ownStaff(ctx, staffId);
    if (pin !== null && !/^\d{4,8}$/.test(pin)) throw new AppError('Le code de pointage fait de 4 à 8 chiffres', 'INVALID');
    this.tx(() => {
      this.db.prepare('UPDATE staff SET punch_pin_hash = ? WHERE id = ?').run(pin === null ? null : hashPin(pin), staffId);
      this.touchStaff(ctx, staffId);
      this.audit(ctx.userId, pin === null ? 'staff.punch_pin_remove' : 'staff.punch_pin', 'staff', staffId);
    });
  }

  /** Nouveau numéro de pointage (en cas de doublon entre deux PC). */
  newPunchNumber(ctx: Context, staffId: string): number {
    this.ownStaff(ctx, staffId);
    const max = this.db.prepare('SELECT MAX(punch_number) FROM staff WHERE store_id = ?').pluck().get(ctx.storeId) as number | null;
    const n = (max ?? 0) + 1;
    this.tx(() => {
      this.db.prepare('UPDATE staff SET punch_number = ? WHERE id = ?').run(n, staffId);
      this.touchStaff(ctx, staffId);
    });
    return n;
  }

  /** Photo du collaborateur (badge, borne) ; à défaut celle de son compte utilisateur. */
  photo(staffId: string): string | null {
    const s = this.staffRow(staffId);
    return s.photo ?? (s.user_id ? this.admin.userPhoto(s.user_id) : null);
  }

  setPhoto(ctx: Context, staffId: string, photo: string | null): void {
    this.ownStaff(ctx, staffId);
    if (photo !== null) {
      if (typeof photo !== 'string' || !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(photo)) throw new AppError('Image invalide : choisissez une photo JPEG ou PNG', 'INVALID');
      if (photo.length > 200_000) throw new AppError('Photo trop lourde, même réduite : choisissez une autre image', 'INVALID');
    }
    this.tx(() => {
      this.db.prepare('UPDATE staff SET photo = ? WHERE id = ?').run(photo, staffId);
      this.touchStaff(ctx, staffId);
      this.audit(ctx.userId, photo ? 'staff.photo' : 'staff.photo_remove', 'staff', staffId);
    });
  }

  // --- Pièces du dossier ----------------------------------------------------------------------

  documents(staffId: string): StaffDocument[] {
    return this.db
      .prepare(
        `SELECT d.id, d.staff_id, d.label, d.file_name, d.expires_on, u.name AS user_name, d.created_at
         FROM staff_documents d LEFT JOIN users u ON u.id = d.user_id WHERE d.staff_id = ? AND d.status = 'active' ORDER BY d.created_at DESC`,
      )
      .all(staffId) as StaffDocument[];
  }

  document(id: string): { label: string; file_name: string | null; data: string } {
    const d = this.db.prepare("SELECT label, file_name, data FROM staff_documents WHERE id = ? AND status = 'active'").get(id) as { label: string; file_name: string | null; data: string } | undefined;
    if (!d) throw new AppError('Pièce introuvable', 'NOT_FOUND');
    return d;
  }

  addDocument(ctx: Context, staffId: string, input: { label: string; fileName?: string | null; data: string; expiresOn?: string | null }): StaffDocument {
    this.ownStaff(ctx, staffId);
    const label = input.label?.trim();
    if (!label) throw new AppError('Indiquez ce qu’est la pièce (CNI, contrat signé…)', 'INVALID');
    if (!/^data:(image\/(jpeg|png|webp)|application\/pdf);base64,[A-Za-z0-9+/=]+$/.test(input.data ?? '')) throw new AppError('Pièce : une photo (JPEG, PNG) ou un PDF', 'INVALID');
    if (input.data.length > 1_500_000) throw new AppError('Pièce trop lourde (1 Mo au plus) : réduisez-la ou scannez-la en basse définition', 'INVALID');
    if (input.expiresOn && !DAY.test(input.expiresOn)) throw new AppError('Date de fin de validité invalide', 'INVALID');
    const id = newId();
    const now = this.now();
    this.tx(() => {
      this.db
        .prepare('INSERT INTO staff_documents (id, store_id, staff_id, label, file_name, data, expires_on, user_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, ctx.storeId, staffId, label, input.fileName?.trim() || null, input.data, input.expiresOn || null, ctx.userId, 'active', now, now);
      this.enqueue(ctx, 'staff_document', id, 'upsert', {});
      this.audit(ctx.userId, 'staff.document', 'staff', staffId, { label });
    });
    return this.documents(staffId).find((d) => d.id === id)!;
  }

  removeDocument(ctx: Context, id: string): void {
    const d = this.db.prepare('SELECT staff_id, store_id, label FROM staff_documents WHERE id = ?').get(id) as { staff_id: string; store_id: string; label: string } | undefined;
    if (!d) throw new AppError('Pièce introuvable', 'NOT_FOUND');
    if (d.store_id !== ctx.storeId) throw new AppError("Cette pièce est d'un autre magasin", 'FORBIDDEN');
    this.tx(() => {
      this.db.prepare("UPDATE staff_documents SET status = 'cancelled', data = '', updated_at = ? WHERE id = ?").run(this.now(), id);
      this.enqueue(ctx, 'staff_document', id, 'upsert', {});
      this.audit(ctx.userId, 'staff.document_remove', 'staff', d.staff_id, { label: d.label });
    });
  }

  // --- Échéances -----------------------------------------------------------------------------

  /** Contrats, pièces et contrats de prestataires qui finissent bientôt (ou sont déjà finis), selon le délai des paramètres. */
  alerts(storeId: string): StaffAlert[] {
    const days = this.admin.storeSettings(storeId).contractAlertDays;
    if (!days) return [];
    const today = this.today();
    const limit = new Date(`${today}T12:00:00`);
    limit.setDate(limit.getDate() + days);
    const until = localDay(limit);
    const left = (d: string) => Math.round((Date.parse(`${d}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / 86_400_000);
    const contracts = this.db
      .prepare('SELECT id, name, contract_end FROM staff WHERE store_id = ? AND active = 1 AND contract_end IS NOT NULL AND contract_end <= ?')
      .all(storeId, until) as { id: string; name: string; contract_end: string }[];
    const docs = this.db
      .prepare(
        `SELECT s.id, s.name, d.label, d.expires_on FROM staff_documents d JOIN staff s ON s.id = d.staff_id
         WHERE d.store_id = ? AND d.status = 'active' AND s.active = 1 AND d.expires_on IS NOT NULL AND d.expires_on <= ?`,
      )
      .all(storeId, until) as { id: string; name: string; label: string; expires_on: string }[];
    const agencies = this.db
      .prepare('SELECT id, name, contract_end FROM staff_agencies WHERE store_id = ? AND active = 1 AND contract_end IS NOT NULL AND contract_end <= ?')
      .all(storeId, until) as { id: string; name: string; contract_end: string }[];
    return [
      ...contracts.map((c) => ({ staff_id: c.id, name: c.name, kind: 'contract' as const, label: 'Fin du contrat', date: c.contract_end, days: left(c.contract_end) })),
      ...docs.map((d) => ({ staff_id: d.id, name: d.name, kind: 'document' as const, label: d.label, date: d.expires_on, days: left(d.expires_on) })),
      ...agencies.map((a) => ({ staff_id: a.id, name: a.name, kind: 'agency' as const, label: 'Fin du contrat de prestation', date: a.contract_end, days: left(a.contract_end) })),
    ].sort((a, b) => a.date.localeCompare(b.date));
  }
}
