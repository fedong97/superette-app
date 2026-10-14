import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Page de l'interface du serveur (une seule page, sans bibliothèque). */
export const ADMIN_PAGE = readFileSync(join(__dirname, 'admin.page.html'), 'utf8');
