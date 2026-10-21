import type { Fcfa } from '@superette/core';
import type { AccountingService } from './accounting';
import type { AdminService } from './admin';
import type { Db } from './database';
import type { StockService } from './stock';
import { AppError, Base, type Clock, newId } from './util';

export interface Company {
  id: string;
  name: string;
  legal_form: string | null;
  taxpayer_number: string | null;
  rccm: string | null;
  address: string | null;
  phone: string | null;
  active: number;
  created_at: string;
  updated_at: string;
}

export interface CompanyInput {
  name: string;
  legalForm?: string | null;
  taxpayerNumber?: string | null;
  rccm?: string | null;
  address?: string | null;
  phone?: string | null;
  active?: boolean;
}

/** Ce que possède l'entreprise à une date, d'après la comptabilité et le stock. */
export interface PatrimonyPoint {
  date: string;
  /** Caisses, banques, Mobile Money, chèques à encaisser (classe 5). */
  treasury: Fcfa;
  /** Ce que doivent les clients. */
  receivables: Fcfa;
  /** Stock valorisé au CMUP. */
  stock: Fcfa;
  /** Ce qui est dû aux fournisseurs. */
  payables: Fcfa;
  /** Trésorerie + créances + stock − dettes fournisseurs. */
  patrimony: Fcfa;
}

/** Fin de mois (AAAA-MM-JJ) des `n` derniers mois, le dernier étant `to`. */
function monthEnds(to: string, n: number): string[] {
  const [y, m] = to.split('-').map(Number) as [number, number];
  const out: string[] = [];
  for (let i = n - 1; i >= 1; i--) out.push(new Date(Date.UTC(y, m - i, 0)).toISOString().slice(0, 10));
  out.push(to);
  return out;
}

/**
 * Sociétés et patrimoine. Une société (personne morale, avec son NIU et son
 * RCCM) regroupe un ou plusieurs magasins : ses chiffres sont la somme de ceux
 * de ses magasins. Le patrimoine suivi en comptabilité :
 * trésorerie + créances clients + stock − dettes fournisseurs, mois par mois.
 */
export class CompanyService extends Base {
  constructor(
    db: Db,
    clock: Clock,
    private readonly admin: AdminService,
    private readonly accounting: AccountingService,
    private readonly stock: StockService,
  ) {
    super(db, clock);
  }

  list(includeInactive = false): (Company & { stores: { id: string; code: string; name: string }[] })[] {
    const rows = this.db.prepare(`SELECT * FROM companies ${includeInactive ? '' : 'WHERE active = 1'} ORDER BY name`).all() as Company[];
    const stores = this.db.prepare('SELECT id, code, name, company_id FROM stores WHERE active = 1 ORDER BY code').all() as { id: string; code: string; name: string; company_id: string | null }[];
    return rows.map((c) => ({ ...c, stores: stores.filter((s) => s.company_id === c.id).map(({ company_id: _, ...s }) => s) }));
  }

  get(id: string): Company {
    const row = this.db.prepare('SELECT * FROM companies WHERE id = ?').get(id) as Company | undefined;
    if (!row) throw new AppError('Société introuvable', 'NOT_FOUND');
    return row;
  }

  save(userId: string, input: CompanyInput, id?: string): Company {
    const name = input.name.trim();
    if (!name) throw new AppError('Le nom de la société est obligatoire', 'INVALID');
    if (name.length > 80) throw new AppError('Nom de la société trop long (80 caractères au plus)', 'INVALID');
    const twin = this.db.prepare('SELECT id FROM companies WHERE lower(name) = lower(?) AND id <> ?').pluck().get(name, id ?? '') as string | undefined;
    if (twin) throw new AppError(`Une société s'appelle déjà « ${name} »`, 'DUPLICATE');
    const text = (v: string | null | undefined) => v?.trim() || null;
    const now = this.now();
    const values = {
      name,
      legal_form: text(input.legalForm),
      taxpayer_number: text(input.taxpayerNumber)?.toUpperCase() ?? null,
      rccm: text(input.rccm),
      address: text(input.address),
      phone: text(input.phone),
      active: input.active === false ? 0 : 1,
      updated_at: now,
    };
    return this.tx(() => {
      const companyId = id ?? newId();
      if (id) {
        this.get(id);
        this.db
          .prepare(
            `UPDATE companies SET name = @name, legal_form = @legal_form, taxpayer_number = @taxpayer_number, rccm = @rccm, address = @address,
               phone = @phone, active = @active, updated_at = @updated_at WHERE id = @id`,
          )
          .run({ ...values, id });
      } else {
        this.db
          .prepare(
            `INSERT INTO companies (id, name, legal_form, taxpayer_number, rccm, address, phone, active, created_at, updated_at)
             VALUES (@id, @name, @legal_form, @taxpayer_number, @rccm, @address, @phone, @active, @created_at, @updated_at)`,
          )
          .run({ ...values, id: companyId, created_at: now });
      }
      this.enqueue(null, 'company', companyId, 'upsert', {});
      this.audit(userId, id ? 'company.update' : 'company.create', 'company', companyId, { name });
      return this.get(companyId);
    });
  }

  /** Rattache un magasin à une société (null : le détache). */
  assignStore(userId: string, storeId: string, companyId: string | null): void {
    const store = this.admin.getStore(storeId);
    if (companyId) {
      const c = this.get(companyId);
      if (!c.active) throw new AppError(`La société ${c.name} est désactivée`, 'INVALID');
    }
    this.tx(() => {
      this.db.prepare('UPDATE stores SET company_id = ? WHERE id = ?').run(companyId, storeId);
      this.enqueue({ storeId, registerId: null }, 'store', storeId, 'upsert', {});
      this.audit(userId, 'company.assign_store', 'store', storeId, { store: store.name, companyId });
    });
  }

  /** Patrimoine d'un magasin à une date. */
  patrimonyAt(storeId: string, date: string): PatrimonyPoint {
    const roles = this.accounting.roles();
    const tb = this.accounting.trialBalance(storeId, { to: date });
    const sum = (pick: (account: string) => boolean) => tb.rows.filter((r) => pick(r.account)).reduce((t, r) => t + r.closing, 0);
    const treasury = sum((a) => a.startsWith('5'));
    const receivables = Math.max(0, sum((a) => a === roles.customers));
    const payables = Math.max(0, -sum((a) => a === roles.suppliers));
    const stock = this.stock.valueAt(storeId, date);
    return { date, treasury, receivables, stock, payables, patrimony: treasury + receivables + stock - payables };
  }

  /**
   * Évolution du patrimoine, une valeur par fin de mois (la dernière à aujourd'hui),
   * pour un magasin, une société (ses magasins) ou tous les magasins.
   */
  patrimony(scope: { storeId?: string | null; companyId?: string | null }, months = 12): { stores: { id: string; name: string }[]; points: PatrimonyPoint[] } {
    const n = Math.min(Math.max(Math.trunc(months) || 12, 2), 24);
    const stores = scope.storeId
      ? [this.admin.getStore(scope.storeId)]
      : (this.db.prepare(`SELECT * FROM stores WHERE active = 1 ${scope.companyId ? 'AND company_id = ?' : ''} ORDER BY code`).all(...(scope.companyId ? [scope.companyId] : [])) as {
          id: string;
          name: string;
        }[]);
    const points = monthEnds(this.today(), n).map((date) => {
      const total: PatrimonyPoint = { date, treasury: 0, receivables: 0, stock: 0, payables: 0, patrimony: 0 };
      for (const s of stores) {
        const p = this.patrimonyAt(s.id, date);
        total.treasury += p.treasury;
        total.receivables += p.receivables;
        total.stock += p.stock;
        total.payables += p.payables;
        total.patrimony += p.patrimony;
      }
      return total;
    });
    return { stores: stores.map((s) => ({ id: s.id, name: s.name })), points };
  }

  /** Chiffres consolidés d'une société à une date : patrimoine de chaque magasin et total. */
  consolidated(companyId: string, date?: string | null): { company: Company; date: string; stores: (PatrimonyPoint & { id: string; name: string; sales: Fcfa })[]; total: PatrimonyPoint & { sales: Fcfa } } {
    const company = this.get(companyId);
    const at = date || this.today();
    const month = at.slice(0, 7);
    const stores = (this.db.prepare('SELECT id, name FROM stores WHERE active = 1 AND company_id = ? ORDER BY code').all(companyId) as { id: string; name: string }[]).map((s) => {
      const sales = this.db
        .prepare("SELECT COALESCE(SUM(total_ttc), 0) FROM sales WHERE store_id = ? AND status = 'completed' AND strftime('%Y-%m', created_at, 'localtime') = ? AND date(created_at, 'localtime') <= ?")
        .pluck()
        .get(s.id, month, at) as number;
      return { ...s, ...this.patrimonyAt(s.id, at), sales };
    });
    const total = { date: at, treasury: 0, receivables: 0, stock: 0, payables: 0, patrimony: 0, sales: 0 };
    for (const s of stores) for (const k of ['treasury', 'receivables', 'stock', 'payables', 'patrimony', 'sales'] as const) total[k] += s[k];
    return { company, date: at, stores, total };
  }
}
