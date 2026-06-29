/**
 * SQLite schema definition and the current schema version.
 */

export const SCHEMA_VERSION = 7;

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
  ingested_at           TEXT NOT NULL,
  -- v2: sub-agent (sidechain) transcripts are indexed as their own rows and
  -- linked to the top-level session that spawned them. NULL = top-level.
  parent_session_id     TEXT,
  -- v2: which agent tool produced this transcript ('claude-code', 'aider', …).
  source                TEXT NOT NULL DEFAULT 'claude-code'
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
CREATE INDEX IF NOT EXISTS idx_tc_success ON tool_calls(success);
CREATE INDEX IF NOT EXISTS idx_ft_path    ON files_touched(file_path);
CREATE INDEX IF NOT EXISTS idx_s_started  ON sessions(started_at);
CREATE INDEX IF NOT EXISTS idx_s_project  ON sessions(project_path);
CREATE INDEX IF NOT EXISTS idx_s_hash     ON sessions(project_hash);
CREATE INDEX IF NOT EXISTS idx_s_parent   ON sessions(parent_session_id);
CREATE INDEX IF NOT EXISTS idx_s_source   ON sessions(source);

-- v3: opt-in full-text index of assistant reasoning ('thinking') blocks.
-- Populated only when AGENTSLOG_INDEX_REASONING is set during ingest. The
-- session_id / sequence_num columns are UNINDEXED (stored, not full-text) so
-- rows can be filtered and deleted per-session on re-ingest.
CREATE VIRTUAL TABLE IF NOT EXISTS reasoning_fts
  USING fts5(session_id UNINDEXED, sequence_num UNINDEXED, text);

-- v4: durable lessons the agent learns from inefficient runs. Recalled before
-- similar actions (PreToolUse) and at session start. Never auto-written to
-- CLAUDE.md — that path is human-reviewed via "agentslog lesson export".
CREATE TABLE IF NOT EXISTS lessons (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at        TEXT NOT NULL,
  source            TEXT NOT NULL DEFAULT 'agent',   -- 'auto' | 'agent' | 'user'
  scope             TEXT NOT NULL DEFAULT 'global',  -- a project_hash, or 'global'
  tool              TEXT,                            -- tool the lesson concerns
  trigger           TEXT,                            -- recall key: command/flag or file
  rule              TEXT NOT NULL,                   -- the distilled lesson
  rationale         TEXT,                            -- why / evidence
  source_session_id TEXT,
  confidence        REAL NOT NULL DEFAULT 0.8,
  hits              INTEGER NOT NULL DEFAULT 0,      -- times recalled (usefulness)
  last_hit_at       TEXT,
  -- v7: when 1, a PreToolUse match for this lesson escalates from a non-blocking
  -- advisory to a permission decision (ask/deny), gated by AGENTSLOG_ENFORCE.
  -- Opt-in per lesson: only deterministic "this WILL fail" gotchas should set it,
  -- never heuristic nudges (e.g. a cd/gh lesson), so common commands are not blocked.
  enforce           INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_lessons_dedup ON lessons(scope, rule);
CREATE INDEX IF NOT EXISTS idx_lessons_scope ON lessons(scope);
CREATE INDEX IF NOT EXISTS idx_lessons_tool  ON lessons(tool);

-- v5: small key/value store for installer + adoption metadata, e.g. 'setup_at'
-- (when "agentslog setup" first ran) used as a fallback baseline for the
-- before/after "impact" report.
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);

-- v6: one row per PreToolUse advisory the hook emits *before* a tool runs — the
-- interception log. lessons.hits counts only the lesson kind; this table also
-- captures the similar-failure / frequency / file-constraint advisories, each
-- tagged by 'kind', so the "advisories" report covers every nudge precisely.
-- Append-only; never blocks a tool (the hook stays advisory).
CREATE TABLE IF NOT EXISTS advisory_fires (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  fired_at    TEXT NOT NULL,
  session_id  TEXT,            -- session whose imminent tool call triggered it (nullable)
  project     TEXT,            -- normalized cwd scope, or NULL when unknown
  tool        TEXT NOT NULL,   -- the tool that was about to run
  kind        TEXT NOT NULL,   -- 'lesson' | 'similar_failure' | 'frequency' | 'not_read' | 'modified_since_read'
  detail      TEXT             -- short human-readable summary of the nudge
);
CREATE INDEX IF NOT EXISTS idx_af_fired ON advisory_fires(fired_at);
CREATE INDEX IF NOT EXISTS idx_af_tool  ON advisory_fires(tool);
CREATE INDEX IF NOT EXISTS idx_af_kind  ON advisory_fires(kind);
`;
