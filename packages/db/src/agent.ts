import type { Fcfa } from '@superette/core';
import type { CashDeskService } from './cashdesk';
import type { Db } from './database';
import type { PosService } from './pos';
import { AppError, Base, type Clock, type Context, newId } from './util';

/** Compte des commissions et des frais encaissés pour les services (SYSCOHADA). */
export const AGENT_COMMISSION_ACCOUNT = '7072';

export type AgentOperator = 'MTN' | 'ORANGE' | 'OTHER';

export const AGENT_OPERATORS: Record<AgentOperator, { label: string; account: string }> = {
  MTN: { label: 'MTN Mobile Money', account: '5523' },
  ORANGE: { label: 'Orange Money', account: '5524' },
  OTHER: { label: 'Autres services (crédit, factures)', account: '5525' },
};

export type AgentKind = 'deposit' | 'withdrawal' | 'airtime' | 'bill' | 'float_in' | 'float_out' | 'commission';

/**
 * Opérations du point Mobile Money. `cash` : espèces reçues (+1) ou données
 * (−1) ; `float` : effet sur la flotte de l'agent.
 */
export const AGENT_KINDS: Record<AgentKind, { label: string; cash: 1 | -1 | 0; float: 1 | -1 }> = {
  deposit: { label: 'Dépôt (le client verse sur son compte)', cash: 1, float: -1 },
  withdrawal: { label: 'Retrait (le client retire des espèces)', cash: -1, float: 1 },
  airtime: { label: 'Vente de crédit de communication', cash: 1, float: -1 },
  bill: { label: 'Paiement de facture (ENEO, CAMWATER, Canal+…)', cash: 1, float: -1 },
  float_in: { label: 'Achat de flotte avec les espèces de la caisse', cash: -1, float: 1 },
  float_out: { label: 'Flotte revendue contre des espèces', cash: 1, float: -1 },
  commission: { label: "Commission versée par l'opérateur", cash: 0, float: 1 },
};

/** Opérations faites pour un client : elles portent son numéro. */
const CLIENT_KINDS = new Set<AgentKind>(['deposit', 'withdrawal', 'airtime', 'bill']);

export interface AgentAccount {
  id: string;
  store_id: string;
  name: string;
  operator: AgentOperator;
  account: string;
  /** Commission en points de base par opération ({ deposit: 50 } = 0,5 %). */
  rates: Partial<Record<AgentKind, number>>;
  active: number;
  /** Flotte disponible d'après les opérations. */
  float: Fcfa;
}

export interface AgentOperation {
  id: string;
  number: string;
  store_id: string;
  agent_account_id: string;
  account_name: string;
  operator: AgentOperator;
  kind: AgentKind;
  amount: Fcfa;
  fee: Fcfa;
  commission: Fcfa;
  phone: string | null;
  reference: string | null;
  biller: string | null;
  session_id: string | null;
  status: 'active' | 'cancelled';
  cancel_reason: string | null;
  user_name: string | null;
  created_at: string;
}

export interface AgentInput {
  accountId: string;
  kind: AgentKind;
  amount: Fcfa;
  /** Frais payés par le client en espèces (paiement de facture). */
  fee?: Fcfa;
  /** Commission de l'opérateur ; sinon calculée avec le taux du compte. */
  commission?: Fcfa | null;
  phone?: string | null;
  reference?: string | null;
  /** Facture payée : ENEO, CAMWATER… */
  biller?: string | null;
}

/** Bilan d'une période par compte agent. */
export interface AgentSummaryRow {
  account_id: string;
  name: string;
  operator: AgentOperator;
  float: Fcfa;
  count: number;
  by_kind: Partial<Record<AgentKind, { count: number; amount: Fcfa }>>;
  commissions: Fcfa;
  fees: Fcfa;
  /** Espèces reçues moins données dans la période. */
  cash_net: Fcfa;
}

const parseRates = (json: string | null): AgentAccount['rates'] => {
  try {
    const r = JSON.parse(json ?? '{}') as Record<string, unknown>;
    return Object.fromEntries(Object.entries(r).filter(([k, v]) => k in AGENT_KINDS && Number.isSafeInteger(v) && (v as number) >= 0)) as AgentAccount['rates'];
  } catch {
    return {};
  }
};

/**
 * Point Mobile Money et services : dépôts, retraits, crédit de communication et
 * factures pour les clients, avec la flotte de chaque compte agent. Les espèces
 * passent par la journée de la caisse (pièces d'« Encaisser » et « Décaisser »,
 * dans le Z) ; la flotte est un compte de trésorerie (5523, 5524, 5525) et les
 * commissions et frais un produit (7072).
 */
export class AgentService extends Base {
  constructor(
    db: Db,
    clock: Clock,
    private readonly pos: PosService,
    private readonly cashdesk: CashDeskService,
  ) {
    super(db, clock);
  }

  // --- Comptes agent ------------------------------------------------------------------

  accounts(storeId: string, opts: { includeInactive?: boolean } = {}): AgentAccount[] {
    const rows = this.db
      .prepare('SELECT * FROM agent_accounts WHERE store_id = ? AND (? = 1 OR active = 1) ORDER BY name')
      .all(storeId, opts.includeInactive ? 1 : 0) as (Omit<AgentAccount, 'rates' | 'float'> & { rates: string })[];
    return rows.map((r) => ({ ...r, rates: parseRates(r.rates), float: this.float(r.id) }));
  }

  getAccount(id: string): AgentAccount {
    const r = this.db.prepare('SELECT * FROM agent_accounts WHERE id = ?').get(id) as (Omit<AgentAccount, 'rates' | 'float'> & { rates: string }) | undefined;
    if (!r) throw new AppError('Compte agent introuvable', 'NOT_FOUND');
    return { ...r, rates: parseRates(r.rates), float: this.float(r.id) };
  }

  saveAccount(ctx: Context, input: { name: string; operator: AgentOperator; rates?: AgentAccount['rates']; active?: boolean }, id?: string): AgentAccount {
    const name = input.name.trim();
    if (!name) throw new AppError('Indiquez le nom du compte (par exemple « Agent MTN principal »)', 'INVALID');
    if (!(input.operator in AGENT_OPERATORS)) throw new AppError('Opérateur inconnu', 'INVALID');
    const rates = parseRates(JSON.stringify(input.rates ?? {}));
    for (const v of Object.values(rates)) if (v > 2_000) throw new AppError('Commission : 20 % au plus', 'INVALID');
    const now = this.now();
    return this.tx(() => {
      const aid = id ?? newId();
      if (id) {
        const cur = this.getAccount(id);
        if (cur.store_id !== ctx.storeId) throw new AppError("Ce compte est d'un autre magasin", 'FORBIDDEN');
        if (cur.operator !== input.operator && this.db.prepare("SELECT 1 FROM agent_operations WHERE agent_account_id = ? AND status = 'active'").get(id))
          throw new AppError("L'opérateur d'un compte qui a déjà des opérations ne change plus", 'INVALID');
        this.db
          .prepare('UPDATE agent_accounts SET name = ?, operator = ?, account = ?, rates = ?, active = ?, updated_at = ? WHERE id = ?')
          .run(name, input.operator, AGENT_OPERATORS[input.operator].account, JSON.stringify(rates), input.active === false ? 0 : 1, now, id);
      } else {
        this.db
          .prepare('INSERT INTO agent_accounts (id, store_id, name, operator, account, rates, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(aid, ctx.storeId, name, input.operator, AGENT_OPERATORS[input.operator].account, JSON.stringify(rates), input.active === false ? 0 : 1, now, now);
      }
      this.enqueue(ctx, 'agent_account', aid, 'upsert', {});
      this.audit(ctx.userId, 'agent.account', 'agent_account', aid, { name, operator: input.operator, rates });
      return this.getAccount(aid);
    });
  }

  /** Flotte d'un compte agent : effet de toutes ses opérations, commissions comprises. */
  float(accountId: string): Fcfa {
    const rows = this.db
      .prepare("SELECT kind, SUM(amount) AS amount, SUM(commission) AS commission FROM agent_operations WHERE agent_account_id = ? AND status = 'active' GROUP BY kind")
      .all(accountId) as { kind: AgentKind; amount: number; commission: number }[];
    return rows.reduce((t, r) => t + AGENT_KINDS[r.kind].float * r.amount + (r.kind === 'commission' ? 0 : r.commission), 0);
  }

  // --- Opérations ---------------------------------------------------------------------

  /** Commission proposée pour une opération, au taux du compte. */
  commissionFor(accountId: string, kind: AgentKind, amount: Fcfa): Fcfa {
    const rate = this.getAccount(accountId).rates[kind] ?? 0;
    return Math.round((amount * rate) / 10_000);
  }

  record(ctx: Context, input: AgentInput): AgentOperation {
    const acc = this.getAccount(input.accountId);
    if (acc.store_id !== ctx.storeId) throw new AppError("Ce compte est d'un autre magasin", 'FORBIDDEN');
    if (!acc.active) throw new AppError(`Le compte ${acc.name} est désactivé`, 'INVALID');
    const def = AGENT_KINDS[input.kind];
    if (!def) throw new AppError("Type d'opération inconnu", 'INVALID');
    if (!Number.isSafeInteger(input.amount) || input.amount <= 0) throw new AppError('Montant invalide', 'INVALID');
    const fee = input.fee ?? 0;
    if (!Number.isSafeInteger(fee) || fee < 0) throw new AppError('Frais invalides', 'INVALID');
    if (fee && input.kind !== 'bill') throw new AppError('Des frais ne se prennent que sur un paiement de facture', 'INVALID');
    const commission = input.kind === 'commission' ? 0 : (input.commission ?? this.commissionFor(acc.id, input.kind, input.amount));
    if (!Number.isSafeInteger(commission) || commission < 0 || commission > input.amount) throw new AppError('Commission invalide', 'INVALID');
    const phone = input.phone?.replace(/\s+/g, '') || null;
    if (CLIENT_KINDS.has(input.kind) && input.kind !== 'bill' && !phone) throw new AppError('Indiquez le numéro de téléphone du client', 'INVALID');
    if (phone && !/^\+?\d{8,15}$/.test(phone)) throw new AppError('Numéro de téléphone invalide', 'INVALID');
    if (input.kind === 'bill' && !input.biller?.trim()) throw new AppError('Indiquez la facture payée (ENEO, CAMWATER…)', 'INVALID');
    if (def.float < 0 && input.amount > acc.float) throw new AppError(`La flotte de ${acc.name} n'a que ${acc.float} FCFA`, 'INSUFFICIENT');
    const session = def.cash !== 0 ? (ctx.registerId ? this.pos.currentSession(ctx.registerId) : null) : null;
    if (def.cash !== 0 && !session) throw new AppError('Ouvrez la caisse : les espèces du point Mobile Money passent par la journée', 'NO_SESSION');
    if (session && def.cash < 0) {
      const cash = this.pos.zReport(session.id).cash.expected;
      if (input.amount > cash) throw new AppError(`Il n'y a que ${cash} FCFA en espèces dans la caisse`, 'INSUFFICIENT');
    }
    const who = phone ?? input.biller?.trim() ?? acc.name;
    const label = `${AGENT_KINDS[input.kind].label.split(' (')[0]}, ${acc.name}${phone ? ` · ${phone}` : ''}${input.biller?.trim() ? ` · ${input.biller.trim()}` : ''}`;
    return this.tx(() => {
      const entryIds: string[] = [];
      if (session && def.cash !== 0) {
        entryIds.push(
          this.cashdesk.record(ctx, {
            direction: def.cash > 0 ? 'IN' : 'OUT',
            kind: def.cash > 0 ? 'agent_in' : 'agent_out',
            amount: input.amount,
            method: 'CASH',
            accountId: acc.account,
            reference: input.reference?.trim() || null,
            sessionId: session.id,
            label,
            party: who,
          }).id,
        );
        if (fee)
          entryIds.push(
            this.cashdesk.record(ctx, {
              direction: 'IN',
              kind: 'agent_in',
              amount: fee,
              method: 'CASH',
              accountId: AGENT_COMMISSION_ACCOUNT,
              sessionId: session.id,
              label: `Frais, ${label}`,
              party: who,
            }).id,
          );
      }
      const id = newId();
      const now = this.now();
      this.db
        .prepare(
          `INSERT INTO agent_operations (id, number, store_id, agent_account_id, kind, amount, fee, commission, phone, reference, biller, session_id, register_id, entry_ids,
             status, user_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
        )
        .run(
          id,
          `AG-${this.stationPrefix()}-${String(this.nextCounter('agent_operation.number')).padStart(5, '0')}`,
          ctx.storeId,
          acc.id,
          input.kind,
          input.amount,
          fee,
          commission,
          phone,
          input.reference?.trim() || null,
          input.biller?.trim() || null,
          session?.id ?? null,
          session ? ctx.registerId : null,
          JSON.stringify(entryIds),
          ctx.userId,
          now,
          now,
        );
      this.enqueue(ctx, 'agent_operation', id, 'upsert', {});
      this.audit(ctx.userId, `agent.${input.kind}`, 'agent_operation', id, { amount: input.amount, fee, commission });
      return this.get(id);
    });
  }

  /** Annule une opération saisie par erreur (journée de caisse encore ouverte) : ses espèces sont annulées avec. */
  cancel(ctx: Context, id: string, reason: string): AgentOperation {
    const op = this.get(id);
    if (op.store_id !== ctx.storeId) throw new AppError("Cette opération est d'un autre magasin", 'FORBIDDEN');
    if (op.status === 'cancelled') return op;
    if (!reason.trim()) throw new AppError("Indiquez le motif de l'annulation", 'INVALID');
    const acc = this.getAccount(op.agent_account_id);
    // Annuler une entrée de flotte ne doit pas la rendre négative.
    if (AGENT_KINDS[op.kind].float > 0 || op.commission > 0) {
      const back = (AGENT_KINDS[op.kind].float > 0 ? op.amount : 0) + (op.kind === 'commission' ? 0 : op.commission);
      if (acc.float - back < 0) throw new AppError('La flotte deviendrait négative : annulez d’abord les opérations suivantes', 'INVALID');
    }
    const entryIds = JSON.parse((this.db.prepare('SELECT entry_ids FROM agent_operations WHERE id = ?').pluck().get(id) as string) ?? '[]') as string[];
    this.tx(() => {
      for (const e of entryIds) {
        const status = this.db.prepare('SELECT status FROM treasury_entries WHERE id = ?').pluck().get(e);
        if (status === 'active') this.cashdesk.cancel(ctx, e, ctx.userId, `Opération ${op.number} annulée : ${reason.trim()}`);
      }
      this.db.prepare("UPDATE agent_operations SET status = 'cancelled', cancel_reason = ?, updated_at = ? WHERE id = ?").run(reason.trim(), this.now(), id);
      this.enqueue(ctx, 'agent_operation', id, 'upsert', {});
      this.audit(ctx.userId, 'agent.cancel', 'agent_operation', id, { number: op.number, reason });
    });
    return this.get(id);
  }

  get(id: string): AgentOperation {
    const r = this.query('o.id = @id', 1).get({ id }) as AgentOperation | undefined;
    if (!r) throw new AppError('Opération introuvable', 'NOT_FOUND');
    return r;
  }

  list(storeId: string, opts: { from?: string | null; to?: string | null; accountId?: string | null; sessionId?: string | null } = {}): AgentOperation[] {
    return this.query(
      `o.store_id = @storeId AND (@account IS NULL OR o.agent_account_id = @account) AND (@session IS NULL OR o.session_id = @session)
       AND (@from IS NULL OR date(o.created_at, 'localtime') >= @from) AND (@to IS NULL OR date(o.created_at, 'localtime') <= @to)`,
      2000,
    ).all({ storeId, account: opts.accountId ?? null, session: opts.sessionId ?? null, from: opts.from ?? null, to: opts.to ?? null }) as AgentOperation[];
  }

  private query(where: string, limit: number) {
    return this.db.prepare(
      `SELECT o.id, o.number, o.store_id, o.agent_account_id, a.name AS account_name, a.operator, o.kind, o.amount, o.fee, o.commission, o.phone, o.reference, o.biller,
              o.session_id, o.status, o.cancel_reason, u.name AS user_name, o.created_at
       FROM agent_operations o JOIN agent_accounts a ON a.id = o.agent_account_id LEFT JOIN users u ON u.id = o.user_id
       WHERE ${where} ORDER BY o.created_at DESC, o.number DESC LIMIT ${limit}`,
    );
  }

  /** Bilan de la période par compte : nombre et montants par type, commissions, frais et espèces. */
  summary(storeId: string, from: string, to: string): AgentSummaryRow[] {
    const ops = this.list(storeId, { from, to }).filter((o) => o.status === 'active');
    return this.accounts(storeId, { includeInactive: true }).map((a) => {
      const mine = ops.filter((o) => o.agent_account_id === a.id);
      const by_kind: AgentSummaryRow['by_kind'] = {};
      for (const o of mine) {
        const k = (by_kind[o.kind] ??= { count: 0, amount: 0 });
        k.count += 1;
        k.amount += o.amount;
      }
      return {
        account_id: a.id,
        name: a.name,
        operator: a.operator,
        float: a.float,
        count: mine.length,
        by_kind,
        commissions: mine.reduce((t, o) => t + (o.kind === 'commission' ? o.amount : o.commission), 0),
        fees: mine.reduce((t, o) => t + o.fee, 0),
        cash_net: mine.reduce((t, o) => t + AGENT_KINDS[o.kind].cash * o.amount + o.fee, 0),
      };
    });
  }
}
