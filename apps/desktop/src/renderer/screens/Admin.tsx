import { type Permission, type RegisterKind } from '@superette/core';
import { useEffect, useState } from 'react';
import { type Result, call } from '../api';
import { ROLE_LABELS } from '../App';
import { Empty, Field, Modal, Tabs, dateTime, useLoad, useToast } from '../ui';
import { RoleRights, UserPrivileges } from './AdminRights';
import { Settings } from './AdminSettings';

type User = NonNullable<Result<'app.state'>['user']>;
type Role = User['role'];
export type AdminTab = Tab;
type Tab = 'stores' | 'registers' | 'warehouses' | 'users' | 'rights' | 'privileges' | 'settings' | 'backups' | 'server' | 'audit';

export function Admin({ user, onChanged, initialTab }: { user: User; onChanged: () => void; initialTab?: Tab }) {
  const [tab, setTab] = useState<Tab>(initialTab ?? (user.role === 'admin' ? 'stores' : 'users'));
  // Utilisateur ouvert depuis la liste (« Privilèges… ») dans l'onglet des privilèges.
  const [privUser, setPrivUser] = useState<string | null>(null);
  const can = (p: Permission) => user.rights.includes(p);
  const tabs: [Tab, string][] = [
    ...(user.role === 'admin' ? ([['stores', 'Magasins']] as [Tab, string][]) : []),
    ['registers', 'Caisses'],
    ['warehouses', 'Dépôts'],
    ['users', 'Utilisateurs'],
    ['rights', 'Droits par rôle'],
    ['privileges', 'Privilèges par utilisateur'],
    ['settings', 'Paramètres'],
    ...(can('backups') ? ([['backups', 'Sauvegardes']] as [Tab, string][]) : []),
    ['server', 'Serveur central'],
    ...(can('audit') ? ([['audit', "Journal d'audit"]] as [Tab, string][]) : []),
  ];
  return (
    <div className="page">
      <header className="page-head">
        <h1>Administration</h1>
      </header>
      <Tabs value={tab} onChange={setTab} tabs={tabs} />
      {tab === 'stores' && <Stores onChanged={onChanged} />}
      {tab === 'registers' && <Registers isAdmin={user.role === 'admin'} onChanged={onChanged} />}
      {tab === 'warehouses' && <Warehouses canCreate={can('warehouses_manage')} />}
      {tab === 'users' && (
        <Users
          currentRole={user.role}
          canManage={can('users_manage')}
          onPrivileges={(id) => {
            setPrivUser(id);
            setTab('privileges');
          }}
        />
      )}
      {tab === 'rights' && <RoleRights isAdmin={user.role === 'admin'} onChanged={onChanged} />}
      {tab === 'privileges' && <UserPrivileges key={privUser ?? ''} isAdmin={user.role === 'admin'} initialUserId={privUser} onChanged={onChanged} />}
      {tab === 'settings' && <Settings user={user} onChanged={onChanged} />}
      {tab === 'backups' && can('backups') && <Backups isAdmin={user.role === 'admin'} onChanged={onChanged} />}
      {tab === 'server' && <CentralServer isAdmin={user.role === 'admin'} />}
      {tab === 'audit' && can('audit') && <Audit />}
    </div>
  );
}

function Stores({ onChanged }: { onChanged: () => void }) {
  const toast = useToast();
  const stores = useLoad(() => call('admin.stores'));
  const [form, setForm] = useState<null | { id?: string; storeCode: string; storeName: string; address: string; phone: string; taxpayerNumber: string }>(null);
  return (
    <>
      <p className="muted">Chaque magasin a son stock, ses dépôts, ses caisses et son journal de caisse ; les articles sont partagés.</p>
      <table className="list">
        <thead>
          <tr>
            <th>Code</th>
            <th>Nom</th>
            <th>Adresse</th>
            <th>Téléphone</th>
            <th>NIU</th>
          </tr>
        </thead>
        <tbody>
          {(stores.data ?? []).map((s) => (
            <tr
              key={s.id}
              className="clickable"
              onClick={() => setForm({ id: s.id, storeCode: s.code, storeName: s.name, address: s.address ?? '', phone: s.phone ?? '', taxpayerNumber: s.taxpayer_number ?? '' })}
            >
              <td>{s.code}</td>
              <td>{s.name}</td>
              <td>{s.address}</td>
              <td>{s.phone}</td>
              <td>{s.taxpayer_number}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="actions">
        <button className="primary" onClick={() => setForm({ storeCode: '', storeName: '', address: '', phone: '', taxpayerNumber: '' })}>
          Ajouter un magasin
        </button>
      </div>
      {form && (
        <Modal title={form.id ? form.storeName : 'Nouveau magasin'} onClose={() => setForm(null)}>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                if (form.id) {
                  await call('admin.updateStore', form.id, { name: form.storeName, address: form.address || null, phone: form.phone || null, taxpayer_number: form.taxpayerNumber || null });
                } else {
                  const { id: _, ...input } = form;
                  await call('admin.createStore', input);
                  toast.ok('Magasin créé avec sa caisse n° 1, sa surface de vente et sa réserve');
                }
                setForm(null);
                stores.reload();
                onChanged();
              } catch (err) {
                toast.error(err);
              }
            }}
          >
            <div className="grid2">
              <Field label="Code">
                <input value={form.storeCode} disabled={Boolean(form.id)} onChange={(e) => setForm({ ...form, storeCode: e.target.value })} required />
              </Field>
              <Field label="Nom">
                <input value={form.storeName} onChange={(e) => setForm({ ...form, storeName: e.target.value })} required />
              </Field>
              <Field label="Adresse">
                <input value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
              </Field>
              <Field label="Téléphone">
                <input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
              </Field>
              <Field label="NIU">
                <input value={form.taxpayerNumber} onChange={(e) => setForm({ ...form, taxpayerNumber: e.target.value })} />
              </Field>
            </div>
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

const KIND_LABEL: Record<RegisterKind, string> = { cash: 'Espèces', electronic: 'Électronique (MTN, Orange, carte)', bank: 'Banque (virement, chèque)' };
const KIND_SHORT: Record<RegisterKind, string> = { cash: 'Espèces', electronic: 'Électronique', bank: 'Banque' };

function Registers({ isAdmin, onChanged }: { isAdmin: boolean; onChanged: () => void }) {
  const toast = useToast();
  const state = useLoad(() => call('app.state'));
  const stores = useLoad(() => call('admin.stores'));
  const [storeId, setStoreId] = useState('');
  const sid = storeId || state.data?.station?.store.id || '';
  const registers = useLoad(() => (sid ? call('admin.registers', sid) : Promise.resolve([])), [sid]);
  const users = useLoad(() => call('admin.users'));
  const [code, setCode] = useState('');
  const [newName, setNewName] = useState('');
  const [newKind, setNewKind] = useState<RegisterKind>('cash');
  const [editing, setEditing] = useState<{ id: string; name: string; active: boolean } | null>(null);
  const assigned = (id: string) =>
    (users.data ?? []).filter((u) => (u.register_id === id || u.emoney_register_id === id || u.bank_register_id === id) && u.active === 1).map((u) => u.name);
  return (
    <>
      <div className="filters">
        <select value={sid} onChange={(e) => setStoreId(e.target.value)}>
          {(stores.data ?? []).map((s) => (
            <option key={s.id} value={s.id}>
              {s.code} · {s.name}
            </option>
          ))}
        </select>
        <span className="muted">Ce PC : {state.data?.station?.register?.name ?? 'non activé comme caisse'}</span>
      </div>
      <p className="muted">
        Chaque utilisateur vend sur la caisse qui lui est attribuée (Administration › Utilisateurs), depuis n'importe quel PC du magasin. Un
        caissier peut avoir une caisse de chaque type : espèces (le tiroir), électronique (MTN, Orange, carte) et banque (virement, chèque) ; chaque
        paiement va dans la caisse de son type. Le code d'activation d'une caisse espèces sert à rattacher un nouveau PC au magasin.
      </p>
      <table className="list">
        <thead>
          <tr>
            <th>N°</th>
            <th>Nom</th>
            <th>Type</th>
            <th>Attribuée à</th>
            <th>Code d'activation</th>
            <th>État</th>
            {isAdmin && <th></th>}
          </tr>
        </thead>
        <tbody>
          {(registers.data ?? []).map((r) => (
            <tr key={r.id} className={r.active ? '' : 'inactive'}>
              <td>{r.number}</td>
              <td>{r.name}</td>
              <td>
                <span className={`tag kind-${r.kind}`}>{KIND_SHORT[r.kind]}</span>
              </td>
              <td>{assigned(r.id).join(', ') || <span className="muted">personne</span>}</td>
              <td>{r.kind === 'cash' ? <code>{r.activation_code}</code> : <span className="muted">—</span>}</td>
              <td>{r.active ? 'Active' : 'Désactivée'}</td>
              {isAdmin && (
                <td>
                  <button className="link" onClick={() => setEditing({ id: r.id, name: r.name, active: r.active === 1 })}>
                    Modifier
                  </button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      {isAdmin && (
        <form
          className="inline"
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              const r = await call('admin.createRegister', sid, newName.trim() || undefined, newKind);
              toast.ok(`${r.name} créée`);
              setNewName('');
              registers.reload();
              onChanged();
            } catch (err) {
              toast.error(err);
            }
          }}
        >
          <select value={newKind} onChange={(e) => setNewKind(e.target.value as RegisterKind)} aria-label="Type de caisse">
            {(Object.keys(KIND_LABEL) as RegisterKind[]).map((k) => (
              <option key={k} value={k}>
                {KIND_LABEL[k]}
              </option>
            ))}
          </select>
          <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder={newKind === 'cash' ? 'Nom (facultatif), ex. Caisse boissons' : newKind === 'electronic' ? 'Nom (facultatif), ex. Mobile 1' : 'Nom (facultatif), ex. Banque SGC'} />
          <button className="primary" type="submit">
            Ajouter une caisse
          </button>
        </form>
      )}
      {editing && (
        <Modal title="Modifier la caisse" onClose={() => setEditing(null)}>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                await call('admin.updateRegister', editing.id, { name: editing.name, active: editing.active });
                toast.ok('Caisse enregistrée');
                setEditing(null);
                registers.reload();
                onChanged();
              } catch (err) {
                toast.error(err);
              }
            }}
          >
            <Field label="Nom">
              <input autoFocus value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
            </Field>
            <label className="check">
              <input type="checkbox" checked={editing.active} onChange={(e) => setEditing({ ...editing, active: e.target.checked })} /> Caisse active
            </label>
            {!editing.active && <p className="warn-text">Les utilisateurs de cette caisse ne pourront plus vendre tant qu'on ne leur en attribue pas une autre.</p>}
            <div className="actions">
              <button type="submit" className="primary">
                Enregistrer
              </button>
            </div>
          </form>
        </Modal>
      )}
      <h3>Rattacher ce PC à une caisse (gérant sans caisse attribuée)</h3>
      <form
        className="inline"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            const r = await call('setup.activateRegister', code);
            toast.ok(`Ce poste est maintenant ${r.name}`);
            setCode('');
            state.reload();
            registers.reload();
            onChanged();
          } catch (err) {
            toast.error(err);
          }
        }}
      >
        <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="Code à 6 chiffres" maxLength={6} />
        <button type="submit" disabled={code.length !== 6}>
          Activer
        </button>
      </form>
      <p className="muted">
        Sur un nouveau PC, choisissez « Rejoindre un magasin existant » au premier démarrage et saisissez l'adresse du serveur central et ce code :
        le PC récupère le catalogue, les utilisateurs et le stock du magasin.
      </p>
    </>
  );
}

function Warehouses({ canCreate }: { canCreate: boolean }) {
  const toast = useToast();
  const wh = useLoad(() => call('admin.warehouses'));
  const [name, setName] = useState('');
  const [kind, setKind] = useState<'shop' | 'reserve' | 'cold'>('reserve');
  const KIND = { shop: 'Surface de vente', reserve: 'Réserve', cold: 'Chambre froide' };
  return (
    <>
      <table className="list">
        <tbody>
          {(wh.data ?? []).map((w) => (
            <tr key={w.id}>
              <td>{w.name}</td>
              <td>{KIND[w.kind]}</td>
              <td>{w.is_sales_default ? <span className="tag normal">Dépôt des ventes</span> : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {canCreate && (
      <form
        className="inline"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await call('admin.createWarehouse', name, kind);
            setName('');
            wh.reload();
          } catch (err) {
            toast.error(err);
          }
        }}
      >
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Nom du dépôt" />
        <select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
          {Object.entries(KIND).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
        <button type="submit" disabled={!name.trim()}>
          Ajouter
        </button>
      </form>
      )}
    </>
  );
}

function Users({ currentRole, canManage, onPrivileges }: { currentRole: Role; canManage: boolean; onPrivileges: (id: string) => void }) {
  const toast = useToast();
  const users = useLoad(() => call('admin.users'));
  const stores = useLoad(() => call('admin.stores'));
  // Caisses de tous les magasins : un utilisateur reçoit celle de son magasin.
  const registers = useLoad(
    () => (stores.data ? Promise.all(stores.data.map((st) => call('admin.registers', st.id))).then((l) => l.flat()) : Promise.resolve([])),
    [stores.data],
  );
  const registerLabel = (id: string | null) => {
    const r = id ? registers.data?.find((x) => x.id === id) : undefined;
    if (!r) return '';
    const st = (stores.data?.length ?? 0) > 1 ? stores.data?.find((x) => x.id === r.store_id) : undefined;
    return `${st ? `${st.code} · ` : ''}${r.name}`;
  };
  const [form, setForm] = useState<null | {
    id?: string;
    name: string;
    login: string;
    pin: string;
    role: Role;
    storeId: string;
    registerId: string;
    emoneyRegisterId: string;
    bankRegisterId: string;
    active: boolean;
  }>(null);
  const sells = (role: Role) => role === 'cashier' || role === 'seller';
  const roles = (Object.keys(ROLE_LABELS) as Role[]).filter((r) => currentRole === 'admin' || r !== 'admin');
  return (
    <>
      <table className="list">
        <thead>
          <tr>
            <th>Nom</th>
            <th>Identifiant</th>
            <th>Rôle</th>
            <th>Magasin</th>
            <th>Caisse</th>
            <th>Privilèges</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {(users.data ?? []).map((u) => (
            <tr
              key={u.id}
              className={`${canManage ? 'clickable' : ''} ${u.active ? '' : 'inactive'}`}
              onClick={() =>
                canManage &&
                setForm({
                  id: u.id,
                  name: u.name,
                  login: u.login,
                  pin: '',
                  role: u.role,
                  storeId: u.store_id ?? '',
                  registerId: u.register_id ?? '',
                  emoneyRegisterId: u.emoney_register_id ?? '',
                  bankRegisterId: u.bank_register_id ?? '',
                  active: u.active === 1,
                })
              }
            >
              <td>{u.name}</td>
              <td>{u.login}</td>
              <td>{ROLE_LABELS[u.role]}</td>
              <td>{stores.data?.find((s) => s.id === u.store_id)?.name ?? 'Tous'}</td>
              <td>
                {registerLabel(u.register_id) ||
                  (sells(u.role) ? <span className="tag alerte">aucune : ne peut pas vendre</span> : <span className="muted">—</span>)}
                {[u.emoney_register_id, u.bank_register_id].filter(Boolean).map((id) => (
                  <small key={id} className="muted">
                    {' '}
                    + {registerLabel(id)}
                  </small>
                ))}
              </td>
              <td onClick={(e) => e.stopPropagation()}>
                {u.role === 'admin' ? (
                  <span className="muted">tous les droits</span>
                ) : (
                  <button className="ghost" onClick={() => onPrivileges(u.id)}>
                    {u.privileges ? (
                      <span className="tag normal" title="Privilèges personnels">
                        {[u.privileges.grants ? `+${u.privileges.grants}` : '', u.privileges.revokes ? `−${u.privileges.revokes}` : ''].filter(Boolean).join(' ')}
                      </span>
                    ) : (
                      'Rôle seul'
                    )}{' '}
                    ›
                  </button>
                )}
              </td>
              <td onClick={(e) => e.stopPropagation()}>
                {!u.active && <span className="tag">désactivé</span>}
                {u.locked && (
                  <>
                    <span className="tag rupture">bloqué (codes faux)</span>{' '}
                    {canManage && (
                      <button
                        className="ghost"
                        onClick={() =>
                          call('admin.unlockUser', u.id).then(() => {
                            toast.ok(`${u.name} est débloqué`);
                            users.reload();
                          }, toast.error)
                        }
                      >
                        Débloquer
                      </button>
                    )}
                  </>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {canManage && (
        <div className="actions">
          <button className="primary" onClick={() => setForm({ name: '', login: '', pin: '', role: 'cashier', storeId: '', registerId: '', emoneyRegisterId: '', bankRegisterId: '', active: true })}>
            Ajouter un utilisateur
          </button>
        </div>
      )}
      {form && (
        <Modal title={form.id ? form.name : 'Nouvel utilisateur'} onClose={() => setForm(null)}>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                if (form.id) {
                  await call('admin.updateUser', form.id, {
                    name: form.name,
                    role: form.role,
                    storeId: form.storeId || null,
                    registerId: form.registerId || null,
                    emoneyRegisterId: form.emoneyRegisterId || null,
                    bankRegisterId: form.bankRegisterId || null,
                    active: form.active,
                    pin: form.pin || undefined,
                  });
                } else {
                  await call('admin.createUser', {
                    name: form.name,
                    login: form.login,
                    pin: form.pin,
                    role: form.role,
                    storeId: form.storeId || null,
                    registerId: form.registerId || null,
                    emoneyRegisterId: form.emoneyRegisterId || null,
                    bankRegisterId: form.bankRegisterId || null,
                  });
                }
                setForm(null);
                users.reload();
              } catch (err) {
                toast.error(err);
              }
            }}
          >
            <div className="grid2">
              <Field label="Nom complet">
                <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
              </Field>
              <Field label="Identifiant">
                <input value={form.login} disabled={Boolean(form.id)} onChange={(e) => setForm({ ...form, login: e.target.value })} required />
              </Field>
              <Field label={form.id ? 'Nouveau code (laisser vide pour garder)' : 'Code secret'} hint="Chiffres seulement ; la longueur minimale se règle dans Paramètres › Sécurité">
                <input type="password" inputMode="numeric" value={form.pin} onChange={(e) => setForm({ ...form, pin: e.target.value })} required={!form.id} />
              </Field>
              <Field label="Rôle">
                <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as Role })}>
                  {roles.map((r) => (
                    <option key={r} value={r}>
                      {ROLE_LABELS[r]}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Magasin">
                <select value={form.storeId} onChange={(e) => setForm({ ...form, storeId: e.target.value })}>
                  <option value="">Tous les magasins</option>
                  {(stores.data ?? []).map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field
                label="Caisse espèces"
                hint={
                  sells(form.role)
                    ? 'Il vend sur cette caisse depuis n’importe quel PC. Sans caisse, il ne peut pas vendre.'
                    : 'Facultatif : sans caisse, le gérant choisit la sienne au moment de vendre.'
                }
              >
                <select value={form.registerId} onChange={(e) => setForm({ ...form, registerId: e.target.value })}>
                  <option value="">Aucune caisse</option>
                  {(registers.data ?? [])
                    .filter((r) => r.kind === 'cash' && (r.active || r.id === form.registerId) && (!form.storeId || r.store_id === form.storeId))
                    .map((r) => (
                      <option key={r.id} value={r.id}>
                        {registerLabel(r.id)}
                      </option>
                    ))}
                </select>
              </Field>
              {(
                [
                  ['emoneyRegisterId', 'electronic', 'Caisse électronique', 'Reçoit ses paiements MTN, Orange Money et carte.'],
                  ['bankRegisterId', 'bank', 'Caisse banque', 'Reçoit ses virements et chèques.'],
                ] as const
              ).map(([key, kind, label, hint]) => (
                <Field key={key} label={label} hint={hint}>
                  <select value={form[key]} onChange={(e) => setForm({ ...form, [key]: e.target.value })}>
                    <option value="">Aucune (dans la caisse espèces)</option>
                    {(registers.data ?? [])
                      .filter((r) => r.kind === kind && (r.active || r.id === form[key]) && (!form.storeId || r.store_id === form.storeId))
                      .map((r) => (
                        <option key={r.id} value={r.id}>
                          {registerLabel(r.id)}
                        </option>
                      ))}
                  </select>
                </Field>
              ))}
              {form.id && (
                <label className="inline">
                  <input type="checkbox" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} /> Compte actif
                </label>
              )}
            </div>
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

function CentralServer({ isAdmin }: { isAdmin: boolean }) {
  const toast = useToast();
  const state = useLoad(() => call('sync.state'));
  const conflicts = useLoad(() => call('sync.conflicts'));
  const [url, setUrl] = useState('');
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const t = setInterval(state.reload, 5000);
    return () => clearInterval(t);
  }, []);
  const st = state.data;
  if (!st) return null;
  const act = async (fn: () => Promise<{ sent: number; received: number; conflicts: number }>) => {
    setBusy(true);
    try {
      const r = await fn();
      toast.ok(`Synchronisé : ${r.sent} envoyée(s), ${r.received} reçue(s)${r.conflicts ? `, ${r.conflicts} conflit(s)` : ''}`);
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
      state.reload();
      conflicts.reload();
    }
  };
  return (
    <div className="narrow">
      <p>
        Le serveur central relie les caisses et les magasins : chaque PC garde sa propre base et continue de vendre sans réseau, les opérations
        partent toutes les 20 secondes dès que la connexion revient.
      </p>
      {st.connected ? (
        <>
          <table className="list">
            <tbody>
              <tr>
                <th>Serveur</th>
                <td>{st.url}</td>
              </tr>
              <tr>
                <th>Dernière synchronisation</th>
                <td>{st.lastSyncAt ? dateTime(st.lastSyncAt) : 'jamais'}</td>
              </tr>
              <tr>
                <th>Opérations en attente d'envoi</th>
                <td>{st.pending}</td>
              </tr>
              <tr>
                <th>État</th>
                <td className={st.lastError ? 'neg' : 'pos'}>{st.lastError ?? 'Connecté'}</td>
              </tr>
            </tbody>
          </table>
          <div className="actions">
            {isAdmin && (
              <button
                disabled={busy}
                onClick={async () => {
                  if (!confirm('Délier ce PC du serveur central ? Les ventes resteront sur ce PC sans être partagées.')) return;
                  try {
                    await call('sync.disconnect');
                    state.reload();
                  } catch (err) {
                    toast.error(err);
                  }
                }}
              >
                Délier ce PC
              </button>
            )}
            <button className="primary" disabled={busy} onClick={() => act(() => call('sync.now'))}>
              Synchroniser maintenant
            </button>
          </div>
        </>
      ) : isAdmin ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void act(() => call('sync.connect', url, key));
          }}
        >
          <div className="grid2">
            <Field label="Adresse du serveur" hint="ex. https://superette.mondomaine.cm">
              <input value={url} onChange={(e) => setUrl(e.target.value)} required />
            </Field>
            <Field label="Clé d'enrôlement" hint="ENROLLMENT_KEY configurée sur le serveur">
              <input type="password" value={key} onChange={(e) => setKey(e.target.value)} required />
            </Field>
          </div>
          <div className="actions">
            <button className="primary" type="submit" disabled={busy}>
              {busy ? 'Envoi de l’historique…' : 'Relier ce PC au serveur'}
            </button>
          </div>
        </form>
      ) : (
        <p className="muted">Ce PC n'est pas relié au serveur central. Demandez à l'administrateur de le faire.</p>
      )}
      {(conflicts.data ?? []).length > 0 && (
        <>
          <h3>Conflits à vérifier</h3>
          <table className="list">
            <thead>
              <tr>
                <th>Date</th>
                <th>Élément</th>
                <th>Problème</th>
              </tr>
            </thead>
            <tbody>
              {conflicts.data!.map((c) => (
                <tr key={c.id}>
                  <td>{dateTime(c.at)}</td>
                  <td>{c.entity}</td>
                  <td>{c.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

const ACTION_LABELS: Record<string, string> = {
  'auth.login': 'Connexion',
  'auth.failed': 'Échec de connexion',
  'sale.cancel': 'Annulation de ticket',
  'sale.return': 'Retour client',
  'sale.discount': 'Remise',
  'cash.open': 'Ouverture de caisse',
  'cash.close': 'Clôture Z',
  'cash.in': 'Apport espèces',
  'cash.out': 'Prélèvement',
  'stock.receive': 'Réception',
  'stock.loss': 'Sortie en perte',
  'stock.transfer': 'Transfert',
  'stock.inventory': 'Inventaire',
  'article.create': 'Création article',
  'article.update': 'Modification article',
  'price.store': 'Prix magasin',
  'user.create': 'Création utilisateur',
  'user.update': 'Modification utilisateur',
  'store.create': 'Création magasin',
  'store.update': 'Modification magasin',
  'register.create': 'Création caisse',
};

function Audit() {
  const log = useLoad(() => call('admin.audit'));
  return (
    <table className="list">
      <thead>
        <tr>
          <th>Date</th>
          <th>Utilisateur</th>
          <th>Action</th>
          <th>Détails</th>
        </tr>
      </thead>
      <tbody>
        {(log.data ?? []).map((a) => (
          <tr key={a.id}>
            <td>{dateTime(a.at)}</td>
            <td>{a.user_name ?? '—'}</td>
            <td>{ACTION_LABELS[a.action] ?? a.action}</td>
            <td className="details">{a.details}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

type BackupInfo = Result<'backup.list'>[number];

const KIND_LABELS: Record<BackupInfo['kind'], string> = { auto: 'Automatique', manual: 'Manuelle', safety: 'Avant restauration' };
const size = (bytes: number) => (bytes >= 1_048_576 ? `${(bytes / 1_048_576).toFixed(1).replace('.', ',')} Mo` : `${Math.max(1, Math.round(bytes / 1024))} Ko`);

/** Sauvegardes de la base de ce PC : automatique chaque jour, copie sur clé USB, restauration. */
function Backups({ isAdmin, onChanged }: { isAdmin: boolean; onChanged: () => void }) {
  const toast = useToast();
  const status = useLoad(() => call('backup.status'));
  const [busy, setBusy] = useState(false);
  const [keep, setKeep] = useState('');
  const [restoring, setRestoring] = useState<BackupInfo | null>(null);
  const st = status.data;
  useEffect(() => {
    if (st) setKeep(String(st.keep));
  }, [st?.keep]);
  if (!st) return null;
  const run = async (fn: () => Promise<BackupInfo | null>, ok: string) => {
    setBusy(true);
    try {
      const info = await fn();
      if (info) toast.ok(`${ok} : ${info.name} (${size(info.size)})`);
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
      status.reload();
      onChanged();
    }
  };
  const configure = (input: { dir?: string | null; copyDir?: string | null; keep?: number }) =>
    call('backup.configure', input).then(() => {
      toast.ok('Réglage enregistré');
      status.reload();
    }, toast.error);
  const choose = async (title: string, key: 'dir' | 'copyDir') => {
    const dir = await call('backup.chooseFolder', title);
    if (dir) await configure({ [key]: dir });
  };
  return (
    <div>
      <p>
        La base de ce PC est copiée chaque jour, pendant que la caisse travaille. Gardez aussi une copie hors du PC (clé USB, dossier OneDrive ou Google
        Drive) : en cas de vol ou de panne du disque, c'est elle qui sauve les ventes, le stock et la comptabilité.
      </p>
      <table className="list narrow">
        <tbody>
          <tr>
            <th>Dernière sauvegarde</th>
            <td>
              {st.last_at ? dateTime(st.last_at) : 'Jamais'}{' '}
              {st.overdue && <span className="tag rupture">En retard</span>}
            </td>
          </tr>
          {st.last_error && (
            <tr>
              <th>Problème</th>
              <td className="danger-text">{st.last_error}</td>
            </tr>
          )}
          <tr>
            <th>Dossier des sauvegardes</th>
            <td>
              <code>{st.dir}</code>{' '}
              <button onClick={() => st.dir && call('backup.openFolder', st.dir).catch(toast.error)}>Ouvrir</button>{' '}
              {isAdmin && <button onClick={() => void choose('Dossier des sauvegardes automatiques', 'dir')}>Changer</button>}
            </td>
          </tr>
          <tr>
            <th>Copie de chaque sauvegarde vers</th>
            <td>
              {st.copy_dir ? <code>{st.copy_dir}</code> : <span className="muted">aucun second dossier</span>}{' '}
              {isAdmin && (
                <>
                  <button onClick={() => void choose('Clé USB ou dossier OneDrive / Google Drive', 'copyDir')}>{st.copy_dir ? 'Changer' : 'Choisir'}</button>{' '}
                  {st.copy_dir && <button onClick={() => void configure({ copyDir: null })}>Retirer</button>}
                </>
              )}
            </td>
          </tr>
          <tr>
            <th>Sauvegardes automatiques gardées</th>
            <td>
              {isAdmin ? (
                <form
                  className="filters"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void configure({ keep: Number(keep) });
                  }}
                >
                  <input inputMode="numeric" value={keep} onChange={(e) => setKeep(e.target.value)} style={{ width: 70 }} />
                  <span className="muted">les plus récentes (les sauvegardes manuelles ne sont jamais effacées)</span>
                  {Number(keep) !== st.keep && <button className="primary">Enregistrer</button>}
                </form>
              ) : (
                st.keep
              )}
            </td>
          </tr>
        </tbody>
      </table>
      <div className="actions" style={{ justifyContent: 'flex-start' }}>
        <button className="primary" disabled={busy} onClick={() => void run(() => call('backup.now'), 'Sauvegarde faite')}>
          Sauvegarder maintenant
        </button>
        <button disabled={busy} onClick={() => void run(() => call('backup.toFolder'), 'Copie faite')}>
          Copier sur une clé USB…
        </button>
        {isAdmin && (
          <button
            disabled={busy}
            onClick={() =>
              call('backup.chooseFile').then((info) => {
                if (!info) return;
                if (!info.ok) toast.error(info.error ?? 'Sauvegarde invalide');
                else setRestoring(info);
              }, toast.error)
            }
          >
            Restaurer depuis un fichier…
          </button>
        )}
      </div>
      <h3>Sauvegardes de ce dossier</h3>
      {st.backups.length === 0 ? (
        <Empty>Aucune sauvegarde pour l'instant. Cliquez sur « Sauvegarder maintenant » ci-dessus ; ensuite, une sauvegarde se fait chaque jour.</Empty>
      ) : (
        <table className="list compact">
          <thead>
            <tr>
              <th>Date</th>
              <th>Type</th>
              <th>Magasin</th>
              <th className="r">Articles</th>
              <th className="r">Tickets</th>
              <th>Dernière vente</th>
              <th className="r">Taille</th>
              <th>État</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {st.backups.map((b) => (
              <tr key={b.file}>
                <td title={b.name}>{dateTime(b.created_at)}</td>
                <td>{KIND_LABELS[b.kind]}</td>
                <td>{b.store_name}</td>
                <td className="r">{b.articles}</td>
                <td className="r">{b.sales}</td>
                <td>{b.last_sale_at ? dateTime(b.last_sale_at) : '-'}</td>
                <td className="r">{size(b.size)}</td>
                <td>{b.ok ? <span className="tag normal">Vérifiée</span> : <span className="tag rupture" title={b.error ?? ''}>Inutilisable</span>}</td>
                <td className="r">
                  {isAdmin && b.ok && (
                    <button className="danger" onClick={() => setRestoring(b)}>
                      Restaurer
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {restoring && <RestoreDialog backup={restoring} onClose={() => setRestoring(null)} />}
    </div>
  );
}

function RestoreDialog({ backup, onClose }: { backup: BackupInfo; onClose: () => void }) {
  const toast = useToast();
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Modal title="Restaurer une sauvegarde" onClose={onClose}>
      <p>
        La base de ce PC va être remplacée par la sauvegarde du <strong>{dateTime(backup.created_at)}</strong>
        {backup.store_name ? ` (${backup.store_name})` : ''} : {backup.articles} articles, {backup.sales} tickets
        {backup.last_sale_at ? `, dernière vente le ${dateTime(backup.last_sale_at)}` : ''}.
      </p>
      <p className="danger-text">
        Tout ce qui a été fait sur ce PC après cette date (ventes, réceptions, écritures) disparaît de ce PC. La base actuelle est d'abord copiée dans le
        dossier des sauvegardes (« Avant restauration ») pour pouvoir revenir en arrière. L'application redémarre ensuite.
      </p>
      <Field label="Tapez RESTAURER pour confirmer">
        <input value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus />
      </Field>
      <div className="actions">
        <button onClick={onClose}>Annuler</button>
        <button
          className="danger"
          disabled={typed.trim().toUpperCase() !== 'RESTAURER' || busy}
          onClick={() => {
            setBusy(true);
            call('backup.restore', backup.file).then(
              () => toast.ok('Restauration en cours, l’application redémarre…'),
              (err) => {
                setBusy(false);
                toast.error(err);
              },
            );
          }}
        >
          Restaurer et redémarrer
        </button>
      </div>
    </Modal>
  );
}

/**
 * Droits par rôle : l'administrateur coche, pour chaque rôle, les fenêtres et
 * les actions permises. L'administrateur a toujours tous les droits.
 */
