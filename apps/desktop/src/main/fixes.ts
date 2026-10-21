import type { AppError, ErrorFix } from '@superette/db';

/**
 * Solutions proposées avec les messages d'erreur courants : au lieu d'un
 * simple « impossible », le message offre un bouton qui ouvre l'écran où le
 * problème se règle. Les solutions données par le service passent devant.
 */
const BY_CODE: Record<string, ErrorFix[]> = {
  SESSION_CLOSED: [{ label: 'Ouvrir la caisse', open: ['treasury', 'day'] }],
  NO_SESSION: [{ label: 'Ouvrir la caisse', open: ['treasury', 'day'] }],
  SESSION_OPEN: [{ label: 'Aller à la clôture', open: ['treasury', 'day'] }],
  NO_REGISTER: [{ label: 'Voir les caisses', open: ['admin', 'registers'] }],
  PERIOD_CLOSED: [{ label: 'Voir les exercices', open: ['accounting', 'fiscal'] }],
  CREDIT_LIMIT: [{ label: 'Voir les plafonds des clients', open: ['customers', 'limits'] }],
  SYNC_NOT_CONFIGURED: [{ label: 'Relier ce PC au serveur', open: ['admin', 'server'] }],
  LICENSE: [{ label: 'Voir la licence', open: ['admin', 'license'] }],
  NO_PRINTER: [{ label: "Régler l'imprimante", open: ['admin', 'settings'] }],
};

export function fixesFor(e: AppError): ErrorFix[] {
  const all = [...(e.fixes ?? []), ...(BY_CODE[e.code] ?? [])];
  return all.filter((f, n) => all.findIndex((x) => x.label === f.label) === n).slice(0, 3);
}
