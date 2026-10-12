import { beforeEach, describe, expect, it } from 'vitest';
import { type Services, createServices, openDatabase } from '@superette/db';
import { createApi } from '../src/main/api';

let s: Services;
let api: Record<string, (...a: unknown[]) => unknown>;
let riz: string;
let sup: string;
let wh: string;
const printed: string[] = [];

const printer = new Proxy({}, { get: (_t, name) => async (...a: unknown[]) => void printed.push(`${String(name)}:${a.map(String).join(',')}`) }) as never;
const sync = { now: async () => undefined, status: () => null } as never;
const system = { chooseFolder: async () => null, chooseBackupFile: async () => null, openFolder: async () => undefined, restore: () => undefined };
const login = (u: string, p: string) => api['auth.login']!(u, p);
const img = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==';

beforeEach(() => {
  printed.length = 0;
  s = createServices(openDatabase(':memory:'));
  const { store, register, admin } = s.admin.bootstrap({ storeCode: 'DLA1', storeName: 'Superette Akwa', adminName: 'Steve', adminLogin: 'steve', adminPin: '1234' });
  s.admin.createUser(admin.id, { name: 'Awa', login: 'awa', pin: '5555', role: 'cashier', storeId: store.id, registerId: register.id });
  riz = s.catalogue.saveArticle(admin.id, { name: 'Riz 5 kg', unit: 'piece', vatRateId: s.admin.listVatRates()[0]!.id, purchasePrice: 3_000, salePrice: 5_000 }).id;
  sup = s.purchases.saveSupplier(admin.id, { name: 'CCA' }).id;
  wh = s.admin.salesWarehouse(store.id).id;
  api = createApi(s, printer, sync, 'test', system) as never;
});

describe('0.35.0 par l’API', () => {
  it('photo : le gérant la met, le caissier la voit mais ne la change pas', () => {
    login('steve', '1234');
    api['catalogue.setPhoto']!(riz, { photo: img, thumb: img });
    login('awa', '5555');
    expect(api['catalogue.photo']!(riz)).toBe(img);
    expect(() => api['catalogue.setPhoto']!(riz, null)).toThrow(/droits/);
  });

  it('facture directe : réservée à qui réceptionne et facture, puis imprimée', async () => {
    const input = { supplierId: sup, supplierNumber: 'F-9', invoiceDate: '2026-10-11', warehouseId: wh, lines: [{ articleId: riz, qty: 10_000, unitCost: 3_000, discountBp: 1_000 }] };
    login('awa', '5555');
    expect(() => api['purchases.directInvoice']!(input)).toThrow(/droits/);
    login('steve', '1234');
    const inv = api['purchases.directInvoice']!(input) as { id: string; total_ht: number };
    expect(inv.total_ht).toBe(27_000);
    const detail = api['purchases.invoice']!(inv.id) as { lines: { discount_bp: number }[] };
    expect(detail.lines[0]!.discount_bp).toBe(1_000);
    await api['purchases.printInvoice']!(inv.id);
    expect(printed).toEqual([`purchaseInvoice:${inv.id},undefined`]);
  });
});
