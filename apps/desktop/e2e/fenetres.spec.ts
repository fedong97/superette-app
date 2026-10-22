import { writeFileSync } from 'node:fs';
import { type ElectronApplication, type Page, expect, test } from '@playwright/test';
import { createStore, invoke, launch } from './app';

/**
 * Écran d'un portable courant : 1366 × 768 avec le zoom Windows à 125 %, moins la
 * barre des tâches et le titre de la fenêtre. Chaque écran et chaque fenêtre
 * doit s'y afficher en entier : rien ne dépasse sans pouvoir défiler.
 */
const WIDTH = 1093;
const HEIGHT = 560;

/** Entrées de menu qui ferment la session ou l'application, ou appellent le serveur : pas ouvertes ici. */
const SKIP = /Quitter|Changer d'utilisateur|Déconnexion|Fermer la session|Synchroniser/i;
/** Boutons d'un écran qui ouvrent une fenêtre de saisie. */
const OPENERS = /^(\+ )?(Nouveau|Nouvelle|Ajouter|Créer|Modifier|Saisir|Encaisser|Décaisser|Ouvrir|Clôturer|Préparer|Transférer|Payer|Régler|Choisir|Faire|Commander|Réceptionner|Recevoir|Compter|Déclarer|Attribuer|Copier|Rembourser|Changer|Importer\b)/;
const NEVER = /Imprimer|Exporter|PDF|Excel|Supprimer|Quitter|Sauvegarder|Restaurer|Synchroniser|Envoyer|WhatsApp|Annuler|Effacer|Désactiver|Fermer la/i;

async function resize(app: ElectronApplication) {
  await app.evaluate(({ BrowserWindow }, [w, h]) => {
    const win = BrowserWindow.getAllWindows()[0]!;
    win.unmaximize();
    win.setMinimumSize(200, 200);
    win.setContentSize(w, h);
  }, [WIDTH, HEIGHT] as const);
}

/** Ce qui est coupé dans la page : éléments hors de l'écran sans défilement possible, contenu masqué. */
async function clipped(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const W = window.innerWidth;
    const H = window.innerHeight;
    const out = new Set<string>();
    const name = (el: Element) => {
      const cls = typeof el.className === 'string' && el.className ? `.${el.className.trim().split(/\s+/).join('.')}` : '';
      const text = (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 50);
      return `${el.tagName.toLowerCase()}${cls}${text ? ` « ${text} »` : ''}`;
    };
    const visible = (el: Element) => {
      const st = getComputedStyle(el);
      if (st.visibility === 'hidden' || st.display === 'none') return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    /** Un ancêtre qui défile dans ce sens et peut montrer l'élément. */
    const scrolls = (el: Element, axis: 'x' | 'y') => {
      for (let p = el.parentElement; p; p = p.parentElement) {
        const st = getComputedStyle(p);
        const ov = axis === 'x' ? st.overflowX : st.overflowY;
        if ((ov === 'auto' || ov === 'scroll') && (axis === 'x' ? p.scrollWidth > p.clientWidth : p.scrollHeight > p.clientHeight)) return true;
      }
      return false;
    };
    // Zone de travail : à droite de la barre verte.
    const left = document.querySelector('nav.rail')?.getBoundingClientRect().right ?? 0;
    const check = (root: Element, box: { l: number; r: number; b: number }, skipModals: boolean) => {
      for (const el of root.querySelectorAll('*')) {
        if (!visible(el) || el.closest('[data-audit-skip]') || (skipModals && el.closest('.modal-back'))) continue;
        const r = el.getBoundingClientRect();
        if (r.right > box.r + 2 && !scrolls(el, 'x')) out.add(`coupé à droite : ${name(el)}`);
        if (r.left < box.l - 2 && !scrolls(el, 'x')) out.add(`coupé à gauche : ${name(el)}`);
        if (r.bottom > box.b + 2 && !scrolls(el, 'y')) out.add(`coupé en bas : ${name(el)}`);
        const st = getComputedStyle(el);
        // Contenu masqué par un cadre qui ne défile pas (hors textes volontairement abrégés « … »).
        if (st.overflowY === 'hidden' && el.scrollHeight > el.clientHeight + 4 && el.clientHeight > 20 && st.textOverflow !== 'ellipsis') out.add(`contenu masqué en bas : ${name(el)}`);
        if (st.overflowX === 'hidden' && el.scrollWidth > el.clientWidth + 4 && st.textOverflow !== 'ellipsis' && st.whiteSpace !== 'nowrap' && el.children.length > 0) out.add(`contenu masqué à droite : ${name(el)}`);
      }
    };
    for (const modal of document.querySelectorAll('.modal')) {
      if (!visible(modal)) continue;
      const rr = modal.getBoundingClientRect();
      const head = name(modal.querySelector('.modal-head h2, .modal-head h3') ?? modal);
      if (rr.bottom > H + 1 || rr.top < -1) out.add(`fenêtre plus haute que l'écran : ${head}`);
      if (rr.right > W + 1 || rr.left < left - 1) out.add(`fenêtre plus large que la zone de travail : ${head}`);
      check(modal, { l: Math.max(left, rr.left), r: Math.min(W, rr.right), b: Math.min(H, rr.bottom) }, false);
    }
    for (const root of document.querySelectorAll('main.windows > section.mdi, main.windows > .home.front')) {
      if (!visible(root)) continue;
      const rr = root.getBoundingClientRect();
      check(root, { l: Math.max(left, rr.left), r: Math.min(W, rr.right), b: Math.min(H, rr.bottom) }, true);
    }
    // Ne garder que les plus hauts éléments coupés : un tableau coupé coupe aussi ses cellules.
    return [...out].slice(0, 12);
  });
}

async function dismiss(page: Page) {
  for (let i = 0; i < 3; i++) await page.keyboard.press('Escape');
}

test('à la taille d’un portable, chaque écran et chaque fenêtre s’affiche en entier', async () => {
  test.setTimeout(45 * 60_000);
  const { app, page } = await launch();
  const report: Record<string, string[]> = {};
  /** Un défaut déjà relevé (même fenêtre ouverte depuis un autre écran) n'est noté qu'une fois. */
  const seen = new Set<string>();
  /** Écrans et onglets déjà parcourus : leurs fenêtres de saisie ne sont ouvertes qu'une fois. */
  const visited = new Set<string>();
  try {
    await createStore(page);
    const vat = (await invoke<{ id: string }[]>(page, 'admin.vatRates'))[0]!;
    for (const name of ['Riz parfumé 1 kg', 'Huile Diamaor 1 L', 'Savon Azur 200 g']) {
      await invoke(page, 'catalogue.save', { name, unit: 'piece', vatRateId: vat.id, purchasePrice: 800, salePrice: 1000 });
    }
    await resize(app);
    await page.waitForTimeout(300);
    const rail = page.locator('nav.rail .rail-scroll .rail-item');
    const menus = await rail.allInnerTexts();
    for (let m = 0; m < menus.length; m++) {
      const menuName = menus[m]!.split('\n').pop()!.trim();
      await rail.nth(m).click();
      const drop = page.locator('.menu-drop');
      if (!(await drop.isVisible())) continue;
      const labels = (await drop.locator('button').allInnerTexts()).map((l) => l.split('\n')[0]!.trim()).filter(Boolean);
      for (const label of labels) {
        if (SKIP.test(label)) continue;
        if (!(await drop.isVisible())) await rail.nth(m).click();
        const btn = drop.locator('button', { hasText: label }).first();
        if (!(await btn.count()) || (await btn.isDisabled())) continue;
        await btn.click();
        await page.waitForTimeout(350);
        const where = `${menuName} › ${label}`;
        const add = (key: string, found: string[]) => {
          const fresh = found.filter((f) => !seen.has(f));
          for (const f of fresh) seen.add(f);
          if (fresh.length) report[key] = fresh;
        };
        add(where, await clipped(page));
        await dismiss(page);
        // Onglets de l'écran, puis les boutons qui ouvrent une fenêtre de saisie.
        const screen = page.locator('main.windows > section.mdi.active').first();
        if (!(await screen.count())) continue;
        const tabs = await screen.locator('.tabs button').allInnerTexts();
        const views = tabs.length ? tabs : [''];
        for (const tab of views.slice(0, 14)) {
          if (tab) {
            await screen.locator('.tabs button', { hasText: tab }).first().click().catch(() => undefined);
            await page.waitForTimeout(250);
            add(`${where} › ${tab}`, await clipped(page));
          }
          const title = `${(await screen.locator('.mdi-title').first().innerText().catch(() => '')).trim()} › ${tab}`;
          if (visited.has(title)) continue;
          visited.add(title);
          const openers = (await screen.locator('button:visible').allInnerTexts()).map((t) => t.trim()).filter((t) => OPENERS.test(t) && !NEVER.test(t));
          for (const text of [...new Set(openers)].slice(0, 8)) {
            const b = screen.locator('button:visible', { hasText: text }).first();
            if (!(await b.count()) || (await b.isDisabled())) continue;
            await b.click({ timeout: 2000 }).catch(() => undefined);
            await page.waitForTimeout(300);
            if (await page.locator('.modal').count()) add(`${where}${tab ? ` › ${tab}` : ''} › [${text}]`, await clipped(page));
            await dismiss(page);
            await page.waitForTimeout(100);
          }
        }
      }
      await dismiss(page);
    }
  } finally {
    writeFileSync('test-results/fenetres-coupees.json', JSON.stringify(report, null, 2));
    await app.close();
  }
  expect(report).toEqual({});
});
