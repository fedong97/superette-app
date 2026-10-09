import { useState } from 'react';
import { call } from '../api';
import { Field, useToast } from '../ui';

/** Premier démarrage : création du premier magasin et du compte administrateur. */
export function Setup({ onDone }: { onDone: () => void }) {
  const [mode, setMode] = useState<'new' | 'join'>('new');
  if (mode === 'join') return <Join onDone={onDone} onBack={() => setMode('new')} />;
  return <NewStore onDone={onDone} onJoin={() => setMode('join')} />;
}

/** PC supplémentaire : rejoint un magasin déjà déclaré sur le serveur central. */
function Join({ onDone, onBack }: { onDone: () => void; onBack: () => void }) {
  const toast = useToast();
  const [url, setUrl] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const station = await call('setup.join', url, code);
      toast.ok(`PC relié : ${station?.store.name}, ${station?.register?.name}`);
      onDone();
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="center-page">
      <form className="card setup" onSubmit={submit}>
        <h1>Rejoindre un magasin</h1>
        <p>
          Sur le PC principal, dans Administration › Caisses, créez une caisse et notez son code d'activation. Ce PC récupère ensuite le
          catalogue, les utilisateurs et le stock du magasin depuis le serveur central.
        </p>
        <div className="grid2">
          <Field label="Adresse du serveur central" hint="ex. https://superette.mondomaine.cm">
            <input value={url} onChange={(e) => setUrl(e.target.value)} required />
          </Field>
          <Field label="Code d'activation de la caisse" hint="6 chiffres">
            <input value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} inputMode="numeric" maxLength={6} required />
          </Field>
        </div>
        <div className="actions">
          <button type="button" onClick={onBack} disabled={busy}>
            Retour
          </button>
          <button className="primary big" type="submit" disabled={busy || code.length !== 6}>
            {busy ? 'Récupération des données…' : 'Rejoindre'}
          </button>
        </div>
      </form>
    </div>
  );
}

function NewStore({ onDone, onJoin }: { onDone: () => void; onJoin: () => void }) {
  const toast = useToast();
  const [f, setF] = useState({ storeCode: '', storeName: '', address: '', phone: '', taxpayerNumber: '', adminName: '', adminLogin: '', adminPin: '', pin2: '' });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  /** Beaucoup de superettes sont au régime simplifié : pas de TVA tant qu'on ne la coche pas. */
  const [vatEnabled, setVatEnabled] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (f.adminPin !== f.pin2) return toast.error('Les deux codes ne correspondent pas');
    try {
      const { pin2: _, ...input } = f;
      await call('setup.bootstrap', { ...input, vatEnabled });
      toast.ok('Magasin créé');
      onDone();
    } catch (err) {
      toast.error(err);
    }
  };
  return (
    <div className="center-page">
      <form className="card setup" onSubmit={submit}>
        <h1>Bienvenue</h1>
        <p>Première installation : renseignez votre magasin et le compte administrateur. Vous pourrez ajouter d'autres magasins et caisses ensuite.</p>
        <h3>Magasin</h3>
        <div className="grid2">
          <Field label="Code magasin" hint="2 à 6 caractères, ex. DLA1">
            <input value={f.storeCode} onChange={set('storeCode')} required maxLength={6} />
          </Field>
          <Field label="Nom du magasin">
            <input value={f.storeName} onChange={set('storeName')} required />
          </Field>
          <Field label="Adresse">
            <input value={f.address} onChange={set('address')} />
          </Field>
          <Field label="Téléphone">
            <input value={f.phone} onChange={set('phone')} />
          </Field>
          <Field label="NIU (numéro contribuable)">
            <input value={f.taxpayerNumber} onChange={set('taxpayerNumber')} />
          </Field>
        </div>
        <label className="check">
          <input type="checkbox" checked={vatEnabled} onChange={(e) => setVatEnabled(e.target.checked)} /> Magasin assujetti à la TVA (régime du réel)
        </label>
        <p className="muted">
          {vatEnabled
            ? 'Les prix sont TTC : la TVA (19,25 %) est calculée et imprimée sur les tickets et les factures.'
            : 'Régime simplifié : aucune TVA sur les ventes, les achats ni les dépenses. Les tickets portent « TVA non applicable ». Un administrateur pourra l’activer plus tard.'}
        </p>
        <h3>Administrateur</h3>
        <div className="grid2">
          <Field label="Nom complet">
            <input value={f.adminName} onChange={set('adminName')} required />
          </Field>
          <Field label="Identifiant">
            <input value={f.adminLogin} onChange={set('adminLogin')} required />
          </Field>
          <Field label="Code secret" hint="4 à 8 chiffres">
            <input type="password" inputMode="numeric" value={f.adminPin} onChange={set('adminPin')} required />
          </Field>
          <Field label="Confirmer le code">
            <input type="password" inputMode="numeric" value={f.pin2} onChange={set('pin2')} required />
          </Field>
        </div>
        <div className="actions">
          <button type="button" onClick={onJoin}>
            Rejoindre un magasin existant
          </button>
          <button className="primary big" type="submit">
            Créer le magasin
          </button>
        </div>
      </form>
    </div>
  );
}
