import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { latestGoodBackup, openServices } from '../src';

function shop() {
  const root = mkdtempSync(join(tmpdir(), 'fedonix-reparation-'));
  const s = openServices(join(root, 'superette.db'), () => new Date('2026-10-17T08:00:00'));
  const { store, register, admin } = s.admin.bootstrap({ storeCode: 'DLA1', storeName: 'Superette Akwa', adminName: 'Steve', adminLogin: 'steve', adminPin: '1234' });
  const ctx = { storeId: store.id, registerId: register.id, userId: admin.id };
  const tva = s.admin.listVatRates()[0]!.id;
  const savon = s.catalogue.saveArticle(admin.id, { name: 'Savon', unit: 'piece', vatRateId: tva, purchasePrice: 0, salePrice: 400 });
  const warehouse = s.admin.salesWarehouse(store.id).id;
  s.stock.receive(ctx, { warehouseId: warehouse, lines: [{ articleId: savon.id, qty: 50_000, unitCost: 250 }] });
  return { root, s, ctx, admin, savon, warehouse };
}

describe('outil de réparation', () => {
  it('trouve un stock faux, le recalcule après une sauvegarde, et dit que tout va bien ensuite', async () => {
    const { root, s, admin, savon, warehouse } = shop();
    expect(s.repair.check()).toMatchObject({ ok: true, damaged: false });
    s.db.prepare('UPDATE stock SET qty = 7 WHERE article_id = ? AND warehouse_id = ?').run(savon.id, warehouse);
    const before = s.repair.check();
    expect(before.ok).toBe(false);
    expect(before.checks.find((c) => c.key === 'stock')).toMatchObject({ status: 'problem', detail: expect.stringMatching(/1 article/) });

    const done = await s.repair.repair(admin.id);
    expect(done).toMatchObject({ ok: true, damaged: false, backup: expect.stringMatching(/safety\.db$/) });
    expect(done.checks.find((c) => c.key === 'stock')).toMatchObject({ status: 'fixed' });
    expect(s.db.prepare('SELECT qty FROM stock WHERE article_id = ?').pluck().get(savon.id)).toBe(50_000);
    expect(s.repair.check().ok).toBe(true);
    // La sauvegarde d'avant réparation n'est pas proposée pour remplacer une base abîmée : on veut la dernière vraie sauvegarde.
    expect(latestGoodBackup(join(root, 'sauvegardes'))).toBeNull();
    await s.backups.saveNow(null);
    expect(latestGoodBackup(join(root, 'sauvegardes'))).toMatchObject({ ok: true, kind: 'auto' });
  });
});
