import { describe, expect, it } from 'vitest';
import { type Can, MODULES, bottomTabs, groupsFor, modulesFor, screenFor } from '../src/modules';

/** Droits tels que le serveur les envoie (MobileService.rights). */
const can = (over: Partial<Can>): Can => ({ count: false, cart: false, missed: false, receive: false, exit: false, sell: null, discount: false, tariff: false, manage: null, credit: false, creditOver: false, ...over });
const ids = (c: Can) => modulesFor(c).map((m) => m.id);

describe('navigation selon les droits', () => {
  it('chaque module dépend d’un seul droit du serveur, sans en inventer', () => {
    expect(ids(can({}))).toEqual(['accueil']);
    expect(ids(can({ cart: true }))).toEqual(['accueil', 'vente']);
    expect(ids(can({ count: true }))).toEqual(['accueil', 'inventaires']);
    expect(ids(can({ receive: true }))).toEqual(['accueil', 'reception']);
    expect(ids(can({ exit: true }))).toEqual(['accueil', 'sortie']);
    expect(ids(can({ manage: 'read' }))).toEqual(['accueil', 'ventes', 'clients', 'stock', 'caisses', 'valider', 'equipe']);
    // « Gérer la boutique » (actions sur le PC) : seulement en mode Gestion, comme avant.
    expect(ids(can({ manage: 'full' }))).toContain('gestion');
    expect(ids(can({ manage: 'read' }))).not.toContain('gestion');
  });

  it('les mêmes fonctions qu’avant la refonte restent accessibles', () => {
    // Avant : panier si cart, réception si receive, sortie si exit, espace du gérant si manage, comptage si count.
    const all = can({ count: true, cart: true, receive: true, exit: true, manage: 'full' });
    expect(ids(all).sort()).toEqual(MODULES.map((m) => m.id).sort());
  });

  it('la barre du bas a au plus 4 modules et jamais un module interdit', () => {
    for (const c of [can({ cart: true }), can({ count: true, receive: true, exit: true }), can({ manage: 'full', cart: true, count: true, receive: true, exit: true })]) {
      const mods = modulesFor(c);
      const tabs = bottomTabs(mods, c);
      expect(tabs.length).toBeLessThanOrEqual(4);
      expect(tabs[0]!.id).toBe('accueil');
      for (const t of tabs) expect(mods).toContain(t);
    }
    expect(bottomTabs(modulesFor(can({ manage: 'full', cart: true })), can({ manage: 'full', cart: true })).map((t) => t.id)).toEqual(['accueil', 'ventes', 'stock', 'valider']);
    expect(bottomTabs(modulesFor(can({ count: true, receive: true })), can({ count: true, receive: true })).map((t) => t.id)).toEqual(['accueil', 'inventaires', 'reception']);
  });

  it('le menu Plus ne montre que les catégories qui ont un module autorisé', () => {
    expect(groupsFor(modulesFor(can({ cart: true }))).map((g) => g.id)).toEqual(['ventes']);
    expect(groupsFor(modulesFor(can({ count: true }))).map((g) => g.id)).toEqual(['stock']);
  });

  it('une notification n’ouvre jamais un écran interdit', () => {
    expect(screenFor('valider', modulesFor(can({ cart: true })))).toBe('accueil');
    expect(screenFor('valider', modulesFor(can({ manage: 'read' })))).toBe('valider');
  });
});
