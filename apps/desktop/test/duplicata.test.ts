import { beforeEach, describe, expect, it } from 'vitest';
import { type Services, createServices, openDatabase } from '@superette/db';
import { createApi } from '../src/main/api';

let s: Services;
let api: Record<string, (...a: unknown[]) => unknown>;
let riz: string;
const printed: { doc: string; duplicate: boolean }[] = [];

// Imprimante qui note chaque document et s'il porte « DUPLICATA ».
const printer = new Proxy(
  {},
  {
    get: (_t, name) => async (_id: unknown, opts?: { duplicate?: boolean }) => {
      printed.push({ doc: String(name), duplicate: Boolean(opts?.duplicate) });
      return true;
    },
  },
) as never;
const sync = { now: async () => undefined, status: () => null } as never;
const system = { chooseFolder: async () => null, chooseBackupFile: async () => null, openFolder: async () => undefined, restore: () => undefined };

beforeEach(() => {
  printed.length = 0;
  s = createServices(openDatabase(':memory:'));
  const { store, register, admin } = s.admin.bootstrap({ storeCode: 'DLA1', storeName: 'Superette Akwa', adminName: 'Steve', adminLogin: 'steve', adminPin: '1234' });
  const tva = s.admin.listVatRates()[0]!.id;
  riz = s.catalogue.saveArticle(admin.id, { name: 'Riz 5 kg', unit: 'piece', vatRateId: tva, purchasePrice: 3_000, salePrice: 5_000 }).id;
  s.stock.receive({ storeId: store.id, registerId: register.id, userId: admin.id }, { warehouseId: s.admin.salesWarehouse(store.id).id, lines: [{ articleId: riz, qty: 50_000, unitCost: 3_000 }] });
  api = createApi(s, printer, sync, 'test', system) as never;
  api['auth.login']!('steve', '1234');
  api['treasury.open']!(10_000);
});

describe('DUPLICATA sur les réimpressions', () => {
  it('ticket et facture se comptent séparément', async () => {
    const sale = api['pos.sell']!({ lines: [{ articleId: riz, qty: 1000 }], payments: [{ method: 'CASH', amount: 5_000 }] }) as { id: string };
    await api['pos.printTicket']!(sale.id, { newSale: true, force: true });
    await api['pos.printInvoice']!(sale.id);
    await api['pos.printTicket']!(sale.id);
    await api['pos.printInvoice']!(sale.id, { format: 'listing' });
    expect(printed).toEqual([
      { doc: 'ticket', duplicate: false },
      { doc: 'invoice', duplicate: false },
      { doc: 'ticket', duplicate: true },
      { doc: 'invoice', duplicate: true },
    ]);
    expect(s.pos.getSale(sale.id)).toMatchObject({ ticket_prints: 2, invoice_prints: 2 });
  });

  it("l'aperçu montre DUPLICATA une fois la facture imprimée", async () => {
    const sale = api['pos.sell']!({ lines: [{ articleId: riz, qty: 1000 }], payments: [{ method: 'CASH', amount: 5_000 }] }) as { id: string };
    printed.length = 0;
    api['pos.previewInvoice']!(sale.id);
    await api['pos.printInvoice']!(sale.id);
    api['pos.previewInvoice']!(sale.id);
    expect(printed.filter((p) => p.doc === 'previewInvoice').map((p) => p.duplicate)).toEqual([false, true]);
  });
});
