import { describe, expect, it } from 'vitest';
import { roleRights } from '@superette/core/src/permissions';
import { type Can, MODULES, bottomTabs, groupsFor, modulesFor, quickActions, screenFor } from '../src/modules';

/** Droits tels que le serveur les envoie (MobileService.rights). */
const can = (over: Partial<Can>): Can => ({ count: false, cart: false, missed: false, receive: false, exit: false, sell: null, discount: false, tariff: false, manage: null, credit: false, creditOver: false, ...over });
const ids = (c: Can, pc: readonly string[] | null = null) => modulesFor({ can: c, pc }).map((m) => m.id);
const PHONE = ['accueil', 'ventes', 'stock', 'valider', 'caisses', 'clients', 'equipe', 'vente', 'inventaires', 'reception', 'sortie'];

describe('navigation selon les droits', () => {
  it('chaque écran du téléphone dépend d’un droit envoyé par le serveur', () => {
    expect(ids(can({}))).toEqual(['accueil']);
    expect(ids(can({ cart: true }))).toEqual(['accueil', 'vente']);
    expect(ids(can({ count: true }))).toEqual(['accueil', 'inventaires']);
    expect(ids(can({ receive: true }))).toEqual(['accueil', 'reception']);
    expect(ids(can({ exit: true }))).toEqual(['accueil', 'sortie']);
    expect(ids(can({ manage: 'read' }))).toEqual(['accueil', 'ventes', 'caisses', 'stock', 'valider', 'clients', 'equipe']);
  });

  it('les écrans du PC suivent les droits du PC, et seulement en mode Gestion', () => {
    const manager = roleRights('manager', null);
    const full = ids(can({ manage: 'full' }), manager);
    expect(full).toContain('pc:treasury');
    expect(full).toContain('pc:customers');
    expect(full).not.toContain('gestion');
    // Consultation seule : aucun écran du PC, même avec les droits du PC.
    expect(ids(can({ manage: 'read' }), manager).some((id) => id.startsWith('pc:'))).toBe(false);
    // Un comptable : la comptabilité, pas l'administration.
    const accountant = ids(can({ manage: 'full' }), roleRights('accountant', null));
    expect(accountant).toContain('pc:accounting');
    expect(accountant).not.toContain('pc:admin');
    // Droits du PC inconnus (ancien serveur) : le menu complet du PC, comme avant.
    expect(ids(can({ manage: 'full' }), null)).toContain('gestion');
  });

  it('toutes les fonctions d’avant restent accessibles', () => {
    const all = ids(can({ count: true, cart: true, receive: true, exit: true, manage: 'full' }), roleRights('admin', null));
    for (const id of PHONE) expect(all).toContain(id);
    expect(all.filter((id) => id.startsWith('pc:')).length).toBe(12);
    expect(MODULES.filter((m) => m.pc).length).toBe(13);
  });

  it('la barre du bas a au plus 4 écrans du téléphone et jamais un module interdit', () => {
    for (const c of [can({ cart: true }), can({ count: true, receive: true, exit: true }), can({ manage: 'full', cart: true, count: true, receive: true, exit: true })]) {
      const mods = modulesFor({ can: c, pc: roleRights('manager', null) });
      const tabs = bottomTabs(mods, c);
      expect(tabs.length).toBeLessThanOrEqual(4);
      expect(tabs[0]!.id).toBe('accueil');
      for (const t of tabs) expect(mods).toContain(t);
      for (const q of quickActions(mods)) expect(mods.map((m) => m.id)).toContain(q.id);
    }
    const mgr = can({ manage: 'full', cart: true });
    expect(bottomTabs(modulesFor({ can: mgr, pc: null }), mgr).map((t) => t.id)).toEqual(['accueil', 'ventes', 'stock', 'valider']);
    const keeper = can({ count: true, receive: true });
    expect(bottomTabs(modulesFor({ can: keeper, pc: null }), keeper).map((t) => t.id)).toEqual(['accueil', 'inventaires', 'reception']);
  });

  it('le menu ne montre que les catégories qui ont un module autorisé', () => {
    expect(groupsFor(modulesFor({ can: can({ cart: true }), pc: null })).map((g) => g.id)).toEqual(['pilotage', 'terrain']);
    expect(groupsFor(modulesFor({ can: can({ count: true }), pc: null })).map((g) => g.id)).toEqual(['pilotage', 'terrain']);
  });

  it('une notification n’ouvre jamais un écran interdit', () => {
    expect(screenFor('valider', modulesFor({ can: can({ cart: true }), pc: null }))).toBe('accueil');
    expect(screenFor('valider', modulesFor({ can: can({ manage: 'read' }), pc: null }))).toBe('valider');
  });
});
