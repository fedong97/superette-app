import { useState } from 'react';
import { call } from '../api';
import { Field, useToast } from '../ui';

/** Premier démarrage : création du premier magasin et du compte administrateur. */
export function Setup({ onDone }: { onDone: () => void }) {
  const toast = useToast();
  const [f, setF] = useState({ storeCode: '', storeName: '', address: '', phone: '', taxpayerNumber: '', adminName: '', adminLogin: '', adminPin: '', pin2: '' });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (f.adminPin !== f.pin2) return toast.error('Les deux codes ne correspondent pas');
    try {
      const { pin2: _, ...input } = f;
      await call('setup.bootstrap', input);
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
          <button className="primary big" type="submit">
            Créer le magasin
          </button>
        </div>
      </form>
    </div>
  );
}
