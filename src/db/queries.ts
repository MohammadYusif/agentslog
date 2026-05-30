/**
 * Read-side query helpers shared across CLI commands.
 */
import type Database from 'better-sqlite3';
import { normalizePath } from '../parser/claude-code.js';

export interface SessionRow {
  id: string;
  project_hash: string;
  project_path: string | null;
  ai_title: string | null;
  model: string | null;
  cc_version: string | null;
  git_branch: string | null;
  started_at: string;
  ended_at: string | null;
  duration_ms: number | null;
  input_tokens: number;
  output_tokens: number;
  last_input_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  tool_call_count: number;
  error_count: number;
  user_turn_count: number;
  raw_path: string;
  ingested_at: string;
}

export interface ToolCallRow {
  id: string;
  session_id: string;
  sequence_num: number;
  tool_name: string;
  called_at: string | null;
  success: number;
  file_path: string | null;
  command: string | null;
  error_text: string | null;
}

export interface FileTouchedRow {
  session_id: string;
  file_path: string;
  read_count: number;
  write_count: number;
  edit_count: number;
}

export interface ListFilters {
  /** ISO cutoff; only sessions started at/after this are returned. */
  sinceIso?: string | null;
  /** Substring match against project_path or project_hash. */
  project?: string | null;
  limit?: number | null;
}

/** List sessions newest-first, applying optional time/project filters. */
export function listSessions(db: Database.Database, filters: ListFilters = {}): SessionRow[] {
  const clauses: string[] = [];
  const params: Record<string, unknown> = {};

  if (filters.sinceIso) {
    clauses.push('started_at >= @since');
    params.since = filters.sinceIso;
  }
  if (filters.project) {
    clauses.push('(project_path LIKE @proj OR project_hash LIKE @proj)');
    params.proj = `%${filters.project}%`;
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const limit = filters.limit && filters.limit > 0 ? `LIMIT ${Math.floor(filters.limit)}` : '';
  const sql = `SELECT * FROM sessions ${where} ORDER BY started_at DESC ${limit}`;
  return db.prepare(sql).all(params) as SessionRow[];
}

/** Resolve a session id prefix to a single row; throws on ambiguity. */
export function resolveSession(db: Database.Database, prefix: string): SessionRow | null {
  const exact = db.prepare('SELECT * FROM sessions WHERE id = ?').get(prefix) as
    | SessionRow
    | undefined;
  if (exact) return exact;

  const rows = db
    .prepare('SELECT * FROM sessions WHERE id LIKE ? ORDER BY started_at DESC')
    .all(`${prefix}%`) as SessionRow[];

  if (rows.length === 0) return null;
  if (rows.length > 1) {
    const ids = rows.map((r) => r.id.slice(0, 12)).join(', ');
    throw new Error(`Ambiguous id prefix "${prefix}" matches ${rows.length} sessions: ${ids}`);
  }
  return rows[0];
}

/** All tool calls for a session, ordered by sequence number. */
export function toolCallsForSession(db: Database.Database, sessionId: string): ToolCallRow[] {
  return db
    .prepare('SELECT * FROM tool_calls WHERE session_id = ? ORDER BY sequence_num')
    .all(sessionId) as ToolCallRow[];
}

/** All files touched by a session, most-active first. */
export function filesForSession(db: Database.Database, sessionId: string): FileTouchedRow[] {
  return db
    .prepare(
      `SELECT * FROM files_touched WHERE session_id = ?
       ORDER BY (read_count + write_count + edit_count) DESC, file_path ASC`
    )
    .all(sessionId) as FileTouchedRow[];
}

/**
 * Find sessions that touched a given file. Matches both exact normalized path
 * and basename, so `--file CLAUDE.md` finds `/abs/path/CLAUDE.md`.
 */
export function sessionsByFile(
  db: Database.Database,
  file: string,
  sinceIso?: string | null
): SessionRow[] {
  const norm = normalizePath(file);
  const base = norm.split('/').pop() ?? norm;
  const params: Record<string, unknown> = {
    exact: norm,
    suffix: `%/${base}`,
    base,
  };
  let timeClause = '';
  if (sinceIso) {
    timeClause = 'AND s.started_at >= @since';
    params.since = sinceIso;
  }
  const sql = `
    SELECT DISTINCT s.* FROM sessions s
    JOIN files_touched f ON f.session_id = s.id
    WHERE (f.file_path = @exact OR f.file_path LIKE @suffix OR f.file_path = @base)
    ${timeClause}
    ORDER BY s.started_at DESC
  `;
  return db.prepare(sql).all(params) as SessionRow[];
}

/** Find sessions that invoked a given tool (case-insensitive). */
export function sessionsByTool(
  db: Database.Database,
  tool: string,
  sinceIso?: string | null
): SessionRow[] {
  const params: Record<string, unknown> = { tool };
  let timeClause = '';
  if (sinceIso) {
    timeClause = 'AND s.started_at >= @since';
    params.since = sinceIso;
  }
  const sql = `
    SELECT DISTINCT s.* FROM sessions s
    JOIN tool_calls t ON t.session_id = s.id
    WHERE t.tool_name = @tool COLLATE NOCASE
    ${timeClause}
    ORDER BY s.started_at DESC
  `;
  return db.prepare(sql).all(params) as SessionRow[];
}

export interface StatsTotals {
  session_count: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  tool_calls: number;
  errors: number;
}

/** Aggregate token/tool/error totals over a time window. */
export function statsTotals(db: Database.Database, sinceIso?: string | null): StatsTotals {
  const where = sinceIso ? 'WHERE started_at >= @since' : '';
  const row = db
    .prepare(
      `SELECT
         COUNT(*)                          AS session_count,
         COALESCE(SUM(input_tokens),0)     AS input_tokens,
         COALESCE(SUM(output_tokens),0)    AS output_tokens,
         COALESCE(SUM(cache_read_tokens),0) AS cache_read_tokens,
         COALESCE(SUM(cache_creation_tokens),0) AS cache_creation_tokens,
         COALESCE(SUM(tool_call_count),0)  AS tool_calls,
         COALESCE(SUM(error_count),0)      AS errors
       FROM sessions ${where}`
    )
    .get(sinceIso ? { since: sinceIso } : {}) as StatsTotals;
  return row;
}

export interface CountRow {
  label: string;
  count: number;
}

/** Top files by total touch count over a window. */
export function topFiles(db: Database.Database, sinceIso?: string | null, limit = 10): CountRow[] {
  const params: Record<string, unknown> = { limit };
  let join = '';
  if (sinceIso) {
    join = 'AND s.started_at >= @since';
    params.since = sinceIso;
  }
  const sql = `
    SELECT f.file_path AS label,
           SUM(f.read_count + f.write_count + f.edit_count) AS count
    FROM files_touched f
    JOIN sessions s ON s.id = f.session_id
    WHERE 1=1 ${join}
    GROUP BY f.file_path
    ORDER BY count DESC, label ASC
    LIMIT @limit
  `;
  return db.prepare(sql).all(params) as CountRow[];
}

/** Top tools by call count over a window. */
export function topTools(db: Database.Database, sinceIso?: string | null, limit = 10): CountRow[] {
  const params: Record<string, unknown> = { limit };
  let join = '';
  if (sinceIso) {
    join = 'AND s.started_at >= @since';
    params.since = sinceIso;
  }
  const sql = `
    SELECT t.tool_name AS label, COUNT(*) AS count
    FROM tool_calls t
    JOIN sessions s ON s.id = t.session_id
    WHERE 1=1 ${join}
    GROUP BY t.tool_name
    ORDER BY count DESC, label ASC
    LIMIT @limit
  `;
  return db.prepare(sql).all(params) as CountRow[];
}

/** Count of sessions currently indexed. */
export function sessionCount(db: Database.Database): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number };
  return row.n;
}
