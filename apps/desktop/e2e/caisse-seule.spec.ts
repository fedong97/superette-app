import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { type Page, expect, test } from '@playwright/test';
import { createStore, invoke, launch } from './app';

/** Captures du mode « Caisse seule » : dans CAPTURES s'il est donné, sinon avec les résultats des tests. */
const SHOTS = process.env.CAPTURES ?? join(__dirname, '../../../test-results/captures-caisse-seule');

async function shot(page: Page, name: string) {
  mkdirSync(SHOTS, { recursive: true });
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

async function loginAs(page: Page, login: string, pin: string) {
  await invoke(page, 'auth.logout');
  await invoke(page, 'auth.login', login, pin);
  await page.reload();
  await page.waitForTimeout(1500);
  const compris = page.getByRole('button', { name: 'Compris' });
  if (await compris.count()) await compris.first().click();
}

const front = (page: Page) => page.locator('main.windows > section.mdi.active');

test('caisse seule : plein écran à la demande ou dès la connexion selon le rôle, une caisse à l’autre', async () => {
  const { app, page, errors } = await launch();
  await page.setViewportSize({ width: 1500, height: 860 });
  const fullScreen = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isFullScreen());
  try {
    await createStore(page);
    const [store] = await invoke<{ id: string }[]>(page, 'admin.stores');
    const [register] = await invoke<{ id: string }[]>(page, 'admin.registers', store!.id);
    await invoke(page, 'admin.createUser', { name: 'Awa', login: 'awa', pin: '5555', role: 'cashier', storeId: store!.id, registerId: register!.id });
    const vat = (await invoke<{ id: string }[]>(page, 'admin.vatRates'))[0]!;
    const art = await invoke<{ id: string }>(page, 'catalogue.save', { name: 'Dolait carton', unit: 'piece', vatRateId: vat.id, purchasePrice: 4000, salePrice: 4500, barcodes: [{ code: '6001234567899' }] });
    const wh = (await invoke<{ id: string }[]>(page, 'admin.warehouses'))[0]!;
    await invoke(page, 'stock.receive', { warehouseId: wh.id, lines: [{ articleId: art.id, qty: 100, unitCost: 4000 }] });
    await invoke(page, 'treasury.open', 0, undefined, register!.id);

    // Affichage habituel : menus, onglets, et le bouton ⛶ dans la barre verte de la fiche.
    await page.getByRole('button', { name: 'V. cash 1', exact: true }).click();
    await expect(page.locator('nav.rail')).toBeVisible();
    await shot(page, '01-affichage-habituel');

    await front(page).locator('.mdi-full').click();
    await expect(page.locator('nav.rail')).toBeHidden();
    await expect(page.locator('.topbar')).toBeHidden();
    await expect(page.locator('.statusbar')).toBeVisible();
    await expect(front(page).locator('.mdi-min')).toHaveCount(0);
    await expect.poll(fullScreen).toBe(true);
    const scan = page.getByPlaceholder(/code-barres|scanner/).first();
    await scan.fill('6001234567899');
    await scan.press('Enter');
    await shot(page, '02-caisse-seule');

    // On passe à V. cash 2 sans quitter le plein écran.
    await front(page).locator('.pos-switch').getByRole('button', { name: 'V. cash 2' }).click();
    await expect(front(page).locator('.mdi-title')).toContainText('2');
    await expect(page.locator('nav.rail')).toBeHidden();
    await shot(page, '03-caisse-seule-v-cash-2');

    // F11 ramène l'affichage habituel.
    await page.keyboard.press('F11');
    await expect(page.locator('nav.rail')).toBeVisible();
    await expect.poll(fullScreen).toBe(false);

    // Le gérant coche « Caissier » : Awa arrive directement en caisse seule.
    await page.locator('nav.rail .rail-item', { hasText: 'Réglages' }).first().click();
    await page.locator('.menu-drop').getByRole('button', { name: 'Paramètres', exact: true }).click();
    await page.getByPlaceholder(/Chercher/).first().fill('caisse seule').catch(() => undefined);
    const row = page.getByText('Mode Caisse seule (plein écran) dès la connexion').first();
    await row.scrollIntoViewIfNeeded();
    await shot(page, '04-parametre-par-role');
    await invoke(page, 'admin.saveStoreSettings', { posFullRoles: 'cashier' });

    await loginAs(page, 'awa', '5555');
    await expect(front(page).locator('.mdi-full.on')).toBeVisible();
    await expect(page.locator('nav.rail')).toBeHidden();
    await expect.poll(fullScreen).toBe(true);
    await shot(page, '05-caissier-arrive-en-caisse-seule');
    expect(errors).toEqual([]);
  } finally {
    await app.close();
  }
});
