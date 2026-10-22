import { parseAttlog } from '@superette/core';
import type { AdminService } from './admin';
import type { Db } from './database';
import type { PersonnelService } from './personnel';
import type { PunchService } from './punches';
import { AppError, Base, type Clock, type Context } from './util';

/** Pointeuse à empreinte connue du magasin. */
export interface FingerprintDevice {
  id: string;
  store_id: string;
  serial: string;
  name: string;
  entrance_id: string | null;
  entrance_name: string | null;
  last_seen_at: string | null;
  active: number;
  created_at: string;
  updated_at: string;
}

/** Bilan d'un envoi de la pointeuse ou d'un fichier de la clé USB. */
export interface FingerprintImport {
  /** Passages notés. */
  added: number;
  /** Déjà notés (même personne, même heure, ou double passage). */
  duplicates: number;
  /** Numéros de la pointeuse sans collaborateur de ce numéro de pointage. */
  unknown: number[];
  /** Collaborateurs marqués partis : passages ignorés. */
  inactive: number;
  /** Lignes illisibles du fichier. */
  unreadable: number;
}

/**
 * Pointeuses à empreinte ZKTeco. Les empreintes restent dans l'appareil :
 * chaque personne y est enregistrée sous son numéro de pointage (fiche du
 * collaborateur). Les passages arrivent par le réseau (la pointeuse les
 * envoie au PC du magasin, protocole ADMS) ou par le fichier « attlog » de
 * la clé USB.
 */
export class FingerprintService extends Base {
  constructor(
    db: Db,
    clock: Clock,
    private readonly admin: AdminService,
    private readonly personnel: PersonnelService,
    private readonly punches: PunchService,
  ) {
    super(db, clock);
  }

  devices(storeId: string): FingerprintDevice[] {
    return this.db
      .prepare(
        `SELECT d.*, e.name AS entrance_name FROM fingerprint_devices d LEFT JOIN entrances e ON e.id = d.entrance_id
         WHERE d.store_id = ? ORDER BY d.active DESC, d.name`,
      )
      .all(storeId) as FingerprintDevice[];
  }

  getDevice(id: string): FingerprintDevice {
    const d = this.db.prepare('SELECT d.*, e.name AS entrance_name FROM fingerprint_devices d LEFT JOIN entrances e ON e.id = d.entrance_id WHERE d.id = ?').get(id) as
      | FingerprintDevice
      | undefined;
    if (!d) throw new AppError('Pointeuse introuvable', 'NOT_FOUND');
    return d;
  }

  /** Nom et entrée d'une pointeuse ; une pointeuse retirée n'est plus écoutée. */
  saveDevice(ctx: Context, id: string, input: { name: string; entranceId?: string | null; active?: boolean }): FingerprintDevice {
    const d = this.getDevice(id);
    if (d.store_id !== ctx.storeId) throw new AppError("Cette pointeuse est d'un autre magasin", 'FORBIDDEN');
    const name = input.name.trim();
    if (!name) throw new AppError('Donnez un nom à la pointeuse', 'INVALID');
    if (input.entranceId && this.personnel.getEntrance(input.entranceId).store_id !== ctx.storeId) throw new AppError("Cette entrée est d'un autre magasin", 'FORBIDDEN');
    this.tx(() => {
      this.db
        .prepare('UPDATE fingerprint_devices SET name = ?, entrance_id = ?, active = ?, updated_at = ? WHERE id = ?')
        .run(name.slice(0, 60), input.entranceId ?? null, input.active === false ? 0 : 1, this.now(), id);
      this.enqueue(ctx, 'fingerprint_device', id, 'upsert', {});
    });
    return this.getDevice(id);
  }

  /** La pointeuse de ce numéro de série : connue, ou ajoutée à son premier envoi. */
  device(storeId: string, serial: string): FingerprintDevice {
    const sn = serial.trim().slice(0, 40);
    if (!/^[A-Za-z0-9._-]+$/.test(sn)) throw new AppError('Numéro de série de pointeuse illisible', 'INVALID');
    const found = this.db.prepare('SELECT id FROM fingerprint_devices WHERE store_id = ? AND serial = ?').pluck().get(storeId, sn) as string | undefined;
    if (found) {
      // L'heure du dernier contact reste sur ce PC : elle ne part pas à la synchronisation.
      this.db.prepare('UPDATE fingerprint_devices SET last_seen_at = ? WHERE id = ?').run(this.now(), found);
      return this.getDevice(found);
    }
    // Identifiant tiré du numéro de série : deux PC qui l'ajoutent n'en font qu'une à la synchronisation.
    const id = `zk:${storeId}:${sn}`;
    const now = this.now();
    this.tx(() => {
      const count = this.db.prepare('SELECT COUNT(*) FROM fingerprint_devices WHERE store_id = ?').pluck().get(storeId) as number;
      this.db
        .prepare('INSERT INTO fingerprint_devices (id, store_id, serial, name, entrance_id, last_seen_at, active, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, ?, 1, ?, ?)')
        .run(id, storeId, sn, `Pointeuse ${count + 1}`, now, now, now);
      this.enqueue({ storeId, registerId: null }, 'fingerprint_device', id, 'upsert', {});
    });
    return this.getDevice(id);
  }

  /**
   * Passages lus d'une pointeuse : chaque numéro est le numéro de pointage
   * d'un collaborateur. Ils sont notés dans l'ordre, à leur heure, arrivée ou
   * départ selon le passage précédent.
   */
  record(storeId: string, text: string, opts: { serial?: string | null; station?: string | null } = {}): FingerprintImport {
    if (!this.admin.storeSettings(storeId).fingerprint) throw new AppError('La pointeuse à empreinte n’est pas activée (Administration › Paramètres › Pointage)', 'FORBIDDEN');
    const device = opts.serial ? this.device(storeId, opts.serial) : null;
    if (device && !device.active) return { added: 0, duplicates: 0, unknown: [], inactive: 0, unreadable: 0 };
    const logs = parseAttlog(text).sort((a, b) => a.at.localeCompare(b.at));
    const lines = text.split(/\r?\n/).filter((l) => l.trim()).length;
    const out: FingerprintImport = { added: 0, duplicates: 0, unknown: [], inactive: 0, unreadable: Math.max(0, lines - logs.length) };
    const byNumber = this.db.prepare('SELECT id, active FROM staff WHERE store_id = ? AND punch_number = ? ORDER BY active DESC, created_at LIMIT 1');
    const limit = this.clock().getTime() + 10 * 60_000;
    this.tx(() => {
      for (const l of logs) {
        // Une pointeuse mal réglée (année 2000, heure d'été) ne note rien dans le futur.
        if (Date.parse(l.at) > limit) {
          out.unreadable += 1;
          continue;
        }
        const s = byNumber.get(storeId, l.number) as { id: string; active: number } | undefined;
        if (!s) {
          if (!out.unknown.includes(l.number)) out.unknown.push(l.number);
          continue;
        }
        if (!s.active) {
          out.inactive += 1;
          continue;
        }
        const r = this.punches.external(storeId, s.id, l.at, { entranceId: device?.entrance_id ?? null, station: opts.station ?? device?.serial ?? null });
        if (r.duplicate) out.duplicates += 1;
        else out.added += 1;
      }
    });
    out.unknown.sort((a, b) => a - b);
    return out;
  }

  /** Fichier « attlog » de la clé USB de la pointeuse, importé par le gérant. */
  importFile(ctx: Context, text: string): FingerprintImport {
    const r = this.record(ctx.storeId, text, { station: 'USB' });
    this.audit(ctx.userId, 'attendance.import', 'store', ctx.storeId, { added: r.added, duplicates: r.duplicates, unknown: r.unknown.length });
    return r;
  }
}
