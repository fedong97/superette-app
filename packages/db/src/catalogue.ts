import { randomInt } from 'node:crypto';
import {
  type ArticleImportRow,
  type ExportArticle,
  type BarcodeKind,
  type Fcfa,
  type Milli,
  type QtyTier,
  type ScaleBarcodeConfig,
  checkPacks,
  checkQtyTiers,
  internalEan13,
  internalEan8,
  isValidEan,
  normalizeBarcode,
  parseNetContent,
  packUnits,
  parseScaleBarcode,
} from '@superette/core';
import { AppError, Base, newId } from './util';
import { fold } from './database';

/** Trois lettres de la famille, sans accents (Boissons → BOI), pour la codification par famille. */
export function familyPrefix(name: string): string {
  const letters = fold(name).toUpperCase().replace(/[^A-Z0-9]/g, '');
  return (letters.slice(0, 3) || 'ART').padEnd(3, 'X');
}

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
  /** Quantité voulue en rayon (réassort) ; vide : deux jours de ventes. */
  shelf_qty: Milli | null;
  active: number;
  /** Nom de l'unité de détail (Ampoule, Bouteille) ; vide = « Pièce ». */
  unit_name: string | null;
  wholesale_price: Fcfa | null;
  super_wholesale_price: Fcfa | null;
  /** Autre référence (référence fournisseur, ancien code) : cherchée en caisse. */
  other_ref: string | null;
  /** Prix d'achat HT du conditionnement d'achat (la palette), exact. */
  pack_purchase_price: Fcfa | null;
  /** Prix de revient du conditionnement d'achat (achat + transport, manutention). */
  pack_cost_price: Fcfa | null;
  /** Miniature de la photo (data URL JPEG), null sans photo. */
  photo_thumb: string | null;
  /** Article proposé en caisse quand celui-ci est épuisé. */
  substitute_id: string | null;
  substitute_code: string | null;
  substitute_name: string | null;
  /** Emplacement dans chaque dépôt (JSON : {"<dépôt>": "A3-2"}). */
  locations: string | null;
  /** Prix par quantité de l'unité de détail (JSON : [{"minQty": 12000, "price": 480}]). */
  qty_tiers: string | null;
  /** Contenu net (« 900 g ») pour le prix au kilo ou au litre ; vide : lu dans la désignation. */
  net_content: string | null;
  barcodes: { code: string; pack_qty: Milli }[];
  /** Conditionnements, du plus grand au plus petit (carton, paquet). */
  packs: ArticlePack[];
}

export interface ArticlePack {
  id: string;
  position: number;
  name: string;
  /** Nombre de conditionnements du niveau suivant (ou d'unités de détail) contenus. */
  contains: number;
  /** Unités de détail contenues (millièmes). */
  units: Milli;
  sale_price: Fcfa;
  wholesale_price: Fcfa | null;
  super_wholesale_price: Fcfa | null;
  barcode: string | null;
  /** Conditionnement dans lequel on achète l'article : toujours le premier (le plus grand). */
  is_purchase: number;
}

export interface PackInput {
  name: string;
  contains: number;
  salePrice: Fcfa;
  wholesalePrice?: Fcfa | null;
  superWholesalePrice?: Fcfa | null;
  barcode?: string | null;
  /** Ignoré : le conditionnement d'achat est toujours le premier. */
  purchase?: boolean;
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
  unitName?: string | null;
  wholesalePrice?: Fcfa | null;
  superWholesalePrice?: Fcfa | null;
  /** Conditionnements du plus grand au plus petit ; absent = inchangés. */
  packs?: PackInput[];
  otherRef?: string | null;
  /**
   * Prix d'achat HT du conditionnement d'achat (le premier, ou l'unité s'il n'y
   * en a pas) : remplace `purchasePrice`, qui en est déduit par unité.
   */
  packPurchasePrice?: Fcfa;
  /** Prix de revient du conditionnement d'achat ; absent = garde l'écart avec l'achat. */
  packCostPrice?: Fcfa;
  /** Article proposé quand celui-ci est épuisé ; absent = inchangé. */
  substituteId?: string | null;
}

/** Résultat d'un scan en caisse. */
export interface ScanResult {
  article: Article;
  barcode: string;
  /** Quantité suggérée : 1 pièce, le conditionnement scanné, ou le poids lu. */
  qty: Milli;
  /** Montant imposé par une étiquette balance à prix intégré. */
  fixedAmount?: Fcfa;
  /** Code-barres d'un conditionnement (carton, paquet) : vendu à son prix. */
  pack?: ArticlePack;
}

/** Taux de TVA de l'article ; 0 dans un magasin sans TVA, quel que soit le taux de la fiche. */
const ARTICLE_SELECT = `
  SELECT a.*, CASE WHEN (SELECT vat_enabled FROM stores WHERE id = @storeId) = 0 THEN 0 ELSE v.rate_bp END AS vat_rate_bp, f.name AS family_name, d.name AS department_name,
         COALESCE(sp.sale_price, a.sale_price) AS store_price, ph.thumb AS photo_thumb,
         sub.code AS substitute_code, sub.name AS substitute_name
  FROM articles a
  LEFT JOIN article_photos ph ON ph.article_id = a.id
  LEFT JOIN articles sub ON sub.id = a.substitute_id
  JOIN vat_rates v ON v.id = a.vat_rate_id
  LEFT JOIN families f ON f.id = a.family_id
  LEFT JOIN departments d ON d.id = f.department_id
  LEFT JOIN store_prices sp ON sp.article_id = a.id AND sp.store_id = @storeId`;

/** Taille maximale d'une photo et de sa miniature (data URL). */
const PHOTO_MAX = 400_000;
const THUMB_MAX = 40_000;

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

  private withBarcodes(rows: Omit<Article, 'barcodes' | 'packs'>[]): Article[] {
    if (rows.length === 0) return [];
    const marks = rows.map(() => '?').join(',');
    const ids = rows.map((r) => r.id);
    const codes = this.db
      .prepare(`SELECT article_id, code, pack_qty FROM barcodes WHERE article_id IN (${marks})`)
      .all(...ids) as { article_id: string; code: string; pack_qty: number }[];
    const packs = this.db
      .prepare(`SELECT * FROM article_packs WHERE article_id IN (${marks}) ORDER BY position`)
      .all(...ids) as (ArticlePack & { article_id: string })[];
    return rows.map((r) => ({
      ...r,
      barcodes: codes.filter((c) => c.article_id === r.id).map(({ code, pack_qty }) => ({ code, pack_qty })),
      packs: packs.filter((p) => p.article_id === r.id).map(({ article_id: _a, ...p }) => p),
    }));
  }

  getArticle(id: string, storeId: string | null = null): Article {
    const row = this.db.prepare(`${ARTICLE_SELECT} WHERE a.id = @id`).get({ id, storeId }) as Omit<Article, 'barcodes' | 'packs'> | undefined;
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
         WHERE (a.name LIKE @q OR a.code LIKE @q OR a.brand LIKE @q OR a.other_ref LIKE @q
                OR a.id IN (SELECT article_id FROM barcodes WHERE code LIKE @q))
           AND (@all = 1 OR a.active = 1) AND a.is_service = 0
           AND (@familyId IS NULL OR a.family_id = @familyId)
         ORDER BY a.name LIMIT @limit`,
      )
      .all({ q, storeId, all: opts.includeInactive ? 1 : 0, familyId: opts.familyId ?? null, limit: opts.limit ?? 200 }) as Omit<
      Article,
      'barcodes' | 'packs'
    >[];
    return this.withBarcodes(rows);
  }

  /**
   * Suggestions pendant la saisie : chaque mot tapé doit se retrouver dans le
   * nom ou la marque (ou commencer le code ou un code-barres), sans tenir compte des accents
   * ni des majuscules. Les noms qui commencent par le premier mot passent devant.
   */
  suggestArticles(query: string, storeId: string | null, limit = 12): Article[] {
    const words = fold(query)
      .replace(/[%_]/g, '')
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 6);
    if (words.length === 0) return [];
    const params: Record<string, unknown> = { storeId, prefix: `${words[0]}%`, limit: Math.min(Math.max(limit, 1), 50) };
    const where = words
      .map((w, i) => {
        params[`w${i}`] = `%${w}%`;
        params[`p${i}`] = `${w}%`;
        // Codes et codes-barres : par le début seulement, sinon « 1 » ramènerait tout le catalogue.
        return `(fold(a.name) LIKE @w${i} OR fold(COALESCE(a.brand, '')) LIKE @w${i} OR fold(a.code) LIKE @p${i} OR fold(COALESCE(a.other_ref, '')) LIKE @p${i}
                 OR a.id IN (SELECT article_id FROM barcodes WHERE code LIKE @p${i}))`;
      })
      .join(' AND ');
    const rows = this.db
      .prepare(
        `${ARTICLE_SELECT}
         WHERE a.active = 1 AND ${where}
         ORDER BY CASE WHEN fold(a.name) LIKE @prefix THEN 0 ELSE 1 END, fold(a.name) LIMIT @limit`,
      )
      .all(params) as Omit<Article, 'barcodes' | 'packs'>[];
    return this.withBarcodes(rows);
  }

  quickKeys(storeId: string): Article[] {
    const rows = this.db
      .prepare(`${ARTICLE_SELECT} WHERE a.quick_key = 1 AND a.active = 1 ORDER BY d.name, f.name, a.name`)
      .all({ storeId }) as Omit<Article, 'barcodes' | 'packs'>[];
    return this.withBarcodes(rows);
  }

  /**
   * Code d'un nouvel article : numéro du poste (DLA11-00012), ou, codification
   * par famille, trois lettres de la famille devant (BOI-DLA11-0012).
   */
  private nextArticleCode(familyId: string | null = null): string {
    if (familyId) {
      const name = this.db.prepare('SELECT name FROM families WHERE id = ?').pluck().get(familyId) as string | undefined;
      const prefix = familyPrefix(name ?? '');
      for (;;) {
        const code = `${prefix}-${this.stationPrefix()}-${String(this.nextCounter(`article.code.${prefix}`)).padStart(4, '0')}`;
        if (!this.db.prepare('SELECT 1 FROM articles WHERE code = ?').get(code)) return code;
      }
    }
    return `${this.stationPrefix()}-${String(this.nextCounter('article.code')).padStart(5, '0')}`;
  }

  /** Crée ou modifie une fiche article ; trace l'historique des prix. */
  saveArticle(userId: string, input: ArticleInput, id?: string, opts: { autoBarcode?: BarcodeKind | null; codeByFamily?: boolean } = {}): Article {
    if (!input.name.trim()) throw new AppError("La désignation de l'article est obligatoire", 'INVALID');
    if (input.substituteId) {
      if (input.substituteId === id) throw new AppError('Un article ne peut pas se remplacer lui-même', 'INVALID');
      if (!this.db.prepare('SELECT 1 FROM articles WHERE id = ?').get(input.substituteId)) throw new AppError('Article de remplacement introuvable', 'NOT_FOUND');
    }
    for (const [label, v] of [
      ['Prix de vente', input.salePrice],
      ["Prix d'achat", input.purchasePrice],
      ["Prix d'achat du conditionnement", input.packPurchasePrice ?? 0],
      ['Prix de revient', input.packCostPrice ?? 0],
    ] as const) {
      if (!Number.isSafeInteger(v) || v < 0) throw new AppError(`${label} invalide`, 'INVALID');
    }
    for (const [label, v] of [
      ['Prix de gros', input.wholesalePrice],
      ['Prix super gros', input.superWholesalePrice],
    ] as const) {
      if (v !== undefined && v !== null && (!Number.isSafeInteger(v) || v <= 0)) throw new AppError(`${label} invalide`, 'INVALID');
    }
    const packs = input.packs?.map((p) => ({ ...p, name: p.name.trim(), barcode: p.barcode?.trim() ? normalizeBarcode(p.barcode) : null }));
    if (packs) {
      const error = checkPacks(packs, input.unit);
      if (error) throw new AppError(error, 'INVALID');
      for (const p of packs) {
        for (const v of [p.wholesalePrice, p.superWholesalePrice]) {
          if (v !== undefined && v !== null && (!Number.isSafeInteger(v) || v <= 0)) throw new AppError(`Prix du conditionnement « ${p.name} » invalide`, 'INVALID');
        }
      }
    }
    const units = packs ? packUnits(packs) : [];
    const packCodes = new Set((packs ?? []).map((p) => p.barcode).filter(Boolean));
    const barcodes = [
      ...(input.barcodes ?? []).map((b) => ({ code: normalizeBarcode(b.code), packQty: b.packQty ?? 1000 })).filter((b) => !packCodes.has(b.code)),
      ...(packs ?? []).flatMap((p, i) => (p.barcode ? [{ code: p.barcode, packQty: units[i]! }] : [])),
    ];
    for (const b of barcodes) {
      if (/^\d+$/.test(b.code) && [8, 13].includes(b.code.length) && !isValidEan(b.code)) {
        throw new AppError(`Code-barres ${b.code} : clé de contrôle incorrecte`, 'INVALID_BARCODE');
      }
    }
    return this.tx(() => {
      const now = this.now();
      const articleId = id ?? newId();
      const existing = id ? this.getArticle(id) : null;
      if (existing && packs) this.assertSameStockUnit(existing, input.unitName === undefined ? existing.unit_name : input.unitName, packs);
      if (opts.autoBarcode) {
        // Code interne pour ce qui n'a pas de code fabricant : l'unité d'un nouvel
        // article à la pièce (hors balance), et chaque nouveau carton ou pack.
        if (!existing && input.unit === 'piece' && !input.plu?.trim() && !barcodes.some((b) => b.packQty === 1000)) {
          barcodes.push({ code: this.generateInternalBarcode(opts.autoBarcode), packQty: 1000 });
        }
        (packs ?? []).forEach((p, i) => {
          if (p.barcode || existing?.packs.some((x) => x.name === p.name)) return;
          p.barcode = this.generateInternalBarcode(opts.autoBarcode!);
          barcodes.push({ code: p.barcode, packQty: units[i]! });
        });
      }
      // Prix d'achat et de revient tenus au conditionnement d'achat, l'unité en est déduite.
      const purchaseUnits = packs ? (units[0] ?? 1000) : (existing?.packs[0]?.units ?? 1000);
      const sameBasis = existing !== null && existing.purchase_price === input.purchasePrice && (existing.packs[0]?.units ?? 1000) === purchaseUnits;
      const packPurchase =
        input.packPurchasePrice ??
        (sameBasis && existing.pack_purchase_price !== null ? existing.pack_purchase_price : Math.round((input.purchasePrice * purchaseUnits) / 1000));
      const packCost =
        input.packCostPrice ??
        (existing?.pack_cost_price != null && existing.pack_purchase_price !== null ? Math.max(0, existing.pack_cost_price + packPurchase - existing.pack_purchase_price) : packPurchase);
      const purchasePrice = input.packPurchasePrice !== undefined ? Math.round((packPurchase * 1000) / purchaseUnits) : input.purchasePrice;
      const params = {
        id: articleId,
        code: input.code?.trim() || existing?.code || this.nextArticleCode(opts.codeByFamily ? (input.familyId ?? null) : null),
        name: input.name.trim(),
        family_id: input.familyId ?? null,
        brand: input.brand ?? null,
        unit: input.unit,
        vat_rate_id: input.vatRateId,
        purchase_price: purchasePrice,
        sale_price: input.salePrice,
        perishable: input.perishable ? 1 : 0,
        plu: input.plu?.trim() ? input.plu.trim().padStart(5, '0') : null,
        quick_key: input.quickKey ? 1 : 0,
        min_qty: input.minQty ?? null,
        alert_qty: input.alertQty ?? null,
        max_qty: input.maxQty ?? null,
        active: input.active === false ? 0 : 1,
        unit_name: input.unitName === undefined ? (existing?.unit_name ?? null) : input.unitName?.trim() || null,
        wholesale_price: input.wholesalePrice === undefined ? (existing?.wholesale_price ?? null) : input.wholesalePrice,
        super_wholesale_price: input.superWholesalePrice === undefined ? (existing?.super_wholesale_price ?? null) : input.superWholesalePrice,
        other_ref: input.otherRef === undefined ? (existing?.other_ref ?? null) : input.otherRef?.trim() || null,
        pack_purchase_price: packPurchase,
        pack_cost_price: packCost,
        substitute_id: input.substituteId === undefined ? (existing?.substitute_id ?? null) : input.substituteId || null,
        now,
      };
      try {
        if (existing) {
          this.db
            .prepare(
              `UPDATE articles SET code=@code, name=@name, family_id=@family_id, brand=@brand, unit=@unit,
                 vat_rate_id=@vat_rate_id, purchase_price=@purchase_price, sale_price=@sale_price,
                 perishable=@perishable, plu=@plu, quick_key=@quick_key, min_qty=@min_qty, alert_qty=@alert_qty,
                 max_qty=@max_qty, active=@active, unit_name=@unit_name, wholesale_price=@wholesale_price,
                 super_wholesale_price=@super_wholesale_price, other_ref=@other_ref, pack_purchase_price=@pack_purchase_price,
                 pack_cost_price=@pack_cost_price, substitute_id=@substitute_id, updated_at=@now WHERE id=@id`,
            )
            .run(params);
        } else {
          this.db
            .prepare(
              `INSERT INTO articles (id, code, name, family_id, brand, unit, vat_rate_id, purchase_price, sale_price,
                 perishable, plu, quick_key, min_qty, alert_qty, max_qty, active, unit_name, wholesale_price, super_wholesale_price,
                 other_ref, pack_purchase_price, pack_cost_price, substitute_id, created_at, updated_at)
               VALUES (@id, @code, @name, @family_id, @brand, @unit, @vat_rate_id, @purchase_price, @sale_price,
                 @perishable, @plu, @quick_key, @min_qty, @alert_qty, @max_qty, @active, @unit_name, @wholesale_price, @super_wholesale_price,
                 @other_ref, @pack_purchase_price, @pack_cost_price, @substitute_id, @now, @now)`,
            )
            .run(params);
        }
        this.db.prepare('DELETE FROM barcodes WHERE article_id = ?').run(articleId);
        const insertCode = this.db.prepare('INSERT INTO barcodes (code, article_id, pack_qty) VALUES (?, ?, ?)');
        for (const b of barcodes) insertCode.run(b.code, articleId, b.packQty);
        if (packs) {
          this.db.prepare('DELETE FROM article_packs WHERE article_id = ?').run(articleId);
          const insertPack = this.db.prepare(
            `INSERT INTO article_packs (id, article_id, position, name, contains, units, sale_price, wholesale_price, super_wholesale_price, barcode, is_purchase)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          );
          // On achète dans le plus grand conditionnement.
          packs.forEach((p, i) =>
            insertPack.run(newId(), articleId, i + 1, p.name, p.contains, units[i], p.salePrice, p.wholesalePrice ?? null, p.superWholesalePrice ?? null, p.barcode, i === 0 ? 1 : 0),
          );
        }
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

  /**
   * Le stock et l'historique sont comptés dans l'unité de détail : une fois
   * l'article mouvementé, elle ne change plus (la CANETTE ne devient pas un
   * conditionnement, la PALETTE ne devient pas l'unité).
   */
  private assertSameStockUnit(existing: Article, unitName: string | null | undefined, packs: { name: string }[]): void {
    const key = (v: string | null | undefined) => (v ?? '').trim().toLowerCase();
    const oldUnit = key(existing.unit_name);
    const becomesPack = oldUnit !== '' && packs.some((p) => key(p.name) === oldUnit);
    const packBecomesUnit = key(unitName) !== oldUnit && existing.packs.some((p) => key(p.name) === key(unitName));
    if (!becomesPack && !packBecomesUnit) return;
    const moved = this.db.prepare('SELECT 1 FROM stock_movements WHERE article_id = ? LIMIT 1').get(existing.id);
    if (moved) {
      throw new AppError(
        `Le stock de « ${existing.name} » est compté en ${existing.unit_name ?? 'pièce'} depuis ses premiers mouvements : cette unité ne peut plus changer. Créez un nouvel article pour vendre dans une unité plus petite.`,
        'STOCK_UNIT_LOCKED',
      );
    }
  }

  /** Photo de l'article (data URL), null sans photo. */
  photo(articleId: string): string | null {
    return (this.db.prepare('SELECT photo FROM article_photos WHERE article_id = ?').pluck().get(articleId) as string | undefined) ?? null;
  }

  /**
   * Photo de l'article, déjà réduite par l'interface (environ 400 px) avec sa
   * miniature ; null la retire. Elle part aux autres postes avec l'article.
   */
  setPhoto(userId: string, articleId: string, input: { photo: string; thumb: string } | null): Article {
    this.getArticle(articleId);
    if (input) {
      for (const [v, max] of [
        [input.photo, PHOTO_MAX],
        [input.thumb, THUMB_MAX],
      ] as const) {
        if (typeof v !== 'string' || !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(v)) throw new AppError('Image invalide : choisissez une photo JPEG ou PNG', 'INVALID');
        if (v.length > max) throw new AppError('Photo trop lourde, même réduite : choisissez une autre image', 'INVALID');
      }
    }
    return this.tx(() => {
      const now = this.now();
      if (input) {
        this.db
          .prepare(
            `INSERT INTO article_photos (article_id, photo, thumb, updated_at) VALUES (?, ?, ?, ?)
             ON CONFLICT(article_id) DO UPDATE SET photo = excluded.photo, thumb = excluded.thumb, updated_at = excluded.updated_at`,
          )
          .run(articleId, input.photo, input.thumb, now);
      } else {
        this.db.prepare('DELETE FROM article_photos WHERE article_id = ?').run(articleId);
      }
      this.db.prepare('UPDATE articles SET updated_at = ? WHERE id = ?').run(now, articleId);
      this.enqueue(null, 'article', articleId, 'upsert', {});
      this.audit(userId, input ? 'article.photo' : 'article.photo_remove', 'article', articleId, {});
      return this.getArticle(articleId);
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

  /** Chiffre propre au poste dans les codes EAN-8 : deux PC hors ligne ne tirent pas le même code. */
  private ean8Node(): number {
    let node = this.db.prepare("SELECT value FROM settings WHERE key = 'barcode.node8'").pluck().get() as string | undefined;
    if (!node) {
      node = String(randomInt(0, 10));
      this.db.prepare("INSERT INTO settings (key, value) VALUES ('barcode.node8', ?)").run(node);
    }
    return Number(node);
  }

  private internalCode(kind: BarcodeKind, seq: number): string {
    if (kind === 'ean13') {
      let node = this.db.prepare("SELECT value FROM settings WHERE key = 'barcode.node'").pluck().get() as string | undefined;
      if (!node) {
        node = String(randomInt(0, 1000));
        this.db.prepare("INSERT INTO settings (key, value) VALUES ('barcode.node', ?)").run(node);
      }
      return internalEan13(Number(node) * 10_000_000 + seq);
    }
    if (seq > 99_999) throw new AppError('Plus de codes EAN-8 libres sur ce poste : passez les codes internes en EAN-13 (Paramètres)', 'INVALID');
    return internalEan8(this.ean8Node() * 100_000 + seq);
  }

  private counterOf = (kind: BarcodeKind) => (kind === 'ean8' ? 'barcode.internal8' : 'barcode.internal');

  /**
   * Code-barres interne libre, préfixe 2 : EAN-8 (2 + poste + 5 chiffres + clé)
   * ou EAN-13 (20 + poste + 7 chiffres + clé). Les codes déjà pris sont sautés.
   */
  generateInternalBarcode(kind: BarcodeKind = 'ean13'): string {
    for (;;) {
      const code = this.internalCode(kind, this.nextCounter(this.counterOf(kind)));
      const taken = this.db.prepare('SELECT 1 FROM barcodes WHERE code = ? UNION SELECT 1 FROM article_packs WHERE barcode = ?').get(code, code);
      if (!taken) return code;
    }
  }

  /** Prochain code interne (sans le réserver) et nombre de codes internes déjà donnés, pour les Paramètres. */
  internalBarcodeInfo(kind: BarcodeKind): { next: string; created: number } {
    let seq = ((this.db.prepare('SELECT value FROM counters WHERE name = ?').pluck().get(this.counterOf(kind)) as number | undefined) ?? 0) + 1;
    let next = this.internalCode(kind, seq);
    while (this.db.prepare('SELECT 1 FROM barcodes WHERE code = ?').get(next)) next = this.internalCode(kind, ++seq);
    const pattern = kind === 'ean8' ? '2_______' : '20___________';
    const created = this.db.prepare('SELECT COUNT(*) FROM barcodes WHERE code LIKE ? AND length(code) = ?').pluck().get(pattern, pattern.length) as number;
    return { next, created };
  }

  /**
   * Donne un code interne à tout ce qui n'en a pas : l'unité des articles actifs
   * à la pièce (hors balance) et chaque carton ou pack. Renvoie le nombre de codes créés.
   */
  assignMissingBarcodes(userId: string, kind: BarcodeKind): number {
    return this.tx(() => {
      const rows = this.db
        .prepare("SELECT id, unit, plu FROM articles WHERE active = 1")
        .all() as { id: string; unit: string; plu: string | null }[];
      const insertCode = this.db.prepare('INSERT INTO barcodes (code, article_id, pack_qty) VALUES (?, ?, ?)');
      const setPack = this.db.prepare('UPDATE article_packs SET barcode = ? WHERE id = ?');
      let created = 0;
      for (const r of rows) {
        const codes = this.db.prepare('SELECT pack_qty FROM barcodes WHERE article_id = ?').pluck().all(r.id) as number[];
        const packs = this.db.prepare('SELECT id, units FROM article_packs WHERE article_id = ? AND barcode IS NULL').all(r.id) as { id: string; units: Milli }[];
        let changed = false;
        if (r.unit === 'piece' && !r.plu && !codes.includes(1000)) {
          insertCode.run(this.generateInternalBarcode(kind), r.id, 1000);
          changed = true;
          created++;
        }
        for (const p of packs) {
          const code = this.generateInternalBarcode(kind);
          setPack.run(code, p.id);
          insertCode.run(code, r.id, p.units);
          changed = true;
          created++;
        }
        if (changed) this.enqueue(null, 'article', r.id, 'upsert', this.getArticle(r.id));
      }
      if (created) this.audit(userId, 'barcode.assign', 'article', undefined, { created, kind });
      return created;
    });
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
    if (hit) {
      const article = this.getArticle(hit.article_id, storeId);
      const pack = article.packs.find((p) => p.barcode === code);
      return { article, barcode: code, qty: pack?.units ?? hit.pack_qty, ...(pack ? { pack } : {}) };
    }

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
  /** Fiche existante reprise telle quelle, pour la réenregistrer avec quelques changements. */
  private inputOf(a: Article): ArticleInput {
    const packCodes = new Set(a.packs.map((p) => p.barcode).filter(Boolean));
    return {
      code: a.code,
      name: a.name,
      familyId: a.family_id,
      brand: a.brand,
      unit: a.unit,
      vatRateId: a.vat_rate_id,
      purchasePrice: a.purchase_price,
      salePrice: a.sale_price,
      perishable: a.perishable === 1,
      plu: a.plu,
      quickKey: a.quick_key === 1,
      minQty: a.min_qty,
      alertQty: a.alert_qty,
      maxQty: a.max_qty,
      active: a.active === 1,
      barcodes: a.barcodes.filter((b) => !packCodes.has(b.code)).map((b) => ({ code: b.code, packQty: b.pack_qty })),
    };
  }

  /** Article d'un code article ou d'un code-barres (unité ou conditionnement). */
  findByCode(code: string): string | null {
    const c = code.trim();
    if (!c) return null;
    const byCode = this.db.prepare('SELECT id FROM articles WHERE code = ? OR code = ?').pluck().get(c, c.toUpperCase()) as string | undefined;
    if (byCode) return byCode;
    return (this.db.prepare('SELECT article_id FROM barcodes WHERE code = ?').pluck().get(normalizeBarcode(c)) as string | undefined) ?? null;
  }

  /**
   * Import du catalogue (Excel, CSV, modèle de boutique). Chaque ligne retrouve
   * sa fiche par le code article, puis un code-barres, puis la désignation
   * exacte ; sinon elle crée l'article. Ce qui n'est pas dans le fichier reste
   * tel quel sur la fiche. `preview` fait tout le travail puis l'annule, pour
   * l'aperçu ; une ligne en erreur n'empêche pas les autres.
   */
  importArticles(
    userId: string,
    rows: ArticleImportRow[],
    opts: { noVat?: boolean; mode?: ImportMode; preview?: boolean; autoBarcode?: BarcodeKind | null; codeByFamily?: boolean } = {},
  ): ImportResult {
    const mode = opts.mode ?? 'upsert';
    const rates = this.db.prepare('SELECT id, rate_bp FROM vat_rates WHERE active = 1').all() as { id: string; rate_bp: number }[];
    const result: ImportResult = { created: 0, updated: 0, skipped: 0, errors: [], lines: [] };
    const familyId = (dep?: string, fam?: string): string | null => {
      if (!dep && !fam) return null;
      if (!dep) {
        // Famille sans rayon : la famille de ce nom, sinon un rayon du même nom.
        const known = this.db.prepare('SELECT id FROM families WHERE fold(name) = fold(?) ORDER BY id LIMIT 1').pluck().get(fam!.trim()) as string | undefined;
        if (known) return known;
        dep = fam;
      }
      let depId = this.db.prepare('SELECT id FROM departments WHERE fold(name) = fold(?)').pluck().get(dep!.trim()) as string | undefined;
      depId ??= this.createDepartment(dep!).id;
      const famName = fam?.trim() || dep!.trim();
      const existing = this.db.prepare('SELECT id FROM families WHERE department_id = ? AND fold(name) = fold(?)').pluck().get(depId, famName) as string | undefined;
      return existing ?? this.createFamily(depId, famName).id;
    };
    const findExisting = (row: ArticleImportRow): string | null => {
      if (row.code) {
        const id = this.db.prepare('SELECT id FROM articles WHERE code = ?').pluck().get(row.code) as string | undefined;
        if (id) return id;
      }
      for (const code of [row.barcode, ...(row.packs ?? []).map((p) => p.barcode)]) {
        if (!code?.trim()) continue;
        const id = this.db.prepare('SELECT article_id FROM barcodes WHERE code = ?').pluck().get(normalizeBarcode(code)) as string | undefined;
        if (id) return id;
      }
      if (row.name.trim()) {
        const ids = this.db.prepare('SELECT id FROM articles WHERE fold(name) = fold(?) AND is_service = 0').pluck().all(row.name.trim()) as string[];
        if (ids.length === 1) return ids[0]!;
      }
      return null;
    };
    const substitutes: { articleId: string; code: string; line: number }[] = [];
    const run = () => {
      rows.forEach((row, index) => {
        const line = row.line ?? index + 1;
        const label = row.name || row.code || `ligne ${line}`;
        try {
          if (row.invalid) throw new AppError(row.invalid, 'INVALID');
          const existingId = findExisting(row);
          const existing = existingId ? this.getArticle(existingId) : null;
          if ((existing && mode === 'create') || (!existing && mode === 'update')) {
            result.skipped++;
            result.lines.push({ row: line, name: label, action: 'skip' });
            return;
          }
          if (!existing && !row.name.trim()) throw new AppError('Désignation vide', 'INVALID');
          if (!existing && row.salePrice === undefined) throw new AppError('Prix de vente manquant', 'INVALID');
          let vatRateId: string;
          if (opts.noVat) {
            // Magasin sans TVA : tout article créé est exonéré, un article existant garde son taux.
            vatRateId = existing?.vat_rate_id ?? rates.find((r) => r.rate_bp === 0)?.id ?? '';
          } else if (row.vatRateBp !== undefined) {
            vatRateId = rates.find((r) => r.rate_bp === row.vatRateBp)?.id ?? '';
            if (!vatRateId) throw new AppError(`Taux de TVA inconnu : ${String(row.vatRateBp / 100).replace('.', ',')} %`, 'INVALID');
          } else {
            vatRateId = existing?.vat_rate_id ?? rates.find((r) => r.rate_bp === 1925)?.id ?? rates[0]?.id ?? '';
          }
          if (!vatRateId) throw new AppError('Aucun taux de TVA exonéré : créez-le dans Administration', 'INVALID');
          const base: ArticleInput = existing
            ? this.inputOf(existing)
            : { name: row.name, unit: 'piece', vatRateId, purchasePrice: 0, salePrice: 0, barcodes: [] };
          const code = row.barcode?.trim() ? normalizeBarcode(row.barcode) : null;
          let barcodes = base.barcodes ?? [];
          let packs: PackInput[] | undefined;
          if (row.packs) {
            // Nouveaux conditionnements : un carton déjà connu garde son code-barres si le fichier n'en donne pas.
            packs = row.packs.map((p) => ({
              name: p.name,
              contains: p.contains,
              salePrice: p.salePrice,
              wholesalePrice: p.wholesalePrice ?? null,
              superWholesalePrice: p.superWholesalePrice ?? null,
              barcode: p.barcode?.trim() || existing?.packs.find((x) => x.name.toLowerCase() === p.name.toLowerCase())?.barcode || null,
            }));
          }
          if (code && !barcodes.some((b) => b.code === code) && !packs?.some((p) => p.barcode && normalizeBarcode(p.barcode) === code)) {
            barcodes = [...barcodes, { code, packQty: 1000 }];
          }
          const input: ArticleInput = {
            ...base,
            code: existing ? existing.code : row.code,
            name: row.name.trim() || base.name,
            familyId: row.department || row.family ? familyId(row.department, row.family) : (base.familyId ?? null),
            brand: row.brand ?? base.brand,
            unit: row.unit ?? base.unit,
            vatRateId,
            purchasePrice: row.purchasePrice ?? base.purchasePrice,
            salePrice: row.salePrice ?? base.salePrice,
            perishable: row.perishable ?? base.perishable,
            plu: row.plu ?? base.plu,
            minQty: row.minQty ?? base.minQty,
            alertQty: row.alertQty ?? base.alertQty,
            maxQty: row.maxQty ?? base.maxQty,
            active: row.active ?? base.active,
            barcodes,
            unitName: row.unitName,
            wholesalePrice: row.wholesalePrice,
            superWholesalePrice: row.superWholesalePrice,
            otherRef: row.otherRef,
            packs,
          };
          // Une ligne à la fois : si elle échoue, rien d'elle ne reste (rayon créé, codes…).
          const saved = this.tx(() => this.saveArticle(userId, input, existingId ?? undefined, { autoBarcode: opts.autoBarcode, codeByFamily: opts.codeByFamily }));
          if (row.substitute) substitutes.push({ articleId: saved.id, code: row.substitute, line });
          if (existing) result.updated++;
          else result.created++;
          result.lines.push({ row: line, name: saved.name, action: existing ? 'update' : 'create', code: saved.code });
        } catch (e) {
          result.errors.push({ row: line, message: `${label} : ${e instanceof Error ? e.message : String(e)}` });
        }
      });
      // Remplaçants en dernier : l'article remplaçant peut être plus bas dans le fichier.
      for (const s of substitutes) {
        const target = this.findByCode(s.code);
        if (!target || target === s.articleId) {
          result.errors.push({ row: s.line, message: `Article de remplacement « ${s.code} » introuvable` });
          continue;
        }
        this.setSubstitute(userId, s.articleId, target);
      }
    };
    if (!opts.preview) {
      this.tx(run);
      return result;
    }
    try {
      this.tx(() => {
        run();
        throw new PreviewDone();
      });
    } catch (e) {
      if (!(e instanceof PreviewDone)) throw e;
    }
    return result;
  }

  /** Article proposé en caisse quand celui-ci est épuisé ; null le retire. */
  setSubstitute(userId: string, articleId: string, substituteId: string | null): Article {
    const a = this.getArticle(articleId);
    return this.saveArticle(userId, { ...this.inputOf(a), substituteId }, articleId);
  }

  /** Prix par quantité de l'unité de détail (« 480 F à partir de 12 ») ; une liste vide les retire. */
  setQtyTiers(userId: string, articleId: string, tiers: QtyTier[]): Article {
    const a = this.getArticle(articleId);
    const clean = tiers.map((t) => ({ minQty: t.minQty, price: t.price })).sort((x, y) => x.minQty - y.minQty);
    if (clean.length && a.unit !== 'piece') throw new AppError('Les prix par quantité ne valent que pour les articles vendus à la pièce', 'INVALID');
    const err = checkQtyTiers(clean, a.sale_price);
    if (err) throw new AppError(err, 'INVALID');
    const json = clean.length ? JSON.stringify(clean) : null;
    if (json === (a.qty_tiers ?? null)) return a;
    return this.tx(() => {
      this.db.prepare('UPDATE articles SET qty_tiers = ?, updated_at = ? WHERE id = ?').run(json, this.now(), articleId);
      const next = this.getArticle(articleId);
      this.enqueue(null, 'article', articleId, 'upsert', next);
      this.audit(userId, 'article.qty_tiers', 'article', articleId, { tiers: clean });
      return next;
    });
  }

  /** Emplacement de l'article dans un dépôt (allée, étagère) ; vide le retire. */
  setLocation(userId: string, articleId: string, warehouseId: string, location: string): Article {
    const a = this.getArticle(articleId);
    const value = location.trim().toUpperCase();
    if (value.length > 20) throw new AppError('Emplacement trop long (20 caractères au plus)', 'INVALID');
    const map = parseLocations(a.locations);
    if (value) map[warehouseId] = value;
    else delete map[warehouseId];
    if ((parseLocations(a.locations)[warehouseId] ?? '') === value) return a;
    return this.tx(() => {
      this.db.prepare('UPDATE articles SET locations = ?, updated_at = ? WHERE id = ?').run(Object.keys(map).length ? JSON.stringify(map) : null, this.now(), articleId);
      const next = this.getArticle(articleId);
      this.enqueue(null, 'article', articleId, 'upsert', next);
      this.audit(userId, 'article.location', 'article', articleId, { warehouseId, location: value || null });
      return next;
    });
  }

  /**
   * Articles à exporter, sans limite de nombre : filtre de la liste (recherche,
   * rayon, famille, actifs ou en sommeil), avec le stock, le coût moyen et
   * l'emplacement dans chaque dépôt du magasin.
   */
  listForExport(storeId: string, filter: ExportFilter = {}): (Article & ExportArticle)[] {
    const q = filter.query?.trim() ? `%${filter.query.trim().replace(/[%_]/g, '')}%` : null;
    const rows = this.db
      .prepare(
        `${ARTICLE_SELECT}
         WHERE a.is_service = 0
           AND (@q IS NULL OR a.name LIKE @q OR a.code LIKE @q OR a.brand LIKE @q OR a.other_ref LIKE @q
                OR a.id IN (SELECT article_id FROM barcodes WHERE code LIKE @q))
           AND (@status = 'all' OR (@status = 'active' AND a.active = 1) OR (@status = 'inactive' AND a.active = 0))
           AND (@familyId IS NULL OR a.family_id = @familyId)
           AND (@departmentId IS NULL OR f.department_id = @departmentId)
           AND (@supplierId IS NULL OR a.id IN (SELECT article_id FROM supplier_articles WHERE supplier_id = @supplierId))
         ORDER BY d.name, f.name, a.name`,
      )
      .all({
        storeId,
        q,
        status: filter.status ?? 'all',
        familyId: filter.familyId ?? null,
        departmentId: filter.departmentId ?? null,
        supplierId: filter.supplierId ?? null,
      }) as Omit<Article, 'barcodes' | 'packs'>[];
    const articles = this.withBarcodes(rows);
    const stock = this.db
      .prepare('SELECT s.article_id, s.warehouse_id, s.qty, s.avg_cost FROM stock s JOIN warehouses w ON w.id = s.warehouse_id WHERE w.store_id = ?')
      .all(storeId) as { article_id: string; warehouse_id: string; qty: Milli; avg_cost: Fcfa }[];
    const byArticle = new Map<string, typeof stock>();
    for (const s of stock) byArticle.set(s.article_id, [...(byArticle.get(s.article_id) ?? []), s]);
    const warehouses = this.db.prepare('SELECT id FROM warehouses WHERE store_id = ?').pluck().all(storeId) as string[];
    return articles.map((a) => {
      const locations = parseLocations(a.locations);
      const own = byArticle.get(a.id) ?? [];
      return {
        ...a,
        stock: warehouses
          .map((w) => {
            const s = own.find((x) => x.warehouse_id === w);
            return { warehouse_id: w, qty: s?.qty ?? 0, avg_cost: s?.avg_cost ?? 0, location: locations[w] ?? null };
          })
          .filter((s) => s.qty !== 0 || s.location),
      };
    });
  }

  // --- Mise à jour des prix en masse ------------------------

  private priceTargets(storeId: string, input: PriceUpdateInput): Article[] {
    if (input.articleIds?.length) return input.articleIds.map((id) => this.getArticle(id, storeId));
    return this.listForExport(storeId, {
      status: input.includeInactive ? 'all' : 'active',
      departmentId: input.departmentId ?? null,
      familyId: input.familyId ?? null,
      supplierId: input.supplierId ?? null,
    });
  }

  /**
   * Calcule les nouveaux prix d'une sélection : hausse ou baisse en %, montant
   * ajouté (par unité de détail), ou prix de vente = prix d'achat × coefficient.
   * Le prix d'achat peut entraîner le prix de vente (même proportion, marge gardée).
   */
  planPriceUpdate(storeId: string, input: PriceUpdateInput): PriceUpdatePlan {
    if (!Number.isFinite(input.value)) throw new AppError('Valeur de la mise à jour invalide', 'INVALID');
    if (input.method === 'coefficient' && (input.target !== 'sale' || input.value <= 0)) throw new AppError('Le coefficient (supérieur à 0) calcule le prix de vente à partir du prix d’achat', 'INVALID');
    if (input.method === 'percent' && input.value <= -100) throw new AppError('Une baisse de 100 % ou plus mettrait les prix à zéro', 'INVALID');
    const rounding = [1, 5, 10, 25, 50, 100].includes(input.rounding) ? input.rounding : 1;
    const round = (v: number) => Math.max(rounding, Math.round(v / rounding) * rounding);
    const plans: PriceUpdatePlan['articles'] = [];
    for (const a of this.priceTargets(storeId, input)) {
      const lines: PriceUpdateLine[] = [];
      const unitName = a.unit === 'piece' ? (a.unit_name ?? 'Pièce') : a.unit === 'kg' ? 'Kg' : 'Litre';
      const change = (old: number, units: Milli) =>
        input.method === 'percent' ? old * (1 + input.value / 100) : old + (input.value * units) / 1000;
      let purchase = a.purchase_price;
      let ratio = 1;
      if (input.target === 'purchase') {
        purchase = Math.round(change(a.purchase_price, 1000));
        if (purchase < 0) throw new AppError(`${a.name} : le prix d'achat deviendrait négatif`, 'INVALID');
        if (purchase !== a.purchase_price) lines.push({ level: unitName, field: 'purchase', old: a.purchase_price, next: purchase });
        ratio = a.purchase_price > 0 ? purchase / a.purchase_price : 1;
      }
      const sale = input.target === 'sale' || input.followSale;
      const nextSale = (old: number, units: Milli): number => {
        if (input.target === 'purchase') return round(old * ratio);
        if (input.method === 'coefficient') return round(((a.purchase_price * units) / 1000) * input.value * (1 + a.vat_rate_bp / 10000));
        return round(change(old, units));
      };
      const salePrices = { unit: a.sale_price, store: a.store_price !== a.sale_price ? a.store_price : null, wholesale: a.wholesale_price, superWholesale: a.super_wholesale_price, packs: a.packs };
      const next = { unit: a.sale_price, store: salePrices.store, wholesale: a.wholesale_price, superWholesale: a.super_wholesale_price, packs: a.packs.map((p) => ({ ...p })) };
      if (sale && !(input.method === 'coefficient' && a.purchase_price <= 0)) {
        next.unit = nextSale(a.sale_price, 1000);
        if (next.unit !== a.sale_price) lines.push({ level: unitName, field: 'sale', old: a.sale_price, next: next.unit });
        if (salePrices.store !== null) {
          next.store = nextSale(salePrices.store, 1000);
          if (next.store !== salePrices.store) lines.push({ level: `${unitName} (prix magasin)`, field: 'sale', old: salePrices.store, next: next.store });
        }
        const tiers = input.tiers && input.method !== 'coefficient';
        if (tiers && a.wholesale_price !== null) {
          next.wholesale = nextSale(a.wholesale_price, 1000);
          if (next.wholesale !== a.wholesale_price) lines.push({ level: unitName, field: 'wholesale', old: a.wholesale_price, next: next.wholesale });
        }
        if (tiers && a.super_wholesale_price !== null) {
          next.superWholesale = nextSale(a.super_wholesale_price, 1000);
          if (next.superWholesale !== a.super_wholesale_price) lines.push({ level: unitName, field: 'superWholesale', old: a.super_wholesale_price, next: next.superWholesale });
        }
        if (input.packs) {
          next.packs = a.packs.map((p) => {
            const np = { ...p, sale_price: nextSale(p.sale_price, p.units) };
            if (np.sale_price !== p.sale_price) lines.push({ level: p.name, field: 'sale', old: p.sale_price, next: np.sale_price });
            if (tiers && p.wholesale_price !== null) {
              np.wholesale_price = nextSale(p.wholesale_price, p.units);
              if (np.wholesale_price !== p.wholesale_price) lines.push({ level: p.name, field: 'wholesale', old: p.wholesale_price, next: np.wholesale_price });
            }
            if (tiers && p.super_wholesale_price !== null) {
              np.super_wholesale_price = nextSale(p.super_wholesale_price, p.units);
              if (np.super_wholesale_price !== p.super_wholesale_price) lines.push({ level: p.name, field: 'superWholesale', old: p.super_wholesale_price, next: np.super_wholesale_price });
            }
            return np;
          });
        }
      }
      if (lines.length) plans.push({ articleId: a.id, code: a.code, name: a.name, purchase, ...next, lines });
    }
    return { articles: plans, lines: plans.reduce((t, p) => t + p.lines.length, 0) };
  }

  /** Applique la mise à jour calculée par `planPriceUpdate` (historique des prix et audit compris). */
  applyPriceUpdate(userId: string, storeId: string, input: PriceUpdateInput): { articles: number; lines: number } {
    const plan = this.planPriceUpdate(storeId, input);
    return this.tx(() => {
      this.applyPlan(userId, storeId, plan);
      this.audit(userId, 'price.bulk_update', 'article', undefined, { ...input, articleIds: input.articleIds?.length, articles: plan.articles.length });
      return { articles: plan.articles.length, lines: plan.lines };
    });
  }

  /**
   * Prix d'un plan déjà calculé, mis tels quels sur les articles (prix
   * programmés). Un article déjà à ces prix n'est pas réécrit : deux PC qui
   * appliquent le même plan ne créent pas de nouvelle modification.
   */
  applyPlan(userId: string, storeId: string, plan: PriceUpdatePlan): number {
    let changed = 0;
    this.tx(() => {
      for (const p of plan.articles) {
        if (!this.db.prepare('SELECT 1 FROM articles WHERE id = ?').get(p.articleId)) continue;
        const a = this.getArticle(p.articleId, storeId);
        const store = a.store_price !== a.sale_price ? a.store_price : null;
        const packsSame = !a.packs.length || a.packs.every((x, i) => {
          const n = p.packs[i];
          return n && n.sale_price === x.sale_price && n.wholesale_price === x.wholesale_price && n.super_wholesale_price === x.super_wholesale_price;
        });
        if (a.purchase_price === p.purchase && a.sale_price === p.unit && a.wholesale_price === p.wholesale && a.super_wholesale_price === p.superWholesale && packsSame && (p.store === null || p.store === store)) continue;
        changed += 1;
        this.saveArticle(
          userId,
          {
            ...this.inputOf(a),
            purchasePrice: p.purchase,
            salePrice: p.unit,
            wholesalePrice: p.wholesale,
            superWholesalePrice: p.superWholesale,
            packs: a.packs.length
              ? p.packs.map((x) => ({ name: x.name, contains: x.contains, salePrice: x.sale_price, wholesalePrice: x.wholesale_price, superWholesalePrice: x.super_wholesale_price, barcode: x.barcode }))
              : undefined,
          },
          a.id,
        );
        if (p.store !== null && p.store !== store) this.setStorePrice(userId, a.id, storeId, p.store);
      }
    });
    return changed;
  }

  /** Contenu net (« 900 g », « 1,5 L ») pour le prix au kilo ou au litre ; vide le retire. */
  setNetContent(userId: string, articleId: string, text: string | null): Article {
    const a = this.getArticle(articleId);
    const value = (text ?? '').trim().slice(0, 30) || null;
    if (value && !parseNetContent(value)) throw new AppError('Contenu net illisible : écrivez par exemple « 900 g », « 1,5 L » ou « 6 x 33 cl »', 'INVALID');
    if (value === (a.net_content ?? null)) return a;
    return this.tx(() => {
      this.db.prepare('UPDATE articles SET net_content = ?, updated_at = ? WHERE id = ?').run(value, this.now(), articleId);
      const next = this.getArticle(articleId);
      this.enqueue(null, 'article', articleId, 'upsert', next);
      this.audit(userId, 'article.net_content', 'article', articleId, { value });
      return next;
    });
  }
}

/** Fin d'un aperçu d'import : tout ce qui a été fait est annulé. */
class PreviewDone extends Error {}

export type ImportMode = 'upsert' | 'create' | 'update';

export interface ImportResult {
  created: number;
  updated: number;
  /** Lignes laissées de côté par le mode d'import (créer seulement, mettre à jour seulement). */
  skipped: number;
  /** `row` : ligne du fichier. */
  errors: { row: number; message: string }[];
  lines: { row: number; name: string; action: 'create' | 'update' | 'skip'; code?: string }[];
}

export interface ExportFilter {
  query?: string | null;
  departmentId?: string | null;
  familyId?: string | null;
  supplierId?: string | null;
  status?: 'active' | 'inactive' | 'all';
}

export interface PriceUpdateInput {
  departmentId?: string | null;
  familyId?: string | null;
  supplierId?: string | null;
  /** Articles choisis un par un ; remplace les filtres. */
  articleIds?: string[];
  includeInactive?: boolean;
  target: 'sale' | 'purchase';
  /** percent : +10 ou -5 ; amount : FCFA par unité de détail ; coefficient : prix de vente = achat HT × coefficient, TVA comprise. */
  method: 'percent' | 'amount' | 'coefficient';
  value: number;
  /** Changer aussi les prix des conditionnements (carton, pack). */
  packs: boolean;
  /** Changer aussi les prix de gros et super gros. */
  tiers: boolean;
  /** Prix d'achat changé : le prix de vente suit dans la même proportion. */
  followSale?: boolean;
  /** Arrondi des prix de vente (au multiple le plus proche). */
  rounding: number;
}

export interface PriceUpdateLine {
  level: string;
  field: 'purchase' | 'sale' | 'wholesale' | 'superWholesale';
  old: Fcfa;
  next: Fcfa;
}

export interface PriceUpdatePlan {
  articles: {
    articleId: string;
    code: string;
    name: string;
    purchase: Fcfa;
    unit: Fcfa;
    store: Fcfa | null;
    wholesale: Fcfa | null;
    superWholesale: Fcfa | null;
    packs: ArticlePack[];
    lines: PriceUpdateLine[];
  }[];
  lines: number;
}

/** Emplacements d'un article par dépôt, lus sans jamais échouer. */
export function parseLocations(json: string | null | undefined): Record<string, string> {
  if (!json) return {};
  try {
    const v = JSON.parse(json) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([, x]) => typeof x === 'string')) as Record<string, string> : {};
  } catch {
    return {};
  }
}
