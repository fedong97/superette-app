import { useEffect, useRef, useState } from 'react';
import { PUNCH_METHODS, type PunchMethod, WARNING_KINDS, type WarningKind, whatsappLink } from '@superette/core';
import { type Result, call } from '../api';
import { askConfirm, askText, Empty, Field, Modal, dateFr, has, today, useLoad, useStoreSettings, useToast } from '../ui';
import { CameraDialog, readPortrait } from './AdminBrand';

type User = NonNullable<Result<'app.state'>['user']>;
type StaffRow = Result<'staff.list'>[number];
type Presence = Result<'punches.presence'>[number];
type Team = Result<'personnel.teams'>[number];
type Agency = Result<'personnel.agencies'>[number];

const hm = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : '');
const hours = (minutes: number) => `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')}`;
const WEEKDAYS: [string, string][] = [
  ['1', 'lun.'],
  ['2', 'mar.'],
  ['3', 'mer.'],
  ['4', 'jeu.'],
  ['5', 'ven.'],
  ['6', 'sam.'],
  ['0', 'dim.'],
];
const daysLabel = (days: string) =>
  days === '0123456'
    ? 'Tous les jours'
    : WEEKDAYS.filter(([d]) => days.includes(d))
        .map(([, l]) => l)
        .join(' ');

const STATES: Record<Presence['state'], string> = {
  present: 'Présent',
  late: 'En retard, pas encore arrivé',
  expected: 'Attendu',
  absent: 'Absent',
  left: 'Parti',
  leave: 'En congé',
  off: 'Repos',
};

/** Initiales à la place de la photo. */
const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('');

function StaffFace({ id, name, hasPhoto }: { id: string; name: string; hasPhoto: boolean }) {
  const photo = useLoad(() => (hasPhoto ? call('personnel.photo', id) : Promise.resolve(null)), [id, hasPhoto]);
  return photo.data ? <img src={photo.data} alt="" /> : <span className="ph">{initials(name)}</span>;
}

/**
 * Qui est là : le personnel du magasin maintenant, présent ou parti, attendu,
 * en retard, absent, en congé ou de repos. Se met à jour toutes les 30 secondes.
 */
export function PresenceBoard() {
  const list = useLoad(() => call('punches.presence'), []);
  const settings = useStoreSettings();
  useEffect(() => {
    const t = setInterval(list.reload, 30_000);
    return () => clearInterval(t);
  }, []);
  const rows = list.data ?? [];
  const count = (s: Presence['state']) => rows.filter((r) => r.state === s).length;
  const groups: [Presence['state'][], string][] = [
    [['late', 'absent'], 'À appeler'],
    [['present'], 'Présents'],
    [['expected'], 'Attendus'],
    [['left'], 'Partis'],
    [['leave', 'off'], 'En congé ou de repos'],
  ];
  return (
    <>
      <div className="staff-cards">
        <div>
          <small>Présents</small>
          <b>{count('present')}</b>
        </div>
        <div>
          <small>En retard</small>
          <b className={count('late') ? 'neg' : ''}>{count('late')}</b>
        </div>
        <div>
          <small>Absents</small>
          <b className={count('absent') ? 'neg' : ''}>{count('absent')}</b>
        </div>
        <div>
          <small>Partis</small>
          <b>{count('left')}</b>
        </div>
      </div>
      {settings.staffAlerts && <AlertsPanel reloadKey={list.data} />}
      <p className="muted">
        {settings.punchKiosk ? 'Passages à la borne de l’entrée' : 'Arrivées notées à la connexion au logiciel'}, comparés à l’horaire prévu de chacun{settings.staffTeams ? ' (équipe ou rotation)' : ''}. Mis à jour
        toutes les 30 secondes.
      </p>
      {rows.length ? (
        groups.map(([states, title]) => {
          const part = rows.filter((r) => states.includes(r.state));
          if (!part.length) return null;
          return (
            <section key={title}>
              <h3>
                {title} ({part.length})
              </h3>
              <div className="presence-grid">
                {part.map((r) => (
                  <div key={r.staff_id} className={`presence-card ${r.state}`}>
                    <StaffFace id={r.staff_id} name={r.name} hasPhoto={r.has_photo} />
                    <div>
                      <b>{r.name}</b>
                      <small className="muted block">{[r.position, r.category === 'contractor' ? r.agency_name : null, r.team].filter(Boolean).join(' · ')}</small>
                      <small className="block">
                        {r.state === 'present'
                          ? `Arrivé à ${hm(r.since)}${r.entrance ? `, ${r.entrance}` : ''}${r.late_minutes ? ` (retard ${r.late_minutes} min)` : ''}`
                          : r.state === 'left'
                            ? `Parti à ${hm(r.left_at)}`
                            : r.state === 'late'
                              ? `Prévu à ${r.expected_start} : ${r.late_minutes} min de retard`
                              : r.state === 'expected'
                                ? `Prévu de ${r.expected_start} à ${r.expected_end}`
                                : STATES[r.state]}
                      </small>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          );
        })
      ) : (
        <Empty>Aucun collaborateur actif. Ajoutez votre personnel dans l’onglet Collaborateurs, même ceux qui n’utilisent pas le logiciel.</Empty>
      )}
    </>
  );
}

/** Passages d'un jour : heure, arrivée ou départ, façon de pointer, entrée et photo ; annulation d'un passage en trop. */
export function DayPunches({ staffId, name, day, onClose, onChanged }: { staffId: string; name: string; day: string; onClose: () => void; onChanged: () => void }) {
  const toast = useToast();
  const list = useLoad(() => call('punches.day', staffId, day), [staffId, day]);
  const rows = list.data ?? [];
  return (
    <Modal title={`Passages de ${name}, ${dateFr(day)}`} onClose={onClose} wide>
      {rows.length ? (
        <>
          <table className="list">
            <thead>
              <tr>
                <th>Heure</th>
                <th>Passage</th>
                <th>Façon</th>
                <th>Entrée</th>
                <th>Note</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.id} className={p.status === 'cancelled' ? 'muted' : ''}>
                  <td>
                    {localDate(p.at) !== day ? `${dateFr(localDate(p.at))} ` : ''}
                    {hm(p.at)}
                  </td>
                  <td>{p.kind === 'in' ? 'Arrivée' : 'Départ'}</td>
                  <td>
                    {PUNCH_METHODS[p.method as PunchMethod] ?? p.method}
                    {p.method === 'manual' && p.user_name ? ` (${p.user_name})` : ''}
                  </td>
                  <td>{p.entrance_name ?? ''}</td>
                  <td>
                    {p.status === 'cancelled' && <span className="tag">annulé</span>} {p.reason ?? ''}
                  </td>
                  <td>
                    {p.status === 'active' && (
                      <button
                        className="link"
                        onClick={async () => {
                          const reason = await askText('Motif de l’annulation de ce passage (double badge, erreur…)');
                          if (!reason) return;
                          try {
                            await call('punches.cancel', p.id, reason);
                            list.reload();
                            onChanged();
                          } catch (e) {
                            toast.error(e);
                          }
                        }}
                      >
                        Annuler
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.some((p) => p.photo) && (
            <>
              <h3>Photos prises à la borne</h3>
              <div className="punch-photos">
                {rows
                  .filter((p) => p.photo)
                  .map((p) => (
                    <figure key={p.id}>
                      <img src={p.photo!} alt="" />
                      <figcaption>
                        {p.kind === 'in' ? 'Arrivée' : 'Départ'} {hm(p.at)}
                      </figcaption>
                    </figure>
                  ))}
              </div>
            </>
          )}
        </>
      ) : (
        <Empty>Aucun passage ce jour-là : seule la connexion au logiciel a été notée, ou rien.</Empty>
      )}
    </Modal>
  );
}

const localDate = (iso: string) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/**
 * Badge et pointage d'un collaborateur : photo, badge (créer, refaire,
 * imprimer), numéro et code tapés à la borne, et son équipe ou sa rotation.
 */
export function StaffPunchDialog({ staff, user, onClose, onChanged }: { staff: StaffRow; user: User; onClose: () => void; onChanged: () => void }) {
  const toast = useToast();
  const settings = useStoreSettings();
  const photo = useLoad(() => call('personnel.photo', staff.id), [staff.id]);
  const preview = useLoad(() => (staff.badge || staff.user_badge ? call('personnel.badgePreview', staff.id) : Promise.resolve(null)), [staff.id, staff.badge]);
  const teams = useLoad(() => (settings.staffTeams ? call('personnel.teams') : Promise.resolve([] as Team[])), []);
  const [pin, setPin] = useState('');
  const [camera, setCamera] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const rot = (() => {
    try {
      return staff.rotation ? (JSON.parse(staff.rotation) as { teams: string[]; start: string; weeks: number }) : null;
    } catch {
      return null;
    }
  })();
  const [teamMode, setTeamMode] = useState<'none' | 'team' | 'rotation'>(rot ? 'rotation' : staff.team_id ? 'team' : 'none');
  const [teamId, setTeamId] = useState(staff.team_id ?? '');
  const [rotation, setRotation] = useState(rot ?? { teams: [] as string[], start: today(), weeks: 1 });
  const canBadge = has(user, 'staff_badges');
  const canTeams = has(user, 'staff_teams');
  const code = staff.badge ?? staff.user_badge;
  const savePhoto = async (p: string | null) => {
    try {
      await call('personnel.setPhoto', staff.id, p);
      photo.reload();
      preview.reload();
      onChanged();
    } catch (e) {
      toast.error(e);
    }
  };
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      toast.ok(ok);
      onChanged();
    } catch (e) {
      toast.error(e);
    }
  };
  return (
    <Modal title={`Badge et pointage : ${staff.name}`} onClose={onClose} wide>
      <div className="grid2">
        <div>
          <h3>Photo</h3>
          <div className="inline">
            {photo.data ? <img className="staff-photo" src={photo.data} alt="" /> : <span className="staff-photo" />}
            <input
              ref={file}
              type="file"
              accept="image/*"
              hidden
              onChange={async (e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (f) readPortrait(f).then(savePhoto, toast.error);
              }}
            />
            <span>
              <button type="button" onClick={() => file.current?.click()} disabled={!has(user, 'staff_edit')}>
                Choisir une photo…
              </button>{' '}
              <button type="button" onClick={() => setCamera(true)} disabled={!has(user, 'staff_edit')}>
                Prendre avec la caméra…
              </button>{' '}
              {photo.data && (
                <button type="button" className="ghost" onClick={() => void savePhoto(null)} disabled={!has(user, 'staff_edit')}>
                  Retirer
                </button>
              )}
            </span>
          </div>
          <small className="muted block">Imprimée sur le badge et montrée à la borne quand la personne pointe.</small>

          <h3>Badge</h3>
          {code ? (
            <p>
              Code du badge : <b translate="no">{code}</b>
              {!staff.badge && staff.user_badge && <small className="muted block">Badge de son compte utilisateur : il sert aussi à se connecter au logiciel.</small>}
            </p>
          ) : (
            <p className="muted">Pas encore de badge.</p>
          )}
          <div className="inline">
            {canBadge && !staff.user_badge && (
              <button
                type="button"
                className={code ? '' : 'primary'}
                onClick={async () => {
                  if (staff.badge && !(await askConfirm('Refaire le badge ? L’ancien badge ne marchera plus à la borne.'))) return;
                  await run(() => call('personnel.newBadge', staff.id), staff.badge ? 'Nouveau badge créé : imprimez-le' : 'Badge créé : imprimez-le');
                }}
              >
                {staff.badge ? 'Refaire le badge' : 'Créer le badge'}
              </button>
            )}
            {canBadge && code && (
              <button type="button" onClick={() => call('personnel.printBadges', [staff.id]).catch(toast.error)}>
                Imprimer le badge
              </button>
            )}
          </div>

          {settings.punchPin && (
            <>
              <h3>Numéro et code de pointage</h3>
              <p>
                Numéro tapé à la borne : <b>{staff.punch_number ?? '—'}</b>{' '}
                {canBadge && (
                  <button type="button" className="link" onClick={() => run(() => call('personnel.newPunchNumber', staff.id), 'Nouveau numéro donné')}>
                    Nouveau numéro
                  </button>
                )}
              </p>
              <p className="muted">{staff.has_punch_pin ? 'Code de pointage enregistré.' : 'Pas encore de code de pointage.'}</p>
              {canBadge && (
                <form
                  className="inline"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void run(() => call('personnel.setPunchPin', staff.id, pin), 'Code de pointage enregistré').then(() => setPin(''));
                  }}
                >
                  <input type="password" inputMode="numeric" placeholder="4 à 8 chiffres" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} />
                  <button type="submit" disabled={pin.length < 4}>
                    {staff.has_punch_pin ? 'Changer le code' : 'Donner ce code'}
                  </button>
                  {Boolean(staff.has_punch_pin) && (
                    <button type="button" className="ghost" onClick={() => run(() => call('personnel.setPunchPin', staff.id, null), 'Code de pointage retiré')}>
                      Retirer
                    </button>
                  )}
                </form>
              )}
            </>
          )}

          {settings.staffTeams && (
            <>
              <h3>Équipe</h3>
              <Field label="Horaire">
                <select value={teamMode} disabled={!canTeams} onChange={(e) => setTeamMode(e.target.value as typeof teamMode)}>
                  <option value="none">Sa semaine type (Planning)</option>
                  <option value="team">Une équipe fixe</option>
                  <option value="rotation">Rotation entre équipes</option>
                </select>
              </Field>
              {teamMode === 'team' && (
                <Field label="Équipe">
                  <select value={teamId} disabled={!canTeams} onChange={(e) => setTeamId(e.target.value)}>
                    <option value="">Choisir…</option>
                    {(teams.data ?? []).map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name} ({t.start_time} → {t.end_time})
                      </option>
                    ))}
                  </select>
                </Field>
              )}
              {teamMode === 'rotation' && (
                <>
                  <Field label="Équipes, dans l’ordre de la rotation">
                    <span>
                      {(teams.data ?? []).map((t) => (
                        <label key={t.id} className="inline">
                          <input
                            type="checkbox"
                            disabled={!canTeams}
                            checked={rotation.teams.includes(t.id)}
                            onChange={(e) => setRotation({ ...rotation, teams: e.target.checked ? [...rotation.teams, t.id] : rotation.teams.filter((x) => x !== t.id) })}
                          />{' '}
                          {t.name}
                          {rotation.teams.includes(t.id) ? ` (${rotation.teams.indexOf(t.id) + 1})` : ''}
                        </label>
                      ))}
                    </span>
                  </Field>
                  <div className="grid2">
                    <Field label="Début de la rotation (un lundi)">
                      <input type="date" value={rotation.start} disabled={!canTeams} onChange={(e) => setRotation({ ...rotation, start: e.target.value })} />
                    </Field>
                    <Field label="Semaines par équipe">
                      <input type="number" min={1} max={8} value={rotation.weeks} disabled={!canTeams} onChange={(e) => setRotation({ ...rotation, weeks: Number(e.target.value) || 1 })} />
                    </Field>
                  </div>
                </>
              )}
              {canTeams && (
                <button
                  type="button"
                  onClick={() =>
                    run(
                      () =>
                        call('personnel.setTeam', staff.id, {
                          teamId: teamMode === 'team' ? teamId || null : null,
                          rotation: teamMode === 'rotation' ? rotation : null,
                        }),
                      'Horaire enregistré',
                    )
                  }
                >
                  Enregistrer l’horaire
                </button>
              )}
            </>
          )}
        </div>
        <div>
          <h3>Aperçu du badge</h3>
          {preview.data ? <iframe className="badge-frame" title="Aperçu du badge" sandbox="" srcDoc={preview.data} /> : <p className="muted">Créez le badge pour le voir ici.</p>}
        </div>
      </div>
      {camera && (
        <CameraDialog
          onClose={() => setCamera(false)}
          onTaken={(p) => {
            setCamera(false);
            void savePhoto(p);
          }}
        />
      )}
    </Modal>
  );
}

/** Pièces du dossier : CNI, contrat signé, certificat médical, avec leur fin de validité. */
export function DocumentsDialog({ staff, onClose }: { staff: { id: string; name: string }; onClose: () => void }) {
  const toast = useToast();
  const list = useLoad(() => call('personnel.documents', staff.id), [staff.id]);
  const [form, setForm] = useState<{ label: string; expiresOn: string; file: File | null }>({ label: '', expiresOn: '', file: null });
  const file = useRef<HTMLInputElement>(null);
  return (
    <Modal title={`Dossier de ${staff.name}`} onClose={onClose} wide>
      {(list.data ?? []).length ? (
        <table className="list">
          <thead>
            <tr>
              <th>Pièce</th>
              <th>Fichier</th>
              <th>Valable jusqu’au</th>
              <th>Ajoutée le</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(list.data ?? []).map((d) => (
              <tr key={d.id}>
                <td>
                  <b>{d.label}</b>
                </td>
                <td>{d.file_name ?? ''}</td>
                <td className={d.expires_on && d.expires_on < today() ? 'neg' : ''}>{d.expires_on ? dateFr(d.expires_on) : ''}</td>
                <td>
                  {dateFr(d.created_at.slice(0, 10))}
                  {d.user_name ? ` · ${d.user_name}` : ''}
                </td>
                <td className="nowrap">
                  <button
                    className="link"
                    onClick={async () => {
                      try {
                        const doc = await call('personnel.document', d.id);
                        const a = document.createElement('a');
                        a.href = doc.data;
                        a.download = doc.file_name ?? `${doc.label}${doc.data.startsWith('data:application/pdf') ? '.pdf' : '.jpg'}`;
                        a.click();
                      } catch (e) {
                        toast.error(e);
                      }
                    }}
                  >
                    Enregistrer sur le PC
                  </button>
                  <button
                    className="link"
                    onClick={async () => {
                      if (!(await askConfirm(`Retirer « ${d.label} » du dossier ?`))) return;
                      call('personnel.removeDocument', d.id).then(list.reload, toast.error);
                    }}
                  >
                    Retirer
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <Empty>Aucune pièce. Ajoutez la CNI, le contrat signé ou un certificat médical (photo ou PDF).</Empty>
      )}
      <h3>Ajouter une pièce</h3>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (!form.file) return;
          try {
            const data = await new Promise<string>((resolve, reject) => {
              const r = new FileReader();
              r.onerror = () => reject(new Error('Fichier illisible'));
              r.onload = () => resolve(String(r.result));
              r.readAsDataURL(form.file!);
            });
            await call('personnel.addDocument', staff.id, { label: form.label, fileName: form.file.name, data, expiresOn: form.expiresOn || null });
            setForm({ label: '', expiresOn: '', file: null });
            list.reload();
            toast.ok('Pièce ajoutée au dossier');
          } catch (err) {
            toast.error(err);
          }
        }}
      >
        <div className="desk-head two">
          <Field label="Pièce">
            <input list="staff-doc-kinds" value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} placeholder="CNI, contrat signé…" />
            <datalist id="staff-doc-kinds">
              <option value="CNI" />
              <option value="Contrat signé" />
              <option value="Certificat médical" />
              <option value="Casier judiciaire" />
              <option value="Diplôme" />
              <option value="Attestation CNPS" />
            </datalist>
          </Field>
          <Field label="Valable jusqu’au (facultatif)" hint="La fin de validité est signalée avant l’échéance.">
            <input type="date" value={form.expiresOn} onChange={(e) => setForm({ ...form, expiresOn: e.target.value })} />
          </Field>
          <Field label="Fichier (photo ou PDF, 1 Mo au plus)">
            <span>
              <input ref={file} type="file" accept="image/jpeg,image/png,image/webp,application/pdf" hidden onChange={(e) => setForm({ ...form, file: e.target.files?.[0] ?? null })} />
              <button type="button" onClick={() => file.current?.click()}>
                Choisir…
              </button>{' '}
              {form.file?.name ?? ''}
            </span>
          </Field>
        </div>
        <div className="actions">
          <button type="submit" className="primary" disabled={!form.label.trim() || !form.file}>
            Ajouter
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** Équipes (matin, soir, nuit), entrées du magasin et borne de ce PC. */
export function TeamsAndEntrances({ user }: { user: User }) {
  const settings = useStoreSettings();
  const toast = useToast();
  const teams = useLoad(() => (settings.staffTeams ? call('personnel.teams', true) : Promise.resolve([] as Team[])), [settings.staffTeams]);
  const entrances = useLoad(() => call('personnel.entrances', true), []);
  const kiosk = useLoad(() => call('kiosk.state'), []);
  const [edit, setEdit] = useState<Team | 'new' | null>(null);
  const canKiosk = has(user, 'staff_kiosk');
  return (
    <>
      {settings.staffTeams && (
        <section>
          <div className="toolbar">
            <h3>Équipes</h3>
            <span className="spacer" />
            <button className="primary" onClick={() => setEdit('new')}>
              Nouvelle équipe…
            </button>
          </div>
          <p className="muted">
            Une équipe a son horaire et ses jours. Une fin avant le début est une garde de nuit : elle finit le lendemain et compte pour le jour où elle commence. Chaque
            collaborateur reçoit une équipe fixe ou une rotation (Collaborateurs › Badge et pointage).
          </p>
          {(teams.data ?? []).length ? (
            <table className="list">
              <thead>
                <tr>
                  <th>Équipe</th>
                  <th>Horaire</th>
                  <th className="r">Durée</th>
                  <th>Jours</th>
                  <th className="r">Tolérance</th>
                  <th className="r">Membres</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {(teams.data ?? []).map((t) => (
                  <tr key={t.id} className={t.active ? '' : 'muted'} onDoubleClick={() => setEdit(t)}>
                    <td>
                      {t.color && <span className="swatch" style={{ background: t.color }} />} <b>{t.name}</b>
                      {!t.active && <span className="tag">Désactivée</span>}
                    </td>
                    <td>
                      {t.start_time} → {t.end_time}
                      {t.overnight && <small className="muted"> (le lendemain)</small>}
                    </td>
                    <td className="r">{hours(t.minutes)}</td>
                    <td>{daysLabel(t.days)}</td>
                    <td className="r">{t.tolerance === null ? `${settings.lateToleranceMinutes} min (magasin)` : `${t.tolerance} min`}</td>
                    <td className="r">{t.members || ''}</td>
                    <td>
                      <button className="link" onClick={() => setEdit(t)}>
                        Modifier
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <Empty action={{ label: 'Nouvelle équipe…', onClick: () => setEdit('new') }}>Aucune équipe. Créez par exemple Matin (06:00 → 14:00), Soir (14:00 → 22:00) et Nuit (22:00 → 06:00).</Empty>
          )}
        </section>
      )}

      {settings.multiEntrances && (
        <section>
          <div className="toolbar">
            <h3>Entrées du magasin</h3>
            <span className="spacer" />
            <button
              onClick={async () => {
                const name = await askText('Nom de la nouvelle entrée (Porte du dépôt, Entrée du personnel…)');
                if (name) call('personnel.saveEntrance', { name }).then(entrances.reload, toast.error);
              }}
            >
              Nouvelle entrée…
            </button>
          </div>
          <p className="muted">Chaque entrée peut avoir sa borne. Le pointage du mois indique par où chacun est passé.</p>
          <table className="list">
            <tbody>
              {(entrances.data ?? []).map((e) => (
                <tr key={e.id} className={e.active ? '' : 'muted'}>
                  <td>
                    <b>{e.name}</b> {!e.active && <span className="tag">Fermée</span>}
                  </td>
                  <td className="nowrap r">
                    <button
                      className="link"
                      onClick={async () => {
                        const name = await askText(`Nouveau nom de « ${e.name} »`);
                        if (name) call('personnel.saveEntrance', { name, active: Boolean(e.active) }, e.id).then(entrances.reload, toast.error);
                      }}
                    >
                      Renommer
                    </button>
                    <button className="link" onClick={() => call('personnel.saveEntrance', { name: e.name, active: !e.active }, e.id).then(entrances.reload, toast.error)}>
                      {e.active ? 'Fermer' : 'Rouvrir'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!(entrances.data ?? []).length && <p className="muted">L’entrée principale est créée au premier passage à la borne.</p>}
        </section>
      )}

      {settings.punchKiosk && canKiosk && (
        <section>
          <h3>Ce PC</h3>
          <p className="muted">
            Un PC réglé en borne affiche la borne de pointage à la place de l’écran de connexion : le personnel y passe son badge en arrivant et en partant. « Connexion au
            logiciel » reste en bas de la borne pour le gérant.
          </p>
          <Field label="Ce PC est la borne de pointage de">
            <select
              value={kiosk.data?.here ? (kiosk.data.entranceId ?? 'main') : ''}
              onChange={async (e) => {
                try {
                  await call('kiosk.configure', e.target.value || null);
                  kiosk.reload();
                  entrances.reload();
                  toast.ok(e.target.value ? 'Ce PC est maintenant une borne : elle s’affiche à la déconnexion' : 'Ce PC n’est plus une borne');
                } catch (err) {
                  toast.error(err);
                }
              }}
            >
              <option value="">Aucune entrée (PC ordinaire)</option>
              {settings.multiEntrances ? (
                (entrances.data ?? [])
                  .filter((x) => x.active)
                  .map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.name}
                    </option>
                  ))
              ) : (
                <option value={kiosk.data?.entranceId ?? 'main'}>L’entrée du magasin</option>
              )}
            </select>
          </Field>
        </section>
      )}
      {settings.fingerprint && <Fingerprints user={user} entrances={(entrances.data ?? []).filter((x) => x.active)} />}
      {!settings.staffTeams && !settings.multiEntrances && !settings.fingerprint && !(settings.punchKiosk && canKiosk) && (
        <Empty>Activez les équipes, plusieurs entrées, la borne ou la pointeuse à empreinte dans Administration › Paramètres › Pointage du personnel.</Empty>
      )}
      {edit && (
        <TeamDialog
          team={edit === 'new' ? null : edit}
          onClose={() => setEdit(null)}
          onDone={() => {
            setEdit(null);
            teams.reload();
          }}
        />
      )}
    </>
  );
}

function TeamDialog({ team, onClose, onDone }: { team: Team | null; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [f, setF] = useState({
    name: team?.name ?? '',
    start: team?.start_time ?? '08:00',
    end: team?.end_time ?? '17:00',
    days: team?.days ?? '123456',
    tolerance: team?.tolerance === null || team?.tolerance === undefined ? '' : String(team.tolerance),
    color: team?.color ?? '#16866b',
    active: team ? Boolean(team.active) : true,
  });
  return (
    <Modal title={team ? `Équipe ${team.name}` : 'Nouvelle équipe'} onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await call('personnel.saveTeam', { name: f.name, start: f.start, end: f.end, days: f.days, tolerance: f.tolerance === '' ? null : Number(f.tolerance), color: f.color, active: f.active }, team?.id ?? null);
            toast.ok('Équipe enregistrée');
            onDone();
          } catch (err) {
            toast.error(err);
          }
        }}
      >
        <Field label="Nom">
          <input autoFocus value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Matin, Soir, Nuit, Vigiles de jour…" />
        </Field>
        <div className="grid2">
          <Field label="Début">
            <input type="time" value={f.start} onChange={(e) => setF({ ...f, start: e.target.value })} />
          </Field>
          <Field label="Fin" hint={f.end <= f.start ? 'Garde de nuit : finit le lendemain' : undefined}>
            <input type="time" value={f.end} onChange={(e) => setF({ ...f, end: e.target.value })} />
          </Field>
        </div>
        <Field label="Jours travaillés">
          <span>
            {WEEKDAYS.map(([d, l]) => (
              <label key={d} className="inline">
                <input type="checkbox" checked={f.days.includes(d)} onChange={(e) => setF({ ...f, days: e.target.checked ? f.days + d : f.days.replace(d, '') })} /> {l}
              </label>
            ))}
          </span>
        </Field>
        <div className="grid2">
          <Field label="Tolérance de retard (minutes)" hint="Vide : celle du magasin.">
            <input inputMode="numeric" value={f.tolerance} onChange={(e) => setF({ ...f, tolerance: e.target.value.replace(/\D/g, '') })} />
          </Field>
          <Field label="Couleur au planning">
            <input type="color" value={f.color} onChange={(e) => setF({ ...f, color: e.target.value })} />
          </Field>
        </div>
        {team && (
          <label className="check">
            <input type="checkbox" checked={!f.active} onChange={(e) => setF({ ...f, active: !e.target.checked })} /> Équipe désactivée
          </label>
        )}
        <div className="actions">
          <button type="button" onClick={onClose}>
            Annuler
          </button>
          <button type="submit" className="primary" disabled={!f.name.trim() || !f.days}>
            Enregistrer
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** Sociétés prestataires (gardiennage, nettoyage) : leurs agents pointent, la société les paie. */
export function Agencies({ onAgents }: { onAgents: (agencyId: string) => void }) {
  const toast = useToast();
  const [inactive, setInactive] = useState(false);
  const list = useLoad(() => call('personnel.agencies', inactive), [inactive]);
  const [edit, setEdit] = useState<Agency | 'new' | null>(null);
  const rows = list.data ?? [];
  return (
    <>
      <div className="toolbar">
        <button data-new className="primary" onClick={() => setEdit('new')}>
          Nouvelle société…
        </button>
        <label className="check">
          <input type="checkbox" checked={inactive} onChange={(e) => setInactive(e.target.checked)} /> Voir aussi les anciennes
        </label>
      </div>
      <p className="muted">
        Les vigiles ou agents d’entretien fournis par une société ont leur fiche (catégorie « Agent d’une société prestataire ») et leur badge. Ils pointent comme les
        autres, sans salaire ni sous-compte : c’est leur société qui les paie. Le pointage du mois filtré par société sert à vérifier sa facture.
      </p>
      {rows.length ? (
        <table className="list">
          <thead>
            <tr>
              <th>Société</th>
              <th>Activité</th>
              <th>Contact</th>
              <th>Téléphone</th>
              <th>Fin du contrat</th>
              <th className="r">Agents</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((a) => (
              <tr key={a.id} className={a.active ? '' : 'muted'} onDoubleClick={() => setEdit(a)}>
                <td>
                  <b>{a.name}</b> {!a.active && <span className="tag">Ancienne</span>}
                </td>
                <td>{a.kind ?? ''}</td>
                <td>{a.contact ?? ''}</td>
                <td>{a.phone ?? ''}</td>
                <td className={a.contract_end && a.contract_end < today() ? 'neg' : ''}>{a.contract_end ? dateFr(a.contract_end) : ''}</td>
                <td className="r">{a.agents || ''}</td>
                <td className="nowrap">
                  <button className="link" onClick={() => setEdit(a)}>
                    Modifier
                  </button>
                  {a.agents > 0 && (
                    <button className="link" onClick={() => onAgents(a.id)}>
                      Pointage de ses agents
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <Empty action={{ label: 'Nouvelle société…', onClick: () => setEdit('new') }}>Aucune société prestataire. Ajoutez votre société de gardiennage ou de nettoyage.</Empty>
      )}
      {edit && (
        <AgencyDialog
          agency={edit === 'new' ? null : edit}
          onClose={() => setEdit(null)}
          onDone={() => {
            setEdit(null);
            list.reload();
          }}
        />
      )}
    </>
  );
}

function AgencyDialog({ agency, onClose, onDone }: { agency: Agency | null; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [f, setF] = useState({
    name: agency?.name ?? '',
    kind: agency?.kind ?? 'Gardiennage',
    contact: agency?.contact ?? '',
    phone: agency?.phone ?? '',
    address: agency?.address ?? '',
    contractEnd: agency?.contract_end ?? '',
    notes: agency?.notes ?? '',
    active: agency ? Boolean(agency.active) : true,
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <Modal title={agency ? agency.name : 'Nouvelle société prestataire'} onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await call('personnel.saveAgency', { ...f, contractEnd: f.contractEnd || null }, agency?.id ?? null);
            toast.ok('Société enregistrée');
            onDone();
          } catch (err) {
            toast.error(err);
          }
        }}
      >
        <div className="desk-head two">
          <Field label="Nom de la société">
            <input autoFocus value={f.name} onChange={set('name')} />
          </Field>
          <Field label="Activité">
            <input list="agency-kinds" value={f.kind} onChange={set('kind')} />
            <datalist id="agency-kinds">
              <option value="Gardiennage" />
              <option value="Nettoyage" />
              <option value="Manutention" />
              <option value="Livraison" />
            </datalist>
          </Field>
          <Field label="Personne à contacter">
            <input value={f.contact} onChange={set('contact')} />
          </Field>
          <Field label="Téléphone">
            <input value={f.phone} onChange={set('phone')} />
          </Field>
          <Field label="Adresse">
            <input value={f.address} onChange={set('address')} />
          </Field>
          <Field label="Fin du contrat de prestation" hint="Signalée avant l’échéance.">
            <input type="date" value={f.contractEnd} onChange={set('contractEnd')} />
          </Field>
        </div>
        <Field label="Notes">
          <input value={f.notes} onChange={set('notes')} placeholder="Nombre d’agents prévus, tarif, horaires du contrat…" />
        </Field>
        {agency && (
          <label className="check">
            <input type="checkbox" checked={!f.active} onChange={(e) => setF({ ...f, active: !e.target.checked })} /> Ne travaille plus avec le magasin
          </label>
        )}
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

type Alert = Result<'staffWatch.alerts'>[number];

/**
 * Retards et absences signalés : le message WhatsApp est prêt pour le
 * responsable, la société prestataire (envoyer un remplaçant) ou la personne.
 */
function AlertsPanel({ reloadKey }: { reloadKey: unknown }) {
  const settings = useStoreSettings();
  const toast = useToast();
  const alerts = useLoad(() => call('staffWatch.alerts'), [reloadKey]);
  const open = (alerts.data ?? []).filter((a) => !a.handled_at);
  const done = (alerts.data ?? []).filter((a) => a.handled_at);
  if (!alerts.data?.length) return null;
  const send = (phone: string | null, text: string) => {
    const link = whatsappLink(phone, text);
    if (link) window.open(link);
    else toast.error('Numéro WhatsApp manquant');
  };
  return (
    <section className="warn-box">
      <h3>Alertes du personnel ({open.length})</h3>
      {open.map((a: Alert) => (
        <div key={a.id} className="alert-row">
          <span>
            {a.day !== today() && <b>{dateFr(a.day)} · </b>}
            {a.text}
          </span>
          <span className="nowrap">
            {settings.alertWhatsapp && (
              <button type="button" className="link" onClick={() => send(settings.alertWhatsapp, `ONIX 360 · ${a.text}`)}>
                WhatsApp au responsable
              </button>
            )}
            {a.category === 'contractor' && a.agency_phone && (
              <button
                type="button"
                className="link"
                onClick={() =>
                  send(
                    a.agency_phone,
                    a.kind === 'absent'
                      ? `Bonjour, votre agent ${a.staff_name} n’est pas venu à son poste aujourd’hui. Merci d’envoyer un remplaçant au plus vite.`
                      : `Bonjour, votre agent ${a.staff_name} n’est pas encore à son poste (${a.minutes} min de retard). Merci de nous dire quand il arrive ou d’envoyer un remplaçant.`,
                  )
                }
              >
                WhatsApp à {a.agency_name}
              </button>
            )}
            {a.staff_phone && (
              <button
                type="button"
                className="link"
                onClick={() => send(a.staff_phone, `Bonjour ${a.staff_name}, vous étiez attendu aujourd’hui et nous n’avons pas de passage à l’entrée. Pouvez-vous nous dire où vous en êtes ?`)}
              >
                WhatsApp à la personne
              </button>
            )}
            <button
              type="button"
              className="ghost"
              onClick={async () => {
                try {
                  await call('staffWatch.handle', a.id);
                  alerts.reload();
                } catch (err) {
                  toast.error(err);
                }
              }}
            >
              Traité
            </button>
          </span>
        </div>
      ))}
      {done.length > 0 && (
        <small className="muted block">
          Traitées : {done.map((a) => `${a.staff_name} (${a.kind === 'absent' ? 'absence' : 'retard'}, ${a.handler_name ?? ''} à ${hm(a.handled_at)})`).join(' · ')}
        </small>
      )}
    </section>
  );
}

type Device = Result<'fingerprint.devices'>[number];

/**
 * Pointeuses à empreinte : ce PC reçoit leurs passages par le réseau, ou on
 * importe le fichier de la clé USB. Chaque personne est enregistrée dans la
 * pointeuse sous son numéro de pointage.
 */
function Fingerprints({ user, entrances }: { user: User; entrances: { id: string; name: string }[] }) {
  const settings = useStoreSettings();
  const toast = useToast();
  const devices = useLoad(() => call('fingerprint.devices'), []);
  const state = useLoad(() => (has(user, 'staff_kiosk') ? call('fingerprint.state') : Promise.resolve(null)), []);
  const [port, setPort] = useState('');
  const [result, setResult] = useState<Result<'fingerprint.import'> | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const st = state.data;
  return (
    <section>
      <h3>Pointeuses à empreinte</h3>
      <p className="muted">
        Enregistrez chaque personne dans la pointeuse sous son numéro de pointage (fiche du collaborateur › Badge et pointage). Les empreintes restent dans l’appareil ; seuls le numéro
        et l’heure arrivent ici, arrivée ou départ selon le passage précédent.
      </p>
      {st && (
        <div className="box">
          <b>Réception par le réseau sur ce PC</b>
          {st.listening ? (
            <p>
              Ce PC reçoit les pointeuses. Dans la pointeuse : Menu › Communication › Serveur cloud (ADMS), adresse du serveur <b>{st.addresses.join(' ou ') || 'IP de ce PC'}</b>, port{' '}
              <b>{st.port}</b>.{st.lastAt ? ` Dernier envoi reçu à ${hm(st.lastAt)}.` : ' Aucun envoi reçu depuis le démarrage.'}
            </p>
          ) : (
            <p className="muted">
              {st.error ?? 'Ce PC ne reçoit pas les pointeuses.'} Choisissez un PC toujours allumé (la borne ou le PC du gérant), branché au même réseau que la pointeuse.
            </p>
          )}
          <div className="toolbar">
            <input className="qty" style={{ width: 90, flex: 'none' }} inputMode="numeric" title="Port" placeholder={String(st.port ?? 8081)} value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, ''))} />
            <button
              type="button"
              onClick={async () => {
                try {
                  await call('fingerprint.configure', Number(port || st.port || 8081));
                  state.reload();
                  toast.ok('Ce PC reçoit les pointeuses');
                } catch (err) {
                  toast.error(err);
                }
              }}
            >
              {st.listening ? 'Changer de port' : 'Recevoir les pointeuses sur ce PC'}
            </button>
            {st.port && (
              <button
                type="button"
                className="ghost"
                onClick={async () => {
                  await call('fingerprint.configure', null).catch(toast.error);
                  state.reload();
                }}
              >
                Arrêter
              </button>
            )}
          </div>
        </div>
      )}
      {has(user, 'staff_attendance') && (
        <div className="toolbar">
          <input
            ref={file}
            type="file"
            accept=".dat,.txt,.log"
            hidden
            onChange={async (e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (!f) return;
              try {
                const r = await call('fingerprint.import', await f.text());
                setResult(r);
                devices.reload();
                toast.ok(`${r.added} passage(s) ajouté(s)`);
              } catch (err) {
                toast.error(err);
              }
            }}
          />
          <button type="button" onClick={() => file.current?.click()}>
            Importer le fichier de la clé USB…
          </button>
          <small className="muted">Dans la pointeuse : Menu › Clé USB › Télécharger › Pointages (fichier « attlog »).</small>
        </div>
      )}
      {result && (
        <p className={result.unknown.length ? 'warn-box' : 'muted'}>
          {result.added} passage(s) ajouté(s), {result.duplicates} déjà noté(s)
          {result.unreadable ? `, ${result.unreadable} ligne(s) illisible(s) ou à une date future` : ''}
          {result.inactive ? `, ${result.inactive} de personnes parties` : ''}.
          {result.unknown.length > 0 && ` Numéros sans collaborateur : ${result.unknown.join(', ')}. Donnez ces numéros de pointage aux bonnes fiches, puis réimportez le fichier.`}
        </p>
      )}
      {devices.data?.length ? (
        <table className="list">
          <thead>
            <tr>
              <th>Pointeuse</th>
              <th>N° de série</th>
              {settings.multiEntrances && <th>Entrée</th>}
              <th>Dernier contact</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {devices.data.map((d: Device) => (
              <tr key={d.id} className={d.active ? '' : 'muted'}>
                <td>{d.name}</td>
                <td>{d.serial}</td>
                {settings.multiEntrances && (
                  <td>
                    <select
                      disabled={!has(user, 'staff_kiosk')}
                      value={d.entrance_id ?? ''}
                      onChange={async (e) => {
                        await call('fingerprint.saveDevice', d.id, { name: d.name, entranceId: e.target.value || null, active: Boolean(d.active) }).catch(toast.error);
                        devices.reload();
                      }}
                    >
                      <option value="">Entrée principale</option>
                      {entrances.map((x) => (
                        <option key={x.id} value={x.id}>
                          {x.name}
                        </option>
                      ))}
                    </select>
                  </td>
                )}
                <td>{d.last_seen_at ? `${new Date(d.last_seen_at).toLocaleDateString('fr-FR')} ${hm(d.last_seen_at)}` : ''}</td>
                <td className="nowrap">
                  {has(user, 'staff_kiosk') && (
                    <>
                      <button
                        type="button"
                        className="link"
                        onClick={async () => {
                          const name = await askText(`Nouveau nom de « ${d.name} »`);
                          if (!name) return;
                          await call('fingerprint.saveDevice', d.id, { name, entranceId: d.entrance_id, active: Boolean(d.active) }).catch(toast.error);
                          devices.reload();
                        }}
                      >
                        Renommer
                      </button>
                      <button
                        type="button"
                        className="link"
                        onClick={async () => {
                          await call('fingerprint.saveDevice', d.id, { name: d.name, entranceId: d.entrance_id, active: !d.active }).catch(toast.error);
                          devices.reload();
                        }}
                      >
                        {d.active ? 'Retirer' : 'Remettre'}
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="muted">Aucune pointeuse encore : elle apparaît ici à son premier envoi par le réseau.</p>
      )}
    </section>
  );
}

type Warning = Result<'staffWatch.warnings'>[number];

/** Avertissements donnés au personnel, et ceux à envisager après trop de retards. */
export function Warnings({ user }: { user: User }) {
  const toast = useToast();
  const settings = useStoreSettings();
  const period = today().slice(0, 7);
  const list = useLoad(() => call('staffWatch.warnings'), []);
  const suggestions = useLoad(() => (has(user, 'staff_edit') ? call('staffWatch.suggestions', period) : Promise.resolve([])), [list.data]);
  const staff = useLoad(() => call('staff.list'), []);
  const [edit, setEdit] = useState<{ staffId: string; reason: string } | null>(null);
  const canEdit = has(user, 'staff_edit');
  return (
    <>
      <div className="toolbar">
        <span className="muted">Avertissement oral, écrit, blâme ou mise à pied : gardé au dossier, avec la lettre à faire signer.</span>
        <span className="spacer" />
        {canEdit && (
          <button className="primary" onClick={() => setEdit({ staffId: '', reason: '' })}>
            Nouvel avertissement…
          </button>
        )}
      </div>
      {suggestions.data && suggestions.data.length > 0 && (
        <div className="warn-box">
          <b>À envisager ({settings.warnLateCount} retards ou plus ce mois) :</b>{' '}
          {suggestions.data.map((x) => (
            <button
              key={x.staff_id}
              type="button"
              className="link"
              onClick={() => setEdit({ staffId: x.staff_id, reason: `${x.late} retards ce mois-ci (${x.late_minutes} minutes en tout).` })}
            >
              {x.name} ({x.late} retards)
            </button>
          ))}
        </div>
      )}
      {list.data?.length ? (
        <table className="list">
          <thead>
            <tr>
              <th>Date</th>
              <th>Collaborateur</th>
              <th>Sorte</th>
              <th>Motif</th>
              <th>Donné par</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {list.data.map((w: Warning) => (
              <tr key={w.id}>
                <td>{dateFr(w.day)}</td>
                <td>{w.staff_name}</td>
                <td>{WARNING_KINDS[w.kind] ?? w.kind}</td>
                <td>{w.reason}</td>
                <td>{w.user_name ?? ''}</td>
                <td className="nowrap">
                  {canEdit && (
                    <>
                      <button type="button" className="link" onClick={() => call('staffWatch.printWarning', w.id).catch(toast.error)}>
                        Imprimer la lettre
                      </button>
                      <button
                        type="button"
                        className="link"
                        onClick={async () => {
                          if (!(await askConfirm(`Retirer l’avertissement de ${w.staff_name} ?`))) return;
                          await call('staffWatch.cancelWarning', w.id).catch(toast.error);
                          list.reload();
                        }}
                      >
                        Retirer
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <Empty>Aucun avertissement.</Empty>
      )}
      {edit && (
        <WarningDialog
          staff={(staff.data ?? []).filter((x) => x.active)}
          initial={edit}
          onClose={() => setEdit(null)}
          onDone={() => {
            setEdit(null);
            list.reload();
          }}
        />
      )}
    </>
  );
}

function WarningDialog({ staff, initial, onClose, onDone }: { staff: StaffRow[]; initial: { staffId: string; reason: string }; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [f, setF] = useState({ staffId: initial.staffId, day: today(), kind: 'oral' as WarningKind, reason: initial.reason });
  return (
    <Modal title="Nouvel avertissement" onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            const w = await call('staffWatch.addWarning', f.staffId, { day: f.day, kind: f.kind, reason: f.reason });
            toast.ok('Avertissement gardé au dossier');
            if (f.kind !== 'oral' && (await askConfirm('Imprimer la lettre à faire signer ?'))) await call('staffWatch.printWarning', w.id);
            onDone();
          } catch (err) {
            toast.error(err);
          }
        }}
      >
        <Field label="Collaborateur">
          <select required value={f.staffId} onChange={(e) => setF({ ...f, staffId: e.target.value })}>
            <option value="">Choisir…</option>
            {staff.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Sorte">
          <select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as WarningKind })}>
            {(Object.entries(WARNING_KINDS) as [WarningKind, string][]).map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Date">
          <input type="date" max={today()} value={f.day} onChange={(e) => setF({ ...f, day: e.target.value })} />
        </Field>
        <Field label="Motif">
          <textarea rows={3} value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} placeholder="Retards répétés, absence sans prévenir…" />
        </Field>
        <div className="actions">
          <button type="button" className="ghost" onClick={onClose}>
            Annuler
          </button>
          <button type="submit" className="primary" disabled={!f.staffId || !f.reason.trim()}>
            Enregistrer
          </button>
        </div>
      </form>
    </Modal>
  );
}
