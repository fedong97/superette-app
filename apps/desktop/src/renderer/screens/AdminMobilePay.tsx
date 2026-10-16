import { useState } from 'react';
import { type Result, call } from '../api';
import { Empty, Field, dateTime, fcfa, useLoad, useToast } from '../ui';

type Config = Result<'mobilepay.config'>;
type Method = 'MTN_MOMO' | 'ORANGE_MONEY';

const STATUS: Record<string, [string, string]> = {
  pending: ['En attente', 'tag'],
  success: ['Payé', 'tag normal'],
  failed: ['Refusé', 'tag rupture'],
  cancelled: ['Abandonné', 'tag'],
};

/**
 * Paiement Mobile Money automatique (Administration › Paiement mobile) :
 * réglages de MTN MoMo et Orange Money sur ce poste, et historique des demandes.
 */
export function MobilePay() {
  const config = useLoad(() => call('mobilepay.config'), []);
  const list = useLoad(() => call('mobilepay.list'), []);
  if (!config.data) return null;
  return (
    <div className="settings">
      <p className="muted">
        La caisse envoie la demande de paiement au téléphone du client, qui confirme avec son code secret ; le paiement s’ajoute au ticket avec le numéro de transaction, sans
        saisie. Les clés restent sur ce PC : réglez chaque PC de caisse qui encaisse par Mobile Money.
      </p>
      <MtnForm config={config.data} onSaved={config.reload} />
      <OrangeForm config={config.data} onSaved={config.reload} />
      <section className="settings-section">
        <h3>Dernières demandes</h3>
        {list.data?.length ? (
          <table className="list compact">
            <thead>
              <tr>
                <th>Date</th>
                <th>Moyen</th>
                <th>Téléphone</th>
                <th className="r">Montant</th>
                <th>État</th>
                <th>Transaction</th>
                <th>Caissier</th>
              </tr>
            </thead>
            <tbody>
              {list.data.map((p) => (
                <tr key={p.id}>
                  <td>{dateTime(p.created_at)}</td>
                  <td>
                    {p.method === 'MTN_MOMO' ? 'MTN MoMo' : 'Orange Money'}
                    {p.mode !== 'production' && <small className="muted"> · {p.mode === 'simulation' ? 'simulation' : 'test'}</small>}
                  </td>
                  <td>{p.phone}</td>
                  <td className="r">{fcfa(p.amount)}</td>
                  <td>
                    <span className={STATUS[p.status]?.[1]}>{STATUS[p.status]?.[0] ?? p.status}</span>
                    {p.reason && <small className="muted"> {p.reason}</small>}
                  </td>
                  <td>{p.transaction_id ?? ''}</td>
                  <td>{p.user_name ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty>Aucune demande pour l’instant. Activez un moyen ci-dessus, puis à la caisse choisissez MTN MoMo ou Orange Money à l’encaissement.</Empty>
        )}
        <button className="ghost" onClick={() => list.reload()}>
          Actualiser
        </button>
      </section>
    </div>
  );
}

function useForm<T extends Record<string, unknown>>(initial: T) {
  const [f, setF] = useState<T>(initial);
  const set = (k: keyof T) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return { f, set };
}

function save(method: Method, patch: Record<string, unknown>, toast: ReturnType<typeof useToast>, onSaved: () => void) {
  return call('mobilepay.saveConfig', method, patch)
    .then(() => {
      toast.ok('Réglages enregistrés');
      onSaved();
    })
    .catch(toast.error);
}

function MtnForm({ config, onSaved }: { config: Config; onSaved: () => void }) {
  const toast = useToast();
  const c = config.MTN_MOMO;
  const { f, set } = useForm({ mode: c.mode, subscriptionKey: '', apiUser: c.apiUser, apiKey: '', targetEnvironment: c.targetEnvironment });
  const [busy, setBusy] = useState(false);
  return (
    <section className="settings-section">
      <h3>
        MTN Mobile Money {c.ready ? <span className="tag normal">Prêt</span> : <span className="tag">Pas prêt</span>}
      </h3>
      <div className="desk-head two">
        <Field label="Mode">
          <select value={f.mode} onChange={set('mode')}>
            <option value="off">Désactivé</option>
            <option value="simulation">Simulation (sans compte, pour essayer)</option>
            <option value="sandbox">Test MTN (sandbox)</option>
            <option value="production">Réel (compte marchand MTN)</option>
          </select>
        </Field>
        {f.mode !== 'off' && f.mode !== 'simulation' && (
          <>
            <Field label="Clé d’abonnement « Collections »" hint={c.subscriptionKey ? `Enregistrée (${c.subscriptionKey}) ; laissez vide pour la garder` : 'Primary key du produit Collections sur momodeveloper.mtn.com'}>
              <input value={f.subscriptionKey} onChange={set('subscriptionKey')} autoComplete="off" />
            </Field>
            <Field label="Utilisateur de l’API (API user)" hint={f.mode === 'sandbox' ? 'Créé par le bouton « Créer l’accès de test »' : 'Remis par MTN avec le compte marchand'}>
              <input value={f.apiUser} onChange={set('apiUser')} autoComplete="off" />
            </Field>
            <Field label="Clé de l’API (API key)" hint={c.apiKey ? `Enregistrée (${c.apiKey}) ; laissez vide pour la garder` : undefined}>
              <input value={f.apiKey} onChange={set('apiKey')} autoComplete="off" />
            </Field>
            {f.mode === 'production' && (
              <Field label="Environnement MTN" hint="mtncameroon pour le Cameroun">
                <input value={f.targetEnvironment} onChange={set('targetEnvironment')} />
              </Field>
            )}
          </>
        )}
      </div>
      {f.mode === 'simulation' && <p className="muted">Simulation : chaque demande est confirmée au bout de 5 secondes ; un numéro qui finit par 0 simule un refus du client. Aucun argent ne bouge.</p>}
      {f.mode === 'sandbox' && (
        <p className="muted">
          Test MTN : créez un compte gratuit sur momodeveloper.mtn.com, abonnez-vous au produit « Collections », collez la clé ci-dessus, enregistrez, puis « Créer l’accès de test ».
          Numéros de test : 46733123453 (payé), 46733123450 (refusé). Aucun argent ne bouge.
        </p>
      )}
      <div className="actions">
        {f.mode === 'sandbox' && (
          <button
            disabled={busy || !c.subscriptionKey}
            title={c.subscriptionKey ? undefined : 'Enregistrez d’abord la clé d’abonnement'}
            onClick={async () => {
              setBusy(true);
              try {
                await call('mobilepay.setupSandbox');
                toast.ok('Accès de test MTN créé');
                onSaved();
              } catch (e) {
                toast.error(e);
              }
              setBusy(false);
            }}
          >
            Créer l’accès de test
          </button>
        )}
        <button className="primary" onClick={() => save('MTN_MOMO', f, toast, onSaved)}>
          Enregistrer
        </button>
      </div>
    </section>
  );
}

function OrangeForm({ config, onSaved }: { config: Config; onSaved: () => void }) {
  const toast = useToast();
  const c = config.ORANGE_MONEY;
  const { f, set } = useForm({ mode: c.mode, baseUrl: c.baseUrl, consumerKey: c.consumerKey, consumerSecret: '', authToken: '', channelMsisdn: c.channelMsisdn, pin: '' });
  const kept = (v: string) => (v ? `Enregistré (${v}) ; laissez vide pour le garder` : undefined);
  return (
    <section className="settings-section">
      <h3>
        Orange Money {c.ready ? <span className="tag normal">Prêt</span> : <span className="tag">Pas prêt</span>}
      </h3>
      <div className="desk-head two">
        <Field label="Mode">
          <select value={f.mode} onChange={set('mode')}>
            <option value="off">Désactivé</option>
            <option value="simulation">Simulation (sans compte, pour essayer)</option>
            <option value="production">Réel (compte marchand Orange Money)</option>
          </select>
        </Field>
        {f.mode === 'production' && (
          <>
            <Field label="Adresse de l’API">
              <input value={f.baseUrl} onChange={set('baseUrl')} />
            </Field>
            <Field label="Consumer key">
              <input value={f.consumerKey} onChange={set('consumerKey')} autoComplete="off" />
            </Field>
            <Field label="Consumer secret" hint={kept(c.consumerSecret)}>
              <input value={f.consumerSecret} onChange={set('consumerSecret')} autoComplete="off" />
            </Field>
            <Field label="Jeton marchand (X-AUTH-TOKEN)" hint={kept(c.authToken)}>
              <input value={f.authToken} onChange={set('authToken')} autoComplete="off" />
            </Field>
            <Field label="Numéro marchand (channel user)">
              <input value={f.channelMsisdn} onChange={set('channelMsisdn')} />
            </Field>
            <Field label="Code du numéro marchand" hint={kept(c.pin)}>
              <input type="password" value={f.pin} onChange={set('pin')} autoComplete="off" />
            </Field>
          </>
        )}
      </div>
      {f.mode === 'simulation' && <p className="muted">Simulation : chaque demande est confirmée au bout de 5 secondes ; un numéro qui finit par 0 simule un refus du client.</p>}
      {f.mode === 'production' && <p className="muted">Ces accès sont remis par Orange Cameroun avec le compte marchand (API Orange Money « paiement marchand »).</p>}
      <div className="actions">
        <button className="primary" onClick={() => save('ORANGE_MONEY', f, toast, onSaved)}>
          Enregistrer
        </button>
      </div>
    </section>
  );
}
