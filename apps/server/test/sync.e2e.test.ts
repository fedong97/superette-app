import type { INestApplication } from '@nestjs/common';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Context, LicenseService, type Services, createServices, enrollStation, joinStore, openDatabase, syncOnce } from '@superette/db';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/main';

const DATABASE_URL = process.env['TEST_DATABASE_URL'];
const KEY = 'cle-enrolement-de-test';
const LOCAL = 'jeton-de-la-fenetre-du-serveur';
/** Paire de clés de test : l'application et le serveur vérifient les licences avec la clé publique. */
const pair = generateKeyPairSync('ed25519');
const LICENSE_PUB = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
function licenseKey(machine: string, stations: number): string {
  const payload = { v: 1, id: randomUUID(), client: 'Superette Akwa', machine, plan: 'annual', start: '2026-01-01', expires: '2099-12-31', stations, stores: 1, issued: new Date().toISOString() };
  const data = Buffer.from(JSON.stringify(payload));
  return `SG1.${data.toString('base64url')}.${sign(null, data, pair.privateKey).toString('base64url')}`;
}

/**
 * Deux PC du même magasin, puis un deuxième magasin, reliés par un vrai serveur :
 * sur PostgreSQL si TEST_DATABASE_URL est donnée, sinon sur la base intégrée (FEDONIX 360 Serveur pour Windows).
 */
describe.each(DATABASE_URL ? ['postgres', 'integree'] : ['integree'])('synchronisation par le serveur central (base %s)', (base) => {
  let app: INestApplication;
  let url: string;
  let pc1: Services;
  let pc2: Services;
  let ctx1: Context;
  let ctx2: Context;
  let articleId: string;
  let firstSaleId: string;
  let code2: string;

  const fresh = () => {
    const s = createServices(openDatabase(':memory:'));
    const machine = randomUUID();
    s.license = new LicenseService(s.db, () => new Date(), () => s.sync.credentials() !== null, () => machine, LICENSE_PUB);
    return s;
  };
  const stockOf = (s: Services, storeId: string) => s.stock.list(storeId).find((r) => r.article_id === articleId);

  beforeAll(async () => {
    if (base === 'postgres') {
      const pool = new Pool({ connectionString: DATABASE_URL });
      await pool.query('DROP TABLE IF EXISTS mobile_sessions, mobile_counts, mobile_unknowns, mobile_assignments, mobile_pairings, events, devices, licenses, settings, schema_migrations');
      await pool.end();
    }
    const where = base === 'postgres' ? { databaseUrl: DATABASE_URL! } : { dataDir: join(mkdtempSync(join(tmpdir(), 'fedo-serveur-')), 'donnees') };
    app = await createApp({
      ...where,
      port: 0,
      enrollmentKey: KEY,
      licensePublicKey: LICENSE_PUB,
      localAdminToken: LOCAL,
      // Sur PostgreSQL (serveur sur Internet), le premier mot de passe vient de la configuration.
      adminPassword: base === 'postgres' ? 'secret-gerant' : undefined,
    });
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

  it('les notes déclaratives saisies sur un PC arrivent sur l’autre', async () => {
    pc1.disclosures.save(ctx1, 2026, { shareholders: [{ name: 'Steve Fedong', nationality: 'Camerounaise', shares: 100, nominal: 10_000 }], social: 'Tri des cartons.' });
    await syncOnce(pc1);
    await syncOnce(pc2);
    const got = pc2.disclosures.get(ctx1.storeId, 2026);
    expect(got.shareholders).toEqual([{ name: 'Steve Fedong', nationality: 'Camerounaise', shares: 100, nominal: 10_000 }]);
    expect(got.social).toBe('Tri des cartons.');
    expect(got.updatedBy).toBe(pc1.admin.getUser(ctx1.userId).name);
  });

  it('une promotion créée sur un PC s’applique sur l’autre et ses ventes remontent', async () => {
    const promo = pc1.promotions.save(ctx1.userId, { name: 'Coca 2 pour 1', kind: 'x_for_y', articleId, storeId: null, startsOn: '2000-01-01', endsOn: '2100-12-31', buyQty: 2, payQty: 1 });
    await syncOnce(pc1);
    await syncOnce(pc2);
    expect(pc2.promotions.activeRules(ctx2.storeId).map((r) => r.id)).toEqual([promo.id]);
    const sale = pc2.pos.completeSale(ctx2, { lines: [{ articleId, qty: 2000 }], payments: [{ method: 'CASH', amount: 650 }] });
    expect(sale.total_promo).toBe(650);
    await syncOnce(pc2);
    await syncOnce(pc1);
    expect(pc1.promotions.get(promo.id)).toMatchObject({ sold_qty: 2000, given: 650 });
    pc1.promotions.setActive(ctx1.userId, promo.id, false);
    await syncOnce(pc1);
    await syncOnce(pc2);
    expect(pc2.promotions.activeRules(ctx2.storeId)).toEqual([]);
  });

  it('les conditionnements et le tarif de gros d’un article voyagent, et un carton vendu sur le PC 2 remonte', async () => {
    const tva = pc1.admin.listVatRates().find((r) => r.rate_bp === 1925)!.id;
    const jus = pc1.catalogue.saveArticle(ctx1.userId, {
      name: 'Jus Top 1 L',
      unit: 'piece',
      unitName: 'Bouteille',
      vatRateId: tva,
      purchasePrice: 500,
      salePrice: 800,
      packs: [
        { name: 'Palette', contains: 80, salePrice: 360_000, purchase: true },
        { name: 'Pack', contains: 6, salePrice: 4_500, wholesalePrice: 4_200 },
      ],
    });
    await syncOnce(pc1);
    await syncOnce(pc2);
    const onPc2 = pc2.catalogue.getArticle(jus.id);
    expect(onPc2.packs.map((p) => [p.name, p.units, p.sale_price])).toEqual([
      ['Palette', 480_000, 360_000],
      ['Pack', 6000, 4_500],
    ]);
    expect(onPc2.unit_name).toBe('Bouteille');
    // Un produit épuisé ne se vend pas : le PC 2 reçoit d'abord un pack.
    pc2.stock.receive(ctx2, { warehouseId: pc2.admin.salesWarehouse(ctx2.storeId).id, lines: [{ articleId: jus.id, qty: 12_000, unitCost: 500 }] });
    const sale = pc2.pos.completeSale(ctx2, { lines: [{ articleId: jus.id, qty: 12_000, packId: onPc2.packs[1]!.id }], payments: [{ method: 'CASH', amount: 9_000 }] });
    await syncOnce(pc2);
    await syncOnce(pc1);
    expect(pc1.pos.getSale(sale.id).lines[0]).toMatchObject({ pack_name: 'Pack', pack_units: 6000, pack_price: 4_500, total_ttc: 9_000 });
  });

  it("un autre magasin reçoit le catalogue mais pas les ventes ni le stock d'Akwa", async () => {
    const yde = pc1.admin.createStore(ctx1.userId, { storeCode: 'YDE1', storeName: 'Superette Bastos' });
    const reg = pc1.admin.createRegister(ctx1.userId, yde.id);
    await syncOnce(pc1);
    const pc3 = fresh();
    const station = await joinStore(pc3, url, reg.activation_code, 'PC Yaoundé');
    expect(station?.store.code).toBe('YDE1');
    expect(pc3.db.prepare('SELECT COUNT(*) FROM articles').pluck().get()).toBe(4);
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

  // --- 0.29.0 : inventaires, transferts, corrections, ristournes et fabrication entre PC ---------------

  const both = async () => {
    await syncOnce(pc1);
    await syncOnce(pc2);
    await syncOnce(pc1);
  };
  const qtyIn = (s: Services, warehouseId: string, id = articleId) => s.stock.list(ctx1.storeId, { warehouseId }).find((r) => r.article_id === id)?.qty ?? 0;

  it('une ristourne accordée sur le PC 1 ne bloque plus la synchronisation et arrive sur le PC 2', async () => {
    const client = pc1.customers.listCustomers(ctx1.storeId).find((c) => c.name === 'Restaurant Chez Mballa')!;
    pc1.rebates.saveRules(ctx1, client.id, [{ familyId: null, rateBp: 500, unitAmount: 0, minQty: 0, pickupFee: 0 }]);
    pc1.rebates.setCustomer(ctx1, client.id, { enabled: true, delivered: true });
    pc1.rebates.adjust(ctx1, client.id, 1_000, 'Reprise de l’ancien logiciel');
    pc1.rebates.grant(ctx1, client.id, 1_000, 'credit');
    await both();
    expect(pc1.sync.state()).toMatchObject({ pending: 0, lastError: null });
    expect(pc2.rebates.balance(ctx1.storeId, client.id)).toBe(0);
    expect(pc2.rebates.entries(ctx1.storeId, { customerId: client.id }).map((e) => e.kind)).toEqual(['credit', 'adjust']);
    expect(pc2.rebates.rules({ customerId: client.id })).toMatchObject([{ rate_bp: 500 }]);
    expect(pc2.rebates.customers().find((c) => c.id === client.id)).toMatchObject({ rebate_enabled: 1, rebate_delivered: 1 });
    for (const s of [pc1, pc2]) expect(s.customers.account(ctx1.storeId, client.id).balance).toBe(1_500);
  });

  it('un inventaire ouvert sur le PC 1 se compte à deux et se clôture sur le PC 2', async () => {
    const wh = pc1.admin.salesWarehouse(ctx1.storeId).id;
    const tva = pc1.admin.listVatRates()[0]!.id;
    const eau = pc1.catalogue.saveArticle(ctx1.userId, { name: 'Eau 1,5 L', unit: 'piece', vatRateId: tva, purchasePrice: 250, salePrice: 400 }).id;
    pc1.stock.receive(ctx1, { warehouseId: wh, lines: [{ articleId: eau, qty: 30_000, unitCost: 250 }] });
    const inv = pc1.inventories.create(ctx1, { warehouseId: wh, kind: 'partial', articleIds: [articleId, eau] });
    await both();
    const before = qtyIn(pc1, wh);
    pc1.inventories.setCount(ctx1, inv.id, articleId, before - 2_000);
    pc2.inventories.setCount(ctx2, inv.id, eau, 28_000);
    await both();
    for (const s of [pc1, pc2]) expect(s.inventories.get(inv.id).lines.map((l) => l.counted)).toEqual(expect.arrayContaining([before - 2_000, 28_000]));
    expect(pc2.inventories.history(inv.id).reduce((t, h) => t + h.count, 0)).toBe(2);
    pc2.inventories.close(ctx2, inv.id);
    await both();
    for (const s of [pc1, pc2]) {
      expect(s.inventories.get(inv.id).inventory.status).toBe('closed');
      expect(qtyIn(s, wh)).toBe(before - 2_000);
      expect(qtyIn(s, wh, eau)).toBe(28_000);
    }
    expect(() => pc1.inventories.setCount(ctx1, inv.id, eau, 1_000)).toThrow();
  });

  it('un transfert expédié sur le PC 1 est réceptionné sur le PC 2, avec des numéros propres à chaque poste', async () => {
    const shop = pc1.admin.salesWarehouse(ctx1.storeId).id;
    const reserve = pc1.admin.listWarehouses(ctx1.storeId).find((w) => w.id !== shop)!.id;
    pc1.stock.receive(ctx1, { warehouseId: reserve, lines: [{ articleId, qty: 24_000, unitCost: 450 }] });
    const t = pc1.transfers.create(ctx1, { fromWarehouseId: reserve, toWarehouseId: shop, lines: [{ articleId, qty: 12_000 }] });
    const t2 = pc2.transfers.create(ctx2, { fromWarehouseId: reserve, toWarehouseId: shop, lines: [{ articleId, qty: 1_000 }] });
    expect(String(t.number)).toMatch(/^DLA11-/);
    expect(String(t2.number)).toMatch(/^DLA12-/);
    pc1.transfers.ship(ctx1, t.id, 'BR-1');
    const shopBefore = qtyIn(pc1, shop);
    await both();
    expect(pc2.transfers.get(t.id).transfer.status).toBe('shipped');
    pc2.transfers.receive(ctx2, t.id, { receptionNumber: 'RC-1', lines: [{ articleId, receivedQty: 11_000 }] });
    await both();
    for (const s of [pc1, pc2]) {
      expect(s.transfers.get(t.id).transfer).toMatchObject({ status: 'received', reception_number: 'RC-1' });
      expect(qtyIn(s, reserve)).toBe(12_000);
      expect(qtyIn(s, shop)).toBe(shopBefore + 11_000);
    }
  });

  it('une correction demandée sur le PC 2 est validée sur le PC 1, et le stock bouge partout', async () => {
    const wh = pc1.admin.salesWarehouse(ctx1.storeId).id;
    const before = qtyIn(pc2, wh);
    const r = pc2.monitoring.request(ctx2, { articleId, warehouseId: wh, newQty: before - 1_000, reason: 'Bouteille cassée' });
    await both();
    expect(pc1.monitoring.requests(ctx1.storeId, { status: 'pending' }).map((x) => x.id)).toContain(r.id);
    pc1.monitoring.decide(ctx1, r.id, true, null);
    await both();
    for (const s of [pc1, pc2]) {
      expect(s.monitoring.requests(ctx1.storeId, { id: r.id })[0]!.status).toBe('approved');
      expect(qtyIn(s, wh)).toBe(before - 1_000);
    }
  });

  it('une recette créée sur le PC 1 sert à fabriquer sur le PC 2', async () => {
    const wh = pc1.admin.salesWarehouse(ctx1.storeId).id;
    const tva = pc1.admin.listVatRates()[0]!.id;
    const pack = pc1.catalogue.saveArticle(ctx1.userId, { name: 'Pack fête 6 bières', unit: 'piece', vatRateId: tva, purchasePrice: 0, salePrice: 4_500 }).id;
    const recipe = pc1.production.saveRecipe(ctx1, { articleId: pack, yieldQty: 1_000, lines: [{ articleId, qty: 6_000 }] });
    await both();
    const before = qtyIn(pc2, wh);
    const order = pc2.production.create(ctx2, { recipeId: recipe.id, warehouseId: wh, qty: 2_000 });
    pc2.production.produce(ctx2, order.id);
    await both();
    for (const s of [pc1, pc2]) {
      expect(s.production.getOrder(order.id).status).toBe('done');
      expect(qtyIn(s, wh)).toBe(before - 12_000);
      expect(qtyIn(s, wh, pack)).toBe(2_000);
    }
  });

  // --- 0.36.0 : stock multi-magasin ----------------------------------------------------------------

  it('le stock de chaque magasin arrive dans « Stock multi-magasin » des autres magasins', async () => {
    const bfn = pc1.admin.createStore(ctx1.userId, { storeCode: 'BFN1', storeName: 'Superette Bafoussam' });
    const reg = pc1.admin.createRegister(ctx1.userId, bfn.id);
    await syncOnce(pc1);
    const pc4 = fresh();
    await joinStore(pc4, url, reg.activation_code, 'PC Bafoussam');
    const user = pc4.db.prepare("SELECT id FROM users WHERE role = 'admin'").pluck().get() as string;
    const bfnWh = pc4.admin.salesWarehouse(bfn.id).id;
    pc4.stock.receive({ storeId: bfn.id, registerId: reg.id, userId: user }, { warehouseId: bfnWh, lines: [{ articleId, qty: 12_000, unitCost: 450 }] });
    await syncOnce(pc4);
    await syncOnce(pc1);
    await syncOnce(pc4);
    // Akwa : tous ses dépôts (surface de vente, réserve…).
    const akwa = pc1.db
      .prepare('SELECT SUM(s.qty) FROM stock s JOIN warehouses w ON w.id = s.warehouse_id WHERE w.store_id = ? AND s.article_id = ?')
      .pluck()
      .get(ctx1.storeId, articleId) as number;
    const onPc1 = pc1.controls.stockByStore(ctx1.storeId, {}).rows.find((r) => r.article_id === articleId)!;
    expect(onPc1.byStore[bfn.id]).toBe(12_000);
    expect(onPc1.byStore[ctx1.storeId]).toBe(akwa);
    const onPc4 = pc4.controls.stockByStore(bfn.id, {});
    expect(onPc4.rows.find((r) => r.article_id === articleId)!.byStore).toMatchObject({ [ctx1.storeId]: akwa, [bfn.id]: 12_000 });
    expect(onPc4.stores.find((x) => x.id === ctx1.storeId)!.updated_at).not.toBeNull();
    // Les mouvements, eux, restent dans leur magasin.
    expect(pc4.db.prepare('SELECT COUNT(*) FROM stock_movements WHERE warehouse_id = ?').pluck().get(pc1.admin.salesWarehouse(ctx1.storeId).id)).toBe(0);
  });

  it('la licence activée sur le PC 1 arrive sur le PC 2 et limite le nombre de PC', async () => {
    expect(pc2.license.status().state).toBe('trial');
    pc1.license.activate(ctx1.userId, licenseKey(pc1.license.machineCode(), 2));
    await syncOnce(pc1);
    await syncOnce(pc2);
    expect(pc2.license.current()?.machine).toBe(pc1.license.machineCode());
    expect(pc2.license.status()).toMatchObject({ state: 'valid', canSell: true });

    const code3 = pc1.admin.createRegister(ctx1.userId, ctx1.storeId).activation_code;
    await syncOnce(pc1);
    await expect(joinStore(fresh(), url, code3, 'PC caisse 3')).rejects.toThrow('permet 2 PC');
  });
  describe("l'interface du serveur", () => {
    let cookie = '';
    const get = (path: string, c = cookie) => fetch(`${url}${path}`, { headers: { cookie: c } });
    const post = (path: string, body?: unknown, c = cookie) =>
      fetch(`${url}${path}`, { method: 'POST', headers: { cookie: c, 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });

    it("s'ouvre sans mot de passe dans la fenêtre du serveur, et refuse les autres", async () => {
      expect((await get('/admin/api/overview', '')).status).toBe(401);
      expect((await fetch(`${url}/?t=mauvais`, { redirect: 'manual' })).headers.get('set-cookie')).toBeNull();
      const res = await fetch(`${url}/?t=${LOCAL}`, { redirect: 'manual' });
      expect(res.status).toBe(302);
      cookie = res.headers.get('set-cookie')!.split(';')[0]!;
      expect((await (await get('/admin/api/session')).json()).authenticated).toBe(true);
      expect(await (await get('/')).text()).toContain('FEDONIX 360 Serveur');
    });

    it('montre les postes, les ventes du jour et le journal des opérations', async () => {
      const o = await (await get('/admin/api/overview')).json();
      expect(o.database).toBe(base);
      expect(o.devices.filter((d: { revoked: boolean }) => !d.revoked).length).toBeGreaterThanOrEqual(2);
      expect(o.devices.find((d: { name: string }) => d.name === 'PC caisse 1')).toMatchObject({ store: 'Superette Akwa', online: true });
      const akwa = o.stores.find((x: { name: string }) => x.name === 'Superette Akwa');
      expect(akwa.sales).toBeGreaterThan(0);
      expect(o.events.total).toBeGreaterThan(10);

      const ventes = await (await get('/admin/api/events?group=ventes')).json();
      expect(ventes[0]).toMatchObject({ type: expect.any(String), device: expect.any(String) });
      expect(ventes.some((e: { type: string; summary: string }) => e.type === 'Vente' && e.summary.includes('FCFA'))).toBe(true);
      const jours = await (await get('/admin/api/sales')).json();
      expect(jours[0].stores.length).toBeGreaterThan(0);
    });

    it('un mot de passe ouvre l\'interface depuis un autre PC', async () => {
      if (base === 'integree') expect((await post('/admin/api/first-password', { password: 'secret-gerant' })).status).toBe(200);
      // Le premier mot de passe ne se choisit qu'une fois.
      expect((await post('/admin/api/first-password', { password: 'autre-secret' })).status).toBe(400);
      expect((await post('/admin/api/login', { password: 'faux-mot' }, '')).status).toBe(401);
      const ok = await post('/admin/api/login', { password: 'secret-gerant' }, '');
      expect(ok.status).toBe(200);
      const other = ok.headers.get('set-cookie')!.split(';')[0]!;
      expect((await get('/admin/api/overview', other)).status).toBe(200);
    });

    it.skipIf(base !== 'integree')('sauvegarde la base et la restaure', async () => {
      const before = (await (await get('/admin/api/overview')).json()).events.total;
      const saved = await (await post('/admin/api/backups')).json();
      expect(saved.name).toMatch(/^fedo-serveur-.*\.tar\.gz$/);
      expect(saved.size).toBeGreaterThan(1000);
      const file = await get(`/admin/api/backups/${saved.name}`);
      expect(file.headers.get('content-disposition')).toContain(saved.name);

      // Une vente arrive après la sauvegarde…
      pc1.pos.completeSale(ctx1, { lines: [{ articleId, qty: 1000 }], payments: [{ method: 'CASH', amount: 650 }] });
      await syncOnce(pc1);
      expect((await (await get('/admin/api/overview')).json()).events.total).toBeGreaterThan(before);

      // … et la restauration ramène la base à l'état sauvegardé, en gardant une copie de l'état d'avant.
      expect((await post(`/admin/api/backups/${saved.name}/restore`)).status).toBe(200);
      expect((await (await get('/admin/api/overview')).json()).events.total).toBe(before);
      const list = await (await get('/admin/api/backups')).json();
      expect(list.some((b: { name: string }) => b.name.includes('avant-restauration'))).toBe(true);
      // Le serveur continue de faire passer les opérations : un client créé sur le PC 2 arrive sur le PC 1.
      const client = pc2.customers.saveCustomer(ctx2.userId, { name: 'Client après restauration' });
      await syncOnce(pc2);
      await syncOnce(pc1);
      expect(pc2.sync.state().lastError).toBeNull();
      expect(pc1.db.prepare('SELECT name FROM customers WHERE id = ?').pluck().get(client.id)).toBe('Client après restauration');
    });
  });
});
