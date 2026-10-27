import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { type Page, expect, test } from '@playwright/test';
import { createStore, invoke, launch } from './app';

/** Captures de la nouvelle organisation des menus : dans CAPTURES s'il est donné, sinon avec les résultats des tests. */
const SHOTS = process.env.CAPTURES ?? join(__dirname, '../../../test-results/captures-nouveaux-menus');

async function shot(page: Page, name: string) {
  mkdirSync(SHOTS, { recursive: true });
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

async function railMenu(page: Page, name: string) {
  await page.keyboard.press('Escape');
  const btn = name === 'Réglages' ? page.locator('nav.rail .rail-item', { hasText: name }) : page.locator(`nav.rail .rail-item[title="${name}"]`);
  await btn.first().click();
  await expect(page.locator('.menu-drop')).toBeVisible();
}

async function loginAs(page: Page, login: string, pin: string) {
  await invoke(page, 'auth.logout');
  await invoke(page, 'auth.login', login, pin);
  await page.reload();
  await page.waitForTimeout(1500);
  const compris = page.getByRole('button', { name: 'Compris' });
  if (await compris.count()) await compris.first().click();
}

test('menus rangés par métier, onglets du haut selon le rôle', async () => {
  const { app, page, errors } = await launch();
  await page.setViewportSize({ width: 1600, height: 960 });
  try {
    await createStore(page);
    const [store] = await invoke<{ id: string }[]>(page, 'admin.stores');
    const [register] = await invoke<{ id: string }[]>(page, 'admin.registers', store!.id);
    await invoke(page, 'admin.createUser', { name: 'Awa', login: 'awa', pin: '5555', role: 'cashier', storeId: store!.id, registerId: register!.id });
    await invoke(page, 'admin.createUser', { name: 'Paul', login: 'paul', pin: '6666', role: 'stock', storeId: store!.id });

    await shot(page, '01-accueil-gerant');
    for (const [n, menu] of [['02', 'Vente'], ['03', 'Trésorerie'], ['04', 'Stock'], ['05', 'Articles'], ['06', 'Achats'], ['06b', 'Fournisseurs'], ['07', 'Clients'], ['08', 'Suivi'], ['09', 'Comptabilité'], ['09b', 'Fiscalité'], ['10', 'Réglages']] as const) {
      await railMenu(page, menu);
      await shot(page, `${n}-menu-${menu.toLowerCase()}`);
    }
    await page.keyboard.press('Escape');
    await page.locator('nav.rail .rail-item', { hasText: 'Tous les menus' }).click();
    await shot(page, '11-tous-les-menus');
    await page.mouse.wheel(0, 900);
    await shot(page, '12-tous-les-menus-suite');
    await page.keyboard.press('Escape');
    await page.locator('.side-user').click();
    await shot(page, '13-pastille-utilisateur');

    await loginAs(page, 'awa', '5555');
    await page.locator('.topbar').waitFor();
    await shot(page, '14-caissier');
    await railMenu(page, 'Vente');
    await shot(page, '15-caissier-menu-vente');

    await loginAs(page, 'paul', '6666');
    await shot(page, '16-magasinier');
    await railMenu(page, 'Stock');
    await shot(page, '17-magasinier-menu-stock');
    // Petit écran : le menu passe sur deux colonnes au lieu de défiler.
    await page.locator('nav.rail .rail-item[title="Stock"]').click();
    await page.setViewportSize({ width: 1366, height: 680 });
    await railMenu(page, 'Stock');
    await shot(page, '18-petit-ecran-menu-en-colonnes');
    expect(errors).toEqual([]);
  } finally {
    await app.close();
  }
});
