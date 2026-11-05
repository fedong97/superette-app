import type { INestApplication } from '@nestjs/common';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Services, createServices, enrollStation, openDatabase, syncOnce } from '@superette/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/main';

/**
 * Contre-expertise de l'audit (0.113.0) : un lot entier d'opérations refusées par le serveur
 * (donnée qu'il ne connaît pas encore) ne bloque plus les ventes faites ensuite.
 */
describe("file d'envoi du PC derrière des opérations refusées", () => {
  let app: INestApplication;
  let pc: Services;

  beforeAll(async () => {
    app = await createApp({ dataDir: join(mkdtempSync(join(tmpdir(), 'fedo-serveur-')), 'donnees'), port: 0, enrollmentKey: 'cle', localAdminToken: 'jeton' });
    await app.listen(0, '127.0.0.1');
    pc = createServices(openDatabase(':memory:'));
    pc.admin.bootstrap({ storeCode: 'DLA1', storeName: 'Superette Akwa', adminName: 'Steve', adminLogin: 'steve', adminPin: '1234' });
    await enrollStation(pc, await app.getUrl(), 'cle', 'PC caisse 1');
  });
  afterAll(() => app.close());

  it('envoie ce qui suit 600 opérations refusées, et les garde en attente', async () => {
    const add = pc.db.prepare(
      "INSERT INTO outbox (id, entity, entity_id, op, payload, store_id, register_id, created_at) VALUES (?, 'donnee_future', ?, 'upsert', '{}', NULL, NULL, ?)",
    );
    for (let i = 0; i < 600; i++) add.run(`futur-${i}`, `x-${i}`, new Date().toISOString());
    const admin = pc.admin.listUsers().find((u) => u.login === 'steve')!;
    const tva = pc.admin.listVatRates()[0]!.id;
    const article = pc.catalogue.saveArticle(admin.id, { name: 'Riz 5 kg', unit: 'piece', vatRateId: tva, purchasePrice: 3_000, salePrice: 5_000 });
    const r = await syncOnce(pc);
    expect(r.sent).toBeGreaterThan(0);
    const pending = pc.db.prepare('SELECT entity FROM outbox WHERE sent_at IS NULL').pluck().all() as string[];
    expect(pending).toHaveLength(600);
    expect(new Set(pending)).toEqual(new Set(['donnee_future']));
    expect(pc.db.prepare("SELECT sent_at FROM outbox WHERE entity = 'article' AND entity_id = ?").pluck().get(article.id)).not.toBeNull();
    expect(pc.sync.state().lastError).toMatch(/600 opération\(s\) refusée\(s\)/);
  });
});
