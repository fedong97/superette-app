import { TAKEOVER_TEMPLATES, parseFrDate, parseFrNumber, parseTakeoverCustomers, parseTakeoverStock } from '@superette/core';
import { describe, expect, it } from 'vitest';
import { type Context, type Entry, OPENING_ACCOUNT, type Services, createServices, openDatabase } from '../src';

let now = new Date('2026-10-01T08:00:00Z');

function setup() {
  now = new Date('2026-10-01T08:00:00Z');
  const s = createServices(openDatabase(':memory:'), () => now);
  const { store, register, admin } = s.admin.bootstrap({ storeCode: 'DLA1', storeName: 'Superette Akwa', adminName: 'Steve', adminLogin: 'steve', adminPin: '1234' });
  const ctx: Context = { storeId: store.id, registerId: register.id, userId: admin.id };
  const tva = s.admin.listVatRates().find((r) => r.rate_bp === 1925)!.id;
  return { s, ctx, tva, shop: s.admin.salesWarehouse(store.id).id };
}

const balanced = (entries: Entry[]) => entries.every((e) => e.lines.reduce((t, l) => t + l.debit, 0) === e.lines.reduce((t, l) => t + l.credit, 0));
const csv = (text: string) => text.trim().split('\n').map((l) => l.split(';'));

describe('lecture des fichiers de reprise', () => {
  it('lit les montants et les dates écrits à la française', () => {
    expect(parseFrNumber('1 500')).toBe(1500);
    expect(parseFrNumber('1 250 000 FCFA')).toBe(1_250_000);
    expect(parseFrNumber('1.500.000')).toBe(1_500_000);
    expect(parseFrNumber('2,5')).toBe(2.5);
    expect(parseFrNumber('-3 000')).toBe(-3000);
    expect(parseFrNumber('(3 000)')).toBe(-3000);
    expect(parseFrNumber('abc')).toBeNull();
    expect(parseFrDate('28/09/2026')).toBe('2026-09-28');
    expect(parseFrDate('5-1-26')).toBe('2026-01-05');
    expect(parseFrDate('2026-09-28')).toBe('2026-09-28');
    expect(parseFrDate('46293')).toBe('2026-09-28');
    expect(parseFrDate('31/02/2026')).toBeUndefined();
    expect(parseFrDate('')).toBeNull();
  });

  it('reconnaît les en-têtes dans le désordre et signale chaque ligne illisible', () => {
    const r = parseTakeoverCustomers(
      csv(`Solde;Nom du client;Téléphone;Échéance;Tarif
85 000;Chez Mballa;677 00 00 01;28/10/2026;gros
abc;Mme Ngo;;;
1000;;;;
2000;Boutique Eto'o;;32/13/2026;
500;Kiosque Bonamoussadi;;;demi-gros`),
    );
    // « Nom du client » n'est pas un en-tête connu : la colonne « nom » manque.
    expect(r.errors[0]!.message).toMatch(/Colonne « nom » introuvable/);
    const ok = parseTakeoverCustomers(
      csv(`Solde;Nom;Téléphone;Échéance;Tarif
85 000;Chez Mballa;677 00 00 01;28/10/2026;gros
abc;Mme Ngo;;;
1000;;;;
2000;Boutique Eto'o;;32/13/2026;
500;Kiosque Bonamoussadi;;;demi-gros`),
    );
    expect(ok.rows).toEqual([
      expect.objectContaining({ line: 2, name: 'Chez Mballa', balance: 85_000, dueDate: '2026-10-28', priceLevel: 'wholesale', phone: '677 00 00 01' }),
    ]);
    expect(ok.errors.map((e) => [e.line, e.message])).toEqual([
      [3, 'Mme Ngo : solde illisible (« abc »)'],
      [4, 'Ligne sans nom : le nom du client est vide'],
      [5, "Boutique Eto'o : échéance illisible (« 32/13/2026 »), écrivez-la JJ/MM/AAAA"],
      [6, 'Kiosque Bonamoussadi : tarif inconnu (« demi-gros ») : détail, gros ou super gros'],
    ]);
    // Les modèles livrés se relisent sans erreur.
    expect(parseTakeoverCustomers(TAKEOVER_TEMPLATES.customers).errors).toEqual([]);
    expect(parseTakeoverStock(TAKEOVER_TEMPLATES.stock).errors).toEqual([]);
  });
});

describe("reprise d'un magasin existant", () => {
  it('clients : aperçu sans rien enregistrer, puis import avec les soldes dans le compte, la balance âgée et les à-nouveaux', () => {
    const { s, ctx } = setup();
    // Un client déjà saisi est complété, pas recréé.
    const existing = s.customers.saveCustomer(ctx.userId, { name: 'Chez Mballa', phone: '677000001' });
    const file = csv(`nom;telephone;plafond;delai;tarif;solde;facture;date;echeance
CHEZ MBALLA;677 00 00 01;200 000;30;gros;85 000;FA-1204;28/08/2026;27/09/2026
Mme Ngo Bassa;699 12 34 56;50 000;15;détail;0;;;
Restaurant Le Wouri;655 11 22 33;;;;-5 000;AV-12;20/09/2026;`);

    const preview = s.opening.run(ctx, 'customers', file, { preview: true });
    expect(preview).toMatchObject({ preview: true, created: 2, updated: 1, total: 80_000, errors: [] });
    expect(preview.lines.map((l) => l.action.replace(/\s/g, " "))).toEqual(['Fiche complétée, doit 85 000 FCFA', 'Fiche créée', 'Fiche créée, avoir de 5 000 FCFA']);
    // Rien n'a été enregistré.
    expect(s.customers.listCustomers(ctx.storeId)).toHaveLength(1);
    expect(s.db.prepare('SELECT COUNT(*) FROM opening_balances').pluck().get()).toBe(0);

    const done = s.opening.run(ctx, 'customers', file, { preview: false });
    expect(done).toMatchObject({ preview: false, created: 2, updated: 1, total: 80_000 });
    expect(s.customers.listCustomers(ctx.storeId)).toHaveLength(3);
    const mballa = s.customers.getCustomer(existing.id);
    expect(mballa).toMatchObject({ credit_limit: 200_000, payment_terms_days: 30, price_level: 'wholesale' });

    // Compte du client : la pièce reprise est due et en retard depuis le 27/09.
    const account = s.customers.account(ctx.storeId, existing.id);
    expect(account).toMatchObject({ balance: 85_000, available: 115_000, overdue: 85_000 });
    expect(account.openItems[0]).toMatchObject({ amount: 85_000, due_date: '2026-09-27', days_late: 4 });
    const wouri = s.customers.listCustomers(ctx.storeId).find((c) => c.name === 'Restaurant Le Wouri')!;
    expect(s.customers.account(ctx.storeId, wouri.id).balance).toBe(-5_000);
    expect(s.customers.receivables(ctx.storeId).totals).toMatchObject({ balance: 80_000, d30: 85_000 });
    expect(s.customers.statement(ctx.storeId, existing.id).lines[0]).toMatchObject({ kind: 'opening', label: 'Solde repris (pièce FA-1204)', debit: 85_000, balance: 85_000 });

    // Un règlement solde la pièce reprise comme une vente à crédit.
    s.customers.receivePayment(ctx, { customerId: existing.id, method: 'CASH', amount: 35_000 });
    expect(s.customers.account(ctx.storeId, existing.id)).toMatchObject({ balance: 50_000, overdue: 50_000 });

    // À-nouveaux contre le compte d'attente, et 411 du tiers égal au compte client.
    const an = s.accounting.entries(ctx.storeId, { journal: 'AN' });
    expect(an).toHaveLength(2);
    expect(balanced(an)).toBe(true);
    expect(an.find((e) => e.date === '2026-08-28')!.lines).toEqual([
      expect.objectContaining({ account: '411', aux: mballa.code, debit: 85_000 }),
      expect.objectContaining({ account: OPENING_ACCOUNT, credit: 85_000 }),
    ]);
    expect(s.accounting.ledger(ctx.storeId, { account: '411', aux: mballa.code }).closing).toBe(50_000);

    // Le même fichier ne reprend pas deux fois les soldes : tout est refusé, rien n'est enregistré.
    const again = s.opening.run(ctx, 'customers', file, { preview: false });
    expect(again.preview).toBe(true);
    expect(again.errors.map((e) => e.message)).toEqual(['CHEZ MBALLA : son solde a déjà été repris', 'Restaurant Le Wouri : son solde a déjà été repris']);
    expect(s.db.prepare('SELECT COUNT(*) FROM opening_balances').pluck().get()).toBe(2);
    // Tout part au serveur central.
    expect(s.db.prepare("SELECT COUNT(*) FROM outbox WHERE entity = 'opening_balance'").pluck().get()).toBe(2);
  });

  it('fournisseurs : dettes reprises payables, hors achats et hors TVA', () => {
    const { s, ctx } = setup();
    const file = csv(`nom;telephone;niu;delai;solde;facture;date;echeance
SABC;233 42 31 44;M0123456789;30;1 250 000;F-55821;30/09/2026;30/10/2026
Grossiste Mokolo;677 55 44 33;;0;0;;;`);
    const done = s.opening.run(ctx, 'suppliers', file, { preview: false });
    expect(done).toMatchObject({ created: 2, total: 1_250_000, errors: [] });
    const sabc = s.purchases.listSuppliers().find((x) => x.name === 'SABC')!;
    expect(sabc.balance).toBe(1_250_000);
    const invoice = s.purchases.listInvoices(ctx.storeId, { supplierId: sabc.id })[0]!;
    expect(invoice).toMatchObject({ supplier_number: 'F-55821', due_date: '2026-10-30', total_tva: 0 });
    s.purchases.paySupplier(ctx, { invoiceId: invoice.id, method: 'BANK_TRANSFER', amount: 250_000, reference: 'VIR-1' });
    expect(s.purchases.listSuppliers().find((x) => x.id === sabc.id)!.balance).toBe(1_000_000);

    const entries = s.accounting.entries(ctx.storeId);
    expect(balanced(entries)).toBe(true);
    expect(entries.filter((e) => e.journal === 'AC')).toHaveLength(0);
    expect(entries.find((e) => e.journal === 'AN')!.lines).toEqual([
      expect.objectContaining({ account: OPENING_ACCOUNT, debit: 1_250_000 }),
      expect.objectContaining({ account: '401', aux: sabc.code, credit: 1_250_000 }),
    ]);
    expect(s.accounting.ledger(ctx.storeId, { account: '401', aux: sabc.code }).closing).toBe(-1_000_000);
    expect(s.accounting.vatReturn(ctx.storeId, '2026-09')).toMatchObject({ purchasesHt: 0, invoiceCount: 0 });
  });

  it('stock de départ : entre au coût indiqué, en cartons ou en unités, refuse les doublons et les lignes incomplètes', () => {
    const { s, ctx, tva, shop } = setup();
    const riz = s.catalogue.saveArticle(ctx.userId, { name: 'Riz parfumé 5 kg', unit: 'piece', vatRateId: tva, purchasePrice: 3_800, salePrice: 4_500, barcodes: [{ code: '6111234567895' }] });
    const lait = s.catalogue.saveArticle(ctx.userId, { name: 'Lait concentré 397 g', unit: 'piece', vatRateId: tva, purchasePrice: 0, salePrice: 700, perishable: true });
    const mutzig = s.catalogue.saveArticle(ctx.userId, {
      name: 'MUTZIG 50CL',
      unit: 'piece',
      unitName: 'CANETTE',
      vatRateId: tva,
      purchasePrice: 0,
      packPurchasePrice: 12_000,
      packCostPrice: 12_000,
      salePrice: 650,
      packs: [{ name: 'CASIER', contains: 12, salePrice: 7_500, barcode: '6009876543219' }],
    });
    const sucre = s.catalogue.saveArticle(ctx.userId, { name: 'Sucre en poudre', unit: 'kg', vatRateId: tva, purchasePrice: 900, salePrice: 1_100 });

    const bad = s.opening.run(
      ctx,
      'stock',
      csv(`code;designation;quantite;cout;lot;peremption
6111234567895;Riz;48;;;
LAIT CONCENTRÉ 397 G;;120;520;;
Inconnu 1 L;;3;100;;
6111234567895;Riz encore;2;;;`),
      { preview: false, warehouseId: shop },
    );
    expect(bad.preview).toBe(true);
    expect(bad.errors.map((e) => e.message)).toEqual([
      'Lait concentré 397 g : date de péremption obligatoire (article périssable)',
      "Inconnu 1 L : article introuvable (importez d'abord le catalogue, Produit › Importer)",
      'Riz parfumé 5 kg : déjà à la ligne 2 du fichier',
    ]);
    expect(s.stock.list(ctx.storeId).filter((r) => r.qty > 0)).toHaveLength(0);

    const file = csv(`code;quantite;cout;lot;peremption
6111234567895;48;;;
Lait concentré 397 g;120;520;L2409;31/03/2027
6009876543219;10;12 000;;
Sucre en poudre;12,5;;;`);
    const done = s.opening.run(ctx, 'stock', file, { preview: false, warehouseId: shop });
    expect(done.errors).toEqual([]);
    // 48 × 3 800 + 120 × 520 + 10 casiers × 12 000 + 12,5 kg × 900.
    expect(done.total).toBe(182_400 + 62_400 + 120_000 + 11_250);
    const stockOf = (id: string) => s.stock.list(ctx.storeId).find((r) => r.article_id === id)!;
    expect(stockOf(riz.id)).toMatchObject({ qty: 48_000, avg_cost: 3_800 });
    expect(stockOf(lait.id)).toMatchObject({ qty: 120_000, avg_cost: 520 });
    expect(stockOf(mutzig.id)).toMatchObject({ qty: 120_000, avg_cost: 1_000 });
    expect(stockOf(sucre.id)).toMatchObject({ qty: 12_500, avg_cost: 900 });
    expect(s.stock.lotsOf(lait.id, ctx.storeId)[0]).toMatchObject({ lot_number: 'L2409', expiry: '2027-03-31' });

    // Une reprise n'est ni un achat à facturer ni une réception fournisseur.
    expect(s.purchases.listReceptions(ctx.storeId, { uninvoiced: true })).toHaveLength(0);
    expect(s.statements.uninvoiced(ctx.storeId, '2026-12-31').amount).toBe(0);
    const an = s.accounting.entries(ctx.storeId, { journal: 'AN' });
    expect(an[0]!.lines).toEqual([expect.objectContaining({ account: '311', debit: done.total }), expect.objectContaining({ account: OPENING_ACCOUNT, credit: done.total })]);
    expect(s.opening.summary(ctx.storeId).stock).toMatchObject({ count: 4, total: done.total });

    // Déjà en stock : il faut un inventaire, pas une seconde reprise.
    const again = s.opening.run(ctx, 'stock', file, { preview: true, warehouseId: shop });
    expect(again.errors[0]!.message).toMatch(/il y a déjà du stock dans « .+ », faites plutôt un inventaire/);
  });

  it("les soldes repris passent d'un PC à l'autre du magasin", () => {
    const { s, ctx } = setup();
    s.opening.run(ctx, 'customers', csv(`nom;solde\nChez Mballa;10 000`), { preview: false });
    const events = s.sync.eventsSince(0);
    const other: Services = createServices(openDatabase(':memory:'), () => now);
    other.sync.applyRemote(events);
    const customer = other.customers.listCustomers(ctx.storeId)[0]!;
    expect(other.customers.account(ctx.storeId, customer.id).balance).toBe(10_000);
  });
});
