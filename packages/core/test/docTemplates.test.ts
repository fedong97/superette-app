import { describe, expect, it } from 'vitest';
import {
  BUILTIN_TEMPLATES,
  effectiveTemplates,
  mergeStoreSettings,
  normalizeTemplate,
  receiptToText,
  renderDocHtml,
  renderDocTicket,
  resolveTemplate,
  sampleDocData,
} from '../src';

const builtin = (id: string) => BUILTIN_TEMPLATES.find((t) => t.id === id)!;

describe('modèles d’impression', () => {
  it('un modèle par emplacement : chaque document en ticket, A4 et listing, pour chacune de ses variantes', () => {
    const slots = BUILTIN_TEMPLATES.map((t) => `${t.doc}.${t.format}.${t.variant}`);
    // Facture (comptant, à terme), devis (devis, proforma), bon de livraison, bon de commande, facture d'achat : 7 variantes × 3 formats.
    expect(new Set(slots).size).toBe(21);
    expect(slots.length).toBe(21);
    expect(resolveTemplate({}, 'invoice', 'listing', 'credit').id).toBe('invoice-listing-credit');
  });

  it('prend le modèle demandé, sinon celui par défaut, sinon celui du logiciel', () => {
    const mine = { ...structuredClone(builtin('invoice-a4-cash')), id: 'tpl-bleu', builtin: false, name: 'Facture bleue' };
    const settings = { printTemplates: [mine], printDefaults: { 'invoice.a4.cash': 'tpl-bleu' } };
    expect(resolveTemplate(settings, 'invoice', 'a4', 'cash').id).toBe('tpl-bleu');
    expect(resolveTemplate(settings, 'invoice', 'a4', 'credit').id).toBe('invoice-a4-credit');
    expect(resolveTemplate(settings, 'invoice', 'a4', 'cash', 'invoice-listing-cash').id).toBe('invoice-listing-cash');
    // Modèle par défaut supprimé : retour au modèle du logiciel.
    expect(resolveTemplate({ printDefaults: { 'invoice.a4.cash': 'disparu' } }, 'invoice', 'a4', 'cash').id).toBe('invoice-a4-cash');
    expect(effectiveTemplates(settings.printTemplates).map((t) => t.id)).toContain('tpl-bleu');
  });

  it('complète et borne un modèle enregistré', () => {
    const t = normalizeTemplate({ id: 'tpl-1', name: '  Ma facture ', doc: 'invoice', format: 'a4', variant: 'cash', page: { fontSize: 99, margin: -3 }, columns: [{ key: 'label', show: true }] });
    expect(t.name).toBe('Ma facture');
    expect(t.page.fontSize).toBe(20);
    expect(t.page.margin).toBe(0);
    expect(t.builtin).toBe(false);
    // Les colonnes absentes reviennent, masquées.
    expect(t.columns.map((c) => c.key)[0]).toBe('label');
    expect(t.columns.filter((c) => c.show).map((c) => c.key)).toEqual(['label']);
    expect(() => normalizeTemplate({ id: 'tpl-2', name: '' })).toThrow('nom');
    expect(() => normalizeTemplate({ id: 'tpl-3', name: 'Vide', columns: [{ key: 'label', show: false }] })).toThrow('colonne');
  });

  it('enregistre les modèles avec les paramètres du magasin', () => {
    const mine = { ...structuredClone(builtin('invoice-ticket-cash')), id: 'tpl-x', name: 'Ticket court' };
    const next = mergeStoreSettings(null, { printTemplates: [mine], printDefaults: { 'invoice.ticket.cash': 'tpl-x', 'mauvaise clé': 'y' } });
    expect(next.printTemplates[0]!.name).toBe('Ticket court');
    expect(next.printDefaults).toEqual({ 'invoice.ticket.cash': 'tpl-x' });
    expect(() => mergeStoreSettings(null, { printTemplates: [mine, mine] })).toThrow('même identifiant');
  });

  it('A4 : colonnes choisies, renommées et dans l’ordre voulu', () => {
    const t = structuredClone(builtin('invoice-a4-credit'));
    const code = t.columns.findIndex((c) => c.key === 'code');
    t.columns[code] = { ...t.columns[code]!, show: true, label: 'Réf.' };
    t.columns.unshift(t.columns.splice(code, 1)[0]!);
    const html = renderDocHtml(t, sampleDocData('credit'));
    expect(html).toContain('<th>Réf.</th><th>Désignation</th>');
    expect(html).toContain('Facture à terme DLA1-1-000123');
    expect(html).toContain('Reste à payer');
    expect(html).toContain('Arrêté à la somme de');
    expect(html).toContain('size: 210mm 297mm');
  });

  it('magasin sans TVA : ni colonne ni total de TVA', () => {
    const d = sampleDocData('cash', { vatEnabled: false });
    d.lines = d.lines.map((l) => ({ ...l, vatRate: 0 }));
    const html = renderDocHtml(builtin('invoice-a4-cash'), d);
    expect(html).not.toContain('<th class="r">TVA</th>');
    expect(html).toContain('Total (FCFA)');
    expect(html).toContain('TVA non applicable');
  });

  it('devis et proforma : validité, observations, montant en lettres, sans règlement', () => {
    const d = sampleDocData('proforma');
    const html = renderDocHtml(resolveTemplate({}, 'quote', 'a4', 'proforma'), d);
    expect(html).toContain('Facture proforma PF-DLA1-00012');
    expect(html).toContain("Valable jusqu'au");
    expect(html).toContain('Livraison possible à Bonabéri.');
    expect(html).toContain('Bon pour accord, le client');
    expect(html).not.toContain('Espèces');
    expect(() => normalizeTemplate({ id: 'tpl-q', name: 'Devis', doc: 'quote', variant: 'cash' })).not.toThrow();
    expect(normalizeTemplate({ id: 'tpl-q', name: 'Devis', doc: 'quote', variant: 'cash' }).variant).toBe('quote');
  });

  it('bon de livraison : quantités sans prix ni total, zones « Livré par » et « Reçu par »', () => {
    const d = sampleDocData('delivery');
    const html = renderDocHtml(resolveTemplate({}, 'delivery', 'a4', 'delivery'), d);
    expect(html).toContain('<th>N°</th><th>Code</th><th>Désignation</th><th class="r">Qté</th><th>Unité</th>');
    expect(html).not.toContain('Total TTC');
    expect(html).toContain('Reçu par');
    const text = receiptToText(renderDocTicket(resolveTemplate({}, 'delivery', 'ticket', 'delivery'), d), 32);
    expect(text).toContain('BON DE LIVRAISON');
    expect(text).toContain('Qté : 2 CASIER');
    expect(text).not.toContain('TOTAL');
  });

  it('ticket à terme : titre, compte du client, reste à payer et duplicata', () => {
    const d = sampleDocData('credit');
    d.doc.duplicate = true;
    const text = receiptToText(renderDocTicket(builtin('invoice-ticket-credit'), d), 48);
    expect(text).toContain('FACTURE À TERME');
    expect(text).toContain('DUPLICATA');
    expect(text).toContain('N° DLA1-1-000123');
    expect(text).toContain('Compte : C0012');
    expect(text).toMatch(/Reste à payer\s+19 950/);
    expect(text).toContain('Le client :');
    // Le même modèle en aperçu HTML.
    expect(renderDocHtml(builtin('invoice-ticket-credit'), d)).toContain('size: 80mm auto');
  });
});
