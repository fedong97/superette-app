// Liste des actions du PC impossibles depuis le téléphone du gérant (« le PC sur le
// téléphone ») : celles qui ouvrent une fenêtre, un dossier ou une imprimante de ce PC,
// changent sa connexion, ses fichiers ou sa session. Régénérée par :
//   node apps/desktop/scripts/remote-blocked.mjs
// et vérifiée par le test remoteBlocked.test.ts.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const here = dirname(fileURLToPath(import.meta.url));
const API = join(here, '../src/main/api.ts');
const OUT = join(here, '../src/main/remoteBlocked.ts');

/** Ce qui touche à ce PC : fenêtres de choix, dossiers, imprimante, mise à jour, afficheur, empreinte. */
const LOCAL = /\b(chooseFile|chooseOpenFile|chooseFolder|chooseSaveFile|system\.(chooseFolder|chooseOpenFile|chooseBackupFile|openFolder|restore|updater|fullScreen|customerDisplay|fingerprint|dossiers|quit|relaunch)|printer\.)/;
/** Familles réservées au poste lui-même : session, fenêtre, sauvegardes, fiches, licence, liaison au serveur… */
const PREFIX = /^(auth|window|update|backup|fiche|dossier|reset|repair|license|kiosk|takeover|setup|display|fingerprint|sync|relay|stations|training)\./;
const NAMES = new Set(['attendance.leave']);
/** Lectures sans effet sur le poste, malgré un mot qui ressemble (dossier ouvert, afficheur…). */
const ALLOW = new Set(['app.state']);

export function computeBlocked(source = readFileSync(API, 'utf8')) {
  const sf = ts.createSourceFile(API, source, ts.ScriptTarget.Latest, true);
  const out = [];
  const visit = (n) => {
    if (ts.isVariableDeclaration(n) && n.name.getText(sf) === 'api' && n.initializer && ts.isObjectLiteralExpression(n.initializer)) {
      for (const p of n.initializer.properties) {
        if (!p.name) continue;
        const name = p.name.getText(sf).replace(/^['"]|['"]$/g, '');
        if (ALLOW.has(name)) continue;
        if (PREFIX.test(name) && name !== 'auth.checkSupervisor') out.push(name);
        else if (NAMES.has(name) || LOCAL.test(p.getText(sf))) out.push(name);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return [...new Set(out)].sort();
}

export const render = (list) =>
  `// Généré par apps/desktop/scripts/remote-blocked.mjs : ne pas modifier à la main.\n` +
  `/** Actions du PC impossibles depuis le téléphone du gérant (fenêtres, dossiers, imprimante, session de ce poste…). */\n` +
  `export const REMOTE_BLOCKED: ReadonlySet<string> = new Set([\n${list.map((n) => `  '${n}',`).join('\n')}\n]);\n`;

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const list = computeBlocked();
  writeFileSync(OUT, render(list));
  console.log(`${list.length} actions réservées au PC`);
}
