import Database from 'better-sqlite3';
import { receiptToText } from '@superette/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { type Context, type Services, createServices, migrate, openDatabase } from '../src';
import { MIGRATIONS } from '../src/schema';

let now = new Date('2026-10-08T07:00:00Z');
const clock = () => now;

let s: Services;
let ctx: Context;
let riz: string;
let warehouse: string;

function setup(opts: { vatEnabled?: boolean } = {}) {
  now = new Date('2026-10-08T07:00:00Z');
  s = createServices(openDatabase(':memory:'), clock);
  const { store, register, admin } = s.admin.bootstrap({
    storeCode: 'DLA1',
    storeName: 'Superette Akwa',
    adminName: 'Steve',
    adminLogin: 'steve',
    adminPin: '1234',
    vatEnabled: opts.vatEnabled,
  });
  ctx = { storeId: store.id, registerId: register.id, userId: admin.id };
  const tva = s.admin.listVatRates().find((r) => r.rate_bp === 1925)!.id;
  riz = s.catalogue.saveArticle(admin.id, { name: 'Riz 5 kg', unit: 'piece', vatRateId: tva, purchasePrice: 3_000, salePrice: 5_000 }).id;
  warehouse = s.admin.salesWarehouse(store.id).id;
  s.stock.receive(ctx, { warehouseId: warehouse, lines: [{ articleId: riz, qty: 10_000, unitCost: 3_000 }] });
}

const balanced = () => {
  for (const e of s.accounting.entries(ctx.storeId)) {
    expect(e.lines.reduce((t, l) => t + l.debit - l.credit, 0), `${e.ref} ${e.label}`).toBe(0);
  }
};

describe('caisse centrale et journées de caisse', () => {
  beforeEach(() => setup());

  it('refuse toute vente tant que la caisse est fermée', () => {
    expect(() => s.pos.completeSale(ctx, { lines: [{ articleId: riz, qty: 1000 }], payments: [{ method: 'CASH', amount: 5_000 }] })).toThrow(
      /ouvrez-la dans Trésorerie/,
    );
  });

  it('verse la recette à la centrale, laisse le fond et le reprend le lendemain', () => {
    s.treasury.record(ctx, { kind: 'IN', nature: 'owner', amount: 50_000 });
    // Première journée : le fond est déjà dans le tiroir, rien ne bouge à la centrale.
    s.pos.openSession(ctx, 10_000);
    expect(s.treasury.balance(ctx.storeId)).toBe(50_000);
    s.pos.completeSale(ctx, { lines: [{ articleId: riz, qty: 4000 }], payments: [{ method: 'CASH', amount: 20_000 }] });
    s.pos.cashOperation(ctx, 'OUT', 15_000, 'Tiroir trop plein');
    expect(s.treasury.balance(ctx.storeId)).toBe(65_000);

    // Comptage à l'aveugle : le premier total est gardé, l'écart est montré après.
    const preview = s.pos.countPreview(ctx, { 10000: 1, 5000: 1 });
    expect(preview).toMatchObject({ expected: 15_000, counted: 15_000, difference: 0, needsApproval: false });
    s.pos.countPreview(ctx, { 10000: 1, 5000: 1, 1000: 1 });
    const session = s.pos.currentSession(ctx.registerId!)!;
    expect(s.pos.getSession(session.id).first_counted).toBe(15_000);

    expect(() => s.pos.closeSession(ctx, { 10000: 1, 5000: 1 }, { floatLeft: 20_000 })).toThrow(/dépasse/);
    const z = s.pos.closeSession(ctx, { 10000: 1, 5000: 1 }, { floatLeft: 5_000 });
    expect(z.session).toMatchObject({ status: 'closed', counted_cash: 15_000, float_left: 5_000, deposit: 10_000, difference: 0 });
    expect(s.treasury.balance(ctx.storeId)).toBe(75_000);
    expect(s.treasury.sessionMovements(session.id).map((m) => [m.kind, m.amount])).toEqual([
      ['DEPOSIT', 15_000],
      ['DEPOSIT', 10_000],
    ]);

    // Lendemain : 5 000 trouvés dans le tiroir, le fond est porté à 10 000 avec la centrale.
    now = new Date('2026-10-09T07:00:00Z');
    expect(s.pos.carriedFloat(ctx.registerId!)).toBe(5_000);
    const next = s.pos.openSession(ctx, 10_000);
    expect(next.carried_float).toBe(5_000);
    expect(s.treasury.balance(ctx.storeId)).toBe(70_000);
    expect(s.treasury.sessionMovements(next.id)).toMatchObject([{ kind: 'FLOAT', amount: 5_000, label: 'Complément du fond de Caisse 1' }]);

    // Livre de la centrale : soldes progressifs, sorties au bureau comprises.
    now = new Date('2026-10-09T10:00:00Z');
    s.expenses.record(ctx, { categoryId: 'cat-transport', label: 'Taxi banque', amount: 2_000, method: 'CASH' });
    s.treasury.record(ctx, { kind: 'OUT', nature: 'bank', amount: 60_000, label: 'Dépôt Afriland' });
    expect(() => s.treasury.record(ctx, { kind: 'OUT', nature: 'bank', amount: 60_000 })).toThrow(/n'a que 8\s?000/);
    const ledger = s.treasury.ledger(ctx.storeId);
    expect(ledger.rows.map((r) => [r.source, r.amount, r.balance])).toEqual([
      ['movement', 50_000, 50_000],
      ['movement', 15_000, 65_000],
      ['movement', 10_000, 75_000],
      ['movement', -5_000, 70_000],
      ['expense', -2_000, 68_000],
      ['movement', -60_000, 8_000],
    ]);
    expect(s.treasury.ledger(ctx.storeId, { from: '2026-10-09' })).toMatchObject({ opening: 75_000, closing: 8_000 });

    // Comptabilité : virements de fonds par le 585, centrale au 5712, équilibrée.
    balanced();
    const t = Object.fromEntries(s.accounting.treasury(ctx.storeId).map((r) => [r.account, r.balance]));
    expect(t['5712']).toBe(8_000);
    expect(t['585']).toBe(0);
    expect(t['521']).toBe(60_000);
    // Caisse de vente : 20 000 vendus − 25 000 versés + 5 000 de complément (le premier fond n'était pas compté).
    expect(t['571']).toBe(0);
  });

  it("exige motif et gérant pour un écart au-delà du seuil, et imprime le bon de versement", () => {
    s.admin.setStoreOptions(ctx.userId, ctx.storeId, { cashGapThreshold: 1_000 });
    s.pos.openSession(ctx, 0);
    s.pos.completeSale(ctx, { lines: [{ articleId: riz, qty: 2000 }], payments: [{ method: 'CASH', amount: 10_000 }] });
    expect(s.pos.countPreview(ctx, { 5000: 1 })).toMatchObject({ difference: -5_000, needsApproval: true, threshold: 1_000 });
    expect(() => s.pos.closeSession(ctx, { 5000: 1 }, { floatLeft: 0, gapReason: 'Billet manquant' })).toThrow(/gérant/);
    const z = s.pos.closeSession(ctx, { 5000: 1 }, { floatLeft: 0, gapReason: 'Billet manquant', gapApprovedBy: ctx.userId });
    expect(z.session).toMatchObject({ gap_reason: 'Billet manquant', gap_approved_by: ctx.userId, deposit: 5_000 });
    const [deposit] = s.treasury.sessionMovements(z.session.id);
    const text = receiptToText(s.receipts.centralVoucher(deposit!.id), 48);
    expect(text).toContain('BON DE VERSEMENT');
    expect(text).toContain('De : Caisse 1 · À : caisse centrale');
    expect(text).toMatch(/Montant FCFA\s+5 000/);
    // Écart passé en manquant (658) ; le versement sort de la caisse de vente.
    balanced();
  });

  it('signale une journée non clôturée et refuse d’en ouvrir une autre', () => {
    const open = s.pos.openSession(ctx, 0);
    now = new Date('2026-10-09T07:00:00Z');
    expect(s.pos.isStale(open)).toBe(true);
    s.pos.closeSession(ctx, {});
    expect(() => s.pos.openSession(ctx, 0)).not.toThrow();
  });
});

describe('TVA facultative', () => {
  it('un magasin non assujetti vend, achète et dépense sans TVA', () => {
    setup({ vatEnabled: false });
    expect(s.admin.getStore(ctx.storeId).vat_enabled).toBe(0);
    s.pos.openSession(ctx, 0);
    const sale = s.pos.completeSale(ctx, { lines: [{ articleId: riz, qty: 1000 }], payments: [{ method: 'CASH', amount: 5_000 }] });
    expect(sale).toMatchObject({ total_ttc: 5_000, total_ht: 5_000, total_tva: 0 });
    expect(receiptToText(s.receipts.ticket(sale.id), 48)).toContain('TVA non applicable');
    expect(receiptToText(s.receipts.zReport(sale.session_id), 48)).toContain('TVA non applicable');

    const sup = s.purchases.saveSupplier(ctx.userId, { name: 'Grossiste Mboppi' });
    const inv = s.purchases.createInvoice(ctx, { supplierId: sup.id, supplierNumber: 'FA-1', invoiceDate: '2026-10-08', totalHt: 100_000, totalTva: 19_250 });
    expect(inv).toMatchObject({ total_ht: 119_250, total_tva: 0, total_ttc: 119_250 });
    const exp = s.expenses.record(ctx, { categoryId: 'cat-transport', label: 'Carburant', amount: 11_925, vat: 1_925, method: 'MTN_MOMO', reference: 'MP9' });
    expect(exp.vat).toBe(0);
    const rec = s.stock.receive(ctx, { warehouseId: warehouse, lines: [{ articleId: riz, qty: 1000, unitCost: 3_500 }] });
    expect(s.purchases.getReception(rec.id).lines[0]!.vat_rate_bp).toBe(0);
    expect(s.accounting.vatReturn(ctx.storeId, '2026-10')).toMatchObject({ collected: 0 });
    balanced();

    // Passage au régime réel : les ventes suivantes portent la TVA.
    s.admin.setStoreOptions(ctx.userId, ctx.storeId, { vatEnabled: true });
    const after = s.pos.completeSale(ctx, { lines: [{ articleId: riz, qty: 1000 }], payments: [{ method: 'CASH', amount: 5_000 }] });
    expect(after.total_tva).toBe(807);
    expect(s.pos.getSale(sale.id).total_tva).toBe(0);
  });

  it('un magasin installé avant cette option reste assujetti', () => {
    setup();
    expect(s.admin.getStore(ctx.storeId).vat_enabled).toBe(1);
  });
});

describe('ignorer la gestion des stocks', () => {
  beforeEach(() => setup());

  it('vend sans stock quand le gérant l’a permis, puis régularise à la réception', () => {
    s.pos.openSession(ctx, 0);
    const sell = (qty: number) => s.pos.completeSale(ctx, { lines: [{ articleId: riz, qty }], payments: [{ method: 'CASH', amount: (qty / 1000) * 5_000 }] });
    expect(() => sell(12_000)).toThrow(/Stock insuffisant pour Riz 5 kg : il reste 10/);
    s.admin.setStoreOptions(ctx.userId, ctx.storeId, { ignoreStock: true });
    const sale = sell(12_000);
    expect(s.stock.list(ctx.storeId, { search: 'riz' })[0]!.qty).toBe(-2_000);
    expect(s.admin.auditLog().find((a) => a.action === 'sale.without_stock')).toMatchObject({ entity_id: sale.id });

    // La marchandise arrive : la réception couvre d'abord les 2 vendus sans stock.
    s.stock.receive(ctx, { warehouseId: warehouse, lines: [{ articleId: riz, qty: 6_000, unitCost: 3_200 }] });
    expect(s.stock.list(ctx.storeId, { search: 'riz' })[0]!.qty).toBe(4_000);
    expect(s.stock.lotsOf(riz, ctx.storeId).map((l) => l.qty)).toEqual([4_000]);
    expect(s.stock.movements(ctx.storeId, { articleId: riz, types: ['REGULARIZATION'] }).map((m) => m.qty).sort()).toEqual([-2_000, 2_000]);

    s.admin.setStoreOptions(ctx.userId, ctx.storeId, { ignoreStock: false });
    expect(() => sell(5_000)).toThrow(/il reste 4/);
  });
});

describe('rôles Vendeur et Responsable d’achat', () => {
  beforeEach(() => setup());

  it('ont leurs droits par défaut et se créent', () => {
    expect(s.admin.rights('seller')).toEqual(expect.arrayContaining(['cash', 'credit', 'customers', 'quotes', 'treasury']));
    expect(s.admin.rights('seller')).not.toContain('purchases');
    expect(s.admin.rights('buyer')).toEqual(expect.arrayContaining(['purchases', 'suppliers', 'purchase_orders', 'purchase_invoices', 'stock', 'articles']));
    expect(s.admin.rights('buyer')).not.toContain('cash');
    expect(s.admin.rights('cashier')).not.toContain('cash_open');
    expect(s.admin.rights('manager')).toEqual(expect.arrayContaining(['cash_open', 'central_cash', 'ignore_stock']));
    const v = s.admin.createUser(ctx.userId, { name: 'Paul', login: 'paul', pin: '1111', role: 'seller', storeId: ctx.storeId });
    const a = s.admin.createUser(ctx.userId, { name: 'Marie', login: 'marie', pin: '2222', role: 'buyer', storeId: ctx.storeId });
    expect([v.role, a.role]).toEqual(['seller', 'buyer']);
  });
});

describe('migration 17', () => {
  it('reconstruit les utilisateurs sans perdre les pièces qui les citent', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
    for (const m of MIGRATIONS.filter((x) => x.version <= 16)) {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations VALUES (?, ?, ?)').run(m.version, m.name, '2026-01-01');
    }
    db.exec(`INSERT INTO stores (id, code, name, created_at) VALUES ('st', 'DLA1', 'Akwa', '2026-01-01');
      INSERT INTO registers (id, store_id, number, name, activation_code) VALUES ('rg', 'st', 1, 'Caisse 1', '123456');
      INSERT INTO users (id, name, login, pin_hash, role, created_at) VALUES ('u1', 'Awa', 'awa', 'x', 'cashier', '2026-01-01');
      INSERT INTO cash_sessions (id, store_id, register_id, user_id, opened_at, opening_float, status) VALUES ('cs', 'st', 'rg', 'u1', '2026-01-01', 0, 'open');
      INSERT INTO accounts (id, label) VALUES ('104', 'Exploitant');`);
    migrate(db);
    expect(db.prepare('SELECT role FROM users WHERE id = ?').pluck().get('u1')).toBe('cashier');
    expect(db.prepare('SELECT vat_enabled FROM stores').pluck().get()).toBe(1);
    expect(db.prepare("SELECT role FROM accounts WHERE id IN ('104', '5712') ORDER BY id").pluck().all()).toEqual(['owner', 'central_cash']);
    db.prepare("INSERT INTO users (id, name, login, pin_hash, role, created_at) VALUES ('u2', 'Paul', 'paul', 'x', 'seller', '2026-01-01')").run();
    // Les clés étrangères vers les utilisateurs tiennent toujours.
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(() => db.prepare("INSERT INTO cash_sessions (id, store_id, register_id, user_id, opened_at, opening_float, status) VALUES ('c2', 'st', 'rg', 'nobody', '2026-01-01', 0, 'closed')").run()).toThrow(
      /FOREIGN KEY/,
    );
  });
});
