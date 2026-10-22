import { describe, expect, it } from 'vitest';
import { attendancePay, DEFAULT_STORE_SETTINGS, parseAttlog } from '@superette/core';
import { createServices, openDatabase } from '../src';

/** Heure locale du poste (le magasin est à Douala). */
const at = (day: string, hhmm: string) => {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y!, m! - 1, d!, Number(hhmm.slice(0, 2)), Number(hhmm.slice(3, 5)));
};

const setup = (day = '2026-10-19', hhmm = '07:00') => {
  let now = at(day, hhmm);
  const s = createServices(openDatabase(':memory:'), () => now);
  const { store, register, admin } = s.admin.bootstrap({ storeCode: 'DLA1', storeName: 'Superette Akwa', adminName: 'Steve', adminLogin: 'steve', adminPin: '1234' });
  const ctx = { storeId: store.id, registerId: register.id, userId: admin.id };
  const settings = (patch: Record<string, unknown>) => s.admin.saveStoreSettings(admin.id, store.id, patch as never);
  return { s, store, admin, ctx, settings, setNow: (d: string, h: string) => (now = at(d, h)) };
};

describe('paie d’après le pointage', () => {
  const rules = { ...DEFAULT_STORE_SETTINGS, payAbsence: true, payLate: true, payOvertime: true, overtimeRatePct: 20, holidayRatePct: 100, attendanceBonus: 5000, monthlyHours: 173 };

  it('retient les absences et les retards, majore les heures supplémentaires et les fériés', () => {
    const { lines, gross } = attendancePay(
      { base: 173_000, dailyRate: 0, allowance: 10_000, plannedDays: 26, presentDays: 24, absences: 2, unpaidLeave: 0, lateMinutes: 90, lateCount: 3, overtimeMinutes: 120, holidayMinutes: 480 },
      rules,
    );
    expect(lines.map((l) => [l.code, l.amount])).toEqual([
      ['base', 173_000],
      ['absence', -13_308],
      ['late', -1500],
      ['overtime', 2400],
      ['holiday', 8000],
      ['allowance', 10_000],
    ]);
    expect(lines[1]!.label).toBe('Retenue : 2 absences');
    expect(gross).toBe(178_592);
  });

  it('paie le journalier à la journée, et donne la prime d’assiduité sans absence ni retard', () => {
    const facts = { base: 0, dailyRate: 3000, allowance: 0, plannedDays: 26, presentDays: 20, absences: 0, unpaidLeave: 0, lateMinutes: 0, lateCount: 0, overtimeMinutes: 0, holidayMinutes: 0 };
    expect(attendancePay(facts, rules)).toEqual({
      lines: [
        { code: 'days', label: '20 jours de présence à 3 000 FCFA', amount: 60_000 },
        { code: 'bonus', label: 'Prime d’assiduité (ni absence ni retard)', amount: 5000 },
      ],
      gross: 65_000,
    });
    // Règles éteintes : seulement le salaire de base.
    const off = { ...rules, payAbsence: false, payLate: false, payOvertime: false, holidayRatePct: 0, attendanceBonus: 0 };
    expect(attendancePay({ ...facts, base: 100_000, dailyRate: 0, absences: 3, lateMinutes: 50, lateCount: 2, overtimeMinutes: 300 }, off).gross).toBe(100_000);
  });

  it('propose le salaire du mois depuis les passages et le garde avec le salaire constaté', () => {
    const { s, ctx, settings, setNow } = setup('2026-10-01', '07:00');
    settings({ staffTeams: true, payFromAttendance: true, payLate: true, payOvertime: true, contractorStaff: true });
    const jour = s.personnel.saveTeam(ctx, { name: 'Jour', start: '08:00', end: '17:00', days: '123456' });
    const marc = s.staff.save(ctx, { name: 'Marc Etoga', position: 'Magasinier', baseSalary: 173_000, hiredOn: '2026-10-01', allowance: 0 });
    s.personnel.setTeam(ctx, marc.id, { teamId: jour.id });
    const agency = s.personnel.saveAgency(ctx, { name: 'Sécurité Plus' });
    s.staff.save(ctx, { name: 'Ali Vigile', category: 'contractor', agencyId: agency.id });

    setNow('2026-11-02', '09:00');
    s.punches.correctDay(ctx, marc.id, '2026-10-05', { arrived: '08:00', left: '19:00', reason: 'Inventaire' });
    s.punches.correctDay(ctx, marc.id, '2026-10-06', { arrived: '08:45', left: '17:00', reason: 'Badge oublié' });
    const [p, ...others] = s.attendance.payProposals(ctx.storeId, '2026-10');
    // L'agent prestataire n'est pas payé ici : sa société le paie.
    expect(others).toEqual([]);
    expect(p!.facts).toMatchObject({ plannedDays: 27, presentDays: 2, absences: 25, lateCount: 1, lateMinutes: 45, overtimeMinutes: 120, holidayMinutes: 0 });
    expect(p!.lines.map((l) => l.amount)).toEqual([173_000, -160_185, -750, 2400]);
    expect(p!.gross).toBe(14_465);

    const [sal] = s.staff.recordSalaries(ctx, '2026-10', [{ staffId: marc.id, gross: 15_000, attendance: { lines: p!.lines, facts: p!.facts, proposed: p!.gross } }]);
    const slip = s.staff.slip(sal!.id);
    expect(slip.attendance).toMatchObject({ proposed: 14_465, facts: { absences: 25 } });
    expect(slip.attendance!.lines).toHaveLength(4);
  });

  it('compte le journalier à la journée et refuse un tarif négatif', () => {
    const { s, ctx, settings, setNow } = setup('2026-10-01', '07:00');
    settings({ payFromAttendance: true });
    const d = s.staff.save(ctx, { name: 'Jean Manutention', category: 'daily', dailyRate: 2500 });
    expect(d).toMatchObject({ daily_rate: 2500, allowance: 0 });
    expect(() => s.staff.save(ctx, { name: 'X', dailyRate: -1 })).toThrow(/Tarif journalier invalide/);
    setNow('2026-10-10', '20:00');
    for (const day of ['2026-10-02', '2026-10-03', '2026-10-05']) s.punches.correctDay(ctx, d.id, day, { arrived: '08:00', left: '16:00', reason: 'Saisie' });
    const [p] = s.attendance.payProposals(ctx.storeId, '2026-10');
    expect(p!.lines).toEqual([{ code: 'days', label: '3 jours de présence à 2 500 FCFA', amount: 7500 }]);
  });
});

describe('pointeuse à empreinte', () => {
  it('lit le fichier de la pointeuse', () => {
    const logs = parseAttlog('     1\t2026-10-19 07:58:03\t0\t1\t0\t0\n12 2026-10-19 08:01\nn’importe quoi\n');
    expect(logs).toEqual([
      { number: 1, at: at('2026-10-19', '07:58').toISOString().replace(':00.000Z', ':03.000Z'), state: 0 },
      { number: 12, at: at('2026-10-19', '08:01').toISOString(), state: null },
    ]);
  });

  it('note les passages envoyés par la pointeuse, une seule fois même reçus deux fois', () => {
    const { s, ctx, settings, setNow } = setup('2026-10-19', '18:00');
    const marie = s.staff.save(ctx, { name: 'Marie Ngo', category: 'daily' });
    expect(marie.punch_number).toBe(1);
    const text = '1\t2026-10-19 07:58:03\t0\t1\n  1\t2026-10-19 17:02:00\t1\t1\n1\t2026-10-19 17:03:00\t1\t1\n99\t2026-10-19 08:00:00\t0\t1\ngarbage\n';
    expect(() => s.fingerprint.record(ctx.storeId, text, { serial: 'CQZ7232460123' })).toThrow(/pas activée/);
    settings({ fingerprint: true });
    // Le second passage à 17:03 est un double passage (moins de 2 minutes).
    expect(s.fingerprint.record(ctx.storeId, text, { serial: 'CQZ7232460123' })).toEqual({ added: 2, duplicates: 1, unknown: [99], inactive: 0, unreadable: 1 });
    expect(s.fingerprint.devices(ctx.storeId)).toMatchObject([{ serial: 'CQZ7232460123', name: 'Pointeuse 1', active: 1 }]);
    // Le même fichier repris de la clé USB : rien de nouveau.
    expect(s.fingerprint.record(ctx.storeId, text)).toMatchObject({ added: 0, duplicates: 3 });
    const [day] = s.punches.days(marie.id, '2026-10-19', '2026-10-19');
    expect(day).toMatchObject({ minutes: 544, methods: ['fingerprint'], sessions: 1 });
    // Pointeuse retirée : plus écoutée. Heure dans le futur : ignorée.
    const dev = s.fingerprint.devices(ctx.storeId)[0]!;
    const main = s.personnel.mainEntrance(ctx);
    expect(s.fingerprint.saveDevice(ctx, dev.id, { name: 'Porte principale', entranceId: main.id })).toMatchObject({ entrance_name: 'Entrée principale' });
    setNow('2026-10-20', '08:00');
    expect(s.fingerprint.record(ctx.storeId, '1\t2026-10-20 07:55:00\n1\t2026-10-21 07:55:00', { serial: 'CQZ7232460123' })).toMatchObject({ added: 1, unreadable: 1 });
    expect(s.punches.last(marie.id)).toMatchObject({ kind: 'in', entrance_id: main.id, station: 'CQZ7232460123' });
    s.fingerprint.saveDevice(ctx, dev.id, { name: 'Porte principale', active: false });
    expect(s.fingerprint.record(ctx.storeId, '1\t2026-10-20 12:00:00', { serial: 'CQZ7232460123' }).added).toBe(0);
  });
});

describe('alertes et avertissements', () => {
  it('signale le retard puis l’absence une seule fois, et le responsable les traite', () => {
    const { s, ctx, settings, setNow } = setup('2026-10-19', '07:00');
    settings({ staffTeams: true, contractorStaff: true });
    const jour = s.personnel.saveTeam(ctx, { name: 'Jour', start: '08:00', end: '17:00', days: '0123456' });
    const agency = s.personnel.saveAgency(ctx, { name: 'Sécurité Plus', phone: '699 11 22 33' });
    const ali = s.staff.save(ctx, { name: 'Ali Moussa', position: 'Vigile', category: 'contractor', agencyId: agency.id });
    s.personnel.setTeam(ctx, ali.id, { teamId: jour.id });
    setNow('2026-10-19', '08:45');
    expect(s.staffWatch.scan(ctx.storeId)).toEqual([]);
    settings({ staffAlerts: true, alertLateMinutes: 30 });
    setNow('2026-10-19', '08:20');
    expect(s.staffWatch.scan(ctx.storeId)).toEqual([]);
    setNow('2026-10-19', '08:45');
    const [late] = s.staffWatch.scan(ctx.storeId);
    expect(late).toMatchObject({ kind: 'late', minutes: 45, staff_name: 'Ali Moussa', agency_phone: '699 11 22 33' });
    expect(late!.text).toBe('Retard : Ali Moussa (Vigile, Sécurité Plus), attendu à 08:00, toujours pas là après 45 min.');
    expect(s.staffWatch.scan(ctx.storeId)).toEqual([]);
    setNow('2026-10-19', '17:30');
    const [absent] = s.staffWatch.scan(ctx.storeId);
    expect(absent).toMatchObject({ kind: 'absent', id: `absent:${ali.id}:2026-10-19` });
    s.staffWatch.handle(ctx, absent!.id);
    expect(s.staffWatch.alerts(ctx.storeId).map((a) => [a.kind, Boolean(a.handled_at), a.handler_name])).toEqual([
      ['absent', true, 'Steve'],
      ['late', false, null],
    ]);
  });

  it('propose un avertissement après trop de retards, et le garde au dossier', () => {
    const { s, ctx, settings, setNow } = setup('2026-10-01', '07:00');
    settings({ staffTeams: true, warnLateCount: 2 });
    const jour = s.personnel.saveTeam(ctx, { name: 'Jour', start: '08:00', end: '17:00', days: '0123456' });
    const luc = s.staff.save(ctx, { name: 'Luc Tchoua', hiredOn: '2026-10-01' });
    s.personnel.setTeam(ctx, luc.id, { teamId: jour.id });
    setNow('2026-10-10', '20:00');
    for (const day of ['2026-10-05', '2026-10-06']) s.punches.correctDay(ctx, luc.id, day, { arrived: '08:40', left: '17:00', reason: 'Saisie' });
    const rows = s.attendance.month(ctx.storeId, '2026-10');
    expect(s.staffWatch.suggestions(ctx.storeId, rows, '2026-10')).toEqual([{ staff_id: luc.id, name: 'Luc Tchoua', late: 2, late_minutes: 80 }]);
    expect(() => s.staffWatch.addWarning(ctx, luc.id, { day: '2026-10-10', kind: 'written', reason: ' ' })).toThrow(/motif/);
    const w = s.staffWatch.addWarning(ctx, luc.id, { day: '2026-10-10', kind: 'written', reason: 'Deux retards de 40 minutes' });
    expect(w).toMatchObject({ staff_name: 'Luc Tchoua', kind: 'written', user_name: 'Steve', status: 'active' });
    expect(s.staffWatch.suggestions(ctx.storeId, rows, '2026-10')).toEqual([]);
    s.staffWatch.cancelWarning(ctx, w.id);
    expect(s.staffWatch.warnings(ctx.storeId, { staffId: luc.id })).toEqual([]);
    expect(s.staffWatch.warnings(ctx.storeId, { staffId: luc.id, includeCancelled: true })).toHaveLength(1);
  });
});
