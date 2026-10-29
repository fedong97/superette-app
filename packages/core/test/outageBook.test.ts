import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  BOOK_MARKERS,
  BOOK_MARKER_SIZE,
  type BookArticle,
  type BookBox,
  type GrayImage,
  bookBoxes,
  bookPageSvg,
  decodeBookPage,
  digitLogits,
  homography,
  project,
  readBookCells,
  readDigit,
} from '../src';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/digits-check.json', import.meta.url), 'utf8')) as { images: string; labels: number[]; logits: number[][] };
const bytes = Buffer.from(fixture.images, 'base64');
const sample = (i: number) => Float32Array.from(bytes.subarray(i * 784, (i + 1) * 784), (v) => v / 255);
/** Les échantillons manuscrits de chaque chiffre (4 par chiffre). */
const byDigit = (d: number) => fixture.labels.flatMap((l, i) => (l === d ? [i] : []));

/**
 * Page du carnet « photographiée » : la page est dessinée à 6 points par mm,
 * les chiffres manuscrits sont posés dans leurs cases, puis la photo est prise
 * de biais (perspective), avec un éclairage inégal et du bruit.
 */
function photo(writes: { box: BookBox; digit: number; variant?: number }[], opts: { tilt?: number; seed?: number } = {}): GrayImage {
  const S = 6;
  const W = 210 * S;
  const H = 297 * S;
  const page = new Uint8Array(W * H).fill(245);
  const fill = (x0: number, y0: number, x1: number, y1: number, v: number) => {
    for (let y = Math.max(0, Math.round(y0 * S)); y < Math.min(H, Math.round(y1 * S)); y++) for (let x = Math.max(0, Math.round(x0 * S)); x < Math.min(W, Math.round(x1 * S)); x++) page[y * W + x] = v;
  };
  for (const m of BOOK_MARKERS) fill(m.x - BOOK_MARKER_SIZE / 2, m.y - BOOK_MARKER_SIZE / 2, m.x + BOOK_MARKER_SIZE / 2, m.y + BOOK_MARKER_SIZE / 2, 15);
  for (const b of bookBoxes()) {
    fill(b.x, b.y, b.x + b.w, b.y + 0.25, 185);
    fill(b.x, b.y + b.h - 0.25, b.x + b.w, b.y + b.h, 185);
    fill(b.x, b.y, b.x + 0.25, b.y + b.h, 185);
    fill(b.x + b.w - 0.25, b.y, b.x + b.w, b.y + b.h, 185);
  }
  // Un peu de texte imprimé dans l'en-tête (des barres sombres).
  fill(24, 11, 80, 16, 40);
  fill(16, 27, 180, 29, 60);
  for (const w of writes) {
    const img = sample(byDigit(w.digit)[(w.variant ?? 0) % 4]!);
    const size = 7.2; // le chiffre de 20 points occupe ~5 mm
    const ox = w.box.x + w.box.w / 2 - size / 2;
    const oy = w.box.y + w.box.h / 2 - size / 2;
    for (let y = 0; y < size * S; y++) {
      for (let x = 0; x < size * S; x++) {
        const v = img[Math.floor((y / (size * S)) * 28) * 28 + Math.floor((x / (size * S)) * 28)]!;
        if (v > 0.1) {
          const p = Math.round((oy * S + y)) * W + Math.round(ox * S + x);
          page[p] = Math.min(page[p]!, Math.round(245 - v * 205));
        }
      }
    }
  }
  // Photo 1000 × 1400 prise de biais : les coins de la page tombent ici.
  const tilt = opts.tilt ?? 1;
  const PW = 1000;
  const PH = 1400;
  const corners = [
    { x: 60 + 30 * tilt, y: 50 },
    { x: 940 - 10 * tilt, y: 80 + 20 * tilt },
    { x: 960, y: 1350 - 15 * tilt },
    { x: 40 + 20 * tilt, y: 1330 },
  ];
  const photoToPage = homography(corners, [
    { x: 0, y: 0 },
    { x: W, y: 0 },
    { x: W, y: H },
    { x: 0, y: H },
  ]);
  let seed = opts.seed ?? 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const out = new Uint8Array(PW * PH);
  for (let y = 0; y < PH; y++) {
    for (let x = 0; x < PW; x++) {
      const p = project(photoToPage, { x, y });
      const px = Math.round(p.x);
      const py = Math.round(p.y);
      const base = px >= 0 && py >= 0 && px < W && py < H ? page[py * W + px]! : 90;
      // Lumière plus faible vers le bas à droite, et bruit du capteur.
      const light = 1 - 0.25 * ((x / PW + y / PH) / 2);
      out[y * PW + x] = Math.max(0, Math.min(255, Math.round(base * light + (rnd() - 0.5) * 16)));
    }
  }
  return { width: PW, height: PH, data: out };
}

/** Écrit un nombre dans les cases d'une zone, en partant de la gauche. */
function write(row: number, field: BookBox['field'], digits: string, variant = 0) {
  const boxes = bookBoxes().filter((b) => b.row === row && b.field === field);
  return [...digits].map((d, i) => ({ box: boxes[i]!, digit: Number(d), variant: variant + i }));
}

const CATALOGUE: BookArticle[] = [
  { code: 12, articleId: 'coca', packId: null, units: 1000, label: 'Coca-Cola 50 cl', unit: 'piece', price: 500 },
  { code: 13, articleId: 'coca', packId: 'casier', units: 12_000, label: 'Coca-Cola 50 cl · Casier de 12', unit: 'piece', price: 5800 },
  { code: 47, articleId: 'riz', packId: null, units: 1000, label: 'Riz au kilo', unit: 'kg', price: 650 },
  { code: 305, articleId: 'savon', packId: null, units: 1000, label: 'Savon Azur', unit: 'piece', price: 350 },
  { code: 1890, articleId: 'lait', packId: null, units: 1000, label: 'Lait Nido 400 g', unit: 'piece', price: 2950 },
];

describe('carnet de coupure à cases', () => {
  it('le réseau de chiffres calcule comme à l’entraînement', () => {
    let right = 0;
    fixture.labels.forEach((label, i) => {
      const z = digitLogits(sample(i));
      fixture.logits[i]!.forEach((v, k) => expect(z[k]!).toBeCloseTo(v, 1));
      const p = readDigit(sample(i));
      if (p.indexOf(Math.max(...p)) === label) right++;
    });
    expect(right).toBeGreaterThanOrEqual(39);
  });

  it('la page imprimée a ses quatre carrés et toutes ses cases', () => {
    const svg = bookPageSvg({ storeName: 'Superette Akwa', registerName: 'Caisse 1' });
    expect(svg).toContain('width="210mm"');
    expect(svg.match(/fill="#000"\/>/g)?.length).toBe(4);
    // Pas d'attribut en double : le SVG doit rester lisible comme image.
    for (const tag of svg.match(/<[a-z]+ [^>]*>/g)!) {
      const names = [...tag.matchAll(/ ([a-z-]+)=/g)].map((m) => m[1]);
      expect(new Set(names).size).toBe(names.length);
    }
    expect(bookBoxes().length).toBe(20 * 22 + 7);
  });

  it('lit une page photographiée de biais et propose les ventes', () => {
    const writes = [
      // Vente 1 à 10 h 25 : 2 Coca et un casier.
      ...write(0, 'sale', '1'),
      ...write(0, 'hour', '10'),
      ...write(0, 'minute', '25'),
      ...write(0, 'code', '0012'),
      ...write(0, 'qty', '2'),
      ...write(0, 'price', '500'),
      ...write(1, 'code', '13', 1),
      ...write(1, 'price', '5800', 2),
      // Vente 2 à 10 h 40 : 1,5 kg de riz, prix non écrit (celui du catalogue).
      ...write(2, 'sale', '2'),
      ...write(2, 'hour', '10', 1),
      ...write(2, 'minute', '40'),
      ...write(2, 'code', '47', 2),
      ...write(2, 'qty', '1'),
      ...write(2, 'qtyDec', '5'),
      // Vente 3 : savon à un prix différent du catalogue (300 au lieu de 350).
      ...write(3, 'sale', '3', 1),
      ...write(3, 'hour', '11'),
      ...write(3, 'minute', '05', 3),
      ...write(3, 'code', '305', 1),
      ...write(3, 'price', '300', 1),
      // Total de la page : 1000 + 5800 + 975 + 300.
      ...bookBoxes()
        .filter((b) => b.field === 'total')
        .slice(0, 4)
        .map((box, i) => ({ box, digit: Number('8075'[i]), variant: i + 2 })),
    ];
    const cells = readBookCells(photo(writes));
    expect(cells).not.toBeNull();
    const reading = decodeBookPage(cells!, CATALOGUE, { from: 10 * 60, to: 12 * 60 });
    expect(reading.lines.map((l) => [l.row, l.sale, l.time, l.code, l.qty, l.price])).toEqual([
      [1, 1, '10:25', 12, 2000, 500],
      [2, 1, '10:25', 13, 12_000, 5800],
      [3, 2, '10:40', 47, 1500, 650],
      [4, 3, '11:05', 305, 1000, 300],
    ]);
    expect(reading.lines.slice(0, 3).map((l) => l.doubts)).toEqual([[], [], []]);
    expect(reading.lines[3]!.doubts).toEqual(['price_differs']);
    expect(reading.sales.map((s) => s.total)).toEqual([6800, 975, 300]);
    expect(reading.computedTotal).toBe(8075);
    expect(reading.writtenTotal).toBe(8075);
  });

  it('sans les quatre carrés, la page n’est pas lue', () => {
    const img = photo([]);
    // On masque le carré en haut à gauche.
    for (let y = 0; y < 200; y++) for (let x = 0; x < 250; x++) img.data[y * img.width + x] = 230;
    expect(readBookCells(img)).toBeNull();
  });
});

