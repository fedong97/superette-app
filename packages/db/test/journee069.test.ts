import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createServices, openDatabase, openServices } from '../src';

describe('ma journée', () => {
  it("donne au vendeur ses seules ventes du jour, son objectif, sa commission et ses commandes en cours", () => {
    const s = createServices(openDatabase(':memory:'), () => new Date('2026-10-20T10:00:00'));
    const { store, register, admin } = s.admin.bootstrap({ storeCode: 'DLA1', storeName: 'Superette Akwa', adminName: 'Steve', adminLogin: 'steve', adminPin: '1234' });
    const tva = s.admin.listVatRates().find((r) => r.rate_bp === 0)?.id ?? s.admin.listVatRates()[0]!.id;
    const riz = s.catalogue.saveArticle(admin.id, { name: 'RIZ 1 KG', unit: 'piece', vatRateId: tva, purchasePrice: 700, salePrice: 1_000 });
    const ctxAdmin = { storeId: store.id, registerId: register.id, userId: admin.id };
    s.stock.receive(ctxAdmin, { warehouseId: s.admin.salesWarehouse(store.id).id, lines: [{ articleId: riz.id, qty: 50_000, unitCost: 700 }] });
    const { user: paul, staff } = s.staff.hire(ctxAdmin, { user: { name: 'Paul', login: 'paul', pin: '5678', role: 'seller', storeId: store.id, registerId: register.id }, staff: { baseSalary: 50_000, declared: false } });
    s.commissions.setTarget(ctxAdmin, staff!.id, { monthTarget: 100_000, dayTarget: 10_000, rateBp: 200 });
    const ctxPaul = { ...ctxAdmin, userId: paul.id };
    s.pos.openSession(ctxPaul, 0);
    s.pos.completeSale(ctxPaul, { lines: [{ articleId: riz.id, qty: 3_000 }], payments: [{ method: 'CASH', amount: 3_000 }] });
    const big = s.pos.completeSale(ctxPaul, { lines: [{ articleId: riz.id, qty: 2_000 }], payments: [{ method: 'CASH', amount: 2_000 }] });
    s.pos.returnSale(ctxPaul, { originalSaleId: big.id, lines: [{ lineId: big.lines[0]!.id, qty: 1_000 }], refundMethod: 'CASH', supervisorId: admin.id, reason: 'abîmé' });
    // Une vente du gérant ne compte pas pour Paul.
    s.pos.completeSale(ctxAdmin, { lines: [{ articleId: riz.id, qty: 9_000 }], payments: [{ method: 'CASH', amount: 9_000 }] });

    const d = s.commissions.myDay(store.id, paul.id);
    expect(d).toMatchObject({ sales: 5_000, returns: -1_000, net: 4_000, tickets: 2, average: 2_500, open_orders: 0 });
    expect(d.target).toMatchObject({ day_target: 10_000, day_sales: 4_000, day_rate: 40, month_rate: 4, commission: 80 });
    expect(s.commissions.myDay(store.id, admin.id)).toMatchObject({ net: 9_000, tickets: 1, target: null });
  });
});

describe('mode formation', () => {
  it("vend dans une copie de la boutique sans rien envoyer ni pouvoir la rapporter", async () => {
    const root = mkdtempSync(join(tmpdir(), 'fedonix-formation-'));
    const clock = () => new Date('2026-10-20T09:00:00');
    const s = openServices(join(root, 'superette.db'), clock);
    const { store, register, admin } = s.admin.bootstrap({ storeCode: 'DLA1', storeName: 'Superette Akwa', adminName: 'Steve', adminLogin: 'steve', adminPin: '1234' });
    const ctx = { storeId: store.id, registerId: register.id, userId: admin.id };
    const tva = s.admin.listVatRates()[0]!.id;
    const savon = s.catalogue.saveArticle(admin.id, { name: 'Savon Azur', unit: 'piece', vatRateId: tva, purchasePrice: 0, salePrice: 400 });
    s.stock.receive(ctx, { warehouseId: s.admin.salesWarehouse(store.id).id, lines: [{ articleId: savon.id, qty: 10_000, unitCost: 250 }] });

    const info = await s.fiches.export(admin, 'formation', join(root, 'Formation'), '0.69.0', { name: 'Formation-DLA1.fedonix', log: false, origin: join(root, 'superette.db') });
    expect(info.fiche).toMatchObject({ kind: 'formation', origin: join(root, 'superette.db') });

    const t = openServices(info.file, clock);
    expect(t.license.status()).toMatchObject({ state: 'fiche', canSell: true });
    expect(t.license.status().message).toMatch(/MODE FORMATION/);
    expect(t.db.prepare('SELECT COUNT(*) FROM outbox').pluck().get()).toBe(0);
    t.pos.openSession(ctx, 0);
    t.pos.completeSale(ctx, { lines: [{ articleId: savon.id, qty: 2_000 }], payments: [{ method: 'CASH', amount: 800 }] });
    expect(t.admin.storeSettings(store.id).ticketHeader).toMatch(/FORMATION/);
    expect(t.sync.credentials()).toBeNull();
    t.db.close();

    // La boutique n'a rien vu et refuse de « rapporter » une copie de formation.
    expect(s.db.prepare('SELECT COUNT(*) FROM sales').pluck().get()).toBe(0);
    expect(() => s.fiches.bringBack(admin.id, info.file)).toThrow(/formation/);
  });
});
