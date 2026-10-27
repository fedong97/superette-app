import type { INestApplication } from '@nestjs/common';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Context, type Services, createServices, enrollStation, openDatabase, syncOnce } from '@superette/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/main';

const LOCAL = 'jeton-de-la-fenetre-du-serveur';

/** Un PC du magasin, le serveur, et l'application ONIX 360 Inventaire simulée par ses appels. */
describe('inventaire sur téléphone', () => {
  let app: INestApplication;
  let url: string;
  let cookie = '';
  let pc: Services;
  let ctx: Context;
  let storeId = '';
  let wh = '';
  let invId = '';
  let device = '';
  let session = '';
  let guestSession = '';
  const A: Record<string, string> = {};

  const admin = (path: string, body?: unknown) =>
    fetch(`${url}${path}`, body === undefined ? { headers: { cookie } } : { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const phone = (path: string, body?: unknown, s = session) => {
    const headers: Record<string, string> = { authorization: `Bearer ${device}`, 'x-fedonix-session': s, 'content-type': 'application/json' };
    return fetch(`${url}/api/v1/mobile${path}`, body === undefined ? { headers } : { method: 'POST', headers, body: JSON.stringify(body) });
  };
  const line = (inventoryId: string, articleId: string) => pc.inventories.lines(inventoryId).find((l) => l.article_id === articleId);
  let n = 0;
  /** Heures des comptages : après le stock reçu par le PC, comme sur un vrai téléphone. */
  let start = 0;
  const at = (s: number) => new Date((start ||= Date.now()) + s * 1000).toISOString();
  const count = (articleId: string, location: string, qty: number | null, at: string, inventoryId = invId) => ({
    id: `compte-${++n}-${Date.now()}`,
    inventoryId,
    articleId,
    location,
    qty,
    countedAt: at,
  });

  beforeAll(async () => {
    app = await createApp({ dataDir: join(mkdtempSync(join(tmpdir(), 'fedo-inventaire-')), 'donnees'), port: 0, enrollmentKey: 'cle-enrolement-de-test', localAdminToken: LOCAL });
    await app.listen(0, '127.0.0.1');
    url = await app.getUrl();
    cookie = (await fetch(`${url}/?t=${LOCAL}`, { redirect: 'manual' })).headers.get('set-cookie')!.split(';')[0]!;

    pc = createServices(openDatabase(':memory:'));
    const boot = pc.admin.bootstrap({ storeCode: 'DLA1', storeName: 'Superette Akwa', adminName: 'Steve', adminLogin: 'steve', adminPin: '1234' });
    storeId = boot.store.id;
    ctx = { storeId, registerId: boot.register.id, userId: boot.admin.id };
    pc.admin.createUser(boot.admin.id, { name: 'Awa', login: 'awa', pin: '5678', role: 'stock', storeId });
    pc.admin.createUser(boot.admin.id, { name: 'Paul', login: 'paul', pin: '1111', role: 'cashier', storeId });
    pc.admin.createUser(boot.admin.id, { name: 'Jean', login: 'jean', pin: '2222', role: 'accountant', storeId });
    const tva = pc.admin.listVatRates()[0]!.id;
    const boissons = pc.catalogue.createDepartment('Boissons');
    const fam = pc.catalogue.createFamily(boissons.id, 'Bières');
    A.biere = pc.catalogue.saveArticle(boot.admin.id, {
      name: 'Bière 65 cl',
      unit: 'piece',
      vatRateId: tva,
      purchasePrice: 450,
      salePrice: 650,
      familyId: fam.id,
      barcodes: [{ code: '6001234567899' }],
    }).id;
    A.lait = pc.catalogue.saveArticle(boot.admin.id, { name: 'Lait 1 L', unit: 'piece', vatRateId: tva, purchasePrice: 600, salePrice: 900 }).id;
    wh = pc.admin.salesWarehouse(storeId).id;
    pc.stock.receive(ctx, {
      warehouseId: wh,
      lines: [
        { articleId: A.biere, qty: 12_000, unitCost: 450 },
        { articleId: A.lait, qty: 1_000, unitCost: 600 },
      ],
    });
    invId = pc.inventories.create(ctx, { warehouseId: wh, kind: 'global' }).id;
    await enrollStation(pc, url, 'cle-enrolement-de-test', 'PC caisse 1');
    await syncOnce(pc);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('relie le téléphone avec le QR code du gérant, une seule fois', async () => {
    expect((await fetch(`${url}/admin/api/mobile/pairing`, { method: 'POST' })).status).toBe(401);
    const p = await (await admin('/admin/api/mobile/pairing', { storeId })).json();
    expect(p).toMatchObject({ storeName: 'Superette Akwa' });
    expect(p.code).toMatch(/^[A-Z2-9]{8}$/);
    expect(p.qr).toContain('<svg');
    const res = await fetch(`${url}/api/v1/mobile/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: p.code.toLowerCase(), name: 'Téléphone Awa' }),
    });
    const paired = await res.json();
    expect(paired).toMatchObject({ storeId, storeName: 'Superette Akwa' });
    device = paired.token;
    const again = await fetch(`${url}/api/v1/mobile/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: p.code }) });
    expect(again.status).toBe(404);
    // Le téléphone ne lit pas le journal des PC (ventes, caisses…).
    expect((await fetch(`${url}/api/v1/sync/pull`, { headers: { authorization: `Bearer ${device}` } })).status).toBe(401);
  });

  it('connecte le compteur avec son code et le droit de compter', async () => {
    expect((await phone('/login', { login: 'awa', pin: '0000' })).status).toBe(401);
    const jean = await phone('/login', { login: 'jean', pin: '2222' });
    expect(jean.status).toBe(403);
    expect((await jean.json()).message).toContain('droit de compter');
    // Un caissier se connecte pour préparer un panier, sans voir les inventaires.
    const paul = await (await phone('/login', { login: 'paul', pin: '1111' })).json();
    expect(paul.can).toEqual({ count: false, cart: true, exit: false, missed: true, receive: false });
    expect((await (await phone('/inventories', undefined, paul.session)).json()).inventories).toEqual([]);
    expect((await phone('/counts', { counts: [] }, paul.session)).status).toBe(403);
    const ok = await (await phone('/login', { login: 'AWA', pin: '5678' })).json();
    expect(ok.user).toMatchObject({ name: 'Awa', role: 'stock' });
    session = ok.session;
    expect((await phone('/inventories', undefined, 'faux')).status).toBe(401);
  });

  it('télécharge le catalogue avec les codes-barres et les rayons, puis rien tant qu’il ne change pas', async () => {
    const c = await (await phone('/catalog')).json();
    const biere = c.articles.find((a: { id: string }) => a.id === A.biere);
    expect(biere).toMatchObject({ name: 'Bière 65 cl', unit: 'piece', barcodes: [{ code: '6001234567899', packQty: 1000 }] });
    expect(c.departments.find((d: { id: string }) => d.id === biere.departmentId)).toMatchObject({ name: 'Boissons' });
    expect(await (await phone(`/catalog?since=${c.version}`)).json()).toEqual({ version: c.version, unchanged: true });
  });

  it('envoie le catalogue sans les photos, puis la photo d’une fiche à part', async () => {
    const thumb = `data:image/jpeg;base64,${'A'.repeat(2000)}`;
    pc.catalogue.setPhoto(ctx.userId, A.lait!, { photo: thumb, thumb });
    await syncOnce(pc);
    const c = await (await phone('/catalog')).json();
    expect(c.articles.every((a: { thumb: unknown }) => a.thumb === null)).toBe(true);
    expect(await (await phone(`/articles/${A.lait}/thumb`)).json()).toEqual({ thumb });
    expect(await (await phone(`/articles/${A.biere}/thumb`)).json()).toEqual({ thumb: null });
  });

  it('cherche sur le serveur un code ou un nom que le téléphone ne trouve pas', async () => {
    const ids = async (q: string) => ((await (await phone(`/find?q=${encodeURIComponent(q)}`)).json()).articles as { id: string }[]).map((a) => a.id);
    expect(await ids('6001234567899')).toEqual([A.biere]);
    // Code-barres lu sans le zéro de tête, ou avec.
    expect(await ids('06001234567899')).toEqual([A.biere]);
    expect(await ids('biere')).toEqual([A.biere]);
    expect(await ids('LAIT 1')).toEqual([A.lait]);
    expect(await ids('x')).toEqual([]);
    expect((await phone('/find?q=lait', undefined, 'faux')).status).toBe(401);
  });

  it('additionne les endroits, garde la dernière saisie de chaque endroit et l’envoie aux PC', async () => {
    const list = await (await phone('/inventories')).json();
    expect(list.inventories).toHaveLength(1);
    expect(list.inventories[0]).toMatchObject({ id: invId, kind: 'global', counted: [], expected: null });
    expect(list.inventories[0].articleIds).toEqual(expect.arrayContaining([A.biere, A.lait]));

    const first = [count(A.biere!, 'Rayon', 5_000, at(0)), count(A.biere!, 'Réserve', 7_000, at(5))];
    expect((await (await phone('/counts', { counts: first })).json()).accepted).toHaveLength(2);
    // Renvoyé (réseau coupé avant la réponse) : rien ne change.
    expect((await (await phone('/counts', { counts: first })).json()).accepted).toHaveLength(2);
    await syncOnce(pc);
    expect(line(invId, A.biere!)).toMatchObject({ counted: 12_000, counted_by_name: 'Awa', difference: 0 });

    await phone('/counts', { counts: [count(A.biere!, 'Rayon', 4_000, at(10))] });
    await syncOnce(pc);
    expect(line(invId, A.biere!)).toMatchObject({ counted: 11_000, difference: -1_000 });
    expect(pc.inventories.history(invId).map((h) => h.user_name)).toContain('Awa');

    const after = await (await phone('/inventories')).json();
    expect(after.inventories[0].counted).toEqual([expect.objectContaining({ articleId: A.biere, qty: 11_000, by: 'Awa' })]);
    expect(after.inventories[0].mine).toEqual(
      expect.arrayContaining([expect.objectContaining({ location: 'Rayon', qty: 4_000 }), expect.objectContaining({ location: 'Réserve', qty: 7_000 })]),
    );
  });

  it('remet à l’heure du serveur les comptages d’un téléphone qui retarde', async () => {
    // Le téléphone retarde d'une heure : son comptage serait avant la réception du stock.
    const late = (iso: string) => new Date(Date.parse(iso) - 3_600_000).toISOString();
    const c = count(A.biere!, 'Rayon', 4_000, late(at(12)));
    await phone('/counts', { counts: [c], sentAt: late(new Date().toISOString()) });
    await syncOnce(pc);
    expect(line(invId, A.biere!)).toMatchObject({ counted: 11_000, difference: -1_000 });
  });

  it('fait recompter un gros écart par un autre compteur', async () => {
    await phone('/counts', { counts: [count(A.lait!, 'Rayon', 9_000, at(15))] });
    expect((await (await phone('/inventories')).json()).inventories[0].recount).toEqual([]);
    const steve = await (await phone('/login', { login: 'steve', pin: '1234' })).json();
    expect((await (await phone('/inventories', undefined, steve.session)).json()).inventories[0].recount).toEqual([A.lait]);
    const o = await (await admin('/admin/api/mobile')).json();
    expect(o.inventories[0].recount).toEqual([expect.objectContaining({ name: 'Lait 1 L', counted: 9_000, expected: 1_000, byName: 'Awa' })]);
    // Steve recompte au même endroit : sa saisie remplace celle d'Awa et le produit n'est plus à recompter.
    await phone('/counts', { counts: [count(A.lait!, 'Rayon', 1_000, at(20))] }, steve.session);
    expect((await (await phone('/inventories', undefined, steve.session)).json()).inventories[0].recount).toEqual([]);
    await syncOnce(pc);
    expect(line(invId, A.lait!)).toMatchObject({ counted: 1_000, counted_by_name: 'Steve' });
  });

  it('ajoute à un inventaire partiel le produit compté hors de sa liste', async () => {
    const partial = pc.inventories.create(ctx, { warehouseId: wh, kind: 'partial', articleIds: [A.lait!] }).id;
    await syncOnce(pc);
    const res = await (await phone('/counts', { counts: [count(A.biere!, 'Rayon', 3_000, at(25), partial)] })).json();
    expect(res.accepted).toHaveLength(1);
    await syncOnce(pc);
    expect(line(partial, A.biere!)).toMatchObject({ counted: 3_000 });
  });

  it('suit les compteurs, les rayons confiés et les codes inconnus', async () => {
    const biereDept = (await (await phone('/catalog')).json()).articles.find((a: { id: string }) => a.id === A.biere).departmentId;
    const awa = pc.admin.listUsers().find((u) => u.login === 'awa')!;
    await admin('/admin/api/mobile/assign', { inventoryId: invId, userId: awa.id, departmentIds: [biereDept] });
    expect((await (await phone('/inventories')).json()).inventories.find((i: { id: string }) => i.id === invId).assigned).toEqual([biereDept]);

    const photo = `data:image/png;base64,${Buffer.from('image').toString('base64')}`;
    await phone('/unknowns', {
      id: 'inconnu-0001',
      inventoryId: invId,
      code: '9990001112223',
      note: 'Biscuits Choco',
      qty: 6_000,
      location: 'Réserve',
      photo,
      at: at(30),
    });
    const o = await (await admin('/admin/api/mobile')).json();
    const inv = o.inventories.find((i: { id: string }) => i.id === invId);
    expect(inv).toMatchObject({ total: 2, counted: 2 });
    expect(inv.departments).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'Boissons', total: 1, counted: 1 })]));
    expect(inv.counters.find((c: { name: string }) => c.name === 'Awa')).toMatchObject({ products: 2, phone: true });
    expect(inv.assignments).toEqual([{ userId: awa.id, departmentIds: [biereDept] }]);
    expect(o.users.map((u: { name: string }) => u.name)).toEqual(expect.arrayContaining(['Awa', 'Steve']));
    expect(o.users.map((u: { name: string }) => u.name)).not.toContain('Paul');
    expect(o.unknowns[0]).toMatchObject({ id: 'inconnu-0001', code: '9990001112223', note: 'Biscuits Choco', user: 'Awa', hasPhoto: true });
    expect(o.devices[0]).toMatchObject({ name: 'Téléphone Awa', online: true, revoked: false });
    const img = await admin('/admin/api/mobile/unknowns/inconnu-0001/photo');
    expect(img.headers.get('content-type')).toBe('image/png');
    await admin('/admin/api/mobile/unknowns/inconnu-0001/done', {});
    expect((await (await admin('/admin/api/mobile')).json()).unknowns).toEqual([]);
    // Les téléphones ne comptent pas dans les postes de la licence, ni dans le tableau du gérant.
    expect((await (await admin('/admin/api/overview')).json()).devices.find((d: { kind: string }) => d.kind === 'mobile')).toMatchObject({ register: 'Téléphone d’inventaire' });
  });

  it('montre le stock attendu seulement si le gérant le choisit', async () => {
    await admin('/admin/api/mobile/settings', { showExpected: true });
    const inv = (await (await phone('/inventories')).json()).inventories.find((i: { id: string }) => i.id === invId);
    expect(inv.expected[A.biere!]).toBe(12_000);
    await admin('/admin/api/mobile/settings', { showExpected: false });
  });

  it('fait compter un aide sans compte, au nom de son responsable, sur cet inventaire seulement', async () => {
    await admin('/admin/api/mobile/settings', { showExpected: true });
    const g = await (await admin('/admin/api/mobile/guests', { inventoryId: invId, name: 'Lucas', onBehalfOf: ctx.userId })).json();
    expect(g.code).toMatch(/^\d{6}$/);
    expect(g.qr).toContain('<svg');
    // Téléphone de l'aide, pas encore relié : le QR de l'aide le relie et le connecte.
    const paired = await (
      await fetch(`${url}/api/v1/mobile/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ guest: g.code, name: 'Tecno de Lucas' }) })
    ).json();
    expect(paired.user).toMatchObject({ name: 'Lucas (aide)', role: 'guest' });
    const asGuest = (path: string, body?: unknown) => {
      const headers = { authorization: `Bearer ${paired.token}`, 'x-fedonix-session': paired.session, 'content-type': 'application/json' };
      return fetch(`${url}/api/v1/mobile${path}`, body === undefined ? { headers } : { method: 'POST', headers, body: JSON.stringify(body) });
    };
    const list = (await (await asGuest('/inventories')).json()).inventories;
    expect(list.map((i: { id: string }) => i.id)).toEqual([invId]);
    expect(list[0].expected).toBeNull();
    await admin('/admin/api/mobile/settings', { showExpected: false });
    const res = await (await asGuest('/counts', { counts: [count(A.lait!, 'Réserve', 4_000, at(30)), count(A.lait!, 'Rayon', 1_000, at(31), 'autre-inventaire')] })).json();
    expect(res.accepted).toHaveLength(1);
    expect(res.rejected).toEqual([expect.objectContaining({ reason: 'Inventaire non confié à cet aide' })]);
    await syncOnce(pc);
    // Sur le PC, la saisie est au nom du responsable (un vrai utilisateur) ; le gérant voit l'aide.
    expect(line(invId, A.lait!)).toMatchObject({ counted_by_name: "Steve" });
    const o = await (await admin('/admin/api/mobile')).json();
    const inv = o.inventories.find((i: { id: string }) => i.id === invId);
    expect(inv.counters.find((c: { name: string }) => c.name === 'Lucas (aide)')).toMatchObject({ products: 1, phone: true });
    expect(inv.guests[0]).toMatchObject({ name: 'Lucas', code: g.code, onBehalfOf: 'Steve', active: true });
    // Le même code sert aussi sur un téléphone du magasin déjà relié.
    expect((await phone('/guest', { code: '000000' })).status).toBe(401);
    expect((await (await phone('/guest', { code: g.code })).json()).user).toMatchObject({ name: 'Lucas (aide)' });
    await admin(`/admin/api/mobile/guests/${g.id}/revoke`, {});
    expect((await asGuest('/inventories')).status).toBe(401);
    // Un second aide, encore actif quand l'inventaire est clôturé.
    const g2 = await (await admin('/admin/api/mobile/guests', { inventoryId: invId, name: 'Inès', onBehalfOf: ctx.userId })).json();
    guestSession = (await (await phone('/guest', { code: g2.code })).json()).session;
    expect((await phone('/inventories', undefined, guestSession)).status).toBe(200);
  });

  it('refuse les comptages d’un inventaire clôturé, puis le téléphone délié', async () => {
    pc.inventories.close(ctx, invId);
    await syncOnce(pc);
    const res = await (await phone('/counts', { counts: [count(A.biere!, 'Rayon', 1_000, at(35))] })).json();
    expect(res).toMatchObject({ accepted: [], rejected: [{ reason: 'Inventaire clôturé' }] });
    const ended = await phone('/inventories', undefined, guestSession);
    expect([ended.status, (await ended.json()).message]).toEqual([401, expect.stringContaining('Accès d’aide terminé')]);
    expect((await (await phone('/inventories')).json()).inventories.map((i: { id: string }) => i.id)).not.toContain(invId);
    const o = await (await admin('/admin/api/mobile')).json();
    await admin(`/admin/api/mobile/devices/${o.devices.find((d: { name: string }) => d.name === 'Téléphone Awa').id}/revoke`, {});
    expect((await phone('/inventories')).status).toBe(401);
  });

  it('sert la page du gérant', async () => {
    const page = await fetch(`${url}/gerant/inventaire`);
    expect(await page.text()).toContain('Inventaire sur téléphone');
  });
});
