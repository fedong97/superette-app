import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type Services, openServices } from '@superette/db';
import { createApi, type SystemHooks } from '../src/main/api';
import { createDossiers } from '../src/main/dossiers';

const printer = new Proxy({}, { get: () => async () => undefined }) as never;
const sync = { now: async () => undefined, connect: async () => undefined } as never;
type Api = Record<string, (...a: unknown[]) => unknown>;

/** Un PC : sa liste de boutiques, ses fenêtres de choix (réponses préparées), ses relances notées. */
function pc(root: string, name: string) {
  const dossiers = createDossiers(join(root, name, 'userData'), join(root, name, 'Documents'));
  const opened: string[] = [];
  const installed: string[] = [];
  const answers = { folder: null as string | null, file: null as string | null };
  const system = (file: string): SystemHooks => ({
    chooseFolder: async () => answers.folder,
    chooseBackupFile: async () => null,
    openFolder: async () => undefined,
    restore: () => undefined,
    dossiers: {
      file,
      dir: dossiers.dir,
      list: () => dossiers.list(file),
      open: (f) => (dossiers.remember(f), opened.push(f)),
      create: (n) => dossiers.newFile(n),
      forget: (f) => dossiers.forget(f, file),
      importFile: (f) => dossiers.importFile(f),
      chooseFile: async () => answers.file,
      install: (f) => void installed.push(f),
    },
  });
  /** Démarre FEDONIX 360 sur la boutique retenue par ce PC. */
  const start = (clock: () => Date): { s: Services; api: Api; file: string } => {
    const file = dossiers.startupFile();
    const s = openServices(file, clock);
    return { s, api: createApi(s, printer, sync, '0.58.0', system(file)) as never, file };
  };
  return { dossiers, opened, installed, answers, start };
}

describe('fiches boutique dans l’application', () => {
  it("le technicien emporte la fiche, l'ouvre sur son PC sans réinstaller, et la boutique la reprend sans s'arrêter", async () => {
    const root = mkdtempSync(join(tmpdir(), 'fedonix-api-fiche-'));
    let now = new Date('2026-10-17T08:00:00');
    const clock = () => now;

    // La boutique.
    const shopPc = pc(root, 'boutique');
    const shop = shopPc.start(clock);
    const { store, register, admin } = shop.s.admin.bootstrap({ storeCode: 'DLA1', storeName: 'Superette Akwa', adminName: 'Steve', adminLogin: 'steve', adminPin: '1234' });
    shop.s.admin.createUser(admin.id, { name: 'Awa', login: 'awa', pin: '5555', role: 'cashier', storeId: store.id, registerId: register.id });
    const tva = shop.s.admin.listVatRates()[0]!.id;
    const riz = shop.s.catalogue.saveArticle(admin.id, { name: 'Riz 5 kg', unit: 'piece', vatRateId: tva, purchasePrice: 3_000, salePrice: 5_000 });

    shop.api['auth.login']!('awa', '5555');
    await expect(shop.api['fiche.export']!('intervention')).rejects.toThrow(/administrateur/);
    await expect(shop.api['fiche.export']!('comptable')).rejects.toThrow(/droits/);
    shop.api['auth.login']!('steve', '1234');
    shopPc.answers.folder = join(root, 'usb');
    const out = (await shop.api['fiche.export']!('intervention')) as { file: string };
    expect(existsSync(out.file)).toBe(true);

    // Le PC du technicien, qui n'a jamais vu cette boutique.
    const techPc = pc(root, 'technicien');
    const tech0 = techPc.start(clock);
    expect(tech0.s.admin.isInitialized()).toBe(false);
    const imported = tech0.api['dossier.importFiche']!(out.file) as { file: string; store_name: string };
    expect(imported).toMatchObject({ store_name: 'Superette Akwa' });
    expect(imported.file.startsWith(techPc.dossiers.dir)).toBe(true);
    expect(techPc.opened).toEqual([imported.file]);
    expect(() => tech0.api['dossier.importFiche']!(out.file)).toThrow(/déjà dans la liste/);
    tech0.s.db.close();

    // Redémarrage sur la fiche : on s'y connecte avec les utilisateurs de la boutique.
    const tech = techPc.start(clock);
    expect(tech.file).toBe(imported.file);
    tech.api['auth.login']!('steve', '1234');
    const state = tech.api['app.state']!() as { dossier: { fiche: { kind: string; banner: string } }; license: { state: string; canSell: boolean } };
    expect(state.dossier.fiche).toMatchObject({ kind: 'intervention', banner: expect.stringMatching(/la caisse ne vend pas ici/) });
    expect(state.license).toMatchObject({ state: 'fiche', canSell: false });
    expect(() => tech.api['sync.connect']!('http://serveur', 'cle')).toThrow(/ne se relie pas au serveur/);
    expect((tech.api['dossier.list']!() as { current: boolean; fiche: unknown }[]).find((d) => d.current)?.fiche).toBeTruthy();
    now = new Date('2026-10-17T10:00:00');
    tech.s.catalogue.saveArticle(admin.id, { name: 'Riz parfumé 5 kg', unit: 'piece', vatRateId: tva, purchasePrice: 3_000, salePrice: 5_500 }, riz.id);
    techPc.answers.folder = join(root, 'usb-retour');
    const copy = (await tech.api['fiche.saveCopy']!()) as { file: string };
    tech.s.db.close();

    // Retour à la boutique, qui a vendu entre-temps.
    now = new Date('2026-10-17T11:00:00');
    shopPc.answers.file = copy.file;
    const check = (await shop.api['fiche.chooseReturn']!()) as { fiche: { kind: string }; returned_at: string | null };
    expect(check).toMatchObject({ fiche: { kind: 'intervention' }, returned_at: null });
    expect(await shop.api['fiche.bringBack']!(copy.file)).toMatchObject({ conflicts: 0 });
    expect(shop.s.catalogue.getArticle(riz.id, store.id)).toMatchObject({ name: 'Riz parfumé 5 kg', sale_price: 5_500 });
    expect(shop.api['fiche.history']!()).toMatchObject([{ kind: 'intervention', returned_by: admin.id }]);
    expect(() => shop.api['setup.installFiche']!(copy.file)).toThrow(/déjà une boutique/);
    expect(() => shop.api['dossier.forget']!(shop.file)).toThrow(/ouverte/);
  });

  it("prépare une boutique au bureau dans un nouveau fichier et l'installe sur le PC du client", async () => {
    const root = mkdtempSync(join(tmpdir(), 'fedonix-api-installation-'));
    const clock = () => new Date('2026-10-17T08:00:00');

    // Au bureau : une nouvelle boutique à côté de celle du PC.
    const officePc = pc(root, 'bureau');
    const main = officePc.start(clock);
    const file = main.api['dossier.create']!('Boutique Mvog-Mbi') as string;
    expect(file).toBe(join(officePc.dossiers.dir, 'Boutique-Mvog-Mbi.fedonix'));
    main.s.db.close();
    officePc.dossiers.remember(file);
    const office = officePc.start(clock);
    expect(office.file).toBe(file);
    const { admin } = office.s.admin.bootstrap({ storeCode: 'YDE1', storeName: 'Boutique Mvog-Mbi', adminName: 'Steve', adminLogin: 'steve', adminPin: '1234' });
    office.s.catalogue.saveArticle(admin.id, { name: 'Huile 1 L', unit: 'piece', vatRateId: office.s.admin.listVatRates()[0]!.id, purchasePrice: 0, salePrice: 1_500 });
    office.api['auth.login']!('steve', '1234');
    officePc.answers.folder = join(root, 'usb');
    const fiche = (await office.api['fiche.export']!('installation')) as { file: string };

    // Chez le client : premier démarrage, on installe la boutique préparée.
    const clientPc = pc(root, 'client');
    const client = clientPc.start(clock);
    expect(() => client.api['setup.installFiche']!(join(root, 'nulle-part.fedonix'))).toThrow(/introuvable/);
    expect(client.api['setup.installFiche']!(fiche.file)).toMatchObject({ store_name: 'Boutique Mvog-Mbi', articles: 1 });
    expect(clientPc.installed).toEqual([fiche.file]);

    // Sur le PC du technicien qui suit plusieurs boutiques, elle devient une boutique ordinaire de la liste.
    const techPc = pc(root, 'technicien');
    const tech = techPc.start(clock);
    expect(() => tech.api['dossier.open']!(fiche.file)).toThrow(/Ouvrir une fiche/);
    const copy = tech.api['dossier.importFiche']!(fiche.file) as { file: string; fiche: unknown; store_name: string };
    expect(copy).toMatchObject({ ok: true, fiche: null, store_name: 'Boutique Mvog-Mbi' });
    expect((tech.api['dossier.list']!() as { file: string }[]).map((d) => d.file)).toContain(copy.file);
  });

  it("une nouvelle boutique sur le PC ne fait pas recommencer l'essai", () => {
    const { dossiers } = pc(mkdtempSync(join(tmpdir(), 'fedonix-essai-')), 'pc');
    expect(dossiers.shareTrial('2026-10-01')).toBe('2026-10-01');
    expect(dossiers.shareTrial(null)).toBe('2026-10-01');
    expect(dossiers.shareTrial('2026-10-17')).toBe('2026-10-01');
    expect(dossiers.shareTrial('2026-09-20')).toBe('2026-09-20');
  });

  it('envoie une fiche compressée, le technicien la renvoie compressée et la boutique la rapporte', async () => {
    const root = mkdtempSync(join(tmpdir(), 'fedonix-api-envoi-'));
    let now = new Date('2026-10-17T08:00:00');
    const clock = () => now;
    const shopPc = pc(root, 'boutique');
    const shop = shopPc.start(clock);
    const { admin } = shop.s.admin.bootstrap({ storeCode: 'DLA1', storeName: 'Superette Akwa', adminName: 'Steve', adminLogin: 'steve', adminPin: '1234' });
    const tva = shop.s.admin.listVatRates()[0]!.id;
    const riz = shop.s.catalogue.saveArticle(admin.id, { name: 'Riz 5 kg', unit: 'piece', vatRateId: tva, purchasePrice: 3_000, salePrice: 5_000 });
    shop.api['auth.login']!('steve', '1234');
    shopPc.answers.folder = join(root, 'whatsapp');
    const sent = (await shop.api['fiche.export']!('intervention', { send: true })) as { file: string };
    expect(sent.file).toMatch(/\.fedonixz$/);

    const techPc = pc(root, 'technicien');
    const tech0 = techPc.start(clock);
    techPc.answers.file = sent.file;
    const chosen = (await tech0.api['dossier.chooseFile']!()) as { file: string; fiche: { kind: string } };
    expect(chosen.fiche.kind).toBe('intervention');
    tech0.api['dossier.importFiche']!(chosen.file);
    tech0.s.db.close();
    const tech = techPc.start(clock);
    tech.api['auth.login']!('steve', '1234');
    now = new Date('2026-10-17T10:00:00');
    tech.s.catalogue.saveArticle(admin.id, { name: 'Riz envoyé', unit: 'piece', vatRateId: tva, purchasePrice: 3_000, salePrice: 5_000 }, riz.id);
    techPc.answers.folder = join(root, 'retour');
    const back = (await tech.api['fiche.saveCopy']!({ send: true })) as { file: string };
    expect(back.file).toMatch(/\.fedonixz$/);
    tech.s.db.close();

    expect(await shop.api['fiche.check']!(back.file)).toMatchObject({ fiche: { kind: 'intervention' }, returned_at: null });
    expect(await shop.api['fiche.bringBack']!(back.file)).toMatchObject({ conflicts: 0 });
    expect(shop.s.catalogue.getArticle(riz.id, shop.s.admin.station()!.store.id).name).toBe('Riz envoyé');
    expect(shop.api['repair.check']!()).toMatchObject({ ok: true });
  });
});
