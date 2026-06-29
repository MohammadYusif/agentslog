/**
 * Schema creation and version migration.
 */
import type Database from 'better-sqlite3';
import { SCHEMA_SQL, SCHEMA_VERSION } from './schema.js';

/** True if `table` already has a column named `column`. */
function hasColumn(db: Database.Database, table: string, column: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return cols.some((c) => c.name === column);
}

/**
 * Ensure the database schema exists and is at the current version.
 *
 * Idempotent: safe to call on every startup. Creates all tables/indexes if
 * missing, applies in-place column migrations for older databases, and records
 * the schema version exactly once.
 */
export function migrate(db: Database.Database): void {
  // Fast path: schema already current. One indexed SELECT instead of the
  // PRAGMA inspection + DDL below — this runs on every open, including the
  // per-tool-call PreToolUse hook.
  if (schemaVersion(db) === SCHEMA_VERSION) return;

  // CREATE TABLE IF NOT EXISTS only builds fresh databases; for an existing
  // database the new v2 columns must be added explicitly before running the
  // rest of SCHEMA_SQL (which also creates the new indexes referencing them).
  if (tableExists(db, 'sessions')) {
    if (!hasColumn(db, 'sessions', 'parent_session_id')) {
      db.exec('ALTER TABLE sessions ADD COLUMN parent_session_id TEXT');
    }
    if (!hasColumn(db, 'sessions', 'source')) {
      db.exec("ALTER TABLE sessions ADD COLUMN source TEXT NOT NULL DEFAULT 'claude-code'");
    }
  }

  // v7: enforce flag on existing lessons tables (CREATE TABLE IF NOT EXISTS in
  // SCHEMA_SQL won't add a column to a table that already exists).
  if (tableExists(db, 'lessons') && !hasColumn(db, 'lessons', 'enforce')) {
    db.exec('ALTER TABLE lessons ADD COLUMN enforce INTEGER NOT NULL DEFAULT 0');
  }

  db.exec(SCHEMA_SQL);

  const row = db.prepare('SELECT version FROM schema_version LIMIT 1').get() as
    | { version: number }
    | undefined;

  if (row == null) {
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(SCHEMA_VERSION);
    return;
  }

  if (row.version < SCHEMA_VERSION) {
    db.prepare('UPDATE schema_version SET version = ?').run(SCHEMA_VERSION);
  }
}

/** True if a table with the given name exists. */
function tableExists(db: Database.Database, name: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
    .get(name);
  return row != null;
}

/**
 * The recorded schema version, or null when the database is fresh (no
 * schema_version table yet) or unreadable.
 */
export function schemaVersion(db: Database.Database): number | null {
  try {
    const row = db.prepare('SELECT version FROM schema_version LIMIT 1').get() as
      | { version: number }
      | undefined;
    return row?.version ?? null;
  } catch {
    return null; // table missing → fresh database
  }
}
