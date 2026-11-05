import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Contre-expertise de l'audit (0.113.0) : une saisie refusée par le serveur ne disparaît plus du
 * téléphone, un relevé refusé ne bloque plus les envois, et un envoi répété garde son identifiant.
 */
vi.mock('@capacitor/push-notifications', () => ({ PushNotifications: {} }));
vi.mock('../src/device', () => ({ native: false, FirebaseSetup: {} }));

type Reply = { status: number; body: unknown };
let calls: { path: string; body: Record<string, unknown> | null }[] = [];
let replies: Record<string, (body: Record<string, unknown> | null) => Reply> = {};
const memory = new Map<string, string>();

beforeEach(() => {
  vi.resetModules();
  calls = [];
  replies = {};
  memory.clear();
  // Mémoire du téléphone : sans IndexedDB, le stockage passe par localStorage.
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => memory.get(k) ?? null,
    setItem: (k: string, v: string) => void memory.set(k, v),
    removeItem: (k: string) => void memory.delete(k),
  });
  vi.stubGlobal('window', { addEventListener: () => undefined });
  vi.stubGlobal('document', { addEventListener: () => undefined, visibilityState: 'visible' });
  vi.stubGlobal('fetch', async (url: string, init: { body?: string }) => {
    const path = new URL(url).pathname;
    const body = init.body ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    calls.push({ path, body });
    const r = replies[path]?.(body) ?? { status: 200, body: { inventories: [], catalogVersion: 'v1', showExpected: false, user: { id: 'u1', name: 'Awa', role: 'stock' } } };
    return { ok: r.status < 400, status: r.status, text: async () => JSON.stringify(r.body) };
  });
  memory.set('fedonix-inventaire.config', JSON.stringify({ urls: ['http://serveur'], url: 'http://serveur', token: 't', storeId: 's1', storeName: 'Akwa', deviceName: 'Tel 1' }));
  memory.set('fedonix-inventaire.session', JSON.stringify({ token: 'sess', user: { id: 'u1', name: 'Awa', role: 'stock' }, can: { count: true, cart: true } }));
  memory.set('fedonix-inventaire.catalog', JSON.stringify({ version: 'v1', articles: [] }));
});

afterEach(() => vi.unstubAllGlobals());

const start = async () => {
  const S = await import('../src/state');
  await S.init();
  // Le premier échange lancé au démarrage est terminé avant la suite du test.
  await S.sync();
  return S;
};

describe('saisies refusées par le serveur', () => {
  it('un comptage refusé passe dans « Saisies à vérifier » avec son motif, et y reste après un redémarrage', async () => {
    replies['/api/v1/mobile/counts'] = (b) => ({ status: 200, body: { accepted: [], rejected: (b!['counts'] as { id: string }[]).map((c) => ({ id: c.id, reason: 'Inventaire clôturé' })) } });
    const S = await start();
    S.record('inv-1', 'art-1', 3_000, null);
    expect(S.getState().pending).toBe(1);
    await S.sync();
    expect(S.getState().pending).toBe(0);
    expect(S.getState().rejected).toHaveLength(1);
    expect(S.getState().rejected[0]).toMatchObject({ kind: 'comptage', reason: 'Inventaire clôturé' });
    expect(S.rejectedText()).toContain('Inventaire clôturé');
    // Redémarrage de l'application : la liste est toujours là.
    const again = await start();
    expect(again.getState().rejected).toHaveLength(1);
    await again.dropRejected(again.getState().rejected[0]!.id);
    expect(again.getState().rejected).toEqual([]);
  });

  it("les saisies d'un utilisateur dont la session n'existe plus sont gardées à vérifier", async () => {
    replies['/api/v1/mobile/counts'] = () => ({ status: 401, body: { message: 'Connectez-vous' } });
    const S = await start();
    S.record('inv-1', 'art-1', 2_000, null);
    // Session terminée côté serveur : la personne doit se reconnecter, la saisie reste en file.
    await S.sync();
    expect(S.getState().session).toBeNull();
    expect(S.getState().pending).toBe(1);
    // Au passage suivant, la saisie de l'ancienne session ne partira jamais : elle est gardée à vérifier.
    await S.sync();
    expect(S.getState().pending).toBe(0);
    expect(S.getState().rejected).toHaveLength(1);
    expect(S.getState().rejected[0]!.reason).toMatch(/déconnecté/);
  });

  it('un relevé de produit inconnu refusé ne bloque plus la mise à jour des inventaires', async () => {
    replies['/api/v1/mobile/unknowns'] = () => ({ status: 400, body: { message: 'Photo trop lourde' } });
    const S = await start();
    await S.addUnknown({ inventoryId: 'inv-1', code: '123', note: 'Biscuit', qty: 1000, photo: null });
    await S.sync();
    expect(S.getState().pending).toBe(0);
    expect(S.getState().rejected[0]).toMatchObject({ kind: 'relevé', reason: 'Photo trop lourde' });
    expect(calls.some((c) => c.path === '/api/v1/mobile/inventories')).toBe(true);
  });

  it('hors ligne, rien ne part dans « Saisies à vérifier » : tout reste en file', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('Failed to fetch');
    });
    const S = await start();
    S.record('inv-1', 'art-1', 2_000, null);
    await S.sync();
    expect(S.getState().pending).toBe(1);
    expect(S.getState().rejected).toEqual([]);
  });
});

describe('envoi répété après une réponse perdue', () => {
  it('le panier repart avec le même identifiant, le panier suivant avec un nouveau', async () => {
    let lost = true;
    replies['/api/v1/mobile/carts'] = () => (lost ? { status: 504, body: { message: 'Délai dépassé' } } : { status: 200, body: { id: 'x', number: 7, total: 1000 } });
    const S = await start();
    S.addToCart('art-1', 1000);
    await expect(S.sendCart()).rejects.toThrow();
    lost = false;
    await S.sendCart();
    const sent = calls.filter((c) => c.path === '/api/v1/mobile/carts' && c.body).map((c) => c.body!['id']);
    expect(sent).toHaveLength(2);
    expect(sent[0]).toBe(sent[1]);
    S.addToCart('art-1', 1000);
    await S.sendCart();
    const next = calls.filter((c) => c.path === '/api/v1/mobile/carts' && c.body).map((c) => c.body!['id']);
    expect(next[2]).not.toBe(sent[0]);
  });

  it('le contrôle de sortie et la vente manquée gardent leur identifiant au nouvel essai', async () => {
    let fail = true;
    for (const p of ['/api/v1/mobile/exit', '/api/v1/mobile/missed']) replies[p] = () => (fail ? { status: 502, body: {} } : { status: 200, body: { id: 'ok' } });
    const S = await start();
    const ticket = { saleId: 'sale-1', number: 'T12' } as never;
    await expect(S.exitRecord(ticket, 'ok')).rejects.toThrow();
    await expect(S.recordMissed({ articleId: null, label: 'Lait', qty: 1, reason: 'absent' })).rejects.toThrow();
    fail = false;
    await S.exitRecord(ticket, 'ok');
    await S.recordMissed({ articleId: null, label: 'Lait', qty: 1, reason: 'absent' });
    const ids = (p: string) => calls.filter((c) => c.path === p).map((c) => c.body!['id']);
    expect(new Set(ids('/api/v1/mobile/exit')).size).toBe(1);
    expect(new Set(ids('/api/v1/mobile/missed')).size).toBe(1);
  });
});
