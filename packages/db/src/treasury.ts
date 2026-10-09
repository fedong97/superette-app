import { type Fcfa } from '@superette/core';
import { AppError, Base, type Context, newId } from './util';

/**
 * Mouvement de la caisse centrale :
 * - DEPOSIT : versement d'une caisse (recette du jour, prélèvement en cours de journée) ;
 * - FLOAT : fond remis à une caisse (complément du fond à l'ouverture, apport en cours de journée) ;
 * - IN / OUT : apport ou sortie au bureau (retrait ou dépôt en banque, apport ou retrait de l'exploitant).
 */
export type CentralKind = 'DEPOSIT' | 'FLOAT' | 'IN' | 'OUT';
export type CentralNature = 'register' | 'bank' | 'owner' | 'other';

export const CENTRAL_NATURES: Record<'IN' | 'OUT', Partial<Record<CentralNature, string>>> = {
  IN: { bank: 'Retrait à la banque', owner: "Apport de l'exploitant" },
  OUT: { bank: 'Dépôt à la banque', owner: "Retrait de l'exploitant" },
};

export interface CentralMovement {
  id: string;
  number: string;
  store_id: string;
  kind: CentralKind;
  nature: CentralNature;
  amount: Fcfa;
  register_id: string | null;
  session_id: string | null;
  cash_operation_id: string | null;
  label: string;
  user_id: string | null;
  at: string;
}

/** Ligne du livre de la caisse centrale, avec le solde après l'opération. */
export interface CentralLedgerRow {
  /** Mouvement de la centrale, ou pièce payée en espèces au bureau. */
  source: 'movement' | 'expense' | 'supplier_payment' | 'customer_payment';
  id: string;
  number: string;
  at: string;
  label: string;
  /** Caisse, fournisseur, client ou bénéficiaire. */
  party: string | null;
  user_name: string | null;
  /** Positif : entrée dans la centrale ; négatif : sortie. */
  amount: Fcfa;
  balance: Fcfa;
}

/**
 * Caisse centrale du magasin. Elle ne vend pas : elle reçoit la recette de
 * chaque caisse à la clôture, donne les fonds de caisse, paie au bureau
 * (fournisseurs, dépenses) et dépose en banque. Son solde se recalcule à partir
 * des mouvements, qui ne se modifient jamais : il reste juste quel que soit
 * l'ordre dans lequel les PC se synchronisent.
 */
export class TreasuryService extends Base {
  /** Enregistre un mouvement (à appeler dans une transaction). */
  insertMovement(
    ctx: Context,
    m: { kind: CentralKind; nature: CentralNature; amount: Fcfa; label: string; registerId?: string | null; sessionId?: string | null; cashOperationId?: string | null },
  ): CentralMovement {
    if (!Number.isSafeInteger(m.amount) || m.amount <= 0) throw new AppError('Montant invalide', 'INVALID');
    const row: CentralMovement = {
      id: newId(),
      number: `VC-${this.stationPrefix()}-${String(this.nextCounter('central.number')).padStart(5, '0')}`,
      store_id: ctx.storeId,
      kind: m.kind,
      nature: m.nature,
      amount: m.amount,
      register_id: m.registerId ?? null,
      session_id: m.sessionId ?? null,
      cash_operation_id: m.cashOperationId ?? null,
      label: m.label,
      user_id: ctx.userId,
      at: this.now(),
    };
    this.db
      .prepare(
        `INSERT INTO central_cash_movements (id, number, store_id, kind, nature, amount, register_id, session_id, cash_operation_id, label, user_id, at)
         VALUES (@id, @number, @store_id, @kind, @nature, @amount, @register_id, @session_id, @cash_operation_id, @label, @user_id, @at)`,
      )
      .run(row);
    this.enqueue(ctx, 'central_cash_movement', row.id, 'upsert', row);
    this.audit(ctx.userId, `central.${m.kind.toLowerCase()}`, 'central_cash_movement', row.id, { amount: m.amount, nature: m.nature, label: m.label });
    return row;
  }

  /** Apport ou sortie saisi au bureau (banque, exploitant). */
  record(ctx: Context, input: { kind: 'IN' | 'OUT'; nature: CentralNature; amount: Fcfa; label?: string | null }): CentralMovement {
    const natureLabel = CENTRAL_NATURES[input.kind]?.[input.nature];
    if (!natureLabel) throw new AppError('Nature du mouvement inconnue', 'INVALID');
    if (input.kind === 'OUT' && input.amount > this.balance(ctx.storeId)) {
      throw new AppError(`La caisse centrale n'a que ${this.balance(ctx.storeId)} FCFA`, 'INSUFFICIENT');
    }
    return this.tx(() => this.insertMovement(ctx, { kind: input.kind, nature: input.nature, amount: input.amount, label: input.label?.trim() || natureLabel }));
  }

  /** Solde de la caisse centrale : mouvements et paiements en espèces faits au bureau. */
  balance(storeId: string, to?: string): Fcfa {
    return this.ledger(storeId, { to }).closing;
  }

  /** Livre de la caisse centrale sur une période (dates locales AAAA-MM-JJ), avec solde de départ et soldes progressifs. */
  ledger(storeId: string, opts: { from?: string; to?: string } = {}): { opening: Fcfa; closing: Fcfa; rows: CentralLedgerRow[] } {
    const all = this.db
      .prepare(
        `SELECT 'movement' AS source, m.id, m.number, m.at, m.label, g.name AS party, u.name AS user_name,
                CASE WHEN m.kind IN ('DEPOSIT', 'IN') THEN m.amount ELSE -m.amount END AS amount
         FROM central_cash_movements m LEFT JOIN registers g ON g.id = m.register_id LEFT JOIN users u ON u.id = m.user_id
         WHERE m.store_id = @storeId
         UNION ALL
         SELECT 'expense', e.id, e.number, e.created_at, e.label, e.beneficiary, u.name, -e.amount
         FROM expenses e LEFT JOIN users u ON u.id = e.user_id
         WHERE e.store_id = @storeId AND e.from_central = 1 AND e.status = 'active'
         UNION ALL
         SELECT 'supplier_payment', p.id, i.number, p.paid_at, 'Paiement fournisseur', f.name, u.name,
                CASE WHEN i.kind = 'invoice' THEN -p.amount ELSE p.amount END
         FROM supplier_payments p JOIN supplier_invoices i ON i.id = p.invoice_id JOIN suppliers f ON f.id = p.supplier_id LEFT JOIN users u ON u.id = p.user_id
         WHERE p.store_id = @storeId AND p.from_central = 1
         UNION ALL
         SELECT 'customer_payment', p.id, p.number, p.paid_at, 'Règlement client', c.name, u.name, p.amount
         FROM customer_payments p JOIN customers c ON c.id = p.customer_id LEFT JOIN users u ON u.id = p.user_id
         WHERE p.store_id = @storeId AND p.from_central = 1
         ORDER BY 4, 3`,
      )
      .all({ storeId }) as Omit<CentralLedgerRow, 'balance'>[];
    const day = (iso: string) => {
      const d = new Date(iso);
      const pad = (n: number) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    };
    let balance = 0;
    let opening = 0;
    const rows: CentralLedgerRow[] = [];
    for (const r of all) {
      const d = day(r.at);
      if (opts.to && d > opts.to) break;
      balance += r.amount;
      if (opts.from && d < opts.from) {
        opening = balance;
        continue;
      }
      rows.push({ ...r, balance });
    }
    return { opening, closing: balance, rows };
  }

  /** Mouvements de la centrale liés à une journée de caisse (fond, versements). */
  sessionMovements(sessionId: string): CentralMovement[] {
    return this.db.prepare('SELECT * FROM central_cash_movements WHERE session_id = ? ORDER BY at').all(sessionId) as CentralMovement[];
  }

  getMovement(id: string): CentralMovement & { register_name: string | null; user_name: string | null } {
    const m = this.db
      .prepare(
        `SELECT m.*, g.name AS register_name, u.name AS user_name FROM central_cash_movements m
         LEFT JOIN registers g ON g.id = m.register_id LEFT JOIN users u ON u.id = m.user_id WHERE m.id = ?`,
      )
      .get(id) as (CentralMovement & { register_name: string | null; user_name: string | null }) | undefined;
    if (!m) throw new AppError('Mouvement de caisse centrale introuvable', 'NOT_FOUND');
    return m;
  }
}
