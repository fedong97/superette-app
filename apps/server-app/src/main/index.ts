import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { BrowserWindow, Menu, Tray, app, dialog, nativeImage, shell } from 'electron';
import { createApp } from '../../../server/src/app';

/**
 * FEDONIX 360 Serveur : le serveur central dans une application Windows.
 * La base est intégrée (dossier %APPDATA%\FEDO Serveur\donnees), l'interface s'ouvre
 * dans une fenêtre, et le serveur continue de tourner, icône près de l'horloge,
 * quand la fenêtre est fermée.
 */

interface Reglages {
  port: number;
  /** Premier démarrage fait : démarrage avec Windows déjà proposé. */
  configure?: boolean;
  /** Démarrage avec Windows coupé à la main depuis l'icône. */
  sansDemarrageAuto?: boolean;
}

// Le serveur s'appelait « FEDO Serveur » : on garde son dossier (%APPDATA%\FEDO Serveur)
// pour que la base, les réglages et le mot de passe soient retrouvés après la mise à jour.
app.setPath('userData', join(app.getPath('appData'), 'FEDO Serveur'));

const HIDDEN_ARG = '--en-arriere-plan';

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let server: INestApplication | null = null;
let quitting = false;
let hintShown = false;
const localToken = randomBytes(24).toString('base64url');

const reglagesFile = () => join(app.getPath('userData'), 'reglages.json');

function readReglages(): Reglages {
  try {
    return { port: 3000, ...JSON.parse(readFileSync(reglagesFile(), 'utf8')) };
  } catch {
    return { port: 3000 };
  }
}

function writeReglages(r: Reglages) {
  mkdirSync(app.getPath('userData'), { recursive: true });
  writeFileSync(reglagesFile(), JSON.stringify(r, null, 2));
}

const icon = () => nativeImage.createFromPath(join(__dirname, process.platform === 'win32' ? 'icon.ico' : 'icon.png'));

function backupDir() {
  return join(app.getPath('documents'), 'FEDO Serveur', 'Sauvegardes');
}

function showWindow(port: number) {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    return;
  }
  win = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 760,
    minHeight: 560,
    title: 'FEDONIX 360 Serveur',
    icon: icon(),
    autoHideMenuBar: true,
    backgroundColor: '#f4f5f7',
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true },
  });
  win.once('ready-to-show', () => win?.show());
  // Les liens (téléchargement d'une sauvegarde mis à part) s'ouvrent dans le navigateur.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    win?.hide();
    if (!hintShown && tray && process.platform === 'win32') {
      hintShown = true;
      tray.displayBalloon({
        title: 'FEDONIX 360 Serveur continue de tourner',
        content: "Les PC du magasin restent synchronisés. Cliquez sur l'icône près de l'horloge pour rouvrir la fenêtre.",
        iconType: 'info',
      });
    }
  });
  win.on('closed', () => (win = null));
  void win.loadURL(`http://127.0.0.1:${port}/?t=${localToken}`);
}

async function quit() {
  const answer = await dialog.showMessageBox({
    type: 'warning',
    buttons: ['Arrêter le serveur', 'Annuler'],
    defaultId: 1,
    cancelId: 1,
    title: 'FEDONIX 360 Serveur',
    message: 'Arrêter le serveur ?',
    detail: "Les PC continueront de vendre, mais ne se synchroniseront plus jusqu'au prochain démarrage de FEDONIX 360 Serveur.",
  });
  if (answer.response !== 0) return;
  quitting = true;
  app.quit();
}

function buildTray(port: number) {
  tray = new Tray(icon());
  tray.setToolTip(`FEDONIX 360 Serveur : en marche (port ${port})`);
  const menu = () =>
    Menu.buildFromTemplate([
      { label: 'Ouvrir FEDONIX 360 Serveur', click: () => showWindow(port) },
      { label: 'Ouvrir dans le navigateur', click: () => void shell.openExternal(`http://localhost:${port}/`) },
      { label: 'Dossier des sauvegardes', click: () => void shell.openPath(backupDir()) },
      { type: 'separator' },
      {
        label: 'Démarrer avec Windows',
        type: 'checkbox',
        checked: app.getLoginItemSettings().openAtLogin,
        click: (item) => {
          app.setLoginItemSettings({ openAtLogin: item.checked, args: [HIDDEN_ARG] });
          writeReglages({ ...readReglages(), sansDemarrageAuto: !item.checked });
          tray?.setContextMenu(menu());
        },
      },
      { type: 'separator' },
      { label: 'Arrêter le serveur et quitter', click: () => void quit() },
    ]);
  tray.setContextMenu(menu());
  tray.on('click', () => showWindow(port));
}

async function start() {
  const reglages = readReglages();
  const dataDir = join(app.getPath('userData'), 'donnees');
  mkdirSync(backupDir(), { recursive: true });
  try {
    server = await createApp({
      dataDir,
      backupDir: backupDir(),
      port: reglages.port,
      localAdminToken: localToken,
      version: app.getVersion(),
    });
    await server.listen(reglages.port, '0.0.0.0');
  } catch (e) {
    const busy = (e as { code?: string }).code === 'EADDRINUSE';
    dialog.showErrorBox(
      'FEDONIX 360 Serveur ne peut pas démarrer',
      busy
        ? `Le port ${reglages.port} est déjà utilisé : un autre serveur FEDO tourne peut-être déjà sur ce PC.\n\nPour changer de port, modifiez ${reglagesFile()}.`
        : `${e instanceof Error ? e.message : String(e)}\n\nDossier de la base : ${dataDir}`,
    );
    quitting = true;
    app.exit(1);
    return;
  }
  // Premier démarrage : le serveur repart tout seul avec Windows.
  if (!reglages.configure) {
    app.setLoginItemSettings({ openAtLogin: true, args: [HIDDEN_ARG] });
    writeReglages({ ...reglages, configure: true });
  } else if (!existsSync(reglagesFile())) {
    writeReglages(reglages);
  } else if (!reglages.sansDemarrageAuto && !app.getLoginItemSettings({ args: [HIDDEN_ARG] }).openAtLogin) {
    // L'exécutable a changé de nom (« FEDO Serveur.exe » devenu « FEDONIX 360 Serveur.exe ») :
    // l'ancienne entrée de démarrage pointe vers un fichier supprimé, on la refait.
    app.setLoginItemSettings({ openAtLogin: true, args: [HIDDEN_ARG] });
  }
  buildTray(reglages.port);
  if (!process.argv.includes(HIDDEN_ARG)) showWindow(reglages.port);
}

// Une seule instance : la base intégrée n'accepte qu'un serveur à la fois.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow(readReglages().port));
  app.on('window-all-closed', () => {
    // Le serveur continue sans fenêtre.
  });
  app.on('before-quit', (e) => {
    if (!server) return;
    quitting = true;
    e.preventDefault();
    const s = server;
    server = null;
    void s
      .close()
      .catch((err) => console.warn('[arrêt]', err))
      .finally(() => app.exit(0));
  });
  void app.whenReady().then(start);
}
