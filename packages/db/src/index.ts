import { AdminService } from './admin';
import { CatalogueService } from './catalogue';
import { type Db, openDatabase } from './database';
import { PosService } from './pos';
import { ReportService } from './reports';
import { StockService } from './stock';
import type { Clock } from './util';

export * from './admin';
export * from './catalogue';
export * from './database';
export * from './pos';
export * from './reports';
export * from './stock';
export { AppError, type Clock, type Context } from './util';

export interface Services {
  db: Db;
  admin: AdminService;
  catalogue: CatalogueService;
  stock: StockService;
  pos: PosService;
  reports: ReportService;
}

export function createServices(db: Db, clock: Clock = () => new Date()): Services {
  const admin = new AdminService(db, clock);
  const catalogue = new CatalogueService(db, clock);
  const stock = new StockService(db, clock);
  const pos = new PosService(db, clock, admin, catalogue, stock);
  const reports = new ReportService(db, clock);
  return { db, admin, catalogue, stock, pos, reports };
}

export function openServices(file: string, clock?: Clock): Services {
  return createServices(openDatabase(file), clock);
}
