import { useState } from 'react';
import { type Result, call } from '../api';
import { Empty, Field, Modal, askConfirm, dateFr, fcfa, parseAmount, today, useLoad, useToast } from '../ui';
import { tx } from '../tax';

type BudgetRow = Result<'planning.budgetReport'>['rows'][number];
type AnalyticRow = Result<'planning.analyticByDepartment'>['rows'][number];

const MONTHS = ['Janvier', 'Février', 'Mars', 'Avril', 'Mai', 'Juin', 'Juillet', 'Août', 'Septembre', 'Octobre', 'Novembre', 'Décembre'];
const pct = (bp: number) => `${(bp / 100).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} %`;
const gapCell = (v: number) => <td className={`r ${v < 0 ? 'neg' : v > 0 ? 'pos' : ''}`}>{v ? fcfa(v) : ''}</td>;

// --- Trésorerie prévisionnelle ------------------------------------------------------

/** Ce qui va entrer et sortir semaine par semaine, à partir des échéances connues. */
export function CashForecast() {
  const [weeks, setWeeks] = useState(8);
  const [estimates, setEstimates] = useState(true);
  const f = useLoad(() => call('planning.forecast', { weeks, estimates }), [weeks, estimates]);
  if (!f.data) return null;
  const d = f.data;
  const low = d.weeks.find((w) => w.closing < 0);
  return (
    <>
      <div className="filters">
        <label className="inline">
          Horizon{' '}
          <select value={weeks} onChange={(e) => setWeeks(Number(e.target.value))}>
            {[4, 8, 13, 26].map((n) => (
              <option key={n} value={n}>
                {n} semaines
              </option>
            ))}
          </select>
        </label>
        <label className="inline">
          <input type="checkbox" checked={estimates} onChange={(e) => setEstimates(e.target.checked)} /> Ajouter les ventes et achats comptant habituels (moyenne des 4 dernières semaines)
        </label>
      </div>
      <div className="kpis">
        <div>
          <small>Trésorerie aujourd'hui</small>
          <strong>{fcfa(d.opening)}</strong>
        </div>
        <div className={d.late.customers ? 'pos' : ''}>
          <small>Clients en retard</small>
          <strong>{fcfa(d.late.customers)}</strong>
        </div>
        <div className={d.late.suppliers || d.late.charges ? 'neg' : ''}>
          <small>Fournisseurs et charges en retard</small>
          <strong>{fcfa(d.late.suppliers + d.late.charges)}</strong>
        </div>
        <div className={low ? 'neg' : ''}>
          <small>{low ? `Trésorerie négative la semaine du ${dateFr(low.from)}` : 'Fin de période'}</small>
          <strong>{fcfa(low ? low.closing : (d.weeks.at(-1)?.closing ?? d.opening))}</strong>
        </div>
      </div>
      <table className="list">
        <thead>
          <tr>
            <th>Semaine</th>
            <th className="r">Début</th>
            <th className="r">Clients</th>
            {d.estimates && <th className="r">Ventes comptant</th>}
            <th className="r">Fournisseurs</th>
            {d.estimates && <th className="r">Achats comptant</th>}
            <th className="r">Charges fixes</th>
            <th className="r">Fin</th>
          </tr>
        </thead>
        <tbody>
          {d.weeks.map((w) => (
            <tr key={w.from}>
              <td>
                {dateFr(w.from)} au {dateFr(w.to)}
              </td>
              <td className="r">{fcfa(w.opening)}</td>
              <td className="r">{w.customers ? fcfa(w.customers) : ''}</td>
              {d.estimates && <td className="r">{w.sales ? fcfa(w.sales) : ''}</td>}
              <td className="r">{w.suppliers ? fcfa(w.suppliers) : ''}</td>
              {d.estimates && <td className="r">{w.purchases ? fcfa(w.purchases) : ''}</td>}
              <td className="r">{w.charges ? fcfa(w.charges) : ''}</td>
              <td className={`r ${w.closing < 0 ? 'neg' : ''}`}>
                <b>{fcfa(w.closing)}</b>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted">
        Départ : {d.positions.map((p) => `${p.label} ${fcfa(p.balance)}`).join(' · ') || 'aucun compte de trésorerie'}. Les échéances déjà dépassées sont comptées la première semaine.
      </p>
      <h3>Échéances</h3>
      {d.items.length === 0 ? (
        <Empty>Aucune échéance connue : ventes à crédit, factures fournisseurs non payées et charges fixes apparaissent ici.</Empty>
      ) : (
        <table className="list compact">
          <thead>
            <tr>
              <th>Date</th>
              <th>Nature</th>
              <th>Libellé</th>
              <th className="r">Montant</th>
            </tr>
          </thead>
          <tbody>
            {d.items.map((i, n) => (
              <tr key={n}>
                <td className={i.late ? 'neg' : ''}>
                  {dateFr(i.date)}
                  {i.late ? ' (en retard)' : ''}
                </td>
                <td>{i.kind === 'customer' ? 'Client' : i.kind === 'supplier' ? 'Fournisseur' : 'Charge fixe'}</td>
                <td>{i.label}</td>
                <td className={`r ${i.amount < 0 ? 'neg' : 'pos'}`}>{fcfa(i.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

// --- Budgets ----------------------------------------------------------------------

/** Budget mensuel par compte de charges ou de produits, comparé au réel du mois et depuis janvier. */
export function Budgets() {
  const toast = useToast();
  const now = today();
  const [year, setYear] = useState(Number(now.slice(0, 4)));
  const [month, setMonth] = useState(Number(now.slice(5, 7)));
  const [edit, setEdit] = useState<BudgetRow | 'new' | null>(null);
  const r = useLoad(() => call('planning.budgetReport', year, month), [year, month, edit]);
  const rows = r.data?.rows ?? [];
  const line = (b: BudgetRow, total = false) => (
    <tr key={b.account} className={total ? 'total' : 'clickable'} onClick={total ? undefined : () => setEdit(b)}>
      <td>{total ? '' : b.account}</td>
      <td>{b.label}</td>
      <td className="r">{fcfa(b.budget)}</td>
      <td className="r">{fcfa(b.real)}</td>
      {gapCell(b.gap)}
      <td className="r">{fcfa(b.budgetToDate)}</td>
      <td className="r">{fcfa(b.realToDate)}</td>
      {gapCell(b.gapToDate)}
    </tr>
  );
  return (
    <>
      <div className="filters">
        <select value={month} onChange={(e) => setMonth(Number(e.target.value))}>
          {MONTHS.map((m, i) => (
            <option key={m} value={i + 1}>
              {m}
            </option>
          ))}
        </select>
        <input type="number" value={year} onChange={(e) => setYear(Number(e.target.value) || year)} style={{ width: 90 }} />
        <button className="primary" onClick={() => setEdit('new')}>
          Ajouter un budget
        </button>
      </div>
      {rows.length === 0 ? (
        <Empty>Aucun budget pour {year}. Fixez un montant par mois sur les comptes à suivre (loyer, salaires, transport, ventes…) : l'écart avec le réel apparaît chaque mois.</Empty>
      ) : (
        <table className="list">
          <thead>
            <tr>
              <th>Compte</th>
              <th>Intitulé</th>
              <th className="r">Budget du mois</th>
              <th className="r">Réel du mois</th>
              <th className="r">Écart</th>
              <th className="r">Budget depuis janvier</th>
              <th className="r">Réel depuis janvier</th>
              <th className="r">Écart</th>
            </tr>
          </thead>
          <tbody>
            {rows.filter((b) => !b.income).map((b) => line(b))}
            {rows.some((b) => !b.income) && line({ ...r.data!.totals.charges, label: 'Total des charges' }, true)}
            {rows.filter((b) => b.income).map((b) => line(b))}
            {rows.some((b) => b.income) && line({ ...r.data!.totals.income, label: 'Total des produits' }, true)}
          </tbody>
        </table>
      )}
      <p className="muted">Un écart positif est favorable : charge sous le budget ou produit au-dessus. Le réel d'un compte comprend ses sous-comptes.</p>
      {edit && (
        <BudgetDialog
          year={year}
          row={edit === 'new' ? null : edit}
          onClose={() => setEdit(null)}
          onSaved={() => {
            toast.ok('Budget enregistré');
            setEdit(null);
          }}
        />
      )}
    </>
  );
}

function BudgetDialog({ year, row, onClose, onSaved }: { year: number; row: BudgetRow | null; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const accounts = useLoad(() => call('accounting.accounts'), []);
  const [account, setAccount] = useState(row?.account ?? '');
  const [months, setMonths] = useState<string[]>(row ? row.months.map(String) : Array(12).fill(''));
  const [same, setSame] = useState('');
  const choices = (accounts.data ?? []).filter((a) => /^[67]/.test(a.id));
  const save = async (values: number[]) => {
    try {
      await call('planning.saveBudget', { year, account, months: values });
      onSaved();
    } catch (e) {
      toast.error(e);
    }
  };
  return (
    <Modal title={row ? `Budget ${year} · ${row.account} ${row.label}` : `Nouveau budget ${year}`} onClose={onClose} wide>
      {!row && (
        <Field label="Compte de charges (6) ou de produits (7)">
          <select value={account} onChange={(e) => setAccount(e.target.value)} autoFocus>
            <option value="">Choisir…</option>
            {choices.map((a) => (
              <option key={a.id} value={a.id}>
                {a.id} · {a.label}
              </option>
            ))}
          </select>
        </Field>
      )}
      <div className="filters">
        <input inputMode="numeric" placeholder="Même montant chaque mois" value={same} onChange={(e) => setSame(e.target.value)} />
        <button disabled={parseAmount(same) === null} onClick={() => setMonths(Array(12).fill(String(parseAmount(same))))}>
          Appliquer aux 12 mois
        </button>
      </div>
      <div className="grid3">
        {MONTHS.map((m, i) => (
          <Field key={m} label={m}>
            <input inputMode="numeric" value={months[i]} onChange={(e) => setMonths(months.map((v, j) => (j === i ? e.target.value : v)))} />
          </Field>
        ))}
      </div>
      <p>Total de l'année : {fcfa(months.reduce((t, v) => t + (parseAmount(v) ?? 0), 0))}</p>
      <div className="actions">
        {row && (
          <button
            className="danger"
            onClick={async () => {
              if (await askConfirm(`Supprimer le budget ${year} du compte ${row.account} ?`)) await save(Array(12).fill(0));
            }}
          >
            Supprimer
          </button>
        )}
        <button onClick={onClose}>Annuler</button>
        <button className="primary" disabled={!account} onClick={() => save(months.map((v) => parseAmount(v) ?? 0))}>
          Enregistrer
        </button>
      </div>
    </Modal>
  );
}

// --- Analytique -------------------------------------------------------------------

/** Marge et résultat par rayon (charges réparties au prorata du chiffre d'affaires) et par magasin. */
export function Analytics() {
  const [from, setFrom] = useState(() => `${today().slice(0, 8)}01`);
  const [to, setTo] = useState(today);
  const [by, setBy] = useState<'department' | 'store'>('department');
  const dept = useLoad(() => (by === 'department' && from <= to ? call('planning.analyticByDepartment', from, to) : Promise.resolve(null)), [by, from, to]);
  const stores = useLoad(() => (by === 'store' && from <= to ? call('planning.analyticByStore', from, to) : Promise.resolve(null)), [by, from, to]);
  const data = by === 'department' ? dept.data : stores.data;
  const row = (r: AnalyticRow, total = false) => (
    <tr key={r.key} className={total ? 'total' : ''}>
      <td>{r.label}</td>
      <td className="r">{fcfa(r.revenueHt)}</td>
      <td className="r">{total ? '' : pct(r.shareBp)}</td>
      <td className="r">{fcfa(r.cost)}</td>
      <td className="r">{fcfa(r.margin)}</td>
      <td className="r">{r.revenueHt ? pct(Math.round((r.margin * 10_000) / r.revenueHt)) : ''}</td>
      <td className="r">{fcfa(r.charges)}</td>
      <td className={`r ${r.result < 0 ? 'neg' : ''}`}>
        <b>{fcfa(r.result)}</b>
      </td>
    </tr>
  );
  return (
    <>
      <div className="filters">
        <select value={by} onChange={(e) => setBy(e.target.value as typeof by)}>
          <option value="department">Par rayon</option>
          <option value="store">Par magasin</option>
        </select>
        <label className="inline">
          Du <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="inline">
          au <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
      </div>
      {data && data.rows.length === 0 ? (
        <Empty>Aucune vente sur la période.</Empty>
      ) : data ? (
        <table className="list">
          <thead>
            <tr>
              <th>{by === 'department' ? 'Rayon' : 'Magasin'}</th>
              <th className="r">{tx("Chiffre d'affaires HT")}</th>
              <th className="r">Part</th>
              <th className="r">Coût d'achat</th>
              <th className="r">Marge</th>
              <th className="r">Taux de marge</th>
              <th className="r">Charges réparties</th>
              <th className="r">Résultat</th>
            </tr>
          </thead>
          <tbody>
            {data.rows.map((r) => row(r))}
            {row(data.total, true)}
          </tbody>
        </table>
      ) : null}
      {by === 'department' && dept.data && dept.data.charges.length > 0 && (
        <>
          <h3>Charges de la période réparties</h3>
          <table className="list compact">
            <tbody>
              {dept.data.charges.map((c) => (
                <tr key={c.account}>
                  <td>{c.account}</td>
                  <td>{c.label}</td>
                  <td className="r">{fcfa(c.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      <p className="muted">
        Les charges (classe 6, hors achats de marchandises) sont réparties au prorata du chiffre d'affaires HT de chaque {by === 'department' ? 'rayon' : 'magasin'}.
        {by === 'store' ? ' Seuls les magasins dont les ventes sont sur ce poste apparaissent.' : ''}
      </p>
    </>
  );
}

// --- Remises de chèques -----------------------------------------------------------

/** Bordereaux de remise en banque des chèques reçus (513 « Chèques à encaisser » vers la banque). */
export function ChequeDeposits() {
  const toast = useToast();
  const [tick, setTick] = useState(0);
  const pending = useLoad(() => call('cheques.pending'), [tick]);
  const list = useLoad(() => call('cheques.list'), [tick]);
  const [picked, setPicked] = useState<string[] | null>(null);
  const [date, setDate] = useState(today);
  const [bank, setBank] = useState('');
  const cheques = pending.data ?? [];
  const chosen = picked ?? cheques.map((c) => c.payment_id);
  const total = cheques.filter((c) => chosen.includes(c.payment_id)).reduce((t, c) => t + c.amount, 0);
  const create = async () => {
    try {
      const d = await call('cheques.create', { date, bank, paymentIds: chosen });
      toast.ok(`Bordereau ${d.number} : ${d.count} chèques, ${fcfa(d.total)}`);
      setPicked(null);
      setTick((t) => t + 1);
      await call('cheques.print', d.id);
    } catch (e) {
      toast.error(e);
    }
  };
  return (
    <>
      <h3>Chèques à remettre en banque</h3>
      {cheques.length === 0 ? (
        <Empty>Aucun chèque en attente. Les chèques reçus en caisse ou en règlement de clients restent au compte 513 jusqu'à leur remise en banque.</Empty>
      ) : (
        <>
          <table className="list compact">
            <thead>
              <tr>
                <th />
                <th>Reçu le</th>
                <th>Pièce</th>
                <th>N° du chèque</th>
                <th>Tireur</th>
                <th className="r">Montant</th>
              </tr>
            </thead>
            <tbody>
              {cheques.map((c) => (
                <tr key={c.payment_id}>
                  <td>
                    <input
                      type="checkbox"
                      checked={chosen.includes(c.payment_id)}
                      onChange={(e) => setPicked(e.target.checked ? [...chosen, c.payment_id] : chosen.filter((x) => x !== c.payment_id))}
                    />
                  </td>
                  <td>{dateFr(c.received_at.slice(0, 10))}</td>
                  <td>{c.doc_number}</td>
                  <td>{c.reference}</td>
                  <td>{c.drawer}</td>
                  <td className="r">{fcfa(c.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="filters">
            <label className="inline">
              Remis le <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </label>
            <input placeholder="Banque" value={bank} onChange={(e) => setBank(e.target.value)} />
            <span>
              {chosen.length} chèques · {fcfa(total)}
            </span>
            <button className="primary" disabled={chosen.length === 0} onClick={create}>
              Créer et imprimer le bordereau
            </button>
          </div>
        </>
      )}
      <h3>Bordereaux</h3>
      {(list.data ?? []).length === 0 ? (
        <p className="muted">Aucun bordereau.</p>
      ) : (
        <table className="list">
          <thead>
            <tr>
              <th>N°</th>
              <th>Date</th>
              <th>Banque</th>
              <th className="r">Chèques</th>
              <th className="r">Total</th>
              <th>État</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(list.data ?? []).map((d) => (
              <tr key={d.id} className={d.status === 'cancelled' ? 'muted' : ''}>
                <td>{d.number}</td>
                <td>{dateFr(d.deposit_date)}</td>
                <td>{d.bank}</td>
                <td className="r">{d.count}</td>
                <td className="r">{fcfa(d.total)}</td>
                <td>{d.status === 'cancelled' ? 'Annulé' : ''}</td>
                <td>
                  <button className="link" onClick={() => call('cheques.print', d.id).catch(toast.error)}>
                    Imprimer
                  </button>
                  {d.status === 'active' && (
                    <button
                      className="link"
                      onClick={async () => {
                        if (!(await askConfirm(`Annuler le bordereau ${d.number} ? Ses chèques redeviennent à remettre.`))) return;
                        try {
                          await call('cheques.cancel', d.id);
                          setTick((t) => t + 1);
                        } catch (e) {
                          toast.error(e);
                        }
                      }}
                    >
                      Annuler
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
