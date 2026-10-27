import type { Context, Services } from '@superette/db';

const CHECK_MS = 5 * 60_000;

/**
 * Travaux programmés du magasin, vérifiés toutes les 5 minutes sur chaque PC :
 * prix arrivés à leur date, commandes répétées des clients pros à préparer.
 * Les deux sont sans doublon : un autre PC qui les fait aussi ne change rien.
 */
export function createScheduler(s: Services) {
  const tick = () => {
    const station = s.admin.station();
    if (!station?.register) return;
    const admin = s.db.prepare("SELECT id FROM users WHERE role = 'admin' AND active = 1 AND deleted_at IS NULL ORDER BY created_at LIMIT 1").pluck().get() as string | undefined;
    if (!admin) return;
    const ctx: Context = { storeId: station.store.id, registerId: station.register.id, userId: admin };
    for (const [name, job] of [
      ['prix programmés', () => s.priceSchedules.applyDue(ctx)],
      ['commandes répétées', () => s.recurringOrders.generate(ctx)],
    ] as const) {
      try {
        job();
      } catch (e) {
        console.warn(`[${name}]`, e instanceof Error ? e.message : e);
      }
    }
  };
  const start = setTimeout(tick, 60_000);
  const timer = setInterval(tick, CHECK_MS);
  return {
    runNow: tick,
    stop: () => {
      clearTimeout(start);
      clearInterval(timer);
    },
  };
}
