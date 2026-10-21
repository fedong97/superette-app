import { randomBytes, randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, HttpException, HttpStatus, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { type Db, PG } from './database';

type Json = Record<string, unknown>;

const str = (v: unknown) => (v === null || v === undefined ? '' : String(v));
const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/** Quantité d'une ligne : 1 000 unités au plus (en millièmes), 60 lignes par commande. */
const MAX_QTY = 1_000_000;
const MAX_LINES = 60;
/** Commandes en attente montrées aux postes : celles des 7 derniers jours. */
const WAITING_DAYS = 7;
/** Vignette d'un article montrée sur la boutique : les plus lourdes sont laissées de côté. */
const MAX_THUMB = 60_000;

/** Réglages de la boutique en ligne et du vérificateur de prix, lus dans la fiche du magasin. */
export interface ShopSettings {
  onlineShop: boolean;
  delivery: boolean;
  deliveryFee: number;
  minOrder: number;
  message: string;
  priceChecker: boolean;
}

export interface ShopStore {
  id: string;
  code: string;
  name: string;
  address: string | null;
  phone: string | null;
  settings: ShopSettings;
}

/** Article tel que la boutique et le vérificateur de prix le voient : prix du magasin et promotion du jour. */
export interface ShopArticle {
  id: string;
  code: string;
  name: string;
  unit: string;
  unitName: string | null;
  department: string | null;
  /** Prix payé aujourd'hui : celui de la promotion s'il y en a une, sinon le prix du magasin. */
  price: number;
  /** Prix du magasin, sans la promotion. */
  regularPrice: number;
  promoName: string | null;
  promoEnds: string | null;
  photo: boolean;
  /** Le magasin en a en stock (ou ne suit pas son stock). */
  available: boolean;
  otherRef: string | null;
  barcodes: { code: string; packQty: number }[];
  packs: { name: string; units: number; barcode: string | null; price: number }[];
}

export interface WebOrderLine {
  articleId: string;
  name: string;
  qty: number;
  price: number;
}

/** Commande de la boutique, au format des postes (FEDONIX 360 sur PC). */
export interface WebOrder {
  id: string;
  number: string;
  customerName: string;
  phone: string;
  address: string | null;
  slot: string | null;
  note: string | null;
  deliveryFee: number;
  lines: WebOrderLine[];
  total: number;
  at: string;
}

interface WebOrderRow {
  id: string;
  number: string;
  store_id: string;
  customer_name: string;
  phone: string;
  address: string | null;
  slot: string | null;
  note: string | null;
  delivery_fee: number;
  lines: WebOrderLine[] | string;
  total: number;
  status: string;
  taken_by_device: string | null;
  taken_at: Date | null;
  created_at: Date;
}

/** Paramètres du magasin : du JSON (texte) dans la fiche ; une valeur absente prend sa valeur par défaut. */
export function shopSettings(raw: unknown): ShopSettings {
  let s: Json = {};
  if (typeof raw === 'string' && raw) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === 'object') s = parsed as Json;
    } catch {
      s = {};
    }
  } else if (raw && typeof raw === 'object') s = raw as Json;
  const fcfa = (v: unknown) => Math.max(0, Math.round(num(v)));
  return {
    onlineShop: s['onlineShop'] === true,
    // Comme dans FEDONIX 360 : la livraison est proposée tant qu'elle n'est pas décochée.
    delivery: s['onlineShopDelivery'] !== false,
    deliveryFee: fcfa(s['onlineShopDeliveryFee']),
    minOrder: fcfa(s['onlineShopMinOrder']),
    message: str(s['onlineShopMessage']).slice(0, 500),
    priceChecker: s['priceChecker'] === true,
  };
}

/**
 * Numéro de téléphone camerounais : 9 chiffres commençant par 6 (mobile) ou 2 (fixe),
 * avec ou sans l'indicatif +237. Rend les 9 chiffres, ou null.
 */
export function cameroonPhone(raw: string): string | null {
  let d = raw.replace(/[\s.\-()/]/g, '');
  if (d.startsWith('+237')) d = d.slice(4);
  else if (d.startsWith('00237')) d = d.slice(5);
  else if (d.length === 12 && d.startsWith('237')) d = d.slice(3);
  return /^[62]\d{8}$/.test(d) ? d : null;
}

/** Date du jour au Cameroun (AAAA-MM-JJ), comme celle des caisses pour les promotions. */
function today(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Douala', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

/**
 * Compteur de demandes par adresse, en mémoire : au-delà de `max` dans la
 * fenêtre, la demande est refusée (429) avec un message en français.
 */
export class RateLimit {
  private readonly hits = new Map<string, { count: number; until: number }>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly message: string,
  ) {}

  /** Refuse si la limite est déjà atteinte, sans compter la demande. */
  check(key: string) {
    const h = this.hits.get(key);
    if (h && h.until > Date.now() && h.count >= this.max) throw new HttpException(this.message, HttpStatus.TOO_MANY_REQUESTS);
  }

  /** Compte une demande. */
  hit(key: string) {
    const now = Date.now();
    if (this.hits.size > 10_000) for (const [k, v] of this.hits) if (v.until <= now) this.hits.delete(k);
    const cur = this.hits.get(key);
    const h = cur && cur.until > now ? cur : { count: 0, until: now + this.windowMs };
    h.count++;
    this.hits.set(key, h);
  }

  /** Vérifie puis compte. */
  take(key: string) {
    this.check(key);
    this.hit(key);
  }
}

/**
 * Boutique en ligne du magasin (`/boutique/<code>`) et vérificateur de prix
 * (`/prix/<code>`) : pages publiques, ouvertes par les Paramètres du magasin.
 * Le catalogue, les prix du magasin, les promotions et le stock viennent du
 * journal envoyé par les PC. Une commande attend qu'un poste du magasin la
 * prenne ; le prix est toujours refait ici, jamais repris de la page.
 */
@Injectable()
export class ShopService {
  /** Catalogue calculé par magasin, refait dès que le journal avance (ou que le jour change). */
  private readonly cache = new Map<string, { key: string; articles: ShopArticle[] }>();
  readonly orderLimit = new RateLimit(10, 10 * 60_000, 'Trop de commandes envoyées depuis cette connexion : réessayez dans quelques minutes ou appelez le magasin.');
  readonly attemptLimit = new RateLimit(40, 10 * 60_000, 'Trop d’essais depuis cette connexion : réessayez dans quelques minutes.');
  readonly priceLimit = new RateLimit(120, 60_000, 'Trop de recherches : patientez une minute.');
  readonly catalogLimit = new RateLimit(60, 60_000, 'Trop de demandes : patientez une minute.');

  constructor(@Inject(PG) private readonly pg: Db) {}

  // ——— Lecture du journal ———

  /** Dernier état de chaque fiche d'une entité (les fiches supprimées sont écartées). */
  private async latest(entity: string, extra = '', params: unknown[] = [], select = 'payload'): Promise<{ entity_id: string; payload: Json }[]> {
    const { rows } = await this.pg.query<{ entity_id: string; op: string; payload: Json | null }>(
      `SELECT DISTINCT ON (entity_id) entity_id, op, ${select} AS payload FROM events
       WHERE entity = $1 ${extra} ORDER BY entity_id, seq DESC`,
      [entity, ...params],
    );
    return rows.filter((r) => r.op !== 'delete' && r.payload).map((r) => ({ entity_id: r.entity_id, payload: r.payload! }));
  }

  /** Magasin par son code (DLA1), sans tenir compte des majuscules. */
  async store(code: string): Promise<ShopStore | null> {
    const c = str(code).trim().toUpperCase();
    if (!/^[A-Z0-9_-]{1,30}$/.test(c)) return null;
    const rows = await this.latest('store');
    const row = rows.find((r) => str(r.payload['code']).trim().toUpperCase() === c && r.payload['active'] !== 0);
    if (!row) return null;
    const p = row.payload;
    return {
      id: row.entity_id,
      code: str(p['code']),
      name: str(p['name']),
      address: (p['address'] as string | null) || null,
      phone: (p['phone'] as string | null) || null,
      settings: shopSettings(p['settings']),
    };
  }

  /** Magasin dont la boutique en ligne est ouverte ; sinon 404. */
  async openShop(code: string): Promise<ShopStore> {
    const store = await this.store(code);
    if (!store?.settings.onlineShop) throw new NotFoundException('Ce magasin n’a pas de boutique en ligne ouverte.');
    return store;
  }

  /** Magasin dont le vérificateur de prix est activé ; sinon 404. */
  async priceStore(code: string): Promise<ShopStore> {
    const store = await this.store(code);
    if (!store?.settings.priceChecker) throw new NotFoundException('Le vérificateur de prix n’est pas activé pour ce magasin.');
    return store;
  }

  /** Articles vendus par le magasin, avec son prix, la promotion du jour et le stock. */
  async articles(storeId: string): Promise<ShopArticle[]> {
    const day = today();
    const { rows: v } = await this.pg.query<{ v: string | null }>('SELECT MAX(seq)::text AS v FROM events');
    const key = `${v[0]?.v ?? '0'}:${day}`;
    const cached = this.cache.get(storeId);
    if (cached?.key === key) return cached.articles;

    const departments = new Map((await this.latest('department', '', [], "jsonb_build_object('name', payload->'name')")).map((r) => [r.entity_id, str(r.payload['name'])]));
    const families = new Map((await this.latest('family', '', [], "jsonb_build_object('department_id', payload->'department_id')")).map((r) => [r.entity_id, str(r.payload['department_id'])]));
    const prices = new Map(
      (await this.latest('store_price', "AND split_part(entity_id, ':', 2) = $2", [storeId])).map((r) => [str(r.payload['article_id']) || r.entity_id.split(':')[0]!, num(r.payload['sale_price'])]),
    );
    // Promotion « prix » en cours dans ce magasin (ou dans tous) : la moins chère l'emporte.
    const promos = new Map<string, { price: number; name: string; ends: string }>();
    for (const r of await this.latest('promotion')) {
      const p = r.payload;
      const price = num(p['promo_price']);
      if (p['kind'] !== 'price' || p['active'] === 0 || price <= 0) continue;
      if (p['store_id'] && p['store_id'] !== storeId) continue;
      if (str(p['starts_on']) > day || str(p['ends_on']) < day) continue;
      const articleId = str(p['article_id']);
      const cur = promos.get(articleId);
      if (!cur || price < cur.price) promos.set(articleId, { price, name: str(p['name']), ends: str(p['ends_on']) });
    }
    // Stock des dépôts du magasin envoyé par les PC ; sans ces données, tout est proposé.
    const store = (await this.latest('store', 'AND entity_id = $2', [storeId]))[0]?.payload;
    const warehouses = (await this.latest('warehouse', "AND payload->>'store_id' = $2", [storeId])).filter((w) => str(w.payload['store_id']) === storeId).map((w) => w.entity_id);
    const levels = warehouses.length ? await this.latest('stock_level', "AND split_part(entity_id, ':', 1) = ANY($2)", [warehouses]) : [];
    const stock = new Map<string, number>();
    for (const l of levels) stock.set(str(l.payload['article_id']), (stock.get(str(l.payload['article_id'])) ?? 0) + num(l.payload['qty']));
    const followsStock = levels.length > 0 && store?.['ignore_stock'] !== 1;

    const rows = await this.latest('article', '', [], "(payload - 'photo') || jsonb_build_object('has_thumb', (payload->'photo'->>'thumb') IS NOT NULL)");
    const articles = rows
      .filter((r) => r.payload['active'] !== 0 && r.payload['is_service'] !== 1)
      .map((r): ShopArticle => {
        const p = r.payload;
        const regular = prices.get(r.entity_id) ?? num(p['sale_price']);
        const promo = promos.get(r.entity_id);
        const promoPrice = promo && promo.price < regular ? promo : null;
        return {
          id: r.entity_id,
          code: str(p['code']),
          name: str(p['name']),
          unit: str(p['unit']) || 'piece',
          unitName: (p['unit_name'] as string | null) || null,
          department: departments.get(families.get(str(p['family_id'])) ?? '') || null,
          price: promoPrice ? promoPrice.price : regular,
          regularPrice: regular,
          promoName: promoPrice?.name ?? null,
          promoEnds: promoPrice?.ends ?? null,
          photo: p['has_thumb'] === true,
          available: !followsStock || (stock.get(r.entity_id) ?? 0) > 0,
          otherRef: (p['other_ref'] as string | null) || null,
          barcodes: ((p['barcodes'] as { code: string; pack_qty: number }[] | undefined) ?? []).map((b) => ({ code: String(b.code).trim(), packQty: Number(b.pack_qty ?? 1000) || 1000 })),
          packs:
            p['unit'] === 'piece'
              ? ((p['packs'] as { name: string; units: number; barcode: string | null; sale_price?: number }[] | undefined) ?? []).map((k) => ({
                  name: str(k.name),
                  units: Number(k.units) || 0,
                  barcode: k.barcode ? String(k.barcode).trim() : null,
                  price: num(k.sale_price),
                }))
              : [],
        };
      })
      .filter((a) => a.regularPrice > 0)
      .sort((a, b) => a.name.localeCompare(b.name, 'fr'));
    this.cache.set(storeId, { key, articles });
    return articles;
  }

  // ——— Boutique en ligne ———

  /** Catalogue public de la boutique : articles en stock, avec le prix du magasin. */
  async catalog(code: string) {
    const store = await this.openShop(code);
    const articles = (await this.articles(store.id)).filter((a) => a.available);
    return {
      store: { code: store.code, name: store.name, address: store.address, phone: store.phone },
      message: store.settings.message,
      delivery: store.settings.delivery,
      deliveryFee: store.settings.delivery ? store.settings.deliveryFee : 0,
      minOrder: store.settings.minOrder,
      articles: articles.map((a) => ({
        id: a.id,
        name: a.name,
        unit: a.unit,
        unitName: a.unitName,
        department: a.department,
        price: a.price,
        regularPrice: a.regularPrice,
        promoEnds: a.promoEnds,
        photo: a.photo,
      })),
    };
  }

  /** Vignette d'un article de la boutique (image JPEG ou PNG). */
  async thumb(code: string, articleId: string): Promise<{ type: string; data: Buffer } | null> {
    const store = await this.openShop(code);
    if (!(await this.articles(store.id)).some((a) => a.id === articleId && a.photo)) return null;
    const rows = await this.latest('article', 'AND entity_id = $2', [articleId], "jsonb_build_object('thumb', payload->'photo'->'thumb')");
    const t = rows[0]?.payload['thumb'];
    const m = typeof t === 'string' && t.length <= MAX_THUMB ? /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(t) : null;
    return m ? { type: m[1]!, data: Buffer.from(m[2]!, 'base64') } : null;
  }

  /**
   * Commande de la boutique : tout est vérifié ici (magasin ouvert, articles
   * vendus et en stock, quantités, montant minimal, téléphone) et le prix est
   * refait avec celui du magasin.
   */
  async createOrder(code: string, input: unknown, ip: string): Promise<{ id: string; number: string; total: number; deliveryFee: number }> {
    this.orderLimit.check(ip);
    this.attemptLimit.take(ip);
    const store = await this.openShop(code);
    const body = (input && typeof input === 'object' ? input : {}) as Json;
    const text = (v: unknown, max: number) => str(v).replace(/\s+/g, ' ').trim().slice(0, max) || null;

    const customerName = text(body['customerName'], 60);
    if (!customerName || customerName.length < 2) throw new BadRequestException('Indiquez votre nom.');
    const phone = cameroonPhone(str(body['phone']));
    if (!phone) throw new BadRequestException('Numéro de téléphone invalide : 9 chiffres commençant par 6 ou 2 (par exemple 6 77 12 34 56).');
    const address = text(body['address'], 200);
    if (address && !store.settings.delivery) throw new BadRequestException('Ce magasin ne livre pas : la commande est à retirer au magasin.');
    const slot = text(body['slot'], 60);
    const note = text(body['note'], 300);

    const raw = Array.isArray(body['lines']) ? (body['lines'] as unknown[]) : [];
    if (!raw.length) throw new BadRequestException('Votre panier est vide.');
    if (raw.length > MAX_LINES) throw new BadRequestException(`Une commande compte ${MAX_LINES} articles différents au plus.`);
    const articles = new Map((await this.articles(store.id)).map((a) => [a.id, a]));
    const qtyById = new Map<string, number>();
    for (const l of raw) {
      const line = (l && typeof l === 'object' ? l : {}) as Json;
      const articleId = str(line['articleId']);
      const qty = Number(line['qty']);
      const a = articles.get(articleId);
      if (!a) throw new BadRequestException('Un article du panier n’est plus vendu en ligne : retirez-le puis renvoyez la commande.');
      if (!a.available) throw new BadRequestException(`${a.name} n’est plus disponible : retirez-le puis renvoyez la commande.`);
      if (!Number.isSafeInteger(qty) || qty <= 0 || qty > MAX_QTY) throw new BadRequestException(`Quantité invalide pour ${a.name}.`);
      if (a.unit === 'piece' && qty % 1000 !== 0) throw new BadRequestException(`${a.name} se vend à l’unité : quantité entière seulement.`);
      const sum = (qtyById.get(articleId) ?? 0) + qty;
      if (sum > MAX_QTY) throw new BadRequestException(`Quantité trop grande pour ${a.name}.`);
      qtyById.set(articleId, sum);
    }
    const lines: WebOrderLine[] = [...qtyById].map(([articleId, qty]) => {
      const a = articles.get(articleId)!;
      return { articleId, name: a.name, qty, price: a.price };
    });
    const subtotal = lines.reduce((s, l) => s + Math.round((l.price * l.qty) / 1000), 0);
    if (subtotal < store.settings.minOrder) {
      throw new BadRequestException(`Le montant minimal d’une commande est de ${store.settings.minOrder.toLocaleString('fr-FR')} FCFA.`);
    }
    const deliveryFee = address ? store.settings.deliveryFee : 0;
    const total = subtotal + deliveryFee;

    const id = randomUUID();
    const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    for (let i = 0; i < 10; i++) {
      const number = `W-${Array.from(randomBytes(6), (b) => alphabet[b % alphabet.length]).join('')}`;
      const { rows } = await this.pg.query<{ number: string }>(
        `INSERT INTO web_orders (id, number, store_id, customer_name, phone, address, slot, note, delivery_fee, lines, total)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) ON CONFLICT (number) DO NOTHING RETURNING number`,
        [id, number, store.id, customerName, phone, address, slot, note, deliveryFee, JSON.stringify(lines), total],
      );
      if (rows[0]) {
        this.orderLimit.hit(ip);
        return { id, number, total, deliveryFee };
      }
    }
    throw new HttpException('Réessayez dans un instant.', HttpStatus.SERVICE_UNAVAILABLE);
  }

  private toOrder(r: WebOrderRow): WebOrder {
    const lines = typeof r.lines === 'string' ? (JSON.parse(r.lines) as WebOrderLine[]) : r.lines;
    return {
      id: r.id,
      number: r.number,
      customerName: r.customer_name,
      phone: r.phone,
      address: r.address,
      slot: r.slot,
      note: r.note,
      deliveryFee: Number(r.delivery_fee),
      lines,
      total: Number(r.total),
      at: new Date(r.created_at).toISOString(),
    };
  }

  /** Commandes de la boutique qui attendent un poste du magasin. */
  async waiting(storeId: string): Promise<{ orders: WebOrder[] }> {
    const { rows } = await this.pg.query<WebOrderRow>(
      `SELECT * FROM web_orders WHERE store_id = $1 AND status = 'waiting' AND created_at >= now() - interval '${WAITING_DAYS} days' ORDER BY created_at`,
      [storeId],
    );
    return { orders: rows.map((r) => this.toOrder(r)) };
  }

  /** Un poste prend la commande : un seul poste l'obtient. */
  async take(device: { id: string; store_id: string }, id: string): Promise<WebOrder> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new NotFoundException('Commande introuvable.');
    const { rows } = await this.pg.query<WebOrderRow>(
      "UPDATE web_orders SET status = 'taken', taken_by_device = $3, taken_at = now() WHERE id = $1 AND store_id = $2 AND status = 'waiting' RETURNING *",
      [id, device.store_id, device.id],
    );
    if (rows[0]) return this.toOrder(rows[0]);
    const { rows: other } = await this.pg.query<{ status: string }>('SELECT status FROM web_orders WHERE id = $1 AND store_id = $2', [id, device.store_id]);
    if (!other[0]) throw new NotFoundException('Commande introuvable.');
    throw new ConflictException(other[0].status === 'cancelled' ? 'Cette commande a été annulée.' : 'Cette commande a déjà été prise par un autre poste.');
  }

  /** Dernières commandes de la boutique de chaque magasin, pour l'interface du serveur. */
  async recent() {
    const { rows } = await this.pg.query<WebOrderRow & { device_name: string | null }>(
      `SELECT o.*, d.name AS device_name FROM web_orders o LEFT JOIN devices d ON d.id = o.taken_by_device
       ORDER BY o.created_at DESC LIMIT 200`,
    );
    const names = new Map((await this.latest('store', '', [], "jsonb_build_object('name', payload->'name', 'code', payload->'code')")).map((r) => [r.entity_id, str(r.payload['name']) || str(r.payload['code'])]));
    return rows.map((r) => ({
      ...this.toOrder(r),
      store: names.get(r.store_id) ?? r.store_id,
      status: r.status,
      takenBy: r.device_name,
      takenAt: r.taken_at ? new Date(r.taken_at).toISOString() : null,
    }));
  }

  // ——— Vérificateur de prix ———

  /**
   * Prix d'un article lu au rayon : code article, code-barres (unité ou lot),
   * code d'un conditionnement, ou autre référence (comme la recherche du téléphone).
   */
  async price(code: string, query: string) {
    const store = await this.priceStore(code);
    const q = str(query).trim().slice(0, 64);
    if (!q) throw new BadRequestException('Scannez ou tapez le code de l’article.');
    const variants = new Set([q, q.replace(/^0+/, ''), `0${q}`]);
    const all = await this.articles(store.id);
    for (const a of all) {
      const pack = a.packs.find((k) => k.barcode && variants.has(k.barcode));
      const bar = a.barcodes.find((b) => variants.has(b.code));
      if (!pack && !bar && !variants.has(a.code) && !(a.otherRef && variants.has(a.otherRef))) continue;
      const base = {
        id: a.id,
        code: a.code,
        name: a.name,
        unit: a.unit,
        unitName: a.unitName,
        price: a.regularPrice,
        promoPrice: a.price < a.regularPrice ? a.price : null,
        promoName: a.promoName,
        promoEnds: a.promoEnds,
        photo: a.photo,
        pack: null as { name: string; units: number; price: number } | null,
      };
      if (pack) {
        base.pack = { name: pack.name, units: pack.units, price: pack.price || Math.round((a.regularPrice * pack.units) / 1000) };
      } else if (bar && bar.packQty !== 1000) {
        base.pack = { name: `Lot de ${(bar.packQty / 1000).toLocaleString('fr-FR')}`, units: bar.packQty, price: Math.round((a.regularPrice * bar.packQty) / 1000) };
      }
      return { store: { name: store.name }, article: base };
    }
    throw new NotFoundException('Article introuvable : demandez à un vendeur.');
  }
}
