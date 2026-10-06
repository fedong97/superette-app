import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('superette', {
  invoke: (name: string, args: unknown[]) => ipcRenderer.invoke('api', name, args),
});
