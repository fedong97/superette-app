import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createServices, openDatabase } from '../src';

function setup() {
  const clock = { now: new Date('2026-10-05T09:00:00Z') };
  const s = createServices(openDatabase(':memory:'), () => clock.now);
  const { store, register, admin } = s.admin.bootstrap({ storeCode: 'DLA1', storeName: 'Superette Akwa', adminName: 'Steve', adminLogin: 'steve', adminPin: '1234' });
  const mireille = s.admin.createUser(admin.id, { name: 'Mireille', login: 'mireille', pin: '2222', role: 'manager', storeId: store.id });
  const ctx = { storeId: store.id, registerId: register.id, userId: admin.id };
  const ctxM = { ...ctx, userId: mireille.id };
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
  return { s, ctx, ctxM, store, a, b, c, clock };
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
  it('sans ajustement, l’état déclaré est exactement le chiffre réel, celui de la déclaration de TVA', () => {
    const { s, store } = setup();
    const st = s.fiscalPrep.statement(store.id, '2026-10-01', '2026-10-31');
    expect(st.real.ttc).toBe(26_500);
    expect(st.declared).toEqual({ ttc: st.real.ttc, ht: st.real.ht, tva: st.real.tva });
    expect(st.real.ht).toBe(s.accounting.vatReturn(store.id, '2026-10').turnoverHt);
    expect(st.real.tva).toBe(s.accounting.vatReturn(store.id, '2026-10').collected);
    expect(st.real).toMatchObject({ sales: 2, returns: 1, cancelled: 1, cancelledTtc: 5_000 });
    expect(st.categories.map((c) => [c.rate, c.real.ttc])).toEqual([
      [1925, 25_000],
      [0, 1_500],
    ]);
    expect(st.reconciliation).toMatchObject({ unexplained: 0, balanced: true });
    expect(st.sourceCheck.ok).toBe(true);
  });

  it('un avoir justifié et approuvé par un autre utilisateur est le seul écart avec les ventes réelles', () => {
    const { s, ctx, ctxM, store, a, b, c } = setup();
    const before = salesFingerprint(s);
    const p = ['2026-10-01', '2026-10-31'] as const;
    const real = s.fiscalPrep.statement(store.id, ...p).real;

    // Pas plus que ce qui reste de la vente (b : 10 000 vendus, 5 000 remboursés).
    expect(s.fiscalPrep.saleSituation(store.id, { saleNumber: b.number }).categories[0]).toMatchObject({ sold: 10_000, returned: 5_000, remaining: 5_000 });
    const base = { saleId: b.id, kind: 'credit_note' as const, vatRateBp: 1925, reason: 'Geste commercial après réclamation', reference: 'RECL-2026-014' };
    expect(() => s.fiscalPrep.propose(ctx, { ...base, amountTtc: 5_001 })).toThrow(/dépasse/);
    // Pas sur une vente annulée, pas sur un retour, pas sans motif ni pièce.
    expect(() => s.fiscalPrep.propose(ctx, { ...base, saleId: c.id, amountTtc: 100 })).toThrow(/annulée/);
    const ret = s.realSales.operations(store.id, { from: p[0], to: p[1], filter: 'returns' })[0]!;
    expect(() => s.fiscalPrep.propose(ctx, { ...base, saleId: ret.id, amountTtc: 100 })).toThrow(/retour/);
    expect(() => s.fiscalPrep.propose(ctx, { ...base, reason: 'court', amountTtc: 100 })).toThrow(/motif/);
    expect(() => s.fiscalPrep.propose(ctx, { ...base, reference: ' ', amountTtc: 100 })).toThrow(/pièce/);
    expect(() => s.fiscalPrep.propose(ctx, { ...base, saleId: 'inconnue', amountTtc: 100 })).toThrow(/introuvable/);

    const avoir = s.fiscalPrep.propose(ctx, { ...base, amountTtc: 1_925 });
    expect(avoir).toMatchObject({ status: 'pending', sale_id: b.id, sale_number: b.number });
    expect(avoir.number).toMatch(/^AJF-DLA11-00001$/);
    // En attente : rien ne change, et il compte déjà dans ce qui reste de la vente.
    expect(s.fiscalPrep.statement(store.id, ...p).declared.ttc).toBe(real.ttc);
    expect(s.fiscalPrep.statement(store.id, ...p).pending).toHaveLength(1);
    expect(() => s.fiscalPrep.propose(ctx, { ...base, amountTtc: 3_100 })).toThrow(/dépasse/);

    // L'auteur n'approuve pas lui-même ; un autre utilisateur, oui.
    expect(() => s.fiscalPrep.decide(ctx, avoir.id, 'approve')).toThrow(/autre utilisateur/);
    const ok = s.fiscalPrep.decide(ctxM, avoir.id, 'approve');
    expect(ok).toMatchObject({ status: 'approved', decided_by_name: 'Mireille' });
    expect(() => s.fiscalPrep.decide(ctxM, avoir.id, 'reject', 'non')).toThrow(/déjà/);

    const st = s.fiscalPrep.statement(store.id, ...p);
    expect(st.adjustments).toEqual({ ttc: -1_925, ht: -1_614, tva: -311 });
    expect(st.declared).toEqual({ ttc: real.ttc - 1_925, ht: real.ht - 1_614, tva: real.tva - 311 });
    expect(st.reconciliation).toEqual({ realHt: real.ht, adjustmentsHt: -1_614, declaredHt: real.ht - 1_614, unexplained: 0, balanced: true });
    expect(st.applied.map((x) => x.number)).toEqual([avoir.number]);
    // Le chiffre réel ne bouge pas : la source n'a pas été touchée.
    expect(st.real).toEqual(s.fiscalPrep.statement(store.id, ...p).real);
    expect(s.realSales.summary(store.id, { from: p[0], to: p[1] }).net.ttc).toBe(26_500);

    // Reclassement : 5 000 FCFA de la vente a, saisis avec la TVA, relèvent d'un article exonéré.
    const rc = s.fiscalPrep.propose(ctx, { saleId: a.id, kind: 'reclass', vatRateBp: 1925, toVatRateBp: 0, amountTtc: 5_000, reason: 'Article exonéré saisi avec la TVA', reference: 'Fiche article corrigée le 05/10' });
    s.fiscalPrep.decide(ctxM, rc.id, 'approve');
    const st2 = s.fiscalPrep.statement(store.id, ...p);
    expect(st2.declared.ttc).toBe(real.ttc - 1_925);
    expect(st2.categories.find((x) => x.rate === 0)!.adjustments.ttc).toBe(5_000);
    expect(st2.reconciliation.balanced).toBe(true);

    // Refus motivé ; retrait par l'auteur seulement.
    const cor = s.fiscalPrep.propose(ctx, { saleId: a.id, kind: 'correction', vatRateBp: 0, amountTtc: -500, reason: 'Prix du pain mal saisi', reference: 'Note interne 12' });
    expect(() => s.fiscalPrep.decide(ctxM, cor.id, 'reject')).toThrow(/motif/);
    expect(s.fiscalPrep.decide(ctxM, cor.id, 'reject', 'Pièce insuffisante').status).toBe('rejected');
    const cor2 = s.fiscalPrep.propose(ctx, { saleId: a.id, kind: 'correction', vatRateBp: 0, amountTtc: 300, reason: 'Livraison facturée en plus', reference: 'BL-77' });
    expect(() => s.fiscalPrep.decide(ctxM, cor2.id, 'withdraw')).toThrow(/auteur/);
    expect(s.fiscalPrep.decide(ctx, cor2.id, 'withdraw').status).toBe('withdrawn');

    expect(salesFingerprint(s)).toBe(before);
  });

  it('ajustements, états et journal ne se modifient ni ne se suppriment, et le journal se vérifie', () => {
    const { s, ctx, ctxM, store, b } = setup();
    const avoir = s.fiscalPrep.propose(ctx, { saleId: b.id, kind: 'credit_note', vatRateBp: 1925, amountTtc: 1_000, reason: 'Geste commercial client fidèle', reference: 'AV-CLIENT-3' });
    s.fiscalPrep.decide(ctxM, avoir.id, 'approve');
    const gen = s.fiscalPrep.generate(ctx, '2026-10-01', '2026-10-31');
    expect(gen.number).toBe('EF-DLA11-00001');
    const got = s.fiscalPrep.getStatement(gen.id);
    expect(got.intact).toBe(true);
    expect(got.statement.applied.map((x) => x.id)).toEqual([avoir.id]);

    expect(() => s.db.prepare('UPDATE fiscal_adjustments SET amount_ttc = 1 WHERE id = ?').run(avoir.id)).toThrow(/ne se modifie pas/);
    expect(() => s.db.prepare('DELETE FROM fiscal_adjustments').run()).toThrow(/ne se supprime pas/);
    expect(() => s.db.prepare('DELETE FROM fiscal_log').run()).toThrow(/ne se supprime pas/);
    expect(() => s.db.prepare("UPDATE fiscal_statements SET declared_ht = 0").run()).toThrow(/ne se modifie pas/);

    const v = s.fiscalPrep.verify(store.id);
    expect(v).toMatchObject({ ok: true, checked: 3, problems: [] });
    expect(s.fiscalPrep.journal(store.id).map((l) => l.action)).toEqual(['generate', 'approve', 'propose']);

    // Quelqu'un retire les protections et retouche la base : le journal le voit.
    s.db.exec('DROP TRIGGER fiscal_adjustments_no_update; DROP TRIGGER fiscal_log_no_delete');
    s.db.prepare('UPDATE fiscal_adjustments SET amount_ttc = 5000 WHERE id = ?').run(avoir.id);
    s.db.prepare("DELETE FROM fiscal_log WHERE action = 'approve'").run();
    const bad = s.fiscalPrep.verify(store.id);
    expect(bad.ok).toBe(false);
    expect(bad.problems.join('\n')).toMatch(/AJF-DLA11-00001 modifié/);
    expect(bad.problems.join('\n')).toMatch(/manque/);

    // L'export de la préparation fiscale cite la vente par son identifiant commun.
    const csv = s.fiscalPrep.exportCsv(got.statement, got);
    expect(csv).toContain(b.id);
    expect(csv).toContain(gen.number);
  });

  it('un ajustement compte dans la période de son approbation et voyage vers les autres PC tel quel', () => {
    const { s, ctx, ctxM, store, b, clock } = setup();
    const avoir = s.fiscalPrep.propose(ctx, { saleId: b.id, kind: 'credit_note', vatRateBp: 1925, amountTtc: 1_000, reason: 'Geste commercial client fidèle', reference: 'AV-CLIENT-3' });
    clock.now = new Date('2026-11-03T09:00:00Z');
    s.fiscalPrep.decide(ctxM, avoir.id, 'approve');
    expect(s.fiscalPrep.statement(store.id, '2026-10-01', '2026-10-31').adjustments.ttc).toBe(0);
    expect(s.fiscalPrep.statement(store.id, '2026-11-01', '2026-11-30').adjustments.ttc).toBe(-1_000);
    expect(s.sync.serialize('fiscal_adjustment', avoir.id)).toMatchObject({ number: avoir.number, sale_id: b.id });
    const pending = s.db.prepare("SELECT entity FROM outbox WHERE entity LIKE 'fiscal_%'").pluck().all();
    expect(pending).toEqual(['fiscal_adjustment', 'fiscal_log', 'fiscal_log']);
    // Reçu une deuxième fois : ignoré, sans erreur.
    expect(s.sync.applyRemote([{ id: 'x', entity: 'fiscal_adjustment', entityId: avoir.id, op: 'upsert', storeId: store.id, registerId: null, createdAt: '', payload: s.sync.serialize('fiscal_adjustment', avoir.id) }])).toMatchObject({ conflicts: 0 });
  });
});
