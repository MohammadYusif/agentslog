/**
 * SQLite schema definition and the current schema version.
 */

export const SCHEMA_VERSION = 1;

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS sessions (
  id                    TEXT PRIMARY KEY,
  project_hash          TEXT NOT NULL,
  project_path          TEXT,
  ai_title              TEXT,
  model                 TEXT,
  cc_version            TEXT,
  git_branch            TEXT,
  started_at            TEXT NOT NULL,
  ended_at              TEXT,
  duration_ms           INTEGER,
  input_tokens          INTEGER DEFAULT 0,
  output_tokens         INTEGER DEFAULT 0,
  last_input_tokens     INTEGER DEFAULT 0,
  cache_read_tokens     INTEGER DEFAULT 0,
  cache_creation_tokens INTEGER DEFAULT 0,
  tool_call_count       INTEGER DEFAULT 0,
  error_count           INTEGER DEFAULT 0,
  user_turn_count       INTEGER DEFAULT 0,
  raw_path              TEXT NOT NULL,
  ingested_at           TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tool_calls (
  id           TEXT PRIMARY KEY,
  session_id   TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  sequence_num INTEGER NOT NULL,
  tool_name    TEXT NOT NULL,
  called_at    TEXT,
  success      INTEGER NOT NULL DEFAULT 1,
  file_path    TEXT,
  command      TEXT,
  error_text   TEXT
);

CREATE TABLE IF NOT EXISTS files_touched (
  session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  file_path   TEXT NOT NULL,
  read_count  INTEGER DEFAULT 0,
  write_count INTEGER DEFAULT 0,
  edit_count  INTEGER DEFAULT 0,
  PRIMARY KEY (session_id, file_path)
);

CREATE INDEX IF NOT EXISTS idx_tc_session ON tool_calls(session_id);
CREATE INDEX IF NOT EXISTS idx_tc_file    ON tool_calls(file_path);
CREATE INDEX IF NOT EXISTS idx_tc_tool    ON tool_calls(tool_name);
CREATE INDEX IF NOT EXISTS idx_ft_path    ON files_touched(file_path);
CREATE INDEX IF NOT EXISTS idx_s_started  ON sessions(started_at);
CREATE INDEX IF NOT EXISTS idx_s_project  ON sessions(project_path);
CREATE INDEX IF NOT EXISTS idx_s_hash     ON sessions(project_hash);
`;
