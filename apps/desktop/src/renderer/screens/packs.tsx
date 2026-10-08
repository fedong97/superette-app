import { containsFromDivisors, dividePrice, splitTtc } from '@superette/core';
import { useEffect, useState } from 'react';
import { call } from '../api';
import { fcfa, parseAmount, parseQty } from '../ui';

/**
 * Fiche article à la KONTROL. Bloc 1 : le conditionnement d'achat (PALETTE)
 * avec ses prix d'achat, de revient et de vente. Blocs 2 à 4 : les
 * conditionnements de vente, du plus grand au plus petit, chacun avec son
 * diviseur par rapport au conditionnement d'achat (CANETTE : 24). Leur achat
 * et leur revient s'en déduisent (17 000 / 24 = 708), leurs prix de vente se
 * saisissent. Le dernier bloc coché est l'unité de détail : le stock est
 * compté ainsi.
 */
export interface LevelDraft {
  key: number;
  enabled: boolean;
  name: string;
  divisor: string;
  sale: string;
  wholesale: string;
  superWholesale: string;
  barcode: string;
  /** Prix de vente proposé (vente du conditionnement d'achat / diviseur), pas encore retouché. */
  auto?: boolean;
}

/** Prix d'achat et de revient du conditionnement d'achat. */
export interface BuyDraft {
  purchase: string;
  cost: string;
}

export const MAX_LEVELS = 4;

let keySeq = 0;
const newKey = () => ++keySeq;
const str = (v: number | null | undefined) => (v === null || v === undefined ? '' : String(v));
const num = (v: string) => (v.trim() ? parseAmount(v) : null);

export const emptyLevel = (enabled = false): LevelDraft => ({ key: newKey(), enabled, name: '', divisor: '', sale: '', wholesale: '', superWholesale: '', barcode: '' });

interface ArticleLevels {
  unit: string;
  unit_name: string | null;
  purchase_price: number;
  sale_price: number;
  wholesale_price: number | null;
  super_wholesale_price: number | null;
  pack_purchase_price: number | null;
  pack_cost_price: number | null;
  packs: readonly { name: string; units: number; sale_price: number; wholesale_price: number | null; super_wholesale_price: number | null; barcode: string | null }[];
}

/** Blocs de la fiche à partir de l'article enregistré (conditionnements puis unité). */
export function levelsFromArticle(a: ArticleLevels | null): { levels: LevelDraft[]; buy: BuyDraft } {
  if (!a) return { levels: [emptyLevel(true), emptyLevel(), emptyLevel(), emptyLevel()], buy: { purchase: '', cost: '' } };
  const top = a.packs[0]?.units ?? 1000;
  const levels: LevelDraft[] = [
    ...a.packs.map((p) => ({
      key: newKey(),
      enabled: true,
      name: p.name,
      divisor: String(Math.round(top / p.units)),
      sale: String(p.sale_price),
      wholesale: str(p.wholesale_price),
      superWholesale: str(p.super_wholesale_price),
      barcode: p.barcode ?? '',
    })),
    {
      key: newKey(),
      enabled: true,
      name: a.unit_name ?? '',
      divisor: String(top / 1000),
      sale: String(a.sale_price),
      wholesale: str(a.wholesale_price),
      superWholesale: str(a.super_wholesale_price),
      barcode: '',
    },
  ];
  while (levels.length < MAX_LEVELS) levels.push(emptyLevel());
  const purchase = a.pack_purchase_price ?? Math.round((a.purchase_price * top) / 1000);
  return { levels, buy: { purchase: String(purchase), cost: String(a.pack_cost_price ?? purchase) } };
}

export interface LevelsInput {
  unitName: string | null;
  salePrice: number;
  wholesalePrice: number | null;
  superWholesalePrice: number | null;
  packPurchasePrice: number;
  packCostPrice: number;
  purchasePrice: number;
  packs: { name: string; contains: number; salePrice: number; wholesalePrice: number | null; superWholesalePrice: number | null; barcode: string | null }[];
}

/** Blocs saisis vers la fiche enregistrée ; renvoie le message d'erreur s'il y en a un. */
export function levelsToInput(levels: LevelDraft[], buy: BuyDraft, piece: boolean): LevelsInput | string {
  const used = piece ? levels.filter((l, i) => i === 0 || l.enabled) : levels.slice(0, 1);
  const divisors = used.map((l, i) => (i === 0 ? 1 : Math.floor(Number(l.divisor.replace(/\s/g, '')) || 0)));
  const contains = containsFromDivisors(used.map((l, i) => ({ name: l.name, divisor: divisors[i]! })));
  if (typeof contains === 'string') return contains;
  const purchase = num(buy.purchase);
  const cost = buy.cost.trim() ? num(buy.cost) : purchase;
  if (purchase === null) return "Prix d'achat du conditionnement d'achat invalide";
  if (cost === null) return 'Prix de revient invalide';
  const prices = [] as { sale: number; wholesale: number | null; superWholesale: number | null }[];
  for (const l of used) {
    const name = l.name.trim() || (piece ? 'sans nom' : 'article');
    if (piece && !l.name.trim()) return 'Donnez un nom à chaque conditionnement coché (PALETTE, CASIER, CANETTE…)';
    const sale = num(l.sale);
    if (!sale) return `Prix de vente de « ${name} » invalide`;
    const wholesale = num(l.wholesale);
    const superWholesale = num(l.superWholesale);
    if ((l.wholesale.trim() && !wholesale) || (l.superWholesale.trim() && !superWholesale)) return `Prix de gros de « ${name} » invalide`;
    prices.push({ sale, wholesale, superWholesale });
  }
  const last = used.length - 1;
  return {
    unitName: piece ? used[last]!.name.trim() : null,
    salePrice: prices[last]!.sale,
    wholesalePrice: prices[last]!.wholesale,
    superWholesalePrice: prices[last]!.superWholesale,
    packPurchasePrice: purchase,
    packCostPrice: cost,
    purchasePrice: dividePrice(purchase, divisors[last]!),
    packs: used.slice(0, last).map((l, i) => ({
      name: l.name.trim(),
      contains: contains[i]!,
      salePrice: prices[i]!.sale,
      wholesalePrice: prices[i]!.wholesale,
      superWholesalePrice: prices[i]!.superWholesale,
      barcode: l.barcode.trim() || null,
    })),
  };
}

/**
 * Grille des conditionnements : une ligne par bloc, comme sur la fiche KONTROL.
 * En plus de KONTROL : la marge sur le revient, et une alerte quand un grand
 * conditionnement revient plus cher que les petits vendus séparément.
 */
export function LevelGrid({
  levels,
  buy,
  rate,
  piece,
  unitLabel,
  onLevels,
  onBuy,
}: {
  levels: LevelDraft[];
  buy: BuyDraft;
  rate: number;
  /** Article vendu à la pièce : sinon (kg, litre) un seul bloc. */
  piece: boolean;
  unitLabel: string;
  onLevels: (levels: LevelDraft[]) => void;
  onBuy: (buy: BuyDraft) => void;
}) {
  const shown = piece ? levels : levels.slice(0, 1);
  const set = (i: number, patch: Partial<LevelDraft>) => onLevels(levels.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const purchase = num(buy.purchase);
  const cost = buy.cost.trim() ? num(buy.cost) : purchase;
  const lastOn = piece ? shown.reduce((last, l, i) => (i === 0 || l.enabled ? i : last), 0) : 0;
  const divisorOf = (i: number) => (i === 0 ? 1 : Math.floor(Number(levels[i]!.divisor) || 0));
  // Prix de vente ramené à l'unité de détail, pour repérer un grand conditionnement plus cher que le détail.
  const lastDiv = divisorOf(lastOn);
  const lastSale = num(levels[lastOn]!.sale);
  const toggle = (i: number, on: boolean) => {
    // Décocher un bloc décoche aussi les plus petits.
    if (!on) return onLevels(levels.map((l, j) => (j >= i ? { ...l, enabled: false } : l)));
    // On coche dans l'ordre : un bloc ne s'active que si le précédent l'est.
    if (i > 1 && !levels[i - 1]!.enabled) return;
    set(i, { enabled: true, ...suggest(levels[i]!, levels[i]!.divisor) });
  };
  // Prix de vente proposé tant qu'il n'a pas été retouché : vente du bloc 1 / diviseur.
  const suggest = (l: LevelDraft, divisor: string): Partial<LevelDraft> => {
    const sale = num(levels[0]!.sale);
    const div = Math.floor(Number(divisor) || 0);
    if (!sale || div < 2 || (l.sale && !l.auto)) return {};
    return { sale: String(dividePrice(sale, div)), auto: true };
  };
  return (
    <table className="list compact levels">
      <thead>
        <tr>
          <th className="n">N°</th>
          <th>Conditionnement</th>
          <th className="r">Diviseur</th>
          <th className="r">Achat HT</th>
          <th className="r">Revient</th>
          <th className="r">Vente TTC</th>
          <th className="r">Gros</th>
          <th className="r">Sup. gros</th>
          <th>Code-barres</th>
          <th className="r">Marge</th>
        </tr>
      </thead>
      <tbody>
        {shown.map((l, i) => {
          const on = i === 0 || l.enabled;
          const div = divisorOf(i);
          const sale = num(l.sale);
          const levelCost = cost !== null && div > 0 ? dividePrice(cost, div) : null;
          const ht = sale ? splitTtc(sale, rate).ht : 0;
          const margin = ht > 0 && levelCost ? Math.round(((ht - levelCost) / ht) * 100) : null;
          const dearer = on && i < lastOn && sale && lastSale && div > 0 && lastDiv > div && sale > lastSale * (lastDiv / div);
          return (
            <tr key={l.key} className={`${i === 0 ? 'buy' : ''} ${on ? '' : 'off'}`}>
              <td className="n">
                {i === 0 ? (
                  <span className="pack-num" title="Conditionnement d'achat">1</span>
                ) : (
                  <label className="inline" title="Activer ce conditionnement de vente">
                    <input type="checkbox" checked={l.enabled} disabled={!l.enabled && i > 1 && !levels[i - 1]!.enabled} onChange={(e) => toggle(i, e.target.checked)} />
                    {i + 1}
                  </label>
                )}
              </td>
              <td>
                {piece ? (
                  <input
                    className="level-name"
                    value={l.name}
                    disabled={!on}
                    onChange={(e) => set(i, { name: e.target.value.toUpperCase() })}
                    placeholder={i === 0 ? 'PALETTE, CARTON…' : 'CANETTE, PIÈCE…'}
                  />
                ) : (
                  <b>{unitLabel}</b>
                )}
                {i === 0 && <small className="muted block">Conditionnement d'achat</small>}
                {piece && on && i === lastOn && <small className="muted block">Le stock est compté en {(l.name.trim() || 'unité').toLowerCase()}</small>}
              </td>
              <td className="r">
                {i === 0 ? (
                  '1'
                ) : (
                  <input className="qty" inputMode="numeric" value={l.divisor} disabled={!on} onChange={(e) => set(i, { divisor: e.target.value, ...suggest(l, e.target.value) })} />
                )}
              </td>
              <td className="r">
                {i === 0 ? (
                  <input className="amount" inputMode="numeric" value={buy.purchase} onChange={(e) => onBuy({ ...buy, purchase: e.target.value })} />
                ) : (
                  <span className="muted">{on && purchase !== null && div > 0 ? fcfa(dividePrice(purchase, div)) : ''}</span>
                )}
              </td>
              <td className="r">
                {i === 0 ? (
                  <input className="amount" inputMode="numeric" value={buy.cost} placeholder={buy.purchase} onChange={(e) => onBuy({ ...buy, cost: e.target.value })} />
                ) : (
                  <span className="muted">{on && levelCost !== null ? fcfa(levelCost) : ''}</span>
                )}
              </td>
              {(['sale', 'wholesale', 'superWholesale'] as const).map((k) => (
                <td key={k} className="r">
                  <input
                    className="amount"
                    inputMode="numeric"
                    value={l[k]}
                    disabled={!on}
                    placeholder={k === 'wholesale' ? l.sale : k === 'superWholesale' ? l.wholesale || l.sale : ''}
                    onChange={(e) => set(i, { [k]: e.target.value, ...(k === 'sale' ? { auto: false } : {}) })}
                  />
                </td>
              ))}
              <td>
                {piece && on && i < lastOn ? (
                  <input className="barcode" value={l.barcode} onChange={(e) => set(i, { barcode: e.target.value })} placeholder="Scanner" />
                ) : (
                  <small className="muted">{on ? 'voir plus bas' : ''}</small>
                )}
              </td>
              <td className={`r ${margin !== null && margin < 0 ? 'neg' : ''}`}>
                {on && margin !== null ? `${margin} %` : ''}
                {dearer && <small className="neg block">Plus cher qu'au détail</small>}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// --- Saisie des achats par conditionnement ---------------------------------------

/** Conditionnement proposé à la saisie d'une ligne d'achat ; `units` en millièmes d'unité de détail. */
export interface PackChoice {
  name: string;
  units: number;
}

interface WithPacks {
  unit: string;
  unit_name: string | null;
  packs: readonly { name: string; units: number; is_purchase: number }[];
}

/** Conditionnements de l'article puis son unité de détail ; vide quand il n'en a pas. */
export function packChoices(a: WithPacks): PackChoice[] {
  if (a.unit !== 'piece' || a.packs.length === 0) return [];
  return [...a.packs.map((p) => ({ name: p.name, units: p.units })), { name: a.unit_name || 'Pièce', units: 1000 }];
}

/** Conditionnement d'achat de l'article : le plus grand (la palette), sinon l'unité. */
export function purchaseUnits(a: WithPacks): number {
  return a.packs[0]?.units ?? 1000;
}

/** Dernier prix d'achat d'un conditionnement : exact pour le conditionnement d'achat (17 000 la palette). */
export function packCostText(a: WithPacks & { purchase_price: number; pack_purchase_price: number | null }, units: number): string {
  if (units === purchaseUnits(a) && a.pack_purchase_price) return String(a.pack_purchase_price);
  return a.purchase_price ? String(Math.round((a.purchase_price * units) / 1000)) : '';
}

/** Conditionnement d'affichage d'une quantité déjà saisie : le préféré s'il tombe juste, sinon le plus grand qui tombe juste. */
export function unitsFor(qty: number, choices: PackChoice[], preferred: number): number {
  if (preferred > 1000 && qty % preferred === 0) return preferred;
  return choices.find((c) => qty > 0 && qty % c.units === 0)?.units ?? 1000;
}

export const qtyText = (milli: number) => String(Math.round(milli) / 1000).replace('.', ',');

/** Ligne saisie en conditionnements (quantité de cartons, prix du carton) ramenée à l'unité de détail. */
export function toBase(qty: string, cost: string, units: number): { qty: number | null; unitCost: number | null } {
  const q = parseQty(qty);
  const c = parseAmount(cost);
  return { qty: q === null ? null : Math.round((q * units) / 1000), unitCost: c === null ? null : Math.round((c * 1000) / units) };
}

/** Change le conditionnement d'une ligne en gardant la même quantité et le même coût. */
export function switchUnits(qty: string, cost: string, from: number, to: number): { qty: string; cost: string } {
  const q = parseQty(qty);
  const c = parseAmount(cost);
  return { qty: q === null ? qty : qtyText((q * from) / to), cost: c === null ? cost : String(Math.round((c * to) / from)) };
}

/** Liste « Carton (100) / Paquet (10) / Ampoule » ; rien pour un article sans conditionnement. */
export function PackUnitSelect({ choices, value, onChange }: { choices: PackChoice[]; value: number; onChange: (units: number) => void }) {
  if (choices.length === 0) return null;
  const base = choices[choices.length - 1]!.name;
  return (
    <select className="pack-unit" value={value} onChange={(e) => onChange(Number(e.target.value))}>
      {choices.map((c) => (
        <option key={c.units} value={c.units}>
          {c.units === 1000 ? c.name : `${c.name} (${qtyText(c.units)} ${base})`}
        </option>
      ))}
    </select>
  );
}

/** Conditionnements des articles d'un bon déjà enregistré, chargés une fois par article. */
export function useArticlePacks(ids: string[]): [Map<string, WithPacks>, (id: string, a: WithPacks) => void] {
  const [map, setMap] = useState(() => new Map<string, WithPacks>());
  const key = [...new Set(ids)].sort().join(',');
  useEffect(() => {
    const missing = key ? key.split(',').filter((id) => !map.has(id)) : [];
    if (!missing.length) return;
    void Promise.all(missing.map((id) => call('catalogue.get', id).catch(() => null))).then((found) =>
      setMap((m) => {
        const next = new Map(m);
        found.forEach((a, i) => a && next.set(missing[i]!, a));
        return next;
      }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const remember = (id: string, a: WithPacks) => setMap((m) => new Map(m).set(id, a));
  return [map, remember];
}
