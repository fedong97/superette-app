import type { Fcfa, Milli } from '@superette/core';
import { AppError, Base, newId } from './util';

/**
 * Code court d'un article ou d'un de ses conditionnements, écrit dans le
 * carnet de coupure à la place du nom (« 0042 » pour Coca-Cola 50 cl).
 */
export interface BookCode {
  code: number;
  article_id: string;
  /** Unités de détail contenues (millièmes) : 1000 = l'unité, 24 000 = un carton de 24. */
  units: Milli;
  article_name: string;
  /** Nom du conditionnement, ou de l'unité de détail. */
  pack_name: string;
  pack_id: string | null;
  unit: 'piece' | 'kg' | 'litre';
  /** Prix de vente au détail dans ce magasin, pour l'unité ou le conditionnement. */
  price: Fcfa;
  department: string | null;
  family: string | null;
}

/**
 * Codes du carnet de coupure. Chaque article actif reçoit un numéro pour
 * l'unité et un pour chaque conditionnement ; un numéro donné ne change plus,
 * pour que les listes déjà imprimées restent justes. Deux PC hors ligne
 * peuvent donner le même numéro : le plus récent est alors renuméroté.
 */
export class BookCodeService extends Base {
  /** Liste pour l'impression et la lecture, triée par rayon, famille et nom. */
  list(storeId: string | null): BookCode[] {
    const rows = this.db
      .prepare(
        `SELECT b.code, b.article_id, b.units, a.name AS article_name, a.unit, a.unit_name, d.name AS department, f.name AS family,
           COALESCE(sp.sale_price, a.sale_price) AS unit_price, p.id AS pack_id, p.name AS pack_name, p.sale_price AS pack_price
         FROM book_codes b
         JOIN articles a ON a.id = b.article_id AND a.active = 1
         LEFT JOIN families f ON f.id = a.family_id
         LEFT JOIN departments d ON d.id = f.department_id
         LEFT JOIN store_prices sp ON sp.article_id = a.id AND sp.store_id = ?
         LEFT JOIN article_packs p ON p.article_id = a.id AND p.units = b.units AND b.units <> 1000
         ORDER BY d.name, f.name, a.name, b.units`,
      )
      .all(storeId) as {
      code: number;
      article_id: string;
      units: Milli;
      article_name: string;
      unit: BookCode['unit'];
      unit_name: string | null;
      department: string | null;
      family: string | null;
      unit_price: Fcfa;
      pack_id: string | null;
      pack_name: string | null;
      pack_price: Fcfa | null;
    }[];
    const unitLabel = { piece: 'Unité', kg: 'Kg', litre: 'Litre' } as const;
    return rows
      .filter((r) => r.units === 1000 || r.pack_id)
      .map((r) => ({
        code: r.code,
        article_id: r.article_id,
        units: r.units,
        article_name: r.article_name,
        pack_name: r.pack_id ? r.pack_name! : r.unit_name || unitLabel[r.unit],
        pack_id: r.pack_id,
        unit: r.unit,
        price: r.pack_id ? r.pack_price! : r.unit_price,
        department: r.department,
        family: r.family,
      }));
  }

  /**
   * Donne un numéro aux articles actifs qui n'en ont pas encore (unité et
   * conditionnements), et renumérote les doublons venus d'un autre PC.
   * Renvoie le nombre de codes créés et renumérotés.
   */
  assign(userId: string): { created: number; renumbered: number } {
    let created = 0;
    let renumbered = 0;
    this.tx(() => {
      const now = this.now();
      let next = ((this.db.prepare('SELECT MAX(code) FROM book_codes').pluck().get() as number | null) ?? 0) + 1;
      const take = () => {
        if (next > 9999) throw new AppError('Plus de 9 999 codes de carnet : désactivez les articles qui ne se vendent plus', 'INVALID');
        return next++;
      };
      // Doublons : le premier donné garde son numéro.
      const dups = this.db
        .prepare(
          `SELECT b.id FROM book_codes b WHERE EXISTS (
             SELECT 1 FROM book_codes o WHERE o.code = b.code AND o.id <> b.id AND (o.created_at < b.created_at OR (o.created_at = b.created_at AND o.id < b.id)))`,
        )
        .pluck()
        .all() as string[];
      for (const id of dups) {
        this.db.prepare('UPDATE book_codes SET code = ?, updated_at = ? WHERE id = ?').run(take(), now, id);
        this.enqueue(null, 'book_code', id, 'upsert', {});
        renumbered++;
      }
      const missing = this.db
        .prepare(
          `SELECT a.id AS article_id, x.units FROM articles a
           JOIN (SELECT id AS article_id, 1000 AS units FROM articles UNION SELECT article_id, units FROM article_packs WHERE units <> 1000) x ON x.article_id = a.id
           LEFT JOIN families f ON f.id = a.family_id
           LEFT JOIN departments d ON d.id = f.department_id
           WHERE a.active = 1 AND a.is_service = 0
             AND NOT EXISTS (SELECT 1 FROM book_codes b WHERE b.article_id = a.id AND b.units = x.units)
           ORDER BY d.name, f.name, a.name, x.units`,
        )
        .all() as { article_id: string; units: Milli }[];
      const insert = this.db.prepare('INSERT INTO book_codes (id, code, article_id, units, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)');
      for (const m of missing) {
        const id = newId();
        insert.run(id, take(), m.article_id, m.units, now, now);
        this.enqueue(null, 'book_code', id, 'upsert', {});
        created++;
      }
      if (created || renumbered) this.audit(userId, 'book_codes.assign', 'book_code', undefined, { created, renumbered });
    });
    return { created, renumbered };
  }
}
