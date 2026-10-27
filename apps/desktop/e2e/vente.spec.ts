import { expect, test } from '@playwright/test';
import { createStore, invoke, launch } from './app';

test('le caissier vend au comptant en scannant un code-barres, et le stock baisse', async () => {
  const { app, page, errors } = await launch();
  try {
    await createStore(page);
    // Un produit reçu en stock (10 pièces), puis la caisse ouverte avec un fond de 0.
    const vat = (await invoke<{ id: string }[]>(page, 'admin.vatRates'))[0]!;
    const art = await invoke<{ id: string }>(page, 'catalogue.save', {
      name: 'Riz parfumé 1 kg',
      unit: 'piece',
      vatRateId: vat.id,
      purchasePrice: 800,
      salePrice: 1000,
      barcodes: [{ code: '6001234567899' }],
    });
    const wh = (await invoke<{ id: string }[]>(page, 'admin.warehouses'))[0]!;
    await invoke(page, 'stock.receive', { warehouseId: wh.id, lines: [{ articleId: art.id, qty: 10_000, unitCost: 800 }] });
    const reg = (await invoke<{ registers: { id: string }[] }>(page, 'treasury.state')).registers[0]!;
    await invoke(page, 'treasury.open', 0, undefined, reg.id);

    // Vente à l'écran : 2 pièces scannées, réglées en espèces au montant exact.
    await page.getByRole('button', { name: 'V. cash 1', exact: true }).click();
    const scan = page.getByPlaceholder(/code-barres/).first();
    await scan.fill('2*6001234567899');
    await scan.press('Enter');
    await expect(page.locator('.tk-lines, .ticket').getByText('Riz parfumé 1 kg').first()).toBeVisible();
    await expect(page.getByText('2 000').first()).toBeVisible();
    await page.getByRole('button', { name: /Exact/ }).click();
    await page.getByRole('button', { name: /VALIDER/ }).click();
    await expect(page.getByText(/Facture DLA1-1-000001 enregistrée/)).toBeVisible();

    const stock = await invoke<{ article_id: string; qty: number }[]>(page, 'stock.list', { warehouseId: wh.id });
    expect(stock.find((r) => r.article_id === art.id)?.qty).toBe(8_000);
    expect(errors).toEqual([]);
  } finally {
    await app.close();
  }
});
