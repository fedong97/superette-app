import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { type Page, chromium, test } from '@playwright/test';
import { invoke, launch } from './app';
import { closeAll, ean, open, seed } from './exemple';

/**
 * Captures du manuel d'utilisation (docs/manuel/images) : une superette d'exemple
 * avec ses articles, clients, fournisseurs, ventes et dépenses, puis chaque écran décrit.
 * Lancer avec `MANUEL=1 xvfb-run -a npx playwright test manuel` (CAPTURES change le dossier).
 */
const SHOTS = process.env.CAPTURES ?? join(__dirname, '../../../docs/manuel/images');

async function shot(page: Page, name: string, wait = 500) {
  mkdirSync(SHOTS, { recursive: true });
  await page.waitForTimeout(wait);
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

/** Capture de la seule fenêtre de dialogue ouverte (plus lisible à l'impression), sinon de l'écran. */
async function shotModal(page: Page, name: string, wait = 700) {
  mkdirSync(SHOTS, { recursive: true });
  await page.waitForTimeout(wait);
  const modal = page.locator('.modal').last();
  if (await modal.isVisible().catch(() => false)) await modal.screenshot({ path: join(SHOTS, `${name}.png`) });
  else await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

/** Nom de la capture, fenêtre, onglet. */
const SCREENS: [string, string, string?][] = [
  ['20-tresorerie-journee', 'treasury', 'day'],
  ['21-registre-z', 'sales', 'z'],
  ['22-historique-journees', 'treasury', 'history'],
  ['23-caisse-centrale', 'treasury', 'central'],
  ['24-caisses-electroniques', 'treasury', 'emoney'],
  ['25-positions', 'accounting', 'treasury'],
  ['26-operations-caisse', 'sales', 'cashops'],
  ['27-mes-factures', 'sales', 'tickets'],
  ['28-rechercher-ventes', 'sales', 'find'],
  ['30-liste-produits', 'articles', 'list'],
  ['32-rayonnage', 'articles', 'shelving'],
  ['33-etiquettes', 'labels'],
  ['34-promotions', 'promotions'],
  ['40-etat-stock', 'stock', 'state'],
  ['41-reception-sans-commande', 'stock', 'receive'],
  ['42-pertes', 'stock', 'loss'],
  ['43-inventaires', 'stock', 'inventory'],
  ['44-peremptions', 'stock', 'expiry'],
  ['45-transfert', 'stock', 'transferNew'],
  ['46-taches-du-jour', 'stock', 'tasks'],
  ['47-mouvements-stock', 'stock', 'moves'],
  ['50-proposition-commande', 'purchases', 'reorder'],
  ['51-nouveau-bon-commande', 'purchases', 'new-order'],
  ['52-bons-commande', 'purchases', 'orders'],
  ['53-facture-directe', 'purchases', 'direct'],
  ['54-echeancier', 'purchases', 'due'],
  ['55-fournisseurs', 'suppliers', 'list'],
  ['56-retours-fournisseur', 'purchases', 'returns'],
  ['57-registre-receptions', 'purchases', 'receptions'],
  ['60-clients', 'customers', 'list'],
  ['61-situation-clients', 'customers', 'receivables'],
  ['63-reglements', 'customers', 'payments'],
  ['64-devis', 'quotes'],
  ['65-commandes-clients', 'orders'],
  ['66-livraisons', 'deliveries'],
  ['70-nouvelle-depense', 'expenses', 'new'],
  ['71-historique-depenses', 'expenses', 'list'],
  ['72-charges-fixes', 'expenses', 'plans'],
  ['73-depenses-categorie', 'expenses', 'summary'],
  ['80-tableau-de-bord', 'dashboard', 'day'],
  ['81-points-attention', 'dashboard', 'attention'],
  ['82-resume-du-jour', 'admin', 'digest'],
  ['83-registre-ventes', 'sales', 'register'],
  ['84-situation-ventes', 'reports', 'department'],
  ['85-controle-caissiers', 'control'],
  ['86-rapport-mois', 'dashboard', 'owner'],
  ['90-collaborateurs', 'staff', 'list'],
  ['91-pointage', 'staff', 'attendance'],
  ['92-salaires', 'staff', 'salaries'],
  ['93-conges', 'staff', 'leaves'],
  ['94-planning', 'staff', 'planning'],
  ['100-journaux', 'accounting', 'journals'],
  ['101-grand-livre', 'accounting', 'ledger'],
  ['102-balance', 'accounting', 'balance'],
  ['103-plan-comptable', 'accounting', 'accounts'],
  ['104-tva', 'accounting', 'vat'],
  ['105-etats-financiers', 'accounting', 'statements'],
  ['110-parametres', 'admin', 'settings'],
  ['111-caisses', 'admin', 'registers'],
  ['112-utilisateurs', 'admin', 'users'],
  ['113-droits', 'admin', 'rights'],
  ['114-privileges', 'admin', 'privileges'],
  ['115-depots', 'admin', 'warehouses'],
  ['116-couleurs-badges', 'admin', 'brand'],
  ['117-modeles-impression', 'admin', 'templates'],
  ['118-reprise-donnees', 'admin', 'takeover'],
  ['119-paiement-mobile', 'admin', 'mobilepay'],
  ['120-sauvegardes', 'admin', 'backups'],
  ['121-licence', 'admin', 'license'],
  ['122-serveur', 'admin', 'server'],
  ['123-etat-des-pc', 'admin', 'stations'],
  ['124-mises-a-jour', 'admin', 'updates'],
  ['125-audit', 'admin', 'audit'],
];

const scan = (page: Page) => page.getByPlaceholder(/code-barres/).first();

test('captures du manuel', async () => {
  test.skip(!process.env.MANUEL, 'Captures du manuel : MANUEL=1');
  test.setTimeout(900_000);
  const { app, page } = await launch();
  await page.setViewportSize({ width: 1440, height: 860 });
  try {
    // Première ouverture : créer le magasin.
    await shot(page, '01-creation-magasin', 1500);
    await page.getByLabel('Code magasin').fill('DLA1');
    await page.getByLabel('Nom du magasin').fill('Superette Akwa');
    await page.getByLabel('Adresse').fill('Rue Joss, Akwa, Douala');
    await page.getByLabel('Téléphone').fill('677 00 00 00');
    await page.getByLabel('Métier').selectOption({ label: 'Superette / alimentation générale' });
    await page.getByLabel('Nom complet').fill('Alain Ngono');
    await page.getByLabel('Identifiant').fill('admin');
    await page.getByLabel(/^Code secret/).fill('1234');
    await page.getByLabel('Confirmer le code').fill('1234');
    await page.getByRole('heading', { name: 'Organisation de la vente' }).scrollIntoViewIfNeeded();
    await shot(page, '01b-creation-magasin-rempli');
    await page.getByRole('button', { name: 'Créer le magasin' }).click();
    await page.waitForTimeout(1500);
    await shot(page, '02-guide-demarrage');
    await page.getByRole('button', { name: 'Compris' }).click();

    await seed(page, {
      beforeSales: async () => {
        await open(page, 'treasury', 'day');
        await page.getByRole('button', { name: 'Ouvrir la caisse…' }).first().click();
        await shotModal(page, '19-ouvrir-la-caisse');
        await closeAll(page);
      },
    });
    await page.reload();
    await page.waitForTimeout(1500);
    const compris = page.getByRole('button', { name: 'Compris' });
    if (await compris.count()) await compris.first().click();
    await shot(page, '03-accueil');

    // Se repérer : menus, recherche, aide.
    await page.locator('nav.rail .rail-item', { hasText: 'Vente' }).first().click();
    await shot(page, '04-menu-vente');
    await page.keyboard.press('Escape');
    await page.mouse.click(900, 600);
    await page.locator('nav.rail .rail-item', { hasText: 'Tous les menus' }).first().click();
    await shot(page, '05-tous-les-menus');
    await page.keyboard.press('Escape');
    await page.mouse.click(900, 600);
    await page.keyboard.press('Control+k');
    await page.keyboard.type('clôt');
    await shot(page, '06-recherche-ctrl-k', 600);
    await page.keyboard.press('Escape');
    await open(page, 'articles', 'list');
    await page.locator('.help-btn').first().click();
    await shot(page, '07-aide-de-la-page', 700);
    await page.keyboard.press('Escape');

    // La caisse.
    await open(page, 'cash1');
    await shot(page, '10-caisse-vide');
    await scan(page).fill(ean('600123450001'));
    await scan(page).press('Enter');
    await scan(page).fill(`3*${ean('600123450005')}`);
    await scan(page).press('Enter');
    await scan(page).fill(ean('600123450002'));
    await scan(page).press('Enter');
    await shot(page, '11-caisse-ticket');
    await scan(page).fill('hu');
    await shot(page, '12-caisse-recherche', 800);
    await scan(page).fill('');
    await page.keyboard.press('Control+e');
    await shotModal(page, '13-encaisser', 800);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    await page.locator('.mdi.active').getByText(/Client comptoir/).first().click().catch(() => undefined);
    await shotModal(page, '14-choisir-client', 800);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    await page.locator('select').filter({ hasText: 'Actions' }).first().click().catch(() => undefined);
    await shot(page, '15-caisse-actions', 500);
    await page.keyboard.press('Escape');
    await open(page, 'credit');
    await shot(page, '16-vente-credit');

    for (const [name, kind, tab] of SCREENS) {
      await open(page, kind, tab);
      await shot(page, name, 500);
    }

    await open(page, 'customers', 'statement');
    await page.locator('main.windows select').first().selectOption({ index: 1 }).catch(() => undefined);
    await shot(page, '62-extrait-client', 900);

    // Fiches : la fiche article est large.
    await page.setViewportSize({ width: 1700, height: 1000 });
    await open(page, 'articles', 'new');
    await shotModal(page, '31-nouvel-article', 900);
    await open(page, 'articles', 'list');
    await page.getByText('RIZ PARFUMÉ 5 KG').first().click();
    await shotModal(page, '31b-fiche-article', 1000);
    await page.setViewportSize({ width: 1440, height: 860 });
    await open(page, 'customers', 'list');
    await page.getByText('Mballa Joseph').first().click();
    await shotModal(page, '60b-fiche-client', 1000);
    await open(page, 'admin', 'users');
    await page.getByRole('button', { name: /Ajouter un employé/ }).first().click();
    await shotModal(page, '112b-nouvel-employe', 800);
    await open(page, 'admin', 'registers');

    // Clôture de la caisse.
    await open(page, 'treasury', 'day');
    await page.getByRole('button', { name: 'Fermer la caisse…' }).first().click();
    await shotModal(page, '29-fermer-la-caisse', 900);
    await closeAll(page);

    // Paramètres : imprimante et écran de caisse.
    for (const [name, word] of [['110b-parametres-imprimante', 'imprim'], ['110c-parametres-ecran-caisse', 'écran de caisse']] as const) {
      await open(page, 'admin', 'settings');
      await page.getByPlaceholder(/Chercher : arrondi/).fill(word);
      await shot(page, name, 700);
    }

    // Serveur central (SERVEUR, ex. http://127.0.0.1:3999, clé ENROLLMENT_KEY) : le PC relié et l'interface du serveur.
    if (process.env.SERVEUR) {
      const server = process.env.SERVEUR;
      const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
      const web = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      await web.goto(server);
      await web.waitForTimeout(800);
      const pwd = web.locator('input[type=password]');
      if ((await pwd.count()) >= 2) {
        await pwd.nth(0).fill('serveur2026');
        await pwd.nth(1).fill('serveur2026');
        await web.getByRole('button', { name: 'Continuer' }).click();
      } else if (await pwd.count()) {
        await pwd.first().fill('serveur2026');
        await web.getByRole('button', { name: 'Se connecter' }).click();
      }
      await web.waitForTimeout(1000);
      await invoke(page, 'sync.connect', server, process.env.ENROLLMENT_KEY ?? 'cle-enrolement-de-test');
      await invoke(page, 'sync.now').catch(() => undefined);
      await open(page, 'admin', 'server');
      await shot(page, '122b-serveur-relie', 1500);
      await open(page, 'admin', 'registers');
      await invoke(page, 'admin.createRegister', (await invoke<{ id: string }[]>(page, 'admin.stores'))[0]!.id, 'Caisse 2').catch(() => undefined);
      await open(page, 'admin', 'registers');
      await shot(page, '111b-caisse-code-activation', 800);
      await web.reload();
      await web.waitForTimeout(1500);
      await web.screenshot({ path: join(SHOTS, 'S1-serveur-accueil.png') });
      for (const [tab, name] of [['Postes', 'S2-serveur-postes'], ['Sauvegardes', 'S3-serveur-sauvegardes'], ['Réglages', 'S4-serveur-reglages']]) {
        await web.locator('nav button, header button, button', { hasText: tab }).first().click().catch(() => undefined);
        await web.waitForTimeout(800);
        await web.screenshot({ path: join(SHOTS, `${name}.png`) });
      }
      const phone = await browser.newPage({ viewport: { width: 390, height: 780 }, deviceScaleFactor: 2 });
      await phone.goto(`${server}/gerant`);
      await phone.waitForTimeout(800);
      const p2 = phone.locator('input[type=password]');
      if (await p2.count()) {
        await p2.first().fill('serveur2026');
        await phone.keyboard.press('Enter');
        await phone.waitForTimeout(1500);
      }
      await phone.screenshot({ path: join(SHOTS, 'S5-telephone-gerant.png') });
      await browser.close();
    }

    // Écran de connexion.
    await invoke(page, 'auth.logout').catch(() => undefined);
    await page.reload();
    await shot(page, '08-connexion', 1500);
  } finally {
    await app.close();
  }
});
