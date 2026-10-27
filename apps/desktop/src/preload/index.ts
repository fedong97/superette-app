import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('superette', {
  invoke: (name: string, args: unknown[]) => ipcRenderer.invoke('api', name, args),
  /** Touche gardée par le logiciel avant Electron (F11) ; renvoie de quoi arrêter d'écouter. */
  onShortcut: (cb: (key: string) => void) => {
    const listener = (_e: unknown, key: string) => cb(key);
    ipcRenderer.on('shortcut', listener);
    return () => ipcRenderer.removeListener('shortcut', listener);
  },
});
