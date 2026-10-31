import { useEffect, useMemo, useRef, useState } from 'react';
import { type CustomerDisplayState, formatFcfa, roundCash } from '@superette/core';
import type { Api } from '../../main/api';
import { type ApiError, type Result, call } from '../api';
import { Empty, Field, Modal, askConfirm, SupervisorPrompt, fcfa, has, parseAmount, useLoad, useStoreSettings, useToast } from '../ui';
import { PaymentDialog } from './PosDialogs';
import { ClosedRegister, RegisterChooser } from './Pos';

type User = NonNullable<Result<'app.state'>['user']>;
type Row = Result<'counter.queue'>[number];
type Recap = Result<'counter.take'>;
type Payments = Parameters<Api['counter.pay']>[0]['payments'];

type Print = Recap['printFormat'];
/** Impressions au choix du caissier, comme à la caisse où vendeur et caissier ne font qu'un. */
const PRINTS: { id: Print; label: string; key: string }[] = [
  { id: 'ticket', label: 'Ticket de caisse', key: 'F2' },
  { id: 'listing', label: 'Facture listing', key: 'F7' },
  { id: 'a4', label: 'Facture A4', key: 'F9' },
  { id: 'none', label: 'Sans impression', key: 'F4' },
];

const BILLS = [1000, 2000, 5000, 10000];
const amount = (v: number) => formatFcfa(v, false);
const hour = (iso: string) => new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
/** Code-barres du bon remis par le vendeur (« ENC-12 ») ou numéro tapé. */
const scannedNumber = (text: string) => {
  const m = /^(?:ENC-)?(\d{1,5})$/i.exec(text.trim());
  return m ? Number(m[1]) : null;
};

const STATE_LABEL: Record<Row['status'], string> = {
  waiting: 'À encaisser',
  editing: 'En modification',
  returned: 'Rendue au vendeur',
  paying: 'En cours d’encaissement',
  paid: 'Encaissée',
  cancelled: 'Annulée',
};

/**
 * Poste du caissier quand vendeur et caissier sont séparés : la liste des
 * factures envoyées par les vendeurs, le récapitulatif de celle du client et
 * l'encaissement. Le caissier ne change aucun article : il encaisse, rend la
 * facture au vendeur, ou la laisse pour un autre client.
 */
export function CounterDesk({
  user,
  hasRegister,
  canChooseRegister = false,
  onRegisterChosen,
  active,
  title,
  onTreasury,
}: {
  user: User;
  hasRegister: boolean;
  canChooseRegister?: boolean;
  onRegisterChosen?: () => void;
  active: boolean;
  title: string;
  onTreasury: () => void;
}) {
  const toast = useToast();
  const settings = useStoreSettings();
  const session = useLoad(() => call('pos.session'), []);
  const queue = useLoad(() => call('counter.queue'), []);
  const [open, setOpen] = useState<Recap[]>([]);
  const [cashGiven, setCashGiven] = useState(0);
  const [search, setSearch] = useState('');
  const [dialog, setDialog] = useState<null | 'pay' | 'giveBack'>(null);
  const [pending, setPending] = useState<{ payments: Payments; supervisorPin?: string; reason: 'discount' | 'credit'; message: string; keepChange?: number | null } | null>(null);
  const [lastSale, setLastSale] = useState<Result<'counter.pay'> | null>(null);
  const [busy, setBusy] = useState(false);
  const printRef = useRef<Print>('none');
  /** Impression choisie pour la facture ouverte : celle demandée par le vendeur, A4 pour un client professionnel, sinon le ticket. */
  const [printChoice, setPrintChoice] = useState<Print>('ticket');
  const scanRef = useRef<HTMLInputElement>(null);

  // La liste se relit toutes les 5 secondes : la facture du vendeur arrive sans rien toucher.
  useEffect(() => {
    if (!active) return;
    queue.reload();
    const t = setInterval(() => queue.reload(), 5_000);
    return () => clearInterval(t);
  }, [active]);
  useEffect(() => {
    if (active && !dialog) setTimeout(() => scanRef.current?.focus(), 0);
  }, [active, dialog, open.length]);

  const rows = queue.data ?? [];
  const total = open.reduce((t, r) => t + r.total, 0);
  const discount = open.reduce((t, r) => t + r.discount, 0);
  const cashDue = roundCash(total, settings.cashRounding);
  const change = open.length ? Math.max(0, cashGiven - cashDue) : 0;
  const first = open[0];
  const customerId = first?.customerId ?? null;
  const offline = queue.error as ApiError | undefined;

  // Afficheur client : le total à payer, puis la monnaie rendue.
  const [paidShown, setPaidShown] = useState<{ total: number; paid: number; change: number } | null>(null);
  useEffect(() => {
    if (!active) return;
    const lines = open.flatMap((r) => r.lines.map((l) => ({ name: l.label, qty: l.qty, amount: l.total })));
    const state: CustomerDisplayState = open.length
      ? { kind: 'cart', last: lines.at(-1) ?? null, lines, total, savings: discount }
      : paidShown
        ? { kind: 'paid', ...paidShown }
        : { kind: 'idle' };
    call('display.show', state).catch(() => undefined);
  }, [active, open, paidShown]);

  /** Ouvre une facture (ou l'ajoute à celles du même client) : aucune autre caisse ne peut la prendre. */
  const take = async (row: Pick<Row, 'id' | 'number'>, add = false) => {
    if (open.some((r) => r.id === row.id)) return;
    if (open.length && !add) return toast.error('Encaissez ou laissez d’abord la facture ouverte');
    setBusy(true);
    try {
      const recap = await call('counter.take', row.id);
      if (add && first && (recap.customerId !== first.customerId || recap.sellerId !== first.sellerId)) {
        await call('counter.release', recap.id).catch(() => undefined);
        toast.error(`La facture n° ${recap.number} n'est pas du même client ou du même vendeur : encaissez-la à part`);
      } else {
        if (!open.length) setPrintChoice(recap.printFormat);
        setOpen((o) => [...o, recap]);
        setLastSale(null);
        setPaidShown(null);
      }
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
      queue.reload();
    }
  };

  const findAndTake = (e: React.FormEvent) => {
    e.preventDefault();
    const n = scannedNumber(search);
    if (n === null) {
      if (open.length && !search.trim()) return void validate(printChoice);
      return toast.error('Tapez ou scannez le numéro de la facture (sur le bon du client)');
    }
    const row = rows.find((r) => r.number === n);
    setSearch('');
    if (!row) return toast.error(`Aucune facture n° ${n} en attente`);
    if (row.status !== 'waiting' && !(row.status === 'paying' && row.lockedHere)) return toast.error(`Facture n° ${n} : ${STATE_LABEL[row.status].toLowerCase()}${row.lockName ? ` (${row.lockName})` : ''}`);
    void take(row, open.length > 0);
  };

  /** Le caissier laisse les factures ouvertes : elles reviennent dans la liste. */
  const releaseAll = async () => {
    for (const r of open) await call('counter.release', r.id).catch(() => undefined);
    setOpen([]);
    setCashGiven(0);
    queue.reload();
  };

  const finish = (sale: Result<'counter.pay'>) => {
    setLastSale(sale);
    setPaidShown({ total: sale.total_ttc, paid: sale.total_ttc + sale.change_given, change: sale.change_given });
    setOpen([]);
    setCashGiven(0);
    setPending(null);
    setDialog(null);
    queue.reload();
    toast.ok(`Facture ${sale.number} encaissée${sale.change_given > 0 ? ` · rendu ${fcfa(sale.change_given)}` : ''}`);
    const print = printRef.current;
    printRef.current = 'none';
    if (print === 'ticket') call('pos.printTicket', sale.id, { newSale: true, force: true }).catch((err) => toast.error(err));
    else {
      // Sans ticket, le tiroir s'ouvre quand même pour une vente en espèces (réglage du poste).
      call('pos.saleDrawer', sale.id).catch((err) => toast.error(err));
      if (print === 'listing') call('pos.printInvoice', sale.id, { format: 'listing' }).catch((err) => toast.error(err));
      else if (print === 'a4') call('pos.printInvoice', sale.id).catch((err) => toast.error(err));
    }
  };

  const pay = async (payments: Payments, pins: { supervisorPin?: string; creditPin?: string; keepChange?: number | null } = {}) => {
    setBusy(true);
    try {
      finish(await call('counter.pay', { ids: open.map((r) => r.id), payments, ...pins }));
    } catch (err) {
      const code = (err as ApiError).code;
      if (code === 'CREDIT_LIMIT' && !pins.creditPin) setPending({ payments, supervisorPin: pins.supervisorPin, keepChange: pins.keepChange, reason: 'credit', message: (err as Error).message });
      else if (code === 'SUPERVISOR_REQUIRED' && !pins.supervisorPin) setPending({ payments, keepChange: pins.keepChange, reason: 'discount', message: 'La facture comporte une remise.' });
      else toast.error(err);
      queue.reload();
    } finally {
      setBusy(false);
    }
  };

  /**
   * En espèces si le reçu couvre le total, sinon le choix du règlement. Entrée
   * imprime ce qui est choisi ; F2 le ticket, F7 la facture listing, F9 la
   * facture A4, F4 rien.
   */
  const validate = async (print: Print) => {
    if (!open.length || busy) return;
    printRef.current = print;
    if (cashGiven >= cashDue) return pay(cashGiven > 0 ? [{ method: 'CASH', amount: cashGiven }] : []);
    setDialog('pay');
  };

  const reprint = (format: Print = 'ticket') => {
    if (!lastSale) return;
    if (!has(user, 'sale_reprint')) return toast.error("Vous n'avez pas le droit de réimprimer un ticket");
    if (format === 'ticket') call('pos.printTicket', lastSale.id).catch(toast.error);
    else call('pos.printInvoice', lastSale.id, format === 'listing' ? { format: 'listing' } : undefined).catch(toast.error);
  };

  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (dialog || pending) return;
      if (e.key === 'F4') {
        e.preventDefault();
        void validate('none');
      } else if (e.key === 'F2' || e.key === 'F7' || e.key === 'F9') {
        e.preventDefault();
        const format: Print = e.key === 'F2' ? 'ticket' : e.key === 'F7' ? 'listing' : 'a4';
        if (open.length) void validate(format);
        else reprint(format);
      } else if (e.ctrlKey && e.key.toLowerCase() === 'e' && open.length) {
        e.preventDefault();
        printRef.current = printChoice;
        setDialog('pay');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const waiting = useMemo(() => rows.filter((r) => !open.some((o) => o.id === r.id)), [rows, open]);

  if (!hasRegister)
    return canChooseRegister ? (
      <div className="center-page">
        <div className="card closed-register">
          <h2>Sur quelle caisse encaissez-vous ?</h2>
          <p>Aucune caisse ne vous est attribuée : choisissez celle de ce comptoir.</p>
          <RegisterChooser current={null} onChosen={() => onRegisterChosen?.()} />
        </div>
      </div>
    ) : (
      <Empty>Aucune caisse ne vous est attribuée. Demandez à l'administrateur de vous en attribuer une dans Administration › Utilisateurs.</Empty>
    );
  if (!session.data) return session.data === null ? <ClosedRegister canOpen={has(user, 'treasury')} onTreasury={onTreasury} onReload={session.reload} /> : null;

  return (
    <div className="counter-desk">
      <section className="cd-queue">
        <div className="cd-queue-head">
          <h2>{title}</h2>
          <small className="muted">
            {rows.filter((r) => r.status === 'waiting').length} à encaisser · {user.name}
          </small>
        </div>
        <form onSubmit={findAndTake} className="cd-scan">
          <input
            ref={scanRef}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            inputMode="numeric"
            autoComplete="off"
            placeholder={open.length ? 'N° d’une autre facture du même client, ou Entrée pour encaisser' : 'Scannez le bon du client ou tapez son numéro'}
          />
        </form>
        {offline && (
          <p className="tre-warning">
            {offline.code === 'SYNC_NOT_CONFIGURED' ? offline.message : `Serveur central injoignable : les factures des vendeurs n'arrivent pas (${offline.message}).`}
          </p>
        )}
        <div className="cd-list">
          {waiting.map((r) => {
            const free = r.status === 'waiting' || (r.status === 'paying' && r.lockedHere);
            return (
              <button
                key={r.id}
                type="button"
                className={`cd-row ${r.status}`}
                disabled={!free || busy}
                onClick={() => void take(r, open.length > 0)}
                title={free ? (open.length ? 'Ajouter cette facture du même client' : 'Ouvrir pour encaisser') : `${STATE_LABEL[r.status]}${r.lockName ? ` par ${r.lockName}` : ''}`}
              >
                <b className="cd-no">{r.number}</b>
                <span className="cd-who">
                  <b>{r.customerName || 'Client comptoir'}</b>
                  <small>
                    {r.cart ? '📱 ' : ''}
                    {r.sellerName} · {hour(r.updatedAt)} · {r.lines} ligne{r.lines > 1 ? 's' : ''}
                    {r.version > 1 ? ' · modifiée' : ''}
                  </small>
                  {!free && (
                    <small className="cd-state">
                      {STATE_LABEL[r.status]}
                      {r.lockName ? ` par ${r.lockName}` : ''}
                    </small>
                  )}
                </span>
                <strong>{amount(r.total)}</strong>
              </button>
            );
          })}
          {!waiting.length && !offline && <p className="tk-empty">Aucune facture en attente. Les factures envoyées par les vendeurs arrivent ici toutes seules.</p>}
        </div>
      </section>

      <aside className="pos-ticket cd-recap">
        {open.length ? (
          <>
            <div className="tk-head">
              <div className="cd-recap-title">
                <b>
                  Facture{open.length > 1 ? 's' : ''} n° {open.map((r) => r.number).join(' + ')}
                </b>
                <small>
                  Vendeur : {first!.sellerName} · Client : {first!.customerName || 'comptoir'}
                  {first!.customerPhone ? ` · ${first!.customerPhone}` : ''}
                </small>
              </div>
            </div>
            <div className="tk-lines">
              <table className="list compact cd-lines">
                <thead>
                  <tr>
                    <th>Produit</th>
                    <th className="r">Qté</th>
                    <th className="r">PU</th>
                    <th className="r">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {open.flatMap((r) =>
                    r.lines.map((l, i) => (
                      <tr key={`${r.id}-${i}`}>
                        <td>
                          {l.label}
                          {l.discount > 0 && <small className="pos"> −{amount(l.discount)}</small>}
                        </td>
                        <td className="r">{l.qty}</td>
                        <td className="r">{amount(l.unitPrice)}</td>
                        <td className="r">{amount(l.total)}</td>
                      </tr>
                    )),
                  )}
                </tbody>
              </table>
            </div>
            <div className="tk-foot">
              {discount > 0 && (
                <div className="tk-sum">
                  <span>Remises et promotions accordées par le vendeur</span>
                  <span>−{amount(discount)}</span>
                </div>
              )}
              <div className="tk-total">
                <span>À PAYER</span>
                <strong>
                  {amount(total)}
                  <small>FCFA</small>
                </strong>
              </div>
              {cashDue < total && <div className="tk-sum">Tout en espèces : {amount(cashDue)} FCFA</div>}
              <div className="cd-cash">
                <Field label="Reçu en espèces">
                  <input inputMode="numeric" value={cashGiven ? amount(cashGiven) : ''} placeholder={amount(cashDue)} onChange={(e) => setCashGiven(parseAmount(e.target.value) ?? 0)} />
                </Field>
                <div className="pos-bills">
                  {BILLS.map((b) => (
                    <button key={b} type="button" onClick={() => setCashGiven((c) => c + b)}>
                      <small>BILLET</small>
                      {amount(b)}
                    </button>
                  ))}
                  <button type="button" className="x" onClick={() => setCashGiven(cashDue)} title="Montant exact">
                    = Exact
                  </button>
                  <button type="button" className="x" disabled={!cashGiven} onClick={() => setCashGiven(0)}>
                    C Effacer
                  </button>
                </div>
              </div>
              <div className="tk-er">
                <div>
                  <small>REÇU</small>
                  <b>{cashGiven ? amount(cashGiven) : '—'}</b>
                </div>
                <div className="change">
                  <small>À RENDRE</small>
                  <b>{change ? amount(change) : '—'}</b>
                </div>
              </div>
              <div className="cd-print" role="radiogroup" aria-label="Impression à l'encaissement">
                <small>IMPRESSION</small>
                {PRINTS.map((p) => (
                  <button
                    key={p.id}
                    role="radio"
                    aria-checked={printChoice === p.id}
                    className={printChoice === p.id ? 'on' : ''}
                    onClick={() => setPrintChoice(p.id)}
                    title={`${p.label} (${p.key} : encaisser directement avec cette impression)`}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
              <div className="cd-actions">
                <button className="primary big" disabled={busy} onClick={() => void validate(printChoice)} title="Entrée">
                  {printChoice === 'none' ? 'Encaisser sans imprimer' : `Encaisser + ${PRINTS.find((p) => p.id === printChoice)!.label.toLowerCase()}`} <kbd>Entrée</kbd>
                </button>
                <button className="primary" disabled={busy} onClick={() => void validate('none')}>
                  Encaisser sans imprimer <kbd>F4</kbd>
                </button>
                <button
                  disabled={busy}
                  onClick={() => {
                    printRef.current = printChoice;
                    setDialog('pay');
                  }}
                  title="Mobile Money, carte, bon d'achat, paiements mixtes, compte du client"
                >
                  Autre paiement <kbd>Ctrl+E</kbd>
                </button>
                <button disabled={busy} onClick={() => setDialog('giveBack')} title="Le client veut changer un article : la facture repart chez le vendeur">
                  Rendre au vendeur
                </button>
                <button disabled={busy} onClick={() => void releaseAll()} title="La facture revient dans la liste, pour un autre client">
                  Laisser
                </button>
              </div>
            </div>
          </>
        ) : (
          <div className="cd-idle">
            {lastSale ? (
              <>
                <p>
                  Dernière facture <b>{lastSale.number}</b> : {fcfa(lastSale.total_ttc)}
                  {lastSale.change_given > 0 ? `, rendu ${fcfa(lastSale.change_given)}` : ''}
                </p>
                <button disabled={!has(user, 'sale_reprint')} onClick={() => reprint('ticket')}>
                  Réimprimer le ticket <kbd>F2</kbd>
                </button>
                <button disabled={!has(user, 'sale_reprint')} onClick={() => reprint('listing')}>
                  Facture listing <kbd>F7</kbd>
                </button>
                <button disabled={!has(user, 'sale_reprint')} onClick={() => reprint('a4')}>
                  Facture A4 <kbd>F9</kbd>
                </button>
              </>
            ) : (
              <p className="muted">Touchez une facture de la liste, ou scannez le bon que le vendeur a remis au client.</p>
            )}
          </div>
        )}
      </aside>

      {dialog === 'pay' && (
        <PaymentDialog
          total={total}
          needsSupervisor={false}
          cashRounding={settings.cashRounding}
          allowCredit={Boolean(customerId)}
          payerPhone={first?.customerPhone ?? null}
          customerName={customerId ? (first?.customerName ?? null) : null}
          onClose={() => setDialog(null)}
          onPaid={async (payments, supervisorPin, keepChange) => {
            setDialog(null);
            await pay(payments as Payments, { supervisorPin, keepChange });
          }}
        />
      )}
      {dialog === 'giveBack' && (
        <GiveBackDialog
          numbers={open.map((r) => r.number)}
          seller={first?.sellerName ?? ''}
          onClose={() => setDialog(null)}
          onDone={async (note) => {
            try {
              for (const r of open) await call('counter.giveBack', r.id, note);
              toast.ok(`Facture rendue à ${first?.sellerName} : il la corrige et la renvoie`);
              setOpen([]);
              setCashGiven(0);
              setDialog(null);
              queue.reload();
            } catch (err) {
              toast.error(err);
            }
          }}
        />
      )}
      {pending && (
        <SupervisorPrompt
          action={pending.reason === 'credit' ? pending.message : `${pending.message} Code du gérant pour l'accepter.`}
          onCancel={() => setPending(null)}
          onConfirm={(pin) => {
            const p = pending;
            setPending(null);
            void pay(p.payments, p.reason === 'credit' ? { supervisorPin: p.supervisorPin, creditPin: pin, keepChange: p.keepChange } : { supervisorPin: pin, keepChange: p.keepChange });
          }}
        />
      )}
    </div>
  );
}

function GiveBackDialog({ numbers, seller, onClose, onDone }: { numbers: number[]; seller: string; onClose: () => void; onDone: (note: string) => Promise<void> }) {
  const [note, setNote] = useState('');
  const quick = ['Le client retire un article', 'Le client ajoute un article', 'Pas assez d’argent', 'Erreur de quantité', 'Mauvais client sur la facture'];
  return (
    <Modal title={`Rendre la facture n° ${numbers.join(' + ')} à ${seller}`} onClose={onClose}>
      <p>La facture repart chez le vendeur avec votre message. Il la corrige et la renvoie à la caisse avec le même numéro.</p>
      <div className="dl-chips">
        {quick.map((q) => (
          <button key={q} type="button" className={note === q ? 'on' : ''} onClick={() => setNote(q)}>
            {q}
          </button>
        ))}
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void onDone(note.trim());
        }}
      >
        <Field label="Ce qu'il faut changer">
          <input autoFocus value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} placeholder="Ex. : le client ne prend que 2 sacs de riz" />
        </Field>
        <div className="actions">
          <button type="button" className="ghost" onClick={onClose}>
            Annuler
          </button>
          <button type="submit" className="primary" disabled={note.trim().length < 2}>
            Rendre au vendeur
          </button>
        </div>
      </form>
    </Modal>
  );
}

/**
 * Factures envoyées à la caisse par le vendeur (toutes celles du magasin pour
 * le gérant) : les rouvrir pour les modifier, les annuler tant qu'aucune
 * caisse ne les encaisse, réimprimer le bon du client.
 */
export function CounterMineDialog({ user, onClose, onEdit }: { user: User; onClose: () => void; onEdit: (id: string) => void }) {
  const toast = useToast();
  const list = useLoad(() => call('counter.mine'), []);
  const supervisor = user.role === 'admin' || user.role === 'manager';
  const act = async (fn: () => Promise<unknown>, done: string) => {
    try {
      await fn();
      toast.ok(done);
      list.reload();
    } catch (err) {
      toast.error(err);
    }
  };
  const rows = list.data ?? [];
  return (
    <Modal title={supervisor ? 'Factures envoyées à la caisse (tous les vendeurs)' : 'Mes factures envoyées à la caisse'} onClose={onClose} wide>
      {list.error ? (
        <p className="neg">{(list.error as Error).message}</p>
      ) : !rows.length ? (
        <Empty>Aucune facture envoyée depuis hier. « Envoyer à la caisse » (F4) depuis la fiche de facturation.</Empty>
      ) : (
        <table className="list compact">
          <thead>
            <tr>
              <th>N°</th>
              <th>Heure</th>
              {supervisor && <th>Vendeur</th>}
              <th>Client</th>
              <th className="r">Montant</th>
              <th>État</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const mineEditing = r.status === 'editing' && r.lockedHere;
              const canEdit = r.status === 'waiting' || r.status === 'returned' || mineEditing;
              const stuck = (r.status === 'editing' && !r.lockedHere) || (r.status === 'paying' && !r.lockedHere);
              return (
                <tr key={r.id} className={r.status === 'returned' ? 'warn' : undefined}>
                  <td>
                    <b>{r.number}</b>
                    {r.version > 1 ? <small className="muted"> v{r.version}</small> : null}
                  </td>
                  <td>{hour(r.updatedAt)}</td>
                  {supervisor && <td>{r.sellerName}</td>}
                  <td>{r.customerName || 'Comptoir'}</td>
                  <td className="r">{amount(r.total)}</td>
                  <td>
                    {STATE_LABEL[r.status]}
                    {r.lockName && (r.status === 'paying' || r.status === 'editing') ? ` (${r.lockName})` : ''}
                    {r.saleNumber ? ` · ${r.saleNumber}` : ''}
                    {r.note && (r.status === 'returned' || r.status === 'cancelled') && <div className="neg">« {r.note} »</div>}
                  </td>
                  <td className="row">
                    {canEdit && (
                      <button className="primary" onClick={() => onEdit(r.id)}>
                        Modifier
                      </button>
                    )}
                    {(r.status === 'waiting' || r.status === 'returned' || r.status === 'editing') && (
                      <button onClick={() => void act(() => call('counter.printSlip', r.id, true), 'Bon réimprimé')}>Bon</button>
                    )}
                    {canEdit && (
                      <button
                        className="danger"
                        onClick={async () => {
                          if (await askConfirm(`Annuler la facture n° ${r.number} ? Le client ne pourra plus la payer à la caisse.`)) {
                            void act(() => call('counter.cancel', r.id, null), `Facture n° ${r.number} annulée`);
                          }
                        }}
                      >
                        Annuler
                      </button>
                    )}
                    {supervisor && stuck && (
                      <button title="PC éteint pendant l'encaissement ou la modification : la facture revient à la caisse" onClick={() => void act(() => call('counter.unlock', r.id), `Facture n° ${r.number} libérée`)}>
                        Libérer
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </Modal>
  );
}
