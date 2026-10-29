import { type Fcfa, type PriceLevel, computeTotals } from '@superette/core';
import type { AdminService } from './admin';
import type { CustomerService } from './customers';
import type { Db } from './database';
import type { PosService, Sale, SaleInput, SaleLineInput } from './pos';
import { AppError, Base, type Clock } from './util';

/**
 * Vendeur et caissier séparés : la facture préparée par le vendeur part au
 * serveur central, une caisse du magasin l'encaisse. Rien ne sort du stock et
 * aucune vente n'existe avant l'encaissement.
 */

/** Contenu d'une facture envoyée à la caisse : ce qu'il faut pour en faire la vente. */
export interface CounterPayload {
  lines: SaleLineInput[];
  customerId: string | null;
  /** Nom d'un client comptoir (sans fiche client). */
  clientName: string | null;
  priceLevel: PriceLevel | null;
  warehouseId: string | null;
  /** Remises : le vendeur qui a ce droit, ou le gérant qui a donné son code. */
  discountBy: string | null;
  /** Prix saisis : le vendeur qui a ce droit, ou le gérant. */
  priceBy: string | null;
  /** Tarif ou dépôt choisis hors de l'habituel : le vendeur qui a ce droit, ou le gérant. */
  optionsBy: string | null;
  /** Panier préparé au rayon sur le téléphone, devenu facture à la caisse. */
  cartNumber?: number | null;
  /** Motif de la remise. */
  discountReason?: string | null;
}

export type CounterStatus = 'waiting' | 'editing' | 'returned' | 'paying' | 'paid' | 'cancelled';

export const COUNTER_STATUS: Record<CounterStatus, string> = {
  waiting: 'À encaisser',
  editing: 'En modification',
  returned: 'Rendue au vendeur',
  paying: 'En cours d’encaissement',
  paid: 'Encaissée',
  cancelled: 'Annulée',
};

/** Une facture envoyée à la caisse, telle que le serveur central la tient. */
export interface CounterInvoice {
  id: string;
  number: number;
  sellerId: string;
  sellerName: string;
  status: CounterStatus;
  version: number;
  total: Fcfa;
  lines: number;
  customerName: string | null;
  /** Motif du retour au vendeur (ou de l'annulation). */
  note: string | null;
  lockName: string | null;
  /** Tenue par ce PC (ouverte ici pour l'encaisser ou la modifier). */
  lockedHere: boolean;
  saleNumber: string | null;
  doneBy: string | null;
  at: string;
  updatedAt: string;
  payload?: CounterPayload;
}

export type CounterAction = 'edit' | 'unedit' | 'take' | 'release' | 'return' | 'paid' | 'cancel' | 'unlock';

export class CounterService extends Base {
  constructor(
    db: Db,
    clock: Clock,
    private readonly admin: AdminService,
    private readonly pos: PosService,
    private readonly customers: CustomerService,
  ) {
    super(db, clock);
  }

  /**
   * Facture prête à partir : lignes au prix du magasin (comme à l'encaissement),
   * total et nom du client affichés à la caisse.
   */
  prepare(storeId: string, payload: CounterPayload): { payload: CounterPayload; total: Fcfa; lines: number; customerName: string | null } {
    if (!payload.lines.length) throw new AppError('La facture est vide', 'EMPTY');
    if (payload.lines.some((l) => l.qty <= 0)) throw new AppError('Quantité négative : le retour client se fait à la caisse', 'INVALID');
    const customer = payload.customerId ? this.customers.getCustomer(payload.customerId) : null;
    const level = payload.priceLevel ?? customer?.price_level ?? 'retail';
    const priced = this.pos.priceLines(storeId, payload.lines, level, customer?.id ?? null);
    const clean: CounterPayload = {
      ...payload,
      customerId: customer?.id ?? null,
      clientName: customer ? null : payload.clientName?.trim().slice(0, 80) || null,
      lines: payload.lines.map((l) => ({ articleId: l.articleId, qty: l.qty, barcode: l.barcode ?? null, discount: l.discount ?? 0, packId: l.packId ?? null, price: l.price ?? null })),
    };
    return { payload: clean, total: computeTotals(priced).totalTtc, lines: priced.length, customerName: customer?.name ?? clean.clientName };
  }

  /**
   * Vente d'une ou plusieurs factures encaissées ensemble (le client a pris un
   * article de plus : le vendeur a fait une deuxième facture). Elles doivent
   * être du même client, du même vendeur, au même tarif et du même dépôt.
   */
  saleInput(invoices: Pick<CounterInvoice, 'number' | 'sellerId' | 'payload'>[]): Omit<SaleInput, 'payments'> {
    const first = invoices[0];
    if (!first?.payload) throw new AppError('Aucune facture à encaisser', 'EMPTY');
    const p0 = first.payload;
    for (const inv of invoices.slice(1)) {
      const p = inv.payload!;
      const same =
        inv.sellerId === first.sellerId &&
        p.customerId === p0.customerId &&
        (p0.customerId !== null || (p.clientName ?? '') === (p0.clientName ?? '') || !p.clientName || !p0.clientName) &&
        (p.priceLevel ?? null) === (p0.priceLevel ?? null) &&
        (p.warehouseId ?? null) === (p0.warehouseId ?? null);
      if (!same) throw new AppError(`Les factures n° ${first.number} et n° ${inv.number} n'ont pas le même client, vendeur, tarif ou dépôt : encaissez-les une par une`, 'INVALID');
    }
    let seller: string | null = null;
    try {
      seller = this.admin.getUser(first.sellerId).id;
    } catch {
      seller = null;
    }
    return {
      lines: invoices.flatMap((i) => i.payload!.lines),
      customerId: p0.customerId,
      clientName: p0.clientName ?? invoices.find((i) => i.payload!.clientName)?.payload!.clientName ?? null,
      priceLevel: p0.priceLevel,
      warehouseId: p0.warehouseId,
      // Chaque facture a fait valider ses remises chez le vendeur.
      discountAuthorizedBy: invoices.map((i) => i.payload!.discountBy).find(Boolean) ?? null,
      sellerId: seller,
    };
  }

  /** Trace d'un envoi, d'une modification, d'un retour ou d'un encaissement dans le journal d'audit. */
  log(userId: string, action: string, entity: string, entityId: string, details: unknown): void {
    this.audit(userId, action, entity, entityId, details);
  }

  /** Factures encaissées sur ce PC : l'avis part au serveur, et repart tant qu'il n'est pas reçu. */
  recordPaid(invoiceIds: string[], sale: Pick<Sale, 'id' | 'number'>, userName: string): void {
    const insert = this.db.prepare('INSERT OR IGNORE INTO counter_paid (invoice_id, sale_id, sale_number, user_name, created_at) VALUES (?, ?, ?, ?, ?)');
    for (const id of invoiceIds) insert.run(id, sale.id, sale.number, userName, this.now());
  }

  unsentPaid(): { invoice_id: string; sale_id: string; sale_number: string; user_name: string | null }[] {
    return this.db.prepare('SELECT invoice_id, sale_id, sale_number, user_name FROM counter_paid WHERE sent_at IS NULL ORDER BY created_at').all() as never;
  }

  markPaidSent(invoiceId: string): void {
    this.db.prepare('UPDATE counter_paid SET sent_at = ? WHERE invoice_id = ?').run(this.now(), invoiceId);
  }

  /** Vente déjà faite ici pour cette facture (avis pas encore reçu par le serveur). */
  paidHere(invoiceId: string): { sale_id: string; sale_number: string } | null {
    return (this.db.prepare('SELECT sale_id, sale_number FROM counter_paid WHERE invoice_id = ?').get(invoiceId) as { sale_id: string; sale_number: string } | undefined) ?? null;
  }
}

