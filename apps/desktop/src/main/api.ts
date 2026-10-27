import {
  type DenominationCount,
  ELECTRONIC_METHODS,
  type BarcodeLabelFormatId,
  type BarcodeLabelOptions,
  type LabelFormatId,
  barcodeLabelsHtml,
  loyaltyCardHtml,
  badgesHtml,
  badgeExpiry,
  holidaysBetween,
  type Rotation,
  type StaffKind,
  STAFF_KINDS,
  type BadgeCard,
  type BadgeLayout,
  reminderMessage,
  whatsappLink,
  ticketMessage,
  purchaseOrderMessage,
  PAYMENT_METHODS,
  formatQty,
  arrivalMessage,
  promoPostersHtml,
  type PosterSize,
  labelsHtml,
  xlsxWorkbook,
  type Fcfa,
  type Milli,
  type MovementType,
  type Payment,
  type PaymentMethod,
  type Permission,
  type PriceLevel,
  type QtyTier,
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
  BUILTIN_EXPORT_FORMATS,
  type ExportFormat,
  type FileFormat,
  type ImportFormat,
  type ArticleImportRow,
  type ArticleColumn,
  ARTICLE_COLUMNS,
  BUILTIN_IMPORT_FORMATS,
  formatEntries,
  type TakeoverKind,
  type CustomerDisplayMode,
  type CustomerDisplayState,
  CUSTOMER_DISPLAY_MODES,
  type DocLang,
  type WarningKind,
} from '@superette/core';
import {
  AppError,
  type AgentInput,
  type AgentKind,
  ClearanceService,
  type ReorderOptions,
  type WeekSchedule,
  approvalStatus,
  requestApproval,
  shelfCarts,
  mobileReceptions,
  takeMobileReception,
  pushStationStatus,
  stationStatuses,
  type StationStatus,
  type MissedSaleInput,
  type PriceScheduleInput,
  type RecurringOrderInput,
  type OwnerReport,
  takeShelfCart,
  takeWebOrder,
  webOrders,
  type AssetInput,
  ficheBanner,
  FICHE_EXTENSION,
  type FicheKind,
  inspectDossier,
  installFiche,
  isPackedFiche,
  packFiche,
  unpackFiche,
  isPayout,
  BUILTIN_TEMPLATES,
  parseTemplate,
  RELAY_EXTENSION,
  type ShopTemplate,
  TEMPLATE_EXTENSION,
  COMMITMENT_KINDS,
  SECURITY_KINDS,
  inspectBackup,
  STAFF_CATEGORIES,
  type AgencyInput,
  type TeamInput,
  type ArticleInput,
  type WarehouseInput,
  type WarehousePurpose,
  type EditRequestStatus,
  type CompanyInput,
  type ExportFilter,
  type ImportMode,
  type PriceUpdateInput,
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
  type OrderInput,
  type SalesTargetInput,
  type OrderStatus,
  type AccountRole,
  type JournalCode,
  type LabelItem,
  type SalesReportInput,
  type ReceptionLine,
  type Role,
  type UserRegisters,
  ROLE_LABELS,
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
  type MobileMethod,
  type MtnConfig,
  type OrangeConfig,
  type SalaryAttendance,
} from '@superette/db';
import { createCloudBackup } from './cloudBackup';

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { CustomerDisplay } from './customerDisplay';
import type { DossierEntry } from './dossiers';
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
  /** Boutiques de ce PC (« Ouvrir une boutique ») ; changer de boutique relance l'application. */
  dossiers?: {
    /** Fichier de la boutique ouverte. */
    file: string;
    /** Dossier où vont les nouvelles boutiques et les fiches copiées depuis une clé. */
    dir: string;
    list(): DossierEntry[];
    open(file: string): void;
    create(name: string): string;
    forget(file: string): void;
    importFile(file: string): string;
    chooseFile(title: string): Promise<string | null>;
    /** Ferme la base vide de ce PC, la remplace par l'installation préparée et relance. */
    install(file: string): void;
  };
  /** Afficheur client branché au PC de caisse (absent dans les tests). */
  customerDisplay?: CustomerDisplay;
  /** Fenêtre de choix d'un fichier d'un type donné (modèle de boutique, fichier de journée). */
  chooseOpenFile?(title: string, name: string, extensions: string[]): Promise<string | null>;
  /** Réception des pointeuses à empreinte par le réseau (absente dans les tests). */
  fingerprint?: { apply(): void; state(): { port: number | null; listening: boolean; error: string | null; lastAt: string | null; addresses: string[] } };
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
  /** Bon de passation d'une relève d'équipe. */
  handover(handoverId: string): Promise<void>;
  /** Bon de versement à la caisse centrale ou de remise de fond. */
  centralVoucher(movementId: string): Promise<void>;
  /** Bon d'un mouvement de caisse électronique : versement vers la centrale, transfert, banque… */
  emoneyVoucher(movementId: string): Promise<void>;
  /** Bon d'achat, d'avoir ou de monnaie, avec son code-barres. */
  giftVoucher(voucherId: string): Promise<void>;
  /** Affiches promo A4 ou A5 (deux par page A4 à l'italienne) : la fenêtre d'impression s'ouvre. Renvoie false si annulé. */
  posters(html: string, size: 'a4' | 'a5'): Promise<boolean>;
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
  /** Registre des immobilisations à une date, puis le plan d'amortissement de chaque bien. */
  assets(storeId: string, at: string, id?: string | null): Promise<void>;
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
  /** Lettre d'avertissement à remettre au collaborateur. */
  staffWarning(warningId: string): Promise<void>;
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
  /** Liste d'un écran telle qu'affichée (colonnes choisies, tri, filtre) : imprimée ou en PDF ; false si annulé. */
  listing(storeId: string, title: string, tableHtml: string, output: 'print' | 'pdf'): Promise<boolean>;
  /** Rapport mensuel du propriétaire sur une page, enregistré en PDF ; false si annulé. */
  ownerReport(storeId: string, report: OwnerReport, month: string): Promise<boolean>;
  countSheet(storeId: string, warehouseId: string, departmentId?: string | null): Promise<void>;
  /** Fiche de comptage d'un inventaire (cases vides par conditionnement), par rayon. */
  inventorySheet(inventoryId: string, opts?: { model?: InventorySheetModel; output?: 'a4' | 'pdf' | 'ticket' }): Promise<void>;
  /** Résultat d'un inventaire : écarts valorisés, totaux et signatures. */
  inventoryResult(inventoryId: string): Promise<void>;
  /** Bon de transfert A4 : bon de route (expédition) ou bon de réception. */
  transferNote(transferId: string): Promise<void>;
  /** Bon de retour au fournisseur. */
  supplierReturn(returnId: string): Promise<void>;
  /** Facture récapitulative d'un client (ventes de la période). */
  summaryInvoice(invoiceId: string): Promise<void>;
  /** Bordereau de remise de chèques en banque. */
  chequeDeposit(depositId: string): Promise<void>;
  /** Feuille de route d'un livreur : ses livraisons, adresses et montants à encaisser. */
  courierSheet(storeId: string, courier: string, date: string): Promise<void>;
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
  'display.customer',
  'display.customerScreen',
  'display.customerPort',
  'display.customerBaud',
  'display.customerColumns',
  'display.customerMessage',
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
  /** Accords donnés à distance par le gérant (téléphone) : valables 2 minutes sur ce PC. */
  const remoteApprovals = new Map<string, { userId: string; until: number }>();
  const supervisor = (pin: string): User => {
    const remote = /^@accord:(.+)$/.exec(pin ?? '');
    if (!remote) return s.admin.authorizeSupervisor(pin);
    const a = remoteApprovals.get(remote[1]!);
    if (!a || a.until < Date.now()) throw new AppError("L'accord du gérant a expiré : redemandez-le", 'SUPERVISOR_DENIED');
    const u = s.admin.getUser(a.userId);
    if (!u.active || u.deleted_at || (u.role !== 'admin' && u.role !== 'manager')) throw new AppError('Code superviseur refusé', 'SUPERVISOR_DENIED');
    return u;
  };
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
  const cloud = createCloudBackup(s);
  /** Ce qui s'imprime sur le badge d'un employé : fiche collaborateur, photo, couleurs et logo de son magasin. */
  const badgeCard = (target: User): BadgeCard => {
    const storeId = target.store_id ?? s.admin.station()?.store.id ?? ctx().storeId;
    const set = s.admin.storeSettings(storeId);
    const staff = s.staff.forUser(target.id);
    return {
      store: s.admin.getStore(storeId).name,
      logo: set.logo || null,
      // Le nom complet est celui de la fiche collaborateur quand elle existe.
      name: staff && staff.name.length > target.name.length ? staff.name : target.name,
      role: ROLE_LABELS[target.role],
      position: staff?.position ?? null,
      number: staff?.code ?? null,
      phone: staff?.phone ?? null,
      hiredOn: staff?.hired_on ?? null,
      code: target.badge ?? '',
      photo: s.admin.userPhoto(target.id),
      expires: badgeExpiry(new Date(), set.badge.validityMonths),
      color: set.brandColor,
      color2: set.brandColor2,
    };
  };
  /** Badge d'un collaborateur, avec ou sans compte dans le logiciel : la société prestataire tient lieu de rôle pour ses agents. */
  const staffBadgeCard = (st: ReturnType<typeof s.staff.get>, code: string): BadgeCard => {
    const set = s.admin.storeSettings(st.store_id);
    const user = st.user_id ? s.admin.getUser(st.user_id) : null;
    return {
      store: s.admin.getStore(st.store_id).name,
      logo: set.logo || null,
      name: st.name,
      role: st.category === 'contractor' ? (st.agency_name ?? STAFF_KINDS.contractor) : user ? ROLE_LABELS[user.role] : STAFF_KINDS[st.category],
      position: st.position,
      number: st.punch_number ? `${st.code} · n° ${st.punch_number}` : st.code,
      phone: st.phone,
      hiredOn: st.hired_on,
      code,
      photo: s.personnel.photo(st.id),
      expires: badgeExpiry(new Date(), set.badge.validityMonths),
      color: set.brandColor,
      color2: set.brandColor2,
    };
  };
  /** Code interne donné à l'enregistrement d'un article sans code, si le magasin l'a choisi. */
  const autoBarcode = () => (settings().barcodeAuto ? settings().barcodeKind : null);
  const codeByFamily = () => settings().articleCodeByFamily;
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
  /**
   * Modifier une facture validée : avec le droit (ses factures, toutes pour qui voit le registre),
   * ou avec la demande que le gérant a accordée à cet utilisateur pour cette facture (renvoyée, à marquer utilisée).
   */
  const editGrant = (saleId: string) => {
    const u = requireUser();
    const sale = s.pos.getSale(saleId);
    if (can(u, ['sale_edit']) && (sale.user_id === u.id || can(u, ['sales']))) return null;
    const grant = s.editRequests.granted(u.id, saleId);
    if (!grant) throw new AppError("Vous n'avez pas le droit de modifier cette facture : demandez-le au gérant", 'FORBIDDEN');
    return grant;
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
    const mine = se.register_id === c.registerId || s.pos.linkedRegisterIds(user!.id).includes(se.register_id);
    if (!mine && !can(user!, ['cash_open'])) throw new AppError("Seuls le caissier de cette caisse et le gérant y encaissent ou décaissent", 'FORBIDDEN');
    return { ...c, registerId: se.register_id };
  };
  const CUSTOMERS: Permission[] = ['customers', 'receivables'];
  const dossiers = () => {
    if (!system.dossiers) throw new AppError('Indisponible sur ce poste', 'UNAVAILABLE');
    return system.dossiers;
  };
  /** Fiche compressée (reçue par e-mail, WhatsApp) : décompressée à part, le fichier reçu n'est pas modifié. */
  const unpacked = new Map<string, string>();
  const local = async (file: string) => {
    if (!isPackedFiche(file)) return file;
    const done = unpacked.get(file);
    if (done) return done;
    const out = await unpackFiche(file, mkdtempSync(`${tmpdir()}/fedonix-recue-`));
    unpacked.set(file, out);
    return out;
  };
  /** Compresse la fiche pour l'envoyer et montre son dossier, prêt à glisser dans l'e-mail ou WhatsApp. */
  const send = async <T extends { file: string; size: number }>(info: T, dir: string): Promise<T> => {
    const file = await packFiche(info.file);
    await system.openFolder(dir).catch(() => undefined);
    return { ...info, file, size: statSync(file).size };
  };
  /** Une fiche emportée ne se relie jamais au serveur : ses modifications reviennent par la fiche. */
  const notInFiche = () => {
    if (s.fiches.current()) throw new AppError("Une fiche emportée ne se relie pas au serveur : rapportez-la à la boutique, qui fera suivre ses modifications", 'FICHE');
  };
  /** Modèles de boutique enregistrés sur ce PC (Documents › FEDONIX 360 › Modèles). */
  const templatesDir = () => join(dirname(dossiers().dir), 'Modèles');
  const templateFiles = (): (ShopTemplate & { file: string })[] => {
    const dir = system.dossiers ? templatesDir() : null;
    if (!dir || !existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith(`.${TEMPLATE_EXTENSION}`))
      .flatMap((f) => {
        try {
          return [{ ...parseTemplate(readFileSync(join(dir, f), 'utf8')), file: join(dir, f) }];
        } catch {
          return [];
        }
      });
  };
  const findTemplate = (idOrFile: string): ShopTemplate => {
    const builtin = BUILTIN_TEMPLATES.find((t) => t.id === idOrFile);
    if (builtin) return builtin;
    const saved = templateFiles().find((t) => t.file === idOrFile || t.id === idOrFile);
    if (saved) return saved;
    if (existsSync(idOrFile)) return parseTemplate(readFileSync(idOrFile, 'utf8'));
    throw new AppError('Modèle introuvable', 'NOT_FOUND');
  };
  const templateSummary = (t: ShopTemplate & { file?: string }) => ({
    id: t.file ?? t.id,
    name: t.name,
    description: t.description,
    builtin: !t.file,
    departments: t.departments.length,
    families: t.departments.reduce((n, d) => n + (d.families?.length ?? 0), 0),
    articles: t.articles?.length ?? 0,
  });
  /** Formats d'import et d'export de ce PC, après ceux livrés avec le logiciel. */
  const userFormats = (): FileFormat[] => {
    try {
      const v = JSON.parse(s.admin.getSetting('formats') ?? '[]') as FileFormat[];
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  };
  const exportModels = (): { id: string; name: string; columns: ArticleColumn[] }[] => {
    try {
      const v = JSON.parse(s.admin.getSetting('exportModels') ?? '[]') as { id: string; name: string; columns: ArticleColumn[] }[];
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  };
  const allFormats = (): FileFormat[] => [...BUILTIN_IMPORT_FORMATS, ...BUILTIN_EXPORT_FORMATS, ...userFormats()];
  const chooseOpenFile = async (title: string, name: string, extensions: string[]) => {
    if (!system.chooseOpenFile) throw new AppError('Indisponible sur ce poste', 'UNAVAILABLE');
    return system.chooseOpenFile(title, name, extensions);
  };
  /** Gérant ou administrateur : leur présence vaut validation (code superviseur). */
  const isSupervisor = (u: User) => u.role === 'admin' || u.role === 'manager';
  let lastStatusPush = 0;
  /** État de ce PC, envoyé au serveur et montré dans Administration › État des PC. */
  const stationStatus = (): StationStatus => {
    const station = s.admin.station();
    const st = s.sync.state();
    const backup = s.backups.status();
    const lic = s.license.status();
    const printerName = s.admin.getSetting('printer.name') || (s.admin.getSetting('printer.mode') === 'network' ? s.admin.getSetting('printer.host') : null);
    return {
      name: hostname(),
      register: station?.register?.name ?? null,
      version: appVersion,
      lastSyncAt: st.lastSyncAt,
      pending: st.pending,
      syncError: st.lastError,
      backupAt: backup.last_at,
      backupError: backup.last_error,
      printer: printerName || null,
      printerEnabled: s.admin.getSetting('printer.enabled') !== '0',
      license: { state: lic.state, canSell: lic.canSell, daysLeft: lic.daysLeft, message: lic.message },
      at: new Date().toISOString(),
    };
  };

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
        if (!user) return { electronic: [], byMethod: {} as Record<string, { id: string; name: string } | null>, bank: null };
        const u = user;
        const ids = s.pos.linkedRegisters(u.id);
        const named = (id: string | null) => (id ? { id, name: s.admin.getRegister(id).name } : null);
        // Pour chaque moyen électronique, la caisse qui le reçoit.
        const byMethod = Object.fromEntries(ELECTRONIC_METHODS.map((m) => [m, named(s.pos.registerFor(u.id, m))]));
        return { electronic: ids.electronic.map((id) => named(id)!), byMethod, bank: named(ids.bank) };
      })(),
      /** Préférences de l'utilisateur : onglets rapides épinglés, dernière version vue. */
      prefs: user ? s.admin.prefs(user.id) : {},
      /** Licence de ce PC : essai, valable, à renouveler ou bloquée. */
      license: (() => {
        const { license, ...rest } = s.license.status();
        return { ...rest, client: license?.client ?? null };
      })(),
      /** Boutique ouverte : son fichier et, si c'est une fiche emportée, ce qu'elle est (bandeau). */
      dossier: (() => {
        const fiche = s.fiches.current();
        return {
          file: system.dossiers?.file ?? null,
          fiche: fiche ? { kind: fiche.kind, storeName: fiche.storeName, at: fiche.at, byName: fiche.byName, banner: ficheBanner(fiche) } : null,
        };
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
    /** Langue de l'utilisateur connecté : celle de ses bons de caisse et rapports imprimés. */
    'prefs.lang': (): DocLang => (user && s.admin.prefs(user.id).lang === 'en' ? 'en' : 'fr'),
    /** Première boutique, au besoin à partir d'un modèle de métier (id d'un modèle livré ou fichier). */
    'setup.bootstrap': (input: BootstrapInput & { template?: string | null }) => {
      const { template, ...rest } = input;
      const t = template ? findTemplate(template) : null;
      const result = s.admin.bootstrap(rest);
      user = result.admin;
      if (t) s.templates.apply(result.admin.id, result.store.id, t);
      return result;
    },
    'setup.activateRegister': (code: string) => s.admin.activateRegister(code),
    /** Nouveau PC : rejoint un magasin existant via le serveur central (avant toute connexion). */
    'setup.join': (url: string, activationCode: string) => (notInFiche(), sync.join(url, activationCode)),
    /** PC du client : installe la boutique préparée au bureau (fiche d'installation) à la place de la base vide. */
    'setup.installFiche': (file: string) => {
      if (s.admin.isInitialized()) throw new AppError('Ce PC a déjà une boutique : ouvrez la fiche depuis « Ouvrir une boutique »', 'INVALID');
      const info = inspectDossier(file);
      if (!info.ok) throw new AppError(info.error ?? 'Fiche invalide', 'INVALID');
      if (info.fiche?.kind !== 'installation') throw new AppError("Ce fichier n'est pas une installation préparée au bureau", 'INVALID');
      dossiers().install(file);
      return info;
    },

    // --- Boutiques de ce PC ----------------------
    // Ouvrir une boutique se fait aussi avant la connexion : chaque boutique a ses propres utilisateurs.
    'dossier.list': () => dossiers().list(),
    'dossier.dir': () => dossiers().dir,
    'dossier.chooseFile': async () => {
      const file = await dossiers().chooseFile('Choisir la fiche ou la boutique à ouvrir');
      return file ? inspectDossier(await local(file)) : null;
    },
    'dossier.open': (file: string) => {
      const info = inspectDossier(file);
      if (!info.ok) throw new AppError(info.error ?? 'Boutique illisible', 'INVALID');
      if (info.fiche?.kind === 'installation') throw new AppError('Une installation préparée se copie sur ce PC avant de s’ouvrir : utilisez « Ouvrir une fiche »', 'INVALID');
      dossiers().open(file);
      return info;
    },
    /**
     * Fiche apportée sur une clé USB : copiée sur ce PC puis ouverte. Une installation
     * préparée devient une boutique ordinaire de ce PC (PC du technicien qui en suit plusieurs).
     */
    'dossier.importFiche': (file: string) => {
      const info = inspectDossier(file);
      if (!info.ok) throw new AppError(info.error ?? 'Fiche illisible', 'INVALID');
      const d = dossiers();
      if (d.list().some((x) => x.ok && x.fiche && info.fiche && x.fiche.id === info.fiche.id && x.file !== file)) {
        throw new AppError('Cette fiche est déjà dans la liste : ouvrez-la depuis la liste', 'INVALID');
      }
      // Nouvelle copie du comptable : elle remplace la précédente de la même boutique au lieu de s'empiler.
      const previous =
        info.fiche?.kind === 'comptable'
          ? d.list().find((x) => !x.current && x.fiche?.kind === 'comptable' && x.fiche.storeId === info.fiche!.storeId)
          : undefined;
      let target: string;
      if (previous) {
        copyFileSync(file, previous.file);
        target = previous.file;
      } else target = d.importFile(file);
      if (info.fiche?.kind === 'installation') installFiche(target, target);
      d.open(target);
      return inspectDossier(target);
    },
    'dossier.create': (name: string) => {
      if (!name.trim()) throw new AppError('Donnez un nom à la nouvelle boutique', 'INVALID');
      return dossiers().create(name.trim());
    },
    'dossier.forget': (file: string) => dossiers().forget(file),

    // --- Fiches boutique (emporter, rapporter) --------------------------------
    /** Fiche emportée sur une clé : intervention et installation pour l'administrateur, copie comptable pour qui exporte la comptabilité. */
    'fiche.export': async (kind: FicheKind, opts: { send?: boolean } = {}) => {
      const u = kind === 'comptable' ? requireUser(['accounting_export']) : requireAdmin();
      const dir = await system.chooseFolder(opts.send ? 'Choisir le dossier où mettre la fiche à envoyer' : 'Choisir la clé USB ou le dossier où mettre la fiche');
      if (!dir) return null;
      const info = await s.fiches.export(u, kind, dir, appVersion);
      return opts.send ? send(info, dir) : info;
    },
    /**
     * Mode formation : copie de la boutique ouverte où l'on vend pour s'entraîner.
     * Elle remplace la copie précédente ; rien n'en sort (ni serveur, ni sauvegarde, ni retour).
     */
    'training.start': async () => {
      const u = requireUser(['training']);
      const open = s.fiches.current();
      if (open?.kind === 'formation') throw new AppError('Vous êtes déjà en mode formation', 'INVALID');
      if (open) throw new AppError('Ouvrez la boutique elle-même pour passer en mode formation', 'FICHE');
      const d = dossiers();
      const station = s.admin.station();
      const slug = (station?.store.code ?? 'boutique').replace(/[^A-Za-z0-9]+/g, '-');
      const dir = join(dirname(d.dir), 'Formation');
      const info = await s.fiches.export(u, 'formation', dir, appVersion, { name: `Formation-${slug}.${FICHE_EXTENSION}`, log: false, origin: d.file });
      d.open(info.file);
      return info;
    },
    'training.stop': () => {
      const meta = s.fiches.current();
      if (meta?.kind !== 'formation') throw new AppError("Vous n'êtes pas en mode formation", 'INVALID');
      const d = dossiers();
      const back = meta.origin && d.list().find((x) => x.ok && x.file.toLowerCase() === meta.origin!.toLowerCase());
      d.open(back ? back.file : (d.list().find((x) => x.main)?.file ?? meta.origin ?? d.file));
      return true;
    },
    'fiche.history': () => (requireUser(['accounting_export', 'backups']), s.fiches.history()),
    'fiche.chooseReturn': async () => {
      requireAdmin();
      const file = await dossiers().chooseFile('Choisir la fiche à rapporter');
      return file ? s.fiches.check(await local(file)) : null;
    },
    'fiche.check': async (file: string) => (requireAdmin(), s.fiches.check(await local(file))),
    'fiche.bringBack': async (file: string) => {
      const u = requireAdmin();
      const back = s.fiches.bringBack(u.id, await local(file));
      s.fiches.archiveShared(file);
      return back;
    },
    // Dossier partagé (réseau, OneDrive, Google Drive) : copie du comptable déposée seule, fiches déposées par le technicien.
    'fiche.share': () => (requireAdmin(), s.fiches.shareStatus()),
    'fiche.shareConfigure': (input: { dir?: string | null; every?: number }) => s.fiches.configureShare(requireAdmin().id, input),
    'fiche.shareChooseDir': async () => {
      const u = requireAdmin();
      const dir = await system.chooseFolder('Choisir le dossier partagé (réseau, OneDrive, Google Drive)');
      return dir ? s.fiches.configureShare(u.id, { dir }) : null;
    },
    'fiche.shareNow': async () => {
      requireAdmin();
      const info = await s.fiches.autoShare(appVersion, true);
      if (!info) throw new AppError(s.fiches.shareStatus().last_error ?? 'Choisissez d’abord le dossier partagé', 'INVALID');
      return info;
    },
    /** Fiches déposées dans le dossier partagé et pas encore rapportées (barre d'état de l'administrateur). */
    'fiche.pendingCount': () => {
      const u = requireUser();
      return u.role === 'admin' && !s.fiches.current() ? s.fiches.shareStatus().pending.length : 0;
    },
    /** Chez le technicien : remet la fiche sur la clé pour la rapporter. */
    'fiche.saveCopy': async (opts: { send?: boolean } = {}) => {
      requireUser();
      if (!s.fiches.current()) throw new AppError("Cette boutique n'est pas une fiche emportée", 'INVALID');
      const dir = await system.chooseFolder(
        opts.send ? 'Choisir le dossier où mettre la fiche à renvoyer' : 'Choisir la clé USB, ou le dossier « Retours » du dossier partagé',
      );
      if (!dir) return null;
      const info = await s.fiches.saveCopy(dir);
      return opts.send ? send(info, dir) : info;
    },

    // --- Réparation ---------------------------
    'repair.check': () => (requireAdmin(), s.repair.check()),
    'repair.run': () => s.repair.repair(requireAdmin().id),

    // --- Modèles de boutique ------------
    // La liste se lit aussi avant la création de la boutique (premier démarrage).
    'template.list': () => [...BUILTIN_TEMPLATES, ...templateFiles()].map(templateSummary),
    'template.apply': (idOrFile: string) => {
      const u = requireAdmin();
      return s.templates.apply(u.id, ctx().storeId, findTemplate(idOrFile));
    },
    'template.choose': async () => {
      const file = await chooseOpenFile('Choisir le modèle de boutique', 'Modèle ONIX 360', [TEMPLATE_EXTENSION]);
      return file ? templateSummary({ ...parseTemplate(readFileSync(file, 'utf8')), file }) : null;
    },
    /** Fait un modèle de la boutique ouverte, rangé avec les modèles de ce PC (et copiable sur une clé). */
    'template.save': (input: { name: string; description?: string; articles?: boolean }) => {
      requireAdmin();
      const t = s.templates.capture(ctx().storeId, input);
      const dir = templatesDir();
      mkdirSync(dir, { recursive: true });
      const base = t.name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'modele';
      let file = join(dir, `${base}.${TEMPLATE_EXTENSION}`);
      for (let i = 2; existsSync(file); i++) file = join(dir, `${base}-${i}.${TEMPLATE_EXTENSION}`);
      writeFileSync(file, JSON.stringify(t, null, 1));
      return { file, ...templateSummary({ ...t, file }) };
    },
    'template.openFolder': async () => {
      requireAdmin();
      mkdirSync(templatesDir(), { recursive: true });
      await system.openFolder(templatesDir());
    },

    // --- Reprise des données d'un magasin existant ----------------------------
    'takeover.summary': () => (requireUser(['data_takeover']), s.opening.summary(ctx().storeId)),
    /** Le fichier arrive en cellules texte (CSV ou Excel lu par l'écran) ; `preview` ne fait que montrer ce qui serait repris. */
    'takeover.run': (kind: TakeoverKind, cells: string[][], opts: { preview: boolean; warehouseId?: string | null }) =>
      s.opening.run(ctx(['data_takeover']), kind, cells, opts),

    // --- Registre des immobilisations -----------------------------------------
    'assets.list': (opts: { at?: string; includeDisposed?: boolean } = {}) => (requireUser(['fixed_assets']), s.assets.list(ctx().storeId, opts)),
    'assets.schedule': (id: string) => (requireUser(['fixed_assets']), s.assets.schedule(id)),
    'assets.save': (input: AssetInput, id?: string) => s.assets.save(ctx(['fixed_asset_edit']), input, id),
    'assets.dispose': (id: string, input: Parameters<Services['assets']['dispose']>[2]) => s.assets.dispose(ctx(['fixed_asset_edit']), id, input),
    'assets.remove': (id: string) => s.assets.remove(ctx(['fixed_asset_edit']), id),
    'assets.print': (at: string, id?: string | null) => (requireUser(['fixed_assets']), printer.assets(ctx().storeId, at, id)),

    // --- Formats d'import et d'export paramétrables ---------------------------
    'formats.list': () => (requireUser(), allFormats()),
    'formats.save': (f: ImportFormat | ExportFormat) => {
      requireUser(f.kind === 'articles' ? ['import'] : ['accounting_export']);
      if (!f.name?.trim()) throw new AppError('Donnez un nom au format', 'INVALID');
      if (f.kind === 'articles' && (f.columns.name === undefined || f.columns.salePrice === undefined)) {
        throw new AppError('Indiquez au moins les colonnes de la désignation et du prix de vente', 'INVALID');
      }
      if (f.kind === 'ecritures' && !f.columns.length) throw new AppError('Choisissez les colonnes du fichier', 'INVALID');
      if ([...BUILTIN_IMPORT_FORMATS, ...BUILTIN_EXPORT_FORMATS].some((b) => b.id === f.id)) throw new AppError('Les formats livrés ne se modifient pas : enregistrez-en une copie', 'INVALID');
      // Deux formats enregistrés dans la même milliseconde ne doivent pas avoir le même identifiant.
      const newFormatId = () => {
        const base = `format-${Date.now()}`;
        const taken = new Set(userFormats().map((x) => x.id));
        let id = base;
        for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
        return id;
      };
      const saved = { ...f, name: f.name.trim(), id: f.id || newFormatId(), builtin: undefined };
      const list = userFormats().filter((x) => x.id !== saved.id);
      s.admin.setSetting('formats', JSON.stringify([...list, saved]));
      return saved;
    },
    'formats.delete': (id: string) => {
      const f = userFormats().find((x) => x.id === id);
      if (!f) throw new AppError('Format introuvable', 'NOT_FOUND');
      requireUser(f.kind === 'articles' ? ['import'] : ['accounting_export']);
      s.admin.setSetting('formats', JSON.stringify(userFormats().filter((x) => x.id !== id)));
    },

    // --- Postes distants (remontée par fichier, sans réseau) -----------------
    'relay.status': () => (requireUser(), s.relay.status()),
    /** Boutique : prépare sur une clé l'installation du PC d'un dépôt, sur une de ses caisses. */
    'relay.installRemote': async (registerId: string) => {
      const u = requireAdmin();
      const dir = await system.chooseFolder("Choisir la clé USB ou le dossier où mettre l'installation du poste distant");
      if (!dir) return null;
      return s.fiches.export(u, 'installation', dir, appVersion, { remote: { registerId } });
    },
    /** Poste distant : fichier des opérations du jour à porter ou envoyer à la boutique. */
    'relay.exportRemontee': async (opts: { send?: boolean } = {}) => {
      const u = requireUser(['cash', 'admin']);
      const dir = await system.chooseFolder(opts.send ? 'Choisir le dossier où mettre le fichier à envoyer' : 'Choisir la clé USB ou le dossier où mettre la remontée');
      if (!dir) return null;
      const out = s.relay.exportRemontee(u, dir);
      if (opts.send) await system.openFolder(dir).catch(() => undefined);
      return out;
    },
    /** Boutique : catalogue, prix et utilisateurs à renvoyer au poste distant. */
    'relay.exportUpdate': async (storeId: string, opts: { send?: boolean } = {}) => {
      const u = requireAdmin();
      const dir = await system.chooseFolder(opts.send ? 'Choisir le dossier où mettre le fichier à envoyer' : 'Choisir la clé USB ou le dossier où mettre la mise à jour');
      if (!dir) return null;
      const out = s.relay.exportUpdate(u, storeId, dir);
      if (opts.send) await system.openFolder(dir).catch(() => undefined);
      return out;
    },
    'relay.choose': async () => {
      requireUser(['cash', 'admin']);
      const file = await chooseOpenFile('Choisir le fichier de journée à intégrer', 'Journée ONIX 360', [RELAY_EXTENSION]);
      return file ? { file, ...s.relay.read(file) } : null;
    },
    'relay.integrate': (file: string) => {
      const u = s.relay.isRemote() ? requireUser(['cash', 'admin']) : requireAdmin();
      return s.relay.integrate(u.id, file);
    },
    'auth.login': (login: string, pin: string) => {
      chosenRegisterId = null;
      user = s.admin.login(login, pin);
      // Pointage : la première connexion du jour note l'arrivée (pas dans une fiche emportée ni en formation).
      const station = s.admin.station();
      if (station && !s.fiches.current()) s.attendance.arrive(user.id, station.store.id);
      return user;
    },
    /** Accord du gérant demandé sur son téléphone (PC relié au serveur). */
    'approval.request': async (action: string) => {
      const u = requireUser();
      return requestApproval(s, action, u.name);
    },
    /** Réponse du gérant ; accordée, elle sert de code pendant 2 minutes (« @accord:id »). */
    'approval.poll': async (id: string) => {
      requireUser();
      const r = await approvalStatus(s, id);
      if (r.status === 'approved' && r.decidedBy) {
        // La fiche du gérant doit être sur ce PC (reçue du serveur) pour valoir code.
        try {
          s.admin.getUser(r.decidedBy);
        } catch {
          throw new AppError(`${r.decidedName ?? 'Le gérant'} a accepté, mais sa fiche n'est pas encore sur ce PC : synchronisez puis redemandez`, 'SUPERVISOR_DENIED');
        }
        remoteApprovals.set(id, { userId: r.decidedBy, until: Date.now() + 120_000 });
        return { status: 'approved' as const, code: `@accord:${id}`, name: r.decidedName ?? null };
      }
      return { status: r.status, code: null, name: r.decidedName ?? null };
    },
    'approval.available': () => Boolean(s.sync.credentials()) && !s.fiches.current(),
    /** Badge scanné sur l'écran de connexion : l'identifiant qu'il porte. */
    'auth.badge': (code: string) => s.admin.loginForBadge(code),
    /** « Je pars » : départ noté pour le pointage, puis déconnexion. */
    'attendance.leave': () => {
      const u = requireUser();
      const station = s.admin.station();
      const row = s.fiches.current() ? null : s.attendance.leave(u.id, station?.store.id ?? null);
      user = null;
      chosenRegisterId = null;
      return row;
    },
    /** « Ma journée » sur l'accueil : seulement les chiffres de l'utilisateur connecté. */
    'me.day': () => {
      const c = ctx();
      return s.commissions.myDay(c.storeId, c.userId);
    },
    'attendance.today': () => {
      const u = requireUser();
      return s.attendance.get(u.id);
    },
    'attendance.month': (period: string, opts?: { category?: StaffKind | null; agencyId?: string | null }) => s.attendance.month(ctx(['staff_attendance']).storeId, period, opts ?? {}),
    'attendance.correct': (userId: string, day: string, input: { arrived: string | null; left: string | null; reason: string }) =>
      s.attendance.correct(requireUser(['staff_attendance']).id, userId, day, input),
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
    'admin.updateRegister': (id: string, patch: { name?: string; active?: boolean; methods?: string[] | null }) => s.admin.updateRegister(requireAdmin().id, id, patch),
    'admin.warehouses': (opts?: { includeInactive?: boolean }) => s.admin.listWarehouses(ctx().storeId, opts),
    'admin.createWarehouse': (name: string, kind: 'shop' | 'reserve' | 'cold', opts?: { purpose?: WarehousePurpose; customerId?: string | null }) =>
      s.admin.createWarehouse(ctx(['warehouses_manage']).storeId, name, kind, false, opts),
    'admin.updateWarehouse': (id: string, input: WarehouseInput) => {
      const c = ctx(['warehouses_manage']);
      if (s.admin.getWarehouse(id).store_id !== c.storeId) throw new AppError("Ce dépôt n'est pas dans ce magasin", 'FORBIDDEN');
      return s.admin.updateWarehouse(c.userId, id, input);
    },
    'admin.setWarehouseActive': (id: string, active: boolean) => {
      const c = ctx(['warehouses_manage']);
      if (s.admin.getWarehouse(id).store_id !== c.storeId) throw new AppError("Ce dépôt n'est pas dans ce magasin", 'FORBIDDEN');
      return s.admin.setWarehouseActive(c.userId, id, active);
    },
    'admin.setSalesWarehouse': (id: string) => {
      const c = ctx(['warehouses_manage']);
      if (s.admin.getWarehouse(id).store_id !== c.storeId) throw new AppError("Ce dépôt n'est pas dans ce magasin", 'FORBIDDEN');
      return s.admin.setSalesWarehouse(c.userId, id);
    },
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
    'admin.updateUser': (id: string, patch: UserRegisters & { name?: string; login?: string; role?: Role; storeId?: string | null; active?: boolean; pin?: string; saleWarehouses?: string[] | null }) => {
      const u = requireUser(['users_manage']);
      if (u.role !== 'admin' && (patch.role === 'admin' || s.admin.getUser(id).role === 'admin')) throw new AppError("Seul l'administrateur modifie un administrateur", 'FORBIDDEN');
      return s.admin.updateUser(u.id, id, patch);
    },
    'admin.deleteUser': (id: string) => {
      const u = requireUser(['users_manage']);
      if (u.role !== 'admin' && s.admin.getUser(id).role === 'admin') throw new AppError("Seul l'administrateur supprime un administrateur", 'FORBIDDEN');
      return s.admin.deleteUser(u.id, id);
    },
    'admin.newBadge': (id: string) => {
      const u = requireUser(['users_manage']);
      if (u.role !== 'admin' && s.admin.getUser(id).role === 'admin') throw new AppError("Seul l'administrateur modifie un administrateur", 'FORBIDDEN');
      return s.admin.newBadge(u.id, id);
    },
    /** Badges d'un ou plusieurs employés sur une planche A4, au format choisi dans Administration. */
    'admin.printBadge': (id: string | string[], copies = 1) => {
      requireUser(['users_manage']);
      const ids = Array.isArray(id) ? id : Array.from({ length: Math.max(1, Math.min(10, Math.round(copies))) }, () => id);
      const cards = ids.map((uid) => {
        const target = s.admin.getUser(uid);
        if (!target.badge) throw new AppError(`${target.name} n'a pas encore de badge`, 'INVALID');
        return badgeCard(target);
      });
      return printer.a4(badgesHtml(cards, settings().badge));
    },
    /** Aperçu du badge (Administration) : celui d'un employé, ou un exemple, avec les réglages en cours de modification. */
    'admin.badgePreview': (input: { userId?: string | null; layout?: BadgeLayout; color?: string; color2?: string }) => {
      requireUser();
      const set = settings();
      const layout = { ...set.badge, ...(input.layout ?? {}) };
      const card: BadgeCard = input.userId
        ? badgeCard(s.admin.getUser(input.userId))
        : {
            store: s.admin.getStore(ctx().storeId).name,
            logo: set.logo || null,
            name: 'Thomas MBARGA',
            role: 'Caissier',
            position: 'Caisse principale',
            number: 'COL-0012',
            phone: '6 99 12 34 56',
            hiredOn: '2024-03-01',
            code: 'FX12345678',
            photo: null,
            expires: badgeExpiry(new Date(), layout.validityMonths),
          };
      return badgesHtml([{ ...card, color: input.color ?? card.color ?? set.brandColor, color2: input.color2 ?? card.color2 ?? set.brandColor2 }], layout);
    },
    'admin.userPhoto': (id: string) => (requireUser(), s.admin.userPhoto(id)),
    'admin.setUserPhoto': (id: string, photo: string | null) => {
      const u = requireUser(['users_manage']);
      if (u.role !== 'admin' && s.admin.getUser(id).role === 'admin') throw new AppError("Seul l'administrateur modifie un administrateur", 'FORBIDDEN');
      s.admin.setUserPhoto(u.id, id, photo);
    },
    /** Nouvel employé : utilisateur, fiche collaborateur et badge en une fois. */
    'admin.hire': (input: {
      user: UserRegisters & { name: string; login: string; pin: string; role: Role; storeId: string | null; saleWarehouses?: string[] | null };
      staff?: Omit<StaffInput, 'name' | 'userId'> | null;
      badge?: boolean;
    }) => {
      const u = requireUser(['users_manage']);
      if (input.user.role === 'admin' && u.role !== 'admin') throw new AppError("Seul l'administrateur crée un administrateur", 'FORBIDDEN');
      if (input.staff && !can(u, ['staff_edit'])) throw new AppError('Vous ne pouvez pas créer de fiche collaborateur', 'FORBIDDEN');
      const station = s.admin.station();
      const storeId = input.user.storeId ?? station?.store.id;
      if (!storeId) throw new AppError("Ce poste n'est pas configuré", 'NO_STATION');
      return s.staff.hire({ storeId, registerId: null, userId: u.id }, input);
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
    /** Afficheur client : l'écran de caisse envoie le ticket en cours, ce PC le dessine. Jamais d'erreur pour la vente. */
    'display.show': (state: CustomerDisplayState) => {
      const station = s.admin.station();
      if (!system.customerDisplay || !user || !station) return;
      const mode = (s.admin.getSetting('display.customer') ?? 'off') as CustomerDisplayMode;
      if (!(mode in CUSTOMER_DISPLAY_MODES)) return;
      const storeId = station.store.id;
      system.customerDisplay.show(state, {
        mode,
        screen: Number(s.admin.getSetting('display.customerScreen')) || 2,
        port: (s.admin.getSetting('display.customerPort') ?? '').trim(),
        baud: Number(s.admin.getSetting('display.customerBaud')) || 9600,
        columns: Number(s.admin.getSetting('display.customerColumns')) || 20,
        welcome: s.admin.getSetting('display.customerMessage') ?? '',
        storeName: s.admin.getStore(storeId).name,
        logo: mode === 'screen' ? s.admin.storeSettings(storeId).logo || null : null,
      });
    },
    /** Écrans branchés à ce PC, pour choisir celui qui fait face au client. */
    'display.screens': () => (requireUser(), system.customerDisplay?.screens() ?? []),
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
      // Boutique en ligne et vérificateur de prix : le droit « online_shop » suffit pour ces réglages-là.
      const shopOnly = Object.keys(patch).length > 0 && Object.keys(patch).every((k) => k.startsWith('onlineShop') || k === 'priceChecker');
      const c = ctx(shopOnly ? ['settings_edit', 'online_shop'] : ['settings_edit']);
      if (patch.posLayout !== undefined) requireAdmin();
      // Les couleurs de l'entreprise et le badge valent pour tous ses magasins.
      const shared = Object.fromEntries(Object.entries(patch).filter(([k]) => k === 'brandColor' || k === 'brandColor2' || k === 'badge'));
      const saved = s.admin.saveStoreSettings(c.userId, c.storeId, patch);
      if (Object.keys(shared).length) for (const st of s.admin.listStores()) if (st.id !== c.storeId) s.admin.saveStoreSettings(c.userId, st.id, shared);
      return saved;
    },
    'admin.audit': (filters?: Parameters<Services['admin']['auditSearch']>[0]) => (requireUser(['audit']), s.admin.auditSearch(filters ?? {})),
    /** Nouvel employé au même poste qu'un autre (rôle, caisse, dépôts, privilèges). */
    'admin.copyUser': (fromId: string, input: { name: string; login: string; pin: string }) => s.admin.copyUser(requireUser(['user_copy']).id, fromId, input),
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
    'sync.state': () => {
      requireUser();
      // Le serveur reçoit l'état de ce PC toutes les 5 minutes (Administration › État des PC).
      if (s.sync.credentials() && Date.now() - lastStatusPush > 5 * 60_000) {
        lastStatusPush = Date.now();
        void pushStationStatus(s, stationStatus()).catch(() => undefined);
      }
      return s.sync.state();
    },
    'sync.connect': (url: string, enrollmentKey: string) => (requireAdmin(), notInFiche(), sync.connect(url, enrollmentKey)),
    'sync.now': () => (requireUser(), sync.now()),
    'sync.resend': () => (requireAdmin(), sync.resend()),
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
        return s.catalogue.saveArticle(u.id, noVat ? { ...input, vatRateId: s.admin.exemptRateId() } : input, id, { autoBarcode: autoBarcode(), codeByFamily: codeByFamily() });
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
        (input.maxQty ?? null) !== cur.max_qty ||
        (input.substituteId !== undefined && (input.substituteId || null) !== cur.substitute_id);
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
    /** `preview` : l'import est fait puis annulé, pour montrer ce qui serait créé, mis à jour ou refusé. */
    'catalogue.import': (rows: ArticleImportRow[], opts: { mode?: ImportMode; preview?: boolean } = {}) =>
      s.catalogue.importArticles(requireUser(['import']).id, rows, {
        noVat: s.admin.vatDisabled(ctx().storeId),
        mode: opts.mode,
        preview: opts.preview,
        autoBarcode: autoBarcode(),
        codeByFamily: codeByFamily(),
      }),
    'catalogue.exportList': (filter: ExportFilter = {}) => s.catalogue.listForExport(ctx(['article_export']).storeId, filter),
    'catalogue.setQtyTiers': (articleId: string, tiers: QtyTier[]) => s.catalogue.setQtyTiers(requireUser(['article_price', 'article_edit']).id, articleId, tiers),
    'catalogue.setLocation': (articleId: string, warehouseId: string, location: string) => {
      const c = ctx(['article_edit', 'stock_location']);
      if (s.admin.getWarehouse(warehouseId).store_id !== c.storeId) throw new AppError("Ce dépôt n'est pas dans ce magasin", 'FORBIDDEN');
      return s.catalogue.setLocation(c.userId, articleId, warehouseId, location);
    },
    /** Modèles d'export personnalisés de la liste des produits (colonnes choisies), gardés sur ce PC. */
    'catalogue.exportModels': () => (requireUser(['article_export']), exportModels()),
    'catalogue.saveExportModel': (m: { id?: string; name: string; columns: ArticleColumn[] }) => {
      requireUser(['article_export']);
      if (!m.name?.trim()) throw new AppError('Donnez un nom au modèle', 'INVALID');
      const columns = (m.columns ?? []).filter((c) => c in ARTICLE_COLUMNS);
      if (!columns.length) throw new AppError('Choisissez au moins une colonne', 'INVALID');
      const saved = { id: m.id || `modele-${Date.now()}`, name: m.name.trim(), columns };
      s.admin.setSetting('exportModels', JSON.stringify([...exportModels().filter((x) => x.id !== saved.id), saved]));
      return saved;
    },
    'catalogue.deleteExportModel': (id: string) => {
      requireUser(['article_export']);
      s.admin.setSetting('exportModels', JSON.stringify(exportModels().filter((x) => x.id !== id)));
    },
    'catalogue.pricePlan': (input: PriceUpdateInput) => s.catalogue.planPriceUpdate(ctx(['price_update']).storeId, input),
    'catalogue.priceApply': (input: PriceUpdateInput) => {
      const c = ctx(['price_update']);
      return s.catalogue.applyPriceUpdate(c.userId, c.storeId, input);
    },

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
    'purchases.freeGoods': (from: string, to: string) => s.purchases.freeGoods(ctx(['free_goods']).storeId, from, to),
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
    /** Bon de commande envoyé au fournisseur par WhatsApp (au numéro de sa fiche, ou celui tapé). */
    'purchases.whatsappOrder': (id: string, phone?: string | null) => {
      requireUser(['purchase_orders']);
      const order = s.purchases.getOrder(id);
      const supplier = s.purchases.getSupplier(order.supplier_id);
      const store = s.admin.getStore(order.store_id);
      const text = purchaseOrderMessage({
        store: store.name,
        storePhone: store.phone,
        supplier: supplier.name,
        number: order.number,
        expected: order.expected_date,
        lines: order.lines.map((l) => ({ label: l.article_name, qty: formatQty(l.qty, l.unit), reference: l.supplier_ref })),
        total: order.total_ht || null,
      });
      const link = whatsappLink(phone?.trim() || supplier.phone, text);
      if (!link) throw new AppError('Tapez le numéro WhatsApp du fournisseur (9 chiffres)', 'NO_PHONE');
      return { link, text, phone: phone?.trim() || supplier.phone };
    },
    'purchases.printOrder': (id: string, opts?: { templateId?: string | null; format?: DocFormat | null; output?: 'print' | 'pdf' }) => (requireUser(), printer.purchaseOrder(id, opts)),
    'purchases.previewOrder': (id: string, opts?: { templateId?: string | null; format?: DocFormat | null }) => (
      requireUser(), { ...printer.previewPurchaseOrder(id, opts), doc: 'purchaseOrder' as const, variant: 'order' as DocVariant }
    ),
    'purchases.receptions': (opts?: { supplierId?: string; uninvoiced?: boolean }) => s.purchases.listReceptions(ctx().storeId, opts),
    'purchases.reception': (id: string) => (requireUser(), s.purchases.getReception(id)),
    'purchases.invoicePreview': (receptionIds: string[]) => (requireUser(), s.purchases.invoicePreview(receptionIds)),
    'purchases.createInvoice': (input: Parameters<Services['purchases']['createInvoice']>[1]) => s.purchases.createInvoice(ctx(['purchase_invoices']), input),
    'supplierReturns.list': (opts?: { supplierId?: string | null; open?: boolean }) => s.supplierReturns.list(ctx(['supplier_returns']).storeId, opts),
    'supplierReturns.pending': () => s.supplierReturns.pending(ctx(['supplier_returns']).storeId),
    'supplierReturns.get': (id: string) => (ctx(['supplier_returns']), s.supplierReturns.get(id)),
    'supplierReturns.create': (input: Parameters<Services['supplierReturns']['create']>[1]) => s.supplierReturns.create(ctx(['supplier_returns']), input),
    'supplierReturns.credit': (id: string, input: Parameters<Services['supplierReturns']['credit']>[2]) => s.supplierReturns.credit(ctx(['supplier_returns', 'purchase_invoices']), id, input),
    'supplierReturns.print': (id: string) => (ctx(['supplier_returns']), printer.supplierReturn(id)),
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
    'purchases.reorder': (coverDays?: number, opts?: Omit<ReorderOptions, 'coverDays'>) => s.purchases.reorderProposal(ctx(['reorder']).storeId, { ...opts, coverDays }),
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
    'pos.priceLines': (lines: SaleLineInput[], level?: PriceLevel, customerId?: string | null) => s.pos.priceLines(ctx().storeId, lines, level ?? 'retail', customerId ?? null),
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
      orderId?: string | null;
      clientName?: string | null;
      priceLevel?: PriceLevel | null;
      warehouseId?: string | null;
      /** Code du gérant qui a permis le tarif ou le dépôt choisis, si le caissier n'en a pas le droit. */
      optionsPin?: string;
      delivery?: DeliveryInput | null;
      /** Facture modifiée : elle est annulée et remplacée par celle-ci ; `payments` ne porte que la différence. */
      replacesId?: string | null;
      /** Vendeur du panier préparé au rayon. */
      sellerId?: string | null;
      /** Monnaie gardée sur le compte du client ou en bon de monnaie. */
      keepChange?: Fcfa | null;
      /** Vente du carnet à souches (panne) : numéro de la souche et heure écrite. */
      book?: { number: string; at: string } | null;
    }) => {
      const c = ctx(POS);
      if (input.book) requireUser(['sale_book']);
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
        orderId: input.orderId ?? null,
        clientName: input.clientName ?? null,
        priceLevel: input.priceLevel ?? null,
        warehouseId: input.warehouseId ?? null,
        delivery: input.delivery ?? null,
        sellerId: input.sellerId ?? null,
        keepChange: input.keepChange ?? null,
        book: input.book ?? null,
      };
      if (input.replacesId) {
        const grant = editGrant(input.replacesId);
        const replaced = s.pos.replaceSale(c, input.replacesId, saleInput, user!.id);
        if (grant) s.editRequests.markUsed(c, grant.id, replaced.id);
        return replaced;
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
    /** Demande de modification d'une facture validée, accordée ou refusée par le gérant. */
    'editRequests.request': (saleId: string, reason: string) => {
      requireSaleAccess(saleId);
      return s.editRequests.request(ctx(['sale_edit_request']), saleId, reason);
    },
    'editRequests.decide': (id: string, approve: boolean, note?: string | null) => s.editRequests.decide(ctx(['sale_edit_approve']), id, approve, note),
    /** Le gérant voit toutes les demandes du magasin ; les autres, les leurs. */
    'editRequests.list': (status?: EditRequestStatus | null) => {
      const c = ctx();
      return s.editRequests.list(c.storeId, { status, requestedBy: can(user!, ['sale_edit_approve']) ? null : c.userId });
    },
    /** Facture à recharger dans la caisse pour la modifier. */
    'sales.editable': (saleId: string) => {
      requireSaleAccess(saleId);
      const sale = s.pos.getSale(saleId);
      editGrant(saleId);
      return { ...s.pos.editableSale(saleId), number: sale.number, credit: sale.payments.some((p) => p.method === 'CUSTOMER_CREDIT') };
    },
    'pos.return': async (input: { originalSaleId: string; lines: { lineId: string; qty: Milli }[]; refundMethod: PaymentMethod; supervisorPin: string; reason: string }) => {
      const ret = s.pos.returnSale(ctx(['sale_return']), { ...input, supervisorId: supervisor(input.supervisorPin).id });
      // Remboursé en bon d'avoir : le bon s'imprime avec son code-barres.
      const code = input.refundMethod === 'VOUCHER' ? ret.payments.find((p) => p.method === 'VOUCHER')?.reference : null;
      const voucher = code ? s.vouchers.byCode(code) : null;
      if (voucher) await printer.giftVoucher(voucher.id).catch(() => undefined);
      return ret;
    },
    'pos.findSale': (number: string) => (requireUser(), s.pos.findSaleByNumber(number)),
    'pos.sale': (id: string) => (requireSaleAccess(id), s.pos.getSale(id)),
    'pos.sales': (opts: { sessionId?: string; date?: string }) => {
      const c = ctx();
      return can(user!, ['sales']) ? s.pos.listSales({ ...opts, storeId: c.storeId }) : ownRecent(user!);
    },
    /**
     * Ticket envoyé au client par WhatsApp : le message rempli et le lien qui
     * ouvre WhatsApp au numéro du client (celui de sa fiche, ou celui tapé).
     */
    'pos.whatsappTicket': (saleId: string, phone?: string | null) => {
      requireSaleAccess(saleId);
      const sale = s.pos.getSale(saleId);
      const store = s.admin.getStore(sale.store_id);
      const customer = sale.customer_id ? s.customers.getCustomer(sale.customer_id) : null;
      const number = phone?.trim() || customer?.phone || '';
      const text = ticketMessage({
        store: store.name,
        storePhone: store.phone,
        number: sale.number,
        date: sale.created_at,
        kind: sale.kind,
        customer: customer?.name ?? sale.customer_name,
        lines: sale.lines.map((l) => ({
          label: l.pack_name ? `${l.label} (${l.pack_name})` : l.label,
          qty: l.pack_units ? formatQty(Math.round((l.qty * 1000) / l.pack_units), 'piece') : formatQty(l.qty, l.unit),
          total: Math.abs(l.total_ttc),
        })),
        total: Math.abs(sale.total_ttc),
        discount: sale.total_discount + sale.total_promo,
        payments: sale.payments.map((p) => ({ label: PAYMENT_METHODS[p.method], amount: Math.abs(p.amount) })),
        change: sale.change_given,
      });
      const link = whatsappLink(number, text);
      if (!link) throw new AppError('Tapez le numéro WhatsApp du client (9 chiffres)', 'NO_PHONE');
      return { link, text, phone: number };
    },
    /** Téléphone du client du ticket (proposé avant l'envoi par WhatsApp). */
    'pos.ticketPhone': (saleId: string) => {
      requireSaleAccess(saleId);
      const sale = s.pos.getSale(saleId);
      return sale.customer_id ? (s.customers.getCustomer(sale.customer_id).phone ?? null) : null;
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
    /** Paniers préparés au rayon par les vendeurs (téléphone), en attente d'une caisse. */
    'pos.shelfCarts': async () => {
      ctx(POS);
      if (s.fiches.current() || !s.sync.credentials()) return [];
      const carts = await shelfCarts(s).catch(() => []);
      return carts.map((c) => ({ id: c.id, number: c.number, label: c.label, sellerName: c.sellerName, at: c.at, lines: c.lines.length }));
    },
    /** Prend le panier : ses lignes arrivent sur la fiche, la vente comptera pour le vendeur. */
    'pos.takeShelfCart': async (id: string) => {
      const c = ctx(['sale_resume']);
      const cart = await takeShelfCart(s, id);
      const known = (articleId: string) => {
        try {
          s.catalogue.getArticle(articleId, c.storeId);
          return true;
        } catch {
          return false;
        }
      };
      const lines: SaleLineInput[] = cart.lines.filter((l) => known(l.articleId)).map((l) => ({ articleId: l.articleId, qty: l.qty, packId: l.packId ?? null }));
      let sellerId: string | null = null;
      try {
        sellerId = s.admin.getUser(cart.sellerId).id;
      } catch {
        sellerId = null;
      }
      return { lines, sellerId, sellerName: cart.sellerName, label: cart.label, number: cart.number, missing: cart.lines.length - lines.length };
    },
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
        linked: s.pos
          .linkedRegisterIds(user!.id)
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
      const mine = s.pos.linkedRegisterIds(u.id).includes(registerId);
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
      const mine = s.pos.linkedRegisterIds(u.id).includes(registerId);
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
          return s.pos.linkedRegisters(u.id).electronic.flatMap((reg) => {
            const se = s.pos.listSessions(c.storeId, 1, reg)[0];
            return se ? s.emoney.sessionExits(se.id).filter((e) => !e.closing && e.user_id === u.id) : [];
          });
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
      const closed = s.pos.closeSession(c, counted, { floatLeft: opts.floatLeft, gapReason: opts.gapReason ?? null, gapApprovedBy: approvedBy });
      if (!s.fiches.current()) s.attendance.leave(c.userId, c.storeId);
      return closed;
    },
    /**
     * Clôture par le caissier sans le droit des montants : ni Z ni attendu en
     * retour, seulement son bon de versement. Le comptage est enregistré tel
     * quel ; le gérant justifie un éventuel écart ensuite, depuis son compte.
     */
    'treasury.closeBlind': (counted: DenominationCount, opts: { floatLeft: Fcfa; registerId?: string }) => {
      const c = sameRegister(ctx(TREASURY), opts.registerId);
      const se = s.pos.closeSession(c, counted, { floatLeft: opts.floatLeft }).session;
      if (!s.fiches.current()) s.attendance.leave(c.userId, c.storeId);
      const voucher = s.treasury.sessionMovements(se.id).find((m) => m.kind === 'DEPOSIT' && !m.cash_operation_id);
      return { sessionId: se.id, counted: se.counted_cash ?? 0, floatLeft: se.float_left ?? 0, deposit: se.deposit ?? 0, voucherId: voucher?.id ?? null, voucherNumber: voucher?.number ?? null };
    },
    /**
     * Relève d'équipe : le caissier qui part compte le tiroir à l'aveugle, celui
     * qui arrive tape son identifiant et son code. Le bon de passation s'imprime,
     * la journée continue au nom du nouveau caissier (même fond, même Z).
     */
    'treasury.handover': async (counted: DenominationCount, login: string, pin: string, registerId?: string) => {
      const c = sameRegister(ctx(TREASURY), registerId);
      const station = s.admin.station()!;
      const next = s.admin.login(login, pin);
      if (!can(next, TREASURY)) throw new AppError(`${next.name} n'a pas accès à la caisse`, 'FORBIDDEN');
      const own = s.admin.getUser(next.id).register_id;
      if (own && own !== c.registerId) throw new AppError(`${next.name} travaille sur une autre caisse : attribuez-lui ${s.admin.getRegister(c.registerId!).name} dans sa fiche`, 'INVALID');
      if (!own && !isSupervisor(next)) throw new AppError(`Aucune caisse n'est attribuée à ${next.name}`, 'INVALID');
      const h = s.pos.handover(c, counted, next.id);
      if (!s.fiches.current()) {
        s.attendance.leave(c.userId, c.storeId);
        s.attendance.arrive(next.id, station.store.id);
      }
      user = next;
      chosenRegisterId = own ? null : c.registerId;
      await printer.handover(h.id).catch(() => undefined);
      return { id: h.id, number: h.number, from: h.from_name, to: h.to_name, counted: h.counted };
    },
    'treasury.printHandover': (id: string) => (requireUser(TREASURY), printer.handover(id)),
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
          const holder = s.admin.emoneyHolders(r.id)[0];
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
      // Le code saisi l'emporte : il sert aussi à dépasser le plafond des avances.
      const by = supervisorPin ? supervisor(supervisorPin).id : can(user!, ['cashout']) ? user!.id : supervisor('').id;
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
    'staff.recordSalaries': (period: string, lines: { staffId: string; gross: Fcfa; deducted?: Fcfa; commission?: Fcfa; attendance?: SalaryAttendance | null }[]) =>
      s.staff.recordSalaries(ctx(['staff_salaries']), period, lines),
    /** Salaires du mois proposés d'après le pointage (règles des paramètres). */
    'staff.payProposals': (period: string) => s.attendance.payProposals(ctx(['staff_salaries']).storeId, period),
    'staff.targets': (period: string) => s.commissions.month(ctx(['staff_targets']).storeId, period),
    'staff.setTarget': (staffId: string, input: SalesTargetInput) => s.commissions.setTarget(ctx(['staff_targets']), staffId, input),
    'staff.commissions': (period: string) => s.commissions.commissions(ctx(['staff_salaries']).storeId, period),
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

    // --- Personnel : prestataires, entrées, équipes, badges et pointage ------------------------
    'personnel.agencies': (includeInactive?: boolean) => s.personnel.agencies(ctx(['staff', 'staff_edit', 'staff_agencies', 'staff_attendance']).storeId, includeInactive),
    'personnel.saveAgency': (input: AgencyInput, id?: string | null) => s.personnel.saveAgency(ctx(['staff_agencies']), input, id),
    'personnel.entrances': (includeInactive?: boolean) => s.personnel.entrances(ctx().storeId, includeInactive),
    'personnel.saveEntrance': (input: { name: string; active?: boolean }, id?: string | null) => s.personnel.saveEntrance(ctx(['staff_teams']), input, id),
    'personnel.teams': (includeInactive?: boolean) => s.personnel.teams(ctx(['staff_teams', 'staff_leaves', 'staff_edit', 'staff_attendance']).storeId, includeInactive),
    'personnel.saveTeam': (input: TeamInput, id?: string | null) => s.personnel.saveTeam(ctx(['staff_teams']), input, id),
    'personnel.setTeam': (staffId: string, input: { teamId?: string | null; rotation?: Rotation | null }) => s.personnel.setTeam(ctx(['staff_teams']), staffId, input),
    'personnel.newBadge': (staffId: string) => s.personnel.newBadge(ctx(['staff_badges']), staffId),
    'personnel.setPunchPin': (staffId: string, pin: string | null) => s.personnel.setPunchPin(ctx(['staff_badges']), staffId, pin),
    'personnel.newPunchNumber': (staffId: string) => s.personnel.newPunchNumber(ctx(['staff_badges']), staffId),
    /** Badges de collaborateurs (avec ou sans compte) sur une planche A4. */
    'personnel.printBadges': (ids: string[]) => {
      requireUser(['staff_badges']);
      const cards = ids.map((id) => {
        const st = s.staff.get(id);
        const code = st.badge ?? st.user_badge;
        if (!code) throw new AppError(`${st.name} n'a pas encore de badge`, 'INVALID');
        return staffBadgeCard(st, code);
      });
      return printer.a4(badgesHtml(cards, settings().badge));
    },
    'personnel.badgePreview': (id: string) => {
      requireUser(['staff', 'staff_edit', 'staff_badges']);
      const st = s.staff.get(id);
      return badgesHtml([staffBadgeCard(st, st.badge ?? st.user_badge ?? 'FP00000000')], settings().badge);
    },
    'personnel.photo': (staffId: string) => (requireUser(['staff', 'staff_edit', 'staff_attendance', 'staff_kiosk']), s.personnel.photo(staffId)),
    'personnel.setPhoto': (staffId: string, photo: string | null) => s.personnel.setPhoto(ctx(['staff_edit']), staffId, photo),
    'personnel.documents': (staffId: string) => (requireUser(['staff_documents']), s.personnel.documents(staffId)),
    'personnel.document': (id: string) => (requireUser(['staff_documents']), s.personnel.document(id)),
    'personnel.addDocument': (staffId: string, input: { label: string; fileName?: string | null; data: string; expiresOn?: string | null }) =>
      s.personnel.addDocument(ctx(['staff_documents']), staffId, input),
    'personnel.removeDocument': (id: string) => s.personnel.removeDocument(ctx(['staff_documents']), id),
    'personnel.alerts': () => s.personnel.alerts(ctx(['staff', 'staff_edit', 'staff_attendance']).storeId),
    /** Jours fériés d'une année, d'après les paramètres (ou ceux en cours de modification). */
    'personnel.holidays': (year: number, draft?: { cameroon: boolean; extra: string }) => {
      const c = ctx();
      const set = s.admin.storeSettings(c.storeId);
      const map = holidaysBetween(`${year}-01-01`, `${year}-12-31`, draft ?? { cameroon: set.holidaysCameroon, extra: set.holidaysExtra });
      return [...map.entries()].map(([day, label]) => ({ day, label }));
    },
    'punches.presence': () => s.punches.presence(ctx(['staff_presence', 'staff_attendance']).storeId),
    /** Retards et absences signalés (aujourd'hui et la veille). */
    'staffWatch.alerts': () => {
      const c = ctx(['staff_presence', 'staff_attendance']);
      // Sans attendre le tour de la minute : l'écran montre tout de suite les retards nouveaux.
      s.staffWatch.scan(c.storeId);
      return s.staffWatch.alerts(c.storeId);
    },
    'staffWatch.handle': (id: string) => s.staffWatch.handle(ctx(['staff_presence', 'staff_attendance']), id),
    'staffWatch.warnings': (staffId?: string | null) => s.staffWatch.warnings(ctx(['staff', 'staff_edit', 'staff_attendance']).storeId, { staffId: staffId ?? null }),
    'staffWatch.addWarning': (staffId: string, input: { day: string; kind: WarningKind; reason: string }) => s.staffWatch.addWarning(ctx(['staff_edit']), staffId, input),
    'staffWatch.cancelWarning': (id: string) => s.staffWatch.cancelWarning(ctx(['staff_edit']), id),
    'staffWatch.printWarning': (id: string) => (requireUser(['staff_edit']), printer.staffWarning(id)),
    /** Avertissements à envisager : trop de retards dans le mois. */
    'staffWatch.suggestions': (period: string) => {
      const c = ctx(['staff_edit', 'staff_attendance']);
      return s.staffWatch.suggestions(c.storeId, s.attendance.month(c.storeId, period), period);
    },

    // --- Pointeuses à empreinte --------------------------------------------------------------------
    'fingerprint.devices': () => s.fingerprint.devices(ctx(['staff_kiosk', 'staff_teams', 'staff_attendance']).storeId),
    'fingerprint.saveDevice': (id: string, input: { name: string; entranceId?: string | null; active?: boolean }) => s.fingerprint.saveDevice(ctx(['staff_kiosk']), id, input),
    /** Ce PC reçoit-il les pointeuses, sur quel port et à quelles adresses ? */
    'fingerprint.state': () => (requireUser(['staff_kiosk', 'staff_teams']), system.fingerprint?.state() ?? { port: null, listening: false, error: null, lastAt: null, addresses: [] }),
    /** Fait écouter ce PC (port) ou l'arrête (null). */
    'fingerprint.configure': (port: number | null) => {
      requireUser(['staff_kiosk']);
      if (port !== null && (!Number.isInteger(port) || port < 1024 || port > 65535)) throw new AppError('Port entre 1024 et 65535', 'INVALID');
      s.admin.setSetting('fingerprint.port', port ? String(port) : '');
      system.fingerprint?.apply();
      return system.fingerprint?.state() ?? null;
    },
    /** Fichier « attlog » de la clé USB de la pointeuse. */
    'fingerprint.import': (text: string) => {
      const c = ctx(['staff_attendance']);
      if (typeof text !== 'string' || text.length > 20_000_000) throw new AppError('Fichier trop gros', 'INVALID');
      return s.fingerprint.importFile(c, text);
    },
    'punches.day': (staffId: string, day: string) => (requireUser(['staff_attendance']), s.punches.dayPunches(staffId, day)),
    'punches.correctDay': (staffId: string, day: string, input: { arrived: string | null; left: string | null; reason: string }) => s.punches.correctDay(ctx(['staff_attendance']), staffId, day, input),
    'punches.cancel': (id: string, reason: string) => s.punches.cancel(ctx(['staff_attendance']), id, reason),

    // --- Borne de pointage -----------------------------------------------------------------------
    /** Ce PC est-il une borne, et pour quelle entrée ? La borne s'affiche à la place de l'écran de connexion. */
    'kiosk.state': () => {
      const station = s.admin.station();
      if (!station) return null;
      const set = s.admin.storeSettings(station.store.id);
      const configured = s.admin.getSetting('kiosk.entrance') || null;
      const entrances = s.personnel.entrances(station.store.id);
      const entrance = (configured && entrances.find((e) => e.id === configured)) || (configured ? (entrances[0] ?? null) : null);
      return {
        /** Borne de ce PC (null : PC ordinaire). */
        here: Boolean(configured && set.punchKiosk),
        entranceId: entrance?.id ?? null,
        entranceName: set.multiEntrances ? (entrance?.name ?? null) : null,
        store: station.store.name,
        enabled: set.punchKiosk,
        badge: set.punchBadge,
        pin: set.punchPin,
        photo: set.punchPhoto,
        multiEntrances: set.multiEntrances,
      };
    },
    /** Fait de ce PC la borne d'une entrée (ou le remet en PC ordinaire avec null). */
    'kiosk.configure': (entranceId: string | null) => {
      const c = ctx(['staff_kiosk']);
      if (entranceId === null) return void s.admin.setSetting('kiosk.entrance', '');
      const id = entranceId === 'main' ? s.personnel.mainEntrance(c).id : entranceId;
      const e = s.personnel.getEntrance(id);
      if (e.store_id !== c.storeId) throw new AppError("Cette entrée est d'un autre magasin", 'FORBIDDEN');
      s.admin.setSetting('kiosk.entrance', id);
    },
    /**
     * Passage à la borne. Sans utilisateur connecté, seulement sur un PC réglé en
     * borne ; sinon il faut le droit d'ouvrir la borne.
     */
    'kiosk.punch': (input: { badge?: string | null; number?: number | string | null; pin?: string | null; photo?: string | null; entranceId?: string | null }) => {
      const station = s.admin.station();
      if (!station) throw new AppError("Ce poste n'est pas configuré", 'NO_STATION');
      const here = s.admin.getSetting('kiosk.entrance') || null;
      if (!here) requireUser(['staff_kiosk']);
      return s.punches.punch(station.store.id, {
        ...input,
        entranceId: here ?? input.entranceId ?? null,
        station: station.register ? `${station.store.code}-${station.register.number}` : station.store.code,
      });
    },
    'treasury.printReport': (sessionId: string) => {
      const u = requireUser(TREASURY);
      if (can(u, AMOUNTS)) return printer.sessionReport(sessionId);
      // Le caissier imprime le bon de clôture de sa caisse électronique ou banque, sans l'attendu.
      const se = s.pos.getSession(sessionId);
      if (!s.pos.linkedRegisterIds(u.id).includes(se.register_id)) requireAmounts();
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
          color: set.brandColor,
          message: set.ticketHeader,
          thanks: s.admin.getSetting('ticket.footer') ?? 'Merci de votre visite !',
          vatEnabled: store.vat_enabled === 1,
        }),
      };
    },

    // --- Clients et crédit ----------------------------------------------------
    'customers.list': (opts?: { search?: string; includeInactive?: boolean; withBalance?: boolean; zone?: string | null }) => s.customers.listCustomers(ctx().storeId, opts),
    'customers.zones': () => (requireUser(), s.customers.zones()),
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
      // Remises par famille : un prix convenu, comme le tarif. Sans le droit, la fiche garde les siennes.
      if (!can(u, ['customer_price_level'])) input = { ...input, familyDiscounts: undefined, articlePrices: undefined };
      // Fiche fournisseur liée : elle permet de compenser les deux comptes.
      if (!can(u, ['account_offsets', 'receivables'])) input = { ...input, supplierId: undefined };
      if (!can(u, ['customer_deactivate']) && (input.active ?? active) !== active) throw new AppError("Vous n'avez pas le droit de désactiver un client", 'FORBIDDEN');
      // Interdit de chèque : décidé par le gérant ou le comptable, comme le crédit.
      if (!can(u, ['receivables', 'cheque_rejections']) && input.noCheque !== undefined && input.noCheque !== Boolean(before?.no_cheque)) {
        throw new AppError("Vous n'avez pas le droit d'autoriser ou d'interdire les chèques à un client", 'FORBIDDEN');
      }
      const fiche = (a: { name: string; phone?: string | null; contact?: string | null; email?: string | null; address?: string | null; notes?: string | null }) =>
        [a.name.trim(), a.phone ?? '', a.contact ?? '', a.email ?? '', a.address ?? '', a.notes ?? ''].join('|');
      if (!id && !can(u, ['customer_create'])) throw new AppError("Vous n'avez pas le droit de créer un client", 'FORBIDDEN');
      if (before && !can(u, ['customer_edit']) && fiche(input) !== fiche(before)) throw new AppError("Vous n'avez pas le droit de modifier la fiche d'un client", 'FORBIDDEN');
      return s.customers.saveCustomer(u.id, { ...input, creditLimit: input.creditLimit ?? credit, paymentTermsDays: input.paymentTermsDays ?? terms }, id);
    },
    'customers.account': (id: string) => s.customers.account(ctx().storeId, id),
    'mobilepay.methods': () => (requireUser(), s.mobilePay.enabled()),
    'mobilepay.config': () => (requireUser(['settings_edit']), s.mobilePay.config()),
    'mobilepay.saveConfig': (method: MobileMethod, patch: Partial<MtnConfig> | Partial<OrangeConfig>) => s.mobilePay.saveConfig(requireUser(['settings_edit']).id, method, patch),
    'mobilepay.setupSandbox': () => s.mobilePay.setupMtnSandbox(requireUser(['settings_edit']).id),
    'mobilepay.request': (input: { method: MobileMethod; phone: string; amount: Fcfa; label?: string | null }) => s.mobilePay.request(ctx(), input),
    'mobilepay.status': (id: string) => (requireUser(), s.mobilePay.status(id)),
    'mobilepay.cancel': (id: string) => s.mobilePay.cancel(ctx(), id),
    'mobilepay.list': () => s.mobilePay.list(ctx(['settings_edit']).storeId),
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
      return printer.a4(loyaltyCardHtml({ store: s.admin.getStore(storeId).name, customer: c.name, code: c.code, phone: c.phone, logo: settings().logo || null, color: settings().brandColor }, copies));
    },
    /** Carte scannée à la caisse : code du client ou numéro de téléphone. */
    'loyalty.findCustomer': (code: string) => (requireUser(), s.customers.findByCard(code)),
    'customers.statement': (id: string, from?: string | null, to?: string | null) =>
      s.customers.statement(ctx(['customer_statement', 'receivables']).storeId, id, { from: from ?? undefined, to: to ?? undefined }),
    'customers.sales': (id: string) => s.pos.listSales({ storeId: ctx().storeId, customerId: id, limit: 100 }),
    'customers.pay': (input: {
      customerId: string;
      method: CustomerPaymentMethod;
      amount: Fcfa;
      reference?: string | null;
      notes?: string | null;
      atRegister?: boolean;
      /** Lettrage : factures que ce règlement solde, au lieu des plus anciennes. */
      allocations?: { saleId: string; amount: Fcfa }[] | null;
    }) => {
      const c = ctx(['customer_payment']);
      if (input.allocations?.length && !can(user!, ['customer_lettering'])) throw new AppError("Vous n'avez pas le droit de lettrer un règlement", 'FORBIDDEN');
      // Encaissé à la caisse : rattaché à la session ouverte, les espèces vont dans le tiroir.
      const session = input.atRegister && c.registerId ? s.pos.currentSession(c.registerId) : null;
      if (input.atRegister && !session) throw new AppError("Ouvrez la caisse avant d'encaisser un règlement client", 'NO_SESSION');
      // Mobile Money et carte vont à la caisse électronique du caissier, virement et chèque à sa caisse banque.
      return s.customers.receivePayment(c, { ...input, sessionId: session ? s.pos.sessionFor(c, input.method, session.id) : null });
    },
    'customers.payments': (opts?: { customerId?: string; limit?: number }) => s.customers.listPayments(ctx().storeId, opts),
    'customers.receivables': () => s.customers.receivables(ctx(SALES).storeId),
    'customers.allocations': (paymentId: string) => (requireUser(['customer_payment', 'customer_lettering', 'receivables']), s.customers.allocations(paymentId)),
    'customers.setAllocations': (paymentId: string, allocations: { saleId: string; amount: Fcfa }[]) => s.customers.setAllocations(ctx(['customer_lettering']), paymentId, allocations),
    // --- Compensation client / fournisseur ----------------------------------------
    'offsets.candidates': (customerId: string) => s.offsets.candidates(ctx(['account_offsets']).storeId, customerId),
    'offsets.create': (input: { customerId: string; invoiceId: string; amount: Fcfa; date?: string | null; notes?: string | null }) => s.offsets.create(ctx(['account_offsets']), input),
    'offsets.cancel': (id: string, reason: string) => s.offsets.cancel(ctx(['account_offsets']), id, reason),
    'offsets.list': (customerId?: string | null) => s.offsets.list(ctx(['account_offsets', 'receivables']).storeId, { customerId }),
    // --- Dépôt-vente chez les revendeurs ------------------------------------------
    'consignment.depots': () => s.consignment.depots(ctx(['consignment']).storeId),
    'consignment.open': (customerId: string) => s.consignment.openDepot(ctx(['consignment']), customerId),
    'consignment.stock': (warehouseId: string) => (ctx(['consignment']), s.consignment.stockAt(warehouseId)),
    'consignment.send': (input: { warehouseId: string; fromWarehouseId: string; lines: { articleId: string; qty: Milli }[] }) => s.consignment.send(ctx(['consignment']), input),
    'consignment.count': (input: { warehouseId: string; lines: { articleId: string; counted: Milli }[]; takeBack?: { toWarehouseId: string } | null; notes?: string | null }) =>
      s.consignment.count(ctx(['consignment']), input),
    'consignment.history': (warehouseId?: string | null) => s.consignment.history(ctx(['consignment']).storeId, warehouseId),
    'consignment.get': (id: string) => (ctx(['consignment']), s.consignment.get(id)),
    'summaryInvoices.candidates': (customerId: string, from: string, to: string) => s.summaryInvoices.candidates(ctx(['summary_invoices']).storeId, customerId, from, to),
    'summaryInvoices.create': (input: { customerId: string; from: string; to: string; saleIds?: string[] }) => s.summaryInvoices.create(ctx(['summary_invoices']), input),
    'summaryInvoices.cancel': (id: string) => s.summaryInvoices.cancel(ctx(['summary_invoices']), id),
    'summaryInvoices.list': (customerId?: string | null) => s.summaryInvoices.list(ctx(['summary_invoices']).storeId, { customerId }),
    'summaryInvoices.get': (id: string) => (ctx(['summary_invoices']), s.summaryInvoices.get(id)),
    'summaryInvoices.print': (id: string) => (ctx(['summary_invoices']), printer.summaryInvoice(id)),
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
    'orders.list': (opts?: { status?: OrderStatus | 'open'; search?: string; date?: string }) => s.orders.list(ctx(['customer_orders', ...POS]).storeId, opts),
    'orders.get': (id: string) => (requireUser(), s.orders.get(id)),
    'orders.save': (input: OrderInput, id?: string | null) => s.orders.save(ctx(['customer_orders']), input, id ?? undefined),
    /** Commandes de la boutique en ligne qui attendent d'être prises par un PC du magasin. */
    'orders.webOrders': async () => {
      ctx(['customer_orders']);
      if (s.fiches.current() || !s.sync.credentials()) return [];
      return webOrders(s).catch(() => []);
    },
    /** Prend la commande en ligne (un seul PC l'obtient) : elle devient une commande client « Boutique en ligne ». */
    'orders.takeWeb': async (id: string) => {
      const c = ctx(['customer_orders']);
      const w = await takeWebOrder(s, id);
      return s.orders.importWeb(c, {
        ref: w.id,
        customerName: w.customerName,
        phone: w.phone,
        address: w.address,
        slot: w.slot,
        note: [`Boutique en ligne ${w.number}`, w.note].filter(Boolean).join(' · '),
        deliveryFee: w.deliveryFee,
        lines: w.lines.map((l) => ({ articleId: l.articleId, qty: l.qty, name: l.name })),
      });
    },
    'orders.prepare': (id: string) => s.orders.prepare(ctx(['customer_orders']), id),
    'orders.backOrderNeeds': (id: string) => s.purchases.backOrderNeeds(ctx(['back_orders']).storeId, id),
    'orders.backOrder': (id: string, opts?: { supplierId?: string | null; warehouseId?: string | null }) => s.purchases.backOrder(ctx(['back_orders']), id, opts),
    'orders.unprepare': (id: string) => s.orders.unprepare(ctx(['customer_orders']), id),
    'orders.cancel': (id: string, reason: string) => s.orders.cancel(ctx(['customer_order_cancel']), id, reason),
    'orders.saleLines': (id: string) => s.orders.saleLines(ctx(POS).storeId, id),
    'orders.reserved': () => Object.fromEntries(s.orders.reserved(ctx().storeId)),
    'orders.confirmation': (id: string) => {
      const c = ctx(['customer_orders']);
      return s.orders.confirmationText(id, s.admin.getStore(c.storeId).name);
    },

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
    /** Contrôle avant clôture : ce qui bloque, ce qui mérite d'être vu (stock compris). */
    'fiscal.checkClose': (id: string) => {
      const c = ctx(['fiscal_years']);
      const checks = s.fiscal.checkClose(c.storeId, id);
      for (const r of s.repair.check().checks.filter((x) => x.key === 'stock' || x.key === 'lots')) {
        checks.push({ key: r.key, label: r.label, status: r.status === 'problem' ? 'warning' : 'ok', detail: r.status === 'problem' ? `${r.detail} (Administration › Réparation)` : r.detail });
      }
      return checks;
    },
    'fiscal.close': (id: string) => s.fiscal.close(ctx(['fiscal_years']), id),
    'fiscal.reopen': (id: string) => s.fiscal.reopen(ctx(['fiscal_years']), id),
    'fiscal.remove': (id: string) => s.fiscal.remove(ctx(['fiscal_years']), id),
    'accounting.ledger': (opts: { account: string; aux?: string; from?: string; to?: string }) => s.accounting.ledger(ctx(ACCOUNTING).storeId, opts),
    'accounting.trialBalance': (opts: { from?: string; to?: string }) => s.accounting.trialBalance(ctx(ACCOUNTING).storeId, opts),
    'accounting.treasury': (to?: string) => s.accounting.treasury(ctx(ACCOUNTING).storeId, to),
    'accounting.vatReturn': (month: string) => s.accounting.vatReturn(ctx(['vat_return']).storeId, month),
    'accounting.exportCsv': (opts: { from?: string; to?: string }) => s.accounting.exportCsv(ctx(['accounting_export']).storeId, opts),
    /** Écritures dans le format du logiciel du cabinet. */
    'accounting.exportFormatted': (opts: { from?: string; to?: string }, formatId: string) => {
      const storeId = ctx(['accounting_export']).storeId;
      const f = allFormats().find((x) => x.id === formatId);
      if (!f || f.kind !== 'ecritures') throw new AppError("Format d'export introuvable", 'NOT_FOUND');
      const lines = s.accounting.entries(storeId, opts).flatMap((e) =>
        e.lines.map((l) => ({ journal: e.journal, date: e.date, piece: e.ref, account: l.account, aux: l.aux, label: l.label, debit: l.debit, credit: l.credit })),
      );
      return formatEntries(lines, f);
    },
    'tax.assessment': (year: number) => s.tax.assessment(ctx(['tax', 'tax_settings']).storeId, year),
    'tax.instalment': (month: string) => s.tax.instalment(ctx(['tax', 'tax_settings']).storeId, month),
    'tax.saveSettings': (year: number, input: Parameters<typeof s.tax.saveSettings>[2]) => s.tax.saveSettings(ctx(['tax_settings']), year, input),
    'tax.book': (year: number) => s.tax.book(ctx(['tax_settings']), year),
    'tax.print': (year: number) => printer.taxAssessment(ctx(['tax', 'tax_settings']).storeId, year),
    'accounting.printVat': (month: string) => printer.vatReturn(ctx(['vat_return']).storeId, month),
    'patrimony.series': (scope?: { companyId?: string | null; allStores?: boolean }, months?: number) => {
      const c = ctx(['patrimony']);
      if ((scope?.companyId || scope?.allStores) && !can(user!, ['companies'])) throw new AppError("Vous n'avez pas le droit de voir les chiffres des autres magasins", 'FORBIDDEN');
      return s.companies.patrimony(scope?.companyId ? { companyId: scope.companyId } : scope?.allStores ? {} : { storeId: c.storeId }, months);
    },
    'companies.list': (includeInactive?: boolean) => (requireUser(['companies', 'patrimony']), s.companies.list(includeInactive)),
    'companies.save': (input: CompanyInput, id?: string) => s.companies.save(requireUser(['companies']).id, input, id),
    'companies.assignStore': (storeId: string, companyId: string | null) => s.companies.assignStore(requireUser(['companies']).id, storeId, companyId),
    'companies.consolidated': (companyId: string, date?: string | null) => (requireUser(['companies']), s.companies.consolidated(companyId, date)),
    'planning.forecast': (opts?: { weeks?: number; estimates?: boolean }) => s.planning.forecast(ctx(['cash_forecast']).storeId, opts),
    'planning.budgetReport': (year: number, month: number) => s.planning.budgetReport(ctx(['budgets']).storeId, year, month),
    'planning.saveBudget': (input: { year: number; account: string; months: number[] }) => s.planning.saveBudget(ctx(['budgets']), input),
    'planning.analyticByDepartment': (from: string, to: string) => s.planning.analyticByDepartment(ctx(['analytics']).storeId, from, to),
    'planning.analyticByStore': (from: string, to: string) => (ctx(['analytics']), s.planning.analyticByStore(from, to)),
    'cheques.pending': () => s.cheques.pending(ctx(['cheque_deposits']).storeId),
    'cheques.list': () => s.cheques.list(ctx(['cheque_deposits']).storeId),
    'cheques.get': (id: string) => (ctx(['cheque_deposits']), s.cheques.get(id)),
    'cheques.create': (input: { date: string; bank?: string | null; paymentIds?: string[] }) => s.cheques.create(ctx(['cheque_deposits']), input),
    'cheques.cancel': (id: string) => s.cheques.cancel(ctx(['cheque_deposits']), id),
    'cheques.print': (id: string) => (ctx(['cheque_deposits']), printer.chequeDeposit(id)),
    'cheques.received': (since?: string | null) => s.cheques.received(ctx(['cheque_rejections']).storeId, { since }),
    'cheques.reject': (input: Parameters<Services['cheques']['reject']>[1]) => s.cheques.reject(ctx(['cheque_rejections']), input),
    'cheques.cancelRejection': (id: string) => s.cheques.cancelRejection(ctx(['cheque_rejections']), id),
    'cheques.rejections': () => s.cheques.rejections(ctx(['cheque_rejections']).storeId),

    // --- Emballages consignés --------------------------------------------------
    'containers.types': (includeInactive?: boolean) => (requireUser(), s.containers.listTypes({ includeInactive })),
    'containers.saveType': (input: { name: string; deposit: Fcfa; active?: boolean }, id?: string | null) => s.containers.saveType(requireUser(['containers']).id, input, id ?? undefined),
    'containers.setArticle': (articleId: string, containerId: string | null, units?: Milli) => s.containers.setArticleContainer(requireUser(['containers', 'article_edit']).id, articleId, containerId, units),
    'containers.needsFor': (lines: { articleId: string; qty: Milli }[]) => (requireUser(), s.containers.needsFor(lines)),
    /** Consigne d'un passage en caisse : emballages sortis et vides rapportés, payés en espèces. */
    'containers.counter': (input: Parameters<Services['containers']['counter']>[1]) => s.containers.counter(ctx(['containers_counter', 'containers']), input),
    'containers.record': (input: Parameters<Services['containers']['record']>[1]) => s.containers.record(ctx(['containers']), input),
    'containers.cancel': (id: string, reason: string) => s.containers.cancel(ctx(['containers']), id, reason),
    'containers.moves': (opts?: Parameters<Services['containers']['moves']>[1]) => s.containers.moves(ctx(['containers', 'containers_counter']).storeId, opts),
    'containers.balances': () => s.containers.balances(ctx(['containers']).storeId),
    'containers.atCustomers': () => s.containers.atCustomers(ctx(['containers', 'containers_counter']).storeId),
    'containers.owedToSuppliers': () => s.containers.owedToSuppliers(ctx(['containers']).storeId),

    // --- Point Mobile Money ----------------------------------------------------
    'agent.accounts': (includeInactive?: boolean) => s.agent.accounts(ctx(['agent_point', 'agent_accounts']).storeId, { includeInactive }),
    'agent.saveAccount': (input: Parameters<Services['agent']['saveAccount']>[1], id?: string | null) => s.agent.saveAccount(ctx(['agent_accounts']), input, id ?? undefined),
    'agent.commissionFor': (accountId: string, kind: AgentKind, amount: Fcfa) => (requireUser(['agent_point']), s.agent.commissionFor(accountId, kind, amount)),
    'agent.record': (input: AgentInput) => {
      // L'approvisionnement de la flotte et la commission se règlent au bureau.
      const need: Permission[] = input.kind === 'float_in' || input.kind === 'float_out' || input.kind === 'commission' ? ['agent_accounts'] : ['agent_point'];
      return s.agent.record(ctx(need), input);
    },
    'agent.cancel': (id: string, reason: string) => s.agent.cancel(ctx(['agent_cancel']), id, reason),
    /** Reçu d'une opération : une pièce de caisse par mouvement d'espèces (montant, frais). */
    'agent.print': async (id: string) => {
      const c = ctx(['agent_point', 'agent_accounts']);
      const op = s.agent.get(id);
      if (op.store_id !== c.storeId) throw new AppError("Cette opération est d'un autre magasin", 'FORBIDDEN');
      const ids = JSON.parse((s.db.prepare('SELECT entry_ids FROM agent_operations WHERE id = ?').pluck().get(id) as string | undefined) ?? '[]') as string[];
      if (!ids.length) throw new AppError("Cette opération n'a pas de reçu : elle ne passe pas par la caisse", 'INVALID');
      for (const e of ids) await printer.officeVoucher(e);
    },
    'agent.list': (opts?: Parameters<Services['agent']['list']>[1]) => s.agent.list(ctx(['agent_point', 'agent_accounts']).storeId, opts),
    'agent.summary': (from: string, to: string) => s.agent.summary(ctx(['agent_accounts']).storeId, from, to),

    // --- Contrôle des caissiers ------------------------------------------------
    'cashierControl.report': (from: string, to: string) => s.cashierControl.report(ctx(['cashier_control']).storeId, from, to),
    'cashierControl.events': (userId: string, from: string, to: string) => s.cashierControl.events(ctx(['cashier_control']).storeId, userId, from, to),

    // --- Congés et planning ----------------------------------------------------
    'staffTime.leaves': (opts?: { staffId?: string | null; year?: number | null }) => s.staffTime.leaves(ctx(['staff_leaves']).storeId, opts),
    'staffTime.requestLeave': (input: Parameters<Services['staffTime']['requestLeave']>[1]) => s.staffTime.requestLeave(ctx(['staff_leaves']), input),
    'staffTime.decideLeave': (id: string, decision: 'approved' | 'refused' | 'cancelled') => s.staffTime.decideLeave(ctx(['staff_leaves']), id, decision),
    'staffTime.balances': (year?: number) => s.staffTime.balances(ctx(['staff_leaves']).storeId, year),
    'staffTime.week': (monday: string) => s.staffTime.week(ctx(['staff_leaves']).storeId, monday),
    'staffTime.schedule': (staffId: string) => (requireUser(['staff_leaves']), s.staffTime.schedule(staffId)),
    'staffTime.saveSchedule': (staffId: string, days: WeekSchedule | null) => s.staffTime.saveSchedule(ctx(['staff_leaves']), staffId, days),

    // --- Déstockage, démarque et inventaire tournant ---------------------------
    'clearance.candidates': () => s.clearance.candidates(ctx(['clearance']).storeId),
    'clearance.createPromotions': (items: { articleId: string; promoPrice: Fcfa; until?: string | null }[]) => {
      const c = ctx(['clearance']);
      return s.clearance.createPromotions(c.userId, c.storeId, items);
    },
    'clearance.losses': (from: string, to: string) => s.clearance.losses(ctx(['clearance']).storeId, from, to),
    'clearance.lossLabels': () => (requireUser(), ClearanceService.lossLabels()),
    'cycleCount.proposal': (warehouseId: string, size?: number) => s.cycleCount.proposal(ctx(['cycle_count']).storeId, warehouseId, { size }),
    'cycleCount.start': (warehouseId: string, articleIds: string[]) => s.cycleCount.start(ctx(['cycle_count']), warehouseId, articleIds),

    // --- Commandes groupées ----------------------------------------------------
    'purchases.createGroupOrder': (input: Parameters<Services['purchases']['createGroupOrder']>[1]) => s.purchases.createGroupOrder(ctx(['group_orders']), input),
    'purchases.groupOrders': () => (requireUser(['group_orders']), s.purchases.groupOrders()),
    'purchases.groupOrder': (ref: string) => (requireUser(['group_orders']), s.purchases.groupOrder(ref)),
    /** Stock et ventes des 28 derniers jours d'un article dans chaque magasin, pour répartir une commande groupée. */
    'purchases.groupNeeds': (articleIds: string[]) => {
      requireUser(['group_orders']);
      const stores = s.admin.listStores();
      const stock = s.db.prepare('SELECT COALESCE(SUM(s.qty), 0) FROM stock s JOIN warehouses w ON w.id = s.warehouse_id WHERE s.article_id = ? AND w.store_id = ?').pluck();
      const since = new Date(Date.now() - 28 * 86_400_000).toISOString();
      const sold = s.db
        .prepare("SELECT COALESCE(-SUM(m.qty), 0) FROM stock_movements m JOIN warehouses w ON w.id = m.warehouse_id WHERE m.article_id = ? AND w.store_id = ? AND m.type IN ('SALE', 'RETURN') AND m.at >= ?")
        .pluck();
      return stores.map((st) => ({
        storeId: st.id,
        storeName: st.name,
        articles: Object.fromEntries(articleIds.map((a) => [a, { stock: stock.get(a, st.id) as number, sold28: sold.get(a, st.id, since) as number }])),
      }));
    },

    // --- Tournées des livreurs ---------------------------------------------------
    'couriers.sheet': (courier: string, date: string) => s.couriers.sheet(ctx(['deliveries']).storeId, courier, date),
    'couriers.printSheet': (courier: string, date: string) => printer.courierSheet(ctx(['deliveries']).storeId, courier, date),
    'couriers.pending': (courier?: string | null) => s.couriers.pending(ctx(['courier_returns']).storeId, courier),
    'couriers.settle': (input: Parameters<Services['couriers']['settle']>[1]) => s.couriers.settle(ctx(['courier_returns']), input),
    'couriers.returns': (opts?: { from?: string; to?: string }) => s.couriers.list(ctx(['courier_returns']).storeId, opts),
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
    // --- Sauvegarde en ligne (chiffrée sur ce PC, gardée par le serveur) ---------
    'backup.cloudStatus': () => (requireUser(['backups']), cloud.status()),
    'backup.cloudSetKey': (passphrase: string) => (requireAdmin(), cloud.setKey(passphrase)),
    'backup.cloudNow': () => cloud.now(requireUser(['backups']).id),
    'backup.cloudList': () => (requireUser(['backups']), cloud.list()),
    'backup.cloudDownload': (id: string, passphrase: string) => (requireAdmin(), cloud.download(id, passphrase)),
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
    // --- Registres et contrôles ------------------------------------
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
        ['cash_alerts', can(u, ['treasury', 'cash_z'])],
        ['to_notify', can(u, ['missed_report', 'missed_sale'])],
        ['store_requests', can(u, ['store_transfers'])],
      ];
      return s.attention.list(c.storeId, new Set(rules.filter(([, ok]) => ok).map(([k]) => k)));
    },
    // --- 0.81.0 : le magasin au quotidien -------------------------------------------
    /** « Le client voulait… » : produit absent, en rupture ou trop cher. */
    'missed.record': (input: MissedSaleInput) => s.missedSales.record(ctx(['missed_sale', 'missed_report']), { ...input, source: 'pc' }),
    'missed.remove': (id: string) => {
      const c = ctx(['missed_sale', 'missed_report']);
      return s.missedSales.remove(c, id, can(requireUser(), ['missed_report']));
    },
    'missed.list': (opts?: { from?: string | null; to?: string | null }) => s.missedSales.list(ctx(['missed_report']).storeId, opts),
    'missed.top': (days?: number) => s.missedSales.top(ctx(['missed_report']).storeId, days),
    /** Mes demandes notées aujourd'hui (pour retirer une erreur). */
    'missed.mine': () => {
      const c = ctx(['missed_sale']);
      return s.missedSales.list(c.storeId, { from: new Date(Date.now() - 86_400_000).toISOString() }).filter((m) => m.user_name === requireUser().name).slice(0, 20);
    },
    /** Clients qui ont laissé leur numéro : le produit qu'ils voulaient est arrivé (message WhatsApp prêt). */
    'missed.toNotify': () => {
      const c = ctx(['missed_sale', 'missed_report']);
      const store = s.admin.getStore(c.storeId).name;
      return s.missedSales.toNotify(c.storeId).map((m) => ({
        ...m,
        whatsapp: whatsappLink(m.phone, arrivalMessage({ store, customer: m.customer_name, product: m.label, price: m.price })),
      }));
    },
    'missed.markNotified': (id: string) => s.missedSales.markNotified(ctx(['missed_sale', 'missed_report']), id),

    // --- 0.87.0 -----------------------------------------------------------------------
    /** Bon d'achat vendu en caisse (Encaisser) : l'argent entre dans la journée, le bon s'imprime. */
    'vouchers.sell': async (sessionId: string, input: { amount: Fcfa; method: string; reference?: string | null; holder?: string | null; customerId?: string | null }) => {
      requireUser(['voucher_sell']);
      const v = s.cashdesk.sellVoucher(deskCtx(sessionId), sessionId, { ...input, validityDays: settings().voucherValidityDays });
      await printer.giftVoucher(v.id).catch(() => undefined);
      return v;
    },
    'vouchers.print': (id: string) => (requireUser(['voucher_sell', 'vouchers', ...POS]), printer.giftVoucher(id)),
    /** Code tapé ou scanné en caisse : le bon, son solde et ce qui l'empêche de servir. */
    'vouchers.lookup': (code: string) => s.vouchers.lookup(ctx().storeId, code),
    'vouchers.list': (opts?: { state?: 'valid' | 'spent' | 'expired' | 'void' | null; search?: string | null }) => {
      const c = ctx(['vouchers']);
      return { vouchers: s.vouchers.list(c.storeId, opts), outstanding: s.vouchers.outstanding(c.storeId) };
    },
    'vouchers.uses': (code: string) => (requireUser(['vouchers']), s.vouchers.uses(code)),
    'vouchers.cancel': (id: string, reason: string) => s.cashdesk.cancelVoucher(ctx(['vouchers']), id, requireUser().id, reason),
    /** Espèces du tiroir et plafond : l'alerte part au gérant quand le plafond est franchi. */
    'pos.drawerStatus': () => {
      const c = ctx();
      return c.registerId ? s.pos.drawerStatus(c) : null;
    },
    'pos.cashAlerts': (days?: number) => s.pos.cashAlerts(ctx(['treasury', 'cash_z']).storeId, days),
    'pos.bookSales': (opts?: { from?: string | null; to?: string | null }) => s.pos.bookSales(ctx(['sales', 'sale_book']).storeId, opts),
    /** Contrôle à la sortie : le vigile scanne le ticket. */
    'exit.lookup': (code: string) => s.exitChecks.lookup(ctx(['exit_check']).storeId, code),
    'exit.record': (saleId: string, input: { status: 'ok' | 'problem'; note?: string | null }) => s.exitChecks.record(ctx(['exit_check']), saleId, { ...input, source: 'pc' }),
    'exit.list': (opts?: { from?: string | null; to?: string | null; problems?: boolean }) => s.exitChecks.list(ctx(['exit_report']).storeId, opts),
    'exit.coverage': (day: string) => s.exitChecks.coverage(ctx(['exit_report']).storeId, day),
    /** Rappels de lots : bloqués à la caisse, clients qui ont acheté, retour au fournisseur. */
    'recalls.list': (opts?: { open?: boolean }) => s.recalls.list(ctx(['lot_recall']).storeId, opts),
    'recalls.detail': (id: string) => (requireUser(['lot_recall']), s.recalls.detail(id)),
    'recalls.create': (input: { articleId: string; lotNumber?: string | null; expiry?: string | null; reason: string; note?: string | null }) => s.recalls.create(ctx(['lot_recall']), input),
    'recalls.returnToSupplier': (id: string, input: { supplierId: string; warehouseId: string }) => s.recalls.returnToSupplier(ctx(['lot_recall']), id, input),
    'recalls.close': (id: string, note?: string | null) => s.recalls.close(ctx(['lot_recall']), id, note),
    'recalls.buyersMessage': (id: string) => {
      const c = ctx(['lot_recall']);
      const d = s.recalls.detail(id);
      const store = s.admin.getStore(c.storeId);
      const text = (name: string) =>
        `Bonjour ${name}, ici ${store.name}. Le produit ${d.recall.article_name}${d.recall.lot_number ? ` (lot ${d.recall.lot_number})` : ''} que vous avez acheté chez nous fait l'objet d'un rappel : merci de ne pas le consommer et de nous le rapporter, il vous sera remboursé ou échangé.${store.phone ? ` Renseignements : ${store.phone}.` : ''}`;
      return d.buyers.map((b) => ({ ...b, whatsapp: whatsappLink(b.phone, text(b.name)) }));
    },
    /** Prix programmés : préparés à l'avance, appliqués seuls à leur date. */
    'priceSchedules.list': () => (requireUser(['price_schedule', 'price_update']), s.priceSchedules.list()),
    'priceSchedules.get': (id: string) => (requireUser(['price_schedule', 'price_update']), s.priceSchedules.get(id)),
    'priceSchedules.create': (input: PriceScheduleInput) => s.priceSchedules.create(ctx(['price_schedule']), input),
    'priceSchedules.cancel': (id: string) => s.priceSchedules.cancel(ctx(['price_schedule']), id),
    'priceSchedules.tomorrow': () => {
      const c = ctx(STOCK);
      const r = s.priceSchedules.pricesOn(c.storeId);
      return { day: r.day, count: r.prices.size, schedules: r.schedules };
    },
    'priceSchedules.labelsPreview': (format: LabelFormatId, day?: string) => labelsHtml(s.priceSchedules.labelsFor(ctx(STOCK).storeId, day), format),
    'priceSchedules.labelsPrint': (format: LabelFormatId, day?: string) => printer.labels(labelsHtml(s.priceSchedules.labelsFor(ctx(STOCK).storeId, day), format), format),
    'articles.setNetContent': (id: string, text: string | null) => s.catalogue.setNetContent(requireUser(['article_edit']).id, id, text),
    /** Affichettes promo A4 ou A5 des promotions choisies. */
    'promotions.postersPreview': (ids: string[], size: PosterSize) => {
      const c = ctx(['promotions', 'promotion_save', 'labels']);
      return promoPostersHtml(s.promotions.posters(c.storeId, ids, s.admin.getStore(c.storeId).name), size);
    },
    'promotions.postersPrint': (ids: string[], size: PosterSize) => {
      const c = ctx(['promotions', 'promotion_save', 'labels']);
      const posters = s.promotions.posters(c.storeId, ids, s.admin.getStore(c.storeId).name);
      if (!posters.length) throw new AppError('Choisissez une promotion en cours ou à venir', 'INVALID');
      return printer.posters(promoPostersHtml(posters, size), size);
    },
    /** Commandes répétées des clients pros. */
    'recurring.list': () => s.recurringOrders.list(ctx(['recurring_orders']).storeId),
    'recurring.save': (input: RecurringOrderInput, id?: string | null) => s.recurringOrders.save(ctx(['recurring_orders']), input, id ?? undefined),
    'recurring.setActive': (id: string, active: boolean) => s.recurringOrders.setActive(ctx(['recurring_orders']), id, active),
    'recurring.generate': () => s.recurringOrders.generate(ctx(['recurring_orders'])).length,
    /** Marchandise demandée à un autre magasin avant d'acheter au fournisseur. */
    'storeTransfers.list': (opts?: { open?: boolean }) => s.storeTransfers.list(ctx(['store_transfers']).storeId, opts),
    'storeTransfers.suggestions': () => s.storeTransfers.suggestions(ctx(['store_transfers', 'reorder']).storeId),
    'storeTransfers.pending': () => s.storeTransfers.pending(ctx(['store_transfers']).storeId),
    'storeTransfers.request': (input: { fromStoreId: string; articleId: string; qty: Milli; note?: string | null }) => s.storeTransfers.request(ctx(['store_transfers']), input),
    'storeTransfers.ship': (id: string, input?: { qty?: Milli; warehouseId?: string | null }) => s.storeTransfers.ship(ctx(['store_transfers']), id, input),
    'storeTransfers.refuse': (id: string, answer: string) => s.storeTransfers.refuse(ctx(['store_transfers']), id, answer),
    'storeTransfers.cancel': (id: string) => s.storeTransfers.cancel(ctx(['store_transfers']), id),
    'storeTransfers.receive': (id: string, input?: { qty?: Milli; warehouseId?: string | null }) => s.storeTransfers.receive(ctx(['store_transfers']), id, input),
    'restock.list': () => s.floor.restockList(ctx(['restock']).storeId),
    'restock.apply': (lines: { articleId: string; fromWarehouseId: string; qty: Milli }[]) => s.floor.restock(ctx(['restock']), lines),
    'restock.setShelfQty': (articleId: string, qty: Milli | null) => s.floor.setShelfQty(ctx(['restock', 'article_edit']), articleId, qty),
    'tasks.today': () => {
      const u = requireUser(['day_tasks']);
      return s.floor.dayTasks(ctx().storeId, (r) => can(u, [r as Permission]));
    },
    'tasks.check': (key: string, done: boolean) => s.floor.checkTask(ctx(['day_tasks']), key, done),
    /** Avant de clôturer : ce qui reste ouvert sur la caisse (tickets en attente, MoMo, livraisons, paniers du rayon). */
    'treasury.beforeClose': async (registerId?: string) => {
      const c = ctx(TREASURY);
      const items = s.floor.beforeClose(c.storeId, registerId ?? c.registerId ?? '');
      const carts = await shelfCarts(s).catch(() => []);
      if (carts.length)
        items.push({ key: 'carts', label: 'Paniers préparés au rayon, pas encore encaissés', count: carts.length, detail: carts.map((x) => `Panier ${x.number} de ${x.sellerName}`), open: ['cash1'] });
      return items;
    },
    'suppliers.calendar': () => s.purchases.visitCalendar(ctx(['supplier_calendar', 'reorder']).storeId),
    'suppliers.setVisitDays': (id: string, days: number[]) => s.purchases.setVisitDays(requireUser(['supplier_calendar', 'supplier_edit']).id, id, days),
    'prices.review': () => s.insights.priceReview(ctx(['price_review']).storeId),
    'prices.applyReview': (articleId: string, price: Fcfa) => {
      const c = ctx(['price_review']);
      requireUser(['article_price']);
      return s.insights.applyPriceReview(c.userId, c.storeId, articleId, price);
    },
    'team.week': (from: string, to: string) => s.insights.team(ctx(['team_board']).storeId, from, to),
    'owner.report': (month: string) => s.insights.ownerReport(ctx(['owner_report']).storeId, month),
    /** Rapport mensuel en PDF (une page A4) : la fenêtre « Enregistrer sous » s'ouvre. */
    'owner.reportPdf': async (month: string) => {
      const c = ctx(['owner_report']);
      return printer.ownerReport(c.storeId, s.insights.ownerReport(c.storeId, month), month);
    },
    /** État de ce PC : synchronisation, version, sauvegarde, imprimante, licence. */
    'stations.self': () => (requireUser(['stations']), stationStatus()),
    /** État de tous les PC du magasin, d'après le serveur (ce PC seul s'il n'est pas relié). */
    'stations.all': async () => {
      requireUser(['stations']);
      const self = stationStatus();
      if (!s.sync.credentials()) return { linked: false, devices: [{ deviceId: 'self', name: self.name, lastSeenAt: self.at, appVersion: self.version, status: self, self: true }] };
      await pushStationStatus(s, self).catch(() => undefined);
      return { linked: true, devices: await stationStatuses(s) };
    },
    /** Réceptions faites sur le téléphone, qui attendent la validation d'un PC. */
    'purchases.mobileReceptions': async () => (requireUser(['order_receive']), mobileReceptions(s).catch(() => [])),
    'purchases.takeMobileReception': (id: string) => (requireUser(['order_receive']), takeMobileReception(s, id)),
    /** Brouillons de saisie gardés sur ce PC (coupure de courant, fermeture). */
    'drafts.save': (key: string, label: string, data: unknown) => s.admin.saveDraft(requireUser().id, key, label, data),
    'drafts.get': (key: string) => s.admin.draft(requireUser().id, key),
    'drafts.list': () => s.admin.drafts(requireUser().id),
    'drafts.clear': (key: string) => s.admin.clearDraft(requireUser().id, key),
    /** Liste imprimée ou en PDF depuis n'importe quel écran (tableau tel qu'affiché). */
    'list.print': (title: string, tableHtml: string) => (requireUser(), printer.listing(ctx().storeId, title, tableHtml, 'print')),
    'list.pdf': (title: string, tableHtml: string) => (requireUser(), printer.listing(ctx().storeId, title, tableHtml, 'pdf')),
    'list.xlsx': (title: string, columns: { header: string; format?: 'text' | 'int' | 'money' | 'qty' | 'pct' }[], rows: (string | number | null)[][]) => {
      requireUser();
      return xlsxWorkbook([{ name: title.slice(0, 31).replace(/[\\/?*[\]:]/g, ' '), title: [title, `Édité le ${new Date().toLocaleString('fr-FR')}`], columns: columns.map((c) => ({ ...c, width: Math.min(50, Math.max(10, c.header.length + 4)) })), rows }]);
    },
    'reports.sales': (input: SalesReportInput) => s.reports.sales(ctx(['reports', 'sales']).storeId, input),
    'reports.unsold': (from: string, to: string) => s.reports.unsold(ctx(['reports', 'sales']).storeId, from, to),
    /** Classeur .xlsx : octets envoyés tels quels à l'écran, qui propose l'enregistrement. */
    'reports.salesXlsx': (input: SalesReportInput) => xlsxWorkbook(s.reports.salesWorkbook(ctx(['report_export']).storeId, input)),
    'reports.salesCsv': (from: string, to: string) => s.reports.salesExportCsv(ctx(['accounting_export', 'report_export']).storeId, from, to),
  };
}

export type Api = ReturnType<typeof createApi>;
export type ApiName = keyof Api;
