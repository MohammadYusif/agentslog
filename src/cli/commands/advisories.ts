/**
 * `agentslog advisories` — report how many imminent tool calls agentslog
 * intercepted with a PreToolUse advisory, broken down by kind and tool.
 *
 * The hook never blocks — it nudges — so this counts nudges emitted *before* a
 * tool ran, not calls prevented. Data accrues from v6 onward (the advisory_fires
 * table); the long-running lesson-recall total still lives in `lessons.hits` and
 * is surfaced here as historical context.
 */
import chalk from 'chalk';
import { openDb } from '../../db/index.js';
import { advisoryFireStats } from '../../db/queries.js';
import { relativeTime, windowCutoffIso } from '../../utils/time.js';

export interface AdvisoriesOptions {
  last?: string;
  json?: boolean;
}

/** Human-friendly labels for the advisory kinds. */
const KIND_LABEL: Record<string, string> = {
  lesson: 'Recorded lesson recalled',
  similar_failure: 'Similar past failure warned',
  frequency: 'Repeated-failure frequency heads-up',
  not_read: 'Read-before-edit constraint',
  modified_since_read: 'Re-read-before-edit constraint',
};

export function runAdvisories(opts: AdvisoriesOptions = {}): void {
  const db = openDb();
  const sinceIso = windowCutoffIso(opts.last);
  const stats = advisoryFireStats(db, sinceIso);

  // Cumulative lesson-recall counter (predates advisory_fires) for context.
  const lessonHits = (
    db.prepare('SELECT COALESCE(SUM(hits), 0) AS n FROM lessons').get() as { n: number }
  ).n;

  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ ...stats, lessonHitsAllTime: lessonHits })}\n`);
    return;
  }

  const windowLabel = opts.last ? `last ${opts.last}` : 'all time';
  process.stdout.write(
    `${chalk.bold('agentslog advisories')} — tool calls intercepted (${windowLabel})\n`,
  );

  if (stats.total === 0) {
    process.stdout.write(
      `\n${chalk.yellow('No advisory firings logged in this window.')}\n` +
        chalk.dim(
          'The advisory_fires log starts accruing from v6 — older nudges were never recorded.\n',
        ) +
        chalk.dim(`Lifetime lesson recalls (legacy counter): ${lessonHits}\n`),
    );
    return;
  }

  const span =
    stats.firstFiredAt && stats.lastFiredAt
      ? `${stats.firstFiredAt.slice(0, 10)} → ${stats.lastFiredAt.slice(0, 10)} (last ${relativeTime(stats.lastFiredAt)})`
      : '';
  process.stdout.write(chalk.dim(`${span}\n`));
  process.stdout.write(`\n  ${chalk.bold(String(stats.total))} total advisory firing(s)\n`);

  process.stdout.write(`\n${chalk.dim('By kind')}\n`);
  for (const r of stats.byKind) {
    const label = KIND_LABEL[r.kind] ?? r.kind;
    process.stdout.write(
      `  ${String(r.count).padStart(6)}  ${label} ${chalk.dim(`(${r.kind})`)}\n`,
    );
  }

  process.stdout.write(`\n${chalk.dim('By tool')}\n`);
  for (const r of stats.byTool) {
    process.stdout.write(`  ${String(r.count).padStart(6)}  ${r.tool}\n`);
  }

  process.stdout.write(
    `\n${chalk.dim(`Lifetime lesson recalls (legacy cumulative counter): ${lessonHits}`)}\n` +
      `${chalk.dim('Note: an advisory is a non-blocking nudge before a tool runs, not a call prevented.')}\n`,
  );
}
