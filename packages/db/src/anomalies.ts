import type { Milli } from '@superette/core';
import type { Db } from './database';
import type { MonitoringService } from './monitoring';
import { stockGaps } from './repair';
import type { StockService } from './stock';
import { AppError, Base, type Clock, type Context, newId } from './util';

export type StockAnomalyKind = 'duplicate_reception' | 'lasting_negative' | 'sold_never_received' | 'drift';

export const STOCK_ANOMALY_KINDS: Record<StockAnomalyKind, string> = {
  duplicate_reception: 'Réception saisie deux fois',
  lasting_negative: 'Stock négatif qui dure',
  sold_never_received: 'Vendu sans jamais être réceptionné',
  drift: 'Stock différent de ses mouvements',
};

/** Correction proposée : le stock d'un article dans un dépôt passe de `before` à `after`. */
export interface AnomalyFix {
  article_id: string;
  article_name: string;
  warehouse_id: string;
  warehouse_name: string;
  before: Milli;
  after: Milli;
}

/** Un cas douteux, ses faits et la correction proposée (null : à vérifier, rien à corriger d'office). */
export interface StockAnomaly {
  key: string;
  kind: StockAnomalyKind;
  title: string;
  facts: string;
  /** Quand le cas a commencé (réception, passage sous zéro, première vente). */
  since: string | null;
  fix: { label: string; lines: AnomalyFix[] } | null;
  /** Autre geste conseillé, sans correction automatique. */
  advice: string;
}

export interface AnomalyDecision {
  id: string;
  case_key: string;
  kind: StockAnomalyKind;
  decision: 'fixed' | 'ignored';
  article_name: string | null;
  warehouse_name: string | null;
  before_qty: Milli | null;
  after_qty: Milli | null;
  note: string | null;
  user_name: string | null;
  created_at: string;
}

const NEGATIVE_DAYS = 3;
const qtyText = (q: Milli) => String(q / 1000).replace('.', ',');
const day = (iso: string) => iso.slice(0, 10).split('-').reverse().join('/');

/**
 * Centre des anomalies de stock : ONIX cherche les cas douteux et les présente
 * au gérant. Une correction passe par une correction de stock signée (jamais
 * en effaçant l'historique) ; chaque décision est gardée et le cas n'est plus proposé.
 */
export class StockAnomalyService extends Base {
  constructor(
    db: Db,
    clock: Clock,
    private readonly stock: StockService,
    private readonly monitoring: MonitoringService,
  ) {
    super(db, clock);
  }

  private warehouses(storeId: string): Map<string, string> {
    return new Map((this.db.prepare('SELECT id, name FROM warehouses WHERE store_id = ?').all(storeId) as { id: string; name: string }[]).map((w) => [w.id, w.name]));
  }

  private decided(storeId: string): Set<string> {
    return new Set(this.db.prepare('SELECT case_key FROM stock_anomaly_decisions WHERE store_id = ?').pluck().all(storeId) as string[]);
  }

  /** Cas à vérifier, sans ceux déjà décidés. */
  list(storeId: string): StockAnomaly[] {
    const cases = this.search(storeId);
    this.cache.set(storeId, { at: this.clock().getTime(), cases });
    return cases;
  }

  private search(storeId: string): StockAnomaly[] {
    const wh = this.warehouses(storeId);
    if (!wh.size) return [];
    const done = this.decided(storeId);
    const name = this.db.prepare('SELECT name FROM articles WHERE id = ?').pluck();
    const qtyOf = this.db.prepare('SELECT COALESCE((SELECT qty FROM stock WHERE article_id = ? AND warehouse_id = ?), 0)').pluck();
    const art = (id: string) => (name.get(id) as string | undefined) ?? 'Article supprimé';
    const out: StockAnomaly[] = [];

    // 1. Même fournisseur, même jour, mêmes lignes : la facture a sans doute été saisie deux fois.
    const receptions = this.db
      .prepare(
        `SELECT r.id, r.number, r.warehouse_id, r.supplier_id, r.received_at, COALESCE(sp.name, 'sans fournisseur') AS supplier,
           (SELECT group_concat(article_id || ':' || qty || ':' || unit_cost, ',') FROM (SELECT article_id, qty, unit_cost FROM reception_lines WHERE reception_id = r.id ORDER BY article_id, qty, unit_cost)) AS sig
         FROM receptions r LEFT JOIN suppliers sp ON sp.id = r.supplier_id
         WHERE r.store_id = ? AND r.received_at >= ? AND COALESCE(r.opening, 0) = 0 ORDER BY r.received_at`,
      )
      .all(storeId, new Date(this.clock().getTime() - 90 * 86_400_000).toISOString()) as {
      id: string;
      number: string;
      warehouse_id: string;
      supplier_id: string | null;
      received_at: string;
      supplier: string;
      sig: string | null;
    }[];
    const firstOf = new Map<string, (typeof receptions)[number]>();
    for (const r of receptions) {
      if (!r.sig) continue;
      const sig = `${r.supplier_id ?? ''}|${r.warehouse_id}|${r.received_at.slice(0, 10)}|${r.sig}`;
      const first = firstOf.get(sig);
      if (!first) {
        firstOf.set(sig, r);
        continue;
      }
      const key = `duplicate_reception:${r.id}`;
      if (done.has(key)) continue;
      const lines = (this.db.prepare('SELECT article_id, SUM(qty) AS qty FROM reception_lines WHERE reception_id = ? GROUP BY article_id').all(r.id) as { article_id: string; qty: Milli }[]).map((l) => {
        const before = qtyOf.get(l.article_id, r.warehouse_id) as Milli;
        return { article_id: l.article_id, article_name: art(l.article_id), warehouse_id: r.warehouse_id, warehouse_name: wh.get(r.warehouse_id) ?? '', before, after: Math.max(0, before - l.qty) };
      });
      out.push({
        key,
        kind: 'duplicate_reception',
        title: `Réceptions n° ${first.number} et n° ${r.number} identiques`,
        facts: `${r.supplier}, le ${day(r.received_at)} : mêmes articles, mêmes quantités, mêmes prix (${lines.length} article${lines.length > 1 ? 's' : ''}).`,
        since: r.received_at,
        fix: lines.some((l) => l.after !== l.before) ? { label: `Retirer du stock les quantités de la réception n° ${r.number}`, lines: lines.filter((l) => l.after !== l.before) } : null,
        advice: "Si le fournisseur a vraiment livré deux fois, laissez tel quel. Sinon, retirez le double du stock et prévenez le comptable pour la facture.",
      });
    }

    // 2. Stock négatif depuis plusieurs jours : une réception ou un transfert manque.
    const negatives = this.db
      .prepare(`SELECT article_id, warehouse_id, qty FROM stock s JOIN articles a ON a.id = s.article_id WHERE s.qty < 0 AND a.is_service = 0 AND s.warehouse_id IN (${[...wh.keys()].map(() => '?').join(',')})`)
      .all(...wh.keys()) as { article_id: string; warehouse_id: string; qty: Milli }[];
    const moves = this.db.prepare('SELECT qty, at FROM stock_movements WHERE article_id = ? AND warehouse_id = ? ORDER BY at, id');
    const limit = new Date(this.clock().getTime() - NEGATIVE_DAYS * 86_400_000).toISOString();
    for (const n of negatives) {
      let level = 0;
      let since: string | null = null;
      for (const m of moves.all(n.article_id, n.warehouse_id) as { qty: Milli; at: string }[]) {
        const was = level;
        level += m.qty;
        if (was >= 0 && level < 0) since = m.at;
        if (level >= 0) since = null;
      }
      if (!since || since > limit) continue;
      const key = `lasting_negative:${n.article_id}|${n.warehouse_id}|${since}`;
      if (done.has(key)) continue;
      out.push({
        key,
        kind: 'lasting_negative',
        title: `${art(n.article_id)} : stock à ${qtyText(n.qty)}`,
        facts: `Sous zéro depuis le ${day(since)} dans « ${wh.get(n.warehouse_id)} ». On a vendu plus que ce qui est entré.`,
        since,
        fix: { label: 'Remettre le stock à 0', lines: [{ article_id: n.article_id, article_name: art(n.article_id), warehouse_id: n.warehouse_id, warehouse_name: wh.get(n.warehouse_id) ?? '', before: n.qty, after: 0 }] },
        advice: "Le mieux est de saisir la réception oubliée (ou le transfert), puis de compter l'article. Remettre à 0 ne corrige que l'affichage.",
      });
    }

    // 3. Vendu dans un dépôt où rien n'est jamais entré (ni réception, ni transfert, ni inventaire).
    const never = this.db
      .prepare(
        `SELECT m.article_id, m.warehouse_id, MIN(m.at) AS first_sale, -SUM(m.qty) AS sold
         FROM stock_movements m JOIN articles a ON a.id = m.article_id
         WHERE m.type = 'SALE' AND a.is_service = 0 AND m.warehouse_id IN (${[...wh.keys()].map(() => '?').join(',')})
           AND NOT EXISTS (SELECT 1 FROM stock_movements e WHERE e.article_id = m.article_id AND e.warehouse_id = m.warehouse_id AND e.qty > 0 AND e.type <> 'RETURN')
         GROUP BY m.article_id, m.warehouse_id`,
      )
      .all(...wh.keys()) as { article_id: string; warehouse_id: string; first_sale: string; sold: Milli }[];
    for (const n of never) {
      const key = `sold_never_received:${n.article_id}|${n.warehouse_id}`;
      if (done.has(key) || n.sold <= 0) continue;
      out.push({
        key,
        kind: 'sold_never_received',
        title: `${art(n.article_id)} : vendu sans réception`,
        facts: `${qtyText(n.sold)} vendu(s) depuis le ${day(n.first_sale)} dans « ${wh.get(n.warehouse_id)} », sans aucune entrée en stock.`,
        since: n.first_sale,
        fix: null,
        advice: "Saisissez la réception de cet article (le coût d'achat et la marge seront justes), ou son stock d'ouverture s'il était déjà en rayon.",
      });
    }

    // 4. Stock enregistré différent de la somme de ses mouvements (coupure pendant une écriture, ancienne version).
    for (const g of stockGaps(this.db)) {
      if (!wh.has(g.warehouse_id)) continue;
      const before = qtyOf.get(g.article_id, g.warehouse_id) as Milli;
      const key = `drift:${g.article_id}|${g.warehouse_id}|${before}|${g.qty}`;
      if (done.has(key)) continue;
      out.push({
        key,
        kind: 'drift',
        title: `${art(g.article_id)} : stock à ${qtyText(before)}, mouvements à ${qtyText(g.qty)}`,
        facts: `Dans « ${wh.get(g.warehouse_id)} », le stock affiché ne correspond pas à la somme des entrées et sorties.`,
        since: null,
        fix: { label: `Recalculer le stock à partir des mouvements (${qtyText(g.qty)})`, lines: [{ article_id: g.article_id, article_name: art(g.article_id), warehouse_id: g.warehouse_id, warehouse_name: wh.get(g.warehouse_id) ?? '', before, after: g.qty }] },
        advice: 'Le recalcul ne crée aucun mouvement : il remet le stock en accord avec son historique.',
      });
    }
    return out.sort((a, b) => (b.since ?? '').localeCompare(a.since ?? ''));
  }

  private cache = new Map<string, { at: number; cases: StockAnomaly[] }>();

  /**
   * Cas à vérifier pour la tuile de l'accueil : la recherche relit tous les
   * mouvements, elle est refaite au plus toutes les 10 minutes.
   */
  cached(storeId: string): StockAnomaly[] {
    const hit = this.cache.get(storeId);
    const now = this.clock().getTime();
    if (hit && now - hit.at < 10 * 60_000) return hit.cases;
    const cases = this.list(storeId);
    this.cache.set(storeId, { at: now, cases });
    return cases;
  }

  /**
   * Applique la correction proposée (corrections de stock signées par le
   * gérant, ou recalcul) ou laisse le cas tel quel ; la décision est gardée.
   */
  decide(ctx: Context, key: string, decision: 'fixed' | 'ignored', note?: string | null): AnomalyDecision[] {
    const c = this.list(ctx.storeId).find((a) => a.key === key);
    if (!c) throw new AppError('Ce cas est déjà traité ou a disparu', 'NOT_FOUND');
    const text = note?.trim().slice(0, 200) || null;
    if (decision === 'ignored' && !text) throw new AppError('Indiquez pourquoi vous laissez ce cas tel quel', 'INVALID');
    if (decision === 'fixed' && !c.fix) throw new AppError("Ce cas n'a pas de correction automatique : suivez le conseil, puis marquez-le comme vu", 'INVALID');
    const lines = decision === 'fixed' ? c.fix!.lines : [];
    const done = this.tx(() => {
      const at = this.now();
      const insert = this.db.prepare(
        `INSERT INTO stock_anomaly_decisions (id, store_id, case_key, kind, decision, article_id, warehouse_id, before_qty, after_qty, note, user_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const ids: string[] = [];
      for (const l of lines) {
        if (c.kind === 'drift') {
          this.stock.recompute(l.article_id, l.warehouse_id);
        } else {
          const now = (this.db.prepare('SELECT COALESCE((SELECT qty FROM stock WHERE article_id = ? AND warehouse_id = ?), 0)').pluck().get(l.article_id, l.warehouse_id) as Milli) ?? 0;
          if (now !== l.after) this.monitoring.request(ctx, { articleId: l.article_id, warehouseId: l.warehouse_id, newQty: l.after, reason: `Anomalie : ${STOCK_ANOMALY_KINDS[c.kind]}${text ? ` (${text})` : ''}` }, true);
        }
        const id = newId();
        insert.run(id, ctx.storeId, key, c.kind, decision, l.article_id, l.warehouse_id, l.before, l.after, text, ctx.userId, at, at);
        ids.push(id);
      }
      if (!lines.length) {
        const id = newId();
        insert.run(id, ctx.storeId, key, c.kind, decision, null, null, null, null, text, ctx.userId, at, at);
        ids.push(id);
      }
      for (const id of ids) this.enqueue(ctx, 'stock_anomaly_decision', id, 'upsert', {});
      this.audit(ctx.userId, `stock.anomaly.${decision}`, 'stock_anomaly', key, { kind: c.kind, title: c.title, lines: lines.length, note: text });
      return this.decisions(ctx.storeId).filter((d) => ids.includes(d.id));
    });
    this.cache.delete(ctx.storeId);
    return done;
  }

  /** Journal des décisions, les plus récentes d'abord. */
  decisions(storeId: string, limit = 200): AnomalyDecision[] {
    return this.db
      .prepare(
        `SELECT d.id, d.case_key, d.kind, d.decision, a.name AS article_name, w.name AS warehouse_name, d.before_qty, d.after_qty, d.note, u.name AS user_name, d.created_at
         FROM stock_anomaly_decisions d LEFT JOIN articles a ON a.id = d.article_id LEFT JOIN warehouses w ON w.id = d.warehouse_id LEFT JOIN users u ON u.id = d.user_id
         WHERE d.store_id = ? ORDER BY d.created_at DESC LIMIT ?`,
      )
      .all(storeId, limit) as AnomalyDecision[];
  }
}
