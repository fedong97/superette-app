import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';
import { autoUpdater } from 'electron-updater';
import type { Services } from '@superette/db';

const CHECK_EVERY_MS = 4 * 3_600_000;

export interface UpdateState {
  /** Mises à jour possibles : application installée (pas en développement). */
  enabled: boolean;
  version: string;
  /** Adresse lue : réglée à la main, sinon celle du serveur central. */
  url: string | null;
  /** Adresse réglée à la main (vide : celle du serveur central). */
  customUrl: string;
  status: 'idle' | 'checking' | 'none' | 'downloading' | 'ready' | 'error';
  available: string | null;
  percent: number;
  error: string | null;
  lastCheck: string | null;
}

/**
 * Mise à jour automatique : le PC lit les nouvelles versions sur le serveur central
 * (`<adresse du serveur>/mises-a-jour/`) ou à une adresse réglée à la main, au démarrage
 * puis toutes les 4 heures. La version téléchargée s'installe à la fermeture du logiciel.
 */
export function createUpdater(s: Services) {
  const file = join(app.getPath('userData'), 'mises-a-jour.json');
  const readCustom = (): string => {
    try {
      return String((JSON.parse(readFileSync(file, 'utf8')) as { url?: string }).url ?? '');
    } catch {
      return '';
    }
  };
  const state: UpdateState = {
    enabled: app.isPackaged,
    version: app.getVersion(),
    url: null,
    customUrl: readCustom(),
    status: 'idle',
    available: null,
    percent: 0,
    error: null,
    lastCheck: null,
  };

  const feedUrl = (): string | null => {
    const custom = state.customUrl.trim();
    if (custom) return custom.endsWith('/') ? custom : `${custom}/`;
    const server = s.sync.credentials()?.url;
    return server ? `${server.replace(/\/+$/, '')}/mises-a-jour/` : null;
  };

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('checking-for-update', () => Object.assign(state, { status: 'checking', error: null }));
  autoUpdater.on('update-not-available', () => Object.assign(state, { status: 'none', available: null }));
  autoUpdater.on('update-available', (info) => Object.assign(state, { status: 'downloading', available: info.version, percent: 0 }));
  autoUpdater.on('download-progress', (p) => (state.percent = Math.round(p.percent)));
  autoUpdater.on('update-downloaded', (info) => Object.assign(state, { status: 'ready', available: info.version, percent: 100 }));
  autoUpdater.on('error', (e) => Object.assign(state, { status: state.status === 'ready' ? 'ready' : 'error', error: e instanceof Error ? e.message : String(e) }));

  const check = async (): Promise<UpdateState> => {
    state.url = feedUrl();
    if (!state.enabled || !state.url || state.status === 'downloading' || state.status === 'ready') return { ...state };
    autoUpdater.setFeedURL({ provider: 'generic', url: state.url });
    state.lastCheck = new Date().toISOString();
    try {
      await autoUpdater.checkForUpdates();
    } catch (e) {
      Object.assign(state, { status: 'error', error: e instanceof Error ? e.message : String(e) });
    }
    return { ...state };
  };

  const quiet = () => void check().catch((e) => console.warn('[mise à jour]', e));
  // Un peu après le démarrage : laisse la synchronisation et la caisse démarrer.
  const first = setTimeout(quiet, 90_000);
  const timer = setInterval(quiet, CHECK_EVERY_MS);

  return {
    state: (): UpdateState => ({ ...state, url: feedUrl() }),
    check,
    setUrl: (url: string) => {
      const v = url.trim();
      if (v && !/^https?:\/\/\S+$/i.test(v)) throw new Error('Adresse invalide : elle commence par http:// ou https://');
      state.customUrl = v;
      writeFileSync(file, JSON.stringify({ url: v }));
      return { ...state, url: feedUrl() };
    },
    /** Ferme le logiciel et installe la version téléchargée. */
    install: () => {
      if (state.status !== 'ready') throw new Error('Aucune mise à jour prête à installer');
      setImmediate(() => autoUpdater.quitAndInstall(false, true));
    },
    stop: () => {
      clearTimeout(first);
      clearInterval(timer);
    },
  };
}

export type Updater = ReturnType<typeof createUpdater>;
