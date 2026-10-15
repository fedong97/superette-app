import { Controller, Get, Header } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Logo et icône du serveur (le logo de l'application avec un serveur devant), lus une fois au démarrage. */
const assets = join(__dirname, '..', 'assets');
const read = (file: string) => {
  try {
    return readFileSync(join(assets, file));
  } catch {
    return null;
  }
};
const logo = read('logo.png');
const icon = read('icon.ico');

/** Page d'accueil du serveur : ouverte dans un navigateur, elle montre que le serveur tourne. */
@Controller()
export class StatusController {
  @Get()
  @Header('Content-Type', 'text/html; charset=utf-8')
  home() {
    const img = logo ? `<img src="data:image/png;base64,${logo.toString('base64')}" alt="" width="160" height="160">` : '';
    return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>FEDONIX 360 Serveur</title>
<link rel="icon" href="/favicon.ico"></head>
<body style="font-family:system-ui,sans-serif;background:#f4f5f7;color:#13241d;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">
<div style="text-align:center">${img}<h1 style="margin:8px 0 4px">FEDONIX 360 Serveur</h1>
<p style="color:#1f7a5c;font-weight:700">Le serveur central est en marche.</p></div></body></html>`;
  }

  @Get('favicon.ico')
  @Header('Content-Type', 'image/x-icon')
  favicon() {
    return icon ?? Buffer.alloc(0);
  }
}
