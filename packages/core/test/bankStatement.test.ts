import { describe, expect, it } from 'vitest';
import { parseStatementAmount, parseStatementCsv, parseStatementDate } from '../src';

describe('relevés bancaires et Mobile Money', () => {
  it('lit les montants et les dates sous toutes leurs formes', () => {
    expect(['1 250 000', '1.250.000', '1,250,000.00', '1 250 000,00', '-5 000', '(5 000)', '5 000-', '250,5', '12 500 FCFA', ''].map(parseStatementAmount)).toEqual([
      1_250_000, 1_250_000, 1_250_000, 1_250_000, -5_000, -5_000, -5_000, 251, 12_500, null,
    ]);
    expect(['06/10/2026', '6-10-26', '2026-10-06', '06/10/2026 14:32', '31/02/2026', 'Solde'].map(parseStatementDate)).toEqual([
      '2026-10-06', '2026-10-06', '2026-10-06', '2026-10-06', null, null,
    ]);
  });

  it('relevé de banque avec débit et crédit séparés, lignes de solde ignorées', () => {
    const csv = [
      'Afriland First Bank;Relevé de compte',
      'Date opération;Date valeur;Libellé;Référence;Débit;Crédit',
      ';;Solde au 30/09/2026;;;1 850 000',
      '02/10/2026;02/10/2026;VERSEMENT ESPECES;VRS-881;;450 000',
      '03/10/2026;04/10/2026;"CHQ 0012, SABC";0012;357 750;',
      '05/10/2026;05/10/2026;FRAIS TENUE DE COMPTE;;5 000;',
      'xx/10/2026;;ERREUR;;1 000;',
    ].join('\n');
    const r = parseStatementCsv(csv);
    expect(r.columns).toMatchObject({ date: 'Date opération', label: 'Libellé', reference: 'Référence', debit: 'Débit', credit: 'Crédit' });
    expect(r.lines).toEqual([
      { date: '2026-10-02', label: 'VERSEMENT ESPECES', reference: 'VRS-881', amount: 450_000 },
      { date: '2026-10-03', label: 'CHQ 0012, SABC', reference: '0012', amount: -357_750 },
      { date: '2026-10-05', label: 'FRAIS TENUE DE COMPTE', reference: null, amount: -5_000 },
    ]);
    expect(r.skipped).toEqual([{ row: 7, reason: 'Date illisible : « xx/10/2026 »' }]);
  });

  it('relevé MoMo avec montant signé et frais à part', () => {
    const csv = 'Date,Transaction ID,Description,Amount,Fees,Balance\n2026-10-04 10:12:00,MP261004.1012.A1,Paiement marchand,"12,500",0,512500\n2026-10-05 08:00:00,MP261005.0800.B2,Retrait,-100000,1000,411500\n';
    expect(parseStatementCsv(csv).lines).toEqual([
      { date: '2026-10-04', label: 'Paiement marchand', reference: 'MP261004.1012.A1', amount: 12_500 },
      { date: '2026-10-05', label: 'Retrait', reference: 'MP261005.0800.B2', amount: -100_000 },
      { date: '2026-10-05', label: 'Frais : Retrait', reference: 'MP261005.0800.B2', amount: -1_000 },
    ]);
    expect(parseStatementCsv('Nom;Valeur\nA;1').skipped[0]!.reason).toContain('Date');
  });
});
