import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { type Page, expect, test } from '@playwright/test';
import { createStore, invoke, launch } from './app';

/** Captures de la nouvelle interface : dans CAPTURES s'il est donné, sinon avec les résultats des tests. */
const SHOTS = process.env.CAPTURES ?? join(__dirname, '../../../test-results/captures-design');

async function shot(page: Page, name: string) {
  mkdirSync(SHOTS, { recursive: true });
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

const ARTICLES: [string, number, number, number][] = [
  ['Coca-Cola 50 cl', 450, 600, 125],
  ['Lait Nido 400 g', 2600, 3200, 8],
  ['Pain de mie', 400, 500, 0],
  ['Riz parfumé 5 kg', 4200, 5000, 40],
  ['Huile Mayor 1 L', 1300, 1600, 22],
  ['Savon Azur', 250, 350, 3],
];

/** Code EAN-13 avec sa clé de contrôle. */
const ean = (d12: string) => d12 + ((10 - ([...d12].reduce((s, c, i) => s + Number(c) * (i % 2 ? 3 : 1), 0) % 10)) % 10);

/** Une petite superette avec des articles, du stock et quelques ventes. */
async function seed(page: Page) {
  const vat = (await invoke<{ id: string }[]>(page, 'admin.vatRates'))[0]!;
  const wh = (await invoke<{ id: string }[]>(page, 'admin.warehouses'))[0]!;
  const ids: string[] = [];
  for (const [i, [name, buy, sell, qty]] of ARTICLES.entries()) {
    const a = await invoke<{ id: string }>(page, 'catalogue.save', { name, unit: 'piece', vatRateId: vat.id, purchasePrice: buy, salePrice: sell, barcodes: [{ code: ean(`60012345678${i}`) }] });
    ids.push(a.id);
    if (qty) await invoke(page, 'stock.receive', { warehouseId: wh.id, lines: [{ articleId: a.id, qty: qty * 1000, unitCost: buy }] });
  }
  const reg = (await invoke<{ registers: { id: string }[] }>(page, 'treasury.state')).registers[0]!;
  await invoke(page, 'treasury.open', 0, undefined, reg.id);
  // Quelques tickets du jour pour le tableau de bord.
  const baskets: [number, number][][] = [[[0, 4], [3, 1]], [[1, 2]], [[4, 3], [0, 2]], [[3, 2], [5, 2]], [[0, 6]], [[1, 1], [4, 1]]];
  for (const b of baskets) {
    const lines = b.map(([i, q]) => ({ articleId: ids[i]!, qty: q * 1000 }));
    const total = b.reduce((t, [i, q]) => t + ARTICLES[i]![2] * q, 0);
    await invoke(page, 'pos.sell', { lines, payments: [{ method: 'CASH', amount: total }] });
  }
}

test('captures de l’interface (accueil, menus, tableau de bord, liste, caisse, fenêtre, recherche)', async () => {
  const { app, page } = await launch();
  await page.setViewportSize({ width: 1440, height: 860 });
  try {
    await createStore(page);
    await seed(page);
    await page.reload();
    await page.waitForTimeout(1200);
    const compris = page.getByRole('button', { name: 'Compris' });
    if (await compris.count()) await compris.first().click();
    await shot(page, '01-accueil');

    await page.locator('nav.rail .rail-item', { hasText: 'Vente' }).first().click();
    await shot(page, '02-menu-vente');
    await page.keyboard.press('Escape');
    await page.mouse.click(900, 500);

    await page.locator('nav.rail .rail-item', { hasText: 'Suivi' }).first().click();
    await page.locator('.menu-drop').getByRole('button', { name: 'Tableau de bord', exact: true }).click();
    await shot(page, '03-tableau-de-bord');

    await page.locator('nav.rail .rail-item', { hasText: 'Articles' }).first().click();
    await page.locator('.menu-drop button').first().click();
    await shot(page, '04-liste-articles');

    await page.getByRole('button', { name: 'V. cash 1', exact: true }).click();
    const scan = page.getByPlaceholder(/code-barres/).first();
    await scan.fill(ean('600123456780'));
    await scan.press('Enter');
    await scan.fill(`3*${ean('600123456783')}`);
    await scan.press('Enter');
    await shot(page, '05-caisse');

    await page.keyboard.press('Control+k');
    await page.keyboard.type('co');
    await page.waitForTimeout(400);
    await shot(page, '06-recherche-ctrl-k');
    await page.keyboard.press('Escape');

    // Barre latérale réduite : les icônes seules, le nom en bulle.
    await page.locator('.rail-logo').first().click();
    await page.locator('.side-toggle').click().catch(() => undefined);
    await page.locator('nav.rail .rail-item', { hasText: 'Stock' }).first().hover();
    await shot(page, '07-barre-reduite');
    await page.locator('.side-toggle').click().catch(() => undefined);

    // Une fenêtre : nouvelle dépense.
    await page.locator('nav.rail .rail-item', { hasText: 'Dépenses' }).first().click();
    await page.locator('.menu-drop').getByRole('button', { name: 'Nouvelle dépense', exact: true }).click();
    await shot(page, '08-nouvelle-depense');
    await page.keyboard.press('Escape');

    await page.locator('.rail-logo').first().click();
    await page.setViewportSize({ width: 900, height: 1000 });
    await shot(page, '09-tablette');
    await page.setViewportSize({ width: 390, height: 844 });
    await shot(page, '10-telephone');
    await page.locator('.side-burger').click();
    await shot(page, '11-telephone-menu');
  } finally {
    await app.close();
  }
});

/** Les écrans de chaque menu, pour vérifier qu'ils suivent tous le même style. */
const SCREENS: [string, string, string?][] = [
  ['10-ventes-registre', 'sales', 'register'],
  ['11-achats', 'purchases'],
  ['12-stock', 'stock'],
  ['13-articles', 'articles', 'list'],
  ['14-clients', 'customers', 'list'],
  ['15-fournisseurs', 'suppliers'],
  ['16-depenses', 'expenses', 'list'],
  ['17-tresorerie', 'treasury', 'day'],
  ['18-compta', 'accounting'],
  ['19-personnel', 'staff'],
  ['20-rapports', 'reports', 'department'],
  ['21-administration', 'admin', 'users'],
  ['22-parametres', 'admin', 'settings'],
  ['23-points-attention', 'dashboard', 'attention'],
];

test('captures de chaque écran dans le nouveau style', async () => {
  const { app, page, errors } = await launch();
  await page.setViewportSize({ width: 1440, height: 860 });
  const dir = join(SHOTS, 'ecrans');
  try {
    await createStore(page);
    await seed(page);
    for (const [name, kind, tab] of SCREENS) {
      await page.keyboard.press('Escape');
      await page.evaluate(([k, t]) => window.dispatchEvent(new CustomEvent('fedonix:open', { detail: [k, t] })), [kind, tab] as const);
      await page.waitForTimeout(700);
      const bar = page.locator('main.windows > section.mdi.active:not(.max) .mdi-bar');
      if (await bar.count()) await bar.first().dblclick().catch(() => undefined);
      mkdirSync(dir, { recursive: true });
      await page.waitForTimeout(400);
      await page.screenshot({ path: join(dir, `${name}.png`) });
    }
    // Comme sur le poste de Steve : la caisse agrandie, Paramètres ouvert devant.
    await page.keyboard.press('Escape');
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('fedonix:open', { detail: ['cash1'] })));
    await page.waitForTimeout(600);
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('fedonix:open', { detail: ['admin', 'settings'] })));
    await page.waitForTimeout(700);
    await page.screenshot({ path: join(dir, '24-caisse-et-parametres.png') });
    expect(errors).toEqual([]);
  } finally {
    await app.close();
  }
});
