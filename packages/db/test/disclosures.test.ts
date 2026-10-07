import { describe, expect, it } from 'vitest';
import { DEFAULT_ACCOUNTING_TEXTS, createServices, openDatabase } from '../src';

function setup() {
  const s = createServices(openDatabase(':memory:'), () => new Date('2026-02-01T09:00:00Z'));
  const { store, register, admin } = s.admin.bootstrap({ storeCode: 'DLA1', storeName: 'Superette Akwa', adminName: 'Steve', adminLogin: 'steve', adminPin: '1234' });
  const ctx = { storeId: store.id, registerId: register.id, userId: admin.id };
  return { s, ctx };
}

describe('notes déclaratives de la DSF', () => {
  it('propose des textes par défaut et des notes vides avant toute saisie', () => {
    const { s, ctx } = setup();
    const d = s.disclosures.get(ctx.storeId, 2025);
    expect(d.updatedAt).toBeNull();
    expect(d.accounting).toEqual(DEFAULT_ACCOUNTING_TEXTS);
    const { notes } = s.notes.notes(ctx.storeId, 2025);
    expect(notes.map((n) => n.id)).toEqual(['1', '2', '3A', '3C', '6', '7', '8', '11', '13', '13B', '16A', '17', '18', '19', '20', '21', '22', '23', '24', '25', '26', '27A', '27B', '28', '29', '30', '34', '35', 'RF']);
    const n2 = notes.find((n) => n.id === '2')!;
    expect(n2.declared).toBe(true);
    expect(n2.paragraphs?.[1]?.text).toContain('coût moyen unitaire pondéré');
    expect(notes.find((n) => n.id === '1')!.rows).toEqual([]);
    expect(notes.find((n) => n.id === '35')!.paragraphs).toEqual([]);
  });

  it('établit les notes 1, 13B et 27B et les rapproche des écritures', () => {
    const { s, ctx } = setup();
    s.accounting.saveAccount(ctx.userId, { id: '661', label: 'Rémunérations directes versées au personnel national' });
    const entry = (journal: 'AN' | 'BQ', date: string, label: string, lines: [string, number, number][]) =>
      s.accounting.addManualEntry(ctx, { journal, date, label, lines: lines.map(([account, debit, credit]) => ({ account, debit, credit })) });
    entry('AN', '2025-01-01', 'Capital', [['521', 1_000_000, 0], ['101', 0, 1_000_000]]);
    entry('BQ', '2025-01-31', 'Salaires janvier', [['661', 180_000, 0], ['521', 0, 180_000]]);

    s.disclosures.save(ctx, 2025, {
      securedDebts: [{ label: 'Prêt équipement', creditor: 'Afriland First Bank', security: 'pledge', amount: 900_000 }],
      commitments: [
        { direction: 'given', kind: 'guarantees', party: 'Caution douane', amount: 250_000 },
        { direction: 'received', kind: 'guarantees', party: 'Caution du gérant', amount: 500_000 },
      ],
      shareholders: [
        { name: 'Steve Fedong', nationality: 'Camerounaise', shares: 80, nominal: 10_000 },
        { name: 'Awa Bello', nationality: 'Tchadienne', shares: 20, nominal: 10_000 },
      ],
      staff: {
        managers: { national: [1, 0], cemac: [0, 0], other: [0, 0], payroll: 100_000 },
        supervisors: { national: [0, 0], cemac: [0, 0], other: [0, 0], payroll: 0 },
        employees: { national: [1, 2], cemac: [0, 1], other: [0, 0], payroll: 80_000 },
        temporary: { national: [0, 0], cemac: [0, 0], other: [0, 0], payroll: 0 },
      },
      external: { count: 1, cost: 40_000 },
      social: 'Tri des cartons, formation des caissières.',
    });
    const { notes } = s.notes.notes(ctx.storeId, 2025);
    const note = (id: string) => notes.find((n) => n.id === id)!;
    expect(note('1').rows).toEqual([
      { label: 'Prêt équipement · Afriland First Bank (nantissement)', values: [900_000, 0, 0] },
      { label: 'Avals, cautions et garanties · Caution douane', values: [0, 250_000, 0] },
      { label: 'Avals, cautions et garanties · Caution du gérant', values: [0, 0, 500_000] },
      { label: 'Total', values: [900_000, 250_000, 500_000], total: true },
    ]);
    expect(note('13B').rows.at(-1)).toEqual({ label: 'Total', values: [100, 0, 1_000_000], total: true });
    expect(note('13B').comment).toBe('Le total correspond au capital inscrit au bilan.');
    expect(note('27B').rows.map((r) => [r.label, r.values.at(-2), r.values.at(-1)])).toEqual([
      ['Cadres', 1, 100_000],
      ['Employés et ouvriers', 4, 80_000],
      ['Personnel extérieur (intérim, mis à disposition)', 1, 40_000],
      ['Total', 6, 220_000],
    ]);
    expect(note('27B').comment).toMatch(/^Rémunérations comptabilisées \(comptes 661 à 663\) : 180.000 FCFA, égales à la masse salariale déclarée\.$/);
    expect(note('35').paragraphs).toEqual([{ heading: '', text: 'Tri des cartons, formation des caissières.' }]);

    // Capital déclaré différent du bilan : signalé.
    s.disclosures.save(ctx, 2025, { shareholders: [{ name: 'Steve Fedong', nationality: '', shares: 50, nominal: 10_000 }] });
    expect(s.notes.notes(ctx.storeId, 2025).notes.find((n) => n.id === '13B')!.comment).toMatch(/^Écart avec le capital inscrit au bilan \(comptes 101 à 104 : 1.000.000 FCFA\)\.$/);
    // La saisie partielle garde le reste.
    expect(s.disclosures.get(ctx.storeId, 2025).social).toBe('Tri des cartons, formation des caissières.');
    expect(s.disclosures.get(ctx.storeId, 2025).updatedBy).toBe('Steve');

    const csv = s.notes.exportCsv(ctx.storeId, 2025);
    expect(csv).toContain('1;"Dettes garanties par des sûretés réelles et engagements financiers";"Total";900000;250000;500000');
    expect(csv).toContain('35;"Informations sociales, environnementales et sociétales";"Tri des cartons, formation des caissières."');
    expect(s.db.prepare("SELECT COUNT(*) FROM outbox WHERE entity = 'dsf_disclosure'").pluck().get()).toBe(2);
  });

  it('refuse les saisies incohérentes', () => {
    const { s, ctx } = setup();
    expect(() => s.disclosures.save(ctx, 2025, { securedDebts: [{ label: '', creditor: 'X', security: 'pledge', amount: 1 }] })).toThrow('indiquez la dette');
    expect(() => s.disclosures.save(ctx, 2025, { commitments: [{ direction: 'given', kind: 'guarantees', party: 'X', amount: -5 }] })).toThrow('montant invalide');
    expect(() => s.disclosures.save(ctx, 2025, { shareholders: [{ name: 'A', nationality: '', shares: 1.5, nominal: 1 }] })).toThrow('nombre invalide');
    expect(() => s.disclosures.save(ctx, 1999, {})).toThrow('Exercice invalide');
    expect(s.disclosures.get(ctx.storeId, 2025).updatedAt).toBeNull();
  });
});
