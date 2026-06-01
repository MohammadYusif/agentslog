#!/usr/bin/env node
import chalk from 'chalk';
/**
 * agentslog — query your Claude Code session history as a local SQLite database.
 *
 * CLI entry point: wires up commander subcommands. Each command delegates to a
 * handler in ./commands so the parsing surface stays thin and testable.
 */
import { Command } from 'commander';
import { runDbVacuum } from './commands/db.js';
import { runDiff } from './commands/diff.js';
import { runErrors } from './commands/errors.js';
import {
  runHookCheck,
  runHookIngest,
  runHookReflect,
  runHookSessionStart,
} from './commands/hook.js';
import { runIngest } from './commands/ingest.js';
import {
  runLessonAdd,
  runLessonExport,
  runLessonRemove,
  runLessonsList,
} from './commands/lesson.js';
import { runQuery } from './commands/query.js';
import { runReasoning } from './commands/reasoning.js';
import { runReview } from './commands/review.js';
import { runSessions } from './commands/sessions.js';
import { runShow } from './commands/show.js';
import { runStats } from './commands/stats.js';
import { runWatch } from './commands/watch.js';

const program = new Command();

program
  .name('agentslog')
  .description('Query your Claude Code session history as a local SQLite database')
  .version('0.4.1');

program
  .command('ingest')
  .description('Scan ~/.claude/projects/**/*.jsonl and index all sessions into SQLite')
  .option('--dir <path>', 'override the Claude projects directory')
  .option('-q, --quiet', 'suppress per-file error output')
  .option('--reasoning', 'also index assistant reasoning (thinking) blocks for search')
  .action(async (opts) => {
    await runIngest({ dir: opts.dir, quiet: opts.quiet, reasoning: opts.reasoning });
  });

program
  .command('sessions')
  .description('List indexed sessions as a table')
  .option('--last <window>', 'only sessions within a window, e.g. 7d, 24h, 2w')
  .option('--project <path>', 'filter by project path or hash substring')
  .option('--source <name>', 'filter by source: claude-code, cline, aider')
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
  .command('review')
  .description('Flag sessions that ran inefficiently (failures, repeats, token spend)')
  .argument('[id-prefix]', 'review one session by id prefix; omit to list flagged sessions')
  .option('--last <window>', 'restrict to a time window, e.g. 7d')
  .option('--limit <n>', 'maximum flagged sessions to list (default 20)')
  .option('--json', 'output raw JSON')
  .action((idPrefix, opts) => {
    runReview(idPrefix, opts);
  });

program
  .command('reasoning')
  .description('Full-text search the indexed reasoning (thinking) blocks')
  .argument('<query>', 'words to search for in past reasoning')
  .option('--last <window>', 'restrict to a time window, e.g. 7d')
  .option('--limit <n>', 'maximum matches to show (default 20)')
  .option('--json', 'output raw JSON')
  .action((query, opts) => {
    runReasoning(query, opts);
  });

program
  .command('watch')
  .description('Watch ~/.claude/projects for new sessions and index them live')
  .option('--no-initial', 'skip the initial full ingest before watching')
  .action(async (opts) => {
    await runWatch({ noInitial: opts.initial === false });
  });

program
  .command('lessons')
  .description('List the durable lessons agentslog has learned')
  .option('--project', 'only lessons for the current project (plus global)')
  .option('--global', 'only global lessons')
  .option('--json', 'output raw JSON')
  .action((opts) => {
    runLessonsList(opts);
  });

const lesson = program.command('lesson').description('Manage learned lessons');
lesson
  .command('add')
  .description('Record a lesson by hand')
  .requiredOption('--rule <text>', 'the lesson to remember')
  .option('--tool <name>', 'tool the lesson concerns (e.g. Bash)')
  .option('--trigger <str>', 'short exact command/file this applies to (e.g. "ls -Recurse")')
  .option('--rationale <text>', 'why / evidence')
  .option('--project', 'scope to the current project instead of global')
  .action((opts) => {
    runLessonAdd(opts);
  });
lesson
  .command('rm')
  .description('Delete a lesson by id')
  .argument('<id>', 'lesson id')
  .action((id) => {
    runLessonRemove(id);
  });
lesson
  .command('export')
  .description('Print lessons as markdown to paste into CLAUDE.md')
  .option('--project', 'only lessons for the current project')
  .action((opts) => {
    runLessonExport(opts);
  });

const db = program.command('db').description('Database maintenance');
db.command('vacuum')
  .description('Reclaim space and optimize indexes (VACUUM + PRAGMA optimize)')
  .action(() => {
    runDbVacuum();
  });

program
  .command('mcp')
  .description('Run as an MCP server so an agent can query its own history')
  .option('--no-ingest', 'skip the freshness ingest before serving')
  .action(async (opts) => {
    // Lazy-load: keeps the MCP SDK + zod off the hot path of fast commands
    // like `hook check` (a blocking PreToolUse hook).
    const { runMcp } = await import('./commands/mcp.js');
    await runMcp({ ingest: opts.ingest !== false });
  });

const hook = program.command('hook').description('Claude Code hook integrations');
hook
  .command('check')
  .description('PreToolUse: warn if a tool/command has failed before (reads stdin)')
  .action(async () => {
    await runHookCheck();
  });
hook
  .command('ingest')
  .description('Stop/SessionEnd: refresh the index so history stays current')
  .action(async () => {
    await runHookIngest();
  });
hook
  .command('reflect')
  .description('Stop: refresh, then auto-record lessons from repeated failures')
  .action(async () => {
    await runHookReflect();
  });
hook
  .command('session-start')
  .description('SessionStart: surface relevant lessons + nudge after inefficient runs')
  .action(async () => {
    await runHookSessionStart();
  });

program.parseAsync(process.argv).catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`${chalk.red(`error: ${msg}`)}\n`);
  process.exit(1);
});
