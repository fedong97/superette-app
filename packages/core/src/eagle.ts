/**
 * L'aigle ONIX : la tête (symbole du logiciel) et la mascotte avec ses six
 * humeurs. Tout est dessiné en SVG, sans fichier image, pour l'écran comme
 * pour les documents.
 */

const C = {
  onyx: '#0f1a17',
  onyx2: '#22332c',
  green: '#1f7a5c',
  green2: '#2e9c74',
  deep: '#0f4a37',
  mint: '#8fd3b6',
  mint2: '#e2f5ec',
  gold: '#f2b705',
  gold3: '#c58f00',
  white: '#ffffff',
  wood: '#7a4f27',
};
const FONT = "'Segoe UI', Arial, sans-serif";

/**
 * Humeurs de la mascotte et leur usage :
 * veille (connexion, pages vides), bonjour (accueil, bienvenue),
 * compte (clôture, inventaire, impression), alerte (erreur, stock bas, écart),
 * bravo (action réussie, clôture juste), dort (caisse fermée, fin de journée).
 */
export type EagleMood = 'veille' | 'bonjour' | 'compte' | 'alerte' | 'bravo' | 'dort';
export const EAGLE_MOODS: EagleMood[] = ['veille', 'bonjour', 'compte', 'alerte', 'bravo', 'dort'];

let uid = 0;

/** Tête d'aigle de profil, dans un carré de 100. `mono` : noir et blanc (ticket). */
export function eagleHeadSvg({ mono = false, dark = false }: { mono?: boolean; dark?: boolean } = {}): string {
  const body = mono ? '#000' : dark ? '#344c43' : C.onyx;
  const gold = mono ? '#fff' : C.gold;
  const chest = mono ? '#000' : C.green;
  return `<path d="M14 96L18 70L6 64L19 56L8 46L24 42L18 30L34 30C40 20 50 14 62 14C74 14 83 20 88 30L90 40L68 46L62 58C72 66 74 82 66 96Z" fill="${body}"/>
<path d="M18 74C32 70 48 70 61 61C69 72 70 85 66 96H16Z" fill="${chest}"/>
<path d="M78 28C92 28 99 38 97 51C96 57 90 59 88 54C90 47 87 42 81 42L66 45Z" fill="${gold}"/>
<path d="M67 47H85C83 51 77 53 70 53Z" fill="${mono ? '#fff' : C.gold3}"/>
${mono ? '' : `<path d="M36 30C40 20 50 15 62 15C74 15 82 21 86 30L88 40L68 45L60 56C50 54 40 46 36 30Z" fill="${C.mint2}"/>`}
<path d="M48 26L72 28" stroke="${mono ? '#fff' : C.onyx}" stroke-width="4" stroke-linecap="round"/>
<circle cx="61" cy="35" r="6.5" fill="${gold}"/><circle cx="62" cy="35.5" r="3.2" fill="${mono ? '#000' : C.onyx}"/><circle cx="63.5" cy="33.6" r="1.3" fill="#fff"/>`;
}

/** La tête seule, en document SVG complet. */
export function eagleHeadDoc(opts: { mono?: boolean; dark?: boolean; size?: number } = {}): string {
  const s = opts.size ?? 100;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="${s}" height="${s}">${eagleHeadSvg(opts)}</svg>`;
}

/** Mascotte de profil (tournée vers la droite), dans un cadre de 200 × 230. */
export function eagleMascotSvg(mood: EagleMood = 'veille', { branch = true, dark = false }: { branch?: boolean; dark?: boolean } = {}): string {
  const u = `aigle${++uid}`;
  const b1 = dark ? '#3d574d' : C.onyx2;
  const b2 = dark ? '#26392f' : C.onyx;
  const kind = { veille: 'open', bonjour: 'wink', alerte: 'wide', compte: 'down', dort: 'closed', bravo: 'happy' }[mood];
  const ex = 124;
  const ey = 64;
  let eye: string;
  if (kind === 'closed' || kind === 'wink') eye = `<path d="M${ex - 10} ${ey}q10 8 20 0" fill="none" stroke="${C.onyx}" stroke-width="4.5" stroke-linecap="round"/>`;
  else if (kind === 'happy') eye = `<path d="M${ex - 10} ${ey + 4}q10 -12 20 0" fill="none" stroke="${C.onyx}" stroke-width="4.5" stroke-linecap="round"/>`;
  else {
    const dy = kind === 'down' ? 4 : 0;
    const r = kind === 'wide' ? 13 : 11;
    const pr = kind === 'wide' ? 3.8 : 5.5;
    eye =
      `<circle cx="${ex}" cy="${ey}" r="${r}" fill="${C.gold}" stroke="${C.onyx}" stroke-width="2"/><circle cx="${ex + 2}" cy="${ey + dy + 1}" r="${pr}" fill="${C.onyx}"/><circle cx="${ex + 5}" cy="${ey + dy - 3}" r="2.4" fill="${C.white}"/>` +
      (kind === 'wide' ? '' : `<path d="M108 48L140 53" stroke="${C.onyx}" stroke-width="5" stroke-linecap="round"/>`);
  }
  const raised = mood === 'bravo' || mood === 'bonjour';
  const wing = raised
    ? `<path d="M74 122C52 96 46 60 62 30L68 44L76 32L80 48L88 40C88 70 92 96 98 116Z" fill="${C.green}"/>`
    : `<path d="M62 108C40 148 48 194 82 210L84 198L92 206C98 172 92 134 62 108Z" fill="${C.green}"/><path d="M66 132C60 156 64 178 80 192" stroke="${C.deep}" stroke-width="3" fill="none" stroke-linecap="round" opacity=".6"/>`;
  let chev = '';
  for (let r = 0; r < 4; r++)
    for (let k = 0; k < (r % 2 ? 2 : 3); k++) {
      const x = 98 + k * 16 + (r % 2 ? 8 : 0);
      const y = 134 + r * 14;
      chev += `<path d="M${x - 6} ${y}q6 7 12 0" fill="none" stroke="${C.gold}" stroke-width="2.4" stroke-linecap="round"/>`;
    }
  const star = (x: number, y: number, s: number) =>
    `<path d="M${x} ${y - s}q${s * 0.2} ${s * 0.8} ${s} ${s}q${-s * 0.8} ${s * 0.2} ${-s} ${s}q${-s * 0.2} ${-s * 0.8} ${-s} ${-s}q${s * 0.8} ${-s * 0.2} ${s} ${-s}z" fill="${C.gold}"/>`;
  const extra = {
    compte: `<g transform="rotate(8 132 150)"><rect x="112" y="122" width="42" height="56" rx="3" fill="${C.white}" stroke="${C.onyx}" stroke-width="2"/>
<text x="133" y="135" text-anchor="middle" font-family="${FONT}" font-weight="700" font-size="7.5" fill="${C.onyx}">ONIX</text>
<path d="M118 142h30M118 149h22M118 156h30" stroke="${C.onyx}" stroke-width="1.8" opacity=".55"/><path d="M118 166h30" stroke="${C.green}" stroke-width="3"/></g>`,
    alerte: `<circle cx="176" cy="30" r="20" fill="${C.gold}"/><rect x="173" y="17" width="6" height="17" rx="3" fill="${C.onyx}"/><circle cx="176" cy="41" r="3.4" fill="${C.onyx}"/>`,
    dort: `<path d="M30 22a20 20 0 1 0 22 30a16 16 0 1 1 -22 -30z" fill="${C.gold}"/>
<text x="150" y="30" font-family="${FONT}" font-weight="700" font-size="22" fill="${C.green2}">z</text><text x="166" y="16" font-family="${FONT}" font-weight="700" font-size="15" fill="${C.green2}">z</text><text x="178" y="6" font-family="${FONT}" font-weight="700" font-size="10" fill="${C.green2}">z</text>`,
    bravo: star(36, 24, 8) + star(160, 22, 7) + star(28, 70, 5),
    bonjour: `<path d="M40 26q-8 8-4 18M30 18q-12 12-6 28" fill="none" stroke="${C.gold}" stroke-width="3.5" stroke-linecap="round"/>`,
    veille: '',
  }[mood];
  return `<defs><linearGradient id="${u}b" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${b1}"/><stop offset="1" stop-color="${b2}"/></linearGradient><linearGradient id="${u}h" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#cfe9dc"/></linearGradient></defs>
${branch ? `<rect x="14" y="210" width="172" height="12" rx="6" fill="${C.wood}"/><path d="M150 214q14-10 26-6" stroke="${C.green2}" stroke-width="6" stroke-linecap="round" fill="none"/>` : ''}
<path d="M70 186L44 224L72 216L78 228L92 206Z" fill="${b2}"/>
<ellipse cx="96" cy="148" rx="54" ry="68" fill="url(#${u}b)" transform="rotate(-8 96 148)"/>
<ellipse cx="112" cy="158" rx="32" ry="46" fill="${dark ? '#4a665b' : '#2c4239'}"/>
${chev}
${wing}
<path d="M86 52L62 40L80 64L56 66L80 80L62 90L88 96L100 106Z" fill="url(#${u}h)"/>
<circle cx="112" cy="70" r="38" fill="url(#${u}h)"/>
${eye}
<path d="M136 70C158 66 172 80 168 98C166 106 158 106 156 100C160 90 156 84 148 84L132 86Z" fill="${C.gold}"/>
<path d="M134 88H152C150 94 142 96 136 96Z" fill="${C.gold3}"/>
<path d="M96 208v10M104 208v10M118 208v10M126 208v10" stroke="${C.gold}" stroke-width="5" stroke-linecap="round"/>
${extra}`;
}

/** La mascotte en document SVG complet. */
export function eagleMascotDoc(mood: EagleMood = 'veille', opts: { branch?: boolean; dark?: boolean } = {}): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 230">${eagleMascotSvg(mood, opts)}</svg>`;
}

/**
 * Icône du logiciel (carré arrondi vert, tête d'aigle) et icône du serveur
 * (carré onyx cerclé d'or, tête d'aigle et pastille « serveur ») : deux icônes
 * différentes pour ne pas confondre les raccourcis sur le bureau.
 */
export function eagleIconDoc(kind: 'app' | 'server', size = 256): string {
  const head = eagleHeadSvg();
  if (kind === 'app')
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="${size}" height="${size}"><defs><linearGradient id="ia" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${C.green2}"/><stop offset="1" stop-color="${C.deep}"/></linearGradient></defs>
<rect width="100" height="100" rx="22" fill="url(#ia)"/><g transform="translate(9 8) scale(.8)">${head}</g></svg>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="${size}" height="${size}">
<rect width="100" height="100" rx="22" fill="${C.onyx}"/><rect x="3" y="3" width="94" height="94" rx="19" fill="none" stroke="${C.gold}" stroke-width="4"/>
<g transform="translate(6 6) scale(.72)">${eagleHeadSvg({ dark: true })}</g>
<g transform="translate(58 56)"><rect x="0" y="0" width="36" height="38" rx="7" fill="${C.gold}"/>
<rect x="6" y="6" width="24" height="7" rx="2" fill="${C.onyx}"/><rect x="6" y="16" width="24" height="7" rx="2" fill="${C.onyx}"/><rect x="6" y="26" width="24" height="7" rx="2" fill="${C.onyx}"/>
<circle cx="25" cy="9.5" r="1.8" fill="${C.green2}"/><circle cx="25" cy="19.5" r="1.8" fill="${C.green2}"/><circle cx="25" cy="29.5" r="1.8" fill="${C.green2}"/></g></svg>`;
}
