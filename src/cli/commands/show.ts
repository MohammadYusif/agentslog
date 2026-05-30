/**
 * `agentslog show <id-prefix>` — full detail of one session.
 */
import chalk from 'chalk';
import { openDb } from '../../db/index.js';
import {
  resolveSession,
  toolCallsForSession,
  filesForSession,
  childSessions,
} from '../../db/queries.js';
import { relativeTime, formatDuration } from '../../utils/time.js';
import {
  abbreviateNumber,
  withCommas,
  shortModel,
  truncate,
  baseName,
  padTo,
} from '../../utils/format.js';
import { estimateCost, formatCost } from '../../utils/pricing.js';
import type { SessionRow } from '../../db/queries.js';

/** Estimate one session row's cost from its model + token columns. */
function rowCost(s: SessionRow): number | null {
  return estimateCost(s.model, {
    inputTokens: s.input_tokens,
    outputTokens: s.output_tokens,
    cacheReadTokens: s.cache_read_tokens,
    cacheCreationTokens: s.cache_creation_tokens,
  });
}

export interface ShowOptions {
  json?: boolean;
}

/** Render a single session's full detail. */
export function runShow(idPrefix: string, options: ShowOptions = {}): void {
  const db = openDb();

  let session;
  try {
    session = resolveSession(db, idPrefix);
  } catch (err) {
    process.stderr.write(chalk.red((err as Error).message) + '\n');
    process.exitCode = 1;
    return;
  }

  if (!session) {
    process.stderr.write(chalk.red(`No session matches "${idPrefix}".\n`));
    process.exitCode = 1;
    return;
  }

  const tools = toolCallsForSession(db, session.id);
  const files = filesForSession(db, session.id);
  const children = childSessions(db, session.id);

  if (options.json) {
    process.stdout.write(
      JSON.stringify(
        { session, toolCalls: tools, filesTouched: files, subAgents: children },
        null,
        2
      ) + '\n'
    );
    return;
  }

  const field = (k: string) => chalk.bold.cyan(padTo(k, 16));

  process.stdout.write(chalk.bold.underline(session.ai_title ?? '(untitled session)') + '\n\n');
  if (session.parent_session_id) {
    process.stdout.write(
      chalk.magenta(`⮡ sub-agent of ${session.parent_session_id.slice(0, 8)}`) + '\n'
    );
  }
  process.stdout.write(`${field('Session')}${session.id}\n`);
  process.stdout.write(`${field('Project')}${session.project_path ?? session.project_hash}\n`);
  process.stdout.write(`${field('Model')}${shortModel(session.model)}\n`);
  if (session.cc_version) process.stdout.write(`${field('CC version')}${session.cc_version}\n`);
  if (session.git_branch) process.stdout.write(`${field('Git branch')}${session.git_branch}\n`);
  process.stdout.write(
    `${field('Started')}${session.started_at}  ${chalk.dim(`(${relativeTime(session.started_at)})`)}\n`
  );
  process.stdout.write(`${field('Duration')}${formatDuration(session.duration_ms)}\n`);
  process.stdout.write(`${field('User turns')}${withCommas(session.user_turn_count)}\n`);

  process.stdout.write('\n');
  process.stdout.write(chalk.bold('Tokens\n'));
  process.stdout.write(
    `${field('  Billed in')}${withCommas(session.input_tokens)}  ` +
      chalk.dim(`(${abbreviateNumber(session.input_tokens)})`) +
      '\n'
  );
  process.stdout.write(
    `${field('  Output')}${withCommas(session.output_tokens)}  ` +
      chalk.dim(`(${abbreviateNumber(session.output_tokens)})`) +
      '\n'
  );
  process.stdout.write(
    `${field('  Last input')}${withCommas(session.last_input_tokens)}  ` +
      chalk.dim('(uncached input_tokens of final assistant turn)') +
      '\n'
  );
  process.stdout.write(
    `${field('  Cache')}${chalk.dim(
      `read ${abbreviateNumber(session.cache_read_tokens)}, ` +
        `created ${abbreviateNumber(session.cache_creation_tokens)}`
    )}\n`
  );
  const ownCost = rowCost(session);
  if (ownCost != null) {
    process.stdout.write(
      `${field('  Est. cost')}${formatCost(ownCost)}  ` +
        chalk.dim(`(${shortModel(session.model)} list price)`) +
        '\n'
    );
  }

  process.stdout.write('\n');
  const errNote =
    session.error_count > 0 ? chalk.red(` (${session.error_count} errors)`) : '';
  process.stdout.write(
    chalk.bold(`Tool calls: ${withCommas(session.tool_call_count)}`) + errNote + '\n'
  );

  // Summarize tool usage counts.
  const byTool = new Map<string, number>();
  for (const t of tools) byTool.set(t.tool_name, (byTool.get(t.tool_name) ?? 0) + 1);
  const sortedTools = [...byTool.entries()].sort((a, b) => b[1] - a[1]);
  for (const [name, count] of sortedTools.slice(0, 12)) {
    process.stdout.write(`  ${padTo(name, 16)}${withCommas(count)}\n`);
  }

  if (files.length > 0) {
    process.stdout.write('\n');
    process.stdout.write(
      chalk.bold(`Files touched: ${withCommas(files.length)}`) + '\n'
    );
    process.stdout.write(
      chalk.dim(`  ${padTo('FILE', 40)}${padTo('R', 5)}${padTo('W', 5)}${padTo('E', 5)}\n`)
    );
    for (const f of files.slice(0, 20)) {
      process.stdout.write(
        `  ${padTo(baseName(f.file_path), 40)}` +
          `${padTo(String(f.read_count), 5)}` +
          `${padTo(String(f.write_count), 5)}` +
          `${padTo(String(f.edit_count), 5)}\n`
      );
    }
    if (files.length > 20) {
      process.stdout.write(chalk.dim(`  … and ${files.length - 20} more\n`));
    }
  }

  // Show recent errors with their command/file context for quick triage.
  const errors = tools.filter((t) => t.success === 0);
  if (errors.length > 0) {
    process.stdout.write('\n');
    process.stdout.write(chalk.bold.red(`Errors (${errors.length})\n`));
    for (const e of errors.slice(0, 5)) {
      const ctx = e.file_path ?? e.command ?? '';
      process.stdout.write(
        `  ${chalk.red('✗')} ${chalk.bold(e.tool_name)} ${chalk.dim(truncate(ctx, 50))}\n`
      );
      if (e.error_text) {
        process.stdout.write(`    ${chalk.dim(truncate(e.error_text.replace(/\s+/g, ' '), 90))}\n`);
      }
    }
  }

  // Sub-agent rollup: list each spawned sub-agent and the combined totals.
  if (children.length > 0) {
    const childInput = children.reduce((a, c) => a + c.input_tokens, 0);
    const childOutput = children.reduce((a, c) => a + c.output_tokens, 0);
    const childTools = children.reduce((a, c) => a + c.tool_call_count, 0);
    const childErrors = children.reduce((a, c) => a + c.error_count, 0);

    process.stdout.write('\n');
    process.stdout.write(chalk.bold.magenta(`Sub-agents (${children.length})\n`));
    process.stdout.write(
      chalk.dim(
        `  ${padTo('ID', 10)}${padTo('MODEL', 12)}${padTo('TOKENS', 9)}${padTo('TOOLS', 7)}TITLE\n`
      )
    );
    for (const c of children) {
      const ctokens = abbreviateNumber(c.input_tokens + c.output_tokens);
      process.stdout.write(
        `  ${padTo(c.id.slice(0, 8), 10)}${padTo(shortModel(c.model), 12)}` +
          `${padTo(ctokens, 9)}${padTo(String(c.tool_call_count), 7)}` +
          `${truncate(c.ai_title ?? '(sub-agent)', 36)}\n`
      );
    }

    process.stdout.write('\n');
    process.stdout.write(chalk.bold('Rolled up (session + sub-agents)\n'));
    process.stdout.write(
      `${field('  Tokens')}${withCommas(
        session.input_tokens + session.output_tokens + childInput + childOutput
      )}  ` +
        chalk.dim(
          `(in: ${abbreviateNumber(session.input_tokens + childInput)}  ` +
            `out: ${abbreviateNumber(session.output_tokens + childOutput)})`
        ) +
        '\n'
    );
    const rolledErrors = session.error_count + childErrors;
    const errNote2 = rolledErrors > 0 ? chalk.red(` (${rolledErrors} errors)`) : '';
    process.stdout.write(
      `${field('  Tool calls')}${withCommas(session.tool_call_count + childTools)}` +
        errNote2 +
        '\n'
    );

    // Rolled-up cost: each sub-agent may run a different model, so price each
    // row independently and sum (only when at least one row is priceable).
    const costs = [session, ...children].map(rowCost);
    if (costs.some((c) => c != null)) {
      const rolledCost = costs.reduce<number>((a, c) => a + (c ?? 0), 0);
      const unpriced = costs.some((c) => c == null);
      process.stdout.write(
        `${field('  Est. cost')}${formatCost(rolledCost)}` +
          chalk.dim(unpriced ? ' (≥, some models unpriced)' : ' (est.)') +
          '\n'
      );
    }
  }

  process.stdout.write(chalk.dim(`\nTranscript: ${session.raw_path}\n`));
}
