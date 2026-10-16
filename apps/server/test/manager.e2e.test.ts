import type { INestApplication } from '@nestjs/common';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServices, enrollStation, openDatabase, syncOnce } from '@superette/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/main';

const LOCAL = 'jeton-de-la-fenetre-du-serveur';

describe('page du gérant sur le téléphone', () => {
  let app: INestApplication;
  let url: string;
  let cookie = '';

  beforeAll(async () => {
    app = await createApp({ dataDir: join(mkdtempSync(join(tmpdir(), 'fedo-gerant-')), 'donnees'), port: 0, enrollmentKey: 'cle-enrolement-de-test', localAdminToken: LOCAL });
    await app.listen(0, '127.0.0.1');
    url = await app.getUrl();
    cookie = (await fetch(`${url}/?t=${LOCAL}`, { redirect: 'manual' })).headers.get('set-cookie')!.split(';')[0]!;

    const pc = createServices(openDatabase(':memory:'));
    const { store, register, admin } = pc.admin.bootstrap({ storeCode: 'DLA1', storeName: 'Superette Akwa', adminName: 'Steve', adminLogin: 'steve', adminPin: '1234' });
    const ctx = { storeId: store.id, registerId: register.id, userId: admin.id };
    const tva = pc.admin.listVatRates()[0]!.id;
    const biere = pc.catalogue.saveArticle(admin.id, { name: 'Bière 65 cl', unit: 'piece', vatRateId: tva, purchasePrice: 450, salePrice: 650, alertQty: 10_000 }).id;
    const lait = pc.catalogue.saveArticle(admin.id, { name: 'Lait 1 L', unit: 'piece', vatRateId: tva, purchasePrice: 600, salePrice: 900 }).id;
    const wh = pc.admin.salesWarehouse(store.id).id;
    pc.stock.receive(ctx, { warehouseId: wh, lines: [{ articleId: biere, qty: 12_000, unitCost: 450 }, { articleId: lait, qty: 1_000, unitCost: 600 }] });
    await enrollStation(pc, url, 'cle-enrolement-de-test', 'PC caisse 1');
    pc.pos.openSession(ctx, 0);
    pc.pos.completeSale(ctx, { lines: [{ articleId: biere, qty: 4_000 }], payments: [{ method: 'CASH', amount: 3_000 }] });
    pc.pos.completeSale(ctx, { lines: [{ articleId: lait, qty: 1_000 }], payments: [{ method: 'MTN_MOMO', amount: 900, reference: 'MP-1' }] });
    // 2 600 FCFA en espèces attendus, 2 000 comptés : manque de 600.
    pc.pos.closeSession(ctx, { 1000: 2 }, { gapReason: 'Erreur de monnaie', gapApprovedBy: admin.id });
    await syncOnce(pc);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('sert la page, son manifeste, son service worker et son icône', async () => {
    const page = await fetch(`${url}/gerant`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('/gerant/manifest.webmanifest');
    const manifest = await (await fetch(`${url}/gerant/manifest.webmanifest`)).json();
    expect(manifest).toMatchObject({ start_url: '/gerant', display: 'standalone' });
    expect((await fetch(`${url}/gerant/sw.js`)).headers.get('content-type')).toContain('javascript');
    expect((await fetch(`${url}/gerant/icon.png`)).headers.get('content-type')).toBe('image/png');
  });

  it('refuse les chiffres sans connexion', async () => {
    expect((await fetch(`${url}/admin/api/manager`)).status).toBe(401);
  });

  it('donne les ventes, les caisses, les écarts, les ruptures et les alertes du jour', async () => {
    const d = await (await fetch(`${url}/admin/api/manager`, { headers: { cookie } })).json();
    expect(d).toMatchObject({ today: true, total: 3_500, sales: 2 });
    const s = d.stores[0];
    expect(s).toMatchObject({ name: 'Superette Akwa', sales: 2, total: 3_500, average: 1_750, outOfStockCount: 1, lowStockCount: 1 });
    expect(s.byMethod).toEqual(
      expect.arrayContaining([
        { method: 'CASH', label: 'Espèces', amount: 2_600 },
        { method: 'MTN_MOMO', label: 'MTN MoMo', amount: 900 },
      ]),
    );
    expect(s.registers[0]).toMatchObject({ state: 'closed', sales: 2, total: 3_500, cashier: 'Steve' });
    expect(s.gaps[0]).toMatchObject({ expected: 2_600, counted: 2_000, difference: -600, reason: 'Erreur de monnaie' });
    expect(s.outOfStock[0]).toMatchObject({ name: 'Lait 1 L', qty: 0 });
    expect(s.lowStock[0]).toMatchObject({ name: 'Bière 65 cl', qty: 8_000, alert: 10_000 });
    expect(s.top[0]).toMatchObject({ label: 'Bière 65 cl', qty: 4_000, total: 2_600 });
    expect(d.alerts.map((a: { text: string }) => a.text)).toEqual(expect.arrayContaining([expect.stringContaining('manque de 600'), '1 article(s) en rupture de stock']));
  });

  it('se connecte pour 30 jours depuis le téléphone', async () => {
    await (await fetch(`${url}/admin/api/password`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ password: 'secret-gerant' }) })).text();
    const res = await fetch(`${url}/admin/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'secret-gerant', remember: true }) });
    expect(res.headers.get('set-cookie')).toContain(`Max-Age=${30 * 24 * 3600}`);
  });
});
