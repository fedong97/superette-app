import { type Fcfa, splitTtc } from '@superette/core';
import { AppError, Base, type Context, newId } from './util';

export const JOURNALS = {
  VE: 'Ventes',
  AC: 'Achats',
  CA: 'Caisse',
  BQ: 'Banque',
  MM: 'Mobile Money',
  OD: 'Opérations diverses',
  AN: 'À-nouveaux',
} as const;
export type JournalCode = keyof typeof JOURNALS;

export const ACCOUNT_ROLES = {
  sales: 'Ventes de marchandises',
  purchases: 'Achats de marchandises',
  vat_collected: 'TVA collectée',
  vat_deductible: 'TVA déductible',
  vat_due: 'TVA due',
  vat_credit: 'Crédit de TVA',
  customers: 'Clients',
  suppliers: 'Fournisseurs',
  cash: 'Caisse (caisses de vente)',
  central_cash: 'Caisse centrale',
  owner: "Compte de l'exploitant",
  bank: 'Banque (virements, chèques)',
  card: 'Cartes bancaires',
  mtn: 'MTN Mobile Money',
  orange: 'Orange Money',
  voucher: "Bons d'achat",
  transfer: 'Virements internes (coffre)',
  cash_short: 'Manquants de caisse',
  cash_over: 'Excédents de caisse',
  stock: 'Stock de marchandises',
  stock_variation: 'Variation des stocks',
} as const;
export type AccountRole = keyof typeof ACCOUNT_ROLES;

export interface Account {
  id: string;
  label: string;
  role: AccountRole | null;
  active: number;
}

export interface EntryLine {
  account: string;
  /** Compte de tiers (code client ou fournisseur) pour les comptes 411 et 401. */
  aux: string | null;
  aux_name: string | null;
  label: string;
  debit: Fcfa;
  credit: Fcfa;
}

export interface Entry {
  journal: JournalCode;
  date: string;
  /** Pièce justificative : n° de Z, de facture, de règlement… */
  ref: string;
  label: string;
  source: 'auto' | 'manual';
  lines: EntryLine[];
}

const METHOD_ROLE: Record<string, AccountRole> = {
  CASH: 'cash',
  MTN_MOMO: 'mtn',
  ORANGE_MONEY: 'orange',
  CARD: 'card',
  BANK_TRANSFER: 'bank',
  CHEQUE: 'bank',
  VOUCHER: 'voucher',
  CUSTOMER_CREDIT: 'customers',
};
const METHOD_JOURNAL = (method: string): JournalCode =>
  method === 'CASH' ? 'CA' : method === 'MTN_MOMO' || method === 'ORANGE_MONEY' ? 'MM' : 'BQ';

/** Ligne au débit si le montant est positif, au crédit sinon (retours, avoirs). */
function side(account: string, amount: number, label: string, aux: { code: string; name: string } | null = null): EntryLine {
  return { account, aux: aux?.code ?? null, aux_name: aux?.name ?? null, label, debit: amount > 0 ? amount : 0, credit: amount < 0 ? -amount : 0 };
}

const inRange = (d: string, from?: string, to?: string) => (!from || d >= from) && (!to || d <= to);

/**
 * Comptabilité SYSCOHADA. Les écritures ne sont pas recopiées : elles se
 * calculent à partir des pièces (Z de caisse, factures, règlements), ce qui
 * les garde justes même quand les PC se synchronisent dans le désordre.
 * Seules les écritures manuelles (à-nouveaux, OD) sont enregistrées.
 */
export class AccountingService extends Base {
  // --- Plan comptable -----------------------------------------------------------

  listAccounts(includeInactive = false): Account[] {
    return this.db.prepare(`SELECT id, label, role, active FROM accounts WHERE (? = 1 OR active = 1) ORDER BY id`).all(includeInactive ? 1 : 0) as Account[];
  }

  roles(): Record<AccountRole, string> {
    const rows = this.db.prepare('SELECT id, role FROM accounts WHERE role IS NOT NULL').all() as { id: string; role: AccountRole }[];
    const map = Object.fromEntries(rows.map((r) => [r.role, r.id])) as Record<AccountRole, string>;
    for (const role of Object.keys(ACCOUNT_ROLES) as AccountRole[]) {
      if (!map[role]) throw new AppError(`Aucun compte n'est désigné pour : ${ACCOUNT_ROLES[role]}`, 'ACCOUNT_MISSING');
    }
    return map;
  }

  saveAccount(userId: string, input: { id: string; label: string; role?: AccountRole | null; active?: boolean }): Account {
    const id = input.id.trim();
    if (!/^[1-9]\d{1,9}$/.test(id)) throw new AppError('Numéro de compte invalide (chiffres uniquement, classe 1 à 9)', 'INVALID');
    if (!input.label.trim()) throw new AppError('Le libellé du compte est obligatoire', 'INVALID');
    if (input.role && !(input.role in ACCOUNT_ROLES)) throw new AppError('Rôle de compte inconnu', 'INVALID');
    const current = this.db.prepare('SELECT role FROM accounts WHERE id = ?').pluck().get(id) as AccountRole | null | undefined;
    // Rôle non précisé : le compte garde le sien.
    const role = input.role === undefined ? (current ?? null) : input.role;
    if (current && role !== current) {
      throw new AppError(`Ce compte sert aux écritures « ${ACCOUNT_ROLES[current]} » : désignez d'abord un autre compte pour cet usage`, 'INVALID');
    }
    if (current && input.active === false) throw new AppError('Un compte utilisé par les écritures automatiques ne peut pas être désactivé', 'INVALID');
    return this.tx(() => {
      const now = this.now();
      if (input.role) {
        // Le rôle passe sur ce compte : l'ancien compte le perd.
        const previous = this.db.prepare('SELECT id FROM accounts WHERE role = ? AND id <> ?').pluck().get(input.role, id) as string | undefined;
        if (previous) {
          this.db.prepare('UPDATE accounts SET role = NULL, updated_at = ? WHERE id = ?').run(now, previous);
          this.enqueue(null, 'account', previous, 'upsert', {});
        }
      }
      this.db
        .prepare(
          `INSERT INTO accounts (id, label, role, active, updated_at) VALUES (@id, @label, @role, @active, @now)
           ON CONFLICT(id) DO UPDATE SET label = @label, role = @role, active = @active, updated_at = @now`,
        )
        .run({ id, label: input.label.trim(), role, active: input.active === false ? 0 : 1, now });
      this.enqueue(null, 'account', id, 'upsert', {});
      this.audit(userId, 'account.save', 'account', id, { label: input.label, role });
      return this.db.prepare('SELECT id, label, role, active FROM accounts WHERE id = ?').get(id) as Account;
    });
  }

  // --- Écritures --------------------------------------------------------------

  entries(storeId: string, opts: { from?: string; to?: string; journal?: JournalCode } = {}): Entry[] {
    const r = this.roles();
    const all = [
      ...this.salesEntries(storeId, r, opts),
      ...this.cashEntries(storeId, r, opts),
      ...this.centralEntries(storeId, r, opts),
      ...this.customerPaymentEntries(storeId, r, opts),
      ...this.purchaseEntries(storeId, r, opts),
      ...this.supplierPaymentEntries(storeId, r, opts),
      ...this.expenseEntries(storeId, r, opts),
      ...this.manualEntries(storeId, opts),
    ].filter((e) => (!opts.journal || e.journal === opts.journal) && inRange(e.date, opts.from, opts.to) && e.lines.length > 0);
    return all.sort((a, b) => a.date.localeCompare(b.date) || a.journal.localeCompare(b.journal) || a.ref.localeCompare(b.ref));
  }

  /** Ventes : une écriture par session de caisse et par jour (comme le Z), tiers client pour le crédit. */
  private salesEntries(storeId: string, r: Record<AccountRole, string>, opts: { from?: string; to?: string }): Entry[] {
    const where = `s.store_id = @storeId AND s.status = 'completed'
      AND (@from IS NULL OR date(s.created_at, 'localtime') >= @from) AND (@to IS NULL OR date(s.created_at, 'localtime') <= @to)`;
    const params = { storeId, from: opts.from ?? null, to: opts.to ?? null };
    const groups = this.db
      .prepare(
        `SELECT s.session_id, date(s.created_at, 'localtime') AS d, SUM(s.total_ht) AS ht, SUM(s.total_tva) AS tva, SUM(s.change_given) AS change,
                COUNT(*) AS n, MAX(g.name) AS register, MAX(cs.z_number) AS z
         FROM sales s JOIN cash_sessions cs ON cs.id = s.session_id JOIN registers g ON g.id = s.register_id
         WHERE ${where} GROUP BY s.session_id, d`,
      )
      .all(params) as { session_id: string; d: string; ht: number; tva: number; change: number; n: number; register: string; z: number | null }[];
    const pays = this.db
      .prepare(
        `SELECT s.session_id, date(s.created_at, 'localtime') AS d, p.method, c.code, c.name, SUM(p.amount) AS amount
         FROM sales s JOIN sale_payments p ON p.sale_id = s.id LEFT JOIN customers c ON c.id = s.customer_id AND p.method = 'CUSTOMER_CREDIT'
         WHERE ${where} GROUP BY s.session_id, d, p.method, c.code ORDER BY p.method, c.name`,
      )
      .all(params) as { session_id: string; d: string; method: string; code: string | null; name: string | null; amount: number }[];
    return groups.map((g) => {
      const label = `Ventes ${g.register} du ${g.d.split('-').reverse().join('/')}`;
      const lines: EntryLine[] = [];
      for (const p of pays.filter((x) => x.session_id === g.session_id && x.d === g.d)) {
        const amount = p.method === 'CASH' ? p.amount - g.change : p.amount;
        if (!amount) continue;
        const aux = p.method === 'CUSTOMER_CREDIT' && p.code ? { code: p.code, name: p.name ?? '' } : null;
        lines.push(side(r[METHOD_ROLE[p.method] ?? 'cash'], amount, aux ? `Vente à crédit ${aux.name}` : label, aux));
      }
      lines.push(side(r.sales, -g.ht, label));
      lines.push(side(r.vat_collected, -g.tva, `TVA collectée, ${label.toLowerCase()}`));
      return { journal: 'VE' as const, date: g.d, ref: g.z ? `Z${g.z}` : `${g.n} tickets`, label, source: 'auto' as const, lines: lines.filter((l) => l.debit || l.credit) };
    });
  }

  /** Caisse : apports et prélèvements (vers le coffre ou la banque), écarts de clôture. */
  private cashEntries(storeId: string, r: Record<AccountRole, string>, opts: { from?: string; to?: string }): Entry[] {
    const ops = this.db
      .prepare(
        `SELECT o.id, o.type, o.amount, o.reason, date(o.at, 'localtime') AS d, g.name AS register
         FROM cash_operations o JOIN cash_sessions cs ON cs.id = o.session_id JOIN registers g ON g.id = cs.register_id
         WHERE cs.store_id = ? AND NOT EXISTS (SELECT 1 FROM central_cash_movements m WHERE m.cash_operation_id = o.id)`,
      )
      .all(storeId) as { id: string; type: 'IN' | 'OUT'; amount: number; reason: string; d: string; register: string }[];
    const closings = this.db
      .prepare(
        `SELECT cs.z_number, cs.difference, date(cs.closed_at, 'localtime') AS d, g.name AS register
         FROM cash_sessions cs JOIN registers g ON g.id = cs.register_id
         WHERE cs.store_id = ? AND cs.status = 'closed' AND cs.difference IS NOT NULL AND cs.difference <> 0`,
      )
      .all(storeId) as { z_number: number; difference: number; d: string; register: string }[];
    const out: Entry[] = [];
    for (const o of ops.filter((x) => inRange(x.d, opts.from, opts.to))) {
      const label = `${o.type === 'IN' ? 'Apport' : 'Prélèvement'} ${o.register} : ${o.reason}`;
      const sign = o.type === 'IN' ? 1 : -1;
      out.push({
        journal: 'CA',
        date: o.d,
        ref: o.type === 'IN' ? 'APPORT' : 'PRELEV',
        label,
        source: 'auto',
        lines: [side(r.cash, sign * o.amount, label), side(r.transfer, -sign * o.amount, label)],
      });
    }
    for (const c of closings.filter((x) => inRange(x.d, opts.from, opts.to))) {
      const label = `${c.difference < 0 ? 'Manquant' : 'Excédent'} de caisse ${c.register}, Z${c.z_number}`;
      out.push({
        journal: 'CA',
        date: c.d,
        ref: `Z${c.z_number}`,
        label,
        source: 'auto',
        lines: [side(r.cash, c.difference, label), side(c.difference < 0 ? r.cash_short : r.cash_over, -c.difference, label)],
      });
    }
    return out;
  }

  /**
   * Caisse centrale : versements des caisses et fonds remis (virements de fonds
   * par le 585, comme le veut le SYSCOHADA), apports et sorties au bureau.
   */
  private centralEntries(storeId: string, r: Record<AccountRole, string>, opts: { from?: string; to?: string }): Entry[] {
    const rows = this.db
      .prepare(
        `SELECT m.number, m.kind, m.nature, m.amount, m.label, date(m.at, 'localtime') AS d FROM central_cash_movements m WHERE m.store_id = ? ORDER BY m.at`,
      )
      .all(storeId) as { number: string; kind: 'DEPOSIT' | 'FLOAT' | 'IN' | 'OUT'; nature: string; amount: number; label: string; d: string }[];
    return rows
      .filter((m) => inRange(m.d, opts.from, opts.to))
      .map((m) => {
        // Sens de la centrale : + elle reçoit, - elle donne. La contrepartie dépend de la nature.
        const sign = m.kind === 'DEPOSIT' || m.kind === 'IN' ? 1 : -1;
        const other = m.nature === 'register' ? r.cash : m.nature === 'bank' ? r.bank : m.nature === 'owner' ? r.owner : r.transfer;
        const viaTransfer = m.nature === 'register' || m.nature === 'bank';
        const lines = viaTransfer
          ? [side(r.central_cash, sign * m.amount, m.label), side(r.transfer, -sign * m.amount, m.label), side(r.transfer, sign * m.amount, m.label), side(other, -sign * m.amount, m.label)]
          : [side(r.central_cash, sign * m.amount, m.label), side(other, -sign * m.amount, m.label)];
        return { journal: m.nature === 'bank' ? ('BQ' as const) : ('CA' as const), date: m.d, ref: m.number, label: m.label, source: 'auto' as const, lines };
      });
  }

  private customerPaymentEntries(storeId: string, r: Record<AccountRole, string>, opts: { from?: string; to?: string }): Entry[] {
    const rows = this.db
      .prepare(
        `SELECT p.number, p.method, p.amount, p.reference, p.from_central, date(p.paid_at, 'localtime') AS d, c.code, c.name
         FROM customer_payments p JOIN customers c ON c.id = p.customer_id WHERE p.store_id = ?`,
      )
      .all(storeId) as { number: string; method: string; amount: number; reference: string | null; from_central: number; d: string; code: string; name: string }[];
    return rows
      .filter((p) => inRange(p.d, opts.from, opts.to))
      .map((p) => {
        const label = `Règlement ${p.name}${p.reference ? ` (${p.reference})` : ''}`;
        return {
          journal: METHOD_JOURNAL(p.method),
          date: p.d,
          ref: p.number,
          label,
          source: 'auto' as const,
          lines: [side(p.from_central ? r.central_cash : r[METHOD_ROLE[p.method] ?? 'bank'], p.amount, label), side(r.customers, -p.amount, label, { code: p.code, name: p.name })],
        };
      });
  }

  private purchaseEntries(storeId: string, r: Record<AccountRole, string>, opts: { from?: string; to?: string }): Entry[] {
    const rows = this.db
      .prepare(
        `SELECT i.number, i.kind, i.supplier_number, i.invoice_date AS d, i.total_ht, i.total_tva, i.total_ttc, f.code, f.name
         FROM supplier_invoices i JOIN suppliers f ON f.id = i.supplier_id WHERE i.store_id = ?`,
      )
      .all(storeId) as { number: string; kind: 'invoice' | 'credit_note'; supplier_number: string; d: string; total_ht: number; total_tva: number; total_ttc: number; code: string; name: string }[];
    return rows
      .filter((i) => inRange(i.d, opts.from, opts.to))
      .map((i) => {
        const sign = i.kind === 'invoice' ? 1 : -1;
        const label = `${i.kind === 'invoice' ? 'Facture' : 'Avoir'} ${i.name} n° ${i.supplier_number}`;
        return {
          journal: 'AC' as const,
          date: i.d,
          ref: i.number,
          label,
          source: 'auto' as const,
          lines: [
            side(r.purchases, sign * i.total_ht, label),
            side(r.vat_deductible, sign * i.total_tva, label),
            side(r.suppliers, -sign * i.total_ttc, label, { code: i.code, name: i.name }),
          ].filter((l) => l.debit || l.credit),
        };
      });
  }

  private supplierPaymentEntries(storeId: string, r: Record<AccountRole, string>, opts: { from?: string; to?: string }): Entry[] {
    const rows = this.db
      .prepare(
        `SELECT p.method, p.amount, p.reference, p.from_central, date(p.paid_at, 'localtime') AS d, i.number, i.kind, f.code, f.name
         FROM supplier_payments p JOIN supplier_invoices i ON i.id = p.invoice_id JOIN suppliers f ON f.id = p.supplier_id
         WHERE p.store_id = ?`,
      )
      .all(storeId) as { method: string; amount: number; reference: string | null; from_central: number; d: string; number: string; kind: string; code: string; name: string }[];
    return rows
      .filter((p) => inRange(p.d, opts.from, opts.to))
      .map((p) => {
        // Un avoir remboursé par le fournisseur fait l'inverse d'un paiement.
        const sign = p.kind === 'invoice' ? 1 : -1;
        const label = `${sign > 0 ? 'Paiement' : 'Remboursement'} ${p.name}, ${p.number}${p.reference ? ` (${p.reference})` : ''}`;
        return {
          journal: METHOD_JOURNAL(p.method),
          date: p.d,
          ref: p.number,
          label,
          source: 'auto' as const,
          lines: [side(r.suppliers, sign * p.amount, label, { code: p.code, name: p.name }), side(p.from_central ? r.central_cash : r[METHOD_ROLE[p.method] ?? 'bank'], -sign * p.amount, label)],
        };
      });
  }

  /** Dépenses : charge HT et TVA récupérable au débit, trésorerie au crédit. */
  private expenseEntries(storeId: string, r: Record<AccountRole, string>, opts: { from?: string; to?: string }): Entry[] {
    const rows = this.db
      .prepare(
        `SELECT e.number, e.expense_date AS d, e.label, e.beneficiary, e.amount, e.vat, e.method, e.reference, e.account_id, e.from_central
         FROM expenses e WHERE e.store_id = @storeId AND e.status = 'active'
         AND (@from IS NULL OR e.expense_date >= @from) AND (@to IS NULL OR e.expense_date <= @to)`,
      )
      .all({ storeId, from: opts.from ?? null, to: opts.to ?? null }) as {
      number: string;
      d: string;
      label: string;
      beneficiary: string | null;
      amount: number;
      vat: number;
      method: string;
      reference: string | null;
      account_id: string;
      from_central: number;
    }[];
    return rows.map((e) => {
      const label = `${e.label}${e.beneficiary ? `, ${e.beneficiary}` : ''}${e.reference ? ` (${e.reference})` : ''}`;
      return {
        journal: METHOD_JOURNAL(e.method),
        date: e.d,
        ref: e.number,
        label,
        source: 'auto' as const,
        lines: [side(e.account_id, e.amount - e.vat, label), side(r.vat_deductible, e.vat, label), side(e.from_central ? r.central_cash : r[METHOD_ROLE[e.method] ?? 'bank'], -e.amount, label)].filter(
          (l) => l.debit || l.credit,
        ),
      };
    });
  }

  private manualEntries(storeId: string, opts: { from?: string; to?: string }): Entry[] {
    const heads = this.db
      .prepare(
        `SELECT id, number, journal, entry_date, label FROM manual_entries
         WHERE store_id = @storeId AND (@from IS NULL OR entry_date >= @from) AND (@to IS NULL OR entry_date <= @to)`,
      )
      .all({ storeId, from: opts.from ?? null, to: opts.to ?? null }) as { id: string; number: string; journal: JournalCode; entry_date: string; label: string }[];
    const lines = this.db.prepare('SELECT account_id, aux, label, debit, credit FROM manual_entry_lines WHERE entry_id = ? ORDER BY line_no');
    return heads.map((h) => ({
      journal: h.journal,
      date: h.entry_date,
      ref: h.number,
      label: h.label,
      source: 'manual' as const,
      lines: (lines.all(h.id) as { account_id: string; aux: string | null; label: string | null; debit: number; credit: number }[]).map((l) => ({
        account: l.account_id,
        aux: l.aux,
        aux_name: null,
        label: l.label ?? h.label,
        debit: l.debit,
        credit: l.credit,
      })),
    }));
  }

  /** Écriture manuelle (à-nouveaux, frais bancaires, dépôt d'espèces à la banque…). Elle doit être équilibrée. */
  addManualEntry(
    ctx: Context,
    input: { journal: JournalCode; date: string; label: string; lines: { account: string; aux?: string | null; label?: string | null; debit: Fcfa; credit: Fcfa }[] },
  ): Entry {
    if (!['AN', 'OD', 'BQ', 'CA', 'MM'].includes(input.journal)) throw new AppError('Journal non autorisé pour une saisie manuelle', 'INVALID');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) throw new AppError('Date invalide', 'INVALID');
    if (!input.label.trim()) throw new AppError("Le libellé de l'écriture est obligatoire", 'INVALID');
    const lines = input.lines.filter((l) => l.debit || l.credit);
    if (lines.length < 2) throw new AppError('Une écriture a au moins deux lignes', 'INVALID');
    const known = new Set(this.listAccounts(true).map((a) => a.id));
    for (const l of lines) {
      if (!known.has(l.account)) throw new AppError(`Compte inconnu : ${l.account}`, 'INVALID');
      if (!Number.isSafeInteger(l.debit) || !Number.isSafeInteger(l.credit) || l.debit < 0 || l.credit < 0 || (l.debit && l.credit)) {
        throw new AppError('Chaque ligne a soit un débit, soit un crédit, en FCFA entiers', 'INVALID');
      }
    }
    const debit = lines.reduce((t, l) => t + l.debit, 0);
    const credit = lines.reduce((t, l) => t + l.credit, 0);
    if (debit !== credit) throw new AppError(`Écriture déséquilibrée : débit ${debit} ≠ crédit ${credit}`, 'UNBALANCED');
    return this.tx(() => {
      const id = newId();
      const number = `OD-${this.stationPrefix()}-${String(this.nextCounter('manual_entry')).padStart(5, '0')}`;
      this.db
        .prepare('INSERT INTO manual_entries (id, number, store_id, journal, entry_date, label, user_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, number, ctx.storeId, input.journal, input.date, input.label.trim(), ctx.userId, this.now());
      const insert = this.db.prepare(
        'INSERT INTO manual_entry_lines (id, entry_id, line_no, account_id, aux, label, debit, credit) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      );
      lines.forEach((l, i) => insert.run(newId(), id, i + 1, l.account, l.aux?.trim() || null, l.label?.trim() || null, l.debit, l.credit));
      this.enqueue(ctx, 'manual_entry', id, 'upsert', {});
      this.audit(ctx.userId, 'accounting.manual_entry', 'manual_entry', id, { number, debit });
      return this.manualEntries(ctx.storeId, { from: input.date, to: input.date }).find((e) => e.ref === number)!;
    });
  }

  // --- États ------------------------------------------------------------------

  /** Grand livre d'un compte (ou d'une racine : « 41 », « 5 »), avec solde d'ouverture et solde progressif. */
  ledger(storeId: string, opts: { account: string; aux?: string; from?: string; to?: string }) {
    const match = (l: EntryLine) => l.account.startsWith(opts.account) && (!opts.aux || l.aux === opts.aux);
    let opening = 0;
    let balance = 0;
    const rows: { date: string; journal: JournalCode; ref: string; label: string; account: string; aux: string | null; debit: Fcfa; credit: Fcfa; balance: Fcfa }[] = [];
    for (const e of this.entries(storeId, { to: opts.to })) {
      for (const l of e.lines.filter(match)) {
        if (opts.from && e.date < opts.from) {
          opening += l.debit - l.credit;
          balance = opening;
          continue;
        }
        balance += l.debit - l.credit;
        rows.push({ date: e.date, journal: e.journal, ref: e.ref, label: l.label, account: l.account, aux: l.aux, debit: l.debit, credit: l.credit, balance });
      }
    }
    return { opening, rows, closing: balance, debit: rows.reduce((t, x) => t + x.debit, 0), credit: rows.reduce((t, x) => t + x.credit, 0) };
  }

  /** Balance générale : mouvements de la période et soldes, par compte. */
  trialBalance(storeId: string, opts: { from?: string; to?: string } = {}) {
    const labels = new Map(this.listAccounts(true).map((a) => [a.id, a.label]));
    const acc = new Map<string, { opening: number; debit: number; credit: number }>();
    for (const e of this.entries(storeId, { to: opts.to })) {
      for (const l of e.lines) {
        const a = acc.get(l.account) ?? { opening: 0, debit: 0, credit: 0 };
        if (opts.from && e.date < opts.from) a.opening += l.debit - l.credit;
        else {
          a.debit += l.debit;
          a.credit += l.credit;
        }
        acc.set(l.account, a);
      }
    }
    const rows = [...acc.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([account, a]) => ({ account, label: labels.get(account) ?? '', ...a, closing: a.opening + a.debit - a.credit }));
    const sum = (k: 'opening' | 'debit' | 'credit' | 'closing') => rows.reduce((t, r) => t + r[k], 0);
    return { rows, totals: { opening: sum('opening'), debit: sum('debit'), credit: sum('credit'), closing: sum('closing') } };
  }

  /** Soldes de trésorerie (caisse, banque, mobile money) à une date. */
  treasury(storeId: string, to?: string) {
    const r = this.roles();
    const accounts = (['cash', 'central_cash', 'bank', 'card', 'mtn', 'orange', 'transfer'] as AccountRole[]).map((role) => r[role]);
    const tb = this.trialBalance(storeId, { to });
    return accounts.map((id) => {
      const row = tb.rows.find((x) => x.account === id);
      return { account: id, label: this.listAccounts(true).find((a) => a.id === id)?.label ?? id, balance: row?.closing ?? 0 };
    });
  }

  /**
   * Déclaration de TVA du mois : TVA collectée sur les ventes (par taux) moins
   * TVA déductible sur les factures fournisseurs. Positif : TVA à payer ;
   * négatif : crédit de TVA à reporter.
   */
  vatReturn(storeId: string, month: string) {
    if (!/^\d{4}-\d{2}$/.test(month)) throw new AppError('Mois invalide (AAAA-MM)', 'INVALID');
    const byRate = this.db
      .prepare(
        `SELECT l.vat_rate_bp AS rate, SUM(l.total_ttc) AS ttc FROM sale_lines l JOIN sales s ON s.id = l.sale_id
         WHERE s.store_id = ? AND s.status = 'completed' AND strftime('%Y-%m', s.created_at, 'localtime') = ?
         GROUP BY l.vat_rate_bp ORDER BY l.vat_rate_bp DESC`,
      )
      .all(storeId, month) as { rate: number; ttc: number }[];
    const sales = byRate.map((v) => ({ rate: v.rate, ttc: v.ttc, ...splitTtc(v.ttc, v.rate) }));
    // Les tickets portent leur propre arrondi de TVA : c'est lui qui est en comptabilité (4431).
    const booked = this.db
      .prepare(
        `SELECT COALESCE(SUM(total_ht), 0) AS ht, COALESCE(SUM(total_tva), 0) AS tva FROM sales
         WHERE store_id = ? AND status = 'completed' AND strftime('%Y-%m', created_at, 'localtime') = ?`,
      )
      .get(storeId, month) as { ht: number; tva: number };
    const purchases = this.db
      .prepare(
        `SELECT COALESCE(SUM(CASE WHEN kind = 'invoice' THEN total_ht ELSE -total_ht END), 0) AS ht,
                COALESCE(SUM(CASE WHEN kind = 'invoice' THEN total_tva ELSE -total_tva END), 0) AS tva,
                COUNT(*) AS n
         FROM supplier_invoices WHERE store_id = ? AND substr(invoice_date, 1, 7) = ?`,
      )
      .get(storeId, month) as { ht: number; tva: number; n: number };
    const expenses = this.db
      .prepare(
        `SELECT COALESCE(SUM(amount - vat), 0) AS ht, COALESCE(SUM(vat), 0) AS tva, COUNT(CASE WHEN vat > 0 THEN 1 END) AS n FROM expenses
         WHERE store_id = ? AND status = 'active' AND substr(expense_date, 1, 7) = ?`,
      )
      .get(storeId, month) as { ht: number; tva: number; n: number };
    const previousCredit = this.carriedVatCredit(storeId, month);
    const deductible = purchases.tva + expenses.tva;
    const due = booked.tva - deductible - previousCredit;
    return {
      month,
      sales,
      turnoverHt: booked.ht,
      exemptHt: sales.filter((s) => s.rate === 0).reduce((t, s) => t + s.ht, 0),
      collected: booked.tva,
      deductible,
      purchasesHt: purchases.ht,
      purchasesVat: purchases.tva,
      invoiceCount: purchases.n,
      expensesHt: expenses.ht,
      expensesVat: expenses.tva,
      expenseCount: expenses.n,
      previousCredit,
      due: Math.max(0, due),
      credit: Math.max(0, -due),
    };
  }

  /** Crédit de TVA reporté des mois précédents (calculé de proche en proche depuis le premier mois d'activité). */
  private carriedVatCredit(storeId: string, month: string): Fcfa {
    const first = this.db
      .prepare(
        `SELECT MIN(m) FROM (SELECT strftime('%Y-%m', created_at, 'localtime') AS m FROM sales WHERE store_id = ?
         UNION ALL SELECT substr(invoice_date, 1, 7) FROM supplier_invoices WHERE store_id = ?
         UNION ALL SELECT substr(expense_date, 1, 7) FROM expenses WHERE store_id = ? AND status = 'active')`,
      )
      .pluck()
      .get(storeId, storeId, storeId) as string | null;
    if (!first || first >= month) return 0;
    let credit = 0;
    let [y, m] = first.split('-').map(Number) as [number, number];
    for (;;) {
      const key = `${y}-${String(m).padStart(2, '0')}`;
      if (key >= month) break;
      const v = this.db
        .prepare(
          `SELECT (SELECT COALESCE(SUM(total_tva), 0) FROM sales WHERE store_id = @s AND status = 'completed' AND strftime('%Y-%m', created_at, 'localtime') = @k)
                - (SELECT COALESCE(SUM(CASE WHEN kind = 'invoice' THEN total_tva ELSE -total_tva END), 0) FROM supplier_invoices WHERE store_id = @s AND substr(invoice_date, 1, 7) = @k)
                - (SELECT COALESCE(SUM(vat), 0) FROM expenses WHERE store_id = @s AND status = 'active' AND substr(expense_date, 1, 7) = @k)`,
        )
        .pluck()
        .get({ s: storeId, k: key }) as number;
      credit = Math.max(0, credit - v);
      m += 1;
      if (m > 12) {
        m = 1;
        y += 1;
      }
    }
    return credit;
  }

  /** Export des écritures pour le cabinet comptable (CSV, séparateur point-virgule). */
  exportCsv(storeId: string, opts: { from?: string; to?: string }): string {
    const esc = (v: string) => (/[;"\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    const out = ['Journal;Date;Pièce;Compte;Tiers;Libellé;Débit;Crédit'];
    for (const e of this.entries(storeId, opts)) {
      for (const l of e.lines) {
        out.push([e.journal, e.date.split('-').reverse().join('/'), e.ref, l.account, l.aux ?? '', l.label, String(l.debit || ''), String(l.credit || '')].map(esc).join(';'));
      }
    }
    return `${out.join('\r\n')}\r\n`;
  }
}
