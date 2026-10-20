import { createCipheriv, createECDH, createPrivateKey, generateKeyPairSync, hkdfSync, randomBytes, sign } from 'node:crypto';

/**
 * Notifications du navigateur (Web Push) sans bibliothèque : clés VAPID
 * (RFC 8292) et message chiffré pour le seul téléphone abonné (RFC 8291).
 */
export interface VapidKeys {
  /** Clé publique brute (65 octets) en base64url, donnée au navigateur. */
  publicKey: string;
  /** Clé privée PKCS#8 (PEM), gardée par le serveur. */
  privateKey: string;
}

export interface PushSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

const b64u = (b: Buffer | string) => Buffer.from(b).toString('base64url');

export function generateVapidKeys(): VapidKeys {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  const raw = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, 'base64url'), Buffer.from(jwk.y!, 'base64url')]);
  return { publicKey: b64u(raw), privateKey: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString() };
}

/** En-tête Authorization signé pour le service de notifications du navigateur. */
export function vapidAuthorization(endpoint: string, keys: VapidKeys, subject: string, now = Date.now()): string {
  const header = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64u(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject }));
  const signature = sign('sha256', Buffer.from(`${header}.${claims}`), { key: createPrivateKey(keys.privateKey), dsaEncoding: 'ieee-p1363' });
  return `vapid t=${header}.${claims}.${b64u(signature)}, k=${keys.publicKey}`;
}

/** Chiffre le message pour l'abonnement (aes128gcm, un seul enregistrement). */
export function encryptPayload(sub: PushSubscription, payload: string): Buffer {
  const uaPublic = Buffer.from(sub.keys.p256dh, 'base64url');
  const authSecret = Buffer.from(sub.keys.auth, 'base64url');
  const ecdh = createECDH('prime256v1');
  const asPublic = ecdh.generateKeys();
  const shared = ecdh.computeSecret(uaPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', shared, authSecret, keyInfo, 32));
  const salt = randomBytes(16);
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, body]);
}

/** Envoie une notification. Renvoie false si l'abonnement n'existe plus (à oublier). */
export async function sendPush(sub: PushSubscription, payload: unknown, keys: VapidKeys, subject: string): Promise<boolean> {
  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      authorization: vapidAuthorization(sub.endpoint, keys, subject),
      'content-encoding': 'aes128gcm',
      'content-type': 'application/octet-stream',
      ttl: '3600',
      urgency: 'high',
    },
    body: new Uint8Array(encryptPayload(sub, JSON.stringify(payload))),
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 404 || res.status === 410) return false;
  return true;
}
