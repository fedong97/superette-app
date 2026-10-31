import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { type Services, createServices, openDatabase } from '@superette/db';
import { createApi, remotePcRunners } from '../src/main/api';
import { REMOTE_BLOCKED } from '../src/main/remoteBlocked';
// @ts-expect-error script JavaScript sans types
import { computeBlocked, render } from '../scripts/remote-blocked.mjs';

let s: Services;
let api: Record<string, (...a: unknown[]) => unknown>;
let run: (c: { id: string; userId: string; name: string; args: unknown[] }) => Promise<{ ok: boolean; data?: unknown; error?: { message: string; code: string } }>;
let managerId: string;
let cashierId: string;

const printer = new Proxy({}, { get: () => async () => undefined }) as never;
const sync = { now: async () => undefined, status: () => null } as never;
const system = { chooseFolder: async () => null, chooseBackupFile: async () => null, openFolder: async () => undefined, restore: () => undefined };

beforeEach(() => {
  s = createServices(openDatabase(':memory:'));
  const { store, register, admin } = s.admin.bootstrap({ storeCode: 'DLA1', storeName: 'Superette Akwa', adminName: 'Steve', adminLogin: 'steve', adminPin: '1234' });
  managerId = s.admin.createUser(admin.id, { name: 'Mireille', login: 'mireille', pin: '2222', role: 'manager', storeId: store.id }).id;
  cashierId = s.admin.createUser(admin.id, { name: 'Awa', login: 'awa', pin: '5555', role: 'cashier', storeId: store.id, registerId: register.id }).id;
  api = createApi(s, printer, sync, 'test', system) as never;
  run = remotePcRunners.get(api)! as never;
});

const call = (userId: string, name: string, ...args: unknown[]) => run({ id: 'x', userId, name, args });

describe('le PC sur le téléphone du gérant', () => {
  it('exécute au nom du gérant sans toucher à la caissière connectée devant le PC', async () => {
    api['auth.login']!('awa', '5555');
    const r = await call(managerId, 'customers.save', { name: 'JEAN DUPONT' });
    expect(r.ok).toBe(true);
    expect((r.data as { name: string }).name).toBe('JEAN DUPONT');
    // La caissière reste connectée, avec ses droits à elle.
    expect((api['app.state']!() as { user: { id: string } }).user.id).toBe(cashierId);
    // Et l'état vu du téléphone est celui du gérant.
    const st = await call(managerId, 'app.state');
    expect((st.data as { user: { id: string } }).user.id).toBe(managerId);
  });

  it('garde les droits de la personne : une caissière ne crée pas de caisse depuis le téléphone', async () => {
    const r = await call(cashierId, 'admin.createUser', { name: 'X', login: 'x', pin: '9999', role: 'cashier', storeId: null });
    expect(r.ok).toBe(false);
  });

  it("refuse les actions propres au poste et ne connecte personne sur le PC", async () => {
    expect((await call(managerId, 'auth.login', 'steve', '1234')).error?.code).toBe('PC_ONLY');
    expect((await call(managerId, 'backup.now')).error?.code).toBe('PC_ONLY');
    expect((api['app.state']!() as { user: unknown }).user).toBeNull();
    expect((await call('inconnu', 'app.state')).error?.code).toBe('NOT_LOGGED_IN');
  });

  it('la liste des actions réservées au PC est à jour', () => {
    expect(render(computeBlocked())).toBe(readFileSync(join(__dirname, '../src/main/remoteBlocked.ts'), 'utf8'));
    expect(REMOTE_BLOCKED.has('customers.save')).toBe(false);
    expect(REMOTE_BLOCKED.has('auth.login')).toBe(true);
  });
});
