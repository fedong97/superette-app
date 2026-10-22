import { describe, expect, it } from 'vitest';
import { cameroonHolidays, easterSunday, holidaysBetween, mergeStoreSettings, parseHolidays, rotationTeam } from '@superette/core';
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
  return { s, store, register, admin, ctx, settings, setNow: (d: string, h: string) => (now = at(d, h)) };
};

describe('jours fériés et rotations', () => {
  it('calcule Pâques, les fêtes légales du Cameroun et les jours ajoutés', () => {
    expect(easterSunday(2026)).toBe('2026-04-05');
    expect(easterSunday(2027)).toBe('2027-03-28');
    const days = cameroonHolidays(2026).map((h) => h.day);
    expect(days).toEqual(['2026-01-01', '2026-02-11', '2026-04-03', '2026-05-01', '2026-05-14', '2026-05-20', '2026-08-15', '2026-12-25']);
    expect(parseHolidays('2026-03-20 Aïd el-Fitr\n12-31 Saint-Sylvestre')).toEqual([
      { date: '2026-03-20', label: 'Aïd el-Fitr' },
      { date: '12-31', label: 'Saint-Sylvestre' },
    ]);
    expect(() => parseHolidays('20 mars')).toThrow(/illisible/);
    const map = holidaysBetween('2026-12-01', '2027-01-02', { cameroon: true, extra: '12-31 Saint-Sylvestre' });
    expect([...map.keys()]).toEqual(['2026-12-25', '2026-12-31', '2027-01-01']);
    expect(() => mergeStoreSettings(null, { holidaysExtra: 'bientôt' })).toThrow(/illisible/);
  });

  it('fait tourner les équipes semaine après semaine', () => {
    const rot = { teams: ['matin', 'soir', 'nuit'], start: '2026-10-05', weeks: 1 };
    expect(rotationTeam(rot, '2026-10-04')).toBeNull();
    expect(rotationTeam(rot, '2026-10-05')).toBe('matin');
    expect(rotationTeam(rot, '2026-10-12')).toBe('soir');
    expect(rotationTeam(rot, '2026-10-25')).toBe('nuit');
    expect(rotationTeam(rot, '2026-10-26')).toBe('matin');
    expect(rotationTeam({ ...rot, weeks: 2 }, '2026-10-19')).toBe('soir');
  });
});

describe('personnel sans accès au logiciel et borne de pointage', () => {
  it('crée un agent de nettoyage sans compte, lui donne un badge et le pointe à la borne', () => {
    const { s, ctx, settings, setNow } = setup();
    settings({ punchKiosk: true, punchPhoto: true });
    const clean = s.staff.save(ctx, { name: 'Marie Ngo', position: 'Agent de nettoyage', category: 'daily', contractType: 'daily' });
    expect(clean).toMatchObject({ category: 'daily', user_id: null, punch_number: 1 });
    expect(clean.salary_account).toMatch(/^4211/);
    const badge = s.personnel.newBadge(ctx, clean.id);
    expect(badge).toMatch(/^FP\d{8}$/);

    // Arrivée à 07:05, double scan ignoré, départ à 16:00.
    setNow('2026-10-19', '07:05');
    const photo = 'data:image/jpeg;base64,AAAA';
    const a = s.punches.punch(ctx.storeId, { badge: badge.toLowerCase(), photo });
    expect(a).toMatchObject({ duplicate: false, staff: { name: 'Marie Ngo' }, punch: { kind: 'in', method: 'badge', photo } });
    setNow('2026-10-19', '07:06');
    expect(s.punches.punch(ctx.storeId, { badge }).duplicate).toBe(true);
    setNow('2026-10-19', '16:00');
    expect(s.punches.punch(ctx.storeId, { badge }).punch.kind).toBe('out');
    expect(s.punches.presence(ctx.storeId).find((p) => p.staff_id === clean.id)?.state).toBe('left');

    setNow('2026-10-21', '09:00');
    const [row] = s.attendance.month(ctx.storeId, '2026-10', { category: 'daily' });
    expect(row).toMatchObject({ name: 'Marie Ngo', present: 1, role: 'Journalier' });
    expect(row!.days[0]).toMatchObject({ day: '2026-10-19', minutes: 535, sessions: 1, methods: ['badge'], late_minutes: 0 });
    // Le 20 était un jour travaillé sans passage.
    expect(row!.absences).toEqual(['2026-10-20']);
    expect(() => s.punches.punch(ctx.storeId, { badge: 'FP00000000' })).toThrow(/Badge inconnu/);
  });

  it('refuse la borne quand le magasin ne l’a pas activée, et le badge quand seul le code est permis', () => {
    const { s, ctx, settings } = setup();
    const v = s.staff.save(ctx, { name: 'Paul Vigile' });
    const badge = s.personnel.newBadge(ctx, v.id);
    expect(() => s.punches.punch(ctx.storeId, { badge })).toThrow(/borne de pointage n’est pas activée/);
    settings({ punchKiosk: true, punchBadge: false, punchPin: true });
    expect(() => s.punches.punch(ctx.storeId, { badge })).toThrow(/badge n’est pas activé/);
    expect(() => s.punches.punch(ctx.storeId, { number: v.punch_number, pin: '1234' })).toThrow(/Pas encore de code/);
    s.personnel.setPunchPin(ctx, v.id, '4321');
    expect(() => s.punches.punch(ctx.storeId, { number: v.punch_number, pin: '1111' })).toThrow(/incorrect/);
    expect(s.punches.punch(ctx.storeId, { number: v.punch_number, pin: '4321' }).punch).toMatchObject({ kind: 'in', method: 'pin' });
    // Cinq codes faux de suite bloquent le numéro.
    for (let i = 0; i < 5; i++) expect(() => s.punches.punch(ctx.storeId, { number: v.punch_number, pin: '0000' })).toThrow();
    expect(() => s.punches.punch(ctx.storeId, { number: v.punch_number, pin: '4321' })).toThrow(/Trop de codes faux/);
  });

  it('agents d’une société de gardiennage : pas de sous-comptes, pas de salaire, mais pointés', () => {
    const { s, ctx, settings } = setup();
    settings({ punchKiosk: true, contractorStaff: true });
    expect(() => s.staff.save(ctx, { name: 'Garde 1', category: 'contractor' })).toThrow(/société prestataire/);
    const agency = s.personnel.saveAgency(ctx, { name: 'Sécurité Plus', kind: 'Gardiennage', phone: '699000000', contractEnd: '2026-11-10' });
    const guard = s.staff.save(ctx, { name: 'Garde 1', category: 'contractor', agencyId: agency.id, position: 'Vigile' });
    expect(guard).toMatchObject({ salary_account: '', advance_account: '', agency_name: 'Sécurité Plus' });
    expect(s.staff.month(ctx.storeId, '2026-10').map((r) => r.staff.name)).not.toContain('Garde 1');
    expect(s.personnel.agencies(ctx.storeId)[0]).toMatchObject({ name: 'Sécurité Plus', agents: 1 });
    expect(() => s.personnel.saveAgency(ctx, { name: 'Sécurité Plus', active: false }, agency.id)).toThrow(/encore actifs/);
    // Fin du contrat de prestation dans 22 jours : signalée.
    expect(s.personnel.alerts(ctx.storeId)).toEqual([expect.objectContaining({ kind: 'agency', name: 'Sécurité Plus', days: 22 })]);
    // Devenu employé : il reçoit ses sous-comptes.
    const hired = s.staff.save(ctx, { name: 'Garde 1', category: 'employee' }, guard.id);
    expect(hired.salary_account).toMatch(/^4211/);
    expect(hired.agency_id).toBeNull();
  });

  it('garde de nuit en équipe : la présence compte pour le jour où elle commence', () => {
    const { s, ctx, settings, setNow } = setup('2026-10-19', '21:00');
    settings({ punchKiosk: true, staffTeams: true });
    const nuit = s.personnel.saveTeam(ctx, { name: 'Nuit', start: '22:00', end: '06:00', days: '0123456', tolerance: 15 });
    expect(nuit).toMatchObject({ overnight: true, minutes: 480 });
    const guard = s.staff.save(ctx, { name: 'Ali Vigile' });
    s.personnel.setTeam(ctx, guard.id, { teamId: nuit.id });
    const badge = s.personnel.newBadge(ctx, guard.id);
    setNow('2026-10-19', '22:30');
    expect(s.punches.punch(ctx.storeId, { badge })).toMatchObject({ late_minutes: 30, expected: '22:00' });
    setNow('2026-10-20', '06:10');
    expect(s.punches.punch(ctx.storeId, { badge }).punch.kind).toBe('out');
    const days = s.punches.days(guard.id, '2026-10-19', '2026-10-20');
    expect(days).toEqual([expect.objectContaining({ day: '2026-10-19', minutes: 460, late_minutes: 30, early_minutes: 0 })]);
    // Le 20 au soir, à 22:10, il est « attendu » (dans la tolérance) ; à 22:20, « en retard ».
    setNow('2026-10-20', '22:10');
    expect(s.punches.presence(ctx.storeId)[0]).toMatchObject({ state: 'expected', expected_start: '22:00', team: 'Nuit' });
    setNow('2026-10-20', '22:20');
    expect(s.punches.presence(ctx.storeId)[0]).toMatchObject({ state: 'late', late_minutes: 20 });
  });

  it('rotation entre deux équipes et jour férié : ni absence ni heures prévues', () => {
    const { s, ctx, settings, setNow } = setup('2026-12-21', '08:00');
    settings({ staffTeams: true });
    const matin = s.personnel.saveTeam(ctx, { name: 'Matin', start: '06:00', end: '14:00', days: '123456' });
    const soir = s.personnel.saveTeam(ctx, { name: 'Soir', start: '14:00', end: '22:00', days: '123456' });
    const p = s.staff.save(ctx, { name: 'Awa' });
    expect(() => s.personnel.setTeam(ctx, p.id, { rotation: { teams: [matin.id], start: '2026-12-21', weeks: 1 } })).toThrow(/au moins deux/);
    s.personnel.setTeam(ctx, p.id, { rotation: { teams: [matin.id, soir.id], start: '2026-12-21', weeks: 1 } });
    expect(s.personnel.plan(p.id, '2026-12-22').shift?.team).toBe('Matin');
    expect(s.personnel.plan(p.id, '2026-12-29').shift?.team).toBe('Soir');
    expect(s.personnel.plan(p.id, '2026-12-25')).toEqual({ shift: null, holiday: 'Noël' });
    setNow('2027-01-03', '12:00');
    const [row] = s.attendance.month(ctx.storeId, '2026-12');
    expect(row!.holidays).toContain('2026-12-25');
    expect(row!.absences).not.toContain('2026-12-25');
    expect(row!.absences).toContain('2026-12-24');
  });

  it('le gérant corrige une journée : les passages sont gardés annulés, remplacés par les siens', () => {
    const { s, ctx, settings, setNow } = setup();
    settings({ punchKiosk: true });
    const p = s.staff.save(ctx, { name: 'Jean' });
    const badge = s.personnel.newBadge(ctx, p.id);
    setNow('2026-10-19', '07:55');
    s.punches.punch(ctx.storeId, { badge });
    setNow('2026-10-20', '10:00');
    // Départ oublié.
    expect(s.punches.days(p.id, '2026-10-19', '2026-10-19')[0]).toMatchObject({ open: true, minutes: 0 });
    expect(() => s.punches.correctDay(ctx, p.id, '2026-10-19', { arrived: '07:55', left: '17:00', reason: '' })).toThrow(/motif/);
    const day = s.punches.correctDay(ctx, p.id, '2026-10-19', { arrived: '07:55', left: '17:00', reason: 'Badge oublié au départ' });
    expect(day).toMatchObject({ minutes: 545, corrected: true, correction_reason: 'Badge oublié au départ', open: false });
    const all = s.punches.dayPunches(p.id, '2026-10-19');
    expect(all.map((x) => [x.kind, x.method, x.status])).toEqual([
      ['in', 'badge', 'cancelled'],
      ['in', 'manual', 'active'],
      ['out', 'manual', 'active'],
    ]);
    // Le passage d'aujourd'hui commence une nouvelle présence.
    expect(s.punches.punch(ctx.storeId, { badge }).punch.kind).toBe('in');
  });

  it('pointage à la connexion : désactivable, et noté dans les passages de la fiche', () => {
    const { s, store, register, ctx, settings, setNow } = setup();
    const { user, staff } = s.staff.hire(ctx, {
      user: { name: 'Awa Caisse', login: 'awa', pin: '5678', role: 'cashier', storeId: store.id, registerId: register.id },
      staff: { position: 'Caissière', baseSalary: 60_000, declared: false },
      badge: true,
    });
    setNow('2026-10-19', '08:20');
    s.attendance.arrive(user.id, store.id);
    setNow('2026-10-19', '17:00');
    s.attendance.leave(user.id, store.id);
    setNow('2026-10-19', '17:30');
    s.attendance.leave(user.id, store.id);
    const [day] = s.punches.days(staff!.id, '2026-10-19', '2026-10-19');
    expect(day).toMatchObject({ minutes: 550, late_minutes: 20, methods: ['login'] });
    // Le badge FX de l'utilisateur pointe aussi à la borne.
    settings({ punchKiosk: true, punchLogin: false });
    setNow('2026-10-20', '07:58');
    expect(s.attendance.arrive(user.id, store.id)).toBeNull();
    expect(s.punches.punch(store.id, { badge: user.badge! })).toMatchObject({ staff: { id: staff!.id }, punch: { kind: 'in', method: 'badge' } });
  });

  it('entrées, pièces du dossier et fin de contrat', () => {
    const { s, ctx, settings } = setup();
    settings({ punchKiosk: true, multiEntrances: true });
    const main = s.personnel.saveEntrance(ctx, { name: 'Entrée principale' });
    const back = s.personnel.saveEntrance(ctx, { name: 'Porte du dépôt' });
    expect(() => s.personnel.saveEntrance(ctx, { name: 'porte du dépôt' })).toThrow(/existe déjà/);
    s.personnel.saveEntrance(ctx, { name: 'Porte du dépôt', active: false }, back.id);
    expect(() => s.personnel.saveEntrance(ctx, { name: 'Entrée principale', active: false }, main.id)).toThrow(/au moins une entrée/);
    const p = s.staff.save(ctx, { name: 'Luc', contractType: 'cdd', hiredOn: '2026-05-01', contractEnd: '2026-11-01' });
    const doc = s.personnel.addDocument(ctx, p.id, { label: 'CNI', data: 'data:image/jpeg;base64,AAAA', expiresOn: '2026-10-30' });
    expect(s.personnel.documents(p.id)).toEqual([expect.objectContaining({ id: doc.id, label: 'CNI' })]);
    expect(s.personnel.alerts(ctx.storeId).map((a) => [a.kind, a.days])).toEqual([
      ['document', 11],
      ['contract', 13],
    ]);
    s.personnel.removeDocument(ctx, doc.id);
    expect(s.personnel.documents(p.id)).toEqual([]);
    const badge = s.personnel.newBadge(ctx, p.id);
    expect(s.punches.punch(ctx.storeId, { badge, entranceId: main.id }).punch.entrance_id).toBe(main.id);
  });
});
