import { useState } from 'react';
import { type Result, call } from '../api';
import { Empty, Field, Modal, Tabs, askConfirm, askText, dateFr, dateTime, downloadText, fcfa, parseAmount, today, useCan, useLoad, useToast } from '../ui';

export type FiscalPrepTab = 'state' | 'adjustments' | 'statements' | 'journal';
type Statement = Result<'fiscalPrep.statement'>;
type Adjustment = Result<'fiscalPrep.adjustments'>[number];
type Kind = Adjustment['kind'];

const KIND_LABELS: Record<Kind, string> = { credit_note: 'Avoir', correction: 'Correction justifiée', reclass: 'Reclassement de catégorie' };
const STATUS_LABELS: Record<Adjustment['status'], string> = { pending: 'En attente', approved: 'Approuvé', rejected: 'Refusé', withdrawn: 'Retiré' };
const ACTION_LABELS: Record<string, string> = { propose: 'Proposé', approve: 'Approuvé', reject: 'Refusé', withdraw: 'Retiré', generate: 'État généré' };

const monthStart = (d: string) => `${d.slice(0, 8)}01`;
/** Mois précédent : celui qu'on déclare d'habitude. */
function lastMonth(): [string, string] {
  const d = new Date();
  const iso = (x: Date) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
  return [iso(new Date(d.getFullYear(), d.getMonth() - 1, 1)), iso(new Date(d.getFullYear(), d.getMonth(), 0))];
}
const effect = (a: Pick<Adjustment, 'effects'>) => a.effects.reduce((t, e) => ({ ttc: t.ttc + e.ttc, ht: t.ht + e.ht, tva: t.tva + e.tva }), { ttc: 0, ht: 0, tva: 0 });
const rateLabel = (bp: number) => `${(bp / 100).toLocaleString('fr-FR')} %`;

/**
 * Préparation fiscale : état comptable et fiscal tiré des ventes réelles. Le chiffre
 * déclaré est toujours le chiffre réel plus les avoirs et corrections approuvés, chacun
 * rattaché à une vente réelle et tracé ; ce module ne modifie jamais les ventes.
 */
export function FiscalPrep({ user, initialTab = 'state' }: { user: { id: string }; initialTab?: FiscalPrepTab }) {
  const [tab, setTab] = useState<FiscalPrepTab>(initialTab);
  return (
    <div className="page">
      <header className="page-head">
        <h1>Préparation fiscale</h1>
      </header>
      <p className="muted">
        État dérivé des ventes réelles, sans les modifier. Seuls les avoirs et les corrections justifiés, rattachés à une vente réelle et approuvés par un autre utilisateur, peuvent
        faire différer le chiffre déclaré du chiffre réel ; chaque écart figure dans le rapprochement.
      </p>
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          ['state', 'État fiscal'],
          ['adjustments', 'Avoirs et corrections'],
          ['statements', 'États générés'],
          ['journal', 'Journal et contrôle'],
        ]}
      />
      {tab === 'state' && <StateTab />}
      {tab === 'adjustments' && <AdjustmentsTab userId={user.id} />}
      {tab === 'statements' && <StatementsTab />}
      {tab === 'journal' && <JournalTab />}
    </div>
  );
}

function StateTab() {
  const toast = useToast();
  const [[from, to], setPeriod] = useState<[string, string]>(lastMonth);
  const [tick, setTick] = useState(0);
  const valid = Boolean(from && to && from <= to);
  const st = useLoad(() => (valid ? call('fiscalPrep.statement', from, to) : Promise.resolve(undefined)), [from, to, tick]).data;
  const generate = async () => {
    if (!(await askConfirm(`Générer l’état fiscal du ${dateFr(from)} au ${dateFr(to)} ? Il sera figé tel quel, avec son empreinte, et ne se modifiera plus.`))) return;
    try {
      const g = await call('fiscalPrep.generate', from, to);
      toast.ok(`État ${g.number} généré`);
      setTick((t) => t + 1);
    } catch (e) {
      toast.error(e);
    }
  };
  return (
    <>
      <div className="filters">
        <label className="inline">
          Du <input type="date" value={from} onChange={(e) => setPeriod([e.target.value, to])} />
        </label>
        <label className="inline">
          au <input type="date" value={to} onChange={(e) => setPeriod([from, e.target.value])} />
        </label>
        <button onClick={() => setPeriod(lastMonth())}>Mois dernier</button>
        <button onClick={() => setPeriod([monthStart(today()), today()])}>Ce mois-ci</button>
      </div>
      {!valid ? <p className="muted">Choisissez une période valide.</p> : st ? <StatementView st={st} /> : null}
      {st && (
        <div className="actions">
          <button className="primary" onClick={generate} disabled={!st.reconciliation.balanced}>
            Générer l’état (figé)
          </button>
          <button
            onClick={async () => {
              try {
                downloadText(`preparation-fiscale_${from}_${to}.csv`, await call('fiscalPrep.exportCsv', from, to));
              } catch (e) {
                toast.error(e);
              }
            }}
          >
            Exporter (CSV)
          </button>
        </div>
      )}
    </>
  );
}

/** Un état fiscal : catégories, rapprochement, ajustements pris en compte et obligations. */
function StatementView({ st }: { st: Statement }) {
  const vat = st.store.vatEnabled;
  return (
    <>
      <table className="list compact">
        <thead>
          <tr>
            <th>Catégorie fiscale</th>
            <th className="r">Ventes réelles HT</th>
            <th className="r">Ajustements HT</th>
            <th className="r">Déclaré HT</th>
            {vat && <th className="r">TVA déclarée</th>}
            <th className="r">Déclaré TTC</th>
          </tr>
        </thead>
        <tbody>
          {st.categories.map((c) => (
            <tr key={c.rate}>
              <td>{c.label}</td>
              <td className="r">{fcfa(c.real.ht)}</td>
              <td className="r">{c.adjustments.ht ? fcfa(c.adjustments.ht) : ''}</td>
              <td className="r">{fcfa(c.declared.ht)}</td>
              {vat && <td className="r">{fcfa(c.declared.tva)}</td>}
              <td className="r">{fcfa(c.declared.ttc)}</td>
            </tr>
          ))}
          <tr>
            <td>
              <b>Total</b>
            </td>
            <td className="r">
              <b>{fcfa(st.real.ht)}</b>
            </td>
            <td className="r">{st.adjustments.ht ? fcfa(st.adjustments.ht) : ''}</td>
            <td className="r">
              <b>{fcfa(st.declared.ht)}</b>
            </td>
            {vat && <td className="r">{fcfa(st.declared.tva)}</td>}
            <td className="r">{fcfa(st.declared.ttc)}</td>
          </tr>
        </tbody>
      </table>
      <h3>Rapprochement avec les ventes réelles</h3>
      <p>
        Chiffre d’affaires réel HT {fcfa(st.reconciliation.realHt)} + ajustements approuvés {fcfa(st.reconciliation.adjustmentsHt)} = chiffre déclaré HT{' '}
        <b>{fcfa(st.reconciliation.declaredHt)}</b>.{' '}
        {st.reconciliation.balanced ? <span className="ok">Écart non justifié : 0.</span> : <span className="warn">Écart non justifié : {fcfa(st.reconciliation.unexplained)}</span>}
      </p>
      <p className="muted">
        {st.real.sales} ventes, {st.real.returns} remboursements ; {st.real.cancelled} annulations hors chiffre d’affaires ({fcfa(st.real.cancelledTtc)}).
        {st.sourceCheck.ok ? '' : ` Attention : les totaux des tickets (${fcfa(st.sourceCheck.headersTtc)}) ne correspondent pas à leurs lignes (${fcfa(st.sourceCheck.linesTtc)}).`}
      </p>
      {st.applied.length === 0 ? (
        <p className="muted">Aucun avoir ni correction approuvé sur la période : le chiffre déclaré est le chiffre réel.</p>
      ) : (
        <table className="list compact">
          <thead>
            <tr>
              <th>N°</th>
              <th>Type</th>
              <th>Vente</th>
              <th className="r">Effet HT</th>
              <th>Motif</th>
              <th>Pièce</th>
              <th>Proposé par</th>
              <th>Approuvé par</th>
            </tr>
          </thead>
          <tbody>
            {st.applied.map((a) => (
              <tr key={a.id}>
                <td>{a.number}</td>
                <td>{KIND_LABELS[a.kind]}</td>
                <td>{a.sale_number}</td>
                <td className="r">{fcfa(effect(a).ht)}</td>
                <td>{a.reason}</td>
                <td>{a.reference}</td>
                <td>{a.created_by_name}</td>
                <td>
                  {a.decided_by_name} · {a.decided_at ? dateTime(a.decided_at) : ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {st.pending.length > 0 && <p className="warn-text">{st.pending.length} ajustements en attente d’approbation ne sont pas pris en compte.</p>}
      <h3>Montants à reporter</h3>
      <ul>
        {vat && <li>TVA collectée : {fcfa(st.obligations.vatCollected)}</li>}
        <li>
          Acompte d’impôt (minimum de perception {rateLabel(st.obligations.instalment.rate)}, régime {st.regime === 'reel' ? 'réel' : 'simplifié'}) : {fcfa(st.obligations.instalment.principal)} +
          CAC {fcfa(st.obligations.instalment.cac)} = <b>{fcfa(st.obligations.instalment.total)}</b>
        </li>
      </ul>
    </>
  );
}

function AdjustmentsTab({ userId }: { userId: string }) {
  const can = useCan();
  const [status, setStatus] = useState<Adjustment['status'] | ''>('pending');
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const list = useLoad(() => call('fiscalPrep.adjustments', { status: status || null }), [status, tick]).data ?? [];
  return (
    <>
      <div className="filters">
        <select value={status} onChange={(e) => setStatus(e.target.value as Adjustment['status'] | '')}>
          <option value="pending">En attente d’approbation</option>
          <option value="approved">Approuvés</option>
          <option value="rejected">Refusés</option>
          <option value="withdrawn">Retirés</option>
          <option value="">Tous</option>
        </select>
        {can('fiscal_adjust') && (
          <button className="primary" onClick={() => setCreating(true)}>
            Nouvel avoir ou correction
          </button>
        )}
      </div>
      {list.length === 0 ? (
        <Empty>Aucun ajustement. Un avoir ou une correction se fait sur une vente réelle, avec un motif et une pièce justificative, puis un autre utilisateur l’approuve.</Empty>
      ) : (
        <table className="list compact">
          <thead>
            <tr>
              <th>N°</th>
              <th>Date</th>
              <th>Type</th>
              <th>Vente</th>
              <th className="r">Effet TTC</th>
              <th>Motif</th>
              <th>Proposé par</th>
              <th>État</th>
            </tr>
          </thead>
          <tbody>
            {list.map((a) => (
              <tr key={a.id} className="clickable" onClick={() => setOpen(a.id)}>
                <td>{a.number}</td>
                <td>{dateTime(a.created_at)}</td>
                <td>{KIND_LABELS[a.kind]}</td>
                <td>{a.sale_number}</td>
                <td className="r">{fcfa(effect(a).ttc)}</td>
                <td>{a.reason}</td>
                <td>{a.created_by_name}</td>
                <td>{STATUS_LABELS[a.status]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {creating && (
        <NewAdjustment
          onClose={() => setCreating(false)}
          onDone={(id) => {
            setCreating(false);
            setTick((t) => t + 1);
            setOpen(id);
          }}
        />
      )}
      {open && <AdjustmentDetail id={open} userId={userId} onClose={() => setOpen(null)} onChanged={() => setTick((t) => t + 1)} />}
    </>
  );
}

function NewAdjustment({ onClose, onDone }: { onClose: () => void; onDone: (id: string) => void }) {
  const toast = useToast();
  const [saleNumber, setSaleNumber] = useState('');
  const [sale, setSale] = useState<Result<'fiscalPrep.saleSituation'> | null>(null);
  const [kind, setKind] = useState<Kind>('credit_note');
  const [rate, setRate] = useState<number | null>(null);
  const [toRate, setToRate] = useState<number | null>(null);
  const [sign, setSign] = useState<1 | -1>(-1);
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [reference, setReference] = useState('');
  const categories = useLoad(() => call('fiscalPrep.categories'), []).data ?? [];
  const find = async () => {
    try {
      const s = await call('fiscalPrep.saleSituation', { saleNumber });
      setSale(s);
      setRate(s.categories[0]?.rate ?? null);
    } catch (e) {
      setSale(null);
      toast.error(e);
    }
  };
  const value = parseAmount(amount);
  const submit = async () => {
    if (!sale || rate === null || !value) return;
    try {
      const a = await call('fiscalPrep.propose', {
        saleId: sale.sale_id,
        kind,
        vatRateBp: rate,
        toVatRateBp: kind === 'reclass' ? toRate : null,
        amountTtc: kind === 'correction' ? sign * value : value,
        reason,
        reference,
      });
      toast.ok(`Ajustement ${a.number} proposé : il attend l’approbation d’un autre utilisateur`);
      onDone(a.id);
    } catch (e) {
      toast.error(e);
    }
  };
  return (
    <Modal title="Nouvel avoir ou correction" onClose={onClose} wide>
      <p className="muted">L’ajustement se rattache à une vente réelle et ne la modifie pas. Il ne compte dans l’état fiscal qu’une fois approuvé par un autre utilisateur.</p>
      <div className="filters">
        <input placeholder="N° du ticket ou de la facture" value={saleNumber} onChange={(e) => setSaleNumber(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && find()} autoFocus />
        <button onClick={find}>Chercher la vente</button>
      </div>
      {sale && (
        <>
          <p>
            Vente <b>{sale.sale_number}</b> du {dateTime(sale.created_at)}
            {sale.customer_name ? ` · ${sale.customer_name}` : ''}
          </p>
          <table className="list compact">
            <thead>
              <tr>
                <th>Catégorie</th>
                <th className="r">Vendu TTC</th>
                <th className="r">Remboursé</th>
                <th className="r">Déjà ajusté</th>
                <th className="r">Reste</th>
              </tr>
            </thead>
            <tbody>
              {sale.categories.map((c) => (
                <tr key={c.rate}>
                  <td>{c.label}</td>
                  <td className="r">{fcfa(c.sold)}</td>
                  <td className="r">{c.returned ? fcfa(c.returned) : ''}</td>
                  <td className="r">{c.adjusted ? fcfa(c.adjusted) : ''}</td>
                  <td className="r">{fcfa(c.remaining)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="grid2">
            <Field label="Type">
              <select value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
                <option value="credit_note">Avoir (réduction accordée au client)</option>
                <option value="correction">Correction justifiée (en plus ou en moins)</option>
                <option value="reclass">Reclassement de catégorie fiscale</option>
              </select>
            </Field>
            <Field label={kind === 'reclass' ? 'Catégorie de départ' : 'Catégorie fiscale'}>
              <select value={rate ?? ''} onChange={(e) => setRate(Number(e.target.value))}>
                {sale.categories.map((c) => (
                  <option key={c.rate} value={c.rate}>
                    {c.label}
                  </option>
                ))}
              </select>
            </Field>
            {kind === 'reclass' && (
              <Field label="Catégorie d’arrivée">
                <select value={toRate ?? ''} onChange={(e) => setToRate(e.target.value === '' ? null : Number(e.target.value))}>
                  <option value="">Choisir…</option>
                  {categories
                    .filter((c) => c.rate !== rate)
                    .map((c) => (
                      <option key={c.rate} value={c.rate}>
                        {c.label}
                      </option>
                    ))}
                </select>
              </Field>
            )}
            {kind === 'correction' && (
              <Field label="Sens">
                <select value={sign} onChange={(e) => setSign(Number(e.target.value) as 1 | -1)}>
                  <option value={-1}>En moins</option>
                  <option value={1}>En plus</option>
                </select>
              </Field>
            )}
            <Field label="Montant TTC">
              <input inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} />
            </Field>
            <Field label="Pièce justificative" hint="N° d’avoir remis au client, réclamation, courrier, PV…">
              <input value={reference} onChange={(e) => setReference(e.target.value)} />
            </Field>
          </div>
          <Field label="Motif">
            <textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
        </>
      )}
      <div className="actions">
        <button className="primary" disabled={!sale || rate === null || !value || reason.trim().length < 10 || !reference.trim()} onClick={submit}>
          Proposer
        </button>
        <button onClick={onClose}>Annuler</button>
      </div>
    </Modal>
  );
}

function AdjustmentDetail({ id, userId, onClose, onChanged }: { id: string; userId: string; onClose: () => void; onChanged: () => void }) {
  const toast = useToast();
  const can = useCan();
  const adj = useLoad(() => call('fiscalPrep.adjustment', id), [id]);
  const a = adj.data;
  if (!a) return null;
  const mine = a.created_by === userId;
  const decide = async (action: 'approve' | 'reject' | 'withdraw') => {
    let reason: string | null = null;
    if (action === 'reject') {
      reason = await askText('Motif du refus');
      if (!reason) return;
    } else if (!(await askConfirm(action === 'approve' ? `Approuver ${a.number} ? Il entrera dans l’état fiscal et ne pourra plus être modifié.` : `Retirer votre proposition ${a.number} ?`))) return;
    try {
      await call('fiscalPrep.decide', id, action, reason);
      adj.reload();
      onChanged();
    } catch (e) {
      toast.error(e);
    }
  };
  return (
    <Modal title={`${KIND_LABELS[a.kind]} ${a.number}`} onClose={onClose} wide>
      <p>
        Vente réelle <b>{a.sale_number}</b> · identifiant {a.sale_id}
      </p>
      <p>
        État : <b>{STATUS_LABELS[a.status]}</b>
        {a.decided_by_name ? ` par ${a.decided_by_name} le ${dateTime(a.decided_at!)}` : ''}
        {a.decision_reason ? ` (${a.decision_reason})` : ''}
      </p>
      <table className="list compact">
        <thead>
          <tr>
            <th>Catégorie (taux)</th>
            <th className="r">Effet TTC</th>
            <th className="r">Effet HT</th>
            <th className="r">Effet TVA</th>
          </tr>
        </thead>
        <tbody>
          {a.effects.map((e) => (
            <tr key={e.rate}>
              <td>{rateLabel(e.rate)}</td>
              <td className="r">{fcfa(e.ttc)}</td>
              <td className="r">{fcfa(e.ht)}</td>
              <td className="r">{fcfa(e.tva)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p>Motif : {a.reason}</p>
      <p>Pièce justificative : {a.reference}</p>
      <h3>Historique</h3>
      <ul>
        {a.journal.map((l) => (
          <li key={l.id}>
            {dateTime(l.at)} · {ACTION_LABELS[l.action]} par {l.user_name}
            {l.reason ? ` : ${l.reason}` : ''}
          </li>
        ))}
      </ul>
      <div className="actions">
        {a.status === 'pending' && !mine && can('fiscal_approve') && (
          <>
            <button className="primary" onClick={() => decide('approve')}>
              Approuver
            </button>
            <button onClick={() => decide('reject')}>Refuser</button>
          </>
        )}
        {a.status === 'pending' && mine && <button onClick={() => decide('withdraw')}>Retirer ma proposition</button>}
        {a.status === 'pending' && mine && <span className="muted">Un autre utilisateur doit l’approuver.</span>}
        <button onClick={onClose}>Fermer</button>
      </div>
    </Modal>
  );
}

function StatementsTab() {
  const toast = useToast();
  const list = useLoad(() => call('fiscalPrep.statements'), []).data ?? [];
  const [open, setOpen] = useState<string | null>(null);
  const shown = useLoad(() => (open ? call('fiscalPrep.getStatement', open) : Promise.resolve(undefined)), [open]).data;
  if (list.length === 0) return <Empty>Aucun état généré. Dans « État fiscal », choisissez la période puis « Générer l’état » : il est figé et gardé ici.</Empty>;
  return (
    <>
      <table className="list compact">
        <thead>
          <tr>
            <th>N°</th>
            <th>Période</th>
            <th className="r">CA réel HT</th>
            <th className="r">CA déclaré HT</th>
            <th>Généré par</th>
            <th>Le</th>
          </tr>
        </thead>
        <tbody>
          {list.map((s) => (
            <tr key={s.id} className="clickable" onClick={() => setOpen(s.id)}>
              <td>{s.number}</td>
              <td>
                {dateFr(s.period_from)} au {dateFr(s.period_to)}
              </td>
              <td className="r">{fcfa(s.real_ht)}</td>
              <td className="r">{fcfa(s.declared_ht)}</td>
              <td>{s.generated_by_name}</td>
              <td>{dateTime(s.generated_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {open && shown && (
        <Modal title={`État fiscal ${shown.number}`} onClose={() => setOpen(null)} wide>
          <p>
            Du {dateFr(shown.period_from)} au {dateFr(shown.period_to)} · généré par {shown.generated_by_name} le {dateTime(shown.generated_at)}
          </p>
          <p className={shown.intact ? 'muted' : 'warn'}>{shown.intact ? `Empreinte vérifiée : ${shown.hash}` : 'Empreinte incorrecte : cet état a été modifié depuis sa génération.'}</p>
          <StatementView st={shown.statement} />
          <div className="actions">
            <button
              className="primary"
              onClick={async () => {
                try {
                  downloadText(`etat-fiscal_${shown.number}.csv`, await call('fiscalPrep.exportStatementCsv', shown.id));
                } catch (e) {
                  toast.error(e);
                }
              }}
            >
              Exporter (CSV)
            </button>
            <button onClick={() => setOpen(null)}>Fermer</button>
          </div>
        </Modal>
      )}
    </>
  );
}

function JournalTab() {
  const [tick, setTick] = useState(0);
  const rows = useLoad(() => call('fiscalPrep.journal'), [tick]).data ?? [];
  const check = useLoad(() => call('fiscalPrep.verify'), [tick]).data;
  return (
    <>
      <div className="filters">
        <button onClick={() => setTick((t) => t + 1)}>Vérifier le journal</button>
        {check &&
          (check.ok ? (
            <span className="ok">Journal intact : {check.checked} lignes vérifiées.</span>
          ) : (
            <span className="warn">{check.problems.length} anomalies trouvées</span>
          ))}
      </div>
      {check && !check.ok && (
        <ul className="warn">
          {check.problems.map((p, i) => (
            <li key={i}>{p}</li>
          ))}
        </ul>
      )}
      <p className="muted">Chaque ligne est chaînée à la précédente par son empreinte : une ligne retirée ou changée se voit à la vérification. Rien ne s’y modifie ni ne s’y efface.</p>
      {rows.length === 0 ? (
        <Empty>Le journal est vide : aucun ajustement proposé ni état généré.</Empty>
      ) : (
        <table className="list compact">
          <thead>
            <tr>
              <th>Date</th>
              <th>Document</th>
              <th>Action</th>
              <th>Utilisateur</th>
              <th>Motif</th>
              <th>Empreinte</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((l) => (
              <tr key={l.id}>
                <td>{dateTime(l.at)}</td>
                <td>{l.number}</td>
                <td>{ACTION_LABELS[l.action]}</td>
                <td>{l.user_name}</td>
                <td>{l.reason}</td>
                <td className="muted">{l.hash.slice(0, 12)}…</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
