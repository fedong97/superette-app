import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type CartLine, type Permission, type Tariff, PAYMENT_METHODS, PRICE_LEVELS, applyPromotions, computeTotals, formatFcfa, lineTotal, roundCash, tariffPrice } from '@superette/core';
import { type ApiError, type Result, call } from '../api';
import { Empty, Field, Modal, SupervisorPrompt, fcfa, parseAmount, parseQty, qty, useLoad, useStoreSettings, useToast, has } from '../ui';
import { type Customer, CustomerPaymentDialog, CustomerPickDialog } from './customerDialogs';
import { ExpenseDialog } from './Expenses';
import { Statement } from './Customers';
import { QuotePickDialog } from './Quotes';
import { ArticleForm } from './Articles';
import { QtyPrompt, type SaleRow, SaleSearchDialog, rowKey, stockIn, useSaleRows } from './SaleSearch';
import { CancelDialog, CashOpDialog, HeldDialog, PaymentDialog, ReturnDialog } from './PosDialogs';
import { tx } from '../tax';

type Article = Result<'catalogue.get'>;
type User = NonNullable<Result<'app.state'>['user']>;

interface PosPack {
  id: string;
  name: string;
  units: number;
  tariff: Tariff;
}

export interface PosLine extends CartLine {
  key: number;
  ref: string;
  unit: Article['unit'];
  unitName: string;
  barcode: string | null;
  /** Tarifs de l'unité et des conditionnements : le prix suit le tarif du client (détail, gros). */
  tariff: Tariff;
  packs: PosPack[];
  /** Conditionnement vendu (carton, paquet), sinon l'unité de détail. */
  packId: string | null;
  /** Prix saisi à la caisse pour ce conditionnement (sinon le tarif du client). */
  price?: number;
}

let keySeq = 0;

function toLine(article: Article, qtyMilli: number, barcode: string | null, fixedAmount?: number, packId?: string | null, price?: number): PosLine {
  const packs = article.packs.map((p) => ({ id: p.id, name: p.name, units: p.units, tariff: { retail: p.sale_price, wholesale: p.wholesale_price, superWholesale: p.super_wholesale_price } }));
  const pack = packId ? packs.find((p) => p.id === packId) : undefined;
  return {
    key: ++keySeq,
    ref: article.code,
    articleId: article.id,
    label: article.name,
    unit: article.unit,
    unitName: article.unit_name ?? UNIT_LABEL[article.unit],
    unitPrice: article.store_price,
    qty: qtyMilli,
    vatRate: article.vat_rate_bp,
    discount: 0,
    fixedAmount,
    barcode,
    tariff: { retail: article.store_price, wholesale: article.wholesale_price, superWholesale: article.super_wholesale_price },
    packs,
    packId: pack?.id ?? null,
    ...(pack ? { packPrice: pack.tariff.retail, packUnits: pack.units } : {}),
    ...(price !== undefined ? { price } : {}),
  };
}

/** Prix de la ligne au tarif du client (le conditionnement garde son propre prix), ou prix saisi à la caisse. */
function atLevel(l: PosLine, level: Parameters<typeof tariffPrice>[1]): PosLine {
  const pack = l.packId ? l.packs.find((p) => p.id === l.packId) : undefined;
  return {
    ...l,
    unitPrice: !pack && l.price !== undefined ? l.price : tariffPrice(l.tariff, level),
    packPrice: pack ? (l.price ?? tariffPrice(pack.tariff, level)) : undefined,
    packUnits: pack?.units,
    priceSet: l.price !== undefined,
  };
}

/** Quantité affichée : « 2 Carton » pour une vente par conditionnement. */
function lineQty(l: PosLine): string {
  const pack = l.packId ? l.packs.find((p) => p.id === l.packId) : undefined;
  return pack ? `${l.qty / pack.units}` : qty(l.qty, l.unit);
}

type Dialog = null | 'pay' | 'close' | 'held' | 'statement' | 'cancel' | 'return' | 'cashIn' | 'cashOut' | 'search' | 'qty' | 'create' | 'weight' | 'discount' | 'vary' | 'customer' | 'custPay' | 'expense' | 'quote';
type SellPayments = { method: 'CASH' | 'CUSTOMER_CREDIT' | Result<'pos.sell'>['payments'][number]['method']; amount: number; reference?: string }[];
type Pane = 'lines' | 'payments' | 'extra';

const UNIT_LABEL = { piece: 'Pièce', kg: 'Kg', litre: 'Litre' } as const;
const BILLS = [1000, 2000, 5000, 10000];
const amount = (v: number) => formatFcfa(v, false);
/** Deux lettres pour la tuile d'un produit sans photo : « Bière Castel » → « BC ». */
const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter((w) => /^[\p{L}\d]/u.test(w))
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('');
const TILE_COLORS = ['#1f7a5c', '#e0a800', '#0891b2', '#db2777', '#7c3aed', '#22a06b', '#2563eb', '#ea580c'];
/** Couleur stable par produit (le nom donne toujours la même). */
const tileColor = (name: string) => {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return { '--c': TILE_COLORS[h % TILE_COLORS.length] } as React.CSSProperties;
};

/**
 * Fiche de facturation (vente au comptant ou à crédit), pensée pour le tactile :
 * recherche avec les produits en tuiles, ticket à droite (client, lignes,
 * total, reçu et rendu), billets rapides et gros boutons d'action en bas.
 * Tous les raccourcis clavier restent actifs.
 * Plusieurs fiches peuvent être ouvertes en même temps (Caisse 1, Caisse 2).
 */
export function Pos({ user, hasRegister, registerId = null, canChooseRegister = false, onRegisterChosen, vatEnabled = true, ignoreStock = false, active, title, onClose, onSwitchMode, onListing, onTreasury, mode = 'cash' }: {
  mode?: 'cash' | 'credit';
  user: User;
  hasRegister: boolean;
  /** Caisse de travail : la journée affichée se recharge quand elle change. */
  registerId?: string | null;
  /** Gérant ou administrateur sans caisse attribuée : il choisit la caisse sur laquelle il vend. */
  canChooseRegister?: boolean;
  onRegisterChosen?: () => void;
  /** Magasin assujetti à la TVA (sinon « Taxes ? » est masqué). */
  vatEnabled?: boolean;
  /** « Ignorer la gestion des stocks » : on vend même si le stock affiché est épuisé. */
  ignoreStock?: boolean;
  active: boolean;
  title: string;
  onClose: () => void;
  /** Passe de la vente au comptant à la vente à crédit (et inversement). */
  onSwitchMode?: () => void;
  onListing: () => void;
  /** Ouvre Trésorerie › Opérations de trésorerie (ouverture et clôture). */
  onTreasury: () => void;
}) {
  const toast = useToast();
  const session = useLoad(() => call('pos.session'), []);
  const quickKeys = useLoad(() => call('catalogue.quickKeys'), []);
  const warehouses = useLoad(() => call('admin.warehouses'), []);
  const [lines, setLines] = useState<PosLine[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [input, setInput] = useState('');
  const [dialog, setDialog] = useState<Dialog>(null);
  const [pane, setPane] = useState<Pane>('lines');
  const [cashGiven, setCashGiven] = useState(0);
  const [showTaxes, setShowTaxes] = useState(false);
  const [now, setNow] = useState(() => new Date());
  /** Recherche complète (F1) et ligne choisie dont on demande la quantité. */
  const [searchQuery, setSearchQuery] = useState('');
  const [picked, setPicked] = useState<{ row: SaleRow; initial?: string } | null>(null);
  /** Fiche article ouverte depuis la recherche : article absent, ou conditionnement à ajouter. */
  const [creating, setCreating] = useState<{ article: Article | null; name?: string; addLevel?: 'top' | 'bottom' } | null>(null);
  const canCreate = has(user, 'article_create') || has(user, 'sale_new_article');
  const settings = useStoreSettings();
  const can = (p: Permission) => has(user, p);
  const [weightFor, setWeightFor] = useState<Article | null>(null);
  const [lastSale, setLastSale] = useState<Result<'pos.sell'> | null>(null);
  const [customer, setCustomer] = useState<Customer | null>(null);
  /** Nom donné par un client comptoir (facultatif), imprimé sur le ticket et la facture. */
  const [clientName, setClientName] = useState('');
  /** Devis ou proforma chargé : ses prix garantis valent accord de remise. */
  const [quote, setQuote] = useState<{ id: string; number: string; validUntil: string } | null>(null);
  const account = useLoad(() => (customer ? call('customers.account', customer.id) : Promise.resolve(null)), [customer?.id]);
  // Tickets en attente sur cette caisse : leur nombre s'affiche sur le bouton « Ouvrir ».
  const held = useLoad(() => call('pos.held'), []);
  // Clients existants proposés pendant la frappe du nom (évite les doublons).
  const namesake = useLoad(() => (clientName.trim().length >= 2 ? call('customers.list', { search: clientName.trim() }) : Promise.resolve([])), [clientName]);
  /** Vente bloquée en attente du code gérant (remise ou dépassement du plafond). */
  const [pending, setPending] = useState<{ payments: SellPayments; supervisorPin?: string; reason: 'discount' | 'credit'; message: string } | null>(null);
  const credit = mode === 'credit';
  const scanRef = useRef<HTMLInputElement>(null);
  /** Promotions du jour : appliquées à l'écran comme elles le seront à l'encaissement. */
  const promoRules = useLoad(() => call('promotions.active'), []);
  const level = customer?.price_level ?? 'retail';
  const priced = useMemo(
    () => applyPromotions(lines.map((l) => atLevel(l, level)), level === 'retail' ? (promoRules.data ?? []) : []),
    [lines, promoRules.data, level],
  );
  const totals = useMemo(() => computeTotals(priced), [priced]);
  /** Total à payer si tout est réglé en espèces (arrondi des paramètres). */
  const cashDue = roundCash(totals.totalTtc, settings.cashRounding);
  // Une remise sous le maximum des paramètres passe sans le code du gérant.
  const underMax = settings.maxDiscountPct > 0 && totals.totalDiscount * 100 <= settings.maxDiscountPct * (totals.totalTtc + totals.totalDiscount);
  const discountNeedsCode = totals.totalDiscount > 0 && !has(user, 'discount') && !underMax;

  const focusScan = useCallback(() => setTimeout(() => scanRef.current?.focus(), 0), []);
  useEffect(() => {
    if (!dialog && active) focusScan();
  }, [dialog, active, focusScan]);
  useEffect(() => {
    if (active) {
      session.reload();
      promoRules.reload();
    }
  }, [active, registerId]);
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  const addLine = (line: PosLine) => {
    setLines((ls) => {
      // Même article (et même conditionnement) à la pièce sans remise : on cumule la quantité.
      const same =
        line.fixedAmount === undefined && line.unit === 'piece'
          ? ls.find((l) => l.articleId === line.articleId && l.packId === line.packId && l.price === line.price && !l.discount && l.fixedAmount === undefined)
          : undefined;
      if (same) {
        setSelected(same.key);
        return ls.map((l) => (l === same ? { ...l, qty: l.qty + line.qty } : l));
      }
      setSelected(line.key);
      return [...ls, line];
    });
    setLastSale(null);
    setPane('lines');
  };

  const addArticle = (article: Article, multiplier = 1000) => {
    if (article.unit !== 'piece' && multiplier === 1000) {
      setWeightFor(article);
      setDialog('weight');
      return;
    }
    addLine(toLine(article, multiplier, null));
  };

  // « 3*mut » : lignes sur « mut », la quantité proposée est 3.
  const multiplied = /^(\d+(?:[.,]\d+)?)\*(.*)$/.exec(input.trim());
  const suggestQuery = multiplied ? multiplied[2]! : input;
  const suggestions = useSaleRows(suggestQuery, customer?.id ?? null);
  /** Une ligne choisie (conditionnement d'un article) : on demande d'abord la quantité. */
  const askQty = (row: SaleRow, initial?: string) => {
    setPicked({ row, initial });
    setDialog('qty');
  };
  const pickSuggestion = (row: SaleRow) => {
    const mult = multiplied?.[1];
    setInput('');
    askQty(row, mult);
  };
  const addRow = async (row: SaleRow, q: number, price: number | null) => {
    try {
      const article = await call('catalogue.get', row.article_id);
      addLine(toLine(article, q, null, undefined, row.pack_id, price ?? undefined));
    } catch (err) {
      toast.error(err);
    }
  };
  const openSearch = (q: string) => {
    setSearchQuery(q);
    setDialog('search');
  };

  const onScan = async (e: React.FormEvent) => {
    e.preventDefault();
    const raw = input.trim();
    if (!raw) {
      if (lines.length) void validate();
      return;
    }
    setInput('');
    // « 3*code » : multiplie la quantité scannée.
    const m = /^(\d+(?:[.,]\d+)?)\*(.*)$/.exec(raw);
    const mult = m ? parseQty(m[1]!) : null;
    const code = m ? m[2]!.trim() : raw;
    try {
      const hit = await call('catalogue.scan', code);
      if (hit) {
        if (hit.fixedAmount !== undefined || hit.article.unit === 'piece' || hit.qty !== 1000) {
          // « 3*code du carton » = 3 cartons ; un multiplicateur décimal n'a pas de sens pour un carton.
          const q = mult ? (hit.pack ? Math.max(1, Math.round(mult / 1000)) * hit.qty : Math.round((hit.qty * mult) / 1000)) : hit.qty;
          addLine(toLine(hit.article, q, hit.barcode, hit.fixedAmount, hit.pack?.id));
        } else {
          addArticle(hit.article, mult ?? 1000);
        }
        return;
      }
      // Pas un code-barres : une seule ligne en stock → quantité, sinon la recherche complète.
      const rows = /^[\d\s]+$/.test(code) ? [] : await call('pos.search', code, { customerId: customer?.id ?? null });
      if (rows.length === 1) askQty(rows[0]!, m?.[1]);
      else openSearch(code);
    } catch (err) {
      toast.error(err);
    }
  };

  const changeQty = (key: number, delta: number) =>
    setLines((ls) =>
      ls.map((l) => {
        if (l.key !== key || l.fixedAmount !== undefined) return l;
        // Un carton de plus (ou de moins) pour une ligne vendue au carton.
        const step = l.packId ? (l.packs.find((p) => p.id === l.packId)?.units ?? 1000) : 1000;
        return { ...l, qty: Math.max(step, l.qty + Math.sign(delta) * Math.max(Math.abs(delta), step)) };
      }),
    );
  const removeLine = (key: number) => {
    setLines((ls) => ls.filter((l) => l.key !== key));
    setSelected(null);
  };
  const clear = () => {
    setQuote(null);
    setClientName('');
    setLines([]);
    setCashGiven(0);
    setSelected(null);
  };

  const saleInput = () => lines.map((l) => ({ articleId: l.articleId, qty: l.qty, barcode: l.barcode, discount: l.discount, packId: l.packId, price: l.price ?? null }));
  /** Lignes rechargées (ticket en attente, devis) : on reprend les fiches pour les tarifs et conditionnements. */
  const reload = async (input: { articleId: string; qty: number; barcode?: string | null; discount?: number; packId?: string | null; price?: number | null }[]) => {
    const priced = await call('pos.priceLines', input);
    const arts = await Promise.all(priced.map((p) => call('catalogue.get', p.articleId)));
    return priced.map((p, i) => ({ ...toLine(arts[i]!, p.qty, p.barcode, p.fixedAmount, p.packId, p.priceSet ? (p.packPrice ?? p.unitPrice) : undefined), discount: p.discount }));
  };

  const finish = (sale: Result<'pos.sell'>) => {
    setLines([]);
    setSelected(null);
    setLastSale(sale);
    setDialog(null);
    setCustomer(null);
    setClientName('');
    setQuote(null);
    call('pos.printTicket', sale.id, { newSale: true }).catch((err) => toast.error(err));
  };

  /**
   * Envoie la vente ; si le serveur demande l'accord d'un gérant (remise d'un
   * caissier, plafond de crédit dépassé), on demande son code puis on relance.
   */
  const sell = async (payments: SellPayments, pins: { supervisorPin?: string; creditPin?: string } = {}) => {
    try {
      finish(await call('pos.sell', { lines: saleInput(), payments: payments as never, customerId: customer?.id ?? null, clientName: customer ? null : clientName.trim() || null, quoteId: quote?.id ?? null, ...pins }));
      setCashGiven(0);
      setPending(null);
    } catch (err) {
      const code = (err as ApiError).code;
      if (code === 'CREDIT_LIMIT' && !pins.creditPin) setPending({ payments, supervisorPin: pins.supervisorPin, reason: 'credit', message: (err as Error).message });
      else if (code === 'SUPERVISOR_REQUIRED' && !pins.supervisorPin) setPending({ payments, reason: 'discount', message: 'Le ticket comporte une remise.' });
      else toast.error(err);
    }
  };

  const printA4 = () => {
    if (lastSale) call('pos.printInvoice', lastSale.id).catch(toast.error);
    else toast.error('Aucune facture à imprimer');
  };

  /**
   * Valider (F4). Au comptant : en espèces si l'encaissé couvre le total, sinon
   * choix du règlement. À crédit : l'encaissé est un acompte, le reste va au
   * compte du client.
   */
  const validate = async () => {
    if (!lines.length) return;
    if (credit) {
      if (!customer) {
        toast.error('Choisissez le client de la vente à crédit');
        setDialog('customer');
        return;
      }
      const deposit = Math.min(cashGiven, totals.totalTtc);
      const payments: SellPayments = cashGiven >= totals.totalTtc ? [{ method: 'CASH', amount: cashGiven }] : [];
      if (!payments.length) {
        if (deposit > 0) payments.push({ method: 'CASH', amount: deposit });
        payments.push({ method: 'CUSTOMER_CREDIT', amount: totals.totalTtc - deposit });
      }
      await sell(payments);
      return;
    }
    const needsSupervisor = discountNeedsCode && !quote;
    // Payé tout en espèces : le total descend à l'arrondi réglé dans les paramètres.
    if (cashGiven >= cashDue && !needsSupervisor) {
      await sell([{ method: 'CASH', amount: cashGiven }]);
      return;
    }
    setDialog('pay');
  };

  const hold = async () => {
    if (!lines.length || !can('sale_hold')) return;
    const label = `Ticket de ${new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })} (${fcfa(totals.totalTtc)})`;
    try {
      await call('pos.hold', label, saleInput());
      clear();
      held.reload();
      toast.ok('Ticket mis en attente');
    } catch (err) {
      toast.error(err);
    }
  };

  const resume = async (id: string) => {
    try {
      setLines(await reload(await call('pos.resume', id)));
      setDialog(null);
      held.reload();
    } catch (err) {
      toast.error(err);
    }
  };

  /** Charge un devis : ses lignes aux prix garantis et son client. */
  const loadQuote = async (id: string) => {
    if (lines.length) return toast.error('Terminez ou mettez en attente le ticket en cours');
    try {
      const q = await call('quotes.get', id);
      setLines(await reload(await call('quotes.saleLines', id)));
      setCustomer(q.customer_id ? await call('customers.get', q.customer_id) : null);
      setQuote({ id: q.id, number: q.number, validUntil: q.valid_until });
      setLastSale(null);
      setDialog(null);
      toast.ok(`${q.number} chargé${q.customer_id ? '' : ` (client : ${q.customer_name})`}`);
    } catch (err) {
      toast.error(err);
    }
  };

  const reprint = () => {
    if (!can('sale_reprint')) return toast.error("Vous n'avez pas le droit de réimprimer un ticket");
    if (lastSale) call('pos.printTicket', lastSale.id).catch(toast.error);
    else toast.error('Aucun ticket à réimprimer');
  };

  const openDrawer = () => {
    if (!can('drawer_open')) return toast.error("Vous n'avez pas le droit d'ouvrir le tiroir sans vente");
    call('pos.openDrawer').then(() => toast.ok('Tiroir ouvert'), toast.error);
  };

  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (dialog) return;
      const fn: Record<string, () => void> = {
        F1: () => openSearch(input),
        F2: reprint,
        F3: () => void hold(),
        F4: () => void validate(),
        F5: openDrawer,
        F6: () => selected !== null && setDialog('discount'),
        F7: onListing,
        F8: () => setDialog('customer'),
        F9: printA4,
        F10: () => can('sale_resume') && setDialog('held'),
      };
      if (fn[e.key]) {
        e.preventDefault();
        fn[e.key]!();
      } else if (e.ctrlKey && e.key.toLowerCase() === 'e' && lines.length) {
        e.preventDefault();
        setDialog('pay');
      } else if (e.target instanceof HTMLInputElement && e.target !== scanRef.current) {
        // Saisie dans une cellule (quantité) : les touches gardent leur sens.
      } else if (e.key === 'Delete' && selected !== null && !input) {
        removeLine(selected);
      } else if ((e.key === '+' || e.key === '-') && selected !== null && !input) {
        e.preventDefault();
        changeQty(selected, e.key === '+' ? 1000 : -1000);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (!hasRegister)
    return canChooseRegister ? (
      <div className="center-page">
        <div className="card closed-register">
          <h2>Sur quelle caisse vendez-vous ?</h2>
          <p>Aucune caisse ne vous est attribuée : choisissez celle de ce comptoir.</p>
          <RegisterChooser current={null} onChosen={() => onRegisterChosen?.()} />
        </div>
      </div>
    ) : (
      <Empty>Aucune caisse ne vous est attribuée. Demandez à l'administrateur de vous en attribuer une dans Administration › Utilisateurs.</Empty>
    );
  if (!session.data) return session.data === null ? <ClosedRegister canOpen={has(user, 'treasury')} onTreasury={onTreasury} onReload={session.reload} /> : null;
  const stale = localDay(session.data.opened_at) !== localDay(now.toISOString());

  const sel = lines.find((l) => l.key === selected);
  const salesWarehouse = (warehouses.data ?? []).find((w) => w.is_sales_default) ?? warehouses.data?.[0];
  const shownTotal = lines.length ? totals.totalTtc : (lastSale?.total_ttc ?? 0);
  const change = lines.length ? Math.max(0, cashGiven - cashDue) : (lastSale?.change_given ?? 0);
  // Après validation : espèces réellement reçues (rien pour une vente entièrement à crédit).
  const given = lines.length ? cashGiven : lastSale ? lastSale.payments.filter((p) => p.method === 'CASH').reduce((t, p) => t + p.amount, 0) : 0;

  return (
    <div className={`pos-screen ${credit ? 'credit' : ''}`}>
      {stale && (
        <div className="tre-warning">
          Cette caisse est ouverte depuis le {new Date(session.data.opened_at).toLocaleDateString('fr-FR')} : clôturez la journée précédente dans{' '}
          <button className="link" onClick={onTreasury}>
            Trésorerie
          </button>{' '}
          puis rouvrez la caisse.
        </div>
      )}
      <div className="pos-body">
        <section className="pos-shop">
          <form onSubmit={onScan} className="pos-search">
            <div className="scan-wrap">
              <span className="scan-icon" aria-hidden>
                🔍
              </span>
              <input
                ref={scanRef}
                className="scan-input"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => suggestions.onKeyDown(e, pickSuggestion)}
                onBlur={suggestions.close}
                autoComplete="off"
                placeholder="Nom du produit ou code-barres (3*code pour la quantité)"
              />
              <button type="button" className="scan-hint" title="Recherche complète (F1)" onClick={() => openSearch(input)}>
                Rechercher <kbd>F1</kbd>
              </button>
            </div>
            <button type="submit" className="scan-go" title="Ajouter (Entrée) ; sur une saisie vide, valider la fiche">
              ▥
            </button>
          </form>
          <div className="pos-opts">
            <label className="opt" title="Le tarif suit la fiche du client (Client › Tarif) : détail pour le client comptoir">
              Tarif
              <select value={level} disabled>
                {Object.entries(PRICE_LEVELS).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </label>
            <label className="opt" title="La vente sort du dépôt « surface de vente » du magasin">
              Dépôt
              <select value={salesWarehouse?.id ?? ''} disabled>
                {salesWarehouse && <option value={salesWarehouse.id}>{salesWarehouse.name}</option>}
              </select>
            </label>
            <select
              className="opt action"
              value=""
              onChange={(e) => {
                const v = e.target.value as Dialog | 'close';
                if (v === 'close') {
                  if (lines.length) return toast.error('Terminez ou mettez en attente le ticket en cours');
                  return onTreasury();
                }
                setDialog(v);
              }}
            >
              <option value="" disabled>
                ⋯ Actions
              </option>
              <option value="cashIn">Apport espèces</option>
              <option value="cashOut">Prélèvement</option>
              <option value="cancel">Annuler un ticket</option>
              <option value="return">Retour client</option>
              <option value="custPay">Règlement client (crédit)</option>
              <option value="quote">Facturer un devis / proforma</option>
              <option value="expense">Dépense payée en caisse</option>
              <option value="close">Clôture de caisse (Trésorerie)</option>
            </select>
            <span className="opts-count">
              {suggestions.items.length
                ? `${suggestions.items.length} produit${suggestions.items.length > 1 ? 's' : ''} trouvé${suggestions.items.length > 1 ? 's' : ''} · touchez pour ajouter`
                : quickKeys.data?.length
                  ? 'Touches rapides'
                  : ''}
            </span>
          </div>
          <div className="pos-tiles">
            {suggestions.items.length > 0
              ? suggestions.items.map((r, i) => (
                  <button
                    type="button"
                    key={rowKey(r)}
                    className={`pos-tile ${i === suggestions.active ? 'hit' : ''} ${r.out_of_stock ? 'out' : r.stock < r.units * 5 ? 'low' : ''}`}
                    style={tileColor(r.name)}
                    // mousedown : choisir avant que la zone de saisie perde le focus.
                    onMouseDown={(e) => {
                      e.preventDefault();
                      pickSuggestion(r);
                    }}
                    onMouseEnter={() => suggestions.setActive(i)}
                  >
                    <span className="tile-ic">{initials(r.name)}</span>
                    <b>{r.name}</b>
                    <small className="tile-pack">
                      {r.code}
                      {r.pack_name ? ` · ${r.pack_name}` : ''}
                    </small>
                    <span className="tile-p">
                      <strong>{amount(r.price)}</strong>
                      <small>{r.out_of_stock ? 'épuisé' : `stock ${stockIn(r)}`}</small>
                    </span>
                  </button>
                ))
              : (quickKeys.data ?? []).map((a) => (
                  <button type="button" key={a.id} className="pos-tile" style={tileColor(a.name)} onClick={() => addArticle(a)}>
                    {a.photo_thumb ? <img className="tile-ph" src={a.photo_thumb} alt="" /> : <span className="tile-ic">{initials(a.name)}</span>}
                    <b>{a.name}</b>
                    <span className="tile-p">
                      <strong>{amount(a.store_price)}</strong>
                      <small>{a.unit !== 'piece' ? `le ${a.unit === 'kg' ? 'kg' : 'litre'}` : ''}</small>
                    </span>
                  </button>
                ))}
            {!suggestions.items.length && !quickKeys.data?.length && (
              <p className="tiles-empty">Tapez le début du nom d'un produit ou scannez son code-barres : les produits trouvés s'affichent ici en tuiles.</p>
            )}
          </div>
          <div className="pos-bills">
            {BILLS.map((b) => (
              <button key={b} type="button" disabled={!lines.length} onClick={() => setCashGiven((c) => c + b)}>
                <small>BILLET</small>
                {amount(b)}
              </button>
            ))}
            <button type="button" className="x" disabled={!lines.length} onClick={() => setCashGiven(cashDue)} title="Montant exact (arrondi espèces compris)">
              = Exact
            </button>
            <button type="button" className="x" disabled={!cashGiven} onClick={() => setCashGiven(0)} title="Remettre l'encaissé à zéro">
              C Effacer
            </button>
          </div>
        </section>

        <aside className="pos-ticket">
          <div className="tk-head">
            <div className="tk-row">
              <button className={`tk-client ${credit && !customer ? 'missing' : ''}`} title="Choisir le client (F8)" onClick={() => setDialog('customer')}>
                <i aria-hidden>👤</i>
                <span>
                  <b>{customer ? customer.name : credit ? 'Choisir le client' : 'Client comptoir'}</b>
                  <small>
                    {customer && account.data
                      ? `${account.data.balance > 0 ? 'Doit' : account.data.balance < 0 ? 'Avoir' : 'Solde'} ${amount(Math.abs(account.data.balance))} FCFA${credit ? ` · disponible ${amount(account.data.available)}` : ''}`
                      : credit
                        ? 'obligatoire pour une vente à crédit'
                        : 'touchez pour choisir un client'}
                  </small>
                </span>
                <kbd>F8</kbd>
              </button>
              <div className="tk-mode" role="group" aria-label="Type de vente">
                <button className={credit ? '' : 'on'} disabled={!credit} onClick={() => (lines.length ? toast.error('Terminez ou mettez en attente la fiche en cours') : onSwitchMode?.())}>
                  Comptant
                </button>
                <button className={credit ? 'on' : ''} disabled={credit} onClick={() => (lines.length ? toast.error('Terminez ou mettez en attente la fiche en cours') : onSwitchMode?.())}>
                  Crédit
                </button>
              </div>
            </div>
            {(customer || level !== 'retail') && (
              <div className="tk-row tk-chips">
                {level !== 'retail' && (
                  <span className="tag surstock" title="Prix de gros appliqués à ce client">
                    Tarif {PRICE_LEVELS[level].toLowerCase()}
                  </span>
                )}
                {customer && (
                  <>
                    <button className="chip-btn" title="Extrait de compte du client" onClick={() => setDialog('statement')}>
                      Extrait de compte
                    </button>
                    <button className="chip-btn" title="Revenir au client comptoir" onClick={() => setCustomer(null)}>
                      ✕ {customer.code}
                    </button>
                  </>
                )}
              </div>
            )}
            {!customer && !credit && (
              <div className="tk-name">
                <input
                  value={clientName}
                  maxLength={80}
                  onChange={(e) => setClientName(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && scanRef.current?.focus()}
                  placeholder="Nom du client sur le ticket (facultatif)"
                  title="Imprimé sur le ticket et la facture"
                />
                {(namesake.data?.length ?? 0) > 0 && (
                  <div className="namesake">
                    <small>Client déjà enregistré ?</small>
                    {namesake.data!.slice(0, 4).map((c) => (
                      <button
                        key={c.id}
                        onClick={() => {
                          setCustomer(c);
                          setClientName('');
                        }}
                      >
                        {c.name}
                        <span className={c.balance > 0 ? 'neg' : c.balance < 0 ? 'pos' : 'muted'}>
                          {' '}
                          {c.balance > 0 ? '−' : c.balance < 0 ? '+' : ''}
                          {amount(Math.abs(c.balance))}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            <div className="tk-tabs">
              <button className={pane === 'lines' ? 'on' : ''} onClick={() => setPane('lines')}>
                Articles{lines.length ? ` (${lines.length})` : ''}
              </button>
              <button className={pane === 'payments' ? 'on' : ''} onClick={() => setPane('payments')}>
                Règlements
              </button>
              <button disabled title="Arrive avec le module Clients">
                Livraisons
              </button>
              <button className={pane === 'extra' ? 'on' : ''} onClick={() => setPane('extra')}>
                Infos
              </button>
              <span className="tk-meta" title={title}>
                {lines.length ? (quote ? `Devis ${quote.number}` : 'Nouveau') : (lastSale?.number ?? 'Nouveau')}
              </span>
            </div>
            {(quote && lines.length > 0) || (!lines.length && lastSale?.customer_name) ? (
              <div className="tk-note">
                {quote && lines.length
                  ? `${quote.number} · prix garantis jusqu'au ${new Date(`${quote.validUntil}T12:00:00`).toLocaleDateString('fr-FR')}`
                  : `${lastSale!.customer_name}${lastSale!.due_date ? ` · à régler avant le ${new Date(`${lastSale!.due_date}T12:00:00`).toLocaleDateString('fr-FR')}` : ''}`}
              </div>
            ) : null}
          </div>

          {pane === 'lines' && (
            <div className="tk-lines">
              {!priced.length && <p className="tk-empty">{lastSale ? `Ticket ${lastSale.number} validé. Scannez le produit suivant.` : 'Aucun article : scannez ou touchez un produit.'}</p>}
              {priced.map((l) => {
                const isSel = l.key === selected;
                const pack = l.packId ? l.packs.find((p) => p.id === l.packId) : undefined;
                return (
                  <div key={l.key} className={`tk-line ${isSel ? 'sel' : ''}`}>
                    <div className="tk-main" onClick={() => setSelected(l.key)} onDoubleClick={() => setDialog('vary')}>
                      <span className="tk-q">{lineQty(l)}</span>
                      <span className="tk-label">
                        <b>{l.label}</b>
                        <small>
                          {lineQty(l)} × {amount(l.packPrice ?? l.unitPrice)} · {pack ? pack.name : l.unitName}
                          {l.discount > 0 && <span className="neg"> · remise −{amount(l.discount)}</span>}
                          {l.promo > 0 && (
                            <span className="promo" title={l.promotionName ?? ''}>
                              {' '}
                              · promo −{amount(l.promo)}
                            </span>
                          )}
                        </small>
                      </span>
                      <span className="tk-t">{amount(lineTotal(l))}</span>
                    </div>
                    {isSel && (
                      <div className="tk-ops">
                        <button title="Quantité − (touche −)" disabled={l.fixedAmount !== undefined} onClick={() => changeQty(l.key, -1000)}>
                          −
                        </button>
                        <QtyCell line={l} onChange={(q) => setLines((ls) => ls.map((x) => (x.key === l.key ? { ...x, qty: q } : x)))} />
                        <button title="Quantité + (touche +)" disabled={l.fixedAmount !== undefined} onClick={() => changeQty(l.key, 1000)}>
                          ＋
                        </button>
                        <button className="wide" title="Changer le prix, le conditionnement ou la quantité" onClick={() => setDialog('vary')}>
                          Varier
                        </button>
                        <button className="wide" title="Remise sur la ligne (F6)" onClick={() => setDialog('discount')}>
                          % Remise
                        </button>
                        <button className="wide red" title="Enlever la ligne (Suppr)" onClick={() => removeLine(l.key)}>
                          Enlever
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {pane === 'payments' && (
            <div className="tk-pane">
              {lastSale && !lines.length ? (
                <table className="list">
                  <caption>Règlement du ticket {lastSale.number}</caption>
                  <tbody>
                    {lastSale.payments.map((p, i) => (
                      <tr key={i}>
                        <td>{PAYMENT_METHODS[p.method]}</td>
                        <td>{p.reference ?? ''}</td>
                        <td className="r">{fcfa(p.amount)}</td>
                      </tr>
                    ))}
                    {lastSale.change_given > 0 && (
                      <tr>
                        <td>Rendu monnaie</td>
                        <td></td>
                        <td className="r">−{fcfa(lastSale.change_given)}</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              ) : (
                <p className="muted">
                  Le règlement se fait à la validation (F4) : espèces avec les billets, ou Encaisser (Ctrl+E) pour MTN Mobile Money, Orange Money, carte, bon
                  d'achat et paiements mixtes.
                </p>
              )}
            </div>
          )}

          {pane === 'extra' && (
            <div className="tk-pane">
              <table className="list compact">
                <tbody>
                  <tr>
                    <th>Fiche</th>
                    <td>{title}</td>
                  </tr>
                  <tr>
                    <th>Caisse ouverte par</th>
                    <td>{session.data.user_name}</td>
                  </tr>
                  <tr>
                    <th>Ouverture</th>
                    <td>{new Date(session.data.opened_at).toLocaleString('fr-FR')}</td>
                  </tr>
                  <tr>
                    <th>Fond de caisse</th>
                    <td>{fcfa(session.data.opening_float)}</td>
                  </tr>
                  <tr>
                    <th>Vendeur</th>
                    <td>{user.name}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}

          <div className="tk-foot">
            <div className="tk-sum">
              <span>
                {totals.itemCount} article{totals.itemCount > 1 ? 's' : ''}
                {totals.totalDiscount > 0 && ` · remises −${amount(totals.totalDiscount)}`}
                {totals.totalPromo > 0 && ` · promotions −${amount(totals.totalPromo)}`}
                {lines.length > 0 && cashDue < totals.totalTtc && ` · espèces ${amount(cashDue)} (arrondi −${amount(totals.totalTtc - cashDue)})`}
              </span>
              {vatEnabled && (
                <button className="link" onClick={() => setShowTaxes((v) => !v)}>
                  HT / TVA {showTaxes ? '▾' : '▸'}
                </button>
              )}
            </div>
            {showTaxes && vatEnabled && (
              <div className="tk-taxes">
                <span>HT {amount(totals.totalHt)}</span>
                {totals.vat
                  .filter((v) => v.tva > 0)
                  .map((v) => (
                    <span key={v.rate}>
                      TVA {(v.rate / 100).toLocaleString('fr-FR')} % : {amount(v.tva)}
                    </span>
                  ))}
              </div>
            )}
            <div className={`tk-total ${!lines.length && lastSale ? 'done' : ''}`}>
              <span>{tx('Total TTC').toUpperCase()}</span>
              <strong>
                {amount(shownTotal)}
                <small>FCFA</small>
              </strong>
            </div>
            <div className="tk-er">
              <div>
                <small>REÇU</small>
                <b>{given ? amount(given) : '—'}</b>
              </div>
              <div className="change">
                <small>À RENDRE</small>
                <b>{change ? amount(change) : '—'}</b>
              </div>
            </div>
          </div>
        </aside>
      </div>

      <div className="pos-actions">
        <button disabled={!lines.length || !can('sale_hold')} onClick={() => void hold()} style={{ '--c': '#e0a800' } as React.CSSProperties}>
          <i aria-hidden>⏸</i>En attente <kbd>F3</kbd>
        </button>
        <button disabled={!can('sale_resume')} onClick={() => setDialog('held')} title="Rappeler un ticket mis en attente" style={{ '--c': '#e0a800' } as React.CSSProperties}>
          <i aria-hidden>↺</i>
          <span>
            Rappeler
            {(held.data?.length ?? 0) > 0 && <b className="held-count">{held.data!.length}</b>}
          </span>
          <kbd>F10</kbd>
        </button>
        <button disabled={!can('drawer_open')} onClick={openDrawer} title="Ouvre le tiroir-caisse sans vente (tracé dans le journal)" style={{ '--c': '#0891b2' } as React.CSSProperties}>
          <i aria-hidden>🗃</i>Tiroir <kbd>F5</kbd>
        </button>
        <button disabled={!lastSale || !can('sale_reprint')} onClick={reprint} title="Réimprimer le dernier ticket" style={{ '--c': '#7c3aed' } as React.CSSProperties}>
          <i aria-hidden>🧾</i>Ticket <kbd>F2</kbd>
        </button>
        <button disabled={!lastSale || lines.length > 0} onClick={printA4} title="Facture A4 du dernier ticket" style={{ '--c': '#7c3aed' } as React.CSSProperties}>
          <i aria-hidden>📄</i>Facture A4 <kbd>F9</kbd>
        </button>
        <button onClick={onListing} title="Listing des factures" style={{ '--c': '#7c3aed' } as React.CSSProperties}>
          <i aria-hidden>☰</i>Listing <kbd>F7</kbd>
        </button>
        <button disabled={!lines.length} onClick={() => confirm('Vider la fiche en cours ?') && clear()} style={{ '--c': '#dc2626' } as React.CSSProperties}>
          <i aria-hidden>🗑</i>Vider
        </button>
        <button onClick={() => (lines.length ? toast.error('Terminez ou mettez en attente la fiche en cours') : onClose())} title="Fermer la fiche" style={{ '--c': '#94a3b8' } as React.CSSProperties}>
          <i aria-hidden>✕</i>Fermer
        </button>
        <button className="pay" disabled={!lines.length} onClick={() => setDialog('pay')} title="Mobile Money, carte, bon d'achat, paiements mixtes">
          <i aria-hidden>💳</i>Encaisser <kbd>Ctrl+E</kbd>
        </button>
        <button className="go" disabled={!lines.length} onClick={() => void validate()}>
          <i aria-hidden>✓</i>
          <span>
            VALIDER
            <small>et nouvelle fiche · F4</small>
          </span>
        </button>
      </div>

      {dialog === 'pay' && (
        <PaymentDialog
          total={totals.totalTtc}
          needsSupervisor={discountNeedsCode}
          cashRounding={settings.cashRounding}
          allowCredit={Boolean(customer)}
          onClose={() => setDialog(null)}
          onPaid={async (payments, supervisorPin) => {
            setDialog(null);
            await sell(payments, { supervisorPin });
          }}
        />
      )}
      {dialog === 'customer' && (
        <CustomerPickDialog
          user={user}
          onClose={() => setDialog(null)}
          onPick={(c) => {
            setCustomer(c);
            setDialog(null);
          }}
        />
      )}
      {dialog === 'custPay' && (
        <CustomerPaymentDialog
          atRegister
          onClose={() => setDialog(null)}
          onPaid={(id) => {
            setDialog(null);
            call('customers.printReceipt', id).catch(toast.error);
          }}
        />
      )}
      {dialog === 'quote' && <QuotePickDialog onClose={() => setDialog(null)} onPick={(id) => void loadQuote(id)} />}
      {dialog === 'expense' && (
        <ExpenseDialog
          atRegister
          user={user}
          needsSupervisor={!has(user, 'cashout')}
          onClose={() => setDialog(null)}
          onSaved={(e) => {
            setDialog(null);
            call('expenses.print', e.id).catch(toast.error);
          }}
        />
      )}
      {pending && (
        <SupervisorPrompt
          action={pending.message}
          onCancel={() => setPending(null)}
          onConfirm={(pin) => {
            const p = pending;
            setPending(null);
            void sell(p.payments, p.reason === 'credit' ? { supervisorPin: p.supervisorPin, creditPin: pin } : { supervisorPin: pin });
          }}
        />
      )}
      {dialog === 'search' && (
        <SaleSearchDialog
          initialQuery={searchQuery}
          customerId={customer?.id ?? null}
          canCreate={canCreate}
          onClose={() => setDialog(null)}
          onPick={(row) => askQty(row)}
          onCreateArticle={(name) => {
            setCreating({ article: null, name });
            setDialog('create');
          }}
          onCreateLevel={async (articleId, where) => {
            try {
              const article = await call('catalogue.get', articleId);
              if (article.unit !== 'piece') return toast.error('Les conditionnements ne valent que pour les articles vendus à la pièce');
              if (article.packs.length >= 3) return toast.error(`${article.name} a déjà 4 conditionnements`);
              setCreating({ article, addLevel: where });
              setDialog('create');
            } catch (err) {
              toast.error(err);
            }
          }}
        />
      )}
      {dialog === 'qty' && picked && (
        <QtyPrompt
          row={picked.row}
          initial={picked.initial}
          onClose={() => setDialog(null)}
          inCart={lines.filter((l) => l.articleId === picked.row.article_id).reduce((t, l) => t + l.qty, 0)}
          canPrice={has(user, 'price')}
          ignoreStock={ignoreStock}
          onDone={(q, price) => {
            setDialog(null);
            void addRow(picked.row, q, price);
          }}
        />
      )}
      {dialog === 'create' && creating && (
        <ArticleForm
          article={creating.article}
          initialName={creating.name}
          addLevel={creating.addLevel}
          canSetStorePrice={false}
          onClose={() => openSearch(searchQuery)}
          onSaved={(a) => {
            setCreating(null);
            openSearch(creating.article ? searchQuery : a.name);
          }}
        />
      )}
      {dialog === 'weight' && weightFor && (
        <WeightDialog
          article={weightFor}
          onClose={() => setDialog(null)}
          onDone={(q) => {
            addLine(toLine(weightFor, q, null));
            setDialog(null);
          }}
        />
      )}
      {dialog === 'discount' && sel && (
        <DiscountDialog
          line={sel}
          onClose={() => setDialog(null)}
          onDone={(discount) => {
            setLines((ls) => ls.map((l) => (l.key === sel.key ? { ...l, discount } : l)));
            setDialog(null);
          }}
        />
      )}
      {dialog === 'vary' && sel && (
        <VaryDialog
          line={sel}
          level={level}
          onClose={() => setDialog(null)}
          onDiscount={() => setDialog('discount')}
          onDone={(q, packId) => {
            // Le prix saisi valait pour l'ancien conditionnement : on revient au tarif si l'on en change.
            setLines((ls) => ls.map((l) => (l.key === sel.key ? { ...l, qty: q, packId, price: packId === l.packId ? l.price : undefined } : l)));
            setDialog(null);
          }}
        />
      )}
      {dialog === 'held' && (
        <HeldDialog
          onClose={() => {
            setDialog(null);
            held.reload();
          }}
          onResume={resume}
        />
      )}
      {dialog === 'statement' && customer && (
        <Modal title={`Extrait de compte : ${customer.name}`} onClose={() => setDialog(null)} wide>
          <Statement customer={customer} />
        </Modal>
      )}
      {dialog === 'cancel' && <CancelDialog sessionId={session.data.id} onClose={() => setDialog(null)} />}
      {dialog === 'return' && <ReturnDialog onClose={() => setDialog(null)} />}
      {(dialog === 'cashIn' || dialog === 'cashOut') && (
        <CashOpDialog type={dialog === 'cashIn' ? 'IN' : 'OUT'} needsSupervisor={!has(user, 'cashout')} onClose={() => setDialog(null)} />
      )}
    </div>
  );
}

/**
 * Quantité modifiable directement dans la grille : nombre de conditionnements
 * (2 PALETTE), de pièces ou de kg. Validée par Entrée ou en quittant la case.
 */
function QtyCell({ line, onChange }: { line: PosLine; onChange: (qtyMilli: number) => void }) {
  const pack = line.packId ? line.packs.find((p) => p.id === line.packId) : undefined;
  const shown = String((pack ? line.qty / pack.units : line.qty / 1000)).replace('.', ',');
  const [value, setValue] = useState(shown);
  useEffect(() => setValue(shown), [shown]);
  if (line.fixedAmount !== undefined) return <>{lineQty(line)}</>;
  const commit = () => {
    const n = parseQty(value);
    // Conditionnement ou pièce : nombre entier ; sinon on revient à la valeur affichée.
    if (n === null || ((pack || line.unit === 'piece') && n % 1000 !== 0)) return setValue(shown);
    const q = pack ? (n / 1000) * pack.units : n;
    if (q !== line.qty) onChange(q);
  };
  return (
    <input
      className="cell-qty"
      inputMode="decimal"
      value={value}
      onClick={(e) => e.stopPropagation()}
      onFocus={(e) => e.target.select()}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          (e.target as HTMLInputElement).blur();
        } else if (e.key === 'Escape') setValue(shown);
      }}
    />
  );
}

/**
 * Varier : changer la quantité de la ligne sélectionnée, ou le conditionnement
 * vendu (passer de 12 ampoules à 1 paquet, ou d'un paquet au carton).
 */
function VaryDialog({
  line,
  level,
  onClose,
  onDone,
  onDiscount,
}: {
  line: PosLine;
  level: Parameters<typeof tariffPrice>[1];
  onClose: () => void;
  onDone: (qty: number, packId: string | null) => void;
  onDiscount: () => void;
}) {
  const [packId, setPackId] = useState<string | null>(line.packId);
  const pack = packId ? line.packs.find((p) => p.id === packId) : undefined;
  const [value, setValue] = useState(String(pack ? line.qty / pack.units : line.qty / 1000).replace('.', ','));
  const fixed = line.fixedAmount !== undefined;
  const n = parseQty(value);
  // Quantité en unités de détail : un nombre entier de cartons, ou la quantité saisie.
  const q = n === null ? null : pack ? (n % 1000 === 0 && n > 0 ? (n / 1000) * pack.units : null) : n;
  const choose = (id: string | null) => {
    const next = id ? line.packs.find((p) => p.id === id) : undefined;
    // On garde la même quantité totale quand elle tombe juste, sinon un seul conditionnement.
    const current = q ?? line.qty;
    setValue(String(next ? (current % next.units === 0 ? current / next.units : 1) : current / 1000).replace('.', ','));
    setPackId(id);
  };
  const preview = q ? atLevel({ ...line, qty: q, packId }, level) : null;
  return (
    <Modal title={line.label} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (q && !fixed) onDone(q, packId);
        }}
      >
        {line.packs.length > 0 && !fixed && (
          <div className="seg pack-seg">
            {line.packs.map((p) => (
              <button type="button" key={p.id} className={packId === p.id ? 'active' : ''} onClick={() => choose(p.id)}>
                {p.name} <small>({p.units / 1000})</small>
              </button>
            ))}
            <button type="button" className={packId === null ? 'active' : ''} onClick={() => choose(null)}>
              {line.unitName}
            </button>
          </div>
        )}
        <Field
          label={`Quantité (${(pack?.name ?? line.unitName).toLowerCase()})`}
          hint={
            fixed
              ? 'Étiquette balance à prix imposé : quantité non modifiable'
              : pack
                ? `Prix du ${pack.name.toLowerCase()} : ${fcfa(tariffPrice(pack.tariff, level))} · ${pack.units / 1000} ${line.unitName.toLowerCase()}`
                : `${tx('PU TTC')} : ${fcfa(tariffPrice(line.tariff, level))}`
          }
        >
          <input autoFocus inputMode="decimal" value={value} disabled={fixed} onChange={(e) => setValue(e.target.value)} />
        </Field>
        {pack && n !== null && q === null && <p className="danger-text">Nombre entier de {pack.name.toLowerCase()} uniquement</p>}
        {preview && !fixed && <p className="big-total">{fcfa(lineTotal(preview))}</p>}
        <div className="actions">
          <button type="button" onClick={onDiscount}>
            Remise (F6)
          </button>
          <button type="submit" className="primary" disabled={!q || fixed}>
            Appliquer
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** Choix de la caisse par un gérant ou l'administrateur sans caisse attribuée. */
export function RegisterChooser({ current, onChosen }: { current: string | null; onChosen: () => void }) {
  const toast = useToast();
  const registers = useLoad(() => call('pos.registers'), []);
  return (
    <div className="register-choice">
      {(registers.data ?? []).map((r) => (
        <button
          key={r.id}
          className={r.id === current ? 'primary' : ''}
          onClick={() =>
            call('pos.chooseRegister', r.id).then(() => {
              toast.ok(`Vous vendez sur ${r.name}`);
              onChosen();
            }, toast.error)
          }
        >
          {String(r.number).padStart(2, '0')} · {r.name}
        </button>
      ))}
      {registers.data && !registers.data.length && <p className="muted">Aucune caisse active : créez-en une dans Administration › Caisses.</p>}
    </div>
  );
}

/** Caisse fermée : aucune vente avant l'ouverture dans Trésorerie. */
function ClosedRegister({ canOpen, onTreasury, onReload }: { canOpen: boolean; onTreasury: () => void; onReload: () => void }) {
  return (
    <div className="center-page">
      <div className="card closed-register">
        <h2>La caisse est fermée</h2>
        <p>Aucune vente n'est possible tant que la caisse n'est pas ouverte. L'ouverture se fait dans Trésorerie › Opérations de trésorerie, avec le comptage du fond de caisse.</p>
        <div className="row">
          {canOpen && (
            <button className="primary big" onClick={onTreasury}>
              Ouvrir la caisse dans Trésorerie
            </button>
          )}
          <button onClick={onReload}>Actualiser</button>
        </div>
        {!canOpen && <p className="muted">Demandez au gérant d'ouvrir la caisse.</p>}
      </div>
    </div>
  );
}

function localDay(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function WeightDialog({ article, onClose, onDone }: { article: Article; onClose: () => void; onDone: (qty: number) => void }) {
  const [value, setValue] = useState('');
  const q = parseQty(value);
  return (
    <Modal title={article.name} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (q) onDone(q);
        }}
      >
        <Field label={`Quantité en ${article.unit === 'kg' ? 'kg' : 'litres'}`} hint={`Prix : ${fcfa(article.store_price)} / ${article.unit === 'kg' ? 'kg' : 'L'}`}>
          <input autoFocus inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} placeholder="1,250" />
        </Field>
        {q && <p className="big-total">{fcfa(Math.round((article.store_price * q) / 1000))}</p>}
        <div className="actions">
          <button type="submit" className="primary" disabled={!q}>
            Ajouter
          </button>
        </div>
      </form>
    </Modal>
  );
}

function DiscountDialog({ line, onClose, onDone }: { line: PosLine; onClose: () => void; onDone: (discount: number) => void }) {
  const gross = lineTotal({ ...line, discount: 0 });
  const [mode, setMode] = useState<'pct' | 'amount'>('pct');
  const [value, setValue] = useState('');
  const n = Number(value.replace(',', '.'));
  const discount = !value ? 0 : mode === 'pct' ? Math.round((gross * n) / 100) : Math.round(n);
  const valid = Number.isFinite(n) && discount >= 0 && discount <= gross;
  return (
    <Modal title={`Remise sur ${line.label}`} onClose={onClose}>
      <div className="tabs">
        <button className={mode === 'pct' ? 'active' : ''} onClick={() => setMode('pct')}>
          En %
        </button>
        <button className={mode === 'amount' ? 'active' : ''} onClick={() => setMode('amount')}>
          En FCFA
        </button>
      </div>
      <Field label={mode === 'pct' ? 'Pourcentage' : 'Montant'} hint={`Ligne : ${fcfa(gross)}. Remise validée par le gérant à l'encaissement.`}>
        <input autoFocus inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} />
      </Field>
      {valid && discount > 0 && <p>Nouveau total de la ligne : {fcfa(gross - discount)}</p>}
      <div className="actions">
        <button className="ghost" onClick={() => onDone(0)}>
          Retirer la remise
        </button>
        <button className="primary" disabled={!valid} onClick={() => onDone(discount)}>
          Appliquer
        </button>
      </div>
    </Modal>
  );
}
