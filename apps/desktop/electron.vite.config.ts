import react from '@vitejs/plugin-react';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';

// Les paquets @superette/* (TypeScript) sont intégrés au bundle ; seules les
// dépendances natives ou d'exécution (better-sqlite3, electron-updater) restent externes.
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
  },
  renderer: {
    plugins: [react()],
  },
});
