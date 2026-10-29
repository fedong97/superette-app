import { hostname } from 'node:os';
import { type Services, checkSync, enrollStation, joinStore, resendEntity, resendMissing, syncOnce } from '@superette/db';

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
    /** Renvoie au serveur les données qu'il n'a pas, puis synchronise. */
    resend: () =>
      run(async () => {
        const { queued } = await resendMissing(s);
        return { ...(await syncOnce(s)), queued };
      }),
    /** État de la synchronisation : le PC et le serveur comparés, sorte par sorte. */
    check: () => run(async () => (await syncOnce(s).catch(() => null), checkSync(s))),
    /** Renvoie une sorte de données qui manque au serveur, synchronise, puis refait l'état. */
    resendEntity: (entity: string) =>
      run(async () => {
        const { queued } = await resendEntity(s, entity);
        await syncOnce(s);
        return { queued, check: await checkSync(s) };
      }),
    connect: (url: string, enrollmentKey: string) => run(() => enrollStation(s, url.trim(), enrollmentKey.trim(), hostname())),
    join: (url: string, activationCode: string) => run(() => joinStore(s, url.trim(), activationCode.trim(), hostname())),
    stop: () => clearInterval(timer),
  };
}

export type SyncRunner = ReturnType<typeof createSyncRunner>;
