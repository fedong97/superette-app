import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { type Page, expect, test } from '@playwright/test';
import { invoke, launch } from './app';

/**
 * Vendeur et caissier séparés, sur deux PC reliés au serveur central :
 * captures dans CAPTURES s'il est donné, sinon avec les résultats des tests.
 * Le serveur central doit tourner (SERVEUR, ex. http://127.0.0.1:3999, clé ENROLLMENT_KEY) ;
 * sans lui, le test est sauté.
 */
const SHOTS = process.env.CAPTURES ?? join(__dirname, '../../../test-results/captures-vendeur-caissier');
const SERVER = process.env.SERVEUR;
const KEY = process.env.ENROLLMENT_KEY ?? 'cle-enrolement-de-test';

async function shot(page: Page, name: string) {
  mkdirSync(SHOTS, { recursive: true });
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

async function loginAs(page: Page, login: string, pin: string) {
  await invoke(page, 'auth.logout').catch(() => undefined);
  await invoke(page, 'auth.login', login, pin);
  await page.reload();
  await page.waitForTimeout(1500);
  const compris = page.getByRole('button', { name: 'Compris' });
  if (await compris.count()) await compris.first().click();
}

const front = (page: Page) => page.locator('main.windows > section.mdi.active');

test('vendeur et caissier séparés : le vendeur envoie, le caissier encaisse', async () => {
  test.skip(!SERVER, 'Serveur central non lancé (SERVEUR)');
  test.setTimeout(240_000);
  const caisse = await launch();
  const vente = await launch();
  const pc1 = caisse.page;
  const pc2 = vente.page;
  await pc1.setViewportSize({ width: 1440, height: 860 });
  await pc2.setViewportSize({ width: 1440, height: 860 });
  try {
    // Installation : le choix de l'organisation de la vente.
    await pc1.getByLabel('Code magasin').fill('DLA1');
    await pc1.getByLabel('Nom du magasin').fill('Superette Akwa');
    await pc1.getByLabel('Métier').selectOption({ label: 'Superette / alimentation générale' });
    await pc1.getByLabel('Nom complet').fill('Steve');
    await pc1.getByLabel('Identifiant').fill('admin');
    await pc1.getByLabel(/^Code secret/).fill('1234');
    await pc1.getByLabel('Confirmer le code').fill('1234');
    await pc1.getByText('Vendeur et caissier séparés', { exact: true }).click();
    await pc1.getByRole('heading', { name: 'Organisation de la vente' }).scrollIntoViewIfNeeded();
    await shot(pc1, '01-installation-organisation-de-la-vente');
    await pc1.getByRole('button', { name: 'Créer le magasin' }).click();
    await pc1.getByRole('button', { name: 'Compris' }).click();

    // Le PC de caisse est relié au serveur ; vendeurs, caissière, articles et stock.
    await invoke(pc1, 'sync.connect', SERVER, KEY);
    const [store] = await invoke<{ id: string }[]>(pc1, 'admin.stores');
    const [register] = await invoke<{ id: string }[]>(pc1, 'admin.registers', store!.id);
    await invoke(pc1, 'admin.createUser', { name: 'Awa', login: 'awa', pin: '5555', role: 'cashier', storeId: store!.id, registerId: register!.id });
    await invoke(pc1, 'admin.createUser', { name: 'Paul', login: 'paul', pin: '1111', role: 'seller', storeId: store!.id });
    const vat = (await invoke<{ id: string }[]>(pc1, 'admin.vatRates'))[0]!;
    const wh = (await invoke<{ id: string }[]>(pc1, 'admin.warehouses'))[0]!;
    const items: [string, number, string][] = [
      ['RIZ PARFUMÉ 5 KG', 5500, '6001000000018'],
      ['HUILE DIAMAOR 1 L', 1300, '6001000000025'],
      ['SUCRE SOSUCAM 1 KG', 900, '6001000000032'],
      ['LAIT DOLAIT 400 G', 2600, '6001000000049'],
    ];
    for (const [name, price, code] of items) {
      const a = await invoke<{ id: string }>(pc1, 'catalogue.save', { name, unit: 'piece', vatRateId: vat.id, purchasePrice: Math.round(price * 0.8), salePrice: price, barcodes: [{ code }] });
      await invoke(pc1, 'stock.receive', { warehouseId: wh.id, lines: [{ articleId: a.id, qty: 100_000, unitCost: Math.round(price * 0.8) }] });
    }
    const poste = await invoke<{ activation_code: string }>(pc1, 'admin.createRegister', store!.id, 'Poste vente 1');
    await invoke(pc1, 'sync.now');

    // Le PC du vendeur rejoint le magasin.
    await pc2.getByRole('button', { name: 'Rejoindre un magasin existant' }).click();
    await pc2.getByLabel('Adresse du serveur central').fill(SERVER!);
    await pc2.getByLabel(/Code d'activation/).fill(poste.activation_code);
    await pc2.getByRole('button', { name: 'Rejoindre' }).click();
    await pc2.waitForTimeout(4000);
    await loginAs(pc2, 'paul', '1111');

    // Le vendeur facture : pas de billets ni de règlement, « Envoyer à la caisse ».
    const scan = (page: Page) => front(page).getByPlaceholder(/code-barres|scanner/).first();
    for (const code of ['6001000000018', '6001000000018', '6001000000025', '6001000000032']) {
      await scan(pc2).fill(code);
      await scan(pc2).press('Enter');
      await pc2.waitForTimeout(300);
    }
    await front(pc2).getByPlaceholder(/Nom du client/).fill('Mme Ngo Bassa').catch(() => undefined);
    await shot(pc2, '02-vendeur-fiche-de-vente');
    await front(pc2).getByRole('button', { name: /ENVOYER/ }).click();
    await expect(pc2.getByText(/envoyée à la caisse/).first()).toBeVisible();
    await shot(pc2, '03-vendeur-facture-envoyee');

    // Une deuxième facture, pour un autre client.
    await scan(pc2).fill('6001000000049');
    await scan(pc2).press('Enter');
    await front(pc2).getByRole('button', { name: /ENVOYER/ }).click();
    await pc2.waitForTimeout(800);

    // La caissière : son écran à elle, la liste des factures à encaisser.
    await loginAs(pc1, 'awa', '5555');
    await invoke(pc1, 'treasury.open', 20_000, '1234');
    await pc1.reload();
    await pc1.waitForTimeout(2500);
    await expect(pc1.locator('.cd-row').first()).toBeVisible({ timeout: 15_000 });
    await shot(pc1, '04-caissiere-factures-a-encaisser');
    await pc1.locator('.cd-row', { hasText: 'Mme Ngo Bassa' }).click();
    await expect(pc1.locator('.cd-recap-title')).toContainText('Facture n° 1');
    await shot(pc1, '05-caissiere-recapitulatif');
    await pc1.locator('.cd-cash input').fill('15000');
    await shot(pc1, '06-caissiere-recu-et-rendu');
    await pc1.keyboard.press('F4');
    await expect(pc1.getByText(/encaissée/).first()).toBeVisible();
    await shot(pc1, '07-caissiere-encaissee');

    // Le vendeur rouvre la deuxième facture : elle est bloquée à la caisse.
    await front(pc2).getByRole('button', { name: /Mes factures/ }).click();
    await shot(pc2, '08-vendeur-mes-factures-envoyees');
    await pc2.locator('.modal tr', { hasText: 'Comptoir' }).first().getByRole('button', { name: 'Modifier' }).click();
    await pc2.waitForTimeout(800);
    await scan(pc2).fill('6001000000032');
    await scan(pc2).press('Enter');
    await shot(pc2, '09-vendeur-modifie-la-facture');
    await pc1.waitForTimeout(6000);
    await shot(pc1, '10-caissiere-facture-en-modification');
    await front(pc2).getByRole('button', { name: /ENVOYER/ }).click();
    await pc2.waitForTimeout(800);

    // La caissière l'ouvre puis la rend au vendeur avec le motif.
    await pc1.waitForTimeout(6000);
    await pc1.locator('.cd-row').first().click();
    await pc1.getByRole('button', { name: 'Rendre au vendeur' }).click();
    await pc1.getByRole('button', { name: 'Pas assez d’argent' }).click();
    await shot(pc1, '11-caissiere-rend-au-vendeur');
    await pc1.locator('.modal').getByRole('button', { name: 'Rendre au vendeur' }).click();
    await pc1.waitForTimeout(800);

    await pc2.waitForTimeout(1000);
    await front(pc2).getByRole('button', { name: /Mes factures/ }).click();
    await shot(pc2, '12-vendeur-facture-rendue-par-la-caisse');
    await pc2.keyboard.press('Escape');

    // Le réglage dans Administration › Paramètres.
    await loginAs(pc1, 'admin', '1234');
    await invoke(pc1, 'admin.saveStoreSettings', {});
    await pc1.locator('nav.rail .rail-item', { hasText: 'Réglages' }).first().click();
    await pc1.locator('.menu-drop').getByRole('button', { name: 'Paramètres', exact: true }).click();
    await pc1.waitForTimeout(800);
    await front(pc1).getByPlaceholder(/^Chercher : arrondi/).fill('organisation');
    await shot(pc1, '13-parametres-organisation-de-la-vente');
  } finally {
    await caisse.app.close();
    await vente.app.close();
  }
});
