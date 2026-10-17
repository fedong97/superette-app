import type { INestApplication } from '@nestjs/common';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Services, createServices, enrollStation, joinStore, openDatabase, resendMissing, syncOnce } from '@superette/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PG } from '../src/database';
import { createApp } from '../src/main';

const KEY = 'cle-enrolement-de-test';

/**
 * Serveur réinstallé : le PC a déjà tout envoyé à l'ancien serveur, sa file
 * d'envoi est vide, et le nouveau serveur n'a pas les produits.
 */
describe('données de référence renvoyées à un serveur qui ne les a pas', () => {
  const apps: INestApplication[] = [];
  let pc: Services;
  let articleId: string;
  let storeId: string;

  const server = async () => {
    const app = await createApp({ dataDir: join(mkdtempSync(join(tmpdir(), 'fedo-serveur-')), 'donnees'), port: 0, enrollmentKey: KEY, localAdminToken: 'jeton' });
    await app.listen(0, '127.0.0.1');
    apps.push(app);
    return app.getUrl();
  };
  const known = async (url: string, entity: string) => {
    const r = await fetch(`${url}/api/v1/sync/known`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${pc.sync.credentials()!.token}` },
      body: JSON.stringify({ entity }),
    });
    return ((await r.json()) as { ids: string[] }).ids;
  };

  beforeAll(async () => {
    pc = createServices(openDatabase(':memory:'));
    const { store, register, admin } = pc.admin.bootstrap({ storeCode: 'DLA1', storeName: 'Superette Akwa', adminName: 'Steve', adminLogin: 'steve', adminPin: '1234' });
    storeId = store.id;
    const tva = pc.admin.listVatRates().find((r) => r.rate_bp === 1925)!.id;
    articleId = pc.catalogue.saveArticle(admin.id, { name: 'Bière 65 cl', unit: 'piece', vatRateId: tva, purchasePrice: 450, salePrice: 650, barcodes: [{ code: '5449000000996' }] }).id;
    pc.stock.receive({ storeId: store.id, registerId: register.id, userId: admin.id }, { warehouseId: pc.admin.salesWarehouse(store.id).id, lines: [{ articleId, qty: 48000, unitCost: 450 }] });
    await enrollStation(pc, await server(), KEY, 'PC 1');
    expect(pc.sync.state().pending).toBe(0);
  });

  afterAll(async () => {
    for (const app of apps) await app.close();
  });

  it('le PC relié à un serveur neuf lui renvoie seul les produits, le stock et les utilisateurs', async () => {
    const url = await server();
    pc.sync.disconnect();
    await enrollStation(pc, url, KEY, 'PC 1');
    expect(await known(url, 'article')).toContain(articleId);
    expect(await known(url, 'user')).toHaveLength(pc.db.prepare('SELECT COUNT(*) FROM users').pluck().get() as number);
    expect((await known(url, 'stock_level')).length).toBeGreaterThan(0);

    // Un nouveau PC qui rejoint ce serveur trouve le catalogue.
    const code = pc.admin.createRegister(pc.db.prepare("SELECT id FROM users WHERE login = 'steve'").pluck().get() as string, storeId).activation_code;
    await syncOnce(pc);
    const pc2 = createServices(openDatabase(':memory:'));
    await joinStore(pc2, url, code, 'PC 2');
    expect(pc2.catalogue.getArticle(articleId).name).toBe('Bière 65 cl');
  });

  it('à la demande, rien ne repart quand le serveur a déjà tout', async () => {
    expect(await resendMissing(pc)).toEqual({ queued: 0 });
    expect(pc.sync.state().pending).toBe(0);
  });

  it('à la demande, seules les données perdues par le serveur repartent', async () => {
    // Le même serveur, mais sans les produits (base restaurée d'avant leur création).
    const url = pc.sync.credentials()!.url;
    const app = apps[apps.length - 1]!;
    await app.get(PG).query("DELETE FROM events WHERE entity = 'article'");
    expect(await known(url, 'article')).toEqual([]);
    expect(await resendMissing(pc)).toEqual({ queued: 1 });
    await syncOnce(pc);
    expect(await known(url, 'article')).toEqual([articleId]);
  });
});
