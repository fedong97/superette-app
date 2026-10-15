import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { StatusController } from '../src/status.controller';

describe("page d'accueil du serveur", () => {
  it('affiche le nom et le logo du serveur', () => {
    const html = new StatusController().home();
    expect(html).toContain('FEDONIX 360 Serveur');
    expect(html).toContain('data:image/png;base64,');
  });

  it("sert l'icône du serveur", () => {
    expect(new StatusController().favicon().length).toBeGreaterThan(0);
  });
});
