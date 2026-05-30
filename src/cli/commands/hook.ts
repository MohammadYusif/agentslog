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
import { openDbReadonly } from '../../db/index.js';
import { type ErrorRow, recentErrors } from '../../db/queries.js';
import { normalizePath } from '../../parser/claude-code.js';
import { relativeTime } from '../../utils/time.js';
import { runIngest } from './ingest.js';

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
 * Build a PreToolUse advisory from past failures of the same tool, or null when
 * there's nothing relevant to warn about. Pure (db + payload in, object out) so
 * it's unit-testable without stdin.
 */
export function buildAdvisory(
  db: import('better-sqlite3').Database,
  payload: PreToolUsePayload,
): HookAdvisory | null {
  const tool = payload.tool_name;
  if (!tool) return null;

  const input = payload.tool_input ?? {};
  const command = typeof input.command === 'string' ? input.command : null;
  const filePath = typeof input.file_path === 'string' ? normalizePath(input.file_path) : null;

  // Past failures of this exact tool, newest first (uses idx_tc_success + tool).
  const past = recentErrors(db, { tool, limit: 50 });
  const matches = past.filter((e: ErrorRow) => {
    if (command && e.command) return commandsSimilar(command, e.command);
    if (filePath && e.file_path) return normalizePath(e.file_path) === filePath;
    // Tools without a command/file key (rare): treat any prior failure as a weak signal.
    return !command && !filePath;
  });
  if (matches.length === 0) return null;

  const lines = matches.slice(0, 3).map((e) => {
    const when = e.called_at ? relativeTime(e.called_at) : 'previously';
    const ctx = e.command ?? e.file_path ?? '';
    const err = (e.error_text ?? '').replace(/\s+/g, ' ').slice(0, 140);
    return `- ${when}: \`${ctx.slice(0, 80)}\` → ${err}`;
  });

  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      additionalContext:
        `⚠ agentslog memory: you (or a past session) hit ${matches.length} similar ${tool} ` +
        `failure(s) before:\n${lines.join('\n')}\nConsider adjusting before running this.`,
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
