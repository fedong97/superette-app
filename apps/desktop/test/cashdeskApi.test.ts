import { beforeEach, describe, expect, it } from 'vitest';
import { type Services, createServices, openDatabase } from '@superette/db';
import { createApi } from '../src/main/api';

let s: Services;
let api: Record<string, (...a: unknown[]) => unknown>;
let caisse2: string;
const printed: string[] = [];

const printer = new Proxy({}, { get: (_t, name) => async (...a: unknown[]) => void printed.push(`${String(name)}:${a.map(String).join(',')}`) }) as never;
const sync = { now: async () => undefined, status: () => null } as never;
const system = { chooseFolder: async () => null, chooseBackupFile: async () => null, openFolder: async () => undefined, restore: () => undefined };
const login = (u: string, p: string) => api['auth.login']!(u, p);
const session = () => (api['treasury.state']!() as { registers: { isThisStation: boolean; session: { id: string } | null }[] }).registers.find((r) => r.isThisStation)!.session!.id;

beforeEach(() => {
  printed.length = 0;
  s = createServices(openDatabase(':memory:'));
  const { store, register, admin } = s.admin.bootstrap({ storeCode: 'DLA1', storeName: 'Superette Akwa', adminName: 'Steve', adminLogin: 'steve', adminPin: '1234' });
  caisse2 = s.admin.createRegister(admin.id, store.id, 'Caisse 2', 'cash').id;
  s.admin.createUser(admin.id, { name: 'Mireille', login: 'mireille', pin: '2222', role: 'manager', storeId: store.id });
  s.admin.createUser(admin.id, { name: 'Awa', login: 'awa', pin: '5555', role: 'cashier', storeId: store.id, registerId: register.id });
  s.admin.createUser(admin.id, { name: 'Ali', login: 'ali', pin: '6666', role: 'cashier', storeId: store.id, registerId: caisse2 });
  api = createApi(s, printer, sync, 'test', system) as never;
});

describe('Encaisser, Décaisser et collaborateurs par l’API', () => {
  it('le caissier encaisse seul, décaisse avec le code du gérant ; un autre caissier ne touche pas à sa caisse', async () => {
    login('steve', '1234');
    const paul = api['staff.save']!({ name: 'Paul', baseSalary: 60_000 }) as { id: string; salary_account: string };
    expect(paul.salary_account).toBe('4211001');

    login('awa', '5555');
    expect(() => api['staff.save']!({ name: 'X' })).toThrow(/droits/);
    api['treasury.open']!(5_000);
    const id = session();
    const opts = api['cashdesk.options']!(id) as { methods: string[]; needsPin: boolean; staff: { id: string }[] };
    expect(opts).toMatchObject({ methods: ['CASH'], needsPin: true });
    expect(opts.staff.map((x) => x.id)).toEqual([paul.id]);

    const r = api['cashdesk.in']!(id, { type: 'other', accountId: '4711', amount: 2_000, method: 'CASH', label: 'Cartons' }) as { source: string; id: string };
    const out = { type: 'staff_advance', staffId: paul.id, amount: 3_000, method: 'CASH' };
    expect(() => api['cashdesk.out']!(id, out)).toThrow();
    api['cashdesk.out']!(id, out, '2222');
    expect(s.staff.get(paul.id).advances).toBe(3_000);

    // Reçu : l'original, puis un duplicata.
    await api['cashdesk.print']!(id, r.source, r.id);
    await api['cashdesk.print']!(id, r.source, r.id);
    expect(printed).toEqual([`deskTicket:${id},entry,${r.id},[object Object]`, `deskTicket:${id},entry,${r.id},[object Object]`]);
    expect(s.cashdesk.get(r.id).printed).toBe(2);
    // Supprimer demande le gérant.
    expect(() => api['cashdesk.cancel']!('entry', r.id, 'Erreur')).toThrow();
    api['cashdesk.cancel']!('entry', r.id, 'Erreur', '2222');
    expect(s.cashdesk.get(r.id).status).toBe('cancelled');

    login('ali', '6666');
    expect(() => api['cashdesk.in']!(id, { type: 'other', accountId: '4711', amount: 1, method: 'CASH', label: 'x' })).toThrow(/caissier de cette caisse/);
    expect((api['treasury.myDay']!() as { entries: unknown[] } | null)?.entries ?? []).toEqual([]);
  });

  it('le gérant constate et paie un salaire au bureau, puis imprime le bulletin', async () => {
    login('steve', '1234');
    const paul = api['staff.save']!({ name: 'Paul', baseSalary: 60_000 }) as { id: string };
    api['treasury.record']!({ kind: 'IN', nature: 'owner', amount: 100_000 });
    const [salary] = api['staff.recordSalaries']!('2026-01', [{ staffId: paul.id, gross: 60_000 }]) as { id: string }[];
    const e = api['staff.pay']!({ kind: 'staff_salary', salaryId: salary!.id, amount: 60_000, method: 'CASH' }) as { id: string; from_central: number };
    expect(e.from_central).toBe(1);
    expect((api['staff.month']!('2026-01') as { salary: { rest: number } }[])[0]!.salary.rest).toBe(0);
    await api['staff.printSlip']!(salary!.id);
    await api['staff.printEntry']!(e.id);
    expect(printed).toEqual([`salarySlip:${salary!.id}`, `officeVoucher:${e.id}`]);
  });
});
