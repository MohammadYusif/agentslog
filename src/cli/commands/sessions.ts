/**
 * `agentslog sessions` — list indexed sessions as a table or JSON.
 */
import chalk from 'chalk';
import { openDb } from '../../db/index.js';
import { listSessions, type SessionRow } from '../../db/queries.js';
import { windowCutoffIso, relativeTime } from '../../utils/time.js';
import {
  renderTable,
  abbreviateNumber,
  projectLabel,
  shortModel,
  type Column,
} from '../../utils/format.js';

export interface SessionsOptions {
  last?: string;
  project?: string;
  json?: boolean;
  limit?: string;
}

/** Render the sessions list. */
export function runSessions(options: SessionsOptions = {}): void {
  const db = openDb();
  const sinceIso = windowCutoffIso(options.last);
  const limit = options.limit ? Number(options.limit) : options.last ? null : 50;

  const rows = listSessions(db, {
    sinceIso,
    project: options.project ?? null,
    limit,
  });

  if (options.json) {
    process.stdout.write(JSON.stringify(rows, null, 2) + '\n');
    return;
  }

  if (rows.length === 0) {
    process.stdout.write(chalk.yellow('No sessions found. Run `agentslog ingest` first.\n'));
    return;
  }

  const columns: Column[] = [
    { header: 'SESSION ID', width: 12 },
    { header: 'TITLE', width: 28 },
    { header: 'PROJECT', width: 18 },
    { header: 'MODEL', width: 12 },
    { header: 'STARTED', width: 10, align: 'right' },
    { header: 'TOKENS', width: 8, align: 'right' },
  ];

  const tableRows = rows.map((s: SessionRow) => [
    s.id.slice(0, 8),
    s.ai_title ?? chalk.dim('(untitled)'),
    projectLabel(s.project_path, s.project_hash),
    shortModel(s.model),
    relativeTime(s.started_at),
    abbreviateNumber(s.input_tokens + s.output_tokens),
  ]);

  process.stdout.write(renderTable(columns, tableRows) + '\n');
  process.stdout.write(chalk.dim(`\n${rows.length} session(s)\n`));
}
