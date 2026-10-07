import { AccountingService } from './accounting';
import { AdminService } from './admin';
import { CatalogueService } from './catalogue';
import { CustomerService } from './customers';
import { type Db, openDatabase } from './database';
import { DisclosureService } from './disclosures';
import { ExpenseService } from './expenses';
import { PosService } from './pos';
import { PurchaseService } from './purchases';
import { ReceiptService } from './receipts';
import { QuoteService } from './quotes';
import { ReportService } from './reports';
import { ReconciliationService } from './reconciliation';
import { TaxService } from './tax';
import { NotesService } from './notes';
import { FinancialStatementsService } from './statements';
import { StockService } from './stock';
import { SyncService } from './sync';
import type { Clock } from './util';

export * from './accounting';
export * from './admin';
export * from './catalogue';
export * from './customers';
export * from './database';
export * from './disclosures';
export * from './expenses';
export * from './pos';
export * from './purchases';
export * from './receipts';
export * from './quotes';
export * from './reports';
export * from './reconciliation';
export * from './tax';
export * from './notes';
export * from './statements';
export * from './stock';
export * from './sync';
export * from './syncClient';
export { AppError, type Clock, type Context } from './util';

export interface Services {
  db: Db;
  admin: AdminService;
  catalogue: CatalogueService;
  stock: StockService;
  customers: CustomerService;
  expenses: ExpenseService;
  quotes: QuoteService;
  pos: PosService;
  receipts: ReceiptService;
  purchases: PurchaseService;
  reports: ReportService;
  accounting: AccountingService;
  statements: FinancialStatementsService;
  reconciliation: ReconciliationService;
  tax: TaxService;
  notes: NotesService;
  disclosures: DisclosureService;
  sync: SyncService;
}

export function createServices(db: Db, clock: Clock = () => new Date()): Services {
  const admin = new AdminService(db, clock);
  const catalogue = new CatalogueService(db, clock);
  const stock = new StockService(db, clock);
  const customers = new CustomerService(db, clock);
  const expenses = new ExpenseService(db, clock);
  const quotes = new QuoteService(db, clock, admin, catalogue);
  const pos = new PosService(db, clock, admin, catalogue, stock, customers, quotes);
  const receipts = new ReceiptService(db, clock, admin, pos, customers, expenses);
  const purchases = new PurchaseService(db, clock, stock);
  const reports = new ReportService(db, clock);
  const accounting = new AccountingService(db, clock);
  const statements = new FinancialStatementsService(db, clock, accounting, stock);
  const reconciliation = new ReconciliationService(db, clock, accounting);
  const tax = new TaxService(db, clock, accounting, statements);
  const disclosures = new DisclosureService(db, clock);
  const notes = new NotesService(db, clock, accounting, statements, tax, disclosures);
  const sync = new SyncService(db, clock, stock);
  return { db, admin, catalogue, stock, customers, expenses, quotes, pos, receipts, purchases, reports, accounting, statements, reconciliation, tax, notes, disclosures, sync };
}

export function openServices(file: string, clock?: Clock): Services {
  return createServices(openDatabase(file), clock);
}
