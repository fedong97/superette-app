import type { INestApplication } from '@nestjs/common';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Services, changeServerUrl, createServices, enrollStation, joinStore, openDatabase, syncOnce } from '@superette/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BackupService } from '../src/backup.service';
import { createApp } from '../src/main';

const KEY = 'cle-enrolement-de-test';
const LOCAL = 'jeton-de-la-fenetre';

/**
 * Le PC qui portait le serveur tombe en panne : sa sauvegarde est remise sur un
 * autre PC, ou un serveur neuf est installé sans sauvegarde. Les caisses doivent
 * renvoyer ce que le serveur a perdu et continuer à se voir les unes les autres.
 */
describe('reprise après la panne du serveur', () => {
  const apps: INestApplication[] = [];
  let pc1: Services;
  let pc2: Services;
  let ctx1: { storeId: string; registerId: string; userId: string };
  let tva: string;
  let admin: string;
  let storeId: string;
  let biere: string;

  const server = async (dir = mkdtempSync(join(tmpdir(), 'fedo-reprise-'))) => {
    const app = await createApp({ dataDir: join(dir, 'donnees'), backupDir: join(dir, 'Sauvegardes'), port: 0, enrollmentKey: KEY, localAdminToken: LOCAL });
    await app.listen(0, '127.0.0.1');
    apps.push(app);
    return { app, url: await app.getUrl(), dir };
  };
  const known = async (url: string, pc: Services, entity: string) => {
    const r = await fetch(`${url}/api/v1/sync/known`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${pc.sync.credentials()!.token}` },
      body: JSON.stringify({ entity }),
    });
    return ((await r.json()) as { ids: string[] }).ids;
  };
  const article = (name: string) => pc1.catalogue.saveArticle(admin, { name, unit: 'piece', vatRateId: tva, purchasePrice: 400, salePrice: 600 }).id;
  const sell = (articleId: string) => pc1.pos.completeSale(ctx1, { lines: [{ articleId, qty: 1_000 }], payments: [{ method: 'CASH', amount: 600 }] });
  const has = (pc: Services, id: string) => Boolean(pc.db.prepare('SELECT 1 FROM articles WHERE id = ?').get(id));

  beforeAll(async () => {
    const { url } = await server();
    pc1 = createServices(openDatabase(':memory:'));
    const boot = pc1.admin.bootstrap({ storeCode: 'DLA1', storeName: 'Superette Akwa', adminName: 'Steve', adminLogin: 'steve', adminPin: '1234' });
    storeId = boot.store.id;
    admin = boot.admin.id;
    ctx1 = { storeId, registerId: boot.register.id, userId: admin };
    tva = pc1.admin.listVatRates()[0]!.id;
    biere = article('Bière 65 cl');
    pc1.stock.receive(ctx1, { warehouseId: pc1.admin.salesWarehouse(storeId).id, lines: [{ articleId: biere, qty: 100_000, unitCost: 400 }] });
    await enrollStation(pc1, url, KEY, 'PC 1');
    const code = pc1.admin.createRegister(admin, storeId).activation_code;
    await syncOnce(pc1);
    pc2 = createServices(openDatabase(':memory:'));
    await joinStore(pc2, url, code, 'PC 2');
    pc1.pos.openSession(ctx1, 0);
    sell(biere);
    await syncOnce(pc1);
    await syncOnce(pc2);
  });

  afterAll(async () => {
    for (const app of apps) await app.close();
  });

  it('sauvegarde du serveur remise sur un autre PC : rien ne se perd et les caisses se voient de nouveau', async () => {
    const old = apps[0]!;
    const oldDir = (await old.get(BackupService).dir()) as string;
    const backup = await old.get(BackupService).backupNow();

    // Après la sauvegarde : un produit et une vente, reçus par l'autre caisse, puis le disque du serveur meurt.
    const apres = article('Lait 1 L');
    const vente = sell(biere);
    for (let i = 0; i < 5; i++) article(`Produit ${i}`);
    await syncOnce(pc1);
    await syncOnce(pc2);
    expect(has(pc2, apres)).toBe(true);
    await old.close();
    apps.shift();

    // Nouveau PC serveur : la sauvegarde arrive de la clé USB, puis on la restaure.
    const fresh = await server();
    const service = fresh.app.get(BackupService);
    mkdirSync(await service.dir(), { recursive: true });
    copyFileSync(join(oldDir, backup.name), join(await service.dir(), backup.name));
    await service.restore(backup.name);
    expect(await known(fresh.url, pc1, 'article')).not.toContain(apres);

    // Nouvelle adresse : les caisses gardent leur liaison et renvoient ce qui manque.
    await changeServerUrl(pc1, fresh.url);
    await changeServerUrl(pc2, fresh.url);
    expect(await known(fresh.url, pc1, 'article')).toContain(apres);
    expect(await known(fresh.url, pc1, 'sale')).toContain(vente.id);

    // Une nouveauté de la caisse 1 arrive sur la caisse 2 (avant, sa lecture restait bloquée au-delà des numéros du serveur).
    const nouveau = article('Sucre 1 kg');
    await syncOnce(pc1);
    await syncOnce(pc2);
    expect(has(pc2, nouveau)).toBe(true);
  });

  it('serveur neuf sans sauvegarde : les caisses le remplissent, et un nouveau PC retrouve les ventes', async () => {
    const { url } = await server();
    pc1.sync.disconnect();
    await enrollStation(pc1, url, KEY, 'PC 1');
    pc2.sync.disconnect();
    await enrollStation(pc2, url, KEY, 'PC 2');
    const sales = pc1.db.prepare('SELECT id FROM sales').pluck().all() as string[];
    expect((await known(url, pc1, 'sale')).sort()).toEqual([...sales].sort());

    const nouveau = article('Riz 5 kg');
    await syncOnce(pc1);
    await syncOnce(pc2);
    expect(has(pc2, nouveau)).toBe(true);

    const pc3 = createServices(openDatabase(':memory:'));
    const code = pc1.admin.createRegister(admin, storeId).activation_code;
    await syncOnce(pc1);
    await joinStore(pc3, url, code, 'PC 3');
    expect(pc3.db.prepare('SELECT COUNT(*) FROM sales').pluck().get()).toBe(sales.length);
  });

  it('copie des sauvegardes du serveur vers un second dossier, rattrapée et relue', async () => {
    const { app, dir } = await server();
    const service = app.get(BackupService);
    const usb = join(dir, 'cle-usb');
    await service.backupNow('a');
    await service.configure({ copyDir: usb, every: 1 });
    expect(await service.every()).toBe(1);
    expect(readdirSync(usb).filter((n) => n.endsWith('.tar.gz'))).toHaveLength(1);
    // Clé débranchée (le dossier est remplacé par un fichier) : la sauvegarde se fait, l'échec est signalé aux PC.
    rmSync(usb, { recursive: true, force: true });
    writeFileSync(usb, '');
    await service.backupNow('b');
    expect((await service.state())!.problem).toContain('Copie vers');
    // Clé rebranchée : les deux sauvegardes y sont recopiées.
    rmSync(usb);
    await service.tick();
    expect(readdirSync(usb).filter((n) => n.endsWith('.tar.gz'))).toHaveLength(2);
    expect((await service.state())!.problem).toBeNull();
  });

  it('une sauvegarde déposée par l\'interface est vérifiée avant d\'être proposée', async () => {
    const { url, app } = await server();
    const cookie = (await fetch(`${url}/?t=${LOCAL}`, { redirect: 'manual' })).headers.get('set-cookie')!.split(';')[0]!;
    const service = app.get(BackupService);
    const bad = await fetch(`${url}/admin/api/backups/upload?name=fedo-serveur-2026-10-29_10-00-00.tar.gz`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/octet-stream' },
      body: 'pas une sauvegarde',
    });
    expect(bad.status).toBe(400);
    const first = await apps[1]!.get(BackupService).backupNow('depot');
    const data = readFileSync(join(await apps[1]!.get(BackupService).dir(), first.name));
    const ok = await fetch(`${url}/admin/api/backups/upload?name=${encodeURIComponent(first.name)}`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/octet-stream' },
      body: data,
    });
    expect(ok.status).toBe(200);
    expect((await service.list()).map((b) => b.name)).toContain(first.name);
  });
});
