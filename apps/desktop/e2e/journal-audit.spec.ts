import { expect, test } from '@playwright/test';
import { createStore, invoke, launch } from './app';

test("le journal d'audit se lit en phrases, par jour, avec le détail en clair", async () => {
  const { app, page, errors } = await launch();
  try {
    await createStore(page);
    const vat = (await invoke<{ id: string }[]>(page, 'admin.vatRates'))[0]!;
    const art = await invoke<{ id: string }>(page, 'catalogue.save', { name: 'Mutzig 65 cl', unit: 'piece', vatRateId: vat.id, purchasePrice: 500, salePrice: 700 });
    const wh = (await invoke<{ id: string }[]>(page, 'admin.warehouses'))[0]!;
    await invoke(page, 'stock.receive', { warehouseId: wh.id, lines: [{ articleId: art.id, qty: 24_000, unitCost: 500 }] });
    const reg = (await invoke<{ registers: { id: string; name: string }[] }>(page, 'treasury.state')).registers[0]!;
    await invoke(page, 'treasury.open', 5000, undefined, reg.id);
    await invoke(page, 'pos.chooseRegister', reg.id);
    await invoke(page, 'pos.sell', { lines: [{ articleId: art.id, qty: 2000 }], payments: [{ method: 'CASH', amount: 1400 }] });
    await invoke(page, 'treasury.countPreview', { 5000: 1 }, reg.id);
    await invoke(page, 'treasury.countPreview', { 5000: 1 }, reg.id);
    await invoke(page, 'treasury.close', { 5000: 1 }, { floatLeft: 0, registerId: reg.id });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('fedonix:open', { detail: ['admin', 'audit'] })));

    const log = page.locator('.audit-log');
    await expect(log).toBeVisible({ timeout: 20_000 });
    await expect(log.locator('.audit-day h3').first()).toHaveText("Aujourd'hui");
    // Plus de code technique ni de données brutes à l'écran.
    await expect(log).not.toContainText('cash.count');
    await expect(log).not.toContainText('{"');
    const close = log.locator('.audit-ev.alert', { hasText: 'a fermé la caisse' });
    await expect(close).toContainText('Manque de 1');
    await expect(log.locator('.audit-ev', { hasText: 'a compté la caisse' })).toContainText('2 fois');
    // Connexions masquées au départ.
    await expect(log).not.toContainText('a ouvert sa session');
    await close.locator('.audit-line').click();
    await expect(close.locator('.audit-detail')).toContainText('Attendu');
    await page.waitForTimeout(600);
    await page.screenshot({ path: 'test-results/ecrans/journal-audit.png' });

    await page.getByRole('button', { name: 'À surveiller' }).click();
    await expect(log.locator('.audit-ev').first()).toContainText('a fermé la caisse');
    // Seulement du rouge et de l'orange : plus de réception ni d'ouverture de caisse.
    await expect(log.locator('.audit-ev.normal, .audit-ev.login')).toHaveCount(0);
    await expect(log).not.toContainText('a enregistré la réception');
    await page.screenshot({ path: 'test-results/ecrans/journal-audit-a-surveiller.png' });
    expect(errors).toEqual([]);
  } finally {
    await app.close();
  }
});
