import { expect, test } from '@playwright/test';
import { createStore, invoke, launch } from './app';

test('les couleurs de l’entreprise et le badge se règlent dans Administration', async () => {
  test.setTimeout(120_000);
  const { app, page, errors } = await launch();
  try {
    await createStore(page);
    const items = page.locator('nav.rail .rail-item');
    await expect(items.first()).toBeVisible();
    const drop = page.locator('.menu-drop');
    let found = false;
    for (let m = 0; m < (await items.count()) && !found; m++) {
      if (/Tous les menus|Personnaliser/.test(await items.nth(m).innerText())) continue;
      await items.nth(m).click();
      if (!(await drop.waitFor({ timeout: 1500 }).then(() => true, () => false))) continue;
      const b = drop.getByRole('button', { name: 'Couleurs et badges' });
      if (await b.count()) { await b.first().click(); found = true; } else { await page.keyboard.press('Escape'); await page.mouse.click(700, 790); }
    }
    expect(found).toBe(true);
    await expect(page.locator('iframe.badge-frame')).toBeVisible();
    await page.getByRole('button', { name: 'Rouge' }).click();
    await page.getByLabel('Modèle').selectOption('arc');
    await page.getByText('Imprimer aussi le verso').click();
    await page.waitForTimeout(800);
    await page.getByRole('button', { name: 'Enregistrer' }).click();
    await page.waitForTimeout(800);
    const set = await invoke<{ brandColor: string; badge: { model: string } }>(page, 'admin.storeSettings');
    expect(set.brandColor).toBe('#c62828');
    expect(set.badge.model).toBe('arc');
    await page.getByRole('button', { name: 'Utilisateurs', exact: true }).click();
    await page.getByRole('cell', { name: 'Gérant Test', exact: true }).click();
    await expect(page.getByText('Prendre une photo')).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await app.close();
  }
});
