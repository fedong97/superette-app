import { describe, expect, it } from 'vitest';
import { RemotePcService } from '../src/remotePc.service';

const pc = { id: 'pc1', store_id: 'S1' };

describe('relais du PC sur le téléphone', () => {
  it('refuse tout de suite quand aucun PC du magasin n’attend', () => {
    const r = new RemotePcService();
    expect(() => r.call('S1', 'u1', 'customers.list', [])).toThrow(/Aucun PC du magasin/);
  });

  it('passe l’appel au PC qui attend et rend sa réponse au téléphone', async () => {
    const r = new RemotePcService();
    const waiting = r.next(pc, 5_000);
    expect(r.online('S1')).toBe(1);
    const answer = r.call('S1', 'u1', 'customers.list', ['a']);
    const { calls } = await waiting;
    expect(calls).toEqual([expect.objectContaining({ userId: 'u1', name: 'customers.list', args: ['a'] })]);
    // Un autre PC (ou un autre magasin) ne peut pas répondre à sa place.
    expect(r.reply({ id: 'pc2', store_id: 'S1' }, calls[0]!.id, { ok: true, data: 1 })).toEqual({ ok: false });
    expect(r.reply(pc, calls[0]!.id, { ok: true, data: [{ name: 'JEAN' }] })).toEqual({ ok: true });
    await expect(answer).resolves.toEqual({ ok: true, data: [{ name: 'JEAN' }] });
  });

  it('garde l’appel jusqu’au retour du PC, puis transmet l’erreur telle quelle', async () => {
    const r = new RemotePcService();
    await r.next(pc, 1_000); // le PC est passé : il est en ligne
    const answer = r.call('S1', 'u1', 'admin.createUser', []);
    const { calls } = await r.next(pc, 5_000);
    r.reply(pc, calls[0]!.id, { ok: false, error: { message: "Vous n'avez pas les droits", code: 'FORBIDDEN' } });
    await expect(answer).resolves.toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(() => r.call('S1', 'u1', 'pas une action', [])).toThrow('Action inconnue');
  });
});
