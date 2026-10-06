import type { Fcfa, StatementLine } from '@superette/core';
import type { AccountingService, JournalCode } from './accounting';
import { createHash } from 'node:crypto';
import { AppError, Base, type Context } from './util';

/** Ligne de comptabilité d'un compte de trésorerie, avec la clé qui sert au pointage. */
export interface BookLine {
  key: string;
  date: string;
  journal: JournalCode;
  ref: string;
  label: string;
  /** Débit moins crédit : positif quand l'argent entre sur le compte. */
  amount: Fcfa;
}

export interface BankLine {
  id: string;
  account_id: string;
  op_date: string;
  label: string;
  reference: string | null;
  amount: Fcfa;
  match_key: string | null;
  matched_at: string | null;
}

export interface Reconciliation {
  account: { id: string; label: string };
  date: string;
  /** Solde du compte en comptabilité à la date (débiteur positif). */
  bookBalance: Fcfa;
  /** Opérations passées en comptabilité mais pas encore vues sur le relevé. */
  bookOnly: BookLine[];
  /** Opérations du relevé pas encore passées en comptabilité. */
  bankOnly: BankLine[];
  /** Pointages faits : ligne du relevé et sa ligne de comptabilité. */
  matched: { bank: BankLine; book: BookLine }[];
  /** Pointages dont la ligne de comptabilité a changé ou disparu (écriture modifiée) : à refaire. */
  lost: BankLine[];
  /** Solde que le relevé doit afficher à la date si tout est juste. */
  expectedBankBalance: Fcfa;
}

/**
 * Rapprochement des comptes de banque et de Mobile Money avec leurs relevés.
 * Les lignes du relevé sont enregistrées ; les écritures restent calculées,
 * et une ligne de relevé pointée garde la clé de sa ligne d'écriture.
 */
export class ReconciliationService extends Base {
  constructor(
    db: ConstructorParameters<typeof Base>[0],
    clock: ConstructorParameters<typeof Base>[1],
    private readonly accounting: AccountingService,
  ) {
    super(db, clock);
  }

  /** Comptes à rapprocher : banques (52), Mobile Money et autres établissements (55), cartes. */
  accounts(): { id: string; label: string }[] {
    return this.accounting
      .listAccounts()
      .filter((a) => /^5[2-5]/.test(a.id))
      .map((a) => ({ id: a.id, label: a.label }));
  }

  private requireAccount(accountId: string) {
    const a = this.accounts().find((x) => x.id === accountId);
    if (!a) throw new AppError('Choisissez un compte de banque ou de Mobile Money (classe 52 à 55)', 'INVALID');
    return a;
  }

  /** Lignes du compte en comptabilité, chacune avec une clé stable tant que l'écriture ne change pas. */
  bookLines(storeId: string, accountId: string, to?: string): BookLine[] {
    const seen = new Map<string, number>();
    const out: BookLine[] = [];
    for (const e of this.accounting.entries(storeId, { to })) {
      for (const l of e.lines) {
        if (l.account !== accountId) continue;
        const amount = l.debit - l.credit;
        const base = `${e.journal}|${e.date}|${e.ref}|${l.aux ?? ''}|${amount}`;
        const n = (seen.get(base) ?? 0) + 1;
        seen.set(base, n);
        out.push({ key: n > 1 ? `${base}#${n}` : base, date: e.date, journal: e.journal, ref: e.ref, label: l.label, amount });
      }
    }
    return out.sort((a, b) => a.date.localeCompare(b.date) || a.key.localeCompare(b.key));
  }

  bankLines(storeId: string, accountId: string, to?: string): BankLine[] {
    return this.db
      .prepare(
        `SELECT id, account_id, op_date, label, reference, amount, match_key, matched_at FROM bank_lines
         WHERE store_id = ? AND account_id = ? AND deleted = 0 AND (? IS NULL OR op_date <= ?) ORDER BY op_date, created_at, id`,
      )
      .all(storeId, accountId, to ?? null, to ?? null) as BankLine[];
  }

  /** Ajoute les lignes d'un relevé ; une ligne déjà importée (même date, montant, libellé, référence) est ignorée. */
  importLines(ctx: Context, accountId: string, lines: StatementLine[]): { added: number; duplicates: number } {
    this.requireAccount(accountId);
    const seen = new Map<string, number>();
    let added = 0;
    let duplicates = 0;
    this.tx(() => {
      // Identifiant tiré de l'empreinte : le même relevé importé sur deux PC donne les mêmes lignes.
      // Une ligne supprimée puis réimportée revient.
      const insert = this.db.prepare(
        `INSERT INTO bank_lines (id, store_id, account_id, op_date, label, reference, amount, import_key, user_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET deleted = 0, updated_at = excluded.updated_at WHERE bank_lines.deleted = 1`,
      );
      for (const l of lines) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(l.date) || !Number.isSafeInteger(l.amount) || l.amount === 0) throw new AppError(`Ligne invalide : ${l.label}`, 'INVALID');
        const base = `${l.date}|${l.amount}|${l.label.trim().toLowerCase()}|${(l.reference ?? '').trim().toLowerCase()}`;
        // Deux opérations identiques le même jour dans le même relevé restent deux lignes.
        const n = (seen.get(base) ?? 0) + 1;
        seen.set(base, n);
        const importKey = `${base}#${n}`;
        const id = createHash('sha256').update(`${ctx.storeId}|${accountId}|${importKey}`).digest('hex').slice(0, 32);
        const now = this.now();
        const r = insert.run(id, ctx.storeId, accountId, l.date, l.label.trim() || 'Opération', l.reference?.trim() || null, l.amount, importKey, ctx.userId, now, now);
        if (r.changes) {
          added++;
          this.enqueue(ctx, 'bank_line', id, 'upsert', {});
        } else duplicates++;
      }
      if (added) this.audit(ctx.userId, 'bank.import', 'account', accountId, { added, duplicates });
    });
    return { added, duplicates };
  }

  /** Supprime une ligne saisie ou importée par erreur (pas si elle est pointée). */
  deleteLine(ctx: Context, id: string): void {
    const l = this.getLine(ctx.storeId, id);
    if (l.match_key) throw new AppError("Dépointez d'abord cette ligne", 'INVALID');
    this.tx(() => {
      this.db.prepare('UPDATE bank_lines SET deleted = 1, updated_at = ? WHERE id = ?').run(this.now(), id);
      this.enqueue(ctx, 'bank_line', id, 'upsert', {});
    });
  }

  private getLine(storeId: string, id: string): BankLine & { store_id: string } {
    const l = this.db.prepare('SELECT * FROM bank_lines WHERE id = ? AND deleted = 0').get(id) as (BankLine & { store_id: string }) | undefined;
    if (!l || l.store_id !== storeId) throw new AppError('Ligne de relevé introuvable', 'NOT_FOUND');
    return l;
  }

  /** Pointe une ligne du relevé avec une ligne d'écriture de même montant. */
  match(ctx: Context, lineId: string, key: string): void {
    const l = this.getLine(ctx.storeId, lineId);
    const book = this.bookLines(ctx.storeId, l.account_id).find((b) => b.key === key);
    if (!book) throw new AppError("Ligne d'écriture introuvable", 'NOT_FOUND');
    if (book.amount !== l.amount) throw new AppError(`Montants différents : relevé ${l.amount}, comptabilité ${book.amount}`, 'INVALID');
    const taken = this.db
      .prepare('SELECT id FROM bank_lines WHERE store_id = ? AND account_id = ? AND match_key = ? AND deleted = 0 AND id <> ?')
      .get(ctx.storeId, l.account_id, key, lineId);
    if (taken) throw new AppError('Cette écriture est déjà pointée avec une autre ligne du relevé', 'INVALID');
    this.setMatch(ctx, lineId, key);
  }

  unmatch(ctx: Context, lineId: string): void {
    this.getLine(ctx.storeId, lineId);
    this.setMatch(ctx, lineId, null);
  }

  private setMatch(ctx: Context, lineId: string, key: string | null): void {
    this.tx(() => {
      const now = this.now();
      this.db
        .prepare('UPDATE bank_lines SET match_key = ?, matched_at = ?, matched_by = ?, updated_at = ? WHERE id = ?')
        .run(key, key ? now : null, key ? ctx.userId : null, now, lineId);
      this.enqueue(ctx, 'bank_line', lineId, 'upsert', {});
    });
  }

  /**
   * Pointage automatique : même montant, à 10 jours d'écart au plus. Quand
   * plusieurs écritures conviennent, celle dont la pièce figure dans le
   * libellé ou la référence du relevé passe devant, puis la date la plus proche.
   */
  autoMatch(ctx: Context, accountId: string): number {
    this.requireAccount(accountId);
    const state = this.state(ctx.storeId, accountId, '9999-12-31');
    const free = new Map(state.bookOnly.map((b) => [b.key, b]));
    let count = 0;
    for (const l of [...state.bankOnly, ...state.lost]) {
      const text = `${l.label} ${l.reference ?? ''}`.toLowerCase();
      const candidates = [...free.values()]
        .filter((b) => b.amount === l.amount && Math.abs(days(b.date, l.op_date)) <= 10)
        .map((b) => ({ b, cited: b.ref && text.includes(b.ref.toLowerCase()) ? 0 : 1, gap: Math.abs(days(b.date, l.op_date)) }))
        .sort((a, b) => a.cited - b.cited || a.gap - b.gap);
      const best = candidates[0];
      if (!best) continue;
      // Deux écritures aussi plausibles l'une que l'autre : on laisse choisir l'utilisateur.
      const second = candidates[1];
      if (second && second.cited === best.cited && second.gap === best.gap) continue;
      this.setMatch(ctx, l.id, best.b.key);
      free.delete(best.b.key);
      count++;
    }
    return count;
  }

  /**
   * Passe en comptabilité une ligne du relevé absente des écritures (frais,
   * agios, intérêts, commission MoMo…) et la pointe aussitôt.
   */
  bookLine(ctx: Context, lineId: string, input: { account: string; label?: string }): void {
    const l = this.getLine(ctx.storeId, lineId);
    if (l.match_key) throw new AppError('Cette ligne est déjà pointée', 'INVALID');
    if (input.account === l.account_id) throw new AppError('Choisissez le compte de contrepartie (frais, intérêts…)', 'INVALID');
    const journal: JournalCode = l.account_id.startsWith('55') ? 'MM' : 'BQ';
    const amount = Math.abs(l.amount);
    const label = input.label?.trim() || l.label;
    const entry = this.accounting.addManualEntry(ctx, {
      journal,
      date: l.op_date,
      label,
      lines:
        l.amount < 0
          ? [
              { account: input.account, debit: amount, credit: 0 },
              { account: l.account_id, debit: 0, credit: amount },
            ]
          : [
              { account: l.account_id, debit: amount, credit: 0 },
              { account: input.account, debit: 0, credit: amount },
            ],
    });
    const book = this.bookLines(ctx.storeId, l.account_id, l.op_date).find((b) => b.ref === entry.ref && b.amount === l.amount);
    if (book) this.setMatch(ctx, lineId, book.key);
  }

  /** État de rapprochement à une date. */
  state(storeId: string, accountId: string, date?: string): Reconciliation {
    const account = this.requireAccount(accountId);
    const to = date ?? this.today();
    const book = this.bookLines(storeId, accountId, to);
    const allBook = new Map(this.bookLines(storeId, accountId).map((b) => [b.key, b]));
    const bank = this.bankLines(storeId, accountId, to);
    const matched: Reconciliation['matched'] = [];
    const lost: BankLine[] = [];
    const bankOnly: BankLine[] = [];
    const usedKeys = new Set<string>();
    for (const l of bank) {
      const b = l.match_key ? allBook.get(l.match_key) : undefined;
      if (l.match_key && (!b || b.amount !== l.amount)) lost.push(l);
      // Pointée avec une écriture postérieure à la date : encore en suspens à cette date.
      else if (b && b.date <= to) {
        matched.push({ bank: l, book: b });
        usedKeys.add(b.key);
      } else bankOnly.push(l);
    }
    // Lignes pointées avec un relevé postérieur à la date : l'écriture reste en suspens à cette date.
    // Les à-nouveaux reprennent un solde déjà rapproché : ils ne restent pas en suspens.
    const bookOnly = book.filter((b) => !usedKeys.has(b.key) && b.journal !== 'AN');
    const bookBalance = book.reduce((t, b) => t + b.amount, 0);
    const expectedBankBalance = bookBalance - bookOnly.reduce((t, b) => t + b.amount, 0) + [...bankOnly, ...lost].reduce((t, l) => t + l.amount, 0);
    return { account, date: to, bookBalance, bookOnly, bankOnly, matched, lost, expectedBankBalance };
  }
}

function days(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}
