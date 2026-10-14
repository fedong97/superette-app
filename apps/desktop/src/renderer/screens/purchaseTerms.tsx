import { promoFree, purchaseAmounts } from '@superette/core';
import { parseAmount, parseQty } from '../ui';
import { toBase } from './packs';

/** Remise en % et promo « N achetés, M payés » d'une ligne d'achat, telles que saisies. */
export interface TermsText {
  disc: string;
  promo: string;
}

/** Saisie de la facture d'achat : gratuits en plus de la quantité et remise en montant. */
export interface ExtraTerms {
  /** Unités gratuites (dans le conditionnement saisi) reçues en plus de la quantité payée. */
  bonus?: string;
  /** Remise en FCFA sur la ligne, à la place du pourcentage quand discType vaut « amount ». */
  discAmount?: string;
  discType?: 'pct' | 'amount' | 'promo';
}

export const noTerms: TermsText = { disc: '', promo: '' };

/** Texte saisi d'après une ligne enregistrée (bon de commande repris). */
export function termsFrom(l: { discount_bp: number; promo_buy: number | null; promo_pay: number | null }): TermsText {
  return {
    disc: l.discount_bp ? String(l.discount_bp / 100).replace('.', ',') : '',
    promo: l.promo_buy && l.promo_pay !== null ? `${l.promo_buy}/${l.promo_pay}` : '',
  };
}

/** « 12/10 », « 12 / 10 » ou « 12:10 » : 12 achetés, 10 payés. */
function parsePromo(v: string): { buy: number; pay: number } | null | 'error' {
  const s = v.trim();
  if (!s) return null;
  const m = /^(\d+)\s*[/:]\s*(\d+)$/.exec(s);
  if (!m) return 'error';
  const buy = Number(m[1]);
  const pay = Number(m[2]);
  return buy > 0 && pay < buy ? { buy, pay } : 'error';
}

function parseDisc(v: string): number | null | 'error' {
  const s = v.trim().replace('%', '').replace(',', '.');
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? Math.round(n * 100) : 'error';
}

export interface LineTerms {
  qty: number;
  unitCost: number;
  discountBp: number;
  freeQty: number;
  promoBuy: number | null;
  promoPay: number | null;
  /** Gratuits dans l'unité saisie (cartons, pièces). */
  freeCount: number;
  net: number;
  gross: number;
}

/**
 * Quantité, prix et conditions d'une ligne en unités de base. La promo
 * compte en unités saisies : 12 cartons achetés, 10 payés sur 24 cartons
 * donne 4 cartons gratuits. Renvoie un message en cas d'erreur.
 */
export function lineTerms(l: { qty: string; cost: string; packUnits: number } & TermsText & ExtraTerms): LineTerms | string {
  const b = toBase(l.qty, l.cost, l.packUnits);
  if (!b.qty || b.qty <= 0 || b.unitCost === null) return 'Quantité ou prix invalide';
  const type = l.discType ?? 'pct';
  const disc = type === 'pct' ? parseDisc(l.disc) : null;
  if (disc === 'error') return 'Remise invalide : un pourcentage entre 0 et 100';
  const promo = type === 'promo' || !l.discType ? parsePromo(l.promo) : null;
  if (promo === 'error') return 'Promo invalide : écrivez N/M, par exemple 12/10 pour 12 achetés, 10 payés';
  const bonusText = (l.bonus ?? '').trim();
  const bonus = bonusText ? parseQty(bonusText) : 0;
  if (bonus === null || bonus < 0) return 'Bonus invalide';
  // Le bonus s'ajoute à la quantité payée : 10 cartons + 1 en bonus, 11 reçus.
  const bonusBase = Math.round((bonus * l.packUnits) / 1000);
  const count = Math.floor((parseQty(l.qty) ?? 0) / 1000);
  const freeCount = promo ? promoFree(count, promo.buy, promo.pay) : 0;
  // packUnits : millièmes d'unité de base par unité saisie (un carton de 12 : 12 000).
  const freeQty = Math.min(b.qty, freeCount * l.packUnits) + bonusBase;
  const qty = b.qty + bonusBase;
  let discountBp = disc ?? 0;
  if (type === 'amount') {
    const amountText = (l.discAmount ?? '').trim();
    const amount = amountText ? parseAmount(amountText) : 0;
    const paid = purchaseAmounts({ qty, unitCost: b.unitCost, freeQty }).net;
    if (amount === null || amount < 0 || amount > paid) return 'Remise invalide : un montant entre 0 et le montant de la ligne';
    // Montant ramené en points de base (0,01 %) : le net peut différer de quelques francs.
    discountBp = paid > 0 ? Math.min(10_000, Math.round((amount * 10_000) / paid)) : 0;
  }
  const a = purchaseAmounts({ qty, unitCost: b.unitCost, discountBp, freeQty });
  return {
    qty,
    unitCost: b.unitCost,
    discountBp,
    freeQty,
    promoBuy: promo?.buy ?? null,
    promoPay: promo?.pay ?? null,
    freeCount: freeCount + bonus / 1000,
    net: a.net,
    gross: a.gross,
  };
}

/** Montant HT net d'une ligne en cours de saisie (0 si elle est incomplète). */
export function lineNet(l: { qty: string; cost: string; packUnits: number } & TermsText & ExtraTerms): number {
  const t = lineTerms(l);
  return typeof t === 'string' ? 0 : t.net;
}

/** Deux cellules : remise en % et promo N/M, avec les gratuits calculés. */
export function TermsCells<L extends { qty: string; cost: string; packUnits: number } & TermsText>({ line, onChange }: { line: L; onChange: (patch: Partial<TermsText>) => void }) {
  const t = lineTerms(line);
  return (
    <>
      <td>
        <input className="qty pct" value={line.disc} placeholder="%" title="Remise en %" onChange={(e) => onChange({ disc: e.target.value })} />
      </td>
      <td>
        <input className="qty promo" value={line.promo} placeholder="N/M" title="N achetés, M payés (12/10)" onChange={(e) => onChange({ promo: e.target.value })} />
        {typeof t !== 'string' && t.freeCount > 0 && <small className="muted block">{t.freeCount} gratuit{t.freeCount > 1 ? 's' : ''}</small>}
      </td>
    </>
  );
}
