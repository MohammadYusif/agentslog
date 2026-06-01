/**
 * `agentslog review [id]` — flag sessions that ran inefficiently.
 *
 * Deterministic heuristics over data already captured: failure rate, repeated
 * identical failures, and disproportionate token spend. Flags are *candidates*
 * for reflection, not verdicts.
 */
import chalk from 'chalk';
import { openDb } from '../../db/index.js';
import {
  resolveSession,
  reviewCandidates,
  type SessionEfficiency,
  sessionEfficiency,
} from '../../db/queries.js';
import { abbreviateNumber, projectLabel, truncate } from '../../utils/format.js';
import { relativeTime, windowCutoffIso } from '../../utils/time.js';

export interface ReviewOptions {
  last?: string;
  limit?: string;
  json?: boolean;
}

/** Human-readable, one-line explanation for each flag. */
const FLAG_LABEL: Record<string, string> = {
  high_error_rate: 'high failure rate',
  repeated_failure: 'repeated identical failures',
  high_spend_no_activity: 'heavy token spend, no reads or changes',
  high_tokens_per_change: 'many tokens per file change',
};

function renderFlags(flags: string[]): string {
  return flags.map((f) => chalk.yellow(FLAG_LABEL[f] ?? f)).join(', ');
}

/** Run the review: one session by id, or a ranked list over a window. */
export function runReview(idPrefix: string | undefined, options: ReviewOptions = {}): void {
  const db = openDb();

  if (idPrefix) {
    let session: ReturnType<typeof resolveSession>;
    try {
      session = resolveSession(db, idPrefix);
    } catch (err) {
      process.stderr.write(`${chalk.red((err as Error).message)}\n`);
      process.exitCode = 1;
      return;
    }
    if (!session) {
      process.stderr.write(chalk.red(`No session matches "${idPrefix}".\n`));
      process.exitCode = 1;
      return;
    }
    const report = sessionEfficiency(db, session.id);
    if (options.json) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      return;
    }
    printSessionReport(session.ai_title, report);
    return;
  }

  const sinceIso = windowCutoffIso(options.last);
  const limit = options.limit ? Number(options.limit) : 20;
  const candidates = reviewCandidates(db, sinceIso, limit);

  if (options.json) {
    process.stdout.write(`${JSON.stringify(candidates, null, 2)}\n`);
    return;
  }

  if (candidates.length === 0) {
    process.stdout.write(chalk.green('No inefficient sessions flagged for the given window.\n'));
    return;
  }

  const scope = options.last ? `last ${options.last}` : 'all time';
  process.stdout.write(chalk.dim(`Flagged sessions (${scope}) — heuristic candidates\n\n`));
  for (const c of candidates) {
    const project = projectLabel(c.project_path, c.project_hash);
    process.stdout.write(
      `${chalk.cyan(c.session_id.slice(0, 8))} ${chalk.bold(truncate(c.ai_title ?? '(untitled)', 36))} ` +
        chalk.dim(`· ${project} · ${relativeTime(c.started_at)}`) +
        '\n',
    );
    process.stdout.write(
      `  ${renderFlags(c.flags)}  ` +
        chalk.dim(
          `(${c.toolCalls} calls, ${c.errors} errors, ${abbreviateNumber(c.tokens)} tokens, ` +
            `${c.writes + c.edits} changes)`,
        ) +
        '\n\n',
    );
  }
  process.stdout.write(
    chalk.dim(`${candidates.length} flagged · run \`agentslog review <id>\` for detail\n`),
  );
}

function printSessionReport(title: string | null, r: SessionEfficiency | null): void {
  if (!r) {
    process.stdout.write(chalk.yellow('No efficiency data for this session.\n'));
    return;
  }
  process.stdout.write(`${chalk.bold.underline(title ?? '(untitled session)')}\n\n`);
  const errPct = r.toolCalls > 0 ? (r.errorRate * 100).toFixed(0) : '0';
  process.stdout.write(
    `${chalk.bold('Efficiency')}  ` +
      `${r.toolCalls} tool calls · ${chalk.red(`${r.errors} errors`)} (${errPct}%) · ` +
      `${abbreviateNumber(r.tokens)} tokens · ${r.reads} reads · ${r.writes + r.edits} changes\n`,
  );

  if (r.flags.length === 0) {
    process.stdout.write(`\n${chalk.green('✓ No inefficiency flags.')}\n`);
  } else {
    process.stdout.write(`\n${chalk.bold('Flags')}  ${renderFlags(r.flags)}\n`);
  }

  if (r.repeated.length > 0) {
    process.stdout.write(`\n${chalk.bold.red('Repeated failures')}\n`);
    for (const rf of r.repeated) {
      const err = (rf.error_text ?? '').replace(/\s+/g, ' ').slice(0, 80);
      process.stdout.write(
        `  ${chalk.red(`${rf.count}×`)} ${chalk.dim(truncate(rf.command, 56))} → ${chalk.dim(err)}\n`,
      );
    }
  }

  if (r.flags.length > 0) {
    process.stdout.write(
      chalk.dim('\nThese are heuristics — review before drawing conclusions.\n'),
    );
  }
}
