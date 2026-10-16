import { describe, expect, it } from 'vitest';
import { createServices, openDatabase } from '../src';

function setup() {
  let now = new Date('2026-10-13T09:00:00Z');
  const s = createServices(openDatabase(':memory:'), () => now);
  const { store, register, admin } = s.admin.bootstrap({ storeCode: 'DLA1', storeName: 'Superette Akwa', adminName: 'Steve', adminLogin: 'steve', adminPin: '1234' });
  const ctx = { storeId: store.id, registerId: register.id, userId: admin.id };
  const tva = s.admin.listVatRates().find((r) => r.rate_bp === 1925)!.id;
  const shop = s.admin.salesWarehouse(store.id);
  const reserve = s.admin.listWarehouses(store.id).find((w) => !w.is_sales_default) ?? s.admin.createWarehouse(store.id, 'Réserve', 'reserve');
  const castel = s.catalogue.saveArticle(admin.id, { name: 'CASTEL 65CL', unit: 'piece', vatRateId: tva, purchasePrice: 450, salePrice: 650 });
  const at = (iso: string) => {
    now = new Date(iso);
  };
  const qty = (warehouseId: string) => s.db.prepare('SELECT COALESCE(SUM(qty), 0) FROM stock WHERE article_id = ? AND warehouse_id = ?').pluck().get(castel.id, warehouseId) as number;
  return { s, ctx, store, admin, shop, reserve, castel, tva, at, qty };
}

describe('charges fixes : suppression', () => {
  it('efface une charge sans échéance constatée, arrête celle qui en a', () => {
    const { s, ctx, at } = setup();
    const eau = s.charges.savePlan(ctx, { categoryId: 'cat-eneo', label: 'CAMWATER', amount: 20_000, frequency: 'monthly', dueDay: 10, startMonth: '2026-10' });
    expect(s.charges.deletePlan(ctx, eau.id)).toEqual({ deleted: true, plan: null });
    expect(s.charges.listPlans(ctx.storeId, true)).toEqual([]);
    expect(s.db.prepare("SELECT op FROM outbox WHERE entity = 'charge_plan' AND entity_id = ? ORDER BY rowid DESC").pluck().get(eau.id)).toBe('delete');

    const loyer = s.charges.savePlan(ctx, { categoryId: 'cat-loyer', label: 'Loyer', amount: 150_000, frequency: 'monthly', dueDay: 5, startMonth: '2026-08' });
    at('2026-09-05T08:00:00Z');
    s.expenses.record(ctx, { categoryId: 'cat-loyer', label: 'Loyer septembre', amount: 150_000, method: 'CASH', planId: loyer.id, planPeriod: '2026-09' });
    at('2026-10-13T08:00:00Z');
    const r = s.charges.deletePlan(ctx, loyer.id);
    expect([r.deleted, r.plan?.active, r.plan?.end_month]).toEqual([false, 0, '2026-09']);
    // L'échéance payée reste, plus rien n'est en retard après septembre.
    const occ = s.charges.schedule(ctx.storeId, '2026-08', '2026-12').occurrences.filter((o) => o.plan_id === loyer.id);
    expect(occ.map((o) => [o.period, o.state])).toEqual([['2026-09', 'paid']]);
  });
});

describe('sauvegarde automatique programmée', () => {
  it('se refait toutes les N minutes une fois celle du jour faite', () => {
    const { s, admin, at } = setup();
    const setLast = (iso: string) => s.db.prepare("INSERT INTO settings (key, value) VALUES ('backup.lastAt', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(iso);
    setLast('2026-10-13T08:30:00Z');
    expect(s.backups.autoDue()).toBe(false);
    expect(() => s.backups.configure(admin.id, { everyMinutes: 7 })).toThrow(/Fréquence/);
    expect(s.backups.configure(admin.id, { everyMinutes: 60 }).every_minutes).toBe(60);
    expect(s.backups.autoDue()).toBe(false);
    at('2026-10-13T09:31:00Z');
    expect(s.backups.autoDue()).toBe(true);
    setLast('2026-10-13T09:31:00Z');
    expect(s.backups.autoDue()).toBe(false);
    s.backups.configure(admin.id, { everyMinutes: 0 });
    at('2026-10-13T15:00:00Z');
    expect(s.backups.autoDue()).toBe(false);
  });
});

describe('transferts : supprimer et modifier', () => {
  it('efface un brouillon, annule un transfert reçu et le reprend en brouillon', () => {
    const { s, ctx, shop, reserve, castel, qty } = setup();
    s.stock.receive(ctx, { warehouseId: reserve.id, lines: [{ articleId: castel.id, qty: 10_000, unitCost: 450 }] });
    const input = { fromWarehouseId: reserve.id, toWarehouseId: shop.id, lines: [{ articleId: castel.id, qty: 4_000 }] };

    const draft = s.transfers.create(ctx, input);
    expect(s.transfers.remove(ctx, draft.id)).toEqual({ deleted: true });
    expect(s.transfers.list(ctx.storeId)).toEqual([]);

    const t = s.transfers.create(ctx, input);
    s.transfers.ship(ctx, t.id);
    s.transfers.receive(ctx, t.id);
    expect([qty(reserve.id), qty(shop.id)]).toEqual([6_000, 4_000]);

    const copy = s.transfers.reopen(ctx, t.id);
    expect([qty(reserve.id), qty(shop.id)]).toEqual([10_000, 0]);
    expect(s.transfers.get(t.id).transfer.status).toBe('cancelled');
    expect(copy.status).toBe('draft');
    expect(s.transfers.get(copy.id).lines.map((l) => l.qty)).toEqual([4_000]);

    // Reçu puis vendu : l'annulation est refusée tant que le dépôt d'arrivée n'a plus la marchandise.
    s.transfers.ship(ctx, copy.id);
    s.transfers.receive(ctx, copy.id);
    s.stock.recordLoss(ctx, { warehouseId: shop.id, articleId: castel.id, qty: 1_000, type: 'BREAKAGE', reason: 'casse' });
    expect(() => s.transfers.remove(ctx, copy.id)).toThrow(/plus assez de CASTEL/);
    expect(s.transfers.list(ctx.storeId, { warehouseId: shop.id }).length).toBe(2);
  });
});

describe('exercices comptables', () => {
  function year2025() {
    let now = new Date('2025-03-01T09:00:00Z');
    const s = createServices(openDatabase(':memory:'), () => now);
    const { store, register, admin } = s.admin.bootstrap({ storeCode: 'DLA1', storeName: 'Superette Akwa', adminName: 'Steve', adminLogin: 'steve', adminPin: '1234' });
    const ctx = { storeId: store.id, registerId: register.id, userId: admin.id };
    const tva = s.admin.listVatRates().find((r) => r.rate_bp === 1925)!.id;
    const riz = s.catalogue.saveArticle(admin.id, { name: 'Riz 5 kg', unit: 'piece', vatRateId: tva, purchasePrice: 3_000, salePrice: 5_000 }).id;
    s.accounting.addManualEntry(ctx, {
      journal: 'AN',
      date: '2025-03-01',
      label: 'Apport initial',
      lines: [
        { account: '521', debit: 2_000_000, credit: 0 },
        { account: '101', debit: 0, credit: 2_000_000 },
      ],
    });
    s.stock.receive(ctx, { warehouseId: s.admin.salesWarehouse(store.id).id, lines: [{ articleId: riz, qty: 100_000, unitCost: 3_000 }] });
    const sabc = s.purchases.saveSupplier(admin.id, { name: 'Grossiste Mboppi' });
    s.purchases.createInvoice(ctx, { supplierId: sabc.id, supplierNumber: 'FA-1', invoiceDate: '2025-03-01', totalHt: 300_000, totalTva: 57_750 });
    s.pos.openSession(ctx, 0);
    s.pos.completeSale(ctx, { lines: [{ articleId: riz, qty: 40_000 }], payments: [{ method: 'CASH', amount: 200_000 }] });
    s.expenses.record(ctx, { categoryId: 'cat-loyer', label: 'Loyer mars', amount: 50_000, method: 'BANK_TRANSFER', reference: 'VIR-1' });
    const at = (iso: string) => {
      now = new Date(iso);
    };
    return { s, ctx, store, riz, at };
  }

  it('clôture : à-nouveaux au 1er janvier, états inchangés, écritures bloquées puis rouvertes', () => {
    const { s, ctx, store, riz, at } = year2025();
    const [fy] = s.fiscal.list(store.id);
    expect([fy!.start_date, fy!.end_date, fy!.status]).toEqual(['2025-01-01', '2025-12-31', 'open']);
    expect(() => s.fiscal.close(ctx, fy!.id)).toThrow(/après cette date/);

    at('2026-02-01T09:00:00Z');
    s.pos.completeSale(ctx, { lines: [{ articleId: riz, qty: 10_000 }], payments: [{ method: 'CASH', amount: 50_000 }] });
    const y2 = { from: '2026-01-01', to: '2026-12-31' };
    const before = s.statements.statements(store.id, y2);
    const tbBefore = s.accounting.trialBalance(store.id, y2);

    const closed = s.fiscal.close(ctx, fy!.id);
    expect([closed.status, closed.result]).toEqual(['closed', -2_285]);
    expect(s.fiscal.list(store.id).map((f) => [f.start_date, f.status])).toEqual([
      ['2026-01-01', 'open'],
      ['2025-01-01', 'closed'],
    ]);
    const an = s.accounting.entries(store.id, { from: '2026-01-01', to: '2026-01-01', journal: 'AN' });
    expect(an).toHaveLength(1);
    expect(an[0]!.closing).toBe(true);
    expect(an[0]!.lines.find((l) => l.account === '129')).toMatchObject({ debit: 2_285, credit: 0 });
    expect(an[0]!.lines.find((l) => l.account === '311')).toMatchObject({ debit: 180_000 });
    expect(s.fiscal.stale(store.id, fy!.id)).toBe(false);

    // Les états de 2026 ne changent pas ; la balance 2026 n'a plus que des comptes de bilan à l'ouverture.
    const after = s.statements.statements(store.id, y2);
    expect(after.liabilities.map((l) => [l.ref, l.net])).toEqual(before.liabilities.map((l) => [l.ref, l.net]));
    expect(after.assets.map((l) => [l.ref, l.net])).toEqual(before.assets.map((l) => [l.ref, l.net]));
    expect(after.result).toBe(before.result);
    const tb = s.accounting.trialBalance(store.id, y2);
    expect(tb.rows.filter((r) => r.account[0]! >= '6' && r.opening)).toEqual([]);
    expect(tb.totals.closing).toBe(0);
    expect(tb.rows.find((r) => r.account === '571')!.closing).toBe(tbBefore.rows.find((r) => r.account === '571')!.closing);
    // L'exercice clôturé se consulte toujours tel quel.
    expect(s.statements.statements(store.id, { from: '2025-01-01', to: '2025-12-31' }).result).toBe(-2_285);

    // Plus d'écriture datée en 2025.
    const lines = [
      { account: '6222', debit: 1_000, credit: 0 },
      { account: '521', debit: 0, credit: 1_000 },
    ];
    expect(() => s.accounting.addManualEntry(ctx, { journal: 'OD', date: '2025-06-01', label: 'Oubli', lines })).toThrow(/clôturé/);
    expect(() => s.expenses.record(ctx, { categoryId: 'cat-loyer', label: 'Loyer', amount: 1_000, method: 'BANK_TRANSFER', reference: 'V2', date: '2025-12-01' })).toThrow(/clôturé/);

    // Rouvert : les à-nouveaux disparaissent et la saisie redevient possible.
    s.fiscal.reopen(ctx, fy!.id);
    expect(s.accounting.entries(store.id, { from: '2026-01-01', to: '2026-01-01', journal: 'AN' })).toEqual([]);
    expect(s.accounting.addManualEntry(ctx, { journal: 'OD', date: '2025-06-01', label: 'Oubli', lines }).date).toBe('2025-06-01');
    expect(s.statements.statements(store.id, y2).result).toBe(before.result);
  });

  it('ouvre, allonge et supprime un exercice sans chevauchement', () => {
    const { s, ctx, store } = year2025();
    s.fiscal.list(store.id);
    const next = s.fiscal.openNext(ctx);
    expect([next.start_date, next.end_date]).toEqual(['2026-01-01', '2026-12-31']);
    expect(() => s.fiscal.open(ctx, { start: '2026-06-01', end: '2027-05-31' })).toThrow(/chevauchent/);
    expect(s.fiscal.setDates(ctx, next.id, { start: '2026-01-01', end: '2027-06-30' }).end_date).toBe('2027-06-30');
    expect(() => s.fiscal.setDates(ctx, next.id, { start: '2026-01-01', end: '2027-12-31' })).toThrow(/18 mois/);
    s.fiscal.remove(ctx, next.id);
    expect(s.fiscal.list(store.id)).toHaveLength(1);
  });
});

describe('écritures : modifier, supprimer, corriger', () => {
  it('modifie et supprime une écriture saisie, corrige une écriture automatique par une OD liée', () => {
    const { s, ctx, store } = setup();
    const lines = [
      { account: '6222', debit: 100_000, credit: 0 },
      { account: '521', debit: 0, credit: 100_000 },
    ];
    const e = s.accounting.addManualEntry(ctx, { journal: 'OD', date: '2026-10-01', label: 'Loyer', lines });
    const edited = s.accounting.updateManualEntry(ctx, e.id!, { journal: 'BQ', date: '2026-10-02', label: 'Loyer octobre', lines: lines.map((l) => ({ ...l, debit: l.debit ? 120_000 : 0, credit: l.credit ? 120_000 : 0 })) });
    expect([edited.ref, edited.journal, edited.date, edited.lines[0]!.debit]).toEqual([e.ref, 'BQ', '2026-10-02', 120_000]);
    expect(() => s.accounting.updateManualEntry(ctx, e.id!, { journal: 'OD', date: '2026-10-02', label: 'x', lines: [lines[0]!, { ...lines[1]!, credit: 1 }] })).toThrow(/déséquilibrée/);
    s.accounting.deleteManualEntry(ctx, e.id!);
    expect(s.accounting.entries(store.id, { from: '2026-10-01', to: '2026-10-31' })).toEqual([]);
    expect(s.db.prepare("SELECT action FROM audit_log WHERE entity_id = ? ORDER BY rowid").pluck().all(e.id)).toEqual(['accounting.manual_entry', 'accounting.manual_entry_update', 'accounting.manual_entry_delete']);

    // Dépense automatique sur 6222 : on la remet sur 6228 sans toucher à la pièce.
    s.expenses.record(ctx, { categoryId: 'cat-loyer', label: 'Loyer', amount: 50_000, method: 'BANK_TRANSFER', reference: 'VIR-9' });
    const auto = s.accounting.entries(store.id, { from: '2026-10-13', to: '2026-10-13' }).find((x) => x.source === 'auto')!;
    const key = `${auto.journal}|${auto.date}|${auto.ref}`;
    const wanted = auto.lines.map((l) => (l.account === '6222' ? { ...l, account: '6228' } : l));
    expect(() => s.accounting.correctEntry(ctx, key, { lines: auto.lines })).toThrow(/Aucun changement/);
    const fix = s.accounting.correctEntry(ctx, key, { lines: wanted });
    expect([fix.journal, fix.corrects]).toEqual(['OD', key]);
    expect(fix.lines.map((l) => [l.account, l.debit, l.credit]).sort()).toEqual([
      ['6222', 0, 50_000],
      ['6228', 50_000, 0],
    ]);
    const tb = s.accounting.trialBalance(store.id, { from: '2026-10-01', to: '2026-10-31' });
    expect(tb.rows.find((r) => r.account === '6222')?.closing ?? 0).toBe(0);
    expect(tb.rows.find((r) => r.account === '6228')!.closing).toBe(50_000);
    expect(s.accounting.entries(store.id, { from: '2026-10-13', to: '2026-10-13' }).find((x) => x.source === 'auto')!.corrected_by).toEqual([fix.ref]);
  });

  it('le plan comptable SYSCOHADA est complet', () => {
    const { s } = setup();
    const ids = new Set(s.accounting.listAccounts().map((a) => a.id));
    for (const id of ['6011', '6056', '6241', '6324', '6611', '6634', '4011', '5211', '7071', '891']) expect(ids.has(id)).toBe(true);
    // Les comptes déjà présents gardent leur libellé.
    expect(s.accounting.listAccounts().find((a) => a.id === '6052')!.label).toBe('Eau et électricité');
  });
});

describe('caisse : stock par dépôt et complément', () => {
  it("complète la ligne dans l'autre dépôt du vendeur et montre le stock de chacun", () => {
    const { s, ctx, store, shop, reserve, castel, qty } = setup();
    s.stock.receive(ctx, { warehouseId: shop.id, lines: [{ articleId: castel.id, qty: 2_000, unitCost: 400 }] });
    s.stock.receive(ctx, { warehouseId: reserve.id, lines: [{ articleId: castel.id, qty: 10_000, unitCost: 500 }] });
    s.pos.openSession(ctx, 0);
    const cashier = s.admin.createUser(ctx.userId, { name: 'Awa', login: 'awa', pin: '5678', role: 'cashier', storeId: store.id, registerId: ctx.registerId });
    const awa = { ...ctx, userId: cashier.id };
    // Par défaut, la caissière ne vend que sur la surface de vente.
    expect(s.admin.saleWarehousesFor(store.id, cashier.id).map((w) => w.id)).toEqual([shop.id]);
    expect(() => s.pos.completeSale(awa, { lines: [{ articleId: castel.id, qty: 5_000 }], payments: [{ method: 'CASH', amount: 3_250 }] })).toThrow(/Stock insuffisant/);

    s.admin.updateUser(ctx.userId, cashier.id, { saleWarehouses: [reserve.id] });
    const row = s.pos.searchForSale(store.id, 'castel', { userId: cashier.id })[0]!;
    expect([row.stock, row.available, row.stocks.map((w) => [w.name, w.qty])]).toEqual([2_000, 12_000, [[shop.name, 2_000], ['Réserve', 10_000]]]);

    const sale = s.pos.completeSale(awa, { lines: [{ articleId: castel.id, qty: 5_000 }], payments: [{ method: 'CASH', amount: 3_250 }] });
    expect([qty(shop.id), qty(reserve.id)]).toEqual([0, 7_000]);
    // Coût moyen pondéré : 2 à 400 et 3 à 500.
    expect(s.db.prepare('SELECT unit_cost FROM sale_lines WHERE sale_id = ?').pluck().get(sale.id)).toBe(460);
    expect(s.db.prepare("SELECT COUNT(*) FROM audit_log WHERE action = 'sale.complement' AND entity_id = ?").pluck().get(sale.id)).toBe(1);
    // Annulée : chaque bouteille retourne dans son dépôt.
    s.pos.cancelSale(ctx, sale.id, ctx.userId, 'erreur');
    expect([qty(shop.id), qty(reserve.id)]).toEqual([2_000, 10_000]);
    // Au-delà du total des deux dépôts : refusé.
    expect(() => s.pos.completeSale(awa, { lines: [{ articleId: castel.id, qty: 13_000 }], payments: [{ method: 'CASH', amount: 8_450 }] })).toThrow(/CASTEL 65CL : il reste 12 /);
  });
});
