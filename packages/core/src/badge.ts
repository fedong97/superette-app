import { brandPalette, contrast } from './brand';
import { barcodeWithDigitsSvg } from './labels';

/**
 * Badge du personnel (Administration › Couleurs et badges), aux couleurs de
 * l'entreprise. Trois modèles :
 * - « Bandeau » (par défaut) : logo en haut à gauche, rôle en grand en haut à
 *   droite, photo à gauche, matricule, nom, poste et expiration au centre,
 *   code-barres vertical à droite, bandeau décoré en bas ;
 * - « Arcs » : vertical, photo ronde dans un grand arc de couleur ;
 * - « Angles » : vertical, bandes géométriques sur les côtés, photo carrée.
 * Un verso (règlement, dates, signature) peut s'imprimer à côté du recto.
 */
export interface BadgeLayout {
  model: BadgeModel;
  /** Carte bancaire (85,6 × 54 mm), grand badge (100 × 70 mm) ou format libre. */
  size: BadgeSize;
  /** Format libre, en mm, mesuré à l'horizontale (largeur ≥ hauteur). */
  width: number;
  height: number;
  /** Badge vertical (tenu par un cordon) ; les modèles « Arcs » et « Angles » le sont toujours. */
  portrait: boolean;
  /** Texte libre sous le nom du magasin (slogan, « Badge du personnel ») ; vide : rien. */
  title: string;
  showLogo: boolean;
  showStore: boolean;
  showRole: boolean;
  showPhoto: boolean;
  showNumber: boolean;
  showPosition: boolean;
  showPhone: boolean;
  showExpiry: boolean;
  showBarcode: boolean;
  showBand: boolean;
  /** Validité du badge à partir du jour de l'impression, en mois. */
  validityMonths: number;
  /** Imprimer aussi le verso, à côté du recto (à plier ou à coller). */
  back: boolean;
  backTitle: string;
  /** Règles imprimées au verso, une par ligne. */
  backText: string;
  /** Sous la ligne de signature du verso. */
  signature: string;
}

export type BadgeModel = 'band' | 'arc' | 'angles';
export type BadgeSize = 'card' | 'large' | 'custom';

export const BADGE_MODELS: Record<BadgeModel, string> = {
  band: 'Bandeau (horizontal ou vertical)',
  arc: 'Arcs, photo ronde (vertical)',
  angles: 'Angles, photo carrée (vertical)',
};

export const BADGE_SIZES: Record<Exclude<BadgeSize, 'custom'>, { label: string; width: number; height: number }> = {
  card: { label: 'Carte bancaire (85,6 × 54 mm)', width: 85.6, height: 54 },
  large: { label: 'Grand badge (100 × 70 mm)', width: 100, height: 70 },
};

export const DEFAULT_BADGE: BadgeLayout = {
  model: 'band',
  size: 'card',
  width: 85.6,
  height: 54,
  portrait: false,
  title: '',
  showLogo: true,
  showStore: true,
  showRole: true,
  showPhoto: true,
  showNumber: true,
  showPosition: true,
  showPhone: true,
  showExpiry: true,
  showBarcode: true,
  showBand: true,
  validityMonths: 12,
  back: false,
  backTitle: "Conditions d'utilisation",
  backText: [
    'Ce badge est personnel : il ne se prête pas.',
    'Portez-le de façon visible pendant le service.',
    'En cas de perte, prévenez tout de suite le gérant.',
  ].join('\n'),
  signature: 'La Direction',
};

/** Éléments qu'on peut afficher ou masquer, dans l'ordre de l'écran de réglage. */
export const BADGE_PARTS: [keyof BadgeLayout, string][] = [
  ['showLogo', 'Logo'],
  ['showStore', 'Nom du magasin'],
  ['showRole', 'Rôle'],
  ['showPhoto', 'Photo'],
  ['showNumber', 'Matricule'],
  ['showPosition', 'Poste'],
  ['showPhone', 'Téléphone'],
  ['showExpiry', "Date d'expiration"],
  ['showBarcode', 'Code-barres de connexion'],
  ['showBand', 'Décor aux couleurs'],
];

/** Réglages du badge reçus (paramètres du magasin) : complétés et ramenés dans leurs bornes. */
export function normalizeBadge(raw: unknown): BadgeLayout {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const out: BadgeLayout = { ...DEFAULT_BADGE };
  if (typeof r['model'] === 'string' && r['model'] in BADGE_MODELS) out.model = r['model'] as BadgeModel;
  if (r['size'] === 'card' || r['size'] === 'large' || r['size'] === 'custom') out.size = r['size'];
  const mm = (v: unknown, min: number, max: number, def: number) => {
    const n = Number(v);
    return v !== undefined && v !== null && Number.isFinite(n) ? Math.round(Math.min(max, Math.max(min, n)) * 10) / 10 : def;
  };
  out.width = mm(r['width'], 40, 150, DEFAULT_BADGE.width);
  out.height = mm(r['height'], 25, 150, DEFAULT_BADGE.height);
  if (out.height > out.width) [out.width, out.height] = [out.height, out.width];
  out.portrait = Boolean(r['portrait'] ?? DEFAULT_BADGE.portrait);
  const text = (k: keyof BadgeLayout, max: number) => {
    if (typeof r[k] === 'string') (out as unknown as Record<string, unknown>)[k] = (r[k] as string).trim().slice(0, max);
  };
  text('title', 40);
  text('backTitle', 40);
  text('signature', 40);
  if (typeof r['backText'] === 'string')
    out.backText = r['backText']
      .split('\n')
      .map((l) => l.trim().slice(0, 120))
      .filter(Boolean)
      .slice(0, 5)
      .join('\n');
  for (const [k] of BADGE_PARTS) if (k in r) (out as unknown as Record<string, unknown>)[k] = Boolean(r[k]);
  out.back = Boolean(r['back'] ?? DEFAULT_BADGE.back);
  out.validityMonths = Math.round(mm(r['validityMonths'], 1, 120, DEFAULT_BADGE.validityMonths));
  return out;
}

/** Le badge est-il vertical ? Les modèles « Arcs » et « Angles » le sont toujours. */
export const badgeIsPortrait = (l: BadgeLayout) => l.model !== 'band' || l.portrait;

/** Largeur et hauteur du badge imprimé, en mm (inversées pour un badge vertical). */
export function badgeSize(l: BadgeLayout): { width: number; height: number } {
  const s = l.size === 'custom' ? { width: l.width, height: l.height } : BADGE_SIZES[l.size];
  return badgeIsPortrait(l) ? { width: s.height, height: s.width } : { width: s.width, height: s.height };
}

/** Ce qui s'imprime sur le badge d'un employé. */
export interface BadgeCard {
  store: string;
  logo?: string | null;
  /** Nom complet de l'employé. */
  name: string;
  role: string;
  /** Poste ou service (fiche collaborateur). */
  position?: string | null;
  /** Matricule (fiche collaborateur). */
  number?: string | null;
  phone?: string | null;
  /** Date d'entrée (AAAA-MM-JJ), imprimée au verso. */
  hiredOn?: string | null;
  /** Code du badge, scanné à la connexion. */
  code: string;
  /** Photo en data URL. */
  photo?: string | null;
  /** Date d'expiration (AAAA-MM-JJ), ou rien. */
  expires?: string | null;
  color?: string | null;
  color2?: string | null;
}

/** Date d'expiration d'un badge imprimé ce jour : le même jour, `months` mois plus tard. */
export function badgeExpiry(today: Date, months: number): string {
  const d = new Date(today.getFullYear(), today.getMonth() + months, today.getDate());
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const r1 = (v: number) => Math.round(v * 100) / 100;
const frDate = (iso: string) => iso.slice(0, 10).split('-').reverse().join('/');

/** Initiales affichées à la place de la photo. */
function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('');
}

/** Bulles claires du bandeau, toujours au même endroit (le badge réimprimé est identique). */
function bokeh(w: number, h: number): string {
  let seed = 7;
  const rnd = () => (seed = (seed * 9301 + 49297) % 233280) / 233280;
  let shapes = '';
  const n = Math.round(w / 2.2);
  for (let i = 0; i < n; i++) {
    const x = r1(rnd() * w);
    const y = r1(rnd() * h);
    const r = r1(h * (0.08 + rnd() * 0.22));
    const o = r1(0.12 + rnd() * 0.3);
    shapes +=
      i % 3 === 0
        ? `<circle cx="${x}" cy="${y}" r="${r}" fill="none" stroke="#fff" stroke-width="${r1(h * 0.025)}" opacity="${o}"/>`
        : `<circle cx="${x}" cy="${y}" r="${r}" fill="#fff" opacity="${o}"/>`;
  }
  return `<svg class="bdg-bokeh" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${r1(w)} ${r1(h)}" preserveAspectRatio="none">${shapes}</svg>`;
}

/**
 * Décor des modèles verticaux, dessiné pour 54 × 85,6 et étiré à la taille du
 * badge. Recto : grand arc autour de la photo ; verso : arcs fins en haut et en bas.
 */
function decor(model: BadgeModel, side: 'front' | 'back', c: { brand: string; brand2: string; dark: string }): string {
  let body = '';
  if (model === 'arc') {
    body =
      side === 'front'
        ? `<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${c.brand}"/><stop offset="1" stop-color="${c.dark}"/></linearGradient></defs>` +
          `<path d="M0,19 Q27,8 54,19 L54,37 Q27,49 0,37 Z" fill="url(#g)"/>` +
          `<path d="M0,17.6 Q27,6.6 54,17.6" fill="none" stroke="${c.brand2}" stroke-width="0.7"/>` +
          `<path d="M0,38.6 Q27,50.6 54,38.6" fill="none" stroke="${c.brand2}" stroke-width="0.7"/>` +
          `<path d="M0,82 Q27,77 54,82 L54,85.6 L0,85.6 Z" fill="${c.brand}"/>` +
          `<path d="M0,80.6 Q27,75.6 54,80.6" fill="none" stroke="${c.dark}" stroke-width="0.5"/>`
        : `<path d="M0,0 L54,0 L54,9 Q27,4 0,9 Z" fill="${c.brand}"/>` +
          `<path d="M0,10.4 Q27,5.4 54,10.4" fill="none" stroke="${c.dark}" stroke-width="0.5"/>` +
          `<path d="M0,85.6 L0,76 Q27,68 54,76 L54,85.6 Z" fill="#fff"/>` +
          `<path d="M0,74.4 Q27,66.4 54,74.4" fill="none" stroke="${c.brand}" stroke-width="0.9"/>`;
  } else if (model === 'angles') {
    body =
      `<polygon points="0,0 4.6,0 11.6,25 0,63" fill="${c.brand2}"/>` +
      `<polygon points="0,3.5 9.4,25 0,56" fill="${c.brand}"/>` +
      `<polygon points="54,28 42.4,61 47.6,85.6 54,85.6" fill="${c.brand2}"/>` +
      `<polygon points="54,34.5 44.6,61 50.4,85.6 54,85.6" fill="${c.brand}"/>` +
      (side === 'back' ? `<polygon points="54,0 49.4,0 54,14" fill="${c.brand2}"/>` : `<polygon points="54,0 51,0 54,9" fill="${c.brand2}"/>`);
  }
  return body ? `<svg class="bdg-decor" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 54 85.6" preserveAspectRatio="none">${body}</svg>` : '';
}

interface Parts {
  W: number;
  H: number;
  k: number;
  style: string;
  logo: string;
  storeName: string;
  title: string;
  palette: ReturnType<typeof brandPalette>;
}

function parts(card: BadgeCard, layout: BadgeLayout): Parts {
  const { width: W, height: H } = badgeSize(layout);
  const p = brandPalette(card.color, card.color2);
  // Rôle et titres : la couleur principale si elle se lit sur le blanc, sinon sa version foncée.
  const accent = contrast(p.brand, '#ffffff') >= 3 ? p.brand : p.deep;
  const k = badgeIsPortrait(layout) ? Math.min(W / 54, H / 85.6) : Math.min(W / 85.6, H / 54);
  const logo = layout.showLogo && card.logo ? `<img class="bdg-logo" src="${esc(card.logo)}" alt="">` : '';
  return {
    W,
    H,
    k,
    palette: p,
    logo,
    // Sans logo, le nom du magasin s'imprime quand même : le badge dit toujours d'où il vient.
    storeName: layout.showStore || !logo ? `<div class="bdg-store">${esc(card.store)}</div>` : '',
    title: layout.title ? `<div class="bdg-title">${esc(layout.title)}</div>` : '',
    style: [
      `width:${r1(W)}mm`,
      `height:${r1(H)}mm`,
      `--k:${r1(k)}mm`,
      `--accent:${accent}`,
      `--brand:${p.brand}`,
      `--brand2:${p.brand2}`,
      `--soft:${p.soft}`,
      `--deep:${p.deep}`,
    ].join(';'),
  };
}

/** Recto du badge, dessiné en mm à sa taille réelle. */
export function badgeHtml(card: BadgeCard, layout: BadgeLayout): string {
  const P = parts(card, layout);
  const { W, H, k, logo, storeName, title } = P;
  const mm = (v: number) => `${r1(v)}mm`;
  const role = layout.showRole && card.role ? `<div class="bdg-role">${esc(card.role)}</div>` : '';
  const photo = layout.showPhoto
    ? `<div class="bdg-photo">${card.photo ? `<img src="${esc(card.photo)}" alt="">` : `<span>${esc(initials(card.name))}</span>`}</div>`
    : '';
  const nameSize = badgeIsPortrait(layout)
    ? card.name.length > 20 ? 3 : card.name.length > 11 ? 3.5 : 4.2
    : card.name.length > 24 ? 3.4 : card.name.length > 16 ? 3.9 : 4.4;
  const name = `<div class="bdg-name" style="font-size:${mm(nameSize * k)}">${esc(card.name)}</div>`;
  const position = layout.showPosition && card.position ? `<div class="bdg-position">${esc(card.position)}</div>` : '';
  const number = layout.showNumber && card.number ? card.number : '';
  const phone = layout.showPhone && card.phone ? card.phone : '';
  const expires = layout.showExpiry && card.expires ? frDate(card.expires) : '';

  if (layout.model !== 'band') {
    const rows = [
      ['Matricule', number],
      ['Téléphone', phone],
      ['Expire le', expires],
    ].filter(([, v]) => v);
    const info = rows.length
      ? `<div class="bdg-info">${rows.map(([l, v]) => `<div><span>${l}</span><b>${esc(v!)}</b></div>`).join('')}</div>`
      : '';
    const code = layout.showBarcode ? `<div class="bdg-code-h">${barcodeWithDigitsSvg(card.code, W * 0.62, 8.5 * k)}</div>` : '';
    const art = layout.showBand ? decor(layout.model, 'front', P.palette) : '';
    return (
      `<div class="bdg bdg-${layout.model}${art ? '' : ' bdg-plain'}" style="${P.style}">${art}` +
      `<div class="bdg-head-p">${logo}<div>${storeName}${title}</div></div>` +
      photo +
      `<div class="bdg-lower"${layout.showPhoto ? '' : ' style="top:calc(var(--k)*20)"'}><div class="bdg-text-p">${name}${position}<div class="bdg-dots"></div>${role}</div>` +
      info +
      code +
      `</div></div>`
    );
  }

  if (badgeIsPortrait(layout)) {
    const band = layout.showBand ? r1(H * 0.11) : 0;
    const code = layout.showBarcode ? `<div class="bdg-code-h">${barcodeWithDigitsSvg(card.code, W * 0.72, 9 * k)}</div>` : '';
    return (
      `<div class="bdg bdg-band-p" style="${P.style};--band:${mm(band)}">` +
      `<div class="bdg-head-p">${logo}${storeName}${title}</div>` +
      role +
      photo +
      `<div class="bdg-text-p">${name}${position}${number ? `<div class="bdg-number">${esc(number)}</div>` : ''}${phone ? `<div class="bdg-phone">${esc(phone)}</div>` : ''}${expires ? `<div class="bdg-expiry">Exp. : ${expires}</div>` : ''}</div>` +
      code +
      (band ? `<div class="bdg-band">${bokeh(W, band)}</div>` : '') +
      `</div>`
    );
  }

  const band = layout.showBand ? r1(H * 0.16) : 0;
  const barW = layout.showBarcode ? 11 * k : 0;
  const textLeft = layout.showPhoto ? 30 * k : 4 * k;
  const textRight = layout.showBarcode ? barW + 6 * k : 4 * k;
  const codeLen = Math.max(10, H - band - 16 * k);
  const code = layout.showBarcode
    ? `<div class="bdg-code-v" style="width:${mm(barW)};height:${mm(codeLen)}"><div style="width:${mm(codeLen)};height:${mm(barW)};transform:translateX(${mm(barW)}) rotate(90deg)">${barcodeWithDigitsSvg(card.code, codeLen, barW)}</div></div>`
    : '';
  return (
    `<div class="bdg bdg-band-l" style="${P.style};--band:${mm(band)}">` +
    `<div class="bdg-head">${logo}<div>${storeName}${title}</div></div>` +
    role +
    photo +
    `<div class="bdg-text" style="left:${mm(textLeft)};right:${mm(textRight)}">${number ? `<div class="bdg-number">${esc(number)}</div>` : ''}${name}${position}${phone ? `<div class="bdg-phone">${esc(phone)}</div>` : ''}${expires ? `<div class="bdg-expiry">Exp. : ${expires}</div>` : ''}</div>` +
    code +
    (band ? `<div class="bdg-band">${bokeh(W, band)}</div>` : '') +
    `</div>`
  );
}

/** Verso du badge : règlement, dates d'entrée et d'expiration, signature, logo. */
export function badgeBackHtml(card: BadgeCard, layout: BadgeLayout): string {
  const P = parts(card, layout);
  const lines = layout.backText.split('\n').filter(Boolean);
  const dates = [
    ['Entré le', card.hiredOn ? frDate(card.hiredOn) : ''],
    ['Expire le', layout.showExpiry && card.expires ? frDate(card.expires) : ''],
  ].filter(([, v]) => v);
  const band = r1(P.H * (badgeIsPortrait(layout) ? 0.08 : 0.12));
  const art = !layout.showBand
    ? ''
    : layout.model === 'band'
      ? `<div class="bdg-band" style="top:0;bottom:auto;height:${band}mm">${bokeh(P.W, band)}</div>`
      : decor(layout.model, 'back', P.palette);
  return (
    `<div class="bdg bdg-back bdg-back-${layout.model}${badgeIsPortrait(layout) ? '' : ' bdg-back-l'}" style="${P.style}">${art}` +
    `<div class="bdg-back-body">` +
    (layout.backTitle ? `<div class="bdg-back-title">${esc(layout.backTitle)}</div>` : '') +
    (lines.length ? `<ul class="bdg-rules">${lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>` : '') +
    (dates.length ? `<div class="bdg-dots"></div><div class="bdg-dates">${dates.map(([l, v]) => `<div><span>${l} :</span> <b>${v}</b></div>`).join('')}</div>` : '') +
    (layout.signature ? `<div class="bdg-sign"><div></div>${esc(layout.signature)}</div>` : '') +
    `</div>` +
    `<div class="bdg-back-foot">${P.logo}<div>${P.storeName}${P.title}</div></div>` +
    `</div>`
  );
}

/** Styles des badges (en mm, proportionnels à la taille du badge par --k). */
export const BADGE_CSS =
  '.bdg-grid{display:flex;flex-wrap:wrap;gap:6mm}' +
  '.bdg-pair{display:flex;gap:2mm;break-inside:avoid;page-break-inside:avoid}' +
  '.bdg{position:relative;box-sizing:border-box;overflow:hidden;background:#fff;border:0.2mm solid #c8c8c8;border-radius:calc(var(--k)*3);font-family:Arial,Helvetica,sans-serif;color:#1d1d1f;page-break-inside:avoid;break-inside:avoid;-webkit-print-color-adjust:exact;print-color-adjust:exact;flex:none}' +
  '.bdg *{box-sizing:border-box}' +
  '.bdg-logo{max-height:calc(var(--k)*11);max-width:calc(var(--k)*30);object-fit:contain;display:block}' +
  '.bdg-store{font-weight:bold;font-size:calc(var(--k)*3.1);color:var(--deep);line-height:1.1}' +
  '.bdg-title{font-size:calc(var(--k)*2.3);color:#666;text-transform:uppercase;letter-spacing:0.2mm;margin-top:calc(var(--k)*0.5)}' +
  '.bdg-role{font-weight:900;color:var(--accent);text-transform:uppercase;letter-spacing:0.15mm;line-height:1.05}' +
  '.bdg-photo{position:relative;overflow:hidden;border-radius:calc(var(--k)*1);background:var(--soft);display:flex;align-items:center;justify-content:center;border:0.25mm solid #d4d4d4;flex:none}' +
  '.bdg-photo img{width:100%;height:100%;object-fit:cover;display:block}' +
  '.bdg-photo span{font-size:calc(var(--k)*8);font-weight:bold;color:var(--deep)}' +
  '.bdg-number{font-size:calc(var(--k)*2.7);font-weight:bold;letter-spacing:0.15mm}' +
  '.bdg-phone{font-size:calc(var(--k)*2.5)}' +
  '.bdg-name{font-weight:bold;line-height:1.1;margin:calc(var(--k)*0.8) 0 calc(var(--k)*0.6);overflow-wrap:anywhere}' +
  '.bdg-position{font-size:calc(var(--k)*2.5);font-weight:bold;font-style:italic;text-transform:uppercase}' +
  '.bdg-expiry{font-size:calc(var(--k)*2.7);font-weight:bold;margin-top:calc(var(--k)*2.6)}' +
  '.bdg-band{position:absolute;left:0;right:0;bottom:0;height:var(--band);background:linear-gradient(90deg,var(--brand),var(--brand2) 55%,var(--brand))}' +
  '.bdg-bokeh,.bdg-decor{position:absolute;inset:0;width:100%;height:100%}' +
  '.bdg-dots{width:calc(var(--k)*16);margin:calc(var(--k)*1) auto;border-top:calc(var(--k)*0.45) dotted var(--accent)}' +
  '.bdg-code-h{margin-top:auto;position:relative}' +
  // Bandeau horizontal : positions fixes, comme sur une carte imprimée.
  '.bdg-band-l .bdg-head{position:absolute;left:calc(var(--k)*4);top:calc(var(--k)*3);display:flex;align-items:center;gap:calc(var(--k)*2);max-width:55%}' +
  '.bdg-band-l .bdg-role{position:absolute;right:calc(var(--k)*4);top:calc(var(--k)*4);font-size:calc(var(--k)*4.2);max-width:42%;text-align:right}' +
  '.bdg-band-l .bdg-photo{position:absolute;left:calc(var(--k)*4);top:calc(var(--k)*16.5);width:calc(var(--k)*22);height:calc(var(--k)*26.5)}' +
  '.bdg-band-l .bdg-text{position:absolute;top:calc(var(--k)*18)}' +
  '.bdg-band-l .bdg-expiry{margin-top:calc(var(--k)*1.6)}' +
  '.bdg-band-l .bdg-code-v{position:absolute;right:calc(var(--k)*3.5);top:calc(var(--k)*13);overflow:hidden}' +
  '.bdg-band-l .bdg-code-v>div{transform-origin:0 0}' +
  // Modèles verticaux : les éléments les uns sous les autres, centrés.
  '.bdg-band-p,.bdg-arc,.bdg-angles{display:flex;flex-direction:column;align-items:center;text-align:center}' +
  '.bdg-band-p{padding:calc(var(--k)*3) calc(var(--k)*3) calc(var(--band) + var(--k)*2)}' +
  '.bdg-head-p{position:relative;display:flex;align-items:center;justify-content:center;gap:calc(var(--k)*1.5);text-align:left}' +
  '.bdg-band-p .bdg-head-p{flex-direction:column;text-align:center;gap:calc(var(--k)*0.8)}' +
  '.bdg-head-p .bdg-logo{max-height:calc(var(--k)*9);max-width:calc(var(--k)*20)}' +
  '.bdg-band-p .bdg-role{font-size:calc(var(--k)*4.2);margin-top:calc(var(--k)*2)}' +
  '.bdg-band-p .bdg-photo{width:calc(var(--k)*23);height:calc(var(--k)*28);margin-top:calc(var(--k)*2)}' +
  '.bdg-text-p{position:relative;margin-top:calc(var(--k)*1.5)}' +
  '.bdg-band-p .bdg-expiry{margin-top:calc(var(--k)*0.8)}' +
  '.bdg-text-p .bdg-role{font-size:calc(var(--k)*2.6)}' +
  '.bdg-arc .bdg-name,.bdg-angles .bdg-name{text-transform:uppercase;margin-bottom:calc(var(--k)*0.3)}' +
  '.bdg-arc .bdg-position,.bdg-angles .bdg-position{font-style:normal;font-weight:normal;font-size:calc(var(--k)*2.4)}' +
  '.bdg-info{position:relative;font-size:calc(var(--k)*2.4);margin-top:calc(var(--k)*0.6);display:grid;gap:calc(var(--k)*0.6)}' +
  '.bdg-info div{display:grid;grid-template-columns:calc(var(--k)*15) auto;text-align:left;gap:calc(var(--k)*1)}' +
  '.bdg-info span{color:#555}' +
  '.bdg-info span::after{content:" :"}' +
  // Arcs : photo ronde posée sur le grand arc.
  '.bdg-arc{padding:calc(var(--k)*3.5) calc(var(--k)*4) calc(var(--k)*8)}' +
  '.bdg-lower{position:absolute;left:calc(var(--k)*4);right:calc(var(--k)*4);display:flex;flex-direction:column;align-items:center}' +
  '.bdg-arc .bdg-photo{position:absolute;left:50%;transform:translateX(-50%);top:calc(var(--k)*17);width:calc(var(--k)*23);height:calc(var(--k)*23);border-radius:50%;border:calc(var(--k)*1.3) solid #fff;box-shadow:0 0 0 calc(var(--k)*0.7) var(--brand2)}' +
  '.bdg-arc .bdg-lower{top:calc(var(--k)*44);bottom:calc(var(--k)*8.5)}' +
  '.bdg-arc .bdg-text-p{margin-top:0}' +
  // Angles : photo carrée arrondie, code-barres encadré.
  '.bdg-angles{padding:calc(var(--k)*4) calc(var(--k)*9) calc(var(--k)*4)}' +
  '.bdg-angles .bdg-photo{position:absolute;left:50%;transform:translateX(-50%);top:calc(var(--k)*14);width:calc(var(--k)*25);height:calc(var(--k)*23);border-radius:calc(var(--k)*2.5)}' +
  '.bdg-angles .bdg-lower{top:calc(var(--k)*39);bottom:calc(var(--k)*4);left:calc(var(--k)*9);right:calc(var(--k)*11)}' +
  '.bdg-angles .bdg-text-p{margin-top:0}' +
  '.bdg-angles .bdg-code-h{border:0.25mm solid #333;padding:calc(var(--k)*0.6) calc(var(--k)*1);background:#fff}' +
  // Verso.
  '.bdg-back{display:flex;flex-direction:column;align-items:center;text-align:center;padding:calc(var(--k)*13) calc(var(--k)*6) calc(var(--k)*3)}' +
  '.bdg-back-l{padding:calc(var(--k)*10) calc(var(--k)*8) calc(var(--k)*3)}' +
  '.bdg-back-angles{padding-left:calc(var(--k)*12);padding-right:calc(var(--k)*12)}' +
  '.bdg-back-band:not(.bdg-back-l){padding-top:calc(var(--k)*10)}' +
  '.bdg-back-body{position:relative;width:100%}' +
  '.bdg-back-title{font-weight:bold;color:var(--accent);text-transform:uppercase;font-size:calc(var(--k)*2.9);margin-bottom:calc(var(--k)*2)}' +
  '.bdg-rules{list-style:none;margin:0;padding:0;text-align:left;font-size:calc(var(--k)*2.2);display:grid;gap:calc(var(--k)*1.4)}' +
  '.bdg-rules li{position:relative;padding-left:calc(var(--k)*3.2);line-height:1.25}' +
  '.bdg-rules li::before{content:"";position:absolute;left:0;top:calc(var(--k)*0.5);width:calc(var(--k)*1.6);height:calc(var(--k)*1.6);border-radius:50%;background:var(--brand2)}' +
  '.bdg-dates{font-size:calc(var(--k)*2.5);display:grid;gap:calc(var(--k)*0.8)}' +
  '.bdg-dates span{color:var(--accent)}' +
  '.bdg-sign{margin:calc(var(--k)*5) auto 0;font-size:calc(var(--k)*2.4);width:calc(var(--k)*24)}' +
  '.bdg-sign div{border-top:0.25mm solid #333;margin-bottom:calc(var(--k)*0.6)}' +
  '.bdg-back-foot{position:relative;margin-top:auto;display:flex;align-items:center;justify-content:center;gap:calc(var(--k)*1.5);text-align:left}' +
  '.bdg-back-foot .bdg-logo{max-height:calc(var(--k)*8);max-width:calc(var(--k)*18)}';

/** Planche A4 de badges (plusieurs employés, ou un même badge en plusieurs exemplaires), avec le verso à côté si demandé. */
export function badgesHtml(cards: readonly BadgeCard[], layout: BadgeLayout): string {
  const one = (c: BadgeCard) => (layout.back ? `<div class="bdg-pair">${badgeHtml(c, layout)}${badgeBackHtml(c, layout)}</div>` : badgeHtml(c, layout));
  return `<style>${BADGE_CSS}</style><div class="bdg-grid">${cards.map(one).join('')}</div>`;
}
