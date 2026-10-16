import { beforeEach, describe, expect, it } from 'vitest';
import { type Context, MobilePayService, type Services, createServices, openDatabase, payerNumber } from '../src';

type Call = { url: string; init: RequestInit };

/** Faux MTN MoMo (sandbox) : crée l'accès, donne un jeton, accepte la demande puis la dit payée. */
function fakeMtn(calls: Call[], final: Record<string, unknown> = { status: 'SUCCESSFUL', financialTransactionId: '1234567890' }) {
  return (async (url: string | URL | Request, init: RequestInit = {}) => {
    const u = String(url);
    calls.push({ url: u, init });
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    if (u.endsWith('/v1_0/apiuser')) return new Response(null, { status: 201 });
    if (u.endsWith('/apikey')) return json({ apiKey: 'cle-api-de-test-abcd' }, 201);
    if (u.endsWith('/collection/token/')) return json({ access_token: 'jeton', expires_in: 3600 });
    if (u.endsWith('/collection/v1_0/requesttopay')) return new Response(null, { status: 202 });
    if (u.includes('/collection/v1_0/requesttopay/')) return json(final);
    return new Response(null, { status: 404 });
  }) as typeof fetch;
}

describe('paiement mobile automatique', () => {
  let s: Services;
  let ctx: Context;
  let now = new Date('2026-10-16T08:00:00Z');

  beforeEach(() => {
    now = new Date('2026-10-16T08:00:00Z');
    s = createServices(openDatabase(':memory:'), () => now);
    const { store, register, admin } = s.admin.bootstrap({ storeCode: 'DLA1', storeName: 'Superette Akwa', adminName: 'Steve', adminLogin: 'steve', adminPin: '1234' });
    ctx = { storeId: store.id, registerId: register.id, userId: admin.id };
  });

  it('met le numéro du client au format MTN', () => {
    expect(payerNumber('677 00 11 22')).toBe('237677001122');
    expect(payerNumber('+237 6 77 00 11 22')).toBe('237677001122');
    expect(payerNumber('46733123453', true)).toBe('46733123453');
    expect(() => payerNumber('2233')).toThrow(/invalide/);
  });

  it('en simulation, confirme au bout de quelques secondes ou refuse un numéro qui finit par 0', async () => {
    expect(s.mobilePay.enabled()).toEqual([]);
    await expect(s.mobilePay.request(ctx, { method: 'MTN_MOMO', phone: '677001122', amount: 5_000 })).rejects.toThrow(/pas réglé/);
    s.mobilePay.saveConfig(ctx.userId, 'MTN_MOMO', { mode: 'simulation' });
    s.mobilePay.saveConfig(ctx.userId, 'ORANGE_MONEY', { mode: 'simulation' });
    expect(s.mobilePay.enabled()).toEqual(['MTN_MOMO', 'ORANGE_MONEY']);
    const ok = await s.mobilePay.request(ctx, { method: 'MTN_MOMO', phone: '677001122', amount: 5_000 });
    const ko = await s.mobilePay.request(ctx, { method: 'ORANGE_MONEY', phone: '699001120', amount: 2_000 });
    expect((await s.mobilePay.status(ok.id)).status).toBe('pending');
    now = new Date(now.getTime() + 6_000);
    expect(await s.mobilePay.status(ok.id)).toMatchObject({ status: 'success', amount: 5_000 });
    expect((await s.mobilePay.status(ok.id)).transaction_id).toMatch(/^SIM/);
    expect(await s.mobilePay.status(ko.id)).toMatchObject({ status: 'failed', reason: expect.stringContaining('refusé') });
    expect(s.mobilePay.list(ctx.storeId)).toHaveLength(2);
  });

  it('en test MTN, crée l’accès avec la seule clé d’abonnement puis encaisse', async () => {
    const calls: Call[] = [];
    s.mobilePay = new MobilePayService(s.db, () => now, fakeMtn(calls));
    s.mobilePay.saveConfig(ctx.userId, 'MTN_MOMO', { mode: 'sandbox', subscriptionKey: 'abonnement-1234' });
    expect(s.mobilePay.config().MTN_MOMO).toMatchObject({ subscriptionKey: '••••1234', ready: false });
    await s.mobilePay.setupMtnSandbox(ctx.userId);
    const conf = s.mobilePay.config().MTN_MOMO;
    expect(conf).toMatchObject({ mode: 'sandbox', apiKey: '••••abcd', ready: true });
    // Un secret laissé masqué garde sa valeur.
    s.mobilePay.saveConfig(ctx.userId, 'MTN_MOMO', { subscriptionKey: '••••1234', apiKey: '' });
    expect(s.mobilePay.config().MTN_MOMO.ready).toBe(true);

    const p = await s.mobilePay.request(ctx, { method: 'MTN_MOMO', phone: '46733123453', amount: 1_500, label: 'Achat' });
    expect(p).toMatchObject({ status: 'pending', currency: 'EUR', phone: '46733123453', provider_ref: p.id });
    const req = calls.find((c) => c.url.endsWith('/requesttopay'))!;
    const headers = req.init.headers as Record<string, string>;
    expect(headers).toMatchObject({ 'X-Target-Environment': 'sandbox', 'X-Reference-Id': p.id, Authorization: 'Bearer jeton', 'Ocp-Apim-Subscription-Key': 'abonnement-1234' });
    expect(JSON.parse(String(req.init.body))).toMatchObject({ amount: '1500', currency: 'EUR', payer: { partyIdType: 'MSISDN', partyId: '46733123453' } });
    expect(await s.mobilePay.status(p.id)).toMatchObject({ status: 'success', transaction_id: '1234567890' });
    expect(calls.filter((c) => c.url.endsWith('/collection/token/'))).toHaveLength(1);
  });

  it('donne le motif de refus de MTN en clair', async () => {
    const calls: Call[] = [];
    s.mobilePay = new MobilePayService(s.db, () => now, fakeMtn(calls, { status: 'FAILED', reason: 'NOT_ENOUGH_FUNDS' }));
    s.mobilePay.saveConfig(ctx.userId, 'MTN_MOMO', { mode: 'production', subscriptionKey: 'k', apiUser: 'u', apiKey: 'a' });
    const p = await s.mobilePay.request(ctx, { method: 'MTN_MOMO', phone: '677001122', amount: 1_000 });
    expect(p).toMatchObject({ currency: 'XAF', phone: '237677001122' });
    expect((calls.find((c) => c.url.endsWith('/requesttopay'))!.init.headers as Record<string, string>)['X-Target-Environment']).toBe('mtncameroon');
    expect(await s.mobilePay.status(p.id)).toMatchObject({ status: 'failed', reason: 'Solde insuffisant sur le compte du client' });
  });

  it('note l’échec quand l’opérateur ne répond pas, et l’abandon à la caisse', async () => {
    s.mobilePay = new MobilePayService(s.db, () => now, (async () => {
      throw new Error('getaddrinfo ENOTFOUND');
    }) as typeof fetch);
    s.mobilePay.saveConfig(ctx.userId, 'MTN_MOMO', { mode: 'production', subscriptionKey: 'k', apiUser: 'u', apiKey: 'a' });
    await expect(s.mobilePay.request(ctx, { method: 'MTN_MOMO', phone: '677001122', amount: 1_000 })).rejects.toThrow(/connexion internet/);
    expect(s.mobilePay.list(ctx.storeId)[0]).toMatchObject({ status: 'failed' });
    s.mobilePay.saveConfig(ctx.userId, 'MTN_MOMO', { mode: 'simulation' });
    const p = await s.mobilePay.request(ctx, { method: 'MTN_MOMO', phone: '677001122', amount: 1_000 });
    expect(s.mobilePay.cancel(ctx, p.id)).toMatchObject({ status: 'cancelled' });
    expect(() => s.mobilePay.saveConfig(ctx.userId, 'ORANGE_MONEY', { mode: 'sandbox' })).toThrow(/simulation/);
  });
});
