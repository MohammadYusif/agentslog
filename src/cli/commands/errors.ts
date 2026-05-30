/**
 * `agentslog errors` — recent failed tool calls across all sessions.
 *
 * A forensic view: when something went wrong, this surfaces what failed, in
 * which session (always the top-level one, even if a sub-agent hit the error),
 * and the error text — newest first.
 */
import chalk from 'chalk';
import { openDb } from '../../db/index.js';
import { type ErrorRow, recentErrors } from '../../db/queries.js';
import { projectLabel, truncate } from '../../utils/format.js';
import { relativeTime, windowCutoffIso } from '../../utils/time.js';

export interface ErrorsOptions {
  last?: string;
  project?: string;
  tool?: string;
  limit?: string;
  json?: boolean;
}

/** Render recent tool-call failures. */
export function runErrors(options: ErrorsOptions = {}): void {
  const db = openDb();
  const sinceIso = windowCutoffIso(options.last);
  const limit = options.limit ? Number(options.limit) : 20;

  const rows = recentErrors(db, {
    sinceIso,
    project: options.project ?? null,
    tool: options.tool ?? null,
    limit,
  });

  if (options.json) {
    process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
    return;
  }

  if (rows.length === 0) {
    process.stdout.write(chalk.green('No failed tool calls found for the given filters.\n'));
    return;
  }

  const scope = options.last ? `last ${options.last}` : 'all time';
  process.stdout.write(
    chalk.dim(`Recent tool-call failures (${scope}) — showing ${rows.length}\n\n`),
  );

  for (const e of rows) {
    const when = e.called_at ? relativeTime(e.called_at) : '—';
    const project = projectLabel(e.project_path, e.project_hash);
    // Header line: ✗ Tool · project · when
    process.stdout.write(
      `${chalk.red('✗')} ${chalk.bold(e.tool_name)} ${chalk.dim(`· ${project} · ${when}`)}\n`,
    );

    // Context line: the file or command that failed.
    const ctx = contextLine(e);
    if (ctx) process.stdout.write(`  ${chalk.dim(ctx)}\n`);

    // Error text, collapsed to a single line.
    if (e.error_text) {
      process.stdout.write(`  ${chalk.red(truncate(collapse(e.error_text), 100))}\n`);
    }

    // Attribution line: which session to open with `agentslog show`.
    const title = e.top_title ? ` "${truncate(e.top_title, 40)}"` : '';
    process.stdout.write(chalk.dim(`  ↳ session ${e.top_session_id.slice(0, 8)}${title}\n\n`));
  }
}

/** The most useful one-line context for a failed call. */
function contextLine(e: ErrorRow): string | null {
  if (e.command) return `$ ${collapse(e.command)}`;
  if (e.file_path) return e.file_path;
  return null;
}

/** Collapse whitespace runs so multi-line output fits on one row. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
