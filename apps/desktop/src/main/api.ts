import {
  type DenominationCount,
  type BarcodeLabelFormatId,
  type BarcodeLabelOptions,
  type LabelFormatId,
  barcodeLabelsHtml,
  loyaltyCardHtml,
  reminderMessage,
  whatsappLink,
  labelsHtml,
  xlsxWorkbook,
  type Fcfa,
  type Milli,
  type MovementType,
  type Payment,
  type PaymentMethod,
  type Permission,
  type PriceLevel,
  type StatementLine,
  type StockLevel,
  type RegisterKind,
  type StoreSettings,
  type PosLayout,
  POS_LAYOUTS,
  type DocFormat,
  type DocTemplate,
  type DocVariant,
  effectiveTemplates,
  sampleDocData,
} from '@superette/core';
import {
  AppError,
  isPayout,
  COMMITMENT_KINDS,
  SECURITY_KINDS,
  inspectBackup,
  STAFF_CATEGORIES,
  type ArticleInput,
  type AttentionKey,
  type BootstrapInput,
  type Context,
  type CustomerInput,
  type CustomerPaymentMethod,
  type DigestConfig,
  type DisclosuresInput,
  type ExpenseInput,
  type ChargePlanInput,
  type Period,
  type SalesRegisterFilter,
  type QuoteInput,
  type QuoteState,
  type AccountRole,
  type JournalCode,
  type LabelItem,
  type SalesReportInput,
  type ReceptionLine,
  type Role,
  type UserRegisters,
  type SaleLineInput,
  type Services,
  type PromotionInput,
  type PurchaseOrderLineInput,
  type SupplierInput,
  type SupplierPaymentMethod,
  type CentralNature,
  type CashInInput,
  type CashOutInput,
  type StaffInput,
  type InventoryInput,
  type InventorySheetModel,
  type TransferInput,
  type TransferStatus,
  type StockRequestStatus,
  type RebateRuleInput,
  type RecipeInput,
  type ProductionStatus,
  type StoreOptions,
  type User,
  type DeliveryInput,
  type DeliveryStatus,
} from '@superette/db';

import type { SyncRunner } from './sync';
import type { Updater } from './updater';

/** Actions du poste qui passent par Windows (fenêtres de choix, redémarrage). */
export interface SystemHooks {
  chooseFolder(title: string): Promise<string | null>;
  chooseBackupFile(): Promise<string | null>;
  openFolder(path: string): Promise<void>;
  /** Ferme la base, la remplace par la sauvegarde et relance l'application. */
  restore(file: string, userId: string): void;
  /** Résumé du soir par e-mail : chiffre le mot de passe pour ce PC, envoie le résumé du jour. */
  digest?: { seal(password: string): string; sendNow(): Promise<string> };
  /** Mise à jour automatique du logiciel (absente dans les tests). */
  updater?: Updater;
}

export interface InvoicePrintOptions {
  templateId?: string | null;
  /** Vente : facture (par défaut) ou bon de livraison. */
  doc?: 'invoice' | 'delivery';
  format?: DocFormat | null;
  output?: 'print' | 'pdf';
  duplicate?: boolean;
}

export interface Printer {
  /** `newSale` : ticket d'une vente qui vient d'être encaissée (ouvre le tiroir selon les réglages). */
  /** `duplicate` : le ticket a déjà été imprimé. Renvoie false si rien n'est sorti (impression automatique coupée). */
  ticket(saleId: string, opts?: { newSale?: boolean; copies?: number; templateId?: string | null; force?: boolean; duplicate?: boolean }): Promise<boolean>;
  /** Tiroir d'une vente enregistrée sans ticket (F4) : il s'ouvre selon les réglages, comme avec le ticket. */
  saleDrawer(saleId: string): Promise<void>;
  zReport(sessionId: string): Promise<void>;
  /** Bon de versement à la caisse centrale ou de remise de fond. */
  centralVoucher(movementId: string): Promise<void>;
  /** Bon d'un mouvement de caisse électronique : versement vers la centrale, transfert, banque… */
  emoneyVoucher(movementId: string): Promise<void>;
  /** Rapport de clôture A4 : Z, mouvements d'espèces et liste des ventes de la journée. */
  /** Rapport A4 d'une journée ; blind : bon de clôture d'une caisse électronique ou banque sans l'attendu ni l'écart. */
  sessionReport(sessionId: string, blind?: boolean): Promise<void>;
  openDrawer(): Promise<void>;
  testPage(withDrawer: boolean): Promise<void>;
  /** Bon de commande et facture d'achat selon un modèle (A4 par défaut). Renvoient false si annulé. */
  purchaseOrder(orderId: string, opts?: InvoicePrintOptions): Promise<boolean>;
  previewPurchaseOrder(orderId: string, opts?: InvoicePrintOptions): { templateId: string; html: string };
  /** Facture selon un modèle (A4 par défaut) ; `output: 'pdf'` l'enregistre. Renvoie false si annulé. */
  invoice(saleId: string, opts?: InvoicePrintOptions): Promise<boolean>;
  /** Page HTML de la facture selon le modèle, pour l'aperçu. */
  previewInvoice(saleId: string, opts?: InvoicePrintOptions): { templateId: string; html: string };
  /** Relevé de compte A4, imprimé ou enregistré en PDF (false : enregistrement annulé). */
  statement(storeId: string, customerId: string, from?: string | null, to?: string | null, output?: 'print' | 'pdf'): Promise<boolean>;
  customerReceipt(paymentId: string): Promise<void>;
  vatReturn(storeId: string, month: string): Promise<void>;
  trialBalance(storeId: string, from?: string | null, to?: string | null): Promise<void>;
  statements(storeId: string, from: string, to: string): Promise<void>;
  reconciliation(storeId: string, accountId: string, date: string, statementBalance: number | null): Promise<void>;
  taxAssessment(storeId: string, year: number): Promise<void>;
  notes(storeId: string, year: number): Promise<void>;
  expenseVoucher(expenseId: string): Promise<void>;
  rebateVoucher(entryId: string): Promise<void>;
  /** Reçu d'une entrée ou bon d'une sortie de caisse (ticket), tels que l'écran de trésorerie les montre. */
  deskTicket(sessionId: string, source: string, id: string, opts?: { duplicate?: boolean; authorizedBy?: string | null }): Promise<void>;
  /** Même reçu ou bon, sur une page A4. */
  deskA4(sessionId: string, source: string, id: string, opts?: { duplicate?: boolean }): Promise<void>;
  /** Décharge A4 à faire signer par le bénéficiaire d'une sortie. */
  discharge(sessionId: string, source: string, id: string): Promise<void>;
  salarySlip(salaryId: string): Promise<void>;
  payrollDeclarations(storeId: string, period: string): Promise<void>;
  staffStatement(staffId: string, from?: string | null, to?: string | null): Promise<void>;
  /** Bon d'une avance, d'un salaire ou d'un remboursement fait au bureau. */
  officeVoucher(entryId: string): Promise<void>;
  /** Devis ou proforma selon un modèle (A4 par défaut) ; `output: 'pdf'` l'enregistre. Renvoie false si annulé. */
  quote(quoteId: string, opts?: InvoicePrintOptions): Promise<boolean>;
  previewQuote(quoteId: string, opts?: InvoicePrintOptions): { templateId: string; html: string };
  journal(storeId: string, from?: string | null, to?: string | null, journal?: JournalCode | null): Promise<void>;
  list(): Promise<{ name: string; isDefault: boolean }[]>;
  /** Planche d'étiquettes déjà mise en page ; false si l'utilisateur annule. */
  labels(html: string, format: LabelFormatId): Promise<boolean>;
  /** Étiquettes produit : directement sur l'imprimante d'étiquettes du poste pour un rouleau, sinon fenêtre d'impression. */
  barcodeLabels(html: string, format: BarcodeLabelFormatId): Promise<boolean>;
  /** Page A4 (cartes de fidélité…) : la fenêtre d'impression Windows s'ouvre. */
  a4(body: string): Promise<void>;
  countSheet(storeId: string, warehouseId: string, departmentId?: string | null): Promise<void>;
  /** Fiche de comptage d'un inventaire (cases vides par conditionnement), par rayon. */
  inventorySheet(inventoryId: string, opts?: { model?: InventorySheetModel; output?: 'a4' | 'pdf' | 'ticket' }): Promise<void>;
  /** Résultat d'un inventaire : écarts valorisés, totaux et signatures. */
  inventoryResult(inventoryId: string): Promise<void>;
  /** Bon de transfert A4 : bon de route (expédition) ou bon de réception. */
  transferNote(transferId: string): Promise<void>;
  productionNote(orderId: string): Promise<void>;
  /** Facture fournisseur A4 : en-tête, lignes (prix, remise, gratuits, net) et règlements. */
  purchaseInvoice(invoiceId: string, opts?: InvoicePrintOptions): Promise<boolean>;
  previewPurchaseInvoice(invoiceId: string, opts?: InvoicePrintOptions): { templateId: string; html: string };
  /** Stock multi-magasin : un article par ligne, une colonne par magasin. */
  stockByStore(storeId: string, opts: { search?: string | null; familyId?: string | null; shortage?: boolean }): Promise<void>;
  reorderSheet(storeId: string, lines: { articleId: string; supplierId: string | null; qty: Milli; unitCost: Fcfa }[]): Promise<void>;
}

/** Réglages propres au PC que l'écran Paramètres peut changer. */
const LOCAL_SETTINGS = [
  'scale.prefixes',
  'scale.valueType',
  'printer.mode',
  'printer.name',
  'printer.host',
  'printer.port',
  'printer.columns',
  'printer.codepage',
  'printer.cut',
  'printer.enabled',
  'drawer.mode',
  'ticket.footer',
  'display.size',
  'pos.layout',
  'printer.listing',
  'printer.labels',
  'backup.autoTime',
  'backup.every',
];

/**
 * API exposée à l'interface. L'utilisateur connecté et le poste (magasin,
 * caisse) sont tenus ici, côté processus principal : l'écran ne peut pas
 * se faire passer pour un autre utilisateur ni valider à la place d'un gérant.
 */
export function createApi(s: Services, printer: Printer, sync: SyncRunner, appVersion: string, system: SystemHooks) {
  let user: User | null = null;
  /** Caisse choisie par un gérant ou l'administrateur qui n'a pas de caisse attribuée. */
  let chosenRegisterId: string | null = null;

  /** Droits réglés par rôle (Administration › Droits) : il suffit d'un des droits demandés. */
  const can = (u: User, need: readonly Permission[]) => need.some((p) => s.admin.hasRight(u, p));
  const requireUser = (need?: readonly Permission[]): User => {
    if (!user) throw new AppError('Session expirée, reconnectez-vous', 'NOT_LOGGED_IN');
    if (need && !can(user, need)) throw new AppError("Vous n'avez pas les droits pour cette action", 'FORBIDDEN');
    return user;
  };
  /** Réservé au rôle Administrateur (magasins, serveur, restauration). */
  const requireAdmin = (): User => {
    const u = requireUser();
    if (u.role !== 'admin') throw new AppError("Réservé à l'administrateur", 'FORBIDDEN');
    return u;
  };
  /**
   * Caisse de travail : celle attribuée à l'utilisateur, quel que soit le PC.
   * Sans caisse attribuée, seuls le gérant et l'administrateur vendent, sur la
   * caisse qu'ils ont choisie ou, à défaut, celle de ce PC.
   */
  const workRegister = (u: User, storeId: string, station: NonNullable<ReturnType<typeof s.admin.station>>) => {
    const assigned = s.admin.getUser(u.id).register_id;
    const usable = (id: string | null) => {
      if (!id) return null;
      const r = s.admin.getRegister(id);
      return r.active && r.kind === 'cash' && r.store_id === storeId ? r : null;
    };
    if (assigned) return usable(assigned);
    if (!isSupervisor(u)) return null;
    return usable(chosenRegisterId) ?? usable(station.register?.id ?? null);
  };
  const ctx = (need?: readonly Permission[]): Context => {
    const u = requireUser(need);
    const station = s.admin.station();
    if (!station) throw new AppError("Ce poste n'est pas configuré", 'NO_STATION');
    return { storeId: station.store.id, registerId: workRegister(u, station.store.id, station)?.id ?? null, userId: u.id };
  };
  const supervisor = (pin: string) => s.admin.authorizeSupervisor(pin);
  /** L'écran agit sur la caisse qu'il affiche : refus si la caisse de travail a changé entre-temps. */
  const sameRegister = (c: Context, registerId?: string): Context => {
    if (registerId && registerId !== c.registerId) throw new AppError("Vous ne travaillez plus sur cette caisse : rouvrez l'écran", 'REGISTER_CHANGED');
    return c;
  };

  const ADMIN: Permission[] = ['admin'];
  const ACCOUNTING: Permission[] = ['accounting'];
  const BANK: Permission[] = ['bank_reconciliation'];
  const STOCK: Permission[] = ['articles', 'stock', 'labels'];
  const POS: Permission[] = ['cash', 'credit'];
  const TREASURY: Permission[] = ['treasury'];
  const INVENTORY: Permission[] = ['inventory', 'inventory_count', 'inventory_close', 'inventory_cancel', 'inventory_edit', 'inventory_import', 'inventory_print'];
  const TRANSFERS: Permission[] = ['transfer_view', 'transfer_create', 'transfer_ship', 'transfer_receive', 'transfer_cancel'];
  const PRODUCTION: Permission[] = ['production', 'production_recipes', 'production_create', 'production_validate', 'production_cancel', ...STOCK];
  /** Paramètres du magasin de ce poste. */
  const settings = () => s.admin.storeSettings(ctx().storeId);
  /** Code interne donné à l'enregistrement d'un article sans code, si le magasin l'a choisi. */
  const autoBarcode = () => (settings().barcodeAuto ? settings().barcodeKind : null);
  const SALES: Permission[] = ['sales', 'reports', 'receivables'];
  /** Montants de la caisse : attendu, entrées, ventes de la journée, historique des journées et Z. */
  const AMOUNTS: Permission[] = ['cash_amounts'];
  const requireAmounts = () => requireUser(AMOUNTS);
  /**
   * Sans le droit « Voir tout le registre des factures », le caissier ne revoit
   * que ses trois dernières factures, pour les réimprimer.
   */
  const OWN_RECENT = 3;
  const ownRecent = (u: User) => s.pos.listSales({ storeId: ctx().storeId, userId: u.id, limit: OWN_RECENT });
  const requireSaleAccess = (saleId: string) => {
    const u = requireUser();
    if (can(u, ['sales', 'cash_amounts']) || ownRecent(u).some((x) => x.id === saleId)) return u;
    throw new AppError('Vous ne pouvez revoir que vos trois dernières factures', 'FORBIDDEN');
  };
  /** Facture d'une vente : juste après la vente par son vendeur (renvoie true), ou plus tard avec le droit de réimprimer. */
  const invoiceAccess = (saleId: string) => {
    const u = requireSaleAccess(saleId);
    const sale = s.pos.getSale(saleId);
    const fresh = sale.user_id === u.id && Date.now() - Date.parse(sale.created_at) < 15 * 60000;
    if (!fresh && !can(u, ['sale_reprint'])) throw new AppError("Vous n'avez pas le droit de réimprimer une facture", 'FORBIDDEN');
    return fresh;
  };
  /** La facture de la vente est déjà sortie une fois : la suivante est un duplicata. */
  const invoiceDuplicate = (saleId: string) => s.pos.getSale(saleId).invoice_prints > 0;
  const SUPPLIERS: Permission[] = ['purchases', 'suppliers', 'purchase_invoices', 'supplier_statement'];
  const STAFF: Permission[] = ['staff', 'staff_edit', 'staff_salaries'];
  /**
   * Encaisser et décaisser dans une journée ouverte : celle de sa caisse (espèces ou
   * électronique), ou de toute caisse pour le gérant. Le contexte prend la caisse de la journée.
   */
  const deskCtx = (sessionId: string): Context => {
    const c = ctx(['cash_desk']);
    const se = s.pos.getSession(sessionId);
    const mine = se.register_id === c.registerId || Object.values(s.pos.linkedRegisters(user!.id)).includes(se.register_id);
    if (!mine && !can(user!, ['cash_open'])) throw new AppError("Seuls le caissier de cette caisse et le gérant y encaissent ou décaissent", 'FORBIDDEN');
    return { ...c, registerId: se.register_id };
  };
  const CUSTOMERS: Permission[] = ['customers', 'receivables'];
  /** Gérant ou administrateur : leur présence vaut validation (code superviseur). */
  const isSupervisor = (u: User) => u.role === 'admin' || u.role === 'manager';

  return {
    // --- Application et connexion -------------------------------------------
    'app.state': () => ({
      version: appVersion,
      initialized: s.admin.isInitialized(),
      station: s.admin.station(),
      /** Utilisateur connecté et ses droits : menus et boutons s'y règlent. */
      user: user ? { ...user, rights: s.admin.userRights(user) } : null,
      /** Paramètres du magasin utiles à l'écran (le logo reste à part : il est lourd). */
      storeSettings: (() => {
        const station = s.admin.station();
        if (!station) return null;
        const { logo, ...rest } = s.admin.storeSettings(station.store.id);
        return { ...rest, hasLogo: Boolean(logo) };
      })(),
      /** Caisse sur laquelle l'utilisateur connecté vend (attribuée, ou choisie par le gérant). */
      register: (() => {
        const station = s.admin.station();
        return user && station ? workRegister(user, station.store.id, station) : null;
      })(),
      /** Le gérant ou l'administrateur sans caisse attribuée peut choisir sa caisse. */
      canChooseRegister: Boolean(user && isSupervisor(user) && !s.admin.getUser(user.id).register_id),
      /** Caisses électronique et banque de l'utilisateur : leurs paiements y vont. */
      linkedRegisters: (() => {
        if (!user) return { electronic: null, bank: null };
        const ids = s.pos.linkedRegisters(user.id);
        const named = (id: string | null) => (id ? { id, name: s.admin.getRegister(id).name } : null);
        return { electronic: named(ids.electronic), bank: named(ids.bank) };
      })(),
      /** Préférences de l'utilisateur : onglets rapides épinglés, dernière version vue. */
      prefs: user ? s.admin.prefs(user.id) : {},
      /** Licence de ce PC : essai, valable, à renouveler ou bloquée. */
      license: (() => {
        const { license, ...rest } = s.license.status();
        return { ...rest, client: license?.client ?? null };
      })(),
      /** Taille du texte réglée sur ce PC (Paramètres › Affichage). */
      display: s.admin.getSetting('display.size') === 'large' ? 'large' : 'normal',
      /** Présentation de l'écran de caisse : celle de ce PC s'il a une exception, sinon celle du magasin. */
      posLayout: ((): PosLayout => {
        const own = s.admin.getSetting('pos.layout');
        if (own && own in POS_LAYOUTS) return own as PosLayout;
        const station = s.admin.station();
        return station ? s.admin.storeSettings(station.store.id).posLayout : 'modern';
      })(),
    }),
    'prefs.set': (key: string, value: unknown) => s.admin.setPref(requireUser().id, key, value),
    'setup.bootstrap': (input: BootstrapInput) => {
      const result = s.admin.bootstrap(input);
      user = result.admin;
      return result;
    },
    'setup.activateRegister': (code: string) => s.admin.activateRegister(code),
    /** Nouveau PC : rejoint un magasin existant via le serveur central (avant toute connexion). */
    'setup.join': (url: string, activationCode: string) => sync.join(url, activationCode),
    'auth.login': (login: string, pin: string) => {
      chosenRegisterId = null;
      return (user = s.admin.login(login, pin));
    },
    'auth.logout': () => {
      user = null;
      chosenRegisterId = null;
    },
    /** Gérant ou administrateur sans caisse attribuée : caisse sur laquelle il travaille. */
    'pos.chooseRegister': (registerId: string | null) => {
      const u = requireUser();
      if (!isSupervisor(u) || s.admin.getUser(u.id).register_id) throw new AppError('Votre caisse est fixée par l’administrateur', 'FORBIDDEN');
      if (registerId) {
        const r = s.admin.getRegister(registerId);
        if (!r.active || r.kind !== 'cash' || r.store_id !== ctx().storeId) throw new AppError('Caisse indisponible', 'INVALID');
      }
      chosenRegisterId = registerId;
      return ctx().registerId;
    },
    'pos.registers': () => s.admin.listRegisters(ctx().storeId).filter((r) => r.active && r.kind === 'cash').map(({ activation_code: _, ...r }) => r),
    'auth.checkSupervisor': (pin: string) => {
      const sup = supervisor(pin);
      return { id: sup.id, name: sup.name };
    },

    // --- Administration -----------------------------------------------------
    'admin.stores': () => (requireUser(), s.admin.listStores()),
    'admin.createStore': (input: { storeCode: string; storeName: string; address?: string; phone?: string; taxpayerNumber?: string }) => {
      const u = requireAdmin();
      s.license.assertCanAddStore(s.admin.listStores().length);
      return s.admin.createStore(u.id, input);
    },
    'admin.updateStore': (id: string, patch: { name?: string; address?: string | null; phone?: string | null; taxpayer_number?: string | null }) =>
      s.admin.updateStore(requireAdmin().id, id, patch),
    /**
     * Options du magasin de ce poste : la TVA est réservée à l'administrateur,
     * la vente sans stock au droit « Ignorer la gestion des stocks ».
     */
    'admin.storeOptions': (options: StoreOptions) => {
      const u = requireUser();
      if (options.vatEnabled !== undefined || options.cashGapThreshold !== undefined) requireAdmin();
      if (options.ignoreStock !== undefined && !can(u, ['ignore_stock'])) throw new AppError("Vous n'avez pas le droit de changer la gestion des stocks", 'FORBIDDEN');
      return s.admin.setStoreOptions(u.id, ctx().storeId, options);
    },
    'admin.registers': (storeId: string) => (requireUser(ADMIN), s.admin.listRegisters(storeId)),
    'admin.createRegister': (storeId: string, name?: string, kind?: RegisterKind) => s.admin.createRegister(requireAdmin().id, storeId, name, kind),
    'admin.updateRegister': (id: string, patch: { name?: string; active?: boolean }) => s.admin.updateRegister(requireAdmin().id, id, patch),
    'admin.warehouses': () => s.admin.listWarehouses(ctx().storeId),
    'admin.createWarehouse': (name: string, kind: 'shop' | 'reserve' | 'cold') => s.admin.createWarehouse(ctx(['warehouses_manage']).storeId, name, kind),
    'admin.users': () => {
      requireUser(ADMIN);
      const locked = new Set(s.admin.lockedUsers());
      const privileged = s.admin.privilegeCounts();
      return s.admin.listUsers().map((u) => ({ ...u, locked: locked.has(u.id), privileges: privileged[u.id] ?? null }));
    },
    // Seul l'administrateur crée un administrateur ou touche à son compte.
    'admin.createUser': (input: UserRegisters & { name: string; login: string; pin: string; role: Role; storeId: string | null; saleWarehouses?: string[] | null }) => {
      const u = requireUser(['users_manage']);
      if (input.role === 'admin' && u.role !== 'admin') throw new AppError("Seul l'administrateur crée un administrateur", 'FORBIDDEN');
      return s.admin.createUser(u.id, input);
    },
    'admin.updateUser': (id: string, patch: UserRegisters & { name?: string; role?: Role; storeId?: string | null; active?: boolean; pin?: string; saleWarehouses?: string[] | null }) => {
      const u = requireUser(['users_manage']);
      if (u.role !== 'admin' && (patch.role === 'admin' || s.admin.getUser(id).role === 'admin')) throw new AppError("Seul l'administrateur modifie un administrateur", 'FORBIDDEN');
      return s.admin.updateUser(u.id, id, patch);
    },
    'admin.unlockUser': (id: string) => s.admin.unlockUser(requireUser(['users_manage']).id, id),
    'admin.vatRates': () => (requireUser(), s.admin.listVatRates()),
    /** TVA réactivée : remettre d'un coup les articles exonérés à 19,25 %. */
    'admin.articlesStandardRate': () => s.admin.setArticlesRate(requireAdmin().id, 'standard'),
    'admin.settings': () => {
      requireUser();
      return Object.fromEntries(LOCAL_SETTINGS.map((k) => [k, s.admin.getSetting(k)])) as Record<string, string | null>;
    },
    /** Réglages propres à ce PC (imprimante, balance, affichage, heure de sauvegarde). */
    'admin.saveSettings': (values: Record<string, string>) => {
      requireUser(['settings_edit']);
      for (const [k, v] of Object.entries(values)) {
        if (!LOCAL_SETTINGS.includes(k)) throw new AppError(`Réglage inconnu : ${k}`, 'INVALID');
        if (k === 'pos.layout') {
          requireAdmin();
          if (v && !(v in POS_LAYOUTS)) throw new AppError("Présentation de l'écran de caisse inconnue", 'INVALID');
        }
        if (k === 'backup.autoTime') s.backups.configure(user!.id, { autoTime: v || null });
        else if (k === 'backup.every') s.backups.configure(user!.id, { everyMinutes: Number(v) || 0 });
        else s.admin.setSetting(k, v);
      }
    },
    /** Nom, adresse, téléphone et NIU du magasin de ce poste. */
    'admin.updateStoreIdentity': (patch: { name?: string; address?: string | null; phone?: string | null; taxpayer_number?: string | null }) => {
      const c = ctx(['settings_edit']);
      if (patch.name !== undefined && !patch.name.trim()) throw new AppError('Le nom du magasin est obligatoire', 'INVALID');
      const { name, address, phone, taxpayer_number } = patch;
      return s.admin.updateStore(c.userId, c.storeId, Object.fromEntries(Object.entries({ name, address, phone, taxpayer_number }).filter(([, v]) => v !== undefined)));
    },
    'admin.rights': () => (requireUser(ADMIN), s.admin.rightsMatrix()),
    'admin.saveRights': (role: Role, rights: Permission[]) => s.admin.saveRights(requireAdmin().id, role, rights),
    /** Privilèges d'un utilisateur : droits de son rôle, droits accordés et retirés à titre personnel. */
    'admin.privileges': (userId: string) => {
      requireUser(ADMIN);
      const target = s.admin.getUser(userId);
      return { role: target.role, roleRights: s.admin.rights(target.role), ...s.admin.privileges(userId) };
    },
    'admin.savePrivileges': (userId: string, input: { grants: Permission[]; revokes: Permission[] }) => s.admin.savePrivileges(requireAdmin().id, userId, input),
    /** Autres utilisateurs actifs qui ont ce droit. */
    'admin.holders': (permission: Permission) => (requireUser(ADMIN), s.admin.holders(permission)),
    /** Paramètres du magasin de ce poste (Administration › Paramètres). */
    'admin.storeSettings': () => s.admin.storeSettings(ctx().storeId),
    'admin.saveStoreSettings': (patch: Partial<StoreSettings>) => {
      const c = ctx(['settings_edit']);
      if (patch.posLayout !== undefined) requireAdmin();
      return s.admin.saveStoreSettings(c.userId, c.storeId, patch);
    },
    'admin.audit': () => (requireUser(['audit']), s.admin.auditLog()),
    'admin.printers': () => (requireUser(), printer.list()),
    'admin.printTest': (withDrawer: boolean) => (requireUser(['settings_edit']), printer.testPage(withDrawer)),

    // --- Licence -------------------------------------------------------------
    /** État de la licence et code machine de ce PC (Administration › Licence). */
    'license.status': () => (requireUser(), s.license.status()),
    /** Active la clé envoyée par l'éditeur ; un PC relié la transmet aussitôt au serveur central. */
    'license.activate': (key: string) => {
      const status = s.license.activate(requireAdmin().id, key);
      if (s.sync.credentials()) void sync.now().catch((e) => console.warn('[licence]', e instanceof Error ? e.message : e));
      return status;
    },

    // --- Serveur central ----------------------------------------------------
    'update.state': () => (requireUser(), system.updater?.state() ?? null),
    'update.check': () => (requireAdmin(), system.updater ? system.updater.check() : null),
    'update.setUrl': (url: string) => {
      requireAdmin();
      if (!system.updater) throw new AppError("La mise à jour automatique n'est pas disponible sur ce poste", 'INVALID');
      try {
        return system.updater.setUrl(url);
      } catch (e) {
        throw new AppError(e instanceof Error ? e.message : String(e), 'INVALID');
      }
    },
    'update.install': () => {
      requireUser();
      if (!system.updater) throw new AppError("La mise à jour automatique n'est pas disponible sur ce poste", 'INVALID');
      try {
        system.updater.install();
      } catch (e) {
        throw new AppError(e instanceof Error ? e.message : String(e), 'INVALID');
      }
    },
    'sync.state': () => (requireUser(), s.sync.state()),
    'sync.connect': (url: string, enrollmentKey: string) => (requireAdmin(), sync.connect(url, enrollmentKey)),
    'sync.now': () => (requireUser(), sync.now()),
    'sync.conflicts': () => (requireUser(ADMIN), s.sync.conflicts()),
    'sync.disconnect': () => {
      requireAdmin();
      s.sync.disconnect();
    },

    // --- Catalogue ----------------------------------------------------------
    'catalogue.search': (query: string, opts?: { includeInactive?: boolean; familyId?: string }) =>
      s.catalogue.searchArticles(query, ctx().storeId, opts),
    'catalogue.suggest': (query: string) => s.catalogue.suggestArticles(query, ctx().storeId),
    'catalogue.get': (id: string) => s.catalogue.getArticle(id, ctx().storeId),
    'catalogue.photo': (id: string) => (requireUser(), s.catalogue.photo(id)),
    // Photo : qui crée ou modifie un article peut lui mettre une photo.
    'catalogue.setPhoto': (id: string, input: { photo: string; thumb: string } | null) =>
      s.catalogue.setPhoto(requireUser(['article_create', 'article_edit', 'sale_new_article']).id, id, input),
    'catalogue.save': (input: ArticleInput, id?: string) => {
      const u = requireUser(['article_create', 'article_edit', 'article_price', 'article_deactivate', 'sale_new_article']);
      // Magasin sans TVA : un nouvel article est exonéré, un article existant garde son taux.
      const noVat = s.admin.vatDisabled(ctx().storeId);
      if (!id) {
        if (!can(u, ['article_create', 'sale_new_article'])) throw new AppError("Vous n'avez pas le droit d'ajouter des produits", 'FORBIDDEN');
        return s.catalogue.saveArticle(u.id, noVat ? { ...input, vatRateId: s.admin.exemptRateId() } : input, id, { autoBarcode: autoBarcode() });
      }
      const cur = s.catalogue.getArticle(id, ctx().storeId);
      if (noVat) input = { ...input, vatRateId: cur.vat_rate_id };
      const priceChanged =
        input.salePrice !== cur.sale_price ||
        input.purchasePrice !== cur.purchase_price ||
        (input.wholesalePrice ?? null) !== cur.wholesale_price ||
        (input.superWholesalePrice ?? null) !== cur.super_wholesale_price ||
        (input.packPurchasePrice !== undefined && input.packPurchasePrice !== cur.pack_purchase_price);
      if (priceChanged && !can(u, ['article_price'])) throw new AppError("Vous n'avez pas le droit de modifier les prix des produits", 'FORBIDDEN');
      if ((input.active ?? true) !== (cur.active === 1) && !can(u, ['article_deactivate'])) throw new AppError("Vous n'avez pas le droit de désactiver un produit", 'FORBIDDEN');
      const otherChanged =
        input.name.trim() !== cur.name ||
        (input.familyId ?? null) !== cur.family_id ||
        input.unit !== cur.unit ||
        input.vatRateId !== cur.vat_rate_id ||
        (input.minQty ?? null) !== cur.min_qty ||
        (input.alertQty ?? null) !== cur.alert_qty ||
        (input.maxQty ?? null) !== cur.max_qty;
      if (otherChanged && !can(u, ['article_edit'])) throw new AppError("Vous n'avez pas le droit de modifier la fiche d'un produit", 'FORBIDDEN');
      return s.catalogue.saveArticle(u.id, input, id, { autoBarcode: autoBarcode() });
    },
    'catalogue.setStorePrice': (articleId: string, price: Fcfa | null) => {
      const c = ctx(['store_price']);
      s.catalogue.setStorePrice(c.userId, articleId, c.storeId, price);
    },
    'catalogue.priceHistory': (articleId: string) => (requireUser(), s.catalogue.priceHistory(articleId)),
    'catalogue.departments': () => (requireUser(), s.catalogue.listDepartments()),
    'catalogue.createDepartment': (name: string) => (requireUser(['article_families']), s.catalogue.createDepartment(name)),
    'catalogue.createFamily': (departmentId: string, name: string) => (requireUser(['article_families']), s.catalogue.createFamily(departmentId, name)),
    'catalogue.newInternalBarcode': () => (requireUser(['article_create', 'article_edit', 'sale_new_article']), s.catalogue.generateInternalBarcode(settings().barcodeKind)),
    'catalogue.assignMissingBarcodes': () => s.catalogue.assignMissingBarcodes(requireUser(['article_edit']).id, settings().barcodeKind),
    'barcode.info': () => (requireUser(), s.catalogue.internalBarcodeInfo(settings().barcodeKind)),
    'catalogue.quickKeys': () => s.catalogue.quickKeys(ctx().storeId),
    'catalogue.scan': (code: string) => s.catalogue.scan(code, ctx().storeId),
    'catalogue.import': (rows: Parameters<Services['catalogue']['importArticles']>[1]) =>
      s.catalogue.importArticles(requireUser(['import']).id, rows, { noVat: s.admin.vatDisabled(ctx().storeId) }),

    // --- Stock --------------------------------------------------------------
    'stock.list': (opts?: { warehouseId?: string; search?: string; level?: StockLevel }) => s.stock.list(ctx().storeId, opts),
    'stock.receive': (input: { warehouseId: string; reference?: string; supplier?: string; supplierId?: string | null; lines: ReceptionLine[] }) =>
      s.stock.receive(ctx(['stock_receive']), input),
    'stock.loss': (input: { warehouseId: string; articleId: string; qty: Milli; type: MovementType; reason: string; lotId?: string | null }) =>
      s.stock.recordLoss(ctx(['stock_loss']), input),
    'stock.transfer': (input: { fromWarehouseId: string; toWarehouseId: string; lines: { articleId: string; qty: Milli }[] }) =>
      s.stock.transfer(ctx(['transfer_direct']), input),
    // --- Bons de transfert entre dépôts --------------------------------------------
    'transfers.list': (status?: TransferStatus | null, filters?: { from?: string | null; to?: string | null; warehouseId?: string | null }) =>
      s.transfers.list(ctx(TRANSFERS).storeId, { status, ...filters }),
    'transfers.get': (id: string) => (requireUser(TRANSFERS), s.transfers.get(id)),
    'transfers.create': (input: TransferInput) => s.transfers.create(ctx(['transfer_create']), input),
    'transfers.update': (id: string, input: TransferInput) => s.transfers.update(ctx(['transfer_create']), id, input),
    'transfers.ship': (id: string, routeNumber?: string | null) => s.transfers.ship(ctx(['transfer_ship']), id, routeNumber),
    'transfers.receive': (id: string, input?: { receptionNumber?: string | null; lines?: { articleId: string; receivedQty: Milli }[] }) => {
      const c = ctx(['transfer_receive']);
      // Paramètre « deux utilisateurs » : celui qui a expédié ne réceptionne pas.
      if (settings().transferTwoUsers && s.transfers.get(id).transfer.shipped_by === c.userId) {
        throw new AppError("Un autre utilisateur que celui qui l'a expédié doit réceptionner ce transfert", 'FORBIDDEN');
      }
      return s.transfers.receive(c, id, input);
    },
    'transfers.cancel': (id: string) => s.transfers.cancel(ctx(['transfer_cancel']), id),
    /** Brouillon effacé ; expédié ou réceptionné : annulé, la marchandise revient au départ. */
    'transfers.remove': (id: string) => s.transfers.remove(ctx(['transfer_cancel']), id),
    /** Modifier un transfert expédié ou réceptionné : annulé puis repris en brouillon. */
    'transfers.reopen': (id: string) => {
      const c = ctx(['transfer_cancel']);
      requireUser(['transfer_create']);
      return s.transfers.reopen(c, id);
    },
    'transfers.movements': (id: string) => (requireUser(TRANSFERS), s.transfers.movements(id)),
    // --- Fabrication -------------------------------------------------------------
    'production.recipes': (includeInactive?: boolean) => (requireUser(PRODUCTION), s.production.recipes({ includeInactive })),
    'production.saveRecipe': (input: RecipeInput, id?: string | null) => s.production.saveRecipe(ctx(['production_recipes']), input, id ?? undefined),
    'production.archiveRecipe': (id: string) => s.production.archiveRecipe(ctx(['production_recipes']), id),
    'production.orders': (status?: ProductionStatus | null) => s.production.orders(ctx(PRODUCTION).storeId, { status }),
    'production.order': (id: string) => (requireUser(PRODUCTION), s.production.getOrder(id)),
    'production.create': (input: { recipeId: string; warehouseId: string; qty: Milli; label?: string | null; expiry?: string | null }) => s.production.create(ctx(['production_create']), input),
    'production.produce': (id: string) => s.production.produce(ctx(['production_validate']), id),
    'production.cancel': (id: string) => s.production.cancel(ctx(['production_cancel']), id),
    'production.print': (id: string) => (requireUser(PRODUCTION), printer.productionNote(id)),
    'transfers.print': async (id: string) => {
      requireUser(TRANSFERS);
      await printer.transferNote(id);
      s.transfers.markPrinted(id);
    },
    // --- Monitoring de l'évolution du stock --------------------------------------
    'monitoring.changes': (articleId: string, warehouseId: string | null, from: string, to: string) =>
      s.monitoring.changes(ctx(['stock_monitoring']).storeId, { articleId, warehouseId, from, to }),
    'monitoring.requests': (opts?: { articleId?: string | null; status?: StockRequestStatus | null; from?: string | null; to?: string | null }) =>
      s.monitoring.requests(ctx(['stock_monitoring', 'stock_request', 'stock_adjust', 'stock_decide']).storeId, opts),
    // Le gérant corrige directement ; le magasinier fait une demande que le gérant valide.
    'monitoring.request': (input: { articleId: string; warehouseId: string; newQty: Milli; reason: string }) => {
      const c = ctx(['stock_request', 'stock_adjust']);
      return s.monitoring.request(c, input, can(user!, ['stock_adjust']));
    },
    'monitoring.decide': (id: string, approve: boolean, note?: string | null) => s.monitoring.decide(ctx(['stock_decide']), id, approve, note ?? null),
    // --- Inventaires enregistrés -------------------------------------------------
    'inventories.list': () => s.inventories.list(ctx(INVENTORY).storeId),
    'inventories.get': (id: string) => (requireUser(INVENTORY), s.inventories.get(id)),
    'inventories.history': (id: string) => (requireUser(INVENTORY), s.inventories.history(id)),
    'inventories.create': (input: InventoryInput) => s.inventories.create(ctx(['inventory']), input),
    'inventories.addArticle': (id: string, articleId: string) => s.inventories.addArticle(ctx(['inventory', 'inventory_count', 'inventory_edit']), id, articleId),
    'inventories.removeArticle': (id: string, articleId: string) => s.inventories.removeArticle(ctx(['inventory_edit']), id, articleId),
    'inventories.setCount': (id: string, articleId: string, counted: Milli | null, detail?: number[] | null) =>
      s.inventories.setCount(ctx(['inventory_count']), id, articleId, counted, detail),
    'inventories.import': (id: string, rows: { code: string; qty: number }[]) => s.inventories.importCounts(ctx(['inventory_import']), id, rows),
    'inventories.close': (id: string) => s.inventories.close(ctx(['inventory_close']), id),
    'inventories.cancel': (id: string) => s.inventories.cancel(ctx(['inventory_cancel']), id),
    'inventories.printSheet': (id: string, opts?: { model?: InventorySheetModel; output?: 'a4' | 'pdf' | 'ticket' }) => (requireUser(['inventory_print']), printer.inventorySheet(id, opts)),
    'inventories.printResult': (id: string) => (requireUser(['inventory_print']), printer.inventoryResult(id)),
    'stock.inventory': (input: { warehouseId: string; counts: { articleId: string; counted: Milli; countedAt: string }[] }) =>
      s.stock.applyInventory(ctx(['inventory_close']), input),
    'stock.printCountSheet': (warehouseId: string, departmentId?: string | null) => {
      const storeId = ctx(['inventory_print', 'stock']).storeId;
      return printer.countSheet(storeId, warehouseId || s.admin.salesWarehouse(storeId).id, departmentId);
    },
    'labels.candidates': (opts?: { redo?: boolean; departmentId?: string | null; search?: string }) => s.labels.candidates(ctx(STOCK).storeId, opts),
    'labels.preview': (items: LabelItem[], format: LabelFormatId, skip?: number) => labelsHtml(s.labels.build(ctx(STOCK).storeId, items), format, skip),
    'labels.print': async (items: LabelItem[], format: LabelFormatId, skip?: number) => {
      const storeId = ctx(STOCK).storeId;
      const printed = await printer.labels(labelsHtml(s.labels.build(storeId, items), format, skip), format);
      if (printed) s.labels.markPrinted(storeId, items);
      return printed;
    },
    'barcode.preview': (items: LabelItem[], format: BarcodeLabelFormatId, opts: BarcodeLabelOptions, skip?: number) => {
      const storeId = ctx().storeId;
      return barcodeLabelsHtml(s.labels.barcodeLabels(storeId, items, s.admin.getStore(storeId).name), format, opts, skip);
    },
    'barcode.print': (items: LabelItem[], format: BarcodeLabelFormatId, opts: BarcodeLabelOptions, skip?: number) => {
      const storeId = ctx().storeId;
      return printer.barcodeLabels(barcodeLabelsHtml(s.labels.barcodeLabels(storeId, items, s.admin.getStore(storeId).name), format, opts, skip), format);
    },
    'stock.expiring': (days?: number) => s.stock.expiringLots(ctx().storeId, days ?? settings().expiryAlertDays),
    'stock.lots': (articleId: string) => s.stock.lotsOf(articleId, ctx().storeId),
    'stock.movements': (articleId?: string, types?: MovementType[]) => s.stock.movements(ctx(['stock_moves', 'stock']).storeId, { articleId, types }),
    'stock.shelving': () => s.controls.shelving(ctx().storeId),
    'stock.byWarehouse': (opts: { search?: string | null; inStockOnly?: boolean }) => s.controls.stockByWarehouse(ctx().storeId, opts),
    /** Stock multi-magasin (onglet Stock MM) : même droit que l'état du stock. */
    'stock.byStore': (opts: { search?: string | null; familyId?: string | null; shortage?: boolean }) => s.controls.stockByStore(ctx().storeId, opts),
    'stock.printByStore': (opts: { search?: string | null; familyId?: string | null; shortage?: boolean }) => printer.stockByStore(ctx().storeId, opts),

    // --- Fournisseurs et achats -----------------------------------------------
    'suppliers.list': (opts?: { search?: string; includeInactive?: boolean }) => (requireUser(), s.purchases.listSuppliers(opts)),
    'suppliers.get': (id: string) => (requireUser(), s.purchases.getSupplier(id)),
    'suppliers.save': (input: SupplierInput, id?: string) => {
      const u = requireUser(['supplier_edit']);
      // Nouveau fournisseur : le délai de paiement par défaut vient des paramètres.
      return s.purchases.saveSupplier(u.id, id || input.paymentTermsDays !== undefined ? input : { ...input, paymentTermsDays: settings().supplierDefaultDays }, id);
    },
    'suppliers.articles': (supplierId: string) => (requireUser(), s.purchases.supplierArticles(supplierId)),
    'suppliers.ofArticle': (articleId: string) => (requireUser(), s.purchases.articleSuppliers(articleId)),
    'suppliers.setArticle': (input: Parameters<Services['purchases']['setSupplierArticle']>[1]) =>
      s.purchases.setSupplierArticle(requireUser(['supplier_articles']).id, input),
    'suppliers.removeArticle': (id: string) => s.purchases.removeSupplierArticle(requireUser(['supplier_articles']).id, id),
    'purchases.orders': (opts?: { supplierId?: string; open?: boolean }) => s.purchases.listOrders(ctx().storeId, opts),
    'purchases.order': (id: string) => (requireUser(), s.purchases.getOrder(id)),
    'purchases.createOrder': (input: { supplierId: string; warehouseId: string; expectedDate?: string | null; notes?: string | null; lines: PurchaseOrderLineInput[] }) =>
      s.purchases.createOrder(ctx(['purchase_orders']), input),
    'purchases.updateOrder': (
      id: string,
      input: { supplierId: string; warehouseId: string; expectedDate?: string | null; notes?: string | null; lines: PurchaseOrderLineInput[] },
    ) => s.purchases.updateOrder(ctx(['purchase_orders']), id, input),
    'purchases.setOrderStatus': (id: string, status: 'sent' | 'closed' | 'cancelled') => s.purchases.setOrderStatus(ctx(['order_close']), id, status),
    'purchases.receiveOrder': (id: string, input: Parameters<Services['purchases']['receiveOrder']>[2]) => s.purchases.receiveOrder(ctx(['order_receive']), id, input),
    'purchases.printOrder': (id: string, opts?: { templateId?: string | null; format?: DocFormat | null; output?: 'print' | 'pdf' }) => (requireUser(), printer.purchaseOrder(id, opts)),
    'purchases.previewOrder': (id: string, opts?: { templateId?: string | null; format?: DocFormat | null }) => (
      requireUser(), { ...printer.previewPurchaseOrder(id, opts), doc: 'purchaseOrder' as const, variant: 'order' as DocVariant }
    ),
    'purchases.receptions': (opts?: { supplierId?: string; uninvoiced?: boolean }) => s.purchases.listReceptions(ctx().storeId, opts),
    'purchases.reception': (id: string) => (requireUser(), s.purchases.getReception(id)),
    'purchases.invoicePreview': (receptionIds: string[]) => (requireUser(), s.purchases.invoicePreview(receptionIds)),
    'purchases.createInvoice': (input: Parameters<Services['purchases']['createInvoice']>[1]) => s.purchases.createInvoice(ctx(['purchase_invoices']), input),
    'purchases.invoices': (opts?: { supplierId?: string; unpaid?: boolean }) => s.purchases.listInvoices(ctx(['purchase_invoices', 'supplier_pay', 'purchase_due']).storeId, opts),
    'purchases.invoice': (id: string) => {
      requireUser(['purchase_invoices', 'supplier_pay', 'purchase_due']);
      return { invoice: s.purchases.getInvoice(id), payments: s.purchases.invoicePayments(id), lines: s.purchases.invoiceLines(id) };
    },
    // Facture directe : elle fait entrer la marchandise, il faut aussi le droit de réceptionner ; la payer tout de suite demande le droit de régler.
    'purchases.directInvoice': (input: Parameters<Services['purchases']['directInvoice']>[1]) => {
      const c = ctx(['purchase_invoices']);
      if (!can(user!, ['stock_receive'])) throw new AppError("Vous n'avez pas le droit de réceptionner la marchandise", 'FORBIDDEN');
      if (input.payment && !can(user!, ['supplier_pay'])) throw new AppError("Vous n'avez pas le droit de régler les fournisseurs", 'FORBIDDEN');
      return s.purchases.directInvoice(c, input);
    },
    'purchases.printInvoice': (id: string, opts?: { templateId?: string | null; format?: DocFormat | null; output?: 'print' | 'pdf' }) => (
      requireUser(['purchase_invoices', 'supplier_pay', 'purchase_due']), printer.purchaseInvoice(id, opts)
    ),
    'purchases.previewInvoice': (id: string, opts?: { templateId?: string | null; format?: DocFormat | null }) => (
      requireUser(['purchase_invoices', 'supplier_pay', 'purchase_due']),
      { ...printer.previewPurchaseInvoice(id, opts), doc: 'purchaseInvoice' as const, variant: 'supplierInvoice' as DocVariant }
    ),
    'purchases.pay': (input: { invoiceId: string; method: SupplierPaymentMethod; amount: Fcfa; reference?: string | null; registerId?: string | null }) =>
      s.purchases.paySupplier(ctx(['supplier_pay']), input),
    'purchases.due': () => s.purchases.dueSchedule(ctx(['purchase_due']).storeId),
    'purchases.reorder': (coverDays?: number) => s.purchases.reorderProposal(ctx(['reorder']).storeId, { coverDays }),
    'purchases.printReorder': (lines: { articleId: string; supplierId: string | null; qty: Milli; unitCost: Fcfa }[]) => printer.reorderSheet(ctx(['reorder']).storeId, lines),
    'purchases.createOrders': (input: { warehouseId: string; lines: (PurchaseOrderLineInput & { supplierId: string })[] }) =>
      s.purchases.createOrdersFromProposal(ctx(['reorder']), input),

    // --- Caisse -------------------------------------------------------------
    'pos.session': () => {
      const c = ctx();
      return c.registerId ? s.pos.currentSession(c.registerId) : null;
    },
    'pos.cashOperation': (type: 'IN' | 'OUT', amount: Fcfa, reason: string, supervisorPin?: string) => {
      const c = ctx(type === 'IN' ? ['cash_in'] : ['cash_withdraw', 'cashout']);
      // Un prélèvement par un caissier doit être validé par le gérant.
      if (type === 'OUT' && !can(user!, ['cashout'])) supervisor(supervisorPin ?? '');
      s.pos.cashOperation(c, type, amount, reason);
    },
    'pos.search': (query: string, opts?: { customerId?: string | null; includeEmpty?: boolean; priceLevel?: PriceLevel | null; warehouseId?: string | null }) =>
      s.pos.searchForSale(ctx().storeId, query, { ...opts, userId: user?.id ?? null }),
    /** Dépôts où l'utilisateur vend sans code du gérant ; la vente s'y complète. */
    'pos.saleWarehouses': () => s.admin.saleWarehousesFor(ctx().storeId, ctx().userId).map((w) => w.id),
    'pos.priceLines': (lines: SaleLineInput[], level?: PriceLevel) => s.pos.priceLines(ctx().storeId, lines, level ?? 'retail'),
    /** Promotions en vigueur aujourd'hui dans ce magasin : la caisse les affiche avant l'encaissement. */
    'promotions.active': () => s.promotions.activeRules(ctx().storeId),
    'promotions.list': () => s.promotions.list(ctx(['promotions', 'promotion_save', 'promotion_stop']).storeId),
    'promotions.save': (input: PromotionInput, id?: string) => s.promotions.save(requireUser(['promotion_save']).id, input, id),
    'promotions.setActive': (id: string, active: boolean) => s.promotions.setActive(requireUser(['promotion_stop']).id, id, active),
    'pos.sell': (input: {
      lines: SaleLineInput[];
      payments: Payment[];
      supervisorPin?: string;
      customerId?: string | null;
      creditPin?: string;
      quoteId?: string | null;
      clientName?: string | null;
      priceLevel?: PriceLevel | null;
      warehouseId?: string | null;
      /** Code du gérant qui a permis le tarif ou le dépôt choisis, si le caissier n'en a pas le droit. */
      optionsPin?: string;
      delivery?: DeliveryInput | null;
      /** Facture modifiée : elle est annulée et remplacée par celle-ci ; `payments` ne porte que la différence. */
      replacesId?: string | null;
    }) => {
      const c = ctx(POS);
      s.license.assertCanSell();
      const usual = input.customerId ? s.customers.getCustomer(input.customerId).price_level : 'retail';
      const otherLevel = Boolean(input.priceLevel) && input.priceLevel !== usual;
      const otherWarehouse =
        Boolean(input.warehouseId) &&
        s.pos.saleWarehouse(c.storeId, input.warehouseId).is_sales_default !== 1 &&
        !s.admin.saleWarehousesFor(c.storeId, c.userId).some((w) => w.id === input.warehouseId);
      if ((otherLevel && !can(user!, ['sale_tariff'])) || otherWarehouse) {
        if (!input.optionsPin) throw new AppError('Tarif ou dépôt soumis à validation du gérant', 'OPTIONS_SUPERVISOR');
        supervisor(input.optionsPin);
      }
      if (input.lines.some((l) => l.price != null) && !can(user!, ['price'])) throw new AppError("Vous n'avez pas le droit de modifier les prix", 'FORBIDDEN');
      const authorizedBy = input.supervisorPin ? supervisor(input.supervisorPin).id : can(user!, ['discount']) ? user!.id : null;
      const creditBy = input.creditPin ? supervisor(input.creditPin).id : null;
      const saleInput = {
        lines: input.lines,
        payments: input.payments,
        discountAuthorizedBy: authorizedBy,
        customerId: input.customerId ?? null,
        creditAuthorizedBy: creditBy,
        quoteId: input.quoteId ?? null,
        clientName: input.clientName ?? null,
        priceLevel: input.priceLevel ?? null,
        warehouseId: input.warehouseId ?? null,
        delivery: input.delivery ?? null,
      };
      if (input.replacesId) {
        const original = s.pos.getSale(input.replacesId);
        if (!can(user!, ['sale_edit']) || (original.user_id !== user!.id && !can(user!, ['sales']))) throw new AppError("Vous n'avez pas le droit de modifier cette facture", 'FORBIDDEN');
        return s.pos.replaceSale(c, input.replacesId, saleInput, user!.id);
      }
      return s.pos.completeSale(c, saleInput);
    },
    /** Taux de TVA des frais de livraison, pour le total affiché à la caisse. */
    'deliveries.feeVat': () => {
      const c = ctx(POS);
      return s.pos.deliveryFeeLine(c, 1).vatRate;
    },
    'deliveries.list': (opts: { from?: string; to?: string; open?: boolean; courier?: string | null }) => s.deliveries.list(ctx(['deliveries']).storeId, opts),
    'deliveries.couriers': () => s.deliveries.couriers(ctx(POS).storeId),
    'deliveries.forSale': (saleId: string) => (requireSaleAccess(saleId), s.deliveries.forSale(saleId)),
    'deliveries.setStatus': (id: string, status: Exclude<DeliveryStatus, 'pending'>, patch?: { courier?: string | null }) => s.deliveries.setStatus(ctx(['deliveries']), id, status, patch),
    'pos.cancel': (saleId: string, supervisorPin: string, reason: string) => {
      const c = ctx(['sale_cancel']);
      const limit = settings().cancelMinutes;
      if (limit > 0 && Date.now() - Date.parse(s.pos.getSale(saleId).created_at) > limit * 60000) {
        throw new AppError(`Une vente ne s'annule que dans les ${limit} minutes qui suivent : faites un retour client`, 'TOO_LATE');
      }
      return s.pos.cancelSale(c, saleId, supervisor(supervisorPin).id, reason);
    },
    /**
     * Annuler (ou « supprimer » : annuler et masquer) une facture depuis le registre ou Mes factures.
     * Avec le droit, sur ses propres factures (toutes pour qui voit tout le registre) ; sinon avec le code du gérant.
     * Journée clôturée : un avoir de toute la facture sur la caisse du jour.
     */
    'sales.cancel': (saleId: string, reason: string, opts?: { hide?: boolean; supervisorPin?: string }) => {
      const u = requireSaleAccess(saleId);
      const c = ctx();
      const sale = s.pos.getSale(saleId);
      const free = can(u, ['sale_cancel_free']) && (sale.user_id === u.id || can(u, ['sales']));
      const by = free ? u.id : supervisor(opts?.supervisorPin ?? '').id;
      return s.pos.voidSale(c, saleId, by, reason, { byRight: free, hide: Boolean(opts?.hide) });
    },
    /** Facture à recharger dans la caisse pour la modifier. */
    'sales.editable': (saleId: string) => {
      const u = requireSaleAccess(saleId);
      const sale = s.pos.getSale(saleId);
      if (!can(u, ['sale_edit']) || (sale.user_id !== u.id && !can(u, ['sales']))) throw new AppError("Vous n'avez pas le droit de modifier cette facture", 'FORBIDDEN');
      return { ...s.pos.editableSale(saleId), number: sale.number, credit: sale.payments.some((p) => p.method === 'CUSTOMER_CREDIT') };
    },
    'pos.return': (input: { originalSaleId: string; lines: { lineId: string; qty: Milli }[]; refundMethod: PaymentMethod; supervisorPin: string; reason: string }) =>
      s.pos.returnSale(ctx(['sale_return']), { ...input, supervisorId: supervisor(input.supervisorPin).id }),
    'pos.findSale': (number: string) => (requireUser(), s.pos.findSaleByNumber(number)),
    'pos.sale': (id: string) => (requireSaleAccess(id), s.pos.getSale(id)),
    'pos.sales': (opts: { sessionId?: string; date?: string }) => {
      const c = ctx();
      return can(user!, ['sales']) ? s.pos.listSales({ ...opts, storeId: c.storeId }) : ownRecent(user!);
    },
    'pos.hold': (label: string, lines: SaleLineInput[]) => {
      const c = ctx(['sale_hold']);
      const max = settings().maxHeld;
      if (max > 0 && c.registerId && s.pos.listHeld(c.registerId).length >= max) {
        throw new AppError(`Déjà ${max} facture(s) en attente sur cette caisse : reprenez-en une d'abord`, 'TOO_MANY');
      }
      return s.pos.holdTicket(c, label, lines);
    },
    'pos.held': () => {
      const c = ctx();
      return c.registerId ? s.pos.listHeld(c.registerId) : [];
    },
    'pos.resume': (id: string) => (requireUser(['sale_resume']), s.pos.resumeHeld(id)),
    'pos.zReport': (sessionId: string) => (requireAmounts(), requireUser(['cash_z']), s.pos.zReport(sessionId)),
    'pos.sessions': () => (requireAmounts(), s.pos.listSessions(ctx(['cash_history']).storeId)),
    /** Ticket d'une vente qui vient d'être faite (autant d'exemplaires que réglé), ou réimpression avec le droit. */
    /** `force` : ticket demandé à la validation (F2), imprimé même si l'impression automatique est coupée. */
    'pos.printTicket': (saleId: string, opts?: { newSale?: boolean; templateId?: string | null; force?: boolean }) => {
      const u = requireSaleAccess(saleId);
      const fresh = Boolean(opts?.newSale && can(u, POS));
      if (!fresh && !can(u, ['sale_reprint'])) throw new AppError("Vous n'avez pas le droit de réimprimer un ticket", 'FORBIDDEN');
      const duplicate = s.pos.getSale(saleId).ticket_prints > 0;
      return printer
        .ticket(saleId, { newSale: fresh, copies: fresh ? settings().ticketCopies : 1, templateId: opts?.templateId, force: Boolean(opts?.force), duplicate })
        .then((printed) => void (printed && s.pos.markSalePrinted(saleId, 'ticket')));
    },
    /** Vente enregistrée sans ticket ou en listing : le tiroir s'ouvre comme au ticket, juste après la vente par son vendeur. */
    'pos.saleDrawer': (saleId: string) => {
      if (!invoiceAccess(saleId)) return;
      return printer.saleDrawer(saleId);
    },
    /** Ouverture du tiroir sans encaissement : tracée dans le journal d'audit. */
    'pos.openDrawer': async () => {
      const c = ctx(['drawer_open']);
      await printer.openDrawer();
      s.receipts.drawerOpened(c);
    },
    'pos.printZ': (sessionId: string) => (requireAmounts(), requireUser(['cash_z']), printer.zReport(sessionId)),

    // --- Trésorerie : journées de caisse et caisse centrale -------------------------
    /** Caisses du magasin, leur état, et la journée de la caisse de ce poste. */
    'treasury.state': () => {
      const c = ctx(TREASURY);
      // Le code d'activation d'une caisse reste réservé à l'administration.
      const registers = s.admin.listRegisters(c.storeId).filter((r) => r.active).map(({ activation_code: _, ...r }) => {
        const open = s.pos.currentSession(r.id);
        return { ...r, isThisStation: r.id === c.registerId, session: open, stale: open ? s.pos.isStale(open) : false, carriedFloat: s.pos.carriedFloat(r.id) };
      });
      return {
        registers,
        canOpen: can(user!, ['cash_open']),
        canChooseRegister: isSupervisor(user!) && !s.admin.getUser(user!.id).register_id,
        canCentral: can(user!, ['central_cash']),
        centralBalance: can(user!, ['central_cash', 'accounting']) ? s.treasury.balance(c.storeId) : null,
        gapThreshold: s.admin.getStore(c.storeId).cash_gap_threshold,
        canSeeAmounts: can(user!, AMOUNTS),
        /** Caisses électronique et banque de l'utilisateur, avec leur journée. */
        linked: Object.values(s.pos.linkedRegisters(user!.id))
          .filter((id): id is string => Boolean(id))
          .map((id) => {
            const { activation_code: _, ...r } = s.admin.getRegister(id);
            const open = s.pos.currentSession(id);
            return { ...r, session: open, stale: open ? s.pos.isStale(open) : false };
          }),
      };
    },
    /** Rouvre les caisses électronique et banque de l'utilisateur (après une clôture en cours de journée). */
    'treasury.openLinked': () => s.pos.openLinked(ctx(TREASURY)),
    /**
     * Clôture d'une caisse électronique ou banque : solde relevé par moyen.
     * Le caissier clôture les siennes ; le gérant (droit des écarts) peut clôturer toute caisse et justifier l'écart.
     */
    'treasury.closeDeclared': (
      registerId: string,
      declared: Partial<Record<PaymentMethod, Fcfa>>,
      opts?: { gapReason?: string | null; deposit?: Partial<Record<PaymentMethod, { amount: Fcfa; reference?: string | null }>> },
    ) => {
      const c = ctx(TREASURY);
      const u = user!;
      const mine = Object.values(s.pos.linkedRegisters(u.id)).includes(registerId);
      if (!mine && !can(u, ['cash_close_other'])) throw new AppError("Cette caisse n'est pas la vôtre", 'FORBIDDEN');
      const z = s.pos.closeDeclared(c, registerId, declared, { gapReason: opts?.gapReason ?? null, gapApprovedBy: can(u, ['cash_open']) ? u.id : null, deposit: opts?.deposit });
      const threshold = s.admin.getStore(c.storeId).cash_gap_threshold;
      const depositId = z.emoneyJournal?.exits.find((e) => e.closing)?.id ?? null;
      // Sans le droit des montants, le caissier ne voit ni l'attendu ni l'écart.
      return can(u, AMOUNTS)
        ? { z, sessionId: z.session.id, needsApproval: false, depositId }
        : { z: null, sessionId: z.session.id, needsApproval: Math.abs(z.difference ?? 0) > threshold, depositId };
    },
    /**
     * Avant la clôture d'une caisse électronique : le mode du magasin, la centrale
     * où verser et les sorties faites par le compte dans la journée (le caissier les
     * voit même sans le droit des montants). Le solde de départ suit le droit des montants.
     */
    'treasury.emoneyDay': (registerId: string) => {
      const c = ctx(TREASURY);
      const u = user!;
      const mine = Object.values(s.pos.linkedRegisters(u.id)).includes(registerId);
      if (!mine && !can(u, ['cash_close_other'])) throw new AppError("Cette caisse n'est pas la vôtre", 'FORBIDDEN');
      const session = s.pos.currentSession(registerId);
      const mode = s.emoney.mode(c.storeId);
      const z = session ? s.pos.zReport(session.id) : null;
      return {
        mode: mode.mode,
        centralName: mode.centralName,
        canDeposit: mode.mode === 'central' && Boolean(mode.centralId) && registerId !== mode.centralId,
        exits: session ? s.emoney.sessionExits(session.id).filter((e) => !e.closing) : [],
        opening: can(u, AMOUNTS) && z?.declared ? Object.fromEntries(z.declared.map((l) => [l.method, l.opening])) : null,
      };
    },
    'treasury.sessions': (registerId?: string | null) => {
      const c = ctx(TREASURY);
      requireAmounts();
      // Sans l'historique, seules les dernières journées de la caisse affichée.
      return s.pos.listSessions(c.storeId, can(user!, ['cash_history']) ? 120 : 3, registerId ?? null);
    },
    /**
     * Journée vue par le caissier sans le droit des montants : état de sa caisse,
     * les sorties d'espèces qu'il a faites lui-même et les bons à signer.
     */
    'treasury.myDay': () => {
      const c = ctx(TREASURY);
      const u = user!;
      const last = c.registerId ? s.pos.listSessions(c.storeId, 1, c.registerId)[0] : undefined;
      if (!last) return null;
      const closed = last.status === 'closed';
      return {
        session: {
          id: last.id,
          register_id: last.register_id,
          status: last.status,
          opened_at: last.opened_at,
          user_name: last.user_name,
          opening_float: last.opening_float,
          closed_at: last.closed_at,
          closed_by_name: last.closed_by_name ?? null,
          float_left: closed ? last.float_left : null,
          deposit: closed ? last.deposit : null,
        },
        stale: !closed && s.pos.isStale(last),
        exits: s.pos.cashJournal(last.id).exits.filter((r) => !r.closing && r.user_id === u.id),
        /** Ses encaissements hors ventes (règlements, « Encaisser ») : jamais le total des ventes. */
        entries: s.pos.cashJournal(last.id).entries.filter((r) => r.user_id === u.id && r.source !== 'sale'),
        /** Sorties faites par le compte MoMo/OM du caissier dans sa journée électronique. */
        emoneyExits: (() => {
          const reg = s.pos.linkedRegisters(u.id).electronic;
          const se = reg ? s.pos.listSessions(c.storeId, 1, reg)[0] : undefined;
          return se ? s.emoney.sessionExits(se.id).filter((e) => !e.closing && e.user_id === u.id) : [];
        })(),
        vouchers: s.treasury
          .sessionMovements(last.id)
          .filter((m) => !m.cash_operation_id)
          .map((m) => ({ id: m.id, kind: m.kind, number: m.number })),
      };
    },
    /** Journée détaillée : Z, entrées et sorties d'espèces, ventes, mouvements de la centrale. */
    'treasury.session': (sessionId: string) => {
      requireUser(TREASURY);
      requireAmounts();
      const z = s.pos.zReport(sessionId);
      return {
        z,
        stale: z.session.status === 'open' && s.pos.isStale(z.session),
        sales: s.pos.listSales({ sessionId, limit: 5000 }),
        cash: s.pos.cashJournal(sessionId),
        movements: s.treasury.sessionMovements(sessionId),
      };
    },
    /**
     * Ouverture : le caissier ouvre sa caisse seul avec le fond laissé la veille
     * (ou moins). Un complément pris dans la caisse centrale demande le gérant.
     */
    'treasury.open': (openingFloat: Fcfa, supervisorPin?: string, registerId?: string) => {
      const c = sameRegister(ctx(TREASURY), registerId);
      const carried = c.registerId ? s.pos.carriedFloat(c.registerId) : null;
      if (carried !== null && openingFloat > carried && !can(user!, ['cash_open'])) supervisor(supervisorPin ?? '');
      const session = s.pos.openSession(c, openingFloat);
      // Complément ou retour de fond : bon à signer entre la caisse et la centrale.
      const voucher = s.treasury.sessionMovements(session.id).find((m) => !m.cash_operation_id);
      return { ...session, voucherId: voucher?.id ?? null };
    },
    /** Attendu et écart : avec le droit des montants, ou sur le code du gérant venu valider l'écart. */
    'treasury.countPreview': (counted: DenominationCount, registerId?: string, supervisorPin?: string) => {
      const c = sameRegister(ctx(TREASURY), registerId);
      if (!can(user!, AMOUNTS)) supervisor(supervisorPin ?? '');
      return s.pos.countPreview(c, counted);
    },
    /** Comptage à l'aveugle du caissier : il apprend seulement s'il faut appeler le gérant. */
    'treasury.blindCount': (counted: DenominationCount, registerId?: string) => {
      const p = s.pos.countPreview(sameRegister(ctx(TREASURY), registerId), counted);
      return { counted: p.counted, needsApproval: p.needsApproval };
    },
    'treasury.close': (counted: DenominationCount, opts: { floatLeft: Fcfa; gapReason?: string | null; supervisorPin?: string; registerId?: string }) => {
      const c = sameRegister(ctx(TREASURY), opts.registerId);
      requireAmounts();
      // Sans code du gérant : un motif saisi par un gérant à la clôture vaut justification, sinon l'écart reste à justifier.
      const approvedBy = can(user!, ['cash_open']) ? user!.id : null;
      return s.pos.closeSession(c, counted, { floatLeft: opts.floatLeft, gapReason: opts.gapReason ?? null, gapApprovedBy: approvedBy });
    },
    /**
     * Clôture par le caissier sans le droit des montants : ni Z ni attendu en
     * retour, seulement son bon de versement. Le comptage est enregistré tel
     * quel ; le gérant justifie un éventuel écart ensuite, depuis son compte.
     */
    'treasury.closeBlind': (counted: DenominationCount, opts: { floatLeft: Fcfa; registerId?: string }) => {
      const c = sameRegister(ctx(TREASURY), opts.registerId);
      const se = s.pos.closeSession(c, counted, { floatLeft: opts.floatLeft }).session;
      const voucher = s.treasury.sessionMovements(se.id).find((m) => m.kind === 'DEPOSIT' && !m.cash_operation_id);
      return { sessionId: se.id, counted: se.counted_cash ?? 0, floatLeft: se.float_left ?? 0, deposit: se.deposit ?? 0, voucherId: voucher?.id ?? null, voucherNumber: voucher?.number ?? null };
    },
    /** Écarts de clôture qui attendent le motif du gérant. */
    'treasury.pendingGaps': () => {
      const u = requireUser();
      if (!can(u, AMOUNTS) || !can(u, ['gap_justify'])) return [];
      return s.pos.pendingGaps(ctx().storeId);
    },
    'treasury.justifyGap': (sessionId: string, reason: string) => {
      const c = ctx(AMOUNTS);
      if (!can(user!, ['gap_justify'])) throw new AppError("Vous n'avez pas le droit de justifier un écart de caisse", 'FORBIDDEN');
      return s.pos.justifyGap(c, sessionId, reason);
    },
    'treasury.central': (opts?: { from?: string; to?: string }) => {
      const c = ctx(['central_cash', 'accounting']);
      return s.treasury.ledger(c.storeId, opts ?? {});
    },
    'treasury.record': (input: { kind: 'IN' | 'OUT'; nature: CentralNature; amount: Fcfa; label?: string | null }) => s.treasury.record(ctx(['central_cash']), input),
    'treasury.printVoucher': (movementId: string) => (requireUser([...TREASURY, 'central_cash']), printer.centralVoucher(movementId)),

    // --- Caisses électroniques : centrale, soldes et mouvements du gérant ------------
    /** Caisses électroniques du magasin pour les listes de choix, la centrale en premier. */
    'emoney.registers': () => {
      const c = ctx();
      const { centralId, mode } = s.emoney.mode(c.storeId);
      return {
        mode,
        centralId,
        registers: s.admin
          .listRegisters(c.storeId)
          .filter((r) => r.active && r.kind === 'electronic')
          .map((r) => ({ id: r.id, name: r.name, central: r.id === centralId }))
          .sort((a, b) => Number(b.central) - Number(a.central) || a.name.localeCompare(b.name)),
      };
    },
    /** Écran de la caisse électronique centrale : solde de chaque caisse électronique et livre de la caisse choisie. */
    'emoney.state': (registerId?: string | null, opts?: { from?: string; to?: string }) => {
      const c = ctx(['central_cash', 'accounting']);
      const mode = s.emoney.mode(c.storeId);
      const registers = s.admin
        .listRegisters(c.storeId)
        .filter((r) => r.active && r.kind === 'electronic')
        .map((r) => {
          const open = s.pos.currentSession(r.id);
          const holder = s.admin.listUsers().find((x) => x.emoney_register_id === r.id && x.active);
          // Journée ouverte : son attendu ; sinon le solde laissé à la dernière clôture et les mouvements depuis.
          const balance = open
            ? (Object.fromEntries((s.pos.zReport(open.id).declared ?? []).map((l) => [l.method, l.expected])) as Record<string, Fcfa>)
            : (s.emoney.balance(r.id) as Record<string, Fcfa>);
          return { id: r.id, name: r.name, central: r.id === mode.centralId, open: Boolean(open), holder: holder?.name ?? null, balance };
        })
        .sort((a, b) => Number(b.central) - Number(a.central) || a.name.localeCompare(b.name));
      const id = registerId || mode.centralId || registers[0]?.id || null;
      return { mode: mode.mode, centralId: mode.centralId, registers, registerId: id, ledger: id ? s.emoney.ledger(id, opts ?? {}) : null, canRecord: can(user!, ['central_cash']) };
    },
    'emoney.record': (input: Parameters<Services['emoney']['record']>[1]) => s.emoney.record(ctx(['central_cash']), input),
    'emoney.print': (movementId: string) => (requireUser([...TREASURY, 'central_cash']), printer.emoneyVoucher(movementId)),

    // --- Encaisser, Décaisser (Opérations de trésorerie) ----------------------------
    /**
     * Ce qu'il faut aux fenêtres « Encaisser » et « Décaisser » d'une journée :
     * la caisse et ses moyens, les clients, factures et avoirs fournisseurs,
     * collaborateurs, salaires à payer, types de charge et comptes.
     */
    'cashdesk.options': (sessionId: string) => {
      const c = deskCtx(sessionId);
      const desk = s.cashdesk.desk(sessionId);
      return {
        ...desk,
        needsPin: !can(user!, ['cashout']),
        canEdit: can(user!, ['cash_desk_edit']),
        customers: s.customers.listCustomers(c.storeId, { withBalance: true }).map((x) => ({ id: x.id, code: x.code, name: x.name, balance: x.balance })),
        invoices: s.purchases
          .listInvoices(c.storeId, { unpaid: true })
          .map((i) => ({ id: i.id, kind: i.kind, supplier_name: i.supplier_name, supplier_number: i.supplier_number, number: i.number, balance: i.balance })),
        staff: s.staff.list(c.storeId).map((x) => ({ id: x.id, name: x.name, position: x.position, due: x.due, advances: x.advances })),
        salaries: s.staff.salaries(c.storeId, { unpaid: true }).map((x) => ({ id: x.id, staff_id: x.staff_id, staff_name: x.staff_name, period: x.period, label: x.label, rest: x.rest })),
        categories: s.expenses.listCategories().map((x) => ({ id: x.id, name: x.name })),
        accounts: s.accounting.listAccounts().filter((a) => !a.id.startsWith('5')).map((a) => ({ id: a.id, label: a.label })),
        emoneyRegisters: s.admin
          .listRegisters(c.storeId)
          .filter((r) => r.active && r.kind === 'electronic' && r.id !== desk.register.id)
          .map((r) => ({ id: r.id, name: r.name, central: r.id === desk.emoneyCentralId })),
      };
    },
    'cashdesk.in': (sessionId: string, input: CashInInput) => s.cashdesk.cashIn(deskCtx(sessionId), sessionId, input),
    /** Une sortie par un caissier demande le code du gérant, comme un prélèvement ou une dépense. */
    'cashdesk.out': (sessionId: string, input: CashOutInput, supervisorPin?: string) => {
      const c = deskCtx(sessionId);
      const by = can(user!, ['cashout']) ? user!.id : supervisor(supervisorPin ?? '').id;
      return s.cashdesk.cashOut(c, sessionId, input, by);
    },
    /** Reçu (entrée) ou bon (sortie) d'une ligne de la journée : ticket ou A4. Le reçu réimprimé porte « DUPLICATA ». */
    'cashdesk.print': async (sessionId: string, source: string, id: string, format: 'ticket' | 'a4' = 'ticket') => {
      requireUser(TREASURY);
      if (source === 'customer_payment' && format === 'ticket') return printer.customerReceipt(id);
      if (source === 'expense' && format === 'ticket') return printer.expenseVoucher(id);
      const entry = source === 'entry' ? s.cashdesk.get(id) : null;
      const duplicate = entry ? entry.printed > 0 : false;
      if (format === 'a4') await printer.deskA4(sessionId, source, id, { duplicate });
      else await printer.deskTicket(sessionId, source, id, { duplicate, authorizedBy: entry?.authorized_by_name ?? null });
      if (entry) s.cashdesk.markPrinted(id);
    },
    'cashdesk.discharge': (sessionId: string, source: string, id: string) => (requireUser(TREASURY), printer.discharge(sessionId, source, id)),
    'cashdesk.unprint': (id: string, supervisorPin?: string) => {
      const c = ctx(TREASURY);
      if (!can(user!, ['cash_desk_edit'])) supervisor(supervisorPin ?? '');
      s.cashdesk.unprint(c, id);
    },
    /** Antidater ou supprimer : le gérant, ou son code. */
    'cashdesk.backdate': (source: 'entry' | 'expense', id: string, at: string, supervisorPin?: string) => {
      const c = ctx(TREASURY);
      if (!can(user!, ['cash_desk_edit'])) supervisor(supervisorPin ?? '');
      s.cashdesk.backdate(c, source, id, at);
    },
    'cashdesk.cancel': (source: 'entry' | 'expense', id: string, reason: string, supervisorPin?: string) => {
      const c = ctx(TREASURY);
      const by = can(user!, ['cash_desk_edit']) ? user!.id : supervisor(supervisorPin ?? '').id;
      if (source === 'expense') return void s.expenses.cancel(c, id, by, reason);
      s.cashdesk.cancel(c, id, by, reason);
    },
    'cashdesk.convert': (id: string, target: { type: 'supplier'; invoiceId: string } | { type: 'customer'; customerId: string }, supervisorPin?: string) => {
      const c = ctx(TREASURY);
      const by = can(user!, ['cash_desk_edit']) ? user!.id : supervisor(supervisorPin ?? '').id;
      return s.cashdesk.convert(c, id, target, by);
    },

    // --- Collaborateurs et paie ------------------------------------------------------
    'staff.list': (includeInactive?: boolean) => s.staff.list(ctx(STAFF).storeId, { includeInactive }),
    'staff.users': () => (requireUser(['staff_edit']), s.admin.listUsers().filter((u) => u.active).map((u) => ({ id: u.id, name: u.name, role: u.role }))),
    'staff.parents': () => (requireUser(['staff', 'staff_edit']), s.staff.parents()),
    'staff.save': (input: StaffInput, id?: string | null) => s.staff.save(ctx(['staff_edit']), input, id ?? undefined),
    'staff.statement': (id: string, from?: string | null, to?: string | null) => (requireUser(STAFF), s.staff.statement(id, { from: from ?? undefined, to: to ?? undefined })),
    'staff.printStatement': (id: string, from?: string | null, to?: string | null) => (requireUser(STAFF), printer.staffStatement(id, from, to)),
    'staff.month': (period: string) => s.staff.month(ctx(['staff_salaries']).storeId, period),
    'staff.recordSalaries': (period: string, lines: { staffId: string; gross: Fcfa; deducted?: Fcfa }[]) => s.staff.recordSalaries(ctx(['staff_salaries']), period, lines),
    'staff.cancelSalary': (id: string, reason: string) => s.staff.cancelSalary(ctx(['staff_salaries']), id, reason),
    'staff.salaries': (opts?: { period?: string | null; staffId?: string | null; unpaid?: boolean }) => s.staff.salaries(ctx(STAFF).storeId, opts ?? {}),
    'staff.declarations': (period: string) => s.staff.declarations(ctx(['staff_salaries']).storeId, period),
    'staff.printDeclarations': (period: string) => printer.payrollDeclarations(ctx(['staff_salaries']).storeId, period),
    'staff.printSlip': (salaryId: string) => (requireUser(STAFF), printer.salarySlip(salaryId)),
    'staff.entries': (staffId?: string | null) => s.cashdesk.officeEntries(ctx(STAFF).storeId, { staffId: staffId ?? null }),
    /** Au bureau : salaire, avance ou remboursement en espèces (caisse centrale), MoMo/OM ou banque. */
    'staff.pay': (input: { kind: 'staff_salary' | 'staff_advance' | 'staff_repayment'; staffId?: string | null; salaryId?: string | null; amount: Fcfa; method: string; reference?: string | null; piece?: string | null; registerId?: string | null }) => {
      const c = ctx(['staff_salaries']);
      if (input.method === 'CASH' && !can(user!, ['central_cash'])) throw new AppError('Payer en espèces au bureau demande le droit de la caisse centrale', 'FORBIDDEN');
      return s.cashdesk.record(c, { ...input, direction: input.kind === 'staff_repayment' ? 'IN' : 'OUT', sessionId: null, authorizedBy: c.userId });
    },
    'staff.printEntry': (id: string) => (requireUser(STAFF), printer.officeVoucher(id)),
    'treasury.printReport': (sessionId: string) => {
      const u = requireUser(TREASURY);
      if (can(u, AMOUNTS)) return printer.sessionReport(sessionId);
      // Le caissier imprime le bon de clôture de sa caisse électronique ou banque, sans l'attendu.
      const se = s.pos.getSession(sessionId);
      if (!Object.values(s.pos.linkedRegisters(u.id)).includes(se.register_id)) requireAmounts();
      return printer.sessionReport(sessionId, true);
    },
    /**
     * Facture selon un modèle : juste après la vente, ou plus tard avec le droit de réimprimer.
     * Dès que la facture (A4 ou listing) a déjà été imprimée, elle porte « DUPLICATA » ; le ticket se compte à part.
     */
    'pos.printInvoice': (saleId: string, opts?: { templateId?: string | null; format?: DocFormat | null; output?: 'print' | 'pdf'; doc?: 'invoice' | 'delivery' }) => {
      const fresh = invoiceAccess(saleId);
      if (opts?.doc === 'delivery') return printer.invoice(saleId, { ...opts, duplicate: !fresh });
      return printer.invoice(saleId, { ...opts, duplicate: invoiceDuplicate(saleId) }).then((done) => {
        if (done) s.pos.markSalePrinted(saleId, 'invoice');
        return done;
      });
    },
    /** Aperçu d'une facture avec le modèle choisi (ou celui par défaut du format). */
    'pos.previewInvoice': (saleId: string, opts?: { templateId?: string | null; format?: DocFormat | null; doc?: 'invoice' | 'delivery' }) => {
      const fresh = invoiceAccess(saleId);
      const duplicate = opts?.doc === 'delivery' ? !fresh : invoiceDuplicate(saleId);
      return { ...printer.previewInvoice(saleId, { ...opts, duplicate }), doc: 'invoice' as const, variant: s.receipts.saleVariant(saleId) };
    },

    // --- Modèles d'impression -------------------------------------------------
    /** Modèles du magasin (ceux du logiciel et ceux modifiés ou ajoutés) et modèle par défaut de chaque emplacement. */
    'docs.templates': () => {
      requireUser();
      const set = settings();
      return { templates: effectiveTemplates(set.printTemplates), stored: set.printTemplates.map((t) => t.id), defaults: set.printDefaults };
    },
    /** Enregistre les modèles modifiés ou ajoutés et les modèles par défaut ; ils partent vers les autres postes. */
    'docs.saveTemplates': (templates: DocTemplate[], defaults: Record<string, string>) => {
      const c = ctx(['print_templates']);
      return s.admin.saveStoreSettings(c.userId, c.storeId, { printTemplates: templates, printDefaults: defaults });
    },
    /** Document servant à l'aperçu d'un modèle : la dernière pièce de cette variante, sinon un exemple. */
    'docs.sample': (variant: DocVariant) => {
      const { storeId } = ctx(['print_templates']);
      if (variant === 'order') {
        const last = s.purchases.listOrders(storeId, { limit: 1 })[0];
        if (last) return { real: true, number: last.number, data: s.receipts.purchaseOrderDoc(last.id) };
      } else if (variant === 'supplierInvoice') {
        const last = s.purchases.listInvoices(storeId).find((i) => i.kind === 'invoice');
        if (last) return { real: true, number: last.number, data: s.receipts.purchaseInvoiceDoc(last.id) };
      } else if (variant === 'quote' || variant === 'proforma') {
        const last = s.quotes.list(storeId, { limit: 60 }).find((q) => q.kind === variant);
        if (last) return { real: true, number: last.number, data: s.receipts.quoteDoc(last.id) };
      } else {
        const last = s.pos
          .listSales({ storeId, limit: 60 })
          .find((x) => x.kind === 'sale' && x.status === 'completed' && (variant === 'delivery' || s.receipts.saleVariant(x.id) === variant));
        if (last) return { real: true, number: last.number, data: s.receipts.saleDoc(last.id) };
      }
      const store = s.admin.getStore(storeId);
      const set = settings();
      return {
        real: false,
        number: null,
        data: sampleDocData(variant, {
          name: store.name,
          address: store.address,
          phone: store.phone,
          niu: store.taxpayer_number,
          rccm: set.rccm,
          logo: set.logo,
          message: set.ticketHeader,
          thanks: s.admin.getSetting('ticket.footer') ?? 'Merci de votre visite !',
          vatEnabled: store.vat_enabled === 1,
        }),
      };
    },

    // --- Clients et crédit ----------------------------------------------------
    'customers.list': (opts?: { search?: string; includeInactive?: boolean; withBalance?: boolean }) => s.customers.listCustomers(ctx().storeId, opts),
    'customers.get': (id: string) => (requireUser(), s.customers.getCustomer(id)),
    'customers.save': (input: CustomerInput, id?: string) => {
      const u = requireUser([id ? 'customer_edit' : 'customer_create', 'customer_deactivate', 'receivables', 'customer_price_level']);
      const before = id ? s.customers.getCustomer(id) : null;
      // Nouveau client : plafond et délai de paiement par défaut des paramètres, si l'écran ne les donne pas.
      const defaults = settings();
      const credit = before?.credit_limit ?? defaults.creditDefaultLimit;
      const terms = before?.payment_terms_days ?? defaults.creditDefaultDays;
      const level = before?.price_level ?? 'retail';
      const active = before ? before.active === 1 : true;
      // Le caissier peut créer ou corriger une fiche, mais pas accorder de crédit.
      if (!can(u, ['receivables']) && ((input.creditLimit ?? credit) !== credit || (input.paymentTermsDays ?? terms) !== terms)) {
        throw new AppError("Vous n'avez pas le droit de fixer le plafond de crédit ou le délai de paiement", 'FORBIDDEN');
      }
      if (!can(u, ['customer_price_level']) && (input.priceLevel ?? level) !== level) throw new AppError("Vous n'avez pas le droit de fixer le tarif du client", 'FORBIDDEN');
      if (!can(u, ['customer_deactivate']) && (input.active ?? active) !== active) throw new AppError("Vous n'avez pas le droit de désactiver un client", 'FORBIDDEN');
      const fiche = (a: { name: string; phone?: string | null; contact?: string | null; email?: string | null; address?: string | null; notes?: string | null }) =>
        [a.name.trim(), a.phone ?? '', a.contact ?? '', a.email ?? '', a.address ?? '', a.notes ?? ''].join('|');
      if (!id && !can(u, ['customer_create'])) throw new AppError("Vous n'avez pas le droit de créer un client", 'FORBIDDEN');
      if (before && !can(u, ['customer_edit']) && fiche(input) !== fiche(before)) throw new AppError("Vous n'avez pas le droit de modifier la fiche d'un client", 'FORBIDDEN');
      return s.customers.saveCustomer(u.id, { ...input, creditLimit: input.creditLimit ?? credit, paymentTermsDays: input.paymentTermsDays ?? terms }, id);
    },
    'customers.account': (id: string) => s.customers.account(ctx().storeId, id),
    'loyalty.status': (customerId: string) => (requireUser(), s.loyalty.status(ctx().storeId, customerId)),
    'loyalty.history': (customerId: string) => (requireUser(['customers']), s.loyalty.history(customerId)),
    'loyalty.balances': () => (requireUser(['customers']), Object.fromEntries(s.loyalty.balances())),
    'loyalty.adjust': (customerId: string, points: number, reason: string) => {
      const u = requireUser(['loyalty_adjust']);
      return s.loyalty.adjust({ storeId: ctx().storeId, userId: u.id }, customerId, points, reason);
    },
    'loyalty.printCard': (customerId: string, copies?: number) => {
      const storeId = ctx(['customers']).storeId;
      const c = s.customers.getCustomer(customerId);
      return printer.a4(loyaltyCardHtml({ store: s.admin.getStore(storeId).name, customer: c.name, code: c.code, phone: c.phone, logo: settings().logo || null }, copies));
    },
    /** Carte scannée à la caisse : code du client ou numéro de téléphone. */
    'loyalty.findCustomer': (code: string) => (requireUser(), s.customers.findByCard(code)),
    'customers.statement': (id: string, from?: string | null, to?: string | null) =>
      s.customers.statement(ctx(['customer_statement', 'receivables']).storeId, id, { from: from ?? undefined, to: to ?? undefined }),
    'customers.sales': (id: string) => s.pos.listSales({ storeId: ctx().storeId, customerId: id, limit: 100 }),
    'customers.pay': (input: { customerId: string; method: CustomerPaymentMethod; amount: Fcfa; reference?: string | null; notes?: string | null; atRegister?: boolean }) => {
      const c = ctx(['customer_payment']);
      // Encaissé à la caisse : rattaché à la session ouverte, les espèces vont dans le tiroir.
      const session = input.atRegister && c.registerId ? s.pos.currentSession(c.registerId) : null;
      if (input.atRegister && !session) throw new AppError("Ouvrez la caisse avant d'encaisser un règlement client", 'NO_SESSION');
      // Mobile Money et carte vont à la caisse électronique du caissier, virement et chèque à sa caisse banque.
      return s.customers.receivePayment(c, { ...input, sessionId: session ? s.pos.sessionFor(c, input.method, session.id) : null });
    },
    'customers.payments': (opts?: { customerId?: string; limit?: number }) => s.customers.listPayments(ctx().storeId, opts),
    'customers.receivables': () => s.customers.receivables(ctx(SALES).storeId),
    'customers.printStatement': (id: string, from?: string | null, to?: string | null) => printer.statement(ctx(['customer_statement', 'receivables']).storeId, id, from, to),
    /** Relance d'un client en retard : message WhatsApp prêt à envoyer, montants et dernière relance. */
    'customers.reminder': (id: string) => {
      const storeId = ctx(['customer_statement', 'receivables']).storeId;
      const store = s.admin.getStore(storeId);
      const d = s.customers.reminderData(storeId, id);
      const text = reminderMessage(settings().reminderTemplate, {
        customer: d.customer.name,
        store: store.name,
        storePhone: store.phone,
        balance: d.balance,
        overdue: d.overdue,
        items: d.items.map((i) => ({ number: i.number, date: i.created_at, dueDate: i.due_date, remaining: i.remaining, daysLate: i.days_late })),
      });
      return { ...d, text, link: whatsappLink(d.customer.phone, text) };
    },
    'customers.reminderSent': (id: string, channel: 'whatsapp' | 'pdf') => s.customers.recordReminder(ctx(['customer_statement', 'receivables']), id, channel),
    /** Relevé en PDF à joindre dans WhatsApp : la relance est notée s'il est enregistré. */
    'customers.reminderPdf': async (id: string) => {
      const c = ctx(['customer_statement', 'receivables']);
      const saved = await printer.statement(c.storeId, id, null, null, 'pdf');
      if (saved) s.customers.recordReminder(c, id, 'pdf');
      return saved;
    },
    'customers.printReceipt': (paymentId: string) => (requireUser(), printer.customerReceipt(paymentId)),

    // --- Ristournes des clients spécifiques ------------------------------------
    'rebates.rules': (customerId?: string | null) => (requireUser(CUSTOMERS), s.rebates.rules({ customerId: customerId ?? null })),
    'rebates.allRules': () => (requireUser(CUSTOMERS), s.rebates.rules({ all: true })),
    'rebates.saveRules': (customerId: string | null, rules: RebateRuleInput[]) => s.rebates.saveRules(ctx(['rebates']), customerId, rules),
    'rebates.setCustomer': (customerId: string, opts: { enabled: boolean; delivered: boolean }) => s.rebates.setCustomer(ctx(['rebates']), customerId, opts),
    'rebates.customers': () => (requireUser(CUSTOMERS), s.rebates.customers()),
    'rebates.compute': (customerId: string, from: string, to: string) => s.rebates.compute(ctx(CUSTOMERS).storeId, customerId, from, to),
    'rebates.state': (from: string, to: string) => s.rebates.state(ctx(CUSTOMERS).storeId, from, to),
    'rebates.close': (from: string, to: string, customerIds?: string[] | null) => s.rebates.close(ctx(['rebates']), from, to, customerIds ?? undefined),
    'rebates.adjust': (customerId: string, amount: Fcfa, reason: string) => s.rebates.adjust(ctx(['rebates']), customerId, amount, reason),
    'rebates.grant': (customerId: string, amount: Fcfa, mode: 'credit' | 'cash', opts?: { method?: string | null; reference?: string | null; registerId?: string | null }) => {
      const c = ctx(['rebates']);
      if (mode === 'cash' && !can(user!, ['central_cash'])) throw new AppError('Payer une ristourne demande le droit de la caisse centrale', 'FORBIDDEN');
      return s.rebates.grant(c, customerId, amount, mode, opts ?? {});
    },
    'rebates.entries': (opts?: { customerId?: string | null; from?: string | null; to?: string | null }) => s.rebates.entries(ctx(CUSTOMERS).storeId, opts ?? {}),
    'rebates.carryForward': (date: string) => s.rebates.carryForward(ctx(CUSTOMERS).storeId, date),
    'rebates.print': (entryId: string) => (requireUser(CUSTOMERS), printer.rebateVoucher(entryId)),

    // --- Devis et proformas ----------------------------------------------------
    'quotes.list': (opts?: { state?: QuoteState; customerId?: string; search?: string }) => s.quotes.list(ctx().storeId, opts),
    'quotes.get': (id: string) => (requireUser(), s.quotes.get(id)),
    /** Remise sur un devis : gérant, ou code d'un gérant. */
    'quotes.save': (input: QuoteInput, id?: string | null, supervisorPin?: string) => {
      const c = ctx(['quote_save']);
      return s.quotes.save(c, input, { id: id ?? undefined, discountAuthorizedBy: supervisorPin ? supervisor(supervisorPin).id : null });
    },
    'quotes.cancel': (id: string) => s.quotes.cancel(ctx(['quote_cancel']), id),
    'quotes.print': (id: string, opts?: { templateId?: string | null; format?: DocFormat | null; output?: 'print' | 'pdf' }) => (requireUser(), printer.quote(id, opts)),
    'quotes.preview': (id: string, opts?: { templateId?: string | null; format?: DocFormat | null }) => {
      requireUser();
      return { ...printer.previewQuote(id, opts), doc: 'quote' as const, variant: s.quotes.get(id).kind as DocVariant };
    },
    /** Lignes à charger dans la fiche de facturation, aux prix garantis par le devis. */
    'quotes.saleLines': (id: string) => s.quotes.saleLines(ctx(POS).storeId, id),

    // --- Dépenses -------------------------------------------------------------
    'expenses.categories': (includeInactive?: boolean) => (requireUser(), s.expenses.listCategories(includeInactive)),
    'expenses.saveCategory': (input: { id?: string | null; name: string; accountId: string; active?: boolean }) =>
      s.expenses.saveCategory(requireUser(['expense_categories']).id, input),
    /** Au bureau : gérant ou comptable. À la caisse (espèces du tiroir) : un caissier a besoin du code d'un gérant. */
    'expenses.record': (input: Omit<ExpenseInput, 'authorizedBy'> & { supervisorPin?: string }) => {
      const { supervisorPin, ...rest } = input;
      const u = requireUser();
      // Le caissier ou le vendeur n'a pas la main sur la caisse centrale : ses dépenses en espèces sortent de sa caisse.
      const atRegister = Boolean(input.atRegister) || ((input.method === 'CASH' || isPayout(input.method)) && !can(u, ['central_cash']) && can(u, POS));
      const c = ctx(atRegister ? POS : ['expense_record']);
      const authorizedBy = atRegister && !can(u, ['cashout']) ? supervisor(supervisorPin ?? '').id : null;
      return s.expenses.record(c, { ...rest, atRegister, date: atRegister ? null : rest.date, authorizedBy });
    },
    'expenses.cancel': (id: string, reason: string, supervisorPin?: string) => {
      const c = ctx(['expense_cancel']);
      const sup = isSupervisor(user!) ? user!.id : supervisor(supervisorPin ?? '').id;
      return s.expenses.cancel(c, id, sup, reason);
    },
    'expenses.get': (id: string) => (requireUser(), s.expenses.get(id)),
    'expenses.list': (opts: { from?: string; to?: string; categoryId?: string; sessionId?: string; includeCancelled?: boolean }) =>
      s.expenses.list(ctx(opts.sessionId ? undefined : ['expenses']).storeId, opts),
    'expenses.summary': (opts: { from?: string; to?: string }) => s.expenses.summary(ctx(['expenses']).storeId, opts),
    'expenses.print': (id: string) => (requireUser(), printer.expenseVoucher(id)),

    // --- Comptabilité --------------------------------------------------------
    'accounting.accounts': (includeInactive?: boolean) => (requireUser(), s.accounting.listAccounts(includeInactive)),
    'accounting.saveAccount': (input: { id: string; label: string; role?: AccountRole | null; active?: boolean }) =>
      s.accounting.saveAccount(requireUser(['chart_accounts']).id, input),
    'accounting.entries': (opts: { from?: string; to?: string; journal?: JournalCode }) => s.accounting.entries(ctx(ACCOUNTING).storeId, opts),
    'accounting.addEntry': (input: Parameters<Services['accounting']['addManualEntry']>[1]) => s.accounting.addManualEntry(ctx(['journal_entry']), input),
    /** Droit « Modifier, supprimer ou corriger une écriture comptable ». */
    'accounting.updateEntry': (id: string, input: Parameters<Services['accounting']['updateManualEntry']>[2]) => s.accounting.updateManualEntry(ctx(['journal_edit']), id, input),
    'accounting.deleteEntry': (id: string) => s.accounting.deleteManualEntry(ctx(['journal_edit']), id),
    'accounting.correctEntry': (key: string, input: Parameters<Services['accounting']['correctEntry']>[2]) => s.accounting.correctEntry(ctx(['journal_edit']), key, input),
    // --- Exercices comptables --------------------------------------------------
    'fiscal.list': () => {
      const storeId = ctx([...ACCOUNTING, 'fiscal_years']).storeId;
      return s.fiscal.list(storeId).map((f) => ({ ...f, stale: f.status === 'closed' && s.fiscal.stale(storeId, f.id) }));
    },
    /** Exercice en cours : période proposée par défaut dans les journaux, la balance et le grand livre. */
    'fiscal.current': () => s.fiscal.at(ctx().storeId),
    'fiscal.open': (input: { start: string; end: string }) => s.fiscal.open(ctx(['fiscal_years']), input),
    'fiscal.openNext': () => s.fiscal.openNext(ctx(['fiscal_years'])),
    'fiscal.setDates': (id: string, input: { start: string; end: string }) => s.fiscal.setDates(ctx(['fiscal_years']), id, input),
    'fiscal.close': (id: string) => s.fiscal.close(ctx(['fiscal_years']), id),
    'fiscal.reopen': (id: string) => s.fiscal.reopen(ctx(['fiscal_years']), id),
    'fiscal.remove': (id: string) => s.fiscal.remove(ctx(['fiscal_years']), id),
    'accounting.ledger': (opts: { account: string; aux?: string; from?: string; to?: string }) => s.accounting.ledger(ctx(ACCOUNTING).storeId, opts),
    'accounting.trialBalance': (opts: { from?: string; to?: string }) => s.accounting.trialBalance(ctx(ACCOUNTING).storeId, opts),
    'accounting.treasury': (to?: string) => s.accounting.treasury(ctx(ACCOUNTING).storeId, to),
    'accounting.vatReturn': (month: string) => s.accounting.vatReturn(ctx(['vat_return']).storeId, month),
    'accounting.exportCsv': (opts: { from?: string; to?: string }) => s.accounting.exportCsv(ctx(['accounting_export']).storeId, opts),
    'tax.assessment': (year: number) => s.tax.assessment(ctx(['tax', 'tax_settings']).storeId, year),
    'tax.instalment': (month: string) => s.tax.instalment(ctx(['tax', 'tax_settings']).storeId, month),
    'tax.saveSettings': (year: number, input: Parameters<typeof s.tax.saveSettings>[2]) => s.tax.saveSettings(ctx(['tax_settings']), year, input),
    'tax.book': (year: number) => s.tax.book(ctx(['tax_settings']), year),
    'tax.print': (year: number) => printer.taxAssessment(ctx(['tax', 'tax_settings']).storeId, year),
    'accounting.printVat': (month: string) => printer.vatReturn(ctx(['vat_return']).storeId, month),
    'accounting.statements': (opts: { from: string; to: string }) => s.statements.statements(ctx(['statements']).storeId, opts),
    'accounting.cashFlow': (opts: { from: string; to: string }) => s.statements.cashFlow(ctx(['statements']).storeId, opts),
    'accounting.notes': (year: number) => s.notes.notes(ctx(['tax', 'statements']).storeId, year),
    'accounting.disclosures': (year: number) => ({
      ...s.disclosures.get(ctx(['tax', 'tax_settings']).storeId, year),
      labels: { security: SECURITY_KINDS, commitment: COMMITMENT_KINDS, staff: STAFF_CATEGORIES },
    }),
    'accounting.saveDisclosures': (year: number, input: DisclosuresInput) => s.disclosures.save(ctx(['tax_settings']), year, input),
    'accounting.notesCsv': (year: number) => s.notes.exportCsv(ctx(['accounting_export']).storeId, year),
    'accounting.printNotes': (year: number) => printer.notes(ctx(['tax', 'statements']).storeId, year),
    'accounting.statementsCsv': (opts: { from: string; to: string }) => s.statements.exportCsv(ctx(['accounting_export']).storeId, opts),
    'accounting.printStatements': (from: string, to: string) => printer.statements(ctx(['statements']).storeId, from, to),
    // --- Rapprochement bancaire --------------------------------------------------------
    'bank.accounts': () => (ctx(BANK), s.reconciliation.accounts()),
    'bank.state': (accountId: string, date?: string) => s.reconciliation.state(ctx(BANK).storeId, accountId, date),
    'bank.import': (accountId: string, lines: StatementLine[]) => s.reconciliation.importLines(ctx(BANK), accountId, lines),
    'bank.delete': (id: string) => s.reconciliation.deleteLine(ctx(BANK), id),
    'bank.match': (id: string, key: string) => s.reconciliation.match(ctx(BANK), id, key),
    'bank.unmatch': (id: string) => s.reconciliation.unmatch(ctx(BANK), id),
    'bank.autoMatch': (accountId: string) => s.reconciliation.autoMatch(ctx(BANK), accountId),
    'bank.book': (id: string, input: { account: string; label?: string }) => s.reconciliation.bookLine(ctx(BANK), id, input),
    'bank.print': (accountId: string, date: string, statementBalance: number | null) =>
      printer.reconciliation(ctx(BANK).storeId, accountId, date, statementBalance),
    'accounting.printBalance': (from?: string | null, to?: string | null) => printer.trialBalance(ctx(ACCOUNTING).storeId, from, to),
    'accounting.printJournal': (from?: string | null, to?: string | null, journal?: JournalCode | null) =>
      printer.journal(ctx(ACCOUNTING).storeId, from, to, journal),

    // --- Sauvegardes -------------------------------------------------------
    'backup.status': () => (requireUser(['backups']), { ...s.backups.status(), backups: s.backups.list() }),
    'backup.overdue': () => (requireUser(), s.backups.status().overdue),
    'backup.now': () => s.backups.saveNow(requireUser(['backups']).id),
    'backup.toFolder': async () => {
      const u = requireUser(['backups']);
      const dir = await system.chooseFolder('Choisir la clé USB ou le dossier de la copie');
      return dir ? s.backups.backup(u.id, { dir, kind: 'manual' }) : null;
    },
    'backup.chooseFolder': (title: string) => (requireAdmin(), system.chooseFolder(title)),
    'backup.configure': (input: { dir?: string | null; copyDir?: string | null; keep?: number; autoTime?: string | null; everyMinutes?: number }) => s.backups.configure(requireAdmin().id, input),
    'backup.list': (dir?: string | null) => (requireUser(['backups']), s.backups.list(dir)),
    'backup.chooseFile': async () => {
      requireAdmin();
      const file = await system.chooseBackupFile();
      return file ? inspectBackup(file) : null;
    },
    'backup.openFolder': (path: string) => (requireUser(['backups']), system.openFolder(path)),
    'backup.restore': (file: string) => {
      const u = requireAdmin();
      const info = inspectBackup(file);
      if (!info.ok) throw new AppError(info.error ?? 'Sauvegarde invalide', 'INVALID');
      system.restore(file, u.id);
      return info;
    },

    // --- Rapports -----------------------------------------------------------
    // --- Registres et contrôles (menus KONTROL) ------------------------------------
    'controls.salesRegister': (f: SalesRegisterFilter) => s.controls.salesRegister(ctx(SALES).storeId, f),
    'controls.salesAlerts': (p: Period & { discountRate?: number }) => s.controls.salesAlerts(ctx(['sales_alerts']).storeId, p, p),
    'controls.purchasesByProduct': (p: Period & { supplierId?: string | null }) => s.controls.purchasesByProduct(ctx(SUPPLIERS).storeId, p),
    'controls.pendingReceipts': () => s.controls.pendingReceipts(ctx(SUPPLIERS).storeId),
    'controls.cashOperations': (p: Period & { registerId?: string | null }) => s.controls.cashOperations(ctx(['cash_operations']).storeId, p),
    'controls.supplierStatement': (supplierId: string, p?: Partial<Period>) => s.controls.supplierStatement(ctx(['supplier_statement']).storeId, supplierId, p),
    'controls.supplierSituation': () => s.controls.supplierSituation(ctx(['supplier_statement']).storeId),
    'controls.recentAccounts': (party: 'supplier' | 'customer', days?: number) =>
      s.controls.recentAccounts(ctx(party === 'supplier' ? SUPPLIERS : CUSTOMERS).storeId, party, days),
    'controls.creditControl': () => s.controls.creditControl(ctx(['receivables']).storeId),
    'charges.plans': (includeInactive?: boolean) => s.charges.listPlans(ctx(['charge_plans']).storeId, includeInactive),
    'charges.savePlan': (input: ChargePlanInput, id?: string | null) => s.charges.savePlan(ctx(['charge_plans']), input, id),
    'charges.deletePlan': (id: string) => s.charges.deletePlan(ctx(['charge_plans']), id),
    'charges.schedule': (from: string, to: string) => s.charges.schedule(ctx(['charge_plans']).storeId, from, to),
    'charges.late': () => (user && can(user, ['charge_plans']) ? s.charges.late(ctx().storeId) : { count: 0, amount: 0 }),

    'reports.daily': (date: string) => s.reports.daily(ctx(['dashboard']).storeId, date),
    /** Résumé du jour du magasin, à envoyer au gérant par WhatsApp ou par e-mail. */
    'digest.preview': (date?: string | null) => s.digest.build(ctx(['dashboard']).storeId, date || s.digest.day(0)),
    'digest.config': () => {
      requireAdmin();
      return s.digest.config();
    },
    /** password : nouveau mot de passe ; absent ou null, on garde l'actuel ; vide, on l'efface. */
    'digest.saveConfig': (input: DigestConfig, password?: string | null) => {
      const u = requireAdmin();
      let sealed: string | undefined;
      if (password === '') sealed = '';
      else if (password) {
        if (!system.digest) throw new AppError("L'envoi par e-mail n'est pas disponible sur ce poste", 'INVALID');
        sealed = system.digest.seal(password);
      }
      s.digest.saveConfig(u.id, input, sealed);
      return s.digest.config();
    },
    'digest.sendNow': async () => {
      requireAdmin();
      if (!system.digest) throw new AppError("L'envoi par e-mail n'est pas disponible sur ce poste", 'INVALID');
      return system.digest.sendNow();
    },
    /** Points d'attention du gérant : chaque point n'apparaît qu'avec le droit de la fenêtre qui le traite. */
    'attention.list': () => {
      const c = ctx(['dashboard']);
      const u = user!;
      const rules: [AttentionKey, boolean][] = [
        ['rupture', can(u, STOCK)],
        ['alerte', can(u, STOCK)],
        ['cash_gaps', can(u, AMOUNTS) && can(u, ['gap_justify'])],
        ['transfers', can(u, TRANSFERS)],
        ['stock_requests', can(u, ['stock_decide'])],
        ['rebates_pending', can(u, ['rebates'])],
        ['rebates_balance', can(u, ['rebates'])],
        ['inventories', can(u, INVENTORY)],
        ['supplier_invoices', can(u, ['purchase_invoices'])],
        ['late_customers', can(u, ['receivables'])],
        ['production', can(u, ['production'])],
      ];
      return s.attention.list(c.storeId, new Set(rules.filter(([, ok]) => ok).map(([k]) => k)));
    },
    'reports.sales': (input: SalesReportInput) => s.reports.sales(ctx(['reports', 'sales']).storeId, input),
    /** Classeur .xlsx : octets envoyés tels quels à l'écran, qui propose l'enregistrement. */
    'reports.salesXlsx': (input: SalesReportInput) => xlsxWorkbook(s.reports.salesWorkbook(ctx(['report_export']).storeId, input)),
    'reports.salesCsv': (from: string, to: string) => s.reports.salesExportCsv(ctx(['accounting_export', 'report_export']).storeId, from, to),
  };
}

export type Api = ReturnType<typeof createApi>;
export type ApiName = keyof Api;
