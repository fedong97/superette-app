import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LICENSE_PUBLIC_KEY as APP_KEY } from '@superette/db';
import { describe, expect, it } from 'vitest';
import { LICENSE_PUBLIC_KEY as SERVER_KEY, readLicense } from '../src/license';

describe('clé publique des licences', () => {
  it("est la même dans l'application, le serveur central et le générateur", () => {
    expect(SERVER_KEY).toBe(APP_KEY);
    expect(readFileSync(join(__dirname, '../../../tools/generateur-licences.html'), 'utf8')).toContain(APP_KEY);
  });

  it('refuse une clé qui n’est pas une licence', () => {
    expect(readLicense('SG1.abc.def')).toBeNull();
    expect(readLicense('bonjour')).toBeNull();
  });
});
