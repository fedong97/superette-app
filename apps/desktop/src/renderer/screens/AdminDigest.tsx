import { useEffect, useState } from 'react';
import { type Result, call } from '../api';
import { Field, today, useLoad, useToast } from '../ui';

type Config = Result<'digest.config'>;

/**
 * Résumé du jour pour le gérant : aperçu et envoi par WhatsApp depuis ce PC,
 * et envoi automatique par e-mail chaque soir, réglé par l'administrateur.
 */
export function Digest({ isAdmin }: { isAdmin: boolean }) {
  const [date, setDate] = useState(today());
  const preview = useLoad(() => call('digest.preview', date), [date]);
  const config = useLoad(() => (isAdmin ? call('digest.config') : Promise.resolve(null)));
  const toast = useToast();
  const text = preview.data?.text ?? '';
  const phone = (config.data?.whatsapp ?? '').replace(/\D/g, '');
  return (
    <div className="digest">
      <section>
        <p>Chaque soir, le gérant reçoit sur son téléphone les ventes, les encaissements, l'état des caisses et ce qui demande son attention.</p>
        <div className="actions" style={{ justifyContent: 'flex-start' }}>
          <Field label="Journée">
            <input type="date" value={date} max={today()} onChange={(e) => setDate(e.target.value || today())} />
          </Field>
        </div>
        <pre className="digest-text">{text || 'Chargement…'}</pre>
        <div className="actions" style={{ justifyContent: 'flex-start' }}>
          <a className="button primary" href={`https://wa.me/${phone}?text=${encodeURIComponent(text)}`} target="_blank" rel="noreferrer">
            Envoyer par WhatsApp
          </a>
          <button
            type="button"
            onClick={() =>
              navigator.clipboard
                .writeText(text)
                .then(() => toast.ok('Résumé copié'))
                .catch(() => toast.error(new Error('Copie impossible')))
            }
          >
            Copier
          </button>
        </div>
        {!phone && isAdmin && <p className="muted">Indiquez le numéro WhatsApp du gérant ci-contre pour que le message lui soit adressé directement.</p>}
      </section>
      {isAdmin && config.data && <MailSettings initial={config.data} onSaved={config.reload} />}
    </div>
  );
}

function MailSettings({ initial, onSaved }: { initial: Config; onSaved: () => void }) {
  const toast = useToast();
  const [c, setC] = useState(initial);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => setC(initial), [initial]);
  const set = <K extends keyof Config>(k: K, v: Config[K]) => setC({ ...c, [k]: v });
  const save = async () => {
    await call(
      'digest.saveConfig',
      { enabled: c.enabled, hour: c.hour, emails: c.emails, whatsapp: c.whatsapp, smtpHost: c.smtpHost, smtpPort: c.smtpPort, smtpUser: c.smtpUser },
      password || null,
    );
    setPassword('');
    onSaved();
  };
  return (
    <form
      className="digest-settings"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
          await save();
          toast.ok('Réglages du résumé enregistrés');
        } catch (err) {
          toast.error(err);
        } finally {
          setBusy(false);
        }
      }}
    >
      <h3>Envoi automatique par e-mail</h3>
      <p className="muted">
        Réglé sur ce PC uniquement : laissez-le allumé avec FEDONIX 360 ouvert à l'heure d'envoi. S'il était éteint, le résumé de la veille part le
        lendemain au démarrage.
      </p>
      <label className="check">
        <input type="checkbox" checked={c.enabled} onChange={(e) => set('enabled', e.target.checked)} /> Envoyer le résumé chaque soir
      </label>
      <Field label="Heure d'envoi">
        <input type="time" value={c.hour} onChange={(e) => set('hour', e.target.value)} required />
      </Field>
      <Field label="Destinataires (e-mail)" hint="Plusieurs adresses séparées par des virgules">
        <input value={c.emails} onChange={(e) => set('emails', e.target.value)} placeholder="gerant@gmail.com" />
      </Field>
      <Field label="Numéro WhatsApp du gérant" hint="Avec l'indicatif, par exemple 237677000000">
        <input value={c.whatsapp} onChange={(e) => set('whatsapp', e.target.value)} placeholder="237677000000" />
      </Field>
      <h4>Compte qui envoie</h4>
      <p className="muted">
        Avec Gmail : activez la validation en deux étapes du compte, puis créez un « mot de passe d'application » (Compte Google › Sécurité) et
        collez-le ci-dessous.
      </p>
      <Field label="Adresse e-mail d'envoi">
        <input value={c.smtpUser} onChange={(e) => set('smtpUser', e.target.value)} placeholder="magasin@gmail.com" />
      </Field>
      <Field label="Mot de passe" hint={c.hasPassword ? 'Enregistré et chiffré sur ce PC. Laissez vide pour le garder.' : undefined}>
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
      </Field>
      <div className="grid2">
        <Field label="Serveur d'envoi (SMTP)">
          <input value={c.smtpHost} onChange={(e) => set('smtpHost', e.target.value)} />
        </Field>
        <Field label="Port">
          <input type="number" value={c.smtpPort} onChange={(e) => set('smtpPort', Number(e.target.value))} />
        </Field>
      </div>
      {c.lastSent && <p className="muted">Dernier résumé envoyé : {c.lastSent.split('-').reverse().join('/')}</p>}
      <div className="actions" style={{ justifyContent: 'flex-start' }}>
        <button className="primary" disabled={busy}>
          Enregistrer
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await save();
              toast.ok(await call('digest.sendNow'));
            } catch (err) {
              toast.error(err);
            } finally {
              setBusy(false);
            }
          }}
        >
          Enregistrer et envoyer maintenant
        </button>
      </div>
    </form>
  );
}
