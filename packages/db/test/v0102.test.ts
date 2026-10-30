import { beforeEach, describe, expect, it } from 'vitest';
import { type Context, type Services, createServices, openDatabase } from '../src';

let s: Services;
let ctx: Context;
let office: Context;
let adminId: string;
let storeId: string;
let registerId: string;
let now = new Date('2026-10-30T09:00:00Z');

beforeEach(() => {
  now = new Date('2026-10-30T09:00:00Z');
  s = createServices(openDatabase(':memory:'), () => now);
  const { store, register, admin } = s.admin.bootstrap({ storeCode: 'DLA1', storeName: 'Superette Akwa', adminName: 'Steve', adminLogin: 'steve', adminPin: '1234' });
  adminId = admin.id;
  storeId = store.id;
  registerId = register.id;
  ctx = { storeId, registerId, userId: adminId };
  office = { storeId, registerId: null, userId: adminId };
});

const later = (minutes: number) => {
  now = new Date(now.getTime() + minutes * 60_000);
};
const balance = (account: string) => s.accounting.trialBalance(storeId).rows.find((r) => r.account === account)?.closing ?? 0;
const supplierBalance = (id: string) => s.purchases.listSuppliers().find((x) => x.id === id)!.balance;

describe("solde d'ouverture et ajustement de solde", () => {
  it('client : JEAN doit 100 000 dès sa création, puis un ajustement avec motif', () => {
    const jean = s.customers.saveCustomer(adminId, { name: 'JEAN' });
    s.opening.adjustCustomer(office, jean.id, { amount: 100_000, kind: 'opening' });
    expect(s.customers.account(storeId, jean.id).balance).toBe(100_000);
    expect(() => s.opening.adjustCustomer(office, jean.id, { amount: 5_000, kind: 'opening' })).toThrow(/déjà saisi/);
    expect(() => s.opening.adjustCustomer(office, jean.id, { amount: -5_000, kind: 'adjustment' })).toThrow(/motif/);
    s.opening.adjustCustomer(office, jean.id, { amount: -15_000, kind: 'adjustment', label: 'Erreur de reprise' });
    expect(s.customers.account(storeId, jean.id).balance).toBe(85_000);
    const st = s.customers.statement(storeId, jean.id);
    expect(st.lines.map((l) => l.label)).toEqual(["Solde repris", 'Ajustement de solde : Erreur de reprise']);
    // Comptabilité : à-nouveau puis opération diverse, contre le compte d'attente.
    expect(balance('4711')).toBe(-85_000);
    // La reprise par fichier ne compte que les soldes d'ouverture.
    expect(s.opening.summary(storeId).customers).toMatchObject({ count: 1, total: 100_000 });
  });

  it("client : une avance d'ouverture (solde négatif)", () => {
    const awa = s.customers.saveCustomer(adminId, { name: 'Awa' });
    s.opening.adjustCustomer(office, awa.id, { amount: -20_000, kind: 'opening' });
    expect(s.customers.account(storeId, awa.id).balance).toBe(-20_000);
  });

  it("fournisseur : on lui doit 250 000 à l'ouverture, puis on ajuste de -50 000", () => {
    const sabc = s.purchases.saveSupplier(adminId, { name: 'SABC' });
    s.opening.adjustSupplier(office, sabc.id, { amount: 250_000, kind: 'opening' });
    expect(supplierBalance(sabc.id)).toBe(250_000);
    expect(() => s.opening.adjustSupplier(office, sabc.id, { amount: 1_000, kind: 'opening' })).toThrow(/déjà saisi/);
    s.opening.adjustSupplier(office, sabc.id, { amount: -50_000, kind: 'adjustment', label: 'Avoir oublié' });
    expect(supplierBalance(sabc.id)).toBe(200_000);
    expect(balance('401')).toBe(-200_000);
    expect(balance('4711')).toBe(200_000);
    // Ni achat ni TVA.
    expect(balance('601')).toBe(0);
    expect(s.opening.summary(storeId).suppliers).toMatchObject({ count: 1, total: 250_000 });
  });
});

describe('annuler un règlement ou un dépôt d’avance de la journée', () => {
  it("dépôt d'avance client annulé : l'argent ressort, le compte revient à zéro ; supprimer l'annulation le rétablit", () => {
    const jean = s.customers.saveCustomer(adminId, { name: 'JEAN' });
    s.pos.openSession(ctx, 10_000);
    const day = s.pos.currentSession(registerId)!.id;
    later(5);
    const dep = s.cashdesk.cashIn(ctx, day, { type: 'customer', customerId: jean.id, amount: 30_000, method: 'CASH', advance: true });
    expect(s.customers.account(storeId, jean.id).balance).toBe(-30_000);
    expect(s.pos.zReport(day).cash.expected).toBe(40_000);
    later(5);
    expect(() => s.cashdesk.reversePayment(ctx, 'customer_payment', dep.id, adminId, '')).toThrow(/motif/);
    const rev = s.cashdesk.reversePayment(ctx, 'customer_payment', dep.id, adminId, 'Le client a changé d’avis');
    expect(rev).toMatchObject({ direction: 'OUT', kind: 'customer_refund', amount: 30_000, payment_id: dep.id });
    expect(s.customers.account(storeId, jean.id).balance).toBe(0);
    expect(s.pos.zReport(day).cash.expected).toBe(10_000);
    expect(() => s.cashdesk.reversePayment(ctx, 'customer_payment', dep.id, adminId, 'encore')).toThrow(/déjà annulé/);
    const st = s.customers.statement(storeId, jean.id);
    expect(st.lines.map((l) => l.label)).toEqual(["Dépôt d'avance Espèces (annulé)", expect.stringMatching(/^Annulation du règlement RC-/)]);
    // Supprimer la pièce d'annulation rétablit le dépôt.
    s.cashdesk.cancel(ctx, rev.id, adminId, 'Erreur');
    expect(s.customers.account(storeId, jean.id).balance).toBe(-30_000);
  });

  it("règlement d'une dette annulé : le client redoit sa vente", () => {
    const jean = s.customers.saveCustomer(adminId, { name: 'JEAN', creditLimit: 100_000 });
    s.opening.adjustCustomer(office, jean.id, { amount: 50_000, kind: 'opening' });
    s.pos.openSession(ctx, 0);
    const day = s.pos.currentSession(registerId)!.id;
    const pay = s.cashdesk.cashIn(ctx, day, { type: 'customer', customerId: jean.id, amount: 20_000, method: 'CASH' });
    expect(s.customers.account(storeId, jean.id).balance).toBe(30_000);
    s.cashdesk.reversePayment(ctx, 'customer_payment', pay.id, adminId, 'Saisi en double');
    expect(s.customers.account(storeId, jean.id).balance).toBe(50_000);
    expect(balance('411')).toBe(50_000);
  });

  it('journée clôturée : on ne supprime plus, on rembourse', () => {
    const jean = s.customers.saveCustomer(adminId, { name: 'JEAN' });
    s.pos.openSession(ctx, 0);
    const day = s.pos.currentSession(registerId)!.id;
    const dep = s.cashdesk.cashIn(ctx, day, { type: 'customer', customerId: jean.id, amount: 5_000, method: 'CASH', advance: true });
    s.pos.closeSession(ctx, { 5000: 1 });
    expect(() => s.cashdesk.reversePayment(ctx, 'customer_payment', dep.id, adminId, 'Trop tard')).toThrow(/clôturée/);
  });

  it("avance au fournisseur versée de la caisse, puis supprimée", () => {
    const sabc = s.purchases.saveSupplier(adminId, { name: 'SABC' });
    s.opening.adjustSupplier(office, sabc.id, { amount: 100_000, kind: 'opening' });
    s.pos.openSession(ctx, 80_000);
    const day = s.pos.currentSession(registerId)!.id;
    const adv = s.cashdesk.cashOut(ctx, day, { type: 'supplier_advance', supplierId: sabc.id, amount: 60_000, method: 'CASH' }, adminId);
    expect(supplierBalance(sabc.id)).toBe(40_000);
    expect(s.pos.zReport(day).cash.expected).toBe(20_000);
    expect(balance('401')).toBe(-40_000);
    // Ni achat, ni TVA déductible.
    expect(balance('601')).toBe(0);
    s.cashdesk.cancel(ctx, adv.id, adminId, 'Le fournisseur ne livre plus');
    expect(supplierBalance(sabc.id)).toBe(100_000);
    expect(s.pos.zReport(day).cash.expected).toBe(80_000);
    expect(balance('401')).toBe(-100_000);
  });

  it("règlement fournisseur de la journée annulé : l'argent revient, la facture redevient due", () => {
    const sabc = s.purchases.saveSupplier(adminId, { name: 'SABC' });
    const inv = s.purchases.createInvoice(office, { supplierId: sabc.id, supplierNumber: 'F-12', invoiceDate: '2026-10-30', totalHt: 50_000, totalTva: 0 });
    s.pos.openSession(ctx, 60_000);
    const day = s.pos.currentSession(registerId)!.id;
    s.cashdesk.cashOut(ctx, day, { type: 'supplier', invoiceId: inv.id, amount: 50_000, method: 'CASH' }, adminId);
    expect(s.purchases.getInvoice(inv.id).state).toBe('paid');
    const paymentId = s.purchases.invoicePayments(inv.id)[0]!.id;
    s.cashdesk.reversePayment(ctx, 'supplier_payment', paymentId, adminId, 'Mauvaise facture');
    expect(s.purchases.getInvoice(inv.id)).toMatchObject({ state: 'unpaid', balance: 50_000 });
    expect(supplierBalance(sabc.id)).toBe(50_000);
    expect(s.pos.zReport(day).cash.expected).toBe(60_000);
    expect(balance('401')).toBe(-50_000);
    expect(s.controls.supplierStatement(storeId, sabc.id).closing).toBe(50_000);
  });
});

describe('plusieurs vendeurs et plusieurs caisses', () => {
  it('chaque vendeur a sa caisse de destination ; retirer la caisse libère ses factures', () => {
    const boissons = s.admin.createRegister(adminId, storeId, 'Caisse boissons', 'cash');
    const paul = s.admin.createUser(adminId, { name: 'Paul', login: 'paul', pin: '5678', role: 'seller', storeId, counterRegisterId: boissons.id });
    expect(s.admin.getUser(paul.id).counter_register_id).toBe(boissons.id);
    s.admin.updateUser(adminId, paul.id, { counterRegisterId: registerId });
    expect(s.admin.getUser(paul.id).counter_register_id).toBe(registerId);
    const momo = s.admin.createRegister(adminId, storeId, 'MoMo', 'electronic');
    expect(() => s.admin.updateUser(adminId, paul.id, { counterRegisterId: momo.id })).toThrow(/pas une caisse espèces/);
    s.admin.updateUser(adminId, paul.id, { counterRegisterId: null });
    expect(s.admin.getUser(paul.id).counter_register_id).toBeNull();
  });

  it('deux caissiers sur la même caisse : celui du matin ferme, celui du soir rouvre la même caisse', () => {
    const awa = s.admin.createUser(adminId, { name: 'Awa', login: 'awa', pin: '5678', role: 'cashier', storeId, registerId });
    const ben = s.admin.createUser(adminId, { name: 'Ben', login: 'ben', pin: '5678', role: 'cashier', storeId, registerId });
    const ctxAwa = { storeId, registerId, userId: awa.id };
    const ctxBen = { storeId, registerId, userId: ben.id };
    const morning = s.pos.openSession(ctxAwa, 10_000);
    later(240);
    s.pos.closeSession(ctxAwa, { 10000: 1 }, { floatLeft: 10_000 });
    later(60);
    const evening = s.pos.openSession(ctxBen, 10_000);
    expect(evening.id).not.toBe(morning.id);
    expect(evening).toMatchObject({ register_id: registerId, user_id: ben.id, status: 'open' });
  });
});

describe('rejoindre un magasin sans code de caisse', () => {
  it('le PC appartient au magasin sans caisse propre', () => {
    s.admin.joinStation(storeId);
    expect(s.admin.station()).toMatchObject({ store: { id: storeId }, register: null });
  });
});

describe('caisses en direct', () => {
  it('montre chaque caisse avec sa journée, son caissier, ses ventes et ses sorties', () => {
    const tva = s.admin.listVatRates()[0]!.id;
    const riz = s.catalogue.saveArticle(adminId, { name: 'Riz', unit: 'piece', vatRateId: tva, purchasePrice: 700, salePrice: 1_000 }).id;
    s.stock.receive(ctx, { warehouseId: s.admin.salesWarehouse(storeId).id, lines: [{ articleId: riz, qty: 10_000, unitCost: 700 }] });
    const boissons = s.admin.createRegister(adminId, storeId, 'Caisse boissons', 'cash');
    const awa = s.admin.createUser(adminId, { name: 'Awa', login: 'awa', pin: '5678', role: 'cashier', storeId, registerId });
    const ctxAwa = { storeId, registerId, userId: awa.id };
    s.pos.openSession(ctxAwa, 5_000);
    later(10);
    s.pos.completeSale(ctxAwa, { lines: [{ articleId: riz, qty: 2_000 }], payments: [{ method: 'CASH', amount: 2_000 }] });
    later(5);
    s.cashdesk.cashOut(ctxAwa, s.pos.currentSession(registerId)!.id, { type: 'other', accountId: '4711', amount: 500, method: 'CASH', label: 'Taxi' }, adminId);
    const live = s.pos.liveRegisters(storeId);
    expect(live.find((r) => r.id === registerId)).toMatchObject({ status: 'open', cashier: 'Awa', tickets: 1, net: 2_000, exits: 500, expected: 6_500, lastAt: now.toISOString() });
    expect(live.find((r) => r.id === boissons.id)).toMatchObject({ status: 'never', session: null });
  });
});
