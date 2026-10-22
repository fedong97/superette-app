import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { type Page, _electron as electron, expect, test } from '@playwright/test';
import { createStore, invoke } from './app';

/** Captures d'écran du module : dans CAPTURES s'il est donné (pour la documentation), sinon avec les résultats des tests. */
const SHOTS = process.env.CAPTURES ?? join(__dirname, '../../../test-results/captures-personnel');

async function shot(page: Page, name: string) {
  mkdirSync(SHOTS, { recursive: true });
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

/** Met la fenêtre de devant en plein écran (gardé pour les ouvertures suivantes). */
async function maximize(page: Page) {
  const b = page.locator('button[title="Plein écran"]').last();
  if (await b.count()) await b.click();
}

/** Ouvre un écran par la barre verte : le menu, puis l'entrée. */
async function openMenu(page: Page, menu: string, item: string | RegExp) {
  await page.locator('nav.rail .rail-item', { hasText: menu }).first().click();
  await page.locator('.menu-drop').getByRole('button', { name: item }).first().click();
}

test('personnel sans accès au logiciel, borne de pointage, équipes et prestataires', async () => {
  test.setTimeout(240_000);
  const dir = mkdtempSync(join(tmpdir(), 'fedonix-personnel-'));
  // Caméra simulée de Chromium : la borne prend sa photo comme avec une vraie webcam.
  const app = await electron.launch({
    args: [resolve(__dirname, '..'), '--no-sandbox', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
    env: { ...process.env, SUPERETTE_DB: join(dir, 'ecrans.db'), APPDATA: dir, HOME: dir, XDG_CONFIG_HOME: dir },
  });
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1366, height: 800 });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  try {
    await createStore(page);
    await invoke(page, 'admin.saveStoreSettings', {
      punchKiosk: true,
      punchBadge: true,
      punchPin: true,
      punchPhoto: true,
      contractorStaff: true,
      staffTeams: true,
      multiEntrances: true,
      holidaysExtra: '2026-03-20 Aïd el-Fitr\n2026-05-27 Tabaski',
    });
    // Le personnel : une caissière (avec compte), un agent de nettoyage et deux vigiles d'une société.
    const agency = await invoke<{ id: string }>(page, 'personnel.saveAgency', { name: 'Sécurité Plus', kind: 'Gardiennage', contact: 'M. Ndongo', phone: '699 11 22 33', contractEnd: '2026-12-31' });
    await invoke(page, 'personnel.saveAgency', { name: 'Clean Services', kind: 'Nettoyage', phone: '677 44 55 66' });
    const jour = await invoke<{ id: string }>(page, 'personnel.saveTeam', { name: 'Jour', start: '07:00', end: '19:00', days: '0123456', color: '#e0a800' });
    const nuit = await invoke<{ id: string }>(page, 'personnel.saveTeam', { name: 'Nuit', start: '19:00', end: '07:00', days: '0123456', tolerance: 15, color: '#1e3a8a' });
    await invoke(page, 'personnel.saveTeam', { name: 'Caisse matin', start: '07:30', end: '15:30', days: '123456' });
    const marie = await invoke<{ id: string }>(page, 'staff.save', { name: 'Marie NGO', position: 'Agent de nettoyage', category: 'daily', contractType: 'daily', phone: '690 00 11 22', baseSalary: 0 });
    const ali = await invoke<{ id: string }>(page, 'staff.save', { name: 'Ali MOUSSA', position: 'Vigile', category: 'contractor', agencyId: agency.id });
    const paul = await invoke<{ id: string }>(page, 'staff.save', { name: 'Paul ESSOMBA', position: 'Vigile', category: 'contractor', agencyId: agency.id });
    const luc = await invoke<{ id: string }>(page, 'staff.save', { name: 'Luc TCHOUA', position: 'Magasinier', category: 'employee', contractType: 'cdd', hiredOn: '2026-05-01', contractEnd: '2026-11-15', baseSalary: 85_000 });
    await invoke(page, 'staff.save', { name: 'Awa NDIAYE', position: 'Stagiaire caisse', category: 'intern', contractType: 'internship', contractEnd: '2027-01-31', baseSalary: 30_000 });
    await invoke(page, 'personnel.setTeam', ali.id, { rotation: { teams: [jour.id, nuit.id], start: '2026-10-19', weeks: 1 } });
    await invoke(page, 'personnel.setTeam', paul.id, { teamId: nuit.id });
    const badges: Record<string, string> = {};
    for (const [name, id] of Object.entries({ marie: marie.id, ali: ali.id, paul: paul.id, luc: luc.id })) badges[name] = await invoke<string>(page, 'personnel.newBadge', id);
    await invoke(page, 'personnel.setPunchPin', marie.id, '2468');
    await invoke(page, 'personnel.saveEntrance', { name: 'Entrée principale' });
    await invoke(page, 'personnel.saveEntrance', { name: 'Porte du dépôt' });
    await page.reload();
    await page.waitForTimeout(1500);
    await page.keyboard.press('Escape');

    // Réglages : les façons de pointer, au choix de chaque entreprise.
    await openMenu(page, 'Réglages', 'Paramètres');
    await maximize(page);
    await page.getByRole('heading', { name: 'Pointage du personnel' }).evaluate((el) => el.scrollIntoView({ block: 'start' }));
    await shot(page, '01-parametres-pointage');
    await page.locator('button.mdi-x').last().click();

    // Le menu Personnel et la liste de tout le personnel.
    await page.locator('nav.rail .rail-item', { hasText: 'Personnel' }).first().click();
    await shot(page, '02-menu-personnel');
    await page.locator('.menu-drop').getByRole('button', { name: /Collaborateurs/ }).click();
    await maximize(page);
    await expect(page.getByRole('cell', { name: /Marie NGO/ })).toBeVisible();
    await shot(page, '03-tout-le-personnel');

    // Fiche d'un vigile de société prestataire.
    await page.getByRole('button', { name: 'Nouveau collaborateur…' }).click();
    await page.getByLabel('Nom et prénom').fill('Jean KAMGA');
    await page.getByLabel('Poste').fill('Vigile');
    await page.getByLabel('Catégorie').selectOption('contractor');
    await page.getByRole('combobox', { name: /^Société prestataire/ }).selectOption({ label: 'Sécurité Plus' });
    await shot(page, '04-fiche-vigile-prestataire');
    await page.locator('.modal').getByRole('button', { name: /^Enregistrer/ }).click();
    await expect(page.getByRole('cell', { name: /Jean KAMGA/ })).toBeVisible();

    // Badge et pointage d'un agent sans compte.
    await page.getByRole('row', { name: /Marie NGO/ }).getByRole('button', { name: 'Badge et pointage' }).click();
    await expect(page.locator('iframe.badge-frame')).toBeVisible();
    await shot(page, '05-badge-et-pointage');
    await page.keyboard.press('Escape');

    // Borne de pointage : badge, numéro et code, refus.
    await openMenu(page, 'Personnel', 'Borne de pointage');
    await expect(page.locator('.kiosk-clock')).toBeVisible();
    await page.waitForTimeout(1500);
    await shot(page, '06-borne-passez-votre-badge');
    await page.locator('.kiosk-scan').fill(badges.ali!);
    await page.keyboard.press('Enter');
    await expect(page.locator('.kiosk-result.in')).toBeVisible();
    await shot(page, '07-borne-arrivee');
    await page.waitForTimeout(4200);
    await page.locator('.kiosk-scan').fill(badges.luc!);
    await page.keyboard.press('Enter');
    await expect(page.locator('.kiosk-result.in')).toBeVisible();
    await page.waitForTimeout(4200);
    await page.locator('.kiosk-scan').fill('FP99999999');
    await page.keyboard.press('Enter');
    await expect(page.locator('.kiosk-result.refused')).toBeVisible();
    await shot(page, '08-borne-badge-inconnu');
    await page.waitForTimeout(5200);
    await page.getByRole('button', { name: /Tapez votre numéro/ }).click();
    const marieNo = (await invoke<{ id: string; punch_number: number }[]>(page, 'staff.list')).find((r) => r.id === marie.id)!.punch_number;
    for (const d of String(marieNo)) await page.locator('.kiosk-pad').getByRole('button', { name: d, exact: true }).click();
    await page.locator('.kiosk-pad').getByRole('button', { name: 'OK' }).click();
    for (const d of '2468') await page.locator('.kiosk-pad').getByRole('button', { name: d, exact: true }).click();
    await shot(page, '09-borne-numero-et-code');
    await page.locator('.kiosk-pad').getByRole('button', { name: 'OK' }).click();
    await expect(page.locator('.kiosk-result.in')).toBeVisible();
    await page.waitForTimeout(4200);
    // Ali repasse plus de 2 minutes après ? Ici tout de suite : le double passage est ignoré.
    await page.locator('.kiosk-scan').fill(badges.ali!);
    await page.keyboard.press('Enter');
    await expect(page.getByText('Déjà noté à')).toBeVisible();
    await page.waitForTimeout(4200);
    await page.getByRole('button', { name: 'Quitter la borne' }).click();
    await page.getByLabel('Code du gérant').fill('1234');
    await page.locator('.modal').getByRole('button', { name: /^Quitter/ }).click();
    await expect(page.locator('.kiosk')).toHaveCount(0);

    // Qui est là.
    await openMenu(page, 'Personnel', /Qui est là/);
    await expect(page.locator('.presence-card').first()).toBeVisible();
    await shot(page, '10-qui-est-la');

    // Pointage du mois, détail d'une personne et passages avec photo.
    await page.getByRole('button', { name: 'Pointage', exact: true }).click();
    await expect(page.getByRole('cell', { name: /Ali MOUSSA/ })).toBeVisible();
    await shot(page, '11-pointage-du-mois');
    await page.getByRole('cell', { name: /Ali MOUSSA/ }).click();
    await page.getByRole('button', { name: 'Passages' }).first().click();
    await expect(page.locator('.punch-photos img').first()).toBeVisible();
    await shot(page, '12-passages-avec-photo');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');

    // Équipes, entrées et borne de ce PC ; sociétés prestataires.
    await page.getByRole('button', { name: 'Équipes et entrées' }).click();
    await expect(page.getByRole('cell', { name: /Nuit/ })).toBeVisible();
    await shot(page, '13-equipes-et-entrees');
    await page.getByRole('button', { name: 'Sociétés prestataires' }).click();
    await expect(page.getByRole('cell', { name: /Sécurité Plus/ })).toBeVisible();
    await shot(page, '14-societes-prestataires');

    // Ce PC devient la borne de l'entrée principale : elle remplace l'écran de connexion.
    const entrances = await invoke<{ id: string; name: string }[]>(page, 'personnel.entrances');
    await invoke(page, 'kiosk.configure', entrances.find((e) => e.name === 'Entrée principale')!.id);
    await invoke(page, 'auth.logout');
    await page.reload();
    await expect(page.locator('.kiosk')).toBeVisible();
    await expect(page.getByText('Entrée principale')).toBeVisible();
    await page.locator('.kiosk-scan').fill(badges.paul!);
    await page.keyboard.press('Enter');
    await expect(page.locator('.kiosk-result.in')).toBeVisible();
    await shot(page, '15-pc-borne-de-l-entree');
    await page.getByRole('button', { name: 'Connexion au logiciel' }).click();
    await expect(page.getByRole('button', { name: 'Se connecter' })).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await app.close();
  }
});
