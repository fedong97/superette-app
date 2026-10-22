import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { AppError, defaultBackupDir, inspectBackup, installFiche, latestGoodBackup, openServices, restoreDatabase, setSyncClientVersion } from '@superette/db';
import { type ApiName, type SystemHooks, createApi } from './api';
import { fixesFor } from './fixes';
import { createCloudBackup } from './cloudBackup';
import { createCustomerDisplay } from './customerDisplay';
import { createDigestMailer } from './digest';
import { createDossiers } from './dossiers';
import { createFingerprintReceiver } from './fingerprint';
import { createPrinter } from './print';
import { createSyncRunner } from './sync';
import { createUpdater } from './updater';

// Le logiciel s'appelait « Superette Gestion » : on garde son dossier de données
// (%APPDATA%\Superette Gestion) pour que les magasins retrouvent leur base après la mise à jour.
app.setPath('userData', join(app.getPath('appData'), 'Superette Gestion'));

// Une seule instance par PC : la base locale n'accepte qu'un écrivain.
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

/** Fenêtre de l'application (l'afficheur client est une autre fenêtre). */
let mainWindow: BrowserWindow | null = null;

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1366,
    height: 800,
    // Un portable 1366 × 768 avec le zoom Windows à 125 % n'offre qu'environ 1090 × 580 :
    // au-delà, le bas du logiciel passerait sous la barre des tâches, impossible à voir.
    minWidth: 800,
    minHeight: 500,
    show: false,
    title: 'ONIX 360',
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
  // Sous Windows, après une question ou une fenêtre d'impression, la page peut
  // rester sans clavier : quand la fenêtre redevient active, on le lui rend.
  win.on('focus', () => win.webContents.focus());
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

/**
 * La base ne s'ouvre plus (disque, coupure de courant) : propose de la remplacer par
 * la dernière bonne sauvegarde. La base abîmée est gardée à côté, jamais effacée.
 */
function recoverFromBackup(dbFile: string, error: unknown): boolean {
  const found = latestGoodBackup(defaultBackupDir(dbFile));
  const when = found ? new Date(found.created_at).toLocaleString('fr-FR') : null;
  const choice = dialog.showMessageBoxSync({
    type: 'error',
    title: 'Base de données abîmée',
    message: 'La base de cette boutique ne peut pas être ouverte.',
    detail: `${dbFile}\n\n${String(error)}\n\n${found ? `Dernière bonne sauvegarde : ${when} (${found.sales} ventes). Les ventes faites depuis seront à ressaisir ; si le PC est relié au serveur central, il les retrouve.` : 'Aucune sauvegarde trouvée dans le dossier « sauvegardes » : choisissez-en une (clé USB, OneDrive…).'}\n\nLa base abîmée est gardée à côté (.abimee) pour le support.`,
    buttons: [...(found ? [`Restaurer la sauvegarde du ${when}`] : []), 'Choisir une sauvegarde…', 'Quitter'],
    defaultId: 0,
    cancelId: found ? 2 : 1,
    noLink: true,
  });
  let file: string | null = null;
  if (found && choice === 0) file = found.file;
  else if (choice === (found ? 1 : 0)) {
    file =
      dialog.showOpenDialogSync({ title: 'Choisir la sauvegarde à restaurer', filters: [{ name: 'Sauvegarde ONIX 360', extensions: ['db'] }], properties: ['openFile'] })?.[0] ?? null;
  }
  if (!file) return false;
  const info = inspectBackup(file);
  if (!info.ok) {
    dialog.showErrorBox('Sauvegarde inutilisable', `${file}\n\n${info.error}`);
    return false;
  }
  try {
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
    restoreDatabase(dbFile, file, `${dbFile}.${stamp}.abimee`);
    return true;
  } catch (e) {
    dialog.showErrorBox('Restauration impossible', String(e));
    return false;
  }
}

void app.whenReady().then(() => {
  // Boutique ouverte : la dernière choisie dans « Ouvrir une boutique », sinon la base du PC.
  const dossiers = createDossiers(app.getPath('userData'), app.getPath('documents'));
  const dbFile = dossiers.startupFile(process.env['SUPERETTE_DB']);
  let services;
  try {
    services = openServices(dbFile);
  } catch (e) {
    // Une boutique illisible (clé retirée, fichier abîmé) ne doit pas empêcher le PC de démarrer sur la sienne.
    if (dbFile !== dossiers.mainFile && !process.env['SUPERETTE_DB']) {
      dialog.showErrorBox('Boutique inaccessible', `${dbFile}\n\n${String(e)}\n\nONIX 360 ouvre la boutique principale de ce PC.`);
      dossiers.remember(dossiers.mainFile);
      app.relaunch();
      app.exit(0);
      return;
    }
    // Base abîmée : on propose la dernière bonne sauvegarde au lieu de laisser le PC sans caisse.
    if (existsSync(dbFile) && recoverFromBackup(dbFile, e)) {
      app.relaunch();
      app.exit(0);
      return;
    }
    app.quit();
    return;
  }
  // Une nouvelle boutique sur ce PC reprend son essai là où il en est, sans le faire recommencer.
  const ownTrial = services.admin.getSetting('license.trialStart');
  const trial = dossiers.shareTrial(ownTrial);
  if (trial && trial !== ownTrial) {
    services.db.prepare("INSERT INTO settings (key, value) VALUES ('license.trialStart', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(trial);
  }
  // Restauration faite juste avant ce démarrage : on la trace dans la base restaurée.
  const marker = `${dbFile}.restauration.json`;
  if (existsSync(marker)) {
    try {
      const done = JSON.parse(readFileSync(marker, 'utf8')) as { userId: string | null };
      services.backups.recordRestore(done.userId, done);
    } catch (e) {
      console.warn('[backup] trace de restauration illisible', e);
    }
    rmSync(marker, { force: true });
  }
  setSyncClientVersion(app.getVersion());
  const sync = createSyncRunner(services);
  const cloudBackup = createCloudBackup(services);
  const updater = createUpdater(services);

  // Sauvegarde automatique : peu après le démarrage, puis selon la fréquence réglée.
  const autoBackup = () => {
    void services.backups
      .runAutomatic()
      // Puis la copie chiffrée sur le serveur, une fois par jour si elle est activée.
      .then(() => cloudBackup.maybeUpload())
      .catch((e) => console.warn('[backup]', e));
    // Copie du comptable dans le dossier partagé, à la fréquence réglée.
    void services.fiches.autoShare(app.getVersion()).catch((e) => console.warn('[partage]', e));
  };
  const backupStart = setTimeout(autoBackup, 60_000);
  // Chaque minute : la sauvegarde du jour, celle de la fréquence réglée (toutes les heures…) et celle de l'heure fixe.
  const backupTimer = setInterval(autoBackup, 60_000);
  const digest = createDigestMailer(services);
  const customerDisplay = createCustomerDisplay();
  // Pointeuses à empreinte par le réseau, et alertes de retard et d'absence du personnel.
  const fingerprint = createFingerprintReceiver(services);
  /** Ferme proprement la boutique ouverte (changement de boutique, restauration, installation). */
  const shutdown = () => {
    customerDisplay.close();
    sync.stop();
    digest.stop();
    fingerprint.stop();
    updater.stop();
    clearTimeout(backupStart);
    clearInterval(backupTimer);
    services.db.close();
  };
  /** Rouvre ONIX 360 sur la boutique retenue, après la réponse à l'écran. */
  const relaunch = () =>
    setTimeout(() => {
      shutdown();
      app.relaunch();
      app.exit(0);
    }, 500);

  const system: SystemHooks = {
    chooseFolder: async (title) => {
      const r = await dialog.showOpenDialog({ title, properties: ['openDirectory', 'createDirectory'] });
      return r.canceled ? null : (r.filePaths[0] ?? null);
    },
    chooseBackupFile: async () => {
      const r = await dialog.showOpenDialog({
        title: 'Choisir la sauvegarde à restaurer',
        defaultPath: services.backups.status().dir ?? undefined,
        filters: [{ name: 'Sauvegarde ONIX 360', extensions: ['db'] }],
        properties: ['openFile'],
      });
      return r.canceled ? null : (r.filePaths[0] ?? null);
    },
    openFolder: async (path) => {
      const error = await shell.openPath(path);
      if (error) throw new AppError(error);
    },
    chooseOpenFile: async (title, name, extensions) => {
      const r = await dialog.showOpenDialog({ title, filters: [{ name, extensions }], properties: ['openFile'] });
      return r.canceled ? null : (r.filePaths[0] ?? null);
    },
    digest: { seal: digest.seal, sendNow: digest.sendNow },
    fingerprint,
    updater,
    customerDisplay,
    restore: (file, userId) => {
      const safetyFile = services.backups.safetyFile();
      const keep = services.backups.localSettings();
      // Laisse partir la réponse à l'écran avant de fermer la base.
      setTimeout(() => {
        shutdown();
        try {
          restoreDatabase(dbFile, file, safetyFile, keep);
          writeFileSync(marker, JSON.stringify({ userId, file, safetyFile, at: new Date().toISOString() }));
        } catch (e) {
          dialog.showErrorBox('Restauration impossible', `${String(e)}\n\nLa base actuelle n'a pas été modifiée.`);
        }
        app.relaunch();
        app.exit(0);
      }, 500);
    },
    dossiers: {
      file: dbFile,
      dir: dossiers.dir,
      list: () => dossiers.list(dbFile),
      open: (file) => {
        dossiers.remember(file);
        relaunch();
      },
      create: (name) => {
        const file = dossiers.newFile(name);
        dossiers.remember(file);
        relaunch();
        return file;
      },
      forget: (file) => dossiers.forget(file, dbFile),
      importFile: (file) => dossiers.importFile(file),
      chooseFile: async (title) => {
        const r = await dialog.showOpenDialog({
          title,
          filters: [
            { name: 'Fiche ONIX 360', extensions: ['fedonix', 'fedonixz'] },
            { name: 'Base ONIX 360', extensions: ['db'] },
          ],
          properties: ['openFile'],
        });
        return r.canceled ? null : (r.filePaths[0] ?? null);
      },
      install: (file) => {
        setTimeout(() => {
          shutdown();
          try {
            installFiche(dbFile, file);
          } catch (e) {
            dialog.showErrorBox('Installation impossible', `${String(e)}\n\nRien n'a été modifié sur ce PC.`);
          }
          app.relaunch();
          app.exit(0);
        }, 500);
      },
    },
  };
  // Les bons de caisse et rapports s'impriment dans la langue de l'utilisateur connecté.
  const api = createApi(services, createPrinter(services, () => api['prefs.lang']()), sync, app.getVersion(), system);

  ipcMain.handle('api', async (_event, name: ApiName, args: unknown[]) => {
    const fn = api[name] as ((...a: unknown[]) => unknown) | undefined;
    if (typeof fn !== 'function') return { ok: false, error: { message: `Action inconnue : ${String(name)}`, code: 'UNKNOWN' } };
    try {
      return { ok: true, data: await fn(...args) };
    } catch (e) {
      if (e instanceof AppError) return { ok: false, error: { message: e.message, code: e.code, fixes: fixesFor(e) } };
      console.error(`[api] ${String(name)}`, e);
      return { ok: false, error: { message: e instanceof Error ? e.message : String(e), code: 'INTERNAL' } };
    }
  });

  mainWindow = createWindow();
  // L'afficheur client ne garde pas l'application ouverte quand la caisse se ferme.
  mainWindow.on('closed', () => {
    mainWindow = null;
    customerDisplay.close();
  });

  app.on('before-quit', () => {
    if (services.db.open) shutdown();
  });
});

app.on('second-instance', () => {
  const win = mainWindow;
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

app.on('window-all-closed', () => app.quit());
