import { AUDIT_THEMES, AUDIT_WATCH_ACTIONS, describeAudit } from '@superette/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { type Services, createServices, openDatabase } from '../src';

/** Journal d'audit en clair (0.114.0) : thèmes, connexions masquées, nom de la caisse. */
let s: Services;
let ids: { store: string; register: string; admin: string; riz: string };

beforeEach(() => {
  s = createServices(openDatabase(':memory:'));
  const { store, register, admin } = s.admin.bootstrap({ storeCode: 'DLA1', storeName: 'Superette Akwa', adminName: 'Steve', adminLogin: 'steve', adminPin: '1234' });
  const tva = s.admin.listVatRates()[0]!.id;
  const riz = s.catalogue.saveArticle(admin.id, { name: 'Riz 5 kg', unit: 'piece', vatRateId: tva, purchasePrice: 3_000, salePrice: 5_000 }).id;
  ids = { store: store.id, register: register.id, admin: admin.id, riz };
  s.admin.login('steve', '1234');
  expect(() => s.admin.login('steve', '0000')).toThrow();
  s.catalogue.setStorePrice(admin.id, riz, store.id, 5_500);
  s.pos.openSession({ storeId: store.id, registerId: register.id, userId: admin.id }, 10_000);
});

const actions = (f: Parameters<Services['admin']['auditSearch']>[0]) => s.admin.auditSearch(f).map((a) => a.action);

describe('journal par thème', () => {
  it('le thème « Caisse et argent » ne montre que la caisse', () => {
    expect(actions({ patterns: AUDIT_THEMES.cash.patterns })).toEqual(['cash.open']);
  });

  it('« Prix et articles » réunit la création et le prix', () => {
    expect(actions({ patterns: AUDIT_THEMES.prices.patterns }).sort()).toEqual(['article.create', 'price.store']);
  });

  it('« À surveiller » garde le prix changé et le code faux, pas la connexion', () => {
    const got = actions({ patterns: AUDIT_WATCH_ACTIONS });
    expect(got).toEqual(expect.arrayContaining(['price.store', 'auth.failed']));
    expect(got).not.toContain('auth.login');
  });

  it('masquer les connexions garde les codes faux', () => {
    const got = actions({ hideLogins: true });
    expect(got).not.toContain('auth.login');
    expect(got).toContain('auth.failed');
    expect(actions({})).toContain('auth.login');
  });

  it('chercher « prix » trouve le changement de prix par son nom en français', () => {
    expect(actions({ text: 'prix', textActions: ['price.store'] })).toContain('price.store');
    expect(actions({ text: 'prix' })).not.toContain('price.store');
  });
});

describe('nom de la caisse', () => {
  it("l'ouverture dit quelle caisse a été ouverte", () => {
    const open = s.admin.auditSearch({ patterns: ['cash.open'] })[0]!;
    const register = s.db.prepare('SELECT name FROM registers WHERE id = ?').pluck().get(ids.register) as string;
    expect(open.entity_name).toBe(register);
    expect(describeAudit(open).text.replace(/ /g, ' ')).toBe(`Steve a ouvert la caisse « ${register} » avec un fond de caisse de 10 000 FCFA.`);
  });
});
