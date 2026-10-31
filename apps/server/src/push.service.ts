import { BadRequestException, Inject, Injectable, Optional } from '@nestjs/common';
import { createSign } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG, type ServerConfig } from './config';
import { type Db, PG } from './database';
import type { MobileCaller } from './mobile.service';
import { userHasRight } from './rights';

type Json = Record<string, unknown>;

/** Compte de service Firebase (fichier JSON téléchargé depuis la console Firebase). */
interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
}

/** Notification envoyée aux téléphones Android, appli fermée. */
export interface PushMessage {
  /** Sorte d'alerte (approval, gap, discount…) : le téléphone garde celles que la personne a le droit de voir. */
  kind: string;
  title: string;
  body: string;
  /** Même tag : la nouvelle remplace l'ancienne au lieu de s'empiler. */
  tag: string;
  /** Magasin concerné (null : tous). */
  storeId: string | null;
  /** Écran à ouvrir dans l'appli quand on touche la notification. */
  screen?: string;
}

/** Réglages Firebase du téléphone, tirés du fichier google-services.json : l'appli démarre Firebase avec eux, sans être recompilée. */
export interface FirebaseClient {
  appId: string;
  apiKey: string;
  projectId: string;
  senderId: string;
}

const ANDROID_PACKAGE = 'cm.fedonix.inventaire';

/** Lit google-services.json (fichier de l'application Android dans la console Firebase). */
export function parseGoogleServices(raw: unknown): FirebaseClient | null {
  const j = raw as { project_info?: { project_id?: string; project_number?: string }; client?: { client_info?: { mobilesdk_app_id?: string; android_client_info?: { package_name?: string } }; api_key?: { current_key?: string }[] }[] };
  if (!j?.project_info?.project_id || !j.project_info.project_number || !Array.isArray(j.client)) return null;
  const c = j.client.find((x) => x.client_info?.android_client_info?.package_name === ANDROID_PACKAGE);
  const appId = c?.client_info?.mobilesdk_app_id;
  const apiKey = c?.api_key?.find((k) => k.current_key)?.current_key;
  if (!appId || !apiKey) return null;
  return { appId, apiKey, projectId: j.project_info.project_id, senderId: j.project_info.project_number };
}

const b64url = (v: string | Buffer) => Buffer.from(v).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

/**
 * Notifications de l'application Android ONIX 360 Mobile par Firebase Cloud
 * Messaging : le téléphone donne son jeton à la connexion, le serveur envoie
 * les alertes du magasin (demandes d'accord, écarts, remises, annulations…)
 * aux personnes qui ont l'espace du gérant ou le droit Superviseur, même
 * quand l'appli est fermée. Sans compte Firebase réglé, rien n'est envoyé :
 * les alertes restent visibles dans l'appli ouverte.
 */
@Injectable()
export class PushService {
  private token: { value: string; until: number } | null = null;

  constructor(
    @Inject(PG) private readonly pg: Db,
    @Optional() @Inject(CONFIG) private readonly config?: ServerConfig,
  ) {}

  private async setting(key: string): Promise<string | null> {
    const { rows } = await this.pg.query<{ value: string }>('SELECT value FROM settings WHERE key = $1', [key]);
    return rows[0]?.value ?? null;
  }

  /** Compte de service : réglé depuis la page Téléphones, sinon le fichier `firebase-service-account.json` du dossier du serveur. */
  private async account(): Promise<ServiceAccount | null> {
    let raw = await this.setting('firebase_service_account');
    if (!raw) {
      const file = process.env['FIREBASE_SERVICE_ACCOUNT'] || (this.config?.dataDir ? join(this.config.dataDir, 'firebase-service-account.json') : '');
      if (file && existsSync(file)) raw = readFileSync(file, 'utf8');
    }
    if (!raw) return null;
    try {
      const a = JSON.parse(raw) as Partial<ServiceAccount>;
      return a.project_id && a.client_email && a.private_key ? (a as ServiceAccount) : null;
    } catch {
      return null;
    }
  }

  /** Réglages Firebase de l'appli Android (google-services.json collé sur la page Téléphones). */
  async client(): Promise<FirebaseClient | null> {
    const raw = await this.setting('firebase_client');
    if (!raw) return null;
    try {
      return parseGoogleServices(JSON.parse(raw));
    } catch {
      return null;
    }
  }

  /** État pour la page Téléphones : les deux fichiers reçus ou non, projet, téléphones abonnés. */
  async status() {
    const a = await this.account();
    const c = await this.client();
    const { rows } = await this.pg.query<{ n: string }>('SELECT COUNT(*) AS n FROM push_tokens');
    return { configured: Boolean(a && c), account: Boolean(a), app: Boolean(c), project: a?.project_id ?? c?.projectId ?? null, phones: Number(rows[0]?.n ?? 0) };
  }

  /**
   * Enregistre un des deux fichiers Firebase collés sur la page Téléphones :
   * le compte de service (clé privée, pour envoyer) ou google-services.json
   * (pour que l'appli reçoive). Vide : coupe les notifications.
   */
  async configure(json: string | null) {
    const text = (json ?? '').trim();
    if (!text) {
      await this.pg.query("DELETE FROM settings WHERE key IN ('firebase_service_account', 'firebase_client')");
      await this.pg.query('DELETE FROM push_tokens');
      this.token = null;
      return this.status();
    }
    let a: Partial<ServiceAccount> & { project_info?: unknown };
    try {
      a = JSON.parse(text) as Partial<ServiceAccount>;
    } catch {
      throw new BadRequestException('Ce n’est pas un fichier JSON de Firebase : collez tout le contenu du fichier');
    }
    if (a.project_info) {
      if (!parseGoogleServices(a)) throw new BadRequestException(`Ce google-services.json ne contient pas l’application Android ${ANDROID_PACKAGE} : ajoutez-la au projet Firebase puis retéléchargez le fichier`);
      await this.pg.query("INSERT INTO settings (key, value) VALUES ('firebase_client', $1) ON CONFLICT (key) DO UPDATE SET value = excluded.value", [text]);
      return this.status();
    }
    if (!a.project_id || !a.client_email || !a.private_key) throw new BadRequestException('Fichier incomplet : il faut le fichier « Compte de service » (clé privée) ou google-services.json du projet Firebase');
    await this.pg.query(
      "INSERT INTO settings (key, value) VALUES ('firebase_service_account', $1) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      [text],
    );
    this.token = null;
    return this.status();
  }

  /** Jeton du téléphone (donné par Android à la connexion) ; null : désabonné. */
  async register(caller: MobileCaller, token: string | null) {
    if (caller.guest) return { ok: false };
    if (!token) {
      await this.pg.query('DELETE FROM push_tokens WHERE device_id = $1', [caller.device.id]);
      return { ok: true };
    }
    if (!/^[\w:.-]{20,4096}$/.test(token)) throw new BadRequestException('Jeton invalide');
    // Un téléphone = un jeton : à la reconnexion d'une autre personne, le jeton passe à elle.
    await this.pg.query('DELETE FROM push_tokens WHERE device_id = $1 AND token <> $2', [caller.device.id, token]);
    await this.pg.query(
      `INSERT INTO push_tokens (token, device_id, user_id, store_id) VALUES ($1, $2, $3, $4)
       ON CONFLICT (token) DO UPDATE SET device_id = excluded.device_id, user_id = excluded.user_id, store_id = excluded.store_id, updated_at = now()`,
      [token, caller.device.id, caller.user.id, caller.device.store_id],
    );
    return { ok: true, configured: Boolean(await this.account()) };
  }

  private async accessToken(a: ServiceAccount): Promise<string> {
    if (this.token && this.token.until > Date.now()) return this.token.value;
    const now = Math.floor(Date.now() / 1000);
    const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claims = b64url(
      JSON.stringify({ iss: a.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }),
    );
    const signer = createSign('RSA-SHA256');
    signer.update(`${head}.${claims}`);
    const jwt = `${head}.${claims}.${b64url(signer.sign(a.private_key))}`;
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }),
    });
    if (!res.ok) throw new Error(`Firebase : connexion refusée (${res.status})`);
    const body = (await res.json()) as { access_token: string; expires_in?: number };
    this.token = { value: body.access_token, until: Date.now() + Math.max(60, (body.expires_in ?? 3600) - 300) * 1000 };
    return body.access_token;
  }

  /** La personne voit cette sorte d'alerte : tout avec l'espace du gérant, les demandes d'accord avec le droit Superviseur. */
  private async allowed(userId: string, kind: string, cache: Map<string, { manage: boolean; supervisor: boolean }>): Promise<boolean> {
    let r = cache.get(userId);
    if (!r) {
      const { rows } = await this.pg.query<{ payload: Json | null }>("SELECT payload FROM events WHERE entity = 'user' AND entity_id = $1 ORDER BY seq DESC LIMIT 1", [userId]);
      const u = rows[0]?.payload;
      const role = String(u?.['role'] ?? '');
      const active = u && u['active'] !== 0 && !u['deleted_at'];
      r = {
        manage: Boolean(active) && (await userHasRight(this.pg, userId, role, ['mobile_manager'], ['manager'])),
        supervisor: Boolean(active) && (await userHasRight(this.pg, userId, role, ['supervisor'], ['manager'])),
      };
      cache.set(userId, r);
    }
    return r.manage || (kind === 'approval' && r.supervisor);
  }

  /** Envoie les notifications aux téléphones abonnés ; renvoie le nombre envoyé. */
  async send(messages: PushMessage[]): Promise<number> {
    if (!messages.length) return 0;
    const { rows: tokens } = await this.pg.query<{ token: string; user_id: string; store_id: string }>('SELECT token, user_id, store_id FROM push_tokens');
    if (!tokens.length) return 0;
    const a = await this.account();
    if (!a) return 0;
    let access: string;
    try {
      access = await this.accessToken(a);
    } catch {
      return 0;
    }
    const cache = new Map<string, { manage: boolean; supervisor: boolean }>();
    let sent = 0;
    for (const t of tokens) {
      for (const m of messages) {
        if (m.storeId && m.storeId !== t.store_id) continue;
        if (!(await this.allowed(t.user_id, m.kind, cache))) continue;
        try {
          const res = await fetch(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(a.project_id)}/messages:send`, {
            method: 'POST',
            headers: { authorization: `Bearer ${access}`, 'content-type': 'application/json' },
            body: JSON.stringify({
              message: {
                token: t.token,
                notification: { title: m.title, body: m.body },
                data: { kind: m.kind, tag: m.tag, screen: m.screen ?? (m.kind === 'approval' ? 'valider' : 'accueil') },
                android: { priority: 'high', notification: { channel_id: 'alertes', tag: m.tag, sound: 'default' } },
              },
            }),
          });
          if (res.status === 404 || res.status === 400) {
            // Appli désinstallée ou jeton périmé : le téléphone se réabonnera à sa prochaine connexion.
            const text = await res.text().catch(() => '');
            if (res.status === 404 || /UNREGISTERED|INVALID_ARGUMENT/.test(text)) {
              await this.pg.query('DELETE FROM push_tokens WHERE token = $1', [t.token]);
              break;
            }
          } else if (res.ok) sent++;
        } catch {
          // Réseau coupé : l'alerte reste visible dans l'appli.
        }
      }
    }
    return sent;
  }
}
