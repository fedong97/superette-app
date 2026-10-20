import { describe, expect, it } from 'vitest';
import { displayAscii, vfdFrame, vfdLines } from '../src';

describe('afficheur client à deux lignes', () => {
  it('écrit les lignes en ASCII, à la largeur de l’afficheur', () => {
    expect(displayAscii('Crème fraîche – 1 500 F')).toBe('Creme fraiche  1 500 F');
    expect(vfdLines({ kind: 'idle' }, 20, 'Bienvenue chez Akwa')).toEqual(['Bienvenue chez Akwa ', ' '.repeat(20)]);
    expect(vfdLines({ kind: 'idle' }, 20, 'Bienvenue')[0]).toBe('     Bienvenue      ');
    const [top, bottom] = vfdLines({ kind: 'cart', last: { name: 'Lait concentré sucré Nestlé', qty: '2', amount: 1500 }, lines: [], total: 12_350, savings: 0 });
    expect(top).toHaveLength(20);
    expect(top).toMatch(/^Lait concentr.* 1 500$/);
    expect(bottom).toBe('TOTAL         12 350');
    expect(vfdLines({ kind: 'paid', total: 12_350, paid: 15_000, change: 2_650 }, 16)).toEqual(['PAYE      15 000', 'MONNAIE    2 650']);
  });

  it('trame ESC/POS : initialise, efface, ligne 1, curseur en ligne 2, ligne 2', () => {
    const frame = vfdFrame(['AB', 'CD']);
    expect([...frame]).toEqual([0x1b, 0x40, 0x0c, 65, 66, 0x1f, 0x24, 1, 2, 67, 68]);
  });
});
