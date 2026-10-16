import { ApiError, findServer, request } from './api';
import { type Article, type Catalog, type Hit, type PlaceCount, buildIndex, newId, placeKey } from './logic';
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
};

let outbox: OutCount[] = [];
let unknowns: OutUnknown[] = [];
/** Comptages et historique de chaque personne qui a compté sur ce téléphone. */
let countsByUser: Record<string, Record<string, PlaceCount>> = {};
let historyByUser: Record<string, HistoryItem[]> = {};

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
  const userId = session?.user.id ?? '';
  set({
    ready: true,
    config,
    session,
    ...withCatalog(catalog),
    inventories: inventories.list,
    showExpected: inventories.showExpected,
    counts: countsByUser[userId] ?? {},
    history: historyByUser[userId] ?? [],
    locations: prefs.locations?.length ? prefs.locations : DEFAULT_LOCATIONS,
    location: prefs.location || 'Rayon',
    rapid: Boolean(prefs.rapid),
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

export async function pair(urls: string[], code: string, deviceName: string) {
  const url = await findServer(urls);
  if (!url) throw new ApiError(`Serveur introuvable à ${urls.join(' ou ')}. Le téléphone est-il sur le Wi-Fi du magasin ?`, 0);
  const r = await request<{ token: string; storeId: string; storeName: string }>(url, '/api/v1/mobile/pair', { body: { code, name: deviceName } });
  const config: Config = { urls: [...new Set([url, ...urls])], url, token: r.token, storeId: r.storeId, storeName: r.storeName, deviceName };
  await save('config', config);
  set({ config, online: true });
}

export async function login(loginName: string, pin: string) {
  const config = state.config;
  if (!config) return;
  const r = await request<{ session: string; user: User; storeName: string }>(config.url, '/api/v1/mobile/login', {
    body: { login: loginName, pin },
    auth: { token: config.token },
  }).catch(async (e) => {
    // Le serveur a peut-être changé d'adresse sur le réseau du magasin.
    if (e instanceof ApiError && e.status === 0 && (await switchServer())) {
      return request<{ session: string; user: User; storeName: string }>(state.config!.url, '/api/v1/mobile/login', {
        body: { login: loginName, pin },
        auth: { token: config.token },
      });
    }
    throw e;
  });
  const session = { token: r.session, user: r.user };
  await save('session', session);
  set({ session, counts: countsByUser[r.user.id] ?? {}, history: historyByUser[r.user.id] ?? [], online: true });
  await sync();
}

/** Changer d'utilisateur : ses saisies pas encore envoyées partent quand même, à son nom. */
export async function logout() {
  const session = state.session;
  await sync();
  if (session && state.config && !outbox.some((o) => o.session === session.token) && !unknowns.some((u) => u.session === session.token)) {
    await request(state.config.url, '/api/v1/mobile/logout', { body: {}, auth: { token: state.config.token, session: session.token } }).catch(() => undefined);
  }
  await save('session', null);
  set({ session: null, counts: {}, history: [] });
}

/** Délier le téléphone : tout ce qui est en mémoire est effacé. */
export async function unpair() {
  await clearAll();
  outbox = [];
  unknowns = [];
  countsByUser = {};
  historyByUser = {};
  set({ config: null, session: null, ...withCatalog(null), inventories: [], counts: {}, history: [], notices: [] });
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
  if (!userId) return;
  countsByUser[userId] = state.counts;
  historyByUser[userId] = state.history;
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
  if (!session) return;
  const key = placeKey(inventoryId, articleId, location);
  const before = state.counts[key] ?? null;
  const at = new Date().toISOString();
  const after = qty === null ? null : { qty, detail, at };
  const counts = { ...state.counts };
  if (after) counts[key] = after;
  else delete counts[key];
  const id = newId();
  outbox.push({ id, inventoryId, articleId, location, qty, detail, countedAt: at, session: session.token });
  const history = [{ id, inventoryId, articleId, location, before, after, at }, ...state.history].slice(0, 200);
  set({ counts, history });
  persistCounts();
  syncSoon();
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
      await save('session', null);
      set({ session: null });
      notify('Reconnectez-vous pour continuer.', 'erreur');
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
  const r = await request<{ inventories: ServerInventory[]; catalogVersion: string; showExpected: boolean; user: User }>(config.url, '/api/v1/mobile/inventories', {
    auth: auth(),
  });
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
  // Inventaires clôturés : leurs comptages ne servent plus.
  const open = new Set(r.inventories.map((i) => i.id));
  for (const key of Object.keys(counts)) {
    if (!open.has(key.split('|')[0]!)) {
      delete counts[key];
      changed = true;
    }
  }
  set({ inventories: r.inventories, showExpected: r.showExpected, ...(changed ? { counts } : {}) });
  if (changed) persistCounts();
  await save('inventories', { list: r.inventories, showExpected: r.showExpected });
  if (r.catalogVersion !== state.catalog?.version) await refreshCatalog(config);
}

export async function refreshCatalog(config = state.config) {
  if (!config || !state.session) return;
  const r = await request<Catalog & { unchanged?: boolean }>(config.url, `/api/v1/mobile/catalog${state.catalog ? `?since=${encodeURIComponent(state.catalog.version)}` : ''}`, {
    auth: auth(),
    timeout: 60_000,
  });
  if (r.unchanged) return;
  const catalog = { version: r.version, articles: r.articles, departments: r.departments };
  await save('catalog', catalog);
  set(withCatalog(catalog));
}
