import { useEffect, useRef, useState } from 'react';
import { type Result, call } from '../api';
import { Field, useToast } from '../ui';

export function Login({ station, onDone }: { station: Result<'app.state'>['station']; onDone: () => void }) {
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
        <h1>{station?.store.name ?? 'Superette Gestion'}</h1>
        <p className="muted">{station?.register?.name ?? 'Poste de gestion'}</p>
        <Field label="Identifiant">
          <input ref={loginRef} value={login} onChange={(e) => setLogin(e.target.value)} autoComplete="username" />
        </Field>
        <Field label="Code secret">
          <input ref={pinRef} type="password" inputMode="numeric" value={pin} onChange={(e) => setPin(e.target.value)} autoComplete="current-password" />
        </Field>
        <button className="primary big" type="submit" disabled={!login || pin.length < 4}>
          Se connecter
        </button>
      </form>
    </div>
  );
}
