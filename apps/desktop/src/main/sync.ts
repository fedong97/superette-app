import { hostname } from 'node:os';
import { type Services, enrollStation, joinStore, syncOnce } from '@superette/db';

const INTERVAL_MS = 20_000;

/**
 * Synchronisation en arrière-plan avec le serveur central : toutes les
 * 20 secondes tant que le poste est relié. Hors ligne, la caisse continue
 * de fonctionner et les opérations partent au retour du réseau.
 */
export function createSyncRunner(s: Services) {
  // Une seule synchronisation à la fois : les demandes s'enchaînent.
  let chain: Promise<unknown> = Promise.resolve();
  let busy = 0;
  const run = <T>(task: () => Promise<T>): Promise<T> => {
    busy++;
    const next = chain.then(task).finally(() => busy--);
    chain = next.catch(() => undefined);
    return next;
  };

  const timer = setInterval(() => {
    if (busy > 0 || !s.sync.credentials()) return;
    run(() => syncOnce(s)).catch((e) => console.warn('[sync]', e instanceof Error ? e.message : e));
  }, INTERVAL_MS);

  return {
    now: () => run(() => syncOnce(s)),
    connect: (url: string, enrollmentKey: string) => run(() => enrollStation(s, url.trim(), enrollmentKey.trim(), hostname())),
    join: (url: string, activationCode: string) => run(() => joinStore(s, url.trim(), activationCode.trim(), hostname())),
    stop: () => clearInterval(timer),
  };
}

export type SyncRunner = ReturnType<typeof createSyncRunner>;
