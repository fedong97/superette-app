import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BUILTIN_TEMPLATES, createServices, installFiche, openDatabase, openServices } from '../src';

const boot = (s: ReturnType<typeof createServices>, code = 'DLA1', name = 'Superette Akwa') =>
  s.admin.bootstrap({ storeCode: code, storeName: name, adminName: 'Steve', adminLogin: 'steve', adminPin: '1234' });

describe('modèles de boutique', () => {
  it("chaque modèle livré s'applique à une boutique neuve", () => {
    for (const t of BUILTIN_TEMPLATES) {
      const s = createServices(openDatabase(':memory:'), () => new Date('2026-10-17T08:00:00'));
      const { store, admin } = boot(s);
      expect(s.templates.apply(admin.id, store.id, t).departments, t.id).toBe(t.departments.length);
    }
  });

  it('monte une pharmacie depuis le modèle, puis refait une boutique depuis un modèle maison', () => {
    const s = createServices(openDatabase(':memory:'), () => new Date('2026-10-17T08:00:00'));
    const { store, admin } = boot(s);
    const pharmacie = BUILTIN_TEMPLATES.find((t) => t.id === 'pharmacie')!;
    const r = s.templates.apply(admin.id, store.id, pharmacie);
    expect(r).toMatchObject({ departments: 3, families: 9 });
    expect(s.admin.storeSettings(store.id).expiryAlertDays).toBe(90);
    expect(s.templates.apply(admin.id, store.id, pharmacie)).toMatchObject({ departments: 0, families: 0 }); // rien en double

    const tva = s.admin.listVatRates()[0]!.id;
    s.catalogue.saveArticle(admin.id, { name: 'Doliprane 500', unit: 'piece', vatRateId: tva, purchasePrice: 600, salePrice: 900, barcodes: [{ code: '3400930000007' }] });
    s.admin.saveRights(admin.id, 'cashier', ['sales']);
    s.admin.saveStoreSettings(admin.id, store.id, { ticketHeader: 'Pharmacie du Marché', maxDiscountPct: 5 });
    const maison = s.templates.capture(store.id, { name: 'Ma pharmacie', articles: true });
    expect(maison.settings).not.toHaveProperty('ticketHeader');
    expect(maison.articles).toMatchObject([{ name: 'Doliprane 500', barcode: '3400930000007', salePrice: 900 }]);

    const other = createServices(openDatabase(':memory:'), () => new Date('2026-10-17T08:00:00'));
    const b = boot(other, 'YDE1', 'Pharmacie Mvog-Mbi');
    const applied = other.templates.apply(b.admin.id, b.store.id, JSON.parse(JSON.stringify(maison)));
    expect(applied.articles).toMatchObject({ created: 1, errors: 0 });
    expect(other.admin.storeSettings(b.store.id)).toMatchObject({ maxDiscountPct: 5, expiryAlertDays: 90, ticketHeader: '' });
    expect(other.admin.rights('cashier')).toContain('sales');
  });
});

describe('remontée des postes distants', () => {
  it('le dépôt sans réseau remonte ses ventes par fichier et reçoit le catalogue de la boutique', async () => {
    const root = mkdtempSync(join(tmpdir(), 'fedonix-remontee-'));
    let now = new Date('2026-10-17T08:00:00');
    const clock = () => now;
    const hq = openServices(join(root, 'boutique.db'), clock);
    const { store, admin } = boot(hq);
    const tva = hq.admin.listVatRates()[0]!.id;
    const riz = hq.catalogue.saveArticle(admin.id, { name: 'Riz 5 kg', unit: 'piece', vatRateId: tva, purchasePrice: 3_000, salePrice: 5_000 });
    const depot = hq.admin.createStore(admin.id, { storeCode: 'BAF1', storeName: 'Dépôt Bafoussam' });
    const caisse = hq.admin.listRegisters(depot.id).find((r) => r.kind === 'cash')!;
    // La boutique a déjà vendu : un poste distant s'installe quand même.
    const ctx = { storeId: store.id, registerId: hq.admin.station()!.register!.id, userId: admin.id };
    hq.stock.receive(ctx, { warehouseId: hq.admin.salesWarehouse(store.id).id, lines: [{ articleId: riz.id, qty: 10_000, unitCost: 3_000 }] });
    hq.pos.openSession(ctx, 0);
    hq.pos.completeSale(ctx, { lines: [{ articleId: riz.id, qty: 1_000 }], payments: [{ method: 'CASH', amount: 5_000 }] });

    const install = await hq.fiches.export(admin, 'installation', join(root, 'usb'), '0.59.0', { remote: { registerId: caisse.id } });
    expect(install.store_name).toBe('Dépôt Bafoussam');
    const depotFile = join(root, 'depot.db');
    openServices(depotFile, clock).db.close();
    installFiche(depotFile, install.file);
    const d = openServices(depotFile, clock);
    expect(d.admin.station()).toMatchObject({ store: { code: 'BAF1' }, register: { id: caisse.id } });
    expect(d.relay.status()).toMatchObject({ role: 'distant', pending: 0 });

    // Au dépôt : réception et vente du jour.
    now = new Date('2026-10-17T10:00:00');
    const dctx = { storeId: depot.id, registerId: caisse.id, userId: admin.id };
    d.stock.receive(dctx, { warehouseId: d.admin.salesWarehouse(depot.id).id, lines: [{ articleId: riz.id, qty: 5_000, unitCost: 3_000 }] });
    d.pos.openSession(dctx, 0);
    const sale = d.pos.completeSale(dctx, { lines: [{ articleId: riz.id, qty: 2_000 }], payments: [{ method: 'CASH', amount: 10_000 }] });
    expect(sale.number).toMatch(/^BAF1-/);
    expect(d.relay.status().pending).toBeGreaterThan(0);
    const up = d.relay.exportRemontee(admin, join(root, 'whatsapp'));
    expect(d.relay.status().pending).toBe(0);
    expect(() => d.relay.integrate(admin.id, up.file)).toThrow(/dans la boutique/);

    // À la boutique, qui a changé un prix entre-temps.
    now = new Date('2026-10-17T11:00:00');
    hq.catalogue.saveArticle(admin.id, { name: 'Riz 5 kg', unit: 'piece', vatRateId: tva, purchasePrice: 3_000, salePrice: 5_200 }, riz.id);
    expect(hq.relay.read(up.file)).toMatchObject({ kind: 'remontee', storeName: 'Dépôt Bafoussam', integrated_at: null });
    const r = hq.relay.integrate(admin.id, up.file);
    expect(r).toMatchObject({ kind: 'remontee', conflicts: 0 });
    expect(hq.pos.listSales({ storeId: depot.id })).toHaveLength(1);
    expect(() => hq.relay.integrate(admin.id, up.file)).toThrow(/déjà été intégré/);
    expect(hq.relay.status().remotes).toMatchObject([{ code: 'BAF1' }]);

    // Mise à jour vers le dépôt : le nouveau prix, mais pas les ventes de la boutique.
    const down = hq.relay.exportUpdate(admin, depot.id, join(root, 'whatsapp'));
    d.relay.integrate(admin.id, down.file);
    expect(d.catalogue.getArticle(riz.id, depot.id).sale_price).toBe(5_200);
    expect(d.pos.listSales({ storeId: store.id })).toHaveLength(1); // celle d'avant l'installation, pas de nouvelle
  });
});

describe('contrôle avant clôture', () => {
  it("signale une journée de caisse restée ouverte et une fiche d'intervention pas rapportée", async () => {
    const root = mkdtempSync(join(tmpdir(), 'fedonix-cloture-'));
    let now = new Date('2025-06-01T09:00:00');
    const s = openServices(join(root, 'b.db'), () => now);
    const { store, register, admin } = boot(s);
    const ctx = { storeId: store.id, registerId: register.id, userId: admin.id };
    s.fiscal.list(store.id);
    s.pos.openSession(ctx, 0);
    await s.fiches.export(admin, 'intervention', join(root, 'usb'), '0.59.0');
    now = new Date('2026-02-01T09:00:00');
    const fy = s.fiscal.list(store.id).find((f) => f.start_date === '2025-01-01')!;
    const checks = s.fiscal.checkClose(store.id, fy.id);
    expect(checks.find((c) => c.key === 'cash')).toMatchObject({ status: 'warning' });
    expect(checks.find((c) => c.key === 'fiches')).toMatchObject({ status: 'warning' });
    expect(checks.find((c) => c.key === 'entries')).toMatchObject({ status: 'ok' });
    expect(checks.find((c) => c.key === 'ended')).toMatchObject({ status: 'ok' });
  });
});
