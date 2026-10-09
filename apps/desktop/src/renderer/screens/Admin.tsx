import { CODEPAGES, type Codepage, PERMISSIONS, PERMISSION_KEYS, type Permission } from '@superette/core';
import { useEffect, useState } from 'react';
import { type Result, call } from '../api';
import { ROLE_LABELS } from '../App';
import { Empty, Field, Modal, Tabs, dateTime, useLoad, useToast } from '../ui';

type User = NonNullable<Result<'app.state'>['user']>;
type Role = User['role'];
export type AdminTab = Tab;
type Tab = 'stores' | 'registers' | 'warehouses' | 'users' | 'rights' | 'settings' | 'backups' | 'server' | 'audit';

export function Admin({ user, onChanged, initialTab }: { user: User; onChanged: () => void; initialTab?: Tab }) {
  const [tab, setTab] = useState<Tab>(initialTab ?? (user.role === 'admin' ? 'stores' : 'users'));
  const tabs: [Tab, string][] = [
    ...(user.role === 'admin' ? ([['stores', 'Magasins']] as [Tab, string][]) : []),
    ['registers', 'Caisses'],
    ['warehouses', 'Dépôts'],
    ['users', 'Utilisateurs'],
    ['rights', 'Droits par rôle'],
    ['settings', 'Paramètres'],
    ['backups', 'Sauvegardes'],
    ['server', 'Serveur central'],
    ['audit', "Journal d'audit"],
  ];
  return (
    <div className="page">
      <header className="page-head">
        <h1>Administration</h1>
      </header>
      <Tabs value={tab} onChange={setTab} tabs={tabs} />
      {tab === 'stores' && <Stores onChanged={onChanged} />}
      {tab === 'registers' && <Registers isAdmin={user.role === 'admin'} onChanged={onChanged} />}
      {tab === 'warehouses' && <Warehouses />}
      {tab === 'users' && <Users currentRole={user.role} />}
      {tab === 'rights' && <Rights isAdmin={user.role === 'admin'} onChanged={onChanged} />}
      {tab === 'settings' && <Settings user={user} onChanged={onChanged} />}
      {tab === 'backups' && <Backups isAdmin={user.role === 'admin'} onChanged={onChanged} />}
      {tab === 'server' && <CentralServer isAdmin={user.role === 'admin'} />}
      {tab === 'audit' && <Audit />}
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
  const [editing, setEditing] = useState<{ id: string; name: string; active: boolean } | null>(null);
  const assigned = (id: string) => (users.data ?? []).filter((u) => u.register_id === id && u.active === 1).map((u) => u.name);
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
        Chaque utilisateur vend sur la caisse qui lui est attribuée (Administration › Utilisateurs), depuis n'importe quel PC du magasin. Le code
        d'activation ne sert plus qu'à rattacher un nouveau PC au magasin.
      </p>
      <table className="list">
        <thead>
          <tr>
            <th>N°</th>
            <th>Nom</th>
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
              <td>{assigned(r.id).join(', ') || <span className="muted">personne</span>}</td>
              <td>
                <code>{r.activation_code}</code>
              </td>
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
              const r = await call('admin.createRegister', sid, newName.trim() || undefined);
              toast.ok(`${r.name} créée`);
              setNewName('');
              registers.reload();
              onChanged();
            } catch (err) {
              toast.error(err);
            }
          }}
        >
          <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Nom (facultatif), ex. Caisse boissons" />
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

function Warehouses() {
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
    </>
  );
}

function Users({ currentRole }: { currentRole: Role }) {
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
            <th />
          </tr>
        </thead>
        <tbody>
          {(users.data ?? []).map((u) => (
            <tr
              key={u.id}
              className={`clickable ${u.active ? '' : 'inactive'}`}
              onClick={() =>
                setForm({ id: u.id, name: u.name, login: u.login, pin: '', role: u.role, storeId: u.store_id ?? '', registerId: u.register_id ?? '', active: u.active === 1 })
              }
            >
              <td>{u.name}</td>
              <td>{u.login}</td>
              <td>{ROLE_LABELS[u.role]}</td>
              <td>{stores.data?.find((s) => s.id === u.store_id)?.name ?? 'Tous'}</td>
              <td>
                {registerLabel(u.register_id) ||
                  (sells(u.role) ? <span className="tag alerte">aucune : ne peut pas vendre</span> : <span className="muted">—</span>)}
              </td>
              <td>{!u.active && <span className="tag">désactivé</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="actions">
        <button className="primary" onClick={() => setForm({ name: '', login: '', pin: '', role: 'cashier', storeId: '', registerId: '', active: true })}>
          Ajouter un utilisateur
        </button>
      </div>
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
              <Field label={form.id ? 'Nouveau code (laisser vide pour garder)' : 'Code secret'} hint="4 à 8 chiffres">
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
                label="Caisse"
                hint={
                  sells(form.role)
                    ? 'Il vend sur cette caisse depuis n’importe quel PC. Sans caisse, il ne peut pas vendre.'
                    : 'Facultatif : sans caisse, le gérant choisit la sienne au moment de vendre.'
                }
              >
                <select value={form.registerId} onChange={(e) => setForm({ ...form, registerId: e.target.value })}>
                  <option value="">Aucune caisse</option>
                  {(registers.data ?? [])
                    .filter((r) => (r.active || r.id === form.registerId) && (!form.storeId || r.store_id === form.storeId))
                    .map((r) => (
                      <option key={r.id} value={r.id}>
                        {registerLabel(r.id)}
                      </option>
                    ))}
                </select>
              </Field>
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

/**
 * Réglages du magasin : TVA (administrateur seulement, elle change les prix
 * HT et la comptabilité), vente sans stock (droit « ignore_stock », le gérant
 * par défaut) et seuil d'écart de caisse à faire valider.
 */
function StoreOptionsPanel({ user, onChanged }: { user: User; onChanged: () => void }) {
  const toast = useToast();
  const state = useLoad(() => call('app.state'));
  const [threshold, setThreshold] = useState<string | null>(null);
  const store = state.data?.station?.store;
  if (!store) return null;
  const isAdmin = user.role === 'admin';
  const canStock = user.rights.includes('ignore_stock');
  const save = async (options: { vatEnabled?: boolean; ignoreStock?: boolean; cashGapThreshold?: number }, message: string) => {
    try {
      await call('admin.storeOptions', options);
      toast.ok(message);
      state.reload();
      onChanged();
    } catch (e) {
      toast.error(e);
    }
  };
  return (
    <>
      <h3>Magasin : {store.name}</h3>
      <label className="check">
        <input
          type="checkbox"
          disabled={!isAdmin}
          checked={store.vat_enabled === 1}
          onChange={(e) => {
            const on = e.target.checked;
            if (
              !confirm(
                on
                  ? 'Activer la TVA ? Les prochaines ventes, factures, achats et dépenses porteront la TVA (19,25 % par défaut). Les pièces déjà enregistrées ne changent pas.'
                  : 'Désactiver la TVA (régime simplifié) ? Les prochaines pièces seront sans TVA et porteront « TVA non applicable ». Les pièces déjà enregistrées ne changent pas.',
              )
            )
              return;
            void save({ vatEnabled: on }, on ? 'TVA activée' : 'TVA désactivée');
          }}
        />{' '}
        Magasin assujetti à la TVA (régime du réel)
      </label>
      <p className="muted">{isAdmin ? 'Ne s’applique qu’aux nouvelles pièces.' : 'Seul un administrateur peut changer ce réglage.'}</p>
      <label className="check">
        <input
          type="checkbox"
          disabled={!canStock}
          checked={store.ignore_stock === 1}
          onChange={(e) =>
            void save({ ignoreStock: e.target.checked }, e.target.checked ? 'Vente sans stock autorisée' : 'Gestion des stocks rétablie')
          }
        />{' '}
        Ignorer la gestion des stocks (vendre même si le stock en machine est épuisé)
      </label>
      <p className="muted">
        À cocher quand la marchandise est arrivée mais pas encore saisie. Le stock passe en négatif et la prochaine réception le régularise
        automatiquement. Pensez à décocher une fois les réceptions saisies.
      </p>
      <div className="grid2">
        <Field label="Écart de caisse toléré (FCFA)" hint="Au-delà, la clôture demande un motif et la validation du gérant">
          <input
            inputMode="numeric"
            disabled={!isAdmin}
            value={threshold ?? String(store.cash_gap_threshold)}
            onChange={(e) => setThreshold(e.target.value)}
            onBlur={() => {
              if (threshold === null) return;
              const n = Number(threshold.replace(/\s/g, ''));
              if (!Number.isInteger(n) || n < 0) return toast.error('Montant invalide');
              if (n !== store.cash_gap_threshold) void save({ cashGapThreshold: n }, 'Seuil d’écart enregistré');
              setThreshold(null);
            }}
          />
        </Field>
      </div>
    </>
  );
}

function Settings({ user, onChanged }: { user: User; onChanged: () => void }) {
  const toast = useToast();
  const settings = useLoad(() => call('admin.settings'));
  const printers = useLoad(() => call('admin.printers'));
  const [draft, setDraft] = useState<Record<string, string>>({});
  if (!settings.data) return null;
  const v = (k: string, d = '') => draft[k] ?? settings.data![k] ?? d;
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setDraft({ ...draft, [k]: e.target.value });
  const mode = v('printer.mode', 'driver');
  return (
    <div className="narrow">
      <StoreOptionsPanel user={user} onChanged={onChanged} />
      <h3>Imprimante ticket et tiroir-caisse</h3>
      <div className="grid2">
        <Field label="Mode d'impression" hint="ESC/POS : plus rapide, accents gérés, coupe du papier et tiroir">
          <select value={mode} onChange={set('printer.mode')}>
            <option value="driver">Pilote Windows (comme une imprimante normale)</option>
            <option value="windows">ESC/POS direct, imprimante USB installée sous Windows</option>
            <option value="network">ESC/POS direct, imprimante réseau (IP)</option>
          </select>
        </Field>
        {mode === 'network' ? (
          <>
            <Field label="Adresse IP de l'imprimante" hint="Imprimée sur la page d'autotest de l'imprimante">
              <input value={v('printer.host')} placeholder="192.168.1.100" onChange={set('printer.host')} />
            </Field>
            <Field label="Port">
              <input value={v('printer.port', '9100')} inputMode="numeric" onChange={set('printer.port')} />
            </Field>
          </>
        ) : (
          <Field label="Imprimante ticket">
            <select value={v('printer.name')} onChange={set('printer.name')}>
              <option value="">Imprimante par défaut de Windows</option>
              {(printers.data ?? []).map((p) => (
                <option key={p.name} value={p.name}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>
        )}
        {mode !== 'driver' && (
          <>
            <Field label="Largeur du papier">
              <select value={v('printer.columns', '48')} onChange={set('printer.columns')}>
                <option value="48">80 mm (48 caractères)</option>
                <option value="42">80 mm (42 caractères)</option>
                <option value="32">58 mm (32 caractères)</option>
              </select>
            </Field>
            <Field label="Table de caractères" hint="Si les accents sortent faux sur la page de test, essayez une autre table">
              <select value={v('printer.codepage', 'pc850')} onChange={set('printer.codepage')}>
                {(Object.keys(CODEPAGES) as Codepage[]).map((c) => (
                  <option key={c} value={c}>
                    {CODEPAGES[c].label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Coupe automatique du papier">
              <select value={v('printer.cut', '1')} onChange={set('printer.cut')}>
                <option value="1">Oui</option>
                <option value="0">Non (imprimante sans massicot)</option>
              </select>
            </Field>
          </>
        )}
        <Field label="Impression automatique du ticket">
          <select value={v('printer.enabled', '1')} onChange={set('printer.enabled')}>
            <option value="1">Oui</option>
            <option value="0">Non</option>
          </select>
        </Field>
        <Field label="Ouverture du tiroir-caisse" hint="Tiroir branché sur l'imprimante (prise RJ11)">
          <select value={v('drawer.mode', 'never')} onChange={set('drawer.mode')}>
            <option value="never">Jamais automatiquement</option>
            <option value="cash">À chaque encaissement en espèces</option>
            <option value="always">À chaque vente</option>
          </select>
        </Field>
        <Field label="Pied de ticket">
          <input value={v('ticket.footer', 'Merci de votre visite !')} onChange={set('ticket.footer')} />
        </Field>
      </div>
      <div className="actions">
        <button
          disabled={Object.keys(draft).length > 0}
          title={Object.keys(draft).length ? "Enregistrez d'abord les paramètres" : undefined}
          onClick={() => call('admin.printTest', false).then(() => toast.ok('Page de test envoyée'), toast.error)}
        >
          Imprimer une page de test
        </button>
        <button
          disabled={Object.keys(draft).length > 0}
          title={Object.keys(draft).length ? "Enregistrez d'abord les paramètres" : undefined}
          onClick={() => call('admin.printTest', true).then(() => toast.ok('Page de test envoyée, le tiroir doit s’ouvrir'), toast.error)}
        >
          Page de test et tiroir
        </button>
      </div>
      <h3>Étiquettes balance</h3>
      <div className="grid2">
        <Field label="Préfixes" hint="Séparés par des virgules, ex. 21,22">
          <input value={v('scale.prefixes', '21,22')} onChange={set('scale.prefixes')} />
        </Field>
        <Field label="La balance imprime">
          <select value={v('scale.valueType', 'price')} onChange={set('scale.valueType')}>
            <option value="price">le prix (FCFA)</option>
            <option value="weight">le poids (grammes)</option>
          </select>
        </Field>
      </div>
      <div className="actions">
        <button
          className="primary"
          disabled={!Object.keys(draft).length}
          onClick={async () => {
            try {
              await call('admin.saveSettings', draft);
              setDraft({});
              settings.reload();
              toast.ok('Paramètres enregistrés');
            } catch (err) {
              toast.error(err);
            }
          }}
        >
          Enregistrer
        </button>
      </div>
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
        <Empty>Aucune sauvegarde pour l'instant</Empty>
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
function Rights({ isAdmin, onChanged }: { isAdmin: boolean; onChanged: () => void }) {
  const toast = useToast();
  const matrix = useLoad(() => call('admin.rights'), []);
  const [draft, setDraft] = useState<Record<string, Permission[]> | null>(null);
  useEffect(() => {
    if (matrix.data) setDraft(Object.fromEntries(matrix.data.map((r) => [r.role, r.rights])));
  }, [matrix.data]);
  if (!matrix.data || !draft) return null;
  const changed = matrix.data.filter((r) => [...r.rights].sort().join() !== [...(draft[r.role] ?? [])].sort().join());
  const toggle = (role: string, perm: Permission, on: boolean) =>
    setDraft({ ...draft, [role]: on ? [...(draft[role] ?? []), perm] : (draft[role] ?? []).filter((p) => p !== perm) });
  const groups = [...new Set(PERMISSION_KEYS.map((k) => PERMISSIONS[k].group))];
  return (
    <>
      <p className="muted">
        Cochez ce que chaque rôle peut ouvrir et faire. L'administrateur a toujours tous les droits. Un changement vaut pour tous les utilisateurs du rôle, à leur
        prochaine connexion.
      </p>
      <table className="list compact rights">
        <thead>
          <tr>
            <th>Droit</th>
            <th className="c">Administrateur</th>
            {matrix.data.map((r) => (
              <th key={r.role} className="c">
                {r.label}
              </th>
            ))}
          </tr>
        </thead>
        {groups.map((g) => (
          <tbody key={g}>
            <tr className="group">
              <th colSpan={matrix.data!.length + 2}>{g}</th>
            </tr>
            {PERMISSION_KEYS.filter((k) => PERMISSIONS[k].group === g).map((k) => (
              <tr key={k}>
                <td>{PERMISSIONS[k].label}</td>
                <td className="c">
                  <input type="checkbox" checked disabled />
                </td>
                {matrix.data!.map((r) => (
                  <td key={r.role} className="c">
                    <input type="checkbox" disabled={!isAdmin} checked={draft[r.role]?.includes(k) ?? false} onChange={(e) => toggle(r.role, k, e.target.checked)} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        ))}
      </table>
      <div className="actions">
        {!isAdmin && <span className="muted">Seul l'administrateur modifie les droits.</span>}
        <button className="ghost" disabled={!changed.length} onClick={() => setDraft(Object.fromEntries(matrix.data!.map((r) => [r.role, r.rights])))}>
          Annuler les changements
        </button>
        <button
          className="primary"
          disabled={!isAdmin || !changed.length}
          onClick={async () => {
            try {
              for (const r of changed) await call('admin.saveRights', r.role, draft[r.role] ?? []);
              toast.ok(`Droits enregistrés (${changed.map((r) => r.label).join(', ')})`);
              matrix.reload();
              onChanged();
            } catch (err) {
              toast.error(err);
            }
          }}
        >
          Enregistrer
        </button>
      </div>
    </>
  );
}
