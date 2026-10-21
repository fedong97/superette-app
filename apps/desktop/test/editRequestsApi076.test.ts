import { beforeEach, describe, expect, it } from 'vitest';
import { type Services, createServices, openDatabase } from '@superette/db';
import { createApi } from '../src/main/api';

let s: Services;
let api: Record<string, (...a: unknown[]) => unknown>;
let riz: string;
let awaId: string;

const printer = new Proxy({}, { get: () => async () => undefined }) as never;
const sync = { now: async () => undefined, status: () => null } as never;
const system = { chooseFolder: async () => null, chooseBackupFile: async () => null, openFolder: async () => undefined, restore: () => undefined };

beforeEach(() => {
  s = createServices(openDatabase(':memory:'));
  const { store, register, admin } = s.admin.bootstrap({ storeCode: 'DLA1', storeName: 'Superette Akwa', adminName: 'Steve', adminLogin: 'steve', adminPin: '1234' });
  s.admin.createUser(admin.id, { name: 'Mireille', login: 'mireille', pin: '2222', role: 'manager', storeId: store.id });
  awaId = s.admin.createUser(admin.id, { name: 'Awa', login: 'awa', pin: '5555', role: 'cashier', storeId: store.id, registerId: register.id }).id;
  const tva = s.admin.listVatRates()[0]!.id;
  riz = s.catalogue.saveArticle(admin.id, { name: 'Riz 5 kg', unit: 'piece', vatRateId: tva, purchasePrice: 3_000, salePrice: 5_000 }).id;
  s.stock.receive({ storeId: store.id, registerId: register.id, userId: admin.id }, { warehouseId: s.admin.salesWarehouse(store.id).id, lines: [{ articleId: riz, qty: 50_000, unitCost: 3_000 }] });
  api = createApi(s, printer, sync, 'test', system) as never;
  // Awa ne modifie pas une facture elle-même : elle doit le demander.
  api['auth.login']!('steve', '1234');
  api['admin.savePrivileges']!(awaId, { grants: [], revokes: ['sale_edit'] });
});

describe('demande de modification de facture par l’API', () => {
  it('le caissier demande, le gérant accorde, la modification ne sert qu’une fois', () => {
    api['auth.login']!('awa', '5555');
    api['treasury.open']!(10_000, '2222');
    const sale = api['pos.sell']!({ lines: [{ articleId: riz, qty: 2_000 }], payments: [{ method: 'CASH', amount: 10_000 }] }) as { id: string };
    expect(() => api['sales.editable']!(sale.id)).toThrow(/demandez-le au gérant/);
    const req = api['editRequests.request']!(sale.id, 'Le client voulait 3 sacs') as { id: string };
    expect(() => api['editRequests.decide']!(req.id, true)).toThrow(/droits/);

    api['auth.login']!('mireille', '2222');
    expect(api['editRequests.list']!('pending')).toEqual([expect.objectContaining({ id: req.id, requester_name: 'Awa' })]);
    api['editRequests.decide']!(req.id, true, null);

    api['auth.login']!('awa', '5555');
    expect(api['sales.editable']!(sale.id)).toMatchObject({ paid: 10_000 });
    const edited = api['pos.sell']!({ lines: [{ articleId: riz, qty: 3_000 }], payments: [{ method: 'CASH', amount: 5_000 }], replacesId: sale.id }) as { id: string };
    expect(api['editRequests.list']!(null)).toEqual([expect.objectContaining({ status: 'used', new_sale_id: edited.id })]);
    expect(() => api['sales.editable']!(edited.id)).toThrow(/demandez-le au gérant/);
  });
});
