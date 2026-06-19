/**
 * `agentslog hook <check|ingest>` — Claude Code hook integrations.
 *
 * - `check`  (PreToolUse): reads the tool call from stdin and, if the same tool
 *   has failed before in a recognizably similar way, emits a non-blocking
 *   advisory so the agent can avoid repeating the mistake. Must stay fast
 *   (Claude Code blocks tool execution while the hook runs): one indexed query
 *   over a read-only connection, no ingest, minimal output.
 * - `ingest` (Stop/SessionEnd): refreshes the index so cross-session memory
 *   stays current in real time.
 */
import fs from 'node:fs';
import type Database from 'better-sqlite3';
import { openDb, openDbReadonly, recordLessonHitStandalone } from '../../db/index.js';
import {
  type ErrorRow,
  insertLesson,
  type LessonRow,
  lessonsForContext,
  recentErrors,
  repeatedFailures,
  sessionEfficiency,
} from '../../db/queries.js';
import { extractFilePath, normalizePath } from '../../parser/claude-code.js';
import { FILE_MODIFIED_SINCE_READ_PATTERN, FILE_NOT_READ_PATTERN } from '../../parser/constants.js';
import { relativeTime, windowCutoffIso } from '../../utils/time.js';
import { runIngest } from './ingest.js';

/**
 * Gate for calls with no command/file context (Skill, MCP tools, bare Glob, …):
 * there is nothing to match similarity on, so raw past failures are surfaced
 * only as a one-line frequency summary, and only when the tool has failed at
 * least this many times within {@link NO_CONTEXT_WINDOW}.
 */
const NO_CONTEXT_MIN_FAILURES = 3;
const NO_CONTEXT_WINDOW = '7d';

/** Read all of stdin (hooks pipe JSON in). Empty string if attached to a TTY. */
async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf-8');
}

interface PreToolUsePayload {
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  cwd?: string;
}

/** Program + flags + first-two-tokens fingerprint of a shell command. */
function commandShape(cmd: string): { program: string; flags: Set<string>; head: string } {
  const tokens = cmd.trim().split(/\s+/);
  return {
    program: (tokens[0] ?? '').toLowerCase(),
    flags: new Set(tokens.filter((t) => t.startsWith('-'))),
    head: tokens.slice(0, 2).join(' ').toLowerCase(),
  };
}

/** True when two shell commands look like "the same kind of command". */
function commandsSimilar(a: string, b: string): boolean {
  const x = commandShape(a);
  const y = commandShape(b);
  if (!x.program || x.program !== y.program) return false;
  for (const f of x.flags) if (y.flags.has(f)) return true; // shared flag
  return x.head === y.head; // same program + first arg
}

export interface HookAdvisory {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse';
    additionalContext: string;
  };
}

/**
 * Build a PreToolUse advisory combining (a) distilled lessons that match the
 * imminent action and (b) raw past failures of the same tool, or null when
 * there's nothing relevant. Unit-testable without stdin (db + payload in,
 * object out). Bumps the hit counter of each lesson that fires — that happens
 * here (not at session start) so `hits` reflects real recall, not noise.
 */
export function buildAdvisory(
  db: Database.Database,
  payload: PreToolUsePayload,
): HookAdvisory | null {
  const tool = payload.tool_name;
  if (!tool) return null;

  const input = payload.tool_input ?? {};
  const command = typeof input.command === 'string' ? input.command : null;
  // Same per-tool extraction as ingest (file_path for Edit/Read/…, path for
  // Grep/Glob), so the value compares against what tool_calls.file_path stores.
  const filePath = extractFilePath(tool, input);

  const sections: string[] = [];

  // (a) Distilled lessons that match this tool + command/file.
  // requireRelevance: a triggered lesson must only fire when its trigger
  // appears in the command/file. For a contextless tool call (MCP tools,
  // ToolSearch, a bare Glob) there's nothing to match, so only triggerless
  // lessons surface — otherwise every tool-agnostic lesson leaks in by hits.
  const lessons = lessonsForContext(db, {
    project: payload.cwd ? normalizePath(payload.cwd) : '',
    tool,
    command,
    file: filePath,
    limit: 3,
    requireRelevance: true,
  });
  if (lessons.length > 0) {
    const ls = lessons.map((l: LessonRow) => `- ${l.rule}`).join('\n');
    sections.push(`📌 Lesson(s) you've recorded for this:\n${ls}`);
    // Bump hits only for lessons that actually fired — not all lessons at session start.
    try {
      recordLessonHitStandalone(lessons.map((l: LessonRow) => l.id));
    } catch {
      /* non-fatal */
    }
  }

  // (b) Raw past failures of this exact tool, newest first.
  //
  // With a command or file path we can match on similarity. Without either
  // (Skill, MCP tools, a bare Glob, …) there is nothing to compare, so listing
  // past failures would just replay every failure of the tool regardless of
  // relevance — noise that trains the agent to ignore the advisories. In that
  // case only a frequency signal is surfaced: the tool failing repeatedly in
  // the last few days is worth a heads-up even without a specific match.
  const hasContext = Boolean(command || filePath);
  let matches: ErrorRow[] = [];
  if (hasContext) {
    const past = recentErrors(db, { tool, limit: 50 });
    matches = past.filter((e: ErrorRow) => {
      if (command && e.command) return commandsSimilar(command, e.command);
      if (filePath && e.file_path) return normalizePath(e.file_path) === filePath;
      return false;
    });
    if (matches.length > 0) {
      const lines = matches.slice(0, 3).map((e) => {
        const when = e.called_at ? relativeTime(e.called_at) : 'previously';
        const ctx = e.command ?? e.file_path ?? '';
        const err = (e.error_text ?? '').replace(/\s+/g, ' ').slice(0, 140);
        return `- ${when}: \`${ctx.slice(0, 80)}\` → ${err}`;
      });
      sections.push(`⚠ ${matches.length} similar ${tool} failure(s) before:\n${lines.join('\n')}`);
    }
  } else {
    const recent = recentErrors(db, {
      tool,
      sinceIso: windowCutoffIso(NO_CONTEXT_WINDOW),
      limit: NO_CONTEXT_MIN_FAILURES,
    });
    if (recent.length >= NO_CONTEXT_MIN_FAILURES) {
      const latest = recent[0];
      const err = (latest.error_text ?? '').replace(/\s+/g, ' ').slice(0, 120);
      sections.push(
        `⚠ ${tool} has failed ${recent.length}+ time(s) in the last ${NO_CONTEXT_WINDOW} — ` +
          `most recent: ${err}`,
      );
    }
  }

  // For Edit/Write: scan all past errors of this tool for the "file not read"
  // pattern — it's tool-level, not file-specific, so the per-file match above
  // misses it for files that haven't failed before.
  // Skip if the per-file match already surfaced this exact pattern (two
  // warnings for one root cause), and skip when Write targets a file that
  // does not exist yet — creating a new file requires no prior Read.
  const isNewFileWrite = tool === 'Write' && filePath != null && !fs.existsSync(filePath);
  if ((tool === 'Edit' || tool === 'Write') && !isNewFileWrite) {
    const alreadyCoveredByFileMatch = matches.some((m: ErrorRow) =>
      (m.error_text ?? '').includes(FILE_NOT_READ_PATTERN),
    );
    if (!alreadyCoveredByFileMatch) {
      const unreadCount = recentErrors(db, { tool, limit: 50 }).filter((e: ErrorRow) =>
        (e.error_text ?? '').includes(FILE_NOT_READ_PATTERN),
      ).length;
      if (unreadCount > 0) {
        sections.push(
          `🔒 Read ${filePath ? `\`${filePath}\`` : 'the file'} before calling ${tool} — ` +
            `past sessions hit "File has not been read yet" ${unreadCount}× with this tool.`,
        );
      }
    }

    // Sibling to the not-read pattern: a linter/formatter can rewrite the file
    // between the Read and the Edit ("File has been modified since read"). This
    // survives an initial Read, so the fix is to re-Read immediately before the
    // Edit (don't interleave other tool calls). Tool-level, like the above.
    const modifiedAlreadyCovered = matches.some((m: ErrorRow) =>
      (m.error_text ?? '').includes(FILE_MODIFIED_SINCE_READ_PATTERN),
    );
    if (!modifiedAlreadyCovered) {
      const modifiedCount = recentErrors(db, { tool, limit: 50 }).filter((e: ErrorRow) =>
        (e.error_text ?? '').includes(FILE_MODIFIED_SINCE_READ_PATTERN),
      ).length;
      if (modifiedCount > 0) {
        sections.push(
          `🔄 Re-Read ${filePath ? `\`${filePath}\`` : 'the file'} immediately before this ${tool} — ` +
            `past sessions hit "File has been modified since read" ${modifiedCount}× ` +
            `(a linter/formatter rewrote it between Read and ${tool}).`,
        );
      }
    }
  }

  if (sections.length === 0) return null;

  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      additionalContext: `agentslog memory:\n${sections.join('\n\n')}\nConsider this before running.`,
    },
  };
}

/** `agentslog hook check` — PreToolUse advisory. Always exits 0 (non-blocking). */
export async function runHookCheck(): Promise<void> {
  const raw = await readStdin();
  let payload: PreToolUsePayload;
  try {
    payload = JSON.parse(raw) as PreToolUsePayload;
  } catch {
    return; // no/invalid payload → say nothing
  }

  const db = openDbReadonly();
  const advisory = buildAdvisory(db, payload);
  if (advisory) process.stdout.write(`${JSON.stringify(advisory)}\n`);
}

/** `agentslog hook ingest` — Stop/SessionEnd refresh. Silent (hook context). */
export async function runHookIngest(): Promise<void> {
  await runIngest({ quiet: true, silent: true });
}

interface SessionHookPayload {
  session_id?: string;
  cwd?: string;
}

/**
 * Record deterministic auto-lessons from the failures of a just-finished
 * session. Pure (db + ids in) so it's unit-testable. Only the unambiguous
 * "identical command failed ≥2×" case fires — high precision, low noise.
 * Returns how many lessons were written.
 */
export function reflectOnSession(db: Database.Database, sessionId: string): number {
  const row = db.prepare('SELECT project_path FROM sessions WHERE id = ?').get(sessionId) as
    | { project_path: string | null }
    | undefined;
  const scope = row?.project_path ? normalizePath(row.project_path) : 'global';

  let written = 0;

  // Bash: identical command failed multiple times. Dedup by (scope, trigger):
  // the rule text embeds the exact command and error, so without this check
  // every variant of the same kind of failure would pile up as a new lesson.
  const autoLessonExists = db.prepare(
    `SELECT 1 FROM lessons
     WHERE source = 'auto' AND scope = ? AND tool = ? AND trigger = ?
     LIMIT 1`,
  );
  for (const rf of repeatedFailures(db, sessionId)) {
    if (rf.count < 2) continue;
    const shape = commandShape(rf.command);
    const trigger = [shape.program, ...shape.flags].join(' ').slice(0, 60).trim();
    if (trigger && autoLessonExists.get(scope, 'Bash', trigger)) continue;
    const err = (rf.error_text ?? '').replace(/\s+/g, ' ').slice(0, 120);
    insertLesson(db, {
      rule: `\`${rf.command.slice(0, 80)}\` failed ${rf.count}× in a row: ${err}`,
      tool: 'Bash',
      trigger: trigger || null,
      scope,
      source: 'auto',
      confidence: 0.6,
      sourceSessionId: sessionId,
    });
    written++;
  }

  // Edit / Write: "File has not been read yet" — tool-level hard constraint.
  // Only record if no existing auto-lesson already covers this tool to avoid
  // growing duplicates across sessions.
  const unreadByTool = db
    .prepare(
      `SELECT tool_name, COUNT(*) AS count
       FROM tool_calls
       WHERE session_id = ? AND success = 0
         AND tool_name IN ('Edit', 'Write')
         AND error_text LIKE ?
       GROUP BY tool_name
       HAVING COUNT(*) >= 2`,
    )
    .all(sessionId, `%${FILE_NOT_READ_PATTERN}%`) as { tool_name: string; count: number }[];

  for (const rf of unreadByTool) {
    const alreadyExists = db
      .prepare(
        `SELECT 1 FROM lessons
         WHERE tool = ? AND source = 'auto' AND trigger = ?
         LIMIT 1`,
      )
      .get(rf.tool_name, rf.tool_name);
    if (alreadyExists) continue;

    insertLesson(db, {
      rule: `Always Read a file before calling ${rf.tool_name} — "File has not been read yet" occurred ${rf.count}× in this session. This is a hard constraint, not a style note.`,
      tool: rf.tool_name,
      trigger: rf.tool_name,
      scope: 'global', // applies everywhere, not just this project
      source: 'auto',
      confidence: 0.75,
      sourceSessionId: sessionId,
    });
    written++;
  }

  return written;
}

/**
 * `agentslog hook reflect` — Stop: refresh the index, then learn from the
 * session that just finished. Silent (hook context).
 */
export async function runHookReflect(): Promise<void> {
  const raw = await readStdin();
  let payload: SessionHookPayload;
  try {
    payload = JSON.parse(raw) as SessionHookPayload;
  } catch {
    payload = {};
  }
  // Refresh so the just-finished session is indexed before we reflect on it.
  await runIngest({ quiet: true, silent: true });
  if (!payload.session_id) return;
  const db = openDb();
  reflectOnSession(db, payload.session_id);
}

/**
 * `agentslog hook session-start` — SessionStart: surface the top lessons for
 * this project (plus global) and, if the most recent session here was flagged
 * inefficient, nudge the agent to record a lesson. Emits additionalContext.
 */
export async function runHookSessionStart(): Promise<void> {
  const raw = await readStdin();
  let payload: SessionHookPayload;
  try {
    payload = JSON.parse(raw) as SessionHookPayload;
  } catch {
    return;
  }
  const project = payload.cwd ? normalizePath(payload.cwd) : '';
  // Read-only: hits are NOT bumped here — they're bumped in buildAdvisory()
  // when a lesson actually fires for a specific tool call, giving meaningful
  // per-lesson signal.
  const db = openDbReadonly();

  // Top 5 lessons for this project + global, ranked by hits then confidence.
  const lessons = lessonsForContext(db, { project, limit: 5 });

  // Was the most recent session in this project flagged inefficient?
  let nudge: string | null = null;
  const last = db
    .prepare(
      `SELECT id FROM sessions
       WHERE parent_session_id IS NULL AND project_path = ?
       ORDER BY started_at DESC LIMIT 1`,
    )
    .get(project) as { id: string } | undefined;
  if (last) {
    const eff = sessionEfficiency(db, last.id);
    if (eff && eff.flags.length > 0) {
      nudge =
        `Your last session here was flagged (${eff.flags.join(', ')}). ` +
        'If you learned something durable, call the agentslog record_lesson tool.';
    }
  }

  const parts: string[] = [];
  if (lessons.length > 0) {
    parts.push(`Lessons to keep in mind:\n${lessons.map((l) => `- ${l.rule}`).join('\n')}`);
  }
  if (nudge) parts.push(nudge);
  if (parts.length === 0) return;

  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: `agentslog memory:\n${parts.join('\n\n')}`,
      },
    })}\n`,
  );
}
