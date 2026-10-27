import { describe, expect, it } from 'vitest';
import { DEFAULT_STORE_SETTINGS, mergeStoreSettings } from '../src/storeSettings';

describe('mode « Caisse seule » par rôle (0.91.0)', () => {
  it('aucun rôle par défaut : l’affichage habituel ne change pas', () => {
    expect(DEFAULT_STORE_SETTINGS.posFullRoles).toBe('');
  });

  it('garde les rôles qui vendent, sans double, dans le même ordre', () => {
    expect(mergeStoreSettings(null, { posFullRoles: 'seller,cashier,seller' }).posFullRoles).toBe('cashier,seller');
    expect(mergeStoreSettings(null, { posFullRoles: 'admin, stock ,manager,inconnu' }).posFullRoles).toBe('manager,admin');
    expect(mergeStoreSettings(null, { posFullRoles: '' }).posFullRoles).toBe('');
  });
});
