import { BUILTIN_TEMPLATES, receiptToEscPos, receiptToText, renderDocHtml } from '@superette/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { type Context, type Services, createServices, openDatabase } from '../src';

const now = new Date('2026-10-06T08:00:00Z');
let s: Services;
let ctx: Context;

beforeEach(() => {
  s = createServices(openDatabase(':memory:'), () => now);
  const { store, register, admin } = s.admin.bootstrap({ storeCode: 'DLA1', storeName: 'Superette Akwa', adminName: 'Steve', adminLogin: 'steve', adminPin: '1234' });
  s.admin.updateStore(admin.id, store.id, { address: 'Rue Joss, Akwa', phone: '699 00 00 00', taxpayer_number: 'M012345678901A' });
  ctx = { storeId: store.id, registerId: register.id, userId: admin.id };
});

function sell() {
  const rates = s.admin.listVatRates();
  const tva = rates.find((r) => r.rate_bp === 1925)!.id;
  const exo = rates.find((r) => r.rate_bp === 0)!.id;
  const shop = s.admin.salesWarehouse(ctx.storeId).id;
  const biere = s.catalogue.saveArticle(ctx.userId, { name: 'Bière Castel 65 cl', unit: 'piece', vatRateId: tva, purchasePrice: 0, salePrice: 650 });
  const riz = s.catalogue.saveArticle(ctx.userId, { name: 'Riz parfumé Uncle Ben’s 5 kg', unit: 'piece', vatRateId: exo, purchasePrice: 0, salePrice: 4500 });
  s.stock.receive(ctx, { warehouseId: shop, lines: [{ articleId: biere.id, qty: 48000, unitCost: 450 }, { articleId: riz.id, qty: 10000, unitCost: 3800 }] });
  s.pos.openSession(ctx, 20000);
  return s.pos.completeSale(ctx, {
    lines: [
      { articleId: biere.id, qty: 6000 },
      { articleId: riz.id, qty: 1000 },
    ],
    payments: [
      { method: 'MTN_MOMO', amount: 3000, reference: 'MP261006.1234' },
      { method: 'CASH', amount: 10000 },
    ],
  });
}

describe('tickets de caisse', () => {
  it('compose le ticket une seule fois pour le pilote et pour l’ESC/POS', () => {
    const sale = sell();
    const text = receiptToText(s.receipts.ticket(sale.id), 32);
    expect(text.split('\n')).toEqual([
      '  S u p e r e t t e   A k w a',
      '         Rue Joss, Akwa',
      '          699 00 00 00',
      '      NIU : M012345678901A',
      '-'.repeat(32),
      'Ticket DLA1-1-000001',
      '06/10/2026 09:00 · Steve',
      '-'.repeat(32),
      'Bière Castel 65 cl         3 900',
      '  6 x 650',
      "Riz parfumé Uncle Ben's 5 kg",
      '                           4 500',
      '-'.repeat(32),
      'T O T A L   F C F A   8   4 0 0',
      'MTN Mobile Money MP261006.1234',
      '                           3 000',
      'Espèces                   10 000',
      'Rendu monnaie              4 600',
      '-'.repeat(32),
      'TVA 19,25 % sur 3 900        630',
      'TVA 0 % sur 4 500              0',
      'dont TVA                     630',
      '-'.repeat(32),
      '    Merci de votre visite !',
    ]);
    // 48 colonnes (80 mm) : le libellé tient sur une ligne.
    expect(receiptToText(s.receipts.ticket(sale.id), 48)).toMatch(/\nRiz parfumé Uncle Ben's 5 kg {15}4 500\n/);
    const bytes = receiptToEscPos(s.receipts.ticket(sale.id), { columns: 48, codepage: 'pc850', kick: true });
    expect(Buffer.from(bytes).includes(Buffer.from([0x1b, 0x70, 0, 25, 250]))).toBe(true);
  });

  it('ticket et facture suivent le modèle par défaut du magasin', () => {
    const sale = sell();
    const base = structuredClone(BUILTIN_TEMPLATES.find((t) => t.id === 'invoice-ticket-cash')!);
    const mine = { ...base, id: 'tpl-court', builtin: false, name: 'Ticket court', info: { ...base.info, title: 'FACTURE', seller: false }, totals: { ...base.totals, vatDetail: false } };
    s.admin.saveStoreSettings(ctx.userId, ctx.storeId, { printTemplates: [mine], printDefaults: { 'invoice.ticket.cash': 'tpl-court' } });
    const text = receiptToText(s.receipts.ticket(sale.id, { duplicate: true }), 32);
    expect(text).toContain('FACTURE\nDUPLICATA\nN° DLA1-1-000001\n06/10/2026 09:00\n');
    expect(text).not.toContain('dont TVA');
    // Vente comptant : modèle A4 comptant, avec le code des articles et le vendeur.
    expect(s.receipts.saleVariant(sale.id)).toBe('cash');
    const a4 = s.receipts.saleTemplate(sale.id, 'a4');
    expect(a4.id).toBe('invoice-a4-cash');
    const html = renderDocHtml(a4, s.receipts.saleDoc(sale.id));
    expect(html).toContain('Facture DLA1-1-000001');
    expect(html).toContain('Vendeur : Steve');
    expect(html).toContain('<td>Bière Castel 65 cl</td>');
  });

  it('rapport Z et page de test', () => {
    sell();
    const session = s.pos.currentSession(ctx.registerId!)!;
    // Écart de 5 100 au-delà du seuil (500), justifié par le gérant à la clôture.
    s.pos.closeSession(ctx, { 10000: 3, 500: 1 }, { floatLeft: 10_000, gapReason: 'Recomptage demandé', gapApprovedBy: ctx.userId });
    const z = receiptToText(s.receipts.zReport(session.id), 48);
    expect(z).toContain('RAPPORT Z N° 1');
    expect(z).toMatch(/Ventes espèces\s+5 400/);
    expect(z).toMatch(/Théorique\s+25 400/);
    expect(z).toMatch(/Écart\s+5 100/);
    expect(z).toContain("Motif de l'écart : Recomptage demandé");
    expect(z).toMatch(/Versé à la caisse centrale\s+20 500/);
    expect(z).toMatch(/Fond laissé dans le tiroir\s+10 000/);
    const test = receiptToText(s.receipts.testPage(32), 32);
    expect(test).toContain('12345678901234567890123456789012');
    expect(test).toContain('Accents : é è ê à â ç ù û ô î');
  });

  it('trace l’ouverture manuelle du tiroir', () => {
    s.receipts.drawerOpened(ctx);
    expect(s.admin.auditLog().find((a) => a.action === 'drawer.open')).toMatchObject({ action: 'drawer.open', entity: 'register', entity_id: ctx.registerId, user_name: 'Steve' });
  });
});
