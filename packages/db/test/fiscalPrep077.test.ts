import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createServices, openDatabase } from '../src';

function setup() {
  const clock = { now: new Date('2026-10-05T09:00:00Z') };
  const s = createServices(openDatabase(':memory:'), () => clock.now);
  const { store, register, admin } = s.admin.bootstrap({ storeCode: 'DLA1', storeName: 'Superette Akwa', adminName: 'Steve', adminLogin: 'steve', adminPin: '1234' });
  const ctx = { storeId: store.id, registerId: register.id, userId: admin.id };
  const rates = s.admin.listVatRates();
  const tva = rates.find((r) => r.rate_bp === 1925)!.id;
  const exo = rates.find((r) => r.rate_bp === 0)!.id;
  const riz = s.catalogue.saveArticle(admin.id, { name: 'Riz 5 kg', unit: 'piece', vatRateId: tva, purchasePrice: 3_000, salePrice: 5_000 }).id;
  const pain = s.catalogue.saveArticle(admin.id, { name: 'Pain', unit: 'piece', vatRateId: exo, purchasePrice: 100, salePrice: 150 }).id;
  const shop = s.admin.salesWarehouse(store.id).id;
  s.stock.receive(ctx, { warehouseId: shop, lines: [{ articleId: riz, qty: 100_000, unitCost: 3_000 }, { articleId: pain, qty: 100_000, unitCost: 100 }] });
  s.pos.openSession(ctx, 0);
  const a = s.pos.completeSale(ctx, { lines: [{ articleId: riz, qty: 4_000 }, { articleId: pain, qty: 10_000 }], payments: [{ method: 'CASH', amount: 21_500 }] });
  const b = s.pos.completeSale(ctx, { lines: [{ articleId: riz, qty: 2_000 }], payments: [{ method: 'MTN_MOMO', amount: 10_000, reference: 'MP123' }] });
  const c = s.pos.completeSale(ctx, { lines: [{ articleId: riz, qty: 1_000 }], payments: [{ method: 'CASH', amount: 5_000 }] });
  s.pos.cancelSale(ctx, c.id, admin.id, 'Erreur de saisie');
  s.pos.returnSale(ctx, { originalSaleId: b.id, lines: [{ lineId: b.lines[0]!.id, qty: 1_000 }], refundMethod: 'CASH', supervisorId: admin.id, reason: 'Sac percé' });
  return { s, ctx, store, a, b, c, clock };
}

/** Empreinte des tables des ventes réelles : la préparation fiscale ne doit jamais les changer. */
const salesFingerprint = (s: ReturnType<typeof setup>['s']) =>
  createHash('sha256')
    .update(JSON.stringify(['sales', 'sale_lines', 'sale_payments', 'customer_payments'].map((t) => s.db.prepare(`SELECT * FROM ${t} ORDER BY id`).all())))
    .digest('hex');

describe('ventes réelles', () => {
  it('montre toutes les opérations, annulations et remboursements compris, avec leurs paiements', () => {
    const { s, store, b, c } = setup();
    const p = { from: '2026-10-01', to: '2026-10-31' };
    const ops = s.realSales.operations(store.id, p);
    expect(ops).toHaveLength(4);
    expect(s.realSales.operations(store.id, { ...p, filter: 'cancelled' }).map((r) => r.id)).toEqual([c.id]);
    const ret = s.realSales.operations(store.id, { ...p, filter: 'returns' })[0]!;
    expect(ret).toMatchObject({ kind: 'return', original_sale_id: b.id, original_number: b.number, total_ttc: -5_000, cancel_reason: 'Sac percé' });
    expect(s.realSales.operations(store.id, { ...p, q: b.number }).map((r) => r.id)).toEqual([b.id]);
    expect(ops.find((r) => r.id === b.id)!.payments).toBe('MTN Mobile Money 10 000');

    const sum = s.realSales.summary(store.id, p);
    expect(sum.sales).toMatchObject({ count: 2, ttc: 31_500 });
    expect(sum.returns).toMatchObject({ count: 1, ttc: -5_000 });
    expect(sum.cancelled).toEqual({ count: 1, ttc: 5_000 });
    expect(sum.net.ttc).toBe(26_500);

    const d = s.realSales.detail(b.id);
    expect(d.returns).toHaveLength(1);
    expect(d.paymentLines).toEqual([{ method: 'MTN_MOMO', label: 'MTN Mobile Money', amount: 10_000, reference: 'MP123' }]);
    expect(s.realSales.payments(store.id, p).filter((x) => x.source === 'sale')).toHaveLength(4);

    const csv = s.realSales.exportCsv(store.id, p, 'operations');
    expect(csv).toContain('Identifiant vente');
    expect(csv).toContain(b.id);
    expect(csv).toContain('Annulation');
    expect(s.realSales.exportCsv(store.id, p, 'lines').split('\r\n')).toHaveLength(1 + 5);
  });
});

describe('préparation fiscale', () => {
  it('lit l’état dans les ventes réelles : avoirs clients compris, annulations exclues, comme la comptabilité', () => {
    const { s, store, b, c } = setup();
    const st = s.fiscalPrep.statement(store.id, '2026-10-01', '2026-10-31');
    expect(st.totals.ttc).toBe(26_500);
    expect(st.totals.ht).toBe(s.accounting.vatReturn(store.id, '2026-10').turnoverHt);
    expect(st.totals.tva).toBe(s.accounting.vatReturn(store.id, '2026-10').collected);
    expect(st.categories.map((x) => [x.rate, x.ttc])).toEqual([
      [1925, 25_000],
      [0, 1_500],
    ]);
    expect(st.counts).toEqual({ sales: 2, creditNotes: 1, cancelled: 1, cancelledTtc: 5_000 });
    expect(st.gross.ttc).toBe(31_500);
    // L'avoir est le retour fait à la caisse, avec sa facture d'origine.
    expect(st.creditNotes).toEqual([expect.objectContaining({ original_sale_id: b.id, original_number: b.number, ttc: -5_000, reason: 'Sac percé' })]);
    expect(st.creditNotes.map((x) => x.sale_id)).not.toContain(c.id);
    // Les comptes disent la même chose.
    expect(st.books).toMatchObject({ salesHt: st.totals.ht, vatCollected: st.totals.tva, differenceHt: 0, differenceTva: 0, matches: true });
    expect(st.sourceCheck.ok).toBe(true);
  });

  it('n’enregistre aucune opération : rien d’autre que les ventes et la comptabilité ne change le chiffre', () => {
    const { s, ctx, store } = setup();
    const before = salesFingerprint(s);
    const svc = s.fiscalPrep as unknown as Record<string, unknown>;
    for (const m of ['propose', 'decide', 'adjust', 'saleSituation']) expect(svc[m]).toBeUndefined();
    s.fiscalPrep.generate(ctx, '2026-10-01', '2026-10-31');
    expect(salesFingerprint(s)).toBe(before);
    expect(s.db.prepare("SELECT name FROM sqlite_master WHERE name = 'fiscal_adjustments'").get()).toBeUndefined();

    // Une écriture manuelle sur le compte de ventes ne change pas l'état : elle apparaît comme un écart à vérifier.
    s.accounting.addManualEntry(ctx, { journal: 'OD', date: '2026-10-10', label: 'Régularisation', lines: [{ account: '701', debit: 1_000, credit: 0 }, { account: '571', debit: 0, credit: 1_000 }] });
    const st = s.fiscalPrep.statement(store.id, '2026-10-01', '2026-10-31');
    expect(st.totals.ttc).toBe(26_500);
    expect(st.books).toMatchObject({ differenceHt: -1_000, matches: false });
  });

  it('les états générés et le journal ne se modifient ni ne se suppriment, et le journal se vérifie', () => {
    const { s, ctx, store, b } = setup();
    const gen = s.fiscalPrep.generate(ctx, '2026-10-01', '2026-10-31');
    expect(gen.number).toBe('EF-DLA11-00001');
    const got = s.fiscalPrep.getStatement(gen.id);
    expect(got.intact).toBe(true);
    expect(got.statement.totals.ttc).toBe(26_500);

    expect(() => s.db.prepare('UPDATE fiscal_statements SET turnover_ht = 0').run()).toThrow(/ne se modifie pas/);
    expect(() => s.db.prepare('DELETE FROM fiscal_statements').run()).toThrow(/ne se supprime pas/);
    expect(() => s.db.prepare('DELETE FROM fiscal_log').run()).toThrow(/ne se supprime pas/);
    s.fiscalPrep.generate(ctx, '2026-10-01', '2026-10-05');
    expect(s.fiscalPrep.verify(store.id)).toMatchObject({ ok: true, checked: 2, problems: [] });
    expect(s.fiscalPrep.journal(store.id)).toHaveLength(2);
    expect(s.db.prepare("SELECT entity FROM outbox WHERE entity LIKE 'fiscal_%' ORDER BY seq").pluck().all()).toEqual(['fiscal_statement', 'fiscal_log', 'fiscal_statement', 'fiscal_log']);

    // Quelqu'un retire les protections et retouche la base : la vérification le voit.
    s.db.exec('DROP TRIGGER fiscal_statements_no_update; DROP TRIGGER fiscal_log_no_delete');
    s.db.prepare('UPDATE fiscal_statements SET payload = replace(payload, \'26500\', \'20000\') WHERE id = ?').run(gen.id);
    s.db.prepare('DELETE FROM fiscal_log WHERE entity_id = ?').run(gen.id);
    const bad = s.fiscalPrep.verify(store.id);
    expect(bad.ok).toBe(false);
    expect(bad.problems.join('\n')).toMatch(/EF-DLA11-00001 modifié/);
    expect(bad.problems.join('\n')).toMatch(/manque/);

    // L'export cite chaque avoir et sa facture d'origine par leur identifiant commun.
    const csv = s.fiscalPrep.exportCsv(s.fiscalPrep.statement(store.id, '2026-10-01', '2026-10-31'));
    expect(csv).toContain(b.id);
    expect(csv).toContain('Contrôle comptable');
  });
});
