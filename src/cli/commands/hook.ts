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
import type Database from 'better-sqlite3';
import { openDb, openDbReadonly, recordLessonHitStandalone } from '../../db/index.js';
import {
  type ErrorRow,
  insertLesson,
  type LessonRow,
  lessonsForContext,
  recentErrors,
  recordLessonHit,
  repeatedFailures,
  sessionEfficiency,
} from '../../db/queries.js';
import { normalizePath } from '../../parser/claude-code.js';
import { relativeTime } from '../../utils/time.js';
import { runIngest } from './ingest.js';

/** Substring present in Claude Code's "file not pre-read" error messages. */
const FILE_NOT_READ_PATTERN = 'has not been read';

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
 * there's nothing relevant. Pure (db + payload in, object out) — unit-testable
 * without stdin. Read-only: does not bump lesson hit counts (PreToolUse is the
 * hot path; recall accounting happens in the SessionStart hook instead).
 */
export function buildAdvisory(
  db: Database.Database,
  payload: PreToolUsePayload,
): HookAdvisory | null {
  const tool = payload.tool_name;
  if (!tool) return null;

  const input = payload.tool_input ?? {};
  const command = typeof input.command === 'string' ? input.command : null;
  const filePath = typeof input.file_path === 'string' ? normalizePath(input.file_path) : null;

  const sections: string[] = [];

  // (a) Distilled lessons that match this tool + command/file.
  const lessons = lessonsForContext(db, {
    project: payload.cwd ? normalizePath(payload.cwd) : '',
    tool,
    command,
    file: filePath,
    limit: 3,
  });
  if (lessons.length > 0) {
    const ls = lessons.map((l: LessonRow) => `- ${l.rule}`).join('\n');
    sections.push(`📌 Lesson(s) you've recorded for this:\n${ls}`);
    // Bump hits only for lessons that actually fired — not all lessons at session start.
    try { recordLessonHitStandalone(lessons.map((l: LessonRow) => l.id)); } catch { /* non-fatal */ }
  }

  // (b) Raw past failures of this exact tool, newest first.
  const past = recentErrors(db, { tool, limit: 50 });
  const matches = past.filter((e: ErrorRow) => {
    if (command && e.command) return commandsSimilar(command, e.command);
    if (filePath && e.file_path) return normalizePath(e.file_path) === filePath;
    return !command && !filePath;
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

  // For Edit/Write: scan all past errors of this tool for the "file not read"
  // pattern — it's tool-level, not file-specific, so the per-file match above
  // misses it for files that haven't failed before.
  // Skip if the per-file match already surfaced this exact pattern to avoid
  // emitting two warnings for the same root cause.
  if (tool === 'Edit' || tool === 'Write') {
    const alreadyCoveredByFileMatch = matches.some((m: ErrorRow) =>
      (m.error_text ?? '').includes(FILE_NOT_READ_PATTERN),
    );
    if (!alreadyCoveredByFileMatch) {
      const unreadCount = past.filter((e: ErrorRow) =>
        (e.error_text ?? '').includes(FILE_NOT_READ_PATTERN),
      ).length;
      if (unreadCount > 0) {
        sections.push(
          `🔒 Read ${filePath ? `\`${filePath}\`` : 'the file'} before calling ${tool} — ` +
            `past sessions hit "File has not been read yet" ${unreadCount}× with this tool.`,
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
 * "identical command failed ≥3×" case fires — high precision, low noise.
 * Returns how many lessons were written.
 */
export function reflectOnSession(db: Database.Database, sessionId: string): number {
  const row = db.prepare('SELECT project_path FROM sessions WHERE id = ?').get(sessionId) as
    | { project_path: string | null }
    | undefined;
  const scope = row?.project_path ? normalizePath(row.project_path) : 'global';

  let written = 0;

  // Bash: identical command failed multiple times.
  for (const rf of repeatedFailures(db, sessionId)) {
    if (rf.count < 2) continue;
    const shape = commandShape(rf.command);
    const trigger = [shape.program, ...shape.flags].join(' ').slice(0, 60).trim();
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
         AND error_text LIKE '%${FILE_NOT_READ_PATTERN}%'
       GROUP BY tool_name
       HAVING COUNT(*) >= 2`,
    )
    .all(sessionId) as { tool_name: string; count: number }[];

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
  const db = openDb(); // writable: SessionStart bumps recall counters

  // Top 5 lessons for this project + global, ranked by hits then confidence.
  // Hits are NOT bumped here — they're bumped in buildAdvisory() when a lesson
  // actually fires for a specific tool call, giving meaningful per-lesson signal.
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
