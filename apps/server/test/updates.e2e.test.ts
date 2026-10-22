import type { INestApplication } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/main';

const LOCAL = 'jeton-de-la-fenetre-du-serveur';

/** Faux installateur Windows : commence par « MZ », plus d'un Mo. */
const installer = (fill: number) => {
  const b = Buffer.alloc(1_200_000, fill);
  b.write('MZ', 0, 'latin1');
  return b;
};

describe('mises à jour des PC par le serveur central', () => {
  let app: INestApplication;
  let url: string;
  let cookie = '';
  let updatesDir: string;
  const upload = (name: string, body: Buffer, c = cookie) =>
    fetch(`${url}/admin/api/updates?name=${encodeURIComponent(name)}`, {
      method: 'POST',
      headers: { cookie: c, 'content-type': 'application/octet-stream' },
      body: new Uint8Array(body),
    });

  beforeAll(async () => {
    const root = mkdtempSync(join(tmpdir(), 'fedo-maj-'));
    updatesDir = join(root, 'mises-a-jour');
    app = await createApp({ dataDir: join(root, 'donnees'), updatesDir, port: 0, enrollmentKey: 'cle-enrolement-de-test', localAdminToken: LOCAL });
    await app.listen(0, '127.0.0.1');
    url = await app.getUrl();
    const res = await fetch(`${url}/?t=${LOCAL}`, { redirect: 'manual' });
    cookie = res.headers.get('set-cookie')!.split(';')[0]!;
  });

  afterAll(async () => {
    await app?.close();
  });

  it('refuse un dépôt sans être connecté, un mauvais nom ou un fichier qui n’est pas un installateur', async () => {
    expect((await upload('Onix360-Setup-0.49.0.exe', installer(1), '')).status).toBe(401);
    expect((await upload('photo.png', installer(1))).status).toBe(400);
    expect((await upload('Onix360-Setup-0.49.0.exe', Buffer.alloc(2_000_000, 7))).status).toBe(400);
    expect((await fetch(`${url}/mises-a-jour/latest.yml`)).status).toBe(404);
    expect(existsSync(join(updatesDir, 'Onix360-Setup-0.49.0.exe'))).toBe(false);
  });

  it('écrit latest.yml avec la version, l’empreinte et la taille, et sert les fichiers aux PC', async () => {
    const exe = installer(1);
    const res = await upload('Onix360-Setup-0.49.0.exe', exe);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ version: '0.49.0', file: 'Onix360-Setup-0.49.0.exe', size: exe.length });

    const yml = await (await fetch(`${url}/mises-a-jour/latest.yml`)).text();
    const sha512 = createHash('sha512').update(exe).digest('base64');
    expect(yml).toContain('version: 0.49.0');
    expect(yml).toContain('path: Onix360-Setup-0.49.0.exe');
    expect(yml).toContain(`sha512: ${sha512}`);
    expect(yml).toContain(`size: ${exe.length}`);

    const got = Buffer.from(await (await fetch(`${url}/mises-a-jour/Onix360-Setup-0.49.0.exe`)).arrayBuffer());
    expect(got.equals(exe)).toBe(true);
    // Rien d'autre que latest.yml et les installateurs n'est servi.
    expect((await fetch(`${url}/mises-a-jour/..%2Fdonnees`)).status).toBe(404);

    const state = await (await fetch(`${url}/admin/api/updates`, { headers: { cookie } })).json();
    expect(state.current).toMatchObject({ version: '0.49.0', file: 'Onix360-Setup-0.49.0.exe' });
  });

  it('garde la version publiée et la précédente seulement', async () => {
    expect((await upload('Onix360-Setup-0.50.0.exe', installer(2))).status).toBe(200);
    expect((await upload('Onix360-Setup-0.51.0.exe', installer(3))).status).toBe(200);
    expect(existsSync(join(updatesDir, 'Onix360-Setup-0.49.0.exe'))).toBe(false);
    expect(existsSync(join(updatesDir, 'Onix360-Setup-0.50.0.exe'))).toBe(true);
    expect(await (await fetch(`${url}/mises-a-jour/latest.yml`)).text()).toContain('version: 0.51.0');
  });
});
