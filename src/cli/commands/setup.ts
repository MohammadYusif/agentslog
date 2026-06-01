/**
 * `agentslog setup` — one-command, transparent, idempotent installer.
 *
 * Wires agentslog into Claude Code so every project benefits automatically:
 *   • registers the MCP server at user scope,
 *   • writes a managed instruction block to ~/.claude/CLAUDE.md,
 *   • (opt-in) installs PreToolUse/Stop/SessionStart hooks,
 *   • runs an initial ingest and records an adoption timestamp.
 *
 * Everything it changes is printed. Components are individually selectable via
 * flags or an interactive picker. The file-mutating pieces are pure functions
 * (exported for tests); the orchestrator wires them to disk and the `claude` CLI.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import chalk from 'chalk';
import { openDb } from '../../db/index.js';
import { setMeta, setMetaIfAbsent } from '../../db/queries.js';
import { SCHEMA_VERSION } from '../../db/schema.js';
import { claudeSettingsPath, globalClaudeMd } from '../../utils/paths.js';
import { runIngest } from './ingest.js';

export const BLOCK_START = '<!-- agentslog:start -->';
export const BLOCK_END = '<!-- agentslog:end -->';

/** Canonical CLAUDE.md instruction block (between the managed markers). */
export const MEMORY_BLOCK = `## agentslog — your own coding history

You have the \`agentslog\` MCP server: a searchable index of your past coding-agent
sessions (every tool call, file edit, error, and recorded lesson) across all
projects on this machine. Use it to avoid repeating past mistakes.

- **Before a tricky, slow, or destructive shell command**, call \`recent_errors\`
  to check whether you (or a past session) already failed at it, and why.
- **Before editing a file you've struggled with**, call \`find_sessions_by_file\`
  to see what previously changed there and what broke.
- **Check \`list_lessons\`** when unsure how to do something in a project.
- **When you discover a non-obvious gotcha**, call \`record_lesson\` (with a short
  exact \`trigger\`, e.g. \`ls -Recurse\`) so future sessions avoid the mistake.

### When something breaks, diagnose with agentslog first

Treat agentslog as the first diagnostic step for any error or "this used to work"
regression — before guessing or re-reading code. Chain the tools like a debugger:

- An **error or failed command** → \`recent_errors\` (filter by the failing tool
  and project) to see if it happened before and how it was resolved.
- A **file misbehaving** → \`find_sessions_by_file\`, then \`get_session\` on the
  suspect run for its full tool-call trace.
- **"It worked yesterday"** → find the last good run and \`get_session\` both to
  compare what diverged.
- **Before undoing past work** → \`search_reasoning\` to recover the original
  intent so you don't reintroduce a bug a past session fixed.
- **After the fix** → \`record_lesson\` so the next occurrence is caught instantly.`;

/**
 * Insert or replace the managed agentslog block in an existing CLAUDE.md body.
 * Idempotent: if the markers are present the block between them is replaced;
 * otherwise the block is appended. Pure (no I/O).
 */
export function upsertManagedBlock(existing: string | null, block: string): string {
  const managed = `${BLOCK_START}\n${block}\n${BLOCK_END}`;
  const body = existing ?? '';
  const start = body.indexOf(BLOCK_START);
  const end = body.indexOf(BLOCK_END);
  if (start !== -1 && end !== -1 && end > start) {
    const before = body.slice(0, start);
    const after = body.slice(end + BLOCK_END.length);
    return `${before}${managed}${after}`
      .replace(/\n{3,}/g, '\n\n')
      .trimEnd()
      .concat('\n');
  }
  const sep = body.trim().length > 0 ? `${body.trimEnd()}\n\n` : '';
  return `${sep}${managed}\n`;
}

// ---------------------------------------------------------------------------
// Tolerant JSON (settings.json may carry comments / trailing commas)
// ---------------------------------------------------------------------------

/** Strip // line and /* block *\/ comments, respecting string literals. */
export function stripJsonComments(text: string): string {
  let out = '';
  let inString = false;
  let quote = '';
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];
    if (inString) {
      out += c;
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === quote) inString = false;
      continue;
    }
    if (c === '"' || c === "'") {
      inString = true;
      quote = c;
      out += c;
      continue;
    }
    if (c === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      if (i < text.length) out += '\n';
      continue;
    }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i++; // skip the closing '/'
      continue;
    }
    out += c;
  }
  return out;
}

/** Remove trailing commas before } or ]. */
export function stripTrailingCommas(text: string): string {
  return text.replace(/,(\s*[}\]])/g, '$1');
}

/**
 * Parse JSON, tolerating comments and trailing commas. Throws (like JSON.parse)
 * only if the text is unsalvageable — callers must NOT overwrite the file then.
 */
export function lenientJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return JSON.parse(stripTrailingCommas(stripJsonComments(text)));
  }
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

interface HookCmd {
  type: 'command';
  command: string;
}
interface HookEntry {
  matcher?: string;
  hooks: HookCmd[];
}
interface Settings {
  hooks?: Record<string, HookEntry[]>;
  disableAllHooks?: boolean;
  [k: string]: unknown;
}

/** The agentslog hooks we install, by Claude Code event name. */
export const DESIRED_HOOKS: { event: string; entry: HookEntry }[] = [
  { event: 'PreToolUse', entry: { matcher: 'Bash', hooks: [cmd('agentslog hook check')] } },
  { event: 'Stop', entry: { hooks: [cmd('agentslog hook reflect')] } },
  { event: 'SessionStart', entry: { hooks: [cmd('agentslog hook session-start')] } },
];

function cmd(command: string): HookCmd {
  return { type: 'command', command };
}

/**
 * Merge the agentslog hook entries into a settings object, deduped by command
 * string (re-running is a no-op). Pure: returns a new object + the commands
 * actually added. Preserves every other key untouched.
 */
export function mergeHooks(settings: Settings): { settings: Settings; added: string[] } {
  const next: Settings = { ...settings, hooks: { ...(settings.hooks ?? {}) } };
  const hooks = next.hooks as Record<string, HookEntry[]>;
  const added: string[] = [];
  for (const { event, entry } of DESIRED_HOOKS) {
    const list = [...(hooks[event] ?? [])];
    hooks[event] = list;
    const command = entry.hooks[0].command;
    const present = list.some((e) => e.hooks?.some((h) => h.command === command));
    if (!present) {
      list.push(entry);
      added.push(command);
    }
  }
  return { settings: next, added };
}

// ---------------------------------------------------------------------------
// Filesystem helpers
// ---------------------------------------------------------------------------

/** Throw a clean, actionable error if `target` (or its parent dir) isn't writable. */
function assertWritable(target: string): void {
  if (fs.existsSync(target)) {
    try {
      fs.accessSync(target, fs.constants.W_OK);
      return;
    } catch {
      throw new Error(`no write permission for ${target} — check file permissions`);
    }
  }
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true });
  try {
    fs.accessSync(dir, fs.constants.W_OK);
  } catch {
    throw new Error(`cannot create ${target} — ${dir} is not writable`);
  }
}

// ---------------------------------------------------------------------------
// MCP registration (the one place we shell out to the `claude` CLI)
// ---------------------------------------------------------------------------

type McpState = 'present' | 'absent' | 'no-cli';

function runClaude(args: string[]): void {
  // shell:true on Windows so the `claude.cmd` shim on PATH resolves correctly.
  execFileSync('claude', args, { stdio: 'ignore', shell: process.platform === 'win32' });
}

function detectMcp(): McpState {
  try {
    runClaude(['mcp', 'get', 'agentslog']);
    return 'present';
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === 'ENOENT' ? 'no-cli' : 'absent';
  }
}

const MCP_MANUAL = 'claude mcp add agentslog --scope user -- agentslog mcp';

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export interface SetupOptions {
  mcp?: boolean; // default true; false via --no-mcp
  memory?: boolean; // default true; false via --no-memory
  withHooks?: boolean; // opt-in
  withReasoning?: boolean; // opt-in
  ingest?: boolean; // default true; false via --no-ingest
  dryRun?: boolean;
  interactive?: boolean;
  yes?: boolean;
}

type Status = 'applied' | 'already' | 'skipped' | 'would' | 'failed';
interface ActionResult {
  label: string;
  status: Status;
  detail?: string;
}

const ICON: Record<Status, string> = {
  applied: chalk.green('✓'),
  already: chalk.blue('•'),
  skipped: chalk.yellow('○'),
  would: chalk.cyan('»'),
  failed: chalk.red('✗'),
};

async function confirm(question: string, defaultYes: boolean): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const hint = defaultYes ? 'Y/n' : 'y/N';
    const answer = (await rl.question(`${question} [${hint}] `)).trim().toLowerCase();
    if (answer === '') return defaultYes;
    return answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}

/** Resolve which components to run, honoring flags then (optionally) prompts. */
async function resolveComponents(o: SetupOptions): Promise<{
  mcp: boolean;
  memory: boolean;
  hooks: boolean;
  reasoning: boolean;
}> {
  const mcpFlag = o.mcp === false; // --no-mcp passed
  const memoryFlag = o.memory === false; // --no-memory passed
  const hooksFlag = o.withHooks === true;
  const reasoningFlag = o.withReasoning === true;

  if (!o.interactive) {
    return {
      mcp: o.mcp !== false,
      memory: o.memory !== false,
      hooks: Boolean(o.withHooks),
      reasoning: Boolean(o.withReasoning),
    };
  }
  // Interactive: prompt unless the flag was explicitly set. Enter = recommended.
  return {
    mcp: mcpFlag ? false : await confirm('Register the agentslog MCP server globally?', true),
    memory: memoryFlag
      ? false
      : await confirm('Add the agentslog instruction to ~/.claude/CLAUDE.md?', true),
    hooks: hooksFlag ? true : await confirm('Install hooks (slight per-command latency)?', false),
    reasoning: reasoningFlag
      ? true
      : await confirm('Index reasoning (thinking) for search?', false),
  };
}

export async function runSetup(o: SetupOptions = {}): Promise<void> {
  const dry = Boolean(o.dryRun);
  const pick = await resolveComponents(o);
  const results: ActionResult[] = [];
  const out = (s: string) => process.stdout.write(s);

  out(
    `${chalk.bold('agentslog setup')}${dry ? chalk.dim('  (dry run — no changes written)') : ''}\n\n`,
  );

  // 1. MCP server (user scope) -----------------------------------------------
  if (pick.mcp) {
    if (dry) {
      results.push({ label: 'MCP server (user scope)', status: 'would', detail: MCP_MANUAL });
    } else {
      const state = detectMcp();
      if (state === 'present') {
        results.push({ label: 'MCP server (user scope)', status: 'already' });
      } else if (state === 'no-cli') {
        results.push({
          label: 'MCP server (user scope)',
          status: 'skipped',
          detail: `claude CLI not found — register manually:\n    ${MCP_MANUAL}`,
        });
      } else {
        try {
          runClaude(['mcp', 'add', 'agentslog', '--scope', 'user', '--', 'agentslog', 'mcp']);
          results.push({ label: 'MCP server (user scope)', status: 'applied', detail: MCP_MANUAL });
        } catch (err) {
          results.push({
            label: 'MCP server (user scope)',
            status: 'failed',
            detail: `${(err as Error).message}\n    register manually: ${MCP_MANUAL}`,
          });
        }
      }
    }
  } else {
    results.push({ label: 'MCP server (user scope)', status: 'skipped', detail: 'deselected' });
  }

  // 2. Global memory (~/.claude/CLAUDE.md) -----------------------------------
  if (pick.memory) {
    const file = globalClaudeMd();
    if (dry) {
      results.push({ label: 'Memory → ~/.claude/CLAUDE.md', status: 'would', detail: file });
    } else {
      try {
        assertWritable(file);
        const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : null;
        const updated = upsertManagedBlock(existing, MEMORY_BLOCK);
        if (existing === updated) {
          results.push({ label: 'Memory → ~/.claude/CLAUDE.md', status: 'already' });
        } else {
          fs.writeFileSync(file, updated, 'utf-8');
          results.push({
            label: 'Memory → ~/.claude/CLAUDE.md',
            status: 'applied',
            detail: existing == null ? `created ${file}` : `updated ${file}`,
          });
        }
      } catch (err) {
        results.push({
          label: 'Memory → ~/.claude/CLAUDE.md',
          status: 'failed',
          detail: (err as Error).message,
        });
      }
    }
  } else {
    results.push({
      label: 'Memory → ~/.claude/CLAUDE.md',
      status: 'skipped',
      detail: 'deselected',
    });
  }

  // 3. Hooks (opt-in) ---------------------------------------------------------
  if (pick.hooks) {
    const file = claudeSettingsPath();
    if (dry) {
      results.push({ label: 'Hooks → ~/.claude/settings.json', status: 'would', detail: file });
    } else {
      try {
        assertWritable(file);
        const raw = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : '{}';
        let parsed: Settings;
        try {
          parsed = (raw.trim() ? (lenientJsonParse(raw) as Settings) : {}) ?? {};
        } catch {
          throw new Error(
            `${file} is not valid JSON — fix it by hand, then re-run (left unchanged)`,
          );
        }
        const { settings, added } = mergeHooks(parsed);
        if (added.length === 0) {
          results.push({ label: 'Hooks → ~/.claude/settings.json', status: 'already' });
        } else {
          fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`, 'utf-8');
          const warn =
            settings.disableAllHooks === true
              ? '  ' +
                chalk.yellow(
                  'note: "disableAllHooks": true is set — hooks won\'t fire until you remove it',
                )
              : '';
          results.push({
            label: 'Hooks → ~/.claude/settings.json',
            status: 'applied',
            detail: `added ${added.length} hook(s)${warn ? `\n${warn}` : ''}`,
          });
        }
      } catch (err) {
        results.push({
          label: 'Hooks → ~/.claude/settings.json',
          status: 'failed',
          detail: (err as Error).message,
        });
      }
    }
  }

  // 4. Initial ingest + adoption metadata ------------------------------------
  if (o.ingest !== false && !dry) {
    const db = openDb();
    setMetaIfAbsent(db, 'setup_at', new Date().toISOString());
    setMeta(db, 'setup_version', String(SCHEMA_VERSION));
    out(`\n${chalk.bold('Indexing your history…')}\n`);
    await runIngest({ quiet: true, reasoning: pick.reasoning });
    out('\n');
  } else if (o.ingest !== false && dry) {
    results.push({ label: 'Initial ingest', status: 'would', detail: 'index existing sessions' });
  }

  if (pick.reasoning) {
    results.push({
      label: 'Reasoning indexing',
      status: dry ? 'would' : 'applied',
      detail:
        'enabled for this ingest. To make it permanent, set AGENTSLOG_INDEX_REASONING=1 in your shell profile.',
    });
  }

  // Summary ------------------------------------------------------------------
  out(`${chalk.bold('Summary')}\n`);
  for (const r of results) {
    out(
      `  ${ICON[r.status]} ${r.label}${r.status === 'already' ? chalk.dim(' (already configured)') : ''}\n`,
    );
    if (r.detail) out(`      ${chalk.dim(r.detail)}\n`);
  }

  out(
    `\n${chalk.dim('Pick & choose:')} --no-mcp · --no-memory · --with-hooks · --with-reasoning · --no-ingest · -i/--interactive · --dry-run\n`,
  );
  if (!dry && pick.mcp) {
    out(
      `${chalk.dim('MCP servers load at session start — open a fresh Claude Code session and run')} ${chalk.bold('/mcp')} ${chalk.dim('to confirm.')}\n`,
    );
  }
}
