import { beforeEach, describe, expect, it } from 'vitest';
import { type Services, createServices, openDatabase } from '@superette/db';
import { createApi } from '../src/main/api';

let s: Services;
let api: Record<string, (...a: unknown[]) => unknown>;
let tva: string;
const printed: string[] = [];

const printer = new Proxy({}, { get: (_t, name) => async (...a: unknown[]) => void printed.push(`${String(name)}:${a.map((x) => JSON.stringify(x)).join(',')}`) }) as never;
const sync = { now: async () => undefined, status: () => null } as never;
const system = { chooseFolder: async () => null, chooseBackupFile: async () => null, openFolder: async () => undefined, restore: () => undefined };
const login = (u: string, p: string) => api['auth.login']!(u, p);
const rateOf = (id: string) => s.db.prepare('SELECT r.rate_bp FROM articles a JOIN vat_rates r ON r.id = a.vat_rate_id WHERE a.id = ?').pluck().get(id);

beforeEach(() => {
  printed.length = 0;
  s = createServices(openDatabase(':memory:'));
  s.admin.bootstrap({ storeCode: 'DLA1', storeName: 'Superette Akwa', adminName: 'Steve', adminLogin: 'steve', adminPin: '1234', vatEnabled: false });
  tva = s.admin.listVatRates().find((r) => r.rate_bp === 1925)!.id;
  api = createApi(s, printer, sync, 'test', system) as never;
});

describe('0.36.0 par l’API', () => {
  it('magasin sans TVA : un nouvel article est exonéré, même si l’écran envoie 19,25 %', () => {
    login('steve', '1234');
    const a = api['catalogue.save']!({ name: 'DOLAIT 400 G', unit: 'piece', vatRateId: tva, purchasePrice: 1_500, salePrice: 2_000 }) as { id: string };
    expect(rateOf(a.id)).toBe(0);
    // Modifier l'article ne change pas son taux.
    api['catalogue.save']!({ name: 'DOLAIT 400 G', unit: 'piece', vatRateId: tva, purchasePrice: 1_500, salePrice: 2_100 }, a.id);
    expect(rateOf(a.id)).toBe(0);
  });

  it('TVA réactivée : l’administrateur remet les exonérés à 19,25 %, puis le stock multi-magasin s’imprime', async () => {
    login('steve', '1234');
    const a = api['catalogue.save']!({ name: 'DOLAIT 400 G', unit: 'piece', vatRateId: tva, purchasePrice: 1_500, salePrice: 2_000 }) as { id: string };
    api['admin.storeOptions']!({ vatEnabled: true });
    expect(api['admin.articlesStandardRate']!()).toBe(1);
    expect(rateOf(a.id)).toBe(1925);
    expect((api['stock.byStore']!({ search: 'dolait' }) as { rows: unknown[] }).rows).toHaveLength(1);
    await api['stock.printByStore']!({ shortage: true });
    expect(printed[0]).toMatch(/^stockByStore:/);
  });
});
