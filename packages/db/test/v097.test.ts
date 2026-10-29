import { describe, expect, it } from 'vitest';
import { createServices, openDatabase } from '../src';

function setup() {
  let now = new Date('2026-10-05T09:00:00Z');
  const s = createServices(openDatabase(':memory:'), () => now);
  const { store, register, admin } = s.admin.bootstrap({ storeCode: 'DLA1', storeName: 'Superette Akwa', adminName: 'Steve', adminLogin: 'steve', adminPin: '1234' });
  const ctx = { storeId: store.id, registerId: register.id, userId: admin.id };
  const tva = s.admin.listVatRates().find((r) => r.rate_bp === 1925)!.id;
  const shop = s.admin.salesWarehouse(store.id).id;
  const coca = s.catalogue.saveArticle(admin.id, { name: 'Coca-Cola 50 cl', unit: 'piece', vatRateId: tva, purchasePrice: 300, salePrice: 500 });
  const riz = s.catalogue.saveArticle(admin.id, { name: 'Riz parfumé 5 kg', unit: 'piece', vatRateId: tva, purchasePrice: 3000, salePrice: 4200, maxDiscountPct: 5 });
  s.stock.receive(ctx, { warehouseId: shop, lines: [{ articleId: coca.id, qty: 100_000, unitCost: 300 }, { articleId: riz.id, qty: 20_000, unitCost: 3000 }] });
  s.pos.openSession(ctx, 10_000);
  const at = (iso: string) => {
    now = new Date(iso);
  };
  const awa = s.admin.createUser(admin.id, { name: 'Awa', login: 'awa', pin: '5678', role: 'cashier', storeId: store.id, registerId: register.id });
  return { s, ctx, shop, coca, riz, at, store, awa };
}

describe('0.97.0 : remises, codes promo, coupures, commerciaux', () => {
  it('motif de remise obligatoire et remise maxi par article', () => {
    const { s, ctx, coca, riz } = setup();
    expect(() =>
      s.pos.completeSale(ctx, { lines: [{ articleId: coca.id, qty: 1000, discount: 50 }], payments: [{ method: 'CASH', amount: 450 }], discountAuthorizedBy: ctx.userId }),
    ).toThrow(/motif de la remise/);
    const ok = s.pos.completeSale(ctx, {
      lines: [{ articleId: coca.id, qty: 1000, discount: 50 }],
      payments: [{ method: 'CASH', amount: 450 }],
      discountAuthorizedBy: ctx.userId,
      discountReason: 'Client fidèle',
    });
    expect(ok.discount_reason).toBe('Client fidèle');

    // Riz : 5 % au plus (210 F) ; 400 F demandent le gérant, même autorisé par un caissier.
    const cashier = { ...ctx, userId: s.admin.listUsers().find((u) => u.login === 'awa')!.id };
    expect(() =>
      s.pos.completeSale(cashier, {
        lines: [{ articleId: riz.id, qty: 1000, discount: 400 }],
        payments: [{ method: 'CASH', amount: 3800 }],
        discountAuthorizedBy: cashier.userId,
        discountReason: 'Achat en gros',
      }),
    ).toThrow(/remise maxi/);
    const big = s.pos.completeSale(ctx, {
      lines: [{ articleId: riz.id, qty: 1000, discount: 400 }],
      payments: [{ method: 'CASH', amount: 3800 }],
      discountAuthorizedBy: ctx.userId,
      discountReason: 'Achat en gros',
    });
    expect(big.total_ttc).toBe(3800);
  });

  it('code de réduction : contrôle, remise sur le ticket, une fois par client', () => {
    const { s, ctx, coca, at } = setup();
    const noel = s.promoCodes.save(ctx.userId, { code: 'noel 25', label: 'Flyer de Noël', kind: 'percent', value: 10, minTotal: 1000, endsOn: '2026-12-31', oncePerCustomer: true });
    expect(noel.code).toBe('NOEL25');
    expect(() => s.promoCodes.save(ctx.userId, { code: 'NOEL25', label: 'Doublon', kind: 'amount', value: 100 })).toThrow(/existe déjà/);
    expect(() => s.promoCodes.check(ctx.storeId, 'NOEL25', 500, null)).toThrow(/à partir de/);
    expect(() => s.promoCodes.check(ctx.storeId, 'NOEL25', 2000, null)).toThrow(/choisissez le client/);
    const client = s.customers.saveCustomer(ctx.userId, { name: 'Mme Ngo' });
    expect(s.promoCodes.check(ctx.storeId, 'noel25', 2000, client.id).amount).toBe(200);

    const sale = s.pos.completeSale(ctx, { lines: [{ articleId: coca.id, qty: 4000 }], payments: [{ method: 'CASH', amount: 1800 }], customerId: client.id, promoCode: 'NOEL25' });
    expect(sale).toMatchObject({ total_ttc: 1800, promo_code: 'NOEL25', promo_code_discount: 200 });
    expect(s.promoCodes.uses(noel.id).map((u) => u.number)).toEqual([sale.number]);
    expect(() => s.promoCodes.check(ctx.storeId, 'NOEL25', 2000, client.id)).toThrow(/déjà utilisé/);
    expect(() => s.promoCodes.save(ctx.userId, { code: 'NOEL26', label: 'Flyer de Noël', kind: 'percent', value: 10 }, noel.id)).toThrow(/déjà servi/);

    s.promoCodes.setActive(ctx.userId, noel.id, false);
    expect(() => s.promoCodes.check(ctx.storeId, 'NOEL25', 2000, null)).toThrow(/plus actif/);
    at('2027-01-02T09:00:00Z');
    s.promoCodes.setActive(ctx.userId, noel.id, true);
    expect(() => s.promoCodes.check(ctx.storeId, 'NOEL25', 2000, 'x')).toThrow(/expiré/);
  });

  it('coupure : ventes saisies à leur heure, écart, clôture avec motif', () => {
    const { s, ctx, coca, at } = setup();
    at('2026-10-05T15:00:00Z');
    const o = s.outages.declare(ctx, { startedAt: '2026-10-05T11:00:00Z', endedAt: '2026-10-05T13:00:00Z', declaredTotal: 2000, note: 'Coupure ENEO' });
    expect(o).toMatchObject({ status: 'open', gap: 2000, sales: 0 });
    expect(() => s.outages.declare(ctx, { startedAt: '2026-10-05T12:00:00Z', endedAt: '2026-10-05T14:00:00Z', declaredTotal: 500 })).toThrow();
    expect(() => s.outages.close(ctx, o.id)).toThrow();

    const sale = s.pos.completeSale(ctx, {
      lines: [{ articleId: coca.id, qty: 3000 }],
      payments: [{ method: 'CASH', amount: 1500 }],
      outage: { id: o.id, at: '2026-10-05T11:30:00Z' },
    });
    expect(sale.outage_id).toBe(o.id);
    expect(() => s.pos.completeSale(ctx, { lines: [{ articleId: coca.id, qty: 1000 }], payments: [{ method: 'CASH', amount: 500 }], outage: { id: o.id, at: '2026-10-05T14:30:00Z' } })).toThrow();
    expect(s.outages.get(o.id)).toMatchObject({ entered_total: 1500, gap: 500, sales: 1 });
    expect(() => s.outages.cancel(ctx, o.id)).toThrow();
    expect(() => s.outages.close(ctx, o.id)).toThrow(/motif|écart/i);
    const closed = s.outages.close(ctx, o.id, { reason: 'Ticket illisible', closedBy: ctx.userId });
    expect(closed).toMatchObject({ status: 'closed', entered_total: 1500, gap: 500, gap_reason: 'Ticket illisible' });
    expect(s.outages.openFor(ctx)).toBeNull();
  });

  it('commercial de terrain : la vente garde sa zone et sa ville, les rapports regroupent par zone', () => {
    const { s, ctx, coca } = setup();
    const paul = s.fieldReps.save(ctx.userId, { name: 'Paul', zone: 'bonamoussadi', city: 'Douala' });
    expect(paul).toMatchObject({ zone: 'BONAMOUSSADI', city: 'DOUALA' });
    const client = s.customers.saveCustomer(ctx.userId, { name: 'Boutique Mama', fieldRepId: paul.id });
    const a = s.pos.completeSale(ctx, { lines: [{ articleId: coca.id, qty: 2000 }], payments: [{ method: 'CASH', amount: 1000 }], customerId: client.id });
    expect(a).toMatchObject({ field_rep_id: paul.id, field_zone: 'BONAMOUSSADI', field_city: 'DOUALA' });
    s.fieldReps.save(ctx.userId, { name: 'Paul', zone: 'Akwa', city: 'Douala' }, paul.id);
    const b = s.pos.completeSale(ctx, { lines: [{ articleId: coca.id, qty: 1000 }], payments: [{ method: 'CASH', amount: 500 }], fieldRepId: paul.id });
    expect(b.field_zone).toBe('AKWA');

    const report = s.reports.sales(ctx.storeId, { from: '2026-10-05', to: '2026-10-05', dimension: 'field_zone' });
    expect(report.rows.map((r) => [r.label, r.revenueTtc])).toEqual(
      expect.arrayContaining([
        ['DOUALA › BONAMOUSSADI', 1000],
        ['DOUALA › AKWA', 500],
      ]),
    );
  });
});

describe('0.97.0 : dépenses, mois en clair, rapports, anomalies', () => {
  it('dépense à approuver au-delà du seuil, avec justificatif', () => {
    const { s, ctx, awa } = setup();
    s.admin.saveStoreSettings(ctx.userId, ctx.storeId, { expenseApprovalAbove: 10_000, expenseProofRequired: true });
    const cashier = { ...ctx, userId: awa.id };
    const small = s.expenses.record(cashier, { categoryId: 'cat-transport', label: 'Taxi', amount: 2_000, method: 'CASH' });
    expect(small.approval).toBe('approved');
    const big = s.expenses.record(cashier, { categoryId: 'cat-transport', label: 'Réparation moto', amount: 25_000, method: 'CASH' });
    expect(big.approval).toBe('pending');
    expect(s.expenses.list(ctx.storeId, { approval: 'pending' }).map((e) => e.id)).toEqual([big.id]);

    expect(() => s.expenses.approve(ctx, big.id)).toThrow(/justificatif|pièce/i);
    expect(() => s.expenses.attach(ctx, big.id, { name: 'virus.exe', mime: 'application/octet-stream', data: 'AAAA' })).toThrow(/photo/);
    s.expenses.attach(ctx, big.id, { name: 'facture.png', mime: 'image/png', data: Buffer.from('png-de-test').toString('base64') });
    expect(s.expenses.attachments(big.id)).toHaveLength(1);
    expect(s.expenses.approve(ctx, big.id, 'Vu la facture')).toMatchObject({ approval: 'approved', approval_note: 'Vu la facture', attachments: 1 });

    const other = s.expenses.record(cashier, { categoryId: 'cat-transport', label: 'Carburant', amount: 15_000, method: 'CASH' });
    expect(s.expenses.reject(ctx, other.id, 'Pas de reçu')).toMatchObject({ approval: 'rejected' });
  });

  it('mon mois en clair : ce qui reste et le verdict', () => {
    const { s, ctx, coca } = setup();
    s.pos.completeSale(ctx, { lines: [{ articleId: coca.id, qty: 50_000 }], payments: [{ method: 'CASH', amount: 25_000 }] });
    s.expenses.record(ctx, { categoryId: 'cat-transport', label: 'Taxi', amount: 1_000, method: 'CASH' });
    const m = s.insights.monthClear(ctx.storeId, '2026-10');
    expect(m.month).toBe('2026-10');
    expect(m.net).toBe(m.figures.margin - m.figures.expenses - m.losses + m.cash_gaps);
    expect(['loss', 'tight', 'good', 'very_good']).toContain(m.verdict);
    expect(m.summary).toBeTruthy();
  });

  it('rapport en colonnes et filtres enregistrés', () => {
    const { s, ctx, coca, riz, at } = setup();
    at('2026-09-10T10:00:00Z');
    s.pos.completeSale(ctx, { lines: [{ articleId: coca.id, qty: 2000 }], payments: [{ method: 'CASH', amount: 1000 }] });
    at('2026-10-05T10:00:00Z');
    s.pos.completeSale(ctx, { lines: [{ articleId: riz.id, qty: 1000 }, { articleId: coca.id, qty: 1000 }], payments: [{ method: 'CASH', amount: 4700 }] });
    const m = s.reports.periodMatrix(ctx.storeId, { dimension: 'article', step: 'month12', measure: 'ttc', end: '2026-10-31' });
    expect(m.columns).toHaveLength(12);
    expect(m.total).toBe(5700);
    const cocaRow = m.rows.find((r) => r.label === 'Coca-Cola 50 cl')!;
    expect(cocaRow.values.slice(-2)).toEqual([1000, 500]);
    expect(m.totals.reduce((a, b) => a + b, 0)).toBe(m.total);

    const mine = s.reportPresets.save(ctx.userId, { screen: 'reports', name: 'Ventes par zone', params: { dimension: 'field_zone' } });
    s.reportPresets.save(ctx.userId, { screen: 'reports', name: 'Ventes par zone', params: { dimension: 'field_city' } });
    expect(s.reportPresets.list(ctx.userId, 'reports')).toMatchObject([{ id: mine.id, params: { dimension: 'field_city' } }]);
    s.reportPresets.remove(ctx.userId, mine.id, true);
    expect(s.reportPresets.list(ctx.userId, 'reports')).toEqual([]);
  });

  it('anomalies de stock : réception en double, décision gardée', () => {
    const { s, ctx, shop, coca } = setup();
    const sabc = s.purchases.saveSupplier(ctx.userId, { name: 'SABC' });
    for (let i = 0; i < 2; i++) s.stock.receive(ctx, { supplierId: sabc.id, warehouseId: shop, lines: [{ articleId: coca.id, qty: 24_000, unitCost: 300 }] });
    const twin = s.anomalies.list(ctx.storeId).find((c) => c.kind === 'duplicate_reception')!;
    expect(twin).toBeTruthy();
    expect(twin.fix?.lines[0]).toMatchObject({ article_name: 'Coca-Cola 50 cl', after: twin.fix!.lines[0]!.before - 24_000 });
    expect(() => s.anomalies.decide(ctx, twin.key, 'ignored')).toThrow();
    s.anomalies.decide(ctx, twin.key, 'ignored', 'Deux livraisons le même jour');
    expect(s.anomalies.list(ctx.storeId).some((c) => c.key === twin.key)).toBe(false);
    expect(s.anomalies.decisions(ctx.storeId)[0]).toMatchObject({ case_key: twin.key });
  });
});
