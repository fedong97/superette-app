import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Locator, type Page, test } from '@playwright/test';
import { launch } from './app';
import { closeAll, ean, open, seed } from './exemple';

/**
 * Guide vidéo : le logiciel filmé pendant qu'il travaille sur la superette d'exemple, avec un
 * curseur visible. Le film brut et le minutage des chapitres et de leurs textes (chapitres.json)
 * vont dans VIDEOS ; docs/guide-video/monter.py le découpe en une vidéo par sujet, avec les textes
 * en sous-titres sous l'image et la voix (VOIX) si elle est faite. CHAP=04,05 ne filme que ces sujets.
 * Lancer avec `VIDEO=1 xvfb-run -a npx playwright test video`.
 */
const OUT = process.env.VIDEOS ?? join(__dirname, '../../../docs/guide-video/brut');
const W = 1680;
const H = 1000;
/** Durée de la voix de chaque texte (VOIX/durees.json), sinon le temps de le lire. */
const VOIX: Record<string, number> = process.env.VOIX && existsSync(join(process.env.VOIX, 'durees.json')) ? JSON.parse(readFileSync(join(process.env.VOIX, 'durees.json'), 'utf8')) : {};
const duree = (texte: string) => (VOIX[texte] ? VOIX[texte] + 0.5 : 1 + texte.length * 0.068);
const SEULS = process.env.CHAP?.split(',');

type Chapitre = { id: string; titre: string; carton: number; debut: number; fin: number; textes: { t: number; texte: string }[] };
const chapitres: Chapitre[] = [];
let t0 = 0;
let courant: Chapitre | null = null;
let echeance = 0;
const cartons: number[] = [];
const now = () => (Date.now() - t0) / 1000;

/** Le calque du film : sous-titre, carton de titre, curseur et touches. Remis après un rechargement. */
async function calque(page: Page) {
  await page.evaluate(() => {
    if (document.getElementById('gv-curseur')) return;
    const css = document.createElement('style');
    css.textContent = `
      #gv-carton { position: fixed; inset: 0; z-index: 2147483647; background: linear-gradient(135deg, #0f5132, #1d7a4f); color: #fff;
        display: none; flex-direction: column; align-items: center; justify-content: center; font-family: Inter, Arial, sans-serif; pointer-events: none; }
      #gv-carton .n { font-size: 22px; font-weight: 700; letter-spacing: 3px; color: #f4c542; text-transform: uppercase; }
      #gv-carton .t { font-size: 54px; font-weight: 800; margin: 14px 0 18px; text-align: center; max-width: 1100px; }
      #gv-carton .s { font-size: 24px; opacity: .9; max-width: 900px; text-align: center; line-height: 1.4; }
      #gv-carton .m { position: absolute; bottom: 40px; font-size: 18px; opacity: .75; }
      .toast.error { display: none !important; }
      #gv-curseur { position: fixed; left: 0; top: 0; width: 26px; height: 26px; z-index: 2147483645; pointer-events: none; transform: translate(-3px, -2px); }
      #gv-onde { position: fixed; width: 44px; height: 44px; margin: -22px 0 0 -22px; border-radius: 50%; border: 3px solid #f4c542;
        z-index: 2147483644; pointer-events: none; opacity: 0; }
      #gv-onde.on { animation: gv-onde .5s ease-out; }
      @keyframes gv-onde { from { opacity: 1; transform: scale(.4); } to { opacity: 0; transform: scale(1.4); } }
      #gv-touche { position: fixed; right: 40px; top: 90px; z-index: 2147483646; pointer-events: none; display: none;
        background: #fff; color: #0f5132; border: 3px solid #0f5132; border-radius: 10px; font: 800 30px Inter, Arial, sans-serif;
        padding: 8px 20px; box-shadow: 0 6px 0 #0f5132; }`;
    document.head.appendChild(css);
    const div = (id: string) => {
      const d = document.createElement('div');
      d.id = id;
      document.body.appendChild(d);
      return d;
    };
    div('gv-onde');
    div('gv-touche');
    div('gv-carton').innerHTML = '<div class="n"></div><div class="t"></div><div class="s"></div><div class="m">ONIX 360 · guide vidéo</div>';
    const c = div('gv-curseur');
    c.innerHTML =
      '<svg width="26" height="26" viewBox="0 0 24 24"><path d="M4 2l15 11-6.5 1 3.8 7.2-2.6 1.4-3.8-7.3L5 20z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    const w = window as any;
    w.__gvX = w.__gvX ?? 720;
    w.__gvY = w.__gvY ?? 430;
    c.style.left = `${w.__gvX}px`;
    c.style.top = `${w.__gvY}px`;
    document.addEventListener(
      'mousemove',
      (e) => {
        w.__gvX = e.clientX;
        w.__gvY = e.clientY;
        c.style.left = `${e.clientX}px`;
        c.style.top = `${e.clientY}px`;
      },
      true,
    );
    document.addEventListener(
      'mousedown',
      (e) => {
        const o = document.getElementById('gv-onde')!;
        o.style.left = `${e.clientX}px`;
        o.style.top = `${e.clientY}px`;
        o.classList.remove('on');
        void o.offsetWidth;
        o.classList.add('on');
      },
      true,
    );
  });
}

/** Attend que le texte en cours ait été lu (ou dit). */
async function attendre(page: Page) {
  const reste = echeance - now();
  if (reste > 0) await page.waitForTimeout(reste * 1000);
}

/** Le texte de l'étape, en sous-titre au montage : les gestes qui suivent se font pendant sa lecture. */
async function dire(page: Page, texte: string) {
  await attendre(page);
  courant?.textes.push({ t: now(), texte });
  echeance = now() + duree(texte);
}

/** Amène le curseur sur l'élément, puis clique. */
async function cliquer(page: Page, cible: Locator, pause = 500) {
  await calque(page);
  await cible.scrollIntoViewIfNeeded().catch(() => undefined);
  const b = await cible.boundingBox();
  if (b) {
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 22 });
    await page.waitForTimeout(250);
  }
  await cible.click();
  await page.waitForTimeout(pause);
}

/** Choisit dans une liste déroulante, sans ouvrir la liste du système (elle bloquerait le film). */
async function choisir(page: Page, liste: Locator, choix: number | string | RegExp) {
  await calque(page);
  const b = await liste.boundingBox();
  if (b) await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 22 });
  await page.waitForTimeout(300);
  let option: { index: number } | { label: string } = typeof choix === 'number' ? { index: choix } : { label: String(choix) };
  if (choix instanceof RegExp) {
    const textes = await liste.locator('option').allTextContents();
    const i = textes.findIndex((t) => choix.test(t));
    option = { index: i < 0 ? 1 : i };
  }
  await liste.selectOption(option).catch(() => undefined);
  await page.waitForTimeout(500);
}

/** Clique dans la case, puis tape le texte lettre par lettre. */
async function taper(page: Page, cible: Locator, texte: string, pause = 350) {
  await cliquer(page, cible, 150);
  await cible.fill('');
  await cible.pressSequentially(texte, { delay: 75 });
  await page.waitForTimeout(pause);
}

/** Montre la touche à l'écran, puis l'appuie. */
async function touche(page: Page, combo: string, affiche = combo.replace('Control', 'Ctrl'), pause = 700) {
  await calque(page);
  await page.evaluate((t) => {
    const k = document.getElementById('gv-touche')!;
    k.textContent = t;
    k.style.display = 'block';
  }, affiche);
  await page.waitForTimeout(700);
  await page.keyboard.press(combo);
  await page.waitForTimeout(pause);
  await page.evaluate(() => (document.getElementById('gv-touche')!.style.display = 'none'));
}

/** Ouvre un menu de la barre verte, puis l'une de ses lignes. */
async function menu(page: Page, rail: string, ligne: string | RegExp) {
  await cliquer(page, page.locator('nav.rail .rail-item', { hasText: rail }).first(), 700);
  await cliquer(page, page.locator('.menu-drop button', { hasText: ligne }).first(), 900);
  const bar = page.locator('main.windows > section.mdi.active:not(.max) .mdi-bar');
  if (await bar.count()) await bar.first().dblclick({ timeout: 1500 }).catch(() => undefined);
  await page.waitForTimeout(400);
}

/** Montre le carton de titre (fond vert plein, repéré au montage pour caler le minutage). */
async function carton(page: Page, num: string, titre: string, sous: string) {
  await calque(page);
  await page.evaluate(
    ([n, t, s]) => {
      const c = document.getElementById('gv-carton')!;
      c.querySelector('.n')!.textContent = n;
      c.querySelector('.t')!.textContent = t;
      c.querySelector('.s')!.textContent = s;
      c.style.display = 'flex';
    },
    [num, titre, sous],
  );
  await page.waitForTimeout(150);
  cartons.push(now());
}

/** Carton de titre, puis le chapitre ; son minutage va dans chapitres.json. */
async function chapitre(page: Page, id: string, num: string, titre: string, sous: string, fn: () => Promise<void>) {
  if (SEULS && !SEULS.some((c) => id.startsWith(c))) return;
  await carton(page, num, titre, sous);
  courant = { id, titre, carton: cartons.at(-1)!, debut: 0, fin: 0, textes: [] };
  await page.waitForTimeout(3600);
  await page.evaluate(() => (document.getElementById('gv-carton')!.style.display = 'none'));
  courant.debut = now();
  await page.waitForTimeout(300);
  try {
    await fn();
  } catch (e) {
    console.log(`[video] ${id} : ${(e as Error).message.split('\n')[0]}`);
    await page.screenshot({ path: join(OUT, `erreur-${id}.png`) }).catch(() => undefined);
  }
  await attendre(page);
  await page.waitForTimeout(800);
  courant.fin = now();
  chapitres.push(courant);
  courant = null;
}

const scan = (page: Page) => page.getByPlaceholder(/code-barres/).first();
const modal = (page: Page) => page.locator('.modal').last();

test('guide vidéo', async () => {
  test.skip(!process.env.VIDEO, 'Guide vidéo : VIDEO=1');
  test.setTimeout(2_400_000);
  mkdirSync(OUT, { recursive: true });
  const { app, page } = await launch({ recordVideo: { dir: OUT, size: { width: W, height: H } } });
  t0 = Date.now();
  await page.setViewportSize({ width: W, height: H });
  const fenetre = page.locator('.mdi.active');
  try {
    await page.waitForTimeout(1500);

    await chapitre(page, '01-creer-le-magasin', 'Vidéo 1', 'Créer votre magasin', 'La première ouverture du logiciel.', async () => {
      await dire(page, 'À la première ouverture, ONIX 360 demande de créer votre magasin. Tout se fait sur cette seule page.');
      await page.mouse.move(700, 300, { steps: 15 });
      await dire(page, 'Le code magasin : deux à six lettres ou chiffres. Il apparaît sur les factures.');
      await taper(page, page.getByLabel('Code magasin'), 'DLA1');
      await dire(page, "Puis le nom, l'adresse et le téléphone : ils s'impriment en haut de chaque ticket.");
      await taper(page, page.getByLabel('Nom du magasin'), 'Superette Akwa');
      await taper(page, page.getByLabel('Adresse'), 'Rue Joss, Akwa, Douala');
      await taper(page, page.getByLabel('Téléphone'), '677 00 00 00');
      await page.getByRole('heading', { name: 'Organisation de la vente' }).scrollIntoViewIfNeeded();
      await dire(page, "Organisation de la vente : choisissez « Vendeur-caissier » si la même personne vend et encaisse. C'est le cas le plus courant.");
      await page.mouse.move(560, 470, { steps: 20 });
      await dire(page, 'Le métier prépare les rayons, les familles et les réglages de départ. Vous pourrez tout modifier ensuite.');
      await choisir(page, page.getByLabel('Métier'), 'Superette / alimentation générale');
      await dire(page, "Enfin, l'administrateur : c'est vous, le propriétaire. Choisissez un identifiant et un code secret dont vous vous souviendrez.");
      await taper(page, page.getByLabel('Nom complet'), 'Alain Ngono');
      await taper(page, page.getByLabel('Identifiant'), 'admin');
      await taper(page, page.getByLabel(/^Code secret/), '1234');
      await taper(page, page.getByLabel('Confirmer le code'), '1234');
      await dire(page, 'Cliquez sur « Créer le magasin ».');
      await cliquer(page, page.getByRole('button', { name: 'Créer le magasin' }), 1500);
      await dire(page, "Le guide de démarrage liste ce qu'il reste à régler. Vous le retrouverez dans le menu Aide.");
      await page.mouse.move(800, 400, { steps: 15 });
      await attendre(page);
      await cliquer(page, page.getByRole('button', { name: 'Compris' }), 800);
    });
    if (await page.getByLabel('Code magasin').count()) {
      // Sujet 01 non filmé : créer le magasin sans le filmer.
      await page.getByLabel('Code magasin').fill('DLA1');
      await page.getByLabel('Nom du magasin').fill('Superette Akwa');
      await page.getByLabel('Adresse').fill('Rue Joss, Akwa, Douala');
      await page.getByLabel('Téléphone').fill('677 00 00 00');
      await page.getByLabel('Métier').selectOption({ label: 'Superette / alimentation générale' });
      await page.getByLabel('Nom complet').fill('Alain Ngono');
      await page.getByLabel('Identifiant').fill('admin');
      await page.getByLabel(/^Code secret/).fill('1234');
      await page.getByLabel('Confirmer le code').fill('1234');
      await page.getByRole('button', { name: 'Créer le magasin' }).click();
      await page.getByRole('button', { name: 'Compris' }).click();
    }

    await seed(page, {
      beforeSales: async () => {
        await page.reload();
        await page.waitForTimeout(1500);
        const compris = page.getByRole('button', { name: 'Compris' });
        if (await compris.count()) await compris.first().click();
        await closeAll(page);
        await chapitre(page, '03-ouvrir-la-caisse', 'Vidéo 3', 'Ouvrir la caisse le matin', 'Compter le fond de caisse avant la première vente.', async () => {
          await dire(page, "Chaque matin, avant la première vente, on ouvre la caisse. Menu Trésorerie, puis « Opérations de trésorerie ».");
          await menu(page, 'Trésorerie', 'Opérations de trésorerie');
          await dire(page, 'Cliquez sur « Ouvrir la caisse ».');
          await cliquer(page, page.getByRole('button', { name: 'Ouvrir la caisse…' }).first(), 900);
          await dire(page, "Comptez les espèces du tiroir et tapez le total : c'est le fond de caisse.");
          await taper(page, modal(page).locator('input').first(), '25000');
          await dire(page, '« Compter par coupures » aide à compter billet par billet, si vous préférez.');
          await page.mouse.move(700, 520, { steps: 12 });
          await dire(page, 'Validez avec « Ouvrir la caisse ».');
          await cliquer(page, modal(page).getByRole('button', { name: /Ouvrir la caisse/ }).last(), 1500);
          await dire(page, 'La caisse est ouverte : la journée commence, on peut vendre.');
          await attendre(page);
          await closeAll(page);
        });
      },
    });
    await page.reload();
    await page.waitForTimeout(1800);
    const compris = page.getByRole('button', { name: 'Compris' });
    if (await compris.count()) await compris.first().click();
    await closeAll(page);

    await chapitre(page, '02-se-reperer', 'Vidéo 2', "Se repérer dans l'écran", "Les menus, la recherche et l'aide de chaque page.", async () => {
      await dire(page, "Voici la page d'accueil : les chiffres de votre journée et les accès rapides.");
      await page.mouse.move(700, 260, { steps: 20 });
      await dire(page, 'À gauche, la barre verte : un menu par domaine. Vente, Trésorerie, Stock, Articles, Achats…');
      await page.mouse.move(90, 300, { steps: 20 });
      await dire(page, 'Un clic ouvre la liste des écrans du menu, rangés par sujet.');
      await cliquer(page, page.locator('nav.rail .rail-item', { hasText: 'Vente' }).first(), 600);
      await attendre(page);
      await page.keyboard.press('Escape');
      await page.mouse.click(1100, 700);
      await dire(page, '« Tous les menus » montre tous les écrans du logiciel sur une seule page.');
      await cliquer(page, page.locator('nav.rail .rail-item', { hasText: 'Tous les menus' }).first(), 800);
      await attendre(page);
      await page.keyboard.press('Escape');
      await page.mouse.click(1100, 700);
      await dire(page, 'Le plus rapide : Ctrl + K, puis tapez ce que vous cherchez. Par exemple « clôt » pour la clôture de caisse.');
      await touche(page, 'Control+k', 'Ctrl + K');
      await page.keyboard.type('clôt', { delay: 140 });
      await dire(page, "Entrée ouvre l'écran trouvé.");
      await attendre(page);
      await page.keyboard.press('Escape');
      await dire(page, 'Sur chaque écran, le bouton rond « ? » en haut à droite explique la page. La touche F1 fait pareil.');
      await menu(page, 'Articles', 'Liste des produits');
      await cliquer(page, page.locator('.help-btn').first(), 900);
      await dire(page, "L'aide décrit l'écran avec les mêmes mots que le manuel.");
      await attendre(page);
      await page.keyboard.press('Escape');
      await closeAll(page);
    });

    await chapitre(page, '04-vendre-et-encaisser', 'Vidéo 4', 'Vendre et encaisser', 'Scanner, chercher un produit, encaisser et rendre la monnaie.', async () => {
      await dire(page, 'Pour vendre : le bouton « V. cash 1 » en haut de l\'écran, ou la touche F2.');
      await cliquer(page, page.getByRole('button', { name: 'V. cash 1', exact: true }), 1000);
      await dire(page, "Scannez le code-barres du produit : il s'ajoute au ticket.");
      await cliquer(page, scan(page), 400);
      await scan(page).fill(ean('600123450001'));
      await scan(page).press('Enter');
      await page.waitForTimeout(600);
      await dire(page, 'Pour plusieurs pièces, tapez la quantité, une étoile, puis scannez. Ici : 3 étoile, et le code.');
      await scan(page).pressSequentially('3*', { delay: 200 });
      await scan(page).fill(`3*${ean('600123450005')}`);
      await scan(page).press('Enter');
      await dire(page, 'Sans code-barres ? Tapez le début du nom : les produits trouvés apparaissent en tuiles.');
      await scan(page).pressSequentially('dent', { delay: 160 });
      await page.waitForTimeout(900);
      await dire(page, "Touchez la tuile, vérifiez la quantité, puis « Ajouter » : le produit passe sur le ticket.");
      await cliquer(page, fenetre.getByText('DENTIFRICE SIGNAL 100 ML').first(), 900);
      await cliquer(page, modal(page).getByRole('button', { name: /Ajouter/ }).first(), 900);
      await dire(page, 'Le total à payer est en bas à droite. Le client donne un billet de 5 000 : touchez-le.');
      await page.mouse.move(1500, 650, { steps: 15 });
      await page.waitForTimeout(600);
      await cliquer(page, fenetre.getByRole('button', { name: /BILLET\s*5\s?000/ }).first(), 900);
      await dire(page, "La monnaie à rendre s'affiche juste à côté.");
      await page.mouse.move(1560, 740, { steps: 15 });
      await dire(page, '« Ticket », ou F2, valide et imprime le ticket. « Valider », ou F4, valide sans imprimer.');
      await cliquer(page, fenetre.getByRole('button', { name: /VALIDER/ }).first(), 1500);
      await dire(page, "La vente est enregistrée et le stock a baissé. Le ticket est vide, prêt pour le client suivant.");
      await dire(page, 'Pour un paiement Mobile Money, carte ou en plusieurs moyens : « Encaisser », ou Ctrl + E.');
      await page.mouse.move(250, 940, { steps: 20 });
      await attendre(page);
      await closeAll(page);
    });

    await chapitre(page, '05-vente-a-credit', 'Vidéo 5', 'Vendre à crédit à un client', 'Choisir le client, vendre sur son compte, suivre ce qu\'il doit.', async () => {
      await cliquer(page, page.getByRole('button', { name: 'V. cash 1', exact: true }), 1000);
      await dire(page, "Un client habitué prend à crédit. D'abord, choisissez le client : touchez « Client comptoir », ou F8.");
      await cliquer(page, fenetre.getByText(/Client comptoir/).first(), 900);
      await dire(page, 'Cherchez-le par son nom ou son téléphone.');
      await taper(page, modal(page).locator('input').first(), 'Mballa');
      await page.waitForTimeout(700);
      await cliquer(page, modal(page).getByText('Mballa Joseph').first(), 900);
      await dire(page, "Ajoutez les produits comme d'habitude.");
      await cliquer(page, scan(page), 300);
      await scan(page).fill(`6*${ean('600123450008')}`);
      await scan(page).press('Enter');
      await page.waitForTimeout(700);
      await dire(page, 'Encaissez avec Ctrl + E, puis choisissez « Crédit client » : le montant passe sur son compte.');
      await touche(page, 'Control+e', 'Ctrl + E', 900);
      await cliquer(page, modal(page).getByRole('button', { name: 'Crédit client' }).first(), 700);
      await cliquer(page, modal(page).getByRole('button', { name: 'Ajouter le paiement' }), 800);
      await dire(page, "Validez le ticket. Le plafond de crédit du client est contrôlé : au-delà, la vente est refusée.");
      await cliquer(page, modal(page).getByRole('button', { name: /Valider le ticket/ }).first(), 1500);
      await attendre(page);
      await page.keyboard.press('Escape');
      await closeAll(page);
      await dire(page, "Pour voir ce que doit chaque client : menu Clients, « Situation des comptes ».");
      await menu(page, 'Clients', /Situation/);
      await dire(page, "Quand le client vient payer, la caisse l'enregistre par « Actions », puis « Règlement client ».");
      await page.mouse.move(800, 400, { steps: 15 });
      await attendre(page);
      await closeAll(page);
    });

    await chapitre(page, '06-creer-un-article', 'Vidéo 6', 'Créer un article', 'La fiche produit : nom, rayon et prix.', async () => {
      await dire(page, 'Menu Articles, puis « Ajouter un article ». La fiche du produit s\'ouvre.');
      await menu(page, 'Articles', /Ajouter/);
      const m = modal(page);
      await dire(page, "La désignation : le nom tel qu'il sera imprimé sur le ticket.");
      await taper(page, m.getByLabel('Désignation'), 'LAIT NIDO 400 G');
      await dire(page, 'Le rayon et la famille rangent le produit, pour les rapports et les étiquettes.');
      const rayon = m.getByLabel('Rayon / famille');
      await choisir(page, rayon, 2);
      const prix = m.locator('table tbody tr').first().locator('input');
      await dire(page, "Dans le tableau des prix : le nom de l'unité, le prix d'achat, puis le prix de vente. La marge se calcule toute seule.");
      await taper(page, prix.nth(0), 'PIÈCE');
      await taper(page, prix.nth(1), '2400');
      await taper(page, prix.nth(3), '3000');
      await dire(page, "Le code-barres se scanne dans sa case. Sans code, ONIX 360 en crée un pour l'étiquette.");
      await page.mouse.move(1500, 420, { steps: 15 });
      await dire(page, 'Enregistrez avec « Enregistrer », ou Ctrl + Entrée.');
      await touche(page, 'Control+Enter', 'Ctrl + Entrée', 1500);
      await dire(page, "L'article est créé. Pour l'avoir en stock, il reste à recevoir la marchandise.");
      await attendre(page);
      await closeAll(page);
    });

    await chapitre(page, '07-recevoir-la-marchandise', 'Vidéo 7', 'Recevoir la marchandise', 'Entrer en stock les produits livrés.', async () => {
      await dire(page, 'Menu Achats, « Réception sans commande » : pour une livraison sans bon de commande.');
      await menu(page, 'Achats', /Réception sans commande/);
      await dire(page, 'Choisissez le fournisseur, puis scannez ou cherchez chaque produit livré.');
      const f = page.locator('main.windows select').nth(1);
      await choisir(page, f, 1);
      await taper(page, page.getByPlaceholder(/Produit : scanner ou rechercher/).first(), 'coca');
      await page.waitForTimeout(900);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(1000);
      await dire(page, "Tapez la quantité reçue et vérifiez le prix d'achat, puis « Ajouter dans la liste ».");
      const qte = fenetre.locator('input:focus');
      if (await qte.count()) await qte.pressSequentially('4', { delay: 150 });
      await page.waitForTimeout(600);
      await cliquer(page, fenetre.getByRole('button', { name: /Ajouter dans la liste/ }).first(), 900);
      await dire(page, '« Valider la réception » ajoute les quantités au stock.');
      const v = page.getByRole('button', { name: 'Valider la réception' }).first();
      if (await v.isEnabled().catch(() => false)) await cliquer(page, v, 1500);
      await dire(page, "ONIX 360 propose alors d'imprimer les étiquettes des produits reçus. « Plus tard » si vous les imprimez après.");
      const tard = modal(page).getByRole('button', { name: /Plus tard/ }).first();
      if (await tard.count()) await cliquer(page, tard, 900);
      await dire(page, 'Pour une commande passée au fournisseur, la réception se fait depuis le bon de commande.');
      await attendre(page);
      await closeAll(page);
    });

    await chapitre(page, '08-enregistrer-une-depense', 'Vidéo 8', 'Enregistrer une dépense', "Loyer, électricité, transport : chaque sortie d'argent.", async () => {
      await dire(page, 'Menu Dépenses, « Nouvelle dépense ».');
      await menu(page, 'Dépenses', /Nouvelle dépense/);
      const m = modal(page);
      await dire(page, 'Choisissez la catégorie, puis décrivez la dépense et son montant.');
      const cat = m.getByLabel('Catégorie');
      await choisir(page, cat, /lectricit/i);
      await taper(page, m.getByLabel('Objet'), 'Facture ENEO de novembre');
      await taper(page, m.getByLabel(/Montant/), '12500');
      await dire(page, 'Indiquez comment elle est payée : espèces, MTN MoMo, Orange Money…, et depuis quelle caisse.');
      await cliquer(page, m.getByRole('button', { name: 'Espèces' }).first(), 500);
      await dire(page, 'Enregistrez : la dépense passe en comptabilité et dans les rapports.');
      await cliquer(page, m.getByRole('button', { name: /Enregistrer la dépense/ }).first(), 1500);
      await attendre(page);
      await closeAll(page);
    });

    await chapitre(page, '09-ajouter-un-caissier', 'Vidéo 9', 'Ajouter un caissier', 'Un compte pour chaque employé.', async () => {
      await dire(page, 'Chaque employé a son propre compte : on sait qui a fait quoi. Menu Réglages, puis « Utilisateurs ».');
      await menu(page, 'Réglages', /Utilisateurs/);
      await cliquer(page, page.getByRole('button', { name: /Ajouter un employé/ }).first(), 900);
      const m = modal(page);
      await dire(page, 'Son nom, son identifiant de connexion et son code secret.');
      await taper(page, m.getByLabel('Nom complet'), 'Brice Tchoua');
      await taper(page, m.getByLabel('Identifiant'), 'brice');
      await taper(page, m.getByLabel('Code secret').first(), '4321');
      await dire(page, 'Le rôle donne les droits : un caissier vend et encaisse, mais ne touche pas aux prix ni aux réglages.');
      const role = m.getByLabel('Rôle').first();
      await choisir(page, role, 'Caissier');
      await dire(page, 'Donnez-lui sa caisse : sans caisse, il ne peut pas vendre.');
      const caisse = m.getByLabel('Caisse espèces').first();
      await choisir(page, caisse, 1);
      await dire(page, 'Enregistrez. Il se connecte ensuite avec son identifiant et son code, ou en scannant son badge.');
      await cliquer(page, m.getByRole('button', { name: /^Enregistrer/ }).last(), 1500);
      await dire(page, 'Son badge peut être imprimé tout de suite, ou plus tard depuis sa fiche.');
      const annuler = modal(page).getByRole('button', { name: /Annuler/ }).first();
      if (await annuler.count()) await cliquer(page, annuler, 900);
      await attendre(page);
      await closeAll(page);
    });

    await chapitre(page, '10-faire-une-sauvegarde', 'Vidéo 10', 'Sauvegarder vos données', 'Une copie de sécurité, aussi sur une clé USB.', async () => {
      await dire(page, 'Le logiciel sauvegarde tout seul, chaque jour. Menu Réglages, « Sauvegardes », pour le vérifier.');
      await menu(page, 'Réglages', /Sauvegardes/);
      await dire(page, "Gardez aussi une copie hors du PC : en cas de vol ou de panne, c'est elle qui sauve vos ventes.");
      await page.mouse.move(800, 500, { steps: 15 });
      await dire(page, '« Sauvegarder maintenant » fait une copie tout de suite. « Copier sur une clé USB » la met sur votre clé.');
      await cliquer(page, page.getByRole('button', { name: 'Sauvegarder maintenant' }).first(), 1500);
      await dire(page, 'La liste montre chaque sauvegarde et son état. « Vérifiée » : elle est bonne.');
      await page.mouse.move(1000, 760, { steps: 15 });
      await attendre(page);
      await closeAll(page);
    });

    await chapitre(page, '11-fermer-la-caisse', 'Vidéo 11', 'Fermer la caisse le soir', 'Compter le tiroir, valider, imprimer le Z.', async () => {
      await dire(page, 'Le soir, on ferme la caisse. Menu Trésorerie, « Opérations de trésorerie », puis « Fermer la caisse ».');
      await menu(page, 'Trésorerie', 'Opérations de trésorerie');
      await cliquer(page, page.getByRole('button', { name: 'Fermer la caisse…' }).first(), 1200);
      await dire(page, "Comptez les espèces du tiroir, coupure par coupure. Le montant attendu ne s'affiche qu'après le comptage.");
      const champs = modal(page).locator('input');
      for (const [n, q] of [[0, '6'], [1, '1'], [2, '2'], [4, '1'], [5, '2']] as const) await taper(page, champs.nth(n), q);
      await dire(page, "Validez le comptage : le logiciel compare avec ce qu'il devrait y avoir.");
      await cliquer(page, modal(page).getByRole('button', { name: /Valider le comptage/ }).first(), 1500);
      await dire(page, "Ici la caisse tombe juste. S'il y a un écart, notez-en la raison. Puis « Clôturer » : le rapport Z de la journée est créé.");
      await page.mouse.move(900, 600, { steps: 15 });
      await attendre(page);
      const fin = modal(page).getByRole('button', { name: /Clôturer|Fermer la caisse|Confirmer/ }).last();
      if (await fin.count()) await cliquer(page, fin, 1800);
      await dire(page, "Imprimez le Z avec « Imprimer le Z ». La caisse reste fermée jusqu'à demain matin.");
      await attendre(page);
      await page.screenshot({ path: join(OUT, 'fin-11.png') });
      await closeAll(page);
    });
  } finally {
    await carton(page, '', 'Fin', 'Retrouvez tous les détails dans le manuel d\'utilisation.').catch(() => undefined);
    await page.waitForTimeout(2500);
    writeFileSync(join(OUT, 'chapitres.json'), JSON.stringify({ video: await page.video()?.path(), cartons, chapitres }, null, 2));
    await app.close();
  }
});
