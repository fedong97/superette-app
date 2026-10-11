import { beforeEach, describe, expect, it } from 'vitest';
import { type Context, type Services, createServices, openDatabase } from '../src';

let now = new Date('2026-10-01T08:00:00Z');
const clock = () => now;

let s: Services;
let ctx: Context;
let boissons: string;
let epicerie: string;
let castel: string;
let riz: string;
let mballa: string;
let etoundi: string;

beforeEach(() => {
  now = new Date('2026-10-01T08:00:00Z');
  s = createServices(openDatabase(':memory:'), clock);
  const { store, register, admin } = s.admin.bootstrap({ storeCode: 'DLA1', storeName: 'Superette Akwa', adminName: 'Steve', adminLogin: 'steve', adminPin: '1234' });
  ctx = { storeId: store.id, registerId: register.id, userId: admin.id };
  const tva = s.admin.listVatRates()[0]!.id;
  const dep = s.catalogue.createDepartment('Alimentation').id;
  boissons = s.catalogue.createFamily(dep, 'Boissons').id;
  epicerie = s.catalogue.createFamily(dep, 'Épicerie').id;
  castel = s.catalogue.saveArticle(admin.id, { name: 'Castel 65 cl', unit: 'piece', vatRateId: tva, purchasePrice: 500, salePrice: 1_000, familyId: boissons }).id;
  riz = s.catalogue.saveArticle(admin.id, { name: 'Riz 5 kg', unit: 'piece', vatRateId: tva, purchasePrice: 3_000, salePrice: 5_000, familyId: epicerie }).id;
  s.stock.receive(ctx, { warehouseId: s.admin.salesWarehouse(store.id).id, lines: [{ articleId: castel, qty: 500_000, unitCost: 500 }, { articleId: riz, qty: 100_000, unitCost: 3_000 }] });
  mballa = s.customers.saveCustomer(ctx.userId, { name: 'Bar Chez Mballa', creditLimit: 1_000_000 }).id;
  etoundi = s.customers.saveCustomer(ctx.userId, { name: 'M. Etoundi', creditLimit: 1_000_000 }).id;
  s.pos.openSession(ctx, 10_000);
});

const sell = (customerId: string, articleId: string, units: number, unitPrice: number) =>
  s.pos.completeSale(ctx, { lines: [{ articleId, qty: units * 1000 }], payments: [{ method: 'CASH', amount: units * unitPrice }], customerId });

describe('ristournes des clients spécifiques', () => {
  it('calcule taux, montant par unité, quantité minimale et frais d’enlèvement ; le réglage du client remplace la base', () => {
    s.rebates.saveRules(ctx, null, [
      { familyId: boissons, rateBp: 0, unitAmount: 50, minQty: 100_000, pickupFee: 10 },
      { familyId: null, rateBp: 200, unitAmount: 0, minQty: 0, pickupFee: 0 },
    ]);
    s.rebates.setCustomer(ctx, mballa, { enabled: true, delivered: true });
    s.rebates.setCustomer(ctx, etoundi, { enabled: true, delivered: false });
    sell(mballa, castel, 120, 1_000);
    sell(mballa, riz, 10, 5_000);
    sell(etoundi, castel, 60, 1_000);

    const [lineCastel, lineRiz] = s.rebates.compute(ctx.storeId, mballa, '2026-10-01', '2026-10-01');
    // Castel : 120 × 50 − 120 × 10 (livré) = 4 800 ; riz : 2 % de 50 000 = 1 000 (règle « toutes familles »).
    expect(lineCastel).toMatchObject({ family_name: 'Boissons', qty: 120_000, rule: 'base', rebate: 4_800 });
    expect(lineRiz).toMatchObject({ family_name: 'Épicerie', amount: 50_000, rule: 'base', rebate: 1_000 });
    // Etoundi : 60 casiers, sous le minimum de 100.
    expect(s.rebates.compute(ctx.storeId, etoundi, '2026-10-01', '2026-10-01')[0]).toMatchObject({ qty: 60_000, rebate: 0 });

    s.rebates.saveRules(ctx, etoundi, [{ familyId: boissons, rateBp: 500, unitAmount: 0, minQty: 0, pickupFee: 0 }]);
    expect(s.rebates.compute(ctx.storeId, etoundi, '2026-10-01', '2026-10-01')[0]).toMatchObject({ rule: 'client', rebate: 3_000 });
    expect(s.rebates.customers().map((c) => [c.name, c.own_rules])).toEqual([
      ['Bar Chez Mballa', 0],
      ['M. Etoundi', 1],
    ]);
  });

  it('constate une période terminée une seule fois, puis accorde en avoir ou en espèces', () => {
    s.rebates.saveRules(ctx, null, [{ familyId: null, rateBp: 1_000, unitAmount: 0, minQty: 0, pickupFee: 0 }]);
    s.rebates.setCustomer(ctx, mballa, { enabled: true, delivered: false });
    sell(mballa, castel, 100, 1_000);
    expect(() => s.rebates.close(ctx, '2026-10-01', '2026-10-01')).toThrow(/terminée/);

    now = new Date('2026-11-02T08:00:00Z');
    expect(s.rebates.state(ctx.storeId, '2026-10-01', '2026-10-31')[0]).toMatchObject({ computed: 10_000, earned: 0, pending: 10_000 });
    expect(s.rebates.close(ctx, '2026-10-01', '2026-10-31')).toEqual([{ customer_id: mballa, amount: 10_000 }]);
    expect(() => s.rebates.close(ctx, '2026-09-15', '2026-10-05')).toThrow(/déjà constatée/);

    const state = s.rebates.state(ctx.storeId, '2026-10-01', '2026-11-30').find((r) => r.customer_id === mballa)!;
    expect(state).toMatchObject({ opening: 0, computed: 10_000, earned: 10_000, pending: 0, granted: 0, balance: 10_000 });

    // Avoir : le compte client passe au crédit.
    const credit = s.rebates.grant(ctx, mballa, 4_000, 'credit');
    expect(credit).toMatchObject({ kind: 'credit', amount: 4_000, number: expect.stringMatching(/^RI-/) });
    expect(s.customers.account(ctx.storeId, mballa).balance).toBe(-4_000);
    expect(s.customers.statement(ctx.storeId, mballa).lines.some((l) => l.kind === 'rebate')).toBe(true);

    // Espèces : il faut de l'argent en caisse centrale.
    expect(() => s.rebates.grant(ctx, mballa, 3_000, 'cash')).toThrow(/caisse centrale/);
    s.treasury.record(ctx, { kind: 'IN', nature: 'owner', amount: 20_000 });
    s.rebates.grant(ctx, mballa, 3_000, 'cash');
    expect(s.treasury.balance(ctx.storeId)).toBe(17_000);
    expect(() => s.rebates.grant(ctx, mballa, 5_000, 'credit')).toThrow(/n'a que 3.000/);

    // Régularisation et report à nouveau.
    s.rebates.adjust(ctx, mballa, -1_000, 'Casiers rendus cassés');
    expect(() => s.rebates.adjust(ctx, mballa, 500, ' ')).toThrow(/motif/);
    expect(s.rebates.balance(ctx.storeId, mballa)).toBe(2_000);
    expect(s.rebates.carryForward(ctx.storeId, '2026-11-03')).toEqual([expect.objectContaining({ customer_id: mballa, balance: 2_000 })]);
    expect(s.rebates.entries(ctx.storeId, { customerId: mballa }).map((e) => e.kind)).toEqual(['adjust', 'cash', 'credit', 'earned']);
  });

  it('passe des écritures comptables équilibrées', () => {
    s.rebates.saveRules(ctx, null, [{ familyId: null, rateBp: 1_000, unitAmount: 0, minQty: 0, pickupFee: 0 }]);
    s.rebates.setCustomer(ctx, mballa, { enabled: true, delivered: false });
    sell(mballa, castel, 100, 1_000);
    now = new Date('2026-11-02T08:00:00Z');
    s.rebates.close(ctx, '2026-10-01', '2026-10-31');
    s.rebates.grant(ctx, mballa, 4_000, 'credit');
    s.treasury.record(ctx, { kind: 'IN', nature: 'owner', amount: 20_000 });
    s.rebates.grant(ctx, mballa, 6_000, 'cash');
    const entries = s.accounting.entries(ctx.storeId).filter((e) => e.lines.some((l) => l.account.startsWith('4198')));
    expect(entries).toHaveLength(3);
    for (const e of entries) expect(e.lines.reduce((t, l) => t + l.debit - l.credit, 0)).toBe(0);
    const accounts = entries.flatMap((e) => e.lines.map((l) => l.account.slice(0, 4)));
    expect(accounts).toEqual(expect.arrayContaining(['7019', '4198', '411', '5712']));
  });
});
