import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { type ElectronApplication, type Page, _electron as electron } from '@playwright/test';

/** Lance FEDONIX 360 sur une base neuve, dans un dossier temporaire (réglages et langue du PC compris). */
export async function launch(): Promise<{ app: ElectronApplication; page: Page; errors: string[] }> {
  const dir = mkdtempSync(join(tmpdir(), 'fedonix-ecrans-'));
  const app = await electron.launch({
    args: [resolve(__dirname, '..'), '--no-sandbox'],
    env: { ...process.env, SUPERETTE_DB: join(dir, 'ecrans.db'), APPDATA: dir, HOME: dir, XDG_CONFIG_HOME: dir },
  });
  const page = await app.firstWindow();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  return { app, page, errors };
}

/** Crée le magasin DLA1 avec le modèle Superette et ferme le guide de démarrage (gérant admin / 1234). */
export async function createStore(page: Page) {
  await page.getByLabel('Code magasin').fill('DLA1');
  await page.getByLabel('Nom du magasin').fill('Superette Test');
  await page.getByLabel('Métier').selectOption({ label: 'Superette / alimentation générale' });
  await page.getByLabel('Nom complet').fill('Gérant Test');
  await page.getByLabel('Identifiant').fill('admin');
  await page.getByLabel(/^Code secret/).fill('1234');
  await page.getByLabel('Confirmer le code').fill('1234');
  await page.getByRole('button', { name: 'Créer le magasin' }).click();
  await page.getByRole('button', { name: 'Compris' }).click();
}

/** Appelle l'API de l'application comme le fait l'interface. */
export async function invoke<T = unknown>(page: Page, name: string, ...args: unknown[]): Promise<T> {
  const res = await page.evaluate(([n, a]) => (window as any).superette.invoke(n, a), [name, args] as const);
  if (!res.ok) throw new Error(`${name} : ${res.error.message}`);
  return res.data as T;
}
