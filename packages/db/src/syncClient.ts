import type { Services } from './index';
import type { SyncEvent } from './sync';
import { AppError } from './util';

let clientVersion: string | null = null;
/** Version de l'application, envoyée au serveur pour qu'il sache quels PC sont à jour. */
export function setSyncClientVersion(version: string) {
  clientVersion = version;
}

/**
 * Échanges HTTP avec le serveur central (fetch : Node 22 et Electron).
 * Utilisé par le processus principal de l'application et par les tests.
 */
async function request<T>(baseUrl: string, path: string, init: { method?: string; token?: string; body?: unknown } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl.replace(/\/+$/, '')}${path}`, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers: {
        'content-type': 'application/json',
        ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
        ...(clientVersion ? { 'x-fedonix-version': clientVersion } : {}),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (e) {
    throw new AppError(`Serveur central injoignable (${e instanceof Error ? e.message : String(e)})`, 'SYNC_OFFLINE');
  }
  const text = await res.text();
  const data = text ? (JSON.parse(text) as unknown) : null;
  if (!res.ok) {
    const message = (data as { message?: string | string[] } | null)?.message;
    throw new AppError(Array.isArray(message) ? message.join(', ') : (message ?? `Erreur serveur ${res.status}`), res.status === 401 ? 'SYNC_UNAUTHORIZED' : 'SYNC_ERROR');
  }
  return data as T;
}

interface DeviceCredentials {
  deviceId: string;
  token: string;
  storeId: string;
  registerId: string;
}

/** Envoie les opérations en attente puis récupère celles des autres postes. */
export async function syncOnce(s: Services): Promise<{ sent: number; received: number; conflicts: number }> {
  const creds = s.sync.credentials();
  if (!creds) throw new AppError("Ce poste n'est pas relié au serveur central", 'SYNC_NOT_CONFIGURED');
  let sent = 0;
  let received = 0;
  let conflicts = 0;
  try {
    // Stock du magasin pour l'écran « Stock multi-magasin » des autres magasins.
    const station = s.admin.station();
    if (station) s.sync.publishStock(station.store.id);
    // Une fois par serveur : ce qui lui manque repart (serveur réinstallé, sauvegarde restaurée).
    if (!s.sync.resendChecked() && Date.now() >= nextResendTry) {
      try {
        await resendMissing(s);
      } catch (e) {
        // Serveur pas encore mis à jour : on réessaiera plus tard, la synchronisation continue.
        if (e instanceof AppError && e.code === 'SYNC_OFFLINE') throw e;
        nextResendTry = Date.now() + 3_600_000;
      }
    }
    for (;;) {
      const batch = s.sync.pending(500);
      if (batch.length === 0) break;
      const { accepted } = await request<{ accepted: string[] }>(creds.url, '/api/v1/sync/push', { token: creds.token, body: { events: batch } });
      s.sync.markSent(accepted);
      sent += accepted.length;
      if (accepted.length < batch.length) break;
    }
    // Licence activée sur ce PC : le serveur la garde et la donne aux autres PC du magasin.
    const key = s.license.pendingUpload();
    if (key) {
      try {
        const r = await request<{ license: string | null }>(creds.url, '/api/v1/license', { token: creds.token, body: { key } });
        s.license.markUploaded(key);
        s.license.acceptFromServer(r.license);
      } catch (e) {
        // Serveur pas encore mis à jour ou licence refusée : la synchronisation continue.
        if (e instanceof AppError && e.code === 'SYNC_OFFLINE') throw e;
      }
    }
    for (;;) {
      const since = s.sync.state().cursor;
      const page = await request<{ events: SyncEvent[]; cursor: number; hasMore: boolean; license?: string | null }>(creds.url, `/api/v1/sync/pull?since=${since}&limit=1000`, {
        token: creds.token,
      });
      const result = s.sync.applyRemote(page.events);
      s.sync.setCursor(page.cursor);
      s.license.acceptFromServer(page.license);
      received += result.applied;
      conflicts += result.conflicts;
      if (!page.hasMore) break;
    }
    s.sync.recordResult(null);
  } catch (e) {
    s.sync.recordResult(e instanceof Error ? e.message : String(e));
    throw e;
  }
  return { sent, received, conflicts };
}

let nextResendTry = 0;

/**
 * Compare les données de référence du PC (produits, rayons, dépôts,
 * utilisateurs, stock, inventaires…) à celles du serveur et remet dans la file
 * d'envoi celles qu'il n'a pas. Rien n'est renvoyé de ce que le serveur a déjà.
 */
export async function resendMissing(s: Services): Promise<{ queued: number }> {
  const creds = s.sync.credentials();
  if (!creds) throw new AppError("Ce poste n'est pas relié au serveur central", 'SYNC_NOT_CONFIGURED');
  const station = s.admin.station();
  let queued = 0;
  for (const t of s.sync.resendTargets(station?.store.id ?? null)) {
    if (t.ids.length === 0) continue;
    const { ids } = await request<{ ids: string[] }>(creds.url, '/api/v1/sync/known', { token: creds.token, body: { entity: t.entity } });
    const known = new Set(ids);
    queued += s.sync.requeue(
      t.entity,
      t.ids.filter((id) => !known.has(id)),
      t.storeId,
    );
  }
  s.sync.markResendChecked();
  return { queued };
}

/** Relie le poste principal (déjà configuré) au serveur avec la clé d'enrôlement, puis envoie tout son historique. */
export async function enrollStation(s: Services, url: string, enrollmentKey: string, name: string): Promise<ReturnType<typeof syncOnce>> {
  const station = s.admin.station();
  if (!station?.register) throw new AppError("Ce poste doit d'abord être activé comme caisse", 'NO_REGISTER');
  const creds = await request<DeviceCredentials>(url, '/api/v1/devices/enroll', {
    body: { enrollmentKey, storeId: station.store.id, registerId: station.register.id, name },
  });
  s.sync.saveCredentials(url, creds.deviceId, creds.token);
  return syncOnce(s);
}

/**
 * Nouveau PC : se rattache à une caisse déclarée sur un autre poste, avec
 * son code d'activation, et récupère toutes les données du magasin.
 */
export async function joinStore(s: Services, url: string, activationCode: string, name: string): Promise<ReturnType<Services['admin']['station']>> {
  if (s.admin.isInitialized()) throw new AppError('Ce poste contient déjà des données', 'ALREADY_INITIALIZED');
  const creds = await request<DeviceCredentials>(url, '/api/v1/devices/activate', { body: { activationCode, name } });
  s.sync.saveCredentials(url, creds.deviceId, creds.token);
  await syncOnce(s);
  s.admin.activateRegister(activationCode);
  return s.admin.station();
}

/** Accord du gérant demandé au serveur : il répond depuis la page du gérant sur son téléphone. */
export async function requestApproval(s: Services, action: string, requestedBy: string): Promise<{ id: string; expiresInSeconds: number }> {
  const creds = s.sync.credentials();
  if (!creds) throw new AppError("Ce PC n'est pas relié au serveur : le gérant ne peut pas répondre de son téléphone", 'SYNC_NOT_CONFIGURED');
  return request(creds.url, '/api/v1/approvals', { token: creds.token, body: { action, requestedBy } });
}

/** Réponse du gérant : en attente, accordée (une seule lecture), refusée ou expirée. */
export async function approvalStatus(s: Services, id: string): Promise<{ status: 'pending' | 'approved' | 'refused' | 'expired' | 'used'; decidedBy?: string; decidedName?: string | null }> {
  const creds = s.sync.credentials();
  if (!creds) throw new AppError("Ce PC n'est pas relié au serveur", 'SYNC_NOT_CONFIGURED');
  return request(creds.url, `/api/v1/approvals/${encodeURIComponent(id)}`, { token: creds.token });
}

/** Panier préparé au rayon par un vendeur, en attente d'une caisse. */
export interface ShelfCart {
  id: string;
  number: number;
  label: string | null;
  sellerId: string;
  sellerName: string;
  lines: { articleId: string; qty: number; packId: string | null }[];
  at: string;
}

/** Paniers des vendeurs du magasin qui attendent une caisse. */
export async function shelfCarts(s: Services): Promise<ShelfCart[]> {
  const creds = s.sync.credentials();
  if (!creds) return [];
  return (await request<{ carts: ShelfCart[] }>(creds.url, '/api/v1/carts', { token: creds.token })).carts;
}

/** Prend le panier pour cette caisse (une seule caisse l'obtient). */
export async function takeShelfCart(s: Services, id: string): Promise<ShelfCart> {
  const creds = s.sync.credentials();
  if (!creds) throw new AppError("Ce PC n'est pas relié au serveur", 'SYNC_NOT_CONFIGURED');
  return request<ShelfCart>(creds.url, `/api/v1/carts/${encodeURIComponent(id)}/take`, { token: creds.token, body: {} });
}
