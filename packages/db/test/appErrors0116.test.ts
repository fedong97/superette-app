import { describe, expect, it } from 'vitest';
import { createServices, openDatabase, scrubError } from '../src';

describe('erreurs du logiciel', () => {
  it('masque ce qui pourrait désigner une personne ou une donnée', () => {
    expect(scrubError('ENOENT C:\\Users\\Mballa\\AppData\\x.db 699123456 steve@ex.cm')).toBe('ENOENT C:\\Users\\…\\AppData\\x.db ######### …@…');
  });

  it('regroupe la même erreur du jour, puis la marque envoyée', () => {
    let now = new Date('2026-11-06T10:00:00Z');
    const s = createServices(openDatabase(':memory:'), () => now);
    const boom = new TypeError("Cannot read properties of undefined (reading 'qty')");
    for (let i = 0; i < 3; i++) s.appErrors.record({ source: 'action', message: boom.message, stack: boom.stack, where: 'pos.completeSale', version: '0.116.0' });
    expect(s.appErrors.list()).toHaveLength(1);
    expect(s.appErrors.list()[0]).toMatchObject({ count: 3, where_at: 'pos.completeSale', sent_at: null });
    const out = s.appErrors.unsent();
    s.appErrors.markSent(out);
    expect(s.appErrors.unsent()).toHaveLength(0);
    now = new Date('2026-11-06T11:00:00Z');
    s.appErrors.record({ source: 'action', message: boom.message, stack: boom.stack, where: 'pos.completeSale', version: '0.116.0' });
    expect(s.appErrors.unsent()[0]).toMatchObject({ count: 4 });
    now = new Date('2026-11-07T09:00:00Z');
    s.appErrors.record({ source: 'action', message: boom.message, stack: boom.stack, version: '0.116.0' });
    expect(s.appErrors.list()).toHaveLength(2);
  });
});
