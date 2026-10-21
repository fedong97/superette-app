import { BACKUP_FREQUENCIES, type Permission, type RegisterKind } from '@superette/core';
import { useEffect, useState } from 'react';
import { type Result, call } from '../api';
import { ROLE_LABELS } from '../App';
import { askConfirm, Empty, Field, Modal, Tabs, dateTime, today, useCan, useLoad, useToast } from '../ui';
import { RoleRights, UserPrivileges } from './AdminRights';
import { Digest } from './AdminDigest';
import { MobilePay } from './AdminMobilePay';
import { Settings } from './AdminSettings';
import { BrandAndBadge, UserPhotoField } from './AdminBrand';
import { PrintTemplates } from './PrintTemplates';
import { FiscalYears } from './Accounting';
import { Fiches, Repair } from './Dossiers';
import { RemoteTills } from './RemoteTills';
import { ShopTemplates } from './ShopTemplates';
import { Takeover } from './Takeover';
import contract from '../../../build/contrat-licence.txt?raw';
import serverLogo from '../assets/logo-serveur.png';

type User = NonNullable<Result<'app.state'>['user']>;
type Role = User['role'];
export type AdminTab = Tab;
type Tab = 'stores' | 'registers' | 'warehouses' | 'users' | 'rights' | 'privileges' | 'settings' | 'templates' | 'backups' | 'server' | 'license' | 'digest' | 'audit' | 'fiscal' | 'updates' | 'mobilepay' | 'fiches' | 'repair' | 'shopTemplates' | 'relay' | 'takeover' | 'brand';

export function Admin({ user, onChanged, initialTab }: { user: User; onChanged: () => void; initialTab?: Tab }) {
  const [tab, setTab] = useState<Tab>(initialTab ?? (user.role === 'admin' ? 'stores' : 'users'));
  // Utilisateur ouvert depuis la liste (« Privilèges… ») dans l'onglet des privilèges.
  const [privUser, setPrivUser] = useState<string | null>(null);
  // Modèle ouvert depuis Paramètres (« Modifier… ») dans l'onglet des modèles.
  const [editTpl, setEditTpl] = useState<string | null>(null);
  const can = (p: Permission) => user.rights.includes(p);
  const tabs: [Tab, string][] = [
    ...(user.role === 'admin' ? ([['stores', 'Magasins']] as [Tab, string][]) : []),
    ['registers', 'Caisses'],
    ['warehouses', 'Dépôts'],
    ['users', 'Utilisateurs'],
    ['rights', 'Droits par rôle'],
    ['privileges', 'Privilèges par utilisateur'],
    ['settings', 'Paramètres'],
    ['brand', 'Couleurs et badges'],
    ...(can('accounting') || can('fiscal_years') ? ([['fiscal', 'Exercices comptables']] as [Tab, string][]) : []),
    ['templates', "Modèles d'impression"],
    ...(can('backups') ? ([['backups', 'Sauvegardes']] as [Tab, string][]) : []),
    ...(user.role === 'admin' || can('accounting_export') ? ([['fiches', 'Fiches boutique']] as [Tab, string][]) : []),
    ...(user.role === 'admin' ? ([['shopTemplates', 'Modèles de boutique']] as [Tab, string][]) : []),
    ...(can('data_takeover') ? ([['takeover', 'Reprise des données']] as [Tab, string][]) : []),
    ...(user.role === 'admin' || can('cash') ? ([['relay', 'Postes distants']] as [Tab, string][]) : []),
    ...(user.role === 'admin' ? ([['repair', 'Réparation']] as [Tab, string][]) : []),
    ...(can('settings_edit') ? ([['mobilepay', 'Paiement mobile']] as [Tab, string][]) : []),
    ['server', 'Serveur central'],
    ['updates', 'Mises à jour'],
    ['license', 'Licence'],
    ...(can('dashboard') ? ([['digest', 'Résumé du jour']] as [Tab, string][]) : []),
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
      {tab === 'settings' && (
        <Settings
          user={user}
          onChanged={onChanged}
          onEditTemplate={(id) => {
            setEditTpl(id);
            setTab('templates');
          }}
        />
      )}
      {tab === 'brand' && <BrandAndBadge canEdit={can('settings_edit')} onChanged={onChanged} />}
      {tab === 'fiscal' && (can('accounting') || can('fiscal_years')) && <FiscalYears />}
      {tab === 'templates' && <PrintTemplates key={editTpl ?? ''} user={user} initialEdit={editTpl} />}
      {tab === 'backups' && can('backups') && <Backups isAdmin={user.role === 'admin'} onChanged={onChanged} />}
      {tab === 'fiches' && (user.role === 'admin' || can('accounting_export')) && <Fiches user={user} onChanged={onChanged} />}
      {tab === 'shopTemplates' && user.role === 'admin' && <ShopTemplates />}
      {tab === 'takeover' && can('data_takeover') && <Takeover />}
      {tab === 'relay' && (user.role === 'admin' || can('cash')) && <RemoteTills isAdmin={user.role === 'admin'} />}
      {tab === 'repair' && user.role === 'admin' && <Repair onBackups={() => setTab('backups')} />}
      {tab === 'mobilepay' && can('settings_edit') && <MobilePay />}
      {tab === 'server' && <CentralServer isAdmin={user.role === 'admin'} />}
      {tab === 'updates' && <SoftwareUpdates isAdmin={user.role === 'admin'} />}
      {tab === 'license' && <License isAdmin={user.role === 'admin'} onChanged={onChanged} />}
      {tab === 'digest' && can('dashboard') && <Digest isAdmin={user.role === 'admin'} />}
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
        <button data-new title="Ctrl+J" className="primary" onClick={() => setForm({ storeCode: '', storeName: '', address: '', phone: '', taxpayerNumber: '' })}>
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
          <button data-new title="Ctrl+J" className="primary" type="submit">
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

type WarehouseRow = Result<'admin.warehouses'>[number];
const WAREHOUSE_KINDS = { shop: 'Surface de vente', reserve: 'Réserve', cold: 'Chambre froide' } as const;

/**
 * Dépôts du magasin : créer, modifier (nom, type, responsable), désactiver ou
 * réactiver, et choisir le dépôt d'où sortent les ventes. Un dépôt désactivé
 * garde son historique ; il faut d'abord le vider de son stock.
 */
function Warehouses({ canCreate }: { canCreate: boolean }) {
  const toast = useToast();
  const [showInactive, setShowInactive] = useState(false);
  const wh = useLoad(() => call('admin.warehouses', { includeInactive: true }));
  const [name, setName] = useState('');
  const [kind, setKind] = useState<WarehouseRow['kind']>('reserve');
  const [editing, setEditing] = useState<WarehouseRow | null>(null);
  const all = wh.data ?? [];
  const inactive = all.filter((w) => !w.active).length;
  const shown = all.filter((w) => showInactive || w.active);
  const act = async (fn: () => Promise<unknown>, done: string) => {
    try {
      await fn();
      toast.ok(done);
      wh.reload();
    } catch (err) {
      toast.error(err);
    }
  };
  return (
    <>
      <div className="filters">
        <span className="muted">
          {all.length - inactive} dépôt{all.length - inactive > 1 ? 's' : ''} actif{all.length - inactive > 1 ? 's' : ''}
          {inactive ? ` · ${inactive} désactivé${inactive > 1 ? 's' : ''}` : ''}
        </span>
        {inactive > 0 && (
          <label className="inline">
            <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} /> Afficher les dépôts désactivés
          </label>
        )}
      </div>
      <table className="list">
        <thead>
          <tr>
            <th>Dépôt</th>
            <th>Type</th>
            <th>Responsable</th>
            <th>Téléphone</th>
            <th />
            {canCreate && <th />}
          </tr>
        </thead>
        <tbody>
          {shown.map((w) => (
            <tr key={w.id} className={w.active ? '' : 'inactive'}>
              <td>
                <b>{w.name}</b>
                {w.address && <small className="muted block">{w.address}</small>}
              </td>
              <td>{WAREHOUSE_KINDS[w.kind]}</td>
              <td>{w.manager ?? ''}</td>
              <td>{w.phone ?? ''}</td>
              <td>
                {w.is_sales_default ? <span className="tag normal">Dépôt des ventes</span> : ''}
                {!w.active && <span className="tag">désactivé</span>}
              </td>
              {canCreate && (
                <td className="r nowrap">
                  {w.active ? (
                    <>
                      <button onClick={() => setEditing(w)}>Modifier</button>
                      {!w.is_sales_default && (
                        <button
                          title="Les ventes de la caisse sortiront de ce dépôt"
                          onClick={async () => {
                            if (!(await askConfirm(`Faire de « ${w.name} » le dépôt des ventes ? Les ventes de la caisse sortiront désormais de ce dépôt.`))) return;
                            void act(() => call('admin.setSalesWarehouse', w.id), `${w.name} est le dépôt des ventes`);
                          }}
                        >
                          Dépôt des ventes
                        </button>
                      )}
                      {!w.is_sales_default && (
                        <button
                          className="ghost"
                          onClick={async () => {
                            if (!(await askConfirm(`Désactiver « ${w.name} » ? Il n'apparaîtra plus dans les ventes, achats, transferts ni inventaires ; son historique est gardé.`))) return;
                            void act(() => call('admin.setWarehouseActive', w.id, false), `${w.name} désactivé`);
                          }}
                        >
                          Désactiver
                        </button>
                      )}
                    </>
                  ) : (
                    <button onClick={() => void act(() => call('admin.setWarehouseActive', w.id, true), `${w.name} réactivé`)}>Réactiver</button>
                  )}
                </td>
              )}
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
            {Object.entries(WAREHOUSE_KINDS).map(([k, v]) => (
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
      {editing && (
        <WarehouseForm
          warehouse={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            wh.reload();
          }}
        />
      )}
    </>
  );
}

function WarehouseForm({ warehouse, onClose, onSaved }: { warehouse: WarehouseRow; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [f, setF] = useState({ name: warehouse.name, kind: warehouse.kind, manager: warehouse.manager ?? '', phone: warehouse.phone ?? '', address: warehouse.address ?? '' });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  return (
    <Modal title={`Modifier le dépôt « ${warehouse.name} »`} onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await call('admin.updateWarehouse', warehouse.id, f);
            toast.ok('Dépôt enregistré');
            onSaved();
          } catch (err) {
            toast.error(err);
          }
        }}
      >
        <div className="grid2">
          <Field label="Nom du dépôt">
            <input autoFocus value={f.name} onChange={set('name')} required maxLength={60} />
          </Field>
          <Field label="Type">
            <select value={f.kind} onChange={set('kind')}>
              {Object.entries(WAREHOUSE_KINDS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Responsable">
            <input value={f.manager} onChange={set('manager')} />
          </Field>
          <Field label="Téléphone">
            <input value={f.phone} onChange={set('phone')} inputMode="tel" />
          </Field>
        </div>
        <Field label="Adresse">
          <input value={f.address} onChange={set('address')} />
        </Field>
        <p className="muted small">Le nouveau nom s'affiche aussi dans l'historique : mouvements, transferts et inventaires passés.</p>
        <div className="actions">
          <button type="button" className="ghost" onClick={onClose}>
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

function Users({ currentRole, canManage, onPrivileges }: { currentRole: Role; canManage: boolean; onPrivileges: (id: string) => void }) {
  const toast = useToast();
  const users = useLoad(() => call('admin.users'));
  const stores = useLoad(() => call('admin.stores'));
  // Caisses de tous les magasins : un utilisateur reçoit celle de son magasin.
  const registers = useLoad(
    () => (stores.data ? Promise.all(stores.data.map((st) => call('admin.registers', st.id))).then((l) => l.flat()) : Promise.resolve([])),
    [stores.data],
  );
  const warehouses = useLoad(() => call('admin.warehouses'), []);
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
    /** Dépôts de vente cochés ; null = selon le droit « vendre depuis un autre dépôt ». */
    saleWarehouses: string[] | null;
    active: boolean;
    badge: string | null;
    /** Nouvel employé : fiche collaborateur créée en même temps (null : pas de fiche). */
    staff: { position: string; phone: string; baseSalary: string; hiredOn: string } | null;
    makeBadge: boolean;
  }>(null);
  const canStaff = useCan()('staff_edit');
  const editBadge = async (id: string, renew: boolean) => {
    if (renew && !(await askConfirm("Refaire le badge ? L'ancien badge ne permettra plus de se connecter."))) return;
    try {
      const u = await call('admin.newBadge', id);
      setForm((f) => (f ? { ...f, badge: u.badge ?? null } : f));
      users.reload();
      toast.ok('Badge créé : imprimez-le');
    } catch (e) {
      toast.error(e);
    }
  };
  const remove = async (id: string, name: string) => {
    if (!(await askConfirm(`Supprimer ${name} ? Il ne pourra plus se connecter et disparaîtra des listes. Ses tickets et écritures passés gardent son nom.`))) return;
    try {
      const r = await call('admin.deleteUser', id);
      toast.ok(r.erased ? `${name} est supprimé` : `${name} est supprimé (gardé pour l’historique de ses ventes)`);
      setForm(null);
      users.reload();
    } catch (e) {
      toast.error(e);
    }
  };
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
                  saleWarehouses: u.sale_warehouses ? (JSON.parse(u.sale_warehouses) as string[]) : null,
                  active: u.active === 1,
                  badge: u.badge ?? null,
                  staff: null,
                  makeBadge: false,
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
          <button data-new title="Ctrl+J" className="primary" onClick={() =>
              setForm({
                name: '',
                login: '',
                pin: '',
                role: 'cashier',
                storeId: '',
                registerId: '',
                emoneyRegisterId: '',
                bankRegisterId: '',
                saleWarehouses: null,
                active: true,
                badge: null,
                staff: canStaff ? { position: '', phone: '', baseSalary: '', hiredOn: today() } : null,
                makeBadge: true,
              })
            }
          >
            Ajouter un employé
          </button>
        </div>
      )}
      {form && (
        <Modal title={form.id ? form.name : 'Nouvel employé'} onClose={() => setForm(null)} wide={!form.id}>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                if (form.id) {
                  await call('admin.updateUser', form.id, {
                    name: form.name,
                    login: form.login,
                    role: form.role,
                    storeId: form.storeId || null,
                    registerId: form.registerId || null,
                    emoneyRegisterId: form.emoneyRegisterId || null,
                    bankRegisterId: form.bankRegisterId || null,
                    saleWarehouses: form.saleWarehouses,
                    active: form.active,
                    pin: form.pin || undefined,
                  });
                } else {
                  const salary = form.staff?.baseSalary ? Number(form.staff.baseSalary.replace(/\s/g, '')) : 0;
                  if (form.staff && (!Number.isSafeInteger(salary) || salary < 0)) throw new Error('Salaire de base : un montant en FCFA');
                  const r = await call('admin.hire', {
                    user: {
                      name: form.name,
                      login: form.login,
                      pin: form.pin,
                      role: form.role,
                      storeId: form.storeId || null,
                      registerId: form.registerId || null,
                      emoneyRegisterId: form.emoneyRegisterId || null,
                      bankRegisterId: form.bankRegisterId || null,
                      saleWarehouses: form.saleWarehouses,
                    },
                    staff: form.staff
                      ? { position: form.staff.position || null, phone: form.staff.phone || null, baseSalary: salary, hiredOn: form.staff.hiredOn || null }
                      : null,
                    badge: form.makeBadge,
                  });
                  toast.ok(`${r.user.name} est enregistré${r.staff ? ', avec sa fiche collaborateur' : ''}`);
                  if (r.user.badge && (await askConfirm('Imprimer son badge maintenant ?'))) await call('admin.printBadge', r.user.id);
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
                <input value={form.login} onChange={(e) => setForm({ ...form, login: e.target.value })} required />
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
              {(warehouses.data?.length ?? 0) > 1 && (
                <Field
                  label="Dépôts de vente"
                  hint="À la facturation, il voit le stock de ces dépôts ; ce qui manque dans le dépôt choisi se complète dans les autres."
                >
                  <label className="inline">
                    <input
                      type="checkbox"
                      checked={form.saleWarehouses !== null}
                      onChange={(e) => setForm({ ...form, saleWarehouses: e.target.checked ? [] : null })}
                    />{' '}
                    Choisir ses dépôts
                  </label>
                  {form.saleWarehouses === null ? (
                    <small className="muted">Selon son droit : tous les dépôts s’il peut « vendre depuis un autre dépôt », sinon la surface de vente.</small>
                  ) : (
                    warehouses.data!.map((w) => (
                      <label key={w.id} className="inline">
                        <input
                          type="checkbox"
                          disabled={w.is_sales_default === 1}
                          checked={w.is_sales_default === 1 || form.saleWarehouses!.includes(w.id)}
                          onChange={(e) =>
                            setForm({ ...form, saleWarehouses: e.target.checked ? [...form.saleWarehouses!, w.id] : form.saleWarehouses!.filter((x) => x !== w.id) })
                          }
                        />{' '}
                        {w.name}
                      </label>
                    ))
                  )}
                </Field>
              )}
              {form.id && (
                <label className="inline">
                  <input type="checkbox" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} /> Compte actif
                </label>
              )}
              {form.id && <UserPhotoField userId={form.id} canEdit={canManage} />}
              {form.id ? (
                <Field label="Badge" hint="Scanné sur l'écran de connexion, il remplit l'identifiant : il ne reste que le code à taper.">
                  {form.badge ? (
                    <span>
                      <code>{form.badge}</code>{' '}
                      <button type="button" onClick={() => call('admin.printBadge', form.id!).catch(toast.error)}>
                        Imprimer
                      </button>{' '}
                      <button type="button" className="ghost" onClick={() => void editBadge(form.id!, true)}>
                        Refaire
                      </button>
                    </span>
                  ) : (
                    <button type="button" onClick={() => void editBadge(form.id!, false)}>
                      Créer son badge
                    </button>
                  )}
                </Field>
              ) : (
                <label className="inline">
                  <input type="checkbox" checked={form.makeBadge} onChange={(e) => setForm({ ...form, makeBadge: e.target.checked })} /> Lui faire un badge (carte à
                  code-barres pour se connecter)
                </label>
              )}
            </div>
            {!form.id && canStaff && (
              <fieldset className="box">
                <legend>
                  <label className="inline">
                    <input
                      type="checkbox"
                      checked={form.staff !== null}
                      onChange={(e) => setForm({ ...form, staff: e.target.checked ? { position: '', phone: '', baseSalary: '', hiredOn: today() } : null })}
                    />{' '}
                    Créer aussi sa fiche collaborateur (salaire, avances, pointage)
                  </label>
                </legend>
                {form.staff && (
                  <div className="grid2">
                    <Field label="Poste">
                      <input value={form.staff.position} placeholder="Caissière, vendeur…" onChange={(e) => setForm({ ...form, staff: { ...form.staff!, position: e.target.value } })} />
                    </Field>
                    <Field label="Téléphone">
                      <input value={form.staff.phone} inputMode="tel" onChange={(e) => setForm({ ...form, staff: { ...form.staff!, phone: e.target.value } })} />
                    </Field>
                    <Field label="Salaire de base (FCFA)">
                      <input value={form.staff.baseSalary} inputMode="numeric" onChange={(e) => setForm({ ...form, staff: { ...form.staff!, baseSalary: e.target.value } })} />
                    </Field>
                    <Field label="Date d'entrée">
                      <input type="date" value={form.staff.hiredOn} onChange={(e) => setForm({ ...form, staff: { ...form.staff!, hiredOn: e.target.value } })} />
                    </Field>
                  </div>
                )}
              </fieldset>
            )}
            <div className="actions">
              <button className="primary" type="submit">
                Enregistrer
              </button>
              {form.id && (
                <button type="button" className="danger" onClick={() => void remove(form.id!, form.name)}>
                  Supprimer l'utilisateur
                </button>
              )}
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}

const PLAN_LABELS = { monthly: 'Mensuelle', annual: 'Annuelle', lifetime: 'À vie' } as const;
const frDay = (d: string) => d.split('-').reverse().join('/');

/**
 * Licence de ce PC : le code machine à envoyer à l'éditeur, puis la clé qu'il
 * renvoie, collée ici par l'administrateur.
 */
function License({ isAdmin, onChanged }: { isAdmin: boolean; onChanged: () => void }) {
  const toast = useToast();
  const status = useLoad(() => call('license.status'));
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [showContract, setShowContract] = useState(false);
  const st = status.data;
  if (!st) return null;
  const lic = st.license;
  const digits = lic?.contact?.replace(/\D/g, '') ?? '';
  const whatsapp = `https://wa.me/${digits.length >= 8 ? digits : ''}?text=${encodeURIComponent(`Bonjour, voici le code machine de mon PC pour la licence FEDONIX 360 : ${st.machineCode}`)}`;
  return (
    <div className="narrow">
      <p>
        FEDONIX 360 s'utilise avec une licence liée à ce PC. Envoyez le code machine à votre fournisseur ; il vous renvoie une clé de licence à
        coller ci-dessous. Les autres PC reliés au serveur central reçoivent la licence tout seuls.{' '}
        <button type="button" className="link" onClick={() => setShowContract(true)}>
          Lire le contrat de licence
        </button>
      </p>
      {showContract && (
        <Modal title="Contrat de licence" wide onClose={() => setShowContract(false)}>
          <pre className="contract">{contract.replace(/^\uFEFF/, '').replace(/\r/g, '')}</pre>
        </Modal>
      )}
      <p className={st.canSell ? (st.warn ? 'warn-text' : 'pos') : 'neg'}>
        <strong>{st.message}</strong>
      </p>
      <table className="list">
        <tbody>
          <tr>
            <th>Code machine de ce PC</th>
            <td>
              <strong style={{ fontSize: 18, letterSpacing: 1 }}>{st.machineCode}</strong>{' '}
              <button
                type="button"
                onClick={() =>
                  navigator.clipboard
                    .writeText(st.machineCode)
                    .then(() => toast.ok('Code machine copié'))
                    .catch(() => toast.error(new Error('Copie impossible : recopiez le code à la main')))
                }
              >
                Copier
              </button>{' '}
              <a href={whatsapp} target="_blank" rel="noreferrer">
                Envoyer par WhatsApp
              </a>
            </td>
          </tr>
          {lic && (
            <>
              <tr>
                <th>Client</th>
                <td>{lic.client}</td>
              </tr>
              <tr>
                <th>Formule</th>
                <td>{PLAN_LABELS[lic.plan]}</td>
              </tr>
              <tr>
                <th>Validité</th>
                <td>{lic.expires ? `du ${frDay(lic.start)} au ${frDay(lic.expires)}` : `depuis le ${frDay(lic.start)}, sans fin`}</td>
              </tr>
              <tr>
                <th>PC et magasins permis</th>
                <td>
                  {lic.stations} PC, {lic.stores} magasin(s)
                </td>
              </tr>
              <tr>
                <th>N° de licence</th>
                <td>{lic.id}</td>
              </tr>
              {lic.contact && (
                <tr>
                  <th>Renouvellement</th>
                  <td>{lic.contact}</td>
                </tr>
              )}
            </>
          )}
        </tbody>
      </table>
      {isAdmin ? (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            try {
              const r = await call('license.activate', key);
              toast.ok(r.message);
              setKey('');
              status.reload();
              onChanged();
            } catch (err) {
              toast.error(err);
            } finally {
              setBusy(false);
            }
          }}
        >
          <Field label="Clé de licence" hint="Collez la clé reçue en entier (elle commence par SG1.)">
            <textarea rows={4} value={key} onChange={(e) => setKey(e.target.value)} required spellCheck={false} style={{ fontFamily: 'monospace', width: '100%' }} />
          </Field>
          <div className="actions">
            <button className="primary" disabled={busy || !key.trim()}>
              Activer la licence
            </button>
          </div>
        </form>
      ) : (
        <p className="muted">Seul l'administrateur active une licence.</p>
      )}
    </div>
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
        <img src={serverLogo} alt="" width={56} height={56} style={{ float: 'left', marginRight: 12 }} />
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
                  if (!(await askConfirm('Délier ce PC du serveur central ? Les ventes resteront sur ce PC sans être partagées.'))) return;
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
            {isAdmin && (
              <button
                disabled={busy}
                title="Produits, rayons, dépôts, utilisateurs, stock et inventaires que le serveur n'a pas (serveur réinstallé, sauvegarde restaurée)"
                onClick={async () => {
                  setBusy(true);
                  try {
                    const r = await call('sync.resend');
                    toast.ok(r.queued ? `${r.queued} donnée(s) renvoyée(s) au serveur` : 'Le serveur avait déjà toutes les données de ce PC');
                  } catch (err) {
                    toast.error(err);
                  } finally {
                    setBusy(false);
                    state.reload();
                  }
                }}
              >
                Renvoyer au serveur ce qui lui manque
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
            <Field label="Adresse du serveur" hint="ex. http://192.168.1.20:3000 (affichée dans FEDONIX 360 Serveur)">
              <input value={url} onChange={(e) => setUrl(e.target.value)} required />
            </Field>
            <Field label="Clé d'enrôlement" hint="affichée dans FEDONIX 360 Serveur, onglet Réglages">
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

const UPDATE_STATUS: Record<string, string> = {
  idle: 'Pas encore vérifié',
  checking: 'Vérification…',
  none: 'Ce PC a la dernière version',
  downloading: 'Téléchargement de la nouvelle version…',
  ready: 'Nouvelle version prête',
  error: 'Vérification impossible',
};

/** Mise à jour automatique : version de ce PC, adresse lue, état et installation. */
function SoftwareUpdates({ isAdmin }: { isAdmin: boolean }) {
  const toast = useToast();
  const state = useLoad(() => call('update.state'));
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const t = setInterval(state.reload, 3000);
    return () => clearInterval(t);
  }, []);
  const st = state.data;
  if (st === undefined) return null;
  if (st === null || !st.enabled) {
    return <p className="muted narrow">La mise à jour automatique ne fonctionne que dans le logiciel installé (pas en mode développement).</p>;
  }
  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true);
    try {
      await fn();
      if (ok) toast.ok(ok);
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
      state.reload();
    }
  };
  return (
    <div className="narrow">
      <p>
        FEDONIX 360 se met à jour tout seul : il cherche une nouvelle version au démarrage puis toutes les 4 heures, la télécharge sans gêner la caisse et
        l'installe à la prochaine fermeture du logiciel. Les nouvelles versions se déposent dans FEDONIX 360 Serveur, onglet « Mises à jour ».
      </p>
      <table className="list">
        <tbody>
          <tr>
            <th>Version de ce PC</th>
            <td>{st.version}</td>
          </tr>
          <tr>
            <th>Adresse des mises à jour</th>
            <td>{st.url ?? <span className="muted">aucune : reliez ce PC au serveur central ou saisissez une adresse ci-dessous</span>}</td>
          </tr>
          <tr>
            <th>État</th>
            <td className={st.status === 'error' ? 'neg' : st.status === 'ready' ? 'pos' : ''}>
              {UPDATE_STATUS[st.status]}
              {st.status === 'downloading' && ` ${st.available} (${st.percent} %)`}
              {st.status === 'ready' && ` : ${st.available}`}
              {st.status === 'error' && st.error && <div className="muted">{st.error}</div>}
            </td>
          </tr>
          <tr>
            <th>Dernière vérification</th>
            <td>{st.lastCheck ? dateTime(st.lastCheck) : 'jamais'}</td>
          </tr>
        </tbody>
      </table>
      <div className="actions">
        {isAdmin && (
          <button disabled={busy || !st.url || st.status === 'checking' || st.status === 'downloading'} onClick={() => run(() => call('update.check'))}>
            Vérifier maintenant
          </button>
        )}
        {st.status === 'ready' && (
          <button
            className="primary"
            disabled={busy}
            onClick={async () => {
              if (!(await askConfirm(`Fermer FEDONIX 360 et installer la version ${st.available} ? Le logiciel se rouvre tout seul après l'installation.`))) return;
              void run(() => call('update.install'));
            }}
          >
            Installer maintenant
          </button>
        )}
      </div>
      {isAdmin && (
        <>
          <h3>Adresse des mises à jour</h3>
          <p className="muted">
            Laissez vide pour utiliser le serveur central auquel ce PC est relié. Pour une boutique sans serveur, saisissez l'adresse internet où l'éditeur dépose
            les nouvelles versions.
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void run(() => call('update.setUrl', url ?? st.customUrl), 'Adresse enregistrée');
            }}
          >
            <Field label="Adresse (facultative)" hint="ex. https://mises-a-jour.fedonix360.cm/">
              <input value={url ?? st.customUrl} onChange={(e) => setUrl(e.target.value)} placeholder="Serveur central de ce PC" />
            </Field>
            <div className="actions">
              <button type="submit" disabled={busy}>
                Enregistrer l'adresse
              </button>
            </div>
          </form>
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
  'warehouse.update': 'Modification dépôt',
  'warehouse.disable': 'Dépôt désactivé',
  'warehouse.enable': 'Dépôt réactivé',
  'warehouse.sales_default': 'Dépôt des ventes changé',
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
  const configure = (input: { dir?: string | null; copyDir?: string | null; keep?: number; everyMinutes?: number }) =>
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
        La base de ce PC est copiée automatiquement (chaque jour, ou plus souvent selon la fréquence choisie), pendant que la caisse travaille. Gardez aussi une copie hors du PC (clé USB, dossier OneDrive ou Google
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
            <th>Sauvegarde automatique</th>
            <td>
              {isAdmin ? (
                <select value={st.every_minutes} onChange={(e) => void configure({ everyMinutes: Number(e.target.value) })}>
                  {BACKUP_FREQUENCIES.map(([m, label]) => (
                    <option key={m} value={m}>
                      {label}
                    </option>
                  ))}
                </select>
              ) : (
                BACKUP_FREQUENCIES.find(([m]) => m === st.every_minutes)?.[1]
              )}
              {st.auto_time && <span className="muted"> · et chaque jour à {st.auto_time}</span>}
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
      <CloudBackup isAdmin={isAdmin} onDownloaded={status.reload} />
      {restoring && <RestoreDialog backup={restoring} onClose={() => setRestoring(null)} />}
    </div>
  );
}

/**
 * Sauvegarde en ligne : après chaque sauvegarde, une copie chiffrée avec la
 * phrase secrète du magasin part sur le serveur central. Sans cette phrase,
 * personne (pas même l'éditeur) ne peut lire les copies.
 */
function CloudBackup({ isAdmin, onDownloaded }: { isAdmin: boolean; onDownloaded: () => void }) {
  const toast = useToast();
  const status = useLoad(() => call('backup.cloudStatus'));
  const [listing, setListing] = useState(false);
  const list = useLoad(() => (listing ? call('backup.cloudList') : Promise.resolve([])), [listing]);
  const [keyDialog, setKeyDialog] = useState(false);
  const [downloading, setDownloading] = useState<{ id: string; name: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const st = status.data;
  if (!st) return null;
  const toggle = async (on: boolean) => {
    try {
      await call('admin.saveStoreSettings', { cloudBackup: on });
      toast.ok(on ? 'Sauvegarde en ligne activée' : 'Sauvegarde en ligne arrêtée');
      status.reload();
    } catch (e) {
      toast.error(e);
    }
  };
  const sendNow = async () => {
    setBusy(true);
    try {
      const r = await call('backup.cloudNow');
      toast.ok(`Copie envoyée au serveur : ${r.name}`);
      if (listing) list.reload();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
      status.reload();
    }
  };
  return (
    <>
      <h3>Sauvegarde en ligne</h3>
      <p className="muted">
        Après chaque sauvegarde, une copie chiffrée de la base part sur le serveur central. En cas de vol, d'incendie ou de panne du PC, vous la récupérez sur un autre PC
        relié au serveur.
      </p>
      {!st.linked ? (
        <p className="muted">Ce PC n'est pas relié au serveur central (Administration › Serveur central) : la sauvegarde en ligne n'est pas disponible.</p>
      ) : (
        <>
          <table className="list narrow">
            <tbody>
              <tr>
                <th>Sauvegarde en ligne</th>
                <td>
                  {isAdmin ? (
                    <select value={st.enabled ? '1' : '0'} onChange={(e) => void toggle(e.target.value === '1')}>
                      <option value="1">Activée</option>
                      <option value="0">Arrêtée</option>
                    </select>
                  ) : st.enabled ? (
                    'Activée'
                  ) : (
                    'Arrêtée'
                  )}
                </td>
              </tr>
              <tr>
                <th>Phrase secrète</th>
                <td>
                  {st.hasKey ? <span className="tag normal">Enregistrée</span> : <span className="tag rupture">À choisir</span>}{' '}
                  {isAdmin && <button onClick={() => setKeyDialog(true)}>{st.hasKey ? 'Changer' : 'Choisir'}</button>}
                </td>
              </tr>
              <tr>
                <th>Dernier envoi</th>
                <td>
                  {!st.last ? (
                    'Jamais'
                  ) : st.last.ok ? (
                    <>
                      {dateTime(st.last.at)} <span className="tag normal">Réussi</span>
                    </>
                  ) : (
                    <>
                      {dateTime(st.last.at)} <span className="tag rupture">Échec</span> <span className="danger-text">{st.last.error}</span>
                    </>
                  )}
                </td>
              </tr>
            </tbody>
          </table>
          <div className="actions" style={{ justifyContent: 'flex-start' }}>
            <button className="primary" disabled={busy || !st.hasKey} onClick={() => void sendNow()}>
              Envoyer une copie maintenant
            </button>
            <button onClick={() => (listing ? list.reload() : setListing(true))}>Voir les copies en ligne</button>
          </div>
          {listing &&
            ((list.data ?? []).length === 0 ? (
              <p className="muted">Aucune copie en ligne.</p>
            ) : (
              <table className="list compact">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Fichier</th>
                    <th>Envoyée par</th>
                    <th className="r">Taille</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {(list.data ?? []).map((b) => (
                    <tr key={b.id}>
                      <td>{dateTime(b.at)}</td>
                      <td>{b.name}</td>
                      <td>{b.device ?? '-'}</td>
                      <td className="r">{size(b.size)}</td>
                      <td className="r">{isAdmin && <button onClick={() => setDownloading({ id: b.id, name: b.name })}>Récupérer</button>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ))}
        </>
      )}
      {keyDialog && (
        <CloudKeyDialog
          onClose={() => setKeyDialog(false)}
          onSaved={() => {
            setKeyDialog(false);
            status.reload();
          }}
        />
      )}
      {downloading && (
        <CloudDownloadDialog
          backup={downloading}
          onClose={() => setDownloading(null)}
          onDone={() => {
            setDownloading(null);
            onDownloaded();
          }}
        />
      )}
    </>
  );
}

function CloudKeyDialog({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [a, setA] = useState('');
  const [b, setB] = useState('');
  const save = async () => {
    if (a.length < 8) return toast.error('La phrase secrète doit faire au moins 8 caractères');
    if (a !== b) return toast.error('Les deux phrases ne sont pas identiques');
    try {
      await call('backup.cloudSetKey', a);
      toast.ok('Phrase secrète enregistrée');
      onSaved();
    } catch (e) {
      toast.error(e);
    }
  };
  return (
    <Modal title="Phrase secrète de la sauvegarde en ligne" onClose={onClose}>
      <p className="danger-text">
        Notez cette phrase et gardez-la en lieu sûr, hors du magasin. Sans elle, les sauvegardes en ligne ne peuvent pas être lues : l'éditeur ne la connaît pas et ne
        peut pas la retrouver.
      </p>
      <Field label="Phrase secrète (8 caractères au moins)">
        <input type="password" autoFocus value={a} onChange={(e) => setA(e.target.value)} />
      </Field>
      <Field label="Retapez la phrase secrète">
        <input type="password" value={b} onChange={(e) => setB(e.target.value)} />
      </Field>
      <div className="actions">
        <button onClick={onClose}>Fermer</button>
        <button className="primary" onClick={() => void save()}>
          Enregistrer
        </button>
      </div>
    </Modal>
  );
}

function CloudDownloadDialog({ backup, onClose, onDone }: { backup: { id: string; name: string }; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [pass, setPass] = useState('');
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try {
      const r = await call('backup.cloudDownload', backup.id, pass);
      toast.ok(`Sauvegarde ${r.name} récupérée : elle est dans la liste des sauvegardes, prête à restaurer`);
      onDone();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={`Récupérer ${backup.name}`} onClose={onClose}>
      <p>La copie est déchiffrée dans le dossier des sauvegardes de ce PC. Restaurez-la ensuite depuis la liste des sauvegardes.</p>
      <Field label="Phrase secrète du magasin">
        <input type="password" autoFocus value={pass} onChange={(e) => setPass(e.target.value)} />
      </Field>
      <div className="actions">
        <button onClick={onClose}>Fermer</button>
        <button className="primary" disabled={busy || !pass} onClick={() => void go()}>
          Récupérer
        </button>
      </div>
    </Modal>
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
