import { useState } from 'react';
import { type Result, call } from '../api';
import { Empty, Field, Modal, askConfirm, dateTime, useLoad, useToast } from '../ui';

type Incoming = NonNullable<Result<'relay.choose'>>;

const KIND_LABELS = { remontee: 'Remontée du poste distant', miseajour: 'Mise à jour de la boutique' } as const;

/**
 * Postes distants, comme la saisie de caisse décentralisée de Sage : un dépôt sans
 * réseau vend sur son PC, envoie chaque soir un fichier de sa journée (clé USB,
 * e-mail, WhatsApp) que la boutique intègre, et reçoit en retour les prix et le catalogue.
 */
export function RemoteTills({ isAdmin }: { isAdmin: boolean }) {
  const toast = useToast();
  const status = useLoad(() => call('relay.status'));
  const [busy, setBusy] = useState(false);
  const [incoming, setIncoming] = useState<Incoming | null>(null);
  const [installing, setInstalling] = useState(false);

  const run = async (job: () => Promise<{ file: string; events: number } | null>, label: string) => {
    setBusy(true);
    try {
      const r = await job();
      if (r) toast.ok(`${label} : ${r.file} (${r.events} opération${r.events > 1 ? 's' : ''})`);
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
      status.reload();
    }
  };
  const choose = async () => {
    try {
      const r = await call('relay.choose');
      if (r) setIncoming(r);
    } catch (err) {
      toast.error(err);
    }
  };

  const s = status.data;
  if (!s) return null;
  return (
    <div>
      {s.role === 'distant' ? (
        <>
          <p>
            Ce PC est un poste distant : il vend sans réseau. Chaque soir, faites la remontée et portez le fichier à la boutique (ou envoyez-le par e-mail ou WhatsApp). Quand la boutique vous renvoie une mise à
            jour (prix, articles, utilisateurs), intégrez-la ici.
          </p>
          <p>
            <strong>{s.pending}</strong> opération{s.pending > 1 ? 's' : ''} depuis la dernière remontée.
          </p>
          <div className="actions" style={{ justifyContent: 'flex-start' }}>
            <button className="primary" disabled={busy} onClick={() => void run(() => call('relay.exportRemontee'), 'Remontée enregistrée')}>
              Faire la remontée…
            </button>
            <button disabled={busy} onClick={() => void run(() => call('relay.exportRemontee', { send: true }), 'Remontée prête à envoyer')}>
              Envoyer…
            </button>
            <button disabled={busy} onClick={() => void choose()}>
              Intégrer une mise à jour…
            </button>
          </div>
        </>
      ) : (
        <>
          <p>
            Un dépôt sans réseau ni serveur peut vendre sur son propre PC : préparez son installation sur une clé, puis intégrez chaque jour le fichier de sa journée. Les ventes, journées de caisse et
            mouvements de stock du dépôt arrivent dans la boutique ; vos prix et votre catalogue repartent par la mise à jour.
          </p>
          {isAdmin && (
            <div className="actions" style={{ justifyContent: 'flex-start' }}>
              <button className="primary" disabled={busy} onClick={() => void choose()}>
                Intégrer une remontée…
              </button>
              <button disabled={busy} onClick={() => setInstalling(true)}>
                Installer un poste distant…
              </button>
            </div>
          )}
          <h3>Postes distants</h3>
          {s.remotes.length === 0 ? (
            <Empty>Aucun poste distant installé depuis cette boutique.</Empty>
          ) : (
            <table className="list">
              <thead>
                <tr>
                  <th>Magasin</th>
                  <th>Dernière remontée</th>
                  <th>Dernière mise à jour envoyée</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {s.remotes.map((r) => (
                  <tr key={r.store_id}>
                    <td>
                      {r.name} <span className="muted">({r.code})</span>
                    </td>
                    <td>{r.last_in ? dateTime(r.last_in) : <span className="muted">Pas encore</span>}</td>
                    <td>{r.last_out ? dateTime(r.last_out) : ''}</td>
                    <td>
                      {isAdmin && (
                        <span>
                          <button disabled={busy} onClick={() => void run(() => call('relay.exportUpdate', r.store_id), 'Mise à jour enregistrée')}>
                            Mise à jour…
                          </button>{' '}
                          <button disabled={busy} onClick={() => void run(() => call('relay.exportUpdate', r.store_id, { send: true }), 'Mise à jour prête à envoyer')}>
                            Envoyer…
                          </button>
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
      <h3>Fichiers échangés</h3>
      {s.log.length === 0 ? (
        <Empty>Aucun fichier échangé.</Empty>
      ) : (
        <table className="list">
          <thead>
            <tr>
              <th>Le</th>
              <th>Fichier</th>
              <th>Magasin</th>
              <th>Opérations</th>
              <th>Résultat</th>
            </tr>
          </thead>
          <tbody>
            {s.log.map((l) => (
              <tr key={`${l.id}-${l.direction}`}>
                <td>{dateTime(l.at)}</td>
                <td>
                  {l.direction === 'in' ? 'Reçu' : 'Envoyé'} : {KIND_LABELS[l.kind]}
                  <div className="muted">
                    <code title={l.file}>{l.file.split(/[\\/]/).pop()}</code>
                  </div>
                </td>
                <td>{l.store_name ?? ''}</td>
                <td>{l.events}</td>
                <td>{l.summary ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {incoming && (
        <Integrate
          info={incoming}
          onClose={() => setIncoming(null)}
          onDone={() => {
            setIncoming(null);
            status.reload();
          }}
        />
      )}
      {installing && <InstallRemote onClose={() => setInstalling(false)} onDone={() => (setInstalling(false), status.reload())} />}
    </div>
  );
}

function Integrate({ info, onClose, onDone }: { info: Incoming; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try {
      const r = await call('relay.integrate', info.file);
      toast.ok(`${KIND_LABELS[r.kind]} intégrée : ${r.applied} opération${r.applied > 1 ? 's' : ''}${r.conflicts ? `, ${r.conflicts} déjà modifiée${r.conflicts > 1 ? 's' : ''} plus récemment ici` : ''}`);
      onDone();
    } catch (err) {
      toast.error(err);
      setBusy(false);
    }
  };
  return (
    <Modal title={KIND_LABELS[info.kind]} onClose={onClose}>
      <p>
        <strong>{info.storeName}</strong> ({info.storeCode}), fait le {dateTime(info.at)}
        {info.byName ? ` par ${info.byName}` : ''} : {info.events} opération{info.events > 1 ? 's' : ''}.
      </p>
      {info.integrated_at ? (
        <p className="error">Ce fichier a déjà été intégré le {dateTime(info.integrated_at)}.</p>
      ) : (
        <p className="muted">Rien n'est effacé : si un même élément a changé des deux côtés, la modification la plus récente est gardée.</p>
      )}
      <div className="actions">
        <button onClick={onClose}>Annuler</button>
        <button className="primary" disabled={busy || Boolean(info.integrated_at)} onClick={() => void go()}>
          Intégrer
        </button>
      </div>
    </Modal>
  );
}

function InstallRemote({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const stores = useLoad(() => call('admin.stores'));
  const [storeId, setStoreId] = useState('');
  const registers = useLoad(() => (storeId ? call('admin.registers', storeId) : Promise.resolve([])), [storeId]);
  const [registerId, setRegisterId] = useState('');
  const [busy, setBusy] = useState(false);
  const cash = (registers.data ?? []).filter((r) => r.active && r.kind === 'cash');
  const go = async () => {
    const reg = cash.find((r) => r.id === registerId);
    if (!reg) return;
    if (reg.activated_at && !(await askConfirm(`La caisse « ${reg.name} » est déjà utilisée sur un autre PC. L'installer quand même sur le poste distant ?`))) return;
    setBusy(true);
    try {
      const info = await call('relay.installRemote', registerId);
      if (info) {
        toast.ok(`Installation du poste distant enregistrée : ${info.file}. Sur le PC du dépôt, au premier démarrage : « Installer une boutique préparée ».`);
        onDone();
      } else setBusy(false);
    } catch (err) {
      toast.error(err);
      setBusy(false);
    }
  };
  return (
    <Modal title="Installer un poste distant" onClose={onClose}>
      <p className="muted">
        Créez d'abord le magasin du dépôt et sa caisse (Administration › Magasins). L'installation emporte le catalogue, les prix et les utilisateurs ; le PC du dépôt vendra sur cette caisse.
      </p>
      <Field label="Magasin du dépôt">
        <select value={storeId} onChange={(e) => (setStoreId(e.target.value), setRegisterId(''))}>
          <option value="">Choisir…</option>
          {(stores.data ?? []).map((st) => (
            <option key={st.id} value={st.id}>
              {st.name} ({st.code})
            </option>
          ))}
        </select>
      </Field>
      <Field label="Caisse">
        <select value={registerId} onChange={(e) => setRegisterId(e.target.value)} disabled={!storeId}>
          <option value="">Choisir…</option>
          {cash.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
              {r.activated_at ? ' (déjà utilisée)' : ''}
            </option>
          ))}
        </select>
      </Field>
      <div className="actions">
        <button onClick={onClose}>Annuler</button>
        <button className="primary" disabled={busy || !registerId} onClick={() => void go()}>
          Préparer l'installation…
        </button>
      </div>
    </Modal>
  );
}
