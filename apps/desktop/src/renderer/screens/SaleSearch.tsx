import { useEffect, useRef, useState } from 'react';
import { formatFcfa } from '@superette/core';
import { type Result, call } from '../api';
import { Field, Modal, fcfa, parseAmount, parseQty, qty, useToast } from '../ui';

export type SaleRow = Result<'pos.search'>[number];

const amount = (v: number) => formatFcfa(v, false);
export const rowKey = (r: SaleRow) => `${r.article_id}:${r.pack_id ?? ''}`;

/** Stock exprimé dans le conditionnement de la ligne : palettes pleines, canettes, kg. */
export function stockIn(r: SaleRow): string {
  if (r.units === 1000) return qty(r.stock, r.unit);
  return String(Math.max(0, Math.floor(r.stock / r.units)));
}

/**
 * Lignes de vente pendant la saisie (à partir de 2 lettres) : une par
 * conditionnement, seulement celles qu'on peut servir avec le stock.
 */
export function useSaleRows(query: string, customerId: string | null) {
  const [items, setItems] = useState<SaleRow[]>([]);
  const [active, setActive] = useState(0);
  const [closed, setClosed] = useState(false);
  useEffect(() => {
    setClosed(false);
    const q = query.trim();
    if (q.length < 2 || /^[\d\s]+$/.test(q)) {
      setItems([]);
      return;
    }
    let live = true;
    const t = setTimeout(() => {
      call('pos.search', q, { customerId })
        .then((r) => {
          if (!live) return;
          setItems(r.slice(0, 14));
          setActive(0);
        })
        .catch(() => live && setItems([]));
    }, 120);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [query, customerId]);
  const shown = closed ? [] : items;
  return {
    items: shown,
    active,
    setActive,
    close: () => setClosed(true),
    /** Flèches pour se déplacer, Entrée pour choisir, Échap pour fermer. Renvoie true si la touche a servi. */
    onKeyDown(e: React.KeyboardEvent, pick: (r: SaleRow) => void): boolean {
      if (!shown.length) return false;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        setActive((i) => (i + (e.key === 'ArrowDown' ? 1 : shown.length - 1)) % shown.length);
      } else if (e.key === 'Enter') {
        pick(shown[Math.min(active, shown.length - 1)]!);
      } else if (e.key === 'Escape') {
        setClosed(true);
      } else return false;
      e.preventDefault();
      e.stopPropagation();
      return true;
    },
  };
}

/** Liste déroulante sous la zone de saisie de la fiche de facturation. */
export function SaleRowList({ s, onPick }: { s: ReturnType<typeof useSaleRows>; onPick: (r: SaleRow) => void }) {
  if (!s.items.length) return null;
  return (
    <div className="suggest dropdown sale-rows" role="listbox">
      {s.items.map((r, i) => (
        <button
          type="button"
          key={rowKey(r)}
          role="option"
          aria-selected={i === s.active}
          className={`${i === s.active ? 'active' : ''} ${r.out_of_stock ? 'out' : ''}`}
          // mousedown : choisir avant que le champ perde le focus.
          onMouseDown={(e) => {
            e.preventDefault();
            onPick(r);
          }}
          onMouseEnter={() => s.setActive(i)}
        >
          <span className="muted">{r.code}</span>
          <span className="suggest-name">{r.name}</span>
          <span className="cond">{r.pack_name}</span>
          <span className="r muted">{r.out_of_stock ? <span className="tag danger epuise">Épuisé</span> : stockIn(r)}</span>
          <span className="suggest-price">{amount(r.price)}</span>
        </button>
      ))}
    </div>
  );
}

/**
 * « Rechercher/Facturer des marchandises » (KONTROL) : chaque conditionnement
 * sur sa ligne, avec stock, dépôt, prix au tarif du client et dernier prix.
 * Les boutons du bas créent l'article ou le conditionnement qui manque.
 */
export function SaleSearchDialog({
  initialQuery,
  customerId,
  canCreate,
  onClose,
  onPick,
  onCreateArticle,
  onCreateLevel,
}: {
  initialQuery: string;
  customerId: string | null;
  canCreate: boolean;
  onClose: () => void;
  onPick: (r: SaleRow) => void;
  onCreateArticle: (name: string) => void;
  onCreateLevel: (articleId: string, where: 'top' | 'bottom') => void;
}) {
  const toast = useToast();
  const [q, setQ] = useState(initialQuery);
  const [hideEmpty, setHideEmpty] = useState(false);
  const [rows, setRows] = useState<SaleRow[]>([]);
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLTableSectionElement>(null);
  useEffect(() => {
    if (q.trim().length < 1) {
      setRows([]);
      return;
    }
    let live = true;
    const t = setTimeout(() => {
      call('pos.search', q, { customerId, includeEmpty: !hideEmpty })
        .then((r) => {
          if (!live) return;
          setRows(r);
          setActive(0);
        })
        .catch((err) => live && toast.error(err));
    }, 120);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [q, hideEmpty, customerId]);
  useEffect(() => {
    listRef.current?.querySelector('tr.sel')?.scrollIntoView({ block: 'nearest' });
  }, [active]);
  const current = rows[Math.min(active, rows.length - 1)];
  const noCreate = canCreate ? undefined : 'Réservé au gérant et au magasinier';
  return (
    <Modal title="Rechercher / Facturer des marchandises" onClose={onClose} wide>
      <div className="filters">
        <input
          className="search"
          autoFocus
          value={q}
          placeholder="Nom, code, autre réf. ou code-barres"
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              if (rows.length) setActive((i) => (i + (e.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length);
            } else if (e.key === 'Enter') {
              e.preventDefault();
              if (current) onPick(current);
            }
          }}
        />
        <label className="inline">
          <input type="checkbox" checked={hideEmpty} onChange={(e) => setHideEmpty(e.target.checked)} /> Masquer les lignes épuisées
        </label>
      </div>
      <div className="sale-search">
        <table className="list compact">
          <thead>
            <tr>
              <th>Code</th>
              <th>Réf.</th>
              <th>Produit</th>
              <th className="r">Stock</th>
              <th>Cond.</th>
              <th>Dépôt</th>
              <th className="r">PV TTC</th>
              <th className="r">Dernier prix</th>
            </tr>
          </thead>
          <tbody ref={listRef}>
            {rows.map((r, i) => (
              <tr key={rowKey(r)} className={`clickable ${i === active ? 'sel' : ''} ${r.out_of_stock ? 'inactive' : ''}`} onClick={() => setActive(i)} onDoubleClick={() => onPick(r)}>
                <td>{r.code}</td>
                <td className="muted">{r.other_ref ?? ''}</td>
                <td>{r.name}</td>
                <td className="r">{r.out_of_stock ? <span className="tag danger epuise">Épuisé</span> : stockIn(r)}</td>
                <td className="cond">{r.pack_name}</td>
                <td className="muted">{r.warehouse.toUpperCase()}</td>
                <td className="r b">{amount(r.price)}</td>
                <td className="r muted">{r.last_price === null ? '' : amount(r.last_price)}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={8} className="muted">
                  {q.trim() ? (hideEmpty ? 'Rien en stock. Décochez « Masquer les lignes épuisées ».' : 'Aucun article ne correspond.') : 'Tapez le début du nom.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="actions spread">
        <div className="inline">
          <button type="button" disabled={!canCreate} title={noCreate} onClick={() => onCreateArticle(q)}>
            Créer un article absent
          </button>
          <button type="button" disabled={!canCreate || !current} title={noCreate} onClick={() => current && onCreateLevel(current.article_id, 'top')}>
            Créer un conditionnement supérieur absent
          </button>
          <button type="button" disabled={!canCreate || !current} title={noCreate} onClick={() => {
              if (!current) return;
              // Le stock est compté dans l'unité de détail : elle ne change plus une fois l'article en stock.
              if (current.stock !== 0) return toast.error(`${current.name} est en stock : son unité de stock ne peut plus changer. Créez un nouvel article.`);
              onCreateLevel(current.article_id, 'bottom');
            }}>
            Créer un conditionnement inférieur absent
          </button>
        </div>
        <button type="button" className="primary" disabled={!current} onClick={() => current && onPick(current)}>
          Choisir <kbd>Entrée</kbd>
        </button>
      </div>
    </Modal>
  );
}

/**
 * Choix d'une ligne : la quantité est demandée tout de suite, et le prix peut
 * être changé (jamais sous le coût de revient du conditionnement). Un produit
 * épuisé, ou une quantité que le stock ne couvre pas, ne s'ajoute pas.
 */
export function QtyPrompt({
  row,
  initial,
  inCart,
  canPrice,
  onClose,
  onDone,
}: {
  row: SaleRow;
  initial?: string;
  /** Quantité de l'article déjà sur la fiche (unités de détail). */
  inCart: number;
  canPrice: boolean;
  onClose: () => void;
  onDone: (qtyMilli: number, price: number | null) => void;
}) {
  const piece = row.unit === 'piece';
  const [value, setValue] = useState(initial ?? (piece ? '1' : ''));
  const [priceText, setPriceText] = useState(String(row.price));
  const n = parseQty(value);
  const price = parseAmount(priceText);
  // À la pièce : un nombre entier de conditionnements. Au poids : la quantité saisie.
  const qtyOk = n !== null && (!piece || n % 1000 === 0);
  const wanted = qtyOk ? (piece ? (n! / 1000) * row.units : n!) : 0;
  const left = row.stock - inCart;
  const short = qtyOk && wanted > left;
  const belowCost = price !== null && price < row.cost;
  const priceOk = price !== null && price > 0 && !belowCost;
  const valid = qtyOk && priceOk && !short && !row.out_of_stock;
  const total = qtyOk && priceOk ? Math.round((price! * n!) / 1000) : null;
  return (
    <Modal title={row.name} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) onDone(wanted, price === row.price ? null : price);
        }}
      >
        <p className="qty-prompt-head">
          <span className="cond">{row.pack_name}</span> à <b>{fcfa(row.price)}</b>
          <span className="muted"> · stock {stockIn(row)}</span>
          {row.out_of_stock && <span className="tag danger epuise">Épuisé</span>}
        </p>
        {row.out_of_stock ? (
          <p className="danger-text">Stock épuisé : ce {row.pack_name.toLowerCase()} ne peut pas être vendu.</p>
        ) : (
          <div className="grid2">
            <Field label={`Quantité (${row.pack_name.toLowerCase()})`}>
              <input autoFocus inputMode="decimal" value={value} onFocus={(e) => e.target.select()} onChange={(e) => setValue(e.target.value)} />
            </Field>
            <Field label="Prix TTC" hint={canPrice ? `Pas moins de ${fcfa(row.cost)} (coût de revient)` : 'Prix du tarif'}>
              <input inputMode="numeric" value={priceText} disabled={!canPrice} onFocus={(e) => e.target.select()} onChange={(e) => setPriceText(e.target.value)} />
            </Field>
          </div>
        )}
        {n !== null && !qtyOk && <p className="danger-text">Nombre entier de {row.pack_name.toLowerCase()} uniquement</p>}
        {short && !row.out_of_stock && (
          <p className="danger-text">
            Stock insuffisant : il reste {piece && row.units > 1000 ? `${Math.max(0, Math.floor(left / row.units))} ${row.pack_name.toLowerCase()}` : stockIn({ ...row, stock: Math.max(0, left) })}
            {inCart > 0 ? ' en plus de ce qui est déjà sur la fiche' : ''}.
          </p>
        )}
        {belowCost && <p className="danger-text">Prix inférieur au coût de revient ({fcfa(row.cost)}).</p>}
        {total !== null && !row.out_of_stock && <p className="big-total">{fcfa(total)}</p>}
        <div className="actions">
          <button type="button" className="ghost" onClick={onClose}>
            {row.out_of_stock ? 'Fermer' : 'Annuler'}
          </button>
          {!row.out_of_stock && (
            <button type="submit" className="primary" disabled={!valid}>
              Ajouter <kbd>Entrée</kbd>
            </button>
          )}
        </div>
      </form>
    </Modal>
  );
}
