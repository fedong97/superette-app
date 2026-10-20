import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BADGE,
  DEFAULT_STORE_SETTINGS,
  badgeExpiry,
  badgeSize,
  badgesHtml,
  brandCssVars,
  brandPalette,
  contrast,
  inkOn,
  mergeStoreSettings,
  normalizeBadge,
  parseStoreSettings,
  renderDocHtml,
  resolveTemplate,
  sampleDocData,
} from '../src';

describe("couleurs de l'entreprise", () => {
  it('tire les teintes des deux couleurs et garde le texte lisible', () => {
    expect(inkOn('#1f7a5c')).toBe('#ffffff');
    expect(inkOn('#f4d84a')).toBe('#111111');
    const p = brandPalette('#f4d84a', '#ffffff');
    // Une principale très claire : les titres prennent sa version foncée.
    expect(contrast(p.deep, '#ffffff')).toBeGreaterThanOrEqual(7);
    expect(brandPalette(null, null).brand).toBe('#1f7a5c');
    expect(brandCssVars('#C62828', '#F2994A')).toMatchObject({ '--brand': '#c62828', '--brand2': '#f2994a', '--brand-ink': '#ffffff' });
  });

  it('valide les couleurs et le badge dans les paramètres du magasin', () => {
    const s = mergeStoreSettings(null, { brandColor: '#C62828', badge: { ...DEFAULT_BADGE, model: 'arc', width: 300 } as never });
    expect(s.brandColor).toBe('#c62828');
    expect(s.brandColor2).toBe(DEFAULT_STORE_SETTINGS.brandColor2);
    expect(s.badge).toMatchObject({ model: 'arc', width: 150 });
    expect(() => mergeStoreSettings(null, { brandColor: 'rouge' })).toThrow(/Couleur/);
    // Paramètres enregistrés avant 0.74 : le badge et les couleurs par défaut.
    expect(parseStoreSettings('{"rccm":"X"}')).toMatchObject({ brandColor: '#1f7a5c', badge: DEFAULT_BADGE });
  });

  it('teinte les en-têtes de tableau des documents A4', () => {
    const t = resolveTemplate({}, 'invoice', 'a4', 'cash');
    const d = sampleDocData('cash');
    expect(renderDocHtml(t, d)).toContain('#e8eef7');
    const html = renderDocHtml(t, { ...d, store: { ...d.store, color: '#c62828' } });
    expect(html).not.toContain('#e8eef7');
    expect(html).toContain('#f7e1e1');
  });
});

describe('badge du personnel', () => {
  const card = {
    store: 'Superette Akwa',
    name: 'Thomas MBARGA',
    role: 'Caissier',
    position: 'Caisse principale',
    number: 'COL-0012',
    phone: '6 99 12 34 56',
    hiredOn: '2024-03-01',
    code: 'FX12345678',
    photo: 'data:image/jpeg;base64,AAAA',
    expires: '2027-10-20',
    color: '#c62828',
    color2: '#f2994a',
  };

  it('imprime le modèle par défaut : rôle, photo, matricule, nom, poste, expiration, code-barres et bandeau', () => {
    const html = badgesHtml([card], DEFAULT_BADGE);
    for (const t of ['Caissier', 'data:image/jpeg;base64,AAAA', 'COL-0012', 'Thomas MBARGA', 'Caisse principale', 'Exp. : 20/10/2027', '<svg', 'bdg-band', '#c62828'])
      expect(html).toContain(t);
    expect(html).not.toContain('Conditions');
    expect(badgeSize(DEFAULT_BADGE)).toEqual({ width: 85.6, height: 54 });
  });

  it('suit les réglages : format, sens, éléments masqués, modèles et verso', () => {
    const vertical = normalizeBadge({ size: 'custom', width: 60, height: 90, portrait: true, showPhoto: false, showPhone: false });
    expect(badgeSize(vertical)).toEqual({ width: 60, height: 90 });
    const html = badgesHtml([card], vertical);
    expect(html).not.toContain('base64,AAAA');
    expect(html).not.toContain('6 99 12 34 56');

    for (const model of ['arc', 'angles'] as const) {
      const l = normalizeBadge({ model, back: true, backText: 'Règle 1\nRègle 2', signature: 'Le Gérant' });
      expect(badgeSize(l)).toEqual({ width: 54, height: 85.6 });
      const h = badgesHtml([card], l);
      expect(h).toContain(`bdg-${model}`);
      expect(h).toContain('<li>Règle 1</li>');
      expect(h).toContain('Entré le :</span> <b>01/03/2024</b>');
      expect(h).toContain('Le Gérant');
    }
    // Sans photo, les initiales ; sans logo, le nom du magasin quand même.
    const noPhoto = badgesHtml([{ ...card, photo: null }], { ...DEFAULT_BADGE, showStore: false });
    expect(noPhoto).toContain('<span>TM</span>');
    expect(noPhoto).toContain('Superette Akwa');
  });

  it("compte l'expiration à partir du jour de l'impression", () => {
    expect(badgeExpiry(new Date(2026, 9, 20), 12)).toBe('2027-10-20');
    expect(badgeExpiry(new Date(2026, 0, 31), 1)).toBe('2026-03-03');
  });
});
