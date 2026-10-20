import { describe, expect, it } from 'vitest';
import { type Context, type Entry, createServices, cumulatedAt, depreciationAccount, openDatabase } from '../src';

let now = new Date('2026-03-15T08:00:00Z');

function setup() {
  now = new Date('2026-03-15T08:00:00Z');
  const s = createServices(openDatabase(':memory:'), () => now);
  const { store, register, admin } = s.admin.bootstrap({ storeCode: 'DLA1', storeName: 'Superette Akwa', adminName: 'Steve', adminLogin: 'steve', adminPin: '1234' });
  const ctx: Context = { storeId: store.id, registerId: register.id, userId: admin.id };
  return { s, ctx };
}

const balanced = (entries: Entry[]) => entries.every((e) => e.lines.reduce((t, l) => t + l.debit, 0) === e.lines.reduce((t, l) => t + l.credit, 0));
const congelateur = { label: 'Congélateur coffre 400 L', account: '241', inServiceOn: '2026-03-15', cost: 730_000, durationMonths: 60, funding: 'supplier' as const };

describe('amortissement linéaire', () => {
  it('au prorata des jours, sans dérive d’arrondi, jusqu’à la valeur d’origine', () => {
    const a = { in_service_on: '2026-03-15', duration_months: 60, account: '241', cost: 730_000 };
    // 5 ans du 15/03/2026 au 14/03/2031 : 1 826 jours.
    expect(cumulatedAt(a, '2026-03-14')).toBe(0);
    expect(cumulatedAt(a, '2026-12-31')).toBe(Math.round((730_000 * 292) / 1826));
    expect(cumulatedAt(a, '2031-03-13')).toBeLessThan(730_000);
    expect(cumulatedAt(a, '2031-03-14')).toBe(730_000);
    expect(cumulatedAt(a, '2040-01-01')).toBe(730_000);
    expect(cumulatedAt({ ...a, account: '222', duration_months: 0 }, '2030-01-01')).toBe(0);
    expect(depreciationAccount('2442')).toBe('2844');
    expect(depreciationAccount('213')).toBe('2813');
    expect(depreciationAccount('241')).toBe('2841');
  });
});

describe('registre des immobilisations', () => {
  it("plan d'amortissement, dotations de fin d'exercice, puis vente du bien", () => {
    const { s, ctx } = setup();
    expect(() => s.assets.save(ctx, { ...congelateur, durationMonths: 0 })).toThrow(/durée d'amortissement/);
    expect(() => s.assets.save(ctx, { ...congelateur, inServiceOn: '2026-04-01' })).toThrow(/futur/);
    const asset = s.assets.save(ctx, congelateur);
    expect(asset.code).toBe('IMMO-DLA11-00001');
    // Les comptes manquants sont créés avec leur libellé SYSCOHADA.
    const accounts = new Map(s.accounting.listAccounts().map((a) => [a.id, a.label]));
    expect(accounts.get('2841')).toBeDefined();
    expect(accounts.get('6813')).toBe('Dotations aux amortissements des immobilisations corporelles');
    expect(accounts.get('481')).toBe("Fournisseurs d'investissements");

    const plan = s.assets.schedule(asset.id);
    expect(plan.map((p) => [p.from, p.to])).toEqual([
      ['2026-03-15', '2026-12-31'],
      ['2027-01-01', '2027-12-31'],
      ['2028-01-01', '2028-12-31'],
      ['2029-01-01', '2029-12-31'],
      ['2030-01-01', '2030-12-31'],
      ['2031-01-01', '2031-03-14'],
    ]);
    expect(plan.reduce((t, p) => t + p.charge, 0)).toBe(730_000);
    expect(plan.at(-1)).toMatchObject({ cumulated: 730_000, net: 0 });
    expect(plan[1]!.charge).toBe(cumulatedAt({ ...asset }, '2027-12-31') - cumulatedAt({ ...asset }, '2026-12-31'));

    // Acquisition à payer au fournisseur d'investissement ; pas encore de dotation.
    let entries = s.accounting.entries(ctx.storeId);
    expect(entries.map((e) => [e.journal, e.ref])).toEqual([['OD', 'IMMO-DLA11-00001']]);
    expect(s.assets.list(ctx.storeId)[0]).toMatchObject({ cumulated: cumulatedAt(asset, '2026-03-15'), net: 730_000 - cumulatedAt(asset, '2026-03-15'), year_charge: plan[0]!.charge, ends_on: '2031-03-14' });

    // En janvier 2028 : deux dotations passées, aux 31/12/2026 et 31/12/2027.
    now = new Date('2028-01-10T08:00:00Z');
    entries = s.accounting.entries(ctx.storeId);
    expect(balanced(entries)).toBe(true);
    const dotations = entries.filter((e) => e.label.startsWith('Dotation'));
    expect(dotations.map((d) => [d.date, d.lines[0]!.account, d.lines[0]!.debit, d.lines[1]!.account])).toEqual([
      ['2026-12-31', '6813', plan[0]!.charge, '2841'],
      ['2027-12-31', '6813', plan[1]!.charge, '2841'],
    ]);
    // Une dotation est passée : la valeur ne se modifie plus, le nom oui.
    expect(() => s.assets.save(ctx, { ...congelateur, cost: 800_000 }, asset.id)).toThrow(/dotation a déjà été passée/);
    expect(s.assets.save(ctx, { ...congelateur, label: 'Congélateur Liebherr 400 L' }, asset.id).label).toBe('Congélateur Liebherr 400 L');
    expect(() => s.assets.remove(ctx, asset.id)).toThrow(/sortez le bien/);

    // Bilan au 31/12/2027 : brut 730 000, amortissements cumulés des deux dotations.
    const tb = s.accounting.trialBalance(ctx.storeId, { to: '2027-12-31' });
    const row = (acc: string) => tb.rows.find((r) => r.account === acc)?.closing ?? 0;
    expect(row('241')).toBe(730_000);
    expect(row('2841')).toBe(-(plan[0]!.charge + plan[1]!.charge));

    // Vendu 400 000 le 30/06/2028 : dotation jusqu'au jour de la vente, sortie et plus-value.
    now = new Date('2028-07-02T08:00:00Z');
    expect(() => s.assets.dispose(ctx, asset.id, { date: '2028-06-30', kind: 'sale' })).toThrow(/prix de vente/);
    s.assets.dispose(ctx, asset.id, { date: '2028-06-30', kind: 'sale', price: 400_000 });
    entries = s.accounting.entries(ctx.storeId);
    expect(balanced(entries)).toBe(true);
    const cumulated = cumulatedAt(asset, '2028-06-30');
    const last = entries.filter((e) => e.label.startsWith('Dotation')).at(-1)!;
    expect(last).toMatchObject({ date: '2028-06-30' });
    expect(last.lines[0]!.debit).toBe(cumulated - plan[0]!.charge - plan[1]!.charge);
    const exit = entries.find((e) => e.ref === 'IMMO-DLA11-00001-S')!;
    expect(exit.lines.map((l) => [l.account, l.debit, l.credit])).toEqual([
      ['2841', cumulated, 0],
      ['812', 730_000 - cumulated, 0],
      ['241', 0, 730_000],
      ['485', 400_000, 0],
      ['822', 0, 400_000],
    ]);
    const after = s.accounting.trialBalance(ctx.storeId);
    expect(after.rows.find((r) => r.account === '241')?.closing).toBe(0);
    expect(after.rows.find((r) => r.account === '2841')?.closing).toBe(0);
    // Plus de dotation après la vente, même des années plus tard.
    now = new Date('2030-02-01T08:00:00Z');
    expect(s.accounting.entries(ctx.storeId).filter((e) => e.label.startsWith('Dotation'))).toHaveLength(3);
    expect(s.assets.list(ctx.storeId)).toHaveLength(0);
    expect(s.assets.list(ctx.storeId, { includeDisposed: true })[0]).toMatchObject({ disposal_kind: 'sale', disposal_price: 400_000 });
  });

  it("un bien repris arrive avec ses amortissements antérieurs, et suit les dates d'exercice du magasin", () => {
    const { s, ctx } = setup();
    // Premier exercice raccourci : du 01/01/2026 au 30/06/2026.
    s.fiscal.setDates(ctx, s.fiscal.list(ctx.storeId)[0]!.id, { start: '2026-01-01', end: '2026-06-30' });
    const pc = s.assets.save(ctx, {
      label: 'PC de caisse HP',
      account: '2442',
      inServiceOn: '2024-07-01',
      recordedOn: '2026-03-01',
      cost: 360_000,
      durationMonths: 36,
      funding: 'opening',
    });
    const prior = cumulatedAt(pc, '2026-02-28');
    const an = s.accounting.entries(ctx.storeId, { journal: 'AN' })[0]!;
    expect(an.lines.map((l) => [l.account, l.debit, l.credit])).toEqual([
      ['2442', 360_000, 0],
      ['2844', 0, prior],
      ['4711', 0, 360_000 - prior],
    ]);
    const plan = s.assets.schedule(pc.id);
    expect(plan.filter((p) => p.prior).map((p) => p.to)).toEqual(['2024-12-31', '2025-12-31']);
    expect(plan.find((p) => p.to === '2026-06-30')).toMatchObject({ prior: false });

    now = new Date('2026-07-05T08:00:00Z');
    const dotation = s.accounting.entries(ctx.storeId).find((e) => e.label.startsWith('Dotation'))!;
    // Première dotation au 30/06/2026, fin de l'exercice, pour la seule part depuis la reprise.
    expect(dotation).toMatchObject({ date: '2026-06-30' });
    expect(dotation.lines[0]!.debit).toBe(cumulatedAt(pc, '2026-06-30') - prior);
    expect(balanced(s.accounting.entries(ctx.storeId))).toBe(true);
    expect(() => s.assets.save(ctx, { label: 'x', account: '2442', inServiceOn: '2024-01-01', recordedOn: '2026-03-01', cost: 1, durationMonths: 12, funding: 'bank' })).toThrow(/Bien repris/);
  });

  it('les fiches passent aux autres PC du magasin', () => {
    const { s, ctx } = setup();
    s.assets.save(ctx, congelateur);
    const other = createServices(openDatabase(':memory:'), () => now);
    other.sync.applyRemote(s.sync.eventsSince(0));
    expect(other.assets.list(ctx.storeId).map((a) => a.label)).toEqual(['Congélateur coffre 400 L']);
    expect(other.accounting.entries(ctx.storeId)).toHaveLength(1);
  });
});
