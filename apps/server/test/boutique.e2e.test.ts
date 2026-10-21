import type { INestApplication } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type Context,
  type Services,
  createServices,
  downloadStationBackup,
  enrollStation,
  openDatabase,
  stationBackups,
  syncOnce,
  takeWebOrder,
  uploadStationBackup,
  webOrders,
} from '@superette/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/main';

const KEY = 'cle-enrolement-de-test';

/** Un PC du magasin DLA1, le serveur, un client sur la boutique en ligne et le vérificateur de prix au rayon. */
describe('boutique en ligne, vérificateur de prix et sauvegarde en ligne', () => {
  let app: INestApplication;
  let url: string;
  let dir: string;
  let pc: Services;
  let ctx: Context;
  let storeId = '';
  const A: Record<string, string> = {};

  const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  /** Autre PC rattaché avec la clé d'enrôlement (d'un magasin donné). */
  const enroll = async (store: string, register: string) =>
    (await (await post('/api/v1/devices/enroll', { enrollmentKey: KEY, storeId: store, registerId: register, name: register })).json()).token as string;
  const order = (lines: { articleId: string; qty: number }[], extra: Record<string, unknown> = {}) =>
    post('/api/v1/shop/dla1/orders', { customerName: 'Mireille', phone: '+237 677 12 34 56', lines, ...extra });

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'fedo-boutique-'));
    app = await createApp({ dataDir: join(dir, 'donnees'), port: 0, enrollmentKey: KEY });
    await app.listen(0, '127.0.0.1');
    url = await app.getUrl();

    pc = createServices(openDatabase(':memory:'));
    const boot = pc.admin.bootstrap({ storeCode: 'DLA1', storeName: 'Superette Akwa', adminName: 'Steve', adminLogin: 'steve', adminPin: '1234' });
    storeId = boot.store.id;
    ctx = { storeId, registerId: boot.register.id, userId: boot.admin.id };
    const tva = pc.admin.listVatRates()[0]!.id;
    A.biere = pc.catalogue.saveArticle(boot.admin.id, { name: 'Bière 65 cl', unit: 'piece', vatRateId: tva, purchasePrice: 450, salePrice: 650, barcodes: [{ code: '6001234567899' }] }).id;
    A.riz = pc.catalogue.saveArticle(boot.admin.id, { name: 'Riz parfumé', unit: 'kg', vatRateId: tva, purchasePrice: 600, salePrice: 900 }).id;
    A.lait = pc.catalogue.saveArticle(boot.admin.id, { name: 'Lait 1 L', unit: 'piece', vatRateId: tva, purchasePrice: 600, salePrice: 900 }).id;
    // Prix du magasin : la bière est plus chère à Akwa.
    pc.catalogue.setStorePrice(boot.admin.id, A.biere, storeId, 700);
    const wh = pc.admin.salesWarehouse(storeId).id;
    pc.stock.receive(ctx, {
      warehouseId: wh,
      lines: [
        { articleId: A.biere, qty: 48_000, unitCost: 450 },
        { articleId: A.riz, qty: 25_000, unitCost: 600 },
      ],
    });
    await enrollStation(pc, url, KEY, 'PC caisse 1');
    await syncOnce(pc);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('la boutique fermée répond 404, en français', async () => {
    const page = await fetch(`${url}/boutique/DLA1`);
    expect(page.status).toBe(404);
    expect(await page.text()).toContain('ne prend pas de commandes en ligne');
    expect((await fetch(`${url}/boutique/INCONNU`)).status).toBe(404);
    const api = await fetch(`${url}/api/v1/shop/DLA1/catalog`);
    expect(api.status).toBe(404);
    expect((await api.json()).message).toContain('boutique en ligne');
    expect((await order([{ articleId: A.biere!, qty: 1000 }])).status).toBe(404);
    expect((await fetch(`${url}/prix/DLA1`)).status).toBe(404);
    expect((await fetch(`${url}/api/v1/shop/DLA1/price?code=6001234567899`)).status).toBe(404);
  });

  it('ouverte, la boutique montre les articles en stock au prix du magasin', async () => {
    pc.admin.saveStoreSettings(ctx.userId, storeId, {
      onlineShop: true,
      onlineShopDelivery: true,
      onlineShopDeliveryFee: 1_000,
      onlineShopMinOrder: 2_000,
      onlineShopMessage: 'Livraison à Akwa et Bonapriso',
      priceChecker: true,
    });
    await syncOnce(pc);
    const page = await fetch(`${url}/boutique/dla1`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('Envoyer la commande');
    const c = await (await fetch(`${url}/api/v1/shop/dla1/catalog`)).json();
    expect(c).toMatchObject({ store: { code: 'DLA1', name: 'Superette Akwa' }, message: 'Livraison à Akwa et Bonapriso', delivery: true, deliveryFee: 1_000, minOrder: 2_000 });
    expect(c.articles.find((a: { id: string }) => a.id === A.biere)).toMatchObject({ name: 'Bière 65 cl', price: 700, regularPrice: 700, unit: 'piece' });
    expect(c.articles.find((a: { id: string }) => a.id === A.riz)).toMatchObject({ price: 900, unit: 'kg' });
    // Pas de stock : pas proposé.
    expect(c.articles.find((a: { id: string }) => a.id === A.lait)).toBeUndefined();
  });

  it('refuse une commande mal remplie', async () => {
    const bad = async (res: Response, text: string) => {
      expect(res.status).toBe(400);
      expect((await res.json()).message).toContain(text);
    };
    await bad(await order([{ articleId: A.biere!, qty: 5_000 }], { phone: '12345' }), 'Numéro de téléphone invalide');
    await bad(await order([{ articleId: A.biere!, qty: 5_000 }], { phone: '+237 5 77 12 34 56' }), 'Numéro de téléphone invalide');
    await bad(await order([{ articleId: 'inconnu', qty: 5_000 }]), 'plus vendu en ligne');
    await bad(await order([{ articleId: A.lait!, qty: 5_000 }]), 'plus disponible');
    await bad(await order([{ articleId: A.biere!, qty: 1_000 }]), 'montant minimal');
    await bad(await order([{ articleId: A.biere!, qty: 1_500 }]), 'quantité entière');
    await bad(await order([{ articleId: A.biere!, qty: -1_000 }]), 'Quantité invalide');
    await bad(await order([{ articleId: A.biere!, qty: 2_000_000 }]), 'Quantité invalide');
    await bad(await order([]), 'panier est vide');
    await bad(await order([{ articleId: A.biere!, qty: 5_000 }], { customerName: ' ' }), 'votre nom');
    await bad(await order(Array.from({ length: 61 }, () => ({ articleId: A.biere!, qty: 1_000 }))), '60 articles');
  });

  it('la commande arrive au poste du magasin, qui la prend une seule fois', async () => {
    const res = await order(
      [
        { articleId: A.biere!, qty: 3_000, price: 1 },
        { articleId: A.riz!, qty: 2_500 },
        { articleId: A.biere!, qty: 1_000 },
      ] as never,
      { address: 'Rue Joss, face pharmacie', slot: 'Samedi matin', note: 'Appeler avant' },
    );
    expect(res.status).toBe(200);
    const r = await res.json();
    expect(r.number).toMatch(/^W-[A-Z2-9]{6}$/);
    // Prix refait par le serveur : 4 × 700 + 2,5 × 900 + livraison 1 000.
    expect(r).toMatchObject({ total: 2_800 + 2_250 + 1_000, deliveryFee: 1_000 });

    const waiting = await webOrders(pc);
    expect(waiting).toEqual([
      {
        id: r.id,
        number: r.number,
        customerName: 'Mireille',
        phone: '677123456',
        address: 'Rue Joss, face pharmacie',
        slot: 'Samedi matin',
        note: 'Appeler avant',
        deliveryFee: 1_000,
        lines: [
          { articleId: A.biere, name: 'Bière 65 cl', qty: 4_000, price: 700 },
          { articleId: A.riz, name: 'Riz parfumé', qty: 2_500, price: 900 },
        ],
        total: 6_050,
        at: expect.any(String),
      },
    ]);
    // Un PC d'un autre magasin ne la voit pas.
    const other = await enroll('magasin-yaounde', 'caisse-yaounde');
    expect((await (await fetch(`${url}/api/v1/web-orders`, { headers: { authorization: `Bearer ${other}` } })).json()).orders).toEqual([]);
    expect((await post(`/api/v1/web-orders/${r.id}/take`, {}, { authorization: `Bearer ${other}` })).status).toBe(404);
    expect((await fetch(`${url}/api/v1/web-orders`)).status).toBe(401);

    const taken = await takeWebOrder(pc, r.id);
    expect(taken.number).toBe(r.number);
    // Un deuxième poste du magasin arrive trop tard.
    const second = await enroll(storeId, 'caisse-2-akwa');
    const again = await post(`/api/v1/web-orders/${r.id}/take`, {}, { authorization: `Bearer ${second}` });
    expect(again.status).toBe(409);
    expect((await again.json()).message).toContain('déjà été prise');
    await expect(takeWebOrder(pc, r.id)).rejects.toThrow(/déjà été prise/);
    expect(await webOrders(pc)).toEqual([]);
  });

  it('le vérificateur de prix lit le code-barres et montre la promotion du jour', async () => {
    const page = await fetch(`${url}/prix/DLA1`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('Vérificateur de prix');
    const before = await (await fetch(`${url}/api/v1/shop/DLA1/price?code=6001234567899`)).json();
    expect(before.article).toMatchObject({ name: 'Bière 65 cl', price: 700, promoPrice: null });

    pc.promotions.save(ctx.userId, { name: 'Bière en fête', kind: 'price', articleId: A.biere!, storeId, startsOn: day(-1), endsOn: day(2), promoPrice: 600 });
    await syncOnce(pc);
    const after = await (await fetch(`${url}/api/v1/shop/DLA1/price?code=6001234567899`)).json();
    expect(after.article).toMatchObject({ name: 'Bière 65 cl', price: 700, promoPrice: 600, promoName: 'Bière en fête', promoEnds: day(2) });
    // Le code article marche aussi ; un code inconnu répond 404 en français.
    const code = after.article.code;
    expect((await (await fetch(`${url}/api/v1/shop/DLA1/price?code=${encodeURIComponent(code)}`)).json()).article.id).toBe(A.biere);
    const unknown = await fetch(`${url}/api/v1/shop/DLA1/price?code=0000000`);
    expect(unknown.status).toBe(404);
    expect((await unknown.json()).message).toContain('Article introuvable');
    // La boutique prend aussi le prix de la promotion.
    const c = await (await fetch(`${url}/api/v1/shop/DLA1/catalog`)).json();
    expect(c.articles.find((a: { id: string }) => a.id === A.biere)).toMatchObject({ price: 600, regularPrice: 700 });
  });

  it('la sauvegarde chiffrée du PC part au serveur et revient intacte', async () => {
    const blob = randomBytes(300_000);
    const sha256 = createHash('sha256').update(blob).digest('hex');
    const up = await uploadStationBackup(pc, { name: '../../fedo-2026-10-20.db.enc', data: blob, sha256 });
    expect(up).toEqual({ id: expect.any(String), at: expect.any(String) });
    const list = await stationBackups(pc);
    expect(list).toEqual([{ id: up.id, name: 'fedo-2026-10-20.db.enc', size: blob.length, at: up.at, device: 'PC caisse 1' }]);
    const back = await downloadStationBackup(pc, up.id);
    expect(back.name).toBe('fedo-2026-10-20.db.enc');
    expect(back.data.equals(blob)).toBe(true);
    // Le fichier est rangé par magasin et par poste, à côté de la base.
    expect(readdirSync(join(dir, 'station-backups'))).toEqual([storeId.replace(/[^\w-]/g, '_')]);

    // Empreinte différente : refusée.
    await expect(uploadStationBackup(pc, { name: 'abime.enc', data: blob, sha256: createHash('sha256').update('autre').digest('hex') })).rejects.toThrow(/empreinte différente/);
    expect(await stationBackups(pc)).toHaveLength(1);

    // Un PC d'un autre magasin ne la voit pas et ne la télécharge pas.
    const other = await enroll('magasin-bafoussam', 'caisse-bafoussam');
    const auth = { authorization: `Bearer ${other}` };
    expect((await (await fetch(`${url}/api/v1/station-backups`, { headers: auth })).json()).backups).toEqual([]);
    expect((await fetch(`${url}/api/v1/station-backups/${up.id}`, { headers: auth })).status).toBe(404);
    expect((await fetch(`${url}/api/v1/station-backups/..%2F..%2Fdonnees`, { headers: auth })).status).toBe(404);
    expect((await fetch(`${url}/api/v1/station-backups`)).status).toBe(401);
  });

  it('garde les 10 dernières sauvegardes de chaque PC', async () => {
    // Plus lourde que la limite des autres demandes (25 Mo).
    const big = randomBytes(26 * 1024 * 1024);
    const first = await uploadStationBackup(pc, { name: 'grosse.enc', data: big, sha256: createHash('sha256').update(big).digest('hex') });
    expect((await downloadStationBackup(pc, first.id)).data.equals(big)).toBe(true);
    for (let i = 0; i < 11; i++) {
      const data = Buffer.from(`sauvegarde ${i}`);
      await uploadStationBackup(pc, { name: `s${i}.enc`, data, sha256: createHash('sha256').update(data).digest('hex') });
    }
    const list = await stationBackups(pc);
    expect(list).toHaveLength(10);
    expect(list[0]!.name).toBe('s10.enc');
    const files = readdirSync(join(dir, 'station-backups', storeId.replace(/[^\w-]/g, '_')), { recursive: true }).filter((f) => String(f).endsWith('.fbk'));
    expect(files).toHaveLength(10);
  });

  it('limite le nombre de commandes envoyées depuis une même connexion', async () => {
    let status = 0;
    for (let i = 0; i < 11 && status !== 429; i++) status = (await order([{ articleId: A.biere!, qty: 5_000 }])).status;
    expect(status).toBe(429);
    const res = await order([{ articleId: A.biere!, qty: 5_000 }]);
    expect(res.status).toBe(429);
    expect((await res.json()).message).toContain('Trop de commandes');
  });
});
