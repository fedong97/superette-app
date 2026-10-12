import { createPublicKey, verify } from 'node:crypto';

/**
 * Clé publique de l'éditeur, la même que dans l'application
 * (packages/db/src/license.ts) : le serveur vérifie les licences que les PC
 * lui envoient, sans pouvoir en fabriquer.
 */
export const LICENSE_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAFN0JKMfb8/004ITtjE6SQUCW0mIEhx+wKm11o+bLs+w=
-----END PUBLIC KEY-----`;

export interface ServerLicense {
  id: string;
  client: string;
  stations: number;
  issued: string;
}

/** Contenu d'une clé « SG1.… » dont la signature est bonne, sinon null. */
export function readLicense(key: string, publicKey: string = LICENSE_PUBLIC_KEY): ServerLicense | null {
  const parts = String(key ?? '').replace(/\s+/g, '').split('.');
  if (parts.length !== 3 || parts[0] !== 'SG1') return null;
  const data = Buffer.from(parts[1]!, 'base64url');
  try {
    if (!verify(null, data, createPublicKey(publicKey), Buffer.from(parts[2]!, 'base64url'))) return null;
    const p = JSON.parse(data.toString('utf8')) as Partial<ServerLicense>;
    if (typeof p.id !== 'string' || typeof p.client !== 'string' || typeof p.issued !== 'string' || !Number.isInteger(p.stations) || p.stations! < 1) return null;
    return { id: p.id, client: p.client, stations: p.stations!, issued: p.issued };
  } catch {
    return null;
  }
}
