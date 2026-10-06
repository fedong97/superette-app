import { join } from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { autoUpdater } from 'electron-updater';
import { AppError, openServices } from '@superette/db';
import { type ApiName, createApi } from './api';
import { createPrinter } from './print';
import { createSyncRunner } from './sync';

// Une seule instance par PC : la base locale n'accepte qu'un écrivain.
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1366,
    height: 800,
    minWidth: 1024,
    minHeight: 700,
    show: false,
    title: 'Superette Gestion',
    autoHideMenuBar: true,
    backgroundColor: '#f4f5f7',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
    },
  });
  win.once('ready-to-show', () => {
    win.maximize();
    win.show();
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  if (process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'));
  }
  return win;
}

void app.whenReady().then(() => {
  const dbFile = process.env['SUPERETTE_DB'] ?? join(app.getPath('userData'), 'superette.db');
  let services;
  try {
    services = openServices(dbFile);
  } catch (e) {
    dialog.showErrorBox('Base de données inaccessible', `${dbFile}\n\n${String(e)}`);
    app.quit();
    return;
  }
  const sync = createSyncRunner(services);
  const api = createApi(services, createPrinter(services), sync, app.getVersion());

  ipcMain.handle('api', async (_event, name: ApiName, args: unknown[]) => {
    const fn = api[name] as ((...a: unknown[]) => unknown) | undefined;
    if (typeof fn !== 'function') return { ok: false, error: { message: `Action inconnue : ${String(name)}`, code: 'UNKNOWN' } };
    try {
      return { ok: true, data: await fn(...args) };
    } catch (e) {
      if (e instanceof AppError) return { ok: false, error: { message: e.message, code: e.code } };
      console.error(`[api] ${String(name)}`, e);
      return { ok: false, error: { message: e instanceof Error ? e.message : String(e), code: 'INTERNAL' } };
    }
  });

  createWindow();

  // Mise à jour automatique au démarrage (installateur packagé uniquement).
  if (app.isPackaged) {
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.checkForUpdatesAndNotify().catch((e) => console.warn('Vérification de mise à jour impossible', e));
  }

  app.on('before-quit', () => {
    sync.stop();
    services.db.close();
  });
});

app.on('second-instance', () => {
  const win = BrowserWindow.getAllWindows()[0];
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

app.on('window-all-closed', () => app.quit());
