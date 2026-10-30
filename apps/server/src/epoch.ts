import { randomUUID } from 'node:crypto';
import type { Db } from './database';

/**
 * Époque de la base du serveur : elle change sur un serveur neuf et à chaque
 * restauration. Un PC qui voit l'époque changer sait que les numéros des
 * opérations ne suivent plus ceux qu'il a lus : il reprend la lecture au début
 * de la nouvelle époque et renvoie ce que le serveur a pu perdre.
 */
export interface Epoch {
  id: string;
  /** Dernier numéro d'opération au début de l'époque : ce qui vient après est nouveau. */
  seq: number;
  /** Date de la dernière opération connue au début de l'époque (null : serveur vide). */
  from: string | null;
}

async function current(pg: Db): Promise<{ seq: number; from: string | null }> {
  const { rows } = await pg.query<{ seq: string | null; at: Date | string | null }>('SELECT MAX(seq)::text AS seq, MAX(created_at) AS at FROM events');
  const at = rows[0]?.at ?? null;
  return { seq: Number(rows[0]?.seq ?? 0), from: at ? new Date(at).toISOString() : null };
}

/** Époque en cours ; la première est créée au premier appel. */
export async function readEpoch(pg: Db): Promise<Epoch> {
  const { rows } = await pg.query<{ value: string }>("SELECT value FROM settings WHERE key = 'sync_epoch'");
  if (rows[0]) return JSON.parse(rows[0].value) as Epoch;
  const epoch: Epoch = { id: randomUUID(), ...(await current(pg)) };
  await pg.query("INSERT INTO settings (key, value) VALUES ('sync_epoch', $1) ON CONFLICT (key) DO NOTHING", [JSON.stringify(epoch)]);
  return readEpoch(pg);
}

/** Nouvelle époque, après une restauration. */
export async function startEpoch(pg: Db): Promise<Epoch> {
  const epoch: Epoch = { id: randomUUID(), ...(await current(pg)) };
  await pg.query("INSERT INTO settings (key, value) VALUES ('sync_epoch', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [JSON.stringify(epoch)]);
  return epoch;
}
