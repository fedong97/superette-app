import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mergeStoreSettings, roleRights, roundCash, userRights } from '@superette/core';
import { describe, expect, it } from 'vitest';
import { createServices, openDatabase, openServices } from '../src';

let now = new Date('2026-10-10T09:00:00Z');

function setup() {
  now = new Date('2026-10-10T09:00:00Z');
  const s = createServices(openDatabase(':memory:'), () => now);
  const { store, register, admin } = s.admin.bootstrap({ storeCode: 'DLA1', storeName: 'Superette Akwa', adminName: 'Steve', adminLogin: 'steve', adminPin: '1234' });
  const ctx = { storeId: store.id, registerId: register.id, userId: admin.id };
  const tva = s.admin.listVatRates().find((r) => r.rate_bp === 1925)!.id;
  const savon = s.catalogue.saveArticle(admin.id, { name: 'SAVON AZUR', unit: 'piece', vatRateId: tva, purchasePrice: 250, salePrice: 1_237 });
  s.stock.receive(ctx, { warehouseId: s.admin.salesWarehouse(store.id).id, lines: [{ articleId: savon.id, qty: 100_000, unitCost: 250 }] });
  s.pos.openSession(ctx, 0);
  const set = (patch: Parameters<typeof s.admin.saveStoreSettings>[2]) => s.admin.saveStoreSettings(admin.id, store.id, patch);
  return { s, ctx, savon, set };
}

describe('droits détaillés', () => {
  it('un droit jamais enregistré suit son droit parent', () => {
    // Ancien réglage : la caissière avait le droit des clients à crédit, sans les nouveaux droits fins.
    const rights = roleRights('cashier', { receivables: true, articles: false });
    expect(rights).toContain('customer_deactivate');
    expect(rights).not.toContain('article_create');
    // Une fois enregistré, le droit fin garde sa propre valeur.
    expect(roleRights('cashier', { receivables: true, customer_deactivate: false })).not.toContain('customer_deactivate');
    expect(roleRights('admin', {})).toContain('settings_edit');
  });

  it('les privilèges ajoutent ou retirent un droit à un seul utilisateur', () => {
    const { s, ctx } = setup();
    const awa = s.admin.createUser(ctx.userId, { name: 'Awa', login: 'awa', pin: '5678', role: 'cashier', storeId: ctx.storeId });
    const binta = s.admin.createUser(ctx.userId, { name: 'Binta', login: 'binta', pin: '5679', role: 'cashier', storeId: ctx.storeId });
    expect(s.admin.hasRight(awa, 'stock')).toBe(false);
    expect(s.admin.hasRight(awa, 'cash')).toBe(true);

    // Un droit déjà donné par le rôle n'est pas gardé comme privilège, ni un retrait d'un droit que le rôle ne donne pas.
    const saved = s.admin.savePrivileges(ctx.userId, awa.id, { grants: ['stock', 'cash'], revokes: ['cash', 'audit'] });
    expect(saved).toEqual({ grants: ['stock'], revokes: ['cash'] });
    expect(s.admin.hasRight(awa, 'stock')).toBe(true);
    expect(s.admin.hasRight(awa, 'cash')).toBe(false);
    // Sa collègue du même rôle ne change pas.
    expect(s.admin.hasRight(binta, 'stock')).toBe(false);
    expect(s.admin.hasRight(binta, 'cash')).toBe(true);

    expect(s.admin.holders('stock').map((u) => u.name)).toContain('Awa');
    expect(s.admin.holders('stock').map((u) => u.name)).not.toContain('Binta');
    expect(s.admin.holders('cash').map((u) => u.name)).toEqual(expect.arrayContaining(['Steve', 'Binta']));
    expect(s.admin.holders('cash').map((u) => u.name)).not.toContain('Awa');
    expect(s.admin.privilegeCounts()).toEqual({ [awa.id]: { grants: 1, revokes: 1 } });

    expect(() => s.admin.savePrivileges(ctx.userId, ctx.userId, { grants: [], revokes: ['cash'] })).toThrow(/tous les droits/);
    expect(() => s.admin.savePrivileges(ctx.userId, awa.id, { grants: ['voler' as never], revokes: [] })).toThrow(/Droit inconnu/);
    // Les privilèges voyagent vers les autres postes.
    expect(s.db.prepare("SELECT entity_id FROM outbox WHERE entity = 'user_rights'").pluck().all()).toEqual([awa.id]);
    expect(userRights('admin', s.admin.rights('admin'), { grants: [], revokes: ['cash'] })).toContain('cash');
  });
});

describe('paramètres du magasin', () => {
  it('valide les valeurs et garde les valeurs par défaut', () => {
    const { s, ctx, set } = setup();
    expect(s.admin.storeSettings(ctx.storeId)).toMatchObject({ cashRounding: 1, prefixQuote: 'DV', pinMinLength: 4 });
    expect(() => set({ cashRounding: 7 as never })).toThrow(/Arrondi possible/);
    expect(() => set({ maxDiscountPct: 150 })).toThrow(/entre 0 et 100/);
    expect(() => set({ prefixSale: 'FA CT' })).toThrow(/Préfixe/);
    expect(() => mergeStoreSettings(null, { logo: 'http://x' })).toThrow(/image/);
    expect(set({ prefixSale: 'fa', ticketHeader: '  Bienvenue  ' })).toMatchObject({ prefixSale: 'FA', ticketHeader: 'Bienvenue' });
    expect(roundCash(1_237, 25)).toBe(1_225);
    expect(roundCash(1_237, 1)).toBe(1_237);
  });

  it('arrondit les ventes payées en espèces, pas celles payées autrement', () => {
    const { s, ctx, savon, set } = setup();
    set({ cashRounding: 25 });
    const cash = s.pos.completeSale(ctx, { lines: [{ articleId: savon.id, qty: 1000 }], payments: [{ method: 'CASH', amount: 1_225 }] });
    expect(cash).toMatchObject({ total_ttc: 1_225, rounding: 12 });
    const momo = s.pos.completeSale(ctx, { lines: [{ articleId: savon.id, qty: 1000 }], payments: [{ method: 'MTN_MOMO', amount: 1_237, reference: 'TX1' }] });
    expect(momo).toMatchObject({ total_ttc: 1_237, rounding: 0 });
  });

  it('accepte une petite remise sans code du gérant, sous le maximum réglé', () => {
    const { s, ctx, savon, set } = setup();
    const awa = s.admin.createUser(ctx.userId, { name: 'Awa', login: 'awa', pin: '5678', role: 'cashier', storeId: ctx.storeId });
    const c = { ...ctx, userId: awa.id };
    const sell = (discount: number) => s.pos.completeSale(c, { lines: [{ articleId: savon.id, qty: 10_000, discount }], discountReason: 'Client fidèle', payments: [{ method: 'CASH', amount: 12_370 - discount }] });
    expect(() => sell(500)).toThrow(/validation du gérant/);
    set({ maxDiscountPct: 5 });
    expect(sell(500).total_ttc).toBe(11_870);
    expect(() => sell(1_000)).toThrow(/validation du gérant/);
  });

  it('demande le nom du client au-delà du montant réglé', () => {
    const { s, ctx, savon, set } = setup();
    set({ customerRequiredAbove: 10_000 });
    const sell = (clientName?: string) => s.pos.completeSale(ctx, { lines: [{ articleId: savon.id, qty: 10_000 }], payments: [{ method: 'CASH', amount: 12_370 }], clientName });
    expect(() => sell()).toThrow(/nom du client est obligatoire/);
    expect(sell('M. Etoundi').total_ttc).toBe(12_370);
    expect(s.pos.completeSale(ctx, { lines: [{ articleId: savon.id, qty: 1000 }], payments: [{ method: 'CASH', amount: 1_237 }] }).total_ttc).toBe(1_237);
  });

  it('refuse le crédit au client en retard si le paramètre le demande', () => {
    const { s, ctx, savon, set } = setup();
    const mballa = s.customers.saveCustomer(ctx.userId, { name: 'Chez Mballa', creditLimit: 100_000, paymentTermsDays: 7 });
    const credit = (by?: string) =>
      s.pos.completeSale(ctx, { lines: [{ articleId: savon.id, qty: 1000 }], payments: [{ method: 'CUSTOMER_CREDIT', amount: 1_237 }], customerId: mballa.id, creditAuthorizedBy: by });
    credit();
    now = new Date('2026-10-25T09:00:00Z');
    expect(credit().total_ttc).toBe(1_237); // sans le paramètre : accepté
    set({ creditBlockLate: true });
    const awa = s.admin.createUser(ctx.userId, { name: 'Awa', login: 'awa', pin: '5678', role: 'cashier', storeId: ctx.storeId });
    expect(() => s.pos.completeSale({ ...ctx, userId: awa.id }, { lines: [{ articleId: savon.id, qty: 1000 }], payments: [{ method: 'CUSTOMER_CREDIT', amount: 1_237 }], customerId: mballa.id })).toThrow(
      /factures échues non payées/,
    );
    expect(credit(ctx.userId).total_ttc).toBe(1_237); // avec l'accord du gérant
  });

  it('met les préfixes devant les numéros des tickets, devis et bons de commande', () => {
    const { s, ctx, savon, set } = setup();
    const before = s.pos.completeSale(ctx, { lines: [{ articleId: savon.id, qty: 1000 }], payments: [{ method: 'CASH', amount: 1_237 }] });
    expect(before.number).toMatch(/^DLA1-/);
    set({ prefixSale: 'FA', prefixQuote: 'DEV', prefixOrder: 'CMD' });
    const after = s.pos.completeSale(ctx, { lines: [{ articleId: savon.id, qty: 1000 }], payments: [{ method: 'CASH', amount: 1_237 }] });
    expect(after.number).toMatch(/^FA-DLA1-/);
    // La suite continue après le dernier numéro, avec ou sans préfixe.
    expect(Number(after.number.split('-').pop())).toBe(Number(before.number.split('-').pop()) + 1);
    const quote = s.quotes.save(ctx, { kind: 'quote', lines: [{ articleId: savon.id, qty: 1000 }], customerName: 'M. Etoundi' });
    expect(quote.number).toMatch(/^DEV-/);
    const supplier = s.purchases.saveSupplier(ctx.userId, { name: 'SABC' });
    const order = s.purchases.createOrder(ctx, { supplierId: supplier.id, warehouseId: s.admin.salesWarehouse(ctx.storeId).id, lines: [{ articleId: savon.id, qty: 1000, unitCost: 250 }] });
    expect(order.number).toMatch(/^CMD-/);
  });

  it('impose la longueur du code et bloque après trop de codes faux', () => {
    const { s, ctx, set } = setup();
    set({ pinMinLength: 6, maxLoginAttempts: 3 });
    expect(() => s.admin.createUser(ctx.userId, { name: 'Awa', login: 'awa', pin: '5678', role: 'cashier', storeId: ctx.storeId })).toThrow(/6 chiffres/);
    const awa = s.admin.createUser(ctx.userId, { name: 'Awa', login: 'awa', pin: '567890', role: 'cashier', storeId: ctx.storeId });
    expect(() => s.admin.login('awa', '000000')).toThrow(/incorrect/);
    expect(() => s.admin.login('awa', '000000')).toThrow(/incorrect/);
    expect(() => s.admin.login('awa', '000000')).toThrow(/bloqué 15 minutes/);
    // Même le bon code est refusé pendant le blocage.
    expect(() => s.admin.login('awa', '567890')).toThrow(/bloqué encore 15 min/);
    expect(s.admin.lockedUsers()).toEqual([awa.id]);
    now = new Date('2026-10-10T09:16:00Z');
    expect(s.admin.login('awa', '567890').id).toBe(awa.id);
    // L'administrateur débloque sans attendre.
    for (let i = 0; i < 3; i++) expect(() => s.admin.login('awa', '000000')).toThrow();
    s.admin.unlockUser(ctx.userId, awa.id);
    expect(s.admin.lockedUsers()).toEqual([]);
    expect(s.admin.login('awa', '567890').id).toBe(awa.id);
  });
});

describe('sauvegarde à heure fixe', () => {
  it('fait une deuxième sauvegarde à l’heure réglée', async () => {
    const root = mkdtempSync(join(tmpdir(), 'superette-heure-'));
    let clock = new Date('2026-10-10T08:00:00');
    const s = openServices(join(root, 'superette.db'), () => clock);
    const { admin } = s.admin.bootstrap({ storeCode: 'DLA1', storeName: 'Superette Akwa', adminName: 'Steve', adminLogin: 'steve', adminPin: '1234' });
    expect(() => s.backups.configure(admin.id, { autoTime: '25:00' })).toThrow();
    s.backups.configure(admin.id, { autoTime: '18:30' });
    expect(s.backups.status().auto_time).toBe('18:30');
    expect(await s.backups.runAutomatic()).not.toBeNull(); // sauvegarde du jour
    expect(s.backups.autoDue()).toBe(false);
    clock = new Date('2026-10-10T18:35:00');
    expect(s.backups.autoDue()).toBe(true);
    expect(await s.backups.runAutomatic()).not.toBeNull();
    expect(s.backups.autoDue()).toBe(false);
  });
});
