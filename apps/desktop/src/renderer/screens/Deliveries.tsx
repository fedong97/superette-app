import { useEffect, useState } from 'react';
import { type Result, call } from '../api';
import { askConfirm, askText, Empty, dateFr, fcfa, today, useLoad, useToast } from '../ui';
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
      if (status === 'out') toast.ok(`${r.sale_number} : en route`);
      if (status === 'delivered') {
        toast.ok(`${r.sale_number} : livrée à ${time(new Date().toISOString())}`);
        // Vente à crédit : le livreur rapporte l'argent, on l'enregistre tout de suite.
        if (r.to_collect > 0 && r.customer_id && (await askConfirm(`Le livreur a-t-il encaissé ${fcfa(r.to_collect)} de ${r.customer_name} ?`))) setCollect(await call('customers.get', r.customer_id));
      }
    } catch (err) {
      toast.error(err);
    }
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
      </div>
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
