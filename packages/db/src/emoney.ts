import { ELECTRONIC_METHODS, type Fcfa, PAYMENT_METHODS, type PaymentMethod, parseStoreSettings, registerMethods } from '@superette/core';
import { type User, emoneyRegisterIds } from './admin';
import { AppError, Base, type Context, newId } from './util';

/**
 * Mouvement d'une caisse électronique hors ventes :
 * - deposit : versement de la recette d'un caissier vers la caisse électronique centrale ;
 * - register : transfert entre deux caisses électroniques ;
 * - bank : dépôt sur le compte en banque, ou retrait vers le compte Mobile Money ;
 * - owner : apport ou retrait de l'exploitant ;
 * - other : autre (solde de départ, frais de l'opérateur…).
 */
export type EmoneyNature = 'deposit' | 'register' | 'bank' | 'owner' | 'other';
export type EmoneyMethod = (typeof ELECTRONIC_METHODS)[number];

export const EMONEY_NATURES: Record<'IN' | 'OUT', Partial<Record<EmoneyNature, string>>> = {
  IN: { register: "Transfert depuis une autre caisse électronique", bank: 'Retrait de la banque', owner: "Apport de l'exploitant", other: 'Autre entrée (solde de départ…)' },
  OUT: { register: 'Transfert vers une autre caisse électronique', bank: 'Dépôt à la banque', owner: "Retrait de l'exploitant", other: "Autre sortie (frais de l'opérateur…)" },
};

export interface EmoneyMovement {
  id: string;
  number: string;
  store_id: string;
  register_id: string;
  session_id: string | null;
  method: EmoneyMethod;
  direction: 'IN' | 'OUT';
  nature: EmoneyNature;
  amount: Fcfa;
  reference: string | null;
  label: string;
  other_register_id: string | null;
  counterpart_id: string | null;
  user_id: string | null;
  at: string;
}

/** Ligne du journal d'une caisse électronique : entrée ou sortie, par moyen de paiement. */
export interface EmoneyRow {
  source: 'sale' | 'refund' | 'customer_payment' | 'expense' | 'supplier_payment' | 'rebate' | 'movement' | 'entry';
  /** Nature d'une pièce d'« Encaisser » ou « Décaisser » (avance, salaire, autre…). */
  kind?: string | null;
  id: string;
  at: string;
  number: string;
  nature: string;
  label: string;
  party: string | null;
  method: PaymentMethod;
  method_label: string;
  reference: string | null;
  amount: Fcfa;
  user_name: string | null;
  user_id: string | null;
  /** Versement de clôture vers la centrale : fait après le relevé, il ne compte pas dans l'attendu. */
  closing?: boolean;
}

/** Ligne du livre d'une caisse électronique sans journée (la centrale) : montant signé et solde du moyen après l'opération. */
export interface EmoneyLedgerRow extends EmoneyRow {
  /** Positif : entrée ; négatif : sortie. */
  signed: Fcfa;
  balance: Fcfa;
}

/** Natures des pièces d'« Encaisser » et « Décaisser » qui ne sont ni vente, ni règlement, ni dépense. */
export type EntryKind = 'staff_advance' | 'staff_salary' | 'staff_repayment' | 'customer_refund' | 'container_deposit' | 'container_refund' | 'agent_in' | 'agent_out' | 'other';
export const ENTRY_KINDS: Record<EntryKind, string> = {
  staff_advance: 'Avance au personnel',
  staff_salary: 'Salaire',
  staff_repayment: 'Remboursement du personnel',
  customer_refund: 'Remboursement client',
  container_deposit: 'Consigne encaissée',
  container_refund: 'Consigne rendue',
  agent_in: 'Point Mobile Money (entrée)',
  agent_out: 'Point Mobile Money (sortie)',
  other: 'Autre',
};

const NATURE_LABEL: Record<EmoneyNature, string> = {
  deposit: 'Versement',
  register: 'Transfert',
  bank: 'Banque',
  owner: 'Exploitant',
  other: 'Autre',
};

export const isEmoney = (m: string): m is EmoneyMethod => (ELECTRONIC_METHODS as readonly string[]).includes(m);
/** Moyens avec lesquels on paie depuis un compte (le terminal de carte ne fait qu'encaisser). */
export const EMONEY_PAYOUT_METHODS = ['MTN_MOMO', 'ORANGE_MONEY'] as const;
export const isPayout = (m: string): boolean => (EMONEY_PAYOUT_METHODS as readonly string[]).includes(m);
const zero = (): Record<EmoneyMethod, Fcfa> => ({ MTN_MOMO: 0, ORANGE_MONEY: 0, CARD: 0 });

/**
 * Caisses électroniques : ce qui en sort (dépenses, fournisseurs, remboursements,
 * versements), leur solde d'un jour à l'autre et la caisse électronique centrale.
 * Comme la caisse centrale espèces, les soldes se recalculent à partir des pièces.
 */
export class EmoneyService extends Base {
  private settings(storeId: string) {
    const raw = this.db.prepare('SELECT settings FROM stores WHERE id = ?').pluck().get(storeId) as string | null | undefined;
    return parseStoreSettings(raw);
  }

  /** Mode du magasin et sa caisse électronique centrale (null : pas encore choisie, ou caisses indépendantes). */
  mode(storeId: string): { mode: 'central' | 'independent'; centralId: string | null; centralName: string | null } {
    const s = this.settings(storeId);
    const centralId = s.emoneyMode === 'central' && s.emoneyCentralRegisterId ? s.emoneyCentralRegisterId : null;
    const centralName = centralId ? ((this.db.prepare('SELECT name FROM registers WHERE id = ?').pluck().get(centralId) as string | undefined) ?? null) : null;
    return { mode: s.emoneyMode, centralId: centralName ? centralId : null, centralName };
  }

  private register(id: string): { id: string; store_id: string; name: string; kind: string } {
    const r = this.db.prepare('SELECT id, store_id, name, kind FROM registers WHERE id = ?').get(id) as { id: string; store_id: string; name: string; kind: string } | undefined;
    if (!r) throw new AppError('Caisse introuvable', 'NOT_FOUND');
    return r;
  }

  /** Caisse électronique de l'utilisateur qui reçoit ce moyen (MoMo, OM), et sa journée ouverte. */
  userRegister(userId: string, method: string): { registerId: string | null; sessionId: string | null; any: boolean } {
    const u = this.db.prepare('SELECT emoney_register_id, emoney_register_ids FROM users WHERE id = ?').get(userId) as Pick<User, 'emoney_register_id' | 'emoney_register_ids'> | undefined;
    const ids = u ? emoneyRegisterIds(u) : [];
    const methodsOf = (id: string) => registerMethods(this.db.prepare('SELECT methods FROM registers WHERE id = ?').pluck().get(id) as string | null) as string[];
    const id = ids.find((r) => methodsOf(r).includes(method)) ?? null;
    return { registerId: id, sessionId: id ? this.openSessionId(id) : null, any: ids.length > 0 };
  }

  /**
   * Une sortie déjà comptée dans le solde de départ d'une journée ouverte depuis
   * ne peut plus être annulée : le solde de la caisse ne collerait plus.
   */
  assertNotCarried(registerId: string | null, sessionId: string | null, at: string): void {
    if (!registerId || sessionId) return;
    const later = this.db.prepare('SELECT 1 FROM cash_sessions WHERE register_id = ? AND opened_at > ?').pluck().get(registerId, at);
    if (later) throw new AppError('Une journée de cette caisse électronique a été ouverte depuis : la sortie ne peut plus être annulée', 'SESSION_CLOSED');
  }

  /** Journée ouverte d'une caisse (null : fermée). */
  openSessionId(registerId: string): string | null {
    return (this.db.prepare("SELECT id FROM cash_sessions WHERE register_id = ? AND status = 'open'").pluck().get(registerId) as string | undefined) ?? null;
  }

  /**
   * Caisse électronique d'où sort un paiement par Mobile Money ou carte : celle
   * choisie, sinon la centrale du magasin. Renvoie aussi sa journée ouverte.
   */
  source(storeId: string, method: string, registerId?: string | null): { registerId: string | null; sessionId: string | null } {
    if (!isPayout(method)) return { registerId: null, sessionId: null };
    const id = registerId || this.mode(storeId).centralId;
    if (!id) return { registerId: null, sessionId: null };
    const r = this.register(id);
    if (r.kind !== 'electronic' || r.store_id !== storeId) throw new AppError(`${r.name} n'est pas une caisse électronique de ce magasin`, 'INVALID');
    return { registerId: id, sessionId: this.openSessionId(id) };
  }

  /**
   * Journée ouverte où se fait un paiement saisi à la caisse (« Encaisser »,
   * « Décaisser ») : espèces pour une caisse espèces, MoMo/OM pour une caisse
   * électronique. Renvoie sa caisse et sa journée.
   */
  openSession(storeId: string, sessionId: string, method: string): { registerId: string; sessionId: string } {
    const se = this.db
      .prepare('SELECT s.id, s.status, s.store_id, r.id AS register_id, r.kind, r.name FROM cash_sessions s JOIN registers r ON r.id = s.register_id WHERE s.id = ?')
      .get(sessionId) as { id: string; status: string; store_id: string; register_id: string; kind: string; name: string } | undefined;
    if (!se || se.store_id !== storeId) throw new AppError('Journée de caisse introuvable', 'NOT_FOUND');
    if (se.status !== 'open') throw new AppError(`La journée de ${se.name} est clôturée`, 'SESSION_CLOSED');
    if (se.kind === 'cash' ? method !== 'CASH' : se.kind !== 'electronic' || !isPayout(method)) {
      throw new AppError(se.kind === 'cash' ? `${se.name} est une caisse espèces : choisissez Espèces` : `${se.name} paie par MTN MoMo ou Orange Money`, 'INVALID');
    }
    return { registerId: se.register_id, sessionId: se.id };
  }

  // --- Journal d'une journée ------------------------------------------------------

  /** Entrées d'une journée électronique : ventes, règlements clients et mouvements reçus. */
  sessionEntries(sessionId: string): EmoneyRow[] {
    const sales = this.db
      .prepare(
        `SELECT s.id, s.created_at AS at, s.number, p.method, p.amount, p.reference, COALESCE(c.name, s.client_name) AS party, u.name AS user_name, s.user_id
         FROM sale_payments p JOIN sales s ON s.id = p.sale_id LEFT JOIN customers c ON c.id = s.customer_id LEFT JOIN users u ON u.id = s.user_id
         WHERE p.session_id = ? AND p.amount > 0 AND s.status = 'completed' AND p.method <> 'CASH' ORDER BY s.created_at`,
      )
      .all(sessionId) as { id: string; at: string; number: string; method: PaymentMethod; amount: number; reference: string | null; party: string | null; user_name: string | null; user_id: string }[];
    const receipts = this.db
      .prepare(
        `SELECT p.id, p.paid_at AS at, p.number, p.method, p.amount, p.reference, c.name AS party, u.name AS user_name, p.user_id
         FROM customer_payments p JOIN customers c ON c.id = p.customer_id LEFT JOIN users u ON u.id = p.user_id
         WHERE p.session_id = ? AND p.method <> 'CASH' ORDER BY p.paid_at`,
      )
      .all(sessionId) as { id: string; at: string; number: string; method: PaymentMethod; amount: number; reference: string | null; party: string; user_name: string | null; user_id: string | null }[];
    const moves = this.movements({ sessionId, direction: 'IN' });
    return [
      ...sales.map((x) => this.row('sale', x, 'Vente', `Ticket ${x.number}`)),
      ...receipts.map((x) => this.row('customer_payment', x, 'Règlement client', `Reçu ${x.number}`)),
      ...moves.map((m) => this.moveRow(m)),
      ...this.received({ sessionId }),
    ].sort((a, b) => a.at.localeCompare(b.at));
  }

  /** Pièces de trésorerie (« Encaisser », « Décaisser ») d'une journée ou d'une caisse hors journée, dans un sens. */
  private pieces(where: { sessionId: string } | { registerId: string; after: string }, direction: 'IN' | 'OUT'): EmoneyRow[] {
    const bySession = 'sessionId' in where;
    const rows = this.db
      .prepare(
        `SELECT x.id, x.at, x.number, x.kind, x.method, x.amount, COALESCE(x.reference, x.piece) AS reference, x.label,
                COALESCE(s.name, c.name, x.party) AS party, u.name AS user_name, x.user_id
         FROM treasury_entries x LEFT JOIN staff s ON s.id = x.staff_id LEFT JOIN customers c ON c.id = x.customer_id LEFT JOIN users u ON u.id = x.user_id
         WHERE ${bySession ? 'x.session_id = @sessionId' : 'x.register_id = @registerId AND x.session_id IS NULL AND x.at > @after'}
           AND x.status = 'active' AND x.direction = @direction AND x.method <> 'CASH'`,
      )
      .all({ ...where, direction }) as { id: string; at: string; number: string; kind: string; method: PaymentMethod; amount: number; reference: string | null; label: string; party: string | null; user_name: string | null; user_id: string | null }[];
    return rows.map((x) => ({ ...this.row('entry', x, ENTRY_KINDS[x.kind as EntryKind] ?? 'Autre', `${x.number} ${x.label}`), kind: x.kind }));
  }

  /** Entrées hors ventes : avoirs remboursés par un fournisseur et pièces d'« Encaisser ». */
  private received(where: { sessionId: string } | { registerId: string; after: string }): EmoneyRow[] {
    const bySession = 'sessionId' in where;
    const suppliers = this.db
      .prepare(
        `SELECT x.id, x.paid_at AS at, i.number, i.supplier_number, x.method, x.amount, x.reference, f.name AS party, u.name AS user_name, x.user_id
         FROM supplier_payments x JOIN supplier_invoices i ON i.id = x.invoice_id JOIN suppliers f ON f.id = x.supplier_id LEFT JOIN users u ON u.id = x.user_id
         WHERE ${bySession ? 'x.session_id = @sessionId' : 'x.register_id = @registerId AND x.session_id IS NULL AND x.paid_at > @after'} AND i.kind = 'credit_note' AND x.method <> 'CASH'`,
      )
      .all(where) as { id: string; at: string; number: string; supplier_number: string; method: PaymentMethod; amount: number; reference: string | null; party: string; user_name: string | null; user_id: string | null }[];
    return [...suppliers.map((x) => this.row('supplier_payment', x, 'Fournisseur', `Avoir ${x.supplier_number} remboursé`)), ...this.pieces(where, 'IN')];
  }

  /** Sorties d'une journée électronique : remboursements, dépenses, fournisseurs, transferts et versement de clôture. */
  sessionExits(sessionId: string): EmoneyRow[] {
    const refunds = this.db
      .prepare(
        `SELECT s.id, s.created_at AS at, s.number, p.method, -p.amount AS amount, p.reference, COALESCE(c.name, s.client_name) AS party, u.name AS user_name, s.user_id
         FROM sale_payments p JOIN sales s ON s.id = p.sale_id LEFT JOIN customers c ON c.id = s.customer_id LEFT JOIN users u ON u.id = s.user_id
         WHERE p.session_id = ? AND p.amount < 0 AND s.status = 'completed' AND p.method <> 'CASH' ORDER BY s.created_at`,
      )
      .all(sessionId) as { id: string; at: string; number: string; method: PaymentMethod; amount: number; reference: string | null; party: string | null; user_name: string | null; user_id: string }[];
    return [...refunds.map((x) => this.row('refund', x, 'Remboursement', `Retour ${x.number}`)), ...this.paidOut({ sessionId })].sort((a, b) => a.at.localeCompare(b.at));
  }

  /**
   * Dépenses, règlements fournisseurs et mouvements sortis d'une journée ou
   * d'une caisse (hors journée), sans les remboursements de retours.
   */
  private paidOut(where: { sessionId: string } | { registerId: string; after: string }): EmoneyRow[] {
    const bySession = 'sessionId' in where;
    const cond = bySession ? 'x.session_id = @sessionId' : 'x.register_id = @registerId AND x.session_id IS NULL';
    const params = bySession ? { sessionId: where.sessionId } : { registerId: where.registerId, after: where.after };
    const expenses = this.db
      .prepare(
        `SELECT x.id, x.created_at AS at, x.number, x.method, x.amount, x.reference, x.label, x.beneficiary AS party, u.name AS user_name, x.user_id
         FROM expenses x LEFT JOIN users u ON u.id = x.user_id
         WHERE ${cond} AND x.status = 'active' AND x.method <> 'CASH' ${bySession ? '' : 'AND x.created_at > @after'}`,
      )
      .all(params) as { id: string; at: string; number: string; method: PaymentMethod; amount: number; reference: string | null; label: string; party: string | null; user_name: string | null; user_id: string | null }[];
    const suppliers = this.db
      .prepare(
        `SELECT x.id, x.paid_at AS at, i.number, x.method, x.amount, x.reference, f.name AS party, u.name AS user_name, x.user_id
         FROM supplier_payments x JOIN supplier_invoices i ON i.id = x.invoice_id JOIN suppliers f ON f.id = x.supplier_id LEFT JOIN users u ON u.id = x.user_id
         WHERE ${cond} AND i.kind = 'invoice' AND x.method <> 'CASH' ${bySession ? '' : 'AND x.paid_at > @after'}`,
      )
      .all(params) as { id: string; at: string; number: string; method: PaymentMethod; amount: number; reference: string | null; party: string; user_name: string | null; user_id: string | null }[];
    const rebates = this.db
      .prepare(
        `SELECT x.id, x.at, x.number, x.method, x.amount, x.reference, c.name AS party, u.name AS user_name, x.user_id
         FROM rebate_entries x JOIN customers c ON c.id = x.customer_id LEFT JOIN users u ON u.id = x.user_id
         WHERE ${cond} AND x.kind = 'cash' AND x.method <> 'CASH' ${bySession ? '' : 'AND x.at > @after'}`,
      )
      .all(params) as { id: string; at: string; number: string; method: PaymentMethod; amount: number; reference: string | null; party: string; user_name: string | null; user_id: string | null }[];
    const moves = bySession
      ? this.movements({ sessionId: where.sessionId, direction: 'OUT' })
      : this.movements({ registerId: where.registerId, after: where.after, outsideSession: true, direction: 'OUT' });
    return [
      ...expenses.map((x) => this.row('expense', x, 'Dépense', `${x.number} ${x.label}`)),
      ...suppliers.map((x) => this.row('supplier_payment', x, 'Fournisseur', `Facture ${x.number}`)),
      ...rebates.map((x) => this.row('rebate', x, 'Ristourne', `Bon ${x.number}`)),
      ...this.pieces(where, 'OUT'),
      ...moves.map((m) => this.moveRow(m)),
    ];
  }

  private row(
    source: EmoneyRow['source'],
    x: { id: string; at: string; number: string; method: PaymentMethod; amount: number; reference: string | null; party: string | null; user_name: string | null; user_id: string | null },
    nature: string,
    label: string,
  ): EmoneyRow {
    return { source, id: x.id, at: x.at, number: x.number, nature, label, party: x.party, method: x.method, method_label: PAYMENT_METHODS[x.method] ?? x.method, reference: x.reference, amount: x.amount, user_name: x.user_name, user_id: x.user_id };
  }

  private moveRow(m: EmoneyMovement & { user_name: string | null; other_name: string | null }): EmoneyRow {
    return {
      source: 'movement',
      id: m.id,
      at: m.at,
      number: m.number,
      nature: NATURE_LABEL[m.nature],
      label: m.label,
      party: m.other_name,
      method: m.method,
      method_label: PAYMENT_METHODS[m.method],
      reference: m.reference,
      amount: m.amount,
      user_name: m.user_name,
      user_id: m.user_id,
      ...(m.nature === 'deposit' && m.direction === 'OUT' ? { closing: true } : {}),
    };
  }

  movements(opts: { sessionId?: string; registerId?: string; after?: string; outsideSession?: boolean; direction?: 'IN' | 'OUT' }): (EmoneyMovement & { user_name: string | null; other_name: string | null })[] {
    return this.db
      .prepare(
        `SELECT m.*, u.name AS user_name, r.name AS other_name FROM emoney_movements m LEFT JOIN users u ON u.id = m.user_id LEFT JOIN registers r ON r.id = m.other_register_id
         WHERE (@session IS NULL OR m.session_id = @session) AND (@register IS NULL OR m.register_id = @register)
           AND (@after IS NULL OR m.at > @after) AND (@outside = 0 OR m.session_id IS NULL) AND (@direction IS NULL OR m.direction = @direction)
         ORDER BY m.at`,
      )
      .all({
        session: opts.sessionId ?? null,
        register: opts.registerId ?? null,
        after: opts.after ?? null,
        outside: opts.outsideSession ? 1 : 0,
        direction: opts.direction ?? null,
      }) as (EmoneyMovement & { user_name: string | null; other_name: string | null })[];
  }

  /**
   * Ce qui change l'attendu d'une journée en plus des ventes : sorties (dépenses,
   * fournisseurs, transferts) et entrées de mouvements, par moyen. Le versement de
   * clôture n'y est pas : il se fait après le relevé.
   */
  sessionAdjustments(sessionId: string): { outflows: Record<EmoneyMethod, Fcfa>; inflows: Record<EmoneyMethod, Fcfa> } {
    const outflows = zero();
    const inflows = zero();
    for (const r of this.paidOut({ sessionId })) if (isEmoney(r.method) && !r.closing) outflows[r.method] += r.amount;
    for (const m of this.movements({ sessionId, direction: 'IN' })) inflows[m.method] += m.amount;
    for (const r of this.received({ sessionId })) if (isEmoney(r.method)) inflows[r.method] += r.amount;
    return { outflows, inflows };
  }

  // --- Soldes ---------------------------------------------------------------------

  /**
   * Solde d'une caisse électronique hors journée ouverte : le reste laissé à sa
   * dernière clôture, plus ce qui y est entré ou sorti depuis sans journée
   * (versements reçus, dépenses et fournisseurs payés au bureau…). C'est le solde
   * de départ de sa prochaine journée, et le solde de la centrale.
   */
  balance(registerId: string): Record<EmoneyMethod, Fcfa> {
    const last = this.db
      .prepare("SELECT closed_at, counted_detail FROM cash_sessions WHERE register_id = ? AND status = 'closed' ORDER BY closed_at DESC LIMIT 1")
      .get(registerId) as { closed_at: string; counted_detail: string | null } | undefined;
    const out = zero();
    if (last?.counted_detail) {
      // Clôture d'avant la 0.33 : pas de reste enregistré, le solde relevé reste sur le compte.
      const detail = JSON.parse(last.counted_detail) as { left?: Record<string, number>; declared?: Record<string, number> };
      const left = detail.left ?? detail.declared ?? {};
      for (const [m, v] of Object.entries(left)) if (isPayout(m)) out[m as EmoneyMethod] += v;
    }
    const after = last?.closed_at ?? '';
    for (const m of this.movements({ registerId, after, outsideSession: true, direction: 'IN' })) out[m.method] += m.amount;
    for (const r of this.received({ registerId, after })) if (isEmoney(r.method)) out[r.method] += r.amount;
    for (const r of this.paidOut({ registerId, after })) if (isEmoney(r.method)) out[r.method] -= r.amount;
    return out;
  }

  /** Livre de la caisse électronique centrale (ou de toute caisse hors journée) : mouvements, dépenses et fournisseurs, avec le solde par moyen. */
  ledger(registerId: string, opts: { from?: string; to?: string } = {}): { rows: EmoneyLedgerRow[]; balance: Record<EmoneyMethod, Fcfa> } {
    const entries = [...this.movements({ registerId, outsideSession: true, direction: 'IN' }).map((m) => this.moveRow(m)), ...this.received({ registerId, after: '' })].map((r) => ({
      ...r,
      signed: r.amount,
    }));
    const exits = this.paidOut({ registerId, after: '' }).map((r) => ({ ...r, signed: -r.amount }));
    const running = zero();
    const rows = [...entries, ...exits]
      .sort((a, b) => a.at.localeCompare(b.at))
      .map((r) => {
        if (isEmoney(r.method)) running[r.method] += r.signed;
        return { ...r, balance: isEmoney(r.method) ? running[r.method] : 0 };
      });
    const day = (at: string) => at.slice(0, 10);
    return {
      rows: rows.filter((r) => (!opts.from || day(r.at) >= opts.from) && (!opts.to || day(r.at) <= opts.to)).reverse(),
      balance: this.balance(registerId),
    };
  }

  // --- Mouvements -----------------------------------------------------------------

  private insert(ctx: Context, m: Omit<EmoneyMovement, 'id' | 'number' | 'store_id' | 'user_id' | 'at'>, number?: string, id?: string): EmoneyMovement {
    const row: EmoneyMovement = {
      id: id ?? newId(),
      number: number ?? `VE-${this.stationPrefix()}-${String(this.nextCounter('emoney.number')).padStart(5, '0')}`,
      store_id: ctx.storeId,
      user_id: ctx.userId,
      at: this.now(),
      ...m,
    };
    this.db
      .prepare(
        `INSERT INTO emoney_movements (id, number, store_id, register_id, session_id, method, direction, nature, amount, reference, label, other_register_id, counterpart_id, user_id, at)
         VALUES (@id, @number, @store_id, @register_id, @session_id, @method, @direction, @nature, @amount, @reference, @label, @other_register_id, @counterpart_id, @user_id, @at)`,
      )
      .run(row);
    this.enqueue(ctx, 'emoney_movement', row.id, 'upsert', row);
    return row;
  }

  /**
   * Transfert d'une caisse électronique à une autre (versement de recette ou
   * transfert) : une sortie et une entrée de même numéro. À appeler dans une transaction.
   */
  transfer(
    ctx: Context,
    input: { fromId: string; toId: string; method: EmoneyMethod; amount: Fcfa; reference: string; nature: 'deposit' | 'register'; label: string; fromSessionId?: string | null; number?: string | null },
  ): EmoneyMovement {
    if (input.fromId === input.toId) throw new AppError('Choisissez deux caisses différentes', 'INVALID');
    const outId = newId();
    const inId = newId();
    // Un versement MTN et Orange de la même clôture partage un seul bon.
    const number = input.number ?? `VE-${this.stationPrefix()}-${String(this.nextCounter('emoney.number')).padStart(5, '0')}`;
    const toSession = input.nature === 'register' ? this.openSessionId(input.toId) : null;
    const out = this.insert(
      ctx,
      {
        register_id: input.fromId,
        session_id: input.fromSessionId ?? null,
        method: input.method,
        direction: 'OUT',
        nature: input.nature,
        amount: input.amount,
        reference: input.reference,
        label: input.label,
        other_register_id: input.toId,
        counterpart_id: inId,
      },
      number,
      outId,
    );
    this.insert(
      ctx,
      {
        register_id: input.toId,
        session_id: toSession,
        method: input.method,
        direction: 'IN',
        nature: input.nature,
        amount: input.amount,
        reference: input.reference,
        label: input.label,
        other_register_id: input.fromId,
        counterpart_id: outId,
      },
      number,
      inId,
    );
    return out;
  }

  /**
   * Mouvement saisi par le gérant sur une caisse électronique : transfert vers
   * une autre caisse électronique, banque, exploitant ou autre. Il compte dans la
   * journée de la caisse si elle est ouverte.
   */
  record(
    ctx: Context,
    input: { registerId: string; direction: 'IN' | 'OUT'; nature: EmoneyNature; method: string; amount: Fcfa; reference?: string | null; label?: string | null; toRegisterId?: string | null },
  ): EmoneyMovement {
    const reg = this.register(input.registerId);
    if (reg.kind !== 'electronic' || reg.store_id !== ctx.storeId) throw new AppError(`${reg.name} n'est pas une caisse électronique de ce magasin`, 'INVALID');
    if (!isEmoney(input.method)) throw new AppError('Moyen de paiement électronique attendu', 'INVALID');
    if (!Number.isSafeInteger(input.amount) || input.amount <= 0) throw new AppError('Montant invalide', 'INVALID');
    if (input.nature === 'deposit') throw new AppError('Le versement de la recette se fait à la clôture de la caisse', 'INVALID');
    const natureLabel = EMONEY_NATURES[input.direction]?.[input.nature];
    if (!natureLabel) throw new AppError('Nature du mouvement inconnue', 'INVALID');
    const reference = input.reference?.trim() || null;
    if (input.nature !== 'other' && !reference) throw new AppError('Indiquez la référence de la transaction', 'REFERENCE_REQUIRED');
    const label = input.label?.trim() || natureLabel;
    const method = input.method;
    return this.tx(() => {
      const session = this.openSessionId(reg.id);
      if (input.nature === 'register') {
        if (input.direction !== 'OUT') throw new AppError("Un transfert se saisit sur la caisse d'où part l'argent", 'INVALID');
        const to = this.register(input.toRegisterId ?? '');
        if (to.kind !== 'electronic' || to.store_id !== ctx.storeId) throw new AppError('Choisissez la caisse électronique qui reçoit', 'INVALID');
        const m = this.transfer(ctx, { fromId: reg.id, toId: to.id, method, amount: input.amount, reference: reference!, nature: 'register', label, fromSessionId: session });
        this.audit(ctx.userId, 'emoney.transfer', 'emoney_movement', m.id, { from: reg.name, to: to.name, amount: input.amount, method });
        return m;
      }
      const m = this.insert(ctx, {
        register_id: reg.id,
        session_id: session,
        method,
        direction: input.direction,
        nature: input.nature,
        amount: input.amount,
        reference,
        label,
        other_register_id: null,
        counterpart_id: null,
      });
      this.audit(ctx.userId, `emoney.${input.direction.toLowerCase()}`, 'emoney_movement', m.id, { register: reg.name, amount: input.amount, method, nature: input.nature });
      return m;
    });
  }

  get(id: string): EmoneyMovement & { register_name: string; other_name: string | null; user_name: string | null } {
    const m = this.db
      .prepare(
        `SELECT m.*, r.name AS register_name, o.name AS other_name, u.name AS user_name FROM emoney_movements m JOIN registers r ON r.id = m.register_id
         LEFT JOIN registers o ON o.id = m.other_register_id LEFT JOIN users u ON u.id = m.user_id WHERE m.id = ?`,
      )
      .get(id) as (EmoneyMovement & { register_name: string; other_name: string | null; user_name: string | null }) | undefined;
    if (!m) throw new AppError('Mouvement introuvable', 'NOT_FOUND');
    return m;
  }
}
