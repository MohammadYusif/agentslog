/**
 * `agentslog sessions` — list indexed sessions as a table or JSON.
 */
import chalk from 'chalk';
import { openDb } from '../../db/index.js';
import { listSessions, type SessionRollupRow } from '../../db/queries.js';
import {
  abbreviateNumber,
  type Column,
  projectLabel,
  renderTable,
  shortModel,
} from '../../utils/format.js';
import { relativeTime, windowCutoffIso } from '../../utils/time.js';

export interface SessionsOptions {
  last?: string;
  project?: string;
  source?: string;
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
    source: options.source ?? null,
    limit,
  });

  if (options.json) {
    process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
    return;
  }

  if (rows.length === 0) {
    process.stdout.write(chalk.yellow('No sessions found. Run `agentslog ingest` first.\n'));
    return;
  }

  // Only show the SOURCE column when more than one source is present, to keep
  // the common Claude-Code-only view uncluttered.
  const multiSource = new Set(rows.map((s) => s.source)).size > 1;

  const columns: Column[] = [
    { header: 'SESSION ID', width: 12 },
    ...(multiSource ? [{ header: 'SOURCE', width: 12 } as Column] : []),
    { header: 'TITLE', width: 28 },
    { header: 'PROJECT', width: 18 },
    { header: 'MODEL', width: 12 },
    { header: 'STARTED', width: 10, align: 'right' },
    { header: 'TOKENS', width: 8, align: 'right' },
    { header: 'SUB', width: 4, align: 'right' },
  ];

  const tableRows = rows.map((s: SessionRollupRow) =>
    [
      s.id.slice(0, 8),
      multiSource ? s.source : null,
      s.ai_title ?? chalk.dim('(untitled)'),
      projectLabel(s.project_path, s.project_hash),
      shortModel(s.model),
      relativeTime(s.started_at),
      abbreviateNumber(s.rollup_input_tokens + s.rollup_output_tokens),
      s.subagent_count > 0 ? chalk.magenta(`+${s.subagent_count}`) : chalk.dim('–'),
    ].filter((c): c is string => c !== null),
  );

  process.stdout.write(`${renderTable(columns, tableRows)}\n`);

  const withSub = rows.filter((s) => s.subagent_count > 0).length;
  const footer =
    withSub > 0
      ? `${rows.length} session(s) · TOKENS and SUB include sub-agent activity`
      : `${rows.length} session(s)`;
  process.stdout.write(chalk.dim(`\n${footer}\n`));
}
