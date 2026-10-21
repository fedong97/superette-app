import { useEffect, useState } from 'react';
import { computePayroll } from '@superette/core';
import { type Result, call } from '../api';
import { Leaves, WeekPlanning } from './StaffTime';
import { askConfirm, askText, Empty, Field, Modal, Tabs, dateFr, dateTime, fcfa, has, parseAmount, today, useLoad, useStoreSettings, useToast } from '../ui';

type User = NonNullable<Result<'app.state'>['user']>;
type StaffRow = Result<'staff.list'>[number];
type MonthRow = Result<'staff.month'>[number];
export type StaffTab = 'list' | 'salaries' | 'targets' | 'attendance' | 'statement' | 'leaves' | 'planning';

const OFFICE_METHODS = { CASH: 'Espèces (caisse centrale)', MTN_MOMO: 'MTN MoMo (caisse électronique centrale)', ORANGE_MONEY: 'Orange Money (caisse électronique centrale)', BANK_TRANSFER: 'Virement', CHEQUE: 'Chèque' } as const;
type OfficeMethod = keyof typeof OFFICE_METHODS;
const periodFr = (p: string) => new Date(`${p}-15T12:00:00`).toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });

/**
 * Collaborateurs (employés, livreurs…) : fiche, sous-comptes de tiers (4211…,
 * 4251…), extrait de compte, salaires du mois et avances.
 */
export function Staff({ user, initialTab = 'list' }: { user: User; initialTab?: StaffTab }) {
  const pay = has(user, 'staff_salaries');
  const targets = has(user, 'staff_targets');
  const attendance = has(user, 'staff_attendance');
  const leaves = has(user, 'staff_leaves');
  const [tab, setTab] = useState<StaffTab>(
    (initialTab === 'salaries' && !pay) ||
      (initialTab === 'targets' && !targets) ||
      (initialTab === 'attendance' && !attendance) ||
      ((initialTab === 'leaves' || initialTab === 'planning') && !leaves)
      ? 'list'
      : initialTab,
  );
  const [shown, setShown] = useState<string | null>(null);
  return (
    <div className="page">
      <header className="page-head">
        <h1>Collaborateurs et salaires</h1>
      </header>
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          ['list', 'Collaborateurs'],
          ...(pay ? ([['salaries', 'Salaires du mois']] as [StaffTab, string][]) : []),
          ...(targets ? ([['targets', 'Objectifs et commissions']] as [StaffTab, string][]) : []),
          ...(attendance ? ([['attendance', 'Pointage']] as [StaffTab, string][]) : []),
          ...(leaves
            ? ([
                ['leaves', 'Congés'],
                ['planning', 'Planning'],
              ] as [StaffTab, string][])
            : []),
          ['statement', 'Extrait de compte'],
        ]}
      />
      {tab === 'list' && (
        <StaffList
          user={user}
          onStatement={(id) => {
            setShown(id);
            setTab('statement');
          }}
        />
      )}
      {tab === 'salaries' && pay && <Salaries />}
      {tab === 'targets' && targets && <Targets />}
      {tab === 'attendance' && attendance && <AttendanceMonth />}
      {tab === 'leaves' && leaves && <Leaves />}
      {tab === 'planning' && leaves && <WeekPlanning />}
      {tab === 'statement' && <Statement initial={shown} />}
    </div>
  );
}

function StaffList({ user, onStatement }: { user: User; onStatement: (id: string) => void }) {
  const toast = useToast();
  const [inactive, setInactive] = useState(false);
  const list = useLoad(() => call('staff.list', inactive), [inactive]);
  const [edit, setEdit] = useState<StaffRow | 'new' | null>(null);
  const [paying, setPaying] = useState<StaffRow | null>(null);
  const rows = list.data ?? [];
  const canEdit = has(user, 'staff_edit');
  const canPay = has(user, 'staff_salaries');
  return (
    <>
      <div className="toolbar">
        {canEdit && (
          <button data-new title="Ctrl+J" className="primary" onClick={() => setEdit('new')}>
            Nouveau collaborateur…
          </button>
        )}
        <label className="check">
          <input type="checkbox" checked={inactive} onChange={(e) => setInactive(e.target.checked)} /> Voir aussi ceux qui sont partis
        </label>
      </div>
      <div className="staff-cards">
        <div>
          <small>Collaborateurs</small>
          <b>{rows.filter((r) => r.active).length}</b>
        </div>
        <div>
          <small>Masse salariale de base</small>
          <b>{fcfa(rows.filter((r) => r.active).reduce((t, r) => t + r.base_salary, 0))}</b>
        </div>
        <div>
          <small>Salaires dus</small>
          <b>{fcfa(rows.reduce((t, r) => t + r.due, 0))}</b>
        </div>
        <div>
          <small>Avances à rembourser</small>
          <b>{fcfa(rows.reduce((t, r) => t + r.advances, 0))}</b>
        </div>
      </div>
      {rows.length ? (
        <table className="list">
          <thead>
            <tr>
              <th>Matricule</th>
              <th>Nom</th>
              <th>Poste</th>
              <th>Téléphone</th>
              <th className="r">Salaire de base</th>
              <th>Rattachement</th>
              <th>Comptes</th>
              <th className="r">Salaire dû</th>
              <th className="r">Avances</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className={r.active ? '' : 'muted'} onDoubleClick={() => canEdit && setEdit(r)}>
                <td>{r.code}</td>
                <td>
                  <b>{r.name}</b>
                  {r.user_name && <small className="muted"> · utilisateur {r.user_name}</small>}
                  {!r.active && <span className="tag">Parti</span>}
                </td>
                <td>{r.position ?? ''}</td>
                <td>{r.phone ?? ''}</td>
                <td className="r">{fcfa(r.base_salary)}</td>
                <td>{r.parent_label ?? r.parent_account}</td>
                <td className="muted">
                  {r.salary_account} · {r.advance_account}
                </td>
                <td className="r">{r.due ? fcfa(r.due) : ''}</td>
                <td className={`r ${r.advances > 0 ? 'neg' : ''}`}>{r.advances ? fcfa(r.advances) : ''}</td>
                <td className="nowrap">
                  {canEdit && (
                    <button className="link" onClick={() => setEdit(r)}>
                      Modifier
                    </button>
                  )}
                  <button className="link" onClick={() => onStatement(r.id)}>
                    Extrait
                  </button>
                  {canPay && r.active && (
                    <button className="link" onClick={() => setPaying(r)}>
                      Avance…
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <Empty action={canEdit ? { label: 'Nouveau collaborateur…', onClick: () => setEdit('new') } : undefined}>
          Aucun collaborateur. Ajoutez vos employés : chacun reçoit ses sous-comptes en comptabilité pour régler ses salaires et ses avances.
        </Empty>
      )}
      {edit && (
        <StaffDialog
          staff={edit === 'new' ? null : edit}
          onClose={() => setEdit(null)}
          onDone={() => {
            setEdit(null);
            list.reload();
          }}
        />
      )}
      {paying && (
        <OfficePayDialog
          kind="staff_advance"
          staff={paying}
          onClose={() => setPaying(null)}
          onDone={() => {
            setPaying(null);
            list.reload();
            toast.ok('Avance enregistrée');
          }}
        />
      )}
    </>
  );
}

function StaffDialog({ staff, onClose, onDone }: { staff: StaffRow | null; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const users = useLoad(() => call('staff.users'), []);
  const parents = useLoad(() => call('staff.parents'), []);
  const [f, setF] = useState({
    parentAccount: staff?.parent_account ?? '4211',
    name: staff?.name ?? '',
    position: staff?.position ?? '',
    phone: staff?.phone ?? '',
    idCard: staff?.id_card ?? '',
    baseSalary: staff ? String(staff.base_salary) : '',
    hiredOn: staff?.hired_on ?? '',
    userId: staff?.user_id ?? '',
    active: staff ? staff.active === 1 : true,
    declared: staff ? staff.declared === 1 : true,
    cnpsNumber: staff?.cnps_number ?? '',
    notes: staff?.notes ?? '',
  });
  const payroll = useStoreSettings().payroll;
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <Modal title={staff ? `Collaborateur ${staff.code}` : 'Nouveau collaborateur'} onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await call(
              'staff.save',
              {
                name: f.name,
                position: f.position || null,
                phone: f.phone || null,
                idCard: f.idCard || null,
                baseSalary: parseAmount(f.baseSalary) ?? 0,
                hiredOn: f.hiredOn || null,
                userId: f.userId || null,
                parentAccount: f.parentAccount,
                active: f.active,
                declared: f.declared,
                cnpsNumber: f.cnpsNumber || null,
                notes: f.notes || null,
              },
              staff?.id ?? null,
            );
            toast.ok(staff ? 'Fiche enregistrée' : 'Collaborateur ajouté, avec ses sous-comptes');
            onDone();
          } catch (err) {
            toast.error(err);
          }
        }}
      >
        <div className="desk-head two">
          <Field label="Nom et prénom">
            <input autoFocus value={f.name} onChange={set('name')} />
          </Field>
          <Field label="Poste">
            <input value={f.position} onChange={set('position')} placeholder="Caissière, magasinier, livreur…" />
          </Field>
          <Field label="Téléphone">
            <input value={f.phone} onChange={set('phone')} />
          </Field>
          <Field label="N° CNI">
            <input value={f.idCard} onChange={set('idCard')} />
          </Field>
          <Field label="Salaire de base mensuel (FCFA)">
            <input inputMode="numeric" className="r" value={f.baseSalary} onChange={set('baseSalary')} />
          </Field>
          <Field label="Date d'entrée">
            <input type="date" value={f.hiredOn} onChange={set('hiredOn')} />
          </Field>
          <Field label="Compte utilisateur (facultatif)" hint="Pour un caissier ou un gérant qui se connecte au logiciel.">
            <select value={f.userId} onChange={set('userId')}>
              <option value="">Aucun</option>
              {(users.data ?? []).map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Notes">
            <input value={f.notes} onChange={set('notes')} />
          </Field>
          <Field label="N° d'immatriculation CNPS">
            <input value={f.cnpsNumber} onChange={set('cnpsNumber')} />
          </Field>
          <Field label="Retenues légales" hint={payroll.enabled ? 'CNPS, IRPP, CAC, CFC, RAV et TDL retenus sur ses salaires' : 'La paie avec retenues s’active dans Administration › Paramètres'}>
            <label className="check">
              <input type="checkbox" checked={f.declared} onChange={(e) => setF({ ...f, declared: e.target.checked })} /> Déclaré à la CNPS et aux impôts
            </label>
          </Field>
          <Field label="Compte de rattachement" hint="Son sous-compte est créé sous ce compte : salaires constatés, paiements et extrait passent par lui">
            <select value={f.parentAccount} onChange={set('parentAccount')}>
              <optgroup label="Proposés">
                {(parents.data ?? [])
                  .filter((p) => p.suggested)
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.id} · {p.label}
                    </option>
                  ))}
              </optgroup>
              <optgroup label="Autre compte de tiers (classe 4)">
                {(parents.data ?? [])
                  .filter((p) => !p.suggested)
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.id} · {p.label}
                    </option>
                  ))}
              </optgroup>
            </select>
          </Field>
        </div>
        {staff && (
          <>
            <p className="muted">
              Sous-comptes : {staff.salary_account} ({staff.parent_label ?? 'rattachement'}) et {staff.advance_account} (avances).
              {f.parentAccount !== staff.parent_account && ' Changer le rattachement crée un nouveau sous-compte ; refusé si le collaborateur a déjà des écritures.'}
            </p>
            <label className="check">
              <input type="checkbox" checked={!f.active} onChange={(e) => setF({ ...f, active: !e.target.checked })} /> A quitté le magasin
            </label>
          </>
        )}
        {!staff && <p className="muted">Ses sous-comptes {f.parentAccount}… (compte de rattachement) et 4251… (avances) sont créés à son nom dans le plan comptable.</p>}
        <div className="actions">
          <button type="button" onClick={onClose}>
            Annuler
          </button>
          <button type="submit" className="primary" disabled={!f.name.trim()}>
            Enregistrer
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** Salaire, avance ou remboursement réglé au bureau : caisse centrale, MoMo/OM ou banque. */
function OfficePayDialog({
  kind,
  staff,
  salary,
  onClose,
  onDone,
}: {
  kind: 'staff_salary' | 'staff_advance';
  staff: { id: string; name: string };
  salary?: { id: string; rest: number; period: string };
  onClose: () => void;
  onDone: () => void;
}) {
  const toast = useToast();
  const [amount, setAmount] = useState(salary ? String(salary.rest) : '');
  const [method, setMethod] = useState<OfficeMethod>('CASH');
  const [reference, setReference] = useState('');
  const [piece, setPiece] = useState('');
  const value = parseAmount(amount) ?? 0;
  return (
    <Modal title={kind === 'staff_salary' ? `Payer le salaire de ${periodFr(salary!.period)}, ${staff.name}` : `Avance à ${staff.name}`} onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            const r = await call('staff.pay', { kind, staffId: staff.id, salaryId: salary?.id ?? null, amount: value, method, reference: reference || null, piece: piece || null });
            if (await askConfirm('Imprimer le bon ?')) call('staff.printEntry', r.id).catch(toast.error);
            onDone();
          } catch (err) {
            toast.error(err);
          }
        }}
      >
        <p className="muted">À la caisse, on passe par Opérations de trésorerie › Décaisser › Remboursement / Prêt.</p>
        <Field label="Montant (FCFA)" hint={salary ? `Reste à payer : ${fcfa(salary.rest)}` : undefined}>
          <input autoFocus inputMode="numeric" className="r" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </Field>
        <Field label="Payé par">
          <select value={method} onChange={(e) => setMethod(e.target.value as OfficeMethod)}>
            {(Object.keys(OFFICE_METHODS) as OfficeMethod[]).map((m) => (
              <option key={m} value={m}>
                {OFFICE_METHODS[m]}
              </option>
            ))}
          </select>
        </Field>
        {method !== 'CASH' && (
          <Field label="Référence (transaction, virement, chèque)">
            <input value={reference} onChange={(e) => setReference(e.target.value)} />
          </Field>
        )}
        <Field label="N° de pièce (facultatif)">
          <input value={piece} onChange={(e) => setPiece(e.target.value)} />
        </Field>
        <div className="actions">
          <button type="button" onClick={onClose}>
            Annuler
          </button>
          <button type="submit" className="primary" disabled={!value || (method !== 'CASH' && !reference.trim())}>
            Payer
          </button>
        </div>
      </form>
    </Modal>
  );
}

const lastMonth = () => {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};

/** Salaires du mois : brut et avances retenues par collaborateur, puis paiement et bulletin. */
function Salaries() {
  const toast = useToast();
  const [period, setPeriod] = useState(today().slice(0, 7));
  const month = useLoad(() => call('staff.month', period), [period]);
  // Commission du mois sur les ventes (Objectifs et commissions), ajoutée au salaire de base.
  const commissions = useLoad(() => call('staff.commissions', period), [period]);
  const [lines, setLines] = useState<Record<string, { gross: string; deducted: string }>>({});
  const [paying, setPaying] = useState<MonthRow | null>(null);
  const rules = useStoreSettings().payroll;
  const decl = useLoad(() => call('staff.declarations', period), [period, month.data]);
  const rows = month.data ?? [];
  /** Retenues légales prévues pour un brut saisi, comme les calculera l'enregistrement. */
  const legalFor = (r: MonthRow, gross: number) => {
    if (!rules.enabled || !r.staff.declared) return 0;
    const p = computePayroll(gross, rules);
    return p.employeeCnps + p.employeeTax;
  };
  useEffect(() => {
    setLines(
      Object.fromEntries(
        rows
          .filter((r) => !r.salary)
          .map((r) => {
            const gross = r.staff.base_salary + (commissions.data?.[r.staff.id] ?? 0);
            return [r.staff.id, { gross: String(gross || ''), deducted: String(Math.min(Math.max(0, r.staff.advances), gross - legalFor(r, gross)) || '') }];
          }),
      ),
    );
  }, [month.data, commissions.data]);
  const todo = rows.filter((r) => !r.salary);
  const amount = (v?: string) => parseAmount(v ?? '') ?? 0;
  return (
    <>
      <div className="toolbar">
        <Field label="Mois">
          <input type="month" value={period} max={today().slice(0, 7)} onChange={(e) => setPeriod(e.target.value || lastMonth())} />
        </Field>
        <span className="spacer" />
        {todo.length > 0 && (
          <button
            className="primary"
            onClick={async () => {
              try {
                const done = await call(
                  'staff.recordSalaries',
                  period,
                  todo.map((r) => {
                    const gross = amount(lines[r.staff.id]?.gross);
                    return { staffId: r.staff.id, gross, deducted: amount(lines[r.staff.id]?.deducted), commission: Math.min(gross, commissions.data?.[r.staff.id] ?? 0) };
                  }),
                );
                toast.ok(`${done.length} salaire(s) de ${periodFr(period)} constaté(s)`);
                month.reload();
              } catch (err) {
                toast.error(err);
              }
            }}
          >
            Constater les salaires de {periodFr(period)}
          </button>
        )}
      </div>
      <p className="muted">
        Constater un salaire le passe en charge (661) et au sous-compte du collaborateur. Les avances retenues soldent son compte d’avances. Le net se paie ici (bureau) ou à la caisse avec « Décaisser ».{' '}
        {rules.enabled
          ? 'Les retenues CNPS, IRPP, CAC, CFC, RAV et TDL sont calculées sur le brut des collaborateurs déclarés, avec la part patronale.'
          : 'Retenues légales non activées : saisissez le salaire net, ou activez la paie dans Administration › Paramètres.'}
      </p>
      {decl.data && decl.data.rows.length > 0 && (
        <div className="staff-cards">
          <div>
            <small>Masse salariale brute (déclarés)</small>
            <b>{fcfa(decl.data.gross)}</b>
          </div>
          <div>
            <small>À verser à la CNPS (4311)</small>
            <b>{fcfa(decl.data.cnps)}</b>
          </div>
          <div>
            <small>À verser aux impôts (4471)</small>
            <b>{fcfa(decl.data.state)}</b>
          </div>
          <div>
            <small>Se paie par Décaisser, compte 4311 ou 4471</small>
            <button onClick={() => call('staff.printDeclarations', period).catch(toast.error)}>Imprimer l’état du mois</button>
          </div>
        </div>
      )}
      {rows.length ? (
        <table className="list">
          <thead>
            <tr>
              <th>Collaborateur</th>
              <th className="r">Salaire de base</th>
              <th className="r">Avances à rembourser</th>
              <th className="r">Commission</th>
              <th className="r">Brut du mois</th>
              <th className="r">Retenues légales</th>
              <th className="r">Avances retenues</th>
              <th className="r">Net à payer</th>
              <th className="r">Payé</th>
              <th className="r">Reste</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const l = lines[r.staff.id];
              const x = r.salary;
              return (
                <tr key={r.staff.id}>
                  <td>
                    <b>{r.staff.name}</b>
                    {r.staff.position ? <small className="muted"> · {r.staff.position}</small> : null}
                    {x && <small className="muted"> · {x.number}</small>}
                  </td>
                  <td className="r">{fcfa(r.staff.base_salary)}</td>
                  <td className="r">{r.staff.advances > 0 ? fcfa(r.staff.advances) : ''}</td>
                  <td className="r">{x ? (x.commission ? fcfa(x.commission) : '') : commissions.data?.[r.staff.id] ? fcfa(commissions.data[r.staff.id]!) : ''}</td>
                  <td className="r">
                    {x ? (
                      fcfa(x.gross)
                    ) : (
                      <input className="r narrow" inputMode="numeric" value={l?.gross ?? ''} onChange={(e) => setLines({ ...lines, [r.staff.id]: { ...l!, gross: e.target.value } })} />
                    )}
                  </td>
                  <td className="r">{x ? (x.cnps + x.tax ? fcfa(x.cnps + x.tax) : '') : legalFor(r, amount(l?.gross)) ? fcfa(legalFor(r, amount(l?.gross))) : ''}</td>
                  <td className="r">
                    {x ? (
                      x.deducted ? fcfa(x.deducted) : ''
                    ) : (
                      <input
                        className="r narrow"
                        inputMode="numeric"
                        disabled={r.staff.advances <= 0}
                        value={l?.deducted ?? ''}
                        onChange={(e) => setLines({ ...lines, [r.staff.id]: { ...l!, deducted: e.target.value } })}
                      />
                    )}
                  </td>
                  <td className="r">
                    <b>{fcfa(x ? x.net : amount(l?.gross) - legalFor(r, amount(l?.gross)) - amount(l?.deducted))}</b>
                  </td>
                  <td className="r">{x ? fcfa(x.paid) : ''}</td>
                  <td className={`r ${x && x.rest > 0 ? 'neg' : ''}`}>{x ? fcfa(x.rest) : <span className="muted">à constater</span>}</td>
                  <td className="nowrap">
                    {x && x.rest > 0 && (
                      <button className="link" onClick={() => setPaying(r)}>
                        Payer…
                      </button>
                    )}
                    {x && (
                      <button className="link" onClick={() => call('staff.printSlip', x.id).catch(toast.error)}>
                        Bulletin
                      </button>
                    )}
                    {x && x.paid === 0 && (
                      <button
                        className="link danger"
                        onClick={async () => {
                          const reason = await askText('Motif de l’annulation de ce salaire ?');
                          if (!reason) return;
                          try {
                            await call('staff.cancelSalary', x.id, reason);
                            month.reload();
                          } catch (err) {
                            toast.error(err);
                          }
                        }}
                      >
                        Annuler
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : (
        <Empty>Aucun collaborateur actif. Ajoutez-les dans l’onglet Collaborateurs.</Empty>
      )}
      {paying?.salary && (
        <OfficePayDialog
          kind="staff_salary"
          staff={paying.staff}
          salary={paying.salary}
          onClose={() => setPaying(null)}
          onDone={() => {
            setPaying(null);
            month.reload();
            toast.ok('Salaire payé');
          }}
        />
      )}
    </>
  );
}

/** Extrait de compte d'un collaborateur : ce qu'on lui doit et ce qu'il doit. */
function Statement({ initial }: { initial: string | null }) {
  const toast = useToast();
  const list = useLoad(() => call('staff.list', true), []);
  const [id, setId] = useState<string | null>(initial);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const shown = id ?? list.data?.[0]?.id ?? null;
  const st = useLoad(() => (shown ? call('staff.statement', shown, from || null, to || null) : Promise.resolve(null)), [shown, from, to]);
  const d = st.data;
  return (
    <>
      <div className="toolbar">
        <Field label="Collaborateur">
          <select value={shown ?? ''} onChange={(e) => setId(e.target.value)}>
            {(list.data ?? []).map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
                {x.active ? '' : ' (parti)'}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Du">
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        <Field label="Au">
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </Field>
        <span className="spacer" />
        {shown && <button onClick={() => call('staff.printStatement', shown, from || null, to || null).catch(toast.error)}>Imprimer l'extrait</button>}
      </div>
      {d && (
        <>
          <div className="staff-cards">
            <div>
              <small>
                Salaire dû ({d.staff.salary_account}, {d.staff.parent_label ?? d.staff.parent_account})
              </small>
              <b>{fcfa(d.staff.due)}</b>
            </div>
            <div>
              <small>Avances à rembourser ({d.staff.advance_account})</small>
              <b className={d.staff.advances > 0 ? 'neg' : ''}>{fcfa(d.staff.advances)}</b>
            </div>
            <div>
              <small>Net en faveur du collaborateur</small>
              <b>{fcfa(d.staff.due - d.staff.advances)}</b>
            </div>
          </div>
          <table className="list compact">
            <thead>
              <tr>
                <th>Date</th>
                <th>Pièce</th>
                <th>Libellé</th>
                <th className="r">Salaire</th>
                <th className="r">Dû au collaborateur</th>
                <th className="r">Avance</th>
                <th className="r">Avances à rembourser</th>
              </tr>
            </thead>
            <tbody>
              {from && (
                <tr className="muted">
                  <td colSpan={4}>Soldes au {dateFr(from)}</td>
                  <td className="r">{fcfa(d.opening.due)}</td>
                  <td></td>
                  <td className="r">{fcfa(d.opening.advances)}</td>
                </tr>
              )}
              {d.lines.map((l, i) => (
                <tr key={i}>
                  <td>{dateTime(l.at)}</td>
                  <td>{l.number}</td>
                  <td>{l.label}</td>
                  <td className="r">{l.due ? fcfa(l.due) : ''}</td>
                  <td className="r">{fcfa(l.dueBalance)}</td>
                  <td className="r">{l.advance ? fcfa(l.advance) : ''}</td>
                  <td className="r">{fcfa(l.advanceBalance)}</td>
                </tr>
              ))}
              {!d.lines.length && (
                <tr>
                  <td colSpan={7} className="muted">
                    Aucun mouvement sur la période.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </>
      )}
    </>
  );
}

type TargetRow = Result<'staff.targets'>[number];
const pct = (bp: number) => `${String(bp / 100).replace('.', ',')} %`;

/**
 * Objectifs de vente et commissions : les ventes de chaque collaborateur relié à un
 * utilisateur (ventes validées moins ses retours), le taux atteint et la commission du mois.
 */
function Targets() {
  const [period, setPeriod] = useState(today().slice(0, 7));
  const rows = useLoad(() => call('staff.targets', period), [period]);
  const [editing, setEditing] = useState<TargetRow | null>(null);
  const list = rows.data ?? [];
  const total = list.reduce((t, r) => t + r.commission, 0);
  return (
    <>
      <div className="toolbar">
        <Field label="Mois">
          <input type="month" value={period} max={today().slice(0, 7)} onChange={(e) => setPeriod(e.target.value || today().slice(0, 7))} />
        </Field>
        <span className="spacer" />
        <button onClick={() => window.print()} disabled={!list.length}>
          Imprimer l’état
        </button>
      </div>
      <p className="muted">
        Les ventes comptées sont celles faites sous le compte utilisateur du collaborateur (fiche collaborateur), au comptant ou à crédit, moins ses retours ; les frais de
        livraison ne comptent pas. La commission du mois s’ajoute au brut dans Salaires du mois.
      </p>
      {list.length ? (
        <table className="list">
          <thead>
            <tr>
              <th>Collaborateur</th>
              <th className="r">Objectif du mois</th>
              <th className="r">Ventes du mois</th>
              <th>Atteint</th>
              <th className="r">Objectif du jour</th>
              <th className="r">Ventes du jour</th>
              <th className="r">Tickets</th>
              <th className="r">Taux</th>
              <th className="r">Commission</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {list.map((r) => (
              <tr key={r.staff_id}>
                <td>
                  <b>{r.staff_name}</b>
                  {r.user_name ? <small className="muted"> · {r.user_name}</small> : <small className="neg"> · aucun utilisateur relié</small>}
                </td>
                <td className="r">{r.month_target ? fcfa(r.month_target) : ''}</td>
                <td className="r">{fcfa(r.month_sales)}</td>
                <td>
                  {r.month_rate !== null && (
                    <span className="target-bar" title={`${r.month_rate} %`}>
                      <i style={{ width: `${Math.min(100, r.month_rate)}%` }} className={r.month_rate >= 100 ? 'ok' : ''} />
                      <small>{String(r.month_rate).replace('.', ',')} %</small>
                    </span>
                  )}
                </td>
                <td className="r">{r.day_target ? fcfa(r.day_target) : ''}</td>
                <td className={`r ${r.day_target && r.day_sales >= r.day_target ? 'pos' : ''}`}>{fcfa(r.day_sales)}</td>
                <td className="r">{r.tickets}</td>
                <td className="r">
                  {r.rate_bp ? pct(r.rate_bp) : ''}
                  {Object.keys(r.family_rates).length > 0 && <small className="muted"> + familles</small>}
                </td>
                <td className="r">
                  <b>{r.commission ? fcfa(r.commission) : ''}</b>
                </td>
                <td>
                  <button className="link" onClick={() => setEditing(r)}>
                    Régler…
                  </button>
                </td>
              </tr>
            ))}
            <tr className="total">
              <td colSpan={8}>Total des commissions</td>
              <td className="r">{fcfa(total)}</td>
              <td />
            </tr>
          </tbody>
        </table>
      ) : (
        <Empty>Aucun vendeur : reliez chaque collaborateur à son compte utilisateur dans l’onglet Collaborateurs (fiche › Utilisateur).</Empty>
      )}
      {editing && (
        <TargetEditor
          row={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            rows.reload();
          }}
        />
      )}
    </>
  );
}

function TargetEditor({ row, onClose, onSaved }: { row: TargetRow; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const deps = useLoad(() => call('catalogue.departments'), []);
  const families = (deps.data ?? []).flatMap((d) => d.families.map((f) => ({ ...f, dep: d.name })));
  const toPct = (bp: number) => (bp ? String(bp / 100).replace('.', ',') : '');
  const [month, setMonth] = useState(row.month_target ? String(row.month_target) : '');
  const [day, setDay] = useState(row.day_target ? String(row.day_target) : '');
  const [rate, setRate] = useState(toPct(row.rate_bp));
  const [famRates, setFamRates] = useState<[string, string][]>(Object.entries(row.family_rates).map(([k, v]) => [k, toPct(v)]));
  const bp = (v: string) => {
    const n = Number((v || '0').replace(',', '.'));
    return Number.isFinite(n) ? Math.round(n * 100) : NaN;
  };
  const save = async () => {
    try {
      await call('staff.setTarget', row.staff_id, {
        monthTarget: parseAmount(month || '0') ?? NaN,
        dayTarget: parseAmount(day || '0') ?? NaN,
        rateBp: bp(rate),
        familyRates: Object.fromEntries(famRates.filter(([k]) => k).map(([k, v]) => [k, bp(v)])),
      });
      toast.ok(`Objectif de ${row.staff_name} enregistré`);
      onSaved();
    } catch (err) {
      toast.error(err);
    }
  };
  return (
    <Modal title={`Objectif et commission · ${row.staff_name}`} onClose={onClose}>
      <div className="grid2">
        <Field label="Objectif du mois (FCFA)">
          <input inputMode="numeric" value={month} onChange={(e) => setMonth(e.target.value)} placeholder="0" />
        </Field>
        <Field label="Objectif du jour (FCFA)">
          <input inputMode="numeric" value={day} onChange={(e) => setDay(e.target.value)} placeholder="0" />
        </Field>
      </div>
      <Field label="Commission sur toutes les ventes (%)" hint="Exemple : 1 pour 1 %, 0,5 pour 0,5 %">
        <input inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} placeholder="0" />
      </Field>
      <h4>Taux propre à une famille</h4>
      {famRates.map(([fam, v], i) => (
        <div className="inline" key={i}>
          <select value={fam} onChange={(e) => setFamRates(famRates.map((x, n) => (n === i ? [e.target.value, x[1]] : x)))}>
            <option value="">Choisir une famille</option>
            {families.map((f) => (
              <option key={f.id} value={f.id}>
                {f.dep} › {f.name}
              </option>
            ))}
          </select>
          <input className="narrow" inputMode="decimal" value={v} onChange={(e) => setFamRates(famRates.map((x, n) => (n === i ? [x[0], e.target.value] : x)))} placeholder="%" />
          <button type="button" className="link" onClick={() => setFamRates(famRates.filter((_, n) => n !== i))}>
            Retirer
          </button>
        </div>
      ))}
      <button type="button" className="link" onClick={() => setFamRates([...famRates, ['', '']])}>
        + Ajouter une famille
      </button>
      <div className="actions">
        <button type="button" onClick={onClose}>
          Annuler
        </button>
        <button type="button" className="primary" onClick={() => void save()}>
          Enregistrer
        </button>
      </div>
    </Modal>
  );
}

type AttendanceRow = Result<'attendance.month'>[number];
const hm = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : '');
const hours = (minutes: number) => `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')}`;
const early = (r: AttendanceRow) => r.days.reduce((t, d) => t + d.early_minutes, 0);

/**
 * Pointage du mois : arrivée à la première connexion du jour, départ à la
 * clôture de caisse ou par « Je pars ». Retards au-delà de l'heure et de la
 * tolérance réglées dans Administration › Paramètres › Pointage.
 */
function AttendanceMonth() {
  const toast = useToast();
  const settings = useStoreSettings();
  const [period, setPeriod] = useState(today().slice(0, 7));
  const rows = useLoad(() => call('attendance.month', period), [period]);
  const [open, setOpen] = useState<AttendanceRow | null>(null);
  const [fix, setFix] = useState<{ userId: string; name: string; day: string; arrived: string; left: string; reason: string } | null>(null);
  const list = rows.data ?? [];
  return (
    <>
      <div className="toolbar">
        <Field label="Mois">
          <input type="month" value={period} max={today().slice(0, 7)} onChange={(e) => setPeriod(e.target.value || today().slice(0, 7))} />
        </Field>
        <span className="spacer" />
        <button onClick={() => window.print()} disabled={!list.length}>
          Imprimer l’état
        </button>
      </div>
      <p className="muted">
        Arrivée attendue à {settings.workStart} (retard au-delà de {settings.lateToleranceMinutes} min). L’arrivée est notée à la première connexion du jour, le départ à la
        clôture de la caisse ou par « Je pars » en bas de l’écran. Cliquez une ligne pour voir les jours et corriger un oubli.
      </p>
      {list.length ? (
        <table className="list">
          <thead>
            <tr>
              <th>Employé</th>
              <th className="r">Jours présents</th>
              <th className="r">Heures</th>
              <th className="r">Retards</th>
              <th className="r">Minutes de retard</th>
              <th className="r">Départs anticipés</th>
              <th className="r">Absences</th>
              <th className="r">Jours de congé</th>
            </tr>
          </thead>
          <tbody>
            {list.map((r) => (
              <tr key={r.user_id} className="clickable" onClick={() => setOpen(r)}>
                <td>
                  <b>{r.name}</b>
                </td>
                <td className="r">{r.present}</td>
                <td className="r">
                  {hours(r.minutes)}
                  {r.scheduled_minutes > 0 && <small className="muted block">prévu {hours(r.scheduled_minutes)}</small>}
                </td>
                <td className={`r ${r.late ? 'neg' : ''}`}>{r.late || ''}</td>
                <td className="r">{r.late_minutes || ''}</td>
                <td className="r" title={early(r) ? `${early(r)} min au total` : ''}>
                  {r.days.filter((d) => d.early_minutes > 0).length || ''}
                </td>
                <td className={`r ${r.absences.length ? 'neg' : ''}`} title={r.absences.map(dateFr).join(', ')}>
                  {r.absences.length || ''}
                </td>
                <td className="r" title={r.leave_days.map(dateFr).join(', ')}>
                  {r.leave_days.length || ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <Empty>Personne à pointer dans ce magasin.</Empty>
      )}
      {open && (
        <Modal title={`Pointage de ${open.name}`} onClose={() => setOpen(null)} wide>
          <table className="list">
            <thead>
              <tr>
                <th>Jour</th>
                <th>Arrivée</th>
                <th>Départ</th>
                <th className="r">Durée</th>
                <th className="r">Retard</th>
                <th className="r">Départ anticipé</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {[
                ...open.days.map((d) => ({ ...d, absent: false, leave: false })),
                ...open.absences.map((day) => ({ day, arrived_at: null, left_at: null, minutes: 0, late_minutes: 0, early_minutes: 0, corrected: false, correction_reason: null, absent: true, leave: false })),
                ...open.leave_days
                  .filter((day) => !open.days.some((d) => d.day === day))
                  .map((day) => ({ day, arrived_at: null, left_at: null, minutes: 0, late_minutes: 0, early_minutes: 0, corrected: false, correction_reason: null, absent: false, leave: true })),
              ]
                .sort((a, b) => a.day.localeCompare(b.day))
                .map((d) => (
                  <tr key={d.day} className={d.absent ? 'inactive' : ''}>
                    <td>{dateFr(d.day)}</td>
                    <td>{d.absent ? <span className="tag rupture">absent</span> : d.leave ? <span className="tag info">congé</span> : hm(d.arrived_at)}</td>
                    <td>{hm(d.left_at)}</td>
                    <td className="r">{d.minutes ? hours(d.minutes) : ''}</td>
                    <td className={`r ${d.late_minutes ? 'neg' : ''}`}>{d.late_minutes ? `${d.late_minutes} min` : ''}</td>
                    <td className={`r ${d.early_minutes ? 'neg' : ''}`}>{d.early_minutes ? `${d.early_minutes} min` : ''}</td>
                    <td>
                      {d.corrected && <small className="muted" title={d.correction_reason ?? ''}>corrigé </small>}
                      <button
                        className="link"
                        onClick={() => setFix({ userId: open.user_id, name: open.name, day: d.day, arrived: hm(d.arrived_at), left: hm(d.left_at), reason: '' })}
                      >
                        Corriger…
                      </button>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </Modal>
      )}
      {fix && (
        <Modal title={`${fix.name}, ${dateFr(fix.day)}`} onClose={() => setFix(null)}>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                await call('attendance.correct', fix.userId, fix.day, { arrived: fix.arrived || null, left: fix.left || null, reason: fix.reason });
                toast.ok('Pointage corrigé');
                setFix(null);
                setOpen(null);
                rows.reload();
              } catch (err) {
                toast.error(err);
              }
            }}
          >
            <div className="grid2">
              <Field label="Arrivée">
                <input type="time" value={fix.arrived} onChange={(e) => setFix({ ...fix, arrived: e.target.value })} />
              </Field>
              <Field label="Départ">
                <input type="time" value={fix.left} onChange={(e) => setFix({ ...fix, left: e.target.value })} />
              </Field>
            </div>
            <Field label="Motif">
              <input value={fix.reason} required placeholder="Badge oublié, mission à l’extérieur…" onChange={(e) => setFix({ ...fix, reason: e.target.value })} />
            </Field>
            <div className="actions">
              <button className="primary" type="submit">
                Enregistrer
              </button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
