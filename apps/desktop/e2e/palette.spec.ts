import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { type Page, expect, test } from '@playwright/test';
import { createStore, invoke, launch } from './app';

/** Captures de la palette (neutres, vert ONIX en accent) : dans CAPTURES s'il est donné, sinon avec les résultats des tests. */
const SHOTS = process.env.CAPTURES ?? join(__dirname, '../../../test-results/captures-palette');

const ARTICLES: [string, number, number, number][] = [
  ['Coca-Cola 50 cl', 450, 600, 125],
  ['Lait Nido 400 g', 2600, 3200, 8],
  ['Pain de mie', 400, 500, 0],
  ['Riz parfumé 5 kg', 4200, 5000, 40],
  ['Huile Mayor 1 L', 1300, 1600, 22],
  ['Savon Azur', 250, 350, 3],
];

const ean = (d12: string) => d12 + ((10 - ([...d12].reduce((s, c, i) => s + Number(c) * (i % 2 ? 3 : 1), 0) % 10)) % 10);

async function shot(page: Page, name: string) {
  mkdirSync(SHOTS, { recursive: true });
  await page.waitForTimeout(600);
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

async function open(page: Page, kind: string, tab?: string) {
  await page.keyboard.press('Escape');
  await page.evaluate(([k, t]) => window.dispatchEvent(new CustomEvent('fedonix:open', { detail: t ? [k, t] : [k] })), [kind, tab] as const);
  await page.waitForTimeout(800);
  const bar = page.locator('main.windows > section.mdi.active:not(.max) .mdi-bar');
  if (await bar.count()) await bar.first().dblclick().catch(() => undefined);
}

test('captures de la palette sur les écrans principaux', async () => {
  test.setTimeout(240_000);
  const { app, page, errors } = await launch();
  await page.setViewportSize({ width: 1440, height: 860 });
  try {
    await createStore(page);
    const vat = (await invoke<{ id: string }[]>(page, 'admin.vatRates'))[0]!;
    const wh = (await invoke<{ id: string }[]>(page, 'admin.warehouses'))[0]!;
    const ids: string[] = [];
    for (const [i, [name, buy, sell, qty]] of ARTICLES.entries()) {
      const a = await invoke<{ id: string }>(page, 'catalogue.save', { name, unit: 'piece', vatRateId: vat.id, purchasePrice: buy, salePrice: sell, barcodes: [{ code: ean(`60012345678${i}`) }] });
      ids.push(a.id);
      if (qty) await invoke(page, 'stock.receive', { warehouseId: wh.id, lines: [{ articleId: a.id, qty: qty * 1000, unitCost: buy }] });
    }
    const reg = (await invoke<{ registers: { id: string }[] }>(page, 'treasury.state')).registers[0]!;
    await invoke(page, 'treasury.open', 5000, undefined, reg.id);
    await invoke(page, 'pos.chooseRegister', reg.id);
    for (const b of [[[0, 4], [3, 1]], [[1, 2]], [[4, 3], [0, 2]], [[3, 2], [5, 2]]] as [number, number][][]) {
      const lines = b.map(([i, q]) => ({ articleId: ids[i]!, qty: q * 1000 }));
      const total = b.reduce((t, [i, q]) => t + ARTICLES[i]![2] * q, 0);
      await invoke(page, 'pos.sell', { lines, payments: [{ method: 'CASH', amount: total }] });
    }
    const inv = await invoke<{ id: string }>(page, 'inventories.create', { warehouseId: wh.id, kind: 'global', label: 'Inventaire de fin de mois' });
    await invoke(page, 'inventories.setCount', inv.id, ids[0], 115_000);
    await invoke(page, 'inventories.setCount', inv.id, ids[1], 6_000);
    await invoke(page, 'inventories.setCount', inv.id, ids[3], 37_000);
    await invoke(page, 'inventories.setCount', inv.id, ids[4], 17_000);

    await invoke(page, 'auth.login', 'admin', '1234');
    await page.reload();
    await page.waitForTimeout(1500);
    const compris = page.getByRole('button', { name: 'Compris' });
    if (await compris.count()) await compris.first().click();
    await page.waitForTimeout(1200);
    await shot(page, '01-accueil');

    await page.locator('nav.rail .rail-item', { hasText: 'Stock' }).first().click();
    await shot(page, '02-menu-stock');
    await page.keyboard.press('Escape');
    await page.mouse.click(900, 500);

    await open(page, 'dashboard');
    await shot(page, '03-tableau-de-bord');

    await open(page, 'stock', 'inventory');
    await shot(page, '04-inventaires');
    const row = page.locator('main.windows section.mdi.active table.list tbody tr').first();
    if (await row.count()) {
      await row.click();
      await page.waitForTimeout(800);
      await shot(page, '05-inventaire-ouvert');
    }

    await open(page, 'articles', 'list');
    await shot(page, '06-articles');
    await open(page, 'stock');
    await shot(page, '07-stock');
    await open(page, 'sales', 'register');
    await shot(page, '08-ventes-registre');
    await open(page, 'treasury', 'day');
    await shot(page, '09-tresorerie');
    await open(page, 'accounting');
    await shot(page, '10-comptabilite');

    await open(page, 'cash1');
    const scan = page.locator('main.windows section.mdi.active').getByPlaceholder(/code-barres/).first();
    for (const q of ['Coca', 'Riz', 'Huile']) {
      await scan.fill(q);
      await page.waitForTimeout(500);
      await page.locator('main.windows section.mdi.active .pos-tile').first().click({ timeout: 3000 }).catch(() => undefined);
      await page.getByRole('button', { name: /^Ajouter/ }).first().click({ timeout: 3000 }).catch(() => undefined);
      await page.waitForTimeout(300);
    }
    await scan.fill('a');
    await page.waitForTimeout(500);
    await shot(page, '11-caisse');

    await page.keyboard.press('Escape');
    await page.locator('nav.rail .rail-item', { hasText: 'Dépenses' }).first().click();
    await page.locator('.menu-drop').getByRole('button', { name: 'Nouvelle dépense', exact: true }).click();
    await shot(page, '12-fenetre-nouvelle-depense');
    expect(errors).toEqual([]);
  } finally {
    await app.close();
  }
});
