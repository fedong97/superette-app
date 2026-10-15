/** Configuration lue dans les variables d'environnement. */
export interface ServerConfig {
  /** Serveur PostgreSQL. Sans elle, la base intégrée de `dataDir` est utilisée. */
  databaseUrl?: string;
  /** Dossier de la base intégrée (FEDONIX 360 Serveur pour Windows) : rien à installer. */
  dataDir?: string;
  /** Dossier des sauvegardes automatiques de la base intégrée. */
  backupDir?: string;
  port: number;
  /**
   * Clé secrète pour rattacher le premier poste d'un magasin (saisie une fois dans l'application).
   * Sans elle, le serveur en crée une au premier démarrage et l'affiche dans son interface.
   */
  enrollmentKey?: string;
  /** Clé publique qui vérifie les licences ; celle de l'éditeur par défaut (autre clé : tests seulement). */
  licensePublicKey?: string;
  /** Jeton qui ouvre l'interface sans mot de passe : seulement pour la fenêtre de FEDONIX 360 Serveur sur ce PC. */
  localAdminToken?: string;
  /** Mot de passe de l'interface, s'il n'en a pas encore (serveur sur Internet, derrière un proxy). */
  adminPassword?: string;
  /** Version affichée dans l'interface. */
  version?: string;
}

export const CONFIG = Symbol('CONFIG');

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const enrollmentKey = env['ENROLLMENT_KEY'] || undefined;
  if (enrollmentKey !== undefined && enrollmentKey.length < 12) {
    throw new Error('ENROLLMENT_KEY doit faire 12 caractères minimum');
  }
  const dataDir = env['DATA_DIR'] || undefined;
  return {
    databaseUrl: dataDir ? undefined : (env['DATABASE_URL'] ?? 'postgres://superette:superette@localhost:5432/superette'),
    dataDir,
    backupDir: env['BACKUP_DIR'] || undefined,
    port: Number(env['PORT'] ?? 3000),
    enrollmentKey,
    adminPassword: env['ADMIN_PASSWORD'] || undefined,
  };
}
