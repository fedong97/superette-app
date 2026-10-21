import { useState } from 'react';
import { type Result, call } from '../api';
import { Empty, Field, Modal, Tabs, askConfirm, dateFr, dateTime, downloadText, fcfa, parseAmount, today, useCan, useLoad, useToast } from '../ui';

export type FiscalPrepTab = 'state' | 'reconciliation' | 'simulator' | 'statements' | 'journal';
type Statement = Result<'fiscalPrep.statement'>;

const monthStart = (d: string) => `${d.slice(0, 8)}01`;
/** Mois précédent : celui qu'on déclare d'habitude. */
function lastMonth(): [string, string] {
  const d = new Date();
  const iso = (x: Date) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
  return [iso(new Date(d.getFullYear(), d.getMonth() - 1, 1)), iso(new Date(d.getFullYear(), d.getMonth(), 0))];
}
const rateLabel = (bp: number) => `${(bp / 100).toLocaleString('fr-FR')} %`;

/**
 * Préparation fiscale : état comptable et fiscal lu dans les ventes réelles et la
 * comptabilité. Ce module n'enregistre aucune opération : un avoir est un retour fait à
 * la caisse, une correction se passe en comptabilité.
 */
export function FiscalPrep({ initialTab = 'state' }: { initialTab?: FiscalPrepTab }) {
  const [tab, setTab] = useState<FiscalPrepTab>(initialTab);
  return (
    <div className="page">
      <header className="page-head">
        <h1>Préparation fiscale</h1>
      </header>
      <p className="muted">
        État lu dans les ventes réelles et la comptabilité, sans rien y changer. Les avoirs sont les retours clients faits à la caisse (déjà en caisse et en comptabilité) ; une
        correction se passe en comptabilité. Le chiffre de l’état est donc toujours celui des livres.
      </p>
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          ['state', 'État fiscal'],
          ['reconciliation', 'Rapprochement'],
          ['simulator', 'Simulateur des régimes'],
          ['statements', 'États générés'],
          ['journal', 'Journal et contrôle'],
        ]}
      />
      {tab === 'state' && <StateTab />}
      {tab === 'reconciliation' && <ReconciliationTab />}
      {tab === 'simulator' && <SimulatorTab />}
      {tab === 'statements' && <StatementsTab />}
      {tab === 'journal' && <JournalTab />}
    </div>
  );
}

function StateTab() {
  const toast = useToast();
  const [[from, to], setPeriod] = useState<[string, string]>(lastMonth);
  const valid = Boolean(from && to && from <= to);
  const st = useLoad(() => (valid ? call('fiscalPrep.statement', from, to) : Promise.resolve(undefined)), [from, to]).data;
  const generate = async () => {
    if (!(await askConfirm(`Générer l’état fiscal du ${dateFr(from)} au ${dateFr(to)} ? Il sera figé tel quel, avec son empreinte, et ne se modifiera plus.`))) return;
    try {
      const g = await call('fiscalPrep.generate', from, to);
      toast.ok(`État ${g.number} généré`);
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
          <button className="primary" onClick={generate}>
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
          <button
            onClick={async () => {
              try {
                if (await call('fiscalPrep.controlPdf', from, to)) toast.ok('Dossier de contrôle enregistré');
              } catch (e) {
                toast.error(e);
              }
            }}
          >
            Dossier de contrôle (PDF)
          </button>
          <button
            onClick={async () => {
              try {
                downloadText(`dossier-controle_${from}_${to}.csv`, await call('fiscalPrep.controlCsv', from, to));
              } catch (e) {
                toast.error(e);
              }
            }}
          >
            Dossier de contrôle (CSV)
          </button>
        </div>
      )}
    </>
  );
}

/** Un état fiscal : catégories, avoirs clients, contrôle comptable et montants à reporter. */
function StatementView({ st }: { st: Statement }) {
  const vat = st.store.vatEnabled;
  return (
    <>
      <table className="list compact">
        <thead>
          <tr>
            <th>Catégorie fiscale</th>
            <th className="r">Chiffre d’affaires HT</th>
            {vat && <th className="r">TVA</th>}
            <th className="r">TTC</th>
          </tr>
        </thead>
        <tbody>
          {st.categories.map((c) => (
            <tr key={c.rate}>
              <td>{c.label}</td>
              <td className="r">{fcfa(c.ht)}</td>
              {vat && <td className="r">{fcfa(c.tva)}</td>}
              <td className="r">{fcfa(c.ttc)}</td>
            </tr>
          ))}
          <tr>
            <td>
              <b>Total</b>
            </td>
            <td className="r">
              <b>{fcfa(st.totals.ht)}</b>
            </td>
            {vat && <td className="r">{fcfa(st.totals.tva)}</td>}
            <td className="r">{fcfa(st.totals.ttc)}</td>
          </tr>
        </tbody>
      </table>
      <p className="muted">
        {st.counts.sales} ventes pour {fcfa(st.gross.ht)} HT, moins {st.counts.creditNotes} avoirs clients ({fcfa(st.totals.ht - st.gross.ht)} HT) ; {st.counts.cancelled} tickets annulés
        hors chiffre d’affaires ({fcfa(st.counts.cancelledTtc)}).
        {st.sourceCheck.ok ? '' : ` Attention : les totaux des tickets (${fcfa(st.sourceCheck.headersTtc)}) ne correspondent pas à leurs lignes (${fcfa(st.sourceCheck.linesTtc)}).`}
      </p>
      {st.creditNotes.length > 0 && (
        <>
          <h3>Avoirs clients de la période</h3>
          <table className="list compact">
            <thead>
              <tr>
                <th>N°</th>
                <th>Date</th>
                <th>Facture d’origine</th>
                <th>Client</th>
                <th className="r">HT</th>
                <th>Motif</th>
              </tr>
            </thead>
            <tbody>
              {st.creditNotes.map((a) => (
                <tr key={a.sale_id}>
                  <td>{a.number}</td>
                  <td>{dateTime(a.created_at)}</td>
                  <td>{a.original_number}</td>
                  <td>{a.customer_name}</td>
                  <td className="r">{fcfa(a.ht)}</td>
                  <td>{a.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      <h3>Contrôle avec la comptabilité</h3>
      <table className="list compact">
        <thead>
          <tr>
            <th />
            <th>Compte</th>
            <th className="r">Comptabilité</th>
            <th className="r">Ventes réelles</th>
            <th className="r">Écart</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Ventes HT</td>
            <td>{st.books.salesAccount}</td>
            <td className="r">{fcfa(st.books.salesHt)}</td>
            <td className="r">{fcfa(st.totals.ht)}</td>
            <td className="r">{st.books.differenceHt ? fcfa(st.books.differenceHt) : '0'}</td>
          </tr>
          {vat && (
            <tr>
              <td>TVA collectée</td>
              <td>{st.books.vatAccount}</td>
              <td className="r">{fcfa(st.books.vatCollected)}</td>
              <td className="r">{fcfa(st.totals.tva)}</td>
              <td className="r">{st.books.differenceTva ? fcfa(st.books.differenceTva) : '0'}</td>
            </tr>
          )}
        </tbody>
      </table>
      <p className={st.books.matches ? 'muted' : 'warn'}>
        {st.books.matches
          ? 'Les comptes correspondent exactement aux ventes réelles.'
          : 'Écart avec les comptes : une écriture manuelle touche les ventes ou la TVA collectée sur la période. Vérifiez-la en comptabilité (Grand livre).'}
      </p>
      {st.books.rebates !== 0 && (
        <p className="muted">
          Ristournes accordées en comptabilité (compte {st.books.rebatesAccount}) : {fcfa(st.books.rebates)}, à reprendre selon leur traitement fiscal.
        </p>
      )}
      {st.concordance && (
        <p className={st.concordance.ok ? 'muted' : 'warn'}>
          {st.concordance.ok
            ? `Journal des ventes, vue de gestion et état fiscal totalisent le même chiffre d’affaires : ${fcfa(st.concordance.fiscalTtc)} TTC.`
            : `Les vues ne concordent pas : journal ${fcfa(st.concordance.journalTtc)}, gestion ${fcfa(st.concordance.managementTtc)}, état ${fcfa(st.concordance.fiscalTtc)} TTC. Signalez-le au support.`}
        </p>
      )}
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
            <th className="r">Chiffre d’affaires HT</th>
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
              <td className="r">{fcfa(s.turnover_ht)}</td>
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
        {check && (check.ok ? <span>Journal intact : {check.checked} lignes vérifiées.</span> : <span className="warn">{check.problems.length} anomalies trouvées</span>)}
      </div>
      {check && !check.ok && (
        <ul className="warn">
          {check.problems.map((p, i) => (
            <li key={i}>{p}</li>
          ))}
        </ul>
      )}
      <p className="muted">Chaque état généré, déclaration inscrite et justification est inscrit ici, chaîné au précédent par son empreinte : une ligne retirée ou changée se voit à la vérification.</p>
      {rows.length === 0 ? (
        <Empty>Le journal est vide : aucun état généré.</Empty>
      ) : (
        <table className="list compact">
          <thead>
            <tr>
              <th>Date</th>
              <th>Objet</th>
              <th>Utilisateur</th>
              <th>Empreinte</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((l) => (
              <tr key={l.id}>
                <td>{dateTime(l.at)}</td>
                <td>{l.number}</td>
                <td>{l.user_name}</td>
                <td className="muted">{l.hash.slice(0, 12)}…</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

type Month = Result<'fiscalPrep.reconciliation'>[number];
const STATUS: Record<Month['status'], string> = {
  not_declared: 'Pas encore déclaré',
  concordant: 'Concordant',
  under: 'Sous-déclaré',
  over: 'Sur-déclaré',
};
const KINDS: [Month['justifications'][number]['kind'], string][] = [
  ['credit_note', 'Avoir client'],
  ['cancellation', 'Ticket annulé'],
  ['entry', 'Écriture comptable'],
  ['rectificative', 'Déclaration rectificative'],
  ['other', 'Autre explication (sans pièce)'],
];

/**
 * Rapprochement : ventes réelles du mois, ce qui a été déclaré, et l'écart. Le réel ne bouge
 * jamais : un écart s'explique par une vraie pièce et se régularise par une déclaration rectificative.
 */
function ReconciliationTab() {
  const can = useCan();
  const [year, setYear] = useState(() => Number(today().slice(0, 4)));
  const [tick, setTick] = useState(0);
  const months = useLoad(() => call('fiscalPrep.reconciliation', `${year}-01-01`, `${year}-12-31`), [year, tick]).data ?? [];
  const [declare, setDeclare] = useState<{ period: string; kind: 'initial' | 'rectificative' } | null>(null);
  const [justify, setJustify] = useState<Month | null>(null);
  const writer = can('fiscal_declare');
  return (
    <>
      <div className="filters">
        <label className="inline">
          Année <input type="number" value={year} min={2000} max={2100} onChange={(e) => setYear(Number(e.target.value))} />
        </label>
      </div>
      <p className="muted">
        Chaque mois : les ventes réelles, ce que vous avez déclaré, et l’écart. Inscrire une déclaration ne change pas le réel ; un écart s’explique par une pièce (avoir, ticket annulé,
        écriture) et se régularise par une déclaration rectificative.
      </p>
      <table className="list compact">
        <thead>
          <tr>
            <th>Mois</th>
            <th className="r">Réel HT</th>
            <th className="r">Réel TVA</th>
            <th className="r">Déclaré HT</th>
            <th className="r">Déclaré TVA</th>
            <th className="r">Écart HT</th>
            <th className="r">Écart TVA</th>
            <th>Situation</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {months.map((m) => (
            <MonthRows key={m.period} m={m} writer={writer} onDeclare={(kind) => setDeclare({ period: m.period, kind })} onJustify={() => setJustify(m)} />
          ))}
        </tbody>
      </table>
      {declare && (
        <DeclarationModal
          {...declare}
          onClose={() => setDeclare(null)}
          onDone={() => {
            setDeclare(null);
            setTick((t) => t + 1);
          }}
        />
      )}
      {justify && (
        <JustificationModal
          month={justify}
          onClose={() => setJustify(null)}
          onDone={() => {
            setJustify(null);
            setTick((t) => t + 1);
          }}
        />
      )}
    </>
  );
}

function MonthRows({ m, writer, onDeclare, onJustify }: { m: Month; writer: boolean; onDeclare: (kind: 'initial' | 'rectificative') => void; onJustify: () => void }) {
  const d = m.declared;
  const gap = m.status === 'under' || m.status === 'over';
  return (
    <>
      <tr>
        <td>{m.period}</td>
        <td className="r">{fcfa(m.real.ht)}</td>
        <td className="r">{fcfa(m.real.tva)}</td>
        <td className="r">{d ? fcfa(d.turnover_ht) : ''}</td>
        <td className="r">{d ? fcfa(d.vat) : ''}</td>
        <td className="r">{d ? fcfa(m.gapHt) : ''}</td>
        <td className="r">{d ? fcfa(m.gapTva) : ''}</td>
        <td className={gap ? 'warn' : ''}>
          {STATUS[m.status]}
          {d ? ` · ${d.kind === 'rectificative' ? 'rectificative' : 'initiale'} ${d.reference} du ${dateFr(d.filed_on)}` : ''}
        </td>
        <td>
          {writer && !d && <button onClick={() => onDeclare('initial')}>Inscrire la déclaration</button>}
          {writer && d && gap && (
            <>
              <button onClick={() => onDeclare('rectificative')}>Rectificative</button> <button onClick={onJustify}>Justifier l’écart</button>
            </>
          )}
        </td>
      </tr>
      {m.justifications.map((j) => (
        <tr key={j.id}>
          <td />
          <td colSpan={8} className="muted">
            {KINDS.find(([k]) => k === j.kind)?.[1]}
            {j.ref_label ? ` · ${j.ref_label}` : ''} : {j.explanation} ({j.user_name}, {dateTime(j.created_at)})
          </td>
        </tr>
      ))}
    </>
  );
}

function DeclarationModal({ period, kind, onClose, onDone }: { period: string; kind: 'initial' | 'rectificative'; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [ht, setHt] = useState('');
  const [vat, setVat] = useState('');
  const [reference, setReference] = useState('');
  const [filedOn, setFiledOn] = useState(today());
  const [note, setNote] = useState('');
  const save = async () => {
    const turnoverHt = parseAmount(ht);
    const v = parseAmount(vat || '0');
    if (turnoverHt === null || v === null) return toast.error('Montant invalide');
    try {
      await call('fiscalPrep.recordDeclaration', { period, kind, turnoverHt, vat: v, reference, filedOn, note });
      toast.ok('Déclaration inscrite');
      onDone();
    } catch (e) {
      toast.error(e);
    }
  };
  return (
    <Modal title={`${kind === 'rectificative' ? 'Déclaration rectificative' : 'Déclaration déposée'} de ${period}`} onClose={onClose}>
      <p className="muted">Recopiez les montants tels qu’ils figurent sur la déclaration déposée. Ils servent au rapprochement et ne changent ni les ventes ni l’état fiscal.</p>
      <Field label="Chiffre d’affaires HT déclaré">
        <input value={ht} onChange={(e) => setHt(e.target.value)} inputMode="numeric" autoFocus />
      </Field>
      <Field label="TVA déclarée">
        <input value={vat} onChange={(e) => setVat(e.target.value)} inputMode="numeric" />
      </Field>
      <Field label="N° de télédéclaration ou de quittance">
        <input value={reference} onChange={(e) => setReference(e.target.value)} />
      </Field>
      <Field label="Déposée le">
        <input type="date" value={filedOn} onChange={(e) => setFiledOn(e.target.value)} />
      </Field>
      <Field label="Note">
        <input value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
      <div className="actions">
        <button className="primary" onClick={save}>
          Inscrire
        </button>
        <button onClick={onClose}>Annuler</button>
      </div>
    </Modal>
  );
}

function JustificationModal({ month, onClose, onDone }: { month: Month; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const pieces = useLoad(() => call('fiscalPrep.pieces', month.period), [month.period]).data;
  const [kind, setKind] = useState<(typeof KINDS)[number][0]>('credit_note');
  const [refId, setRefId] = useState('');
  const [explanation, setExplanation] = useState('');
  const options = kind === 'other' ? [] : (pieces?.[kind] ?? []);
  const save = async () => {
    try {
      await call('fiscalPrep.justify', { declarationId: month.declared!.id, kind, refId: kind === 'other' ? null : refId, explanation });
      toast.ok('Justification inscrite');
      onDone();
    } catch (e) {
      toast.error(e);
    }
  };
  return (
    <Modal title={`Justifier l’écart de ${month.period}`} onClose={onClose}>
      <p className="muted">
        Écart HT {fcfa(month.gapHt)}, TVA {fcfa(month.gapTva)}. La justification documente l’écart avec une pièce réelle ; elle ne change aucun montant. Seule une déclaration
        rectificative régularise un écart.
      </p>
      <Field label="Pièce">
        <select
          value={kind}
          onChange={(e) => {
            setKind(e.target.value as typeof kind);
            setRefId('');
          }}
        >
          {KINDS.map(([k, label]) => (
            <option key={k} value={k}>
              {label}
            </option>
          ))}
        </select>
      </Field>
      {kind !== 'other' && (
        <Field label="Document">
          <select value={refId} onChange={(e) => setRefId(e.target.value)}>
            <option value="">{options.length ? 'Choisir…' : 'Aucune pièce de ce type ce mois-ci'}</option>
            {options.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
        </Field>
      )}
      <Field label="Explication">
        <textarea value={explanation} onChange={(e) => setExplanation(e.target.value)} rows={3} />
      </Field>
      <div className="actions">
        <button className="primary" onClick={save}>
          Inscrire
        </button>
        <button onClick={onClose}>Annuler</button>
      </div>
    </Modal>
  );
}

/** Simulateur : ce que coûterait chaque régime, sur les ventes réelles et le résultat comptable de l'année. */
function SimulatorTab() {
  const [year, setYear] = useState(() => Number(today().slice(0, 4)));
  const sim = useLoad(() => call('fiscalPrep.simulate', year), [year]).data;
  const STATUS_TEXT = { applicable: 'Votre régime', option: 'Sur option', excluded: 'Exclu (chiffre d’affaires trop élevé)' } as const;
  return (
    <>
      <div className="filters">
        <label className="inline">
          Année <input type="number" value={year} min={2000} max={2100} onChange={(e) => setYear(Number(e.target.value))} />
        </label>
      </div>
      {sim && (
        <>
          <p className="muted">
            Calcul sur le chiffre d’affaires réel ({fcfa(sim.turnoverHt)} HT) et le résultat imposable tiré de la comptabilité ({fcfa(sim.taxableIncome)}),{' '}
            {sim.form === 'company' ? 'impôt sur les sociétés' : 'IRPP de l’entrepreneur individuel'}.{sim.provisional ? ' Année en cours : chiffres à date, provisoires.' : ''}
          </p>
          <table className="list compact">
            <thead>
              <tr>
                <th>Régime</th>
                <th>Seuil</th>
                <th>Situation</th>
                <th className="r">Acompte (minimum + CAC)</th>
                <th className="r">Impôt sur le résultat</th>
                <th className="r">Montant dû</th>
              </tr>
            </thead>
            <tbody>
              {sim.regimes.map((r) => (
                <tr key={r.code} className={r.status === 'excluded' ? 'muted' : ''}>
                  <td>
                    <b>{r.label}</b>
                    <div className="muted">{r.obligations}</div>
                  </td>
                  <td>{r.threshold}</td>
                  <td>{STATUS_TEXT[r.status]}</td>
                  <td className="r">{r.minimum ? `${fcfa(r.minimum.total)} (${rateLabel(r.minimum.rate)})` : ''}</td>
                  <td className="r">{r.resultTax === null ? '' : fcfa(r.resultTax)}</td>
                  <td className="r">{r.due === null ? 'Forfait communal' : <b>{fcfa(r.due)}</b>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted">
            Barème en vigueur depuis le {dateFr(sim.ruleset.validFrom)} ({sim.ruleset.source}), relu le {dateFr(sim.ruleset.checkedOn)}. On peut opter pour un régime plus exigeant,
            jamais pour un régime inférieur. Faites valider le choix d’un régime par votre centre des impôts ou votre conseil.
          </p>
        </>
      )}
    </>
  );
}
