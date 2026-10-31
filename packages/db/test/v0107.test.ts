import { beforeEach, describe, expect, it } from 'vitest';
import { type Context, type Services, createServices, openDatabase } from '../src';

let s: Services;
let ctx: Context;
let adminId: string;
let storeId: string;
let registerId: string;
let managerId: string;
let cashierId: string;
let sellerId: string;
let riz: string;
let now = new Date('2026-10-31T09:00:00Z');

beforeEach(() => {
  now = new Date('2026-10-31T09:00:00Z');
  s = createServices(openDatabase(':memory:'), () => now);
  const { store, register, admin } = s.admin.bootstrap({ storeCode: 'DLA1', storeName: 'Superette Akwa', adminName: 'Steve', adminLogin: 'steve', adminPin: '1234' });
  adminId = admin.id;
  storeId = store.id;
  registerId = register.id;
  managerId = s.admin.createUser(adminId, { name: 'Paul', login: 'paul', pin: '4321', role: 'manager', storeId }).id;
  cashierId = s.admin.createUser(adminId, { name: 'Awa', login: 'awa', pin: '5678', role: 'cashier', storeId }).id;
  sellerId = s.admin.createUser(adminId, { name: 'Ali', login: 'ali', pin: '8765', role: 'seller', storeId }).id;
  ctx = { storeId, registerId, userId: cashierId };
  const tva = s.admin.listVatRates()[0]!.id;
  riz = s.catalogue.saveArticle(adminId, { name: 'Riz', unit: 'piece', vatRateId: tva, purchasePrice: 700, salePrice: 1_000 }).id;
  s.stock.receive({ ...ctx, userId: adminId }, { warehouseId: s.admin.salesWarehouse(storeId).id, lines: [{ articleId: riz, qty: 100_000, unitCost: 700 }] });
});

describe('rien n’est réservé au seul gérant (0.107.0)', () => {
  it('le droit « Superviseur » rend le code d’un caissier valable comme celui du gérant', () => {
    expect(s.admin.authorizeSupervisor('4321').id).toBe(managerId);
    expect(() => s.admin.authorizeSupervisor('5678')).toThrow('Code superviseur refusé');
    s.admin.savePrivileges(adminId, cashierId, { grants: ['supervisor'], revokes: [] });
    expect(s.admin.authorizeSupervisor('5678').id).toBe(cashierId);
    // Le gérant à qui on retire le droit ne peut plus valider.
    s.admin.savePrivileges(adminId, managerId, { grants: [], revokes: ['supervisor'] });
    expect(() => s.admin.authorizeSupervisor('4321')).toThrow('Code superviseur refusé');
  });

  it('un superviseur désigné annule une vente et valide un retour comme le gérant', () => {
    s.admin.savePrivileges(adminId, sellerId, { grants: ['supervisor'], revokes: [] });
    s.pos.openSession(ctx, 5_000);
    const sale = s.pos.completeSale(ctx, { lines: [{ articleId: riz, qty: 2_000 }], payments: [{ method: 'CASH', amount: 2_000 }] });
    const ret = s.pos.returnSale(ctx, { originalSaleId: sale.id, lines: [{ lineId: sale.lines[0]!.id, qty: 1_000 }], refundMethod: 'CASH', supervisorId: sellerId, reason: 'Abîmé' });
    expect(ret.kind).toBe('return');
    const other = s.pos.completeSale(ctx, { lines: [{ articleId: riz, qty: 1_000 }], payments: [{ method: 'CASH', amount: 1_000 }] });
    expect(() => s.pos.cancelSale(ctx, other.id, cashierId, 'Erreur')).toThrow('Annulation réservée au gérant');
    expect(s.pos.cancelSale(ctx, other.id, sellerId, 'Erreur').status).toBe('cancelled');
  });

  it('le droit « crédit au-delà du plafond » laisse vendre sans code', () => {
    const jean = s.customers.saveCustomer(adminId, { name: 'JEAN', creditLimit: 1_000 });
    s.pos.openSession(ctx, 5_000);
    const sell = () => s.pos.completeSale(ctx, { customerId: jean.id, lines: [{ articleId: riz, qty: 3_000 }], payments: [{ method: 'CUSTOMER_CREDIT', amount: 3_000 }] });
    expect(sell).toThrow(/Plafond de crédit dépassé/);
    s.admin.savePrivileges(adminId, cashierId, { grants: ['credit_over'], revokes: [] });
    expect(sell().total_ttc).toBe(3_000);
  });

  it('plafond de remise : au-delà, le code reste demandé même avec le droit', () => {
    s.admin.savePrivileges(adminId, cashierId, { grants: ['discount'], revokes: [] });
    s.admin.saveLimits(adminId, cashierId, { discountPct: 10 });
    s.pos.openSession(ctx, 5_000);
    expect(s.pos.completeSale(ctx, { lines: [{ articleId: riz, qty: 10_000, discount: 1_000 }], payments: [{ method: 'CASH', amount: 9_000 }], discountReason: 'Fidélité' }).total_ttc).toBe(9_000);
    expect(() => s.pos.completeSale(ctx, { lines: [{ articleId: riz, qty: 10_000, discount: 2_000 }], payments: [{ method: 'CASH', amount: 8_000 }], discountReason: 'Fidélité' })).toThrow('plafond de 10 %');
    expect(s.admin.limits(cashierId)).toEqual({ discountPct: 10 });
  });
});

describe('délégation temporaire des pouvoirs du gérant (0.107.0)', () => {
  it('le caissier reçoit les droits du gérant jusqu’à la date de fin, puis tout revient', () => {
    expect(s.admin.hasRight(s.admin.getUser(cashierId), 'supervisor')).toBe(false);
    const d = s.admin.delegate(managerId, cashierId, '2026-11-02T18:00:00Z');
    expect(d.byName).toBe('Paul');
    expect(d.rights).not.toContain('delegate');
    // Le droit se calcule à l'heure du PC : la délégation court.
    const cashier = s.admin.getUser(cashierId);
    expect(s.admin.hasRight(cashier, 'supervisor')).toBe(true);
    expect(s.admin.hasRight(cashier, 'delegate')).toBe(false);
    expect(s.admin.authorizeSupervisor('5678').id).toBe(cashierId);
    expect(s.admin.delegations().map((x) => x.userName)).toEqual(['Awa']);
    // Les privilèges personnels enregistrés ensuite gardent la délégation.
    s.admin.savePrivileges(adminId, cashierId, { grants: ['labels'], revokes: [] });
    expect(s.admin.privileges(cashierId).delegation?.by).toBe(managerId);
    s.admin.endDelegation(managerId, cashierId);
    expect(s.admin.hasRight(cashier, 'supervisor')).toBe(false);
    expect(s.admin.delegations()).toEqual([]);
  });

  it('refuse une délégation passée, à soi-même, ou sans le droit', () => {
    expect(() => s.admin.delegate(managerId, cashierId, '2020-01-01T00:00:00Z')).toThrow('dans le futur');
    expect(() => s.admin.delegate(managerId, managerId, '2026-11-02T18:00:00Z')).toThrow('autre utilisateur');
    expect(() => s.admin.delegate(sellerId, cashierId, '2026-11-02T18:00:00Z')).toThrow("pas le droit");
  });

  it('une délégation échue ne donne plus rien', () => {
    s.admin.delegate(managerId, cashierId, new Date(Date.now() + 60_000).toISOString());
    expect(s.admin.hasRight(s.admin.getUser(cashierId), 'supervisor')).toBe(true);
    const p = s.admin.privileges(cashierId);
    p.delegation!.until = new Date(Date.now() - 1_000).toISOString();
    s.db.prepare('UPDATE user_rights SET delegation = ? WHERE id = ?').run(JSON.stringify(p.delegation), cashierId);
    expect(s.admin.hasRight(s.admin.getUser(cashierId), 'supervisor')).toBe(false);
  });
});
