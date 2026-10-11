import { beforeEach, describe, expect, it } from 'vitest';
import { type Services, createServices, openDatabase } from '@superette/db';
import { createApi } from '../src/main/api';

let s: Services;
let api: Record<string, (...a: unknown[]) => unknown>;
let riz: string;
let mobile: string;
const printed: string[] = [];

const printer = new Proxy({}, { get: (_t, name) => async (...a: unknown[]) => void printed.push(`${String(name)}:${a.map(String).join(',')}`) }) as never;
const sync = { now: async () => undefined, status: () => null } as never;
const system = { chooseFolder: async () => null, chooseBackupFile: async () => null, openFolder: async () => undefined, restore: () => undefined };
const login = (u: string, p: string) => api['auth.login']!(u, p);

beforeEach(() => {
  printed.length = 0;
  s = createServices(openDatabase(':memory:'));
  const { store, register, admin } = s.admin.bootstrap({ storeCode: 'DLA1', storeName: 'Superette Akwa', adminName: 'Steve', adminLogin: 'steve', adminPin: '1234' });
  mobile = s.admin.createRegister(admin.id, store.id, undefined, 'electronic').id;
  s.admin.createUser(admin.id, { name: 'Mireille', login: 'mireille', pin: '2222', role: 'manager', storeId: store.id });
  s.admin.createUser(admin.id, { name: 'Awa', login: 'awa', pin: '5555', role: 'cashier', storeId: store.id, registerId: register.id, emoneyRegisterId: mobile });
  const tva = s.admin.listVatRates()[0]!.id;
  riz = s.catalogue.saveArticle(admin.id, { name: 'Riz 5 kg', unit: 'piece', vatRateId: tva, purchasePrice: 3_000, salePrice: 5_000 }).id;
  s.stock.receive({ storeId: store.id, registerId: register.id, userId: admin.id }, { warehouseId: s.admin.salesWarehouse(store.id).id, lines: [{ articleId: riz, qty: 50_000, unitCost: 3_000 }] });
  api = createApi(s, printer, sync, 'test', system) as never;
});

describe('caisse électronique du caissier', () => {
  it('s’ouvre avec sa caisse espèces, reçoit le MTN et se clôture à l’aveugle avec son bon', async () => {
    login('awa', '5555');
    expect((api['app.state']!() as { linkedRegisters: { electronic: { name: string } | null } }).linkedRegisters.electronic?.name).toBe('Mobile 1');
    api['treasury.open']!(10_000);
    const state = api['treasury.state']!() as { linked: { id: string; session: unknown }[] };
    expect(state.linked).toHaveLength(1);
    expect(state.linked[0]!.session).not.toBeNull();
    // Un ticket payé moitié espèces, moitié MTN.
    api['pos.sell']!({ lines: [{ articleId: riz, qty: 2_000 }], payments: [{ method: 'CASH', amount: 5_000 }, { method: 'MTN_MOMO', amount: 5_000, reference: 'TX1' }] });
    const r = api['treasury.closeDeclared']!(mobile, { MTN_MOMO: 4_000, ORANGE_MONEY: 0, CARD: 0 }) as { z: unknown; sessionId: string; needsApproval: boolean };
    expect(r.z).toBeNull();
    expect(r.needsApproval).toBe(true);
    // Le caissier imprime son bon, sans l'attendu ; il ne voit pas le rapport de sa caisse espèces.
    await api['treasury.printReport']!(r.sessionId);
    expect(printed).toEqual([`sessionReport:${r.sessionId},true`]);
    const cashSession = s.pos.currentSession(s.admin.getUser(s.admin.listUsers().find((u) => u.login === 'awa')!.id).register_id!)!;
    expect(() => api['treasury.printReport']!(cashSession.id)).toThrow(/droits/);
    // Le gérant voit l'écart et le justifie.
    login('mireille', '2222');
    const z = s.pos.zReport(r.sessionId);
    expect(z.declared).toMatchObject([
      { method: 'MTN_MOMO', label: 'MTN Mobile Money', expected: 5_000, declared: 4_000 },
      { method: 'ORANGE_MONEY', label: 'Orange Money', expected: 0, declared: 0 },
      { method: 'CARD', label: 'Carte bancaire', expected: 0, declared: 0 },
    ]);
    expect(z.difference).toBe(-1_000);
    expect((api['treasury.pendingGaps']!() as { id: string }[]).map((g) => g.id)).toContain(r.sessionId);
  });

  it('refuse la clôture de la caisse électronique d’un autre caissier', () => {
    s.admin.createUser(s.admin.listUsers()[0]!.id, { name: 'Brice', login: 'brice', pin: '6666', role: 'cashier', storeId: s.admin.station()!.store.id });
    login('awa', '5555');
    api['treasury.open']!(10_000);
    login('brice', '6666');
    expect(() => api['treasury.closeDeclared']!(mobile, { MTN_MOMO: 0 })).toThrow(/pas la vôtre/);
  });
});

describe('préférences de l’utilisateur', () => {
  it('garde les onglets rapides et la dernière version vue de chacun', () => {
    login('awa', '5555');
    const tabs = [{ label: 'Ma caisse', open: ['treasury', 'day'] }];
    api['prefs.set']!('quickTabs', tabs);
    api['prefs.set']!('seenVersion', '0.31.0');
    expect((api['app.state']!() as { prefs: Record<string, unknown> }).prefs).toEqual({ quickTabs: tabs, seenVersion: '0.31.0' });
    // Un autre utilisateur garde les siens.
    login('mireille', '2222');
    expect((api['app.state']!() as { prefs: Record<string, unknown> }).prefs).toEqual({});
    login('awa', '5555');
    api['prefs.set']!('quickTabs', null);
    expect((api['app.state']!() as { prefs: Record<string, unknown> }).prefs).toEqual({ seenVersion: '0.31.0' });
    expect(() => api['prefs.set']!('1 mauvaise clé', true)).toThrow(/Préférence/);
  });
});
