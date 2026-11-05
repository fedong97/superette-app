import { BadRequestException, GatewayTimeoutException, Injectable, type OnModuleDestroy, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

/** Appel du logiciel du PC fait depuis le téléphone du gérant. */
export interface RemoteCall {
  id: string;
  userId: string;
  name: string;
  args: unknown[];
}

/** Réponse du PC, telle que l'écran du PC la reçoit : données, ou erreur avec ses solutions. */
export type RemoteReply = { ok: true; data: unknown } | { ok: false; error: { message: string; code: string; fixes?: unknown[] } };

interface Pending extends RemoteCall {
  storeId: string;
  done: (r: RemoteReply) => void;
  takenBy: string | null;
}

interface Waiter {
  deviceId: string;
  give: (calls: RemoteCall[]) => void;
}

/** Un PC qui n'est pas revenu chercher du travail depuis ce délai est considéré éteint. */
const ONLINE_MS = 45_000;
/** Temps laissé au PC pour répondre (rapports lourds compris). */
const REPLY_MS = 45_000;
/** Attente d'un PC qui demande du travail, avant qu'il redemande. */
const POLL_MS = 25_000;

/**
 * « Le PC sur le téléphone » : le téléphone du gérant affiche l'écran complet du
 * logiciel du PC, et chaque action part ici. Un PC allumé du magasin, qui attend
 * en permanence (requête longue), la prend, l'exécute au nom du gérant avec ses
 * droits, et rend la réponse. Rien n'est gardé sur le serveur : un appel sans
 * PC pour le prendre échoue tout de suite, avec un message clair.
 */
@Injectable()
export class RemotePcService implements OnModuleDestroy {
  private closed = false;
  private readonly queue = new Map<string, Pending[]>();
  private readonly taken = new Map<string, Pending>();
  private readonly waiters = new Map<string, Waiter[]>();
  private readonly seen = new Map<string, Map<string, number>>();

  /** PC du magasin prêts à exécuter (revenus récemment). */
  online(storeId: string): number {
    const pcs = this.seen.get(storeId);
    if (!pcs) return 0;
    const now = Date.now();
    let n = 0;
    for (const [id, at] of pcs) {
      if (now - at < ONLINE_MS) n++;
      else pcs.delete(id);
    }
    return n;
  }

  private mark(storeId: string, deviceId: string) {
    let pcs = this.seen.get(storeId);
    if (!pcs) this.seen.set(storeId, (pcs = new Map()));
    pcs.set(deviceId, Date.now());
  }

  /** Le téléphone appelle une action du PC ; la réponse revient quand un PC l'a exécutée. */
  call(storeId: string, userId: string, name: unknown, args: unknown): Promise<RemoteReply> {
    if (typeof name !== 'string' || !/^[a-zA-Z]+\.[a-zA-Z]+$/.test(name)) throw new BadRequestException('Action inconnue');
    if (args !== undefined && !Array.isArray(args)) throw new BadRequestException('Paramètres invalides');
    if (JSON.stringify(args ?? []).length > 2_000_000) throw new BadRequestException('Envoi trop gros');
    if (!this.online(storeId)) {
      throw new ServiceUnavailableException('Aucun PC du magasin n’est allumé et relié au serveur : allumez-en un (n’importe lequel) puis réessayez.');
    }
    return new Promise<RemoteReply>((resolve, reject) => {
      const p: Pending = {
        id: randomUUID(),
        storeId,
        userId,
        name,
        args: (args as unknown[] | undefined) ?? [],
        takenBy: null,
        done: (r) => {
          clearTimeout(timer);
          this.taken.delete(p.id);
          this.remove(p);
          resolve(r);
        },
      };
      const timer = setTimeout(() => {
        this.taken.delete(p.id);
        this.remove(p);
        reject(new GatewayTimeoutException('Le PC du magasin n’a pas répondu à temps : vérifiez sa connexion, puis réessayez.'));
      }, REPLY_MS);
      const list = this.queue.get(storeId) ?? [];
      list.push(p);
      this.queue.set(storeId, list);
      this.dispatch(storeId);
    });
  }

  private remove(p: Pending) {
    const list = this.queue.get(p.storeId);
    if (!list) return;
    const i = list.indexOf(p);
    if (i >= 0) list.splice(i, 1);
  }

  /** Donne le travail en attente au premier PC qui attend. */
  private dispatch(storeId: string) {
    const list = this.queue.get(storeId);
    const waiters = this.waiters.get(storeId);
    if (!list?.length || !waiters?.length) return;
    const w = waiters.shift()!;
    const calls = list.splice(0, 10);
    for (const c of calls) {
      c.takenBy = w.deviceId;
      this.taken.set(c.id, c);
    }
    w.give(calls.map(({ id, userId, name, args }) => ({ id, userId, name, args })));
  }

  /** Arrêt du serveur : les PC qui attendent repartent tout de suite (l'arrêt n'attend pas 25 s). */
  onModuleDestroy() {
    this.closed = true;
    for (const list of this.waiters.values()) for (const w of [...list]) w.give([]);
  }

  /** Le PC attend du travail (requête longue) ; il redemande aussitôt après chaque réponse. */
  next(device: { id: string; store_id: string }, waitMs = POLL_MS): Promise<{ calls: RemoteCall[] }> {
    if (this.closed) return Promise.resolve({ calls: [] });
    this.mark(device.store_id, device.id);
    return new Promise((resolve) => {
      const waiters = this.waiters.get(device.store_id) ?? [];
      // Un seul attente par PC : l'ancienne (connexion coupée) laisse la place.
      for (const old of waiters.filter((w) => w.deviceId === device.id)) old.give([]);
      const kept = waiters.filter((w) => w.deviceId !== device.id);
      const w: Waiter = {
        deviceId: device.id,
        give: (calls) => {
          clearTimeout(timer);
          const list = this.waiters.get(device.store_id);
          if (list) {
            const i = list.indexOf(w);
            if (i >= 0) list.splice(i, 1);
          }
          this.mark(device.store_id, device.id);
          resolve({ calls });
        },
      };
      const timer = setTimeout(() => w.give([]), Math.max(1_000, Math.min(waitMs, POLL_MS)));
      kept.push(w);
      this.waiters.set(device.store_id, kept);
      this.dispatch(device.store_id);
    });
  }

  /** Réponse du PC à un appel qu'il a pris. */
  reply(device: { id: string; store_id: string }, id: string, reply: RemoteReply): { ok: boolean } {
    const p = this.taken.get(id);
    if (!p || p.storeId !== device.store_id || p.takenBy !== device.id) return { ok: false };
    const r: RemoteReply =
      reply && reply.ok === true
        ? { ok: true, data: reply.data ?? null }
        : { ok: false, error: { message: String(reply?.ok === false ? reply.error?.message : 'Réponse invalide du PC'), code: String(reply?.ok === false ? reply.error?.code : 'INTERNAL'), fixes: reply?.ok === false ? reply.error?.fixes : undefined } };
    p.done(r);
    return { ok: true };
  }
}
