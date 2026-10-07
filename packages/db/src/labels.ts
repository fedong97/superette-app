import { type Fcfa, type LabelData, type Milli, type PromotionRule, formatFcfa, promotionLabel } from '@superette/core';
import type { Article, CatalogueService } from './catalogue';
import type { Db } from './database';
import type { PromotionService } from './promotions';
import { AppError, Base, type Clock } from './util';

/** Une étiquette demandée : l'unité (`pack` vide) ou un conditionnement, en `copies` exemplaires. */
export interface LabelItem {
  articleId: string;
  /** Nom du conditionnement (Carton) ; vide pour l'unité de détail. */
  pack?: string | null;
  copies: number;
}

/** Article (ou conditionnement) proposé à l'impression, avec le prix déjà affiché en rayon. */
export interface LabelCandidate {
  article_id: string;
  code: string;
  name: string;
  department_name: string | null;
  pack: string;
  /** « Ampoule », « Carton de 100 ». */
  pack_label: string;
  price: Fcfa;
  /** Prix de la dernière étiquette imprimée sur ce poste ; null si jamais imprimée. */
  last_price: Fcfa | null;
  printed_at: string | null;
  stock: Milli;
  /** Pourquoi refaire l'étiquette : nouvel article en stock, ou prix changé. */
  reason: 'new' | 'price' | null;
}

const MAX_LABELS = 2000;
const UNIT_WORD = { kg: 'le kg', litre: 'le litre' } as const;

/**
 * Étiquettes de rayon : prix du magasin (promotion comprise), un code-barres par
 * conditionnement, et suivi du dernier prix imprimé pour savoir quelles
 * étiquettes refaire après un changement de prix ou une réception.
 */
export class LabelService extends Base {
  constructor(
    db: Db,
    clock: Clock,
    private readonly catalogue: CatalogueService,
    private readonly promotions: PromotionService,
  ) {
    super(db, clock);
  }

  /** Prix affiché : prix promo du jour pour l'unité, sinon prix du magasin ou du conditionnement. */
  private priceOf(a: Article, pack: string, rules: Map<string, PromotionRule>): Fcfa {
    if (!pack) {
      const rule = rules.get(a.id);
      return rule?.kind === 'price' && rule.promoPrice ? rule.promoPrice : a.store_price;
    }
    const p = a.packs.find((x) => x.name === pack);
    if (!p) throw new AppError(`Conditionnement « ${pack} » introuvable pour ${a.name}`, 'NOT_FOUND');
    return p.sale_price;
  }

  private rules(storeId: string): Map<string, PromotionRule> {
    return new Map(this.promotions.activeRules(storeId).map((r) => [r.articleId, r]));
  }

  /**
   * Étiquettes possibles, unité et conditionnements. `redo` ne garde que les
   * étiquettes à refaire : jamais imprimées pour un article en stock, ou prix changé.
   */
  candidates(storeId: string, opts: { redo?: boolean; departmentId?: string | null; search?: string } = {}): LabelCandidate[] {
    const rules = this.rules(storeId);
    const printed = new Map(
      (
        this.db.prepare('SELECT article_id, pack, price, printed_at FROM label_prints WHERE store_id = ?').all(storeId) as {
          article_id: string;
          pack: string;
          price: Fcfa;
          printed_at: string;
        }[]
      ).map((r) => [`${r.article_id}|${r.pack}`, r]),
    );
    const stock = new Map(
      (
        this.db
          .prepare(
            `SELECT s.article_id, SUM(s.qty) AS qty FROM stock s JOIN warehouses w ON w.id = s.warehouse_id
             WHERE w.store_id = ? GROUP BY s.article_id`,
          )
          .all(storeId) as { article_id: string; qty: Milli }[]
      ).map((r) => [r.article_id, r.qty]),
    );
    const departments = opts.departmentId
      ? new Set(
          this.db
            .prepare('SELECT id FROM families WHERE department_id = ?')
            .pluck()
            .all(opts.departmentId) as string[],
        )
      : null;
    const out: LabelCandidate[] = [];
    for (const a of this.catalogue.searchArticles(opts.search ?? '', storeId, { limit: 100_000 })) {
      if (departments && !(a.family_id && departments.has(a.family_id))) continue;
      const unitName = a.unit_name || 'Pièce';
      const levels = [
        ...a.packs.map((p) => ({ pack: p.name, label: `${p.name} de ${p.units / 1000}` })),
        { pack: '', label: a.unit === 'piece' ? unitName : UNIT_WORD[a.unit] },
      ];
      const qty = stock.get(a.id) ?? 0;
      for (const l of levels) {
        const price = this.priceOf(a, l.pack, rules);
        const last = printed.get(`${a.id}|${l.pack}`);
        const reason = last ? (last.price !== price ? 'price' : null) : qty > 0 ? 'new' : null;
        if (opts.redo && !reason) continue;
        out.push({
          article_id: a.id,
          code: a.code,
          name: a.name,
          department_name: a.department_name,
          pack: l.pack,
          pack_label: l.label,
          price,
          last_price: last?.price ?? null,
          printed_at: last?.printed_at ?? null,
          stock: qty,
          reason,
        });
      }
    }
    return out;
  }

  /** Contenu des étiquettes, chaque article répété `copies` fois. */
  build(storeId: string, items: readonly LabelItem[]): LabelData[] {
    const total = items.reduce((s, i) => s + Math.max(0, Math.floor(i.copies)), 0);
    if (total === 0) throw new AppError('Aucune étiquette à imprimer', 'INVALID');
    if (total > MAX_LABELS) throw new AppError(`${MAX_LABELS} étiquettes au plus par impression`, 'INVALID');
    const rules = this.rules(storeId);
    const d = this.today();
    const date = `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;
    const out: LabelData[] = [];
    for (const item of items) {
      const a = this.catalogue.getArticle(item.articleId, storeId);
      const pack = item.pack ?? '';
      const price = this.priceOf(a, pack, rules);
      const unitName = (a.unit_name || 'Pièce').toLowerCase();
      let label: LabelData;
      if (pack) {
        const p = a.packs.find((x) => x.name === pack)!;
        const n = p.units / 1000;
        label = {
          name: `${a.name} · ${p.name}`,
          price,
          detail: `${p.name} de ${n} ${n > 1 ? plural(unitName) : unitName} · ${formatFcfa(Math.round(price / n), false)} F l’unité`,
          barcode: p.barcode,
          code: a.code,
          date,
        };
      } else {
        const rule = rules.get(a.id);
        // Le conditionnement juste au-dessus de l'unité (le pack plutôt que la palette).
        const big = a.packs.at(-1);
        label = {
          name: a.name,
          price,
          oldPrice: rule?.kind === 'price' && price !== a.store_price ? a.store_price : null,
          promo: rule ? (rule.kind === 'price' ? 'PROMO' : promotionLabel(rule, (v) => formatFcfa(v, false))) : null,
          detail:
            a.unit !== 'piece'
              ? `Prix ${UNIT_WORD[a.unit]}`
              : big
                ? `${big.name} de ${big.units / 1000} : ${formatFcfa(big.sale_price, false)} F`
                : null,
          barcode: a.unit === 'piece' ? (a.barcodes.find((b) => b.pack_qty === 1000)?.code ?? null) : null,
          code: a.code,
          date,
        };
      }
      for (let i = 0; i < Math.floor(item.copies); i++) out.push(label);
    }
    return out;
  }

  /** Retient le prix imprimé : l'étiquette sort de la liste « à refaire ». */
  markPrinted(storeId: string, items: readonly LabelItem[]): void {
    const rules = this.rules(storeId);
    const now = this.now();
    const upsert = this.db.prepare(
      `INSERT INTO label_prints (store_id, article_id, pack, price, printed_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (store_id, article_id, pack) DO UPDATE SET price = excluded.price, printed_at = excluded.printed_at`,
    );
    this.db.transaction(() => {
      for (const item of items) {
        if (item.copies < 1) continue;
        const a = this.catalogue.getArticle(item.articleId, storeId);
        upsert.run(storeId, a.id, item.pack ?? '', this.priceOf(a, item.pack ?? '', rules), now);
      }
    })();
  }
}

const plural = (w: string) => (/[sxz]$/.test(w) ? w : `${w}s`);
