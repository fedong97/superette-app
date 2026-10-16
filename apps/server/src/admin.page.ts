import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Page de l'interface du serveur (une seule page, sans bibliothèque). */
export const ADMIN_PAGE = readFileSync(join(__dirname, 'admin.page.html'), 'utf8');

/** Page du gérant, faite pour le téléphone et installable comme une application. */
export const MANAGER_PAGE = readFileSync(join(__dirname, 'manager.page.html'), 'utf8');

let icon: Buffer | null | undefined;
/** Icône de l'application du gérant : celle de FEDONIX 360 Serveur. */
export function MANAGER_ICON(): Buffer | null {
  if (icon === undefined) {
    const file = [join(__dirname, 'icon.png'), join(__dirname, '..', '..', 'server-app', 'build', 'icon.png')].find((f) => existsSync(f));
    icon = file ? readFileSync(file) : null;
  }
  return icon;
}
