import { useState } from 'react';
import { type Result, call } from '../api';
import { askConfirm, askText, Empty, Modal, dateTime, useLoad, useToast } from '../ui';

type Dossier = Result<'dossier.list'>[number];
type FicheInfo = NonNullable<Result<'fiche.chooseReturn'>>;
type FicheKind = NonNullable<Dossier['fiche']>['kind'];
type AppUser = NonNullable<Result<'app.state'>['user']>;

export const FICHE_LABELS: Record<FicheKind, string> = {
  intervention: "Fiche d'intervention",
  comptable: 'Copie comptable',
  installation: 'Installation préparée',
  formation: 'Mode formation',
};

const size = (bytes: number) => (bytes >= 1_048_576 ? `${(bytes / 1_048_576).toFixed(1).replace('.', ',')} Mo` : `${Math.max(1, Math.round(bytes / 1024))} Ko`);

/**
 * « Ouvrir une boutique » : les boutiques de ce PC.
 * Ouvrir une autre boutique relance ONIX 360 dessus ; on s'y connecte avec ses propres utilisateurs.
 */
export function DossierPicker({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const list = useLoad(() => call('dossier.list'));
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>, message: string) => {
    setBusy(true);
    try {
      await fn();
      toast.ok(message);
    } catch (err) {
      toast.error(err);
      setBusy(false);
    }
  };
  const open = (d: Dossier) => run(() => call('dossier.open', d.file), `Ouverture de ${d.store_name ?? d.name}…`);
  const openFile = async () => {
    const info = await call('dossier.chooseFile').catch(toast.error);
    if (!info) return;
    if (!info.ok) return toast.error(info.error ?? 'Fichier illisible');
    // Une fiche (clé USB) est d'abord copiée sur ce PC ; un dossier ordinaire s'ouvre là où il est.
    if (info.fiche) {
      const what = info.fiche.kind === 'installation' ? `Copier sur ce PC la boutique préparée « ${info.store_name} » et l'ouvrir ?` : `Copier sur ce PC la ${FICHE_LABELS[info.fiche.kind].toLowerCase()} de ${info.store_name} (sortie le ${dateTime(info.fiche.at)}) et l'ouvrir ? La fiche de la clé n'est pas modifiée.`;
      if (!(await askConfirm(what))) return;
      return run(() => call('dossier.importFiche', info.file), `Ouverture de ${info.store_name}…`);
    }
    return run(() => call('dossier.open', info.file), `Ouverture de ${info.store_name ?? info.name}…`);
  };
  const create = async () => {
    const name = await askText('Nom du fichier de la nouvelle boutique (ex. Boutique Mvog-Mbi) : ONIX 360 redémarre sur une boutique vide à paramétrer.');
    if (name) return run(() => call('dossier.create', name), 'Ouverture de la nouvelle boutique…');
  };
  const forget = async (d: Dossier) => {
    if (!(await askConfirm(`Retirer « ${d.store_name ?? d.name} » de la liste ? Le fichier reste sur le disque : ${d.file}`))) return;
    call('dossier.forget', d.file).then(list.reload, toast.error);
  };
  return (
    <Modal title="Ouvrir une boutique" onClose={onClose} wide>
      <p className="muted">Chaque boutique est un fichier. Le PC rouvre la dernière boutique ouverte ; on s'y connecte avec les utilisateurs de cette boutique.</p>
      {list.data && list.data.length === 0 ? (
        <Empty>Aucune boutique sur ce PC.</Empty>
      ) : (
        <table className="list">
          <thead>
            <tr>
              <th>Boutique</th>
              <th>Fichier</th>
              <th className="num">Articles</th>
              <th>Dernière vente</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(list.data ?? []).map((d) => (
              <tr key={d.file}>
                <td>
                  <strong>{d.store_name ?? 'Boutique à paramétrer'}</strong> {d.store_code && <span className="muted">{d.store_code}</span>}{' '}
                  {d.current && <span className="tag">Ouverte</span>} {d.fiche && <span className="tag alerte">{FICHE_LABELS[d.fiche.kind]}</span>}
                  {d.fiche && d.fiche.kind !== 'installation' && <div className="muted">Données du {dateTime(d.fiche.at)}{d.fiche.byName ? `, sortie par ${d.fiche.byName}` : ''}</div>}
                  {d.error && <div className="danger-text">{d.error}</div>}
                </td>
                <td>
                  <code title={d.file}>{d.name}</code> <span className="muted">{d.size ? size(d.size) : ''}</span>
                </td>
                <td className="num">{d.ok ? d.articles : ''}</td>
                <td>{d.last_sale_at ? dateTime(d.last_sale_at) : ''}</td>
                <td className="actions-cell">
                  {!d.current && (
                    <button className="primary" disabled={busy || !d.ok} onClick={() => void open(d)}>
                      Ouvrir
                    </button>
                  )}{' '}
                  {!d.current && !d.main && (
                    <button disabled={busy} onClick={() => void forget(d)}>
                      Retirer
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="actions spread">
        <span className="muted">ONIX 360 redémarre sur la boutique choisie.</span>
        <span>
          <button disabled={busy} onClick={() => void openFile()}>
            Ouvrir une fiche…
          </button>{' '}
          <button disabled={busy} onClick={() => void create()}>
            Nouvelle boutique…
          </button>
        </span>
      </div>
    </Modal>
  );
}

/** Bandeau des fiches emportées : on sait toujours qu'on ne travaille pas dans la boutique elle-même. */
export function FicheBanner({
  fiche,
  onSaveCopy,
  onStopTraining,
}: {
  fiche: NonNullable<Result<'app.state'>['dossier']['fiche']>;
  onSaveCopy?: () => void;
  onStopTraining?: () => void;
}) {
  if (fiche.kind === 'installation') return null;
  return (
    <div className={`fiche-banner ${fiche.kind === 'formation' ? 'training' : ''}`}>
      <span>{fiche.banner}</span>
      {onStopTraining && fiche.kind === 'formation' && (
        <button className="warn soft" onClick={onStopTraining}>
          Quitter la formation
        </button>
      )}
      {onSaveCopy && fiche.kind === 'intervention' && (
        <button className="warn soft" onClick={onSaveCopy}>
          Remettre la fiche sur la clé USB
        </button>
      )}
    </div>
  );
}

/** Remet la fiche ouverte sur une clé USB (ou la compresse pour la renvoyer) pour la rapporter à la boutique. */
export async function saveFicheCopy(toast: ReturnType<typeof useToast>, send = false) {
  try {
    const info = await call('fiche.saveCopy', { send });
    if (!info) return;
    toast.ok(
      send
        ? `Fiche compressée : ${info.file} (${size(info.size)}). Joignez ce fichier à un e-mail ou un message WhatsApp pour la boutique.`
        : `Fiche copiée : ${info.file}. Rapportez-la dans la boutique (Administration › Fiches boutique › Rapporter une fiche).`,
    );
  } catch (err) {
    toast.error(err);
  }
}

const SHARE_FREQUENCIES: [number, string][] = [
  [0, 'Jamais'],
  [60, 'Toutes les heures'],
  [240, 'Toutes les 4 heures'],
  [1440, 'Chaque jour'],
];

/** Administration › Fiches boutique : emporter une fiche, la rapporter, préparer une installation. */
export function Fiches({ user, onChanged }: { user: AppUser; onChanged: () => void }) {
  const toast = useToast();
  const state = useLoad(() => call('app.state'));
  const fiche = state.data?.dossier.fiche ?? null;
  const isAdmin = user.role === 'admin';
  const canAccounting = user.rights.includes('accounting_export');
  const history = useLoad(() => call('fiche.history'));
  const [busy, setBusy] = useState(false);
  const [back, setBack] = useState<FicheInfo | null>(null);
  const [picker, setPicker] = useState(false);
  const exportFiche = async (kind: FicheKind, send = false) => {
    setBusy(true);
    try {
      const info = await call('fiche.export', kind, { send });
      if (info)
        toast.ok(
          send
            ? `${FICHE_LABELS[kind]} compressée : ${info.file} (${size(info.size)}). Joignez ce fichier à un e-mail ou un message WhatsApp.`
            : `${FICHE_LABELS[kind]} enregistrée : ${info.file} (${size(info.size)})`,
        );
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
      history.reload();
    }
  };
  const share = useLoad(() => (isAdmin && !fiche ? call('fiche.share') : Promise.resolve(null)), [isAdmin, Boolean(fiche)]);
  const openPending = async (file: string) => {
    try {
      const info = await call('fiche.check', file);
      if (!info.ok) return toast.error(info.error ?? 'Fiche illisible');
      setBack({ ...info, file });
    } catch (err) {
      toast.error(err);
    }
  };
  const chooseReturn = async () => {
    try {
      const info = await call('fiche.chooseReturn');
      if (!info) return;
      if (!info.ok) return toast.error(info.error ?? 'Fiche illisible');
      setBack(info);
    } catch (err) {
      toast.error(err);
    }
  };

  if (!state.data) return null;
  if (fiche) {
    return (
      <div>
        <p>
          <strong>{fiche.banner}</strong>
        </p>
        {fiche.kind === 'intervention' ? (
          <>
            <p>
              Travaillez ici comme dans la boutique : articles, prix, clients, paramètres, comptabilité… La caisse ne vend pas. Quand vous avez fini, remettez la fiche sur la clé USB et rapportez-la : dans la
              boutique, Administration › Fiches boutique › Rapporter une fiche ajoute vos modifications sans rien effacer de ce qu'elle a vendu entre-temps.
            </p>
            <div className="actions" style={{ justifyContent: 'flex-start' }}>
              <button className="primary" onClick={() => void saveFicheCopy(toast)}>
                Remettre la fiche sur la clé USB
              </button>
              <button onClick={() => void saveFicheCopy(toast, true)}>Compresser pour l'envoyer…</button>
              <button onClick={() => setPicker(true)}>Ouvrir une autre boutique</button>
            </div>
          </>
        ) : (
          <>
            <p>
              Copie pour les états : rapports, comptabilité, déclarations. La boutique continue de vendre pendant ce temps. Pour des chiffres à jour, prenez une nouvelle copie dans la boutique ; vos écritures et
              corrections peuvent aussi y être rapportées comme une fiche d'intervention.
            </p>
            <div className="actions" style={{ justifyContent: 'flex-start' }}>
              <button onClick={() => void saveFicheCopy(toast)}>Remettre la copie sur la clé USB</button>
              <button onClick={() => setPicker(true)}>Ouvrir une autre boutique</button>
            </div>
          </>
        )}
        {picker && <DossierPicker onClose={() => setPicker(false)} />}
      </div>
    );
  }

  return (
    <div>
      <p>
        Une fiche est une copie de la boutique dans un seul fichier, à emporter sur une clé USB. La boutique n'est jamais arrêtée : la fiche se prend pendant que la caisse vend, et au retour seules les
        modifications faites dans la fiche sont ajoutées.
      </p>
      <div className="fiche-actions">
        {isAdmin && (
          <section className="card">
            <h3>Fiche d'intervention</h3>
            <p className="muted">Le technicien l'emporte, l'ouvre sur son PC (Ouvrir une boutique › Ouvrir une fiche), y travaille puis la rapporte. La caisse ne vend pas dans la fiche.</p>
            <span>
              <button className="primary" disabled={busy} onClick={() => void exportFiche('intervention')}>
                Emporter une fiche d'intervention…
              </button>{' '}
              <button disabled={busy} onClick={() => void exportFiche('intervention', true)} title="Fiche compressée à joindre à un e-mail ou un message WhatsApp">
                Envoyer…
              </button>
            </span>
          </section>
        )}
        {canAccounting && (
          <section className="card">
            <h3>Copie pour le comptable</h3>
            <p className="muted">Le comptable fait ses états chez lui. À sa prochaine visite, il prend simplement une nouvelle copie.</p>
            <span>
              <button disabled={busy} onClick={() => void exportFiche('comptable')}>
                Copie pour le comptable…
              </button>{' '}
              <button disabled={busy} onClick={() => void exportFiche('comptable', true)} title="Copie compressée à joindre à un e-mail ou un message WhatsApp">
                Envoyer…
              </button>
            </span>
          </section>
        )}
        {isAdmin && (
          <section className="card">
            <h3>Rapporter une fiche</h3>
            <p className="muted">Ajoute à la boutique ce qui a été fait dans la fiche. Si un même élément a changé des deux côtés, la modification la plus récente est gardée.</p>
            <button disabled={busy} onClick={() => void chooseReturn()}>
              Rapporter une fiche…
            </button>
          </section>
        )}
        {isAdmin && (
          <section className="card">
            <h3>Installation préparée</h3>
            <p className="muted">
              Boutique paramétrée au bureau (magasin, utilisateurs, articles), sans vente d'essai. Sur le PC du client, au premier démarrage : « Installer une boutique préparée ».
            </p>
            <button disabled={busy} onClick={() => void exportFiche('installation')}>
              Préparer l'installation…
            </button>
          </section>
        )}
      </div>
      {isAdmin && share.data !== undefined && share.data !== null && (
        <SharedFolder
          status={share.data}
          onChanged={share.reload}
          onBringBack={(file) => void openPending(file)}
        />
      )}
      <h3>Fiches sorties</h3>
      {history.data && history.data.length === 0 ? (
        <Empty>Aucune fiche sortie de cette boutique.</Empty>
      ) : (
        <table className="list">
          <thead>
            <tr>
              <th>Sortie le</th>
              <th>Fiche</th>
              <th>Fichier</th>
              <th>Rapportée</th>
            </tr>
          </thead>
          <tbody>
            {(history.data ?? []).map((h) => {
              const summary = h.summary ? (JSON.parse(h.summary) as { applied: number; settings: number }) : null;
              return (
                <tr key={h.id}>
                  <td>{dateTime(h.created_at)}</td>
                  <td>{FICHE_LABELS[h.kind]}</td>
                  <td>
                    <code title={h.file}>{h.file.split(/[\\/]/).pop()}</code>
                  </td>
                  <td>
                    {h.returned_at
                      ? `Le ${dateTime(h.returned_at)}${summary ? ` : ${summary.applied} modification${summary.applied > 1 ? 's' : ''}, ${summary.settings} réglage${summary.settings > 1 ? 's' : ''}` : ''}`
                      : h.kind === 'intervention'
                        ? <span className="muted">Pas encore</span>
                        : ''}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {back && (
        <BringBack
          info={back}
          onClose={() => setBack(null)}
          onDone={() => {
            setBack(null);
            history.reload();
            share.reload();
            onChanged();
          }}
        />
      )}
    </div>
  );
}

function BringBack({ info, onClose, onDone }: { info: FicheInfo; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const f = info.fiche;
  const submit = async () => {
    setBusy(true);
    try {
      const r = await call('fiche.bringBack', info.file);
      if (r.reset) toast.ok(`Boutique remise à zéro. Sauvegarde d’avant : ${r.backup}`);
      toast.ok(
        r.changes === 0 && r.settings === 0
          ? 'Fiche rapportée : rien n’avait été modifié dedans'
          : `Fiche rapportée : ${r.applied} modification${r.applied > 1 ? 's' : ''} ajoutée${r.applied > 1 ? 's' : ''}, ${r.settings} réglage${r.settings > 1 ? 's' : ''}${r.conflicts ? `, ${r.conflicts} déjà plus récente${r.conflicts > 1 ? 's' : ''} dans la boutique (gardée${r.conflicts > 1 ? 's' : ''})` : ''}`,
      );
      onDone();
    } catch (err) {
      toast.error(err);
      setBusy(false);
    }
  };
  return (
    <Modal title="Rapporter une fiche" onClose={onClose}>
      {!f ? (
        <p className="danger-text">Ce fichier n'est pas une fiche sortie d'une boutique.</p>
      ) : (
        <>
          <table className="list narrow">
            <tbody>
              <tr>
                <th>Boutique</th>
                <td>{f.storeName}</td>
              </tr>
              <tr>
                <th>Fiche</th>
                <td>{FICHE_LABELS[f.kind]}</td>
              </tr>
              <tr>
                <th>Données arrêtées le</th>
                <td>
                  {dateTime(f.at)}
                  {f.byName ? `, par ${f.byName}` : ''}
                </td>
              </tr>
              <tr>
                <th>Fichier</th>
                <td>
                  <code>{info.file}</code>
                </td>
              </tr>
            </tbody>
          </table>
          {info.returned_at ? (
            <p className="danger-text">Cette fiche a déjà été rapportée le {dateTime(info.returned_at)}.</p>
          ) : f.reset ? (
            <p className="danger-text">
              Remise à zéro des données d’essai faite dans la fiche le {dateTime(f.reset.at)}
              {f.reset.byName ? ` par ${f.reset.byName}` : ''} : la boutique va d’abord être remise à zéro (ventes, achats, caisses, dépenses et mouvements de stock effacés, toutes celles faites
              jusqu’à maintenant comprises ; stock {f.reset.keepStock ? 'gardé comme stock de départ' : 'remis à zéro'}), avec une sauvegarde juste avant. Ensuite, ce qui a été modifié dans la
              fiche est ajouté.
            </p>
          ) : (
            <p>
              Ce qui a été modifié dans la fiche depuis le {dateTime(f.at)} est ajouté à la boutique. Les ventes faites ici pendant ce temps restent ; si un même élément a été changé des deux côtés, la modification la
              plus récente est gardée. La caisse peut continuer de vendre.
            </p>
          )}
        </>
      )}
      <div className="actions">
        <button onClick={onClose} disabled={busy}>
          Annuler
        </button>
        <button className="primary" disabled={busy || !f || Boolean(info.returned_at)} onClick={() => void submit()}>
          {busy ? 'Ajout des modifications…' : 'Rapporter la fiche'}
        </button>
      </div>
    </Modal>
  );
}

type ShareStatus = NonNullable<Result<'fiche.share'>>;

/**
 * Dossier partagé (dossier réseau, OneDrive, Google Drive) : la copie du comptable
 * s'y dépose seule, et le technicien y dépose sa fiche (« Retours ») au lieu de venir avec la clé.
 */
function SharedFolder({ status, onChanged, onBringBack }: { status: ShareStatus; onChanged: () => void; onBringBack: (file: string) => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const configure = (input: { dir?: string | null; every?: number }) => call('fiche.shareConfigure', input).then(onChanged, toast.error);
  const chooseDir = () => call('fiche.shareChooseDir').then((r) => r && onChanged(), toast.error);
  const now = async () => {
    setBusy(true);
    try {
      const info = await call('fiche.shareNow');
      toast.ok(`Copie du comptable déposée : ${info.file}`);
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
      onChanged();
    }
  };
  return (
    <section className="card" style={{ marginBottom: 22 }}>
      <h3>Dossier partagé</h3>
      <p className="muted">
        Un dossier du réseau, de OneDrive ou de Google Drive, ouvert aussi chez le comptable et le technicien. La copie du comptable y est déposée seule dans « Comptable » ; le technicien dépose sa
        fiche dans « Retours » et elle apparaît ici, à rapporter. Plusieurs PC n'écrivent jamais dans le même fichier : chaque boutique garde sa base.
      </p>
      <table className="list narrow">
        <tbody>
          <tr>
            <th>Dossier</th>
            <td>
              {status.dir ? <code>{status.dir}</code> : <span className="muted">aucun</span>}{' '}
              <button onClick={() => void chooseDir()}>{status.dir ? 'Changer' : 'Choisir'}</button>{' '}
              {status.dir && <button onClick={() => void configure({ dir: null })}>Retirer</button>}
            </td>
          </tr>
          {status.dir && (
            <tr>
              <th>Copie du comptable</th>
              <td>
                <select value={status.every} onChange={(e) => void configure({ every: Number(e.target.value) })}>
                  {SHARE_FREQUENCIES.map(([m, label]) => (
                    <option key={m} value={m}>
                      {label}
                    </option>
                  ))}
                </select>{' '}
                <button disabled={busy} onClick={() => void now()}>
                  Déposer maintenant
                </button>{' '}
                {status.last_at && <span className="muted">dernière : {dateTime(status.last_at)}</span>}
                {status.last_error && <div className="danger-text">{status.last_error}</div>}
              </td>
            </tr>
          )}
        </tbody>
      </table>
      {status.dir && status.pending.length > 0 && (
        <>
          <h4>Fiches déposées à rapporter</h4>
          <table className="list">
            <tbody>
              {status.pending.map((p) => (
                <tr key={p.file}>
                  <td>
                    <strong>{p.kind ? FICHE_LABELS[p.kind] : p.packed ? 'Fiche compressée' : p.name}</strong>
                    {p.at && (
                      <span className="muted">
                        {' '}
                        du {dateTime(p.at)}
                        {p.by_name ? `, ${p.by_name}` : ''}
                      </span>
                    )}
                    {p.error && <div className="danger-text">{p.error}</div>}
                  </td>
                  <td>
                    <code>{p.name}</code>
                  </td>
                  <td>
                    <button className="primary" disabled={Boolean(p.error)} onClick={() => onBringBack(p.file)}>
                      Rapporter…
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}

type RepairReport = Result<'repair.check'>;
const REPAIR_TAGS: Record<RepairReport['checks'][number]['status'], [string, string]> = {
  ok: ['OK', 'tag'],
  fixed: ['Réparé', 'tag'],
  problem: ['À réparer', 'tag rupture'],
  info: ['Info', 'tag'],
};

/** Administration › Réparation : vérifie la base et recalcule ce qui doit l'être, sans arrêter la caisse. */
export function Repair({ onBackups }: { onBackups: () => void }) {
  const toast = useToast();
  const [report, setReport] = useState<RepairReport | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (repair: boolean) => {
    if (repair && !(await askConfirm('Réparer la base ? Une sauvegarde est faite d’abord ; la caisse peut continuer de vendre.'))) return;
    setBusy(true);
    try {
      const r = repair ? await call('repair.run') : await call('repair.check');
      setReport(r);
      if (repair) toast.ok(r.ok ? 'Base réparée' : 'Réparation faite : il reste des points à voir');
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };
  useLoad(() => run(false), []);
  return (
    <div>
      <p>
        Vérifie le fichier de la boutique et recalcule le stock et les lots à partir des mouvements, sans toucher la base à la main. La caisse continue de vendre pendant la vérification et la réparation.
      </p>
      {report && (
        <table className="list">
          <tbody>
            {report.checks.map((c) => (
              <tr key={c.key}>
                <th>{c.label}</th>
                <td>
                  <span className={REPAIR_TAGS[c.status][1]}>{REPAIR_TAGS[c.status][0]}</span>
                </td>
                <td>{c.detail}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {report?.backup && <p className="muted">Sauvegarde d'avant réparation : {report.backup}</p>}
      <div className="actions" style={{ justifyContent: 'flex-start' }}>
        <button disabled={busy} onClick={() => void run(false)}>
          {busy ? 'Vérification…' : 'Vérifier à nouveau'}
        </button>
        {report?.damaged ? (
          <button className="primary" onClick={onBackups}>
            Restaurer une sauvegarde…
          </button>
        ) : (
          <button className="primary" disabled={busy || !report || report.ok} onClick={() => void run(true)}>
            Réparer
          </button>
        )}
      </div>
    </div>
  );
}
