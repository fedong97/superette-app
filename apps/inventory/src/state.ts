import { ApiError, findServer, request } from './api';
import { type Article, type Catalog, type FileLine, type Hit, type ParsedFile, type PlaceCount, buildIndex, fileArticle, newId, placeKey } from './logic';
import { clearAll, load, save } from './storage';

/** Téléphone relié à un magasin par le QR code du gérant. */
export interface Config {
  urls: string[];
  url: string;
  token: string;
  storeId: string;
  storeName: string;
  deviceName: string;
}

export interface User {
  id: string;
  name: string;
  role: string;
}

export interface Session {
  token: string;
  user: User;
  /** Ce que la personne peut faire : compter un inventaire, préparer un panier au rayon. */
  can?: { count: boolean; cart: boolean };
}

/** Ligne du panier préparé au rayon : quantité en millièmes d'unité. */
export interface CartLine {
  articleId: string;
  qty: number;
}

/** Panier envoyé à la caisse aujourd'hui. */
export interface SentCart {
  id: string;
  number: number;
  label: string | null;
  lines: number;
  at: string;
  takenAt: string | null;
}

/** Inventaire ouvert, tel que le serveur l'envoie. */
export interface ServerInventory {
  id: string;
  number: string;
  label: string | null;
  kind: 'global' | 'partial' | string;
  warehouseId: string;
  warehouseName: string;
  inventoryDate: string;
  departmentIds: string[];
  articleIds: string[];
  counted: { articleId: string; qty: number; at: string | null; by: string }[];
  mine: { articleId: string; location: string; qty: number; detail: number[] | null; at: string }[];
  assigned: string[];
  recount: string[];
  expected: Record<string, number> | null;
}

/** Fiche de comptage ouverte sur le téléphone, sans serveur (mode fichier). */
export interface FileInventory extends ServerInventory {
  file: true;
  format: 'pc' | 'txt';
  fileName: string;
  createdAt: string;
  closed: boolean;
  articles: Article[];
  lines: Record<string, FileLine>;
}

/** Inventaire clôturé sur le PC : ce que la personne y a compté, gardé en lecture seule. */
export interface Archive {
  inventory: ServerInventory;
  counts: Record<string, PlaceCount>;
  closedAt: string;
}

export const isFile = (inv: ServerInventory): inv is FileInventory => (inv as FileInventory).file === true;
const isFileId = (id: string) => id.startsWith('f-');
/** Comptages des fiches : rangés à part, ils ne changent pas avec la personne connectée. */
const LOCAL = 'local';

interface OutCount {
  id: string;
  inventoryId: string;
  articleId: string;
  location: string;
  qty: number | null;
  detail: number[] | null;
  countedAt: string;
  session: string;
}

interface OutUnknown {
  id: string;
  inventoryId: string | null;
  code: string;
  note: string;
  qty: number | null;
  location: string;
  photo: string | null;
  at: string;
  session: string;
}

export interface HistoryItem {
  id: string;
  inventoryId: string;
  articleId: string;
  location: string;
  before: PlaceCount | null;
  after: PlaceCount | null;
  at: string;
  undone?: boolean;
}

export interface Notice {
  id: string;
  level: 'erreur' | 'info';
  text: string;
}

export interface State {
  ready: boolean;
  config: Config | null;
  session: Session | null;
  catalog: Catalog | null;
  index: Map<string, Hit>;
  articles: Map<string, Article>;
  inventories: ServerInventory[];
  files: FileInventory[];
  archives: Archive[];
  showExpected: boolean;
  /** Comptages de l'utilisateur connecté sur ce téléphone, par inventaire, produit et endroit. */
  counts: Record<string, PlaceCount>;
  history: HistoryItem[];
  pending: number;
  online: boolean | null;
  syncing: boolean;
  lastSync: string | null;
  notices: Notice[];
  locations: string[];
  location: string;
  rapid: boolean;
  /** Dernière erreur du téléchargement du catalogue (affichée à la place des produits introuvables). */
  catalogError: string | null;
  /** Panier en préparation au rayon (gardé sur le téléphone jusqu'à l'envoi). */
  cart: CartLine[];
  cartLabel: string;
  sentCarts: SentCart[];
}

const DEFAULT_LOCATIONS = ['Rayon', 'Réserve', 'Chambre froide'];

let state: State = {
  ready: false,
  config: null,
  session: null,
  catalog: null,
  index: new Map(),
  articles: new Map(),
  inventories: [],
  files: [],
  archives: [],
  showExpected: false,
  counts: {},
  history: [],
  pending: 0,
  online: null,
  syncing: false,
  lastSync: null,
  notices: [],
  locations: DEFAULT_LOCATIONS,
  location: 'Rayon',
  rapid: false,
  catalogError: null,
  cart: [],
  cartLabel: '',
  sentCarts: [],
};

let outbox: OutCount[] = [];
let unknowns: OutUnknown[] = [];
/** Comptages et historique de chaque personne qui a compté sur ce téléphone. */
let countsByUser: Record<string, Record<string, PlaceCount>> = {};
let historyByUser: Record<string, HistoryItem[]> = {};
let archivesByUser: Record<string, Archive[]> = {};

/** Comptages visibles : ceux de la personne connectée et ceux des fiches. */
function countsOf(userId: string | undefined) {
  return { ...(userId ? countsByUser[userId] : {}), ...countsByUser[LOCAL] };
}
function historyOf(userId: string | undefined) {
  return [...(userId ? (historyByUser[userId] ?? []) : []), ...(historyByUser[LOCAL] ?? [])].sort((a, b) => b.at.localeCompare(a.at));
}

const listeners = new Set<() => void>();
export const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};
export const getState = () => state;

function set(patch: Partial<State>) {
  state = { ...state, ...patch, pending: outbox.length + unknowns.length };
  for (const fn of listeners) fn();
}

function notify(text: string, level: Notice['level'] = 'info') {
  set({ notices: [...state.notices.filter((n) => n.text !== text), { id: newId(), level, text }].slice(-4) });
}

export function dismiss(id: string) {
  set({ notices: state.notices.filter((n) => n.id !== id) });
}

const auth = () => ({ token: state.config?.token, session: state.session?.token });

function withCatalog(catalog: Catalog | null): Partial<State> {
  return { catalog, index: buildIndex(catalog?.articles ?? []), articles: new Map((catalog?.articles ?? []).map((a) => [a.id, a])) };
}

// ——— Démarrage ———

export async function init() {
  const [config, session, catalog, inventories, prefs] = await Promise.all([
    load<Config | null>('config', null),
    load<Session | null>('session', null),
    load<Catalog | null>('catalog', null),
    load<{ list: ServerInventory[]; showExpected: boolean }>('inventories', { list: [], showExpected: false }),
    load<{ locations: string[]; location: string; rapid: boolean }>('prefs', { locations: DEFAULT_LOCATIONS, location: 'Rayon', rapid: false }),
  ]);
  outbox = await load<OutCount[]>('outbox', []);
  unknowns = await load<OutUnknown[]>('unknowns', []);
  countsByUser = await load('counts', {});
  historyByUser = await load('history', {});
  archivesByUser = await load('archives', {});
  const files = await load<FileInventory[]>('files', []);
  const cart = await load<{ lines: CartLine[]; label: string }>('cart', { lines: [], label: '' });
  const userId = session?.user.id;
  set({
    ready: true,
    config,
    session,
    ...withCatalog(catalog),
    inventories: inventories.list,
    files,
    archives: userId ? (archivesByUser[userId] ?? []) : [],
    showExpected: inventories.showExpected,
    counts: countsOf(userId),
    history: historyOf(userId),
    locations: prefs.locations?.length ? prefs.locations : DEFAULT_LOCATIONS,
    location: prefs.location || 'Rayon',
    rapid: Boolean(prefs.rapid),
    cart: cart.lines ?? [],
    cartLabel: cart.label ?? '',
  });
  setInterval(() => void sync(), 20_000);
  window.addEventListener('online', () => void sync());
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && void sync());
  void sync();
}

const savePrefs = () => save('prefs', { locations: state.locations, location: state.location, rapid: state.rapid });

export function setLocation(location: string) {
  const name = location.trim().slice(0, 40);
  if (!name) return;
  set({ location: name, locations: state.locations.includes(name) ? state.locations : [...state.locations, name] });
  void savePrefs();
}

export function removeLocation(location: string) {
  if (DEFAULT_LOCATIONS.includes(location)) return;
  set({ locations: state.locations.filter((l) => l !== location), location: state.location === location ? 'Rayon' : state.location });
  void savePrefs();
}

export function setRapid(rapid: boolean) {
  set({ rapid });
  void savePrefs();
}

// ——— Rattachement et connexion ———

/** Relie le téléphone (QR du gérant) ; avec un code d'aide, connecte aussi l'aide. */
export async function pair(urls: string[], code: string, deviceName: string, guest?: string) {
  const url = await findServer(urls);
  if (!url) throw new ApiError(`Serveur introuvable à ${urls.join(' ou ')}. Le téléphone est-il sur le Wi-Fi du magasin ?`, 0);
  const r = await request<{ token: string; storeId: string; storeName: string; session?: string; user?: User }>(url, '/api/v1/mobile/pair', {
    body: guest ? { guest, name: deviceName } : { code, name: deviceName },
  });
  const config: Config = { urls: [...new Set([url, ...urls])], url, token: r.token, storeId: r.storeId, storeName: r.storeName, deviceName };
  await save('config', config);
  set({ config, online: true });
  if (r.session && r.user) await startSession({ token: r.session, user: r.user, can: (r as { can?: Session['can'] }).can });
}

async function startSession(session: Session) {
  await save('session', session);
  set({
    session,
    counts: countsOf(session.user.id),
    history: historyOf(session.user.id),
    archives: archivesByUser[session.user.id] ?? [],
    online: true,
  });
  await sync();
}

/** Aide sans compte sur un téléphone déjà relié : le code à 6 chiffres donné par le gérant. */
export async function loginGuest(code: string) {
  const config = state.config;
  if (!config) return;
  const r = await request<{ session: string; user: User }>(config.url, '/api/v1/mobile/guest', { body: { code }, auth: { token: config.token } });
  await startSession({ token: r.session, user: r.user });
}

export async function login(loginName: string, pin: string) {
  const config = state.config;
  if (!config) return;
  type LoginReply = { session: string; user: User; storeName: string; can?: Session['can'] };
  const r = await request<LoginReply>(config.url, '/api/v1/mobile/login', {
    body: { login: loginName, pin },
    auth: { token: config.token },
  }).catch(async (e) => {
    // Le serveur a peut-être changé d'adresse sur le réseau du magasin.
    if (e instanceof ApiError && e.status === 0 && (await switchServer())) {
      return request<LoginReply>(state.config!.url, '/api/v1/mobile/login', {
        body: { login: loginName, pin },
        auth: { token: config.token },
      });
    }
    throw e;
  });
  await startSession({ token: r.session, user: r.user, can: r.can });
}

/** Changer d'utilisateur : ses saisies pas encore envoyées partent quand même, à son nom. */
export async function logout() {
  const session = state.session;
  await sync();
  if (session && state.config && !outbox.some((o) => o.session === session.token) && !unknowns.some((u) => u.session === session.token)) {
    await request(state.config.url, '/api/v1/mobile/logout', { body: {}, auth: { token: state.config.token, session: session.token } }).catch(() => undefined);
  }
  await save('session', null);
  set({ session: null, counts: countsOf(undefined), history: historyOf(undefined), archives: [] });
}

/** Délier le téléphone : tout ce qui est en mémoire est effacé. */
export async function unpair() {
  await clearAll();
  outbox = [];
  unknowns = [];
  countsByUser = {};
  historyByUser = {};
  archivesByUser = {};
  set({ config: null, session: null, ...withCatalog(null), inventories: [], files: [], archives: [], counts: {}, history: [], notices: [] });
}

export async function setServerAddress(url: string) {
  if (!state.config) return;
  const ok = await findServer([url]);
  if (!ok) throw new ApiError('Ce serveur ne répond pas', 0);
  const config = { ...state.config, url, urls: [...new Set([url, ...state.config.urls])] };
  await save('config', config);
  set({ config });
  void sync();
}

async function switchServer(): Promise<boolean> {
  const config = state.config;
  if (!config || config.urls.length < 2) return false;
  const url = await findServer(config.urls);
  if (!url || url === config.url) return false;
  const next = { ...config, url };
  await save('config', next);
  set({ config: next });
  return true;
}

// ——— Comptage ———

function persistCounts() {
  const userId = state.session?.user.id;
  const local: Record<string, PlaceCount> = {};
  const mine: Record<string, PlaceCount> = {};
  for (const [k, v] of Object.entries(state.counts)) (isFileId(k) ? local : mine)[k] = v;
  countsByUser[LOCAL] = local;
  historyByUser[LOCAL] = state.history.filter((h) => isFileId(h.inventoryId));
  if (userId) {
    countsByUser[userId] = mine;
    historyByUser[userId] = state.history.filter((h) => !isFileId(h.inventoryId));
  }
  void save('counts', countsByUser);
  void save('history', historyByUser);
  void save('outbox', outbox);
}

let soon: ReturnType<typeof setTimeout> | undefined;
function syncSoon() {
  clearTimeout(soon);
  soon = setTimeout(() => void sync(), 1_500);
}

/** Enregistre la quantité d'un produit à l'endroit choisi (null : efface l'endroit). */
export function record(inventoryId: string, articleId: string, qty: number | null, detail: number[] | null, location = state.location) {
  const session = state.session;
  const file = isFileId(inventoryId);
  if (!session && !file) return;
  const key = placeKey(inventoryId, articleId, location);
  const before = state.counts[key] ?? null;
  const at = new Date().toISOString();
  const after = qty === null ? null : { qty, detail, at };
  const counts = { ...state.counts };
  if (after) counts[key] = after;
  else delete counts[key];
  const id = newId();
  if (!file) outbox.push({ id, inventoryId, articleId, location, qty, detail, countedAt: at, session: session!.token });
  const history = [{ id, inventoryId, articleId, location, before, after, at }, ...state.history].slice(0, 300);
  set({ counts, history });
  persistCounts();
  if (!file) syncSoon();
}

/** Remet à 0 mes comptages d'un inventaire : un endroit, ou tous (location null). */
export function resetCounts(inventoryId: string, location: string | null): number {
  const prefix = `${inventoryId}|`;
  const keys = Object.keys(state.counts).filter((k) => k.startsWith(prefix) && (location === null || k.endsWith(`|${location}`)));
  const file = isFileId(inventoryId);
  const at = new Date().toISOString();
  const counts = { ...state.counts };
  for (const k of keys) {
    const [, articleId, ...rest] = k.split('|');
    const place = rest.join('|');
    delete counts[k];
    if (!file && state.session) outbox.push({ id: newId(), inventoryId, articleId: articleId!, location: place, qty: null, detail: null, countedAt: at, session: state.session.token });
  }
  // Les saisies effacées ne peuvent plus être annulées une par une.
  const gone = new Set(keys);
  const history = state.history.filter((h) => !gone.has(placeKey(h.inventoryId, h.articleId, h.location)));
  set({ counts, history });
  persistCounts();
  if (!file) syncSoon();
  return keys.length;
}

// ——— Mode fichier ———

const saveFiles = (files: FileInventory[]) => {
  set({ files });
  void save('files', files);
};

/** Ouvre une fiche de comptage (fichier du PC ou fichier texte) comme un inventaire du téléphone. */
export function openFile(fileName: string, parsed: ParsedFile): FileInventory {
  const id = `f-${newId()}`;
  const articles: Article[] = [];
  const lines: Record<string, FileLine> = {};
  const seen = new Set<string>();
  for (const line of parsed.lines) {
    const a = fileArticle(line, state.index);
    if (seen.has(a.id)) continue;
    seen.add(a.id);
    articles.push(a);
    lines[a.id] = line;
  }
  const title = fileName.replace(/\.(csv|txt|xlsx)$/i, '');
  const inv: FileInventory = {
    file: true,
    format: parsed.format,
    fileName,
    createdAt: new Date().toISOString(),
    closed: false,
    articles,
    lines,
    id,
    number: title.slice(0, 40),
    label: parsed.title,
    kind: 'file',
    warehouseId: '',
    warehouseName: 'Fichier',
    inventoryDate: new Date().toISOString().slice(0, 10),
    departmentIds: [],
    articleIds: articles.map((a) => a.id),
    counted: [],
    mine: [],
    assigned: [],
    recount: [],
    expected: null,
  };
  saveFiles([inv, ...state.files]);
  // Quantités déjà inscrites dans le fichier : un endroit à part, modifiable.
  const counts = { ...state.counts };
  for (const a of articles) {
    const q = lines[a.id]?.qty;
    if (q) counts[placeKey(id, a.id, 'Déjà dans le fichier')] = { qty: q, detail: null, at: inv.createdAt };
  }
  set({ counts });
  persistCounts();
  return inv;
}

export function updateFile(id: string, patch: Partial<Pick<FileInventory, 'number' | 'closed'>>) {
  saveFiles(state.files.map((f) => (f.id === id ? { ...f, ...patch } : f)));
}

export function deleteFile(id: string) {
  resetCounts(id, null);
  saveFiles(state.files.filter((f) => f.id !== id));
}

/** Produit compté qui n'était pas dans la fiche (scan d'un article du catalogue ou produit noté à la main). */
export function addToFile(id: string, article: Article, line?: FileLine) {
  const f = state.files.find((x) => x.id === id);
  if (!f || f.articleIds.includes(article.id)) return;
  saveFiles(
    state.files.map((x) =>
      x.id === id
        ? {
            ...x,
            articles: [...x.articles, article],
            articleIds: [...x.articleIds, article.id],
            lines: { ...x.lines, [article.id]: line ?? { code: article.code, name: article.name, pack: null, department: null, qty: null } },
          }
        : x,
    ),
  );
}

/** Annule une saisie : l'endroit reprend la quantité d'avant. */
export function undo(item: HistoryItem) {
  record(item.inventoryId, item.articleId, item.before?.qty ?? null, item.before?.detail ?? null, item.location);
  // La saisie d'annulation n'encombre pas la liste : seule la saisie annulée est barrée.
  const [, ...rest] = state.history;
  set({ history: rest.map((h) => (h.id === item.id ? { ...h, undone: true } : h)) });
  persistCounts();
}

export function addUnknown(input: { inventoryId: string | null; code: string; note: string; qty: number | null; photo: string | null }) {
  const session = state.session;
  if (!session) return;
  unknowns.push({ id: newId(), ...input, location: state.location, at: new Date().toISOString(), session: session.token });
  void save('unknowns', unknowns);
  set({});
  syncSoon();
}

// ——— Synchronisation ———

let running: Promise<void> | null = null;

export function sync(): Promise<void> {
  if (!running) running = doSync().finally(() => (running = null));
  return running;
}

async function doSync() {
  const config = state.config;
  if (!config) return;
  set({ syncing: true });
  try {
    await pushCounts(config);
    await pushUnknowns(config);
    if (state.session) await refresh(config);
    set({ online: true, lastSync: new Date().toISOString() });
  } catch (e) {
    if (e instanceof ApiError && e.status === 0) {
      set({ online: false });
      void switchServer();
    } else if (e instanceof ApiError && e.status === 401 && /délié/.test(e.message)) {
      notify('Ce téléphone a été délié par le gérant. Reliez-le de nouveau avec un QR code.', 'erreur');
    } else if (e instanceof ApiError && e.status === 401) {
      // Session terminée côté serveur : il faut se reconnecter, les saisies restent sur le téléphone.
      const wasGuest = state.session?.user.role === 'guest';
      await save('session', null);
      set({ session: null, counts: countsOf(undefined), history: historyOf(undefined), archives: [] });
      notify(wasGuest ? 'Votre accès d’aide est terminé (inventaire clôturé ou accès coupé par le gérant). Merci pour votre aide !' : 'Reconnectez-vous pour continuer.', 'erreur');
    } else {
      notify(e instanceof Error ? e.message : 'Erreur de synchronisation', 'erreur');
    }
  } finally {
    set({ syncing: false });
  }
}

async function pushCounts(config: Config) {
  while (outbox.length) {
    const sessionToken = outbox[0]!.session;
    const batch = outbox.filter((o) => o.session === sessionToken).slice(0, 200);
    let r: { accepted: string[]; rejected: { id: string; reason: string }[] };
    try {
      r = await request(config.url, '/api/v1/mobile/counts', {
        body: { counts: batch.map(({ session: _s, ...c }) => c), sentAt: new Date().toISOString() },
        auth: { token: config.token, session: sessionToken },
      });
    } catch (e) {
      // Saisies d'une session qui n'existe plus (téléphone délié puis relié) : elles ne partiront jamais.
      if (e instanceof ApiError && e.status === 401 && sessionToken !== state.session?.token && !/délié/.test(e.message)) {
        outbox = outbox.filter((o) => o.session !== sessionToken);
        notify(`${batch.length} saisie(s) d'un utilisateur déconnecté n'ont pas pu être envoyées.`, 'erreur');
        continue;
      }
      throw e;
    }
    const done = new Set([...r.accepted, ...r.rejected.map((x) => x.id)]);
    outbox = outbox.filter((o) => !done.has(o.id));
    await save('outbox', outbox);
    if (r.rejected.length) {
      const reasons = [...new Set(r.rejected.map((x) => x.reason))].join(', ');
      notify(`${r.rejected.length} saisie(s) refusée(s) par le serveur : ${reasons}.`, 'erreur');
    }
    set({});
    if (!r.accepted.length && !r.rejected.length) break;
  }
}

async function pushUnknowns(config: Config) {
  while (unknowns.length) {
    const u = unknowns[0]!;
    const { session, ...body } = u;
    await request(config.url, '/api/v1/mobile/unknowns', { body, auth: { token: config.token, session } });
    unknowns = unknowns.slice(1);
    await save('unknowns', unknowns);
    set({});
  }
}

async function refresh(config: Config) {
  const r = await request<{ inventories: ServerInventory[]; catalogVersion: string; showExpected: boolean; user: User; can?: Session['can'] }>(config.url, '/api/v1/mobile/inventories', {
    auth: auth(),
  });
  // Droits changés par le gérant depuis la connexion.
  if (r.can && state.session && JSON.stringify(r.can) !== JSON.stringify(state.session.can)) {
    const session = { ...state.session, can: r.can };
    await save('session', session);
    set({ session });
  }
  // Comptages faits par la même personne sur un autre téléphone (ou avant une réinstallation).
  const counts = { ...state.counts };
  let changed = false;
  for (const inv of r.inventories) {
    for (const m of inv.mine) {
      const key = placeKey(inv.id, m.articleId, m.location);
      const local = counts[key];
      if (!local || (local.at < m.at && !outbox.some((o) => placeKey(o.inventoryId, o.articleId, o.location) === key))) {
        counts[key] = { qty: m.qty, detail: m.detail, at: m.at };
        changed = true;
      }
    }
  }
  // Inventaires clôturés : mes comptages sont gardés à part, en lecture seule.
  const open = new Set(r.inventories.map((i) => i.id));
  const closing = new Map<string, Record<string, PlaceCount>>();
  for (const key of Object.keys(counts)) {
    const invId = key.split('|')[0]!;
    if (isFileId(invId) || open.has(invId)) continue;
    if (!closing.has(invId)) closing.set(invId, {});
    closing.get(invId)![key] = counts[key]!;
    delete counts[key];
    changed = true;
  }
  const userId = state.session?.user.id;
  if (userId && closing.size) {
    const closedAt = new Date().toISOString();
    const added = [...closing]
      .map(([invId, c]) => {
        const inventory = state.inventories.find((i) => i.id === invId);
        return inventory ? { inventory, counts: c, closedAt } : null;
      })
      .filter((x): x is Archive => Boolean(x));
    archivesByUser[userId] = [...added, ...(archivesByUser[userId] ?? []).filter((a) => !closing.has(a.inventory.id))].slice(0, 20);
    void save('archives', archivesByUser);
    set({ archives: archivesByUser[userId] });
  }
  set({ inventories: r.inventories, showExpected: r.showExpected, ...(changed ? { counts } : {}) });
  if (changed) persistCounts();
  await save('inventories', { list: r.inventories, showExpected: r.showExpected });
  // Catalogue d'une version sans les prix : retéléchargé en entier pour le panier.
  const noPrice = Boolean(state.catalog?.articles.length && state.catalog.articles[0]!.price === undefined);
  if (r.catalogVersion !== state.catalog?.version || !state.catalog?.articles.length || noPrice) await refreshCatalog(config, noPrice).catch(() => undefined);
}

export async function refreshCatalog(config = state.config, full = false) {
  if (!config || !state.session) return;
  const since = state.catalog?.articles.length && !full ? `?since=${encodeURIComponent(state.catalog.version)}` : '';
  let r: Catalog & { unchanged?: boolean };
  try {
    r = await request<Catalog & { unchanged?: boolean }>(config.url, `/api/v1/mobile/catalog${since}`, { auth: auth(), timeout: 120_000 });
  } catch (e) {
    set({ catalogError: e instanceof Error ? e.message : String(e) });
    throw e;
  }
  set({ catalogError: null });
  if (r.unchanged) return;
  const catalog = { version: r.version, articles: r.articles ?? [], departments: r.departments ?? [] };
  await save('catalog', catalog);
  set(withCatalog(catalog));
}

/**
 * Le serveur cherche un code ou un nom que le téléphone ne trouve pas. Les
 * articles trouvés rejoignent le catalogue du téléphone ; un code connu du
 * serveur mais absent ici veut dire que le catalogue est en retard : il est
 * retéléchargé en entier.
 */
export async function findOnServer(query: string): Promise<Article[]> {
  const config = state.config;
  if (!config || !state.session || query.trim().length < 2) return [];
  const r = await request<{ articles: Article[] }>(config.url, `/api/v1/mobile/find?q=${encodeURIComponent(query.trim())}`, { auth: auth(), timeout: 8_000 });
  const fresh = r.articles.filter((a) => !state.articles.has(a.id));
  if (fresh.length && state.catalog) {
    const catalog = { ...state.catalog, articles: [...state.catalog.articles, ...fresh] };
    set(withCatalog(catalog));
    void save('catalog', catalog);
    void refreshCatalog(config, true).catch(() => undefined);
  } else if (fresh.length) {
    set(withCatalog({ version: '', articles: fresh, departments: [] }));
    void refreshCatalog(config, true).catch(() => undefined);
  }
  return r.articles;
}

const thumbs = new Map<string, Promise<string | null>>();
/** Photo d'un article, demandée à l'ouverture de sa fiche. */
export function thumbOf(articleId: string): Promise<string | null> {
  const config = state.config;
  if (!config || !state.session || articleId.startsWith('f:')) return Promise.resolve(null);
  if (!thumbs.has(articleId)) {
    thumbs.set(
      articleId,
      request<{ thumb: string | null }>(config.url, `/api/v1/mobile/articles/${encodeURIComponent(articleId)}/thumb`, { auth: auth() })
        .then((r) => r.thumb)
        .catch(() => (thumbs.delete(articleId), null)),
    );
  }
  return thumbs.get(articleId)!;
}

// ——— Panier préparé au rayon ———

const saveCart = () => save('cart', { lines: state.cart, label: state.cartLabel });

/** Ajoute au panier (un scan ou une quantité tapée), en millièmes d'unité. */
export function addToCart(articleId: string, qty: number) {
  if (!(qty > 0)) return;
  const cur = state.cart.find((l) => l.articleId === articleId);
  const cart = cur ? state.cart.map((l) => (l.articleId === articleId ? { ...l, qty: l.qty + qty } : l)) : [{ articleId, qty }, ...state.cart];
  set({ cart });
  void saveCart();
}

export function setCartQty(articleId: string, qty: number) {
  set({ cart: qty > 0 ? state.cart.map((l) => (l.articleId === articleId ? { ...l, qty } : l)) : state.cart.filter((l) => l.articleId !== articleId) });
  void saveCart();
}

export function setCartLabel(label: string) {
  set({ cartLabel: label });
  void saveCart();
}

export function clearCart() {
  set({ cart: [], cartLabel: '' });
  void saveCart();
}

/** Envoie le panier à la caisse : il y attend d'être encaissé, au nom du vendeur. */
export async function sendCart(): Promise<number> {
  const config = state.config;
  if (!config || !state.session) throw new ApiError('Connectez-vous', 401);
  if (!state.cart.length) throw new ApiError('Le panier est vide', 400);
  const id = newId();
  const r = await request<{ id: string; number: number }>(config.url, '/api/v1/mobile/carts', {
    body: { id, label: state.cartLabel.trim() || null, lines: [...state.cart].reverse() },
    auth: auth(),
  });
  clearCart();
  void loadSentCarts();
  return r.number;
}

/** Paniers envoyés aujourd'hui et ceux déjà pris en caisse. */
export async function loadSentCarts() {
  const config = state.config;
  if (!config || !state.session) return;
  const r = await request<{ carts: SentCart[] }>(config.url, '/api/v1/mobile/carts', { auth: auth() }).catch(() => null);
  if (r) set({ sentCarts: r.carts });
}
