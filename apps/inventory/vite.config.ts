import { readFileSync } from 'node:fs';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

// Pages servies depuis le téléphone (Capacitor) : chemins relatifs.
// Essai dans un navigateur : `FEDONIX_SERVER=http://localhost:3000 npm run dev`, puis relier avec l'adresse de la page.
export default defineConfig({
  base: './',
  plugins: [react()],
  server: process.env['FEDONIX_SERVER'] ? { proxy: { '/api': process.env['FEDONIX_SERVER'] } } : undefined,
  define: { __APP_VERSION__: JSON.stringify(version) },
  build: { outDir: 'dist', target: 'es2020' },
});
