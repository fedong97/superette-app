import { describeInPacks } from '@superette/core';
import { useEffect, useMemo, useState } from 'react';
import { type Result, call } from '../api';
import { askConfirm, Empty, Field, Modal, Tabs, dateFr, dateTime, fcfa, parseAmount, parseQty, qty, today, useCan, useLoad, useToast, has } from '../ui';
import { PendingReceipts, PurchasesByProduct, saveXlsx } from './Controls';
import { PackUnitSelect, packChoices, packCostText, purchaseUnits, switchUnits, toBase, unitsFor, useArticlePacks } from './packs';
import { ArticlePicker, SupplierSelect, WarehouseSelect } from './pickers';
import { type RecLine, newRecLine, recLineInput } from './Stock';
import { PurchaseEntry } from './purchaseEntry';
import { type TermsText, TermsCells, lineNet, lineTerms, noTerms, termsFrom } from './purchaseTerms';
import { hasVat, tx } from '../tax';
import { DocPreview } from './docPreview';
import { ReceptionLabels } from './barcodePrint';
import { SupplierReturns } from './SupplierReturns';
import { GroupOrders } from './GroupOrders';

type User = NonNullable<Result<'app.state'>['user']>;
type Order = Result<'purchases.order'>;
type Invoice = Result<'purchases.invoice'>['invoice'];
export type PurchasesTab = 'orders' | 'new-order' | 'receptions' | 'pending' | 'byproduct' | 'invoices' | 'direct' | 'due' | 'reorder' | 'returns' | 'group';

const ORDER_STATES: Record<Order['state'], string> = {
  draft: 'Brouillon',
  sent: 'Envoyée',
  partial: 'Reçue en partie',
  received: 'Reçue',
  closed: 'Soldée',
  cancelled: 'Annulée',
};
const STATE_TAG: Record<Order['state'], string> = {
  draft: '',
  sent: 'surstock',
  partial: 'alerte',
  received: 'normal',
  closed: 'normal',
  cancelled: 'rupture',
};
const PAY_METHODS = {
  CASH: 'Espèces',
  BANK_TRANSFER: 'Virement',
  CHEQUE: 'Chèque',
  MTN_MOMO: 'MTN Mobile Money',
  ORANGE_MONEY: 'Orange Money',
} as const;

const num = (milli: number) => String(milli / 1000).replace('.', ',');

/** Achats : bons de commande, réceptions, factures fournisseurs, échéancier, proposition de commande. */
/** « 4475 » devient « BL 4475 », sans doubler le préfixe s'il a déjà été saisi. */
const deliveryNote = (n: string) => (/^b\.?l\b/i.test(n.trim()) ? n.trim() : `BL ${n.trim()}`);

export function Purchases({ user, initialTab = 'orders' }: { user: User; initialTab?: PurchasesTab }) {
  const buying = has(user, 'purchase_orders');
  const invoices = has(user, 'purchase_invoices') || has(user, 'supplier_pay');
  // Facture directe : elle fait aussi entrer la marchandise.
  const direct = has(user, 'purchase_invoices') && has(user, 'stock_receive');
  const [tab, setTab] = useState<PurchasesTab>(initialTab === 'new-order' ? 'orders' : initialTab);
  const tabs: [PurchasesTab, string][] = [
    ['orders', 'Bons de commande'],
    ['receptions', 'Registre des réceptions'],
    ['pending', 'Non encore reçues'],
    ...(invoices ? ([['invoices', 'Registre des achats']] as [PurchasesTab, string][]) : []),
    ...(direct ? ([['direct', 'Facture directe']] as [PurchasesTab, string][]) : []),
    ...(has(user, 'purchase_due') ? ([['due', 'Échéancier']] as [PurchasesTab, string][]) : []),
    ...(has(user, 'supplier_returns') ? ([['returns', 'Retours fournisseur']] as [PurchasesTab, string][]) : []),
    ['byproduct', 'Achats par produit'],
    ...(has(user, 'reorder') ? ([['reorder', 'Proposition de commande']] as [PurchasesTab, string][]) : []),
    ...(has(user, 'group_orders') ? ([['group', 'Commandes groupées']] as [PurchasesTab, string][]) : []),
  ];
  return (
    <div className="page">
      <header className="page-head">
        <h1>Achats</h1>
      </header>
      <Tabs value={tab} onChange={setTab} tabs={tabs} />
      {tab === 'orders' && <Orders canEdit={buying} startNew={initialTab === 'new-order' && buying} />}
      {tab === 'receptions' && <Receptions />}
      {tab === 'pending' && <PendingReceipts />}
      {tab === 'byproduct' && <PurchasesByProduct />}
      {tab === 'invoices' && invoices && <Invoices />}
      {tab === 'direct' && direct && <DirectInvoice canPay={has(user, 'supplier_pay')} />}
      {tab === 'due' && has(user, 'purchase_due') && <Due />}
      {tab === 'returns' && has(user, 'supplier_returns') && <SupplierReturns canCredit={has(user, 'purchase_invoices')} />}
      {tab === 'reorder' && has(user, 'reorder') && <Reorder onCreated={() => setTab('orders')} />}
      {tab === 'group' && has(user, 'group_orders') && <GroupOrders />}
    </div>
  );
}

// --- Bons de commande --------------------------------------------------------

type OrderView = { mode: 'list' } | { mode: 'edit'; order: Order | null } | { mode: 'view'; id: string } | { mode: 'receive'; id: string };

function Orders({ canEdit, startNew = false }: { canEdit: boolean; startNew?: boolean }) {
  const [view, setView] = useState<OrderView>(startNew ? { mode: 'edit', order: null } : { mode: 'list' });
  const [open, setOpen] = useState(true);
  const list = useLoad(() => call('purchases.orders', { open }), [open, view.mode]);
  if (view.mode === 'edit') return <OrderEditor order={view.order} onDone={(id) => setView(id ? { mode: 'view', id } : { mode: 'list' })} />;
  if (view.mode === 'view')
    return <OrderDetail id={view.id} canEdit={canEdit} onBack={() => setView({ mode: 'list' })} onEdit={(o) => setView({ mode: 'edit', order: o })} onReceive={() => setView({ mode: 'receive', id: view.id })} />;
  if (view.mode === 'receive') return <ReceiveOrder id={view.id} onDone={() => setView({ mode: 'view', id: view.id })} />;
  return (
    <>
      <div className="filters">
        <label>
          <input type="checkbox" checked={open} onChange={(e) => setOpen(e.target.checked)} /> En cours seulement
        </label>
        {canEdit && (
          <button data-new title="Ctrl+J" className="primary" style={{ marginLeft: 'auto' }} onClick={() => setView({ mode: 'edit', order: null })}>
            Nouveau bon de commande
          </button>
        )}
      </div>
      {list.data?.length === 0 ? (
        <Empty>Aucun bon de commande {open ? 'en cours' : ''}. Créez-en un, ou partez de la proposition de commande.</Empty>
      ) : (
        <table className="list">
          <thead>
            <tr>
              <th>N°</th>
              <th>Date</th>
              <th>Fournisseur</th>
              <th>Dépôt</th>
              <th>Livraison prévue</th>
              <th className="r">{tx('Total HT')}</th>
              <th>État</th>
            </tr>
          </thead>
          <tbody>
            {(list.data ?? []).map((o) => (
              <tr key={o.id} className="clickable" onClick={() => setView({ mode: 'view', id: o.id })}>
                <td>{o.number}</td>
                <td>{dateFr(o.order_date)}</td>
                <td>{o.supplier_name}</td>
                <td>{o.warehouse_name}</td>
                <td className={o.expected_date && o.expected_date < today() && ['sent', 'partial'].includes(o.state) ? 'neg' : ''}>
                  {o.expected_date ? dateFr(o.expected_date) : ''}
                </td>
                <td className="r">{fcfa(o.total_ht)}</td>
                <td>
                  <span className={`tag ${STATE_TAG[o.state]}`}>{ORDER_STATES[o.state]}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}


/** Ligne prête à envoyer : quantité et prix en unités de base, remise et gratuits. */
function termsInput(l: { name: string; qty: string; cost: string; packUnits: number } & TermsText) {
  const t = lineTerms(l);
  if (typeof t === 'string') throw new Error(`${t} : ${l.name}`);
  return { qty: t.qty, unitCost: t.unitCost, discountBp: t.discountBp, freeQty: t.freeQty, promoBuy: t.promoBuy, promoPay: t.promoPay };
}

/** Les lignes reprises d'un bon passent au conditionnement d'achat quand la quantité tombe juste (2 cartons plutôt que 200 pièces). */
function useAutoPacks<L extends { articleId: string; qty: string; cost: string; packUnits: number; auto?: boolean }>(
  lines: L[] | null,
  setLines: (l: L[]) => void,
  packs: ReturnType<typeof useArticlePacks>[0],
) {
  useEffect(() => {
    if (!lines?.some((l) => l.auto && packs.has(l.articleId))) return;
    setLines(
      lines.map((l) => {
        const a = l.auto ? packs.get(l.articleId) : undefined;
        if (!a) return l;
        const base = toBase(l.qty, l.cost, l.packUnits);
        const units = unitsFor(base.qty ?? 0, packChoices(a), purchaseUnits(a));
        return { ...l, ...switchUnits(l.qty, l.cost, l.packUnits, units), packUnits: units, auto: false };
      }),
    );
  }, [lines, packs, setLines]);
}

/** Choix du conditionnement d'une ligne, la quantité et le prix étant convertis. */
function PackCell<L extends { qty: string; cost: string; packUnits: number; auto?: boolean }>({
  line,
  a,
  onChange,
}: {
  line: L;
  a: Parameters<typeof packChoices>[0] | undefined;
  onChange: (patch: Partial<L>) => void;
}) {
  if (!a) return null;
  return (
    <PackUnitSelect
      choices={packChoices(a)}
      value={line.packUnits}
      onChange={(u) => onChange({ ...switchUnits(line.qty, line.cost, line.packUnits, u), packUnits: u, auto: false } as Partial<L>)}
    />
  );
}

/** Lignes d'un bon enregistré, remises dans le conditionnement d'achat quand la quantité tombe juste. */
async function orderLines(order: Order): Promise<RecLine[]> {
  return Promise.all(
    order.lines.map(async (l) => {
      const a = await call('catalogue.get', l.article_id);
      const promo = Boolean(l.promo_buy && l.promo_pay !== null);
      // Gratuits sans promo : le bonus saisi en plus de la quantité payée.
      const bonus = promo ? 0 : l.free_qty;
      const paid = l.qty - bonus;
      let units = unitsFor(paid, packChoices(a), purchaseUnits(a));
      if (bonus % units) units = 1000;
      const t = termsFrom(l);
      return {
        ...newRecLine(a),
        supplierRef: l.supplier_ref,
        qty: num((paid * 1000) / units),
        cost: String(Math.round((l.unit_cost * units) / 1000)),
        packUnits: units,
        bonus: bonus ? num((bonus * 1000) / units) : '',
        ...t,
        discType: t.disc && t.promo ? undefined : t.promo ? 'promo' : 'pct',
      };
    }),
  );
}

function OrderEditor({ order, onDone }: { order: Order | null; onDone: (id: string | null) => void }) {
  const toast = useToast();
  const can = useCan();
  const [supplierId, setSupplierId] = useState(order?.supplier_id ?? '');
  const [warehouseId, setWarehouseId] = useState(order?.warehouse_id ?? '');
  const [expected, setExpected] = useState(order?.expected_date ?? '');
  const [notes, setNotes] = useState(order?.notes ?? '');
  const [lines, setLines] = useState<RecLine[]>([]);
  useEffect(() => {
    if (order) orderLines(order).then(setLines, (err) => toast.error(err));
  }, [order?.id]);
  const total = lines.reduce((t, l) => t + lineNet(l), 0);

  /** Prix négocié et colisage du fournisseur choisi, sinon dernier prix d'achat ; saisie dans le conditionnement d'achat. */
  const prepare = async (a: Result<'catalogue.get'>): Promise<RecLine> => {
    const refs = await call('suppliers.ofArticle', a.id);
    const ref = refs.find((r) => r.supplier_id === supplierId);
    const baseQty = ref?.pack_qty ?? purchaseUnits(a);
    const units = unitsFor(baseQty, packChoices(a), purchaseUnits(a));
    const cost = ref?.unit_cost ? String(Math.round((ref.unit_cost * units) / 1000)) : packCostText(a, units);
    // Bonus convenu avec ce fournisseur (« 12 achetés, 10 payés ») : proposé sur la ligne.
    const promo = ref?.promo_buy && ref.promo_pay ? { promo: `${ref.promo_buy}/${ref.promo_pay}`, discType: 'promo' as const } : {};
    return { ...newRecLine(a), supplierRef: ref?.supplier_ref ?? null, qty: num((baseQty * 1000) / units), cost, packUnits: units, ...promo };
  };

  const save = async (send: boolean) => {
    try {
      const input = {
        supplierId,
        warehouseId,
        expectedDate: expected || null,
        notes: notes || null,
        lines: lines.map((l) => {
          const t = lineTerms(l);
          if (typeof t === 'string') throw new Error(`${t} : ${l.article.name}`);
          return { articleId: l.article.id, qty: t.qty, unitCost: t.unitCost, discountBp: t.discountBp, freeQty: t.freeQty, promoBuy: t.promoBuy, promoPay: t.promoPay };
        }),
      };
      if (!supplierId) throw new Error('Choisissez le fournisseur');
      let saved = order ? await call('purchases.updateOrder', order.id, input) : await call('purchases.createOrder', input);
      if (send) saved = await call('purchases.setOrderStatus', saved.id, 'sent');
      toast.ok(send ? `Bon ${saved.number} envoyé` : `Bon ${saved.number} enregistré`);
      onDone(saved.id);
    } catch (err) {
      toast.error(err);
    }
  };

  return (
    <div>
      <h2>{order ? `Bon de commande ${order.number}` : 'Nouveau bon de commande'}</h2>
      <div className="grid3">
        <SupplierSelect value={supplierId} onChange={setSupplierId} />
        <WarehouseSelect value={warehouseId} onChange={setWarehouseId} label="Livrer au dépôt" />
        <Field label="Livraison souhaitée" hint="Par défaut : délai de livraison du fournisseur">
          <input type="date" value={expected} onChange={(e) => setExpected(e.target.value)} />
        </Field>
      </div>
      <PurchaseEntry lines={lines} setLines={setLines} order prepare={prepare}>
        <Field label="Notes pour le fournisseur">
          <input value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
        <div className="actions">
          <span className="big-total">{fcfa(total)}{tx(' HT')}</span>
          <button onClick={() => onDone(order?.id ?? null)}>Retour</button>
          <button disabled={!lines.length} onClick={() => void save(false)}>
            Enregistrer le brouillon
          </button>
          {can('order_close') && (
            <button className="primary" disabled={!lines.length} onClick={() => void save(true)}>
              Enregistrer et envoyer
            </button>
          )}
        </div>
      </PurchaseEntry>
    </div>
  );
}

function OrderDetail({ id, canEdit, onBack, onEdit, onReceive }: { id: string; canEdit: boolean; onBack: () => void; onEdit: (o: Order) => void; onReceive: () => void }) {
  const toast = useToast();
  const can = useCan();
  const canClose = can('order_close');
  const order = useLoad(() => call('purchases.order', id), [id]);
  const receptions = useLoad(() => call('purchases.receptions', {}), [id]);
  const [preview, setPreview] = useState(false);
  const [whatsapp, setWhatsapp] = useState(false);
  const o = order.data;
  if (!o) return null;
  const setStatus = async (status: 'sent' | 'closed' | 'cancelled', question?: string) => {
    if (question && !(await askConfirm(question))) return;
    try {
      await call('purchases.setOrderStatus', o.id, status);
      order.reload();
    } catch (err) {
      toast.error(err);
    }
  };
  const mine = (receptions.data ?? []).filter((r) => r.order_id === o.id);
  return (
    <div>
      <div className="page-head">
        <h2>
          Bon de commande {o.number} <span className={`tag ${STATE_TAG[o.state]}`}>{ORDER_STATES[o.state]}</span>
        </h2>
      </div>
      <p>
        <b>{o.supplier_name}</b> · commandé le {dateFr(o.order_date)}
        {o.expected_date ? `, livraison prévue le ${dateFr(o.expected_date)}` : ''} · dépôt {o.warehouse_name}
        {o.user_name ? ` · par ${o.user_name}` : ''}
      </p>
      <table className="list">
        <thead>
          <tr>
            <th>Réf. fournisseur</th>
            <th>Article</th>
            <th className="r">Commandé</th>
            <th className="r">Reçu</th>
            <th className="r">Reste</th>
            <th className="r">{tx('PU HT')}</th>
            <th className="r">Remise</th>
            <th className="r">Gratuits</th>
            <th className="r">{tx('Total HT')}</th>
          </tr>
        </thead>
        <tbody>
          {o.lines.map((l) => (
            <tr key={l.id}>
              <td>{l.supplier_ref}</td>
              <td>
                {l.article_name} <small className="muted">{l.article_code}</small>
              </td>
              <td className="r">{qty(l.qty, l.unit)}</td>
              <td className="r">{l.received ? qty(l.received, l.unit) : ''}</td>
              <td className={`r ${l.qty > l.received ? 'neg' : 'pos'}`}>{qty(Math.max(0, l.qty - l.received), l.unit)}</td>
              <td className="r">{fcfa(l.unit_cost)}</td>
              <td className="r">{l.discount_bp ? `${l.discount_bp / 100} %` : ''}</td>
              <td className="r">
                {l.free_qty ? qty(l.free_qty, l.unit) : ''}
                {l.promo_buy && <small className="muted block">{l.promo_buy} achetés, {l.promo_pay} payés</small>}
              </td>
              <td className="r">{fcfa(l.total_ht)}</td>
            </tr>
          ))}
          <tr className="b">
            <td colSpan={8}>{tx('Total HT')}</td>
            <td className="r">{fcfa(o.total_ht)}</td>
          </tr>
        </tbody>
      </table>
      {o.notes && <p className="muted">{o.notes}</p>}
      {mine.length > 0 && (
        <p>
          Réceptions :{' '}
          {mine.map((r, i) => (
            <span key={r.id}>
              {i > 0 && ', '}
              {r.number} du {dateTime(r.received_at)}
              {r.delivery_note ? ` (${deliveryNote(r.delivery_note)})` : ''}
            </span>
          ))}
        </p>
      )}
      <div className="actions">
        <button onClick={onBack}>Retour à la liste</button>
        <button onClick={() => setPreview(true)}>Aperçu et impression…</button>
        {preview && <DocPreview source={{ kind: 'purchaseOrder', id: o.id }} onClose={() => setPreview(false)} />}
        <button onClick={() => setWhatsapp(true)} title="Envoyer le bon au fournisseur par WhatsApp">
          WhatsApp au fournisseur
        </button>
        {whatsapp && <WhatsappOrderDialog orderId={o.id} number={o.number} supplier={o.supplier_name} onClose={() => setWhatsapp(false)} />}
        {canEdit && o.state === 'draft' && <button onClick={() => onEdit(o)}>Modifier</button>}
        {canClose && o.state === 'draft' && (
          <>
            <button className="danger" onClick={() => void setStatus('cancelled', 'Annuler ce bon de commande ?')}>
              Annuler
            </button>
            <button className="primary" onClick={() => void setStatus('sent')}>
              Marquer envoyée
            </button>
          </>
        )}
        {canClose && o.state === 'sent' && (
          <button className="danger" onClick={() => void setStatus('cancelled', 'Annuler ce bon de commande ?')}>
            Annuler
          </button>
        )}
        {canClose && o.state === 'partial' && (
          <button onClick={() => void setStatus('closed', 'Solder la commande ? Le reliquat ne sera plus attendu.')}>Solder le reliquat</button>
        )}
        {can('order_receive') && (o.state === 'sent' || o.state === 'partial') && (
          <button className="primary" onClick={onReceive}>
            Réceptionner
          </button>
        )}
      </div>
    </div>
  );
}

interface RecvLine {
  orderLineId: string | null;
  articleId: string;
  name: string;
  unit: 'piece' | 'kg' | 'litre';
  perishable: boolean;
  ordered: number;
  already: number;
  qty: string;
  cost: string;
  packUnits: number;
  auto?: boolean;
  lot: string;
  expiry: string;
  disc: string;
  promo: string;
}

function ReceiveOrder({ id, onDone }: { id: string; onDone: () => void }) {
  const toast = useToast();
  const order = useLoad(() => call('purchases.order', id), [id]);
  const [lines, setLines] = useState<RecvLine[] | null>(null);
  const [note, setNote] = useState('');
  const [received, setReceived] = useState<{ number: string; lines: { articleId: string; qty: number; packUnits: number }[] } | null>(null);
  useEffect(() => {
    if (order.data && !lines)
      setLines(
        order.data.lines.map((l) => ({
          orderLineId: l.id,
          articleId: l.article_id,
          name: l.article_name,
          unit: l.unit,
          perishable: l.perishable === 1,
          ordered: l.qty,
          already: l.received,
          qty: num(Math.max(0, l.qty - l.received)),
          cost: String(l.unit_cost),
          packUnits: 1000,
          auto: true,
          lot: '',
          expiry: '',
          ...termsFrom(l),
        })),
      );
  }, [order.data, lines]);
  const [packs, remember] = useArticlePacks((lines ?? []).map((l) => l.articleId));
  useAutoPacks(lines, setLines, packs);
  const inPacks = (q: number, articleId: string) => {
    const a = packs.get(articleId);
    return a && a.packs.length ? describeInPacks(q, a.packs, a.unit_name || 'Pièce') : '';
  };
  if (!order.data || !lines) return null;
  const update = (i: number, patch: Partial<RecvLine>) => setLines(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const total = lines.reduce((t, l) => t + lineNet(l), 0);
  return (
    <div>
      <h2>
        Réception du bon {order.data.number} · {order.data.supplier_name}
      </h2>
      <p className="muted">Saisissez ce qui est réellement livré (0 si absent). Un écart de prix avec la commande est signalé en rouge.</p>
      <div className="grid3">
        <Field label="N° du bon de livraison fournisseur">
          <input value={note} onChange={(e) => setNote(e.target.value)} autoFocus />
        </Field>
      </div>
      <ArticlePicker
        placeholder="Article livré en plus de la commande : scanner ou rechercher"
        onPick={(a) => {
          remember(a.id, a);
          const units = purchaseUnits(a);
          setLines([
            ...lines,
            { orderLineId: null, articleId: a.id, name: a.name, unit: a.unit, perishable: a.perishable === 1, ordered: 0, already: 0, qty: '1', cost: packCostText(a, units), packUnits: units, lot: '', expiry: '', ...noTerms },
          ]);
        }}
      />
      <table className="list">
        <thead>
          <tr>
            <th>Article</th>
            <th className="r">Commandé</th>
            <th className="r">Déjà reçu</th>
            <th>Reçu</th>
            <th>Conditionnement</th>
            <th>{tx('PU HT')}</th>
            <th>Remise %</th>
            <th>Promo N/M</th>
            <th>N° de lot</th>
            <th>Date limite</th>
            <th className="r">{tx('Montant HT')}</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l, i) => {
            const ol = order.data!.lines.find((x) => x.id === l.orderLineId);
            const priceGap = ol && toBase(l.qty, l.cost, l.packUnits).unitCost !== ol.unit_cost;
            return (
              <tr key={i}>
                <td>
                  {l.name}
                  {!l.orderLineId && <small className="muted"> hors commande</small>}
                </td>
                <td className="r">
                  {l.ordered ? qty(l.ordered, l.unit) : ''}
                  {l.ordered > 0 && inPacks(l.ordered, l.articleId) && <small className="muted block">{inPacks(l.ordered, l.articleId)}</small>}
                </td>
                <td className="r">{l.already ? qty(l.already, l.unit) : ''}</td>
                <td>
                  <input className="qty" value={l.qty} onChange={(e) => update(i, { qty: e.target.value })} />
                </td>
                <td>
                  <PackCell line={l} a={packs.get(l.articleId)} onChange={(p) => update(i, p)} />
                </td>
                <td>
                  <input className={`qty ${priceGap ? 'gap' : ''}`} value={l.cost} onChange={(e) => update(i, { cost: e.target.value })} />
                </td>
                <TermsCells line={l} onChange={(p) => update(i, p)} />
                <td>
                  <input className="qty" value={l.lot} onChange={(e) => update(i, { lot: e.target.value })} />
                </td>
                <td>
                  <input type="date" value={l.expiry} required={l.perishable && (parseQty(l.qty) ?? 0) > 0} onChange={(e) => update(i, { expiry: e.target.value })} />
                </td>
                <td className="r">{fcfa(lineNet(l))}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="actions">
        <span className="big-total">{fcfa(total)}{tx(' HT')}</span>
        <button onClick={onDone}>Retour</button>
        <button
          className="primary"
          onClick={async () => {
            try {
              const input = lines
                .filter((l) => l.qty.trim() && l.qty.trim() !== '0')
                .map((l) => ({
                  orderLineId: l.orderLineId,
                  articleId: l.articleId,
                  ...termsInput(l),
                  packCost: parseAmount(l.cost) ?? undefined,
                  packUnits: l.packUnits,
                  lotNumber: l.lot || null,
                  expiry: l.expiry || null,
                }));
              const r = await call('purchases.receiveOrder', id, { deliveryNote: note || undefined, lines: input });
              toast.ok(`Réception ${r.number} enregistrée, stock mis à jour`);
              setReceived({ number: r.number, lines: input.map((l) => ({ articleId: l.articleId, qty: l.qty, packUnits: l.packUnits })) });
            } catch (err) {
              toast.error(err);
            }
          }}
        >
          Valider la réception
        </button>
      </div>
      {received && <ReceptionLabels title={`Réception ${received.number} enregistrée · imprimer les étiquettes ?`} lines={received.lines} onClose={onDone} />}
    </div>
  );
}

// --- Réceptions ----------------------------------------------------------------

function Receptions() {
  const list = useLoad(() => call('purchases.receptions', {}));
  const [open, setOpen] = useState<string | null>(null);
  const detail = useLoad(() => (open ? call('purchases.reception', open) : Promise.resolve(null)), [open]);
  return (
    <>
      {list.data?.length === 0 ? (
        <Empty>Aucune réception. Réceptionnez un bon de commande, ou saisissez une réception sans commande dans Stock › Réception.</Empty>
      ) : (
        <table className="list">
          <thead>
            <tr>
              <th>N°</th>
              <th>Date</th>
              <th>Fournisseur</th>
              <th>Commande</th>
              <th>BL fournisseur</th>
              <th className="r">{tx('Total HT')}</th>
              <th className="r">{tx('TTC')}</th>
              <th>Facture</th>
            </tr>
          </thead>
          <tbody>
            {(list.data ?? []).map((r) => (
              <tr key={r.id} className="clickable" onClick={() => setOpen(r.id)}>
                <td>{r.number}</td>
                <td>{dateTime(r.received_at)}</td>
                <td>{r.supplier_name ?? <span className="muted">sans fournisseur</span>}</td>
                <td>{r.order_number}</td>
                <td>{r.delivery_note ? deliveryNote(r.delivery_note) : ''}</td>
                <td className="r">{fcfa(r.total_ht)}</td>
                <td className="r">{fcfa(r.total_ttc)}</td>
                <td>{r.invoice_number ?? (r.supplier_id ? <span className="tag alerte">à facturer</span> : '')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {open && detail.data && (
        <Modal title={`Bon de réception ${detail.data.number}`} onClose={() => setOpen(null)} wide>
          <p>
            {detail.data.supplier_name ?? 'Sans fournisseur'} · {dateTime(detail.data.received_at)} · dépôt {detail.data.warehouse_name}
            {detail.data.user_name ? ` · reçu par ${detail.data.user_name}` : ''}
          </p>
          <ReceivedLines lines={detail.data.lines} />
          <p className="b">
            {hasVat() ? `Total HT ${fcfa(detail.data.total_ht)} · TVA ${fcfa(detail.data.total_tva)} · TTC ${fcfa(detail.data.total_ttc)}` : `Total ${fcfa(detail.data.total_ttc)}`}
            {detail.data.discount ? ` · dont remise globale ${fcfa(detail.data.discount)}` : ''}
          </p>
        </Modal>
      )}
    </>
  );
}

/** Lignes reçues : prix avant remise, remise, gratuits, coût net entré en stock. */
function ReceivedLines({ lines }: { lines: Result<'purchases.reception'>['lines'] }) {
  const terms = lines.some((l) => l.discount_bp || l.free_qty || (l.gross_cost !== null && l.gross_cost !== l.unit_cost));
  return (
    <table className="list compact">
      <thead>
        <tr>
          <th>Article</th>
          <th className="r">Quantité</th>
          <th className="r">{tx('PU HT')}</th>
          {terms && (
            <>
              <th className="r">Remise</th>
              <th className="r">Gratuits</th>
              <th className="r">Coût net</th>
            </>
          )}
          <th>Lot</th>
          <th>Date limite</th>
          <th className="r">{tx('Total HT')}</th>
        </tr>
      </thead>
      <tbody>
        {lines.map((l) => (
          <tr key={l.id}>
            <td>{l.article_name}</td>
            <td className="r">{qty(l.qty, l.unit)}</td>
            <td className="r">{fcfa(l.gross_cost ?? l.unit_cost)}</td>
            {terms && (
              <>
                <td className="r">{l.discount_bp ? `${l.discount_bp / 100} %` : ''}</td>
                <td className="r">
                  {l.free_qty ? qty(l.free_qty, l.unit) : ''}
                  {l.promo_buy && <small className="muted block">{l.promo_buy} achetés, {l.promo_pay} payés</small>}
                </td>
                <td className="r">{fcfa(l.unit_cost)}</td>
              </>
            )}
            <td>{l.lot_number}</td>
            <td>{l.expiry ? dateFr(l.expiry) : ''}</td>
            <td className="r">{fcfa(l.total_ht)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// --- Factures et règlements ------------------------------------------------------

function InvoiceState({ i }: { i: Invoice }) {
  if (i.state === 'paid') return <span className="tag normal">Réglée</span>;
  return <span className={`tag ${i.overdue ? 'rupture' : 'alerte'}`}>{i.overdue ? 'En retard' : i.state === 'partial' ? 'Réglée en partie' : 'À régler'}</span>;
}

function Invoices() {
  const can = useCan();
  const [unpaid, setUnpaid] = useState(false);
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const list = useLoad(() => call('purchases.invoices', { unpaid }), [unpaid, creating, open]);
  return (
    <>
      <div className="filters">
        <label>
          <input type="checkbox" checked={unpaid} onChange={(e) => setUnpaid(e.target.checked)} /> Non réglées seulement
        </label>
        {can('purchase_invoices') && (
          <button className="primary" style={{ marginLeft: 'auto' }} onClick={() => setCreating(true)}>
            Saisir une facture ou un avoir
          </button>
        )}
      </div>
      <InvoiceTable invoices={list.data ?? []} onOpen={setOpen} />
      {creating && <InvoiceForm onClose={() => setCreating(false)} />}
      {open && <InvoiceDetail id={open} onClose={() => setOpen(null)} />}
    </>
  );
}

function InvoiceTable({ invoices, onOpen }: { invoices: Invoice[]; onOpen: (id: string) => void }) {
  if (!invoices.length) return <Empty>Aucune facture. Saisissez la facture du fournisseur à partir de ses bons de réception.</Empty>;
  return (
    <table className="list">
      <thead>
        <tr>
          <th>N°</th>
          <th>Fournisseur</th>
          <th>Facture fournisseur</th>
          <th>Date</th>
          <th>Échéance</th>
          <th className="r">{tx('TTC')}</th>
          <th className="r">Écart réception</th>
          <th className="r">Reste à payer</th>
          <th>État</th>
        </tr>
      </thead>
      <tbody>
        {invoices.map((i) => (
          <tr key={i.id} className="clickable" onClick={() => onOpen(i.id)}>
            <td>{i.number}</td>
            <td>{i.supplier_name}</td>
            <td>
              {i.kind === 'credit_note' ? 'Avoir ' : ''}
              {i.supplier_number}
            </td>
            <td>{dateFr(i.invoice_date)}</td>
            <td className={i.overdue ? 'neg' : ''}>{dateFr(i.due_date)}</td>
            <td className="r">{fcfa(i.kind === 'invoice' ? i.total_ttc : -i.total_ttc)}</td>
            <td className={`r ${i.received_ht && i.total_ht !== i.received_ht ? 'neg' : ''}`}>{i.received_ht ? fcfa(i.total_ht - i.received_ht) : ''}</td>
            <td className="r">{i.balance ? fcfa(i.balance) : ''}</td>
            <td>
              <InvoiceState i={i} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function InvoiceForm({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const [supplierId, setSupplierId] = useState('');
  const [kind, setKind] = useState<'invoice' | 'credit_note'>('invoice');
  const [picked, setPicked] = useState<string[]>([]);
  const [f, setF] = useState({ number: '', date: today(), due: '', ht: '', tva: '', notes: '' });
  const receptions = useLoad(() => (supplierId ? call('purchases.receptions', { supplierId, uninvoiced: true }) : Promise.resolve([])), [supplierId]);
  const preview = useLoad(() => call('purchases.invoicePreview', picked), [picked.join(',')]);
  useEffect(() => {
    if (preview.data && picked.length) setF((v) => (hasVat() ? { ...v, ht: String(preview.data!.total_ht), tva: String(preview.data!.total_tva) } : { ...v, ht: String(preview.data!.total_ttc), tva: '' }));
  }, [preview.data]);
  const ht = parseAmount(f.ht) ?? 0;
  const tva = hasVat() ? (parseAmount(f.tva) ?? 0) : 0;
  const gap = picked.length && preview.data ? ht - (hasVat() ? preview.data.total_ht : preview.data.total_ttc) : 0;
  return (
    <Modal title="Saisir une facture fournisseur" onClose={onClose} wide>
      <div className="grid3">
        <SupplierSelect
          value={supplierId}
          onChange={(v) => {
            setSupplierId(v);
            setPicked([]);
          }}
        />
        <Field label="Type">
          <select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
            <option value="invoice">Facture</option>
            <option value="credit_note">Avoir (remise, retour, erreur)</option>
          </select>
        </Field>
        <Field label="N° de la facture du fournisseur">
          <input value={f.number} onChange={(e) => setF({ ...f, number: e.target.value })} />
        </Field>
      </div>
      {kind === 'invoice' && supplierId && (
        <>
          <h3>Bons de réception facturés</h3>
          {(receptions.data ?? []).length === 0 ? (
            <p className="muted">Aucune réception à facturer pour ce fournisseur.</p>
          ) : (
            <table className="list compact">
              <tbody>
                {(receptions.data ?? []).map((r) => (
                  <tr key={r.id}>
                    <td>
                      <input
                        type="checkbox"
                        checked={picked.includes(r.id)}
                        onChange={(e) => setPicked(e.target.checked ? [...picked, r.id] : picked.filter((x) => x !== r.id))}
                      />
                    </td>
                    <td>{r.number}</td>
                    <td>{dateTime(r.received_at)}</td>
                    <td>{r.delivery_note ? deliveryNote(r.delivery_note) : ''}</td>
                    <td className="r">{fcfa(r.total_ht)}{tx(' HT')}</td>
                    <td className="r">{fcfa(r.total_ttc)}{tx(' TTC')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
      <div className="grid3">
        <Field label="Date de la facture">
          <input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} />
        </Field>
        <Field label="Échéance" hint="Par défaut : délai de paiement du fournisseur">
          <input type="date" value={f.due} onChange={(e) => setF({ ...f, due: e.target.value })} />
        </Field>
        <Field label="Notes">
          <input value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />
        </Field>
        <Field label={tx('Total HT (FCFA)')}>
          <input inputMode="numeric" value={f.ht} onChange={(e) => setF({ ...f, ht: e.target.value })} />
        </Field>
        {hasVat() && (
          <>
            <Field label="TVA (FCFA)">
              <input inputMode="numeric" value={f.tva} onChange={(e) => setF({ ...f, tva: e.target.value })} />
            </Field>
            <Field label="Total TTC">
              <input readOnly value={fcfa(ht + tva)} />
            </Field>
          </>
        )}
      </div>
      {gap !== 0 && (
        <p className="neg">
          Écart avec les réceptions : {fcfa(gap)}{tx(' HT')}. Vérifiez les prix ou les quantités facturées avant de valider.
        </p>
      )}
      <div className="actions">
        <button onClick={onClose}>Annuler</button>
        <button
          className="primary"
          disabled={!supplierId || !f.number || !ht}
          onClick={async () => {
            try {
              const inv = await call('purchases.createInvoice', {
                supplierId,
                kind,
                supplierNumber: f.number,
                invoiceDate: f.date,
                dueDate: f.due || null,
                totalHt: ht,
                totalTva: tva,
                receptionIds: picked,
                notes: f.notes || null,
              });
              toast.ok(`${kind === 'invoice' ? `Facture ${inv.number} enregistrée` : `Avoir ${inv.number} enregistré`}, échéance le ${dateFr(inv.due_date)}`);
              onClose();
            } catch (err) {
              toast.error(err);
            }
          }}
        >
          Enregistrer
        </button>
      </div>
    </Modal>
  );
}

function InvoiceDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const can = useCan();
  const toast = useToast();
  const data = useLoad(() => call('purchases.invoice', id), [id]);
  const receptions = useLoad(() => call('purchases.receptions', {}), [id]);
  const [paying, setPaying] = useState(false);
  const [preview, setPreview] = useState(false);
  if (!data.data) return null;
  const { invoice: i, payments, lines } = data.data;
  if (preview) return <DocPreview source={{ kind: 'purchaseInvoice', id: i.id }} onClose={() => setPreview(false)} />;
  return (
    <Modal title={`${i.kind === 'invoice' ? 'Facture' : 'Avoir'} ${i.number} · ${i.supplier_name}`} onClose={onClose} wide>
      <p>
        Pièce fournisseur {i.supplier_number} du {dateFr(i.invoice_date)}, échéance {dateFr(i.due_date)} <InvoiceState i={i} />
      </p>
      <table className="list compact">
        <tbody>
          <tr>
            <th>{tx('Total HT')}</th>
            <td className="r">{fcfa(i.total_ht)}</td>
            <th>{tx('Réceptions rattachées HT')}</th>
            <td className={`r ${i.received_ht && i.received_ht !== i.total_ht ? 'neg' : ''}`}>{fcfa(i.received_ht)}</td>
          </tr>
          <tr>
            <th>{hasVat() ? 'TVA' : ''}</th>
            <td className="r">{hasVat() ? fcfa(i.total_tva) : ''}</td>
            <th>Déjà réglé</th>
            <td className="r">{fcfa(i.paid)}</td>
          </tr>
          <tr className="b">
            <th>{tx('Total TTC')}</th>
            <td className="r">{fcfa(i.total_ttc)}</td>
            <th>Reste à payer</th>
            <td className="r">{fcfa(i.balance)}</td>
          </tr>
        </tbody>
      </table>
      {i.direct === 1 && lines.length > 0 && (
        <>
          <h3>Articles de la facture{i.discount ? ` · remise globale ${fcfa(i.discount)} répartie sur les lignes` : ''}</h3>
          <ReceivedLines lines={lines} />
        </>
      )}
      <p className="muted">
        Bons rattachés :{' '}
        {(receptions.data ?? [])
          .filter((r) => r.invoice_id === i.id)
          .map((r) => r.number)
          .join(', ') || 'aucun'}
      </p>
      <h3>Règlements</h3>
      {payments.length === 0 ? (
        <p className="muted">Aucun règlement.</p>
      ) : (
        <table className="list compact">
          <tbody>
            {payments.map((p) => (
              <tr key={p.id}>
                <td>{dateTime(p.paid_at)}</td>
                <td>{PAY_METHODS[p.method]}</td>
                <td>{p.reference}</td>
                <td>{p.user_name}</td>
                <td className="r">{fcfa(p.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="actions">
        <button onClick={() => setPreview(true)}>Aperçu et impression…</button>
        {i.balance > 0 && can('supplier_pay') && (
          <button className="primary" onClick={() => setPaying(true)}>
            {i.kind === 'invoice' ? 'Régler' : 'Enregistrer le remboursement'}
          </button>
        )}
      </div>
      {paying && (
        <PayDialog
          invoice={i}
          onClose={() => setPaying(false)}
          onPaid={() => {
            setPaying(false);
            data.reload();
          }}
        />
      )}
    </Modal>
  );
}

function PayDialog({ invoice, onClose, onPaid }: { invoice: Invoice; onClose: () => void; onPaid: () => void }) {
  const toast = useToast();
  const [method, setMethod] = useState<keyof typeof PAY_METHODS>('CASH');
  const [amount, setAmount] = useState(String(invoice.balance));
  const [reference, setReference] = useState('');
  // MoMo / Orange Money : le règlement sort d'une caisse électronique, la centrale par défaut.
  const payout = invoice.kind === 'invoice' && (method === 'MTN_MOMO' || method === 'ORANGE_MONEY');
  const emoney = useLoad(() => call('emoney.registers'), []);
  const [registerId, setRegisterId] = useState('');
  const chosen = registerId || emoney.data?.centralId || emoney.data?.registers[0]?.id || '';
  return (
    <Modal title={`Règlement ${invoice.supplier_name}, ${invoice.supplier_number}`} onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          const v = parseAmount(amount);
          if (!v) return toast.error('Montant invalide');
          try {
            await call('purchases.pay', { invoiceId: invoice.id, method, amount: v, reference: reference || null, registerId: payout ? chosen || null : null });
            toast.ok('Règlement enregistré');
            onPaid();
          } catch (err) {
            toast.error(err);
          }
        }}
      >
        <div className="methods">
          {(Object.keys(PAY_METHODS) as (keyof typeof PAY_METHODS)[]).map((m) => (
            <button type="button" key={m} className={method === m ? 'active' : ''} onClick={() => setMethod(m)}>
              {PAY_METHODS[m]}
            </button>
          ))}
        </div>
        <Field label="Montant (FCFA)" hint={`Reste à payer : ${fcfa(invoice.balance)}`}>
          <input autoFocus inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </Field>
        {payout && Boolean(emoney.data?.registers.length) && (
          <Field label="Payé depuis la caisse électronique" hint="Le règlement sort du solde de cette caisse électronique">
            <select value={chosen} onChange={(e) => setRegisterId(e.target.value)}>
              {emoney.data!.registers.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                  {r.central ? ' (centrale)' : ''}
                </option>
              ))}
            </select>
          </Field>
        )}
        {method !== 'CASH' && (
          <Field label={method === 'CHEQUE' ? 'N° de chèque' : 'Référence de la transaction'}>
            <input value={reference} onChange={(e) => setReference(e.target.value)} required />
          </Field>
        )}
        <div className="actions">
          <button type="submit" className="primary">
            Valider le règlement
          </button>
        </div>
      </form>
    </Modal>
  );
}

/**
 * Facture d'achat directe, sans bon de commande : les articles de la facture
 * entrent en stock au coût net (remise, gratuits, remise globale), et la
 * facture va au registre des achats, réglée tout de suite ou à l'échéance.
 */
function DirectInvoice({ canPay }: { canPay: boolean }) {
  const toast = useToast();
  const [preview, setPreview] = useState<string | null>(null);
  const app = useLoad(() => call('app.state'), []);
  const vat = app.data?.station?.store.vat_enabled !== 0;
  const [supplierId, setSupplierId] = useState('');
  const [warehouseId, setWarehouseId] = useState('');
  const [number, setNumber] = useState('');
  const [date, setDate] = useState(today());
  const [due, setDue] = useState('');
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<RecLine[]>([]);
  const [disc, setDisc] = useState('');
  const [discMode, setDiscMode] = useState<'pct' | 'amount'>('pct');
  const [pay, setPay] = useState(false);
  const [method, setMethod] = useState<keyof typeof PAY_METHODS>('CASH');
  const [reference, setReference] = useState('');
  const [registerId, setRegisterId] = useState('');
  const emoney = useLoad(() => call('emoney.registers'), []);
  const [done, setDone] = useState<Invoice | null>(null);
  const [received, setReceived] = useState<{ articleId: string; qty: number; packUnits: number }[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const sum = lines.reduce((s, l) => s + lineNet(l), 0);
  const d = Number(disc.replace(',', '.').replace('%', '').trim() || 0);
  const global = !Number.isFinite(d) || d <= 0 ? 0 : discMode === 'pct' ? Math.round((sum * Math.min(d, 100)) / 100) : Math.min(sum, Math.round(d));
  const ht = sum - global;
  // TVA estimée ligne par ligne (le calcul exact est fait à l'enregistrement).
  const tva = vat ? lines.reduce((s, l) => s + Math.round(((sum ? (lineNet(l) * ht) / sum : 0) * l.article.vat_rate_bp) / 10000), 0) : 0;
  const payout = method === 'MTN_MOMO' || method === 'ORANGE_MONEY';
  const chosen = registerId || emoney.data?.centralId || emoney.data?.registers[0]?.id || '';
  const reset = () => {
    setLines([]);
    setNumber('');
    setDisc('');
    setNotes('');
    setPay(false);
    setReference('');
  };
  if (done)
    return (
      <div className="card done-card">
        <h2>Facture {done.number} enregistrée</h2>
        <p>
          {done.supplier_name} · facture n° {done.supplier_number} · {fcfa(done.total_ttc)}{tx(' TTC')} · {done.balance > 0 ? `reste à payer ${fcfa(done.balance)}, échéance le ${dateFr(done.due_date)}` : 'réglée'}
        </p>
        <p className="muted">La marchandise est entrée en stock et le bon de réception est rattaché à la facture.</p>
        <div className="actions">
          <button onClick={() => setOpen(done.id)}>Voir la facture</button>
          <button onClick={() => setPreview(done.id)}>Aperçu et impression…</button>
          {preview && <DocPreview source={{ kind: 'purchaseInvoice', id: preview }} onClose={() => setPreview(null)} />}
          <button data-new title="Ctrl+J"
            className="primary"
            onClick={() => {
              setDone(null);
              reset();
            }}
          >
            Nouvelle facture directe
          </button>
        </div>
        {open && <InvoiceDetail id={open} onClose={() => setOpen(null)} />}
        {received && <ReceptionLabels title={`Facture ${done.number} enregistrée · imprimer les étiquettes ?`} lines={received} onClose={() => setReceived(null)} />}
      </div>
    );
  return (
    <div>
      <h2>Facture d'achat directe (sans bon de commande)</h2>
      <p className="muted">Saisissez la facture du fournisseur avec ses articles : la marchandise entre en stock au coût net et la facture va au registre des achats.</p>
      <div className="grid3">
        <SupplierSelect value={supplierId} onChange={setSupplierId} />
        <Field label="N° de la facture du fournisseur">
          <input value={number} onChange={(e) => setNumber(e.target.value)} />
        </Field>
        <WarehouseSelect value={warehouseId} onChange={setWarehouseId} label="Dépôt qui reçoit" />
        <Field label="Date de la facture">
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <Field label="Échéance" hint="Par défaut : délai de paiement du fournisseur">
          <input type="date" value={due} onChange={(e) => setDue(e.target.value)} />
        </Field>
        <Field label="Notes">
          <input value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
      </div>
      <PurchaseEntry lines={lines} setLines={setLines}>
      {lines.length > 0 && (
        <div className="direct-foot">
          <div>
            <Field label="Remise globale">
              <div className="inline">
                <input className="qty" value={disc} onChange={(e) => setDisc(e.target.value)} placeholder="0" />
                <select value={discMode} onChange={(e) => setDiscMode(e.target.value as 'pct' | 'amount')}>
                  <option value="pct">%</option>
                  <option value="amount">FCFA</option>
                </select>
              </div>
            </Field>
            {canPay && (
              <label className="check">
                <input type="checkbox" checked={pay} onChange={(e) => setPay(e.target.checked)} /> Réglée tout de suite
              </label>
            )}
            {pay && (
              <>
                <div className="methods">
                  {(Object.keys(PAY_METHODS) as (keyof typeof PAY_METHODS)[]).map((m) => (
                    <button type="button" key={m} className={method === m ? 'active' : ''} onClick={() => setMethod(m)}>
                      {PAY_METHODS[m]}
                    </button>
                  ))}
                </div>
                {method === 'CASH' && <p className="muted small">Les espèces sortent de la caisse centrale.</p>}
                {payout && Boolean(emoney.data?.registers.length) && (
                  <Field label="Payé depuis la caisse électronique">
                    <select value={chosen} onChange={(e) => setRegisterId(e.target.value)}>
                      {emoney.data!.registers.map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.name}
                          {r.central ? ' (centrale)' : ''}
                        </option>
                      ))}
                    </select>
                  </Field>
                )}
                {method !== 'CASH' && (
                  <Field label={method === 'CHEQUE' ? 'N° de chèque' : 'Référence de la transaction'}>
                    <input value={reference} onChange={(e) => setReference(e.target.value)} />
                  </Field>
                )}
              </>
            )}
          </div>
          <table className="totals">
            <tbody>
              {(vat || global > 0) && (
                <tr>
                  <td>{tx('Total des lignes HT')}</td>
                  <td className="r">{fcfa(sum)}</td>
                </tr>
              )}
              {global > 0 && (
                <tr>
                  <td>Remise globale</td>
                  <td className="r">-{fcfa(global)}</td>
                </tr>
              )}
              {vat && (
                <tr>
                  <td>Total HT</td>
                  <td className="r">{fcfa(ht)}</td>
                </tr>
              )}
              {vat && (
                <tr>
                  <td>TVA (calculée par article)</td>
                  <td className="r">{fcfa(tva)}</td>
                </tr>
              )}
              <tr className="b">
                <td>{tx('Total TTC')}</td>
                <td className="r">{fcfa(ht + tva)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
      <div className="actions">
        <button
          className="primary"
          disabled={!lines.length || !supplierId || !number.trim()}
          onClick={async () => {
            try {
              if (!warehouseId) throw new Error('Choisissez le dépôt qui reçoit');
              if (pay && method !== 'CASH' && !reference.trim()) throw new Error('Saisissez la référence du règlement');
              const inv = await call('purchases.directInvoice', {
                supplierId,
                supplierNumber: number,
                invoiceDate: date,
                dueDate: due || null,
                warehouseId,
                notes: notes || null,
                lines: lines.map(recLineInput),
                ...(discMode === 'pct' ? { discountBp: Math.round(Math.min(Math.max(d, 0), 100) * 100) } : { discountAmount: global }),
                payment: pay ? { method, reference: reference || null, registerId: payout ? chosen || null : null } : null,
              });
              toast.ok(`Facture ${inv.number} enregistrée, stock mis à jour`);
              setDone(inv);
              setReceived(lines.map(recLineInput).map((l) => ({ articleId: l.articleId, qty: l.qty, packUnits: l.packUnits })));
            } catch (err) {
              toast.error(err);
            }
          }}
        >
          Enregistrer la facture et la réception
        </button>
      </div>
      </PurchaseEntry>
    </div>
  );
}

function Due() {
  const [open, setOpen] = useState<string | null>(null);
  const due = useLoad(() => call('purchases.due'), [open]);
  if (!due.data) return null;
  return (
    <>
      <div className="kpis">
        <div className="neg">
          <small>En retard</small>
          <strong>{fcfa(due.data.overdue)}</strong>
        </div>
        <div>
          <small>À payer sous 7 jours</small>
          <strong>{fcfa(due.data.dueThisWeek)}</strong>
        </div>
        <div>
          <small>Total dû aux fournisseurs</small>
          <strong>{fcfa(due.data.total)}</strong>
        </div>
        <div>
          <small>Factures ouvertes</small>
          <strong>{due.data.invoices.length}</strong>
        </div>
      </div>
      <InvoiceTable invoices={due.data.invoices} onOpen={setOpen} />
      {open && <InvoiceDetail id={open} onClose={() => setOpen(null)} />}
    </>
  );
}

// --- Proposition de commande -------------------------------------------------------

function Reorder({ onCreated }: { onCreated: () => void }) {
  const toast = useToast();
  const [cover, setCover] = useState('7');
  const [method, setMethod] = useState<'recent' | 'season'>('recent');
  const [boost, setBoost] = useState('0');
  const boostPct = Math.max(-50, Math.min(300, Math.round(Number(boost.replace(',', '.')) || 0)));
  const proposal = useLoad(() => call('purchases.reorder', Number(cover) || 7, { method, boostPct }), [cover, method, boostPct]);
  const season = method === 'season';
  const suppliers = useLoad(() => call('suppliers.list'));
  const [warehouseId, setWarehouseId] = useState('');
  const [edits, setEdits] = useState<Record<string, { qty: string; supplierId: string; on: boolean }>>({});
  const [dept, setDept] = useState('');
  const [supplierFilter, setSupplierFilter] = useState('');
  const [outOnly, setOutOnly] = useState(false);
  const all = useMemo(
    () =>
      (proposal.data ?? []).map((r) => {
        const e = edits[r.article_id];
        return { ...r, qtyText: e?.qty ?? num(r.qty), supplierId: e?.supplierId ?? r.supplier_id ?? '', on: e?.on ?? Boolean(r.supplier_id) };
      }),
    [proposal.data, edits],
  );
  // Filtres : rayon, fournisseur, ruptures seulement. Seules les lignes affichées et cochées sont commandées.
  const rows = all.filter(
    (r) => (!dept || r.department_id === dept) && (!supplierFilter || (supplierFilter === '-' ? !r.supplierId : r.supplierId === supplierFilter)) && (!outOnly || r.stock <= 0),
  );
  const departments = [...new Map(all.filter((r) => r.department_id).map((r) => [r.department_id!, r.department_name!])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
  const supplierName = (id: string) => (suppliers.data ?? []).find((f) => f.id === id)?.name ?? '';
  const inPacks = (r: (typeof rows)[number]) => {
    const q = parseQty(r.qtyText);
    return q && r.packs.length ? describeInPacks(q, r.packs, r.unit_name || 'Pièce') : '';
  };
  const exportXlsx = () =>
    saveXlsx(`proposition-de-commande-${today()}.xlsx`, {
      name: 'Proposition de commande',
      title: [`Proposition de commande du ${dateFr(today())} · ${cover} jours à couvrir${season ? ' · saison' : ''}${boostPct ? ` · majoration ${boostPct} %` : ''}`],
      columns: [
        { header: 'Code', width: 14 },
        { header: 'Article', width: 32 },
        { header: 'Rayon', width: 16 },
        { header: 'Fournisseur', width: 22 },
        { header: 'Stock', format: 'qty' },
        { header: 'En commande', format: 'qty' },
        { header: 'Ventes / jour', format: 'qty' },
        { header: 'Point de commande', format: 'qty' },
        { header: 'À commander', format: 'qty' },
        { header: 'En conditionnements', width: 22 },
        { header: tx('PU HT'), format: 'money' },
        { header: tx('Montant HT'), format: 'money' },
      ],
      rows: chosen.map((r) => {
        const q = parseQty(r.qtyText) ?? 0;
        return [r.article_code, r.article_name, r.department_name ?? '', supplierName(r.supplierId), r.stock / 1000, r.on_order / 1000, r.avg_daily_sales / 1000, r.reorder_point / 1000, q / 1000, inPacks(r), r.unit_cost, Math.round((q * r.unit_cost) / 1000)];
      }),
    });
  const set = (id: string, patch: Partial<{ qty: string; supplierId: string; on: boolean }>) =>
    setEdits((e) => {
      const r = rows.find((x) => x.article_id === id)!;
      return { ...e, [id]: { qty: r.qtyText, supplierId: r.supplierId, on: r.on, ...e[id], ...patch } };
    });
  const chosen = rows.filter((r) => r.on);
  const total = chosen.reduce((t, r) => t + Math.round(((parseQty(r.qtyText) ?? 0) * r.unit_cost) / 1000), 0);
  return (
    <>
      <p className="muted">
        Articles dont le stock, plus ce qui est déjà commandé, passe sous le stock d'alerte de la fiche ou sous les ventes attendues pendant le délai
        de livraison du fournisseur (moyenne des 4 dernières semaines). Les quantités sont arrondies au colisage.
      </p>
      <div className="grid3">
        <Field label="Jours de vente à couvrir après livraison">
          <input inputMode="numeric" value={cover} onChange={(e) => setCover(e.target.value)} />
        </Field>
        <WarehouseSelect value={warehouseId} onChange={setWarehouseId} label="Livrer au dépôt" />
        <Field label="Calcul">
          <select value={method} onChange={(e) => setMethod(e.target.value as 'recent' | 'season')}>
            <option value="recent">Ventes récentes</option>
            <option value="season">Même période l'an dernier (saison)</option>
          </select>
        </Field>
        <Field label="Majoration %" hint="Pour un événement (fêtes, rentrée, Ramadan…) : de −50 à 300.">
          <input type="number" min={-50} max={300} step={5} value={boost} onChange={(e) => setBoost(e.target.value)} />
        </Field>
      </div>
      {season && (
        <p className="muted">
          Calcul « saison » : les ventes des mêmes semaines l'an dernier, corrigées de l'évolution des ventes récentes par rapport à l'an dernier. Sans historique de
          l'an dernier, la moyenne récente est utilisée.
        </p>
      )}
      <div className="filters">
        <select value={dept} onChange={(e) => setDept(e.target.value)}>
          <option value="">Tous les rayons</option>
          {departments.map(([id, name]) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </select>
        <select value={supplierFilter} onChange={(e) => setSupplierFilter(e.target.value)}>
          <option value="">Tous les fournisseurs</option>
          <option value="-">Sans fournisseur</option>
          {(suppliers.data ?? []).map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </select>
        <label>
          <input type="checkbox" checked={outOnly} onChange={(e) => setOutOnly(e.target.checked)} /> Ruptures seulement
        </label>
        <span className="muted">
          {rows.length} article(s) sur {all.length}
        </span>
        <button style={{ marginLeft: 'auto' }} disabled={!chosen.length} onClick={exportXlsx}>
          Exporter Excel
        </button>
        <button
          disabled={!chosen.length}
          onClick={() =>
            call(
              'purchases.printReorder',
              chosen.map((r) => ({ articleId: r.article_id, supplierId: r.supplierId || null, qty: parseQty(r.qtyText) ?? 0, unitCost: r.unit_cost })),
            ).catch(toast.error)
          }
        >
          Imprimer
        </button>
      </div>
      {rows.length === 0 ? (
        <Empty>Rien à commander : tous les stocks couvrent le délai de livraison.</Empty>
      ) : (
        <table className="list">
          <thead>
            <tr>
              <th />
              <th>Article</th>
              <th>Fournisseur</th>
              <th className="r">Stock</th>
              <th className="r">En commande</th>
              <th className="r">Ventes / jour</th>
              {season && <th className="r">L'an dernier / jour</th>}
              {season && <th className="r">Tendance</th>}
              <th className="r">Point de commande</th>
              <th>À commander</th>
              <th>En conditionnements</th>
              <th className="r">{tx('PU HT')}</th>
              <th className="r">{tx('Montant HT')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.article_id} className={r.on ? '' : 'inactive'}>
                <td>
                  <input type="checkbox" checked={r.on} onChange={(e) => set(r.article_id, { on: e.target.checked })} />
                </td>
                <td>
                  {r.article_name} <small className="muted">{r.article_code}</small>
                  {r.department_name && <small className="muted block">{r.department_name}</small>}
                </td>
                <td>
                  <select value={r.supplierId} onChange={(e) => set(r.article_id, { supplierId: e.target.value, on: Boolean(e.target.value) })}>
                    <option value="">Aucun fournisseur</option>
                    {(suppliers.data ?? []).map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.name}
                      </option>
                    ))}
                  </select>
                </td>
                <td className={`r ${r.stock <= 0 ? 'neg' : ''}`}>{qty(r.stock, r.unit)}</td>
                <td className="r">{r.on_order ? qty(r.on_order, r.unit) : ''}</td>
                <td className="r">{r.avg_daily_sales ? qty(r.avg_daily_sales, r.unit) : ''}</td>
                {season && <td className="r">{r.last_year_daily != null ? qty(r.last_year_daily, r.unit) : <span className="muted">—</span>}</td>}
                {season && <td className="r">{r.trend != null ? `×${r.trend.toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : ''}</td>}
                <td className="r">{qty(r.reorder_point, r.unit)}</td>
                <td>
                  <input className="qty" value={r.qtyText} onChange={(e) => set(r.article_id, { qty: e.target.value })} />
                </td>
                <td className="muted">{inPacks(r)}</td>
                <td className="r">{fcfa(r.unit_cost)}</td>
                <td className="r">{fcfa(Math.round(((parseQty(r.qtyText) ?? 0) * r.unit_cost) / 1000))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="actions">
        <span className="big-total">{fcfa(total)}{tx(' HT')}</span>
        <button
          className="primary"
          disabled={!chosen.length}
          onClick={async () => {
            try {
              const missing = chosen.find((r) => !r.supplierId);
              if (missing) throw new Error(`Choisissez un fournisseur pour « ${missing.article_name} »`);
              const orders = await call('purchases.createOrders', {
                warehouseId,
                lines: chosen.map((r) => {
                  const q = parseQty(r.qtyText);
                  if (!q) throw new Error(`Quantité invalide : ${r.article_name}`);
                  return { supplierId: r.supplierId, articleId: r.article_id, qty: q, unitCost: r.unit_cost };
                }),
              });
              toast.ok(`${orders.length} bon(s) de commande créé(s) en brouillon : ${orders.map((o) => o.number).join(', ')}`);
              onCreated();
            } catch (err) {
              toast.error(err);
            }
          }}
        >
          Créer les bons de commande
        </button>
      </div>
    </>
  );
}

/** Bon de commande envoyé au fournisseur par WhatsApp, avec le PDF du bon à joindre. */
function WhatsappOrderDialog({ orderId, number, supplier, onClose }: { orderId: string; number: string; supplier: string; onClose: () => void }) {
  const toast = useToast();
  const [phone, setPhone] = useState('');
  const [pdf, setPdf] = useState(true);
  return (
    <Modal title={`Envoyer le bon ${number} à ${supplier}`} onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            if (pdf && !(await call('purchases.printOrder', orderId, { output: 'pdf' }))) return;
            const r = await call('purchases.whatsappOrder', orderId, phone || null);
            window.open(r.link);
            toast.ok(pdf ? 'WhatsApp est ouvert : joignez le PDF du bon, puis envoyez.' : 'WhatsApp est ouvert avec le bon de commande.');
            onClose();
          } catch (err) {
            toast.error(err);
          }
        }}
      >
        <Field label="Numéro WhatsApp" hint="Vide : le téléphone de la fiche du fournisseur.">
          <input autoFocus inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="6XX XX XX XX" />
        </Field>
        <label className="inline">
          <input type="checkbox" checked={pdf} onChange={(e) => setPdf(e.target.checked)} /> Enregistrer d’abord le bon en PDF pour le joindre
        </label>
        <div className="actions">
          <button className="primary" type="submit">
            Ouvrir WhatsApp
          </button>
        </div>
      </form>
    </Modal>
  );
}
