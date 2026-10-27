import { useState } from 'react';
import { type Result, call } from '../api';
import { Empty, Field, Modal, Tabs, askText, dateTime, fcfa, parseAmount, today, useCan, useLoad, useToast } from '../ui';
import { SupplierSelect } from './pickers';
import { ContainerCounterDialog } from './PosDialogs';

export type ContainersTab = 'situation' | 'moves' | 'types';

type ContainerType = Result<'containers.types'>[number];
type RecordKind = 'supplier_in' | 'supplier_out' | 'adjust';

const MOVES: Record<Result<'containers.moves'>[number]['kind'], string> = {
  customer_out: 'Sorti chez le client',
  customer_in: 'Vide rapporté par le client',
  supplier_in: 'Reçu du fournisseur',
  supplier_out: 'Vide rendu au fournisseur',
  adjust: 'Casse ou comptage',
};

const monthStart = () => `${today().slice(0, 8)}01`;

/**
 * Emballages consignés (casiers, bouteilles) : vides au magasin, emballages
 * chez les clients, consignes encaissées et ce qui est dû aux fournisseurs.
 */
export function Containers({ initialTab = 'situation' }: { initialTab?: ContainersTab }) {
  const can = useCan();
  const allowed: Record<ContainersTab, boolean> = {
    situation: can('containers'),
    moves: can('containers', 'containers_counter'),
    types: can('containers'),
  };
  const [tab, setTab] = useState<ContainersTab>(allowed[initialTab] ? initialTab : ((Object.keys(allowed) as ContainersTab[]).find((k) => allowed[k]) ?? 'moves'));
  const [counter, setCounter] = useState(false);
  const [record, setRecord] = useState<RecordKind | null>(null);
  const [tick, setTick] = useState(0);
  const changed = () => setTick((t) => t + 1);
  return (
    <div className="page">
      <header className="page-head">
        <h1>Emballages consignés</h1>
        <span className="muted">Casiers et bouteilles : vides au magasin, emballages chez les clients, consignes et retours aux fournisseurs</span>
      </header>
      <div className="toolbar">
        {can('containers_counter') && (
          <button className="primary" onClick={() => setCounter(true)}>
            Consigne au comptoir
          </button>
        )}
        {can('containers') && (
          <>
            <button onClick={() => setRecord('supplier_in')}>Reçus du fournisseur</button>
            <button onClick={() => setRecord('supplier_out')}>Vides rendus au fournisseur</button>
            <button onClick={() => setRecord('adjust')}>Casse ou comptage</button>
          </>
        )}
      </div>
      <Tabs
        main
        value={tab}
        onChange={setTab}
        tabs={(
          [
            ['situation', 'Situation'],
            ['moves', 'Mouvements'],
            ['types', "Types d'emballages"],
          ] as [ContainersTab, string][]
        ).filter(([k]) => allowed[k])}
      />
      {!allowed[tab] && <Empty>Vous n'avez pas accès à cet onglet.</Empty>}
      {tab === 'situation' && allowed.situation && <Situation refresh={tick} />}
      {tab === 'moves' && allowed.moves && <Moves refresh={tick} canCancel={can('containers')} />}
      {tab === 'types' && allowed.types && <Types />}
      {counter && <ContainerCounterDialog onClose={() => setCounter(false)} onDone={changed} />}
      {record && <RecordDialog kind={record} onClose={() => setRecord(null)} onDone={changed} />}
    </div>
  );
}

// --- Situation ------------------------------------------------------------------------

function Situation({ refresh }: { refresh: number }) {
  const balances = useLoad(() => call('containers.balances'), [refresh]);
  const customers = useLoad(() => call('containers.atCustomers'), [refresh]);
  const suppliers = useLoad(() => call('containers.owedToSuppliers'), [refresh]);
  const rows = balances.data ?? [];
  const held = rows.reduce((t, r) => t + r.deposits_held, 0);
  const owedValue = (suppliers.data ?? []).reduce((t, r) => t + r.value, 0);
  if (balances.data && rows.length === 0)
    return <Empty>Aucun emballage consigné. Créez vos casiers et bouteilles dans l'onglet Types d'emballages, puis reliez chaque boisson à son emballage sur sa fiche article.</Empty>;
  return (
    <>
      <div className="kpis">
        <div>
          <small>Vides au magasin</small>
          <strong>{rows.reduce((t, r) => t + r.empties, 0)}</strong>
        </div>
        <div>
          <small>Chez les clients</small>
          <strong>{rows.reduce((t, r) => t + r.at_customers, 0)}</strong>
        </div>
        <div className={held ? 'neg' : ''}>
          <small>Consignes à rendre aux clients (4194)</small>
          <strong>{fcfa(held)}</strong>
        </div>
        <div className={owedValue ? 'neg' : ''}>
          <small>Dû aux fournisseurs</small>
          <strong>{fcfa(owedValue)}</strong>
        </div>
      </div>
      <table className="list">
        <thead>
          <tr>
            <th>Emballage</th>
            <th className="r">Consigne</th>
            <th className="r">Vides au magasin</th>
            <th className="r">Chez les clients</th>
            <th className="r">Consignes encaissées</th>
            <th className="r">À rendre aux fournisseurs</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.container_id}>
              <td>{r.name}</td>
              <td className="r">{fcfa(r.deposit)}</td>
              <td className={`r ${r.empties < 0 ? 'neg' : ''}`}>{r.empties}</td>
              <td className="r">{r.at_customers}</td>
              <td className="r">{fcfa(r.deposits_held)}</td>
              <td className="r">{r.owed_to_suppliers}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h3>Clients qui gardent des emballages</h3>
      {(customers.data ?? []).length === 0 ? (
        <p className="muted">Aucun client ne garde d'emballage.</p>
      ) : (
        <table className="list compact">
          <thead>
            <tr>
              <th>Client</th>
              <th>Emballage</th>
              <th className="r">Nombre</th>
              <th className="r">Consigne payée</th>
            </tr>
          </thead>
          <tbody>
            {(customers.data ?? []).map((c) => (
              <tr key={`${c.customer_id ?? ''}-${c.container_id}`}>
                <td>{c.name}</td>
                <td>{c.container_name}</td>
                <td className="r">{c.qty}</td>
                <td className="r">{c.paid ? fcfa(c.paid) : <span className="tag alerte">Sans consigne</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <h3>Emballages à rendre aux fournisseurs</h3>
      {(suppliers.data ?? []).length === 0 ? (
        <p className="muted">Rien à rendre aux fournisseurs.</p>
      ) : (
        <table className="list compact">
          <thead>
            <tr>
              <th>Fournisseur</th>
              <th>Emballage</th>
              <th className="r">Nombre</th>
              <th className="r">Valeur des consignes</th>
            </tr>
          </thead>
          <tbody>
            {(suppliers.data ?? []).map((s) => (
              <tr key={`${s.supplier_id}-${s.container_id}`}>
                <td>{s.supplier_name}</td>
                <td>{s.container_name}</td>
                <td className="r">{s.qty}</td>
                <td className="r">{fcfa(s.value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

/** Emballages reçus du fournisseur, vides rendus, casse ou comptage : sans argent. */
function RecordDialog({ kind, onClose, onDone }: { kind: RecordKind; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const types = useLoad(() => call('containers.types'), []);
  const [supplierId, setSupplierId] = useState('');
  const [containerId, setContainerId] = useState('');
  const [count, setCount] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const adjust = kind === 'adjust';
  const n = Number(count.trim().replace(/\s/g, ''));
  const valid = Number.isSafeInteger(n) && n !== 0 && (adjust || n > 0) && Boolean(containerId) && (adjust ? Boolean(note.trim()) : Boolean(supplierId));
  const save = async () => {
    setBusy(true);
    try {
      const m = await call('containers.record', { kind, containerId, qty: n, supplierId: adjust ? null : supplierId, note: note.trim() || null });
      toast.ok(`Mouvement ${m.number} enregistré`);
      onDone();
      onClose();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={MOVES[kind]} onClose={onClose}>
      {!adjust && <SupplierSelect value={supplierId} onChange={setSupplierId} />}
      <Field label="Emballage">
        <select value={containerId} onChange={(e) => setContainerId(e.target.value)}>
          <option value="">Choisir…</option>
          {(types.data ?? []).map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Nombre d'emballages" hint={adjust ? 'Négatif pour une casse ou des vides manquants au comptage, positif pour des vides trouvés en plus' : undefined}>
        <input autoFocus inputMode="numeric" value={count} onChange={(e) => setCount(e.target.value)} />
      </Field>
      <Field label={adjust ? 'Motif (obligatoire)' : 'Note'}>
        <input value={note} placeholder={adjust ? 'Casier cassé, comptage du mois…' : 'N° du bon de livraison…'} onChange={(e) => setNote(e.target.value)} />
      </Field>
      <p className="muted">
        {kind === 'supplier_in'
          ? 'Les emballages pleins reçus avec la livraison : le fournisseur les attend en retour.'
          : kind === 'supplier_out'
            ? 'Les vides rendus au fournisseur sortent du magasin et diminuent ce que vous lui devez.'
            : 'Corrige le nombre de vides au magasin après une casse ou un comptage.'}
      </p>
      <div className="actions">
        <button onClick={onClose}>Annuler</button>
        <button className="primary" disabled={busy || !valid} onClick={save}>
          Enregistrer
        </button>
      </div>
    </Modal>
  );
}

// --- Mouvements -----------------------------------------------------------------------

function Moves({ canCancel, refresh }: { canCancel: boolean; refresh: number }) {
  const toast = useToast();
  const types = useLoad(() => call('containers.types', true), []);
  const [containerId, setContainerId] = useState('');
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(today());
  const moves = useLoad(() => call('containers.moves', { containerId: containerId || null, from: from || null, to: to || null }), [containerId, from, to, refresh]);
  const cancel = async (id: string, number: string) => {
    const reason = await askText(`Annuler le mouvement ${number} ? La consigne encaissée ou rendue avec est annulée aussi. Indiquez le motif.`);
    if (!reason) return;
    try {
      await call('containers.cancel', id, reason);
      toast.ok(`Mouvement ${number} annulé`);
      moves.reload();
    } catch (e) {
      toast.error(e);
    }
  };
  return (
    <>
      <div className="filters">
        <label className="inline">
          Emballage{' '}
          <select value={containerId} onChange={(e) => setContainerId(e.target.value)}>
            <option value="">Tous</option>
            {(types.data ?? []).map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
        <label className="inline">
          Du <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="inline">
          au <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
      </div>
      {(moves.data ?? []).length === 0 ? (
        <Empty>Aucun mouvement d'emballage sur la période.</Empty>
      ) : (
        <table className="list">
          <thead>
            <tr>
              <th>N°</th>
              <th>Date</th>
              <th>Emballage</th>
              <th>Mouvement</th>
              <th className="r">Nombre</th>
              <th className="r">Consigne</th>
              <th>Client ou fournisseur</th>
              <th>Vente</th>
              <th>Note</th>
              <th>Par</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(moves.data ?? []).map((m) => (
              <tr key={m.id} className={m.status === 'cancelled' ? 'muted' : ''}>
                <td>{m.number}</td>
                <td>{dateTime(m.created_at)}</td>
                <td>{m.container_name}</td>
                <td>{MOVES[m.kind]}</td>
                <td className="r">{m.qty}</td>
                <td className="r">{m.amount ? fcfa(m.amount) : ''}</td>
                <td>{m.customer_name ?? m.client_name ?? m.supplier_name ?? ''}</td>
                <td>{m.sale_number ?? ''}</td>
                <td>{m.note ?? ''}</td>
                <td>{m.user_name ?? ''}</td>
                <td>
                  {m.status === 'cancelled' ? (
                    <span className="tag">Annulé</span>
                  ) : (
                    canCancel && (
                      <button className="link" onClick={() => void cancel(m.id, m.number)}>
                        Annuler
                      </button>
                    )
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

// --- Types d'emballages -----------------------------------------------------------------

function Types() {
  const types = useLoad(() => call('containers.types', true), []);
  const [editing, setEditing] = useState<ContainerType | 'new' | null>(null);
  return (
    <>
      <div className="toolbar">
        <button className="primary" onClick={() => setEditing('new')}>
          Nouvel emballage
        </button>
      </div>
      <p className="muted">
        Chaque boisson consignée se relie à son emballage sur sa fiche article (Emballage consigné, et le nombre d'unités par emballage : 12 pour un casier de 12 bouteilles).
        À la caisse, la consigne est alors proposée après la vente.
      </p>
      {(types.data ?? []).length === 0 ? (
        <Empty action={{ label: 'Nouvel emballage', onClick: () => setEditing('new') }}>Aucun emballage consigné. Créez par exemple « Casier 12 » ou « Bouteille 65 cl » avec le montant de leur consigne.</Empty>
      ) : (
        <table className="list">
          <thead>
            <tr>
              <th>Emballage</th>
              <th className="r">Consigne</th>
              <th>État</th>
            </tr>
          </thead>
          <tbody>
            {(types.data ?? []).map((t) => (
              <tr key={t.id} className="clickable" onClick={() => setEditing(t)}>
                <td>{t.name}</td>
                <td className="r">{fcfa(t.deposit)}</td>
                <td>{t.active ? 'Actif' : <span className="tag">Désactivé</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {editing && (
        <TypeForm
          type={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            types.reload();
          }}
        />
      )}
    </>
  );
}

function TypeForm({ type, onClose, onSaved }: { type: ContainerType | null; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [name, setName] = useState(type?.name ?? '');
  const [deposit, setDeposit] = useState(type ? String(type.deposit) : '');
  const [active, setActive] = useState(type ? type.active === 1 : true);
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await call('containers.saveType', { name, deposit: parseAmount(deposit) ?? 0, active }, type?.id ?? null);
      toast.ok('Emballage enregistré');
      onSaved();
    } catch (err) {
      toast.error(err);
    }
  };
  return (
    <Modal title={type ? type.name : 'Nouvel emballage'} onClose={onClose}>
      <form onSubmit={save}>
        <Field label="Nom" hint="Casier 12, Bouteille 65 cl, Fût 30 L…">
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} required />
        </Field>
        <Field label="Consigne (FCFA)" hint="Montant payé par le client pour un emballage, rendu quand il le rapporte">
          <input inputMode="numeric" value={deposit} onChange={(e) => setDeposit(e.target.value)} required />
        </Field>
        <label className="inline">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> Actif
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
