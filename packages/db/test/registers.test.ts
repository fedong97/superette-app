import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { type Context, type Services, createServices, migrate, openDatabase } from '../src';
import { MIGRATIONS } from '../src/schema';

let s: Services;
let ctx: Context;
let riz: string;
let adminId: string;

beforeEach(() => {
  s = createServices(openDatabase(':memory:'));
  const { store, register, admin } = s.admin.bootstrap({ storeCode: 'DLA1', storeName: 'Superette Akwa', adminName: 'Steve', adminLogin: 'steve', adminPin: '1234' });
  adminId = admin.id;
  ctx = { storeId: store.id, registerId: register.id, userId: admin.id };
  const tva = s.admin.listVatRates()[0]!.id;
  riz = s.catalogue.saveArticle(admin.id, { name: 'Riz 5 kg', unit: 'piece', vatRateId: tva, purchasePrice: 3_000, salePrice: 5_000 }).id;
  s.stock.receive(ctx, { warehouseId: s.admin.salesWarehouse(store.id).id, lines: [{ articleId: riz, qty: 20_000, unitCost: 3_000 }] });
});

describe('caisses attribuées aux utilisateurs', () => {
  it('attribue une caisse à la création et à la modification, refuse une caisse désactivée', () => {
    const c2 = s.admin.createRegister(adminId, ctx.storeId, 'Caisse boissons');
    const paul = s.admin.createUser(adminId, { name: 'Paul', login: 'paul', pin: '3333', role: 'seller', storeId: ctx.storeId, registerId: c2.id });
    expect(paul.register_id).toBe(c2.id);
    expect(s.admin.registerUsers(c2.id).map((u) => u.name)).toEqual(['Paul']);
    expect(s.admin.updateUser(adminId, paul.id, { name: 'Paul Etoa' }).register_id).toBe(c2.id);
    expect(s.admin.updateUser(adminId, paul.id, { registerId: null }).register_id).toBeNull();

    s.admin.updateRegister(adminId, c2.id, { name: 'Boissons', active: false });
    expect(s.admin.getRegister(c2.id)).toMatchObject({ name: 'Boissons', active: 0 });
    expect(() => s.admin.updateUser(adminId, paul.id, { registerId: c2.id })).toThrow(/désactivée/);
  });

  it('ne désactive pas une caisse ouverte', () => {
    s.pos.openSession(ctx, 10_000);
    expect(() => s.admin.updateRegister(adminId, ctx.registerId!, { active: false })).toThrow(/Clôturez/);
  });

  it('reprend la numérotation après les tickets faits sur un autre PC', () => {
    s.pos.openSession(ctx, 10_000);
    const sell = () => s.pos.completeSale(ctx, { lines: [{ articleId: riz, qty: 1000 }], payments: [{ method: 'CASH', amount: 5_000 }] }).number;
    expect(sell()).toBe('DLA1-1-000001');
    // Ce PC n'a jamais compté les tickets 2 à 7, faits ailleurs sur la même caisse et reçus par synchronisation.
    s.db.prepare("UPDATE sales SET number = 'DLA1-1-000007'").run();
    expect(sell()).toBe('DLA1-1-000008');
  });

  it('à la mise à jour, chaque caissier garde la caisse de sa dernière vente', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
    for (const m of MIGRATIONS.filter((x) => x.version <= 17)) {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations VALUES (?, ?, ?)').run(m.version, m.name, '2026-01-01');
    }
    db.exec(`INSERT INTO stores (id, code, name, created_at) VALUES ('st', 'DLA1', 'Akwa', '2026-01-01');
      INSERT INTO registers (id, store_id, number, name, activation_code) VALUES ('r1', 'st', 1, 'Caisse 1', '111111'), ('r2', 'st', 2, 'Caisse 2', '222222');
      INSERT INTO users (id, name, login, pin_hash, role, created_at) VALUES
        ('awa', 'Awa', 'awa', 'x', 'cashier', '2026-01-01'), ('neuf', 'Neuf', 'neuf', 'x', 'cashier', '2026-01-01'), ('gerant', 'Mireille', 'mireille', 'x', 'manager', '2026-01-01');
      INSERT INTO cash_sessions (id, store_id, register_id, user_id, opened_at, opening_float, status) VALUES ('cs1', 'st', 'r1', 'awa', '2026-01-01', 0, 'closed'), ('cs2', 'st', 'r2', 'awa', '2026-01-02', 0, 'open');`);
    const sale = db.prepare(
      `INSERT INTO sales (id, number, kind, store_id, register_id, session_id, user_id, status, total_ttc, total_ht, total_tva, total_discount, created_at)
       VALUES (?, ?, 'sale', 'st', ?, ?, ?, 'completed', 0, 0, 0, 0, ?)`,
    );
    sale.run('v1', 'A-1', 'r1', 'cs1', 'awa', '2026-01-01T10:00:00Z');
    sale.run('v2', 'A-2', 'r2', 'cs2', 'awa', '2026-01-02T10:00:00Z');
    sale.run('v3', 'A-3', 'r2', 'cs2', 'gerant', '2026-01-02T11:00:00Z');
    migrate(db);
    expect(db.prepare('SELECT id, register_id FROM users ORDER BY id').all()).toEqual([
      { id: 'awa', register_id: 'r2' },
      { id: 'gerant', register_id: null },
      { id: 'neuf', register_id: null },
    ]);
  });
});
