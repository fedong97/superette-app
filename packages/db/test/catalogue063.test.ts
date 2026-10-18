import { beforeEach, describe, expect, it } from 'vitest';
import { buildArticleExport, exportToDelimited, parseArticlesText } from '@superette/core';
import { type Context, type Services, createServices, openDatabase } from '../src';

let s: Services;
let ctx: Context;
let tva: string;
let now: Date;

beforeEach(() => {
  now = new Date('2026-10-10T08:00:00Z');
  s = createServices(openDatabase(':memory:'), () => now);
  const { store, register, admin } = s.admin.bootstrap({ storeCode: 'DLA1', storeName: 'Superette Akwa', adminName: 'Steve', adminLogin: 'steve', adminPin: '1234' });
  ctx = { storeId: store.id, registerId: register.id, userId: admin.id };
  tva = s.admin.listVatRates().find((r) => r.rate_bp === 1925)!.id;
});

const art = (code: string) => {
  const id = s.catalogue.findByCode(code);
  return id ? s.catalogue.getArticle(id, ctx.storeId) : null;
};
const reserve = () => s.admin.listWarehouses(ctx.storeId).find((w) => w.name === 'Réserve')!;

describe('dépôts', () => {
  it('modifie le nom, le type et la fiche, refuse un nom en double', () => {
    const w = s.admin.updateWarehouse(ctx.userId, reserve().id, { name: ' Réserve Bonabéri ', kind: 'cold', manager: 'Paul', phone: '699000000', address: 'Bonabéri' });
    expect(w).toMatchObject({ name: 'Réserve Bonabéri', kind: 'cold', manager: 'Paul', phone: '699000000', address: 'Bonabéri' });
    const sales = s.admin.salesWarehouse(ctx.storeId);
    expect(() => s.admin.updateWarehouse(ctx.userId, w.id, { name: sales.name.toUpperCase(), kind: 'shop' })).toThrow(/déjà/);
    expect(() => s.admin.updateWarehouse(ctx.userId, w.id, { name: '  ', kind: 'shop' })).toThrow(/nom/);
  });

  it('désactive un dépôt vide seulement, jamais le dépôt des ventes', () => {
    const r = reserve();
    const lait = s.catalogue.saveArticle(ctx.userId, { name: 'Lait', unit: 'piece', vatRateId: tva, purchasePrice: 500, salePrice: 700 });
    s.stock.receive(ctx, { warehouseId: r.id, lines: [{ articleId: lait.id, qty: 2_000, unitCost: 500 }] });
    expect(() => s.admin.setWarehouseActive(ctx.userId, r.id, false)).toThrow(/en stock/);
    s.transfers.ship(ctx, s.transfers.create(ctx, { fromWarehouseId: r.id, toWarehouseId: s.admin.salesWarehouse(ctx.storeId).id, lines: [{ articleId: lait.id, qty: 2_000 }] }).id);
    expect(() => s.admin.setWarehouseActive(ctx.userId, r.id, false)).toThrow(/transfert/);
    expect(() => s.admin.setWarehouseActive(ctx.userId, s.admin.salesWarehouse(ctx.storeId).id, false)).toThrow(/dépôt des ventes/);
  });

  it('un dépôt désactivé sort des listes et peut redevenir dépôt des ventes une fois réactivé', () => {
    const r = reserve();
    expect(s.admin.setWarehouseActive(ctx.userId, r.id, false).active).toBe(0);
    expect(s.admin.listWarehouses(ctx.storeId).some((w) => w.id === r.id)).toBe(false);
    expect(s.admin.listWarehouses(ctx.storeId, { includeInactive: true }).some((w) => w.id === r.id)).toBe(true);
    expect(() => s.admin.setSalesWarehouse(ctx.userId, r.id)).toThrow(/désactivé/);
    s.admin.setWarehouseActive(ctx.userId, r.id, true);
    s.admin.setSalesWarehouse(ctx.userId, r.id);
    expect(s.admin.salesWarehouse(ctx.storeId).id).toBe(r.id);
  });
});

describe('import des articles', () => {
  const csv = [
    'Code;Désignation;Code-barres;Rayon;Famille;Prix achat;Prix vente;Prix gros;Prix super gros;Stock mini;Cond. 1 nom;Cond. 1 contient;Cond. 1 prix;Cond. 1 gros;Cond. 1 code-barres;Cond. 2 nom;Cond. 2 contient;Cond. 2 prix',
    'COCA50;Coca-Cola 50 cl;5449000000996;Boissons;Sodas;300;500;450;420;24;Carton;4;11000;10500;5449000000002;Pack;6;2900',
    ';Eau Supermont 1,5 L;;Boissons;Eaux;200;350;;;;;;;;;;;',
  ].join('\n');

  it('importe prix, tarifs, seuils et conditionnements avec leurs codes-barres', () => {
    const rows = parseArticlesText(csv);
    const res = s.catalogue.importArticles(ctx.userId, rows);
    expect(res).toMatchObject({ created: 2, updated: 0, errors: [] });
    const coca = art('COCA50')!;
    expect(coca).toMatchObject({ name: 'Coca-Cola 50 cl', purchase_price: 300, sale_price: 500, wholesale_price: 450, super_wholesale_price: 420, min_qty: 24_000 });
    expect(coca.packs.map((p) => [p.name, p.contains, p.units, p.sale_price, p.wholesale_price, p.barcode])).toEqual([
      ['CARTON', 4, 24_000, 11_000, 10_500, '5449000000002'],
      ['PACK', 6, 6_000, 2_900, null, null],
    ]);
    expect(coca.barcodes.map((b) => b.code)).toContain('5449000000996');
  });

  it('l’aperçu n’enregistre rien ; réimporter met à jour sans doublon, même sans code ni code-barres', () => {
    const preview = s.catalogue.importArticles(ctx.userId, parseArticlesText(csv), { preview: true });
    expect(preview.created).toBe(2);
    expect(art('COCA50')).toBeFalsy();
    s.catalogue.importArticles(ctx.userId, parseArticlesText(csv));
    const again = s.catalogue.importArticles(ctx.userId, parseArticlesText(csv.replace(';200;350;', ';220;375;')));
    expect(again).toMatchObject({ created: 0, updated: 2 });
    const count = s.db.prepare("SELECT COUNT(*) FROM articles WHERE name LIKE 'Eau Supermont%'").pluck().get();
    expect(count).toBe(1);
  });

  it('les modes créer seulement et mettre à jour seulement laissent les autres lignes de côté', () => {
    s.catalogue.importArticles(ctx.userId, parseArticlesText(csv.split('\n').slice(0, 2).join('\n')));
    const create = s.catalogue.importArticles(ctx.userId, parseArticlesText(csv), { mode: 'create' });
    expect(create).toMatchObject({ created: 1, updated: 0, skipped: 1 });
    const update = s.catalogue.importArticles(ctx.userId, [{ name: 'Inconnu', salePrice: 100 }, { name: 'Coca-Cola 50 cl', salePrice: 550 }], { mode: 'update' });
    expect(update).toMatchObject({ created: 0, updated: 1, skipped: 1 });
    expect(art('COCA50')!.sale_price).toBe(550);
  });

  it('une colonne absente garde la valeur de la fiche ; une ligne en erreur n’empêche pas les autres', () => {
    s.catalogue.importArticles(ctx.userId, parseArticlesText(csv));
    const res = s.catalogue.importArticles(ctx.userId, [{ name: 'Coca-Cola 50 cl', code: 'COCA50', salePrice: 520 }, { line: 3, name: 'Sans prix' }]);
    expect(res.updated).toBe(1);
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0]!.row).toBe(3);
    const coca = art('COCA50')!;
    expect(coca).toMatchObject({ sale_price: 520, purchase_price: 300, wholesale_price: 450 });
    expect(coca.packs).toHaveLength(2);
  });

  it('lit le fichier article de Sage tel quel (famille, prix, remplaçant)', () => {
    const sage = ['Référence;Désignation;Famille;Prix d\'achat;Prix de vente;Unité de vente;Article de substitution', 'RIZ5;Riz parfumé 5 kg;RIZ;3 000,00;4 200,00;Pièce;RIZ25', 'RIZ25;Riz parfumé 25 kg;RIZ;14 000,00;19 500,00;Pièce;'].join('\n');
    const res = s.catalogue.importArticles(ctx.userId, parseArticlesText(sage));
    expect(res).toMatchObject({ created: 2, errors: [] });
    const riz = art('RIZ5')!;
    expect(riz).toMatchObject({ sale_price: 4_200, purchase_price: 3_000, family_name: 'RIZ', substitute_code: 'RIZ25' });
  });

  it('le catalogue exporté se réimporte sans rien changer', () => {
    s.catalogue.importArticles(ctx.userId, parseArticlesText(csv));
    const data = buildArticleExport('catalogue', s.catalogue.listForExport(ctx.storeId));
    const text = exportToDelimited(data, { separator: ';', decimal: ',', header: true });
    const before = art('COCA50')!;
    const res = s.catalogue.importArticles(ctx.userId, parseArticlesText(text), { mode: 'update' });
    expect(res).toMatchObject({ created: 0, updated: 2, errors: [] });
    const after = art('COCA50')!;
    expect(after.packs.map((p) => [p.name, p.contains, p.sale_price, p.barcode])).toEqual(before.packs.map((p) => [p.name, p.contains, p.sale_price, p.barcode]));
    expect([after.sale_price, after.wholesale_price, after.min_qty]).toEqual([before.sale_price, before.wholesale_price, before.min_qty]);
  });
});

describe('export, prix et fiche article', () => {
  it('l’export de comptage porte le stock et l’emplacement du dépôt', () => {
    const lait = s.catalogue.saveArticle(ctx.userId, { name: 'Lait Nido', unit: 'piece', vatRateId: tva, purchasePrice: 2_700, salePrice: 3_250 });
    const r = reserve();
    s.stock.receive(ctx, { warehouseId: r.id, lines: [{ articleId: lait.id, qty: 12_000, unitCost: 2_700 }] });
    s.catalogue.setLocation(ctx.userId, lait.id, r.id, 'Allée 3 / Étagère B');
    const data = buildArticleExport('count', s.catalogue.listForExport(ctx.storeId), { warehouses: [{ id: r.id, name: r.name }], withExpected: true });
    const row = data.rows.find((x) => x.includes('Lait Nido'))!;
    expect(row).toContain('ALLÉE 3 / ÉTAGÈRE B');
    expect(data.columns.length).toBeGreaterThan(3);
  });

  it('augmente les prix de vente de 10 % arrondis à 25 FCFA, conditionnements compris', () => {
    s.catalogue.importArticles(ctx.userId, parseArticlesText('Code;Désignation;Prix achat;Prix vente;Cond. 1 nom;Cond. 1 contient;Cond. 1 prix\nC1;Coca;300;500;Carton;24;11000'));
    const input = { target: 'sale' as const, method: 'percent' as const, value: 10, packs: true, tiers: false, rounding: 25 };
    const plan = s.catalogue.planPriceUpdate(ctx.storeId, input);
    expect(plan.articles[0]!.lines.map((l) => [l.old, l.next])).toEqual(expect.arrayContaining([[500, 550], [11_000, 12_100]]));
    expect(art('C1')!.sale_price).toBe(500);
    s.catalogue.applyPriceUpdate(ctx.userId, ctx.storeId, input);
    const c = art('C1')!;
    expect([c.sale_price, c.packs[0]!.sale_price]).toEqual([550, 12_100]);
  });

  it('codifie par famille et refuse un article qui se remplace lui-même', () => {
    const dep = s.catalogue.createDepartment('Boissons');
    const fam = s.catalogue.createFamily(dep.id, 'Sodas');
    const a = s.catalogue.saveArticle(ctx.userId, { name: 'Fanta', unit: 'piece', vatRateId: tva, purchasePrice: 300, salePrice: 500, familyId: fam.id }, undefined, { codeByFamily: true });
    const b = s.catalogue.saveArticle(ctx.userId, { name: 'Sprite', unit: 'piece', vatRateId: tva, purchasePrice: 300, salePrice: 500, familyId: fam.id }, undefined, { codeByFamily: true });
    expect(a.code).toMatch(/^SOD-.*0001$/);
    expect(b.code).toMatch(/^SOD-.*0002$/);
    expect(() => s.catalogue.setSubstitute(ctx.userId, a.id, a.id)).toThrow();
    expect(s.catalogue.setSubstitute(ctx.userId, a.id, b.id).substitute_name).toBe('Sprite');
  });

  it('liste les produits sans vente sur la période', () => {
    const shop = s.admin.salesWarehouse(ctx.storeId).id;
    const coca = s.catalogue.saveArticle(ctx.userId, { name: 'Coca', unit: 'piece', vatRateId: tva, purchasePrice: 300, salePrice: 500 });
    const riz = s.catalogue.saveArticle(ctx.userId, { name: 'Riz', unit: 'piece', vatRateId: tva, purchasePrice: 3_000, salePrice: 4_200 });
    s.stock.receive(ctx, { warehouseId: shop, lines: [{ articleId: coca.id, qty: 10_000, unitCost: 300 }, { articleId: riz.id, qty: 5_000, unitCost: 3_000 }] });
    s.pos.openSession(ctx, 0);
    s.pos.completeSale(ctx, { lines: [{ articleId: coca.id, qty: 1_000 }], payments: [{ method: 'CASH', amount: 500 }] });
    const unsold = s.reports.unsold(ctx.storeId, '2026-10-01', '2026-10-31');
    expect(unsold.map((u) => u.name)).toEqual(['Riz']);
    expect(unsold[0]).toMatchObject({ qty: 5_000, value: 15_000 });
  });
});
