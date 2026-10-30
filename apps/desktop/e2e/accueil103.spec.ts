import { expect, test } from '@playwright/test';
import { createStore, invoke, launch } from './app';

test("l'accueil du gérant montre son magasin maintenant, et chaque bloc ouvre son écran", async () => {
  const { app, page, errors } = await launch();
  try {
    await createStore(page);
    const vat = (await invoke<{ id: string }[]>(page, 'admin.vatRates'))[0]!;
    const art = await invoke<{ id: string }>(page, 'catalogue.save', { name: 'Riz parfumé 1 kg', unit: 'piece', vatRateId: vat.id, purchasePrice: 800, salePrice: 1000 });
    const wh = (await invoke<{ id: string }[]>(page, 'admin.warehouses'))[0]!;
    await invoke(page, 'stock.receive', { warehouseId: wh.id, lines: [{ articleId: art.id, qty: 10_000, unitCost: 800 }] });
    const reg = (await invoke<{ registers: { id: string; name: string }[] }>(page, 'treasury.state')).registers[0]!;
    await invoke(page, 'treasury.open', 5000, undefined, reg.id);
    await invoke(page, 'pos.chooseRegister', reg.id);
    await invoke(page, 'pos.sell', { lines: [{ articleId: art.id, qty: 3000 }], payments: [{ method: 'CASH', amount: 3000 }] });
    await page.setViewportSize({ width: 1440, height: 900 });
    await invoke(page, 'auth.login', 'admin', '1234');
    await page.reload();
    await page.waitForTimeout(1500);
    const compris = page.getByRole('button', { name: 'Compris' });
    if (await compris.count()) await compris.first().click();

    const home = page.locator('section.home');
    await expect(home.getByRole('heading', { name: 'Mon magasin maintenant' })).toBeVisible({ timeout: 20_000 });
    await expect(home.getByRole('heading', { name: 'Caisses en direct' })).toBeVisible();
    await expect(home.getByRole('heading', { name: 'Activité en direct' })).toBeVisible();
    await expect(home.locator('.till-mini').first()).toBeVisible();
    await page.waitForTimeout(1200);
    await page.screenshot({ path: 'test-results/ecrans/accueil-gerant.png', fullPage: true });

    // Une caisse de l'accueil s'ouvre dans les Caisses en direct, déjà choisie.
    await home.locator('.till-mini').first().click();
    await expect(page.locator('.live-card.on')).toBeVisible({ timeout: 10_000 });
    expect(errors).toEqual([]);
  } finally {
    await app.close();
  }
});
