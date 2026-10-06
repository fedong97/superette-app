import { beforeEach, describe, expect, it } from 'vitest';
import { type Context, type Services, createServices, openDatabase } from '../src';

let now = new Date('2026-10-06T08:00:00Z');
const clock = () => now;

let s: Services;
let ctx: Context;
let riz: string;

beforeEach(() => {
  now = new Date('2026-10-06T08:00:00Z');
  s = createServices(openDatabase(':memory:'), clock);
  const { store, register, admin } = s.admin.bootstrap({ storeCode: 'DLA1', storeName: 'Superette Akwa', adminName: 'Steve', adminLogin: 'steve', adminPin: '1234' });
  ctx = { storeId: store.id, registerId: register.id, userId: admin.id };
  const tva = s.admin.listVatRates().find((r) => r.rate_bp === 1925)!.id;
  riz = s.catalogue.saveArticle(admin.id, { name: 'Riz 5 kg', unit: 'piece', vatRateId: tva, purchasePrice: 3_000, salePrice: 5_000 }).id;
  s.stock.receive(ctx, { warehouseId: s.admin.salesWarehouse(store.id).id, lines: [{ articleId: riz, qty: 100_000, unitCost: 3_000 }] });
});

describe('dépenses', () => {
  it('une sortie de caisse diminue les espèces attendues au Z et passe en comptabilité', () => {
    s.pos.openSession(ctx, 20_000);
    s.pos.completeSale(ctx, { lines: [{ articleId: riz, qty: 4000 }], payments: [{ method: 'CASH', amount: 20_000 }] });
    expect(() => s.expenses.record(ctx, { categoryId: 'cat-transport', label: 'Taxi livraison', amount: 2_000, method: 'MTN_MOMO', reference: 'MP1', atRegister: true })).toThrow('espèces');
    const taxi = s.expenses.record(ctx, { categoryId: 'cat-transport', label: 'Taxi livraison', beneficiary: 'Moto-taxi', amount: 2_000, method: 'CASH', atRegister: true });
    expect(taxi).toMatchObject({ number: 'DEP-DLA11-00001', account_id: '618', category_name: 'Transport et carburant', expense_date: '2026-10-06' });
    const sacs = s.expenses.record(ctx, { categoryId: 'cat-emballages', label: 'Sacs plastiques', amount: 3_500, method: 'CASH', atRegister: true });
    const session = s.pos.currentSession(ctx.registerId!)!;
    expect(s.pos.zReport(session.id).cash).toMatchObject({ expenses: 5_500, expected: 20_000 + 20_000 - 5_500 });

    s.expenses.cancel(ctx, sacs.id, ctx.userId, 'Saisie en double');
    expect(s.pos.zReport(session.id).expenses.map((e) => e.number)).toEqual([taxi.number]);
    const z = s.pos.closeSession(ctx, { 10000: 3, 5000: 1, 2000: 1, 1000: 1 });
    expect(z.difference).toBe(0);
    expect(() => s.expenses.cancel(ctx, taxi.id, ctx.userId, 'Erreur')).toThrow('clôturé');

    const entry = s.accounting.entries(ctx.storeId, { journal: 'CA' }).find((e) => e.ref === taxi.number)!;
    expect(entry.lines).toMatchObject([
      { account: '618', debit: 2_000 },
      { account: '571', credit: 2_000 },
    ]);
    expect(s.accounting.entries(ctx.storeId).some((e) => e.ref === sacs.number)).toBe(false);
    // Caisse : 20 000 de ventes moins 2 000 de taxi (le fond de caisse n'est pas compté).
    expect(s.accounting.treasury(ctx.storeId).find((t) => t.account === '571')!.balance).toBe(18_000);
  });

  it('la TVA des factures de dépenses est déductible', () => {
    expect(() => s.expenses.record(ctx, { categoryId: 'cat-eneo', label: 'ENEO', amount: 59_625, vat: 9_625, method: 'ORANGE_MONEY' })).toThrow('Référence');
    expect(() => s.expenses.record(ctx, { categoryId: 'cat-eneo', label: 'ENEO', amount: 5_000, vat: 5_000, method: 'CASH' })).toThrow('TVA');
    expect(() => s.expenses.record(ctx, { categoryId: 'cat-eneo', label: 'ENEO', amount: 5_000, method: 'CASH', date: '2026-10-07' })).toThrow('futur');
    const eneo = s.expenses.record(ctx, { categoryId: 'cat-eneo', label: 'Facture ENEO septembre', amount: 59_625, vat: 9_625, method: 'ORANGE_MONEY', reference: 'OM261006.1', date: '2026-10-05' });
    s.expenses.record(ctx, { categoryId: 'cat-loyer', label: 'Loyer octobre', amount: 150_000, method: 'BANK_TRANSFER', reference: 'VIR-1006' });
    const entry = s.accounting.entries(ctx.storeId).find((e) => e.ref === eneo.number)!;
    expect(entry).toMatchObject({ journal: 'MM' });
    expect(entry.lines.map((l) => [l.account, l.debit, l.credit])).toEqual([
      ['6052', 50_000, 0],
      ['4452', 9_625, 0],
      ['5522', 0, 59_625],
    ]);
    const vat = s.accounting.vatReturn(ctx.storeId, '2026-10');
    expect(vat).toMatchObject({ deductible: 9_625, expensesVat: 9_625, expensesHt: 200_000, expenseCount: 1, credit: 9_625 });
    expect(s.accounting.vatReturn(ctx.storeId, '2026-11').previousCredit).toBe(9_625);

    const sum = s.expenses.summary(ctx.storeId, { from: '2026-10-01', to: '2026-10-31' });
    expect(sum.total).toBe(209_625);
    expect(sum.byCategory.map((c) => c.name)).toEqual(['Loyer', 'Électricité et eau (ENEO, CDE)']);
    expect(sum.byMethod.map((m) => m.label)).toEqual(['Virement', 'Orange Money']);
  });

  it('les catégories passent sur un compte de charges et gardent le compte des dépenses passées', () => {
    const old = s.expenses.record(ctx, { categoryId: 'cat-divers', label: 'Pain pour le personnel', amount: 1_000, method: 'CASH' });
    expect(() => s.expenses.saveCategory(ctx.userId, { id: 'cat-divers', name: 'Divers', accountId: '571' })).toThrow('classe 6');
    s.expenses.saveCategory(ctx.userId, { id: 'cat-divers', name: 'Divers', accountId: '638' });
    const fresh = s.expenses.record(ctx, { categoryId: 'cat-divers', label: 'Nettoyage', amount: 2_000, method: 'CASH' });
    expect([s.expenses.get(old.id).account_id, fresh.account_id]).toEqual(['658', '638']);
    const cat = s.expenses.saveCategory(ctx.userId, { name: 'Publicité', accountId: '638' });
    expect(s.expenses.listCategories().some((c) => c.id === cat.id)).toBe(true);
    s.expenses.saveCategory(ctx.userId, { id: cat.id, name: 'Publicité', accountId: '638', active: false });
    expect(() => s.expenses.record(ctx, { categoryId: cat.id, label: 'Affiches', amount: 1_000, method: 'CASH' })).toThrow('catégorie');
  });
});
