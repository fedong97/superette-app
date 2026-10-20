import type { INestApplication } from '@nestjs/common';
import { createDecipheriv, createECDH, createPublicKey, hkdfSync, randomBytes, verify } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalStatus, createServices, enrollStation, openDatabase, requestApproval, syncOnce } from '@superette/db';
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
    pc.pos.completeSale(ctx, { lines: [{ articleId: savon, qty: 1_000, discount: 400 }], payments: [{ method: 'CASH', amount: 600 }], discountAuthorizedBy: admin.id });
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
