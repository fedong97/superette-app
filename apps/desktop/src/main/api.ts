import {
  type DenominationCount,
  type LabelFormatId,
  labelsHtml,
  type Fcfa,
  type Milli,
  type MovementType,
  type Payment,
  type PaymentMethod,
  type PriceLevel,
  type StatementLine,
  type StockLevel,
} from '@superette/core';
import {
  AppError,
  COMMITMENT_KINDS,
  SECURITY_KINDS,
  inspectBackup,
  STAFF_CATEGORIES,
  type ArticleInput,
  type BootstrapInput,
  type Context,
  type CustomerInput,
  type CustomerPaymentMethod,
  type DisclosuresInput,
  type ExpenseInput,
  type QuoteInput,
  type QuoteState,
  type AccountRole,
  type JournalCode,
  type LabelItem,
  type ReceptionLine,
  type Role,
  type SaleLineInput,
  type Services,
  type PromotionInput,
  type PurchaseOrderLineInput,
  type SupplierInput,
  type SupplierPaymentMethod,
  type User,
} from '@superette/db';

import type { SyncRunner } from './sync';

/** Actions du poste qui passent par Windows (fenêtres de choix, redémarrage). */
export interface SystemHooks {
  chooseFolder(title: string): Promise<string | null>;
  chooseBackupFile(): Promise<string | null>;
  openFolder(path: string): Promise<void>;
  /** Ferme la base, la remplace par la sauvegarde et relance l'application. */
  restore(file: string, userId: string): void;
}

export interface Printer {
  /** `newSale` : ticket d'une vente qui vient d'être encaissée (ouvre le tiroir selon les réglages). */
  ticket(saleId: string, opts?: { newSale?: boolean }): Promise<void>;
  zReport(sessionId: string): Promise<void>;
  openDrawer(): Promise<void>;
  testPage(withDrawer: boolean): Promise<void>;
  purchaseOrder(orderId: string): Promise<void>;
  invoice(saleId: string): Promise<void>;
  statement(storeId: string, customerId: string, from?: string | null, to?: string | null): Promise<void>;
  customerReceipt(paymentId: string): Promise<void>;
  vatReturn(storeId: string, month: string): Promise<void>;
  trialBalance(storeId: string, from?: string | null, to?: string | null): Promise<void>;
  statements(storeId: string, from: string, to: string): Promise<void>;
  reconciliation(storeId: string, accountId: string, date: string, statementBalance: number | null): Promise<void>;
  taxAssessment(storeId: string, year: number): Promise<void>;
  notes(storeId: string, year: number): Promise<void>;
  expenseVoucher(expenseId: string): Promise<void>;
  quote(quoteId: string): Promise<void>;
  journal(storeId: string, from?: string | null, to?: string | null, journal?: JournalCode | null): Promise<void>;
  list(): Promise<{ name: string; isDefault: boolean }[]>;
  /** Planche d'étiquettes déjà mise en page ; false si l'utilisateur annule. */
  labels(html: string, format: LabelFormatId): Promise<boolean>;
  countSheet(storeId: string, warehouseId: string, departmentId?: string | null): Promise<void>;
}

/**
 * API exposée à l'interface. L'utilisateur connecté et le poste (magasin,
 * caisse) sont tenus ici, côté processus principal : l'écran ne peut pas
 * se faire passer pour un autre utilisateur ni valider à la place d'un gérant.
 */
export function createApi(s: Services, printer: Printer, sync: SyncRunner, appVersion: string, system: SystemHooks) {
  let user: User | null = null;

  const requireUser = (roles?: Role[]): User => {
    if (!user) throw new AppError('Session expirée, reconnectez-vous', 'NOT_LOGGED_IN');
    if (roles && !roles.includes(user.role)) throw new AppError("Vous n'avez pas les droits pour cette action", 'FORBIDDEN');
    return user;
  };
  const ctx = (roles?: Role[]): Context => {
    const u = requireUser(roles);
    const station = s.admin.station();
    if (!station) throw new AppError("Ce poste n'est pas configuré", 'NO_STATION');
    return { storeId: station.store.id, registerId: station.register?.id ?? null, userId: u.id };
  };
  const supervisor = (pin: string) => s.admin.authorizeSupervisor(pin);

  const MANAGE: Role[] = ['admin', 'manager'];
  const ACCOUNTING: Role[] = ['admin', 'manager', 'accountant'];
  const BUY: Role[] = ['admin', 'manager', 'stock'];
  const STOCK: Role[] = ['admin', 'manager', 'stock'];
  const POS: Role[] = ['admin', 'manager', 'cashier'];

  return {
    // --- Application et connexion -------------------------------------------
    'app.state': () => ({
      version: appVersion,
      initialized: s.admin.isInitialized(),
      station: s.admin.station(),
      user,
    }),
    'setup.bootstrap': (input: BootstrapInput) => {
      const result = s.admin.bootstrap(input);
      user = result.admin;
      return result;
    },
    'setup.activateRegister': (code: string) => s.admin.activateRegister(code),
    /** Nouveau PC : rejoint un magasin existant via le serveur central (avant toute connexion). */
    'setup.join': (url: string, activationCode: string) => sync.join(url, activationCode),
    'auth.login': (login: string, pin: string) => (user = s.admin.login(login, pin)),
    'auth.logout': () => {
      user = null;
    },
    'auth.checkSupervisor': (pin: string) => {
      const sup = supervisor(pin);
      return { id: sup.id, name: sup.name };
    },

    // --- Administration -----------------------------------------------------
    'admin.stores': () => (requireUser(), s.admin.listStores()),
    'admin.createStore': (input: { storeCode: string; storeName: string; address?: string; phone?: string; taxpayerNumber?: string }) =>
      s.admin.createStore(requireUser(['admin']).id, input),
    'admin.updateStore': (id: string, patch: { name?: string; address?: string | null; phone?: string | null; taxpayer_number?: string | null }) =>
      s.admin.updateStore(requireUser(['admin']).id, id, patch),
    'admin.registers': (storeId: string) => (requireUser(MANAGE), s.admin.listRegisters(storeId)),
    'admin.createRegister': (storeId: string, name?: string) => s.admin.createRegister(requireUser(['admin']).id, storeId, name),
    'admin.warehouses': () => s.admin.listWarehouses(ctx().storeId),
    'admin.createWarehouse': (name: string, kind: 'shop' | 'reserve' | 'cold') => s.admin.createWarehouse(ctx(MANAGE).storeId, name, kind),
    'admin.users': () => (requireUser(MANAGE), s.admin.listUsers()),
    'admin.createUser': (input: { name: string; login: string; pin: string; role: Role; storeId: string | null }) =>
      s.admin.createUser(requireUser(MANAGE).id, input),
    'admin.updateUser': (id: string, patch: { name?: string; role?: Role; storeId?: string | null; active?: boolean; pin?: string }) =>
      s.admin.updateUser(requireUser(MANAGE).id, id, patch),
    'admin.vatRates': () => (requireUser(), s.admin.listVatRates()),
    'admin.settings': () => {
      requireUser();
      const keys = [
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
      ];
      return Object.fromEntries(keys.map((k) => [k, s.admin.getSetting(k)])) as Record<string, string | null>;
    },
    'admin.saveSettings': (values: Record<string, string>) => {
      requireUser(MANAGE);
      for (const [k, v] of Object.entries(values)) s.admin.setSetting(k, v);
    },
    'admin.audit': () => (requireUser(MANAGE), s.admin.auditLog()),
    'admin.printers': () => (requireUser(), printer.list()),
    'admin.printTest': (withDrawer: boolean) => (requireUser(MANAGE), printer.testPage(withDrawer)),

    // --- Serveur central ----------------------------------------------------
    'sync.state': () => (requireUser(), s.sync.state()),
    'sync.connect': (url: string, enrollmentKey: string) => (requireUser(['admin']), sync.connect(url, enrollmentKey)),
    'sync.now': () => (requireUser(), sync.now()),
    'sync.conflicts': () => (requireUser(MANAGE), s.sync.conflicts()),
    'sync.disconnect': () => {
      requireUser(['admin']);
      s.sync.disconnect();
    },

    // --- Catalogue ----------------------------------------------------------
    'catalogue.search': (query: string, opts?: { includeInactive?: boolean; familyId?: string }) =>
      s.catalogue.searchArticles(query, ctx().storeId, opts),
    'catalogue.suggest': (query: string) => s.catalogue.suggestArticles(query, ctx().storeId),
    'catalogue.get': (id: string) => s.catalogue.getArticle(id, ctx().storeId),
    'catalogue.save': (input: ArticleInput, id?: string) => s.catalogue.saveArticle(requireUser(STOCK).id, input, id),
    'catalogue.setStorePrice': (articleId: string, price: Fcfa | null) => {
      const c = ctx(MANAGE);
      s.catalogue.setStorePrice(c.userId, articleId, c.storeId, price);
    },
    'catalogue.priceHistory': (articleId: string) => (requireUser(), s.catalogue.priceHistory(articleId)),
    'catalogue.departments': () => (requireUser(), s.catalogue.listDepartments()),
    'catalogue.createDepartment': (name: string) => (requireUser(STOCK), s.catalogue.createDepartment(name)),
    'catalogue.createFamily': (departmentId: string, name: string) => (requireUser(STOCK), s.catalogue.createFamily(departmentId, name)),
    'catalogue.newInternalBarcode': () => (requireUser(STOCK), s.catalogue.generateInternalBarcode()),
    'catalogue.quickKeys': () => s.catalogue.quickKeys(ctx().storeId),
    'catalogue.scan': (code: string) => s.catalogue.scan(code, ctx().storeId),
    'catalogue.import': (rows: Parameters<Services['catalogue']['importArticles']>[1]) => s.catalogue.importArticles(requireUser(MANAGE).id, rows),

    // --- Stock --------------------------------------------------------------
    'stock.list': (opts?: { warehouseId?: string; search?: string; level?: StockLevel }) => s.stock.list(ctx().storeId, opts),
    'stock.receive': (input: { warehouseId: string; reference?: string; supplier?: string; supplierId?: string | null; lines: ReceptionLine[] }) =>
      s.stock.receive(ctx(STOCK), input),
    'stock.loss': (input: { warehouseId: string; articleId: string; qty: Milli; type: MovementType; reason: string; lotId?: string | null }) =>
      s.stock.recordLoss(ctx(STOCK), input),
    'stock.transfer': (input: { fromWarehouseId: string; toWarehouseId: string; lines: { articleId: string; qty: Milli }[] }) =>
      s.stock.transfer(ctx(STOCK), input),
    'stock.inventory': (input: { warehouseId: string; counts: { articleId: string; counted: Milli; countedAt: string }[] }) =>
      s.stock.applyInventory(ctx(MANAGE), input),
    'stock.printCountSheet': (warehouseId: string, departmentId?: string | null) => {
      const storeId = ctx(STOCK).storeId;
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
    'stock.expiring': (days?: number) => s.stock.expiringLots(ctx().storeId, days),
    'stock.lots': (articleId: string) => s.stock.lotsOf(articleId, ctx().storeId),
    'stock.movements': (articleId?: string) => s.stock.movements(ctx().storeId, { articleId }),

    // --- Fournisseurs et achats -----------------------------------------------
    'suppliers.list': (opts?: { search?: string; includeInactive?: boolean }) => (requireUser(), s.purchases.listSuppliers(opts)),
    'suppliers.get': (id: string) => (requireUser(), s.purchases.getSupplier(id)),
    'suppliers.save': (input: SupplierInput, id?: string) => s.purchases.saveSupplier(requireUser(BUY).id, input, id),
    'suppliers.articles': (supplierId: string) => (requireUser(), s.purchases.supplierArticles(supplierId)),
    'suppliers.ofArticle': (articleId: string) => (requireUser(), s.purchases.articleSuppliers(articleId)),
    'suppliers.setArticle': (input: Parameters<Services['purchases']['setSupplierArticle']>[1]) =>
      s.purchases.setSupplierArticle(requireUser(BUY).id, input),
    'suppliers.removeArticle': (id: string) => s.purchases.removeSupplierArticle(requireUser(BUY).id, id),
    'purchases.orders': (opts?: { supplierId?: string; open?: boolean }) => s.purchases.listOrders(ctx().storeId, opts),
    'purchases.order': (id: string) => (requireUser(), s.purchases.getOrder(id)),
    'purchases.createOrder': (input: { supplierId: string; warehouseId: string; expectedDate?: string | null; notes?: string | null; lines: PurchaseOrderLineInput[] }) =>
      s.purchases.createOrder(ctx(BUY), input),
    'purchases.updateOrder': (
      id: string,
      input: { supplierId: string; warehouseId: string; expectedDate?: string | null; notes?: string | null; lines: PurchaseOrderLineInput[] },
    ) => s.purchases.updateOrder(ctx(BUY), id, input),
    'purchases.setOrderStatus': (id: string, status: 'sent' | 'closed' | 'cancelled') => s.purchases.setOrderStatus(ctx(BUY), id, status),
    'purchases.receiveOrder': (id: string, input: Parameters<Services['purchases']['receiveOrder']>[2]) => s.purchases.receiveOrder(ctx(BUY), id, input),
    'purchases.printOrder': (id: string) => (requireUser(), printer.purchaseOrder(id)),
    'purchases.receptions': (opts?: { supplierId?: string; uninvoiced?: boolean }) => s.purchases.listReceptions(ctx().storeId, opts),
    'purchases.reception': (id: string) => (requireUser(), s.purchases.getReception(id)),
    'purchases.invoicePreview': (receptionIds: string[]) => (requireUser(), s.purchases.invoicePreview(receptionIds)),
    'purchases.createInvoice': (input: Parameters<Services['purchases']['createInvoice']>[1]) => s.purchases.createInvoice(ctx(ACCOUNTING), input),
    'purchases.invoices': (opts?: { supplierId?: string; unpaid?: boolean }) => s.purchases.listInvoices(ctx(ACCOUNTING).storeId, opts),
    'purchases.invoice': (id: string) => {
      requireUser(ACCOUNTING);
      return { invoice: s.purchases.getInvoice(id), payments: s.purchases.invoicePayments(id) };
    },
    'purchases.pay': (input: { invoiceId: string; method: SupplierPaymentMethod; amount: Fcfa; reference?: string | null }) =>
      s.purchases.paySupplier(ctx(ACCOUNTING), input),
    'purchases.due': () => s.purchases.dueSchedule(ctx(ACCOUNTING).storeId),
    'purchases.reorder': (coverDays?: number) => s.purchases.reorderProposal(ctx(BUY).storeId, { coverDays }),
    'purchases.createOrders': (input: { warehouseId: string; lines: (PurchaseOrderLineInput & { supplierId: string })[] }) =>
      s.purchases.createOrdersFromProposal(ctx(BUY), input),

    // --- Caisse -------------------------------------------------------------
    'pos.session': () => {
      const c = ctx();
      return c.registerId ? s.pos.currentSession(c.registerId) : null;
    },
    'pos.open': (openingFloat: Fcfa) => s.pos.openSession(ctx(POS), openingFloat),
    'pos.cashOperation': (type: 'IN' | 'OUT', amount: Fcfa, reason: string, supervisorPin?: string) => {
      const c = ctx(POS);
      // Un prélèvement par un caissier doit être validé par le gérant.
      if (type === 'OUT' && user!.role === 'cashier') supervisor(supervisorPin ?? '');
      s.pos.cashOperation(c, type, amount, reason);
    },
    'pos.priceLines': (lines: SaleLineInput[], level?: PriceLevel) => s.pos.priceLines(ctx().storeId, lines, level ?? 'retail'),
    /** Promotions en vigueur aujourd'hui dans ce magasin : la caisse les affiche avant l'encaissement. */
    'promotions.active': () => s.promotions.activeRules(ctx().storeId),
    'promotions.list': () => s.promotions.list(ctx(MANAGE).storeId),
    'promotions.save': (input: PromotionInput, id?: string) => s.promotions.save(requireUser(MANAGE).id, input, id),
    'promotions.setActive': (id: string, active: boolean) => s.promotions.setActive(requireUser(MANAGE).id, id, active),
    'pos.sell': (input: {
      lines: SaleLineInput[];
      payments: Payment[];
      supervisorPin?: string;
      customerId?: string | null;
      creditPin?: string;
      quoteId?: string | null;
    }) => {
      const c = ctx(POS);
      const authorizedBy = input.supervisorPin ? supervisor(input.supervisorPin).id : null;
      const creditBy = input.creditPin ? supervisor(input.creditPin).id : null;
      return s.pos.completeSale(c, {
        lines: input.lines,
        payments: input.payments,
        discountAuthorizedBy: authorizedBy,
        customerId: input.customerId ?? null,
        creditAuthorizedBy: creditBy,
        quoteId: input.quoteId ?? null,
      });
    },
    'pos.cancel': (saleId: string, supervisorPin: string, reason: string) =>
      s.pos.cancelSale(ctx(POS), saleId, supervisor(supervisorPin).id, reason),
    'pos.return': (input: { originalSaleId: string; lines: { lineId: string; qty: Milli }[]; refundMethod: PaymentMethod; supervisorPin: string; reason: string }) =>
      s.pos.returnSale(ctx(POS), { ...input, supervisorId: supervisor(input.supervisorPin).id }),
    'pos.findSale': (number: string) => (requireUser(), s.pos.findSaleByNumber(number)),
    'pos.sale': (id: string) => (requireUser(), s.pos.getSale(id)),
    'pos.sales': (opts: { sessionId?: string; date?: string }) => s.pos.listSales({ ...opts, storeId: ctx().storeId }),
    'pos.hold': (label: string, lines: SaleLineInput[]) => s.pos.holdTicket(ctx(POS), label, lines),
    'pos.held': () => {
      const c = ctx();
      return c.registerId ? s.pos.listHeld(c.registerId) : [];
    },
    'pos.resume': (id: string) => (requireUser(POS), s.pos.resumeHeld(id)),
    'pos.zReport': (sessionId: string) => (requireUser(), s.pos.zReport(sessionId)),
    'pos.close': (counted: DenominationCount) => s.pos.closeSession(ctx(POS), counted),
    'pos.sessions': () => s.pos.listSessions(ctx(MANAGE).storeId),
    'pos.printTicket': (saleId: string, opts?: { newSale?: boolean }) =>
      printer.ticket(saleId, { newSale: Boolean(opts?.newSale && requireUser(POS)) }),
    /** Ouverture du tiroir sans encaissement : tracée dans le journal d'audit. */
    'pos.openDrawer': async () => {
      const c = ctx(POS);
      await printer.openDrawer();
      s.receipts.drawerOpened(c);
    },
    'pos.printZ': (sessionId: string) => printer.zReport(sessionId),
    'pos.printInvoice': (saleId: string) => (requireUser(), printer.invoice(saleId)),

    // --- Clients et crédit ----------------------------------------------------
    'customers.list': (opts?: { search?: string; includeInactive?: boolean; withBalance?: boolean }) => s.customers.listCustomers(ctx().storeId, opts),
    'customers.get': (id: string) => (requireUser(), s.customers.getCustomer(id)),
    'customers.save': (input: CustomerInput, id?: string) => {
      const u = requireUser([...MANAGE, 'accountant', 'cashier']);
      // Le caissier peut créer ou corriger une fiche, mais pas accorder de crédit.
      if (u.role === 'cashier') {
        const before = id ? s.customers.getCustomer(id).credit_limit : 0;
        if ((input.creditLimit ?? before) !== before) throw new AppError('Seul le gérant ou le comptable fixe le plafond de crédit', 'FORBIDDEN');
        const level = id ? s.customers.getCustomer(id).price_level : 'retail';
        if ((input.priceLevel ?? level) !== level) throw new AppError('Seul le gérant ou le comptable fixe le tarif du client', 'FORBIDDEN');
      }
      return s.customers.saveCustomer(u.id, input, id);
    },
    'customers.account': (id: string) => s.customers.account(ctx().storeId, id),
    'customers.statement': (id: string, from?: string | null, to?: string | null) =>
      s.customers.statement(ctx().storeId, id, { from: from ?? undefined, to: to ?? undefined }),
    'customers.sales': (id: string) => s.pos.listSales({ storeId: ctx().storeId, customerId: id, limit: 100 }),
    'customers.pay': (input: { customerId: string; method: CustomerPaymentMethod; amount: Fcfa; reference?: string | null; notes?: string | null; atRegister?: boolean }) => {
      const c = ctx([...POS, 'accountant']);
      // Encaissé à la caisse : rattaché à la session ouverte, les espèces vont dans le tiroir.
      const session = input.atRegister && c.registerId ? s.pos.currentSession(c.registerId) : null;
      if (input.atRegister && !session) throw new AppError("Ouvrez la caisse avant d'encaisser un règlement client", 'NO_SESSION');
      return s.customers.receivePayment(c, { ...input, sessionId: session?.id ?? null });
    },
    'customers.payments': (opts?: { customerId?: string; limit?: number }) => s.customers.listPayments(ctx().storeId, opts),
    'customers.receivables': () => s.customers.receivables(ctx([...MANAGE, 'accountant']).storeId),
    'customers.printStatement': (id: string, from?: string | null, to?: string | null) => printer.statement(ctx().storeId, id, from, to),
    'customers.printReceipt': (paymentId: string) => (requireUser(), printer.customerReceipt(paymentId)),

    // --- Devis et proformas ----------------------------------------------------
    'quotes.list': (opts?: { state?: QuoteState; customerId?: string; search?: string }) => s.quotes.list(ctx().storeId, opts),
    'quotes.get': (id: string) => (requireUser(), s.quotes.get(id)),
    /** Remise sur un devis : gérant, ou code d'un gérant. */
    'quotes.save': (input: QuoteInput, id?: string | null, supervisorPin?: string) => {
      const c = ctx([...POS, 'accountant']);
      return s.quotes.save(c, input, { id: id ?? undefined, discountAuthorizedBy: supervisorPin ? supervisor(supervisorPin).id : null });
    },
    'quotes.cancel': (id: string) => s.quotes.cancel(ctx([...POS, 'accountant']), id),
    'quotes.print': (id: string) => (requireUser(), printer.quote(id)),
    /** Lignes à charger dans la fiche de facturation, aux prix garantis par le devis. */
    'quotes.saleLines': (id: string) => s.quotes.saleLines(ctx(POS).storeId, id),

    // --- Dépenses -------------------------------------------------------------
    'expenses.categories': (includeInactive?: boolean) => (requireUser(), s.expenses.listCategories(includeInactive)),
    'expenses.saveCategory': (input: { id?: string | null; name: string; accountId: string; active?: boolean }) =>
      s.expenses.saveCategory(requireUser(ACCOUNTING).id, input),
    /** Au bureau : gérant ou comptable. À la caisse (espèces du tiroir) : un caissier a besoin du code d'un gérant. */
    'expenses.record': (input: Omit<ExpenseInput, 'authorizedBy'> & { supervisorPin?: string }) => {
      const { supervisorPin, ...rest } = input;
      const c = ctx(input.atRegister ? POS : ACCOUNTING);
      const authorizedBy = user!.role === 'cashier' ? supervisor(supervisorPin ?? '').id : null;
      return s.expenses.record(c, { ...rest, authorizedBy });
    },
    'expenses.cancel': (id: string, reason: string, supervisorPin?: string) => {
      const c = ctx([...POS, 'accountant']);
      const sup = MANAGE.includes(user!.role) ? user!.id : supervisor(supervisorPin ?? '').id;
      return s.expenses.cancel(c, id, sup, reason);
    },
    'expenses.get': (id: string) => (requireUser(), s.expenses.get(id)),
    'expenses.list': (opts: { from?: string; to?: string; categoryId?: string; sessionId?: string; includeCancelled?: boolean }) =>
      s.expenses.list(ctx(opts.sessionId ? undefined : ACCOUNTING).storeId, opts),
    'expenses.summary': (opts: { from?: string; to?: string }) => s.expenses.summary(ctx(ACCOUNTING).storeId, opts),
    'expenses.print': (id: string) => (requireUser(), printer.expenseVoucher(id)),

    // --- Comptabilité --------------------------------------------------------
    'accounting.accounts': (includeInactive?: boolean) => (requireUser(), s.accounting.listAccounts(includeInactive)),
    'accounting.saveAccount': (input: { id: string; label: string; role?: AccountRole | null; active?: boolean }) =>
      s.accounting.saveAccount(requireUser(ACCOUNTING).id, input),
    'accounting.entries': (opts: { from?: string; to?: string; journal?: JournalCode }) => s.accounting.entries(ctx(ACCOUNTING).storeId, opts),
    'accounting.addEntry': (input: Parameters<Services['accounting']['addManualEntry']>[1]) => s.accounting.addManualEntry(ctx(ACCOUNTING), input),
    'accounting.ledger': (opts: { account: string; aux?: string; from?: string; to?: string }) => s.accounting.ledger(ctx(ACCOUNTING).storeId, opts),
    'accounting.trialBalance': (opts: { from?: string; to?: string }) => s.accounting.trialBalance(ctx(ACCOUNTING).storeId, opts),
    'accounting.treasury': (to?: string) => s.accounting.treasury(ctx(ACCOUNTING).storeId, to),
    'accounting.vatReturn': (month: string) => s.accounting.vatReturn(ctx(ACCOUNTING).storeId, month),
    'accounting.exportCsv': (opts: { from?: string; to?: string }) => s.accounting.exportCsv(ctx(ACCOUNTING).storeId, opts),
    'tax.assessment': (year: number) => s.tax.assessment(ctx(ACCOUNTING).storeId, year),
    'tax.instalment': (month: string) => s.tax.instalment(ctx(ACCOUNTING).storeId, month),
    'tax.saveSettings': (year: number, input: Parameters<typeof s.tax.saveSettings>[2]) => s.tax.saveSettings(ctx(ACCOUNTING), year, input),
    'tax.book': (year: number) => s.tax.book(ctx(ACCOUNTING), year),
    'tax.print': (year: number) => printer.taxAssessment(ctx(ACCOUNTING).storeId, year),
    'accounting.printVat': (month: string) => printer.vatReturn(ctx(ACCOUNTING).storeId, month),
    'accounting.statements': (opts: { from: string; to: string }) => s.statements.statements(ctx(ACCOUNTING).storeId, opts),
    'accounting.cashFlow': (opts: { from: string; to: string }) => s.statements.cashFlow(ctx(ACCOUNTING).storeId, opts),
    'accounting.notes': (year: number) => s.notes.notes(ctx(ACCOUNTING).storeId, year),
    'accounting.disclosures': (year: number) => ({
      ...s.disclosures.get(ctx(ACCOUNTING).storeId, year),
      labels: { security: SECURITY_KINDS, commitment: COMMITMENT_KINDS, staff: STAFF_CATEGORIES },
    }),
    'accounting.saveDisclosures': (year: number, input: DisclosuresInput) => s.disclosures.save(ctx(ACCOUNTING), year, input),
    'accounting.notesCsv': (year: number) => s.notes.exportCsv(ctx(ACCOUNTING).storeId, year),
    'accounting.printNotes': (year: number) => printer.notes(ctx(ACCOUNTING).storeId, year),
    'accounting.statementsCsv': (opts: { from: string; to: string }) => s.statements.exportCsv(ctx(ACCOUNTING).storeId, opts),
    'accounting.printStatements': (from: string, to: string) => printer.statements(ctx(ACCOUNTING).storeId, from, to),
    // --- Rapprochement bancaire --------------------------------------------------------
    'bank.accounts': () => (ctx(ACCOUNTING), s.reconciliation.accounts()),
    'bank.state': (accountId: string, date?: string) => s.reconciliation.state(ctx(ACCOUNTING).storeId, accountId, date),
    'bank.import': (accountId: string, lines: StatementLine[]) => s.reconciliation.importLines(ctx(ACCOUNTING), accountId, lines),
    'bank.delete': (id: string) => s.reconciliation.deleteLine(ctx(ACCOUNTING), id),
    'bank.match': (id: string, key: string) => s.reconciliation.match(ctx(ACCOUNTING), id, key),
    'bank.unmatch': (id: string) => s.reconciliation.unmatch(ctx(ACCOUNTING), id),
    'bank.autoMatch': (accountId: string) => s.reconciliation.autoMatch(ctx(ACCOUNTING), accountId),
    'bank.book': (id: string, input: { account: string; label?: string }) => s.reconciliation.bookLine(ctx(ACCOUNTING), id, input),
    'bank.print': (accountId: string, date: string, statementBalance: number | null) =>
      printer.reconciliation(ctx(ACCOUNTING).storeId, accountId, date, statementBalance),
    'accounting.printBalance': (from?: string | null, to?: string | null) => printer.trialBalance(ctx(ACCOUNTING).storeId, from, to),
    'accounting.printJournal': (from?: string | null, to?: string | null, journal?: JournalCode | null) =>
      printer.journal(ctx(ACCOUNTING).storeId, from, to, journal),

    // --- Sauvegardes -------------------------------------------------------
    'backup.status': () => (requireUser(MANAGE), { ...s.backups.status(), backups: s.backups.list() }),
    'backup.overdue': () => (requireUser(), s.backups.status().overdue),
    'backup.now': () => s.backups.saveNow(requireUser(MANAGE).id),
    'backup.toFolder': async () => {
      const u = requireUser(MANAGE);
      const dir = await system.chooseFolder('Choisir la clé USB ou le dossier de la copie');
      return dir ? s.backups.backup(u.id, { dir, kind: 'manual' }) : null;
    },
    'backup.chooseFolder': (title: string) => (requireUser(['admin']), system.chooseFolder(title)),
    'backup.configure': (input: { dir?: string | null; copyDir?: string | null; keep?: number }) => s.backups.configure(requireUser(['admin']).id, input),
    'backup.list': (dir?: string | null) => (requireUser(MANAGE), s.backups.list(dir)),
    'backup.chooseFile': async () => {
      requireUser(['admin']);
      const file = await system.chooseBackupFile();
      return file ? inspectBackup(file) : null;
    },
    'backup.openFolder': (path: string) => (requireUser(MANAGE), system.openFolder(path)),
    'backup.restore': (file: string) => {
      const u = requireUser(['admin']);
      const info = inspectBackup(file);
      if (!info.ok) throw new AppError(info.error ?? 'Sauvegarde invalide', 'INVALID');
      system.restore(file, u.id);
      return info;
    },

    // --- Rapports -----------------------------------------------------------
    'reports.daily': (date: string) => s.reports.daily(ctx(MANAGE).storeId, date),
    'reports.salesCsv': (from: string, to: string) => s.reports.salesExportCsv(ctx(['admin', 'manager', 'accountant']).storeId, from, to),
  };
}

export type Api = ReturnType<typeof createApi>;
export type ApiName = keyof Api;
