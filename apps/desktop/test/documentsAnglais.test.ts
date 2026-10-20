import { describe, expect, it } from 'vitest';
import { renderDocHtml, translateDocHtml, translateReceipt } from '@superette/core';
import { createServices, openDatabase } from '@superette/db';
import { createApi } from '../src/main/api';

const printer = new Proxy({}, { get: () => async () => true }) as never;
const sync = { now: async () => undefined, status: () => null } as never;
const system = { chooseFolder: async () => null, chooseBackupFile: async () => null, openFolder: async () => undefined, restore: () => undefined };
/** Mots français qui ne doivent plus rester sur un document traduit. */
const FRENCH = /\b(Facture|Rendu monnaie|Reste à payer|Arrêté|francs CFA|Merci|Vendeur|Désignation|Qté|Remises|Solde de votre compte|Client comptoir|Espèces|Encaissé|Attendu|Écart|Théorique|Compté|Fond de caisse|Ventes espèces)\b/;

describe('tickets et factures dans la langue du client', () => {
  it('le client choisit l’anglais : sa fiche le garde, son ticket et sa facture A4 sortent en anglais', () => {
    const s = createServices(openDatabase(':memory:'));
    const { store, register, admin } = s.admin.bootstrap({ storeCode: 'DLA1', storeName: 'Superette Akwa', adminName: 'Steve', adminLogin: 'steve', adminPin: '1234' });
    const tva = s.admin.listVatRates()[0]!.id;
    const riz = s.catalogue.saveArticle(admin.id, { name: 'RIZ 5 KG', unit: 'piece', vatRateId: tva, purchasePrice: 3_000, salePrice: 5_000 }).id;
    s.stock.receive({ storeId: store.id, registerId: register.id, userId: admin.id }, { warehouseId: s.admin.salesWarehouse(store.id).id, lines: [{ articleId: riz, qty: 50_000, unitCost: 3_000 }] });
    const api = createApi(s, printer, sync, 'test', system) as unknown as Record<string, (...a: unknown[]) => any>;
    api['auth.login']!('steve', '1234');
    api['treasury.open']!(10_000);

    const john = api['customers.save']!({ name: 'John Smith', phone: '677000000', creditLimit: 100_000, language: 'en' });
    expect(api['customers.get']!(john.id).language).toBe('en');
    expect(() => api['customers.save']!({ name: 'X', language: 'de' })).toThrow(/Langue/);
    // Une autre modification de la fiche garde la langue.
    api['customers.save']!({ name: 'John Smith', phone: '677000001' }, john.id);
    expect(api['customers.get']!(john.id).language).toBe('en');

    const sale = api['pos.sell']!({ customerId: john.id, lines: [{ articleId: riz, qty: 3000 }], payments: [{ method: 'CASH', amount: 20_000 }] });
    const ticket = translateReceipt(s.receipts.ticket(sale.id, {}), 'en');
    const text = ticket.map((l) => (l.t === 'text' ? l.text : l.t === 'row' ? `${l.left} ${l.right}` : '')).join('\n');
    expect(text).toContain('TOTAL FCFA');
    expect(text).toContain('Change');
    expect(text).toContain('RIZ 5 KG');
    expect(text).not.toMatch(FRENCH);

    for (const format of ['a4', 'listing'] as const) {
      const html = translateDocHtml(renderDocHtml(s.receipts.saleTemplate(sale.id, format), s.receipts.saleDoc(sale.id, {})), 'en');
      expect(html).toMatch(/Invoice (No\. )?DLA1-1-000001/i);
      expect(html.replace(/<style>[\s\S]*?<\/style>/g, '')).not.toMatch(FRENCH);
      if (format === 'listing') expect(html).toContain('Fifteen thousand');
    }

    // Rapport Z de la caissière en anglais (langue de l'utilisateur).
    const z = translateReceipt(s.receipts.zReport(api['treasury.state']!().session?.id ?? s.pos.currentSession(register.id)!.id), 'en');
    expect(z.map((l) => (l.t === 'text' ? l.text : l.t === 'row' ? l.left : '')).join('\n')).not.toMatch(FRENCH);
  });
});
