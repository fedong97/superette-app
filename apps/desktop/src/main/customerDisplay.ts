import { execFile } from 'node:child_process';
import { closeSync, openSync, writeSync } from 'node:fs';
import { type CustomerDisplayMode, type CustomerDisplayState, formatFcfa, vfdFrame, vfdLines } from '@superette/core';
import { BrowserWindow, screen } from 'electron';

/** Réglages de l'afficheur de ce PC (Administration › Paramètres, section du poste). */
export interface CustomerDisplaySettings {
  mode: CustomerDisplayMode;
  /** Deuxième écran : numéro de l'écran dans Windows (2 par défaut). */
  screen: number;
  /** Afficheur VFD : port série (COM3) et vitesse. */
  port: string;
  baud: number;
  columns: number;
  /** Message d'accueil, avec le nom et le logo du magasin. */
  welcome: string;
  storeName: string;
  logo: string | null;
}

export interface CustomerDisplay {
  show(state: CustomerDisplayState, settings: CustomerDisplaySettings): void;
  /** Écrans branchés au PC, pour choisir celui du client. */
  screens(): { index: number; label: string; primary: boolean }[];
  close(): void;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const money = (v: number) => formatFcfa(v);

/** Page du deuxième écran : grands chiffres lisibles de loin, aux couleurs d’ONIX 360. */
const PAGE = `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Afficheur client</title><style>
  html, body { margin: 0; height: 100%; font-family: 'Segoe UI', Arial, sans-serif; background: #0f3d3a; color: #fff; overflow: hidden; }
  body { display: flex; flex-direction: column; }
  header { display: flex; align-items: center; gap: 24px; padding: 24px 40px; background: #fff; color: #0f3d3a; }
  header img { max-height: 90px; max-width: 260px; }
  header h1 { margin: 0; font-size: 40px; }
  main { flex: 1; display: flex; flex-direction: column; padding: 32px 40px; gap: 24px; min-height: 0; }
  .welcome { flex: 1; display: flex; align-items: center; justify-content: center; text-align: center; font-size: 64px; font-weight: 700; }
  .last { background: #145c56; border-radius: 16px; padding: 24px 32px; display: flex; justify-content: space-between; align-items: baseline; font-size: 44px; }
  .last .name { font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-right: 24px; }
  .lines { flex: 1; overflow: hidden; font-size: 28px; display: flex; flex-direction: column; justify-content: flex-end; }
  .lines div { display: flex; justify-content: space-between; padding: 6px 0; border-bottom: 1px solid rgba(255,255,255,.15); }
  .lines .q { opacity: .75; margin-right: 16px; }
  .total { display: flex; justify-content: space-between; align-items: baseline; font-size: 72px; font-weight: 800; color: #ffd84d; }
  .savings { font-size: 30px; color: #9be7c4; text-align: right; }
  .paid { flex: 1; display: grid; grid-template-columns: 1fr auto; align-content: center; gap: 24px 48px; font-size: 56px; }
  .paid .change { color: #ffd84d; font-weight: 800; font-size: 88px; }
  .r { text-align: right; white-space: nowrap; }
</style></head><body><header id="head"></header><main id="main"></main>
<script>
  window.render = function (head, main) {
    if (head !== null) document.getElementById('head').innerHTML = head;
    document.getElementById('main').innerHTML = main;
  };
</script></body></html>`;

function body(state: CustomerDisplayState, s: CustomerDisplaySettings): string {
  switch (state.kind) {
    case 'idle':
      return `<div class="welcome">${esc(s.welcome || 'Bienvenue')}</div>`;
    case 'cart':
      return `${state.last ? `<div class="last"><span class="name">${esc(state.last.name)}</span><span class="r">${state.last.qty !== '1' ? `${esc(state.last.qty)} · ` : ''}${money(state.last.amount)}</span></div>` : ''}
        <div class="lines">${state.lines
          .slice(-8)
          .map((l) => `<div><span><span class="q">${esc(l.qty)}</span>${esc(l.name)}</span><span class="r">${money(l.amount)}</span></div>`)
          .join('')}</div>
        ${state.savings ? `<div class="savings">Vous économisez ${money(state.savings)}</div>` : ''}
        <div class="total"><span>TOTAL</span><span class="r">${money(state.total)}</span></div>`;
    case 'paid':
      return `<div class="paid"><span>Total</span><span class="r">${money(state.total)}</span><span>Reçu</span><span class="r">${money(state.paid)}</span>
        <span class="change">Monnaie</span><span class="r change">${money(state.change)}</span></div>`;
  }
}

/**
 * Afficheur client du PC de caisse. Le deuxième écran est une fenêtre sans
 * bord, plein écran sur l'écran choisi ; l'afficheur VFD reçoit ses deux
 * lignes par le port série. Une panne de l'afficheur ne gêne jamais la vente.
 */
export function createCustomerDisplay(): CustomerDisplay {
  let win: BrowserWindow | null = null;
  let ready: Promise<void> | null = null;
  let configuredPort = '';
  let last = '';
  let shownHead = '';

  const ensureWindow = (index: number): Promise<void> => {
    const displays = screen.getAllDisplays();
    const target = displays[index - 1] ?? displays.find((d) => d.id !== screen.getPrimaryDisplay().id) ?? displays[0]!;
    if (win && !win.isDestroyed()) {
      const b = win.getBounds();
      if (b.x !== target.bounds.x || b.y !== target.bounds.y) win.setBounds(target.bounds);
      return ready!;
    }
    win = new BrowserWindow({
      ...target.bounds,
      frame: false,
      focusable: false,
      skipTaskbar: true,
      show: false,
      backgroundColor: '#0f3d3a',
      title: 'Afficheur client',
      webPreferences: { sandbox: true, contextIsolation: true },
    });
    win.setMenu(null);
    ready = win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(PAGE)}`).then(() => {
      win?.showInactive();
      win?.setFullScreen(true);
    });
    win.on('closed', () => {
      win = null;
      ready = null;
    });
    return ready;
  };

  const writeVfd = (state: CustomerDisplayState, s: CustomerDisplaySettings) => {
    if (process.platform !== 'win32' || !/^COM\d{1,3}$/i.test(s.port)) return;
    const frame = vfdFrame(vfdLines(state, s.columns, s.welcome || s.storeName));
    const send = () => {
      try {
        const fd = openSync(`\\\\.\\${s.port.toUpperCase()}`, 'w');
        try {
          writeSync(fd, frame);
        } finally {
          closeSync(fd);
        }
      } catch (e) {
        console.warn('[afficheur] port', s.port, e);
      }
    };
    const key = `${s.port}:${s.baud}`;
    if (configuredPort === key) return send();
    // Vitesse du port réglée une fois par Windows (mode COM3 BAUD=9600 …), puis envoi.
    execFile('mode', [s.port.toUpperCase(), `BAUD=${s.baud}`, 'PARITY=N', 'DATA=8', 'STOP=1'], { windowsHide: true }, () => {
      configuredPort = key;
      send();
    });
  };

  return {
    show(state, s) {
      const key = JSON.stringify([state, s.mode, s.screen, s.port, s.baud, s.columns, s.welcome, s.storeName, s.logo?.length ?? 0]);
      if (key === last) return;
      last = key;
      if (s.mode === 'off') {
        win?.destroy();
        return;
      }
      if (s.mode === 'vfd') {
        win?.destroy();
        writeVfd(state, s);
        return;
      }
      const head = `${s.logo ? `<img src="${esc(s.logo)}">` : ''}<h1>${esc(s.storeName)}</h1>`;
      const fresh = !win || win.isDestroyed();
      void ensureWindow(s.screen)
        .then(() => {
          // Le logo ne repart pas à chaque article scanné.
          const sendHead = fresh || head !== shownHead;
          shownHead = head;
          return win?.webContents.executeJavaScript(`window.render(${sendHead ? JSON.stringify(head) : 'null'}, ${JSON.stringify(body(state, s))})`);
        })
        .catch((e) => console.warn('[afficheur] écran', e));
    },
    screens() {
      const primary = screen.getPrimaryDisplay().id;
      return screen.getAllDisplays().map((d, i) => ({ index: i + 1, label: `Écran ${i + 1} (${d.size.width} × ${d.size.height})`, primary: d.id === primary }));
    },
    close() {
      win?.destroy();
    },
  };
}
