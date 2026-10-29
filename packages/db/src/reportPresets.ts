import { AppError, Base, newId } from './util';

/** Filtres d'un rapport enregistrés sous un nom, rappelés d'un clic. */
export interface ReportPreset {
  id: string;
  /** Écran du rapport (« reports », « expenses »…). */
  screen: string;
  name: string;
  /** Critères tels que l'écran les lit (période, regroupement, comparaison…). */
  params: Record<string, unknown>;
  /** null : visible de tous ; sinon réservé à son auteur. */
  user_id: string | null;
  mine: boolean;
}

const MAX_PARAMS = 4000;

export class ReportPresetService extends Base {
  /** Filtres d'un écran : ceux de l'utilisateur et ceux partagés, par nom. */
  list(userId: string, screen: string): ReportPreset[] {
    const rows = this.db
      .prepare('SELECT id, screen, name, params, user_id FROM report_presets WHERE screen = ? AND deleted = 0 AND (user_id IS NULL OR user_id = ?) ORDER BY name COLLATE NOCASE')
      .all(screen, userId) as { id: string; screen: string; name: string; params: string; user_id: string | null }[];
    return rows.map((r) => ({ ...r, params: safeParse(r.params), mine: r.user_id === userId }));
  }

  /** Enregistre (ou remplace, même nom sur le même écran) un filtre. */
  save(userId: string, input: { screen: string; name: string; params: Record<string, unknown>; shared?: boolean }): ReportPreset {
    const name = input.name?.trim().replace(/\s+/g, ' ').slice(0, 60);
    if (!name) throw new AppError('Donnez un nom à ce filtre', 'INVALID');
    const screen = input.screen?.trim();
    if (!screen || !/^[a-z][a-zA-Z0-9_.-]{1,40}$/.test(screen)) throw new AppError('Écran inconnu', 'INVALID');
    const params = JSON.stringify(input.params ?? {});
    if (params.length > MAX_PARAMS) throw new AppError('Filtre trop long', 'INVALID');
    const owner = input.shared ? null : userId;
    const twin = this.db
      .prepare('SELECT id FROM report_presets WHERE screen = ? AND deleted = 0 AND name = ? COLLATE NOCASE AND user_id IS ?')
      .pluck()
      .get(screen, name, owner) as string | undefined;
    const id = twin ?? newId();
    this.tx(() => {
      const now = this.now();
      this.db
        .prepare(
          `INSERT INTO report_presets (id, user_id, screen, name, params, deleted, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)
           ON CONFLICT(id) DO UPDATE SET name = excluded.name, params = excluded.params, updated_at = excluded.updated_at`,
        )
        .run(id, owner, screen, name, params, now, now);
      this.enqueue(null, 'report_preset', id, 'upsert', {});
      this.audit(userId, twin ? 'report_preset.update' : 'report_preset.create', 'report_preset', id, { screen, name, shared: owner === null });
    });
    return this.list(userId, screen).find((p) => p.id === id)!;
  }

  /** Supprime un filtre : le sien, ou un filtre partagé si on gère les rapports. */
  remove(userId: string, id: string, canShared: boolean): void {
    const row = this.db.prepare('SELECT user_id FROM report_presets WHERE id = ? AND deleted = 0').get(id) as { user_id: string | null } | undefined;
    if (!row) throw new AppError('Filtre introuvable', 'NOT_FOUND');
    if (row.user_id !== userId && !(row.user_id === null && canShared)) throw new AppError("Ce filtre n'est pas le vôtre", 'FORBIDDEN');
    this.tx(() => {
      this.db.prepare('UPDATE report_presets SET deleted = 1, updated_at = ? WHERE id = ?').run(this.now(), id);
      this.enqueue(null, 'report_preset', id, 'upsert', {});
      this.audit(userId, 'report_preset.delete', 'report_preset', id);
    });
  }
}

function safeParse(text: string): Record<string, unknown> {
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
