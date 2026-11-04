import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { type Page, expect, test } from '@playwright/test';
import { createStore, invoke, launch } from './app';

/** 0.108.0 : fenêtres entières, écrans de vente sur une page, barre des tableaux à la demande. */
const SHOTS = process.env.CAPTURES ?? join(__dirname, '../../../test-results/captures-ecrans-vente-108');
const W = Number(process.env.VW ?? 1536);
const H = Number(process.env.VH ?? 864);

async function shot(page: Page, name: string) {
  mkdirSync(SHOTS, { recursive: true });
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

async function openFrom(page: Page, menu: string, label: string) {
  await page.keyboard.press('Escape');
  await page.locator(`nav.rail .rail-item[title="${menu}"]`).first().click();
  await page.locator('.menu-drop').getByRole('button', { name: label, exact: true }).click();
}

/** Rien ne dépasse de la fenêtre : pas de défilement horizontal ni vertical de la page. */
async function noScroll(page: Page) {
  return page.evaluate(() => {
    const out: string[] = [];
    const win = document.querySelector<HTMLElement>('main.windows section.mdi.active')!;
    const wr = win.getBoundingClientRect();
    for (const el of win.querySelectorAll<HTMLElement>('*')) {
      const cs = getComputedStyle(el);
      if (el.scrollWidth > el.clientWidth + 2 && /(auto|scroll)/.test(cs.overflowX) && el.clientWidth > 0) out.push(`scrollx:${el.className}`);
      if (el.scrollHeight > el.clientHeight + 2 && /(auto|scroll)/.test(cs.overflowY) && el.clientHeight > 0 && !el.closest('table, .pv-grid, .pc-grid, .pos-lines, .pos-cart')) out.push(`scrolly:${el.className}`);
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.right > wr.right + 1 && !el.closest('.pos-actions-menu')) out.push(`dépasse:${el.tagName}.${el.className}:${Math.round(r.right - wr.right)}`);
    }
    return out;
  });
}

test('écrans de vente sur une page, fenêtres entières', async () => {
  const { app, page, errors } = await launch();
  await page.setViewportSize({ width: W, height: H });
  try {
    await createStore(page);
    const vat = (await invoke<{ id: string }[]>(page, 'admin.vatRates'))[0]!;
    const art = await invoke<{ id: string }>(page, 'catalogue.save', { name: 'DOLAIT CARTON', unit: 'piece', vatRateId: vat.id, purchasePrice: 4000, salePrice: 4500 });
    const wh = (await invoke<{ id: string }[]>(page, 'admin.warehouses'))[0]!;
    await invoke(page, 'stock.receive', { warehouseId: wh.id, lines: [{ articleId: art.id, qty: 10_000, unitCost: 4000 }] });
    const reg = (await invoke<{ registers: { id: string }[] }>(page, 'treasury.state')).registers[0]!;
    await invoke(page, 'treasury.open', 5000, undefined, reg.id);
    await invoke(page, 'pos.chooseRegister', reg.id);
    await page.reload();
    await page.waitForTimeout(1200);
    const compris = page.getByRole('button', { name: 'Compris' });
    if (await compris.count()) await compris.first().click();

    // Menus Achats et Fournisseurs séparés.
    await expect(page.locator('nav.rail .rail-item[title="Achats"]')).toBeVisible();
    await expect(page.locator('nav.rail .rail-item[title="Fournisseurs"]')).toBeVisible();
    await page.locator('nav.rail .rail-item[title="Fournisseurs"]').click();
    await shot(page, '01-menu-fournisseurs');
    await page.keyboard.press('Escape');

    // Nouvel article : la fenêtre est entière, à droite de la barre latérale.
    await openFrom(page, 'Produits', 'Liste des produits');
    await page.waitForTimeout(800);
    await shot(page, '02-liste-des-produits');
    const table = page.locator('main.windows section.mdi.active table').first();
    await table.hover();
    await shot(page, '03-tableau-survole');
    await page.locator('.lv-more').click();
    await expect(page.locator('.lv-tools')).toBeVisible();
    await shot(page, '03b-barre-ouverte');
    await page.keyboard.press('Escape');
    await expect(page.locator('.lv-tools')).toHaveCount(0);
    await page.keyboard.press('Control+j');
    const modal = page.locator('.modal').last();
    await expect(modal).toBeVisible();
    await shot(page, '04-nouvel-article');
    const box = (await modal.boundingBox())!;
    const rail = (await page.locator('nav.rail').boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(rail.x + rail.width);
    expect(box.x + box.width).toBeLessThanOrEqual(W);
    // Pas de défilement de côté dans la fenêtre.
    expect(await modal.evaluate((m) => m.scrollWidth <= m.clientWidth + 1)).toBe(true);
    await page.keyboard.press('Escape');

    for (const layout of ['modern', 'classic', 'conventional'] as const) {
      await invoke(page, 'admin.saveStoreSettings', { posLayout: layout });
      await page.reload();
      await page.waitForTimeout(1500);
      for (const [label, kind] of [['Vente 1', 'v1'], ['Vente à crédit', 'credit']] as const) {
        await openFrom(page, 'Vente', label);
        await page.waitForTimeout(900);
        const scan = page.locator('main.windows section.mdi.active').getByPlaceholder(/code-barres|scanner/).first();
        await scan.fill('DOLAIT');
        await page.keyboard.press('Enter');
        await page.waitForTimeout(500);
        await page.keyboard.press('Enter');
        await page.waitForTimeout(500);
        await shot(page, `10-${layout}-${kind}`);
        expect(await noScroll(page)).toEqual([]);
        await expect(page.locator('.pos-offline')).toHaveCount(0);
        if (layout === 'conventional' && kind === 'v1') await expect(page.locator('main.windows section.mdi.active .pv-client .tk-name input')).toBeVisible();
        const actions = page.locator('main.windows section.mdi.active').getByRole('button', { name: /Actions/ }).first();
        if (await actions.count()) {
          await actions.click();
          await shot(page, `11-${layout}-${kind}-actions`);
          const menu = page.locator('main.windows section.mdi.active .pos-actions-menu');
          const m = (await menu.boundingBox())!;
          expect(m.x).toBeGreaterThanOrEqual(0);
          expect(m.x + m.width).toBeLessThanOrEqual(W + 1);
          expect(m.y + m.height).toBeLessThanOrEqual(H + 1);
          await page.keyboard.press('Escape');
          await expect(menu).toHaveCount(0);
        }
      }
    }
    expect(errors).toEqual([]);
  } finally {
    await app.close();
  }
});
