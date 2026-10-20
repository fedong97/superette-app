import type { Fcfa, Milli } from '@superette/core';
import type { CashDeskService } from './cashdesk';
import type { Db } from './database';
import type { PosService } from './pos';
import { AppError, Base, type Clock, type Context, newId } from './util';

/** Compte des consignes reçues des clients (SYSCOHADA). */
export const CONTAINER_ACCOUNT = '4194';

/** Emballage consigné : casier, bouteille, fût… avec le montant de sa consigne. */
export interface Container {
  id: string;
  name: string;
  deposit: Fcfa;
  active: number;
  updated_at: string;
}

export type ContainerMoveKind = 'customer_out' | 'customer_in' | 'supplier_in' | 'supplier_out' | 'adjust';

export const CONTAINER_MOVES: Record<ContainerMoveKind, string> = {
  customer_out: 'Sorti chez le client',
  customer_in: 'Vide rapporté par le client',
  supplier_in: 'Reçu du fournisseur',
  supplier_out: 'Vide rendu au fournisseur',
  adjust: 'Casse ou comptage',
};

export interface ContainerMove {
  id: string;
  number: string;
  store_id: string;
  container_id: string;
  container_name: string;
  kind: ContainerMoveKind;
  /** Nombre d'emballages (négatif pour une casse ou un comptage en moins). */
  qty: number;
  /** Consigne encaissée (sortie) ou rendue (retour), en FCFA ; 0 sans argent. */
  amount: Fcfa;
  customer_id: string | null;
  customer_name: string | null;
  client_name: string | null;
  supplier_id: string | null;
  supplier_name: string | null;
  sale_id: string | null;
  sale_number: string | null;
  treasury_entry_id: string | null;
  note: string | null;
  status: 'active' | 'cancelled';
  user_name: string | null;
  created_at: string;
}

/** Situation d'un emballage dans le magasin. */
export interface ContainerBalance {
  container_id: string;
  name: string;
  deposit: Fcfa;
  /** Vides au magasin : rapportés par les clients, moins rendus au fournisseur, plus ou moins les comptages. */
  empties: number;
  /** Chez les clients : sortis moins rapportés. */
  at_customers: number;
  /** Consignes encaissées moins rendues : ce que le magasin doit aux clients (compte 4194). */
  deposits_held: Fcfa;
  /** À rendre aux fournisseurs : reçus moins rendus. */
  owed_to_suppliers: number;
}

/** Emballages que garde un client (sortis moins rapportés), consigne payée ou non. */
export interface CustomerContainers {
  customer_id: string | null;
  name: string;
  container_id: string;
  container_name: string;
  qty: number;
  paid: Fcfa;
}

/** Emballages d'un ticket : sortis avec la marchandise et vides rapportés par le client. */
export interface CounterContainerLine {
  containerId: string;
  /** Emballages qui partent avec le client. */
  out: number;
  /** Vides que le client rapporte. */
  back: number;
}

export interface ContainerNeed {
  container_id: string;
  name: string;
  deposit: Fcfa;
  count: number;
}

const COUNT = (n: unknown) => Number.isSafeInteger(n) && (n as number) >= 0;

/**
 * Emballages consignés. La consigne n'est pas une vente : encaissée à la
 * caisse, elle entre au compte 4194 (pièce d'« Encaisser ») et ressort quand
 * le client rapporte ses vides. Le magasin suit ses vides, ce que les clients
 * gardent et ce qu'il doit rendre aux fournisseurs (brasseries).
 */
export class ContainerService extends Base {
  constructor(
    db: Db,
    clock: Clock,
    private readonly pos: PosService,
    private readonly cashdesk: CashDeskService,
  ) {
    super(db, clock);
  }

  // --- Types d'emballages ----------------------------------------------------------

  listTypes(opts: { includeInactive?: boolean } = {}): Container[] {
    return this.db.prepare(`SELECT * FROM containers WHERE (? = 1 OR active = 1) ORDER BY name`).all(opts.includeInactive ? 1 : 0) as Container[];
  }

  getType(id: string): Container {
    const c = this.db.prepare('SELECT * FROM containers WHERE id = ?').get(id) as Container | undefined;
    if (!c) throw new AppError('Emballage introuvable', 'NOT_FOUND');
    return c;
  }

  saveType(userId: string, input: { name: string; deposit: Fcfa; active?: boolean }, id?: string): Container {
    const name = input.name.trim();
    if (!name) throw new AppError("Indiquez le nom de l'emballage (casier, bouteille…)", 'INVALID');
    if (!Number.isSafeInteger(input.deposit) || input.deposit <= 0) throw new AppError('Indiquez le montant de la consigne', 'INVALID');
    const dup = this.db.prepare('SELECT id FROM containers WHERE lower(name) = lower(?) AND id <> ?').pluck().get(name, id ?? '') as string | undefined;
    if (dup) throw new AppError(`L'emballage « ${name} » existe déjà`, 'DUPLICATE');
    const now = this.now();
    return this.tx(() => {
      const cid = id ?? newId();
      if (id) {
        this.getType(id);
        this.db.prepare('UPDATE containers SET name = ?, deposit = ?, active = ?, updated_at = ? WHERE id = ?').run(name, input.deposit, input.active === false ? 0 : 1, now, id);
      } else {
        this.db.prepare('INSERT INTO containers (id, name, deposit, active, updated_at) VALUES (?, ?, ?, ?, ?)').run(cid, name, input.deposit, input.active === false ? 0 : 1, now);
      }
      this.enqueue(null, 'container', cid, 'upsert', {});
      this.audit(userId, 'container.save', 'container', cid, { name, deposit: input.deposit });
      return this.getType(cid);
    });
  }

  /** Emballage d'un article : `units` emballages (en millièmes) par unité vendue ; null le retire. */
  setArticleContainer(userId: string, articleId: string, containerId: string | null, units: Milli = 1000): void {
    const exists = this.db.prepare('SELECT 1 FROM articles WHERE id = ?').get(articleId);
    if (!exists) throw new AppError('Article introuvable', 'NOT_FOUND');
    if (containerId) this.getType(containerId);
    if (!Number.isSafeInteger(units) || units <= 0 || units > 1_000_000) throw new AppError("Nombre d'emballages par unité invalide", 'INVALID');
    this.tx(() => {
      this.db.prepare('UPDATE articles SET container_id = ?, container_units = ?, updated_at = ? WHERE id = ?').run(containerId, containerId ? units : 1000, this.now(), articleId);
      this.enqueue(null, 'article', articleId, 'upsert', {});
      this.audit(userId, 'article.container', 'article', articleId, { containerId, units });
    });
  }

  /** Emballages qui partent avec ces lignes de vente (quantités en millièmes). */
  needsFor(lines: { articleId: string; qty: Milli }[]): ContainerNeed[] {
    const get = this.db.prepare(
      'SELECT c.id, c.name, c.deposit, a.container_units FROM articles a JOIN containers c ON c.id = a.container_id WHERE a.id = ? AND c.active = 1',
    );
    const out = new Map<string, ContainerNeed>();
    for (const l of lines) {
      const c = get.get(l.articleId) as { id: string; name: string; deposit: number; container_units: number } | undefined;
      if (!c || l.qty <= 0) continue;
      const count = (l.qty * c.container_units) / 1_000_000;
      const cur = out.get(c.id) ?? { container_id: c.id, name: c.name, deposit: c.deposit, count: 0 };
      cur.count += count;
      out.set(c.id, cur);
    }
    return [...out.values()].map((n) => ({ ...n, count: Math.round(n.count) })).filter((n) => n.count > 0);
  }

  // --- Mouvements --------------------------------------------------------------------

  /**
   * Consignes d'un passage en caisse : emballages qui partent avec le client et
   * vides qu'il rapporte. La différence se paie en espèces dans la journée de
   * la caisse (consigne encaissée ou rendue). Sans paiement (`onAccount`), le
   * client désigné garde les emballages sans consigne versée.
   */
  counter(
    ctx: Context,
    input: { lines: CounterContainerLine[]; saleId?: string | null; customerId?: string | null; clientName?: string | null; onAccount?: boolean; note?: string | null },
  ): { moves: ContainerMove[]; net: Fcfa; entryId: string | null } {
    const lines = input.lines.filter((l) => l.out > 0 || l.back > 0);
    if (!lines.length) throw new AppError('Indiquez les emballages sortis ou rapportés', 'EMPTY');
    for (const l of lines) if (!COUNT(l.out) || !COUNT(l.back)) throw new AppError("Nombre d'emballages invalide", 'INVALID');
    if (input.onAccount && !input.customerId) throw new AppError('Choisissez le client qui garde les emballages sans consigne', 'INVALID');
    const session = ctx.registerId ? this.pos.currentSession(ctx.registerId) : null;
    if (!session) throw new AppError("Ouvrez la caisse : la consigne s'encaisse ou se rend en espèces", 'NO_SESSION');
    const types = lines.map((l) => ({ line: l, type: this.getType(l.containerId) }));
    const net = input.onAccount ? 0 : types.reduce((t, { line, type }) => t + (line.out - line.back) * type.deposit, 0);
    const customer = input.customerId ? (this.db.prepare('SELECT name FROM customers WHERE id = ?').pluck().get(input.customerId) as string | undefined) : null;
    if (input.customerId && !customer) throw new AppError('Client introuvable', 'NOT_FOUND');
    const who = customer ?? (input.clientName?.trim() || 'client comptoir');
    return this.tx(() => {
      let entryId: string | null = null;
      if (net !== 0) {
        const detail = types.map(({ line, type }) => `${line.out ? `${line.out} sorti${line.out > 1 ? 's' : ''}` : ''}${line.out && line.back ? ', ' : ''}${line.back ? `${line.back} rapporté${line.back > 1 ? 's' : ''}` : ''} ${type.name}`).join(' ; ');
        entryId = this.cashdesk.record(ctx, {
          direction: net > 0 ? 'IN' : 'OUT',
          kind: net > 0 ? 'container_deposit' : 'container_refund',
          amount: Math.abs(net),
          method: 'CASH',
          sessionId: session.id,
          label: `${net > 0 ? 'Consigne encaissée' : 'Consigne rendue'}, ${who} : ${detail}`,
          party: who,
        }).id;
      }
      const moves: ContainerMove[] = [];
      for (const { line, type } of types) {
        if (line.out > 0)
          moves.push(
            this.insert(ctx, {
              kind: 'customer_out',
              containerId: type.id,
              qty: line.out,
              amount: input.onAccount ? 0 : line.out * type.deposit,
              customerId: input.customerId ?? null,
              clientName: customer ? null : input.clientName?.trim() || null,
              saleId: input.saleId ?? null,
              entryId,
              note: input.note ?? null,
            }),
          );
        if (line.back > 0)
          moves.push(
            this.insert(ctx, {
              kind: 'customer_in',
              containerId: type.id,
              qty: line.back,
              amount: input.onAccount ? 0 : line.back * type.deposit,
              customerId: input.customerId ?? null,
              clientName: customer ? null : input.clientName?.trim() || null,
              saleId: input.saleId ?? null,
              entryId,
              note: input.note ?? null,
            }),
          );
      }
      return { moves, net, entryId };
    });
  }

  /** Emballages reçus du fournisseur ou vides rendus, casse ou comptage (sans argent). */
  record(
    ctx: Context,
    input: { kind: 'supplier_in' | 'supplier_out' | 'adjust'; containerId: string; qty: number; supplierId?: string | null; note?: string | null },
  ): ContainerMove {
    const type = this.getType(input.containerId);
    if (!Number.isSafeInteger(input.qty) || input.qty === 0) throw new AppError("Nombre d'emballages invalide", 'INVALID');
    if (input.kind !== 'adjust' && input.qty < 0) throw new AppError("Nombre d'emballages invalide", 'INVALID');
    if (input.kind !== 'adjust' && !input.supplierId) throw new AppError('Choisissez le fournisseur', 'INVALID');
    if (input.kind === 'adjust' && !input.note?.trim()) throw new AppError('Indiquez le motif (casse, comptage…)', 'INVALID');
    if (input.kind === 'supplier_out') {
      const b = this.balances(ctx.storeId).find((x) => x.container_id === type.id);
      if ((b?.empties ?? 0) < input.qty) throw new AppError(`Il n'y a que ${b?.empties ?? 0} ${type.name} vides au magasin`, 'INSUFFICIENT');
    }
    return this.tx(() =>
      this.insert(ctx, { kind: input.kind, containerId: type.id, qty: input.qty, amount: 0, supplierId: input.supplierId ?? null, note: input.note?.trim() || null }),
    );
  }

  private insert(
    ctx: Context,
    m: {
      kind: ContainerMoveKind;
      containerId: string;
      qty: number;
      amount: Fcfa;
      customerId?: string | null;
      clientName?: string | null;
      supplierId?: string | null;
      saleId?: string | null;
      entryId?: string | null;
      note?: string | null;
    },
  ): ContainerMove {
    const id = newId();
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO container_moves (id, number, store_id, container_id, kind, qty, amount, customer_id, client_name, supplier_id, sale_id, treasury_entry_id, note, status, user_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
      )
      .run(
        id,
        `EM-${this.stationPrefix()}-${String(this.nextCounter('container_move.number')).padStart(5, '0')}`,
        ctx.storeId,
        m.containerId,
        m.kind,
        m.qty,
        m.amount,
        m.customerId ?? null,
        m.clientName ?? null,
        m.supplierId ?? null,
        m.saleId ?? null,
        m.entryId ?? null,
        m.note ?? null,
        ctx.userId,
        now,
        now,
      );
    this.enqueue(ctx, 'container_move', id, 'upsert', {});
    this.audit(ctx.userId, `container.${m.kind}`, 'container_move', id, { qty: m.qty, amount: m.amount });
    return this.get(id);
  }

  /** Annule un mouvement saisi par erreur ; la consigne encaissée ou rendue est annulée avec (journée encore ouverte). */
  cancel(ctx: Context, id: string, reason: string): ContainerMove {
    const m = this.get(id);
    if (m.store_id !== ctx.storeId) throw new AppError("Ce mouvement est d'un autre magasin", 'FORBIDDEN');
    if (m.status === 'cancelled') return m;
    if (!reason.trim()) throw new AppError("Indiquez le motif de l'annulation", 'INVALID');
    this.tx(() => {
      const linked = m.treasury_entry_id
        ? (this.db.prepare("SELECT id FROM container_moves WHERE treasury_entry_id = ? AND status = 'active'").pluck().all(m.treasury_entry_id) as string[])
        : [m.id];
      if (m.treasury_entry_id) {
        const entry = this.db.prepare('SELECT status FROM treasury_entries WHERE id = ?').pluck().get(m.treasury_entry_id);
        if (entry === 'active') this.cashdesk.cancel(ctx, m.treasury_entry_id, ctx.userId, `Consigne annulée : ${reason.trim()}`);
      }
      const upd = this.db.prepare("UPDATE container_moves SET status = 'cancelled', note = COALESCE(note || ' · ', '') || ?, updated_at = ? WHERE id = ?");
      for (const x of linked) {
        upd.run(`Annulé : ${reason.trim()}`, this.now(), x);
        this.enqueue(ctx, 'container_move', x, 'upsert', {});
      }
      this.audit(ctx.userId, 'container.cancel', 'container_move', id, { reason });
    });
    return this.get(id);
  }

  get(id: string): ContainerMove {
    const m = this.query('m.id = @id', 1).get({ id }) as ContainerMove | undefined;
    if (!m) throw new AppError('Mouvement introuvable', 'NOT_FOUND');
    return m;
  }

  moves(storeId: string, opts: { containerId?: string | null; customerId?: string | null; from?: string | null; to?: string | null } = {}): ContainerMove[] {
    return this.query(
      `m.store_id = @storeId AND (@container IS NULL OR m.container_id = @container) AND (@customer IS NULL OR m.customer_id = @customer)
       AND (@from IS NULL OR date(m.created_at, 'localtime') >= @from) AND (@to IS NULL OR date(m.created_at, 'localtime') <= @to)`,
      1000,
    ).all({ storeId, container: opts.containerId ?? null, customer: opts.customerId ?? null, from: opts.from ?? null, to: opts.to ?? null }) as ContainerMove[];
  }

  private query(where: string, limit: number) {
    return this.db.prepare(
      `SELECT m.id, m.number, m.store_id, m.container_id, c.name AS container_name, m.kind, m.qty, m.amount, m.customer_id, cu.name AS customer_name, m.client_name,
              m.supplier_id, s.name AS supplier_name, m.sale_id, sa.number AS sale_number, m.treasury_entry_id, m.note, m.status, u.name AS user_name, m.created_at
       FROM container_moves m LEFT JOIN containers c ON c.id = m.container_id LEFT JOIN customers cu ON cu.id = m.customer_id
       LEFT JOIN suppliers s ON s.id = m.supplier_id LEFT JOIN sales sa ON sa.id = m.sale_id LEFT JOIN users u ON u.id = m.user_id
       WHERE ${where} ORDER BY m.created_at DESC, m.number DESC LIMIT ${limit}`,
    );
  }

  /** Situation de chaque emballage du magasin. */
  balances(storeId: string): ContainerBalance[] {
    return this.db
      .prepare(
        `SELECT c.id AS container_id, c.name, c.deposit,
           COALESCE(SUM(CASE m.kind WHEN 'customer_in' THEN m.qty WHEN 'supplier_out' THEN -m.qty WHEN 'adjust' THEN m.qty ELSE 0 END), 0) AS empties,
           COALESCE(SUM(CASE m.kind WHEN 'customer_out' THEN m.qty WHEN 'customer_in' THEN -m.qty ELSE 0 END), 0) AS at_customers,
           COALESCE(SUM(CASE m.kind WHEN 'customer_out' THEN m.amount WHEN 'customer_in' THEN -m.amount ELSE 0 END), 0) AS deposits_held,
           COALESCE(SUM(CASE m.kind WHEN 'supplier_in' THEN m.qty WHEN 'supplier_out' THEN -m.qty ELSE 0 END), 0) AS owed_to_suppliers
         FROM containers c LEFT JOIN container_moves m ON m.container_id = c.id AND m.store_id = ? AND m.status = 'active'
         GROUP BY c.id HAVING c.active = 1 OR COUNT(m.id) > 0 ORDER BY c.name`,
      )
      .all(storeId) as ContainerBalance[];
  }

  /** Emballages chez chaque client désigné (les clients comptoir sont regroupés). */
  atCustomers(storeId: string): CustomerContainers[] {
    return (
      this.db
        .prepare(
          `SELECT m.customer_id, COALESCE(cu.name, 'Clients comptoir') AS name, m.container_id, c.name AS container_name,
             SUM(CASE m.kind WHEN 'customer_out' THEN m.qty ELSE -m.qty END) AS qty,
             SUM(CASE m.kind WHEN 'customer_out' THEN m.amount ELSE -m.amount END) AS paid
           FROM container_moves m JOIN containers c ON c.id = m.container_id LEFT JOIN customers cu ON cu.id = m.customer_id
           WHERE m.store_id = ? AND m.status = 'active' AND m.kind IN ('customer_out', 'customer_in')
           GROUP BY m.customer_id, m.container_id ORDER BY name, container_name`,
        )
        .all(storeId) as CustomerContainers[]
    ).filter((r) => r.qty !== 0 || r.paid !== 0);
  }

  /** Ce que le fournisseur attend en retour, emballage par emballage. */
  owedToSuppliers(storeId: string): { supplier_id: string; supplier_name: string; container_id: string; container_name: string; qty: number; value: Fcfa }[] {
    return (
      this.db
        .prepare(
          `SELECT m.supplier_id, s.name AS supplier_name, m.container_id, c.name AS container_name,
             SUM(CASE m.kind WHEN 'supplier_in' THEN m.qty ELSE -m.qty END) AS qty, c.deposit
           FROM container_moves m JOIN containers c ON c.id = m.container_id JOIN suppliers s ON s.id = m.supplier_id
           WHERE m.store_id = ? AND m.status = 'active' AND m.kind IN ('supplier_in', 'supplier_out')
           GROUP BY m.supplier_id, m.container_id ORDER BY supplier_name, container_name`,
        )
        .all(storeId) as { supplier_id: string; supplier_name: string; container_id: string; container_name: string; qty: number; deposit: number }[]
    )
      .filter((r) => r.qty !== 0)
      .map(({ deposit, ...r }) => ({ ...r, value: r.qty * deposit }));
  }
}
