import { Inject, Injectable } from '@nestjs/common';
import { type Db, PG } from './database';

/** Un PC qui ne s'est pas synchronisé depuis 5 minutes alors qu'une caisse y est ouverte est signalé. */
const SILENT_MS = 5 * 60_000;

const METHODS: Record<string, string> = {
  CASH: 'Espèces',
  MTN_MOMO: 'MTN MoMo',
  ORANGE_MONEY: 'Orange Money',
  CARD: 'Carte',
  BANK_TRANSFER: 'Virement',
  CHEQUE: 'Chèque',
  CUSTOMER_CREDIT: 'Crédit client',
  VOUCHER: "Bon d'achat",
  LOYALTY: 'Points fidélité',
};

type Json = Record<string, unknown>;
const num = (v: unknown) => Number(v ?? 0) || 0;
const str = (v: unknown) => (v === null || v === undefined ? null : String(v));

/** Début d'une journée (AAAA-MM-JJ) à l'heure du PC du serveur. */
function dayStart(day: string): Date {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y!, m! - 1, d!, 0, 0, 0, 0);
}

function localDay(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export interface ManagerAlert {
  level: 'erreur' | 'alerte';
  store: string | null;
  text: string;
}

/**
 * Tableau de bord du gérant, fait pour le téléphone : ventes de la journée,
 * caisses ouvertes et fermées, écarts de caisse, ruptures de stock et
 * alertes, par magasin. Tout est relu dans le journal des opérations reçues
 * des PC (dernier état de chaque fiche).
 */
@Injectable()
export class ManagerService {
  constructor(@Inject(PG) private readonly pg: Db) {}

  /** Dernier état de chaque fiche d'une entité, avec les seuls champs demandés. */
  private async latest(entity: string, fields: string[], extra = '', params: unknown[] = []): Promise<(Json & { entity_id: string; store_id: string | null })[]> {
    const cols = fields.map((f) => `payload->'${f}' AS "${f}"`).join(', ');
    const { rows } = await this.pg.query<Json & { entity_id: string; store_id: string | null; deleted: boolean }>(
      `SELECT DISTINCT ON (entity_id) entity_id, store_id, op = 'delete' AS deleted${cols ? `, ${cols}` : ''} FROM events
       WHERE entity = $1 ${extra} ORDER BY entity_id, seq DESC`,
      [entity, ...params],
    );
    return rows.filter((r) => !r.deleted);
  }

  async dashboard(day?: string) {
    const today = localDay(new Date());
    const wanted = day && /^\d{4}-\d{2}-\d{2}$/.test(day) && day <= today ? day : today;
    const from = dayStart(wanted);
    const to = new Date(from.getTime() + 86_400_000);
    const before = new Date(from.getTime() - 86_400_000);

    const stores = (await this.latest('store', ['name', 'code', 'active'])).filter((s) => s['active'] !== 0);
    const users = new Map((await this.latest('user', ['name'])).map((u) => [u.entity_id, String(u['name'] ?? '')]));
    const registers = (await this.latest('register', ['name', 'number', 'store_id', 'active', 'kind'])).filter((r) => r['active'] !== 0);
    const { rows: devices } = await this.pg.query<{ name: string; store_id: string; register_id: string; last_seen_at: Date | null; app_version: string | null }>(
      "SELECT name, store_id, register_id, last_seen_at, app_version FROM devices WHERE revoked_at IS NULL AND kind = 'pc'",
    );

    // Ventes de la journée et de la veille (dernier état de chaque ticket).
    const { rows: sales } = await this.pg.query<{ store_id: string | null; payload: Json }>(
      `SELECT DISTINCT ON (entity_id) store_id, payload FROM events
       WHERE entity = 'sale' AND payload IS NOT NULL AND payload->>'created_at' >= $1 AND payload->>'created_at' < $2
       ORDER BY entity_id, seq DESC`,
      [before.toISOString(), to.toISOString()],
    );
    const live = sales.filter((s) => s.payload['status'] !== 'cancelled');

    // Journées de caisse ouvertes, ou fermées ce jour-là.
    const sessions = (
      await this.latest(
        'cash_session',
        ['register_id', 'store_id', 'user_id', 'status', 'opened_at', 'closed_at', 'closed_by', 'expected_cash', 'counted_cash', 'difference', 'gap_reason'],
        "AND received_at >= $2",
        [new Date(from.getTime() - 40 * 86_400_000)],
      )
    ).filter((s) => s['status'] === 'open' || (str(s['closed_at']) ?? '') >= from.toISOString());

    // Stock du magasin : somme des dépôts, articles actifs.
    const warehouses = new Map((await this.latest('warehouse', ['store_id'])).map((w) => [w.entity_id, String(w['store_id'] ?? '')]));
    const articles = new Map(
      (await this.latest('article', ['name', 'active', 'alert_qty', 'unit'])).filter((a) => a['active'] !== 0).map((a) => [a.entity_id, a]),
    );
    const levels = await this.latest('stock_level', ['warehouse_id', 'article_id', 'qty']);
    const stock = new Map<string, number>();
    for (const l of levels) {
      const store = warehouses.get(String(l['warehouse_id']));
      if (!store || !articles.has(String(l['article_id']))) continue;
      const key = `${store}:${l['article_id']}`;
      stock.set(key, (stock.get(key) ?? 0) + num(l['qty']));
    }

    const now = Date.now();
    const alerts: ManagerAlert[] = [];
    const versions = devices.map((d) => d.app_version).filter((v): v is string => Boolean(v));
    const newest = versions.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0];

    const result = stores
      .map((st) => {
        const storeId = st.entity_id;
        const name = String(st['name'] ?? '');
        const mine = live.filter((s) => (s.store_id ?? s.payload['store_id']) === storeId);
        const dayOf = (s: { payload: Json }) => String(s.payload['created_at']) >= from.toISOString();
        const todays = mine.filter(dayOf);
        const salesOnly = todays.filter((s) => s.payload['kind'] !== 'return');
        const returns = todays.filter((s) => s.payload['kind'] === 'return').reduce((t, s) => t + Math.abs(num(s.payload['total_ttc'])), 0);
        const total = salesOnly.reduce((t, s) => t + num(s.payload['total_ttc']), 0);
        const yesterday = mine.filter((s) => !dayOf(s) && s.payload['kind'] !== 'return').reduce((t, s) => t + num(s.payload['total_ttc']), 0);

        // Ventes par vendeur : le vendeur du panier ou de la facture, sinon le caissier.
        const bySeller = new Map<string, { id: string; name: string; tickets: number; total: number }>();
        for (const s of salesOnly) {
          const id = String(s.payload['seller_id'] ?? s.payload['user_id'] ?? '');
          const cur = bySeller.get(id) ?? { id, name: users.get(id) ?? 'Inconnu', tickets: 0, total: 0 };
          cur.tickets++;
          cur.total += num(s.payload['total_ttc']);
          bySeller.set(id, cur);
        }
        const byMethod = new Map<string, number>();
        const byHour = new Array<number>(24).fill(0);
        const byArticle = new Map<string, { label: string; qty: number; total: number }>();
        for (const s of salesOnly) {
          for (const p of (s.payload['payments'] as Json[] | undefined) ?? []) {
            const m = String(p['method']);
            byMethod.set(m, (byMethod.get(m) ?? 0) + num(p['amount']) - (m === 'CASH' ? num(s.payload['change_given']) : 0));
          }
          byHour[new Date(String(s.payload['created_at'])).getHours()]! += num(s.payload['total_ttc']);
          for (const l of (s.payload['lines'] as Json[] | undefined) ?? []) {
            const id = String(l['article_id']);
            const cur = byArticle.get(id) ?? { label: String(l['label'] ?? ''), qty: 0, total: 0 };
            cur.qty += num(l['qty']);
            cur.total += num(l['total_ttc']);
            byArticle.set(id, cur);
          }
        }

        const regs = registers
          .filter((r) => r['store_id'] === storeId)
          .sort((a, b) => num(a['number']) - num(b['number']))
          .map((r) => {
            const open = sessions.find((x) => x['register_id'] === r.entity_id && x['status'] === 'open');
            const closed = sessions
              .filter((x) => x['register_id'] === r.entity_id && x['status'] === 'closed')
              .sort((a, b) => String(b['closed_at']).localeCompare(String(a['closed_at'])))[0];
            const regSales = salesOnly.filter((s) => s.payload['register_id'] === r.entity_id);
            const device = devices.find((d) => d.register_id === r.entity_id);
            const lastSeen = device?.last_seen_at ? new Date(device.last_seen_at).getTime() : null;
            const silent = Boolean(open && wanted === today && (lastSeen === null || now - lastSeen > SILENT_MS));
            if (silent) alerts.push({ level: 'alerte', store: name, text: `${r['name']} : caisse ouverte mais le PC ne donne plus de nouvelles depuis ${lastSeen ? Math.round((now - lastSeen) / 60_000) + ' min' : 'longtemps'}` });
            return {
              id: r.entity_id,
              name: String(r['name'] ?? ''),
              kind: String(r['kind'] ?? 'cash'),
              state: open ? 'open' : closed ? 'closed' : 'idle',
              cashier: open ? (users.get(String(open['user_id'])) ?? null) : closed ? (users.get(String(closed['closed_by'] ?? closed['user_id'])) ?? null) : null,
              openedAt: open ? str(open['opened_at']) : null,
              closedAt: !open && closed ? str(closed['closed_at']) : null,
              sales: regSales.length,
              total: regSales.reduce((t, s) => t + num(s.payload['total_ttc']), 0),
              lastSale: regSales.map((s) => String(s.payload['created_at'])).sort().at(-1) ?? null,
              lastSeen: device?.last_seen_at ?? null,
              silent,
              device: device?.name ?? null,
              version: device?.app_version ?? null,
            };
          });

        const gaps = sessions
          .filter((x) => x['status'] === 'closed' && (x['store_id'] ?? storeId) === storeId && regs.some((r) => r.id === x['register_id']) && num(x['difference']) !== 0)
          .map((x) => ({
            register: regs.find((r) => r.id === x['register_id'])?.name ?? '',
            cashier: users.get(String(x['closed_by'] ?? x['user_id'])) ?? null,
            closedAt: str(x['closed_at']),
            expected: num(x['expected_cash']),
            counted: num(x['counted_cash']),
            difference: num(x['difference']),
            reason: str(x['gap_reason']),
          }))
          .sort((a, b) => Math.abs(b.difference) - Math.abs(a.difference));
        for (const g of gaps) {
          if (g.difference < 0) alerts.push({ level: 'erreur', store: name, text: `${g.register} : manque de ${Math.abs(g.difference).toLocaleString('fr-FR')} FCFA à la clôture${g.cashier ? ` (${g.cashier})` : ''}` });
        }

        const outs: { name: string; qty: number; alert: number; unit: string }[] = [];
        const low: { name: string; qty: number; alert: number; unit: string }[] = [];
        for (const [key, qty] of stock) {
          const [sid, articleId] = key.split(':');
          if (sid !== storeId) continue;
          const a = articles.get(articleId!)!;
          const row = { name: String(a['name'] ?? ''), qty, alert: num(a['alert_qty']), unit: String(a['unit'] ?? 'piece') };
          if (qty <= 0) outs.push(row);
          else if (row.alert > 0 && qty <= row.alert) low.push(row);
        }
        outs.sort((a, b) => a.name.localeCompare(b.name, 'fr'));
        low.sort((a, b) => a.qty / a.alert - b.qty / b.alert);
        if (outs.length) alerts.push({ level: 'alerte', store: name, text: `${outs.length} article(s) en rupture de stock` });

        return {
          id: storeId,
          name,
          sales: salesOnly.length,
          total,
          returns,
          net: total - returns,
          average: salesOnly.length ? Math.round(total / salesOnly.length) : 0,
          yesterday,
          byMethod: [...byMethod.entries()].filter(([, v]) => v).map(([method, amount]) => ({ method, label: METHODS[method] ?? method, amount })).sort((a, b) => b.amount - a.amount),
          byHour,
          top: [...byArticle.values()].sort((a, b) => b.total - a.total).slice(0, 10),
          sellers: [...bySeller.values()].sort((a, b) => b.total - a.total),
          registers: regs,
          gaps,
          outOfStock: outs.slice(0, 100),
          outOfStockCount: outs.length,
          lowStock: low.slice(0, 100),
          lowStockCount: low.length,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name, 'fr'));

    if (newest) {
      const late = devices.filter((d) => d.app_version && d.app_version !== newest);
      if (late.length) alerts.push({ level: 'alerte', store: null, text: `${late.length} PC pas encore en version ${newest} : ${late.map((d) => d.name).join(', ')}` });
    }

    return {
      day: wanted,
      today: wanted === today,
      generatedAt: new Date().toISOString(),
      total: result.reduce((t, s) => t + s.net, 0),
      sales: result.reduce((t, s) => t + s.sales, 0),
      stores: result,
      alerts: alerts.sort((a, b) => (a.level === b.level ? 0 : a.level === 'erreur' ? -1 : 1)),
    };
  }

  /**
   * Chiffre d'affaires du magasin par jour, du début du mois dernier à
   * aujourd'hui : la semaine, le mois en cours et le même nombre de jours
   * du mois dernier, pour le gérant sur son téléphone.
   */
  async periods(storeId: string) {
    const now = new Date();
    const today = localDay(now);
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const { rows } = await this.pg.query<{ created_at: string; total: string | null; kind: string | null }>(
      `SELECT payload->>'created_at' AS created_at, payload->>'total_ttc' AS total, payload->>'kind' AS kind FROM (
         SELECT DISTINCT ON (entity_id) payload FROM events
         WHERE entity = 'sale' AND payload IS NOT NULL AND COALESCE(store_id, payload->>'store_id') = $1 AND payload->>'created_at' >= $2
         ORDER BY entity_id, seq DESC) s
       WHERE payload->>'status' <> 'cancelled'`,
      [storeId, lastMonthStart.toISOString()],
    );
    const byDay = new Map<string, { total: number; tickets: number }>();
    for (const r of rows) {
      const d = localDay(new Date(r.created_at));
      const cur = byDay.get(d) ?? { total: 0, tickets: 0 };
      const amount = num(r.total);
      cur.total += r.kind === 'return' ? -Math.abs(amount) : amount;
      if (r.kind !== 'return') cur.tickets++;
      byDay.set(d, cur);
    }
    const week = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6 + i);
      const day = localDay(d);
      return { day, ...(byDay.get(day) ?? { total: 0, tickets: 0 }) };
    });
    const sum = (from: Date, to: string) => {
      let total = 0;
      let tickets = 0;
      for (const [d, v] of byDay) {
        if (d < localDay(from) || d > to) continue;
        total += v.total;
        tickets += v.tickets;
      }
      return { total, tickets };
    };
    // Même jour du mois dernier (le 31 devient le dernier jour d'un mois plus court).
    const sameDay = new Date(now.getFullYear(), now.getMonth() - 1, Math.min(now.getDate(), new Date(now.getFullYear(), now.getMonth(), 0).getDate()));
    return { today, week, month: sum(monthStart, today), lastMonth: sum(lastMonthStart, localDay(sameDay)) };
  }
}
