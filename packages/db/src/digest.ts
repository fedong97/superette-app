import { type Fcfa, PAYMENT_METHODS, type PaymentMethod, formatFcfa } from '@superette/core';
import type { AdminService } from './admin';
import type { AttentionService } from './attention';
import type { Db } from './database';
import type { ReportService } from './reports';
import { AppError, Base, type Clock } from './util';

/** Envoi du résumé du soir, réglé sur le PC qui l'envoie (jamais synchronisé : le mot de passe reste ici). */
export interface DigestConfig {
  enabled: boolean;
  /** Heure d'envoi, « 21:00 ». */
  hour: string;
  /** Adresses e-mail des destinataires, séparées par des virgules. */
  emails: string;
  /** Numéro WhatsApp du gérant, pour l'envoi depuis l'écran. */
  whatsapp: string;
  smtpHost: string;
  smtpPort: number;
  smtpUser: string;
}

export const DEFAULT_DIGEST_CONFIG: DigestConfig = { enabled: false, hour: '21:00', emails: '', whatsapp: '', smtpHost: 'smtp.gmail.com', smtpPort: 465, smtpUser: '' };

/** Résumé d'une journée du magasin, envoyé le soir au gérant (e-mail ou WhatsApp). */
export interface DayDigest {
  date: string;
  storeName: string;
  tickets: number;
  revenue: Fcfa;
  averageBasket: Fcfa;
  grossMargin: Fcfa;
  returns: { count: number; amount: Fcfa };
  cancelled: { count: number; amount: Fcfa };
  payments: { method: PaymentMethod; label: string; amount: Fcfa }[];
  sessions: { closed: number; open: number; gaps: { register: string; user: string; difference: Fcfa }[] };
  expenses: Fcfa;
  customerPayments: Fcfa;
  top: { name: string; qty: number; revenue: Fcfa }[];
  alerts: { label: string; detail: string }[];
  /** Le résumé prêt à envoyer, mis en forme pour WhatsApp (*gras*). */
  text: string;
}

const DAYS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
const frDate = (d: string) => d.split('-').reverse().join('/');
const qtyText = (milli: number) => (milli % 1000 === 0 ? String(milli / 1000) : (milli / 1000).toLocaleString('fr-FR', { maximumFractionDigits: 3 }));

export class DigestService extends Base {
  constructor(
    db: Db,
    clock: Clock,
    private readonly admin: AdminService,
    private readonly reports: ReportService,
    private readonly attention: AttentionService,
  ) {
    super(db, clock);
  }

  /** Jour civil du PC, et la veille : le résumé du soir porte sur aujourd'hui. */
  day(offset = 0): string {
    const d = this.clock();
    d.setDate(d.getDate() + offset);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  config(): DigestConfig & { hasPassword: boolean; lastSent: string | null } {
    let saved: Partial<DigestConfig> = {};
    try {
      saved = JSON.parse(this.setting('digest.config') ?? '{}') as Partial<DigestConfig>;
    } catch {
      saved = {};
    }
    return { ...DEFAULT_DIGEST_CONFIG, ...saved, hasPassword: !!this.setting('digest.smtpPass'), lastSent: this.setting('digest.lastSent') };
  }

  /** `sealedPassword` : mot de passe déjà chiffré par Windows ; absent, on garde l'actuel ; vide, on l'efface. */
  saveConfig(userId: string, input: DigestConfig, sealedPassword?: string): void {
    const hour = /^([01]\d|2[0-3]):[0-5]\d$/.test(input.hour) ? input.hour : null;
    if (!hour) throw new AppError("Heure d'envoi invalide : écrivez-la comme 21:00", 'INVALID');
    const emails = input.emails.split(/[,;\s]+/).filter(Boolean);
    const bad = emails.find((e) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e));
    if (bad) throw new AppError(`Adresse e-mail invalide : ${bad}`, 'INVALID');
    if (input.enabled && !emails.length) throw new AppError("Indiquez au moins une adresse e-mail pour l'envoi automatique", 'INVALID');
    const port = Math.trunc(Number(input.smtpPort));
    if (!(port > 0 && port < 65536)) throw new AppError('Port du serveur d’envoi invalide', 'INVALID');
    const config: DigestConfig = {
      enabled: !!input.enabled,
      hour,
      emails: emails.join(', '),
      whatsapp: input.whatsapp.replace(/[^\d+]/g, ''),
      smtpHost: input.smtpHost.trim(),
      smtpPort: port,
      smtpUser: input.smtpUser.trim(),
    };
    if (config.enabled && (!config.smtpHost || !config.smtpUser)) throw new AppError("Renseignez le serveur d'envoi et le compte e-mail", 'INVALID');
    this.tx(() => {
      this.admin.setSetting('digest.config', JSON.stringify(config));
      if (sealedPassword !== undefined) this.admin.setSetting('digest.smtpPass', sealedPassword);
      this.audit(userId, 'digest.settings', 'store', undefined, { enabled: config.enabled, hour: config.hour, emails: config.emails });
    });
  }

  sealedPassword(): string | null {
    return this.setting('digest.smtpPass') || null;
  }

  markSent(date: string): void {
    this.admin.setSetting('digest.lastSent', date);
  }

  /**
   * Jour à envoyer maintenant, ou null : aujourd'hui une fois l'heure passée ;
   * avant l'heure, la veille si elle n'est pas partie (PC éteint le soir).
   */
  due(): string | null {
    const c = this.config();
    if (!c.enabled || !c.emails || !c.smtpHost || !c.hasPassword) return null;
    const today = this.day(0);
    const now = this.clock();
    const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    if (hhmm >= c.hour) return c.lastSent === today ? null : today;
    const yesterday = this.day(-1);
    return c.lastSent && c.lastSent < yesterday ? yesterday : null;
  }

  private setting(key: string): string | null {
    return this.admin.getSetting(key);
  }

  build(storeId: string, date: string): DayDigest {
    const store = this.admin.getStore(storeId);
    const daily = this.reports.daily(storeId, date);
    const params = { storeId, date };
    const sameDay = `s.store_id = @storeId AND date(s.created_at, 'localtime') = @date`;

    const counts = this.db
      .prepare(
        `SELECT COALESCE(SUM(CASE WHEN kind = 'return' AND status = 'completed' THEN 1 END), 0) AS returnCount,
                COALESCE(SUM(CASE WHEN kind = 'return' AND status = 'completed' THEN -total_ttc END), 0) AS returnAmount,
                COALESCE(SUM(CASE WHEN status = 'cancelled' THEN 1 END), 0) AS cancelledCount,
                COALESCE(SUM(CASE WHEN status = 'cancelled' THEN total_ttc END), 0) AS cancelledAmount,
                COALESCE(SUM(CASE WHEN status = 'completed' THEN change_given END), 0) AS changeGiven
         FROM sales s WHERE ${sameDay}`,
      )
      .get(params) as { returnCount: number; returnAmount: number; cancelledCount: number; cancelledAmount: number; changeGiven: number };

    // Comme le rapport Z : les espèces reçues moins la monnaie rendue.
    const methods = this.db
      .prepare(
        `SELECT p.method, SUM(p.amount) AS amount FROM sale_payments p JOIN sales s ON s.id = p.sale_id
         WHERE ${sameDay} AND s.status = 'completed' GROUP BY p.method`,
      )
      .all(params) as { method: PaymentMethod; amount: number }[];
    const payments = methods
      .map((m) => ({
        method: m.method,
        label: PAYMENT_METHODS[m.method] ?? m.method,
        amount: m.method === 'CASH' ? m.amount - counts.changeGiven : m.amount,
      }))
      .filter((m) => m.amount !== 0)
      .sort((a, b) => b.amount - a.amount);

    const closed = this.db
      .prepare(
        `SELECT r.name AS register, u.name AS user, cs.difference FROM cash_sessions cs
         JOIN registers r ON r.id = cs.register_id JOIN users u ON u.id = cs.user_id
         WHERE cs.store_id = @storeId AND cs.status = 'closed' AND date(cs.closed_at, 'localtime') = @date
         ORDER BY r.name`,
      )
      .all(params) as { register: string; user: string; difference: number | null }[];
    const open = this.db.prepare(`SELECT COUNT(*) FROM cash_sessions WHERE store_id = ? AND status = 'open'`).pluck().get(storeId) as number;

    const expenses = this.db
      .prepare(`SELECT COALESCE(SUM(amount), 0) FROM expenses WHERE store_id = @storeId AND status = 'active' AND expense_date = @date`)
      .pluck()
      .get(params) as number;
    const customerPayments = this.db
      .prepare(`SELECT COALESCE(SUM(amount), 0) FROM customer_payments WHERE store_id = @storeId AND date(paid_at, 'localtime') = @date`)
      .pluck()
      .get(params) as number;

    const alerts = this.attention
      .list(storeId, new Set(['rupture', 'cash_gaps', 'late_customers'] as const))
      .filter((a) => a.count > 0)
      .map((a) => ({ label: a.label, detail: a.detail }));

    const digest: Omit<DayDigest, 'text'> = {
      date,
      storeName: store.name,
      tickets: daily.ticketCount,
      revenue: daily.revenueTtc,
      averageBasket: daily.averageBasket,
      grossMargin: daily.grossMargin,
      returns: { count: counts.returnCount, amount: counts.returnAmount },
      cancelled: { count: counts.cancelledCount, amount: counts.cancelledAmount },
      payments,
      sessions: {
        closed: closed.length,
        open,
        gaps: closed.filter((c) => (c.difference ?? 0) !== 0).map((c) => ({ register: c.register, user: c.user, difference: c.difference ?? 0 })),
      },
      expenses,
      customerPayments,
      top: daily.topArticles.slice(0, 5).map((t) => ({ name: t.name, qty: t.qty, revenue: t.revenueTtc })),
      alerts,
    };
    return { ...digest, text: digestText(digest) };
  }
}

function digestText(d: Omit<DayDigest, 'text'>): string {
  const weekday = DAYS[new Date(`${d.date}T12:00:00`).getDay()];
  const lines = [`*${d.storeName}* · FEDO Gestion`, `Résumé du ${weekday} ${frDate(d.date)}`, ''];
  if (d.tickets === 0) {
    lines.push('Aucune vente ce jour.');
  } else {
    lines.push(`*Ventes : ${formatFcfa(d.revenue)}*`);
    lines.push(`${d.tickets} ticket${d.tickets > 1 ? 's' : ''}, panier moyen ${formatFcfa(d.averageBasket)}`);
    lines.push(`Marge brute : ${formatFcfa(d.grossMargin)}`);
  }
  if (d.returns.count) lines.push(`Retours : ${d.returns.count} (${formatFcfa(d.returns.amount)})`);
  if (d.cancelled.count) lines.push(`Annulations : ${d.cancelled.count} (${formatFcfa(d.cancelled.amount)})`);

  if (d.payments.length) {
    lines.push('', '*Encaissements*');
    for (const p of d.payments) lines.push(`${p.label} : ${formatFcfa(p.amount)}`);
  }
  if (d.customerPayments) lines.push(`Règlements de clients : ${formatFcfa(d.customerPayments)}`);
  if (d.expenses) lines.push(`Dépenses : ${formatFcfa(d.expenses)}`);

  lines.push('', '*Caisses*');
  const state = [`${d.sessions.closed} clôturée${d.sessions.closed > 1 ? 's' : ''}`];
  if (d.sessions.open) state.push(`${d.sessions.open} encore ouverte${d.sessions.open > 1 ? 's' : ''}`);
  lines.push(state.join(', '));
  if (d.sessions.gaps.length) {
    for (const g of d.sessions.gaps) lines.push(`Écart ${g.register} (${g.user}) : ${g.difference > 0 ? '+' : ''}${formatFcfa(g.difference)}`);
  } else if (d.sessions.closed) {
    lines.push('Aucun écart à la clôture');
  }

  if (d.top.length) {
    lines.push('', '*Meilleures ventes*');
    d.top.forEach((t, i) => lines.push(`${i + 1}. ${t.name} : ${qtyText(t.qty)} (${formatFcfa(t.revenue)})`));
  }
  if (d.alerts.length) {
    lines.push('', '*À surveiller*');
    for (const a of d.alerts) lines.push(`${a.label} : ${a.detail}`);
  }
  return lines.join('\n');
}
