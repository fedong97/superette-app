import { type ReadInvoice, type ReadInvoiceLine, labelSimilarity } from '@superette/core';
import { Base } from './util';

/** Comment l'article d'une ligne lue a été trouvé. */
export type InvoiceMatchKind = 'barcode' | 'reference' | 'name' | null;

export interface MatchedInvoiceLine extends ReadInvoiceLine {
  articleId: string | null;
  articleName: string | null;
  match: InvoiceMatchKind;
  /** Conditionnement de la ligne (millièmes de l'unité de base : 12 000 pour un casier de 12). */
  packUnits: number;
  /** Autres articles proches, pour corriger d'un clic. */
  others: { id: string; name: string }[];
}

export interface MatchedInvoice extends Omit<ReadInvoice, 'lines'> {
  supplierId: string | null;
  supplierName: string | null;
  lines: MatchedInvoiceLine[];
}

/** Ressemblance minimale d'une désignation pour proposer un article. */
const MIN_SIMILARITY = 0.5;

/**
 * Rapproche une facture lue (0.116.0) des fiches d'ONIX : le fournisseur par son
 * NIU (ou celui déjà choisi), puis chaque ligne par code-barres, par référence
 * chez ce fournisseur, ou par désignation. Rien n'est enregistré.
 */
export class InvoiceMatchService extends Base {
  match(read: ReadInvoice, supplierId: string | null, docLines: string[] = []): MatchedInvoice {
    let supplier = supplierId ? (this.db.prepare('SELECT id, name FROM suppliers WHERE id = ?').get(supplierId) as { id: string; name: string } | undefined) : undefined;
    if (!supplier && read.taxpayerNumber) {
      supplier = this.db.prepare('SELECT id, name FROM suppliers WHERE upper(taxpayer_number) = ? AND active = 1').get(read.taxpayerNumber.toUpperCase()) as
        | { id: string; name: string }
        | undefined;
    }
    if (!supplier && docLines.length) {
      // Le nom du fournisseur est souvent en tête de facture.
      const head = docLines.slice(0, 8).join(' ');
      const all = this.db.prepare('SELECT id, name FROM suppliers WHERE active = 1').all() as { id: string; name: string }[];
      let best = 0;
      for (const s of all) {
        const score = labelSimilarity(s.name, head) * (head.toLowerCase().includes(s.name.toLowerCase()) ? 2 : 1);
        if (score > best && (score >= 0.3 || head.toLowerCase().includes(s.name.toLowerCase()))) {
          best = score;
          supplier = s;
        }
      }
    }
    const articles = this.db.prepare('SELECT id, name, purchase_price FROM articles WHERE active = 1').all() as { id: string; name: string; purchase_price: number }[];
    const byId = new Map(articles.map((a) => [a.id, a]));
    const byBarcode = this.db.prepare('SELECT article_id, pack_qty FROM barcodes WHERE code = ?');
    const byPackBarcode = this.db.prepare('SELECT article_id, units FROM article_packs WHERE barcode = ?');
    const byRef = this.db.prepare('SELECT article_id, pack_qty FROM supplier_articles WHERE supplier_id = ? AND upper(supplier_ref) = ?');
    const packs = this.db.prepare('SELECT units FROM article_packs WHERE article_id = ? ORDER BY position');
    /** Conditionnement dont le dernier prix d'achat est le plus proche du prix lu (l'unité à défaut). */
    const guessPack = (articleId: string, price: number): number => {
      const cost = byId.get(articleId)?.purchase_price ?? 0;
      if (!cost || !price) return 1000;
      const choices = [1000, ...(packs.pluck().all(articleId) as number[])];
      let best = 1000;
      let gap = Infinity;
      for (const u of choices) {
        const ratio = price / ((cost * u) / 1000);
        const g = Math.abs(Math.log(ratio));
        if (g < gap) {
          gap = g;
          best = u;
        }
      }
      return gap < Math.log(2) ? best : 1000;
    };
    const lines = read.lines.map((l): MatchedInvoiceLine => {
      const out = (articleId: string | null, match: InvoiceMatchKind, packUnits: number, others: { id: string; name: string }[] = []): MatchedInvoiceLine => ({
        ...l,
        articleId,
        articleName: articleId ? (byId.get(articleId)?.name ?? null) : null,
        match: articleId ? match : null,
        packUnits,
        others,
      });
      if (l.barcode) {
        const b = byBarcode.get(l.barcode) as { article_id: string; pack_qty: number } | undefined;
        if (b && byId.has(b.article_id)) return out(b.article_id, 'barcode', b.pack_qty || 1000);
        const p = byPackBarcode.get(l.barcode) as { article_id: string; units: number } | undefined;
        if (p && byId.has(p.article_id)) return out(p.article_id, 'barcode', p.units);
      }
      if (l.reference && supplier) {
        const r = byRef.get(supplier.id, l.reference.toUpperCase()) as { article_id: string; pack_qty: number } | undefined;
        if (r && byId.has(r.article_id)) return out(r.article_id, 'reference', r.pack_qty || guessPack(r.article_id, l.unitPrice));
      }
      const scored = articles
        .map((a) => ({ id: a.id, name: a.name, score: labelSimilarity(l.label, a.name) }))
        .filter((a) => a.score >= MIN_SIMILARITY * 0.6)
        .sort((a, b) => b.score - a.score)
        .slice(0, 5);
      const top = scored[0];
      if (top && top.score >= MIN_SIMILARITY) return out(top.id, 'name', guessPack(top.id, l.unitPrice), scored.slice(1).map(({ id, name }) => ({ id, name })));
      return out(null, null, 1000, scored.map(({ id, name }) => ({ id, name })));
    });
    return { ...read, supplierId: supplier?.id ?? null, supplierName: supplier?.name ?? null, lines };
  }
}
