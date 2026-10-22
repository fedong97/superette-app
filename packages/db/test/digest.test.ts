import { formatFcfa } from '@superette/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { type Context, type Services, createServices, openDatabase } from '../src';

let s: Services;
let ctx: Context;
let riz: string;
let now: Date;

beforeEach(() => {
  now = new Date('2026-10-12T19:00:00');
  s = createServices(openDatabase(':memory:'), () => new Date(now));
  const { store, register, admin } = s.admin.bootstrap({ storeCode: 'DLA1', storeName: 'Superette Akwa', adminName: 'Steve', adminLogin: 'steve', adminPin: '1234' });
  ctx = { storeId: store.id, registerId: register.id, userId: admin.id };
  const tva = s.admin.listVatRates()[0]!.id;
  riz = s.catalogue.saveArticle(admin.id, { name: 'Riz 5 kg', unit: 'piece', vatRateId: tva, purchasePrice: 3_600, salePrice: 4_500 }).id;
  s.stock.receive(ctx, { warehouseId: s.admin.salesWarehouse(store.id).id, lines: [{ articleId: riz, qty: 10_000, unitCost: 3_600 }] });
});

const config = { enabled: true, hour: '21:00', emails: 'gerant@gmail.com', whatsapp: '+237 677 00 00 00', smtpHost: 'smtp.gmail.com', smtpPort: 465, smtpUser: 'magasin@gmail.com' };

describe('résumé du jour', () => {
  it('donne les ventes, les encaissements et les caisses de la journée', () => {
    s.pos.openSession(ctx, 10_000);
    s.pos.completeSale(ctx, { lines: [{ articleId: riz, qty: 2_000 }], payments: [{ method: 'CASH', amount: 10_000 }] });
    s.pos.completeSale(ctx, { lines: [{ articleId: riz, qty: 1_000 }], payments: [{ method: 'MTN_MOMO', amount: 4_500, reference: 'MP123' }] });
    // 10 000 de fond + 9 000 de ventes en espèces = 19 000 attendus ; 18 500 comptés.
    s.pos.closeSession(ctx, { 10_000: 1, 5_000: 1, 2_000: 1, 1_000: 1, 500: 1 });

    const d = s.digest.build(ctx.storeId, '2026-10-12');
    expect(d).toMatchObject({ tickets: 2, revenue: 13_500, averageBasket: 6_750, expenses: 0 });
    expect(d.payments).toEqual([
      { method: 'CASH', label: 'Espèces', amount: 9_000 },
      { method: 'MTN_MOMO', label: 'MTN Mobile Money', amount: 4_500 },
    ]);
    expect(d.sessions).toMatchObject({ closed: 1, open: 0, gaps: [{ difference: -500 }] });
    expect(d.top[0]).toMatchObject({ name: 'Riz 5 kg', qty: 3_000, revenue: 13_500 });
    expect(d.text).toContain('*Superette Akwa* · ONIX 360');
    expect(d.text).toContain('Résumé du lundi 12/10/2026');
    expect(d.text).toContain(`*Ventes : ${formatFcfa(13_500)}*`);
    expect(d.text).toContain(`Espèces : ${formatFcfa(9_000)}`);
    expect(d.text).toContain(`Écart Caisse 1 (Steve) : ${formatFcfa(-500)}`);
    expect(d.text).toContain(`1. Riz 5 kg : 3 (${formatFcfa(13_500)})`);

    expect(s.digest.build(ctx.storeId, '2026-10-11').text).toContain('Aucune vente ce jour.');
  });

  it("part une fois par jour après l'heure, et rattrape la veille", () => {
    expect(s.digest.due()).toBeNull();
    s.digest.saveConfig(ctx.userId, config, 'mot-de-passe-chiffre');
    expect(s.digest.config()).toMatchObject({ whatsapp: '+237677000000', hasPassword: true, lastSent: null });
    expect(s.digest.due()).toBeNull();

    now = new Date('2026-10-12T21:05:00');
    expect(s.digest.due()).toBe('2026-10-12');
    s.digest.markSent('2026-10-12');
    expect(s.digest.due()).toBeNull();

    // PC éteint le 13 au soir : le 14 au matin, le résumé du 13 part au démarrage.
    now = new Date('2026-10-14T08:00:00');
    expect(s.digest.due()).toBe('2026-10-13');

    s.digest.saveConfig(ctx.userId, { ...config, enabled: false });
    expect(s.digest.due()).toBeNull();
    expect(s.digest.config().hasPassword).toBe(true);
  });

  it('refuse un réglage incomplet', () => {
    expect(() => s.digest.saveConfig(ctx.userId, { ...config, hour: '25:00' })).toThrow(/Heure/);
    expect(() => s.digest.saveConfig(ctx.userId, { ...config, emails: 'gerant@' })).toThrow(/invalide : gerant@/);
    expect(() => s.digest.saveConfig(ctx.userId, { ...config, emails: '' })).toThrow(/au moins une adresse/);
    expect(() => s.digest.saveConfig(ctx.userId, { ...config, smtpUser: '' })).toThrow(/serveur d'envoi/);
  });
});
