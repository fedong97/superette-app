import { PERMISSIONS, PERMISSION_GROUPS, PERMISSION_KEYS, type Permission, type PermissionGroup } from '@superette/core';
import { useEffect, useMemo, useState } from 'react';
import { call } from '../api';
import { ROLE_LABELS } from '../App';
import { fold } from '../nav';
import { askConfirm, Empty, useLoad, useToast } from '../ui';

type Role = keyof typeof ROLE_LABELS;

/** Droits d'un groupe, ou ceux qui correspondent à la recherche (tous groupes confondus). */
function visibleRights(group: PermissionGroup, search: string): Permission[] {
  const words = fold(search).split(/\s+/).filter(Boolean);
  if (!words.length) return PERMISSION_KEYS.filter((k) => PERMISSIONS[k].group === group);
  return PERMISSION_KEYS.filter((k) => {
    const text = fold(`${PERMISSIONS[k].label} ${PERMISSIONS[k].group}`);
    return words.every((w) => text.includes(w));
  });
}

/** Liste des groupes à gauche et champ de recherche. */
function GroupPicker({ group, onGroup, search, onSearch, count }: { group: PermissionGroup; onGroup: (g: PermissionGroup) => void; search: string; onSearch: (s: string) => void; count?: (g: PermissionGroup) => number }) {
  return (
    <aside className="rights-groups">
      <input className="rights-search" placeholder="Critère de recherche" value={search} onChange={(e) => onSearch(e.target.value)} />
      <div className="rights-group-list">
        <div className="rights-group-head">Groupe</div>
        {PERMISSION_GROUPS.map((g) => (
          <button key={g} className={!search && g === group ? 'active' : ''} onClick={() => (onSearch(''), onGroup(g))}>
            <span>{g}</span>
            {count && count(g) > 0 && <small className="tag normal">{count(g)}</small>}
          </button>
        ))}
      </div>
    </aside>
  );
}

/** Utilisateurs actifs qui ont le droit sélectionné. */
function Holders({ permission, exclude }: { permission: Permission | null; exclude?: string }) {
  const holders = useLoad(() => (permission ? call('admin.holders', permission) : Promise.resolve([])), [permission]);
  return (
    <div className="rights-holders">
      <h3>Autres utilisateurs actifs ayant ce privilège</h3>
      {!permission ? (
        <p className="muted">Cliquez sur un privilège pour voir qui l'a.</p>
      ) : (
        <>
          <p className="muted">{PERMISSIONS[permission].label}</p>
          <table className="list compact">
            <thead>
              <tr>
                <th>N°</th>
                <th>Utilisateur</th>
                <th>Rôle</th>
              </tr>
            </thead>
            <tbody>
              {(holders.data ?? [])
                .filter((h) => h.id !== exclude)
                .map((h, i) => (
                  <tr key={h.id}>
                    <td>{i + 1}</td>
                    <td>{h.name}</td>
                    <td>{ROLE_LABELS[h.role]}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

/**
 * Droits par rôle : les groupes à gauche, les droits du groupe à droite avec
 * une colonne par rôle. Un changement vaut pour tous les utilisateurs du rôle.
 */
export function RoleRights({ isAdmin, onChanged }: { isAdmin: boolean; onChanged: () => void }) {
  const toast = useToast();
  const matrix = useLoad(() => call('admin.rights'), []);
  const [draft, setDraft] = useState<Record<string, Permission[]> | null>(null);
  const [group, setGroup] = useState<PermissionGroup>(PERMISSION_GROUPS[0]);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Permission | null>(null);
  useEffect(() => {
    if (matrix.data) setDraft(Object.fromEntries(matrix.data.map((r) => [r.role, r.rights])));
  }, [matrix.data]);
  const rows = useMemo(() => visibleRights(group, search), [group, search]);
  if (!matrix.data || !draft) return null;
  const changed = matrix.data.filter((r) => [...r.rights].sort().join() !== [...(draft[r.role] ?? [])].sort().join());
  const set = (role: string, perms: Permission[], on: boolean) => {
    const cur = new Set(draft[role] ?? []);
    for (const p of perms) on ? cur.add(p) : cur.delete(p);
    setDraft({ ...draft, [role]: PERMISSION_KEYS.filter((k) => cur.has(k)) });
  };
  const changedIn = (g: PermissionGroup) =>
    PERMISSION_KEYS.filter((k) => PERMISSIONS[k].group === g && matrix.data!.some((r) => r.rights.includes(k) !== (draft[r.role] ?? []).includes(k))).length;
  return (
    <>
      <p className="muted">
        Cochez ce que chaque rôle peut ouvrir et faire. L'administrateur a toujours tous les droits. Un changement vaut pour tous les utilisateurs du rôle, à leur
        prochaine connexion. Pour une seule personne, utilisez « Privilèges par utilisateur ».
      </p>
      <div className="rights-layout">
        <GroupPicker group={group} onGroup={setGroup} search={search} onSearch={setSearch} count={changedIn} />
        <div className="rights-main">
          <table className="list compact rights">
            <thead>
              <tr>
                <th>Privilège</th>
                <th>Type</th>
                <th className="c">Administrateur</th>
                {matrix.data.map((r) => (
                  <th key={r.role} className="c">
                    {r.label}
                  </th>
                ))}
              </tr>
              {rows.length > 1 && (
                <tr className="group">
                  <th colSpan={3}>{search ? `${rows.length} privilège(s) trouvé(s)` : `Tout le groupe « ${group} »`}</th>
                  {matrix.data.map((r) => {
                    const all = rows.every((k) => draft[r.role]?.includes(k));
                    return (
                      <th key={r.role} className="c">
                        <input type="checkbox" disabled={!isAdmin} checked={all} title={all ? 'Tout décocher' : 'Tout cocher'} onChange={() => set(r.role, rows, !all)} />
                      </th>
                    );
                  })}
                </tr>
              )}
            </thead>
            <tbody>
              {rows.map((k) => (
                <tr key={k} className={`clickable ${selected === k ? 'selected' : ''}`} onClick={() => setSelected(k)}>
                  <td>
                    {PERMISSIONS[k].label}
                    {search && <small className="muted"> · {PERMISSIONS[k].group}</small>}
                  </td>
                  <td>{PERMISSIONS[k].type}</td>
                  <td className="c">
                    <input type="checkbox" checked disabled />
                  </td>
                  {matrix.data!.map((r) => (
                    <td key={r.role} className="c" onClick={(e) => e.stopPropagation()}>
                      <input type="checkbox" disabled={!isAdmin} checked={draft[r.role]?.includes(k) ?? false} onChange={(e) => set(r.role, [k], e.target.checked)} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {!rows.length && <Empty>Aucun privilège ne correspond. Essayez un autre mot.</Empty>}
          <Holders permission={selected} />
        </div>
      </div>
      <div className="actions">
        {!isAdmin && <span className="muted">Seul l'administrateur modifie les droits.</span>}
        {changed.length > 0 && <span className="muted">Rôles modifiés : {changed.map((r) => r.label).join(', ')}</span>}
        <button className="ghost" disabled={!changed.length} onClick={() => setDraft(Object.fromEntries(matrix.data!.map((r) => [r.role, r.rights])))}>
          Annuler les changements
        </button>
        <button
          className="primary"
          disabled={!isAdmin || !changed.length}
          onClick={async () => {
            try {
              for (const r of changed) await call('admin.saveRights', r.role, draft[r.role] ?? []);
              toast.ok('Droits enregistrés');
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

/**
 * Privilèges supplémentaires d'un utilisateur : en plus de ce que son rôle lui
 * donne (colonne grisée), on lui accorde ou on lui retire des droits à lui seul.
 */
export function UserPrivileges({ isAdmin, initialUserId, onChanged }: { isAdmin: boolean; initialUserId?: string | null; onChanged: () => void }) {
  const toast = useToast();
  const users = useLoad(() => call('admin.users'), []);
  const choices = (users.data ?? []).filter((u) => u.role !== 'admin' && u.active === 1);
  const [userId, setUserId] = useState<string | null>(initialUserId ?? null);
  const current = userId ?? choices[0]?.id ?? null;
  const priv = useLoad(() => (current ? call('admin.privileges', current) : Promise.resolve(null)), [current]);
  const [grants, setGrants] = useState<Permission[]>([]);
  const [revokes, setRevokes] = useState<Permission[]>([]);
  const [group, setGroup] = useState<PermissionGroup>(PERMISSION_GROUPS[0]);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Permission | null>(null);
  useEffect(() => {
    setGrants(priv.data?.grants ?? []);
    setRevokes(priv.data?.revokes ?? []);
  }, [priv.data]);
  const rows = useMemo(() => visibleRights(group, search), [group, search]);
  if (!users.data) return null;
  if (!choices.length) return <Empty>Aucun utilisateur à régler : créez d'abord les utilisateurs (l'administrateur a toujours tous les droits).</Empty>;
  const p = priv.data;
  const fromRole = new Set(p?.roleRights ?? []);
  const dirty = p && ([...grants].sort().join() !== [...p.grants].sort().join() || [...revokes].sort().join() !== [...p.revokes].sort().join());
  const toggle = (list: Permission[], setList: (l: Permission[]) => void, k: Permission, on: boolean) => setList(on ? [...list, k] : list.filter((x) => x !== k));
  const personal = (g: PermissionGroup) => PERMISSION_KEYS.filter((k) => PERMISSIONS[k].group === g && (grants.includes(k) || revokes.includes(k))).length;
  const name = choices.find((u) => u.id === current)?.name ?? '';
  return (
    <>
      <div className="filters">
        <label className="inline">
          Utilisateur{' '}
          <select
            value={current ?? ''}
            onChange={async (e) => {
              const next = e.target.value;
              if (dirty && !(await askConfirm('Les changements de cet utilisateur ne sont pas enregistrés. Les abandonner ?'))) return;
              setUserId(next);
              setSelected(null);
            }}
          >
            {choices.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name} ({ROLE_LABELS[u.role]})
              </option>
            ))}
          </select>
        </label>
        {p && (
          <span className="muted">
            {grants.length} privilège(s) accordé(s) en plus du rôle {ROLE_LABELS[p.role as Role]}, {revokes.length} retiré(s)
          </span>
        )}
      </div>
      <p className="muted">
        La colonne « Via son rôle » montre ce que le rôle donne déjà. Cochez « Attribué ? » pour accorder un droit à cette personne seulement, ou « Retiré » pour le
        lui enlever.
      </p>
      <div className="rights-layout">
        <GroupPicker group={group} onGroup={setGroup} search={search} onSearch={setSearch} count={personal} />
        <div className="rights-main">
          <table className="list compact rights">
            <thead>
              <tr>
                <th>Privilège</th>
                <th>Type</th>
                <th className="c">Via son rôle</th>
                <th className="c">Attribué ?</th>
                <th className="c">Retiré</th>
                <th className="c">Résultat</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((k) => {
                const role = fromRole.has(k);
                const result = (role && !revokes.includes(k)) || grants.includes(k);
                return (
                  <tr key={k} className={`clickable ${selected === k ? 'selected' : ''}`} onClick={() => setSelected(k)}>
                    <td>
                      {PERMISSIONS[k].label}
                      {search && <small className="muted"> · {PERMISSIONS[k].group}</small>}
                    </td>
                    <td>{PERMISSIONS[k].type}</td>
                    <td className="c">
                      <input type="checkbox" checked={role} disabled />
                    </td>
                    <td className="c" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        disabled={!isAdmin || role}
                        title={role ? 'Déjà donné par le rôle' : undefined}
                        checked={role ? false : grants.includes(k)}
                        onChange={(e) => toggle(grants, setGrants, k, e.target.checked)}
                      />
                    </td>
                    <td className="c" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        disabled={!isAdmin || !role}
                        title={!role ? 'Le rôle ne donne pas ce droit' : undefined}
                        checked={role && revokes.includes(k)}
                        onChange={(e) => toggle(revokes, setRevokes, k, e.target.checked)}
                      />
                    </td>
                    <td className="c">{result ? <span className="tag normal">Oui</span> : <span className="muted">Non</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {!rows.length && <Empty>Aucun privilège ne correspond. Essayez un autre mot.</Empty>}
          <Holders permission={selected} exclude={current ?? undefined} />
        </div>
      </div>
      <div className="actions">
        {!isAdmin && <span className="muted">Seul l'administrateur modifie les privilèges.</span>}
        <button className="ghost" disabled={!dirty} onClick={() => p && (setGrants(p.grants), setRevokes(p.revokes))}>
          Annuler les changements
        </button>
        <button
          className="primary"
          disabled={!isAdmin || !dirty || !current}
          onClick={async () => {
            try {
              await call('admin.savePrivileges', current!, { grants, revokes });
              toast.ok(`Privilèges de ${name} enregistrés : ils valent à sa prochaine connexion`);
              priv.reload();
              users.reload();
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
