import { createHash } from 'node:crypto';
import { Base } from './util';

/**
 * Erreurs du logiciel (0.116.0) : un plantage du programme (pas une erreur
 * prévue comme « stock insuffisant ») est noté sur ce PC, puis envoyé au serveur
 * central, où FEDONG le voit avant que le client n'appelle.
 *
 * Gardé : le message, l'endroit dans le programme (pile d'appels), la version,
 * l'écran ou l'action, et combien de fois c'est arrivé. Jamais de données
 * saisies : les chemins de dossiers perdent le nom de l'utilisateur Windows et
 * les longues suites de chiffres (téléphones, montants, codes) sont masquées.
 */

export type AppErrorSource = 'main' | 'screen' | 'action';

export interface AppErrorRow {
  id: string;
  source: AppErrorSource;
  message: string;
  stack: string | null;
  where_at: string | null;
  version: string | null;
  count: number;
  first_at: string;
  last_at: string;
  sent_at: string | null;
}

export interface AppErrorReport {
  id: string;
  source: AppErrorSource;
  message: string;
  stack: string | null;
  where: string | null;
  version: string | null;
  count: number;
  firstAt: string;
  lastAt: string;
}

const MAX_MESSAGE = 500;
const MAX_STACK = 3_000;
/** Lignes gardées sur ce PC (les plus récentes). */
const KEEP = 500;

/** Retire de quoi reconnaître une personne ou une donnée : nom de session Windows, chiffres longs, adresses e-mail. */
export function scrubError(text: string): string {
  return text
    .replace(/([\\/](?:Users|home)[\\/])[^\\/\s'"]+/gi, '$1…')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '…@…')
    .replace(/\d{6,}/g, (m) => '#'.repeat(Math.min(m.length, 12)));
}

export class AppErrorService extends Base {
  /** Note une erreur ; la même erreur le même jour ne fait qu'augmenter son compteur. */
  record(input: { source: AppErrorSource; message: string; stack?: string | null; where?: string | null; version?: string | null }): void {
    const message = scrubError(String(input.message ?? '').trim() || 'Erreur sans message').slice(0, MAX_MESSAGE);
    const stack = input.stack ? scrubError(String(input.stack)).slice(0, MAX_STACK) : null;
    const where = input.where ? scrubError(String(input.where)).slice(0, 120) : null;
    const now = this.now();
    // Même message, même premier endroit du programme, même version, même jour : une seule ligne.
    const frame = stack?.split('\n').find((l) => /^\s*at /.test(l))?.trim() ?? '';
    const id = createHash('sha256')
      .update([input.source, message, frame, input.version ?? '', now.slice(0, 10)].join('|'))
      .digest('hex')
      .slice(0, 32);
    this.db
      .prepare(
        `INSERT INTO app_errors (id, source, message, stack, where_at, version, count, first_at, last_at, sent_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, NULL)
         ON CONFLICT(id) DO UPDATE SET count = count + 1, last_at = excluded.last_at, sent_at = NULL, where_at = COALESCE(excluded.where_at, where_at)`,
      )
      .run(id, input.source, message, stack, where, input.version ?? null, now, now);
    this.db.prepare(`DELETE FROM app_errors WHERE id NOT IN (SELECT id FROM app_errors ORDER BY last_at DESC LIMIT ${KEEP})`).run();
  }

  list(limit = 100): AppErrorRow[] {
    return this.db.prepare('SELECT * FROM app_errors ORDER BY last_at DESC LIMIT ?').all(limit) as AppErrorRow[];
  }

  /** Erreurs pas encore envoyées au serveur (ou arrivées de nouveau depuis l'envoi). */
  unsent(limit = 50): AppErrorReport[] {
    return (this.db.prepare('SELECT * FROM app_errors WHERE sent_at IS NULL ORDER BY last_at LIMIT ?').all(limit) as AppErrorRow[]).map((r) => ({
      id: r.id,
      source: r.source,
      message: r.message,
      stack: r.stack,
      where: r.where_at,
      version: r.version,
      count: r.count,
      firstAt: r.first_at,
      lastAt: r.last_at,
    }));
  }

  markSent(reports: Pick<AppErrorReport, 'id' | 'lastAt'>[]): void {
    const at = this.now();
    // Arrivée de nouveau pendant l'envoi : last_at a changé, elle repartira.
    const mark = this.db.prepare('UPDATE app_errors SET sent_at = ? WHERE id = ? AND last_at = ?');
    this.tx(() => {
      for (const r of reports) mark.run(at, r.id, r.lastAt);
    });
  }
}
