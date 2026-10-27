import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { type Page, expect, test } from '@playwright/test';
import { createStore, invoke, launch } from './app';

/** Captures des fenêtres façon Sage : dans CAPTURES s'il est donné, sinon avec les résultats des tests. */
const SHOTS = process.env.CAPTURES ?? join(__dirname, '../../../test-results/captures-fenetres-sage');

async function shot(page: Page, name: string) {
  mkdirSync(SHOTS, { recursive: true });
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

/** Ouvre un écran par son menu de la barre verte. */
async function openFrom(page: Page, menu: string, label: string) {
  await page.keyboard.press('Escape');
  const btn = menu === 'Réglages' ? page.locator('nav.rail .rail-item', { hasText: menu }) : page.locator(`nav.rail .rail-item[title="${menu}"]`);
  await btn.first().click();
  await page.locator('.menu-drop').getByRole('button', { name: label, exact: true }).click();
}

const front = (page: Page) => page.locator('main.windows > section.mdi.active');

test('chaque écran a sa fenêtre : réduire, agrandir, fermer ; les réglages ne font que se fermer', async () => {
  const { app, page, errors } = await launch();
  await page.setViewportSize({ width: 1500, height: 900 });
  try {
    await createStore(page);

    // Paramètres seul, sans les autres onglets de l'administration ; boîte de dialogue : seulement ✕.
    await openFrom(page, 'Réglages', 'Paramètres');
    await expect(front(page).locator('.mdi-title')).toHaveText('Administration › Paramètres');
    await expect(front(page).locator('.tabs button', { hasText: 'Utilisateurs' })).toHaveCount(0);
    await expect(front(page).getByRole('heading', { name: 'Administration', exact: true })).toHaveCount(0);
    await expect(front(page).locator('.mdi-min')).toHaveCount(0);
    await expect(front(page).getByTitle('Agrandir', { exact: true })).toHaveCount(0);
    await shot(page, '01-parametres-seul-fermer-seulement');

    // Utilisateurs : une autre fenêtre ; Paramètres reste ouverte derrière.
    await openFrom(page, 'Réglages', 'Utilisateurs');
    await expect(front(page).locator('.mdi-title')).toHaveText('Administration › Utilisateurs');
    await expect(page.locator('main.windows > section.mdi')).toHaveCount(2);

    // État du stock : fenêtre normale, avec réduire et agrandir.
    await openFrom(page, 'Stock', 'État du stock');
    await expect(front(page).locator('.mdi-title')).toHaveText('Stock › État du stock');
    await expect(front(page).locator('.tabs button', { hasText: 'Mouvements' })).toHaveCount(0);
    await shot(page, '02-etat-du-stock-reduire-agrandir-fermer');
    await front(page).getByTitle('Agrandir', { exact: true }).click();
    await shot(page, '03-agrandie');
    await front(page).locator('.mdi-min').click();
    await expect(page.locator('.mdi-tray-item')).toHaveCount(1);
    await shot(page, '04-reduite-dans-la-barre-du-bas');

    // Le menu Fenêtres liste les quatre, réduite comprise.
    await openFrom(page, 'Achats', 'Bons de commande');
    await page.locator('.win-btn').click();
    await expect(page.locator('.win-menu')).toContainText('Stock › État du stock');
    await expect(page.locator('.win-menu')).toContainText('réduite');
    await shot(page, '05-menu-fenetres');
    await page.locator('.win-menu').getByRole('button', { name: 'Mosaïque' }).click();
    await expect(page.locator('.mdi-tray-item')).toHaveCount(0);
    await shot(page, '06-mosaique');

    // Ctrl+F4 ferme la fenêtre de devant.
    await page.keyboard.press('Control+F4');
    await expect(page.locator('main.windows > section.mdi')).toHaveCount(3);
    expect(errors).toEqual([]);
  } finally {
    await app.close();
  }
});

test('ticket d’une petite fenêtre : les boutons du bas passent à la ligne au lieu d’être coupés', async () => {
  const { app, page, errors } = await launch();
  await page.setViewportSize({ width: 1093, height: 560 });
  try {
    await createStore(page);
    const vat = (await invoke<{ id: string }[]>(page, 'admin.vatRates'))[0]!;
    const art = await invoke<{ id: string }>(page, 'catalogue.save', { name: 'Dolait carton', unit: 'piece', vatRateId: vat.id, purchasePrice: 4000, salePrice: 4500, barcodes: [{ code: '6001234567899' }] });
    const wh = (await invoke<{ id: string }[]>(page, 'admin.warehouses'))[0]!;
    await invoke(page, 'stock.receive', { warehouseId: wh.id, lines: [{ articleId: art.id, qty: 10_000, unitCost: 4000 }] });
    const reg = (await invoke<{ registers: { id: string }[] }>(page, 'treasury.state')).registers[0]!;
    await invoke(page, 'treasury.open', 0, undefined, reg.id);
    await page.getByRole('button', { name: 'V. cash 1', exact: true }).click();
    const scan = page.getByPlaceholder(/code-barres/).first();
    await scan.fill('6001234567899');
    await scan.press('Enter');
    await page.getByRole('button', { name: /Exact/ }).click();
    await page.getByRole('button', { name: /VALIDER/ }).click();
    await expect(page.getByText(/Facture DLA1-1-000001 enregistrée/)).toBeVisible();

    await openFrom(page, 'Vente', 'Mes factures');
    await front(page).getByText('DLA1-1-000001').first().click();
    const modal = page.locator('.modal').last();
    await expect(modal.getByRole('button', { name: /Réimprimer le ticket/ })).toBeVisible();
    const box = (await modal.boundingBox())!;
    for (const b of await modal.locator('.actions button:visible').all()) {
      const r = (await b.boundingBox())!;
      expect(r.x).toBeGreaterThanOrEqual(box.x);
      expect(r.x + r.width).toBeLessThanOrEqual(box.x + box.width + 1);
    }
    await shot(page, '07-ticket-boutons-entiers');
    expect(errors).toEqual([]);
  } finally {
    await app.close();
  }
});
