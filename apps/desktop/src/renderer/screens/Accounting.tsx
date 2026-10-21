import { Fragment, useState } from 'react';
import { type DateFormat, EXPORT_FIELDS, type ExportField, type ExportFormat, type Separator, type StatementLine, parseStatementCsv } from '@superette/core';
import { type ApiError, type Result, call } from '../api';
import { Empty, Field, Modal, Tabs, askConfirm, dateFr, dateTime, downloadText, fcfa, parseAmount, readTextFile, today, useCan, useLoad, useToast } from '../ui';
import { Disclosures } from './Disclosures';
import { Assets } from './Assets';
import { Analytics, Budgets, CashForecast, ChequeDeposits } from './Planning';
import { AccountPicker } from './accountPicker';
import { ChequeRejections } from './ChequeRejections';
import { hasVat, tx } from '../tax';

type User = NonNullable<Result<'app.state'>['user']>;
type Account = Result<'accounting.accounts'>[number];
type JournalCode = Result<'accounting.entries'>[number]['journal'];
export type AccountingTab = 'journals' | 'ledger' | 'balance' | 'statements' | 'dsf' | 'vat' | 'tax' | 'treasury' | 'bank' | 'accounts' | 'fiscal' | 'assets' | 'forecast' | 'budgets' | 'analytics' | 'cheques' | 'unpaid';
type Entry = Result<'accounting.entries'>[number];
type FiscalYear = Result<'fiscal.list'>[number];

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
  cheques: 'Chèques à encaisser',
};

const monthStart = () => `${today().slice(0, 7)}-01`;
const signed = (v: number) => (v === 0 ? '' : v > 0 ? `${fcfa(v)} D` : `${fcfa(-v)} C`);
const amount = (v: number) => (v ? fcfa(v) : '');

/** Comptabilité SYSCOHADA : écritures tirées des caisses, achats et règlements, plus les saisies manuelles. */
export function Accounting({ user, initialTab = 'journals' }: { user: User; initialTab?: AccountingTab }) {
  const can = useCan();
  const allowed: Record<AccountingTab, boolean> = {
    journals: can('accounting'),
    ledger: can('accounting'),
    balance: can('accounting'),
    statements: can('statements'),
    dsf: can('tax', 'tax_settings'),
    vat: can('vat_return'),
    tax: can('tax', 'tax_settings'),
    treasury: can('accounting'),
    bank: can('bank_reconciliation'),
    accounts: true,
    fiscal: can('accounting', 'fiscal_years'),
    assets: can('fixed_assets'),
    forecast: can('cash_forecast'),
    budgets: can('budgets'),
    analytics: can('analytics'),
    cheques: can('cheque_deposits'),
    unpaid: can('cheque_rejections'),
  };
  const [tab, setTab] = useState<AccountingTab>(allowed[initialTab] ? initialTab : ((Object.keys(allowed) as AccountingTab[]).find((k) => allowed[k]) ?? 'accounts'));
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
        tabs={(
          [
            ['journals', 'Journaux'],
            ['ledger', 'Grand livre'],
            ['balance', 'Balance'],
            ['statements', 'États financiers'],
            ['dsf', 'Notes déclaratives'],
            ['vat', 'Déclaration de TVA'],
            ['tax', 'Impôt sur le résultat'],
            ['treasury', 'Trésorerie'],
            ['bank', 'Rapprochement bancaire'],
            ['cheques', 'Remises de chèques'],
            ['unpaid', 'Chèques impayés'],
            ['forecast', 'Trésorerie prévisionnelle'],
            ['budgets', 'Budgets'],
            ['analytics', 'Analytique'],
            ['assets', 'Immobilisations'],
            ['accounts', 'Plan comptable'],
            ['fiscal', 'Exercices'],
          ] as [AccountingTab, string][]
        ).filter(([k]) => allowed[k] && (k !== 'vat' || hasVat()))}
      />
      {!allowed[tab] && <Empty>Vous n'avez pas accès à cet onglet.</Empty>}
      {tab === 'journals' && allowed.journals && <Journals />}
      {tab === 'ledger' && allowed.ledger && <Ledger account={ledgerAccount} onAccount={setLedgerAccount} />}
      {tab === 'balance' && allowed.balance && <Balance onOpen={openLedger} />}
      {tab === 'statements' && allowed.statements && <Statements onOpen={openLedger} />}
      {tab === 'dsf' && allowed.dsf && <Disclosures />}
      {tab === 'vat' && allowed.vat && hasVat() && <VatReturn />}
      {tab === 'tax' && allowed.tax && <TaxReturn />}
      {tab === 'treasury' && allowed.treasury && <Treasury onOpen={openLedger} />}
      {tab === 'bank' && allowed.bank && <BankReconciliation />}
      {tab === 'accounts' && <Accounts user={user} />}
      {tab === 'fiscal' && allowed.fiscal && <FiscalYears />}
      {tab === 'assets' && allowed.assets && <Assets />}
      {tab === 'forecast' && allowed.forecast && <CashForecast />}
      {tab === 'budgets' && allowed.budgets && <Budgets />}
      {tab === 'analytics' && allowed.analytics && <Analytics />}
      {tab === 'cheques' && allowed.cheques && <ChequeDeposits />}
      {tab === 'unpaid' && allowed.unpaid && <ChequeRejections />}
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

/**
 * Export des écritures pour le logiciel du cabinet comptable, dans son format :
 * format du logiciel du cabinet, ou format décrit une fois.
 */
function EntriesExport({ from, to }: { from: string; to: string }) {
  const toast = useToast();
  const formats = useLoad(() => call('formats.list').then((l) => l.filter((f): f is ExportFormat => f.kind === 'ecritures')));
  const [formatId, setFormatId] = useState(() => {
    try {
      return localStorage.getItem('export.format') ?? 'fedonix';
    } catch {
      return 'fedonix';
    }
  });
  const [editing, setEditing] = useState(false);
  const choose = (id: string) => {
    if (id === 'new') return setEditing(true);
    setFormatId(id);
    try {
      localStorage.setItem('export.format', id);
    } catch {
      // Préférence de confort seulement.
    }
  };
  const current = formats.data?.find((f) => f.id === formatId) ?? formats.data?.[0];
  const run = async () => {
    if (!current) return;
    try {
      const content = await call('accounting.exportFormatted', { from: from || undefined, to: to || undefined }, current.id);
      downloadText(`ecritures_${current.id}_${from}_${to}.${current.separator === '\t' ? 'txt' : 'csv'}`, current.id === 'fedonix' ? `\uFEFF${content}` : content);
    } catch (err) {
      toast.error(err);
    }
  };
  const remove = async () => {
    if (!current || current.builtin || !(await askConfirm(`Supprimer le format « ${current.name} » ?`))) return;
    try {
      await call('formats.delete', current.id);
      choose('fedonix');
      formats.reload();
    } catch (err) {
      toast.error(err);
    }
  };
  return (
    <span className="inline">
      <select value={current?.id ?? ''} onChange={(e) => choose(e.target.value)} title="Format du logiciel du cabinet comptable" style={{ maxWidth: 260 }}>
        {(formats.data ?? []).map((f) => (
          <option key={f.id} value={f.id}>
            {f.name}
          </option>
        ))}
        <option value="new">Nouveau format…</option>
      </select>{' '}
      {current && !current.builtin && <button onClick={() => void remove()}>Supprimer</button>}{' '}
      <button onClick={() => void run()}>Exporter (cabinet comptable)</button>
      {editing && (
        <ExportFormatEditor
          onClose={() => setEditing(false)}
          onSaved={(f) => {
            setEditing(false);
            formats.reload();
            choose(f.id);
          }}
        />
      )}
    </span>
  );
}

const DATE_FORMATS: [DateFormat, string][] = [
  ['dd/mm/yyyy', '31/12/2026'],
  ['ddmmyy', '311226'],
  ['ddmmyyyy', '31122026'],
  ['yyyy-mm-dd', '2026-12-31'],
];

function ExportFormatEditor({ onClose, onSaved }: { onClose: () => void; onSaved: (f: ExportFormat) => void }) {
  const toast = useToast();
  const [f, setF] = useState<ExportFormat>({ id: '', name: '', kind: 'ecritures', separator: ';', dateFormat: 'dd/mm/yyyy', header: true, columns: ['journal', 'date', 'piece', 'account', 'label', 'debit', 'credit'], debitMark: 'D', creditMark: 'C' });
  const toggle = (c: ExportField) => setF({ ...f, columns: f.columns.includes(c) ? f.columns.filter((x) => x !== c) : [...f.columns, c] });
  const move = (i: number, d: -1 | 1) => {
    const cols = [...f.columns];
    const j = i + d;
    if (j < 0 || j >= cols.length) return;
    [cols[i], cols[j]] = [cols[j]!, cols[i]!];
    setF({ ...f, columns: cols });
  };
  const save = async () => {
    try {
      onSaved((await call('formats.save', f)) as ExportFormat);
    } catch (err) {
      toast.error(err);
    }
  };
  return (
    <Modal title="Nouveau format d'export" onClose={onClose}>
      <p className="muted">Reprenez l'ordre des colonnes demandé par le logiciel du cabinet (dans le menu d’import/export de son logiciel).</p>
      <div className="grid2">
        <Field label="Nom du format">
          <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} autoFocus />
        </Field>
        <Field label="Séparateur">
          <select value={f.separator} onChange={(e) => setF({ ...f, separator: e.target.value as Separator })}>
            <option value=";">Point-virgule</option>
            <option value=",">Virgule</option>
            <option value={'\t'}>Tabulation</option>
          </select>
        </Field>
        <Field label="Date">
          <select value={f.dateFormat} onChange={(e) => setF({ ...f, dateFormat: e.target.value as DateFormat })}>
            {DATE_FORMATS.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Sens débit / crédit" hint="Si la colonne Sens est choisie">
          <span className="inline">
            <input value={f.debitMark} onChange={(e) => setF({ ...f, debitMark: e.target.value })} style={{ width: 50 }} /> /{' '}
            <input value={f.creditMark} onChange={(e) => setF({ ...f, creditMark: e.target.value })} style={{ width: 50 }} />
          </span>
        </Field>
      </div>
      <label className="check">
        <input type="checkbox" checked={f.header} onChange={(e) => setF({ ...f, header: e.target.checked })} /> Première ligne avec les noms des colonnes
      </label>
      <h4>Colonnes, dans l'ordre</h4>
      <ol>
        {f.columns.map((c, i) => (
          <li key={c}>
            {EXPORT_FIELDS[c]}{' '}
            <button type="button" onClick={() => move(i, -1)} disabled={i === 0} title="Monter">
              ↑
            </button>
            <button type="button" onClick={() => move(i, 1)} disabled={i === f.columns.length - 1} title="Descendre">
              ↓
            </button>
            <button type="button" onClick={() => toggle(c)} title="Retirer">
              ×
            </button>
          </li>
        ))}
      </ol>
      <p>
        Ajouter :{' '}
        {(Object.keys(EXPORT_FIELDS) as ExportField[])
          .filter((c) => !f.columns.includes(c))
          .map((c) => (
            <button type="button" key={c} onClick={() => toggle(c)} style={{ marginRight: 4 }}>
              {EXPORT_FIELDS[c]}
            </button>
          ))}
      </p>
      <div className="actions">
        <button onClick={onClose}>Annuler</button>
        <button className="primary" disabled={!f.name.trim() || !f.columns.length} onClick={() => void save()}>
          Enregistrer le format
        </button>
      </div>
    </Modal>
  );
}

function Journals() {
  const toast = useToast();
  const can = useCan();
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(today());
  const [journal, setJournal] = useState<JournalCode | ''>('');
  const [adding, setAdding] = useState(false);
  // Écriture saisie à modifier, ou écriture automatique à corriger.
  const [editing, setEditing] = useState<{ entry: Entry; mode: 'edit' | 'correct' } | null>(null);
  const canEdit = can('journal_edit');
  const remove = async (e: Entry) => {
    if (!(await askConfirm(`Supprimer l'écriture ${e.ref} du ${dateFr(e.date)} ?\nElle reste dans le journal d'audit.`))) return;
    try {
      await call('accounting.deleteEntry', e.id!);
      toast.ok(`Écriture ${e.ref} supprimée`);
      list.reload();
    } catch (err) {
      toast.error(err);
    }
  };
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
        {can('accounting_export') && <EntriesExport from={from} to={to} />}
        {can('journal_entry') && (
          <button className="primary" onClick={() => setAdding(true)}>
            Saisir une écriture
          </button>
        )}
      </div>
      {list.error ? (
        <Empty>{String((list.error as Error).message ?? list.error)}</Empty>
      ) : entries.length === 0 ? (
        <Empty>Aucune écriture sur la période. Changez les dates : les ventes sont passées à chaque clôture Z, les achats et dépenses à leur saisie.</Empty>
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
              {canEdit && <th />}
            </tr>
          </thead>
          <tbody>
            {entries.map((e, i) => (
              <Fragment key={`${e.journal}-${e.ref}-${i}`}>
                {e.lines.map((l, j) => (
                  <tr key={j} className={j === 0 ? 'entry-first' : ''}>
                    <td>{j === 0 ? dateFr(e.date) : ''}</td>
                    <td>{j === 0 ? <span className="tag">{e.journal}</span> : ''}</td>
                    <td className="nowrap">
                      {j === 0 ? e.ref : ''}
                      {j === 0 && e.closing && <small className="muted block">clôture</small>}
                      {j === 0 && e.corrects && <small className="muted block">correction de {e.corrects.split('|')[2]}</small>}
                      {j === 0 && e.corrected_by && <small className="warn-text block">corrigée ({e.corrected_by.join(', ')})</small>}
                    </td>
                    <td>{l.account}</td>
                    <td>{l.aux_name ?? l.aux ?? ''}</td>
                    <td>{l.label}</td>
                    <td className="r">{amount(l.debit)}</td>
                    <td className="r">{amount(l.credit)}</td>
                    {canEdit && (
                      <td className="nowrap">
                        {j === 0 && e.source === 'manual' && !e.closing && (
                          <>
                            <button className="link" onClick={() => setEditing({ entry: e, mode: 'edit' })}>
                              Modifier
                            </button>
                            <button className="link danger-text" onClick={() => void remove(e)}>
                              Supprimer
                            </button>
                          </>
                        )}
                        {j === 0 && e.source === 'auto' && (
                          <button className="link" title="Écriture tirée d'une pièce : la correction passe en OD, liée à cette écriture" onClick={() => setEditing({ entry: e, mode: 'correct' })}>
                            Corriger
                          </button>
                        )}
                      </td>
                    )}
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
              {canEdit && <td />}
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
      {editing && (
        <ManualEntryDialog
          entry={editing.entry}
          mode={editing.mode}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
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
function ManualEntryDialog({ entry, mode, onClose, onSaved }: { entry?: Entry; mode?: 'edit' | 'correct'; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const accounts = useLoad(() => call('accounting.accounts'), []);
  const correcting = mode === 'correct' && entry;
  const [journal, setJournal] = useState<JournalCode>(entry && mode === 'edit' ? entry.journal : 'OD');
  const [date, setDate] = useState(entry?.date ?? today());
  const [label, setLabel] = useState(entry ? (correcting ? `Correction de ${entry.journal} ${entry.ref} du ${dateFr(entry.date)}` : entry.label) : '');
  const [lines, setLines] = useState<DraftLine[]>(
    entry
      ? entry.lines.map((l) => ({ account: l.account, aux: l.aux ?? '', label: l.label === entry.label ? '' : l.label, debit: l.debit ? String(l.debit) : '', credit: l.credit ? String(l.credit) : '' }))
      : [emptyLine(), emptyLine()],
  );
  // Ligne dont le compte se choisit dans le plan comptable (📖).
  const [browsing, setBrowsing] = useState<number | null>(null);
  const set = (i: number, patch: Partial<DraftLine>) => setLines(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const num = (v: string) => (v ? (parseAmount(v) ?? NaN) : 0);
  const debit = lines.reduce((t, l) => t + num(l.debit), 0);
  const credit = lines.reduce((t, l) => t + num(l.credit), 0);
  const gap = debit - credit;
  return (
    <Modal title={correcting ? `Corriger l'écriture ${entry.journal} ${entry.ref}` : entry ? `Modifier l'écriture ${entry.ref}` : 'Saisir une écriture'} onClose={onClose} wide>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          const payload = lines
            .filter((l) => l.account)
            .map((l) => ({ account: l.account, aux: l.aux || null, label: l.label || null, debit: num(l.debit), credit: num(l.credit) }));
          try {
            if (correcting) {
              const fix = await call('accounting.correctEntry', `${entry.journal}|${entry.date}|${entry.ref}`, { label, lines: payload });
              toast.ok(`Correction ${fix.ref} enregistrée`);
            } else if (entry?.id) {
              await call('accounting.updateEntry', entry.id, { journal, date, label, lines: payload });
              toast.ok(`Écriture ${entry.ref} modifiée`);
            } else {
              const saved = await call('accounting.addEntry', { journal, date, label, lines: payload });
              toast.ok(`Écriture ${saved.ref} enregistrée`);
            }
            onSaved();
          } catch (err) {
            toast.error(err);
          }
        }}
      >
        {correcting && (
          <p className="muted">
            Cette écriture se calcule à partir de sa pièce : elle ne se réécrit pas. Corrigez les comptes ou les montants ci-dessous ; la différence est enregistrée au
            journal OD, à la même date, comme correction de cette écriture.
          </p>
        )}
        <div className="grid3">
          <Field label="Journal">
            <select value={journal} disabled={Boolean(correcting)} onChange={(e) => setJournal(e.target.value as JournalCode)}>
              {MANUAL_JOURNALS.map((j) => (
                <option key={j} value={j}>
                  {j} · {JOURNALS[j]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Date">
            <input type="date" value={date} disabled={Boolean(correcting)} onChange={(e) => setDate(e.target.value)} required />
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
                <td className="nowrap">
                  <input list="accounts-list" value={l.account} onChange={(e) => set(i, { account: e.target.value.trim() })} style={{ width: 90 }} />
                  <button type="button" className="ghost" title="Choisir dans le plan comptable" onClick={() => setBrowsing(i)}>
                    📖
                  </button>
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
            {correcting ? 'Enregistrer la correction' : "Enregistrer l'écriture"}
          </button>
        </div>
      </form>
      {browsing !== null && (
        <AccountPicker
          value={lines[browsing]?.account}
          onClose={() => setBrowsing(null)}
          onPick={(a) => {
            set(browsing, { account: a.id });
            setBrowsing(null);
            accounts.reload();
          }}
        />
      )}
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
  // Par défaut : depuis le début de l'exercice en cours.
  const current = useLoad(() => call('fiscal.current'), []);
  const [startSet, setStartSet] = useState(false);
  if (!startSet && current.data !== undefined) {
    setStartSet(true);
    if (current.data) setFrom(current.data.start_date);
  }
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
        <Empty>Aucun mouvement sur la période. Changez les dates ou le compte.</Empty>
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
  const can = useCan();
  const thisYear = Number(today().slice(0, 4));
  const [year, setYear] = useState(thisYear);
  const [view, setView] = useState<'sheet' | 'income' | 'flows' | 'notes'>('sheet');
  const from = `${year}-01-01`;
  const to = year === thisYear ? today() : `${year}-12-31`;
  const st = useLoad(() => call('accounting.statements', { from, to }), [from, to]);
  const flows = useLoad(() => call('accounting.cashFlow', { from, to }), [from, to]);
  const notes = useLoad(() => (view === 'notes' ? call('accounting.notes', year) : Promise.resolve(undefined)), [year, view]);
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
          <button className={view === 'notes' ? 'active' : ''} onClick={() => setView('notes')}>
            Notes annexes
          </button>
        </div>
        <button
          style={{ marginLeft: 'auto' }}
          onClick={() => (view === 'notes' ? call('accounting.printNotes', year) : call('accounting.printStatements', from, to)).catch(toast.error)}
        >
          {view === 'notes' ? 'Imprimer les notes (A4)' : 'Imprimer (A4)'}
        </button>
        <button
          disabled={!can('accounting_export')}
          onClick={() =>
            (view === 'notes' ? call('accounting.notesCsv', year) : call('accounting.statementsCsv', { from, to }))
              .then((csv) => downloadText(view === 'notes' ? `notes-annexes-${year}.csv` : `etats-financiers-${year}.csv`, csv))
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
      {d && d.uninvoiced.amount > 0 && (
        <p className="warn-text">
          {fcfa(d.uninvoiced.amount)} HT de marchandises sont entrées en stock sans facture fournisseur. Le stock les compte mais pas les achats : le
          résultat est surévalué d'autant tant que ces factures ne sont pas saisies (Fournisseur › Factures et avoirs fournisseurs). Pour le stock
          de départ, faites passer une écriture d'à-nouveaux par votre comptable.
        </p>
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
      {view === 'notes' && notes.data && (
        <>
          <p className="muted">
            Notes calculées à partir des écritures de l'exercice. Les notes déclaratives (1, 2, 13B, 27B et 35) viennent de l'onglet Notes déclaratives.
          </p>
          {notes.data.notes.map((n) => (
            <details key={n.id} className="note" open={n.id === '3A'}>
              <summary>
                <strong>{n.id === 'RF' ? '' : `Note ${n.id} · `}</strong>
                {n.title}
                {n.declared && <span className="muted"> · déclarée</span>}
                {n.rows.length === 0 && !n.paragraphs?.length && <span className="muted"> · néant</span>}
              </summary>
              {n.rows.length > 0 && (
                <table className="list compact">
                  <thead>
                    <tr>
                      <th />
                      {n.columns.map((c) => (
                        <th key={c} className="r">
                          {c}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {n.rows.map((r, k) => (
                      <tr key={k} className={r.total ? 'total' : ''}>
                        <td>{r.label}</td>
                        {r.values.map((x, j) => (
                          <td key={j} className={`r ${x < 0 ? 'neg' : ''}`}>
                            {x ? (n.units?.[j] === 'number' ? x.toLocaleString('fr-FR') : fcfa(x)) : '-'}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {n.paragraphs?.map((p, k) => (
                <div key={k} className="paragraph">
                  {p.heading && <h4>{p.heading}</h4>}
                  <p>{p.text}</p>
                </div>
              ))}
              {n.comment && <p className="muted">{n.comment}</p>}
            </details>
          ))}
        </>
      )}
      {d && view === 'flows' && (
        <p className="muted">
          Méthode indirecte du SYSCOHADA : on part du résultat net, on retire ce qui ne se paie pas (amortissements, provisions, cessions), puis on suit les variations du
          bilan. Les à-nouveaux de reprise comptent comme trésorerie de départ, pas comme des flux. La ligne ZH doit égaler la trésorerie du bilan.
        </p>
      )}
      {d && (view === 'sheet' || view === 'income') && (
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
  const app = useLoad(() => call('app.state'));
  return (
    <>
      {app.data?.station?.store.vat_enabled === 0 && (
        <p className="tre-warning">Magasin au régime simplifié : les nouvelles pièces sont sans TVA. Ce tableau ne reprend que les pièces faites quand la TVA était active.</p>
      )}
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
              <small>{tx("Chiffre d'affaires HT")}</small>
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
                  <th className="r">{tx('TTC')}</th>
                  <th className="r">{tx('HT')}</th>
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
  const can = useCan();
  const canSet = can('tax_settings');
  const thisYear = Number(today().slice(0, 4));
  const [year, setYear] = useState(thisYear);
  const st = useLoad(() => call('tax.assessment', year), [year]);
  const a = st.data;
  const [kind, setKind] = useState<TaxAdjustment['kind']>('add');
  const [label, setLabel] = useState('');
  const [amount, setAmount] = useState('');
  const save = (input: Parameters<typeof call<'tax.saveSettings'>>[2], ok?: string) =>
    (canSet ? call('tax.saveSettings', year, input) : Promise.reject(new Error("Vous n'avez pas le droit de modifier les paramètres de l'impôt"))).then(() => {
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
          disabled={!canSet || !a || a.provisional || !a.toBook}
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
            <span>{tx("Chiffre d'affaires HT")} {a.provisional ? 'à ce jour' : year}</span>
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
                <th className="r">{tx('CA HT')}</th>
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
              if (f) setPreview({ name: f.name, parsed: parseStatementCsv(await readTextFile(f)) });
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
  const canEdit = user.rights.includes('chart_accounts');
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
          <button data-new title="Ctrl+J" className="primary" style={{ marginLeft: 'auto' }} onClick={() => setOpen('new')}>
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

/**
 * Exercices comptables : ouverture, clôture (à-nouveaux générés au premier jour
 * de l'exercice suivant) et réouverture. Un exercice clôturé n'accepte plus
 * aucune écriture datée dedans.
 */
export function FiscalYears() {
  const toast = useToast();
  const can = useCan();
  const canManage = can('fiscal_years');
  const list = useLoad(() => call('fiscal.list'), []);
  const [form, setForm] = useState<{ id?: string; start: string; end: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try {
      await fn();
      toast.ok(ok);
      list.reload();
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };
  /** Contrôle avant clôture : la clôture se fait depuis sa fenêtre. */
  const [checking, setChecking] = useState<{ fy: FiscalYear; checks: Result<'fiscal.checkClose'> } | null>(null);
  const close = async (f: FiscalYear) => {
    try {
      setChecking({ fy: f, checks: await call('fiscal.checkClose', f.id) });
    } catch (err) {
      toast.error(err);
    }
  };
  const confirmClose = async (f: FiscalYear) => {
    setChecking(null);
    await run(() => call('fiscal.close', f.id), 'Exercice clôturé');
  };
  const reopen = async (f: FiscalYear) => {
    if (!(await askConfirm(`Rouvrir l'exercice du ${dateFr(f.start_date)} au ${dateFr(f.end_date)} ? Ses à-nouveaux sont supprimés ; clôturez-le de nouveau une fois les corrections faites.`))) return;
    await run(() => call('fiscal.reopen', f.id), 'Exercice rouvert');
  };
  const rows = list.data ?? [];
  return (
    <>
      <div className="filters">
        <span className="muted">
          Un exercice dure en général 12 mois (du 1er janvier au 31 décembre). À sa clôture, les soldes passent en à-nouveaux et plus rien ne se saisit dedans.
        </span>
        {canManage && (
          <>
            <button style={{ marginLeft: 'auto' }} disabled={busy} onClick={() => void run(() => call('fiscal.openNext'), 'Exercice suivant ouvert')}>
              Ouvrir l'exercice suivant
            </button>
            <button data-new title="Ctrl+J" className="primary" onClick={() => setForm({ start: '', end: '' })}>
              Nouvel exercice…
            </button>
          </>
        )}
      </div>
      <table className="list">
        <thead>
          <tr>
            <th>Exercice</th>
            <th>Du</th>
            <th>Au</th>
            <th>État</th>
            <th className="r">Résultat reporté</th>
            <th>Clôturé le</th>
            <th>À-nouveaux</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((f, i) => (
            <tr key={f.id}>
              <td className="b">{f.start_date.slice(0, 4) === f.end_date.slice(0, 4) ? f.start_date.slice(0, 4) : `${f.start_date.slice(0, 4)}-${f.end_date.slice(0, 4)}`}</td>
              <td>{dateFr(f.start_date)}</td>
              <td>{dateFr(f.end_date)}</td>
              <td>
                {f.status === 'closed' ? <span className="tag rupture">Clôturé</span> : <span className="tag normal">Ouvert</span>}
                {f.stale && (
                  <small className="warn-text block" title="Une pièce est arrivée (d'un autre PC) après la clôture">
                    soldes changés depuis la clôture : rouvrez puis clôturez de nouveau
                  </small>
                )}
              </td>
              <td className={`r ${f.result !== null && f.result < 0 ? 'neg' : ''}`}>{f.result === null ? '' : `${fcfa(f.result)} ${f.result >= 0 ? '(bénéfice)' : '(perte)'}`}</td>
              <td>{f.closed_at ? `${dateTime(f.closed_at)}${f.closed_by_name ? ` par ${f.closed_by_name}` : ''}` : ''}</td>
              <td>{f.closing_ref ?? ''}</td>
              <td className="nowrap">
                {canManage && f.status === 'open' && (
                  <>
                    <button className="link" disabled={busy} onClick={() => void close(f)}>
                      Clôturer
                    </button>
                    <button className="link" onClick={() => setForm({ id: f.id, start: f.start_date, end: f.end_date })}>
                      Dates
                    </button>
                    {i === 0 && rows.length > 1 && (
                      <button
                        className="link danger-text"
                        onClick={async () => {
                          if (await askConfirm(`Supprimer l'exercice du ${dateFr(f.start_date)} au ${dateFr(f.end_date)} ? Les écritures ne sont pas touchées.`))
                            void run(() => call('fiscal.remove', f.id), 'Exercice supprimé');
                        }}
                      >
                        Supprimer
                      </button>
                    )}
                  </>
                )}
                {canManage && f.status === 'closed' && (
                  <button className="link" disabled={busy} onClick={() => void reopen(f)}>
                    Rouvrir
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!canManage && <p className="muted">Le droit « Ouvrir, clôturer et rouvrir un exercice comptable » permet de gérer les exercices.</p>}
      {form && (
        <Modal title={form.id ? "Dates de l'exercice" : 'Nouvel exercice'} onClose={() => setForm(null)}>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                if (form.id) await call('fiscal.setDates', form.id, { start: form.start, end: form.end });
                else await call('fiscal.open', { start: form.start, end: form.end });
                toast.ok('Exercice enregistré');
                setForm(null);
                list.reload();
              } catch (err) {
                toast.error(err);
              }
            }}
          >
            <div className="grid2">
              <Field label="Premier jour">
                <input type="date" value={form.start} disabled={Boolean(form.id)} onChange={(e) => setForm({ ...form, start: e.target.value, end: form.end || lastDayOfYear(e.target.value) })} required />
              </Field>
              <Field label="Dernier jour" hint="18 mois au plus (premier exercice plus long)">
                <input type="date" value={form.end} onChange={(e) => setForm({ ...form, end: e.target.value })} required />
              </Field>
            </div>
            <div className="actions">
              <button type="button" onClick={() => setForm(null)}>
                Annuler
              </button>
              <button type="submit" className="primary">
                Enregistrer
              </button>
            </div>
          </form>
        </Modal>
      )}
      {checking && <CloseCheck fy={checking.fy} checks={checking.checks} onClose={() => setChecking(null)} onConfirm={() => void confirmClose(checking.fy)} />}
    </>
  );
}

const CHECK_MARKS = { ok: '✓', warning: '!', blocking: '✗' } as const;

function CloseCheck({ fy, checks, onClose, onConfirm }: { fy: FiscalYear; checks: Result<'fiscal.checkClose'>; onClose: () => void; onConfirm: () => void }) {
  const blocking = checks.filter((c) => c.status === 'blocking');
  const warnings = checks.filter((c) => c.status === 'warning');
  return (
    <Modal title={`Contrôle avant clôture : exercice du ${dateFr(fy.start_date)} au ${dateFr(fy.end_date)}`} onClose={onClose} wide>
      <table className="list">
        <tbody>
          {checks.map((c) => (
            <tr key={c.key}>
              <td className={c.status === 'ok' ? 'ok' : c.status === 'warning' ? 'warn' : 'error'} style={{ width: 24, fontWeight: 700 }}>
                {CHECK_MARKS[c.status]}
              </td>
              <td>
                <strong>{c.label}</strong>
                <div className="muted">{c.detail}</div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {blocking.length ? (
        <p className="error">Corrigez d'abord ce qui est marqué ✗ : la clôture est impossible tant qu'il reste {blocking.length > 1 ? 'ces points' : 'ce point'}.</p>
      ) : (
        <p>
          Les à-nouveaux (comptes de bilan, stock, clients, fournisseurs et résultat en report à nouveau) seront générés au {dateFr(nextDay(fy.end_date))}. Ensuite, plus aucune écriture ne peut être datée
          dans cet exercice, sauf à le rouvrir. Pensez à passer l'impôt sur le résultat avant de clôturer.
          {warnings.length > 0 && ' Les points marqués ! ne bloquent pas : vérifiez-les si besoin.'}
        </p>
      )}
      <div className="actions">
        <button onClick={onClose}>Annuler</button>
        <button className="primary" disabled={blocking.length > 0} onClick={onConfirm}>
          Clôturer l'exercice
        </button>
      </div>
    </Modal>
  );
}

const nextDay = (d: string) => new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
/** Veille du même jour l'année suivante : fin d'un exercice de 12 mois. */
const lastDayOfYear = (start: string) => (start ? new Date(Date.parse(`${Number(start.slice(0, 4)) + 1}${start.slice(4)}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10) : '');
