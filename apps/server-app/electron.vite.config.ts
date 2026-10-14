import { defineConfig, externalizeDepsPlugin } from 'electron-vite';

// Le code du serveur (apps/server) est intégré au bundle ; NestJS, PGlite et pg restent
// dans node_modules (dépendances d'exécution).
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
  },
});
