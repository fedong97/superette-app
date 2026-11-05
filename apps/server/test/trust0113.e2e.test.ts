import type { INestApplication } from '@nestjs/common';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Services, createServices, enrollStation, joinStore, openDatabase, syncOnce } from '@superette/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/main';

const LOCAL = 'jeton-de-la-fenetre-du-serveur';

/**
 * Étape 6 de l'audit (0.113.0) : PC de confiance. Dès qu'un PC du siège est désigné, eux seuls
 * envoient l'administration du réseau et les données des autres magasins ; les ventes et la
 * gestion de son propre magasin restent ouvertes à chaque PC.
 */
describe('PC de confiance', () => {
  let app: INestApplication;
  let url: string;
  let cookie = '';
  let siege: Services;
  let caisse: Services;
  let akwa = '';
  let bastos = '';
  let steve = '';

  const admin = (path: string, body?: unknown) =>
    fetch(`${url}${path}`, body === undefined ? { headers: { cookie } } : { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const device = async (name: string) => (await (await admin('/admin/api/overview')).json()).devices.find((d: { name: string }) => d.name === name);
  const trust = async (name: string, trusted: boolean) => (await admin(`/admin/api/devices/${(await device(name)).id}/trust`, { trusted })).json();
  const stores = (s: Services) => s.admin.listStores().map((x) => x.code).sort();
  const both = async () => {
    await syncOnce(siege);
    await syncOnce(caisse);
    await syncOnce(siege);
  };

  beforeAll(async () => {
    app = await createApp({ dataDir: join(mkdtempSync(join(tmpdir(), 'fedo-serveur-')), 'donnees'), port: 0, enrollmentKey: 'cle', localAdminToken: LOCAL });
    await app.listen(0, '127.0.0.1');
    url = await app.getUrl();
    cookie = (await fetch(`${url}/?t=${LOCAL}`, { redirect: 'manual' })).headers.get('set-cookie')!.split(';')[0]!;
    siege = createServices(openDatabase(':memory:'));
    const boot = siege.admin.bootstrap({ storeCode: 'DLA1', storeName: 'Superette Akwa', adminName: 'Steve', adminLogin: 'steve', adminPin: '1234' });
    akwa = boot.store.id;
    steve = boot.admin.id;
    bastos = siege.admin.createStore(steve, { storeCode: 'YDE1', storeName: 'Superette Bastos' }).id;
    const code = siege.admin.createRegister(steve, akwa).activation_code;
    await enrollStation(siege, url, 'cle', 'PC du siège');
    caisse = createServices(openDatabase(':memory:'));
    await joinStore(caisse, url, code, 'PC caisse 2');
  });
  afterAll(() => app.close());

  it('sans PC de confiance désigné, tout passe comme avant', async () => {
    expect((await device('PC du siège')).trusted).toBe(false);
    caisse.admin.createStore(steve, { storeCode: 'BFS1', storeName: 'Superette Bafoussam' });
    await both();
    expect(stores(siege)).toContain('BFS1');
    expect(caisse.sync.state().untrusted).toBeNull();
    // Même machine que le serveur : l'heure est juste, rien n'est signalé.
    expect(caisse.sync.state().clockSkewSeconds).toBeNull();
  });

  it('un PC de confiance désigné : les autres PC ne créent plus de magasin ni d’utilisateur ailleurs, mais gèrent le leur', async () => {
    expect(await trust('PC du siège', true)).toEqual({ trusted: true, trustedCount: 1 });
    caisse.admin.createStore(steve, { storeCode: 'KRI1', storeName: 'Superette Kribi' });
    caisse.admin.createUser(steve, { name: 'Intrus', login: 'intrus', pin: '9999', role: 'manager', storeId: bastos });
    caisse.admin.createUser(steve, { name: 'Awa', login: 'awa', pin: '5555', role: 'cashier', storeId: akwa });
    caisse.admin.saveStoreSettings(steve, akwa, { maxLoginAttempts: 6 });
    await both();
    // Refusées pour de bon : elles ne restent pas en attente et l'écran du serveur central le dit.
    // Le magasin de Kribi (avec sa caisse et ses dépôts) et l'utilisateur de Bastos.
    expect(caisse.sync.state()).toMatchObject({ pending: 0, untrusted: { count: 5, entity: 'register, store, user, warehouse', reason: expect.stringContaining('Réservé aux PC de confiance') } });
    expect(caisse.admin.auditLog(20).map((a) => a.action)).toContain('sync.refused_untrusted');
    expect(caisse.sync.state().lastError).toBeNull();
    expect(stores(siege)).not.toContain('KRI1');
    expect(siege.admin.listUsers().map((u) => u.login)).toContain('awa');
    expect(siege.admin.listUsers().map((u) => u.login)).not.toContain('intrus');
    expect(siege.admin.storeSettings(akwa).maxLoginAttempts).toBe(6);
  });

  it('une donnée d’administration renvoyée à l’identique passe sans bruit', async () => {
    const before = caisse.sync.state().untrusted!.count;
    const tva = caisse.admin.listVatRates()[0]!.id;
    caisse.db
      .prepare("INSERT INTO outbox (id, entity, entity_id, op, payload, store_id, register_id, created_at) VALUES ('renvoi-tva', 'vat_rate', ?, 'upsert', '{}', NULL, NULL, ?)")
      .run(tva, new Date().toISOString());
    await syncOnce(caisse);
    expect(caisse.sync.state()).toMatchObject({ pending: 0, untrusted: { count: before } });
  });

  it('le PC de confiance garde tous les droits, et les ventes de chaque PC passent', async () => {
    siege.admin.createStore(steve, { storeCode: 'LIM1', storeName: 'Superette Limbé' });
    siege.admin.createUser(steve, { name: 'Paul', login: 'paul', pin: '7777', role: 'manager', storeId: bastos });
    await both();
    expect(stores(caisse)).toContain('LIM1');
    expect(caisse.admin.listUsers().map((u) => u.login)).toContain('paul');
  });

  it('sans plus aucun PC de confiance, les règles ne s’appliquent plus', async () => {
    expect(await trust('PC du siège', false)).toEqual({ trusted: false, trustedCount: 0 });
    caisse.admin.createStore(steve, { storeCode: 'EBO1', storeName: 'Superette Ebolowa' });
    await both();
    expect(stores(siege)).toContain('EBO1');
  });
});
