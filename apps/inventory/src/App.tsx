import { type ReactNode, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { ApiError } from './api';
import { beepError, beepOk, listenWedge, native, shrinkPhoto, startCamera, toggleTorch } from './device';
import { type Article, addDetail, formatQty, levels, lookup, normalizeUrl, parsePairing, partsToDetail, partsToQty, phoneTotal, placeKey, search } from './logic';
import * as S from './state';

const VERSION = __APP_VERSION__;

const useStore = () => useSyncExternalStore(S.subscribe, S.getState);
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const heure = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : '');

export function App() {
  const s = useStore();
  const [inventoryId, setInventoryId] = useState<string | null>(() => sessionStorage.getItem('inventaire') || null);
  const choose = (id: string | null) => {
    setInventoryId(id);
    try {
      if (id) sessionStorage.setItem('inventaire', id);
      else sessionStorage.removeItem('inventaire');
    } catch {
      /* rien */
    }
  };
  if (!s.ready) return <div className="splash">FEDONIX 360 Inventaire</div>;
  const inventory = s.inventories.find((i) => i.id === inventoryId) ?? null;
  return (
    <div className="app">
      <Notices />
      {!s.config ? <Pairing /> : !s.session ? <Login /> : inventory ? <Count inventory={inventory} onBack={() => choose(null)} /> : <Inventories onChoose={choose} />}
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

function Pairing() {
  const [camera, setCamera] = useState(false);
  const [manual, setManual] = useState(!native);
  const [address, setAddress] = useState('');
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const go = async (urls: string[], pairingCode: string) => {
    setBusy(true);
    setError('');
    try {
      await S.pair(urls, pairingCode, name.trim() || 'Téléphone d’inventaire');
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
      void go(p.urls, p.code);
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
      <p className="muted">Reliez ce téléphone au magasin. Le gérant ouvre FEDONIX 360 Gérant › Inventaire et affiche le QR code.</p>
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
            Code affiché sous le QR
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
      <p className="muted small">Version {VERSION}</p>
    </div>
  );
}

// ——— Connexion du compteur ———

function Login() {
  const s = useStore();
  const [login, setLogin] = useState(() => localStorage.getItem('dernier-identifiant') ?? '');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [menu, setMenu] = useState(false);
  return (
    <div className="page center">
      <img className="logo" src="./icon.png" alt="" />
      <h1>{s.config!.storeName}</h1>
      <p className="muted">Connectez-vous avec votre identifiant et votre code de FEDONIX 360.</p>
      <form
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
      {s.pending ? <p className="muted">{s.pending} saisie(s) attendent d’être envoyées.</p> : null}
      <button className="link" onClick={() => setMenu(true)}>
        Réglages du téléphone
      </button>
      {menu ? <Settings onClose={() => setMenu(false)} /> : null}
    </div>
  );
}

// ——— Choix de l'inventaire ———

function Inventories({ onChoose }: { onChoose: (id: string) => void }) {
  const s = useStore();
  const [menu, setMenu] = useState(false);
  return (
    <div className="page">
      <header className="bar">
        <div className="grow">
          <b>{s.config!.storeName}</b>
          <small>{s.session!.user.name}</small>
        </div>
        <Status />
        <button className="ghost" onClick={() => setMenu(true)} aria-label="Menu">
          ☰
        </button>
      </header>
      <main>
        <h2>Inventaires en cours</h2>
        {!s.catalog ? <div className="card muted">Téléchargement du catalogue…</div> : null}
        {s.inventories.map((inv) => {
          const counted = new Set(inv.counted.map((c) => c.articleId));
          for (const k of Object.keys(s.counts)) if (k.startsWith(`${inv.id}|`)) counted.add(k.split('|')[1]!);
          const pct = inv.articleIds.length ? Math.round((counted.size / inv.articleIds.length) * 100) : 0;
          return (
            <button key={inv.id} className="card inventory" onClick={() => onChoose(inv.id)}>
              <div className="row">
                <b className="grow">
                  N° {inv.number}
                  {inv.label ? ` · ${inv.label}` : ''}
                </b>
                <span className="pill">{inv.kind === 'global' ? 'Global' : 'Partiel'}</span>
              </div>
              <div className="muted">
                {inv.warehouseName} · date {inv.inventoryDate.split('-').reverse().join('/')}
              </div>
              <div className="gauge">
                <div style={{ width: `${pct}%` }} />
              </div>
              <div className="muted small">
                {counted.size} / {inv.articleIds.length} produits comptés
                {inv.assigned.length ? ` · ${inv.assigned.length} rayon(s) pour vous` : ''}
                {inv.recount.length ? ` · ${inv.recount.length} à recompter` : ''}
              </div>
            </button>
          );
        })}
        {!s.inventories.length ? (
          <div className="card muted">
            Aucun inventaire ouvert dans ce magasin. Le gérant le crée sur un PC (Stock › Inventaires), puis il apparaît ici.
            <button className="big" onClick={() => void S.sync()}>
              Actualiser
            </button>
          </div>
        ) : null}
      </main>
      {menu ? <Settings onClose={() => setMenu(false)} /> : null}
    </div>
  );
}

// ——— Comptage ———

type Tab = 'saisies' | 'reste' | 'recompter';

interface Sheet {
  article: Article;
  level: number;
}

function Count({ inventory, onBack }: { inventory: S.ServerInventory; onBack: () => void }) {
  const s = useStore();
  const [camera, setCamera] = useState(false);
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [unknown, setUnknown] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [tab, setTab] = useState<Tab>('saisies');
  const [flash, setFlash] = useState<{ text: string; ok: boolean } | null>(null);
  const [menu, setMenu] = useState(false);
  const [newPlace, setNewPlace] = useState(false);
  const seen = useRef<{ code: string; at: number }>({ code: '', at: 0 });
  const flashTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const inList = useMemo(() => new Set(inventory.articleIds), [inventory.articleIds]);
  const show = (text: string, ok: boolean) => {
    setFlash({ text, ok });
    clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlash(null), 2500);
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
    if (sheet || unknown) return;
    // État du moment (pas celui du dernier affichage) : deux scans rapprochés s'additionnent bien.
    const st = S.getState();
    const hit = lookup(st.index, code);
    if (!hit) {
      beepError();
      setCamera(false);
      setUnknown(code);
      return;
    }
    beepOk();
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
  const results = useMemo(() => (query.trim().length >= 2 ? search(s.catalog?.articles ?? [], query, 40) : []), [query, s.catalog]);
  const historyHere = s.history.filter((h) => h.inventoryId === inventory.id);
  const latestByKey = new Map<string, string>();
  for (const h of historyHere) {
    const k = placeKey(h.inventoryId, h.articleId, h.location);
    if (!latestByKey.has(k)) latestByKey.set(k, h.id);
  }

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
          <b>N° {inventory.number}</b>
          <small>
            {counted.size} / {inventory.articleIds.length} comptés · {s.session!.user.name}
          </small>
        </div>
        <Status />
        <button className="ghost" onClick={() => setMenu(true)} aria-label="Menu">
          ☰
        </button>
      </header>
      <main>
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
              const hit = lookup(s.index, query);
              if (hit) {
                onCode(query, false);
                setQuery('');
              } else if (results.length === 1) {
                setSheet({ article: results[0]!, level: levels(results[0]!).length - 1 });
                setQuery('');
              }
            }
          }}
          placeholder="Nom ou code du produit"
          enterKeyHint="search"
        />
        {query.trim().length >= 2 ? (
          <div className="list">
            {results.map((a) => (
              <ArticleRow key={a.id} article={a} inventory={inventory} onClick={() => (setSheet({ article: a, level: levels(a).length - 1 }), setQuery(''))} />
            ))}
            {!results.length ? (
              <div className="empty">
                Aucun produit trouvé.{' '}
                <button className="link" onClick={() => (setUnknown(query.trim()), setQuery(''))}>
                  Signaler un produit inconnu
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
              <button className={tab === 'reste' ? 'on' : ''} onClick={() => setTab('reste')}>
                Reste à compter
              </button>
              <button className={tab === 'recompter' ? 'on' : ''} onClick={() => setTab('recompter')}>
                À recompter{inventory.recount.length ? ` (${inventory.recount.length})` : ''}
              </button>
            </div>
            {tab === 'saisies' ? (
              <div className="list">
                {historyHere.slice(0, 60).map((h) => {
                  const a = s.articles.get(h.articleId);
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
                  <div className="empty">Scannez un produit pour commencer. Les quantités partent toutes seules au serveur, même après une coupure.</div>
                ) : null}
              </div>
            ) : tab === 'reste' ? (
              <Remaining inventory={inventory} counted={counted} onOpen={(a) => setSheet({ article: a, level: levels(a).length - 1 })} />
            ) : (
              <div className="list">
                <p className="muted small">
                  Un collègue a trouvé un gros écart sur ces produits. Recomptez-les à l’endroit où ils sont rangés : votre saisie remplace la sienne pour cet endroit.
                </p>
                {inventory.recount
                  .map((id) => s.articles.get(id))
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
        <Unknown code={unknown} inventoryId={inventory.id} onClose={(saved) => (setUnknown(null), saved && show('Produit inconnu signalé au gérant', true))} />
      ) : null}
      {newPlace ? <NewPlace onClose={() => setNewPlace(false)} /> : null}
      {menu ? <Settings onClose={() => setMenu(false)} /> : null}
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
      <span className="chev">›</span>
    </div>
  );
}

function Remaining({ inventory, counted, onOpen }: { inventory: S.ServerInventory; counted: Set<string>; onOpen: (a: Article) => void }) {
  const s = useStore();
  const [dept, setDept] = useState<string>(inventory.assigned.length ? 'mine' : 'all');
  const [limit, setLimit] = useState(80);
  const departments = s.catalog?.departments ?? [];
  const usedDepts = useMemo(() => {
    const ids = new Set<string>();
    for (const id of inventory.articleIds) {
      const d = s.articles.get(id)?.departmentId;
      if (d) ids.add(d);
    }
    return departments.filter((d) => ids.has(d.id));
  }, [inventory.articleIds, s.articles, departments]);
  const left = inventory.articleIds
    .filter((id) => !counted.has(id))
    .map((id) => s.articles.get(id))
    .filter((a): a is Article => Boolean(a))
    .filter((a) => (dept === 'all' ? true : dept === 'mine' ? inventory.assigned.includes(a.departmentId ?? '') : a.departmentId === dept))
    .sort((a, b) => a.name.localeCompare(b.name, 'fr'));
  return (
    <div className="list">
      <select className="select" value={dept} onChange={(e) => (setDept(e.target.value), setLimit(80))}>
        {inventory.assigned.length ? <option value="mine">Mes rayons</option> : null}
        <option value="all">Tous les rayons</option>
        {usedDepts.map((d) => (
          <option key={d.id} value={d.id}>
            {d.name}
          </option>
        ))}
      </select>
      <p className="muted small">{left.length} produit(s) pas encore comptés.</p>
      {left.slice(0, limit).map((a) => (
        <ArticleRow key={a.id} article={a} inventory={inventory} onClick={() => onOpen(a)} />
      ))}
      {left.length > limit ? (
        <button className="big" onClick={() => setLimit(limit + 200)}>
          Afficher plus
        </button>
      ) : null}
      {!left.length ? <div className="empty">Tout est compté ici.</div> : null}
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
    S.record(inventory.id, article.id, newHere, mode === 'add' && here ? addDetail(here.detail, detail) : detail);
    onClose(`${article.name} : ${formatQty(newHere, article)} (${s.location})`);
  };
  return (
    <div className="modal" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet">
        <div className="row">
          {article.thumb ? <img className="thumb big-thumb" src={article.thumb} alt="" /> : null}
          <div className="grow">
            <h2>{article.name}</h2>
            <div className="muted small">
              {article.code}
              {deptName ? ` · ${deptName}` : ''}
            </div>
          </div>
        </div>
        {outside ? <div className="notice info">Ce produit n’est pas dans la liste de cet inventaire : il y sera ajouté.</div> : null}
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

function Unknown({ code, inventoryId, onClose }: { code: string; inventoryId: string; onClose: (saved: boolean) => void }) {
  const [note, setNote] = useState('');
  const [qty, setQty] = useState('');
  const [photo, setPhoto] = useState<string | null>(null);
  const [error, setError] = useState('');
  return (
    <div className="modal" onClick={(e) => e.target === e.currentTarget && onClose(false)}>
      <div className="sheet">
        <h2>Produit inconnu</h2>
        <p className="muted">
          {code ? `Le code ${code} n’est pas dans le catalogue.` : 'Produit sans code.'} Prenez-le en photo et notez son nom : le gérant créera l’article, puis vous le compterez.
        </p>
        <label className="field">
          Nom lu sur l’emballage
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Ex. : Biscuits Choco 200 g" />
        </label>
        <label className="field">
          Quantité trouvée
          <input value={qty} onChange={(e) => setQty(e.target.value)} inputMode="decimal" placeholder="0" />
        </label>
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
        {error ? <div className="notice erreur">{error}</div> : null}
        <button
          className="big primary"
          onClick={() => {
            const n = qty.trim() ? Number(qty.replace(',', '.')) : null;
            if (n !== null && !(n >= 0)) return setError('Quantité invalide');
            if (!note.trim() && !photo && !code) return setError('Notez le nom ou prenez une photo');
            S.addUnknown({ inventoryId, code, note: note.trim(), qty: n === null ? null : Math.round(n * 1000), photo });
            onClose(true);
          }}
        >
          Envoyer au gérant
        </button>
        <button className="link" onClick={() => onClose(false)}>
          Annuler
        </button>
      </div>
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
