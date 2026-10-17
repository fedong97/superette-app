import { useEffect, useRef, useState } from 'react';
import { type Result, call } from '../api';
import logo from '../assets/logo.png';
import { Field, useToast } from '../ui';
import { DossierPicker } from './Dossiers';

export function Login({ station, fiche, onDone }: { station: Result<'app.state'>['station']; fiche: Result<'app.state'>['dossier']['fiche']; onDone: () => void }) {
  const [dossiers, setDossiers] = useState(false);
  const toast = useToast();
  const [login, setLogin] = useState('');
  const [pin, setPin] = useState('');
  const pinRef = useRef<HTMLInputElement>(null);
  const loginRef = useRef<HTMLInputElement>(null);
  useEffect(() => loginRef.current?.focus(), []);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await call('auth.login', login, pin);
      onDone();
    } catch (err) {
      setPin('');
      pinRef.current?.focus();
      toast.error(err);
    }
  };
  return (
    <div className="center-page">
      <form className="card login" onSubmit={submit}>
        <div className="brand">
          <img src={logo} alt="" width={40} height={40} />
          <span>FEDONIX 360</span>
        </div>
        <h1>{station?.store.name ?? 'FEDONIX 360'}</h1>
        <p className="muted">{station?.register?.name ?? 'Poste de gestion'}</p>
        {fiche && fiche.kind !== 'installation' && <p className="warn-text">{fiche.banner}</p>}
        <Field label="Identifiant">
          <input ref={loginRef} value={login} onChange={(e) => setLogin(e.target.value)} autoComplete="username" />
        </Field>
        <Field label="Code secret">
          <input ref={pinRef} type="password" inputMode="numeric" value={pin} onChange={(e) => setPin(e.target.value)} autoComplete="current-password" />
        </Field>
        <button className="primary big" type="submit" disabled={!login || pin.length < 4}>
          Se connecter
        </button>
        <button type="button" className="link" onClick={() => setDossiers(true)}>
          Changer de boutique
        </button>
      </form>
      {dossiers && <DossierPicker onClose={() => setDossiers(false)} />}
    </div>
  );
}
