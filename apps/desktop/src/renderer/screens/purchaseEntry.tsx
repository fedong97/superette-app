import { purchaseAmounts } from '@superette/core';
import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { type Result, call } from '../api';
import { dateFr, fcfa, parseAmount, qty as qtyFmt, useCan, useLoad, useToast } from '../ui';
import { hasVat, tx } from '../tax';
import { ArticleForm } from './Articles';
import { PackUnitSelect, packChoices, purchaseUnits, switchUnits } from './packs';
import { ArticlePicker } from './pickers';
import { lineTerms } from './purchaseTerms';
import { type RecLine, newRecLine, recExtraCost } from './Stock';

type Article = Result<'catalogue.get'>;
type DiscType = NonNullable<RecLine['discType']>;

const DISC_TYPES: [DiscType, string][] = [
  ['pct', '%'],
  ['amount', 'FCFA'],
  ['promo', 'N/M'],
];

/** Nom du conditionnement saisi (« Carton », « Pièce », « kg »). */
function packName(a: Article, units: number): string {
  const c = packChoices(a).find((p) => p.units === units);
  if (c) return c.name;
  return a.unit === 'piece' ? a.unit_name || 'Pièce' : a.unit;
}

/** Écart actuel entre le prix de revient et le prix d'achat, ramené au conditionnement saisi. */
function usualExtra(a: Article, units: number): number {
  if (a.pack_cost_price === null || a.pack_purchase_price === null) return 0;
  return Math.max(0, Math.round(((a.pack_cost_price - a.pack_purchase_price) * units) / purchaseUnits(a)));
}

/** Prix de revient d'un conditionnement saisi : prix d'achat plus transport et manutention. */
function costPrice(l: RecLine): number {
  return (parseAmount(l.cost) ?? 0) + (recExtraCost(l) ?? usualExtra(l.article, l.packUnits));
}

/** Montant sans « FCFA » pour garder la liste étroite. */
const amt = (n: number) => fcfa(n).replace(/\s*FCFA$/, '');

function discText(l: RecLine): string {
  const type = l.discType ?? 'pct';
  if (type === 'amount') return l.discAmount?.trim() ? amt(parseAmount(l.discAmount) ?? 0) : '—';
  if (type === 'promo') return l.promo.trim() ? `Promo ${l.promo.trim()}` : '—';
  return l.disc.trim() ? `${l.disc.trim()} %` : '—';
}

const vatRate = (a: Article) => a.vat_rate_bp ?? 0;
const toTtc = (ht: string, a: Article) => {
  const v = parseAmount(ht);
  return v === null ? ht : String(Math.round((v * (10_000 + vatRate(a))) / 10_000));
};
const toHt = (ttc: string, a: Article) => {
  const v = parseAmount(ttc);
  return v === null ? ttc : String(Math.round((v * 10_000) / (10_000 + vatRate(a))));
};

/**
 * Saisie d'une facture d'achat ou d'une réception, ligne par ligne : à gauche
 * le panneau de l'article scanné (quantité, bonus, remise, prix, lot, date
 * limite), à droite la liste. Entrée passe au champ suivant et, sur le dernier,
 * fait descendre la ligne dans la liste ; un clic sur une ligne la remonte.
 */
export function PurchaseEntry({ lines, setLines, children }: { lines: RecLine[]; setLines: (l: RecLine[]) => void; children?: ReactNode }) {
  const toast = useToast();
  const can = useCan();
  const [draft, setDraft] = useState<RecLine | null>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [ttc, setTtc] = useState(false);
  const [ttcText, setTtcText] = useState('');
  const [sheet, setSheet] = useState<Article | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const fields = useRef<HTMLDivElement>(null);
  const vat = hasVat();
  const stock = useLoad(
    () => (draft ? call('stock.list', { search: draft.article.code }) : Promise.resolve([])),
    [draft?.article.id],
  );
  const inStock = draft ? stock.data?.find((r) => r.article_id === draft.article.id) : undefined;

  // Le curseur va dans Quantité à chaque nouvel article ou ligne reprise.
  useEffect(() => {
    if (!draft) return;
    const el = fields.current?.querySelector<HTMLInputElement>('[data-first]');
    el?.focus();
    el?.select();
  }, [draft?.article.id, editing]);

  const focusPicker = () => setTimeout(() => root.current?.querySelector<HTMLInputElement>('.picker input')?.focus(), 0);
  const patch = (p: Partial<RecLine>) => setDraft((d) => (d ? { ...d, ...p } : d));
  const load = (l: RecLine) => {
    setDraft(l);
    setTtcText(toTtc(l.cost, l.article));
  };

  /** Erreur de la ligne en cours, ou null quand elle peut descendre dans la liste. */
  const problem = (l: RecLine): string | null => {
    const t = lineTerms(l);
    if (typeof t === 'string') return t;
    if (l.article.perishable === 1 && !l.expiry) return `Date limite obligatoire pour « ${l.article.name} » (article périssable)`;
    return null;
  };

  const commit = (): boolean => {
    if (!draft) return true;
    const err = problem(draft);
    if (err) {
      toast.error(err);
      if (draft.article.perishable === 1 && !draft.expiry) fields.current?.querySelector<HTMLInputElement>('[data-expiry]')?.focus();
      return false;
    }
    if (editing !== null) setLines(lines.map((l, i) => (i === editing ? draft : l)));
    else setLines([...lines, draft]);
    setSelected(editing ?? lines.length);
    setDraft(null);
    setEditing(null);
    focusPicker();
    return true;
  };

  const cancel = () => {
    setDraft(null);
    setEditing(null);
    focusPicker();
  };

  const pick = (a: Article) => {
    // Un nouveau scan fait descendre la ligne en cours si elle est complète.
    if (draft && editing === null && !problem(draft)) setLines([...lines, draft]);
    else if (draft) return toast.error(`Terminez d'abord la ligne « ${draft.article.name} » (ou Échap pour l'abandonner)`);
    setEditing(null);
    load({ ...newRecLine(a), discType: 'pct' });
  };

  const edit = (i: number) => {
    const l = lines[i];
    if (!l) return;
    setSelected(i);
    setEditing(i);
    load({ ...l, discType: l.discType ?? (l.promo.trim() ? 'promo' : 'pct') });
  };

  const remove = (i: number) => {
    setLines(lines.filter((_, j) => j !== i));
    if (editing === i) cancel();
    setSelected(null);
  };

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      cancel();
      return;
    }
    if (e.key !== 'Enter') return;
    const target = e.target as HTMLElement;
    if (!['INPUT', 'SELECT'].includes(target.tagName)) return;
    e.preventDefault();
    const all = [...(fields.current?.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input:not([disabled]), select:not([disabled])') ?? [])];
    const i = all.indexOf(target as HTMLInputElement);
    const next = all[i + 1];
    if (i < 0 || !next) {
      commit();
      return;
    }
    next.focus();
    if (next instanceof HTMLInputElement) next.select();
  };

  const terms = draft ? lineTerms(draft) : null;
  const amounts =
    terms && typeof terms !== 'string' ? purchaseAmounts({ qty: terms.qty, unitCost: terms.unitCost, discountBp: terms.discountBp, freeQty: terms.freeQty }) : null;
  const type = draft?.discType ?? 'pct';
  const units = draft ? packName(draft.article, draft.packUnits).toLowerCase() : '';
  const usual = draft ? usualExtra(draft.article, draft.packUnits) : 0;
  const anyLot = lines.some((l) => l.lot || l.expiry);

  return (
    <div className="pe-split" ref={root}>
      <div className={`pe-side${editing !== null ? ' editing' : ''}`}>
        <ArticlePicker placeholder="Produit : scanner ou rechercher" onPick={pick} />
        {!draft && <p className="muted small">Scannez ou cherchez un article : sa fiche de saisie s'ouvre ici, puis Entrée le fait descendre dans la liste.</p>}
        {draft && (
          <div ref={fields} onKeyDown={onKey}>
            <h3 className="pe-title">
              {draft.article.name}
              {draft.article.perishable === 1 && <span className="pe-tag">périssable</span>}
              {editing !== null && <span className="pe-tag">Modification ligne {editing + 1}</span>}
            </h3>
            <p className="pe-info">
              Stock : {inStock ? inStock.in_packs || qtyFmt(inStock.qty, inStock.unit) : '…'}
              {draft.article.purchase_price > 0 && ` · dernier P.A ${fcfa(parseAmount(newRecLine(draft.article).cost) ?? 0)} / ${packName(draft.article, newRecLine(draft.article).packUnits).toLowerCase()}`}
            </p>
            <div className="pe-grid">
              <label className="field">
                <span>Conditionnement</span>
                {packChoices(draft.article).length ? (
                  <PackUnitSelect
                    choices={packChoices(draft.article)}
                    value={draft.packUnits}
                    onChange={(u) => {
                      const sw = switchUnits(draft.qty, draft.cost, draft.packUnits, u);
                      patch({ ...sw, packUnits: u });
                      setTtcText(toTtc(sw.cost, draft.article));
                    }}
                  />
                ) : (
                  <input value={packName(draft.article, draft.packUnits)} disabled />
                )}
              </label>
              <label className="field">
                <span>Quantité</span>
                <input data-first value={draft.qty} onChange={(e) => patch({ qty: e.target.value })} />
              </label>
              <label className="field">
                <span>Bonus (gratuits en plus)</span>
                <input value={draft.bonus ?? ''} placeholder="0" onChange={(e) => patch({ bonus: e.target.value })} />
              </label>
              <label className="field">
                <span>Remise</span>
                <div className="inline">
                  {type === 'promo' ? (
                    <input value={draft.promo} placeholder="12/10" title="N achetés, M payés" onChange={(e) => patch({ promo: e.target.value })} />
                  ) : type === 'amount' ? (
                    <input value={draft.discAmount ?? ''} placeholder="0" onChange={(e) => patch({ discAmount: e.target.value })} />
                  ) : (
                    <input value={draft.disc} placeholder="0" onChange={(e) => patch({ disc: e.target.value })} />
                  )}
                  <select value={type} title="Type de remise" onChange={(e) => patch({ discType: e.target.value as DiscType })}>
                    {DISC_TYPES.map(([k, label]) => (
                      <option key={k} value={k}>
                        {label}
                      </option>
                    ))}
                  </select>
                </div>
              </label>
            </div>
            {vat && (
              <div className="pe-seg">
                <button type="button" className={ttc ? '' : 'on'} onClick={() => setTtc(false)}>
                  Prix HT
                </button>
                <button
                  type="button"
                  className={ttc ? 'on' : ''}
                  onClick={() => {
                    setTtcText(toTtc(draft.cost, draft.article));
                    setTtc(true);
                  }}
                >
                  Prix TTC
                </button>
              </div>
            )}
            <div className="pe-grid">
              <label className="field">
                <span>{vat ? (ttc ? 'P.A TTC' : 'P.A HT') : "Prix d'achat"} / {units}</span>
                {ttc ? (
                  <input
                    value={ttcText}
                    onChange={(e) => {
                      setTtcText(e.target.value);
                      patch({ cost: toHt(e.target.value, draft.article) });
                    }}
                  />
                ) : (
                  <input value={draft.cost} onChange={(e) => patch({ cost: e.target.value })} />
                )}
              </label>
              <label className="field">
                <span>Transport / {units}</span>
                <input value={draft.transport ?? ''} placeholder={usual ? `écart actuel ${usual}` : '0'} onChange={(e) => patch({ transport: e.target.value })} />
              </label>
              <label className="field">
                <span>Manutention / {units}</span>
                <input value={draft.handling ?? ''} placeholder="0" onChange={(e) => patch({ handling: e.target.value })} />
              </label>
              <label className="field">
                <span>N° de lot</span>
                <input value={draft.lot} onChange={(e) => patch({ lot: e.target.value })} />
              </label>
            </div>
            <div className="pe-cost">
              <span>Prix de revient / {units}</span>
              <b>{fcfa(costPrice(draft))}</b>
            </div>
            {draft.article.perishable === 1 && (
              <label className="field">
                <span>Périme le (obligatoire)</span>
                <input data-expiry type="date" className={draft.expiry ? '' : 'pe-required'} value={draft.expiry} onChange={(e) => patch({ expiry: e.target.value })} />
              </label>
            )}
            <div className="pe-net">
              <small>
                {amounts
                  ? [`brut ${fcfa(amounts.gross)}`, amounts.free > 0 && `gratuits −${fcfa(amounts.free)}`, amounts.discount > 0 && `remise −${fcfa(amounts.discount)}`]
                      .filter(Boolean)
                      .join(' · ')
                  : typeof terms === 'string'
                    ? terms
                    : ''}
              </small>
              <b>{fcfa(amounts?.net ?? 0)}</b>
            </div>
            {editing !== null ? (
              <div className="pe-buttons">
                <button onClick={cancel}>Annuler</button>
                <button className="primary" onClick={() => commit()}>
                  Enregistrer la ligne
                </button>
              </div>
            ) : (
              <div className="pe-buttons">
                <button onClick={cancel}>Vider</button>
                <button className="primary" onClick={() => commit()}>
                  Ajouter dans la liste ↵
                </button>
              </div>
            )}
            <p className="pe-hint">
              <kbd>Entrée</kbd> champ suivant · <kbd>Entrée</kbd> sur le dernier champ ajoute · <kbd>Échap</kbd> abandonne
            </p>
          </div>
        )}
      </div>
      <div className="pe-main">
        <div className="pe-toolbar">
          <button disabled={selected === null || !lines[selected]} onClick={() => selected !== null && edit(selected)}>
            ✎ Éditer la ligne
          </button>
          <button disabled={selected === null || !lines[selected]} onClick={() => selected !== null && remove(selected)}>
            ✕ Enlever de la liste
          </button>
          <button disabled={selected === null || !lines[selected]} onClick={() => selected !== null && lines[selected] && setSheet(lines[selected]!.article)}>
            Fiche de l'article
          </button>
          <span className="muted">
            {lines.length} ligne{lines.length > 1 ? 's' : ''}
          </span>
        </div>
        <div className="pe-scroll">
        <table className="list pe-table">
          <thead>
            <tr>
              <th>N°</th>
              <th>Réf.</th>
              <th>Produit</th>
              <th className="r">Qté</th>
              <th>Cond.</th>
              <th className="r">Bonus</th>
              <th className="r">Remise</th>
              <th className="r">{tx('P.A HT')}</th>
              <th className="r">Transp. + manut.</th>
              <th className="r">P. revient</th>
              {anyLot && <th>Lot</th>}
              {anyLot && <th>Périme le</th>}
              <th className="r">Montant</th>
            </tr>
          </thead>
          <tbody>
            {lines.length === 0 && (
              <tr>
                <td colSpan={anyLot ? 13 : 11} className="muted">
                  Aucune ligne : les articles saisis à gauche descendent ici.
                </td>
              </tr>
            )}
            {lines.map((l, i) => {
              const extra = recExtraCost(l);
              return (
                <tr
                  key={i}
                  className={`clickable${selected === i ? ' selected' : ''}${editing === i ? ' editing' : ''}`}
                  onClick={() => (draft && editing === null ? setSelected(i) : edit(i))}
                  onDoubleClick={() => edit(i)}
                >
                  <td>{i + 1}</td>
                  <td className="muted">{l.article.code}</td>
                  <td>
                    {l.article.name}
                    {l.article.perishable === 1 && <span className="pe-pill">périssable</span>}
                  </td>
                  <td className="r">{l.qty}</td>
                  <td>{packName(l.article, l.packUnits)}</td>
                  <td className="r">{l.bonus?.trim() || '—'}</td>
                  <td className="r">{discText(l)}</td>
                  <td className="r">{amt(parseAmount(l.cost) ?? 0)}</td>
                  <td className="r">{extra !== undefined ? amt(extra) : '—'}</td>
                  <td className="r">{amt(costPrice(l))}</td>
                  {anyLot && <td>{l.lot || '—'}</td>}
                  {anyLot && <td>{l.expiry ? dateFr(l.expiry) : '—'}</td>}
                  <td className="r">{amt(lineNetOf(l))}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        </div>
        {children}
      </div>
      {sheet && (
        <ArticleForm
          article={sheet}
          canSetStorePrice={can('store_price')}
          onClose={() => setSheet(null)}
          onSaved={(a) => {
            setSheet(null);
            setLines(lines.map((l) => (l.article.id === a.id ? { ...l, article: a } : l)));
          }}
        />
      )}
    </div>
  );
}

function lineNetOf(l: RecLine): number {
  const t = lineTerms(l);
  return typeof t === 'string' ? 0 : t.net;
}
