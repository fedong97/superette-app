import { beforeEach, describe, expect, it } from 'vitest';
import { type Context, type Services, createServices, openDatabase } from '../src';

let s: Services;
let ctx: Context;
let tva: string;
let now: Date;
let shop: string;
let castel: string;
let lait: string;

const later = (minutes: number) => {
  now = new Date(now.getTime() + minutes * 60_000);
};

beforeEach(() => {
  now = new Date('2026-10-12T09:00:00Z');
  s = createServices(openDatabase(':memory:'), () => now);
  const { store, register, admin } = s.admin.bootstrap({ storeCode: 'DLA1', storeName: 'Superette Akwa', adminName: 'Steve', adminLogin: 'steve', adminPin: '1234' });
  ctx = { storeId: store.id, registerId: register.id, userId: admin.id };
  tva = s.admin.listVatRates().find((r) => r.rate_bp === 1925)!.id;
  shop = s.admin.salesWarehouse(store.id).id;
  const boissons = s.catalogue.createFamily(s.catalogue.createDepartment('Boissons').id, 'Bières').id;
  const frais = s.catalogue.createFamily(s.catalogue.createDepartment('Frais').id, 'Laitages').id;
  castel = s.catalogue.saveArticle(admin.id, { name: 'Castel 65 cl', unit: 'piece', vatRateId: tva, purchasePrice: 450, salePrice: 650, familyId: boissons }).id;
  lait = s.catalogue.saveArticle(admin.id, { name: 'Yaourt nature', unit: 'piece', vatRateId: tva, purchasePrice: 200, salePrice: 400, familyId: frais }).id;
  s.stock.receive(ctx, { warehouseId: shop, lines: [{ articleId: castel, qty: 100_000, unitCost: 450 }] });
  s.pos.openSession(ctx, 10_000);
});

const balanceOf = (account: string) => s.accounting.trialBalance(ctx.storeId).rows.find((r) => r.account === account)?.closing ?? 0;
const expectedCash = () => s.pos.zReport(s.pos.currentSession(ctx.registerId!)!.id).cash.expected;

describe('emballages consignés', () => {
  it('encaisse la consigne au 4194, la rend au retour des vides et suit les vides et les fournisseurs', () => {
    const casier = s.containers.saveType(ctx.userId, { name: 'Casier 12', deposit: 3_000 });
    s.containers.setArticleContainer(ctx.userId, castel, casier.id, 12_000);
    expect(s.containers.needsFor([{ articleId: castel, qty: 24_000 }])).toEqual([expect.objectContaining({ container_id: casier.id, count: 2 })]);
    const client = s.customers.saveCustomer(ctx.userId, { name: 'Bar Le Calao' });
    const out = s.containers.counter(ctx, { lines: [{ containerId: casier.id, out: 2, back: 0 }], customerId: client.id });
    expect(out.net).toBe(6_000);
    expect(expectedCash()).toBe(16_000);
    expect(balanceOf('4194')).toBe(-6_000);
    expect(s.containers.atCustomers(ctx.storeId)).toEqual([expect.objectContaining({ name: 'Bar Le Calao', qty: 2, paid: 6_000 })]);
    later(10);
    const back = s.containers.counter(ctx, { lines: [{ containerId: casier.id, out: 0, back: 1 }], customerId: client.id });
    expect(back.net).toBe(-3_000);
    expect(expectedCash()).toBe(13_000);
    expect(s.containers.balances(ctx.storeId)).toEqual([expect.objectContaining({ empties: 1, at_customers: 1, deposits_held: 3_000 })]);
    const sabc = s.purchases.saveSupplier(ctx.userId, { name: 'SABC' });
    s.containers.record(ctx, { kind: 'supplier_in', containerId: casier.id, qty: 10, supplierId: sabc.id });
    expect(() => s.containers.record(ctx, { kind: 'supplier_out', containerId: casier.id, qty: 5, supplierId: sabc.id })).toThrow(/que 1/);
    s.containers.record(ctx, { kind: 'supplier_out', containerId: casier.id, qty: 1, supplierId: sabc.id });
    expect(s.containers.owedToSuppliers(ctx.storeId)).toEqual([expect.objectContaining({ supplier_name: 'SABC', qty: 9, value: 27_000 })]);
    // Annulation : l'argent ressort de la caisse et les mouvements du ticket aussi.
    s.containers.cancel(ctx, back.moves[0]!.id, 'erreur');
    expect(expectedCash()).toBe(16_000);
    expect(s.containers.balances(ctx.storeId)[0]).toMatchObject({ at_customers: 2, deposits_held: 6_000 });
  });
});

describe('point Mobile Money', () => {
  it('suit la flotte, les espèces du Z et la commission', () => {
    const mtn = s.agent.saveAccount(ctx, { name: 'MTN agent', operator: 'MTN', rates: { deposit: 50 } });
    expect(() => s.agent.record(ctx, { accountId: mtn.id, kind: 'float_in', amount: 100_000 })).toThrow(/que 10000/);
    s.agent.record(ctx, { accountId: mtn.id, kind: 'float_in', amount: 8_000 });
    expect([s.agent.float(mtn.id), expectedCash()]).toEqual([8_000, 2_000]);
    // Dépôt : le client donne 5 000 en espèces, la flotte baisse, l'opérateur verse 0,5 %.
    const dep = s.agent.record(ctx, { accountId: mtn.id, kind: 'deposit', amount: 5_000, phone: '677000000' });
    expect(dep.commission).toBe(25);
    expect([s.agent.float(mtn.id), expectedCash()]).toEqual([3_025, 7_000]);
    expect(() => s.agent.record(ctx, { accountId: mtn.id, kind: 'deposit', amount: 5_000, phone: '677000000' })).toThrow(/flotte/);
    expect(() => s.agent.record(ctx, { accountId: mtn.id, kind: 'withdrawal', amount: 9_000, phone: '677000000' })).toThrow(/espèces/);
    s.agent.record(ctx, { accountId: mtn.id, kind: 'withdrawal', amount: 2_000, phone: '677000001' });
    expect([s.agent.float(mtn.id), expectedCash()]).toEqual([5_025, 5_000]);
    expect(balanceOf('7072')).toBe(-25);
    expect(s.agent.summary(ctx.storeId, '2026-10-12', '2026-10-12')[0]).toMatchObject({ count: 3, commissions: 25, cash_net: -5_000 });
    s.agent.cancel(ctx, dep.id, 'erreur de numéro');
    expect([s.agent.float(mtn.id), expectedCash()]).toEqual([10_000, 0]);
  });
});

describe('chèques impayés', () => {
  it('remet le chèque au débit du client avec les frais et peut l’interdire de chèque', () => {
    const c = s.customers.saveCustomer(ctx.userId, { name: 'Ets Fotso', creditLimit: 500_000 });
    s.pos.completeSale(ctx, { lines: [{ articleId: castel, qty: 10_000 }], payments: [{ method: 'CHEQUE', amount: 6_500, reference: 'CHQ 1234' }], customerId: c.id });
    const [ch] = s.cheques.received(ctx.storeId);
    expect(ch).toMatchObject({ amount: 6_500, deposited: false });
    s.cheques.reject(ctx, { paymentId: ch!.payment_id, date: '2026-10-12', fees: 2_500, reason: 'Sans provision', blockCheques: true });
    expect(s.customers.account(ctx.storeId, c.id).balance).toBe(9_000);
    expect(s.cheques.pending(ctx.storeId).some((p) => p.payment_id === ch!.payment_id)).toBe(false);
    expect(s.customers.getCustomer(c.id).no_cheque).toBe(1);
    expect(() =>
      s.pos.completeSale(ctx, { lines: [{ articleId: castel, qty: 1_000 }], payments: [{ method: 'CHEQUE', amount: 650, reference: 'CHQ 2' }], customerId: c.id }),
    ).toThrow(/interdit de chèque/);
    expect(balanceOf('411')).toBeGreaterThanOrEqual(0);
    expect(() => s.cheques.reject(ctx, { paymentId: ch!.payment_id, date: '2026-10-12' })).toThrow(/déjà/);
  });
});

describe('congés, planning et avances', () => {
  it('acquiert les congés par mois, refuse au-delà du solde et retire les jours de congé des absences', () => {
    const paul = s.staff.save(ctx, { name: 'Paul', baseSalary: 100_000, hiredOn: '2026-01-01' });
    const b = s.staffTime.balance(paul.id, 2026);
    expect(b.acquired).toBe(13.5);
    expect(() => s.staffTime.requestLeave(ctx, { staffId: paul.id, kind: 'paid', from: '2026-10-19', to: '2026-11-15', approved: true })).toThrow(/jour\(s\) de congé/);
    const l = s.staffTime.requestLeave(ctx, { staffId: paul.id, kind: 'paid', from: '2026-10-19', to: '2026-10-23' });
    expect(l).toMatchObject({ status: 'requested', days: 5 });
    expect(() => s.staffTime.requestLeave(ctx, { staffId: paul.id, kind: 'sick', from: '2026-10-20', to: '2026-10-20' })).toThrow(/déjà un congé/);
    s.staffTime.decideLeave(ctx, l.id, 'approved');
    expect(s.staffTime.balance(paul.id, 2026)).toMatchObject({ taken: 5, remaining: 8.5 });
    const week = s.staffTime.week(ctx.storeId, '2026-10-19');
    expect(week[0]!.cells.filter((c) => c.leave?.kind === 'paid')).toHaveLength(5);
    s.staffTime.saveSchedule(ctx, paul.id, { '1': { start: '07:00', end: '15:00' }, '2': { start: '07:00', end: '15:00' } });
    expect(s.staffTime.workingDays(paul.id, '2026-10-19', '2026-10-25')).toBe(2);
  });

  it("plafonne les avances au pourcentage du salaire, sauf accord d'un gérant", () => {
    s.admin.saveStoreSettings(ctx.userId, ctx.storeId, { advanceMaxPct: 30 });
    const paul = s.staff.save(ctx, { name: 'Paul', baseSalary: 100_000 });
    const awa = s.admin.createUser(ctx.userId, { name: 'Awa', login: 'awa', pin: '5678', role: 'cashier', storeId: ctx.storeId });
    const session = s.pos.currentSession(ctx.registerId!)!.id;
    s.cashdesk.cashOut(ctx, session, { type: 'staff_advance', staffId: paul.id, amount: 1_000, method: 'CASH' }, awa.id);
    expect(() => s.cashdesk.cashOut(ctx, session, { type: 'staff_advance', staffId: paul.id, amount: 5_000, method: 'CASH' }, awa.id)).not.toThrow();
    expect(() => s.cashdesk.cashOut(ctx, session, { type: 'staff_advance', staffId: paul.id, amount: 30_000, method: 'CASH' }, awa.id)).toThrow(/limitées à 30000/);
  });
});

describe('contrôle des caissiers', () => {
  it('compte les annulations, remises et retours de chacun et signale ce qui sort de la moyenne', () => {
    const awa = s.admin.createUser(ctx.userId, { name: 'Awa', login: 'awa', pin: '5678', role: 'cashier', storeId: ctx.storeId, registerId: ctx.registerId });
    const ben = s.admin.createUser(ctx.userId, { name: 'Ben', login: 'ben', pin: '5679', role: 'cashier', storeId: ctx.storeId, registerId: ctx.registerId });
    const a = { ...ctx, userId: awa.id };
    const b = { ...ctx, userId: ben.id };
    for (let i = 0; i < 6; i += 1) {
      s.pos.completeSale(b, { lines: [{ articleId: castel, qty: 1_000 }], payments: [{ method: 'CASH', amount: 650 }] });
      const sale = s.pos.completeSale(a, { lines: [{ articleId: castel, qty: 1_000 }], payments: [{ method: 'CASH', amount: 650 }] });
      if (i < 4) s.pos.cancelSale(a, sale.id, ctx.userId, 'erreur');
    }
    const report = s.cashierControl.report(ctx.storeId, '2026-10-12', '2026-10-12');
    const rowA = report.find((r) => r.name === 'Awa')!;
    expect(rowA.metrics.cancellations).toEqual({ count: 4, amount: 2_600 });
    expect(rowA.flags).toContain('cancellations');
    expect(report[0]!.name).toBe('Awa');
    expect(s.cashierControl.events(ctx.storeId, awa.id, '2026-10-12', '2026-10-12').filter((e) => e.kind === 'cancellations')).toHaveLength(4);
  });
});

describe('déstockage et démarque', () => {
  it('propose une remise par palier avant la date limite et la transforme en promotion', () => {
    s.stock.receive(ctx, { warehouseId: shop, lines: [{ articleId: lait, qty: 20_000, unitCost: 200, expiry: '2026-10-17' }] });
    const [row] = s.clearance.candidates(ctx.storeId);
    expect(row).toMatchObject({ article_id: lait, days_left: 5, pct: 20, promo_price: 320, below_cost: false, at_risk: 4_000 });
    expect(s.clearance.createPromotions(ctx.userId, ctx.storeId, [{ articleId: lait, promoPrice: 320 }])).toEqual({ created: 1, skipped: [] });
    expect(s.clearance.candidates(ctx.storeId)[0]!.running_promo).toMatch(/Déstockage/);
    expect(s.pos.priceLines(ctx.storeId, [{ articleId: lait, qty: 1_000 }])[0]!.promo).toBe(80);
  });
});

describe('inventaire tournant', () => {
  it('choisit les produits de valeur et ouvre un inventaire partiel', () => {
    s.stock.receive(ctx, { warehouseId: shop, lines: [{ articleId: lait, qty: 5_000, unitCost: 200 }] });
    const rows = s.cycleCount.proposal(ctx.storeId, shop, { size: 1 });
    expect(rows.map((r) => r.article_id)).toEqual([castel]);
    const inv = s.cycleCount.start(ctx, shop, [castel]);
    expect(inv.label).toMatch(/Inventaire tournant, semaine 42/);
    expect(s.cycleCount.proposal(ctx.storeId, shop).map((r) => r.article_id)).toEqual([lait]);
  });
});

describe('commande groupée et proposition de saison', () => {
  it('crée un bon par magasin sous un même numéro', () => {
    const yde = s.admin.createStore(ctx.userId, { storeCode: 'YDE1', storeName: 'Superette Bastos' });
    const sabc = s.purchases.saveSupplier(ctx.userId, { name: 'SABC' });
    const g = s.purchases.createGroupOrder(ctx, { supplierId: sabc.id, lines: [{ articleId: castel, unitCost: 450, qtyByStore: { [ctx.storeId]: 120_000, [yde.id]: 60_000 } }] });
    expect(g.ref).toMatch(/^CG-/);
    expect(g.orders.map((o) => o.store_id).sort()).toEqual([ctx.storeId, yde.id].sort());
    expect(s.purchases.groupOrders()).toEqual([expect.objectContaining({ ref: g.ref, stores: 2, total_ht: 81_000 })]);
  });

  it("tient compte des ventes de l'an dernier à la même période", () => {
    const sale = (day: string, qty: number) => {
      now = new Date(`${day}T10:00:00Z`);
      s.pos.completeSale(ctx, { lines: [{ articleId: lait, qty }], payments: [{ method: 'CASH', amount: (qty / 1000) * 400 }] });
    };
    now = new Date('2025-09-01T08:00:00Z');
    s.stock.receive(ctx, { warehouseId: shop, lines: [{ articleId: lait, qty: 115_000, unitCost: 200 }] });
    sale('2025-10-01', 10_000);
    sale('2025-10-20', 80_000);
    sale('2026-10-01', 10_000);
    sale('2026-10-05', 10_000);
    now = new Date('2026-10-12T09:00:00Z');
    const recent = s.purchases.reorderProposal(ctx.storeId, { coverDays: 14 }).find((r) => r.article_id === lait);
    const season = s.purchases.reorderProposal(ctx.storeId, { coverDays: 14, method: 'season' }).find((r) => r.article_id === lait);
    expect(season).toMatchObject({ trend: 2 });
    expect(season!.last_year_daily).toBeGreaterThan(0);
    // Avec les seules ventes récentes, les 5 yaourts restants suffisent ; la saison annonce le pic de fin octobre.
    expect(recent).toBeUndefined();
    expect(season!.qty).toBeGreaterThan(50_000);
  });
});

describe('retour du livreur', () => {
  it("encaisse ce que le livreur rapporte sur le compte de chaque client et note l'écart", () => {
    const c = s.customers.saveCustomer(ctx.userId, { name: 'Mme Ekane', creditLimit: 100_000 });
    const sale = s.pos.completeSale(ctx, {
      lines: [{ articleId: castel, qty: 10_000 }],
      payments: [{ method: 'CUSTOMER_CREDIT', amount: 6_500 }],
      customerId: c.id,
      delivery: { address: 'Bonapriso', courier: 'Paul' },
    });
    const d = s.deliveries.forSale(sale.id)!;
    expect(s.couriers.sheet(ctx.storeId, 'Paul', '2026-10-12')).toMatchObject({ to_collect: 6_500 });
    s.deliveries.setStatus(ctx, d.id, 'out');
    s.deliveries.setStatus(ctx, d.id, 'delivered');
    expect(s.couriers.pending(ctx.storeId, 'Paul')).toHaveLength(1);
    const before = expectedCash();
    const r = s.couriers.settle(ctx, { courier: 'Paul', deliveries: [{ id: d.id, collected: 6_500 }], returned: 6_000 });
    expect(r).toMatchObject({ expected: 6_500, returned: 6_000 });
    expect(s.couriers.list(ctx.storeId)[0]).toMatchObject({ collected: 6_500, difference: -500, deliveries: 1 });
    expect(s.customers.account(ctx.storeId, c.id).balance).toBe(0);
    expect(expectedCash()).toBe(before + 6_500);
    expect(s.couriers.pending(ctx.storeId, 'Paul')).toHaveLength(0);
    expect(() => s.couriers.settle(ctx, { courier: 'Paul', deliveries: [{ id: d.id, collected: 0 }], returned: 0 })).toThrow(/déjà rendue/);
  });
});

describe('boutique en ligne', () => {
  it('reprend une commande en ligne une seule fois, sans les articles inconnus', () => {
    const web = { ref: 'W-1', customerName: 'Mme Ekane', phone: '699000000', address: 'Bonapriso', deliveryFee: 1_000, lines: [{ articleId: castel, qty: 6_000 }, { articleId: 'inconnu', qty: 1_000, name: 'Savon' }] };
    const first = s.orders.importWeb(ctx, web);
    expect(first).toMatchObject({ created: true, skipped: ['Savon'] });
    expect(first.order).toMatchObject({ channel: 'web', web_ref: 'W-1', total_ttc: 4_900, delivery_fee: 1_000 });
    expect(first.order.note).toMatch(/Non repris : Savon/);
    const again = s.orders.importWeb(ctx, web);
    expect(again).toMatchObject({ created: false });
    expect(again.order.id).toBe(first.order.id);
  });
});
