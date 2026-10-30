/**
 * Carnet de coupure ONIX : une page A4 à cases, imprimée d'avance, que le
 * caissier remplit à la main pendant une coupure (un chiffre par case). Au
 * retour du courant, la photo de la page est lue sur le PC, sans internet :
 * les quatre carrés noirs des coins situent la page, chaque case est découpée
 * puis lue par le petit réseau de chiffres de `digitNet`.
 *
 * Toutes les mesures sont en millimètres sur la page A4 (210 × 297).
 */

export const BOOK_PAGE = { width: 210, height: 297 } as const;

/** Carrés noirs des coins : centre et côté (mm). Ils servent à redresser la photo. */
export const BOOK_MARKER_SIZE = 9;
export const BOOK_MARKERS: readonly { x: number; y: number }[] = [
  { x: 13, y: 13 },
  { x: 197, y: 13 },
  { x: 197, y: 284 },
  { x: 13, y: 284 },
];

export const BOOK_BOX = { w: 7.5, h: 9 } as const;
export const BOOK_ROWS = 20;
export const BOOK_FIRST_ROW_Y = 54;
export const BOOK_ROW_STEP = 10.5;

/** Les zones d'une ligne, de gauche à droite. `sep` : signe imprimé entre deux groupes de cases (« : » de l'heure, « , » de la quantité). */
export type BookField = 'sale' | 'hour' | 'minute' | 'code' | 'qty' | 'qtyDec' | 'price';
export const BOOK_COLUMNS: readonly { field: BookField; x: number; boxes: number; title?: string; sep?: string }[] = [
  { field: 'sale', x: 12.5, boxes: 3, title: 'N° vente' },
  { field: 'hour', x: 39, boxes: 2, title: 'Heure' },
  { field: 'minute', x: 56, boxes: 2, sep: ':' },
  { field: 'code', x: 75, boxes: 4, title: 'Code article' },
  { field: 'qty', x: 109, boxes: 3, title: 'Quantité' },
  { field: 'qtyDec', x: 133.5, boxes: 2, sep: ',' },
  { field: 'price', x: 152.5, boxes: 6, title: 'Prix unitaire (FCFA)' },
];

/** Total de la page, écrit par le caissier : ONIX le compare à la somme des lignes lues. */
export const BOOK_TOTAL = { x: 145, y: 268, boxes: 7 } as const;

export interface BookBox {
  /** Ligne (0 à 19), ou -1 pour le total de la page. */
  row: number;
  field: BookField | 'total';
  /** Position de la case dans sa zone, de gauche à droite. */
  index: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Toutes les cases de la page, ligne par ligne, puis celles du total. */
export function bookBoxes(): BookBox[] {
  const boxes: BookBox[] = [];
  for (let row = 0; row < BOOK_ROWS; row++) {
    const y = BOOK_FIRST_ROW_Y + row * BOOK_ROW_STEP;
    for (const c of BOOK_COLUMNS) {
      for (let i = 0; i < c.boxes; i++) boxes.push({ row, field: c.field, index: i, x: c.x + i * BOOK_BOX.w, y, w: BOOK_BOX.w, h: BOOK_BOX.h });
    }
  }
  for (let i = 0; i < BOOK_TOTAL.boxes; i++) boxes.push({ row: -1, field: 'total', index: i, x: BOOK_TOTAL.x + i * BOOK_BOX.w, y: BOOK_TOTAL.y, w: BOOK_BOX.w, h: BOOK_BOX.h });
  return boxes;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Page du carnet à imprimer, en SVG aux dimensions réelles (210 × 297 mm).
 * Les cases sont tracées en gris clair : à la lecture, seule l'encre du stylo compte.
 */
export function bookPageSvg(opts: { storeName: string; registerName?: string | null }): string {
  const parts: string[] = [];
  const text = (x: number, y: number, s: string, size = 3, extra = '') =>
    parts.push(`<text x="${x}" y="${y}" font-family="Inter, Arial, sans-serif" font-size="${size}"${extra.includes('fill=') ? '' : ' fill="#111"'} ${extra}>${esc(s)}</text>`);
  for (const m of BOOK_MARKERS) {
    const h = BOOK_MARKER_SIZE / 2;
    parts.push(`<rect x="${m.x - h}" y="${m.y - h}" width="${BOOK_MARKER_SIZE}" height="${BOOK_MARKER_SIZE}" fill="#000"/>`);
  }
  text(24, 15, 'Carnet de coupure', 5.5, 'font-weight="700"');
  text(24, 21, `${opts.storeName}${opts.registerName ? ` · ${opts.registerName}` : ''} · ONIX 360`, 3.2);
  text(130, 15, 'Date : ........ / ........ / ............', 3.2);
  text(130, 21, 'Caissier : ...............................', 3.2);
  text(16, 30, 'Un chiffre par case, au stylo noir ou bleu foncé, sans déborder. Rien dans les cases vides.', 3);
  text(16, 35, 'Une vente sur plusieurs lignes : même n° de vente. L’heure et le n° seulement sur la première ligne de la vente.', 3);
  text(16, 40, 'Le code de l’article est sur la liste des codes du carnet. Quantité vide = 1.', 3);
  for (const c of BOOK_COLUMNS) {
    if (c.title) text(c.x, BOOK_FIRST_ROW_Y - 3, c.title, 3, 'font-weight="600"');
    if (c.sep) {
      // Au milieu de l'espace entre les deux groupes de cases, jamais dans une case.
      for (let row = 0; row < BOOK_ROWS; row++) text(c.x - 1, BOOK_FIRST_ROW_Y + row * BOOK_ROW_STEP + 6.5, c.sep, 4.5, 'fill="#999" text-anchor="middle"');
    }
  }
  for (const b of bookBoxes()) {
    parts.push(`<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" fill="none" stroke="#b8b8b8" stroke-width="0.25"/>`);
  }
  for (let row = 1; row < BOOK_ROWS; row += 2) {
    parts.push(`<rect x="10" y="${BOOK_FIRST_ROW_Y + row * BOOK_ROW_STEP - 0.75}" width="190" height="${BOOK_ROW_STEP}" fill="#000" fill-opacity="0.035"/>`);
  }
  text(BOOK_TOTAL.x - 40, BOOK_TOTAL.y + 6.5, 'Total de la page (FCFA)', 3.4, 'font-weight="600"');
  text(24, 285, 'Pour lire la page : photographiez-la à plat, entière, avec les quatre carrés noirs visibles.', 2.8, 'fill="#555"');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="210mm" height="297mm" viewBox="0 0 210 297"><rect width="210" height="297" fill="#fff"/>${parts.join('')}</svg>`;
}

/** Pages du carnet à imprimer d'un coup (HTML A4 sans marges, une page par feuille). */
export function bookPagesHtml(count: number, opts: { storeName: string; registerName?: string | null }): string {
  const n = Math.max(1, Math.min(50, Math.floor(count)));
  const page = bookPageSvg(opts);
  return `<!doctype html><html><head><meta charset="utf-8"><style>@page{size:A4;margin:0}html,body{margin:0}.p{width:210mm;height:297mm;page-break-after:always;overflow:hidden}.p:last-child{page-break-after:auto}svg{display:block}</style></head><body>${Array.from({ length: n }, () => `<div class="p">${page}</div>`).join('')}</body></html>`;
}

/** Liste des codes du carnet, par rayon : à garder près de la caisse pour les coupures. */
export function bookCodesTableHtml(codes: { code: number; article_name: string; pack_name: string; price: number; department: string | null }[]): string {
  const rows: string[] = [];
  let dept: string | null | undefined;
  for (const c of codes) {
    if (c.department !== dept) {
      dept = c.department;
      rows.push(`<tr><th colspan="4" style="text-align:left;padding-top:8px">${esc(dept ?? 'Sans rayon')}</th></tr>`);
    }
    rows.push(
      `<tr><td style="font-family:monospace;font-size:14px;font-weight:700">${String(c.code).padStart(4, '0')}</td><td>${esc(c.article_name)}</td><td>${esc(c.pack_name)}</td><td style="text-align:right">${c.price.toLocaleString('fr-FR')} F</td></tr>`,
    );
  }
  return `<table><thead><tr><th>Code</th><th>Article</th><th>Vendu à</th><th style="text-align:right">Prix</th></tr></thead><tbody>${rows.join('')}</tbody></table>`;
}

// --- Lecture de la photo -----------------------------------------------------

/** Image en niveaux de gris : 0 = noir, 255 = blanc. */
export interface GrayImage {
  width: number;
  height: number;
  data: Uint8Array | Uint8ClampedArray;
}

/** RGBA (canvas) vers niveaux de gris. */
export function toGray(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number): GrayImage {
  const data = new Uint8Array(width * height);
  for (let i = 0, j = 0; j < data.length; i += 4, j++) data[j] = (rgba[i]! * 77 + rgba[i + 1]! * 150 + rgba[i + 2]! * 29) >> 8;
  return { width, height, data };
}

/**
 * Seuil local (moyenne sur une fenêtre, image intégrale) : une page mal
 * éclairée, avec une ombre ou un coin plus sombre, reste lisible.
 * Renvoie 1 pour l'encre, 0 pour le papier.
 */
export function binarize(img: GrayImage, radius = Math.max(8, Math.round(Math.min(img.width, img.height) / 40)), offset = 18): Uint8Array {
  const { width: w, height: h, data } = img;
  const integral = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += data[y * w + x]!;
      integral[(y + 1) * (w + 1) + x + 1] = integral[y * (w + 1) + x + 1]! + row;
    }
  }
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - radius);
    const y1 = Math.min(h, y + radius + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - radius);
      const x1 = Math.min(w, x + radius + 1);
      const sum = integral[y1 * (w + 1) + x1]! - integral[y0 * (w + 1) + x1]! - integral[y1 * (w + 1) + x0]! + integral[y0 * (w + 1) + x0]!;
      const mean = sum / ((x1 - x0) * (y1 - y0));
      out[y * w + x] = data[y * w + x]! < mean - offset ? 1 : 0;
    }
  }
  return out;
}

export interface Point {
  x: number;
  y: number;
}

/**
 * Les quatre carrés noirs des coins, dans l'ordre haut-gauche, haut-droit,
 * bas-droit, bas-gauche. Ce sont des taches pleines, à peu près carrées ; on
 * garde la plus grande de chaque quart de la photo. `null` s'il en manque un.
 */
export function findMarkers(img: GrayImage): Point[] | null {
  const { width: w, height: h } = img;
  // Seuil global d'Otsu : les carrés sont le noir le plus franc de la page.
  const hist = new Array<number>(256).fill(0);
  for (const v of img.data) hist[v]!++;
  const total = w * h;
  let sumAll = 0;
  for (let i = 0; i < 256; i++) sumAll += i * hist[i]!;
  let best = 0;
  let thr = 100;
  let wB = 0;
  let sumB = 0;
  for (let t = 0; t < 256; t++) {
    wB += hist[t]!;
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t]!;
    const mB = sumB / wB;
    const mF = (sumAll - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > best) {
      best = between;
      thr = t;
    }
  }
  const dark = new Uint8Array(total);
  for (let i = 0; i < total; i++) dark[i] = img.data[i]! <= thr ? 1 : 0;
  // Taches connexes (parcours en largeur).
  const seen = new Uint8Array(total);
  const stack = new Int32Array(total);
  const minArea = (Math.min(w, h) / 120) ** 2;
  const blobs: { cx: number; cy: number; area: number }[] = [];
  for (let start = 0; start < total; start++) {
    if (!dark[start] || seen[start]) continue;
    let top = 0;
    stack[top++] = start;
    seen[start] = 1;
    let area = 0;
    let sx = 0;
    let sy = 0;
    let minX = w;
    let maxX = 0;
    let minY = h;
    let maxY = 0;
    while (top > 0) {
      const p = stack[--top]!;
      const x = p % w;
      const y = (p - x) / w;
      area++;
      sx += x;
      sy += y;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      const n = [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1];
      for (const q of n) {
        if (q >= 0 && dark[q] && !seen[q]) {
          seen[q] = 1;
          stack[top++] = q;
        }
      }
    }
    if (area < minArea) continue;
    const bw = maxX - minX + 1;
    const bh = maxY - minY + 1;
    const ratio = bw / bh;
    // Un carré photographié de biais reste un quadrilatère bien rempli.
    if (ratio < 0.5 || ratio > 2 || area / (bw * bh) < 0.6) continue;
    blobs.push({ cx: sx / area, cy: sy / area, area });
  }
  if (blobs.length < 4) return null;
  // Les plus gros carrés ; puis le plus proche de chaque coin de la photo.
  const big = blobs.sort((a, b) => b.area - a.area).slice(0, 12);
  const maxArea = big[0]!.area;
  const candidates = big.filter((b) => b.area >= maxArea * 0.3);
  const corners: Point[] = [
    { x: 0, y: 0 },
    { x: w, y: 0 },
    { x: w, y: h },
    { x: 0, y: h },
  ];
  const picked: Point[] = [];
  for (const c of corners) {
    let pick: (typeof candidates)[number] | null = null;
    let d = Infinity;
    for (const b of candidates) {
      const dd = (b.cx - c.x) ** 2 + (b.cy - c.y) ** 2;
      if (dd < d) {
        d = dd;
        pick = b;
      }
    }
    if (!pick || picked.some((p) => p.x === pick!.cx && p.y === pick!.cy)) return null;
    picked.push({ x: pick.cx, y: pick.cy });
  }
  return picked;
}

/** Homographie qui envoie les 4 points `from` sur les 4 points `to` (matrice 3 × 3, ligne par ligne). */
export function homography(from: Point[], to: Point[]): number[] {
  // Système 8 × 8 résolu par élimination de Gauss.
  const a: number[][] = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = from[i]!;
    const { x: u, y: v } = to[i]!;
    a.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
    a.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  }
  for (let c = 0; c < 8; c++) {
    let p = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(a[r]![c]!) > Math.abs(a[p]![c]!)) p = r;
    [a[c], a[p]] = [a[p]!, a[c]!];
    const piv = a[c]![c]!;
    if (Math.abs(piv) < 1e-12) throw new Error('Points alignés : homographie impossible');
    for (let k = c; k < 9; k++) a[c]![k]! /= piv;
    for (let r = 0; r < 8; r++) {
      if (r === c) continue;
      const f = a[r]![c]!;
      if (f !== 0) for (let k = c; k < 9; k++) a[r]![k]! -= f * a[c]![k]!;
    }
  }
  return [...a.map((r) => r[8]!), 1];
}

export function project(m: number[], p: Point): Point {
  const d = m[6]! * p.x + m[7]! * p.y + m[8]!;
  return { x: (m[0]! * p.x + m[1]! * p.y + m[2]!) / d, y: (m[3]! * p.x + m[4]! * p.y + m[5]!) / d };
}

/** Échantillon bilinéaire de l'encre (0 papier … 1 noir) à un point de la photo. */
function inkAt(img: GrayImage, x: number, y: number, paper: number, ink: number): number {
  const { width: w, height: h, data } = img;
  if (x < 0 || y < 0 || x >= w - 1 || y >= h - 1) return 0;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const i = y0 * w + x0;
  const v = data[i]! * (1 - fx) * (1 - fy) + data[i + 1]! * fx * (1 - fy) + data[i + w]! * (1 - fx) * fy + data[i + w + 1]! * fx * fy;
  const t = (paper - v) / Math.max(1, paper - ink);
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

/** Côté de l'échantillon d'une case redressée, en points (≈ 8 points par mm). */
const CELL_RES = 8;

/**
 * Case redressée en image d'encre (0 à 1), sans le bord gris imprimé de la
 * case. Le papier et l'encre sont mesurés autour de la case pour suivre
 * l'éclairage de la photo.
 */
export function cellInk(img: GrayImage, pageToPhoto: number[], box: BookBox): { w: number; h: number; ink: Float32Array } {
  const inset = 0.9;
  const w = Math.round((box.w - 2 * inset) * CELL_RES);
  const h = Math.round((box.h - 2 * inset) * CELL_RES);
  // Papier : la valeur claire typique de la case et de son entourage ; encre : la plus sombre.
  const values: number[] = [];
  for (let j = -2; j <= h + 2; j += 2) {
    for (let i = -2; i <= w + 2; i += 2) {
      const p = project(pageToPhoto, { x: box.x + inset + i / CELL_RES, y: box.y + inset + j / CELL_RES });
      const xi = Math.round(p.x);
      const yi = Math.round(p.y);
      if (xi >= 0 && yi >= 0 && xi < img.width && yi < img.height) values.push(img.data[yi * img.width + xi]!);
    }
  }
  values.sort((a, b) => a - b);
  const paper = values[Math.floor(values.length * 0.7)] ?? 255;
  const darkest = values[0] ?? 0;
  // Une case sans encre : la plus sombre reste proche du papier. On ne force pas le contraste.
  const ink = Math.min(darkest, paper - 60);
  const out = new Float32Array(w * h);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const p = project(pageToPhoto, { x: box.x + inset + (i + 0.5) / CELL_RES, y: box.y + inset + (j + 0.5) / CELL_RES });
      out[j * w + i] = inkAt(img, p.x, p.y, paper - 12, ink);
    }
  }
  return { w, h, ink: out };
}

/**
 * Prépare une case comme les chiffres d'entraînement (MNIST) : on garde la
 * plus grande tache d'encre et celles qui la touchent presque, on la met dans
 * un carré de 20 points, centrée par son centre de masse dans une image 28 × 28.
 * `null` : case vide.
 */
export function cellToDigit(cell: { w: number; h: number; ink: Float32Array }): Float32Array | null {
  const { w, h, ink } = cell;
  const on = new Uint8Array(w * h);
  let mass = 0;
  for (let i = 0; i < ink.length; i++) {
    if (ink[i]! > 0.35) {
      on[i] = 1;
      mass += ink[i]!;
    }
  }
  // Moins de 2 % de la case encrée : vide (poussière, reste du bord).
  if (mass < w * h * 0.02) return null;
  // Taches connexes ; les traits collés au bord et très fins sont des restes du cadre.
  const label = new Int32Array(w * h).fill(-1);
  const comps: { area: number; minX: number; maxX: number; minY: number; maxY: number }[] = [];
  const stack: number[] = [];
  for (let s = 0; s < on.length; s++) {
    if (!on[s] || label[s]! >= 0) continue;
    const id = comps.length;
    const c = { area: 0, minX: w, maxX: 0, minY: h, maxY: 0 };
    label[s] = id;
    stack.push(s);
    while (stack.length) {
      const p = stack.pop()!;
      const x = p % w;
      const y = (p - x) / w;
      c.area++;
      c.minX = Math.min(c.minX, x);
      c.maxX = Math.max(c.maxX, x);
      c.minY = Math.min(c.minY, y);
      c.maxY = Math.max(c.maxY, y);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const q = ny * w + nx;
          if (on[q] && label[q]! < 0) {
            label[q] = id;
            stack.push(q);
          }
        }
      }
    }
    comps.push(c);
  }
  const frame = (c: (typeof comps)[number]) => {
    const bw = c.maxX - c.minX + 1;
    const bh = c.maxY - c.minY + 1;
    const edge = c.minX === 0 || c.minY === 0 || c.maxX === w - 1 || c.maxY === h - 1;
    return edge && (bw <= 3 || bh <= 3);
  };
  const kept = comps.map((c, i) => ({ c, i })).filter(({ c }) => !frame(c) && c.area >= 6);
  if (kept.length === 0) return null;
  const main = kept.reduce((a, b) => (b.c.area > a.c.area ? b : a));
  const near = (c: (typeof comps)[number]) => c.minX <= main.c.maxX + 4 && c.maxX >= main.c.minX - 4 && c.minY <= main.c.maxY + 4 && c.maxY >= main.c.minY - 4;
  const keep = new Set(kept.filter(({ c }) => c === main.c || near(c)).map(({ i }) => i));
  let minX = w;
  let maxX = 0;
  let minY = h;
  let maxY = 0;
  for (let p = 0; p < on.length; p++) {
    if (label[p]! >= 0 && keep.has(label[p]!)) {
      const x = p % w;
      const y = (p - x) / w;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  }
  const bw = maxX - minX + 1;
  const bh = maxY - minY + 1;
  if (bh < h * 0.25) return null; // un point ou un tiret : pas un chiffre
  // Mise à l'échelle dans 20 × 20 (rapport conservé), en gardant l'encre des taches retenues.
  const scale = 20 / Math.max(bw, bh);
  const tw = Math.max(1, Math.round(bw * scale));
  const th = Math.max(1, Math.round(bh * scale));
  const small = new Float32Array(tw * th);
  for (let j = 0; j < th; j++) {
    for (let i = 0; i < tw; i++) {
      // Moyenne de la zone source couverte par ce point.
      const sx0 = minX + i / scale;
      const sx1 = minX + (i + 1) / scale;
      const sy0 = minY + j / scale;
      const sy1 = minY + (j + 1) / scale;
      let sum = 0;
      let n = 0;
      for (let y = Math.floor(sy0); y < Math.ceil(sy1); y++) {
        for (let x = Math.floor(sx0); x < Math.ceil(sx1); x++) {
          if (x < minX || x > maxX || y < minY || y > maxY) continue;
          const p = y * w + x;
          sum += label[p]! >= 0 && keep.has(label[p]!) ? ink[p]! : ink[p]! * 0.3;
          n++;
        }
      }
      small[j * tw + i] = n ? sum / n : 0;
    }
  }
  // Centre de masse au milieu de l'image 28 × 28.
  let m = 0;
  let mx = 0;
  let my = 0;
  for (let j = 0; j < th; j++) {
    for (let i = 0; i < tw; i++) {
      const v = small[j * tw + i]!;
      m += v;
      mx += v * i;
      my += v * j;
    }
  }
  const ox = Math.round(14 - (m ? mx / m : tw / 2));
  const oy = Math.round(14 - (m ? my / m : th / 2));
  const out = new Float32Array(784);
  let peak = 0;
  for (let j = 0; j < th; j++) {
    for (let i = 0; i < tw; i++) {
      const x = i + ox;
      const y = j + oy;
      if (x >= 0 && y >= 0 && x < 28 && y < 28) {
        out[y * 28 + x] = small[j * tw + i]!;
        peak = Math.max(peak, small[j * tw + i]!);
      }
    }
  }
  if (peak > 0) for (let i = 0; i < 784; i++) out[i] = Math.min(1, out[i]! / peak);
  return out;
}
