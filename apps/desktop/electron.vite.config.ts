import { resolve } from 'node:path';
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
    build: {
      rollupOptions: {
        // mobile.html : les écrans de gestion du PC dans ONIX 360 Mobile (téléphone du gérant).
        input: { index: resolve(__dirname, 'src/renderer/index.html'), mobile: resolve(__dirname, 'src/renderer/mobile.html') },
      },
    },
  },
});
