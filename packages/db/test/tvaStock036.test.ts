import { beforeEach, describe, expect, it } from 'vitest';
import { type Context, type Services, createServices, openDatabase } from '../src';

let s: Services;
let ctx: Context;
let storeId: string;
let adminId: string;
let wh: string;
let dolait: string;
const now = new Date('2026-10-11T09:00:00Z');

beforeEach(() => {
  s = createServices(openDatabase(':memory:'), () => now);
  const { store, register, admin } = s.admin.bootstrap({ storeCode: 'DLA1', storeName: 'Superette Akwa', adminName: 'Steve', adminLogin: 'steve', adminPin: '1234' });
  storeId = store.id;
  adminId = admin.id;
  ctx = { storeId, registerId: register.id, userId: admin.id };
  wh = s.admin.salesWarehouse(storeId).id;
  const tva = s.admin.listVatRates().find((r) => r.rate_bp === 1925)!.id;
  dolait = s.catalogue.saveArticle(admin.id, { name: 'DOLAIT 400 G', unit: 'piece', vatRateId: tva, purchasePrice: 1_500, salePrice: 2_000 }).id;
});

const rateOf = (articleId: string) => s.db.prepare('SELECT r.rate_bp FROM articles a JOIN vat_rates r ON r.id = a.vat_rate_id WHERE a.id = ?').pluck().get(articleId);

describe('TVA désactivée', () => {
  it('les articles passent à « Exonéré » et la vente se fait sans TVA', () => {
    const store = s.admin.setStoreOptions(adminId, storeId, { vatEnabled: false });
    expect(store.articlesExempted).toBe(1);
    expect(rateOf(dolait)).toBe(0);
    expect(s.sync.pending().some((e) => e.entity === 'article' && e.entityId === dolait)).toBe(true);
    s.stock.receive(ctx, { warehouseId: wh, lines: [{ articleId: dolait, qty: 10_000, unitCost: 1_500 }] });
    const [line] = s.pos.priceLines(storeId, [{ articleId: dolait, qty: 1_000 }]);
    expect(line).toMatchObject({ vatRate: 0 });
  });

  it('un article encore taxé est lu à 0 % dans un magasin sans TVA', () => {
    // Autre magasin assujetti : les articles (communs) gardent leur taux, ce magasin le lit à 0 %.
    const other = s.admin.createStore(adminId, { storeCode: 'YDE1', storeName: 'Superette Bastos' });
    expect(other.vat_enabled).toBe(1);
    const store = s.admin.setStoreOptions(adminId, storeId, { vatEnabled: false });
    expect(store.articlesExempted).toBeUndefined();
    expect(rateOf(dolait)).toBe(1925);
    expect(s.catalogue.getArticle(dolait, storeId).vat_rate_bp).toBe(0);
    expect(s.catalogue.getArticle(dolait, other.id).vat_rate_bp).toBe(1925);
  });

  it('l’import met les articles à Exonéré, quelle que soit la colonne TVA', () => {
    s.admin.setStoreOptions(adminId, storeId, { vatEnabled: false });
    s.catalogue.importArticles(adminId, [{ name: 'Lait Nido 400 g', salePrice: 3_000, vatRateBp: 1925 }], { noVat: true });
    const id = s.db.prepare("SELECT id FROM articles WHERE name = 'LAIT NIDO 400 G' OR name = 'Lait Nido 400 g'").pluck().get() as string;
    expect(rateOf(id)).toBe(0);
  });

  it('TVA réactivée : les articles exonérés reviennent à 19,25 % sur demande', () => {
    s.admin.setStoreOptions(adminId, storeId, { vatEnabled: false });
    s.admin.setStoreOptions(adminId, storeId, { vatEnabled: true });
    expect(rateOf(dolait)).toBe(0);
    expect(s.admin.setArticlesRate(adminId, 'standard')).toBe(1);
    expect(rateOf(dolait)).toBe(1925);
  });

  it('le classeur des ventes n’a plus ni feuille TVA ni colonne HT', () => {
    s.admin.setStoreOptions(adminId, storeId, { vatEnabled: false });
    const sheets = s.reports.salesWorkbook(storeId, { from: '2026-10-01', to: '2026-10-31', dimension: 'department' });
    expect(sheets.map((sh) => sh.name)).not.toContain('TVA');
    const headers = sheets.flatMap((sh) => sh.columns.map((c) => c.header));
    expect(headers.some((h) => /\b(HT|TTC|TVA)\b/.test(h))).toBe(false);
    expect(sheets[0]!.rows.map((r) => r[0])).toContain('Chiffre d’affaires');
    expect(s.reports.salesExportCsv(storeId, '2026-10-01', '2026-10-31')).toContain('Prix unitaire;Remise;Total');
  });
});

describe('stock multi-magasin', () => {
  it('ne publie que le stock qui a changé depuis le dernier envoi', () => {
    s.stock.receive(ctx, { warehouseId: wh, lines: [{ articleId: dolait, qty: 38_000, unitCost: 1_500 }] });
    expect(s.sync.publishStock(storeId)).toBe(1);
    expect(s.sync.publishStock(storeId)).toBe(0);
    const event = s.sync.pending().find((e) => e.entity === 'stock_level')!;
    expect(event).toMatchObject({ entityId: `${wh}:${dolait}`, storeId: null, payload: { warehouse_id: wh, article_id: dolait, qty: 38_000 } });
    s.stock.receive(ctx, { warehouseId: wh, lines: [{ articleId: dolait, qty: 2_000, unitCost: 1_500 }] });
    expect(s.sync.publishStock(storeId)).toBe(1);
  });

  it('affiche le stock de chaque magasin, avec la date du dernier envoi', () => {
    s.stock.receive(ctx, { warehouseId: wh, lines: [{ articleId: dolait, qty: 38_000, unitCost: 1_500 }] });
    const bastos = s.admin.createStore(adminId, { storeCode: 'YDE1', storeName: 'Superette Bastos' });
    const bastosWh = s.admin.salesWarehouse(bastos.id).id;
    const level = (warehouseId: string, qty: number, at: string) => ({
      id: `ev-${warehouseId}-${at}`,
      entity: 'stock_level',
      entityId: `${warehouseId}:${dolait}`,
      op: 'upsert' as const,
      storeId: null,
      registerId: null,
      createdAt: at,
      payload: { warehouse_id: warehouseId, article_id: dolait, qty, updated_at: at },
    });
    s.sync.applyRemote([level(bastosWh, 12_000, '2026-10-11T08:00:00Z'), level(bastosWh, 9_000, '2026-10-11T07:00:00Z'), level(wh, 1_000, '2026-10-11T08:00:00Z')]);
    const d = s.controls.stockByStore(storeId, {});
    expect(d.stores.map((x) => [x.name, x.own, x.updated_at])).toEqual([
      ['Superette Akwa', true, null],
      ['Superette Bastos', false, '2026-10-11T08:00:00Z'],
    ]);
    // Le plus récent l'emporte ; le stock d'Akwa reste celui de ses propres mouvements.
    const row = d.rows.find((r) => r.article_id === dolait)!;
    expect(row.byStore).toEqual({ [storeId]: 38_000, [bastos.id]: 12_000 });
    expect(row.byWarehouse[bastosWh]).toBe(12_000);
    expect(row.total).toBe(50_000);
    expect(s.controls.stockByStore(storeId, { shortage: true }).rows).toHaveLength(0);
    expect(s.controls.stockByStore(storeId, { search: 'nido' }).rows).toHaveLength(0);
  });
});
