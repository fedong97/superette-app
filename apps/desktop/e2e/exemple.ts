import type { Page } from '@playwright/test';
import { invoke } from './app';

/**
 * La superette d'exemple des captures du manuel et du guide vidéo : articles, stock, clients,
 * fournisseurs, utilisateurs, ventes et dépenses, et l'ouverture des fenêtres comme les menus.
 */
/** Code EAN-13 avec sa clé de contrôle. */
export const ean = (d12: string) => d12 + ((10 - ([...d12].reduce((s, c, i) => s + Number(c) * (i % 2 ? 3 : 1), 0) % 10)) % 10);

/** Famille, désignation, achat, vente, stock (pièces), conditionnement. */
export const ARTICLES: [string, string, number, number, number, [string, number, number]?][] = [
  ['Riz et céréales', 'RIZ PARFUMÉ 5 KG', 4200, 5000, 40, ['SAC DE 5', 5, 24000]],
  ['Huiles', 'HUILE DIAMAOR 1 L', 1300, 1600, 60, ['CARTON DE 12', 12, 18500]],
  ['Sucre et farine', 'SUCRE SOSUCAM 1 KG', 750, 900, 80, ['BALLE DE 10', 10, 8700]],
  ['Laitiers', 'LAIT DOLAIT 400 G', 2100, 2600, 8],
  ['Pâtes', 'SPAGHETTI PANZANI 500 G', 420, 550, 120, ['CARTON DE 20', 20, 10500]],
  ['Jus et sodas', 'COCA-COLA 50 CL', 380, 500, 144, ['PACK DE 12', 12, 5800]],
  ['Eaux', 'EAU SUPERMONT 1,5 L', 280, 400, 200, ['PACK DE 6', 6, 2300]],
  ['Jus et sodas', 'JUS FOLLER ORANGE 1 L', 900, 1200, 0],
  ['Bières', 'BIÈRE CASTEL 65 CL', 520, 650, 96, ['CASIER DE 12', 12, 7500]],
  ['Savons', 'SAVON AZUR 200 G', 250, 350, 3],
  ['Soins du corps', 'DENTIFRICE SIGNAL 100 ML', 650, 900, 35],
  ['Ménage', 'PAPIER TOILETTE LOTUS X4', 900, 1250, 50],
];

export async function trySeed(label: string, fn: () => Promise<unknown>) {
  try {
    return await fn();
  } catch (e) {
    console.log(`[seed] ${label} : ${(e as Error).message}`);
    return undefined;
  }
}

/** La superette d'exemple : articles, stock, clients, fournisseurs, utilisateurs, ventes, dépenses. */
export async function seed(page: Page, opts: { beforeSales?: () => Promise<void> } = {}) {
  const vat = (await invoke<{ id: string; rate_bp?: number }[]>(page, 'admin.vatRates'))[0]!;
  const wh = (await invoke<{ id: string }[]>(page, 'admin.warehouses'))[0]!;
  const [store] = await invoke<{ id: string }[]>(page, 'admin.stores');
  const depts: Record<string, string | null> = {};
  for (const d of await invoke<{ families: { id: string; name: string }[] }[]>(page, 'catalogue.departments')) for (const f of d.families) depts[f.name] = f.id;
  const ids: string[] = [];
  for (const [i, [dept, name, buy, sell, qty, pack]] of ARTICLES.entries()) {
    const a = await invoke<{ id: string }>(page, 'catalogue.save', {
      name,
      unit: 'piece',
      familyId: depts[dept],
      vatRateId: vat.id,
      purchasePrice: buy,
      salePrice: sell,
      alertQty: 10_000,
      minQty: 5_000,
      quickKey: i < 8,
      barcodes: [{ code: ean(`60012345${String(i).padStart(4, '0')}`) }],
      ...(pack ? { packs: [{ name: pack[0], contains: pack[1], salePrice: pack[2] }] } : {}),
    });
    ids.push(a.id);
    if (qty) await invoke(page, 'stock.receive', { warehouseId: wh.id, lines: [{ articleId: a.id, qty: qty * 1000, unitCost: buy }] });
  }
  const reg = (await invoke<{ registers: { id: string }[] }>(page, 'treasury.state')).registers[0]!;
  await trySeed('utilisateurs', async () => {
    await invoke(page, 'admin.createUser', { name: 'Awa Ngono', login: 'awa', pin: '5555', role: 'cashier', storeId: store!.id, registerId: reg.id });
    await invoke(page, 'admin.createUser', { name: 'Paul Etoa', login: 'paul', pin: '1111', role: 'seller', storeId: store!.id });
    await invoke(page, 'admin.createUser', { name: 'Jean Mbarga', login: 'jean', pin: '2222', role: 'stock', storeId: store!.id });
  });
  const customers: string[] = [];
  for (const [name, phone, limit] of [
    ['Mballa Joseph', '677 12 34 56', 200_000],
    ['Restaurant Le Bon Goût', '699 88 77 66', 500_000],
    ['Ngo Bassa Marie', '655 44 33 22', 50_000],
  ] as const) {
    const c = (await trySeed('client ' + name, () => invoke<{ id: string }>(page, 'customers.save', { name, phone, creditLimit: limit, paymentTermsDays: 30 }))) as { id: string } | undefined;
    if (c) customers.push(c.id);
  }
  const suppliers: string[] = [];
  for (const [name, phone] of [
    ['SABC (Brasseries du Cameroun)', '233 42 00 00'],
    ['Grossiste Akwa Distribution', '677 00 11 22'],
  ] as const) {
    const s = (await trySeed('fournisseur ' + name, () => invoke<{ id: string }>(page, 'suppliers.save', { name, phone, paymentTermsDays: 30, leadTimeDays: 3 }))) as { id: string } | undefined;
    if (s) suppliers.push(s.id);
  }
  if (opts.beforeSales) await opts.beforeSales();
  await trySeed('ouverture de caisse', () => invoke(page, 'treasury.open', 25_000, undefined, reg.id));
  const baskets: [number, number][][] = [[[0, 1], [1, 2]], [[5, 6]], [[3, 1], [4, 4]], [[6, 6], [9, 2]], [[8, 12]], [[2, 3], [10, 1]], [[11, 2], [5, 2]], [[1, 1], [4, 2], [6, 3]]];
  for (const b of baskets) {
    const lines = b.map(([i, q]) => ({ articleId: ids[i]!, qty: q * 1000 }));
    const total = b.reduce((t, [i, q]) => t + ARTICLES[i]![3] * q, 0);
    await trySeed('vente', () => invoke(page, 'pos.sell', { lines, payments: [{ method: 'CASH', amount: total }] }));
  }
  await trySeed('vente MoMo', () => invoke(page, 'pos.sell', { lines: [{ articleId: ids[0]!, qty: 2000 }], payments: [{ method: 'MTN_MOMO', amount: 10_000, reference: 'MP241028.1532.A12345' }] }));
  if (customers[1]) {
    await trySeed('vente à crédit', () =>
      invoke(page, 'pos.sell', { customerId: customers[1], lines: [{ articleId: ids[1]!, qty: 12_000 }, { articleId: ids[0]!, qty: 4000 }], payments: [{ method: 'CUSTOMER_CREDIT', amount: 12 * 1600 + 4 * 5000 }] }),
    );
  }
  if (customers[0]) {
    await trySeed('vente à crédit 2', () => invoke(page, 'pos.sell', { customerId: customers[0], lines: [{ articleId: ids[8]!, qty: 24_000 }], payments: [{ method: 'CUSTOMER_CREDIT', amount: 24 * 650 }] }));
    await trySeed('règlement', () => invoke(page, 'customers.pay', { customerId: customers[0], method: 'CASH', amount: 5000, atRegister: true }));
  }
  if (suppliers[0]) {
    await trySeed('commande', () =>
      invoke(page, 'purchases.createOrder', { supplierId: suppliers[0], warehouseId: wh.id, lines: [{ articleId: ids[8]!, qty: 120_000, unitCost: 520 }, { articleId: ids[5]!, qty: 96_000, unitCost: 380 }] }),
    );
  }
  if (suppliers[1]) {
    await trySeed('facture directe', () =>
      invoke(page, 'purchases.directInvoice', {
        supplierId: suppliers[1],
        supplierNumber: 'FA-2026-0412',
        invoiceDate: new Date().toISOString().slice(0, 10),
        warehouseId: wh.id,
        lines: [{ articleId: ids[2]!, qty: 50_000, unitCost: 750 }, { articleId: ids[4]!, qty: 100_000, unitCost: 420 }],
      }),
    );
  }
  const cats = (await trySeed('catégories', () => invoke<{ id: string; name: string }[]>(page, 'expenses.categories'))) as { id: string; name: string }[] | undefined;
  if (cats?.length) {
    const cat = (re: RegExp) => (cats.find((c) => re.test(c.name)) ?? cats[0]!).id;
    await trySeed('dépense 1', () => invoke(page, 'expenses.record', { categoryId: cat(/transport/i), label: 'Taxi pour la livraison', amount: 2000, method: 'CASH', atRegister: true }));
    await trySeed('dépense 2', () => invoke(page, 'expenses.record', { categoryId: cat(/électricité|eneo/i), label: 'Facture ENEO octobre', beneficiary: 'ENEO', amount: 48_500, method: 'MTN_MOMO', reference: 'MP241028.0901.B5521' }));
  }
  if (customers[1]) await trySeed('devis', () => invoke(page, 'quotes.save', { kind: 'quote', customerId: customers[1], validDays: 15, lines: [{ articleId: ids[1]!, qty: 24_000 }, { articleId: ids[6]!, qty: 36_000 }] }));
  await trySeed('collaborateur', () => invoke(page, 'staff.save', { name: 'Eric Fotso', position: 'Manutentionnaire', phone: '690 11 22 33', baseSalary: 60_000, hiredOn: '2026-01-05' }));
  return { ids, customers, suppliers, reg };
}

/** Ferme toutes les fenêtres ouvertes. */
export async function closeAll(page: Page) {
  await page.keyboard.press('Escape');
  if (await page.locator('.modal').count()) await page.keyboard.press('Escape');
  for (let i = 0; i < 12; i++) {
    const x = page.locator('main.windows > section.mdi .mdi-x');
    if (!(await x.count())) break;
    await x.last().click({ force: true }).catch(() => undefined);
    await page.waitForTimeout(150);
  }
}

/** Ouvre une fenêtre (et son onglet) comme le font les menus, agrandie. */
export async function open(page: Page, kind: string, tab?: string) {
  await closeAll(page);
  await page.evaluate(([k, t]) => window.dispatchEvent(new CustomEvent('fedonix:open', { detail: t ? [k, t] : [k] })), [kind, tab] as const);
  await page.waitForTimeout(800);
  const bar = page.locator('main.windows > section.mdi.active:not(.max) .mdi-bar');
  if (await bar.count()) await bar.first().dblclick().catch(() => undefined);
}
