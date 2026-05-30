/**
 * `agentslog diff <id1> <id2>` — compare two sessions side by side.
 */
import chalk from 'chalk';
import { openDb } from '../../db/index.js';
import {
  filesForSession,
  resolveSession,
  type SessionRow,
  toolCallsForSession,
} from '../../db/queries.js';
import { abbreviateNumber, baseName, padTo, shortModel, withCommas } from '../../utils/format.js';
import { formatDuration, relativeTime } from '../../utils/time.js';

export interface DiffOptions {
  json?: boolean;
}

function resolveOrReport(db: ReturnType<typeof openDb>, prefix: string): SessionRow | null {
  try {
    const s = resolveSession(db, prefix);
    if (!s) process.stderr.write(chalk.red(`No session matches "${prefix}".\n`));
    return s;
  } catch (err) {
    process.stderr.write(`${chalk.red((err as Error).message)}\n`);
    return null;
  }
}

/** Render a two-column comparison plus a tool/file delta. */
export function runDiff(id1: string, id2: string, options: DiffOptions = {}): void {
  const db = openDb();

  const a = resolveOrReport(db, id1);
  const b = resolveOrReport(db, id2);
  if (!a || !b) {
    process.exitCode = 1;
    return;
  }

  const aTools = toolCallsForSession(db, a.id);
  const bTools = toolCallsForSession(db, b.id);
  const aFiles = filesForSession(db, a.id);
  const bFiles = filesForSession(db, b.id);

  const aFileSet = new Set(aFiles.map((f) => f.file_path));
  const bFileSet = new Set(bFiles.map((f) => f.file_path));
  const common = [...aFileSet].filter((f) => bFileSet.has(f));
  const onlyA = [...aFileSet].filter((f) => !bFileSet.has(f));
  const onlyB = [...bFileSet].filter((f) => !aFileSet.has(f));

  const toolCounts = (rows: typeof aTools) => {
    const m = new Map<string, number>();
    for (const t of rows) m.set(t.tool_name, (m.get(t.tool_name) ?? 0) + 1);
    return m;
  };
  const aToolCounts = toolCounts(aTools);
  const bToolCounts = toolCounts(bTools);

  if (options.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          a,
          b,
          files: { common, onlyA, onlyB },
          tools: {
            a: Object.fromEntries(aToolCounts),
            b: Object.fromEntries(bToolCounts),
          },
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  const COL = 26;
  const label = (s: string) => chalk.bold.cyan(padTo(s, 14));
  const cell = (s: string) => padTo(s, COL);

  // Header row with the two session ids/titles.
  process.stdout.write(
    `${padTo('', 14)}${chalk.bold(cell(`A: ${a.id.slice(0, 8)}`))}${chalk.bold(`B: ${b.id.slice(0, 8)}`)}\n`,
  );
  process.stdout.write(
    `${label('title')}${cell(truncateField(a.ai_title))}${truncateField(b.ai_title)}\n`,
  );
  process.stdout.write(`${label('model')}${cell(shortModel(a.model))}${shortModel(b.model)}\n`);
  process.stdout.write(
    `${label('started')}${cell(relativeTime(a.started_at))}${relativeTime(b.started_at)}\n`,
  );
  process.stdout.write(
    `${label('duration')}${cell(formatDuration(a.duration_ms))}${formatDuration(b.duration_ms)}\n`,
  );
  process.stdout.write(
    `${label('tokens')}${cell(abbreviateNumber(a.input_tokens + a.output_tokens))}` +
      `${abbreviateNumber(b.input_tokens + b.output_tokens)}\n`,
  );
  process.stdout.write(
    `${label('tool calls')}${cell(withCommas(a.tool_call_count))}${withCommas(b.tool_call_count)}\n`,
  );
  process.stdout.write(
    `${label('errors')}${cell(withCommas(a.error_count))}${withCommas(b.error_count)}\n`,
  );
  process.stdout.write(
    `${label('files')}${cell(withCommas(aFiles.length))}${withCommas(bFiles.length)}\n`,
  );

  // Tool delta: union of tool names with per-session counts.
  const allTools = [...new Set([...aToolCounts.keys(), ...bToolCounts.keys()])].sort();
  if (allTools.length > 0) {
    process.stdout.write('\n');
    process.stdout.write(chalk.bold(`Tool usage (A vs B)\n`));
    for (const name of allTools) {
      const ca = aToolCounts.get(name) ?? 0;
      const cb = bToolCounts.get(name) ?? 0;
      const delta = cb - ca;
      const deltaStr =
        delta === 0
          ? chalk.dim('=')
          : delta > 0
            ? chalk.green(`+${delta}`)
            : chalk.red(String(delta));
      process.stdout.write(
        `  ${padTo(name, 16)}${padTo(String(ca), 6)}${padTo(String(cb), 6)}${deltaStr}\n`,
      );
    }
  }

  // File overlap summary.
  process.stdout.write('\n');
  process.stdout.write(chalk.bold('Files\n'));
  process.stdout.write(`  ${chalk.dim('shared:')} ${common.length}\n`);
  printFileGroup('only in A', onlyA);
  printFileGroup('only in B', onlyB);
}

function truncateField(s: string | null): string {
  return s ?? '(untitled)';
}

function printFileGroup(title: string, files: string[]): void {
  if (files.length === 0) return;
  process.stdout.write(`  ${chalk.dim(`${title}:`)} ${files.length}\n`);
  for (const f of files.slice(0, 8)) {
    process.stdout.write(`    ${baseName(f)}\n`);
  }
  if (files.length > 8) process.stdout.write(chalk.dim(`    … and ${files.length - 8} more\n`));
}
