import { AppError, Base, newId } from './util';

/** Commercial de terrain (prévendeur, représentant) : pas forcément un utilisateur du logiciel. */
export interface FieldRep {
  id: string;
  name: string;
  phone: string | null;
  zone: string;
  city: string;
  active: number;
  /** Clients qui lui sont rattachés. */
  customers: number;
}

export interface FieldRepInput {
  name: string;
  phone?: string | null;
  zone: string;
  city: string;
  active?: boolean;
}

/** « bonamoussadi » → « BONAMOUSSADI », espaces simplifiés : la même zone s'écrit toujours pareil. */
const place = (v: string) => v.trim().replace(/\s+/g, ' ').toUpperCase();

/**
 * Commerciaux de terrain, chacun rattaché à une zone et une ville. Une vente
 * qui lui est attribuée garde la zone et la ville du jour de la vente : un
 * commercial qui change de secteur ne réécrit pas l'historique des secteurs.
 */
export class FieldRepService extends Base {
  list(includeInactive = false): FieldRep[] {
    return this.db
      .prepare(
        `SELECT r.id, r.name, r.phone, r.zone, r.city, r.active, (SELECT COUNT(*) FROM customers c WHERE c.field_rep_id = r.id AND c.active = 1) AS customers
         FROM field_reps r WHERE (? = 1 OR r.active = 1) ORDER BY r.city, r.zone, r.name`,
      )
      .all(includeInactive ? 1 : 0) as FieldRep[];
  }

  get(id: string): FieldRep {
    const rep = this.list(true).find((r) => r.id === id);
    if (!rep) throw new AppError('Commercial introuvable', 'NOT_FOUND');
    return rep;
  }

  save(userId: string, input: FieldRepInput, id?: string | null): FieldRep {
    const name = input.name?.trim().replace(/\s+/g, ' ');
    if (!name) throw new AppError('Le nom du commercial est obligatoire', 'INVALID');
    const zone = place(input.zone ?? '');
    const city = place(input.city ?? '');
    if (!zone) throw new AppError('Indiquez la zone du commercial', 'INVALID');
    if (!city) throw new AppError('Indiquez la ville du commercial', 'INVALID');
    if (name.length > 80 || zone.length > 40 || city.length > 40) throw new AppError('Nom, zone ou ville trop long', 'INVALID');
    const repId = id ?? newId();
    const before = id ? this.get(id) : null;
    this.tx(() => {
      const now = this.now();
      this.db
        .prepare(
          `INSERT INTO field_reps (id, name, phone, zone, city, active, created_at, updated_at) VALUES (@id, @name, @phone, @zone, @city, @active, @now, @now)
           ON CONFLICT(id) DO UPDATE SET name = @name, phone = @phone, zone = @zone, city = @city, active = @active, updated_at = @now`,
        )
        .run({ id: repId, name, phone: input.phone?.trim() || null, zone, city, active: input.active === false ? 0 : 1, now });
      this.enqueue(null, 'field_rep', repId, 'upsert', {});
      this.audit(userId, before ? 'field_rep.update' : 'field_rep.create', 'field_rep', repId, {
        name,
        zone,
        city,
        ...(before && (before.zone !== zone || before.city !== city) ? { from: { zone: before.zone, city: before.city } } : {}),
      });
    });
    return this.get(repId);
  }

  /** Zones et villes déjà utilisées, pour les proposer à la saisie. */
  places(): { zones: string[]; cities: string[] } {
    return {
      zones: this.db.prepare('SELECT DISTINCT zone FROM field_reps ORDER BY zone').pluck().all() as string[],
      cities: this.db.prepare('SELECT DISTINCT city FROM field_reps ORDER BY city').pluck().all() as string[],
    };
  }

  /**
   * Commercial d'une vente : celui choisi à la caisse, sinon celui qui suit le
   * client. Sa zone et sa ville sont figées sur la vente.
   */
  forSale(fieldRepId: string | null | undefined, customerId: string | null | undefined): { id: string; zone: string; city: string } | null {
    const id =
      fieldRepId ||
      (customerId ? ((this.db.prepare('SELECT field_rep_id FROM customers WHERE id = ?').pluck().get(customerId) as string | null | undefined) ?? null) : null);
    if (!id) return null;
    const rep = this.db.prepare('SELECT id, zone, city, active FROM field_reps WHERE id = ?').get(id) as { id: string; zone: string; city: string; active: number } | undefined;
    if (!rep) throw new AppError('Commercial introuvable', 'NOT_FOUND');
    if (!rep.active && fieldRepId) throw new AppError('Ce commercial est désactivé', 'INVALID');
    return rep.active ? rep : null;
  }
}
