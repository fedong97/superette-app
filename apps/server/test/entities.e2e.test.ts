import type { INestApplication } from '@nestjs/common';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { type Services, createServices, enrollStation, openDatabase, syncOnce } from '@superette/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/main';
import { KNOWN_ENTITIES } from '../src/sync.service';

const KEY = 'cle-enrolement-de-test';

describe('données envoyées par les PC au serveur central', () => {
  it('le serveur accepte toutes les données que les PC envoient', () => {
    const dir = join(__dirname, '../../../packages/db/src');
    const sent = new Set<string>();
    for (const f of readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
      for (const m of readFileSync(join(dir, f), 'utf8').matchAll(/enqueue\([^;']*?, '([a-z_]+)', /g)) if (m[1] !== 'upsert' && m[1] !== 'delete') sent.add(m[1]!);
    }
    for (const t of createServices(openDatabase(':memory:')).sync.resendTargets('magasin')) sent.add(t.entity);
    expect(sent).toContain('attendance');
    expect([...sent].filter((e) => !KNOWN_ENTITIES.has(e))).toEqual([]);
  });

  describe('une opération refusée ne bloque pas les autres', () => {
    let app: INestApplication;
    let pc: Services;
    let userId: string;
    let storeId: string;

    beforeAll(async () => {
      app = await createApp({ dataDir: join(mkdtempSync(join(tmpdir(), 'fedo-serveur-')), 'donnees'), port: 0, enrollmentKey: KEY, localAdminToken: 'jeton' });
      await app.listen(0, '127.0.0.1');
      pc = createServices(openDatabase(':memory:'));
      const { store, admin } = pc.admin.bootstrap({ storeCode: 'DLA1', storeName: 'Superette Akwa', adminName: 'Steve', adminLogin: 'steve', adminPin: '1234' });
      userId = admin.id;
      storeId = store.id;
      await enrollStation(pc, await app.getUrl(), KEY, 'PC 1');
    });

    afterAll(async () => {
      await app.close();
    });

    it('le pointage du personnel part au serveur', async () => {
      pc.attendance.arrive(userId, storeId);
      await syncOnce(pc);
      expect(pc.sync.state()).toMatchObject({ pending: 0, lastError: null });
    });

    it("une donnée qu'un serveur plus ancien ne connaît pas reste en attente, la suite part", async () => {
      // Donnée d'une version plus récente de l'application, inconnue de ce serveur.
      pc.db
        .prepare("INSERT INTO outbox (id, entity, entity_id, op, payload, store_id, created_at) VALUES (?, 'nouveaute', 'x', 'delete', '{}', ?, ?)")
        .run(randomUUID(), storeId, new Date().toISOString());
      pc.attendance.leave(userId, storeId);
      await syncOnce(pc);
      const state = pc.sync.state();
      expect(state.pending).toBe(1);
      expect(state.lastError).toMatch(/mettez à jour le serveur central/);
      expect(state.lastSyncAt).not.toBeNull();
      expect(pc.db.prepare('SELECT entity FROM outbox WHERE sent_at IS NULL').pluck().all()).toEqual(['nouveaute']);
    });
  });
});
