import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { type Db, PG } from './database';
import { DAY_NUMBER } from './mobile.service';

type Device = { id: string; store_id: string };

/**
 * Où en est une facture envoyée à la caisse :
 * - waiting : elle attend une caisse du magasin ;
 * - editing : le vendeur l'a rouverte pour la modifier (la caisse ne peut pas l'encaisser) ;
 * - returned : le caissier l'a rendue au vendeur, avec le motif ;
 * - paying : un caissier l'a ouverte pour l'encaisser ;
 * - paid, cancelled : terminée.
 */
export type CounterStatus = 'waiting' | 'editing' | 'returned' | 'paying' | 'paid' | 'cancelled';

export interface CounterInvoice {
  id: string;
  number: number;
  sellerId: string;
  sellerName: string;
  status: CounterStatus;
  version: number;
  total: number;
  lines: number;
  customerName: string | null;
  note: string | null;
  /** Qui la tient (vendeur qui la modifie, caissier qui l'encaisse) et depuis quel PC. */
  lockName: string | null;
  lockedHere: boolean;
  saleNumber: string | null;
  doneBy: string | null;
  /** Caisse qui doit l'encaisser (null : toutes). */
  registerId: string | null;
  at: string;
  updatedAt: string;
  /** Contenu de la facture (lignes, client, tarif, accords), lu tel quel par le PC. */
  payload?: unknown;
}

interface Row {
  id: string;
  number: number;
  seller_id: string;
  seller_name: string;
  status: CounterStatus;
  version: number;
  total: string | number;
  line_count: number;
  customer_name: string | null;
  note: string | null;
  lock_device: string | null;
  lock_name: string | null;
  sale_number: string | null;
  done_by: string | null;
  payload: unknown;
  created_at: Date;
  updated_at: Date;
}

const str = (v: unknown) => (v === null || v === undefined ? '' : String(v));
const name = (v: unknown) => str(v).trim().slice(0, 80);
/** Une facture qui n'est plus touchée depuis 24 heures sort des listes. */
const OPEN_SINCE = "now() - interval '24 hours'";

/**
 * Factures envoyées à la caisse (vendeur et caissier séparés). Le serveur
 * garde la facture et qui la tient ; chaque passage d'un état à l'autre est
 * une seule requête conditionnelle, deux PC ne prennent jamais la même.
 */
@Injectable()
export class CounterService {
  constructor(@Inject(PG) private readonly pg: Db) {}

  private view(r: Row, device: Device, withPayload = false): CounterInvoice {
    return {
      id: r.id,
      number: r.number,
      sellerId: r.seller_id,
      sellerName: r.seller_name,
      status: r.status,
      version: r.version,
      total: Number(r.total),
      lines: r.line_count,
      customerName: r.customer_name,
      note: r.note,
      lockName: r.lock_name,
      lockedHere: r.lock_device === device.id,
      saleNumber: r.sale_number,
      doneBy: r.done_by,
      // Caisse de destination choisie pour le vendeur (dans la facture elle-même).
      registerId: typeof r.payload === 'object' && r.payload ? ((r.payload as { registerId?: string | null }).registerId ?? null) : null,
      at: new Date(r.created_at).toISOString(),
      updatedAt: new Date(r.updated_at).toISOString(),
      ...(withPayload ? { payload: r.payload } : {}),
    };
  }

  private async row(device: Device, id: string): Promise<Row> {
    const { rows } = await this.pg.query<Row>('SELECT * FROM counter_invoices WHERE id = $1 AND store_id = $2', [str(id), device.store_id]);
    if (!rows[0]) throw new NotFoundException('Facture introuvable');
    return rows[0];
  }

  /** Changement d'état conditionnel : refusé avec un message clair si la facture a bougé entre-temps. */
  private async move(device: Device, id: string, set: string, where: string, params: unknown[]): Promise<CounterInvoice> {
    const { rows } = await this.pg.query<Row>(
      `UPDATE counter_invoices SET ${set}, updated_at = now() WHERE id = $1 AND store_id = $2 AND (${where}) RETURNING *`,
      [str(id), device.store_id, ...params],
    );
    if (rows[0]) return this.view(rows[0], device, true);
    const r = await this.row(device, id);
    throw new ConflictException(busy(r, device));
  }

  /**
   * Envoi à la caisse. Une nouvelle facture reçoit le numéro du jour ; une
   * facture rouverte par le vendeur (ou rendue par la caisse) repart avec le
   * même numéro et une version de plus. Le même envoi répété (réseau coupé)
   * n'est enregistré qu'une fois.
   */
  async send(
    device: Device,
    input: { id: string; baseVersion?: number | null; sellerId: string; sellerName: string; payload: unknown; total: number; lines: number; customerName?: string | null; forMe?: string | null },
  ): Promise<CounterInvoice> {
    const id = str(input?.id).trim();
    if (!/^[\w-]{8,64}$/.test(id)) throw new BadRequestException('Facture invalide');
    const total = Math.round(Number(input?.total));
    const lines = Math.round(Number(input?.lines));
    if (!Number.isSafeInteger(total) || total < 0 || !Number.isSafeInteger(lines) || lines < 1 || lines > 300) throw new BadRequestException('La facture est vide (300 lignes au plus)');
    const payload = JSON.stringify(input?.payload ?? null);
    if (!input?.payload || payload.length > 200_000) throw new BadRequestException('Facture invalide');
    const sellerId = str(input.sellerId);
    const sellerName = name(input.sellerName);
    if (!sellerId || !sellerName) throw new BadRequestException('Vendeur manquant');
    const customer = name(input.customerName) || null;
    // Panier du téléphone pris par une caisse : il naît « à encaisser » sur ce PC.
    const forMe = name(input.forMe) || null;
    if (input.baseVersion === undefined || input.baseVersion === null) {
      const { rows } = await this.pg.query<Row>(
        `INSERT INTO counter_invoices (id, store_id, number, device_id, seller_id, seller_name, status, payload, total, line_count, customer_name, lock_device, lock_name, locked_at)
         VALUES ($1, $2, ${DAY_NUMBER('$2')}, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         ON CONFLICT (id) DO NOTHING RETURNING *`,
        [id, device.store_id, device.id, sellerId, sellerName, forMe ? 'paying' : 'waiting', payload, total, lines, customer, forMe ? device.id : null, forMe, forMe ? new Date().toISOString() : null],
      );
      return this.view(rows[0] ?? (await this.row(device, id)), device, true);
    }
    // Nouvelle version : seulement depuis le PC qui l'a rouverte, ou après un retour de la caisse.
    return this.move(
      device,
      id,
      `status = 'waiting', version = version + 1, payload = $5, total = $6, line_count = $7, customer_name = $8, note = NULL, lock_device = NULL, lock_name = NULL, locked_at = NULL`,
      `version = $3 AND ((status = 'editing' AND lock_device = $4) OR status = 'returned')`,
      [Math.round(Number(input.baseVersion)), device.id, payload, total, lines, customer],
    );
  }

  /** Factures du magasin encore ouvertes : la liste de la caisse. */
  async open(device: Device): Promise<CounterInvoice[]> {
    const { rows } = await this.pg.query<Row>(
      `SELECT * FROM counter_invoices WHERE store_id = $1 AND status IN ('waiting', 'editing', 'returned', 'paying') AND updated_at >= ${OPEN_SINCE} ORDER BY number`,
      [device.store_id],
    );
    return rows.map((r) => this.view(r, device));
  }

  /** Factures d'un vendeur depuis hier (ou de tous les vendeurs pour le gérant) : « Mes factures envoyées ». */
  async bySeller(device: Device, sellerId: string | null): Promise<CounterInvoice[]> {
    const { rows } = await this.pg.query<Row>(
      `SELECT * FROM counter_invoices WHERE store_id = $1 AND ($2::text IS NULL OR seller_id = $2) AND updated_at >= ${OPEN_SINCE} ORDER BY created_at DESC LIMIT 200`,
      [device.store_id, sellerId || null],
    );
    return rows.map((r) => this.view(r, device));
  }

  async get(device: Device, id: string): Promise<CounterInvoice> {
    return this.view(await this.row(device, id), device, true);
  }

  /** Le vendeur la rouvre pour la modifier : elle est bloquée à la caisse le temps de la modification. */
  edit(device: Device, id: string, by: string) {
    return this.move(
      device,
      id,
      `status = 'editing', lock_device = $3, lock_name = $4, locked_at = now()`,
      `status IN ('waiting', 'returned') OR (status = 'editing' AND lock_device = $3)`,
      [device.id, name(by)],
    );
  }

  /** Le vendeur abandonne sa modification : la facture repart telle qu'elle était. */
  unedit(device: Device, id: string) {
    return this.move(device, id, `status = 'waiting', lock_device = NULL, lock_name = NULL, locked_at = NULL`, `status = 'editing' AND lock_device = $3`, [device.id]);
  }

  /** Le caissier l'ouvre pour l'encaisser : aucune autre caisse ne peut la prendre. */
  take(device: Device, id: string, by: string) {
    return this.move(
      device,
      id,
      `status = 'paying', lock_device = $3, lock_name = $4, locked_at = now()`,
      `status = 'waiting' OR (status = 'paying' AND lock_device = $3)`,
      [device.id, name(by)],
    );
  }

  /** Le caissier la laisse sans l'encaisser : elle revient dans la liste. */
  release(device: Device, id: string) {
    return this.move(device, id, `status = 'waiting', lock_device = NULL, lock_name = NULL, locked_at = NULL`, `status = 'paying' AND lock_device = $3`, [device.id]);
  }

  /** Le caissier la rend au vendeur, avec le motif (« le client ne veut plus l'huile »). */
  giveBack(device: Device, id: string, note: string, by: string) {
    const why = str(note).trim().slice(0, 200);
    if (why.length < 2) throw new BadRequestException('Dites au vendeur ce qu’il faut changer');
    return this.move(
      device,
      id,
      `status = 'returned', note = $4, done_by = $5, lock_device = NULL, lock_name = NULL, locked_at = NULL`,
      `status = 'waiting' OR (status = 'paying' AND lock_device = $3)`,
      [device.id, why, name(by)],
    );
  }

  /** Encaissée : le numéro de la vente reste sur la facture. Le même avis répété ne change rien. */
  async paid(device: Device, id: string, saleId: string, saleNumber: string, by: string) {
    const r = await this.row(device, id);
    if (r.status === 'paid' && r.sale_number === str(saleNumber)) return this.view(r, device);
    return this.move(
      device,
      id,
      `status = 'paid', sale_id = $4, sale_number = $5, done_by = $6, lock_device = NULL, lock_name = NULL, locked_at = NULL`,
      // La vente est faite : elle l'emporte, même si la facture a été libérée entre-temps.
      `status <> 'paid' AND $3::uuid IS NOT NULL`,
      [device.id, str(saleId), str(saleNumber), name(by)],
    );
  }

  /** Annulée par le vendeur (ou le gérant) tant qu'aucune caisse ne l'encaisse. */
  cancel(device: Device, id: string, by: string, reason?: string | null) {
    return this.move(
      device,
      id,
      `status = 'cancelled', done_by = $4, note = COALESCE($5, note), lock_device = NULL, lock_name = NULL, locked_at = NULL`,
      `status IN ('waiting', 'returned') OR (status = 'editing' AND lock_device = $3)`,
      [device.id, name(by), str(reason).trim().slice(0, 200) || null],
    );
  }

  /** Le gérant libère une facture restée bloquée (PC éteint pendant l'encaissement ou la modification). */
  unlock(device: Device, id: string) {
    return this.move(device, id, `status = 'waiting', lock_device = NULL, lock_name = NULL, locked_at = NULL`, `status IN ('editing', 'paying')`, []);
  }
}

/** Pourquoi la facture ne peut pas changer maintenant, dit au vendeur ou au caissier. */
function busy(r: Row, device: Device): string {
  const here = r.lock_device === device.id;
  switch (r.status) {
    case 'paid':
      return `La facture n° ${r.number} est déjà encaissée${r.sale_number ? ` (${r.sale_number})` : ''}`;
    case 'cancelled':
      return `La facture n° ${r.number} a été annulée`;
    case 'paying':
      return here ? `La facture n° ${r.number} est ouverte sur cette caisse` : `La facture n° ${r.number} est en cours d’encaissement${r.lock_name ? ` par ${r.lock_name}` : ''}`;
    case 'editing':
      return `La facture n° ${r.number} est en cours de modification${r.lock_name ? ` par ${r.lock_name}` : ''}`;
    case 'returned':
      return `La facture n° ${r.number} a été rendue au vendeur`;
    default:
      return `La facture n° ${r.number} a changé entre-temps : rouvrez-la`;
  }
}
