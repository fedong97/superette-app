import { useEffect, useState } from 'react';
import { type Result, call } from '../api';
import { ROLE_LABELS } from '../App';
import { Field, Modal, Tabs, dateTime, useLoad, useToast } from '../ui';

type User = NonNullable<Result<'app.state'>['user']>;
type Role = User['role'];
export type AdminTab = Tab;
type Tab = 'stores' | 'registers' | 'warehouses' | 'users' | 'settings' | 'server' | 'audit';

export function Admin({ user, onChanged, initialTab }: { user: User; onChanged: () => void; initialTab?: Tab }) {
  const [tab, setTab] = useState<Tab>(initialTab ?? (user.role === 'admin' ? 'stores' : 'users'));
  const tabs: [Tab, string][] = [
    ...(user.role === 'admin' ? ([['stores', 'Magasins']] as [Tab, string][]) : []),
    ['registers', 'Caisses'],
    ['warehouses', 'Dépôts'],
    ['users', 'Utilisateurs'],
    ['settings', 'Paramètres'],
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
      {tab === 'settings' && <Settings />}
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
  const [code, setCode] = useState('');
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
        <span className="muted">Ce poste : {state.data?.station?.register?.name ?? 'non activé comme caisse'}</span>
      </div>
      <table className="list">
        <thead>
          <tr>
            <th>N°</th>
            <th>Nom</th>
            <th>Code d'activation</th>
            <th>Activée le</th>
          </tr>
        </thead>
        <tbody>
          {(registers.data ?? []).map((r) => (
            <tr key={r.id}>
              <td>{r.number}</td>
              <td>{r.name}</td>
              <td>
                <code>{r.activation_code}</code>
              </td>
              <td>{r.activated_at ? dateTime(r.activated_at) : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="actions">
        {isAdmin && (
          <button
            className="primary"
            onClick={async () => {
              try {
                const r = await call('admin.createRegister', sid);
                toast.ok(`${r.name} créée, code d'activation ${r.activation_code}`);
                registers.reload();
              } catch (err) {
                toast.error(err);
              }
            }}
          >
            Ajouter une caisse
          </button>
        )}
      </div>
      <h3>Activer ce poste comme caisse</h3>
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
  const [form, setForm] = useState<null | { id?: string; name: string; login: string; pin: string; role: Role; storeId: string; active: boolean }>(null);
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
            <th />
          </tr>
        </thead>
        <tbody>
          {(users.data ?? []).map((u) => (
            <tr
              key={u.id}
              className={`clickable ${u.active ? '' : 'inactive'}`}
              onClick={() => setForm({ id: u.id, name: u.name, login: u.login, pin: '', role: u.role, storeId: u.store_id ?? '', active: u.active === 1 })}
            >
              <td>{u.name}</td>
              <td>{u.login}</td>
              <td>{ROLE_LABELS[u.role]}</td>
              <td>{stores.data?.find((s) => s.id === u.store_id)?.name ?? 'Tous'}</td>
              <td>{!u.active && <span className="tag">désactivé</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="actions">
        <button className="primary" onClick={() => setForm({ name: '', login: '', pin: '', role: 'cashier', storeId: '', active: true })}>
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
                  await call('admin.updateUser', form.id, { name: form.name, role: form.role, storeId: form.storeId || null, active: form.active, pin: form.pin || undefined });
                } else {
                  await call('admin.createUser', { name: form.name, login: form.login, pin: form.pin, role: form.role, storeId: form.storeId || null });
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

function Settings() {
  const toast = useToast();
  const settings = useLoad(() => call('admin.settings'));
  const printers = useLoad(() => call('admin.printers'));
  const [draft, setDraft] = useState<Record<string, string>>({});
  if (!settings.data) return null;
  const v = (k: string, d = '') => draft[k] ?? settings.data![k] ?? d;
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setDraft({ ...draft, [k]: e.target.value });
  return (
    <div className="narrow">
      <h3>Impression</h3>
      <div className="grid2">
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
        <Field label="Impression automatique du ticket">
          <select value={v('printer.enabled', '1')} onChange={set('printer.enabled')}>
            <option value="1">Oui</option>
            <option value="0">Non</option>
          </select>
        </Field>
        <Field label="Pied de ticket">
          <input value={v('ticket.footer', 'Merci de votre visite !')} onChange={set('ticket.footer')} />
        </Field>
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
