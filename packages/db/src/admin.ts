import { randomInt } from 'node:crypto';
import {
  EDITABLE_ROLES,
  PERMISSIONS,
  type Permission,
  ELECTRONIC_METHODS,
  PAYMENT_METHODS,
  type RegisterKind,
  type StoreSettings,
  registerMethods,
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
  /** Première de ses caisses électroniques (gardée pour les anciennes versions). */
  emoney_register_id: string | null;
  /** Caisses électroniques (Mobile Money, carte) qui reçoivent ses paiements électroniques, en JSON d'ids. */
  emoney_register_ids?: string | null;
  /** Caisse banque (virements, chèques) qui reçoit ses paiements bancaires. */
  bank_register_id: string | null;
  /** Vendeur et caissier séparés : la caisse où partent ses factures (null : n'importe quelle caisse). */
  counter_register_id?: string | null;
  /** Dépôts où il vend et complète une ligne (JSON d'ids) ; null = selon son droit « vendre depuis un autre dépôt ». */
  sale_warehouses: string | null;
  active: number;
  /** Code-barres du badge de l'employé (connexion en le scannant). */
  badge?: string | null;
  /** Supprimé : gardé pour l'historique, ne se connecte plus et n'apparaît plus dans les listes. */
  deleted_at?: string | null;
}

export const REGISTER_KINDS: Record<RegisterKind, string> = {
  cash: 'Espèces',
  electronic: 'Électronique (Mobile Money, carte)',
  bank: 'Banque (virement, chèque)',
};

/** Caisses attribuées à un utilisateur : une espèces, une banque et plusieurs électroniques. */
export interface UserRegisters {
  registerId?: string | null;
  /** Une seule caisse électronique (anciens appels) ; emoneyRegisterIds l'emporte. */
  emoneyRegisterId?: string | null;
  emoneyRegisterIds?: string[] | null;
  bankRegisterId?: string | null;
  /** Vendeur : caisse qui reçoit ses factures (vendeur et caissier séparés). */
  counterRegisterId?: string | null;
}

/** Caisses électroniques d'un utilisateur, dans l'ordre choisi. */
export function emoneyRegisterIds(u: Pick<User, 'emoney_register_id' | 'emoney_register_ids'>): string[] {
  if (u.emoney_register_ids) {
    try {
      const ids = JSON.parse(u.emoney_register_ids) as unknown;
      if (Array.isArray(ids)) return ids.filter((x): x is string => typeof x === 'string');
    } catch {
      // Valeur illisible : on retombe sur la caisse unique.
    }
  }
  return u.emoney_register_id ? [u.emoney_register_id] : [];
}

export interface Store {
  id: string;
  code: string;
  name: string;
  address: string | null;
  phone: string | null;
  taxpayer_number: string | null;
  active: number;
  /** Société (personne morale) à laquelle appartient le magasin. */
  company_id: string | null;
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
  /** Caisse électronique : moyens qu'elle reçoit (« MTN_MOMO,CARD ») ; vide : tous. */
  methods?: string | null;
}

export interface Warehouse {
  id: string;
  store_id: string;
  name: string;
  kind: 'shop' | 'reserve' | 'cold';
  is_sales_default: number;
  active: number;
  manager: string | null;
  phone: string | null;
  address: string | null;
  /** Usage : stock normal, avaries (abîmé, hors vente) ou dépôt-vente chez un client revendeur. */
  purpose: WarehousePurpose;
  /** Dépôt-vente : le client revendeur qui détient la marchandise. */
  customer_id: string | null;
}

export type WarehousePurpose = 'stock' | 'damaged' | 'consignment';

export const WAREHOUSE_PURPOSES: Record<WarehousePurpose, string> = {
  stock: 'Stock du magasin',
  damaged: 'Avaries (hors vente)',
  consignment: 'Dépôt-vente chez un client',
};

export interface WarehouseInput {
  name: string;
  kind: Warehouse['kind'];
  manager?: string | null;
  phone?: string | null;
  address?: string | null;
  /** Absent : inchangé (stock normal à la création). */
  purpose?: WarehousePurpose;
  /** Client revendeur d'un dépôt-vente. */
  customerId?: string | null;
}

const WAREHOUSE_KINDS: Warehouse['kind'][] = ['shop', 'reserve', 'cold'];

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
export interface AuditRow {
  id: string;
  user_id: string | null;
  user_name: string | null;
  action: string;
  entity: string | null;
  entity_id: string | null;
  /** Nom de la fiche concernée (produit, client, fournisseur, utilisateur, n° de facture). */
  entity_name: string | null;
  details: string | null;
  at: string;
}

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
      const holder = this.emoneyHolders(reg.id)[0]?.name;
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

  createWarehouse(
    storeId: string,
    name: string,
    kind: Warehouse['kind'],
    salesDefault = false,
    opts: { purpose?: WarehousePurpose; customerId?: string | null } = {},
  ): Warehouse {
    const purpose = opts.purpose ?? 'stock';
    this.checkWarehouseInput(storeId, { name, kind, purpose, customerId: opts.customerId ?? null });
    if (salesDefault && purpose !== 'stock') throw new AppError('Le dépôt des ventes est un dépôt de stock normal', 'INVALID');
    name = name.trim();
    const id = newId();
    this.db
      .prepare('INSERT INTO warehouses (id, store_id, name, kind, is_sales_default, purpose, customer_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, storeId, name, kind, salesDefault ? 1 : 0, purpose, purpose === 'consignment' ? opts.customerId! : null);
    const wh = this.db.prepare('SELECT * FROM warehouses WHERE id = ?').get(id) as Warehouse;
    this.enqueue({ storeId, registerId: null }, 'warehouse', id, 'upsert', wh);
    return wh;
  }

  /** Dépôts du magasin, dépôt des ventes en premier ; les dépôts désactivés seulement sur demande. */
  listWarehouses(storeId: string, opts: { includeInactive?: boolean } = {}): Warehouse[] {
    return this.db
      .prepare(`SELECT * FROM warehouses WHERE store_id = ? ${opts.includeInactive ? '' : 'AND active = 1'} ORDER BY active DESC, is_sales_default DESC, name`)
      .all(storeId) as Warehouse[];
  }

  getWarehouse(id: string): Warehouse {
    const wh = this.db.prepare('SELECT * FROM warehouses WHERE id = ?').get(id) as Warehouse | undefined;
    if (!wh) throw new AppError('Dépôt introuvable', 'NOT_FOUND');
    return wh;
  }

  private checkWarehouseInput(storeId: string, input: WarehouseInput, id?: string): void {
    const name = input.name?.trim() ?? '';
    if (!name) throw new AppError('Donnez un nom au dépôt', 'INVALID');
    if (name.length > 60) throw new AppError('Nom du dépôt trop long (60 caractères au plus)', 'INVALID');
    if (!WAREHOUSE_KINDS.includes(input.kind)) throw new AppError('Type de dépôt inconnu', 'INVALID');
    if (input.purpose !== undefined && !(input.purpose in WAREHOUSE_PURPOSES)) throw new AppError('Usage du dépôt inconnu', 'INVALID');
    if (input.purpose === 'consignment') {
      if (!input.customerId) throw new AppError('Choisissez le client revendeur qui détient ce dépôt-vente', 'INVALID');
      if (!this.db.prepare('SELECT 1 FROM customers WHERE id = ?').get(input.customerId)) throw new AppError('Client introuvable', 'INVALID');
    }
    // Un ancien doublon de nom garde son nom : seul un nouveau nom doit être libre.
    if (id && this.getWarehouse(id).name.toLowerCase() === name.toLowerCase()) return;
    const twin = this.db
      .prepare('SELECT id FROM warehouses WHERE store_id = ? AND lower(name) = lower(?) AND id <> ?')
      .pluck()
      .get(storeId, name, id ?? '') as string | undefined;
    if (twin) throw new AppError(`Un dépôt s'appelle déjà « ${name} » dans ce magasin`, 'DUPLICATE');
  }

  /** Nom, type et fiche du dépôt (responsable, téléphone, adresse) : l'historique garde le dépôt, sous son nouveau nom. */
  updateWarehouse(userId: string, id: string, input: WarehouseInput): Warehouse {
    const wh = this.getWarehouse(id);
    const purpose = input.purpose ?? wh.purpose;
    const customerId = purpose === 'consignment' ? (input.customerId === undefined ? wh.customer_id : input.customerId) : null;
    this.checkWarehouseInput(wh.store_id, { ...input, purpose, customerId }, id);
    if (purpose !== 'stock' && wh.is_sales_default) throw new AppError(`« ${wh.name} » est le dépôt des ventes : il reste un dépôt de stock normal`, 'INVALID');
    if (purpose !== wh.purpose || customerId !== wh.customer_id) {
      // Changer l'usage d'un dépôt qui contient de la marchandise fausserait ventes et contrôles : il se vide d'abord.
      const stocked = this.db.prepare('SELECT COUNT(*) FROM stock WHERE warehouse_id = ? AND qty <> 0').pluck().get(id) as number;
      if (stocked > 0) throw new AppError(`« ${wh.name} » contient encore du stock : transférez-le avant de changer l'usage du dépôt`, 'WAREHOUSE_NOT_EMPTY');
    }
    const text = (v: string | null | undefined, current: string | null) => (v === undefined ? current : v?.trim() || null);
    return this.tx(() => {
      this.db
        .prepare('UPDATE warehouses SET name = ?, kind = ?, manager = ?, phone = ?, address = ?, purpose = ?, customer_id = ? WHERE id = ?')
        .run(input.name.trim(), input.kind, text(input.manager, wh.manager), text(input.phone, wh.phone), text(input.address, wh.address), purpose, customerId, id);
      const next = this.getWarehouse(id);
      this.enqueue({ storeId: wh.store_id, registerId: null }, 'warehouse', id, 'upsert', next);
      this.audit(userId, 'warehouse.update', 'warehouse', id, {
        from: { name: wh.name, kind: wh.kind, purpose: wh.purpose },
        to: { name: next.name, kind: next.kind, purpose: next.purpose },
      });
      return next;
    });
  }

  /**
   * Désactive ou réactive un dépôt. Il sort alors des listes (ventes, achats,
   * transferts, inventaires) mais garde tout son historique. On ne désactive
   * ni le dépôt des ventes, ni un dépôt qui a encore du stock ou un document en cours.
   */
  setWarehouseActive(userId: string, id: string, active: boolean): Warehouse {
    const wh = this.getWarehouse(id);
    if (active === (wh.active === 1)) return wh;
    if (!active) {
      if (wh.is_sales_default) throw new AppError(`« ${wh.name} » est le dépôt des ventes : choisissez d'abord un autre dépôt des ventes`, 'INVALID');
      const stocked = this.db.prepare('SELECT COUNT(*) FROM stock WHERE warehouse_id = ? AND qty <> 0').pluck().get(id) as number;
      if (stocked > 0) {
        throw new AppError(
          `« ${wh.name} » contient encore ${stocked} article${stocked > 1 ? 's' : ''} en stock : transférez-les vers un autre dépôt (ou passez-les en perte) avant de le désactiver`,
          'WAREHOUSE_NOT_EMPTY',
        );
      }
      const transfers = this.db
        .prepare("SELECT COUNT(*) FROM transfers WHERE (from_warehouse_id = ? OR to_warehouse_id = ?) AND status IN ('draft', 'shipped')")
        .pluck()
        .get(id, id) as number;
      if (transfers > 0) throw new AppError(`« ${wh.name} » a ${transfers} transfert${transfers > 1 ? 's' : ''} en cours : réceptionnez-les ou annulez-les d'abord`, 'INVALID');
      const counts = this.db.prepare("SELECT COUNT(*) FROM inventories WHERE warehouse_id = ? AND status = 'open'").pluck().get(id) as number;
      if (counts > 0) throw new AppError(`« ${wh.name} » a un inventaire en cours : clôturez-le ou annulez-le d'abord`, 'INVALID');
    }
    return this.tx(() => {
      this.db.prepare('UPDATE warehouses SET active = ? WHERE id = ?').run(active ? 1 : 0, id);
      const next = this.getWarehouse(id);
      this.enqueue({ storeId: wh.store_id, registerId: null }, 'warehouse', id, 'upsert', next);
      this.audit(userId, active ? 'warehouse.enable' : 'warehouse.disable', 'warehouse', id, { name: wh.name });
      return next;
    });
  }

  /** Le dépôt d'où sortent les ventes de la caisse (un seul par magasin). */
  setSalesWarehouse(userId: string, id: string): Warehouse {
    const wh = this.getWarehouse(id);
    if (!wh.active) throw new AppError(`« ${wh.name} » est désactivé : réactivez-le d'abord`, 'INVALID');
    if (wh.purpose !== 'stock') throw new AppError(`« ${wh.name} » est un dépôt ${wh.purpose === 'damaged' ? 'd’avaries' : 'de dépôt-vente'} : on n'y vend pas`, 'INVALID');
    if (wh.is_sales_default) return wh;
    return this.tx(() => {
      const previous = this.db.prepare('SELECT id FROM warehouses WHERE store_id = ? AND is_sales_default = 1').pluck().all(wh.store_id) as string[];
      this.db.prepare('UPDATE warehouses SET is_sales_default = (id = ?) WHERE store_id = ?').run(id, wh.store_id);
      for (const w of [...previous, id]) this.enqueue({ storeId: wh.store_id, registerId: null }, 'warehouse', w, 'upsert', this.getWarehouse(w));
      this.audit(userId, 'warehouse.sales_default', 'warehouse', id, { name: wh.name });
      return this.getWarehouse(id);
    });
  }

  /**
   * Dépôts où l'utilisateur vend, dépôt de vente en premier : ceux cochés sur
   * sa fiche (plus le dépôt de vente), sinon tous s'il a le droit « vendre
   * depuis un autre dépôt », sinon le seul dépôt de vente.
   */
  saleWarehousesFor(storeId: string, userId: string): Warehouse[] {
    // Avaries et dépôts-ventes ne servent jamais de source à la caisse.
    const all = this.listWarehouses(storeId).filter((w) => w.purpose === 'stock');
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
  updateRegister(userId: string, id: string, patch: { name?: string; active?: boolean; methods?: string[] | null }): Register {
    const current = this.getRegister(id);
    const name = patch.name === undefined ? current.name : patch.name.trim();
    if (!name) throw new AppError('Nom de caisse obligatoire', 'INVALID');
    if (patch.active === false && current.active) {
      const open = this.db.prepare("SELECT 1 FROM cash_sessions WHERE register_id = ? AND status = 'open'").get(id);
      if (open) throw new AppError('Clôturez la caisse avant de la désactiver', 'SESSION_OPEN');
    }
    let methods = current.methods ?? null;
    if (patch.methods !== undefined && current.kind === 'electronic') {
      const list = [...new Set(patch.methods ?? [])];
      if (list.some((m) => !(ELECTRONIC_METHODS as readonly string[]).includes(m))) throw new AppError('Moyen de paiement inconnu', 'INVALID');
      if (patch.methods && !list.length) throw new AppError('Cochez au moins un moyen reçu par la caisse', 'INVALID');
      methods = list.length && list.length < ELECTRONIC_METHODS.length ? ELECTRONIC_METHODS.filter((m) => list.includes(m)).join(',') : null;
      // Chaque caissier qui tient cette caisse ne doit pas recevoir un moyen dans deux caisses.
      for (const u of this.emoneyHolders(id)) this.checkEmoneyOverlap(emoneyRegisterIds(u), { [id]: methods });
    }
    this.db.prepare('UPDATE registers SET name = ?, active = ?, methods = ? WHERE id = ?').run(name, patch.active === undefined ? current.active : patch.active ? 1 : 0, methods, id);
    const reg = this.getRegister(id);
    this.enqueue({ storeId: reg.store_id, registerId: null }, 'register', id, 'upsert', reg);
    this.audit(userId, 'register.update', 'register', id, patch);
    return reg;
  }

  /**
   * Pièces qui citent déjà la caisse (journées, ventes, mouvements…) : une
   * caisse qui a servi garde son type et ne se supprime plus, elle se désactive.
   */
  registerUsage(id: string): number {
    const tables = this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT IN ('registers', 'users', 'outbox', 'audit_log', 'settings')").pluck().all() as string[];
    let n = 0;
    for (const t of tables) {
      const cols = (this.db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name).filter((c) => c === 'register_id' || c === 'other_register_id' || c === 'to_register_id');
      for (const c of cols) n += this.db.prepare(`SELECT COUNT(*) FROM ${t} WHERE ${c} = ?`).pluck().get(id) as number;
    }
    return n;
  }

  private registerLocked(reg: Register): string | null {
    if (this.registerUsage(reg.id) > 0) return `${reg.name} a déjà servi (journées, ventes ou mouvements) : désactivez-la plutôt`;
    if (this.getSetting('station.registerId') === reg.id || reg.activated_at) return `${reg.name} est rattachée à un PC (code d'activation déjà utilisé)`;
    if (this.storeSettings(reg.store_id).emoneyCentralRegisterId === reg.id) return `${reg.name} est la caisse électronique centrale (Paramètres)`;
    return null;
  }

  /** Retire une caisse aux utilisateurs qui la tiennent (avant un changement de type ou une suppression). */
  private detachRegister(reg: Register): string[] {
    const names: string[] = [];
    const holders = this.db
      .prepare('SELECT id, name, register_id, emoney_register_id, emoney_register_ids, bank_register_id FROM users WHERE register_id = @id OR bank_register_id = @id OR emoney_register_id = @id OR emoney_register_ids LIKE @like')
      .all({ id: reg.id, like: `%${reg.id}%` }) as (Pick<User, 'id' | 'name' | 'register_id' | 'emoney_register_id' | 'emoney_register_ids' | 'bank_register_id'>)[];
    for (const u of holders) {
      const emoney = emoneyRegisterIds(u).filter((x) => x !== reg.id);
      this.db
        .prepare('UPDATE users SET register_id = ?, bank_register_id = ?, emoney_register_id = ?, emoney_register_ids = ? WHERE id = ?')
        .run(u.register_id === reg.id ? null : u.register_id, u.bank_register_id === reg.id ? null : u.bank_register_id, emoney[0] ?? null, emoney.length ? JSON.stringify(emoney) : null, u.id);
      this.enqueue(null, 'user', u.id, 'upsert', this.getUser(u.id));
      names.push(u.name);
    }
    // Vendeurs qui y envoyaient leurs factures : elles repartent vers toutes les caisses.
    for (const id of this.db.prepare('SELECT id FROM users WHERE counter_register_id = ?').pluck().all(reg.id) as string[]) {
      this.db.prepare('UPDATE users SET counter_register_id = NULL WHERE id = ?').run(id);
      this.enqueue(null, 'user', id, 'upsert', this.getUser(id));
    }
    return names;
  }

  /**
   * Change le type d'une caisse créée par erreur (espèces au lieu d'électronique…).
   * Seulement tant qu'elle n'a pas servi ; elle est retirée aux utilisateurs qui la tenaient.
   */
  changeRegisterKind(userId: string, id: string, kind: RegisterKind): { register: Register; detached: string[] } {
    if (!(kind in REGISTER_KINDS)) throw new AppError('Type de caisse inconnu', 'INVALID');
    const reg = this.getRegister(id);
    if (reg.kind === kind) return { register: reg, detached: [] };
    const locked = this.registerLocked(reg);
    if (locked) throw new AppError(`Type non modifiable : ${locked}`, 'IN_USE');
    return this.tx(() => {
      const detached = this.detachRegister(reg);
      this.db.prepare('UPDATE registers SET kind = ?, methods = NULL WHERE id = ?').run(kind, id);
      const next = this.getRegister(id);
      this.enqueue({ storeId: next.store_id, registerId: null }, 'register', id, 'upsert', next);
      this.audit(userId, 'register.kind', 'register', id, { from: reg.kind, to: kind, detached });
      return { register: next, detached };
    });
  }

  /** Supprime une caisse qui n'a jamais servi (créée en trop ou par erreur). */
  deleteRegister(userId: string, id: string): { detached: string[] } {
    const reg = this.getRegister(id);
    const locked = this.registerLocked(reg);
    if (locked) throw new AppError(`Suppression impossible : ${locked}`, 'IN_USE');
    if (this.db.prepare('SELECT COUNT(*) FROM registers WHERE store_id = ? AND kind = ? AND id <> ?').pluck().get(reg.store_id, 'cash', id) === 0 && reg.kind === 'cash') {
      throw new AppError('Le magasin doit garder au moins une caisse espèces', 'INVALID');
    }
    return this.tx(() => {
      const detached = this.detachRegister(reg);
      this.db.prepare('DELETE FROM registers WHERE id = ?').run(id);
      this.enqueue({ storeId: reg.store_id, registerId: null }, 'register', id, 'delete', null);
      this.audit(userId, 'register.delete', 'register', id, { number: reg.number, name: reg.name, kind: reg.kind, detached });
      return { detached };
    });
  }

  /** Utilisateurs à qui une caisse est attribuée. */
  registerUsers(registerId: string): User[] {
    return this.db
      .prepare('SELECT id, name, login, role, store_id, register_id, emoney_register_id, emoney_register_ids, bank_register_id, counter_register_id, sale_warehouses, active FROM users WHERE register_id = ? AND active = 1 ORDER BY name')
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

  /**
   * PC qui a rejoint le magasin sans code de caisse (poste de vendeur, magasinier…) :
   * il appartient au magasin sans caisse propre ; chacun y vend sur la caisse que
   * l'administration lui attribue.
   */
  joinStation(storeId: string): void {
    this.getStore(storeId);
    this.setSetting('station.storeId', storeId);
    this.setSetting('station.registerId', '');
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
    return this.db.prepare('SELECT id, name, login, role, store_id, register_id, emoney_register_id, emoney_register_ids, bank_register_id, counter_register_id, sale_warehouses, active, badge FROM users WHERE deleted_at IS NULL ORDER BY name').all() as User[];
  }

  getUser(id: string): User {
    const user = this.db.prepare('SELECT id, name, login, role, store_id, register_id, emoney_register_id, emoney_register_ids, bank_register_id, counter_register_id, sale_warehouses, active, badge, deleted_at FROM users WHERE id = ?').get(id) as User | undefined;
    if (!user) throw new AppError('Utilisateur introuvable', 'NOT_FOUND');
    return user;
  }

  createUser(
    byUserId: string,
    input: UserRegisters & { name: string; login: string; pin: string; role: Role; storeId: string | null; saleWarehouses?: string[] | null },
  ): User {
    this.checkPinLength(input.pin, input.storeId);
    if (!/^[a-z0-9._-]{2,30}$/.test(input.login.trim().toLowerCase())) {
      throw new AppError("Identifiant : 2 à 30 lettres sans accent, chiffres, point, tiret ou soulignement", 'INVALID');
    }
    const id = newId();
    const registerId = this.checkRegister(input.registerId ?? null, 'cash');
    const emoneyIds = this.checkEmoneyRegisters(input.emoneyRegisterIds ?? (input.emoneyRegisterId ? [input.emoneyRegisterId] : []));
    const bankId = this.checkRegister(input.bankRegisterId ?? null, 'bank');
    try {
      this.db
        .prepare(
          'INSERT INTO users (id, name, login, pin_hash, role, store_id, register_id, emoney_register_id, emoney_register_ids, bank_register_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(id, input.name.trim(), input.login.trim().toLowerCase(), hashPin(input.pin), input.role, input.storeId, registerId, emoneyIds[0] ?? null, emoneyIds.length ? JSON.stringify(emoneyIds) : null, bankId, this.now());
    } catch (e) {
      if (String(e).includes('UNIQUE')) throw new AppError('Identifiant déjà utilisé', 'DUPLICATE');
      throw e;
    }
    if (input.saleWarehouses) this.db.prepare('UPDATE users SET sale_warehouses = ? WHERE id = ?').run(JSON.stringify([...new Set(input.saleWarehouses)]), id);
    if (input.counterRegisterId) this.db.prepare('UPDATE users SET counter_register_id = ? WHERE id = ?').run(this.checkRegister(input.counterRegisterId, 'cash'), id);
    const user = this.getUser(id);
    this.enqueue(null, 'user', id, 'upsert', user);
    this.audit(byUserId, 'user.create', 'user', id, { role: input.role });
    return user;
  }

  updateUser(
    byUserId: string,
    id: string,
    patch: UserRegisters & { name?: string; login?: string; role?: Role; storeId?: string | null; active?: boolean; pin?: string; saleWarehouses?: string[] | null },
  ): User {
    const current = this.getUser(id);
    if (current.deleted_at) throw new AppError('Cet utilisateur a été supprimé', 'INVALID');
    if (patch.login !== undefined) {
      const login = patch.login.trim().toLowerCase();
      if (!/^[a-z0-9._-]{2,30}$/.test(login)) throw new AppError("Identifiant : 2 à 30 lettres sans accent, chiffres, point, tiret ou soulignement", 'INVALID');
      if (login !== current.login) {
        if (this.db.prepare('SELECT 1 FROM users WHERE login = ? AND id <> ?').get(login, id)) throw new AppError('Identifiant déjà utilisé', 'DUPLICATE');
        this.db.prepare('UPDATE users SET login = ? WHERE id = ?').run(login, id);
      }
    }
    if (patch.active === false || (patch.role !== undefined && patch.role !== 'admin')) this.keepOneAdmin(id);
    if (patch.saleWarehouses !== undefined) {
      const ids = patch.saleWarehouses ? [...new Set(patch.saleWarehouses)] : null;
      this.db.prepare('UPDATE users SET sale_warehouses = ? WHERE id = ?').run(ids ? JSON.stringify(ids) : null, id);
    }
    if (patch.pin) this.checkPinLength(patch.pin, patch.storeId === undefined ? current.store_id : patch.storeId);
    const emoneyIds =
      patch.emoneyRegisterIds !== undefined
        ? this.checkEmoneyRegisters(patch.emoneyRegisterIds ?? [])
        : patch.emoneyRegisterId !== undefined
          ? this.checkEmoneyRegisters(patch.emoneyRegisterId ? [patch.emoneyRegisterId] : [])
          : emoneyRegisterIds(current);
    this.db
      .prepare('UPDATE users SET name = ?, role = ?, store_id = ?, register_id = ?, emoney_register_id = ?, emoney_register_ids = ?, bank_register_id = ?, active = ? WHERE id = ?')
      .run(
        patch.name ?? current.name,
        patch.role ?? current.role,
        patch.storeId === undefined ? current.store_id : patch.storeId,
        patch.registerId === undefined ? current.register_id : this.checkRegister(patch.registerId, 'cash'),
        emoneyIds[0] ?? null,
        emoneyIds.length ? JSON.stringify(emoneyIds) : null,
        patch.bankRegisterId === undefined ? current.bank_register_id : this.checkRegister(patch.bankRegisterId, 'bank'),
        patch.active === undefined ? current.active : patch.active ? 1 : 0,
        id,
      );
    if (patch.pin) this.db.prepare('UPDATE users SET pin_hash = ? WHERE id = ?').run(hashPin(patch.pin), id);
    if (patch.counterRegisterId !== undefined) {
      this.db.prepare('UPDATE users SET counter_register_id = ? WHERE id = ?').run(patch.counterRegisterId ? this.checkRegister(patch.counterRegisterId, 'cash') : null, id);
    }
    const user = this.getUser(id);
    this.enqueue(null, 'user', id, 'upsert', user);
    this.audit(byUserId, 'user.update', 'user', id, { ...patch, pin: patch.pin ? '***' : undefined });
    return user;
  }

  /** Refuse de retirer le dernier administrateur actif. */
  private keepOneAdmin(id: string): void {
    const others = this.db.prepare("SELECT COUNT(*) FROM users WHERE role = 'admin' AND active = 1 AND deleted_at IS NULL AND id <> ?").pluck().get(id) as number;
    const isAdmin = this.db.prepare("SELECT 1 FROM users WHERE id = ? AND role = 'admin' AND active = 1").get(id);
    if (isAdmin && others === 0) throw new AppError('Il faut garder au moins un administrateur actif', 'INVALID');
  }

  /**
   * L'utilisateur a-t-il déjà laissé une trace (vente, journée de caisse,
   * mouvement…) ? On cherche son identifiant dans toutes les colonnes qui
   * désignent un utilisateur.
   */
  private userHasHistory(id: string): boolean {
    const tables = this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT IN ('users', 'user_prefs', 'user_rights', 'login_attempts', 'audit_log', 'outbox')").pluck().all() as string[];
    for (const t of tables) {
      const cols = (this.db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[])
        .map((c) => c.name)
        .filter((c) => c === 'user_id' || c.endsWith('_by') || c === 'cashier_id' || c === 'seller_id');
      for (const c of cols) if (this.db.prepare(`SELECT 1 FROM ${t} WHERE ${c} = ? LIMIT 1`).get(id)) return true;
    }
    return false;
  }

  /**
   * Supprime un utilisateur. Sans aucune trace, il est effacé ; sinon il reste
   * pour l'historique (son nom sur ses tickets et ses écritures), désactivé,
   * caché des listes, et son identifiant redevient libre.
   */
  deleteUser(byUserId: string, id: string): { erased: boolean } {
    const user = this.getUser(id);
    if (user.deleted_at) return { erased: false };
    if (id === byUserId) throw new AppError('Vous ne pouvez pas supprimer votre propre compte', 'INVALID');
    this.keepOneAdmin(id);
    return this.tx(() => {
      // Avec un serveur, un autre PC peut avoir des ventes de lui pas encore reçues : on le garde.
      const erased = !this.getSetting('sync.deviceId') && !this.userHasHistory(id);
      if (erased) {
        this.db.prepare('UPDATE audit_log SET user_id = NULL WHERE user_id = ?').run(id);
        for (const t of ['user_prefs', 'login_attempts']) this.db.prepare(`DELETE FROM ${t} WHERE user_id = ?`).run(id);
        this.db.prepare('DELETE FROM user_rights WHERE id = ?').run(id);
        this.db.prepare('UPDATE staff SET user_id = NULL WHERE user_id = ?').run(id);
        this.db.prepare('DELETE FROM users WHERE id = ?').run(id);
        this.enqueue(null, 'user', id, 'delete', null);
      } else {
        this.db
          .prepare('UPDATE users SET active = 0, deleted_at = ?, badge = NULL, photo = NULL, login = ?, register_id = NULL, emoney_register_id = NULL, emoney_register_ids = NULL, bank_register_id = NULL WHERE id = ?')
          .run(this.now(), `${user.login}~${id.slice(0, 8)}`, id);
        this.enqueue(null, 'user', id, 'upsert', this.getUser(id));
      }
      this.audit(byUserId, 'user.delete', 'user', erased ? undefined : id, { name: user.name, login: user.login, erased });
      return { erased };
    });
  }

  /** Donne un badge à l'utilisateur (ou le refait : l'ancien badge ne marche plus). */
  newBadge(byUserId: string, id: string): User {
    const user = this.getUser(id);
    if (user.deleted_at) throw new AppError('Cet utilisateur a été supprimé', 'INVALID');
    let badge = '';
    do badge = `FX${String(randomInt(0, 100_000_000)).padStart(8, '0')}`;
    while (this.db.prepare('SELECT 1 FROM users WHERE badge = ?').get(badge));
    this.db.prepare('UPDATE users SET badge = ? WHERE id = ?').run(badge, id);
    const next = this.getUser(id);
    this.enqueue(null, 'user', id, 'upsert', next);
    this.audit(byUserId, 'user.badge', 'user', id);
    return next;
  }

  /** Photo de l'employé (data URL) imprimée sur son badge ; null sans photo. */
  userPhoto(id: string): string | null {
    return (this.db.prepare('SELECT photo FROM users WHERE id = ?').pluck().get(id) as string | null | undefined) ?? null;
  }

  /**
   * Photo de l'employé, déjà réduite par l'interface ; null la retire. Elle part
   * aux autres postes avec la fiche de l'utilisateur.
   */
  setUserPhoto(byUserId: string, id: string, photo: string | null): void {
    const user = this.getUser(id);
    if (user.deleted_at) throw new AppError('Cet utilisateur a été supprimé', 'INVALID');
    if (photo !== null) {
      if (typeof photo !== 'string' || !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(photo)) throw new AppError('Image invalide : choisissez une photo JPEG ou PNG', 'INVALID');
      if (photo.length > 200_000) throw new AppError('Photo trop lourde, même réduite : choisissez une autre image', 'INVALID');
    }
    this.tx(() => {
      this.db.prepare('UPDATE users SET photo = ? WHERE id = ?').run(photo, id);
      this.enqueue(null, 'user', id, 'upsert', {});
      this.audit(byUserId, photo ? 'user.photo' : 'user.photo_remove', 'user', id);
    });
  }

  /** Identifiant de l'utilisateur dont on a scanné le badge (null si inconnu). */
  loginForBadge(badge: string): string | null {
    const code = badge.trim().toUpperCase();
    if (!code) return null;
    return (this.db.prepare('SELECT login FROM users WHERE badge = ? AND active = 1 AND deleted_at IS NULL').pluck().get(code) as string | undefined) ?? null;
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

  /** Caisses électroniques attribuables à un utilisateur : chaque moyen (MTN, Orange, carte) ne va qu'à une de ses caisses. */
  private checkEmoneyRegisters(ids: string[]): string[] {
    const list = [...new Set(ids.filter(Boolean))].map((id) => this.checkRegister(id, 'electronic')!);
    this.checkEmoneyOverlap(list);
    return list;
  }

  /** Refuse deux caisses d'un même utilisateur qui reçoivent le même moyen ; `override` donne des moyens pas encore enregistrés. */
  private checkEmoneyOverlap(ids: string[], override: Record<string, string | null> = {}): void {
    const taken = new Map<string, string>();
    for (const id of ids) {
      const reg = this.getRegister(id);
      for (const m of registerMethods(id in override ? override[id] : reg.methods)) {
        const other = taken.get(m);
        if (other) {
          throw new AppError(`${other} et ${reg.name} reçoivent toutes les deux ${PAYMENT_METHODS[m]} : réglez les moyens de chaque caisse électronique (Administration › Caisses)`, 'INVALID');
        }
        taken.set(m, reg.name);
      }
    }
  }

  /** Utilisateurs actifs qui tiennent une caisse électronique. */
  emoneyHolders(registerId: string): User[] {
    return this.listUsers().filter((u) => u.active && emoneyRegisterIds(u).includes(registerId));
  }

  login(login: string, pin: string): User {
    const row = this.db
      .prepare('SELECT id, pin_hash, store_id FROM users WHERE (login = ? OR badge = ?) AND active = 1 AND deleted_at IS NULL')
      .get(login.trim().toLowerCase(), login.trim().toUpperCase()) as { id: string; pin_hash: string; store_id: string | null } | undefined;
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

  auditLog(limit = 200): AuditRow[] {
    return this.auditSearch({ limit });
  }

  /**
   * Journal d'audit cherchable : « qui a changé le prix de la Mutzig ? ».
   * Filtres par personne, par fiche (produit, client, fournisseur…), par
   * période et par mot (action, détails, nom de la fiche).
   */
  auditSearch(f: { userId?: string | null; entityId?: string | null; text?: string | null; from?: string | null; to?: string | null; action?: string | null; limit?: number } = {}): AuditRow[] {
    const text = f.text?.trim() ? `%${f.text.trim().toLowerCase()}%` : null;
    const to = f.to ? new Date(Date.parse(`${f.to}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10) : null;
    return this.db
      .prepare(
        `SELECT a.id, a.user_id, u.name AS user_name, a.action, a.entity, a.entity_id, a.details, a.at,
                CASE a.entity WHEN 'article' THEN (SELECT name FROM articles WHERE id = a.entity_id)
                              WHEN 'customer' THEN (SELECT name FROM customers WHERE id = a.entity_id)
                              WHEN 'supplier' THEN (SELECT name FROM suppliers WHERE id = a.entity_id)
                              WHEN 'user' THEN (SELECT name FROM users WHERE id = a.entity_id)
                              WHEN 'sale' THEN (SELECT number FROM sales WHERE id = a.entity_id)
                              WHEN 'warehouse' THEN (SELECT name FROM warehouses WHERE id = a.entity_id) END AS entity_name
         FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
         WHERE (@userId IS NULL OR a.user_id = @userId) AND (@entityId IS NULL OR a.entity_id = @entityId)
           AND (@action IS NULL OR a.action LIKE @action || '%')
           AND (@from IS NULL OR a.at >= @from) AND (@to IS NULL OR a.at < @to)
           AND (@text IS NULL OR lower(a.action) LIKE @text OR lower(COALESCE(a.details, '')) LIKE @text OR lower(COALESCE(u.name, '')) LIKE @text
                OR (a.entity = 'article' AND a.entity_id IN (SELECT id FROM articles WHERE lower(name) LIKE @text OR lower(code) LIKE @text))
                OR (a.entity = 'customer' AND a.entity_id IN (SELECT id FROM customers WHERE lower(name) LIKE @text))
                OR (a.entity = 'supplier' AND a.entity_id IN (SELECT id FROM suppliers WHERE lower(name) LIKE @text)))
         ORDER BY a.at DESC LIMIT @limit`,
      )
      .all({ userId: f.userId ?? null, entityId: f.entityId ?? null, action: f.action?.trim() || null, from: f.from ?? null, to, text, limit: Math.min(Math.max(f.limit ?? 300, 1), 2000) }) as AuditRow[];
  }

  /**
   * Nouvel employé au même poste qu'un autre : rôle, magasin, caisses,
   * dépôts de vente et privilèges personnels repris. Seuls le nom,
   * l'identifiant et le code sont à saisir.
   */
  copyUser(byUserId: string, fromId: string, input: { name: string; login: string; pin: string }): User {
    const from = this.getUser(fromId);
    if (from.deleted_at) throw new AppError('Cet utilisateur a été supprimé', 'INVALID');
    if (!input.name?.trim()) throw new AppError('Le nom est obligatoire', 'INVALID');
    return this.tx(() => {
      const user = this.createUser(byUserId, {
        name: input.name,
        login: input.login,
        pin: input.pin,
        role: from.role,
        storeId: from.store_id,
        registerId: from.register_id,
        emoneyRegisterIds: emoneyRegisterIds(from),
        bankRegisterId: from.bank_register_id,
        saleWarehouses: from.sale_warehouses ? (JSON.parse(from.sale_warehouses) as string[]) : null,
      });
      const priv = this.privileges(fromId);
      if (priv.grants.length || priv.revokes.length) this.savePrivileges(byUserId, user.id, priv);
      this.audit(byUserId, 'user.copy', 'user', user.id, { from: fromId });
      return this.getUser(user.id);
    });
  }

  // --- Brouillons ------------------------------------------------------------------

  /** Saisie en cours gardée sur ce PC : proposée au redémarrage après une coupure. */
  saveDraft(userId: string, key: string, label: string, data: unknown): void {
    const json = JSON.stringify(data);
    if (json.length > 2_000_000) throw new AppError('Brouillon trop volumineux', 'INVALID');
    this.db.prepare('INSERT OR REPLACE INTO ui_drafts (user_id, key, label, data, updated_at) VALUES (?, ?, ?, ?, ?)').run(userId, key, label.slice(0, 120), json, this.now());
  }

  draft(userId: string, key: string): { label: string; data: unknown; updated_at: string } | null {
    const row = this.db.prepare('SELECT label, data, updated_at FROM ui_drafts WHERE user_id = ? AND key = ?').get(userId, key) as { label: string; data: string; updated_at: string } | undefined;
    return row ? { label: row.label, data: JSON.parse(row.data) as unknown, updated_at: row.updated_at } : null;
  }

  drafts(userId: string): { key: string; label: string; updated_at: string }[] {
    return this.db.prepare('SELECT key, label, updated_at FROM ui_drafts WHERE user_id = ? ORDER BY updated_at DESC').all(userId) as never;
  }

  clearDraft(userId: string, key: string): void {
    this.db.prepare('DELETE FROM ui_drafts WHERE user_id = ? AND key = ?').run(userId, key);
  }

}
