/**
 * `agentslog stats` — aggregate token / tool / file statistics.
 */
import chalk from 'chalk';
import { openDb } from '../../db/index.js';
import { statsTotals, topFiles, topTools } from '../../db/queries.js';
import { windowCutoffIso } from '../../utils/time.js';
import { abbreviateNumber, withCommas, baseName, padTo } from '../../utils/format.js';

export interface StatsOptions {
  last?: string;
  json?: boolean;
}

/** Render aggregate statistics over an optional time window. */
export function runStats(options: StatsOptions = {}): void {
  const db = openDb();
  const sinceIso = windowCutoffIso(options.last);
  const period = options.last ? `last ${options.last}` : 'all time';

  const totals = statsTotals(db, sinceIso);
  const files = topFiles(db, sinceIso, 10);
  const tools = topTools(db, sinceIso, 10);

  if (options.json) {
    process.stdout.write(
      JSON.stringify({ period, totals, topFiles: files, topTools: tools }, null, 2) + '\n'
    );
    return;
  }

  const totalTokens = totals.input_tokens + totals.output_tokens;
  const cached = totals.cache_read_tokens;
  const errPct =
    totals.tool_calls > 0 ? ((totals.errors / totals.tool_calls) * 100).toFixed(1) : '0.0';

  const label = (s: string) => chalk.bold.cyan(padTo(s, 12));

  process.stdout.write(`${label('PERIOD')}${period}\n`);
  const sessionsLine =
    totals.subagent_count > 0
      ? `${withCommas(totals.session_count)}  ` +
        chalk.dim(`(+ ${withCommas(totals.subagent_count)} sub-agent run(s))`)
      : withCommas(totals.session_count);
  process.stdout.write(`${label('SESSIONS')}${sessionsLine}\n`);
  process.stdout.write(
    `${label('TOKENS')}${abbreviateNumber(totalTokens)}   ` +
      chalk.dim(
        `(in: ${abbreviateNumber(totals.input_tokens)}  ` +
          `out: ${abbreviateNumber(totals.output_tokens)}  ` +
          `cached: ${abbreviateNumber(cached)})`
      ) +
      '\n'
  );
  process.stdout.write(
    `${label('TOOLS')}${withCommas(totals.tool_calls)}  ` +
      chalk.dim(`(errors: ${withCommas(totals.errors)}, ${errPct}%)`) +
      '\n'
  );

  if (files.length > 0) {
    process.stdout.write('\n');
    process.stdout.write(chalk.bold.cyan(`${padTo('TOP FILES', 34)}TOUCHES\n`));
    for (const f of files) {
      process.stdout.write(`${padTo(baseName(f.label), 34)}${withCommas(f.count)}\n`);
    }
  }

  if (tools.length > 0) {
    process.stdout.write('\n');
    process.stdout.write(chalk.bold.cyan(`${padTo('TOP TOOLS', 34)}CALLS\n`));
    for (const t of tools) {
      process.stdout.write(`${padTo(t.label, 34)}${withCommas(t.count)}\n`);
    }
  }
}
