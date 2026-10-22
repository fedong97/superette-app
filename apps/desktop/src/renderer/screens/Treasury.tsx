import { useEffect, useState } from 'react';
import { BANK_METHODS, DENOMINATIONS_FCFA, ELECTRONIC_METHODS, PAYMENT_METHODS, type PaymentMethod, type RegisterKind, countedTotal } from '@superette/core';
import { type Result, call } from '../api';
import { askConfirm, Empty, Field, Mascot, Modal, Tabs, dateFr, dateTime, fcfa, parseAmount, today, useCan, useLoad, useToast, PhoneApproval } from '../ui';
import { CashInDialog, CashOutDialog, DeskActions, type DeskProps, type DeskRow, NatureTotals } from './CashDesk';
import { EmoneyCentral } from './EmoneyCentral';
import { ZView } from './PosDialogs';
import { BeforeClose } from './Floor';

type User = NonNullable<Result<'app.state'>['user']>;
type State = Result<'treasury.state'>;
type RegisterRow = State['registers'][number];
type LinkedRow = State['linked'][number];
type Journey = Result<'treasury.session'>;
type CashRow = Journey['cash']['entries'][number];

export type TreasuryTab = 'day' | 'history' | 'central' | 'emoney';

/** Caisse choisie en haut de l'écran : une caisse de vente, ou la caisse centrale. */
const CENTRAL = 'central';
/** Caisses électroniques : soldes de chacune et livre de la centrale électronique. */
const EMONEY = 'emoney';

const KIND_LABEL: Record<RegisterKind, string> = { cash: 'Espèces', electronic: 'Électronique', bank: 'Banque' };
const KIND_METHODS: Record<Exclude<RegisterKind, 'cash'>, readonly PaymentMethod[]> = { electronic: ELECTRONIC_METHODS, bank: BANK_METHODS };

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
 * Opérations de trésorerie : ouverture de la journée avec
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
  const [selected, setSelected] = useState<string | null>(canCentral && initialTab === 'central' ? CENTRAL : canCentral && initialTab === 'emoney' ? EMONEY : null);
  const [tab, setTab] = useState<Exclude<TreasuryTab, 'central' | 'emoney'>>(initialTab === 'history' ? 'history' : 'day');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<'open' | 'close' | 'handover' | 'declared' | 'central-in' | 'central-out' | null>(null);
  // Historique filtré par type de caisse : espèces, électronique ou banque.
  const [kind, setKind] = useState<RegisterKind | 'all'>('all');

  const registers = (state.data?.registers ?? []).filter((r) => kind === 'all' || r.kind === kind);
  const register: RegisterRow | undefined = registers.find((r) => r.id === selected) ?? registers.find((r) => r.isThisStation) ?? registers[0];
  const emoneyView = selected === EMONEY;
  const central = selected === CENTRAL || emoneyView;
  const history = useLoad(() => (register && !central ? call('treasury.sessions', register.id) : Promise.resolve([])), [register?.id, central]);
  // Journée affichée : celle choisie, sinon la journée ouverte, sinon la dernière clôturée.
  const shownId = sessionId ?? register?.session?.id ?? history.data?.[0]?.id ?? null;
  const journey = useLoad(() => (shownId && !central ? call('treasury.session', shownId) : Promise.resolve(null)), [shownId, central]);

  // Écarts à justifier, toutes caisses : un clic ouvre la journée sur sa caisse.
  const gaps = useLoad(() => call('treasury.pendingGaps'), []);
  const [jump, setJump] = useState<string | null>(null);
  useEffect(() => {
    setSessionId(jump);
    setJump(null);
  }, [register?.id]);
  const openGap = (g: { id: string; register_id: string }) => {
    setTab('day');
    if (g.register_id === register?.id) return setSessionId(g.id);
    setJump(g.id);
    setSelected(g.register_id);
  };
  // Le gérant vient de changer de caisse : on affiche la nouvelle.
  useEffect(() => {
    if (selected !== CENTRAL && selected !== EMONEY) setSelected(null);
  }, [registerId]);
  const reload = () => {
    state.reload();
    history.reload();
    journey.reload();
    gaps.reload();
    onChanged?.();
  };

  if (!state.data) return null;
  const open = register?.session ?? null;
  const here = Boolean(register?.isThisStation);
  const declared = Boolean(register && register.kind !== 'cash');
  const mine = Boolean(register && state.data.linked.some((l) => l.id === register.id));

  return (
    <div className="page treasury">
      <header className="page-head">
        <h1>Opérations de trésorerie</h1>
      </header>
      <div className="tre-bar">
        <label>
          Type
          <select
            className="tre-kind"
            value={kind}
            onChange={(e) => {
              setKind(e.target.value as RegisterKind | 'all');
              setSelected(null);
              setSessionId(null);
            }}
          >
            <option value="all">Toutes</option>
            {(Object.keys(KIND_LABEL) as RegisterKind[]).map((k) => (
              <option key={k} value={k}>
                {KIND_LABEL[k]}
              </option>
            ))}
          </select>
        </label>
        <label>
          Caisse
          <select value={emoneyView ? EMONEY : central ? CENTRAL : (register?.id ?? '')} onChange={(e) => setSelected(e.target.value)}>
            {registers.map((r) => (
              <option key={r.id} value={r.id}>
                {String(r.number).padStart(2, '0')} · {r.name}
                {r.kind !== 'cash' ? ` (${KIND_LABEL[r.kind].toLowerCase()})` : ''}
                {r.isThisStation || state.data!.linked.some((l) => l.id === r.id) ? ' (ma caisse)' : ''}
              </option>
            ))}
            {canCentral && <option value={EMONEY}>98 · Caisses électroniques (soldes, centrale)</option>}
            {canCentral && <option value={CENTRAL}>99 · Caisse centrale</option>}
          </select>
        </label>
        {emoneyView ? null : central ? (
          <strong className="tre-state">Solde : {fcfa(state.data.centralBalance ?? 0)}</strong>
        ) : (
          <strong className={`tre-state ${open ? 'open' : 'closed'}`}>{open ? (register?.stale ? 'Ouverte (journée non clôturée)' : 'Ouverte.') : 'Fermée.'}</strong>
        )}
        <span className="spacer" />
        {emoneyView ? null : central ? (
          state.data.canCentral && (
            <>
              <button onClick={() => setDialog('central-in')}>Entrée en caisse centrale…</button>
              <button onClick={() => setDialog('central-out')}>Sortie (dépôt en banque…)</button>
            </>
          )
        ) : declared ? (
          open && (mine || state.data.canOpen) ? (
            <button className="danger" onClick={() => setDialog('declared')}>
              Clôturer la caisse…
            </button>
          ) : !open && mine ? (
            <button className="primary" onClick={() => call('treasury.openLinked').then(reload, toast.error)}>
              Ouvrir la caisse
            </button>
          ) : (
            <span className="muted">{open ? 'Seul son caissier ou le gérant la clôture.' : 'Elle s’ouvre avec la caisse espèces de son caissier.'}</span>
          )
        ) : here ? (
          open ? (
            <>
              <button onClick={() => setDialog('handover')}>Relève d'équipe…</button>
              <button className="danger" onClick={() => setDialog('close')}>
                Fermer la caisse…
              </button>
            </>
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

      {emoneyView ? (
        <EmoneyCentral />
      ) : central ? (
        <CentralLedger key={state.data.centralBalance} />
      ) : (
        <>
          <Tabs
            value={tab}
            onChange={setTab}
            tabs={[
              ['day', 'Opérations journalières'],
              ...(user.rights.includes('cash_history') ? ([['history', 'Historique des journées']] as [Exclude<TreasuryTab, 'central' | 'emoney'>, string][]) : []),
            ]}
          />
          {tab === 'day' &&
            (journey.data ? (
              <Day
                journey={journey.data}
                sessions={history.data ?? []}
                onSession={setSessionId}
                threshold={state.data.gapThreshold}
                canJustify={user.rights.includes('gap_justify')}
                onJustified={reload}
              />
            ) : (
              <Empty action={here && !open ? { label: 'Ouvrir la caisse…', onClick: () => setDialog('open') } : undefined}>
                Aucune journée pour cette caisse. {here ? 'Ouvrez la caisse pour commencer la journée : le fond laissé la veille est proposé.' : 'Elle s’ouvre depuis le poste de son caissier.'}
              </Empty>
            ))}
          {tab === 'history' && Boolean(gaps.data?.length) && (
            <section className="tre-gaps">
              <h3>Écarts à justifier</h3>
              <table className="list compact">
                <tbody>
                  {gaps.data!.map((g) => (
                    <tr key={g.id} className="clickable" onClick={() => openGap(g)}>
                      <td>{registers.find((r) => r.id === g.register_id)?.name ?? ''}</td>
                      <td>Z{g.z_number}</td>
                      <td>{g.closed_at ? dateTime(g.closed_at) : ''}</td>
                      <td>{g.closed_by_name ?? g.user_name}</td>
                      <td className={`r ${(g.difference ?? 0) < 0 ? 'neg' : 'pos'}`}>{fcfa(g.difference ?? 0)}</td>
                      <td>
                        <button className="link">Ouvrir la journée</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}
          {tab === 'history' && (
            <History
              sessions={history.data ?? []}
              threshold={state.data.gapThreshold}
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
      {dialog === 'handover' && open && (
        <HandoverDialog
          session={open}
          user={user}
          onClose={() => setDialog(null)}
          onDone={() => {
            setDialog(null);
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
      {dialog === 'declared' && register && open && (
        <DeclaredCloseDialog
          register={register}
          session={open}
          blind={false}
          canApprove={state.data.canOpen}
          threshold={state.data.gapThreshold}
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
          onDone={async (id) => {
            setDialog(null);
            reload();
            if (await askConfirm('Imprimer le bon ?')) call('treasury.printVoucher', id).catch(toast.error);
          }}
        />
      )}
    </div>
  );
}

/** Journée de caisse : en-tête, entrées et sorties d'espèces, puis attendu, relevé et différentiel ; ventes de la journée. */
/** Écart d'une journée clôturée au-delà du seuil, sans motif du gérant. */
const gapPending = (x: { status: string; difference: number | null; gap_reason: string | null }, threshold: number) =>
  x.status === 'closed' && x.difference !== null && !x.gap_reason && Math.abs(x.difference) > threshold;

function Day({
  journey,
  sessions,
  onSession,
  threshold,
  canJustify,
  onJustified,
}: {
  journey: Journey;
  sessions: Result<'treasury.sessions'>;
  onSession: (id: string) => void;
  threshold: number;
  canJustify: boolean;
  onJustified: () => void;
}) {
  const toast = useToast();
  const can = useCan();
  const [justifying, setJustifying] = useState(false);
  const { z, cash, sales } = journey;
  const se = z.session;
  const [view, setView] = useState<'cash' | 'sales' | 'z'>('cash');
  const sum = (rows: CashRow[]) => rows.filter((r) => !r.closing).reduce((t, r) => t + r.amount, 0);
  const diffClass = z.difference === null ? '' : z.difference < 0 ? 'neg' : z.difference > 0 ? 'pos' : '';
  // Bons de la journée : remise ou retour de fond à l'ouverture, versement de la recette à la clôture.
  const vouchers = journey.movements.filter((m) => !m.cash_operation_id);
  // Caisse électronique ou banque : le Z par moyen tient lieu de pied de journée.
  const declared = z.declared;
  // Caisse électronique : entrées et sorties du compte, avec le moyen et la référence.
  const ej = z.emoneyJournal;
  const ejRows = (rows: NonNullable<typeof ej>['entries']): CashRow[] =>
    rows.map((r) => ({
      source: r.source,
      id: r.id,
      number: r.number,
      kind: r.kind,
      at: r.at,
      amount: r.amount,
      nature: r.nature,
      label: `${r.label} · ${r.method_label}${r.reference ? ` ${r.reference}` : ''}`,
      party: r.party,
      user_name: r.user_name,
      user_id: r.user_id,
      closing: r.closing,
    }));
  const [eview, setEview] = useState<'journal' | 'z'>('journal');
  // Encaisser, Décaisser et le bouton Action de chaque volet.
  const desk: DeskProps | null = can('cash_desk') ? { sessionId: se.id, open: se.status === 'open', onChanged: onJustified } : null;
  const [totals, setTotals] = useState(false);
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
        {!declared && (
          <Field label="Mnt. à l'ouverture" hint={se.carried_float !== null ? `dont ${fcfa(se.carried_float)} laissés la veille` : undefined}>
            <input readOnly className="r tre-amount" value={fcfa(se.opening_float)} />
          </Field>
        )}
        <div className="tre-print">
          {can('cash_z') && <button onClick={() => call('pos.printZ', se.id).catch(toast.error)}>Imprimer le Z</button>}
          <button onClick={() => call('treasury.printReport', se.id).catch(toast.error)}>{declared ? 'Bon de clôture (A4)' : 'Rapport de clôture (A4)'}</button>
          {vouchers.map((m) => (
            <button key={m.id} onClick={() => call('treasury.printVoucher', m.id).catch(toast.error)}>
              {m.kind === 'FLOAT' ? 'Bon de remise de fond' : 'Bon de versement'} {m.number}
            </button>
          ))}
          {ej?.exits
            .filter((r) => r.closing)
            .slice(0, 1)
            .map((r) => (
              <button key={r.id} onClick={() => call('emoney.print', r.id).catch(toast.error)}>
                Bon de versement {r.number}
              </button>
            ))}
        </div>
      </div>
      {ej ? (
        <>
          <div className="seg">
            <button className={eview === 'journal' ? 'active' : ''} onClick={() => setEview('journal')}>
              Entrées et sorties du compte
            </button>
            <button className={eview === 'z' ? 'active' : ''} onClick={() => setEview('z')}>
              Vue détaillée (Z)
            </button>
          </div>
          {eview === 'journal' && (
            <div className="tre-panes">
              <CashPane title="Entrées" direction="IN" desk={desk} rows={ejRows(ej.entries)} party="Tiers" total={sum(ejRows(ej.entries))} />
              <CashPane title="Sorties" direction="OUT" desk={desk} rows={ejRows(ej.exits)} party="Bénéficiaire" total={sum(ejRows(ej.exits))} />
            </div>
          )}
          {eview === 'journal' && <Totals open={totals} onToggle={() => setTotals(!totals)} entries={ejRows(ej.entries)} exits={ejRows(ej.exits)} />}
          {eview === 'z' && <ZView z={z} />}
          {eview === 'journal' && <ZView z={z} compact />}
        </>
      ) : declared ? (
        <ZView z={z} />
      ) : (
        <>
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
              <CashPane title="Entrées de caisse" direction="IN" desk={desk} rows={cash.entries} party="Tiers" total={sum(cash.entries)} />
              <CashPane title="Sorties de caisse" direction="OUT" desk={desk} rows={cash.exits} party="Bénéficiaire" total={sum(cash.exits)} />
            </div>
          )}
          {view === 'cash' && <Totals open={totals} onToggle={() => setTotals(!totals)} entries={cash.entries} exits={cash.exits} />}
          {view === 'sales' && <SalesList sales={sales} />}
          {view === 'z' && <ZView z={z} />}
        </>
      )}
      {!declared && (
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
      )}
      {gapPending(se, threshold) && (
        <p className="danger-text tre-gap">
          Écart à justifier : {fcfa(se.difference ?? 0)} à la clôture de {se.closed_by_name ?? se.user_name}.
          {canJustify && (
            <button className="danger" onClick={() => setJustifying(true)}>
              Justifier l'écart…
            </button>
          )}
        </p>
      )}
      {se.gap_reason && (
        <p className="muted">
          Motif de l'écart : {se.gap_reason}
          {se.gap_approved_by_name && ` · justifié par ${se.gap_approved_by_name}${se.gap_justified_at ? ` le ${dateTime(se.gap_justified_at)}` : ''}`}
          {canJustify && (
            <button className="link" onClick={() => setJustifying(true)}>
              Modifier
            </button>
          )}
        </p>
      )}
      {justifying && (
        <JustifyGapDialog
          session={se}
          difference={z.difference ?? 0}
          onClose={() => setJustifying(false)}
          onDone={() => {
            setJustifying(false);
            onJustified();
          }}
        />
      )}
      {se.first_counted !== null && se.counted_cash !== null && se.first_counted !== se.counted_cash && (
        <p className="warn-text">Premier comptage : {fcfa(se.first_counted)} (recompté ensuite).</p>
      )}
    </div>
  );
}

function Totals({ open, onToggle, entries, exits }: { open: boolean; onToggle: () => void; entries: DeskRow[]; exits: DeskRow[] }) {
  return (
    <div className="desk-totals-box">
      <button className="link" onClick={onToggle}>
        {open ? '▾' : '▸'} Totaux par nature d'entrée / sortie
      </button>
      {open && <NatureTotals entries={entries} exits={exits} />}
    </div>
  );
}

/** Volet des entrées ou des sorties : un clic choisit la ligne, « Action » agit dessus. */
function CashPane({ title, rows, party, total, direction, desk }: { title: string; rows: CashRow[]; party: string; total: number; direction: 'IN' | 'OUT'; desk: DeskProps | null }) {
  const [picked, setPicked] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const row = rows.find((r) => `${r.source}-${r.id}` === picked) ?? null;
  return (
    <section className="tre-pane">
      <h3 className="desk-title">
        {title}
        {desk && (
          <span className="desk-buttons">
            <button className="primary" disabled={!desk.open} title={desk.open ? undefined : 'La journée est clôturée'} onClick={() => setAdding(true)}>
              {direction === 'IN' ? 'Encaisser' : 'Décaisser'}
            </button>
            <DeskActions direction={direction} row={row} desk={desk} />
          </span>
        )}
      </h3>
      {adding && desk && direction === 'IN' && (
        <CashInDialog
          sessionId={desk.sessionId}
          onClose={() => setAdding(false)}
          onDone={() => {
            setAdding(false);
            desk.onChanged();
          }}
        />
      )}
      {adding && desk && direction === 'OUT' && (
        <CashOutDialog
          sessionId={desk.sessionId}
          onClose={() => setAdding(false)}
          onDone={() => {
            setAdding(false);
            desk.onChanged();
          }}
        />
      )}
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
            {rows.map((r) => (
              <tr
                key={`${r.source}-${r.id}`}
                className={`${r.closing ? 'muted' : ''} ${desk ? 'clickable' : ''} ${picked === `${r.source}-${r.id}` ? 'selected' : ''}`}
                title={r.user_name ?? ''}
                onClick={() => desk && setPicked(`${r.source}-${r.id}`)}
              >
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

/** Le gérant a interpellé le caissier : il saisit le motif de l'écart. */
function JustifyGapDialog({ session, difference, onClose, onDone }: { session: Journey['z']['session']; difference: number; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [reason, setReason] = useState(session.gap_reason ?? '');
  return (
    <Modal title="Justifier l'écart de caisse" onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await call('treasury.justifyGap', session.id, reason);
            toast.ok('Écart justifié');
            onDone();
          } catch (err) {
            toast.error(err);
          }
        }}
      >
        <div className="kpis">
          <div>
            <small>Attendu</small>
            <strong>{fcfa(session.expected_cash ?? 0)}</strong>
          </div>
          <div>
            <small>Relevé</small>
            <strong>{fcfa(session.counted_cash ?? 0)}</strong>
          </div>
          <div className={difference < 0 ? 'neg' : 'pos'}>
            <small>Écart</small>
            <strong>{fcfa(difference)}</strong>
          </div>
        </div>
        <p className="muted">
          Clôture du {session.closed_at ? dateTime(session.closed_at) : ''} par {session.closed_by_name ?? session.user_name}.
        </p>
        <Field label="Motif de l'écart">
          <input autoFocus value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Erreur de monnaie, billet manquant, vente non saisie…" />
        </Field>
        <div className="actions">
          <button type="button" onClick={onClose}>
            Annuler
          </button>
          <button type="submit" className="primary" disabled={!reason.trim()}>
            Enregistrer le motif
          </button>
        </div>
      </form>
    </Modal>
  );
}

function History({ sessions, threshold, onOpen }: { sessions: Result<'treasury.sessions'>; threshold: number; onOpen: (id: string) => void }) {
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
            <td className={`r ${x.difference ? (x.difference < 0 ? 'neg' : 'pos') : ''}`}>
              {x.difference === null ? '' : fcfa(x.difference)}
              {gapPending(x, threshold) && <span className="tag rupture">Écart à justifier</span>}
              {x.gap_reason && Math.abs(x.difference ?? 0) > threshold && <span className="tag normal" title={x.gap_reason}>Justifié</span>}
            </td>
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
  // Le caissier ouvre seul ; seul un complément pris dans la caisse centrale demande le gérant.
  const needsPin = !canOpen && delta > 0;
  return (
    <Modal title={`Ouvrir ${register.name}`} onClose={onClose} wide={Boolean(count)}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (value === null) return toast.error('Montant invalide');
          try {
            const opened = await call('treasury.open', value, needsPin ? pin : undefined, register.id);
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
        {needsPin && (
          <Field label="Code du gérant" hint="Le complément de fond pris dans la caisse centrale est validé par le gérant">
            <input type="password" inputMode="numeric" value={pin} onChange={(e) => setPin(e.target.value)} />
          </Field>
        )}
        {needsPin && <PhoneApproval action={`Compléter le fond de ${register.name} de ${fcfa(delta)} pris dans la caisse centrale`} onCode={setPin} />}
        <div className="actions">
          {value !== null && <span className="big-total">{fcfa(value)}</span>}
          <button type="submit" className="primary" disabled={value === null || (needsPin && !pin)}>
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
  const canZ = useCan()('cash_z');
  const [count, setCount] = useState<Record<number, number>>({});
  const [preview, setPreview] = useState<Result<'treasury.countPreview'> | null>(null);
  const [floatText, setFloatText] = useState('');
  const [reason, setReason] = useState('');
  const [done, setDone] = useState<Result<'treasury.close'> | null>(null);
  const counted = countedTotal(count);
  const floatLeft = parseAmount(floatText || '0');
  const deposit = preview && floatLeft !== null ? preview.counted - floatLeft : null;

  if (done) {
    const deposits = done.session.deposit ?? 0;
    return (
      <Modal title={`Caisse fermée · Z n° ${done.session.z_number}`} onClose={() => onDone(done.session.id)} wide>
        <div className="aigle-bulle">
          <Mascot mood="dort" size={70} branch={false} />
          <div>Caisse fermée. Bon repos, à demain !</div>
        </div>
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
          <BeforeClose registerId={session.register_id ?? undefined} />
          <div className="aigle-bulle">
            <Mascot mood="compte" size={70} branch={false} />
            <div>Comptez les espèces du tiroir par coupure. L'attendu s'affiche après le comptage.</div>
          </div>
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
              const z = await call('treasury.close', count, { floatLeft, gapReason: reason, registerId: session.register_id });
              setDone(z);
              if (canZ) call('pos.printZ', z.session.id).catch(toast.error);
              const dep = (await call('treasury.session', z.session.id)).movements.find((m) => m.kind === 'DEPOSIT' && !m.cash_operation_id);
              if (dep) call('treasury.printVoucher', dep.id).catch(toast.error);
            } catch (err) {
              toast.error(err);
            }
          }}
        >
          <div className="aigle-bulle">
            <Mascot mood={preview.difference === 0 ? 'bravo' : 'alerte'} size={70} branch={false} />
            <div>
              {preview.difference === 0
                ? 'Caisse juste : le comptage tombe pile sur l’attendu.'
                : `${preview.difference < 0 ? 'Il manque' : 'Il y a en trop'} ${fcfa(Math.abs(preview.difference))} : recomptez avant de clôturer.`}
            </div>
          </div>
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
              {canApprove ? (
                <Field label="Motif de l'écart (facultatif)" hint={`Écart supérieur à ${fcfa(preview.threshold)}. Sans motif, la journée reste « écart à justifier ».`}>
                  <input autoFocus value={reason} onChange={(e) => setReason(e.target.value)} />
                </Field>
              ) : (
                <p className="danger-text">Écart supérieur à {fcfa(preview.threshold)} : le gérant le justifiera depuis son compte.</p>
              )}
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
              disabled={deposit === null || deposit < 0}
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
  const [dialog, setDialog] = useState<'open' | 'close' | 'handover' | null>(null);
  const reload = () => {
    state.reload();
    day.reload();
    onChanged?.();
  };
  const linked = state.data ? <LinkedRegisters linked={state.data.linked} canApprove={state.data.canOpen} threshold={state.data.gapThreshold} onChanged={reload} /> : null;

  if (!state.data) return null;
  const register = state.data.registers.find((r) => r.isThisStation);
  const open = register?.session ?? null;
  const d = day.data && day.data.session.register_id === register?.id ? day.data : null;
  const exits = d?.exits ?? [];
  const entries = d?.entries ?? [];
  const desk: DeskProps | null = d && user.rights.includes('cash_desk') ? { sessionId: d.session.id, open: d.session.status === 'open', onChanged: reload } : null;
  const emoneyExits: CashRow[] = (d?.emoneyExits ?? []).map((r) => ({
    source: r.source,
    id: r.id,
    at: r.at,
    amount: r.amount,
    nature: r.nature,
    label: `${r.label} · ${r.method_label}${r.reference ? ` ${r.reference}` : ''}`,
    party: r.party,
    user_name: r.user_name,
    user_id: r.user_id,
  }));

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
              <>
                <button onClick={() => setDialog('handover')}>Relève d'équipe…</button>
                <button className="danger" onClick={() => setDialog('close')}>
                  Fermer la caisse…
                </button>
              </>
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
              <div className="tre-panes">
                <CashPane title="Mes encaissements" direction="IN" desk={desk} rows={entries} party="Tiers" total={entries.reduce((t, r) => t + r.amount, 0)} />
                <CashPane title="Mes sorties de caisse" direction="OUT" desk={desk} rows={exits} party="Bénéficiaire" total={exits.reduce((t, r) => t + r.amount, 0)} />
                {emoneyExits.length > 0 && (
                  <CashPane title="Mes sorties MoMo / OM" direction="OUT" desk={null} rows={emoneyExits} party="Bénéficiaire" total={emoneyExits.reduce((t, r) => t + r.amount, 0)} />
                )}
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
            <Empty action={!open ? { label: 'Ouvrir la caisse…', onClick: () => setDialog('open') } : undefined}>
              Aucune journée pour votre caisse. Ouvrez la caisse pour commencer la journée : le fond laissé la veille est proposé.
            </Empty>
          )}
          {linked}
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
      {dialog === 'handover' && open && (
        <HandoverDialog
          session={open}
          user={user}
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
 * verse le reste. La caisse se ferme sur son comptage, sans code du gérant ;
 * le gérant justifie ensuite un éventuel écart depuis son compte. Seul le bon de versement s'imprime.
 */
function BlindCloseDialog({ session, user, onClose, onDone }: { session: NonNullable<RegisterRow['session']>; user: User; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [count, setCount] = useState<Record<number, number>>({});
  const [checked, setChecked] = useState<Result<'treasury.blindCount'> | null>(null);
  const [floatText, setFloatText] = useState('');
  const [done, setDone] = useState<Result<'treasury.closeBlind'> | null>(null);
  const counted = countedTotal(count);
  const floatLeft = parseAmount(floatText || '0');
  const deposit = checked && floatLeft !== null ? checked.counted - floatLeft : null;

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

  return (
    <Modal title="Fermer la caisse" onClose={onClose} wide>
      {!checked ? (
        <>
          <BeforeClose registerId={session.register_id ?? undefined} />
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
      ) : (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (floatLeft === null) return toast.error('Fond invalide');
            try {
              const r = await call('treasury.closeBlind', count, { floatLeft, registerId: session.register_id });
              setDone(r);
              if (r.voucherId) call('treasury.printVoucher', r.voucherId).catch(toast.error);
            } catch (err) {
              toast.error(err);
            }
          }}
        >
          <p>
            Espèces comptées : <b>{fcfa(checked.counted)}</b>
          </p>
          <div className="grid2">
            <Field label="Fond laissé dans le tiroir pour demain" hint={`Fond de ce matin : ${fcfa(session.opening_float)}`}>
              <input autoFocus inputMode="numeric" value={floatText} onChange={(e) => setFloatText(e.target.value)} />
            </Field>
            <Field label="Versé à la caisse centrale">
              <input readOnly className="r" value={deposit === null || deposit < 0 ? '—' : fcfa(deposit)} />
            </Field>
          </div>
          <div className="actions">
            <button type="button" className="ghost" onClick={() => setChecked(null)}>
              Recompter
            </button>
            <button type="submit" className="danger" disabled={deposit === null || deposit < 0}>
              Clôturer et verser
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}

/**
 * Relève d'équipe : le caissier qui part compte le tiroir sans voir l'attendu,
 * celui qui arrive se connecte, et le bon de passation s'imprime avec l'écart.
 * La journée continue : même fond, même Z, qui détaillera chaque caissier.
 */
function HandoverDialog({ session, user, onClose, onDone }: { session: NonNullable<RegisterRow['session']>; user: User; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [count, setCount] = useState<Record<number, number>>({});
  const [step, setStep] = useState<'count' | 'next'>('count');
  const [login, setLogin] = useState('');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<Result<'treasury.handover'> | null>(null);
  const counted = countedTotal(count);

  if (done) {
    return (
      <Modal title="Relève faite" onClose={onDone}>
        <p>
          Merci {done.from}. Bienvenue {done.to} : la caisse est à votre nom, la journée continue.
        </p>
        <p className="muted">Le bon de passation n° {done.number} est imprimé : signez-le tous les deux.</p>
        <div className="actions">
          <button onClick={() => call('treasury.printHandover', done.id).catch(toast.error)}>Réimprimer le bon</button>
          <button className="primary" onClick={onDone}>
            Terminer
          </button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="Relève d'équipe" onClose={onClose} wide>
      {step === 'count' ? (
        <>
          <p>{user.name}, comptez les espèces du tiroir par coupure avant de passer la main. La caisse reste ouverte.</p>
          <Denominations count={count} onChange={setCount} />
          <div className="actions">
            <span className="big-total">{fcfa(counted)}</span>
            <button className="primary" onClick={() => setStep('next')}>
              Valider le comptage
            </button>
          </div>
        </>
      ) : (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            try {
              setDone(await call('treasury.handover', count, login.trim(), pin, session.register_id));
            } catch (err) {
              toast.error(err);
            } finally {
              setBusy(false);
            }
          }}
        >
          <p>
            Espèces comptées : <b>{fcfa(counted)}</b>. Le caissier qui arrive se connecte :
          </p>
          <div className="grid2">
            <Field label="Identifiant (ou badge)">
              <input
                autoFocus
                value={login}
                onChange={(e) => setLogin(e.target.value)}
                onKeyDown={async (e) => {
                  if (e.key !== 'Enter' || !/^FX\d{8}$/i.test(login.trim())) return;
                  e.preventDefault();
                  const found = await call('auth.badge', login.trim()).catch(() => null);
                  if (found) setLogin(found);
                  (e.currentTarget.form?.elements.namedItem('pin') as HTMLInputElement | null)?.focus();
                }}
              />
            </Field>
            <Field label="Code">
              <input name="pin" type="password" inputMode="numeric" value={pin} onChange={(e) => setPin(e.target.value)} />
            </Field>
          </div>
          <div className="actions">
            <button type="button" className="ghost" onClick={() => setStep('count')}>
              Recompter
            </button>
            <button type="submit" className="primary" disabled={busy || !login.trim() || !pin}>
              Passer la main
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

/**
 * Caisses électronique et banque du caissier : elles s'ouvrent avec sa caisse
 * espèces. À la clôture, il saisit le montant relevé sur chaque téléphone,
 * terminal ou relevé, sans voir l'attendu.
 */
function LinkedRegisters({ linked, canApprove, threshold, onChanged }: { linked: LinkedRow[]; canApprove: boolean; threshold: number; onChanged: () => void }) {
  const toast = useToast();
  const [closing, setClosing] = useState<LinkedRow | null>(null);
  if (!linked.length) return null;
  return (
    <section className="tre-linked">
      <h3>Mes autres caisses</h3>
      <table className="list compact">
        <tbody>
          {linked.map((r) => (
            <tr key={r.id}>
              <td>
                <strong>{r.name}</strong>
                <span className={`tag kind-${r.kind}`}>{KIND_LABEL[r.kind]}</span>
              </td>
              <td className="muted">{KIND_METHODS[r.kind as Exclude<RegisterKind, 'cash'>]?.map((m) => PAYMENT_METHODS[m]).join(', ')}</td>
              <td className={`tre-state ${r.session ? 'open' : 'closed'}`}>{r.session ? (r.stale ? 'Ouverte (journée non clôturée)' : 'Ouverte.') : 'Fermée.'}</td>
              <td className="r">
                {r.session ? (
                  <button className="danger" onClick={() => setClosing(r)}>
                    Clôturer…
                  </button>
                ) : (
                  <button onClick={() => call('treasury.openLinked').then(onChanged, toast.error)}>Ouvrir</button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {closing?.session && (
        <DeclaredCloseDialog
          register={closing}
          session={closing.session}
          blind
          canApprove={canApprove}
          threshold={threshold}
          onClose={() => setClosing(null)}
          onDone={() => {
            setClosing(null);
            onChanged();
          }}
        />
      )}
    </section>
  );
}

/**
 * Clôture d'une caisse électronique ou banque : un montant relevé par moyen
 * (téléphone MTN, téléphone Orange, terminal de carte ; relevé de virements,
 * chèques reçus). Avec le droit des montants, l'encaissé et l'écart s'affichent ;
 * le gérant donne le motif d'un écart au-delà du seuil. Le bon de clôture s'imprime ensuite.
 */
function DeclaredCloseDialog({
  register,
  session,
  blind,
  canApprove,
  threshold,
  onClose,
  onDone,
}: {
  register: { id: string; name: string; kind: RegisterKind };
  session: { id: string };
  blind: boolean;
  canApprove: boolean;
  threshold: number;
  onClose: () => void;
  onDone: (sessionId: string) => void;
}) {
  const toast = useToast();
  const methods = KIND_METHODS[register.kind as Exclude<RegisterKind, 'cash'>] ?? [];
  const electronic = register.kind === 'electronic';
  const [values, setValues] = useState<Record<string, string>>({});
  const [deposits, setDeposits] = useState<Record<string, string>>({});
  const [refs, setRefs] = useState<Record<string, string>>({});
  const [reason, setReason] = useState('');
  const [done, setDone] = useState<Result<'treasury.closeDeclared'> | null>(null);
  const journey = useLoad(() => (blind ? Promise.resolve(null) : call('treasury.session', session.id)), [session.id, blind]);
  // Caisse électronique : sorties faites par le compte, solde de départ et centrale où verser.
  const day = useLoad(() => (electronic ? call('treasury.emoneyDay', register.id) : Promise.resolve(null)), [register.id, electronic]);
  const lineOf = (m: PaymentMethod) => journey.data?.z.declared?.find((l) => l.method === m);
  const expectedOf = (m: PaymentMethod) => lineOf(m)?.expected ?? 0;
  const declared = Object.fromEntries(methods.map((m) => [m, parseAmount(values[m] ?? '') ?? 0])) as Record<PaymentMethod, number>;
  const filled = methods.every((m) => (values[m] ?? '').trim() !== '' && parseAmount(values[m]!) !== null);
  const gap = methods.reduce((t, m) => t + declared[m] - expectedOf(m), 0);
  const needsReason = !blind && canApprove && filled && Math.abs(gap) > threshold;
  const canDeposit = Boolean(day.data?.canDeposit);
  const depositable = (m: PaymentMethod) => canDeposit && m !== 'CARD';
  // Versé : tout le solde relevé par défaut ; le caissier peut garder un reste.
  const depositOf = (m: PaymentMethod) => (!depositable(m) ? 0 : (deposits[m] ?? '').trim() === '' ? declared[m] : (parseAmount(deposits[m]!) ?? 0));
  const missingRef = methods.some((m) => depositable(m) && depositOf(m) > 0 && !(refs[m] ?? '').trim());
  const overDeposit = methods.some((m) => depositOf(m) > declared[m]);
  const exits = day.data?.exits ?? [];
  const showOpening = !blind && electronic && methods.some((m) => (lineOf(m)?.opening ?? 0) !== 0);
  const hint = (m: PaymentMethod) =>
    m === 'CARD'
      ? 'Total du jour sur le terminal de paiement'
      : m === 'BANK_TRANSFER'
        ? 'Virements reçus, d’après le relevé'
        : m === 'CHEQUE'
          ? 'Total des chèques reçus'
          : 'Solde du compte, lu sur le téléphone';

  if (done) {
    return (
      <Modal title={`${register.name} clôturée`} onClose={() => onDone(done.sessionId)} wide={Boolean(done.z)}>
        {done.z ? <ZView z={done.z} /> : <p>{done.needsApproval ? 'Clôture enregistrée. Le gérant justifiera l’écart constaté.' : 'Clôture enregistrée.'}</p>}
        <div className="actions">
          <button onClick={() => call('treasury.printReport', done.sessionId).catch(toast.error)}>Imprimer le bon de clôture</button>
          {done.depositId && <button onClick={() => call('emoney.print', done.depositId!).catch(toast.error)}>Imprimer le bon de versement</button>}
          <button className="primary" onClick={() => onDone(done.sessionId)}>
            Terminer
          </button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title={`Clôturer ${register.name}`} onClose={onClose} wide={!blind || canDeposit || exits.length > 0}>
      <p className="muted">
        Saisissez pour chaque moyen le montant relevé, puis validez. {blind ? '' : electronic ? 'L’attendu tient compte du solde de départ et des sorties du compte.' : 'L’écart se calcule avec l’encaissé de la journée.'}
      </p>
      {electronic && (
        <section className="tre-myexits">
          <h4>Mes sorties par ce compte aujourd’hui</h4>
          {exits.length ? (
            <table className="list compact">
              <tbody>
                {exits.map((e) => (
                  <tr key={`${e.source}-${e.id}`}>
                    <td>{time(e.at)}</td>
                    <td>{e.nature}</td>
                    <td>{e.label}</td>
                    <td>{e.party ?? ''}</td>
                    <td>
                      {e.method_label}
                      {e.reference ? ` · ${e.reference}` : ''}
                    </td>
                    <td className="r">{fcfa(e.amount)}</td>
                  </tr>
                ))}
                <tr className="total">
                  <td colSpan={5}>Total des sorties</td>
                  <td className="r">{fcfa(exits.reduce((t, e) => t + e.amount, 0))}</td>
                </tr>
              </tbody>
            </table>
          ) : (
            <p className="muted">Aucune dépense, aucun remboursement ni règlement payé par ce compte.</p>
          )}
        </section>
      )}
      <table className="list declared-form">
        <thead>
          <tr>
            <th>Moyen</th>
            {showOpening && <th className="r">Solde de départ</th>}
            {!blind && <th className="r">{electronic ? 'Attendu' : 'Encaissé'}</th>}
            <th className="r">Montant relevé</th>
            {!blind && <th className="r">Écart</th>}
            {canDeposit && <th className="r">Versé à {day.data?.centralName}</th>}
            {canDeposit && <th>Référence du transfert</th>}
            {canDeposit && <th className="r">Reste</th>}
          </tr>
        </thead>
        <tbody>
          {methods.map((m, i) => {
            const v = (values[m] ?? '').trim() === '' ? null : parseAmount(values[m]!);
            const d = v === null ? null : v - expectedOf(m);
            return (
              <tr key={m}>
                <td>
                  {PAYMENT_METHODS[m]}
                  <br />
                  <small className="muted">{hint(m)}</small>
                </td>
                {showOpening && <td className="r">{fcfa(lineOf(m)?.opening ?? 0)}</td>}
                {!blind && <td className="r">{fcfa(expectedOf(m))}</td>}
                <td className="r">
                  <input autoFocus={i === 0} inputMode="numeric" value={values[m] ?? ''} onChange={(e) => setValues({ ...values, [m]: e.target.value })} />
                </td>
                {!blind && <td className={`r ${d ? (d < 0 ? 'neg' : 'pos') : ''}`}>{d === null ? '—' : fcfa(d)}</td>}
                {canDeposit &&
                  (depositable(m) ? (
                    <>
                      <td className="r">
                        <input inputMode="numeric" placeholder={v === null ? '' : String(v)} value={deposits[m] ?? ''} onChange={(e) => setDeposits({ ...deposits, [m]: e.target.value })} />
                      </td>
                      <td>
                        <input
                          className={depositOf(m) > 0 && !(refs[m] ?? '').trim() ? 'required' : ''}
                          placeholder={depositOf(m) > 0 ? 'Obligatoire' : ''}
                          value={refs[m] ?? ''}
                          onChange={(e) => setRefs({ ...refs, [m]: e.target.value })}
                        />
                      </td>
                      <td className={`r ${declared[m] - depositOf(m) < 0 ? 'neg' : ''}`}>{v === null ? '—' : fcfa(declared[m] - depositOf(m))}</td>
                    </>
                  ) : (
                    <td colSpan={3} className="muted">
                      Va à la banque
                    </td>
                  ))}
              </tr>
            );
          })}
        </tbody>
      </table>
      {canDeposit && <p className="muted">Transférez votre recette vers {day.data?.centralName} et notez la référence de chaque transfert. Ce que vous ne versez pas reste sur votre compte pour demain.</p>}
      {electronic && day.data?.mode === 'independent' && <p className="muted">Caisses indépendantes : le solde relevé reste sur le compte et sert de départ demain.</p>}
      {!blind && filled && (
        <p className={Math.abs(gap) > threshold ? 'danger-text' : 'muted'}>
          Écart total : {fcfa(gap)}
          {Math.abs(gap) > threshold && !canApprove ? ' : le gérant le justifiera.' : ''}
        </p>
      )}
      {overDeposit && <p className="danger-text">Le versement dépasse le montant relevé.</p>}
      {needsReason && (
        <Field label="Motif de l'écart">
          <textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
      )}
      <div className="actions">
        <button onClick={onClose}>Annuler</button>
        <button
          className="danger"
          disabled={!filled || (needsReason && !reason.trim()) || (filled && (missingRef || overDeposit))}
          onClick={async () => {
            try {
              const deposit = canDeposit
                ? Object.fromEntries(methods.filter((m) => depositOf(m) > 0).map((m) => [m, { amount: depositOf(m), reference: refs[m] ?? '' }]))
                : undefined;
              setDone(await call('treasury.closeDeclared', register.id, declared, { gapReason: needsReason ? reason : null, deposit }));
            } catch (e) {
              toast.error(e);
            }
          }}
        >
          {canDeposit ? 'Clôturer et verser' : 'Clôturer la caisse'}
        </button>
      </div>
    </Modal>
  );
}
