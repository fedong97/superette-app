import { Fragment, useState } from 'react';
import { type StatementLine, parseStatementCsv } from '@superette/core';
import { type ApiError, type Result, call } from '../api';
import { Empty, Field, Modal, Tabs, dateFr, downloadText, fcfa, parseAmount, today, useLoad, useToast } from '../ui';

type User = NonNullable<Result<'app.state'>['user']>;
type Account = Result<'accounting.accounts'>[number];
type JournalCode = Result<'accounting.entries'>[number]['journal'];
export type AccountingTab = 'journals' | 'ledger' | 'balance' | 'statements' | 'vat' | 'tax' | 'treasury' | 'bank' | 'accounts';

const JOURNALS: Record<JournalCode, string> = {
  VE: 'Ventes',
  AC: 'Achats',
  CA: 'Caisse',
  BQ: 'Banque',
  MM: 'Mobile Money',
  OD: 'Opérations diverses',
  AN: 'À-nouveaux',
};
const MANUAL_JOURNALS: JournalCode[] = ['OD', 'BQ', 'CA', 'MM', 'AN'];

const ROLES: Record<string, string> = {
  sales: 'Ventes de marchandises',
  purchases: 'Achats de marchandises',
  vat_collected: 'TVA collectée',
  vat_deductible: 'TVA déductible',
  vat_due: 'TVA due',
  vat_credit: 'Crédit de TVA',
  customers: 'Clients',
  suppliers: 'Fournisseurs',
  cash: 'Caisse',
  bank: 'Banque (virements, chèques)',
  card: 'Cartes bancaires',
  mtn: 'MTN Mobile Money',
  orange: 'Orange Money',
  voucher: "Bons d'achat",
  transfer: 'Virements internes (coffre)',
  cash_short: 'Manquants de caisse',
  cash_over: 'Excédents de caisse',
  stock: 'Stock de marchandises',
  stock_variation: 'Variation des stocks',
};

const monthStart = () => `${today().slice(0, 7)}-01`;
const signed = (v: number) => (v === 0 ? '' : v > 0 ? `${fcfa(v)} D` : `${fcfa(-v)} C`);
const amount = (v: number) => (v ? fcfa(v) : '');

/** Comptabilité SYSCOHADA : écritures tirées des caisses, achats et règlements, plus les saisies manuelles. */
export function Accounting({ user, initialTab = 'journals' }: { user: User; initialTab?: AccountingTab }) {
  const [tab, setTab] = useState<AccountingTab>(initialTab);
  const [ledgerAccount, setLedgerAccount] = useState('571');
  const openLedger = (account: string) => {
    setLedgerAccount(account);
    setTab('ledger');
  };
  return (
    <div className="page">
      <header className="page-head">
        <h1>Comptabilité</h1>
        <span className="muted">Plan SYSCOHADA révisé · les écritures se passent toutes seules à partir des Z, factures et règlements</span>
      </header>
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          ['journals', 'Journaux'],
          ['ledger', 'Grand livre'],
          ['balance', 'Balance'],
          ['statements', 'États financiers'],
          ['vat', 'Déclaration de TVA'],
          ['tax', 'Impôt sur le résultat'],
          ['treasury', 'Trésorerie'],
          ['bank', 'Rapprochement bancaire'],
          ['accounts', 'Plan comptable'],
        ]}
      />
      {tab === 'journals' && <Journals />}
      {tab === 'ledger' && <Ledger account={ledgerAccount} onAccount={setLedgerAccount} />}
      {tab === 'balance' && <Balance onOpen={openLedger} />}
      {tab === 'statements' && <Statements onOpen={openLedger} />}
      {tab === 'vat' && <VatReturn />}
      {tab === 'tax' && <TaxReturn />}
      {tab === 'treasury' && <Treasury onOpen={openLedger} />}
      {tab === 'bank' && <BankReconciliation />}
      {tab === 'accounts' && <Accounts user={user} />}
    </div>
  );
}

function Period({ from, to, onFrom, onTo }: { from: string; to: string; onFrom: (v: string) => void; onTo: (v: string) => void }) {
  return (
    <>
      <label className="inline">
        Du <input type="date" value={from} onChange={(e) => onFrom(e.target.value)} />
      </label>
      <label className="inline">
        au <input type="date" value={to} onChange={(e) => onTo(e.target.value)} />
      </label>
    </>
  );
}

function Journals() {
  const toast = useToast();
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(today());
  const [journal, setJournal] = useState<JournalCode | ''>('');
  const [adding, setAdding] = useState(false);
  const list = useLoad(() => call('accounting.entries', { from: from || undefined, to: to || undefined, journal: journal || undefined }), [from, to, journal]);
  const entries = list.data ?? [];
  const total = entries.reduce((t, e) => t + e.lines.reduce((s, l) => s + l.debit, 0), 0);
  return (
    <>
      <div className="filters">
        <Period from={from} to={to} onFrom={setFrom} onTo={setTo} />
        <select value={journal} onChange={(e) => setJournal(e.target.value as JournalCode | '')}>
          <option value="">Tous les journaux</option>
          {(Object.keys(JOURNALS) as JournalCode[]).map((j) => (
            <option key={j} value={j}>
              {j} · {JOURNALS[j]}
            </option>
          ))}
        </select>
        <button style={{ marginLeft: 'auto' }} onClick={() => call('accounting.printJournal', from, to, journal || null).catch(toast.error)}>
          Imprimer
        </button>
        <button
          onClick={async () => {
            try {
              downloadText(`ecritures_${from}_${to}.csv`, `﻿${await call('accounting.exportCsv', { from: from || undefined, to: to || undefined })}`);
            } catch (err) {
              toast.error(err);
            }
          }}
        >
          Export CSV (cabinet comptable)
        </button>
        <button className="primary" onClick={() => setAdding(true)}>
          Saisir une écriture
        </button>
      </div>
      {list.error ? (
        <Empty>{String((list.error as Error).message ?? list.error)}</Empty>
      ) : entries.length === 0 ? (
        <Empty>Aucune écriture sur la période.</Empty>
      ) : (
        <table className="list compact journal">
          <thead>
            <tr>
              <th>Date</th>
              <th>Jnl</th>
              <th>Pièce</th>
              <th>Compte</th>
              <th>Tiers</th>
              <th>Libellé</th>
              <th className="r">Débit</th>
              <th className="r">Crédit</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e, i) => (
              <Fragment key={`${e.journal}-${e.ref}-${i}`}>
                {e.lines.map((l, j) => (
                  <tr key={j} className={j === 0 ? 'entry-first' : ''}>
                    <td>{j === 0 ? dateFr(e.date) : ''}</td>
                    <td>{j === 0 ? <span className="tag">{e.journal}</span> : ''}</td>
                    <td className="nowrap">{j === 0 ? e.ref : ''}</td>
                    <td>{l.account}</td>
                    <td>{l.aux_name ?? l.aux ?? ''}</td>
                    <td>{l.label}</td>
                    <td className="r">{amount(l.debit)}</td>
                    <td className="r">{amount(l.credit)}</td>
                  </tr>
                ))}
              </Fragment>
            ))}
            <tr className="total">
              <td colSpan={6}>
                {entries.length} écritures · total des mouvements
              </td>
              <td className="r">{fcfa(total)}</td>
              <td className="r">{fcfa(total)}</td>
            </tr>
          </tbody>
        </table>
      )}
      {adding && (
        <ManualEntryDialog
          onClose={() => setAdding(false)}
          onSaved={() => {
            setAdding(false);
            list.reload();
          }}
        />
      )}
    </>
  );
}

interface DraftLine {
  account: string;
  aux: string;
  label: string;
  debit: string;
  credit: string;
}
const emptyLine = (): DraftLine => ({ account: '', aux: '', label: '', debit: '', credit: '' });

/** Saisie d'une écriture : à-nouveaux, frais bancaires, versement d'espèces à la banque, loyer… */
function ManualEntryDialog({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const accounts = useLoad(() => call('accounting.accounts'), []);
  const [journal, setJournal] = useState<JournalCode>('OD');
  const [date, setDate] = useState(today());
  const [label, setLabel] = useState('');
  const [lines, setLines] = useState<DraftLine[]>([emptyLine(), emptyLine()]);
  const set = (i: number, patch: Partial<DraftLine>) => setLines(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const num = (v: string) => (v ? (parseAmount(v) ?? NaN) : 0);
  const debit = lines.reduce((t, l) => t + num(l.debit), 0);
  const credit = lines.reduce((t, l) => t + num(l.credit), 0);
  const gap = debit - credit;
  return (
    <Modal title="Saisir une écriture" onClose={onClose} wide>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            const entry = await call('accounting.addEntry', {
              journal,
              date,
              label,
              lines: lines
                .filter((l) => l.account)
                .map((l) => ({ account: l.account, aux: l.aux || null, label: l.label || null, debit: num(l.debit), credit: num(l.credit) })),
            });
            toast.ok(`Écriture ${entry.ref} enregistrée`);
            onSaved();
          } catch (err) {
            toast.error(err);
          }
        }}
      >
        <div className="grid3">
          <Field label="Journal">
            <select value={journal} onChange={(e) => setJournal(e.target.value as JournalCode)}>
              {MANUAL_JOURNALS.map((j) => (
                <option key={j} value={j}>
                  {j} · {JOURNALS[j]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Date">
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
          </Field>
          <Field label="Libellé">
            <input autoFocus value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Loyer d'octobre, frais bancaires…" required />
          </Field>
        </div>
        <datalist id="accounts-list">
          {(accounts.data ?? []).map((a) => (
            <option key={a.id} value={a.id}>
              {a.label}
            </option>
          ))}
        </datalist>
        <table className="list compact">
          <thead>
            <tr>
              <th>Compte</th>
              <th>Intitulé</th>
              <th>Tiers</th>
              <th>Libellé de ligne</th>
              <th className="r">Débit</th>
              <th className="r">Crédit</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={i}>
                <td>
                  <input list="accounts-list" value={l.account} onChange={(e) => set(i, { account: e.target.value.trim() })} style={{ width: 90 }} />
                </td>
                <td className="muted">{accounts.data?.find((a) => a.id === l.account)?.label ?? ''}</td>
                <td>
                  <input value={l.aux} onChange={(e) => set(i, { aux: e.target.value })} style={{ width: 120 }} placeholder="CLI-… / FRS-…" />
                </td>
                <td>
                  <input value={l.label} onChange={(e) => set(i, { label: e.target.value })} />
                </td>
                <td>
                  <input inputMode="numeric" className="r" value={l.debit} onChange={(e) => set(i, { debit: e.target.value, credit: '' })} style={{ width: 110 }} />
                </td>
                <td>
                  <input inputMode="numeric" className="r" value={l.credit} onChange={(e) => set(i, { credit: e.target.value, debit: '' })} style={{ width: 110 }} />
                </td>
              </tr>
            ))}
            <tr className="total">
              <td colSpan={4}>
                <button type="button" onClick={() => setLines([...lines, { ...emptyLine(), ...(gap > 0 ? { credit: String(gap) } : gap < 0 ? { debit: String(-gap) } : {}) }])}>
                  Ajouter une ligne
                </button>{' '}
                {Number.isNaN(gap) ? <span className="neg">Montant invalide</span> : gap !== 0 ? <span className="neg">Écart {fcfa(Math.abs(gap))}</span> : <span className="pos">Équilibrée</span>}
              </td>
              <td className="r">{Number.isNaN(debit) ? '' : fcfa(debit)}</td>
              <td className="r">{Number.isNaN(credit) ? '' : fcfa(credit)}</td>
            </tr>
          </tbody>
        </table>
        <p className="muted">
          Exemples : versement à la banque des espèces prélevées au tiroir (débit 521, crédit 585), frais bancaires (débit 631, crédit 521), loyer payé (débit 6222, crédit 521),
          à-nouveaux de début d'exercice (journal AN).
        </p>
        <div className="actions">
          <button type="button" onClick={onClose}>
            Annuler
          </button>
          <button type="submit" className="primary" disabled={gap !== 0 || debit === 0}>
            Enregistrer l'écriture
          </button>
        </div>
      </form>
    </Modal>
  );
}

function Ledger({ account, onAccount }: { account: string; onAccount: (v: string) => void }) {
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(today());
  const [aux, setAux] = useState('');
  const accounts = useLoad(() => call('accounting.accounts', true), []);
  const ledger = useLoad(() => (account ? call('accounting.ledger', { account, aux: aux || undefined, from: from || undefined, to: to || undefined }) : Promise.resolve(null)), [account, aux, from, to]);
  const l = ledger.data;
  return (
    <>
      <div className="filters">
        <select value={accounts.data?.some((a) => a.id === account) ? account : ''} onChange={(e) => e.target.value && onAccount(e.target.value)}>
          <option value="">Racine de compte…</option>
          {(accounts.data ?? []).map((a) => (
            <option key={a.id} value={a.id}>
              {a.id} · {a.label}
            </option>
          ))}
        </select>
        <input value={account} onChange={(e) => onAccount(e.target.value.trim())} style={{ width: 90 }} title="Compte ou racine (ex. 41, 5)" />
        <input value={aux} onChange={(e) => setAux(e.target.value.trim())} placeholder="Tiers (CLI-…, FRS-…)" style={{ width: 160 }} />
        <Period from={from} to={to} onFrom={setFrom} onTo={setTo} />
      </div>
      {l && (
        <table className="list compact">
          <thead>
            <tr>
              <th>Date</th>
              <th>Jnl</th>
              <th>Pièce</th>
              <th>Compte</th>
              <th>Libellé</th>
              <th className="r">Débit</th>
              <th className="r">Crédit</th>
              <th className="r">Solde</th>
            </tr>
          </thead>
          <tbody>
            {from && (
              <tr className="muted">
                <td colSpan={7}>Solde au {dateFr(from)}</td>
                <td className="r">{signed(l.opening) || '0'}</td>
              </tr>
            )}
            {l.rows.map((r, i) => (
              <tr key={i}>
                <td>{dateFr(r.date)}</td>
                <td>
                  <span className="tag">{r.journal}</span>
                </td>
                <td className="nowrap">{r.ref}</td>
                <td>
                  {r.account}
                  {r.aux ? ` ${r.aux}` : ''}
                </td>
                <td>{r.label}</td>
                <td className="r">{amount(r.debit)}</td>
                <td className="r">{amount(r.credit)}</td>
                <td className="r nowrap">{signed(r.balance)}</td>
              </tr>
            ))}
            <tr className="total">
              <td colSpan={5}>Totaux et solde de fin de période</td>
              <td className="r">{fcfa(l.debit)}</td>
              <td className="r">{fcfa(l.credit)}</td>
              <td className="r nowrap">{signed(l.closing) || '0'}</td>
            </tr>
          </tbody>
        </table>
      )}
      <p className="muted">D = solde débiteur, C = solde créditeur. Tapez une racine (41, 5…) pour regrouper plusieurs comptes.</p>
    </>
  );
}

function Balance({ onOpen }: { onOpen: (account: string) => void }) {
  const toast = useToast();
  const [from, setFrom] = useState(`${today().slice(0, 4)}-01-01`);
  const [to, setTo] = useState(today());
  const tb = useLoad(() => call('accounting.trialBalance', { from: from || undefined, to: to || undefined }), [from, to]);
  const rows = tb.data?.rows ?? [];
  const sumD = rows.reduce((t, r) => t + Math.max(r.closing, 0), 0);
  const sumC = rows.reduce((t, r) => t + Math.max(-r.closing, 0), 0);
  return (
    <>
      <div className="filters">
        <Period from={from} to={to} onFrom={setFrom} onTo={setTo} />
        <button style={{ marginLeft: 'auto' }} onClick={() => call('accounting.printBalance', from, to).catch(toast.error)}>
          Imprimer
        </button>
      </div>
      {rows.length === 0 ? (
        <Empty>Aucun mouvement sur la période.</Empty>
      ) : (
        <table className="list compact">
          <thead>
            <tr>
              <th>Compte</th>
              <th>Intitulé</th>
              <th className="r">À-nouveau</th>
              <th className="r">Débit</th>
              <th className="r">Crédit</th>
              <th className="r">Solde débiteur</th>
              <th className="r">Solde créditeur</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.account} className="clickable" onClick={() => onOpen(r.account)} title="Ouvrir le grand livre de ce compte">
                <td>{r.account}</td>
                <td>{r.label}</td>
                <td className="r">{signed(r.opening)}</td>
                <td className="r">{amount(r.debit)}</td>
                <td className="r">{amount(r.credit)}</td>
                <td className="r">{amount(Math.max(r.closing, 0))}</td>
                <td className="r">{amount(Math.max(-r.closing, 0))}</td>
              </tr>
            ))}
            <tr className="total">
              <td colSpan={3}>Totaux</td>
              <td className="r">{fcfa(tb.data!.totals.debit)}</td>
              <td className="r">{fcfa(tb.data!.totals.credit)}</td>
              <td className="r">{fcfa(sumD)}</td>
              <td className="r">{fcfa(sumC)}</td>
            </tr>
          </tbody>
        </table>
      )}
      {tb.data && tb.data.totals.debit === tb.data.totals.credit && rows.length > 0 && <p className="pos">Balance équilibrée : total des débits = total des crédits.</p>}
    </>
  );
}

type Statements = Result<'accounting.statements'>;
type StatementRow = Statements['income'][number];

/** Bilan et compte de résultat SYSCOHADA de l'exercice (année civile), avec l'exercice précédent. */
function Statements({ onOpen }: { onOpen: (account: string) => void }) {
  const toast = useToast();
  const thisYear = Number(today().slice(0, 4));
  const [year, setYear] = useState(thisYear);
  const [view, setView] = useState<'sheet' | 'income' | 'flows'>('sheet');
  const from = `${year}-01-01`;
  const to = year === thisYear ? today() : `${year}-12-31`;
  const st = useLoad(() => call('accounting.statements', { from, to }), [from, to]);
  const flows = useLoad(() => call('accounting.cashFlow', { from, to }), [from, to]);
  const d = st.data;
  const f = flows.data;
  const cell = (v: number | undefined) => <td className={`r ${v && v < 0 ? 'neg' : ''}`}>{v ? fcfa(v) : '-'}</td>;
  const line = (r: StatementRow, extra?: React.ReactNode) => (
    <tr key={r.ref} className={r.total ? 'total' : ''}>
      <td className="muted">{r.ref}</td>
      <td>{r.label}</td>
      {extra}
      {cell(r.net)}
      {cell(r.previous)}
    </tr>
  );
  const heads = (
    <>
      <th className="r">{year === thisYear ? `Au ${dateFr(to)}` : `Exercice ${year}`}</th>
      <th className="r">Exercice {year - 1}</th>
    </>
  );
  return (
    <>
      <div className="filters">
        <label className="inline">
          Exercice
          <select value={year} onChange={(e) => setYear(Number(e.target.value))}>
            {[0, 1, 2, 3].map((k) => (
              <option key={k} value={thisYear - k}>
                {thisYear - k}
              </option>
            ))}
          </select>
        </label>
        <div className="seg">
          <button className={view === 'sheet' ? 'active' : ''} onClick={() => setView('sheet')}>
            Bilan
          </button>
          <button className={view === 'income' ? 'active' : ''} onClick={() => setView('income')}>
            Compte de résultat
          </button>
          <button className={view === 'flows' ? 'active' : ''} onClick={() => setView('flows')}>
            Flux de trésorerie
          </button>
        </div>
        <button style={{ marginLeft: 'auto' }} onClick={() => call('accounting.printStatements', from, to).catch(toast.error)}>
          Imprimer (A4)
        </button>
        <button
          onClick={() =>
            call('accounting.statementsCsv', { from, to })
              .then((csv) => downloadText(`etats-financiers-${year}.csv`, csv))
              .catch(toast.error)
          }
        >
          Export pour la DSF (CSV)
        </button>
      </div>
      {d && (
        <div className="kpis">
          <div>
            <span>Résultat net {year === thisYear ? 'à ce jour' : year}</span>
            <strong className={d.result < 0 ? 'neg' : 'pos'}>{fcfa(d.result)}</strong>
          </div>
          <div>
            <span>Chiffre d'affaires</span>
            <strong>{fcfa(d.income.find((l) => l.ref === 'XB')!.net)}</strong>
          </div>
          <div>
            <span>Marge commerciale</span>
            <strong>{fcfa(d.income.find((l) => l.ref === 'XA')!.net)}</strong>
          </div>
          <div>
            <span>Stock au CMUP</span>
            <strong>{fcfa(d.stock.closing)}</strong>
          </div>
        </div>
      )}
      {d && d.unmapped.length > 0 && (
        <p className="neg">
          Comptes non repris dans les états, à vérifier :{' '}
          {d.unmapped.map((u, i) => (
            <Fragment key={u.account}>
              {i > 0 && ', '}
              <button className="link" onClick={() => onOpen(u.account)}>
                {u.account}
              </button>{' '}
              ({signed(u.balance)})
            </Fragment>
          ))}
        </p>
      )}
      {d && view === 'sheet' && (
        <div className="grid2 statements">
          <table className="list compact">
            <thead>
              <tr>
                <th />
                <th>Actif</th>
                <th className="r">Brut</th>
                <th className="r">Amort. dépréc.</th>
                {heads}
              </tr>
            </thead>
            <tbody>
              {d.assets.map((a) =>
                line(
                  a,
                  <>
                    <td className="r muted">{a.total || !a.gross ? '' : fcfa(a.gross)}</td>
                    <td className="r muted">{a.total || !a.depreciation ? '' : fcfa(a.depreciation)}</td>
                  </>,
                ),
              )}
            </tbody>
          </table>
          <table className="list compact">
            <thead>
              <tr>
                <th />
                <th>Passif</th>
                {heads}
              </tr>
            </thead>
            <tbody>{d.liabilities.map((l) => line(l))}</tbody>
          </table>
        </div>
      )}
      {d && view === 'income' && (
        <table className="list compact statements">
          <thead>
            <tr>
              <th />
              <th>Compte de résultat</th>
              {heads}
            </tr>
          </thead>
          <tbody>{d.income.map((l) => line(l))}</tbody>
        </table>
      )}
      {f && view === 'flows' && (
        <>
          {f.check.gap !== 0 && (
            <p className="neg">
              La trésorerie du bilan ({fcfa(f.check.treasury)}) diffère de la ligne ZH de {fcfa(f.check.gap)} : une écriture sort du schéma habituel (immobilisation ou capital
              passé sans contrepartie de trésorerie, par exemple). Vérifiez-la avant de remettre le tableau.
            </p>
          )}
          <table className="list compact statements">
            <thead>
              <tr>
                <th />
                <th>Tableau des flux de trésorerie</th>
                {heads}
              </tr>
            </thead>
            <tbody>{f.rows.map((l) => line(l))}</tbody>
          </table>
        </>
      )}
      {d && view === 'flows' && (
        <p className="muted">
          Méthode indirecte du SYSCOHADA : on part du résultat net, on retire ce qui ne se paie pas (amortissements, provisions, cessions), puis on suit les variations du
          bilan. Les à-nouveaux de reprise comptent comme trésorerie de départ, pas comme des flux. La ligne ZH doit égaler la trésorerie du bilan.
        </p>
      )}
      {d && view !== 'flows' && (
        <p className="muted">
          Le stock de marchandises est valorisé au coût moyen pondéré d'après les mouvements de stock ({fcfa(d.stock.opening)} au début de l'exercice, {fcfa(d.stock.closing)}{' '}
          à la date choisie) : l'écart passe en variation de stock (compte 6031), comme l'écriture d'inventaire. Les résultats des exercices précédents apparaissent en report à
          nouveau tant qu'ils ne sont pas affectés par une écriture.
        </p>
      )}
    </>
  );
}

function VatReturn() {
  const toast = useToast();
  const [month, setMonth] = useState(today().slice(0, 7));
  const vat = useLoad(() => call('accounting.vatReturn', month), [month]);
  const inst = useLoad(() => call('tax.instalment', month), [month]);
  const v = vat.data;
  const i = inst.data;
  return (
    <>
      <div className="filters">
        <label className="inline">
          Mois <input type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} />
        </label>
        <button style={{ marginLeft: 'auto' }} className="primary" onClick={() => call('accounting.printVat', month).catch(toast.error)}>
          Imprimer la déclaration
        </button>
      </div>
      {v && (
        <>
          <div className="kpis">
            <div>
              <small>Chiffre d'affaires HT</small>
              <strong>{fcfa(v.turnoverHt)}</strong>
              <small>dont exonéré {fcfa(v.exemptHt)}</small>
            </div>
            <div>
              <small>TVA collectée</small>
              <strong>{fcfa(v.collected)}</strong>
            </div>
            <div>
              <small>TVA déductible</small>
              <strong>{fcfa(v.deductible)}</strong>
              <small>{v.previousCredit ? `+ crédit reporté ${fcfa(v.previousCredit)}` : `${v.invoiceCount} factures fournisseurs, ${v.expenseCount} dépenses`}</small>
            </div>
            <div className={v.due ? 'neg' : 'pos'}>
              <small>{v.due ? 'TVA à payer' : 'Crédit de TVA à reporter'}</small>
              <strong>{fcfa(v.due || v.credit)}</strong>
            </div>
            {i && (
              <div>
                <small>Acompte d'impôt (minimum de perception)</small>
                <strong>{fcfa(i.total)}</strong>
                <small>
                  {(i.rate / 100).toLocaleString('fr-FR')} % du CA HT + CAC · total DGI {fcfa(v.due + i.total)}
                </small>
              </div>
            )}
          </div>
          <div className="grid2 top">
            <table className="list compact">
              <caption>Ventes par taux</caption>
              <thead>
                <tr>
                  <th>Taux</th>
                  <th className="r">TTC</th>
                  <th className="r">HT</th>
                  <th className="r">TVA</th>
                </tr>
              </thead>
              <tbody>
                {v.sales.map((s) => (
                  <tr key={s.rate}>
                    <td>{(s.rate / 100).toLocaleString('fr-FR')} %</td>
                    <td className="r">{fcfa(s.ttc)}</td>
                    <td className="r">{fcfa(s.ht)}</td>
                    <td className="r">{fcfa(s.tva)}</td>
                  </tr>
                ))}
                {v.sales.length > 0 && v.sales.reduce((t, r) => t + r.tva, 0) !== v.collected && (
                  <tr className="muted">
                    <td colSpan={3}>Arrondis de TVA ticket par ticket</td>
                    <td className="r">{fcfa(v.collected - v.sales.reduce((t, r) => t + r.tva, 0))}</td>
                  </tr>
                )}
                {v.sales.length === 0 && (
                  <tr>
                    <td colSpan={4} className="muted">
                      Aucune vente ce mois-ci
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
            <div className="card">
              <p>
                Ce récapitulatif sert à remplir la déclaration mensuelle sur le portail de la DGI. La TVA collectée est celle des tickets (arrondie ticket par
                ticket), la TVA déductible celle des factures et avoirs fournisseurs et des dépenses datés du mois.
              </p>
              <p className="muted">
                L'acompte d'impôt sur le résultat (minimum de perception) est calculé sur le chiffre d'affaires HT du mois, au taux du régime choisi dans
                Fiscal › Impôt sur le résultat. Les précomptes et le droit d'accises restent à ajouter par votre comptable.
              </p>
            </div>
          </div>
        </>
      )}
    </>
  );
}

type TaxForm = Result<'tax.assessment'>['settings']['form'];
type TaxRegime = Result<'tax.assessment'>['settings']['regime'];
type TaxAdjustment = Result<'tax.assessment'>['settings']['adjustments'][number];

const pctFr = (bp: number) => `${(bp / 100).toLocaleString('fr-FR')} %`;

/** Impôt sur le résultat : du résultat comptable au résultat fiscal, liquidation et acomptes mensuels. */
function TaxReturn() {
  const toast = useToast();
  const thisYear = Number(today().slice(0, 4));
  const [year, setYear] = useState(thisYear);
  const st = useLoad(() => call('tax.assessment', year), [year]);
  const a = st.data;
  const [kind, setKind] = useState<TaxAdjustment['kind']>('add');
  const [label, setLabel] = useState('');
  const [amount, setAmount] = useState('');
  const save = (input: Parameters<typeof call<'tax.saveSettings'>>[2], ok?: string) =>
    call('tax.saveSettings', year, input).then(() => {
      if (ok) toast.ok(ok);
      st.reload();
    }, toast.error);
  const v = parseAmount(amount);
  const signed = (n: number) => <td className={`r ${n < 0 ? 'neg' : ''}`}>{fcfa(n)}</td>;
  const rate = (key: 'isRate' | 'reducedRate' | 'minimumRate', text: string) =>
    a && (
      <Field label={text}>
        <input
          key={`${year}-${key}-${a.settings.rates[key]}`}
          inputMode="decimal"
          defaultValue={(a.settings.rates[key] / 100).toLocaleString('fr-FR')}
          onBlur={(e) => {
            const n = Math.round(Number(e.target.value.replace(',', '.').replace('%', '').trim()) * 100);
            if (Number.isFinite(n) && n !== a.settings.rates[key]) save({ rates: { [key]: n } }, 'Taux enregistré');
          }}
        />
      </Field>
    );
  return (
    <>
      <div className="filters">
        <label className="inline">
          Exercice
          <select value={year} onChange={(e) => setYear(Number(e.target.value))}>
            {[0, 1, 2, 3].map((k) => (
              <option key={k} value={thisYear - k}>
                {thisYear - k}
              </option>
            ))}
          </select>
        </label>
        {a && (
          <>
            <select value={a.settings.form} onChange={(e) => save({ form: e.target.value as TaxForm })}>
              <option value="company">Société (impôt sur les sociétés)</option>
              <option value="individual">Entreprise individuelle (IRPP, BIC)</option>
            </select>
            <select value={a.settings.regime} onChange={(e) => save({ regime: e.target.value as TaxRegime })}>
              <option value="reel">Régime du réel</option>
              <option value="simplifie">Régime simplifié</option>
            </select>
          </>
        )}
        <button style={{ marginLeft: 'auto' }} onClick={() => call('tax.print', year).catch(toast.error)}>
          Imprimer (A4)
        </button>
        <button
          className="primary"
          disabled={!a || a.provisional || !a.toBook}
          title={a?.provisional ? "L'impôt se constate une fois l'exercice clos" : undefined}
          onClick={() =>
            call('tax.book', year).then((n) => {
              toast.ok(`Écriture passée : ${fcfa(Math.abs(n))} au compte 891`);
              st.reload();
            }, toast.error)
          }
        >
          {a && !a.provisional && !a.toBook ? 'Impôt passé en comptabilité' : "Passer l'écriture d'impôt"}
        </button>
      </div>
      {a && (
        <div className="kpis">
          <div>
            <span>Chiffre d'affaires HT {a.provisional ? 'à ce jour' : year}</span>
            <strong>{fcfa(a.turnoverHt)}</strong>
          </div>
          <div>
            <span>Résultat fiscal</span>
            <strong className={a.fiscalResult < 0 ? 'neg' : ''}>{fcfa(a.fiscalResult)}</strong>
          </div>
          <div>
            <span>Impôt dû{a.provisional ? ' (provisoire)' : ''}</span>
            <strong>{fcfa(a.due)}</strong>
            <small>{a.due === a.minimum && a.tax.total < a.minimum ? 'minimum de perception' : `${a.settings.form === 'company' ? 'IS' : 'IRPP'} ${pctFr(a.rateApplied)} + CAC`}</small>
          </div>
          <div className={a.balance ? 'neg' : 'pos'}>
            <span>Reste à payer après acomptes</span>
            <strong>{fcfa(a.balance)}</strong>
          </div>
        </div>
      )}
      {a && (
        <div className="grid2 top">
          <section>
            <table className="list compact">
              <caption>Du résultat comptable au résultat fiscal</caption>
              <tbody>
                <tr>
                  <td>Résultat net comptable avant impôt sur le résultat</td>
                  {signed(a.resultBeforeTax)}
                  <td />
                </tr>
                {a.settings.adjustments.map((x, k) => (
                  <tr key={k}>
                    <td>
                      {x.kind === 'add' ? '+ Réintégration' : '- Déduction'} : {x.label}
                    </td>
                    <td className="r">{fcfa(x.kind === 'add' ? x.amount : -x.amount)}</td>
                    <td className="r">
                      <button className="link" onClick={() => save({ adjustments: a.settings.adjustments.filter((_, j) => j !== k) }, 'Ligne retirée')}>
                        Retirer
                      </button>
                    </td>
                  </tr>
                ))}
                <tr className="total">
                  <td>Résultat fiscal</td>
                  {signed(a.fiscalResult)}
                  <td />
                </tr>
                <tr>
                  <td>Déficits des exercices antérieurs (encore reportables)</td>
                  <td className="r">
                    <input
                      key={`${year}-${a.settings.priorLosses}`}
                      className="r"
                      inputMode="numeric"
                      defaultValue={a.settings.priorLosses || ''}
                      placeholder="0"
                      onBlur={(e) => {
                        const n = parseAmount(e.target.value || '0');
                        if (n !== null && n !== a.settings.priorLosses) save({ priorLosses: n }, 'Déficit antérieur enregistré');
                      }}
                    />
                  </td>
                  <td />
                </tr>
                <tr className="total">
                  <td>Bénéfice imposable{a.lossesUsed ? ` (déficit imputé : ${fcfa(a.lossesUsed)})` : ''}</td>
                  <td className="r">{fcfa(a.taxableIncome)}</td>
                  <td />
                </tr>
                <tr>
                  <td>
                    {a.settings.form === 'company' ? `Impôt sur les sociétés à ${pctFr(a.rateApplied)}` : `IRPP au barème (taux moyen ${pctFr(a.rateApplied)})`}, plus CAC
                    10 %
                  </td>
                  <td className="r">{fcfa(a.tax.total)}</td>
                  <td />
                </tr>
                <tr>
                  <td>Minimum de perception (total des acomptes)</td>
                  <td className="r">{fcfa(a.minimum)}</td>
                  <td />
                </tr>
                <tr className="total">
                  <td>Impôt dû (le plus élevé des deux)</td>
                  <td className="r">{fcfa(a.due)}</td>
                  <td />
                </tr>
                <tr className="total">
                  <td>Solde à payer après acomptes</td>
                  <td className="r">{fcfa(a.balance)}</td>
                  <td />
                </tr>
                {a.lossCarriedForward > 0 && (
                  <tr className="muted">
                    <td>Déficit reportable sur les {4} exercices suivants</td>
                    <td className="r">{fcfa(a.lossCarriedForward)}</td>
                    <td />
                  </tr>
                )}
              </tbody>
            </table>
            <form
              className="filters"
              onSubmit={(e) => {
                e.preventDefault();
                if (!v || !label.trim()) return;
                save({ adjustments: [...a.settings.adjustments, { kind, label: label.trim(), amount: v }] }, 'Ligne ajoutée').then(() => {
                  setLabel('');
                  setAmount('');
                });
              }}
            >
              <select value={kind} onChange={(e) => setKind(e.target.value as TaxAdjustment['kind'])}>
                <option value="add">Réintégration</option>
                <option value="deduct">Déduction</option>
              </select>
              <input
                list="tax-adjustments"
                placeholder="Amendes et pénalités, dons au-delà du plafond…"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                style={{ flex: 1 }}
              />
              <datalist id="tax-adjustments">
                <option value="Amendes et pénalités" />
                <option value="Dons et libéralités au-delà du plafond" />
                <option value="Cadeaux et réceptions non justifiés" />
                <option value="Amortissements excédentaires" />
                <option value="Charges sans facture ou payées en espèces au-delà du seuil" />
                <option value="Rémunération de l'exploitant" />
                <option value="Produits déjà imposés (dividendes reçus)" />
              </datalist>
              <input inputMode="numeric" placeholder="Montant" value={amount} onChange={(e) => setAmount(e.target.value)} style={{ width: '9em' }} />
              <button type="submit" disabled={!v || !label.trim()}>
                Ajouter
              </button>
            </form>
            <details>
              <summary>Taux appliqués</summary>
              <div className="filters">
                {a.settings.form === 'company' && rate('isRate', 'Taux normal IS (%)')}
                {a.settings.form === 'company' && rate('reducedRate', 'Taux réduit, CA ≤ 3 milliards (%)')}
                {rate('minimumRate', 'Minimum de perception (%)')}
              </div>
              <p className="muted">
                Taux du Code général des impôts par défaut, hors centimes additionnels communaux (10 % de l'impôt, ajoutés au calcul). L'IRPP des entreprises
                individuelles suit le barème 10 / 15 / 25 / 35 %. Faites valider ces taux par votre comptable.
              </p>
            </details>
          </section>
          <table className="list compact">
            <caption>Acomptes mensuels (minimum de perception)</caption>
            <thead>
              <tr>
                <th>Mois</th>
                <th className="r">CA HT</th>
                <th className="r">Acompte</th>
              </tr>
            </thead>
            <tbody>
              {a.instalments.map((m) => (
                <tr key={m.month}>
                  <td>{new Date(`${m.month}-01T00:00:00`).toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' })}</td>
                  <td className="r">{fcfa(m.turnoverHt)}</td>
                  <td className="r">{fcfa(m.total)}</td>
                </tr>
              ))}
              <tr className="total">
                <td>Total</td>
                <td className="r">{fcfa(a.turnoverHt)}</td>
                <td className="r">{fcfa(a.minimum)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
      {a && (
        <p className="muted">
          L'impôt dû est le plus élevé de l'impôt calculé sur le bénéfice et du minimum de perception. Les acomptes se paient chaque mois avec la TVA ; passez
          leur paiement au débit du compte 441. En fin d'exercice, « Passer l'écriture d'impôt » constate l'impôt dû (débit 891, crédit 441) : le solde du 441
          est alors ce qui reste à payer.
        </p>
      )}
    </>
  );
}

function Treasury({ onOpen }: { onOpen: (account: string) => void }) {
  const [date, setDate] = useState(today());
  const t = useLoad(() => call('accounting.treasury', date), [date]);
  const total = (t.data ?? []).reduce((s, a) => s + a.balance, 0);
  return (
    <>
      <div className="filters">
        <label className="inline">
          Soldes au <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
      </div>
      <div className="kpis">
        {(t.data ?? []).map((a) => (
          <div key={a.account} className={`clickable ${a.balance < 0 ? 'neg' : ''}`} onClick={() => onOpen(a.account)} title="Voir le grand livre">
            <small>
              {a.account} · {a.label}
            </small>
            <strong>{fcfa(a.balance)}</strong>
          </div>
        ))}
        <div>
          <small>Total trésorerie</small>
          <strong>{fcfa(total)}</strong>
        </div>
      </div>
      <p className="muted">
        La caisse (571) regroupe les espèces du magasin, tiroirs et coffre : ventes en espèces nettes de la monnaie rendue, règlements clients en
        espèces et écarts de clôture. Les prélèvements faits pendant la journée passent au compte 585 jusqu'à leur dépôt à la banque, que vous saisissez
        dans Journaux (débit 521, crédit 585). MTN MoMo et Orange Money reçoivent les paiements mobiles des ventes et des clients, moins les paiements
        aux fournisseurs.
      </p>
    </>
  );
}

type BankState = Result<'bank.state'>;
type BankLine = BankState['bankOnly'][number];
type BookLine = BankState['bookOnly'][number];

/** Lit un fichier de relevé : UTF-8, ou Windows-1252 pour les exports Excel des banques. */
async function readStatementFile(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder('windows-1252').decode(buf);
  }
}

/** Rapprochement d'un compte de banque ou de Mobile Money avec son relevé. */
function BankReconciliation() {
  const toast = useToast();
  const accounts = useLoad(() => call('bank.accounts'), []);
  const [account, setAccount] = useState('521');
  const [date, setDate] = useState(today());
  const [statementBalance, setStatementBalance] = useState('');
  const [bankSel, setBankSel] = useState<string | null>(null);
  const [bookSel, setBookSel] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ name: string; parsed: ReturnType<typeof parseStatementCsv> } | null>(null);
  const [adding, setAdding] = useState(false);
  const [booking, setBooking] = useState<BankLine | null>(null);
  const st = useLoad(() => call('bank.state', account, date || undefined), [account, date]);
  const d = st.data;
  const reload = () => {
    setBankSel(null);
    setBookSel(null);
    st.reload();
  };
  const run = (p: Promise<unknown>, ok?: string) =>
    p.then(() => {
      if (ok) toast.ok(ok);
      reload();
    }, toast.error);
  const given = statementBalance.trim() ? parseSigned(statementBalance) : null;
  const gap = d && given !== null ? given - d.expectedBankBalance : null;
  const bank = d ? [...d.lost, ...d.bankOnly] : [];
  const selBank = bank.find((l) => l.id === bankSel);
  const selBook = d?.bookOnly.find((b) => b.key === bookSel);

  return (
    <>
      <div className="filters">
        <select value={account} onChange={(e) => setAccount(e.target.value)}>
          {(accounts.data ?? []).map((a) => (
            <option key={a.id} value={a.id}>
              {a.id} {a.label}
            </option>
          ))}
        </select>
        <label className="inline">
          Au <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
        <label className="button-like" style={{ marginLeft: 'auto' }}>
          Importer un relevé (CSV)
          <input
            type="file"
            accept=".csv,.txt,text/csv"
            hidden
            onChange={async (e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f) setPreview({ name: f.name, parsed: parseStatementCsv(await readStatementFile(f)) });
            }}
          />
        </label>
        <button onClick={() => setAdding(true)}>Ajouter une ligne</button>
        <button
          onClick={() =>
            call('bank.autoMatch', account).then((n) => {
              toast.ok(n ? `${n} opération${n > 1 ? 's' : ''} pointée${n > 1 ? 's' : ''}` : 'Rien à pointer automatiquement');
              reload();
            }, toast.error)
          }
        >
          Pointer automatiquement
        </button>
        <button className="primary" onClick={() => call('bank.print', account, date, given).catch(toast.error)}>
          Imprimer l'état
        </button>
      </div>
      {d && (
        <div className="kpis">
          <div>
            <span>Solde en comptabilité</span>
            <strong>{fcfa(d.bookBalance)}</strong>
          </div>
          <div>
            <span>Le relevé doit afficher</span>
            <strong>{fcfa(d.expectedBankBalance)}</strong>
          </div>
          <div>
            <span>Solde du relevé au {dateFr(d.date)}</span>
            <input inputMode="numeric" placeholder="À recopier du relevé" value={statementBalance} onChange={(e) => setStatementBalance(e.target.value)} />
          </div>
          <div className={gap === null ? '' : gap === 0 ? 'pos' : 'neg'}>
            <span>Écart</span>
            <strong>{gap === null ? '-' : gap === 0 ? 'Juste' : fcfa(gap)}</strong>
          </div>
        </div>
      )}
      {d && (
        <div className="grid2 statements">
          <section>
            <h3>Relevé : pas encore en comptabilité ({bank.length})</h3>
            {bank.length === 0 ? (
              <Empty>Tout le relevé est pointé.</Empty>
            ) : (
              <table className="list compact">
                <tbody>
                  {bank.map((l) => (
                    <tr key={l.id} className={`clickable ${bankSel === l.id ? 'selected' : ''}`} onClick={() => setBankSel(bankSel === l.id ? null : l.id)}>
                      <td className="nowrap">{dateFr(l.op_date)}</td>
                      <td>
                        {l.label}
                        {l.reference && <span className="muted"> · {l.reference}</span>}
                        {d.lost.includes(l) && <span className="tag alerte">écriture modifiée, à repointer</span>}
                      </td>
                      <td className={`r nowrap ${l.amount < 0 ? 'neg' : ''}`}>{fcfa(l.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
          <section>
            <h3>Comptabilité : pas encore sur le relevé ({d.bookOnly.length})</h3>
            {d.bookOnly.length === 0 ? (
              <Empty>Toutes les écritures sont pointées.</Empty>
            ) : (
              <table className="list compact">
                <tbody>
                  {d.bookOnly.map((b) => (
                    <tr key={b.key} className={`clickable ${bookSel === b.key ? 'selected' : ''}`} onClick={() => setBookSel(bookSel === b.key ? null : b.key)}>
                      <td className="nowrap">{dateFr(b.date)}</td>
                      <td>
                        {b.label} <span className="muted">· {b.journal} {b.ref}</span>
                      </td>
                      <td className={`r nowrap ${b.amount < 0 ? 'neg' : ''}`}>{fcfa(b.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </div>
      )}
      {(selBank || selBook) && (
        <div className="actions sticky">
          {selBank && selBook && (
            <button className="primary" disabled={selBank.amount !== selBook.amount} onClick={() => run(call('bank.match', selBank.id, selBook.key), 'Opération pointée')}>
              {selBank.amount === selBook.amount ? 'Pointer ces deux lignes' : 'Montants différents'}
            </button>
          )}
          {selBank && !selBook && (
            <>
              <button className="primary" onClick={() => setBooking(selBank)}>
                Comptabiliser (frais, intérêts…)
              </button>
              <button className="danger" onClick={() => run(call('bank.delete', selBank.id), 'Ligne supprimée')}>
                Supprimer la ligne
              </button>
            </>
          )}
        </div>
      )}
      {d && d.matched.length > 0 && (
        <details>
          <summary>{d.matched.length} opérations pointées</summary>
          <table className="list compact">
            <tbody>
              {d.matched.map((m) => (
                <tr key={m.bank.id}>
                  <td className="nowrap">{dateFr(m.bank.op_date)}</td>
                  <td>{m.bank.label}</td>
                  <td className="muted">
                    {m.book.journal} {m.book.ref} du {dateFr(m.book.date)}
                  </td>
                  <td className="r nowrap">{fcfa(m.bank.amount)}</td>
                  <td>
                    <button className="link" onClick={() => run(call('bank.unmatch', m.bank.id))}>
                      Dépointer
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
      <p className="muted">
        Importez le relevé de la banque ou de MoMo / Orange Money (fichier CSV), puis pointez : chaque opération du relevé avec son écriture. Ce qui reste d'un côté explique
        l'écart entre les deux soldes : chèques pas encore encaissés, frais pas encore comptabilisés… Les à-nouveaux sont considérés comme déjà rapprochés.
      </p>
      {preview && (
        <ImportPreview
          name={preview.name}
          parsed={preview.parsed}
          onClose={() => setPreview(null)}
          onImport={(lines) =>
            call('bank.import', account, lines).then((r) => {
              toast.ok(`${r.added} ligne${r.added > 1 ? 's' : ''} importée${r.added > 1 ? 's' : ''}${r.duplicates ? `, ${r.duplicates} déjà présente${r.duplicates > 1 ? 's' : ''}` : ''}`);
              setPreview(null);
              reload();
            }, toast.error)
          }
        />
      )}
      {adding && (
        <BankLineDialog
          onClose={() => setAdding(false)}
          onSave={(line) =>
            call('bank.import', account, [line]).then(() => {
              setAdding(false);
              reload();
            }, toast.error)
          }
        />
      )}
      {booking && (
        <BookDialog
          line={booking}
          onClose={() => setBooking(null)}
          onSave={(input) =>
            call('bank.book', booking.id, input).then(() => {
              toast.ok('Écriture passée et pointée');
              setBooking(null);
              reload();
            }, toast.error)
          }
        />
      )}
    </>
  );
}

const parseSigned = (v: string) => {
  const neg = v.trim().startsWith('-');
  const n = parseAmount(v.replace('-', ''));
  return n === null ? null : neg ? -n : n;
};

function ImportPreview({
  name,
  parsed,
  onClose,
  onImport,
}: {
  name: string;
  parsed: ReturnType<typeof parseStatementCsv>;
  onClose: () => void;
  onImport: (lines: StatementLine[]) => void;
}) {
  const cols = Object.entries(parsed.columns)
    .map(([k, v]) => `${({ date: 'date', label: 'libellé', reference: 'référence', debit: 'débit', credit: 'crédit', amount: 'montant', fee: 'frais' } as Record<string, string>)[k]} = « ${v} »`)
    .join(', ');
  const total = parsed.lines.reduce((t, l) => t + l.amount, 0);
  return (
    <Modal title={`Importer ${name}`} onClose={onClose} wide>
      {cols && <p className="muted">Colonnes reconnues : {cols}</p>}
      {parsed.skipped.map((sk) => (
        <p key={sk.row} className="neg">
          Ligne {sk.row} ignorée : {sk.reason}
        </p>
      ))}
      {parsed.lines.length === 0 ? (
        <Empty>Aucune opération lisible dans ce fichier.</Empty>
      ) : (
        <table className="list compact">
          <tbody>
            {parsed.lines.slice(0, 200).map((l, i) => (
              <tr key={i}>
                <td className="nowrap">{dateFr(l.date)}</td>
                <td>
                  {l.label}
                  {l.reference && <span className="muted"> · {l.reference}</span>}
                </td>
                <td className={`r nowrap ${l.amount < 0 ? 'neg' : ''}`}>{fcfa(l.amount)}</td>
              </tr>
            ))}
            <tr className="total">
              <td colSpan={2}>{parsed.lines.length} opérations, mouvement net</td>
              <td className="r">{fcfa(total)}</td>
            </tr>
          </tbody>
        </table>
      )}
      <div className="actions">
        <button onClick={onClose}>Annuler</button>
        <button className="primary" disabled={!parsed.lines.length} onClick={() => onImport(parsed.lines)}>
          Importer {parsed.lines.length} opérations
        </button>
      </div>
    </Modal>
  );
}

function BankLineDialog({ onClose, onSave }: { onClose: () => void; onSave: (l: StatementLine) => void }) {
  const [date, setDate] = useState(today());
  const [label, setLabel] = useState('');
  const [reference, setReference] = useState('');
  const [amount, setAmount] = useState('');
  const [out, setOut] = useState(true);
  const v = parseAmount(amount);
  return (
    <Modal title="Ligne du relevé" onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (v) onSave({ date, label, reference: reference || null, amount: out ? -v : v });
        }}
      >
        <div className="methods">
          <button type="button" className={out ? 'active' : ''} onClick={() => setOut(true)}>
            Sortie (débit du relevé)
          </button>
          <button type="button" className={!out ? 'active' : ''} onClick={() => setOut(false)}>
            Entrée (crédit du relevé)
          </button>
        </div>
        <Field label="Date">
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
        </Field>
        <Field label="Libellé">
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Frais de tenue de compte, agios…" required autoFocus />
        </Field>
        <Field label="Référence">
          <input value={reference} onChange={(e) => setReference(e.target.value)} />
        </Field>
        <Field label="Montant (FCFA)">
          <input inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} required />
        </Field>
        <div className="actions">
          <button type="button" onClick={onClose}>
            Annuler
          </button>
          <button type="submit" className="primary" disabled={!v || !label.trim()}>
            Ajouter
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** Passe en comptabilité une opération vue seulement sur le relevé. */
function BookDialog({ line, onClose, onSave }: { line: BankLine; onClose: () => void; onSave: (input: { account: string; label: string }) => void }) {
  const accounts = useLoad(() => call('accounting.accounts'), []);
  const [account, setAccount] = useState(line.amount < 0 ? '631' : '758');
  const [label, setLabel] = useState(line.label);
  const choices = (accounts.data ?? []).filter((a) => /^[4678]/.test(a.id));
  return (
    <Modal title="Comptabiliser l'opération du relevé" onClose={onClose}>
      <p>
        {dateFr(line.op_date)} · {line.label} · <strong className={line.amount < 0 ? 'neg' : ''}>{fcfa(line.amount)}</strong>
      </p>
      <Field label={line.amount < 0 ? 'Compte de charge (débité)' : 'Compte de produit (crédité)'}>
        <select value={account} onChange={(e) => setAccount(e.target.value)}>
          {choices.map((a) => (
            <option key={a.id} value={a.id}>
              {a.id} {a.label}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Libellé de l'écriture">
        <input value={label} onChange={(e) => setLabel(e.target.value)} />
      </Field>
      <div className="actions">
        <button onClick={onClose}>Annuler</button>
        <button className="primary" onClick={() => onSave({ account, label })}>
          Passer l'écriture et pointer
        </button>
      </div>
    </Modal>
  );
}

function Accounts({ user }: { user: User }) {
  const canEdit = ['admin', 'manager', 'accountant'].includes(user.role);
  const [inactive, setInactive] = useState(false);
  const [search, setSearch] = useState('');
  const list = useLoad(() => call('accounting.accounts', inactive), [inactive]);
  const [open, setOpen] = useState<Account | 'new' | null>(null);
  const q = search.toLowerCase();
  const rows = (list.data ?? []).filter((a) => !q || a.id.startsWith(q) || a.label.toLowerCase().includes(q));
  return (
    <>
      <div className="filters">
        <input className="search" placeholder="Numéro ou intitulé" value={search} onChange={(e) => setSearch(e.target.value)} />
        <label>
          <input type="checkbox" checked={inactive} onChange={(e) => setInactive(e.target.checked)} /> Comptes désactivés
        </label>
        {canEdit && (
          <button className="primary" style={{ marginLeft: 'auto' }} onClick={() => setOpen('new')}>
            Nouveau compte
          </button>
        )}
      </div>
      <table className="list compact">
        <thead>
          <tr>
            <th>Compte</th>
            <th>Intitulé</th>
            <th>Utilisé automatiquement pour</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((a) => (
            <tr key={a.id} className={`${canEdit ? 'clickable' : ''} ${a.active ? '' : 'inactive'}`} onClick={() => canEdit && setOpen(a)}>
              <td>{a.id}</td>
              <td>{a.label}</td>
              <td>{a.role ? <span className="tag">{ROLES[a.role]}</span> : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {open && (
        <AccountDialog
          account={open === 'new' ? null : open}
          onClose={() => setOpen(null)}
          onSaved={() => {
            setOpen(null);
            list.reload();
          }}
        />
      )}
    </>
  );
}

function AccountDialog({ account, onClose, onSaved }: { account: Account | null; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [id, setId] = useState(account?.id ?? '');
  const [label, setLabel] = useState(account?.label ?? '');
  const [role, setRole] = useState<string>(account?.role ?? '');
  const [active, setActive] = useState(account ? account.active === 1 : true);
  return (
    <Modal title={account ? `Compte ${account.id}` : 'Nouveau compte'} onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await call('accounting.saveAccount', { id, label, role: (role || null) as Account['role'], active });
            toast.ok('Compte enregistré');
            onSaved();
          } catch (err) {
            toast.error(err);
          }
        }}
      >
        <Field label="Numéro de compte" hint="Plan SYSCOHADA : classe 1 à 9, ex. 5211 pour un deuxième compte bancaire">
          <input autoFocus={!account} value={id} disabled={!!account} onChange={(e) => setId(e.target.value.trim())} required />
        </Field>
        <Field label="Intitulé">
          <input autoFocus={!!account} value={label} onChange={(e) => setLabel(e.target.value)} required />
        </Field>
        <Field
          label="Utilisé automatiquement pour"
          hint={account?.role ? 'Pour changer, choisissez cet usage sur le nouveau compte' : "Un seul compte par usage : le choisir ici le retire de l'ancien compte"}
        >
          <select value={role} disabled={!!account?.role} onChange={(e) => setRole(e.target.value)}>
            <option value="">Aucun usage automatique</option>
            {Object.entries(ROLES).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </Field>
        <label>
          <input type="checkbox" checked={active} disabled={!!account?.role} onChange={(e) => setActive(e.target.checked)} /> Compte actif
        </label>
        <div className="actions">
          <button type="button" onClick={onClose}>
            Annuler
          </button>
          <button type="submit" className="primary">
            Enregistrer
          </button>
        </div>
      </form>
    </Modal>
  );
}
