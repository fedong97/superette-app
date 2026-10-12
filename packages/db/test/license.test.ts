import { generateKeyPairSync, sign } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { createServices, LicenseService, type LicensePayload, LICENSE_PUBLIC_KEY, machineCodeFrom, openDatabase, parseLicenseKey } from '../src';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const PUB = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const HERE = machineCodeFrom('pc-de-la-caisse');
const ELSEWHERE = machineCodeFrom('autre-pc');

/** Clé signée comme le fait le générateur de l'éditeur. */
function makeKey(patch: Partial<LicensePayload> = {}): string {
  const payload: LicensePayload = {
    v: 1,
    id: 'L-1',
    client: 'Superette Akwa',
    machine: HERE,
    plan: 'annual',
    start: '2026-10-01',
    expires: '2027-09-30',
    stations: 2,
    stores: 1,
    issued: '2026-10-01T08:00:00.000Z',
    contact: 'Steve 677000000',
    ...patch,
  };
  const data = Buffer.from(JSON.stringify(payload));
  return `SG1.${data.toString('base64url')}.${sign(null, data, privateKey).toString('base64url')}`;
}

let admin: string;
let now: Date;
let connected: boolean;
let lic: LicenseService;
const at = (d: string) => (now = new Date(`${d}T10:00:00`));

beforeEach(() => {
  at('2026-10-12');
  const s = createServices(openDatabase(':memory:'), () => now);
  admin = s.admin.bootstrap({ storeCode: 'DLA1', storeName: 'Superette Akwa', adminName: 'Steve', adminLogin: 'steve', adminPin: '1234' }).admin.id;
  connected = false;
  lic = new LicenseService(s.db, () => now, () => connected, () => 'pc-de-la-caisse', PUB);
});

describe('licence', () => {
  it('donne un code machine lisible et stable', () => {
    expect(HERE).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    expect(machineCodeFrom('pc-de-la-caisse')).toBe(HERE);
    expect(ELSEWHERE).not.toBe(HERE);
    expect(lic.machineCode()).toBe(HERE);
  });

  it('laisse 15 jours d’essai puis bloque la vente', () => {
    expect(lic.status()).toMatchObject({ state: 'trial', canSell: true, daysLeft: 15 });
    at('2026-10-26');
    expect(lic.status()).toMatchObject({ state: 'trial', daysLeft: 1 });
    at('2026-10-27');
    expect(lic.status()).toMatchObject({ state: 'trial_over', canSell: false });
    expect(() => lic.assertCanSell()).toThrow(/essai est terminée/);
  });

  it('active une licence annuelle, avertit avant la fin, laisse 15 jours de grâce puis bloque', () => {
    const st = lic.activate(admin, makeKey());
    expect(st).toMatchObject({ state: 'valid', canSell: true, warn: false });
    expect(st.message).toContain('30/09/2027');

    at('2027-09-20');
    expect(lic.status()).toMatchObject({ state: 'valid', warn: true, daysLeft: 11 });
    at('2027-10-01');
    expect(lic.status()).toMatchObject({ state: 'grace', canSell: true, daysLeft: 15 });
    expect(lic.status().message).toContain('Steve 677000000');
    at('2027-10-15');
    expect(lic.status()).toMatchObject({ state: 'grace', daysLeft: 1 });
    at('2027-10-16');
    expect(lic.status()).toMatchObject({ state: 'expired', canSell: false });
    expect(() => lic.assertCanSell()).toThrow(/ne vend plus/);
  });

  it('une licence à vie ne finit jamais', () => {
    lic.activate(admin, makeKey({ plan: 'lifetime', expires: null }));
    at('2040-01-01');
    expect(lic.status()).toMatchObject({ state: 'valid', canSell: true, warn: false, daysLeft: null });
  });

  it('refuse une licence d’un autre PC, expirée, modifiée ou signée par une autre clé', () => {
    expect(() => lic.activate(admin, makeKey({ machine: ELSEWHERE }))).toThrow(/autre PC/);
    expect(() => lic.activate(admin, makeKey({ start: '2025-01-01', expires: '2025-12-31' }))).toThrow(/expiré/);
    const [, p, s] = makeKey().split('.');
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p!, 'base64url').toString()), plan: 'lifetime', expires: null })).toString('base64url');
    expect(() => lic.activate(admin, `SG1.${forged}.${s}`)).toThrow(/incorrecte/);
    // Vraie clé de l'éditeur dans le logiciel : une clé de test n'y passe pas.
    expect(() => parseLicenseKey(makeKey(), LICENSE_PUBLIC_KEY)).toThrow(/incorrecte/);
    expect(() => lic.activate(admin, 'bonjour')).toThrow(/pas une clé/);
  });

  it('accepte une clé coupée en plusieurs lignes', () => {
    const key = makeKey();
    expect(lic.activate(admin, `${key.slice(0, 40)}\n${key.slice(40, 90)} \n${key.slice(90)}`).state).toBe('valid');
  });

  it('bloque quand la date du PC est reculée', () => {
    lic.activate(admin, makeKey());
    at('2026-12-01');
    expect(lic.status().state).toBe('valid');
    at('2026-11-01');
    expect(lic.status()).toMatchObject({ state: 'clock', canSell: false });
    at('2026-12-01');
    expect(lic.status().state).toBe('valid');
  });

  it('un PC relié au serveur reçoit la licence activée sur un autre PC', () => {
    expect(lic.acceptFromServer(makeKey({ machine: ELSEWHERE }))).toBe(true);
    expect(lic.status()).toMatchObject({ state: 'other_machine', canSell: false });
    connected = true;
    expect(lic.status()).toMatchObject({ state: 'valid', canSell: true });
    // Une licence plus ancienne ne remplace pas la récente ; un renouvellement oui.
    expect(lic.acceptFromServer(makeKey({ machine: ELSEWHERE, issued: '2026-09-01T00:00:00.000Z' }))).toBe(false);
    expect(lic.acceptFromServer(makeKey({ id: 'L-2', machine: ELSEWHERE, expires: '2028-09-30', issued: '2027-09-25T00:00:00.000Z' }))).toBe(true);
    expect(lic.current()?.expires).toBe('2028-09-30');
    expect(lic.acceptFromServer('pas une licence')).toBe(false);
  });

  it('envoie une fois au serveur la licence activée ici', () => {
    const key = makeKey();
    lic.activate(admin, key);
    expect(lic.pendingUpload()).toBe(key);
    lic.markUploaded(key);
    expect(lic.pendingUpload()).toBeNull();
  });

  it('limite le nombre de magasins', () => {
    expect(() => lic.assertCanAddStore(5)).not.toThrow();
    lic.activate(admin, makeKey({ stores: 2 }));
    expect(() => lic.assertCanAddStore(1)).not.toThrow();
    expect(() => lic.assertCanAddStore(2)).toThrow(/2 magasins/);
  });
});
