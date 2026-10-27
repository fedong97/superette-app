import { useState } from 'react';
import { VOUCHER_KINDS } from '@superette/core';
import { type Result, call } from '../api';
import { Empty, Modal, askText, dateFr, dateTime, fcfa, useCan, useLoad, useToast } from '../ui';

type Voucher = Result<'vouchers.list'>['vouchers'][number];
type State = Voucher['state'];

const STATES: Record<State, [string, string]> = {
  valid: ['valable', 'normal'],
  spent: ['épuisé', 'surstock'],
  expired: ['expiré', 'alerte'],
  void: ['annulé', 'rupture'],
};

/**
 * Bons d'achat du magasin : vendus, donnés en avoir d'un retour ou pour la
 * monnaie. Le solde se calcule d'après les tickets payés avec le bon : un bon
 * ne sert jamais au-delà de son montant, ni après sa date de fin.
 */
export function Vouchers() {
  const toast = useToast();
  const can = useCan();
  const [state, setState] = useState<State | ''>('valid');
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState<Voucher | null>(null);
  const list = useLoad(() => call('vouchers.list', { state: state || null, search: search || null }), [state, search]);
  const cancel = async (v: Voucher) => {
    const reason = await askText(`Annuler le bon ${v.code} de ${fcfa(v.amount)} ? L'argent est rendu au client (la pièce d'encaissement est annulée). Motif :`);
    if (!reason) return;
    call('vouchers.cancel', v.id, reason).then(() => (toast.ok('Bon annulé'), list.reload()), toast.error);
  };
  const out = list.data?.outstanding;
  return (
    <>
      <div className="filters">
        <select value={state} onChange={(e) => setState(e.target.value as State | '')}>
          <option value="valid">Valables</option>
          <option value="spent">Épuisés</option>
          <option value="expired">Expirés</option>
          <option value="void">Annulés</option>
          <option value="">Tous</option>
        </select>
        <input className="search" placeholder="Code (scanner le bon), nom" value={search} onChange={(e) => setSearch(e.target.value)} />
        {out && (
          <span className="muted" style={{ marginLeft: 'auto' }}>
            {out.count} bon{out.count > 1 ? 's' : ''} encore à utiliser : <b>{fcfa(out.total)}</b> dus aux clients (compte 4191)
          </span>
        )}
      </div>
      {list.data?.vouchers.length === 0 ? (
        <Empty>Aucun bon. Un bon d'achat se vend à la caisse (bouton « Bon d'achat »), un bon d'avoir se donne lors d'un retour remboursé en « Bon d'achat ».</Empty>
      ) : (
        <table className="list compact">
          <thead>
            <tr>
              <th>Code</th>
              <th>Type</th>
              <th>Émis le</th>
              <th>Pour</th>
              <th className="r">Montant</th>
              <th className="r">Utilisé</th>
              <th className="r">Reste</th>
              <th>Fin</th>
              <th>État</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(list.data?.vouchers ?? []).map((v) => (
              <tr key={v.id} className="clickable" onClick={() => setOpen(v)}>
                <td className="mono">{v.code}</td>
                <td>{VOUCHER_KINDS[v.kind]}</td>
                <td>{dateTime(v.created_at)}</td>
                <td>{v.holder ?? v.customer_name ?? ''}</td>
                <td className="r">{fcfa(v.amount)}</td>
                <td className="r">{v.used ? fcfa(v.used) : '-'}</td>
                <td className="r">
                  <b>{fcfa(v.balance)}</b>
                </td>
                <td>{v.expires_on ? dateFr(v.expires_on) : '-'}</td>
                <td>
                  <span className={`tag ${STATES[v.state][1]}`}>{STATES[v.state][0]}</span>
                </td>
                <td className="r nowrap" onClick={(e) => e.stopPropagation()}>
                  <button onClick={() => call('vouchers.print', v.id).catch(toast.error)}>Réimprimer</button>{' '}
                  {can('vouchers') && v.kind === 'sold' && v.used === 0 && v.state === 'valid' && (
                    <button className="danger" onClick={() => void cancel(v)}>
                      Annuler
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {open && <VoucherUses voucher={open} onClose={() => setOpen(null)} />}
    </>
  );
}

function VoucherUses({ voucher, onClose }: { voucher: Voucher; onClose: () => void }) {
  const uses = useLoad(() => call('vouchers.uses', voucher.code), [voucher.code]);
  return (
    <Modal title={`Bon ${voucher.code} · ${fcfa(voucher.amount)}`} onClose={onClose}>
      {voucher.sale_number && <p className="muted">Venu du ticket {voucher.sale_number}</p>}
      {uses.data?.length === 0 ? (
        <p>Pas encore utilisé.</p>
      ) : (
        <table className="list compact">
          <thead>
            <tr>
              <th>Ticket</th>
              <th>Date</th>
              <th>Caissier</th>
              <th className="r">Payé avec le bon</th>
            </tr>
          </thead>
          <tbody>
            {(uses.data ?? []).map((u) => (
              <tr key={u.sale_id}>
                <td>{u.number}</td>
                <td>{dateTime(u.at)}</td>
                <td>{u.user_name}</td>
                <td className="r">{fcfa(u.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="actions">
        <button onClick={onClose}>Fermer</button>
      </div>
    </Modal>
  );
}
