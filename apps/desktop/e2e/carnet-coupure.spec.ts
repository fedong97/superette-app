import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { bookBoxes, bookPageSvg } from '../../../packages/core/src/outageBook';
import { createStore, invoke, launch } from './app';

// Chiffres manuscrits d'essai (MNIST, 4 par chiffre), les mêmes que les tests du réseau.
const fixture = JSON.parse(readFileSync(resolve(__dirname, '../../../packages/core/test/fixtures/digits-check.json'), 'utf8')) as { images: string; labels: number[] };
const bytes = Buffer.from(fixture.images, 'base64');
const digitPixels = (d: number, variant: number) => {
  const idx = fixture.labels.flatMap((l, i) => (l === d ? [i] : []))[variant % 4]!;
  return Array.from(bytes.subarray(idx * 784, (idx + 1) * 784));
};

const SHOTS = process.env.CAPTURES ?? resolve(__dirname, '../../../test-results/captures-carnet');

test('Coupure : la photo d’une page du carnet ONIX est lue, vérifiée puis enregistrée', async () => {
  const { app, page, errors } = await launch();
  await page.setViewportSize({ width: 1440, height: 900 });
  mkdirSync(SHOTS, { recursive: true });
  try {
    await createStore(page);
    const vat = (await invoke<{ id: string }[]>(page, 'admin.vatRates'))[0]!;
    const coca = await invoke<{ id: string }>(page, 'catalogue.save', {
      name: 'Coca-Cola 50 cl',
      unit: 'piece',
      vatRateId: vat.id,
      purchasePrice: 300,
      salePrice: 500,
      packs: [{ name: 'Casier', contains: 12, salePrice: 5800 }],
    });
    const riz = await invoke<{ id: string }>(page, 'catalogue.save', { name: 'Riz au kilo', unit: 'kg', vatRateId: vat.id, purchasePrice: 450, salePrice: 650 });
    const wh = (await invoke<{ id: string }[]>(page, 'admin.warehouses'))[0]!;
    await invoke(page, 'stock.receive', { warehouseId: wh.id, lines: [{ articleId: coca.id, qty: 100_000, unitCost: 300 }, { articleId: riz.id, qty: 50_000, unitCost: 450 }] });
    const reg = (await invoke<{ registers: { id: string }[] }>(page, 'treasury.state')).registers[0]!;
    await invoke(page, 'treasury.open', 0, undefined, reg.id);

    // Coupure de 2 h qui finit il y a une heure ; ventes notées 20 et 45 minutes après son début.
    const start = new Date(Date.now() - 3 * 3_600_000);
    start.setSeconds(0, 0);
    const end = new Date(start.getTime() + 2 * 3_600_000);
    await invoke(page, 'outages.declare', { startedAt: start.toISOString(), endedAt: end.toISOString(), declaredTotal: 7775 });
    const codes = await invoke<{ code: number; article_id: string; units: number }[]>(page, 'outages.bookCodes');
    const code = (id: string, units = 1000) => String(codes.find((c) => c.article_id === id && c.units === units)!.code).padStart(4, '0');
    const hm = (d: Date) => [String(d.getHours()).padStart(2, '0'), String(d.getMinutes()).padStart(2, '0')];
    const [h1, m1] = hm(new Date(start.getTime() + 20 * 60_000));
    const [h2, m2] = hm(new Date(start.getTime() + 45 * 60_000));

    // Ce que le caissier a écrit, case par case.
    const boxes = bookBoxes();
    const writes: { x: number; y: number; w: number; h: number; px: number[] }[] = [];
    let v = 0;
    const put = (row: number, field: string, digits: string) => {
      const zone = boxes.filter((b) => b.row === row && b.field === field);
      [...digits].forEach((d, i) => writes.push({ ...zone[i]!, px: digitPixels(Number(d), v++) }));
    };
    put(0, 'sale', '1');
    put(0, 'hour', h1!);
    put(0, 'minute', m1!);
    put(0, 'code', code(coca.id));
    put(0, 'qty', '2');
    put(0, 'price', '500');
    put(1, 'code', code(coca.id, 12_000));
    put(1, 'price', '5800');
    put(2, 'sale', '2');
    put(2, 'hour', h2!);
    put(2, 'minute', m2!);
    put(2, 'code', code(riz.id));
    put(2, 'qty', '1');
    put(2, 'qtyDec', '5');
    put(-1, 'total', '7775');

    // La page imprimée, remplie, puis photographiée un peu de travers sous une lumière inégale.
    const svg = bookPageSvg({ storeName: 'Superette Test', registerName: 'Caisse 1' });
    const blank = await page.evaluate(async (svg) => {
      const c = document.createElement('canvas');
      c.width = 1240;
      c.height = 1754;
      const img = new Image();
      img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
      await img.decode();
      c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
      return c.toDataURL('image/png');
    }, svg);
    writeFileSync(resolve(SHOTS, '00-page-du-carnet-a-imprimer.png'), Buffer.from(blank.split(',')[1]!, 'base64'));
    const photo = await page.evaluate(
      async ({ svg, writes }) => {
        const S = 6;
        const pageCanvas = document.createElement('canvas');
        pageCanvas.width = 210 * S;
        pageCanvas.height = 297 * S;
        const pc = pageCanvas.getContext('2d')!;
        const img = new Image();
        img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
        await img.decode();
        pc.drawImage(img, 0, 0, pageCanvas.width, pageCanvas.height);
        const cell = document.createElement('canvas');
        cell.width = 28;
        cell.height = 28;
        const cc = cell.getContext('2d')!;
        for (const w of writes) {
          const data = cc.createImageData(28, 28);
          w.px.forEach((p, i) => {
            data.data[i * 4] = 20;
            data.data[i * 4 + 1] = 30;
            data.data[i * 4 + 2] = 90; // stylo bleu
            data.data[i * 4 + 3] = p;
          });
          cc.putImageData(data, 0, 0);
          const size = 7.2 * S;
          pc.drawImage(cell, (w.x + w.w / 2) * S - size / 2, (w.y + w.h / 2) * S - size / 2, size, size);
        }
        const out = document.createElement('canvas');
        out.width = 1100;
        out.height = 1500;
        const oc = out.getContext('2d')!;
        oc.fillStyle = '#6b5a48'; // la table sous la page
        oc.fillRect(0, 0, out.width, out.height);
        oc.translate(550, 750);
        oc.rotate((3 * Math.PI) / 180);
        oc.drawImage(pageCanvas, -480, -680, 960, 1358);
        oc.setTransform(1, 0, 0, 1, 0, 0);
        const shade = oc.createLinearGradient(0, 0, out.width, out.height);
        shade.addColorStop(0, 'rgba(255,255,255,0)');
        shade.addColorStop(1, 'rgba(40,30,10,0.28)');
        oc.fillStyle = shade;
        oc.fillRect(0, 0, out.width, out.height);
        return out.toDataURL('image/jpeg', 0.88);
      },
      { svg, writes },
    );
    const jpeg = Buffer.from(photo.split(',')[1]!, 'base64');
    writeFileSync(resolve(SHOTS, '01-photo-de-la-page.jpg'), jpeg);

    // À la caisse : Coupure, puis « Lire une page du carnet ».
    await page.getByRole('button', { name: 'V. cash 1', exact: true }).click();
    await page.locator('select').filter({ hasText: 'Actions' }).selectOption('outage');
    await page.getByRole('button', { name: 'Lire une page du carnet' }).click();
    await page.screenshot({ path: resolve(SHOTS, '02-choisir-la-photo.png') });
    await page.locator('.modal input[type=file]').setInputFiles({ name: 'page-1.jpg', mimeType: 'image/jpeg', buffer: jpeg });
    const rows = page.locator('.book-reader table.list tbody tr:not(.book-strip)');
    await expect(rows).toHaveCount(3, { timeout: 30_000 });
    await expect(rows.nth(0)).toContainText('Coca-Cola 50 cl');
    await expect(rows.nth(1)).toContainText('Casier');
    await expect(rows.nth(2)).toContainText('Riz au kilo');
    await expect(page.locator('.book-reader')).toContainText('7 775');
    await page.screenshot({ path: resolve(SHOTS, '03-lignes-lues-a-verifier.png') });
    // Une ligne douteuse se coche une fois comparée à la photo.
    for (const box of await page.locator('.book-reader tbody input[type=checkbox]:not(:checked)').all()) await box.check();
    await page.getByRole('button', { name: 'Enregistrer les ventes de la page' }).click();
    await expect(page.getByText(/2 vente\(s\) de la page 1 enregistrées/)).toBeVisible();
    const o = await invoke<{ entered_total: number; gap: number; sales: number; pages: number }>(page, 'outages.current');
    expect(o).toMatchObject({ entered_total: 7775, gap: 0, sales: 2, pages: 1 });
    await page.locator('select').filter({ hasText: 'Actions' }).selectOption('outage');
    await expect(page.getByText('Ventes saisies (2)')).toBeVisible();
    await page.waitForTimeout(500);
    await page.screenshot({ path: resolve(SHOTS, '04-coupure-sans-ecart.png') });
    expect(errors).toEqual([]);
  } finally {
    await app.close();
  }
});
