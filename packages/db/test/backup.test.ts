import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { inspectBackup, openServices, restoreDatabase } from '../src';

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'superette-backup-'));
  const file = join(root, 'superette.db');
  let now = new Date('2026-10-10T20:00:00');
  const s = openServices(file, () => now);
  const { store, register, admin } = s.admin.bootstrap({ storeCode: 'DLA1', storeName: 'Superette Akwa', adminName: 'Steve', adminLogin: 'steve', adminPin: '1234' });
  const ctx = { storeId: store.id, registerId: register.id, userId: admin.id };
  const tva = s.admin.listVatRates().find((r) => r.rate_bp === 1925)!.id;
  const savon = s.catalogue.saveArticle(admin.id, { name: 'Savon Azur', unit: 'piece', vatRateId: tva, purchasePrice: 0, salePrice: 400 });
  s.stock.receive(ctx, { warehouseId: s.admin.salesWarehouse(store.id).id, lines: [{ articleId: savon.id, qty: 50_000, unitCost: 250 }] });
  s.pos.openSession(ctx, 0);
  const sell = () => s.pos.completeSale(ctx, { lines: [{ articleId: savon.id, qty: 1000 }], payments: [{ method: 'CASH', amount: 400 }] });
  return { root, file, s, ctx, sell, setNow: (iso: string) => (now = new Date(iso)) };
}

describe('sauvegardes', () => {
  it('fait une sauvegarde par jour, vérifiée, garde les plus récentes et copie vers la clé USB', async () => {
    const { root, s, ctx, sell, setNow } = setup();
    sell();
    expect(s.backups.status()).toMatchObject({ dir: join(root, 'sauvegardes'), keep: 14, last_at: null, overdue: true });
    const usb = join(root, 'usb');
    s.backups.configure(ctx.userId, { keep: 2, copyDir: usb });

    const first = await s.backups.runAutomatic();
    expect(first).toMatchObject({ ok: true, kind: 'auto', store_name: 'Superette Akwa', sales: 1, articles: 1 });
    expect(first!.name).toBe('superette-DLA11-2026-10-10-200000-auto.db');
    expect(await s.backups.runAutomatic()).toBeNull(); // déjà faite aujourd'hui
    expect(s.backups.status()).toMatchObject({ overdue: false, last_error: null });

    for (const day of ['11', '12', '13']) {
      setNow(`2026-10-${day}T20:00:00`);
      sell();
      await s.backups.runAutomatic();
    }
    const list = s.backups.list();
    expect(list.map((b) => [b.name.slice(16, 26), b.sales])).toEqual([
      ['2026-10-13', 4],
      ['2026-10-12', 3],
    ]);
    // Un seul fichier par sauvegarde (pas de -wal ni -shm à oublier en copiant).
    expect(readdirSync(usb).sort()).toEqual(list.map((b) => b.name).sort());
    expect(readdirSync(join(root, 'sauvegardes')).sort()).toEqual(list.map((b) => b.name).sort());

    // Une sauvegarde manuelle (clé USB) n'est jamais effacée par la rotation.
    const manual = await s.backups.backup(ctx.userId, { dir: usb });
    expect(manual.kind).toBe('manual');
    setNow('2026-10-14T20:00:00');
    await s.backups.runAutomatic();
    expect(readdirSync(usb)).toContain(manual.name);
    expect(readdirSync(usb).filter((f) => f.endsWith('-auto.db'))).toHaveLength(2);

    // Clé USB débranchée : la sauvegarde principale réussit, l'erreur est signalée.
    s.backups.configure(ctx.userId, { copyDir: join(root, 'superette.db', 'impossible') });
    await s.backups.runAutomatic(true);
    expect(s.backups.status().last_error).toMatch(/clé USB débranchée/);
    expect(s.backups.status().overdue).toBe(false);
  });

  it('refuse un fichier qui n’est pas une sauvegarde et restaure une bonne sauvegarde', async () => {
    const { root, file, s, ctx, sell } = setup();
    sell();
    const backup = await s.backups.backup(ctx.userId, { dir: join(root, 'cle') });
    sell();
    sell();
    const safety = s.backups.safetyFile();
    s.backups.configure(ctx.userId, { copyDir: join(root, 'usb') });
    const keep = s.backups.localSettings();
    s.db.close();

    const junk = join(root, 'photo.db');
    writeFileSync(junk, 'pas une base');
    expect(inspectBackup(junk)).toMatchObject({ ok: false });
    expect(() => restoreDatabase(file, junk, safety)).toThrow(/illisible|abîmé/);

    restoreDatabase(file, backup.file, safety, keep);
    expect(inspectBackup(safety)).toMatchObject({ ok: true, sales: 3, kind: 'safety' });
    const restored = openServices(file);
    expect(restored.db.prepare('SELECT COUNT(*) FROM sales').pluck().get()).toBe(1);
    // Les réglages de sauvegarde du PC survivent à la restauration.
    expect(restored.backups.status().copy_dir).toBe(join(root, 'usb'));
    restored.db.close();
  });
});
