import type { INestApplication } from '@nestjs/common';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clientIp } from '../src/clientIp';
import { createApp } from '../src/main';

/** Contre-expertise de l'audit (0.113.0) : mot de passe de l'administration limité, adresse réelle derrière le proxy. */
describe("administration du serveur : essais de mot de passe", () => {
  let app: INestApplication;
  let url: string;
  const login = (password: string, from?: string) =>
    fetch(`${url}/admin/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(from ? { 'x-forwarded-for': from } : {}) },
      body: JSON.stringify({ password }),
    });

  beforeAll(async () => {
    app = await createApp({ dataDir: join(mkdtempSync(join(tmpdir(), 'fedo-serveur-')), 'donnees'), port: 0, enrollmentKey: 'cle', localAdminToken: 'jeton' });
    await app.listen(0, '127.0.0.1');
    url = await app.getUrl();
    const first = await fetch(`${url}/admin/api/first-password`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'secret-gerant' }) });
    expect(first.status).toBe(200);
  });
  afterAll(() => app.close());

  it('bloque une adresse après 10 mots de passe faux, même le bon, sans gêner les autres', async () => {
    for (let i = 0; i < 10; i++) expect((await login('faux', '41.202.1.1')).status).toBe(401);
    const blocked = await login('secret-gerant', '41.202.1.1');
    expect(blocked.status).toBe(429);
    expect((await blocked.json()).message).toMatch(/quart d’heure/);
    // Une autre personne derrière le même proxy se connecte normalement.
    expect((await login('secret-gerant', '41.202.9.9')).status).toBe(200);
  });

  it('un bon mot de passe remet le compte à zéro ; un mot de passe vide ne compte pas', async () => {
    for (let i = 0; i < 9; i++) await login('faux', '41.202.2.2');
    expect((await login('secret-gerant', '41.202.2.2')).status).toBe(200);
    for (let i = 0; i < 20; i++) await login('', '41.202.2.2');
    for (let i = 0; i < 9; i++) await login('faux', '41.202.2.2');
    expect((await login('secret-gerant', '41.202.2.2')).status).toBe(200);
  });

  it('pose un cookie « Secure » derrière HTTPS seulement', async () => {
    const https = await fetch(`${url}/admin/api/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-proto': 'https', 'x-forwarded-for': '41.202.4.4' }, body: JSON.stringify({ password: 'secret-gerant' }) });
    expect(https.headers.get('set-cookie')).toContain('; Secure');
    expect((await login('secret-gerant', '41.202.4.4')).headers.get('set-cookie')).not.toContain('Secure');
  });

  it("une demande passée par le proxy ne compte pas comme faite sur le PC du serveur", async () => {
    const direct = await (await fetch(`${url}/admin/api/session`)).json();
    const proxied = await (await fetch(`${url}/admin/api/session`, { headers: { 'x-forwarded-for': '41.202.3.3' } })).json();
    // Le mot de passe existe déjà : on vérifie seulement que la demande passée par le proxy n'est pas locale.
    expect(direct.canChoose).toBe(true);
    expect(proxied.canChoose).toBe(false);
  });
});

describe("adresse de l'appelant", () => {
  const req = (peer: string, xff?: string | string[]) => ({ socket: { remoteAddress: peer }, headers: xff === undefined ? {} : { 'x-forwarded-for': xff } }) as never;
  it('prend la dernière adresse du proxy local, et ignore l’en-tête venant d’ailleurs', () => {
    expect(clientIp(req('127.0.0.1', '1.1.1.1, 41.202.1.1'))).toBe('41.202.1.1');
    expect(clientIp(req('::ffff:127.0.0.1', ['1.1.1.1', '41.202.1.2']))).toBe('41.202.1.2');
    expect(clientIp(req('192.168.1.20', '41.202.1.1'))).toBe('192.168.1.20');
    expect(clientIp(req('127.0.0.1'))).toBe('127.0.0.1');
  });
});
