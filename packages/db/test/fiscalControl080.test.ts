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
  const b = s.pos.completeSale(ctx, { lines: [{ articleId: riz, qty: 2_000 }], payments: [{ method: 'CASH', amount: 10_000 }] });
  const c = s.pos.completeSale(ctx, { lines: [{ articleId: riz, qty: 1_000 }], payments: [{ method: 'CASH', amount: 5_000 }] });
  s.pos.cancelSale(ctx, c.id, admin.id, 'Erreur de saisie');
  const ret = s.pos.returnSale(ctx, { originalSaleId: b.id, lines: [{ lineId: b.lines[0]!.id, qty: 1_000 }], refundMethod: 'CASH', supervisorId: admin.id, reason: 'Sac percé' });
  return { s, ctx, store, a, b, c, ret, clock };
}

const salesFingerprint = (s: ReturnType<typeof setup>['s']) =>
  createHash('sha256')
    .update(JSON.stringify(['sales', 'sale_lines', 'sale_payments', 'customer_payments', 'manual_entries'].map((t) => s.db.prepare(`SELECT * FROM ${t} ORDER BY id`).all())))
    .digest('hex');

describe('vue de gestion et vue fiscale', () => {
  it('totalisent le même chiffre d’affaires que le journal des ventes', () => {
    const { s, store } = setup();
    const st = s.fiscalPrep.statement(store.id, '2026-10-01', '2026-10-31');
    const management = s.reports.sales(store.id, { from: '2026-10-01', to: '2026-10-31', dimension: 'cashier' }).totals.revenueTtc;
    expect(st.concordance).toEqual({ journalTtc: 26_500, managementTtc: 26_500, fiscalTtc: 26_500, ok: true });
    expect(management).toBe(st.totals.ttc);
  });
});

describe('rapprochement avec les déclarations déposées', () => {
  it('montre l’écart sans jamais toucher au réel ; un écart se justifie par une vraie pièce et se régularise par une rectificative', () => {
    const { s, ctx, store, a, c, ret } = setup();
    const before = salesFingerprint(s);
    const real = s.fiscalPrep.statement(store.id, '2026-10-01', '2026-10-31').totals;

    // Mois pas encore commencé, déclaration en double, rectificative sans initiale : refusés.
    expect(() => s.fiscalPrep.recordDeclaration(ctx, { period: '2026-11', kind: 'initial', turnoverHt: 0, vat: 0, reference: 'TD-1', filedOn: '2026-10-05' })).toThrow(/pas commencé/);
    expect(() => s.fiscalPrep.recordDeclaration(ctx, { period: '2026-10', kind: 'rectificative', turnoverHt: 0, vat: 0, reference: 'TD-1', filedOn: '2026-10-05' })).toThrow(/suit une déclaration initiale/);

    const d1 = s.fiscalPrep.recordDeclaration(ctx, { period: '2026-10', kind: 'initial', turnoverHt: real.ht - 1_000, vat: real.tva, reference: 'TD-2026-10-001', filedOn: '2026-10-05' });
    expect(() => s.fiscalPrep.recordDeclaration(ctx, { period: '2026-10', kind: 'initial', turnoverHt: 0, vat: 0, reference: 'TD-2', filedOn: '2026-10-05' })).toThrow(/rectificative/);

    let m = s.fiscalPrep.reconciliation(store.id, '2026-10-01', '2026-10-31')[0]!;
    expect(m).toMatchObject({ period: '2026-10', real: { ht: real.ht, tva: real.tva }, gapHt: -1_000, gapTva: 0, status: 'under' });
    // L'état fiscal reste celui des ventes.
    expect(s.fiscalPrep.statement(store.id, '2026-10-01', '2026-10-31').totals).toEqual(real);

    // Justifications : uniquement avec une pièce qui existe et du bon type.
    expect(() => s.fiscalPrep.justify(ctx, { declarationId: d1.id, kind: 'credit_note', refId: a.id, explanation: 'Avoir oublié dans la déclaration' })).toThrow(/Avoir introuvable/);
    expect(() => s.fiscalPrep.justify(ctx, { declarationId: d1.id, kind: 'cancellation', refId: a.id, explanation: 'Ticket annulé après la déclaration' })).toThrow(/annulé introuvable/);
    expect(() => s.fiscalPrep.justify(ctx, { declarationId: d1.id, kind: 'entry', refId: 'x', explanation: 'Écriture de régularisation' })).toThrow(/Écriture introuvable/);
    expect(() => s.fiscalPrep.justify(ctx, { declarationId: d1.id, kind: 'other', explanation: 'trop court' })).toThrow(/15 caractères/);
    const j1 = s.fiscalPrep.justify(ctx, { declarationId: d1.id, kind: 'credit_note', refId: ret.id, explanation: 'Avoir saisi en double sur le formulaire' });
    expect(j1.ref_label).toBe(`Avoir ${ret.number}`);
    s.fiscalPrep.justify(ctx, { declarationId: d1.id, kind: 'cancellation', refId: c.id, explanation: 'Ticket annulé déduit à tort du chiffre déclaré' });

    // La justification documente, elle ne referme pas l'écart.
    m = s.fiscalPrep.reconciliation(store.id, '2026-10-01', '2026-10-31')[0]!;
    expect(m.status).toBe('under');
    expect(m.justifications).toHaveLength(2);

    // La rectificative régularise : le dernier déclaré égale le réel.
    const d2 = s.fiscalPrep.recordDeclaration(ctx, { period: '2026-10', kind: 'rectificative', turnoverHt: real.ht, vat: real.tva, reference: 'TD-2026-10-002', filedOn: '2026-10-05' });
    s.fiscalPrep.justify(ctx, { declarationId: d1.id, kind: 'rectificative', refId: d2.id, explanation: 'Déclaration rectificative déposée le même jour' });
    m = s.fiscalPrep.reconciliation(store.id, '2026-10-01', '2026-10-31')[0]!;
    expect(m).toMatchObject({ status: 'concordant', gapHt: 0, gapTva: 0 });
    expect(m.declarations.map((d) => d.id)).toEqual([d1.id, d2.id]);

    // Rien n'a changé dans les ventes ni la comptabilité.
    expect(salesFingerprint(s)).toBe(before);

    // Déclarations et justifications ne se modifient ni ne se suppriment, et sont au journal chaîné.
    expect(() => s.db.prepare('UPDATE fiscal_declarations SET turnover_ht = 0').run()).toThrow(/ne se modifie pas/);
    expect(() => s.db.prepare('DELETE FROM fiscal_justifications').run()).toThrow(/ne se supprime pas/);
    expect(s.fiscalPrep.journal(store.id).map((l) => l.action)).toEqual(['justify', 'record', 'justify', 'justify', 'record']);
    expect(s.fiscalPrep.verify(store.id)).toMatchObject({ ok: true, checked: 5 });
    s.db.exec('DROP TRIGGER fiscal_declarations_no_update');
    s.db.prepare('UPDATE fiscal_declarations SET turnover_ht = turnover_ht + 1 WHERE id = ?').run(d1.id);
    expect(s.fiscalPrep.verify(store.id).problems).toEqual(['Déclaration 2026-10 (TD-2026-10-001) modifiée ou absente du journal']);
  });
});

describe('dossier de contrôle', () => {
  it('rassemble le registre complet, les avoirs, la TVA, les contrôles et le rapprochement, avec les identifiants de vente', () => {
    const { s, ctx, store, a, c, ret } = setup();
    s.fiscalPrep.recordDeclaration(ctx, { period: '2026-10', kind: 'initial', turnoverHt: 1, vat: 0, reference: 'TD-9', filedOn: '2026-10-05' });
    const f = s.fiscalPrep.controlFile(store.id, '2026-10-01', '2026-10-31');
    expect(f.register.map((r) => r.id)).toContain(c.id);
    expect(f.register).toHaveLength(4);
    expect(f.register.reduce((t, r) => t + (r.status === 'completed' ? r.ttc : 0), 0)).toBe(f.statement.totals.ttc);
    expect(f.vat).toEqual([expect.objectContaining({ month: '2026-10', collected: f.statement.totals.tva })]);
    expect(f.reconciliation[0]!.status).toBe('under');
    const csv = s.fiscalPrep.exportControlCsv(f);
    for (const h of ['1. Registre des ventes', '2. Avoirs clients', '4. TVA du mois', '6. Concordance des vues', '7. Rapprochement']) expect(csv).toContain(h);
    expect(csv.indexOf('1. Registre')).toBeLessThan(csv.indexOf('7. Rapprochement'));
    expect(csv).toContain(a.id);
    expect(csv).toContain(ret.id);
  });
});

describe('simulateur des régimes', () => {
  it('calcule sur les ventes réelles de l’année et le barème daté, sans montant saisi', () => {
    const { s, store } = setup();
    const sim = s.fiscalPrep.simulate(store.id, 2026);
    const real = s.fiscalPrep.statement(store.id, '2026-01-01', '2026-10-05').totals.ht;
    expect(sim.turnoverHt).toBe(real);
    expect(sim.provisional).toBe(true);
    expect(sim.ruleset.validFrom).toBe('2020-01-01');
    expect(sim.regimes.map((r) => [r.code, r.status])).toEqual([
      ['liberatoire', 'applicable'],
      ['simplifie', 'option'],
      ['reel', 'option'],
    ]);
    const reel = sim.regimes.find((r) => r.code === 'reel')!;
    const principal = Math.round((real * 200) / 10_000);
    expect(reel.minimum).toEqual({ rate: 200, principal, cac: Math.round(principal / 10), total: principal + Math.round(principal / 10) });
    expect(reel.due).toBe(Math.max(sim.resultTax.total, reel.minimum!.total));
    expect(sim.regimes[0]!.due).toBeNull();
    // Le simulateur ne prend que l'année : aucun chiffre d'affaires ne se saisit.
    expect(s.fiscalPrep.simulate.length).toBe(2);
  });
});
