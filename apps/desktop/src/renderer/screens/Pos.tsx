import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  type CartLine,
  type CustomerDisplayState,
  type Permission,
  type PosLayout,
  type PriceLevel,
  type QtyTier,
  type Tariff,
  PRICE_LEVELS,
  agreedPrices,
  applyPromotions,
  computeTotals,
  formatFcfa,
  lineTotal,
  parseFamilyDiscounts,
  parseQtyTiers,
  roundCash,
  tariffPrice,
} from '@superette/core';
import { type ApiError, type Result, call } from '../api';
import { askConfirm, Empty, Field, Modal, SupervisorPrompt, fcfa, parseAmount, parseQty, qty, useLoad, useStoreSettings, useToast, has } from '../ui';
import { type Customer, CustomerPaymentDialog, CustomerPickDialog } from './customerDialogs';
import { ExpenseDialog } from './Expenses';
import { Statement } from './Customers';
import { OrderPickDialog } from './Orders';
import { QuotePickDialog } from './Quotes';
import { ArticleForm } from './Articles';
import { QtyPrompt, type SaleRow, SaleRowList, SaleSearchDialog, rowKey, stockByDepot, stockIn, useSaleRows } from './SaleSearch';
import { CancelDialog, CashOpDialog, HeldDialog, PaymentDialog, ReturnDialog, WhatsappTicketDialog } from './PosDialogs';
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
  /** Prix par quantité de l'unité de détail et famille (remise du client par famille). */
  tiers: QtyTier[];
  familyId: string | null;
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
    tiers: parseQtyTiers(article.qty_tiers),
    familyId: article.family_id,
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

type Dialog = null | 'options' | 'pay' | 'close' | 'held' | 'statement' | 'cancel' | 'return' | 'cashIn' | 'cashOut' | 'search' | 'qty' | 'create' | 'weight' | 'discount' | 'vary' | 'customer' | 'custPay' | 'expense' | 'quote' | 'order';
type SellPayments = { method: 'CASH' | 'CUSTOMER_CREDIT' | Result<'pos.sell'>['payments'][number]['method']; amount: number; reference?: string }[];
type Pane = 'lines' | 'payments' | 'delivery' | 'extra';
type PrintChoice = 'none' | 'ticket' | 'listing';

/** Livraison en cours de saisie dans l'onglet Livraison du ticket. */
type DeliveryDraft = { on: boolean; address: string; phone: string; courier: string; slot: string; date: string; fee: string; note: string };
const NO_DELIVERY: DeliveryDraft = { on: false, address: '', phone: '', courier: '', slot: 'Tout de suite', date: '', fee: '', note: '' };
const SLOTS = ['Tout de suite', '8h–12h', '12h–16h', '16h–20h'];
const dayPlus = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

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
const TILE_COLORS = ['var(--brand)', '#e0a800', '#0891b2', '#db2777', '#7c3aed', '#22a06b', '#2563eb', '#ea580c'];
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

export function Pos({ edit = null, user, hasRegister, registerId = null, canChooseRegister = false, onRegisterChosen, vatEnabled = true, ignoreStock = false, active, title, onClose, onSwitchMode, onTreasury, mode = 'cash', layout = 'modern' }: {
  mode?: 'cash' | 'credit';
  layout?: PosLayout;
  /** Facture à recharger pour la modifier (demandée depuis le registre ou Mes factures). */
  edit?: { sale: Result<'sales.editable'> & { id: string }; nonce: number } | null;
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
  /** Ouvre Trésorerie › Opérations de trésorerie (ouverture et clôture). */
  onTreasury: () => void;
}) {
  const toast = useToast();
  const session = useLoad(() => call('pos.session'), []);
  const quickKeys = useLoad(() => call('catalogue.quickKeys'), []);
  const warehouses = useLoad(() => call('admin.warehouses'), []);
  // Dépôts où ce vendeur vend sans le code du gérant.
  const myWarehouses = useLoad(() => call('pos.saleWarehouses'), []);
  const [lines, setLines] = useState<PosLine[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [input, setInput] = useState('');
  const [dialog, setDialog] = useState<Dialog>(null);
  const [pane, setPane] = useState<Pane>('lines');
  const [cashGiven, setCashGiven] = useState(0);
  const [showTaxes, setShowTaxes] = useState(false);
  /** Classique : colonne Remise affichée ; Conventionnel : quantité saisie avant le produit. */
  const [showDiscount, setShowDiscount] = useState(false);
  const [entryQty, setEntryQty] = useState('1');
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
  const [waSale, setWaSale] = useState<{ id: string; number: string } | null>(null);
  const sendWhatsapp = () => lastSale && setWaSale({ id: lastSale.id, number: lastSale.number });
  const [customer, setCustomer] = useState<Customer | null>(null);
  /** Nom donné par un client comptoir (facultatif), imprimé sur le ticket et la facture. */
  const [clientName, setClientName] = useState('');
  /** Devis ou proforma chargé : ses prix garantis valent accord de remise. */
  const [quote, setQuote] = useState<{ id: string; number: string; validUntil: string } | null>(null);
  /** Commande client chargée : sa marchandise réservée lui revient, elle passe « facturée » à la validation. */
  const [order, setOrder] = useState<{ id: string; number: string } | null>(null);
  /** Vendeur du panier préparé au rayon : la vente compte pour lui. */
  const [seller, setSeller] = useState<{ id: string | null; name: string } | null>(null);
  /** Tarif et dépôt choisis pour cette fiche (null : ceux du client et du magasin). */
  const [levelChoice, setLevelChoice] = useState<PriceLevel | null>(null);
  const [warehouseChoice, setWarehouseChoice] = useState<string | null>(null);
  /** Code du gérant qui a permis ces choix, quand le caissier n'en a pas le droit. */
  const [optionsPin, setOptionsPin] = useState<string | undefined>();
  const [askOption, setAskOption] = useState<{ label: string; apply: () => void } | null>(null);
  const [delivery, setDelivery] = useState<DeliveryDraft>(NO_DELIVERY);
  const feeVat = useLoad(() => call('deliveries.feeVat'), []);
  const couriers = useLoad(() => call('deliveries.couriers'), []);
  const account = useLoad(() => (customer ? call('customers.account', customer.id) : Promise.resolve(null)), [customer?.id]);
  // Carte de fidélité du client choisi (rechargée après chaque vente).
  const fidelity = useLoad(() => (customer ? call('loyalty.status', customer.id) : Promise.resolve(null)), [customer?.id, lastSale?.id]);
  // Tickets en attente sur cette caisse : leur nombre s'affiche sur le bouton « Ouvrir ».
  const held = useLoad(() => call('pos.held'), []);
  // Paniers des vendeurs : relus toutes les 20 secondes (PC relié au serveur).
  const carts = useLoad(() => call('pos.shelfCarts'), []);
  useEffect(() => {
    const t = setInterval(() => carts.reload(), 20_000);
    return () => clearInterval(t);
  }, []);
  // Clients existants proposés pendant la frappe du nom (évite les doublons).
  const namesake = useLoad(() => (clientName.trim().length >= 2 ? call('customers.list', { search: clientName.trim() }) : Promise.resolve([])), [clientName]);
  /** Vente bloquée en attente du code gérant (remise ou dépassement du plafond). */
  const [pending, setPending] = useState<{ payments: SellPayments; supervisorPin?: string; reason: 'discount' | 'credit'; message: string } | null>(null);
  const credit = mode === 'credit';
  const scanRef = useRef<HTMLInputElement>(null);
  /** Impression demandée à la validation : F2 ticket, F7 listing, F4 (VALIDER) aucune. */
  const printRef = useRef<PrintChoice>('none');
  /** Promotions du jour : appliquées à l'écran comme elles le seront à l'encaissement. */
  const promoRules = useLoad(() => call('promotions.active'), []);
  const usualLevel = customer?.price_level ?? 'retail';
  const level = levelChoice ?? usualLevel;
  const priced = useMemo(
    () => {
      // Prix convenus, comme à l'enregistrement : paliers de quantité et remises du client par famille.
      const discounts = parseFamilyDiscounts(customer?.family_discounts);
      return applyPromotions(
        lines.map((l) => agreedPrices(atLevel(l, level), l, discounts)),
        level === 'retail' ? (promoRules.data ?? []) : [],
      );
    },
    [lines, promoRules.data, level, customer],
  );
  /** Frais de livraison : une ligne de service ajoutée au ticket par le serveur à la validation. */
  const fee = delivery.on ? (parseAmount(delivery.fee) ?? 0) : 0;
  const totals = useMemo(() => {
    const t = computeTotals(fee > 0 ? [...priced, { articleId: 'svc-delivery-fee', label: 'Frais de livraison', unitPrice: fee, qty: 1000, vatRate: feeVat.data ?? 0, discount: 0 }] : priced);
    return { ...t, itemCount: computeTotals(priced).itemCount };
  }, [priced, fee, feeVat.data]);
  /** Facture en cours de modification : ce que le client a déjà réglé est repris. */
  const [replacing, setReplacing] = useState<{ id: string; number: string; paid: number } | null>(null);
  /** Reste à encaisser : le total, moins ce qui était déjà réglé sur la facture modifiée. */
  const toPay = replacing ? Math.max(0, totals.totalTtc - replacing.paid) : totals.totalTtc;
  /** Total à payer si tout est réglé en espèces (arrondi des paramètres). */
  const cashDue = roundCash(toPay, settings.cashRounding);
  // Une remise sous le maximum des paramètres passe sans le code du gérant.
  const underMax = settings.maxDiscountPct > 0 && totals.totalDiscount * 100 <= settings.maxDiscountPct * (totals.totalTtc + totals.totalDiscount);
  const discountNeedsCode = totals.totalDiscount > 0 && !has(user, 'discount') && !underMax;

  /** Afficheur client : le ticket en cours, puis la monnaie rendue jusqu'au client suivant. */
  const [displayPaid, setDisplayPaid] = useState<{ total: number; paid: number; change: number } | null>(null);
  useEffect(() => {
    if (!active) return;
    if (lines.length && displayPaid) return setDisplayPaid(null);
    const show = (l: (typeof priced)[number]) => ({ name: l.label, qty: lineQty(l), amount: lineTotal(l) });
    const last = priced.reduce<(typeof priced)[number] | null>((m, l) => (!m || l.key > m.key ? l : m), null);
    const state: CustomerDisplayState = lines.length
      ? { kind: 'cart', last: last && show(last), lines: priced.map(show), total: toPay, savings: totals.totalDiscount + totals.totalPromo }
      : displayPaid
        ? { kind: 'paid', ...displayPaid }
        : { kind: 'idle' };
    call('display.show', state).catch(() => undefined);
    if (state.kind !== 'paid') return;
    // Retour à l'accueil une minute après la vente.
    const t = setTimeout(() => setDisplayPaid(null), 60_000);
    return () => clearTimeout(t);
  }, [active, lines.length, priced, toPay, totals.totalDiscount, totals.totalPromo, displayPaid]);

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
  const saleOpts = { priceLevel: levelChoice, warehouseId: warehouseChoice };
  const suggestions = useSaleRows(suggestQuery, customer?.id ?? null, saleOpts);
  /** Une ligne choisie (conditionnement d'un article) : on demande d'abord la quantité. */
  const askQty = (row: SaleRow, initial?: string) => {
    setPicked({ row, initial });
    setDialog('qty');
  };
  /** `qtyText` : quantité saisie à part (case Quantité de la présentation Conventionnel). */
  const pickSuggestion = (row: SaleRow, qtyText?: string) => {
    const mult = multiplied?.[1] ?? qtyText;
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

  const onScan = async (e: React.FormEvent, qtyText?: string) => {
    e.preventDefault();
    const typed = input.trim();
    const raw = qtyText && typed && !typed.includes('*') ? `${qtyText}*${typed}` : typed;
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
      // Carte de fidélité ou numéro de téléphone d'un client : il devient le client de la fiche.
      if (!m && !customer) {
        const c = await call('loyalty.findCustomer', code);
        if (c) {
          setCustomer(c);
          toast.ok(`Client : ${c.name}`);
          return;
        }
      }
      // Pas un code-barres : une seule ligne en stock → quantité, sinon la recherche complète.
      const rows = /^[\d\s]+$/.test(code) ? [] : await call('pos.search', code, { customerId: customer?.id ?? null, ...saleOpts });
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
  /** Tarif, dépôt et livraison valent pour une fiche : on revient aux réglages habituels. */
  const resetOptions = () => {
    setLevelChoice(null);
    setWarehouseChoice(null);
    setOptionsPin(undefined);
    setDelivery(NO_DELIVERY);
  };
  const clear = () => {
    setQuote(null);
    setOrder(null);
    setSeller(null);
    setReplacing(null);
    setClientName('');
    setLines([]);
    setCashGiven(0);
    setSelected(null);
    resetOptions();
  };
  /**
   * Tarif ou dépôt choisis pour la fiche : sans le droit, le code d'un gérant
   * est demandé (une fois par fiche). Revenir au réglage habituel est libre.
   */
  const chooseOption = (label: string, right: Permission, usual: boolean, apply: () => void) => {
    if (usual || can(right) || optionsPin) return apply();
    setAskOption({ label, apply });
    setDialog('options');
  };
  const deliveryInput = () =>
    delivery.on
      ? {
          address: delivery.address,
          phone: delivery.phone || null,
          courier: delivery.courier || null,
          slot: delivery.slot || null,
          plannedDate: delivery.date || null,
          fee,
          note: delivery.note || null,
        }
      : null;

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
    // La fiche repart vierge ; la vente reste en mémoire pour Réimprimer et Facture A4.
    setLastSale(sale);
    setDisplayPaid({ total: sale.total_ttc, paid: sale.total_ttc + sale.change_given, change: sale.change_given });
    setDialog(null);
    setCustomer(null);
    setClientName('');
    setQuote(null);
    setOrder(null);
    setReplacing(null);
    const delivered = delivery.on;
    resetOptions();
    toast.ok(`Facture ${sale.number} enregistrée${sale.change_given > 0 ? ` · rendu ${fcfa(sale.change_given)}` : ''}`);
    const print = printRef.current;
    printRef.current = 'none';
    if (print === 'ticket') call('pos.printTicket', sale.id, { newSale: true, force: true }).catch((err) => toast.error(err));
    else {
      // Sans ticket, le tiroir s'ouvre quand même pour une vente en espèces (réglage du poste).
      call('pos.saleDrawer', sale.id).catch((err) => toast.error(err));
      if (print === 'listing') call('pos.printInvoice', sale.id, { format: 'listing' }).catch((err) => toast.error(err));
    }
    // Le bon de livraison part avec le livreur.
    if (delivered) {
      call('pos.printInvoice', sale.id, { doc: 'delivery' }).catch((err) => toast.error(err));
      couriers.reload();
    }
  };

  /**
   * Envoie la vente ; si le serveur demande l'accord d'un gérant (remise d'un
   * caissier, plafond de crédit dépassé), on demande son code puis on relance.
   */
  const sell = async (payments: SellPayments, pins: { supervisorPin?: string; creditPin?: string } = {}) => {
    try {
      if (delivery.on && !delivery.address.trim()) {
        setPane('delivery');
        return toast.error("Indiquez l'adresse de livraison (onglet Livraison)");
      }
      finish(
        await call('pos.sell', {
          lines: saleInput(),
          payments: payments as never,
          customerId: customer?.id ?? null,
          clientName: customer ? null : clientName.trim() || null,
          quoteId: quote?.id ?? null,
          orderId: order?.id ?? null,
          priceLevel: levelChoice,
          warehouseId: warehouseChoice,
          optionsPin,
          delivery: deliveryInput(),
          replacesId: replacing?.id ?? null,
          sellerId: seller?.id ?? null,
          ...pins,
        }),
      );
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
  const validate = async (print: PrintChoice = 'none') => {
    if (!lines.length) return;
    printRef.current = print;
    if (credit) {
      if (!customer) {
        toast.error('Choisissez le client de la vente à crédit');
        setDialog('customer');
        return;
      }
      const deposit = Math.min(cashGiven, toPay);
      const payments: SellPayments = cashGiven >= toPay ? (cashGiven > 0 ? [{ method: 'CASH', amount: cashGiven }] : []) : [];
      if (cashGiven < toPay) {
        if (deposit > 0) payments.push({ method: 'CASH', amount: deposit });
        payments.push({ method: 'CUSTOMER_CREDIT', amount: toPay - deposit });
      }
      await sell(payments);
      return;
    }
    const needsSupervisor = discountNeedsCode && !quote;
    // Payé tout en espèces : le total descend à l'arrondi réglé dans les paramètres.
    if (cashGiven >= cashDue && !needsSupervisor) {
      await sell(cashGiven > 0 ? [{ method: 'CASH', amount: cashGiven }] : []);
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

  /** Panier préparé au rayon par un vendeur : il arrive sur la fiche, à son nom. */
  const takeCart = async (id: string) => {
    if (lines.length) return toast.error('Terminez ou mettez en attente le ticket en cours');
    try {
      const c = await call('pos.takeShelfCart', id);
      setLines(await reload(c.lines));
      setSeller({ id: c.sellerId, name: c.sellerName });
      setLastSale(null);
      setDialog(null);
      carts.reload();
      toast.ok(`Panier n° ${c.number} de ${c.sellerName}${c.label ? ` (${c.label})` : ''}${c.missing ? ` : ${c.missing} article(s) inconnu(s) de ce PC laissé(s) de côté` : ''}`);
    } catch (err) {
      toast.error(err);
      carts.reload();
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

  /** Charge une commande client : ses articles au prix du jour, son client et sa livraison. */
  const loadOrder = async (id: string) => {
    if (lines.length) return toast.error('Terminez ou mettez en attente le ticket en cours');
    try {
      const o = await call('orders.get', id);
      const load = await call('orders.saleLines', id);
      setLines(await reload(load.lines));
      setCustomer(load.customerId ? await call('customers.get', load.customerId) : null);
      setClientName(load.customerId ? '' : load.clientName);
      setDelivery(
        load.delivery
          ? {
              on: true,
              address: load.delivery.address,
              phone: load.delivery.phone ?? '',
              courier: load.delivery.courier ?? '',
              slot: load.delivery.slot ?? NO_DELIVERY.slot,
              date: load.delivery.plannedDate > dayPlus(0) ? load.delivery.plannedDate : '',
              fee: load.delivery.fee ? String(load.delivery.fee) : '',
              note: load.delivery.note ?? '',
            }
          : NO_DELIVERY,
      );
      setQuote(null);
      setOrder({ id: o.id, number: o.number });
      setLastSale(null);
      setDialog(null);
      toast.ok(`Commande ${o.number} chargée${o.status === 'new' ? " (elle n'était pas encore préparée)" : ''}`);
    } catch (err) {
      toast.error(err);
    }
  };

  /** Facture à modifier : ses lignes, son client et ce qu'il a déjà réglé reviennent sur la fiche. */
  useEffect(() => {
    if (!edit) return;
    if (lines.length) return void toast.error('Terminez ou mettez en attente le ticket en cours, puis relancez « Modifier »');
    const { sale } = edit;
    (async () => {
      try {
        setLines(await reload(sale.lines));
        const c = sale.customerId ? await call('customers.get', sale.customerId) : null;
        setCustomer(c);
        setClientName(sale.clientName ?? '');
        setLevelChoice(sale.priceLevel !== (c?.price_level ?? 'retail') ? sale.priceLevel : null);
        setQuote(null);
        setLastSale(null);
        setCashGiven(0);
        setReplacing({ id: sale.id, number: sale.number, paid: sale.paid });
        setPane('lines');
        toast.ok(`Facture ${sale.number} rechargée : modifiez puis validez`);
      } catch (err) {
        toast.error(err);
      }
    })();
  }, [edit?.nonce]);

  const reprint = () => {
    if (!can('sale_reprint')) return toast.error("Vous n'avez pas le droit de réimprimer un ticket");
    if (lastSale) call('pos.printTicket', lastSale.id).catch(toast.error);
    else toast.error('Aucun ticket à réimprimer');
  };
  /** Fiche vide : Listing (F7) réimprime la dernière facture au format listing, comme Ticket (F2) le dernier ticket. */
  const reprintListing = () => {
    if (!can('sale_reprint')) return toast.error("Vous n'avez pas le droit de réimprimer une facture");
    if (lastSale) call('pos.printInvoice', lastSale.id, { format: 'listing' }).catch(toast.error);
    else toast.error('Aucune facture à réimprimer');
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
        // Fiche en cours : F2 valide et imprime le ticket, F7 le listing, F4 enregistre sans imprimer.
        // Fiche vide : F2 réimprime le dernier ticket, F7 la dernière facture en listing.
        F2: () => (lines.length ? void validate('ticket') : reprint()),
        F3: () => void hold(),
        F4: () => void validate('none'),
        F5: openDrawer,
        F6: () => selected !== null && setDialog('discount'),
        F7: () => (lines.length ? void validate('listing') : reprintListing()),
        F8: () => setDialog('customer'),
        F9: printA4,
        F10: () => can('sale_resume') && setDialog('held'),
      };
      if (fn[e.key]) {
        e.preventDefault();
        fn[e.key]!();
      } else if (e.ctrlKey && e.key.toLowerCase() === 'e' && lines.length) {
        e.preventDefault();
        printRef.current = 'none';
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
  // Après validation la fiche est vierge : le montant de la vente précédente ne reste pas affiché.
  const shownTotal = lines.length ? totals.totalTtc : 0;
  const change = lines.length ? Math.max(0, cashGiven - cashDue) : 0;
  const given = lines.length ? cashGiven : 0;


  /** Morceaux communs aux trois présentations de la caisse (Moderne, Classique, Conventionnel). */
  const paymentsPane = (
    <div className="tk-pane">
      <p className="muted">
        Le règlement se fait à la validation (F4) : espèces avec les billets, ou Encaisser (Ctrl+E) pour MTN Mobile Money, Orange Money, carte, bon
        d'achat et paiements mixtes.
      </p>
    </div>
  );
  const deliveryPane = (
    <div className="tk-pane tk-delivery">
      <label className="dl-switch">
        <input
          type="checkbox"
          checked={delivery.on}
          onChange={(e) => {
            const on = e.target.checked;
            setDelivery((d) => ({
              ...d,
              on,
              // Adresse et téléphone repris de la fiche du client.
              address: d.address || (on ? (customer?.address ?? '') : ''),
              phone: d.phone || (on ? (customer?.phone ?? '') : ''),
            }));
          }}
        />
        À livrer chez le client
      </label>
      {delivery.on ? (
        <>
          <Field label="Adresse de livraison">
            <input value={delivery.address} maxLength={200} onChange={(e) => setDelivery((d) => ({ ...d, address: e.target.value }))} placeholder="Quartier, rue, repère" />
          </Field>
          <div className="grid2">
            <Field label="Téléphone">
              <input value={delivery.phone} maxLength={40} onChange={(e) => setDelivery((d) => ({ ...d, phone: e.target.value }))} />
            </Field>
            <Field label="Livreur">
              <input value={delivery.courier} maxLength={60} list="pos-couriers" onChange={(e) => setDelivery((d) => ({ ...d, courier: e.target.value }))} />
              <datalist id="pos-couriers">
                {(couriers.data ?? []).map((c) => (
                  <option key={c} value={c} />
                ))}
              </datalist>
            </Field>
          </div>
          <div className="dl-chips">
            <b>Quand ?</b>
            {[
              ['', "Aujourd'hui"],
              [dayPlus(1), 'Demain'],
            ].map(([d, label]) => (
              <button key={label} type="button" className={delivery.date === d ? 'on' : ''} onClick={() => setDelivery((x) => ({ ...x, date: d! }))}>
                {label}
              </button>
            ))}
            <input
              type="date"
              value={delivery.date}
              min={dayPlus(0)}
              onChange={(e) => setDelivery((x) => ({ ...x, date: e.target.value }))}
              title="Autre jour"
            />
          </div>
          <div className="dl-chips">
            {SLOTS.map((sl) => (
              <button key={sl} type="button" className={delivery.slot === sl ? 'on' : ''} onClick={() => setDelivery((x) => ({ ...x, slot: sl }))}>
                {sl}
              </button>
            ))}
          </div>
          <div className="grid2">
            <Field label="Frais de livraison (FCFA)">
              <input inputMode="numeric" value={delivery.fee} onChange={(e) => setDelivery((d) => ({ ...d, fee: e.target.value }))} placeholder="0" />
            </Field>
            <Field label="Note pour le livreur">
              <input value={delivery.note} maxLength={300} onChange={(e) => setDelivery((d) => ({ ...d, note: e.target.value }))} />
            </Field>
          </div>
          <p className="muted">
            Au VALIDER, le bon de livraison s'imprime avec le ticket et la vente apparaît dans Vente › Livraisons du jour.{credit ? ' La part à crédit est à encaisser par le livreur.' : ''}
          </p>
        </>
      ) : (
        <p className="muted">Cochez « À livrer » pour porter cette vente chez le client : adresse, créneau, livreur et frais de livraison.</p>
      )}
    </div>
  );
  const extraPane = (
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
  );
  const nameInput = (
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
  );
  const actionsMenu = (
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
    <option value="order">Charger une commande client</option>
    <option value="expense">Dépense payée en caisse</option>
    <option value="close">Clôture de caisse (Trésorerie)</option>
  </select>
  );

  const dialogs = (
    <>
    {waSale && <WhatsappTicketDialog saleId={waSale.id} number={waSale.number} onClose={() => setWaSale(null)} />}
      {dialog === 'pay' && (
      <PaymentDialog
        total={toPay}
        needsSupervisor={discountNeedsCode}
        cashRounding={settings.cashRounding}
        allowCredit={Boolean(customer)}
        loyalty={fidelity.data?.enabled ? fidelity.data : null}
        payerPhone={customer?.phone ?? null}
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
          // Livraison déjà cochée : l'adresse et le téléphone viennent de la fiche du client.
          setDelivery((d) => (d.on ? { ...d, address: d.address || (c.address ?? ''), phone: d.phone || (c.phone ?? '') } : d));
          setDialog(null);
        }}
      />
    )}
    {dialog === 'options' && askOption && (
      <SupervisorPrompt
        action={`${askOption.label} Vous n'avez pas ce droit : le code d'un gérant est demandé.`}
        onCancel={() => setDialog(null)}
        onConfirm={(pin) =>
          call('auth.checkSupervisor', pin).then(() => {
            setOptionsPin(pin);
            askOption.apply();
            setAskOption(null);
            setDialog(null);
          }, toast.error)
        }
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
    {dialog === 'order' && <OrderPickDialog onClose={() => setDialog(null)} onPick={(id) => void loadOrder(id)} />}
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
        opts={saleOpts}
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
        onSubstitute={async (code) => {
          setDialog(null);
          try {
            // Le remplaçant au même conditionnement s'il en a un, sinon à l'unité.
            const rows = (await call('pos.search', code, { customerId: customer?.id ?? null, ...saleOpts })).filter((r) => r.code === code);
            const same = rows.find((r) => r.pack_name === picked.row.pack_name) ?? rows.find((r) => r.pack_id === null) ?? rows[0];
            if (same) askQty(same);
            else openSearch(code);
          } catch (err) {
            toast.error(err);
          }
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
          carts.reload();
        }}
        onResume={resume}
        onTakeCart={takeCart}
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
    </>
  );


  // --- Actions communes aux trois présentations ---------------------------------
  const openPay = () => {
    printRef.current = 'none';
    setDialog('pay');
  };
  const askClear = async () => {
    if (await askConfirm('Vider la fiche en cours ?')) clear();
    focusScan();
  };
  const closeFiche = () => (lines.length ? toast.error('Terminez ou mettez en attente la fiche en cours') : onClose());
  /** F2 et F7 : valident la fiche en cours ; sur une fiche vide, réimpriment le dernier ticket ou la dernière facture en listing. */
  const ticketKey = () => (lines.length ? void validate('ticket') : reprint());
  const listingKey = () => (lines.length ? void validate('listing') : reprintListing());
  const pickLevel = (k: PriceLevel) =>
    chooseOption(`Passer cette fiche au tarif ${PRICE_LEVELS[k].toLowerCase()}.`, 'sale_tariff', k === usualLevel, () => setLevelChoice(k === usualLevel ? null : k));
  const pickWarehouse = (id: string) => {
    const w = warehouses.data?.find((x) => x.id === id);
    const mine = w?.id === salesWarehouse?.id || Boolean(w && myWarehouses.data?.includes(w.id));
    if (w) chooseOption(`Vendre depuis le dépôt « ${w.name} ».`, 'sale_warehouse', mine, () => setWarehouseChoice(w.id === salesWarehouse?.id ? null : w.id));
  };
  const setLineQty = (key: number, q: number) => setLines((ls) => ls.map((x) => (x.key === key ? { ...x, qty: q } : x)));
  const heldCount = (held.data?.length ?? 0) + (carts.data?.length ?? 0);
  const ficheNumber = replacing
    ? `Modif. ${replacing.number}`
    : quote && lines.length
      ? `Devis ${quote.number}`
      : order && lines.length
        ? `Commande ${order.number}`
        : seller && lines.length
          ? `Panier de ${seller.name}`
          : 'Nouveau';
  const tariffSelect = (
    <select value={level} onChange={(e) => pickLevel(e.target.value as PriceLevel)} title="Tarif de cette fiche ; par défaut celui du client">
      {(Object.keys(PRICE_LEVELS) as PriceLevel[]).map((k) => (
        <option key={k} value={k}>
          {PRICE_LEVELS[k]}
        </option>
      ))}
    </select>
  );
  const depotSelect =
    (warehouses.data?.length ?? 0) > 1 ? (
      <select value={warehouseChoice ?? salesWarehouse?.id ?? ''} onChange={(e) => pickWarehouse(e.target.value)} title="Dépôt d'où sort la marchandise de cette fiche">
        {warehouses.data!.map((w) => (
          <option key={w.id} value={w.id}>
            {w.name}
          </option>
        ))}
      </select>
    ) : null;
  const staleNote = stale && (
    <div className="tre-warning">
      Cette caisse est ouverte depuis le {new Date(session.data.opened_at).toLocaleDateString('fr-FR')} : clôturez la journée précédente dans{' '}
      <button className="link" onClick={onTreasury}>
        Trésorerie
      </button>{' '}
      puis rouvrez la caisse.
    </div>
  );
  const bandText = replacing
    ? `Modification de la facture ${replacing.number} · déjà réglé ${amount(replacing.paid)} · ${
        totals.totalTtc >= replacing.paid ? `reste à encaisser ${amount(totals.totalTtc - replacing.paid)}` : `à rendre ${amount(replacing.paid - totals.totalTtc)}`
      } FCFA`
    : credit && customer && account.data
      ? `Doit ${amount(account.data.balance)} · disponible ${amount(account.data.available)} FCFA`
      : quote && lines.length
          ? `${quote.number} · prix garantis jusqu'au ${new Date(`${quote.validUntil}T12:00:00`).toLocaleDateString('fr-FR')}`
          : delivery.on
            ? `À livrer${delivery.address ? ` : ${delivery.address}` : ''}`
            : 'Livraison immédiate';
  const optionChips = (level !== 'retail' || warehouseChoice) && (
    <>
      {level !== 'retail' && <span className="tag surstock">Tarif {PRICE_LEVELS[level].toLowerCase()}</span>}
      {warehouseChoice && <span className="tag surstock">Sortie {warehouses.data?.find((w) => w.id === warehouseChoice)?.name}</span>}
    </>
  );
  const balanceChip = customer && account.data && (
    <span className={`solde-chip ${account.data.balance > 0 ? 'neg' : account.data.balance < 0 ? 'pos' : 'zero'}`}>
      Solde : {account.data.balance > 0 ? '−' : account.data.balance < 0 ? '+' : ''}
      {amount(Math.abs(account.data.balance))} FCFA
      <small>{account.data.balance > 0 ? ' (doit)' : account.data.balance < 0 ? ' (avoir)' : ''}</small>
      {fidelity.data?.enabled && (
        <small className="points" title={`Carte de fidélité : ${fidelity.data.balance} points, soit ${amount(fidelity.data.value)} FCFA`}>
          {' '}· ★ {fidelity.data.balance} pts
        </small>
      )}
    </span>
  );
  const keyStrip = (
    <div className="pos-keys">
      <span>
        <kbd>F1</kbd> Rechercher
      </span>
      <span>
        <kbd>F2</kbd> Valider + ticket
      </span>
      <span>
        <kbd>F7</kbd> Valider + listing
      </span>
      <span>
        <kbd>F4</kbd> Enregistrer
      </span>
      <span>
        <kbd>F3</kbd> Attente
      </span>
      <span>
        <kbd>F10</kbd> Rappeler
      </span>
      <span>
        <kbd>F5</kbd> Tiroir
      </span>
      <span>
        <kbd>F6</kbd> Remise
      </span>
      <span>
        <kbd>F8</kbd> Client
      </span>
      <span>
        <kbd>F9</kbd> Facture A4
      </span>
      <span>
        <kbd>Ctrl+E</kbd> Encaisser
      </span>
      <span>
        <kbd>Suppr</kbd> Enlever
      </span>
    </div>
  );
  const withDiscount = showDiscount || totals.totalDiscount > 0;
  const gridRows = Math.max(10, priced.length);

  // --- Présentation Classique : la fiche de facturation d'avant la 0.41 -------------
  if (layout === 'classic')
    return (
      <div className={`pc ${credit ? 'credit' : ''}`}>
        <div className="pc-band">
          <h2>{title}</h2>
          <div className="pc-mode">{credit ? 'Vente à crédit' : 'Vente au comptant'}</div>
          <div className="pc-info">{bandText}</div>
        </div>
        {staleNote}
        <div className="pc-body">
          <div className="pc-main">
            <div className="pc-head">
              <label>N°</label>
              <input readOnly value={ficheNumber} />
              <button className={`pc-client ${credit && !customer ? 'missing' : ''}`} title="Choisir le client (F8)" onClick={() => setDialog('customer')}>
                {customer ? customer.name.toUpperCase() : credit ? 'CHOISIR LE CLIENT (F8)' : 'CLIENT COMPTOIR'}
              </button>
              {customer ? (
                <button className="pc-small" title="Revenir au client comptoir" onClick={() => setCustomer(null)}>
                  ✕ {customer.code}
                </button>
              ) : (
                <button className="pc-small" onClick={() => setDialog('customer')}>
                  Client… <kbd>F8</kbd>
                </button>
              )}
              <span className="pc-count">{totals.itemCount} art.</span>
              <div className="pc-total">
                {amount(shownTotal)}
                <small>{tx('TTC')}</small>
              </div>
              <label>Date</label>
              <input readOnly value={now.toLocaleString('fr-FR')} />
              <div className="pc-second">
                {customer ? (
                  <>
                    {balanceChip}
                    <button className="pc-small" title="Extrait de compte du client" onClick={() => setDialog('statement')}>
                      Extrait
                    </button>
                  </>
                ) : (
                  !credit && nameInput
                )}
              </div>
              <div className="pc-opts">
                <label>Tarif</label>
                {tariffSelect}
                {depotSelect && <label>Dépôt</label>}
                {depotSelect}
                {optionChips}
              </div>
            </div>
            <div className="pc-tabs">
              <button className={pane === 'lines' ? 'active' : ''} onClick={() => setPane('lines')}>
                Produits commandés
              </button>
              <button className={pane === 'payments' ? 'active' : ''} onClick={() => setPane('payments')}>
                Règlements
              </button>
              <button className={pane === 'delivery' ? 'active' : ''} onClick={() => setPane('delivery')}>
                Livraison{delivery.on ? ' 🚚' : ''}
              </button>
              <button className={pane === 'extra' ? 'active' : ''} onClick={() => setPane('extra')}>
                Infos
              </button>
            </div>
            {pane === 'lines' ? (
              <>
                <form onSubmit={(e) => void onScan(e)} className="pc-tools">
                  <div className="pc-scan">
                    <input
                      ref={scanRef}
                      className="scan-input"
                      value={input}
                      onChange={(e) => setInput(e.target.value)}
                      onKeyDown={(e) => suggestions.onKeyDown(e, pickSuggestion)}
                      onBlur={suggestions.close}
                      autoComplete="off"
                      placeholder="Taper le début du nom produit ou scanner (3*code pour la quantité) · F1 recherche"
                    />
                    <SaleRowList s={suggestions} onPick={(r) => pickSuggestion(r)} />
                  </div>
                  {actionsMenu}
                </form>
                <div className="pc-grid">
                  <table>
                    <thead>
                      <tr>
                        <th className="n">N°</th>
                        <th className="ref">Réf.</th>
                        <th>Produit</th>
                        <th className="r">Qté</th>
                        <th>Cond.</th>
                        <th className="r">{tx('PU TTC')}</th>
                        {withDiscount && <th className="r">Remise</th>}
                        <th className="r">{tx('Total TTC')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {Array.from({ length: gridRows }, (_, i) => {
                        const l = priced[i];
                        if (!l)
                          return (
                            <tr key={`empty-${i}`} className="empty">
                              <td colSpan={withDiscount ? 8 : 7}>&nbsp;</td>
                            </tr>
                          );
                        return (
                          <tr key={l.key} className={l.key === selected ? 'sel' : ''} onClick={() => setSelected(l.key)} onDoubleClick={() => setDialog('vary')}>
                            <td className="n">{i + 1}</td>
                            <td className="ref">{l.ref}</td>
                            <td>
                              {l.label}
                              {l.promo > 0 && (
                                <span className="tag normal promo" title={l.promotionName ?? ''}>
                                  Promo −{amount(l.promo)}
                                </span>
                              )}
                            </td>
                            <td className="r">
                              <QtyCell line={l} onChange={(q) => setLineQty(l.key, q)} />
                            </td>
                            <td>{l.packId ? l.packs.find((p) => p.id === l.packId)?.name : l.unitName}</td>
                            <td className="r">{amount(l.packPrice ?? l.unitPrice)}</td>
                            {withDiscount && <td className="r">{l.discount ? amount(l.discount) : ''}</td>}
                            <td className="r">{amount(lineTotal(l))}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                    <tfoot>
                      <tr>
                        <td colSpan={3}>
                          Total{fee > 0 && lines.length > 0 && ` (dont livraison ${amount(fee)})`}
                          {totals.totalPromo > 0 && <span className="tag normal promo">Promotions −{amount(totals.totalPromo)}</span>}
                        </td>
                        <td className="r">{lines.length ? totals.itemCount : ''}</td>
                        <td colSpan={withDiscount ? 3 : 2} className="r">
                          {withDiscount && totals.totalDiscount ? `remises −${amount(totals.totalDiscount)}` : ''}
                        </td>
                        <td className="r">{amount(totals.totalTtc)}</td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </>
            ) : (
              <div className="pc-pane">{pane === 'payments' ? paymentsPane : pane === 'delivery' ? deliveryPane : extraPane}</div>
            )}
            <div className="pc-foot">
              <div className="pc-checks">
                <label>
                  <input type="checkbox" checked={showDiscount} onChange={(e) => setShowDiscount(e.target.checked)} /> Remise ?
                </label>
                {vatEnabled && (
                  <label>
                    <input type="checkbox" checked={showTaxes} onChange={(e) => setShowTaxes(e.target.checked)} /> Taxes ?
                  </label>
                )}
              </div>
              <div className="pc-taxes">
                {showTaxes && vatEnabled ? (
                  <>
                    <div>HT {amount(totals.totalHt)}</div>
                    {totals.vat
                      .filter((v) => v.tva > 0)
                      .map((v) => (
                        <div key={v.rate}>
                          TVA {(v.rate / 100).toLocaleString('fr-FR')} % : {amount(v.tva)}
                        </div>
                      ))}
                  </>
                ) : lines.length > 0 && cashDue < totals.totalTtc ? (
                  <>
                    <div>Espèces : {amount(cashDue)}</div>
                    <div className="muted">arrondi −{amount(totals.totalTtc - cashDue)}</div>
                  </>
                ) : null}
              </div>
              <div className="pc-bills">
                {BILLS.map((b) => (
                  <button key={b} type="button" disabled={!lines.length} onClick={() => setCashGiven((c) => c + b)}>
                    {amount(b)}
                  </button>
                ))}
                <button type="button" disabled={!lines.length} onClick={() => setCashGiven(cashDue)} title="Montant exact (arrondi espèces compris)">
                  =
                </button>
                <button type="button" disabled={!cashGiven} onClick={() => setCashGiven(0)} title="Remettre l'encaissé à zéro">
                  C
                </button>
              </div>
              <div className="pc-er">
                <span>E:</span> {given ? amount(given) : ''}
              </div>
              <div className="pc-er">
                <span>R:</span> {change ? amount(change) : ''}
              </div>
            </div>
          </div>
          <aside className="pc-actions">
            <button className="main" disabled={!lines.length} onClick={() => void validate('none')} title="Enregistre la vente sans imprimer">
              Valider / Nouv. <kbd>F4</kbd>
            </button>
            <button disabled={!lines.length || !can('sale_hold')} onClick={() => void hold()}>
              Mise en attente <kbd>F3</kbd>
            </button>
            <button disabled={!can('sale_resume')} onClick={() => setDialog('held')} title="Rappeler un ticket mis en attente">
              <span>
                Ouvrir (en attente)
                {heldCount > 0 && <b className="held-count">{heldCount}</b>}
              </span>
              <kbd>F10</kbd>
            </button>
            <button disabled={!lines.length} onClick={openPay}>
              Encaisser <kbd>Ctrl+E</kbd>
            </button>
            <hr />
            <button disabled={!lines.length && (!lastSale || !can('sale_reprint'))} onClick={listingKey} title={lines.length ? 'Valider et imprimer la facture listing' : 'Réimprimer la dernière facture en listing'}>
              Listing <kbd>F7</kbd>
            </button>
            <button disabled={!lines.length && (!lastSale || !can('sale_reprint'))} onClick={ticketKey} title={lines.length ? 'Valider et imprimer le ticket' : 'Réimprimer le dernier ticket'}>
              Ticket <kbd>F2</kbd>
            </button>
            <button disabled={!lastSale || lines.length > 0} onClick={printA4} title="Facture A4 du dernier ticket">
              Facture A4 <kbd>F9</kbd>
            </button>
            <button disabled={!lastSale || lines.length > 0} onClick={sendWhatsapp} title="Envoyer le dernier ticket au client par WhatsApp">
              WhatsApp
            </button>
            <button disabled={!can('drawer_open')} onClick={openDrawer} title="Ouvre le tiroir-caisse sans vente (tracé dans le journal)">
              Tiroir <kbd>F5</kbd>
            </button>
            <hr />
            <button disabled={!sel} onClick={() => setDialog('vary')}>
              Varier
            </button>
            <button disabled={!sel} onClick={() => setDialog('discount')}>
              Remise <kbd>F6</kbd>
            </button>
            <button disabled={!sel} onClick={() => sel && removeLine(sel.key)}>
              Enlever <kbd>Suppr</kbd>
            </button>
            <button className="danger" disabled={!lines.length} onClick={() => void askClear()}>
              Vider
            </button>
            <button className="close" onClick={closeFiche}>
              Fermer
            </button>
          </aside>
        </div>
        {keyStrip}
        {dialogs}
      </div>
    );

  // --- Présentation Conventionnel : grand total en haut, ligne de saisie, cadre Règlement ---
  if (layout === 'conventional')
    return (
      <div className={`pv ${credit ? 'credit' : ''}`}>
        <div className="pv-tool">
          <button onClick={() => void askClear()} disabled={!lines.length} title="Vider la fiche et en commencer une nouvelle">
            <i>＋</i>Nouveau
          </button>
          <button onClick={() => setDialog('customer')}>
            <i>👤</i>Client <kbd>F8</kbd>
          </button>
          <button onClick={() => openSearch(input)}>
            <i>🔍</i>Rechercher <kbd>F1</kbd>
          </button>
          <button disabled={!lines.length || !can('sale_hold')} onClick={() => void hold()}>
            <i>⏸</i>Attente <kbd>F3</kbd>
          </button>
          <button disabled={!can('sale_resume')} onClick={() => setDialog('held')}>
            <i>↺</i>Rappeler{heldCount > 0 && <b className="held-count">{heldCount}</b>} <kbd>F10</kbd>
          </button>
          <button disabled={!sel} onClick={() => setDialog('vary')}>
            <i>✎</i>Varier
          </button>
          <button disabled={!sel} onClick={() => setDialog('discount')}>
            <i>％</i>Remise <kbd>F6</kbd>
          </button>
          <button disabled={!can('drawer_open')} onClick={openDrawer}>
            <i>🗃</i>Tiroir <kbd>F5</kbd>
          </button>
          <button className={pane === 'delivery' ? 'on' : ''} onClick={() => setPane(pane === 'delivery' ? 'lines' : 'delivery')}>
            <i>🚚</i>Livraison{delivery.on ? ' ✓' : ''}
          </button>
          <span className="pv-spacer" />
          <div className="pv-mode" role="group" aria-label="Type de vente">
            <button className={credit ? '' : 'on'} disabled={!credit} onClick={() => (lines.length ? toast.error('Terminez ou mettez en attente la fiche en cours') : onSwitchMode?.())}>
              Comptant
            </button>
            <button className={credit ? 'on' : ''} disabled={credit} onClick={() => (lines.length ? toast.error('Terminez ou mettez en attente la fiche en cours') : onSwitchMode?.())}>
              Crédit
            </button>
          </div>
          {actionsMenu}
        </div>
        {staleNote}
        <div className="pv-top">
          <div className="pv-fields">
            <label>Caissier</label>
            <span className="pv-box">{user.name}</span>
            <label>Date</label>
            <span className="pv-box">{now.toLocaleDateString('fr-FR')}</span>
            <label>N°</label>
            <span className="pv-box">{ficheNumber}</span>
            <label>Client</label>
            <div className="pv-client">
              <button className={`pv-box pv-pick ${credit && !customer ? 'missing' : ''}`} onClick={() => setDialog('customer')} title="Choisir le client (F8)">
                {customer ? customer.name : credit ? 'Choisir le client (F8)' : 'Client comptoir'}
              </button>
              {customer && (
                <button className="pv-x" title="Revenir au client comptoir" onClick={() => setCustomer(null)}>
                  ✕
                </button>
              )}
              {balanceChip}
            </div>
            <label>Tarif</label>
            {tariffSelect}
            {depotSelect ? <label>Dépôt</label> : <span />}
            {depotSelect ?? <span />}
          </div>
          <div className="pv-total">
            <span>{tx('Total TTC')}</span>
            <b>{amount(shownTotal)}</b>
          </div>
        </div>
        {pane === 'delivery' ? (
          <div className="pv-delivery">{deliveryPane}</div>
        ) : (
          <>
            <form
              className="pv-entry"
              onSubmit={(e) => {
                const q = entryQty.trim() && entryQty.trim() !== '1' ? entryQty.trim() : undefined;
                setEntryQty('1');
                void onScan(e, q);
              }}
            >
              <label className="pv-grow">
                Référence / Désignation
                <div className="pv-scan">
                  <input
                    ref={scanRef}
                    className="scan-input"
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={(e) =>
                      suggestions.onKeyDown(e, (r) => {
                        const q = entryQty.trim() && entryQty.trim() !== '1' ? entryQty.trim() : undefined;
                        setEntryQty('1');
                        pickSuggestion(r, q);
                      })
                    }
                    onBlur={suggestions.close}
                    autoComplete="off"
                    placeholder="Taper le nom ou scanner le code-barres"
                  />
                  <SaleRowList
                    s={suggestions}
                    onPick={(r) => {
                      const q = entryQty.trim() && entryQty.trim() !== '1' ? entryQty.trim() : undefined;
                      setEntryQty('1');
                      pickSuggestion(r, q);
                    }}
                  />
                </div>
              </label>
              <label>
                Quantité
                <input className="pv-qty" inputMode="decimal" value={entryQty} onChange={(e) => setEntryQty(e.target.value)} onFocus={(e) => e.target.select()} />
              </label>
              <button type="button" disabled={!sel} onClick={() => sel && removeLine(sel.key)} title="Enlever la ligne choisie (Suppr)">
                Supprimer
              </button>
              <button type="submit" className="g" title="Ajouter le produit (Entrée)">
                Enregistrer la ligne
              </button>
            </form>
            <div className="pv-grid">
              <table>
                <thead>
                  <tr>
                    <th>Référence</th>
                    <th>Désignation</th>
                    <th className="r">{tx('P.U. TTC')}</th>
                    <th className="r">Quantité</th>
                    <th>Cond.</th>
                    <th className="r">Remise</th>
                    <th className="r">{tx('Montant TTC')}</th>
                  </tr>
                </thead>
                <tbody>
                  {priced.map((l) => (
                    <tr key={l.key} className={l.key === selected ? 'sel' : ''} onClick={() => setSelected(l.key)} onDoubleClick={() => setDialog('vary')}>
                      <td>{l.ref}</td>
                      <td>
                        {l.label}
                        {l.promo > 0 && <span className="tag normal promo">Promo −{amount(l.promo)}</span>}
                      </td>
                      <td className="r">{amount(l.packPrice ?? l.unitPrice)}</td>
                      <td className="r">
                        <QtyCell line={l} onChange={(q) => setLineQty(l.key, q)} />
                      </td>
                      <td>{l.packId ? l.packs.find((p) => p.id === l.packId)?.name : l.unitName}</td>
                      <td className="r">{l.discount ? amount(l.discount) : ''}</td>
                      <td className="r">{amount(lineTotal(l))}</td>
                    </tr>
                  ))}
                  {!priced.length && (
                    <tr className="empty">
                      <td colSpan={7}>Aucun article : saisissez ou scannez un produit.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </>
        )}
        <div className="pv-low">
          <div className="pv-pan">
            <h4>Informations</h4>
            {!customer && !credit && nameInput}
            <div className="pv-line">
              {optionChips}
              {delivery.on && <span className="tag info">À livrer{delivery.courier ? ` · ${delivery.courier}` : ''}</span>}
            </div>
            <div className="pv-line muted">
              {totals.itemCount} article{totals.itemCount > 1 ? 's' : ''}
              {fee > 0 && lines.length > 0 && ` · livraison ${amount(fee)}`}
              {totals.totalDiscount > 0 && ` · remises −${amount(totals.totalDiscount)}`}
              {totals.totalPromo > 0 && ` · promotions −${amount(totals.totalPromo)}`}
            </div>
            {vatEnabled && (
              <div className="pv-line muted">
                {tx('Total HT')} {amount(totals.totalHt)}
                {totals.vat
                  .filter((v) => v.tva > 0)
                  .map((v) => ` · TVA ${(v.rate / 100).toLocaleString('fr-FR')} % : ${amount(v.tva)}`)
                  .join('')}
              </div>
            )}
          </div>
          <div className="pv-pan pv-pay">
            <h4>Règlement</h4>
            <div className="pv-payrow">
              <label>Mode de règlement</label>
              <select
                value="cash"
                onChange={(e) => {
                  if (e.target.value === 'other') openPay();
                }}
                disabled={!lines.length}
              >
                <option value="cash">{credit ? 'Espèces (acompte), reste au compte' : 'Espèces'}</option>
                <option value="other">Mobile Money, carte, bon, mixte…</option>
              </select>
            </div>
            <div className="pv-payrow">
              <label>Montant réglé</label>
              <input
                inputMode="numeric"
                disabled={!lines.length}
                value={lines.length ? (cashGiven ? amount(cashGiven) : '') : given ? amount(given) : ''}
                onChange={(e) => setCashGiven(parseAmount(e.target.value) ?? 0)}
                placeholder={lines.length ? amount(cashDue) : ''}
              />
              <button type="button" disabled={!lines.length} onClick={() => setCashGiven(cashDue)} title="Montant exact">
                =
              </button>
            </div>
            <div className="pv-rendre">
              <span>A rendre</span>
              <b>{change ? amount(change) : '0'}</b>
            </div>
          </div>
        </div>
        <div className="pv-actions">
          <button disabled={!lines.length && (!lastSale || !can('sale_reprint'))} onClick={ticketKey} title={lines.length ? 'Valider et imprimer le ticket' : 'Réimprimer le dernier ticket'}>
            Ticket <kbd>F2</kbd>
          </button>
          <button disabled={!lines.length && (!lastSale || !can('sale_reprint'))} onClick={listingKey} title={lines.length ? 'Valider et imprimer la facture listing' : 'Réimprimer la dernière facture en listing'}>
            Listing <kbd>F7</kbd>
          </button>
          <button disabled={!lastSale || lines.length > 0} onClick={printA4}>
            Facture A4 <kbd>F9</kbd>
          </button>
          <button disabled={!lastSale || lines.length > 0} onClick={sendWhatsapp} title="Envoyer le dernier ticket au client par WhatsApp">
            WhatsApp
          </button>
          <button disabled={!lines.length} onClick={openPay}>
            Encaisser <kbd>Ctrl+E</kbd>
          </button>
          <button className="g" disabled={!lines.length} onClick={() => void validate('none')} title="Enregistre la vente sans imprimer">
            Valider <kbd>F4</kbd>
          </button>
          <span className="pv-spacer" />
          <button onClick={closeFiche}>Fermer</button>
        </div>
        {keyStrip}
        {dialogs}
      </div>
    );

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
            <div className="opt-seg" role="group" aria-label="Tarif" title="Tarif de cette fiche ; par défaut celui du client (détail pour le client comptoir)">
              <span>Tarif</span>
              {(Object.keys(PRICE_LEVELS) as PriceLevel[]).map((k) => (
                <button
                  key={k}
                  type="button"
                  className={level === k ? 'on' : ''}
                  onClick={() => pickLevel(k)}
                >
                  {PRICE_LEVELS[k]}
                </button>
              ))}
            </div>
            {(warehouses.data?.length ?? 0) > 1 && (
              <div className="opt-seg" role="group" aria-label="Dépôt" title="Dépôt d'où sort la marchandise de cette fiche">
                <span>Dépôt</span>
                {warehouses.data!.map((w) => (
                  <button
                    key={w.id}
                    type="button"
                    className={(warehouseChoice ?? salesWarehouse?.id) === w.id ? 'on' : ''}
                    onClick={() => pickWarehouse(w.id)}
                  >
                    {w.name}
                  </button>
                ))}
              </div>
            )}
            {actionsMenu}
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
                    className={`pos-tile ${i === suggestions.active ? 'hit' : ''} ${r.out_of_stock ? 'out' : r.available < r.units * 5 ? 'low' : ''}`}
                    style={tileColor(r.name)}
                    title={stockByDepot(r) || undefined}
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
                      <strong>{amount(tariffPrice({ retail: a.store_price, wholesale: a.wholesale_price, superWholesale: a.super_wholesale_price }, level))}</strong>
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
            {(customer || level !== 'retail' || warehouseChoice) && (
              <div className="tk-row tk-chips">
                {level !== 'retail' && (
                  <span className="tag surstock" title={levelChoice ? 'Tarif choisi pour cette fiche' : 'Tarif de ce client'}>
                    Tarif {PRICE_LEVELS[level].toLowerCase()}
                  </span>
                )}
                {warehouseChoice && <span className="tag surstock">Sortie {warehouses.data?.find((w) => w.id === warehouseChoice)?.name}</span>}
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
            {!customer && !credit && nameInput}
            <div className="tk-tabs">
              <button className={pane === 'lines' ? 'on' : ''} onClick={() => setPane('lines')}>
                Articles{lines.length ? ` (${lines.length})` : ''}
              </button>
              <button className={pane === 'payments' ? 'on' : ''} onClick={() => setPane('payments')}>
                Règlements
              </button>
              <button className={pane === 'delivery' ? 'on' : ''} title="Livrer cette vente chez le client" onClick={() => setPane('delivery')}>
                Livraison{delivery.on ? ' 🚚' : ''}
              </button>
              <button className={pane === 'extra' ? 'on' : ''} onClick={() => setPane('extra')}>
                Infos
              </button>
              <span className="tk-meta" title={title}>
                {ficheNumber}
              </span>
            </div>
            {quote && lines.length > 0 ? (
              <div className="tk-note">{`${quote.number} · prix garantis jusqu'au ${new Date(`${quote.validUntil}T12:00:00`).toLocaleDateString('fr-FR')}`}</div>
            ) : null}
          </div>

          {pane === 'lines' && (
            <div className="tk-lines">
              {!priced.length && <p className="tk-empty">Aucun article : scannez ou touchez un produit.</p>}
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

          {pane === 'payments' && paymentsPane}

          {pane === 'delivery' && deliveryPane}

          {pane === 'extra' && extraPane}

          <div className="tk-foot">
            <div className="tk-sum">
              <span>
                {totals.itemCount} article{totals.itemCount > 1 ? 's' : ''}
                {fee > 0 && lines.length > 0 && ` · livraison ${amount(fee)}`}
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
            <div className="tk-total">
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
            {heldCount > 0 && <b className="held-count">{heldCount}</b>}
          </span>
          <kbd>F10</kbd>
        </button>
        <button disabled={!can('drawer_open')} onClick={openDrawer} title="Ouvre le tiroir-caisse sans vente (tracé dans le journal)" style={{ '--c': '#0891b2' } as React.CSSProperties}>
          <i aria-hidden>🗃</i>Tiroir <kbd>F5</kbd>
        </button>
        <button disabled={!lines.length && (!lastSale || !can('sale_reprint'))} onClick={ticketKey} title={lines.length ? 'Valider et imprimer le ticket de caisse' : 'Réimprimer le dernier ticket'} style={{ '--c': '#7c3aed' } as React.CSSProperties}>
          <i aria-hidden>🧾</i>Ticket <kbd>F2</kbd>
        </button>
        <button disabled={!lastSale || lines.length > 0} onClick={printA4} title="Facture A4 du dernier ticket" style={{ '--c': '#7c3aed' } as React.CSSProperties}>
          <i aria-hidden>📄</i>Facture A4 <kbd>F9</kbd>
        </button>
        <button disabled={!lastSale || lines.length > 0} onClick={sendWhatsapp} title="Envoyer le dernier ticket au client par WhatsApp" style={{ '--c': '#16a34a' } as React.CSSProperties}>
          <i aria-hidden>💬</i>WhatsApp
        </button>
        <button disabled={!lines.length && (!lastSale || !can('sale_reprint'))} onClick={listingKey} title={lines.length ? 'Valider et imprimer la facture listing' : 'Réimprimer la dernière facture en listing'} style={{ '--c': '#7c3aed' } as React.CSSProperties}>
          <i aria-hidden>☰</i>Listing <kbd>F7</kbd>
        </button>
        <button disabled={!lines.length} onClick={async () => {
            if (await askConfirm('Vider la fiche en cours ?')) clear();
            focusScan();
          }} style={{ '--c': '#dc2626' } as React.CSSProperties}>
          <i aria-hidden>🗑</i>Vider
        </button>
        <button onClick={() => (lines.length ? toast.error('Terminez ou mettez en attente la fiche en cours') : onClose())} title="Fermer la fiche" style={{ '--c': '#94a3b8' } as React.CSSProperties}>
          <i aria-hidden>✕</i>Fermer
        </button>
        <button className="pay" disabled={!lines.length} onClick={openPay} title="Mobile Money, carte, bon d'achat, paiements mixtes">
          <i aria-hidden>💳</i>Encaisser <kbd>Ctrl+E</kbd>
        </button>
        <button className="go" disabled={!lines.length} onClick={() => void validate('none')} title="Enregistre la fiche sans rien imprimer">
          <i aria-hidden>✓</i>
          <span>
            VALIDER
            <small>sans imprimer · F4</small>
          </span>
        </button>
      </div>

      {dialogs}
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
