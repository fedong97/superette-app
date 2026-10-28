import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { type Page, expect, test } from '@playwright/test';
import { createStore, invoke, launch } from './app';

/** Captures du registre des achats et de Ctrl+Suppr à la caisse : dans CAPTURES s'il est donné, sinon avec les résultats des tests. */
const SHOTS = process.env.CAPTURES ?? join(__dirname, '../../../test-results/captures-registre-achats');

async function shot(page: Page, name: string) {
  mkdirSync(SHOTS, { recursive: true });
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

const front = (page: Page) => page.locator('main.windows > section.mdi.active');

test('registre des achats : factures, avoirs et réceptions non facturées ; Ctrl+Suppr vide la fiche de caisse', async () => {
  const { app, page, errors } = await launch();
  await page.setViewportSize({ width: 1500, height: 860 });
  try {
    await createStore(page);
    const [store] = await invoke<{ id: string }[]>(page, 'admin.stores');
    const [register] = await invoke<{ id: string }[]>(page, 'admin.registers', store!.id);
    const vat = (await invoke<{ id: string }[]>(page, 'admin.vatRates'))[0]!;
    const wh = (await invoke<{ id: string }[]>(page, 'admin.warehouses'))[0]!;
    const art = await invoke<{ id: string }>(page, 'catalogue.save', { name: 'Dolait carton', unit: 'piece', vatRateId: vat.id, purchasePrice: 4000, salePrice: 4500, barcodes: [{ code: '6001234567899' }] });
    const sabc = await invoke<{ id: string }>(page, 'suppliers.save', { name: 'SABC' });
    const nestle = await invoke<{ id: string }>(page, 'suppliers.save', { name: 'Nestlé Cameroun' });
    const today = new Date().toISOString().slice(0, 10);
    await invoke(page, 'purchases.directInvoice', { supplierId: sabc.id, supplierNumber: 'FA-2210', invoiceDate: today, warehouseId: wh.id, lines: [{ articleId: art.id, qty: 50_000, unitCost: 4000 }] });
    await invoke(page, 'stock.receive', { warehouseId: wh.id, supplierId: nestle.id, reference: '7781', lines: [{ articleId: art.id, qty: 20_000, unitCost: 4000 }] });

    // Le menu Achats › Payer ouvre le registre.
    await page.locator('nav.rail .rail-item[title="Achats"]').first().click();
    await page.locator('.menu-drop').getByText('Registre des achats', { exact: true }).click();
    const win = front(page);
    await expect(win.getByRole('cell', { name: 'SABC' })).toBeVisible();
    await expect(win.getByRole('cell', { name: 'Facture directe' })).toBeVisible();
    await expect(win.getByRole('cell', { name: 'Non facturée' })).toBeVisible();
    await shot(page, '01-registre-des-achats');

    await win.locator('select').filter({ hasText: 'Tous les achats' }).selectOption('reception');
    await expect(win.getByRole('cell', { name: 'SABC' })).toHaveCount(0);
    await expect(win.getByRole('cell', { name: 'Nestlé Cameroun' })).toBeVisible();
    await shot(page, '02-receptions-non-facturees');
    await win.getByRole('cell', { name: 'Nestlé Cameroun' }).click();
    await expect(page.getByText(/Pas encore facturée/)).toBeVisible();
    await shot(page, '03-detail-reception');
    await page.keyboard.press('Escape');

    // Caisse : Ctrl+Suppr vide la fiche, Ctrl+Z la rend.
    await invoke(page, 'treasury.open', 0, undefined, register!.id);
    await page.getByRole('button', { name: 'V. cash 1', exact: true }).click();
    const scan = page.getByPlaceholder(/code-barres|scanner/).first();
    await scan.fill('6001234567899');
    await scan.press('Enter');
    await expect(front(page).getByText('Dolait carton').first()).toBeVisible();
    await shot(page, '04-fiche-en-cours');
    await page.keyboard.press('Control+Delete');
    await expect(page.getByText(/Fiche vidée/)).toBeVisible();
    await expect(front(page).getByText('Dolait carton')).toHaveCount(0);
    await shot(page, '05-ctrl-suppr-fiche-videe');
    expect(errors).toEqual([]);
  } finally {
    await app.close();
  }
});
