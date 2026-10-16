import { DEFAULT_PAYROLL, computePayroll, mergeStoreSettings } from '@superette/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { type Context, type Services, createServices, openDatabase } from '../src';

describe('paie (règles)', () => {
  it('calcule les retenues et charges d’un salaire de 150 000 FCFA', () => {
    const p = computePayroll(150_000, DEFAULT_PAYROLL);
    // IRPP : (1 800 000 − 30 % − CNPS 75 600 − 500 000) = 684 400 à 10 % = 68 440 par an.
    expect(p).toMatchObject({ cnps: 6_300, irpp: 5_703, cac: 570, cfc: 1_500, rav: 1_950, tdl: 1_000, employeeTax: 10_723, net: 132_977 });
    expect(p).toMatchObject({ employerCnps: 16_800 + 2_625, employerCfc: 2_250, employerFne: 1_500, employerTax: 3_750 });
  });

  it('plafonne la CNPS, applique les tranches et le seuil de l’IRPP', () => {
    const high = computePayroll(1_000_000, DEFAULT_PAYROLL);
    expect(high.cnps).toBe(31_500);
    expect(high.irpp).toBe(144_392);
    expect(high.rav).toBe(12_350);
    expect(high.tdl).toBe(2_500);
    const low = computePayroll(60_000, DEFAULT_PAYROLL);
    expect(low).toMatchObject({ irpp: 0, cac: 0, tdl: 0, rav: 750 });
  });

  it('valide les taux et barèmes modifiés', () => {
    const next = mergeStoreSettings(null, { payroll: { ...DEFAULT_PAYROLL, enabled: true, accident: 250 } });
    expect(next.payroll).toMatchObject({ enabled: true, accident: 250 });
    expect(() => mergeStoreSettings(null, { payroll: { ...DEFAULT_PAYROLL, cac: -1 } })).toThrow(/taux invalide/);
    expect(() => mergeStoreSettings(null, { payroll: { ...DEFAULT_PAYROLL, rav: [{ upTo: null, value: 0 }, { upTo: 10, value: 1 }] } })).toThrow(/dernière tranche/);
  });
});

describe('salaires avec retenues légales', () => {
  let s: Services;
  let ctx: Context;
  const now = new Date('2026-10-16T08:00:00Z');

  beforeEach(() => {
    s = createServices(openDatabase(':memory:'), () => now);
    const { store, admin } = s.admin.bootstrap({ storeCode: 'DLA1', storeName: 'Superette Akwa', adminName: 'Steve', adminLogin: 'steve', adminPin: '1234' });
    ctx = { storeId: store.id, registerId: null, userId: admin.id };
  });

  it('sans paie activée, le salaire reste payé tel quel', () => {
    const paul = s.staff.save(ctx, { name: 'Paul', baseSalary: 150_000 });
    const [x] = s.staff.recordSalaries(ctx, '2026-09', [{ staffId: paul.id, gross: 150_000 }]);
    expect(x).toMatchObject({ cnps: 0, tax: 0, net: 150_000, payroll: null });
  });

  it('retient CNPS et impôts, passe les écritures et prépare les déclarations', () => {
    s.admin.saveStoreSettings(ctx.userId, ctx.storeId, { payroll: { ...DEFAULT_PAYROLL, enabled: true } });
    const paul = s.staff.save(ctx, { name: 'Paul', baseSalary: 150_000, cnpsNumber: '123456789' });
    const awa = s.staff.save(ctx, { name: 'Awa', baseSalary: 80_000, declared: false });
    expect(paul).toMatchObject({ declared: 1, cnps_number: '123456789' });
    s.cashdesk.record(ctx, { kind: 'staff_advance', staffId: paul.id, amount: 20_000, method: 'BANK_TRANSFER', reference: 'VIR-1', direction: 'OUT', sessionId: null, authorizedBy: ctx.userId });
    const [x, y] = s.staff.recordSalaries(ctx, '2026-09', [
      { staffId: paul.id, gross: 150_000, deducted: 20_000 },
      { staffId: awa.id, gross: 80_000 },
    ]);
    expect(x).toMatchObject({ cnps: 6_300, tax: 10_723, employer_social: 19_425, employer_tax: 3_750, net: 132_977 - 20_000, rest: 112_977 });
    expect(y).toMatchObject({ cnps: 0, tax: 0, net: 80_000 });
    expect(s.staff.get(paul.id)).toMatchObject({ due: 112_977, advances: 0 });
    const st = s.staff.statement(paul.id);
    expect(st.lines.at(-1)?.dueBalance).toBe(112_977);

    const tb = s.accounting.trialBalance(ctx.storeId).rows;
    const bal = (a: string) => tb.find((r) => r.account === a)?.closing ?? 0;
    expect(bal('661')).toBe(230_000);
    expect(bal('664')).toBe(19_425);
    expect(bal('641')).toBe(3_750);
    expect(bal('4311')).toBe(-(6_300 + 19_425));
    expect(bal('4471')).toBe(-(10_723 + 3_750));
    expect(bal(paul.salary_account)).toBe(-112_977);

    const d = s.staff.declarations(ctx.storeId, '2026-09');
    expect(d).toMatchObject({ gross: 150_000, cnps: 25_725, state: 14_473, irpp: 5_703, cac: 570, cfc: 3_750, fne: 1_500, rav: 1_950, tdl: 1_000 });
    expect(d.rows).toHaveLength(1);
    expect(s.staff.slip(x!.id).payroll).toMatchObject({ irpp: 5_703, net: 132_977 });
  });

  it('refuse une retenue d’avances au-delà du net après retenues', () => {
    s.admin.saveStoreSettings(ctx.userId, ctx.storeId, { payroll: { ...DEFAULT_PAYROLL, enabled: true } });
    const paul = s.staff.save(ctx, { name: 'Paul', baseSalary: 150_000 });
    s.cashdesk.record(ctx, { kind: 'staff_advance', staffId: paul.id, amount: 150_000, method: 'BANK_TRANSFER', reference: 'VIR-1', direction: 'OUT', sessionId: null, authorizedBy: ctx.userId });
    expect(() => s.staff.recordSalaries(ctx, '2026-09', [{ staffId: paul.id, gross: 150_000, deducted: 140_000 }])).toThrow(/dépasse son salaire net/);
  });
});
