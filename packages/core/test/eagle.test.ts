import { describe, expect, it } from 'vitest';
import { EAGLE_MOODS, eagleHeadDoc, eagleIconDoc, eagleMascotDoc, eagleMascotSvg } from '../src/eagle';

describe('aigle ONIX', () => {
  it('dessine les six humeurs, chacune différente', () => {
    const docs = EAGLE_MOODS.map((m) => eagleMascotDoc(m));
    expect(new Set(docs.map((d) => d.replace(/aigle\d+/g, ''))).size).toBe(6);
    for (const d of docs) expect(d).toMatch(/^<svg [^>]*viewBox="0 0 200 230">/);
  });

  it('donne des dégradés uniques à chaque mascotte affichée', () => {
    const ids = (s: string) => [...s.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
    const a = ids(eagleMascotSvg('veille'));
    const b = ids(eagleMascotSvg('veille'));
    expect(a.some((x) => b.includes(x))).toBe(false);
  });

  it('distingue l’icône du serveur de celle du logiciel', () => {
    expect(eagleIconDoc('app')).not.toBe(eagleIconDoc('server'));
    expect(eagleIconDoc('server', 64)).toContain('width="64"');
    expect(eagleHeadDoc({ mono: true })).not.toMatch(/#1f7a5c|#f2b705/);
  });
});
