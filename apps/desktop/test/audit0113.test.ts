import { beforeEach, describe, expect, it } from 'vitest';
import { type Services, createServices, openDatabase } from '@superette/db';
import { createApi } from '../src/main/api';

/** Contre-expertise de l'audit (0.113.0) : double validation à la caisse, code du gérant, accueil du caissier. */
let s: Services;
let api: Record<string, (...a: unknown[]) => unknown>;
let riz: string;

const printer = new Proxy({}, { get: () => async () => undefined }) as never;
const sync = { now: async () => undefined, status: () => null } as never;
const system = { chooseFolder: async () => null, chooseBackupFile: async () => null, openFolder: async () => undefined, restore: () => undefined };

const login = (u: string, p: string) => api['auth.login']!(u, p);
const sell = (requestId?: string) =>
  api['pos.sell']!({ lines: [{ articleId: riz, qty: 2_000 }], payments: [{ method: 'CASH', amount: 10_000 }], requestId }) as { id: string; number: string };
const count = (sql: string, ...params: unknown[]) => s.db.prepare(sql).pluck().get(...params) as number;

beforeEach(() => {
  s = createServices(openDatabase(':memory:'));
  const { store, register, admin } = s.admin.bootstrap({ storeCode: 'DLA1', storeName: 'Superette Akwa', adminName: 'Steve', adminLogin: 'steve', adminPin: '1234' });
  s.admin.createUser(admin.id, { name: 'Mireille', login: 'mireille', pin: '2222', role: 'manager', storeId: store.id });
  s.admin.createUser(admin.id, { name: 'Awa', login: 'awa', pin: '5555', role: 'cashier', storeId: store.id, registerId: register.id });
  const tva = s.admin.listVatRates()[0]!.id;
  riz = s.catalogue.saveArticle(admin.id, { name: 'Riz 5 kg', unit: 'piece', vatRateId: tva, purchasePrice: 3_000, salePrice: 5_000 }).id;
  s.stock.receive({ storeId: store.id, registerId: register.id, userId: admin.id }, { warehouseId: s.admin.salesWarehouse(store.id).id, lines: [{ articleId: riz, qty: 50_000, unitCost: 3_000 }] });
  api = createApi(s, printer, sync, 'test', system) as never;
  login('awa', '5555');
  api['treasury.open']!(10_000, '2222');
});

describe('une seule vente par validation', () => {
  it('la même validation reçue deux fois (F4 appuyé deux fois) rend la vente déjà faite', () => {
    const first = sell('validation-1');
    const again = sell('validation-1');
    expect(again.id).toBe(first.id);
    expect(count('SELECT COUNT(*) FROM sales')).toBe(1);
    expect(count("SELECT COUNT(*) FROM stock_movements WHERE type = 'SALE'")).toBe(1);
    expect(count("SELECT COUNT(*) FROM outbox WHERE entity = 'sale' AND entity_id = ?", first.id)).toBe(1);
  });

  it('deux fiches différentes font deux ventes, avec ou sans identifiant', () => {
    expect(sell('validation-1').id).not.toBe(sell('validation-2').id);
    sell();
    sell();
    expect(count('SELECT COUNT(*) FROM sales')).toBe(4);
  });

  it("l'identifiant d'un autre utilisateur ne rend pas sa vente", () => {
    const awa = sell('validation-1');
    api['auth.logout']!();
    login('mireille', '2222');
    api['pos.chooseRegister']!(s.pos.getSale(awa.id).register_id);
    expect(sell('validation-1').id).not.toBe(awa.id);
  });
});

describe('code du gérant à la caisse', () => {
  it('bloqué sur le PC après 4 codes faux, même le bon ; le blocage est au journal', () => {
    for (let i = 0; i < 3; i++) expect(() => s.admin.authorizeSupervisor('9999')).toThrow('Code superviseur refusé');
    expect(() => s.admin.authorizeSupervisor('9999')).toThrow(/pendant 15 minutes/);
    expect(() => s.admin.authorizeSupervisor('2222')).toThrow(/codes refusés encore/);
    const actions = s.admin.auditLog(50).map((r) => r.action);
    expect(actions).toContain('supervisor.locked');
    expect(actions.filter((a) => a === 'supervisor.failed')).toHaveLength(4);
  });

  it('un bon code remet le compte à zéro ; un code vide ne compte pas', () => {
    for (let i = 0; i < 3; i++) expect(() => s.admin.authorizeSupervisor('9999')).toThrow();
    expect(s.admin.authorizeSupervisor('2222').name).toBe('Mireille');
    for (let i = 0; i < 20; i++) expect(() => s.admin.authorizeSupervisor('')).toThrow('Code superviseur refusé');
    for (let i = 0; i < 3; i++) expect(() => s.admin.authorizeSupervisor('9999')).toThrow('Code superviseur refusé');
    expect(s.admin.authorizeSupervisor('2222').name).toBe('Mireille');
  });

  it('suit le réglage « Blocage après des codes faux » quand il est donné', () => {
    const storeId = s.admin.station()!.store.id;
    s.admin.saveStoreSettings(s.pos.getSale(sell().id).user_id, storeId, { maxLoginAttempts: 6 });
    for (let i = 0; i < 5; i++) expect(() => s.admin.authorizeSupervisor('9999')).toThrow('Code superviseur refusé');
    expect(() => s.admin.authorizeSupervisor('9999')).toThrow(/pendant 15 minutes/);
  });
});

describe('accueil du caissier sans les montants de la caisse', () => {
  it("ne montre ni l'attendu du tiroir ni le chiffre de sa caisse", async () => {
    sell();
    const home = (await api['home.overview']!()) as { mine: { expected: number | null; net: number } | null };
    expect(home.mine).not.toBeNull();
    expect(home.mine!.expected).toBeNull();
    expect(home.mine!.net).toBe(0);
  });
});

describe('lectures réservées aux écrans qui les montrent', () => {
  const forbidden = (fn: () => unknown) => expect(fn).toThrow("Vous n'avez pas les droits");

  it('un caissier ne lit pas les achats ; il garde la recherche des clients et leurs soldes', () => {
    forbidden(() => api['purchases.orders']!());
    forbidden(() => api['purchases.receptions']!());
    forbidden(() => api['purchases.order']!('x'));
    forbidden(() => api['purchases.reception']!('x'));
    expect(api['customers.list']!({ search: 'x' })).toEqual([]);
    expect(api['customers.list']!({ withBalance: true })).toEqual([]);
    expect(api['customers.payments']!({ limit: 5 })).toEqual([]);
  });

  it('un magasinier lit les achats mais pas l’argent des clients', () => {
    const storeId = s.admin.station()!.store.id;
    s.admin.createUser(s.admin.listUsers().find((u) => u.login === 'steve')!.id, { name: 'Jo', login: 'jo', pin: '7777', role: 'stock', storeId });
    api['auth.logout']!();
    login('jo', '7777');
    expect(api['purchases.orders']!()).toEqual([]);
    expect(api['purchases.receptions']!()).toEqual(expect.any(Array));
    forbidden(() => api['customers.payments']!({ limit: 5 }));
    forbidden(() => api['customers.list']!({ withBalance: true }));
    forbidden(() => api['customers.receiptHtml']!('x'));
  });
});
