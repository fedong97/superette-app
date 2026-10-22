import { Inject, Injectable } from '@nestjs/common';
import { type Db, PG } from './database';
import { type VapidKeys, generateVapidKeys, sendPush } from './webpush';

/** Sortes d'alertes que le gérant choisit de recevoir sur son téléphone. */
export const ALERT_KINDS = {
  approval: 'Demandes d’accord des caisses',
  gap: 'Écarts de caisse à la clôture',
  discount: 'Grosses remises',
  cancel: 'Tickets annulés',
  stockout: 'Ruptures de stock',
  silent: 'PC qui ne donnent plus de nouvelles',
  staff: 'Retards et absences du personnel',
} as const;
export type AlertKind = keyof typeof ALERT_KINDS;

export interface PhoneAlert {
  /** Clé stable : la même alerte n'est montrée et envoyée qu'une fois. */
  key: string;
  kind: AlertKind;
  store: string | null;
  title: string;
  text: string;
  at: string;
  /** Remise : part du ticket en pour cent (le téléphone garde celles au-dessus de son seuil). */
  pct?: number;
}

type Json = Record<string, unknown>;
const num = (v: unknown) => Number(v ?? 0) || 0;
const fcfa = (n: number) => `${Math.round(n).toLocaleString('fr-FR')} FCFA`;
/** Un PC dont la caisse est ouverte et qui n'a pas synchronisé depuis 5 minutes. */
const SILENT_MS = 5 * 60_000;

/**
 * Alertes du gérant : relues dans le journal des opérations reçues des PC
 * (écarts, remises, annulations, ruptures), plus les PC muets et les
 * demandes d'accord. La page ouverte les affiche avec un son ; un téléphone
 * abonné (serveur en HTTPS) les reçoit en notification, page fermée.
 */
@Injectable()
export class AlertsService {
  private timer: NodeJS.Timeout | null = null;
  private cursor: number | null = null;
  private readonly sent = new Set<string>();

  constructor(@Inject(PG) private readonly pg: Db) {}

  start(intervalMs = 15_000) {
    this.timer = setInterval(() => void this.tick().catch(() => undefined), intervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async lastSeq(): Promise<number> {
    const { rows } = await this.pg.query<{ seq: string | null }>('SELECT MAX(seq) AS seq FROM events');
    return Number(rows[0]?.seq ?? 0);
  }

  private async names(entity: string, ids: string[]): Promise<Map<string, Json>> {
    if (!ids.length) return new Map();
    const { rows } = await this.pg.query<{ entity_id: string; payload: Json }>(
      `SELECT DISTINCT ON (entity_id) entity_id, payload FROM events WHERE entity = $1 AND entity_id = ANY($2) AND payload IS NOT NULL ORDER BY entity_id, seq DESC`,
      [entity, [...new Set(ids)]],
    );
    return new Map(rows.map((r) => [r.entity_id, r.payload]));
  }

  /**
   * Alertes nées depuis `since` (numéro d'opération). Sans `since`, rien du
   * passé : seulement le curseur, les PC muets et les demandes en attente.
   */
  async feed(since?: number): Promise<{ cursor: number; alerts: PhoneAlert[] }> {
    const cursor = await this.lastSeq();
    const alerts: PhoneAlert[] = [];
    if (since !== undefined && since < cursor) alerts.push(...(await this.fromEvents(since, cursor)));
    alerts.push(...(await this.silent()));
    return { cursor, alerts };
  }

  private async fromEvents(since: number, upTo: number): Promise<PhoneAlert[]> {
    const { rows } = await this.pg.query<{ seq: string; entity: string; entity_id: string; store_id: string | null; payload: Json; created_at: Date; first: boolean; was: Json | null }>(
      `SELECT e.seq, e.entity, e.entity_id, e.store_id, e.payload, e.created_at,
         NOT EXISTS (SELECT 1 FROM events p WHERE p.entity = e.entity AND p.entity_id = e.entity_id AND p.seq < e.seq) AS first,
         (SELECT p.payload FROM events p WHERE p.entity = e.entity AND p.entity_id = e.entity_id AND p.seq < e.seq ORDER BY p.seq DESC LIMIT 1) AS was
       FROM events e WHERE e.seq > $1 AND e.seq <= $2 AND e.op = 'upsert' AND e.entity IN ('cash_session', 'sale', 'stock_level', 'staff_alert') ORDER BY e.seq LIMIT 2000`,
      [since, upTo],
    );
    if (!rows.length) return [];
    const stores = await this.names('store', rows.map((r) => String(r.store_id ?? r.payload['store_id'] ?? '')));
    const registers = await this.names('register', rows.map((r) => String(r.payload['register_id'] ?? '')));
    const users = await this.names('user', rows.flatMap((r) => [String(r.payload['user_id'] ?? ''), String(r.payload['closed_by'] ?? '')]));
    const articles = await this.names('article', rows.filter((r) => r.entity === 'stock_level').map((r) => String(r.payload['article_id'] ?? '')));
    const warehouses = await this.names('warehouse', rows.filter((r) => r.entity === 'stock_level').map((r) => String(r.payload['warehouse_id'] ?? '')));
    const name = (m: Map<string, Json>, id: unknown) => (id ? String(m.get(String(id))?.['name'] ?? '') : '');
    const out: PhoneAlert[] = [];
    for (const r of rows) {
      const p = r.payload;
      const at = new Date(r.created_at).toISOString();
      const storeName = name(stores, r.store_id ?? p['store_id']) || null;
      if (r.entity === 'cash_session') {
        const closedNow = p['status'] === 'closed' && r.was?.['status'] !== 'closed';
        const diff = num(p['difference']);
        if (closedNow && diff !== 0) {
          const who = name(users, p['closed_by'] ?? p['user_id']);
          out.push({ key: `gap:${r.entity_id}`, kind: 'gap', store: storeName, title: diff < 0 ? 'Manque en caisse' : 'Excédent en caisse', text: `${name(registers, p['register_id'])} : ${diff > 0 ? '+' : ''}${fcfa(diff)} à la clôture${who ? ` (${who})` : ''}`, at });
        }
      } else if (r.entity === 'sale') {
        const who = name(users, p['user_id']);
        if (p['status'] === 'cancelled' && r.was?.['status'] !== 'cancelled') {
          out.push({ key: `cancel:${r.entity_id}`, kind: 'cancel', store: storeName, title: 'Ticket annulé', text: `${String(p['number'] ?? '')} : ${fcfa(Math.abs(num(p['total_ttc'])))}${who ? ` (${who})` : ''}`, at });
        }
        const discount = num(p['total_discount']);
        if (r.first && p['kind'] !== 'return' && discount > 0) {
          const pct = Math.round((discount / Math.max(1, num(p['total_ttc']) + discount)) * 100);
          out.push({ key: `discount:${r.entity_id}`, kind: 'discount', store: storeName, title: `Remise de ${pct} %`, text: `${String(p['number'] ?? '')} : ${fcfa(discount)} de remise sur ${fcfa(num(p['total_ttc']) + discount)}${who ? ` (${who})` : ''}`, at, pct });
        }
      } else if (r.entity === 'staff_alert') {
        // Levée par le PC du magasin d'après l'horaire prévu ; une seule fois par personne, jour et sorte.
        if (r.first) out.push({ key: `staff:${r.entity_id}`, kind: 'staff', store: storeName, title: p['kind'] === 'absent' ? 'Absence du personnel' : 'Retard du personnel', text: String(p['text'] ?? ''), at });
      } else if (num(p['qty']) <= 0 && (r.first || num(r.was?.['qty']) > 0)) {
        const article = name(articles, p['article_id']);
        if (!article) continue;
        const store = name(stores, warehouses.get(String(p['warehouse_id']))?.['store_id']) || storeName;
        out.push({ key: `stockout:${r.entity_id}:${r.seq}`, kind: 'stockout', store, title: 'Rupture de stock', text: `${article} : plus rien en stock (${name(warehouses, p['warehouse_id'])})`, at });
      }
    }
    return out;
  }

  /** PC dont la caisse est ouverte mais qui ne se synchronise plus. */
  private async silent(): Promise<PhoneAlert[]> {
    const { rows } = await this.pg.query<{ id: string; name: string; store_id: string; register_id: string; last_seen_at: Date | null }>(
      "SELECT id, name, store_id, register_id, last_seen_at FROM devices WHERE revoked_at IS NULL AND kind = 'pc' AND (last_seen_at IS NULL OR last_seen_at < $1)",
      [new Date(Date.now() - SILENT_MS)],
    );
    if (!rows.length) return [];
    const { rows: open } = await this.pg.query<{ register_id: string }>(
      `SELECT payload->>'register_id' AS register_id FROM (SELECT DISTINCT ON (entity_id) payload FROM events WHERE entity = 'cash_session' AND payload->>'register_id' = ANY($1) ORDER BY entity_id, seq DESC) s
       WHERE payload->>'status' = 'open'`,
      [rows.map((r) => r.register_id)],
    );
    const stores = await this.names('store', rows.map((r) => r.store_id));
    return rows
      .filter((d) => open.some((o) => o.register_id === d.register_id))
      .map((d) => {
        const since = d.last_seen_at ? new Date(d.last_seen_at) : null;
        return {
          key: `silent:${d.id}:${since?.toISOString() ?? ''}`,
          kind: 'silent' as const,
          store: String(stores.get(d.store_id)?.['name'] ?? '') || null,
          title: 'PC muet',
          text: `${d.name} : caisse ouverte mais plus de nouvelles depuis ${since ? since.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : 'longtemps'}`,
          at: new Date().toISOString(),
        };
      });
  }

  // ——— Notifications sur le téléphone (Web Push) ———

  async vapid(): Promise<VapidKeys> {
    const { rows } = await this.pg.query<{ value: string }>("SELECT value FROM settings WHERE key = 'push_vapid'");
    if (rows[0]) return JSON.parse(rows[0].value) as VapidKeys;
    const keys = generateVapidKeys();
    await this.pg.query("INSERT INTO settings (key, value) VALUES ('push_vapid', $1) ON CONFLICT (key) DO NOTHING", [JSON.stringify(keys)]);
    return this.vapid();
  }

  async subscribe(input: { subscription: { endpoint: string; keys: { p256dh: string; auth: string } }; kinds: string[]; discountPct?: number }, origin: string) {
    const sub = input?.subscription;
    if (!sub?.endpoint?.startsWith('https://') || !sub.keys?.p256dh || !sub.keys?.auth) throw new Error('Abonnement invalide');
    const kinds = (input.kinds ?? []).filter((k) => k in ALERT_KINDS);
    const pct = Math.min(100, Math.max(1, Math.round(num(input.discountPct) || 20)));
    await this.pg.query(
      `INSERT INTO push_subscriptions (endpoint, p256dh, auth, kinds, discount_pct, origin) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (endpoint) DO UPDATE SET p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth, kinds = EXCLUDED.kinds, discount_pct = EXCLUDED.discount_pct, origin = EXCLUDED.origin`,
      [sub.endpoint, sub.keys.p256dh, sub.keys.auth, JSON.stringify(kinds), pct, origin],
    );
    return { ok: true, kinds, discountPct: pct };
  }

  async unsubscribe(endpoint: string) {
    await this.pg.query('DELETE FROM push_subscriptions WHERE endpoint = $1', [String(endpoint ?? '')]);
    return { ok: true };
  }

  /** Envoie les alertes aux téléphones abonnés à leur sorte. */
  async notify(alerts: PhoneAlert[]) {
    const fresh = alerts.filter((a) => !this.sent.has(a.key));
    for (const a of fresh) this.sent.add(a.key);
    if (this.sent.size > 5000) this.sent.clear();
    if (!fresh.length) return 0;
    const { rows } = await this.pg.query<{ endpoint: string; p256dh: string; auth: string; kinds: string[]; discount_pct: number; origin: string }>('SELECT * FROM push_subscriptions');
    if (!rows.length) return 0;
    const keys = await this.vapid();
    let count = 0;
    for (const s of rows) {
      for (const a of fresh) {
        if (!s.kinds.includes(a.kind) || (a.kind === 'discount' && (a.pct ?? 0) < s.discount_pct)) continue;
        const payload = { title: a.store ? `${a.title} · ${a.store}` : a.title, body: a.text, tag: a.key, url: '/gerant' };
        try {
          const alive = await sendPush({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, keys, s.origin);
          if (!alive) {
            await this.unsubscribe(s.endpoint);
            break;
          }
          count++;
        } catch {
          // Service de notification injoignable : l'alerte reste visible sur la page.
        }
      }
    }
    return count;
  }

  /** Tour de veille : nouvelles alertes depuis le dernier tour, envoyées aux abonnés. */
  async tick() {
    const { rows } = await this.pg.query<{ n: string }>('SELECT COUNT(*) AS n FROM push_subscriptions');
    if (this.cursor === null || Number(rows[0]?.n ?? 0) === 0) {
      this.cursor = await this.lastSeq();
      return 0;
    }
    const { cursor, alerts } = await this.feed(this.cursor);
    this.cursor = cursor;
    return this.notify(alerts);
  }
}
