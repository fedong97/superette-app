import { type ReactNode, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { ApiError } from './api';
import { readXlsxRows } from '@superette/core/src/xlsxRead';
import { beepError, beepOk, listenWedge, native, shareFile, shrinkPhoto, startCamera, toggleTorch } from './device';
import {
  type Article,
  type Hit,
  type PlaceCount,
  addDetail,
  buildIndex,
  csvRows,
  exportCountFile,
  formatQty,
  parseNumber,
  guestCode,
  levels,
  lookup,
  normalizeUrl,
  parseCountFile,
  parsePairing,
  partsToDetail,
  partsToQty,
  phoneTotal,
  placeKey,
  recapCsv,
  search,
} from './logic';
import * as S from './state';

const VERSION = __APP_VERSION__;

const useStore = () => useSyncExternalStore(S.subscribe, S.getState);
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const heure = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : '');

const remember = (key: string, value: string | null) => {
  try {
    if (value) sessionStorage.setItem(key, value);
    else sessionStorage.removeItem(key);
  } catch {
    /* rien */
  }
};
const recall = (key: string) => {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
};

export function App() {
  const s = useStore();
  const [inventoryId, setInventoryId] = useState<string | null>(() => recall('inventaire'));
  const [recapId, setRecapId] = useState<string | null>(null);
  // Mode fichier : compter sans serveur ni connexion, à partir d'une fiche.
  const [fileMode, setFileMode] = useState(() => recall('mode-fichier') === '1');
  const choose = (id: string | null) => {
    setInventoryId(id);
    remember('inventaire', id);
  };
  const files = (on: boolean) => {
    setFileMode(on);
    remember('mode-fichier', on ? '1' : null);
  };
  // Panier préparé au rayon (vendeur) : à la place des inventaires.
  const [cartMode, setCartMode] = useState(() => recall('panier') === '1');
  const cartOn = (on: boolean) => {
    setCartMode(on);
    remember('panier', on ? '1' : null);
  };
  // Réception d'une livraison (magasinier) : à la place des inventaires.
  const [receiveMode, setReceiveMode] = useState(() => recall('reception') === '1');
  const receiveOn = (on: boolean) => {
    setReceiveMode(on);
    remember('reception', on ? '1' : null);
  };
  if (!s.ready) return <div className="splash">FEDONIX 360 Inventaire</div>;
  const connected = Boolean(s.config && s.session);
  const inventory = [...(connected ? s.inventories : []), ...s.files].find((i) => i.id === inventoryId) ?? null;
  const archive = s.archives.find((a) => a.inventory.id === recapId);
  const recapFile = s.files.find((f) => f.id === recapId);
  const can = s.session?.can;
  const cartOnly = Boolean(connected && can && can.cart && !can.count);
  let page: ReactNode;
  if (connected && can?.receive && receiveMode) page = <Receive onBack={() => receiveOn(false)} />;
  else if (connected && can?.cart && (cartOnly || cartMode)) page = <ShelfCart onBack={cartOnly ? null : () => cartOn(false)} onReceive={can.receive ? () => receiveOn(true) : undefined} />;
  else if (archive) page = <Recap inventory={archive.inventory} counts={archive.counts} closed onClose={() => setRecapId(null)} />;
  else if (recapFile) page = <Recap inventory={recapFile} counts={s.counts} closed={recapFile.closed} onClose={() => setRecapId(null)} />;
  else if (inventory && recapId === inventory.id) page = <Recap inventory={inventory} counts={s.counts} closed={false} onClose={() => setRecapId(null)} />;
  else if (inventory && !(S.isFile(inventory) && inventory.closed)) page = <Count inventory={inventory} onBack={() => choose(null)} onRecap={() => setRecapId(inventory.id)} />;
  else if (connected || fileMode)
    page = (
      <Inventories
        onChoose={choose}
        onRecap={setRecapId}
        onLeaveFiles={connected ? undefined : () => files(false)}
        onCart={connected && can?.cart ? () => cartOn(true) : undefined}
        onReceive={connected && can?.receive ? () => receiveOn(true) : undefined}
      />
    );
  else if (!s.config) page = <Pairing onFiles={() => files(true)} />;
  else page = <Login onFiles={() => files(true)} />;
  return (
    <div className="app">
      <Notices />
      {page}
    </div>
  );
}

function Notices() {
  const s = useStore();
  if (!s.notices.length) return null;
  return (
    <div className="notices">
      {s.notices.map((n) => (
        <div key={n.id} className={`notice ${n.level}`} onClick={() => S.dismiss(n.id)}>
          {n.text}
          <span className="x">×</span>
        </div>
      ))}
    </div>
  );
}

function Status() {
  const s = useStore();
  const label = s.online === false ? 'Hors ligne' : s.syncing ? 'Envoi…' : s.pending ? `${s.pending} à envoyer` : 'À jour';
  return (
    <button
      className={`status ${s.online === false ? 'off' : s.pending ? 'wait' : 'ok'}`}
      onClick={() => void S.sync()}
      title={s.lastSync ? `Dernier échange à ${heure(s.lastSync)}` : ''}
    >
      <span className="dot" />
      {label}
    </button>
  );
}

// ——— Caméra plein écran (QR du gérant ou codes-barres) ———

function CameraOverlay({ title, hint, onStop, children }: { title: string; hint?: string; onStop: () => void; children?: ReactNode }) {
  return (
    <div className="camera-ui">
      <div className="camera-top">
        <b>{title}</b>
        <button className="ghost" onClick={() => void toggleTorch()}>
          Lampe
        </button>
      </div>
      <div className="viseur" />
      {hint ? <div className="camera-hint">{hint}</div> : null}
      <div className="camera-bottom">
        {children}
        <button className="big" onClick={onStop}>
          Terminer
        </button>
      </div>
    </div>
  );
}

/** Caméra en marche tant que le composant est affiché. */
function useCamera(active: boolean, onCode: (code: string) => void, onError: (e: unknown) => void) {
  const handler = useRef(onCode);
  handler.current = onCode;
  useEffect(() => {
    if (!active) return;
    let stop: (() => Promise<void>) | null = null;
    let cancelled = false;
    startCamera((c) => handler.current(c))
      .then((fn) => {
        if (cancelled) void fn();
        else stop = fn;
      })
      .catch((e) => !cancelled && onError(e));
    return () => {
      cancelled = true;
      if (stop) void stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);
}

// ——— Rattachement au magasin ———

function FileModeLink({ onFiles }: { onFiles: () => void }) {
  return (
    <button className="link" onClick={onFiles}>
      Compter avec un fichier, sans serveur
    </button>
  );
}

function Pairing({ onFiles }: { onFiles: () => void }) {
  const [camera, setCamera] = useState(false);
  const [manual, setManual] = useState(!native);
  const [address, setAddress] = useState('');
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const go = async (urls: string[], pairingCode: string, guest?: string) => {
    setBusy(true);
    setError('');
    try {
      await S.pair(urls, pairingCode, name.trim() || 'Téléphone d’inventaire', guest ?? guestCode(pairingCode) ?? undefined);
    } catch (e) {
      setError(message(e));
      beepError();
    } finally {
      setBusy(false);
    }
  };
  useCamera(
    camera,
    (text) => {
      const p = parsePairing(text);
      if (!p) return;
      setCamera(false);
      beepOk();
      void go(p.urls, p.code, p.guest);
    },
    (e) => {
      setCamera(false);
      setError(message(e));
    },
  );

  if (camera) return <CameraOverlay title="QR code du gérant" hint="Visez le QR code affiché sur la page Inventaire du gérant" onStop={() => setCamera(false)} />;
  return (
    <div className="page center">
      <img className="logo" src="./icon.png" alt="" />
      <h1>FEDONIX 360 Inventaire</h1>
      <p className="muted">
        Reliez ce téléphone au magasin : le gérant ouvre FEDONIX 360 Gérant › Inventaire et affiche le QR code. Vous venez aider sans compte ? Scannez le QR code d’aide que le
        gérant vous montre.
      </p>
      <label className="field">
        Nom de ce téléphone
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex. : Samsung d’Awa" maxLength={60} />
      </label>
      {error ? <div className="notice erreur">{error}</div> : null}
      {native ? (
        <button className="big primary" disabled={busy} onClick={() => setCamera(true)}>
          {busy ? 'Connexion…' : 'Scanner le QR code'}
        </button>
      ) : null}
      {manual ? (
        <form
          className="card"
          onSubmit={(e) => {
            e.preventDefault();
            const url = normalizeUrl(address);
            if (!url) return setError('Adresse du serveur invalide');
            void go([url], code);
          }}
        >
          <label className="field">
            Adresse du serveur
            <input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="192.168.1.10:3000" inputMode="url" autoCapitalize="off" />
          </label>
          <label className="field">
            Code affiché sous le QR, ou code d’aide (6 chiffres)
            <input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="ABCD 2345" autoCapitalize="characters" />
          </label>
          <button className="big" disabled={busy || !address || !code}>
            Relier
          </button>
        </form>
      ) : (
        <button className="link" onClick={() => setManual(true)}>
          Saisir l’adresse et le code à la main
        </button>
      )}
      <FileModeLink onFiles={onFiles} />
      <p className="muted small">Version {VERSION}</p>
    </div>
  );
}

// ——— Connexion du compteur ———

function Login({ onFiles }: { onFiles: () => void }) {
  const s = useStore();
  const [guest, setGuest] = useState(false);
  const [login, setLogin] = useState(() => localStorage.getItem('dernier-identifiant') ?? '');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [menu, setMenu] = useState(false);
  return (
    <div className="page center">
      <img className="logo" src="./icon.png" alt="" />
      <h1>{s.config!.storeName}</h1>
      {guest ? <GuestLogin onBack={() => setGuest(false)} /> : null}
      <p className="muted" hidden={guest}>
        Connectez-vous avec votre identifiant et votre code de FEDONIX 360.
      </p>
      <form
        hidden={guest}
        className="card"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError('');
          try {
            await S.login(login, pin);
            localStorage.setItem('dernier-identifiant', login);
          } catch (err) {
            setError(err instanceof ApiError && err.status === 0 ? 'Pas de connexion au serveur. Vérifiez le Wi-Fi du magasin.' : message(err));
            setPin('');
          } finally {
            setBusy(false);
          }
        }}
      >
        <label className="field">
          Identifiant
          <input value={login} onChange={(e) => setLogin(e.target.value)} autoCapitalize="off" autoCorrect="off" autoComplete="username" />
        </label>
        <label className="field">
          Code
          <input value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} type="password" inputMode="numeric" maxLength={8} autoComplete="current-password" />
        </label>
        {error ? <div className="notice erreur">{error}</div> : null}
        <button className="big primary" disabled={busy || !login || pin.length < 4}>
          {busy ? 'Connexion…' : 'Se connecter'}
        </button>
      </form>
      {!guest ? (
        <button className="big" onClick={() => setGuest(true)}>
          Je suis un aide (sans compte)
        </button>
      ) : null}
      {s.pending ? <p className="muted">{s.pending} saisie(s) attendent d’être envoyées.</p> : null}
      <button className="link" onClick={() => setMenu(true)}>
        Réglages du téléphone
      </button>
      <FileModeLink onFiles={onFiles} />
      {menu ? <Settings onClose={() => setMenu(false)} /> : null}
    </div>
  );
}

/** Aide sans compte : le code à 6 chiffres ou le QR code d'aide affiché par le gérant. */
function GuestLogin({ onBack }: { onBack: () => void }) {
  const [code, setCode] = useState('');
  const [camera, setCamera] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const go = async (c: string) => {
    setBusy(true);
    setError('');
    try {
      await S.loginGuest(c);
    } catch (e) {
      setError(e instanceof ApiError && e.status === 0 ? 'Pas de connexion au serveur. Vérifiez le Wi-Fi du magasin.' : message(e));
      beepError();
    } finally {
      setBusy(false);
    }
  };
  useCamera(
    camera,
    (text) => {
      const g = parsePairing(text)?.guest ?? guestCode(text);
      if (!g) return;
      setCamera(false);
      beepOk();
      void go(g);
    },
    (e) => {
      setCamera(false);
      setError(message(e));
    },
  );
  if (camera) return <CameraOverlay title="QR code d’aide" hint="Visez le QR code d’aide affiché par le gérant" onStop={() => setCamera(false)} />;
  const valid = guestCode(code);
  return (
    <form
      className="card"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) void go(valid);
      }}
    >
      <p className="muted">Le gérant vous a créé un accès pour cet inventaire : scannez son QR code ou tapez le code à 6 chiffres. Pas besoin d’identifiant.</p>
      {native ? (
        <button type="button" className="big primary" disabled={busy} onClick={() => setCamera(true)}>
          Scanner le QR code d’aide
        </button>
      ) : null}
      <label className="field">
        Code d’aide
        <input value={code} onChange={(e) => setCode(e.target.value.replace(/[^\d ]/g, ''))} inputMode="numeric" maxLength={7} placeholder="123 456" />
      </label>
      {error ? <div className="notice erreur">{error}</div> : null}
      <button className="big" disabled={busy || !valid}>
        {busy ? 'Connexion…' : 'Commencer à compter'}
      </button>
      <button type="button" className="link" onClick={onBack}>
        J’ai un identifiant
      </button>
    </form>
  );
}

// ——— Choix de l'inventaire ———

async function readCountFile(f: File) {
  if (/\.xlsx$/i.test(f.name)) return parseCountFile(await readXlsxRows(new Uint8Array(await f.arrayBuffer())));
  const buf = await f.arrayBuffer();
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    // CSV enregistré par Excel sans UTF-8 : accents en Windows-1252.
    text = new TextDecoder('windows-1252').decode(buf);
  }
  return parseCountFile(csvRows(text));
}

function progress(inv: S.ServerInventory, counts: Record<string, PlaceCount>) {
  const counted = new Set(inv.counted.map((c) => c.articleId));
  for (const k of Object.keys(counts)) if (k.startsWith(`${inv.id}|`)) counted.add(k.split('|')[1]!);
  return counted.size;
}

function Inventories({
  onChoose,
  onRecap,
  onLeaveFiles,
  onCart,
  onReceive,
}: {
  onChoose: (id: string) => void;
  onRecap: (id: string) => void;
  onLeaveFiles?: () => void;
  onCart?: () => void;
  onReceive?: () => void;
}) {
  const s = useStore();
  const [menu, setMenu] = useState(false);
  const [filter, setFilter] = useState<'open' | 'closed'>('open');
  const [error, setError] = useState('');
  const picker = useRef<HTMLInputElement>(null);
  const connected = Boolean(s.config && s.session);
  const openFiles = s.files.filter((f) => !f.closed);
  const closedFiles = s.files.filter((f) => f.closed);
  const card = (inv: S.ServerInventory, onClick: () => void, extra?: string) => {
    const done = progress(inv, s.counts);
    const pct = inv.articleIds.length ? Math.round((done / inv.articleIds.length) * 100) : 0;
    const file = S.isFile(inv);
    return (
      <button key={inv.id} className="card inventory" onClick={onClick}>
        <div className="row">
          <b className="grow">
            {file ? inv.number : `N° ${inv.number}`}
            {inv.label && !file ? ` · ${inv.label}` : ''}
          </b>
          <span className="pill">{file ? 'Fichier' : inv.kind === 'global' ? 'Global' : 'Partiel'}</span>
        </div>
        <div className="muted">
          {file ? `Ouvert le ${new Date(inv.createdAt).toLocaleDateString('fr-FR')}` : `${inv.warehouseName} · date ${inv.inventoryDate.split('-').reverse().join('/')}`}
          {extra ? ` · ${extra}` : ''}
        </div>
        <div className="gauge">
          <div style={{ width: `${pct}%` }} />
        </div>
        <div className="muted small">
          {done} / {inv.articleIds.length} produits comptés
          {inv.assigned.length ? ` · ${inv.assigned.length} rayon(s) pour vous` : ''}
          {inv.recount.length ? ` · ${inv.recount.length} à recompter` : ''}
        </div>
      </button>
    );
  };
  return (
    <div className="page">
      <header className="bar">
        <div className="grow">
          <b>{connected ? s.config!.storeName : 'Mode fichier'}</b>
          <small>{connected ? s.session!.user.name : 'Sans serveur ni connexion'}</small>
        </div>
        {connected ? <Status /> : null}
        <button className="ghost" onClick={() => setMenu(true)} aria-label="Menu">
          ☰
        </button>
      </header>
      <main>
        {onReceive ? (
          <button className="big" onClick={onReceive}>
            Réceptionner une livraison
          </button>
        ) : null}
        {onCart ? (
          <button className="big primary" onClick={onCart}>
            Préparer un panier pour un client
          </button>
        ) : null}
        <div className="tabs">
          <button className={filter === 'open' ? 'on' : ''} onClick={() => setFilter('open')}>
            En cours
          </button>
          <button className={filter === 'closed' ? 'on' : ''} onClick={() => setFilter('closed')}>
            Clôturés{s.archives.length + closedFiles.length ? ` (${s.archives.length + closedFiles.length})` : ''}
          </button>
        </div>
        {filter === 'open' ? (
          <>
            {connected && !s.catalog ? <div className="card muted">Téléchargement du catalogue…</div> : null}
            {connected ? s.inventories.map((inv) => card(inv, () => onChoose(inv.id))) : null}
            {connected && !s.inventories.length ? (
              <div className="card muted">
                Aucun inventaire ouvert dans ce magasin. Le gérant le crée sur un PC (Stock › Inventaires), puis il apparaît ici.
                <button className="big" onClick={() => void S.sync()}>
                  Actualiser
                </button>
              </div>
            ) : null}
            {openFiles.map((f) => card(f, () => onChoose(f.id)))}
            {error ? <div className="notice erreur">{error}</div> : null}
            <button className="big" hidden={s.session?.user.role === 'guest'} onClick={() => picker.current?.click()}>
              Ouvrir une fiche de comptage (fichier)
            </button>
            <p className="muted small" hidden={s.session?.user.role === 'guest'}>
              Sans Wi-Fi au magasin : exportez sur le PC la fiche à remplir (Inventaires › Fiche Excel) ou un fichier texte « code;nom;quantité », envoyez-la sur ce
              téléphone, comptez, puis renvoyez la fiche remplie au PC (bouton Importer).
            </p>
            <input
              ref={picker}
              type="file"
              hidden
              onChange={async (e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (!f) return;
                setError('');
                try {
                  const parsed = await readCountFile(f);
                  if (!parsed.lines.length) throw new Error('Aucun produit trouvé dans ce fichier. Il faut une colonne Code et une colonne Produit, ou des lignes « code;nom;quantité ».');
                  onChoose(S.openFile(f.name, parsed).id);
                } catch (err) {
                  setError(message(err));
                }
              }}
            />
          </>
        ) : (
          <>
            {s.archives.map((a) => card(a.inventory, () => onRecap(a.inventory.id), `clôturé le ${new Date(a.closedAt).toLocaleDateString('fr-FR')}`))}
            {closedFiles.map((f) => card(f, () => onRecap(f.id), 'clôturé'))}
            {!s.archives.length && !closedFiles.length ? (
              <div className="card muted">Aucun inventaire clôturé. Quand le gérant clôture un inventaire sur le PC, vos comptages restent consultables ici.</div>
            ) : null}
          </>
        )}
        {onLeaveFiles ? (
          <button className="link" onClick={onLeaveFiles}>
            {s.config ? 'Se connecter au magasin' : 'Relier ce téléphone au magasin'}
          </button>
        ) : null}
      </main>
      {menu ? <Settings onClose={() => setMenu(false)} /> : null}
    </div>
  );
}

// ——— Panier préparé au rayon ———

const fcfa = (n: number) => `${Math.round(n).toLocaleString('fr-FR')} FCFA`;

/**
 * Le vendeur accompagne le client au rayon, scanne ses produits, puis envoie
 * le panier à la caisse : le caissier le retrouve dans « Tickets en attente »
 * et l'encaisse ; la vente compte pour le vendeur.
 */
function ShelfCart({ onBack, onReceive }: { onBack: (() => void) | null; onReceive?: () => void }) {
  const s = useStore();
  const [info, setInfo] = useState<Article | null>(null);
  const [missed, setMissed] = useState<{ article: Article | null; label: string } | null>(null);
  const canMissed = Boolean(s.session?.can?.missed);
  const [camera, setCamera] = useState(false);
  const [query, setQuery] = useState('');
  const [flash, setFlash] = useState<{ text: string; ok: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<number | null>(null);
  const seen = useRef<{ code: string; at: number }>({ code: '', at: 0 });
  const flashTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => void S.loadSentCarts(), []);

  const show = (text: string, ok: boolean) => {
    setFlash({ text, ok });
    clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlash(null), 2500);
  };
  const add = (a: Article, qty: number) => {
    S.addToCart(a.id, qty);
    setSent(null);
    beepOk();
    show(`${a.name} : +${formatQty(qty, a)}`, true);
  };
  const onCode = (raw: string, fromCamera: boolean) => {
    const code = raw.trim();
    const now = Date.now();
    if (fromCamera && code === seen.current.code && now - seen.current.at < 2000) {
      seen.current.at = now;
      return;
    }
    seen.current = { code, at: now };
    const hit = lookup(S.getState().index, code);
    if (hit) return add(hit.article, hit.qty);
    void S.findOnServer(code)
      .catch(() => [] as Article[])
      .then(() => {
        const again = lookup(S.getState().index, code);
        if (again) return add(again.article, again.qty);
        beepError();
        show(`Code ${code} inconnu : cherchez le produit par son nom`, false);
      });
  };
  useCamera(
    camera,
    (c) => onCode(c, true),
    (e) => {
      setCamera(false);
      show(message(e), false);
    },
  );
  const wedge = useRef(onCode);
  wedge.current = onCode;
  useEffect(() => listenWedge((c) => wedge.current(c, false)), []);

  const results = useMemo(() => (query.trim().length >= 2 ? search(s.catalog?.articles ?? [], query, 30) : []), [query, s.catalog]);
  const lines = s.cart.map((l) => ({ ...l, article: s.articles.get(l.articleId) })).filter((l): l is S.CartLine & { article: Article } => Boolean(l.article));
  const total = lines.reduce((t, l) => t + Math.round(((l.article.price ?? 0) * l.qty) / 1000), 0);
  const step = (a: Article) => (a.unit === 'piece' ? 1000 : 500);

  if (camera) {
    return (
      <CameraOverlay title="Panier" hint="Chaque scan ajoute le produit au panier" onStop={() => setCamera(false)}>
        {flash ? <div className={`flash ${flash.ok ? 'ok' : 'ko'}`}>{flash.text}</div> : null}
        <div className="flash ok">
          {lines.length} produit(s) · {fcfa(total)}
        </div>
      </CameraOverlay>
    );
  }

  return (
    <div className="page">
      <header className="bar">
        {onBack ? (
          <button className="ghost" onClick={onBack} aria-label="Retour">
            ‹
          </button>
        ) : null}
        <div className="grow">
          <b>Panier au rayon</b>
          <small>{s.session?.user.name}</small>
        </div>
        <Status />
        {!onBack ? (
          <button className="ghost" onClick={() => void S.logout()} aria-label="Changer d'utilisateur">
            ⎋
          </button>
        ) : null}
      </header>
      <main>
        <CatalogState />
        {sent !== null ? (
          <div className="notice info">
            Panier n° {sent} envoyé à la caisse. Dites au client : « passez en caisse, panier n° {sent} de {s.session?.user.name} ».
          </div>
        ) : null}
        <button className="scan" onClick={() => setCamera(true)}>
          <span className="scan-icon">▥</span>
          Scanner
          <small>chaque scan ajoute 1</small>
        </button>
        {flash ? <div className={`flash ${flash.ok ? 'ok' : 'ko'}`}>{flash.text}</div> : null}
        <input className="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Nom ou code du produit" enterKeyHint="search" />
        {canMissed && query.trim().length < 2 ? (
          <button className="big" onClick={() => setMissed({ article: null, label: '' })}>
            Le client voulait… (produit absent, en rupture, trop cher)
          </button>
        ) : null}
        {onReceive ? (
          <button className="link" onClick={onReceive}>
            Réceptionner une livraison
          </button>
        ) : null}
        {query.trim().length >= 2 ? (
          <div className="list">
            {results.map((a) => (
              <div key={a.id} className="row item" onClick={() => (add(a, step(a)), setQuery(''))}>
                <div className="grow">
                  {a.name}
                  <small>
                    {a.code}
                    {a.price ? ` · ${fcfa(a.price)}` : ''}
                  </small>
                </div>
                <button className="small-btn" onClick={(e) => (e.stopPropagation(), setInfo(a))} aria-label="Stock ailleurs, livraison, remplaçant">
                  ℹ
                </button>
                <span className="small-btn">+</span>
              </div>
            ))}
            {!results.length ? <div className="empty">Aucun produit trouvé.</div> : null}
            {canMissed ? (
              <button className="link" onClick={() => setMissed({ article: null, label: query.trim() })}>
                Le client voulait « {query.trim()} » : le noter pour le gérant
              </button>
            ) : null}
          </div>
        ) : (
          <>
            <div className="list">
              {lines.map((l) => (
                <div key={l.articleId} className="row item">
                  <div className="grow">
                    {l.article.name}
                    <small>
                      {formatQty(l.qty, l.article)}
                      {l.article.price ? ` · ${fcfa(Math.round((l.article.price * l.qty) / 1000))}` : ''}
                    </small>
                  </div>
                  <button className="small-btn" onClick={() => setInfo(l.article)} aria-label="Stock ailleurs, livraison, remplaçant">
                    ℹ
                  </button>
                  <button className="small-btn" onClick={() => S.setCartQty(l.articleId, l.qty - step(l.article))} aria-label="Moins">
                    −
                  </button>
                  <button className="small-btn" onClick={() => S.setCartQty(l.articleId, l.qty + step(l.article))} aria-label="Plus">
                    +
                  </button>
                </div>
              ))}
              {!lines.length ? <div className="empty">Scannez les produits du client ou cherchez-les par leur nom.</div> : null}
            </div>
            {lines.length ? (
              <div className="card">
                <label className="field">
                  Client (facultatif)
                  <input value={s.cartLabel} onChange={(e) => S.setCartLabel(e.target.value)} placeholder="Nom ou signe pour le reconnaître" />
                </label>
                <div className="row">
                  <b className="grow">Total indicatif</b>
                  <b>{fcfa(total)}</b>
                </div>
                <p className="muted small">La caisse refait le prix (promotions, tarif du client).</p>
                <button
                  className="big primary"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      setSent(await S.sendCart());
                    } catch (e) {
                      show(e instanceof ApiError && e.status === 0 ? 'Pas de connexion au serveur : le panier reste sur le téléphone, réessayez.' : message(e), false);
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  {busy ? 'Envoi…' : 'Envoyer à la caisse'}
                </button>
                <button className="link" onClick={() => S.clearCart()}>
                  Vider le panier
                </button>
              </div>
            ) : null}
            {s.sentCarts.length ? (
              <>
                <h3>Mes paniers du jour</h3>
                <div className="list">
                  {s.sentCarts.map((c) => (
                    <div key={c.id} className="row item">
                      <div className="grow">
                        Panier n° {c.number}
                        {c.label ? ` · ${c.label}` : ''}
                        <small>
                          {heure(c.at)} · {c.lines} ligne(s)
                        </small>
                      </div>
                      <span className={`pill ${c.takenAt ? '' : 'wait'}`}>{c.takenAt ? `En caisse ${heure(c.takenAt)}` : 'En attente'}</span>
                    </div>
                  ))}
                </div>
                <button className="link" onClick={() => void S.loadSentCarts()}>
                  Actualiser
                </button>
              </>
            ) : null}
          </>
        )}
      </main>
      {info ? (
        <InfoSheet
          article={info}
          onClose={() => setInfo(null)}
          onAdd={(a) => (add(a, step(a)), setInfo(null))}
          onMissed={canMissed ? () => (setMissed({ article: info, label: '' }), setInfo(null)) : undefined}
        />
      ) : null}
      {missed ? <MissedSheet article={missed.article} label={missed.label} onClose={(text) => (setMissed(null), setQuery(''), text && show(text, true))} /> : null}
    </div>
  );
}

const day = (iso: string) => iso.slice(0, 10).split('-').reverse().join('/');

/** Ce que le vendeur répond au client : stock dans les autres dépôts et magasins, prochaine livraison, remplaçant. */
function InfoSheet({ article, onClose, onAdd, onMissed }: { article: Article; onClose: () => void; onAdd: (a: Article) => void; onMissed?: () => void }) {
  const s = useStore();
  const [info, setInfo] = useState<S.ProductInfo | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    S.productInfo(article.id).then(setInfo, (e) => setError(message(e)));
  }, [article.id]);
  const sub = info?.substitute ? s.articles.get(info.substitute.id) : undefined;
  return (
    <div className="modal" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet">
        <h2>{article.name}</h2>
        {error ? <div className="notice erreur">{error}</div> : null}
        {!info && !error ? <div className="muted">Recherche…</div> : null}
        {info ? (
          <>
            <h3>Stock</h3>
            <div className="list">
              {info.stock.map((w) => (
                <div key={w.warehouseId} className="row item">
                  <div className="grow">
                    {w.warehouse}
                    <small>{w.here ? 'ce magasin' : w.store}</small>
                  </div>
                  <b className={w.qty > 0 ? '' : 'muted'}>{formatQty(w.qty, article)}</b>
                </div>
              ))}
              {!info.stock.length ? <div className="empty">Aucun stock connu.</div> : null}
            </div>
            <h3>Prochaine livraison</h3>
            <p>{info.nextDelivery ? `${formatQty(info.nextDelivery.qty, article)} attendus le ${day(info.nextDelivery.expectedDate)} (bon ${info.nextDelivery.number})` : 'Aucune commande en cours pour ce produit.'}</p>
            {info.substitute ? (
              <>
                <h3>À la place</h3>
                <div className="row item">
                  <div className="grow">
                    {info.substitute.name}
                    <small>
                      {info.substitute.price ? fcfa(info.substitute.price) : ''} · {sub ? formatQty(info.substitute.stockHere, sub) : info.substitute.stockHere / 1000} en stock ici
                    </small>
                  </div>
                  {sub ? (
                    <button className="small-btn" onClick={() => onAdd(sub)} aria-label="Ajouter le remplaçant au panier">
                      +
                    </button>
                  ) : null}
                </div>
              </>
            ) : null}
          </>
        ) : null}
        {onMissed ? (
          <button className="big" onClick={onMissed}>
            Le client le voulait : le noter
          </button>
        ) : null}
        <button className="link" onClick={onClose}>
          Fermer
        </button>
      </div>
    </div>
  );
}

const MISSED_REASONS: Record<S.MissedReason, string> = { rupture: 'En rupture', absent: 'Pas vendu ici', prix: 'Trop cher pour lui', autre: 'Autre' };

/** « Le client voulait… » : produit demandé qu'on n'a pas pu vendre, pour le gérant et la commande. */
function MissedSheet({ article, label, onClose }: { article: Article | null; label: string; onClose: (done: string | null) => void }) {
  const s = useStore();
  const [picked, setPicked] = useState<Article | null>(article);
  const [text, setText] = useState(label);
  const [qty, setQty] = useState('1');
  const [reason, setReason] = useState<S.MissedReason>(article ? 'rupture' : 'absent');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const results = useMemo(() => (!picked && text.trim().length >= 2 ? search(s.catalog?.articles ?? [], text, 6) : []), [picked, text, s.catalog]);
  const save = async () => {
    setBusy(true);
    setError('');
    try {
      const q = parseNumber(qty);
      await S.recordMissed({ articleId: picked?.id ?? null, label: picked ? null : text.trim(), qty: Math.round((q && q > 0 ? q : 1) * 1000), reason: !picked && reason === 'rupture' ? 'absent' : reason });
      beepOk();
      onClose(`Noté : le client voulait ${picked?.name ?? text.trim()}`);
    } catch (e) {
      setError(e instanceof ApiError && e.status === 0 ? 'Pas de connexion au serveur : réessayez dans un instant.' : message(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="modal" onClick={(e) => e.target === e.currentTarget && onClose(null)}>
      <div className="sheet">
        <h2>Le client voulait…</h2>
        {picked ? (
          <div className="row item">
            <b className="grow">{picked.name}</b>
            <button className="link" onClick={() => setPicked(null)}>
              changer
            </button>
          </div>
        ) : (
          <>
            <input className="search" autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder="Produit demandé (nom, ou ce que dit le client)" />
            <div className="list">
              {results.map((a) => (
                <div key={a.id} className="row item" onClick={() => (setPicked(a), setReason('rupture'))}>
                  <div className="grow">
                    {a.name}
                    <small>{a.code}</small>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
        <label className="field">
          Quantité demandée
          <input inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} />
        </label>
        <div className="tabs">
          {(Object.keys(MISSED_REASONS) as S.MissedReason[])
            .filter((r) => picked || r !== 'rupture')
            .map((r) => (
              <button key={r} className={reason === r ? 'on' : ''} onClick={() => setReason(r)}>
                {MISSED_REASONS[r]}
              </button>
            ))}
        </div>
        {error ? <div className="notice erreur">{error}</div> : null}
        <button className="big primary" disabled={busy || (!picked && text.trim().length < 2)} onClick={() => void save()}>
          {busy ? 'Envoi…' : 'Noter pour le gérant'}
        </button>
        <button className="link" onClick={() => onClose(null)}>
          Annuler
        </button>
      </div>
    </div>
  );
}

// ——— Réception d'une livraison ———

/**
 * Le magasinier compte la livraison devant le camion : il choisit le bon de
 * commande, scanne chaque produit (un scan = un conditionnement), note les
 * abîmés, le lot et la date limite, puis envoie. Un PC du magasin reprend ce
 * comptage, vérifie les prix et valide : le stock n'entre qu'à ce moment.
 */
function Receive({ onBack }: { onBack: () => void }) {
  const s = useStore();
  const [orders, setOrders] = useState<S.ReceptionOrder[] | null>(null);
  const [draft, setDraftState] = useState<S.ReceptionDraft | null>(null);
  const [error, setError] = useState('');
  const [flash, setFlash] = useState<{ text: string; ok: boolean } | null>(null);
  const [camera, setCamera] = useState(false);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [sent, setSent] = useState('');
  const reload = () => S.receptionOrders().then(setOrders, (e) => setError(message(e)));
  useEffect(() => {
    void reload();
    void S.loadReceptionDraft().then(setDraftState);
  }, []);
  const setDraft = (d: S.ReceptionDraft | null) => {
    setDraftState(d);
    void S.saveReceptionDraft(d);
  };
  const order = draft ? orders?.find((o) => o.id === draft.orderId) : undefined;
  const show = (text: string, ok: boolean) => {
    setFlash({ text, ok });
    setTimeout(() => setFlash(null), 2500);
  };
  const bump = (lineId: string, qty: number) => {
    if (!draft) return;
    const cur = draft.lines[lineId] ?? { qty: 0, damaged: 0, lot: '', expiry: '' };
    setDraft({ ...draft, lines: { ...draft.lines, [lineId]: { ...cur, qty: Math.max(0, cur.qty + qty) } } });
  };
  const onCode = (raw: string) => {
    if (!draft || !order) return;
    const hit = lookup(S.getState().index, raw.trim());
    const line = hit ? order.lines.find((l) => l.articleId === hit.article.id) : undefined;
    if (!hit || !line) {
      beepError();
      return show(hit ? `${hit.article.name} n'est pas sur ce bon` : `Code ${raw.trim()} inconnu`, false);
    }
    beepOk();
    bump(line.id, hit.qty);
    show(`${hit.article.name} : +${formatQty(hit.qty, hit.article)}`, true);
  };
  useCamera(camera, onCode, (e) => (setCamera(false), show(message(e), false)));
  const wedge = useRef(onCode);
  wedge.current = onCode;
  useEffect(() => listenWedge((c) => wedge.current(c)), []);

  if (camera)
    return (
      <CameraOverlay title={`Bon ${draft?.orderNumber ?? ''}`} hint="Chaque scan ajoute un conditionnement" onStop={() => setCamera(false)}>
        {flash ? <div className={`flash ${flash.ok ? 'ok' : 'ko'}`}>{flash.text}</div> : null}
      </CameraOverlay>
    );

  const header = (
    <header className="bar">
      <button className="ghost" onClick={onBack} aria-label="Retour">
        ‹
      </button>
      <div className="grow">
        <b>Réception</b>
        <small>{draft ? `Bon ${draft.orderNumber} · ${draft.supplier}` : s.session?.user.name}</small>
      </div>
      <Status />
    </header>
  );

  if (!draft || !order)
    return (
      <div className="page">
        {header}
        <main>
          {sent ? <div className="notice info">{sent}</div> : null}
          {error ? <div className="notice erreur">{error}</div> : null}
          {draft && orders && !order ? <div className="notice erreur">Le bon {draft.orderNumber} n'est plus à réceptionner (déjà reçu ou annulé sur le PC).</div> : null}
          {!orders && !error ? <div className="card muted">Chargement des bons de commande…</div> : null}
          {orders?.map((o) => (
            <button
              key={o.id}
              className="card inventory"
              onClick={() => (setSent(''), setDraft({ orderId: o.id, orderNumber: o.number, supplier: o.supplier, deliveryNote: '', note: '', lines: {} }))}
            >
              <div className="row">
                <b className="grow">N° {o.number}</b>
                {o.waitingOnPc ? <span className="pill wait">déjà envoyé, attend le PC</span> : null}
              </div>
              <div className="muted">
                {o.supplier}
                {o.expectedDate ? ` · attendu le ${day(o.expectedDate)}` : ''} · {o.lines.length} produit(s)
              </div>
            </button>
          ))}
          {orders && !orders.length ? <div className="card muted">Aucun bon de commande à réceptionner. Le bon est créé et envoyé sur le PC (Achats › Bons de commande).</div> : null}
          <button className="link" onClick={() => void reload()}>
            Actualiser
          </button>
        </main>
      </div>
    );

  const rows = order.lines.map((l) => ({ ...l, article: s.articles.get(l.articleId), got: draft.lines[l.id] }));
  const counted = rows.filter((r) => r.got && (r.got.qty > 0 || r.got.damaged > 0)).length;
  const edit = editing ? rows.find((r) => r.id === editing) : undefined;
  return (
    <div className="page">
      {header}
      <main>
        <button className="scan" onClick={() => setCamera(true)}>
          <span className="scan-icon">▥</span>
          Scanner
          <small>un scan = un conditionnement</small>
        </button>
        {flash ? <div className={`flash ${flash.ok ? 'ok' : 'ko'}`}>{flash.text}</div> : null}
        <label className="field">
          N° du bon de livraison du fournisseur
          <input value={draft.deliveryNote} onChange={(e) => setDraft({ ...draft, deliveryNote: e.target.value })} />
        </label>
        <div className="list">
          {rows.map((r) => {
            const got = r.got?.qty ?? 0;
            const a = r.article;
            const f = (q: number) => (a ? formatQty(q, a) : String(q / 1000));
            return (
              <div key={r.id} className="row item" onClick={() => setEditing(r.id)}>
                <div className="grow">
                  {a?.name ?? 'Produit'}
                  <small>
                    attendu {f(r.remaining)} · reçu <b className={got === r.remaining ? '' : got ? 'warn' : ''}>{f(got)}</b>
                    {r.got?.damaged ? ` · ${f(r.got.damaged)} abîmé(s)` : ''}
                  </small>
                </div>
                <button className="small-btn" onClick={(e) => (e.stopPropagation(), bump(r.id, r.remaining - got))} aria-label="Tout reçu">
                  ✓
                </button>
              </div>
            );
          })}
        </div>
        <label className="field">
          Remarque pour le PC (facultatif)
          <input value={draft.note} onChange={(e) => setDraft({ ...draft, note: e.target.value })} placeholder="Carton ouvert, chauffeur pressé…" />
        </label>
        {error ? <div className="notice erreur">{error}</div> : null}
        <button
          className="big primary"
          disabled={busy || !counted}
          onClick={async () => {
            setBusy(true);
            setError('');
            try {
              await S.sendReception(draft, order);
              setSent(`Réception du bon ${draft.orderNumber} envoyée : un PC du magasin la vérifie et la valide.`);
              setDraftState(null);
              void reload();
            } catch (e) {
              setError(e instanceof ApiError && e.status === 0 ? 'Pas de connexion au serveur : le comptage reste sur le téléphone, réessayez.' : message(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? 'Envoi…' : `Envoyer au PC (${counted}/${rows.length})`}
        </button>
        <button className="link" onClick={() => setDraft(null)}>
          Abandonner cette réception
        </button>
      </main>
      {edit ? (
        <ReceiveLine
          name={edit.article?.name ?? 'Produit'}
          unit={edit.article}
          value={edit.got ?? { qty: 0, damaged: 0, lot: '', expiry: '' }}
          onClose={(v) => {
            if (v) setDraft({ ...draft, lines: { ...draft.lines, [edit.id]: v } });
            setEditing(null);
          }}
        />
      ) : null}
    </div>
  );
}

function ReceiveLine({ name, unit, value, onClose }: { name: string; unit?: Article; value: S.ReceptionDraft['lines'][string]; onClose: (v: S.ReceptionDraft['lines'][string] | null) => void }) {
  const [qty, setQty] = useState(String(value.qty / 1000).replace('.', ','));
  const [damaged, setDamaged] = useState(value.damaged ? String(value.damaged / 1000).replace('.', ',') : '');
  const [lot, setLot] = useState(value.lot);
  const [expiry, setExpiry] = useState(value.expiry);
  const unitName = unit?.unitName || (unit?.unit === 'kg' ? 'kg' : unit?.unit === 'litre' ? 'litres' : 'unités');
  return (
    <div className="modal" onClick={(e) => e.target === e.currentTarget && onClose(null)}>
      <div className="sheet">
        <h2>{name}</h2>
        <label className="field">
          Reçu en bon état ({unitName})
          <input inputMode="decimal" autoFocus value={qty} onChange={(e) => setQty(e.target.value)} />
        </label>
        <label className="field">
          Abîmés ou refusés ({unitName})
          <input inputMode="decimal" value={damaged} onChange={(e) => setDamaged(e.target.value)} />
        </label>
        <label className="field">
          N° de lot
          <input value={lot} onChange={(e) => setLot(e.target.value)} />
        </label>
        <label className="field">
          Date limite
          <input type="date" value={expiry} onChange={(e) => setExpiry(e.target.value)} />
        </label>
        <button
          className="big primary"
          onClick={() =>
            onClose({ qty: Math.max(0, Math.round((parseNumber(qty) ?? 0) * 1000)), damaged: Math.max(0, Math.round((parseNumber(damaged) ?? 0) * 1000)), lot: lot.trim(), expiry })
          }
        >
          OK
        </button>
        <button className="link" onClick={() => onClose(null)}>
          Annuler
        </button>
      </div>
    </div>
  );
}

// ——— Comptage ———

type Tab = 'saisies' | 'produits' | 'recompter';

interface Sheet {
  article: Article;
  level: number;
}

/** Catalogue d'un inventaire : celui du magasin, ou pour une fiche ses produits d'abord. */
interface Cat {
  find: (code: string) => Hit | null;
  articles: Map<string, Article>;
  list: Article[];
}

function useCat(inventory: S.ServerInventory): Cat {
  const s = useStore();
  return useMemo(() => {
    if (!S.isFile(inventory)) return { find: (c: string) => lookup(s.index, c), articles: s.articles, list: s.catalog?.articles ?? [] };
    const own = buildIndex(inventory.articles);
    const articles = new Map(s.articles);
    for (const a of inventory.articles) articles.set(a.id, a);
    const ids = new Set(inventory.articles.map((a) => a.id));
    return {
      find: (c: string) => lookup(own, c) ?? lookup(s.index, c),
      articles,
      list: [...inventory.articles, ...(s.catalog?.articles ?? []).filter((a) => !ids.has(a.id))],
    };
  }, [inventory, s.index, s.articles, s.catalog]);
}

/** Bandeau quand le catalogue n'est pas là : les codes ne peuvent pas être reconnus sur le téléphone. */
function CatalogState() {
  const s = useStore();
  const [busy, setBusy] = useState(false);
  if (!s.session || (s.catalog?.articles.length && !s.catalogError)) return null;
  const retry = async () => {
    setBusy(true);
    await S.refreshCatalog(undefined, true).catch(() => undefined);
    setBusy(false);
  };
  return (
    <div className="notice erreur">
      {s.catalog?.articles.length
        ? `Catalogue pas à jour (${s.catalogError}). Les produits récents sont cherchés sur le serveur.`
        : s.catalogError
          ? `Catalogue pas téléchargé : ${s.catalogError}. Les codes sont cherchés sur le serveur tant qu’il répond.`
          : s.catalog
            ? 'Le serveur n’a aucun produit. Sur le PC principal (version 0.57 ou plus), ouvrez Administration › Serveur central et touchez « Renvoyer au serveur ce qui lui manque », puis Réessayer ici.'
            : 'Téléchargement du catalogue…'}{' '}
      <button className="small-btn" disabled={busy} onClick={() => void retry()}>
        {busy ? '…' : 'Réessayer'}
      </button>
    </div>
  );
}

function Count({ inventory, onBack, onRecap }: { inventory: S.ServerInventory; onBack: () => void; onRecap: () => void }) {
  const s = useStore();
  const cat = useCat(inventory);
  const catRef = useRef(cat);
  catRef.current = cat;
  const file = S.isFile(inventory);
  const [camera, setCamera] = useState(false);
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [unknown, setUnknown] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [remote, setRemote] = useState<{ q: string; list: Article[] } | null>(null);
  const [tab, setTab] = useState<Tab>('saisies');
  const [flash, setFlash] = useState<{ text: string; ok: boolean } | null>(null);
  const [menu, setMenu] = useState(false);
  const [newPlace, setNewPlace] = useState(false);
  const seen = useRef<{ code: string; at: number }>({ code: '', at: 0 });
  const flashTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const busy = useRef(false);

  const inList = useMemo(() => new Set(inventory.articleIds), [inventory.articleIds]);
  const show = (text: string, ok: boolean) => {
    setFlash({ text, ok });
    clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlash(null), 2500);
  };

  const accept = (hit: Hit) => {
    beepOk();
    const st = S.getState();
    if (file && !inList.has(hit.article.id)) S.addToFile(inventory.id, hit.article);
    if (st.rapid) {
      const key = placeKey(inventory.id, hit.article.id, st.location);
      const before = st.counts[key];
      const lv = levels(hit.article);
      const step = lv.map((_, i) => (i === hit.level ? 1 : 0));
      const qty = (before?.qty ?? 0) + hit.qty;
      const detail = before ? addDetail(before.detail, lv.length > 1 ? step : null) : lv.length > 1 ? step : null;
      S.record(inventory.id, hit.article.id, qty, detail);
      show(`${hit.article.name} : ${formatQty(qty, hit.article)} (${st.location})`, true);
      return;
    }
    setCamera(false);
    setSheet({ article: hit.article, level: hit.level });
  };

  const onCode = (raw: string, fromCamera: boolean) => {
    const code = raw.trim();
    const now = Date.now();
    // La caméra relit le même code tant qu'il est devant l'objectif : on attend qu'il sorte du champ.
    if (fromCamera && code === seen.current.code && now - seen.current.at < 2000) {
      seen.current.at = now;
      return;
    }
    seen.current = { code, at: now };
    if (sheet || unknown || busy.current) return;
    const hit = catRef.current.find(code);
    if (hit) return accept(hit);
    // Pas sur le téléphone : le serveur a peut-être l'article (catalogue en retard ou pas téléchargé).
    busy.current = true;
    void S.findOnServer(code)
      .catch(() => [] as Article[])
      .then(() => {
        busy.current = false;
        const again = catRef.current.find(code) ?? lookup(S.getState().index, code);
        if (again) return accept(again);
        beepError();
        setCamera(false);
        setUnknown(code);
      });
  };

  useCamera(
    camera,
    (c) => onCode(c, true),
    (e) => {
      setCamera(false);
      show(message(e), false);
    },
  );
  const wedge = useRef(onCode);
  wedge.current = onCode;
  useEffect(() => listenWedge((c) => wedge.current(c, false)), []);

  const counted = useMemo(() => {
    const set = new Set(inventory.counted.map((c) => c.articleId));
    for (const k of Object.keys(s.counts)) if (k.startsWith(`${inventory.id}|`)) set.add(k.split('|')[1]!);
    return set;
  }, [inventory, s.counts]);
  const local = useMemo(() => (query.trim().length >= 2 ? search(cat.list, query, 40) : []), [query, cat.list]);
  // Rien sur le téléphone : on demande au serveur, une fois la frappe terminée.
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2 || local.length || !s.session) return;
    const t = setTimeout(() => {
      void S.findOnServer(q)
        .then((list) => setRemote({ q, list }))
        .catch(() => setRemote({ q, list: [] }));
    }, 400);
    return () => clearTimeout(t);
  }, [query, local.length, s.session]);
  const results = local.length ? local : remote && remote.q === query.trim() ? remote.list : [];
  const historyHere = s.history.filter((h) => h.inventoryId === inventory.id);
  const latestByKey = new Map<string, string>();
  for (const h of historyHere) {
    const k = placeKey(h.inventoryId, h.articleId, h.location);
    if (!latestByKey.has(k)) latestByKey.set(k, h.id);
  }
  const open = (a: Article) => (setSheet({ article: a, level: levels(a).length - 1 }), setQuery(''));

  if (camera) {
    return (
      <CameraOverlay
        title={`${s.location}${s.rapid ? ' · rafale' : ''}`}
        hint={s.rapid ? 'Chaque scan ajoute 1. Éloignez le téléphone entre deux produits identiques.' : 'Visez le code-barres du produit'}
        onStop={() => setCamera(false)}
      >
        {flash ? <div className={`flash ${flash.ok ? 'ok' : 'ko'}`}>{flash.text}</div> : null}
        <label className="toggle on-dark">
          <input type="checkbox" checked={s.rapid} onChange={(e) => S.setRapid(e.target.checked)} /> Rafale (+1 par scan)
        </label>
      </CameraOverlay>
    );
  }

  return (
    <div className="page">
      <header className="bar">
        <button className="ghost" onClick={onBack} aria-label="Retour">
          ‹
        </button>
        <div className="grow">
          <b>{file ? inventory.number : `N° ${inventory.number}`}</b>
          <small>
            {counted.size} / {inventory.articleIds.length} comptés{s.session && !file ? ` · ${s.session.user.name}` : ''}
          </small>
        </div>
        {!file && s.session ? <Status /> : null}
        <button className="ghost" onClick={() => setMenu(true)} aria-label="Menu">
          ☰
        </button>
      </header>
      <main>
        {!file ? <CatalogState /> : null}
        <div className="places">
          {s.locations.map((l) => (
            <button key={l} className={`chip ${l === s.location ? 'on' : ''}`} onClick={() => S.setLocation(l)}>
              {l}
            </button>
          ))}
          <button className="chip add" onClick={() => setNewPlace(true)}>
            + Endroit
          </button>
        </div>
        <button className="scan" onClick={() => setCamera(true)}>
          <span className="scan-icon">▥</span>
          Scanner
          <small>
            {s.location}
            {s.rapid ? ' · rafale' : ''}
          </small>
        </button>
        <label className="toggle">
          <input type="checkbox" checked={s.rapid} onChange={(e) => S.setRapid(e.target.checked)} /> Rafale : chaque scan ajoute 1, sans taper la quantité
        </label>
        {flash ? <div className={`flash ${flash.ok ? 'ok' : 'ko'}`}>{flash.text}</div> : null}
        <input
          className="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && query.trim()) {
              if (cat.find(query)) {
                onCode(query, false);
                setQuery('');
              } else if (results.length === 1) open(results[0]!);
            }
          }}
          placeholder="Nom ou code du produit"
          enterKeyHint="search"
        />
        {query.trim().length >= 2 ? (
          <div className="list">
            {results.map((a) => (
              <ArticleRow key={a.id} article={a} inventory={inventory} onClick={() => open(a)} />
            ))}
            {!results.length ? (
              <div className="empty">
                {!local.length && s.session && (!remote || remote.q !== query.trim()) ? 'Recherche sur le serveur…' : 'Aucun produit trouvé.'}{' '}
                <button className="link" onClick={() => (setUnknown(query.trim()), setQuery(''))}>
                  {file ? 'Ajouter un produit à la fiche' : 'Signaler un produit inconnu'}
                </button>
              </div>
            ) : null}
          </div>
        ) : (
          <>
            <div className="tabs">
              <button className={tab === 'saisies' ? 'on' : ''} onClick={() => setTab('saisies')}>
                Mes saisies
              </button>
              <button className={tab === 'produits' ? 'on' : ''} onClick={() => setTab('produits')}>
                Produits
              </button>
              {!file ? (
                <button className={tab === 'recompter' ? 'on' : ''} onClick={() => setTab('recompter')}>
                  À recompter{inventory.recount.length ? ` (${inventory.recount.length})` : ''}
                </button>
              ) : null}
            </div>
            {tab === 'saisies' ? (
              <div className="list">
                {historyHere.slice(0, 60).map((h) => {
                  const a = cat.articles.get(h.articleId);
                  if (!a) return null;
                  const last = latestByKey.get(placeKey(h.inventoryId, h.articleId, h.location)) === h.id;
                  return (
                    <div key={h.id} className={`row item ${h.undone ? 'undone' : ''}`}>
                      <div className="grow" onClick={() => setSheet({ article: a, level: levels(a).length - 1 })}>
                        {a.name}
                        <small>
                          {h.location} · {heure(h.at)} · {h.before ? `${formatQty(h.before.qty, a)} → ` : ''}
                          {h.after ? formatQty(h.after.qty, a) : 'effacé'}
                        </small>
                      </div>
                      {last && !h.undone ? (
                        <button className="small-btn" onClick={() => S.undo(h)}>
                          Annuler
                        </button>
                      ) : null}
                    </div>
                  );
                })}
                {!historyHere.length ? (
                  <div className="empty">
                    {file
                      ? 'Scannez un produit ou ouvrez l’onglet Produits pour toucher celui que vous comptez. Exportez la fiche remplie depuis le menu ☰.'
                      : 'Scannez un produit pour commencer. Les quantités partent toutes seules au serveur, même après une coupure.'}
                  </div>
                ) : null}
              </div>
            ) : tab === 'produits' ? (
              <Products inventory={inventory} cat={cat} counted={counted} onOpen={(a) => setSheet({ article: a, level: levels(a).length - 1 })} />
            ) : (
              <div className="list">
                <p className="muted small">
                  Un collègue a trouvé un gros écart sur ces produits. Recomptez-les à l’endroit où ils sont rangés : votre saisie remplace la sienne pour cet endroit.
                </p>
                {inventory.recount
                  .map((id) => cat.articles.get(id))
                  .filter((a): a is Article => Boolean(a))
                  .map((a) => (
                    <ArticleRow key={a.id} article={a} inventory={inventory} onClick={() => setSheet({ article: a, level: levels(a).length - 1 })} />
                  ))}
                {!inventory.recount.length ? <div className="empty">Rien à recompter pour le moment.</div> : null}
              </div>
            )}
          </>
        )}
      </main>
      {sheet ? (
        <ProductSheet
          article={sheet.article}
          level={sheet.level}
          inventory={inventory}
          outside={!inList.has(sheet.article.id)}
          onClose={(saved) => {
            setSheet(null);
            if (saved) show(saved, true);
          }}
        />
      ) : null}
      {unknown !== null ? (
        <Unknown
          code={unknown}
          inventory={inventory}
          onClose={(saved) => (setUnknown(null), saved && show(file ? 'Produit ajouté à la fiche' : 'Produit inconnu signalé au gérant', true))}
        />
      ) : null}
      {newPlace ? <NewPlace onClose={() => setNewPlace(false)} /> : null}
      {menu ? <InventoryMenu inventory={inventory} onRecap={onRecap} onBack={onBack} onClose={() => setMenu(false)} /> : null}
    </div>
  );
}

function ArticleRow({ article, inventory, onClick }: { article: Article; inventory: S.ServerInventory; onClick: () => void }) {
  const s = useStore();
  const mine = phoneTotal(s.counts, inventory.id, article.id);
  const server = inventory.counted.find((c) => c.articleId === article.id);
  return (
    <div className="row item" onClick={onClick}>
      {article.thumb ? <img className="thumb" src={article.thumb} alt="" /> : null}
      <div className="grow">
        {article.name}
        <small>
          {article.code}
          {mine.places.length ? ` · vous : ${formatQty(mine.total, article)}` : server ? ` · compté : ${formatQty(server.qty, article)}${server.by ? ` (${server.by})` : ''}` : ''}
        </small>
      </div>
      {mine.places.length || server ? <span className="pill ok">✓</span> : <span className="chev">›</span>}
    </div>
  );
}

/** Tous les produits de l'inventaire, à toucher pour les compter, avec le filtre Comptés / Pas comptés. */
function Products({ inventory, cat, counted, onOpen }: { inventory: S.ServerInventory; cat: Cat; counted: Set<string>; onOpen: (a: Article) => void }) {
  const s = useStore();
  const [dept, setDept] = useState<string>(inventory.assigned.length ? 'mine' : 'all');
  const [which, setWhich] = useState<'left' | 'done' | 'all'>('left');
  const [limit, setLimit] = useState(80);
  const departments = s.catalog?.departments ?? [];
  const all = useMemo(
    () =>
      inventory.articleIds
        .map((id) => cat.articles.get(id))
        .filter((a): a is Article => Boolean(a))
        .sort((a, b) => a.name.localeCompare(b.name, 'fr')),
    [inventory.articleIds, cat.articles],
  );
  const usedDepts = useMemo(() => {
    const ids = new Set(all.map((a) => a.departmentId).filter(Boolean));
    return departments.filter((d) => ids.has(d.id));
  }, [all, departments]);
  const inDept = all.filter((a) => (dept === 'all' ? true : dept === 'mine' ? inventory.assigned.includes(a.departmentId ?? '') : a.departmentId === dept));
  const doneHere = inDept.filter((a) => counted.has(a.id)).length;
  const shown = inDept.filter((a) => (which === 'all' ? true : which === 'done' ? counted.has(a.id) : !counted.has(a.id)));
  const missing = inventory.articleIds.length - all.length;
  return (
    <div className="list">
      <div className="segmented">
        <button className={which === 'left' ? 'on' : ''} onClick={() => (setWhich('left'), setLimit(80))}>
          À compter ({inDept.length - doneHere})
        </button>
        <button className={which === 'done' ? 'on' : ''} onClick={() => (setWhich('done'), setLimit(80))}>
          Comptés ({doneHere})
        </button>
        <button className={which === 'all' ? 'on' : ''} onClick={() => (setWhich('all'), setLimit(80))}>
          Tous
        </button>
      </div>
      {usedDepts.length || inventory.assigned.length ? (
        <select className="select" value={dept} onChange={(e) => (setDept(e.target.value), setLimit(80))}>
          {inventory.assigned.length ? <option value="mine">Mes rayons</option> : null}
          <option value="all">Tous les rayons</option>
          {usedDepts.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
      ) : null}
      <div className="gauge">
        <div style={{ width: `${inDept.length ? Math.round((doneHere / inDept.length) * 100) : 0}%` }} />
      </div>
      <p className="muted small">
        {doneHere} / {inDept.length} comptés
        {missing > 0 ? ` · ${missing} produit(s) pas encore dans le catalogue du téléphone` : ''}
      </p>
      {shown.slice(0, limit).map((a) => (
        <ArticleRow key={a.id} article={a} inventory={inventory} onClick={() => onOpen(a)} />
      ))}
      {shown.length > limit ? (
        <button className="big" onClick={() => setLimit(limit + 200)}>
          Afficher plus
        </button>
      ) : null}
      {!shown.length ? <div className="empty">{which === 'left' ? 'Tout est compté ici.' : 'Rien ici pour le moment.'}</div> : null}
    </div>
  );
}

function ProductSheet({
  article,
  level,
  inventory,
  outside,
  onClose,
}: {
  article: Article;
  level: number;
  inventory: S.ServerInventory;
  outside: boolean;
  onClose: (saved?: string) => void;
}) {
  const s = useStore();
  const lv = levels(article);
  const key = placeKey(inventory.id, article.id, s.location);
  const here = s.counts[key];
  const [parts, setParts] = useState<string[]>(() => lv.map(() => ''));
  const [mode, setMode] = useState<'add' | 'set'>(here ? 'add' : 'set');
  const [error, setError] = useState('');
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const t = setTimeout(() => first.current?.focus(), 150);
    return () => clearTimeout(t);
  }, []);
  const entered = partsToQty(lv, parts);
  const all = phoneTotal(s.counts, inventory.id, article.id);
  const server = inventory.counted.find((c) => c.articleId === article.id);
  const expected = s.showExpected ? inventory.expected?.[article.id] : undefined;
  const newHere = entered === null ? null : mode === 'add' && here ? here.qty + entered : entered;
  const deptName = s.catalog?.departments.find((d) => d.id === article.departmentId)?.name;
  const [thumb, setThumb] = useState<string | null>(article.thumb);
  useEffect(() => {
    let live = true;
    if (!article.thumb) void S.thumbOf(article.id).then((t) => live && setThumb(t));
    return () => {
      live = false;
    };
  }, [article]);
  const bump = (i: number, delta: number) =>
    setParts((p) =>
      p.map((v, j) => {
        if (j !== i) return v;
        const n = Math.max(0, (Number(v.replace(',', '.')) || 0) + delta);
        return String(n).replace('.', ',');
      }),
    );
  const save = () => {
    if (entered === null || newHere === null) return setError('Quantité invalide');
    if (!parts.some((p) => p.trim())) return setError('Saisissez la quantité comptée');
    const detail = partsToDetail(lv, parts);
    if (outside && S.isFile(inventory)) S.addToFile(inventory.id, article);
    S.record(inventory.id, article.id, newHere, mode === 'add' && here ? addDetail(here.detail, detail) : detail);
    onClose(`${article.name} : ${formatQty(newHere, article)} (${s.location})`);
  };
  return (
    <div className="modal" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet">
        <div className="row">
          {thumb ? <img className="thumb big-thumb" src={thumb} alt="" /> : null}
          <div className="grow">
            <h2>{article.name}</h2>
            <div className="muted small">
              {article.code}
              {deptName ? ` · ${deptName}` : ''}
            </div>
          </div>
        </div>
        {outside ? <div className="notice info">Ce produit n’est pas dans la liste de {S.isFile(inventory) ? 'cette fiche' : 'cet inventaire'} : il y sera ajouté.</div> : null}
        <div className="facts">
          <div>
            <small>Ici ({s.location})</small>
            {here ? formatQty(here.qty, article) : '—'}
          </div>
          <div>
            <small>Vous, partout</small>
            {all.places.length ? formatQty(all.total, article) : '—'}
          </div>
          {server ? (
            <div>
              <small>Compté{server.by ? ` (${server.by})` : ''}</small>
              {formatQty(server.qty, article)}
            </div>
          ) : null}
          {expected !== undefined ? (
            <div>
              <small>Stock attendu</small>
              {formatQty(expected, article)}
            </div>
          ) : null}
        </div>
        {here ? (
          <div className="segmented">
            <button className={mode === 'add' ? 'on' : ''} onClick={() => setMode('add')}>
              Ajouter
            </button>
            <button className={mode === 'set' ? 'on' : ''} onClick={() => setMode('set')}>
              Remplacer
            </button>
          </div>
        ) : null}
        {lv.map((l, i) => (
          <div key={l.name + i} className="qty-row">
            <label className="grow">
              {l.name}
              {i < lv.length - 1 ? <small> de {l.units / 1000}</small> : null}
            </label>
            <button className="step" onClick={() => bump(i, -1)}>
              −
            </button>
            <input
              ref={i === level ? first : undefined}
              value={parts[i]}
              onChange={(e) => setParts((p) => p.map((v, j) => (j === i ? e.target.value : v)))}
              onKeyDown={(e) => e.key === 'Enter' && save()}
              inputMode="decimal"
              enterKeyHint="done"
              placeholder="0"
            />
            <button className="step" onClick={() => bump(i, 1)}>
              +
            </button>
          </div>
        ))}
        <div className="total">
          {newHere === null ? 'Quantité invalide' : `${s.location} : ${formatQty(newHere, article)}`}
          {mode === 'add' && here && entered ? (
            <small>
              {' '}
              ({formatQty(here.qty, article)} + {formatQty(entered, article)})
            </small>
          ) : null}
        </div>
        {error ? <div className="notice erreur">{error}</div> : null}
        <button className="big primary" onClick={save}>
          Valider
        </button>
        <div className="row">
          {here ? (
            <button
              className="link danger"
              onClick={() => {
                S.record(inventory.id, article.id, null, null);
                onClose(`${article.name} : comptage effacé (${s.location})`);
              }}
            >
              Effacer cet endroit
            </button>
          ) : null}
          <span className="grow" />
          <button className="link" onClick={() => onClose()}>
            Fermer
          </button>
        </div>
      </div>
    </div>
  );
}

function Unknown({ code, inventory, onClose }: { code: string; inventory: S.ServerInventory; onClose: (saved: boolean) => void }) {
  const file = S.isFile(inventory);
  const [note, setNote] = useState('');
  const [qty, setQty] = useState('');
  const [photo, setPhoto] = useState<string | null>(null);
  const [error, setError] = useState('');
  const send = () => {
    const n = qty.trim() ? Number(qty.replace(',', '.')) : null;
    if (n !== null && !(n >= 0)) return setError('Quantité invalide');
    if (file) {
      // Fiche sans serveur : le produit est ajouté à la fiche, avec sa quantité.
      if (!note.trim()) return setError('Notez le nom du produit');
      const id = code || `sans-code-${Date.now().toString(36)}`;
      const article: Article = { id: `f:${id}`, code: id, name: note.trim(), unit: 'piece', unitName: null, otherRef: null, departmentId: null, barcodes: [], packs: [], thumb: null };
      S.addToFile(inventory.id, article, { code: id, name: note.trim(), pack: null, department: null, qty: null });
      if (n !== null) S.record(inventory.id, article.id, Math.round(n * 1000), null);
      return onClose(true);
    }
    if (!note.trim() && !photo && !code) return setError('Notez le nom ou prenez une photo');
    S.addUnknown({ inventoryId: inventory.id, code, note: note.trim(), qty: n === null ? null : Math.round(n * 1000), photo });
    onClose(true);
  };
  return (
    <div className="modal" onClick={(e) => e.target === e.currentTarget && onClose(false)}>
      <div className="sheet">
        <h2>{file ? 'Produit absent de la fiche' : 'Produit inconnu'}</h2>
        <p className="muted">
          {code ? `Le code ${code} n’est ni dans ${file ? 'la fiche' : 'le catalogue du téléphone'} ni sur le serveur.` : 'Produit sans code.'}{' '}
          {file ? 'Notez son nom et sa quantité : il sera ajouté à la fiche.' : 'Prenez-le en photo et notez son nom : le gérant créera l’article, puis vous le compterez.'}
        </p>
        <label className="field">
          Nom lu sur l’emballage
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Ex. : Biscuits Choco 200 g" />
        </label>
        <label className="field">
          Quantité trouvée
          <input value={qty} onChange={(e) => setQty(e.target.value)} inputMode="decimal" placeholder="0" />
        </label>
        {!file ? (
          <label className="photo-btn">
            {photo ? <img src={photo} alt="" /> : <span>Prendre une photo</span>}
            <input
              type="file"
              accept="image/*"
              capture="environment"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (f) setPhoto(await shrinkPhoto(f).catch(() => null));
              }}
            />
          </label>
        ) : null}
        {error ? <div className="notice erreur">{error}</div> : null}
        <button className="big primary" onClick={send}>
          {file ? 'Ajouter à la fiche' : 'Envoyer au gérant'}
        </button>
        <button className="link" onClick={() => onClose(false)}>
          Annuler
        </button>
      </div>
    </div>
  );
}

/** Menu d'un inventaire : récapitulatif, remise à 0, et pour une fiche l'export, le nom, la clôture. */
function InventoryMenu({ inventory, onRecap, onBack, onClose }: { inventory: S.ServerInventory; onRecap: () => void; onBack: () => void; onClose: () => void }) {
  const s = useStore();
  const file = S.isFile(inventory) ? inventory : null;
  const [settings, setSettings] = useState(false);
  const [info, setInfo] = useState('');
  const [name, setName] = useState(file?.number ?? '');
  const mineHere = Object.keys(s.counts).filter((k) => k.startsWith(`${inventory.id}|`));
  const atPlace = mineHere.filter((k) => k.endsWith(`|${s.location}`)).length;
  const reset = (location: string | null) => {
    const what = location ? `vos ${atPlace} comptage(s) de l’endroit « ${location} »` : `vos ${mineHere.length} comptage(s) de tout l’inventaire`;
    if (!confirm(`Remettre à 0 ${what} ? Les quantités seront effacées${file ? '' : ' aussi sur le serveur'}.`)) return;
    setInfo(`${S.resetCounts(inventory.id, location)} comptage(s) remis à 0.`);
  };
  if (settings) return <Settings onClose={onClose} />;
  return (
    <div className="modal" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet">
        <h2>{file ? file.number : `Inventaire N° ${inventory.number}`}</h2>
        {info ? <div className="notice info">{info}</div> : null}
        <button className="big primary" onClick={() => (onClose(), onRecap())}>
          {file ? 'Récapitulatif et export de la fiche' : 'Mon récapitulatif (à partager)'}
        </button>
        <button className="big" disabled={!atPlace} onClick={() => reset(s.location)}>
          Remettre à 0 l’endroit « {s.location} »
        </button>
        <button className="big" disabled={!mineHere.length} onClick={() => reset(null)}>
          Remettre à 0 tout l’inventaire
        </button>
        {file ? (
          <>
            <label className="field">
              Nom de la fiche
              <div className="row">
                <input className="grow" value={name} onChange={(e) => setName(e.target.value)} maxLength={40} />
                <button className="small-btn" disabled={!name.trim() || name.trim() === file.number} onClick={() => (S.updateFile(file.id, { number: name.trim() }), setInfo('Fiche renommée.'))}>
                  Renommer
                </button>
              </div>
            </label>
            <button
              className="big"
              onClick={() => {
                if (!confirm('Clôturer cette fiche ? Elle passe dans « Clôturés » : elle reste exportable, et vous pourrez la rouvrir.')) return;
                S.updateFile(file.id, { closed: true });
                onClose();
                onBack();
              }}
            >
              Clôturer la fiche
            </button>
            <button
              className="link danger"
              onClick={() => {
                if (!confirm('Supprimer cette fiche et tous ses comptages du téléphone ?')) return;
                S.deleteFile(file.id);
                onClose();
                onBack();
              }}
            >
              Supprimer la fiche
            </button>
          </>
        ) : null}
        {s.config ? (
          <button className="link" onClick={() => setSettings(true)}>
            Réglages du téléphone
          </button>
        ) : null}
        <button className="link" onClick={onClose}>
          Fermer
        </button>
      </div>
    </div>
  );
}

/** Ce que j'ai compté, par endroit, avec le partage du fichier (et pour une fiche, l'export pour le PC). */
function Recap({ inventory, counts, closed, onClose }: { inventory: S.ServerInventory; counts: Record<string, PlaceCount>; closed: boolean; onClose: () => void }) {
  const s = useStore();
  const cat = useCat(inventory);
  const file = S.isFile(inventory) ? inventory : null;
  const [error, setError] = useState('');
  const prefix = `${inventory.id}|`;
  const rows = Object.entries(counts)
    .filter(([k]) => k.startsWith(prefix))
    .map(([k, v]) => {
      const [, articleId, ...rest] = k.split('|');
      const article = cat.articles.get(articleId!);
      return article ? { location: rest.join('|'), article, qty: v.qty } : null;
    })
    .filter((r): r is { location: string; article: Article; qty: number } => Boolean(r));
  const places = [...new Set(rows.map((r) => r.location))].sort((a, b) => a.localeCompare(b, 'fr'));
  const totals = new Map<string, number>();
  for (const r of rows) totals.set(r.article.id, (totals.get(r.article.id) ?? 0) + r.qty);
  const who = s.session?.user.name ?? s.config?.deviceName ?? 'telephone';
  const safe = (v: string) => v.normalize('NFD').replace(/[^\w.-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  const run = async (fn: () => Promise<void>) => {
    setError('');
    try {
      await fn();
    } catch (e) {
      setError(message(e));
    }
  };
  const shareRecap = () =>
    run(() => shareFile(`recapitulatif-${safe(inventory.number)}-${safe(who)}.csv`, recapCsv(rows), `Récapitulatif de l’inventaire ${inventory.number} (${who})`));
  const exportFile = () =>
    run(async () => {
      if (!file) return;
      const ext = file.format === 'txt' ? 'txt' : 'csv';
      await shareFile(`${safe(file.number)}-rempli.${ext}`, exportCountFile(file.format, file.articles, totals, (a) => file.lines[a.id]), `Fiche remplie ${file.number}`);
    });
  return (
    <div className="page">
      <header className="bar">
        <button className="ghost" onClick={onClose} aria-label="Retour">
          ‹
        </button>
        <div className="grow">
          <b>Récapitulatif · {file ? file.number : `N° ${inventory.number}`}</b>
          <small>
            {totals.size} produit(s) compté(s) · {places.length} endroit(s){closed ? ' · clôturé' : ''}
          </small>
        </div>
      </header>
      <main>
        {error ? <div className="notice erreur">{error}</div> : null}
        {file ? (
          <>
            <button className="big primary" onClick={() => void exportFile()}>
              Exporter la fiche remplie pour le PC
            </button>
            <p className="muted small">
              Envoyez-la par WhatsApp ou e-mail, puis sur le PC : Inventaires › ouvrir l’inventaire › Importer. Le total de chaque produit (tous endroits) remplit la colonne
              Compté.
            </p>
          </>
        ) : null}
        <button className={`big ${file ? '' : 'primary'}`} disabled={!rows.length} onClick={() => void shareRecap()}>
          Partager mon récapitulatif
        </button>
        {file && closed ? (
          <button className="big" onClick={() => (S.updateFile(file.id, { closed: false }), onClose())}>
            Rouvrir la fiche
          </button>
        ) : null}
        {places.map((place) => (
          <div key={place} className="list">
            <h2>{place}</h2>
            {rows
              .filter((r) => r.location === place)
              .sort((a, b) => a.article.name.localeCompare(b.article.name, 'fr'))
              .map((r) => (
                <div key={r.article.id} className="row item">
                  <div className="grow">
                    {r.article.name}
                    <small>{r.article.code}</small>
                  </div>
                  <b>{formatQty(r.qty, r.article)}</b>
                </div>
              ))}
          </div>
        ))}
        {!rows.length ? <div className="empty">Rien compté sur ce téléphone pour cet inventaire.</div> : null}
      </main>
    </div>
  );
}

function NewPlace({ onClose }: { onClose: () => void }) {
  const s = useStore();
  const [name, setName] = useState('');
  return (
    <div className="modal" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <form
        className="sheet"
        onSubmit={(e) => {
          e.preventDefault();
          S.setLocation(name);
          onClose();
        }}
      >
        <h2>Endroit compté</h2>
        <p className="muted">Les quantités d’un même produit à plusieurs endroits (rayon, réserve, vitrine…) s’additionnent.</p>
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex. : Vitrine, Allée 3" maxLength={40} />
        <button className="big primary" disabled={!name.trim()}>
          Ajouter
        </button>
        <div className="places">
          {s.locations
            .filter((l) => !['Rayon', 'Réserve', 'Chambre froide'].includes(l))
            .map((l) => (
              <button type="button" key={l} className="chip" onClick={() => S.removeLocation(l)}>
                {l} ×
              </button>
            ))}
        </div>
      </form>
    </div>
  );
}

function Settings({ onClose }: { onClose: () => void }) {
  const s = useStore();
  const [address, setAddress] = useState(s.config?.url ?? '');
  const [busy, setBusy] = useState('');
  const [info, setInfo] = useState('');
  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setInfo('');
    try {
      await fn();
      setInfo('C’est fait.');
    } catch (e) {
      setInfo(message(e));
    } finally {
      setBusy('');
    }
  };
  return (
    <div className="modal" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet">
        <h2>Réglages</h2>
        <div className="muted small">
          {s.config?.deviceName} · {s.config?.storeName}
          <br />
          {s.catalog ? `${s.catalog.articles.length} articles en mémoire` : 'Catalogue pas encore téléchargé'} · {s.pending} saisie(s) à envoyer
          {s.lastSync ? ` · dernier échange à ${heure(s.lastSync)}` : ''}
        </div>
        {info ? <div className="notice info">{info}</div> : null}
        {s.session ? (
          <>
            <button className="big" disabled={Boolean(busy)} onClick={() => run('sync', () => S.sync())}>
              {busy === 'sync' ? 'Envoi…' : 'Envoyer et actualiser maintenant'}
            </button>
            <button className="big" disabled={Boolean(busy)} onClick={() => run('cat', () => S.refreshCatalog())}>
              {busy === 'cat' ? 'Téléchargement…' : 'Actualiser le catalogue'}
            </button>
            <button
              className="big"
              disabled={Boolean(busy)}
              onClick={() =>
                run('out', async () => {
                  await S.logout();
                  onClose();
                })
              }
            >
              Changer d’utilisateur
            </button>
          </>
        ) : null}
        <label className="field">
          Adresse du serveur
          <div className="row">
            <input className="grow" value={address} onChange={(e) => setAddress(e.target.value)} inputMode="url" autoCapitalize="off" />
            <button
              className="small-btn"
              disabled={Boolean(busy)}
              onClick={() =>
                run('addr', async () => {
                  const url = normalizeUrl(address);
                  if (!url) throw new Error('Adresse invalide');
                  await S.setServerAddress(url);
                })
              }
            >
              Essayer
            </button>
          </div>
        </label>
        <button
          className="link danger"
          onClick={() => {
            const warn = s.pending ? `${s.pending} saisie(s) ne sont pas encore envoyées et seront perdues. ` : '';
            if (confirm(`${warn}Délier ce téléphone du magasin ?`)) void S.unpair().then(onClose);
          }}
        >
          Délier ce téléphone
        </button>
        <p className="muted small">FEDONIX 360 Inventaire {VERSION}</p>
        <button className="link" onClick={onClose}>
          Fermer
        </button>
      </div>
    </div>
  );
}
