/** Configuration lue dans les variables d'environnement. */
export interface ServerConfig {
  databaseUrl: string;
  port: number;
  /** Clé secrète pour rattacher le premier poste d'un magasin (saisie une fois dans l'application). */
  enrollmentKey: string;
}

export const CONFIG = Symbol('CONFIG');

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const enrollmentKey = env['ENROLLMENT_KEY'] ?? '';
  if (enrollmentKey.length < 12) {
    throw new Error('ENROLLMENT_KEY doit être définie (12 caractères minimum)');
  }
  return {
    databaseUrl: env['DATABASE_URL'] ?? 'postgres://superette:superette@localhost:5432/superette',
    port: Number(env['PORT'] ?? 3000),
    enrollmentKey,
  };
}
