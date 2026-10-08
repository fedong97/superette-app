import Database from 'better-sqlite3';
import { MIGRATIONS } from './schema';

export type Db = Database.Database;

export function openDatabase(file: string): Db {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');
  // Minuscules sans accents, pour chercher « creme » et trouver « Crème ».
  db.function('fold', { deterministic: true }, (v: unknown) => (v == null ? null : fold(String(v))));
  migrate(db);
  return db;
}

export function fold(text: string): string {
  return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

export function migrate(db: Db): void {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
  const applied = new Set(
    db.prepare('SELECT version FROM schema_migrations').pluck().all() as number[],
  );
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    // Reconstruire une table que d'autres citent : la vérification des clés
    // étrangères est suspendue (elle ne se change pas dans une transaction).
    const fk = m.rebuild ? (db.pragma('foreign_keys', { simple: true }) as number) : 0;
    if (fk) db.pragma('foreign_keys = OFF');
    try {
      db.transaction(() => {
        db.exec(m.sql);
        db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
          m.version,
          m.name,
          new Date().toISOString(),
        );
      })();
    } finally {
      if (fk) db.pragma('foreign_keys = ON');
    }
  }
}
