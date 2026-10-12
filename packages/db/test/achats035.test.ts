import { purchaseAmounts, promoFree, spreadDiscount } from '@superette/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { type Context, type Services, createServices, openDatabase } from '../src';

let s: Services;
let ctx: Context;
let storeId: string;
let adminId: string;
let wh: string;
let riz: string;
let huile: string;
let sup: string;
const now = new Date('2026-10-11T09:00:00Z');

beforeEach(() => {
  s = createServices(openDatabase(':memory:'), () => now);
  const { store, register, admin } = s.admin.bootstrap({ storeCode: 'DLA1', storeName: 'Superette Akwa', adminName: 'Steve', adminLogin: 'steve', adminPin: '1234', vatEnabled: false });
  storeId = store.id;
  adminId = admin.id;
  ctx = { storeId, registerId: register.id, userId: admin.id };
  wh = s.admin.salesWarehouse(storeId).id;
  const tva = s.admin.listVatRates()[0]!.id;
  riz = s.catalogue.saveArticle(admin.id, { name: 'Riz 5 kg', unit: 'piece', vatRateId: tva, purchasePrice: 3_000, salePrice: 5_000 }).id;
  huile = s.catalogue.saveArticle(admin.id, { name: 'Huile 1 L', unit: 'piece', vatRateId: tva, purchasePrice: 1_000, salePrice: 1_500 }).id;
  sup = s.purchases.saveSupplier(admin.id, { name: 'CCA Distribution', paymentTermsDays: 30 }).id;
});

const cost = (articleId: string) => s.stock.list(storeId).find((r) => r.article_id === articleId)!;

describe('calcul des remises et promos à l’achat', () => {
  it('N achetés, M payés : gratuits par tranche complète', () => {
    expect(promoFree(30, 12, 10)).toBe(4);
    expect(promoFree(11, 12, 10)).toBe(0);
    expect(promoFree(24, 12, 12)).toBe(0);
  });

  it('remise et gratuits donnent le coût net unitaire', () => {
    // 12 riz à 3 000, 2 gratuits, puis 10 % : 10 × 3 000 = 30 000 − 3 000 = 27 000, soit 2 250 le sac.
    expect(purchaseAmounts({ qty: 12_000, unitCost: 3_000, discountBp: 1_000, freeQty: 2_000 })).toEqual({
      gross: 36_000,
      free: 6_000,
      discount: 3_000,
      net: 27_000,
      netUnitCost: 2_250,
    });
  });

  it('remise globale répartie au prorata, sans perte d’arrondi', () => {
    const parts = spreadDiscount([27_000, 9_001], 1_000);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(1_000);
    expect(parts[0]).toBe(750);
  });
});

describe('photo de l’article', () => {
  const img = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==';
  it('se met, se lit avec sa miniature dans les listes, se retire', () => {
    s.catalogue.setPhoto(adminId, riz, { photo: img, thumb: img });
    expect(s.catalogue.photo(riz)).toBe(img);
    expect(s.catalogue.searchArticles('riz', storeId)[0]!.photo_thumb).toBe(img);
    s.catalogue.setPhoto(adminId, riz, null);
    expect(s.catalogue.photo(riz)).toBeNull();
    expect(() => s.catalogue.setPhoto(adminId, riz, { photo: 'pas une image', thumb: img })).toThrow(/Image invalide/);
  });
});

describe('remises sur le bon de commande et la réception', () => {
  it('le bon garde remise et promo ; la réception fait entrer le stock au coût net', () => {
    const o = s.purchases.createOrder(ctx, {
      supplierId: sup,
      warehouseId: wh,
      lines: [{ articleId: riz, qty: 12_000, unitCost: 3_000, discountBp: 1_000, freeQty: 2_000, promoBuy: 12, promoPay: 10 }],
    });
    expect(o.lines[0]).toMatchObject({ discount_bp: 1_000, free_qty: 2_000, promo_buy: 12, promo_pay: 10, total_ht: 27_000 });
    expect(o.total_ht).toBe(27_000);
    s.purchases.setOrderStatus(ctx, o.id, 'sent');
    const r = s.purchases.receiveOrder(ctx, o.id, {
      lines: [{ orderLineId: o.lines[0]!.id, articleId: riz, qty: 12_000, unitCost: 3_000, discountBp: 1_000, freeQty: 2_000, promoBuy: 12, promoPay: 10 }],
    });
    const rec = s.purchases.getReception(r.id);
    expect(rec.total_ht).toBe(27_000);
    expect(rec.lines[0]).toMatchObject({ unit_cost: 2_250, gross_cost: 3_000, discount_bp: 1_000, free_qty: 2_000 });
    expect(cost(riz).avg_cost).toBe(2_250);
    // Le prix d'achat de la fiche reste le prix du fournisseur, avant remise.
    expect(s.catalogue.getArticle(riz).purchase_price).toBe(3_000);
  });

  it('refuse plus de gratuits que de quantité ou une remise au-delà de 100 %', () => {
    expect(() => s.stock.receive(ctx, { warehouseId: wh, lines: [{ articleId: riz, qty: 2_000, unitCost: 3_000, freeQty: 3_000 }] })).toThrow(/gratuits/);
    expect(() => s.stock.receive(ctx, { warehouseId: wh, lines: [{ articleId: riz, qty: 2_000, unitCost: 3_000, discountBp: 12_000 }] })).toThrow(/Remise/);
  });
});

describe('facture d’achat directe', () => {
  it('fait entrer le stock, crée le bon de réception et la facture, réparti la remise globale, et se règle tout de suite', () => {
    s.treasury.record({ storeId, registerId: null, userId: adminId }, { kind: 'IN', nature: 'owner', amount: 100_000 });
    const inv = s.purchases.directInvoice(ctx, {
      supplierId: sup,
      supplierNumber: 'FAC-2210',
      invoiceDate: '2026-10-11',
      warehouseId: wh,
      lines: [
        { articleId: riz, qty: 12_000, unitCost: 3_000, freeQty: 2_000, promoBuy: 12, promoPay: 10 },
        { articleId: huile, qty: 10_000, unitCost: 1_000, discountBp: 500 },
      ],
      discountAmount: 1_950,
      payment: { method: 'CASH' },
    });
    // Lignes : 30 000 + 9 500 = 39 500, remise globale 1 950 : 37 550.
    expect(inv).toMatchObject({ direct: 1, discount: 1_950, total_ht: 37_550, total_ttc: 37_550, balance: 0, state: 'paid' });
    const lines = s.purchases.invoiceLines(inv.id);
    expect(lines.reduce((t, l) => t + l.total_ht, 0)).toBe(37_550);
    expect(lines.map((l) => l.free_qty)).toEqual([2_000, 0]);
    expect(cost(riz).qty).toBe(12_000);
    const rec = s.purchases.listReceptions(storeId)[0]!;
    expect(rec).toMatchObject({ invoice_id: inv.id, discount: 1_950, total_ht: 37_550 });
    expect(s.treasury.balance(storeId)).toBe(100_000 - 37_550);
  });

  it('une facture déjà saisie est refusée et rien n’entre en stock', () => {
    const input = { supplierId: sup, supplierNumber: 'FAC-1', invoiceDate: '2026-10-11', warehouseId: wh, lines: [{ articleId: huile, qty: 5_000, unitCost: 1_000 }] };
    s.purchases.directInvoice(ctx, input);
    expect(() => s.purchases.directInvoice(ctx, input)).toThrow(/déjà saisie/);
    expect(cost(huile).qty).toBe(5_000);
  });
});

describe('compte de rattachement des collaborateurs', () => {
  const office = () => ({ storeId, registerId: null, userId: adminId });
  it('crée le sous-compte sous le compte choisi et passe les salaires par lui', () => {
    const jean = s.staff.save(office(), { name: 'Jean Associé', baseSalary: 100_000, parentAccount: '4621' });
    expect(jean).toMatchObject({ parent_account: '4621', salary_account: '4621001', parent_label: 'Associés, comptes courants' });
    expect(s.accounting.listAccounts().find((a) => a.id === '4621001')?.label).toBe('Associés, comptes courants, Jean Associé');
    const paul = s.staff.save(office(), { name: 'Paul', baseSalary: 50_000 });
    expect(paul).toMatchObject({ parent_account: '4211', salary_account: '4211002' });
    s.staff.recordSalaries(office(), '2026-09', [{ staffId: jean.id, gross: 100_000 }]);
    expect(s.accounting.trialBalance(storeId).rows.find((r) => r.account === '4621001')?.closing).toBe(-100_000);
    expect(s.staff.parents().slice(0, 4).map((p) => p.id)).toEqual(['4211', '4311', '4471', '4621']);
  });

  it('change de rattachement tant qu’il n’y a pas d’écriture, puis refuse', () => {
    const awa = s.staff.save(office(), { name: 'Awa', baseSalary: 60_000 });
    const moved = s.staff.save(office(), { name: 'Awa', baseSalary: 60_000, parentAccount: '4311' }, awa.id);
    expect(moved).toMatchObject({ parent_account: '4311', salary_account: '4311001' });
    s.staff.recordSalaries(office(), '2026-09', [{ staffId: awa.id, gross: 60_000 }]);
    expect(() => s.staff.save(office(), { name: 'Awa', baseSalary: 60_000, parentAccount: '4211' }, awa.id)).toThrow(/ne peut plus changer/);
    expect(() => s.staff.save(office(), { name: 'X', parentAccount: '601' })).toThrow(/classe 4/);
    expect(() => s.staff.save(office(), { name: 'X', parentAccount: '4251' })).toThrow(/avances/);
  });
});
