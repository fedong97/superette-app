import { existsSync, mkdirSync, mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { inspectDossier, installFiche, openServices, packFiche, unpackFiche } from '../src';

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'fedonix-fiche-'));
  let now = new Date('2026-10-17T08:00:00');
  const clock = () => now;
  const s = openServices(join(root, 'superette.db'), clock);
  const { store, register, admin } = s.admin.bootstrap({ storeCode: 'DLA1', storeName: 'Superette Akwa', adminName: 'Steve', adminLogin: 'steve', adminPin: '1234' });
  const ctx = { storeId: store.id, registerId: register.id, userId: admin.id };
  const tva = s.admin.listVatRates().find((r) => r.rate_bp === 1925)!.id;
  const article = (name: string, salePrice: number) => s.catalogue.saveArticle(admin.id, { name, unit: 'piece', vatRateId: tva, purchasePrice: 0, salePrice });
  const savon = article('Savon Azur', 400);
  s.stock.receive(ctx, { warehouseId: s.admin.salesWarehouse(store.id).id, lines: [{ articleId: savon.id, qty: 50_000, unitCost: 250 }] });
  s.pos.openSession(ctx, 0);
  const sell = () => s.pos.completeSale(ctx, { lines: [{ articleId: savon.id, qty: 1000 }], payments: [{ method: 'CASH', amount: 400 }] });
  return { root, s, ctx, admin, tva, savon, sell, clock, setNow: (iso: string) => (now = new Date(iso)) };
}

describe('fiches boutique', () => {
  it("emporte une fiche d'intervention sans bloquer la boutique et fusionne ses modifications au retour", async () => {
    const { root, s, ctx, admin, tva, savon, sell, clock, setNow } = setup();
    sell();
    const usb = join(root, 'usb');
    const info = await s.fiches.export(admin, 'intervention', usb, '0.58.0');
    expect(info).toMatchObject({ ok: true, store_name: 'Superette Akwa', sales: 1 });
    expect(info.name).toBe('Superette-Akwa-intervention-2026-10-17-0800.fedonix');
    expect(info.fiche).toMatchObject({ kind: 'intervention', storeCode: 'DLA1', byName: 'Steve' });

    // La boutique continue : une vente et un article créés pendant l'intervention.
    setNow('2026-10-17T09:00:00');
    sell();
    const lait = s.catalogue.saveArticle(admin.id, { name: 'Lait Nido', unit: 'piece', vatRateId: tva, purchasePrice: 0, salePrice: 2500 });

    // Chez le technicien : la fiche s'ouvre sans licence, ne vend pas, ne garde pas les réglages du PC.
    const t = openServices(info.file, clock);
    expect(t.license.status()).toMatchObject({ state: 'fiche', canSell: false });
    expect(t.license.status().message).toMatch(/Fiche d'intervention de Superette Akwa, données arrêtées au 17\/10\/2026 à 08:00/);
    expect(t.sync.credentials()).toBeNull();
    expect(t.admin.station()?.store.code).toBe('DLA1');
    setNow('2026-10-17T10:00:00');
    t.catalogue.saveArticle(admin.id, { name: 'Savon Azur 200 g', unit: 'piece', vatRateId: tva, purchasePrice: 0, salePrice: 450 }, savon.id);
    const riz = t.catalogue.saveArticle(admin.id, { name: 'Riz 5 kg', unit: 'piece', vatRateId: tva, purchasePrice: 0, salePrice: 5000 });
    expect(riz.code).toMatch(/^DLA11T-/); // ses numéros ne croisent jamais ceux de la boutique
    const client = t.customers.saveCustomer(admin.id, { name: 'Mballa' });
    t.admin.setSetting('ticket.footer', 'Merci de votre visite');
    t.admin.setSetting('printer.name', 'Imprimante du technicien');
    t.db.close();

    // Retour à la boutique : rien de ce qu'elle a fait entre-temps n'est perdu.
    setNow('2026-10-17T11:00:00');
    expect(s.fiches.check(info.file)).toMatchObject({ ok: true, returned_at: null });
    const back = s.fiches.bringBack(ctx.userId, info.file);
    expect(back).toMatchObject({ kind: 'intervention', byName: 'Steve', conflicts: 0, settings: 1 });
    expect(back.applied).toBeGreaterThanOrEqual(3);
    expect(s.catalogue.getArticle(savon.id, ctx.storeId)).toMatchObject({ name: 'Savon Azur 200 g', sale_price: 450 });
    expect(s.catalogue.getArticle(riz.id, ctx.storeId).name).toBe('Riz 5 kg');
    expect(s.catalogue.getArticle(lait.id, ctx.storeId).name).toBe('Lait Nido');
    expect(s.customers.getCustomer(client.id).name).toBe('Mballa');
    expect(s.pos.listSales({ storeId: ctx.storeId })).toHaveLength(2);
    expect(s.admin.getSetting('ticket.footer')).toBe('Merci de votre visite');
    expect(s.admin.getSetting('printer.name')).toBeNull();
    // Les modifications repartent vers le serveur et les autres PC.
    expect(s.sync.pending(1000).map((e) => e.entityId)).toEqual(expect.arrayContaining([savon.id, riz.id, client.id]));
    expect(s.fiches.history()[0]).toMatchObject({ kind: 'intervention', returned_by: ctx.userId });
    expect(() => s.fiches.bringBack(ctx.userId, info.file)).toThrow(/déjà été rapportée/);
  });

  it('garde la modification la plus récente quand la boutique et la fiche changent le même article', async () => {
    const { root, s, ctx, admin, tva, savon, clock, setNow } = setup();
    const info = await s.fiches.export(admin, 'comptable', join(root, 'usb'), '0.58.0');
    const t = openServices(info.file, clock);
    setNow('2026-10-17T09:00:00');
    t.catalogue.saveArticle(admin.id, { name: 'Savon (fiche)', unit: 'piece', vatRateId: tva, purchasePrice: 0, salePrice: 400 }, savon.id);
    t.db.close();
    setNow('2026-10-17T10:00:00');
    s.catalogue.saveArticle(admin.id, { name: 'Savon (boutique)', unit: 'piece', vatRateId: tva, purchasePrice: 0, salePrice: 400 }, savon.id);
    s.fiches.bringBack(ctx.userId, info.file);
    expect(s.catalogue.getArticle(savon.id, ctx.storeId).name).toBe('Savon (boutique)');
  });

  it("refuse une fiche d'une autre boutique et ne sort pas de fiche d'une fiche", async () => {
    const a = setup();
    const b = setup();
    const info = await a.s.fiches.export(a.admin, 'intervention', join(a.root, 'usb'), '0.58.0');
    expect(() => b.s.fiches.bringBack(b.ctx.userId, info.file)).toThrow(/autre boutique \(Superette Akwa\)/);
    const t = openServices(info.file, a.clock);
    await expect(t.fiches.export(a.admin, 'comptable', join(a.root, 'usb2'), '0.58.0')).rejects.toThrow(/déjà une fiche d'intervention/);
    t.db.close();
  });

  it('installe chez le client une boutique préparée au bureau', async () => {
    const root = mkdtempSync(join(tmpdir(), 'fedonix-installation-'));
    const clock = () => new Date('2026-10-17T08:00:00');
    const office = openServices(join(root, 'bureau.fedonix'), clock);
    const { admin } = office.admin.bootstrap({ storeCode: 'YDE1', storeName: 'Boutique Mvog-Mbi', adminName: 'Steve', adminLogin: 'steve', adminPin: '1234' });
    const tva = office.admin.listVatRates()[0]!.id;
    office.catalogue.saveArticle(admin.id, { name: 'Huile 1 L', unit: 'piece', vatRateId: tva, purchasePrice: 0, salePrice: 1500 });
    office.license.status();
    const info = await office.fiches.export(admin, 'installation', join(root, 'usb'), '0.58.0');
    expect(info.fiche?.kind).toBe('installation');

    // Sur le PC du client : la boutique est prête, avec sa caisse ; la licence d'essai démarre sur ce PC.
    mkdirSync(join(root, 'client'));
    const target = join(root, 'client', 'superette.db');
    const fresh = openServices(target, clock);
    fresh.db.close();
    installFiche(target, info.file);
    const shop = openServices(target, clock);
    expect(shop.fiches.current()).toBeNull();
    expect(shop.admin.station()?.store.name).toBe('Boutique Mvog-Mbi');
    expect(shop.catalogue.searchArticles('huile', shop.admin.station()!.store.id)).toHaveLength(1);
    expect(shop.license.status()).toMatchObject({ state: 'trial', canSell: true });
    expect(inspectDossier(target)).toMatchObject({ ok: true, store_code: 'YDE1', fiche: null });
  });

  it("ne prépare pas d'installation qui emporterait des ventes d'essai", async () => {
    const { root, s, admin, sell } = setup();
    sell();
    await expect(s.fiches.export(admin, 'installation', join(root, 'usb'), '0.58.0')).rejects.toThrow(/déjà des ventes/);
  });
});

describe('fiches envoyées et dossier partagé', () => {
  it('compresse une fiche pour l’envoyer et la rapporte après décompression', async () => {
    const { root, s, ctx, admin, tva, savon, clock, setNow } = setup();
    const info = await s.fiches.export(admin, 'intervention', join(root, 'envoi'), '0.59.0');
    const packed = await packFiche(info.file);
    expect(packed).toMatch(/\.fedonixz$/);
    expect(existsSync(info.file)).toBe(false);
    expect(statSync(packed).size).toBeLessThan(info.size / 3);
    const file = await unpackFiche(packed, join(root, 'recu'));
    const t = openServices(file, clock);
    setNow('2026-10-17T10:00:00');
    t.catalogue.saveArticle(admin.id, { name: 'Savon envoyé', unit: 'piece', vatRateId: tva, purchasePrice: 0, salePrice: 400 }, savon.id);
    t.db.close();
    s.fiches.bringBack(ctx.userId, file);
    expect(s.catalogue.getArticle(savon.id, ctx.storeId).name).toBe('Savon envoyé');
    await expect(unpackFiche(join(root, 'recu', basename(file)), join(root, 'x'))).rejects.toThrow(/compressée illisible/);
  });

  it('dépose la copie du comptable dans le dossier partagé et y trouve les fiches à rapporter', async () => {
    const { root, s, ctx, admin, tva, savon, clock, setNow } = setup();
    const share = join(root, 'partage');
    s.fiches.configureShare(admin.id, { dir: share, every: 60 });
    const first = await s.fiches.autoShare('0.59.0');
    expect(first?.file).toBe(join(share, 'Comptable', 'Superette-Akwa-comptable.fedonix'));
    expect(await s.fiches.autoShare('0.59.0')).toBeNull(); // pas avant une heure
    setNow('2026-10-17T09:05:00');
    expect((await s.fiches.autoShare('0.59.0'))?.file).toBe(first?.file); // remplacée, pas empilée
    expect(s.fiches.history()).toHaveLength(0);

    // Le technicien dépose sa fiche dans « Retours ».
    const fiche = await s.fiches.export(admin, 'intervention', join(share, 'Retours'), '0.59.0');
    const t = openServices(fiche.file, clock);
    setNow('2026-10-17T10:00:00');
    t.catalogue.saveArticle(admin.id, { name: 'Savon partagé', unit: 'piece', vatRateId: tva, purchasePrice: 0, salePrice: 400 }, savon.id);
    t.db.close();
    expect(s.fiches.shareStatus().pending).toMatchObject([{ kind: 'intervention', by_name: 'Steve', store_name: 'Superette Akwa' }]);
    s.fiches.bringBack(ctx.userId, fiche.file);
    s.fiches.archiveShared(fiche.file);
    expect(s.fiches.shareStatus().pending).toHaveLength(0);
    expect(existsSync(join(share, 'Retours', 'Rapportées', basename(fiche.file)))).toBe(true);
  });
  it("remise à zéro faite dans une fiche d'intervention : refaite dans la boutique au retour, avant les modifications", async () => {
    const { root, s, ctx, admin, tva, savon, sell, clock, setNow } = setup();
    sell();
    const info = await s.fiches.export(admin, 'intervention', join(root, 'usb'), '0.106.0');
    setNow('2026-10-17T09:00:00');
    sell(); // vente d'essai faite pendant l'intervention : effacée aussi

    // Chez le technicien : remise à zéro dans la fiche, puis un réglage de produit.
    const t = openServices(info.file, clock);
    t.reset.run(admin.id, { keepStock: true, inFiche: true });
    expect(t.fiches.markReset(admin, true)).toMatchObject({ keepStock: true, byName: 'Steve' });
    expect(t.pos.listSales({ storeId: ctx.storeId })).toHaveLength(0);
    setNow('2026-10-17T10:00:00');
    t.catalogue.saveArticle(admin.id, { name: 'Savon Azur', unit: 'piece', vatRateId: tva, purchasePrice: 0, salePrice: 450 }, savon.id);
    expect(t.sync.pending(1000).some((e) => e.entity === 'stock_movement')).toBe(false);
    t.db.close();

    // Retour : la fiche dit qu'il faut remettre la boutique à zéro, puis ses modifications sont ajoutées.
    setNow('2026-10-17T11:00:00');
    expect(s.fiches.check(info.file).fiche?.reset).toMatchObject({ keepStock: true });
    const meta = s.fiches.returnable(info.file);
    expect(meta.reset).toMatchObject({ keepStock: true });
    s.reset.run(ctx.userId, { keepStock: meta.reset!.keepStock });
    const back = s.fiches.bringBack(ctx.userId, info.file);
    expect(back).toMatchObject({ reset: true, conflicts: 0 });
    expect(s.pos.listSales({ storeId: ctx.storeId })).toHaveLength(0);
    expect(s.catalogue.getArticle(savon.id, ctx.storeId).sale_price).toBe(450);
    // Stock de départ : celui de la boutique (50 reçus, 2 vendus), une seule fois.
    const moves = s.db.prepare("SELECT qty FROM stock_movements WHERE article_id = ?").pluck().all(savon.id) as number[];
    expect(moves).toEqual([48_000]);
  });
});
