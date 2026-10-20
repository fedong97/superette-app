import { describe, expect, it } from 'vitest';
import { createServices, openDatabase } from '../src';

describe("relève d'équipe", () => {
  it('note le comptage de chacun, garde une seule journée et détaille le Z par caissier', () => {
    let now = new Date('2026-10-20T08:00:00');
    const s = createServices(openDatabase(':memory:'), () => now);
    const { store, register, admin } = s.admin.bootstrap({ storeCode: 'DLA1', storeName: 'Superette Akwa', adminName: 'Steve', adminLogin: 'steve', adminPin: '1234' });
    const tva = s.admin.listVatRates()[0]!.id;
    const ctxAdmin = { storeId: store.id, registerId: register.id, userId: admin.id };
    const riz = s.catalogue.saveArticle(admin.id, { name: 'RIZ 1 KG', unit: 'piece', vatRateId: tva, purchasePrice: 700, salePrice: 1_000 });
    s.stock.receive(ctxAdmin, { warehouseId: s.admin.salesWarehouse(store.id).id, lines: [{ articleId: riz.id, qty: 50_000, unitCost: 700 }] });
    const awa = s.admin.createUser(admin.id, { name: 'Awa', login: 'awa', pin: '5678', role: 'cashier', storeId: store.id, registerId: register.id });
    const ben = s.admin.createUser(admin.id, { name: 'Ben', login: 'ben', pin: '5678', role: 'cashier', storeId: store.id, registerId: register.id });
    const ctxAwa = { ...ctxAdmin, userId: awa.id };
    const ctxBen = { ...ctxAdmin, userId: ben.id };

    const session = s.pos.openSession(ctxAwa, 10_000);
    s.pos.completeSale(ctxAwa, { lines: [{ articleId: riz.id, qty: 3_000 }], payments: [{ method: 'CASH', amount: 3_000 }] });
    // Awa part à 14 h : 13 000 attendus, 12 500 comptés.
    now = new Date('2026-10-20T14:00:00');
    expect(() => s.pos.handover(ctxAwa, { 10000: 1 }, awa.id)).toThrow(/différents/);
    const h = s.pos.handover(ctxAwa, { 10000: 1, 2000: 1, 500: 1 }, ben.id);
    expect(h).toMatchObject({ number: 1, from_name: 'Awa', to_name: 'Ben', expected: 13_000, counted: 12_500, difference: -500 });
    expect(s.receipts.handoverSlip(h.id).some((l) => 'text' in l && /PASSATION/.test(l.text))).toBe(true);

    // Ben vend sur la même journée, puis ferme : le tiroir garde le manque d'Awa, Ben est juste.
    expect(s.pos.currentSession(register.id)!.id).toBe(session.id);
    s.pos.completeSale(ctxBen, { lines: [{ articleId: riz.id, qty: 2_000 }], payments: [{ method: 'CASH', amount: 2_000 }] });
    now = new Date('2026-10-20T20:00:00');
    const z = s.pos.closeSession(ctxBen, { 10000: 1, 2000: 2, 500: 1 }, { floatLeft: 10_000 });
    expect(z.difference).toBe(-500);
    expect(z.session.z_number).toBe(1);
    expect(z.handovers).toHaveLength(1);
    expect(z.byCashier).toEqual([
      { user_id: awa.id, name: 'Awa', tickets: 1, net: 3_000, difference: -500 },
      { user_id: ben.id, name: 'Ben', tickets: 1, net: 2_000, difference: 0 },
    ]);
    expect(s.receipts.zReport(session.id).some((l) => 'text' in l && /Par caissier/.test(l.text))).toBe(true);
    expect(s.db.prepare("SELECT COUNT(*) FROM outbox WHERE entity = 'cash_handover'").pluck().get()).toBe(1);
  });
});
