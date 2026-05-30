/**
 * `agentslog reasoning <query>` — full-text search the indexed reasoning
 * ('thinking') blocks to recall *why* a past approach was chosen.
 *
 * Requires reasoning indexing to have been enabled during ingest
 * (AGENTSLOG_INDEX_REASONING=1 or `agentslog ingest --reasoning`).
 */
import chalk from 'chalk';
import { openDb } from '../../db/index.js';
import { searchReasoning } from '../../db/queries.js';
import { projectLabel, truncate } from '../../utils/format.js';
import { relativeTime, windowCutoffIso } from '../../utils/time.js';

export interface ReasoningOptions {
  last?: string;
  limit?: string;
  json?: boolean;
}

/** Run a reasoning full-text search. */
export function runReasoning(query: string, options: ReasoningOptions = {}): void {
  const db = openDb();
  const sinceIso = windowCutoffIso(options.last);
  const limit = options.limit ? Number(options.limit) : 20;

  const hits = searchReasoning(db, query, { sinceIso, limit });

  if (options.json) {
    process.stdout.write(`${JSON.stringify(hits, null, 2)}\n`);
    return;
  }

  if (hits.length === 0) {
    process.stdout.write(
      `${chalk.yellow(`No reasoning matches for "${query}".`)}\n` +
        chalk.dim(
          'Reasoning indexing is opt-in — run `agentslog ingest --reasoning`\n' +
            '(or set AGENTSLOG_INDEX_REASONING=1) to capture thinking blocks.\n',
        ),
    );
    return;
  }

  process.stdout.write(chalk.dim(`reasoning matching ${chalk.bold(query)}\n\n`));
  for (const h of hits) {
    const project = projectLabel(h.project_path, h.project_hash);
    process.stdout.write(
      `${chalk.cyan(h.session_id.slice(0, 8))} ` +
        `${chalk.bold(truncate(h.ai_title ?? '(untitled)', 40))} ` +
        chalk.dim(`· ${project} · ${relativeTime(h.started_at)}`) +
        '\n',
    );
    // The snippet wraps matches in [ ]; render those in color.
    const rendered = h.snippet
      .replace(/\s+/g, ' ')
      .replace(/\[(.+?)\]/g, (_, m) => chalk.yellow(m));
    process.stdout.write(`  ${rendered}\n\n`);
  }

  process.stdout.write(chalk.dim(`${hits.length} match(es)\n`));
}
