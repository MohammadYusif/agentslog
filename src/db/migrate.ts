/**
 * Schema creation and version migration.
 */
import type Database from 'better-sqlite3';
import { SCHEMA_SQL, SCHEMA_VERSION } from './schema.js';

/**
 * Ensure the database schema exists and is at the current version.
 *
 * Idempotent: safe to call on every startup. Creates all tables/indexes if
 * missing and records the schema version exactly once.
 */
export function migrate(db: Database.Database): void {
  db.exec(SCHEMA_SQL);

  const row = db.prepare('SELECT version FROM schema_version LIMIT 1').get() as
    | { version: number }
    | undefined;

  if (row == null) {
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(SCHEMA_VERSION);
    return;
  }

  if (row.version < SCHEMA_VERSION) {
    // Future migrations would run here, stepping version -> SCHEMA_VERSION.
    db.prepare('UPDATE schema_version SET version = ?').run(SCHEMA_VERSION);
  }
}
