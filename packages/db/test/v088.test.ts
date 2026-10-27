import { beforeEach, describe, expect, it } from 'vitest';
import { type Context, type Services, createServices, openDatabase } from '../src';

let s: Services;
let ctx: Context;
let storeId: string;
let adminId: string;
let wh: string;
let tva: string;
let riz: string;
let huile: string;
let sup: string;
const now = new Date('2026-10-27T09:00:00Z');

beforeEach(() => {
  s = createServices(openDatabase(':memory:'), () => now);
  const { store, register, admin } = s.admin.bootstrap({ storeCode: 'DLA1', storeName: 'Superette Akwa', adminName: 'Steve', adminLogin: 'steve', adminPin: '1234', vatEnabled: false });
  storeId = store.id;
  adminId = admin.id;
  ctx = { storeId, registerId: register.id, userId: admin.id };
  wh = s.admin.salesWarehouse(storeId).id;
  tva = s.admin.listVatRates()[0]!.id;
  riz = s.catalogue.saveArticle(admin.id, { name: 'Riz 5 kg', unit: 'piece', vatRateId: tva, purchasePrice: 3_000, salePrice: 5_000 }).id;
  huile = s.catalogue.saveArticle(admin.id, { name: 'Huile 1 L', unit: 'piece', vatRateId: tva, purchasePrice: 1_000, salePrice: 1_500 }).id;
  sup = s.purchases.saveSupplier(admin.id, { name: 'CCA Distribution', paymentTermsDays: 30 }).id;
});

const stockOf = (articleId: string) => s.stock.list(storeId).find((r) => r.article_id === articleId)?.qty ?? 0;

describe('rayons et familles', () => {
  it('se renomment, se déplacent et se suppriment une fois vides', () => {
    const epicerie = s.catalogue.createDepartment('Epicerie');
    const boissons = s.catalogue.createDepartment('Boissons');
    const sodas = s.catalogue.createFamily(epicerie.id, 'Sodas');
    expect(() => s.catalogue.renameDepartment(adminId, epicerie.id, 'Boissons')).toThrow(/existe déjà/);
    s.catalogue.renameDepartment(adminId, epicerie.id, 'Épicerie');
    s.catalogue.updateFamily(adminId, sodas.id, { name: 'Sodas et jus', departmentId: boissons.id });
    expect(s.catalogue.listDepartments().find((d) => d.id === boissons.id)!.families).toEqual([{ id: sodas.id, name: 'Sodas et jus' }]);
    // Un rayon vide apparaît dans le rayonnage pour être supprimé.
    expect(s.controls.shelving(storeId).rows.some((r) => r.department === 'Épicerie' && r.family_id === null)).toBe(true);

    const a = s.catalogue.getArticle(riz, storeId);
    s.catalogue.saveArticle(adminId, { name: a.name, unit: 'piece', vatRateId: tva, purchasePrice: 3_000, salePrice: 5_000, familyId: sodas.id }, riz);
    expect(() => s.catalogue.deleteFamily(adminId, sodas.id)).toThrow(/encore 1 produit/);
    expect(() => s.catalogue.deleteDepartment(adminId, boissons.id)).toThrow(/encore 1 famille/);
    s.catalogue.saveArticle(adminId, { name: a.name, unit: 'piece', vatRateId: tva, purchasePrice: 3_000, salePrice: 5_000, familyId: null }, riz);
    s.catalogue.deleteFamily(adminId, sodas.id);
    s.catalogue.deleteDepartment(adminId, boissons.id);
    s.catalogue.deleteDepartment(adminId, epicerie.id);
    expect(s.catalogue.listDepartments()).toEqual([]);
    const out = s.db.prepare("SELECT entity, op FROM outbox WHERE entity IN ('family', 'department') AND op = 'delete'").all();
    expect(out).toHaveLength(3);
  });
});

describe('type et suppression d’une caisse', () => {
  it('une caisse qui n’a pas servi change de type ou se supprime ; celle qui a servi non', () => {
    const extra = s.admin.createRegister(adminId, storeId, 'Caisse en trop', 'cash');
    const awa = s.admin.createUser(adminId, { name: 'Awa', login: 'awa', pin: '5555', role: 'cashier', storeId, registerId: extra.id });
    const changed = s.admin.changeRegisterKind(adminId, extra.id, 'electronic');
    expect(changed.register.kind).toBe('electronic');
    expect(changed.detached).toEqual(['Awa']);
    expect(s.admin.getUser(awa.id).register_id).toBeNull();
    s.admin.deleteRegister(adminId, extra.id);
    expect(s.admin.listRegisters(storeId).map((r) => r.name)).toEqual(['Caisse 1']);
    // La caisse du PC (activée, avec des journées) garde son type.
    s.pos.openSession(ctx, 10_000);
    expect(() => s.admin.changeRegisterKind(adminId, ctx.registerId!, 'bank')).toThrow(/déjà servi|rattachée/);
    expect(() => s.admin.deleteRegister(adminId, ctx.registerId!)).toThrow(/Suppression impossible/);
  });
});

describe('nom d’un produit', () => {
  it('se change par le renommage, avec l’ancien nom au journal d’audit', () => {
    expect(() => s.catalogue.renameArticle(adminId, riz, '  ', '')).toThrow(/nouveau nom/);
    s.catalogue.renameArticle(adminId, riz, 'RIZ PARFUMÉ 5 KG', 'Faute de frappe');
    expect(s.catalogue.getArticle(riz, storeId).name).toBe('RIZ PARFUMÉ 5 KG');
    const log = s.db.prepare("SELECT details FROM audit_log WHERE action = 'article.rename'").pluck().get() as string;
    expect(JSON.parse(log)).toEqual({ from: 'Riz 5 kg', to: 'RIZ PARFUMÉ 5 KG', reason: 'Faute de frappe' });
  });
});

describe('modifier une entrée ou une sortie de caisse', () => {
  it('montant, motif et tiers se corrigent tant que la journée est ouverte', () => {
    s.pos.openSession(ctx, 50_000);
    const day = s.pos.currentSession(ctx.registerId!)!.id;
    const account = s.accounting.listAccounts().find((a) => !a.id.startsWith('5') && a.id.startsWith('6'))!.id;
    const out = s.cashdesk.cashOut(ctx, day, { type: 'other', accountId: account, amount: 5_000, method: 'CASH', label: 'Taxi', party: 'Moto' }, adminId);
    s.cashdesk.update(ctx, out.id, adminId, { amount: 4_000, label: 'Taxi livraison', party: 'Moto-taxi' });
    expect(s.cashdesk.get(out.id)).toMatchObject({ amount: 4_000, label: 'Taxi livraison', party: 'Moto-taxi' });
    expect(s.pos.zReport(day).cash.expected).toBe(50_000 - 4_000);

    const category = s.expenses.listCategories()[0]!.id;
    const dep = s.expenses.record(ctx, { categoryId: category, label: 'Sacs', amount: 3_500, method: 'CASH', atRegister: true });
    s.expenses.update(ctx, dep.id, adminId, { amount: 3_000, label: 'Sacs plastiques', beneficiary: 'Marché' });
    expect(s.expenses.get(dep.id)).toMatchObject({ amount: 3_000, label: 'Sacs plastiques', beneficiary: 'Marché' });

    s.pos.closeSession(ctx, { 10000: 4, 2000: 1, 1000: 1 });
    expect(() => s.cashdesk.update(ctx, out.id, adminId, { amount: 1_000 })).toThrow(/clôturée/);
    expect(() => s.expenses.update(ctx, dep.id, adminId, { amount: 1_000 })).toThrow(/clôturée/);
  });
});

describe('modifier une facture d’achat', () => {
  it('le n°, les dates et les montants d’une facture rapprochée des réceptions', () => {
    const rec = s.stock.receive(ctx, { warehouseId: wh, supplierId: sup, lines: [{ articleId: riz, qty: 10_000, unitCost: 3_000 }] });
    const inv = s.purchases.createInvoice(ctx, { supplierId: sup, supplierNumber: 'F-1', invoiceDate: '2026-10-20', totalHt: 30_000, totalTva: 0, receptionIds: [rec.id] });
    s.purchases.paySupplier(ctx, { invoiceId: inv.id, method: 'BANK_TRANSFER', amount: 10_000, reference: 'VIR-1' });
    const up = s.purchases.updateInvoice(ctx, inv.id, { supplierNumber: 'F-0001', invoiceDate: '2026-10-21', totalHt: 29_000 });
    expect(up).toMatchObject({ supplier_number: 'F-0001', invoice_date: '2026-10-21', due_date: '2026-11-20', total_ttc: 29_000, balance: 19_000 });
    expect(() => s.purchases.updateInvoice(ctx, inv.id, { supplierNumber: 'F-0001', invoiceDate: '2026-10-21', totalHt: 5_000 })).toThrow(/déjà réglés/);
  });

  it('les articles d’une facture directe : le stock reçu est refait', () => {
    const inv = s.purchases.directInvoice(ctx, {
      supplierId: sup,
      supplierNumber: 'FAC-9',
      invoiceDate: '2026-10-27',
      warehouseId: wh,
      lines: [
        { articleId: riz, qty: 10_000, unitCost: 3_000 },
        { articleId: huile, qty: 5_000, unitCost: 1_000 },
      ],
    });
    // 2 riz vendus avant de voir l'erreur.
    s.pos.openSession(ctx, 0);
    s.pos.completeSale(ctx, { lines: [{ articleId: riz, qty: 2_000 }], payments: [{ method: 'CASH', amount: 10_000 }] });
    expect(stockOf(riz)).toBe(8_000);
    // C'était 12 riz à 2 900, et pas d'huile mais 3 litres... de riz en plus : on corrige.
    const fixed = s.purchases.correctDirectInvoice(ctx, inv.id, {
      supplierNumber: 'FAC-9',
      invoiceDate: '2026-10-27',
      lines: [{ articleId: riz, qty: 12_000, unitCost: 2_900 }],
    });
    expect(fixed).toMatchObject({ total_ht: 34_800, total_ttc: 34_800, received_ht: 34_800 });
    expect(stockOf(riz)).toBe(10_000);
    expect(stockOf(huile)).toBe(0);
    expect(s.purchases.invoiceLines(inv.id).map((l) => [l.article_id, l.qty, l.unit_cost])).toEqual([[riz, 12_000, 2_900]]);
    const lots = s.db.prepare('SELECT COALESCE(SUM(qty), 0) FROM lots WHERE article_id = ?').pluck().get(riz);
    expect(lots).toBe(10_000);
  });
});

describe('bons de commande et de réception', () => {
  it('une commande envoyée se modifie tant que rien n’est reçu', () => {
    const o = s.purchases.createOrder(ctx, { supplierId: sup, warehouseId: wh, lines: [{ articleId: riz, qty: 10_000, unitCost: 3_000 }] });
    s.purchases.setOrderStatus(ctx, o.id, 'sent');
    const up = s.purchases.updateOrder(ctx, o.id, { supplierId: sup, warehouseId: wh, lines: [{ articleId: riz, qty: 12_000, unitCost: 3_000 }] });
    expect(up).toMatchObject({ status: 'sent', total_ht: 36_000 });
    s.purchases.receiveOrder(ctx, o.id, { lines: [{ orderLineId: up.lines[0]!.id, articleId: riz, qty: 5_000, unitCost: 3_000 }] });
    expect(() => s.purchases.updateOrder(ctx, o.id, { supplierId: sup, warehouseId: wh, lines: [{ articleId: riz, qty: 1_000, unitCost: 3_000 }] })).toThrow(/déjà reçue/);
  });

  it('un bon de réception pas encore facturé se corrige, la commande suit', () => {
    const o = s.purchases.createOrder(ctx, { supplierId: sup, warehouseId: wh, lines: [{ articleId: riz, qty: 10_000, unitCost: 3_000 }] });
    s.purchases.setOrderStatus(ctx, o.id, 'sent');
    const r = s.purchases.receiveOrder(ctx, o.id, { lines: [{ orderLineId: o.lines[0]!.id, articleId: riz, qty: 10_000, unitCost: 3_000 }] });
    const recId = s.purchases.listReceptions(storeId)[0]!.id;
    expect(r).toBeTruthy();
    const fixed = s.purchases.correctReception(ctx, recId, { lines: [{ articleId: riz, qty: 8_000, unitCost: 3_000 }] });
    expect(fixed.lines.map((l) => l.qty)).toEqual([8_000]);
    expect(stockOf(riz)).toBe(8_000);
    expect(s.purchases.getOrder(o.id).lines[0]!.received).toBe(8_000);
    s.purchases.createInvoice(ctx, { supplierId: sup, supplierNumber: 'F-2', invoiceDate: '2026-10-27', totalHt: 24_000, totalTva: 0, receptionIds: [recId] });
    expect(() => s.purchases.correctReception(ctx, recId, { lines: [{ articleId: riz, qty: 1_000, unitCost: 3_000 }] })).toThrow(/déjà facturé/);
  });
});

describe('remise à zéro des données d’essai', () => {
  const play = () => {
    const cust = s.customers.saveCustomer(adminId, { name: 'Mballa', creditLimit: 100_000 });
    s.purchases.directInvoice(ctx, { supplierId: sup, supplierNumber: 'FAC-1', invoiceDate: '2026-10-27', warehouseId: wh, lines: [{ articleId: riz, qty: 20_000, unitCost: 3_000 }] });
    s.pos.openSession(ctx, 10_000);
    s.pos.completeSale(ctx, { lines: [{ articleId: riz, qty: 3_000 }], payments: [{ method: 'CASH', amount: 15_000 }] });
    s.expenses.record(ctx, { categoryId: s.expenses.listCategories()[0]!.id, label: 'Taxi', amount: 1_000, method: 'CASH', atRegister: true });
    return cust;
  };

  it('efface ventes, achats, caisse et stock et garde réglages, produits, clients et fournisseurs', () => {
    const cust = play();
    const before = s.reset.preview();
    expect(before).toMatchObject({ sales: 1, receptions: 1, supplierInvoices: 1, cashSessions: 1, expenses: 1 });
    const after = s.reset.run(adminId);
    expect(after).toMatchObject({ sales: 0, receptions: 0, supplierInvoices: 0, cashSessions: 0, expenses: 0, movements: 0, articles: 2, customers: 1, suppliers: 1, users: 1 });
    expect(stockOf(riz)).toBe(0);
    expect(s.customers.account(storeId, cust.id).balance).toBe(0);
    expect(s.admin.listRegisters(storeId)).toHaveLength(1);
    // La vie reprend : numéros repartis à 1, codes des articles poursuivis.
    s.stock.receive(ctx, { warehouseId: wh, lines: [{ articleId: huile, qty: 5_000, unitCost: 1_000 }] });
    s.pos.openSession(ctx, 0);
    const sale = s.pos.completeSale(ctx, { lines: [{ articleId: huile, qty: 1_000 }], payments: [{ method: 'CASH', amount: 1_500 }] });
    expect(String(sale.number)).toMatch(/1$/);
    const next = s.catalogue.saveArticle(adminId, { name: 'Sucre', unit: 'piece', vatRateId: tva, purchasePrice: 500, salePrice: 800 });
    expect(next.code).not.toBe(s.catalogue.getArticle(riz, storeId).code);
    expect(s.db.prepare("SELECT COUNT(*) FROM audit_log WHERE action = 'data.reset'").pluck().get()).toBe(1);
  });

  it('peut garder les quantités en stock comme stock de départ', () => {
    play();
    s.reset.run(adminId, { keepStock: true });
    expect(stockOf(riz)).toBe(17_000);
    expect(s.stock.movements(storeId, { articleId: riz }).map((m) => [m.type, m.qty])).toEqual([['INVENTORY_ADJUST', 17_000]]);
    expect(s.db.pragma('foreign_key_check')).toEqual([]);
  });
});
