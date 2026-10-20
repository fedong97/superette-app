import { describe, expect, it } from 'vitest';
import { createServices, openDatabase } from '../src';

const PHOTO = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';

describe('photo et fiche du badge', () => {
  it("garde la photo de l'employé à part, l'envoie aux autres postes et la retire à la suppression", () => {
    const s = createServices(openDatabase(':memory:'), () => new Date('2026-10-20T10:00:00'));
    const { store, register, admin } = s.admin.bootstrap({ storeCode: 'DLA1', storeName: 'Superette Akwa', adminName: 'Steve', adminLogin: 'steve', adminPin: '1234' });
    const ctx = { storeId: store.id, registerId: register.id, userId: admin.id };
    const { user: paul } = s.staff.hire(ctx, {
      user: { name: 'Paul', login: 'paul', pin: '5678', role: 'seller', storeId: store.id, registerId: null },
      staff: { position: 'Rayon boissons', phone: '6 99 12 34 56', hiredOn: '2024-03-01', baseSalary: 50_000, declared: false },
      badge: true,
    });

    expect(s.admin.userPhoto(paul.id)).toBeNull();
    s.admin.setUserPhoto(admin.id, paul.id, PHOTO);
    expect(s.admin.userPhoto(paul.id)).toBe(PHOTO);
    // Les listes restent légères : la photo n'y est pas.
    expect(s.admin.listUsers().find((u) => u.id === paul.id)).not.toHaveProperty('photo');
    expect(s.sync.serialize('user', paul.id)).toMatchObject({ photo: PHOTO });
    expect(() => s.admin.setUserPhoto(admin.id, paul.id, 'data:text/html;base64,AAAA')).toThrow(/Image invalide/);

    // Matricule, poste, téléphone et date d'entrée viennent de la fiche collaborateur.
    expect(s.staff.forUser(paul.id)).toMatchObject({ position: 'Rayon boissons', phone: '6 99 12 34 56', hired_on: '2024-03-01' });
    expect(s.staff.forUser(paul.id)!.code).toBeTruthy();
    expect(s.staff.forUser(admin.id)).toBeNull();

    // Un autre poste reçoit la photo avec la fiche de l'utilisateur.
    const t = createServices(openDatabase(':memory:'), () => new Date('2026-10-20T10:00:00'));
    t.admin.bootstrap({ storeCode: 'DLA1', storeName: 'Superette Akwa', adminName: 'Steve', adminLogin: 'steve2', adminPin: '1234' });
    t.sync.applyRemote([
      { id: 'e1', entity: 'user', entityId: paul.id, op: 'upsert', storeId: null, registerId: null, createdAt: '2026-10-20T10:00:00Z', payload: s.sync.serialize('user', paul.id)! },
    ]);
    expect(t.admin.userPhoto(paul.id)).toBe(PHOTO);

    s.admin.deleteUser(admin.id, paul.id);
    expect(s.admin.userPhoto(paul.id)).toBeNull();
  });
});
