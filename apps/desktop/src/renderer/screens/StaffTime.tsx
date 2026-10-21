import { useState } from 'react';
import { type Result, call } from '../api';
import { askConfirm, Empty, Field, Modal, dateFr, today, useLoad, useToast } from '../ui';

type Leave = Result<'staffTime.leaves'>[number];
type PlanningRow = Result<'staffTime.week'>[number];
type WeekSchedule = Result<'staffTime.schedule'>['schedule'];
type Weekday = keyof WeekSchedule;
type LeaveKind = Leave['kind'];

const KINDS: Record<LeaveKind, string> = {
  paid: 'Congé payé',
  sick: 'Maladie',
  unpaid: 'Congé sans solde',
  permission: 'Permission exceptionnelle',
};
const STATUS: Record<Leave['status'], [string, string]> = {
  requested: ['Demandé', 'alerte'],
  approved: ['Accordé', 'normal'],
  refused: ['Refusé', 'rupture'],
  cancelled: ['Annulé', ''],
};
/** Lundi d'abord. */
const WEEKDAYS: [Weekday, string][] = [
  ['1', 'Lundi'],
  ['2', 'Mardi'],
  ['3', 'Mercredi'],
  ['4', 'Jeudi'],
  ['5', 'Vendredi'],
  ['6', 'Samedi'],
  ['0', 'Dimanche'],
];

const pad = (n: number) => String(n).padStart(2, '0');
const localDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (day: string, n: number) => {
  const d = new Date(`${day}T12:00:00`);
  d.setDate(d.getDate() + n);
  return localDay(d);
};
const mondayOf = (day: string) => addDays(day, -((new Date(`${day}T12:00:00`).getDay() + 6) % 7));
const hours = (minutes: number) => `${Math.floor(minutes / 60)} h ${pad(minutes % 60)}`;
const shortDay = (day: string) => new Date(`${day}T12:00:00`).toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' });
const days = (n: number) => `${String(n).replace('.', ',')} j`;

/** Congés : soldes de l'année, demandes à décider et nouveau congé. */
export function Leaves() {
  const toast = useToast();
  const [year, setYear] = useState(Number(today().slice(0, 4)));
  const [creating, setCreating] = useState(false);
  const [tick, setTick] = useState(0);
  const balances = useLoad(() => call('staffTime.balances', year), [year, tick]);
  const leaves = useLoad(() => call('staffTime.leaves', { year }), [year, tick]);
  const decide = async (l: Leave, decision: 'approved' | 'refused' | 'cancelled') => {
    const what = decision === 'approved' ? 'Accorder' : decision === 'refused' ? 'Refuser' : 'Annuler';
    if (!(await askConfirm(`${what} le congé de ${l.staff_name} du ${dateFr(l.date_from)} au ${dateFr(l.date_to)} ?`))) return;
    try {
      await call('staffTime.decideLeave', l.id, decision);
      toast.ok(decision === 'approved' ? 'Congé accordé' : decision === 'refused' ? 'Congé refusé' : 'Congé annulé');
      setTick((t) => t + 1);
    } catch (e) {
      toast.error(e);
    }
  };
  const list = leaves.data ?? [];
  return (
    <>
      <div className="toolbar">
        <button className="primary" onClick={() => setCreating(true)}>
          Nouveau congé…
        </button>
        <Field label="Année">
          <input type="number" min={2000} max={2100} value={year} onChange={(e) => setYear(Number(e.target.value) || Number(today().slice(0, 4)))} />
        </Field>
      </div>
      <p className="muted">
        Les congés payés s'acquièrent chaque mois de service (réglage dans Administration › Paramètres). Seuls les jours travaillés du planning sont décomptés ; un congé
        accordé n'est pas compté comme une absence au pointage.
      </p>
      <h3>Soldes de congés payés {year}</h3>
      {(balances.data ?? []).length === 0 ? (
        <Empty>Aucun collaborateur actif.</Empty>
      ) : (
        <table className="list compact">
          <thead>
            <tr>
              <th>Collaborateur</th>
              <th className="r">Acquis</th>
              <th className="r">Pris</th>
              <th className="r">Restant</th>
            </tr>
          </thead>
          <tbody>
            {(balances.data ?? []).map((b) => (
              <tr key={b.staff_id}>
                <td>{b.name}</td>
                <td className="r">{days(b.acquired)}</td>
                <td className="r">{days(b.taken)}</td>
                <td className="r">
                  <b>{days(b.remaining)}</b>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <h3>Congés {year}</h3>
      {list.length === 0 ? (
        <Empty>Aucun congé enregistré cette année.</Empty>
      ) : (
        <table className="list">
          <thead>
            <tr>
              <th>Collaborateur</th>
              <th>Type</th>
              <th>Du</th>
              <th>Au</th>
              <th className="r">Jours</th>
              <th>Motif</th>
              <th>État</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {list.map((l) => (
              <tr key={l.id} className={l.status === 'cancelled' || l.status === 'refused' ? 'inactive' : ''}>
                <td>{l.staff_name}</td>
                <td>{KINDS[l.kind]}</td>
                <td>{dateFr(l.date_from)}</td>
                <td>{dateFr(l.date_to)}</td>
                <td className="r">{l.days}</td>
                <td>{l.reason ?? ''}</td>
                <td>
                  <span className={`tag ${STATUS[l.status][1]}`}>{STATUS[l.status][0]}</span>
                  {l.decided_by_name && <small className="muted"> par {l.decided_by_name}</small>}
                </td>
                <td className="nowrap">
                  {l.status === 'requested' && (
                    <>
                      <button className="link" onClick={() => void decide(l, 'approved')}>
                        Accorder
                      </button>{' '}
                      <button className="link" onClick={() => void decide(l, 'refused')}>
                        Refuser
                      </button>{' '}
                    </>
                  )}
                  {(l.status === 'requested' || l.status === 'approved') && (
                    <button className="link" onClick={() => void decide(l, 'cancelled')}>
                      Annuler
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {creating && <LeaveForm onClose={() => setCreating(false)} onSaved={() => (setCreating(false), setTick((t) => t + 1))} />}
    </>
  );
}

function LeaveForm({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const staff = useLoad(() => call('staff.list', false));
  const [f, setF] = useState({ staffId: '', kind: 'paid' as LeaveKind, from: today(), to: today(), reason: '', approved: true });
  return (
    <Modal title="Nouveau congé" onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            if (!f.staffId) throw new Error('Choisissez le collaborateur');
            const l = await call('staffTime.requestLeave', { staffId: f.staffId, kind: f.kind, from: f.from, to: f.to, reason: f.reason || null, approved: f.approved });
            toast.ok(`${KINDS[l.kind]} de ${l.staff_name} enregistré : ${l.days} jour(s) travaillé(s)`);
            onSaved();
          } catch (err) {
            toast.error(err);
          }
        }}
      >
        <div className="grid2">
          <Field label="Collaborateur">
            <select value={f.staffId} required onChange={(e) => setF({ ...f, staffId: e.target.value })}>
              <option value="">Choisir…</option>
              {(staff.data ?? [])
                .filter((s) => s.active)
                .map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
            </select>
          </Field>
          <Field label="Type">
            <select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as LeaveKind })}>
              {Object.entries(KINDS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Du">
            <input type="date" value={f.from} required onChange={(e) => setF({ ...f, from: e.target.value, to: f.to < e.target.value ? e.target.value : f.to })} />
          </Field>
          <Field label="Au (compris)">
            <input type="date" value={f.to} min={f.from} required onChange={(e) => setF({ ...f, to: e.target.value })} />
          </Field>
        </div>
        <Field label="Motif">
          <input value={f.reason} placeholder="Vacances, certificat médical, événement familial…" onChange={(e) => setF({ ...f, reason: e.target.value })} />
        </Field>
        <label className="inline">
          <input type="checkbox" checked={f.approved} onChange={(e) => setF({ ...f, approved: e.target.checked })} /> Accordé tout de suite
        </label>
        <div className="actions">
          <button className="primary" type="submit">
            Enregistrer
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** Planning de la semaine : horaires prévus, congés et repos de chaque collaborateur. */
export function WeekPlanning() {
  const [monday, setMonday] = useState(mondayOf(today()));
  const [edit, setEdit] = useState<PlanningRow | null>(null);
  const week = useLoad(() => call('staffTime.week', monday), [monday, edit]);
  const rows = week.data ?? [];
  const dayList = Array.from({ length: 7 }, (_, i) => addDays(monday, i));
  return (
    <>
      <div className="toolbar">
        <button onClick={() => setMonday(addDays(monday, -7))} title="Semaine précédente">
          ‹
        </button>
        <b>
          Semaine du {dateFr(monday)} au {dateFr(addDays(monday, 6))}
        </b>
        <button onClick={() => setMonday(addDays(monday, 7))} title="Semaine suivante">
          ›
        </button>
        {monday !== mondayOf(today()) && <button onClick={() => setMonday(mondayOf(today()))}>Cette semaine</button>}
        <span className="spacer" />
        <button onClick={() => window.print()} disabled={!rows.length}>
          Imprimer le planning
        </button>
      </div>
      <p className="muted">
        Horaires de la semaine type de chaque collaborateur (ou ceux du magasin), avec les congés accordés et demandés. Cliquez un nom pour régler ses horaires.
      </p>
      {rows.length === 0 ? (
        <Empty>Aucun collaborateur actif dans ce magasin.</Empty>
      ) : (
        <table className="list">
          <thead>
            <tr>
              <th>Collaborateur</th>
              {dayList.map((d) => (
                <th key={d} className={d === today() ? 'active' : ''}>
                  {shortDay(d)}
                </th>
              ))}
              <th className="r">Heures</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.staff_id}>
                <td>
                  <button className="link" onClick={() => setEdit(r)}>
                    {r.name}
                  </button>
                  {r.position && <small className="muted block">{r.position}</small>}
                </td>
                {r.cells.map((c) => (
                  <td key={c.day}>
                    {c.leave ? (
                      c.leave.status === 'approved' ? (
                        <span className="tag info">{KINDS[c.leave.kind]}</span>
                      ) : (
                        <span className="tag alerte" title="Congé demandé, pas encore accordé">
                          {KINDS[c.leave.kind]} (demandé)
                        </span>
                      )
                    ) : null}
                    {c.shift && c.leave?.status !== 'approved' ? (
                      <span className={c.leave ? 'block' : ''}>
                        {c.shift.start}–{c.shift.end}
                      </span>
                    ) : !c.shift && !c.leave ? (
                      <span className="muted">Repos</span>
                    ) : null}
                  </td>
                ))}
                <td className="r">
                  <b>{hours(r.minutes)}</b>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {edit && <ScheduleEditor staffId={edit.staff_id} name={edit.name} onClose={() => setEdit(null)} />}
    </>
  );
}

function ScheduleEditor({ staffId, name, onClose }: { staffId: string; name: string; onClose: () => void }) {
  const toast = useToast();
  const loaded = useLoad(() => call('staffTime.schedule', staffId), [staffId]);
  const [draft, setDraft] = useState<Record<string, { on: boolean; start: string; end: string }> | null>(null);
  const days =
    draft ??
    (loaded.data
      ? Object.fromEntries(WEEKDAYS.map(([k]) => [k, { on: Boolean(loaded.data!.schedule[k]), start: loaded.data!.schedule[k]?.start ?? '08:00', end: loaded.data!.schedule[k]?.end ?? '17:00' }]))
      : null);
  const set = (k: Weekday, patch: Partial<{ on: boolean; start: string; end: string }>) => days && setDraft({ ...days, [k]: { ...days[k]!, ...patch } });
  const save = async (value: WeekSchedule | null) => {
    try {
      await call('staffTime.saveSchedule', staffId, value);
      toast.ok(value ? `Horaires de ${name} enregistrés` : `${name} reprend les horaires du magasin`);
      onClose();
    } catch (e) {
      toast.error(e);
    }
  };
  return (
    <Modal title={`Semaine type de ${name}`} onClose={onClose}>
      {!days ? (
        <p className="muted">Chargement…</p>
      ) : (
        <>
          <p className="muted">
            {loaded.data?.custom ? 'Horaires propres à ce collaborateur.' : 'Pas encore d’horaires propres : ce sont ceux du magasin.'} Le pointage compare les arrivées
            et départs à ces horaires.
          </p>
          <table className="list compact">
            <thead>
              <tr>
                <th>Jour</th>
                <th>Travaillé</th>
                <th>Début</th>
                <th>Fin</th>
              </tr>
            </thead>
            <tbody>
              {WEEKDAYS.map(([k, label]) => {
                const d = days[k]!;
                return (
                  <tr key={k} className={d.on ? '' : 'inactive'}>
                    <td>{label}</td>
                    <td>
                      <label className="inline">
                        <input type="checkbox" checked={d.on} onChange={(e) => set(k, { on: e.target.checked })} /> {d.on ? 'Oui' : 'Repos'}
                      </label>
                    </td>
                    <td>
                      <input type="time" value={d.start} disabled={!d.on} onChange={(e) => set(k, { start: e.target.value })} />
                    </td>
                    <td>
                      <input type="time" value={d.end} disabled={!d.on} onChange={(e) => set(k, { end: e.target.value })} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="actions">
            {loaded.data?.custom && <button onClick={() => void save(null)}>Reprendre les horaires du magasin</button>}
            <button
              className="primary"
              onClick={() => {
                const bad = WEEKDAYS.find(([k]) => days[k]!.on && (!days[k]!.start || !days[k]!.end || days[k]!.end <= days[k]!.start));
                if (bad) return toast.error(`${bad[1]} : la fin doit venir après le début`);
                void save(Object.fromEntries(WEEKDAYS.filter(([k]) => days[k]!.on).map(([k]) => [k, { start: days[k]!.start, end: days[k]!.end }])) as WeekSchedule);
              }}
            >
              Enregistrer
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}
