/**
 * Read-side query helpers shared across CLI commands.
 */
import type Database from 'better-sqlite3';
import { normalizePath } from '../parser/claude-code.js';

export interface SessionRow {
  id: string;
  parent_session_id: string | null;
  source: string;
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

/**
 * A top-level session row enriched with rolled-up totals from its sub-agents.
 * `rollup_*` fields equal the session's own value plus the sum across all of
 * its child (sidechain) sessions; `subagent_count` is how many it spawned.
 */
export interface SessionRollupRow extends SessionRow {
  rollup_input_tokens: number;
  rollup_output_tokens: number;
  rollup_tool_call_count: number;
  rollup_error_count: number;
  subagent_count: number;
}

/** SQL subquery aggregating child (sub-agent) sessions by their parent id. */
const CHILD_AGG = `
  SELECT parent_session_id,
         SUM(input_tokens)     AS c_input,
         SUM(output_tokens)    AS c_output,
         SUM(tool_call_count)  AS c_tools,
         SUM(error_count)      AS c_errors,
         COUNT(*)              AS c_count
  FROM sessions
  WHERE parent_session_id IS NOT NULL
  GROUP BY parent_session_id
`;

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
  /** Exact source filter ('claude-code', 'cline', 'aider'). */
  source?: string | null;
  limit?: number | null;
}

/**
 * List top-level sessions newest-first, each enriched with rolled-up sub-agent
 * totals. Sub-agent (child) sessions are never listed on their own here — their
 * activity is folded into the parent's `rollup_*` fields.
 */
export function listSessions(db: Database.Database, filters: ListFilters = {}): SessionRollupRow[] {
  const clauses: string[] = ['s.parent_session_id IS NULL'];
  const params: Record<string, unknown> = {};

  if (filters.sinceIso) {
    clauses.push('s.started_at >= @since');
    params.since = filters.sinceIso;
  }
  if (filters.project) {
    clauses.push('(s.project_path LIKE @proj OR s.project_hash LIKE @proj)');
    params.proj = `%${filters.project}%`;
  }
  if (filters.source) {
    clauses.push('s.source = @source');
    params.source = filters.source;
  }

  const where = `WHERE ${clauses.join(' AND ')}`;
  const limit = filters.limit && filters.limit > 0 ? `LIMIT ${Math.floor(filters.limit)}` : '';
  const sql = `
    SELECT s.*,
           s.input_tokens    + COALESCE(c.c_input, 0)  AS rollup_input_tokens,
           s.output_tokens   + COALESCE(c.c_output, 0) AS rollup_output_tokens,
           s.tool_call_count + COALESCE(c.c_tools, 0)  AS rollup_tool_call_count,
           s.error_count     + COALESCE(c.c_errors, 0) AS rollup_error_count,
           COALESCE(c.c_count, 0)                      AS subagent_count
    FROM sessions s
    LEFT JOIN (${CHILD_AGG}) c ON c.parent_session_id = s.id
    ${where}
    ORDER BY s.started_at DESC
    ${limit}
  `;
  return db.prepare(sql).all(params) as SessionRollupRow[];
}

/** Child (sub-agent) sessions spawned by a given top-level session. */
export function childSessions(db: Database.Database, parentId: string): SessionRow[] {
  return db
    .prepare('SELECT * FROM sessions WHERE parent_session_id = ? ORDER BY started_at ASC')
    .all(parentId) as SessionRow[];
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
    timeClause = 'AND top.started_at >= @since';
    params.since = sinceIso;
  }
  // A sub-agent may be the one that touched the file; surface the top-level
  // session that spawned it (via COALESCE to the parent) so the result is
  // actionable, and de-duplicate when several children hit the same file.
  const sql = `
    SELECT DISTINCT top.* FROM files_touched f
    JOIN sessions s   ON s.id = f.session_id
    JOIN sessions top ON top.id = COALESCE(s.parent_session_id, s.id)
    WHERE (f.file_path = @exact OR f.file_path LIKE @suffix OR f.file_path = @base)
    ${timeClause}
    ORDER BY top.started_at DESC
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
    timeClause = 'AND top.started_at >= @since';
    params.since = sinceIso;
  }
  // As with file queries, surface the top-level session when a sub-agent ran
  // the tool, de-duplicating across multiple children.
  const sql = `
    SELECT DISTINCT top.* FROM tool_calls t
    JOIN sessions s   ON s.id = t.session_id
    JOIN sessions top ON top.id = COALESCE(s.parent_session_id, s.id)
    WHERE t.tool_name = @tool COLLATE NOCASE
    ${timeClause}
    ORDER BY top.started_at DESC
  `;
  return db.prepare(sql).all(params) as SessionRow[];
}

export interface StatsTotals {
  /** Number of top-level sessions (excludes sub-agent runs). */
  session_count: number;
  /** Number of sub-agent (sidechain) runs folded into those sessions. */
  subagent_count: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  tool_calls: number;
  errors: number;
}

/**
 * Aggregate token/tool/error totals over a time window. Token, tool, and error
 * sums span every row (sub-agents included, since their cost is real); the
 * session count reflects only top-level sessions, with sub-agents reported
 * separately as `subagent_count`.
 */
export function statsTotals(db: Database.Database, sinceIso?: string | null): StatsTotals {
  const where = sinceIso ? 'WHERE started_at >= @since' : '';
  const row = db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN parent_session_id IS NULL     THEN 1 ELSE 0 END),0) AS session_count,
         COALESCE(SUM(CASE WHEN parent_session_id IS NOT NULL THEN 1 ELSE 0 END),0) AS subagent_count,
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

export interface ModelTokensRow {
  model: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
}

/**
 * Token sums grouped by model over a window, spanning all rows (sub-agents
 * included). Used to estimate cost, since pricing is per-model.
 */
export function tokensByModel(db: Database.Database, sinceIso?: string | null): ModelTokensRow[] {
  const where = sinceIso ? 'WHERE started_at >= @since' : '';
  const sql = `
    SELECT model,
           COALESCE(SUM(input_tokens),0)          AS input_tokens,
           COALESCE(SUM(output_tokens),0)         AS output_tokens,
           COALESCE(SUM(cache_read_tokens),0)     AS cache_read_tokens,
           COALESCE(SUM(cache_creation_tokens),0) AS cache_creation_tokens
    FROM sessions ${where}
    GROUP BY model
  `;
  return db.prepare(sql).all(sinceIso ? { since: sinceIso } : {}) as ModelTokensRow[];
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

export interface ErrorRow {
  /** Session that actually ran the failing tool (may be a sub-agent). */
  session_id: string;
  /** Top-level session for display/grouping. */
  top_session_id: string;
  top_title: string | null;
  project_path: string | null;
  project_hash: string;
  tool_name: string;
  file_path: string | null;
  command: string | null;
  error_text: string | null;
  called_at: string | null;
}

export interface ErrorFilters {
  sinceIso?: string | null;
  project?: string | null;
  tool?: string | null;
  limit?: number | null;
}

/**
 * Most recent failed tool calls across all sessions, newest first. Each row is
 * attributed to its top-level session (sub-agent failures surface the parent)
 * so a failure is always actionable.
 */
export function recentErrors(db: Database.Database, filters: ErrorFilters = {}): ErrorRow[] {
  const clauses: string[] = ['t.success = 0'];
  const params: Record<string, unknown> = {};

  if (filters.sinceIso) {
    clauses.push('top.started_at >= @since');
    params.since = filters.sinceIso;
  }
  if (filters.project) {
    clauses.push('(top.project_path LIKE @proj OR top.project_hash LIKE @proj)');
    params.proj = `%${filters.project}%`;
  }
  if (filters.tool) {
    clauses.push('t.tool_name = @tool COLLATE NOCASE');
    params.tool = filters.tool;
  }

  const limit = filters.limit && filters.limit > 0 ? Math.floor(filters.limit) : 20;
  const sql = `
    SELECT t.session_id, t.tool_name, t.file_path, t.command, t.error_text, t.called_at,
           top.id AS top_session_id, top.ai_title AS top_title,
           top.project_path, top.project_hash
    FROM tool_calls t
    JOIN sessions s   ON s.id = t.session_id
    JOIN sessions top ON top.id = COALESCE(s.parent_session_id, s.id)
    WHERE ${clauses.join(' AND ')}
    ORDER BY t.called_at DESC
    LIMIT ${limit}
  `;
  return db.prepare(sql).all(params) as ErrorRow[];
}
