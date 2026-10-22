import { type Fcfa } from './money';

export const PAYMENT_METHODS = {
  CASH: 'Espèces',
  MTN_MOMO: 'MTN Mobile Money',
  ORANGE_MONEY: 'Orange Money',
  CARD: 'Carte bancaire',
  BANK_TRANSFER: 'Virement',
  CHEQUE: 'Chèque',
  CUSTOMER_CREDIT: 'Crédit client',
  VOUCHER: "Bon d'achat",
  LOYALTY: 'Points fidélité',
} as const;

export type PaymentMethod = keyof typeof PAYMENT_METHODS;

/**
 * Caisse qui reçoit un paiement : les espèces vont au tiroir, Mobile Money et
 * carte à la caisse électronique du caissier, virement et chèque à sa caisse banque.
 * Crédit client, bon d'achat et points fidélité restent sur la journée du ticket.
 */
export type RegisterKind = 'cash' | 'electronic' | 'bank';
export const ELECTRONIC_METHODS = ['MTN_MOMO', 'ORANGE_MONEY', 'CARD'] as const;
export const BANK_METHODS = ['BANK_TRANSFER', 'CHEQUE'] as const;
export type ElectronicMethod = (typeof ELECTRONIC_METHODS)[number];

/** Moyens reçus par une caisse électronique (« MTN_MOMO,CARD ») ; vide : tous. */
export function registerMethods(methods: string | null | undefined): ElectronicMethod[] {
  const list = (methods ?? '').split(',').filter((m): m is ElectronicMethod => (ELECTRONIC_METHODS as readonly string[]).includes(m));
  return list.length ? list : [...ELECTRONIC_METHODS];
}
export function paymentRegisterKind(method: string): RegisterKind {
  if ((ELECTRONIC_METHODS as readonly string[]).includes(method)) return 'electronic';
  if ((BANK_METHODS as readonly string[]).includes(method)) return 'bank';
  return 'cash';
}

export interface Payment {
  method: PaymentMethod;
  amount: Fcfa;
  /** Référence de transaction mobile money / carte, numéro de bon… */
  reference?: string;
}

export interface Settlement {
  paid: Fcfa;
  remaining: Fcfa;
  change: Fcfa;
  complete: boolean;
}

/**
 * Règlement mixte d'un ticket. Seules les espèces peuvent dépasser le reste
 * dû (rendu monnaie) ; un paiement électronique supérieur au reste est refusé.
 */
export function settle(total: Fcfa, payments: readonly Payment[]): Settlement {
  const nonCash = payments.filter((p) => p.method !== 'CASH').reduce((s, p) => s + p.amount, 0);
  const cash = payments.filter((p) => p.method === 'CASH').reduce((s, p) => s + p.amount, 0);
  for (const p of payments) {
    if (!Number.isSafeInteger(p.amount) || p.amount <= 0) {
      throw new Error(`Montant de paiement invalide : ${p.amount}`);
    }
  }
  if (nonCash > total) {
    throw new Error('Les paiements hors espèces dépassent le montant du ticket');
  }
  const paid = cash + nonCash;
  const remaining = Math.max(0, total - paid);
  const change = Math.max(0, paid - total);
  return { paid, remaining, change, complete: remaining === 0 };
}

/** Paiements qui exigent une référence de transaction avant validation. */
export function requiresReference(method: PaymentMethod): boolean {
  return method === 'MTN_MOMO' || method === 'ORANGE_MONEY' || method === 'VOUCHER' || method === 'BANK_TRANSFER' || method === 'CHEQUE';
}
