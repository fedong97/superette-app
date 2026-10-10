import { useEffect, useState } from 'react';
import { type Result, call } from '../api';
import { Empty, Field, Modal, Tabs, dateFr, dateTime, fcfa, has, parseAmount, qty, today, useLoad, useToast } from '../ui';

type User = NonNullable<Result<'app.state'>['user']>;
type Rule = Result<'rebates.rules'>[number];
type State = Result<'rebates.state'>[number];
type Entry = Result<'rebates.entries'>[number];
type RebateCustomer = Result<'rebates.customers'>[number];

export type RebatesTab = 'state' | 'carry' | 'base' | 'clients' | 'entries';

const KIND = { earned: 'Acquise', adjust: 'Régularisation', credit: 'Avoir', cash: 'Espèces' } as const;
const KIND_TAG = { earned: 'normal', adjust: 'alerte', credit: 'info', cash: 'info' } as const;

const firstOfPrevMonth = () => {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
};
const lastOfPrevMonth = () => {
  const d = new Date();
  d.setDate(0);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const pct = (bp: number) => `${(bp / 100).toLocaleString('fr-FR', { maximumFractionDigits: 2 })} %`;

/**
 * Ristournes des clients spécifiques, comme le menu Client › Ristournes &
 * Autres de KONTROL : état, reports à nouveau, réglages de base et des
 * clients, régularisations.
 */
export function Rebates({ user, initialTab = 'state' }: { user: User; initialTab?: RebatesTab }) {
  const [tab, setTab] = useState<RebatesTab>(initialTab);
  useEffect(() => setTab(initialTab), [initialTab]);
  const manage = has(user, 'rebates');
  return (
    <div className="rebates">
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          ['state', 'État des ristournes'],
          ['carry', 'Reports à nouveau'],
          ['base', 'Réglage de base'],
          ['clients', 'Réglage des clients'],
          ['entries', 'Régularisations et bons'],
        ]}
      />
      {tab === 'state' && <RebateState user={user} manage={manage} />}
      {tab === 'carry' && <CarryForward />}
      {tab === 'base' && <BaseRules manage={manage} />}
      {tab === 'clients' && <CustomerRules manage={manage} />}
      {tab === 'entries' && <Entries manage={manage} />}
    </div>
  );
}

// --- État des ristournes -------------------------------------------------------

function RebateState({ user, manage }: { user: User; manage: boolean }) {
  const toast = useToast();
  const [from, setFrom] = useState(firstOfPrevMonth);
  const [to, setTo] = useState(lastOfPrevMonth);
  const [open, setOpen] = useState<State | null>(null);
  const state = useLoad(() => call('rebates.state', from, to), [from, to]);
  const rows = state.data ?? [];
  const sum = (k: 'opening' | 'computed' | 'earned' | 'pending' | 'adjusted' | 'granted' | 'balance') => rows.reduce((t, r) => t + r[k], 0);
  const toClose = rows.filter((r) => r.pending > 0).length;

  const closePeriod = async () => {
    if (!confirm(`Constater la ristourne du ${dateFr(from)} au ${dateFr(to)} pour ${toClose} client(s) ?`)) return;
    try {
      const done = await call('rebates.close', from, to, null);
      toast.ok(`${done.length} ristourne(s) constatée(s) : ${fcfa(done.reduce((t, d) => t + d.amount, 0))}`);
      state.reload();
    } catch (e) {
      toast.error(e);
    }
  };

  return (
    <>
      <div className="filters">
        <Field label="Du">
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        <Field label="Au">
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </Field>
        <button onClick={state.reload}>Actualiser</button>
        {manage && (
          <button className="primary" style={{ marginLeft: 'auto' }} disabled={!toClose} onClick={closePeriod} title="Porte la ristourne calculée au compte de ristourne des clients">
            Constater la période
          </button>
        )}
      </div>
      <div className="kpis">
        <div>
          <small>Report à nouveau</small>
          <strong>{fcfa(sum('opening'))}</strong>
        </div>
        <div>
          <small>Calculée sur la période</small>
          <strong>{fcfa(sum('computed'))}</strong>
        </div>
        <div>
          <small>À constater</small>
          <strong>{fcfa(sum('pending'))}</strong>
        </div>
        <div>
          <small>Reste à accorder aujourd’hui</small>
          <strong>{fcfa(sum('balance'))}</strong>
        </div>
      </div>
      {rows.length === 0 ? (
        <Empty>Aucun client à ristourne. Cochez des clients dans « Réglage des clients ».</Empty>
      ) : (
        <table className="list">
          <thead>
            <tr>
              <th>Code</th>
              <th>Client</th>
              <th className="r">Report</th>
              <th className="r">Calculée</th>
              <th className="r">Constatée</th>
              <th className="r">À constater</th>
              <th className="r">Régularisée</th>
              <th className="r">Accordée</th>
              <th className="r">Reste à accorder</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.customer_id} className="clickable" onClick={() => setOpen(r)}>
                <td>{r.customer_code}</td>
                <td>
                  {r.customer_name}
                  {r.delivered && <small className="muted"> · livré</small>}
                </td>
                <td className="r">{fcfa(r.opening)}</td>
                <td className="r">{fcfa(r.computed)}</td>
                <td className="r">{r.earned ? fcfa(r.earned) : ''}</td>
                <td className="r">{r.pending ? <span className="tag alerte">{fcfa(r.pending)}</span> : ''}</td>
                <td className={`r ${r.adjusted < 0 ? 'neg' : ''}`}>{r.adjusted ? fcfa(r.adjusted) : ''}</td>
                <td className="r">{r.granted ? fcfa(r.granted) : ''}</td>
                <td className="r">
                  <b className={r.balance > 0 ? 'pos' : ''}>{fcfa(r.balance)}</b>
                </td>
              </tr>
            ))}
            <tr className="total">
              <td colSpan={2}>Total</td>
              <td className="r">{fcfa(sum('opening'))}</td>
              <td className="r">{fcfa(sum('computed'))}</td>
              <td className="r">{fcfa(sum('earned'))}</td>
              <td className="r">{fcfa(sum('pending'))}</td>
              <td className="r">{fcfa(sum('adjusted'))}</td>
              <td className="r">{fcfa(sum('granted'))}</td>
              <td className="r">{fcfa(sum('balance'))}</td>
            </tr>
          </tbody>
        </table>
      )}
      {open && (
        <StateDetail
          row={open}
          user={user}
          manage={manage}
          from={from}
          to={to}
          onClose={() => setOpen(null)}
          onChanged={() => {
            setOpen(null);
            state.reload();
          }}
        />
      )}
    </>
  );
}

function StateDetail({ row, user, manage, from, to, onClose, onChanged }: { row: State; user: User; manage: boolean; from: string; to: string; onClose: () => void; onChanged: () => void }) {
  const [granting, setGranting] = useState(false);
  const [adjusting, setAdjusting] = useState(false);
  const due = row.balance;
  return (
    <Modal title={`Ristourne : ${row.customer_name}`} onClose={onClose} wide>
      <p className="muted">
        Achats du {dateFr(from)} au {dateFr(to)}
        {row.delivered ? ', client livré par la superette (frais d’enlèvement déduits)' : ''}.
      </p>
      {row.lines.length === 0 ? (
        <Empty>Pas d’achat donnant droit à ristourne sur la période.</Empty>
      ) : (
        <table className="list compact">
          <thead>
            <tr>
              <th>Famille</th>
              <th>Réglage</th>
              <th className="r">Qté achetée</th>
              <th className="r">Montant TTC</th>
              <th className="r">Taux</th>
              <th className="r">Par unité</th>
              <th className="r">Qté min.</th>
              <th className="r">Enlèvement</th>
              <th className="r">Ristourne</th>
            </tr>
          </thead>
          <tbody>
            {row.lines.map((l) => (
              <tr key={l.family_id ?? '-'}>
                <td>{l.family_name}</td>
                <td>
                  <span className={`tag ${l.rule === 'client' ? 'info' : 'normal'}`}>{l.rule === 'client' ? 'Client' : 'Base'}</span>
                </td>
                <td className="r">{qty(l.qty, 'piece')}</td>
                <td className="r">{fcfa(l.amount)}</td>
                <td className="r">{l.rate_bp ? pct(l.rate_bp) : ''}</td>
                <td className="r">{l.unit_amount ? fcfa(l.unit_amount) : ''}</td>
                <td className={`r ${l.qty < l.min_qty ? 'neg' : ''}`}>{l.min_qty ? qty(l.min_qty, 'piece') : ''}</td>
                <td className="r">{row.delivered && l.pickup_fee ? `−${fcfa(l.pickup_fee)}` : ''}</td>
                <td className="r">
                  <b>{fcfa(l.rebate)}</b>
                </td>
              </tr>
            ))}
            <tr className="total">
              <td colSpan={8}>Ristourne calculée</td>
              <td className="r">{fcfa(row.computed)}</td>
            </tr>
          </tbody>
        </table>
      )}
      <div className="kpis">
        <div>
          <small>Reste à accorder aujourd’hui</small>
          <strong className={due > 0 ? 'pos' : ''}>{fcfa(due)}</strong>
        </div>
      </div>
      {manage && (
        <div className="actions">
          <button onClick={() => setAdjusting(true)}>Régulariser…</button>
          <button className="primary" disabled={due <= 0} onClick={() => setGranting(true)}>
            Accorder la ristourne…
          </button>
        </div>
      )}
      {granting && <GrantDialog user={user} customerId={row.customer_id} customerName={row.customer_name} due={due} onClose={() => setGranting(false)} onDone={onChanged} />}
      {adjusting && <AdjustDialog customerId={row.customer_id} customerName={row.customer_name} onClose={() => setAdjusting(false)} onDone={onChanged} />}
    </Modal>
  );
}

function GrantDialog({ user, customerId, customerName, due, onClose, onDone }: { user: User; customerId: string; customerName: string; due: number; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [amount, setAmount] = useState(String(due));
  const [mode, setMode] = useState<'credit' | 'cash'>('credit');
  const canCash = has(user, 'central_cash');
  return (
    <Modal title={`Accorder la ristourne : ${customerName}`} onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          const n = parseAmount(amount);
          if (!n) return toast.error('Montant invalide');
          try {
            const entry = await call('rebates.grant', customerId, n, mode);
            toast.ok(mode === 'credit' ? 'Avoir porté sur le compte du client' : 'Ristourne payée depuis la caisse centrale');
            await call('rebates.print', entry.id).catch(toast.error);
            onDone();
          } catch (err) {
            toast.error(err);
          }
        }}
      >
        <Field label="Montant (FCFA)" hint={`Reste à accorder : ${fcfa(due)}`}>
          <input autoFocus className="key" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </Field>
        <div className="radio-list">
          <label>
            <input type="radio" checked={mode === 'credit'} onChange={() => setMode('credit')} /> En avoir sur le compte du client (déduit de ce qu’il doit ou utilisable à ses prochains achats « sur compte »)
          </label>
          <label className={canCash ? '' : 'muted'}>
            <input type="radio" disabled={!canCash} checked={mode === 'cash'} onChange={() => setMode('cash')} /> En espèces, depuis la caisse centrale
          </label>
        </div>
        <p className="muted">Un bon de ristourne s’imprime pour la signature du client.</p>
        <div className="actions">
          <button type="button" onClick={onClose}>
            Annuler
          </button>
          <button type="submit" className="primary">
            Accorder et imprimer le bon
          </button>
        </div>
      </form>
    </Modal>
  );
}

function AdjustDialog({ customerId, customerName, onClose, onDone }: { customerId: string | null; customerName?: string; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const customers = useLoad(() => (customerId ? Promise.resolve([]) : call('rebates.customers')), []);
  const [who, setWho] = useState(customerId ?? '');
  const [sign, setSign] = useState<1 | -1>(1);
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  return (
    <Modal title={customerName ? `Régulariser : ${customerName}` : 'Nouvelle régularisation'} onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          const n = parseAmount(amount);
          if (!n || !who) return toast.error('Client ou montant invalide');
          try {
            await call('rebates.adjust', who, sign * n, reason);
            toast.ok('Régularisation enregistrée');
            onDone();
          } catch (err) {
            toast.error(err);
          }
        }}
      >
        {!customerId && (
          <Field label="Client">
            <select value={who} onChange={(e) => setWho(e.target.value)} required>
              <option value="">Choisir…</option>
              {(customers.data ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
        )}
        <div className="grid2">
          <Field label="Sens">
            <select value={sign} onChange={(e) => setSign(Number(e.target.value) as 1 | -1)}>
              <option value={1}>Ajouter à la ristourne</option>
              <option value={-1}>Retirer de la ristourne</option>
            </select>
          </Field>
          <Field label="Montant (FCFA)">
            <input autoFocus className="key" value={amount} onChange={(e) => setAmount(e.target.value)} required />
          </Field>
        </div>
        <Field label="Motif">
          <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Casiers rendus cassés, oubli de la période…" required />
        </Field>
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

// --- Reports à nouveau -----------------------------------------------------------

function CarryForward() {
  const [date, setDate] = useState(today);
  const list = useLoad(() => call('rebates.carryForward', date), [date]);
  const rows = list.data ?? [];
  return (
    <>
      <div className="filters">
        <Field label="Solde au début du">
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
      </div>
      {rows.length === 0 ? (
        <Empty>Aucune ristourne restant à accorder à cette date.</Empty>
      ) : (
        <table className="list">
          <thead>
            <tr>
              <th>Code</th>
              <th>Client</th>
              <th className="r">Report à nouveau</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.customer_id}>
                <td>{r.customer_code}</td>
                <td>{r.customer_name}</td>
                <td className="r">{fcfa(r.balance)}</td>
              </tr>
            ))}
            <tr className="total">
              <td colSpan={2}>Total à reporter</td>
              <td className="r">{fcfa(rows.reduce((t, r) => t + r.balance, 0))}</td>
            </tr>
          </tbody>
        </table>
      )}
    </>
  );
}

// --- Réglages ----------------------------------------------------------------------

interface Draft {
  familyId: string;
  rate: string;
  unitAmount: string;
  minQty: string;
  pickupFee: string;
}

const draftOf = (r: Rule): Draft => ({
  familyId: r.family_id ?? '',
  rate: r.rate_bp ? String(r.rate_bp / 100).replace('.', ',') : '',
  unitAmount: r.unit_amount ? String(r.unit_amount) : '',
  minQty: r.min_qty ? String(r.min_qty / 1000).replace('.', ',') : '',
  pickupFee: r.pickup_fee ? String(r.pickup_fee) : '',
});
const EMPTY: Draft = { familyId: '', rate: '', unitAmount: '', minQty: '', pickupFee: '' };

function num(v: string, scale: number): number | null {
  if (!v.trim()) return 0;
  const n = Number(v.replace(',', '.').replace(/[\s ]/g, ''));
  return Number.isFinite(n) && n >= 0 ? Math.round(n * scale) : null;
}

function RuleEditor({ customerId, manage, intro }: { customerId: string | null; manage: boolean; intro: string }) {
  const toast = useToast();
  const departments = useLoad(() => call('catalogue.departments'), []);
  const rules = useLoad(() => call('rebates.rules', customerId), [customerId]);
  const [rows, setRows] = useState<Draft[]>([]);
  useEffect(() => setRows((rules.data ?? []).map(draftOf)), [rules.data]);
  const families = (departments.data ?? []).flatMap((d) => d.families.map((f) => ({ ...f, dep: d.name })));
  const set = (i: number, patch: Partial<Draft>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const save = async () => {
    const out = [];
    for (const r of rows) {
      const rateBp = num(r.rate, 100);
      const unitAmount = num(r.unitAmount, 1);
      const minQty = num(r.minQty, 1000);
      const pickupFee = num(r.pickupFee, 1);
      if (rateBp === null || unitAmount === null || minQty === null || pickupFee === null) return toast.error('Une valeur est invalide');
      out.push({ familyId: r.familyId || null, rateBp, unitAmount, minQty, pickupFee });
    }
    try {
      await call('rebates.saveRules', customerId, out);
      toast.ok('Réglage enregistré');
      rules.reload();
    } catch (e) {
      toast.error(e);
    }
  };

  return (
    <div className="card">
      <p className="muted">{intro}</p>
      <table className="list compact rebate-rules">
        <thead>
          <tr>
            <th>Famille d’articles</th>
            <th className="r">Taux (%)</th>
            <th className="r">Montant par unité</th>
            <th className="r">Qté minimale</th>
            <th className="r">Frais d’enlèvement / unité</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <td>
                <select disabled={!manage} value={r.familyId} onChange={(e) => set(i, { familyId: e.target.value })}>
                  <option value="">Toutes les familles</option>
                  {families.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.dep} › {f.name}
                    </option>
                  ))}
                </select>
              </td>
              <td className="r">
                <input disabled={!manage} className="key num" value={r.rate} placeholder="0" onChange={(e) => set(i, { rate: e.target.value })} />
              </td>
              <td className="r">
                <input disabled={!manage} className="key num" value={r.unitAmount} placeholder="0" onChange={(e) => set(i, { unitAmount: e.target.value })} />
              </td>
              <td className="r">
                <input disabled={!manage} className="num" value={r.minQty} placeholder="0" onChange={(e) => set(i, { minQty: e.target.value })} />
              </td>
              <td className="r">
                <input disabled={!manage} className="num" value={r.pickupFee} placeholder="0" onChange={(e) => set(i, { pickupFee: e.target.value })} />
              </td>
              <td>
                {manage && (
                  <button className="ghost" title="Retirer la ligne" onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}>
                    ✕
                  </button>
                )}
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={6} className="muted">
                Aucun réglage.
              </td>
            </tr>
          )}
        </tbody>
      </table>
      {manage && (
        <div className="actions">
          <button onClick={() => setRows((rs) => [...rs, EMPTY])}>Ajouter une famille</button>
          <button className="primary" onClick={save}>
            Enregistrer
          </button>
        </div>
      )}
    </div>
  );
}

function BaseRules({ manage }: { manage: boolean }) {
  return (
    <RuleEditor
      customerId={null}
      manage={manage}
      intro="Réglage de base : il vaut pour tous les clients cochés « à ristourne » qui n’ont pas de réglage propre. La ligne « Toutes les familles » s’applique aux familles sans ligne. La ristourne = taux × montant acheté + montant par unité × quantité, à partir de la quantité minimale sur la période, moins les frais d’enlèvement si la superette livre le client."
    />
  );
}

function CustomerRules({ manage }: { manage: boolean }) {
  const toast = useToast();
  const list = useLoad(() => call('rebates.customers'), []);
  const [selected, setSelected] = useState<RebateCustomer | null>(null);
  const [search, setSearch] = useState('');
  const found = useLoad(() => (search.trim().length >= 2 ? call('customers.list', { search }) : Promise.resolve([])), [search]);
  const toggle = async (c: Pick<RebateCustomer, 'id' | 'rebate_enabled' | 'rebate_delivered'>, patch: { enabled?: boolean; delivered?: boolean }) => {
    try {
      await call('rebates.setCustomer', c.id, { enabled: patch.enabled ?? c.rebate_enabled === 1, delivered: patch.delivered ?? c.rebate_delivered === 1 });
      list.reload();
    } catch (e) {
      toast.error(e);
    }
  };
  return (
    <div className="rebate-clients">
      <div>
        {manage && (
          <div className="picker">
            <input className="search" placeholder="Ajouter un client : nom ou code" value={search} onChange={(e) => setSearch(e.target.value)} />
            {(found.data ?? []).length > 0 && (
              <div className="pick-list">
                {(found.data ?? []).slice(0, 8).map((c) => (
                  <button
                    key={c.id}
                    onClick={async () => {
                      await toggle({ id: c.id, rebate_enabled: 0, rebate_delivered: 0 }, { enabled: true });
                      setSearch('');
                    }}
                  >
                    {c.name} <small className="muted">{c.code}</small>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        <table className="list compact">
          <thead>
            <tr>
              <th>Client</th>
              <th>À ristourne</th>
              <th>Livré</th>
              <th>Réglage</th>
            </tr>
          </thead>
          <tbody>
            {(list.data ?? []).map((c) => (
              <tr key={c.id} className={`clickable ${selected?.id === c.id ? 'selected' : ''}`} onClick={() => setSelected(c)}>
                <td>
                  {c.name} <small className="muted">{c.code}</small>
                </td>
                <td>
                  <input type="checkbox" onClick={(e) => e.stopPropagation()} disabled={!manage} checked={c.rebate_enabled === 1} onChange={(e) => toggle(c, { enabled: e.target.checked })} />
                </td>
                <td>
                  <input type="checkbox" onClick={(e) => e.stopPropagation()} disabled={!manage} checked={c.rebate_delivered === 1} onChange={(e) => toggle(c, { delivered: e.target.checked })} title="La superette livre ce client : les frais d’enlèvement sont déduits" />
                </td>
                <td>{c.own_rules ? <span className="tag info">Propre ({c.own_rules})</span> : <span className="tag normal">De base</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {(list.data ?? []).length === 0 && <Empty>Aucun client à ristourne. Ajoutez-en un avec la recherche.</Empty>}
      </div>
      <div>
        {selected ? (
          <>
            <h3 className="section">Réglage propre à {selected.name}</h3>
            <RuleEditor
              customerId={selected.id}
              manage={manage}
              intro="Ces lignes remplacent le réglage de base pour ce client. Sans ligne, le réglage de base s’applique (si le client est coché « à ristourne »)."
            />
          </>
        ) : (
          <Empty>Choisissez un client pour lui donner un réglage propre.</Empty>
        )}
      </div>
    </div>
  );
}

// --- Régularisations et bons ---------------------------------------------------------

function Entries({ manage }: { manage: boolean }) {
  const toast = useToast();
  const [from, setFrom] = useState(firstOfPrevMonth);
  const [to, setTo] = useState(today);
  const [adding, setAdding] = useState(false);
  const list = useLoad(() => call('rebates.entries', { from, to }), [from, to]);
  const rows: Entry[] = list.data ?? [];
  return (
    <>
      <div className="filters">
        <Field label="Du">
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        <Field label="Au">
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </Field>
        {manage && (
          <button className="primary" style={{ marginLeft: 'auto' }} onClick={() => setAdding(true)}>
            Nouvelle régularisation
          </button>
        )}
      </div>
      {rows.length === 0 ? (
        <Empty>Aucune écriture de ristourne sur la période.</Empty>
      ) : (
        <table className="list">
          <thead>
            <tr>
              <th>N°</th>
              <th>Date</th>
              <th>Client</th>
              <th>Nature</th>
              <th>Libellé</th>
              <th className="r">Montant</th>
              <th>Par</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((e) => (
              <tr key={e.id}>
                <td>{e.number}</td>
                <td className="nowrap">{dateTime(e.at)}</td>
                <td>{e.customer_name}</td>
                <td>
                  <span className={`tag ${KIND_TAG[e.kind]}`}>{KIND[e.kind]}</span>
                </td>
                <td>{e.label}</td>
                <td className={`r ${e.kind === 'credit' || e.kind === 'cash' || e.amount < 0 ? 'neg' : 'pos'}`}>
                  {e.kind === 'credit' || e.kind === 'cash' ? '−' : e.amount > 0 ? '+' : ''}
                  {fcfa(e.amount)}
                </td>
                <td>{e.user_name ?? ''}</td>
                <td>
                  <button className="ghost" onClick={() => call('rebates.print', e.id).catch(toast.error)}>
                    Imprimer le bon
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {adding && (
        <AdjustDialog
          customerId={null}
          onClose={() => setAdding(false)}
          onDone={() => {
            setAdding(false);
            list.reload();
          }}
        />
      )}
    </>
  );
}
