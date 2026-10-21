import { useState } from 'react';
import { type Result, call } from '../api';
import { Empty, Modal, Tabs, askConfirm, dateFr, dateTime, downloadText, fcfa, today, useLoad, useToast } from '../ui';

export type FiscalPrepTab = 'state' | 'statements' | 'journal';
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
          ['statements', 'États générés'],
          ['journal', 'Journal et contrôle'],
        ]}
      />
      {tab === 'state' && <StateTab />}
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
      <p className="muted">Chaque état généré est inscrit ici, chaîné au précédent par son empreinte : une ligne retirée ou changée se voit à la vérification.</p>
      {rows.length === 0 ? (
        <Empty>Le journal est vide : aucun état généré.</Empty>
      ) : (
        <table className="list compact">
          <thead>
            <tr>
              <th>Date</th>
              <th>État</th>
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
