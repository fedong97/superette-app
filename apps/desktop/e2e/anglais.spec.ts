import { writeFileSync } from 'node:fs';
import { type Page, expect, test } from '@playwright/test';
import { createStore, invoke, launch } from './app';

/** Menus que voient le caissier et le vendeur : tout y est en anglais. */
const CASHIER_MENUS = ['Register', 'Sales', 'Treasury', 'Customers'];
const SKIP = /Quit|Switch user|Sign out|Sync/i;

/** Textes encore en français à l'écran (mots courants ou lettres accentuées), hors données saisies. */
async function frenchLeft(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out = new Set<string>();
    const fr = /[éèêàçùôîûœ]|\b(le|la|les|des|du|un|une|et|pour|sur|avec|aucun|aucune|est|dans|par|de|au|aux|en|ou|ce|cette|ses|son|sa|nouveau|nouvelle|rechercher|enregistrer|imprimer|choisir|fermer|ouvrir|tous|toutes|jour|mois|annuler|valider|retour|remise|solde|reste|payer|caisse|vente|ventes|client|clients|facture|montant|ticket)\b/i;
    const data = /Superette Test|Gérant Test|Riz parfumé|Awa Ndiaye|ONIX|DLA1/;
    const keep = (t: string | null | undefined) => {
      const s = (t ?? '').trim();
      if (s && fr.test(s) && !data.test(s)) out.add(s.slice(0, 160));
    };
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    for (let n: Node | null = walker.currentNode; n; n = walker.nextNode()) {
      if (n.nodeType === Node.TEXT_NODE) {
        const p = n.parentElement;
        if (p && !p.closest('script, style, textarea, [translate="no"]') && p.offsetParent !== null) keep(n.nodeValue);
      } else {
        const el = n as Element;
        if (el.closest('[translate="no"]')) continue;
        keep(el.getAttribute('placeholder'));
        keep(el.getAttribute('title'));
      }
    }
    return [...out];
  });
}

async function dismiss(page: Page) {
  for (let i = 0; i < 3; i++) await page.keyboard.press('Escape');
  await page.mouse.click(700, 790);
}

test('en anglais, les écrans du caissier et la vente sont traduits', async () => {
  const { app, page, errors } = await launch();
  try {
    await createStore(page);
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
    const store = (await invoke<{ id: string }[]>(page, 'admin.stores'))[0]!;
    await invoke(page, 'admin.createUser', { name: 'Awa', login: 'awa', pin: '5678', role: 'cashier', storeId: store.id, registerId: reg.id });

    // Le gérant passe en anglais ; l'écran de connexion garde la langue du PC, et la caissière s'y connecte.
    await page.getByRole('button', { name: 'English', exact: true }).click();
    await page.getByRole('button', { name: 'Switch user' }).click();
    await page.getByLabel('Login').fill('awa');
    await page.getByLabel('Secret code').fill('5678');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.getByRole('button', { name: 'Got it' }).click({ timeout: 5000 }).catch(() => {});
    await expect(page.getByRole('button', { name: 'Switch user' })).toBeVisible();

    const left = new Map<string, Set<string>>();
    const note = async (where: string) => {
      for (const t of await frenchLeft(page)) left.set(t, (left.get(t) ?? new Set()).add(where));
    };

    // Vente en anglais : scan, montant exact, VALIDATE.
    await page.getByRole('button', { name: 'Register 1', exact: true }).click();
    const scan = page.getByPlaceholder(/barcode/).first();
    await scan.fill('2*6001234567899');
    await scan.press('Enter');
    await expect(page.getByText('2 000').first()).toBeVisible();
    await note('Register 1 (sale)');
    await page.screenshot({ path: 'test-results/anglais-caisse.png' });
    await page.getByRole('button', { name: /Exact/ }).click();
    await page.getByRole('button', { name: /VALIDATE/ }).click();
    await expect(page.getByText('Invoice DLA1-1-000001 saved')).toBeVisible();
    await note('Register 1 (after sale)');

    // Chaque action de la caisse, puis l'encaissement d'une fiche pleine.
    const actions = page.locator('.mdi.active select').filter({ has: page.locator('option', { hasText: 'Actions' }) }).first();
    for (const value of ['cashIn', 'cashOut', 'cancel', 'return', 'custPay', 'quote', 'order', 'expense']) {
      await actions.selectOption(value);
      await page.waitForTimeout(400);
      await note(`Register 1 › action ${value}`);
      await dismiss(page);
    }
    await scan.fill('6001234567899');
    await scan.press('Enter');
    await page.keyboard.press('Control+e');
    await page.waitForTimeout(400);
    await note('Register 1 › Collect');
    await dismiss(page);

    const rail = page.locator('nav.rail .rail-scroll .rail-item');
    const names = (await rail.allInnerTexts()).map((t) => t.split('\n').pop()!.trim());
    for (const menu of CASHIER_MENUS) {
      const m = names.indexOf(menu);
      expect(m, `menu ${menu} in ${names.join(', ')}`).toBeGreaterThanOrEqual(0);
      await rail.nth(m).click();
      const drop = page.locator('.menu-drop');
      await expect(drop).toBeVisible();
      await note(`menu ${menu}`);
      const labels = (await drop.locator('button').allInnerTexts()).map((l) => l.split('\n')[0]!.trim());
      for (const label of labels) {
        if (SKIP.test(label)) continue;
        if (!(await drop.isVisible())) await rail.nth(m).click();
        const btn = drop.locator('button', { hasText: label }).first();
        if (await btn.isDisabled()) continue;
        await btn.click();
        await page.waitForTimeout(400);
        await note(`${menu} › ${label}`);
        const create = page.locator('.mdi.active button', { hasText: /^New customer$/ }).first();
        if (await create.isVisible().catch(() => false)) {
          await create.click();
          await page.waitForTimeout(300);
          await note(`${menu} › ${label} › New customer`);
          await page.keyboard.press('Escape');
        }
        const tabs = page.locator('.mdi.active .tabs button, .modal .tabs button');
        for (let i = 0; i < (await tabs.count()); i++) {
          await tabs.nth(i).click().catch(() => {});
          await page.waitForTimeout(250);
          await note(`${menu} › ${label} › tab ${i + 1}`);
        }
        await dismiss(page);
      }
      await dismiss(page);
    }
    const report = [...left].map(([t, w]) => `${t}\t${[...w].slice(0, 3).join(' | ')}`).sort();
    writeFileSync('test-results/anglais-restes.txt', report.join('\n'));
    expect(errors).toEqual([]);
    expect(report).toEqual([]);
  } finally {
    await app.close();
  }
});
