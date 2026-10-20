import { describe, expect, it } from 'vitest';
import { purchaseOrderMessage, staffBadgeHtml, ticketMessage, whatsappLink } from '../src';

describe('envois par WhatsApp', () => {
  it('écrit le ticket du client avec les lignes, le total et les paiements', () => {
    const text = ticketMessage({
      store: 'Superette Akwa',
      storePhone: '699 00 00 00',
      number: 'DLA1-1-000012',
      date: new Date(2026, 9, 20, 10, 5).toISOString(),
      kind: 'sale',
      customer: 'Mme Mballa',
      lines: [
        { label: 'RIZ 1 KG', qty: '2', total: 2_000 },
        { label: 'MUTZIG 50CL (CARTON)', qty: '1', total: 12_000 },
      ],
      total: 14_000,
      discount: 0,
      payments: [{ label: 'Espèces', amount: 15_000 }],
      change: 1_000,
    });
    expect(text).toContain('*Superette Akwa*');
    expect(text).toContain('Ticket DLA1-1-000012 du 20/10/2026 10:05');
    expect(text).toContain('2 × RIZ 1 KG');
    expect(text).toMatch(/\*Total : 14.000 FCFA\*/);
    expect(text).toMatch(/Monnaie rendue : 1.000 FCFA/);
    expect(text).not.toContain('Remises');
    expect(whatsappLink('699 12 34 56', text)).toMatch(/^https:\/\/wa\.me\/237699123456\?text=/);
  });

  it('écrit le bon de commande pour le fournisseur', () => {
    const text = purchaseOrderMessage({
      store: 'Superette Akwa',
      supplier: 'SABC',
      number: 'BC-DLA11-3',
      expected: '2026-10-22',
      lines: [{ label: 'CASTEL 65CL', qty: '10', reference: 'C65' }],
      total: 95_000,
    });
    expect(text).toContain('Bonjour SABC,');
    expect(text).toContain('- 10 × CASTEL 65CL (réf. C65)');
    expect(text).toContain('Livraison souhaitée le 22/10/2026.');
  });

  it('dessine le badge avec son code-barres', () => {
    const html = staffBadgeHtml({ store: 'Superette Akwa', name: 'Awa', role: 'Caissier', code: 'FX12345678' });
    expect(html).toContain('Badge du personnel');
    expect(html).toContain('<svg');
    expect(html).toContain('Awa');
  });
});
