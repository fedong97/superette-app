import { useEffect, useState } from 'react';
import { DENOMINATIONS_FCFA, countedTotal } from '@superette/core';
import { type Result, call } from '../api';
import { Empty, Field, Modal, Tabs, dateFr, dateTime, fcfa, parseAmount, today, useLoad, useToast } from '../ui';
import { ZView } from './PosDialogs';

type User = NonNullable<Result<'app.state'>['user']>;
type State = Result<'treasury.state'>;
type RegisterRow = State['registers'][number];
type Journey = Result<'treasury.session'>;
type CashRow = Journey['cash']['entries'][number];

export type TreasuryTab = 'day' | 'history' | 'central';

/** Caisse choisie en haut de l'écran : une caisse de vente, ou la caisse centrale. */
const CENTRAL = 'central';

const time = (iso: string) => new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
const dayTime = (iso: string) => new Date(iso).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

interface TreasuryProps {
  user: User;
  /** Caisse de travail de l'utilisateur : l'écran suit quand le gérant en change. */
  registerId?: string | null;
  initialTab?: TreasuryTab;
  onChanged?: () => void;
}

/**
 * Sans le droit « Voir les montants de la caisse », le caissier ou le vendeur
 * ouvre et ferme sa caisse sans voir ni ventes, ni attendu, ni journées.
 */
export function Treasury(props: TreasuryProps) {
  return props.user.rights.includes('cash_amounts') ? <FullTreasury {...props} /> : <CashierTreasury {...props} />;
}

/**
 * Opérations de trésorerie, comme dans KONTROL : ouverture de la journée avec
 * son fond, entrées et sorties d'espèces, clôture avec comptage à l'aveugle et
 * versement à la caisse centrale, historique des journées et livre de la centrale.
 */
function FullTreasury({
  user,
  registerId = null,
  initialTab = 'day',
  onChanged,
}: TreasuryProps) {
  const toast = useToast();
  const state = useLoad(() => call('treasury.state'), [registerId]);
  const canCentral = user.rights.includes('central_cash') || user.rights.includes('accounting');
  const [selected, setSelected] = useState<string | null>(initialTab === 'central' && canCentral ? CENTRAL : null);
  const [tab, setTab] = useState<Exclude<TreasuryTab, 'central'>>(initialTab === 'history' ? 'history' : 'day');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<'open' | 'close' | 'central-in' | 'central-out' | null>(null);

  const registers = state.data?.registers ?? [];
  const register: RegisterRow | undefined = registers.find((r) => r.id === selected) ?? registers.find((r) => r.isThisStation) ?? registers[0];
  const central = selected === CENTRAL;
  const history = useLoad(() => (register && !central ? call('treasury.sessions', register.id) : Promise.resolve([])), [register?.id, central]);
  // Journée affichée : celle choisie, sinon la journée ouverte, sinon la dernière clôturée.
  const shownId = sessionId ?? register?.session?.id ?? history.data?.[0]?.id ?? null;
  const journey = useLoad(() => (shownId && !central ? call('treasury.session', shownId) : Promise.resolve(null)), [shownId, central]);

  useEffect(() => setSessionId(null), [register?.id]);
  // Le gérant vient de changer de caisse : on affiche la nouvelle.
  useEffect(() => {
    if (selected !== CENTRAL) setSelected(null);
  }, [registerId]);
  const reload = () => {
    state.reload();
    history.reload();
    journey.reload();
    onChanged?.();
  };

  if (!state.data) return null;
  const open = register?.session ?? null;
  const here = Boolean(register?.isThisStation);

  return (
    <div className="page treasury">
      <header className="page-head">
        <h1>Opérations de trésorerie</h1>
      </header>
      <div className="tre-bar">
        <label>
          Caisse
          <select value={central ? CENTRAL : (register?.id ?? '')} onChange={(e) => setSelected(e.target.value)}>
            {registers.map((r) => (
              <option key={r.id} value={r.id}>
                {String(r.number).padStart(2, '0')} · {r.name}
                {r.isThisStation ? ' (ma caisse)' : ''}
              </option>
            ))}
            {canCentral && <option value={CENTRAL}>99 · Caisse centrale</option>}
          </select>
        </label>
        {central ? (
          <strong className="tre-state">Solde : {fcfa(state.data.centralBalance ?? 0)}</strong>
        ) : (
          <strong className={`tre-state ${open ? 'open' : 'closed'}`}>{open ? (register?.stale ? 'Ouverte (journée non clôturée)' : 'Ouverte.') : 'Fermée.'}</strong>
        )}
        <span className="spacer" />
        {central ? (
          state.data.canCentral && (
            <>
              <button onClick={() => setDialog('central-in')}>Entrée en caisse centrale…</button>
              <button onClick={() => setDialog('central-out')}>Sortie (dépôt en banque…)</button>
            </>
          )
        ) : here ? (
          open ? (
            <button className="danger" onClick={() => setDialog('close')}>
              Fermer la caisse…
            </button>
          ) : (
            <button className="primary" onClick={() => setDialog('open')}>
              Ouvrir la caisse…
            </button>
          )
        ) : state.data.canChooseRegister && register ? (
          <button
            onClick={() =>
              call('pos.chooseRegister', register.id).then(() => {
                toast.ok(`Vous travaillez sur ${register.name}`);
                reload();
              }, toast.error)
            }
          >
            Travailler sur cette caisse
          </button>
        ) : (
          <span className="muted">Seuls les utilisateurs de cette caisse l'ouvrent et la ferment.</span>
        )}
      </div>
      {!central && register?.stale && open && (
        <p className="warn-text tre-warning">
          La journée du {new Date(open.opened_at).toLocaleDateString('fr-FR')} n'a pas été clôturée. Fermez la caisse avant d'ouvrir la journée d'aujourd'hui.
        </p>
      )}

      {central ? (
        <CentralLedger key={state.data.centralBalance} />
      ) : (
        <>
          <Tabs
            value={tab}
            onChange={setTab}
            tabs={[
              ['day', 'Opérations journalières'],
              ['history', 'Historique des journées'],
            ]}
          />
          {tab === 'day' &&
            (journey.data ? (
              <Day
                journey={journey.data}
                sessions={history.data ?? []}
                onSession={setSessionId}
              />
            ) : (
              <Empty>Aucune journée pour cette caisse. {here ? 'Ouvrez la caisse pour commencer la journée.' : ''}</Empty>
            ))}
          {tab === 'history' && (
            <History
              sessions={history.data ?? []}
              onOpen={(id) => {
                setSessionId(id);
                setTab('day');
              }}
            />
          )}
        </>
      )}

      {dialog === 'open' && register && (
        <OpenDialog
          register={register}
          canOpen={state.data.canOpen}
          onClose={() => setDialog(null)}
          onDone={() => {
            setDialog(null);
            setSessionId(null);
            reload();
          }}
        />
      )}
      {dialog === 'close' && open && (
        <CloseDialog
          session={open}
          canApprove={state.data.canOpen}
          onClose={() => setDialog(null)}
          onDone={(id) => {
            setDialog(null);
            setSessionId(id);
            reload();
          }}
        />
      )}
      {(dialog === 'central-in' || dialog === 'central-out') && (
        <CentralDialog
          kind={dialog === 'central-in' ? 'IN' : 'OUT'}
          balance={state.data.centralBalance ?? 0}
          onClose={() => setDialog(null)}
          onDone={(id) => {
            setDialog(null);
            reload();
            if (confirm('Imprimer le bon ?')) call('treasury.printVoucher', id).catch(toast.error);
          }}
        />
      )}
    </div>
  );
}

/** Journée de caisse : en-tête, entrées et sorties d'espèces, puis attendu, relevé et différentiel ; ventes de la journée. */
function Day({ journey, sessions, onSession }: { journey: Journey; sessions: Result<'treasury.sessions'>; onSession: (id: string) => void }) {
  const toast = useToast();
  const { z, cash, sales } = journey;
  const se = z.session;
  const [view, setView] = useState<'cash' | 'sales' | 'z'>('cash');
  const sum = (rows: CashRow[]) => rows.filter((r) => !r.closing).reduce((t, r) => t + r.amount, 0);
  const diffClass = z.difference === null ? '' : z.difference < 0 ? 'neg' : z.difference > 0 ? 'pos' : '';
  // Bons de la journée : remise ou retour de fond à l'ouverture, versement de la recette à la clôture.
  const vouchers = journey.movements.filter((m) => !m.cash_operation_id);
  return (
    <div className="tre-day">
      <div className="tre-head">
        <Field label="Session">
          <select value={se.id} onChange={(e) => onSession(e.target.value)}>
            {sessions.map((x) => (
              <option key={x.id} value={x.id}>
                {dayTime(x.opened_at)} – {x.closed_at ? dayTime(x.closed_at) : 'en cours'}
                {x.z_number ? ` (Z${x.z_number})` : ''}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Ouverture le">
          <input readOnly value={`${dateTime(se.opened_at)} · ${se.user_name}`} />
        </Field>
        <Field label="Clôture le">
          <input readOnly value={se.closed_at ? `${dateTime(se.closed_at)} · ${se.closed_by_name ?? ''}` : ''} />
        </Field>
        <Field label="Mnt. à l'ouverture" hint={se.carried_float !== null ? `dont ${fcfa(se.carried_float)} laissés la veille` : undefined}>
          <input readOnly className="r tre-amount" value={fcfa(se.opening_float)} />
        </Field>
        <div className="tre-print">
          <button onClick={() => call('pos.printZ', se.id).catch(toast.error)}>Imprimer le Z</button>
          <button onClick={() => call('treasury.printReport', se.id).catch(toast.error)}>Rapport de clôture (A4)</button>
          {vouchers.map((m) => (
            <button key={m.id} onClick={() => call('treasury.printVoucher', m.id).catch(toast.error)}>
              {m.kind === 'FLOAT' ? 'Bon de remise de fond' : 'Bon de versement'} {m.number}
            </button>
          ))}
        </div>
      </div>
      <div className="seg">
        <button className={view === 'cash' ? 'active' : ''} onClick={() => setView('cash')}>
          Entrées et sorties de caisse
        </button>
        <button className={view === 'sales' ? 'active' : ''} onClick={() => setView('sales')}>
          Historique des ventes ({sales.length})
        </button>
        <button className={view === 'z' ? 'active' : ''} onClick={() => setView('z')}>
          Vue détaillée (Z)
        </button>
      </div>
      {view === 'cash' && (
        <div className="tre-panes">
          <CashPane title="Entrées de caisse" rows={cash.entries} party="Tiers" total={sum(cash.entries)} />
          <CashPane title="Sorties de caisse" rows={cash.exits} party="Bénéficiaire" total={sum(cash.exits)} />
        </div>
      )}
      {view === 'sales' && <SalesList sales={sales} />}
      {view === 'z' && <ZView z={z} />}
      <div className="tre-foot">
        <div>
          <small>V. à crédit</small>
          <strong className="tre-credit">{fcfa(cash.creditSales)}</strong>
        </div>
        <div>
          <small>Attendu à la clôture</small>
          <strong className="tre-amount">{fcfa(z.cash.expected)}</strong>
        </div>
        <div>
          <small>Relevé à la clôture</small>
          <strong className="tre-amount">{z.counted === null ? '—' : fcfa(z.counted)}</strong>
        </div>
        <div className={diffClass}>
          <small>Différentiel</small>
          <strong className="tre-amount">{z.difference === null ? '—' : fcfa(z.difference)}</strong>
        </div>
        {se.deposit !== null && (
          <div>
            <small>Versé à la centrale · fond laissé</small>
            <strong>
              {fcfa(se.deposit)} · {fcfa(se.float_left ?? 0)}
            </strong>
          </div>
        )}
      </div>
      {se.gap_reason && <p className="muted">Motif de l'écart : {se.gap_reason}</p>}
      {se.first_counted !== null && se.counted_cash !== null && se.first_counted !== se.counted_cash && (
        <p className="warn-text">Premier comptage : {fcfa(se.first_counted)} (recompté ensuite).</p>
      )}
    </div>
  );
}

function CashPane({ title, rows, party, total }: { title: string; rows: CashRow[]; party: string; total: number }) {
  return (
    <section className="tre-pane">
      <h3>{title}</h3>
      <div className="tre-scroll">
        <table className="list compact">
          <thead>
            <tr>
              <th>Heure</th>
              <th className="r">Montant</th>
              <th>Nature</th>
              <th>Motif</th>
              <th>{party}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className={r.closing ? 'muted' : ''} title={r.user_name ?? ''}>
                <td>{dayTime(r.at)}</td>
                <td className="r">{fcfa(r.amount)}</td>
                <td>{r.nature}</td>
                <td>{r.label}</td>
                <td>{r.party ?? ''}</td>
              </tr>
            ))}
            {!rows.length && (
              <tr>
                <td colSpan={5} className="muted">
                  Aucune opération
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="tre-sum">
        Somme <b>{fcfa(total)}</b>
      </div>
    </section>
  );
}

function SalesList({ sales }: { sales: Journey['sales'] }) {
  const [open, setOpen] = useState<Result<'pos.sale'> | null>(null);
  const toast = useToast();
  return (
    <div className="tre-scroll tall">
      <table className="list compact">
        <thead>
          <tr>
            <th>Ticket</th>
            <th>Heure</th>
            <th>Vendeur</th>
            <th>Client</th>
            <th>Type</th>
            <th className="r">Remise</th>
            <th className="r">Montant</th>
          </tr>
        </thead>
        <tbody>
          {sales.map((x) => (
            <tr
              key={x.id}
              className={`clickable ${x.status === 'cancelled' ? 'inactive' : ''}`}
              onDoubleClick={() => call('pos.sale', x.id).then(setOpen, toast.error)}
              title="Double-clic : détail du ticket"
            >
              <td>{x.number}</td>
              <td>{time(x.created_at)}</td>
              <td>{x.user_name}</td>
              <td>{x.customer_name ?? ''}</td>
              <td>{x.kind === 'return' ? 'Retour' : x.status === 'cancelled' ? `Annulé${x.cancel_reason ? ` : ${x.cancel_reason}` : ''}` : 'Vente'}</td>
              <td className="r">{x.total_discount ? fcfa(x.total_discount) : ''}</td>
              <td className="r">{fcfa(x.total_ttc)}</td>
            </tr>
          ))}
          {!sales.length && (
            <tr>
              <td colSpan={7} className="muted">
                Aucune vente
              </td>
            </tr>
          )}
        </tbody>
      </table>
      {open && (
        <Modal title={`Ticket ${open.number}`} onClose={() => setOpen(null)}>
          <table className="list compact">
            <tbody>
              {open.lines.map((l) => (
                <tr key={l.id}>
                  <td>{l.label}</td>
                  <td className="r">{fcfa(l.total_ttc)}</td>
                </tr>
              ))}
              <tr>
                <th>Total</th>
                <th className="r">{fcfa(open.total_ttc)}</th>
              </tr>
            </tbody>
          </table>
        </Modal>
      )}
    </div>
  );
}

function History({ sessions, onOpen }: { sessions: Result<'treasury.sessions'>; onOpen: (id: string) => void }) {
  return (
    <table className="list">
      <thead>
        <tr>
          <th>Z</th>
          <th>Ouverture</th>
          <th>Clôture</th>
          <th>Ouverte par</th>
          <th>Fermée par</th>
          <th className="r">Fond</th>
          <th className="r">Attendu</th>
          <th className="r">Relevé</th>
          <th className="r">Écart</th>
          <th className="r">Versé à la centrale</th>
        </tr>
      </thead>
      <tbody>
        {sessions.map((x) => (
          <tr key={x.id} className="clickable" onClick={() => onOpen(x.id)}>
            <td>{x.z_number ?? '—'}</td>
            <td>{dateTime(x.opened_at)}</td>
            <td>{x.closed_at ? dateTime(x.closed_at) : <span className="tag normal">En cours</span>}</td>
            <td>{x.user_name}</td>
            <td>{x.closed_by_name ?? ''}</td>
            <td className="r">{fcfa(x.opening_float)}</td>
            <td className="r">{x.expected_cash === null ? '' : fcfa(x.expected_cash)}</td>
            <td className="r">{x.counted_cash === null ? '' : fcfa(x.counted_cash)}</td>
            <td className={`r ${x.difference ? (x.difference < 0 ? 'neg' : 'pos') : ''}`}>{x.difference === null ? '' : fcfa(x.difference)}</td>
            <td className="r">{x.deposit === null ? '' : fcfa(x.deposit)}</td>
          </tr>
        ))}
        {!sessions.length && (
          <tr>
            <td colSpan={10} className="muted">
              Aucune journée
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
}

/** Grille de comptage par coupure FCFA. */
function Denominations({ count, onChange }: { count: Record<number, number>; onChange: (c: Record<number, number>) => void }) {
  return (
    <div className="denoms">
      {DENOMINATIONS_FCFA.map((d) => (
        <label key={d}>
          <span>{fcfa(d)}</span>
          <input type="number" min={0} value={count[d] ?? ''} onChange={(e) => onChange({ ...count, [d]: Math.max(0, Math.floor(Number(e.target.value) || 0)) })} />
          <small>{fcfa(d * (count[d] ?? 0))}</small>
        </label>
      ))}
    </div>
  );
}

/**
 * Ouverture : le fond proposé est celui laissé à la dernière clôture. Un fond
 * plus élevé est complété par la caisse centrale ; un fond plus bas lui rend l'excédent.
 */
function OpenDialog({ register, canOpen, onClose, onDone }: { register: RegisterRow; canOpen: boolean; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const carried = register.carriedFloat;
  const [amount, setAmount] = useState(carried === null ? '' : String(carried));
  const [count, setCount] = useState<Record<number, number> | null>(null);
  const [pin, setPin] = useState('');
  const value = count ? countedTotal(count) : parseAmount(amount || '0');
  const delta = carried === null || value === null ? 0 : value - carried;
  return (
    <Modal title={`Ouvrir ${register.name}`} onClose={onClose} wide={Boolean(count)}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (value === null) return toast.error('Montant invalide');
          try {
            const opened = await call('treasury.open', value, canOpen ? undefined : pin, register.id);
            toast.ok(`${register.name} ouverte avec un fond de ${fcfa(value)}`);
            // Complément ou retour de fond : bon à signer entre la caisse et la centrale.
            if (opened.voucherId) call('treasury.printVoucher', opened.voucherId).catch(toast.error);
            onDone();
          } catch (err) {
            toast.error(err);
          }
        }}
      >
        <p>
          {carried === null
            ? "Première journée suivie : indiquez les espèces présentes dans le tiroir."
            : `Fond laissé dans le tiroir à la dernière clôture : ${fcfa(carried)}.`}
        </p>
        {count ? (
          <Denominations count={count} onChange={setCount} />
        ) : (
          <Field label="Fond de caisse (FCFA)">
            <input autoFocus inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0" />
          </Field>
        )}
        <button type="button" className="link" onClick={() => setCount(count ? null : {})}>
          {count ? 'Saisir un montant' : 'Compter par coupures'}
        </button>
        {delta > 0 && <p className="warn-text">Complément de {fcfa(delta)} pris dans la caisse centrale (bon de remise de fond).</p>}
        {delta < 0 && <p className="warn-text">{fcfa(-delta)} rendus à la caisse centrale.</p>}
        {!canOpen && (
          <Field label="Code du gérant" hint="L'ouverture de la caisse est validée par le gérant">
            <input type="password" inputMode="numeric" value={pin} onChange={(e) => setPin(e.target.value)} />
          </Field>
        )}
        <div className="actions">
          {value !== null && <span className="big-total">{fcfa(value)}</span>}
          <button type="submit" className="primary" disabled={value === null || (!canOpen && !pin)}>
            Ouvrir la caisse
          </button>
        </div>
      </form>
    </Modal>
  );
}

/**
 * Clôture en trois temps : comptage à l'aveugle par coupures, écart (motif et
 * code du gérant au-delà du seuil) et fond laissé, puis versement à la centrale.
 */
function CloseDialog({
  session,
  canApprove,
  onClose,
  onDone,
}: {
  session: NonNullable<RegisterRow['session']>;
  canApprove: boolean;
  onClose: () => void;
  onDone: (sessionId: string) => void;
}) {
  const toast = useToast();
  const [count, setCount] = useState<Record<number, number>>({});
  const [preview, setPreview] = useState<Result<'treasury.countPreview'> | null>(null);
  const [floatText, setFloatText] = useState('');
  const [reason, setReason] = useState('');
  const [pin, setPin] = useState('');
  const [done, setDone] = useState<Result<'treasury.close'> | null>(null);
  const counted = countedTotal(count);
  const floatLeft = parseAmount(floatText || '0');
  const deposit = preview && floatLeft !== null ? preview.counted - floatLeft : null;

  if (done) {
    const deposits = done.session.deposit ?? 0;
    return (
      <Modal title={`Caisse fermée · Z n° ${done.session.z_number}`} onClose={() => onDone(done.session.id)} wide>
        <ZView z={done} />
        <p>
          Versé à la caisse centrale : <b>{fcfa(deposits)}</b> · fond laissé dans le tiroir : <b>{fcfa(done.session.float_left ?? 0)}</b>
        </p>
        <div className="actions">
          <button onClick={() => call('treasury.printReport', done.session.id).catch(toast.error)}>Rapport de clôture (A4)</button>
          <button className="primary" onClick={() => onDone(done.session.id)}>
            Terminer
          </button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="Fermer la caisse" onClose={onClose} wide>
      {!preview ? (
        <>
          <p>Comptez les espèces du tiroir par coupure. L'attendu s'affiche après le comptage.</p>
          <Denominations count={count} onChange={setCount} />
          <div className="actions">
            <span className="big-total">{fcfa(counted)}</span>
            <button
              className="primary"
              onClick={async () => {
                try {
                  const p = await call('treasury.countPreview', count, session.register_id);
                  setPreview(p);
                  setFloatText(String(Math.min(session.opening_float, p.counted)));
                } catch (e) {
                  toast.error(e);
                }
              }}
            >
              Valider le comptage
            </button>
          </div>
        </>
      ) : (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (floatLeft === null) return toast.error('Fond invalide');
            try {
              const z = await call('treasury.close', count, { floatLeft, gapReason: reason, supervisorPin: pin || undefined, registerId: session.register_id });
              setDone(z);
              call('pos.printZ', z.session.id).catch(toast.error);
              const dep = (await call('treasury.session', z.session.id)).movements.find((m) => m.kind === 'DEPOSIT' && !m.cash_operation_id);
              if (dep) call('treasury.printVoucher', dep.id).catch(toast.error);
            } catch (err) {
              toast.error(err);
            }
          }}
        >
          <div className="kpis">
            <div>
              <small>Attendu</small>
              <strong>{fcfa(preview.expected)}</strong>
            </div>
            <div>
              <small>Relevé</small>
              <strong>{fcfa(preview.counted)}</strong>
            </div>
            <div className={preview.difference < 0 ? 'neg' : preview.difference > 0 ? 'pos' : ''}>
              <small>Différentiel</small>
              <strong>{fcfa(preview.difference)}</strong>
            </div>
          </div>
          {preview.needsApproval && (
            <>
              <p className="danger-text">Écart supérieur à {fcfa(preview.threshold)} : indiquez le motif{canApprove ? '' : ' et faites valider par le gérant'}.</p>
              <div className="grid2">
                <Field label="Motif de l'écart">
                  <input autoFocus value={reason} onChange={(e) => setReason(e.target.value)} />
                </Field>
                {!canApprove && (
                  <Field label="Code du gérant">
                    <input type="password" inputMode="numeric" value={pin} onChange={(e) => setPin(e.target.value)} />
                  </Field>
                )}
              </div>
            </>
          )}
          <div className="grid2">
            <Field label="Fond laissé dans le tiroir pour demain" hint={`Fond de ce matin : ${fcfa(session.opening_float)}`}>
              <input inputMode="numeric" value={floatText} onChange={(e) => setFloatText(e.target.value)} />
            </Field>
            <Field label="Versé à la caisse centrale">
              <input readOnly className="r" value={deposit === null || deposit < 0 ? '—' : fcfa(deposit)} />
            </Field>
          </div>
          <div className="actions">
            <button type="button" className="ghost" onClick={() => setPreview(null)}>
              Recompter
            </button>
            <button
              type="submit"
              className="danger"
              disabled={deposit === null || deposit < 0 || (preview.needsApproval && (!reason.trim() || (!canApprove && !pin)))}
            >
              Clôturer, verser et imprimer
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}

/**
 * Trésorerie du caissier ou du vendeur : il ouvre et ferme sa caisse, voit les
 * sorties d'espèces qu'il a faites lui-même et ses bons ; rien sur les ventes ni l'attendu.
 */
function CashierTreasury({ user, registerId = null, onChanged }: TreasuryProps) {
  const toast = useToast();
  const state = useLoad(() => call('treasury.state'), [registerId]);
  const day = useLoad(() => call('treasury.myDay'), [registerId]);
  const [dialog, setDialog] = useState<'open' | 'close' | null>(null);
  const reload = () => {
    state.reload();
    day.reload();
    onChanged?.();
  };

  if (!state.data) return null;
  const register = state.data.registers.find((r) => r.isThisStation);
  const open = register?.session ?? null;
  const d = day.data && day.data.session.register_id === register?.id ? day.data : null;
  const exits = d?.exits ?? [];

  return (
    <div className="page treasury">
      <header className="page-head">
        <h1>Opérations de trésorerie</h1>
      </header>
      {!register ? (
        <Empty>Aucune caisse ne vous est attribuée. Demandez à l'administrateur de vous en attribuer une.</Empty>
      ) : (
        <>
          <div className="tre-bar">
            <label>
              Ma caisse
              <input readOnly value={`${String(register.number).padStart(2, '0')} · ${register.name}`} />
            </label>
            <strong className={`tre-state ${open ? 'open' : 'closed'}`}>{open ? (register.stale ? 'Ouverte (journée non clôturée)' : 'Ouverte.') : 'Fermée.'}</strong>
            <span className="spacer" />
            {open ? (
              <button className="danger" onClick={() => setDialog('close')}>
                Fermer la caisse…
              </button>
            ) : (
              <button className="primary" onClick={() => setDialog('open')}>
                Ouvrir la caisse…
              </button>
            )}
          </div>
          {register.stale && open && (
            <p className="warn-text tre-warning">
              La journée du {new Date(open.opened_at).toLocaleDateString('fr-FR')} n'a pas été clôturée. Fermez la caisse avant d'ouvrir la journée d'aujourd'hui.
            </p>
          )}
          {d ? (
            <div className="tre-day">
              <div className="tre-head">
                <Field label="Ouverture le">
                  <input readOnly value={`${dateTime(d.session.opened_at)} · ${d.session.user_name}`} />
                </Field>
                <Field label="Clôture le">
                  <input readOnly value={d.session.closed_at ? `${dateTime(d.session.closed_at)} · ${d.session.closed_by_name ?? ''}` : ''} />
                </Field>
                <Field label="Fond de caisse à l'ouverture">
                  <input readOnly className="r tre-amount" value={fcfa(d.session.opening_float)} />
                </Field>
                <div className="tre-print">
                  {d.vouchers.map((m) => (
                    <button key={m.id} onClick={() => call('treasury.printVoucher', m.id).catch(toast.error)}>
                      {m.kind === 'FLOAT' ? 'Bon de remise de fond' : 'Bon de versement'} {m.number}
                    </button>
                  ))}
                </div>
              </div>
              <div className="tre-panes single">
                <CashPane title="Mes sorties de caisse" rows={exits} party="Bénéficiaire" total={exits.reduce((t, r) => t + r.amount, 0)} />
              </div>
              {d.session.deposit !== null && (
                <div className="tre-foot">
                  <div>
                    <small>Versé à la caisse centrale</small>
                    <strong className="tre-amount">{fcfa(d.session.deposit)}</strong>
                  </div>
                  <div>
                    <small>Fond laissé dans le tiroir</small>
                    <strong className="tre-amount">{fcfa(d.session.float_left ?? 0)}</strong>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <Empty>Aucune journée pour votre caisse. Ouvrez la caisse pour commencer la journée.</Empty>
          )}
        </>
      )}
      {dialog === 'open' && register && (
        <OpenDialog
          register={register}
          canOpen={state.data.canOpen}
          onClose={() => setDialog(null)}
          onDone={() => {
            setDialog(null);
            reload();
          }}
        />
      )}
      {dialog === 'close' && open && (
        <BlindCloseDialog
          session={open}
          user={user}
          onClose={() => setDialog(null)}
          onDone={() => {
            setDialog(null);
            reload();
          }}
        />
      )}
    </div>
  );
}

/**
 * Clôture par le caissier, sans attendu ni écart : il compte, laisse le fond et
 * verse le reste. Si l'écart dépasse le seuil, le gérant vient valider avec son
 * code ; lui seul voit l'écart et en saisit le motif. Seul le bon de versement s'imprime.
 */
function BlindCloseDialog({ session, user, onClose, onDone }: { session: NonNullable<RegisterRow['session']>; user: User; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [count, setCount] = useState<Record<number, number>>({});
  const [checked, setChecked] = useState<Result<'treasury.blindCount'> | null>(null);
  const [pin, setPin] = useState('');
  const [approval, setApproval] = useState<Result<'treasury.countPreview'> | null>(null);
  const [reason, setReason] = useState('');
  const [floatText, setFloatText] = useState('');
  const [done, setDone] = useState<Result<'treasury.closeBlind'> | null>(null);
  const counted = countedTotal(count);
  const floatLeft = parseAmount(floatText || '0');
  const deposit = checked && floatLeft !== null ? checked.counted - floatLeft : null;
  const blocked = Boolean(checked?.needsApproval && !approval);

  if (done) {
    return (
      <Modal title="Caisse fermée" onClose={onDone} wide>
        <p>Merci {user.name}. Remettez la recette à la caisse centrale avec le bon de versement.</p>
        <div className="kpis">
          <div>
            <small>Espèces comptées</small>
            <strong>{fcfa(done.counted)}</strong>
          </div>
          <div>
            <small>Fond laissé dans le tiroir</small>
            <strong>{fcfa(done.floatLeft)}</strong>
          </div>
          <div>
            <small>Versé à la caisse centrale</small>
            <strong>{fcfa(done.deposit)}</strong>
          </div>
        </div>
        <div className="actions">
          {done.voucherId && <button onClick={() => call('treasury.printVoucher', done.voucherId!).catch(toast.error)}>Réimprimer le bon {done.voucherNumber}</button>}
          <button className="primary" onClick={onDone}>
            Terminer
          </button>
        </div>
      </Modal>
    );
  }

  const recount = () => {
    setChecked(null);
    setApproval(null);
    setPin('');
    setReason('');
  };

  return (
    <Modal title="Fermer la caisse" onClose={onClose} wide>
      {!checked ? (
        <>
          <p>Comptez les espèces du tiroir par coupure.</p>
          <Denominations count={count} onChange={setCount} />
          <div className="actions">
            <span className="big-total">{fcfa(counted)}</span>
            <button
              className="primary"
              onClick={async () => {
                try {
                  const c = await call('treasury.blindCount', count, session.register_id);
                  setChecked(c);
                  setFloatText(String(Math.min(session.opening_float, c.counted)));
                } catch (e) {
                  toast.error(e);
                }
              }}
            >
              Valider le comptage
            </button>
          </div>
        </>
      ) : blocked ? (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              setApproval(await call('treasury.countPreview', count, session.register_id, pin));
            } catch (err) {
              toast.error(err);
            }
          }}
        >
          <p className="danger-text">Le comptage ne correspond pas à la caisse. Recomptez, ou appelez le gérant pour valider la clôture.</p>
          <Field label="Code du gérant">
            <input autoFocus type="password" inputMode="numeric" value={pin} onChange={(e) => setPin(e.target.value)} />
          </Field>
          <div className="actions">
            <button type="button" className="ghost" onClick={recount}>
              Recompter
            </button>
            <button type="submit" className="primary" disabled={!pin}>
              Valider (gérant)
            </button>
          </div>
        </form>
      ) : (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (floatLeft === null) return toast.error('Fond invalide');
            try {
              const r = await call('treasury.closeBlind', count, {
                floatLeft,
                gapReason: approval ? reason : null,
                supervisorPin: approval ? pin : undefined,
                registerId: session.register_id,
              });
              setDone(r);
              if (r.voucherId) call('treasury.printVoucher', r.voucherId).catch(toast.error);
            } catch (err) {
              toast.error(err);
            }
          }}
        >
          {approval && (
            <>
              <p className="muted">Réservé au gérant :</p>
              <div className="kpis">
                <div>
                  <small>Attendu</small>
                  <strong>{fcfa(approval.expected)}</strong>
                </div>
                <div>
                  <small>Relevé</small>
                  <strong>{fcfa(approval.counted)}</strong>
                </div>
                <div className={approval.difference < 0 ? 'neg' : approval.difference > 0 ? 'pos' : ''}>
                  <small>Différentiel</small>
                  <strong>{fcfa(approval.difference)}</strong>
                </div>
              </div>
              <Field label="Motif de l'écart (saisi par le gérant)">
                <input autoFocus value={reason} onChange={(e) => setReason(e.target.value)} />
              </Field>
            </>
          )}
          <div className="grid2">
            <Field label="Fond laissé dans le tiroir pour demain" hint={`Fond de ce matin : ${fcfa(session.opening_float)}`}>
              <input inputMode="numeric" value={floatText} onChange={(e) => setFloatText(e.target.value)} />
            </Field>
            <Field label="Versé à la caisse centrale">
              <input readOnly className="r" value={deposit === null || deposit < 0 ? '—' : fcfa(deposit)} />
            </Field>
          </div>
          <div className="actions">
            <button type="button" className="ghost" onClick={recount}>
              Recompter
            </button>
            <button type="submit" className="danger" disabled={deposit === null || deposit < 0 || Boolean(approval && !reason.trim())}>
              Clôturer et verser
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}

const NATURES = {
  IN: [
    ['bank', 'Retrait à la banque'],
    ['owner', "Apport de l'exploitant"],
  ],
  OUT: [
    ['bank', 'Dépôt à la banque'],
    ['owner', "Retrait de l'exploitant"],
  ],
} as const;

function CentralDialog({ kind, balance, onClose, onDone }: { kind: 'IN' | 'OUT'; balance: number; onClose: () => void; onDone: (movementId: string) => void }) {
  const toast = useToast();
  const [nature, setNature] = useState<'bank' | 'owner'>('bank');
  const [amount, setAmount] = useState('');
  const [label, setLabel] = useState('');
  const value = parseAmount(amount);
  return (
    <Modal title={kind === 'IN' ? 'Entrée en caisse centrale' : 'Sortie de la caisse centrale'} onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            const m = await call('treasury.record', { kind, nature, amount: value ?? 0, label });
            toast.ok('Mouvement enregistré');
            onDone(m.id);
          } catch (err) {
            toast.error(err);
          }
        }}
      >
        <Field label="Nature">
          <select value={nature} onChange={(e) => setNature(e.target.value as 'bank' | 'owner')}>
            {NATURES[kind].map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Montant (FCFA)" hint={kind === 'OUT' ? `Solde de la caisse centrale : ${fcfa(balance)}` : undefined}>
          <input autoFocus inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </Field>
        <Field label="Libellé (facultatif)">
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Bordereau n°, banque…" />
        </Field>
        <div className="actions">
          <button type="submit" className="primary" disabled={!value}>
            Enregistrer
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** Livre de la caisse centrale : versements des caisses, fonds remis, paiements au bureau, dépôts en banque. */
function CentralLedger() {
  const toast = useToast();
  const [from, setFrom] = useState(() => `${today().slice(0, 8)}01`);
  const [to, setTo] = useState(today());
  const ledger = useLoad(() => call('treasury.central', { from, to }), [from, to]);
  const rows = ledger.data?.rows ?? [];
  const ins = rows.filter((r) => r.amount > 0).reduce((t, r) => t + r.amount, 0);
  const outs = rows.filter((r) => r.amount < 0).reduce((t, r) => t - r.amount, 0);
  return (
    <>
      <div className="filters">
        Du <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /> au <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        <span className="muted">Solde au {dateFr(from)} : {fcfa(ledger.data?.opening ?? 0)}</span>
      </div>
      <div className="tre-scroll tall">
        <table className="list compact">
          <thead>
            <tr>
              <th>Date</th>
              <th>Pièce</th>
              <th>Opération</th>
              <th>Caisse ou tiers</th>
              <th>Par</th>
              <th className="r">Entrée</th>
              <th className="r">Sortie</th>
              <th className="r">Solde</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.source}-${r.id}`}>
                <td>{dateTime(r.at)}</td>
                <td>{r.number}</td>
                <td>{r.label}</td>
                <td>{r.party ?? ''}</td>
                <td>{r.user_name ?? ''}</td>
                <td className="r">{r.amount > 0 ? fcfa(r.amount) : ''}</td>
                <td className="r">{r.amount < 0 ? fcfa(-r.amount) : ''}</td>
                <td className={`r ${r.balance < 0 ? 'neg' : ''}`}>{fcfa(r.balance)}</td>
                <td>
                  {r.source === 'movement' && (
                    <button className="link" onClick={() => call('treasury.printVoucher', r.id).catch(toast.error)}>
                      Bon
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {!rows.length && (
              <tr>
                <td colSpan={9} className="muted">
                  Aucun mouvement sur la période
                </td>
              </tr>
            )}
          </tbody>
          <tfoot>
            <tr>
              <th colSpan={5}>Totaux de la période</th>
              <th className="r">{fcfa(ins)}</th>
              <th className="r">{fcfa(outs)}</th>
              <th className="r">{fcfa(ledger.data?.closing ?? 0)}</th>
              <th></th>
            </tr>
          </tfoot>
        </table>
      </div>
    </>
  );
}
