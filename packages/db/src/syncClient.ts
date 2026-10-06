import type { Services } from './index';
import type { SyncEvent } from './sync';
import { AppError } from './util';

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
    for (;;) {
      const batch = s.sync.pending(500);
      if (batch.length === 0) break;
      const { accepted } = await request<{ accepted: string[] }>(creds.url, '/api/v1/sync/push', { token: creds.token, body: { events: batch } });
      s.sync.markSent(accepted);
      sent += accepted.length;
      if (accepted.length < batch.length) break;
    }
    for (;;) {
      const since = s.sync.state().cursor;
      const page = await request<{ events: SyncEvent[]; cursor: number; hasMore: boolean }>(creds.url, `/api/v1/sync/pull?since=${since}&limit=1000`, {
        token: creds.token,
      });
      const result = s.sync.applyRemote(page.events);
      s.sync.setCursor(page.cursor);
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
