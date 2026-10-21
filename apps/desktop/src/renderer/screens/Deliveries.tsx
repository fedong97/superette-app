import { useEffect, useState } from 'react';
import { whatsappLink } from '@superette/core';
import { type Result, call } from '../api';
import { askConfirm, askText, Empty, Field, Modal, dateFr, dateTime, fcfa, parseAmount, today, useCan, useLoad, useToast } from '../ui';
import { type Customer, CustomerPaymentDialog } from './customerDialogs';

type Row = Result<'deliveries.list'>[number];
type Period = 'today' | 'tomorrow' | 'week' | 'open';

const STATUS = { pending: ['À préparer', 'alerte'], out: ['En route', 'info'], delivered: ['Livrée', 'normal'], cancelled: ['Annulée', 'rupture'] } as const;

const dayPlus = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const time = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : '');

/**
 * Livraisons du jour (Vente › Livraisons du jour) : les ventes à porter chez
 * le client, à préparer, en route ou livrées, avec ce que le livreur encaisse.
 */
export function Deliveries({ active }: { active: boolean }) {
  const toast = useToast();
  const [period, setPeriod] = useState<Period>('today');
  const [courier, setCourier] = useState('');
  const range = period === 'today' ? { from: today(), to: today() } : period === 'tomorrow' ? { from: dayPlus(1), to: dayPlus(1) } : period === 'week' ? { from: today(), to: dayPlus(6) } : { open: true };
  const list = useLoad(() => call('deliveries.list', { ...range, courier: courier || null }), [period, courier]);
  const couriers = useLoad(() => call('deliveries.couriers'), []);
  const [collect, setCollect] = useState<Customer | null>(null);
  const [returning, setReturning] = useState(false);
  const can = useCan();
  const sheetDate = period === 'tomorrow' ? dayPlus(1) : today();
  const printSheet = (c: string) => call('couriers.printSheet', c, sheetDate).catch(toast.error);
  // Revenir sur l'écran recharge la liste (ventes livrables faites entre-temps à la caisse).
  useEffect(() => {
    if (active) {
      list.reload();
      couriers.reload();
    }
  }, [active]);

  const rows = list.data ?? [];
  const live = rows.filter((r) => r.status === 'pending' || r.status === 'out');
  const count = (st: Row['status']) => rows.filter((r) => r.status === st).length;

  const act = async (r: Row, status: 'out' | 'delivered' | 'cancelled') => {
    try {
      let courierName: string | null = null;
      if (status === 'out' && !r.courier) {
        courierName = await askText('Quel livreur part avec cette commande ?');
        if (!courierName) return;
      }
      if (status === 'cancelled' && !(await askConfirm(`Ne plus livrer ${r.sale_number} ? La vente reste valable.`))) return;
      await call('deliveries.setStatus', r.id, status, courierName ? { courier: courierName } : undefined);
      list.reload();
      if (status === 'out') {
        toast.ok(`${r.sale_number} : en route`);
        await tellCustomer(r, courierName ?? r.courier ?? '');
      }
      if (status === 'delivered') {
        toast.ok(`${r.sale_number} : livrée à ${time(new Date().toISOString())}`);
        // Vente à crédit : le livreur rapporte l'argent, on l'enregistre tout de suite.
        if (r.to_collect > 0 && r.customer_id && (await askConfirm(`Le livreur a-t-il encaissé ${fcfa(r.to_collect)} de ${r.customer_name} ?`))) setCollect(await call('customers.get', r.customer_id));
      }
    } catch (err) {
      toast.error(err);
    }
  };
  /** Message WhatsApp au client : sa commande part avec le livreur. */
  const tellCustomer = async (r: Row, courierName: string) => {
    const amount = r.to_collect > 0 ? ` Montant à régler à la livraison : ${fcfa(r.to_collect)}.` : '';
    const link = whatsappLink(r.phone, `Bonjour${r.customer_name ? ` ${r.customer_name}` : ''}, votre commande ${r.sale_number} est en route avec ${courierName}.${amount}`);
    if (link && (await askConfirm(`Prévenir le client par WhatsApp au ${r.phone} ?`))) window.open(link);
  };
  const printNote = (r: Row) => call('pos.printInvoice', r.sale_id, { doc: 'delivery' }).catch(toast.error);

  return (
    <div className="page deliveries">
      <header className="page-head">
        <h1>Livraisons du jour</h1>
        <span className="muted">Les ventes à porter chez le client, saisies à la caisse dans l'onglet Livraison du ticket</span>
      </header>
      <div className="dl-kpis">
        <div>
          À préparer<b>{count('pending')}</b>
        </div>
        <div>
          En route<b>{count('out')}</b>
        </div>
        <div>
          Livrées<b>{count('delivered')}</b>
        </div>
        <div>
          À encaisser à la livraison<b>{fcfa(live.reduce((t, r) => t + r.to_collect, 0))}</b>
        </div>
      </div>
      <div className="filters">
        <div className="seg">
          {(
            [
              ['today', "Aujourd'hui"],
              ['tomorrow', 'Demain'],
              ['week', '7 prochains jours'],
              ['open', 'Toutes les non livrées'],
            ] as const
          ).map(([k, label]) => (
            <button key={k} className={period === k ? 'active' : ''} onClick={() => setPeriod(k)}>
              {label}
            </button>
          ))}
        </div>
        <label className="inline">
          Livreur{' '}
          <select value={courier} onChange={(e) => setCourier(e.target.value)}>
            <option value="">tous</option>
            {(couriers.data ?? []).map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </label>
        {can('courier_returns') && <button onClick={() => setReturning(true)}>Retour du livreur</button>}
      </div>
      {(couriers.data ?? []).length > 0 && (
        <div className="filters">
          <span className="muted">Feuilles de route du {dateFr(sheetDate)} :</span>
          {(courier ? [courier] : (couriers.data ?? [])).map((c) => (
            <button key={c} title="Imprimer les livraisons du livreur, avec adresses et montants à encaisser" onClick={() => void printSheet(c)}>
              Feuille de route <b>{c}</b>
            </button>
          ))}
        </div>
      )}
      {!rows.length ? (
        <Empty>Aucune livraison {period === 'open' ? 'en attente' : 'prévue sur cette période'}. À la caisse, ouvrez l'onglet Livraison du ticket et cochez « À livrer ».</Empty>
      ) : (
        <table className="list dl-table">
          <thead>
            <tr>
              <th>Quand</th>
              <th>Facture</th>
              <th>Client</th>
              <th>Adresse</th>
              <th>Livreur</th>
              <th className="r">Frais</th>
              <th className="r">À encaisser</th>
              <th>État</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const [label, tag] = STATUS[r.status];
              return (
                <tr key={r.id} className={r.status === 'delivered' || r.status === 'cancelled' ? 'muted' : ''}>
                  <td>
                    {r.planned_date !== today() && <small>{dateFr(r.planned_date)} · </small>}
                    {r.slot ?? '—'}
                  </td>
                  <td>{r.sale_number}</td>
                  <td>
                    {r.customer_name ?? 'Client comptoir'}
                    {r.phone && <small className="muted"> · {r.phone}</small>}
                  </td>
                  <td>
                    {r.address}
                    {r.note && <small className="muted dl-note">{r.note}</small>}
                  </td>
                  <td>{r.courier ?? '—'}</td>
                  <td className="r">{r.fee ? fcfa(r.fee) : ''}</td>
                  <td className="r">{r.to_collect ? fcfa(r.to_collect) : '0'}</td>
                  <td>
                    <span className={`tag ${tag}`}>
                      {label}
                      {r.status === 'out' && r.out_at ? ` ${time(r.out_at)}` : ''}
                      {r.status === 'delivered' && r.delivered_at ? ` ${time(r.delivered_at)}` : ''}
                    </span>
                  </td>
                  <td className="actions">
                    {r.status === 'pending' && <button onClick={() => void act(r, 'out')}>Partir 🚚</button>}
                    {r.status === 'out' && (
                      <button className="primary" onClick={() => void act(r, 'delivered')}>
                        Livrée ✓
                      </button>
                    )}
                    <button title="Imprimer le bon de livraison" onClick={() => void printNote(r)}>
                      Bon
                    </button>
                    {(r.status === 'pending' || r.status === 'out') && (
                      <button className="ghost" title="Ne plus livrer (la vente reste valable)" onClick={() => void act(r, 'cancelled')}>
                        ✕
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <p className="muted">« Partir » et « Livrée » notent l'heure. Pour une vente à crédit, l'argent rapporté par le livreur s'enregistre comme un règlement du client.</p>
      {returning && (
        <CourierReturnDialog
          couriers={couriers.data ?? []}
          initial={courier}
          onClose={() => setReturning(false)}
          onDone={() => {
            setReturning(false);
            list.reload();
          }}
        />
      )}
      {collect && (
        <CustomerPaymentDialog
          atRegister
          customer={collect}
          onClose={() => setCollect(null)}
          onPaid={(id) => {
            setCollect(null);
            call('customers.printReceipt', id).catch(toast.error);
            toast.ok('Règlement enregistré');
          }}
        />
      )}
    </div>
  );
}

/**
 * Retour du livreur : ses livraisons faites mais pas encore rendues, ce qu'il a
 * encaissé chez chaque client et les espèces qu'il remet à la caisse.
 */
function CourierReturnDialog({ couriers, initial, onClose, onDone }: { couriers: string[]; initial: string; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [courier, setCourier] = useState(initial || couriers[0] || '');
  const pending = useLoad(() => (courier ? call('couriers.pending', courier) : Promise.resolve([])), [courier]);
  const history = useLoad(() => call('couriers.returns'), []);
  const [collected, setCollected] = useState<Record<string, string>>({});
  const [handed, setHanded] = useState<string | null>(null);
  const [note, setNote] = useState('');
  useEffect(() => {
    setCollected({});
    setHanded(null);
  }, [courier]);
  const rows = pending.data ?? [];
  const amountOf = (r: Row) => (collected[r.id] === undefined ? r.to_collect : parseAmount(collected[r.id]!));
  const expected = rows.reduce((t, r) => t + r.to_collect, 0);
  const total = rows.reduce((t, r) => t + (amountOf(r) ?? 0), 0);
  const returned = handed === null ? total : parseAmount(handed);
  const gap = (returned ?? 0) - total;
  const save = async () => {
    if (rows.some((r) => amountOf(r) === null) || returned === null) return toast.error('Montant invalide');
    try {
      const r = await call('couriers.settle', { courier, deliveries: rows.map((d) => ({ id: d.id, collected: amountOf(d)! })), returned, note: note || null });
      toast.ok(`Retour ${r.number} enregistré : ${fcfa(r.returned)} remis`);
      onDone();
    } catch (e) {
      toast.error(e);
    }
  };
  return (
    <Modal title="Retour du livreur" onClose={onClose} wide>
      <Field label="Livreur">
        <select value={courier} onChange={(e) => setCourier(e.target.value)}>
          {couriers.map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
      </Field>
      {!rows.length ? (
        <p className="muted">Aucune livraison livrée par ce livreur n'attend son retour.</p>
      ) : (
        <>
          <table className="list compact">
            <thead>
              <tr>
                <th>Facture</th>
                <th>Client</th>
                <th>Adresse</th>
                <th className="r">À encaisser</th>
                <th className="r">Encaissé</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>{r.sale_number}</td>
                  <td>{r.customer_name ?? 'Client comptoir'}</td>
                  <td>{r.address}</td>
                  <td className="r">{fcfa(r.to_collect)}</td>
                  <td className="r">
                    <input
                      style={{ width: 110, textAlign: 'right' }}
                      inputMode="numeric"
                      disabled={r.to_collect === 0}
                      value={collected[r.id] ?? String(r.to_collect)}
                      onChange={(e) => setCollected({ ...collected, [r.id]: e.target.value })}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={3}>Total</td>
                <td className="r">{fcfa(expected)}</td>
                <td className="r">{fcfa(total)}</td>
              </tr>
            </tfoot>
          </table>
          <Field label="Espèces remises à la caisse">
            <input inputMode="numeric" value={handed ?? String(total)} onChange={(e) => setHanded(e.target.value)} />
          </Field>
          {gap !== 0 && <p className={gap < 0 ? 'neg' : ''}>{gap < 0 ? `Il manque ${fcfa(-gap)}.` : `Le montant remis dépasse l'encaissé de ${fcfa(gap)}.`}</p>}
          <Field label="Note">
            <input value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
          <p className="muted">L'argent encaissé entre dans la caisse ouverte comme règlement de chaque client ; ce qui n'est pas encaissé reste sur son compte.</p>
        </>
      )}
      <div className="actions">
        <button onClick={onClose}>Fermer</button>
        <button className="primary" disabled={!rows.length} onClick={save}>
          Enregistrer le retour
        </button>
      </div>
      <h3>Derniers retours</h3>
      {(history.data ?? []).length === 0 ? (
        <p className="muted">Aucun retour enregistré.</p>
      ) : (
        <table className="list compact">
          <thead>
            <tr>
              <th>N°</th>
              <th>Date</th>
              <th>Livreur</th>
              <th className="r">Attendu</th>
              <th className="r">Encaissé</th>
              <th className="r">Remis</th>
              <th className="r">Écart</th>
            </tr>
          </thead>
          <tbody>
            {(history.data ?? []).slice(0, 15).map((h) => (
              <tr key={h.id}>
                <td>{h.number}</td>
                <td>{dateTime(h.created_at)}</td>
                <td>{h.courier}</td>
                <td className="r">{fcfa(h.expected)}</td>
                <td className="r">{fcfa(h.collected)}</td>
                <td className="r">{fcfa(h.returned)}</td>
                <td className={`r ${h.difference < 0 ? 'neg' : ''}`}>{h.difference ? fcfa(h.difference) : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Modal>
  );
}
