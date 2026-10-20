import { describe, expect, it } from 'vitest';
import { createServices, openDatabase } from '../src';

const setup = (at = '2026-10-20T07:00:00Z') => {
  let now = new Date(at);
  const s = createServices(openDatabase(':memory:'), () => now);
  const { store, register, admin } = s.admin.bootstrap({ storeCode: 'DLA1', storeName: 'Superette Akwa', adminName: 'Steve', adminLogin: 'steve', adminPin: '1234' });
  return { s, store, register, admin, ctx: { storeId: store.id, registerId: register.id, userId: admin.id }, setNow: (iso: string) => (now = new Date(iso)) };
};

describe('fiche utilisateur : identifiant modifiable et suppression', () => {
  it("change l'identifiant, refuse un identifiant pris ou invalide", () => {
    const { s, store, admin } = setup();
    const awa = s.admin.createUser(admin.id, { name: 'Awa', login: 'awa', pin: '5678', role: 'cashier', storeId: store.id });
    s.admin.createUser(admin.id, { name: 'Paul', login: 'paul', pin: '5678', role: 'seller', storeId: store.id });
    expect(() => s.admin.updateUser(admin.id, awa.id, { login: 'Paul' })).toThrow(/déjà utilisé/);
    expect(() => s.admin.updateUser(admin.id, awa.id, { login: 'awa ndiaye' })).toThrow(/Identifiant/);
    expect(s.admin.updateUser(admin.id, awa.id, { login: ' Awa.N ' }).login).toBe('awa.n');
    expect(s.admin.login('awa.n', '5678').id).toBe(awa.id);
    expect(() => s.admin.login('awa', '5678')).toThrow(/incorrect/);
  });

  it("efface un utilisateur qui n'a rien fait, garde pour l'historique celui qui a vendu", () => {
    const { s, store, register, admin } = setup();
    const neuf = s.admin.createUser(admin.id, { name: 'Neuf', login: 'neuf', pin: '5678', role: 'seller', storeId: store.id });
    expect(s.admin.deleteUser(admin.id, neuf.id)).toEqual({ erased: true });
    expect(() => s.admin.getUser(neuf.id)).toThrow(/introuvable/);

    const awa = s.admin.createUser(admin.id, { name: 'Awa', login: 'awa', pin: '5678', role: 'cashier', storeId: store.id, registerId: register.id });
    const ctxAwa = { storeId: store.id, registerId: register.id, userId: awa.id };
    s.pos.openSession(ctxAwa, 0);
    expect(s.admin.deleteUser(admin.id, awa.id)).toEqual({ erased: false });
    expect(s.admin.listUsers().map((u) => u.login)).toEqual(['steve']);
    expect(s.admin.getUser(awa.id)).toMatchObject({ name: 'Awa', active: 0, register_id: null });
    expect(() => s.admin.login('awa', '5678')).toThrow(/incorrect/);
    // L'identifiant est de nouveau libre.
    expect(s.admin.createUser(admin.id, { name: 'Awa 2', login: 'awa', pin: '5678', role: 'cashier', storeId: store.id }).login).toBe('awa');
    expect(() => s.admin.updateUser(admin.id, awa.id, { name: 'X' })).toThrow(/supprimé/);
  });

  it('garde toujours un administrateur et refuse de se supprimer soi-même', () => {
    const { s, admin } = setup();
    expect(() => s.admin.deleteUser(admin.id, admin.id)).toThrow(/propre compte/);
    const boss = s.admin.createUser(admin.id, { name: 'Boss', login: 'boss', pin: '5678', role: 'admin', storeId: null });
    expect(() => s.admin.updateUser(boss.id, admin.id, { active: false })).not.toThrow();
    expect(() => s.admin.deleteUser(admin.id, boss.id)).toThrow(/au moins un administrateur/);
  });
});

describe('badge, nouvel employé et pointage', () => {
  it('crée utilisateur, collaborateur et badge en une fois, puis connecte par le badge', () => {
    const { s, store, register, ctx } = setup();
    const { user, staff } = s.staff.hire(ctx, {
      user: { name: 'Awa Ndiaye', login: 'awa', pin: '5678', role: 'cashier', storeId: store.id, registerId: register.id },
      staff: { position: 'Caissière', phone: '690000000', baseSalary: 60_000, declared: false },
      badge: true,
    });
    expect(user.badge).toMatch(/^FX\d{8}$/);
    expect(staff).toMatchObject({ name: 'Awa Ndiaye', user_id: user.id, base_salary: 60_000, position: 'Caissière' });
    expect(s.admin.loginForBadge(user.badge!.toLowerCase())).toBe('awa');
    expect(s.admin.login(user.badge!, '5678').id).toBe(user.id);
    // Badge refait : l'ancien ne marche plus.
    const next = s.admin.newBadge(ctx.userId, user.id);
    expect(next.badge).not.toBe(user.badge);
    expect(s.admin.loginForBadge(user.badge!)).toBeNull();
    // Un identifiant déjà pris : rien n'est créé.
    const before = s.db.prepare('SELECT COUNT(*) FROM staff').pluck().get();
    expect(() => s.staff.hire(ctx, { user: { name: 'Autre', login: 'awa', pin: '5678', role: 'seller', storeId: store.id }, staff: { baseSalary: 1 } })).toThrow(/déjà utilisé/);
    expect(s.db.prepare('SELECT COUNT(*) FROM staff').pluck().get()).toBe(before);
  });

  it("note l'arrivée une fois, le départ, les retards et les absences du mois", () => {
    // Lundi 5 octobre 2026 : arrivée 08:25 (heure du test), départ 17:00.
    const { s, store, admin, setNow } = setup('2026-10-05T08:25:00');
    s.admin.saveStoreSettings(admin.id, store.id, { workStart: '08:00', lateToleranceMinutes: 10, workDays: '123456' });
    const awa = s.admin.createUser(admin.id, { name: 'Awa', login: 'awa', pin: '5678', role: 'cashier', storeId: store.id });
    s.attendance.arrive(awa.id, store.id);
    setNow('2026-10-05T09:00:00');
    s.attendance.arrive(awa.id, store.id);
    setNow('2026-10-05T17:00:00');
    s.attendance.leave(awa.id, store.id);
    // Mardi 6 : à l'heure (08:05, dans la tolérance).
    setNow('2026-10-06T08:05:00');
    s.attendance.arrive(awa.id, store.id);
    // Mercredi 7 : oubli corrigé par le gérant.
    setNow('2026-10-09T10:00:00');
    expect(() => s.attendance.correct(admin.id, awa.id, '2026-10-07', { arrived: '08:00', left: '16:00', reason: '' })).toThrow(/motif/);
    s.attendance.correct(admin.id, awa.id, '2026-10-07', { arrived: '08:00', left: '16:00', reason: 'badge oublié' });

    const row = s.attendance.month(store.id, '2026-10').find((r) => r.user_id === awa.id)!;
    expect(row.present).toBe(3);
    expect(row.late).toBe(1);
    expect(row.late_minutes).toBe(25);
    expect(row.minutes).toBe(8 * 60 + 35 + 8 * 60);
    // Du jeudi 1er au jeudi 8, sans les dimanches : absent les 1, 2, 3 et 8.
    expect(row.absences).toEqual(['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-08']);
    expect(row.days.find((d) => d.day === '2026-10-07')).toMatchObject({ corrected: true, correction_reason: 'badge oublié' });
  });

  it('fusionne le pointage reçu de deux PC : première arrivée, dernier départ', () => {
    const { s, store, admin } = setup('2026-10-05T08:30:00');
    const awa = s.admin.createUser(admin.id, { name: 'Awa', login: 'awa', pin: '5678', role: 'cashier', storeId: store.id });
    s.attendance.arrive(awa.id, store.id);
    const id = `${awa.id}:2026-10-05`;
    s.sync.applyRemote([
      {
        id: 'e1',
        entity: 'attendance',
        entityId: id,
        op: 'upsert',
        storeId: store.id,
        registerId: null,
        createdAt: '2026-10-05T18:00:00Z',
        payload: { id, store_id: store.id, user_id: awa.id, day: '2026-10-05', arrived_at: new Date('2026-10-05T07:55:00').toISOString(), left_at: new Date('2026-10-05T18:00:00').toISOString(), corrected_by: null, correction_reason: null, updated_at: '2026-10-05T18:00:00.000Z' },
      },
    ]);
    const merged = s.attendance.get(awa.id, '2026-10-05')!;
    expect(merged.arrived_at).toBe(new Date('2026-10-05T07:55:00').toISOString());
    expect(merged.left_at).toBe(new Date('2026-10-05T18:00:00').toISOString());
  });
});
