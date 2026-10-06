import { AccountingService } from './accounting';
import { AdminService } from './admin';
import { CatalogueService } from './catalogue';
import { CustomerService } from './customers';
import { type Db, openDatabase } from './database';
import { PosService } from './pos';
import { PurchaseService } from './purchases';
import { ReportService } from './reports';
import { StockService } from './stock';
import { SyncService } from './sync';
import type { Clock } from './util';

export * from './accounting';
export * from './admin';
export * from './catalogue';
export * from './customers';
export * from './database';
export * from './pos';
export * from './purchases';
export * from './reports';
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
  pos: PosService;
  purchases: PurchaseService;
  reports: ReportService;
  accounting: AccountingService;
  sync: SyncService;
}

export function createServices(db: Db, clock: Clock = () => new Date()): Services {
  const admin = new AdminService(db, clock);
  const catalogue = new CatalogueService(db, clock);
  const stock = new StockService(db, clock);
  const customers = new CustomerService(db, clock);
  const pos = new PosService(db, clock, admin, catalogue, stock, customers);
  const purchases = new PurchaseService(db, clock, stock);
  const reports = new ReportService(db, clock);
  const accounting = new AccountingService(db, clock);
  const sync = new SyncService(db, clock, stock);
  return { db, admin, catalogue, stock, customers, pos, purchases, reports, accounting, sync };
}

export function openServices(file: string, clock?: Clock): Services {
  return createServices(openDatabase(file), clock);
}
