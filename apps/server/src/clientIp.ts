import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/**
 * Adresse de la personne qui appelle. Derrière un proxy installé sur le même PC (Caddy),
 * toutes les demandes arrivent de 127.0.0.1 : on prend alors la dernière adresse ajoutée par
 * le proxy dans X-Forwarded-For. Venant d'ailleurs, l'en-tête est ignoré (il serait inventé).
 * Sans cela, les limites d'essais seraient communes à tout le monde derrière le proxy.
 */
export function clientIp(req: Pick<Request, 'socket' | 'headers'>): string {
  const peer = req.socket?.remoteAddress ?? '';
  const forwarded = req.headers['x-forwarded-for'];
  if (LOOPBACK.has(peer) && forwarded) {
    const list = (Array.isArray(forwarded) ? forwarded.join(',') : forwarded).split(',').map((s) => s.trim()).filter(Boolean);
    const last = list[list.length - 1];
    if (last) return last;
  }
  return peer;
}

/** Demande faite sur le PC du serveur lui-même, sans passer par un proxy. */
export const isLocalRequest = (req: Pick<Request, 'socket' | 'headers'>) => LOOPBACK.has(req.socket?.remoteAddress ?? '') && !req.headers['x-forwarded-for'];

/** `@ClientIp()` : comme `@Ip()`, mais avec l'adresse réelle derrière le proxy du serveur. */
export const ClientIp = createParamDecorator((_: unknown, ctx: ExecutionContext) => clientIp(ctx.switchToHttp().getRequest<Request>()));
