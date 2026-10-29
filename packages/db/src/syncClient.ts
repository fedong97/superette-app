import { randomUUID } from 'node:crypto';
import type { Fcfa, PriceLevel } from '@superette/core';
import type { CounterAction, CounterInvoice, CounterPayload } from './counter';
import type { Services } from './index';
import type { SyncCheck, SyncCheckRow, SyncEvent } from './sync';
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
async function request<T>(baseUrl: string, path: string, init: { method?: string; token?: string; body?: unknown; timeoutMs?: number } = {}): Promise<T> {
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
      signal: AbortSignal.timeout(init.timeoutMs ?? 60_000),
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
    // Opérations refusées par un serveur plus ancien : elles restent en attente, les autres partent quand même.
    let refused: { id: string; reason: string }[] = [];
    for (;;) {
      const batch = s.sync.pending(500);
      if (batch.length === 0) break;
      const r = await request<{ accepted: string[]; rejected?: { id: string; reason: string }[] }>(creds.url, '/api/v1/sync/push', { token: creds.token, body: { events: batch } });
      s.sync.markSent(r.accepted);
      sent += r.accepted.length;
      refused = r.rejected ?? [];
      if (r.accepted.length === 0 || r.accepted.length + refused.length < batch.length || batch.length < 500) break;
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
    s.sync.recordResult(
      refused.length
        ? `${refused.length} opération(s) refusée(s) par le serveur central (${refused[0]!.reason}) : mettez à jour le serveur central, elles partiront ensuite.`
        : null,
      true,
    );
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

/**
 * État de la synchronisation : pour chaque sorte de données, ce que le PC a,
 * ce que le serveur a, et les écarts dans les deux sens. Le résultat est gardé
 * pour le voyant de la barre d'état.
 */
export async function checkSync(s: Services): Promise<SyncCheck> {
  const creds = s.sync.credentials();
  if (!creds) throw new AppError("Ce poste n'est pas relié au serveur central", 'SYNC_NOT_CONFIGURED');
  const storeId = s.admin.station()?.store.id ?? null;
  const rows: SyncCheckRow[] = [];
  for (const t of s.sync.checkTargets(storeId)) {
    const { ids } = await request<{ ids: string[] }>(creds.url, '/api/v1/sync/known', { token: creds.token, body: { entity: t.entity } });
    const server = new Set(ids);
    const local = new Set(t.ids);
    const pending = s.sync.pendingIds(t.entity);
    rows.push({
      entity: t.entity,
      label: t.label,
      local: local.size,
      server: server.size,
      missing_on_server: t.ids.filter((id) => !server.has(id) && !pending.has(id)).length,
      only_on_server: ids.filter((id) => !local.has(id)).length,
      pending: [...pending].filter((id) => local.has(id)).length,
    });
  }
  const state = s.sync.state();
  const check: SyncCheck = {
    at: new Date().toISOString(),
    ok: state.pending === 0 && state.conflicts === 0 && rows.every((r) => r.missing_on_server === 0 && r.only_on_server === 0),
    rows,
    pending: state.pending,
    conflicts: state.conflicts,
    lastSyncAt: state.lastSyncAt,
    lastError: state.lastError,
  };
  s.sync.saveCheck(check);
  return check;
}

/** Renvoie au serveur les données d'une sorte qu'il n'a pas (ligne de l'état de la synchronisation). */
export async function resendEntity(s: Services, entity: string): Promise<{ queued: number }> {
  const creds = s.sync.credentials();
  if (!creds) throw new AppError("Ce poste n'est pas relié au serveur central", 'SYNC_NOT_CONFIGURED');
  const t = s.sync.checkTargets(s.admin.station()?.store.id ?? null).find((x) => x.entity === entity);
  if (!t) throw new AppError('Sorte de données inconnue', 'INVALID');
  const { ids } = await request<{ ids: string[] }>(creds.url, '/api/v1/sync/known', { token: creds.token, body: { entity } });
  const known = new Set(ids);
  return { queued: s.sync.requeue(entity, t.ids.filter((id) => !known.has(id)), t.storeId) };
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
  /** `discount` : remise de la ligne en FCFA (vendeur au rayon complet). */
  lines: { articleId: string; qty: number; packId: string | null; discount?: number }[];
  /** Client choisi sur le téléphone, et tarif s'il n'est pas celui du client. */
  customerId?: string | null;
  customerName?: string | null;
  priceLevel?: PriceLevel | null;
  /** Qui a permis la remise ou le tarif : le vendeur qui en a le droit, ou le gérant qui a tapé son code (vérifié par le serveur). */
  discountBy?: string | null;
  discountReason?: string | null;
  optionsBy?: string | null;
  /** Total indicatif calculé par le serveur. */
  total?: number | null;
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

/** Commande passée sur la boutique en ligne du magasin, en attente d'un poste. */
export interface WebOrder {
  id: string;
  number: string;
  customerName: string;
  phone: string;
  address: string | null;
  slot: string | null;
  note: string | null;
  deliveryFee: number;
  lines: { articleId: string; name: string; qty: number; price: number }[];
  total: number;
  at: string;
}

/** Commandes de la boutique en ligne qui attendent un poste du magasin ; aucune si le PC n'est pas relié. */
export async function webOrders(s: Services): Promise<WebOrder[]> {
  const creds = s.sync.credentials();
  if (!creds) return [];
  return (await request<{ orders: WebOrder[] }>(creds.url, '/api/v1/web-orders', { token: creds.token })).orders;
}

/** Prend la commande de la boutique pour ce poste (un seul poste l'obtient). */
export async function takeWebOrder(s: Services, id: string): Promise<WebOrder> {
  const creds = s.sync.credentials();
  if (!creds) throw new AppError("Ce PC n'est pas relié au serveur : les commandes de la boutique en ligne n'arrivent pas", 'SYNC_NOT_CONFIGURED');
  return request<WebOrder>(creds.url, `/api/v1/web-orders/${encodeURIComponent(id)}/take`, { token: creds.token, body: {} });
}

/** Une sauvegarde de 200 Mo sur une connexion lente : jusqu'à 30 minutes. */
const BACKUP_TIMEOUT_MS = 30 * 60_000;

/** Envoie au serveur une sauvegarde déjà chiffrée sur ce PC (le serveur n'a pas la clé). */
export async function uploadStationBackup(s: Services, input: { name: string; data: Buffer; sha256: string }): Promise<{ id: string; at: string }> {
  const creds = s.sync.credentials();
  if (!creds) throw new AppError("Ce PC n'est pas relié au serveur : la sauvegarde en ligne est impossible", 'SYNC_NOT_CONFIGURED');
  return request<{ id: string; at: string }>(creds.url, '/api/v1/station-backups', {
    token: creds.token,
    body: { name: input.name, size: input.data.length, sha256: input.sha256, data: input.data.toString('base64') },
    timeoutMs: BACKUP_TIMEOUT_MS,
  });
}

/** Sauvegardes en ligne des PC du magasin, de la plus récente à la plus ancienne. */
export async function stationBackups(s: Services): Promise<{ id: string; name: string; size: number; at: string; device: string | null }[]> {
  const creds = s.sync.credentials();
  if (!creds) throw new AppError("Ce PC n'est pas relié au serveur : les sauvegardes en ligne ne sont pas accessibles", 'SYNC_NOT_CONFIGURED');
  return (await request<{ backups: { id: string; name: string; size: number; at: string; device: string | null }[] }>(creds.url, '/api/v1/station-backups', { token: creds.token })).backups;
}

/** Récupère une sauvegarde en ligne du magasin (toujours chiffrée : la clé du magasin l'ouvre). */
export async function downloadStationBackup(s: Services, id: string): Promise<{ name: string; data: Buffer }> {
  const creds = s.sync.credentials();
  if (!creds) throw new AppError("Ce PC n'est pas relié au serveur : les sauvegardes en ligne ne sont pas accessibles", 'SYNC_NOT_CONFIGURED');
  const r = await request<{ name: string; data: string }>(creds.url, `/api/v1/station-backups/${encodeURIComponent(id)}`, { token: creds.token, timeoutMs: BACKUP_TIMEOUT_MS });
  return { name: r.name, data: Buffer.from(r.data, 'base64') };
}

/** État d'un PC du magasin : envoyé au serveur, lu dans Administration › État des PC. */
export interface StationStatus {
  name: string;
  register: string | null;
  version: string;
  lastSyncAt: string | null;
  pending: number;
  syncError: string | null;
  backupAt: string | null;
  backupError: string | null;
  printer: string | null;
  printerEnabled: boolean;
  license: { state: string; canSell: boolean; daysLeft: number | null; message: string };
  /** Crédits clients du magasin (les plus gros soldes), pour le gérant sur son téléphone. */
  receivables?: Receivables | null;
  at: string;
}

export interface Receivables {
  total: Fcfa;
  overdue: Fcfa;
  count: number;
  customers: { id: string; name: string; phone: string | null; balance: Fcfa; overdue: Fcfa; limit: Fcfa }[];
}

/** Ce PC donne son état au serveur (après une synchronisation). */
export async function pushStationStatus(s: Services, status: StationStatus): Promise<void> {
  const creds = s.sync.credentials();
  if (!creds) return;
  await request(creds.url, '/api/v1/devices/status', { token: creds.token, body: status });
}

/** État de tous les PC du magasin, d'après le serveur. */
export async function stationStatuses(s: Services): Promise<{ deviceId: string; name: string; lastSeenAt: string | null; appVersion: string | null; status: StationStatus | null; self: boolean }[]> {
  const creds = s.sync.credentials();
  if (!creds) throw new AppError("Ce PC n'est pas relié au serveur : seul son propre état est connu", 'SYNC_NOT_CONFIGURED');
  const r = await request<{ devices: { deviceId: string; name: string; lastSeenAt: string | null; appVersion: string | null; status: StationStatus | null }[] }>(creds.url, '/api/v1/devices/status', { token: creds.token });
  const me = s.sync.state().deviceId;
  return r.devices.map((d) => ({ ...d, self: d.deviceId === me }));
}

/** Réception d'un bon de commande faite sur le téléphone : le PC la valide. */
export interface MobileReception {
  id: string;
  orderId: string;
  orderNumber: string | null;
  userName: string;
  deliveryNote: string | null;
  note: string | null;
  lines: { orderLineId: string | null; articleId: string; qty: number; damaged: number; lot: string | null; expiry: string | null }[];
  at: string;
}

export async function mobileReceptions(s: Services): Promise<MobileReception[]> {
  const creds = s.sync.credentials();
  if (!creds) return [];
  return (await request<{ receptions: MobileReception[] }>(creds.url, '/api/v1/mobile-receptions', { token: creds.token })).receptions;
}

/** Le PC prend la réception (un seul PC l'obtient) pour la valider. */
export async function takeMobileReception(s: Services, id: string): Promise<MobileReception> {
  const creds = s.sync.credentials();
  if (!creds) throw new AppError("Ce PC n'est pas relié au serveur", 'SYNC_NOT_CONFIGURED');
  return request<MobileReception>(creds.url, `/api/v1/mobile-receptions/${encodeURIComponent(id)}/take`, { token: creds.token, body: {} });
}

// ——— Vendeur et caissier séparés : factures envoyées à la caisse ———

/** Identifiant d'une nouvelle facture : le même renvoi après une coupure ne crée pas de doublon. */
export const newCounterId = () => `fc-${randomUUID()}`;

function creds(s: Services) {
  const c = s.sync.credentials();
  if (!c) throw new AppError('Vendeur et caissier séparés : ce PC doit être relié au serveur central (Administration › Serveur central)', 'SYNC_NOT_CONFIGURED');
  return c;
}

/** Envoie (ou renvoie après modification) une facture à la caisse. */
export async function counterSend(
  s: Services,
  input: { id: string; baseVersion: number | null; sellerId: string; sellerName: string; payload: CounterPayload; total: Fcfa; lines: number; customerName: string | null; forMe?: string | null },
): Promise<CounterInvoice> {
  const c = creds(s);
  return request<CounterInvoice>(c.url, '/api/v1/counter', { token: c.token, body: input });
}

/** Factures ouvertes du magasin (caisse), ou d'un vendeur, ou de tous les vendeurs (`'*'`). */
export async function counterList(s: Services, seller?: string | null): Promise<CounterInvoice[]> {
  const c = creds(s);
  const q = seller ? `?seller=${encodeURIComponent(seller)}` : '';
  return (await request<{ invoices: CounterInvoice[] }>(c.url, `/api/v1/counter${q}`, { token: c.token })).invoices;
}

export async function counterGet(s: Services, id: string): Promise<CounterInvoice> {
  const c = creds(s);
  return request<CounterInvoice>(c.url, `/api/v1/counter/${encodeURIComponent(id)}`, { token: c.token });
}

export async function counterAction(s: Services, id: string, action: CounterAction, body: { by?: string; note?: string | null; saleId?: string; saleNumber?: string } = {}): Promise<CounterInvoice> {
  const c = creds(s);
  return request<CounterInvoice>(c.url, `/api/v1/counter/${encodeURIComponent(id)}/${action}`, { token: c.token, body });
}

/** Avis « encaissée » restés sur ce PC (réseau coupé) : renvoyés au serveur. */
export async function flushCounterPaid(s: Services): Promise<void> {
  for (const p of s.counter.unsentPaid()) {
    try {
      await counterAction(s, p.invoice_id, 'paid', { saleId: p.sale_id, saleNumber: p.sale_number, by: p.user_name ?? '' });
      s.counter.markPaidSent(p.invoice_id);
    } catch (e) {
      // Serveur injoignable : on réessaiera ; facture refusée (annulée entre-temps) : on n'insiste pas.
      if (e instanceof AppError && e.code === 'SYNC_OFFLINE') return;
      s.counter.markPaidSent(p.invoice_id);
    }
  }
}
