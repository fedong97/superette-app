import { randomInt } from 'node:crypto';
import {
  EDITABLE_ROLES,
  PERMISSIONS,
  type Permission,
  type RegisterKind,
  type StoreSettings,
  TVA_CAMEROUN_NORMAL,
  type UserPrivileges,
  mergeStoreSettings,
  parseStoreSettings,
  roleRights,
  userRights,
} from '@superette/core';
import { AppError, Base, hashPin, newId, verifyPin } from './util';

/** Durée du blocage après trop de codes faux. */
const LOCK_MINUTES = 15;

export type Role = 'admin' | 'manager' | 'cashier' | 'seller' | 'buyer' | 'stock' | 'accountant';

export const ROLE_LABELS: Record<Role, string> = {
  admin: 'Administrateur',
  manager: 'Gérant',
  cashier: 'Caissier',
  seller: 'Vendeur',
  buyer: "Responsable d'achat (appro)",
  stock: 'Magasinier',
  accountant: 'Comptable',
};

export interface User {
  id: string;
  name: string;
  login: string;
  role: Role;
  store_id: string | null;
  /** Caisse espèces attribuée : l'utilisateur y vend depuis n'importe quel PC. */
  register_id: string | null;
  /** Caisse électronique (Mobile Money, carte) qui reçoit ses paiements électroniques. */
  emoney_register_id: string | null;
  /** Caisse banque (virements, chèques) qui reçoit ses paiements bancaires. */
  bank_register_id: string | null;
  /** Dépôts où il vend et complète une ligne (JSON d'ids) ; null = selon son droit « vendre depuis un autre dépôt ». */
  sale_warehouses: string | null;
  active: number;
}

export const REGISTER_KINDS: Record<RegisterKind, string> = {
  cash: 'Espèces',
  electronic: 'Électronique (Mobile Money, carte)',
  bank: 'Banque (virement, chèque)',
};

/** Caisses attribuées à un utilisateur, une de chaque type au plus. */
export interface UserRegisters {
  registerId?: string | null;
  emoneyRegisterId?: string | null;
  bankRegisterId?: string | null;
}

export interface Store {
  id: string;
  code: string;
  name: string;
  address: string | null;
  phone: string | null;
  taxpayer_number: string | null;
  active: number;
  /** Assujetti à la TVA (régime réel) ; sinon les ventes se font sans TVA. */
  vat_enabled: number;
  /** Vente permise sans stock : le stock passe en négatif et se régularise à la réception. */
  ignore_stock: number;
  /** Écart de clôture (FCFA) au-delà duquel motif et code du gérant sont demandés. */
  cash_gap_threshold: number;
  /** Paramètres du magasin (JSON) : lire avec `storeSettings`. */
  settings: string | null;
}

/** Options du magasin réglées par le gérant ou l'administrateur. */
export interface StoreOptions {
  vatEnabled?: boolean;
  ignoreStock?: boolean;
  cashGapThreshold?: number;
}

export interface Register {
  id: string;
  store_id: string;
  number: number;
  name: string;
  activation_code: string;
  activated_at: string | null;
  active: number;
  kind: RegisterKind;
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
  /** Magasin assujetti à la TVA (oui si absent, comme avant cette option). */
  vatEnabled?: boolean;
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
      if (input.vatEnabled === false) this.setStoreOptions(adminId, store.id, { vatEnabled: false });
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

  /**
   * TVA, vente sans stock et seuil d'écart de caisse. Changer la TVA ne vaut que
   * pour les ventes et achats suivants : les pièces passées gardent la leur.
   */
  setStoreOptions(userId: string, id: string, options: StoreOptions): Store & { articlesExempted?: number } {
    const current = this.getStore(id);
    const threshold = options.cashGapThreshold ?? current.cash_gap_threshold;
    if (!Number.isSafeInteger(threshold) || threshold < 0) throw new AppError("Seuil d'écart invalide", 'INVALID');
    const next = {
      vat_enabled: options.vatEnabled === undefined ? current.vat_enabled : options.vatEnabled ? 1 : 0,
      ignore_stock: options.ignoreStock === undefined ? current.ignore_stock : options.ignoreStock ? 1 : 0,
      cash_gap_threshold: threshold,
    };
    this.tx(() => {
      this.db.prepare('UPDATE stores SET vat_enabled = ?, ignore_stock = ?, cash_gap_threshold = ? WHERE id = ?').run(next.vat_enabled, next.ignore_stock, next.cash_gap_threshold, id);
      this.enqueue({ storeId: id, registerId: null }, 'store', id, 'upsert', this.getStore(id));
      this.audit(userId, 'store.options', 'store', id, options);
    });
    // TVA désactivée : les articles passent à « Exonéré », sauf si un autre magasin reste assujetti
    // (les articles sont communs à tous les magasins).
    if (current.vat_enabled === 1 && next.vat_enabled === 0) {
      const vatStores = this.db.prepare('SELECT COUNT(*) FROM stores WHERE active = 1 AND vat_enabled = 1').pluck().get() as number;
      if (vatStores === 0) return { ...this.getStore(id), articlesExempted: this.setArticlesRate(userId, 'exempt') };
    }
    return this.getStore(id);
  }

  /** Taux « Exonéré » (0 %), créé s'il manque. */
  exemptRateId(): string {
    const id = this.db.prepare('SELECT id FROM vat_rates WHERE rate_bp = 0 AND active = 1 ORDER BY id LIMIT 1').pluck().get() as string | undefined;
    if (id) return id;
    const created = newId();
    this.db.prepare('INSERT INTO vat_rates (id, label, rate_bp) VALUES (?, ?, 0)').run(created, 'Exonéré');
    this.enqueue(null, 'vat_rate', created, 'upsert', { id: created, label: 'Exonéré', rate_bp: 0 });
    return created;
  }

  /** Vrai si le magasin vend sans TVA (régime simplifié). */
  vatDisabled(storeId: string): boolean {
    return this.getStore(storeId).vat_enabled !== 1;
  }

  /**
   * Taux de tous les articles d'un coup : « exempt » met les articles taxés à Exonéré
   * (TVA désactivée), « standard » remet les exonérés à 19,25 % (TVA réactivée).
   */
  setArticlesRate(userId: string, mode: 'exempt' | 'standard'): number {
    return this.tx(() => {
      const exempt = this.exemptRateId();
      let target = exempt;
      if (mode === 'standard') {
        const standard = this.db.prepare('SELECT id FROM vat_rates WHERE rate_bp = ? AND active = 1 LIMIT 1').pluck().get(TVA_CAMEROUN_NORMAL) as string | undefined;
        if (!standard) throw new AppError('Taux de TVA 19,25 % introuvable', 'NOT_FOUND');
        target = standard;
      }
      const ids = this.db
        .prepare(`SELECT a.id FROM articles a JOIN vat_rates r ON r.id = a.vat_rate_id WHERE ${mode === 'exempt' ? 'r.rate_bp <> 0' : 'r.rate_bp = 0'}`)
        .pluck()
        .all() as string[];
      const now = this.now();
      const update = this.db.prepare('UPDATE articles SET vat_rate_id = ?, updated_at = ? WHERE id = ?');
      for (const articleId of ids) {
        update.run(target, now, articleId);
        this.enqueue(null, 'article', articleId, 'upsert', {});
      }
      this.audit(userId, mode === 'exempt' ? 'articles.vat_exempt' : 'articles.vat_standard', 'article', undefined, { count: ids.length });
      return ids.length;
    });
  }

  /** Paramètres du magasin, complétés par les valeurs par défaut. */
  storeSettings(storeId: string): StoreSettings {
    return parseStoreSettings(this.getStore(storeId).settings);
  }

  /** Change des paramètres du magasin ; ils partent vers les autres postes avec la fiche du magasin. */
  saveStoreSettings(userId: string, storeId: string, patch: Partial<StoreSettings>): StoreSettings {
    const current = this.getStore(storeId);
    let next: StoreSettings;
    try {
      next = mergeStoreSettings(parseStoreSettings(current.settings), patch);
    } catch (e) {
      throw new AppError((e as Error).message, 'INVALID');
    }
    if (patch.emoneyCentralRegisterId) {
      // La centrale électronique est une caisse électronique du magasin que personne ne tient au quotidien.
      const reg = this.getRegister(patch.emoneyCentralRegisterId);
      if (reg.store_id !== storeId || reg.kind !== 'electronic') throw new AppError('Choisissez une caisse électronique de ce magasin', 'INVALID');
      const holder = this.db.prepare('SELECT name FROM users WHERE emoney_register_id = ? AND active = 1').pluck().get(reg.id) as string | undefined;
      if (holder) throw new AppError(`${reg.name} est la caisse électronique de ${holder} : choisissez une caisse que personne ne tient`, 'INVALID');
    }
    this.tx(() => {
      this.db.prepare('UPDATE stores SET settings = ? WHERE id = ?').run(JSON.stringify(next), storeId);
      this.enqueue({ storeId, registerId: null }, 'store', storeId, 'upsert', this.getStore(storeId));
      // Le logo n'encombre pas le journal : on note seulement qu'il a changé.
      const logged = {
        ...patch,
        ...(patch.logo !== undefined ? { logo: patch.logo ? 'nouveau logo' : 'logo retiré' } : {}),
        ...(patch.printTemplates !== undefined ? { printTemplates: `${next.printTemplates.length} modèle(s) d'impression` } : {}),
      };
      this.audit(userId, 'store.settings', 'store', storeId, logged);
    });
    return next;
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

  /**
   * Dépôts où l'utilisateur vend, dépôt de vente en premier : ceux cochés sur
   * sa fiche (plus le dépôt de vente), sinon tous s'il a le droit « vendre
   * depuis un autre dépôt », sinon le seul dépôt de vente.
   */
  saleWarehousesFor(storeId: string, userId: string): Warehouse[] {
    const all = this.listWarehouses(storeId);
    const main = this.salesWarehouse(storeId);
    const user = this.getUser(userId);
    let chosen: string[] | null = null;
    try {
      chosen = user.sale_warehouses ? (JSON.parse(user.sale_warehouses) as string[]) : null;
    } catch {
      chosen = null;
    }
    if (chosen) return all.filter((w) => w.id === main.id || chosen!.includes(w.id));
    return this.hasRight(user, 'sale_warehouse') ? all : [main];
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

  /**
   * Déclare une caisse supplémentaire. Une caisse espèces s'active sur son PC
   * avec le code renvoyé ; une caisse électronique ou banque s'attribue aux caissiers.
   */
  createRegister(userId: string, storeId: string, name?: string, kind: RegisterKind = 'cash'): Register {
    if (!(kind in REGISTER_KINDS)) throw new AppError('Type de caisse inconnu', 'INVALID');
    const number =
      ((this.db.prepare('SELECT MAX(number) FROM registers WHERE store_id = ?').pluck().get(storeId) as number | null) ?? 0) + 1;
    const id = newId();
    const code = String(randomInt(100000, 1000000));
    this.db
      .prepare('INSERT INTO registers (id, store_id, number, name, activation_code, kind) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, storeId, number, name?.trim() || this.defaultRegisterName(storeId, number, kind), code, kind);
    const reg = this.getRegister(id);
    this.enqueue({ storeId, registerId: null }, 'register', id, 'upsert', reg);
    this.audit(userId, 'register.create', 'register', id, { number, kind });
    return reg;
  }

  /** Préférences de l'utilisateur sur ce PC (onglets rapides, dernière version vue), en JSON. */
  prefs(userId: string): Record<string, unknown> {
    const rows = this.db.prepare('SELECT key, value FROM user_prefs WHERE user_id = ?').all(userId) as { key: string; value: string }[];
    return Object.fromEntries(rows.map((r) => [r.key, JSON.parse(r.value) as unknown]));
  }

  /** Enregistre une préférence ; null l'efface. */
  setPref(userId: string, key: string, value: unknown): void {
    if (!/^[a-zA-Z][\w.-]{0,40}$/.test(key)) throw new AppError('Préférence inconnue', 'INVALID');
    if (value === null || value === undefined) {
      this.db.prepare('DELETE FROM user_prefs WHERE user_id = ? AND key = ?').run(userId, key);
      return;
    }
    const json = JSON.stringify(value);
    if (json.length > 20_000) throw new AppError('Préférence trop longue', 'INVALID');
    this.db
      .prepare('INSERT INTO user_prefs (user_id, key, value) VALUES (?, ?, ?) ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value')
      .run(userId, key, json);
  }

  /** Caisse 3, ou Mobile 1 et Banque 1 : les caisses électroniques et banque se numérotent entre elles. */
  private defaultRegisterName(storeId: string, number: number, kind: RegisterKind): string {
    if (kind === 'cash') return `Caisse ${number}`;
    const n = (this.db.prepare('SELECT COUNT(*) FROM registers WHERE store_id = ? AND kind = ?').pluck().get(storeId, kind) as number) + 1;
    return `${kind === 'electronic' ? 'Mobile' : 'Banque'} ${n}`;
  }

  /** Renomme ou désactive une caisse. Une caisse ouverte se clôture avant d'être désactivée. */
  updateRegister(userId: string, id: string, patch: { name?: string; active?: boolean }): Register {
    const current = this.getRegister(id);
    const name = patch.name === undefined ? current.name : patch.name.trim();
    if (!name) throw new AppError('Nom de caisse obligatoire', 'INVALID');
    if (patch.active === false && current.active) {
      const open = this.db.prepare("SELECT 1 FROM cash_sessions WHERE register_id = ? AND status = 'open'").get(id);
      if (open) throw new AppError('Clôturez la caisse avant de la désactiver', 'SESSION_OPEN');
    }
    this.db.prepare('UPDATE registers SET name = ?, active = ? WHERE id = ?').run(name, patch.active === undefined ? current.active : patch.active ? 1 : 0, id);
    const reg = this.getRegister(id);
    this.enqueue({ storeId: reg.store_id, registerId: null }, 'register', id, 'upsert', reg);
    this.audit(userId, 'register.update', 'register', id, patch);
    return reg;
  }

  /** Utilisateurs à qui une caisse est attribuée. */
  registerUsers(registerId: string): User[] {
    return this.db
      .prepare('SELECT id, name, login, role, store_id, register_id, emoney_register_id, bank_register_id, sale_warehouses, active FROM users WHERE register_id = ? AND active = 1 ORDER BY name')
      .all(registerId) as User[];
  }

  /** Active ce PC comme caisse à partir du code donné par l'administration. */
  activateRegister(code: string): Register {
    const reg = this.db
      .prepare('SELECT * FROM registers WHERE activation_code = ? AND active = 1')
      .get(code.trim()) as Register | undefined;
    if (!reg) throw new AppError("Code d'activation inconnu", 'INVALID_CODE');
    if (reg.kind !== 'cash') throw new AppError("Seule une caisse espèces s'active sur un PC", 'INVALID_CODE');
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
    return this.db.prepare('SELECT id, name, login, role, store_id, register_id, emoney_register_id, bank_register_id, sale_warehouses, active FROM users ORDER BY name').all() as User[];
  }

  getUser(id: string): User {
    const user = this.db.prepare('SELECT id, name, login, role, store_id, register_id, emoney_register_id, bank_register_id, sale_warehouses, active FROM users WHERE id = ?').get(id) as User | undefined;
    if (!user) throw new AppError('Utilisateur introuvable', 'NOT_FOUND');
    return user;
  }

  createUser(
    byUserId: string,
    input: UserRegisters & { name: string; login: string; pin: string; role: Role; storeId: string | null; saleWarehouses?: string[] | null },
  ): User {
    this.checkPinLength(input.pin, input.storeId);
    const id = newId();
    const registerId = this.checkRegister(input.registerId ?? null, 'cash');
    const emoneyId = this.checkRegister(input.emoneyRegisterId ?? null, 'electronic');
    const bankId = this.checkRegister(input.bankRegisterId ?? null, 'bank');
    try {
      this.db
        .prepare(
          'INSERT INTO users (id, name, login, pin_hash, role, store_id, register_id, emoney_register_id, bank_register_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(id, input.name.trim(), input.login.trim().toLowerCase(), hashPin(input.pin), input.role, input.storeId, registerId, emoneyId, bankId, this.now());
    } catch (e) {
      if (String(e).includes('UNIQUE')) throw new AppError('Identifiant déjà utilisé', 'DUPLICATE');
      throw e;
    }
    if (input.saleWarehouses) this.db.prepare('UPDATE users SET sale_warehouses = ? WHERE id = ?').run(JSON.stringify([...new Set(input.saleWarehouses)]), id);
    const user = this.getUser(id);
    this.enqueue(null, 'user', id, 'upsert', user);
    this.audit(byUserId, 'user.create', 'user', id, { role: input.role });
    return user;
  }

  updateUser(
    byUserId: string,
    id: string,
    patch: UserRegisters & { name?: string; role?: Role; storeId?: string | null; active?: boolean; pin?: string; saleWarehouses?: string[] | null },
  ): User {
    const current = this.getUser(id);
    if (patch.saleWarehouses !== undefined) {
      const ids = patch.saleWarehouses ? [...new Set(patch.saleWarehouses)] : null;
      this.db.prepare('UPDATE users SET sale_warehouses = ? WHERE id = ?').run(ids ? JSON.stringify(ids) : null, id);
    }
    if (patch.pin) this.checkPinLength(patch.pin, patch.storeId === undefined ? current.store_id : patch.storeId);
    this.db
      .prepare('UPDATE users SET name = ?, role = ?, store_id = ?, register_id = ?, emoney_register_id = ?, bank_register_id = ?, active = ? WHERE id = ?')
      .run(
        patch.name ?? current.name,
        patch.role ?? current.role,
        patch.storeId === undefined ? current.store_id : patch.storeId,
        patch.registerId === undefined ? current.register_id : this.checkRegister(patch.registerId, 'cash'),
        patch.emoneyRegisterId === undefined ? current.emoney_register_id : this.checkRegister(patch.emoneyRegisterId, 'electronic'),
        patch.bankRegisterId === undefined ? current.bank_register_id : this.checkRegister(patch.bankRegisterId, 'bank'),
        patch.active === undefined ? current.active : patch.active ? 1 : 0,
        id,
      );
    if (patch.pin) this.db.prepare('UPDATE users SET pin_hash = ? WHERE id = ?').run(hashPin(patch.pin), id);
    const user = this.getUser(id);
    this.enqueue(null, 'user', id, 'upsert', user);
    this.audit(byUserId, 'user.update', 'user', id, { ...patch, pin: patch.pin ? '***' : undefined });
    return user;
  }

  /** Longueur minimale du code fixée dans les paramètres du magasin (celui de l'utilisateur, sinon celui de ce poste). */
  private checkPinLength(pin: string, storeId: string | null): void {
    const sid = storeId ?? this.getSetting('station.storeId');
    const min = sid ? this.storeSettings(sid).pinMinLength : 4;
    if (pin.length < min) throw new AppError(`Le code doit faire au moins ${min} chiffres`, 'INVALID_PIN');
  }

  /** Caisse attribuable : elle existe, n'est pas désactivée et a le type attendu. */
  private checkRegister(registerId: string | null, kind: RegisterKind): string | null {
    if (!registerId) return null;
    const reg = this.getRegister(registerId);
    if (!reg.active) throw new AppError('Cette caisse est désactivée', 'INVALID');
    if (reg.kind !== kind) throw new AppError(`${reg.name} n'est pas une caisse ${REGISTER_KINDS[kind].split(' ')[0]!.toLowerCase()}`, 'INVALID');
    if (kind === 'electronic' && this.storeSettings(reg.store_id).emoneyCentralRegisterId === registerId) {
      throw new AppError(`${reg.name} est la caisse électronique centrale : elle reçoit les versements et n'est attribuée à personne`, 'INVALID');
    }
    return registerId;
  }

  login(login: string, pin: string): User {
    const row = this.db
      .prepare('SELECT id, pin_hash, store_id FROM users WHERE login = ? AND active = 1')
      .get(login.trim().toLowerCase()) as { id: string; pin_hash: string; store_id: string | null } | undefined;
    const attempts = row
      ? ((this.db.prepare('SELECT failures, locked_until FROM login_attempts WHERE user_id = ?').get(row.id) as { failures: number; locked_until: string | null } | undefined) ?? null)
      : null;
    const now = this.now();
    if (attempts?.locked_until && attempts.locked_until > now) {
      const minutes = Math.max(1, Math.ceil((Date.parse(attempts.locked_until) - Date.parse(now)) / 60000));
      throw new AppError(`Trop de codes faux : compte bloqué encore ${minutes} min. L'administrateur peut le débloquer.`, 'LOCKED');
    }
    if (!row || !verifyPin(pin, row.pin_hash)) {
      this.audit(null, 'auth.failed', 'user', row?.id, { login });
      if (row) {
        const sid = row.store_id ?? this.getSetting('station.storeId');
        const max = sid ? this.storeSettings(sid).maxLoginAttempts : 0;
        const failures = (attempts?.failures ?? 0) + 1;
        const lock = max > 0 && failures >= max;
        const until = lock ? new Date(Date.parse(now) + LOCK_MINUTES * 60000).toISOString() : null;
        this.db
          .prepare('INSERT INTO login_attempts (user_id, failures, locked_until) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET failures = excluded.failures, locked_until = excluded.locked_until')
          .run(row.id, lock ? 0 : failures, until);
        if (lock) {
          this.audit(null, 'auth.locked', 'user', row.id, { login, minutes: LOCK_MINUTES });
          throw new AppError(`Trop de codes faux : compte bloqué ${LOCK_MINUTES} minutes`, 'LOCKED');
        }
      }
      throw new AppError('Identifiant ou code incorrect', 'AUTH_FAILED');
    }
    this.db.prepare('DELETE FROM login_attempts WHERE user_id = ?').run(row.id);
    this.audit(row.id, 'auth.login', 'user', row.id);
    return this.getUser(row.id);
  }

  /** Utilisateurs bloqués sur ce PC après trop de codes faux. */
  lockedUsers(): string[] {
    return this.db.prepare('SELECT user_id FROM login_attempts WHERE locked_until > ?').pluck().all(this.now()) as string[];
  }

  /** Débloque un utilisateur avant la fin de son blocage. */
  unlockUser(byUserId: string, id: string): void {
    this.db.prepare('DELETE FROM login_attempts WHERE user_id = ?').run(id);
    this.audit(byUserId, 'user.unlock', 'user', id);
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

  /** Privilèges personnels d'un utilisateur (droits accordés en plus de son rôle, droits retirés). */
  privileges(userId: string): UserPrivileges {
    const row = this.db.prepare('SELECT grants, revokes FROM user_rights WHERE id = ?').get(userId) as { grants: string; revokes: string } | undefined;
    if (!row) return { grants: [], revokes: [] };
    const known = (list: string) => (JSON.parse(list) as string[]).filter((p): p is Permission => p in PERMISSIONS);
    return { grants: known(row.grants), revokes: known(row.revokes) };
  }

  /** Droits effectifs d'un utilisateur : son rôle, plus ses privilèges accordés, moins ceux qui lui sont retirés. */
  userRights(user: Pick<User, 'id' | 'role'>): Permission[] {
    return userRights(user.role, this.rights(user.role), user.role === 'admin' ? null : this.privileges(user.id));
  }

  hasRight(user: Pick<User, 'id' | 'role'>, permission: Permission): boolean {
    return this.userRights(user).includes(permission);
  }

  /**
   * Enregistre les privilèges personnels d'un utilisateur. Un droit accordé que
   * le rôle donne déjà, ou retiré que le rôle ne donne pas, n'est pas gardé.
   */
  savePrivileges(byUserId: string, userId: string, input: UserPrivileges): UserPrivileges {
    const user = this.getUser(userId);
    if (user.role === 'admin') throw new AppError("L'administrateur a toujours tous les droits", 'INVALID');
    const unknown = [...input.grants, ...input.revokes].find((r) => !(r in PERMISSIONS));
    if (unknown) throw new AppError(`Droit inconnu : ${unknown}`, 'INVALID');
    const role = new Set(this.rights(user.role));
    const grants = [...new Set(input.grants)].filter((p) => !role.has(p));
    const revokes = [...new Set(input.revokes)].filter((p) => role.has(p));
    return this.tx(() => {
      const row = { id: userId, grants: JSON.stringify(grants), revokes: JSON.stringify(revokes), updated_at: this.now() };
      this.db
        .prepare(
          'INSERT INTO user_rights (id, grants, revokes, updated_at) VALUES (@id, @grants, @revokes, @updated_at) ON CONFLICT(id) DO UPDATE SET grants = excluded.grants, revokes = excluded.revokes, updated_at = excluded.updated_at',
        )
        .run(row);
      this.enqueue(null, 'user_rights', userId, 'upsert', row);
      this.audit(byUserId, 'admin.privileges', 'user', userId, { grants, revokes });
      return { grants, revokes };
    });
  }

  /** Utilisateurs actifs qui ont un droit (par leur rôle ou à titre personnel). */
  holders(permission: Permission): { id: string; name: string; role: Role }[] {
    return this.listUsers()
      .filter((u) => u.active === 1 && this.hasRight(u, permission))
      .map((u) => ({ id: u.id, name: u.name, role: u.role }));
  }

  /** Utilisateurs qui ont des privilèges personnels, avec leur nombre de droits accordés et retirés. */
  privilegeCounts(): Record<string, { grants: number; revokes: number }> {
    const out: Record<string, { grants: number; revokes: number }> = {};
    for (const r of this.db.prepare('SELECT id FROM user_rights').pluck().all() as string[]) {
      const p = this.privileges(r);
      if (p.grants.length || p.revokes.length) out[r] = { grants: p.grants.length, revokes: p.revokes.length };
    }
    return out;
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
