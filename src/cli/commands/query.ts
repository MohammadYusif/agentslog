/**
 * `agentslog query --file <path> | --tool <name>` — filter sessions.
 */
import chalk from 'chalk';
import { openDb } from '../../db/index.js';
import { sessionsByFile, sessionsByTool, type SessionRow } from '../../db/queries.js';
import { windowCutoffIso, relativeTime } from '../../utils/time.js';
import {
  renderTable,
  abbreviateNumber,
  projectLabel,
  shortModel,
  type Column,
} from '../../utils/format.js';

export interface QueryOptions {
  file?: string;
  tool?: string;
  last?: string;
  json?: boolean;
}

/** Run a file/tool filter query against indexed sessions. */
export function runQuery(options: QueryOptions = {}): void {
  if (!options.file && !options.tool) {
    process.stderr.write(chalk.red('Provide --file <path> or --tool <name>.\n'));
    process.exitCode = 1;
    return;
  }

  const db = openDb();
  const sinceIso = windowCutoffIso(options.last);

  let rows: SessionRow[];
  let heading: string;
  if (options.file) {
    rows = sessionsByFile(db, options.file, sinceIso);
    heading = `sessions touching ${chalk.bold(options.file)}`;
  } else {
    rows = sessionsByTool(db, options.tool!, sinceIso);
    heading = `sessions using ${chalk.bold(options.tool!)}`;
  }

  if (options.json) {
    process.stdout.write(JSON.stringify(rows, null, 2) + '\n');
    return;
  }

  if (rows.length === 0) {
    process.stdout.write(chalk.yellow(`No ${heading}.\n`));
    return;
  }

  const columns: Column[] = [
    { header: 'SESSION ID', width: 12 },
    { header: 'TITLE', width: 30 },
    { header: 'PROJECT', width: 18 },
    { header: 'MODEL', width: 12 },
    { header: 'STARTED', width: 10, align: 'right' },
    { header: 'TOKENS', width: 8, align: 'right' },
  ];

  const tableRows = rows.map((s) => [
    s.id.slice(0, 8),
    s.ai_title ?? chalk.dim('(untitled)'),
    projectLabel(s.project_path, s.project_hash),
    shortModel(s.model),
    relativeTime(s.started_at),
    abbreviateNumber(s.input_tokens + s.output_tokens),
  ]);

  process.stdout.write(chalk.dim(`${heading}\n\n`));
  process.stdout.write(renderTable(columns, tableRows) + '\n');
  process.stdout.write(chalk.dim(`\n${rows.length} session(s)\n`));
}
