import type { INestApplication } from '@nestjs/common';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServices, enrollStation, openDatabase, pushAppErrors } from '@superette/db';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/main';

const KEY = 'cle-enrolement-de-test';

/** 0.116.0 : les plantages notés sur un PC arrivent au serveur, sans données saisies. */
describe('erreurs des PC envoyées au serveur', () => {
  let app: INestApplication;
  afterAll(() => app?.close());

  it('reçoit les erreurs, les regroupe et les montre à l’administration', async () => {
    app = await createApp({ dataDir: join(mkdtempSync(join(tmpdir(), 'fedo-serveur-')), 'donnees'), port: 0, enrollmentKey: KEY, localAdminToken: 'jeton' });
    await app.listen(0, '127.0.0.1');
    const url = await app.getUrl();
    const pc = createServices(openDatabase(':memory:'));
    pc.admin.bootstrap({ storeCode: 'DLA1', storeName: 'Superette Akwa', adminName: 'Steve', adminLogin: 'steve', adminPin: '1234' });
    await enrollStation(pc, url, KEY, 'PC caisse 1');
    const boom = new TypeError("Cannot read properties of undefined (reading 'qty')");
    pc.appErrors.record({ source: 'action', message: boom.message, stack: boom.stack, where: 'pos.completeSale', version: '0.116.0' });
    pc.appErrors.record({ source: 'action', message: boom.message, stack: boom.stack, where: 'pos.completeSale', version: '0.116.0' });
    expect(await pushAppErrors(pc)).toBe(1);
    expect(await pushAppErrors(pc)).toBe(0);
    pc.appErrors.record({ source: 'action', message: boom.message, stack: boom.stack, where: 'pos.completeSale', version: '0.116.0' });
    expect(await pushAppErrors(pc)).toBe(1);

    const login = await fetch(`${url}/admin/api/first-password`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'secret-gerant' }) });
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    const list = (await (await fetch(`${url}/admin/api/errors`, { headers: { cookie } })).json()) as { device: string; count: number; where: string; message: string }[];
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ device: 'PC caisse 1', count: 3, where: 'pos.completeSale' });

    const bad = await fetch(`${url}/api/v1/devices/errors`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ errors: [] }) });
    expect(bad.status).toBe(401);
  });
});
