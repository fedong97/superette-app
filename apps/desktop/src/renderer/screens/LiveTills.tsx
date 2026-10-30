import { useEffect, useState } from 'react';
import { type Result, call } from '../api';
import { Empty, fcfa, useLoad, useToast } from '../ui';
import { FullTreasury } from './Treasury';

type User = NonNullable<Result<'app.state'>['user']>;
type Live = Result<'treasury.live'>;
type LiveRow = Live['registers'][number];

/** Rafraîchissement des caisses : les opérations des autres PC arrivent par le serveur central. */
const REFRESH_MS = 10_000;

const KIND: Record<LiveRow['kind'], string> = { cash: 'Espèces', electronic: 'Électronique', bank: 'Banque' };
const hour = (iso: string) => new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
const day = (iso: string) => new Date(iso).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' });

/**
 * Caisses en direct, pour le gérant : toutes les caisses du magasin d'un coup,
 * rafraîchies seules (ventes, encaissements, sorties, attendu du tiroir, caissier
 * en place). Une caisse choisie montre ses opérations du jour et l'historique de
 * ses journées, où le gérant modifie ou annule une facture, une entrée ou une
 * sortie ; « Intervenir » le fait travailler sur cette caisse.
 */
export function LiveTills({ user, onChanged }: { user: User; onChanged?: () => void }) {
  const toast = useToast();
  const [tick, setTick] = useState(0);
  const live = useLoad(() => call('treasury.live'), [tick]);
  const [selected, setSelected] = useState<string | null>(null);
  const [tab, setTab] = useState<'day' | 'history'>('day');
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), REFRESH_MS);
    return () => clearInterval(t);
  }, []);
  const data = live.data;
  if (!data) return null;
  const chosen = data.registers.find((r) => r.id === selected) ?? null;
  const work = async (registerId: string | null) => {
    try {
      await call('pos.chooseRegister', registerId);
      toast.ok(registerId ? `Vous intervenez sur ${data.registers.find((r) => r.id === registerId)?.name ?? 'cette caisse'} : ventes, entrées et sorties y sont enregistrées` : 'Vous êtes revenu sur votre caisse');
      setTick((n) => n + 1);
      onChanged?.();
    } catch (err) {
      toast.error(err);
    }
  };
  const open = data.registers.filter((r) => r.status === 'open');
  return (
    <div className="page live-tills">
      <header className="page-head">
        <h1>Caisses en direct</h1>
        <span className="muted small">
          {open.length} caisse{open.length > 1 ? 's' : ''} ouverte{open.length > 1 ? 's' : ''} · ventes du jour {fcfa(open.reduce((t, r) => t + r.net, 0))} · mis à jour à{' '}
          {hour(new Date().toISOString())}
        </span>
        <span className="spacer" />
        {data.intervening && (
          <button onClick={() => work(null)} title="Vous travaillez sur une autre caisse que la vôtre">
            Revenir à ma caisse
          </button>
        )}
        <button onClick={() => setTick((n) => n + 1)}>Actualiser</button>
      </header>
      {!data.connected && <p className="warn-text">Ce PC n’est pas relié au serveur central : seules les opérations faites sur ce PC apparaissent.</p>}
      {data.registers.length === 0 ? (
        <Empty>Aucune caisse : créez-en dans Administration › Caisses.</Empty>
      ) : (
        <div className="live-grid">
          {data.registers.map((r) => (
            <button
              key={r.id}
              type="button"
              className={`live-card ${r.status} ${r.id === selected ? 'on' : ''} ${r.id === data.workRegisterId ? 'mine' : ''}`}
              onClick={() => setSelected(r.id === selected ? null : r.id)}
            >
              <span className="live-head">
                <b>
                  {String(r.number).padStart(2, '0')} · {r.name}
                </b>
                <small>{KIND[r.kind]}</small>
              </span>
              <span className={`live-state ${r.status}`}>
                {r.status === 'open'
                  ? r.stale
                    ? `Ouverte depuis le ${day(r.session!.opened_at)} (non clôturée)`
                    : `Ouverte à ${hour(r.session!.opened_at)}`
                  : r.status === 'closed'
                    ? `Fermée${r.session?.closed_at ? ` le ${day(r.session.closed_at)} à ${hour(r.session.closed_at)}` : ''}`
                    : 'Jamais ouverte'}
              </span>
              {r.session && (
                <>
                  <span className="live-who">{r.cashiers.length > 1 ? r.cashiers.join(' puis ') : (r.cashier ?? '')}</span>
                  <span className="live-figures">
                    <span>
                      <small>Ventes ({r.tickets})</small>
                      <b>{fcfa(r.net)}</b>
                    </span>
                    <span>
                      <small>Règlements</small>
                      <b>{fcfa(r.receipts)}</b>
                    </span>
                    {r.kind === 'cash' && (
                      <>
                        <span>
                          <small>Sorties</small>
                          <b>{fcfa(r.exits)}</b>
                        </span>
                        <span>
                          <small>{r.status === 'open' ? 'Attendu' : 'Écart'}</small>
                          <b className={r.status !== 'open' && r.difference ? (r.difference < 0 ? 'neg' : 'pos') : ''}>
                            {r.status === 'open' ? fcfa(r.expected ?? 0) : fcfa(r.difference ?? 0)}
                          </b>
                        </span>
                      </>
                    )}
                  </span>
                  {r.lastAt && <small className="muted">Dernière opération à {hour(r.lastAt)}</small>}
                </>
              )}
            </button>
          ))}
        </div>
      )}
      {chosen && (
        <section className="live-detail">
          <div className="tre-bar">
            <strong>
              {String(chosen.number).padStart(2, '0')} · {chosen.name}
            </strong>
            <span className="tabs-inline">
              <button className={tab === 'day' ? 'active' : ''} onClick={() => setTab('day')}>
                Opérations du jour
              </button>
              <button className={tab === 'history' ? 'active' : ''} onClick={() => setTab('history')}>
                Historique des journées
              </button>
            </span>
            <span className="spacer" />
            {chosen.kind === 'cash' && chosen.id !== data.workRegisterId && data.canIntervene && (
              <button
                className="primary"
                title="Vos ventes, modifications de factures, entrées et sorties se font sur cette caisse jusqu’à « Revenir à ma caisse »"
                onClick={() => work(chosen.id)}
              >
                Intervenir sur cette caisse
              </button>
            )}
            {chosen.id === data.workRegisterId && <span className="tag">Vous travaillez sur cette caisse</span>}
          </div>
          <p className="muted small">
            Double-cliquez une facture pour la réimprimer, la modifier ou l’annuler ; choisissez une entrée ou une sortie puis « Plus » pour la modifier, la supprimer
            ou annuler un règlement.
          </p>
          <FullTreasury key={`${chosen.id}-${tab}`} user={user} embedded initialRegisterId={chosen.id} initialTab={tab} tick={tick} onChanged={() => setTick((n) => n + 1)} />
        </section>
      )}
    </div>
  );
}
