import { beforeEach, describe, expect, it } from 'vitest';
import { type Context, type Services, createServices, openDatabase } from '../src';

let s: Services;
let ctx: Context;
let riz: string;
let adminId: string;
let storeId: string;
let mobile: string;
let centrale: string;
let awa: string;
let category: string;
let now = new Date('2026-10-11T09:00:00Z');

beforeEach(() => {
  now = new Date('2026-10-11T09:00:00Z');
  s = createServices(openDatabase(':memory:'), () => now);
  const { store, register, admin } = s.admin.bootstrap({ storeCode: 'DLA1', storeName: 'Superette Akwa', adminName: 'Steve', adminLogin: 'steve', adminPin: '1234' });
  adminId = admin.id;
  storeId = store.id;
  const tva = s.admin.listVatRates()[0]!.id;
  riz = s.catalogue.saveArticle(admin.id, { name: 'Riz 5 kg', unit: 'piece', vatRateId: tva, purchasePrice: 3_000, salePrice: 5_000 }).id;
  s.stock.receive({ storeId, registerId: register.id, userId: admin.id }, { warehouseId: s.admin.salesWarehouse(storeId).id, lines: [{ articleId: riz, qty: 50_000, unitCost: 3_000 }] });
  mobile = s.admin.createRegister(adminId, storeId, 'Mobile Awa', 'electronic').id;
  centrale = s.admin.createRegister(adminId, storeId, 'MoMo magasin', 'electronic').id;
  awa = s.admin.createUser(adminId, { name: 'Awa', login: 'awa', pin: '5555', role: 'cashier', storeId, registerId: register.id, emoneyRegisterId: mobile }).id;
  ctx = { storeId, registerId: register.id, userId: awa };
  category = s.expenses.listCategories()[0]!.id;
});

const later = (minutes: number) => {
  now = new Date(now.getTime() + minutes * 60_000);
};
const sell = (payments: { method: 'CASH' | 'MTN_MOMO' | 'ORANGE_MONEY'; amount: number; reference?: string }[], qty = 1) =>
  s.pos.completeSale(ctx, { lines: [{ articleId: riz, qty: qty * 1000 }], payments });
const phoneExpense = (amount: number) =>
  s.expenses.record(ctx, { categoryId: category, label: 'Crédit téléphone', amount, method: 'MTN_MOMO', reference: 'MP-DEP', atRegister: true });
const useCentral = () => s.admin.saveStoreSettings(adminId, storeId, { emoneyMode: 'central', emoneyCentralRegisterId: centrale });
const line = (z: { declared: { method: string }[] | null }, m: string) => z.declared!.find((d) => d.method === m)!;

describe('caisses électroniques', () => {
  it('le journal montre ventes, remboursement et dépense MoMo ; l’attendu en tient compte', () => {
    s.pos.openSession(ctx, 0);
    const day = s.pos.currentSession(mobile)!;
    later(1);
    const sale = sell([{ method: 'MTN_MOMO', amount: 15_000, reference: 'MP1' }], 3);
    later(1);
    s.pos.returnSale(ctx, { originalSaleId: sale.id, lines: [{ lineId: s.pos.getSale(sale.id).lines[0]!.id as never, qty: 1_000 }], refundMethod: 'MTN_MOMO', supervisorId: adminId, reason: 'Sac abîmé' });
    later(1);
    phoneExpense(500);

    const z = s.pos.zReport(day.id);
    expect(z.emoneyJournal!.entries.map((e) => [e.nature, e.amount])).toEqual([['Vente', 15_000]]);
    expect(z.emoneyJournal!.exits.map((e) => [e.nature, e.amount])).toEqual([
      ['Remboursement', 5_000],
      ['Dépense', 500],
    ]);
    expect(line(z, 'MTN_MOMO')).toMatchObject({ opening: 0, received: 10_000, outflows: 500, expected: 9_500 });

    // Le téléphone montre 9 500 : pas d'écart.
    const closed = s.pos.closeDeclared(ctx, mobile, { MTN_MOMO: 9_500 });
    expect(closed.session.difference).toBe(0);
    // La sortie d'espèces n'est pas touchée.
    expect(s.pos.zReport(s.pos.listSessions(storeId, 5, ctx.registerId).at(0)!.id).cash.expenses).toBe(0);
  });

  it('refuse une dépense MoMo à la caisse sans caisse électronique, et l’espèces reste au tiroir', () => {
    s.pos.openSession(ctx, 1_000);
    s.admin.updateUser(adminId, awa, { emoneyRegisterId: null });
    expect(() => phoneExpense(500)).toThrow(/pas de caisse électronique/);
    const e = s.expenses.record(ctx, { categoryId: category, label: 'Taxi', amount: 500, method: 'CASH', atRegister: true });
    expect(e.register_id).toBe(ctx.registerId);
  });

  it('mode centrale : versement avec référence, reste repris le lendemain, centrale créditée', () => {
    useCentral();
    s.pos.openSession(ctx, 0);
    later(1);
    sell([{ method: 'MTN_MOMO', amount: 10_000, reference: 'MP1' }], 2);
    sell([{ method: 'ORANGE_MONEY', amount: 5_000, reference: 'OM1' }]);
    later(1);
    expect(() => s.pos.closeDeclared(ctx, mobile, { MTN_MOMO: 10_000, ORANGE_MONEY: 5_000 }, { deposit: { MTN_MOMO: { amount: 9_000 } } })).toThrow(/référence/);
    expect(() => s.pos.closeDeclared(ctx, mobile, { MTN_MOMO: 10_000, ORANGE_MONEY: 5_000 }, { deposit: { MTN_MOMO: { amount: 11_000, reference: 'X' } } })).toThrow(/dépasse/);
    const z = s.pos.closeDeclared(ctx, mobile, { MTN_MOMO: 10_000, ORANGE_MONEY: 5_000 }, {
      deposit: { MTN_MOMO: { amount: 9_000, reference: 'MP-V1' }, ORANGE_MONEY: { amount: 5_000, reference: 'OM-V1' } },
    });
    expect(z.session.difference).toBe(0);
    expect(line(z, 'MTN_MOMO')).toMatchObject({ declared: 10_000, deposited: 9_000, left: 1_000 });
    expect(z.emoneyDeposit).toMatchObject({ centralName: 'MoMo magasin' });
    // Le versement apparaît dans les sorties, sans changer l'attendu.
    expect(z.emoneyJournal!.exits.filter((e) => e.closing).map((e) => [e.method, e.amount])).toEqual([
      ['MTN_MOMO', 9_000],
      ['ORANGE_MONEY', 5_000],
    ]);
    expect(s.emoney.balance(centrale)).toMatchObject({ MTN_MOMO: 9_000, ORANGE_MONEY: 5_000 });

    // Le lendemain, la caisse d'Awa repart avec son reste.
    later(60 * 14);
    s.pos.closeSession(ctx, {} as never);
    s.pos.openSession(ctx, 0);
    const z2 = s.pos.zReport(s.pos.currentSession(mobile)!.id);
    expect(line(z2, 'MTN_MOMO')).toMatchObject({ opening: 1_000, expected: 1_000 });
    expect(line(z2, 'ORANGE_MONEY')).toMatchObject({ opening: 0 });
  });

  it('mode indépendant : le solde passe d’un jour à l’autre', () => {
    s.admin.saveStoreSettings(adminId, storeId, { emoneyMode: 'independent' });
    s.pos.openSession(ctx, 0);
    sell([{ method: 'MTN_MOMO', amount: 5_000, reference: 'MP1' }]);
    expect(() => s.pos.closeDeclared(ctx, mobile, { MTN_MOMO: 5_000 }, { deposit: { MTN_MOMO: { amount: 5_000, reference: 'X' } } })).toThrow(/centrale/);
    s.pos.closeDeclared(ctx, mobile, { MTN_MOMO: 5_000 });
    later(10);
    // Dépense payée au bureau depuis la caisse d'Awa fermée : elle sort du solde de départ.
    const internet = s.expenses.record({ storeId, registerId: null, userId: adminId }, { categoryId: category, label: 'Internet', amount: 2_000, method: 'MTN_MOMO', reference: 'MP-B', registerId: mobile });
    later(60 * 14);
    s.pos.closeSession(ctx, {} as never);
    s.pos.openSession(ctx, 0);
    sell([{ method: 'MTN_MOMO', amount: 5_000, reference: 'MP2' }]);
    const z = s.pos.zReport(s.pos.currentSession(mobile)!.id);
    expect(line(z, 'MTN_MOMO')).toMatchObject({ opening: 3_000, received: 5_000, expected: 8_000 });
    // Déjà comptée dans le solde de départ : elle ne s'annule plus.
    expect(() => s.expenses.cancel(ctx, internet.id, adminId, 'Erreur')).toThrow(/ouverte depuis/);
  });

  it('la caisse centrale ne s’attribue pas ; dépenses et fournisseurs au bureau en sortent ; mouvements du gérant', () => {
    useCentral();
    expect(() => s.admin.updateUser(adminId, awa, { emoneyRegisterId: centrale })).toThrow(/centrale/);
    expect(() => s.admin.saveStoreSettings(adminId, storeId, { emoneyCentralRegisterId: mobile })).toThrow();
    const office = { storeId, registerId: null, userId: adminId };
    s.emoney.record(office, { registerId: centrale, direction: 'IN', nature: 'other', method: 'MTN_MOMO', amount: 50_000, label: 'Solde de départ' });
    s.expenses.record(office, { categoryId: category, label: 'ENEO', amount: 12_000, method: 'MTN_MOMO', reference: 'MP-E' });
    expect(() => s.emoney.record(office, { registerId: centrale, direction: 'OUT', nature: 'bank', method: 'MTN_MOMO', amount: 10_000 })).toThrow(/référence/);
    s.emoney.record(office, { registerId: centrale, direction: 'OUT', nature: 'bank', method: 'MTN_MOMO', amount: 10_000, reference: 'RB-1' });
    s.emoney.record(office, { registerId: centrale, direction: 'OUT', nature: 'register', method: 'MTN_MOMO', amount: 3_000, reference: 'TR-1', toRegisterId: mobile });
    expect(s.emoney.balance(centrale).MTN_MOMO).toBe(25_000);
    expect(s.emoney.balance(mobile).MTN_MOMO).toBe(3_000);
    const ledger = s.emoney.ledger(centrale);
    expect(ledger.rows.map((r) => [r.nature, r.signed, r.balance])).toEqual([
      ['Transfert', -3_000, 25_000],
      ['Banque', -10_000, 28_000],
      ['Dépense', -12_000, 38_000],
      ['Autre', 50_000, 50_000],
    ]);
    // Dépôt à la banque passé en comptabilité ; le transfert entre caisses électroniques non.
    const entries = s.accounting.entries(storeId).filter((e) => e.ref.startsWith('VE-'));
    expect(entries.map((e) => e.journal).sort()).toEqual(['BQ', 'CA']);
  });
});
