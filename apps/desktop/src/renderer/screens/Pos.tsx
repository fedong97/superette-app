import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type CartLine, PAYMENT_METHODS, computeTotals, formatFcfa, lineTotal } from '@superette/core';
import { type ApiError, type Result, call } from '../api';
import { Empty, Field, Modal, SupervisorPrompt, fcfa, parseAmount, parseQty, qty, useLoad, useToast } from '../ui';
import { type Customer, CustomerPaymentDialog, CustomerPickDialog } from './customerDialogs';
import { ExpenseDialog } from './Expenses';
import { QuotePickDialog } from './Quotes';
import { SuggestionList, useArticleSuggestions } from './pickers';
import { CancelDialog, CashOpDialog, CloseDialog, HeldDialog, PaymentDialog, ReturnDialog } from './PosDialogs';

type Article = Result<'catalogue.get'>;
type User = NonNullable<Result<'app.state'>['user']>;

export interface PosLine extends CartLine {
  key: number;
  ref: string;
  unit: Article['unit'];
  barcode: string | null;
}

let keySeq = 0;

function toLine(article: Article, qtyMilli: number, barcode: string | null, fixedAmount?: number): PosLine {
  return {
    key: ++keySeq,
    ref: article.code,
    articleId: article.id,
    label: article.name,
    unit: article.unit,
    unitPrice: article.store_price,
    qty: qtyMilli,
    vatRate: article.vat_rate_bp,
    discount: 0,
    fixedAmount,
    barcode,
  };
}

type Dialog = null | 'pay' | 'close' | 'held' | 'cancel' | 'return' | 'cashIn' | 'cashOut' | 'search' | 'weight' | 'discount' | 'vary' | 'customer' | 'custPay' | 'expense' | 'quote';
type SellPayments = { method: 'CASH' | 'CUSTOMER_CREDIT' | Result<'pos.sell'>['payments'][number]['method']; amount: number; reference?: string }[];
type Pane = 'lines' | 'payments' | 'extra';

const UNIT_LABEL = { piece: 'Pièce', kg: 'Kg', litre: 'Litre' } as const;
const BILLS = [1000, 2000, 5000, 10000];
const amount = (v: number) => formatFcfa(v, false);

/**
 * Fiche de facturation (vente au comptant ou à crédit), sur le modèle de KONTROL :
 * saisie produit, grille, grand total TTC, billets rapides avec encaissé
 * et rendu, boutons d'action à droite et raccourcis clavier en bas.
 * Plusieurs fiches peuvent être ouvertes en même temps (V. cash 1, V. cash 2).
 */
export function Pos({ user, hasRegister, active, title, onClose, onListing, mode = 'cash' }: {
  mode?: 'cash' | 'credit';
  user: User;
  hasRegister: boolean;
  active: boolean;
  title: string;
  onClose: () => void;
  onListing: () => void;
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
  const [showDiscount, setShowDiscount] = useState(false);
  const [showTaxes, setShowTaxes] = useState(false);
  const [now, setNow] = useState(() => new Date());
  const [searchResults, setSearchResults] = useState<Article[]>([]);
  const [weightFor, setWeightFor] = useState<Article | null>(null);
  const [lastSale, setLastSale] = useState<Result<'pos.sell'> | null>(null);
  const [customer, setCustomer] = useState<Customer | null>(null);
  /** Devis ou proforma chargé : ses prix garantis valent accord de remise. */
  const [quote, setQuote] = useState<{ id: string; number: string; validUntil: string } | null>(null);
  const account = useLoad(() => (customer ? call('customers.account', customer.id) : Promise.resolve(null)), [customer?.id]);
  /** Vente bloquée en attente du code gérant (remise ou dépassement du plafond). */
  const [pending, setPending] = useState<{ payments: SellPayments; supervisorPin?: string; reason: 'discount' | 'credit'; message: string } | null>(null);
  const credit = mode === 'credit';
  const scanRef = useRef<HTMLInputElement>(null);
  const totals = useMemo(() => computeTotals(lines), [lines]);

  const focusScan = useCallback(() => setTimeout(() => scanRef.current?.focus(), 0), []);
  useEffect(() => {
    if (!dialog && active) focusScan();
  }, [dialog, active, focusScan]);
  useEffect(() => {
    if (active) session.reload();
  }, [active]);
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  const addLine = (line: PosLine) => {
    setLines((ls) => {
      // Même article à la pièce sans remise : on cumule la quantité.
      const same = line.fixedAmount === undefined && line.unit === 'piece' ? ls.find((l) => l.articleId === line.articleId && !l.discount && l.fixedAmount === undefined) : undefined;
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

  // « 3*riz » : suggestions sur « riz », l'article choisi est ajouté 3 fois.
  const multiplied = /^(\d+(?:[.,]\d+)?)\*(.*)$/.exec(input.trim());
  const suggestQuery = multiplied ? multiplied[2]! : input;
  const suggestions = useArticleSuggestions(suggestQuery);
  const pickSuggestion = (a: Article) => {
    const mult = multiplied ? parseQty(multiplied[1]!) : null;
    setInput('');
    addArticle(a, mult ?? 1000);
    scanRef.current?.focus();
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
          const q = mult ? Math.round((hit.qty * mult) / 1000) : hit.qty;
          addLine(toLine(hit.article, q, hit.barcode, hit.fixedAmount));
        } else {
          addArticle(hit.article, mult ?? 1000);
        }
        return;
      }
      const found = await call('catalogue.suggest', code);
      if (found.length === 1) addArticle(found[0]!, mult ?? 1000);
      else if (found.length === 0) toast.error(`Article introuvable : ${code}`);
      else {
        setSearchResults(found);
        setDialog('search');
      }
    } catch (err) {
      toast.error(err);
    }
  };

  const changeQty = (key: number, delta: number) =>
    setLines((ls) => ls.map((l) => (l.key === key && l.fixedAmount === undefined ? { ...l, qty: Math.max(1000, l.qty + delta) } : l)));
  const removeLine = (key: number) => {
    setLines((ls) => ls.filter((l) => l.key !== key));
    setSelected(null);
  };
  const clear = () => {
    setQuote(null);
    setLines([]);
    setCashGiven(0);
    setSelected(null);
  };

  const saleInput = () => lines.map((l) => ({ articleId: l.articleId, qty: l.qty, barcode: l.barcode, discount: l.discount }));

  const finish = (sale: Result<'pos.sell'>) => {
    setLines([]);
    setSelected(null);
    setLastSale(sale);
    setDialog(null);
    setCustomer(null);
    setQuote(null);
    call('pos.printTicket', sale.id, { newSale: true }).catch((err) => toast.error(err));
  };

  /**
   * Envoie la vente ; si le serveur demande l'accord d'un gérant (remise d'un
   * caissier, plafond de crédit dépassé), on demande son code puis on relance.
   */
  const sell = async (payments: SellPayments, pins: { supervisorPin?: string; creditPin?: string } = {}) => {
    try {
      finish(await call('pos.sell', { lines: saleInput(), payments: payments as never, customerId: customer?.id ?? null, quoteId: quote?.id ?? null, ...pins }));
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
    const needsSupervisor = totals.totalDiscount > 0 && user.role === 'cashier' && !quote;
    if (cashGiven >= totals.totalTtc && !needsSupervisor) {
      await sell([{ method: 'CASH', amount: cashGiven }]);
      return;
    }
    setDialog('pay');
  };

  const hold = async () => {
    if (!lines.length) return;
    const label = `Ticket de ${new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })} (${fcfa(totals.totalTtc)})`;
    try {
      await call('pos.hold', label, saleInput());
      clear();
      toast.ok('Ticket mis en attente');
    } catch (err) {
      toast.error(err);
    }
  };

  const resume = async (id: string) => {
    try {
      const saved = await call('pos.resume', id);
      const priced = await call('pos.priceLines', saved);
      const arts = await Promise.all(priced.map((p) => call('catalogue.get', p.articleId)));
      setLines(priced.map((p, i) => ({ ...p, key: ++keySeq, ref: arts[i]!.code, unit: arts[i]!.unit, barcode: p.barcode })));
      setDialog(null);
    } catch (err) {
      toast.error(err);
    }
  };

  /** Charge un devis : ses lignes aux prix garantis et son client. */
  const loadQuote = async (id: string) => {
    if (lines.length) return toast.error('Terminez ou mettez en attente le ticket en cours');
    try {
      const q = await call('quotes.get', id);
      const priced = await call('pos.priceLines', await call('quotes.saleLines', id));
      const arts = await Promise.all(priced.map((p) => call('catalogue.get', p.articleId)));
      setLines(priced.map((p, i) => ({ ...p, key: ++keySeq, ref: arts[i]!.code, unit: arts[i]!.unit, barcode: p.barcode })));
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
    if (lastSale) call('pos.printTicket', lastSale.id).catch(toast.error);
    else toast.error('Aucun ticket à réimprimer');
  };

  const openDrawer = () => {
    call('pos.openDrawer').then(() => toast.ok('Tiroir ouvert'), toast.error);
  };

  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (dialog) return;
      const fn: Record<string, () => void> = {
        F2: reprint,
        F3: () => void hold(),
        F4: () => void validate(),
        F5: openDrawer,
        F6: () => selected !== null && setDialog('discount'),
        F7: onListing,
        F8: () => setDialog('customer'),
        F9: printA4,
      };
      if (fn[e.key]) {
        e.preventDefault();
        fn[e.key]!();
      } else if (e.ctrlKey && e.key.toLowerCase() === 'e' && lines.length) {
        e.preventDefault();
        setDialog('pay');
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

  if (!hasRegister) return <Empty>Ce poste n'est pas activé comme caisse. Activez-le depuis Administration › Caisses.</Empty>;
  if (!session.data) return session.data === null ? <OpenSession onOpened={session.reload} /> : null;

  const sel = lines.find((l) => l.key === selected);
  const salesWarehouse = (warehouses.data ?? []).find((w) => w.is_sales_default) ?? warehouses.data?.[0];
  const withDiscount = showDiscount || totals.totalDiscount > 0;
  const shownTotal = lines.length ? totals.totalTtc : (lastSale?.total_ttc ?? 0);
  const change = lines.length ? Math.max(0, cashGiven - totals.totalTtc) : (lastSale?.change_given ?? 0);
  // Après validation : espèces réellement reçues (rien pour une vente entièrement à crédit).
  const given = lines.length ? cashGiven : lastSale ? lastSale.payments.filter((p) => p.method === 'CASH').reduce((t, p) => t + p.amount, 0) : 0;
  const rows = Math.max(12, lines.length);

  return (
    <div className="fiche">
      <div className="fiche-band">
        <h2>{title}</h2>
        <div className={`band-mode ${credit ? 'credit' : ''}`}>{credit ? 'Vente à crédit' : 'Vente au comptant'}</div>
        <div className={`band-delivery ${credit ? 'credit' : ''}`}>
          {credit && customer && account.data
            ? `Doit ${amount(account.data.balance)} · disponible ${amount(account.data.available)} FCFA`
            : !lines.length && lastSale?.customer_name
              ? `${lastSale.customer_name}${lastSale.due_date ? ` · à régler avant le ${new Date(`${lastSale.due_date}T12:00:00`).toLocaleDateString('fr-FR')}` : ''}`
              : quote && lines.length
                ? `${quote.number} · prix garantis jusqu'au ${new Date(`${quote.validUntil}T12:00:00`).toLocaleDateString('fr-FR')}`
                : 'Livraison immédiate'}
        </div>
      </div>
      <div className="fiche-body">
        <div className="fiche-main">
          <div className="fiche-head">
            <label>N°</label>
            <input readOnly value={lines.length ? (quote ? `Devis ${quote.number}` : 'Nouveau') : (lastSale?.number ?? 'Nouveau')} />
            <input
              className={`client ${credit && !customer ? 'missing' : ''}`}
              readOnly
              value={customer ? customer.name.toUpperCase() : credit ? 'CHOISIR LE CLIENT (F8)' : 'CLIENT COMPTOIR'}
              title="Choisir le client (F8)"
              onClick={() => setDialog('customer')}
            />
            {customer ? (
              <button className="client-clear" title="Revenir au client comptoir" onClick={() => setCustomer(null)}>
                ✕ {customer.code}
              </button>
            ) : (
              <button className="client-clear" onClick={() => setDialog('customer')}>
                Client… <kbd>F8</kbd>
              </button>
            )}
            <span className="count">
              {totals.itemCount} art.
            </span>
            <div className={`fiche-total ${!lines.length && lastSale ? 'done' : ''}`}>
              {amount(shownTotal)}
              <small>TTC</small>
            </div>
            <label>Date</label>
            <input readOnly value={now.toLocaleString('fr-FR')} />
          </div>

          <div className="fiche-tabs">
            <button className={pane === 'lines' ? 'active' : ''} onClick={() => setPane('lines')}>
              Produits commandés
            </button>
            <button className={pane === 'payments' ? 'active' : ''} onClick={() => setPane('payments')}>
              Règlements
            </button>
            <button disabled title="Arrive avec le module Clients">
              Livraisons
            </button>
            <button className={pane === 'extra' ? 'active' : ''} onClick={() => setPane('extra')}>
              Extra infos
            </button>
          </div>

          {pane === 'lines' && (
            <>
              <form onSubmit={onScan} className="fiche-tools">
                <div className="scan-wrap">
                  <input
                    ref={scanRef}
                    className="scan-input"
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={(e) => suggestions.onKeyDown(e, pickSuggestion)}
                    onBlur={suggestions.close}
                    autoComplete="off"
                    placeholder="Taper le début du nom produit ou scanner (3*code)"
                  />
                  <SuggestionList s={suggestions} onPick={pickSuggestion} query={suggestQuery} />
                </div>
                <label>Grille tarif.</label>
                <select defaultValue="detail">
                  <option value="detail">Détail</option>
                  <option disabled>Gros (bientôt)</option>
                </select>
                <label>Dépôt</label>
                <select value={salesWarehouse?.id ?? ''} disabled title="La vente sort du dépôt « surface de vente » du magasin">
                  {salesWarehouse && <option value={salesWarehouse.id}>{salesWarehouse.name.toUpperCase()}</option>}
                </select>
                <select
                  className="action"
                  value=""
                  onChange={(e) => {
                    const v = e.target.value as Dialog | 'close';
                    if (v === 'close' && lines.length) return toast.error('Terminez ou mettez en attente le ticket en cours');
                    setDialog(v);
                  }}
                >
                  <option value="" disabled>
                    Action
                  </option>
                  <option value="cashIn">Apport espèces</option>
                  <option value="cashOut">Prélèvement</option>
                  <option value="cancel">Annuler un ticket</option>
                  <option value="return">Retour client</option>
                  <option value="custPay">Règlement client (crédit)</option>
                  <option value="quote">Facturer un devis / proforma</option>
                  <option value="expense">Dépense payée en caisse</option>
                  <option value="close">Clôture de caisse (Z)</option>
                </select>
              </form>

              <div className={`fiche-grid-wrap ${quickKeys.data?.length ? '' : 'no-quick'}`}>
                <div className="fiche-grid">
                  <table>
                    <thead>
                      <tr>
                        <th className="n">N°</th>
                        <th className="ref">Réf.</th>
                        <th>Produit</th>
                        <th className="r">Qté</th>
                        {withDiscount && <th className="r">Remise</th>}
                        <th>Cond.</th>
                        <th className="r">PU TTC</th>
                        <th className="r">Total TTC</th>
                      </tr>
                    </thead>
                    <tbody>
                      {Array.from({ length: rows }, (_, i) => {
                        const l = lines[i];
                        if (!l)
                          return (
                            <tr key={`empty-${i}`} className="empty-row">
                              <td colSpan={withDiscount ? 8 : 7}>&nbsp;</td>
                            </tr>
                          );
                        return (
                          <tr key={l.key} className={l.key === selected ? 'sel' : ''} onClick={() => setSelected(l.key)} onDoubleClick={() => setDialog('vary')}>
                            <td className="n">{i + 1}</td>
                            <td className="ref">{l.ref}</td>
                            <td>{l.label}</td>
                            <td className="r">{qty(l.qty, l.unit)}</td>
                            {withDiscount && <td className="r">{l.discount ? amount(l.discount) : ''}</td>}
                            <td>{UNIT_LABEL[l.unit]}</td>
                            <td className="r">{amount(l.unitPrice)}</td>
                            <td className="r">{amount(lineTotal(l))}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                    <tfoot>
                      <tr>
                        <td colSpan={3}>Total</td>
                        <td className="r">{lines.length ? totals.itemCount : ''}</td>
                        {withDiscount && <td className="r">{totals.totalDiscount ? amount(totals.totalDiscount) : ''}</td>}
                        <td colSpan={2}></td>
                        <td className="r">{amount(totals.totalTtc)}</td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
                <div className="fiche-quick">
                  {(quickKeys.data ?? []).map((a) => (
                    <button key={a.id} onClick={() => addArticle(a)}>
                      {a.name}
                      <small>
                        {fcfa(a.store_price)}
                        {a.unit !== 'piece' ? ` / ${a.unit === 'kg' ? 'kg' : 'L'}` : ''}
                      </small>
                    </button>
                  ))}
                </div>
              </div>
            </>
          )}

          {pane === 'payments' && (
            <div className="fiche-pane">
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
                  Le règlement se fait à la validation (F4) : espèces avec les billets rapides, ou Ctrl+E pour MTN Mobile Money, Orange Money,
                  carte, bon d'achat et paiements mixtes.
                </p>
              )}
            </div>
          )}

          {pane === 'extra' && (
            <div className="fiche-pane">
              <table className="list compact">
                <tbody>
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

          <div className="fiche-foot">
            <div className="checks-col">
              <label>
                <input type="checkbox" checked={showDiscount} onChange={(e) => setShowDiscount(e.target.checked)} /> Remise ?
              </label>
              <label>
                <input type="checkbox" checked={showTaxes} onChange={(e) => setShowTaxes(e.target.checked)} /> Taxes ?
              </label>
            </div>
            {showTaxes ? (
              <div className="taxes">
                <div>HT {amount(totals.totalHt)}</div>
                {totals.vat.filter((v) => v.tva > 0).map((v) => (
                  <div key={v.rate}>TVA {(v.rate / 100).toLocaleString('fr-FR')} % : {amount(v.tva)}</div>
                ))}
              </div>
            ) : (
              <div className="taxes" />
            )}
            <div className="bills">
              {BILLS.map((b) => (
                <button key={b} type="button" disabled={!lines.length} onClick={() => setCashGiven((c) => c + b)}>
                  {amount(b)}
                </button>
              ))}
              <button type="button" className="exact" disabled={!lines.length} onClick={() => setCashGiven(totals.totalTtc)} title="Montant exact">
                =
              </button>
              <button type="button" className="exact" disabled={!cashGiven} onClick={() => setCashGiven(0)} title="Remettre l'encaissé à zéro">
                C
              </button>
            </div>
            <div className="er">
              <span>E:</span> {given ? amount(given) : ''}
            </div>
            <div className="er">
              <span>R:</span> {change ? amount(change) : ''}
            </div>
          </div>
        </div>

        <aside className="fiche-actions">
          <button className="main" disabled={!lines.length} onClick={() => void validate()}>
            Valider / Nouv. <kbd>F4</kbd>
          </button>
          <button disabled={!lines.length} onClick={() => void hold()}>
            Mise en attente <kbd>F3</kbd>
          </button>
          <button onClick={() => setDialog('held')}>Ouvrir (en attente)</button>
          <button disabled={!lines.length} onClick={() => setDialog('pay')}>
            Encaisser <kbd>Ctrl+E</kbd>
          </button>
          <hr />
          <button onClick={onListing}>
            Listing <kbd>F7</kbd>
          </button>
          <button disabled={!lastSale} onClick={reprint}>
            Ticket <kbd>F2</kbd>
          </button>
          <button disabled={!lastSale || lines.length > 0} onClick={printA4} title="Facture A4 du dernier ticket">
            Facture A4 <kbd>F9</kbd>
          </button>
          <button onClick={openDrawer} title="Ouvre le tiroir-caisse sans vente (tracé dans le journal)">
            Tiroir <kbd>F5</kbd>
          </button>
          <hr />
          <button disabled={!sel} onClick={() => setDialog('vary')}>
            Varier
          </button>
          <button disabled={!sel} onClick={() => sel && removeLine(sel.key)}>
            Enlever
          </button>
          <button className="danger" disabled={!lines.length} onClick={() => confirm('Vider la fiche en cours ?') && clear()}>
            Vider
          </button>
          <button className="close" onClick={() => (lines.length ? toast.error('Terminez ou mettez en attente la fiche en cours') : onClose())}>
            Fermer
          </button>
        </aside>
      </div>

      <div className="shortcuts">
        <span>
          <kbd>Suppr</kbd> Enlever
        </span>
        <span>
          <kbd>+</kbd>/<kbd>−</kbd> Quantité
        </span>
        <span>
          <kbd>F6</kbd> Remise
        </span>
        <span>
          <kbd>F3</kbd> Mise en attente
        </span>
        <span>
          <kbd>F4</kbd> Valider
        </span>
        <span>
          <kbd>F2</kbd> Ticket
        </span>
        <span>
          <kbd>F5</kbd> Tiroir
        </span>
        <span>
          <kbd>F7</kbd> Listing
        </span>
        <span>
          <kbd>Ctrl+E</kbd> Encaisser
        </span>
        <span>
          <kbd>F8</kbd> Client
        </span>
        <span>
          <kbd>F9</kbd> Facture A4
        </span>
      </div>

      {dialog === 'pay' && (
        <PaymentDialog
          total={totals.totalTtc}
          needsSupervisor={totals.totalDiscount > 0 && user.role === 'cashier'}
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
          needsSupervisor={user.role === 'cashier'}
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
        <Modal title="Choisir l'article" onClose={() => setDialog(null)}>
          <div className="pick-list">
            {searchResults.map((a) => (
              <button
                key={a.id}
                onClick={() => {
                  setDialog(null);
                  addArticle(a);
                }}
              >
                <span>{a.name}</span>
                <span>{fcfa(a.store_price)}</span>
              </button>
            ))}
          </div>
        </Modal>
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
          onClose={() => setDialog(null)}
          onDiscount={() => setDialog('discount')}
          onDone={(q) => {
            setLines((ls) => ls.map((l) => (l.key === sel.key ? { ...l, qty: q } : l)));
            setDialog(null);
          }}
        />
      )}
      {dialog === 'held' && <HeldDialog onClose={() => setDialog(null)} onResume={resume} />}
      {dialog === 'cancel' && <CancelDialog sessionId={session.data.id} onClose={() => setDialog(null)} />}
      {dialog === 'return' && <ReturnDialog onClose={() => setDialog(null)} />}
      {(dialog === 'cashIn' || dialog === 'cashOut') && (
        <CashOpDialog type={dialog === 'cashIn' ? 'IN' : 'OUT'} needsSupervisor={user.role === 'cashier'} onClose={() => setDialog(null)} />
      )}
      {dialog === 'close' && (
        <CloseDialog
          sessionId={session.data.id}
          onClose={() => setDialog(null)}
          onClosed={() => {
            setDialog(null);
            session.reload();
          }}
        />
      )}
    </div>
  );
}

/** Varier : changer la quantité de la ligne sélectionnée (ou passer à la remise). */
function VaryDialog({ line, onClose, onDone, onDiscount }: { line: PosLine; onClose: () => void; onDone: (qty: number) => void; onDiscount: () => void }) {
  const [value, setValue] = useState(String(line.qty / 1000).replace('.', ','));
  const q = parseQty(value);
  const fixed = line.fixedAmount !== undefined;
  return (
    <Modal title={line.label} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (q && !fixed) onDone(q);
        }}
      >
        <Field label={`Quantité (${UNIT_LABEL[line.unit].toLowerCase()})`} hint={fixed ? 'Étiquette balance à prix imposé : quantité non modifiable' : `PU TTC : ${fcfa(line.unitPrice)}`}>
          <input autoFocus inputMode="decimal" value={value} disabled={fixed} onChange={(e) => setValue(e.target.value)} />
        </Field>
        {q && !fixed && <p className="big-total">{fcfa(lineTotal({ ...line, qty: q }))}</p>}
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

function OpenSession({ onOpened }: { onOpened: () => void }) {
  const toast = useToast();
  const [amount, setAmount] = useState('');
  return (
    <div className="center-page">
      <form
        className="card"
        onSubmit={async (e) => {
          e.preventDefault();
          const v = parseAmount(amount || '0');
          if (v === null) return toast.error('Montant invalide');
          try {
            await call('pos.open', v);
            onOpened();
          } catch (err) {
            toast.error(err);
          }
        }}
      >
        <h2>Ouverture de caisse</h2>
        <Field label="Fond de caisse (FCFA)" hint="Espèces présentes dans le tiroir à l'ouverture">
          <input autoFocus inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0" />
        </Field>
        <button className="primary big" type="submit">
          Ouvrir la caisse
        </button>
      </form>
    </div>
  );
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
