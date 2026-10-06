import type { INestApplication } from '@nestjs/common';
import { type Context, type Services, createServices, enrollStation, joinStore, openDatabase, syncOnce } from '@superette/db';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/main';

const DATABASE_URL = process.env['TEST_DATABASE_URL'];
const KEY = 'cle-enrolement-de-test';

/** Deux PC du même magasin, puis un deuxième magasin, reliés par un vrai serveur et une vraie base PostgreSQL. */
describe.skipIf(!DATABASE_URL)('synchronisation par le serveur central', () => {
  let app: INestApplication;
  let url: string;
  let pc1: Services;
  let pc2: Services;
  let ctx1: Context;
  let ctx2: Context;
  let articleId: string;
  let firstSaleId: string;
  let code2: string;

  const fresh = () => createServices(openDatabase(':memory:'));
  const stockOf = (s: Services, storeId: string) => s.stock.list(storeId).find((r) => r.article_id === articleId);

  beforeAll(async () => {
    const pool = new Pool({ connectionString: DATABASE_URL });
    await pool.query('DROP TABLE IF EXISTS events, devices, schema_migrations');
    await pool.end();
    app = await createApp({ databaseUrl: DATABASE_URL!, port: 0, enrollmentKey: KEY });
    await app.listen(0, '127.0.0.1');
    url = await app.getUrl();

    pc1 = fresh();
    const { store, register, admin } = pc1.admin.bootstrap({ storeCode: 'DLA1', storeName: 'Superette Akwa', adminName: 'Steve', adminLogin: 'steve', adminPin: '1234' });
    ctx1 = { storeId: store.id, registerId: register.id, userId: admin.id };
    const tva = pc1.admin.listVatRates().find((r) => r.rate_bp === 1925)!.id;
    articleId = pc1.catalogue.saveArticle(admin.id, {
      name: 'Bière 65 cl',
      unit: 'piece',
      vatRateId: tva,
      purchasePrice: 450,
      salePrice: 650,
      barcodes: [{ code: '5449000000996' }],
    }).id;
    pc1.stock.receive(ctx1, { warehouseId: pc1.admin.salesWarehouse(store.id).id, lines: [{ articleId, qty: 48000, unitCost: 450 }] });
    code2 = pc1.admin.createRegister(admin.id, store.id).activation_code;
  });

  afterAll(async () => {
    await app?.close();
  });

  it("refuse une clé d'enrôlement incorrecte", async () => {
    await expect(enrollStation(pc1, url, 'mauvaise-cle-123', 'PC caisse 1')).rejects.toThrow("Clé d'enrôlement incorrecte");
    expect(pc1.sync.state().connected).toBe(false);
  });

  it("relie le premier PC et envoie tout l'historique", async () => {
    const result = await enrollStation(pc1, url, KEY, 'PC caisse 1');
    expect(result.sent).toBeGreaterThan(5);
    expect(pc1.sync.state()).toMatchObject({ connected: true, pending: 0, lastError: null });
  });

  it("un nouveau PC rejoint le magasin avec le code d'activation de la caisse 2", async () => {
    pc2 = fresh();
    const station = await joinStore(pc2, url, code2, 'PC caisse 2');
    expect(station?.register?.number).toBe(2);
    expect(pc2.admin.login('steve', '1234').role).toBe('admin');
    expect(pc2.catalogue.scan('5449000000996', station!.store.id)?.article.id).toBe(articleId);
    expect(stockOf(pc2, station!.store.id)).toMatchObject({ qty: 48000, avg_cost: 450 });
    ctx2 = { storeId: station!.store.id, registerId: station!.register!.id, userId: ctx1.userId };

    await expect(joinStore(fresh(), url, code2, 'PC volé')).rejects.toThrow('déjà reliée');
  });

  it('les ventes faites hors ligne sur les deux caisses donnent le même stock partout', async () => {
    pc1.pos.openSession(ctx1, 0);
    pc2.pos.openSession(ctx2, 0);
    firstSaleId = pc1.pos.completeSale(ctx1, { lines: [{ articleId, qty: 2000 }], payments: [{ method: 'CASH', amount: 1300 }] }).id;
    const sale2 = pc2.pos.completeSale(ctx2, { lines: [{ articleId, qty: 6000 }], payments: [{ method: 'CASH', amount: 3900 }] });
    expect(sale2.number).toBe('DLA1-2-000001');

    await syncOnce(pc1);
    await syncOnce(pc2);
    await syncOnce(pc1);
    for (const s of [pc1, pc2]) expect(stockOf(s, ctx1.storeId)).toMatchObject({ qty: 40000, avg_cost: 450 });
    expect(pc1.pos.getSale(sale2.id).total_ttc).toBe(3900);
  });

  it('une réception sur le PC 2 recalcule le même CMUP sur le PC 1', async () => {
    pc2.stock.receive(ctx2, { warehouseId: pc2.admin.salesWarehouse(ctx2.storeId).id, lines: [{ articleId, qty: 40000, unitCost: 500 }] });
    await syncOnce(pc2);
    await syncOnce(pc1);
    for (const s of [pc1, pc2]) expect(stockOf(s, ctx1.storeId)).toMatchObject({ qty: 80000, avg_cost: 475 });
  });

  it('les codes articles créés sur deux postes ne se chevauchent pas', async () => {
    const tva = pc1.admin.listVatRates().find((r) => r.rate_bp === 1925)!.id;
    const a1 = pc1.catalogue.saveArticle(ctx1.userId, { name: 'Lait 1 L', unit: 'piece', vatRateId: tva, purchasePrice: 600, salePrice: 900 });
    const a2 = pc2.catalogue.saveArticle(ctx2.userId, { name: 'Sucre 1 kg', unit: 'piece', vatRateId: tva, purchasePrice: 700, salePrice: 1000 });
    expect(a1.code).toBe('DLA11-00002');
    expect(a2.code).toBe('DLA12-00001');
    await syncOnce(pc1);
    await syncOnce(pc2);
    await syncOnce(pc1);
    expect(pc1.catalogue.getArticle(a2.id).name).toBe('Sucre 1 kg');
    expect(pc2.catalogue.getArticle(a1.id).name).toBe('Lait 1 L');
    expect(pc1.sync.state().conflicts + pc2.sync.state().conflicts).toBe(0);
  });

  it("un retour sur le PC 2 d'un ticket du PC 1 remet le stock partout", async () => {
    const original = pc2.pos.getSale(firstSaleId);
    pc2.pos.returnSale(ctx2, {
      originalSaleId: firstSaleId,
      lines: [{ lineId: original.lines[0]!.id, qty: 2000 }],
      refundMethod: 'CASH',
      supervisorId: ctx1.userId,
      reason: 'Bouteilles cassées',
    });
    await syncOnce(pc2);
    await syncOnce(pc1);
    for (const s of [pc1, pc2]) expect(stockOf(s, ctx1.storeId)?.qty).toBe(82000);
  });

  it('une commande passée sur le PC 1 est réceptionnée sur le PC 2', async () => {
    const sabc = pc1.purchases.saveSupplier(ctx1.userId, { name: 'SABC', paymentTermsDays: 30 });
    pc1.purchases.setSupplierArticle(ctx1.userId, { supplierId: sabc.id, articleId, unitCost: 450, packQty: 12_000 });
    const order = pc1.purchases.createOrder(ctx1, { supplierId: sabc.id, warehouseId: pc1.admin.salesWarehouse(ctx1.storeId).id, lines: [{ articleId, qty: 24_000, unitCost: 450 }] });
    pc1.purchases.setOrderStatus(ctx1, order.id, 'sent');
    await syncOnce(pc1);
    await syncOnce(pc2);
    expect(pc2.purchases.articleSuppliers(articleId)[0]?.supplier_name).toBe('SABC');
    const remote = pc2.purchases.getOrder(order.id);
    const r = pc2.purchases.receiveOrder(ctx2, order.id, { deliveryNote: 'BL 9', lines: [{ orderLineId: remote.lines[0]!.id, articleId, qty: 12_000, unitCost: 450 }] });
    await syncOnce(pc2);
    await syncOnce(pc1);
    expect(pc1.purchases.getOrder(order.id).state).toBe('partial');
    expect(pc1.purchases.getReception(r.id).total_ht).toBe(5_400);
    for (const s of [pc1, pc2]) expect(stockOf(s, ctx1.storeId)?.qty).toBe(94_000);
  });

  it('une vente à crédit sur le PC 2, réglée sur le PC 1, donne le même compte client partout', async () => {
    const client = pc1.customers.saveCustomer(ctx1.userId, { name: 'Restaurant Chez Mballa', creditLimit: 100_000 });
    await syncOnce(pc1);
    await syncOnce(pc2);
    pc2.pos.completeSale(ctx2, { lines: [{ articleId, qty: 10_000 }], payments: [{ method: 'CUSTOMER_CREDIT', amount: 6_500 }], customerId: client.id });
    await syncOnce(pc2);
    await syncOnce(pc1);
    pc1.customers.receivePayment(ctx1, { customerId: client.id, method: 'MTN_MOMO', amount: 4_000, reference: 'MP1' });
    await syncOnce(pc1);
    await syncOnce(pc2);
    for (const s of [pc1, pc2]) expect(s.customers.account(ctx1.storeId, client.id)).toMatchObject({ balance: 2_500, available: 97_500 });
  });

  it('le plan comptable et les écritures manuelles du PC 1 donnent la même balance sur le PC 2', async () => {
    pc1.accounting.saveAccount(ctx1.userId, { id: '5711', label: 'Caisse magasin', role: 'cash' });
    pc1.accounting.addManualEntry(ctx1, {
      journal: 'BQ',
      date: '2026-10-06',
      label: 'Frais de tenue de compte',
      lines: [
        { account: '631', debit: 2_500, credit: 0 },
        { account: '521', debit: 0, credit: 2_500 },
      ],
    });
    await syncOnce(pc1);
    await syncOnce(pc2);
    expect(pc2.accounting.listAccounts().filter((a) => a.role === 'cash').map((a) => a.id)).toEqual(['5711']);
    expect(pc2.accounting.trialBalance(ctx1.storeId)).toEqual(pc1.accounting.trialBalance(ctx1.storeId));
    expect(pc2.accounting.entries(ctx1.storeId, { journal: 'BQ' }).find((e) => e.source === 'manual')?.label).toBe('Frais de tenue de compte');
  });

  it('une dépense saisie sur le PC 2 et annulée sur le PC 1 reste annulée partout', async () => {
    pc1.expenses.saveCategory(ctx1.userId, { id: 'cat-divers', name: 'Divers et imprévus', accountId: '638' });
    await syncOnce(pc1);
    await syncOnce(pc2);
    expect(pc2.expenses.listCategories().find((c) => c.id === 'cat-divers')?.account_id).toBe('638');
    const dep = pc2.expenses.record(ctx2, { categoryId: 'cat-divers', label: 'Réparation balance', amount: 7_500, method: 'CASH' });
    await syncOnce(pc2);
    await syncOnce(pc1);
    pc1.expenses.cancel(ctx1, dep.id, ctx1.userId, 'Payée par le fournisseur');
    await syncOnce(pc1);
    await syncOnce(pc2);
    for (const s of [pc1, pc2]) expect(s.expenses.get(dep.id)).toMatchObject({ status: 'cancelled', account_id: '638' });
  });

  it('un devis fait sur le PC 1 et facturé sur le PC 2 est marqué facturé partout', async () => {
    const q = pc1.quotes.save(ctx1, { kind: 'proforma', customerName: 'Hôtel La Falaise', lines: [{ articleId, qty: 4000 }] });
    await syncOnce(pc1);
    await syncOnce(pc2);
    const lines = pc2.quotes.saleLines(ctx2.storeId, q.id);
    const sale = pc2.pos.completeSale(ctx2, { lines, payments: [{ method: 'CASH', amount: q.total_ttc }], quoteId: q.id });
    await syncOnce(pc2);
    await syncOnce(pc1);
    for (const s of [pc1, pc2]) expect(s.quotes.get(q.id)).toMatchObject({ state: 'accepted', sale_number: sale.number });
  });

  it('un relevé importé sur les deux PC ne se double pas, et le pointage voyage', async () => {
    const line = { date: '2026-10-06', label: 'FRAIS TENUE DE COMPTE', reference: null, amount: -5_000 };
    expect(pc1.reconciliation.importLines(ctx1, '521', [line])).toEqual({ added: 1, duplicates: 0 });
    expect(pc2.reconciliation.importLines(ctx2, '521', [line])).toEqual({ added: 1, duplicates: 0 });
    const id = pc1.reconciliation.bankLines(ctx1.storeId, '521')[0]!.id;
    pc1.reconciliation.bookLine(ctx1, id, { account: '631' });
    await syncOnce(pc1);
    await syncOnce(pc2);
    await syncOnce(pc1);
    for (const s of [pc1, pc2]) {
      const st = s.reconciliation.state(ctx1.storeId, '521', '2026-12-31');
      expect(st.bankOnly).toEqual([]);
      expect(st.matched.map((m) => m.bank.id)).toEqual([id]);
    }
  });

  it('les paramètres fiscaux saisis sur un PC arrivent sur l’autre, sans doublon', async () => {
    pc2.tax.saveSettings(ctx2, 2026, { regime: 'simplifie' });
    pc1.tax.saveSettings(ctx1, 2026, { form: 'individual', priorLosses: 250_000 });
    await syncOnce(pc2);
    await syncOnce(pc1);
    await syncOnce(pc2);
    // Les deux saisies peuvent tomber dans la même milliseconde : peu importe laquelle l'emporte, tous les PC gardent la même.
    const [a, b] = [pc1, pc2].map((s) => s.tax.settings(ctx1.storeId, 2026));
    expect(a).toEqual(b);
    expect(JSON.stringify([a!.form, a!.regime, a!.priorLosses])).toBeOneOf([JSON.stringify(['individual', 'reel', 250_000]), JSON.stringify(['company', 'simplifie', 0])]);
    for (const s of [pc1, pc2]) expect(s.db.prepare('SELECT COUNT(*) FROM tax_years').pluck().get()).toBe(1);
  });

  it("un autre magasin reçoit le catalogue mais pas les ventes ni le stock d'Akwa", async () => {
    const yde = pc1.admin.createStore(ctx1.userId, { storeCode: 'YDE1', storeName: 'Superette Bastos' });
    const reg = pc1.admin.createRegister(ctx1.userId, yde.id);
    await syncOnce(pc1);
    const pc3 = fresh();
    const station = await joinStore(pc3, url, reg.activation_code, 'PC Yaoundé');
    expect(station?.store.code).toBe('YDE1');
    expect(pc3.db.prepare('SELECT COUNT(*) FROM articles').pluck().get()).toBe(3);
    expect(pc3.db.prepare('SELECT COUNT(*) FROM sales').pluck().get()).toBe(0);
    expect(pc3.db.prepare('SELECT COUNT(*) FROM stock_movements').pluck().get()).toBe(0);
    expect(pc3.purchases.listSuppliers().map((f) => f.name)).toEqual(['SABC']);
    expect(pc3.db.prepare('SELECT COUNT(*) FROM purchase_orders').pluck().get()).toBe(0);
    const client = pc3.customers.listCustomers(station!.store.id);
    expect(client.map((c) => [c.name, c.balance])).toEqual([['Restaurant Chez Mballa', 0]]);
    expect(pc3.accounting.listAccounts().find((a) => a.role === 'cash')?.id).toBe('5711');
    expect(pc3.db.prepare('SELECT COUNT(*) FROM manual_entries').pluck().get()).toBe(0);
    expect(pc3.db.prepare('SELECT COUNT(*) FROM expenses').pluck().get()).toBe(0);
    expect(pc3.expenses.listCategories().find((c) => c.id === 'cat-divers')?.name).toBe('Divers et imprévus');
  });
});
