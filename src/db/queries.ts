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
       ORDER BY (read_count + write_count + edit_count) DESC, file_path ASC`,
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
  sinceIso?: string | null,
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
  sinceIso?: string | null,
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
       FROM sessions ${where}`,
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
  const clauses: string[] = [
    't.success = 0',
    "(t.error_text IS NULL OR t.error_text NOT LIKE '%doesn''t want to proceed%')",
  ];
  const params: Record<string, unknown> = {};

  if (filters.sinceIso) {
    // Window on when the failure happened (its call time), not when the session
    // started — otherwise a recent failure in a long-running session is missed.
    // Fall back to the session start when a call has no timestamp.
    clauses.push('COALESCE(t.called_at, top.started_at) >= @since');
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

export interface ReasoningHit {
  session_id: string;
  ai_title: string | null;
  project_path: string | null;
  project_hash: string;
  source: string;
  started_at: string;
  sequence_num: number;
  snippet: string;
}

export interface ReasoningFilters {
  sinceIso?: string | null;
  limit?: number | null;
}

/**
 * Turn a free-text query into a safe FTS5 MATCH expression: extract word
 * tokens, quote each as a phrase, and AND them together. Avoids FTS5 syntax
 * errors from punctuation/operators in user input.
 */
function toFtsMatch(raw: string): string {
  const terms = raw.match(/[\p{L}\p{N}_]+/gu) ?? [];
  return terms.map((t) => `"${t}"`).join(' ');
}

/**
 * Full-text search the indexed reasoning ('thinking') blocks. Returns the
 * best-ranked matches with a highlighted snippet and their session context.
 * Empty when reasoning indexing was never enabled (table is empty).
 */
export function searchReasoning(
  db: Database.Database,
  query: string,
  filters: ReasoningFilters = {},
): ReasoningHit[] {
  const match = toFtsMatch(query);
  if (!match) return [];

  const limit = filters.limit && filters.limit > 0 ? Math.floor(filters.limit) : 20;
  const params: Record<string, unknown> = { match };
  let timeClause = '';
  if (filters.sinceIso) {
    timeClause = 'AND s.started_at >= @since';
    params.since = filters.sinceIso;
  }

  const sql = `
    SELECT r.session_id                          AS session_id,
           s.ai_title                            AS ai_title,
           s.project_path                        AS project_path,
           s.project_hash                        AS project_hash,
           s.source                              AS source,
           s.started_at                          AS started_at,
           CAST(r.sequence_num AS INTEGER)       AS sequence_num,
           snippet(reasoning_fts, 2, '[', ']', '…', 14) AS snippet
    FROM reasoning_fts r
    JOIN sessions s ON s.id = r.session_id
    WHERE reasoning_fts MATCH @match ${timeClause}
    ORDER BY rank
    LIMIT ${limit}
  `;
  return db.prepare(sql).all(params) as ReasoningHit[];
}

// ----------------------------------------------------------------------------
// Review / efficiency detection (v0.4)
// ----------------------------------------------------------------------------

/** Tunable thresholds for the deterministic inefficiency flags. */
export const REVIEW_THRESHOLDS = {
  /** Min tool calls before an error rate is meaningful. */
  minToolCallsForErrorRate: 5,
  /** Fraction of tool calls that failed to flag `high_error_rate`. */
  errorRate: 0.3,
  /** Identical failed command repeated this many times → `repeated_failure`. */
  repeatedFailure: 3,
  /** Tokens with zero reads AND zero changes → `high_spend_no_activity`. */
  highSpendTokens: 30_000,
  /** Tokens per change above this (with ≥1 change) → `high_tokens_per_change`. */
  tokensPerChange: 50_000,
};

/** Raw efficiency metrics for one session. */
export interface EfficiencyMetrics {
  toolCalls: number;
  errors: number;
  errorRate: number;
  reads: number;
  writes: number;
  edits: number;
  tokens: number;
  durationMs: number | null;
  /** Highest identical-failed-command repeat count in the session. */
  maxRepeat: number;
}

/**
 * Compute inefficiency flags from metrics. Flags are heuristic *candidates*,
 * not verdicts. `high_spend_no_activity` deliberately requires zero reads too,
 * so a legitimate deep research/plan phase (lots of reading, no edits) is not
 * punished.
 */
export function computeFlags(m: EfficiencyMetrics): string[] {
  const flags: string[] = [];
  const t = REVIEW_THRESHOLDS;
  const changes = m.writes + m.edits;
  if (m.toolCalls >= t.minToolCallsForErrorRate && m.errorRate >= t.errorRate) {
    flags.push('high_error_rate');
  }
  if (m.maxRepeat >= t.repeatedFailure) flags.push('repeated_failure');
  if (m.tokens >= t.highSpendTokens && changes === 0 && m.reads === 0) {
    flags.push('high_spend_no_activity');
  }
  if (changes > 0 && m.tokens / changes >= t.tokensPerChange) {
    flags.push('high_tokens_per_change');
  }
  return flags;
}

export interface RepeatedFailure {
  command: string;
  count: number;
  error_text: string | null;
}

/** Identical commands that failed two or more times in a session, worst first. */
export function repeatedFailures(db: Database.Database, sessionId: string): RepeatedFailure[] {
  return db
    .prepare(
      `SELECT command, COUNT(*) AS count, MAX(error_text) AS error_text
       FROM tool_calls
       WHERE session_id = ? AND success = 0 AND command IS NOT NULL AND command != ''
       GROUP BY command
       HAVING count >= 2
       ORDER BY count DESC, command ASC`,
    )
    .all(sessionId) as RepeatedFailure[];
}

export interface SessionEfficiency extends EfficiencyMetrics {
  sessionId: string;
  flags: string[];
  repeated: RepeatedFailure[];
}

/** Full efficiency report for one session, or null if it doesn't exist. */
export function sessionEfficiency(
  db: Database.Database,
  sessionId: string,
): SessionEfficiency | null {
  const row = db
    .prepare(
      `SELECT s.tool_call_count AS toolCalls, s.error_count AS errors,
              (s.input_tokens + s.output_tokens) AS tokens, s.duration_ms AS durationMs,
              COALESCE(ft.reads,0) AS reads, COALESCE(ft.writes,0) AS writes,
              COALESCE(ft.edits,0) AS edits
       FROM sessions s
       LEFT JOIN (
         SELECT session_id, SUM(read_count) reads, SUM(write_count) writes, SUM(edit_count) edits
         FROM files_touched GROUP BY session_id
       ) ft ON ft.session_id = s.id
       WHERE s.id = ?`,
    )
    .get(sessionId) as
    | (Omit<EfficiencyMetrics, 'errorRate' | 'maxRepeat'> & { durationMs: number | null })
    | undefined;
  if (!row) return null;

  const repeated = repeatedFailures(db, sessionId);
  const errorRate = row.toolCalls > 0 ? row.errors / row.toolCalls : 0;
  const maxRepeat = repeated.length > 0 ? repeated[0].count : 0;
  const metrics: EfficiencyMetrics = { ...row, errorRate, maxRepeat };
  return { sessionId, ...metrics, flags: computeFlags(metrics), repeated };
}

export interface ReviewCandidate extends EfficiencyMetrics {
  session_id: string;
  ai_title: string | null;
  project_path: string | null;
  project_hash: string;
  started_at: string;
  flags: string[];
}

/**
 * Top-level sessions in a window whose efficiency trips at least one flag,
 * most-flagged first. One query + in-JS scoring (cheap at this scale).
 */
export function reviewCandidates(
  db: Database.Database,
  sinceIso?: string | null,
  limit = 20,
): ReviewCandidate[] {
  // Window on when the session was last *active* (its newest tool call), not when
  // it started — so a long-running session with recent failures still surfaces.
  const where = sinceIso ? 'AND COALESCE(la.last_at, s.started_at) >= @since' : '';
  const rows = db
    .prepare(
      `SELECT s.id AS session_id, s.ai_title, s.project_path, s.project_hash, s.started_at,
              s.tool_call_count AS toolCalls, s.error_count AS errors,
              (s.input_tokens + s.output_tokens) AS tokens, s.duration_ms AS durationMs,
              COALESCE(ft.reads,0) AS reads, COALESCE(ft.writes,0) AS writes,
              COALESCE(ft.edits,0) AS edits, COALESCE(rf.max_repeat,0) AS maxRepeat
       FROM sessions s
       LEFT JOIN (
         SELECT session_id, SUM(read_count) reads, SUM(write_count) writes, SUM(edit_count) edits
         FROM files_touched GROUP BY session_id
       ) ft ON ft.session_id = s.id
       LEFT JOIN (
         SELECT session_id, MAX(n) AS max_repeat FROM (
           SELECT session_id, command, COUNT(*) AS n FROM tool_calls
           WHERE success = 0 AND command IS NOT NULL AND command != ''
           GROUP BY session_id, command
         ) GROUP BY session_id
       ) rf ON rf.session_id = s.id
       LEFT JOIN (
         SELECT session_id, MAX(called_at) AS last_at FROM tool_calls GROUP BY session_id
       ) la ON la.session_id = s.id
       WHERE s.parent_session_id IS NULL ${where}
       ORDER BY COALESCE(la.last_at, s.started_at) DESC`,
    )
    .all(sinceIso ? { since: sinceIso } : {}) as (Omit<ReviewCandidate, 'errorRate' | 'flags'> & {
    durationMs: number | null;
  })[];

  const out: ReviewCandidate[] = [];
  for (const r of rows) {
    const errorRate = r.toolCalls > 0 ? r.errors / r.toolCalls : 0;
    const metrics: EfficiencyMetrics = { ...r, errorRate };
    const flags = computeFlags(metrics);
    if (flags.length > 0) out.push({ ...r, errorRate, flags });
  }
  out.sort((a, b) => b.flags.length - a.flags.length);
  return out.slice(0, limit);
}

// ----------------------------------------------------------------------------
// Lessons store (v0.4)
// ----------------------------------------------------------------------------

export interface LessonRow {
  id: number;
  created_at: string;
  source: string;
  scope: string;
  tool: string | null;
  trigger: string | null;
  rule: string;
  rationale: string | null;
  source_session_id: string | null;
  confidence: number;
  hits: number;
  last_hit_at: string | null;
}

export interface LessonInput {
  rule: string;
  scope?: string;
  tool?: string | null;
  trigger?: string | null;
  rationale?: string | null;
  source?: string;
  sourceSessionId?: string | null;
  confidence?: number;
}

/**
 * Insert a lesson, de-duplicating on (scope, rule): a repeat keeps the higher
 * confidence and fills any missing tool/trigger/rationale. Returns the row id.
 */
export function insertLesson(db: Database.Database, input: LessonInput): number {
  const row = db
    .prepare(
      `INSERT INTO lessons
         (created_at, source, scope, tool, trigger, rule, rationale, source_session_id, confidence)
       VALUES
         (@createdAt, @source, @scope, @tool, @trigger, @rule, @rationale, @sourceSessionId, @confidence)
       ON CONFLICT(scope, rule) DO UPDATE SET
         confidence = MAX(lessons.confidence, excluded.confidence),
         tool       = COALESCE(excluded.tool, lessons.tool),
         trigger    = COALESCE(excluded.trigger, lessons.trigger),
         rationale  = COALESCE(excluded.rationale, lessons.rationale)
       RETURNING id`,
    )
    .get({
      createdAt: new Date().toISOString(),
      source: input.source ?? 'agent',
      scope: input.scope ?? 'global',
      tool: input.tool ?? null,
      trigger: input.trigger ?? null,
      rule: input.rule,
      rationale: input.rationale ?? null,
      sourceSessionId: input.sourceSessionId ?? null,
      confidence: input.confidence ?? 0.8,
    }) as { id: number };
  return row.id;
}

/** List lessons, optionally scoped to a project (plus 'global') or one scope. */
export function listLessons(
  db: Database.Database,
  filters: { scope?: string | null; includeGlobal?: boolean } = {},
): LessonRow[] {
  if (filters.scope) {
    const scopes = filters.includeGlobal !== false ? [filters.scope, 'global'] : [filters.scope];
    const placeholders = scopes.map(() => '?').join(', ');
    return db
      .prepare(
        `SELECT * FROM lessons WHERE scope IN (${placeholders})
         ORDER BY hits DESC, confidence DESC, id DESC`,
      )
      .all(...scopes) as LessonRow[];
  }
  return db
    .prepare('SELECT * FROM lessons ORDER BY hits DESC, confidence DESC, id DESC')
    .all() as LessonRow[];
}

/** Delete a lesson by id. Returns true if a row was removed. */
export function removeLesson(db: Database.Database, id: number): boolean {
  return db.prepare('DELETE FROM lessons WHERE id = ?').run(id).changes > 0;
}

export interface LessonContext {
  /** Project scope key (the normalized working directory). */
  project: string;
  tool?: string | null;
  command?: string | null;
  file?: string | null;
  limit?: number | null;
}

/**
 * Recall lessons relevant to the current project and (optionally) an imminent
 * action. With a command/file, only lessons whose `trigger` is null or appears
 * in that command/file are returned; with none (e.g. at session start), the top
 * scoped lessons are returned. Ordered by `hits` then `confidence`.
 */
export function lessonsForContext(db: Database.Database, ctx: LessonContext): LessonRow[] {
  const clauses = ['scope IN (@proj, @global)'];
  const params: Record<string, unknown> = { proj: ctx.project, global: 'global' };

  if (ctx.tool) {
    clauses.push('(tool IS NULL OR tool = @tool COLLATE NOCASE)');
    params.tool = ctx.tool;
  }

  const hasAction = Boolean(ctx.command || ctx.file);
  if (hasAction) {
    const subs: string[] = ['trigger IS NULL'];
    if (ctx.command) {
      subs.push('instr(lower(@command), lower(trigger)) > 0');
      params.command = ctx.command;
    }
    if (ctx.file) {
      subs.push('instr(lower(@file), lower(trigger)) > 0');
      params.file = ctx.file;
    }
    clauses.push(`(${subs.join(' OR ')})`);
  }

  const limit = ctx.limit && ctx.limit > 0 ? Math.floor(ctx.limit) : 5;
  return db
    .prepare(
      `SELECT * FROM lessons WHERE ${clauses.join(' AND ')}
       ORDER BY hits DESC, confidence DESC, id DESC LIMIT ${limit}`,
    )
    .all(params) as LessonRow[];
}

/** Bump the recall counters for lessons that were surfaced. */
export function recordLessonHit(db: Database.Database, ids: number[]): void {
  if (ids.length === 0) return;
  const now = new Date().toISOString();
  const stmt = db.prepare('UPDATE lessons SET hits = hits + 1, last_hit_at = ? WHERE id = ?');
  const tx = db.transaction((rows: number[]) => {
    for (const id of rows) stmt.run(now, id);
  });
  tx(ids);
}

// ----------------------------------------------------------------------------
// Meta key/value store + impact (before/after) analysis (v0.5)
// ----------------------------------------------------------------------------

/** Read a meta value by key, or null if unset. */
export function getMeta(db: Database.Database, key: string): string | null {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row ? row.value : null;
}

/** Upsert a meta value. */
export function setMeta(db: Database.Database, key: string, value: string): void {
  db.prepare(
    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, value);
}

/** Set a meta value only if the key is currently unset. Returns the value in effect. */
export function setMetaIfAbsent(db: Database.Database, key: string, value: string): string {
  const existing = getMeta(db, key);
  if (existing != null) return existing;
  setMeta(db, key, value);
  return value;
}

/**
 * The earliest session start time at which the agent actually *used* agentslog —
 * detected by an `mcp__agentslog__*` tool call in that session. This is the most
 * honest "adoption" signal for the impact report. Null if never used.
 */
export function firstAgentslogUseIso(db: Database.Database): string | null {
  const row = db
    .prepare(
      `SELECT MIN(s.started_at) AS iso
       FROM sessions s
       JOIN tool_calls t ON t.session_id = s.id
       WHERE t.tool_name LIKE 'mcp\\_\\_agentslog\\_\\_%' ESCAPE '\\'`,
    )
    .get() as { iso: string | null };
  return row.iso ?? null;
}

export interface WindowAggregate {
  session_count: number;
  tool_calls: number;
  errors: number;
  input_tokens: number;
  output_tokens: number;
  tokens: number;
}

/**
 * Aggregate activity over a half-open time window `[fromIso, toIso)`. Either
 * bound is optional. Counts only top-level sessions for `session_count` (so
 * per-session averages aren't diluted by sub-agents) but sums tokens/tools/errors
 * across every row, since sub-agent cost is real.
 */
export function aggregateWindow(
  db: Database.Database,
  bounds: { fromIso?: string | null; toIso?: string | null } = {},
): WindowAggregate {
  const clauses: string[] = [];
  const params: Record<string, unknown> = {};
  if (bounds.fromIso) {
    clauses.push('started_at >= @from');
    params.from = bounds.fromIso;
  }
  if (bounds.toIso) {
    clauses.push('started_at < @to');
    params.to = bounds.toIso;
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const row = db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN parent_session_id IS NULL THEN 1 ELSE 0 END),0) AS session_count,
         COALESCE(SUM(tool_call_count),0) AS tool_calls,
         COALESCE(SUM(error_count),0)     AS errors,
         COALESCE(SUM(input_tokens),0)    AS input_tokens,
         COALESCE(SUM(output_tokens),0)   AS output_tokens,
         COALESCE(SUM(input_tokens + output_tokens),0) AS tokens
       FROM sessions ${where}`,
    )
    .get(params) as WindowAggregate;
  return row;
}
