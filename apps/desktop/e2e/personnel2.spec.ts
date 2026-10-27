import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { type Page, _electron as electron, expect, test } from '@playwright/test';
import { createStore, invoke } from './app';

/** Captures d'écran du module : dans CAPTURES s'il est donné (pour la documentation), sinon avec les résultats des tests. */
const SHOTS = process.env.CAPTURES ?? join(__dirname, '../../../test-results/captures-personnel2');

async function shot(page: Page, name: string) {
  mkdirSync(SHOTS, { recursive: true });
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

async function maximize(page: Page) {
  const b = page.locator('button[title="Plein écran"]').last();
  if (await b.count()) await b.click();
}

async function openMenu(page: Page, menu: string, item: string | RegExp) {
  await page.locator('nav.rail .rail-item', { hasText: menu }).first().click();
  await page.locator('.menu-drop').getByRole('button', { name: item }).first().click();
}

const pad = (n: number) => String(n).padStart(2, '0');
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
/** Jours ouvrés (lundi à samedi) du mois dernier. */
function lastMonthWorkdays(): string[] {
  const now = new Date();
  const out: string[] = [];
  for (let d = new Date(now.getFullYear(), now.getMonth() - 1, 1); d.getMonth() === (now.getMonth() + 11) % 12; d.setDate(d.getDate() + 1)) if (d.getDay() !== 0) out.push(ymd(d));
  return out;
}

test('paie d’après le pointage, pointeuse à empreinte, alertes et avertissements', async () => {
  test.setTimeout(240_000);
  const dir = mkdtempSync(join(tmpdir(), 'fedonix-personnel2-'));
  const app = await electron.launch({
    args: [resolve(__dirname, '..'), '--no-sandbox'],
    env: { ...process.env, SUPERETTE_DB: join(dir, 'ecrans.db'), APPDATA: dir, HOME: dir, XDG_CONFIG_HOME: dir },
  });
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1366, height: 800 });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  try {
    await createStore(page);
    await invoke(page, 'admin.saveStoreSettings', {
      staffTeams: true,
      contractorStaff: true,
      payFromAttendance: true,
      payLate: true,
      payOvertime: true,
      attendanceBonus: 5000,
      fingerprint: true,
      staffAlerts: true,
      alertLateMinutes: 5,
      alertWhatsapp: '699 00 00 00',
      warnLateCount: 2,
    });
    const days = lastMonthWorkdays();
    const period = days[0]!.slice(0, 7);
    const jour = await invoke<{ id: string }>(page, 'personnel.saveTeam', { name: 'Jour', start: '08:00', end: '17:00', days: '123456', color: '#e0a800' });
    // Garde commencée juste après minuit : le vigile qui n'a pas pointé est en retard quelle que soit l'heure du test.
    const garde = await invoke<{ id: string }>(page, 'personnel.saveTeam', { name: 'Garde', start: '00:01', end: '23:59', days: '0123456', tolerance: 0 });
    const agency = await invoke<{ id: string }>(page, 'personnel.saveAgency', { name: 'Sécurité Plus', kind: 'Gardiennage', phone: '699 11 22 33' });
    const luc = await invoke<{ id: string; punch_number: number }>(page, 'staff.save', { name: 'Luc TCHOUA', position: 'Magasinier', baseSalary: 173_000, hiredOn: days[0], allowance: 15_000 });
    const marie = await invoke<{ id: string; punch_number: number }>(page, 'staff.save', { name: 'Marie NGO', position: 'Agent de nettoyage', category: 'daily', dailyRate: 3000, hiredOn: days[0] });
    const ali = await invoke<{ id: string }>(page, 'staff.save', { name: 'Ali MOUSSA', position: 'Vigile', category: 'contractor', agencyId: agency.id, phone: '677 00 00 00' });
    await invoke(page, 'personnel.setTeam', luc.id, { teamId: jour.id });
    await invoke(page, 'personnel.setTeam', ali.id, { teamId: garde.id });
    // Le mois dernier de Luc : présent tous les jours, deux retards et deux soirées d'inventaire, une absence.
    for (const [i, day] of days.entries()) {
      if (i === 3) continue;
      const late = i === 5 || i === 9;
      const overtime = i === 12 || i === 13;
      await invoke(page, 'punches.correctDay', luc.id, day, { arrived: late ? '08:40' : '07:55', left: overtime ? '20:00' : '17:05', reason: 'Reprise du cahier de présence' });
    }

    // Réglages : la paie d'après le pointage, règle par règle.
    await page.reload();
    await page.waitForTimeout(1500);
    await page.keyboard.press('Escape');
    await openMenu(page, 'Réglages', 'Paramètres');
    await maximize(page);
    await page.getByRole('heading', { name: 'Paie d’après le pointage' }).evaluate((el) => el.scrollIntoView({ block: 'start' }));
    await shot(page, '01-parametres-paie-pointage');
    await page.getByRole('heading', { name: 'Pointage du personnel' }).evaluate((el) => el.scrollIntoView({ block: 'start' }));
    await page.mouse.wheel(0, 500);
    await shot(page, '02-parametres-empreinte-alertes');
    await page.locator('button.mdi-x').last().click();

    // Pointeuse : le fichier de la clé USB (journées de Marie), puis un envoi par le réseau.
    await openMenu(page, 'Personnel', 'Équipes, rotations et pointeuses');
    await maximize(page);
    const usb = join(dir, '1_attlog.dat');
    const lines = days.slice(0, 12).flatMap((d) => [`  ${marie.punch_number}\t${d} 07:58:12\t0\t1\t0\t0`, `  ${marie.punch_number}\t${d} 16:02:40\t1\t1\t0\t0`]);
    writeFileSync(usb, [...lines, `  42\t${days[0]} 08:00:00\t0\t1\t0\t0`].join('\r\n'));
    await page.locator('input[type=file][accept=".dat,.txt,.log"]').setInputFiles(usb);
    await expect(page.getByText('24 passage(s) ajouté(s)', { exact: false }).first()).toBeVisible();
    await invoke(page, 'fingerprint.configure', 18081);
    const base = 'http://127.0.0.1:18081/iclock';
    expect(await (await fetch(`${base}/cdata?SN=CQZ7232460123&options=all`)).text()).toContain('GET OPTION FROM: CQZ7232460123');
    const res = await fetch(`${base}/cdata?SN=CQZ7232460123&table=ATTLOG&Stamp=1`, { method: 'POST', body: `${marie.punch_number}\t${days[12]} 07:59:00\t0\t1\n${marie.punch_number}\t${days[12]} 16:00:00\t1\t1\n` });
    expect(await res.text()).toBe('OK: 2');
    // Fenêtre déjà ouverte : elle revient devant, F5 relit les passages reçus de la pointeuse.
    await openMenu(page, 'Personnel', 'Équipes, rotations et pointeuses');
    await page.keyboard.press('F5');
    await page.getByRole('heading', { name: 'Pointeuses à empreinte' }).evaluate((el) => el.scrollIntoView({ block: 'start' }));
    await expect(page.getByRole('cell', { name: 'CQZ7232460123' })).toBeVisible();
    await shot(page, '03-pointeuses-a-empreinte');

    // Salaires du mois dernier, proposés d'après le pointage.
    await openMenu(page, 'Personnel', 'Salaires du mois');
    await page.getByLabel('Mois').fill(period);
    await expect(page.getByRole('cell', { name: /Luc TCHOUA/ })).toBeVisible();
    await shot(page, '04-salaires-d-apres-le-pointage');
    await page.getByRole('row', { name: /Luc TCHOUA/ }).getByRole('button', { name: /FCFA/ }).click();
    await expect(page.locator('.modal').getByText('Brut proposé')).toBeVisible();
    await shot(page, '05-calcul-du-salaire');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: /^Constater les salaires/ }).click();
    await expect(page.getByText(/salaire\(s\) de .* constaté\(s\)/)).toBeVisible();
    const sal = (await invoke<{ staff_id: string; attendance: string | null; gross: number }[]>(page, 'staff.salaries', { period })).find((x) => x.staff_id === luc.id)!;
    expect(sal.attendance).toContain('Heures supplémentaires');

    // Fiche d'un journalier : tarif de la journée.
    await openMenu(page, 'Personnel', /^Collaborateurs/);
    await page.getByRole('row', { name: /Marie NGO/ }).getByRole('button', { name: 'Modifier' }).click();
    await expect(page.getByLabel('Tarif d’une journée (FCFA)')).toHaveValue('3000');
    await shot(page, '06-fiche-journalier');
    await page.keyboard.press('Escape');

    // Qui est là : le vigile n'a pas pointé, l'alerte propose les messages WhatsApp.
    await openMenu(page, 'Personnel', /Qui est là/);
    await expect(page.locator('.alert-row', { hasText: 'Ali MOUSSA' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'WhatsApp à Sécurité Plus' })).toBeVisible();
    await shot(page, '07-alertes-whatsapp');

    // Avertissements : Luc a deux retards le mois dernier ? Seuls ceux du mois en cours comptent ; on en donne un à la main.
    await openMenu(page, 'Personnel', 'Avertissements');
    await page.getByRole('button', { name: 'Nouvel avertissement…' }).click();
    await page.locator('.modal').getByLabel('Collaborateur').selectOption({ label: 'Luc TCHOUA' });
    await page.locator('.modal').getByLabel('Sorte').selectOption('written');
    await page.locator('.modal').getByLabel('Motif').fill('Deux retards de 40 minutes le mois dernier, sans prévenir.');
    await shot(page, '08-nouvel-avertissement');
    await page.locator('.modal').getByRole('button', { name: /^Enregistrer/ }).click();
    await expect(page.getByText('Imprimer la lettre à faire signer ?')).toBeVisible();
    await page.getByRole('button', { name: 'Annuler' }).last().click();
    await expect(page.getByRole('cell', { name: 'Avertissement écrit' })).toBeVisible();
    await shot(page, '09-avertissements');
    expect(errors).toEqual([]);
  } finally {
    await app.close();
  }
});
