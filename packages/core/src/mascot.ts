/**
 * Le logo ONIX 360 et les mascottes. Le logo reprend des lames courbes en
 * relief qui tournent autour d'un œil dont l'iris est un graphique en anneau.
 * Les six humeurs du logiciel sont jouées par Awa, la caissière, et Paul, le
 * gérant. Tout est dessiné en SVG, sans fichier image, pour l'écran comme pour
 * les documents.
 */

const C = {
  onyx: '#0f1a17',
  onyx2: '#22332c',
  green: '#1f7a5c',
  green2: '#2e9c74',
  deep: '#0f4a37',
  mint: '#8fd3b6',
  gold: '#f2b705',
  white: '#ffffff',
};
const FONT = "'Segoe UI', Arial, sans-serif";

/**
 * Humeurs de la mascotte et leur usage :
 * veille (connexion, pages vides), bonjour (accueil, bienvenue),
 * compte (clôture, inventaire, impression), alerte (erreur, stock bas, écart),
 * bravo (action réussie, clôture juste), dort (caisse fermée, fin de journée).
 */
export type MascotMood = 'veille' | 'bonjour' | 'compte' | 'alerte' | 'bravo' | 'dort';
export const MASCOT_MOODS: MascotMood[] = ['veille', 'bonjour', 'compte', 'alerte', 'bravo', 'dort'];

let uid = 0;

const rad = (a: number) => (a * Math.PI) / 180;
/** Arc de cercle de a0 à a1 degrés (sens horaire). */
function arc(cx: number, cy: number, r: number, a0: number, a1: number): string {
  const p = (a: number) => `${(cx + r * Math.cos(rad(a))).toFixed(2)} ${(cy + r * Math.sin(rad(a))).toFixed(2)}`;
  return `M${p(a0)}A${r} ${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${p(a1)}`;
}

/** Les parts du graphique de l'iris : or, vert, vert foncé, menthe (couleur, puis gris pour le noir et blanc). */
const PARTS: [number, number, string, string][] = [
  [0, 150, C.gold, '#000'],
  [150, 250, C.green2, '#555'],
  [250, 330, C.deep, '#000'],
  [330, 360, C.mint, '#999'],
];
function donut(cx: number, cy: number, r: number, width: number, gap: number, mono = false): string {
  return PARTS.map(
    ([a, b, col, grey]) => `<path d="${arc(cx, cy, r, a - 90 + gap, b - 90 - gap)}" fill="none" stroke="${mono ? grey : col}" stroke-width="${width}"/>`,
  ).join('');
}

// Lames du logo, dans un carré de 512.
const BLADES = {
  arc: 'M342 113C300 80 200 70 150 130C118 170 128 240 180 270C222 293 282 290 312 263C280 279 232 280 202 252C176 226 174 162 210 130C250 98 310 100 342 113Z',
  right: 'M335 160C392 180 422 240 413 292C405 350 360 400 300 419C344 380 368 322 365 266C363 222 352 186 335 160Z',
  sweep: 'M343 195C354 268 322 338 252 372C212 390 172 393 144 385C178 410 222 426 266 423C302 420 326 398 340 356C352 314 353 250 343 195Z',
  plume1: 'M112 150C86 200 98 272 160 303C205 323 260 319 292 299C240 306 175 290 141 250C113 218 108 180 112 150Z',
  plume2: 'M83 260C94 322 150 376 220 379C272 381 306 346 321 292C296 330 252 341 200 335C150 329 104 300 83 260Z',
  glow: 'M366 262C366 322 344 378 302 417',
};

/** Le symbole du logo dans un carré de 512. `mono` : noir et blanc (ticket). */
export function logoSvg({ mono = false }: { mono?: boolean } = {}): string {
  const u = `onix${++uid}`;
  const grad = (id: string, a: string, b: string, x2: number, y2: number) =>
    `<linearGradient id="${u}${id}" x1="0" y1="0" x2="${x2}" y2="${y2}"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient>`;
  const blade = (d: string, fill: string) =>
    mono
      ? `<path d="${d}" fill="#000" stroke="#fff" stroke-width="6" stroke-linejoin="round"/>`
      : `<path d="${d}" fill="${fill}" filter="url(#${u}s)"/><path d="${d}" fill="none" stroke="#fff" stroke-opacity=".75" stroke-width="2.4" stroke-linejoin="round"/>`;
  const eye = `<g transform="translate(266 192) scale(2.75)"${mono ? '' : ` filter="url(#${u}e)"`}>${mono ? '<circle r="26" fill="#fff"/>' : ''}${donut(0, 0, 17.5, 11, 4, mono)}<circle r="10" fill="${mono ? '#000' : C.onyx}"/>${mono ? '' : '<circle cx="4" cy="-4.5" r="3.2" fill="#fff"/>'}</g>`;
  const defs = mono
    ? ''
    : `<defs>${grad('a', '#5cc79f', C.green, 0.7, 1)}${grad('b', C.green2, C.deep, 1, 1)}${grad('c', '#bfe6d4', '#5aa98a', 0, 1)}${grad('t', C.deep, '#082a20', 1, 0.6)}
<filter id="${u}s" x="-20%" y="-20%" width="150%" height="150%"><feDropShadow dx="6" dy="9" stdDeviation="7" flood-color="#000" flood-opacity=".38"/></filter>
<filter id="${u}e" x="-30%" y="-30%" width="160%" height="160%"><feDropShadow dx="3" dy="5" stdDeviation="4" flood-color="#000" flood-opacity=".3"/></filter></defs>`;
  return (
    defs +
    blade(BLADES.sweep, `url(#${u}c)`) +
    blade(BLADES.plume2, `url(#${u}t)`) +
    blade(BLADES.plume1, `url(#${u}t)`) +
    blade(BLADES.arc, `url(#${u}a)`) +
    blade(BLADES.right, `url(#${u}b)`) +
    (mono ? '' : `<path d="${BLADES.glow}" fill="none" stroke="${C.gold}" stroke-width="5" stroke-linecap="round"/>`) +
    eye
  );
}

/** Le symbole seul, en document SVG complet. */
export function logoDoc(opts: { mono?: boolean; size?: number } = {}): string {
  const s = opts.size ?? 512;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="${s}" height="${s}">${logoSvg(opts)}</svg>`;
}

/** Les deux personnages : Awa, la caissière (caisse et vente), et Paul, le gérant (administration). */
export type MascotWho = 'awa' | 'paul';
const PEOPLE: Record<MascotWho, { skin: string; skin2: string; shirt: string; shirt2: string; hair: string }> = {
  awa: { skin: '#8a5a3b', skin2: '#6e4529', shirt: C.green, shirt2: C.deep, hair: '#1b1410' },
  paul: { skin: '#6b4229', skin2: '#53321e', shirt: C.deep, shirt2: '#0a3326', hair: '#16100c' },
};
type EyeKind = 'open' | 'closed' | 'happy' | 'wide' | 'down';
const EYES: Record<MascotMood, [EyeKind, EyeKind]> = {
  veille: ['open', 'open'],
  bonjour: ['open', 'closed'],
  alerte: ['wide', 'wide'],
  compte: ['down', 'down'],
  dort: ['closed', 'closed'],
  bravo: ['happy', 'happy'],
};
const MOUTHS: Record<MascotMood, string> = {
  veille: `<path d="M90 126q10 7 20 0" fill="none" stroke="#4a1f14" stroke-width="3" stroke-linecap="round"/>`,
  bonjour: `<path d="M86 123q14 14 28 0z" fill="#4a1f14"/><path d="M90 124h20" stroke="${C.white}" stroke-width="3"/>`,
  compte: `<path d="M92 127q8 2 16 0" fill="none" stroke="#4a1f14" stroke-width="3" stroke-linecap="round"/>`,
  alerte: `<ellipse cx="100" cy="128" rx="6" ry="7.5" fill="#4a1f14"/>`,
  bravo: `<path d="M84 121q16 18 32 0z" fill="#4a1f14"/><path d="M88 122h24" stroke="${C.white}" stroke-width="3.4"/><path d="M93 131q7 3 14 0" stroke="#c4473a" stroke-width="3" fill="none" stroke-linecap="round"/>`,
  dort: `<ellipse cx="100" cy="128" rx="4" ry="3" fill="#4a1f14"/>`,
};

/**
 * La mascotte : Awa ou Paul derrière le comptoir, dans un cadre de 200 × 230.
 * `counter` : avec le comptoir (par défaut).
 */
export function mascotSvg(mood: MascotMood = 'veille', { who = 'awa', counter = true }: { who?: MascotWho; counter?: boolean } = {}): string {
  const p = PEOPLE[who];
  const u = `perso${++uid}`;
  const awa = who === 'awa';
  const eye = (x: number, k: EyeKind) => {
    const y = 104;
    if (k === 'closed') return `<path d="M${x - 8} ${y}q8 6 16 0" fill="none" stroke="${C.onyx}" stroke-width="3.4" stroke-linecap="round"/>`;
    if (k === 'happy') return `<path d="M${x - 8} ${y + 3}q8 -9 16 0" fill="none" stroke="${C.onyx}" stroke-width="3.6" stroke-linecap="round"/>`;
    const big = k === 'wide';
    const dy = k === 'down' ? 3 : 0;
    return (
      `<ellipse cx="${x}" cy="${y}" rx="${big ? 9.5 : 8}" ry="${big ? 10.5 : 9}" fill="${C.white}"/>` +
      `<circle cx="${x}" cy="${y + dy + 1}" r="${big ? 4.6 : 5.6}" fill="#3a2214"/><circle cx="${x}" cy="${y + dy + 1}" r="${big ? 2.4 : 3}" fill="${C.onyx}"/>` +
      `<circle cx="${x + 2}" cy="${y + dy - 1.5}" r="1.6" fill="${C.white}"/>` +
      (awa ? `<path d="M${x - 9} ${y - 6}l-3 -3M${x + 9} ${y - 6}l3 -3" stroke="${C.onyx}" stroke-width="1.6" stroke-linecap="round"/>` : '')
    );
  };
  const [eyeL, eyeR] = EYES[mood];
  const browY = mood === 'alerte' ? 84 : 89;
  const brows =
    mood === 'compte'
      ? `<path d="M76 90q8 -2 16 1M108 91q8 -3 16 -1" fill="none" stroke="${p.hair}" stroke-width="3.4" stroke-linecap="round"/>`
      : `<path d="M76 ${browY}q8 -5 16 0M108 ${browY}q8 -5 16 0" fill="none" stroke="${p.hair}" stroke-width="3.4" stroke-linecap="round"/>`;
  const lip = awa && (mood === 'veille' || mood === 'compte') ? `<path d="M90 126q10 7 20 0" fill="none" stroke="#a8432f" stroke-width="1.4" opacity=".7"/>` : '';

  // Cheveux : foulard vert et or pour Awa ; cheveux courts, barbe et lunettes dorées pour Paul.
  let hairBack = '';
  let hairTop: string;
  let face: string;
  if (awa) {
    hairBack = `<ellipse cx="100" cy="98" rx="44" ry="48" fill="${p.hair}"/>`;
    hairTop = `<path d="M54 98C46 54 78 30 108 32C146 34 160 66 148 98C138 76 120 70 100 70C80 70 62 78 54 98Z" fill="url(#${u}w)"/>
<path d="M58 86C80 70 122 66 146 86" fill="none" stroke="${C.gold}" stroke-width="3" stroke-dasharray="1 7" stroke-linecap="round"/>
<path d="M64 70C86 56 120 54 140 68" fill="none" stroke="${C.gold}" stroke-width="3" stroke-dasharray="1 7" stroke-linecap="round"/>
<path d="M128 40C150 22 172 34 160 50C152 44 140 44 132 50Z" fill="${C.green2}"/><path d="M128 42C140 30 160 30 160 50" fill="none" stroke="${C.gold}" stroke-width="2"/>`;
    face = `<circle cx="60" cy="118" r="4.5" fill="${C.gold}"/><circle cx="140" cy="118" r="4.5" fill="${C.gold}"/>
<ellipse cx="78" cy="118" rx="7" ry="4" fill="#c4473a" opacity=".22"/><ellipse cx="122" cy="118" rx="7" ry="4" fill="#c4473a" opacity=".22"/>`;
  } else {
    hairTop = `<path d="M60 98C56 56 84 48 100 48C118 48 146 56 140 98C136 80 128 70 120 68C104 64 92 70 80 68C70 72 64 82 60 98Z" fill="${p.hair}"/>
<path d="M62 104C62 92 64 88 66 86" stroke="${p.hair}" stroke-width="5" stroke-linecap="round"/><path d="M138 104C138 92 136 88 134 86" stroke="${p.hair}" stroke-width="5" stroke-linecap="round"/>`;
    face = `<path d="M66 112C66 150 134 150 134 112C130 130 120 142 100 142C80 142 70 130 66 112Z" fill="${p.hair}"/>
<path d="M86 118q14 -6 28 0" stroke="${p.hair}" stroke-width="4.5" fill="none" stroke-linecap="round"/>
<rect x="72" y="94" width="25" height="19" rx="7" fill="none" stroke="${C.gold}" stroke-width="2.6"/><rect x="103" y="94" width="25" height="19" rx="7" fill="none" stroke="${C.gold}" stroke-width="2.6"/><path d="M97 101h6" stroke="${C.gold}" stroke-width="2.6"/>`;
  }

  // Tenue : polo vert avec badge ONIX pour Awa ; veste, chemise blanche et cravate dorée pour Paul.
  const torso = `<path d="M30 230C30 190 44 170 70 162L130 162C156 170 170 190 170 230Z" fill="url(#${u}s)"/>`;
  const collar = awa
    ? `<path d="M80 160L100 182L120 160L112 156L100 168L88 156Z" fill="${C.gold}"/><rect x="118" y="186" width="30" height="13" rx="3" fill="${C.white}"/><text x="133" y="195.5" text-anchor="middle" font-family="${FONT}" font-weight="700" font-size="7.5" fill="${C.green}">ONIX</text>`
    : `<path d="M82 162L100 214L118 162Z" fill="${C.white}"/><path d="M96 170h8l3 34l-7 10l-7 -10z" fill="${C.gold}"/><path d="M82 162L96 196L88 200L74 166Z" fill="${p.shirt2}"/><path d="M118 162L104 196L112 200L126 166Z" fill="${p.shirt2}"/>`;

  // Bras et gestes.
  const sleeve = (d: string) => `<path d="${d}" fill="url(#${u}s)"/>`;
  const hand = (x: number, y: number, r = 11) => `<circle cx="${x}" cy="${y}" r="${r}" fill="${p.skin}"/>`;
  const palm = (x: number, y: number, rot: number) =>
    `<g transform="rotate(${rot} ${x} ${y})"><rect x="${x - 10}" y="${y - 14}" width="20" height="24" rx="9" fill="${p.skin}"/>` +
    `<path d="M${x - 6} ${y - 14}v-8M${x - 1} ${y - 15}v-10M${x + 4} ${y - 14}v-9" stroke="${p.skin}" stroke-width="5.5" stroke-linecap="round"/><path d="M${x + 10} ${y - 2}l7 -6" stroke="${p.skin}" stroke-width="5.5" stroke-linecap="round"/></g>`;
  const restL = sleeve('M44 196C40 206 48 214 62 214L74 214L70 196Z') + hand(74, 206);
  const restR = sleeve('M156 196C160 206 152 214 138 214L126 214L130 196Z') + hand(126, 206);
  const raisedR = sleeve('M146 172C160 160 168 140 170 118L184 122C184 150 174 176 158 192Z') + palm(176, 104, 12);
  let arms = restL + restR;
  if (mood === 'bonjour') arms = restL + raisedR;
  else if (mood === 'bravo') arms = sleeve('M54 172C40 160 32 140 30 118L16 122C16 150 26 176 42 192Z') + palm(24, 104, -12) + raisedR;
  else if (mood === 'alerte') arms = restL + sleeve('M150 176C164 170 168 152 160 138L148 142C152 150 148 160 140 166Z') + hand(146, 136);
  else if (mood === 'compte') arms = '';

  const star = (x: number, y: number, s: number) =>
    `<path d="M${x} ${y - s}q${s * 0.2} ${s * 0.8} ${s} ${s}q${-s * 0.8} ${s * 0.2} ${-s} ${s}q${-s * 0.2} ${-s * 0.8} ${-s} ${-s}q${s * 0.8} ${-s * 0.2} ${s} ${-s}z" fill="${C.gold}"/>`;
  const extra = {
    veille: '',
    compte: `<g transform="rotate(-6 100 186)"><rect x="76" y="160" width="48" height="58" rx="3" fill="${C.white}" stroke="${C.onyx}" stroke-width="2"/>
<text x="100" y="174" text-anchor="middle" font-family="${FONT}" font-weight="700" font-size="8" fill="${C.onyx}">ONIX</text>
<path d="M84 181h32M84 189h24M84 197h32" stroke="${C.onyx}" stroke-width="2" opacity=".55"/><path d="M84 207h32" stroke="${C.green}" stroke-width="3.5"/></g>${hand(76, 196, 10)}${hand(124, 192, 10)}`,
    alerte: `<circle cx="172" cy="46" r="20" fill="${C.gold}" stroke="${C.onyx}" stroke-width="2"/><rect x="169" y="33" width="6" height="17" rx="3" fill="${C.onyx}"/><circle cx="172" cy="57" r="3.4" fill="${C.onyx}"/>`,
    dort: `<path d="M24 22a20 20 0 1 0 22 30a16 16 0 1 1 -22 -30z" fill="${C.gold}"/>
<text x="152" y="58" font-family="${FONT}" font-weight="700" font-size="22" fill="${C.green2}">z</text><text x="168" y="40" font-family="${FONT}" font-weight="700" font-size="15" fill="${C.green2}">z</text><text x="180" y="26" font-family="${FONT}" font-weight="700" font-size="10" fill="${C.green2}">z</text>`,
    bravo: star(48, 40, 7) + star(152, 30, 8) + star(100, 14, 6),
    bonjour: `<path d="M188 70q8 6 6 16M196 62q12 10 8 26" fill="none" stroke="${C.gold}" stroke-width="3.5" stroke-linecap="round"/>`,
  }[mood];
  const tilt = mood === 'dort' ? 'rotate(-9 100 150)' : mood === 'alerte' ? 'translate(0 -3)' : '';
  return `<defs><linearGradient id="${u}s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${p.shirt}"/><stop offset="1" stop-color="${p.shirt2}"/></linearGradient>
<linearGradient id="${u}w" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${C.green2}"/><stop offset="1" stop-color="${C.deep}"/></linearGradient></defs>
${torso}${collar}
<rect x="88" y="138" width="24" height="28" rx="6" fill="${p.skin2}"/>
<g transform="${tilt}">${hairBack}
<circle cx="60" cy="106" r="9" fill="${p.skin2}"/><circle cx="140" cy="106" r="9" fill="${p.skin2}"/>
<ellipse cx="100" cy="104" rx="40" ry="45" fill="${p.skin}"/>
${face}${hairTop}${eye(84, eyeL)}${eye(116, eyeR)}${brows}
<path d="M97 106q-3 10 -5 12q8 3 16 0q-2 -2 -5 -12" fill="${p.skin2}" opacity=".7"/>${MOUTHS[mood]}${lip}</g>
${counter ? `<rect x="6" y="208" width="188" height="22" rx="6" fill="${C.onyx2}"/><rect x="6" y="208" width="188" height="5" rx="2.5" fill="${C.green2}"/>` : ''}
${arms}${extra}`;
}

/** La mascotte en document SVG complet. */
export function mascotDoc(mood: MascotMood = 'veille', opts: { who?: MascotWho; counter?: boolean } = {}): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 230">${mascotSvg(mood, opts)}</svg>`;
}

/**
 * Icône du logiciel (carré menthe, logo) et icône du serveur (carré onyx
 * cerclé d'or, logo et pastille « serveur ») : deux icônes différentes pour
 * ne pas confondre les raccourcis sur le bureau.
 */
export function iconDoc(kind: 'app' | 'server', size = 256): string {
  if (kind === 'app')
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="${size}" height="${size}"><defs><linearGradient id="ia" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f4fbf7"/><stop offset="1" stop-color="#cdeedd"/></linearGradient></defs>
<rect width="512" height="512" rx="112" fill="url(#ia)"/><rect x="8" y="8" width="496" height="496" rx="104" fill="none" stroke="${C.green}" stroke-width="16"/><g transform="translate(16 10) scale(.94)">${logoSvg()}</g></svg>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="${size}" height="${size}">
<rect width="512" height="512" rx="112" fill="${C.onyx}"/><rect x="15" y="15" width="482" height="482" rx="97" fill="none" stroke="${C.gold}" stroke-width="20"/>
<g transform="translate(20 14) scale(.8)">${logoSvg()}</g>
<g transform="translate(336 320) scale(3.9)"><rect x="0" y="0" width="36" height="38" rx="7" fill="${C.gold}"/>
<rect x="6" y="6" width="24" height="7" rx="2" fill="${C.onyx}"/><rect x="6" y="16" width="24" height="7" rx="2" fill="${C.onyx}"/><rect x="6" y="26" width="24" height="7" rx="2" fill="${C.onyx}"/>
<circle cx="25" cy="9.5" r="1.8" fill="${C.green2}"/><circle cx="25" cy="19.5" r="1.8" fill="${C.green2}"/><circle cx="25" cy="29.5" r="1.8" fill="${C.green2}"/></g></svg>`;
}
