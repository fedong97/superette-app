import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openServices } from '@superette/db';
import { createApi, type SystemHooks } from '../src/main/api';
import { createDossiers } from '../src/main/dossiers';

const printer = new Proxy({}, { get: () => async () => undefined }) as never;
const sync = { now: async () => undefined, connect: async () => undefined } as never;
type Api = Record<string, (...a: unknown[]) => unknown>;

function start(root: string, clock: () => Date) {
  const dossiers = createDossiers(join(root, 'userData'), join(root, 'Documents'));
  const file = dossiers.startupFile();
  const s = openServices(file, clock);
  const answers = { folder: null as string | null, file: null as string | null };
  const system: SystemHooks = {
    chooseFolder: async () => answers.folder,
    chooseBackupFile: async () => null,
    openFolder: async () => undefined,
    restore: () => undefined,
    chooseOpenFile: async () => answers.file,
    dossiers: {
      file,
      dir: dossiers.dir,
      list: () => dossiers.list(file),
      open: () => undefined,
      create: (n) => dossiers.newFile(n),
      forget: () => undefined,
      importFile: (f) => dossiers.importFile(f),
      chooseFile: async () => answers.file,
      install: () => undefined,
    },
  };
  return { s, answers, api: createApi(s, printer, sync, '0.59.0', system) as unknown as Api };
}

describe('nouveautés tirées de Sage dans l’application', () => {
  it('crée la boutique depuis un modèle, en fait un modèle et le réapplique ailleurs', () => {
    const root = mkdtempSync(join(tmpdir(), 'fedonix-api-modele-'));
    const clock = () => new Date('2026-10-17T08:00:00');
    const a = start(join(root, 'a'), clock);
    const list = a.api['template.list']!() as { id: string; builtin: boolean }[];
    expect(list.map((t) => t.id)).toContain('quincaillerie');
    a.api['setup.bootstrap']!({ storeCode: 'DLA1', storeName: 'Quincaillerie Akwa', adminName: 'Steve', adminLogin: 'steve', adminPin: '1234', template: 'quincaillerie' });
    expect(a.s.catalogue.listDepartments().map((d) => d.name)).toContain('Plomberie');
    expect(a.s.admin.storeSettings(a.s.admin.station()!.store.id).defaultMarginPct).toBe(25);

    const saved = a.api['template.save']!({ name: 'Ma quincaillerie' }) as { file: string; builtin: boolean };
    expect(existsSync(saved.file)).toBe(true);
    expect(saved.file).toContain(join('Documents', 'FEDONIX 360', 'Modèles'));
    expect((a.api['template.list']!() as { id: string }[]).some((t) => t.id === saved.file)).toBe(true);

    const b = start(join(root, 'b'), clock);
    b.answers.file = saved.file;
    b.api['setup.bootstrap']!({ storeCode: 'YDE1', storeName: 'Quincaillerie Mvog', adminName: 'Steve', adminLogin: 'steve', adminPin: '1234' });
    expect(b.s.catalogue.listDepartments()).toHaveLength(0);
    expect(b.api['template.apply']!(saved.file)).toMatchObject({ departments: 5 });
    expect(b.s.catalogue.listDepartments().map((d) => d.name)).toContain('Matériaux');
  });

  it('exporte les écritures au format Sage 100 et selon un format enregistré, puis contrôle la clôture', async () => {
    const root = mkdtempSync(join(tmpdir(), 'fedonix-api-format-'));
    let now = new Date('2026-03-02T09:00:00');
    const a = start(root, () => now);
    const { store, register, admin } = a.s.admin.bootstrap({ storeCode: 'DLA1', storeName: 'Superette Akwa', adminName: 'Steve', adminLogin: 'steve', adminPin: '1234' });
    a.api['auth.login']!('steve', '1234');
    const tva = a.s.admin.listVatRates()[0]!.id;
    const riz = a.s.catalogue.saveArticle(admin.id, { name: 'Riz 5 kg', unit: 'piece', vatRateId: tva, purchasePrice: 3_000, salePrice: 5_000 });
    const fy = (a.api['fiscal.list']!() as { id: string }[])[0]!;
    const ctx = { storeId: store.id, registerId: register.id, userId: admin.id };
    a.s.stock.receive(ctx, { warehouseId: a.s.admin.salesWarehouse(store.id).id, lines: [{ articleId: riz.id, qty: 10_000, unitCost: 3_000 }] });
    a.s.pos.openSession(ctx, 0);
    a.s.pos.completeSale(ctx, { lines: [{ articleId: riz.id, qty: 1_000 }], payments: [{ method: 'CASH', amount: 5_000 }] });

    const sage = a.api['accounting.exportFormatted']!({ from: '2026-03-01', to: '2026-03-31' }, 'sage100') as string;
    expect(sage.split('\r\n')[0]).toMatch(/^[A-Z]+;020326;/);
    expect(sage).toMatch(/;D;5000\r\n/);

    expect(() => a.api['formats.save']!({ id: '', name: '', kind: 'ecritures', separator: ';', dateFormat: 'ddmmyyyy', header: false, columns: ['account'], debitMark: 'D', creditMark: 'C' })).toThrow(/nom/);
    const mine = a.api['formats.save']!({ id: '', name: 'Cabinet Ngono', kind: 'ecritures', separator: '\t', dateFormat: 'ddmmyyyy', header: false, columns: ['date', 'account', 'amount', 'direction'], debitMark: '+', creditMark: '-' }) as { id: string };
    const out = a.api['accounting.exportFormatted']!({ from: '2026-03-01', to: '2026-03-31' }, mine.id) as string;
    expect(out).toMatch(/^02032026\t\d+\t5000\t\+/);
    const imp = a.api['formats.save']!({ id: '', name: 'Brasseries', kind: 'articles', separator: ';', skipRows: 2, decimal: ',', columns: { name: 1, salePrice: 3 } }) as { id: string };
    expect((a.api['formats.list']!() as { id: string }[]).map((f) => f.id)).toEqual(['sage100-articles', 'fedonix', 'sage100', 'debit-credit', mine.id, imp.id]);
    a.api['formats.delete']!(imp.id);
    expect(() => a.api['formats.delete']!('sage100')).toThrow(/introuvable/);

    now = new Date('2027-01-05T09:00:00');
    const checks = a.api['fiscal.checkClose']!(fy.id) as { key: string; status: string }[];
    expect(checks.find((c) => c.key === 'cash')).toMatchObject({ status: 'warning' });
    expect(checks.find((c) => c.key === 'stock')).toMatchObject({ status: 'ok' });
    expect(checks.filter((c) => c.status === 'blocking')).toEqual([]);
  });
});
