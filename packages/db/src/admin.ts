import { randomInt } from 'node:crypto';
import { EDITABLE_ROLES, PERMISSIONS, type Permission, TVA_CAMEROUN_NORMAL, roleRights } from '@superette/core';
import { AppError, Base, hashPin, newId, verifyPin } from './util';

export type Role = 'admin' | 'manager' | 'cashier' | 'stock' | 'accountant';

export const ROLE_LABELS: Record<Role, string> = {
  admin: 'Administrateur',
  manager: 'Gérant',
  cashier: 'Caissier',
  stock: 'Magasinier',
  accountant: 'Comptable',
};

export interface User {
  id: string;
  name: string;
  login: string;
  role: Role;
  store_id: string | null;
  active: number;
}

export interface Store {
  id: string;
  code: string;
  name: string;
  address: string | null;
  phone: string | null;
  taxpayer_number: string | null;
  active: number;
}

export interface Register {
  id: string;
  store_id: string;
  number: number;
  name: string;
  activation_code: string;
  activated_at: string | null;
  active: number;
}

export interface Warehouse {
  id: string;
  store_id: string;
  name: string;
  kind: 'shop' | 'reserve' | 'cold';
  is_sales_default: number;
}

export interface BootstrapInput {
  storeCode: string;
  storeName: string;
  address?: string;
  phone?: string;
  taxpayerNumber?: string;
  adminName: string;
  adminLogin: string;
  adminPin: string;
}

/**
 * Administration : magasins, dépôts, caisses, utilisateurs, paramètres.
 * Ajouter un magasin ou une caisse se fait ici, sans développement.
 */
export class AdminService extends Base {
  isInitialized(): boolean {
    return (this.db.prepare('SELECT COUNT(*) FROM stores').pluck().get() as number) > 0;
  }

  /** Premier démarrage : premier magasin, sa caisse n° 1, ses dépôts, l'administrateur, les taux de TVA. */
  bootstrap(input: BootstrapInput): { store: Store; register: Register; admin: User } {
    if (this.isInitialized()) throw new AppError('Application déjà initialisée', 'ALREADY_INITIALIZED');
    return this.tx(() => {
      const now = this.now();
      for (const [label, rate] of [
        ['TVA 19,25 %', TVA_CAMEROUN_NORMAL],
        ['Exonéré', 0],
      ] as const) {
        const id = newId();
        this.db.prepare('INSERT INTO vat_rates (id, label, rate_bp) VALUES (?, ?, ?)').run(id, label, rate);
        this.enqueue(null, 'vat_rate', id, 'upsert', { id, label, rate_bp: rate });
      }
      this.setSetting('scale.prefixes', '21,22');
      this.setSetting('scale.valueType', 'price');
      this.setSetting('currency', 'XAF');
      const adminId = newId();
      this.db
        .prepare('INSERT INTO users (id, name, login, pin_hash, role, store_id, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?)')
        .run(adminId, input.adminName.trim(), input.adminLogin.trim().toLowerCase(), hashPin(input.adminPin), 'admin', now);
      this.enqueue(null, 'user', adminId, 'upsert', this.getUser(adminId));
      const store = this.createStore(adminId, input);
      const register = this.listRegisters(store.id)[0]!;
      this.activateRegister(register.activation_code);
      return { store, register: this.getRegister(register.id), admin: this.getUser(adminId) };
    });
  }

  // --- Paramètres -----------------------------------------------------------

  getSetting(key: string): string | null {
    return (this.db.prepare('SELECT value FROM settings WHERE key = ?').pluck().get(key) as string | undefined) ?? null;
  }

  setSetting(key: string, value: string): void {
    this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  // --- Magasins -------------------------------------------------------------

  listStores(): Store[] {
    return this.db.prepare('SELECT * FROM stores ORDER BY code').all() as Store[];
  }

  getStore(id: string): Store {
    const store = this.db.prepare('SELECT * FROM stores WHERE id = ?').get(id) as Store | undefined;
    if (!store) throw new AppError('Magasin introuvable', 'NOT_FOUND');
    return store;
  }

  /** Crée un magasin avec ses dépôts par défaut (magasin, réserve) et sa caisse n° 1. */
  createStore(
    userId: string,
    input: { storeCode: string; storeName: string; address?: string; phone?: string; taxpayerNumber?: string },
  ): Store {
    const code = input.storeCode.trim().toUpperCase();
    if (!/^[A-Z0-9]{2,6}$/.test(code)) throw new AppError('Code magasin : 2 à 6 lettres ou chiffres', 'INVALID');
    return this.tx(() => {
      const id = newId();
      this.db
        .prepare('INSERT INTO stores (id, code, name, address, phone, taxpayer_number, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(id, code, input.storeName.trim(), input.address ?? null, input.phone ?? null, input.taxpayerNumber ?? null, this.now());
      this.createWarehouse(id, 'Surface de vente', 'shop', true);
      this.createWarehouse(id, 'Réserve', 'reserve', false);
      this.createRegister(userId, id, 'Caisse 1');
      const store = this.getStore(id);
      this.enqueue({ storeId: id, registerId: null }, 'store', id, 'upsert', store);
      this.audit(userId, 'store.create', 'store', id, { code });
      return store;
    });
  }

  updateStore(userId: string, id: string, patch: Partial<Pick<Store, 'name' | 'address' | 'phone' | 'taxpayer_number' | 'active'>>): Store {
    const current = this.getStore(id);
    const next = { ...current, ...patch };
    this.db
      .prepare('UPDATE stores SET name = ?, address = ?, phone = ?, taxpayer_number = ?, active = ? WHERE id = ?')
      .run(next.name, next.address, next.phone, next.taxpayer_number, next.active, id);
    this.enqueue({ storeId: id, registerId: null }, 'store', id, 'upsert', next);
    this.audit(userId, 'store.update', 'store', id, patch);
    return this.getStore(id);
  }

  // --- Dépôts ---------------------------------------------------------------

  createWarehouse(storeId: string, name: string, kind: Warehouse['kind'], salesDefault = false): Warehouse {
    const id = newId();
    this.db
      .prepare('INSERT INTO warehouses (id, store_id, name, kind, is_sales_default) VALUES (?, ?, ?, ?, ?)')
      .run(id, storeId, name, kind, salesDefault ? 1 : 0);
    const wh = this.db.prepare('SELECT * FROM warehouses WHERE id = ?').get(id) as Warehouse;
    this.enqueue({ storeId, registerId: null }, 'warehouse', id, 'upsert', wh);
    return wh;
  }

  listWarehouses(storeId: string): Warehouse[] {
    return this.db
      .prepare('SELECT * FROM warehouses WHERE store_id = ? AND active = 1 ORDER BY is_sales_default DESC, name')
      .all(storeId) as Warehouse[];
  }

  salesWarehouse(storeId: string): Warehouse {
    const wh = this.db
      .prepare('SELECT * FROM warehouses WHERE store_id = ? AND is_sales_default = 1 AND active = 1')
      .get(storeId) as Warehouse | undefined;
    if (!wh) throw new AppError('Aucun dépôt de vente défini pour ce magasin', 'NO_SALES_WAREHOUSE');
    return wh;
  }

  // --- Caisses --------------------------------------------------------------

  listRegisters(storeId: string): Register[] {
    return this.db.prepare('SELECT * FROM registers WHERE store_id = ? ORDER BY number').all(storeId) as Register[];
  }

  getRegister(id: string): Register {
    const reg = this.db.prepare('SELECT * FROM registers WHERE id = ?').get(id) as Register | undefined;
    if (!reg) throw new AppError('Caisse introuvable', 'NOT_FOUND');
    return reg;
  }

  /** Déclare une caisse supplémentaire ; elle s'active sur son PC avec le code renvoyé. */
  createRegister(userId: string, storeId: string, name?: string): Register {
    const number =
      ((this.db.prepare('SELECT MAX(number) FROM registers WHERE store_id = ?').pluck().get(storeId) as number | null) ?? 0) + 1;
    const id = newId();
    const code = String(randomInt(100000, 1000000));
    this.db
      .prepare('INSERT INTO registers (id, store_id, number, name, activation_code) VALUES (?, ?, ?, ?, ?)')
      .run(id, storeId, number, name ?? `Caisse ${number}`, code);
    const reg = this.getRegister(id);
    this.enqueue({ storeId, registerId: null }, 'register', id, 'upsert', reg);
    this.audit(userId, 'register.create', 'register', id, { number });
    return reg;
  }

  /** Active ce PC comme caisse à partir du code donné par l'administration. */
  activateRegister(code: string): Register {
    const reg = this.db
      .prepare('SELECT * FROM registers WHERE activation_code = ? AND active = 1')
      .get(code.trim()) as Register | undefined;
    if (!reg) throw new AppError("Code d'activation inconnu", 'INVALID_CODE');
    this.db.prepare('UPDATE registers SET activated_at = ? WHERE id = ?').run(this.now(), reg.id);
    this.setSetting('station.storeId', reg.store_id);
    this.setSetting('station.registerId', reg.id);
    return this.getRegister(reg.id);
  }

  /** Magasin et caisse de ce PC. */
  station(): { store: Store; register: Register | null } | null {
    const storeId = this.getSetting('station.storeId');
    if (!storeId) return null;
    const registerId = this.getSetting('station.registerId');
    return { store: this.getStore(storeId), register: registerId ? this.getRegister(registerId) : null };
  }

  // --- Utilisateurs ---------------------------------------------------------

  listUsers(): User[] {
    return this.db.prepare('SELECT id, name, login, role, store_id, active FROM users ORDER BY name').all() as User[];
  }

  getUser(id: string): User {
    const user = this.db.prepare('SELECT id, name, login, role, store_id, active FROM users WHERE id = ?').get(id) as User | undefined;
    if (!user) throw new AppError('Utilisateur introuvable', 'NOT_FOUND');
    return user;
  }

  createUser(byUserId: string, input: { name: string; login: string; pin: string; role: Role; storeId: string | null }): User {
    const id = newId();
    try {
      this.db
        .prepare('INSERT INTO users (id, name, login, pin_hash, role, store_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(id, input.name.trim(), input.login.trim().toLowerCase(), hashPin(input.pin), input.role, input.storeId, this.now());
    } catch (e) {
      if (String(e).includes('UNIQUE')) throw new AppError('Identifiant déjà utilisé', 'DUPLICATE');
      throw e;
    }
    const user = this.getUser(id);
    this.enqueue(null, 'user', id, 'upsert', user);
    this.audit(byUserId, 'user.create', 'user', id, { role: input.role });
    return user;
  }

  updateUser(byUserId: string, id: string, patch: { name?: string; role?: Role; storeId?: string | null; active?: boolean; pin?: string }): User {
    const current = this.getUser(id);
    this.db
      .prepare('UPDATE users SET name = ?, role = ?, store_id = ?, active = ? WHERE id = ?')
      .run(
        patch.name ?? current.name,
        patch.role ?? current.role,
        patch.storeId === undefined ? current.store_id : patch.storeId,
        patch.active === undefined ? current.active : patch.active ? 1 : 0,
        id,
      );
    if (patch.pin) this.db.prepare('UPDATE users SET pin_hash = ? WHERE id = ?').run(hashPin(patch.pin), id);
    const user = this.getUser(id);
    this.enqueue(null, 'user', id, 'upsert', user);
    this.audit(byUserId, 'user.update', 'user', id, { ...patch, pin: patch.pin ? '***' : undefined });
    return user;
  }

  login(login: string, pin: string): User {
    const row = this.db
      .prepare('SELECT id, pin_hash FROM users WHERE login = ? AND active = 1')
      .get(login.trim().toLowerCase()) as { id: string; pin_hash: string } | undefined;
    if (!row || !verifyPin(pin, row.pin_hash)) {
      this.audit(null, 'auth.failed', 'user', row?.id, { login });
      throw new AppError('Identifiant ou code incorrect', 'AUTH_FAILED');
    }
    this.audit(row.id, 'auth.login', 'user', row.id);
    return this.getUser(row.id);
  }

  /** Validation superviseur (annulation, retour, remise) par le code d'un gérant. */
  // --- Droits par rôle --------------------------------------------------------

  private savedRights(role: Role): Partial<Record<Permission, boolean>> | null {
    const raw = this.db.prepare('SELECT rights FROM role_rights WHERE id = ?').pluck().get(role) as string | undefined;
    return raw ? (JSON.parse(raw) as Partial<Record<Permission, boolean>>) : null;
  }

  /** Droits effectifs d'un rôle (tous pour l'administrateur). */
  rights(role: Role): Permission[] {
    return roleRights(role, this.savedRights(role));
  }

  hasRight(user: Pick<User, 'role'>, permission: Permission): boolean {
    return this.rights(user.role).includes(permission);
  }

  /** Tableau des droits : chaque rôle réglable et ses droits cochés. */
  rightsMatrix(): { role: Role; label: string; rights: Permission[] }[] {
    return EDITABLE_ROLES.map((role) => ({ role, label: ROLE_LABELS[role], rights: this.rights(role) }));
  }

  /** Enregistre les droits d'un rôle (l'administrateur garde toujours tous les droits). */
  saveRights(userId: string, role: Role, rights: Permission[]): Permission[] {
    if (role === 'admin') throw new AppError("L'administrateur a toujours tous les droits", 'INVALID');
    if (!(EDITABLE_ROLES as Role[]).includes(role)) throw new AppError('Rôle inconnu', 'INVALID');
    const unknown = rights.find((r) => !(r in PERMISSIONS));
    if (unknown) throw new AppError(`Droit inconnu : ${unknown}`, 'INVALID');
    return this.tx(() => {
      const map = Object.fromEntries((Object.keys(PERMISSIONS) as Permission[]).map((k) => [k, rights.includes(k)]));
      const row = { id: role, rights: JSON.stringify(map), updated_at: this.now() };
      this.db
        .prepare('INSERT INTO role_rights (id, rights, updated_at) VALUES (@id, @rights, @updated_at) ON CONFLICT(id) DO UPDATE SET rights = excluded.rights, updated_at = excluded.updated_at')
        .run(row);
      this.enqueue(null, 'role_rights', role, 'upsert', row);
      this.audit(userId, 'admin.rights', 'role', role, { rights });
      return this.rights(role);
    });
  }

  /** Code d'un administrateur ou d'un gérant pour valider une action. */
  authorizeSupervisor(pin: string): User {
    const rows = this.db
      .prepare("SELECT id, pin_hash FROM users WHERE active = 1 AND role IN ('admin', 'manager')")
      .all() as { id: string; pin_hash: string }[];
    const match = rows.find((r) => verifyPin(pin, r.pin_hash));
    if (!match) throw new AppError('Code superviseur refusé', 'SUPERVISOR_DENIED');
    return this.getUser(match.id);
  }

  listVatRates(): { id: string; label: string; rate_bp: number }[] {
    return this.db.prepare('SELECT id, label, rate_bp FROM vat_rates WHERE active = 1 ORDER BY rate_bp DESC').all() as {
      id: string;
      label: string;
      rate_bp: number;
    }[];
  }

  auditLog(limit = 200): { id: string; user_name: string | null; action: string; entity: string | null; entity_id: string | null; details: string | null; at: string }[] {
    return this.db
      .prepare(
        `SELECT a.id, u.name AS user_name, a.action, a.entity, a.entity_id, a.details, a.at
         FROM audit_log a LEFT JOIN users u ON u.id = a.user_id ORDER BY a.at DESC LIMIT ?`,
      )
      .all(limit) as never;
  }
}
