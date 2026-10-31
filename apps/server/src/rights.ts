import type { Db } from './database';

type Json = Record<string, unknown>;

const parse = <T>(v: unknown, fallback: T): T => {
  if (v === null || v === undefined || v === '') return fallback;
  if (typeof v !== 'string') return v as T;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
};

/** Délégation reçue d'un gérant absent, encore en cours. */
export function activeDelegation(userRights: Json | null, now = Date.now()): { by: string; byName: string; until: string; rights: string[] } | null {
  const d = parse<{ by?: string; byName?: string; until?: string; rights?: string[] } | null>(userRights?.['delegation'], null);
  if (!d?.until || new Date(d.until).getTime() <= now) return null;
  return { by: String(d.by ?? ''), byName: String(d.byName ?? ''), until: d.until, rights: Array.isArray(d.rights) ? d.rights.map(String) : [] };
}

/**
 * Un droit de l'utilisateur, calculé comme sur les PC : délégation en cours,
 * privilèges retirés ou accordés, réglage du rôle (le droit demandé puis ses
 * parents dans `chain`), sinon les rôles qui l'ont par défaut.
 */
export function rightFrom(role: string, userRights: Json | null, roleRights: Json | null, chain: string[], defaults: string[]): boolean {
  if (role === 'admin') return true;
  const [right] = chain;
  if (!right) return false;
  if (activeDelegation(userRights)?.rights.includes(right)) return true;
  if (parse<string[]>(userRights?.['revokes'], []).includes(right)) return false;
  if (parse<string[]>(userRights?.['grants'], []).includes(right)) return true;
  const rr = parse<Record<string, boolean>>(roleRights?.['rights'], {});
  for (const r of chain) if (rr[r] !== undefined) return rr[r]!;
  return defaults.includes(role);
}

/** Dernière fiche reçue des PC pour une entité (null si supprimée ou inconnue). */
async function latest(pg: Db, entity: string, id: string): Promise<Json | null> {
  const { rows } = await pg.query<{ op: string; payload: Json | null }>('SELECT op, payload FROM events WHERE entity = $1 AND entity_id = $2 ORDER BY seq DESC LIMIT 1', [entity, id]);
  const r = rows[0];
  return r && r.op !== 'delete' ? (r.payload ?? null) : null;
}

/** Droit d'un utilisateur lu dans le journal des PC. */
export async function userHasRight(pg: Db, userId: string, role: string, chain: string[], defaults: string[]): Promise<boolean> {
  if (role === 'admin') return true;
  return rightFrom(role, await latest(pg, 'user_rights', userId), await latest(pg, 'role_rights', role), chain, defaults);
}

/** Superviseur : son code vaut celui du gérant (gérant, administrateur, ou droit « Superviseur » donné ou délégué). */
export function isSupervisor(pg: Db, userId: string, role: string): Promise<boolean> {
  return userHasRight(pg, userId, role, ['supervisor'], ['manager']);
}

/** Utilisateurs actifs du magasin (fiches reçues des PC). */
export async function storeUsers(pg: Db, storeId: string): Promise<{ entity_id: string; payload: Json }[]> {
  const { rows } = await pg.query<{ entity_id: string; payload: Json }>(
    `SELECT entity_id, payload FROM (SELECT DISTINCT ON (entity_id) entity_id, op, payload FROM events WHERE entity = 'user' ORDER BY entity_id, seq DESC) u
     WHERE op = 'upsert' AND (payload->>'active')::int = 1 AND payload->>'deleted_at' IS NULL
       AND (payload->>'store_id' IS NULL OR payload->>'store_id' = $1)`,
    [storeId],
  );
  return rows;
}
