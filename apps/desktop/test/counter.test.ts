import type { INestApplication } from '@nestjs/common';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Services, createServices, enrollStation, joinStore, openDatabase, shelfCarts, syncOnce } from '@superette/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PG } from '../../server/src/database';
import { createApp } from '../../server/src/main';
import { createApi } from '../src/main/api';

type Api = Record<string, (...a: unknown[]) => unknown>;
type Row = { id: string; number: number; status: string; version: number; total: number; sellerName: string; lockName: string | null; note: string | null; cart?: boolean };

const KEY = 'cle-enrolement-de-test';
const sync = { now: async () => undefined, status: () => null } as never;
const system = { chooseFolder: async () => null, chooseBackupFile: async () => null, openFolder: async () => undefined, restore: () => undefined };

/**
 * Vendeur et caissier séparés : le vendeur facture sur son PC et envoie à la
 * caisse ; le caissier, sur un autre PC, encaisse. Les deux PC passent par le
 * serveur central.
 */
describe('vendeur et caissier séparés', () => {
  let app: INestApplication;
  let url: string;
  let caisse: Services;
  let poste: Services;
  let atCash: Api;
  let atDesk: Api;
  let riz: string;
  let huile: string;
  const slips: unknown[] = [];
  const printer = new Proxy({}, { get: (_t, name) => async (...a: unknown[]) => void (name === 'counterSlip' && slips.push(a[0])) }) as never;

  beforeAll(async () => {
    app = await createApp({ dataDir: join(mkdtempSync(join(tmpdir(), 'fedo-caisse-')), 'donnees'), port: 0, enrollmentKey: KEY, localAdminToken: 'jeton' });
    await app.listen(0, '127.0.0.1');
    url = await app.getUrl();

    caisse = createServices(openDatabase(':memory:'));
    const { store, register, admin } = caisse.admin.bootstrap({ storeCode: 'DLA1', storeName: 'Superette Akwa', adminName: 'Steve', adminLogin: 'steve', adminPin: '1234' });
    caisse.admin.saveStoreSettings(admin.id, store.id, { saleFlow: 'split' });
    caisse.admin.createUser(admin.id, { name: 'Awa', login: 'awa', pin: '5555', role: 'cashier', storeId: store.id, registerId: register.id });
    caisse.admin.createUser(admin.id, { name: 'Paul', login: 'paul', pin: '1111', role: 'seller', storeId: store.id });
    caisse.admin.createUser(admin.id, { name: 'Mireille', login: 'mireille', pin: '2222', role: 'manager', storeId: store.id });
    const tva = caisse.admin.listVatRates()[0]!.id;
    riz = caisse.catalogue.saveArticle(admin.id, { name: 'RIZ 5 KG', unit: 'piece', vatRateId: tva, purchasePrice: 3_000, salePrice: 5_000 }).id;
    huile = caisse.catalogue.saveArticle(admin.id, { name: 'HUILE 1 L', unit: 'piece', vatRateId: tva, purchasePrice: 900, salePrice: 1_200 }).id;
    caisse.stock.receive({ storeId: store.id, registerId: register.id, userId: admin.id }, { warehouseId: caisse.admin.salesWarehouse(store.id).id, lines: [{ articleId: riz, qty: 50_000, unitCost: 3_000 }, { articleId: huile, qty: 50_000, unitCost: 900 }] });
    await enrollStation(caisse, url, KEY, 'PC caisse');
    // Le poste du vendeur : un deuxième PC du magasin.
    const code = caisse.admin.createRegister(admin.id, store.id, 'Poste vente').activation_code;
    await syncOnce(caisse);
    poste = createServices(openDatabase(':memory:'));
    await joinStore(poste, url, code, 'PC vente');
    atCash = createApi(caisse, printer, sync, 'test', system) as never;
    atDesk = createApi(poste, printer, sync, 'test', system) as never;
    atCash['auth.login']!('awa', '5555');
    atCash['treasury.open']!(10_000, '1234');
    atDesk['auth.login']!('paul', '1111');
  });

  afterAll(async () => {
    await app?.close();
  });

  it('chacun son poste : le vendeur facture, le caissier encaisse', () => {
    expect(atDesk['counter.mode']!()).toEqual({ split: true, post: 'seller', connected: true });
    expect(atCash['counter.mode']!()).toEqual({ split: true, post: 'cashier', connected: true });
  });

  it('le vendeur envoie, le caissier encaisse ; la vente compte pour le vendeur', async () => {
    const sent = (await atDesk['counter.send']!({ lines: [{ articleId: riz, qty: 2_000 }], clientName: 'Mme Ngo' })) as Row;
    expect(sent).toMatchObject({ number: 1, status: 'waiting', version: 1, total: 10_000, sellerName: 'Paul' });
    await atDesk['counter.printSlip']!(sent.id);
    expect(slips.at(-1)).toMatchObject({ number: 1, total: 10_000, sellerName: 'Paul', customerName: 'Mme Ngo', lines: [{ label: 'RIZ 5 KG', qty: '2', amount: 10_000 }] });
    // Rien n'est vendu ni sorti du stock tant que la caisse n'a pas encaissé.
    expect(caisse.db.prepare('SELECT COUNT(*) FROM sales').pluck().get()).toBe(0);

    const queue = (await atCash['counter.queue']!()) as Row[];
    expect(queue).toEqual([expect.objectContaining({ id: sent.id, number: 1, status: 'waiting', total: 10_000 })]);
    const recap = (await atCash['counter.take']!(sent.id)) as { total: number; lines: { label: string; qty: string; total: number }[]; customerName: string };
    expect(recap).toMatchObject({ total: 10_000, customerName: 'Mme Ngo', lines: [{ label: 'RIZ 5 KG', qty: '2', total: 10_000 }] });
    // Ouverte sur cette caisse : le vendeur ne peut plus la modifier, une autre caisse ne peut pas la prendre.
    await expect(atDesk['counter.edit']!(sent.id)).rejects.toThrow(/en cours d’encaissement par Awa/);

    const sale = (await atCash['counter.pay']!({ ids: [sent.id], payments: [{ method: 'CASH', amount: 10_000 }] })) as { id: string; number: string; total_ttc: number };
    expect(sale.total_ttc).toBe(10_000);
    const stored = caisse.pos.getSale(sale.id);
    expect(stored).toMatchObject({ client_name: 'Mme Ngo', seller_id: caisse.admin.listUsers().find((u) => u.login === 'paul')!.id });
    expect(((await atDesk['counter.mine']!()) as Row[])[0]).toMatchObject({ id: sent.id, status: 'paid', saleNumber: sale.number });
    expect((await atCash['counter.queue']!()) as Row[]).toEqual([]);
    // Encaissée une fois : la payer à nouveau est refusé.
    await expect(atCash['counter.pay']!({ ids: [sent.id], payments: [{ method: 'CASH', amount: 10_000 }] })).rejects.toThrow(/déjà encaissée/);
  });

  it('le vendeur modifie sa facture : bloquée à la caisse pendant la modification, même numéro, version suivante', async () => {
    const sent = (await atDesk['counter.send']!({ lines: [{ articleId: riz, qty: 1_000 }] })) as Row;
    const opened = (await atDesk['counter.edit']!(sent.id)) as { payload: { lines: unknown[] } };
    expect(opened.payload.lines).toEqual([expect.objectContaining({ articleId: riz, qty: 1_000 })]);
    expect(((await atCash['counter.queue']!()) as Row[]).find((r) => r.id === sent.id)).toMatchObject({ status: 'editing', lockName: 'Paul' });
    await expect(atCash['counter.take']!(sent.id)).rejects.toThrow(/en cours de modification par Paul/);

    const again = (await atDesk['counter.send']!({ id: sent.id, baseVersion: sent.version, lines: [{ articleId: riz, qty: 1_000 }, { articleId: huile, qty: 1_000 }] })) as Row;
    expect(again).toMatchObject({ id: sent.id, number: sent.number, version: 2, status: 'waiting', total: 6_200 });
    // L'ancienne version ne peut plus être renvoyée (deux modifications croisées).
    await expect(atDesk['counter.send']!({ id: sent.id, baseVersion: 1, lines: [{ articleId: riz, qty: 3_000 }] })).rejects.toThrow(/changé|modifi/);
    // Un autre vendeur ne la touche pas.
    const other = createApi(poste, printer, sync, 'test', system) as unknown as Api;
    caisse.admin.createUser(caisse.admin.listUsers().find((u) => u.login === 'steve')!.id, { name: 'Jean', login: 'jean', pin: '3333', role: 'seller', storeId: caisse.admin.station()!.store.id });
    await syncOnce(caisse);
    await syncOnce(poste);
    other['auth.login']!('jean', '3333');
    await expect(other['counter.edit']!(sent.id)).rejects.toThrow(/celle de Paul/);

    const recap = (await atCash['counter.take']!(sent.id)) as { total: number };
    expect(recap.total).toBe(6_200);
    await atCash['counter.release']!(sent.id);
    expect(((await atCash['counter.queue']!()) as Row[]).find((r) => r.id === sent.id)).toMatchObject({ status: 'waiting', lockName: null });
  });

  it('le client ajoute un article : deuxième facture, encaissées ensemble en un seul ticket', async () => {
    const queue = (await atCash['counter.queue']!()) as Row[];
    const first = queue.find((r) => r.status === 'waiting')!;
    const extra = (await atDesk['counter.send']!({ lines: [{ articleId: huile, qty: 2_000 }] })) as Row;
    await atCash['counter.take']!(first.id);
    await atCash['counter.take']!(extra.id);
    const sale = (await atCash['counter.pay']!({ ids: [first.id, extra.id], payments: [{ method: 'CASH', amount: 10_000 }] })) as { id: string; total_ttc: number; change_given: number };
    expect(sale).toMatchObject({ total_ttc: 8_600, change_given: 1_400 });
    expect(caisse.pos.getSale(sale.id).lines).toHaveLength(3);
    const mine = (await atDesk['counter.mine']!()) as Row[];
    expect(mine.filter((r) => r.id === first.id || r.id === extra.id).map((r) => r.status)).toEqual(['paid', 'paid']);
  });

  it('le caissier rend la facture au vendeur avec le motif ; le vendeur corrige et renvoie, ou annule', async () => {
    const sent = (await atDesk['counter.send']!({ lines: [{ articleId: riz, qty: 3_000 }] })) as Row;
    await atCash['counter.take']!(sent.id);
    await expect(atCash['counter.giveBack']!(sent.id, '')).rejects.toThrow(/Dites au vendeur/);
    await atCash['counter.giveBack']!(sent.id, 'Le client prend 2 sacs seulement');
    expect(((await atDesk['counter.mine']!()) as Row[]).find((r) => r.id === sent.id)).toMatchObject({ status: 'returned', note: 'Le client prend 2 sacs seulement' });
    await expect(atCash['counter.take']!(sent.id)).rejects.toThrow(/rendue au vendeur/);
    const fixed = (await atDesk['counter.send']!({ id: sent.id, baseVersion: sent.version, lines: [{ articleId: riz, qty: 2_000 }] })) as Row;
    expect(fixed).toMatchObject({ status: 'waiting', version: 2, total: 10_000, note: null });

    await atDesk['counter.cancel']!(fixed.id, 'Client parti');
    expect(((await atCash['counter.queue']!()) as Row[]).some((r) => r.id === fixed.id)).toBe(false);
  });

  it('remise : le vendeur sans le droit donne le code du gérant ; la caisse encaisse sans le redemander', async () => {
    await expect(atDesk['counter.send']!({ lines: [{ articleId: riz, qty: 1_000, discount: 500 }] })).rejects.toThrow(/validation du gérant/);
    const sent = (await atDesk['counter.send']!({ lines: [{ articleId: riz, qty: 1_000, discount: 500 }], supervisorPin: '2222' })) as Row;
    expect(sent.total).toBe(4_500);
    // Le vendeur change la quantité d'une autre ligne : la remise déjà accordée reste valable.
    await atDesk['counter.edit']!(sent.id);
    const again = (await atDesk['counter.send']!({ id: sent.id, baseVersion: 1, lines: [{ articleId: riz, qty: 1_000, discount: 500 }, { articleId: huile, qty: 1_000 }] })) as Row;
    expect(again.total).toBe(5_700);
    await atCash['counter.take']!(sent.id);
    const sale = (await atCash['counter.pay']!({ ids: [sent.id], payments: [{ method: 'CASH', amount: 5_700 }] })) as { total_discount: number };
    expect(sale.total_discount).toBe(500);
  });

  it('un prix négocié par le vendeur (son droit) est repris tel quel à la caisse', async () => {
    const sent = (await atDesk['counter.send']!({ lines: [{ articleId: riz, qty: 1_000, price: 4_800 }] })) as Row;
    expect(sent.total).toBe(4_800);
    await atCash['counter.take']!(sent.id);
    const sale = (await atCash['counter.pay']!({ ids: [sent.id], payments: [{ method: 'CASH', amount: 4_800 }] })) as { id: string; total_ttc: number };
    expect(sale.total_ttc).toBe(4_800);
  });

  it('le panier du téléphone arrive dans la même liste et s’encaisse comme une facture', async () => {
    const storeId = caisse.admin.station()!.store.id;
    const sellerId = caisse.admin.listUsers().find((u) => u.login === 'paul')!.id;
    // Panier posé directement sur le serveur (le téléphone passe par /api/v1/mobile/carts).
    const db = app.get(PG) as { query: (sql: string, p: unknown[]) => Promise<unknown> };
    const device = (await db.query('SELECT id FROM devices LIMIT 1', [])) as { rows: { id: string }[] };
    await db.query(
      "INSERT INTO shelf_carts (id, device_id, store_id, user_id, user_name, label, lines, number) VALUES ('panier-0001-paul', $1, $2, $3, 'Paul', 'Dame au foulard', $4, 99)",
      [device.rows[0]!.id, storeId, sellerId, JSON.stringify([{ articleId: huile, qty: 3_000, packId: null }])],
    );
    expect(await shelfCarts(caisse)).toHaveLength(1);
    const queue = (await atCash['counter.queue']!()) as Row[];
    const cart = queue.find((r) => r.cart)!;
    expect(cart).toMatchObject({ id: 'cart:panier-0001-paul', number: 99, total: 3_600, sellerName: 'Paul' });
    const recap = (await atCash['counter.take']!(cart.id)) as { id: string; total: number };
    expect(recap.total).toBe(3_600);
    const sale = (await atCash['counter.pay']!({ ids: [recap.id], payments: [{ method: 'CASH', amount: 3_600 }] })) as { id: string };
    expect(caisse.pos.getSale(sale.id).seller_id).toBe(sellerId);
    expect(await shelfCarts(caisse)).toEqual([]);
  });
  it('vendeur complet au rayon : client, tarif gros, remise avec le code du gérant, suivi jusqu’au ticket', async () => {
    const storeId = caisse.admin.station()!.store.id;
    const admin = caisse.admin.listUsers().find((u) => u.login === 'steve')!.id;
    const savon = caisse.catalogue.saveArticle(admin, { name: 'SAVON 400 G', unit: 'piece', vatRateId: caisse.admin.listVatRates()[0]!.id, purchasePrice: 400, salePrice: 700, wholesalePrice: 600 }).id;
    caisse.stock.receive({ storeId, registerId: null, userId: admin }, { warehouseId: caisse.admin.salesWarehouse(storeId).id, lines: [{ articleId: savon, qty: 100_000, unitCost: 400 }] });
    const client = caisse.customers.saveCustomer(admin, { name: 'Boutique Mama Ngo', phone: '699001122', creditLimit: 100_000 });
    await syncOnce(caisse);

    // Le téléphone du vendeur, relié par le QR du gérant.
    const cookie = (await fetch(`${url}/?t=jeton`, { redirect: 'manual' })).headers.get('set-cookie')!.split(';')[0]!;
    const pairing = await (await fetch(`${url}/admin/api/mobile/pairing`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ storeId }) })).json();
    const token = (await (await fetch(`${url}/api/v1/mobile/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: pairing.code, name: 'Téléphone Paul' }) })).json()).token;
    let session = '';
    const phone = (path: string, body?: unknown) =>
      fetch(`${url}/api/v1/mobile${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { authorization: `Bearer ${token}`, 'x-fedonix-session': session, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    const login = await (await phone('/login', { login: 'paul', pin: '1111' })).json();
    session = login.session;
    expect(login.can).toMatchObject({ cart: true, sell: 'full', discount: false, tariff: false, manage: null });

    const found = (await (await phone('/customers?q=mama')).json()).customers;
    expect(found).toEqual([expect.objectContaining({ id: client.id, name: 'Boutique Mama Ngo', priceLevel: 'retail', creditLimit: 100_000 })]);
    const catalog = await (await phone('/catalog')).json();
    expect(catalog.articles.find((a: { id: string }) => a.id === savon)).toMatchObject({ price: 700, wholesale: 600 });

    // 10 savons au prix de gros, 500 FCFA de remise : Paul n'a aucun des deux droits, le gérant donne son code.
    const cart = { id: 'panier-0002-paul', lines: [{ articleId: savon, qty: 10_000, discount: 500 }], customerId: client.id, priceLevel: 'wholesale' };
    const noReason = await phone('/carts', cart);
    expect(noReason.status).toBe(400);
    expect((await noReason.json()).code).toBe('REASON_REQUIRED');
    const asked = await phone('/carts', { ...cart, discountReason: 'Achat en quantité' });
    expect(asked.status).toBe(403);
    expect(await asked.json()).toMatchObject({ code: 'SUPERVISOR_REQUIRED' });
    expect((await phone('/carts', { ...cart, discountReason: 'Achat en quantité', supervisorPin: '9999' })).status).toBe(403);
    const ok = await (await phone('/carts', { ...cart, discountReason: 'Achat en quantité', supervisorPin: '2222' })).json();
    expect(ok).toMatchObject({ id: cart.id, total: 5_500 });

    // Le client ajoute un savon : le panier, pas encore en caisse, est renvoyé modifié sous le même numéro.
    const edited = await (await phone('/carts', { ...cart, lines: [{ articleId: savon, qty: 11_000, discount: 500 }], discountReason: 'Achat en quantité', supervisorPin: '2222' })).json();
    expect(edited).toMatchObject({ number: ok.number, total: 6_100 });

    const queued = ((await atCash['counter.queue']!()) as Row[]).find((r) => r.id === `cart:${cart.id}`)!;
    expect(queued).toMatchObject({ number: ok.number, total: 6_100, sellerName: 'Paul' });
    const recap = (await atCash['counter.take']!(queued.id)) as { id: string; total: number; customerName: string };
    expect(recap).toMatchObject({ total: 6_100, customerName: 'Boutique Mama Ngo' });
    // En caisse : le vendeur ne peut plus le modifier ni l'annuler.
    expect((await phone('/carts', { ...cart, lines: [{ articleId: savon, qty: 1_000 }] })).status).toBe(409);
    expect((await phone(`/carts/${cart.id}/cancel`, {})).status).toBe(409);
    expect((await (await phone('/carts')).json()).carts.find((c: { id: string }) => c.id === cart.id)).toMatchObject({ status: 'taken' });

    // La caisse encaisse sans redemander le code : client, tarif gros, remise, motif et vendeur sont repris.
    const sale = (await atCash['counter.pay']!({ ids: [recap.id], payments: [{ method: 'CASH', amount: 6_100 }] })) as { id: string; number: string; total_discount: number };
    const stored = caisse.pos.getSale(sale.id);
    expect(stored).toMatchObject({ customer_id: client.id, price_level: 'wholesale', total_ttc: 6_100, total_discount: 500, seller_id: caisse.admin.listUsers().find((u) => u.login === 'paul')!.id });
    await syncOnce(caisse);
    const mine = await (await phone('/carts')).json();
    expect(mine.carts.find((c: { id: string }) => c.id === cart.id)).toMatchObject({ status: 'paid', saleNumber: sale.number, total: 6_100, customerName: 'Boutique Mama Ngo' });
    expect(mine.day.tickets).toBeGreaterThanOrEqual(1);
    expect(mine.day.total).toBeGreaterThanOrEqual(6_100);

    // Un panier que le client abandonne est annulé : la caisse ne le voit plus.
    expect((await phone('/carts', { id: 'panier-0003-paul', lines: [{ articleId: savon, qty: 1_000 }] })).status).toBe(200);
    expect((await phone('/carts/panier-0003-paul/cancel', {})).status).toBe(200);
    expect(((await atCash['counter.queue']!()) as Row[]).some((r) => r.id === 'cart:panier-0003-paul')).toBe(false);
    expect((await (await phone('/carts')).json()).carts.find((c: { id: string }) => c.id === 'panier-0003-paul')).toMatchObject({ status: 'cancelled' });
  });
});
