#!/usr/bin/env node
/**
 * agentslog — query your Claude Code session history as a local SQLite database.
 *
 * CLI entry point: wires up commander subcommands. Each command delegates to a
 * handler in ./commands so the parsing surface stays thin and testable.
 */
import { Command } from 'commander';
import chalk from 'chalk';
import { runIngest } from './commands/ingest.js';
import { runSessions } from './commands/sessions.js';
import { runQuery } from './commands/query.js';
import { runStats } from './commands/stats.js';
import { runShow } from './commands/show.js';
import { runDiff } from './commands/diff.js';
import { runErrors } from './commands/errors.js';
import { runWatch } from './commands/watch.js';

const program = new Command();

program
  .name('agentslog')
  .description('Query your Claude Code session history as a local SQLite database')
  .version('0.1.0');

program
  .command('ingest')
  .description('Scan ~/.claude/projects/**/*.jsonl and index all sessions into SQLite')
  .option('--dir <path>', 'override the Claude projects directory')
  .option('-q, --quiet', 'suppress per-file error output')
  .action(async (opts) => {
    await runIngest({ dir: opts.dir, quiet: opts.quiet });
  });

program
  .command('sessions')
  .description('List indexed sessions as a table')
  .option('--last <window>', 'only sessions within a window, e.g. 7d, 24h, 2w')
  .option('--project <path>', 'filter by project path or hash substring')
  .option('--limit <n>', 'maximum rows to show')
  .option('--json', 'output raw JSON')
  .action((opts) => {
    runSessions(opts);
  });

program
  .command('query')
  .description('Filter sessions by file or tool')
  .option('--file <path>', 'sessions that read/wrote/edited this file')
  .option('--tool <name>', 'sessions that invoked this tool (e.g. Bash, Read)')
  .option('--last <window>', 'restrict to a time window, e.g. 7d')
  .option('--json', 'output raw JSON')
  .action((opts) => {
    runQuery(opts);
  });

program
  .command('errors')
  .description('List recent failed tool calls across sessions')
  .option('--last <window>', 'restrict to a time window, e.g. 7d')
  .option('--project <path>', 'filter by project path or hash substring')
  .option('--tool <name>', 'only failures from this tool (e.g. Bash)')
  .option('--limit <n>', 'maximum failures to show (default 20)')
  .option('--json', 'output raw JSON')
  .action((opts) => {
    runErrors(opts);
  });

program
  .command('stats')
  .description('Aggregate token / tool / file statistics')
  .option('--last <window>', 'restrict to a time window, e.g. 7d')
  .option('--json', 'output raw JSON')
  .action((opts) => {
    runStats(opts);
  });

program
  .command('show')
  .description('Show full detail of one session by id prefix')
  .argument('<id-prefix>', 'first characters of a session id')
  .option('--json', 'output raw JSON')
  .action((idPrefix, opts) => {
    runShow(idPrefix, opts);
  });

program
  .command('diff')
  .description('Compare two sessions side by side')
  .argument('<id1>', 'first session id prefix')
  .argument('<id2>', 'second session id prefix')
  .option('--json', 'output raw JSON')
  .action((id1, id2, opts) => {
    runDiff(id1, id2, opts);
  });

program
  .command('watch')
  .description('Watch ~/.claude/projects for new sessions and index them live')
  .option('--no-initial', 'skip the initial full ingest before watching')
  .action(async (opts) => {
    await runWatch({ noInitial: opts.initial === false });
  });

program.parseAsync(process.argv).catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(chalk.red(`error: ${msg}`) + '\n');
  process.exit(1);
});
