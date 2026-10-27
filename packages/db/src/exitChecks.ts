import { type Fcfa, type Milli, formatQty } from '@superette/core';
import type { AdminService } from './admin';
import type { Db } from './database';
import { DELIVERY_FEE_ARTICLE_ID } from './deliveries';
import type { PosService } from './pos';
import { AppError, Base, type Clock, type Context, newId } from './util';

export interface ExitCheck {
  id: string;
  sale_id: string;
  sale_number: string;
  status: 'ok' | 'problem';
  note: string | null;
  /** Le ticket avait déjà été contrôlé avant celui-ci. */
  repeat: number;
  user_name: string | null;
  source: string;
  created_at: string;
}

export interface ExitTicket {
  sale: { id: string; number: string; created_at: string; total_ttc: Fcfa; status: string; kind: string; customer_name: string | null; user_name: string; store_id: string };
  /** Articles payés (moins ce qui a été rapporté au magasin) : ce que le client doit avoir dans son sac. */
  lines: { label: string; qty: Milli; text: string }[];
  checks: ExitCheck[];
  /** Ce qui doit alerter le vigile ; `stop` : le client ne sort pas avec ce ticket. */
  warnings: string[];
  verdict: 'ok' | 'warn' | 'stop';
}

const SELECT = `SELECT x.id, x.sale_id, x.sale_number, x.status, x.note, x.repeat, u.name AS user_name, x.source, x.created_at
  FROM exit_checks x LEFT JOIN users u ON u.id = x.user_id`;

/**
 * Contrôle à la sortie : le vigile scanne le code-barres du ticket (téléphone
 * ou PC à la porte). Il voit les articles payés, marque le ticket contrôlé ;
 * un ticket déjà contrôlé, ancien, annulé ou d'un retour est signalé.
 */
export class ExitCheckService extends Base {
  constructor(
    db: Db,
    clock: Clock,
    private readonly admin: AdminService,
    private readonly pos: PosService,
  ) {
    super(db, clock);
  }

  lookup(storeId: string, raw: string): ExitTicket {
    const code = raw.trim().toUpperCase();
    if (!code) throw new AppError('Scannez le code-barres du ticket, ou tapez son numéro', 'INVALID');
    const sale = this.pos.findSaleByNumber(code);
    if (!sale) throw new AppError(`Aucun ticket n° ${code} : faites vérifier par la caisse`, 'NOT_FOUND');
    const returned = new Map<number, Milli>();
    for (const r of this.db
      .prepare("SELECT l.line_no, -SUM(l.qty) AS qty FROM sale_lines l JOIN sales s ON s.id = l.sale_id WHERE s.original_sale_id = ? AND s.status = 'completed' GROUP BY l.line_no")
      .all(sale.id) as { line_no: number; qty: Milli }[])
      returned.set(r.line_no, r.qty);
    const lines = sale.lines
      .filter((l) => l.article_id !== DELIVERY_FEE_ARTICLE_ID)
      .map((l) => {
        const qty = l.qty - (returned.get(l.line_no) ?? 0);
        const packs = l.pack_name && l.pack_units ? qty / l.pack_units : null;
        const text = packs && Number.isInteger(packs) ? `${packs} ${l.pack_name}` : formatQty(qty, l.unit);
        return { label: l.label, qty, text };
      })
      .filter((l) => l.qty > 0);
    const checks = this.forSale(sale.id);
    const warnings: string[] = [];
    let verdict: ExitTicket['verdict'] = 'ok';
    const stop = (w: string) => (warnings.push(w), (verdict = 'stop'));
    const warn = (w: string) => (warnings.push(w), verdict === 'ok' && (verdict = 'warn'));
    if (sale.store_id !== storeId) stop('Ticket d’un autre magasin');
    if (sale.status !== 'completed') stop('Ticket ANNULÉ : la vente n’existe plus');
    if (sale.kind === 'return') stop('C’est un ticket de RETOUR, pas un achat');
    if (sale.status === 'completed' && sale.kind === 'sale' && !lines.length) stop('Tous les articles de ce ticket ont été rapportés au magasin');
    if (checks.length) warn(`Ticket DÉJÀ CONTRÔLÉ le ${new Date(checks[0]!.created_at).toLocaleString('fr-FR', { timeZone: 'Africa/Douala', dateStyle: 'short', timeStyle: 'short' })}${checks[0]!.user_name ? ` par ${checks[0]!.user_name}` : ''}`);
    const hours = this.admin.storeSettings(storeId).exitCheckHours;
    const age = (this.clock().getTime() - Date.parse(sale.created_at)) / 3_600_000;
    if (age > hours) warn(`Ticket ancien : payé il y a ${age < 48 ? `${Math.floor(age)} h` : `${Math.floor(age / 24)} jours`}`);
    const { lines: _l, payments: _p, ...head } = sale;
    return {
      sale: { id: head.id, number: head.number, created_at: head.created_at, total_ttc: head.total_ttc, status: head.status, kind: head.kind, customer_name: head.customer_name, user_name: head.user_name, store_id: head.store_id },
      lines,
      checks,
      warnings,
      verdict,
    };
  }

  forSale(saleId: string): ExitCheck[] {
    return this.db.prepare(`${SELECT} WHERE x.sale_id = ? ORDER BY x.created_at`).all(saleId) as ExitCheck[];
  }

  /** Le vigile valide la sortie (« ok ») ou note un problème (article en trop, ticket douteux). */
  record(ctx: Context, saleId: string, input: { status: 'ok' | 'problem'; note?: string | null; source?: 'pc' | 'phone' }): ExitCheck {
    const sale = this.pos.getSale(saleId);
    if (sale.store_id !== ctx.storeId) throw new AppError('Ticket d’un autre magasin', 'FORBIDDEN');
    if (input.status !== 'ok' && input.status !== 'problem') throw new AppError('Résultat du contrôle invalide', 'INVALID');
    const note = input.note?.trim().slice(0, 300) || null;
    if (input.status === 'problem' && !note) throw new AppError('Dites ce qui ne va pas (article en trop, ticket douteux…)', 'INVALID');
    const repeat = this.forSale(saleId).length > 0 ? 1 : 0;
    const id = newId();
    const now = this.now();
    this.tx(() => {
      this.db
        .prepare('INSERT INTO exit_checks (id, store_id, sale_id, sale_number, status, note, repeat, user_id, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, ctx.storeId, saleId, sale.number, input.status, note, repeat, ctx.userId, input.source === 'phone' ? 'phone' : 'pc', now, now);
      this.enqueue(ctx, 'exit_check', id, 'upsert', {});
      if (input.status === 'problem' || repeat) this.audit(ctx.userId, 'exit.problem', 'sale', saleId, { number: sale.number, note, repeat });
    });
    return this.db.prepare(`${SELECT} WHERE x.id = ?`).get(id) as ExitCheck;
  }

  /** Contrôles d'une période : tous, ou seulement les problèmes et tickets présentés deux fois. */
  list(storeId: string, opts: { from?: string | null; to?: string | null; problems?: boolean } = {}): (ExitCheck & { total_ttc: Fcfa; cashier: string | null })[] {
    return this.db
      .prepare(
        `SELECT x.id, x.sale_id, x.sale_number, x.status, x.note, x.repeat, u.name AS user_name, x.source, x.created_at, s.total_ttc, c.name AS cashier
         FROM exit_checks x LEFT JOIN users u ON u.id = x.user_id LEFT JOIN sales s ON s.id = x.sale_id LEFT JOIN users c ON c.id = s.user_id
         WHERE x.store_id = @storeId AND (@from IS NULL OR date(x.created_at, 'localtime') >= @from) AND (@to IS NULL OR date(x.created_at, 'localtime') <= @to)
           AND (@problems = 0 OR x.status = 'problem' OR x.repeat = 1)
         ORDER BY x.created_at DESC LIMIT 2000`,
      )
      .all({ storeId, from: opts.from ?? null, to: opts.to ?? null, problems: opts.problems ? 1 : 0 }) as never;
  }

  /** Part des tickets du jour contrôlés à la sortie. */
  coverage(storeId: string, day: string): { tickets: number; checked: number; problems: number } {
    const r = this.db
      .prepare(
        `SELECT COUNT(DISTINCT s.id) AS tickets, COUNT(DISTINCT x.sale_id) AS checked FROM sales s LEFT JOIN exit_checks x ON x.sale_id = s.id
         WHERE s.store_id = ? AND s.kind = 'sale' AND s.status = 'completed' AND date(s.created_at, 'localtime') = ?`,
      )
      .get(storeId, day) as { tickets: number; checked: number };
    const problems = this.db
      .prepare("SELECT COUNT(*) FROM exit_checks WHERE store_id = ? AND date(created_at, 'localtime') = ? AND (status = 'problem' OR repeat = 1)")
      .pluck()
      .get(storeId, day) as number;
    return { tickets: r.tickets, checked: r.checked, problems };
  }
}
