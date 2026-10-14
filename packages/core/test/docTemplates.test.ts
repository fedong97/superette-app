import { describe, expect, it } from 'vitest';
import {
  BUILTIN_TEMPLATES,
  effectiveTemplates,
  mergeStoreSettings,
  docSections,
  normalizeTemplate,
  parcelCount,
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
    // Plus les dispositions encadrée et détaillée du ticket et le listing sans logo, comptant et à terme.
    expect(slots.length).toBe(27);
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

  it('réimpression : filigrane DUPLICATA, sauf si le modèle ne l’affiche pas', () => {
    const d = sampleDocData('cash');
    expect(renderDocHtml(builtin('invoice-a4-cash'), d)).not.toContain('class="wm"');
    d.doc.duplicate = true;
    for (const id of ['invoice-a4-cash', 'invoice-listing-cash', 'invoice-ticket-cash']) expect(renderDocHtml(builtin(id), d)).toContain('<div class="wm">DUPLICATA</div>');
    const off = { ...builtin('invoice-a4-cash'), footer: { ...builtin('invoice-a4-cash').footer, duplicate: false } };
    expect(renderDocHtml(off, d)).not.toContain('DUPLICATA');
  });

  it('marges gauche et droite, largeur imprimée, interlignes et ordre des sections', () => {
    const base = builtin('invoice-ticket-cash');
    const t = normalizeTemplate({
      ...base,
      page: { ...base.page, marginLeft: 1, marginRight: 6, printWidth: 70, lineSpacing: 150, sectionGap: 3 },
      sections: [{ key: 'footer', space: 5 }, { key: 'lines', space: 0 }],
    });
    expect(docSections(t).map((x) => x.key)).toEqual(['footer', 'lines', 'header', 'title', 'totals', 'payments']);
    const html = renderDocHtml(t, sampleDocData('cash'));
    expect(html).toContain('size: 70mm auto');
    expect(html).toContain('padding: 0 6mm 0 1mm');
    expect(html).toContain('font: 11px/2.02');
    // Ticket ESC/POS : interligne en tête, puis le pied d'abord (5 mm au-dessus), et 3 mm entre les sections.
    const r = renderDocTicket(t, sampleDocData('cash'));
    expect(r[0]).toEqual({ t: 'spacing', pct: 150 });
    expect(r[1]).toEqual({ t: 'space', mm: 5 });
    expect(r.filter((l) => l.t === 'space').map((l) => (l as { mm: number }).mm)).toEqual([5, 3, 3, 3, 3, 3]);
    const a4 = renderDocHtml({ ...builtin('invoice-a4-cash'), sections: [{ key: 'totals', space: 0 }] }, sampleDocData('cash'));
    expect(a4.indexOf('sec-totals')).toBeLessThan(a4.indexOf('sec-header'));
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
    expect(text).toContain('D U P L I C A T A');
    expect(text).toContain('N° DLA1-1-000123');
    expect(text).toContain('Compte : C0012');
    expect(text).toMatch(/Reste à payer\s+19 950/);
    expect(text).toContain('Le client :');
    // Le même modèle en aperçu HTML.
    // Rouleau de 80 mm : la tête n'imprime que sur 72 mm, la page s'y tient.
    expect(renderDocHtml(builtin('invoice-ticket-credit'), d)).toContain('size: 72mm auto');
  });

  it('facture listing (F7) : encadrée, papier continu, cases DATE / CLIENT, montant en lettres, nombre de colis, net à payer', () => {
    const t = builtin('invoice-listing-cash');
    expect(t.page).toMatchObject({ paper: 'listing', style: 'framed' });
    const d = sampleDocData('credit');
    const html = renderDocHtml(t, { ...d, doc: { ...d.doc, warehouse: 'Surface de vente' } });
    for (const s of ['class="frame"', 'DATE', 'CLIENT', 'MAG. DE LIVR. : SURFACE DE VENTE', 'MONTANT EN LETTRES', 'NB COLIS', 'NET À PAYER', 'Merci de votre fidélité', 'FACTURÉ PAR : AWA', 'size: 240mm auto'])
      expect(html).toContain(s);
    expect(parcelCount([{ qty: '2' }, { qty: '3' }, { qty: '1,250 kg' }] as never)).toBe(6);
    // Un ancien modèle enregistré sans présentation reste « simple ».
    expect(normalizeTemplate({ id: 'x', name: 'Ancien', doc: 'invoice', format: 'a4', variant: 'cash' }).page.style).toBe('plain');
  });

  it('écran de caisse : moderne par défaut, seulement les trois présentations', () => {
    expect(mergeStoreSettings(null, {}).posLayout).toBe('modern');
    expect(mergeStoreSettings(null, { posLayout: 'classic' }).posLayout).toBe('classic');
    expect(() => mergeStoreSettings(null, { posLayout: 'autre' as never })).toThrow('écran de caisse');
  });

  it('ticket encadré, ticket détaillé et listing sans logo : la partie TVA disparaît pour un magasin sans TVA', () => {
    const d = sampleDocData('cash');
    const noVat = { ...d, store: { ...d.store, vatEnabled: false }, lines: d.lines.map((l) => ({ ...l, vatRate: 0 })) };
    const boxed = builtin('invoice-ticket-cash-boxed');
    expect(renderDocHtml(boxed, d)).toContain('TVA');
    expect(renderDocHtml(boxed, noVat)).not.toContain('TVA');
    expect(receiptToText(renderDocTicket(boxed, noVat), 42)).not.toContain('TVA');
    const detailed = builtin('invoice-ticket-cash-detailed');
    const html = renderDocHtml(detailed, d);
    for (const s of ['CODE', 'TOTAL HT', 'NB COLIS', 'MONTANT TTC']) expect(html).toContain(s);
    const plainHtml = renderDocHtml(detailed, noVat);
    expect(plainHtml).not.toContain('TVA');
    expect(plainHtml).not.toContain('TOTAL HT');
    // Partie TVA décochée : rien sur la TVA, même avec TVA.
    expect(renderDocHtml({ ...detailed, totals: { ...detailed.totals, ht: false, vatDetail: false } }, d)).not.toContain('TVA');
    const side = renderDocHtml(builtin('invoice-listing-cash-side'), d);
    for (const s of ['class="fside"', 'LE GESTIONNAIRE', 'LE CHAUFFEUR', 'LE CONTRÔLEUR', 'LE CLIENT']) expect(side).toContain(s);
  });
});
