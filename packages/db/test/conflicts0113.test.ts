import { beforeEach, describe, expect, it } from 'vitest';
import { type Services, createServices, openDatabase } from '../src';

/** Contre-expertise de l'audit (0.113.0) : conflits de synchronisation à résoudre, diagnostic sans secret. */
describe('conflits de synchronisation', () => {
  let pc1: Services;
  let pc2: Services;
  let admin: string;

  const boot = (s: Services) => s.admin.bootstrap({ storeCode: 'DLA1', storeName: 'Superette Akwa', adminName: 'Steve', adminLogin: 'steve', adminPin: '1234' }).admin.id;
  const article = (s: Services, user: string, name: string, code: string) =>
    s.catalogue.saveArticle(user, { name, unit: 'piece', vatRateId: s.admin.listVatRates()[0]!.id, purchasePrice: 400, salePrice: 600, barcodes: [{ code }] });

  beforeEach(() => {
    pc1 = createServices(openDatabase(':memory:'));
    pc2 = createServices(openDatabase(':memory:'));
    admin = boot(pc1);
    boot(pc2);
  });

  /** Article créé sur le PC 2 avec un code-barres que le PC 1 a déjà donné à un autre article. */
  const conflict = () => {
    const local = article(pc1, admin, 'Biscuit local', '6001234500001');
    const remote = article(pc2, pc2.admin.listUsers()[0]!.id, 'Biscuit du PC 2', '6001234500001');
    const r = pc1.sync.applyRemote([
      { id: 'evt-1', entity: 'article', entityId: remote.id, op: 'upsert', storeId: null, registerId: null, createdAt: new Date().toISOString(), payload: pc2.sync.serialize('article', remote.id) },
    ]);
    expect(r.conflicts).toBe(1);
    return { local, remote, id: pc1.sync.conflicts()[0]!.id };
  };
  const attention = () => pc1.attention.list(pc1.admin.station()!.store.id, new Set(['sync_conflicts']))[0]!;

  it('réessaie après correction de la cause : appliqué, le compteur revient à 0', () => {
    const { local, remote, id } = conflict();
    expect(attention()).toMatchObject({ count: 1, tone: 'warning' });
    expect(pc1.sync.state().conflicts).toBe(1);
    // Toujours en échec tant que la cause est là : le conflit reste, sans doublon.
    expect(pc1.sync.retryConflict(admin, id).ok).toBe(false);
    expect(pc1.sync.conflicts()).toHaveLength(1);
    // Le gérant corrige l'article du PC 1 (autre code article, code-barres retiré), puis réessaie.
    pc1.db.prepare("UPDATE articles SET code = 'A-LOCAL-1' WHERE id = ?").run(local.id);
    pc1.db.prepare('DELETE FROM barcodes WHERE article_id = ?').run(local.id);
    expect(pc1.sync.retryConflict(admin, id)).toEqual({ ok: true, message: null });
    expect(pc1.db.prepare('SELECT name FROM articles WHERE id = ?').pluck().get(remote.id)).toBe('Biscuit du PC 2');
    expect(pc1.sync.conflicts()).toEqual([]);
    expect(attention().count).toBe(0);
    expect(pc1.admin.auditLog(20).map((a) => a.action)).toContain('sync.conflict_retried');
    expect(() => pc1.sync.retryConflict(admin, id)).toThrow(/déjà résolu/);
  });

  it('ignore avec un motif obligatoire, gardé au journal', () => {
    const { id } = conflict();
    expect(() => pc1.sync.ignoreConflict(admin, id, '  ')).toThrow(/Indiquez pourquoi/);
    pc1.sync.ignoreConflict(admin, id, 'Doublon créé par erreur sur le PC 2');
    expect(pc1.sync.state().conflicts).toBe(0);
    const row = pc1.db.prepare('SELECT resolution, resolved_by FROM sync_conflicts WHERE id = ?').get(id);
    expect(row).toEqual({ resolution: 'Ignoré : Doublon créé par erreur sur le PC 2', resolved_by: admin });
    expect(pc1.sync.diagnostic().conflicts).toMatchObject({ open: 0, resolved: 1 });
  });

  it('le diagnostic ne contient ni jeton ni code', () => {
    conflict();
    pc1.sync.saveCredentials('http://serveur:3000', 'appareil-1', 'jeton-secret-tres-long');
    const text = JSON.stringify(pc1.sync.diagnostic());
    expect(text).not.toContain('jeton-secret-tres-long');
    expect(text).not.toContain('1234');
    expect(JSON.parse(text)).toMatchObject({ server: 'http://serveur:3000', connected: true, conflicts: { open: 1 }, pendingByEntity: expect.any(Array) });
  });
});
