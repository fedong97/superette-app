import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { type Page, expect, test } from '@playwright/test';
import { createStore, launch } from './app';

/** Captures de la 0.93.0 : dans CAPTURES s'il est donné, sinon avec les résultats des tests. */
const SHOTS = process.env.CAPTURES ?? join(__dirname, '../../../test-results/captures-093');

async function shot(page: Page, name: string) {
  mkdirSync(SHOTS, { recursive: true });
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

test('barre latérale personnalisable, barre du haut allégée, une imprimante par format', async () => {
  const { app, page, errors } = await launch();
  await page.setViewportSize({ width: 1440, height: 860 });
  try {
    await createStore(page);
    await page.reload();
    await page.waitForTimeout(1200);
    const compris = page.getByRole('button', { name: 'Compris' });
    if (await compris.count()) await compris.first().click();

    // Le compte n'est plus que dans la barre latérale ; la recherche du haut est une loupe.
    await expect(page.locator('.topbar .user-chip')).toHaveCount(0);
    await expect(page.locator('nav.rail .side-user')).toBeVisible();
    expect((await page.locator('.topbar .top-search').boundingBox())!.width).toBeLessThan(40);
    await expect(page.locator('nav.rail .rail-item[title="Comptabilité"]')).toBeVisible();
    await expect(page.locator('nav.rail .rail-item[title="Fiscalité"]')).toBeVisible();
    await expect(page.locator('nav.rail .rail-item[title="Fournisseurs"]')).toBeVisible();
    await shot(page, '093-01-accueil');

    // « Personnaliser » en bas de la barre : masquer Fiscalité la retire de la barre.
    await page.locator('nav.rail .side-custom').click();
    const editor = page.locator('.modal', { hasText: 'Personnaliser la barre latérale' });
    await expect(editor).toBeVisible();
    await shot(page, '093-02-personnaliser-la-barre');
    await editor.locator('tr', { hasText: 'Fiscalité' }).locator('input[type="checkbox"]').uncheck();
    await editor.getByRole('button', { name: 'Enregistrer' }).click();
    await expect(page.locator('nav.rail .rail-item[title="Fiscalité"]')).toHaveCount(0);
    await page.reload();
    await page.waitForTimeout(1200);
    await expect(page.locator('nav.rail .rail-item[title="Fiscalité"]')).toHaveCount(0);
    await expect(page.locator('nav.rail .rail-item[title="Comptabilité"]')).toBeVisible();

    // Onglets rapides : 12 au plus, sur deux lignes.
    await page.locator('.topbar .tab-add').click();
    const tabs = page.locator('.modal', { hasText: 'Personnaliser les onglets rapides' });
    for (let i = 0; i < 20; i++) {
      const add = tabs.getByRole('button', { name: 'Ajouter' }).first();
      if (await add.isDisabled()) break;
      await add.click();
    }
    await expect(tabs.getByRole('button', { name: 'Ajouter' }).first()).toBeDisabled();
    await shot(page, '093-03-onglets-12-au-plus');
    await tabs.getByRole('button', { name: 'Enregistrer' }).click();
    await expect(page.locator('.quick-tabs button')).toHaveCount(12);
    expect((await page.locator('.quick-tabs').boundingBox())!.height).toBeLessThanOrEqual(64);
    await shot(page, '093-04-onglets-sur-deux-lignes');

    // Paramètres : une imprimante ticket, une listing, une A4.
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('fedonix:open', { detail: ['admin', 'settings'] })));
    await page.waitForTimeout(800);
    const head = page.getByText('Imprimantes et tiroir-caisse (ce PC)').first();
    await head.click().catch(() => undefined);
    await page.getByText('Pied de ticket', { exact: true }).first().scrollIntoViewIfNeeded();
    await expect(page.getByText('Imprimante listing (factures F7)').first()).toBeVisible();
    await expect(page.getByText('Imprimante A4', { exact: true }).first()).toBeVisible();
    await shot(page, '093-05-imprimantes');
    expect(errors).toEqual([]);
  } finally {
    await app.close();
  }
});
