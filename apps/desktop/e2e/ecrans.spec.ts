import { type Page, expect, test } from '@playwright/test';
import { createStore, launch } from './app';

/** Entrées de menu qui ferment la session ou l'application, ou appellent le serveur : pas ouvertes ici. */
const SKIP = /Quitter|Changer d'utilisateur|Déconnexion|Fermer la session|Synchroniser/i;

/** Ferme les fenêtres de dialogue restées ouvertes. */
async function dismiss(page: Page) {
  for (let i = 0; i < 3; i++) await page.keyboard.press('Escape');
  await page.mouse.click(700, 790);
}

test('la roulette fait défiler chaque menu ouvert sans le fermer', async () => {
  const { app, page } = await launch();
  try {
    await createStore(page);
    const items = page.locator('nav.rail .rail-item');
    const drop = page.locator('.menu-drop');
    // La barre verte s'affiche après la fermeture du guide de démarrage.
    await expect(items.first()).toBeVisible();
    let scrolled = 0;
    for (let m = 0; m < (await items.count()); m++) {
      const name = (await items.nth(m).innerText()).split('\n').pop()!.trim();
      if (/Tous les menus|Personnaliser/.test(name)) continue;
      await items.nth(m).click();
      if (!(await drop.waitFor({ timeout: 2000 }).then(() => true, () => false))) continue;
      await page.waitForTimeout(150);
      if (await drop.evaluate((d) => d.scrollHeight > d.clientHeight + 4)) {
        const box = (await drop.boundingBox())!;
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.wheel(0, 400);
        await page.waitForTimeout(250);
        await expect(drop, `menu ${name} fermé par la roulette`).toBeVisible();
        expect(await drop.evaluate((d) => d.scrollTop), `menu ${name} n'a pas défilé`).toBeGreaterThan(0);
        scrolled++;
      }
      await page.keyboard.press('Escape');
      await page.mouse.click(700, 790);
    }
    // Au moins Clients et un autre menu dépassent une fenêtre de 800 pixels.
    expect(scrolled).toBeGreaterThanOrEqual(2);
  } finally {
    await app.close();
  }
});

test('chaque menu de la barre verte s’ouvre et chacun de ses écrans s’affiche', async () => {
  const { app, page, errors } = await launch();
  try {
    await createStore(page);
    const rail = page.locator('nav.rail .rail-scroll .rail-item');
    const menus = await rail.allInnerTexts();
    expect(menus.length).toBeGreaterThan(5);
    const failures: string[] = [];
    let opened = 0;
    for (let m = 0; m < menus.length; m++) {
      const menuName = menus[m]!.split('\n').pop()!.trim();
      await rail.nth(m).click();
      const drop = page.locator('.menu-drop');
      await expect(drop, `menu ${menuName}`).toBeVisible();
      const labels = (await drop.locator('button').allInnerTexts()).map((l) => l.split('\n')[0]!.trim());
      for (const label of labels) {
        if (SKIP.test(label)) continue;
        if (!(await drop.isVisible())) await rail.nth(m).click();
        const btn = drop.locator('button', { hasText: label }).first();
        if (await btn.isDisabled()) continue;
        const before = errors.length;
        await btn.click();
        opened++;
        await page.waitForTimeout(400);
        if (await page.locator('.screen-error').count()) failures.push(`${menuName} › ${label} : ${await page.locator('.screen-error pre').first().innerText()}`);
        if (errors.length > before) failures.push(`${menuName} › ${label} : ${errors.slice(before).join(' | ')}`);
        if (!(await page.locator('nav.rail').isVisible())) {
          failures.push(`${menuName} › ${label} : l'application a disparu (écran blanc)`);
          break;
        }
        await dismiss(page);
      }
      await dismiss(page);
    }
    expect(opened, 'écrans ouverts').toBeGreaterThan(100);
    expect(failures).toEqual([]);
  } finally {
    await app.close();
  }
});
