import { beforeEach, describe, expect, it } from 'vitest';
import { type Services, createServices, openDatabase } from '@superette/db';
import { createApi } from '../src/main/api';

let s: Services;
let api: Record<string, (...a: unknown[]) => unknown>;
const sealed: string[] = [];

const printer = new Proxy({}, { get: () => async () => undefined }) as never;
const sync = { now: async () => undefined } as never;
const system = {
  chooseFolder: async () => null,
  chooseBackupFile: async () => null,
  openFolder: async () => undefined,
  restore: () => undefined,
  digest: { seal: (p: string) => (sealed.push(p), `chiffré:${p.length}`), sendNow: async () => 'Résumé envoyé' },
};
const config = { enabled: true, hour: '21:00', emails: 'gerant@gmail.com', whatsapp: '237677000000', smtpHost: 'smtp.gmail.com', smtpPort: 465, smtpUser: 'magasin@gmail.com' };

beforeEach(() => {
  sealed.length = 0;
  s = createServices(openDatabase(':memory:'), () => new Date('2026-10-12T10:00:00'));
  const { store, register, admin } = s.admin.bootstrap({ storeCode: 'DLA1', storeName: 'Superette Akwa', adminName: 'Steve', adminLogin: 'steve', adminPin: '1234' });
  s.admin.createUser(admin.id, { name: 'Awa', login: 'awa', pin: '5555', role: 'cashier', storeId: store.id, registerId: register.id });
  api = createApi(s, printer, sync, 'test', system) as never;
});

describe('résumé du jour dans l’application', () => {
  it("seul l'administrateur règle l'envoi ; le mot de passe est chiffré par Windows", async () => {
    api['auth.login']!('awa', '5555');
    expect(() => api['digest.config']!()).toThrow();
    expect(() => api['digest.saveConfig']!(config, 'secret')).toThrow();

    api['auth.login']!('steve', '1234');
    expect(api['digest.preview']!()).toMatchObject({ storeName: 'Superette Akwa', date: '2026-10-12', tickets: 0 });
    expect(api['digest.saveConfig']!(config, 'secret')).toMatchObject({ enabled: true, hasPassword: true });
    expect(sealed).toEqual(['secret']);
    expect(s.digest.sealedPassword()).toBe('chiffré:6');
    expect(JSON.stringify(s.admin.getSetting('digest.config'))).not.toContain('secret');
    api['digest.saveConfig']!(config, null);
    expect(s.digest.sealedPassword()).toBe('chiffré:6');
    await expect(api['digest.sendNow']!()).resolves.toBe('Résumé envoyé');
  });
});
