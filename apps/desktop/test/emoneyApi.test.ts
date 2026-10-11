import { beforeEach, describe, expect, it } from 'vitest';
import { type Services, createServices, openDatabase } from '@superette/db';
import { createApi } from '../src/main/api';

let s: Services;
let api: Record<string, (...a: unknown[]) => unknown>;
let riz: string;
let mobile: string;
let centrale: string;
let category: string;
const printed: string[] = [];

const printer = new Proxy({}, { get: (_t, name) => async (...a: unknown[]) => void printed.push(`${String(name)}:${a.map(String).join(',')}`) }) as never;
const sync = { now: async () => undefined, status: () => null } as never;
const system = { chooseFolder: async () => null, chooseBackupFile: async () => null, openFolder: async () => undefined, restore: () => undefined };
const login = (u: string, p: string) => api['auth.login']!(u, p);

beforeEach(() => {
  printed.length = 0;
  s = createServices(openDatabase(':memory:'));
  const { store, register, admin } = s.admin.bootstrap({ storeCode: 'DLA1', storeName: 'Superette Akwa', adminName: 'Steve', adminLogin: 'steve', adminPin: '1234' });
  mobile = s.admin.createRegister(admin.id, store.id, 'Mobile Awa', 'electronic').id;
  centrale = s.admin.createRegister(admin.id, store.id, 'MoMo magasin', 'electronic').id;
  s.admin.createUser(admin.id, { name: 'Mireille', login: 'mireille', pin: '2222', role: 'manager', storeId: store.id });
  s.admin.createUser(admin.id, { name: 'Awa', login: 'awa', pin: '5555', role: 'cashier', storeId: store.id, registerId: register.id, emoneyRegisterId: mobile });
  const tva = s.admin.listVatRates()[0]!.id;
  riz = s.catalogue.saveArticle(admin.id, { name: 'Riz 5 kg', unit: 'piece', vatRateId: tva, purchasePrice: 3_000, salePrice: 5_000 }).id;
  s.stock.receive({ storeId: store.id, registerId: register.id, userId: admin.id }, { warehouseId: s.admin.salesWarehouse(store.id).id, lines: [{ articleId: riz, qty: 50_000, unitCost: 3_000 }] });
  category = s.expenses.listCategories()[0]!.id;
  api = createApi(s, printer, sync, 'test', system) as never;
  login('steve', '1234');
  api['admin.saveStoreSettings']!({ emoneyMode: 'central', emoneyCentralRegisterId: centrale });
});

describe('caisse électronique : sorties et versement à la centrale', () => {
  it('le caissier paie une dépense par son compte MoMo, la voit à la clôture et verse sa recette', async () => {
    login('awa', '5555');
    api['treasury.open']!(0);
    api['pos.sell']!({ lines: [{ articleId: riz, qty: 2_000 }], payments: [{ method: 'MTN_MOMO', amount: 10_000, reference: 'TX1' }] });
    // Sans le droit des sorties, il faut le code du gérant.
    const expense = { categoryId: category, label: 'Crédit téléphone', amount: 1_000, method: 'MTN_MOMO', reference: 'MP-55' };
    expect(() => api['expenses.record']!(expense)).toThrow();
    const e = api['expenses.record']!({ ...expense, supervisorPin: '2222' }) as { register_id: string; session_id: string };
    expect(e.register_id).toBe(mobile);

    const day = api['treasury.emoneyDay']!(mobile) as { canDeposit: boolean; centralName: string; exits: { nature: string; amount: number }[]; opening: unknown };
    expect(day).toMatchObject({ canDeposit: true, centralName: 'MoMo magasin', opening: null });
    expect(day.exits.map((x) => [x.nature, x.amount])).toEqual([['Dépense', 1_000]]);
    expect((api['treasury.myDay']!() as { emoneyExits: { amount: number }[] }).emoneyExits.map((x) => x.amount)).toEqual([1_000]);

    // Le téléphone montre 9 000 : il verse 8 000 et garde 1 000.
    const r = api['treasury.closeDeclared']!(mobile, { MTN_MOMO: 9_000, ORANGE_MONEY: 0, CARD: 0 }, { deposit: { MTN_MOMO: { amount: 8_000, reference: 'MP-V1' } } }) as {
      needsApproval: boolean;
      depositId: string;
    };
    expect(r.needsApproval).toBe(false);
    await api['emoney.print']!(r.depositId);
    expect(printed).toEqual([`emoneyVoucher:${r.depositId}`]);
    expect(s.receipts.emoneyVoucher(r.depositId).some((l) => 'text' in l && l.text === 'BON DE VERSEMENT ÉLECTRONIQUE')).toBe(true);

    // Le gérant voit la centrale créditée et le reste sur la caisse d'Awa.
    expect(() => api['emoney.state']!()).toThrow(/droits/);
    login('mireille', '2222');
    const st = api['emoney.state']!() as { registers: { name: string; central: boolean; balance: Record<string, number> }[]; ledger: { rows: { nature: string; signed: number }[] } };
    expect(st.registers.map((x) => [x.name, x.central, x.balance.MTN_MOMO])).toEqual([
      ['MoMo magasin', true, 8_000],
      ['Mobile Awa', false, 1_000],
    ]);
    expect(st.ledger.rows.map((x) => [x.nature, x.signed])).toEqual([['Versement', 8_000]]);
  });

  it('au bureau, une dépense MoMo sort de la centrale ; un règlement fournisseur de la caisse choisie', () => {
    login('mireille', '2222');
    api['emoney.record']!({ registerId: centrale, direction: 'IN', nature: 'other', method: 'MTN_MOMO', amount: 30_000 });
    const e = api['expenses.record']!({ categoryId: category, label: 'ENEO', amount: 7_000, method: 'MTN_MOMO', reference: 'MP-E' }) as { register_id: string };
    expect(e.register_id).toBe(centrale);
    expect(s.emoney.balance(centrale).MTN_MOMO).toBe(23_000);
    const sup = s.purchases.saveSupplier(s.admin.listUsers()[0]!.id, { name: 'Brasseries' } as never) as { id: string };
    const inv = s.purchases.createInvoice({ storeId: s.admin.station()!.store.id, registerId: null, userId: s.admin.listUsers()[0]!.id }, {
      supplierId: sup.id,
      supplierNumber: 'F-1',
      invoiceDate: '2026-10-01',
      kind: 'invoice',
      totalHt: 5_000,
      totalTva: 0,
    }) as { id: string };
    api['purchases.pay']!({ invoiceId: inv.id, method: 'ORANGE_MONEY', amount: 5_000, reference: 'OM-F', registerId: centrale });
    expect(s.emoney.balance(centrale).ORANGE_MONEY).toBe(-5_000);
  });
});
