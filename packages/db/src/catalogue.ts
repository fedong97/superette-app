import { randomInt } from 'node:crypto';
import {
  type Fcfa,
  type Milli,
  type ScaleBarcodeConfig,
  internalEan13,
  isValidEan,
  normalizeBarcode,
  parseScaleBarcode,
} from '@superette/core';
import { AppError, Base, newId } from './util';

export type Unit = 'piece' | 'kg' | 'litre';

export interface Article {
  id: string;
  code: string;
  name: string;
  family_id: string | null;
  family_name: string | null;
  department_name: string | null;
  brand: string | null;
  unit: Unit;
  vat_rate_id: string;
  vat_rate_bp: number;
  purchase_price: Fcfa;
  /** Prix national. */
  sale_price: Fcfa;
  /** Prix appliqué dans le magasin demandé (prix magasin s'il existe). */
  store_price: Fcfa;
  perishable: number;
  plu: string | null;
  quick_key: number;
  min_qty: Milli | null;
  alert_qty: Milli | null;
  max_qty: Milli | null;
  active: number;
  barcodes: { code: string; pack_qty: Milli }[];
}

export interface ArticleInput {
  code?: string;
  name: string;
  familyId?: string | null;
  brand?: string | null;
  unit: Unit;
  vatRateId: string;
  purchasePrice: Fcfa;
  salePrice: Fcfa;
  perishable?: boolean;
  plu?: string | null;
  quickKey?: boolean;
  minQty?: Milli | null;
  alertQty?: Milli | null;
  maxQty?: Milli | null;
  active?: boolean;
  barcodes?: { code: string; packQty?: Milli }[];
}

/** Résultat d'un scan en caisse. */
export interface ScanResult {
  article: Article;
  barcode: string;
  /** Quantité suggérée : 1 pièce, le conditionnement scanné, ou le poids lu. */
  qty: Milli;
  /** Montant imposé par une étiquette balance à prix intégré. */
  fixedAmount?: Fcfa;
}

const ARTICLE_SELECT = `
  SELECT a.*, v.rate_bp AS vat_rate_bp, f.name AS family_name, d.name AS department_name,
         COALESCE(sp.sale_price, a.sale_price) AS store_price
  FROM articles a
  JOIN vat_rates v ON v.id = a.vat_rate_id
  LEFT JOIN families f ON f.id = a.family_id
  LEFT JOIN departments d ON d.id = f.department_id
  LEFT JOIN store_prices sp ON sp.article_id = a.id AND sp.store_id = @storeId`;

export class CatalogueService extends Base {
  // --- Rayons et familles ---------------------------------------------------

  listDepartments(): { id: string; name: string; families: { id: string; name: string }[] }[] {
    const deps = this.db.prepare('SELECT id, name FROM departments ORDER BY name').all() as { id: string; name: string }[];
    const fams = this.db.prepare('SELECT id, department_id, name FROM families ORDER BY name').all() as {
      id: string;
      department_id: string;
      name: string;
    }[];
    return deps.map((d) => ({ ...d, families: fams.filter((f) => f.department_id === d.id).map(({ id, name }) => ({ id, name })) }));
  }

  createDepartment(name: string): { id: string; name: string } {
    const id = newId();
    this.db.prepare('INSERT INTO departments (id, name) VALUES (?, ?)').run(id, name.trim());
    this.enqueue(null, 'department', id, 'upsert', { id, name });
    return { id, name: name.trim() };
  }

  createFamily(departmentId: string, name: string): { id: string; name: string } {
    const id = newId();
    this.db.prepare('INSERT INTO families (id, department_id, name) VALUES (?, ?, ?)').run(id, departmentId, name.trim());
    this.enqueue(null, 'family', id, 'upsert', { id, department_id: departmentId, name });
    return { id, name: name.trim() };
  }

  // --- Articles -------------------------------------------------------------

  private withBarcodes(rows: Omit<Article, 'barcodes'>[]): Article[] {
    if (rows.length === 0) return [];
    const codes = this.db
      .prepare(`SELECT article_id, code, pack_qty FROM barcodes WHERE article_id IN (${rows.map(() => '?').join(',')})`)
      .all(...rows.map((r) => r.id)) as { article_id: string; code: string; pack_qty: number }[];
    return rows.map((r) => ({
      ...r,
      barcodes: codes.filter((c) => c.article_id === r.id).map(({ code, pack_qty }) => ({ code, pack_qty })),
    }));
  }

  getArticle(id: string, storeId: string | null = null): Article {
    const row = this.db.prepare(`${ARTICLE_SELECT} WHERE a.id = @id`).get({ id, storeId }) as Omit<Article, 'barcodes'> | undefined;
    if (!row) throw new AppError('Article introuvable', 'NOT_FOUND');
    return this.withBarcodes([row])[0]!;
  }

  searchArticles(
    query: string,
    storeId: string | null,
    opts: { includeInactive?: boolean; familyId?: string; limit?: number } = {},
  ): Article[] {
    const q = `%${query.trim().replace(/[%_]/g, '')}%`;
    const rows = this.db
      .prepare(
        `${ARTICLE_SELECT}
         WHERE (a.name LIKE @q OR a.code LIKE @q OR a.brand LIKE @q
                OR a.id IN (SELECT article_id FROM barcodes WHERE code LIKE @q))
           AND (@all = 1 OR a.active = 1)
           AND (@familyId IS NULL OR a.family_id = @familyId)
         ORDER BY a.name LIMIT @limit`,
      )
      .all({ q, storeId, all: opts.includeInactive ? 1 : 0, familyId: opts.familyId ?? null, limit: opts.limit ?? 200 }) as Omit<
      Article,
      'barcodes'
    >[];
    return this.withBarcodes(rows);
  }

  quickKeys(storeId: string): Article[] {
    const rows = this.db
      .prepare(`${ARTICLE_SELECT} WHERE a.quick_key = 1 AND a.active = 1 ORDER BY f.name, a.name`)
      .all({ storeId }) as Omit<Article, 'barcodes'>[];
    return this.withBarcodes(rows);
  }

  private nextArticleCode(): string {
    return `${this.stationPrefix()}-${String(this.nextCounter('article.code')).padStart(5, '0')}`;
  }

  /** Crée ou modifie une fiche article ; trace l'historique des prix. */
  saveArticle(userId: string, input: ArticleInput, id?: string): Article {
    if (!input.name.trim()) throw new AppError("La désignation de l'article est obligatoire", 'INVALID');
    for (const [label, v] of [
      ['Prix de vente', input.salePrice],
      ["Prix d'achat", input.purchasePrice],
    ] as const) {
      if (!Number.isSafeInteger(v) || v < 0) throw new AppError(`${label} invalide`, 'INVALID');
    }
    const barcodes = (input.barcodes ?? []).map((b) => ({ code: normalizeBarcode(b.code), packQty: b.packQty ?? 1000 }));
    for (const b of barcodes) {
      if (/^\d+$/.test(b.code) && [8, 13].includes(b.code.length) && !isValidEan(b.code)) {
        throw new AppError(`Code-barres ${b.code} : clé de contrôle incorrecte`, 'INVALID_BARCODE');
      }
    }
    return this.tx(() => {
      const now = this.now();
      const articleId = id ?? newId();
      const existing = id ? this.getArticle(id) : null;
      const params = {
        id: articleId,
        code: input.code?.trim() || existing?.code || this.nextArticleCode(),
        name: input.name.trim(),
        family_id: input.familyId ?? null,
        brand: input.brand ?? null,
        unit: input.unit,
        vat_rate_id: input.vatRateId,
        purchase_price: input.purchasePrice,
        sale_price: input.salePrice,
        perishable: input.perishable ? 1 : 0,
        plu: input.plu?.trim() ? input.plu.trim().padStart(5, '0') : null,
        quick_key: input.quickKey ? 1 : 0,
        min_qty: input.minQty ?? null,
        alert_qty: input.alertQty ?? null,
        max_qty: input.maxQty ?? null,
        active: input.active === false ? 0 : 1,
        now,
      };
      try {
        if (existing) {
          this.db
            .prepare(
              `UPDATE articles SET code=@code, name=@name, family_id=@family_id, brand=@brand, unit=@unit,
                 vat_rate_id=@vat_rate_id, purchase_price=@purchase_price, sale_price=@sale_price,
                 perishable=@perishable, plu=@plu, quick_key=@quick_key, min_qty=@min_qty, alert_qty=@alert_qty,
                 max_qty=@max_qty, active=@active, updated_at=@now WHERE id=@id`,
            )
            .run(params);
        } else {
          this.db
            .prepare(
              `INSERT INTO articles (id, code, name, family_id, brand, unit, vat_rate_id, purchase_price, sale_price,
                 perishable, plu, quick_key, min_qty, alert_qty, max_qty, active, created_at, updated_at)
               VALUES (@id, @code, @name, @family_id, @brand, @unit, @vat_rate_id, @purchase_price, @sale_price,
                 @perishable, @plu, @quick_key, @min_qty, @alert_qty, @max_qty, @active, @now, @now)`,
            )
            .run(params);
        }
        this.db.prepare('DELETE FROM barcodes WHERE article_id = ?').run(articleId);
        const insertCode = this.db.prepare('INSERT INTO barcodes (code, article_id, pack_qty) VALUES (?, ?, ?)');
        for (const b of barcodes) insertCode.run(b.code, articleId, b.packQty);
      } catch (e) {
        const msg = String(e);
        if (msg.includes('barcodes.code')) throw new AppError('Un des codes-barres est déjà attribué à un autre article', 'DUPLICATE_BARCODE');
        if (msg.includes('articles.code')) throw new AppError('Code article déjà utilisé', 'DUPLICATE');
        if (msg.includes('articles.plu')) throw new AppError('Code balance (PLU) déjà utilisé', 'DUPLICATE');
        throw e;
      }
      if (!existing || existing.sale_price !== input.salePrice) {
        this.db
          .prepare('INSERT INTO price_history (id, article_id, store_id, old_price, new_price, user_id, at) VALUES (?, ?, NULL, ?, ?, ?, ?)')
          .run(newId(), articleId, existing?.sale_price ?? null, input.salePrice, userId, now);
      }
      const article = this.getArticle(articleId);
      this.enqueue(null, 'article', articleId, 'upsert', article);
      this.audit(userId, existing ? 'article.update' : 'article.create', 'article', articleId);
      return article;
    });
  }

  /** Prix propre à un magasin (null pour revenir au prix national). */
  setStorePrice(userId: string, articleId: string, storeId: string, price: Fcfa | null): void {
    this.tx(() => {
      const before = this.getArticle(articleId, storeId);
      if (price === null) {
        this.db.prepare('DELETE FROM store_prices WHERE article_id = ? AND store_id = ?').run(articleId, storeId);
      } else {
        this.db
          .prepare(
            'INSERT INTO store_prices (article_id, store_id, sale_price) VALUES (?, ?, ?) ON CONFLICT DO UPDATE SET sale_price = excluded.sale_price',
          )
          .run(articleId, storeId, price);
      }
      this.db
        .prepare('INSERT INTO price_history (id, article_id, store_id, old_price, new_price, user_id, at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(newId(), articleId, storeId, before.store_price, price ?? before.sale_price, userId, this.now());
      this.enqueue({ storeId, registerId: null }, 'store_price', `${articleId}:${storeId}`, price === null ? 'delete' : 'upsert', {
        article_id: articleId,
        store_id: storeId,
        sale_price: price,
      });
      this.audit(userId, 'price.store', 'article', articleId, { storeId, price });
    });
  }

  priceHistory(articleId: string): { old_price: number | null; new_price: number; store_id: string | null; user_name: string | null; at: string }[] {
    return this.db
      .prepare(
        `SELECT h.old_price, h.new_price, h.store_id, u.name AS user_name, h.at
         FROM price_history h LEFT JOIN users u ON u.id = h.user_id WHERE h.article_id = ? ORDER BY h.at DESC`,
      )
      .all(articleId) as never;
  }

  /** Attribue un code-barres interne (préfixe 20) à un article sans code. */
  generateInternalBarcode(): string {
    // 3 chiffres propres au poste + 7 chiffres de séquence : pas de doublon entre PC hors ligne.
    let node = this.db.prepare("SELECT value FROM settings WHERE key = 'barcode.node'").pluck().get() as string | undefined;
    if (!node) {
      node = String(randomInt(0, 1000));
      this.db.prepare("INSERT INTO settings (key, value) VALUES ('barcode.node', ?)").run(node);
    }
    for (;;) {
      const code = internalEan13(Number(node) * 10_000_000 + this.nextCounter('barcode.internal'));
      const taken = this.db.prepare('SELECT 1 FROM barcodes WHERE code = ?').get(code);
      if (!taken) return code;
    }
  }

  private scaleConfig(): ScaleBarcodeConfig {
    const get = (k: string) => this.db.prepare('SELECT value FROM settings WHERE key = ?').pluck().get(k) as string | undefined;
    return {
      prefixes: (get('scale.prefixes') ?? '21,22').split(',').map((s) => s.trim()).filter(Boolean),
      valueType: get('scale.valueType') === 'weight' ? 'weight' : 'price',
    };
  }

  /**
   * Résout un scan : code-barres article (et conditionnement), étiquette
   * balance (préfixe 2x, prix ou poids intégré), ou code article interne.
   */
  scan(raw: string, storeId: string): ScanResult | null {
    const code = normalizeBarcode(raw);
    if (!code) return null;
    const hit = this.db
      .prepare('SELECT b.article_id, b.pack_qty FROM barcodes b JOIN articles a ON a.id = b.article_id WHERE b.code = ? AND a.active = 1')
      .get(code) as { article_id: string; pack_qty: number } | undefined;
    if (hit) return { article: this.getArticle(hit.article_id, storeId), barcode: code, qty: hit.pack_qty };

    const scale = parseScaleBarcode(code, this.scaleConfig());
    if (scale) {
      const id = this.db.prepare('SELECT id FROM articles WHERE plu = ? AND active = 1').pluck().get(scale.plu) as string | undefined;
      if (id) {
        const article = this.getArticle(id, storeId);
        if (scale.valueType === 'weight') return { article, barcode: code, qty: scale.value };
        // Prix intégré : quantité déduite du prix au kilo, montant imposé par l'étiquette.
        const qty = article.store_price > 0 ? Math.round((scale.value * 1000) / article.store_price) : 1000;
        return { article, barcode: code, qty, fixedAmount: scale.value };
      }
    }

    const byCode = this.db.prepare('SELECT id FROM articles WHERE code = ? AND active = 1').pluck().get(code.toUpperCase()) as
      | string
      | undefined;
    if (byCode) return { article: this.getArticle(byCode, storeId), barcode: code, qty: 1000 };
    return null;
  }

  /**
   * Import en masse (reprise du catalogue depuis Excel/CSV). Les lignes
   * dont le code-barres existe déjà mettent à jour l'article correspondant.
   */
  importArticles(
    userId: string,
    rows: { name: string; barcode?: string; salePrice: Fcfa; purchasePrice?: Fcfa; vatRateBp?: number; unit?: Unit; department?: string; family?: string }[],
  ): { created: number; updated: number; errors: { row: number; message: string }[] } {
    const rates = this.db.prepare('SELECT id, rate_bp FROM vat_rates WHERE active = 1').all() as { id: string; rate_bp: number }[];
    const result = { created: 0, updated: 0, errors: [] as { row: number; message: string }[] };
    const familyId = (dep?: string, fam?: string): string | null => {
      if (!dep) return null;
      let depId = this.db.prepare('SELECT id FROM departments WHERE name = ?').pluck().get(dep.trim()) as string | undefined;
      depId ??= this.createDepartment(dep).id;
      const famName = fam?.trim() || dep.trim();
      const existing = this.db.prepare('SELECT id FROM families WHERE department_id = ? AND name = ?').pluck().get(depId, famName) as
        | string
        | undefined;
      return existing ?? this.createFamily(depId, famName).id;
    };
    rows.forEach((row, index) => {
      try {
        const rate = rates.find((r) => r.rate_bp === (row.vatRateBp ?? 1925));
        if (!rate) throw new AppError(`Taux de TVA inconnu : ${row.vatRateBp}`, 'INVALID');
        const code = row.barcode ? normalizeBarcode(row.barcode) : null;
        const existingId = code
          ? (this.db.prepare('SELECT article_id FROM barcodes WHERE code = ?').pluck().get(code) as string | undefined)
          : undefined;
        const existing = existingId ? this.getArticle(existingId) : null;
        this.saveArticle(
          userId,
          {
            code: existing?.code,
            name: row.name,
            familyId: familyId(row.department, row.family) ?? existing?.family_id ?? null,
            brand: existing?.brand,
            unit: row.unit ?? existing?.unit ?? 'piece',
            vatRateId: rate.id,
            purchasePrice: row.purchasePrice ?? existing?.purchase_price ?? 0,
            salePrice: row.salePrice,
            perishable: existing?.perishable === 1,
            plu: existing?.plu,
            quickKey: existing?.quick_key === 1,
            minQty: existing?.min_qty,
            alertQty: existing?.alert_qty,
            maxQty: existing?.max_qty,
            barcodes: existing
              ? existing.barcodes.map((b) => ({ code: b.code, packQty: b.pack_qty }))
              : code
                ? [{ code }]
                : [],
          },
          existingId,
        );
        if (existing) result.updated++;
        else result.created++;
      } catch (e) {
        result.errors.push({ row: index + 1, message: e instanceof Error ? e.message : String(e) });
      }
    });
    return result;
  }
}
