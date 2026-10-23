import { describe, expect, it } from 'vitest';
import { MASCOT_MOODS, iconDoc, logoDoc, mascotDoc, mascotSvg } from '../src/mascot';

describe('logo et mascottes ONIX', () => {
  it('dessine les six humeurs d’Awa et de Paul, chacune différente', () => {
    for (const who of ['awa', 'paul'] as const) {
      const docs = MASCOT_MOODS.map((m) => mascotDoc(m, { who }));
      expect(new Set(docs.map((d) => d.replace(/perso\d+/g, ''))).size).toBe(6);
      for (const d of docs) expect(d).toMatch(/^<svg [^>]*viewBox="0 0 200 230">/);
    }
    expect(mascotDoc('veille', { who: 'awa' }).replace(/perso\d+/g, '')).not.toBe(mascotDoc('veille', { who: 'paul' }).replace(/perso\d+/g, ''));
  });

  it('donne des identifiants uniques à chaque dessin affiché', () => {
    const ids = (s: string) => [...s.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
    const a = ids(mascotSvg('bonjour'));
    const b = ids(mascotSvg('bonjour'));
    expect(a.length).toBeGreaterThan(0);
    expect(a.some((x) => b.includes(x))).toBe(false);
    expect(ids(logoDoc()).some((x) => ids(logoDoc()).includes(x))).toBe(false);
  });

  it('distingue l’icône du serveur de celle du logiciel', () => {
    expect(iconDoc('app')).not.toBe(iconDoc('server'));
    expect(iconDoc('server', 64)).toContain('width="64"');
    expect(logoDoc({ mono: true })).not.toMatch(/#1f7a5c|#f2b705|#2e9c74|url\(/);
  });
});
