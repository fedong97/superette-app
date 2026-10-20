import { beforeEach, describe, expect, it } from 'vitest';
import { type Services, createServices, openDatabase } from '@superette/db';
import { createApi } from '../src/main/api';

let s: Services;
let api: Record<string, (...a: unknown[]) => unknown>;
let riz: string;
let shop: string;
let reserve: string;
let awaId: string;
let jeanId: string;

const printer = new Proxy({}, { get: () => async () => undefined }) as never;
const sync = { now: async () => undefined, status: () => null } as never;
const system = { chooseFolder: async () => null, chooseBackupFile: async () => null, openFolder: async () => undefined, restore: () => undefined };

beforeEach(() => {
  s = createServices(openDatabase(':memory:'));
  const { store, register, admin } = s.admin.bootstrap({ storeCode: 'DLA1', storeName: 'Superette Akwa', adminName: 'Steve', adminLogin: 'steve', adminPin: '1234' });
  s.admin.createUser(admin.id, { name: 'Mireille', login: 'mireille', pin: '2222', role: 'manager', storeId: store.id });
  jeanId = s.admin.createUser(admin.id, { name: 'Jean', login: 'jean', pin: '4444', role: 'stock', storeId: store.id }).id;
  awaId = s.admin.createUser(admin.id, { name: 'Awa', login: 'awa', pin: '5555', role: 'cashier', storeId: store.id, registerId: register.id }).id;
  const tva = s.admin.listVatRates()[0]!.id;
  riz = s.catalogue.saveArticle(admin.id, { name: 'Riz 5 kg', unit: 'piece', vatRateId: tva, purchasePrice: 3_000, salePrice: 5_000 }).id;
  shop = s.admin.salesWarehouse(store.id).id;
  reserve = s.admin.createWarehouse(store.id, 'Réserve 2', 'reserve').id;
  const ctx = { storeId: store.id, registerId: register.id, userId: admin.id };
  s.stock.receive(ctx, { warehouseId: shop, lines: [{ articleId: riz, qty: 10_000, unitCost: 3_000 }] });
  s.stock.receive(ctx, { warehouseId: reserve, lines: [{ articleId: riz, qty: 10_000, unitCost: 3_000 }] });
  api = createApi(s, printer, sync, 'test', system) as never;
});

const loss = () => api['stock.loss']!({ warehouseId: shop, articleId: riz, qty: 1_000, type: 'BREAKAGE', reason: 'Sac percé' });

describe('privilèges par utilisateur', () => {
  it("donnent un droit à une seule caissière et en retirent un autre, sans toucher à son rôle", () => {
    api['auth.login']!('awa', '5555');
    expect(loss).toThrow(/droits/);
    expect(() => api['admin.savePrivileges']!(awaId, { grants: ['stock_loss'], revokes: [] })).toThrow();

    api['auth.login']!('steve', '1234');
    api['admin.savePrivileges']!(awaId, { grants: ['stock_loss'], revokes: ['sale_hold'] });
    expect(api['admin.holders']!('stock_loss')).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'Awa' })]));

    api['auth.login']!('awa', '5555');
    expect((api['app.state']!() as { user: { rights: string[] } }).user.rights).toContain('stock_loss');
    loss();
    expect(() => api['pos.hold']!('Table 2', [{ articleId: riz, qty: 1_000 }])).toThrow(/droits/);
  });

  it('seul un administrateur crée un administrateur', () => {
    api['auth.login']!('mireille', '2222');
    s.admin.saveRights(s.admin.listUsers().find((u) => u.role === 'admin')!.id, 'manager', [...s.admin.rights('manager'), 'users_manage']);
    expect(() => api['admin.createUser']!({ name: 'X', login: 'x', pin: '9999', role: 'admin', storeId: null })).toThrow(/Seul l'administrateur/);
    expect(api['admin.createUser']!({ name: 'Paul', login: 'paul', pin: '9999', role: 'cashier', storeId: null })).toMatchObject({ role: 'cashier' });
  });

  it('les droits fins de la fiche client : le caissier ne fixe ni plafond ni tarif', () => {
    api['auth.login']!('steve', '1234');
    api['admin.saveStoreSettings']!({ creditDefaultLimit: 20_000, creditDefaultDays: 10 });
    api['auth.login']!('awa', '5555');
    // Sans plafond donné, le nouveau client prend celui des paramètres.
    const c = api['customers.save']!({ name: 'Chez Mballa' }) as { id: string; credit_limit: number; payment_terms_days: number };
    expect(c).toMatchObject({ credit_limit: 20_000, payment_terms_days: 10 });
    expect(() => api['customers.save']!({ name: 'Chez Mballa', creditLimit: 50_000 }, c.id)).toThrow(/plafond/);
    expect(() => api['customers.save']!({ name: 'Chez Mballa', priceLevel: 'wholesale' }, c.id)).toThrow(/tarif/);
    expect(() => api['customers.save']!({ name: 'Chez Mballa', active: false }, c.id)).toThrow(/désactiver/);
  });
});

describe('paramètres appliqués par les écrans', () => {
  it('limite les factures en attente et le délai d’annulation', () => {
    api['auth.login']!('steve', '1234');
    api['admin.saveStoreSettings']!({ maxHeld: 1, cancelMinutes: 30 });
    api['treasury.open']!(0);
    api['pos.hold']!('Table 1', [{ articleId: riz, qty: 1_000 }]);
    expect(() => api['pos.hold']!('Table 2', [{ articleId: riz, qty: 1_000 }])).toThrow(/Déjà 1 facture/);

    const sale = api['pos.sell']!({ lines: [{ articleId: riz, qty: 1_000 }], payments: [{ method: 'CASH', amount: 5_000 }] }) as { id: string };
    s.db.prepare("UPDATE sales SET created_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(sale.id);
    expect(() => api['pos.cancel']!(sale.id, '1234', 'Erreur')).toThrow(/30 minutes/);
  });

  it('un autre utilisateur réceptionne le transfert quand le paramètre le demande', () => {
    api['auth.login']!('steve', '1234');
    api['admin.saveStoreSettings']!({ transferTwoUsers: true });
    api['auth.login']!('jean', '4444');
    const t = api['transfers.create']!({ fromWarehouseId: reserve, toWarehouseId: shop, lines: [{ articleId: riz, qty: 2_000 }] }) as { id: string };
    api['transfers.ship']!(t.id, null);
    expect(() => api['transfers.receive']!(t.id, {})).toThrow(/autre utilisateur/);
    api['auth.login']!('mireille', '2222');
    expect(api['transfers.receive']!(t.id, {})).toMatchObject({ status: 'received' });
    expect(jeanId).toBeTruthy();
  });
});
