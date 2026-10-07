import { packUnits, splitTtc } from '@superette/core';
import { useEffect, useState } from 'react';
import { call } from '../api';
import { fcfa, parseAmount, parseQty } from '../ui';

/** Conditionnement en cours de saisie dans la fiche article (du plus grand au plus petit). */
export interface PackDraft {
  key: number;
  name: string;
  contains: string;
  sale: string;
  wholesale: string;
  superWholesale: string;
  barcode: string;
}

/** Unité de détail : l'article lui-même. */
export interface BaseDraft {
  unitName: string;
  purchase: string;
  sale: string;
  wholesale: string;
  superWholesale: string;
}

let keySeq = 0;
export const newPackKey = () => ++keySeq;

/** « 100 ampoules », « 1 ampoule », « 24 jus ». */
const plural = (word: string, n: number) => (n > 1 && !/[sxz]$/.test(word) ? `${word}s` : word);

const num = (v: string) => (v.trim() ? parseAmount(v) : null);

/** Unités de détail de chaque conditionnement saisi (0 si un « contient » est invalide). */
export function draftUnits(packs: PackDraft[]): number[] {
  return packUnits(packs.map((p) => ({ name: p.name, contains: Math.max(0, Math.floor(Number(p.contains) || 0)) })));
}

/**
 * Grille des conditionnements sur le modèle de KONTROL : une colonne par niveau,
 * du conditionnement d'achat (carton, palette) à l'unité de détail, avec pour
 * chacun ce qu'il contient, son coût d'achat, ses prix détail / gros / super gros
 * et son code-barres. On ajoute en plus : le prix ramené à l'unité, la marge, et
 * une alerte quand le carton revient plus cher que les unités vendues séparément.
 */
export function PackGrid({
  packs,
  base,
  purchaseIndex,
  rate,
  onPacks,
  onBase,
  onPurchaseIndex,
}: {
  packs: PackDraft[];
  base: BaseDraft;
  /** Niveau acheté au fournisseur : index du conditionnement, ou -1 pour l'unité de détail. */
  purchaseIndex: number;
  rate: number;
  onPacks: (packs: PackDraft[]) => void;
  onBase: (patch: Partial<BaseDraft>) => void;
  onPurchaseIndex: (i: number) => void;
}) {
  const units = draftUnits(packs);
  const unitName = base.unitName.trim() || 'Pièce';
  const unitBuy = num(base.purchase) ?? 0;
  const unitSale = num(base.sale) ?? 0;
  const setPack = (i: number, patch: Partial<PackDraft>) => onPacks(packs.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  const addBigger = () => {
    const top = packs[0];
    const contains = 10;
    const topUnits = top ? units[0]! : 1000;
    onPacks([{ key: newPackKey(), name: packs.length === 0 ? 'Carton' : packs.length === 1 ? 'Palette' : 'Lot', contains: String(contains), sale: unitSale ? String(Math.round((unitSale * topUnits * contains) / 1000)) : '', wholesale: '', superWholesale: '', barcode: '' }, ...packs]);
    if (purchaseIndex >= 0) onPurchaseIndex(purchaseIndex + 1);
  };
  const addSmaller = () => {
    // Niveau intercalé juste au-dessus de l'unité : le dernier conditionnement en contient alors plusieurs.
    const last = packs.length - 1;
    onPacks([
      ...packs.slice(0, last),
      { ...packs[last]!, contains: '' },
      { key: newPackKey(), name: 'Paquet', contains: '', sale: '', wholesale: '', superWholesale: '', barcode: '' },
    ]);
  };
  const remove = (i: number) => {
    // Le niveau au-dessus garde le même nombre d'unités : il contient désormais directement le niveau suivant.
    const next = packs.map((p) => ({ ...p }));
    if (i > 0) next[i - 1]!.contains = String((Number(next[i - 1]!.contains) || 0) * (Number(packs[i]!.contains) || 0));
    next.splice(i, 1);
    onPacks(next);
    if (purchaseIndex === i) onPurchaseIndex(-1);
    else if (purchaseIndex > i) onPurchaseIndex(purchaseIndex - 1);
  };
  const levelName = (i: number) => (i < packs.length ? packs[i]!.name.trim() || `niveau ${i + 1}` : unitName);

  const facts = (sale: number | null, levelUnits: number) => {
    if (!sale) return null;
    const perUnit = Math.round((sale * 1000) / levelUnits);
    const cost = Math.round((unitBuy * levelUnits) / 1000);
    const ht = splitTtc(sale, rate).ht;
    const margin = ht > 0 && cost > 0 ? Math.round(((ht - cost) / ht) * 100) : null;
    const saving = levelUnits > 1000 && unitSale ? Math.round((1 - perUnit / unitSale) * 100) : null;
    return (
      <div className="pack-facts">
        {levelUnits > 1000 && (
          <span>
            {fcfa(perUnit)} / {unitName.toLowerCase()}
            {saving !== null && saving > 0 && <span className="ok"> (−{saving} %)</span>}
          </span>
        )}
        {margin !== null && <span className={margin < 0 ? 'neg' : ''}>Marge {margin} %</span>}
        {levelUnits > 1000 && unitSale > 0 && perUnit > unitSale && <span className="neg">Plus cher qu'à l'unité</span>}
        {margin !== null && margin < 0 && <span className="neg">Vendu à perte</span>}
      </div>
    );
  };

  const priceRows = (v: { sale: string; wholesale: string; superWholesale: string }, set: (patch: Partial<typeof v>) => void, levelUnits: number) => (
    <>
      <label>
        <span>Vente TTC</span>
        <input inputMode="numeric" value={v.sale} onChange={(e) => set({ sale: e.target.value })} required />
      </label>
      <label>
        <span>Gros</span>
        <input inputMode="numeric" value={v.wholesale} placeholder={v.sale} onChange={(e) => set({ wholesale: e.target.value })} />
      </label>
      <label>
        <span>Super gros</span>
        <input inputMode="numeric" value={v.superWholesale} placeholder={v.wholesale || v.sale} onChange={(e) => set({ superWholesale: e.target.value })} />
      </label>
      {facts(num(v.sale), levelUnits)}
    </>
  );

  const buyRow = (levelUnits: number) => (
    <label>
      <span>Achat HT</span>
      <input
        inputMode="numeric"
        value={levelUnits === 1000 ? base.purchase : unitBuy ? String(Math.round((unitBuy * levelUnits) / 1000)) : ''}
        onChange={(e) => {
          const v = num(e.target.value);
          onBase({ purchase: levelUnits === 1000 ? e.target.value : v === null ? '' : String(Math.round((v * 1000) / levelUnits)) });
        }}
      />
    </label>
  );

  const purchaseMark = (i: number) => (
    <label className="pack-buy" title="Conditionnement dans lequel le fournisseur livre">
      <input type="radio" name="purchase-level" checked={purchaseIndex === i} onChange={() => onPurchaseIndex(i)} /> Achat
    </label>
  );

  return (
    <div className="packs">
      <button type="button" className="pack-add" onClick={addBigger} disabled={packs.length >= 3} title="Ajouter un conditionnement plus grand (carton, palette)">
        + Plus grand
      </button>
      {packs.map((p, i) => (
        <div key={p.key} className={`pack ${purchaseIndex === i ? 'buy' : ''}`}>
          <div className="pack-head">
            <span className="pack-num">{i + 1}</span>
            <input value={p.name} onChange={(e) => setPack(i, { name: e.target.value })} placeholder="Carton" required />
            <button type="button" className="ghost" onClick={() => remove(i)} title="Retirer ce conditionnement">
              ✕
            </button>
          </div>
          {purchaseMark(i)}
          <label>
            <span>Contient</span>
            <span className="inline">
              <input inputMode="numeric" className="contains" value={p.contains} onChange={(e) => setPack(i, { contains: e.target.value })} required />
              <small>{levelName(i + 1)}</small>
            </span>
          </label>
          <div className="pack-units muted">{units[i] ? `= ${units[i]! / 1000} ${plural(unitName.toLowerCase(), units[i]! / 1000)}` : 'Indiquez le contenu'}</div>
          {units[i] ? buyRow(units[i]!) : null}
          {priceRows(p, (patch) => setPack(i, patch), units[i] || 1000)}
          <label>
            <span>Code-barres</span>
            <input value={p.barcode} onChange={(e) => setPack(i, { barcode: e.target.value })} placeholder="Scanner" />
          </label>
        </div>
      ))}
      <div className={`pack base ${purchaseIndex === -1 ? 'buy' : ''}`}>
        <div className="pack-head">
          <span className="pack-num">{packs.length + 1}</span>
          <input value={base.unitName} onChange={(e) => onBase({ unitName: e.target.value })} placeholder="Pièce" />
        </div>
        {purchaseMark(-1)}
        <div className="pack-units muted">Unité de détail : le stock est compté ainsi</div>
        {buyRow(1000)}
        {priceRows(base, onBase, 1000)}
        {packs.length > 0 && packs.length < 3 && (
          <button type="button" className="ghost" onClick={addSmaller} title="Intercaler un niveau (paquet, pack) entre le dernier conditionnement et l'unité">
            + Intercaler un niveau
          </button>
        )}
      </div>
    </div>
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

/** Conditionnement d'achat de l'article (le carton, la palette), sinon l'unité. */
export function purchaseUnits(a: WithPacks): number {
  return a.packs.find((p) => p.is_purchase)?.units ?? 1000;
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
