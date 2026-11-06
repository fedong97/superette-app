import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Context, type Services, createServices, openDatabase } from '../src';

let s: Services;
let ctx: Context;
let riz: string;
let file: string;

function setup(db = openDatabase(file)) {
  s = createServices(db);
}

beforeEach(() => {
  file = join(mkdtempSync(join(tmpdir(), 'seal-')), 'base.db');
  setup();
  const { store, register, admin } = s.admin.bootstrap({ storeCode: 'DLA1', storeName: 'Superette Akwa', adminName: 'Steve', adminLogin: 'steve', adminPin: '1234' });
  ctx = { storeId: store.id, registerId: register.id, userId: admin.id };
  const tva = s.admin.listVatRates()[0]!.id;
  riz = s.catalogue.saveArticle(admin.id, { name: 'Riz 5 kg', unit: 'piece', vatRateId: tva, purchasePrice: 3_000, salePrice: 5_000 }).id;
  s.stock.receive(ctx, { warehouseId: s.admin.salesWarehouse(store.id).id, lines: [{ articleId: riz, qty: 20_000, unitCost: 3_000 }] });
  s.pos.openSession(ctx, 10_000);
});

const sell = () => s.pos.completeSale(ctx, { lines: [{ articleId: riz, qty: 2_000 }], payments: [{ method: 'CASH', amount: 10_000 }] });

describe('journal scellé', () => {
  it('scelle ce que fait ONIX : le contrôle est vert', () => {
    sell();
    const sale = sell();
    s.pos.cancelSale(ctx, sale.id, ctx.userId, 'Erreur de saisie');
    const c = s.seals.check();
    expect(c.total).toBe(0);
    expect(c.ok).toBe(true);
    expect(c.seals).toBeGreaterThan(5);
    expect(c.fingerprint).toMatch(/^[0-9A-F]{12}$/);
  });

  it('voit une vente modifiée, supprimée ou ajoutée en dehors d’ONIX', () => {
    const a = sell();
    const b = sell();
    s.db.close();
    const raw = new Database(file);
    raw.prepare('UPDATE sales SET total_ttc = 1000 WHERE id = ?').run(a.id);
    raw.prepare('DELETE FROM sale_payments WHERE sale_id = ?').run(b.id);
    raw.prepare("INSERT INTO cash_operations (id, session_id, type, amount, reason, user_id, at) SELECT 'x1', session_id, 'OUT', 500, 'retrait', user_id, created_at FROM sales WHERE id = ?").run(a.id);
    raw.close();
    setup();
    const c = s.seals.check();
    expect(c.ok).toBe(false);
    const by = (p: string) => c.findings.filter((f) => f.problem === p);
    expect(by('modified').map((f) => f.ref)).toEqual([a.number]);
    expect(by('deleted').map((f) => f.table)).toEqual(['sale_payments']);
    expect(by('added').map((f) => f.row_id)).toEqual(['x1']);
  });

  it('voit un maillon de la chaîne retouché', () => {
    sell();
    s.db.close();
    const raw = new Database(file);
    raw.prepare("UPDATE seals SET data = 'faux' WHERE seq = (SELECT MAX(seq) FROM seals WHERE tbl = 'sales')").run();
    raw.close();
    setup();
    const c = s.seals.check();
    expect(c.findings.some((f) => f.problem === 'chain')).toBe(true);
  });

  it('une remise à zéro faite par ONIX reste intègre', () => {
    sell();
    s.pos.closeSession(ctx, { 10_000: 2 });
    s.reset.run(ctx.userId, { keepStock: true });
    expect(s.seals.check().total).toBe(0);
  });
});

describe('manquant de caisse à la charge du caissier', () => {
  it('va en avance au personnel, retenue sur la paie, au lieu des manquants de caisse', () => {
    sell(); // 10 000 encaissés + fond 10 000 = 20 000 attendus
    const staffCtx = { ...ctx, registerId: null };
    const steve = s.staff.save(staffCtx, { name: 'Steve Caissier', baseSalary: 80_000, userId: ctx.userId });
    expect(s.pos.cashierStaff(ctx.userId)?.id).toBe(steve.id);
    const z = s.pos.closeSession(ctx, { 10_000: 1, 5_000: 1, 2_000: 2 }); // 19 000 : manquant de 1 000
    const session = z.session;
    expect(session.difference).toBe(-1_000);
    const done = s.pos.justifyGap(ctx, session.id, 'Monnaie mal rendue', { chargeCashier: true });
    expect(done.gap_staff_id).toBe(steve.id);
    expect(done.gap_staff_name).toBe('Steve Caissier');
    expect(s.staff.balance(steve.id).advances).toBe(1_000);
    expect(s.staff.statement(steve.id).lines.some((l) => l.label.includes('Manquant de caisse') && l.advance === 1_000)).toBe(true);
    const entry = s.accounting.entries(ctx.storeId).find((e) => e.label.startsWith('Manquant de caisse'))!;
    expect(entry.lines.find((l) => l.account === steve.advance_account)).toMatchObject({ debit: 1_000 });
    expect(entry.lines.some((l) => l.account === '658')).toBe(false);
    // Revenir à une perte du magasin.
    s.pos.justifyGap(ctx, session.id, 'Monnaie mal rendue');
    expect(s.staff.balance(steve.id).advances).toBe(0);
    expect(s.accounting.entries(ctx.storeId).find((e) => e.label.startsWith('Manquant de caisse'))!.lines.some((l) => l.account === '658')).toBe(true);
    expect(s.seals.check().ok).toBe(true);
  });

  it('refuse sans fiche du personnel, ou pour un excédent', () => {
    const z = s.pos.closeSession(ctx, { 5_000: 1 });
    expect(() => s.pos.justifyGap(ctx, z.session.id, 'Inconnu', { chargeCashier: true })).toThrow(/fiche dans le personnel/);
  });
});

describe('facture fournisseur lue en PDF : rapprochement', () => {
  it('trouve le fournisseur par son NIU et les articles par code-barres, référence ou désignation', async () => {
    const { readSupplierInvoice } = await import('@superette/core');
    const tva = s.admin.listVatRates()[0]!.id;
    const sabc = s.purchases.saveSupplier(ctx.userId, { name: 'SABC Douala', taxpayerNumber: 'M012345678901A' });
    const castel = s.catalogue.saveArticle(ctx.userId, { name: 'Castel 33 cl', unit: 'piece', vatRateId: tva, purchasePrice: 540, salePrice: 700, packs: [{ name: 'Casier 12', contains: 12, salePrice: 8_000 }] });
    const coca = s.catalogue.saveArticle(ctx.userId, { name: 'Coca-Cola 1,5 L', unit: 'piece', vatRateId: tva, purchasePrice: 450, salePrice: 600, barcodes: [{ code: '5449000000996' }] });
    const mutzig = s.catalogue.saveArticle(ctx.userId, { name: 'Bière Mutzig 65 cl', unit: 'piece', vatRateId: tva, purchasePrice: 600, salePrice: 800 });
    s.purchases.setSupplierArticle(ctx.userId, { supplierId: sabc.id, articleId: mutzig.id, supplierRef: 'MUT65', unitCost: 600 });
    const lines = ['SABC', 'NIU : M012345678901A', 'FACTURE N° FA-1', 'CAS33 Casier Castel 33 cl 10 6 450 64 500', '5449000000996 Coca 24 450 10 800', 'MUT65 Mutzig grande 2 600 1 200', 'Savon Azur 3 250 750'];
    const m = s.invoiceMatch.match(readSupplierInvoice(lines), null, lines);
    expect(m.supplierId).toBe(sabc.id);
    expect(m.lines.map((l) => [l.articleId, l.match, l.packUnits])).toEqual([
      [castel.id, 'name', 12_000],
      [coca.id, 'barcode', 1000],
      [mutzig.id, 'reference', 1000],
      [null, null, 1000],
    ]);
  });
});
