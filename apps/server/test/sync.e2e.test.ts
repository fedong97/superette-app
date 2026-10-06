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
  });
});
