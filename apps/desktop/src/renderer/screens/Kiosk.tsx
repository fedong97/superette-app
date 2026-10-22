import { useEffect, useRef, useState } from 'react';
import { type Result, call } from '../api';
import logo from '../assets/logo.png';
import { Field, Mascot, Modal, useLoad, useToast } from '../ui';

type Punch = Result<'kiosk.punch'>;
type Shown = { ok: true; result: Punch } | { ok: false; message: string };

const hm = (iso: string) => new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });

/** Bip de la borne : aigu quand c'est bon, grave en cas de refus. */
function beep(ok: boolean) {
  try {
    const ctx = new AudioContext();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.value = ok ? 1046 : 220;
    g.gain.value = 0.15;
    o.connect(g).connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + (ok ? 0.15 : 0.45));
    o.onended = () => void ctx.close();
  } catch {
    // Pas de son sur ce PC : la borne marche sans.
  }
}

/**
 * Borne de pointage à l'entrée du magasin : la personne passe son badge
 * (la douchette tape le code puis Entrée) ou tape son numéro et son code.
 * La caméra prend une photo à chaque passage si le magasin l'a choisi.
 * Arrivée ou départ, selon qu'elle est déjà là.
 */
export function Kiosk({ overlay, onExit, onLogin }: { overlay?: boolean; onExit?: () => void; onLogin?: () => void }) {
  const state = useLoad(() => call('kiosk.state'), []);
  const entrances = useLoad(() => (overlay ? call('personnel.entrances') : Promise.resolve([])), []);
  const [entranceId, setEntranceId] = useState<string | null>(null);
  const [now, setNow] = useState(new Date());
  const [badge, setBadge] = useState('');
  const [mode, setMode] = useState<'badge' | 'number' | 'pin'>('badge');
  const [number, setNumber] = useState('');
  const [pin, setPin] = useState('');
  const [shown, setShown] = useState<Shown | null>(null);
  const [busy, setBusy] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [camera, setCamera] = useState<'off' | 'on' | 'error'>('off');
  const input = useRef<HTMLInputElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const hide = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const k = state.data;

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  // La saisie du badge garde le clavier : la douchette tape dedans à tout moment.
  useEffect(() => {
    const t = setInterval(() => {
      if (!leaving && mode === 'badge' && document.activeElement !== input.current) input.current?.focus();
    }, 700);
    return () => clearInterval(t);
  }, [leaving, mode]);
  // Caméra de la borne, si le magasin prend une photo à chaque passage.
  useEffect(() => {
    if (!k?.photo) return;
    let stream: MediaStream | null = null;
    let alive = true;
    navigator.mediaDevices
      ?.getUserMedia({ video: { width: 320, height: 240 }, audio: false })
      .then((s) => {
        if (!alive) return s.getTracks().forEach((t) => t.stop());
        stream = s;
        if (video.current) {
          video.current.srcObject = s;
          void video.current.play().catch(() => undefined);
        }
        setCamera('on');
      })
      .catch(() => setCamera('error'));
    return () => {
      alive = false;
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [k?.photo]);
  useEffect(() => () => clearTimeout(hide.current), []);

  const snapshot = (): string | null => {
    const v = video.current;
    if (!k?.photo || camera !== 'on' || !v || !v.videoWidth) return null;
    const c = document.createElement('canvas');
    c.width = 240;
    c.height = Math.round((240 * v.videoHeight) / v.videoWidth);
    c.getContext('2d')!.drawImage(v, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.6);
  };

  const show = (s: Shown) => {
    setShown(s);
    beep(s.ok);
    clearTimeout(hide.current);
    hide.current = setTimeout(() => setShown(null), s.ok ? 4000 : 5000);
  };

  const punch = async (input: { badge?: string; number?: string; pin?: string }) => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await call('kiosk.punch', { ...input, photo: snapshot(), entranceId: overlay ? entranceId : null });
      show({ ok: true, result });
    } catch (e) {
      show({ ok: false, message: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
      setBadge('');
      setNumber('');
      setPin('');
      if (mode !== 'badge') setMode(k?.badge ? 'badge' : 'number');
    }
  };

  if (!k) return <div className="kiosk">{state.error ? <p className="neg">{String((state.error as Error).message ?? state.error)}</p> : 'Chargement…'}</div>;
  const usable = k.enabled && (k.badge || k.pin);
  const keypad = (value: string, set: (v: string) => void, onOk: () => void) => (
    <div className="kiosk-pad">
      {['1', '2', '3', '4', '5', '6', '7', '8', '9', '⌫', '0', 'OK'].map((d) => (
        <button
          key={d}
          type="button"
          className={d === 'OK' ? 'primary' : ''}
          onClick={() => (d === '⌫' ? set(value.slice(0, -1)) : d === 'OK' ? onOk() : set((value + d).slice(0, 8)))}
        >
          {d}
        </button>
      ))}
    </div>
  );

  return (
    <div className={`kiosk ${overlay ? 'overlay' : ''}`}>
      <header>
        <div className="brand">
          <img src={logo} alt="" width={36} height={36} />
          <span>{k.store}</span>
        </div>
        <span>{k.entranceName ?? (overlay && k.multiEntrances ? '' : 'Pointage du personnel')}</span>
        {overlay && k.multiEntrances && (
          <select value={entranceId ?? ''} onChange={(e) => setEntranceId(e.target.value || null)} title="Entrée de cette borne">
            <option value="">Entrée principale</option>
            {(entrances.data ?? []).map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </select>
        )}
      </header>
      <div className="kiosk-clock">
        <b>{now.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</b>
        <span>{now.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</span>
      </div>

      {shown ? (
        <div className={`kiosk-result ${shown.ok ? (shown.result.punch.kind === 'in' ? 'in' : 'out') : 'refused'}`}>
          {shown.ok ? (
            <>
              {shown.result.staff.photo ? <img src={shown.result.staff.photo} alt="" /> : <Mascot mood={shown.result.punch.kind === 'in' ? 'bonjour' : 'bravo'} size={120} />}
              <div>
                <h2>
                  {shown.result.punch.kind === 'in' ? 'Bonjour' : 'Au revoir'} {shown.result.staff.name}
                </h2>
                <p className="kiosk-big">
                  {shown.result.duplicate ? 'Déjà noté à' : shown.result.punch.kind === 'in' ? 'Arrivée à' : 'Départ à'} {hm(shown.result.punch.at)}
                </p>
                {!shown.result.duplicate && shown.result.late_minutes > 0 && (
                  <p className="kiosk-warn">
                    En retard de {shown.result.late_minutes} min (début prévu à {shown.result.expected})
                  </p>
                )}
                {shown.result.duplicate && <p>Votre passage était déjà enregistré.</p>}
              </div>
            </>
          ) : (
            <>
              <Mascot mood="alerte" size={120} />
              <div>
                <h2>Pointage refusé</h2>
                <p className="kiosk-big">{shown.message}</p>
              </div>
            </>
          )}
        </div>
      ) : !usable ? (
        <div className="kiosk-result refused">
          <div>
            <h2>Borne désactivée</h2>
            <p>Le gérant l’active dans Administration › Paramètres › Pointage du personnel.</p>
          </div>
        </div>
      ) : mode === 'badge' ? (
        <div className="kiosk-ask">
          {k.badge ? (
            <>
              <h2>Passez votre badge</h2>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (badge.trim()) void punch({ badge: badge.trim() });
                }}
              >
                <input ref={input} className="kiosk-scan" value={badge} onChange={(e) => setBadge(e.target.value)} placeholder="Badge" autoFocus autoComplete="off" />
              </form>
            </>
          ) : null}
          {k.pin && (
            <button type="button" className="big" onClick={() => setMode('number')}>
              {k.badge ? 'Pas de badge ? Tapez votre numéro' : 'Tapez votre numéro de pointage'}
            </button>
          )}
        </div>
      ) : mode === 'number' ? (
        <div className="kiosk-ask">
          <h2>Votre numéro de pointage</h2>
          <div className="kiosk-digits">{number || '·'}</div>
          {keypad(number, setNumber, () => number && setMode('pin'))}
          {k.badge && (
            <button type="button" className="link" onClick={() => setMode('badge')}>
              Retour au badge
            </button>
          )}
        </div>
      ) : (
        <div className="kiosk-ask">
          <h2>Votre code de pointage</h2>
          <div className="kiosk-digits">{'●'.repeat(pin.length) || '·'}</div>
          {keypad(pin, setPin, () => pin.length >= 4 && void punch({ number, pin }))}
          <button type="button" className="link" onClick={() => setMode('number')}>
            Changer de numéro
          </button>
        </div>
      )}

      <footer>
        {k.photo && (
          <div className="kiosk-cam" title={camera === 'error' ? 'Caméra introuvable : le pointage se fait sans photo' : 'Une photo est prise à chaque passage'}>
            <video ref={video} muted playsInline />
            {camera === 'error' && <small className="neg">Caméra introuvable</small>}
          </div>
        )}
        <span className="spacer" />
        {onLogin && (
          <button type="button" className="ghost" onClick={onLogin}>
            Connexion au logiciel
          </button>
        )}
        {overlay && (
          <button type="button" className="ghost" onClick={() => setLeaving(true)}>
            Quitter la borne
          </button>
        )}
      </footer>
      {leaving && <ExitPrompt onCancel={() => setLeaving(false)} onDone={() => onExit?.()} />}
    </div>
  );
}

/** Quitter la borne ouverte par le gérant : son code (ou celui d'un autre gérant) est demandé. */
function ExitPrompt({ onCancel, onDone }: { onCancel: () => void; onDone: () => void }) {
  const toast = useToast();
  const [pin, setPin] = useState('');
  return (
    <Modal title="Quitter la borne de pointage" onClose={onCancel}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await call('auth.checkSupervisor', pin);
            onDone();
          } catch (err) {
            setPin('');
            toast.error(err);
          }
        }}
      >
        <Field label="Code du gérant">
          <input autoFocus type="password" inputMode="numeric" value={pin} onChange={(e) => setPin(e.target.value)} />
        </Field>
        <div className="actions">
          <button type="button" className="ghost" onClick={onCancel}>
            Annuler
          </button>
          <button type="submit" className="primary" disabled={pin.length < 4}>
            Quitter
          </button>
        </div>
      </form>
    </Modal>
  );
}
