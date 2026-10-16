import { randomUUID } from 'node:crypto';
import type { Fcfa } from '@superette/core';
import type { Db } from './database';
import { AppError, Base, type Clock, type Context } from './util';

/**
 * Paiement Mobile Money automatique : la caisse envoie une demande de
 * paiement au téléphone du client (MTN MoMo ou Orange Money), le client
 * confirme avec son code secret, et la caisse reçoit la confirmation avec le
 * numéro de transaction, sans rien saisir.
 *
 * - « Simulation » : aucun compte nécessaire, pour essayer et former les
 *   caissiers. Le paiement est confirmé au bout de quelques secondes ; un
 *   numéro qui finit par 0 simule un refus.
 * - « Test MTN » : l'environnement de test (sandbox) de MTN MoMo Developer,
 *   avec la seule clé d'abonnement du compte développeur gratuit.
 * - « Réel » : le compte marchand (clés remises par MTN ou Orange).
 *
 * Les clés restent sur ce PC (réglages du poste) : elles ne passent ni par le
 * serveur central, ni par les autres PC.
 */
export type MobileMethod = 'MTN_MOMO' | 'ORANGE_MONEY';
export type MobileMode = 'off' | 'simulation' | 'sandbox' | 'production';
export type MobileStatus = 'pending' | 'success' | 'failed' | 'cancelled';

export interface MtnConfig {
  mode: MobileMode;
  /** Clé d'abonnement au produit « Collections » (Ocp-Apim-Subscription-Key). */
  subscriptionKey: string;
  /** Utilisateur et clé de l'API (créés tout seuls en test, remis par MTN en réel). */
  apiUser: string;
  apiKey: string;
  /** Environnement cible en réel (mtncameroon par défaut). */
  targetEnvironment: string;
}

export interface OrangeConfig {
  mode: MobileMode;
  /** Adresse de l'API Orange Money Cameroun. */
  baseUrl: string;
  /** Identifiants de l'application (consumer key et secret). */
  consumerKey: string;
  consumerSecret: string;
  /** Jeton marchand (X-AUTH-TOKEN). */
  authToken: string;
  /** Numéro marchand (channel user) et son code. */
  channelMsisdn: string;
  pin: string;
}

export interface MobilePayConfig {
  MTN_MOMO: MtnConfig;
  ORANGE_MONEY: OrangeConfig;
}

export const DEFAULT_MOBILE_PAY: MobilePayConfig = {
  MTN_MOMO: { mode: 'off', subscriptionKey: '', apiUser: '', apiKey: '', targetEnvironment: 'mtncameroon' },
  ORANGE_MONEY: { mode: 'off', baseUrl: 'https://api-s1.orange.cm', consumerKey: '', consumerSecret: '', authToken: '', channelMsisdn: '', pin: '' },
};

/** Champs secrets : jamais renvoyés à l'écran, seulement leur fin. */
const SECRETS = ['subscriptionKey', 'apiKey', 'consumerSecret', 'authToken', 'pin'] as const;

export const MOBILE_MODES: Record<MobileMode, string> = { off: 'Désactivé', simulation: 'Simulation (sans compte)', sandbox: 'Test MTN (sandbox)', production: 'Réel (compte marchand)' };

export interface MobilePayment {
  id: string;
  method: MobileMethod;
  mode: MobileMode;
  phone: string;
  amount: Fcfa;
  currency: string;
  status: MobileStatus;
  provider_ref: string | null;
  transaction_id: string | null;
  reason: string | null;
  store_id: string | null;
  register_id: string | null;
  user_id: string | null;
  user_name?: string | null;
  created_at: string;
  updated_at: string;
}

const MTN_URL = { sandbox: 'https://sandbox.momodeveloper.mtn.com', production: 'https://proxy.momoapi.mtn.com' };
const SETTING = 'mobilepay.config';
/** Délai de la simulation avant la réponse du « client ». */
const SIMULATION_MS = 5_000;

type Fetch = typeof fetch;

/** Numéro du payeur : 237 + 9 chiffres au Cameroun ; en test MTN, les numéros de test tels quels. */
export function payerNumber(phone: string, sandbox = false): string {
  let digits = phone.replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (sandbox && digits.length >= 8) return digits;
  if (digits.length === 9 && digits.startsWith('6')) digits = `237${digits}`;
  if (!/^2376\d{8}$/.test(digits)) throw new AppError('Numéro de téléphone invalide : 9 chiffres commençant par 6', 'INVALID');
  return digits;
}

export class MobilePayService extends Base {
  private tokens = new Map<string, { token: string; until: number }>();

  constructor(
    db: Db,
    clock: Clock,
    private readonly http: Fetch = (...args) => fetch(...args),
  ) {
    super(db, clock);
  }

  // --- Réglages du poste --------------------------------------------------------------

  private raw(): MobilePayConfig {
    const json = this.db.prepare('SELECT value FROM settings WHERE key = ?').pluck().get(SETTING) as string | undefined;
    let saved: Partial<MobilePayConfig> = {};
    try {
      saved = json ? (JSON.parse(json) as Partial<MobilePayConfig>) : {};
    } catch {
      saved = {};
    }
    return { MTN_MOMO: { ...DEFAULT_MOBILE_PAY.MTN_MOMO, ...saved.MTN_MOMO }, ORANGE_MONEY: { ...DEFAULT_MOBILE_PAY.ORANGE_MONEY, ...saved.ORANGE_MONEY } };
  }

  private write(config: MobilePayConfig): void {
    this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(SETTING, JSON.stringify(config));
    this.tokens.clear();
  }

  /** Réglages à l'écran : les secrets masqués, et si chaque moyen est prêt. */
  config() {
    const c = this.raw();
    const mask = (v: string) => (v ? `••••${v.slice(-4)}` : '');
    const masked = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, (SECRETS as readonly string[]).includes(k) ? mask(String(v)) : v]));
    return {
      MTN_MOMO: { ...(masked({ ...c.MTN_MOMO }) as unknown as MtnConfig), ready: this.ready('MTN_MOMO', c) },
      ORANGE_MONEY: { ...(masked({ ...c.ORANGE_MONEY }) as unknown as OrangeConfig), ready: this.ready('ORANGE_MONEY', c) },
    };
  }

  /** Moyens qui peuvent envoyer une demande de paiement depuis ce poste. */
  enabled(): MobileMethod[] {
    const c = this.raw();
    return (['MTN_MOMO', 'ORANGE_MONEY'] as const).filter((m) => this.ready(m, c));
  }

  private ready(method: MobileMethod, c = this.raw()): boolean {
    if (method === 'MTN_MOMO') {
      const m = c.MTN_MOMO;
      if (m.mode === 'simulation') return true;
      return (m.mode === 'sandbox' || m.mode === 'production') && Boolean(m.subscriptionKey && m.apiUser && m.apiKey);
    }
    const o = c.ORANGE_MONEY;
    if (o.mode === 'simulation') return true;
    return o.mode === 'production' && Boolean(o.baseUrl && o.consumerKey && o.consumerSecret && o.authToken && o.channelMsisdn && o.pin);
  }

  /** Enregistre les réglages ; un secret laissé masqué ou vide garde sa valeur. */
  saveConfig(userId: string, method: MobileMethod, patch: Partial<MtnConfig> | Partial<OrangeConfig>) {
    const c = this.raw();
    const current = c[method] as unknown as Record<string, string>;
    const next: Record<string, string> = { ...current };
    for (const [k, v] of Object.entries(patch ?? {})) {
      if (!(k in current)) throw new AppError(`Réglage inconnu : ${k}`, 'INVALID');
      const value = String(v ?? '').trim();
      if ((SECRETS as readonly string[]).includes(k) && (value === '' || value.startsWith('••••'))) continue;
      next[k] = value;
    }
    if (!(next['mode']! in MOBILE_MODES)) throw new AppError('Mode inconnu', 'INVALID');
    if (method === 'ORANGE_MONEY' && next['mode'] === 'sandbox') throw new AppError("Orange Money n'a pas d'environnement de test ici : choisissez la simulation", 'INVALID');
    if (method === 'ORANGE_MONEY' && next['baseUrl'] && !/^https:\/\//.test(next['baseUrl'])) throw new AppError("L'adresse de l'API doit commencer par https://", 'INVALID');
    this.write({ ...c, [method]: next } as MobilePayConfig);
    this.audit(userId, 'mobilepay.config', 'settings', SETTING, { method, mode: next['mode'] });
    return this.config();
  }

  /**
   * Test MTN : crée l'utilisateur et la clé de l'API dans le sandbox avec la
   * seule clé d'abonnement du compte développeur.
   */
  async setupMtnSandbox(userId: string) {
    const c = this.raw();
    const key = c.MTN_MOMO.subscriptionKey;
    if (!key) throw new AppError("Saisissez d'abord la clé d'abonnement « Collections » de votre compte MTN MoMo Developer", 'INVALID');
    const apiUser = randomUUID();
    const headers = { 'Ocp-Apim-Subscription-Key': key, 'Content-Type': 'application/json' };
    const created = await this.call(`${MTN_URL.sandbox}/v1_0/apiuser`, { method: 'POST', headers: { ...headers, 'X-Reference-Id': apiUser }, body: JSON.stringify({ providerCallbackHost: 'localhost' }) });
    if (created.status !== 201) throw new AppError(`MTN refuse la création de l'utilisateur de test (${created.status}) : vérifiez la clé d'abonnement`, 'MOBILE_PAY');
    const res = await this.call(`${MTN_URL.sandbox}/v1_0/apiuser/${apiUser}/apikey`, { method: 'POST', headers });
    const body = (await res.json().catch(() => ({}))) as { apiKey?: string };
    if (res.status !== 201 || !body.apiKey) throw new AppError(`MTN refuse la création de la clé de test (${res.status})`, 'MOBILE_PAY');
    this.write({ ...c, MTN_MOMO: { ...c.MTN_MOMO, mode: 'sandbox', apiUser, apiKey: body.apiKey } });
    this.audit(userId, 'mobilepay.sandbox', 'settings', SETTING, { apiUser });
    return this.config();
  }

  // --- Demandes de paiement -------------------------------------------------------------

  get(id: string): MobilePayment {
    const row = this.db.prepare('SELECT p.*, u.name AS user_name FROM mobile_payments p LEFT JOIN users u ON u.id = p.user_id WHERE p.id = ?').get(id) as MobilePayment | undefined;
    if (!row) throw new AppError('Demande de paiement introuvable', 'NOT_FOUND');
    return row;
  }

  list(storeId: string, limit = 100): MobilePayment[] {
    return this.db
      .prepare('SELECT p.*, u.name AS user_name FROM mobile_payments p LEFT JOIN users u ON u.id = p.user_id WHERE p.store_id = ? ORDER BY p.created_at DESC LIMIT ?')
      .all(storeId, limit) as MobilePayment[];
  }

  private update(id: string, patch: Partial<Pick<MobilePayment, 'status' | 'provider_ref' | 'transaction_id' | 'reason'>>): MobilePayment {
    const cur = this.get(id);
    const next = { ...cur, ...patch };
    this.db
      .prepare('UPDATE mobile_payments SET status = ?, provider_ref = ?, transaction_id = ?, reason = ?, updated_at = ? WHERE id = ?')
      .run(next.status, next.provider_ref, next.transaction_id, next.reason, this.now(), id);
    return this.get(id);
  }

  /** Envoie la demande de paiement au téléphone du client. */
  async request(ctx: Context, input: { method: MobileMethod; phone: string; amount: Fcfa; label?: string | null }): Promise<MobilePayment> {
    const c = this.raw();
    const method = input.method;
    if (method !== 'MTN_MOMO' && method !== 'ORANGE_MONEY') throw new AppError('Moyen de paiement mobile inconnu', 'INVALID');
    if (!this.ready(method, c)) throw new AppError(`Le paiement automatique ${method === 'MTN_MOMO' ? 'MTN MoMo' : 'Orange Money'} n'est pas réglé sur ce poste (Administration › Paiement mobile)`, 'INVALID');
    if (!Number.isSafeInteger(input.amount) || input.amount <= 0) throw new AppError('Montant invalide', 'INVALID');
    const mode = c[method].mode;
    const phone = mode === 'simulation' ? input.phone.replace(/\D/g, '') : payerNumber(input.phone, mode === 'sandbox');
    if (mode === 'simulation' && phone.length < 8) throw new AppError('Numéro de téléphone invalide', 'INVALID');
    const id = randomUUID();
    const now = this.now();
    // Le sandbox MTN ne connaît que l'euro ; le compte réel encaisse en francs CFA.
    const currency = mode === 'sandbox' ? 'EUR' : 'XAF';
    this.db
      .prepare(
        `INSERT INTO mobile_payments (id, method, mode, phone, amount, currency, status, store_id, register_id, user_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
      )
      .run(id, method, mode, phone, input.amount, currency, ctx.storeId, ctx.registerId, ctx.userId, now, now);
    this.audit(ctx.userId, 'mobilepay.request', 'mobile_payment', id, { method, mode, phone, amount: input.amount });
    const note = (input.label?.trim() || 'Achat').slice(0, 60);
    try {
      if (mode === 'simulation') return this.get(id);
      if (method === 'MTN_MOMO') {
        const m = c.MTN_MOMO;
        const res = await this.call(`${this.mtnUrl(m)}/collection/v1_0/requesttopay`, {
          method: 'POST',
          headers: { ...(await this.mtnHeaders(m)), 'X-Reference-Id': id, 'Content-Type': 'application/json' },
          body: JSON.stringify({ amount: String(input.amount), currency, externalId: id.slice(0, 8), payer: { partyIdType: 'MSISDN', partyId: phone }, payerMessage: note, payeeNote: note }),
        });
        if (res.status !== 202) throw new AppError(`MTN refuse la demande (${res.status}${await this.detail(res)})`, 'MOBILE_PAY');
        return this.update(id, { provider_ref: id });
      }
      const o = c.ORANGE_MONEY;
      const headers = await this.orangeHeaders(o);
      const init = await this.call(`${o.baseUrl}/omcoreapis/1.0.2/mp/init`, { method: 'POST', headers });
      const payToken = ((await init.json().catch(() => ({}))) as { data?: { payToken?: string } }).data?.payToken;
      if (!init.ok || !payToken) throw new AppError(`Orange Money refuse la demande (${init.status})`, 'MOBILE_PAY');
      const pay = await this.call(`${o.baseUrl}/omcoreapis/1.0.2/mp/pay`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ notifUrl: 'https://localhost/', channelUserMsisdn: o.channelMsisdn, amount: String(input.amount), subscriberMsisdn: phone.slice(3), pin: o.pin, orderId: id.slice(0, 20), description: note, payToken }),
      });
      if (!pay.ok) throw new AppError(`Orange Money refuse la demande (${pay.status}${await this.detail(pay)})`, 'MOBILE_PAY');
      return this.update(id, { provider_ref: payToken });
    } catch (e) {
      const reason = e instanceof AppError ? e.message : `Pas de réponse de l'opérateur : vérifiez la connexion internet (${(e as Error).message})`;
      this.update(id, { status: 'failed', reason });
      throw new AppError(reason, 'MOBILE_PAY');
    }
  }

  /** Où en est la demande : relit la réponse de l'opérateur tant qu'elle est en attente. */
  async status(id: string): Promise<MobilePayment> {
    const p = this.get(id);
    if (p.status !== 'pending') return p;
    const c = this.raw();
    if (p.mode === 'simulation') {
      if (this.clock().getTime() - new Date(p.created_at).getTime() < SIMULATION_MS) return p;
      if (p.phone.endsWith('0')) return this.update(id, { status: 'failed', reason: 'Le client a refusé le paiement (simulation)' });
      return this.update(id, { status: 'success', transaction_id: `SIM${Date.now().toString().slice(-8)}` });
    }
    try {
      if (p.method === 'MTN_MOMO') {
        const m = c.MTN_MOMO;
        const res = await this.call(`${MTN_URL[p.mode === 'sandbox' ? 'sandbox' : 'production']}/collection/v1_0/requesttopay/${p.provider_ref}`, { headers: await this.mtnHeaders(m, p.mode) });
        if (!res.ok) return p;
        const body = (await res.json()) as { status?: string; financialTransactionId?: string; reason?: string | { message?: string } };
        if (body.status === 'SUCCESSFUL') return this.update(id, { status: 'success', transaction_id: body.financialTransactionId ?? p.provider_ref });
        if (body.status === 'FAILED' || body.status === 'REJECTED' || body.status === 'TIMEOUT') {
          const why = typeof body.reason === 'string' ? body.reason : (body.reason?.message ?? body.status);
          return this.update(id, { status: 'failed', reason: MTN_REASONS[why] ?? `Paiement refusé (${why})` });
        }
        return p;
      }
      const o = c.ORANGE_MONEY;
      const res = await this.call(`${o.baseUrl}/omcoreapis/1.0.2/mp/paymentstatus/${p.provider_ref}`, { headers: await this.orangeHeaders(o) });
      if (!res.ok) return p;
      const data = ((await res.json()) as { data?: { status?: string; txnid?: string; inittxnmessage?: string } }).data ?? {};
      const st = String(data.status ?? '').toUpperCase();
      if (st.startsWith('SUCCESS')) return this.update(id, { status: 'success', transaction_id: data.txnid ?? p.provider_ref });
      if (st === 'FAILED' || st === 'CANCELLED' || st === 'EXPIRED') return this.update(id, { status: 'failed', reason: data.inittxnmessage || 'Paiement refusé ou expiré' });
      return p;
    } catch {
      // Pas de réseau pour l'instant : la demande reste en attente, on réessaiera.
      return p;
    }
  }

  /** Abandon à la caisse : le client ne confirme pas. Un paiement confirmé plus tard reste visible dans l'historique. */
  cancel(ctx: Context, id: string): MobilePayment {
    const p = this.get(id);
    if (p.status !== 'pending') return p;
    this.audit(ctx.userId, 'mobilepay.cancel', 'mobile_payment', id, {});
    return this.update(id, { status: 'cancelled', reason: 'Abandonné à la caisse' });
  }

  // --- Opérateurs -----------------------------------------------------------------------

  private async call(url: string, init: RequestInit): Promise<Response> {
    return this.http(url, { ...init, signal: AbortSignal.timeout(20_000) });
  }

  private async detail(res: Response): Promise<string> {
    const text = await res.text().catch(() => '');
    try {
      const body = JSON.parse(text) as { message?: string; reason?: string };
      return body.message || body.reason ? ` : ${body.message ?? body.reason}` : '';
    } catch {
      return '';
    }
  }

  private mtnUrl(m: MtnConfig, mode: MobileMode = m.mode): string {
    return MTN_URL[mode === 'sandbox' ? 'sandbox' : 'production'];
  }

  private async mtnHeaders(m: MtnConfig, mode: MobileMode = m.mode): Promise<Record<string, string>> {
    const cacheKey = `mtn:${mode}:${m.apiUser}`;
    let t = this.tokens.get(cacheKey);
    if (!t || t.until < Date.now()) {
      const res = await this.call(`${this.mtnUrl(m, mode)}/collection/token/`, {
        method: 'POST',
        headers: { 'Ocp-Apim-Subscription-Key': m.subscriptionKey, Authorization: `Basic ${Buffer.from(`${m.apiUser}:${m.apiKey}`).toString('base64')}` },
      });
      const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number };
      if (!res.ok || !body.access_token) throw new AppError(`MTN refuse la connexion (${res.status}) : vérifiez l'utilisateur et la clé de l'API`, 'MOBILE_PAY');
      t = { token: body.access_token, until: Date.now() + ((body.expires_in ?? 3600) - 60) * 1000 };
      this.tokens.set(cacheKey, t);
    }
    return {
      Authorization: `Bearer ${t.token}`,
      'Ocp-Apim-Subscription-Key': m.subscriptionKey,
      'X-Target-Environment': mode === 'sandbox' ? 'sandbox' : m.targetEnvironment || 'mtncameroon',
    };
  }

  private async orangeHeaders(o: OrangeConfig): Promise<Record<string, string>> {
    const cacheKey = `orange:${o.consumerKey}`;
    let t = this.tokens.get(cacheKey);
    if (!t || t.until < Date.now()) {
      const res = await this.call(`${o.baseUrl}/token`, {
        method: 'POST',
        headers: { Authorization: `Basic ${Buffer.from(`${o.consumerKey}:${o.consumerSecret}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'grant_type=client_credentials',
      });
      const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number };
      if (!res.ok || !body.access_token) throw new AppError(`Orange Money refuse la connexion (${res.status}) : vérifiez les identifiants de l'application`, 'MOBILE_PAY');
      t = { token: body.access_token, until: Date.now() + ((body.expires_in ?? 3600) - 60) * 1000 };
      this.tokens.set(cacheKey, t);
    }
    return { Authorization: `Bearer ${t.token}`, 'X-AUTH-TOKEN': o.authToken };
  }
}

/** Motifs de refus de MTN, en clair pour le caissier. */
const MTN_REASONS: Record<string, string> = {
  PAYER_NOT_FOUND: 'Ce numéro n’a pas de compte MTN Mobile Money',
  NOT_ENOUGH_FUNDS: 'Solde insuffisant sur le compte du client',
  PAYEE_NOT_ALLOWED_TO_RECEIVE: 'Le compte marchand ne peut pas recevoir ce paiement',
  APPROVAL_REJECTED: 'Le client a refusé le paiement',
  EXPIRED: 'Le client n’a pas confirmé à temps',
  TRANSACTION_CANCELED: 'Paiement annulé',
  NOT_ALLOWED: 'Paiement non autorisé',
  INTERNAL_PROCESSING_ERROR: 'Erreur chez MTN, réessayez',
  SERVICE_UNAVAILABLE: 'Service MTN indisponible, réessayez',
  COULD_NOT_PERFORM_TRANSACTION: 'MTN n’a pas pu faire le paiement',
  FAILED: 'Paiement refusé',
  REJECTED: 'Le client a refusé le paiement',
  TIMEOUT: 'Le client n’a pas confirmé à temps',
};
