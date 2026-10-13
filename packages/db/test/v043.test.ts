import { describe, expect, it } from 'vitest';
import { createServices, openDatabase } from '../src';

function setup() {
  let now = new Date('2026-10-13T09:00:00Z');
  const s = createServices(openDatabase(':memory:'), () => now);
  const { store, register, admin } = s.admin.bootstrap({ storeCode: 'DLA1', storeName: 'Superette Akwa', adminName: 'Steve', adminLogin: 'steve', adminPin: '1234' });
  const ctx = { storeId: store.id, registerId: register.id, userId: admin.id };
  const tva = s.admin.listVatRates().find((r) => r.rate_bp === 1925)!.id;
  const shop = s.admin.salesWarehouse(store.id);
  const reserve = s.admin.listWarehouses(store.id).find((w) => !w.is_sales_default) ?? s.admin.createWarehouse(store.id, 'Réserve', 'reserve');
  const castel = s.catalogue.saveArticle(admin.id, { name: 'CASTEL 65CL', unit: 'piece', vatRateId: tva, purchasePrice: 450, salePrice: 650 });
  const at = (iso: string) => {
    now = new Date(iso);
  };
  const qty = (warehouseId: string) => s.db.prepare('SELECT COALESCE(SUM(qty), 0) FROM stock WHERE article_id = ? AND warehouse_id = ?').pluck().get(castel.id, warehouseId) as number;
  return { s, ctx, store, admin, shop, reserve, castel, tva, at, qty };
}

describe('charges fixes : suppression', () => {
  it('efface une charge sans échéance constatée, arrête celle qui en a', () => {
    const { s, ctx, at } = setup();
    const eau = s.charges.savePlan(ctx, { categoryId: 'cat-eneo', label: 'CAMWATER', amount: 20_000, frequency: 'monthly', dueDay: 10, startMonth: '2026-10' });
    expect(s.charges.deletePlan(ctx, eau.id)).toEqual({ deleted: true, plan: null });
    expect(s.charges.listPlans(ctx.storeId, true)).toEqual([]);
    expect(s.db.prepare("SELECT op FROM outbox WHERE entity = 'charge_plan' AND entity_id = ? ORDER BY rowid DESC").pluck().get(eau.id)).toBe('delete');

    const loyer = s.charges.savePlan(ctx, { categoryId: 'cat-loyer', label: 'Loyer', amount: 150_000, frequency: 'monthly', dueDay: 5, startMonth: '2026-08' });
    at('2026-09-05T08:00:00Z');
    s.expenses.record(ctx, { categoryId: 'cat-loyer', label: 'Loyer septembre', amount: 150_000, method: 'CASH', planId: loyer.id, planPeriod: '2026-09' });
    at('2026-10-13T08:00:00Z');
    const r = s.charges.deletePlan(ctx, loyer.id);
    expect([r.deleted, r.plan?.active, r.plan?.end_month]).toEqual([false, 0, '2026-09']);
    // L'échéance payée reste, plus rien n'est en retard après septembre.
    const occ = s.charges.schedule(ctx.storeId, '2026-08', '2026-12').occurrences.filter((o) => o.plan_id === loyer.id);
    expect(occ.map((o) => [o.period, o.state])).toEqual([['2026-09', 'paid']]);
  });
});

describe('sauvegarde automatique programmée', () => {
  it('se refait toutes les N minutes une fois celle du jour faite', () => {
    const { s, admin, at } = setup();
    const setLast = (iso: string) => s.db.prepare("INSERT INTO settings (key, value) VALUES ('backup.lastAt', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(iso);
    setLast('2026-10-13T08:30:00Z');
    expect(s.backups.autoDue()).toBe(false);
    expect(() => s.backups.configure(admin.id, { everyMinutes: 7 })).toThrow(/Fréquence/);
    expect(s.backups.configure(admin.id, { everyMinutes: 60 }).every_minutes).toBe(60);
    expect(s.backups.autoDue()).toBe(false);
    at('2026-10-13T09:31:00Z');
    expect(s.backups.autoDue()).toBe(true);
    setLast('2026-10-13T09:31:00Z');
    expect(s.backups.autoDue()).toBe(false);
    s.backups.configure(admin.id, { everyMinutes: 0 });
    at('2026-10-13T15:00:00Z');
    expect(s.backups.autoDue()).toBe(false);
  });
});

describe('transferts : supprimer et modifier', () => {
  it('efface un brouillon, annule un transfert reçu et le reprend en brouillon', () => {
    const { s, ctx, shop, reserve, castel, qty } = setup();
    s.stock.receive(ctx, { warehouseId: reserve.id, lines: [{ articleId: castel.id, qty: 10_000, unitCost: 450 }] });
    const input = { fromWarehouseId: reserve.id, toWarehouseId: shop.id, lines: [{ articleId: castel.id, qty: 4_000 }] };

    const draft = s.transfers.create(ctx, input);
    expect(s.transfers.remove(ctx, draft.id)).toEqual({ deleted: true });
    expect(s.transfers.list(ctx.storeId)).toEqual([]);

    const t = s.transfers.create(ctx, input);
    s.transfers.ship(ctx, t.id);
    s.transfers.receive(ctx, t.id);
    expect([qty(reserve.id), qty(shop.id)]).toEqual([6_000, 4_000]);

    const copy = s.transfers.reopen(ctx, t.id);
    expect([qty(reserve.id), qty(shop.id)]).toEqual([10_000, 0]);
    expect(s.transfers.get(t.id).transfer.status).toBe('cancelled');
    expect(copy.status).toBe('draft');
    expect(s.transfers.get(copy.id).lines.map((l) => l.qty)).toEqual([4_000]);

    // Reçu puis vendu : l'annulation est refusée tant que le dépôt d'arrivée n'a plus la marchandise.
    s.transfers.ship(ctx, copy.id);
    s.transfers.receive(ctx, copy.id);
    s.stock.recordLoss(ctx, { warehouseId: shop.id, articleId: castel.id, qty: 1_000, type: 'BREAKAGE', reason: 'casse' });
    expect(() => s.transfers.remove(ctx, copy.id)).toThrow(/plus assez de CASTEL/);
    expect(s.transfers.list(ctx.storeId, { warehouseId: shop.id }).length).toBe(2);
  });
});
