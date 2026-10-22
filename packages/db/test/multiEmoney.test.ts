import { beforeEach, describe, expect, it } from 'vitest';
import { type Context, type Services, createServices, openDatabase } from '../src';

let s: Services;
let ctx: Context;
let riz: string;
let adminId: string;
let mtn: string;
let orange: string;
let awa: string;

beforeEach(() => {
  s = createServices(openDatabase(':memory:'), () => new Date('2026-10-22T09:00:00Z'));
  const { store, register, admin } = s.admin.bootstrap({ storeCode: 'DLA1', storeName: 'Superette Akwa', adminName: 'Steve', adminLogin: 'steve', adminPin: '1234' });
  adminId = admin.id;
  const tva = s.admin.listVatRates()[0]!.id;
  riz = s.catalogue.saveArticle(admin.id, { name: 'Riz 5 kg', unit: 'piece', vatRateId: tva, purchasePrice: 3_000, salePrice: 5_000 }).id;
  s.stock.receive({ storeId: store.id, registerId: register.id, userId: admin.id }, { warehouseId: s.admin.salesWarehouse(store.id).id, lines: [{ articleId: riz, qty: 20_000, unitCost: 3_000 }] });
  mtn = s.admin.createRegister(adminId, store.id, 'Mobile MTN', 'electronic').id;
  orange = s.admin.createRegister(adminId, store.id, 'Mobile Orange', 'electronic').id;
  awa = s.admin.createUser(adminId, { name: 'Awa', login: 'awa', pin: '5555', role: 'cashier', storeId: store.id, registerId: register.id }).id;
  ctx = { storeId: store.id, registerId: register.id, userId: awa };
});

const sell = (method: 'CASH' | 'MTN_MOMO' | 'ORANGE_MONEY' | 'CARD') =>
  s.pos.completeSale(ctx, { lines: [{ articleId: riz, qty: 1000 }], payments: [{ method, amount: 5_000, reference: method === 'CASH' ? undefined : 'REF1' }] });

describe('plusieurs caisses électroniques par utilisateur', () => {
  it('refuse deux caisses qui reçoivent le même moyen', () => {
    expect(() => s.admin.updateUser(adminId, awa, { emoneyRegisterIds: [mtn, orange] })).toThrow(/reçoivent toutes les deux MTN Mobile Money/);
    s.admin.updateRegister(adminId, mtn, { methods: ['MTN_MOMO', 'CARD'] });
    s.admin.updateRegister(adminId, orange, { methods: ['ORANGE_MONEY'] });
    expect(s.admin.updateUser(adminId, awa, { emoneyRegisterIds: [mtn, orange] })).toMatchObject({ emoney_register_id: mtn, emoney_register_ids: JSON.stringify([mtn, orange]) });
    // Une fois attribuées, une caisse ne peut pas prendre le moyen de l'autre.
    expect(() => s.admin.updateRegister(adminId, orange, { methods: ['ORANGE_MONEY', 'CARD'] })).toThrow(/carte bancaire/i);
    expect(() => s.admin.updateRegister(adminId, orange, { methods: [] })).toThrow(/au moins un moyen/);
    expect(s.admin.getRegister(orange).methods).toBe('ORANGE_MONEY');
    // Tous les moyens cochés : la caisse les reçoit tous (valeur vide).
    s.admin.updateUser(adminId, awa, { emoneyRegisterIds: [mtn] });
    s.admin.updateRegister(adminId, mtn, { methods: ['MTN_MOMO', 'ORANGE_MONEY', 'CARD'] });
    expect(s.admin.getRegister(mtn).methods).toBeNull();
  });

  it('chaque paiement va dans la caisse qui reçoit son moyen ; toutes s’ouvrent et se clôturent', () => {
    s.admin.updateRegister(adminId, mtn, { methods: ['MTN_MOMO', 'CARD'] });
    s.admin.updateRegister(adminId, orange, { methods: ['ORANGE_MONEY'] });
    s.admin.updateUser(adminId, awa, { emoneyRegisterIds: [mtn, orange] });
    expect(s.pos.linkedRegisters(awa)).toEqual({ electronic: [mtn, orange], bank: null });
    expect(s.pos.registerFor(awa, 'ORANGE_MONEY')).toBe(orange);
    expect(s.pos.registerFor(awa, 'CARD')).toBe(mtn);

    s.pos.openSession(ctx, 0);
    const mtnDay = s.pos.currentSession(mtn)!;
    const orangeDay = s.pos.currentSession(orange)!;
    expect(mtnDay).toMatchObject({ user_id: awa });
    expect(orangeDay).toMatchObject({ user_id: awa });

    sell('MTN_MOMO');
    sell('ORANGE_MONEY');
    sell('CARD');
    const expected = (id: string) => Object.fromEntries(s.pos.zReport(id).declared!.map((d) => [d.method, d.expected]));
    expect(expected(mtnDay.id)).toEqual({ MTN_MOMO: 5_000, ORANGE_MONEY: 0, CARD: 5_000 });
    expect(expected(orangeDay.id)).toEqual({ MTN_MOMO: 0, ORANGE_MONEY: 5_000, CARD: 0 });

    s.pos.closeDeclared(ctx, orange, { ORANGE_MONEY: 5_000 });
    expect(s.pos.currentSession(orange)).toBeNull();
    expect(s.pos.currentSession(mtn)).not.toBeNull();
    // Rouvrir après une clôture en cours de journée : seule la caisse fermée repart.
    expect(s.pos.openLinked(ctx).map((se) => se.register_id)).toEqual([orange]);
  });

  it('un moyen reçu par aucune de ses caisses reste dans la caisse espèces', () => {
    s.admin.updateRegister(adminId, mtn, { methods: ['MTN_MOMO'] });
    s.admin.updateUser(adminId, awa, { emoneyRegisterIds: [mtn] });
    s.pos.openSession(ctx, 0);
    const sale = sell('ORANGE_MONEY');
    expect(s.pos.zReport(s.pos.currentSession(ctx.registerId!)!.id).byMethod.map((m) => m.method)).toContain('ORANGE_MONEY');
    expect(sale).toBeTruthy();
  });

  it('copier un employé garde ses caisses électroniques', () => {
    s.admin.updateRegister(adminId, mtn, { methods: ['MTN_MOMO'] });
    s.admin.updateRegister(adminId, orange, { methods: ['ORANGE_MONEY'] });
    s.admin.updateUser(adminId, awa, { emoneyRegisterIds: [mtn, orange] });
    const copy = s.admin.copyUser(adminId, awa, { name: 'Binta', login: 'binta', pin: '5678' });
    expect(s.pos.linkedRegisters(copy.id).electronic).toEqual([mtn, orange]);
  });
});
