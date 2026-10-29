import { expect, test } from '@playwright/test';
import { createStore, invoke, launch } from './app';

// Le menu « Plus ▾ » des entrées et sorties s'ouvrait hors de la fenêtre (rien de visible).
test('Trésorerie : « Plus ▾ » s’ouvre sous son bouton, avec imprimer, modifier, supprimer', async () => {
  const { app, page, errors } = await launch();
  await page.setViewportSize({ width: 1280, height: 800 });
  try {
    await createStore(page);
    await invoke(page, 'treasury.open', 0);
    await page.keyboard.press('Escape');
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('fedonix:open', { detail: ['treasury', 'day'] })));
    for (const [i, items] of [
      [0, ['Imprimer le reçu', 'Modifier', 'Supprimer']],
      [1, ['Imprimer le bon de sortie', 'Décharge', 'Modifier', 'Supprimer']],
    ] as const) {
      const plus = page.getByRole('button', { name: 'Plus ▾' }).nth(i);
      await plus.click();
      const drop = page.locator('.desk-action .menu-drop');
      await expect(drop).toBeVisible();
      for (const name of items) await expect(drop.getByRole('button', { name, exact: true })).toBeVisible();
      const [b, d] = [await plus.boundingBox(), await drop.boundingBox()];
      expect(d!.y).toBeGreaterThanOrEqual(b!.y + b!.height);
      expect(d!.y).toBeLessThan(b!.y + b!.height + 20);
      await plus.click();
    }
    expect(errors).toEqual([]);
  } finally {
    await app.close();
  }
});
