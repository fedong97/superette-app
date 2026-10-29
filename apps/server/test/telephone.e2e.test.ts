import type { INestApplication } from '@nestjs/common';
import { createDecipheriv, createECDH, createPublicKey, hkdfSync, randomBytes, verify } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  approvalStatus,
  createServices,
  enrollStation,
  mobileReceptions,
  openDatabase,
  pushStationStatus,
  requestApproval,
  shelfCarts,
  stationStatuses,
  syncOnce,
  takeMobileReception,
  takeShelfCart,
} from '@superette/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/main';
import { encryptPayload, generateVapidKeys, vapidAuthorization } from '../src/webpush';

const LOCAL = 'jeton-de-la-fenetre-du-serveur';

describe('téléphone du gérant : accord à distance et alertes', () => {
  let app: INestApplication;
  let url: string;
  let cookie = '';
  const pc = createServices(openDatabase(':memory:'));
  const { store, register, admin } = pc.admin.bootstrap({ storeCode: 'DLA1', storeName: 'Superette Akwa', adminName: 'Steve', adminLogin: 'steve', adminPin: '1234' });
  const ctx = { storeId: store.id, registerId: register.id, userId: admin.id };
  const get = async (path: string) => (await fetch(`${url}${path}`, { headers: { cookie } })).json();
  const post = (path: string, body: unknown) => fetch(`${url}${path}`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) });

  beforeAll(async () => {
    app = await createApp({ dataDir: join(mkdtempSync(join(tmpdir(), 'fedo-tel-')), 'donnees'), port: 0, enrollmentKey: 'cle-enrolement-de-test', localAdminToken: LOCAL });
    await app.listen(0, '127.0.0.1');
    url = await app.getUrl();
    cookie = (await fetch(`${url}/?t=${LOCAL}`, { redirect: 'manual' })).headers.get('set-cookie')!.split(';')[0]!;
    await enrollStation(pc, url, 'cle-enrolement-de-test', 'PC caisse 1');
    await syncOnce(pc);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('la caisse demande, le gérant accepte avec son code, la caisse lit la réponse une fois', async () => {
    const { id } = await requestApproval(pc, 'Remise de 15 % sur le ticket', 'Awa');
    expect(await approvalStatus(pc, id)).toMatchObject({ status: 'pending' });
    const pending = await get('/admin/api/approvals');
    expect(pending).toEqual([expect.objectContaining({ id, action: 'Remise de 15 % sur le ticket', requestedBy: 'Awa', store: 'Superette Akwa' })]);

    expect((await post(`/admin/api/approvals/${id}`, { approve: true, pin: '9999' })).status).toBe(403);
    expect(await (await post(`/admin/api/approvals/${id}`, { approve: true, pin: '1234' })).json()).toEqual({ status: 'approved', decidedName: 'Steve' });
    expect(await approvalStatus(pc, id)).toMatchObject({ status: 'approved', decidedBy: admin.id, decidedName: 'Steve' });
    expect(await approvalStatus(pc, id)).toMatchObject({ status: 'used' });
    expect(await get('/admin/api/approvals')).toEqual([]);

    const refused = await requestApproval(pc, 'Annuler le ticket T-12', 'Awa');
    await post(`/admin/api/approvals/${refused.id}`, { approve: false });
    expect(await approvalStatus(pc, refused.id)).toMatchObject({ status: 'refused' });
    expect((await fetch(`${url}/admin/api/approvals`)).status).toBe(401);
  });

  it('donne les nouvelles alertes : écart, annulation, grosse remise, rupture', async () => {
    const start = await get('/admin/api/alerts');
    expect(start.alerts).toEqual([]);
    const tva = pc.admin.listVatRates()[0]!.id;
    const savon = pc.catalogue.saveArticle(admin.id, { name: 'Savon Azur', unit: 'piece', vatRateId: tva, purchasePrice: 250, salePrice: 1_000 }).id;
    pc.stock.receive(ctx, { warehouseId: pc.admin.salesWarehouse(store.id).id, lines: [{ articleId: savon, qty: 3_000, unitCost: 250 }] });
    pc.pos.openSession(ctx, 0);
    pc.pos.completeSale(ctx, { lines: [{ articleId: savon, qty: 1_000, discount: 400 }], payments: [{ method: 'CASH', amount: 600 }], discountAuthorizedBy: admin.id, discountReason: 'Geste commercial' });
    const sale = pc.pos.completeSale(ctx, { lines: [{ articleId: savon, qty: 1_000 }], payments: [{ method: 'CASH', amount: 1_000 }] });
    pc.pos.cancelSale(ctx, sale.id, admin.id, 'erreur');
    pc.pos.completeSale(ctx, { lines: [{ articleId: savon, qty: 2_000 }], payments: [{ method: 'CASH', amount: 2_000 }] });
    pc.pos.closeSession(ctx, { 1000: 2 }, {});
    await syncOnce(pc);

    const r = await get(`/admin/api/alerts?since=${start.cursor}`);
    const kinds = r.alerts.map((a: { kind: string }) => a.kind).sort();
    expect(kinds).toEqual(['cancel', 'discount', 'gap', 'stockout']);
    expect(r.alerts.find((a: { kind: string }) => a.kind === 'discount')).toMatchObject({ pct: 40, store: 'Superette Akwa' });
    expect(r.alerts.find((a: { kind: string }) => a.kind === 'gap').text).toContain('-600 FCFA');
    expect(r.alerts.find((a: { kind: string }) => a.kind === 'stockout').text).toContain('Savon Azur');
    expect((await get(`/admin/api/alerts?since=${r.cursor}`)).alerts).toEqual([]);
  });

  it("enregistre l'abonnement du téléphone et sa clé publique", async () => {
    const { publicKey } = await get('/admin/api/push/key');
    expect(Buffer.from(publicKey, 'base64url')).toHaveLength(65);
    const res = await post('/admin/api/push/subscribe', { subscription: { endpoint: 'https://push.example/abc', keys: { p256dh: 'x', auth: 'y' } }, kinds: ['gap', 'inconnu'], discountPct: 30 });
    expect(await res.json()).toEqual({ ok: true, kinds: ['gap'], discountPct: 30 });
  });
});

describe('panier préparé au rayon', () => {
  let app: INestApplication;
  let url: string;
  let cookie = '';
  const pc = createServices(openDatabase(':memory:'));
  const { store, register, admin } = pc.admin.bootstrap({ storeCode: 'DLA1', storeName: 'Superette Akwa', adminName: 'Steve', adminLogin: 'steve', adminPin: '1234' });
  const ctx = { storeId: store.id, registerId: register.id, userId: admin.id };

  beforeAll(async () => {
    app = await createApp({ dataDir: join(mkdtempSync(join(tmpdir(), 'fedo-panier-')), 'donnees'), port: 0, enrollmentKey: 'cle-enrolement-de-test', localAdminToken: LOCAL });
    await app.listen(0, '127.0.0.1');
    url = await app.getUrl();
    cookie = (await fetch(`${url}/?t=${LOCAL}`, { redirect: 'manual' })).headers.get('set-cookie')!.split(';')[0]!;
    await enrollStation(pc, url, 'cle-enrolement-de-test', 'PC caisse 1');
  });

  afterAll(async () => {
    await app?.close();
  });

  it('le vendeur envoie son panier, la caisse le prend une fois et la vente compte pour lui', async () => {
    const tva = pc.admin.listVatRates()[0]!.id;
    const riz = pc.catalogue.saveArticle(admin.id, { name: 'RIZ 1 KG', unit: 'piece', vatRateId: tva, purchasePrice: 700, salePrice: 1_000 }).id;
    pc.stock.receive(ctx, { warehouseId: pc.admin.salesWarehouse(store.id).id, lines: [{ articleId: riz, qty: 20_000, unitCost: 700 }] });
    const { user: paul, staff } = pc.staff.hire(ctx, { user: { name: 'Paul', login: 'paul', pin: '1111', role: 'seller', storeId: store.id }, staff: { baseSalary: 50_000, declared: false } });
    pc.commissions.setTarget(ctx, staff!.id, { monthTarget: 100_000, dayTarget: 10_000, rateBp: 100 });
    await syncOnce(pc);

    const p = await (await fetch(`${url}/admin/api/mobile/pairing`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ storeId: store.id }) })).json();
    const device = (await (await fetch(`${url}/api/v1/mobile/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: p.code, name: 'Téléphone Paul' }) })).json()).token;
    const phone = async (path: string, body?: unknown, session = '') => {
      const headers: Record<string, string> = { authorization: `Bearer ${device}`, 'x-fedonix-session': session, 'content-type': 'application/json' };
      return fetch(`${url}/api/v1/mobile${path}`, body === undefined ? { headers } : { method: 'POST', headers, body: JSON.stringify(body) });
    };
    const login = await (await phone('/login', { login: 'paul', pin: '1111' })).json();
    expect(login.can).toEqual({ count: false, cart: true, exit: false, missed: true, receive: false });
    const catalog = await (await phone('/catalog', undefined, login.session)).json();
    expect(catalog.articles.find((a: { id: string }) => a.id === riz)).toMatchObject({ price: 1_000 });

    const cart = { id: 'panier-0001-paul', label: 'Dame au foulard rouge', lines: [{ articleId: riz, qty: 3_000 }] };
    expect(await (await phone('/carts', cart, login.session)).json()).toEqual({ id: cart.id, number: 1 });
    // Renvoyé après une coupure : pas de doublon.
    expect(await (await phone('/carts', cart, login.session)).json()).toEqual({ id: cart.id, number: 1 });
    expect((await phone('/carts', { id: 'panier-vide-0001', lines: [] }, login.session)).status).toBe(400);

    const waiting = await shelfCarts(pc);
    expect(waiting).toEqual([expect.objectContaining({ id: cart.id, number: 1, label: 'Dame au foulard rouge', sellerId: paul.id, sellerName: 'Paul' })]);
    const taken = await takeShelfCart(pc, cart.id);
    expect(taken.lines).toEqual([{ articleId: riz, qty: 3_000, packId: null }]);
    await expect(takeShelfCart(pc, cart.id)).rejects.toThrow(/déjà été pris/);
    expect(await shelfCarts(pc)).toEqual([]);
    expect((await (await phone('/carts', undefined, login.session)).json()).carts[0]).toMatchObject({ number: 1, lines: 1, takenAt: expect.any(String) });

    // Le caissier (ici le gérant) encaisse : la vente compte pour Paul.
    pc.pos.openSession(ctx, 0);
    const sale = pc.pos.completeSale(ctx, { lines: taken.lines, payments: [{ method: 'CASH', amount: 3_000 }], sellerId: taken.sellerId });
    expect(pc.pos.getSale(sale.id).seller_id).toBe(paul.id);
    expect(pc.commissions.myDay(store.id, paul.id)).toMatchObject({ net: 3_000, tickets: 1 });
    expect(pc.commissions.myDay(store.id, admin.id)).toMatchObject({ net: 0, tickets: 0 });
  });

  it('le vendeur note une vente manquée et voit le stock ailleurs ; le magasinier compte la livraison, le PC la reprend une fois', async () => {
    const tva = pc.admin.listVatRates()[0]!.id;
    const shop = pc.admin.salesWarehouse(store.id).id;
    const reserve = pc.admin.createWarehouse(store.id, 'Réserve du fond', 'reserve').id;
    const sucre = pc.catalogue.saveArticle(admin.id, { name: 'SUCRE 1 KG', unit: 'piece', vatRateId: tva, purchasePrice: 600, salePrice: 900 }).id;
    pc.stock.receive(ctx, { warehouseId: reserve, lines: [{ articleId: sucre, qty: 30_000, unitCost: 600 }] });
    const supplier = pc.purchases.saveSupplier(admin.id, { name: 'SOSUCAM' });
    const order = pc.purchases.createOrder(ctx, { supplierId: supplier.id, warehouseId: shop, expectedDate: '2099-01-15', lines: [{ articleId: sucre, qty: 24_000, unitCost: 600 }] });
    pc.purchases.setOrderStatus(ctx, order.id, 'sent');
    pc.admin.createUser(admin.id, { name: 'Awa', login: 'awa', pin: '5678', role: 'stock', storeId: store.id });
    await syncOnce(pc);

    const p = await (await fetch(`${url}/admin/api/mobile/pairing`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ storeId: store.id }) })).json();
    const device = (await (await fetch(`${url}/api/v1/mobile/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: p.code, name: 'Téléphone rayon' }) })).json()).token;
    const phone = async (path: string, body?: unknown, session = '') => {
      const headers: Record<string, string> = { authorization: `Bearer ${device}`, 'x-fedonix-session': session, 'content-type': 'application/json' };
      return fetch(`${url}/api/v1/mobile${path}`, body === undefined ? { headers } : { method: 'POST', headers, body: JSON.stringify(body) });
    };

    // Vendeur : stock dans la réserve, livraison attendue, puis « le client voulait… ».
    const paul = (await (await phone('/login', { login: 'paul', pin: '1111' })).json()).session;
    const info = await (await phone(`/articles/${sucre}/info`, undefined, paul)).json();
    expect(info.stock).toEqual(expect.arrayContaining([expect.objectContaining({ warehouseId: reserve, here: true, qty: 30_000 })]));
    expect(info.nextDelivery).toMatchObject({ number: order.number, qty: 24_000, expectedDate: '2099-01-15' });
    const missed = { id: 'manque-0001-paul', articleId: sucre, qty: 2_000, reason: 'rupture' };
    expect((await phone('/missed', missed, paul)).status).toBe(200);
    expect((await phone('/missed', missed, paul)).status).toBe(200);
    expect((await phone('/missed', { label: 'Couches taille 5', reason: 'absent' }, paul)).status).toBe(200);
    expect((await phone('/reception-orders', undefined, paul)).status).toBe(403);
    await syncOnce(pc);
    expect(pc.missedSales.list(store.id).map((m) => m.label).sort()).toEqual(['Couches taille 5', 'SUCRE 1 KG']);

    // Magasinier : la livraison comptée devant le camion attend un PC, qui la prend une seule fois.
    const awa = await (await phone('/login', { login: 'awa', pin: '5678' })).json();
    expect(awa.can).toMatchObject({ count: true, receive: true });
    const orders = (await (await phone('/reception-orders', undefined, awa.session)).json()).orders;
    expect(orders).toEqual([expect.objectContaining({ id: order.id, supplier: 'SOSUCAM', lines: [expect.objectContaining({ articleId: sucre, remaining: 24_000 })] })]);
    const lineId = orders[0].lines[0].id;
    const rec = { id: 'reception-0001-awa', orderId: order.id, deliveryNote: '4475', lines: [{ orderLineId: lineId, articleId: sucre, qty: 22_000, damaged: 2_000, lot: 'L12', expiry: '2027-06-30' }] };
    expect((await phone('/receptions', rec, awa.session)).status).toBe(200);
    const waiting = await mobileReceptions(pc);
    expect(waiting).toEqual([expect.objectContaining({ id: rec.id, orderId: order.id, deliveryNote: '4475', userName: 'Awa' })]);
    expect((await takeMobileReception(pc, rec.id)).lines).toEqual([{ orderLineId: lineId, articleId: sucre, qty: 22_000, damaged: 2_000, lot: 'L12', expiry: '2027-06-30' }]);
    await expect(takeMobileReception(pc, rec.id)).rejects.toThrow(/déjà été reprise/);
    expect(await mobileReceptions(pc)).toEqual([]);
  });

  it('garde l’état de chaque PC pour le gérant', async () => {
    await pushStationStatus(pc, { name: 'PC caisse 1', version: '0.81.0', backup: null, printer: null, pendingEvents: 0, license: { canSell: true, label: 'OK' } } as never);
    const all = await stationStatuses(pc);
    expect(all).toEqual([expect.objectContaining({ name: 'PC caisse 1', self: true, status: expect.objectContaining({ version: '0.81.0' }) })]);
  });
});

describe('notifications du navigateur (Web Push)', () => {
  it('chiffre le message pour le seul téléphone abonné', () => {
    const ua = createECDH('prime256v1');
    const uaPublic = ua.generateKeys();
    const auth = randomBytes(16);
    const body = encryptPayload({ endpoint: 'https://push.example/x', keys: { p256dh: uaPublic.toString('base64url'), auth: auth.toString('base64url') } }, '{"title":"Écart"}');
    // Déchiffrement côté navigateur (RFC 8291).
    const salt = body.subarray(0, 16);
    const idLen = body[20]!;
    const asPublic = body.subarray(21, 21 + idLen);
    const shared = ua.computeSecret(asPublic);
    const ikm = Buffer.from(hkdfSync('sha256', shared, auth, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]), 32));
    const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
    const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
    const data = body.subarray(21 + idLen);
    const d = createDecipheriv('aes-128-gcm', cek, nonce);
    d.setAuthTag(data.subarray(data.length - 16));
    const plain = Buffer.concat([d.update(data.subarray(0, data.length - 16)), d.final()]);
    expect(plain.subarray(0, -1).toString()).toBe('{"title":"Écart"}');
    expect(plain.at(-1)).toBe(2);
  });

  it('signe la demande avec la clé du serveur (VAPID)', () => {
    const keys = generateVapidKeys();
    const h = vapidAuthorization('https://fcm.googleapis.com/fcm/send/abc', keys, 'https://gerant.example');
    const [, jwt, k] = /^vapid t=([^,]+), k=(.+)$/.exec(h)!;
    expect(k).toBe(keys.publicKey);
    const [head, claims, sig] = jwt!.split('.');
    expect(JSON.parse(Buffer.from(claims!, 'base64url').toString())).toMatchObject({ aud: 'https://fcm.googleapis.com', sub: 'https://gerant.example' });
    const raw = Buffer.from(keys.publicKey, 'base64url');
    const pub = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: raw.subarray(1, 33).toString('base64url'), y: raw.subarray(33).toString('base64url') }, format: 'jwk' });
    expect(verify('sha256', Buffer.from(`${head}.${claims}`), { key: pub, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig!, 'base64url'))).toBe(true);
  });
});
